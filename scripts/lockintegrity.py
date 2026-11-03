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

What it compares: the root project name, the root project version — compared as normalised PEP 440,
because uv normalises the *root* version it writes (`version = "0.3.7.0"` locks as `version = "0.3.7"`)
while writing dependency specifiers back verbatim — `requires-python` on both sides in both directions,
the declared dependency specifiers — `[project.dependencies]` plus every
`[project.optional-dependencies]` extra, each compared as its canonical name with its PEP 503
canonicalisation and its extras against the specifier uv recorded, and its PEP 508 marker against the
`marker` uv recorded after uv's own rewrite (`python_version >= '3.13'` locks as
`python_full_version >= '3.13'`, and uv sorts the atoms of a conjunction) — the extra names against the
lock's `provides-extras`, the declared dependency groups (uv 0.13.6 flattens `{ include-group = "dev" }`
into the group it names, measured `lock --check` exit 0 and `uv-0.5.0 sync --locked` exit 0 on the pair
it wrote), the root entry's source mode and path, that every declared requirement
resolves to exactly one `[[package]]` entry, that each `[[package]]` version agrees with the sdist and
wheel filenames inside its own block, that the root entry's resolved `dependencies` and
`[package.dev-dependencies]` lists are covered by its own `[package.metadata]` lists — the lock compared
against itself, which is the comparison that survives a `dynamic = ["dependencies"]` manifest this reader
cannot resolve — and the lockfile revision bound. A mismatch in any of them is what
makes uv call a lock stale. The comparison was validated on this host against real uv 0.5.0, 0.6.10,
0.7.22, 0.8.5, 0.9.30, 0.10.7 and 0.13.6: the drifted 0.3.6 pair is refused by every one of them, the
corrected pair is accepted by every one of them, and `uv lock` regenerates exactly the two lines this
guard names. Receipts: `evidence/quality-v0.3.7-2026-11-02/uv-matrix.json` and
`lock-provenance.json`.

What it deliberately does not claim. A marker uv simplifies in a way this reader does not model — a
`~=`, `in` or `not in` comparison, a prefix version like `'3.13.*'`, a three-component
`python_version` bound, or a boolean sub-expression — is not compared at all: the reader reports nothing
rather than reporting drift it cannot prove. `EXPECTED_REVISION_MAX` is this toolkit's support policy,
not a uv verdict: uv 0.13.6 and uv 0.9.30 both read `revision = 6` and `revision = 99` and call such a
pair up to date.
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
#
# This is a support ceiling, not a uv verdict. Measured with uv 0.13.6 and uv 0.9.30 against a pair
# identical to the one uv 0.13.6 wrote except for `revision = 6` and `revision = 99`: both exited 0 on
# `uv lock --check`. A lock above this maximum is a pair this toolkit has not reviewed against its
# declared uv floor — it is not a pair uv calls stale.
EXPECTED_REVISION_MAX = 5

# `[tool.uv]` keys that change what uv resolves to and that this reader does not model. Measured with
# uv 0.13.6 against the shipped worker pair, changing only the manifest: each of these six made uv refuse
# the lock (`lock --check` exit 1) while a reader that ignores `[tool.uv]` called the pair current.
# `default-groups`, `index`, `default-index`, `find-links` and `no-build-isolation-package` were measured
# too and uv accepted the lock unchanged, so they are deliberately not flagged here.
UV_RESOLUTION_KEYS = frozenset({
    "override-dependencies", "constraint-dependencies", "environments", "required-environments",
    "sources", "exclude-newer",
})


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


# --- PEP 508 markers, compared after uv's own rewrite ---------------------------------------------

_MARKER_ATOM = re.compile(r"^([A-Za-z_][A-Za-z0-9_.]*)\s*(<=|>=|==|!=|~=|<|>)\s*(['\"])(.*?)\3$")
_WORD_CHAR = re.compile(r"[A-Za-z0-9_.]")

# Measured with uv 0.13.6 on a probe project (`uv lock`, then `uv lock --check` on what it wrote, exit 0
# for every row): uv rewrites the `python_version` variable into `python_full_version`, and rewrites the
# operator so the comparison keeps its meaning for a two-component interpreter version.
#
#     python_version >= '3.13'  ->  python_full_version >= '3.13'
#     python_version <  '3.13'  ->  python_full_version <  '3.13'
#     python_version >  '3.13'  ->  python_full_version >= '3.14'
#     python_version <= '3.13'  ->  python_full_version <  '3.14'
#     python_version == '3.13'  ->  python_full_version == '3.13.*'
#     python_version != '3.13'  ->  python_full_version != '3.13.*'
#     python_version >= '3'     ->  python_full_version >= '3'
#     python_version ~= '3.13'  ->  python_full_version >= '3.13' and python_full_version < '4'
#     python_version >= '3.13.1'->  python_full_version >= '3.14'
#     python_version not in '3.13 3.14' -> python_full_version < '3.13' or python_full_version >= '3.15'
#
# uv also sorts the atoms of a conjunction, and canonicalises an `extra` name the way it canonicalises
# an extra in `provides-extras` (`cli_tools` locks as `extra == 'cli-tools'`). The rows this reader
# models are the six comparison operators on a one- or two-component `python_version` bound; a `~=`,
# `in`/`not in`, prefix (`'3.13.*'`) or three-component bound is left unmodelled on purpose, because a
# reader that guessed at those rewrites would call a uv-current pair stale and stop the package build.
_PYTHON_VERSION_OPERATORS = {">=", "<", ">", "<=", "==", "!="}


