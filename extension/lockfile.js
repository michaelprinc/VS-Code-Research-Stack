"use strict";

/**
 * Lockfile drift: read a `uv.lock` and a `pyproject.toml` well enough to tell whether uv would
 * call the lock stale.
 *
 * uv compares a lockfile with the project metadata before it honours `--locked`
 * ("When considering if the lockfile is up-to-date, uv will check if it matches the project
 * metadata" — https://docs.astral.sh/uv/concepts/projects/sync/). The 0.3.6 release shipped a
 * worker pair where `pyproject.toml` said `version = "0.3.6"` and the lock beside it still
 * recorded `version = "0.3.4"`, so every managed component setup on a real host stopped with
 * "The lockfile at `uv.lock` needs to be updated, but `--locked` was provided."
 *
 * This module is the read-only half of the fix: it recognises that failure, compares a pair the
 * way uv compares it, and reports the pins a lock holds so a re-lock can be checked before it is
 * accepted. It starts no process and writes nothing.
 *
 * The comparison is (canonical name, extras, specifier, normalised marker). A PEP 508 marker IS
 * part of the requirement identity — measured with uv 0.13.6 on this host, a marker added to,
 * removed from, or changed on a requirement makes uv refuse the lock (exit 1) — but it is compared
 * after uv's own rewrite, never as raw text: uv records `python_version >= '3.13'` as
 * `python_full_version >= '3.13'` in the lock, and comparing the raw text would report drift for a
 * pair uv accepts. `markerKey` below is that rewrite, measured clause by clause.
 *
 * The reader also cross-checks what uv parses out of the lock itself: the version each `[[package]]`
 * entry records against the sdist and wheel filenames beside it, the resolved dependency edges
 * against the package entries they name, the root entry's resolved dependency lists against the
 * requirements its own `[package.metadata]` records (the comparison that survives a
 * `dynamic = ["dependencies"]` manifest, which this reader cannot resolve and therefore does not
 * compare against the manifest), and the root entry's source mode against what the manifest implies.
 * Each of those is a measured uv refusal (exit 2 or exit 1) that a metadata-only reader misses.
 *
 * The two readers of a pair — this module and `scripts/lockintegrity.py` — are aligned on measured
 * behaviour, pair by pair, in `extension/test/lockfile-adversarial.test.js`. Where a pair is not
 * certifiable at all (a `[tool.uv]` resolution input this reader does not model, a PEP 735
 * `{ include = … }` group reference uv 0.13.6 refuses), both say so in the same words instead of
 * reporting a mismatch neither of them can prove.
 */

/** uv's own refusal, seen unchanged on 0.5.0 through 0.13.6 on this host. */
const DRIFT_SIGNATURE = /The lockfile at `uv\.lock` needs to be updated, but `--(?:locked|check)` was provided/i;
/**
 * Reasons uv may call a lock stale that are NOT a version-only drift and must not be auto-repaired.
 *
 * Measured on this host, the staleness classes this reader now names — a changed or missing marker,
 * an extra the lock does not record, a `requires-python` the manifest dropped, a source mode the
 * manifest no longer implies — all print exactly `DRIFT_SIGNATURE` and nothing else (uv 0.13.6, exit
 * 1). No stderr signature can separate them from a version-only drift; `pairProblems` is what does,
 * and the shipped runtime consults it before it acts on `isLockDrift`. The lock-internal classes
 * (a pin that disagrees with its filenames, a dependency with no entry beside it, a lock with no
 * `requires-python`) are not drift at all: uv fails to parse the lock (exit 2, "Failed to parse
 * `uv.lock`"), which `DRIFT_SIGNATURE` does not match, so `isLockDrift` is already false for them.
 */
const STALENESS_REASONS = /mismatched requirements for:|change in Python requirement:|mismatched members:|No solution found when resolving|Failed to parse `uv\.lock`|inconsistent version|has missing `source` field|missing field|malformed dependency groups/i;
/**
 * Measured on this host: uv 0.5.0 through uv 0.13.6 all write `revision = 5`. `scripts/lockintegrity.py`
 * holds the same ceiling, so the Python guard and this reader report the same lock. This is a support
 * limit of this toolkit, not a claim about uv: uv 0.13.6 and 0.9.30 both read a `revision = 6` lock.
 */
const EXPECTED_REVISION_MAX = 5;
/**
 * A lock records a local source relative to the lockfile, so the project the lockfile belongs to is
 * always `.`. `editable = "packages/other"` is a workspace member, not this project's root entry.
 */
const ROOT_SOURCE_PATH = ".";

/**
 * A TOML table header — `[table]`, `[package.metadata]` or `[[package]]` — with an optional trailing
 * comment. TOML allows whitespace before a header, so an indented header still ends its table.
 */
const TABLE_HEADER = /^[ \t]*(?:\[\[[^\]]+\]\]|\[[^\]]+\])[ \t]*(#.*)?$/m;
/** The header that opens one `[[package]]` entry of a uv lockfile. */
const PACKAGE_HEADER = /^[ \t]*\[\[package\]\][ \t]*(#.*)?$/gm;
/** `key = [` in a table body, indented or not: TOML allows whitespace before a key. */
const keyArrayOpen = (key) => new RegExp(`^[ \\t]*${key}\\s*=\\s*\\[`, "m");
/** Every `key = [` assignment in a table body, capturing the key. */
const ANY_KEY_ARRAY_OPEN = /^[ \t]*([A-Za-z0-9_-]+)\s*=\s*\[/gm;
/**
 * The same in a manifest, where TOML also allows the key itself to be quoted.
 *
 * `[dependency-groups]\n"dev" = ["pytest==8.4.2"]` is ordinary TOML and uv locks it as
 * `requires-dev.dev` — measured (adversarial pair P05) `lock --check` exits 0 on all seven uv binaries.
 * A reader that only matches bare keys sees no group at all and reports the group as missing.
 */
const MANIFEST_KEY_ARRAY_OPEN = /^[ \t]*("(?:[^"]*)"|'(?:[^']*)'|[A-Za-z0-9_-]+)\s*=\s*\[/gm;
/** A TOML table key as written, quoted or not, read as the name it denotes. */
const tableKey = (raw) => unquote(raw);

/** True when a run failure is uv refusing a lock that no longer matches its project metadata. */
function isLockDrift(error) {
  if (!error) return false;
  const text = `${error.stderr || ""}\n${error.message || ""}`;
  return DRIFT_SIGNATURE.test(text) && !STALENESS_REASONS.test(text);
}

function canonicalName(name) {
  return String(name).replace(/[-_.]+/g, "-").toLowerCase();
}

/**
 * Index just past the closing quote of the string that starts at `at`.
 *
 * Triple quotes are TOML's multi-line string: `dependencies = ["""pypdf==6.4.1"""]` is ordinary TOML
 * and uv accepts it, so a reader that stops at the second `"` reads an empty requirement instead.
 */
function stringEnd(text, at) {
  const quote = text[at];
  const triple = quote.repeat(3);
  if (text.startsWith(triple, at)) {
    for (let index = at + 3; index < text.length; index += 1) {
      if (text[index] === "\\") { index += 1; continue; }
      if (text.startsWith(triple, index)) return index + 3;
    }
    return text.length;
  }
  for (let index = at + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === quote) return index + 1;
  }
  return text.length;
}

/**
 * Index of the bracket that closes the bracket at `open`.
 *
 * `dependencies = ["mcp[cli]==2.2.0", "pypdf==6.4.1"]` ends at the last `]`, not at the one inside
 * `mcp[cli`: the bracket inside the quoted string is part of the requirement, not of the array.
 * Parentheses count too — `mcp(cli)==2.2.0` closes at its `)`, so the requirement is read as a
 * requirement instead of being reported as an unclosed array.
 */
function bracketEnd(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "#") {
      const newline = text.indexOf("\n", index);
      index = newline === -1 ? text.length : newline;
      continue;
    }
    if (char === '"' || char === "'") { index = stringEnd(text, index) - 1; continue; }
    if (char === "[" || char === "{" || char === "(") depth += 1;
    else if (char === "]" || char === "}" || char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Split the inside of an array or inline table at its top-level commas, keeping nested items whole. */
function topLevelItems(inner) {
  const items = [];
  let depth = 0;
  let current = "";
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === "#") {
      const newline = inner.indexOf("\n", index);
      index = newline === -1 ? inner.length : newline;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = stringEnd(inner, index);
      current += inner.slice(index, end);
      index = end - 1;
      continue;
    }
    if (char === "[" || char === "{" || char === "(") depth += 1;
    else if (char === "]" || char === "}" || char === ")") depth -= 1;
    if (char === "," && depth === 0) { items.push(current); current = ""; continue; }
    current += char;
  }
  if (current.trim()) items.push(current);
  return items.map((item) => item.trim()).filter(Boolean);
}

/** The fields of `{ name = "mcp", extras = ["cli"], marker = "…", specifier = "==2.2.0" }`, in any order. */
function inlineTable(text) {
  const open = text.indexOf("{");
  if (open === -1) return {};
  const close = bracketEnd(text, open);
  if (close === -1) throw new Error(`inline table is not closed: ${text.slice(0, 60)}`);
  const fields = {};
  for (const item of topLevelItems(text.slice(open + 1, close))) {
    const assignment = item.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (assignment) fields[assignment[1]] = assignment[2].trim();
  }
  return fields;
}

function unquote(value) {
  const text = String(value).trim();
  const tripleBasic = text.match(/^"""([\s\S]*?)"""/);
  if (tripleBasic) return tripleBasic[1].trim();
  const tripleLiteral = text.match(/^'''([\s\S]*?)'''/);
  if (tripleLiteral) return tripleLiteral[1].trim();
  const basic = text.match(/^"([^"]*)"/);
  if (basic) return basic[1];
  const literal = text.match(/^'([^']*)'/);
  if (literal) return literal[1];
  return text;
}

function extrasFrom(value) {
  const text = String(value).trim();
  if (!text.startsWith("[") && !text.startsWith("(")) return [text].map((item) => canonicalName(unquote(item)));
  const close = bracketEnd(text, 0);
  if (close === -1) throw new Error(`extras ${text.slice(0, 60)} are not closed`);
  return topLevelItems(text.slice(1, close)).map((item) => canonicalName(unquote(item))).filter(Boolean);
}

/**
 * `mcp[cli]==2.2.0; python_version >= '3.13'` -> name `mcp`, extras `["cli"]`, specifier `==2.2.0`,
 * marker `python_version >= '3.13'`. uv keeps the marker in its own key, so the marker is separated
 * here instead of being left glued onto the specifier.
 */
function splitRequirement(text) {
  const raw = String(text).trim();
  const match = raw.match(/^[A-Za-z0-9][A-Za-z0-9._-]*/);
  if (!match) throw new Error(`cannot read a package name from requirement ${JSON.stringify(text)}`);
  let rest = raw.slice(match[0].length).trim();
  let extras = [];
  if (rest.startsWith("[") || rest.startsWith("(")) {
    const close = bracketEnd(rest, 0);
    if (close === -1) throw new Error(`extras of requirement ${JSON.stringify(text)} are not closed`);
    extras = extrasFrom(rest.slice(0, close + 1));
    rest = rest.slice(close + 1).trim();
  }
  const markerAt = rest.indexOf(";");
  const specifier = markerAt === -1 ? rest : rest.slice(0, markerAt);
  const marker = markerAt === -1 ? "" : rest.slice(markerAt + 1).trim();
  return { name: canonicalName(match[0]), extras, specifier: specifier.trim(), marker };
}

