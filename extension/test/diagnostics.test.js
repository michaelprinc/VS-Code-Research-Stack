"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { baseInventory, checkInventory, inventoryText } = require("../diagnostics");
const workerBundle = require("../worker/bundle.json");
const { makeHarness } = require("./harness");
// The Python argv shape comes from the shipped runner, not from a fixture's memory of it (0.3.8).
const { PYTHON_FLAGS, runsPythonFile } = require("./python-argv");

const find = (snapshot, id) => snapshot.components.find((item) => item.id === id);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-inventory-test-"));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("research-inventory-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const folder = { name: "Research & <test>", uri: { scheme: "file", fsPath: root } };
  fs.writeFileSync(path.join(root, "pyproject.toml"), '[project]\nname = "research-stack-basic"\n');
  return { root, folder, write(name, content = "fixture") { const destination = path.join(root, name); fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, content); } };
}

test("editor-only inventory proves controller version without deriving installation from desired profile", () => {
  const harness = makeHarness({ initial: { selectedPackage: "full" } });
  const snapshot = baseInventory(harness.vscode, harness.context);
  assert.equal(find(snapshot, "toolkit").version, require("../package.json").version, "the controller reports the version it is actually running");
  assert.equal(find(snapshot, "toolkit").readiness, "Ready");
  assert.equal(find(snapshot, "python").installed, "Not checked");
  assert.equal(find(snapshot, "qdrant-local-service").installed, "Not bundled");
  assert.equal(find(snapshot, "qdrant-local-service").readiness, "Planned");
  assert.equal(find(snapshot, "openalex-rest-api").installed, "External service");
  assert.equal(snapshot.checkedAt, null);
});

test("observed versions and smoke results stay separate from worker/MCP/service readiness", async (t) => {
  const files = fixture(t);
  files.write(process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  files.write(".mcp.json", JSON.stringify({ mcpServers: { "research-stack-basic": { command: "must-never-run", env: { SECRET: "must-not-appear" } } } }));
  const calls = [];
  const services = {
    async findHostTool(name) { return `/host/${name}`; },
    async runFile(executable, args) {
      calls.push({ executable, args });
      if (args[0] === "--version") return `${path.basename(executable)} 9.8.7-observed`;
      assert.deepEqual(args.slice(0, PYTHON_FLAGS.length), PYTHON_FLAGS, `the probe child carries the reviewed flags ${PYTHON_FLAGS.join(" ")}`);
      assert.ok(runsPythonFile(args, "probe.py"), `and the probe script is the argument after them, got ${args.join(" ")}`);
      return JSON.stringify({ python: "3.12.99", packages: {
        "mcp-python-sdk": { version: "2.2.0", ok: true, detail: "Import passed" },
        pypdf: { version: "6.4.1", ok: true, detail: "Memory test passed" },
        "python-docx": { version: "1.2.0", ok: false, detail: "Smoke test failed" },
        "document-worker": { version: "0.1.0", ok: true },
      }, recommended: true, full: true });
    },
  };
  const harness = makeHarness({ folders: [files.folder], diagnosticServices: services });
  const result = await harness.registered.get("researchToolkit.checkComponents")();
  assert.match(find(result, "uv").version, /9.8.7-observed/);
  assert.equal(find(result, "python").version, "3.12.99");
  assert.equal(find(result, "pypdf").readiness, "Ready");
  assert.equal(find(result, "python-docx").readiness, "Check failed");
  assert.equal(find(result, "document-worker").version, "0.1.0");
  assert.equal(find(result, "document-worker").readiness, "Not verified");
  assert.equal(find(result, "mcp-config").installed, "Configuration present");
  assert.equal(find(result, "mcp-config").readiness, "Not verified");
  assert.equal(find(result, "openalex-rest-api").readiness, "Not verified");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.executable !== "must-never-run"));
  assert.doesNotMatch(JSON.stringify(result), /must-not-appear/);
});

