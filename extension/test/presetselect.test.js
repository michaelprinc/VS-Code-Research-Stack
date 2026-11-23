"use strict";
/**
 * Preset → Copilot tool selection (0.3.14, HR-11, HR-12, DD15-03, DD15-06, DD15-07).
 *
 * `extension/presetselect.js` is pure, so most cases here are a function over a preset object and a
 * string: no filesystem, no process, no network, no clock (each case that needs a timestamp passes one).
 * The last cases drive the shipped command through the editor harness against a real temporary workspace,
 * because "written only on an explicit operator action, with a copy kept of what it replaced" is a claim
 * about the write, and only a write proves it.
 *
 * The three rules the cases are built around:
 *   - HR-11: a selection's tool count is the length of the names it lists. `toolsEstimate` is checked
 *     against that list and then never used, so a preset that disagrees is refused, not trusted.
 *   - HR-12 / DD15-03: the selection is written in the shape the harness honours (`mcpServers` with a
 *     per-server `tools` allow-list). The deprecated editor `servers` shape is refused because a subset
 *     written into it would be silently ignored.
 *   - Preserve what the Toolkit did not write, and never produce a byte that carries a credential. A
 *     refusal is "nothing was produced", never "partly produced".
 *
 * What is not claimed here, and is stated in the module header too: that these tool names exist on a
 * running GitHub MCP server. Every name comes from the vendor catalog recorded in
 * `research/github-mcp-tool-map-2026-11-17.md`; no `tools/list` was captured on this host.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  TOOLKIT_ID, MARKER_KEY, MCP_FILE_NAME, TOKEN_ENV_REFERENCE, LOCAL_COMMAND, LOCAL_ARGS, REFUSALS,
  looksLikeCredential, isToolkitWritten, selectionForPreset, remoteEntry, localEntry, mergeIntoMcpFile,
} = require("../presetselect");
const { makeHarness } = require("./harness");
const { fileLink } = require("./linkfixture");

const PRESETS_PATH = path.join(__dirname, "..", "presets.json");
const PRESETS = JSON.parse(fs.readFileSync(PRESETS_PATH, "utf8")).presets;
const STAMP = "2026-11-17T00:00:00.000Z";
const presetById = (id) => structuredClone(PRESETS.find((preset) => preset.id === id));

/**
 * Escape a real path for use in a RegExp. The 19 November 2026 Windows run failed here: the review
 * quotes the target and the archive folder as `path.join` produces them on the host, so an assertion
 * written with a literal forward slash (`/.research-toolkit\/preset-tools/`) matched on Linux and
 * missed on Windows, where the same path is `.research-toolkit\preset-tools`. Deriving the expected
 * text from `path.join` keeps the assertion asserting the same thing on both hosts.
 */
function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Run a call that must refuse, and return the refusal code plus the message the operator would read. */
function refusalOf(run, label) {
  try {
    run();
  } catch (error) {
    assert.ok(error.code, `${label}: a refusal must carry a code, not only a sentence`);
    assert.equal(error.refusal, error.code, `${label}: error.refusal and error.code are the same refusal`);
    assert.ok(error.message.length > 40, `${label}: a refusal names what failed and what to do about it`);
    return { code: error.code, message: error.message };
  }
  assert.fail(`${label}: expected a refusal, and something was produced`);
}

function githubEntryOf(preset) {
  return preset.thirdParty.find((entry) => String(entry.id).startsWith("github"));
}

test("every shipped GitHub surface names exactly the tools it counts (HR-11, T15-11)", () => {
  const shipped = PRESETS.filter((preset) => (preset.thirdParty || []).some((entry) => String(entry.id).startsWith("github")));
  assert.ok(shipped.length >= 2, "the max presets are the point of HR-11, so at least two presets must carry a GitHub surface");
  for (const preset of shipped) {
    const selection = selectionForPreset(preset);
    const entry = githubEntryOf(preset);
    assert.ok(selection, `${preset.id}: a preset with a GitHub surface must yield a selection`);
    assert.equal(selection.toolCount, selection.tools.length, `${preset.id}: the count is derived from the named list`);
    assert.equal(selection.toolCount, entry.toolsEstimate, `${preset.id}: toolsEstimate agrees with the list it names`);
    assert.equal(new Set(selection.tools).size, selection.tools.length, `${preset.id}: no tool is named twice`);
    assert.ok(selection.toolsets.length, `${preset.id}: the selection states the toolsets it asks the server for`);
    assert.equal(selection.remoteUrl.startsWith("https://api.githubcopilot.com/"), true, `${preset.id}: only the reviewed host`);
  }
});

