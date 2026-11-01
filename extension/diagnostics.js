"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const catalog = require("./components.json");
// 0.3.6: this module no longer spawns processes or searches for host executables itself.
// Both concerns live in runner.js (the single reviewed process boundary) and hosttools.js.
const { runFile } = require("./runner");
const { resolveHostTool, resolverFrom } = require("./hosttools");

function baseInventory(vscode, context) {
  const components = catalog.components.map((item) => ({
    ...item, installed: "Not checked", version: null, readiness: "Not checked",
    evidence: "Run Check components to inspect the selected workspace.",
    installMode: item.install.mode, installStep: item.install.step, installable: item.install.mode === "managed" && Boolean(item.install.step),
    toolkitVersion: item.install.toolkitVersion || null, nextAction: item.nextAction,
  }));
  const set = (id, values) => Object.assign(components.find((item) => item.id === id), values);
  set("toolkit", { installed: "Installed", version: context.extension.packageJSON.version, readiness: "Ready", evidence: "This extension is running in the current VS Code Extension Host." });
  set("vscode-desktop", { installed: "Installed", version: vscode.version, readiness: "Ready", evidence: "Current editor host; external tools can be on a different remote machine." });
  for (const [id, candidates] of [
    ["vscode-python-extension", ["ms-python.python"]],
    ["vscode-jupyter-extension", ["ms-toolsai.jupyter"]],
    ["github-copilot", ["GitHub.copilot", "GitHub.copilot-chat"]],
  ]) {
    const found = candidates.map((name) => vscode.extensions.getExtension(name)).filter(Boolean);
    set(id, found.length ? {
      installed: "Installed", version: found.map((item) => `${item.id} ${item.packageJSON.version}`).join("; "),
      readiness: "Not verified", evidence: "Visible to this Extension Host. Authentication, policy and kernel operation are separate checks.",
    } : { installed: "Not detected", readiness: "Needs setup", evidence: "Not visible in this Extension Host; disabled or remote-only installations may not be listed." });
  }
  for (const item of catalog.components) {
    if (item.kind === "service") set(item.id, { installed: "External service", readiness: "Not verified", evidence: "Not bundled. Connectivity, account access and provider policy are not tested by this local check." });
    if (item.kind === "planned") set(item.id, { installed: "Not bundled", readiness: "Planned", evidence: "This integration is not implemented in the toolkit; unrelated installations are not inspected." });
    if (item.kind === "manual") set(item.id, { installed: "External / manual", readiness: "Not verified", evidence: "User-managed workflow; this extension does not connect to the service." });
  }
  return { checkedAt: null, scope: "Editor only · workspace and runtime checks have not run", components };
}

async function statFile(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}
async function readJson(file) {
  try {
    const info = await fs.stat(file);
    if (info.size > 65536) return { error: "Configuration exceeds the 64 KiB inspection limit." };
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? { value } : { error: "Expected a JSON object." };
  } catch (error) {
    return error.code === "ENOENT" ? {} : { error: "Configuration cannot be read as JSON; review it manually." };
  }
}
function under(root, file) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}
/** Compatibility wrapper: the resolution itself lives in hosttools.js. */
async function findHostTool(name, roots) {
  const resolved = await resolveHostTool(name, { roots, verify: false });
  return resolved.path || undefined;
}

