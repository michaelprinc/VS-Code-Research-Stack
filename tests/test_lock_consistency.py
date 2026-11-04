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
rather than `virtual` (measured with uv 0.13.6 and uv 0.5.0 on a probe project). Where a fixture's
`requires-dist` names a requirement, the lock carries a `[[package]]` block for it too: measured with
uv 0.13.6, a lock whose metadata names `mcp` but has no `mcp` package block is refused (`lock --check`
exit 2, "Dependency `pypdf` has missing `source` field but has more than one matching package"), so a
fixture that left the block out was describing a pair no uv accepts. A block with no `sdist` and no
`wheels` keys is faithful — uv 0.13.6 accepts that (`lock --check` exit 0) — and every fixture below
that claims uv accepts the pair was run against real uv 0.13.6 in a temp directory.
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


def _root_lock(extra: str = "", requires_python: str = ">=3.12") -> str:
    """A lock carrying only the root entry, plus whatever the test adds.

    `requires-python` is not optional in a uv 0.13.6 lock: a lock without the key fails to parse
    ("missing field `requires-python`", `lock --check` exit 2). uv writes one even for a manifest that
    declares none — `>=3.12`, measured on uv 0.5.0, 0.7.22, 0.9.30 and 0.13.6 — which is the default
    here, because `_packaged_manifest` declares no `requires-python`. Pass `requires_python=""` to test
    its absence.
    """
    header = 'version = 1\n'
    if requires_python:
        header += 'requires-python = "' + requires_python + '"\n'
    return header + '[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { editable = "." }\n' + extra