def _split_marker_expression(text: str, separator: str) -> list[str]:
    """Split a marker on a boolean word, ignoring the word inside quotes or brackets."""
    parts: list[str] = []
    start = 0
    depth = 0
    quote: str | None = None
    index = 0
    while index < len(text):
        char = text[index]
        if quote:
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
        elif char in "([":
            depth += 1
        elif char in ")]":
            depth = max(0, depth - 1)
        elif depth == 0 and text.startswith(separator, index):
            before = text[index - 1] if index else ""
            after = text[index + len(separator)] if index + len(separator) < len(text) else ""
            if not _WORD_CHAR.match(before) and not _WORD_CHAR.match(after):
                parts.append(text[start:index])
                index += len(separator)
                start = index
                continue
        index += 1
    parts.append(text[start:])
    return parts


def _normalize_marker_atom(atom: str) -> str | None:
    """One `name operator 'value'` atom in the form uv writes it, or None if this reader does not model it."""
    match = _MARKER_ATOM.match(atom)
    if match is None:
        return None
    variable, operator, value = match.group(1).lower(), match.group(2), match.group(4)
    if variable == "extra":
        return f"extra {operator} {canonical_name(value)}"
    if variable != "python_version":
        return f"{variable} {operator} {value}"
    components = value.split(".")
    if not all(component.isdigit() for component in components) or len(components) > 2:
        return None
    if operator not in _PYTHON_VERSION_OPERATORS:
        return None
    if len(components) == 1:
        if operator not in (">=", "<"):
            return None
        return f"python_full_version {operator} {value}"
    next_minor = f"{int(components[0])}.{int(components[1]) + 1}"
    if operator in (">=", "<"):
        return f"python_full_version {operator} {value}"
    if operator == ">":
        return f"python_full_version >= {next_minor}"
    if operator == "<=":
        return f"python_full_version < {next_minor}"
    if operator == "==":
        return f"python_full_version == {value}.*"
    return f"python_full_version != {value}.*"


def _marker_form(text: object) -> tuple[tuple[str, ...], ...] | None:
    """A marker as a comparable form: sorted `or` clauses of sorted atoms, or None when unmodelled.

    `()` is the empty marker — uv records no `marker` key at all for an unmarked requirement, so an
    unmarked manifest requirement and an unmarked lock entry have to compare equal.
    """
    text = str(text).strip()
    if not text:
        return ()
    clauses: list[tuple[str, ...]] = []
    for clause in _split_marker_expression(text, "or"):
        atoms: list[str] = []
        for atom in _split_marker_expression(clause, "and"):
            atom = atom.strip()
            if not atom or atom[0] in "([":
                return None
            normalized = _normalize_marker_atom(atom)
            if normalized is None:
                return None
            atoms.append(normalized)
        clauses.append(tuple(sorted(atoms)))
    return tuple(sorted(clauses))


def _combine_marker_forms(left: tuple[tuple[str, ...], ...] | None,
                          right: tuple[tuple[str, ...], ...] | None):
    """`and` two marker forms: uv folds an optional dependency as `original and extra == 'pdf'`."""
    if left is None or right is None:
        return None
    if not left or not right:
        return left or right
    return tuple(sorted(tuple(sorted(a + b)) for a in left for b in right))


def _requirement_marker(text: str) -> tuple[str, tuple[tuple[str, ...], ...] | None]:
    """The PEP 508 marker of a requirement string, as written and as comparable."""
    quote: str | None = None
    depth = 0
    for index, char in enumerate(str(text)):
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
            return text[index + 1:].strip(), _marker_form(text[index + 1:])
    return "", ()


# --- PEP 440 versions -----------------------------------------------------------------------------

_PEP440 = re.compile(
    r"""
    ^(?:(?P<epoch>[0-9]+)!)?
    (?P<release>[0-9]+(?:\.[0-9]+)*)
    (?:[-_.]?(?P<pre>alpha|a|beta|b|preview|pre|c|rc)[-_.]?(?P<pre_n>[0-9]+)?)?
    (?:-(?P<post_n1>[0-9]+)|[-_.]?(?P<post>post|rev|r)[-_.]?(?P<post_n2>[0-9]+)?)?
    (?:[-_.]?(?P<dev>dev)[-_.]?(?P<dev_n>[0-9]+)?)?
    (?:\+(?P<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?
    $""",
    re.VERBOSE | re.IGNORECASE,
)
_PRE_LABELS = {"alpha": "a", "a": "a", "beta": "b", "b": "b", "preview": "c", "pre": "c", "c": "c", "rc": "c"}
_POST_LABELS = {"post": "post", "rev": "post", "r": "post"}


def _normalize_pep440(text: object) -> str | None:
    """`"0.3.7.0"` -> `"0.3.7"`: the PEP 440 canonical form, or None when the text is not a version.

    Measured with uv 0.13.6: a manifest declaring `version = "1.0.0.0"` locks as `version = "1.0"` and
    `uv lock --check` exits 0, so the root version has to compare as a normalised PEP 440 version.
    Dependency specifiers are a different matter — uv writes `==2.2.0.0`, `>=6.4.1,!=6.5.0`, `~=1.2` and
    `===6.4.1` back verbatim and accepts them, so those stay compared as text.
    """
    match = _PEP440.match(str(text).strip())
    if match is None:
        return None
    parts = match.groupdict()
    release = [str(int(component)) for component in parts["release"].split(".")]
    while len(release) > 1 and release[-1] == "0":
        release.pop()
    out = ""
    if parts["epoch"]:
        out += f"{int(parts['epoch'])}!"
    out += ".".join(release)
    if parts["pre"]:
        out += f"{_PRE_LABELS[parts['pre'].lower()]}{int(parts['pre_n'] or 0)}"
    post_number = parts["post_n1"] if parts["post_n1"] is not None else parts["post_n2"]
    if post_number is not None:
        out += f".post{int(post_number)}"
    if parts["dev"]:
        out += f".dev{int(parts['dev_n'] or 0)}"
    if parts["local"]:
        out += "+" + ".".join(re.split(r"[-_.]", parts["local"].lower()))
    return out


# --- sdist / wheel filenames ----------------------------------------------------------------------

