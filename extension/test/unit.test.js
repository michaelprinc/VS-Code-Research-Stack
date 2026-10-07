"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const extension = require("../extension");

function makeHarness({ pickedId = "full", cancel = false } = {}) {
  const registered = new Map();
  const disposed = [];
  const values = new Map();
  const globalTarget = 1;
  const output = {
    clear() {},
    appendLine(value) { this.value = value; },
    show() { this.shown = true; },
    dispose() { disposed.push("output"); },
  };
  const vscode = {
    ConfigurationTarget: { Global: globalTarget },
    workspace: {
      getConfiguration(section) {
        assert.equal(section, "researchStack");
        return {
          get(key, fallback) { assert.equal(key, "selectedPackage"); return values.has(key) ? values.get(key) : fallback; },
          async update(key, value, target) {
            assert.equal(key, "selectedPackage");
            assert.equal(target, globalTarget);
            values.set(key, value);
          },
        };
      },
    },
    window: {
      createOutputChannel(name) { assert.equal(name, "Research Stack"); return output; },
      async showQuickPick(items, options) {
        assert.equal(options.title, "Select a Research Stack package");
        assert.equal(items.length, 3);
        assert.equal(items.find((item) => item.id === "recommended").description, "Currently selected");
        return cancel ? undefined : items.find((item) => item.id === pickedId);
      },
    },
    commands: {
      registerCommand(id, callback) {
        registered.set(id, callback);
        return { dispose() { disposed.push(id); } };
      },
    },
  };
  const context = {
    subscriptions: [],
  };
  extension.activateWith(vscode, context);
  return { registered, context, disposed, output, values };
}

test("manifest exposes lazy readiness and package-switch commands with no runtime dependencies", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vsix-manifest.json"), "utf8"));
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.main, "./extension.js");
  assert.deepEqual(manifest.activationEvents, [
    "onCommand:researchToolkit.showPhaseReadiness",
    "onCommand:researchToolkit.switchPackage",
  ]);
  assert.deepEqual(manifest.contributes.commands.map((item) => item.command), [
    "researchToolkit.showPhaseReadiness",
    "researchToolkit.switchPackage",
  ]);
  assert.deepEqual(manifest.contributes.configuration.properties["researchStack.selectedPackage"].enum, ["basic", "recommended", "full"]);
  assert.equal(manifest.contributes.configuration.properties["researchStack.selectedPackage"].scope, "application");
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.files.sort(), ["README.md", "extension.js", "package.json"]);
});

test("activation registers both disposable commands and reports the profile preference", async () => {
  const harness = makeHarness();
  assert.deepEqual([...harness.registered.keys()], [
    "researchToolkit.showPhaseReadiness",
    "researchToolkit.switchPackage",
  ]);
  assert.equal(harness.context.subscriptions.length, 3);
  let status = harness.registered.get("researchToolkit.showPhaseReadiness")();
  assert.match(status, /Selected package preference: Recommended Research \(recommended\)/);
  assert.match(status, /G1 not passed/);
  assert.match(status, /G2 not passed/);
  assert.match(status, /G3 not passed/);
  assert.match(status, /does not install, remove, or configure components/);

  status = await harness.registered.get("researchToolkit.switchPackage")("basic");
  assert.match(status, /Selected package preference: Basic \(basic\)/);
  assert.equal(harness.values.get("selectedPackage"), "basic");
  assert.equal(harness.output.shown, true);
  for (const subscription of harness.context.subscriptions) subscription.dispose();
  assert.equal(harness.disposed.length, 3);
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
