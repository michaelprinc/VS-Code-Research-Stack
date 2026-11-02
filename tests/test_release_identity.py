"""Cross-language release identity: the release declares exactly one version.

Reads only (nothing here writes or repackages): pyproject.toml, src/research_stack/__init__.py,
extension/package.json, extension/vsix-manifest.json, extension/runtime.js and
extension/worker/bundle.json. Standard library only (tomllib needs Python 3.11+; the project
venv is 3.13), no network, no packaging.
"""

from __future__ import annotations

import json
import re
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]

PYPROJECT = ROOT / "pyproject.toml"
PACKAGE_PYTHON = ROOT / "src" / "research_stack" / "__init__.py"
EXTENSION_PACKAGE_JSON = ROOT / "extension" / "package.json"
VSIX_MANIFEST = ROOT / "extension" / "vsix-manifest.json"
RUNTIME_JS = ROOT / "extension" / "runtime.js"
WORKER_BUNDLE = ROOT / "extension" / "worker" / "bundle.json"

# `@vscode/vsce` validates the extension manifest with `semver.valid`, and the VS Code Marketplace
# accepts "one to three numbers" (microsoft/vscode-vsce #415, closed as designed). A four-part version
# such as 0.3.6.1 cannot be packaged at all, so the release identity is three-part and stays strict.
VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _toml_version() -> str:
    version = tomllib.loads(_read(PYPROJECT))["project"]["version"]
    assert isinstance(version, str), "pyproject.toml [project].version is not a string"
    return version


def _dunder_version() -> str:
    match = re.search(r'^__version__ = "([^"]+)"', _read(PACKAGE_PYTHON), re.M)
    assert match is not None, f"{PACKAGE_PYTHON.relative_to(ROOT)} does not declare __version__"
    return match.group(1)


def _json_version(path: Path) -> str:
    manifest = json.loads(_read(path))
    version = manifest.get("version")
    assert isinstance(version, str), f"{path.relative_to(ROOT)} has no string version"
    return version


def _runtime_constant(name: str) -> str:
    match = re.search(rf"const {name} = \"([^\"]+)\";", _read(RUNTIME_JS))
    assert match is not None, f"extension/runtime.js does not declare const {name}"
    return match.group(1)


def _runtime_folder_template() -> str:
    match = re.search(r"const WORKER_FOLDER = `([^`]*)`;", _read(RUNTIME_JS))
    assert match is not None, "extension/runtime.js does not declare const WORKER_FOLDER"
    return match.group(1)


def declared_versions() -> dict[str, str]:
    """Every place the 0.3.x release states its version."""
    return {
        "pyproject.toml [project].version": _toml_version(),
        "src/research_stack/__init__.py __version__": _dunder_version(),
        "extension/package.json version": _json_version(EXTENSION_PACKAGE_JSON),
        "extension/vsix-manifest.json version": _json_version(VSIX_MANIFEST),
        "extension/runtime.js WORKER_VERSION": _runtime_constant("WORKER_VERSION"),
    }


def test_release_declares_one_version_in_every_source() -> None:
    declared = declared_versions()
    distinct = sorted(set(declared.values()))
    assert len(distinct) == 1, "release identity is split across sources:\n" + json.dumps(declared, indent=2)
    assert VERSION_PATTERN.fullmatch(distinct[0]), f"unexpected version shape: {distinct[0]!r}"


@pytest.mark.parametrize("source", sorted(declared_versions()))
def test_source_states_the_python_package_version(source: str) -> None:
    expected = _toml_version()
    assert declared_versions()[source] == expected, f"{source} disagrees with pyproject.toml"


def test_worker_folder_names_the_worker_version() -> None:
    worker_version = _runtime_constant("WORKER_VERSION")
    template = _runtime_folder_template()
    # The folder is a template literal interpolated from WORKER_VERSION, so the managed path a
    # running extension uses is `.research-toolkit/managed/worker-<WORKER_VERSION>`.
    assert template == ".research-toolkit/managed/worker-${WORKER_VERSION}"
    effective = template.replace("${WORKER_VERSION}", worker_version)
    assert effective == f".research-toolkit/managed/worker-{worker_version}"


def test_worker_bundle_records_the_extension_version() -> None:
    bundle = json.loads(_read(WORKER_BUNDLE))
    extension_version = _json_version(EXTENSION_PACKAGE_JSON)
    assert bundle.get("extensionVersion") == extension_version, (
        f"extension/worker/bundle.json records extensionVersion {bundle.get('extensionVersion')!r} "
        f"but extension/package.json is {extension_version!r}"
    )
    assert bundle.get("workerVersion") == _runtime_constant("WORKER_VERSION")
    assert bundle.get("schemaVersion") == 2


def test_managed_folder_pattern_accepts_this_release() -> None:
    """`discoverRuntimes` must see the folder this release names, or the runtime becomes invisible."""
    match = re.search(r"const WORKER_FOLDER_PATTERN = (/[^/]+/);", _read(RUNTIME_JS))
    assert match is not None, "extension/runtime.js does not declare const WORKER_FOLDER_PATTERN"
    pattern = re.compile(match.group(1)[1:-1])
    worker_version = _runtime_constant("WORKER_VERSION")
    assert pattern.fullmatch(f"worker-{worker_version}"), (
        f"WORKER_FOLDER_PATTERN {match.group(1)} does not accept this release's managed folder "
        f"worker-{worker_version}; discovery, activation and rollback would skip the current runtime"
    )
    for folder in ("worker-0.3.6", "worker-0.3.7", "worker-0.4.0"):
        assert pattern.fullmatch(folder), f"{folder} must be discoverable"
    # A four-part name is not a runtime this toolkit can produce: vsce refuses to package such a
    # version, so accepting it here would only hide a manifest that cannot be built.
    assert pattern.fullmatch("worker-0.3.6.1") is None, "a four-part managed folder is not a shippable runtime"
    assert pattern.fullmatch("worker-0.3") is None, "a partial version is not a runtime"


def test_release_version_is_one_vsce_can_package() -> None:
    """`semver.valid` in `@vscode/vsce` accepts at most three numbers; a fourth makes packaging fail."""
    version = _toml_version()
    assert VERSION_PATTERN.fullmatch(version), (
        f"{version!r} is not a version vsce can package: the extension manifest must be one to three "
        "numbers (microsoft/vscode-vsce #415). `npm run package` would stop here."
    )