_WHEEL_FILENAME = re.compile(
    r"^(?P<name>[A-Za-z0-9_.]+)-(?P<version>[A-Za-z0-9_.!+]+)-(?P<python>[A-Za-z0-9_.]+)"
    r"-(?P<abi>[A-Za-z0-9_.]+)-(?P<platform>[A-Za-z0-9_.]+)\.whl$"
)
_SDIST_FILENAME = re.compile(
    r"^(?P<name>.+)-(?P<version>[0-9][A-Za-z0-9_.!+:-]*)\.(?:tar\.gz|tar\.bz2|tar\.xz|tar|tgz|zip)$"
)


def _artifact_filename(artifact: object) -> str:
    """The filename uv recorded for one sdist or wheel entry."""
    if isinstance(artifact, dict):
        filename = artifact.get("filename")
        if isinstance(filename, str) and filename.strip():
            return filename.strip()
        url = artifact.get("url")
        if isinstance(url, str) and url.strip():
            return url.rstrip("/").rsplit("/", 1)[-1]
    return ""


def _artifact_versions(package: dict) -> list[tuple[str, str]]:
    """`(filename, claimed version)` for every sdist and wheel in one `[[package]]` block.

    A filename this reader cannot read is skipped rather than guessed at: uv 0.13.6 accepts a package
    whose `sdist` and `wheels` keys were removed outright, so a missing artifact list is not drift and a
    filename in a shape this reader does not know is not evidence of drift either.
    """
    found: list[tuple[str, str]] = []
    artifacts: list[object] = []
    if isinstance(package.get("sdist"), dict):
        artifacts.append(package["sdist"])
    if isinstance(package.get("wheels"), list):
        artifacts.extend(package["wheels"])
    for artifact in artifacts:
        filename = _artifact_filename(artifact)
        if not filename:
            continue
        match = _WHEEL_FILENAME.match(filename) or _SDIST_FILENAME.match(filename)
        if match is None:
            continue
        found.append((filename, match.group("version")))
    return found


def split_requirement(text: str) -> tuple[str, str]:
    """`"mcp[cli]>=1.0"` -> `("mcp[cli]", ">=1.0")`.

    The key is what uv itself compares: the canonical name with its extras attached, and the
    specifier with the PEP 508 marker removed. `"pywin32==306; sys_platform == 'win32'"` ->
    `("pywin32", "==306")`. The marker is not dropped from the comparison — it is compared too, after
    uv's own rewrite, by `_requirement_parts` and `_marker_form`; this two-part key is the one callers
    outside this module use.
    """
    name, specifier, _, _ = _requirement_parts(text)
    return name, specifier


def _requirement_parts(text: str) -> tuple[str, str, str, tuple[tuple[str, ...], ...] | None]:
    """`(name+extras, specifier, marker as written, marker as comparable)` for one requirement string."""
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
    marker_text, marker = _requirement_marker(rest)
    return name, _normalize_specifier(_strip_marker(rest)), marker_text, marker


def _lock_requirement_parts(entry: dict) -> tuple[str, str, str, tuple[tuple[str, ...], ...] | None]:
    """What uv recorded for one `requires-dist` / `requires-dev` entry, in the same four parts.

    Measured on this host with `uv lock` (uv 0.13.6 and uv 0.5.0) on a probe project declaring
    `mcp[cli]==2.2.0` and `"pywin32==311; sys_platform == 'win32'"`, uv writes

        requires-dist = [
            { name = "mcp", extras = ["cli"], specifier = "==2.2.0" },
            { name = "pywin32", marker = "sys_platform == 'win32'", specifier = "==311" },
        ]

    so the extras live in their own `extras` key and the marker lives in its own `marker` key, with the
    specifier carrying neither. A lock entry with no extras key at all is read as "no extras", which is
    exactly what uv writes for a requirement without extras — it is not treated as a wildcard match for
    an extras-bearing requirement.

    The singular `extra` key is uv's spelling in a resolved `[[package]]` `dependencies` list, not in
    `requires-dist`. Measured with uv 0.13.6: a lock whose `requires-dist` entry reads
    `{ name = "mcp", extra = "cli", specifier = "==2.2.0" }` beside a manifest declaring `mcp[cli]` is
    refused (`lock --check` exit 1), so reading `extra` here would certify a pair uv rejects.
    """
    name = canonical_name(entry["name"]) + _canonical_extras(entry.get("extras"))
    marker_text = str(entry.get("marker", "")).strip()
    return (
        name,
        _normalize_specifier(_strip_marker(str(entry.get("specifier", "")))),
        marker_text,
        _marker_form(marker_text),
    )


def _strip_bom(text: str) -> str:
    """Drop a leading byte-order mark.

    PowerShell 5.1's `Out-File -Encoding utf8` and older Notepad write one, and uv reads such a file
    without complaint. Treating it as a malformed manifest would refuse a pair uv accepts and blame the
    operator's editor for a toolkit build defect.
    """
    return text[1:] if text.startswith("﻿") else text


def _load_toml(path: Path) -> dict:
    return tomllib.loads(path.read_text(encoding="utf-8-sig"))


def lock_document_text(text: str, label: str = "uv.lock") -> dict:
    document = tomllib.loads(_strip_bom(text))
    if not isinstance(document.get("package"), list):
        raise ValueError(f"{label}: no [[package]] entries in this lockfile")
    return document


