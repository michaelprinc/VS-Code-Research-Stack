"use strict";

/**
 * The component steps themselves.
 *
 * Each step is one function with one job, so the plan engine in `installer.js` no longer carries
 * four different installation implementations. A step either returns what it produced, or throws
 * an error whose text comes from the runner's captured exit code and stderr.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { bundle, directory, isReparsePoint, managedRuntime, setupRuntime, WORKER_FOLDER, minimumVersionFor } = require("./runtime");
const { resolverFrom } = require("./hosttools");
const { runProcess, asRunProcess } = require("./runner");
const { pairProblems } = require("./lockfile");

const NOTEBOOK_PROJECT_NAME = "research-stack-analysis";
const NOTEBOOK_DEPENDENCIES = ["ipykernel", "matplotlib"];

function digestOf(content) { return crypto.createHash("sha256").update(content).digest("hex"); }

/** Timeout for a step: registry value, or the operator override, whichever is longer. */
function stepTimeout(step, settings = {}) {
  const override = Number(settings.setupTimeoutSeconds);
  const base = Number(step.timeoutSeconds) || 120;
  const seconds = Number.isFinite(override) ? Math.min(3600, Math.max(60, Math.max(base, override))) : base;
  return seconds * 1000;
}

async function resolveUv({ vscode, services = {}, settings = {}, roots }) {
  if (services.uv) return typeof services.uv === "string" ? { path: services.uv, name: "uv", version: null, source: "provided" } : services.uv;
  const resolve = resolverFrom(services);
  const folders = roots || ((vscode && vscode.workspace && vscode.workspace.workspaceFolders) || [])
    .filter((item) => item.uri.scheme === "file").map((item) => item.uri.fsPath);
  const tool = await resolve("uv", {
    roots: folders,
    configuredPath: settings.uvPath,
    minimumVersion: (settings.minimumVersions || {}).uv,
  });
  if (!tool.verified) {
    const error = new Error(`${tool.reason} ${tool.hint}`);
    error.resolution = tool;
    throw error;
  }
  return tool;
}

/**
 * Identify the notebook project before any package manager runs. An unrelated or incompatible
 * project is not synced; a compatible existing project is reported as existing.
 */
async function inspectNotebookProject(project) {
  const pyproject = path.join(project, "pyproject.toml");
  let text;
  try {
    if ((await fs.lstat(pyproject)).isSymbolicLink()) return { owned: false, reason: "pyproject.toml is a link" };
    text = await fs.readFile(pyproject, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { owned: true, existingProject: false };
    throw error;
  }
  const name = text.match(/name\s*=\s*"([^"]+)"/);
  const projectName = name ? name[1] : null;
  const missing = NOTEBOOK_DEPENDENCIES.filter((dependency) => !new RegExp(`"${dependency}(?:[\\[<>=~!^][^"]*)?"`).test(text));
  if (missing.length) return { owned: false, reason: `it does not declare ${missing.join(" and ")}` };
  if (projectName && projectName !== NOTEBOOK_PROJECT_NAME) {
    return {
      owned: true, existingProject: true, reviewedProject: false, projectName,
      note: `project name "${projectName}" is not the reviewed "${NOTEBOOK_PROJECT_NAME}", but it declares ${NOTEBOOK_DEPENDENCIES.join(" and ")}: kept as a compatible existing project`,
    };
  }
  return { owned: true, existingProject: true, reviewedProject: true, projectName: projectName || NOTEBOOK_PROJECT_NAME };
}

/** Overlay files belong to two steps; the mapping is by reviewed path prefix. */
function overlayStepFor(relative) {
  return relative.startsWith("notebooks/analysis/") ? "notebook-env" : "research-overlay";
}