def _package_block(name: str, version: str, artifacts: str = "") -> str:
    """A `[[package]]` block in the shape uv writes, minus the artifact lists unless given.

    uv 0.13.6 accepts a package entry with no `sdist` and no `wheels` keys (`lock --check` exit 0,
    measured), so a block like this keeps a fixture faithful to a pair uv accepts without dragging
    hundreds of lines of hashes into the test file.
    """
    return (
        '\n[[package]]\nname = "' + name + '"\nversion = "' + version + '"\n'
        'source = { registry = "https://pypi.org/simple" }\n' + artifacts
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
    _fixture(tmp_path, 'version = 1\nrevision = 3\nrequires-python = ">=3.12"\n[[package]]\nname = "research-stack-basic"\nversion = "0.3.6.1"\nsource = { editable = "." }\n',
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
        _root_lock('\n[package.metadata]\nrequires-dist = [\n    { name = "mcp", extras = ["cli"], specifier = "==2.2.0" },\n]\n')
        + _package_block("mcp", "2.2.0"),
        _packaged_manifest('"mcp[cli]==2.2.0", '),
    )
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


def test_marker_bearing_requirement_matches_the_marker_uv_records(tmp_path: Path) -> None:
    """`"pywin32==306; sys_platform == 'win32'"` against uv's `marker` + `specifier` pair."""
    _fixture(
        tmp_path,
        _root_lock(
            '\n[package.metadata]\nrequires-dist = [{ name = "pywin32", marker = "sys_platform == \'win32\'", specifier = "==306" }]\n'
        )
        + _package_block("pywin32", "306"),
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
    + _package_block("mcp", "2.2.0")
    + _package_block("pypdf", "6.4.1")
    + _package_block("pywin32", "311")
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

def test_group_include_spelling_is_a_construct_the_reader_cannot_certify(tmp_path: Path) -> None:
    """`{ include = "dev" }` is a group reference uv 0.13.6 refuses, so the guard certifies neither side.

    Measured on this host in a temp copy of the shipped worker pair (`HOME=/data/dsh/home`,
    `UV_CACHE_DIR=/tmp/uvcache`): uv 0.5.0 accepted the spelling and locked the group as `other = []`
    (`sync --locked --python 3.12` exit 0), and uv 0.13.6 refuses the manifest against **either** lock —
    beside the shipped lock and beside that `other = []` lock both give `lock --check` exit 2, "Project
    `research-stack-basic` has malformed dependency groups / Group `test` contains an unknown dependency
    object specifier: {\"include\": \"dev\"}". A guard that returned no problem for this pair certified a
    manifest the pinned build uv rejects.

    This replaces the 0.3.7 fixture that asserted `check_pair(...) == []` for exactly this pair. That
    assertion was the Python half of a divergence: `extension/lockfile.js` flagged the same pair, so the
    two gates answered the same pair differently. Both now report the same thing, in the same words, and
    neither calls it a group mismatch it cannot prove.
    """
    _fixture(
        tmp_path,
        _root_lock(
            '\n[package.metadata]\nrequires-dist = []\n\n'
            '[package.metadata.requires-dev]\n'
            'dev = [{ name = "pytest", specifier = "==8.4.2" }]\n'
            'other = []\n'
        )
        + _package_block("pytest", "8.4.2"),
        _packaged_manifest(groups='\n[dependency-groups]\ndev = ["pytest==8.4.2"]\nother = [{ include = "dev" }]\n'),
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert len(problems) == 1, problems
    assert "dependency group 'other' declares { include = 'dev' }" in problems[0], problems[0]
    assert "cannot certify that group-reference spelling" in problems[0], problems[0]
    assert "dependency groups differ" not in "\n".join(problems), problems[0]


def test_include_group_against_an_empty_group_is_drift(tmp_path: Path) -> None:
    """`{ include-group = "dev" }` is the spelling uv flattens, so a lock that records it empty is stale.

    Measured with uv 0.13.6 on the manifest declaring `dev = ["pytest==8.4.2"]` and
    `test = [{ include-group = "dev" }]`: beside the lock uv wrote for it (`test = [{ name = "pytest",
    specifier = "==8.4.2" }]`) `lock --check` exits 0 and `uv-0.5.0 sync --locked --python 3.12` exits 0;
    beside a lock recording `test = []` it exits 1 with uv's staleness sentence. The pair the previous
    test reports as uncertifiable is a *different* spelling, and this is the one that is ordinary drift.
    """
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(
            'dev = [{ name = "pytest", specifier = "==8.4.2" }]\n',
            'dev = [{ name = "pytest", specifier = "==8.4.2" }]\ntest = []\n',
        ),
        PROBE_MANIFEST.replace(
            'dev = ["pytest==8.4.2"]',
            'dev = ["pytest==8.4.2"]\ntest = [{ include-group = "dev" }]',
        ),
    )
    assert any("dependency groups differ" in problem for problem in problems), problems
    assert "test" in "\n".join(problems), problems


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
        'version = 1\nrequires-python = ">=3.12"\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { virtual = "." }\n',
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


def test_uvs_own_default_requires_python_is_not_drift(tmp_path: Path) -> None:
    """A manifest that declares no `requires-python` beside the `>=3.12` uv writes for it is current.

    Measured with uv 0.13.6 in a temp copy of the shipped worker pair: `lock --check` exits 0 with the
    warning "No `requires-python` value found in the workspace. Defaulting to `>=3.12`", and
    `uv-0.5.0 sync --locked --python 3.12` on the same pair exits 0. The lock carries uv's own sentence,
    not a constraint the manifest dropped — reporting it as drift refuses a pair uv itself wrote, and it
    is the pair `extension/lockfile.js` used to refuse while this guard accepted it. The version of the
    pair that keeps an upper bound is still drift (F4, above).
    """
    _fixture(tmp_path, _root_lock(), _packaged_manifest())
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


def test_a_stray_local_entry_is_not_drift(tmp_path: Path) -> None:
    """A second local entry pointing at another directory is a workspace member, not a rival root.

    This replaces the 0.3.7 fixture that asserted the opposite for exactly this pair. That fixture was
    unfaithful to what real uv writes: measured with uv 0.13.6 in a temp directory, a lock carrying
    `source = { virtual = "packages/member" }` beside the root entry — and the same pair carrying
    `source = { editable = "packages/other-member" }`, before and after the root entry — passes
    `uv lock --check` with exit 0. Reporting that as drift blocks a package build over a pair uv calls
    current. Ambiguity is only real when two entries claim `.`.
    """
    _fixture(
        tmp_path,
        'version = 1\nrequires-python = ">=3.12"\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { editable = "." }\n\n'
        '[[package]]\nname = "member"\nversion = "0.1.0"\nsource = { virtual = "packages/member" }\n',
        _packaged_manifest(),
    )
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []
    assert lockintegrity.root_lock_entry(tmp_path / "uv.lock")["name"] == "p"


def test_two_entries_claiming_the_root_path_are_ambiguous(tmp_path: Path) -> None:
    """Two `[[package]]` blocks both claiming `source = { editable = "." }` is not a guess."""
    _fixture(
        tmp_path,
        'version = 1\nrequires-python = ">=3.12"\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { editable = "." }\n\n'
        '[[package]]\nname = "other"\nversion = "0.1.0"\nsource = { editable = "." }\n',
        _packaged_manifest(),
    )
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert len(problems) == 1, problems
    assert "all claiming the source path '.'" in problems[0], problems[0]
    assert "'p' (editable = '.')" in problems[0] and "'other' (editable = '.')" in problems[0], problems


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
    _fixture(tmp_path, 'version = 1\nrequires-python = ">=3.12, <3.15"\n[[package]]\nname = "p"\nversion = "2.0.0"\nsource = { editable = "." }\n',
             '[project]\nname = "p"\nversion = "2.0.0"\nrequires-python = ">=3.12,<3.15"\n' + BUILD_SYSTEM)
    build_worker_bundle.assert_locks_current([("pyproject.toml", "uv.lock")], tmp_path)


def test_the_cli_reports_drift_with_a_nonzero_exit(tmp_path: Path) -> None:
    _fixture(tmp_path, 'version = 1\nrequires-python = ">=3.12, <3.15"\n[[package]]\nname = "p"\nversion = "1.0.0"\nsource = { editable = "." }\n',
             '[project]\nname = "p"\nversion = "2.0.0"\nrequires-python = ">=3.12,<3.15"\n' + BUILD_SYSTEM)
    assert lockintegrity.main(["lockintegrity.py", str(tmp_path)]) == 1
    assert lockintegrity.main(["lockintegrity.py", str(ROOT)]) == 0


# --- the defects an adversarial pass measured against real uv --------------------------------------
#
# PROBE_PAIR is the pair uv 0.13.6 writes for PROBE_MANIFEST (measured in a temp directory: `uv lock`,
# then `uv lock --check` on what it wrote — exit 0). Every fixture below is that pair with exactly one
# field changed, and every changed pair was put back in front of real uv 0.13.6: the exit code uv gave
# is recorded in the test's docstring and is what the assertion claims.

PROBE_MANIFEST = (
    '[project]\nname = "probe"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.15"\n'
    'dependencies = ["pypdf==6.4.1"]\n\n[dependency-groups]\ndev = ["pytest==8.4.2"]\n' + BUILD_SYSTEM
)
# The sdist and wheel uv 0.13.6 recorded for pypdf 6.4.1, copied out of the shipped worker lock.
PYPDF_SDIST = (
    'sdist = { url = "https://files.pythonhosted.org/packages/0c/e0/57f914ae9fedbc91fe3ebe74b78c88903943ec9c232b6da15947bb3bf8ab/pypdf-6.4.1.tar.gz", hash = "sha256:36eb0b52730fc3077d2b8d4122751e696d46af9ef9e5383db492df1ab0cc4647", size = 5275322, upload-time = "2025-12-07T14:19:27.922Z" }\n'
)
PYPDF_WHEEL = (
    'wheels = [\n'
    '    { url = "https://files.pythonhosted.org/packages/db/ef/68c0f473d8b8764b23f199450dfa035e6f2206e67e9bde5dd695bab9bdf0/pypdf-6.4.1-py3-none-any.whl", hash = "sha256:1782ee0766f0b77defc305f1eb2bafe738a2ef6313f3f3d2ee85b4542ba7e535", size = 328325, upload-time = "2025-12-07T14:19:26.286Z" },\n'
    ']\n'
)
PYPDF_ARTIFACTS = PYPDF_SDIST + PYPDF_WHEEL
PROBE_LOCK = (
    'version = 1\nrevision = 5\nrequires-python = ">=3.12, <3.15"\n\n'
    '[[package]]\nname = "probe"\nversion = "1.0.0"\nsource = { editable = "." }\n'
    'dependencies = [\n    { name = "pypdf" },\n]\n\n'
    '[package.dev-dependencies]\ndev = [\n    { name = "pytest" },\n]\n\n'
    '[package.metadata]\nrequires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]\n\n'
    '[package.metadata.requires-dev]\ndev = [{ name = "pytest", specifier = "==8.4.2" }]\n'
    + _package_block("pypdf", "6.4.1", PYPDF_ARTIFACTS)
    + _package_block("pytest", "8.4.2")
)
# uv 0.13.6 wrote these sdists and wheels for pytest 8.4.2 and for iniconfig 2.3.1, one of its
# dependencies. iniconfig is the transitive package: the manifest never names it.
PYTEST_ARTIFACTS = (
    'sdist = { url = "https://files.pythonhosted.org/packages/a3/5c/00a0e072241553e1a7496d638deababa67c5058571567b92a7eaa258397c/pytest-8.4.2.tar.gz", hash = "sha256:86c0d0b93306b961d58d62a4db4879f27fe25513d4b969df351abdddb3c30e01", size = 1519618, upload-time = "2025-09-04T14:34:22.711Z" }\n'
    'wheels = [\n'
    '    { url = "https://files.pythonhosted.org/packages/a8/a4/20da314d277121d6534b3a980b29035dcd51e6744bd79075a6ce8fa4eb8d/pytest-8.4.2-py3-none-any.whl", hash = "sha256:872f880de3fc3a5bdc88a11b39c9710c3497a547cfa9320bc3c5e62fbf272e79", size = 365750, upload-time = "2025-09-04T14:34:20.226Z" },\n'
    ']\n'
)
INICONFIG_ARTIFACTS = (
    'sdist = { url = "https://files.pythonhosted.org/packages/01/e1/2069291243c926a2ff1cd706c7f3eeb9b62144bf60f77c9fb9ff2fb26bd3/iniconfig-2.3.1.tar.gz", hash = "sha256:67f4b9c50da0dedf52af349e7749a80a9057a5031199791b906c3bb3ae878960", size = 21209, upload-time = "2026-10-06T22:48:38.076Z" }\n'
    'wheels = [\n'
    '    { url = "https://files.pythonhosted.org/packages/56/43/4ca9e49d27a1fcf6bece6f6aec0ea46bb9112489b93d4b688fb415457bdb/iniconfig-2.3.1-py3-none-any.whl", hash = "sha256:9121e2c1fdb355232495be3194c8dfe87ccc2d5dee45947b78e68f499790d7a7", size = 7552, upload-time = "2026-10-06T22:48:36.959Z" },\n'
    ']\n'
)
TRANSITIVE_LOCK = PROBE_LOCK.replace(
    _package_block("pytest", "8.4.2"),
    '[[package]]\nname = "pytest"\nversion = "8.4.2"\nsource = { registry = "https://pypi.org/simple" }\n'
    'dependencies = [\n    { name = "iniconfig" },\n]\n'
    + PYTEST_ARTIFACTS
    + _package_block("iniconfig", "2.3.1", INICONFIG_ARTIFACTS),
)


def test_the_pair_uv_wrote_is_clean(tmp_path: Path) -> None:
    """The control every other test in this section is a diff against. `uv lock --check`: exit 0."""
    _fixture(tmp_path, PROBE_LOCK, PROBE_MANIFEST)
    assert lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock") == []


def _probe_pair(tmp_path: Path, lock_text: str, pyproject_text: str) -> list[str]:
    _fixture(tmp_path, lock_text, pyproject_text)
    return lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")


# F1: a PEP 508 marker is part of the requirement uv compares. Measured with uv 0.13.6: changed, added
# and removed markers each make `uv lock --check` exit 1.

def test_marker_changed_on_a_requirement_is_detected(tmp_path: Path) -> None:
    """`python_version >= '3.14'` in the manifest beside `python_full_version >= '3.13'` in the lock. `uv lock --check`: exit 1."""
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(
            'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
            'requires-dist = [{ name = "pypdf", marker = "python_full_version >= \'3.13\'", specifier = "==6.4.1" }]',
        ),
        PROBE_MANIFEST.replace('"pypdf==6.4.1"', '"pypdf==6.4.1; python_version >= \'3.14\'"'),
    )
    assert len(problems) == 1, problems
    assert "marker" in problems[0] and "python_version >= '3.14'" in problems[0], problems[0]
    assert "python_full_version >= '3.13'" in problems[0], problems[0]


def test_marker_added_to_a_requirement_is_detected(tmp_path: Path) -> None:
    """A marker the manifest gained and the lock never recorded. `uv lock --check`: exit 1."""
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK,
        PROBE_MANIFEST.replace('"pypdf==6.4.1"', '"pypdf==6.4.1; python_version >= \'3.13\'"'),
    )
    assert len(problems) == 1, problems
    assert "marker" in problems[0] and "python_version >= '3.13'" in problems[0], problems[0]