test("restricted and remote checks execute no tools or workspace probes", async () => {
  let calls = 0;
  const services = { async findHostTool() { calls++; }, async runFile() { calls++; } };
  const restricted = makeHarness({ trusted: false });
  let result = await checkInventory(restricted.vscode, restricted.context, restricted.vscode.workspace.workspaceFolders[0], services);
  assert.match(result.scope, /Restricted/);
  const remote = makeHarness(); remote.vscode.env.remoteName = "ssh-remote";
  result = await checkInventory(remote.vscode, remote.context, undefined, services);
  assert.match(result.scope, /Remote/);
  assert.equal(calls, 0);
});

test("prepared source, malformed config, missing environment and runtime failures remain actionable", async (t) => {
  const files = fixture(t);
  files.write(".research-toolkit/worker/src/research_stack/mcp_server.py");
  files.write(".mcp.json", "{broken");
  const harness = makeHarness({ folders: [files.folder] });
  let result = await checkInventory(harness.vscode, harness.context, files.folder, { async findHostTool() { return undefined; } });
  assert.equal(find(result, "document-worker").installed, "Files prepared");
  assert.equal(find(result, "python").installed, "Not detected");
  assert.equal(find(result, "mcp-config").readiness, "Needs attention");
  result = await checkInventory(harness.vscode, harness.context, files.folder, { async findHostTool(name) { return name; }, async runFile() { throw new Error("Timed out"); } });
  assert.equal(find(result, "uv").readiness, "Check failed");
  assert.equal(find(result, "uv").installed, "Detected");
});

