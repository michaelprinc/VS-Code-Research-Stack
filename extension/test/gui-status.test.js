"use strict";
/**
 * 0.3.6 installation status in the GUI: the panel must name the outcome of a component setup,
 * show which step failed and why, offer retry / lock clearing / the log, and read the verdict
 * back from the workspace when the panel is reopened.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { makeHarness } = require("./harness");
const { controlPanelHtml } = require("../ui");
const { WORKER_FOLDER } = require("../runtime");
const { readStatus, readLog, paths } = require("../setuplog");
const { lockPath } = require("../preflight");
const TOOLKIT_VERSION = require("../package.json").version;

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-gui-status-test-"));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, folder: { name: "Research Status", uri: { scheme: "file", fsPath: root } } };
}

/** Fake runner that leaves the artefacts the reviewed steps check for, or fails like a real uv error. */
function services(root, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    async findHostTool(name) { return name === "uv" ? "/trusted/uv" : undefined; },
    async runFile(executable, args, options) {
      calls.push({ executable, args });
      if (args[0] === "sync") {
        const project = args[args.indexOf("--project") + 1];
        if (fail) throw new Error("Command failed: uv sync failed with exit code 2: error: failed to download ipykernel from pypi.org");
        const python = path.join(project, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
        await fs.mkdir(path.dirname(python), { recursive: true });
        await fs.writeFile(python, "fixture interpreter");
        return "";
      }
      if (args[0] === "--version") return "uv 0.7.3";
      if (args[2].endsWith("probe.py")) return JSON.stringify({ python: "3.12.99", packages: {}, recommended: true, full: true, lab: true });
      if (args.slice(0, 3).join(" ") === "-I -B -c") return "3.12.99 (fixture, main)";
      assert.ok(args[2].endsWith("functional_check.py"));
      const surface = (module, names) => ({ module, toolCount: names.length, characters: 400 * names.length, tokensEstimate: 140 * names.length, tools: names.map((name) => ({ name, title: name, characters: 400, tokensEstimate: 140 })) });
      return JSON.stringify({
        ok: true, pdfRead: true, docxRead: true, lexicalSearch: true, researchAdapter: true, corpusIndex: false, recordStore: false, externalProvidersChecked: false,
        toolSurface: { basis: "measured", servers: [surface("research_stack.mcp_server", ["read_document", "read_text_source", "search_local_text", "write_markdown", "write_docx"]),
          surface("research_stack.recommended_server", ["search_literature", "check_citation", "zotero_collections", "zotero_item", "prepare_zotero_import"])], toolCount: 11, characters: 4400, tokensEstimate: 1540 },
      });
    },
  };
}

async function openPanel(harness) {
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "ready" });
  return panel;
}

