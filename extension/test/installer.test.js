"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { makeHarness } = require("./harness");
const { WORKER_FOLDER, bundle } = require("../runtime");
const { readStatus, readLog } = require("../setuplog");
const catalog = require("../components.json");
const TOOLKIT_VERSION = require("../package.json").version;
const {
  STEPS_BY_ID, RECEIPT_NAME, stepsForPackage, stepsForComponents, resolveStepSelection,
  readReceipt, writeReceipt, stepStatus, componentStatus, planView, outdatedSteps, failedSteps,
  overlayStepFor, writeOverlayFiles, runPlan, verifyStepArtifacts, planArtifacts, inspectNotebookProject, explainStepSelection, refreshPlanStatus,
  commandLine, rerunInstruction, runAttempts, attemptRecord, nextActionFor,
} = require("../installer");
const { diagnosticsText, outcomeLine, stepRow } = require("../status");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-install-test-"));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("research-install-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, folder: { name: "Research é & spaces", uri: { scheme: "file", fsPath: root } } };
}

/** Bounded fake runner: only the reviewed commands are accepted, and each one leaves the artefact the real step checks for. */
function services(root, { fail = false, failProject = null } = {}) {
  const calls = [];
  const progressMessages = [];
  return { calls, progressMessages,
    progress(message) { progressMessages.push(message); },
    async findHostTool(name) { return name === "uv" ? "/trusted/uv" : undefined; },
    async runFile(executable, args, options) {
      calls.push({ executable, args, options });
      if (args[0] === "sync") {
        const project = args[args.indexOf("--project") + 1];
        const allowed = [path.join(root, WORKER_FOLDER), path.join(root, "notebooks", "analysis")];
        assert.ok(allowed.includes(project), `only reviewed projects are synced, got ${project}`);
        if (fail || (failProject && project === failProject)) throw new Error(`Synthetic interrupted install in ${path.basename(project)}`);
        const python = path.join(project, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
        await fs.mkdir(path.dirname(python), { recursive: true }); await fs.writeFile(python, "fixture interpreter");
        return "";
      }
      if (args[0] === "--version") return "uv 9.9-observed";
      if (args[2].endsWith("probe.py")) return JSON.stringify({ python: "3.12.99", packages: {}, recommended: true, full: true, lab: true });
      if (args.slice(0, 3).join(" ") === "-I -B -c") {
        assert.match(args[3], /import ipykernel, matplotlib/, "the notebook step verifies the imports its notebooks use");
        return "3.12.99 (fixture, main)";
      }
      if (args.slice(0, 3).join(" ") === "-I -B -m" && args[3] === "research_stack.cli") {
        assert.deepEqual(args.slice(0, 5), ["-I", "-B", "-m", "research_stack.cli", "init-lab"]);
        const store = path.join(root, ".research-toolkit", "store", "research.sqlite3");
        await fs.mkdir(path.dirname(store), { recursive: true }); await fs.writeFile(store, "fixture store");
        return JSON.stringify({ ok: true, store, schemaVersion: 2, tableCount: 7, profile: "full" });
      }
      assert.ok(args[2].endsWith("functional_check.py"));
      const surface = (module, names) => ({ module, toolCount: names.length, characters: 400 * names.length, tokensEstimate: 140 * names.length, tools: names.map((name) => ({ name, title: name, characters: 400, tokensEstimate: 140 })) });
      return JSON.stringify({
        ok: true, pdfRead: true, docxRead: true, lexicalSearch: true, researchAdapter: true, corpusIndex: true, recordStore: true, externalProvidersChecked: false,
        toolSurface: { basis: "measured", servers: [surface("research_stack.mcp_server", ["read_document", "read_text_source", "search_local_text", "write_markdown", "write_docx"]),
          surface("research_stack.recommended_server", ["search_literature", "check_citation", "zotero_collections", "zotero_item", "prepare_zotero_import"]),
          surface("research_stack.lab_server", ["index_corpus", "unindex_corpus", "search_corpus", "evidence_read", "claims_read", "claims_write", "claims_export", "store_status", "store_maintenance"])], toolCount: 20, characters: 8000, tokensEstimate: 2800 },
      });
    },
  };
}

test("every package declares an ordered step plan whose prerequisites it also offers", () => {
  assert.equal(catalog.schemaVersion, 2, "the install plan is declarative in the component registry");
  const expected = { basic: ["worker"], recommended: ["worker", "research-overlay", "notebook-env"], full: ["worker", "research-overlay", "notebook-env", "lab-store"] };
  for (const [packageId, ids] of Object.entries(expected)) {
    assert.deepEqual(stepsForPackage(packageId).map((step) => step.id), ids, `${packageId} step plan`);
    const declaration = catalog.packages[packageId];
    assert.ok(declaration.label && declaration.gate && declaration.support, `${packageId} states its label, gate and support level`);
    for (const step of stepsForPackage(packageId)) {
      for (const prerequisite of step.prerequisites || []) {
        assert.ok(ids.indexOf(prerequisite) < ids.indexOf(step.id), `${packageId}: "${prerequisite}" must come before "${step.id}"`);
      }
    }
  }
  assert.deepEqual(stepsForPackage("not-a-package"), []);
  for (const step of catalog.installSteps) {
    assert.ok(STEPS_BY_ID.get(step.id) === step);
    assert.ok(Array.isArray(step.components) && step.components.length, `${step.id} names the components it provides`);
    for (const id of step.components) assert.ok(catalog.components.some((item) => item.id === id), `${step.id} references ${id}`);
  }
  for (const component of catalog.components) {
    const install = component.install || {};
    assert.ok(["managed", "planned", "external", "host", "editor"].includes(install.mode), `${component.id} declares an install mode`);
    assert.ok(typeof component.nextAction === "string" && component.nextAction.length > 10, `${component.id} states the next action`);
    if (install.mode !== "managed") continue;
    assert.ok(STEPS_BY_ID.get(install.step), `${component.id} is provided by a declared step`);
    assert.ok(STEPS_BY_ID.get(install.step).components.includes(component.id), `${component.id} is listed by its own step`);
    for (const packageId of component.profiles || []) {
      assert.ok(stepsForPackage(packageId).some((step) => step.id === install.step), `${packageId} offers the step that provides ${component.id}`);
    }
  }
});

test("a component selection pulls in its prerequisites and rejects steps the package does not offer", () => {
  assert.deepEqual(resolveStepSelection("full", ["lab-store"]), ["worker", "lab-store"], "the dependency closure is resolved, not rejected");
  assert.deepEqual(explainStepSelection("full", ["lab-store"]).added, [{ id: "worker", label: "Isolated locked worker (Python 3.12)", reason: "Required by lab-store." }], "the added step is explained to the operator");
  assert.deepEqual(resolveStepSelection("full", ["research-overlay"]), ["research-overlay"], "the overlay needs no interpreter, so it has no prerequisite");
  assert.deepEqual(resolveStepSelection("full", ["worker", "lab-store"]), ["worker", "lab-store"], "the plan order is preserved");
  assert.deepEqual(resolveStepSelection("full", undefined), ["worker", "research-overlay", "notebook-env", "lab-store"]);
  assert.deepEqual(stepsForComponents("full", ["research-record-store"]).map((step) => step.id), ["worker", "lab-store"]);
  assert.deepEqual(stepsForComponents("recommended", ["research-corpus-index"]), [], "the corpus tools are not offered below Full");
  for (const [packageId, requested, message] of [
    ["basic", ["lab-store"], /not offered by the selected package/],
    ["full", ["lab-store", "not-a-step"], /not offered by the selected package/],
    ["full", "worker", /must be a list/],
    ["full", [7], /must be a list/],
  ]) {
    assert.throws(() => resolveStepSelection(packageId, requested), message, `${packageId} ${JSON.stringify(requested)}`);
  }
});

test("the receipt distinguishes missing, installed and outdated steps for the GUI and the update command", async (t) => {
  const { root } = await fixture(t);
  const worker = path.join(root, WORKER_FOLDER);
  assert.equal(await readReceipt(worker), null, "a fresh workspace has no receipt");
  const step = STEPS_BY_ID.get("worker");
  assert.equal(stepStatus(step, null, "0.3.4").status, "missing");
  await writeReceipt(worker, { workerVersion: "0.3.4", steps: { worker: { toolkitVersion: "0.3.3", evidence: "Older release" }, "research-overlay": { toolkitVersion: "0.3.4" } } });
  const receipt = await readReceipt(worker);
  assert.equal(stepStatus(step, receipt, "0.3.4").status, "outdated");
  assert.equal(stepStatus(step, receipt, "0.3.4").installedVersion, "0.3.3");
  assert.equal(stepStatus(STEPS_BY_ID.get("research-overlay"), receipt, "0.3.4").status, "installed");
  assert.equal(stepStatus(STEPS_BY_ID.get("lab-store"), receipt, "0.3.4").status, "missing");
  assert.deepEqual(outdatedSteps("full", receipt, "0.3.4"), ["worker"]);
  assert.deepEqual(outdatedSteps("full", receipt, "0.3.3"), ["research-overlay"]);
  const plan = planView("full", receipt, "0.3.4");
  assert.equal(plan.steps.length, 4);
  assert.deepEqual(plan.outdated, ["worker"]);
  assert.deepEqual(plan.missing, ["lab-store"], "an optional step is not counted as an unmet required step");
  assert.deepEqual(plan.needsRepair, [], "no artifacts were observed, so nothing is claimed to need repair");
  assert.deepEqual(plan.omittedOptional, ["notebook-env"], "an uninstalled optional step is reported as a deliberate omission");
  const observed = new Map([["research-overlay", { stepId: "research-overlay", verified: false, missing: ["research/README.md"], observedCount: 0 }]]);
  const repaired = planView("full", receipt, "0.3.4", observed);
  assert.deepEqual(repaired.needsRepair, ["research-overlay"], "a recorded step whose files are gone is reported as needing repair");
  assert.match(repaired.steps.find((step) => step.id === "research-overlay").evidence, /research\/README\.md/, "the repair evidence names the missing file");
  assert.equal(stepStatus(STEPS_BY_ID.get("research-overlay"), receipt, "0.3.4", { verified: true, missing: [] }).status, "installed");
  assert.equal(plan.counts.installed, 1);
  assert.equal(plan.package.gate, "G3 not passed", "the plan states the gate it has not cleared");
  const corpus = componentStatus(catalog.components.find((item) => item.id === "research-corpus-index"), receipt, "0.3.4", null);
  assert.equal(corpus.mode, "managed"); assert.equal(corpus.installable, true); assert.equal(corpus.status, "missing");
  assert.equal(componentStatus(catalog.components.find((item) => item.id === "zotero-local-api"), receipt, "0.3.4", null).mode, "external");
  assert.equal(componentStatus(catalog.components.find((item) => item.id === "duckdb-research-record-store"), receipt, "0.3.4", null).status, "planned");
  const editor = componentStatus(catalog.components.find((item) => item.id === "github-copilot"), receipt, "0.3.4", { installed: "Installed", version: "1.2.3" });
  assert.equal(editor.status, "installed"); assert.equal(editor.installedVersion, "1.2.3");
  await fs.writeFile(path.join(worker, RECEIPT_NAME), "[]", "utf8");
  assert.equal(await readReceipt(worker), null, "a malformed receipt is not treated as an install record");
});

test("runPlan runs missing steps in order, records each one, and resumes without repeating current work", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const backend = services(root);
  const first = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "full", services: backend });
  assert.deepEqual(first.ran, ["worker", "research-overlay", "notebook-env", "lab-store"]);
  assert.deepEqual(first.skipped, []);
  const receipt = first.receipt;
  assert.equal(receipt.workerVersion, TOOLKIT_VERSION);
  assert.equal(Object.keys(receipt.steps).length, 4);
  assert.equal(receipt.steps["notebook-env"].status, "installed");
  assert.match(receipt.steps["notebook-env"].evidence, /Kernel not started by this step/);
  assert.match(receipt.steps["notebook-env"].evidence, /ipykernel and matplotlib import/, "the notebook step records the import verification, not just a sync");
  assert.equal(receipt.steps["notebook-env"].importsVerified, true);
  assert.match(receipt.steps["lab-store"].evidence, /schema 2; 7 tables/);
  assert.ok(receipt.checks.ok, "the worker reading check is recorded with the plan");
  assert.ok(backend.calls.some(({ args }) => args[3] === "research_stack.cli"), "the store step ran through the worker module path");
  const resume = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "full", services: backend });
  assert.deepEqual(resume.ran, [], "a resumed plan repeats nothing");
  assert.deepEqual(resume.skipped, ["worker", "research-overlay", "notebook-env", "lab-store"], "skipping needs observed artifacts, not only a receipt");
  assert.deepEqual(resume.repaired, []);
  const leftovers = await fs.readdir(path.join(root, WORKER_FOLDER));
  assert.deepEqual(leftovers.filter((name) => name.endsWith(".tmp")), [], "the receipt is written atomically, with no temporary file left behind");
  await assert.rejects(fs.lstat(path.join(root, ".research-toolkit/managed/.setup.lock")), /ENOENT/, "the plan-wide lock is released when the plan finishes");

  await fs.rm(path.join(root, "research", "README.md"));
  const repaired = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "full", services: backend });
  assert.deepEqual(repaired.ran, ["research-overlay"], "a recorded step whose produced file is gone is re-run, not reported as complete");
  assert.deepEqual(repaired.repaired, ["research-overlay"]);
  const partial = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "full", stepIds: ["worker", "lab-store"], services: backend, force: true });
  assert.deepEqual(partial.ran, ["worker", "lab-store"], "forced steps re-run in plan order");
  // 0.3.6 contract: a failing step does not throw the plan away. The plan reports the failure,
  // records it, and refuses to call a failed step installed.
  const broken = services(root, { fail: true });
  const brokenRun = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "recommended", stepIds: ["worker", "research-overlay", "notebook-env"], services: broken, force: true });
  assert.deepEqual(brokenRun.failed, ["worker"], "the failure is reported, not swallowed");
  assert.deepEqual(brokenRun.ran, ["research-overlay"], "a step with no failed prerequisite continues (T6-13)");
  assert.deepEqual(brokenRun.blocked, ["notebook-env"], "a step that does declare the failed step is blocked, not silently skipped (T6-13)");
  assert.equal(brokenRun.outcome, "partial", "the plan outcome names the failure without erasing the step that succeeded");
  assert.match(brokenRun.statusRecord.steps[0].error, /Synthetic interrupted install/, "the captured error text is kept for the GUI and the log");
  const stored = await readReceipt(path.join(root, WORKER_FOLDER));
  assert.deepEqual(Object.keys(stored.steps).sort(), ["lab-store", "notebook-env", "research-overlay", "worker"], "a failed step does not invent a record");
  assert.equal(stored.steps["research-overlay"].status, "installed", "a step that completed stays installed even when a sibling failed");
  assert.equal(stored.steps["worker"].lastAttempt.status, "failed", "the failed attempt is recorded on the step");
  assert.match(stored.steps["worker"].lastAttempt.error, /Synthetic interrupted install/);
  const status = await refreshPlanStatus({ context: harness.context, folder, packageId: "recommended" });
  assert.ok(status.failed.includes("worker"), "the plan view reports the step whose last attempt failed");
  assert.equal(status.steps.find((step) => step.id === "worker").lastAttempt.status, "failed", "the panel sees the failed attempt even though an earlier run recorded the step");
  assert.ok(status.statusRecord, "the plan view carries the recorded installation status");
});