def lock_document(lock_path: Path) -> dict:
    return lock_document_text(lock_path.read_text(encoding="utf-8-sig"), str(lock_path))


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

    A workspace lock carries a local entry for every member, and uv writes the project the lockfile
    belongs to at the source path `.`. Measured with uv 0.13.6: a lock that carries an extra
    `source = { editable = "packages/other-member" }` entry beside the root entry is accepted
    (`lock --check` exit 0) whether it comes before or after it, so a second local entry that points
    somewhere else is not drift and must not be reported. Ambiguity is only real when two entries both
    claim `.` — then the guard cannot tell which one is this project's root, and it names them instead
    of guessing.
    """
    local = [(item, _local_source(item)) for item in document["package"]]
    local = [(item, source) for item, source in local if source is not None]
    if not local:
        raise ValueError(f"{label}: no editable/virtual root package entry")
    candidates = [(item, source) for item, source in local if source[1] == ROOT_SOURCE_PATH]
    if not candidates:
        # No entry claims `.`. Keep the one local entry this lock does have so the caller reports the
        # path drift instead of reporting a root entry that is missing.
        candidates = local
    if len(candidates) > 1:
        raise ValueError(
            f"{label}: {len(candidates)} local (editable/virtual) package entries all claiming the "
            f"source path {ROOT_SOURCE_PATH!r} — "
            + ", ".join(_describe_local_source(item) for item, _ in candidates)
            + " — so the guard cannot tell which one is this project's root"
        )
    return candidates[0][0]


def root_lock_entry(lock_path: Path) -> dict:
    return root_entry_of(lock_document(lock_path), str(lock_path))


def _requirement_map(
    values: object, label: str, where: str, extra_name: str | None = None
) -> tuple[dict[tuple[str, str], list[tuple[object, str]]], list[str]]:
    """Requirements as `{(name+extras, specifier): [(marker form, marker text)]}`, plus read problems.

    The key is the pair uv compares; the marker hangs off it because uv records a marker per
    requirement, and one name+specifier can legitimately appear twice with different markers — a
    package that is both a plain dependency and an extra member locks as two `requires-dist` entries.
    A `dict` entry is read in uv's lock shape (`name` / `extras` / `marker` / `specifier`), a `str` in
    PEP 508 shape. `extra_name` folds an optional dependency the way uv does: `extra == '<name>'` and
    whatever marker the requirement already carried.
    """
    mapping: dict[tuple[str, str], list[tuple[object, str]]] = {}
    problems: list[str] = []
    if not isinstance(values, list):
        return mapping, [f"{label}: {where} is not a list of requirements"]
    for value in values:
        parts: tuple[str, str, str, object] | None = None
        if isinstance(value, str):
            try:
                parts = _requirement_parts(value)
            except ValueError as error:
                problems.append(f"{label}: {where} entry {value!r} is not a requirement this reader can parse: {error}")
        elif isinstance(value, dict) and "name" in value:
            try:
                parts = _lock_requirement_parts(value)
            except ValueError as error:
                problems.append(f"{label}: {where} entry {value!r} has extras this reader cannot read: {error}")
        else:
            problems.append(f"{label}: {where} entry {value!r} is not a requirement string this reader can compare")
        if parts is None:
            continue
        name, specifier, marker_text, marker = parts
        if extra_name is not None:
            marker = _combine_marker_forms(marker, _marker_form(f"extra == '{extra_name}'"))
            marker_text = f"{marker_text} and extra == '{extra_name}'".strip()
        mapping.setdefault((name, specifier), []).append((marker, marker_text))
    return mapping, problems


def _marker_drift_problems(
    declared: dict[tuple[str, str], list[tuple[object, str]]],
    locked: dict[tuple[str, str], list[tuple[object, str]]],
    label: str,
    where: str,
) -> list[str]:
    """Report a requirement whose PEP 508 marker differs from the marker uv recorded.

    Only requirements whose markers this reader models are compared. A marker uv simplifies some other
    way — a `~=`, an `in`/`not in`, a prefix version, a three-component `python_version` bound — is left
    alone: guessing at it would call a pair uv accepts stale, and that stops the package build.
    """
    problems: list[str] = []
    for key in sorted(set(declared) & set(locked)):
        mine, theirs = declared[key], locked[key]
        if any(marker is None for marker, _ in mine) or any(marker is None for marker, _ in theirs):
            continue
        if sorted(marker for marker, _ in mine) == sorted(marker for marker, _ in theirs):
            continue
        name, specifier = key

        def spell(entries: list[tuple[object, str]]) -> str:
            return ", ".join("no marker" if not text else repr(text) for text in sorted(
                text for _, text in entries
            ))

        problems.append(
            f"{label}: {where} {name} {specifier or '(no specifier)'} carries "
            f"{spell(mine)} in the manifest but the lock records {spell(theirs)} — uv re-locks when a "
            "PEP 508 marker is added, removed or changed"
        )
    return problems


def _requirement_map_signature(mapping: dict[tuple[str, str], list[tuple[object, str]]]) -> dict[tuple[str, str], int]:
    """Which requirements a map holds, and how many entries each one carries.

    The marker is deliberately left out of the signature: a marker this reader does not model must not
    turn into a "these are different requirements" report. Marker differences are reported by
    `_marker_drift_problems`, which only speaks about markers it can actually compare.
    """
    return {key: len(value) for key, value in mapping.items()}


def _declared_groups(
    project: dict, label: str
) -> tuple[dict[str, dict[tuple[str, str], list[tuple[object, str]]]], list[str], set[str]]:
    """Dependency groups as `{group name: requirement map}`, plus problems, plus the groups to skip.

    A group entry is a requirement string, or — in uv's dialect — a reference to another group. The two
    spellings are not the same construct, and the measurements separate them (all four runs on this host,
    in a temp copy of the shipped worker pair, `HOME=/data/dsh/home`, `UV_CACHE_DIR=/tmp/uvcache`):

    * `{ include-group = "dev" }` is what uv 0.13.6 accepts, and it **flattens**: on a manifest declaring
      `dev = ["pytest==8.4.2"]` and `test = [{ include-group = "dev" }]`, uv 0.13.6 wrote
      `requires-dev.test = [{ name = "pytest", specifier = "==8.4.2" }]`, `lock --check` on that pair
      exited 0, and `uv-0.5.0 sync --locked --python 3.12` on the same pair exited 0. Beside a lock that
      records `test = []` instead, the same manifest is refused (`lock --check` exit 1), so the flattening
      is what makes the group comparison correct rather than noisy. The reader folds the referenced
      group's requirements into the including group.
    * `{ include = "dev" }` is the PEP 735 spelling uv 0.5.0 accepted — it locked the group as
      `requires-dev.test = []` and `sync --locked --python 3.12` on that pair exited 0 — and that uv
      0.13.6 refuses outright: `lock --check` exits 2 with "Project `research-stack-basic` has malformed
      dependency groups / Group `test` contains an unknown dependency object specifier: {"include":
      "dev"}", against both the uv 0.13.6 lock and the uv 0.5.0 lock. So it is neither a requirement nor
      something this reader can compare: it is reported as a construct the reader cannot certify, in the
      same words it uses for an unmodelled `[tool.uv]` input, and its group is left out of the
      comparison so the pair is not *also* reported as a group mismatch it cannot prove.

    Any other entry shape — `{ id = "...", marker = "..."` and friends — is reported as a problem
    instead of reaching `split_requirement` and raising.
    """
    declared_groups = project.get("dependency-groups") or {}
    if not isinstance(declared_groups, dict):
        return {}, [f"{label}: [dependency-groups] is not a table of groups"], set()
    group_names = {str(key) for key in declared_groups}
    groups: dict[str, dict[tuple[str, str], list[tuple[object, str]]]] = {}
    includes: dict[str, list[str]] = {}
    problems: list[str] = []
    # Groups this reader cannot model: their contents are not compared, because the only honest report
    # about them is already in `problems`.
    unmodellable: set[str] = set()
    for key, value in declared_groups.items():
        group_name = str(key)
        mapping: dict[tuple[str, str], list[tuple[object, str]]] = {}
        groups[group_name] = mapping
        if not isinstance(value, list):
            problems.append(f"{label}: dependency group {group_name!r} is not a list of requirements")
            continue
        for item in value:
            if isinstance(item, str):
                pairs, pair_problems = _requirement_map([item], label, f"dependency group {group_name!r} entry")
                problems.extend(pair_problems)
                for pair, markers in pairs.items():
                    mapping.setdefault(pair, []).extend(markers)
            elif isinstance(item, dict) and set(item) == {"include-group"} and isinstance(item["include-group"], str):
                referenced = item["include-group"]
                if referenced not in group_names:
                    problems.append(
                        f"{label}: dependency group {group_name!r} includes {referenced!r}, "
                        "which the manifest does not declare"
                    )
                    unmodellable.add(group_name)
                else:
                    includes.setdefault(group_name, []).append(referenced)
            elif isinstance(item, dict) and set(item) == {"include"} and isinstance(item["include"], str):
                referenced = item["include"]
                unmodellable.add(group_name)
                if referenced not in group_names:
                    problems.append(
                        f"{label}: dependency group {group_name!r} includes {referenced!r}, "
                        "which the manifest does not declare"
                    )
                problems.append(
                    f"{label}: dependency group {group_name!r} declares {{ include = {referenced!r} }}; "
                    "this reader cannot certify that group-reference spelling — measured on this host, "
                    "uv 0.13.6 refuses the manifest (`lock --check` exit 2, contains an unknown "
                    "dependency object specifier) and uv 0.5.0 accepted it and locked the group as empty, "
                    "so the pair cannot be certified up to date"
                )
            else:
                unmodellable.add(group_name)
                problems.append(
                    f"{label}: dependency group {group_name!r} entry {item!r} is neither a requirement "
                    "string nor an `{ include = ... }` group reference nor an `{ include-group = ... }` "
                    "one, so this reader cannot compare it against the lock"
                )
    for group_name in list(groups):
        groups[group_name] = _expand_group_includes(groups, includes, group_name, frozenset())
    return groups, problems, unmodellable


def _expand_group_includes(
    groups: dict[str, dict[tuple[str, str], list[tuple[object, str]]]],
    includes: dict[str, list[str]],
    name: str,
    seen: frozenset[str],
) -> dict[tuple[str, str], list[tuple[object, str]]]:
    """A group's requirements with every `include-group` reference it carries folded in, cycle-safe."""
    merged: dict[tuple[str, str], list[tuple[object, str]]] = {key: list(value) for key, value in groups.get(name, {}).items()}
    for referenced in includes.get(name, ()):
        if referenced in seen:
            continue
        merged = _merge_requirement_maps(
            merged, _expand_group_includes(groups, includes, referenced, seen | {name})
        )
    return merged


