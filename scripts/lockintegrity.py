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
import sys
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

# `[tool.uv]` keys that change what uv resolves to. Measured with uv 0.13.6 against the shipped worker
# pair, changing only the manifest: each of these six made uv refuse the lock (`lock --check` exit 1)
# while a reader that ignores `[tool.uv]` called the pair current. `default-groups`, `index`,
# `default-index`, `find-links` and `no-build-isolation-package` were measured too and uv accepted the
# lock unchanged, so they are deliberately not flagged here.
#
# Three of the six are resolution inputs uv RECORDS in the lock it writes, and are certifiable when the
# lock carries them (see `UV_RECORDED_RESOLUTION_KEYS`): refusing them there is a false alarm that
# blocks `npm run package` on a pair uv itself produced.
UV_RESOLUTION_KEYS = frozenset({
    "override-dependencies", "constraint-dependencies", "environments", "required-environments",
    "sources", "exclude-newer",
})

# `[tool.uv]` key -> where uv records that same input in the lock it writes. Measured on this host, on
# probe projects whose `uv.lock` uv 0.13.6 wrote itself (adversarial pairs P06, P07, P08): beside the
# lock it wrote, `override-dependencies` (the lock carries `[manifest] overrides`),
# `constraint-dependencies` (`[manifest] constraints`) and `required-environments` (top-level
# `required-markers`) all pass `uv lock --check` at exit 0 on 0.6.10, 0.7.22, 0.8.5, 0.9.30, 0.10.7 and
# 0.13.6, and `uv-0.5.0 sync --locked --python 3.12` at exit 0. The reverse is a real defect: the same
# lock beside a manifest that dropped the key is refused by all seven (P10, exit 1 everywhere).
#
# `environments` is NOT in this table. Measured (P09): `environments = ["python_full_version >= '3.12'"]`
# beside the lock uv wrote for it, which records `supported-markers = []`, is refused by every uv in the
# matrix — exit 2 on 0.5.0, 0.6.10 and 0.7.22, exit 1 on 0.8.5 through 0.13.6. It stays refused.
UV_RECORDED_RESOLUTION_KEYS = {
    "override-dependencies": ("manifest", "overrides"),
    "constraint-dependencies": ("manifest", "constraints"),
    "required-environments": ("", "required-markers"),
}


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


def _specifier_bounds(text: object) -> list[str]:
    """The bounds of a specifier, one operator/bound pair per item, whitespace dropped."""
    return [re.sub(r"\s+", "", part) for part in str(text).split(",") if re.sub(r"\s+", "", part)]


def _normalize_specifier(text: str) -> str:
    """`"pypdf<7,>=6.4"`'s specifier `"<7,>=6.4"` -> `"<7,>=6.4"`; `">=6.4, <7"` -> the same string.

    A requirement specifier is compared as the SET of its parsed bounds, not as normalised text.
    Measured on this host against the shipped worker pair (adversarial pair P63) and a probe pair
    (P01): the manifest writes `pypdf<7,>=6.4` / `packaging<25,>=24.0`, and uv 0.13.6 writes
    `specifier = ">=6.4,<7"` / `">=24.0,<25"` — the order **uv itself writes** — and `uv-0.13.6
    lock --check` exits 0 on all of 0.6.10, 0.7.22, 0.8.5, 0.9.30, 0.10.7 and 0.13.6, and
    `uv-0.5.0 sync --locked --python 3.12` exits 0. Comparing the two texts calls the pair the toolkit
    ships stale, which is what made `scripts/build_worker_bundle.py` refuse to build.
    A strict subset or superset is still a different set, so the pairs uv really refuses stay refused:
    manifest `>=24.0` against lock `>=24.0,<25` (P02) and manifest `<25,>=24.0,!=24.1` against the same
    lock (P03) are both exit 2 on 0.5.0-0.7.22 and exit 1 from 0.8.5 on.
    Each bound is kept verbatim — uv writes `===6.4.1`, `~=6.4.1` and `>=6.4.1,!=6.5.0` back unchanged,
    so a bound's own text is not normalised.
    """
    return ",".join(sorted(set(_specifier_bounds(text))))


# --- PEP 508 markers, compared after uv's own rewrite ---------------------------------------------

_MARKER_ATOM = re.compile(
    r"^([A-Za-z_][A-Za-z0-9_.]*)\s*(<=|>=|==|!=|~=|not in|in|<|>)\s*(['\"])(.*?)\3$"
)
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
# models are the six comparison operators on a one-, two- or three-component `python_version` bound,
# plus `~=`, `in` and `not in` through the interval model below; a prefix bound (`'3.13.*'`), a
# parenthesised marker, or a `~=`/`==`/`!=` against a three-component bound is left unmodelled on
# purpose, because a reader that guessed at those rewrites would call a uv-current pair stale and stop
# the package build.
_PYTHON_VERSION_OPERATORS = {">=", "<", ">", "<=", "==", "!="}