function overlayEvidenceText(overlay) {
  const parts = [`${overlay.created.length} overlay file(s) created`, `${overlay.current.length} unchanged file(s) preserved`];
  if (overlay.modifiedPreserved.length) parts.push(`${overlay.modifiedPreserved.length} file(s) changed by you and preserved (they differ from this release)`);
  return parts.join(", ");
}

test("a first failed attempt is named in the component evidence instead of a bare 'not installed' (T6-14)", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const broken = services(root, { fail: true });
  const run = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "basic", services: broken });
  assert.equal(run.outcome, "failed");
  const view = await refreshPlanStatus({ context: harness.context, folder, packageId: "basic" });
  const worker = view.steps.find((step) => step.id === "worker");
  assert.equal(worker.status, "missing", "a step that never succeeded is not reported installed");
  assert.match(worker.evidence, /The last setup attempt failed: Synthetic interrupted install/, "the evidence names the failure the operator has to fix");
  assert.equal(worker.lastAttempt.status, "failed");
  assert.match(worker.lastAttempt.error, /Synthetic interrupted install/);
  const status = await readStatus(path.join(root));
  assert.equal(status.outcome, "failed", "the workspace status record survives the plan");
  assert.match(status.steps[0].error, /Synthetic interrupted install/);
  const log = await readLog(path.join(root));
  assert.ok(log.files.length, "the setup log file exists");
  assert.ok(log.lines.some((entry) => entry.record.stepId === "worker" && entry.record.status === "failed"), "the attempt is in the log");
});

