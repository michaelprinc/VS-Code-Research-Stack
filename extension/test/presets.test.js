"use strict";
/**
 * The preset surface as 0.3.14 states it: HR-10…HR-14, DD15-01, DD15-06, DD15-07, DD15-08 and
 * T15-10…T15-12 in specs/phase-15-hybrid-retrieval-presets-bundles/.
 *
 * Two kinds of number appear below and the difference is deliberate.
 *   - A RULE is asserted against values derived from `extension/presets.json` inside the test, so the rule
 *     still holds after the next release re-cuts a preset: "no preset may carry more verbs than the cap
 *     this file declares", "an entry's count is the length of the list it names".
 *   - A SHIPPED SURFACE is pinned to a literal, so a verb that joins or leaves a preset without a recorded
 *     decision is caught here rather than discovered by an operator: 21 verbs in the inventory, 16 for
 *     `research-max-github-full`, 15 for the Full default, 12 for `corpus-lab`.
 *
 * What is NOT claimed by any number here: that a GitHub MCP server has 92 or 42 tools. Those are name-list
 * counts taken from the vendor catalog as recorded in research/github-mcp-tool-map-2026-11-17.md; no
 * `tools/list` was captured on this host and the preset's own tips say the same. Token figures are the
 * budget's per-tool estimate unless a setup receipt says it measured the real schemas.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const extension = require("../extension");

const catalog = extension.presetCatalog;
const budget = catalog.budget;
/** The six verbs that make a preset able to work in the research store (R15-01 is their absence). */
const STORE_VERBS = ["index_corpus", "embed_corpus", "search_corpus", "evidence_read", "claims_read", "claims_write"];
const MAX_PRESETS = ["research-max-github-full", "research-max-github-limited", "research-max-no-github"];
const retiredPresets = () => catalog.presets.filter((preset) => preset.retired);
const presetById = (id) => extension.PRESETS_BY_ID.get(id);
const estimate = (id) => extension.presetEstimate(presetById(id));

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
    assert.equal(new Set(preset.tools).size, preset.tools.length, `${preset.id}: a verb is listed once`);
    for (const key of ["defaultFor"]) assert.ok(Array.isArray(preset[key]), `${preset.id}: defaultFor must be a list`);
    for (const packageId of preset.defaultFor) assert.ok(preset.packages.includes(packageId), `${preset.id}: default for ${packageId} must be offered by it`);
    // DD15-07: a retired preset is allowed to stay in the registry, but only with its successors named and
    // without a package default claim on it.
    if (preset.retired) {
      assert.deepEqual(preset.defaultFor, [], `${preset.id}: a retired preset is never a package default`);
      assert.ok(Array.isArray(preset.successor) && preset.successor.length >= 1, `${preset.id}: a retired preset names what replaces it`);
      for (const successor of preset.successor) {
        const target = presetById(successor);
        assert.ok(target, `${preset.id}: successor ${successor} must exist in this package`);
        assert.ok(!target.retired, `${preset.id}: successor ${successor} is itself retired`);
      }
    }
  }
  for (const packageId of ["basic", "recommended", "full"]) {
    const offered = extension.presetsForPackage(packageId);
    assert.ok(offered.length >= 2, `${packageId}: at least two presets so the choice is real`);
    const defaults = offered.filter((item) => item.defaultFor.includes(packageId));
    assert.equal(defaults.length, 1, `${packageId}: exactly one package default preset`);
    assert.equal(extension.defaultPresetFor(packageId), defaults[0].id);
    assert.ok(!offered.some((preset) => preset.retired), `${packageId}: no retired preset is offered`);
  }
});