# --- the `python_version` interval model -----------------------------------------------------------
#
# `python_version` only ever holds `major.minor`, so a `python_version` constraint is a set of
# `major.minor` points, and uv rewrites it into `python_full_version` bounds that select exactly the
# same points. Measured on this host with uv 0.13.6 (`uv lock` on a probe project, then `uv lock
# --check` on what it wrote — exit 0 for every row), the spelling uv settles on is:
#
#     python_version ~= '3.12'        -> python_full_version >= '3.12' and python_full_version < '4'
#     python_version in '3.12 3.13'   -> python_full_version >= '3.12' and python_full_version < '3.14'
#     python_version in '3.12 3.14'   -> python_full_version == '3.12.*' or python_full_version == '3.14.*'
#     python_version not in '3.12 3.14'-> python_full_version < '3.12' or python_full_version == '3.13.*'
#                                        or python_full_version >= '3.15'
#
# That is a union of half-open `major.minor` intervals, adjacent intervals merged, printed bound by
# bound — which is what `_python_version_intervals` and `_spell_intervals` below reproduce. A single
# point prints as uv prints a single point (`== '3.12.*'`), a run of points prints as one bounded
# interval, and the complement of a run prints as the open ends plus the holes. `~=` with a
# three-component bound is left unmodelled: measured, uv 0.13.6 writes `python_version < '0'` for it,
# which is a construct this reader will not guess at.

_MINOR_POINT = re.compile(r"^(?P<major>\d{1,2})(?:\.(?P<minor>\d{1,2}))?$")


def _minor_point(text: object) -> tuple[int, int] | None:
    match = _MINOR_POINT.match(str(text).strip())
    if match is None:
        return None
    return (int(match.group("major")), int(match.group("minor") or 0))


def _next_minor(point: tuple[int, int]) -> tuple[int, int]:
    return (point[0], point[1] + 1)


def _spell_minor(point: tuple[int, int]) -> str:
    """uv prints `4` for `4.0` and `3.12` for `3.12`."""
    return str(point[0]) if point[1] == 0 else f"{point[0]}.{point[1]}"


def _merge_intervals(intervals: list[tuple[tuple[int, int] | None, tuple[int, int] | None]]):
    """Sort half-open `major.minor` intervals and merge the ones that touch or overlap."""
    kept = [(lo, hi) for lo, hi in intervals if lo is None or hi is None or lo < hi]
    kept.sort(key=lambda pair: (pair[0] is not None, pair[0] or (0, 0), pair[1] is None, pair[1] or (0, 0)))
    merged: list = []
    for lo, hi in kept:
        if merged:
            previous_lo, previous_hi = merged[-1]
            if previous_hi is None:
                continue
            if lo is None or previous_hi >= lo:
                # The two intervals touch or overlap: keep the lower start and the higher end. An
                # unbounded end stays unbounded — `resolution-markers = ["… >= '3.14'", "… < '3.14'"]`
                # is the whole line, and a merge that dropped the open end called the shipped pair's own
                # markers a coverage gap.
                merged[-1] = (previous_lo, None if hi is None else (hi if previous_hi < hi else previous_hi))
                continue
        merged.append((lo, hi))
    return merged


def _complement_intervals(intervals):
    """Everything the merged intervals do not cover, over the whole `major.minor` line."""
    out: list = []
    cursor: tuple[int, int] | None = None
    for lo, hi in intervals:
        if lo is None:
            cursor = hi
            continue
        out.append((cursor, lo))
        cursor = hi
    if cursor is not None:
        out.append((cursor, None))
    return out


def _spell_intervals(intervals) -> list[tuple[str, ...]] | None:
    """One conjunction of `python_full_version` atoms per interval, in uv's own spelling.

    None when the spelling would not be uv's. Measured with uv 0.13.6 (adversarial probe
    `python_version not in '3.12 4'`), uv parenthesises a multi-atom clause inside a disjunction and
    spells its upper bound `python_full_version < '4.0'` there, while the same bound in a single
    clause (`python_version ~= '3.12'`) comes out as `python_full_version < '4'`. A disjunction that
    contains a conjunction is therefore not reproducible from the interval model, and guessing at it
    would report drift for a pair uv accepts.
    """
    groups: list[tuple[str, ...]] = []
    for lo, hi in intervals:
        if lo is None and hi is None:
            continue
        if lo is None:
            groups.append((f"python_full_version < {_spell_minor(hi)}",))
        elif hi is None:
            groups.append((f"python_full_version >= {_spell_minor(lo)}",))
        elif hi == _next_minor(lo):
            # uv writes the point in full here: `python_version in '3 3.12'` measures as
            # `python_full_version == '3.0.*' or python_full_version == '3.12.*'`, not `== '3.*'`.
            groups.append((f"python_full_version == {lo[0]}.{lo[1]}.*",))
        else:
            groups.append((f"python_full_version >= {_spell_minor(lo)}",
                           f"python_full_version < {_spell_minor(hi)}"))
    if len(groups) > 1 and any(len(group) > 1 for group in groups):
        return None
    return groups


def _python_version_expansion(operator: str, value: str):
    """A `~=`, `in` or `not in` `python_version` atom as uv's own conjunctions, or None if unmodelled."""
    if operator == "~=":
        components = str(value).split(".")
        # Measured with uv 0.13.6: `~= '3.12'` locks as `>= '3.12' and < '4'`, `~= '3.12.1'` locks as
        # `python_version < '0'`, and `~= '3'` locks with the marker dropped altogether. Only the
        # two-component spelling is a thing this reader models.
        if len(components) != 2 or not all(component.isdigit() for component in components):
            return None
        low = _minor_point(value)
        if low is None:
            return None
        groups = _spell_intervals([(low, (low[0] + 1, 0))])
        return None if groups is None else tuple(groups)
    points: list[tuple[int, int]] = []
    for item in re.split(r"[\s,]+", str(value).strip()):
        if not item:
            continue
        point = _minor_point(item)
        if point is None:
            return None
        points.append(point)
    if not points:
        return None
    intervals = _merge_intervals([(point, _next_minor(point)) for point in points])
    if operator == "not in":
        intervals = _complement_intervals(intervals)
    groups = _spell_intervals(intervals)
    if groups is None:
        return None
    return tuple(groups) or ((),)


