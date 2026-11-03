"use strict";

/**
 * Host executable resolution.
 *
 * 0.3.5 looked only at absolute PATH entries of the Extension Host process and reported every
 * other location as "not searched". A uv installed in a per-user directory that the editor
 * process did not inherit was therefore invisible, setup refused before touching a file, and no
 * component was installed. 0.3.6 searches a bounded, documented set of locations, reports which
 * one answered, and reports the categories it searched when nothing did.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { runProcess, DEFAULT_TIMEOUT_MS } = require("./runner");

const VERSION_TIMEOUT_MS = 8000;

/**
 * Windows launch shape. The runner launches with `shell: false`, so a `.cmd`/`.bat` wrapper is
 * not something setup may start; it is reported as found-but-unusable so the operator can point
 * the setting at the real executable it calls.
 */
const WINDOWS_WRAPPER_EXTENSIONS = [".cmd", ".bat"];

/** Bounded and documented: no recursive search, no home-directory walk. */
function knownLocations(platform, env) {
  if (platform === "win32") {
    // Every entry is conditional on its environment variable. Without the filter an unset
    // %APPDATA% reached path.join(undefined, …) and aborted the whole plan with no verdict.
    return [
      env.USERPROFILE && path.join(env.USERPROFILE, ".local", "bin"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "uv"),
      env.APPDATA && path.join(env.APPDATA, "Python", "Python312", "Scripts"),
      env.APPDATA && path.join(env.APPDATA, "Python", "Scripts"),
      env.USERPROFILE && path.join(env.USERPROFILE, "scoop", "shims"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
      "C:\\Program Files\\uv",
    ].filter(Boolean);
  }
  const home = env.HOME || "";
  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    home && path.join(home, ".local", "bin"),
    home && path.join(home, ".cargo", "bin"),
    env.XDG_BIN_HOME || "",
  ].filter(Boolean);
}

/**
 * One pass over PATH: absolute entries only, each entry probed once, and the entries that were
 * skipped counted so the "searched" summary is not misleading.
 */
function pathScan(env) {
  const raw = String(env.PATH || "").split(path.delimiter).filter(Boolean);
  const entries = [];
  const seen = new Set();
  let skippedRelative = 0;
  let duplicates = 0;
  for (const entry of raw) {
    if (!path.isAbsolute(entry)) { skippedRelative += 1; continue; }
    if (seen.has(entry)) { duplicates += 1; continue; }
    seen.add(entry);
    entries.push(entry);
  }
  return { entries, skippedRelative, duplicates };
}

function pathEntries(env) {
  return pathScan(env).entries;
}

function binaryName(name, platform) {
  return platform === "win32" ? `${name}.exe` : name;
}

/** The launchable name first; on Windows the batch shapes are probed only to be reported. */
function binaryCandidates(name, platform) {
  if (platform !== "win32") return [name];
  return [`${name}.exe`, ...WINDOWS_WRAPPER_EXTENSIONS.map((extension) => `${name}${extension}`)];
}

function underAnyRoot(roots, candidate) {
  return roots.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  });
}

/**
 * Why a configured path cannot be used, judged from the value alone. A misconfigured setting
 * must not collapse into "not found": the operator has to see the value they typed and what is
 * wrong with it, otherwise the answer reads as if the tool does not exist on the machine.
 */
