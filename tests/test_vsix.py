from __future__ import annotations

import hashlib
import json
import importlib.util
import zipfile
from pathlib import Path

import time

import pytest

_VERIFIER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "verify_vsix.py"
_SPEC = importlib.util.spec_from_file_location("research_stack_vsix_verifier", _VERIFIER_PATH)
assert _SPEC is not None and _SPEC.loader is not None
_VERIFIER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_VERIFIER)
EXPECTED = _VERIFIER.EXPECTED
verify = _VERIFIER.verify


def _drift(lock_text: str) -> str:
    """Wind the lock's root package version back to the one 0.3.6 recorded."""
    import re

    pattern = re.compile(r'(name = "research-stack-basic"\nversion = ")[^"]+(")')
    assert pattern.search(lock_text), "the packaged lock has no root package entry to wind back"
    return pattern.sub(r"\g<1>0.3.4\g<2>", lock_text, count=1)


def _write_vsix(
    path: Path,
    *,
    include_extra: bool = False,
    stale_worker_lock: bool = False,
    crlf_members: tuple[str, ...] = (),
    source_crlf: bool = False,
    build_clock: bool = False,
    loose_modes: tuple[str, ...] = (),
) -> Path:
    manifest = {
        "name": "research-stack-toolkit",
        "version": "0.1.0",
        "dependencies": {},
    }
    members = {
        "[Content_Types].xml": b"<Types />",
        "extension.vsixmanifest": b"<PackageManifest />",
        "extension/readme.md": b"preview",
        "extension/extension.js": b"module.exports = {};",
        "extension/ui.js": b"module.exports = {};",
        "extension/media/controls.js": b"// controls",
        "extension/media/controls.css": b"body {}",
        "extension/media/toolkit.svg": b"<svg />",
        "extension/package.json": json.dumps(manifest).encode(),
    }
    extension_root = Path(__file__).resolve().parents[1] / "extension"
    for name in EXPECTED - set(members):
        relative = name.removeprefix("extension/")
        members[name] = (extension_root / relative).read_bytes()
    assert set(members) == EXPECTED
    if stale_worker_lock:
        # The 0.3.6 packaging mistake: the lock beside the manifest records another version.
        # Both the member and the mirrored source carry it, and the bundle manifest is re-hashed,
        # so the payload and bundle-hash gates stay clean and only the packaged-pair check can
        # catch it — which is exactly how a real stale build reaches those gates today.
        drifted = _drift(members["extension/worker/uv.lock"].decode()).encode("utf-8")
        members["extension/worker/uv.lock"] = drifted
        bundle = json.loads(members["extension/worker/bundle.json"])
        bundle["files"]["uv.lock"] = hashlib.sha256(drifted).hexdigest()
        members["extension/worker/bundle.json"] = json.dumps(bundle, indent=2).encode("utf-8")
    if include_extra:
        members["extension/.env"] = b"secret"
    # `git checkout` can leave CRLF in the working tree while the committed blobs are LF, so the
    # staged tree a VSIX was built from is not the tree a fresh clone produces. The packaging step
    # normalises the staged tree; this reproduces the un-normalised case.
    source_bytes = dict(members)
    for name in crlf_members:
        members[name] = members[name].replace(b"\n", b"\r\n")
    if source_crlf:
        for name in crlf_members:
            source_bytes[name] = source_bytes[name].replace(b"\n", b"\r\n")
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            # `writestr` with a bare name stamps the entry with the time of the run, which is what makes
            # an unstamped VSIX irreproducible; the packaging step stamps every entry instead.
            entry = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0) if not build_clock else time.localtime()[:6])
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (0o664 if name in loose_modes else 0o644) << 16
            archive.writestr(entry, content)
    source_root = path.parent / "source"
    source_root.mkdir(exist_ok=True)
    (source_root / "vsix-manifest.json").write_bytes(members["extension/package.json"])
    (source_root / "extension.js").write_bytes(source_bytes["extension/extension.js"])
    (source_root / "README.md").write_bytes(source_bytes["extension/readme.md"])
    (source_root / "media").mkdir(exist_ok=True)
    for member in EXPECTED:
        if member.startswith("extension/") and member not in ("extension/package.json", "extension/readme.md"):
            destination = source_root / member.removeprefix("extension/")
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(source_bytes[member])
    return source_root


def test_vsix_verifier_reports_hash_and_size_for_expected_inventory(tmp_path: Path) -> None:
    package = tmp_path / "preview.vsix"
    source_root = _write_vsix(package)

    receipt = verify(package, source_root)

    assert receipt["result"] == "passed"
    assert receipt["sourceFilesMatch"] is True
    assert len(receipt["sha256"]) == 64
    assert receipt["entries"] == sorted(EXPECTED)


def test_vsix_verifier_rejects_extra_secret_members(tmp_path: Path) -> None:
    package = tmp_path / "unsafe.vsix"
    _write_vsix(package, include_extra=True)

    with pytest.raises(ValueError, match="sensitive or heavyweight path|unexpected package inventory"):
        verify(package)


