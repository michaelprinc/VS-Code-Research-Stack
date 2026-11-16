"use strict";

const assert = require("node:assert/strict");
const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");
const TOOLKIT_VERSION = require("../package.json").version;

async function run() {
  const originalClipboard = await vscode.env.clipboard.readText();
  const stage = process.env.PACKAGE_SWITCH_TEST_STAGE || "mutate";
  const start = performance.now();
  let status = await vscode.commands.executeCommand("researchToolkit.showPhaseReadiness");
  const activationAndCommandMs = performance.now() - start;
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("researchToolkit.showPhaseReadiness"), "readiness command is registered");
  assert.ok(commands.includes("researchToolkit.switchPackage"), "package switch command is registered");
  for (const id of ["openControlPanel", "openSettings", "openHelp", "copyReadiness", "refresh"]) {
    assert.ok(commands.includes(`researchToolkit.${id}`), `${id} command is registered`);
  }
  const extension = vscode.extensions.getExtension("michaelprinc.research-stack-toolkit");
  assert.equal(extension.packageJSON.version, TOOLKIT_VERSION, "the installed extension reports the release under test");
  const api = extension.exports;
  const panel = api.openControlPanel();
  assert.equal(api.openControlPanel(), panel, "opening controls reuses the current panel");
  assert.match(panel.webview.html, /Package preference/);
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.match(panel.webview.html, /controls.js/);
  const readyDeadline = Date.now() + 10000;
  while (!api.isControlPanelReady() && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(api.isControlPanelReady(), true, "packaged webview script loads and reaches the host message bridge");
  let setupCheck;
  let selectedRead;
  let providerDefinitions;
  if (process.env.VSCODE_TEST_SETUP_WORKER) {
    const folder = vscode.workspace.workspaceFolders[0];
    const runtimeApi = require(path.join(extension.extensionPath, "runtime.js"));
    const context = { extensionUri: extension.extensionUri };
    const preservedConfig = await fs.readFile(path.join(folder.uri.fsPath, ".vscode/mcp.json"), "utf8");
    const preservedEnvironment = await fs.readFile(path.join(folder.uri.fsPath, ".venv/preserve.txt"), "utf8");
    if (stage === "mutate") {
      const installed = await runtimeApi.setupRuntime(vscode, context, folder);
      setupCheck = installed.check;
    } else {
      setupCheck = await vscode.commands.executeCommand("researchToolkit.runReadingCheck");
    }
    assert.equal(setupCheck.pdfRead, true); assert.equal(setupCheck.docxRead, true);
    const runtime = await runtimeApi.managedRuntime(context, folder);
    const { runFile } = require(path.join(extension.extensionPath, "diagnostics.js"));
    // The receipt's own Python child uses the shipped flags, so the reference host exercises the
    // same UTF-8 shape the extension gives every child (0.3.8).
    const { PYTHON_FLAGS } = require(path.join(extension.extensionPath, "runner.js"));
    const source = path.join(folder.uri.fsPath, "Selected document é with spaces.docx");
    await runFile(runtime.python, [...PYTHON_FLAGS, "-c", "from docx import Document; import sys; d=Document(); d.add_paragraph('Actual selected document reading check: Výzkum a evidence.'); d.save(sys.argv[1])", source]);
    selectedRead = await runtimeApi.functionalCheck(context, runtime, folder, source);
    assert.match(selectedRead.preview, /Výzkum a evidence/);
    assert.equal(selectedRead.locators[0].item, 1);
    assert.equal(await fs.readFile(path.join(folder.uri.fsPath, ".vscode/mcp.json"), "utf8"), preservedConfig);
    assert.equal(await fs.readFile(path.join(folder.uri.fsPath, ".venv/preserve.txt"), "utf8"), preservedEnvironment);
    providerDefinitions = await api.mcpProvider.provideMcpServerDefinitions();
    assert.equal(providerDefinitions.length, 2);
    for (const definition of providerDefinitions) {
      assert.equal(typeof definition.label, "string");
      assert.equal(definition.command, runtime.python);
      assert.equal(definition.env.RESEARCH_STACK_WORKSPACE, folder.uri.fsPath);
      assert.equal(definition.env.RESEARCH_STACK_TOOL_PRESET, "research-core");
      // The definition version is the surface signature, not the bare release: it is what a client
      // compares to decide whether its tool list is current (see test/runtime.test.js).
      assert.match(definition.version, new RegExp(`^${TOOLKIT_VERSION}\\+research-core:[0-9a-f]{12}$`), "the definition version carries the managed runtime and the goal's tool surface");
      assert.deepEqual(definition.args.slice(0, PYTHON_FLAGS.length), PYTHON_FLAGS, "the editor starts the MCP server behind the reviewed isolation and UTF-8 flags");
    }
  }
  await vscode.commands.executeCommand("researchToolkit.openHelp");
  const guide = vscode.Uri.joinPath(extension.extensionUri, "guides", "index.md");
  assert.ok((await vscode.workspace.fs.stat(guide)).size > 0, "packaged help file resolves with case-sensitive filename");
  assert.equal(api.state().inventory.components.find((item) => item.id === "toolkit").version, TOOLKIT_VERSION);
  const inventory = await vscode.commands.executeCommand("researchToolkit.checkComponents");
  assert.ok(inventory.checkedAt);
  assert.equal(inventory.components.find((item) => item.id === "qdrant-local-service").readiness, "Planned");
  if (process.env.VSCODE_TEST_WORKSPACE) {
    for (const id of ["python", "mcp-python-sdk", "pypdf", "python-docx"]) {
      assert.equal(inventory.components.find((item) => item.id === id).readiness, "Ready", `${id}: real workspace probe passed`);
    }
    assert.equal(inventory.components.find((item) => item.id === "document-worker").readiness, process.env.VSCODE_TEST_SETUP_WORKER ? "Ready" : "Not verified");
  }
  await vscode.commands.executeCommand("researchToolkit.openComponentGuide", "pypdf");
  assert.equal(api.state().showStatusBar, stage === "mutate");
  assert.equal(api.state().openControlPanelOnStartup, stage === "persist");
  assert.ok(status.includes(`Research Stack Toolkit ${TOOLKIT_VERSION} preview`));
  assert.match(status, /G1 not passed/);
  assert.match(status, /G2 not passed/);
  assert.match(status, /G3 not passed/);
  assert.ok(activationAndCommandMs < 500, `first command took ${activationAndCommandMs.toFixed(1)} ms`);

  if (stage === "mutate") {
    assert.match(status, /Selected package preference: Recommended Research \(recommended\)/);
    for (const id of ["basic", "full", "recommended", "full"]) {
      status = await vscode.commands.executeCommand("researchToolkit.switchPackage", id);
      assert.match(status, new RegExp(`Selected package preference: ${id === "recommended" ? "Recommended Research" : id === "basic" ? "Basic" : "Full"} \\(${id}\\)`));
      const readiness = await vscode.commands.executeCommand("researchToolkit.showPhaseReadiness");
      assert.match(readiness, new RegExp(`Selected package preference: .* \\(${id}\\)`));
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await vscode.workspace.getConfiguration("researchStack").update("showStatusBar", false, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("researchStack").update("openControlPanelOnStartup", true, vscode.ConfigurationTarget.Global);
    assert.equal(api.state().showStatusBar, false);
    await vscode.commands.executeCommand("researchToolkit.copyReadiness");
    assert.match(await vscode.env.clipboard.readText(), /Full \(full\)/);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } else if (stage === "persist") {
    assert.match(status, /Selected package preference: Full \(full\)/, "package choice persists across Extension Host restart");
    assert.equal(api.state().showStatusBar, false, "GUI setting persists across Extension Host restart");
    await vscode.workspace.getConfiguration("researchStack").update("showStatusBar", true, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("researchStack").update("openControlPanelOnStartup", false, vscode.ConfigurationTarget.Global);
    status = await vscode.commands.executeCommand("researchToolkit.switchPackage", "basic");
    assert.match(status, /Selected package preference: Basic \(basic\)/);
  } else {
    throw new Error(`Unknown PACKAGE_SWITCH_TEST_STAGE: ${stage}`);
  }

  const warmCommandTimes = [];
  for (let index = 0; index < 100; index += 1) {
    const commandStart = performance.now();
    await vscode.commands.executeCommand("researchToolkit.showPhaseReadiness");
    warmCommandTimes.push(performance.now() - commandStart);
  }
  warmCommandTimes.sort((left, right) => left - right);
  const warmP95Ms = warmCommandTimes[Math.ceil(warmCommandTimes.length * 0.95) - 1];
  assert.ok(warmP95Ms < 50, `warm command p95 took ${warmP95Ms.toFixed(1)} ms`);

  const concurrentResults = await Promise.all(
    Array.from({ length: 25 }, () => vscode.commands.executeCommand("researchToolkit.showPhaseReadiness")),
  );
  assert.ok(concurrentResults.every((result) => result === concurrentResults[0]), "concurrent readiness responses are consistent");
  console.log(JSON.stringify({
    test: "actual-vscode-extension-host",
    stage,
    activationAndCommandMs,
    warmCommandP95Ms: warmP95Ms,
    warmCalls: warmCommandTimes.length,
    packageTransitions: stage === "mutate" ? ["basic", "full", "recommended", "full"] : ["persisted full", "basic"],
    concurrentCalls: concurrentResults.length,
    gui: "packaged renderer ready handshake, help opened, panel reused, commands registered, option persistence verified",
    inventory: inventory.components.filter((item) => item.version).map(({ id, version, readiness }) => ({ id, version, readiness })),
    setupCheck, selectedRead, providerDefinitions,
  }));
  panel.dispose();
  await vscode.env.clipboard.writeText(originalClipboard);
}

module.exports = { run };
