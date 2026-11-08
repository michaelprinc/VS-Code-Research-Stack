"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const extension = require("../extension");

const { makeHarness } = require("./harness");

test("manifest exposes GUI and package commands with matching contributions and no runtime dependencies", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vsix-manifest.json"), "utf8"));
  const releaseVersion = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).version;
  assert.equal(manifest.version, releaseVersion, "the packaged manifest and the extension manifest are the same release");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, "the release version is a version vsce can package: one to three numbers");
  assert.equal(manifest.main, "./extension.js");
  assert.ok(manifest.activationEvents.includes("onStartupFinished"));
  assert.ok(manifest.contributes.commands.some((item) => item.command === "researchToolkit.openControlPanel"));
  assert.equal(manifest.contributes.views.researchToolkit[0].id, "researchToolkit.overview");
  assert.deepEqual(manifest.contributes.configuration.properties["researchStack.selectedPackage"].enum, ["basic", "recommended", "full"]);
  assert.equal(manifest.contributes.configuration.properties["researchStack.selectedPackage"].scope, "application");
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.private, undefined);
  const shippedAllowlist = ["CHANGELOG.md", "LICENSE.txt", "README.md", "SECURITY.md", "SUPPORT.md", "bundles", "bundles.js", "components.json", "diagnostics.js", "extension.js", "functional_check.py", "guides", "hosttools.js", "installer.js", "lockfile.js", "media", "package.json", "preflight.js", "presets.json", "probe.py", "reports.js", "runner.js", "runtime.js", "setuplog.js", "status.js", "steps.js", "ui.js", "updates.js", "worker"].sort();
  assert.deepEqual([...manifest.files].sort(), shippedAllowlist,
    "the shipped allowlist names every module the controller requires, including the 0.3.6 setup modules, the 0.3.7 lock reader, the 0.3.9 bundle installer and the 0.3.10 update and report modules");
  assert.deepEqual(manifest.contributes.configuration.properties["researchStack.toolsPreset"].enum, ["package-default", "read-and-cite", "find-in-notes", "verify-citations", "zotero-handoff", "research-core", "research-workflow", "research-lab", "research-lab-max", "corpus-lab"]);
  assert.equal(manifest.contributes.configuration.properties["researchStack.toolsPreset"].default, "package-default");
  assert.equal(manifest.contributes.configuration.properties["researchStack.toolsPreset"].scope, "application-overridable", "a preset can be overridden per workspace folder");
  assert.ok(manifest.contributes.commands.some((item) => item.command === "researchToolkit.selectToolsPreset"));
  for (const command of ["researchToolkit.refreshComponentStatus", "researchToolkit.rollbackRuntime"]) {
    assert.ok(manifest.contributes.commands.some((item) => item.command === command), `${command} is contributed, not just registered`);
  }
  const development = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  const { scripts, devDependencies, private: privatePackage, ...shipped } = development;
  assert.deepEqual(shipped, manifest, "development and packaged contribution manifests agree");
});

test("the settings contributions describe the shipped presets and commands without drift", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vsix-manifest.json"), "utf8"));
  const preset = manifest.contributes.configuration.properties["researchStack.toolsPreset"];
  assert.equal(preset.enumItemLabels.length, preset.enum.length, "every selectable preset has a Settings label in the same order");
  const registry = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "presets.json"), "utf8"));
  const byId = new Map(registry.presets.map((item) => [item.id, item.label]));
  for (const [index, id] of preset.enum.entries()) {
    if (id === "package-default") continue;
    assert.equal(preset.enumItemLabels[index], byId.get(id), `${id} is labelled with its registry label, not a stale one`);
  }
  const categories = new Set(manifest.contributes.commands.map((item) => item.category));
  assert.deepEqual([...categories], ["Research Toolkit"], "the new commands appear in the same Command Palette group as the rest");
  assert.equal(manifest.contributes.commands.length, 33, "30 through 0.3.9 plus the three 0.3.10 update and problem-report commands");
  for (const command of ["researchToolkit.indexSelectedSources", "researchToolkit.verifySourceFreshness",
    "researchToolkit.installTopicBundle", "researchToolkit.repairTopicBundle", "researchToolkit.showBundleStatus",
    "researchToolkit.reportProblem", "researchToolkit.checkForUpdates", "researchToolkit.updateExtension"]) {
    assert.ok(manifest.contributes.commands.some((item) => item.command === command), `${command} is contributed, not just registered`);
  }
});