def _normalize_marker_atom(atom: str):
    """One `name operator 'value'` atom in the form uv writes it.

    A plain atom comes back as one string. A `~=`, `in` or `not in` `python_version` atom comes back as
    a tuple of conjunctions — uv's own rewrite of it — because uv expands those three into a
    disjunction over `python_full_version` bounds, and `_marker_form` has to distribute them over the
    rest of the conjunction to compare the marker the way uv records it. None means this reader does
    not model the atom.
    """
    match = _MARKER_ATOM.match(atom)
    if match is None:
        return None
    variable, operator, value = match.group(1).lower(), match.group(2), match.group(4)
    if variable == "extra":
        return f"extra {operator} {canonical_name(value)}"
    if variable != "python_version":
        return f"{variable} {operator} {value}"
    if operator in ("~=", "in", "not in"):
        return _python_version_expansion(operator, value)
    components = value.split(".")
    if not all(component.isdigit() for component in components) or len(components) > 3:
        return None
    if operator not in _PYTHON_VERSION_OPERATORS:
        return None
    # `python_version` holds `major.minor`, so uv compares that point against the bound the way PEP 440
    # compares versions — `3.12` equals `3.12.0` and is below `3.12.2` — and prints the bounds of the
    # minors that survive. Measured with uv 0.13.6 on a probe project (`uv lock`, then `uv lock --check`
    # on what it wrote, exit 0 for every row):
    #
    #     >= '3.12'   -> >= '3.12'      >= '3.12.0' -> >= '3.12'     >= '3.12.2' -> >= '3.13'
    #     >= '4.0.0'  -> >= '4'         >  '3'       -> >= '3.1'      >  '3.12.0' -> >= '3.13'
    #     <  '3.13.0' -> <  '3.13'      <  '3.13.1'  -> <  '3.14'     <= '3'      -> <  '3.1'
    #     <= '3.12.0' -> <  '3.13'      == '3'       -> == '3.0.*'    == '3.13.0' -> == '3.13.*'
    #     != '3.13.0' -> != '3.13.*'
    #
    # A `==` or `!=` against a three-component bound is left unmodelled: measured, uv 0.13.6 writes
    # `python_version < '0'` for `== '3.12.1'` and drops the requirement's marker altogether for
    # `!= '3.12.1'`.
    major = int(components[0])
    minor = int(components[1]) if len(components) > 1 else 0
    patch = int(components[2]) if len(components) > 2 else 0
    point = _spell_minor((major, minor))
    above = _spell_minor((major, minor + 1))
    lower = above if patch > 0 else point
    if operator == ">=":
        return f"python_full_version >= {lower}"
    if operator == ">":
        return f"python_full_version >= {above}"
    if operator == "<":
        return f"python_full_version < {lower}"
    if operator == "<=":
        return f"python_full_version < {above}"
    if patch > 0:
        return None
    if operator == "==":
        return f"python_full_version == {major}.{minor}.*"
    return f"python_full_version != {major}.{minor}.*"


def _marker_form(text: object) -> tuple[tuple[str, ...], ...] | None:
    """A marker as a comparable form: sorted `or` clauses of sorted atoms, or None when unmodelled.

    `()` is the empty marker — uv records no `marker` key at all for an unmarked requirement, so an
    unmarked manifest requirement and an unmarked lock entry have to compare equal.

    A conjunction is a SET of atoms, not a sequence: measured with uv 0.13.6 (adversarial pair P41), a
    manifest writing `platform_machine == 'x86_64' and os_name == 'posix'` beside the lock uv wrote,
    which records `os_name == 'posix' and platform_machine == 'x86_64'`, passes `lock --check` at exit 0
    on all seven uv binaries. Sorting the atoms is what makes that pair read as the pair uv wrote.
    """
    text = str(text).strip()
    if not text:
        return ()
    clauses: list[tuple[str, ...]] = []
    for clause in _split_marker_expression(text, "or"):
        atoms: list[str] = []
        expansions: list[tuple[tuple[str, ...], ...]] = []
        for atom in _split_marker_expression(clause, "and"):
            atom = atom.strip()
            if not atom or atom[0] in "([":
                return None
            normalized = _normalize_marker_atom(atom)
            if normalized is None:
                return None
            if isinstance(normalized, tuple):
                expansions.append(normalized)
            else:
                atoms.append(normalized)
        if len(expansions) > 1:
            # Two interval-modelled `python_version` atoms in one conjunction: uv intersects their
            # intervals and this reader has not measured that intersection, so it says nothing.
            return None
        if expansions:
            for extra in expansions[0]:
                clauses.append(tuple(sorted(atoms + list(extra))))
        else:
            clauses.append(tuple(sorted(atoms)))
    return tuple(sorted(clauses))


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
    v?
    (?:(?P<epoch>[0-9]+)!)?
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

    The spellings this normalisation has to absorb, each measured on this host against a lock uv itself
    wrote (adversarial pairs): a leading `v` (`version = "v1.0.0"` against `version = "1.0.0"`, P12,
    `lock --check` exit 0 on all seven uv binaries); a zero-padded component (`"1.0.00"` against
    `"1.0.0"`, P13, exit 0 on all seven); and the dash spelling of a post release (`"1.0-1"` against
    `"1.0.post1"`, P11, exit 0 on all seven). The epoch and the local segment are NOT absorbed — a lock
    root version of `1!0.3.7` (P15) or `0.3.7+local` (P14) beside a manifest `0.3.7` is refused by every
    uv in the matrix (exit 2 on 0.5.0-0.7.22, exit 1 from 0.8.5 on), and a real drift like 0.3.4 against
    0.3.7 is the defect this release exists to catch.
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
    """The filename uv recorded for one sdist or wheel entry.

    `url` wins over `filename`. Measured with uv 0.13.6 against the shipped worker lock (adversarial
    pair P27): a wheels entry carrying `filename = "pypdf-6.4.2-py3-none-any.whl"` beside
    `url = ".../pypdf-6.4.1-py3-none-any.whl"` is accepted by every uv in the matrix (`lock --check`
    exit 0 on all seven), so the pair is current and the name uv actually fetches is the one in `url`.
    Reading the stale `filename` first reported a version mismatch uv does not see.
    """
    if isinstance(artifact, dict):
        url = artifact.get("url")
        if isinstance(url, str) and url.strip():
            return url.split("?")[0].rstrip("/").rsplit("/", 1)[-1]
        filename = artifact.get("filename")
        if isinstance(filename, str) and filename.strip():
            return filename.strip()
    return ""


