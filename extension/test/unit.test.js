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
  const shippedAllowlist = ["README.md", "components.json", "diagnostics.js", "extension.js", "functional_check.py", "guides", "hosttools.js", "installer.js", "lockfile.js", "media", "package.json", "preflight.js", "presets.json", "probe.py", "runner.js", "runtime.js", "setuplog.js", "status.js", "steps.js", "ui.js", "worker"].sort();
  assert.deepEqual([...manifest.files].sort(), shippedAllowlist,
    "the shipped allowlist names every module the controller requires, including the 0.3.6 setup modules and the 0.3.7 lock reader");
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
  assert.equal(manifest.contributes.commands.length, 25);
});

test("activation registers both disposable commands and reports the profile preference", async () => {
  const harness = makeHarness();
  assert.equal(harness.registered.size, 25);
  for (const command of ["researchToolkit.retryFailedSteps", "researchToolkit.clearSetupLock", "researchToolkit.openSetupLog", "researchToolkit.copyInstallationDiagnostics"]) {
    assert.equal(typeof harness.registered.get(command), "function", `${command} is registered so the panel can offer it`);
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
  assert.equal(harness.disposed.length, 26, "every registered command and the status item are disposed with the extension");
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
  assert.ok(harness.invoked.some((item) => item.id === "markdown.showPreview" && item.args[0] === "extension/guides/index.md"));
  assert.ok(harness.invoked.some((item) => item.id === "workbench.action.openSettings"));
});

test("webview limits scripts and local resources and uses a fresh nonce", () => {
  const harness = makeHarness();
  const panel = harness.api.openControlPanel();
  assert.deepEqual(panel.options.localResourceRoots, ["extension/media"]);
  assert.match(panel.webview.html, /default-src 'none'/);
  assert.match(panel.webview.html, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
  assert.doesNotMatch(panel.webview.html, /unsafe-inline|onclick=|https?:\/\//);
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
