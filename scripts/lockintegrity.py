"""Static lock/pyproject drift guard for every uv project this toolkit ships.

Why this exists. The 0.3.6 release bundled a `uv.lock` whose root package entry still recorded
`version = "0.3.4"` while the `pyproject.toml` shipped beside it declared `version = "0.3.6"`.
uv compares a lockfile against the project metadata before it will honour `--locked`
("When considering if the lockfile is up-to-date, uv will check if it matches the project
metadata" — https://docs.astral.sh/uv/concepts/projects/sync/), so every managed component setup
failed with:

    error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.

The version was bumped in 0.3.5 and 0.3.6 without re-running `uv lock`. Nothing in the test
suite compared the two files, so the pair went out twice. This module is the check that reads
the pair the way uv reads it, with no uv, no network and no environment.

What it compares: the root project name, the root project version, `requires-python` on both sides,
the declared dependency specifiers — `[project.dependencies]` plus every
`[project.optional-dependencies]` extra, each compared as its canonical name with its PEP 503
canonicalisation and its extras against the specifier uv recorded, marker-insensitive — the extra
names against the lock's `provides-extras`, the declared dependency groups, the root entry's source
mode and path, and the lockfile revision bound. A mismatch in any of them is what makes uv
call a lock stale. The comparison was validated on this host against real uv 0.5.0, 0.6.10, 0.7.22,
0.8.5, 0.9.30, 0.10.7 and 0.13.6: the drifted 0.3.6 pair is refused by every one of them, the
corrected pair is accepted by every one of them, and `uv lock` regenerates exactly the two lines this
guard names. Receipts: `evidence/quality-v0.3.7-2026-11-02/uv-matrix.json` and
`lock-provenance.json`.
"""

from __future__ import annotations

import re
import tomllib
from pathlib import Path

# The root project is the lock entry whose source points at the project directory itself.
LOCAL_SOURCE_KEYS = ("editable", "virtual")
# uv writes a local source path relative to the lockfile, so the project the lockfile belongs to is
# always `.`; `editable = "packages/p"` is a workspace member, not this project's root.
ROOT_SOURCE_PATH = "."
_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*")
_EXTRAS = re.compile(r"^\[([^\[\]]*)\]")
# Measured on this host: uv 0.13.6 **wrote** `revision = 5` when it regenerated the worker lock
# (`revision = 3 -> 5`, evidence/quality-v0.3.7-2026-11-02/lock-provenance.json), and uv 0.5.0
# **read** that lock — `uv sync --locked` on the shipped pair exited 0
# (evidence/quality-v0.3.7-2026-11-02/uv-matrix.json, `shippedPair.exitCode` 0). No older uv in the
# matrix wrote a revision, so this guard states the write and the read separately: the value it
# reports is the one 0.13.6 wrote, and the oldest uv proven to accept it is 0.5.0.
EXPECTED_REVISION_MAX = 5


def canonical_name(name: str) -> str:
    """PEP 503 name normalisation, so `python-docx` and `python_docx` compare equal."""
    return re.sub(r"[-_.]+", "-", str(name)).lower()


def _canonical_extras(items: object) -> str:
    """`["cli", "CLI"]` -> `"[cli]"`; `None` or empty -> `""`.

    Extras are part of the requirement identity: `mcp` and `mcp[cli]` are different requirements to
    uv, so they must not compare equal here.
    """
    if items is None:
        return ""
    if isinstance(items, str):
        items = [items]
    if not isinstance(items, (list, tuple, set)):
        raise ValueError(f"cannot read extras from {items!r}")
    names = sorted({canonical_name(item) for item in items if str(item).strip()})
    return "[" + ",".join(names) + "]" if names else ""


def _strip_marker(text: str) -> str:
    """Drop a PEP 508 environment marker: `"==306; sys_platform == 'win32'"` -> `"==306"`.

    The split is on the first `;` outside quotes and brackets, so a marker containing a quoted
    semicolon stays intact.
    """
    quote: str | None = None
    depth = 0
    for index, char in enumerate(text):
        if quote:
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char in "([":
            depth += 1
        elif char in ")]":
            depth = max(0, depth - 1)
        elif char == ";" and depth == 0:
            return text[:index]
    return text


def _normalize_specifier(text: str) -> str:
    """`">= 3.12, <3.15"` -> `">=3.12,<3.15"`: uv re-serialises specifiers without the spaces."""
    return re.sub(r"\s+", "", str(text))


