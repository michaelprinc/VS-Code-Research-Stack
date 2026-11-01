"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { makeHarness } = require("./harness");
const { setupRuntime, managedRuntime, functionalCheck, discoverRuntimes, activateRuntime, rollbackRuntime, WORKER_FOLDER, WORKER_VERSION, MANAGED_FOLDER } = require("../runtime");
const { runPlan, writeReceipt, RECEIPT_NAME } = require("../installer");
const { checkInventory } = require("../diagnostics");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-setup-test-"));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("research-setup-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, folder: { name: "Research é & spaces", uri: { scheme: "file", fsPath: root } } };
}
function services(root, { fail = false, failCheck = false, block } = {}) {
  const calls = [];
  return { calls,
    async findHostTool(name) { return name === "uv" ? "/trusted/uv" : undefined; },
    async runFile(executable, args, options) {
      calls.push({ executable, args, options });
      if (args[0] === "sync") {
        assert.deepEqual(args.slice(0, 5), ["sync", "--locked", "--no-dev", "--python", "3.12"]);
        assert.ok(args.includes("--no-config"));
        const project = args[args.indexOf("--project") + 1];
        const managed = project === path.join(root, WORKER_FOLDER);
        const notebook = project === path.join(root, "notebooks", "analysis");
        assert.ok(managed || notebook, `only reviewed projects are synced, got ${project}`);
        if (block) await block;
        if (fail) throw new Error("Synthetic interrupted install");
        const python = path.join(project, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
        await fs.mkdir(path.dirname(python), { recursive: true }); await fs.writeFile(python, "fixture interpreter");
        return "";
      }
      if (args[0] === "--version") return "uv 9.9-observed";
      if (args.slice(0, 3).join(" ") === "-I -B -c") {
        assert.match(args[3], /import ipykernel, matplotlib/, "the notebook step verifies the imports its notebooks use");
        return "3.12.99 (fixture, main)";
      }
      if (args[2].endsWith("probe.py")) return JSON.stringify({ python: "3.12.99", packages: Object.fromEntries(["mcp-python-sdk", "mcp-types", "pypdf", "python-docx", "document-worker"].map((id) => [id, { version: id === "document-worker" ? require("../runtime").WORKER_VERSION : "9.9-observed", ok: true, detail: "Fixture check passed" }])), recommended: true, full: true, lab: true });
      assert.ok(args[2].endsWith("functional_check.py"));
      if (failCheck) throw new Error("Synthetic functional check failure");
      const surface = (module, names) => {
        const tools = names.map((name) => ({ name, title: name, characters: 400, tokensEstimate: 140 }));
        return { module, toolCount: tools.length, characters: 400 * tools.length, tokensEstimate: 140 * tools.length, tools };
      };
      const servers = [surface("research_stack.mcp_server", ["read_document", "read_text_source", "search_local_text", "write_markdown", "write_docx"]),
        surface("research_stack.recommended_server", ["search_literature", "search", "check_citation", "zotero_collections", "zotero_item", "prepare_zotero_import"]),
        surface("research_stack.lab_server", ["index_corpus", "unindex_corpus", "search_corpus", "evidence_read", "claims_read", "claims_write", "claims_export", "store_status", "store_maintenance"])];
      return JSON.stringify({ ok: true, pdfRead: true, docxRead: true, lexicalSearch: true, researchAdapter: true, corpusIndex: true, recordStore: true, externalProvidersChecked: false,
        toolSurface: { basis: "measured from real tools/list responses", servers, toolCount: 20, characters: 8000, tokensEstimate: 2800 },
        ...(args.includes("--document") ? { document: args.at(-1), preview: "Selected fixture text", detail: "Source unchanged." } : {}) });
    },
  };
}

test("setup isolates locked packages, preserves project files, config and data; repeat setup reuses reviewed source", async (t) => {
  const { root, folder } = await fixture(t);
  await fs.mkdir(path.join(root, ".venv")); await fs.writeFile(path.join(root, ".venv", "keep.txt"), "project environment");
  await fs.mkdir(path.join(root, ".vscode")); await fs.writeFile(path.join(root, ".vscode", "mcp.json"), '// JSONC config\n{"servers":{"existing":{"command":"never-run"}}}');
  await fs.writeFile(path.join(root, "paper.docx"), "original document");
  const harness = makeHarness({ folders: [folder] });
  const backend = services(root);
  const plan = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "basic", services: backend });
  const first = plan.receipt.steps.worker;
  assert.equal(first.check.ok, true); assert.equal(first.toolkitVersion, WORKER_VERSION);
  assert.deepEqual(plan.ran, ["worker"]); assert.deepEqual(plan.skipped, []);
  assert.equal((await managedRuntime(harness.context, folder)).python, first.python);
  const repeat = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "basic", services: backend });
  assert.deepEqual(repeat.ran, [], "a current step is not run again");
  assert.deepEqual(repeat.skipped, ["worker"]);
  assert.equal(await fs.readFile(path.join(root, ".venv", "keep.txt"), "utf8"), "project environment");
  assert.match(await fs.readFile(path.join(root, ".vscode", "mcp.json"), "utf8"), /never-run/);
  assert.equal(await fs.readFile(path.join(root, "paper.docx"), "utf8"), "original document");
  assert.ok(backend.calls.every(({ executable }) => executable !== "never-run"));
  await assert.rejects(fs.stat(path.join(root, ".research-toolkit/managed/.setup.lock")), { code: "ENOENT" });
  const inventory = await checkInventory(harness.vscode, harness.context, folder, backend);
  for (const id of ["document-worker", "research-stack-recommended-adapter", "research-stack-full-markdown-bm25-prototype"]) assert.equal(inventory.components.find((item) => item.id === id).readiness, "Ready");
  assert.equal(inventory.components.find((item) => item.id === "mcp-config").installed, "Provided by extension");
  assert.equal(inventory.components.find((item) => item.id === "crossref-rest-api").readiness, "Not verified");
});

