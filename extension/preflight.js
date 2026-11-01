"use strict";

/**
 * Preflight: what has to be true before setup touches a file or starts a process.
 *
 * 0.3.5 started external tool runs first and reported whatever broke afterwards, which left operators
 * with a generic failure and a lock file they had to delete by hand. 0.3.6 checks the workspace,
 * the host tools, the managed paths and the setup lock up front, and each failure names the
 * action that clears it.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { MANAGED_FOLDER, isReparsePoint } = require("./runtime");
const { resolveHostTool, resolverFrom } = require("./hosttools");

const LOCK_NAME = ".setup.lock";
const STALE_BY_PID_AFTER_MS = 60000;
const DAMAGED_LOCK_AFTER_MS = 60000;
const DEFAULT_SETUP_WINDOW_MS = 15 * 60 * 1000;
const SETUP_WINDOW_MARGIN_MS = 5 * 60 * 1000;

function lockPath(root) {
  return path.join(path.resolve(root), MANAGED_FOLDER, LOCK_NAME);
}

/**
 * How long a setup may legitimately hold the lock.
 *
 * A plan holds one lock for every step, and a step may be attempted twice, so the window is the
 * plan's own bound — each selected step's timeout (or the operator's override, whichever is
 * longer) doubled — plus a margin for the verification that follows each step.
 */
