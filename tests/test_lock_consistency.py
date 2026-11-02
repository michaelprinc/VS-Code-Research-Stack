"""Lockfile integrity: every uv project this toolkit ships must be lock-current.

0.3.6 shipped `extension/worker/pyproject.toml` declaring `version = "0.3.6"` beside a
`extension/worker/uv.lock` whose root entry still recorded `version = "0.3.4"`. uv compares a lockfile
with the project metadata before it honours `--locked`, so every managed component setup on a real host
stopped with "The lockfile at `uv.lock` needs to be updated, but `--locked` was provided." Nothing in
the build, the audit or the tests compared the two files, so the same defect shipped in 0.3.5 and 0.3.6.

These tests are the gate. They read the pair the way uv reads it — no uv, no network, no environment —
and, when a uv is present on the development host, they also run uv's own `uv lock --check`.

The synthetic fixtures mirror the shapes real uv writes. Where a fixture declares a lock entry as
`editable`, its manifest declares a `[build-system]`, because that is what makes uv write `editable`
rather than `virtual` (measured with uv 0.13.6 and uv 0.5.0 on a probe project).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import build_worker_bundle  # noqa: E402
import lockintegrity  # noqa: E402

WORKER_PAIR = ("extension/worker/pyproject.toml", "extension/worker/uv.lock")
NOTEBOOK_PAIR = (
    "templates/recommended-overlay/notebooks/analysis/pyproject.toml",
    "templates/recommended-overlay/notebooks/analysis/uv.lock",
)
# A manifest with a build-system is a packaged project, so uv records its root entry as
# `source = { editable = "." }`; without one, uv records `virtual`.
BUILD_SYSTEM = '\n[build-system]\nrequires = ["hatchling==1.27.0"]\nbuild-backend = "hatchling.build"\n'


def uv_binary() -> str | None:
    """The uv this host offers, or None. The uv gate is real when it exists and skipped when it does not.

    `RESEARCH_STACK_UV` names the uv to gate with, so a release build can pin the same uv it generated
    the lockfile with. A uv on `PATH` is honoured too.
    """
    named = os.environ.get("RESEARCH_STACK_UV")
    if named:
        resolved = shutil.which(named) or (named if Path(named).is_file() else None)
        assert resolved, f"RESEARCH_STACK_UV names {named!r}, which is not an executable"
        return resolved
    return shutil.which("uv")


def test_every_shipped_pair_is_lock_current() -> None:
    report = lockintegrity.check_tree(ROOT)
    assert report["ok"], "shipped lockfile drift:\n" + "\n".join(str(problem) for problem in report["problems"])
    assert set(report["pairs"]) == {"pyproject.toml", WORKER_PAIR[0], NOTEBOOK_PAIR[0]}


def test_worker_bundle_carries_the_reviewed_pair_byte_for_byte() -> None:
    """The pair a host syncs is the pair the repository reviews; a hand-edited bundle copy is drift."""
    for name in ("pyproject.toml", "uv.lock"):
        assert (ROOT / "extension/worker" / name).read_bytes() == (ROOT / name).read_bytes(), (
            f"extension/worker/{name} differs from the reviewed {name}; rebuild the worker bundle"
        )


def test_bundled_lock_records_the_version_the_bundled_manifest_declares() -> None:
    declared = tomllib.loads((ROOT / "extension/worker/pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    entry = lockintegrity.root_lock_entry(ROOT / "extension/worker/uv.lock")
    assert entry["version"] == declared, (
        f"the bundled worker lock records {entry['version']!r} while the bundled manifest declares {declared!r}; "
        "uv sync --locked refuses this pair"
    )


def test_the_locked_package_set_is_the_reviewed_set() -> None:
    """A re-lock must not smuggle new package versions into a release."""
    pins = lockintegrity.lock_dependency_set(ROOT / "extension/worker/uv.lock")
    assert len(pins) == 40 - 1, "the reviewed worker lock pins 39 third-party packages plus the project itself"
    for name, specifier in {("mcp", "==2.2.0"), ("mcp-types", "==2.2.0"), ("pypdf", "==6.4.1"), ("python-docx", "==1.2.0")}:
        declared = lockintegrity.canonical_name(name)
        assert any(declared == pinned for pinned, _ in pins), f"{name} is not in the locked set"
        assert specifier.startswith("==")


def test_lockfile_revision_stays_readable_by_the_declared_uv_floor() -> None:
    for lock_relative in ("uv.lock", WORKER_PAIR[1], NOTEBOOK_PAIR[1]):
        revision = lockintegrity.lock_document(ROOT / lock_relative).get("revision", 1)
        assert isinstance(revision, int) and revision <= lockintegrity.EXPECTED_REVISION_MAX, (
            f"{lock_relative} records lockfile revision {revision}, above the reviewed maximum "
            f"{lockintegrity.EXPECTED_REVISION_MAX}"
        )


# --- the detector itself, proven on the exact defect that shipped -------------------------------

def _fixture(tmp_path: Path, lock_text: str, pyproject_text: str) -> None:
    (tmp_path / "pyproject.toml").write_text(pyproject_text, encoding="utf-8")
    (tmp_path / "uv.lock").write_text(lock_text, encoding="utf-8")


def _root_lock(extra: str = "") -> str:
    return (
        'version = 1\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { editable = "." }\n'
        + extra
    )


def _packaged_manifest(dependencies: str = "", groups: str = "", python: str = "") -> str:
    return (
        '[project]\nname = "p"\nversion = "1.0.0"\n' + python + 'dependencies = [' + dependencies + ']\n'
        + groups + BUILD_SYSTEM
    )


def test_version_only_drift_is_detected(tmp_path: Path) -> None:
    """The 0.3.6 defect, reproduced as a fixture: manifest 0.3.6, lock 0.3.4."""
    _fixture(tmp_path, 'version = 1\nrevision = 3\n[[package]]\nname = "research-stack-basic"\nversion = "0.3.4"\nsource = { editable = "." }\n',
             '[project]\nname = "research-stack-basic"\nversion = "0.3.6"\n' + BUILD_SYSTEM)
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert len(problems) == 1, problems
    assert "root package version '0.3.4'" in problems[0]
    assert "uv sync --locked would refuse this pair" in problems[0]


def test_matching_versions_are_accepted(tmp_path: Path) -> None:
    _fixture(tmp_path, 'version = 1\nrevision = 3\n[[package]]\nname = "research-stack-basic"\nversion = "0.3.6.1"\nsource = { editable = "." }\n',
             '[project]\nname = "research-stack-basic"\nversion = "0.3.6.1"\n' + BUILD_SYSTEM)
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


def test_dependency_specifier_drift_is_detected(tmp_path: Path) -> None:
    _fixture(
        tmp_path,
        'version = 1\n[[package]]\nname = "research-stack-basic"\nversion = "1.0.0"\nsource = { editable = "." }\n\n[package.metadata]\nrequires-dist = [{ name = "pypdf", specifier = "==6.4.0" }]\n',
        '[project]\nname = "research-stack-basic"\nversion = "1.0.0"\ndependencies = ["pypdf==6.4.1"]\n' + BUILD_SYSTEM,
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("declared dependencies differ" in problem for problem in problems), problems


def test_dependency_group_drift_is_detected(tmp_path: Path) -> None:
    _fixture(
        tmp_path,
        'version = 1\n[[package]]\nname = "research-stack-basic"\nversion = "1.0.0"\nsource = { editable = "." }\n\n[package.metadata]\nrequires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]\n',
        '[project]\nname = "research-stack-basic"\nversion = "1.0.0"\ndependencies = ["pypdf==6.4.1"]\n\n[dependency-groups]\ndev = ["pytest==8.4.2"]\n' + BUILD_SYSTEM,
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("dependency groups differ" in problem for problem in problems), problems


def test_requires_python_drift_is_detected(tmp_path: Path) -> None:
    _fixture(
        tmp_path,
        'version = 1\nrequires-python = ">=3.12, <3.15"\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { virtual = "." }\n',
        '[project]\nname = "p"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.14"\n',
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("requires-python" in problem for problem in problems), problems


def test_a_lock_without_a_root_entry_is_a_problem(tmp_path: Path) -> None:
    _fixture(tmp_path, 'version = 1\n[[package]]\nname = "pypdf"\nversion = "6.4.1"\nsource = { registry = "https://pypi.org/simple" }\n',
             '[project]\nname = "p"\nversion = "1.0.0"\n')
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert problems and "no editable/virtual root package entry" in problems[0]


# --- extras and environment markers, compared the way uv records them ---------------------------

def test_split_requirement_normalises_extras_and_markers() -> None:
    """The comparison key uv uses: canonical name with its extras, specifier without the marker."""
    assert lockintegrity.split_requirement("mcp[cli]==2.2.0") == ("mcp[cli]", "==2.2.0")
    assert lockintegrity.split_requirement("pywin32==306; sys_platform == 'win32'") == ("pywin32", "==306")
    assert lockintegrity.split_requirement("MCP-Types[CLI] >= 2.2.0") == ("mcp-types[cli]", ">=2.2.0")
    assert lockintegrity.split_requirement("ipykernel") == ("ipykernel", "")


def test_extras_declare_matches_the_extras_uv_records(tmp_path: Path) -> None:
    """`mcp[cli]==2.2.0` against the entry `uv lock` writes for it: extras in their own key.

    Measured shape (uv 0.13.6 and uv 0.5.0 on a probe project):
    `requires-dist = [{ name = "mcp", extras = ["cli"], specifier = "==2.2.0" }]`.
    """
    _fixture(
        tmp_path,
        _root_lock('\n[package.metadata]\nrequires-dist = [\n    { name = "mcp", extras = ["cli"], specifier = "==2.2.0" },\n]\n'),
        _packaged_manifest('"mcp[cli]==2.2.0", '),
    )
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


def test_marker_bearing_requirement_matches_the_marker_uv_records(tmp_path: Path) -> None:
    """`"pywin32==306; sys_platform == 'win32'"` against uv's `marker` + `specifier` pair."""
    _fixture(
        tmp_path,
        _root_lock(
            '\n[package.metadata]\nrequires-dist = [{ name = "pywin32", marker = "sys_platform == \'win32\'", specifier = "==306" }]\n'
        ),
        _packaged_manifest('"pywin32==306; sys_platform == \'win32\'", '),
    )
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