def test_vsix_verifier_rejects_unsafe_archive_paths(tmp_path: Path) -> None:
    package = tmp_path / "traversal.vsix"
    _write_vsix(package)
    with zipfile.ZipFile(package, "a") as archive:
        archive.writestr("extension/../../outside.txt", b"escape")

    with pytest.raises(ValueError, match="unsafe archive path"):
        verify(package)


def test_vsix_verifier_detects_payload_drift_from_source(tmp_path: Path) -> None:
    good_package = tmp_path / "original.vsix"
    source_root = _write_vsix(good_package)
    tampered_package = tmp_path / "tampered.vsix"
    with zipfile.ZipFile(good_package, "r") as original, zipfile.ZipFile(tampered_package, "w") as altered:
        for member in original.namelist():
            content = original.read(member)
            if member == "extension/extension.js":
                content = b"tampered entry"
            altered.writestr(member, content)

    with pytest.raises(ValueError, match="does not match project source"):
        verify(tampered_package, source_root)


@pytest.mark.parametrize("member", ["extension/media/controls.js", "extension/media/controls.css", "extension/ui.js", "extension/components.json", "extension/guides/pypdf.md"])
def test_vsix_verifier_audits_gui_assets(tmp_path: Path, member: str) -> None:
    original = tmp_path / "original.vsix"
    source_root = _write_vsix(original)
    altered = tmp_path / "altered.vsix"
    with zipfile.ZipFile(original) as source, zipfile.ZipFile(altered, "w") as target:
        for name in source.namelist():
            target.writestr(name, b"tampered asset" if name == member else source.read(name))
    with pytest.raises(ValueError, match="does not match project source"):
        verify(altered, source_root)


def test_vsix_verifier_refuses_a_packaged_worker_whose_lock_is_stale(tmp_path: Path) -> None:
    """T7-07: the 0.3.6 artifact would have been caught before it reached a user's machine.

    The tampered lock is in the package *and* in the mirrored source, so the payload comparison
    passes and only the packaged-pair check can refuse the build.
    """
    package = tmp_path / "stale-lock.vsix"
    source_root = _write_vsix(package, stale_worker_lock=True)

    with pytest.raises(ValueError, match="packaged lockfile is stale"):
        verify(package, source_root)


def test_vsix_verifier_accepts_the_packaged_pair_as_this_release_ships_it(tmp_path: Path) -> None:
    package = tmp_path / "current.vsix"
    source_root = _write_vsix(package)
    result = verify(package, source_root)
    assert result["result"] == "passed"


def test_vsix_verifier_refuses_a_text_member_that_only_matches_after_line_ending_rewriting(tmp_path: Path) -> None:
    """0.3.7 review: the first 0.3.7 artifact was not reproducible from the tag.

    16 guides and `extension/media/toolkit.svg` were packaged with CRLF while the committed tree
    holds LF. The payload comparison normalises line endings, so only the reproducibility invariant
    refuses that artifact.
    """
    package = tmp_path / "crlf.vsix"
    source_root = _write_vsix(package, crlf_members=("extension/guides/pypdf.md", "extension/media/toolkit.svg"))

    with pytest.raises(ValueError, match="carry CRLF line endings.*not reproducible from the tag"):
        verify(package, source_root)


def test_vsix_verifier_refuses_crlf_even_when_the_source_tree_is_crlf_too(tmp_path: Path) -> None:
    """A CRLF artifact that matches a CRLF working tree is still not buildable from the tag."""
    package = tmp_path / "crlf-both.vsix"
    source_root = _write_vsix(package, crlf_members=("extension/guides/pypdf.md",), source_crlf=True)

    with pytest.raises(ValueError, match="carry CRLF line endings"):
        verify(package, source_root)


def test_vsix_verifier_accepts_the_shipped_text_members_as_lf(tmp_path: Path) -> None:
    package = tmp_path / "lf.vsix"
    source_root = _write_vsix(package)
    receipt = verify(package, source_root)
    assert receipt["result"] == "passed"


def test_vsix_verifier_refuses_members_stamped_with_the_build_clock(tmp_path: Path) -> None:
    """Every member byte-identical is not enough: the entry headers carry the build time."""
    stamped = tmp_path / "stamped.vsix"
    unstamped = tmp_path / "unstamped.vsix"
    source_root = _write_vsix(stamped)
    _write_vsix(unstamped, build_clock=True)

    assert verify(stamped, source_root)["result"] == "passed"
    with pytest.raises(ValueError, match="build epoch"):
        verify(unstamped, source_root)


def test_vsix_verifier_refuses_members_whose_permission_bits_come_from_the_build_tree(tmp_path: Path) -> None:
    package = tmp_path / "loose-modes.vsix"
    source_root = _write_vsix(package, loose_modes=("extension/guides/pypdf.md", "extension/worker/uv.lock"))

    with pytest.raises(ValueError, match="permission bits other than 0644"):
        verify(package, source_root)