def _artifact_wheels(package: dict) -> list[tuple[str, str, str]]:
    """`(filename, name, claimed version)` for every WHEEL in one `[[package]]` block.

    Only wheels. Measured with uv 0.13.6 against the shipped worker lock (adversarial pair P25b): the
    pypdf entry's `sdist` rewritten to `pypdf-6.4.2.tar.gz` beside an entry whose version is 6.4.1 is
    accepted by all seven uv binaries (`lock --check` exit 0 on 0.5.0 through 0.13.6, and
    `uv-0.5.0 sync --locked --python 3.12` exit 0), while the same edit on the wheel filename is
    refused by all seven (P25c: exit 2 on 0.5.0-0.7.22, exit 1 from 0.8.5 on). uv validates the wheel
    filename against the entry and ignores whether the sdist filename agrees. That is measured uv
    behaviour, not a style preference, so this reader checks wheels and says nothing about sdist names.

    A filename this reader cannot read is skipped rather than guessed at: uv 0.13.6 accepts a package
    whose `sdist` and `wheels` keys were removed outright, so a missing artifact list is not drift and a
    filename in a shape this reader does not know is not evidence of drift either.
    """
    found: list[tuple[str, str, str]] = []
    wheels = package.get("wheels")
    if not isinstance(wheels, list):
        return found
    for artifact in wheels:
        filename = _artifact_filename(artifact)
        if not filename:
            continue
        match = _WHEEL_FILENAME.match(filename)
        if match is None:
            continue
        found.append((filename, match.group("name"), match.group("version")))
    return found


def _artifact_versions(package: dict) -> list[tuple[str, str]]:
    """Kept for callers that only want `(filename, claimed version)` of the wheels in a block."""
    return [(filename, version) for filename, _name, version in _artifact_wheels(package)]


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


def _normalize_source_path(path: object) -> str:
    """`"./"` -> `"."`: uv accepts both spellings of the project directory.

    Measured with uv 0.13.6 against the shipped worker lock (adversarial pair P31): rewriting the root
    entry to `source = { editable = "./" }` leaves `lock --check` at exit 0 on every uv in the matrix
    and `uv-0.5.0 sync --locked --python 3.12` at exit 0, while `editable = "packages/other-member"` is
    a workspace member and is not this project's root. A trailing slash is the only difference uv does
    not see, so it is the only difference this reader drops.
    """
    text = str(path)
    stripped = text.rstrip("/")
    return stripped if stripped else "."


def _local_source(entry: dict) -> tuple[str, str] | None:
    """`(mode, path)` for a lock entry with an `editable`/`virtual` source, else None.

    The path comes back normalised (`"./"` reads as `"."`), because that is the spelling uv accepts
    interchangeably for the project directory itself.
    """
    source = entry.get("source")
    if not isinstance(source, dict):
        return None
    for key in LOCAL_SOURCE_KEYS:
        if key in source:
            return key, _normalize_source_path(source[key])
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
        entry = (marker, marker_text)
        # A requirement written twice in the manifest is one requirement to uv. Measured (adversarial
        # pair P04): `[project.dependencies] = ["packaging==24.0", "packaging==24.0"]` locks as ONE
        # `requires-dist` entry and `uv lock --check` on that pair exits 0 on all seven uv binaries,
        # while counting the duplicate reported drift for the pair uv wrote. Two entries with different
        # markers stay two entries — that is how a package that is both a plain dependency and an extra
        # member is recorded.
        if entry in mapping.setdefault((name, specifier), []):
            continue
        mapping.setdefault((name, specifier), []).append(entry)
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
    """`requires-python` compared as the set of its bounds, exactly as a requirement specifier is.

    Measured on this host (adversarial pairs P64 and P51): the manifest writes
    `requires-python = "<3.15,>=3.12"` and uv writes `">=3.12, <3.15"` in the lock it produces;
    `uv lock --check` exits 0 on every uv in the matrix and `uv-0.5.0 sync --locked --python 3.12`
    exits 0. Comparing the two texts refuses the pair the toolkit ships.
    """
    return _normalize_specifier(constraint)


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