def test_extras_and_markers_do_not_hide_a_specifier_change(tmp_path: Path) -> None:
    """The pair is stale under an extra and under a marker, exactly as it is on a plain requirement."""
    _fixture(
        tmp_path,
        _root_lock(
            '\n[package.metadata]\nrequires-dist = [\n'
            '    { name = "mcp", extras = ["cli"], specifier = "==2.1.0" },\n'
            '    { name = "pywin32", marker = "sys_platform == \'win32\'", specifier = "==307" },\n]\n'
        ),
        _packaged_manifest('"mcp[cli]==2.2.0",\n  "pywin32==306; sys_platform == \'win32\'",\n'),
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("declared dependencies differ" in problem for problem in problems), problems
    text = "\n".join(problems)
    assert text.count("'mcp[cli]'") == 2, problems
    assert "==2.2.0" in text and "==2.1.0" in text, problems
    assert "'pywin32'" in text and "==306" in text and "==307" in text, problems


def test_extras_are_part_of_the_requirement_identity(tmp_path: Path) -> None:
    """`mcp[cli]` is not `mcp`: uv records the extras, so a lock without them is a different pair."""
    _fixture(
        tmp_path,
        _root_lock('\n[package.metadata]\nrequires-dist = [{ name = "mcp", specifier = "==2.2.0" }]\n'),
        _packaged_manifest('"mcp[cli]==2.2.0", '),
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("declared dependencies differ" in problem for problem in problems), problems


# --- optional dependencies, which uv folds into requires-dist ------------------------------------

# The exact `[package.metadata]` uv 0.13.6 writes for the manifest below (measured with `uv lock`
# on a probe project; `uv lock --check` on the pair uv wrote exits 0).
OPTIONAL_LOCK = (
    'version = 1\nrevision = 5\nrequires-python = ">=3.12"\n[[package]]\nname = "p"\nversion = "1.0.0"\n'
    'source = { editable = "." }\n\n[package.metadata]\nrequires-dist = [\n'
    '    { name = "mcp", extras = ["cli"], specifier = "==2.2.0" },\n'
    '    { name = "pypdf", marker = "extra == \'pdf\'", specifier = "==6.4.1" },\n'
    '    { name = "pywin32", marker = "sys_platform == \'win32\' and extra == \'win\'", specifier = "==311" },\n'
    ']\nprovides-extras = ["pdf", "win"]\n'
)
OPTIONAL_MANIFEST = (
    '[project]\nname = "p"\nversion = "1.0.0"\nrequires-python = ">=3.12"\n'
    'dependencies = ["mcp[cli]==2.2.0"]\n\n[project.optional-dependencies]\n'
    'pdf = ["pypdf==6.4.1"]\nwin = ["pywin32==311; sys_platform == \'win32\'"]\n' + BUILD_SYSTEM
)


def test_optional_dependencies_match_the_requires_dist_uv_records(tmp_path: Path) -> None:
    """uv puts optional dependencies in `requires-dist` with `extra == 'pdf'` markers; comparing only
    `[project.dependencies]` reported drift for a pair `uv lock --check` accepts."""
    _fixture(tmp_path, OPTIONAL_LOCK, OPTIONAL_MANIFEST)
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


def test_optional_dependency_missing_from_the_lock_is_reported(tmp_path: Path) -> None:
    _fixture(
        tmp_path,
        OPTIONAL_LOCK.replace(
            '    { name = "pypdf", marker = "extra == \'pdf\'", specifier = "==6.4.1" },\n', ""
        ).replace('provides-extras = ["pdf", "win"]', 'provides-extras = ["win"]'),
        OPTIONAL_MANIFEST,
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("declared dependencies differ" in problem and "'pypdf'" in problem for problem in problems), problems
    assert any("provides-extras ['win']" in problem and "optional-dependencies ['pdf', 'win']" in problem for problem in problems), problems


def test_provides_extras_the_manifest_does_not_declare_is_reported(tmp_path: Path) -> None:
    _fixture(
        tmp_path,
        'version = 1\nrevision = 5\nrequires-python = ">=3.12"\n[[package]]\nname = "p"\nversion = "1.0.0"\n'
        'source = { editable = "." }\n\n[package.metadata]\n'
        'requires-dist = [{ name = "mcp", extras = ["cli"], specifier = "==2.2.0" }]\n'
        'provides-extras = ["pdf"]\n',
        '[project]\nname = "p"\nversion = "1.0.0"\nrequires-python = ">=3.12"\n'
        'dependencies = ["mcp[cli]==2.2.0"]\n' + BUILD_SYSTEM,
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("provides-extras ['pdf']" in problem and "optional-dependencies []" in problem for problem in problems), problems


def test_a_lock_without_provides_extras_is_not_drift(tmp_path: Path) -> None:
    """uv 0.5.0 writes `requires-dist` for optional dependencies but no `provides-extras` at all."""
    _fixture(
        tmp_path,
        OPTIONAL_LOCK.replace('provides-extras = ["pdf", "win"]\n', "").replace("revision = 5\n", ""),
        OPTIONAL_MANIFEST,
    )
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


def test_shipped_pairs_stay_clean_and_declare_no_extras() -> None:
    """None of the three shipped pairs uses optional-dependencies, so this check must not move them."""
    for pyproject_relative, lock_relative in lockintegrity.shipped_pairs(ROOT):
        manifest = tomllib.loads((ROOT / pyproject_relative).read_text(encoding="utf-8"))
        assert "optional-dependencies" not in manifest.get("project", {}), pyproject_relative
        assert lockintegrity.check_pair(ROOT / pyproject_relative, ROOT / lock_relative) == [], (
            f"{pyproject_relative} / {lock_relative} is no longer lock-current"
        )


def test_single_quoted_manifest_scalars_are_read(tmp_path: Path) -> None:
    """TOML literal strings are as valid as basic strings: `name = 'p'` must not read as missing."""
    _fixture(
        tmp_path,
        'version = 1\nrequires-python = ">=3.12"\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { virtual = "." }\n',
        "[project]\nname = 'p'\nversion = '1.0.0'\nrequires-python = '>=3.12'\ndependencies = []\n",
    )
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


# --- dependency groups that are not requirement strings ------------------------------------------

def test_group_include_reference_is_compared_by_name_and_does_not_crash(tmp_path: Path) -> None:
    """`{ include = "dev" }` is a group reference: uv 0.5.0 locks it as `other = []`, so it carries
    no specifier on either side, and the guard compares the group names instead."""
    _fixture(
        tmp_path,
        _root_lock(
            '\n[package.metadata]\nrequires-dist = []\n\n'
            '[package.metadata.requires-dev]\n'
            'dev = [{ name = "pytest", specifier = "==8.4.2" }]\n'
            'other = []\n'
        ),
        _packaged_manifest(groups='\n[dependency-groups]\ndev = ["pytest==8.4.2"]\nother = [{ include = "dev" }]\n'),
    )
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


def test_group_entry_the_reader_cannot_read_is_a_problem_not_a_traceback(tmp_path: Path) -> None:
    """`{ id = "...", marker = "..." }` reaches the reader; it names it instead of raising."""
    _fixture(
        tmp_path,
        _root_lock('\n[package.metadata]\nrequires-dist = []\n\n[package.metadata.requires-dev]\nother = []\n'),
        _packaged_manifest(groups="\n[dependency-groups]\nother = [{ id = \"dev\", marker = \"sys_platform == 'win32'\" }]\n"),
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert problems, "an unreadable group entry must be reported, not swallowed"
    assert all(isinstance(problem, str) for problem in problems)
    assert any("neither a requirement string nor an `{ include = ... }` group reference" in problem for problem in problems), problems
    assert any("'other'" in problem for problem in problems), problems


def test_group_include_of_an_undeclared_group_is_reported(tmp_path: Path) -> None:
    _fixture(
        tmp_path,
        _root_lock('\n[package.metadata]\nrequires-dist = []\n\n[package.metadata.requires-dev]\nother = []\n'),
        _packaged_manifest(groups='\n[dependency-groups]\nother = [{ include = "missing-group" }]\n'),
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("includes 'missing-group'" in problem for problem in problems), problems


def test_entries_that_are_not_requirements_are_problems_not_tracebacks(tmp_path: Path) -> None:
    """A group that is not a list, and a lock entry that is not a requirement, are both named."""
    _fixture(
        tmp_path,
        _root_lock('\n[package.metadata]\nrequires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]\n'),
        _packaged_manifest('"pypdf==6.4.1", ') + '\n[dependency-groups]\ndev = "pytest==8.4.2"\n',
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("dependency group 'dev' is not a list of requirements" in problem for problem in problems), problems

    _fixture(
        tmp_path,
        _root_lock('\n[package.metadata]\nrequires-dist = ["== not a requirement =="]\n'),
        _packaged_manifest('"pypdf==6.4.1", '),
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("lock requires-dist entry" in problem for problem in problems), problems
    assert any("declared dependencies differ" in problem for problem in problems), problems


# --- malformed input is a problem string, never an exception -------------------------------------

def test_malformed_pyproject_is_a_problem_not_a_traceback(tmp_path: Path) -> None:
    """`scripts/verify_vsix.py` catches ValueError, not TOMLDecodeError: the reader must not escape it."""
    _fixture(tmp_path, _root_lock(), '[project\nname = "p"\nversion = "1.0.0"\n')
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert len(problems) == 1, problems
    assert "pyproject.toml is not valid TOML" in problems[0], problems
    assert problems[0].startswith("uv.lock:"), problems


def test_malformed_pyproject_survives_the_packaged_reader(tmp_path: Path) -> None:
    """The same guarantee through `check_pair_text`, the entry point the VSIX audit uses."""
    problems = lockintegrity.check_pair_text(
        "[project\nname = \"p\"\n", 'version = 1\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { virtual = "." }\n',
        "packaged uv.lock",
    )
    assert problems and "not valid TOML" in problems[0], problems


# --- the root entry's source: mode and path, not just presence ------------------------------------

def test_root_source_path_drift_is_reported(tmp_path: Path) -> None:
    """`editable = "."` moved to `editable = "packages/p"` is a different project, not the same one."""
    _fixture(
        tmp_path,
        'version = 1\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { editable = "packages/p" }\n',
        _packaged_manifest(),
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("'packages/p'" in problem and "does not point at" in problem for problem in problems), problems


def test_root_source_mode_drift_is_reported(tmp_path: Path) -> None:
    """A packaged project locked as `virtual` (and a virtual one locked as `editable`) is drift."""
    _fixture(tmp_path, 'version = 1\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { virtual = "." }\n', _packaged_manifest())
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("source is virtual = '.'" in problem and "build-system" in problem for problem in problems), problems

    _fixture(tmp_path, 'version = 1\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { editable = "." }\n',
             '[project]\nname = "p"\nversion = "1.0.0"\ndependencies = []\n')
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("source is editable = '.'" in problem and "no [build-system]" in problem for problem in problems), problems


def test_tool_uv_package_false_locks_as_virtual(tmp_path: Path) -> None:
    """`[tool.uv] package = false` is the manifest saying "do not install me": uv writes `virtual`."""
    _fixture(
        tmp_path,
        'version = 1\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { virtual = "." }\n',
        _packaged_manifest() + '\n[tool.uv]\npackage = false\n',
    )
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


# --- a lock that omits a field the manifest declares ----------------------------------------------

def test_lock_without_requires_python_is_reported(tmp_path: Path) -> None:
    _fixture(
        tmp_path,
        'version = 1\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { virtual = "." }\n',
        '[project]\nname = "p"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.15"\ndependencies = []\n',
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("requires-python" in problem and "the lockfile records none" in problem for problem in problems), problems


def test_two_local_entries_are_reported_naming_both(tmp_path: Path) -> None:
    """A workspace lock is not a guess: the guard names both local entries instead of picking one."""
    _fixture(
        tmp_path,
        'version = 1\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { editable = "." }\n\n'
        '[[package]]\nname = "member"\nversion = "0.1.0"\nsource = { virtual = "packages/member" }\n',
        _packaged_manifest(),
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert len(problems) == 1, problems
    assert "2 local (editable/virtual) package entries" in problems[0], problems
    assert "'p' (editable = '.')" in problems[0] and "'member' (virtual = 'packages/member')" in problems[0], problems


def test_a_non_integer_revision_is_reported(tmp_path: Path) -> None:
    """`revision` is a uv schema field: a string or a boolean is not a readable lockfile."""
    _fixture(
        tmp_path,
        'version = 1\nrevision = "five"\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { virtual = "." }\n',
        '[project]\nname = "p"\nversion = "1.0.0"\ndependencies = []\n',
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert any("lockfile revision 'five' is not an integer" in problem for problem in problems), problems


# --- the build refuses to bundle a drifted pair --------------------------------------------------
def test_the_bundle_build_refuses_a_stale_source_pair(tmp_path: Path) -> None:
    _fixture(tmp_path, 'version = 1\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { editable = "." }\n',
             '[project]\nname = "p"\nversion = "2.0.0"\n' + BUILD_SYSTEM)
    with pytest.raises(ValueError) as caught:
        build_worker_bundle.assert_locks_current([("pyproject.toml", "uv.lock")], tmp_path)
    assert "lockfile drift" in str(caught.value)
    assert "uv sync --locked would refuse this pair" in str(caught.value)


def test_the_bundle_build_accepts_a_current_pair(tmp_path: Path) -> None:
    _fixture(tmp_path, 'version = 1\n[[package]]\nname = "p"\nversion = "2.0.0"\nsource = { editable = "." }\n',
             '[project]\nname = "p"\nversion = "2.0.0"\n' + BUILD_SYSTEM)
    build_worker_bundle.assert_locks_current([("pyproject.toml", "uv.lock")], tmp_path)


def test_the_cli_reports_drift_with_a_nonzero_exit(tmp_path: Path) -> None:
    _fixture(tmp_path, 'version = 1\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { editable = "." }\n',
             '[project]\nname = "p"\nversion = "2.0.0"\n' + BUILD_SYSTEM)
    assert lockintegrity.main(["lockintegrity.py", str(tmp_path)]) == 1
    assert lockintegrity.main(["lockintegrity.py", str(ROOT)]) == 0


# --- uv's own verdict, when this host has a uv ---------------------------------------------------

@pytest.mark.skipif(uv_binary() is None, reason="no uv on this development host — the uv gate is skipped, not passed")
def test_uv_itself_calls_every_shipped_pair_up_to_date() -> None:
    for pair_root in (ROOT, ROOT / "extension/worker", ROOT / "templates/recommended-overlay/notebooks/analysis"):
        run = subprocess.run(
            [uv_binary(), "lock", "--check", "--project", str(pair_root), "--no-config"],
            capture_output=True, text=True, cwd=pair_root, timeout=300,
        )
        assert run.returncode == 0, f"uv lock --check refused {pair_root}: {run.stderr.strip()}"