test("preset tools come from the shipped worker servers and never exceed the client ceiling", () => {
  const shipped = new Set(catalog.servers.flatMap((server) => server.tools));
  assert.equal(catalog.servers.length, 3);
  // DD15-08: `embed_corpus` joins the inventory in 0.3.14, so the shipped toolkit surface is 21 verbs.
  // The count is pinned because it is the shipped surface, and checked against the servers it is derived from.
  assert.equal(shipped.size, 21, "the shipped toolkit surface is twenty-one verbs across three servers");
  assert.equal(shipped.size, catalog.servers.reduce((total, server) => total + server.tools.length, 0),
    "no verb is shared between the three servers, so the server lists and the inventory agree");
  assert.ok(shipped.has("embed_corpus"), "0.3.14's store verb for building retrieval vectors ships in the lab server");
  assert.equal(catalog.servers.find((server) => server.module === "research_stack.lab_server").tools.length, 11,
    "the corpus server registers eleven verbs, embed_corpus among them");
  assert.equal(budget.clientCeiling, 128);
  assert.equal(budget.toolkitCeilingPerPreset, 20, "HR-13 / DD15-01: the cap is twenty verbs per preset, not the 0.3.13 twelve");
  assert.equal(budget.minimumHeadroom, 20, "HR-13: the widest preset keeps twenty tools of headroom under the ceiling");
  assert.ok(budget.accuracyBand < budget.ceilingWarning && budget.ceilingWarning < budget.clientCeiling);
  assert.equal(budget.toolkitCeilingPerPreset <= shipped.size, true, "the cap must be reachable with the verbs this package ships");

  for (const preset of catalog.presets) {
    for (const tool of preset.tools) assert.ok(shipped.has(tool), `${preset.id}: ${tool} is not a shipped toolkit tool`);
    const surface = extension.presetEstimate(preset);
    assert.equal(surface.toolkitTools, preset.tools.length);
    assert.equal(surface.thirdPartyTools, (preset.thirdParty || []).reduce((total, item) => total + item.toolsEstimate, 0),
      `${preset.id}: the external count is the sum of its entries`);
    assert.equal(surface.totalTools, surface.toolkitTools + surface.thirdPartyTools);
    assert.ok(surface.toolkitTools <= budget.toolkitCeilingPerPreset, `${preset.id}: ${surface.toolkitTools} toolkit verbs exceeds the ${budget.toolkitCeilingPerPreset}-verb cap`);
    // HR-13 / T15-12: the rule is on the total, so a wide third-party surface cannot lean on the verb cap.
    assert.ok(surface.totalTools <= budget.clientCeiling - budget.minimumHeadroom,
      `${preset.id}: ${surface.totalTools} tools leaves ${budget.clientCeiling - surface.totalTools} of the ${budget.minimumHeadroom} the budget keeps`);
    assert.equal(surface.headroom, budget.clientCeiling - surface.totalTools, `${preset.id}: headroom is what is left, not a promise`);
    assert.ok(surface.tokensEstimate > 0 && surface.contextPercent > 0 && surface.contextPercent < 100);
    assert.ok(surface.servers.length >= 1 && surface.servers.length <= catalog.servers.length);
    for (const module of surface.servers) assert.ok(catalog.servers.some((server) => server.module === module));
    for (const item of preset.thirdParty || []) {
      assert.ok(Number.isInteger(item.toolsEstimate) && item.toolsEstimate > 0, `${preset.id}: a third-party entry counts whole tools`);
      assert.ok(item.note.length > 10, `${preset.id}: every third-party entry states its basis`);
    }
  }

  const narrow = extension.presetEstimate(presetById("read-and-cite"));
  assert.ok(narrow.totalTools <= 4, "the narrowest preset stays a focused surface");
  assert.equal(narrow.level, "focused");
  // R15-11: 0.3.13's changelog called `research-lab-max` the widest preset. It is retired and carries no
  // third-party surface at all now, so the claim is checked against the shipped range instead.
  const retiredWidest = extension.presetEstimate(presetById("research-lab-max"));
  assert.equal(retiredWidest.thirdPartyTools, 0, "a retired preset no longer carries an unnamed estimate");
  assert.ok(retiredWidest.totalTools < narrow.totalTools + 100, "the retired preset is not the widest surface in this release");
  assert.ok(extension.PRESETS_BY_ID.get("corpus-lab").packages.includes("full"));
  assert.ok(!extension.PRESETS_BY_ID.get("corpus-lab").packages.includes("recommended"), "corpus tools are not offered below the Full package");
});