test("the panel names the outcome of a component setup and shows the failing step (T6-15, T6-16, T6-20)", async (t) => {
  const { root, folder } = await fixture(t);
  const backend = services(root, { fail: true });
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: backend });
  const panel = await openPanel(harness);
  assert.equal(panel.messages.at(-1).installation.outcome, "not-run");
  assert.match(panel.messages.at(-1).installation.line, /No component setup has run in this workspace yet/);

  await panel.receive({ type: "setup", steps: ["worker", "research-overlay"] });
  const state = harness.api.state();
  assert.equal(state.installation.outcome, "partial", "a failed step is never reported as a success, even when an independent step succeeded");
  assert.match(state.installation.line, /^Installation incomplete — 1 step\(s\) verified, 1 need attention \(Isolated locked worker/, state.installation.line);
  assert.match(state.installation.problem.label, /Isolated locked worker/, "the problem line names the failing step");
  assert.match(state.installation.problem.detail, /failed to download ipykernel/, "the problem line carries the captured error text");
  const row = state.installation.steps.find((step) => step.id === "worker");
  assert.equal(row.status, "failed");
  assert.match(row.statusText, /failed/, row.statusText);
  assert.match(row.error, /uv sync failed with exit code 2/, "the step row carries the error, not only a colour");
  assert.equal(state.installation.steps.find((step) => step.id === "research-overlay").status, "installed", "the overlay needs no interpreter, so a worker failure does not block it");
  assert.match(state.installation.problem.action, /Retry/, "the card names the action that continues the install");
  assert.match(state.readiness, /1 of 3 component steps installed/, "the sidebar agrees with the card");
  assert.match(harness.output.lines.join("\n"), /Component setup partial in /, "the output channel states the same outcome");
  assert.match(harness.output.lines.join("\n"), /failed: worker/, "the output channel names what failed, instead of calling a failed run current");

  const html = panel.webview.html;
  for (const id of ["install-status", "install-outcome", "install-steps", "install-problem", "retry-button"]) {
    assert.ok(html.includes(`id="${id}"`), `the panel renders #${id}`);
  }
  for (const action of ["clearLock", "setupLog", "copySetup"]) {
    assert.ok(html.includes(`data-action="${action}"`), `the panel offers ${action}`);
  }
  const controls = await fs.readFile(path.join(__dirname, "..", "media", "controls.js"), "utf8");
  assert.match(controls, /outcome/, "the webview script renders the outcome, not only the step list");

  const status = await readStatus(root);
  assert.equal(status.outcome, "partial", "the record on disk agrees with the card the user was shown");
  assert.equal(status.toolkitVersion, TOOLKIT_VERSION);
  const log = await readLog(root);
  assert.ok(log.files.length >= 1, "the attempt is recorded on disk");
  assert.match(JSON.stringify(log.lines), /Synthetic|failed to download/, "the log holds the attempt that the card shows");
});

test("host-tool resolution is visible before a setup is attempted (R6-07)", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: services(root) });
  const panel = await openPanel(harness);
  const inventory = await harness.registered.get("researchToolkit.checkComponents")();
  const uv = (inventory.items || inventory.components).find((item) => item.id === "uv");
  assert.equal(uv.location, "/trusted/uv", "the check names the resolved path before any component runs");
  assert.match(uv.evidence, /Resolved from/, uv.evidence);
  assert.equal(uv.minimumVersion, "0.5.0", "the registry minimum is reported with the finding");
  assert.equal(harness.api.state().installation.outcome, "not-run", "the check ran no component step");
});

test("the setup log and status record carry tool evidence, never research document text (R6-22, R6-26)", async (t) => {
  const { root, folder } = await fixture(t);
  await fs.mkdir(path.join(root, "papers"), { recursive: true });
  const secret = "The patient reported a marked improvement in the second trial arm.";
  await fs.writeFile(path.join(root, "papers", "trial.md"), `# Trial\n\n${secret}\n`, "utf-8");
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: services(root, { fail: true }) });
  const panel = await openPanel(harness);
  await panel.receive({ type: "setup", steps: ["worker"] });
  const log = await readLog(root);
  const status = await readStatus(root);
  const text = JSON.stringify(log.lines) + JSON.stringify(status);
  assert.ok(!text.includes(secret), "setup evidence never copies workspace research text");
  assert.ok(!text.includes("trial arm"), text.slice(0, 200));
  const reviewedLogKeys = new Set(["kind", "stepId", "status", "error", "hint", "at", "durationMs", "exitCode", "attempts", "artifactsVerified", "package", "blockers", "ran", "skipped", "repaired", "failed", "blocked"]);
  const reviewedStatusKeys = new Set(["schemaVersion", "outcome", "package", "toolkitVersion", "workspaceFolder", "startedAt", "finishedAt", "durationMs", "steps", "preflight", "hostTools", "lock", "logFile", "statusFile", "packageSteps"]);
  const logKeys = new Set();
  for (const entry of log.lines) for (const key of Object.keys(entry.record)) logKeys.add(key);
  assert.ok([...logKeys].every((key) => reviewedLogKeys.has(key)), `unexpected log field: ${[...logKeys].filter((key) => !reviewedLogKeys.has(key)).join(", ")}`);
  assert.ok([...logKeys].sort().includes("stepId") && [...logKeys].includes("status"), "the log names the step and its outcome");
  assert.ok(Object.keys(status).every((key) => reviewedStatusKeys.has(key)), `unexpected status field: ${Object.keys(status).filter((key) => !reviewedStatusKeys.has(key)).join(", ")}`);
  assert.match(status.steps[0].error, /uv sync failed/, "the failure text an operator needs is kept");
});