def test_marker_removed_from_a_requirement_is_detected(tmp_path: Path) -> None:
    """A marker the manifest dropped and the lock still carries. `uv lock --check`: exit 1."""
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(
            'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
            'requires-dist = [{ name = "pypdf", marker = "python_full_version >= \'3.13\'", specifier = "==6.4.1" }]',
        ),
        PROBE_MANIFEST,
    )
    assert len(problems) == 1, problems
    assert "marker" in problems[0] and "python_full_version >= '3.13'" in problems[0], problems[0]


def test_uvs_marker_rewrite_is_not_drift(tmp_path: Path) -> None:
    """uv rewrites `python_version` into `python_full_version` and sorts a conjunction; both are accepted.

    Every row here is the manifest spelling beside the lock spelling uv 0.13.6 actually wrote for it,
    measured with `uv lock` followed by `uv lock --check` — exit 0 for all seven. Comparing the marker
    text instead of uv's rewrite would call all seven stale.
    """
    rewrites = [
        ("python_version >= '3.13'", "python_full_version >= '3.13'"),
        ("python_version < '3.14'", "python_full_version < '3.14'"),
        ("python_version == '3.13'", "python_full_version == '3.13.*'"),
        ("python_version != '3.13'", "python_full_version != '3.13.*'"),
        ("python_version > '3.13'", "python_full_version >= '3.14'"),
        ("python_version <= '3.13'", "python_full_version < '3.14'"),
        ("sys_platform == 'win32' and python_version >= '3.13'",
         "python_full_version >= '3.13' and sys_platform == 'win32'"),
    ]
    for manifest_marker, lock_marker in rewrites:
        problems = _probe_pair(
            tmp_path,
            PROBE_LOCK.replace(
                'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
                'requires-dist = [{ name = "pypdf", marker = "' + lock_marker + '", specifier = "==6.4.1" }]',
            ),
            PROBE_MANIFEST.replace('"pypdf==6.4.1"', '"pypdf==6.4.1; ' + manifest_marker + '"'),
        )
        assert problems == [], f"{manifest_marker!r} vs {lock_marker!r}: {problems}"