test("a failure blocks only its dependents: independent steps still run (T6-13, R6-19)", async (t) => {
  const { root, folder } = await fixture(t);
  const notebookProject = path.join(root, "notebooks", "analysis");
  const backend = services(root, { failProject: notebookProject });
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "full" }, diagnosticServices: backend });
  const run = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "full", services: backend });
  assert.deepEqual(run.ran, ["worker", "research-overlay", "lab-store"], "the steps that do not depend on the failure are not skipped because of it");
  assert.deepEqual(run.failed, ["notebook-env"], "the failure is named, not absorbed");
  assert.deepEqual(run.blocked, [], "no step depends on notebook-env, so nothing is blocked by it");
  assert.equal(run.outcome, "partial", "one verified step short of the plan is reported as partial");
  assert.match(run.statusRecord.steps.find((step) => step.id === "notebook-env").error, /Synthetic interrupted install in analysis/);
  const stored = await readReceipt(path.join(root, WORKER_FOLDER));
  assert.ok(stored.steps["research-overlay"], "a step that succeeded next to a failure is recorded");
  const failedRecord = stored.steps["notebook-env"];
  assert.equal(failedRecord.status, undefined, "the failed step is kept only as an attempt, never as an installation");
  assert.equal(failedRecord.lastAttempt.status, "failed", "the receipt keeps what the last attempt did");
  assert.equal(stepStatus(STEPS_BY_ID.get("notebook-env"), stored, TOOLKIT_VERSION, null).status, "missing");
  const plan = planView("full", stored, TOOLKIT_VERSION, await planArtifacts("full", root, await bundle(harness.context).then(({ manifest }) => manifest), run.statusRecord));
  assert.equal(plan.steps.find((step) => step.id === "notebook-env").status, "missing", "the panel lists the failed step as unmet, not as installed");
  assert.deepEqual(plan.failed, ["notebook-env"], "and names it as the failure to act on");
});