async function writeOverlayFiles(context, root, stepId, services) {
  const { root: source, manifest } = await bundle(context);
  const created = [];
  const current = [];
  const modifiedPreserved = [];
  for (const [relative, expected] of Object.entries(manifest.overlayFiles || {})) {
    if (overlayStepFor(relative) !== stepId) continue;
    const destination = path.join(root, relative);
    await directory(root, path.dirname(relative).replace(/\\/g, "/"), true);
    const content = await fs.readFile(path.join(source, "overlay", relative));
    if (digestOf(content) !== expected) throw new Error(`Bundled overlay integrity check failed for ${relative}. Reinstall the VSIX.`);
    try {
      await fs.writeFile(destination, content, { flag: "wx" });
      created.push(relative);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((await fs.lstat(destination)).isSymbolicLink()) throw new Error(`Existing overlay path is a link: ${relative}. Nothing was written.`);
      const existing = await fs.readFile(destination);
      (digestOf(existing) === expected ? current : modifiedPreserved).push(relative);
    }
  }
  services.progress?.(stepId === "notebook-env" ? "Prepared the reviewed notebook project files." : "Prepared the reviewed research overlay files.");
  return { created, preserved: [...current, ...modifiedPreserved], current, modifiedPreserved };
}

function overlayEvidence(overlay) {
  const parts = [`${overlay.created.length} overlay file(s) created`, `${overlay.current.length} unchanged file(s) preserved`];
  if (overlay.modifiedPreserved.length) parts.push(`${overlay.modifiedPreserved.length} file(s) changed by you and preserved (they differ from this release)`);
  return `${parts.join(", ")}.`;
}

/**
 * A fallback install is not a clean install: the drift stays visible in the component evidence so the
 * panel, the receipt and the copied diagnostics all name it.
 */
function lockFallbackNote(fallback) {
  if (!fallback) return "";
  return ` Warning: this host's uv refused the shipped lockfile (${fallback.uvMessage || "the lockfile did not match the project file"}); the toolkit installed exactly the packages that lock pins, without rewriting the lockfile. Report this if it repeats.`;
}

async function runWorkerStep({ vscode, context, folder, services, settings }) {
  const uv = await resolveUv({ vscode, services, settings });
  const result = await setupRuntime(vscode, context, folder, { ...services, uv: uv.path });
  return {
    toolkitVersion: result.version,
    evidence: `Locked worker synced with ${uv.path} (${uv.version || "version not reported"}) and verified through real local MCP reading, reports, search and RIS preparation.${lockFallbackNote(result.lockFallback)}`,
    worker: result.worker,
    python: result.python,
    check: result.check,
    lockFallback: result.lockFallback || null,
    hostTool: { name: "uv", path: uv.path, version: uv.version, source: uv.source },
  };
}

async function runResearchOverlayStep({ context, root, services }) {
  const overlay = await writeOverlayFiles(context, root, "research-overlay", services);
  const { manifest } = await bundle(context);
  return { toolkitVersion: manifest.workerVersion, evidence: overlayEvidence(overlay), overlay };
}

/** Read the notebook project's own pair from disk. A reader failure is reported as a problem. */
async function notebookPairProblems(project) {
  try {
    return pairProblems(
      await fs.readFile(path.join(project, "pyproject.toml"), "utf8"),
      await fs.readFile(path.join(project, "uv.lock"), "utf8"),
    );
  } catch (error) {
    return [`the notebook project's dependency files could not be read (${String((error && error.message) || error)})`];
  }
}