/**
 * Split a marker on a boolean word, ignoring the word inside a quoted value.
 *
 * `python_version >= '3.13' or os_name == 'posix'` splits into two clauses; a value containing the
 * word does not split it.
 */
function splitMarker(text, separator) {
  const parts = [];
  let start = 0;
  let quote = null;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (text.startsWith(separator, index)) {
      const before = index ? text[index - 1] : "";
      const after = text[index + separator.length] || "";
      if (!/[A-Za-z0-9_.]/.test(before) && !/[A-Za-z0-9_.]/.test(after)) {
        parts.push(text.slice(start, index));
        index += separator.length;
        start = index;
        continue;
      }
    }
    index += 1;
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * The `python_version` interval model.
 *
 * `python_version` only ever holds `major.minor`, so a `python_version` constraint is a set of
 * `major.minor` points, and uv rewrites it into `python_full_version` bounds selecting the same
 * points. Measured on this host with uv 0.13.6 (`uv lock` on a probe project, then `uv lock --check`
 * on what it wrote — exit 0 for every row), the spelling uv settles on is:
 *
 *   python_version ~= '3.12'          -> python_full_version >= '3.12' and python_full_version < '4'
 *   python_version in '3.12 3.13'     -> python_full_version >= '3.12' and python_full_version < '3.14'
 *   python_version in '3.12 3.14'     -> python_full_version == '3.12.*' or python_full_version == '3.14.*'
 *   python_version not in '3.12 3.14' -> python_full_version < '3.12' or python_full_version == '3.13.*'
 *                                        or python_full_version >= '3.15'
 *
 * That is a union of half-open `major.minor` intervals, adjacent intervals merged, printed bound by
 * bound. `scripts/lockintegrity.py`'s `_python_version_expansion` is the same model, and the two
 * readers have to agree on it: measured (adversarial pairs P42 and P43), a `~=` or `in` atom changed
 * on the manifest side is refused by every uv in the matrix (exit 2 on 0.5.0-0.7.22, exit 1 from 0.8.5
 * on), and a reader that skips those atoms certifies a pair uv rejects.
 */
const MINOR_POINT = /^(\d{1,2})(?:\.(\d{1,2}))?$/;
const minorPoint = (text) => {
  const match = MINOR_POINT.exec(String(text).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0)];
};
const nextMinor = (point) => [point[0], point[1] + 1];
/** uv prints `4` for `4.0` and `3.12` for `3.12`. */
const spellMinor = (point) => (point[1] === 0 ? `${point[0]}` : `${point[0]}.${point[1]}`);
const comparePoints = (left, right) => (left[0] - right[0]) || (left[1] - right[1]);

function mergeIntervals(intervals) {
  const kept = intervals.filter(([lo, hi]) => lo === null || hi === null || comparePoints(lo, hi) < 0);
  kept.sort((a, b) => {
    if (a[0] === null && b[0] === null) return 0;
    if (a[0] === null) return -1;
    if (b[0] === null) return 1;
    return comparePoints(a[0], b[0]);
  });
  const merged = [];
  for (const [lo, hi] of kept) {
    if (merged.length) {
      const [, previousHi] = merged[merged.length - 1];
      if (previousHi === null) continue;
      if (lo === null || comparePoints(previousHi, lo) >= 0) {
        merged[merged.length - 1] = [merged[merged.length - 1][0], hi === null || comparePoints(previousHi, hi) < 0 ? hi : previousHi];
        continue;
      }
    }
    merged.push([lo, hi]);
  }
  return merged;
}

function complementIntervals(intervals) {
  const out = [];
  let cursor = null;
  for (const [lo, hi] of intervals) {
    if (lo === null) { cursor = hi; continue; }
    out.push([cursor, lo]);
    cursor = hi;
  }
  if (cursor !== null) out.push([cursor, null]);
  return out;
}

/** One conjunction of `python_full_version` atoms per interval, in uv's own spelling, or null. */
function spellIntervals(intervals) {
  const groups = [];
  for (const [lo, hi] of intervals) {
    if (lo === null && hi === null) continue;
    if (lo === null) groups.push([`python_full_version < '${spellMinor(hi)}'`]);
    else if (hi === null) groups.push([`python_full_version >= '${spellMinor(lo)}'`]);
    else if (comparePoints(hi, nextMinor(lo)) === 0) {
      // uv writes the point in full here: `python_version in '3 3.12'` measures as
      // `python_full_version == '3.0.*' or python_full_version == '3.12.*'`, not `== '3.*'`.
      groups.push([`python_full_version == '${lo[0]}.${lo[1]}.*'`]);
    }
    else groups.push([`python_full_version >= '${spellMinor(lo)}'`, `python_full_version < '${spellMinor(hi)}'`]);
  }
  // Measured with uv 0.13.6 (`python_version not in '3.12 4'`): uv parenthesises a multi-atom clause
  // inside a disjunction and spells its upper bound `python_full_version < '4.0'` there, while the same
  // bound in a single clause (`python_version ~= '3.12'`) comes out as `python_full_version < '4'`. A
  // disjunction containing a conjunction is not reproducible from the interval model.
  if (groups.length > 1 && groups.some((group) => group.length > 1)) return null;
  return groups;
}

/** A `~=`, `in` or `not in` `python_version` atom as uv's own conjunctions, or null when unmodelled. */
function pythonVersionExpansion(operator, value) {
  if (operator === "~=") {
    const components = String(value).split(".");
    // Measured with uv 0.13.6: `~= '3.12'` locks as `>= '3.12' and < '4'`, `~= '3.12.1'` locks as
    // `python_version < '0'`, and `~= '3'` locks with the marker dropped altogether.
    if (components.length !== 2 || !components.every((part) => /^\d+$/.test(part))) return null;
    const low = minorPoint(value);
    if (!low) return null;
    return spellIntervals([[low, [low[0] + 1, 0]]]);
  }
  const points = [];
  for (const item of String(value).split(/[\s,]+/)) {
    if (!item) continue;
    const point = minorPoint(item);
    if (!point) return null;
    points.push(point);
  }
  if (!points.length) return null;
  let intervals = mergeIntervals(points.map((point) => [point, nextMinor(point)]));
  if (operator === "not in") intervals = complementIntervals(intervals);
  const groups = spellIntervals(intervals);
  return groups === null ? null : (groups.length ? groups : [[]]);
}

/**
 * One `name operator 'value'` atom in the form uv writes it, or null when this reader does not model it.
 *
 * A plain atom comes back as a string. A `~=`, `in` or `not in` `python_version` atom comes back as an
 * array of conjunctions — uv's own rewrite of it — which `markerKey` distributes over the rest of the
 * clause, because uv expands those three into a disjunction over `python_full_version` bounds.
 */