def test_a_marker_this_reader_does_not_model_is_left_alone(tmp_path: Path) -> None:
    """Guessing at a rewrite uv does not report would call a uv-current pair stale, so the reader stays quiet.

    uv 0.13.6 rewrites `python_version ~= '3.13'` as
    `python_full_version >= '3.13' and python_full_version < '4'` and accepts the pair
    (`uv lock --check`: exit 0). The reader models the six comparison operators, not `~=`, and reports
    nothing rather than reporting a drift it cannot prove.
    """
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(
            'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
            'requires-dist = [{ name = "pypdf", marker = "python_full_version >= \'3.13\' and python_full_version < \'4\'", specifier = "==6.4.1" }]',
        ),
        PROBE_MANIFEST.replace('"pypdf==6.4.1"', '"pypdf==6.4.1; python_version ~= \'3.13\'"'),
    )
    assert problems == [], problems


# F3: an extra the lock does not record. Measured with uv 0.13.6 against a lock it wrote: both rows
# make `uv lock --check` exit 1.

def test_extra_reusing_an_existing_pin_is_detected(tmp_path: Path) -> None:
    """`pdf = ["pypdf==6.4.1"]` where pypdf is already a pinned dependency: no new requirement text. `uv lock --check`: exit 1."""
    problems = _probe_pair(tmp_path, PROBE_LOCK, PROBE_MANIFEST + '\n[project.optional-dependencies]\npdf = ["pypdf==6.4.1"]\n')
    assert any("provides-extras" in problem for problem in problems), problems


def test_extra_declared_with_an_empty_list_is_detected(tmp_path: Path) -> None:
    """`pdf = []` changes no requirement and no specifier at all. `uv lock --check`: exit 1."""
    problems = _probe_pair(tmp_path, PROBE_LOCK, PROBE_MANIFEST + '\n[project.optional-dependencies]\npdf = []\n')
    assert len(problems) == 1, problems
    assert "provides-extras" in problems[0], problems[0]


def test_an_extra_folded_into_the_marker_is_accepted(tmp_path: Path) -> None:
    """The same manifest beside the lock uv wrote for it is current. `uv lock --check`: exit 0.

    uv records an optional dependency as a second `requires-dist` entry carrying `extra == 'pdf'`, and
    canonicalises the extra name in the marker the way it canonicalises it in `provides-extras`
    (`cli_tools` locks as `extra == 'cli-tools'`, measured).
    """
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(
            'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
            'requires-dist = [\n    { name = "pypdf", specifier = "==6.4.1" },\n'
            '    { name = "pypdf", marker = "extra == \'pdf\'", specifier = "==6.4.1" },\n]\n'
            'provides-extras = ["pdf"]',
        ),
        PROBE_MANIFEST + '\n[project.optional-dependencies]\npdf = ["pypdf==6.4.1"]\n',
    )
    assert problems == [], problems


# F4: `requires-python` the lock carries and the manifest no longer declares. `uv lock --check`: exit 1.

def test_requires_python_dropped_from_the_manifest_is_detected(tmp_path: Path) -> None:
    problems = _probe_pair(tmp_path, PROBE_LOCK, PROBE_MANIFEST.replace('requires-python = ">=3.12,<3.15"\n', ""))
    assert len(problems) == 1, problems
    assert "the lockfile records requires-python" in problems[0] and "pyproject declares none" in problems[0], problems[0]


# F6: a transitive pin hand-edited inside the lock. Measured with uv 0.13.6: `uv lock --check` exit 2,
# "The entry for package `pypdf` (6.4.0) has wheel `pypdf-6.4.1-py3-none-any.whl` with inconsistent
# version (6.4.1), which indicates a malformed wheel".

def test_a_hand_edited_package_version_is_detected(tmp_path: Path) -> None:
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(_package_block("pypdf", "6.4.1", PYPDF_ARTIFACTS), _package_block("pypdf", "6.4.0", PYPDF_ARTIFACTS)),
        PROBE_MANIFEST,
    )
    assert len(problems) == 1, problems
    assert "records version '6.4.0'" in problems[0], problems[0]
    # uv's own refusal names the wheel, and so does the reader: `uv lock --check` on this pair says
    # "has wheel `pypdf-6.4.1-py3-none-any.whl` with inconsistent version (6.4.1)".
    assert "pypdf-6.4.1-py3-none-any.whl" in problems[0] and "claims '6.4.1'" in problems[0], problems[0]

    wheel_only = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(_package_block("pypdf", "6.4.1", PYPDF_ARTIFACTS), _package_block("pypdf", "6.4.0", PYPDF_WHEEL)),
        PROBE_MANIFEST,
    )
    assert len(wheel_only) == 1, wheel_only
    assert "pypdf-6.4.1-py3-none-any.whl" in wheel_only[0], wheel_only[0]


def test_a_sdist_filename_that_disagrees_while_the_wheel_agrees_is_not_reported(tmp_path: Path) -> None:
    """Measured with uv 0.13.6: `uv lock --check` exits 0 on a lock whose sdist filename names another
    version, because uv validates the wheel filenames it downloads and not the sdist name. A reader that
    flagged this would refuse a lock real uv accepts and would block the toolkit's own build."""
    drifted_sdist = PYPDF_SDIST.replace("pypdf-6.4.1.tar.gz", "pypdf-6.4.2.tar.gz")
    assert drifted_sdist != PYPDF_SDIST
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(_package_block("pypdf", "6.4.1", PYPDF_ARTIFACTS), _package_block("pypdf", "6.4.1", drifted_sdist + PYPDF_WHEEL)),
        PROBE_MANIFEST,
    )
    assert problems == [], problems


