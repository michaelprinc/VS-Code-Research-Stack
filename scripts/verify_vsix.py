"""Audit the allow-listed contents and integrity of a packaged VSIX."""

from __future__ import annotations

import hashlib
import json
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lockintegrity

EXPECTED = {
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/readme.md",
    "extension/LICENSE.txt",
    "extension/changelog.md",
    "extension/SUPPORT.md",
    "extension/SECURITY.md",
    "extension/extension.js",
    "extension/ui.js",
    # 0.3.9: the bundle installer module. `extension/extension.js` requires './bundles', so a package
    # that ships the bundle payload without the module that reads it activates and then fails to load.
    "extension/bundles.js",
    # 0.3.10: the published-version check and the problem-report builder. `extension/extension.js`
    # requires both, so a package that omits either activates and then fails to load.
    "extension/updates.js",
    "extension/reports.js",
    # 0.3.10: the Marketplace tile icon. vsce rejects an SVG icon outright and rejects a declared icon
    # that is not in the package, so the PNG is an audited member rather than a stray file.
    "extension/media/toolkit.png",
    "extension/media/controls.js",
    "extension/media/controls.css",
    "extension/media/toolkit.svg",
    "extension/package.json",
    "extension/diagnostics.js",
    "extension/runner.js",
    "extension/hosttools.js",
    "extension/preflight.js",
    "extension/setuplog.js",
    "extension/steps.js",
    "extension/status.js",
    "extension/lockfile.js",
    "extension/probe.py",
    "extension/components.json",
    "extension/presets.json",
    "extension/guides/index.md",
    "extension/guides/onboarding.md",
    "extension/guides/maintenance.md",
    "extension/runtime.js",
    "extension/installer.js",
    "extension/functional_check.py",
    "extension/worker/bundle.json",
}
_TEXT_SUFFIXES = {".md", ".js", ".cjs", ".mjs", ".json", ".py", ".toml", ".txt", ".svg", ".css", ".html", ".yml", ".yaml"}
# The ZIP format cannot record a date before 1980-01-01, so the build stamps every entry to it.
BUILD_EPOCH = (1980, 1, 1, 0, 0, 0)
# vsce generates the manifest, content types, readme and changelog assets itself.
GENERATED_MEMBERS = frozenset({"[Content_Types].xml", "extension.vsixmanifest", "extension/readme.md", "extension/changelog.md"})



def _lf(data: bytes) -> bytes:
    """Line endings as `extension/scripts/package.js` stages them: LF only.

    `.gitattributes` says `* text=auto eol=lf`, but a maintainer's tree can still hold CRLF copies of
    the guides — git normalises them on commit, so `git status` stays clean while the file on disk keeps
    CRLF. vsce copies those bytes verbatim, which made the 0.3.7 build from this tree differ from a
    build of the same tag in a fresh clone in 17 members. The packager now normalises the staged tree,
    and this audit compares normalised bytes so a line-ending difference is neither a payload mismatch
    nor a build-host-specific digest.
    """
    return data.replace(b"\r\n", b"\n")


_EXTENSION_ROOT = Path(__file__).resolve().parents[1] / "extension"
_COMPONENTS = json.loads((_EXTENSION_ROOT / "components.json").read_text(encoding="utf-8"))["components"]
_REPO_ROOT = _EXTENSION_ROOT.parent
WORKER_FILES = ['pyproject.toml', 'uv.lock', '.python-version', 'README.md'] + [
    str(p.relative_to(_REPO_ROOT)).replace('\\', '/') for p in sorted((_REPO_ROOT / 'src/research_stack').glob('*.py'))
]
EXPECTED.update(f"extension/worker/{relative}" for relative in WORKER_FILES)
_BUNDLE = json.loads((_EXTENSION_ROOT / "worker/bundle.json").read_text(encoding="utf-8"))
if _BUNDLE.get("schemaVersion") != 2 or _BUNDLE.get("overlayFiles") is None:
    raise ValueError("Worker bundle manifest is not the reviewed schemaVersion 2 layout")