def _merge_requirement_maps(left: dict, right: dict) -> dict:
    merged: dict[tuple[str, str], list[tuple[object, str]]] = {key: list(value) for key, value in left.items()}
    for key, value in right.items():
        merged.setdefault(key, []).extend(value)
    return merged


def _declared_extras(meta: dict, label: str) -> tuple[dict[tuple[str, str], list[tuple[object, str]]], set[str], list[str]]:
    """`[project.optional-dependencies]` as a requirement map, plus the extra names it declares.

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
    itself accepts. Each optional requirement is compared with `extra == '<name>'` folded into its
    marker, exactly as uv folds it; the extra names are compared separately, against `provides-extras`.
    Measured with uv 0.13.6: a package that is both a plain dependency and an extra member locks as
    two entries, one unmarked and one marked `extra == 'pdf'`, and `uv lock --check` exits 0 — which is
    why the map keeps a list of markers per name+specifier instead of one.
    """
    optional = meta.get("optional-dependencies")
    if optional is None:
        return {}, set(), []
    if not isinstance(optional, dict):
        return {}, set(), [f"{label}: [project.optional-dependencies] is not a table of extras"]
    mapping: dict[tuple[str, str], list[tuple[object, str]]] = {}
    names: set[str] = set()
    problems: list[str] = []
    for key, value in optional.items():
        names.add(canonical_name(key))
        extra_map, extra_problems = _requirement_map(
            value, label, f"optional-dependencies extra {str(key)!r}", extra_name=canonical_name(key)
        )
        for pair, markers in extra_map.items():
            mapping.setdefault(pair, []).extend(markers)
        problems.extend(extra_problems)
    return mapping, names, problems


