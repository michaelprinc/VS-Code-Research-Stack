"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { baseInventory, checkInventory } = require("../diagnostics");
const { makeHarness } = require("./harness");

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
      assert.deepEqual(args.slice(0, 2), ["-I", "-B"]);
      assert.ok(args[2].endsWith("probe.py"));
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

test("component guide/docs actions accept only registry IDs and fixed upstream URLs", async () => {
  const harness = makeHarness();
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "guide", id: "pypdf" });
  assert.ok(harness.invoked.some((entry) => entry.id === "markdown.showPreview" && entry.args[0] === "extension/guides/pypdf.md"));
  await panel.receive({ type: "docs", id: "pypdf" });
  assert.equal(harness.events.external, "https://pypdf.readthedocs.io/en/stable/user/extract-text.html");
  for (const id of ["../../credentials", "https://evil.test", "institutional-provider-adapters"]) {
    await panel.receive({ type: "docs", id });
    assert.ok(panel.messages.at(-1).error);
  }
});