test("HR-11: a third-party entry's count is the length of the tools it names (T15-11)", () => {
  const entries = catalog.presets.flatMap((preset) => (preset.thirdParty || []).map((item) => ({ preset, item })));
  assert.ok(entries.length >= 2, "the shipped range names at least one third-party surface, so this test has something to measure");
  const seen = new Map();
  for (const { preset, item } of entries) {
    const where = `${preset.id}/${item.id}`;
    assert.ok(Array.isArray(item.tools), `${where}: HR-11 needs a list of names, not a number`);
    assert.ok(item.tools.length > 0, `${where}: an entry that names no tools is an estimate, which 0.3.14 does not allow`);
    assert.equal(new Set(item.tools).size, item.tools.length, `${where}: a tool name is listed once`);
    assert.equal(item.toolsEstimate, item.tools.length, `${where}: the count IS the length of the named list`);
    assert.equal(typeof item.readOnly, "boolean", `${where}: the preset says whether its selection reads or acts`);
    assert.ok(item.note.length > 10, `${where}: the basis of the names is stated`);
    assert.ok(Array.isArray(item.toolsets) && item.toolsets.length >= 1, `${where}: the toolsets the names come from are stated`);
    assert.equal(new Set(item.toolsets).size, item.toolsets.length, `${where}: a toolset is listed once`);
    assert.ok(item.server && typeof item.server === "object", `${where}: the entry names the server form it means`);
    assert.ok(/^https:\/\/api\.githubcopilot\.com\/[A-Za-z0-9/_.-]+$/.test(item.server.remoteUrl), `${where}: only the reviewed remote form is named`);
    assert.ok(typeof item.server.localToolsets === "string" && item.server.localToolsets.length > 0, `${where}: the local form is named too`);
    if (item.server.excludeTools) {
      assert.ok(Array.isArray(item.server.excludeTools), `${where}: the exclusion is a list`);
      assert.equal(new Set(item.server.excludeTools).size, item.server.excludeTools.length, `${where}: a tool is not excluded twice`);
      for (const name of item.server.excludeTools) {
        assert.ok(!item.tools.includes(name), `${where}: ${name} is both selected and excluded`);
      }
    }
    seen.set(`${preset.id}/${item.id}`, item);
  }
  const full = presetById("research-max-github-full").thirdParty[0];
  const limited = presetById("research-max-github-limited").thirdParty[0];
  // The two GitHub presets select from one reviewed catalog, so a name in the narrower one must exist in the
  // wider one. That is what stops a preset inventing a tool nobody published.
  for (const name of limited.tools) assert.ok(full.tools.includes(name), `research-max-github-limited names ${name}, which the full catalog does not`);
  for (const toolset of limited.toolsets) assert.ok(full.toolsets.includes(toolset), `research-max-github-limited enables toolset ${toolset}, which the full preset does not`);
  // A preset with no third-party surface says so with an empty list, not with an entry that names nothing.
  for (const preset of catalog.presets) {
    if (preset.thirdParty && preset.thirdParty.length === 0) continue;
    if ((preset.thirdParty || []).length === 0) assert.ok(Array.isArray(preset.thirdParty), `${preset.id}: no external surface is an empty list, not a missing field`);
  }
});

test("HR-13: no preset passes the verb cap and the widest one leaves exactly the headroom (T15-12)", () => {
  const capRule = budget.toolkitCeilingPerPreset;
  const totalRule = budget.clientCeiling - budget.minimumHeadroom;
  const surfaces = catalog.presets.map((preset) => extension.presetEstimate(preset));
  for (const surface of surfaces) {
    assert.ok(surface.toolkitTools <= capRule, `${surface.presetId}: ${surface.toolkitTools} verbs is over the ${capRule}-verb cap`);
    assert.ok(surface.totalTools <= totalRule, `${surface.presetId}: ${surface.totalTools} tools is over ${totalRule}, the ceiling less the headroom`);
    assert.ok(surface.headroom >= budget.minimumHeadroom, `${surface.presetId}: only ${surface.headroom} tools of headroom`);
  }
  const widest = surfaces.slice().sort((left, right) => right.totalTools - left.totalTools)[0];
  assert.equal(widest.presetId, "research-max-github-full", "the widest shipped surface is the full GitHub max preset");
  assert.equal(widest.totalTools, 108, "16 toolkit verbs + 92 named GitHub tools = 108 (DD15-06 trims the toolkit side, never the GitHub side)");
  assert.equal(widest.headroom, 20, "the widest preset sits on exactly the minimum headroom, not below it");
  assert.equal(widest.toolkitTools, 16, "research-max-github-full carries sixteen toolkit verbs");
  assert.equal(widest.thirdPartyTools, 92, "and the ninety-two tool names the vendor catalog published");
  assert.equal(widest.level, "near-ceiling", "108 of 128 is near the ceiling and the panel must say so");
  assert.equal(Math.max(...surfaces.map((surface) => surface.toolkitTools)), 20, "at least one preset uses the whole 20-verb cap, so the cap is a real ceiling");
  assert.equal(presetById("research-max-github-limited").thirdParty[0].tools.length, 42, "the read-only preset names 42 GitHub tools");
  assert.equal(extension.presetEstimate(presetById("research-max-github-limited")).totalTools, 62, "20 verbs + 42 named tools = 62");
  assert.equal(extension.presetEstimate(presetById("research-max-no-github")).thirdPartyTools, 0, "the no-GitHub preset names no third-party surface");
  assert.equal(presetById("research-max-no-github").thirdParty.length, 0, "and it says so with an empty list");
});

