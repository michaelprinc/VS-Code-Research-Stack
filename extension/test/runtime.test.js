"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { makeHarness } = require("./harness");
const { setupRuntime, managedRuntime, functionalCheck, discoverRuntimes, activateRuntime, rollbackRuntime, WORKER_FOLDER, WORKER_VERSION, MANAGED_FOLDER } = require("../runtime");
const { runPlan, writeReceipt, RECEIPT_NAME, commandLine, rerunInstruction } = require("../installer");
const { runProcess } = require("../runner");
// The Python argv shape comes from the shipped runner, not from a fixture's memory of it (0.3.8).
const { pythonArgv, hasPythonFlags, afterPythonFlags, isPythonCall, runsPythonFile } = require("./python-argv");
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
      assert.ok(hasPythonFlags(args), `every Python child carries the reviewed flags, got ${args.join(" ")}`);
      if (isPythonCall(args, "-c")) {
        assert.match(afterPythonFlags(args)[1], /import ipykernel, matplotlib/, "the notebook step verifies the imports its notebooks use");
        return "3.12.99 (fixture, main)";
      }
      if (runsPythonFile(args, "probe.py")) return JSON.stringify({ python: "3.12.99", packages: Object.fromEntries(["mcp-python-sdk", "mcp-types", "pypdf", "python-docx", "document-worker"].map((id) => [id, { version: id === "document-worker" ? require("../runtime").WORKER_VERSION : "9.9-observed", ok: true, detail: "Fixture check passed" }])), recommended: true, full: true, lab: true });
      assert.ok(runsPythonFile(args, "functional_check.py"));
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
  assert.deepEqual(definitions[0].args, pythonArgv("-m", "research_stack.mcp_server"), "the MCP server child starts behind the reviewed isolation and UTF-8 flags");
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
  assert.deepEqual(documents[0].args, pythonArgv("-m", "research_stack.mcp_server"), "the MCP server child starts behind the reviewed isolation and UTF-8 flags");
  assert.equal(documents[0].env.RESEARCH_STACK_TOOL_PRESET, "read-and-cite");
  assert.match(documents[0].version, new RegExp(`^${WORKER_VERSION}\\+read-and-cite:[0-9a-f]{12}$`), "changing the goal changes the version a client compares, so its tool list refreshes");
  assert.notEqual(documents[0].version, definitions[0].version);
  assert.equal(harness.api.state().appliedToolsPreset, "read-and-cite");
  harness.values.set("toolsPreset", "verify-citations");
  const metadata = await harness.api.mcpProvider.provideMcpServerDefinitions();
  assert.equal(metadata.length, 1);
  assert.deepEqual(metadata[0].args, pythonArgv("-m", "research_stack.recommended_server"), "the MCP server child starts behind the reviewed isolation and UTF-8 flags");
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
  assert.ok(backend.calls.some(({ args }) => runsPythonFile(args, "functional_check.py")), "rollback runs the real reading check with the candidate interpreter");
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

