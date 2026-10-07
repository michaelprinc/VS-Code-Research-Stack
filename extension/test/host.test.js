"use strict";

const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
  const stage = process.env.PACKAGE_SWITCH_TEST_STAGE || "mutate";
  const start = performance.now();
  let status = await vscode.commands.executeCommand("researchToolkit.showPhaseReadiness");
  const activationAndCommandMs = performance.now() - start;
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("researchToolkit.showPhaseReadiness"), "readiness command is registered");
  assert.ok(commands.includes("researchToolkit.switchPackage"), "package switch command is registered");
  assert.match(status, /Research Stack Phase 4 preview/);
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
  } else if (stage === "persist") {
    assert.match(status, /Selected package preference: Full \(full\)/, "package choice persists across Extension Host restart");
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
  }));
}

module.exports = { run };