test("unrelated .venv no longer reports missing research packages as a broken toolkit install", async (t) => {
  const { root, folder } = await fixture(t);
  const python = path.join(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await fs.mkdir(path.dirname(python), { recursive: true }); await fs.writeFile(python, "project interpreter");
  const harness = makeHarness({ folders: [folder] });
  let invoked = false;
  const inventory = await checkInventory(harness.vscode, harness.context, folder, { async findHostTool() { return undefined; }, async runFile() { invoked = true; } });
  assert.equal(invoked, false); assert.equal(inventory.components.find((item) => item.id === "python").readiness, "Needs setup");
});

test("failed install is resumable and changed managed source is preserved without execution", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  await assert.rejects(setupRuntime(harness.vscode, harness.context, folder, services(root, { fail: true })), /interrupted/);
  assert.equal(await managedRuntime(harness.context, folder), undefined);
  await setupRuntime(harness.vscode, harness.context, folder, services(root));
  const source = path.join(root, WORKER_FOLDER, "src/research_stack/mcp_server.py");
  await fs.writeFile(source, "user edited source");
  const backend = services(root);
  await assert.rejects(setupRuntime(harness.vscode, harness.context, folder, backend), /differ/);
  assert.equal(backend.calls.length, 0);
  assert.equal(await fs.readFile(source, "utf8"), "user edited source");
  await assert.rejects(managedRuntime(harness.context, folder), /changed/);
});

test("a workspace setup lock blocks competing windows and releases on completion", async (t) => {
  const { root, folder } = await fixture(t);
  let release, signal;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { signal = resolve; });
  const backend = services(root, { block: gate });
  const run = backend.runFile;
  backend.runFile = async (...args) => { if (args[1][0] === "sync") signal(); return run(...args); };
  const harness = makeHarness({ folders: [folder] });
  const first = setupRuntime(harness.vscode, harness.context, folder, backend);
  await started;
  await assert.rejects(setupRuntime(harness.vscode, harness.context, folder, backend), /Another setup/);
  release(); await first;
});

test("restricted/remote setup and cancelled preview perform no writes or execution", async (t) => {
  const { root, folder } = await fixture(t);
  const backend = services(root);
  const restricted = makeHarness({ trusted: false, folders: [folder], diagnosticServices: backend });
  await assert.rejects(restricted.registered.get("researchToolkit.setupLocalComponents")(), /Trust/);
  const remote = makeHarness({ folders: [folder], diagnosticServices: backend }); remote.vscode.env.remoteName = "ssh-remote";
  await assert.rejects(remote.registered.get("researchToolkit.setupLocalComponents")(), /local desktop/);
  const cancel = makeHarness({ folders: [folder], diagnosticServices: backend, confirmSetup: false });
  assert.equal(await cancel.registered.get("researchToolkit.setupLocalComponents")(), undefined);
  assert.equal(backend.calls.length, 0); await assert.rejects(fs.stat(path.join(root, ".research-toolkit")), { code: "ENOENT" });
});