def split_requirement(text: str) -> tuple[str, str]:
    """`"mcp[cli]>=1.0"` -> `("mcp[cli]", ">=1.0")`.

    The key is what uv itself compares: the canonical name with its extras attached, and the
    specifier with the PEP 508 marker removed. `"pywin32==306; sys_platform == 'win32'"` ->
    `("pywin32", "==306")`.
    """
    text = str(text).strip()
    match = _NAME.match(text)
    if match is None:
        raise ValueError(f"cannot read a package name from requirement {text!r}")
    name = canonical_name(match.group(0))
    rest = text[match.end():].strip()
    extras_match = _EXTRAS.match(rest)
    if extras_match is not None:
        name += _canonical_extras(extras_match.group(1).split(","))
        rest = rest[extras_match.end():].strip()
    return name, _normalize_specifier(_strip_marker(rest))


def _lock_requirement_pair(entry: dict) -> tuple[str, str]:
    """The (name+extras, specifier) uv recorded for one `requires-dist` / `requires-dev` entry.

    Measured on this host with `uv lock` (uv 0.13.6 and uv 0.5.0) on a probe project declaring
    `mcp[cli]==2.2.0` and `"pywin32==311; sys_platform == 'win32'"`, uv writes

        requires-dist = [
            { name = "mcp", extras = ["cli"], specifier = "==2.2.0" },
            { name = "pywin32", marker = "sys_platform == 'win32'", specifier = "==311" },
        ]

    so the extras live in their own `extras` key and the marker lives in its own `marker` key, with
    the specifier carrying neither. That is the shape this reader compares against: extras are part
    of the name, the marker is ignored. The singular `extra` key uv uses in the resolved
    `dependencies` list is accepted too, so a lock that records extras under either name compares.
    A lock entry with no extras key at all is read as "no extras", which is exactly what uv writes
    for a requirement without extras — it is not treated as a wildcard match for an extras-bearing
    requirement.
    """
    name = canonical_name(entry["name"]) + _canonical_extras(entry.get("extras", entry.get("extra")))
    return name, _normalize_specifier(_strip_marker(str(entry.get("specifier", ""))))