test("activation registers both disposable commands and reports the profile preference", async () => {
  const harness = makeHarness();
  assert.equal(harness.registered.size, 33, "every contributed command is registered, including the 0.3.10 update and report commands");
  for (const command of ["researchToolkit.retryFailedSteps", "researchToolkit.clearSetupLock", "researchToolkit.openSetupLog", "researchToolkit.copyInstallationDiagnostics"]) {
    assert.equal(typeof harness.registered.get(command), "function", `${command} is registered so the panel can offer it`);
  }
  for (const command of ["researchToolkit.indexSelectedSources", "researchToolkit.verifySourceFreshness",
    "researchToolkit.installTopicBundle", "researchToolkit.repairTopicBundle", "researchToolkit.showBundleStatus"]) {
    assert.equal(typeof harness.registered.get(command), "function", `${command} is registered so the control panel can offer it`);
  }
  assert.equal(harness.panels.length, 0, "activation does not open the GUI by default");
  let status = harness.registered.get("researchToolkit.showPhaseReadiness")();
  assert.match(status, /Selected package preference: Recommended Research \(recommended\)/);
  assert.match(status, /G1 not passed/);
  assert.match(status, /G2 not passed/);
  assert.match(status, /G3 not passed/);
  assert.match(status, /nothing is installed silently/);
  assert.match(status, /Package setup for Recommended Research: 0 of 3 component steps installed, 2 not installed, 1 optional step\(s\) deliberately not installed/);

  status = await harness.registered.get("researchToolkit.switchPackage")("basic");
  assert.match(status, /Selected package preference: Basic \(basic\)/);
  assert.equal(harness.values.get("selectedPackage"), "basic");
  assert.equal(harness.output.shown, true);
  for (const subscription of harness.context.subscriptions) subscription.dispose();
  assert.equal(harness.disposed.length, 34, "every registered command and the status item are disposed with the extension");
});

test("GUI saves packages/options, reuses its panel, and syncs external settings with sidebar/status", async () => {
  const harness = makeHarness();
  const panel = harness.api.openControlPanel();
  assert.equal(harness.api.openControlPanel(), panel);
  assert.equal(panel.revealed, 1);
  await panel.receive({ type: "ready" });
  assert.equal(panel.messages.at(-1).selectedPackage, "recommended");
  await panel.receive({ type: "setPackage", id: "basic" });
  assert.equal(harness.values.get("selectedPackage"), "basic");
  assert.match(harness.statusBar.text, /Basic/);
  assert.equal(harness.provider.getChildren()[1].label, "Package: Basic");
  await panel.receive({ type: "setOption", key: "showStatusBar", value: false });
  assert.equal(harness.statusBar.visible, false);
  await panel.receive({ type: "setOption", key: "openControlPanelOnStartup", value: true });
  assert.equal(harness.values.get("openControlPanelOnStartup"), true);
  harness.values.set("selectedPackage", "full");
  harness.events.config({ affectsConfiguration: () => true });
  assert.equal(panel.messages.at(-1).selectedPackage, "full");
  assert.match(harness.statusBar.text, /Full/);
  panel.dispose();
  assert.equal(panel.listenerDisposed, true);
  assert.notEqual(harness.api.openControlPanel(), panel);
});

test("GUI rejects untrusted messages and reports failed settings without changing state", async () => {
  const harness = makeHarness({ failUpdate: true });
  const panel = harness.api.openControlPanel();
  for (const message of [
    { type: "setPackage", id: "custom" },
    { type: "setOption", key: "selectedPackage", value: true },
    { type: "setOption", key: "showStatusBar", value: "false" },
    { type: "action", action: "workbench.action.terminal.new" },
    { type: "action", action: "__proto__" },
    { type: "setPackage", id: "full" },
  ]) {
    await panel.receive(message);
    assert.equal(panel.messages.at(-1).type, "result");
    assert.ok(panel.messages.at(-1).error);
    assert.equal(harness.api.state().selectedPackage, "recommended");
    assert.equal(harness.values.size, 0);
  }
  assert.equal(harness.invoked.length, 0);
  await panel.receive(null);
  await panel.receive([]);
});

test("GUI actions use a fixed command allowlist and startup opening is opt-in", async () => {
  const harness = makeHarness({ initial: { openControlPanelOnStartup: true, showStatusBar: false, selectedPackage: "full" } });
  assert.equal(harness.panels.length, 1);
  assert.equal(harness.statusBar.visible, false);
  const panel = harness.panels[0];
  for (const action of ["copy", "readiness", "help", "settings", "refresh"]) await panel.receive({ type: "action", action });
  assert.match(harness.events.clipboard, /Full \(full\)/);
  assert.ok(harness.invoked.some((item) => item.id === "markdown.showPreview" && item.args[0].fsPath === "extension/guides/index.md"), "the guide is handed to VS Code as a Uri, not as a string");
  assert.ok(harness.invoked.some((item) => item.id === "workbench.action.openSettings"));
});

