from __future__ import annotations

import json
import importlib.util
import zipfile
from pathlib import Path

import pytest

_VERIFIER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "verify_vsix.py"
_SPEC = importlib.util.spec_from_file_location("research_stack_vsix_verifier", _VERIFIER_PATH)
assert _SPEC is not None and _SPEC.loader is not None
_VERIFIER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_VERIFIER)
EXPECTED = _VERIFIER.EXPECTED
verify = _VERIFIER.verify


def _write_vsix(path: Path, *, include_extra: bool = False) -> Path:
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
    if include_extra:
        members["extension/.env"] = b"secret"
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in members.items():
            archive.writestr(name, content)
    source_root = path.parent / "source"
    source_root.mkdir(exist_ok=True)
    (source_root / "vsix-manifest.json").write_bytes(members["extension/package.json"])
    (source_root / "extension.js").write_bytes(members["extension/extension.js"])
    (source_root / "README.md").write_bytes(members["extension/readme.md"])
    (source_root / "media").mkdir(exist_ok=True)
    for member in EXPECTED:
        if member.startswith("extension/") and member not in ("extension/package.json", "extension/readme.md"):
            destination = source_root / member.removeprefix("extension/")
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(members[member])
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