# --- resolution-markers against requires-python -----------------------------------------------------
#
# `resolution-markers` is the fork uv resolved under: every Python version the lock claims to support
# has to fall inside one of them. Measured on the shipped worker lock (adversarial pair P37), changing
# one marker from `python_full_version >= '3.14'` to `python_full_version >= '3.20'` beside
# `requires-python = ">=3.12, <3.15"` is refused by uv 0.9.30, 0.10.7 and 0.13.6 (`lock --check` exit 1,
# uv's ordinary staleness sentence) and by 0.6.10 and 0.7.22 (exit 2); uv 0.5.0 accepts it (exit 0), so
# the row in `extension/test/lockfile-adversarial.test.js` records that floor divergence. Dropping one
# marker out of the set is refused the same way (the "one resolution-marker dropped" row).
#
# What is modelled: the `python_full_version` / `python_version` bounds of each marker, as half-open
# `major.minor` intervals, and the requires-python range, as one such interval. A marker whose interval
# cannot intersect the declared range is named, and a range no marker covers is named. What is NOT
# modelled: the non-Python atoms of a marker (`sys_platform`, `os_name`, …) are ignored, which makes the
# coverage test an over-approximation — it can only report a gap that is real for every platform, never
# invent one. A marker whose Python bounds this reader cannot read is skipped rather than guessed at.

_PYTHON_MARKER_VARIABLES = ("python_full_version", "python_version")


def _python_atom_interval(atom: str):
    """The `major.minor` range one Python-version atom allows, as `(lo, hi)` with None for unbounded."""
    match = re.match(r"^(python_full_version|python_version)\s*(<=|>=|==|!=|<|>)\s*(.+)$", atom.strip())
    if match is None:
        return None
    operator, raw = match.group(2), match.group(3).strip().strip("'\"")
    prefix = raw.endswith(".*")
    point = _minor_point(raw[:-2] if prefix else raw)
    if point is None:
        return None
    if operator == "==":
        return (point, _next_minor(point))
    if operator == "!=":
        return None
    if operator == ">=":
        return (point, None)
    if operator == ">":
        return (_next_minor(point), None)
    if operator == "<":
        return (None, point)
    return (None, _next_minor(point))


def _marker_python_intervals(marker_text: object):
    """The union of `major.minor` ranges a marker allows, or None when it holds an unreadable atom."""
    text = str(marker_text or "").strip()
    if not text:
        return [(None, None)]
    union: list = []
    for clause in _split_marker_expression(text, "or"):
        interval: tuple | None = (None, None)
        found_python = False
        for atom in _split_marker_expression(clause, "and"):
            atom = atom.strip()
            if not atom or atom[0] in "([":
                return None
            if not atom.startswith(_PYTHON_MARKER_VARIABLES):
                continue
            found_python = True
            span = _python_atom_interval(atom)
            if span is None:
                return None
            # A conjunction intersects: a clause keeps only the `major.minor` points every one of its
            # Python atoms allows. `None` means unbounded, so it never wins an argument with a bound.
            lo, hi = interval
            if lo is None:
                lo = span[0]
            elif span[0] is not None and span[0] > lo:
                lo = span[0]
            if hi is None:
                hi = span[1]
            elif span[1] is not None and span[1] < hi:
                hi = span[1]
            interval = (lo, hi)
        if not found_python:
            # A marker with no Python bound applies to every Python version.
            union.append((None, None))
        else:
            union.append(interval)
    return _merge_intervals(union)


def _requires_python_interval(constraint: object):
    """The `major.minor` range a `requires-python` declares, or None when it is not a plain range."""
    interval: tuple | None = (None, None)
    for bound in _specifier_bounds(constraint):
        match = re.match(r"^(<=|>=|<|>)(.+)$", bound)
        if match is None:
            return None
        operator, raw = match.group(1), match.group(2)
        point = _minor_point(raw[:-2] if raw.endswith(".*") else raw)
        if point is None:
            return None
        if operator == ">=":
            interval = (point, interval[1])
        elif operator == ">":
            interval = (_next_minor(point), interval[1])
        elif operator == "<":
            interval = (interval[0], point)
        else:
            interval = (interval[0], _next_minor(point))
    return interval


def _intervals_cover(target, intervals) -> bool:
    """True when every point of `target` falls inside at least one of `intervals`."""
    lo, hi = target
    cursor = lo
    for ilo, ihi in _merge_intervals(list(intervals)):
        if cursor is not None and ihi is not None and ihi <= cursor:
            continue
        if ilo is not None and (cursor is None or ilo > cursor):
            return False
        if ihi is None:
            return True
        cursor = ihi
        if hi is not None and cursor >= hi:
            return True
    return hi is None or (cursor is not None and cursor >= hi)