test("overlay files are created once, hash-verified, and never overwrite project files", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const { created } = await writeOverlayFiles(harness.context, root, "research-overlay", services(root));
  assert.ok(created.length >= 8, "the reviewed research overlay is written once");
  assert.deepEqual(created.filter((relative) => relative.startsWith("notebooks/analysis/")), [], "notebook files belong to the notebook step");
  assert.equal(overlayStepFor("notebooks/analysis/pyproject.toml"), "notebook-env");
  assert.equal(overlayStepFor("src/research_stack/full.py"), "research-overlay");
  const firstFile = created[0];
  await fs.writeFile(path.join(root, firstFile), "hand-edited by the researcher", "utf8");
  const again = await writeOverlayFiles(harness.context, root, "research-overlay", services(root));
  assert.deepEqual(again.created, [], "no file is replaced");
  assert.ok(again.preserved.includes(firstFile));
  assert.ok(again.modifiedPreserved.includes(firstFile), "a hand-edited file is classified as modified-preserved, not as current");
  assert.ok(again.current.length >= 1 && !again.current.includes(firstFile), "unchanged files are classified as current");
  assert.equal(await fs.readFile(path.join(root, firstFile), "utf8"), "hand-edited by the researcher", "project edits survive a re-run");
  assert.match(overlayEvidenceText(again), /changed by you and preserved/);
  const link = path.join(root, "notebooks", "analysis");
  await fs.mkdir(path.dirname(link), { recursive: true });
  await fs.symlink(path.join(os.tmpdir(), "elsewhere"), link, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(writeOverlayFiles(harness.context, root, "notebook-env", services(root)), /must be real directories, not links/, "a linked path is refused instead of followed");
});