function markerAtom(atom) {
  const match = atom.trim().match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*(<=|>=|==|!=|~=|not in|in|<|>)\s*(['"])(.*?)\3$/);
  if (!match) return null;
  const variable = match[1].toLowerCase();
  const operator = match[2];
  const value = match[4];
  if (variable === "extra") return `extra ${operator} '${canonicalName(value)}'`;
  if (variable !== "python_version") return `${variable} ${operator} '${value}'`;
  if (operator === "~=" || operator === "in" || operator === "not in") return pythonVersionExpansion(operator, value);
  const components = value.split(".");
  if (!components.every((part) => /^\d+$/.test(part)) || components.length > 3) return null;
  // `python_version` holds `major.minor`, so uv compares that point against the bound the way PEP 440
  // compares versions — `3.12` equals `3.12.0` and is below `3.12.2` — and prints the bounds of the
  // minors that survive. Measured with uv 0.13.6 on a probe project (`uv lock`, then `uv lock --check`
  // on what it wrote, exit 0 for every row):
  //
  //     >= '3.12'   -> >= '3.12'      >= '3.12.0' -> >= '3.12'     >= '3.12.2' -> >= '3.13'
  //     >= '4.0.0'  -> >= '4'         >  '3'       -> >= '3.1'      >  '3.12.0' -> >= '3.13'
  //     <  '3.13.0' -> <  '3.13'      <  '3.13.1'  -> <  '3.14'     <= '3'      -> <  '3.1'
  //     <= '3.12.0' -> <  '3.13'      == '3'       -> == '3.0.*'    == '3.13.0' -> == '3.13.*'
  //     != '3.13.0' -> != '3.13.*'
  //
  // A `==` or `!=` against a three-component bound is left unmodelled: measured, uv 0.13.6 writes
  // `python_version < '0'` for `== '3.12.1'` and drops the requirement's marker altogether for
  // `!= '3.12.1'`. `scripts/lockintegrity.py`'s `_normalize_marker_atom` is the same function.
  const major = Number(components[0]);
  const minor = components.length > 1 ? Number(components[1]) : 0;
  const patch = components.length > 2 ? Number(components[2]) : 0;
  const point = spellMinor([major, minor]);
  const above = spellMinor([major, minor + 1]);
  const lower = patch > 0 ? above : point;
  if (operator === ">=") return `python_full_version >= '${lower}'`;
  if (operator === ">") return `python_full_version >= '${above}'`;
  if (operator === "<") return `python_full_version < '${lower}'`;
  if (operator === "<=") return `python_full_version < '${above}'`;
  if (patch > 0) return null;
  if (operator === "==") return `python_full_version == '${major}.${minor}.*'`;
  return `python_full_version != '${major}.${minor}.*'`;
}

/**
 * A marker in uv's own spelling, or null when this reader cannot model it.
 *
 * A conjunction is a SET of atoms and the clauses of a disjunction are a set too. Measured with uv
 * 0.13.6 (adversarial pair P41): a manifest writing `platform_machine == 'x86_64' and os_name ==
 * 'posix'` beside the lock uv wrote, which records `os_name == 'posix' and platform_machine ==
 * 'x86_64'`, passes `lock --check` at exit 0 on all seven uv binaries. Sorting the atoms is what makes
 * that pair read as the pair uv wrote; hoisting only the Python clause to the front did not.
 *
 * A parenthesised marker is left unmodelled — uv writes `python_full_version >= '3.13' or
 * (implementation_name == 'cpython' and os_name == 'posix')` for a manifest that never used
 * parentheses (adversarial pair P44, `lock --check` exit 0), and this reader does not re-associate a
 * boolean expression it has not measured.
 */
function markerKey(marker) {
  const raw = String(marker || "").trim();
  if (!raw) return "";
  if (/[()[\]]/.test(raw)) return null;
  const clauses = [];
  for (const orClause of splitMarker(raw, "or")) {
    const atoms = [];
    const expansions = [];
    for (const atom of splitMarker(orClause, "and")) {
      const normalized = markerAtom(atom);
      if (normalized === null) return null;
      if (Array.isArray(normalized)) expansions.push(normalized);
      else atoms.push(normalized);
    }
    if (expansions.length > 1) return null;
    if (expansions.length === 1) {
      for (const extra of expansions[0]) clauses.push([...atoms, ...extra].sort());
    } else {
      clauses.push([...atoms].sort());
    }
  }
  if (!clauses.length) return null;
  return [...new Set(clauses.map((clause) => clause.join(" and ")))].sort().join(" or ");
}

/** The part of a requirement identity that is not its marker: canonical name, extras and specifier. */
function requirementBaseKey(item) {
  const extras = [...new Set((item.extras || []).map(canonicalName))].sort();
  const extrasPart = extras.length ? `[${extras.join(",")}]` : "";
  return `${canonicalName(item.name)}${extrasPart} ${specifierKey(item.specifier)}`;
}

/**
 * The key a requirement is compared on: canonical name, sorted extras, the specifier as the set of its
 * bounds, and the marker in uv's own spelling. The marker is part of the requirement — uv 0.13.6
 * refuses a lock whose recorded marker is not the manifest's — but it is compared after uv's rewrite,
 * never as the raw text the manifest wrote.
 */
function requirementKey(item) {
  const marker = markerKey(item.marker);
  const markerPart = marker ? ` ; ${marker}` : "";
  return `${requirementBaseKey(item)}${markerPart}`.trim();
}

/**
 * The marker uv gives an `[project.optional-dependencies]` entry in `requires-dist`: the group's own
 * `extra == '<group>'`, appended after whatever marker the manifest wrote, with the group name
 * canonicalised the way uv canonicalises it (`cli_tools` -> `extra == 'cli-tools'`).
 */
function extraMarker(marker, group) {
  const own = String(marker || "").trim();
  const extra = `extra == '${canonicalName(group)}'`;
  return own ? `${own} and ${extra}` : extra;
}

/**
 * A requirement specifier as the SET of its bounds, whitespace dropped.
 *
 * A specifier is compared as the set of parsed bounds uv reads out of it, not as the text the manifest
 * wrote. Measured on this host against the shipped worker pair (adversarial pair P63) and a probe pair
 * (P01): the manifest writes `pypdf<7,>=6.4` and `packaging<25,>=24.0`, and uv 0.13.6 writes
 * `specifier = ">=6.4,<7"` and `">=24.0,<25"` — the order **uv itself writes** — and `uv-0.13.6
 * lock --check` exits 0 on 0.6.10, 0.7.22, 0.8.5, 0.9.30, 0.10.7 and 0.13.6, and `uv-0.5.0
 * sync --locked --python 3.12` exits 0. Comparing the two texts calls the pair this toolkit ships stale,
 * which is what made `scripts/build_worker_bundle.py` refuse to build it.
 *
 * A strict subset or superset is still a different set, so the pairs uv really refuses stay refused:
 * manifest `>=24.0` against lock `>=24.0,<25` (P02) and manifest `<25,>=24.0,!=24.1` against the same
 * lock (P03) are both exit 2 on 0.5.0-0.7.22 and exit 1 from 0.8.5 on. Each bound is kept verbatim — uv
 * writes `===6.4.1`, `~=6.4.1` and `>=6.4.1,!=6.5.0` back unchanged — so a bound's own text is not
 * normalised. `scripts/lockintegrity.py`'s `_normalize_specifier` is the same function.
 */
function specifierKey(specifier) {
  const bounds = String(specifier === undefined || specifier === null ? "" : specifier)
    .split(",")
    .map((part) => part.replace(/\s+/g, ""))
    .filter(Boolean);
  return [...new Set(bounds)].sort().join(",");
}

const pinKey = (item) => `${item.name}@${item.version}`;

/** The raw inner text of `key = [ … ]` in `block`, or null when the key is absent. */
function arrayInner(block, key, label) {
  const match = block.match(keyArrayOpen(key));
  if (!match) return null;
  const open = match.index + match[0].length - 1;
  const close = bracketEnd(block, open);
  if (close === -1) throw new Error(`${label} ${key} array is not closed`);
  return block.slice(open + 1, close);
}

/**
 * The part of a block that belongs to one table: from its header to the next table header.
 *
 * `requires-dev` ends at `[package.metadata.conditions]`, not at the end of the package block, so a
 * key of the following sub-table is never read as another dependency group.
 */
function tableBlock(block, header) {
  const match = block.match(header);
  if (!match) return null;
  const rest = block.slice(match.index + match[0].length);
  const end = rest.search(TABLE_HEADER);
  return end === -1 ? rest : rest.slice(0, end);
}

/** One `[[package]]` entry: its text span plus the keys uv writes before any sub-table. */
function packageHead(block) {
  const head = { name: null, version: null, local: false, mode: null, path: null };
  const seen = new Set();
  for (const raw of block.split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // A sub-table header ends the package's own keys, so a `name = "…"` inside `requires-dist`
    // is never mistaken for the package entry itself.
    if (line.startsWith("[")) break;
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const [, key, value] = assignment;
    // TOML forbids a key twice in one table and uv's parser agrees. Measured (adversarial pair P29),
    // a `[[package]]` block carrying `version` twice makes every uv in the matrix answer "Failed to
    // parse `uv.lock`" (exit 2 from 0.6.10 on, exit 1 on 0.5.0). A reader that keeps the first value
    // certifies a lock no uv can open.
    if (seen.has(key)) throw new Error(`lockfile [[package]] entry repeats the key ${JSON.stringify(key)} — uv cannot parse this lock`);
    seen.add(key);
    if (key === "name") head.name = unquote(value);
    else if (key === "version") head.version = unquote(value);
    else if (key === "source") {
      // The mode and the path are read, not just "is local": `editable` against a manifest with no
      // build-system, or a root entry pointing at a subdirectory, are both pairs uv refuses.
      const fields = inlineTable(value);
      for (const mode of ["editable", "virtual"]) {
        if (fields[mode] !== undefined) {
          head.local = true;
          head.mode = mode;
          head.path = normalizeSourcePath(unquote(fields[mode]));
          break;
        }
      }
    }
  }
  return head;
}

/**
 * `"./"` reads as `"."`: uv accepts both spellings of the project directory.
 *
 * Measured with uv 0.13.6 against the shipped worker lock (adversarial pair P31): rewriting the root
 * entry to `source = { editable = "./" }` leaves `lock --check` at exit 0 on every uv in the matrix and
 * `uv-0.5.0 sync --locked --python 3.12` at exit 0, while `editable = "packages/other-member"` is a
 * workspace member and is not this project's root. A trailing slash is the only difference uv does not
 * see, so it is the only difference this reader drops.
 */
function normalizeSourcePath(path) {
  const text = String(path);
  const stripped = text.replace(/\/+$/, "");
  return stripped || ".";
}

/**
 * The sdist and wheel filenames a `[[package]]` entry records.
 *
 * uv checks them against the entry's own `version` while it parses the lock: a hand-edited pin leaves
 * the filenames behind, and uv answers "The entry for package `anyio` (4.15.0) has wheel
 * `anyio-4.15.1-py3-none-any.whl` with inconsistent version" (exit 2). An entry that lists no
 * artifacts at all is ordinary — uv accepts a lock with the sdist and wheels lists removed.
 */
function packageArtifacts(block) {
  const names = [];
  const collect = (open) => {
    const close = bracketEnd(block, open);
    if (close === -1) return;
    for (const url of block.slice(open, close).matchAll(/url = "([^"]+)"/g)) {
      const file = url[1].split("?")[0].split("/").pop();
      if (file) names.push(decodeURIComponent(file));
    }
  };
  const sdist = block.match(/^[ \t]*sdist\s*=\s*\{/m);
  if (sdist) collect(sdist.index + sdist[0].length - 1);
  const wheels = block.match(/^[ \t]*wheels\s*=\s*\[/m);
  if (wheels) collect(wheels.index + wheels[0].length - 1);
  return names;
}

/** `(name, version)` read out of an sdist or wheel filename, or null when no version is readable. */
function artifactIdentity(filename) {
  if (/\.whl$/.test(filename)) {
    const parts = filename.slice(0, -4).split("-");
    if (parts.length < 5) return null;
    return { name: parts[0], version: parts[1] };
  }
  const match = filename.match(/^(.+?)-(.+?)\.(?:tar\.gz|tar\.bz2|tar\.xz|tar|zip)$/);
  if (!match) return null;
  return { name: match[1], version: match[2] };
}

/**
 * A version compared the way uv compares it: canonical PEP 440, or null when the text is not a version.
 *
 * uv normalises the ROOT version it writes and only the root version. Measured with uv 0.13.6: a
 * manifest declaring `version = "1.0.0.0"` locks as `version = "1.0"` and `uv lock --check` exits 0.
 * The spellings uv absorbs, each measured on this host against a lock uv itself wrote (adversarial
 * pairs): a leading `v` (`"v1.0.0"` against `"1.0.0"`, P12, exit 0 on all seven), a zero-padded
 * component (`"1.0.00"` against `"1.0.0"`, P13, exit 0 on all seven) and the dash spelling of a post
 * release (`"1.0-1"` against `"1.0.post1"`, P11, exit 0 on all seven).
 *
 * What it does NOT absorb: the epoch and the local segment. A lock root version of `1!0.3.7` (P15) or
 * `0.3.7+local` (P14) beside a manifest `0.3.7` is refused by every uv in the matrix (exit 2 on
 * 0.5.0-0.7.22, exit 1 from 0.8.5 on), and stripping them read those pairs as clean. A real drift —
 * 0.3.4 against 0.3.7, the defect this release exists to catch — is still a different canonical form.
 * `scripts/lockintegrity.py`'s `_normalize_pep440` is the same normalisation.
 */
const PEP440 = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\d+)?)?(?:-(\d+)|[-_.]?(post|rev|r)[-_.]?(\d+)?)?(?:[-_.]?(dev)[-_.]?(\d+)?)?(?:\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$/i;
const PRE_LABELS = { alpha: "a", a: "a", beta: "b", b: "b", preview: "rc", pre: "rc", c: "rc", rc: "rc" };

function versionKey(version) {
  const text = String(version === null || version === undefined ? "" : version).trim();
  const match = PEP440.exec(text);
  if (!match) return null;
  const epoch = match[1];
  const release = match[2];
  const preLabel = match[3];
  const preNumber = match[4];
  const postNumber = match[5];
  const postLabel = match[6];
  const postNumber2 = match[7];
  const devLabel = match[8];
  const devNumber = match[9];
  const local = match[10];
  const parts = release.split(".").map(Number);
  while (parts.length > 1 && parts[parts.length - 1] === 0) parts.pop();
  let out = parts.join(".");
  if (epoch) out = `${Number(epoch)}!${out}`;
  if (preLabel) out += `${PRE_LABELS[preLabel.toLowerCase()]}${preNumber === undefined ? 0 : Number(preNumber)}`;
  if (postNumber !== undefined || postLabel) {
    out += `.post${postNumber !== undefined ? Number(postNumber) : Number(postNumber2 === undefined ? 0 : postNumber2)}`;
  }
  if (devLabel) out += `.dev${devNumber === undefined ? 0 : Number(devNumber)}`;
  if (local) out += `+${local.toLowerCase().split(/[-_.]/).join(".")}`;
  return out;
}

/** Every `[[package]]` entry of a lockfile, with the span it occupies in the text. */
function lockPackageBlocks(lockText) {
  const source = String(lockText || "");
  const starts = [...source.matchAll(PACKAGE_HEADER)].map((match) => match.index);
  return starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : source.length;
    const block = source.slice(start, end);
    return { block, start, end, ...packageHead(block) };
  });
}

/**
 * Parse the `[[package]]` entries of a uv lockfile.
 *
 * Only the keys uv and this toolkit care about are read: the package name, its version, whether
 * its source is the project directory itself (`editable`/`virtual`), and the file's
 * `revision`/`requires-python`. Sub-tables such as `[package.metadata]` are skipped so that a
 * `name = "…"` line inside `requires-dist` is never mistaken for a package entry.
 */