def _load_toml(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8"))


def lock_document_text(text: str, label: str = "uv.lock") -> dict:
    document = tomllib.loads(text)
    if not isinstance(document.get("package"), list):
        raise ValueError(f"{label}: no [[package]] entries in this lockfile")
    return document


def lock_document(lock_path: Path) -> dict:
    return lock_document_text(lock_path.read_text(encoding="utf-8"), str(lock_path))


def _local_source(entry: dict) -> tuple[str, str] | None:
    """`(mode, path)` for a lock entry with an `editable`/`virtual` source, else None."""
    source = entry.get("source")
    if not isinstance(source, dict):
        return None
    for key in LOCAL_SOURCE_KEYS:
        if key in source:
            return key, str(source[key])
    return None


def _describe_local_source(entry: dict) -> str:
    mode, path = _local_source(entry) or ("?", "?")
    return f"{entry.get('name')!r} ({mode} = {path!r})"


def root_entry_of(document: dict, label: str = "uv.lock") -> dict:
    """The lock entry for the project the lockfile belongs to.

    A workspace lock can carry more than one local entry. Picking one of them silently would let the
    guard compare the wrong package, so the ambiguity is named instead.
    """
    local = [(item, _local_source(item)) for item in document["package"]]
    local = [(item, source) for item, source in local if source is not None]
    if not local:
        raise ValueError(f"{label}: no editable/virtual root package entry")
    if len(local) > 1:
        raise ValueError(
            f"{label}: {len(local)} local (editable/virtual) package entries — "
            + ", ".join(_describe_local_source(item) for item, _ in local)
            + " — so the guard cannot tell which one is this project's root"
        )
    return local[0][0]


def root_lock_entry(lock_path: Path) -> dict:
    return root_entry_of(lock_document(lock_path), str(lock_path))


def _declared_pairs(values: object, label: str, where: str) -> tuple[set[tuple[str, str]], list[str]]:
    """Requirement pairs from a list of entries, plus a problem for every entry this reader cannot read."""
    pairs: set[tuple[str, str]] = set()
    problems: list[str] = []
    if not isinstance(values, list):
        return pairs, [f"{label}: {where} is not a list of requirements"]
    for value in values:
        if isinstance(value, str):
            try:
                pairs.add(split_requirement(value))
            except ValueError as error:
                problems.append(f"{label}: {where} entry {value!r} is not a requirement this reader can parse: {error}")
        elif isinstance(value, dict) and "name" in value:
            try:
                pairs.add(_lock_requirement_pair(value))
            except ValueError as error:
                problems.append(f"{label}: {where} entry {value!r} has extras this reader cannot read: {error}")
        else:
            problems.append(f"{label}: {where} entry {value!r} is not a requirement string this reader can compare")
    return pairs, problems


def _declared_groups(project: dict, label: str) -> tuple[dict[str, set[tuple[str, str]]], list[str]]:
    """Dependency groups as `{group name: {(name+extras, specifier)}}`, plus problems for odd entries.

    A group entry is a requirement string, or — in uv's dialect — a `{ include = "other-group" }`
    reference to another group. Measured with uv 0.5.0, `other = [{ include = "dev" }]` locks as
    `requires-dev.other = []`: the reference carries no specifier on either side, so the reader
    compares the group membership the reference names (the group must exist in the manifest) and
    contributes nothing to the specifier set. Any other entry shape — `{ id = "...", marker = "..."`
    and friends, which uv 0.13.6 rejects outright — is reported as a problem instead of reaching
    `split_requirement` and raising.
    """
    declared_groups = project.get("dependency-groups") or {}
    if not isinstance(declared_groups, dict):
        return {}, [f"{label}: [dependency-groups] is not a table of groups"]
    group_names = {str(key) for key in declared_groups}
    groups: dict[str, set[tuple[str, str]]] = {}
    problems: list[str] = []
    for key, value in declared_groups.items():
        group_name = str(key)
        pairs: set[tuple[str, str]] = set()
        if not isinstance(value, list):
            problems.append(f"{label}: dependency group {group_name!r} is not a list of requirements")
            groups[group_name] = pairs
            continue
        for item in value:
            if isinstance(item, str):
                try:
                    pairs.add(split_requirement(item))
                except ValueError as error:
                    problems.append(
                        f"{label}: dependency group {group_name!r} entry {item!r} is not a requirement "
                        f"this reader can parse: {error}"
                    )
            elif isinstance(item, dict) and set(item) == {"include"} and isinstance(item["include"], str):
                if item["include"] not in group_names:
                    problems.append(
                        f"{label}: dependency group {group_name!r} includes {item['include']!r}, "
                        "which the manifest does not declare"
                    )
            else:
                problems.append(
                    f"{label}: dependency group {group_name!r} entry {item!r} is neither a requirement "
                    "string nor an `{ include = ... }` group reference, so this reader cannot compare it "
                    "against the lock"
                )
        groups[group_name] = pairs
    return groups, problems


def _declared_extras(meta: dict, label: str) -> tuple[set[tuple[str, str]], set[str], list[str]]:
    """`[project.optional-dependencies]` as requirement pairs, plus the extra names it declares.

    uv folds optional dependencies into the root entry's `requires-dist` beside the plain ones —
    measured with uv 0.13.6 and uv 0.5.0 on a project declaring `optional-dependencies.pdf =
    ["pypdf==6.4.1"]` and `win = ["pywin32==311; sys_platform == 'win32'"]`:

        requires-dist = [
            { name = "mcp", extras = ["cli"], specifier = "==2.2.0" },
            { name = "pypdf", marker = "extra == 'pdf'", specifier = "==6.4.1" },
            { name = "pywin32", marker = "sys_platform == 'win32' and extra == 'win'", specifier = "==311" },
        ]
        provides-extras = ["pdf", "win"]

    so comparing only `[project.dependencies]` against `requires-dist` reports drift for a pair uv
    itself accepts. The markers are ignored here exactly as they are for plain requirements; the
    extra names are compared separately, against `provides-extras`.
    """
    optional = meta.get("optional-dependencies")
    if optional is None:
        return set(), set(), []
    if not isinstance(optional, dict):
        return set(), set(), [f"{label}: [project.optional-dependencies] is not a table of extras"]
    pairs: set[tuple[str, str]] = set()
    names: set[str] = set()
    problems: list[str] = []
    for key, value in optional.items():
        names.add(canonical_name(key))
        extra_pairs, extra_problems = _declared_pairs(
            value, label, f"optional-dependencies extra {str(key)!r}"
        )
        pairs |= extra_pairs
        problems.extend(extra_problems)
    return pairs, names, problems


def _normalize_python(constraint: str) -> str:
    return re.sub(r"\s+", "", str(constraint))


def _implied_source_mode(project: dict) -> str:
    """`editable` when the manifest declares a build-system and the project is packaged, else `virtual`.

    Measured on this host with uv 0.13.6 and uv 0.5.0: a project with a `[build-system]` locks as
    `source = { editable = "." }`, the same project without one locks as `source = { virtual = "." }`,
    and `[tool.uv] package = false` locks as `virtual` even with a build-system.
    """
    tool = project.get("tool")
    uv_settings = tool.get("uv") if isinstance(tool, dict) else None
    if isinstance(uv_settings, dict) and uv_settings.get("package") is False:
        return "virtual"
    return "editable" if isinstance(project.get("build-system"), dict) else "virtual"


def check_pair_text(pyproject_text: str, lock_text: str, label: str = "uv.lock") -> list[str]:
    """Return every reason uv would call this lockfile stale. An empty list means the pair is current.

    Text in, problems out — so the same comparison runs against bytes read out of a packaged VSIX.
    Nothing in here raises: a malformed manifest is a problem string, the same as a stale field, so
    callers such as `scripts/verify_vsix.py` report it on one line instead of printing a traceback.
    """
    problems: list[str] = []
    try:
        project = tomllib.loads(pyproject_text)
    except tomllib.TOMLDecodeError as error:
        return [f"{label}: pyproject.toml is not valid TOML: {error}"]
    if not isinstance(project, dict):
        return [f"{label}: pyproject.toml did not parse to a table"]
    meta = project.get("project")
    if not isinstance(meta, dict):
        return [f"{label}: pyproject.toml has no [project] table"]
    name = str(meta.get("name", ""))
    declared_version = meta.get("version")
    dynamic = [str(item) for item in meta.get("dynamic", [])]

    try:
        document = lock_document_text(lock_text, label)
        entry = root_entry_of(document, label)
    except (ValueError, tomllib.TOMLDecodeError) as error:
        text = str(error)
        # `lock_document_text` and `root_entry_of` already name the lockfile; do not say it twice.
        return [text if text.startswith(f"{label}:") else f"{label}: {text}"]

    lock_name = str(entry.get("name", ""))
    if canonical_name(lock_name) != canonical_name(name):
        problems.append(f"{label}: root package name {lock_name!r} does not match pyproject name {name!r}")

    if "version" in dynamic:
        if "version" in entry:
            problems.append(
                f"{label}: pyproject declares a dynamic version but the lock records {entry['version']!r}"
            )
    elif str(entry.get("version", "")) != str(declared_version):
        problems.append(
            f"{label}: root package version {entry.get('version')!r} does not match "
            f"pyproject version {declared_version!r} — uv sync --locked would refuse this pair"
        )

    source = _local_source(entry)
    if source is None:  # root_entry_of guarantees a local source; kept so the guard cannot skip the check
        problems.append(f"{label}: root package entry {lock_name!r} has no editable/virtual source to compare")
    else:
        mode, path = source
        implied = _implied_source_mode(project)
        if mode != implied:
            reason = (
                "the manifest declares a [build-system], so uv records the project as editable"
                if implied == "editable"
                else "the manifest declares no [build-system] (or sets tool.uv.package = false), so uv records the project as virtual"
            )
            problems.append(
                f"{label}: root package source is {mode} = {path!r} but {reason} — "
                "uv would rewrite this entry when it re-locks"
            )
        if path != ROOT_SOURCE_PATH:
            problems.append(
                f"{label}: root package source path {path!r} does not point at {ROOT_SOURCE_PATH!r}, "
                f"the project directory the lockfile sits in"
            )

    py_python = meta.get("requires-python")
    lock_python = document.get("requires-python")
    if py_python is not None and lock_python is None:
        problems.append(
            f"{label}: pyproject declares requires-python {py_python!r} but the lockfile records none "
            "— uv would re-lock this pair"
        )
    elif py_python is not None and lock_python is not None and _normalize_python(py_python) != _normalize_python(lock_python):
        problems.append(
            f"{label}: requires-python {lock_python!r} does not match pyproject {py_python!r}"
        )

    metadata = entry.get("metadata")
    if metadata is not None and not isinstance(metadata, dict):
        problems.append(f"{label}: lock metadata is not a table")
        metadata = {}
    metadata = metadata or {}

    declared, declared_problems = _declared_pairs(meta.get("dependencies", []), label, "pyproject dependency")
    problems.extend(declared_problems)
    optional_pairs, extras_declared, optional_problems = _declared_extras(meta, label)
    declared |= optional_pairs
    problems.extend(optional_problems)
    locked, locked_problems = _declared_pairs(metadata.get("requires-dist", []), label, "lock requires-dist")
    problems.extend(locked_problems)
    if declared != locked:
        problems.append(
            f"{label}: declared dependencies differ from the lock metadata: "
            f"pyproject {sorted(declared)} vs lock {sorted(locked)}"
        )

    # `provides-extras` is uv 0.13.6's record of the extras the root entry carries; uv 0.5.0 omits
    # the key entirely, so its absence is not drift — but a list that disagrees with the manifest is.
    provides = metadata.get("provides-extras")
    if provides is not None:
        if not isinstance(provides, list):
            problems.append(f"{label}: lock metadata provides-extras is not a list of extra names")
        else:
            # Extra names are canonicalised the same way package names are, so `PDF` and `pdf` are
            # the same extra on both sides of the comparison.
            locked_extras = {canonical_name(item) for item in provides if str(item).strip()}
            if locked_extras != extras_declared:
                problems.append(
                    f"{label}: the lock records provides-extras {sorted(locked_extras)} but the manifest "
                    f"declares optional-dependencies {sorted(extras_declared)}"
                )

    groups, group_problems = _declared_groups(project, label)
    problems.extend(group_problems)
    locked_groups: dict[str, set[tuple[str, str]]] = {}
    requires_dev = metadata.get("requires-dev") or {}
    if not isinstance(requires_dev, dict):
        problems.append(f"{label}: lock metadata requires-dev is not a table of groups")
    else:
        for key, value in requires_dev.items():
            pairs, pairs_problems = _declared_pairs(value, label, f"lock requires-dev group {str(key)!r}")
            problems.extend(pairs_problems)
            locked_groups[str(key)] = pairs
    if groups != locked_groups:
        problems.append(
            f"{label}: dependency groups differ from the lock metadata: "
            f"pyproject {sorted((k, sorted(v)) for k, v in groups.items())} vs lock "
            f"{sorted((k, sorted(v)) for k, v in locked_groups.items())}"
        )

    revision = document.get("revision", 1)
    if "revision" in document and (isinstance(revision, bool) or not isinstance(revision, int)):
        problems.append(
            f"{label}: lockfile revision {revision!r} is not an integer — uv cannot read this lockfile"
        )
    elif isinstance(revision, int) and not isinstance(revision, bool) and revision > EXPECTED_REVISION_MAX:
        problems.append(
            f"{label}: lockfile revision {revision} is above the reviewed maximum "
            f"{EXPECTED_REVISION_MAX} for the declared uv floor"
        )
    return problems


def check_pair(pyproject_path: Path, lock_path: Path) -> list[str]:
    return check_pair_text(
        pyproject_path.read_text(encoding="utf-8"), lock_path.read_text(encoding="utf-8"), lock_path.name
    )


def shipped_pairs(root: Path) -> list[tuple[str, str]]:
    """Every pyproject/uv.lock pair this toolkit builds, bundles or documents."""
    return [
        ("pyproject.toml", "uv.lock"),
        ("extension/worker/pyproject.toml", "extension/worker/uv.lock"),
        ("templates/recommended-overlay/notebooks/analysis/pyproject.toml",
         "templates/recommended-overlay/notebooks/analysis/uv.lock"),
    ]


def check_tree(root: Path) -> dict[str, object]:
    report: dict[str, object] = {"pairs": {}, "problems": []}
    for pyproject_relative, lock_relative in shipped_pairs(root):
        pyproject_path, lock_path = root / pyproject_relative, root / lock_relative
        if not pyproject_path.is_file() or not lock_path.is_file():
            report["problems"].append(f"missing pair: {pyproject_relative} / {lock_relative}")
            continue
        problems = check_pair(pyproject_path, lock_path)
        try:
            revision: object = lock_document(lock_path).get("revision", 1)
            root_version: object = root_lock_entry(lock_path).get("version")
        except (ValueError, tomllib.TOMLDecodeError) as error:
            # The unreadable lock is already in `problems` as a comparison failure; the report must
            # still be JSON-serialisable so the CLI can print it.
            report["problems"].append(f"{lock_relative}: {error}")
            revision, root_version = None, None
        report["pairs"][pyproject_relative] = {
            "lock": lock_relative,
            "lockRevision": revision,
            "rootVersion": root_version,
            "ok": not problems,
        }
        report["problems"].extend(problems)
    report["ok"] = not report["problems"]
    return report


def lock_dependency_set(lock_path: Path) -> set[tuple[str, str]]:
    """Every (name, version) in the lock except the root project entry — the diff guard for a re-lock."""
    return {
        (canonical_name(item["name"]), str(item.get("version", "")))
        for item in lock_document(lock_path)["package"]
        if _local_source(item) is None
    }


def main(argv: list[str] | None = None) -> int:
    """`python scripts/lockintegrity.py [root]` — JSON verdict, exit 1 when any shipped pair is stale."""
    import json
    import sys

    root = Path(argv[1]) if argv and len(argv) > 1 else Path(__file__).resolve().parents[1]
    report = check_tree(root)
    sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