test("HR-10: the three max presets differ in GitHub support and each carries the store verbs (T15-10, closes R15-01)", () => {
  const surface = new Set(catalog.servers.flatMap((server) => server.tools));
  assert.equal(MAX_PRESETS.length, 3, "0.3.14 ships three max presets");
  for (const id of MAX_PRESETS) {
    const preset = presetById(id);
    assert.ok(preset, `${id} ships`);
    assert.ok(!preset.retired, `${id} is a shipped preset, not a retired one`);
    assert.ok(preset.packages.includes("full"), `${id} is offered by the Full package`);
    for (const verb of STORE_VERBS) {
      assert.ok(preset.tools.includes(verb), `${id}: ${verb} is the verb R15-01 found missing from the widest preset`);
      assert.ok(surface.has(verb), `${verb} ships in a managed server`);
    }
    // HR-14: each preset states the verb it leaves out. The dropped verbs are the difference between the
    // 21-verb inventory and this preset's list, and each preset must say so in its own tips.
    const leftOut = [...surface].filter((verb) => !preset.tools.includes(verb));
    assert.ok(leftOut.length > 0, `${id}: a preset under the cap names what it leaves out`);
    for (const verb of leftOut) {
      assert.ok(preset.tips.some((tip) => tip.includes(verb)), `${id}: its tips name ${verb} as a verb this goal does not use`);
    }
  }
  const full = presetById("research-max-github-full");
  const limited = presetById("research-max-github-limited");
  const none = presetById("research-max-no-github");
  assert.equal(full.thirdParty[0].readOnly, false, "the full preset's GitHub selection reads and acts");
  assert.equal(limited.thirdParty[0].readOnly, true, "the limited preset's GitHub selection is read-only");
  assert.equal(none.thirdParty.length, 0, "the third preset has no GitHub surface at all");
  assert.equal(full.tools.length, 16);
  assert.equal(limited.tools.length, 20);
  assert.equal(none.tools.length, 20);
  // The read-only selection excludes the write surface. The 35 names are the vendor catalog's write tools
  // (research/github-mcp-tool-map-2026-11-17.md) — a name count, not a measurement of a running server.
  const excluded = limited.thirdParty[0].server.excludeTools;
  assert.equal(excluded.length, 35, "every write name in the catalog is excluded, not left to a server default");
  for (const name of excluded) assert.ok(full.thirdParty[0].tools.includes(name), `${name} is excluded but is not a name the catalog publishes`);
  assert.ok(!limited.tools.some((name) => excluded.includes(name)), "a read-only selection does not select a name it excludes");
  assert.ok(limited.thirdParty[0].server.remoteUrl.includes("readonly"), "the limited preset names the vendor's read-only endpoint");
  assert.ok(full.thirdParty[0].server.remoteUrl.includes("/all"), "the full preset names the vendor's whole-catalog endpoint");
  // The destructive pair lives where the operator is working on the store, and each preset says which of the
  // pair it leaves out (preset-selection.md §3): `research-max-github-limited` keeps `unindex_corpus` but
  // drops `store_maintenance`, and `research-max-github-full` drops both.
  for (const id of ["corpus-lab", "research-max-no-github"]) {
    for (const verb of ["store_maintenance", "unindex_corpus"]) {
      assert.ok(presetById(id).tools.includes(verb), `${id} owns the store, so it carries ${verb}`);
    }
  }
  for (const id of ["research-max-github-full", "research-workflow"]) {
    for (const verb of ["store_maintenance", "unindex_corpus"]) {
      assert.ok(!presetById(id).tools.includes(verb), `${verb} is not part of ${id}'s objective`);
    }
  }
  assert.ok(presetById("research-max-github-limited").tools.includes("unindex_corpus"), "the read-only max preset keeps unindex_corpus: its 20 verbs are all but store_maintenance");
  assert.ok(!presetById("research-max-github-limited").tools.includes("store_maintenance"), "and drops store_maintenance, which its tips name as the verb this goal leaves out");
});