test("the full and limited GitHub surfaces differ in the way the plan says (DD15-06)", () => {
  const full = selectionForPreset(presetById("research-max-github-full"));
  const limited = selectionForPreset(presetById("research-max-github-limited"));
  assert.equal(full.readOnly, false, "the full surface does not ask for the server's read-only switch");
  assert.equal(limited.readOnly, true, "the limited surface does");
  assert.equal(full.toolCount, 92, "the full surface names every published tool of the reviewed catalog");
  assert.equal(limited.toolCount, 42, "the limited surface names the read-only subset it selected");
  assert.equal(limited.excluded.length, 35, "the limited surface also states the write tools it excludes");
  const writeNames = new Set(limited.excluded);
  for (const name of limited.tools) {
    assert.equal(writeNames.has(name), false, `"${name}" is selected and excluded in the same surface`);
  }
  assert.ok(limited.tools.every((name) => full.tools.includes(name)), "the limited selection is a subset of the full one");
});

test("a preset with no GitHub surface configures nothing, and says how to get the same result by hand", () => {
  const preset = presetById("research-max-no-github");
  assert.equal(preset.thirdParty.length, 0, "this preset's point is that it carries no external surface");
  assert.equal(selectionForPreset(preset), null, "no GitHub surface is a real answer, not a failure");
  const refusal = refusalOf(() => remoteEntry(preset, { writtenAt: STAMP }), "research-max-no-github");
  assert.equal(refusal.code, REFUSALS.NO_GITHUB_SELECTION);
  assert.ok(refusal.message.includes(MCP_FILE_NAME), `${MCP_FILE_NAME} is named so the operator knows where to look`);
  assert.ok(refusal.message.includes("Tools"), "the message states the hand alternative in the Tools tab");
});

test("the hosted entry is the shape the Copilot harness honours, with the selection in it (HR-12)", () => {
  const preset = presetById("research-max-github-limited");
  const selection = selectionForPreset(preset);
  const written = remoteEntry(preset, { writtenAt: STAMP });
  const entry = written.github;
  assert.deepEqual(Object.keys(written), ["github"], "one entry is produced, under the requested key");
  assert.equal(entry.type, "http");
  assert.equal(entry.url, selection.remoteUrl);
  assert.equal(entry.headers["X-MCP-Toolsets"], selection.toolsets.join(","));
  assert.equal(entry.headers["X-MCP-Readonly"], "true", "the read-only switch is stated, not assumed");
  assert.equal(entry.headers["X-MCP-Exclude-Tools"], selection.excluded.join(","));
  assert.deepEqual(entry.tools, selection.tools, "the per-server allow-list is the selection, in order");
  assert.equal(entry.tools.length, 42);
  assert.equal(entry[MARKER_KEY].toolkit, TOOLKIT_ID, "the marker is what lets a later run replace this entry");
  assert.equal(entry[MARKER_KEY].presetId, preset.id);
  assert.equal(entry[MARKER_KEY].selectionId, selection.selectionId);
  assert.equal(entry[MARKER_KEY].toolCount, 42);
  assert.equal(entry[MARKER_KEY].writtenAt, STAMP, "a caller that pins the timestamp gets it verbatim");
  assert.equal(looksLikeCredential(JSON.stringify(entry)), false, "nothing in a written entry has the shape of a token");
});

test("the local entry names the vendor's controls and keeps the token a reference, never a value", () => {
  const preset = presetById("research-max-github-full");
  const selection = selectionForPreset(preset);
  const entry = localEntry(preset, { writtenAt: STAMP }).github;
  assert.equal(entry.type, "stdio");
  assert.equal(entry.command, LOCAL_COMMAND);
  assert.deepEqual(entry.args, LOCAL_ARGS);
  assert.equal(entry.env.GITHUB_PERSONAL_ACCESS_TOKEN, TOKEN_ENV_REFERENCE);
  assert.equal(entry.env.GITHUB_TOOLSETS, selection.toolsets.join(","));
  assert.equal(entry.env.GITHUB_TOOLS, selection.tools.join(","));
  assert.equal("GITHUB_READ_ONLY" in entry.env, false, "the full surface does not set the read-only switch");
  assert.equal("GITHUB_EXCLUDE_TOOLS" in entry.env, false, "the full surface excludes nothing");
  assert.deepEqual(entry.tools, selection.tools);
  for (const [key, value] of Object.entries(entry.env)) {
    assert.equal(looksLikeCredential(String(value)), false, `${key} must hold a reference or a name list, never a credential`);
  }
});

