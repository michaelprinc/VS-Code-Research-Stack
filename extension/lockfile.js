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

/** The names a PEP 508 marker clause can start with. */
const MARKER_KEYS = new Set([
  "python_version", "python_full_version", "os_name", "sys_platform", "platform_release",
  "platform_system", "platform_machine", "platform_python_implementation", "implementation_name",
  "implementation_version", "extra",
]);

/**
 * The `python_full_version` bound uv writes for a `python_version` comparison.
 *
 * `python_version` only ever holds `major.minor`, so uv rewrites the bound to the `major.minor`
 * values that select the same interpreters. Measured clause by clause with uv 0.13.6 on this host:
 * `>= '3.12'` -> `>= '3.12'`, `>= '3.12.0'` -> `>= '3.12'`, `>= '3.12.1'` -> `>= '3.13'`,
 * `>= '4.0.0'` -> `>= '4'`, `> '3.12'` -> `>= '3.13'`, `> '3.12.1'` -> `>= '3.13'`,
 * `< '3.14'` -> `< '3.14'`, `< '3.13.0'` -> `< '3.13'`, `<= '3.13'` -> `< '3.14'`,
 * `<= '3.12.1'` -> `< '3.13'`, `== '3.13'` -> `== '3.13.*'`, `!= '3.13'` -> `!= '3.13.*'`.
 * Returns null for a shape that was not measured, so the caller skips the marker instead of
 * inventing drift for a pair uv accepts.
 */
function pythonVersionBound(operator, version) {
  const parts = String(version).split(".");
  if (parts.length > 3 || !parts.every((part) => /^\d{1,2}$/.test(part))) return null;
  const major = Number(parts[0]);
  const minor = parts.length > 1 ? Number(parts[1]) : 0;
  const patch = parts.length > 2 ? Number(parts[2]) : 0;
  // The lowest `major.minor` at or above the bound, and the next one up, printed the way uv prints them.
  const written = minor === 0 ? `${major}` : `${major}.${minor}`;
  const above = `${major}.${minor + 1}`;
  const atOrAbove = patch > 0 ? above : written;
  if (operator === ">=") return `python_full_version >= '${atOrAbove}'`;
  if (operator === ">") return `python_full_version >= '${above}'`;
  if (operator === "<") return `python_full_version < '${patch > 0 ? above : atOrAbove}'`;
  if (operator === "<=") return `python_full_version < '${above}'`;
  if (operator === "==" && patch === 0) return `python_full_version == '${atOrAbove}.*'`;
  if (operator === "!=" && patch === 0) return `python_full_version != '${atOrAbove}.*'`;
  return null;
}

/** One `sys_platform == 'win32'` clause in the form uv writes it, or null when it is not modelled. */
function markerClause(text) {
  const clean = text.trim().replace(/"/g, "'").replace(/\s+/g, " ");
  const match = clean.match(/^([a-z_]+)\s*(===|==|!=|<=|>=|~=|<|>)\s*'([^']*)'$/);
  if (!match) return null;
  const [, key, operator, value] = match;
  if (!MARKER_KEYS.has(key)) return null;
  if (key !== "python_version") return { python: key === "python_full_version", text: `${key} ${operator} '${value}'` };
  const rewritten = pythonVersionBound(operator, value);
  return rewritten === null ? null : { python: true, text: rewritten };
}

/**
 * A PEP 508 marker in the form uv re-serialises it into the lock, or null when it is a marker this
 * reader does not model.
 *
 * uv hoists the `python_full_version` clause to the front of a conjunction or a disjunction and keeps
 * the rest in the order the manifest wrote it (measured: `implementation_name == 'cpython' and
 * python_version >= '3.13'` -> `python_full_version >= '3.13' and implementation_name == 'cpython'`).
 * A marker with parentheses uv expands into a disjunctive normal form this reader cannot reproduce —
 * and uv's own expansion of such a manifest fails uv's own `lock --check` — so it is left unmodelled
 * rather than guessed at.
 */
function markerKey(marker) {
  const raw = String(marker || "").trim();
  if (!raw) return "";
  if (/[()[\]]/.test(raw)) return null;
  const pieces = raw.split(/\s+(and|or)\s+/);
  if (pieces.length % 2 === 0) return null;
  const operator = pieces.length > 1 ? pieces[1] : "";
  const clauses = [];
  for (let index = 0; index < pieces.length; index += 2) {
    if (index > 1 && pieces[index - 1] !== operator) return null;
    const clause = markerClause(pieces[index]);
    if (clause === null) return null;
    clauses.push(clause);
  }
  clauses.sort((left, right) => (left.python === right.python ? 0 : left.python ? -1 : 1));
  return clauses.map((clause) => clause.text).join(operator ? ` ${operator} ` : " ");
}

