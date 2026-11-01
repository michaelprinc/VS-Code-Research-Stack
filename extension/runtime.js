"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { runProcess, asRunProcess } = require("./runner");
const { resolverFrom } = require("./hosttools");
const WORKER_VERSION = "0.3.6";
// The managed worker folder name is derived from the version so a release cannot leave one stale.
const WORKER_FOLDER = `.research-toolkit/managed/worker-${WORKER_VERSION}`;
const componentCatalog = require("./components.json");
/** The version floor a host tool must clear is registry data, not a code literal. */
const minimumVersionFor = (name) => (componentCatalog.components.find((item) => item.id === name) || {}).minimumVersion || null;
const digest = (content) => createHash("sha256").update(content).digest("hex");
const WORKER_PATH = /^(pyproject\.toml|uv\.lock|\.python-version|README\.md|src\/research_stack\/[a-z_]+\.py)$/;
const OVERLAY_PATH = /^(\.github\/skills\/[a-z0-9-]+\/SKILL\.md|\.research-toolkit\/recommended-profile\.json|notebooks\/analysis\/(pyproject\.toml|uv\.lock|\.python-version)|notebooks\/[a-z0-9-]+\.ipynb|research\/README\.md)$/;
function under(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
/**
 * True when `target` is reached through a symlink or a Windows junction/reparse point.
 * Node's lstat reports a junction as an ordinary directory, so the check compares the
 * resolved location against the resolved parent plus the final name.
 */
async function isReparsePoint(target) {
  try {
    const info = await fs.lstat(target);
    if (info.isSymbolicLink()) return true;
    if (!info.isDirectory()) return false;
    const resolved = await fs.realpath(target);
    const parentResolved = await fs.realpath(path.dirname(target));
    return path.resolve(parentResolved, path.basename(target)) !== path.resolve(resolved);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function assertRealPath(root, relative) {
  let current = path.resolve(root);
  for (const part of String(relative).split("/")) {
    current = path.join(current, part);
    if (await isReparsePoint(current)) throw new Error(`${current} is a link or junction. Toolkit setup writes stay in real workspace paths; replace it with a real directory or choose another location.`);
  }
  return current;
}
function requireLocal(vscode, folder) {
  if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before setting up or reading documents.");
  if (vscode.env.remoteName || !folder || folder.uri.scheme !== "file") throw new Error("Open a local desktop workspace folder for setup and reading checks.");
  return folder.uri.fsPath;
}
async function directory(root, relative, create = false) {
  let current = await fs.realpath(root);
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (create) await fs.mkdir(current).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Toolkit managed paths must be real directories, not links or files. Existing files were preserved.");
  }
  return current;
}
/** Read and integrity-check the reviewed worker source and workspace overlay templates. */
async function bundle(context) {
  const root = path.join(context.extensionUri.fsPath, "worker");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "bundle.json"), "utf8"));
  if (manifest.schemaVersion !== 2 || manifest.workerVersion !== WORKER_VERSION) throw new Error("Unsupported worker bundle. Reinstall the VSIX.");
  for (const [group, pattern] of [["files", WORKER_PATH], ["overlayFiles", OVERLAY_PATH]]) {
    for (const [relative, expected] of Object.entries(manifest[group] || {})) {
      if (!pattern.test(relative) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid ${group} inventory in the worker bundle.`);
      const source = group === "overlayFiles" ? path.join(root, "overlay", relative) : path.join(root, relative);
      if (digest(await fs.readFile(source)) !== expected) throw new Error(`Bundled ${group === "overlayFiles" ? "overlay" : "worker"} integrity check failed. Reinstall the VSIX.`);
    }
  }
  return { root, manifest };
}
async function validateWorker(worker, manifest) {
  for (const [relative, expected] of Object.entries(manifest.files)) {
    await directory(worker, path.dirname(relative).replace(/\\/g, "/"));
    const destination = path.join(worker, relative);
    if ((await fs.lstat(destination)).isSymbolicLink() || digest(await fs.readFile(destination)) !== expected) throw new Error("Managed worker source was changed. Existing files were preserved; use a fresh workspace or move the managed worker aside before retrying setup.");
  }
}
async function managedRuntime(context, folder) {
  if (!folder || folder.uri.scheme !== "file") return undefined;
  let worker;
  try { worker = await directory(folder.uri.fsPath, WORKER_FOLDER); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
  const { manifest } = await bundle(context);
  await validateWorker(worker, manifest);
  let receipt;
  try {
    const receiptPath = path.join(worker, "installation.json");
    if ((await fs.lstat(receiptPath)).isSymbolicLink()) throw new Error("Setup receipt must not be a link.");
    receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  }
  catch (error) { if (error.code === "ENOENT") return undefined; throw new Error("Invalid setup receipt. Retry Set up package components."); }
  if (receipt.workerVersion !== manifest.workerVersion) return undefined;
  await directory(worker, ".venv");
  await directory(worker, process.platform === "win32" ? ".venv/Scripts" : ".venv/bin");
  const python = path.join(worker, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!(await fs.stat(python)).isFile()) throw new Error("Managed Python is missing. Retry Set up package components.");
  return { worker, python, version: manifest.workerVersion, receipt };
}
const MANAGED_FOLDER = ".research-toolkit/managed";
const ACTIVE_POINTER_NAME = "active.json";
const WORKER_FOLDER_PATTERN = /^worker-(\d+\.\d+\.\d+)$/;

async function readJsonFile(file) {
  try {
    const info = await fs.lstat(file);
    // A link is not evidence, and a directory or unreadable JSON where a record is expected
    // is reported as "no readable record" instead of crashing the workspace inspection.
    if (info.isSymbolicLink() || info.isDirectory()) return null;
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Which managed runtimes this workspace holds, including ones an earlier release installed. */
async function discoverRuntimes(root) {
  const managed = path.join(path.resolve(root), MANAGED_FOLDER);
  let entries;
  try { entries = await fs.readdir(managed, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return { managed, runtimes: [], active: null }; throw error; }
  const pointer = await readJsonFile(path.join(managed, ACTIVE_POINTER_NAME));
  const runtimes = [];
  for (const entry of entries) {
    const match = entry.name.match(WORKER_FOLDER_PATTERN);
    if (!match) continue;
    const folder = path.join(managed, entry.name);
    const receipt = await readJsonFile(path.join(folder, "installation.json"));
    runtimes.push({
      version: match[1],
      folder,
      current: match[1] === WORKER_VERSION,
      recordedAt: receipt && receipt.updatedAt ? receipt.updatedAt : null,
      verified: Boolean(receipt && receipt.checks && receipt.checks.ok),
      active: Boolean(pointer && pointer.version === match[1]),
      thisRelease: match[1] === WORKER_VERSION,
    });
  }
  runtimes.sort((a, b) => (a.recordedAt || "").localeCompare(b.recordedAt || ""));
  return { managed, runtimes, active: pointer && pointer.version ? pointer : null };
}

/** Record which managed runtime the toolkit should use, atomically, keeping the prior entry. */
async function activateRuntime(managed, { version, folder, previousVersion, reason }) {
  await fs.mkdir(managed, { recursive: true });
  const pointerPath = path.join(managed, ACTIVE_POINTER_NAME);
  const payload = JSON.stringify({
    schemaVersion: 1,
    version,
    folder,
    activatedAt: new Date().toISOString(),
    previousVersion: previousVersion || null,
    reason: reason || "verified-setup",
  }, null, 2) + "\n";
  JSON.parse(payload);
  const temporary = path.join(managed, `${ACTIVE_POINTER_NAME}.${process.pid}.tmp`);
  try {
    await fs.writeFile(temporary, payload, { flag: "wx" });
    await fs.rename(temporary, pointerPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return pointerPath;
}

/**
 * Point the workspace back at a runtime an earlier release verified. The candidate is
 * re-verified by running the real functional check with its own interpreter before it is
 * activated, so a rollback is evidence and not a guess.
 */
async function rollbackRuntime(vscode, context, folder, version, services = {}) {
  const root = requireLocal(vscode, folder);
  const discovered = await discoverRuntimes(root);
  const candidate = discovered.runtimes.find((item) => item.version === version);
  if (!candidate) throw new Error(`No managed runtime ${version} exists in this workspace. Nothing was changed.`);
  if (candidate.active) throw new Error(`Runtime ${version} is already the active one.`);
  const python = path.join(candidate.folder, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!(await fs.stat(python).catch(() => null))) throw new Error(`Runtime ${version} has no interpreter in this workspace. Run Set up package components instead.`);
  const check = await functionalCheck(context, { worker: candidate.folder, python, version: candidate.version }, folder, undefined, services);
  const pointerPath = await activateRuntime(discovered.managed, {
    version: candidate.version, folder: candidate.folder, previousVersion: discovered.active && discovered.active.version,
    reason: "rollback-verified",
  });
  return { version: candidate.version, folder: candidate.folder, pointer: pointerPath, check, previousVersion: discovered.active && discovered.active.version || null };
}

async function functionalCheck(context, runtime, folder, document, services = {}) {
  const args = ["-I", "-B", path.join(context.extensionUri.fsPath, "functional_check.py")];
  if (document) {
    const root = await fs.realpath(folder.uri.fsPath);
    const resolved = await fs.realpath(document);
    if (!under(root, resolved) || !/\.(pdf|docx)$/i.test(resolved)) throw new Error("Choose a PDF or DOCX inside the selected workspace. Outside files and links outside the workspace cannot be read.");
    if ((await fs.stat(resolved)).size > 50 * 1024 * 1024) throw new Error("Choose a document smaller than 50 MiB.");
    args.push("--workspace", root, "--document", path.relative(root, resolved));
  }
  const executed = await asRunProcess(services)(runtime.python, args, { timeout: 90000, captureJsonFailure: true, signal: services.signal });
  let result;
  try { result = JSON.parse(executed.stdout); if (typeof result.ok !== "boolean") throw new Error(); }
  catch { throw new Error("Worker returned invalid check data. Retry setup; no runtime output was copied."); }
  if (!result.ok) throw new Error(result.detail || "Reading check failed.");
  return { ...result, checkedAt: new Date().toISOString(), scope: document ? "Selected workspace document" : "Temporary synthetic fixtures through real local stdio MCP" };
}
/**
 * One setup at a time per workspace. The caller that runs a multi-step plan holds the lock
 * for the whole plan; a standalone setup call takes it for its own duration.
 *
 * The claim and its contents are written in one call: a crash between creating the file and
 * recording its owner is what left operators with an unidentifiable lock in 0.3.5.
 */
async function acquireSetupLock(managed) {
  await fs.mkdir(managed, { recursive: true });
  const lockFile = path.join(managed, ".setup.lock");
  try {
    await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("Another setup is running, or a prior setup left a lock behind. Run Clear interrupted setup lock; it removes only a lock whose owning process is gone.");
    throw error;
  }
  return { lockPath: lockFile, release: async () => { await fs.rm(lockFile, { force: true }); } };
}

/**
 * Install/refresh the isolated worker project only. The component receipt is written by
 * the installer engine so that a multi-step plan stays resumable after a failure.
 */
async function setupRuntime(vscode, context, folder, services = {}) {
  const root = requireLocal(vscode, folder);
  const { root: source, manifest } = await bundle(context);
  // The host tool is resolved by the caller (the worker step / preflight) so the same resolution
  // result is reported in the GUI and in the setup log. A raw name lookup is kept only for callers
  // that did not resolve one, and it now searches the documented locations too.
  const tools = (vscode.workspace.workspaceFolders || []).filter((item) => item.uri.scheme === "file").map((item) => item.uri.fsPath);
  let uv = services.uv;
  if (!uv) {
    const resolved = await resolverFrom(services)("uv", {
      roots: tools,
      configuredPath: services.settings && services.settings.uvPath,
      managedDir: services.settings && services.settings.managedToolDir,
      minimumVersion: minimumVersionFor("uv"),
    });
    if (!resolved.verified) throw new Error(`${resolved.reason} ${resolved.hint} No packages were changed.`);
    uv = resolved.path;
  }
  const managed = await directory(root, MANAGED_FOLDER, true);
  const prior = await discoverRuntimes(root);
  const lock = services.lockHeld ? null : await acquireSetupLock(managed);
  try {
    if (await isReparsePoint(managed)) throw new Error(`Managed setup path ${MANAGED_FOLDER} is a link or junction. Nothing was written; replace it with a real directory and retry.`);
    const worker = await directory(root, WORKER_FOLDER, true);
    if (await isReparsePoint(worker)) throw new Error(`Managed worker path ${WORKER_FOLDER} is a link or junction. Nothing was written; replace it with a real directory and retry.`);
    services.progress?.("Preparing the reviewed worker source and dependency lock…");
    for (const [relative, expected] of Object.entries(manifest.files)) {
      await directory(worker, path.dirname(relative).replace(/\\/g, "/"), true);
      const destination = path.join(worker, relative);
      const content = await fs.readFile(path.join(source, relative));
      try { await fs.writeFile(destination, content, { flag: "wx" }); }
      catch (error) {
        if (error.code !== "EEXIST") throw error;
        if ((await fs.lstat(destination)).isSymbolicLink() || digest(await fs.readFile(destination)) !== expected) throw new Error("Managed worker files differ from this release. Existing files were preserved; move that managed worker aside or select a fresh workspace.");
      }
    }
    // Only this reviewed project is synced. Never use the research project's .venv/config.
    try { await directory(worker, ".venv"); await directory(worker, process.platform === "win32" ? ".venv/Scripts" : ".venv/bin"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    services.progress?.("Installing locked worker dependencies with Python 3.12. This can download packages…");
    await asRunProcess(services)(uv, ["sync", "--locked", "--no-dev", "--python", "3.12", "--project", worker, "--no-config"], {
      // Same rule as every other step: the registry floor and the operator override, whichever is
      // longer. A short override must not cut a downloading sync below the reviewed bound.
      timeout: Math.max(((Number((componentCatalog.installSteps || []).find((item) => item.id === "worker") || {}).timeoutSeconds) || 900) * 1000,
        Number.isFinite(Number(services.setupTimeoutMs)) ? Number(services.setupTimeoutMs) : 0),
      cwd: worker, signal: services.signal, kind: "setup", retry: true,
      hint: "The first run can download a managed Python 3.12 and the locked packages.",
    });
    const python = path.join(worker, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    services.progress?.("Verifying MCP discovery, PDF/DOCX reading, reports, local search and RIS preparation…");
    const runtime = { worker, python, version: manifest.workerVersion };
    const check = await functionalCheck(context, runtime, folder, undefined, services);
    // The verified runtime becomes active only after the real check passes; a runtime an
    // earlier release left in place stays on disk and remains selectable for rollback.
    const pointer = await activateRuntime(managed, {
      version: manifest.workerVersion,
      folder: worker,
      previousVersion: prior.active && prior.active.version !== manifest.workerVersion ? prior.active.version : null,
      reason: "verified-setup",
    });
    return { ...runtime, check, pointer, priorRuntimes: prior.runtimes.filter((item) => item.version !== manifest.workerVersion) };
  } finally {
    if (lock) await lock.release();
  }
}

module.exports = {
  WORKER_FOLDER, WORKER_VERSION, MANAGED_FOLDER, ACTIVE_POINTER_NAME, minimumVersionFor,
  requireLocal, managedRuntime, setupRuntime, functionalCheck, bundle, directory,
  isReparsePoint, assertRealPath, discoverRuntimes, activateRuntime, rollbackRuntime, acquireSetupLock,
};