test("the Full default reaches fifteen verbs and the corpus goal twelve (preset-selection.md §6)", () => {
  const workflow = extension.presetEstimate(presetById("research-workflow"));
  assert.equal(workflow.toolkitTools, 15, "0.3.14 moves the Full default from 11 to 15 verbs: embed_corpus, verify_sources, claims_export and store_status join");
  assert.ok(workflow.headroom >= budget.minimumHeadroom);
  assert.deepEqual(presetById("research-workflow").defaultFor, ["full"], "the Full package's default preset is the continuous workflow");
  for (const verb of ["read_document", "read_text_source", "index_corpus", "embed_corpus", "search_corpus", "evidence_read", "claims_read", "claims_write", "write_markdown"]) {
    assert.ok(presetById("research-workflow").tools.includes(verb), `the workflow preset must include ${verb} for the journey to be continuous`);
  }
  for (const verb of ["verify_sources", "claims_export", "store_status"]) {
    assert.ok(presetById("research-workflow").tools.includes(verb), `${verb} joins the journey in 0.3.14: a report cites evidence that has been re-verified and exported`);
  }
  const corpus = extension.presetEstimate(presetById("corpus-lab"));
  const storeVerbs = catalog.servers.find((server) => server.module === "research_stack.lab_server").tools;
  assert.equal(corpus.toolkitTools, 12, "the corpus goal is the twelve-verb surface: every store verb plus the text reader");
  for (const verb of storeVerbs) assert.ok(presetById("corpus-lab").tools.includes(verb), `corpus-lab: ${verb} is a store verb and this is the preset that owns the store`);
  assert.ok(corpus.toolkitTools === storeVerbs.length + 1, `the corpus surface is the ${storeVerbs.length} store verbs plus read_text_source`);
  assert.ok(presetById("corpus-lab").tools.includes("read_text_source"), "a corpus hit has to be reopenable with its provenance");
  assert.deepEqual(corpus.servers, ["research_stack.mcp_server", "research_stack.lab_server"], "the corpus goal uses the record-store server plus the text reader");
});