test("HR-11 is enforced on the preset, not assumed from it", () => {
  const base = presetById("research-max-github-limited");
  const entry = (mutate) => {
    const preset = presetById("research-max-github-limited");
    mutate(githubEntryOf(preset));
    return preset;
  };

  let caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { item.toolsEstimate = 91; })), "estimate disagrees with the list");
  assert.equal(caseRefusal.code, REFUSALS.TOOL_COUNT_MISMATCH);
  assert.ok(caseRefusal.message.includes("91"), "the refusal quotes both numbers so the operator can find the line");

  caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { item.tools = [...item.tools, item.tools[0]]; })), "a tool named twice");
  assert.equal(caseRefusal.code, REFUSALS.TOOL_LIST_DUPLICATED);

  caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { item.tools = []; item.toolsEstimate = 0; })), "a surface with no names");
  assert.equal(caseRefusal.code, REFUSALS.TOOL_LIST_MISSING);

  caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { item.tools = ["ghp_" + "a".repeat(36)]; item.toolsEstimate = 1; })), "a credential in a tool list");
  assert.equal(caseRefusal.code, REFUSALS.LITERAL_CREDENTIAL);

  caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { item.tools = ["drop table"]; item.toolsEstimate = 1; })), "a name that is not a tool name");
  assert.equal(caseRefusal.code, REFUSALS.TOOL_NAME_UNSAFE);

  caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { delete item.readOnly; })), "read-only left unstated");
  assert.equal(caseRefusal.code, REFUSALS.SELECTION_INCOMPLETE);

  caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { item.toolsets = []; })), "no toolsets stated");
  assert.equal(caseRefusal.code, REFUSALS.SELECTION_INCOMPLETE);

  caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { item.server.remoteUrl = "https://evil.example.com/mcp"; })), "a host this Toolkit is not reviewed to write");
  assert.equal(caseRefusal.code, REFUSALS.REMOTE_URL_UNREVIEWED);

  caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { item.server.remoteUrl = "https://api.githubcopilot.com/mcp?token=x"; })), "a query on the reviewed host");
  assert.equal(caseRefusal.code, REFUSALS.REMOTE_URL_UNREVIEWED);

  caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { item.server.excludeTools = [base.thirdParty[0].tools[0]]; })), "a tool both selected and excluded");
  assert.equal(caseRefusal.code, REFUSALS.EXCLUDE_OVERLAPS_SELECTION);

  caseRefusal = refusalOf(() => selectionForPreset(entry((item) => { item.id = "github full"; })), "a surface id that is not a name");
  assert.equal(caseRefusal.code, REFUSALS.SELECTION_ID_INVALID);

  // The module validates the surface it is handed, not the identity of the preset: a well-shaped surface
  // from outside the registry is still written, so the registry check belongs to the command, and
  // `test/unit.test.js` is where that is proven.
  const synthetic = selectionForPreset({ id: "made-up", thirdParty: [{ id: "github", tools: ["search_repositories"], toolsEstimate: 1, readOnly: true, toolsets: ["repos"], server: { remoteUrl: "https://api.githubcopilot.com/mcp" } }] });
  assert.equal(synthetic.toolCount, 1, "a well-shaped synthetic surface yields a selection of length 1");
  assert.equal(synthetic.presetId, "made-up");

  caseRefusal = refusalOf(() => selectionForPreset(null), "not a preset");
  assert.equal(caseRefusal.code, REFUSALS.PRESET_INVALID);
});

test("a preset carrying two GitHub surfaces is refused rather than guessed at", () => {
  const preset = presetById("research-max-github-limited");
  preset.thirdParty.push(structuredClone(githubEntryOf(presetById("research-max-github-full"))));
  preset.thirdParty[1].id = "github-other";
  const refusal = refusalOf(() => selectionForPreset(preset), "two GitHub surfaces in one preset");
  assert.equal(refusal.code, REFUSALS.GITHUB_SELECTION_AMBIGUOUS);
  assert.ok(refusal.message.includes("github-other") && refusal.message.includes("github-limited"), "the refusal names both surfaces it found");
});