def test_a_hand_edited_pin_on_a_transitive_package_is_detected(tmp_path: Path) -> None:
    """The case F6 was measured with: a package the manifest never names, reached through pytest.

    `uv lock --check` on TRANSITIVE_LOCK exits 0; bumping iniconfig's recorded version from 2.3.1 to
    2.3.0 makes it exit 2 with "The entry for package `iniconfig` (2.3.0) has wheel
    `iniconfig-2.3.1-py3-none-any.whl` with inconsistent version (2.3.1)", and
    `uv sync --locked --dry-run --python 3.12` exits 2 for the same reason.
    """
    assert _probe_pair(tmp_path, TRANSITIVE_LOCK, PROBE_MANIFEST) == []

    problems = _probe_pair(
        tmp_path,
        TRANSITIVE_LOCK.replace('name = "iniconfig"\nversion = "2.3.1"', 'name = "iniconfig"\nversion = "2.3.0"'),
        PROBE_MANIFEST,
    )
    assert len(problems) == 1, problems
    assert "iniconfig-2.3.1-py3-none-any.whl" in problems[0], problems[0]


def test_a_package_without_sdist_or_wheels_is_not_drift(tmp_path: Path) -> None:
    """uv 0.13.6 accepts a lock whose `sdist` and `wheels` keys were deleted. `uv lock --check`: exit 0."""
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(PYPDF_ARTIFACTS, ""),
        PROBE_MANIFEST,
    )
    assert problems == [], problems


# F7: a whole `[[package]]` block deleted. Measured with uv 0.13.6: `uv lock --check` exit 2,
# "Dependency `pypdf` has missing `source` field but has more than one matching package".

def test_a_deleted_package_block_is_detected(tmp_path: Path) -> None:
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(_package_block("pypdf", "6.4.1", PYPDF_ARTIFACTS), ""),
        PROBE_MANIFEST,
    )
    assert any("requirement pypdf has no [[package]] entry" in problem for problem in problems), problems


def test_a_duplicated_package_block_is_detected(tmp_path: Path) -> None:
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK + _package_block("pypdf", "6.4.1", PYPDF_ARTIFACTS),
        PROBE_MANIFEST,
    )
    assert any("resolves to 2 [[package]] entries" in problem for problem in problems), problems


# F9: `extra` (singular) is uv's key in a resolved `dependencies` list, not in `requires-dist`.
# Measured with uv 0.13.6: `uv lock --check` exit 1.

def test_singular_extra_key_in_requires_dist_is_detected(tmp_path: Path) -> None:
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(
            'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
            'requires-dist = [{ name = "pypdf", extra = "cli", specifier = "==6.4.1" }]',
        ),
        PROBE_MANIFEST.replace('"pypdf==6.4.1"', '"pypdf[cli]==6.4.1"'),
    )
    assert any("declared dependencies differ" in problem for problem in problems), problems
    assert any("'pypdf[cli]'" in problem for problem in problems), problems


# F11: `dynamic = ["dependencies"]` resolved by the build backend. Measured with uv 0.13.6 on a buildable
# project: `uv lock` writes the resolved requirements into `[package.metadata] requires-dist`, and the
# pair it wrote passes `uv lock --check` (exit 0) and `uv sync --locked --dry-run --python 3.12` (exit 0).

DYNAMIC_MANIFEST = (
    '[project]\nname = "probe"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.15"\n'
    'dynamic = ["dependencies"]\n\n[dependency-groups]\ndev = ["pytest==8.4.2"]\n'
    '\n[tool.setuptools.dynamic]\ndependencies = { file = ["requirements.txt"] }\n'
    '\n[build-system]\nrequires = ["setuptools==75.6.0"]\nbuild-backend = "setuptools.build_meta"\n'
)


def test_dynamic_dependencies_skip_the_requires_dist_comparison(tmp_path: Path) -> None:
    _fixture(tmp_path, PROBE_LOCK, DYNAMIC_MANIFEST)
    (tmp_path / "requirements.txt").write_text("pypdf==6.4.1\n", encoding="utf-8")
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert problems == [], problems
    assert "declared dependencies differ" not in "\n".join(problems)


def test_a_resolved_dependency_the_metadata_half_does_not_record_is_detected(tmp_path: Path) -> None:
    """With the manifest half unreadable, the lock is still compared against itself.

    Measured with uv 0.13.6 on this pair: emptying `[package.metadata] requires-dist` while the root
    entry's resolved `dependencies` list still names `pypdf` makes `uv lock --check` exit 1 — "The
    lockfile at `uv.lock` needs to be updated, but `--check` was provided".
    """
    _fixture(tmp_path, PROBE_LOCK.replace('requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]', "requires-dist = []"), DYNAMIC_MANIFEST)
    (tmp_path / "requirements.txt").write_text("pypdf==6.4.1\n", encoding="utf-8")
    problems = lockintegrity.check_pair(tmp_path / "pyproject.toml", tmp_path / "uv.lock")
    assert len(problems) == 1, problems
    assert "resolves pypdf" in problems[0] and "records no such requirement" in problems[0], problems[0]


# F12: uv normalises the root version it writes, and only the root version. Measured with uv 0.13.6:
# `version = "1.0.0.0"` locks as `version = "1.0"` and `uv lock --check` exits 0.

def test_root_version_is_compared_as_normalised_pep_440(tmp_path: Path) -> None:
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace('name = "probe"\nversion = "1.0.0"', 'name = "probe"\nversion = "1.0"'),
        PROBE_MANIFEST.replace('version = "1.0.0"', 'version = "1.0.0.0"'),
    )
    assert problems == [], problems

    drifted = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace('name = "probe"\nversion = "1.0.0"', 'name = "probe"\nversion = "1.0.1"'),
        PROBE_MANIFEST.replace('version = "1.0.0"', 'version = "1.0.0.0"'),
    )
    assert any("root package version" in problem for problem in drifted), drifted