test("GUI setup, update and component actions drive the plan and report component coverage", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: services(root) });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "ready" });
  let state = panel.messages.at(-1);
  assert.equal(state.installPlan.package.id, "recommended");
  assert.equal(state.installPlan.steps.length, 3);
  assert.deepEqual(state.installPlan.missing, ["worker", "research-overlay"], "the optional notebook step is an omission, not a missing requirement");
  assert.deepEqual(state.installPlan.omittedOptional, ["notebook-env"]);
  assert.equal(state.installPlan.components.managed, 8);
  assert.match(state.readiness, /Package setup for Recommended Research: 0 of 3 component steps installed, 2 not installed, 1 optional step\(s\) deliberately not installed/);
  await panel.receive({ type: "setup", steps: ["worker", "research-overlay"] });
  assert.deepEqual(panel.messages.at(-1), { type: "result", message: "Done." });
  state = harness.api.state();
  assert.equal(state.installPlan.counts.installed, 2);
  assert.deepEqual(state.installPlan.missing, [], "no required step is unmet");
  assert.deepEqual(state.installPlan.omittedOptional, ["notebook-env"], "the optional step is reported as deliberately omitted");
  assert.match(state.readiness, /Package setup for Recommended Research: 2 of 3 component steps installed, 1 optional step\(s\) deliberately not installed/);
  const stored = await readReceipt(path.join(root, WORKER_FOLDER));
  assert.deepEqual(Object.keys(stored.steps).sort(), ["research-overlay", "worker"]);
  assert.equal(stored.toolPreset.id, "research-core", "the receipt records the goal the workspace is using");
  await panel.receive({ type: "setup", steps: ["research-overlay"] });
  assert.deepEqual(panel.messages.at(-1), { type: "result", message: "Done." }, "a prerequisite is resolved automatically instead of failing the click");
  state = harness.api.state();
  assert.equal(state.installPlan.counts.installed, 2, "the already-current prerequisite is not repeated");
  await panel.receive({ type: "installComponent", id: "research-stack-recommended-adapter" });
  state = harness.api.state();
  assert.equal(state.installPlan.counts.installed, 2, "installing an already-current component changes nothing");
  await panel.receive({ type: "installComponent", id: "not-a-component" });
  assert.match(panel.messages.at(-1).error || "", /component/i, "unknown component ids are rejected");
  await harness.registered.get("researchToolkit.checkComponents")();
  await harness.registered.get("researchToolkit.copyReadiness")();
  assert.match(harness.events.clipboard, new RegExp(`Component setup \\(recommended, toolkit ${TOOLKIT_VERSION}\\): worker installed at ${TOOLKIT_VERSION} · research-overlay installed at ${TOOLKIT_VERSION}`));
  assert.match(harness.events.clipboard, /preset research-core \(10 toolkit tools, ≈1400 tokens measured\)/, "the receipt's preset and measured surface appear in the copied inventory");
  const status = await harness.registered.get("researchToolkit.updateComponents")();
  assert.match(status.message, /nothing is recorded by an earlier toolkit release, and every recorded step's files are present/, "with a current receipt and present artifacts there is nothing to update");
  assert.deepEqual(status.ran, []);
  const refreshed = await harness.registered.get("researchToolkit.refreshComponentStatus")();
  assert.match(refreshed, /No recorded step is missing its produced files/);
  assert.match(refreshed, /Deliberately omitted optional steps: notebook-env/);
  assert.match(refreshed, /The functional MCP reading check was not run by this refresh/, "a status refresh is not presented as a functional check");
  await harness.registered.get("researchToolkit.diagnoseToolLimit")();
  assert.match(harness.output.lines.join("\n"), /Client ceiling: 128 tools/);
  assert.match(harness.output.lines.join("\n"), /Toolkit contribution now: 10 toolkit tools from 2 managed MCP server/);
  await harness.registered.get("researchToolkit.copyPresetSummary")();
  assert.match(harness.events.clipboard, /Toolkit tools \(10\):/);
  panel.dispose();
});

test("the notebook step identifies project ownership before any package management (T5-18)", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-notebook-ownership-"));
  const project = (name, pyproject) => path.join(root, name, "notebooks/analysis");
  const write = async (name, pyproject) => {
    const dir = project(name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "pyproject.toml"), pyproject, "utf8");
    return dir;
  };
  try {
    const reviewed = await write("reviewed", `name = "research-stack-analysis"\nrequires-python = ">=3.12,<3.15"\ndependencies = ["ipykernel", "matplotlib"]\n`);
    assert.deepEqual(await inspectNotebookProject(reviewed),
      { owned: true, existingProject: true, reviewedProject: true, projectName: "research-stack-analysis" },
      "the reviewed project is owned and synced");

    const unrelated = await write("unrelated", `name = "someone-elses-project"\nrequires-python = ">=3.12"\ndependencies = ["numpy"]\n`);
    const refused = await inspectNotebookProject(unrelated);
    assert.equal(refused.owned, false, "an unrelated project is not synced");
    assert.match(refused.reason, /does not declare ipykernel and matplotlib/);

    const compatible = await write("compatible", `name = "my-own-analysis"\nrequires-python = ">=3.12"\ndependencies = ["ipykernel>=6", "matplotlib>=3"]\n`);
    const custom = await inspectNotebookProject(compatible);
    assert.equal(custom.owned, true, "a project that declares what the notebooks import is compatible");
    assert.equal(custom.reviewedProject, false);
    assert.equal(custom.projectName, "my-own-analysis");
    assert.match(custom.note, /compatible existing project/, "the difference is reported, not hidden");

    const empty = await inspectNotebookProject(path.join(root, "empty/notebooks/analysis"));
    assert.deepEqual(empty, { owned: true, existingProject: false }, "with no project the step creates the reviewed one");

    await fs.mkdir(path.join(root, "linked", "notebooks/analysis"), { recursive: true });
    await fs.writeFile(path.join(root, "linked", "notebooks/analysis/real.toml"), `name = "research-stack-analysis"\ndependencies = ["ipykernel", "matplotlib"]\n`, "utf8");
    await fs.symlink(path.join(root, "linked", "notebooks/analysis/real.toml"), path.join(root, "linked", "notebooks/analysis/pyproject.toml"));
    const linked = await inspectNotebookProject(path.join(root, "linked", "notebooks/analysis"));
    assert.equal(linked.owned, false, "a linked pyproject.toml is refused rather than followed");
    assert.match(linked.reason, /is a link/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


test("uv's symlinked interpreter counts as produced, not as a missing file (0.3.6 field symptom)", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const backend = services(root);
  await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "basic", services: backend });
  const interpreter = path.join(root, WORKER_FOLDER, ".venv/bin/python");
  const base = path.join(root, "base-interpreter");
  await fs.writeFile(base, "#!python\n");
  await fs.rm(interpreter);
  await fs.symlink(base, interpreter);
  const artifacts = await verifyStepArtifacts(STEPS_BY_ID.get("worker"), root, null);
  assert.equal(artifacts.verified, true, JSON.stringify(artifacts.missing));
  const status = await refreshPlanStatus({ context: harness.context, folder, packageId: "basic" });
  assert.deepEqual(status.needsRepair, [], "a symlinked interpreter is not a repair target");
  const rerun = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "basic", services: backend });
  assert.deepEqual(rerun.skipped, ["worker"], "the plan does not re-download a worker that is already there");
});