def _normalize_python(constraint: str) -> str:
    return re.sub(r"\s+", "", str(constraint))


_UV_DEFAULT_REQUIRES_PYTHON = re.compile(r"^>=[^,]+$")


def _is_uv_default_requires_python(constraint: object) -> bool:
    """True for the single lower bound uv records when the manifest declares no `requires-python`.

    Measured: uv 0.5.0, 0.7.22, 0.9.30 and 0.13.6 each lock a project with no `requires-python` as
    `requires-python = ">=3.12"` and then accept that lock (`lock --check` exit 0); uv 0.13.6 given
    `--python 3.13` writes `>=3.13` instead. The same manifest beside a lock recording
    `">=3.12, <3.15"` is refused (exit 1). A lone `>=` bound is therefore uv speaking for itself;
    anything with an upper bound is a constraint the manifest no longer declares.
    """
    return bool(_UV_DEFAULT_REQUIRES_PYTHON.match(_normalize_python(constraint)))


def _implied_source_mode(project: dict) -> str:
    """`editable` when the project is packaged, `virtual` when it is not.

    Measured on this host with uv 0.13.6 and uv 0.5.0: a project with a `[build-system]` locks as
    `source = { editable = "." }`, the same project without one locks as `source = { virtual = "." }`,
    and `[tool.uv] package = false` locks as `virtual` even with a build-system. `[tool.uv] package =
    true` is the mirror image and needs no `[build-system]`: measured with uv 0.13.6 on a manifest with
    no `[build-system]` at all, uv wrote `source = { editable = "." }` and `uv lock --check` on that pair
    exited 0. `package` is the manifest overriding the build-system question, in both directions.
    """
    tool = project.get("tool")
    uv_settings = tool.get("uv") if isinstance(tool, dict) else None
    if isinstance(uv_settings, dict):
        if uv_settings.get("package") is False:
            return "virtual"
        if uv_settings.get("package") is True:
            return "editable"
    return "editable" if isinstance(project.get("build-system"), dict) else "virtual"


def _package_entry_problems(
    document: dict,
    locked: dict[tuple[str, str], list[tuple[object, str]]],
    locked_groups: dict[str, dict[tuple[str, str], list[tuple[object, str]]]],
    label: str,
) -> list[str]:
    """Every requirement the lock claims has to resolve to exactly one `[[package]]` block.

    Measured with uv 0.13.6 against a lock uv itself wrote: deleting the whole `[[package]]` block of a
    direct dependency makes `uv lock --check` exit 2 — "Dependency `pypdf` has missing `source` field but
    has more than one matching package" — while a reader that only compares `requires-dist` certifies the
    pair, because the metadata still names the dependency and the specifier still matches. The resolution
    the lock records is part of the pair, not just its metadata.
    """
    counts: dict[str, int] = {}
    for item in document["package"]:
        if not isinstance(item, dict):
            continue
        name = canonical_name(item.get("name", ""))
        if name:
            counts[name] = counts.get(name, 0) + 1

    problems: list[str] = []
    seen: set[str] = set()
    mappings: list[dict[tuple[str, str], list[tuple[object, str]]]] = [locked, *locked_groups.values()]
    for mapping in mappings:
        for pair in mapping:
            # `mcp[cli]` is a requirement on the distribution `mcp`; the extras are not part of the
            # package name uv looks the entry up by.
            base = canonical_name(str(pair[0]).split("[", 1)[0])
            if not base or base in seen:
                continue
            seen.add(base)
            found = counts.get(base, 0)
            if found == 0:
                problems.append(
                    f"{label}: requirement {base} has no [[package]] entry in the lock — uv reports the "
                    "dependency as missing and refuses this pair"
                )
            elif found > 1:
                problems.append(
                    f"{label}: requirement {base} resolves to {found} [[package]] entries in the lock — "
                    "uv reports more than one matching package and refuses this pair"
                )
    return problems


def _package_version_problems(document: dict, label: str) -> list[str]:
    """Each `[[package]]` version has to agree with the sdist and wheel filenames in its own block.

    Measured with uv 0.13.6 against a lock uv itself wrote: editing one transitive pin from `4.15.1` to
    `4.15.0`, metadata untouched, makes `uv lock --check` exit 2 — "The entry for package `anyio` (4.15.0)
    has wheel `anyio-4.15.1-py3-none-any.whl` with inconsistent version (4.15.1), which indicates a
    malformed wheel". A hand-edited pin is the exact defect `lock_dependency_set` exists to catch on a
    re-lock; here it is caught inside the lock itself.

    A package with no sdist and no wheels is not drift: uv 0.13.6 accepts a lock whose `sdist` and
    `wheels` keys were deleted outright (`lock --check` exit 0). A filename this reader cannot parse is
    skipped for the same reason — an unverifiable claim is not evidence.
    """
    problems: list[str] = []
    for item in document["package"]:
        if not isinstance(item, dict):
            continue
        version = item.get("version")
        if version is None:
            continue
        normalized = _normalize_pep440(version)
        if normalized is None:
            continue
        mismatched = []
        for filename, claimed in _artifact_versions(item):
            claimed_normalized = _normalize_pep440(claimed)
            if claimed_normalized is None or claimed_normalized == normalized:
                continue
            mismatched.append(f"its artifact {filename!r} claims {claimed!r}")
        if mismatched:
            problems.append(
                f"{label}: {item.get('name')!r} records version {version!r} but "
                + ", and ".join(mismatched)
                + " — uv refuses a lock whose package version does not match its own sdist or wheel"
            )
    return problems


