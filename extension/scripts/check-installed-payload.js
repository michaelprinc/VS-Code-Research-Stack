"use strict";
/**
 * Install-payload check for a built VSIX.
 *
 * Extracts the package and runs the shipped controller exactly as an installed extension would:
 * worker-bundle hash validation, command registration, MCP provider behaviour with a simulated
 * setup receipt, goal-based preset selection, GUI state and packaged guide resolution.
 * Run after `npm run package`:  npm run check:payload [path/to.vsix]
 * This is a payload/behaviour check, not an Extension Host receipt.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const yauzl = require("yauzl");

const projectRoot = path.resolve(__dirname, "..");
const releaseVersion = require("../vsix-manifest.json").version;
const artifact = path.resolve(process.argv[2] || path.join(projectRoot, "..", "dist", `research-stack-toolkit-${releaseVersion}.vsix`));

function extract(source, target) {
  return new Promise((resolve, reject) => {
    yauzl.open(source, { lazyEntries: true }, (openError, zipfile) => {
      if (openError) return reject(openError);
      const writes = [];
      zipfile.on("entry", (entry) => {
        if (entry.fileName.endsWith("/")) return zipfile.readEntry();
        const destination = path.join(target, entry.fileName);
        if (!destination.startsWith(target + path.sep)) return reject(new Error(`Unsafe entry in package: ${entry.fileName}`));
        writes.push(new Promise((settle, fail) => {
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          zipfile.openReadStream(entry, (streamError, stream) => {
            if (streamError) return fail(streamError);
            const sink = fs.createWriteStream(destination);
            stream.on("error", fail);
            sink.on("error", fail);
            sink.on("close", settle);
            stream.pipe(sink);
          });
        }));
        zipfile.readEntry();
      });
      zipfile.on("close", () => Promise.all(writes).then(resolve, reject));
      zipfile.on("error", reject);
      zipfile.readEntry();
    });
  });
}

function fakeHost(workspace, { confirm = false } = {}) {
  const registered = new Map();
  const values = new Map();
  const panels = [];
  const statusBar = { show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  class Emitter { event(cb) { this.cb = cb; return { dispose() {} }; } fire() { this.cb?.(); } dispose() {} }
  const vscode = {
    version: "1.141.0",
    extensions: { getExtension: () => undefined, onDidChange: () => ({ dispose() {} }) },
    EventEmitter: Emitter,
    StatusBarAlignment: { Left: 1 }, ViewColumn: { One: 1 }, TreeItemCollapsibleState: { None: 0 },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } },
    lm: { registerMcpServerDefinitionProvider: (id, value) => { vscode.provider = value; return { dispose() {} }; } },
    ProgressLocation: { Notification: 15 },
    Uri: { joinPath: (base, ...parts) => [base, ...parts].join("/"), parse: (value) => value },
    env: { clipboard: { async writeText(text) { vscode.clipboard = text; } }, openExternal: async () => true },
    ConfigurationTarget: { Global: 1 },
    workspace: {
      fs: { async stat() { return {}; } },
      workspaceFolders: [{ name: "Payload check", uri: { scheme: "file", fsPath: workspace } }],
      isTrusted: true,
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      onDidGrantWorkspaceTrust: () => ({ dispose() {} }),
      getConfiguration(section) {
        assert.equal(section, "researchStack");
        return { get: (key, fallback) => (values.has(key) ? values.get(key) : fallback), async update(key, value, target) { assert.equal(target, 1); values.set(key, value); } };
      },
    },
    window: {
      createStatusBarItem: () => statusBar,
      registerTreeDataProvider: (id, value) => { vscode.tree = value; return { dispose() {} }; },
      createOutputChannel: () => ({ clear() {}, appendLine() {}, show() {}, dispose() {} }),
      showQuickPick: async () => undefined,
      showInformationMessage: async (text, ...items) => (confirm && items.some((item) => typeof item === "string") ? items.find((item) => typeof item === "string") : undefined),
      showOpenDialog: async () => undefined,
      withProgress: async (options, callback) => callback({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
      createWebviewPanel: () => {
        const panel = {
          options: {}, messages: [],
          webview: { cspSource: "vscode-resource:", asWebviewUri: (uri) => String(uri), onDidReceiveMessage: (callback) => { panel.receive = callback; return { dispose() {} }; }, async postMessage(message) { panel.messages.push(message); return true; } },
          reveal() {}, onDidDispose: (callback) => { panel.close = callback; return { dispose() {} }; }, dispose() { panel.close?.(); },
        };
        panels.push(panel);
        return panel;
      },
    },
    commands: {
      registerCommand: (id, callback) => { registered.set(id, callback); return { dispose() {} }; },
      async executeCommand(id, ...args) { return registered.has(id) ? registered.get(id)(...args) : undefined; },
    },
  };
  return { vscode, registered, values };
}

async function main() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "research-vsix-payload-"));
  const report = { artifact: path.basename(artifact) };
  try {
    await extract(artifact, stage);
    const packageRoot = path.join(stage, "extension");
    const extension = require(path.join(packageRoot, "extension.js"));
    const { bundle, managedRuntime, WORKER_FOLDER } = require(path.join(packageRoot, "runtime.js"));
    const manifestPackage = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const version = manifestPackage.version;
    report.version = version;
    assert.equal(manifestPackage.contributes.mcpServerDefinitionProviders[0].id, "researchToolkit.local");
    assert.ok(manifestPackage.contributes.configuration.properties["researchStack.toolsPreset"], "tools preset setting ships in the manifest");

    const { manifest } = await bundle({ extensionUri: { fsPath: packageRoot } });
    assert.equal(manifest.workerVersion, version, "bundled worker matches the extension version");
    assert.ok(manifest.files["src/research_stack/presets.py"], "preset gating ships inside the worker bundle");
    assert.ok(manifest.files["src/research_stack/lab_server.py"], "corpus and record tools ship inside the worker bundle");
    assert.equal(Object.keys(manifest.overlayFiles).length, 11, "reviewed workspace overlay templates ship in the bundle");
    report.workerBundle = { files: Object.keys(manifest.files).length, overlayFiles: Object.keys(manifest.overlayFiles).length, workerVersion: manifest.workerVersion };

    const workspace = path.join(stage, "workspace");
    fs.mkdirSync(workspace);
    const { vscode, registered, values } = fakeHost(workspace);
    const context = {
      subscriptions: [], extensionUri: { fsPath: packageRoot, toString: () => packageRoot },
      extension: { packageJSON: manifestPackage },
    };
    const api = extension.activateWith(vscode, context);
    report.commands = registered.size;
    assert.deepEqual(await api.mcpProvider.provideMcpServerDefinitions(), [], "no servers before a setup receipt");

    const worker = path.join(workspace, WORKER_FOLDER);
    for (const relative of Object.keys(manifest.files)) {
      const destination = path.join(worker, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(packageRoot, "worker", relative), destination);
    }
    const python = path.join(worker, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, "installed interpreter");
    for (const relative of Object.keys(manifest.overlayFiles)) {
      const destination = path.join(workspace, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(packageRoot, "worker", "overlay", relative), destination);
    }
    fs.mkdirSync(path.join(workspace, ".research-toolkit", "store"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".research-toolkit", "store", "research.sqlite3"), "record store");
    const server = (module, names, characters) => {
      const tools = names.map((name) => ({ name, title: name, characters, tokensEstimate: Math.ceil(characters / 4) + 40 }));
      return { module, toolCount: tools.length, characters: characters * tools.length, tokensEstimate: tools.reduce((sum, tool) => sum + tool.tokensEstimate, 0), tools };
    };
    const servers = extension.presetCatalog.servers.map((item, index) => server(item.module, item.tools, 437 + index * 33));
    const toolCount = servers.reduce((sum, item) => sum + item.toolCount, 0);
    fs.writeFileSync(path.join(worker, "installation.json"), JSON.stringify({
      extensionVersion: version, workerVersion: manifest.workerVersion, installedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      package: "full", mcpMode: "extension-provider",
      steps: {
        worker: { status: "installed", toolkitVersion: version, at: new Date().toISOString(), evidence: "fixture" },
        "research-overlay": { status: "installed", toolkitVersion: version, at: new Date().toISOString(), evidence: "fixture" },
        "notebook-env": { status: "installed", toolkitVersion: "0.3.3", at: new Date().toISOString(), evidence: "fixture" },
        "lab-store": { status: "installed", toolkitVersion: version, at: new Date().toISOString(), evidence: "fixture" },
      },
      checks: { ok: true, corpusIndex: true, recordStore: true, toolSurface: { basis: "measured from real tools/list responses", servers, toolCount,
        characters: servers.reduce((sum, item) => sum + item.characters, 0), tokensEstimate: servers.reduce((sum, item) => sum + item.tokensEstimate, 0) } },
    }, null, 2));
    const runtime = await managedRuntime(context, vscode.workspace.workspaceFolders[0]);
    assert.ok(runtime?.python, "managed runtime resolves from the setup receipt");
    report.receipt = { extensionVersion: runtime.receipt.extensionVersion, workerVersion: runtime.receipt.workerVersion, managedPath: WORKER_FOLDER };

    const serversFor = async () => (await api.mcpProvider.provideMcpServerDefinitions())
      .map((definition) => ({ module: definition.args.at(-1), preset: definition.env.RESEARCH_STACK_TOOL_PRESET }));
    values.set("selectedPackage", "recommended");
    report.presets = { recommendedDefault: await serversFor() };
    assert.equal(report.presets.recommendedDefault.length, 2);
    values.set("toolsPreset", "read-and-cite");
    report.presets.readAndCite = await serversFor();
    assert.equal(report.presets.readAndCite.length, 1);
    assert.equal(report.presets.readAndCite[0].module, "research_stack.mcp_server");
    values.set("toolsPreset", "verify-citations");
    report.presets.verifyCitations = await serversFor();
    assert.equal(report.presets.verifyCitations.length, 1);
    assert.equal(report.presets.verifyCitations[0].module, "research_stack.recommended_server");
    values.set("selectedPackage", "full");
    values.set("toolsPreset", "research-lab-max");
    report.presets.researchLabMax = await serversFor();
    assert.equal(report.presets.researchLabMax.length, 2);
    assert.ok(report.presets.researchLabMax.every((item) => item.preset === "research-lab-max"));
    values.set("toolsPreset", "corpus-lab");
    report.presets.corpusLab = await serversFor();
    assert.deepEqual(report.presets.corpusLab, [
      { module: "research_stack.mcp_server", preset: "corpus-lab" },
      { module: "research_stack.lab_server", preset: "corpus-lab" },
    ], "the corpus goal offers the record-store server plus the notes reader that reopens a hit");
    values.set("toolsPreset", "research-workflow");
    report.presets.researchWorkflow = await serversFor();
    assert.equal(report.presets.researchWorkflow.length, 3, "the Full default preset spans all three servers");
    assert.ok(report.presets.researchWorkflow.every((item) => item.preset === "research-workflow"));

    const panel = api.openControlPanel();
    await panel.receive({ type: "ready" });
    const state = panel.messages.at(-1);
    assert.equal(state.version, version);
    assert.equal(state.presets.length, 9, "Full offers the whole preset range");
    assert.equal(state.toolSurface.toolCount, 20, "the preset-selectable surface is 20 tools: 5 document/recommended readers, 5 research verbs, 10 store verbs (0.3.9 adds verify_sources)");
    assert.equal(state.installPlan.package.id, "full");
    assert.equal(state.installPlan.steps.length, 4, "Full declares four component steps");
    assert.deepEqual(state.installPlan.counts, { installed: 3, outdated: 1, omittedOptional: 0 }, "the receipt plus produced files drive step status");
    assert.equal(state.installPlan.steps.find((step) => step.id === "notebook-env").status, "outdated");
    assert.ok(state.installPlan.steps.every((step) => step.status !== "installed" || step.artifacts), "an installed step reports the files that prove it");
    assert.equal(state.installPlan.components.managed, 11);
    assert.equal(state.installPlan.components.planned, 5);
    const widest = state.presets.find((item) => item.id === "research-lab-max");
    assert.equal(widest.estimate.measured, true);
    assert.equal(widest.estimate.totalTools, 101);
    assert.ok(widest.estimate.totalTools <= state.toolBudget.clientCeiling);
    assert.match(panel.webview.html, /id="preset-list"/);
    assert.match(panel.webview.html, /id="preset-estimate"/);
    assert.match(panel.webview.html, /id="install-plan"/);
    assert.match(panel.webview.html, /Update outdated or repaired component steps/);
    assert.match(panel.webview.html, /data-action="status"[^>]*>Refresh component status/);
    assert.match(panel.webview.html, /data-action="rollback"[^>]*>Roll back managed runtime/);
    // 0.3.6: the panel must carry the installation verdict, not only the plan.
    for (const id of ["install-status", "install-outcome", "install-meta", "install-steps", "install-problem", "install-tools", "retry-button"]) {
      assert.ok(panel.webview.html.includes(`id="${id}"`), `packaged panel renders #${id}`);
    }
    for (const action of ["clearLock", "setupLog", "copySetup"]) {
      assert.match(panel.webview.html, new RegExp(`data-action="${action}"`), `packaged panel offers ${action}`);
    }
    assert.ok(panel.webview.html.includes('<button id="retry-button">Retry failed component steps</button>'), "retry is a real button, not a hint");
    assert.ok(state.installation && state.installation.outcome, "the packaged panel state carries an installation outcome");
    assert.match(state.installation.line, /component setup|Installation/, state.installation.line);
    assert.equal(state.installation.toolkitVersion, version, "the installation card is labelled with the packaged release");
    report.commands = registered.size;
    assert.equal(registered.size, 30, "every declared command is registered (25 through 0.3.8 plus the five 0.3.9 corpus, freshness and bundle commands)");
    for (const command of ["researchToolkit.retryFailedSteps", "researchToolkit.clearSetupLock", "researchToolkit.openSetupLog", "researchToolkit.copyInstallationDiagnostics",
      "researchToolkit.indexSelectedSources", "researchToolkit.verifySourceFreshness", "researchToolkit.installTopicBundle", "researchToolkit.repairTopicBundle", "researchToolkit.showBundleStatus"]) {
      assert.equal(typeof registered.get(command), "function", `${command} ships registered`);
    }
    for (const setting of ["researchStack.uvPath", "researchStack.setupTimeoutSeconds"]) {
      assert.ok(manifestPackage.contributes.configuration.properties[setting], `${setting} ships in the manifest`);
    }
    assert.equal(manifestPackage.contributes.configuration.properties["researchStack.setupTimeoutSeconds"].default, 900);
    assert.equal(manifestPackage.contributes.configuration.properties["researchStack.uvPath"].scope, "application");
    const diagnosis = await registered.get("researchToolkit.diagnoseToolLimit")();
    assert.match(diagnosis, /Client ceiling: 128 tools/);
    assert.match(diagnosis, /Toolkit contribution now: 11 toolkit tools from 3 managed MCP server\(s\)/, "the Full default preset spans all three servers");
    values.set("toolsPreset", "corpus-lab");
    const summary = await registered.get("researchToolkit.copyPresetSummary")();
    const corpusPreset = extension.presetCatalog.presets.find((item) => item.id === "corpus-lab");
    assert.equal(corpusPreset.tools.length, 11, "the corpus goal carries all ten store verbs plus the notes reader (0.3.9 adds verify_sources)");
    assert.ok(corpusPreset.tools.includes("verify_sources"), "the shipped corpus preset can ask whether an indexed source still matches the file");
    assert.match(summary, new RegExp(`Toolkit tools \\(11\\): ${corpusPreset.tools.join(", ")}`), "the copied summary lists the shipped corpus verbs");
    assert.match(summary, /measured from the installed worker's tools\/list schemas/);
    assert.equal(vscode.clipboard, summary);
    assert.match(api.state().readiness, /Selected tools preset: Index, search and record claims · 11 toolkit tools/);
    assert.match(api.state().readiness, /Package setup for Full: 3 of 4 component steps installed, 1 outdated for this toolkit release/);
    assert.equal(vscode.tree.getChildren()[2].label, "Tools preset: Index, search and record claims");
    assert.equal(vscode.tree.getChildren()[3].label, "Components: 3/4 steps ready");
    report.gui = { presets: state.presets.length, measuredToolkitTokens: state.toolSurface.tokensEstimate, widestPresetTokens: widest.estimate.tokensEstimate, widestPresetContextPercent: widest.estimate.contextPercent };

    await registered.get("researchToolkit.openHelp")();
    for (const file of ["guides/index.md", "guides/onboarding.md", "presets.json", "installer.js", "runner.js", "hosttools.js", "preflight.js", "setuplog.js", "steps.js", "status.js", "components.json", "worker/overlay/notebooks/analysis/uv.lock", "worker/overlay/.github/skills/literature-search/SKILL.md", "functional_check.py", "probe.py", "readme.md", "media/controls.js", "media/controls.css"]) {
      assert.ok(fs.existsSync(path.join(packageRoot, file)), `packaged ${file} resolves`);
    }
    assert.ok(fs.readFileSync(path.join(packageRoot, "guides", "onboarding.md"), "utf8").includes("Choose a tools preset for the task"));
    assert.ok(fs.readFileSync(path.join(packageRoot, "readme.md"), "utf8").includes(version));
    const refreshed = await registered.get("researchToolkit.refreshComponentStatus")();
    assert.match(refreshed, /Component status refresh · toolkit /);
    assert.match(refreshed, /No recorded step is missing its produced files\./);
    assert.match(refreshed, /The functional MCP reading check was not run by this refresh/);
    report.refresh = { states: refreshed.match(/\b(installed|outdated|needs-repair|missing)\b/g).length };
    report.help = { guides: fs.readdirSync(path.join(packageRoot, "guides")).length };

    // 0.3.6: reproduce the reported field failure against the packaged controller — the VSIX
    // installs, but a component step fails — and require the package to say so instead of
    // reporting a successful installation.
    const failingWorkspace = path.join(stage, "workspace-failed-setup");
    fs.mkdirSync(failingWorkspace);
    const failingHost = fakeHost(failingWorkspace, { confirm: true });
    const failingContext = { subscriptions: [], extensionUri: { fsPath: packageRoot, toString: () => packageRoot }, extension: { packageJSON: manifestPackage } };
    const failingApi = extension.activateWith(failingHost.vscode, failingContext, {
      async findHostTool(name) { return name === "uv" ? "/packaged-check/uv" : undefined; },
      async runFile(executable, args) {
        if (args[0] === "--version") return "uv 0.7.3";
        throw new Error("Command failed: uv sync failed with exit code 2: error: Request failed after 3 retries in 5.2s");
      },
    });
    const failedRun = await failingHost.registered.get("researchToolkit.setupLocalComponents")();
    assert.equal(failedRun.outcome, "partial", "a failed step is reported as incomplete, never as a success");
    assert.deepEqual(failedRun.failed, ["worker"]);
    assert.deepEqual(failedRun.blocked, ["notebook-env"], "dependents are blocked, never silently skipped; the interpreter-free overlay still runs");
    const packagedStatus = require(path.join(packageRoot, "setuplog.js"));
    const stored = await packagedStatus.readStatus(failingWorkspace);
    assert.equal(stored.outcome, "partial", "the packaged status record survives the failed run");
    assert.match(stored.steps[0].error, /uv sync failed with exit code 2/, "the captured tool output is stored for troubleshooting");
    const failedLog = await packagedStatus.readLog(failingWorkspace);
    assert.ok(failedLog.files.length >= 1, "the packaged log writer recorded the attempt");
    assert.equal(failingApi.state().installation.outcome, "partial");
    assert.match(failingApi.state().installation.line, /^Installation incomplete — 1 step\(s\) verified, 2 need attention \(/, failingApi.state().installation.line);
    const diagnostics = await failingHost.registered.get("researchToolkit.copyInstallationDiagnostics")();
    assert.match(diagnostics, /Installation incomplete/, "the copied diagnostics name the failure");
    assert.match(diagnostics, /next action: /, "the copied diagnostics name the next action");
    const retry = await failingHost.registered.get("researchToolkit.retryFailedSteps")();
    assert.deepEqual(retry.selected, ["worker", "notebook-env"], "retry re-runs the failed step and the step blocked by it, and skips the step that already succeeded");
    report.failedSetup = { outcome: failedRun.outcome, blocked: failedRun.blocked, logFiles: failedLog.files.length, verdict: failingApi.state().installation.line };
    report.result = "passed";
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