test("a retired preset is never offered, never a default, and still resolves when it is what was saved (DD15-07 / T15-10)", async () => {
  const retired = retiredPresets();
  assert.equal(retired.length, 2, "0.3.14 retires research-lab and research-lab-max, and only those two");
  assert.deepEqual(retired.map((preset) => preset.id).sort(), ["research-lab", "research-lab-max"]);
  for (const preset of retired) {
    for (const packageId of ["basic", "recommended", "full"]) {
      assert.ok(!extension.presetsForPackage(packageId).some((item) => item.id === preset.id), `${preset.id} is not offered by ${packageId}`);
      assert.notEqual(extension.defaultPresetFor(packageId), preset.id, `${preset.id} is not the default of ${packageId}`);
    }
    assert.ok(extension.PRESETS_BY_ID.has(preset.id), `${preset.id} is still a known preset id, so a saved value resolves`);
    for (const successor of preset.successor) {
      const target = presetById(successor);
      assert.ok(MAX_PRESETS.includes(successor), `${preset.id} is replaced by a max preset, not by another estimate`);
      assert.ok(extension.presetEstimate(target).toolkitTools >= 16, `${preset.id}: its successor ${successor} carries more toolkit verbs than it did (${preset.tools.length})`);
    }
  }

  const harness = require("./harness");
  const { makeHarness } = harness;
  const saved = makeHarness({ initial: { selectedPackage: "full", toolsPreset: "research-lab-max" } });
  const state = saved.api.state();
  assert.equal(state.toolsPresetSetting, "research-lab-max", "the saved value is kept, not rewritten by the retirement");
  assert.equal(state.selectedToolsPreset, "research-lab-max", "and it still resolves instead of falling back in silence");
  assert.ok(!state.presets.some((item) => item.retired), "the panel's preset list offers no retired preset");
  assert.ok(!state.presets.some((item) => item.id === "research-lab-max"), "the retired preset has no card in the panel");
  assert.ok(MAX_PRESETS.every((id) => state.presets.some((item) => item.id === id)), "the panel does offer the three max presets this package carries");
  assert.equal(typeof state.presetRetirement, "string", "the state names the retirement instead of leaving it to be inferred");
  assert.match(state.presetRetirement, /research-lab-max/, "it names the preset the operator actually saved");
  assert.match(state.presetRetirement, /retired in 0\.3\.14/, "and says when and why");
  for (const successor of presetById("research-lab-max").successor) {
    assert.ok(state.presetRetirement.includes(successor), `the retirement names the successor ${successor}`);
    assert.ok(state.presetRetirement.includes(presetById(successor).label), `and gives it a label the operator can look for`);
  }
  assert.match(saved.api.state().readiness, /Selected tools preset: Maximum research lab \(retired\) · 9 toolkit tools/, "the readiness line states the retired preset's real toolkit-tool count");

  // The picker: a retired preset is not a row, and the row the operator can act on carries the retirement.
  await saved.registered.get("researchToolkit.selectToolsPreset")();
  const items = saved.events.quickPick.items;
  assert.ok(!items.some((item) => item.id === "research-lab-max"), "the preset Quick Pick does not list a retired preset");
  assert.ok(!items.some((item) => item.id === "research-lab"), "nor the other retired one");
  assert.match(items.at(-1).description, /Default for this package/, "the last row is still the package default");
  assert.match(items.at(-1).description, /retired in 0\.3\.14/, "and it says why the operator's own preset is missing from the list");
  for (const successor of presetById("research-lab-max").successor) {
    assert.ok(items.at(-1).description.includes(successor), `the Quick Pick names ${successor} as a replacement`);
  }

  // Both doors refuse a *new* choice of a retired preset, and leave the saved value where it was.
  await assert.rejects(saved.registered.get("researchToolkit.selectToolsPreset")("research-lab-max"), /retired in 0\.3\.14/);
  assert.equal(saved.values.get("toolsPreset"), "research-lab-max", "a refusal changes nothing");
  const panel = saved.api.openControlPanel();
  await panel.receive({ type: "ready" });
  await new Promise((resolve) => setTimeout(resolve, 80)); // let the panel's scheduled version check settle into a state first
  await panel.receive({ type: "setPreset", id: "research-lab-max" });
  const refusal = panel.messages.filter((message) => message.type === "result").at(-1);
  assert.ok(refusal, "the panel answered the request it was given");
  assert.match(refusal.error, /retired in 0\.3\.14/, "the panel refuses it too and names the reason");
  assert.equal(saved.values.get("toolsPreset"), "research-lab-max", "and writes nothing");
  panel.dispose();

  // A retired id that the package never offered is still an unknown preset, as before.
  const narrow = makeHarness({ initial: { selectedPackage: "basic" } });
  await assert.rejects(narrow.registered.get("researchToolkit.selectToolsPreset")("research-lab-max"), /Unknown tools preset for the selected package/);
  assert.equal(narrow.values.get("toolsPreset"), undefined, "refusing it does not save it");

  // A live preset gains no retirement text, so nothing new is claimed about presets that are not retired.
  const live = makeHarness({ initial: { selectedPackage: "full", toolsPreset: "corpus-lab" } });
  assert.equal(live.api.state().presetRetirement, undefined, "a preset that is not retired carries no retirement text");
  live.registered.get("researchToolkit.selectToolsPreset")();
  assert.ok(!live.events.quickPick.items.at(-1).description.includes("retired"), "and the Quick Pick says nothing about retirement for it");
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
  assert.equal(state.presetRetirement, undefined, "the retirement text follows the preset in force, not the saved id");
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

test("the Quick Pick lists the goals this package offers and the status names the widest one honestly", async () => {
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ initial: { selectedPackage: "full" }, pickedId: "research-max-github-full" });
  const status = await harness.registered.get("researchToolkit.selectToolsPreset")();
  const listed = harness.events.quickPick.items.map((item) => item.id);
  assert.deepEqual(listed.slice(0, -1), extension.presetsForPackage("full").map((item) => item.id),
    "the picker lists exactly the presets this package offers — the three max presets among them, the two retired ones absent");
  assert.equal(harness.values.get("toolsPreset"), "research-max-github-full");
  const widest = presetById("research-max-github-full");
  assert.match(status, new RegExp(`Selected tools preset: ${widest.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} · 16 toolkit tools \\+ 92 configured external tools \\(tools the preset names\\)`),
    "the widest preset is described by its real counts, and the external number is labelled as a list the preset names");
  assert.ok(!/vendor estimates/.test(status), "a preset that names its tools is not reported as an estimate");
  const narrow = makeHarness({ initial: { selectedPackage: "basic" } });
  await assert.rejects(narrow.registered.get("researchToolkit.selectToolsPreset")("research-max-github-full"), /Unknown tools preset for the selected package/);
  assert.equal(narrow.values.get("toolsPreset"), undefined);
  const cancelled = makeHarness({ initial: { selectedPackage: "full" }, cancel: true });
  assert.equal(await cancelled.registered.get("researchToolkit.selectToolsPreset")(), undefined);
  assert.equal(cancelled.values.get("toolsPreset"), undefined);
});