test("Installation complete appears only when the recorded steps' artefacts are verified (T6-17, T6-24)", async (t) => {
  const { root, folder } = await fixture(t);
  const backend = services(root);
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: backend });
  const panel = await openPanel(harness);
  await panel.receive({ type: "setup", steps: ["worker", "research-overlay"] });
  const state = harness.api.state();
  assert.equal(state.installation.outcome, "success");
  assert.match(state.installation.line, /^Installation complete — 2 component step\(s\) verified\. 2 of 3 package steps are installed in this workspace\.$/,
    "a record made from a partial selection says how much of the package it covers");
  assert.deepEqual(state.installation.steps.map((step) => step.status), ["installed", "installed"]);
  assert.match(state.installation.steps[0].artifactsText, /\d+ file\(s\) verified/, "a verified step says its files were checked");
  assert.ok(state.installation.hostTools.some((tool) => tool.name === "uv" && tool.path === "/trusted/uv"), "the host tool the setup used is named");
  assert.equal(state.installation.preflight.ok, true);
  assert.ok(state.installation.preflight.checks.some((check) => check.id === "host-tool-uv" && check.status === "ok"));

  await fs.rm(path.join(root, "research", "README.md"));
  const refreshed = await harness.registered.get("researchToolkit.refreshComponentStatus")();
  assert.match(refreshed, /research-overlay/, "a recorded step whose produced file disappeared is reported, not hidden");
  assert.match(refreshed, /missing|re-run/, refreshed);
});

test("the verdict is read back from the workspace when the panel reopens, without re-running setup (T6-25)", async (t) => {
  const { root, folder } = await fixture(t);
  const backend = services(root);
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: backend });
  const panel = await openPanel(harness);
  await panel.receive({ type: "setup", steps: ["worker", "research-overlay"] });
  const callsAfterSetup = backend.calls.length;
  panel.close();

  const reopened = await openPanel(harness);
  const installation = reopened.messages.at(-1).installation;
  assert.equal(installation.outcome, "success", "the verdict survives the panel closing");
  assert.match(installation.line, /Installation complete — 2 component step\(s\) verified/, installation.line);
  assert.notEqual(installation.attemptedAt, "not recorded", "the card says when the setup ran");
  assert.match(installation.workspaceFolder, /Research Status/);
  assert.equal(backend.calls.length, callsAfterSetup, "reopening the panel runs no component command");
  assert.ok(installation.logFiles.length >= 1, "the card points at the log file it read");
});

test("Retry failed component steps re-runs only what failed and turns the verdict green (T6-19, T6-21)", async (t) => {
  const { root, folder } = await fixture(t);
  const broken = services(root, { fail: true });
  const first = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: broken });
  const panel = await openPanel(first);
  await panel.receive({ type: "setup", steps: ["worker", "notebook-env"] });
  assert.equal(first.api.state().installation.outcome, "failed", "nothing was verified, so the verdict is a failure");
  assert.equal(first.api.state().installation.steps.find((step) => step.id === "notebook-env").status, "blocked", "the dependent step is blocked, not skipped");
  const failedCalls = broken.calls.length;

  const fixed = services(root);
  const second = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: fixed });
  const run = await second.registered.get("researchToolkit.retryFailedSteps")();
  assert.deepEqual(run.ran, ["worker", "notebook-env"], "the failed step and the step blocked by it are retried together");
  assert.equal(run.outcome, "success", "the retry turns the verdict green");
  assert.deepEqual(run.failed, []); assert.deepEqual(run.blocked, []);
  assert.equal(second.api.state().installation.outcome, "success");
  assert.equal(await second.registered.get("researchToolkit.retryFailedSteps")(), undefined, "a second retry says there is nothing to retry instead of re-running the plan");
  assert.match(second.events.messages.at(-1).text, /Nothing to retry/);
  assert.equal(broken.calls.length, failedCalls, "the retry uses the current services, not the broken ones");
  const log = await readLog(root);
  const attempts = log.lines.filter((entry) => entry.record.stepId === "worker");
  assert.ok(attempts.length >= 2, "both the failed and the successful attempt stay in the log");
  assert.deepEqual(attempts.map((entry) => entry.record.status), ["failed", "installed"]);
  const stored = await readStatus(root);
  assert.equal(stored.steps.find((step) => step.id === "worker").status, "installed");
});