OVERLAY_FILES = list(_BUNDLE["overlayFiles"])
EXPECTED.update(f"extension/worker/overlay/{relative}" for relative in OVERLAY_FILES)
# --- 0.3.9 skill bundles (DD9-16, DD9-17, R9-19) ---
# The bundle payload is a separate group from the worker overlay: `extension/runtime.js` and
# `scripts/build_worker_bundle.py` allow only `.github/skills/<id>/SKILL.md` under the overlay, and a
# bundle carries references/, scripts/, evals/ and README.md. The overlay regexes are deliberately not
# widened; the bundle group is expected and audited here instead, from its own catalog.
_BUNDLE_CATALOG = json.loads((_EXTENSION_ROOT / "bundles/catalog.json").read_text(encoding="utf-8"))
if _BUNDLE_CATALOG.get("schemaVersion") != 1 or not _BUNDLE_CATALOG.get("bundles"):
    raise ValueError("Skill-bundle catalog is not the reviewed schemaVersion 1 layout")
BUNDLE_FILES: list[str] = []
for _bundle in _BUNDLE_CATALOG["bundles"]:
    for _entry in _bundle.get("files") or []:
        _path = PurePosixPath(str(_entry.get("path")))
        if _path.is_absolute() or ".." in _path.parts or "\\" in str(_entry.get("path")) or _path.parts[0] != _bundle["id"]:
            raise ValueError(f"Unsafe bundle file path in the catalog: {_entry.get('path')!r}")
        BUNDLE_FILES.append(_path.as_posix())
if not BUNDLE_FILES:
    raise ValueError("Skill-bundle catalog lists no files")
EXPECTED.add("extension/bundles/catalog.json")
EXPECTED.update(f"extension/bundles/{relative}" for relative in BUNDLE_FILES)
for _component in _COMPONENTS:
    _guide = PurePosixPath(_component["guide"])
    if len(_guide.parts) != 2 or _guide.parts[0] != "guides" or _guide.suffix != ".md" or _guide.name != f"{_component['id']}.md":
        raise ValueError("Unsafe component guide path in registry")
    EXPECTED.add(f"extension/{_guide}")
MAX_PACKAGE_BYTES = 50 * 1024 * 1024
# Measured, not assumed. The 0.3.8 artifact unpacked to 1 035 352 bytes of the 1 048 576 this gate
# allowed — 13 224 bytes of headroom across 87 members. 0.3.9 adds a reviewed skill bundle
# (`extension/bundles/theological-research/**`, 60 825 bytes over 11 files) and its catalog
# (`extension/bundles/catalog.json`, 5 536 bytes), and the 0.3.9 worker/guides growth measured in this
# tree is 1 075 616 bytes for the same 87 members. The projected 0.3.9 payload is 1 141 977 bytes.
# The ceiling is raised to 1 310 720 (1.25 MiB) deliberately: it keeps a real gate — 168 743 bytes of
# headroom, not an open door — and it is stated here so the next member added to the payload is
# measured against a number rather than discovered by a failing audit. If a build exceeds it, the fix
# is to move payload out of the VSIX or to re-measure here, never to drop a reviewed file.
MAX_UNPACKED_BYTES = 1_310_720
SENSITIVE_NAMES = re.compile(r"(^|/)(\.env(\.|$)|\.venv|node_modules|\.git|corpus|models?|secrets?)(/|$)", re.I)
# The capability scan is about starting a process or opening a socket. A method call on an object
# (`SOME_PATTERN.exec(text)` on a RegExp, which `extension/lockfile.js` uses to read a version) is
# neither, so the call must be unqualified to count: `exec(`, `execFile(`, `spawn(`, `execSync(`.
# A process call still cannot hide behind that rule, because every one of them needs
# `require("node:child_process")`, which is forbidden here outright and counted exactly once for the
# one reviewed boundary member in the loop below.
FORBIDDEN_ENTRY = re.compile(
    rb"\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|child_process|subprocess|"
    rb"(?<![.\w])(?:exec|execFile|spawn)(?:Sync)?\s*\()|require\s*\(\s*['\"](?:node:)?"
    rb"(?:http|https|net|tls|child_process)['\"]",
    re.I,
)