test("webview limits scripts and local resources and uses a fresh nonce", () => {
  const harness = makeHarness();
  const panel = harness.api.openControlPanel();
  assert.deepEqual(panel.options.localResourceRoots.map((uri) => uri.fsPath), ["extension/media"]);
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.match(panel.webview.html, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|onclick=|https?:\/\//);
  // 0.3.10: the panel offers the update and report controls, and states what the online request is.
  for (const action of ["report", "checkUpdates", "updateNow"]) {
    assert.ok(panel.webview.html.includes(`data-action="${action}"`), `the panel offers ${action}`);
  }
  assert.ok(panel.webview.html.includes('id="update-state"'), "and a place to state the verdict");
  assert.ok(panel.webview.html.includes("The Toolkit sends nothing by itself"), "with the disclosure in the panel, not only in a setting");
  assert.ok(panel.webview.html.includes("Updates &amp; problem reports"));
  panel.dispose();
  const fresh = harness.api.openControlPanel();
  assert.notEqual(panel.webview.html, fresh.webview.html);
});

test("Quick Pick switches package preference and cancel or invalid IDs preserve the stored value", async () => {
  const harness = makeHarness({ pickedId: "full" });
  let status = await harness.registered.get("researchToolkit.switchPackage")();
  assert.match(status, /Selected package preference: Full \(full\)/);
  assert.equal(harness.values.get("selectedPackage"), "full");
  await assert.rejects(harness.registered.get("researchToolkit.switchPackage")("custom"), /Unknown Research Stack package/);
  assert.equal(harness.values.get("selectedPackage"), "full");

  const cancelled = makeHarness({ cancel: true });
  assert.equal(await cancelled.registered.get("researchToolkit.switchPackage")(), undefined);
  assert.equal(cancelled.values.get("selectedPackage"), undefined);
});

test("readiness formatting stays cheap under repeated access", () => {
  const start = process.hrtime.bigint();
  for (let index = 0; index < 10000; index += 1) extension.readinessText();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 500, `10,000 status renders took ${elapsedMs.toFixed(2)} ms`);
});

test("a panel result names the request it answers", async () => {
  const { makeHarness } = require("./harness");
  const harness = makeHarness({});
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "ready" });
  await panel.receive({ type: "action", action: "help", requestId: 41 });
  const result = panel.messages.at(-1);
  assert.equal(result.type, "result");
  assert.equal(result.requestId, 41, "the result is correlated to the request that produced it");
  await panel.receive({ type: "action", action: "not-an-action", requestId: 42 });
  const failure = panel.messages.at(-1);
  assert.equal(failure.requestId, 42, "an error result is correlated too");
  assert.match(failure.error, /action/i);
  panel.dispose();
});