test("the panel opens the setup log and copies the diagnostics an operator can paste (T6-26, T6-28)", async (t) => {
  const { root, folder } = await fixture(t);
  const backend = services(root, { fail: true });
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: backend });
  const panel = await openPanel(harness);
  await panel.receive({ type: "setup", steps: ["worker"] });

  const target = await harness.registered.get("researchToolkit.openSetupLog")();
  assert.ok(target.startsWith(paths(root).directory), "the log opened is inside the workspace");
  assert.equal(harness.events.shownDocument, target, "the log is shown as a document, not only mentioned");

  const text = await harness.registered.get("researchToolkit.copyInstallationDiagnostics")();
  assert.equal(harness.events.clipboard, text);
  assert.match(text, new RegExp(`^Research Stack component setup — Installation failed`));
  assert.match(text, new RegExp(`Toolkit: ${TOOLKIT_VERSION}`));
  assert.match(text, /uv: .* at \/trusted\/uv|uv: not found/, "the host tool state is part of the diagnostics");
  assert.match(text, /Isolated locked worker \(Python 3\.12\) \(worker\): failed/);
  assert.match(text, /next action: /, "the copied text names what to do next");
  assert.match(harness.output.lines.join("\n"), /Setup log file: /);

  const empty = await makeHarness({ folders: [folder], initial: { selectedPackage: "basic" }, diagnosticServices: services(root) });
  await fs.rm(paths(root).directory, { recursive: true, force: true });
  await assert.rejects(empty.registered.get("researchToolkit.openSetupLog")(), /No setup log exists/, "a workspace with no setup says so instead of opening nothing");
});

test("an interrupted setup lock is reported and cleared from the panel (T6-11)", async (t) => {
  const { root, folder } = await fixture(t);
  const lock = lockPath(root);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, JSON.stringify({ pid: 2_147_483_646, startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() }));
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: services(root) });
  const panel = await openPanel(harness);
  await panel.receive({ type: "action", action: "clearLock" });
  await assert.rejects(fs.lstat(lock), { code: "ENOENT" }, "the panel action removed the interrupted lock");
  assert.match(harness.events.messages.map((item) => item.text).join("\n"), /Removed the interrupted setup lock/);
  assert.match(harness.output.lines.join("\n"), /Removed the interrupted setup lock/);
  const again = await harness.registered.get("researchToolkit.clearSetupLock")();
  assert.equal(again.removed, false, "a second clear reports that there is nothing to clear");
  assert.match(again.message, /No setup lock exists/);
  await panel.receive({ type: "setup", steps: ["worker"] });
  assert.equal(harness.api.state().installation.outcome, "success", "the workspace is installable again after the interrupted lock is cleared");
});