/**
 * The key a requirement is compared on: canonical name, sorted extras, whitespace-free specifier and
 * the marker in uv's own spelling. The marker is part of the requirement — uv 0.13.6 refuses a lock
 * whose recorded marker is not the manifest's — but it is compared after uv's rewrite, never as the
 * raw text the manifest wrote.
 */
function requirementKey(item) {
  const extras = [...new Set((item.extras || []).map(canonicalName))].sort();
  const extrasPart = extras.length ? `[${extras.join(",")}]` : "";
  const specifier = String(item.specifier || "").replace(/\s+/g, "");
  const marker = markerKey(item.marker);
  const markerPart = marker ? ` ; ${marker}` : "";
  return `${item.name}${extrasPart} ${specifier}${markerPart}`.trim();
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

/** Kept as the historical name of `requirementKey`. */
const specifierKey = requirementKey;
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
  for (const raw of block.split(/\r?\n/).slice(1)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // A sub-table header ends the package's own keys, so a `name = "…"` inside `requires-dist`
    // is never mistaken for the package entry itself.
    if (line.startsWith("[")) break;
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const [, key, value] = assignment;
    if (key === "name" && head.name === null) head.name = unquote(value);
    else if (key === "version" && head.version === null) head.version = unquote(value);
    else if (key === "source") {
      // The mode and the path are read, not just "is local": `editable` against a manifest with no
      // build-system, or a root entry pointing at a subdirectory, are both pairs uv refuses.
      const fields = inlineTable(value);
      for (const mode of ["editable", "virtual"]) {
        if (fields[mode] !== undefined) {
          head.local = true;
          head.mode = mode;
          head.path = unquote(fields[mode]);
          break;
        }
      }
    }
  }
  return head;
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

/** A version compared the way uv compares it: epoch and local part aside, trailing zeros ignored. */
function versionKey(version) {
  const text = String(version || "").trim().toLowerCase().replace(/^\d+!/, "").replace(/\+.*$/, "");
  const match = text.match(/^(\d+(?:\.\d+)*)(.*)$/);
  if (!match) return text;
  const parts = match[1].split(".");
  while (parts.length > 1 && parts[parts.length - 1] === "0") parts.pop();
  return `${parts.join(".")}${match[2]}`;
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
  const topLevel = {};
  for (const raw of source.slice(0, blocks[0].start).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const assignment = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const [, key, value] = assignment;
    const scalar = value.replace(/#.*$/, "").trim();
    if (key === "revision") topLevel.revision = Number(scalar);
    else if (key === "requires-python") topLevel.requiresPython = unquote(value);
    else if (key === "version" && topLevel.lockFormatVersion === undefined) topLevel.lockFormatVersion = Number(scalar);
  }
  return { ...topLevel, packages: blocks.map((item) => ({ name: item.name, version: item.version, local: item.local, mode: item.mode, path: item.path, start: item.start, end: item.end, artifacts: packageArtifacts(item.block) })) };
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
  return local.find((item) => item.path === ROOT_SOURCE_PATH) || local[0];
}

/** The pins a lock holds, as `name@version`, excluding the project's own entry. */
function dependencyPins(parsed) {
  return new Set(parsed.packages.filter((item) => !item.local).map((item) => `${canonicalName(item.name)}@${item.version}`));
}

/**
 * Read the fields of a pyproject.toml this toolkit writes. Deliberately narrow: an unexpected
 * shape throws instead of guessing, because a silent guess is how a drifted pair gets shipped.
 * `pairProblems` — the function the shipped runtime calls — turns a throw into a reported problem.
 */
function parsePyproject(text) {
  const source = String(text || "").replace(/^\uFEFF/, "");
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
    // TOML allows a literal string in single quotes. Reading only basic strings would report the
    // missing value as a version mismatch instead of reading the manifest.
    const match = project.match(new RegExp(`^[ \\t]*${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m"));
    if (!match) return null;
    return match[1] !== undefined ? match[1] : match[2];
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
    for (const match of groups.matchAll(ANY_KEY_ARRAY_OPEN)) {
      const open = match.index + match[0].length - 1;
      const close = bracketEnd(groups, open);
      if (close === -1) throw new Error("pyproject.toml dependency group array is not closed");
      dependencyGroups[match[1]] = topLevelItems(groups.slice(open + 1, close)).map((item) => {
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
    for (const match of optional.matchAll(ANY_KEY_ARRAY_OPEN)) {
      const open = match.index + match[0].length - 1;
      const close = bracketEnd(optional, open);
      if (close === -1) throw new Error("pyproject.toml optional dependency group array is not closed");
      optionalDependencies[match[1]] = topLevelItems(optional.slice(open + 1, close)).map((item) => {
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

/** `metadata.requires-dev` of the root entry, as requirement keys per group. */
function lockMetadataRequiresDev(lockText, entry) {
  const block = lockPackageBlock(lockText, entry);
  if (!block) return {};
  const table = tableBlock(block, /^\[package\.metadata\.requires-dev\][ \t]*(#.*)?$/m);
  if (table === null) return {};
  const groups = {};
  for (const match of table.matchAll(ANY_KEY_ARRAY_OPEN)) {
    const open = match.index + match[0].length - 1;
    const close = bracketEnd(table, open);
    if (close === -1) throw new Error("lockfile requires-dev group array is not closed");
    groups[match[1]] = lockRequirements(table.slice(open + 1, close)).map(requirementKey);
  }
  return groups;
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

/** `metadata.requires-dist` of the root entry, read straight from the lock text. */
function lockMetadataSpecifiers(lockText, entry) {
  const block = lockPackageBlock(lockText, entry);
  if (!block) return [];
  const table = tableBlock(block, /^\[package\.metadata\][ \t]*(#.*)?$/m);
  if (table === null) return [];
  const inner = arrayInner(table, "requires-dist", "lockfile");
  if (inner === null) return [];
  return lockRequirements(inner).map(requirementKey);
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
 * The names of the dependency edges uv resolved for the root entry: its own `dependencies` array plus
 * `[package.optional-dependencies]` and `[package.dev-dependencies]`.
 *
 * These are the entries uv looks up when it parses the lock. Delete the `[[package]]` block one of
 * them names and uv answers "Dependency `pypdf` has missing `source` field but has more than one
 * matching package" (exit 2) — a hand-edited lock that still lists the requirement in `requires-dist`
 * looks untouched to a metadata-only reader.
 */
function lockDependencyEdges(lockText, entry) {
  const block = lockPackageBlock(lockText, entry);
  if (!block) return [];
  const names = requirementNames(arrayInner(packageKeyBlock(block), "dependencies", "lockfile") || "");
  for (const table of ["optional-dependencies", "dev-dependencies"]) {
    names.push(...subTableNames(block, new RegExp(`^\\[package\\.${table}\\][ \\t]*(#.*)?$`, "m"), `lockfile [package.${table}]`));
  }
  return names;
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
    if (project.requiresPython !== null && lock.requiresPython === undefined) {
      problems.push(`pyproject declares requires-python ${JSON.stringify(project.requiresPython)} but the lockfile records none — uv refuses to parse such a lock`);
    } else if (project.requiresPython === null && lock.requiresPython !== undefined && !isUvDefaultRequiresPython(lock.requiresPython)) {
      problems.push(`pyproject declares no requires-python but the lock records ${JSON.stringify(lock.requiresPython)} — uv defaults the manifest to >=3.12 and calls the lock stale`);
    } else if (project.requiresPython !== null && lock.requiresPython !== undefined
      && normalize(project.requiresPython) !== normalize(lock.requiresPython)) {
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
    const declared = new Set([
      ...project.dependencies.map(requirementKey),
      ...Object.entries(project.optionalDependencies || {}).flatMap(([group, items]) =>
        items.map((item) => requirementKey({ ...item, marker: extraMarker(item.marker, group) }))),
    ]);
    const locked = new Set(lockMetadataSpecifiers(lockText, entry));
    if (!dynamicDependencies && !dynamicOptional
      && (declared.size !== locked.size || [...declared].some((item) => !locked.has(item)))) {
      problems.push(`lock dependency specifiers ${[...locked].sort().join(", ")} do not match pyproject ${[...declared].sort().join(", ")}`);
    }
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
    if (lockedExtras === null ? declaredExtras.size > 0 && lock.revision !== undefined
      : declaredExtras.size !== lockedExtraSet.size || [...declaredExtras].some((name) => !lockedExtraSet.has(name))) {
      problems.push(`lock provides-extras ${lockedExtras === null ? "(key absent)" : [...lockedExtraSet].sort().join(", ") || "(none)"} does not match pyproject optional-dependencies ${[...declaredExtras].sort().join(", ") || "(none)"}`);
    }
    const unmodelled = (project.uvResolutionInputs || []).filter((key) => UV_RESOLUTION_KEYS.has(key)).sort();
    if (unmodelled.length) {
      problems.push(`pyproject declares [tool.uv] ${unmodelled.join(", ")}; this reader cannot model those resolution inputs, so the pair cannot be certified up to date`);
    }
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
      else declaredGroups[name] = new Set(requirements.map(requirementKey));
    }
    for (const [name, target] of legacyIncludes) {
      problems.push(`pyproject dependency group ${name} declares { include = ${JSON.stringify(target)} }; this reader cannot certify that group-reference spelling — measured on this host, uv 0.13.6 refuses the manifest (lock --check exit 2, contains an unknown dependency object specifier) and uv 0.5.0 accepted it and locked the group as empty, so the pair cannot be certified up to date`);
    }
    const lockedGroups = Object.fromEntries(Object.entries(lockMetadataRequiresDev(lockText, entry)).map(([key, items]) => [key, new Set(items)]));
    const groupNames = [...new Set([...Object.keys(declaredGroups), ...Object.keys(lockedGroups)])]
      .filter((name) => !unmodellable.has(name)).sort();
    for (const name of groupNames) {
      const want = declaredGroups[name] || new Set();
      const have = lockedGroups[name] || new Set();
      if (want.size !== have.size || [...want].some((item) => !have.has(item))) {
        problems.push(`lock dependency group ${name} ${[...have].sort().join(", ") || "(none)"} does not match pyproject ${[...want].sort().join(", ") || "(none)"}`);
      }
    }
    // Every dependency edge uv resolved out of the root entry has to name exactly one package entry.
    // A deleted `[[package]]` block leaves the edge dangling: uv answers "Dependency `pypdf` has
    // missing `source` field but has more than one matching package" (exit 2).
    const packageCount = new Map();
    for (const pkg of lock.packages) {
      if (pkg.start === entry.start) continue;
      const key = canonicalName(pkg.name || "");
      packageCount.set(key, (packageCount.get(key) || 0) + 1);
    }
    for (const name of new Set(lockDependencyEdges(lockText, entry))) {
      const count = packageCount.get(name) || 0;
      if (count === 0) problems.push(`lock resolves ${name} for the project but records no [[package]] entry for it — uv cannot read this lock`);
      else if (count > 1) problems.push(`lock records ${count} [[package]] entries for ${name}, the dependency uv resolved for the project — uv cannot pick one`);
    }
    // The root entry's resolved half has to be covered by its metadata half — the comparison that keeps
    // working when the manifest half is `dynamic` and this reader cannot resolve it.
    problems.push(...lockRootResolutionProblems(lockText, entry));
    // uv checks each entry's own version against the sdist and wheel filenames beside it while it
    // parses the lock. A hand-edited pin leaves the filenames behind and uv answers (exit 2) "The entry
    // for package `anyio` (4.15.0) has wheel `anyio-4.15.1-py3-none-any.whl` with inconsistent version".
    for (const pkg of lock.packages) {
      if (pkg.local || !pkg.artifacts.length) continue;
      const want = versionKey(pkg.version);
      for (const file of pkg.artifacts) {
        const identity = artifactIdentity(file);
        if (!identity || canonicalName(identity.name) !== canonicalName(pkg.name || "")) continue;
        if (versionKey(identity.version) !== want) {
          problems.push(`lock entry for ${pkg.name} records version ${pkg.version} but carries ${file} with version ${identity.version} — uv calls this a malformed lock entry`);
          break;
        }
      }
    }
    const revision = Number.isFinite(lock.revision) ? lock.revision : 1;
    if (revision > EXPECTED_REVISION_MAX) {
      problems.push(`lockfile revision ${revision} is above ${EXPECTED_REVISION_MAX}, the highest lockfile revision this toolkit supports (uv itself reads higher revisions, so this is a support limit, not uv's own ceiling)`);
    }
    return problems;
  } catch (error) {
    return [`lock comparison failed: ${failure(error)}`];
  }
}

module.exports = {
  DRIFT_SIGNATURE, STALENESS_REASONS, EXPECTED_REVISION_MAX, ROOT_SOURCE_PATH, UV_RESOLUTION_KEYS,
  canonicalName, isLockDrift, parseLock, parsePyproject, rootEntry, dependencyPins, pairProblems,
  splitRequirement, requirementKey, specifierKey, pinKey, markerKey, extraMarker, versionKey,
  impliedSourceMode, packageArtifacts, artifactIdentity, lockDependencyEdges, lockRootResolutionProblems,
  lockPackageBlock, lockPackageBlocks, lockMetadataSpecifiers, lockMetadataRequiresDev, lockProvidesExtras,
};
