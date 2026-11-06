"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const extension = require("../extension");

const root = path.resolve(__dirname, "..");
const catalog = extension.presetCatalog;

test("preset registry is goal-shaped, unique, and offered by a package", () => {
  assert.equal(catalog.schemaVersion, 1);
  const ids = catalog.presets.map((item) => item.id);
  assert.equal(new Set(ids).size, ids.length, "preset ids must be unique");
  for (const preset of catalog.presets) {
    assert.match(preset.id, /^[a-z0-9-]+$/);
    assert.ok(preset.label.length > 3 && preset.label.length <= 64, preset.id);
    assert.ok(preset.goal.length > 30, `${preset.id}: every preset states the goal it serves`);
    assert.ok(preset.tips.length >= 2, `${preset.id}: presets guide the choice`);
    assert.ok(preset.requires.length >= 1, `${preset.id}: presets state what they need`);
    assert.deepEqual(preset.packages, [...new Set(preset.packages)].filter((item) => ["basic", "recommended", "full"].includes(item)));
    assert.ok(preset.packages.length >= 1, `${preset.id}: offered by at least one package`);
    assert.ok(preset.tools.length >= 1, `${preset.id}: a preset enables at least one tool`);
    for (const key of ["defaultFor"]) assert.ok(Array.isArray(preset[key]), `${preset.id}: defaultFor must be a list`);
    for (const packageId of preset.defaultFor) assert.ok(preset.packages.includes(packageId), `${preset.id}: default for ${packageId} must be offered by it`);
  }
  for (const packageId of ["basic", "recommended", "full"]) {
    const offered = extension.presetsForPackage(packageId);
    assert.ok(offered.length >= 2, `${packageId}: at least two presets so the choice is real`);
    const defaults = offered.filter((item) => item.defaultFor.includes(packageId));
    assert.equal(defaults.length, 1, `${packageId}: exactly one package default preset`);
    assert.equal(extension.defaultPresetFor(packageId), defaults[0].id);
  }
});

test("preset tools come from the shipped worker servers and never exceed the client ceiling", () => {
  const shipped = new Set(catalog.servers.flatMap((server) => server.tools));
  assert.equal(catalog.servers.length, 3);
  assert.equal(shipped.size, 20, "the shipped toolkit surface is twenty tools across three servers");
  const budget = catalog.budget;
  assert.equal(budget.clientCeiling, 128);
  assert.equal(budget.toolkitCeilingPerPreset, 12, "C-13: no preset may ship more than twelve toolkit tools");
  assert.equal(budget.minimumHeadroom, 20, "C-13: the widest preset keeps headroom for later releases");
  assert.ok(budget.accuracyBand < budget.ceilingWarning && budget.ceilingWarning < budget.clientCeiling);
  for (const preset of catalog.presets) {
    for (const tool of preset.tools) assert.ok(shipped.has(tool), `${preset.id}: ${tool} is not a shipped toolkit tool`);
    const estimate = extension.presetEstimate(preset);
    assert.equal(estimate.toolkitTools, preset.tools.length);
    assert.equal(estimate.totalTools, estimate.toolkitTools + estimate.thirdPartyTools);
    assert.ok(estimate.totalTools <= budget.clientCeiling, `${preset.id}: ${estimate.totalTools} tools exceeds the ${budget.clientCeiling}-tool ceiling`);
    assert.ok(estimate.toolkitTools <= budget.toolkitCeilingPerPreset, `${preset.id}: ${estimate.toolkitTools} toolkit tools exceeds ${budget.toolkitCeilingPerPreset}`);
    assert.ok(estimate.headroom >= budget.minimumHeadroom, `${preset.id}: only ${estimate.headroom} tools of headroom`);
    assert.ok(estimate.tokensEstimate > 0 && estimate.contextPercent > 0 && estimate.contextPercent < 100);
    assert.ok(estimate.servers.length >= 1 && estimate.servers.length <= catalog.servers.length);
    for (const module of estimate.servers) assert.ok(catalog.servers.some((server) => server.module === module));
    for (const item of preset.thirdParty) {
      assert.ok(Number.isInteger(item.toolsEstimate) && item.toolsEstimate > 0, `${preset.id}: third-party counts are estimates`);
      assert.ok(item.note.length > 10, `${preset.id}: every estimate states its basis`);
    }
  }
  const narrow = extension.presetEstimate(extension.PRESETS_BY_ID.get("read-and-cite"));
  const widest = extension.presetEstimate(extension.PRESETS_BY_ID.get("research-lab-max"));
  assert.ok(narrow.totalTools <= 4, "the narrowest preset stays a focused surface");
  assert.ok(widest.totalTools > budget.accuracyBand && widest.totalTools <= budget.clientCeiling, "the widest preset uses the budget without breaking the ceiling");
  assert.equal(widest.level, "near-ceiling");
  assert.equal(narrow.level, "focused");
  assert.ok(widest.headroom >= budget.minimumHeadroom, "the widest preset leaves headroom for later releases");
  const corpus = extension.presetEstimate(extension.PRESETS_BY_ID.get("corpus-lab"));
  assert.equal(corpus.toolkitTools, 11, "the corpus goal carries the full record-store surface, including verify_sources, plus the text reader");
  assert.ok(extension.PRESETS_BY_ID.get("corpus-lab").tools.includes("verify_sources"), "0.3.9: the corpus goal must be able to re-hash what it indexed");
  assert.deepEqual(corpus.servers, ["research_stack.mcp_server", "research_stack.lab_server"], "the corpus goal uses the record-store server plus the text reader");
  const workflow = extension.presetEstimate(extension.PRESETS_BY_ID.get("research-workflow"));
  assert.equal(workflow.toolkitTools, 11, "the Full journey preset stays inside the twelve-tool budget");
  assert.ok(workflow.headroom >= catalog.budget.minimumHeadroom);
  assert.deepEqual(extension.PRESETS_BY_ID.get("research-workflow").defaultFor, ["full"], "the Full package's default preset is the continuous workflow");
  for (const verb of ["read_document", "read_text_source", "index_corpus", "search_corpus", "evidence_read", "claims_read", "claims_write", "write_markdown"]) {
    assert.ok(extension.PRESETS_BY_ID.get("research-workflow").tools.includes(verb), `the workflow preset must include ${verb} for the journey to be continuous`);
  }
  for (const destructive of ["store_maintenance", "unindex_corpus"]) {
    assert.ok(!extension.PRESETS_BY_ID.get("research-workflow").tools.includes(destructive), `${destructive} is not part of the everyday workflow`);
  }
  assert.ok(extension.PRESETS_BY_ID.get("corpus-lab").packages.includes("full"));
  assert.ok(!extension.PRESETS_BY_ID.get("corpus-lab").packages.includes("recommended"), "corpus tools are not offered below the Full package");
});