def test_odd_specifiers_are_compared_as_uv_wrote_them(tmp_path: Path) -> None:
    """uv writes `===6.4.1`, `~=6.4.1` and `>=6.4.1, !=6.5.0` back verbatim, and accepts them.

    Measured with uv 0.13.6: each manifest below locks with its specifier written back unchanged —
    `specifier = "===6.4.1"`, `"~=6.4.1"`, `">=6.4.1,!=6.5.0"` (the spaces dropped) — and `uv lock
    --check` on each pair exits 0. The PEP 440 normalisation this reader applies is measured for the
    root version only; a specifier is compared as the text uv records.
    """
    for specifier in ("===6.4.1", "~=6.4.1", ">=6.4.1, !=6.5.0"):
        problems = _probe_pair(
            tmp_path,
            PROBE_LOCK.replace('specifier = "==6.4.1"', 'specifier = "' + specifier + '"'),
            PROBE_MANIFEST.replace('"pypdf==6.4.1"', '"pypdf' + specifier + '"'),
        )
        assert problems == [], f"{specifier}: {problems}"


# F16: uv 0.13.6 accepts `{ include-group = "dev" }` and flattens it. Measured: `uv lock` writes
# `requires-dev.test = [{ name = "pytest", specifier = "==8.4.2" }]` and `uv lock --check` exits 0.

def test_include_group_is_flattened_the_way_uv_flattens_it(tmp_path: Path) -> None:
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(
            'dev = [{ name = "pytest", specifier = "==8.4.2" }]\n',
            'dev = [{ name = "pytest", specifier = "==8.4.2" }]\ntest = [{ name = "pytest", specifier = "==8.4.2" }]\n',
        ),
        PROBE_MANIFEST.replace(
            'dev = ["pytest==8.4.2"]',
            'dev = ["pytest==8.4.2"]\ntest = [{ include-group = "dev" }]',
        ),
    )
    assert problems == [], problems


def test_include_group_of_an_undeclared_group_is_reported(tmp_path: Path) -> None:
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK,
        PROBE_MANIFEST.replace(
            'dev = ["pytest==8.4.2"]',
            'dev = ["pytest==8.4.2"]\ntest = [{ include-group = "missing-group" }]',
        ),
    )
    assert any("includes 'missing-group'" in problem for problem in problems), problems


# F17: `[tool.uv] package = true` means editable with no `[build-system]`. Measured with uv 0.13.6: uv
# wrote `source = { editable = "." }` for such a manifest and `uv lock --check` on it exits 0.

def test_tool_uv_package_true_locks_as_editable_without_a_build_system(tmp_path: Path) -> None:
    manifest = (
        '[project]\nname = "probe"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.15"\n'
        'dependencies = ["pypdf==6.4.1"]\n\n[tool.uv]\npackage = true\n'
    )
    lock = (
        'version = 1\nrevision = 5\nrequires-python = ">=3.12, <3.15"\n\n'
        '[[package]]\nname = "probe"\nversion = "1.0.0"\nsource = { editable = "." }\n\n'
        '[package.metadata]\nrequires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]\n'
        + _package_block("pypdf", "6.4.1", PYPDF_ARTIFACTS)
    )
    assert _probe_pair(tmp_path, lock, manifest) == []


# F18: the revision ceiling is this toolkit's support policy. Measured: uv 0.13.6 and uv 0.9.30 both
# exit 0 on `uv lock --check` against a pair identical to the one 0.13.6 wrote except `revision = 6`
# and `revision = 99`.

def test_revision_above_the_supported_maximum_is_a_support_limit_not_a_uv_verdict(tmp_path: Path) -> None:
    for revision in (6, 99):
        problems = _probe_pair(tmp_path, PROBE_LOCK.replace("revision = 5", f"revision = {revision}"), PROBE_MANIFEST)
        assert len(problems) == 1, problems
        assert f"revision {revision}" in problems[0], problems[0]
        assert "support policy, not a uv verdict" in problems[0], problems[0]
        assert "needs to be updated" not in problems[0], problems[0]


# --- the classes this measurement round put into BOTH readers in the same change -------------------
#
# Each pair below is one of the 69 adversarial pairs this round measured under `/tmp/adv-037/pairs`.
# The exit codes quoted are those pairs' measured verdicts from uv 0.5.0 / 0.6.10 / 0.7.22 / 0.8.5 /
# 0.9.30 / 0.10.7 / 0.13.6 — `lock --check`, or `sync --locked --python 3.12` for 0.5.0, which has no
# `lock --check`. `python3 /tmp/fix-readers/crossread.py /tmp/adv-037/pairs` runs this reader and
# `extension/lockfile.js` over all 69 and must report zero divergences; a fix that lands on one side
# alone shows up there as a divergence, which is why these rows exist here as well as in
# `extension/test/lockfile-adversarial.test.js`.

def test_a_specifier_is_compared_as_a_set_of_bounds(tmp_path: Path) -> None:
    """P63 (the shipped pair), P01, P64 and P51: uv accepts the same bounds written in a different
    order — exit 0 on every uv in the matrix. P02 and P03, where a bound is added or dropped, are
    refused by every uv (2/2/2/1/1/1/1). Comparing specifier strings instead of bound sets reports P63
    as drift and blocks the toolkit's own build."""
    reordered = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace('specifier = "==6.4.1"', 'specifier = ">=6.4, <7"'),
        PROBE_MANIFEST.replace('"pypdf==6.4.1"', '"pypdf<7,>=6.4"'),
    )
    assert reordered == [], reordered

    python_reordered = _probe_pair(
        tmp_path, PROBE_LOCK,
        PROBE_MANIFEST.replace('requires-python = ">=3.12,<3.15"', 'requires-python = "<3.15,>=3.12"'),
    )
    assert python_reordered == [], python_reordered

    for manifest_specifier, lock_specifier in (('"pypdf>=6.4"', 'specifier = ">=6.4,<7"'),
                                               ('"pypdf<7,>=6.4,!=6.5"', 'specifier = ">=6.4,<7"')):
        problems = _probe_pair(
            tmp_path,
            PROBE_LOCK.replace('specifier = "==6.4.1"', lock_specifier),
            PROBE_MANIFEST.replace('"pypdf==6.4.1"', manifest_specifier),
        )
        assert len(problems) == 1, problems
        assert "declared dependencies differ" in problems[0], problems[0]