async function runNotebookStep({ root, context, services, settings, step, vscode }) {
  // The same roots the preflight used: a uv that lives inside the workspace must not be executed
  // here after the resolver refused it.
  const uv = await resolveUv({ vscode, services, settings, root });
  const project = path.join(root, "notebooks", "analysis");
  const ownership = await inspectNotebookProject(project);
  if (!ownership.owned) throw new Error(`notebooks/analysis already holds a project this toolkit does not own (${ownership.reason}). Nothing was synced or overwritten. Move that project aside, or remove the folder if it is not yours.`);
  const overlay = await writeOverlayFiles(context, root, "notebook-env", services);
  if (await isReparsePoint(project)) throw new Error("notebooks/analysis is a link or junction. No package manager was run inside it.");
  // The pair just written is the pair uv is about to be pointed at. The worker tree is self-checked
  // in `setupRuntime`; this project is written straight into the workspace, so it is checked here.
  const drift = await notebookPairProblems(project);
  if (drift.length) {
    const error = new Error(`The notebook analysis project this toolkit wrote has a locked dependency file that does not match its own project file: ${drift.join("; ")}. uv was not run. This is a defect in the toolkit build, not in this workspace.`);
    error.lockDrift = { source: "notebook", problems: drift };
    throw error;
  }
  services.progress?.("Creating the locked notebook analysis environment. This can download packages…");
  const run = await asRunProcess(services)(uv.path, ["sync", "--locked", "--no-dev", "--python", "3.12", "--project", project, "--no-config"], {
    timeout: stepTimeout(step, settings), cwd: project, signal: services.signal, kind: "setup", retry: true,
    hint: "The notebook environment is separate from the MCP worker.",
  });
  const executable = path.join(project, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!(await fs.stat(executable).catch(() => null)) || !(await fs.stat(executable)).isFile()) {
    const error = new Error(`uv sync finished (exit 0) but ${path.relative(root, executable)} does not exist. The notebook environment was not created; retry the notebook step.`);
    error.missingArtifact = path.relative(root, executable);
    throw error;
  }
  if (await isReparsePoint(path.join(project, ".venv"))) throw new Error("notebooks/analysis/.venv is a link or junction pointing outside the workspace. The environment was not accepted.");
  const imports = await asRunProcess(services)(executable, ["-I", "-B", "-c", "import ipykernel, matplotlib, sys; print(sys.version)"], {
    timeout: 120000, cwd: project, signal: services.signal,
  });
  const pythonVersion = String(imports.stdout || "").trim().split("\n")[0];
  const { manifest } = await bundle(context);
  const ownershipNote = ownership.reviewedProject === false ? `${ownership.note}. ` : "";
  return {
    toolkitVersion: manifest.workerVersion,
    evidence: `${ownershipNote}Locked notebooks/analysis environment created (${overlayEvidence(overlay)} Interpreter verified: ${pythonVersion || "version not reported"}; ipykernel and matplotlib import. Kernel not started by this step.`,
    overlay, python: executable, importsVerified: true, pythonVersion,
    syncDurationMs: run.durationMs,
    existingProject: ownership.existingProject || false,
    reviewedProject: ownership.reviewedProject !== false,
    projectName: ownership.projectName || NOTEBOOK_PROJECT_NAME,
    hostTool: { name: "uv", path: uv.path, version: uv.version, source: uv.source },
  };
}

async function runLabStoreStep({ root, context, folder, services, settings, step }) {
  const runtime = await managedRuntime(context, folder);
  if (!runtime) throw new Error("Set up the isolated worker before the corpus index and record store step.");
  services.progress?.("Initialising the workspace corpus index and research record store…");
  const payload = await asRunProcess(services)(runtime.python, ["-I", "-B", "-m", "research_stack.cli", "init-lab", "--workspace", root], {
    timeout: stepTimeout(step, settings), cwd: root, signal: services.signal,
  });
  let result;
  try { result = JSON.parse(payload.stdout); } catch { throw new Error("The worker returned invalid store-initialisation data. No store file was replaced."); }
  if (!result || result.ok !== true || !result.store) throw new Error((result && result.error) || "Corpus index and record store initialisation failed.");
  return { toolkitVersion: runtime.version, evidence: `SQLite record store initialised at ${result.store} with schema ${result.schemaVersion}; ${result.tableCount} tables.`, store: result.store, schemaVersion: result.schemaVersion, tableCount: result.tableCount, profile: result.profile };
}

const STEP_RUNNERS = {
  worker: runWorkerStep,
  "research-overlay": runResearchOverlayStep,
  "notebook-env": runNotebookStep,
  "lab-store": runLabStoreStep,
};

async function runStep({ step, vscode, context, folder, root, services = {}, settings = {} }) {
  const runner = STEP_RUNNERS[step.id];
  if (!runner) throw new TypeError(`Unknown component step: ${step.id}`);
  return runner({ step, vscode, context, folder, root, services, settings });
}

module.exports = {
  NOTEBOOK_PROJECT_NAME, NOTEBOOK_DEPENDENCIES, WORKER_FOLDER,
  digestOf, stepTimeout, resolveUv, inspectNotebookProject, overlayStepFor, writeOverlayFiles, overlayEvidence, lockFallbackNote, notebookPairProblems,
  runWorkerStep, runResearchOverlayStep, runNotebookStep, runLabStoreStep, runStep, STEP_RUNNERS,
};