function settingProblem(value) {
  const raw = String(value === undefined || value === null ? "" : value);
  const trimmed = raw.trim();
  if (!trimmed) return "is empty";
  if (/^["']|["']$/.test(trimmed)) return `is wrapped in quotes (${trimmed}) — the setting takes the path itself, not a quoted string`;
  if (raw !== trimmed) return "has leading or trailing spaces, which are part of the path";
  if (/[/\\]$/.test(trimmed)) return "ends with a path separator — point at the executable file, not at a folder";
  if (!path.isAbsolute(trimmed)) return `is a relative path (${trimmed}) — the setting must be the absolute path of the executable`;
  return null;
}

/**
 * Inspect one candidate. `problem` is null only when the candidate is launchable; otherwise it
 * names what was found and why it cannot be used, so a present-but-unusable tool is never
 * reported as a missing one.
 */
async function probeCandidate(candidate, platform = process.platform) {
  if (!candidate) return { resolved: null, problem: "empty" };
  if (!path.isAbsolute(candidate)) return { resolved: null, problem: `a relative path (${candidate}) — only absolute paths can be probed` };
  let resolved;
  try { resolved = await fs.realpath(candidate); } catch { return { resolved: null, problem: null }; }
  let info;
  try { info = await fs.stat(resolved); } catch { return { resolved: null, problem: null }; }
  if (info.isDirectory()) return { resolved, problem: "a directory, not an executable file" };
  if (!info.isFile()) return { resolved, problem: "not a regular file" };
  if (platform === "win32" && WINDOWS_WRAPPER_EXTENSIONS.includes(path.extname(resolved).toLowerCase())) {
    return { resolved, problem: "a Windows batch wrapper", wrapper: true };
  }
  if (platform !== "win32" && !(info.mode & 0o111)) return { resolved, problem: "not executable", notExecutable: true };
  // Windows has no executable bit, so an empty file is the unusable case there. A 0-byte `uv.exe`
  // left behind by an interrupted installer would otherwise be reported as a usable tool and fail
  // later as a confusing spawn error.
  if (platform === "win32" && info.size === 0) return { resolved, problem: "an empty file", notExecutable: true };
  return { resolved, usable: true, problem: null };
}

async function executableFile(candidate) {
  const probe = await probeCandidate(candidate);
  return probe.usable ? probe.resolved : null;
}

/** "1.2.3" >= "0.5.0" without pulling in a dependency. */
function compareVersions(left, right) {
  const parse = (value) => String(value || "").match(/\d+(\.\d+)?(\.\d+)?/);
  const a = parse(left) ? parse(left)[0].split(".").map(Number) : [];
  const b = parse(right) ? parse(right)[0].split(".").map(Number) : [];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function versionOf(output) {
  const match = String(output || "").match(/\d+\.\d+(\.\d+)?/);
  return match ? match[0] : null;
}

const cache = new Map();
function clearHostToolCache() { cache.clear(); }

function cacheKey(name, options) {
  // The platform is part of the answer: the launchable shape and the documented locations differ.
  return [name, options.platform || process.platform, options.configuredPath || "", (options.env || process.env).PATH || "", (options.roots || []).join(path.delimiter), options.managedDir || ""].join("|");
}

/**
 * Resolve one host tool.
 *
 * Order: explicit setting → PATH → documented known locations → toolkit managed directory.
 * A resolved tool is verified by its version command (stdout **and** stderr, bounded by
 * `versionTimeoutMs`, 8 s by default). A tool that does not answer is reported as `unverified`
 * rather than as installed. A candidate that is present but cannot be launched — a misconfigured
 * setting, a directory, a file without the executable bit, a Windows batch wrapper — is reported
 * with `usable: false` and a reason that names it, never as "not found".
 */
async function resolveHostTool(name, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const roots = options.roots || [];
  const key = cacheKey(name, { ...options, env });
  if (!options.refresh && cache.has(key)) return cache.get(key);

  const searched = { setting: 0, pathEntries: 0, pathEntriesSkippedRelative: 0, pathEntriesDuplicate: 0, knownLocations: 0, managed: 0 };
  const binaryShapes = binaryCandidates(name, platform);
  const attempts = [];

  const settingIssue = options.configuredPath ? settingProblem(options.configuredPath) : null;
  if (options.configuredPath) {
    searched.setting = 1;
    attempts.push({ source: "setting", candidate: String(options.configuredPath), settingIssue });
  }
  const scan = pathScan(env);
  searched.pathEntries = scan.entries.length;
  searched.pathEntriesSkippedRelative = scan.skippedRelative;
  searched.pathEntriesDuplicate = scan.duplicates;
  for (const entry of scan.entries) for (const binary of binaryShapes) attempts.push({ source: "path", candidate: path.join(entry, binary) });
  const known = knownLocations(platform, env);
  searched.knownLocations = known.length;
  for (const directory of known) for (const binary of binaryShapes) attempts.push({ source: "known-location", candidate: path.join(directory, binary) });
  if (options.managedDir) {
    searched.managed = 1;
    for (const binary of binaryShapes) attempts.push({ source: "managed", candidate: path.join(options.managedDir, binary) });
  }

  const base = { name, searched, probedAt: new Date().toISOString(), workspaceRefusals: [] };
  /** Found but unusable candidates, kept so the verdict says what was actually in the way. */
  const unusable = [];
  let wrapperFound = null;

  for (const attempt of attempts) {
    if (attempt.source === "setting" && attempt.settingIssue) {
      unusable.push({ candidate: attempt.candidate, source: "setting", problem: attempt.settingIssue, clause: attempt.settingIssue, fromSetting: true });
      continue;
    }
    const probe = await probeCandidate(attempt.candidate, platform);
    if (!probe.resolved) continue;
    if (underAnyRoot(roots, probe.resolved)) {
      base.workspaceRefusals.push(probe.resolved);
      continue;
    }
    if (probe.wrapper) {
      // Recorded, never launched: `shell: false` means a batch file is not something setup may start.
      wrapperFound = wrapperFound || { candidate: probe.resolved, source: attempt.source, problem: probe.problem, wrapper: true, fromSetting: attempt.source === "setting" };
      continue;
    }
    if (probe.problem) {
      unusable.push({ candidate: probe.resolved, source: attempt.source, problem: probe.problem, clause: `is ${probe.problem}`, fromSetting: attempt.source === "setting" });
      continue;
    }
    const resolved = probe.resolved;
    // A usable tool elsewhere on the machine does not make a broken setting correct: the shape
    // problem travels with the answer so the GUI can name it.
    const result = { ...base, path: resolved, source: attempt.source, usable: true, settingProblem: settingIssue };
    if (options.verify === false) return remember(key, { ...result, verified: null });
    let output;
    try {
      const run = options.runProcess || runProcess;
      const versionProbe = await run(resolved, ["--version"], { timeout: options.versionTimeoutMs || VERSION_TIMEOUT_MS, cwd: options.probeCwd });
      // Some builds print the version banner on stderr; both streams answer the probe.
      output = `${versionProbe.stdout || ""}\n${versionProbe.stderr || ""}`;
    } catch (error) {
      return remember(key, {
        ...result, version: null, verified: false, verifyError: error.message,
        reason: `${name} was found at ${resolved} but its version command failed: ${error.message}`,
        hint: `Check that ${resolved} runs from a terminal, or point researchStack.uvPath at a working executable.`,
      });
    }
    const version = versionOf(output);
    const minimum = options.minimumVersion || null;
    const belowMinimum = version !== null && minimum && compareVersions(version, minimum) < 0;
    return remember(key, {
      ...result,
      version: version || null,
      versionOutput: String(output || "").trim().slice(0, 200),
      verified: version !== null && !belowMinimum,
      minimumVersion: minimum,
      reason: version === null ? `${name} at ${resolved} did not report a version.`
        : belowMinimum ? `${name} ${version} at ${resolved} is older than the required ${minimum}.` : null,
      hint: version === null ? `Update ${name} and retry.`
        : belowMinimum ? `Update ${name} to ${minimum} or newer, then retry setup.` : "",
    });
  }

  const summary = `Searched: ${searched.setting} configured path(s), ${searched.pathEntries} absolute PATH entr(ies)`
    + `${searched.pathEntriesSkippedRelative ? `, ${searched.pathEntriesSkippedRelative} PATH entr(ies) skipped as relative` : ""}`
    + `, ${searched.knownLocations} documented install location(s), ${searched.managed} managed location(s).`;
  const refused = base.workspaceRefusals.length ? ` ${base.workspaceRefusals.length} candidate(s) inside the workspace were refused.` : "";
  const blocked = unusable.find((entry) => entry.fromSetting) || wrapperFound || unusable[0] || null;

  if (blocked && blocked.wrapper) {
    return remember(key, {
      ...base, path: blocked.candidate, source: blocked.source, version: null, verified: false, usable: false,
      reason: `${name} was found at ${blocked.candidate} but it is a Windows batch wrapper; setup cannot launch it directly — set researchStack.uvPath to the ${name}.exe it calls. ${summary}`,
      hint: `Point researchStack.uvPath at the ${name}.exe that ${blocked.candidate} calls, or install the ${name} executable package.`,
    });
  }
  if (blocked && blocked.fromSetting) {
    return remember(key, {
      ...base, path: null, source: "setting", version: null, verified: false, usable: false,
      configuredPath: String(options.configuredPath), settingProblem: blocked.problem,
      reason: `${name} was not used: the configured path ${JSON.stringify(String(options.configuredPath))} ${blocked.clause}. ${summary}`,
      hint: `Set researchStack.uvPath to the absolute path of the ${name} executable — no quotes, no trailing separator — then run "Reload Window" so the editor process sees it.`,
    });
  }
  if (blocked) {
    return remember(key, {
      ...base, path: blocked.candidate, source: blocked.source, version: null, verified: false, usable: false,
      reason: `${name} was found at ${blocked.candidate} but it is ${blocked.problem}. ${summary}`,
      hint: `Replace ${blocked.candidate} with a working ${name} executable, or set researchStack.uvPath to the ${name} executable you intend setup to run.`,
    });
  }

  return remember(key, {
    ...base, path: null, source: null, version: null, verified: false,
    reason: `${name} was not found. ${summary}${refused}`,
    hint: `Install ${name}, or set researchStack.uvPath to its executable and run "Reload Window" so the editor process sees it.`,
  });
}

function remember(key, value) { cache.set(key, value); return value; }

/**
 * Adapter for callers and test fixtures that provide the 0.3.x `findHostTool` service, or a
 * pre-resolved path, instead of `resolveHostTool`. One resolution path, no fixture rewrite.
 */
function resolverFrom(services = {}) {
  if (typeof services.resolveHostTool === "function") return services.resolveHostTool;
  if (typeof services.findHostTool === "function") {
    return async (name, options = {}) => {
      const found = await services.findHostTool(name, options.roots || []);
      if (!found) return { name, path: null, source: null, version: null, verified: false, searched: { setting: 0, pathEntries: 0, knownLocations: 0, managed: 0 }, reason: `${name} was not found by the injected resolver.`, hint: `Install ${name} and retry.` };
      return { name, path: found, source: "injected", version: null, versionUnprobed: true, verified: true, searched: { setting: 0, pathEntries: 0, knownLocations: 0, managed: 0 }, minimumVersion: options.minimumVersion || null };
    };
  }
  return resolveHostTool;
}

module.exports = {
  VERSION_TIMEOUT_MS, WINDOWS_WRAPPER_EXTENSIONS, resolverFrom, knownLocations, pathEntries, pathScan,
  binaryName, binaryCandidates, compareVersions, versionOf, settingProblem, probeCandidate,
  resolveHostTool, clearHostToolCache, executableFile,
};