def test_resolution_markers_that_partition_requires_python_are_accepted(tmp_path: Path) -> None:
    """The shipped locks carry `requires-python = ">=3.12, <3.15"` beside

        resolution-markers = ["python_full_version >= '3.14'", "python_full_version < '3.14'"]

    which partitions the declared range. uv 0.13.6 wrote that pair itself and `lock --check` on it exits
    0, so a coverage rule that flags it is a false alarm on the pair the toolkit ships.
    """
    def with_markers(markers: str) -> str:
        replaced = PROBE_LOCK.replace(
            'requires-python = ">=3.12, <3.15"\n',
            'requires-python = ">=3.12, <3.15"\nresolution-markers = [\n' + markers + "]\n",
        )
        assert "resolution-markers" in replaced
        return replaced

    shipped = "    \"python_full_version >= '3.14'\",\n    \"python_full_version < '3.14'\",\n"
    assert _probe_pair(tmp_path, with_markers(shipped), PROBE_MANIFEST) == []
    three_way = ("    \"python_full_version < '3.13'\",\n"
                 "    \"python_full_version >= '3.13' and python_full_version < '3.14'\",\n"
                 "    \"python_full_version >= '3.14'\",\n")
    assert _probe_pair(tmp_path, with_markers(three_way), PROBE_MANIFEST) == []
    whole = "    \"python_full_version >= '3.12'\",\n"
    assert _probe_pair(tmp_path, with_markers(whole), PROBE_MANIFEST) == []
    # uv's own `python_version` spelling of the same partition (P37b, uv 0.5.0 exit 0).
    spelled = "    \"python_version >= '3.14'\",\n    \"python_version < '3.14'\",\n"
    assert _probe_pair(tmp_path, with_markers(spelled), PROBE_MANIFEST) == []
    # A lock with no `resolution-markers` key at all is not a gap: uv 0.5.0 wrote none (P22, exit 0).
    assert _probe_pair(tmp_path, PROBE_LOCK, PROBE_MANIFEST) == []


def test_resolution_markers_that_leave_part_of_requires_python_uncovered_are_refused(tmp_path: Path) -> None:
    """The other direction of the same rule. Dropping one marker leaves 3.12 and 3.13 with no fork:
    uv 0.13.6 refuses that lock (`lock --check` exit 1). P37 — a marker outside the declared range — is
    exit 2 on uv 0.6.10 and 0.7.22 and exit 1 on 0.8.5 through 0.13.6."""
    def with_markers(markers: str) -> str:
        replaced = PROBE_LOCK.replace(
            'requires-python = ">=3.12, <3.15"\n',
            'requires-python = ">=3.12, <3.15"\nresolution-markers = [\n' + markers + "]\n",
        )
        assert "resolution-markers" in replaced
        return replaced

    problems = _probe_pair(tmp_path, with_markers("    \"python_full_version >= '3.14'\",\n"), PROBE_MANIFEST)
    assert len(problems) == 1, problems
    assert "do not cover requires-python" in problems[0], problems[0]

    assert len(_probe_pair(tmp_path, with_markers("    \"python_full_version < '3.13'\",\n"), PROBE_MANIFEST)) == 1

    hole = ("    \"python_full_version >= '3.12' and python_full_version < '3.13'\",\n"
            "    \"python_full_version >= '3.14'\",\n")
    assert len(_probe_pair(tmp_path, with_markers(hole), PROBE_MANIFEST)) == 1

    outside = "    \"python_full_version >= '3.20'\",\n    \"python_full_version < '3.14'\",\n"
    problems = _probe_pair(tmp_path, with_markers(outside), PROBE_MANIFEST)
    assert len(problems) == 1, problems
    assert "cannot select any Python version" in problems[0], problems[0]


def test_a_lock_declaring_schema_version_two_is_refused(tmp_path: Path) -> None:
    """P34: `version = 2` in the lock header. uv 0.13.6 answers "unsupported schema version (v2, but
    only v1 is supported)" and exits 2 on every uv in the matrix. A reader that never reads the header
    certifies a lock no uv can open."""
    problems = _probe_pair(tmp_path, PROBE_LOCK.replace("version = 1\nrevision = 5", "version = 2\nrevision = 5"),
                           PROBE_MANIFEST)
    assert len(problems) == 1, problems
    assert "lockfile format version 2 is not 1" in problems[0], problems[0]
    assert "unsupported schema version" in problems[0], problems[0]


def test_an_sdist_written_as_a_list_is_refused(tmp_path: Path) -> None:
    """P25 and P25d: an sdist recorded as a one-element list. uv writes `sdist` as a table, and the list
    form is exit 2 on every uv in the matrix — uv cannot parse the field as it stands."""
    as_list = PYPDF_SDIST.replace('sdist = { url = ', 'sdist = [\n    { url = ')
    as_list = as_list[:-2] + " },\n]\n"
    assert as_list.startswith("sdist = [\n    { url = ") and as_list.endswith(" },\n]\n"), as_list
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace(_package_block("pypdf", "6.4.1", PYPDF_ARTIFACTS),
                           _package_block("pypdf", "6.4.1", as_list + PYPDF_WHEEL)),
        PROBE_MANIFEST,
    )
    assert any("writes its sdist as a list" in problem for problem in problems), problems


def test_root_version_spellings_uv_normalises_are_accepted(tmp_path: Path) -> None:
    """P12 (`v1.0.0`), P11 (`1.0-1`) and P13 (`1.0.00`): uv canonicalises the root version it writes,
    and `lock --check` on the pair it wrote exits 0 on every uv in the matrix. Real drift stays drift:
    `1.0.1` beside `1.0.0` is refused by every uv."""
    for declared, recorded in (("v1.0.0", "1.0.0"), ("1.0-1", "1.0.post1"), ("1.0.00", "1.0.0"),
                               ("1.0.0", "1.0")):
        lock = PROBE_LOCK.replace('name = "probe"\nversion = "1.0.0"', f'name = "probe"\nversion = "{recorded}"')
        manifest = PROBE_MANIFEST.replace('version = "1.0.0"', f'version = "{declared}"', 1)
        problems = _probe_pair(tmp_path, lock, manifest)
        assert problems == [], f"{declared} beside {recorded}: {problems}"

    problems = _probe_pair(tmp_path, PROBE_LOCK, PROBE_MANIFEST.replace('version = "1.0.0"', 'version = "1.0.1"', 1))
    assert len(problems) == 1, problems
    assert "does not match pyproject version" in problems[0], problems[0]