test("the diagnosis line names what the external number is, and offers only presets this package offers", async () => {
  const { makeHarness } = require("./harness");
  const named = makeHarness({ initial: { selectedPackage: "full", toolsPreset: "research-max-github-full" } });
  const diagnosis = await named.registered.get("researchToolkit.diagnoseToolLimit")();
  assert.match(diagnosis, /Client ceiling: 128 tools/);
  assert.match(diagnosis, /External tools you configured: 92 \(the exact tool names this preset selects/);
  assert.match(diagnosis, /a vendor-published name list, not a measurement/, "and says what those names are and are not");
  assert.ok(!/vendor-published toolset estimates/.test(diagnosis), "a named surface is not reported as a toolset estimate");
  assert.match(diagnosis, /Total estimate: 108 of 128 · headroom 20 · level near-ceiling/);
  assert.ok(!/research-lab/.test(diagnosis), "the diagnosis offers only presets the package still offers, never a retired one");
  // Derived, not remembered: the three narrowest presets the Full package still offers, smallest first.
  const narrower = extension.presetsForPackage("full")
    .filter((preset) => preset.id !== "research-max-github-full")
    .map((preset) => extension.presetEstimate(preset))
    .sort((left, right) => left.totalTools - right.totalTools)
    .slice(0, 3);
  assert.match(diagnosis, new RegExp(`Narrower presets this package offers: ${narrower.map((surface) => `${presetById(surface.presetId).label} \\(${surface.totalTools} tools\\)`).join(", ")}`),
    "the narrower suggestions are the package's own smallest surfaces, in the order it claims");

  const none = makeHarness({ initial: { selectedPackage: "full", toolsPreset: "research-max-no-github" } });
  const local = await none.registered.get("researchToolkit.diagnoseToolLimit")();
  assert.match(local, /External tools you configured: 0 \(none: this preset names no third-party surface\)/, "a preset with no external surface says none, not zero estimates");
  assert.match(local, /Toolkit contribution now: 20 toolkit tools from 3 managed MCP server\(s\)/);
});

test("the copied preset summary states the named tools and the retirement, if any (HR-11)", async () => {
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ initial: { selectedPackage: "full", toolsPreset: "research-max-github-full" } });
  const summary = await harness.registered.get("researchToolkit.copyPresetSummary")();
  assert.match(summary, /Toolkit tools \(16\): read_document, read_text_source/);
  assert.match(summary, /GitHub MCP, every published toolset — 92 tools this preset names by name/, "the summary uses the preset's own names");
  assert.match(summary, /vendor-published names, not measured by this extension/, "and states the basis of those names");
  assert.match(summary, /Total against the client ceiling: 108 of 128 · headroom 20/);
  assert.ok(!summary.includes("retired in 0.3.14"), "a shipped preset carries no retirement text");

  const retired = makeHarness({ initial: { selectedPackage: "full", toolsPreset: "research-lab" } });
  const retiredSummary = await retired.registered.get("researchToolkit.copyPresetSummary")();
  assert.match(retiredSummary, /research-lab/, "a summary of the retired preset names it");
  assert.match(retiredSummary, /retired in 0\.3\.14/, "and says it is retired before the operator pastes it somewhere as current");
  assert.ok(retiredSummary.includes("research-max-github-limited"), "naming the successor is part of the summary");
});