test("an artefact that cannot be checked is reported as unverified, never as installed (T6-17)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-artifact-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".research-toolkit"), "not a directory");
  const artifacts = await verifyStepArtifacts(STEPS_BY_ID.get("lab-store"), root, null);
  assert.equal(artifacts.verified, false, "a verification failure is not proof of presence");
  assert.deepEqual(artifacts.missing, [".research-toolkit/store/research.sqlite3 (could not be checked: ENOTDIR)"]);
});

test("a retry record describes the whole package plan, not only the steps the retry re-ran (0.3.6 retry semantics)", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const backend = services(root, { failProject: path.join(root, WORKER_FOLDER) });
  const first = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "recommended", services: backend });
  assert.equal(first.outcome, "partial");
  assert.deepEqual(first.failed, ["worker"]);
  const afterFailure = await readStatus(root);
  assert.ok(afterFailure.steps.some((row) => row.id === "research-overlay" && row.status === "installed"),
    "the step that succeeded is in the record the panel reads");

  const retry = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "recommended", stepIds: ["worker"], services: services(root) });
  assert.deepEqual(retry.selected, ["worker"], "only the failed step is re-run");
  const record = await readStatus(root);
  assert.equal(record.outcome, "success", JSON.stringify(record.steps.map((row) => [row.id, row.status])));
  assert.deepEqual(record.steps.map((row) => row.id), ["worker", "research-overlay"], "the record keeps the step the retry did not attempt");
  const carried = record.steps.find((row) => row.id === "research-overlay");
  assert.equal(carried.carried, true, "a carried step is marked as carried, with its own re-checked evidence");
  assert.equal(carried.artifacts.verified, true);
  assert.deepEqual(record.packageSteps, { total: 3, installed: 2 }, "the record states how much of the package it covers");
});

test("the command an operator is told to re-run is quotable, and a fallback attempt carries its marker (0.3.7 Windows review D5)", () => {
  const line = commandLine({
    command: "C:\\Users\\sestra\\AppData\\Local\\uv\\uv.exe",
    args: ["sync", "--locked", "--no-dev", "--python", "3.12", "--project", "K:\\Soukromé aktivity\\Bankovní účet SVJ ČSA368\\.research-toolkit\\managed\\worker-0.3.7", "--no-config"],
    cwd: "K:\\Soukromé aktivity\\Bankovní účet SVJ ČSA368",
  });
  assert.match(line, /"K:\\Soukromé aktivity\\Bankovní účet SVJ ČSA368\\\.research-toolkit\\managed\\worker-0\.3\.7"/, line);
  assert.match(line, /\(in "K:\\Soukromé aktivity\\Bankovní účet SVJ ČSA368"\)/, line);
  assert.ok(!/--project K:\\/.test(line), "an unquoted path with spaces cannot be pasted into a terminal");
  assert.equal(commandLine({ command: "uv", args: ["--version"] }), "uv --version (working directory not recorded)", "a missing directory is named, not silently dropped");

  const attempt = attemptRecord({ id: "worker", label: "Isolated locked worker" }, {
    status: "installed", attempts: 1, evidence: "Locked worker synced", lockFallback: { detectedAt: "2026-11-02T21:00:00.000Z", problems: [] },
  });
  assert.deepEqual(attempt.lockFallback, { detectedAt: "2026-11-02T21:00:00.000Z", problems: [] }, "the fallback marker has to survive into the status record");
  assert.equal(attemptRecord({ id: "worker", label: "w" }, { status: "installed" }).lockFallback, null);
});