def _root_resolution_problems(document: dict, label: str) -> list[str]:
    """The root entry's resolved dependency lists have to be covered by its own metadata lists.

    For the local package uv writes both halves: `dependencies` and `[package.dev-dependencies]` name the
    distributions it resolved to, `[package.metadata] requires-dist` and `[package.metadata.requires-dev]`
    name the requirements those distributions came from. Measured with uv 0.13.6 on a
    `dynamic = ["dependencies"]` project whose requirements uv read from `requirements.txt`: the lock uv
    writes carries both halves and `uv lock --check` exits 0; emptying `requires-dist` while the resolved
    half still names `pypdf` makes it exit 1 — "The lockfile at `uv.lock` needs to be updated, but
    `--check` was provided". The manifest half of that pair is unreadable to this reader (a build backend
    resolves it), so this is the comparison that still works: the lock against itself.
    """
    candidates = [
        item
        for item in document["package"]
        if isinstance(item, dict)
        and (source := _local_source(item)) is not None
        and source[1] == ROOT_SOURCE_PATH
    ]
    if len(candidates) != 1:
        # No local entry at all, or two of them both claiming `.`: `root_entry_of` reports that already.
        return []
    entry = candidates[0]

    resolved: set[str] = set()
    for value in entry.get("dependencies") or []:
        if isinstance(value, dict) and value.get("name"):
            resolved.add(canonical_name(str(value["name"])))
    groups = entry.get("dev-dependencies")
    if isinstance(groups, dict):
        for values in groups.values():
            for value in values or []:
                if isinstance(value, dict) and value.get("name"):
                    resolved.add(canonical_name(str(value["name"])))

    metadata = entry.get("metadata")
    metadata = metadata if isinstance(metadata, dict) else {}
    recorded: set[str] = set()
    for value in metadata.get("requires-dist") or []:
        if isinstance(value, dict) and value.get("name"):
            recorded.add(canonical_name(str(value["name"])))
    declared_groups = metadata.get("requires-dev")
    if isinstance(declared_groups, dict):
        for values in declared_groups.values():
            for value in values or []:
                if isinstance(value, dict) and value.get("name"):
                    recorded.add(canonical_name(str(value["name"])))

    missing = sorted(resolved - recorded)
    if not missing:
        return []
    return [
        f"{label}: the root package entry resolves {', '.join(missing)} but its [package.metadata] "
        "records no such requirement — uv writes both halves of the root entry, and a lock whose resolved "
        "half names a distribution its metadata half does not record is not the lock uv wrote"
    ]