test("provider and selected-document reading use only the verified managed worker and in-workspace files", async (t) => {
  const { root, folder } = await fixture(t);
  const backend = services(root);
  const harness = makeHarness({ folders: [folder], diagnosticServices: backend, documentPath: path.join(root, "paper.docx") });
  assert.deepEqual(await harness.api.mcpProvider.provideMcpServerDefinitions(), []);
  await harness.registered.get("researchToolkit.setupLocalComponents")();
  const definitions = await harness.api.mcpProvider.provideMcpServerDefinitions();
  assert.equal(definitions.length, 2); assert.equal(definitions[0].env.RESEARCH_STACK_WORKSPACE, root);
  assert.deepEqual(definitions[0].args, ["-I", "-B", "-m", "research_stack.mcp_server"]);
  assert.match(definitions[0].version, new RegExp(`^${WORKER_VERSION}\\+research-core:[0-9a-f]{12}$`), "the definition version carries the runtime and the goal's tool surface");
  assert.equal(definitions[0].version, definitions[1].version, "servers of one goal share the surface signature");
  assert.equal(definitions[0].env.RESEARCH_STACK_TOOL_PRESET, "research-core");
  assert.equal(definitions[1].env.RESEARCH_STACK_TOOL_PRESET, "research-core");
  const measured = harness.api.state();
  assert.equal(measured.toolSurface.toolCount, 20);
  assert.equal(measured.presets.find((item) => item.id === "research-core").estimate.measured, true);
  assert.equal(measured.presets.find((item) => item.id === "research-core").estimate.tokensEstimate, 1400);
  assert.equal(measured.presets.find((item) => item.id === "research-core").estimate.basis, "measured");
  assert.equal(measured.appliedToolsPreset, "research-core", "the panel can show which preset the assistant actually has");
  assert.equal(measured.presetApplied, true);
  assert.equal(measured.presets.find((item) => item.id === "read-and-cite").estimate.tokensEstimate, 560);
  harness.values.set("toolsPreset", "read-and-cite");
  const documents = await harness.api.mcpProvider.provideMcpServerDefinitions();
  assert.equal(documents.length, 1, "a goal that needs no research server does not start one");
  assert.deepEqual(documents[0].args, ["-I", "-B", "-m", "research_stack.mcp_server"]);
  assert.equal(documents[0].env.RESEARCH_STACK_TOOL_PRESET, "read-and-cite");
  assert.match(documents[0].version, new RegExp(`^${WORKER_VERSION}\\+read-and-cite:[0-9a-f]{12}$`), "changing the goal changes the version a client compares, so its tool list refreshes");
  assert.notEqual(documents[0].version, definitions[0].version);
  assert.equal(harness.api.state().appliedToolsPreset, "read-and-cite");
  harness.values.set("toolsPreset", "verify-citations");
  const metadata = await harness.api.mcpProvider.provideMcpServerDefinitions();
  assert.equal(metadata.length, 1);
  assert.deepEqual(metadata[0].args, ["-I", "-B", "-m", "research_stack.recommended_server"]);
  await fs.writeFile(path.join(root, "paper.docx"), "fixture source");
  const read = await harness.registered.get("researchToolkit.readSelectedDocument")();
  assert.equal(read.document, "paper.docx"); assert.equal(harness.api.state().readingResult.preview, "Selected fixture text");
  const runtime = await managedRuntime(harness.context, folder);
  await assert.rejects(functionalCheck(harness.context, runtime, folder, path.join(root, WORKER_FOLDER, "pyproject.toml"), backend), /Choose a PDF/);
  await assert.rejects(functionalCheck(harness.context, runtime, folder, __filename, backend), /inside the selected workspace/);
  harness.vscode.workspace.isTrusted = false;
  assert.deepEqual(await harness.api.mcpProvider.provideMcpServerDefinitions(), []);
});