test("the merge writes the native format and preserves everything it did not write", () => {
  const preset = presetById("research-max-github-full");
  const existing = JSON.stringify({
    mcpServers: {
      "playwright": { type: "http", url: "https://example.invalid/mcp" },
      "zotero-local": { type: "stdio", command: "zotero-mcp" },
    },
    "instructions": "kept because this Toolkit did not write it",
  }, null, 2);
  const { content, plan } = mergeIntoMcpFile({ existingJson: existing, preset, writtenAt: STAMP });
  const parsed = JSON.parse(content);
  assert.deepEqual(parsed.instructions, "kept because this Toolkit did not write it");
  assert.deepEqual(Object.keys(parsed.mcpServers), ["playwright", "zotero-local", "github"], "existing entries keep their order and the new one is appended");
  assert.deepEqual(parsed.mcpServers.playwright, { type: "http", url: "https://example.invalid/mcp" }, "an entry this Toolkit did not write is byte-for-byte the same");
  assert.deepEqual(plan.added, ["github"]);
  assert.deepEqual(plan.replaced, []);
  assert.deepEqual(plan.preserved, ["playwright", "zotero-local"]);
  assert.deepEqual(plan.preservedTopLevel, ["instructions"]);
  assert.equal(plan.toolCount, 92);
  assert.equal(content.endsWith("\n"), true, `${MCP_FILE_NAME} ends with a newline, like every file this Toolkit writes`);
});

test("an entry this Toolkit wrote may be replaced; an entry the operator wrote is left alone and the run refuses", () => {
  const preset = presetById("research-max-github-limited");
  const writtenByToolkit = JSON.stringify({
    mcpServers: { github: remoteEntry(presetById("research-max-github-full"), { writtenAt: STAMP }).github },
  }, null, 2);
  const second = mergeIntoMcpFile({ existingJson: writtenByToolkit, preset, writtenAt: STAMP });
  assert.deepEqual(second.plan.replaced, ["github"], "the Toolkit replaces only its own entry");
  assert.deepEqual(second.plan.added, []);
  assert.equal(JSON.parse(second.content).mcpServers.github.tools.length, 42, "the entry now carries the limited selection, not the full one");

  const operatorsFile = JSON.stringify({
    mcpServers: {
      github: { type: "http", url: "https://api.githubcopilot.com/mcp", headers: { Accept: "application/json" } },
      "playwright": { type: "http", url: "https://example.invalid/mcp" },
    },
  }, null, 2);
  const refusal = refusalOf(() => mergeIntoMcpFile({ existingJson: operatorsFile, preset, writtenAt: STAMP }), "operator's github entry");
  assert.equal(refusal.code, REFUSALS.SERVER_ENTRY_NOT_WRITTEN_BY_TOOLKIT);
  assert.ok(refusal.message.includes("playwright"), "the refusal says which other entries are untouched");
  assert.equal(isToolkitWritten({ type: "http" }), false);
  assert.equal(isToolkitWritten({ [MARKER_KEY]: { toolkit: "some-other-tool", presetId: "x" } }), false, "a copied field name is not proof of authorship");
});