def _resolution_marker_problems(document: dict, label: str) -> list[str]:
    """The same coverage rule `extension/lockfile.js` applies, in the same words: a marker set that
    partitions the declared range covers it, and a set that leaves a sub-range of the declared range with
    no marker, or whose markers cannot intersect the declared range at all, does not.

    Measured: the shipped pair's `resolution-markers = ["python_full_version >= '3.14'",
    "python_full_version < '3.14'"]` beside `requires-python = ">=3.12, <3.15"` is what uv 0.13.6 wrote
    itself and reads back with exit 0, so it must read clean here; dropping one marker is exit 1, and
    pair P37 — a marker outside the declared range — is exit 2 on uv 0.6.10 and 0.7.22 and exit 1 on
    0.8.5 through 0.13.6. A marker this reader does not model is skipped rather than guessed at.
    """
    markers = document.get("resolution-markers")
    if not isinstance(markers, list) or not markers:
        return []
    target = _requires_python_interval(document.get("requires-python"))
    if target is None:
        return []
    problems: list[str] = []
    covered: list = []
    for marker in markers:
        if not isinstance(marker, str):
            continue
        intervals = _marker_python_intervals(marker)
        if intervals is None:
            continue
        covered.extend(intervals)
        if not any(
            (lo is None or target[1] is None or lo < target[1])
            and (hi is None or target[0] is None or hi > target[0])
            for lo, hi in intervals
        ):
            problems.append(
                f"{label}: resolution-marker {marker!r} cannot select any Python version the lock's "
                f"requires-python {document.get('requires-python')!r} declares — uv resolved this lock "
                "under a fork its own requires-python excludes"
            )
    if not problems and covered and not _intervals_cover(target, covered):
        problems.append(
            f"{label}: the lock's resolution-markers do not cover requires-python "
            f"{document.get('requires-python')!r} — uv resolved this lock under a fork set that leaves "
            "part of the declared Python range unresolved"
        )
    return problems


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


def _lock_edge_names(item: dict) -> set[str]:
    """Every distribution name one `[[package]]` block resolves to: its own `dependencies` list plus
    its `[package.optional-dependencies]` and `[package.dev-dependencies]` tables."""
    names: set[str] = set()

    def collect(values: object) -> None:
        for value in values or []:
            if isinstance(value, dict) and value.get("name"):
                names.add(canonical_name(str(value["name"])))

    collect(item.get("dependencies"))
    for table in ("dev-dependencies", "optional-dependencies"):
        groups = item.get(table)
        if isinstance(groups, dict):
            for values in groups.values():
                collect(values)
    return names


def _marker_can_never_select(marker: tuple[tuple[str, ...], ...] | None, known_extras: set[str]) -> bool:
    """True when a requirement's marker can never be satisfied, so uv resolves nothing for it.

    Measured with uv 0.13.6 (adversarial pair P45): a manifest whose plain `[project.dependencies]`
    carries `packaging==24.0; extra == 'pdf'` while the manifest declares no `pdf` extra locks with
    `requires-dist = [{ name = "packaging", marker = "extra == 'pdf'", specifier = "==24.0" }]` and NO
    `[[package]]` entry for packaging, and `uv lock --check` on that pair exits 0 on all seven uv
    binaries. The marker can never select the requirement, so demanding an entry for it reports a
    defect uv does not have.
    """
    if not marker:
        return False
    for clause in marker:
        for atom in clause:
            match = re.match(r"^extra == (.+)$", atom)
            if match is not None and match.group(1) not in known_extras:
                return True
    return False


def _package_entry_problems(
    document: dict,
    locked: dict[tuple[str, str], list[tuple[object, str]]],
    locked_groups: dict[str, dict[tuple[str, str], list[tuple[object, str]]]],
    label: str,
    known_extras: set[str] | None = None,
    root_name: str = "",
) -> list[str]:
    """Every dependency edge the lock resolves has to name exactly one `[[package]]` block.

    Measured with uv 0.13.6 against a lock uv itself wrote: deleting the whole `[[package]]` block of a
    direct dependency makes `uv lock --check` exit 2 — "Dependency `pypdf` has missing `source` field but
    has more than one matching package" — while a reader that only compares `requires-dist` certifies the
    pair, because the metadata still names the dependency and the specifier still matches. The resolution
    the lock records is part of the pair, not just its metadata.

    The edges are taken from **every** `[[package]]` block, not only the root entry. Measured on the
    shipped worker lock (adversarial pairs P23 and P24): deleting the `h11` block, which only `httpcore2`
    and `uvicorn` name, makes every uv in the matrix answer "Failed to parse `uv.lock`" (exit 2 on
    0.5.0-0.7.22, exit 1 from 0.8.5 on), and duplicating that same block does the same. A reader that
    looks only at the root entry's dependency lists sees neither.
    """
    counts: dict[str, int] = {}
    for item in document["package"]:
        if not isinstance(item, dict):
            continue
        name = canonical_name(item.get("name", ""))
        if name:
            counts[name] = counts.get(name, 0) + 1
    # A project named like a registry package it depends on has two blocks with the same name, and the
    # local one is the root, not the dependency the edge resolves to.
    root = canonical_name(root_name)
    if root and root in counts:
        counts[root] -= 1

    known_extras = known_extras or set()
    wanted: set[str] = set()
    problems: list[str] = []

    def consider(base: str, marker: tuple[tuple[str, ...], ...] | None) -> None:
        if not base or base in wanted:
            return
        if _marker_can_never_select(marker, known_extras):
            return
        wanted.add(base)
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

    for mapping in (locked, *locked_groups.values()):
        for pair, markers in mapping.items():
            base = canonical_name(str(pair[0]).split("[", 1)[0])
            consider(base, markers[0][0] if markers else None)

    for item in document["package"]:
        if not isinstance(item, dict):
            continue
        for base in sorted(_lock_edge_names(item)):
            consider(base, None)
    return problems