# 0.3.10: the published-version check is the one reviewed outbound-network edge in the packaged
# extension, and it is reviewed as a named member plus the bounds it must keep — not as a blanket
# permission. It cannot move to another file, grow a second request site, drop its timeout or byte cap,
# or point at a host other than the Marketplace the extension is published on. The source-tree half of
# this review is `extension/test/module-boundaries.test.js`; this half measures the shipped bytes.
REVIEWED_JS_NETWORK_MEMBERS = frozenset({"extension/updates.js"})
REVIEWED_JS_NETWORK_IMPORT = b'const https = require("node:https");'
REVIEWED_JS_NETWORK_BOUNDS = (
    b'const MARKETPLACE_HOST = "marketplace.visualstudio.com";',
    b"const REQUEST_TIMEOUT_MS = 8000;",
    b"const MAX_RESPONSE_BYTES = 64 * 1024;",
    b"const CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000;",
    b"function httpsGet(",
)
REVIEWED_JS_NETWORK_EXTRA_TRANSPORT = re.compile(
    rb"\bXMLHttpRequest\b|\bWebSocket\b|\bfetch\s*\(|require\s*\(\s*['\"](?:node:)?"
    rb"(?:net|tls|dgram|child_process|fs|worker_threads)['\"]|\bFunction\(|\beval\(",
)

# --- Python half of the review (added after the independent 0.3.6 audit) ---
# Measured on the packaged 0.3.6 payload (17 packaged .py members): the only process- or
# dynamic-code primitive present in any packaged Python member is the single
# `__import__("mcp_types", fromlist=["ToolAnnotations"])` library-presence probe on line 54 of
# extension/probe.py. `subprocess`, `os.system`, `os.popen`, `os.exec*`, `eval(`, `exec(`, `pty`
# and `multiprocessing` have zero occurrences, so every one of them — and `__import__(` itself —
# stays forbidden for every member, and the allowlist below is the single reviewed exception
# (its literal-shaped matches are removed before the forbidden scan).
PYTHON_FORBIDDEN_PRIMITIVE = re.compile(
    rb"\bsubprocess\b|(?<![\w.])eval\s*\(|(?<![\w.])exec\s*\(|__import__\s*\(|"
    rb"os\.(?:system|popen|exec\w*)\s*\(|\bpty\b|\bmultiprocessing\b",
)
# Reviewed allowlist keyed by packaged member path. Each entry is a literal-shaped pattern (the
# imported module name must be a literal string), and its matches are removed before the
# forbidden scan, so any *other* dynamic import or dynamic-code call in the same member is still
# rejected.
PYTHON_REVIEWED_PRIMITIVES = {
    # extension/probe.py: bounded read-only diagnostic that proves the pinned `mcp_types`
    # distribution (declared in the reviewed pyproject.toml) is importable. Literal module name,
    # no evaluated source, no user input, no process execution.
    "extension/probe.py": re.compile(
        rb'__import__\(\s*["\']mcp_types["\']\s*,\s*fromlist=\[[^\]]*\]\s*\)'
    ),
}
# Outbound-network capability, measured (not assumed) across every packaged member.
NETWORK_PRIMITIVE = re.compile(
    rb"\burllib\.request\b|\burlopen\b|\bbuild_opener\b|\bhttp\.client\b|\bsocket\b|"
    rb"\bXMLHttpRequest\b|\bWebSocket\b|\bfetch\s*\(|require\s*\(\s*['\"](?:node:)?"
    rb"(?:http|https|net|tls)['\"]",
)
URL_PARSE_ONLY = re.compile(rb"\burllib\.parse\b")
OUTBOUND_PYTHON = re.compile(rb"\burllib\.request\b|\burlopen\b|\bbuild_opener\b|\bsocket\b|\bhttp\.client\b")
DEVELOPMENT_ONLY_MANIFEST_FIELDS = ("scripts", "devDependencies", "private")