test("a file in the deprecated editor shape is refused, because a subset in it would be ignored (DD15-03)", () => {
  const preset = presetById("research-max-github-full");
  const refusal = refusalOf(
    () => mergeIntoMcpFile({ existingJson: JSON.stringify({ servers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp" } } }), preset, writtenAt: STAMP }),
    "the .vscode/mcp.json shape",
  );
  assert.equal(refusal.code, REFUSALS.MCP_FILE_EDITOR_FORMAT);
  assert.ok(refusal.message.includes("allow-list"), "the refusal explains why that shape cannot carry a selection");
});

test("a file that cannot be read safely, or that already holds a credential, is left exactly as it was", () => {
  const preset = presetById("research-max-github-full");
  const cases = [
    ["{ not json", REFUSALS.MCP_FILE_NOT_JSON],
    ["[1,2,3]", REFUSALS.MCP_FILE_NOT_OBJECT],
    [JSON.stringify({ mcpServers: [] }), REFUSALS.MCP_SERVERS_NOT_AN_OBJECT],
    [JSON.stringify({ mcpServers: { github: "https://api.githubcopilot.com/mcp" } }), REFUSALS.SERVER_ENTRY_NOT_A_SERVER],
    // The credential scan is reached once the entry is classifiable, so this case carries the Toolkit's
    // own marker: the refusal under test is the secret already in the file, not the authorship check
    // that fires earlier for an unmarked entry (covered in the case above).
    [JSON.stringify({ mcpServers: { github: remoteEntry(preset, { writtenAt: STAMP }).github }, token: "ghp_" + "b".repeat(36) }), REFUSALS.LITERAL_CREDENTIAL],
  ];
  for (const [existingJson, expected] of cases) {
    const refusal = refusalOf(() => mergeIntoMcpFile({ existingJson, preset, writtenAt: STAMP }), `file state ${expected}`);
    assert.equal(refusal.code, expected);
  }
});

test("there is no input that accepts a credential, and no option this module does not know", () => {
  const preset = presetById("research-max-github-full");
  const refusal = refusalOf(() => mergeIntoMcpFile({ existingJson: undefined, preset, token: "ghp_" + "c".repeat(36), writtenAt: STAMP }), "a token handed to the merge");
  assert.equal(refusal.code, REFUSALS.LITERAL_CREDENTIAL);
  assert.ok(refusal.message.includes(TOKEN_ENV_REFERENCE), "the refusal states the only form a token may take");

  const unknown = refusalOf(() => mergeIntoMcpFile({ existingJson: undefined, preset, toolkitToken: "x" }), "an option this module does not accept");
  assert.equal(unknown.code, REFUSALS.MERGE_OPTION_UNKNOWN);

  const badVariant = refusalOf(() => mergeIntoMcpFile({ existingJson: undefined, preset, variant: "hosted-http" }), "an unknown selection shape");
  assert.equal(badVariant.code, REFUSALS.MERGE_VARIANT_UNKNOWN);

  const badKey = refusalOf(() => remoteEntry(preset, { serverKey: "../github", writtenAt: STAMP }), "a server key that would write outside one entry");
  assert.equal(badKey.code, REFUSALS.UNSAFE_SERVER_KEY);
});

test("the produced file never carries a credential-shaped value, for either shape or either preset", () => {
  for (const id of ["research-max-github-full", "research-max-github-limited"]) {
    for (const variant of ["remote", "local"]) {
      const { content, plan } = mergeIntoMcpFile({ preset: presetById(id), variant, writtenAt: STAMP });
      assert.equal(looksLikeCredential(content), false, `${id} / ${variant}: the content is clean`);
      assert.ok(content.includes(TOKEN_ENV_REFERENCE) === (variant === "local"), `${variant} shape references the token only where the vendor needs it`);
      assert.equal(plan.serverKey, "github");
      assert.equal(plan.presetId, id);
      assert.equal(plan.fileName, MCP_FILE_NAME);
    }
  }
});

/**
 * The command, driven through the same editor harness the controller tests use, against a real temporary
 * workspace: the pure module says what may be written, and these cases are the only proof in this release
 * that the controller writes it only when asked, keeps a copy of what it replaced, and refuses the file it
 * did not write.
 */
function presetWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-preset-select-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    folders: [{ name: "Research", uri: { scheme: "file", fsPath: root, path: root, toString() { return root; } } }],
  };
}
const FULL_PACKAGE_LIMITED = { selectedPackage: "full", toolsPreset: "research-max-github-limited" };

test("the command writes nothing until the operator answers its modal (HR-12, T15-13)", async (t) => {
  const { root, folders } = presetWorkspace(t);
  const harness = makeHarness({ folders, initial: FULL_PACKAGE_LIMITED, confirmPrompt: false });
  assert.equal(await harness.registered.get("researchToolkit.configurePresetTools")(), undefined, "no answer, no write");
  assert.equal(fs.existsSync(path.join(root, MCP_FILE_NAME)), false, "and no file, not even an empty one");
  const asked = harness.events.messages.filter((message) => message.kind === "warning").at(-1);
  const review = asked.options.detail;
  assert.equal(asked.options.modal, true, "an offer that changes a configuration file the harness reads is a modal");
  assert.deepEqual(asked.buttons, ["Write the hosted entry (http)", "Write the local entry (stdio)"], "the operator chooses between two shapes, both shown");
  for (const [phrase, why] of [
    [/42 exact names/, "the count it selected, derived from the named list"],
    [/Server-side read-only switch: yes/, "the read-only state, in words"],
    [/Toolsets \(14\): context, repos, git/, "the toolsets it will name"],
    [/\.vscode\/mcp\.json/, "why the deprecated editor file is not the target"],
    [new RegExp(escapeForRegExp(path.join(root, MCP_FILE_NAME))), "the target file, spelled the way this host spells it"],
    [/\$\{GITHUB_PERSONAL_ACCESS_TOKEN\}/, "what the credential line will hold"],
    [/read-only switch is a filter, not a permission boundary/, "what a read-only selection does not do"],
    [/not tools counted on this machine/, "what the 42 names are not"],
    [new RegExp(escapeForRegExp(path.join(root, ".research-toolkit", "preset-tools"))), "where the bytes it replaces are copied first"],
  ]) assert.match(review, phrase, `the review must say ${why}`);
});

test("the command writes the hosted selection, names its count in the output channel, and replaces only its own entry", async (t) => {
  const { root, folders } = presetWorkspace(t);
  const file = path.join(root, MCP_FILE_NAME);
  const harness = makeHarness({ folders, initial: FULL_PACKAGE_LIMITED });
  const plan = await harness.registered.get("researchToolkit.configurePresetTools")();
  assert.equal(plan.toolCount, 42);
  assert.deepEqual(plan.added, ["github"]);
  assert.deepEqual(plan.replaced, []);
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(written), ["mcpServers"]);
  assert.equal(written.mcpServers.github.type, "http");
  assert.equal(written.mcpServers.github.headers["X-MCP-Readonly"], "true");
  assert.deepEqual(written.mcpServers.github.tools, presetById("research-max-github-limited").thirdParty[0].tools, "the file names exactly the tools the applied preset selected");
  assert.equal(written.mcpServers.github[MARKER_KEY].toolkit, TOOLKIT_ID);
  assert.equal(looksLikeCredential(fs.readFileSync(file, "utf8")), false, "the file on disk holds no credential");
  assert.match(harness.output.lines.join("\n"), /"toolCount": 42/, "the output channel reports the count it selected");
  assert.match(harness.events.messages.at(-1).text, /42 GitHub tool name\(s\)/, "and says it in plain words too");

  // The second run replaces the entry it wrote, and copies the bytes it replaced before touching them.
  const firstBytes = fs.readFileSync(file, "utf8");
  const next = makeHarness({ folders, initial: { selectedPackage: "full", toolsPreset: "research-max-github-full" } });
  const second = await next.registered.get("researchToolkit.configurePresetTools")();
  assert.deepEqual(second.replaced, ["github"], "the entry it wrote is the entry it may replace");
  assert.equal(second.toolCount, 92);
  const copies = fs.readdirSync(path.join(root, ".research-toolkit", "preset-tools"));
  assert.equal(copies.length, 1);
  assert.equal(fs.readFileSync(path.join(root, ".research-toolkit", "preset-tools", copies[0]), "utf8"), firstBytes, "the copy holds the bytes that were in the file, not a summary of them");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.github.tools.length, 92);

  // A copy is never rewritten: the folder keeps every version this workspace has replaced.
  const third = makeHarness({ folders, initial: FULL_PACKAGE_LIMITED });
  await third.registered.get("researchToolkit.configurePresetTools")();
  assert.equal(fs.readdirSync(path.join(root, ".research-toolkit", "preset-tools")).length, 2, "two replaced versions, both kept, neither edited");
});