def _package_version_problems(document: dict, label: str, root_name: str = "") -> list[str]:
    """Each `[[package]]` version has to agree with the wheels in its own block, and has to be there.

    Measured with uv 0.13.6 against a lock uv itself wrote: editing one transitive pin from `4.15.1` to
    `4.15.0`, metadata untouched, makes `uv lock --check` exit 2 — "The entry for package `anyio` (4.15.0)
    has wheel `anyio-4.15.1-py3-none-any.whl` with inconsistent version (4.15.1), which indicates a
    malformed wheel". A hand-edited pin is the exact defect `lock_dependency_set` exists to catch on a
    re-lock; here it is caught inside the lock itself.

    A package with no sdist and no wheels is not drift: uv 0.13.6 accepts a lock whose `sdist` and
    `wheels` keys were deleted outright (`lock --check` exit 0). A filename this reader cannot parse is
    skipped for the same reason — an unverifiable claim is not evidence.

    Two measured boundaries shape this check:

    * The SDIST filename is not checked. Measured on the shipped worker lock (adversarial pair P25b),
      `pypdf-6.4.2.tar.gz` beside an entry whose version is 6.4.1 is accepted by all seven uv binaries
      — `lock --check` exit 0 on 0.6.10 through 0.13.6 and `uv-0.5.0 sync --locked --python 3.12` exit 0
      — while the same edit on the wheel filename (P25c) is refused by all seven. uv validates wheel
      filenames and ignores sdist filename/version agreement. That is measured uv behaviour, not a style
      preference, and calling it drift would refuse a pair every uv this toolkit supports accepts.
    * An entry with no `version` key at all is refused (adversarial pair P28): `uv-0.13.6 lock --check`
      and `uv-0.5.0 sync --locked --python 3.12` both exit 2, "Failed to parse `uv.lock`". uv 0.6.10
      through 0.10.7 read that lock, so this is a floor-and-pinned-build verdict rather than a
      whole-matrix one, and it is recorded as such in `extension/test/lockfile-adversarial.test.js`.
      The root entry of a `dynamic = ["version"]` manifest is exempt: uv writes no version there and
      accepts the pair (`lock --check` exit 0).
    """
    problems: list[str] = []
    for item in document["package"]:
        if not isinstance(item, dict):
            continue
        name = canonical_name(item.get("name", ""))
        version = item.get("version")
        if version is None:
            if name != canonical_name(root_name):
                problems.append(
                    f"{label}: [[package]] entry {item.get('name')!r} records no version at all — "
                    "uv 0.13.6 and uv 0.5.0 both answer 'Failed to parse `uv.lock`' (exit 2) for this lock"
                )
            continue
        normalized = _normalize_pep440(version)
        if normalized is None:
            continue
        mismatched = []
        for filename, artifact_name, claimed in _artifact_wheels(item):
            if canonical_name(artifact_name) != name:
                # A wheel that belongs to another distribution: measured (adversarial pair P26), pasting
                # `foreign-9.9.9-py3-none-any.whl` into the pypdf entry makes every uv in the matrix
                # answer "Failed to parse `uv.lock`" (exit 2).
                mismatched.append(f"its artifact {filename!r} belongs to {artifact_name!r}, not to {item.get('name')!r}")
                continue
            claimed_normalized = _normalize_pep440(claimed)
            if claimed_normalized is None or claimed_normalized == normalized:
                continue
            mismatched.append(f"its artifact {filename!r} claims {claimed!r}")
        if mismatched:
            problems.append(
                f"{label}: {item.get('name')!r} records version {version!r} but "
                + ", and ".join(mismatched)
                + " — uv refuses a lock whose package version does not match its own wheel"
            )
        if isinstance(item.get("sdist"), list):
            # `sdist = [ {…} ]` is not the shape uv writes (`sdist = {…}`), and uv cannot read it:
            # measured (adversarial pairs P25 and P25d, the list with an entry and the empty list), every
            # uv in the matrix exits 2 — "Failed to parse `uv.lock`" from 0.6.10 on, "Failed to prepare
            # distributions" on 0.5.0. An artifact form this reader cannot parse is a problem, not an
            # absence of artifacts.
            problems.append(
                f"{label}: [[package]] entry {item.get('name')!r} writes its sdist as a list — "
                "uv writes `sdist = { url = … }` and refuses to parse this lock"
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


def _uv_resolution_problems(project: dict, document: dict, label: str) -> list[str]:
    """Compare the `[tool.uv]` resolution inputs against what the lock records for them.

    A key uv records in the lock is certifiable when both sides carry it; a key the manifest declares
    and the lock does not record is the pair uv refuses; a key the lock records and the manifest no
    longer declares is the same defect seen from the other side.
    """
    tool = project.get("tool")
    tool_uv = tool.get("uv") if isinstance(tool, dict) else None
    declared_keys = {str(key) for key in tool_uv} if isinstance(tool_uv, dict) else set()
    manifest_table = document.get("manifest") if isinstance(document.get("manifest"), dict) else {}
    recorded = {
        key: (document.get("required-markers") if where[0] == "" else manifest_table.get(where[1]))
        for key, where in UV_RECORDED_RESOLUTION_KEYS.items()
    }
    problems: list[str] = []
    unmodelled = sorted(key for key in declared_keys if key in UV_RESOLUTION_KEYS and key not in recorded)
    if unmodelled:
        problems.append(
            f"{label}: pyproject declares [tool.uv] {', '.join(unmodelled)}; this reader cannot model "
            "those resolution inputs, so the pair cannot be certified up to date"
        )
    certifiable = sorted(key for key in declared_keys if key in recorded)
    for key in certifiable:
        if recorded[key] is None:
            problems.append(
                f"{label}: pyproject declares [tool.uv] {key} but the lock records no "
                f"{UV_RECORDED_RESOLUTION_KEYS[key][1] or 'required-markers'} for it — measured on this "
                "host, uv refuses that pair (`lock --check` exit 1 on 0.8.5 through 0.13.6, exit 2 on "
                "0.5.0 through 0.7.22)"
            )
    for key in sorted(recorded):
        if key in declared_keys or recorded.get(key) is None:
            continue
        problems.append(
            f"{label}: the lock records {UV_RECORDED_RESOLUTION_KEYS[key][1]} but pyproject declares no "
            f"[tool.uv] {key} — measured on this host (adversarial pair P10), uv 0.5.0 through 0.13.6 "
            "all refuse that pair (`lock --check` exit 1)"
        )
    return problems


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
        elif dynamic_optional:
            # `dynamic = ["optional-dependencies"]` is resolved by the build backend, so the manifest
            # half of this comparison does not exist. Measured on this host (adversarial pair P48): a
            # project whose extras come from `[tool.setuptools.dynamic] optional-dependencies = { pdf =
            # { file = ["extras.txt"] } }` locks with `provides-extras = ["pdf"]`, and uv accepts that
            # pair — `lock --check` exit 0 on 0.6.10 through 0.13.6 and `uv-0.5.0 sync --locked --python
            # 3.12` exit 0. Comparing it against the empty `[project.optional-dependencies]` this reader
            # can see calls the pair uv wrote stale.
            pass
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
    elif dynamic_optional and "revision" in document:
        # The same key uv records for a dynamic extra, missing from a lock that carries a `revision`:
        # measured (adversarial pair P49), deleting `provides-extras = ["pdf"]` from the lock uv wrote
        # for a `dynamic = ["optional-dependencies"]` project is refused by uv 0.6.10 and 0.7.22 (exit 2)
        # and by 0.8.5, 0.9.30, 0.10.7 and 0.13.6 (exit 1). uv 0.5.0 accepts it (exit 0) because it
        # writes no `provides-extras` and no `revision` at all, which is why the `revision` test is what
        # separates "written by a uv that records extras" from "written by one that does not".
        problems.append(
            f"{label}: the manifest resolves its optional-dependencies dynamically and the lock carries "
            "a revision, but the lock records no provides-extras — uv 0.6.10 through 0.13.6 refuse this "
            "pair (measured: exit 2 on 0.6.10 and 0.7.22, exit 1 from 0.8.5 on)"
        )
    elif extras_declared and "revision" in document:
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

    known_extras = set(extras_declared)
    if isinstance(provides, list):
        known_extras |= {canonical_name(item) for item in provides if str(item).strip()}
    problems.extend(_package_entry_problems(document, locked, locked_groups, label,
                                            known_extras=known_extras, root_name=name))
    problems.extend(_package_version_problems(document, label, root_name=name))
    problems.extend(_root_resolution_problems(document, label))
    problems.extend(_resolution_marker_problems(document, label))

    # The lockfile's own format key. uv writes `version = 1` and refuses any other: measured on the
    # shipped worker lock (adversarial pair P34), raising it to `version = 2` makes every uv in the
    # matrix answer "Failed to parse `uv.lock`" (exit 2) with "this lockfile uses an unsupported schema
    # version (v2, but only v1 is supported)". A reader that parses the header and never uses it
    # certifies a lock no uv can open.
    lock_format = document.get("version")
    if lock_format is not None and (isinstance(lock_format, bool) or lock_format != 1):
        problems.append(
            f"{label}: lockfile format version {lock_format!r} is not 1 — uv writes `version = 1` and "
            "answers 'this lockfile uses an unsupported schema version' for anything else"
        )

    # `[tool.uv]` keys that change what uv resolves to. Measured on a pair that differs only by
    # `override-dependencies`: uv 0.13.6 refuses it (exit 1), uv 0.5.0 refuses it (exit 2), and a reader
    # that ignores `[tool.uv]` calls the same pair current — which would let a stale resolution through
    # the packaging gate and into a `--frozen` install. Three of them are certifiable when the lock
    # carries the record uv writes for them; see `UV_RECORDED_RESOLUTION_KEYS`.
    problems.extend(_uv_resolution_problems(project, document, label))

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
    """`python scripts/lockintegrity.py [root]` — JSON verdict, exit 1 when any shipped pair is stale.

    The documented argument is honoured: `root` is the tree whose shipped pairs get audited, so
    `python scripts/lockintegrity.py /path/to/extract` audits the extract, not this repository. With no
    argument it audits this module's own tree. A second argument is refused (exit 2) rather than
    silently ignored — silently ignoring it is how an audit of the wrong tree reads as an audit of the
    right one.
    """
    import json
    import sys

    argv = list(sys.argv if argv is None else argv)
    if len(argv) > 2:
        sys.stderr.write(f"usage: {argv[0]} [root]  (unexpected arguments: {' '.join(argv[2:])})\n")
        return 2
    root = Path(argv[1]) if len(argv) > 1 else Path(__file__).resolve().parents[1]
    report = check_tree(root)
    sys.stdout.write(json.dumps(report, indent=2, sort_keys=True) + "\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