/** A worker bundle whose project file cannot be parsed at all: the reader must report, not crash. */
async function unreadableBundleContext(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-unreadable-bundle-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.cp(path.join(__dirname, "..", "worker"), path.join(dir, "worker"), { recursive: true });
  const worker = path.join(dir, "worker");
  await fs.writeFile(path.join(worker, "pyproject.toml"), "[project\nname = \"research-stack-basic\"\nversion = \"", "utf8");
  const { createHash } = require("node:crypto");
  const manifest = JSON.parse(await fs.readFile(path.join(worker, "bundle.json"), "utf8"));
  for (const group of ["files", "overlayFiles"]) {
    for (const relative of Object.keys(manifest[group])) {
      const target = group === "overlayFiles" ? path.join(worker, "overlay", relative) : path.join(worker, relative);
      manifest[group][relative] = createHash("sha256").update(await fs.readFile(target)).digest("hex");
    }
  }
  await fs.writeFile(path.join(worker, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { extensionUri: { fsPath: dir } };
}

/** A worker bundle built from a stale tree: hashes match, the pair does not (the 0.3.6 packaging mistake). */
async function staleBundleContext(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-stale-bundle-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.cp(path.join(__dirname, "..", "worker"), path.join(dir, "worker"), { recursive: true });
  const worker = path.join(dir, "worker");
  const pyproject = await fs.readFile(path.join(worker, "pyproject.toml"), "utf8");
  await fs.writeFile(path.join(worker, "pyproject.toml"), pyproject.replace(`version = "${WORKER_VERSION}"`, 'version = "0.4.0"'));
  const { createHash } = require("node:crypto");
  const manifest = JSON.parse(await fs.readFile(path.join(worker, "bundle.json"), "utf8"));
  for (const group of ["files", "overlayFiles"]) {
    for (const relative of Object.keys(manifest[group])) {
      const target = group === "overlayFiles" ? path.join(worker, "overlay", relative) : path.join(worker, relative);
      manifest[group][relative] = createHash("sha256").update(await fs.readFile(target)).digest("hex");
    }
  }
  await fs.writeFile(path.join(worker, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { extensionUri: { fsPath: dir } };
}

test("setup refuses a bundled worker pair that uv would refuse, before any process or write (R7-07, T7-10)", async (t) => {
  const { root, folder } = await fixture(t);
  const backend = services(root);
  const harness = makeHarness({ folders: [folder] });
  const context = await staleBundleContext(t);
  const error = await setupRuntime(harness.vscode, context, folder, backend).catch((item) => item);
  assert.match(error.message, /does not match its own project file/);
  assert.match(error.message, new RegExp(`root package version ${WORKER_VERSION} does not match pyproject version 0\\.4\\.0`));
  assert.equal(error.lockDrift.source, "bundled");
  assert.equal(error.kind, "lock-drift", "the refusal is classified, so the status record does not fall through to a generic retry hint");
  assert.match(error.hint, /Reinstall the VSIX/, error.hint);
  assert.equal(error.attempts, 0, "no attempt was made, and the record says so");
  assert.deepEqual(backend.calls, [], "no host tool was run");
  await assert.rejects(fs.stat(path.join(root, ".research-toolkit")), /ENOENT/, "nothing was written into the workspace");
});

test("a bundled pair the dependency reader cannot parse is refused as a build defect, not as a crash (R7-07)", async (t) => {
  const { root, folder } = await fixture(t);
  const backend = services(root);
  const harness = makeHarness({ folders: [folder] });
  const context = await unreadableBundleContext(t);
  const error = await setupRuntime(harness.vscode, context, folder, backend).catch((item) => item);
  assert.ok(error instanceof Error, "setup rejected");
  assert.match(error.message, /does not match its own project file/, "the operator reads the packaging-defect sentence, not a stack trace");
  assert.equal(error.lockDrift.source, "bundled");
  assert.ok(error.lockDrift.problems.length >= 1, "the reader's own failure is recorded as the problem");
  assert.deepEqual(backend.calls, [], "no host tool was run");
  await assert.rejects(fs.stat(path.join(root, ".research-toolkit")), /ENOENT/, "nothing was written into the workspace");
});

test("a host that calls the shipped lock stale gets exactly one recorded --frozen fallback (R7-09, R7-10, T7-12)", async (t) => {
  const { root, folder } = await fixture(t);
  const base = services(root);
  const backend = { ...base, runFile: async (executable, args, options) => {
    if (args[0] !== "sync") return base.runFile(executable, args, options);
    backend.calls.push({ executable, args, options });
    if (args[1] === "--locked") {
      const error = new Error("run failure");
      error.kind = "exit"; error.exitCode = 1; error.attempts = 1;
      error.stderr = "Resolved 40 packages in 63ms\nerror: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.\nhint: To update the lockfile, run `uv lock`.";
      throw error;
    }
    const python = path.join(args[args.indexOf("--project") + 1], ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    await fs.mkdir(path.dirname(python), { recursive: true }); await fs.writeFile(python, "fixture interpreter");
    return "";
  } };
  const harness = makeHarness({ folders: [folder] });
  const result = await setupRuntime(harness.vscode, harness.context, folder, backend);
  const syncs = backend.calls.filter((call) => call.args[0] === "sync");
  assert.deepEqual(syncs.map((call) => call.args[1]), ["--locked", "--frozen"], "one locked attempt, one frozen fallback, nothing else");
  assert.ok(result.lockFallback, "the fallback is recorded on the runtime result");
  assert.match(result.lockFallback.uvMessage, /needs to be updated/, "uv's own sentence is kept");
  assert.deepEqual(result.lockFallback.problems, [], "the shipped pair itself is current, so this host caused the refusal");
  assert.ok(result.check.ok, "the fallback runtime is still verified by the real reading check");
  assert.equal(result.attempts, 2, "two uv processes ran (locked, then frozen) and the step reports both (0.3.7 e2e D7)");
});

test("an ordinary sync failure gets no fallback, and plain `uv sync` is never issued (T7-13)", async (t) => {
  const { root, folder } = await fixture(t);
  const base = services(root);
  const backend = { ...base, runFile: async (executable, args, options) => {
    if (args[0] !== "sync") return base.runFile(executable, args, options);
    backend.calls.push({ executable, args, options });
    const error = new Error("run failure");
    error.kind = "exit"; error.exitCode = 2; error.stderr = "error: failed to fetch https://pypi.org/simple/pypdf/";
    error.message = "uv sync failed with exit code 2: error: failed to fetch https://pypi.org/simple/pypdf/";
    throw error;
  } };
  const harness = makeHarness({ folders: [folder] });
  await assert.rejects(setupRuntime(harness.vscode, harness.context, folder, backend), /failed with exit code 2/);
  const syncs = backend.calls.filter((call) => call.args[0] === "sync");
  assert.equal(syncs.length, 1, "a network failure is not answered by a second, weaker command");
  assert.ok(syncs.every((call) => ["--locked", "--frozen"].includes(call.args[1])), "the toolkit never runs an unlocked sync");
});

test("discovery sees this release's managed folder and rejects names the toolkit cannot ship (R7-14, T7-16)", async (t) => {
  const { root } = await fixture(t);
  const managed = path.join(root, MANAGED_FOLDER);
  const shaped = ["0.3.6", "0.3.7", WORKER_VERSION].filter((item, index, all) => all.indexOf(item) === index);
  for (const name of [...shaped.map((version) => `worker-${version}`), "worker-0.3.6.1", "worker-0.3"]) {
    const folder = path.join(managed, name);
    await fs.mkdir(path.join(folder, ".venv", process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
    await fs.writeFile(path.join(folder, "installation.json"), JSON.stringify({ workerVersion: name.replace("worker-", ""), updatedAt: "2026-11-02T15:13:11.812Z", checks: { ok: true } }));
  }
  const discovered = await discoverRuntimes(root);
  const versions = discovered.runtimes.map((item) => item.version).sort();
  // `worker-0.3.6.1` and `worker-0.3` are not runtimes: vsce validates the extension version with
  // semver.valid, which takes at most three numbers, so no release can ever name such a folder.
  assert.deepEqual(versions, ["0.3.6", "0.3.7", WORKER_VERSION].filter((item, index, all) => all.indexOf(item) === index),
    "shaped runtimes are discovered and malformed folder names are skipped");
  const current = discovered.runtimes.find((item) => item.version === WORKER_VERSION);
  assert.equal(current.thisRelease, true);
  assert.equal(current.verified, true);
  await activateRuntime(managed, { version: WORKER_VERSION, folder: path.join(managed, `worker-${WORKER_VERSION}`), previousVersion: "0.3.6", reason: "verified-setup" });
  const after = await discoverRuntimes(root);
  assert.equal(after.active.version, WORKER_VERSION, "the patch runtime can be made active");
});

test("the reading check honours the operator's setup bound instead of a fixed 90 s (R7-16, T7-19)", async () => {
  const calls = [];
  const servicesWithBound = { setupTimeoutMs: 1_800_000, async runFile(executable, args, options) { calls.push(options); return JSON.stringify({ ok: true, toolSurface: { servers: [], toolCount: 0 } }); } };
  await functionalCheck({ extensionUri: { fsPath: "/ext" } }, { python: "/w/.venv/bin/python", worker: "/w", version: WORKER_VERSION }, undefined, undefined, servicesWithBound);
  assert.equal(calls[0].timeout, 1_800_000, "a raised setup timeout raises the reading check too");
  const defaultCalls = [];
  await functionalCheck({ extensionUri: { fsPath: "/ext" } }, { python: "/w/.venv/bin/python", worker: "/w", version: WORKER_VERSION }, undefined, undefined, { async runFile(executable, args, options) { defaultCalls.push(options); return JSON.stringify({ ok: true, toolSurface: { servers: [], toolCount: 0 } }); } });
  assert.equal(defaultCalls[0].timeout, 90000, "the reviewed floor still applies when nothing was raised");
});

test("when the reviewed fallback also fails, the operator sees both refusals, not just the last one (0.3.7 review, T7-13 gap)", async (t) => {
  const { root, folder } = await fixture(t);
  const base = services(root);
  const backend = { ...base, runFile: async (executable, args, options) => {
    if (args[0] !== "sync") return base.runFile(executable, args, options);
    backend.calls.push({ executable, args, options });
    const error = new Error("run failure");
    error.kind = "exit"; error.exitCode = 2; error.attempts = 1;
    if (args[1] === "--locked") {
      error.stderr = "Resolved 40 packages in 63ms\nerror: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.\nhint: To update the lockfile, run `uv lock`.";
    } else {
      error.stderr = "error: failed to fetch https://pypi.org/simple/pypdf/";
    }
    throw error;
  } };
  const harness = makeHarness({ folders: [folder] });
  const error = await setupRuntime(harness.vscode, harness.context, folder, backend).catch((item) => item);
  const syncs = backend.calls.filter((call) => call.args[0] === "sync");
  assert.deepEqual(syncs.map((call) => call.args[1]), ["--locked", "--frozen"], "the fallback ran once and nothing ran after it");
  assert.match(error.message, /The locked install was refused by this host's uv/, error.message);
  assert.match(error.message, /needs to be updated/, "the first refusal's sentence survives");
  assert.match(error.message, /The reviewed fallback that installs exactly what the shipped lock pins also failed/, error.message);
  assert.match(error.message, /failed to fetch/i, "and so does the second one");
  assert.match(error.message, /was not rewritten/, error.message);
  assert.equal(error.attempts, 2, "the record says two attempts ran");
  assert.equal(error.exitCode, 2, "the exit code of the attempt that stopped the install");
  assert.ok(error.lockFallback, "the status record can still show that a fallback was attempted");
  assert.match(error.lockFallback.fallbackFailure, /failed to fetch/);
});

/**
 * A stand-in for uv that goes through the reviewed process boundary itself: it refuses `--locked`
 * with uv 0.13.6's own sentence (receipts/12-genuine-uv-refusal-text.txt) and then fails the gated
 * `--frozen` fallback the way a real network failure does (receipts/19). It writes nothing.
 */
const STUB_UV = [
  "const a = process.argv.slice(1);",
  "if (a[0] !== 'sync') { console.error('unexpected args: ' + a.join(' ')); process.exit(9); }",
  "if (a[1] === '--locked') {",
  "  console.error('Using CPython 3.12.16');",
  "  console.error('Resolved 40 packages in 180ms');",
  "  console.error('error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.');",
  "  console.error('hint: To update the lockfile, run `uv lock`.');",
  "  process.exit(1);",
  "}",
  "console.error('Request failed after 3 retries in 6.2s');",
  "console.error('  Caused by: Failed to fetch: https://127.0.0.1:1/simple/hatchling/');",
  "console.error('  Caused by: tcp connect error: Connection refused (os error 111)');",
  "process.exit(2);",
].join(" "); // one line, so the recorded command stays one line

test("a failed lockfile fallback never repeats the success wording, and names the next action and the directory (0.3.7 e2e D1, D3, D4)", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const calls = [];
  const services = {
    uv: process.execPath,
    runProcess: (executable, args, options) => {
      calls.push({ args });
      return runProcess(process.execPath, ["-e", STUB_UV, ...args], options);
    },
  };
  const error = await setupRuntime(harness.vscode, harness.context, folder, services).catch((item) => item);
  const syncs = calls.filter((call) => call.args[0] === "sync");
  assert.deepEqual(syncs.map((call) => call.args[1]), ["--locked", "--frozen"], "one locked attempt and one gated fallback, through the reviewed runner");
  assert.match(error.message, /The locked install was refused by this host's uv/, error.message);
  assert.match(error.message, /needs to be updated/, "the first refusal's sentence survives");
  assert.match(error.message, /The reviewed fallback that installs exactly what the shipped lock pins also failed/, error.message);
  assert.match(error.message, /Failed to fetch/, "and so does the second one");
  assert.ok(!error.message.includes("Installed exactly the packages the shipped lock pins"), "a failed step never carries the tier's success wording (D1)");
  assert.match(error.message, /Check the host tool version and network access, then retry setup\./, "the failure sentence the code intends to say (D1)");
  assert.match(error.hint, /Check the host tool version and network access, then retry setup\./, "the status layer gets a next action, not the generic retry (D3)");
  const managed = await fs.realpath(path.join(root, MANAGED_FOLDER));
  assert.ok(String(error.cwd || "").endsWith(path.join(`worker-${WORKER_VERSION}`)), `the failure carries the directory the fallback ran in, got ${error.cwd} (D4)`);
  assert.equal(path.dirname(error.cwd), managed, "and it is the managed worker directory inside this workspace");
  const line = commandLine(error);
  assert.ok(line.includes("(in ") && line.includes(error.cwd), `the recorded command line names the working directory, got ${line} (D4)`);
  assert.ok(!line.includes("working directory not recorded"), line);
  const rerun = rerunInstruction(error).split("\n");
  assert.ok(rerun.some((entry) => entry.startsWith("cd ") && entry.includes(error.cwd)), `the pasteable instruction gets a real cd line: ${rerun.join(" | ")}`);
  assert.equal(error.attempts, 2, "two uv processes ran and the record says two");
  assert.equal(error.exitCode, 2, "the exit code of the attempt that stopped the install");
  await assert.rejects(fs.stat(path.join(managed, `worker-${WORKER_VERSION}`, ".venv")), /ENOENT/, "the failed fallback created no environment");
});