test("the command's local button writes the vendor's environment controls with the token left a reference", async (t) => {
  const { root, folders } = presetWorkspace(t);
  const harness = makeHarness({ folders, initial: FULL_PACKAGE_LIMITED, pickButton: "Write the local entry (stdio)" });
  const plan = await harness.registered.get("researchToolkit.configurePresetTools")();
  assert.equal(plan.variant, "local");
  const entry = JSON.parse(fs.readFileSync(path.join(root, MCP_FILE_NAME), "utf8")).mcpServers.github;
  assert.equal(entry.type, "stdio");
  assert.equal(entry.command, LOCAL_COMMAND);
  assert.deepEqual(entry.args, LOCAL_ARGS);
  assert.equal(entry.env.GITHUB_PERSONAL_ACCESS_TOKEN, TOKEN_ENV_REFERENCE);
  assert.equal(entry.env.GITHUB_READ_ONLY, "true");
  assert.equal(entry.env.GITHUB_TOOLS.split(",").length, 42);
  assert.equal(entry.env.GITHUB_EXCLUDE_TOOLS.split(",").length, 35);
  assert.deepEqual(entry.tools, presetById("research-max-github-limited").thirdParty[0].tools);
});

test("the command writes nothing for a preset that selects no GitHub surface, and says what to do instead", async (t) => {
  const { root, folders } = presetWorkspace(t);
  const harness = makeHarness({ folders, initial: { selectedPackage: "full", toolsPreset: "research-max-no-github" } });
  const report = await harness.registered.get("researchToolkit.configurePresetTools")();
  assert.deepEqual(report, { presetId: "research-max-no-github", serverKey: "github", githubToolsSelected: 0, written: false, reason: "this preset selects no GitHub MCP surface" });
  assert.equal(fs.existsSync(path.join(root, MCP_FILE_NAME)), false);
  assert.equal(harness.events.messages.filter((message) => message.kind === "warning").length, 0, "nothing to confirm, so no dialog");
  assert.match(harness.events.messages.at(-1).text, /uncheck the GitHub server group/);
});