test("a blocked preflight is named in the GUI before any component command runs (T6-12, R6-18)", async (t) => {
  const { root, folder } = await fixture(t);
  const backend = services(root);
  const harness = makeHarness({
    folders: [folder], initial: { selectedPackage: "recommended" },
    diagnosticServices: { ...backend, findHostTool: async () => undefined },
  });
  const panel = await openPanel(harness);
  await panel.receive({ type: "setup", steps: ["worker", "research-overlay"] });
  const state = harness.api.state();
  assert.equal(state.installation.outcome, "blocked");
  assert.match(state.installation.line, /^Setup blocked — /, state.installation.line);
  assert.match(state.installation.problem.detail, /uv was not found/, state.installation.problem.detail);
  assert.match(state.installation.problem.action, /researchStack\.uvPath|Install uv/, state.installation.problem.action);
  assert.equal(backend.calls.length, 0, "nothing was executed when a prerequisite was missing");
  const status = await readStatus(root);
  assert.equal(status.outcome, "blocked");
  assert.deepEqual(status.preflight.blockers, ["host-tool-uv"]);
  assert.deepEqual(state.installPlan.missing, ["worker", "research-overlay"], "the plan still shows what is unmet");
});

/** The panel markup the webview gets, rendered without a browser. */
function panelMarkup() {
  const webview = { cspSource: "https://toolkit.test", asWebviewUri: (value) => String(value) };
  return controlPanelHtml(webview, "https://toolkit.test/extension", { joinPath: (base, ...parts) => [base, ...parts].join("/") });
}

/** Every control the panel renders with a data-action, with the id it carries. */
function renderedActions(html) {
  const items = [];
  for (const tag of html.matchAll(/<(button|input|select|a)\b([^>]*)>/g)) {
    const action = /data-action="([^"]+)"/.exec(tag[2]);
    if (!action) continue;
    const id = /id="([^"]+)"/.exec(tag[2]);
    items.push({ action: action[1], id: id ? id[1] : null });
  }
  return items;
}

function cssRule(css, selector) {
  return css.split("\n").find((line) => line.startsWith(`${selector} {`)) || null;
}