function parseLock(text) {
  // A leading byte-order mark is what PowerShell 5.1's `Out-File -Encoding utf8` and older Notepad
  // write. uv reads such a file happily, so refusing it here would blame the user's editor as a
  // toolkit build defect.
  const source = String(text || "").replace(/^\uFEFF/, "");
  const blocks = lockPackageBlocks(source);
  if (!blocks.length) throw new Error("lockfile has no [[package]] entries");
  const headerRegion = source.slice(0, blocks[0].start);
  const topLevel = {};
  // `resolution-markers` is the fork set uv resolved the lock over; it is a multi-line array, so it is
  // read as an array and not as one more line-by-line scalar.
  const markersInner = arrayInner(headerRegion, "resolution-markers", "lockfile");
  if (markersInner !== null) topLevel.resolutionMarkers = topLevelItems(markersInner).map((item) => unquote(item));
  const manifestRecords = {};
  let currentTable = "";
  for (const raw of headerRegion.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(/^\[([^\]]+)\][ \t]*(#.*)?$/);
    if (header) { currentTable = header[1].replace(/\s+/g, ""); continue; }
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const [, key, value] = assignment;
    const scalar = value.replace(/#.*$/, "").trim();
    if (currentTable === "manifest") { manifestRecords[key] = true; continue; }
    if (key === "revision") {
      // `revision = 5.0` is a TOML float, and uv's reader wants an integer: measured (adversarial pair
      // P36), it is exit 2 from 0.6.10 on and exit 0 on 0.5.0. `Number("5.0")` is 5, so a reader that
      // only checks the number calls this lock current.
      if (!/^-?\d+$/.test(scalar)) {
        throw new Error(`lockfile revision ${JSON.stringify(scalar)} is not an integer — uv cannot read this lockfile`);
      }
      topLevel.revision = Number(scalar);
    }
    else if (key === "requires-python") topLevel.requiresPython = unquote(value);
    else if (key === "version" && topLevel.lockFormatVersion === undefined) topLevel.lockFormatVersion = Number(scalar);
    else if (key === "required-markers") topLevel.requiredMarkers = true;
  }
  return {
    ...topLevel,
    manifestRecords,
    packages: blocks.map((item) => ({
      name: item.name, version: item.version, local: item.local, mode: item.mode, path: item.path,
      start: item.start, end: item.end, artifacts: packageArtifacts(item.block),
      // `sdist = [ {…} ]` is not the shape uv writes (`sdist = { url = … }`) and uv cannot read it:
      // measured (adversarial pairs P25 and P25d), every uv in the matrix exits 2 — "Failed to parse
      // `uv.lock`" from 0.6.10 on, "Failed to prepare distributions" on 0.5.0. An artifact form this
      // reader cannot parse is a problem, not an absence of artifacts.
      sdistList: /^[ \t]*sdist\s*=\s*\[/m.test(item.block),
    })),
  };
}

/**
 * The root entry: the local (`editable`/`virtual`) package whose source points at the project
 * directory itself.
 *
 * A stray local entry — a leftover `[[package]]` for a member that is no longer in the workspace —
 * sits beside the root, and uv accepts the lock anyway (measured: exit 0). Taking the *first* local
 * entry would then compare the metadata of the wrong package, so the entries are filtered to the one
 * that points at `.` before anything is compared.
 */
function rootEntry(parsed) {
  const local = (parsed.packages || []).filter((item) => item.local);
  if (!local.length) throw new Error("lockfile has no editable/virtual root package entry");
  // Two local entries both pointing at the project directory: measured (adversarial pair P30),
  // duplicating the root block of the shipped worker lock makes every uv in the matrix answer
  // "Failed to parse `uv.lock`" (exit 2 on 0.6.10-0.13.6, exit 1 on 0.5.0). Picking the first one and
  // carrying on certifies a lock uv cannot open, and which entry is "the project" is not decidable.
  const roots = local.filter((item) => item.path === ROOT_SOURCE_PATH);
  if (roots.length > 1) {
    throw new Error(`lockfile has ${roots.length} local (editable/virtual) package entries all claiming the source path ".", `
      + `so this reader cannot tell which one is this project's root: ${roots.map((item) => `${item.name} (${item.mode} = ${JSON.stringify(item.path)})`).join(", ")}`);
  }
  return roots[0] || local[0];
}

/** The pins a lock holds, as `name@version`, excluding the project's own entry. */
function dependencyPins(parsed) {
  return new Set(parsed.packages.filter((item) => !item.local).map((item) => `${canonicalName(item.name)}@${item.version}`));
}

/**
 * The TOML validity a manifest has to have for uv to read it at all.
 *
 * `scripts/lockintegrity.py` gets these for free from `tomllib`, which raises on them; this reader
 * parses by hand, so it has to check them itself or it certifies a manifest uv cannot open. Measured
 * on this host against probe pairs whose lock uv itself wrote:
 *
 *   `[tool.uv]` declared twice (P19) and `version` declared twice in `[project]` (P20) are both
 *   refused by every uv in the matrix — `lock --check` exit 2 on 0.5.0-0.7.22 and exit 1 from 0.8.5 on,
 *   "Failed to parse `pyproject.toml`".
 *
 * Only tables a manifest declares at the top level are compared, and `[[array-of-table]]` headers are
 * exempt: a lockfile legitimately repeats `[[package]]`, and each of those blocks legitimately carries
 * its own `[package.metadata]`.
 */
function assertManifestTomlValidity(source) {
  const headerPattern = /^[ \t]*(\[[^\][\n]+\]|\[\[[^\][\n]+\]\])[ \t]*(#.*)?$/gm;
  const tables = new Map();
  const sections = [];
  for (const match of source.matchAll(headerPattern)) {
    if (match[1].startsWith("[[")) continue;
    const name = match[1].replace(/\s+/g, "");
    tables.set(name, (tables.get(name) || 0) + 1);
    if (tables.get(name) > 1) {
      throw new Error(`pyproject.toml declares table ${match[1]} twice — uv answers "Failed to parse \`pyproject.toml\`" for this manifest`);
    }
    sections.push({ name, start: match.index + match[0].length });
  }
  sections.forEach((section, index) => {
    const end = index + 1 < sections.length ? sections[index + 1].start : source.length;
    const keys = new Set();
    let depth = 0;
    for (const raw of source.slice(section.start, end).split(/\r?\n/)) {
      const line = depth === 0 ? raw : raw.trim();
      if (depth === 0) {
        const assignment = line.match(/^[ \t]*("(?:[^"]*)"|'[^']*'|[A-Za-z0-9_.-]+)[ \t]*=/);
        if (assignment) {
          const key = tableKey(assignment[1]);
          if (keys.has(key)) {
            throw new Error(`pyproject.toml declares ${JSON.stringify(key)} twice in ${section.name} — uv answers "Failed to parse \`pyproject.toml\`" for this manifest`);
          }
          keys.add(key);
        }
      }
      for (const char of raw) {
        if (char === "[" ) depth += 1;
        else if (char === "]") depth = Math.max(0, depth - 1);
      }
    }
  });
}

/**
 * Read the fields of a pyproject.toml this toolkit writes. Deliberately narrow: an unexpected
 * shape throws instead of guessing, because a silent guess is how a drifted pair gets shipped.
 * `pairProblems` — the function the shipped runtime calls — turns a throw into a reported problem.
 */
function parsePyproject(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
  assertManifestTomlValidity(source);
  const section = (name) => {
    const header = source.match(new RegExp(`^[ \\t]*\\[${name}\\][ \\t]*(#.*)?$`, "m"));
    if (!header) return null;
    // Search after the header itself: a section is terminated by the *next* header, not by its own.
    const rest = source.slice(header.index + header[0].length);
    const end = rest.search(TABLE_HEADER);
    return end === -1 ? rest : rest.slice(0, end);
  };
  const project = section("project");
  if (!project) throw new Error("pyproject.toml has no [project] section");
  const scalar = (key) => {
    // TOML allows a literal string in single quotes, and a triple-quoted multi-line string. Reading
    // only basic strings would report the missing value as a version mismatch instead of reading the
    // manifest; reading `"""1.0.0"""` as an empty string does the same. Measured (adversarial pair
    // P18), a manifest writing `version = """1.0.0"""` beside the lock uv wrote for it passes
    // `lock --check` at exit 0 on all seven uv binaries.
    const match = project.match(new RegExp(`^[ \\t]*${key}\\s*=\\s*(?:"""([\\s\\S]*?)"""|"([^"]*)"|'([^']*)')`, "m"));
    if (!match) return null;
    if (match[1] !== undefined) return match[1];
    return match[2] !== undefined ? match[2] : match[3];
  };
  const stringArray = (block, key) => {
    const inner = arrayInner(block, key, "pyproject.toml");
    if (inner === null) return null;
    return topLevelItems(inner).map((item) => {
      if (item.startsWith('"') || item.startsWith("'")) return unquote(item);
      throw new Error(`pyproject.toml ${key} entry ${JSON.stringify(item.slice(0, 40))} is not a requirement string`);
    });
  };
  const declared = (stringArray(project, "dependencies") || []).map(splitRequirement);
  const dynamic = (stringArray(project, "dynamic") || []).map((item) => item.trim());
  const groups = section("dependency-groups");
  const dependencyGroups = {};
  if (groups) {
    for (const match of groups.matchAll(MANIFEST_KEY_ARRAY_OPEN)) {
      const open = match.index + match[0].length - 1;
      const close = bracketEnd(groups, open);
      if (close === -1) throw new Error("pyproject.toml dependency group array is not closed");
      dependencyGroups[tableKey(match[1])] = topLevelItems(groups.slice(open + 1, close)).map((item) => {
        // PEP 735 lets a group hold a dependency object instead of a requirement. The two spellings of a
        // group reference are not the same construct, and only one of them is a thing this reader can
        // compare — see `resolveGroup` and the group section of `pairProblems` for the measurements.
        if (item.startsWith("{") || item.startsWith('"{')) {
          const fields = inlineTable(item);
          if (fields["include-group"] !== undefined) return { kind: "include", group: unquote(fields["include-group"]) };
          if (fields.include !== undefined) return { kind: "legacy-include", group: unquote(fields.include) };
          return { kind: "unknown", raw: item };
        }
        if (item.startsWith('"') || item.startsWith("'")) return { kind: "requirement", requirement: splitRequirement(unquote(item)) };
        throw new Error(`pyproject.toml dependency group entry ${JSON.stringify(item.slice(0, 40))} is not a requirement string`);
      });
    }
  }
  // uv records `[project.optional-dependencies]` in the lock's `requires-dist` too, each entry with
  // `marker = "extra == '<group>'"`, and lists the group names in `provides-extras`. Comparing only
  // `dependencies` would call such a pair stale.
  const optional = section("project.optional-dependencies");
  const optionalDependencies = {};
  if (optional) {
    for (const match of optional.matchAll(MANIFEST_KEY_ARRAY_OPEN)) {
      const open = match.index + match[0].length - 1;
      const close = bracketEnd(optional, open);
      if (close === -1) throw new Error("pyproject.toml optional dependency group array is not closed");
      optionalDependencies[tableKey(match[1])] = topLevelItems(optional.slice(open + 1, close)).map((item) => {
        if (item.startsWith('"') || item.startsWith("'")) return splitRequirement(unquote(item));
        throw new Error(`pyproject.toml optional dependency entry ${JSON.stringify(item.slice(0, 40))} is not a requirement string`);
      });
    }
  }
  // `[tool.uv]` keys that change how uv resolves, and that neither reader here models. A manifest using
  // one is not certifiable as current: uv 0.13.6 refuses a lock whose recorded resolution was made
  // under `override-dependencies` while a reader that ignores that table calls the same pair clean, and
  // the runtime would then fall back to `--frozen` and install a resolution it cannot explain.
  const toolUv = section("tool\\.uv");
  const uvResolutionInputs = toolUv === null ? []
    : [...toolUv.matchAll(/^[ \t]*([A-Za-z0-9_-]+)\s*=/gm)].map((match) => match[1]);
  // `[tool.uv] package` decides the source mode uv records for the project, so its value matters, not
  // just its presence.
  const declaredPackage = toolUv === null ? null : toolUv.match(/^[ \t]*package\s*=\s*(true|false)\b/m);
  return {
    name: scalar("name"),
    version: scalar("version"),
    dynamic,
    requiresPython: scalar("requires-python"),
    dependencies: declared,
    optionalDependencies,
    groups: dependencyGroups,
    uvResolutionInputs,
    buildSystem: section("build-system") !== null,
    toolUvPackage: declaredPackage ? declaredPackage[1] === "true" : null,
  };
}

/**
 * The lone lower bound uv records for a project whose manifest declares no `requires-python`.
 *
 * Measured on this host with uv 0.5.0, 0.7.22, 0.9.30 and 0.13.6: such a project locks as
 * `requires-python = ">=3.12"` and uv then accepts that lock (uv 0.13.6 `lock --check` exit 0, warning
 * "No `requires-python` value found in the workspace. Defaulting to `>=3.12`"); given `--python 3.13` it
 * writes `>=3.13`. A single `>=` bound is therefore uv speaking for itself, and calling it drift would
 * refuse a pair uv wrote. Anything carrying an upper bound is a constraint the manifest no longer
 * declares, and stays drift (measured: exit 1). `scripts/lockintegrity.py` applies the same exception.
 */
const UV_DEFAULT_REQUIRES_PYTHON = /^>=[^,]+$/;
function isUvDefaultRequiresPython(constraint) {
  return UV_DEFAULT_REQUIRES_PYTHON.test(String(constraint || "").replace(/\s+/g, ""));
}

/**
 * The source mode uv records for the project root, measured with uv 0.13.6 and uv 0.5.0 on this host:
 * a manifest with a `[build-system]` locks as `editable = "."`, the same manifest without one locks as
 * `virtual = "."`, `[tool.uv] package = false` locks as `virtual` even with a build-system, and
 * `package = true` locks as `editable` even without one.
 */
function impliedSourceMode(project) {
  if (project.toolUvPackage === false) return "virtual";
  if (project.toolUvPackage === true) return "editable";
  return project.buildSystem ? "editable" : "virtual";
}

/**
 * Flatten a dependency group the way uv does before it writes `requires-dev`: an `include-group`
 * reference contributes the referenced group's own requirements (measured with uv 0.13.6: the manifest
 * `dev = ["pytest==8.4.2"]`, `test = [{ include-group = "dev" }]` locks as
 * `requires-dev.test = [{ name = "pytest", specifier = "==8.4.2" }]` and `lock --check` on that pair
 * exits 0, and `uv-0.5.0 sync --locked --python 3.12` on the same pair exits 0). Returns null for a
 * group this reader cannot model — a `{ include = … }` reference, which uv 0.13.6 refuses outright, an
 * object entry that is not a reference at all, or a reference to a group the manifest does not declare —
 * so the caller skips the group instead of reporting contents it cannot prove.
 */
function resolveGroup(entries, all, seen) {
  const requirements = [];
  for (const entry of entries) {
    if (entry.kind === "requirement") { requirements.push(entry.requirement); continue; }
    if (entry.kind !== "include") return null;
    const target = entry.group;
    if (!all[target] || seen.has(target)) return null;
    const nested = resolveGroup(all[target], all, new Set([...seen, target]));
    if (nested === null) return null;
    requirements.push(...nested);
  }
  return requirements;
}

/** `metadata.requires-dev` of the root entry, as requirement objects per group. */
function lockMetadataRequiresDevItems(lockText, entry) {
  const block = lockPackageBlock(lockText, entry);
  if (!block) return {};
  const table = tableBlock(block, /^\[package\.metadata\.requires-dev\][ \t]*(#.*)?$/m);
  if (table === null) return {};
  const groups = {};
  for (const match of table.matchAll(ANY_KEY_ARRAY_OPEN)) {
    const open = match.index + match[0].length - 1;
    const close = bracketEnd(table, open);
    if (close === -1) throw new Error("lockfile requires-dev group array is not closed");
    groups[match[1]] = lockRequirements(table.slice(open + 1, close));
  }
  return groups;
}

/** `metadata.requires-dev` of the root entry, as requirement keys per group. */
function lockMetadataRequiresDev(lockText, entry) {
  return Object.fromEntries(Object.entries(lockMetadataRequiresDevItems(lockText, entry))
    .map(([group, items]) => [group, items.map(requirementKey)]));
}

/**
 * The `[[package]]` block of the root entry, or null.
 *
 * A project named like a registry package — a project called `pypdf` that depends on `pypdf` — has
 * two blocks with the same name, and the metadata that matters is the local one. The entry from
 * `parseLock` carries the span it was read from, so the block is taken from that span; a hand-built
 * entry falls back to preferring the local/editable/virtual block, as `scripts/lockintegrity.py` does.
 */
function lockPackageBlock(lockText, entry) {
  if (!entry) return null;
  const source = String(lockText || "");
  if (Number.isInteger(entry.start) && Number.isInteger(entry.end)) {
    const block = source.slice(entry.start, entry.end);
    if (/^[ \t]*\[\[package\]\]/.test(block)) return block;
  }
  const want = canonicalName(entry.name || "");
  const matches = lockPackageBlocks(source).filter((item) => canonicalName(item.name || "") === want);
  if (!matches.length) return null;
  const local = Boolean(entry.local);
  return (matches.find((item) => Boolean(item.local) === local) || matches[0]).block;
}

/** Requirement objects out of a lock array of `{ name = … }` tables or plain requirement strings. */
function lockRequirements(inner) {
  const requirements = [];
  for (const item of topLevelItems(inner)) {
    if (item.startsWith("{")) {
      const fields = inlineTable(item);
      if (fields.name === undefined) continue;
      const parsed = splitRequirement(unquote(fields.name));
      const extras = fields.extras === undefined ? parsed.extras : [...parsed.extras, ...extrasFrom(fields.extras)];
      requirements.push({
        name: parsed.name,
        extras,
        specifier: fields.specifier === undefined ? "" : unquote(fields.specifier),
        marker: fields.marker === undefined ? "" : unquote(fields.marker),
      });
      continue;
    }
    if (item.startsWith('"') || item.startsWith("'")) requirements.push(splitRequirement(unquote(item)));
  }
  return requirements;
}

/** `metadata.requires-dist` of the root entry, as requirement objects read straight from the lock text. */
function lockMetadataRequirementItems(lockText, entry) {
  const block = lockPackageBlock(lockText, entry);
  if (!block) return [];
  const table = tableBlock(block, /^\[package\.metadata\][ \t]*(#.*)?$/m);
  if (table === null) return [];
  const inner = arrayInner(table, "requires-dist", "lockfile");
  if (inner === null) return [];
  return lockRequirements(inner);
}

/** `metadata.requires-dist` of the root entry, as comparison keys. */
function lockMetadataSpecifiers(lockText, entry) {
  return lockMetadataRequirementItems(lockText, entry).map(requirementKey);
}

/**
 * Requirements as `{ "name[extras] specifier": [[marker form, marker text], …] }`.
 *
 * The map is the shape both readers compare in, and it is deliberately two-layered. The key is the
 * requirement identity uv compares — name, extras and the specifier as a set of bounds — and the marker
 * hangs off it, because one identity can legitimately be recorded twice under two markers (a package
 * that is both a plain dependency and an extra member locks as two `requires-dist` entries). A
 * requirement written twice in the manifest with the same marker is ONE requirement: measured
 * (adversarial pair P04), `[project.dependencies] = ["packaging==24.0", "packaging==24.0"]` locks as a
 * single entry and `uv lock --check` on that pair exits 0 on all seven uv binaries, while counting the
 * duplicate reported drift for the pair uv wrote.
 *
 * The split matters for markers this reader cannot model. Comparing name+specifier+marker as one string
 * turns an unmodellable marker into "these are different requirements" and reports a specifier mismatch
 * that is not there; `scripts/lockintegrity.py`'s `_requirement_map_signature` compares identities only
 * and leaves markers to `markerDriftProblems`, which only speaks about markers it can compare. Measured
 * (adversarial pair P44), a manifest whose requirement carries no parentheses beside a lock whose
 * `requires-dist` entry records uv's own parenthesised expansion is accepted by uv (exit 0), and a
 * reader that compared whole keys called that pair stale.
 */
function requirementMap(items) {
  const map = new Map();
  for (const item of items) {
    const base = requirementBaseKey(item);
    const entry = [markerKey(item.marker), String(item.marker || "").trim()];
    const list = map.get(base) || [];
    if (!list.some(([marker, text]) => marker === entry[0] && text === entry[1])) list.push(entry);
    map.set(base, list);
  }
  return map;
}

/** Which requirements a map holds, and how many entries each one carries — the marker left out. */
function requirementSignature(map) {
  return [...map.entries()].map(([key, entries]) => `${key} #${entries.length}`).sort();
}

/** Report a requirement whose PEP 508 marker differs from the marker uv recorded. */
function markerDriftProblems(declared, locked, where) {
  const problems = [];
  for (const key of [...declared.keys()].filter((name) => locked.has(name)).sort()) {
    const mine = declared.get(key);
    const theirs = locked.get(key);
    // A marker this reader does not model — a `~=`, a parenthesised clause, a prefix version — is left
    // alone: guessing at it would call a pair uv accepts stale, and that stops the package build.
    if (mine.some(([marker]) => marker === null) || theirs.some(([marker]) => marker === null)) continue;
    const forms = (entries) => entries.map(([marker]) => marker).sort();
    if (JSON.stringify(forms(mine)) === JSON.stringify(forms(theirs))) continue;
    const spell = (entries) => entries.map(([, text]) => text ? JSON.stringify(text) : "no marker").sort().join(", ");
    problems.push(`lock ${where} ${key} carries ${spell(mine)} in the manifest but the lock records ${spell(theirs)} `
      + "— uv re-locks when a PEP 508 marker is added, removed or changed");
  }
  return problems;
}

/** `metadata.provides-extras` of the root entry, canonicalised, or null when the lock records none. */
function lockProvidesExtras(lockText, entry) {
  const block = lockPackageBlock(lockText, entry);
  if (!block) return null;
  const table = tableBlock(block, /^\[package\.metadata\][ \t]*(#.*)?$/m);
  if (table === null) return null;
  const inner = arrayInner(table, "provides-extras", "lockfile");
  if (inner === null) return null;
  return topLevelItems(inner).map((item) => canonicalName(unquote(item)));
}

/** The `{ name = … }` package names in one lock array of requirement tables. */
function requirementNames(inner) {
  const names = [];
  for (const item of topLevelItems(inner)) {
    if (!item.startsWith("{")) continue;
    const fields = inlineTable(item);
    if (fields.name !== undefined) names.push(canonicalName(unquote(fields.name)));
  }
  return names;
}

/** The keys of the `[[package]]` entry itself: from its header to the first sub-table header. */
function packageKeyBlock(block) {
  const afterHeader = block.slice(block.indexOf("\n") + 1);
  const end = afterHeader.search(TABLE_HEADER);
  return end === -1 ? afterHeader : afterHeader.slice(0, end);
}

/** Every `{ name = … }` name in every array of one `[package.…]` sub-table of a lock entry. */
function subTableNames(block, header, label) {
  const sub = tableBlock(block, header);
  if (sub === null) return [];
  const names = [];
  for (const match of sub.matchAll(ANY_KEY_ARRAY_OPEN)) {
    const open = match.index + match[0].length - 1;
    const close = bracketEnd(sub, open);
    if (close === -1) throw new Error(`${label} array is not closed`);
    names.push(...requirementNames(sub.slice(open + 1, close)));
  }
  return names;
}

/**
 * The `resolution-markers` coverage model.
 *
 * A lock's `resolution-markers` are the Python ranges uv forked the resolution over; every Python
 * version the lock's own `requires-python` declares has to fall inside at least one of them, and no
 * marker may select a Python version `requires-python` excludes. **A marker set that partitions the
 * declared range covers it, and a set that leaves a sub-range of the declared range with no marker, or
 * whose markers cannot intersect the declared range at all, does not.**
 *
 * Measured on this host against the shipped worker pair (and its marker-free twin P37b): its
 * `resolution-markers = ["python_full_version >= '3.14'", "python_full_version < '3.14'"]` cover every
 * version `requires-python = ">=3.12, <3.15"` declares, and `uv-0.13.6 lock --check` and
 * `uv-0.5.0 sync --locked --python 3.12` both exit 0 on that pair — so a reader that flagged the
 * shipped pair here would refuse the toolkit's own release. Measured against the same pair with the
 * first marker replaced by `python_full_version >= '3.20'` (adversarial pair P37), which selects
 * nothing the lock's `requires-python` allows, uv 0.9.30, 0.10.7 and 0.13.6 each answer exit 1.
 *
 * What is modelled is the Python range only: a marker holding a non-Python atom contributes the whole
 * line, because such a fork applies to every Python version. What is not modelled is a marker this
 * reader cannot read (a parenthesised clause, a `!=` bound) — such a marker is skipped rather than
 * guessed at, and a lock whose markers are all unreadable is not reported here at all.
 * `scripts/lockintegrity.py`'s `_resolution_marker_problems` is the same model.
 */
const PYTHON_MARKER_VARIABLES = /^(python_full_version|python_version)\b/;

/** The `major.minor` range one Python-version atom allows, as `[lo, hi]` with null for unbounded. */
function pythonAtomInterval(atom) {
  const match = atom.trim().match(/^(python_full_version|python_version)\s*(<=|>=|==|!=|<|>)\s*(.+)$/);
  if (!match) return null;
  const operator = match[2];
  const raw = match[3].trim().replace(/^['"]/, "").replace(/['"]$/, "");
  const prefix = raw.endsWith(".*");
  const point = minorPoint(prefix ? raw.slice(0, -2) : raw);
  if (!point) return null;
  if (operator === "==") return [point, nextMinor(point)];
  if (operator === "!=") return null;
  if (operator === ">=") return [point, null];
  if (operator === ">") return [nextMinor(point), null];
  if (operator === "<") return [null, point];
  return [null, nextMinor(point)];
}

/** The union of `major.minor` ranges a marker allows, or null when it holds an unreadable atom. */
function markerPythonIntervals(marker) {
  const text = String(marker || "").trim();
  if (!text) return [[null, null]];
  const union = [];
  for (const clause of splitMarker(text, "or")) {
    let interval = [null, null];
    let foundPython = false;
    for (const atom of splitMarker(clause, "and")) {
      const clean = atom.trim();
      if (!clean || "([".includes(clean[0])) return null;
      if (!PYTHON_MARKER_VARIABLES.test(clean)) continue;
      foundPython = true;
      const span = pythonAtomInterval(clean);
      if (span === null) return null;
      // A conjunction intersects: a clause keeps only the points every one of its atoms allows.
      const lo = interval[0] === null || (span[0] !== null && comparePoints(span[0], interval[0]) > 0) ? span[0] : interval[0];
      const hi = interval[1] === null || (span[1] !== null && comparePoints(span[1], interval[1]) < 0) ? span[1] : interval[1];
      interval = [lo, hi];
    }
    // A marker with no Python bound applies to every Python version.
    union.push(foundPython ? interval : [null, null]);
  }
  return mergeIntervals(union);
}

/** The `major.minor` range a `requires-python` declares, or null when it is not a plain range. */
function requiresPythonInterval(constraint) {
  let interval = [null, null];
  for (const bound of String(constraint === undefined || constraint === null ? "" : constraint).split(",")) {
    const clean = bound.replace(/\s+/g, "");
    if (!clean) continue;
    const match = clean.match(/^(<=|>=|<|>)(.+)$/);
    if (!match) return null;
    const raw = match[2];
    const point = minorPoint(raw.endsWith(".*") ? raw.slice(0, -2) : raw);
    if (!point) return null;
    if (match[1] === ">=") interval = [point, interval[1]];
    else if (match[1] === ">") interval = [nextMinor(point), interval[1]];
    else if (match[1] === "<") interval = [interval[0], point];
    else interval = [interval[0], nextMinor(point)];
  }
  return interval;
}

/** True when every point of `target` falls inside at least one of `intervals`. */
function intervalsCover(target, intervals) {
  const [, targetHi] = target;
  let cursor = target[0];
  for (const [lo, hi] of mergeIntervals([...intervals])) {
    if (cursor !== null && hi !== null && comparePoints(hi, cursor) <= 0) continue;
    if (lo !== null && (cursor === null || comparePoints(lo, cursor) > 0)) return false;
    if (hi === null) return true;
    cursor = hi;
    if (targetHi !== null && comparePoints(cursor, targetHi) >= 0) return true;
  }
  return targetHi === null || (cursor !== null && comparePoints(cursor, targetHi) >= 0);
}

/** Problems for a lock whose `resolution-markers` do not match its own `requires-python`. */
function lockResolutionMarkerProblems(lock, label) {
  const markers = lock.resolutionMarkers;
  if (!Array.isArray(markers) || !markers.length) return [];
  const target = requiresPythonInterval(lock.requiresPython);
  if (target === null) return [];
  const problems = [];
  const covered = [];
  for (const marker of markers) {
    if (typeof marker !== "string") continue;
    const intervals = markerPythonIntervals(marker);
    if (intervals === null) continue;
    covered.push(...intervals);
    const intersects = intervals.some(([lo, hi]) =>
      (lo === null || target[1] === null || comparePoints(lo, target[1]) < 0)
      && (hi === null || target[0] === null || comparePoints(hi, target[0]) > 0));
    if (!intersects) {
      problems.push(`${label}: resolution-marker ${JSON.stringify(marker)} cannot select any Python version the lock's `
        + `requires-python ${JSON.stringify(lock.requiresPython)} declares — uv resolved this lock under a fork its own requires-python excludes`);
    }
  }
  if (!problems.length && covered.length && !intervalsCover(target, covered)) {
    problems.push(`${label}: the lock's resolution-markers do not cover requires-python ${lock.requiresPython} `
      + "— uv resolved this lock under a fork set that leaves part of the declared Python range unresolved");
  }
  return problems;
}

/**
 * The names of the dependency edges uv resolved for the root entry: its own `dependencies` array plus
 * `[package.optional-dependencies]` and `[package.dev-dependencies]`.
 *
 * These are the entries uv looks up when it parses the lock. Delete the `[[package]]` block one of
 * them names and uv answers "Dependency `pypdf` has missing `source` field but has more than one
 * matching package" (exit 2) — a hand-edited lock that still lists the requirement in `requires-dist`
 * looks untouched to a metadata-only reader.
 */
function lockDependencyEdges(lockText) {
  const names = [];
  for (const item of lockPackageBlocks(String(lockText || ""))) names.push(...lockEntryEdges(item.block));
  return names;
}

/** The edges one `[[package]]` block resolves. */
function lockEntryEdges(block) {
  const names = requirementNames(arrayInner(packageKeyBlock(block), "dependencies", "lockfile") || "");
  for (const table of ["optional-dependencies", "dev-dependencies"]) {
    names.push(...subTableNames(block, new RegExp(`^\\[package\\.${table}\\][ \\t]*(#.*)?$`, "m"), `lockfile [package.${table}]`));
  }
  return names;
}

/**
 * True when a requirement's marker can never be satisfied, so uv resolves nothing for it.
 *
 * Measured with uv 0.13.6 (adversarial pair P45): a manifest whose plain `[project.dependencies]`
 * carries `packaging==24.0; extra == 'pdf'` while the manifest declares no `pdf` extra locks with
 * `requires-dist = [{ name = "packaging", marker = "extra == 'pdf'", specifier = "==24.0" }]` and NO
 * `[[package]]` entry for packaging, and `uv lock --check` on that pair exits 0 on all seven uv
 * binaries. The marker can never select the requirement, so demanding an entry for it reports a defect
 * uv does not have.
 */
function markerCanNeverSelect(marker, knownExtras) {
  const form = markerKey(marker);
  if (form === null || !form) return false;
  for (const clause of form.split(" or ")) {
    for (const atom of clause.split(" and ")) {
      const match = atom.trim().match(/^extra == '([^']*)'$/);
      if (match && !knownExtras.has(match[1])) return true;
    }
  }
  return false;
}

/**
 * The two halves of the root entry have to agree with each other.
 *
 * uv writes the distributions it resolved (`dependencies`, `[package.dev-dependencies]`) beside the
 * requirements those distributions came from (`[package.metadata] requires-dist`,
 * `[package.metadata.requires-dev]`). Measured with uv 0.13.6 on a `dynamic = ["dependencies"]` project
 * whose requirements uv read from `requirements.txt`: the pair uv wrote passes `lock --check` (exit 0),
 * and emptying `requires-dist` while the resolved half still names `iniconfig` and `packaging` makes it
 * exit 1 with uv's ordinary staleness sentence. That is the comparison that survives a manifest this
 * reader cannot resolve — the lock read against itself. `scripts/lockintegrity.py`'s
 * `_root_resolution_problems` is the same comparison, and both readers report it in the same words.
 */
function lockRootResolutionProblems(lockText, entry) {
  const block = lockPackageBlock(lockText, entry);
  if (!block) return [];
  const resolved = new Set([
    ...requirementNames(arrayInner(packageKeyBlock(block), "dependencies", "lockfile") || ""),
    ...subTableNames(block, /^\[package\.dev-dependencies\][ \t]*(#.*)?$/m, "lockfile [package.dev-dependencies]"),
  ]);
  const metadata = tableBlock(block, /^\[package\.metadata\][ \t]*(#.*)?$/m);
  const recorded = new Set(metadata === null
    ? []
    : requirementNames(arrayInner(metadata, "requires-dist", "lockfile") || ""));
  for (const name of subTableNames(block, /^\[package\.metadata\.requires-dev\][ \t]*(#.*)?$/m, "lockfile [package.metadata.requires-dev]")) recorded.add(name);
  const missing = [...resolved].filter((name) => !recorded.has(name)).sort();
  if (!missing.length) return [];
  return [`lock root package entry resolves ${missing.join(", ")} but its [package.metadata] records no such requirement — uv writes both halves of the root entry, and a lock whose resolved half names a distribution its metadata half does not record is not the lock uv wrote`];
}

const failure = (error) => (error && error.message ? String(error.message) : String(error));

/**
 * `[tool.uv]` keys that change what uv resolves to and that neither reader here models. Measured with
 * uv 0.13.6 against the shipped pair, changing only the manifest: `override-dependencies`,
 * `constraint-dependencies`, `sources`, `environments`, `required-environments` and `exclude-newer` each
 * make uv refuse the lock (exit 1) while a reader that ignores `[tool.uv]` calls the pair current.
 * `default-groups`, `index`, `default-index`, `find-links` and `no-build-isolation-package` were also
 * measured and uv accepted the lock unchanged, so flagging them would block a build uv is happy with.
 */
const UV_RESOLUTION_KEYS = new Set([
  "override-dependencies", "constraint-dependencies", "environments", "required-environments",
  "sources", "exclude-newer",
]);

/**
 * `[tool.uv]` key -> the key uv records that same input under in the lock it writes.
 *
 * Measured on this host, on probe projects whose `uv.lock` uv 0.13.6 wrote itself (adversarial pairs
 * P06, P07, P08): beside the lock it wrote, `override-dependencies` (the lock carries
 * `[manifest] overrides`), `constraint-dependencies` (`[manifest] constraints`) and
 * `required-environments` (top-level `required-markers`) all pass `uv lock --check` at exit 0 on
 * 0.6.10, 0.7.22, 0.8.5, 0.9.30, 0.10.7 and 0.13.6, and `uv-0.5.0 sync --locked --python 3.12` at exit
 * 0. Refusing them was a false alarm that blocked `npm run package` on a pair uv itself produced.
 * `environments` is NOT in this table: measured (adversarial pair P09), `environments = { "all" = {
 * marker = "sys_platform == 'linux'" } }` beside the lock uv wrote is refused by every uv in the
 * matrix (exit 2 on 0.5.0-0.7.22, exit 1 from 0.8.5 on), so it stays an input this reader cannot
 * certify. `scripts/lockintegrity.py`'s `UV_RECORDED_RESOLUTION_KEYS` is the same table.
 */
const UV_RECORDED_RESOLUTION_KEYS = {
  "override-dependencies": "overrides",
  "constraint-dependencies": "constraints",
  "required-environments": "required-markers",
};

/** Compare the `[tool.uv]` resolution inputs against what the lock records for them. */
function uvResolutionProblems(project, lock, label) {
  const declaredKeys = new Set(project.uvResolutionInputs || []);
  const recordedPresent = new Map();
  for (const [key, where] of Object.entries(UV_RECORDED_RESOLUTION_KEYS)) {
    const present = where === "required-markers" ? lock.requiredMarkers === true : lock.manifestRecords[where] === true;
    if (present) recordedPresent.set(key, where);
  }
  const problems = [];
  // A key uv records in the lock is certifiable; one it does not record is not.
  const certifiable = Object.keys(UV_RECORDED_RESOLUTION_KEYS);
  const unmodelled = [...declaredKeys].filter((key) => UV_RESOLUTION_KEYS.has(key) && !certifiable.includes(key)).sort();
  if (unmodelled.length) {
    problems.push(`${label}: pyproject declares [tool.uv] ${unmodelled.join(", ")}; this reader cannot model those resolution inputs, so the pair cannot be certified up to date`);
  }
  for (const key of [...declaredKeys].filter((key) => certifiable.includes(key)).sort()) {
    if (recordedPresent.has(key)) continue;
    problems.push(`${label}: pyproject declares [tool.uv] ${key} but the lock records no ${UV_RECORDED_RESOLUTION_KEYS[key]} for it `
      + "— measured on this host, uv refuses that pair (`lock --check` exit 1 on 0.8.5 through 0.13.6, exit 2 on 0.5.0 through 0.7.22)");
  }
  for (const [key, where] of [...recordedPresent].sort()) {
    if (declaredKeys.has(key)) continue;
    problems.push(`${label}: the lock records ${where} but pyproject declares no [tool.uv] ${key} `
      + "— measured on this host (adversarial pair P10), uv 0.5.0 through 0.13.6 all refuse that pair (`lock --check` exit 1)");
  }
  return problems;
}

/**
 * Every reason uv would call this lock stale for this project. An empty list means the pair is
 * current, which is what `uv sync --locked` requires.
 *
 * A pair this reader cannot read is a reported problem, never a thrown one: the shipped runtime
 * calls this while a setup is already running, and an exception there is reported to the user as a
 * toolkit crash instead of as the lock defect it is.
 */
function pairProblems(pyprojectText, lockText) {
  let project;
  let lock;
  let entry;
  try {
    project = parsePyproject(pyprojectText);
  } catch (error) {
    return [`pyproject.toml could not be read: ${failure(error)}`];
  }
  try {
    lock = parseLock(lockText);
    entry = rootEntry(lock);
  } catch (error) {
    return [`uv.lock could not be read: ${failure(error)}`];
  }
  try {
    const problems = [];

    if (canonicalName(entry.name || "") !== canonicalName(project.name || "")) {
      problems.push(`lock root package name ${entry.name} does not match pyproject name ${project.name}`);
    }
    if (project.dynamic.includes("version")) {
      if (entry.version !== null) problems.push(`pyproject declares a dynamic version but the lock records ${entry.version}`);
    } else if (versionKey(entry.version) !== versionKey(project.version)) {
      problems.push(`lock root package version ${entry.version} does not match pyproject version ${project.version}`);
    }
    // The root entry's source mode is part of the pair: uv re-locks a project whose recorded mode is
    // not the one its manifest implies, and refuses the pair under `--locked` (measured: `[tool.uv]
    // package = false` beside an `editable` lock is exit 1).
    const implied = impliedSourceMode(project);
    if (entry.mode !== implied) {
      const reason = implied === "editable"
        ? "the manifest declares a [build-system], so uv records the project as editable"
        : project.toolUvPackage === false
          ? "the manifest sets [tool.uv] package = false, so uv records the project as virtual"
          : "the manifest declares no [build-system], so uv records the project as virtual";
      problems.push(`lock root package source is ${entry.mode} = ${JSON.stringify(entry.path)} but ${reason} — uv would rewrite this entry when it re-locks`);
    }
    if (entry.path !== ROOT_SOURCE_PATH) {
      problems.push(`lock root package source path ${JSON.stringify(entry.path)} does not point at ${JSON.stringify(ROOT_SOURCE_PATH)}, the project directory the lockfile sits in`);
    }
    const normalize = (value) => String(value || "").replace(/\s+/g, "");
    // `requires-python` is compared in both directions. A lock that keeps a Python requirement the
    // manifest dropped is stale (uv 0.13.6: exit 1, after warning that it is defaulting), and a lock
    // that does not record one at all fails uv's parser outright (exit 2, "missing field
    // `requires-python`") — the same pair a reader that only compares two present values calls clean.
    // The two constraints are compared as the SET of their bounds, the same way the dependency
    // specifiers are: measured (adversarial pairs P64 and P51), a manifest writing
    // `requires-python = "<3.15,>=3.12"` beside the lock uv wrote, which records
    // `requires-python = ">=3.12, <3.15"`, passes `lock --check` at exit 0 on all seven uv binaries,
    // and comparing the two texts reported drift for the pair uv itself wrote.
    if (project.requiresPython !== null && lock.requiresPython === undefined) {
      problems.push(`pyproject declares requires-python ${JSON.stringify(project.requiresPython)} but the lockfile records none — uv refuses to parse such a lock`);
    } else if (project.requiresPython === null && lock.requiresPython !== undefined && !isUvDefaultRequiresPython(lock.requiresPython)) {
      problems.push(`pyproject declares no requires-python but the lock records ${JSON.stringify(lock.requiresPython)} — uv defaults the manifest to >=3.12 and calls the lock stale`);
    } else if (project.requiresPython !== null && lock.requiresPython !== undefined
      && specifierKey(project.requiresPython) !== specifierKey(lock.requiresPython)) {
      problems.push(`lock requires-python ${lock.requiresPython} does not match pyproject ${project.requiresPython}`);
    }
    // `dynamic` fields are resolved by the build backend, not by the manifest text, so the manifest half
    // of the comparison does not exist here. Measured with uv 0.13.6 on a project whose
    // `dynamic = ["dependencies"]` is filled in by `[tool.setuptools.dynamic] dependencies = { file =
    // ["requirements.txt"] }`: uv wrote `requires-dist` for the resolved set and `lock --check` on that
    // pair exited 0. Comparing an empty `[project.dependencies]` against it invents drift — which is what
    // this reader used to do, reporting `lock dependency specifiers iniconfig ==2.1.0, packaging ==24.0
    // do not match pyproject` for the pair uv itself wrote. `scripts/lockintegrity.py` skips the same
    // comparison for the same reason, and both readers fall back to the comparison that still works: the
    // lock against itself, in `lockRootResolutionProblems` below.
    const dynamicDependencies = project.dynamic.includes("dependencies");
    const dynamicOptional = project.dynamic.includes("optional-dependencies");
    const declaredItems = [
      ...project.dependencies,
      ...Object.entries(project.optionalDependencies || {}).flatMap(([group, items]) =>
        items.map((item) => ({ ...item, marker: extraMarker(item.marker, group) }))),
    ];
    const declared = requirementMap(declaredItems);
    const locked = requirementMap(lockMetadataRequirementItems(lockText, entry));
    if (!dynamicDependencies && !dynamicOptional
      && JSON.stringify(requirementSignature(declared)) !== JSON.stringify(requirementSignature(locked))) {
      const spell = (map) => [...map.keys()].sort().join(", ") || "(none)";
      problems.push(`lock dependency specifiers ${spell(locked)} do not match pyproject ${spell(declared)}`);
    }
    problems.push(...markerDriftProblems(declared, locked, "requirement"));
    // Optional dependency groups are a second drift surface: uv writes them into `requires-dist` with
    // an `extra ==` marker, and names the groups in `provides-extras`. Measured with uv 0.13.6: a
    // manifest that declares an extra beside a lock that records no `provides-extras` is refused
    // (exit 1) even when the `requires-dist` entries are there. A lock that omits the key is only
    // forgiven when the manifest declares nothing for it to name, or when the lock carries no `revision`
    // at all — uv 0.5.0 writes neither key (`sync --locked --python 3.12` on the pair it wrote exits 0),
    // so a lock without a `revision` is a receipt that its writer never recorded extras, not evidence of
    // a missing one. `scripts/lockintegrity.py` applies the same two exceptions.
    const declaredExtras = new Set(dynamicOptional ? [] : Object.keys(project.optionalDependencies || {}).map(canonicalName));
    const lockedExtras = lockProvidesExtras(lockText, entry);
    const lockedExtraSet = new Set(lockedExtras === null ? [] : lockedExtras);
    if (lockedExtras === null) {
      // `dynamic = ["optional-dependencies"]` resolved by the build backend still gets a
      // `provides-extras`: measured (adversarial pair P48) uv writes `provides-extras = ["pdf"]` for it
      // and accepts the pair (exit 0 on all seven uv binaries). So the key is expected here too, and
      // deleting it is drift uv refuses (adversarial pair P49: exit 2 on 0.6.10 and 0.7.22, exit 1 from
      // 0.8.5 on, exit 0 on 0.5.0 — which writes no `provides-extras` and no `revision` at all).
      if (dynamicOptional) {
        if (lock.revision !== undefined) {
          problems.push("lock carries a revision but records no provides-extras for a manifest that resolves its "
            + "optional-dependencies dynamically — uv 0.6.10 through 0.13.6 refuse this pair (measured: exit 2 on "
            + "0.6.10 and 0.7.22, exit 1 from 0.8.5 on)");
        }
      } else if (declaredExtras.size > 0 && lock.revision !== undefined) {
        problems.push(`lock provides-extras (key absent) does not match pyproject optional-dependencies ${[...declaredExtras].sort().join(", ") || "(none)"}`);
      }
    } else if (!dynamicOptional
      && (declaredExtras.size !== lockedExtraSet.size || [...declaredExtras].some((name) => !lockedExtraSet.has(name)))) {
      problems.push(`lock provides-extras ${[...lockedExtraSet].sort().join(", ") || "(none)"} does not match pyproject optional-dependencies ${[...declaredExtras].sort().join(", ") || "(none)"}`);
    }
    // The extra names a marker may legitimately test for: what the manifest declares plus what the lock
    // records. Used by `markerCanNeverSelect` below.
    const knownExtras = new Set([...declaredExtras, ...lockedExtraSet]);
    // uv records a project's dependency groups as `requires-dev`; a group added to the manifest without
    // a re-lock is the same class of drift as a dependency added to it. The two spellings of a PEP 735
    // group reference are not the same construct, and the measurements separate them (all four runs on
    // this host, in a temp copy of the shipped worker pair, `HOME=/data/dsh/home`,
    // `UV_CACHE_DIR=/tmp/uvcache`):
    //
    //   `test = [{ include-group = "dev" }]` beside the lock uv 0.13.6 wrote for it
    //     (`requires-dev.test = [{ name = "pytest", specifier = "==8.4.2" }]`): `lock --check` exit 0, and
    //     `uv-0.5.0 sync --locked --python 3.12` on the same pair exit 0. Beside a lock recording
    //     `test = []` the same manifest is refused: `lock --check` exit 1. So `include-group` flattens,
    //     exactly as `resolveGroup` flattens it, and a group that only looks empty against it is drift.
    //   `test = [{ include = "dev" }]` is refused by uv 0.13.6 whatever the lock says — `lock --check`
    //     exit 2, "Project `research-stack-basic` has malformed dependency groups / Group `test` contains
    //     an unknown dependency object specifier: {"include": "dev"}" — while uv 0.5.0 accepted it and
    //     locked the group as `test = []` (`sync --locked --python 3.12` exit 0). It is not a requirement,
    //     and no lock this toolkit can certify carries it, so it is named as a construct this reader
    //     cannot certify — the same wording it uses for an unmodelled `[tool.uv]` input — and its group
    //     is left out of the comparison, so the pair is not *also* reported as a group mismatch the
    //     reader cannot prove. Certifying it would let a manifest the pinned build uv (0.13.6) refuses
    //     through the packaging gate; calling it a group mismatch would blame the lock for what the
    //     manifest wrote.
    const declaredGroups = {};
    const unmodellable = new Set();
    const legacyIncludes = [];
    for (const [name, entries] of Object.entries(project.groups)) {
      for (const item of entries) {
        if (item.kind !== "include" && item.kind !== "legacy-include") continue;
        if (project.groups[item.group]) continue;
        problems.push(`pyproject dependency group ${name} includes ${JSON.stringify(item.group)}, which the manifest does not declare`);
      }
      const legacy = entries.filter((item) => item.kind === "legacy-include");
      if (legacy.length) legacyIncludes.push(...legacy.map((item) => [name, item.group]));
      const requirements = resolveGroup(entries, project.groups, new Set([name]));
      if (requirements === null) unmodellable.add(name);
      else declaredGroups[name] = requirementMap(requirements);
    }
    for (const [name, target] of legacyIncludes) {
      problems.push(`pyproject dependency group ${name} declares { include = ${JSON.stringify(target)} }; this reader cannot certify that group-reference spelling — measured on this host, uv 0.13.6 refuses the manifest (lock --check exit 2, contains an unknown dependency object specifier) and uv 0.5.0 accepted it and locked the group as empty, so the pair cannot be certified up to date`);
    }
    const lockedGroups = Object.fromEntries(Object.entries(lockMetadataRequiresDevItems(lockText, entry))
      .map(([key, items]) => [key, requirementMap(items)]));
    const groupNames = [...new Set([...Object.keys(declaredGroups), ...Object.keys(lockedGroups)])]
      .filter((name) => !unmodellable.has(name)).sort();
    for (const name of groupNames) {
      const want = declaredGroups[name] || new Map();
      const have = lockedGroups[name] || new Map();
      if (JSON.stringify(requirementSignature(want)) !== JSON.stringify(requirementSignature(have))) {
        const spell = (map) => [...map.keys()].sort().join(", ") || "(none)";
        problems.push(`lock dependency group ${name} ${spell(have)} does not match pyproject ${spell(want)}`);
      }
      problems.push(...markerDriftProblems(want, have, `dependency group ${name} requirement`));
    }
    // Every dependency edge uv resolved out of the root entry has to name exactly one package entry.
    // A deleted `[[package]]` block leaves the edge dangling: uv answers "Dependency `pypdf` has
    // missing `source` field but has more than one matching package" (exit 2).
    // Every dependency edge the lock resolves — out of the root entry's requirements AND out of every
    // other `[[package]]` block — has to name exactly one package entry. A deleted `[[package]]` block
    // leaves the edge dangling: measured (adversarial pairs P23 and P24), deleting the `h11` block of
    // the shipped worker lock, which only `httpcore2` and `uvicorn` name, makes every uv in the matrix
    // answer "Failed to parse `uv.lock`" (exit 2 on 0.5.0-0.7.22, exit 1 from 0.8.5 on), and
    // duplicating that same block does the same. A reader that looks only at the root entry's own
    // dependency lists sees neither.
    const packageCount = new Map();
    for (const pkg of lock.packages) {
      const key = canonicalName(pkg.name || "");
      if (key) packageCount.set(key, (packageCount.get(key) || 0) + 1);
    }
    // A project named like a registry package it depends on has two blocks with the same name, and the
    // local one is the root, not the dependency an edge resolves to.
    const rootName = canonicalName(entry.name || "");
    if (rootName && packageCount.has(rootName)) packageCount.set(rootName, packageCount.get(rootName) - 1);
    const wantedEntries = new Set();
    const considerEntry = (base, marker) => {
      if (!base || wantedEntries.has(base)) return;
      if (markerCanNeverSelect(marker, knownExtras)) return;
      wantedEntries.add(base);
      const count = packageCount.get(base) || 0;
      if (count === 0) {
        problems.push(`lock requirement ${base} has no [[package]] entry in the lock — uv reports the dependency as missing and refuses this pair`);
      } else if (count > 1) {
        problems.push(`lock requirement ${base} resolves to ${count} [[package]] entries in the lock — uv reports more than one matching package and refuses this pair`);
      }
    };
    for (const item of [...lockMetadataRequirementItems(lockText, entry),
      ...Object.values(lockMetadataRequiresDevItems(lockText, entry)).flat()]) {
      considerEntry(canonicalName(item.name || ""), item.marker);
    }
    for (const name of lockDependencyEdges(lockText)) considerEntry(name, null);
    // The root entry's resolved half has to be covered by its metadata half — the comparison that keeps
    // working when the manifest half is `dynamic` and this reader cannot resolve it.
    problems.push(...lockRootResolutionProblems(lockText, entry));
    // uv checks each entry's own version against the WHEEL filenames beside it while it parses the
    // lock. A hand-edited pin leaves the filenames behind and uv answers (exit 2) "The entry for package
    // `anyio` (4.15.0) has wheel `anyio-4.15.1-py3-none-any.whl` with inconsistent version".
    //
    // The sdist filename is not checked, and that is measured uv behaviour, not a style preference: on
    // the shipped worker lock (adversarial pair P25b), `pypdf-6.4.2.tar.gz` beside an entry whose
    // version is 6.4.1 is accepted by all seven uv binaries — `lock --check` exit 0 on 0.6.10 through
    // 0.13.6 and `uv-0.5.0 sync --locked --python 3.12` exit 0 — while the same edit on the wheel
    // filename (P25c) is refused by all seven. uv validates wheel filenames and ignores sdist
    // filename/version agreement, so calling the sdist spelling drift would refuse a pair every uv this
    // toolkit supports accepts. `scripts/lockintegrity.py`'s `_artifact_wheels` drops sdists for the
    // same measured reason.
    for (const pkg of lock.packages) {
      const name = canonicalName(pkg.name || "");
      if (pkg.sdistList) {
        problems.push(`lockfile [[package]] entry ${JSON.stringify(pkg.name)} writes its sdist as a list — `
          + "uv writes `sdist = { url = … }` and refuses to parse this lock (measured: exit 2 on every uv in the matrix)");
      }
      if (pkg.local) continue;
      if (pkg.version === null || pkg.version === undefined) {
        if (name !== rootName) {
          problems.push(`lockfile [[package]] entry ${JSON.stringify(pkg.name)} records no version at all — `
            + "uv 0.13.6 and uv 0.5.0 both answer \"Failed to parse `uv.lock`\" (exit 2) for this lock");
        }
        continue;
      }
      const want = versionKey(pkg.version);
      if (want === null) continue;
      const mismatched = [];
      for (const file of pkg.artifacts) {
        if (!/\.whl$/.test(file)) continue;
        const identity = artifactIdentity(file);
        if (!identity) continue;
        if (canonicalName(identity.name) !== name) {
          mismatched.push(`its artifact ${JSON.stringify(file)} belongs to ${identity.name}, not to ${pkg.name}`);
          continue;
        }
        const claimed = versionKey(identity.version);
        if (claimed === null || claimed === want) continue;
        mismatched.push(`its artifact ${JSON.stringify(file)} claims ${JSON.stringify(identity.version)}`);
      }
      if (mismatched.length) {
        problems.push(`lockfile ${pkg.name} records version ${JSON.stringify(pkg.version)} but `
          + mismatched.join(", and ")
          + " — uv refuses a lock whose package version does not match its own wheel");
      }
    }
    // The lock's own format version: uv 0.13.6 answers "unsupported schema version (v2, but only v1 is
    // supported)" and exits 2 when the header says `version = 2` (adversarial pair P34, exit 2 on every
    // uv in the matrix). A reader that never looks at the header certifies a lock no uv can open.
    if (lock.lockFormatVersion !== undefined && lock.lockFormatVersion !== 1) {
      problems.push(`lockfile declares schema version ${lock.lockFormatVersion}, but uv reads only version 1 lockfiles — `
        + "measured: `lock --check` exit 2, \"unsupported schema version\"");
    }
    problems.push(...lockResolutionMarkerProblems(lock, "lockfile"));
    problems.push(...uvResolutionProblems(project, lock, "lockfile"));
    const revision = Number.isFinite(lock.revision) ? lock.revision : 1;
    if (revision > EXPECTED_REVISION_MAX) {
      problems.push(`lockfile revision ${revision} is above ${EXPECTED_REVISION_MAX}, the highest lockfile revision this toolkit supports (uv itself reads higher revisions, so this is a support limit, not uv's own ceiling)`);
    }
    return problems;
  } catch (error) {
    // An internal failure of this reader is not a verdict about the pair. A pair this reader cannot
    // compare is reported by the caller in its own words (`readBundledPair`, `notebookPairProblems`),
    // never dressed up as a finding about the dependency files. A pair the reader cannot even parse is
    // a different case, and it is a verdict: uv itself refuses to open those files, so the two parse
    // blocks above return it.
    throw error;
  }
}

module.exports = {
  DRIFT_SIGNATURE, STALENESS_REASONS, EXPECTED_REVISION_MAX, ROOT_SOURCE_PATH, UV_RESOLUTION_KEYS,
  UV_RECORDED_RESOLUTION_KEYS,
  canonicalName, isLockDrift, parseLock, parsePyproject, rootEntry, dependencyPins, pairProblems,
  splitRequirement, requirementKey, requirementBaseKey, requirementMap, requirementSignature,
  markerDriftProblems, specifierKey, pinKey, markerKey, extraMarker, versionKey,
  impliedSourceMode, packageArtifacts, artifactIdentity, lockDependencyEdges, lockEntryEdges,
  markerCanNeverSelect, lockResolutionMarkerProblems, requiresPythonInterval, intervalsCover,
  pythonAtomInterval, markerPythonIntervals,
  lockRootResolutionProblems, uvResolutionProblems,
  lockPackageBlock, lockPackageBlocks, lockMetadataSpecifiers, lockMetadataRequirementItems,
  lockMetadataRequiresDev, lockMetadataRequiresDevItems, lockProvidesExtras,
};
