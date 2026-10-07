"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const extension = require("../extension");

test("manifest has one lazy command and no runtime dependencies", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vsix-manifest.json"), "utf8"));
  assert.equal(manifest.main, "./extension.js");
  assert.equal(manifest.activationEvents.length, 1);
  assert.equal(manifest.activationEvents[0], "onCommand:researchToolkit.showPhaseReadiness");
  assert.deepEqual(manifest.contributes.commands.map((item) => item.command), ["researchToolkit.showPhaseReadiness"]);
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.private, undefined);
  assert.deepEqual(manifest.files.sort(), ["README.md", "extension.js", "package.json"]);
});

test("activation only registers disposable output and readiness command", () => {
  const registered = new Map();
  const disposed = [];
  const output = {
    clear() {},
    appendLine(value) { this.value = value; },
    show() { this.shown = true; },
    dispose() { disposed.push("output"); },
  };
  const vscode = {
    window: { createOutputChannel(name) { assert.equal(name, "Research Stack"); return output; } },
    commands: {
      registerCommand(id, callback) {
        registered.set(id, callback);
        return { dispose() { disposed.push(id); } };
      },
    },
  };
  const context = { subscriptions: [] };

  extension.activateWith(vscode, context);
  assert.deepEqual([...registered.keys()], ["researchToolkit.showPhaseReadiness"]);
  assert.equal(context.subscriptions.length, 2);
  const status = registered.get("researchToolkit.showPhaseReadiness")();
  assert.match(status, /G1 not passed/);
  assert.match(status, /G2 not passed/);
  assert.match(status, /G3 not passed/);
  assert.match(status, /Setup, downloads, service starts.*disabled/);
  assert.equal(output.shown, true);
  for (const subscription of context.subscriptions) subscription.dispose();
  assert.equal(disposed.length, 2);
});

test("readiness formatting stays cheap under repeated access", () => {
  const start = process.hrtime.bigint();
  for (let index = 0; index < 10000; index += 1) extension.readinessText();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.ok(elapsedMs < 500, `10,000 status renders took ${elapsedMs.toFixed(2)} ms`);
});