/** WCAG relative-luminance contrast, so a colour in the stylesheet is measured instead of claimed. */
function contrastRatio(one, two) {
  const channel = (hex, index) => {
    const value = parseInt(hex.slice(index, index + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  const luminance = (hex) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const [brighter, darker] = [luminance(one), luminance(two)].sort((a, b) => b - a);
  return (brighter + 0.05) / (darker + 0.05);
}

test("every action the panel renders is wired in the webview and accepted by the host (0.3.6 inert-button regression)", async (t) => {
  const html = panelMarkup();
  const rendered = renderedActions(html);
  assert.ok(rendered.length >= 12, `the panel should render its action controls, found ${rendered.length}`);
  const controls = await fs.readFile(path.join(__dirname, "..", "media", "controls.js"), "utf8");
  const host = await fs.readFile(path.join(__dirname, "..", "extension.js"), "utf8");

  // The generic loop must exist, must send the action the button carries, and its only guard is the button id.
  const loop = /document\.querySelectorAll\("\[data-action\]"\)\.forEach\(\((\w+)\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/.exec(controls);
  assert.ok(loop, "controls.js must wire every [data-action] control in one generic loop");
  const parameter = loop[1];
  const body = loop[2];
  const guard = body.split("addEventListener")[0];
  // `dataset?.action` and `dataset.action` are both reads of the action name.
  const datasetAction = "dataset\\??\\.action";
  assert.ok(!new RegExp(`${parameter}\\.${datasetAction}`).test(guard),
    `the generic loop must not skip a control by action name: ${guard.trim()}`);
  assert.match(body, new RegExp(`send\\(\\{ type: "action", action: ${parameter}\\.${datasetAction} \\}\\)`),
    "the generic loop must send the action the button carries");

  // A Set consulted against dataset.action is an exclusion set. In 0.3.6 one named clearLock, setupLog
  // and copySetup, so three card buttons rendered, were clickable, and sent nothing.
  const excluded = new Set();
  for (const set of controls.matchAll(/const (\w+) = new Set\(\[([^\]]*)\]\)/g)) {
    const name = set[1];
    const usedOnAction = new RegExp(`${name}\\.has\\([^)]*${datasetAction}`).test(controls);
    const usedOnId = new RegExp(`${name}\\.has\\([^)]*\\.id\\)`).test(controls);
    if (usedOnAction && !usedOnId) for (const member of set[2].matchAll(/"([^"]+)"/g)) excluded.add(member[1]);
  }
  assert.deepEqual([...excluded], [], "no action name may be excluded from the generic loop");

  // Reachability, per rendered action: a dedicated handler id, a dedicated send literal, or the generic loop.
  const handlerSet = /const dedicatedHandlers = new Set\(\[([^\]]*)\]\)/.exec(controls);
  const dedicatedIds = new Set(handlerSet ? [...handlerSet[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]) : []);
  const dedicatedActions = new Set([...controls.matchAll(/send\(\{ type: "action", action: "([^"]+)" \}\)/g)].map((match) => match[1]));
  for (const item of rendered) {
    const wired = (item.id && dedicatedIds.has(item.id)) || dedicatedActions.has(item.action) || !excluded.has(item.action);
    assert.ok(wired, `#${item.id || item.action}: data-action="${item.action}" is rendered but no handler sends it`);
  }
  for (const action of ["clearLock", "setupLog", "copySetup"]) {
    assert.ok(rendered.some((item) => item.action === action), `the installation card must offer ${action}`);
  }
  assert.ok(dedicatedActions.has("retry"), "#retry-button must send the retry action");

  // The host must accept every action the panel can send, and the command it maps to must exist.
  const block = /const actions = \{([\s\S]*?)\n\s*\};/.exec(host);
  assert.ok(block, "extension.js must name the control-panel actions it accepts");
  const allowed = new Map([...block[1].matchAll(/(\w+):\s*"(researchToolkit\.[A-Za-z]+)"/g)].map((match) => [match[1], match[2]]));
  for (const item of rendered) {
    assert.ok(allowed.has(item.action), `the panel offers data-action="${item.action}" but the host allowlist rejects it`);
  }
  for (const action of dedicatedActions) {
    assert.ok(allowed.has(action), `controls.js sends action "${action}" but the host allowlist rejects it`);
  }
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: services(root) });
  for (const [action, command] of allowed) {
    assert.ok(harness.registered.has(command), `the allowlist maps "${action}" to ${command}, which the extension never registers`);
  }
});

test("the status card announces only its verdict, keeps read-only actions live, and wraps long output (0.3.6 density and accessibility)", async () => {
  const html = panelMarkup();
  const controls = await fs.readFile(path.join(__dirname, "..", "media", "controls.js"), "utf8");
  const css = await fs.readFile(path.join(__dirname, "..", "media", "controls.css"), "utf8");

  // One live region, on the paragraph that states the verdict, labelled by the card heading.
  const cardTag = /<div id="install-status"[^>]*>/.exec(html);
  assert.ok(cardTag, "the panel renders the installation status card");
  assert.ok(!/aria-live/.test(cardTag[0]), `the whole card must not be a live region: ${cardTag[0]}`);
  assert.match(html, /<h3 id="install-status-heading">Installation status<\/h3>/, "the card needs a heading");
  const outcomeTag = /<p id="install-outcome"[^>]*>/.exec(html);
  assert.ok(outcomeTag, "the card renders its outcome paragraph");
  assert.match(outcomeTag[0], /aria-live="polite"/, "the verdict paragraph is the live region");
  assert.match(outcomeTag[0], /aria-labelledby="install-status-heading"/, "and is labelled by the card heading");

  // A step may run for the whole setup timeout; the log and the copied diagnostics must stay clickable.
  for (const action of ["setupLog", "copySetup"]) {
    const tag = new RegExp(`<button[^>]*data-action="${action}"[^>]*>`).exec(html);
    assert.ok(tag, `the card offers ${action}`);
    assert.match(tag[0], /data-readonly="true"/, `${action} must be marked read-only`);
  }
  assert.match(controls, /const isReadOnly = \(control\) => control\.dataset\?\.readonly === "true";/, "controls.js must define read-only");
  const sendBody = /function send\(message\) \{([\s\S]*?)\n  \}/.exec(controls);
  assert.ok(sendBody && /if \(isReadOnly\(control\)\) return;/.test(sendBody[1]), "the send-time disable sweep must skip read-only controls");
  assert.match(controls, /function applyControlAvailability\(\) \{[\s\S]*?if \(isReadOnly\(control\)\) \{[\s\S]*?control\.disabled = false;/,
    "the busy re-enable sweep must keep read-only controls enabled");
  assert.equal((controls.match(/applyControlAvailability\(\);/g) || []).length, 2, "state and result messages re-enable controls through one sweep");
  assert.ok(!/control\.disabled = Boolean\(busy\)/.test(controls), "no sweep may disable every control again");

  // A control that is unavailable stays in the Tab order and says why.
  assert.match(controls, /control\.setAttribute\("aria-disabled", "true"\)/, "a disabled control is announced as disabled");
  assert.match(controls, /function markUnavailable\(control, reason\)/, "unavailability carries a reason");
  assert.match(controls, /control\.title = reason/, "and the reason is readable as a title");

  // Long tool output is collapsed to a summary with the full text one click away, not repeated three times.
  assert.match(controls, /const ERROR_PREVIEW_CHARS = 200;/, "the step row shows a bounded summary");
  assert.match(controls, /document\.createElement\("details"\)/, "the full error sits inside a details element");
  assert.ok(!/step\.error \? ` · \$\{step\.error\}`/.test(controls), "the error is not repeated in the step row as well as the summary");

  // Long unbroken tokens must not widen a 380 px sidebar.
  for (const selector of [".install-status", ".install-status .outcome", ".install-status .problem", ".attempt-list", ".attempt"]) {
    const rule = cssRule(css, selector);
    assert.ok(rule, `${selector} must have a rule in controls.css`);
    assert.match(rule, /overflow-wrap: anywhere/, `${selector} must wrap anywhere`);
  }

  // Success green must clear 4.5:1 for 13 px text on the dark editor background.
  const successRule = cssRule(css, '.install-status .outcome[data-outcome="success"]');
  assert.ok(successRule, "the success outcome needs its own rule");
  const success = /color: var\((--vscode-[A-Za-z-]+), (#[0-9a-fA-F]{6})\)/.exec(successRule);
  assert.ok(success, "the success outcome must name a theme token and a literal fallback");
  assert.notEqual(success[1], "--vscode-charts-green", "charts-green is 3.86:1 on #1e1e1e, below 4.5:1 for 13 px text");
  const ratio = contrastRatio(success[2], "#1e1e1e");
  assert.ok(ratio >= 4.5, `${success[2]} is ${ratio.toFixed(2)}:1 on #1e1e1e, below 4.5:1`);
});

test("the card names the live setup lock and the status record it read (payload -> evidence line)", async (t) => {
  const { root, folder } = await fixture(t);
  const harness = makeHarness({ folders: [folder], initial: { selectedPackage: "recommended" }, diagnosticServices: services(root) });
  const panel = await openPanel(harness);

  const before = harness.api.state().installation;
  assert.ok(before.lock && typeof before.lock.state === "string", "the host sends the live setup-lock state to the card");
  assert.equal(before.lock.state, "free", "a workspace with no setup has no lock");
  assert.equal(before.statusFile, null, "there is no status record before a setup has run");

  await panel.receive({ type: "setup", steps: ["worker"] });
  await harness.registered.get("researchToolkit.refresh")();
  const after = harness.api.state().installation;
  assert.equal(after.statusFile, path.join(path.resolve(root), ".research-toolkit", "logs", "last-setup.json"),
    "the card is given the status record it read, by full path");
  assert.equal(after.lock.state, "free", "a finished setup releases the lock");

  const lock = lockPath(root);
  await fs.mkdir(path.dirname(lock), { recursive: true });
  await fs.writeFile(lock, JSON.stringify({ pid: 2_147_483_646, startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() }));
  await harness.registered.get("researchToolkit.refresh")();
  const interrupted = harness.api.state().installation.lock;
  assert.equal(interrupted.state, "stale", "an interrupted setup is visible in the payload, not only after a button press");
  assert.ok(interrupted.reason && interrupted.ageMs > 0, "the payload carries why the lock is stale");

  // The card's own wording, run without a browser from the shipped evidenceLine().
  const controls = await fs.readFile(path.join(__dirname, "..", "media", "controls.js"), "utf8");
  const fn = /function evidenceLine\(\) \{[\s\S]*?\n  \}/.exec(controls);
  assert.ok(fn, "controls.js must build the evidence line in one function");
  const labels = /const LOCK_TEXT = \{[\s\S]*?\n  \};/.exec(controls);
  assert.ok(labels, "each lock state needs a plain-language label");
  const render = (payload) => {
    const element = { title: "" };
    const line = new Function("installation", "document", `${labels[0]}\n${fn[0]}\nreturn evidenceLine();`)(payload, { getElementById: () => element });
    return { line, title: element.title };
  };

  const live = render({
    logFiles: ["setup-20261101T140000Z.jsonl"],
    statusFile: "/research/.research-toolkit/logs/last-setup.json",
    lock: { state: "stale", path: "/research/.research-toolkit/.setup.lock", reason: "older than the 15 minute setup window", ageMs: 1_200_000, ownerPid: 4242 },
    preflight: { checks: [{ id: "setup-lock", status: "ok", detail: "No setup is running." }] },
  });
  assert.match(live.line, /Setup lock: interrupted lock left behind/, "the live lock state is what the card shows");
  assert.match(live.line, /Status record: \/research\/\.research-toolkit\/logs\/last-setup\.json/, "and it names the status record");
  assert.match(live.title, /older than the 15 minute setup window/, "the reason is readable");
  assert.match(live.title, /pid 4242/, "with the owning process");

  assert.match(render({ lock: { state: "held", path: "/r/.setup.lock", reason: "held by the running process 99", ownerPid: 99 } }).line,
    /Setup lock: held by a running setup/);
  assert.match(render({ lock: { state: "free", path: "/r/.setup.lock" } }).line, /Setup lock: no setup lock/);
  assert.match(render({ lock: { state: "invalid", path: "/r/.setup.lock", reason: "not a regular file" } }).line,
    /Setup lock: the lock path is not a file/);
  assert.match(render({ lock: { state: "n-a", path: null } }).line, /Setup lock: no local workspace to inspect/);

  // Only when the payload has no live lock may the card fall back to the recorded preflight check.
  const fallback = render({ preflight: { checks: [{ id: "setup-lock", status: "warn", detail: "/r/.setup.lock is stale.", action: "Clear it." }] } });
  assert.match(fallback.line, /Setup lock: interrupted lock left behind/, "the recorded check is the fallback");
  assert.match(fallback.title, /Setup lock at the last setup/, "and the title says it is the recorded state");
  assert.match(render({}).line, /Setup lock: not reported/, "with neither, the card says it does not know");

  const lockFirst = fn[0].indexOf("installation.lock");
  const preflightFirst = fn[0].indexOf("installation.preflight");
  assert.ok(lockFirst >= 0 && preflightFirst > lockFirst, "the live lock must be read before the recorded preflight check");

  // Every state preflight.js can report must have a label in the card.
  const preflight = await fs.readFile(path.join(__dirname, "..", "preflight.js"), "utf8");
  const states = new Set([...preflight.matchAll(/state: "([a-z-]+)"/g)].map((match) => match[1]));
  assert.ok(states.size >= 4, `preflight.js reports lock states, found ${[...states]}`);
  for (const state of states) {
    assert.match(labels[0], new RegExp(`"?${state}"?:`), `the card must explain lock state "${state}"`);
  }
});