test("the problem report writes a file the operator reads, copies it, and only then offers the mail draft", async () => {
  const os = require("node:os");
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "research-report-"));
  try {
    const harness = makeHarness({ storageDir: storage, reportNote: "The reading check stopped after I moved the folder." });
    const result = await harness.registered.get("researchToolkit.reportProblem")();
    assert.equal(harness.events.writtenFiles.length, 1, "exactly one file is written");
    const written = harness.events.writtenFiles[0];
    assert.ok(written.startsWith(storage), `the report went to the extension's own storage folder, not to the workspace: ${written}`);
    assert.match(path.basename(written), /^research-stack-report-r-\d{8}T\d{6}Z\.txt$/);
    assert.equal(harness.events.shownDocument, written, "the file the operator was shown is the file that was written");
    const onDisk = fs.readFileSync(written, "utf8");
    assert.equal(harness.events.clipboard, onDisk, "the clipboard holds exactly what the operator was shown");
    assert.ok(onDisk.includes("RESEARCH STACK TOOLKIT — PROBLEM REPORT"));
    assert.ok(onDisk.includes("princ.michael@gmail.com"), "the report says who it is for");
    assert.ok(onDisk.includes("The reading check stopped after I moved the folder."), "the operator's own words are in it");
    assert.ok(onDisk.includes("no setup has run in this workspace yet"), "and so is the recorded setup verdict");
    assert.ok(!onDisk.includes("Research <draft>"), "the workspace folder name is not");
    assert.ok(onDisk.includes("Workspace: <workspace>"));
    assert.ok(onDisk.includes("WHAT WAS REMOVED FROM THIS REPORT"));
    assert.equal(result.bytes, Buffer.byteLength(onDisk, "utf8"), "the reported size is the real size");
    assert.equal(result.path, written);
    assert.equal(result.mailtoFits, true);
    const mail = harness.events.external;
    assert.ok(String(mail).startsWith("mailto:princ.michael@gmail.com?"), "the draft is handed to the operator's own mail program");
    assert.ok(Buffer.byteLength(String(mail), "utf8") <= 1800, "and it is short enough for a mail client to accept whole");
    assert.ok(String(mail).includes("%0D%0A"), "with line breaks that survive the URI");
    const modal = harness.events.messages.find((item) => (item.buttons || []).includes("Open my mail program"));
    assert.ok(modal, "the offer is a question the operator has to answer");
    assert.equal(modal.options.modal, true, "and it is a modal, not a notification that can be clicked past");
    assert.ok(modal.options.detail.includes("Nothing is sent by the Toolkit"), "the modal says what it will and will not do");
    assert.ok(modal.options.detail.includes("Removed from the report before you saw it"), "and counts what it took out");
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test("cancelling the note writes nothing, copies nothing and opens nothing", async () => {
  const os = require("node:os");
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "research-report-"));
  try {
    const harness = makeHarness({ storageDir: storage, reportCancel: true });
    await assert.rejects(() => harness.registered.get("researchToolkit.reportProblem")(), /Report cancelled/);
    assert.deepEqual(harness.events.writtenFiles, [], "no file");
    assert.equal(harness.events.clipboard, undefined, "no clipboard write");
    assert.equal(harness.events.external, undefined, "no mail program asked to open");
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test("refusing the mail draft keeps the report and sends nothing", async () => {
  const os = require("node:os");
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "research-report-"));
  try {
    const harness = makeHarness({ storageDir: storage, reportNote: "uv sync timed out", confirmPrompt: false });
    const result = await harness.registered.get("researchToolkit.reportProblem")();
    assert.equal(harness.events.external, undefined, "no mail program was asked to open");
    assert.equal(harness.events.writtenFiles.length, 1, "the operator still has the report file");
    assert.ok(harness.events.clipboard.includes("WHAT WAS REMOVED FROM THIS REPORT"));
    assert.equal(result.mailtoFits, true);
  } finally {
    fs.rmSync(storage, { recursive: true, force: true });
  }
});

test("the version check is refused when the setting is off, and a published build becomes a stated update", async () => {
  const off = makeHarness({ initial: { checkForUpdates: false } });
  const refused = await off.registered.get("researchToolkit.checkForUpdates")();
  assert.equal(refused.state, "disabled");
  assert.equal(off.events.updateChecks.length, 0, "a switched-off check reaches no transport at all");

  const on = makeHarness({ updateReply: { status: 200, body: JSON.stringify({
    versions: [{ version: "0.3.11", lastUpdated: "2026-11-07T10:00:00Z", properties: [{ name: "Microsoft.VisualStudio.Code.Engine", value: "^1.140.0" }] }],
  }) } });
  const verdict = await on.registered.get("researchToolkit.checkForUpdates")();
  assert.equal(verdict.state, "update-available");
  assert.equal(verdict.publishedVersion, "0.3.11");
  assert.equal(verdict.installedVersion, require("../package.json").version);
  assert.equal(on.events.updateChecks.length, 1, "one request");
  assert.equal(on.events.updateChecks[0], "https://marketplace.visualstudio.com/_apis/public/gallery/vscode/michaelprinc/research-stack-toolkit/latest");
  const offer = on.events.messages.find((item) => item.buttons.includes("Update from the Marketplace"));
  assert.ok(offer, "the operator is told an update exists, with the version in the sentence");

  const panel = on.api.openControlPanel();
  await panel.receive({ type: "ready" });
  // The scheduled check is deliberately not awaited by the panel: a slow Marketplace must not hold the
  // first paint. The test looks again the way an operator does.
  let state = null;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    state = panel.messages.filter((item) => item.type === "state").at(-1) || null;
    if (state && state.update && state.update.cached) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(on.events.updateChecks.length, 1, "opening the panel again does not ask the Marketplace a second time on the same day");
  assert.ok(state && state.update, "the panel carries an update verdict");
  assert.equal(state.update.state, "update-available", "the panel keeps the verdict it already has instead of erasing it");
  assert.equal(state.update.cached, true, "and labels it as kept from the earlier check");
  assert.ok(state.update.checkedAtText, "with the stamp of when it was actually asked");
  panel.dispose();
});

test("a Marketplace that has not published this extension is reported as such, not as a failure", async () => {
  const harness = makeHarness({});
  const verdict = await harness.registered.get("researchToolkit.checkForUpdates")();
  assert.equal(verdict.state, "not-published");
  assert.equal(verdict.action, "install-from-marketplace");
  assert.equal(harness.events.updateChecks.length, 1);
  const said = harness.events.messages.find((item) => /No published version/.test(item.text));
  assert.ok(said, "the panel wording says what was found");
});