function setupWindowMs(settings = {}, steps = []) {
  const override = Number(settings.setupTimeoutSeconds);
  const planMs = (steps || []).reduce((sum, step) => {
    const base = Number(step.timeoutSeconds) || 120;
    const seconds = Number.isFinite(override) ? Math.min(3600, Math.max(60, Math.max(base, override))) : base;
    return sum + seconds * 1000;
  }, 0);
  return Math.max(DEFAULT_SETUP_WINDOW_MS, planMs * 2 + SETUP_WINDOW_MARGIN_MS);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

/**
 * Classify the setup lock.
 *
 * A lock whose owning process is still running is always live, however old the file looks: a long
 * setup legitimately holds one lock for the whole plan, and removing it would let a second setup
 * write into the same managed worker at the same time. A lock is `stale` only when its owner is
 * gone, or when its contents cannot be read and it has been sitting for longer than a write takes.
 * Anything else is treated as a live setup and setup refuses to interleave with it.
 */
async function inspectLock(root, { now = Date.now(), setupWindowMs = DEFAULT_SETUP_WINDOW_MS } = {}) {
  const file = lockPath(root);
  let info;
  try { info = await fs.lstat(file); } catch (error) {
    if (error.code === "ENOENT") return { state: "free", path: file };
    throw error;
  }
  if (!info.isFile()) return { state: "invalid", path: file, ageMs: null, ownerPid: null, damaged: true, reason: "not a regular file" };
  let record = null;
  try { record = JSON.parse(await fs.readFile(file, "utf8")); } catch { record = null; }
  const startedAt = record && record.startedAt ? Date.parse(record.startedAt) : null;
  // A lock that cannot be read (a crash between creating the file and writing its contents) is
  // aged by the file's own modification time, so it is not immortal.
  const ageMs = Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : Math.max(0, now - info.mtimeMs);
  const ownerPid = record && Number.isInteger(record.pid) ? record.pid : null;
  const ownerAlive = pidAlive(ownerPid);
  const damaged = record === null || ownerPid === null;
  const olderThanWindow = ageMs > setupWindowMs;
  if (olderThanWindow) {
    // The window is the authority here: a pid recorded long ago may belong to another process now,
    // and re-checking it must not make the lock immortal.
    return { state: "stale", staleByWindow: true, path: file, ageMs, ownerPid, reason: `older than the ${Math.round(setupWindowMs / 60000)} minute setup window` };
  }
  if (ownerAlive) {
    return { state: "held", path: file, ageMs, ownerPid, reason: `held by the running process ${ownerPid}` };
  }
  if (ageMs > (damaged ? DAMAGED_LOCK_AFTER_MS : STALE_BY_PID_AFTER_MS)) {
    return {
      state: "stale", path: file, ageMs, ownerPid,
      reason: damaged ? "unreadable and older than a minute" : `left behind by process ${ownerPid}, which is no longer running`,
    };
  }
  return {
    state: "held", path: file, ageMs, ownerPid, damaged,
    reason: damaged && ageMs <= DAMAGED_LOCK_AFTER_MS
      ? "unreadable and only seconds old, so a setup may be writing it now"
      : "held by a setup that is running or was interrupted recently",
  };
}

async function checkWritable(directory) {
  try { await fs.access(directory, fs.constants.W_OK); return true; } catch { return false; }
}

/** Tools the selected steps need, taken from the component registry rather than from prose. */
function requiredTools(steps) {
  const tools = new Set();
  for (const step of steps) for (const tool of step.hostTools || []) tools.add(tool);
  return [...tools];
}

async function runPreflight({ vscode, folder, steps, settings = {}, services = {}, roots }) {
  const checks = [];
  const add = (check) => { checks.push(check); return check; };
  const workspaceFolders = (vscode.workspace.workspaceFolders || []).filter((item) => item.uri.scheme === "file").map((item) => item.uri.fsPath);
  const root = folder && folder.uri.scheme === "file" ? folder.uri.fsPath : null;
  const searchRoots = roots || workspaceFolders;

  if (!vscode.workspace.isTrusted) {
    add({ id: "trust", label: "Workspace trust", status: "fail", detail: "This workspace is not trusted. Setup writes and process execution are blocked by the editor.", action: "Trust this workspace folder, then run setup again." });
  } else {
    add({ id: "trust", label: "Workspace trust", status: "ok", detail: "This workspace folder is trusted." });
  }

  if (vscode.env.remoteName || !root) {
    add({ id: "local", label: "Local desktop workspace", status: "fail", detail: vscode.env.remoteName ? `The workspace is opened remotely (${vscode.env.remoteName}); components would be installed on a different machine.` : "No workspace folder is open.", action: "Open a local folder on this machine and run setup there." });
  } else {
    add({ id: "local", label: "Local desktop workspace", status: "ok", detail: `Setup will run in ${root}.` });
  }

  const hostTools = [];
  for (const name of requiredTools(steps)) {
    const resolve = resolverFrom(services);
    const tool = await resolve(name, {
      roots: searchRoots,
      configuredPath: name === "uv" ? settings.uvPath : undefined,
      minimumVersion: (settings.minimumVersions || {})[name],
      managedDir: settings.managedToolDir,
    });
    hostTools.push(tool);
    add({
      id: `host-tool-${name}`,
      label: `${name} on this machine`,
      status: tool.verified ? "ok" : "fail",
      detail: tool.verified ? `${name} ${tool.version || "version not reported"} resolved from ${tool.source}: ${tool.path}`
        : `${tool.reason}${tool.searched ? ` Searched ${tool.searched.pathEntries} PATH entr(ies) and ${tool.searched.knownLocations} documented location(s).` : ""}`,
      action: tool.hint,
    });
  }

  if (root) {
    const managed = path.join(path.resolve(root), MANAGED_FOLDER);
    const managedExists = await fs.stat(managed).catch(() => null);
    const linkFound = [];
    for (const candidate of [path.join(path.resolve(root), ".research-toolkit"), managed]) {
      if (await isReparsePoint(candidate)) linkFound.push(candidate);
    }
    add(linkFound.length
      ? { id: "managed-path", label: "Managed toolkit paths", status: "fail", detail: `${linkFound.join(", ")} is a link or junction.`, action: "Replace it with a real directory; setup never writes through links." }
      : { id: "managed-path", label: "Managed toolkit paths", status: "ok", detail: managedExists ? `${managed} is a real directory.` : `${MANAGED_FOLDER} does not exist yet and will be created inside the workspace.` });

    const writableTarget = managedExists ? managed : path.resolve(root);
    add(await checkWritable(writableTarget)
      ? { id: "managed-writable", label: "Workspace is writable", status: "ok", detail: `${writableTarget} accepts writes.` }
      : { id: "managed-writable", label: "Workspace is writable", status: "fail", detail: `${writableTarget} is not writable by the editor process.`, action: "Check folder permissions, read-only media or antivirus protection, then retry." });
  } else {
    add({ id: "managed-path", label: "Managed toolkit paths", status: "n-a", detail: "No local workspace to inspect." });
    add({ id: "managed-writable", label: "Workspace is writable", status: "n-a", detail: "No local workspace to inspect." });
  }

  const lock = root ? await inspectLock(root, { setupWindowMs: settings.setupWindowMs || setupWindowMs(settings) }) : { state: "n-a", path: null };
  add({
    id: "setup-lock",
    label: "Setup lock",
    status: lock.state === "free" || lock.state === "n-a" ? "ok" : lock.state === "stale" ? "warn" : "fail",
    detail: lock.state === "free" ? "No setup is running."
      : lock.state === "n-a" ? "No local workspace to inspect."
      : `${lock.path} is ${lock.reason}${lock.ageMs !== null ? ` (${Math.round(lock.ageMs / 1000)} s)` : ""}.`,
    action: lock.state === "stale" ? "Run Clear interrupted setup lock; it removes only that file."
      : lock.state === "invalid" ? `Remove ${lock.path} manually: it is not a lock file the toolkit wrote.`
      : lock.ownerPid ? `Close the editor window or process ${lock.ownerPid} that is holding the setup, then run Clear interrupted setup lock.`
      : "Wait for the running setup to finish.",
  });

  const blockers = checks.filter((check) => check.status === "fail").map((check) => check.id);
  return { ok: blockers.length === 0, checks, blockers, hostTools, lock };
}

/** Remove one reviewed file, and only when it is classified stale. */
async function clearStaleLock(root, options = {}) {
  const lock = await inspectLock(root, options);
  if (lock.state === "free") return { removed: false, lock, message: "No setup lock exists in this workspace." };
  if (lock.state === "held") return { removed: false, lock, message: `A setup appears to be running (${lock.reason}). Nothing was removed.` };
  const info = await fs.lstat(lock.path).catch(() => null);
  if (!info) return { removed: false, lock, message: "The setup lock disappeared before it could be removed." };
  // A link at the lock path is removed as a link, never through it. A directory is not the
  // toolkit's file to delete, so it is named instead.
  if (info.isDirectory()) return { removed: false, lock, message: `${lock.path} is a directory, not the toolkit's lock file. Remove that directory yourself if it is not yours.` };
  if (!lock.staleByWindow && pidAlive(lock.ownerPid)) return { removed: false, lock, message: `Process ${lock.ownerPid} is running again; the lock was kept.` };
  await fs.rm(lock.path, { force: true });
  return { removed: true, lock, message: `Removed the interrupted setup lock ${lock.path}.` };
}

module.exports = {
  LOCK_NAME, STALE_BY_PID_AFTER_MS, DAMAGED_LOCK_AFTER_MS, SETUP_WINDOW_MARGIN_MS, DEFAULT_SETUP_WINDOW_MS,
  lockPath, setupWindowMs, inspectLock, runPreflight, clearStaleLock, requiredTools, pidAlive,
};