test("malformed Python output is reported without exposing its contents", async (t) => {
  const files = fixture(t);
  files.write(process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
  const harness = makeHarness({ folders: [files.folder] });
  for (const output of ["private-token-not-json", JSON.stringify({ python: "3.12", packages: {} })]) {
    const result = await checkInventory(harness.vscode, harness.context, files.folder, {
      async findHostTool() { return undefined; }, async runFile() { return output; },
    });
    assert.equal(find(result, "python").readiness, "Check failed");
    assert.match(find(result, "python").evidence, /invalid diagnostic data/);
    assert.doesNotMatch(JSON.stringify(result), /private-token/);
  }
});

test("changing selected folder discards a scan for the previous workspace", async (t) => {
  const a = fixture(t), b = fixture(t); b.folder.name = "Other workspace";
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const harness = makeHarness({ folders: [a.folder, b.folder], diagnosticServices: { async findHostTool() { await blocked; return undefined; } } });
  const panel = harness.api.openControlPanel();
  const check = harness.registered.get("researchToolkit.checkComponents")();
  await panel.receive({ type: "selectWorkspace", index: 1 });
  release(); await check;
  assert.equal(harness.api.state().diagnosticsWorkspace, 1);
  assert.equal(harness.api.state().inventory.checkedAt, null);
  await panel.receive({ type: "selectWorkspace", index: 99 });
  assert.ok(panel.messages.at(-1).error);
});

test("the BM25 line claims only what the reading check proved, and names the condition the vector modes need", async (t) => {
  // 0.3.14 shipped retrieval in the store, and this line kept saying "Vector search remains planned".
  // It is now derived from the check it is standing on: the vector half is claimed only when the check
  // reports `vectorRetrieval`, which `extension/functional_check.py` sets after it has run `embed_corpus`
  // on the fixture store, read the index back as `ready`, and answered `vector` and `hybrid` over the same
  // MCP session. A receipt from an older worker does not carry that flag and is not credited with it.
  // Mutation proof for the wording: with the old sentence back, the first assertion below fails (the BM25
  // half now ends "in the default lexical mode"), the `4 vector(s)` assertion fails, the `not-built` /
  // `VECTORS_MISSING` condition assertion fails, and the last assertion fails because the old line names
  // the word "planned".
  const files = fixture(t);
  const worker = path.join(files.root, ".research-toolkit", "managed", `worker-${workerBundle.workerVersion}`);
  for (const relative of Object.keys(workerBundle.files)) {
    const target = path.join(worker, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(__dirname, "..", "worker", relative), target);
  }
  fs.writeFileSync(path.join(worker, "installation.json"), JSON.stringify({ workerVersion: workerBundle.workerVersion, checks: { toolSurface: true } }) + "\n");
  const bin = path.join(worker, process.platform === "win32" ? ".venv/Scripts" : ".venv/bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, process.platform === "win32" ? "python.exe" : "python"), "#!/bin/sh\nexit 0\n");
  const harness = makeHarness({ folders: [files.folder] });
  const services = {
    async findHostTool() { return undefined; },
    async runFile() { return JSON.stringify({ python: "3.12.99", packages: {
      "mcp-python-sdk": { version: "2.2.0", ok: true, detail: "Import passed" },
      pypdf: { version: "6.4.1", ok: true, detail: "Memory test passed" },
      "python-docx": { version: "1.2.0", ok: true, detail: "Memory test passed" },
      "document-worker": { version: "0.1.0", ok: true },
    }, recommended: true, full: true, lab: true }); },
  };

  const proved = { ok: true, corpusIndex: true, recordStore: true, vectorRetrieval: true, lab: { chunksIndexed: 3, vectorsBuilt: 4 } };
  const result = await checkInventory(harness.vscode, harness.context, files.folder, { ...services, functionalResult: proved });
  assert.equal(result.managed && result.managed.version, workerBundle.workerVersion, "this really is the managed-worker path the reading check runs on");
  const evidence = find(result, "research-stack-full-markdown-bm25-prototype").evidence;
  assert.equal(find(result, "research-stack-full-markdown-bm25-prototype").readiness, "Ready");
  assert.match(evidence, /^Selected Markdown fixture returned provenance-bearing BM25 results through MCP in the default lexical mode\./,
    "the lexical half is claimed as what the check did, in the mode the store answers in by default");
  assert.match(evidence, /built that store's vectors with embed_corpus \(4 vector\(s\), index reported ready\)/,
    "the vector half is claimed only with the numbers this check reported");
  assert.match(evidence, /and answered vector and hybrid through the same MCP session/, "and with the two modes it actually called");
  assert.match(evidence, /index_corpus writes them for the chunks it indexes and embed_corpus builds or rebuilds them/,
    "the condition for the vector modes is stated, not left to the guide");
  assert.match(evidence, /a store that has none reports the index as not-built and refuses both modes with VECTORS_MISSING until embed_corpus has run/,
    "including the state a migrated or untouched workspace store is really in");
  assert.match(evidence, /lexical is the default mode and needs none/, "and which mode an operator can always use");
  assert.match(evidence, /rsk-hashing-v1, a lexical signature computed on CPU from the chunk text — not a semantic model/,
    "and what the backend is, in the words the code uses for it");
  assert.doesNotMatch(evidence, /planned|no vector store|remains planned/i, "nothing on this line still describes retrieval as unshipped");
  assert.ok(inventoryText(result).includes("VECTORS_MISSING"), "the operator sees the condition in the panel text, not only in the object");

  const older = { ok: true, corpusIndex: true, recordStore: true, lab: { chunksIndexed: 3 } };
  const second = await checkInventory(harness.vscode, harness.context, files.folder, { ...services, functionalResult: older });
  const secondEvidence = find(second, "research-stack-full-markdown-bm25-prototype").evidence;
  assert.match(secondEvidence, /did not run the vector or hybrid modes, so it proves nothing about them/,
    "a receipt that never exercised the modes is reported as such");
  assert.doesNotMatch(secondEvidence, /index reported ready/, "and is not credited with vectors it never built");
  assert.match(secondEvidence, /not-built and refuses both modes with VECTORS_MISSING/, "while the condition is still stated");
});

test("component guide/docs actions accept only registry IDs and fixed upstream URLs", async () => {
  const harness = makeHarness();
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "guide", id: "pypdf" });
  assert.ok(harness.invoked.some((entry) => entry.id === "markdown.showPreview" && entry.args[0].fsPath === "extension/guides/pypdf.md"));
  await panel.receive({ type: "docs", id: "pypdf" });
  assert.equal(harness.events.external, "https://pypdf.readthedocs.io/en/stable/user/extract-text.html");
  for (const id of ["../../credentials", "https://evil.test", "institutional-provider-adapters"]) {
    await panel.receive({ type: "docs", id });
    assert.ok(panel.messages.at(-1).error);
  }
});