test("the command refuses to write a file that changed after the operator reviewed it", async (t) => {
  const { root, folders } = presetWorkspace(t);
  const harness = makeHarness({ folders, initial: FULL_PACKAGE_LIMITED });
  const file = path.join(root, MCP_FILE_NAME);
  // Answer the modal, and change the file in the same breath: this is the only way to make the review and
  // the write disagree without a real operator racing the command.
  const reviewed = harness.vscode.window.showWarningMessage;
  harness.vscode.window.showWarningMessage = async (...args) => {
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { github: { type: "http", url: "https://example.com/mcp" } } }, null, 2) + "\n");
    return await reviewed(...args);
  };
  const failure = await harness.registered.get("researchToolkit.configurePresetTools")().catch((error) => error);
  assert.equal(failure.code, REFUSALS.TARGET_CHANGED_MID_RUN);
  assert.match(failure.message, /changed after you reviewed it/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.github.url, "https://example.com/mcp", "the file keeps the bytes that appeared after the review, not the bytes the command prepared");
  assert.equal(fs.existsSync(path.join(root, ".research-toolkit", "preset-tools")), false, "and nothing was copied, because nothing was written");
});

test("the command refuses a github entry it did not write and leaves the operator's file byte-identical", async (t) => {
  const { root, folders } = presetWorkspace(t);
  const operatorFile = JSON.stringify({
    mcpServers: {
      github: { type: "http", url: "https://api.githubcopilot.com/mcp", headers: { "X-MCP-Toolsets": "repos" }, tools: ["*"] },
      playwright: { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] },
    },
  }, null, 2) + "\n";
  fs.writeFileSync(path.join(root, MCP_FILE_NAME), operatorFile);
  const harness = makeHarness({ folders, initial: FULL_PACKAGE_LIMITED });
  const failure = await harness.registered.get("researchToolkit.configurePresetTools")().catch((error) => error);
  assert.equal(failure.code, REFUSALS.SERVER_ENTRY_NOT_WRITTEN_BY_TOOLKIT);
  assert.equal(fs.readFileSync(path.join(root, MCP_FILE_NAME), "utf8"), operatorFile, "refused means the file is untouched");
  assert.equal(fs.existsSync(path.join(root, ".research-toolkit", "preset-tools")), false, "and nothing was staged to archive either");

  // A link in the target's place is refused too: the Toolkit does not follow it. On Windows an
  // unprivileged process cannot create a file symlink, so the case states that it could not be built
  // instead of reporting a refusal it never had the chance to test (see test/linkfixture.js).
  fs.unlinkSync(path.join(root, MCP_FILE_NAME));
  if (fileLink(t, path.join(root, "elsewhere.json"), path.join(root, MCP_FILE_NAME))) {
    const linkHarness = makeHarness({ folders, initial: FULL_PACKAGE_LIMITED });
    const linkFailure = await linkHarness.registered.get("researchToolkit.configurePresetTools")().catch((error) => error);
    assert.equal(linkFailure.code, REFUSALS.TARGET_IS_LINK);
    assert.equal(fs.lstatSync(path.join(root, MCP_FILE_NAME)).isSymbolicLink(), true, "the link is still a link");
  }
});