test("measured tool schemas replace the vendor estimate once a setup receipt exists", () => {
  const preset = extension.PRESETS_BY_ID.get("research-core");
  const vendor = extension.presetEstimate(preset, undefined);
  assert.equal(vendor.measured, false);
  assert.equal(vendor.tokensEstimate, 10 * catalog.budget.vendorTokensPerTool);
  assert.equal(vendor.basis, "estimated");
  const surface = {
    toolCount: 9,
    servers: catalog.servers.map((server) => ({
      module: server.module,
      toolCount: server.tools.length,
      tools: server.tools.map((name) => ({ name, characters: 400, tokensEstimate: 140 })),
    })),
  };
  const measured = extension.presetEstimate(preset, surface);
  assert.equal(measured.measured, true);
  assert.equal(measured.basis, "measured");
  assert.equal(measured.measuredTools, 10);
  assert.equal(measured.tokensEstimate, 10 * 140);
  assert.equal(measured.totalTools, vendor.totalTools);
  const partial = extension.presetEstimate(preset, { servers: [{ module: "research_stack.mcp_server", tools: [{ name: "read_document", tokensEstimate: 150 }] }] });
  assert.equal(partial.measured, true);
  assert.equal(partial.basis, "partial");
  assert.equal(partial.measuredTools, 1);
  assert.equal(partial.tokensEstimate, 150 + 9 * catalog.budget.vendorTokensPerTool);
});

test("a preset only offered by another package falls back to the package default", () => {
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ initial: { selectedPackage: "full", toolsPreset: "research-lab-max" } });
  assert.equal(harness.api.state().selectedToolsPreset, "research-lab-max");
  harness.values.set("selectedPackage", "basic");
  const state = harness.api.state();
  assert.equal(state.toolsPresetSetting, "research-lab-max", "the saved value is preserved");
  assert.equal(state.selectedToolsPreset, "read-and-cite", "the effective preset follows the package");
  assert.ok(state.presets.every((item) => item.id !== "research-lab-max"));
  assert.match(state.readiness, /Selected tools preset: Read and cite a document · 4 toolkit tools/);
});