def check_pair_text(pyproject_text: str, lock_text: str, label: str = "uv.lock") -> list[str]:
    """Return every reason uv would call this lockfile stale. An empty list means the pair is current.

    Text in, problems out — so the same comparison runs against bytes read out of a packaged VSIX.
    Nothing in here raises: a malformed manifest is a problem string, the same as a stale field, so
    callers such as `scripts/verify_vsix.py` report it on one line instead of printing a traceback.
    """
    problems: list[str] = []
    try:
        project = tomllib.loads(_strip_bom(pyproject_text))
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
    else:
        lock_version, manifest_version = str(entry.get("version", "")), str(declared_version)
        # uv normalises the *root* version when it writes the lock: measured with uv 0.13.6, a manifest
        # declaring `version = "1.0.0.0"` locks as `version = "1.0"` and `uv lock --check` exits 0.
        # Comparing the raw text calls that pair stale. Dependency specifiers are the opposite — uv
        # writes `==2.2.0.0` and `===6.4.1` back verbatim — so only this comparison is normalised.
        normalized_lock, normalized_manifest = _normalize_pep440(lock_version), _normalize_pep440(manifest_version)
        if normalized_lock is None or normalized_manifest is None or normalized_lock != normalized_manifest:
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
    elif py_python is None and lock_python is not None and not _is_uv_default_requires_python(lock_python):
        # The other direction is drift too. Measured with uv 0.13.6 against a lock uv itself wrote:
        # deleting `requires-python` from the manifest only makes `lock --check` exit 1 — the lock still
        # carries the constraint, and uv reads the pair as no longer describing the manifest. The one
        # exception is uv's own default: a manifest with no `requires-python` makes uv write
        # `requires-python = ">=3.12"` (measured on uv 0.5.0, 0.7.22, 0.9.30 and 0.13.6; with
        # `--python 3.13` the same project locks as `>=3.13`), and `uv lock --check` on that pair exits
        # 0. A single lower bound is therefore the shape uv records when the manifest says nothing;
        # anything else in the lock is a constraint the manifest no longer declares.
        problems.append(
            f"{label}: the lockfile records requires-python {lock_python!r} but pyproject declares none "
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

    # `dynamic` fields are resolved by the build backend, not by the manifest text. Measured with uv
    # 0.13.6 on a project whose `dynamic = ["dependencies"]` is filled in by
    # `[tool.setuptools.dynamic] dependencies = { file = ["requirements.txt"] }`: uv wrote
    # `requires-dist` for the resolved set and `uv lock --check` on that pair exited 0. Comparing an
    # empty `[project.dependencies]` against it reports drift for a pair uv accepts, so the comparison
    # is skipped exactly as the dynamic-version rule skips the version comparison.
    dynamic_dependencies = "dependencies" in dynamic
    dynamic_optional = "optional-dependencies" in dynamic

    declared: dict[tuple[str, str], list[tuple[object, str]]] = {}
    optional_map: dict[tuple[str, str], list[tuple[object, str]]] = {}
    extras_declared: set[str] = set()
    if not dynamic_dependencies:
        declared, declared_problems = _requirement_map(meta.get("dependencies", []), label, "pyproject dependency")
        problems.extend(declared_problems)
    if not dynamic_optional:
        optional_map, extras_declared, optional_problems = _declared_extras(meta, label)
        problems.extend(optional_problems)
    for pair, markers in optional_map.items():
        declared.setdefault(pair, []).extend(markers)
    locked, locked_problems = _requirement_map(metadata.get("requires-dist", []), label, "lock requires-dist")
    problems.extend(locked_problems)
    if not dynamic_dependencies and not dynamic_optional:
        if _requirement_map_signature(declared) != _requirement_map_signature(locked):
            problems.append(
                f"{label}: declared dependencies differ from the lock metadata: "
                f"pyproject {sorted(declared)} vs lock {sorted(locked)}"
            )
        else:
            problems.extend(_marker_drift_problems(declared, locked, label, "requirement"))

    # `provides-extras` is uv 0.13.6's record of the extras the root entry carries. Measured across the
    # uv matrix on this host: uv 0.5.0 writes no `revision` key and no `provides-extras` at all, and
    # `uv 0.5.0 sync --locked` on the pair it wrote exits 0; uv 0.6.10 writes `revision = 1` **and**
    # `provides-extras`, as do 0.7.22, 0.8.5, 0.9.30, 0.10.7 and 0.13.6. So a lock that carries a
    # `revision` is a lock written by a uv that records extras, and a missing `provides-extras` in it is
    # drift. Measured with uv 0.13.6 against a lock uv itself wrote: adding `pdf = ["pypdf==6.4.1"]` to
    # the manifest — reusing a pin the lock already carries, so no new requirement text appears anywhere
    # — makes `lock --check` exit 1, and so does the empty `pdf = []`. In both cases the only evidence is
    # the extra name the manifest declares and the `provides-extras` the lock does not record.
    provides = metadata.get("provides-extras")
    if provides is not None:
        if not isinstance(provides, list):
            problems.append(f"{label}: lock metadata provides-extras is not a list of extra names")
        else:
            # Extra names are canonicalised the same way package names are, so `PDF`, `cli_tools` and
            # `pdf` compare equal on both sides: measured with uv 0.13.6, an extra declared as
            # `cli_tools` locks as `provides-extras = ["cli-tools"]`.
            locked_extras = {canonical_name(item) for item in provides if str(item).strip()}
            if locked_extras != extras_declared:
                problems.append(
                    f"{label}: the lock records provides-extras {sorted(locked_extras)} but the manifest "
                    f"declares optional-dependencies {sorted(extras_declared)}"
                )
    elif extras_declared and not dynamic_optional and "revision" in document:
        problems.append(
            f"{label}: the manifest declares optional-dependencies {sorted(extras_declared)} but the lock "
            "records no provides-extras — uv would re-lock this pair"
        )

    groups, group_problems, unmodellable_groups = _declared_groups(project, label)
    problems.extend(group_problems)
    locked_groups: dict[str, dict[tuple[str, str], list[tuple[object, str]]]] = {}
    requires_dev = metadata.get("requires-dev") or {}
    if not isinstance(requires_dev, dict):
        problems.append(f"{label}: lock metadata requires-dev is not a table of groups")
    else:
        for key, value in requires_dev.items():
            pairs, pairs_problems = _requirement_map(value, label, f"lock requires-dev group {str(key)!r}")
            problems.extend(pairs_problems)
            locked_groups[str(key)] = pairs
    # A group the reader just reported as unmodellable is not compared a second time: the honest report
    # about it is already in `problems`, and a group mismatch invented on top of it would name a defect
    # this reader cannot prove.
    if {name: _requirement_map_signature(mapping) for name, mapping in groups.items()
        if name not in unmodellable_groups} != {
        name: _requirement_map_signature(mapping) for name, mapping in locked_groups.items()
        if name not in unmodellable_groups
    }:
        problems.append(
            f"{label}: dependency groups differ from the lock metadata: "
            f"pyproject {sorted((k, sorted(v)) for k, v in groups.items() if k not in unmodellable_groups)} vs lock "
            f"{sorted((k, sorted(v)) for k, v in locked_groups.items() if k not in unmodellable_groups)}"
        )
    else:
        for group_name in sorted((set(groups) & set(locked_groups)) - unmodellable_groups):
            problems.extend(
                _marker_drift_problems(groups[group_name], locked_groups[group_name], label,
                                       f"dependency group {group_name!r} requirement")
            )

    problems.extend(_package_entry_problems(document, locked, locked_groups, label))
    problems.extend(_package_version_problems(document, label))
    problems.extend(_root_resolution_problems(document, label))

    # `[tool.uv]` keys that change what uv resolves to are not modelled by this reader. Measured on a
    # pair that differs only by `override-dependencies`: uv 0.13.6 refuses it (exit 1), uv 0.5.0 refuses
    # it (exit 2), and a reader that ignores `[tool.uv]` calls the same pair current — which would let a
    # stale resolution through the packaging gate and into a `--frozen` install.
    tool = project.get("tool")
    tool_uv = tool.get("uv") if isinstance(tool, dict) else None
    if isinstance(tool_uv, dict):
        unmodelled = sorted(key for key in tool_uv if key in UV_RESOLUTION_KEYS)
        if unmodelled:
            problems.append(
                f"{label}: pyproject declares [tool.uv] {', '.join(unmodelled)}; this reader cannot model "
                "those resolution inputs, so the pair cannot be certified up to date"
            )

    revision = document.get("revision", 1)
    if "revision" in document and (isinstance(revision, bool) or not isinstance(revision, int)):
        problems.append(
            f"{label}: lockfile revision {revision!r} is not an integer — uv cannot read this lockfile"
        )
    elif isinstance(revision, int) and not isinstance(revision, bool) and revision > EXPECTED_REVISION_MAX:
        problems.append(
            f"{label}: lockfile revision {revision} is above the maximum revision "
            f"{EXPECTED_REVISION_MAX} this toolkit supports for the declared uv floor — this is the "
            "toolkit's support policy, not a uv verdict: measured with uv 0.13.6 and uv 0.9.30, a lock "
            "at revision 6 passes `uv lock --check`"
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