test("linked managed directories cannot redirect installation outside the workspace", async (t) => {
  const selected = await fixture(t), outside = await fixture(t);
  const toolkit = path.join(selected.root, ".research-toolkit");
  await fs.mkdir(toolkit);
  const link = path.join(toolkit, "managed");
  await fs.symlink(outside.root, link, process.platform === "win32" ? "junction" : "dir");
  try {
    const harness = makeHarness({ folders: [selected.folder] });
    const backend = services(selected.root);
    await assert.rejects(setupRuntime(harness.vscode, harness.context, selected.folder, backend), /real directories/);
    assert.equal(backend.calls.length, 0);
    assert.deepEqual(await fs.readdir(outside.root), []);
  } finally { await fs.unlink(link); }
});

test("a runtime an earlier release installed is discovered, re-verified and can be rolled back to (T5-17)", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const backend = services(root);
  const plan = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "basic", services: backend });
  assert.equal(plan.receipt.steps.worker.toolkitVersion, WORKER_VERSION);

  const prior = path.join(root, MANAGED_FOLDER, "worker-0.3.4");
  const priorPython = path.join(prior, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await fs.mkdir(path.dirname(priorPython), { recursive: true });
  await fs.writeFile(priorPython, "prior interpreter");
  await writeReceipt(prior, {
    extensionVersion: "0.3.4", workerVersion: "0.3.4", updatedAt: "2026-10-30T00:00:00.000Z",
    steps: { worker: { toolkitVersion: "0.3.4", at: "2026-10-30T00:00:00.000Z", evidence: "Recorded by an earlier toolkit release." } },
  });

  const discovered = await discoverRuntimes(root);
  assert.deepEqual(discovered.runtimes.map((item) => item.version), ["0.3.4", WORKER_VERSION], "both runtimes are reported, the older one is not orphaned");
  assert.equal(discovered.active.version, WORKER_VERSION, "the active pointer names exactly one runtime");
  assert.equal(discovered.runtimes.find((item) => item.version === "0.3.4").verified, false, "an unverified older runtime is labelled as unverified");

  const rolled = await rollbackRuntime(harness.vscode, harness.context, folder, "0.3.4", backend);
  assert.equal(rolled.previousVersion, WORKER_VERSION);
  assert.equal(rolled.check.ok, true, "the candidate is re-verified before it is activated");
  assert.ok(backend.calls.some(({ args }) => String(args[2] || "").endsWith("functional_check.py")), "rollback runs the real reading check with the candidate interpreter");
  const after = await discoverRuntimes(root);
  assert.equal(after.active.version, "0.3.4");
  assert.equal(after.active.previousVersion, WORKER_VERSION);
  assert.equal(after.runtimes.find((item) => item.version === WORKER_VERSION).thisRelease, true, "this release's runtime stays on disk");

  const broken = path.join(root, MANAGED_FOLDER, "worker-0.0.1");
  await fs.mkdir(broken, { recursive: true });
  await fs.writeFile(path.join(broken, RECEIPT_NAME), "{ not json", "utf8");
  const withBroken = await discoverRuntimes(root);
  assert.equal(withBroken.runtimes.length, 3, "an unreadable receipt does not hide the other runtimes");
  assert.equal(withBroken.runtimes.find((item) => item.version === "0.0.1").verified, false, "an unreadable receipt is not treated as verification");

  await assert.rejects(rollbackRuntime(harness.vscode, harness.context, folder, "9.9.9", backend), /No managed runtime/);
  await assert.rejects(rollbackRuntime(harness.vscode, harness.context, folder, "0.3.4", backend), /already the active one/);
});

test("a rollback candidate that fails the reading check never becomes active (T5-17)", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const backend = services(root);
  await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "basic", services: backend });

  const prior = path.join(root, MANAGED_FOLDER, "worker-0.3.4");
  const priorPython = path.join(prior, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await fs.mkdir(path.dirname(priorPython), { recursive: true });
  await fs.writeFile(priorPython, "prior interpreter");
  await writeReceipt(prior, { extensionVersion: "0.3.4", workerVersion: "0.3.4", updatedAt: "2026-10-30T00:00:00.000Z",
    steps: { worker: { toolkitVersion: "0.3.4", at: "2026-10-30T00:00:00.000Z" } } });

  await assert.rejects(
    rollbackRuntime(harness.vscode, harness.context, folder, "0.3.4", services(root, { failCheck: true })),
    /Synthetic functional check failure/);
  const after = await discoverRuntimes(root);
  assert.equal(after.active.version, WORKER_VERSION, "a failed candidate does not move the active pointer");
  assert.equal(after.runtimes.find((item) => item.version === "0.3.4").active, false);
});