test("measured tool schemas replace the vendor estimate once a setup receipt exists", () => {
  const preset = presetById("research-core");
  const vendor = extension.presetEstimate(preset, undefined);
  assert.equal(vendor.measured, false);
  assert.equal(vendor.tokensEstimate, 9 * budget.vendorTokensPerTool);
  assert.equal(vendor.basis, "estimated");
  const surface = {
    toolCount: 21,
    servers: catalog.servers.map((server) => ({
      module: server.module,
      toolCount: server.tools.length,
      tools: server.tools.map((name) => ({ name, characters: 400, tokensEstimate: 140 })),
    })),
  };
  const measured = extension.presetEstimate(preset, surface);
  assert.equal(measured.measured, true);
  assert.equal(measured.basis, "measured");
  assert.equal(measured.measuredTools, 9);
  assert.equal(measured.tokensEstimate, 9 * 140);
  assert.equal(measured.totalTools, vendor.totalTools);
  const partial = extension.presetEstimate(preset, { servers: [{ module: "research_stack.mcp_server", tools: [{ name: "read_document", tokensEstimate: 150 }] }] });
  assert.equal(partial.measured, true);
  assert.equal(partial.basis, "partial");
  assert.equal(partial.measuredTools, 1);
  assert.equal(partial.tokensEstimate, 150 + 8 * budget.vendorTokensPerTool);
});

test("sidebar and readiness report the effective preset", async () => {
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ initial: { selectedPackage: "recommended" } });
  const rows = harness.provider.getChildren();
  assert.equal(rows[1].label, "Package: Recommended Research");
  assert.equal(rows[2].label, "Tools preset: Read, search, cite and write");
  assert.match(rows[2].tooltip, /goal-shaped tools preset/);
  await harness.registered.get("researchToolkit.copyReadiness")();
  assert.match(harness.events.clipboard, /Selected tools preset: Read, search, cite and write · 9 toolkit tools/);
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

test("a saved 0.3.13 preset id stays valid across the 0.3.14 package change", () => {
  // The settings contribution carries every id this package can resolve, retired ones included, so VS Code
  // does not treat a saved 0.3.13 preference as an invalid value and quietly drop it.
  const fs = require("node:fs");
  const path = require("node:path");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "vsix-manifest.json"), "utf8"));
  const development = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  for (const [file, contributed] of [["vsix-manifest.json", manifest], ["package.json", development]]) {
    const setting = contributed.contributes.configuration.properties["researchStack.toolsPreset"];
    assert.equal(setting.enum.length, setting.enumItemLabels.length, `${file}: every selectable id has a label in the same position`);
    for (const preset of catalog.presets) {
      assert.ok(setting.enum.includes(preset.id), `${file}: ${preset.id} stays a valid saved value`);
      assert.equal(setting.enumItemLabels[setting.enum.indexOf(preset.id)], preset.label,
        `${file}: ${preset.id} is labelled with its registry label, not a stale one`);
    }
    for (const preset of retiredPresets()) {
      assert.ok(setting.enum.includes(preset.id), `${file}: the retired ${preset.id} is still accepted as a saved value (DD15-07)`);
      assert.match(setting.enumItemLabels[setting.enum.indexOf(preset.id)], /\(retired\)$/, `${file}: its label says retired`);
    }
  }
  assert.equal(manifest.version, development.version, "the two manifests are the same release");
});