test("D4: a command line whose error carries no cwd says the directory is unknown (receipts/19c)", () => {
  const args = ["sync", "--frozen", "--no-dev", "--python", "3.12", "--project", "/tmp/e2e-037/work/Bankovní účet SVJ ČSA368/.research-toolkit/managed/worker-0.3.7", "--no-config"];
  // The shape the runtime's combined lock-fallback error has today: command and args, no cwd.
  const noCwd = commandLine({ command: "/tmp/uvs/uv-0.13.6", args });
  assert.ok(!/\(in /.test(noCwd), `no phantom directory: ${noCwd}`);
  assert.match(noCwd, /\(working directory not recorded\)$/, noCwd);
  assert.match(noCwd, /"\/tmp\/e2e-037\/work\/Bankovní účet SVJ ČSA368\/\.research-toolkit\/managed\/worker-0\.3\.7"/, "the spaced path is still quoted");
  // The shape it has once the runtime carries the cwd through: the suffix must appear.
  const withCwd = commandLine({ command: "/tmp/uvs/uv-0.13.6", args, cwd: "/tmp/e2e-037/work/Bankovní účet SVJ ČSA368/.research-toolkit/managed/worker-0.3.7" });
  assert.match(withCwd, /\(in "\/tmp\/e2e-037\/work\/Bankovní účet SVJ ČSA368\/\.research-toolkit\/managed\/worker-0\.3\.7"\)$/, withCwd);
  assert.ok(!/working directory not recorded/.test(withCwd), withCwd);
  assert.equal(commandLine(null), "");
  assert.equal(commandLine({}), "");
});

test("W7: the re-run instruction is two lines and quotable in cmd.exe and PowerShell (0.3.7 Windows review)", () => {
  const czech = "K:\\Soukromé aktivity\\Bankovní účet SVJ ČSA368\\.research-toolkit\\managed\\worker-0.3.7";
  const instruction = rerunInstruction({ command: "C:\\Users\\sestra\\AppData\\Local\\uv\\uv.exe", args: ["sync", "--locked", "--no-dev", "--python", "3.12", "--project", czech, "--no-config"], cwd: czech }, { platform: "win32" });
  const lines = instruction.split("\n");
  assert.equal(lines.length, 3, `cd line, command line and the encoding note: ${instruction}`);
  assert.match(lines[0], /UTF-8/, "W8: the OEM code page warning is part of the instruction");
  assert.match(lines[0], /chcp 65001/, "and it names the command that fixes the code page");
  assert.equal(lines[1], `cd "${czech}"`, lines[1]);
  assert.equal(lines[2], `"C:\\Users\\sestra\\AppData\\Local\\uv\\uv.exe" "sync" "--locked" "--no-dev" "--python" "3.12" "--project" "${czech}" "--no-config"`, lines[2]);
  assert.ok(!/\(in "/.test(instruction), `a trailing "(in …)" block is not pasteable: ${instruction}`);

  // A path with no whitespace but a cmd separator must still be quoted.
  const ampersand = rerunInstruction({ command: "C:\\tools\\uv.exe", args: ["sync", "--project", "K:\\A&B\\účet"], cwd: "K:\\A&B" }, { platform: "win32" });
  assert.ok(ampersand.includes('"K:\\A&B\\účet"'), ampersand);
  assert.ok(ampersand.includes('cd "K:\\A&B"'), ampersand);

  // An embedded double quote is escaped, not left to close the argument early.
  const quoted = rerunInstruction({ command: "C:\\tools\\uv.exe", args: ["-c", 'print("x")', "--project", 'K:\\weird\\"quoted\\" dir'], cwd: 'K:\\weird\\"quoted\\" dir' }, { platform: "win32" });
  assert.ok(quoted.includes('"K:\\weird\\\\\\"quoted\\\\\\" dir"'), quoted);
  assert.ok(quoted.includes('"print(\\"x\\")"'), quoted);

  // A trailing backslash must not swallow the closing quote.
  const trailing = rerunInstruction({ command: "C:\\tools\\uv.exe", args: ["sync", "--project", "K:\\dir with space\\"], cwd: "K:\\dir with space\\" }, { platform: "win32" });
  assert.ok(trailing.includes('"K:\\dir with space\\\\"'), trailing);

  // No recorded cwd: the instruction says so instead of guessing a directory.
  const noCwd = rerunInstruction({ command: "C:\\tools\\uv.exe", args: ["sync", "--locked"] }, { platform: "win32" });
  assert.ok(!/^cd /m.test(noCwd), noCwd);
  assert.match(noCwd, /working directory was not recorded/, noCwd);

  // The same instruction on a POSIX host uses shell quoting.
  const posix = rerunInstruction({ command: "/tmp/uvs/uv-0.13.6", args: ["sync", "--locked", "--project", "/w/Bankovní účet SVJ ČSA368"], cwd: "/w/Bankovní účet SVJ ČSA368" }, { platform: "linux" });
  assert.equal(posix.split("\n")[1], `cd '/w/Bankovní účet SVJ ČSA368'`, posix);
  assert.ok(posix.includes(`'/tmp/uvs/uv-0.13.6' 'sync' '--locked' '--project' '/w/Bankovní účet SVJ ČSA368'`), posix);

  // An argument containing a line break cannot be pasted as one line, and the instruction says so.
  const multiline = rerunInstruction({ command: "C:\\tools\\uv.exe", args: ["-c", "import sys\nprint(1)"], cwd: "K:\\w" }, { platform: "win32" });
  assert.match(multiline, /cannot be pasted as one line/, multiline);
  assert.ok(!multiline.includes("import sys\nprint(1)"), multiline);
});

test("D7: attempts=0 is recorded as 0, and a real attempt count from the run record is consumed (receipts/11a, 11b, 13)", () => {
  assert.equal(attemptRecord({ id: "worker", label: "w" }, { status: "failed", attempts: 0, error: "no process ran" }).attempts, 0, "a refusal where nothing ran must not read as one attempt");
  assert.equal(runAttempts({ attempts: 0 }), 0);
  assert.equal(runAttempts({ attempts: 2 }), 2, "two uv processes ran, so the record says two");
  assert.equal(runAttempts({ processAttempts: 2 }), 2, "the count is consumed whatever name the runner layer publishes it under");
  assert.equal(runAttempts({ attemptsRun: 2 }), 2);
  assert.equal(runAttempts({ attemptCount: 2 }), 2);
  assert.equal(runAttempts({}), 1, "a step result with no count still records one attempt");
  assert.equal(runAttempts({ attempts: null }), 1);
  assert.equal(runAttempts({ attempts: "two" }), 1);
  assert.equal(runAttempts({ attempts: -1 }), 1);
  assert.equal(runAttempts({ attempts: 2.9 }), 2, "an attempt count is a whole number");
});

test("D4 + D7 end to end: a refusal where no process ran records 0 attempts, an honest command line and the fallback marker", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const backend = services(root);
  const refuses = (withCwd) => async (executable, args, options = {}) => {
    if (args[0] !== "sync") return backend.runFile(executable, args, options);
    // The runner's own shape for a refusal where nothing started (runner.js sets attempts = 0),
    // and the shape of the combined lock-fallback error (command/args, no cwd).
    const error = new Error("run failure");
    error.name = "RunError";
    error.kind = "cwd";
    error.exitCode = null;
    error.attempts = 0;
    error.command = executable;
    error.args = args;
    error.stderr = "";
    if (withCwd) error.cwd = options.cwd;
    error.lockFallback = { detectedAt: "2026-11-03T11:00:50.383Z", problems: [], uvMessage: "error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.", fallbackFailure: "cause: Connection refused (os error 111)" };
    throw error;
  };
  backend.runProcess = refuses(false);
  const result = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "recommended", stepIds: ["worker"], services: backend });
  assert.deepEqual(result.failed, ["worker"]);
  const record = await readStatus(root);
  const row = record.steps.find((item) => item.id === "worker");
  assert.equal(row.attempts, 0, "the status record says no attempt ran");
  assert.match(row.command, /working directory not recorded/, row.command);
  assert.ok(row.lockFallback, "the fallback marker survives into the status record");
  assert.match(row.lockFallback.fallbackFailure, /Connection refused/);
  assert.ok(row.rerun, "the record carries the pasteable re-run instruction");
  assert.match(row.rerun, /working directory was not recorded/, row.rerun);
  assert.ok(!/^cd /m.test(row.rerun), "no cd line is invented when the directory is unknown");
  const text = diagnosticsText(record);
  assert.match(text, /attempted the reviewed lockfile fallback, which did not install this step/, text);
  assert.ok(!/installed through a lockfile fallback/.test(text), text);
  assert.match(text, /^    To re-run this step yourself, use a UTF-8 terminal:/m, "the instruction is printed as its own lines in the copied diagnostics");

  // Once the layer below carries the directory, the same record names it instead of apologising.
  backend.runProcess = refuses(true);
  await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "recommended", stepIds: ["worker"], services: backend });
  const named = (await readStatus(root)).steps.find((item) => item.id === "worker");
  assert.match(named.command, /\(in /, named.command);
  assert.ok(!/working directory not recorded/.test(named.command), named.command);
  assert.match(named.rerun, /^cd '/m, named.rerun);
});