test("the tools preset is saved, validated, and reaches the worker through the environment", async () => {
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ initial: { selectedPackage: "recommended" } });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "ready" });
  const state = panel.messages.at(-1);
  assert.deepEqual(state.presets.map((item) => item.id), ["read-and-cite", "find-in-notes", "verify-citations", "zotero-handoff", "research-core"]);
  assert.equal(state.selectedToolsPreset, "research-core");
  assert.equal(state.toolsPresetSetting, "package-default");
  assert.equal(state.presets.find((item) => item.id === "research-core").isPackageDefault, true);
  await panel.receive({ type: "setPreset", id: "zotero-handoff" });
  assert.equal(harness.values.get("toolsPreset"), "zotero-handoff");
  assert.equal(harness.api.state().selectedToolsPreset, "zotero-handoff");
  assert.match(harness.statusBar.tooltip, /Tools preset: Prepare a Zotero import — 5 toolkit tools/);
  for (const message of [{ type: "setPreset", id: "research-lab-max" }, { type: "setPreset", id: "not-a-preset" }, { type: "setPreset", id: 7 }]) {
    await panel.receive(message);
    assert.equal(panel.messages.at(-1).type, "result");
    assert.match(panel.messages.at(-1).error, /tools preset/);
    assert.equal(harness.values.get("toolsPreset"), "zotero-handoff");
  }
  await panel.receive({ type: "setPreset", id: "package-default" });
  assert.equal(harness.values.get("toolsPreset"), "package-default");
  panel.dispose();
});

test("saving a preset for the workspace folder writes at folder scope and reports that scope", async () => {
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ initial: { selectedPackage: "recommended" } });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "ready" });
  assert.equal(panel.messages.at(-1).toolsPresetScope, "profile", "nothing is scoped before a save");
  await panel.receive({ type: "setPreset", id: "research-core", scope: "workspaceFolder" });
  assert.equal(harness.folderValues.get("toolsPreset"), "research-core", "the value is written at WorkspaceFolder scope");
  assert.equal(harness.api.state().toolsPresetScope, "workspaceFolder");
  assert.equal(harness.api.state().selectedToolsPreset, "research-core");
  panel.dispose();
});

test("Quick Pick lists only presets the package offers and keeps the choice in the budget", async () => {
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ initial: { selectedPackage: "full" }, pickedId: "research-lab-max" });
  const status = await harness.registered.get("researchToolkit.selectToolsPreset")();
  assert.equal(harness.values.get("toolsPreset"), "research-lab-max");
  assert.match(status, /Selected tools preset: Maximum research lab \(128-tool budget\) · 10 toolkit tools \+ 91 configured external tools \(vendor estimates\)/);
  const narrow = makeHarness({ initial: { selectedPackage: "basic" } });
  await assert.rejects(narrow.registered.get("researchToolkit.selectToolsPreset")("research-lab-max"), /Unknown tools preset for the selected package/);
  assert.equal(narrow.values.get("toolsPreset"), undefined);
  const cancelled = makeHarness({ initial: { selectedPackage: "full" }, cancel: true });
  assert.equal(await cancelled.registered.get("researchToolkit.selectToolsPreset")(), undefined);
  assert.equal(cancelled.values.get("toolsPreset"), undefined);
});

test("sidebar and readiness report the effective preset", async () => {
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ initial: { selectedPackage: "recommended" } });
  const rows = harness.provider.getChildren();
  assert.equal(rows[1].label, "Package: Recommended Research");
  assert.equal(rows[2].label, "Tools preset: Read, search, cite and write");
  assert.match(rows[2].tooltip, /goal-shaped tools preset/);
  await harness.registered.get("researchToolkit.copyReadiness")();
  assert.match(harness.events.clipboard, /Selected tools preset: Read, search, cite and write · 10 toolkit tools/);
});

test("recently used presets are offered first and labelled as recent (T5-35)", async () => {
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ initial: { selectedPackage: "recommended" }, pickedId: "verify-citations" });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "ready" });
  await panel.receive({ type: "setPreset", id: "zotero-handoff" });
  await panel.receive({ type: "setPreset", id: "verify-citations" });
  assert.deepEqual(harness.api.state().recentPresets, ["verify-citations", "zotero-handoff"], "most recent first");
  await harness.registered.get("researchToolkit.selectToolsPreset")();
  const listed = harness.events.quickPick.items.map((item) => item.id);
  assert.deepEqual(listed.slice(0, 2), ["verify-citations", "zotero-handoff"], "recent presets come before the rest of the package's list");
  assert.match(harness.events.quickPick.items[0].description, /recently used/);
  assert.ok(!harness.events.quickPick.items.some((item) => /applied/.test(item.description)),
    "with no managed runtime nothing is claimed as applied");
  assert.equal(harness.api.state().presetApplied, false, "saved is not the same as applied");
  panel.dispose();
});