def test_a_root_entry_source_of_editable_dot_slash_dot_is_accepted(tmp_path: Path) -> None:
    """P31: uv writes the root entry's source path with a trailing slash. `lock --check` on the pair it
    wrote exits 0 (every uv in the matrix). A reader that compares the path string against `"."` reports
    the shipped project as drifted."""
    problems = _probe_pair(tmp_path, PROBE_LOCK.replace('source = { editable = "." }', 'source = { editable = "./" }'),
                           PROBE_MANIFEST)
    assert problems == [], problems


def test_a_byte_order_mark_on_the_manifest_is_not_drift(tmp_path: Path) -> None:
    """P21a and P21d: a UTF-8 BOM in front of `pyproject.toml`. uv 0.6.10 through 0.13.6 read it
    (exit 0); uv 0.5.0 — the toolkit's declared floor — fails on it with exit 2, "Failed to prepare
    distributions". Both readers strip it: the divergence is uv's own version difference, not a
    hand-edited dependency pair, and the floor is stated in
    `test_lockfile_revision_stays_readable_by_the_declared_uv_floor`."""
    problems = _probe_pair(tmp_path, PROBE_LOCK, "\ufeff" + PROBE_MANIFEST)
    assert problems == [], problems


def test_an_identical_requirement_written_twice_is_not_drift(tmp_path: Path) -> None:
    """P04: the same requirement spelled twice in `dependencies`. uv de-duplicates it and writes one
    `requires-dist` entry — exit 0 on every uv in the matrix. Counting entries compares the manifest
    against uv's de-duplication and reports a clean pair as drift."""
    problems = _probe_pair(
        tmp_path, PROBE_LOCK,
        PROBE_MANIFEST.replace('dependencies = ["pypdf==6.4.1"]', 'dependencies = ["pypdf==6.4.1", "pypdf==6.4.1"]'),
    )
    assert problems == [], problems
    # The same requirement under a different marker is still two requirements (uv refuses that pair).
    problems = _probe_pair(
        tmp_path, PROBE_LOCK,
        PROBE_MANIFEST.replace('dependencies = ["pypdf==6.4.1"]',
                               'dependencies = ["pypdf==6.4.1", "pypdf==6.4.1; sys_platform == \'win32\'"]'),
    )
    assert len(problems) == 1, problems
    assert "declared dependencies differ" in problems[0], problems[0]


def test_a_quoted_group_key_and_a_triple_quoted_version_are_read(tmp_path: Path) -> None:
    """P05 (a quoted key in `[dependency-groups]`) and P18 (the version as a triple-quoted scalar):
    TOML spellings uv reads, exit 0 on every uv in the matrix. A reader that keys the group section on a
    bare word, or that reads a triple-quoted scalar as its own quotes, reports the pair as drifted."""
    problems = _probe_pair(tmp_path, PROBE_LOCK,
                           PROBE_MANIFEST.replace('dev = ["pytest==8.4.2"]', '"dev" = ["pytest==8.4.2"]'))
    assert problems == [], problems
    problems = _probe_pair(tmp_path, PROBE_LOCK,
                           PROBE_MANIFEST.replace('version = "1.0.0"', 'version = """1.0.0"""', 1))
    assert problems == [], problems


def test_marker_atom_order_is_not_drift(tmp_path: Path) -> None:
    """P41: uv compares a PEP 508 conjunction as a set of atoms and writes them in its own order.
    `sys_platform == 'win32' and python_version >= '3.13'` beside uv's
    `python_full_version >= '3.13' and sys_platform == 'win32'` is exit 0 on every uv in the matrix."""
    problems = _probe_pair(
        tmp_path,
        PROBE_LOCK.replace('requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
                           'requires-dist = [{ name = "pypdf", marker = "python_full_version >= \'3.13\' '
                           'and sys_platform == \'win32\'", specifier = "==6.4.1" }]'),
        PROBE_MANIFEST.replace('"pypdf==6.4.1"',
                               '"pypdf==6.4.1; sys_platform == \'win32\' and python_version >= \'3.13\'"'),
    )
    assert problems == [], problems


def test_dynamic_optional_dependencies_accepts_what_uv_records_and_flags_its_removal(tmp_path: Path) -> None:
    """P48: with `dynamic = ["optional-dependencies"]` the manifest declares no extras and uv writes the
    ones the build backend produced into `provides-extras` — exit 0 on every uv in the matrix. P49:
    deleting `provides-extras` from that lock is refused — exit 0 on uv 0.5.0, then 2/2/1/1/1/1."""
    manifest = PROBE_MANIFEST.replace('dependencies = ["pypdf==6.4.1"]',
                                      'dependencies = ["pypdf==6.4.1"]\ndynamic = ["optional-dependencies"]')
    with_extras = PROBE_LOCK.replace('requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
                                     'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]\nprovides-extras = ["pdf"]')
    assert _probe_pair(tmp_path, with_extras, manifest) == []

    problems = _probe_pair(tmp_path, PROBE_LOCK, manifest)
    assert len(problems) == 1, problems
    assert "provides-extras" in problems[0], problems[0]


def test_the_cli_refuses_a_second_argument(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    """`python scripts/lockintegrity.py [root]` audits the tree named by `root`. A second argument is
    refused with usage on stderr rather than silently ignored — silently ignoring it is how an audit of
    the wrong tree reads as an audit of the right one."""
    assert lockintegrity.main(["lockintegrity.py", str(ROOT)]) == 0
    assert lockintegrity.main(["lockintegrity.py", str(tmp_path), str(ROOT)]) == 2
    assert "usage: lockintegrity.py [root]" in capsys.readouterr().err


# --- uv's own verdict, when this host has a uv ---------------------------------------------------

@pytest.mark.skipif(uv_binary() is None, reason="no uv on this development host — the uv gate is skipped, not passed")
def test_uv_itself_calls_every_shipped_pair_up_to_date() -> None:
    for pair_root in (ROOT, ROOT / "extension/worker", ROOT / "templates/recommended-overlay/notebooks/analysis"):
        run = subprocess.run(
            [uv_binary(), "lock", "--check", "--project", str(pair_root), "--no-config"],
            capture_output=True, text=True, cwd=pair_root, timeout=300,
        )
        assert run.returncode == 0, f"uv lock --check refused {pair_root}: {run.stderr.strip()}"
