"""Audit the allow-listed contents and integrity of a packaged VSIX."""

from __future__ import annotations

import hashlib
import json
import re
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

EXPECTED = {
    "[Content_Types].xml",
    "extension.vsixmanifest",
    "extension/readme.md",
    "extension/extension.js",
    "extension/package.json",
}
MAX_PACKAGE_BYTES = 50 * 1024 * 1024
MAX_UNPACKED_BYTES = 1 * 1024 * 1024
SENSITIVE_NAMES = re.compile(r"(^|/)(\.env(\.|$)|\.venv|node_modules|\.git|corpus|models?|secrets?)(/|$)", re.I)
FORBIDDEN_ENTRY = re.compile(
    rb"\b(?:fetch\s*\(|XMLHttpRequest|WebSocket|child_process|subprocess|"
    rb"(?:exec|spawn)(?:Sync)?\s*\()|require\s*\(\s*['\"](?:node:)?"
    rb"(?:http|https|net|tls|child_process)['\"]",
    re.I,
)


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
                raise ValueError("unpacked payload exceeds the 1 MiB preview limit")
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
        entry = archive.read("extension/extension.js")
        if FORBIDDEN_ENTRY.search(entry):
            raise ValueError("extension entry introduces network or subprocess capabilities")
        expected_source = {
            "extension/package.json": source_root / "vsix-manifest.json",
            "extension/extension.js": source_root / "extension.js",
            "extension/readme.md": source_root / "README.md",
        }
        for member, source in expected_source.items():
            packaged_bytes = archive.read(member)
            source_bytes = source.read_bytes()
            if member == "extension/package.json":
                try:
                    matches = json.loads(packaged_bytes) == json.loads(source_bytes)
                except json.JSONDecodeError:
                    matches = False
            else:
                matches = packaged_bytes == source_bytes
            if not matches:
                raise ValueError(f"packaged payload does not match project source: {member}")
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    return {
        "artifact": artifact.name,
        "sha256": digest,
        "packageBytes": package_size,
        "unpackedBytes": unpacked_bytes,
        "entries": sorted(names),
        "sourceFilesMatch": True,
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