async function checkInventory(vscode, context, folder, services = {}) {
  const inventory = baseInventory(vscode, context);
  const set = (id, values) => Object.assign(inventory.components.find((item) => item.id === id), values);
  inventory.checkedAt = new Date().toISOString();
  if (!vscode.workspace.isTrusted) {
    inventory.scope = "Restricted mode · editor inventory only; no files or executables inspected";
    return inventory;
  }
  if (vscode.env.remoteName || (folder && folder.uri.scheme !== "file")) {
    inventory.scope = "Remote / virtual workspace · editor inventory only; local machine tools would describe a different host";
    return inventory;
  }
  const root = folder && folder.uri.fsPath;
  inventory.scope = root ? `Workspace: ${folder.name} · local read-only checks` : "No workspace · local host tools only";
  const run = services.runFile || runFile;
  const find = services.findHostTool || findHostTool;
  const roots = (vscode.workspace.workspaceFolders || []).filter((item) => item.uri.scheme === "file").map((item) => item.uri.fsPath);
  for (const [id, name] of [["uv", "uv"], ["git-for-windows", "git"]]) {
    const resolution = await resolverFrom(services)(name, {
      roots, configuredPath: name === "uv" ? (services.settings && services.settings.uvPath) : undefined,
      minimumVersion: (services.settings && services.settings.minimumVersions || {})[name],
    });
    const executable = resolution.path;
    if (!executable) { set(id, { installed: "Not detected", readiness: "Needs setup", evidence: `${resolution.reason} ${resolution.hint}` }); continue; }
    if (!resolution.verified) { set(id, { installed: "Detected", readiness: "Check failed", evidence: resolution.reason, location: executable }); continue; }
    try {
      const reported = resolution.version || String(resolution.versionOutput || "") || await run(executable, ["--version"]);
      set(id, { installed: "Installed", version: String(reported).slice(0, 200), readiness: "Ready", evidence: `Resolved from ${resolution.source}; version command succeeded. Project setup and remote authorization are separate.`, location: executable });
    } catch (error) { set(id, { installed: "Detected", readiness: "Check failed", evidence: error.message, location: executable }); }
  }
  if (!root) return inventory;
  const { managedRuntime, functionalCheck, WORKER_FOLDER } = require("./runtime");
  const installer = require("./installer");
  let managed;
  let managedError;
  try { managed = await managedRuntime(context, folder); } catch (error) { managedError = error.message; }
  const portable = await readJson(path.join(root, ".mcp.json"));
  const native = await statFile(path.join(root, ".vscode", "mcp.json"));
  const servers = portable.value && portable.value.mcpServers;
  set("mcp-config", { installed: portable.value || native ? "Configuration present" : "Not detected", readiness: portable.error ? "Needs attention" : "Not verified", evidence: portable.error || (native ? "Native .vscode/mcp.json present (JSONC not parsed). " : "") + (servers && typeof servers === "object" && !Array.isArray(servers) ? "Portable server IDs read; server commands were not executed. Start and test servers through VS Code." : "Portable toolkit server definitions not found. Follow the MCP guide.") });
  const workerRoot = path.join(root, ".research-toolkit", "worker");
  const managedWorkerRoot = path.join(root, WORKER_FOLDER);
  const workerFile = async (name) => (await statFile(path.join(managedWorkerRoot, "src", "research_stack", name))) || (await statFile(path.join(workerRoot, "src", "research_stack", name)));
  const workerFiles = await workerFile("mcp_server.py");
  const recommendedFiles = await workerFile("recommended_server.py");
  const labFiles = await workerFile("lab_server.py");
  set("document-worker", { installed: workerFiles ? "Files prepared" : "Not detected", readiness: "Needs setup", evidence: workerFiles ? "Worker source exists; a working environment and MCP invocation are still required." : "No workspace worker found. The VSIX does not contain the Python worker." });
  set("research-stack-recommended-adapter", { installed: recommendedFiles ? "Files prepared" : "Not detected", readiness: "Not verified", evidence: recommendedFiles ? "Research adapter source exists; provider calls and MCP session are not tested." : "Add the Recommended overlay after Basic setup." });
  // An unrelated project environment (e.g. WireGuard's .venv) is not a toolkit installation.
  let sourceProject = false;
  try { sourceProject = /name\s*=\s*["']research-stack-basic["']/.test(await fs.readFile(path.join(root, "pyproject.toml"), "utf8")); } catch { /* No toolkit source project. */ }
  const candidates = [...(managed ? [path.dirname(path.dirname(managed.python))] : []), path.join(workerRoot, ".venv"), ...(sourceProject ? [path.join(root, ".venv")] : [])];
  const executableIn = (directory) => path.join(directory, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  let python;
  for (const candidate of candidates) if (await statFile(executableIn(candidate))) { python = executableIn(candidate); break; }
  if (!python) {
    set("python", { installed: "Not detected", readiness: "Needs setup", evidence: managedError || "No toolkit worker environment found. Use Set up package components; unrelated project .venv and global Python installations are preserved and not used." });
    for (const id of ["mcp-python-sdk", "pypdf", "python-docx"]) set(id, { installed: "Not checked", readiness: "Needs setup", evidence: "Create the selected workspace environment before checking its Python packages." });
  } else {
    try {
      const probePath = path.join(context.extensionUri.fsPath, "probe.py");
      const payload = await run(python, ["-I", "-B", probePath]);
      let probe;
      try {
        probe = JSON.parse(payload);
        if (typeof probe.python !== "string" || !probe.packages) throw new Error();
        for (const id of ["mcp-python-sdk", "pypdf", "python-docx", "document-worker"]) {
          const entry = probe.packages[id];
          if (!entry || typeof entry.ok !== "boolean" || !(entry.version === null || typeof entry.version === "string")) throw new Error();
          if (id !== "document-worker" && typeof entry.detail !== "string") throw new Error();
        }
      } catch { throw new Error("Python probe returned invalid diagnostic data; review the selected environment."); }
      set("python", { installed: "Installed", version: probe.python, readiness: "Ready", evidence: "Selected workspace Python launched in isolated mode; no setup or package sync ran.", location: python });
      for (const id of ["mcp-python-sdk", "pypdf", "python-docx"]) {
        const result = probe.packages[id];
        set(id, { installed: result.version ? "Installed" : "Not detected", version: result.version, readiness: result.ok ? "Ready" : "Check failed", evidence: result.detail, location: python });
      }
      const worker = probe.packages["document-worker"];
      if (worker.version) set("document-worker", { installed: worker.ok ? "Installed" : "Metadata found", version: worker.version, readiness: worker.ok ? "Not verified" : "Needs attention", evidence: worker.ok ? "Package metadata and module found in this environment; MCP startup/tool invocation is still unverified." : "Distribution metadata exists but the worker module is missing; repair the selected environment.", location: python });
      if (probe.recommended) set("research-stack-recommended-adapter", { installed: "Module available", version: worker.version, readiness: "Not verified", evidence: "Adapter module found in the inspected environment; provider availability/authentication are not tested." });
      if (probe.full) set("research-stack-full-markdown-bm25-prototype", { installed: "Module available", version: worker.version, readiness: "Not verified", evidence: "Lexical prototype module found; the persistent index lives in the workspace record store." });
      if (probe.lab) set("research-corpus-index", { installed: "Module available", version: worker.version, readiness: "Not verified", evidence: "Index tools are served by the managed worker; the index itself lives in the workspace store." });
      if (probe.lab) set("research-record-store", { installed: "Module available", version: worker.version, readiness: "Not verified", evidence: "Record tools are served by the managed worker; no store file exists in this workspace yet." });
    } catch (error) {
      set("python", { installed: "Detected", readiness: "Check failed", evidence: error.message, location: python });
    }
  }
  if (managed) {
    inventory.managed = { worker: managed.worker, version: managed.version };
    set("mcp-config", vscode.lm?.registerMcpServerDefinitionProvider ? { installed: "Provided by extension", version: context.extension.packageJSON.version, readiness: "Configured", evidence: "Toolkit-owned Basic and Research servers are supplied through the VS Code MCP provider. Existing native/portable configuration was preserved; editor authorization remains separate." } : { installed: "Provider unavailable", readiness: "Needs attention", evidence: "This editor does not expose the required MCP provider API. Use the tested VS Code Desktop host or configure a reviewed manual server definition." });
    try {
      const check = services.functionalResult || await functionalCheck(context, managed, folder, undefined, services);
      inventory.readingCheck = check;
      set("document-worker", { readiness: "Ready", evidence: "Real local stdio MCP discovery, PDF/DOCX reading, hashes/locators and report creation passed on temporary synthetic fixtures. VS Code chat authorization is separate." });
      set("research-stack-recommended-adapter", { readiness: "Ready", evidence: "Real MCP discovery and local RIS preparation passed. External metadata providers and Zotero are not checked." });
      set("research-stack-full-markdown-bm25-prototype", { readiness: "Ready", evidence: "Selected Markdown fixture returned provenance-bearing BM25 results through MCP. Vector search remains planned." });
      if (check.corpusIndex) set("research-corpus-index", { readiness: "Ready", evidence: `Real MCP indexing and stored-corpus search passed on a synthetic fixture; ${check.lab ? check.lab.chunksIndexed : 0} chunk(s) indexed, fingerprint recorded.` });
      if (check.recordStore) set("research-record-store", { readiness: "Ready", evidence: "Real MCP claim write/read with an evidence link, store status, backup and the confirm-before-vacuum rule passed on synthetic fixtures." });
    } catch (error) {
      inventory.readingCheck = { ok: false, detail: error.message, checkedAt: new Date().toISOString() };
      set("document-worker", { readiness: "Check failed", evidence: error.message });
    }
  } else if (managedError) {
    set("document-worker", { readiness: "Needs attention", evidence: managedError });
  }
  if (!inventory.components.find((item) => item.id === "research-stack-full-markdown-bm25-prototype").version) {
    set("research-stack-full-markdown-bm25-prototype", { installed: "Not detected", readiness: "Needs setup", evidence: "Set up package components to enable bounded workspace text search." });
  }
  const storePath = path.join(root, ".research-toolkit", "store", "research.sqlite3");
  const storeExists = await statFile(storePath);
  if (storeExists) set("research-record-store", { installed: "Store present", version: inventory.components.find((item) => item.id === "research-record-store").version || null, readiness: "Not verified", evidence: "Workspace store file exists at .research-toolkit/store/research.sqlite3. Open the corpus tools or run store status to inspect its contents." });
  else if (labFiles) set("research-corpus-index", { installed: "Not initialised", readiness: "Needs setup", evidence: "Index tools are available but no store exists yet. Run the corpus index and record store component step." });
  const kernelPath = executableIn(path.join(root, "notebooks", "analysis", ".venv"));
  const notebookProject = await statFile(path.join(root, "notebooks", "analysis", "pyproject.toml"));
  set("research-analysis-python-environment", { installed: await statFile(kernelPath) ? "Environment detected" : notebookProject ? "Project present, environment missing" : "Not detected", readiness: "Not verified", evidence: await statFile(kernelPath) ? "Interpreter created by the notebook component step. Select it in a notebook and run a cell to verify the kernel; it is independent of the MCP worker." : notebookProject ? "notebooks/analysis exists but has no locked environment yet. Run the notebook analysis component step." : "No notebooks/analysis project in this workspace. Run component setup with the Recommended or Full package." });
  try {
    const receipt = await installer.readReceipt(path.join(root, WORKER_FOLDER));
    if (receipt) {
      inventory.setup = {
        package: receipt.package || null, workerVersion: receipt.workerVersion || null,
        updatedAt: receipt.updatedAt || receipt.installedAt || null,
        toolPreset: receipt.toolPreset || null,
        steps: Object.entries(receipt.steps || {}).map(([id, step]) => ({ id, status: step.status, toolkitVersion: step.toolkitVersion, evidence: step.evidence })),
      };
    }
  } catch { /* A damaged receipt is reported by setup, not by the inventory. */ }
  return inventory;
}

function inventoryText(inventory) {
  const preset = inventory.setup && inventory.setup.toolPreset
    ? ` · preset ${inventory.setup.toolPreset.id} (${inventory.setup.toolPreset.toolkitTools} toolkit tools${inventory.setup.toolPreset.measured ? `, ≈${inventory.setup.toolPreset.tokensEstimate} tokens measured` : ", estimated surface"})`
    : "";
  const setup = inventory.setup ? [`Component setup (${inventory.setup.package || "unknown package"}, toolkit ${inventory.setup.workerVersion || "unknown"}): ${inventory.setup.steps.map((step) => `${step.id} ${step.status === "installed" ? "installed" : step.status} at ${step.toolkitVersion || "unknown"}`).join(" · ") || "no steps recorded"}${preset}`] : ["Component setup: no setup receipt in this workspace."];
  return [inventory.scope, `Last check: ${inventory.checkedAt || "Not run"}`, ...setup, ...(inventory.readingCheck ? [`Reading check: ${inventory.readingCheck.ok ? "Passed (PDF, DOCX, corpus, records, real MCP)" : "Failed"}; ${inventory.readingCheck.checkedAt}`] : []), ...inventory.components.map((item) => `${item.title}: ${item.installed}; version ${item.version || "unknown / not applicable"}; ${item.readiness}. ${item.evidence}`)].join("\n");
}
module.exports = { baseInventory, checkInventory, inventoryText, runFile, findHostTool };
