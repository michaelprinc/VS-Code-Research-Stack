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
 * The comparison is (canonical name, extras, specifier); a PEP 508 marker is read off the
 * manifest and ignored on both sides, because uv keeps it in its own `marker` key. A reader that
 * compares the marker text instead reports drift for a pair uv accepts, which is worse than not
 * reading the pair at all: the shipped runtime uses this verdict to decide whether to blame the
 * host for a lock this toolkit wrote.
 */

/** uv's own refusal, seen unchanged on 0.5.0 through 0.13.6 on this host. */
const DRIFT_SIGNATURE = /The lockfile at `uv\.lock` needs to be updated, but `--(?:locked|check)` was provided/i;
/** Reasons uv may call a lock stale that are NOT a version-only drift and must not be auto-repaired. */
const STALENESS_REASONS = /mismatched requirements for:|change in Python requirement:|mismatched members:|No solution found when resolving/i;
/**
 * Measured on this host: uv 0.5.0 through uv 0.13.6 all write `revision = 5`. `scripts/lockintegrity.py`
 * holds the same ceiling, so the Python guard and this reader report the same lock.
 */
const EXPECTED_REVISION_MAX = 5;

/** A TOML table header — `[table]`, `[package.metadata]` or `[[package]]` — with an optional trailing comment. */
const TABLE_HEADER = /^(?:\[\[[^\]]+\]\]|\[[^\]]+\])[ \t]*(#.*)?$/m;
/** The header that opens one `[[package]]` entry of a uv lockfile. */
const PACKAGE_HEADER = /^\[\[package\]\][ \t]*(#.*)?$/gm;

/** True when a run failure is uv refusing a lock that no longer matches its project metadata. */
function isLockDrift(error) {
  if (!error) return false;
  const text = `${error.stderr || ""}\n${error.message || ""}`;
  return DRIFT_SIGNATURE.test(text) && !STALENESS_REASONS.test(text);
}

function canonicalName(name) {
  return String(name).replace(/[-_.]+/g, "-").toLowerCase();
}

/** Index just past the closing quote of the string that starts at `at`. */
function stringEnd(text, at) {
  const quote = text[at];
  for (let index = at + 1; index < text.length; index += 1) {
    if (text[index] === "\\") index += 1;
    else if (text[index] === quote) return index + 1;
  }
  return text.length;
}

/**
 * Index of the bracket that closes the `[` or `{` at `open`.
 *
 * `dependencies = ["mcp[cli]==2.2.0", "pypdf==6.4.1"]` ends at the last `]`, not at the one inside
 * `mcp[cli`: the bracket inside the quoted string is part of the requirement, not of the array.
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
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") {
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
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
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
 * The key a requirement is compared on: canonical name, sorted extras, whitespace-free specifier.
 * The marker is deliberately absent — uv records it separately and does not compare it against the
 * manifest text, which is written in PEP 440 form (`python_version`) while the lock writes the
 * resolved form (`python_full_version`).
 */
function requirementKey(item) {
  const extras = [...new Set((item.extras || []).map(canonicalName))].sort();
  const extrasPart = extras.length ? `[${extras.join(",")}]` : "";
  const specifier = String(item.specifier || "").replace(/\s+/g, "");
  return `${item.name}${extrasPart} ${specifier}`.trim();
}

/** Kept as the historical name of `requirementKey`. */
const specifierKey = requirementKey;
const pinKey = (item) => `${item.name}@${item.version}`;

/** The raw inner text of `key = [ … ]` in `block`, or null when the key is absent. */
function arrayInner(block, key, label) {
  const match = block.match(new RegExp(`^${key}\\s*=\\s*\\[`, "m"));
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
  const head = { name: null, version: null, local: false };
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
    else if (key === "source" && /\b(editable|virtual)\s*=/.test(value)) head.local = true;
  }
  return head;
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
  const source = String(text || "");
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
  return { ...topLevel, packages: blocks.map((item) => ({ name: item.name, version: item.version, local: item.local, start: item.start, end: item.end })) };
}

function rootEntry(parsed) {
  const entry = parsed.packages.find((item) => item.local);
  if (!entry) throw new Error("lockfile has no editable/virtual root package entry");
  return entry;
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
  const source = String(text || "");
  const section = (name) => {
    const header = source.match(new RegExp(`^\\[${name}\\][ \\t]*(#.*)?$`, "m"));
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
    const match = project.match(new RegExp(`^${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "m"));
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
    for (const match of groups.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*\[/gm)) {
      const open = match.index + match[0].length - 1;
      const close = bracketEnd(groups, open);
      if (close === -1) throw new Error("pyproject.toml dependency group array is not closed");
      dependencyGroups[match[1]] = topLevelItems(groups.slice(open + 1, close)).map((item) => {
        // PEP 735 lets a group hold a dependency object instead of a requirement: uv writes
        // `{ include-group = "other" }`, the PEP writes `{ include = "other" }`. Neither is a package.
        if (item.startsWith("{") || item.startsWith('"{')) {
          const fields = inlineTable(item);
          const target = fields["include-group"] !== undefined ? unquote(fields["include-group"])
            : fields.include !== undefined ? unquote(fields.include) : null;
          return target === null ? { kind: "unknown", raw: item } : { kind: "include", group: target };
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
    for (const match of optional.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*\[/gm)) {
      const open = match.index + match[0].length - 1;
      const close = bracketEnd(optional, open);
      if (close === -1) throw new Error("pyproject.toml optional dependency group array is not closed");
      optionalDependencies[match[1]] = topLevelItems(optional.slice(open + 1, close)).map((item) => {
        if (item.startsWith('"') || item.startsWith("'")) return splitRequirement(unquote(item));
        throw new Error(`pyproject.toml optional dependency entry ${JSON.stringify(item.slice(0, 40))} is not a requirement string`);
      });
    }
  }
  return {
    name: scalar("name"),
    version: scalar("version"),
    dynamic,
    requiresPython: scalar("requires-python"),
    dependencies: declared,
    optionalDependencies,
    groups: dependencyGroups,
  };
}

/**
 * Flatten a dependency group the way uv does before it writes `requires-dev`: an included group
 * contributes its own requirements. Returns null for a group this reader cannot model — an object
 * entry that is not an include, or an include of a group the manifest does not declare — so the
 * caller skips it instead of reporting a group that only looks wrong.
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
  for (const match of table.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*\[/gm)) {
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
    if (/^\[\[package\]\]/.test(block)) return block;
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
      requirements.push({ name: parsed.name, extras, specifier: fields.specifier === undefined ? "" : unquote(fields.specifier) });
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

/** `metadata.provides-extras` of the root entry, or null when the lock records none. */
function lockProvidesExtras(lockText, entry) {
  const block = lockPackageBlock(lockText, entry);
  if (!block) return null;
  const table = tableBlock(block, /^\[package\.metadata\][ \t]*(#.*)?$/m);
  if (table === null) return null;
  const inner = arrayInner(table, "provides-extras", "lockfile");
  if (inner === null) return null;
  return topLevelItems(inner).map((item) => unquote(item));
}

const failure = (error) => (error && error.message ? String(error.message) : String(error));

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
    } else if (String(entry.version) !== String(project.version)) {
      problems.push(`lock root package version ${entry.version} does not match pyproject version ${project.version}`);
    }
    const normalize = (value) => String(value || "").replace(/\s+/g, "");
    if (project.requiresPython && lock.requiresPython && normalize(project.requiresPython) !== normalize(lock.requiresPython)) {
      problems.push(`lock requires-python ${lock.requiresPython} does not match pyproject ${project.requiresPython}`);
    }
    const declared = new Set([
      ...project.dependencies.map(requirementKey),
      ...Object.values(project.optionalDependencies || {}).flat().map(requirementKey),
    ]);
    const locked = new Set(lockMetadataSpecifiers(lockText, entry));
    if (declared.size !== locked.size || [...declared].some((item) => !locked.has(item))) {
      problems.push(`lock dependency specifiers ${[...locked].sort().join(", ")} do not match pyproject ${[...declared].sort().join(", ")}`);
    }
    // Optional dependency groups are a second drift surface: uv writes them into `requires-dist` with
    // an `extra ==` marker. Recent uv also names them in `provides-extras`; uv 0.5.0 does not, so a
    // lock that omits the key is not stale — the `requires-dist` comparison above is what catches a
    // missing optional dependency.
    const declaredExtras = new Set(Object.keys(project.optionalDependencies || {}));
    const lockedExtras = lockProvidesExtras(lockText, entry);
    if (lockedExtras !== null) {
      const lockedExtraSet = new Set(lockedExtras);
      if (declaredExtras.size !== lockedExtraSet.size || [...declaredExtras].some((name) => !lockedExtraSet.has(name))) {
        problems.push(`lock provides-extras ${[...lockedExtraSet].sort().join(", ") || "(none)"} does not match pyproject optional-dependencies ${[...declaredExtras].sort().join(", ") || "(none)"}`);
      }
    }
    // uv records a project's dependency groups as `requires-dev`; a group added to the manifest without
    // a re-lock is the same class of drift as a dependency added to it.
    const declaredGroups = {};
    const unmodellable = new Set();
    for (const [name, entries] of Object.entries(project.groups)) {
      const requirements = resolveGroup(entries, project.groups, new Set([name]));
      if (requirements === null) unmodellable.add(name);
      else declaredGroups[name] = new Set(requirements.map(requirementKey));
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
    const revision = Number.isFinite(lock.revision) ? lock.revision : 1;
    if (revision > EXPECTED_REVISION_MAX) {
      problems.push(`lockfile revision ${revision} is above the reviewed maximum ${EXPECTED_REVISION_MAX} for the uv versions this toolkit supports`);
    }
    return problems;
  } catch (error) {
    return [`lock comparison failed: ${failure(error)}`];
  }
}

module.exports = {
  DRIFT_SIGNATURE, STALENESS_REASONS, EXPECTED_REVISION_MAX,
  canonicalName, isLockDrift, parseLock, parsePyproject, rootEntry, dependencyPins, pairProblems,
  splitRequirement, requirementKey, specifierKey, pinKey,
  lockPackageBlock, lockPackageBlocks, lockMetadataSpecifiers, lockMetadataRequiresDev, lockProvidesExtras,
};