test("a carried step keeps its lockfile fallback marker in a retry record (D2 support)", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const first = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "recommended", stepIds: ["worker"], services: services(root) });
  assert.equal(first.outcome, "success");
  const workerDirectory = path.join(root, WORKER_FOLDER);
  const receipt = await readReceipt(workerDirectory);
  receipt.steps.worker.lockFallback = { detectedAt: "2026-11-03T09:06:02.825Z", problems: [], uvMessage: "error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided." };
  await writeReceipt(workerDirectory, receipt);
  await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "recommended", stepIds: ["research-overlay"], services: services(root) });
  const record = await readStatus(root);
  const carried = record.steps.find((item) => item.id === "worker");
  assert.equal(carried.carried, true);
  assert.ok(carried.lockFallback, "a step installed through the fallback is still marked as such after a retry");
  assert.match(outcomeLine(record).line, /installed through a lockfile fallback/, outcomeLine(record).line);
});

test("D7 success half: a step that ran two uv processes records 2 attempts, not 1 (receipts/13)", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder] });
  const backend = services(root);
  const syncCalls = [];
  // The runner's own success shape: `attempts` is how many processes the step started, so a locked
  // attempt plus the reviewed --frozen fallback reports 2 (runner.js returns the same field).
  backend.runProcess = async (executable, args, options = {}) => {
    if (args[0] !== "sync") return { ok: true, stdout: await backend.runFile(executable, args, options), stderr: "", exitCode: 0, durationMs: 1, attempts: 1, command: executable, args, cwd: options.cwd || "" };
    syncCalls.push(args[1]);
    const stdout = await backend.runFile(executable, args, options);
    return { ok: true, stdout, stderr: "", exitCode: 0, durationMs: 1, attempts: 2, command: executable, args, cwd: options.cwd || "" };
  };
  const result = await runPlan({ vscode: harness.vscode, context: harness.context, folder, packageId: "recommended", stepIds: ["worker"], services: backend });
  assert.equal(result.outcome, "success", JSON.stringify(result.statusRecord.steps.map((row) => [row.id, row.status, row.attempts])));
  const row = result.statusRecord.steps.find((item) => item.id === "worker");
  assert.equal(row.attempts, 2, "the run record's real count is what the status record shows");
  assert.match(stepRow(row).statusText, /installed · 2 attempts/, stepRow(row).statusText);
  assert.equal((await readStatus(root)).steps.find((item) => item.id === "worker").attempts, 2, "and it survives into the record the panel reads back");
});

test("a refusal raised by the reviewed tool policy is answered as a build defect, not as a retry (DD7-12)", () => {
  // runner.js refuses `uv lock` and a plain `uv sync` before starting anything (kind "policy").
  // Falling through to "Retry this step" would tell the operator to press the same button on a
  // sentence that only this build could have produced.
  const error = {
    kind: "policy", exitCode: null, attempts: 0, cwd: "/ws/.research-toolkit/managed/worker-0.3.7",
    command: "/host/uv", args: ["lock", "--check"],
    message: "uv lock was refused before it ran: the toolkit never runs `uv lock` in a managed runtime (cwd /ws). No process was started.",
  };
  const action = nextActionFor(error, { id: "worker", label: "Isolated locked worker (Python 3.12)" });
  assert.match(action, /reviewed policy refuses/);
  assert.match(action, /Reinstall the VSIX from this release/);
  assert.ok(!/Retry this step/.test(action), action);
  // The other failure classes keep their own answers; a policy refusal must not crowd them out.
  assert.match(nextActionFor({ kind: "spawn", message: "x" }, {}), /researchStack\.uvPath/);
  assert.match(nextActionFor({ kind: "timeout", message: "x" }, {}), /setupTimeoutSeconds/);
  assert.match(nextActionFor({ kind: "buffer", message: "x" }, {}), /more output than the toolkit captures/);
  assert.match(nextActionFor({ kind: "cwd", message: "x" }, {}), /workspace folder/);
  assert.match(nextActionFor({ kind: "cancelled", message: "x" }, {}), /resume where this run stopped/);
  assert.match(nextActionFor({ kind: "exit", hint: "Named answer", message: "x" }, {}), /Named answer/);
});