def verify(path: Path, source_root: Path | None = None) -> dict[str, object]:
    artifact = path.resolve(strict=True)
    source_root = source_root or Path(__file__).resolve().parents[1] / "extension"
    package_size = artifact.stat().st_size
    if package_size > MAX_PACKAGE_BYTES:
        raise ValueError(f"package exceeds proposed 50 MiB target ({package_size} bytes)")
    with zipfile.ZipFile(artifact) as archive:
        names: list[str] = []
        unpacked_bytes = 0
        for info in archive.infolist():
            name = info.filename
            pure_name = PurePosixPath(name)
            if pure_name.is_absolute() or ".." in pure_name.parts or "\\" in name:
                raise ValueError(f"unsafe archive path: {name!r}")
            if SENSITIVE_NAMES.search(name):
                raise ValueError(f"sensitive or heavyweight path in package: {name!r}")
            if info.external_attr:
                mode = (info.external_attr >> 16) & 0xFFFF
                if stat.S_ISLNK(mode):
                    raise ValueError(f"symbolic link in package: {name!r}")
            if name in names:
                raise ValueError(f"duplicate archive member: {name!r}")
            names.append(name)
            unpacked_bytes += info.file_size
            if unpacked_bytes > MAX_UNPACKED_BYTES:
                raise ValueError(
                    f"unpacked payload exceeds the {MAX_UNPACKED_BYTES} byte preview limit "
                    f"({unpacked_bytes} bytes measured)"
                )
        if set(names) != EXPECTED:
            raise ValueError(f"unexpected package inventory: expected {sorted(EXPECTED)!r}; got {sorted(names)!r}")
        manifest = json.loads(archive.read("extension/package.json"))
        source_manifest = json.loads((source_root / "vsix-manifest.json").read_bytes())
        if manifest.get("name") != "research-stack-toolkit" or manifest.get("version") != source_manifest.get("version"):
            raise ValueError("extension manifest identity/version does not match the reviewed source")
        if manifest.get("dependencies"):
            raise ValueError("extension manifest contains runtime dependencies")
        if any(field in manifest for field in ("devDependencies", "scripts", "private")):
            raise ValueError("development-only npm metadata leaked into the VSIX")
        if source_root == _EXTENSION_ROOT:
            # The packaged manifest is also compared with the repository manifest, not only with
            # extension/vsix-manifest.json: the packaged copy must be exactly the repository
            # extension/package.json with the development-only fields removed. Gated on the real
            # source tree (same gate as the repository-drift check below) because tests audit a
            # synthetic source tree that has no repository manifest behind it.
            repository_manifest = json.loads((_REPO_ROOT / "extension" / "package.json").read_text(encoding="utf-8"))
            expected_manifest = {
                key: value for key, value in repository_manifest.items()
                if key not in DEVELOPMENT_ONLY_MANIFEST_FIELDS
            }
            if manifest != expected_manifest:
                differences = sorted(
                    set(manifest) ^ set(expected_manifest)
                    | {key for key in set(manifest) & set(expected_manifest) if manifest[key] != expected_manifest[key]}
                )
                raise ValueError(
                    "packaged extension/package.json is not the repository extension/package.json with "
                    f"{list(DEVELOPMENT_ONLY_MANIFEST_FIELDS)} removed; differing fields: {differences}"
                )
        python_members: list[str] = []
        python_dynamic_code_findings: list[dict[str, object]] = []
        for member in names:
            if member.endswith(".js"):
                script = archive.read(member)
                if member == "extension/runner.js":
                    # The shared runner is the only reviewed process boundary in the extension.
                    # DD7-12: the boundary is one bounded `childProcess.spawn(` — the tool run, started
                    # in its own POSIX process group so a stopped run can be reaped with `kill(-pid)` —
                    # plus one `childProcess.execFile(` for the Windows `taskkill` tree reaper. It is no
                    # longer an `execFile` run because Node builds `execFile`'s own spawn options and
                    # drops `detached`, which would point `kill(-pid)` at the editor's own group. The
                    # capture limit is enforced by the boundary itself, not by an option it ignores.
                    allowed_import = b'const childProcess = require("node:child_process");'
                    reviewed_calls = {b"childProcess.spawn(": 1, b"childProcess.execFile(": 1}
                    if script.count(allowed_import) != 1:
                        raise ValueError("runner process boundary differs from reviewed pattern")
                    for call, reviewed_count in reviewed_calls.items():
                        found = script.count(call)
                        if found != reviewed_count:
                            raise ValueError(
                                "runner process boundary differs from reviewed pattern: "
                                f"{call.decode()} occurs {found} times, {reviewed_count} is reviewed"
                            )
                    if b"shell: true" in script:
                        raise ValueError("runner process boundary differs from reviewed pattern: shell: true")
                    # The boundary is exactly one bounded spawn and one bounded taskkill reaper. Any other
                    # process primitive in the one reviewed file — a synchronous run, a fork, or a bare
                    # `exec` — is unreviewed even if the counts above still add up.
                    for forbidden in (b"execSync", b"spawnSync", b"forkSync", b".exec(", b".fork("):
                        if forbidden in script:
                            raise ValueError(
                                "runner process boundary differs from reviewed pattern: "
                                f"{forbidden.decode()} is not part of the reviewed boundary"
                            )
                    for required in (
                        b"const DEFAULT_TIMEOUT_MS = 8000;",
                        b"const MAX_BUFFER_BYTES = 8 * 1024 * 1024;",
                        b"const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;",
                        b"maxBuffer: MAX_BUFFER_BYTES",
                        b"sink.total >= MAX_BUFFER_BYTES",
                        b"windowsHide: true",
                        b"shell: false",
                        b'detached: os.platform() !== "win32"',
                        b'process.kill(-pid, "SIGKILL")',
                        b'const TASKKILL = "taskkill.exe";',
                        b"function taskkillArguments(pid)",
                        b'"/PID", String(pid), "/T", "/F"',
                    ):
                        if required not in script:
                            raise ValueError(f"runner process bounds missing: {required.decode()!r}")
                    for bound, reviewed_count in ((b"shell: false", 2), (b"windowsHide: true", 2)):
                        if script.count(bound) < reviewed_count:
                            raise ValueError(
                                f"runner process bounds missing: {bound.decode()} must guard both call sites "
                                f"({script.count(bound)} found, at least {reviewed_count} reviewed)"
                            )
                    script = (
                        script.replace(allowed_import, b"")
                        .replace(b"childProcess.spawn(", b"reviewedCall(")
                        .replace(b"childProcess.execFile(", b"reviewedCall(")
                    )
                if member in REVIEWED_JS_NETWORK_MEMBERS:
                    # The reviewed network edge, measured rather than assumed: one import, one request
                    # call site, the bounds that make it one small GET, and nothing else.
                    if script.count(REVIEWED_JS_NETWORK_IMPORT) != 1:
                        raise ValueError(
                            f"reviewed network member {member} must import its transport exactly once "
                            f"({script.count(REVIEWED_JS_NETWORK_IMPORT)} found)"
                        )
                    for required in REVIEWED_JS_NETWORK_BOUNDS:
                        if required not in script:
                            raise ValueError(f"reviewed network member {member} no longer keeps {required.decode()!r}")
                    if script.count(b"https.get(") != 1:
                        raise ValueError(
                            f"reviewed network member {member} must keep exactly one request call site "
                            f"({script.count(b'https.get(')} found)"
                        )
                    extra = REVIEWED_JS_NETWORK_EXTRA_TRANSPORT.search(script)
                    if extra:
                        raise ValueError(
                            f"reviewed network member {member} reaches beyond the one bounded Marketplace GET: "
                            f"{extra.group().decode(errors='replace')}"
                        )
                    script = script.replace(REVIEWED_JS_NETWORK_IMPORT, b"")
                if FORBIDDEN_ENTRY.search(script):
                    raise ValueError(f"extension introduces unreviewed network/process capabilities: {member}")
            elif member.endswith(".py"):
                payload = archive.read(member)
                python_members.append(member)
                reviewed = PYTHON_REVIEWED_PRIMITIVES.get(member)
                reviewed_matches: list[bytes] = []
                scanned = payload
                if reviewed is not None:
                    reviewed_matches = reviewed.findall(payload)
                    if len(reviewed_matches) > 1:
                        raise ValueError(
                            f"reviewed Python dynamic-import pattern occurs {len(reviewed_matches)} times in {member}; at most one is reviewed"
                        )
                    scanned = reviewed.sub(b"", payload)
                unreviewed = sorted({match.group(0).decode() for match in PYTHON_FORBIDDEN_PRIMITIVE.finditer(scanned)})
                if unreviewed:
                    raise ValueError(f"packaged Python introduces unreviewed process or dynamic-code capability in {member}: {unreviewed}")
                for match in reviewed_matches:
                    python_dynamic_code_findings.append(
                        {
                            "member": member,
                            "primitive": match.decode(errors="replace"),
                            "reviewed": True,
                            "reason": "literal module name from the reviewed pyproject dependency; library-presence probe only",
                        }
                    )
        # Measured, not assumed: which packaged members actually carry outbound-network capability.
        # 0.3.10: one member is reviewed and named above; anything else that reaches the network is a defect.
        outbound_js_members = sorted(
            member for member in names if member.endswith(".js") and NETWORK_PRIMITIVE.search(archive.read(member))
        )
        unreviewed_js_network_members = [member for member in outbound_js_members if member not in REVIEWED_JS_NETWORK_MEMBERS]
        if unreviewed_js_network_members:
            raise ValueError(f"packaged JavaScript introduces network capability: {unreviewed_js_network_members}")
        if [member for member in REVIEWED_JS_NETWORK_MEMBERS if member not in outbound_js_members]:
            raise ValueError(
                f"the reviewed network member is no longer the member this audit reviews: "
                f"{sorted(REVIEWED_JS_NETWORK_MEMBERS)} carries no outbound capability"
            )
        outbound_network_members = sorted(
            member for member in names
            if member.endswith(".py") and OUTBOUND_PYTHON.search(archive.read(member))
        )
        url_parse_only_members = sorted(
            member for member in names
            if member.endswith(".py")
            and URL_PARSE_ONLY.search(archive.read(member))
            and member not in outbound_network_members
        )
        expected_source = {member: source_root / member.removeprefix("extension/") for member in EXPECTED if member.startswith("extension/")}
        expected_source["extension/package.json"] = source_root / "vsix-manifest.json"
        expected_source["extension/readme.md"] = source_root / "README.md"
        expected_source["extension/changelog.md"] = source_root / "MARKETPLACE-CHANGELOG.md"
        for member, source in expected_source.items():
            packaged_bytes = archive.read(member)
            source_bytes = source.read_bytes()
            if member == "extension/package.json":
                try:
                    matches = json.loads(packaged_bytes) == json.loads(source_bytes)
                except json.JSONDecodeError:
                    matches = False
            else:
                # `extension/scripts/package.js` normalises the staged tree to LF, so the comparison is
                # made on normalised bytes: a maintainer's CRLF copy of a guide must not change the
                # release digest, and it must not look like a payload substitution either.
                matches = _lf(packaged_bytes) == _lf(source_bytes)
            if not matches:
                raise ValueError(f"packaged payload does not match project source: {member}")
        crlf_members = sorted(
            member for member in names
            if PurePosixPath(member).suffix.lower() in _TEXT_SUFFIXES and b"\r\n" in archive.read(member)
        )
        if crlf_members:
            raise ValueError(f"packaged text members carry CRLF line endings, so the artifact is not reproducible from the tag: {crlf_members}")
        # Line endings are only half of a reproducible artifact. vsce writes the copy time of each staged
        # file, and a new Date() for the members it generates, into the ZIP entry headers: two builds of
        # the same commit were 312,471 bytes each with byte-identical members and different digests.
        # `extension/scripts/package.js` sets SOURCE_DATE_EPOCH, which vsce applies to every entry, so a
        # member carrying any other timestamp means the artifact was built unstamped.
        unstamped = sorted(info.filename for info in archive.infolist() if info.date_time != BUILD_EPOCH)
        if unstamped:
            raise ValueError(
                "packaged members carry a build-time timestamp instead of the fixed build epoch, so the "
                f"artifact is not reproducible from the tag: {unstamped}"
            )
        # The same headers also carry the permission bits of the file that was packed. A maintainer's
        # tree and a fresh clone of the same tag disagree there — 32 members of the 0.3.7 build were 0664
        # here and 0644 in a clone, with identical content and different digests. vsce's own three
        # generated members are 0664 on every build; everything copied from the tree is 0644.
        loose_modes = sorted(
            info.filename for info in archive.infolist()
            if info.filename not in GENERATED_MEMBERS and (info.external_attr >> 16) & 0o777 != 0o644
        )
        if loose_modes:
            raise ValueError(
                "packaged members carry permission bits other than 0644, so the artifact depends on the "
                f"build tree rather than the tag: {loose_modes}"
            )
        bundle = json.loads(archive.read("extension/worker/bundle.json"))
        # The bundle must be the one the reviewed source tree builds for this release.
        reviewed_version = json.loads((_EXTENSION_ROOT / "vsix-manifest.json").read_text(encoding="utf-8")).get("version")
        reviewed_worker = re.search(r'const WORKER_VERSION = "([^"]+)";', (_EXTENSION_ROOT / "runtime.js").read_text(encoding="utf-8"))
        if reviewed_worker is None:
            raise ValueError("reviewed runtime.js does not declare a worker version")
        reviewed_worker_version = reviewed_worker.group(1)
        if reviewed_version != reviewed_worker_version:
            raise ValueError(f"reviewed source versions disagree: extension {reviewed_version} vs worker {reviewed_worker_version}")
        if (
            bundle.get('schemaVersion') != 2
            or bundle.get('workerVersion') != reviewed_worker_version
            or bundle.get('extensionVersion') != reviewed_version
            or set(bundle['files']) != set(WORKER_FILES)
            or set(bundle['overlayFiles']) != set(OVERLAY_FILES)
        ):
            raise ValueError('worker bundle schema/inventory mismatch')
        for relative, expected in list(bundle['files'].items()) + [
            (f"overlay/{name}", digest) for name, digest in bundle['overlayFiles'].items()
        ]:
            payload = archive.read(f'extension/worker/{relative}')
            if hashlib.sha256(payload).hexdigest() != expected:
                raise ValueError('worker bundle hash mismatch')
            if source_root == _EXTENSION_ROOT:
                source = (_REPO_ROOT / relative) if not relative.startswith('overlay/') else (_REPO_ROOT / 'templates/recommended-overlay' / relative.removeprefix('overlay/'))
                if payload != source.read_bytes():
                    raise ValueError(f'worker bundle drift from repository source: {relative}')
        # Skill bundles (R9-19): source -> payload -> VSIX member is one chain. Every catalog file must
        # be in the archive (the EXPECTED gate above), must hash to what the catalog says, must carry
        # the byte count the catalog says, and must be byte-identical to the staged template tree the
        # catalog was generated from. A bundle that is packaged but not the reviewed bundle is the same
        # class of defect 0.3.6 shipped in a lockfile, so it is refused here rather than reported.
        catalog = json.loads(archive.read("extension/bundles/catalog.json"))
        if catalog != _BUNDLE_CATALOG:
            raise ValueError("packaged skill-bundle catalog differs from the reviewed extension/bundles/catalog.json")
        bundle_audit: list[dict[str, object]] = []
        for bundle in catalog["bundles"]:
            bundle_id = str(bundle["id"])
            staged_tree = str((bundle.get("provenance") or {}).get("stagedTree") or "")
            if not staged_tree:
                raise ValueError(f"bundle {bundle_id}: provenance.stagedTree is required to audit the payload")
            for entry in bundle["files"]:
                member = f"extension/bundles/{entry['path']}"
                payload = archive.read(member)
                if hashlib.sha256(payload).hexdigest() != entry["sha256"]:
                    raise ValueError(f"skill bundle hash mismatch: {entry['path']}")
                if len(payload) != entry["bytes"]:
                    raise ValueError(f"skill bundle byte count mismatch: {entry['path']}")
                if source_root == _EXTENSION_ROOT:
                    within = PurePosixPath(entry["path"]).relative_to(PurePosixPath(bundle_id))
                    staged = _REPO_ROOT / staged_tree / within
                    if not staged.is_file():
                        raise ValueError(f"skill bundle has no staged source file: {entry['path']}")
                    if _lf(payload) != _lf(staged.read_bytes()):
                        raise ValueError(f"skill bundle drift from the staged template tree: {entry['path']}")
            if str(bundle.get("license", "")).strip().lower().startswith("unresolved") and bundle.get("publishable"):
                raise ValueError(f"bundle {bundle_id}: license is unresolved, so the package may not mark it publishable (DD9-24)")
            bundle_audit.append({
                "id": bundle_id,
                "version": bundle.get("version"),
                "files": len(bundle["files"]),
                "bytes": sum(int(entry["bytes"]) for entry in bundle["files"]),
                "license": bundle.get("license"),
                "publishable": bool(bundle.get("publishable")),
            })
        # The packaged pairs are the pairs a host runs `uv sync --locked` against, so they are compared        # as packaged bytes and not only as the repository tree: 0.3.6 shipped a worker lock that still
        # recorded the 0.3.4 project version, and every managed setup on a real host stopped there.
        packaged_problems: list[str] = []
        for prefix in ("extension/worker", "extension/worker/overlay/notebooks/analysis"):
            packaged_problems.extend(lockintegrity.check_pair_text(
                archive.read(f"{prefix}/pyproject.toml").decode("utf-8"),
                archive.read(f"{prefix}/uv.lock").decode("utf-8"),
                f"packaged {prefix}/uv.lock",
            ))
        if packaged_problems:
            raise ValueError("packaged lockfile is stale: " + "; ".join(packaged_problems))
        # Documentation that ships inside the payload must name the release it ships in. 0.3.7 shipped
        # guides and a worker README that still told the operator to install
        # `research-stack-toolkit-0.3.6.vsix` and look in `worker-0.3.6/` — the text the operator follows
        # was two releases behind the code, and nothing tested it.
        versioned_reference = re.compile(r"(?:worker-|research-stack-toolkit-)(\d+\.\d+\.\d+)(?![\d.])")
        stale_docs: list[str] = []
        for member in names:
            if not (member.startswith("extension/guides/") or member in {"extension/readme.md", "extension/worker/README.md"}):
                continue
            for found in versioned_reference.findall(archive.read(member).decode("utf-8", errors="replace")):
                if found != reviewed_version:
                    stale_docs.append(f"{member}: {found}")
        if stale_docs:
            raise ValueError(
                f"packaged documentation names a release other than {reviewed_version}: {sorted(set(stale_docs))}"
            )
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    reviewed_dynamic_code_boundary = (
        f"{len(python_members)} packaged Python members scanned for eval(, exec(, __import__(, "
        "subprocess, os.system, os.popen, os.exec*, pty and multiprocessing. "
        + (
            "Reviewed allowlist: " + "; ".join(f"{finding['member']} -> {finding['primitive']}" for finding in python_dynamic_code_findings)
            if python_dynamic_code_findings
            else "No dynamic-code or process-execution primitive present in any packaged Python member."
        )
    )
    reviewed_network_boundary = (
        "Measured over every packaged member. Packaged JavaScript outbound capability: "
        + (", ".join(outbound_js_members) if outbound_js_members else "none")
        + " — reviewed as one bounded HTTPS GET to marketplace.visualstudio.com with a timeout, a byte "
        "cap and a 24 hour cooldown; no other packaged JavaScript matched fetch, XMLHttpRequest, WebSocket, "
        "require(node:http|https|net|tls), urllib.request, socket or http.client. Packaged Python outbound network: "
        + (", ".join(outbound_network_members) if outbound_network_members else "none")
        + ". "
        + (
            "urllib is imported without outbound capability (URL quoting only) in " + ", ".join(url_parse_only_members) + "."
            if url_parse_only_members
            else "No packaged Python member imports urllib without outbound capability."
        )
    )
    return {
        "artifact": artifact.name,
        "sha256": digest,
        "packageBytes": package_size,
        "unpackedBytes": unpacked_bytes,
        "entries": sorted(names),
        "sourceFilesMatch": True,
        "reviewedProcessBoundary": (
            "extension/runner.js (the only process-execution call site in packaged JavaScript); "
            f"the {len(python_members)} packaged Python members were scanned separately and none of them "
            "executes a process (subprocess, os.system, os.popen, os.exec*, pty and multiprocessing are forbidden)"
        ),
        "reviewedDynamicCodeBoundary": reviewed_dynamic_code_boundary,
        "reviewedNetworkBoundary": reviewed_network_boundary,
        "pythonMembersScanned": sorted(python_members),
        "pythonDynamicCodeFindings": python_dynamic_code_findings,
        "outboundNetworkMembers": outbound_network_members,
        "skillBundleCatalog": {
            "bundles": bundle_audit,
            "files": sum(int(item["files"]) for item in bundle_audit),
            "bytes": sum(int(item["bytes"]) for item in bundle_audit),
            "unresolvedLicenses": [item["id"] for item in bundle_audit if str(item["license"]).lower().startswith("unresolved")],
            "publishable": all(bool(item["publishable"]) for item in bundle_audit),
        },
        "reviewedBundleBoundary": (
            f"{len(bundle_audit)} reviewed skill bundle(s), {sum(int(item['files']) for item in bundle_audit)} file(s), "
            "packaged under extension/bundles/ and hashed against extension/bundles/catalog.json and the "
            "staged template tree. Bundle files are not worker overlay files: the overlay allowlist "
            "(scripts/build_worker_bundle.py, extension/runtime.js) still accepts only "
            ".github/skills/<id>/SKILL.md and was not widened."
        ),
        "result": "passed",
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python scripts/verify_vsix.py <artifact.vsix>", file=sys.stderr)
        return 2
    try:
        print(json.dumps(verify(Path(sys.argv[1])), indent=2))
    except (OSError, zipfile.BadZipFile, ValueError, json.JSONDecodeError) as exc:
        print(f"VSIX audit failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
