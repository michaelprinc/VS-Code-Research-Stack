"use strict";

/**
 * Package-aware component plan engine.
 *
 * This module decides *what* runs and *in which order*, verifies what a step produced, keeps the
 * workspace receipt, and records every attempt. The step bodies live in `steps.js`, process
 * execution in `runner.js`, host executable lookup in `hosttools.js`, pre-execution checks in
 * `preflight.js`, and the verdict wording in `status.js`.
 *
 * 0.3.6 change: a failing step no longer aborts the plan. Independent steps continue, dependents
 * are reported as blocked, and the outcome is recorded so the GUI can say what happened.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const catalog = require("./components.json");
const { bundle, directory, isReparsePoint, managedRuntime, setupRuntime, WORKER_FOLDER, MANAGED_FOLDER, discoverRuntimes, acquireSetupLock } = require("./runtime");
const { runStep, inspectNotebookProject, writeOverlayFiles, overlayEvidence, overlayStepFor, NOTEBOOK_PROJECT_NAME, NOTEBOOK_DEPENDENCIES } = require("./steps");
const { runPreflight, clearStaleLock, setupWindowMs } = require("./preflight");
const { appendRecord, writeStatus, readStatus, readLog, paths: logPaths } = require("./setuplog");
const { outcomeOf, outcomeLine } = require("./status");

const STEPS_BY_ID = new Map(catalog.installSteps.map((step) => [step.id, step]));
const COMPONENTS_BY_ID = new Map(catalog.components.map((item) => [item.id, item]));
const RECEIPT_NAME = "installation.json";

/** Ordered step objects a package needs. Unknown packages resolve to no steps. */
function stepsForPackage(packageId) {
  const declaration = catalog.packages[packageId];
  if (!declaration) return [];
  return declaration.steps.map((id) => STEPS_BY_ID.get(id)).filter(Boolean);
}

function packageDeclaration(packageId) {
  return catalog.packages[packageId] || null;
}

/** Steps a package offers that a component selection needs, in plan order. */
function stepsForComponents(packageId, componentIds) {
  const wanted = new Set(componentIds);
  const offered = stepsForPackage(packageId);
  const selected = new Set();
  for (const step of offered) {
    if (!step.components.some((id) => wanted.has(id))) continue;
    selected.add(step.id);
    for (const prerequisite of step.prerequisites || []) selected.add(prerequisite);
  }
  return offered.filter((step) => selected.has(step.id));
}

/**
 * Resolve a GUI/Quick Pick step selection against the package plan.
 *
 * One resolver serves every entry point. A selection is expanded to its full dependency closure in
 * plan order instead of failing on a prerequisite the operator did not think to tick.
 */
function resolveStepSelection(packageId, requested) {
  const offered = stepsForPackage(packageId);
  const offeredIds = new Set(offered.map((step) => step.id));
  if (requested === undefined || requested === null) return offered.map((step) => step.id);
  if (!Array.isArray(requested) || requested.some((id) => typeof id !== "string")) throw new TypeError("Component steps must be a list of step ids.");
  const unknown = requested.filter((id) => !offeredIds.has(id));
  if (unknown.length) throw new TypeError(`These component steps are not offered by the selected package: ${unknown.join(", ")}.`);
  const selected = new Set(requested);
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...selected]) {
      const step = STEPS_BY_ID.get(id);
      for (const prerequisite of step.prerequisites || []) {
        if (!offeredIds.has(prerequisite) || selected.has(prerequisite)) continue;
        selected.add(prerequisite);
        changed = true;
      }
    }
  }
  return offered.filter((step) => selected.has(step.id)).map((step) => step.id);
}

/** The same resolution with the reason each extra step was pulled in. */
function explainStepSelection(packageId, requested) {
  const steps = resolveStepSelection(packageId, requested);
  const requestedIds = new Set(Array.isArray(requested) ? requested : steps);
  return {
    steps,
    added: steps.filter((id) => !requestedIds.has(id)).map((id) => ({
      id,
      label: STEPS_BY_ID.get(id).label,
      reason: `Required by ${steps.filter((other) => (STEPS_BY_ID.get(other).prerequisites || []).includes(id)).join(", ")}.`,
    })),
  };
}

function readReceipt(workerDirectory) {
  return (async () => {
    try {
      const receiptPath = path.join(workerDirectory, RECEIPT_NAME);
      if ((await fs.lstat(receiptPath)).isSymbolicLink()) throw new Error("Setup receipt must not be a link.");
      const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
      return receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt : null;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  })();
}

async function writeReceipt(workerDirectory, receipt) {
  const receiptPath = path.join(workerDirectory, RECEIPT_NAME);
  await fs.mkdir(workerDirectory, { recursive: true });
  try {
    if ((await fs.lstat(receiptPath)).isSymbolicLink()) throw new Error("Setup receipt must not be a link.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // A half-written receipt used to make an installed package look uninstalled.
  const payload = JSON.stringify(receipt, null, 2) + "\n";
  JSON.parse(payload);
  // The temporary name is unique per write, and a leftover from a killed process is cleared first,
  // so a crash cannot poison the next attempt with EEXIST.
  const temporary = path.join(workerDirectory, `${RECEIPT_NAME}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    await fs.rm(temporary, { force: true });
    await fs.writeFile(temporary, payload, { flag: "wx" });
    await fs.rename(temporary, receiptPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return receiptPath;
}

/** Append to the attempt log, but never let a log failure abort a run that already happened. */
async function safeAppend(root, record) {
  try { return await appendRecord(root, record); } catch { return null; }
}

/** A run that never started: recorded so the panel shows a verdict instead of silence. */
async function blockedRun({ root, packageId, manifest, workerDirectory, selected, preflight, reason }) {
  const record = {
    outcome: "blocked", package: packageId, toolkitVersion: manifest.workerVersion,
    workspaceFolder: (root && path.basename(root)) || "workspace", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    durationMs: 0, steps: [], preflight: { ok: false, checks: preflight.checks, blockers: preflight.blockers },
    hostTools: preflight.hostTools || [], lock: preflight.lock || null,
  };
  record.logFile = logPaths(root).statusFile;
  let statusFile = null;
  try {
    statusFile = await writeStatus(root, record);
    await appendRecord(root, { kind: "plan", status: "blocked", package: packageId, blockers: preflight.blockers, reason: reason || preflight.blockers, at: record.startedAt });
  } catch (error) {
    // A status record that cannot be written is reported, not swallowed: the run still has a verdict.
    record.recordError = error.message;
  }
  if (statusFile) record.logFile = statusFile;
  return {
    receipt: {}, ran: [], skipped: [], repaired: [], blocked: selected.map((id) => id), failed: [], selected,
    outcome: "blocked", preflight, statusRecord: record, worker: workerDirectory, blockedPreflight: true,
  };
}

/** Observe what the step actually produced on disk. A receipt alone is not proof. */
async function verifyStepArtifacts(step, root, manifest) {
  const missing = [];
  const observed = [];
  const exists = async (relative, file = true) => {
    const target = path.join(root, relative);
    try {
      const link = await fs.lstat(target);
      if (link.isSymbolicLink()) {
        // uv links `.venv/bin/python` to its managed base interpreter even with copy link mode.
        // Reading through that link is not a write risk, so it counts as evidence when it resolves
        // to a real file; a link that resolves to nothing, or to a directory, is not evidence.
        const resolved = await fs.stat(target).catch(() => null);
        if (!resolved || !resolved.isFile()) { missing.push(`${relative} (link does not resolve to a file)`); return false; }
        observed.push(relative);
        return true;
      }
      const info = file ? await fs.stat(target) : link;
      if (file && !info.isFile()) { missing.push(relative); return false; }
      observed.push(relative);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") { missing.push(relative); return false; }
      // A verification failure is not proof of absence, and it must never read as success.
      missing.push(`${relative} (could not be checked: ${error.code || "verification error"})`);
      return false;
    }
  };
  if (step.id === "worker") {
    await exists(`${WORKER_FOLDER}/src/research_stack/mcp_server.py`);
    await exists(`${WORKER_FOLDER}/${process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"}`);
  } else if (step.id === "lab-store") {
    await exists(".research-toolkit/store/research.sqlite3");
  } else if (step.id === "notebook-env") {
    await exists("notebooks/analysis/pyproject.toml");
    await exists(`notebooks/analysis/${process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python"}`);
  } else if (step.id === "research-overlay") {
    const files = manifest ? Object.keys(manifest.overlayFiles || {}) : null;
    if (files) {
      for (const relative of files.filter((item) => overlayStepFor(item) === step.id)) await exists(relative);
    }
    await exists(".research-toolkit/recommended-profile.json");
  }
  return { stepId: step.id, verified: missing.length === 0, missing, observedCount: observed.length };
}

/** Status of one step: recorded installation, observed artifacts and this release's version. */
function stepStatus(step, receipt, workerVersion, artifacts) {
  const recorded = receipt && receipt.steps ? receipt.steps[step.id] : undefined;
  // A record that only holds a failed attempt is not an installation. Without this distinction a
  // step that never succeeded was reported "outdated", which implied a version that was never there.
  const installedRecord = recorded && (recorded.toolkitVersion || recorded.evidence || recorded.status === "installed");
  if (!installedRecord) {
    const attempt = artifacts && artifacts.lastAttempt;
    return {
      id: step.id, label: step.label, status: "missing", installedVersion: null,
      evidence: attempt && attempt.status === "failed"
        ? `Not installed. The last setup attempt failed: ${attempt.error}`
        : attempt && attempt.status === "blocked"
          ? `Not installed. This step was blocked because ${attempt.blockedBy} did not complete.`
          : "Not installed in this workspace.",
      lastAttempt: attempt || null, artifacts: artifacts || null,
    };
  }
  const current = recorded.toolkitVersion === workerVersion;
  const artifactsMissing = Boolean(artifacts && !artifacts.verified);
  return {
    id: step.id,
    label: step.label,
    status: !current ? "outdated" : artifactsMissing ? "needs-repair" : "installed",
    installedVersion: recorded.toolkitVersion || null,
    at: recorded.at || null,
    artifacts: artifacts || null,
    lastAttempt: recorded.lastAttempt || null,
    evidence: artifactsMissing
      ? `Recorded by this release, but ${artifacts.missing.length} file(s) it produced are missing: ${artifacts.missing.slice(0, 3).join(", ")}${artifacts.missing.length > 3 ? ", …" : ""}. Repair this step.`
      : recorded.evidence || (current ? "Recorded by the last component setup." : "Recorded by an earlier toolkit release."),
  };
}

/** What the GUI shows for one component: status, owning step and the next action. */
function componentStatus(component, receipt, workerVersion, observed) {
  const install = component.install || { mode: "external", step: null, verify: "none" };
  const base = {
    id: component.id,
    mode: install.mode,
    step: install.step || null,
    verify: install.verify || "none",
    nextAction: component.nextAction || "",
    installable: install.mode === "managed" && Boolean(install.step && STEPS_BY_ID.get(install.step)),
  };
  if (install.mode === "managed") {
    const step = STEPS_BY_ID.get(install.step);
    // The component list and the plan must not disagree about one step: use the verification the
    // run recorded, so a step whose produced files were not verified is not shown as installed.
    const recordedArtifacts = step && receipt && receipt.steps && receipt.steps[step.id] ? receipt.steps[step.id].artifacts : null;
    const status = step ? stepStatus(step, receipt, workerVersion, recordedArtifacts) : { status: "missing" };
    return { ...base, status: status.status, installedVersion: status.installedVersion || null, evidence: status.evidence };
  }
  if (install.mode === "planned") return { ...base, status: "planned", installedVersion: null, evidence: "Not implemented in the toolkit." };
  if (install.mode === "external") return { ...base, status: "external", installedVersion: null, evidence: "Provided outside the toolkit; the toolkit does not install it." };
  return { ...base, status: observed && observed.installed === "Installed" ? "installed" : observed && observed.installed === "Not detected" ? "missing" : "observed", installedVersion: observed ? observed.version || null : null, evidence: observed ? observed.evidence || "" : "Observed by the component check." };
}

/** Observe every step a package offers, for the control panel's quick status refresh. */
async function planArtifacts(packageId, root, manifest, statusRecord) {
  const observed = new Map();
  for (const step of stepsForPackage(packageId)) {
    const artifacts = await verifyStepArtifacts(step, root, manifest);
    const attempt = statusRecord && Array.isArray(statusRecord.steps)
      ? statusRecord.steps.find((item) => item.id === step.id) : null;
    if (attempt && attempt.status !== "installed") artifacts.lastAttempt = attempt;
    observed.set(step.id, artifacts);
  }
  return observed;
}

/** Plan view for the control panel: every offered step with its status and coverage. */
function planView(packageId, receipt, workerVersion, artifacts) {
  const declaration = packageDeclaration(packageId);
  const steps = stepsForPackage(packageId).map((step) => {
    const observed = artifacts && typeof artifacts.get === "function" ? artifacts.get(step.id) : null;
    const status = stepStatus(step, receipt, workerVersion, observed);
    const selected = !step.optional || status.status !== "installed";
    return {
      ...step,
      status: status.status,
      installedVersion: status.installedVersion,
      installedAt: status.at,
      evidence: status.evidence,
      lastAttempt: status.lastAttempt,
      artifacts: observed || null,
      selected,
      // An optional step that was never installed is a deliberate omission, not an unmet requirement.
      omitted: step.optional && status.status === "missing",
    };
  });
  const counts = steps.reduce((total, step) => {
    if (step.omitted) return total;
    total[step.status] = (total[step.status] || 0) + 1;
    return total;
  }, {});
  counts.omittedOptional = steps.filter((step) => step.omitted).length;
  const components = catalog.components
    .filter((item) => (item.profiles || []).includes(packageId))
    .map((item) => componentStatus(item, receipt, workerVersion, null));
  return {
    package: { id: packageId, label: declaration ? declaration.label : packageId, gate: declaration ? declaration.gate : "unknown", support: declaration ? declaration.support : "unknown" },
    steps,
    counts,
    outdated: steps.filter((step) => step.status === "outdated").map((step) => step.id),
    missing: steps.filter((step) => step.status === "missing" && !step.omitted).map((step) => step.id),
    needsRepair: steps.filter((step) => step.status === "needs-repair").map((step) => step.id),
    failed: steps.filter((step) => step.lastAttempt && step.lastAttempt.status === "failed").map((step) => step.id),
    blocked: steps.filter((step) => step.lastAttempt && step.lastAttempt.status === "blocked").map((step) => step.id),
    omittedOptional: steps.filter((step) => step.omitted).map((step) => step.id),
    components: {
      managed: components.filter((item) => item.mode === "managed").length,
      host: components.filter((item) => item.mode === "host").length,
      editor: components.filter((item) => item.mode === "editor").length,
      external: components.filter((item) => item.mode === "external").length,
      planned: components.filter((item) => item.mode === "planned").length,
    },
  };
}

function attemptRecord(step, values) {
  return {
    id: step.id,
    label: step.label,
    status: values.status,
    startedAt: values.startedAt || null,
    finishedAt: values.finishedAt || new Date().toISOString(),
    durationMs: values.durationMs || null,
    attempts: values.attempts || 1,
    exitCode: values.exitCode === undefined ? null : values.exitCode,
    error: values.error || "",
    command: values.command || "",
    hint: values.hint || "",
    blockedBy: values.blockedBy || null,
    artifacts: values.artifacts || null,
    evidence: values.evidence || "",
    lockFallback: values.lockFallback || null,
  };
}

/**
 * What the operator should do next, taken from the shape of the failure rather than from a
 * generic sentence. A tool that could not be launched is not fixed by pressing the same button.
 */
function nextActionFor(error, step) {
  if (error.kind === "spawn") return "Install the tool this step needs, or set researchStack.uvPath to its full path, then retry.";
  if (error.kind === "timeout") return "Increase researchStack.setupTimeoutSeconds and retry, or run the same command in a terminal to see where it stops.";
  if (error.kind === "buffer") return "Retry the step; the tool produced more output than the toolkit captures.";
  if (error.kind === "cwd") return "Restore the workspace folder this step works in, then retry.";
  if (error.kind === "cancelled") return "Run Set up package components again to resume where this run stopped.";
  return error.hint || "Retry this step, then open the setup log for the full output.";
}

/** The command line a failing step actually ran, for the copied diagnostics. */
function commandLine(error) {
  if (!error || !error.command) return "";
  // The hint beside this text tells the operator to run the command themselves, and a workspace path
  // such as `K:\Soukromé aktivity\Bankovní účet SVJ ČSA368` breaks a copy-paste unless it is quoted.
  const quote = (value) => (/\s/.test(value) ? `"${value}"` : value);
  const args = Array.isArray(error.args) && error.args.length ? ` ${error.args.map(quote).join(" ")}` : "";
  return `${quote(error.command)}${args}${error.cwd ? ` (in ${quote(error.cwd)})` : ""}`;
}

/**
 * Run the selected steps for a package, in plan order, and record the result.
 *
 * A step is skipped only when this release recorded it and its produced files are still present.
 * A recorded step whose artifacts are gone is re-run as a repair. A step that fails does not stop
 * the plan: steps that do not depend on it continue, and its dependents are recorded as blocked.
 * The workspace setup lock is held for the whole plan.
 */
async function runPlan({ vscode, context, folder, packageId, stepIds, services = {}, force = false, settings = {} }) {
  const root = folder.uri.fsPath;
  const { manifest } = await bundle(context);
  const workerDirectory = path.join(root, WORKER_FOLDER);
  const managed = path.join(root, MANAGED_FOLDER);
  const selected = resolveStepSelection(packageId, stepIds);
  const steps = selected.map((id) => STEPS_BY_ID.get(id));

  const preflight = await runPreflight({ vscode, folder, steps, services, settings });
  if (!preflight.ok) {
    return blockedRun({ root, packageId, manifest, workerDirectory, selected, preflight, reason: preflight.blockers });
  }

  // Preflight already classified this lock. If it is stale, clear it here so the plan gets a
  // verdict instead of dying on EEXIST with nothing recorded.
  if (preflight.lock && preflight.lock.state === "stale") {
    await clearStaleLock(root, { setupWindowMs: settings.setupWindowMs || setupWindowMs(settings, steps) });
  }

  let lock = null;
  if (!services.lockHeld) {
    try { lock = await acquireSetupLock(managed); }
    catch (error) {
      // A lock this run could not take is still a result the operator has to be able to read:
      // without a record the panel says nothing ran, which is exactly the 0.3.5 symptom.
      const check = { id: "setup-lock", label: "Setup lock", status: "fail", detail: error.message, action: "Run Clear interrupted setup lock; it removes only a lock whose owning process is gone." };
      return blockedRun({ root, packageId, manifest, workerDirectory, selected, preflight: { ok: false, checks: [check], blockers: ["setup-lock"], lock: null }, reason: ["setup-lock"] });
    }
  }
  const held = { ...services, lockHeld: true, settings, setupTimeoutMs: (Number(settings.setupTimeoutSeconds) || 0) * 1000 || undefined };
  const startedAt = new Date().toISOString();
  try {
    let existing;
    try { existing = (await readReceipt(workerDirectory)) || {}; }
    catch (error) {
      // A damaged receipt is a preflight problem with a named file and a remedy, not a stack trace.
      const check = { id: "setup-receipt", label: "Setup receipt", status: "fail", detail: `${path.join(workerDirectory, RECEIPT_NAME)} could not be read: ${error.message}`, action: "Remove that receipt file and run Set up package components again." };
      return blockedRun({ root, packageId, manifest, workerDirectory, selected, preflight: { ok: false, checks: [check], blockers: ["setup-receipt"], lock: null }, reason: ["setup-receipt"] });
    }
    const receipt = {
      extensionVersion: manifest.extensionVersion || manifest.workerVersion,
      workerVersion: manifest.workerVersion,
      installedAt: existing.installedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      package: packageId,
      steps: { ...(existing.steps || {}) },
      toolPreset: existing.toolPreset || null,
      checks: existing.checks || null,
    };
    const ran = [];
    const skipped = [];
    const repaired = [];
    const failed = [];
    const blocked = [];
    const attempts = [];
    const troubled = new Set();

    for (const step of steps) {
      const blockedBy = (step.prerequisites || []).find((prerequisite) => troubled.has(prerequisite));
      if (blockedBy) {
        const attempt = attemptRecord(step, { status: "blocked", blockedBy, hint: `Fix ${blockedBy} first, then retry this step.` });
        attempts.push(attempt);
        blocked.push(step.id);
        troubled.add(step.id);
        receipt.steps[step.id] = { ...(receipt.steps[step.id] || {}), lastAttempt: attempt };
        await safeAppend(root, { kind: "step", stepId: step.id, status: "blocked", blockedBy, at: attempt.finishedAt });
        continue;
      }
      if (services.signal && services.signal.aborted) {
        // Cancel has to be honoured before a step starts, not only inside a running process:
        // a file-writing step ignores the signal, so the plan is the place that refuses it.
        const attempt = attemptRecord(step, { status: "cancelled", hint: "Run Set up package components again to resume where this run stopped." });
        attempts.push(attempt);
        troubled.add(step.id);
        receipt.steps[step.id] = { ...(receipt.steps[step.id] || {}), lastAttempt: attempt };
        await safeAppend(root, { kind: "step", stepId: step.id, status: "cancelled", at: attempt.finishedAt });
        continue;
      }
      const artifacts = await verifyStepArtifacts(step, root, manifest);
      const status = stepStatus(step, receipt, manifest.workerVersion, artifacts);
      if (status.status === "installed" && !force) {
        const attempt = attemptRecord(step, { status: "skipped", artifacts, evidence: status.evidence });
        attempts.push(attempt);
        skipped.push(step.id);
        await safeAppend(root, { kind: "step", stepId: step.id, status: "skipped-current", at: attempt.finishedAt });
        continue;
      }
      if (status.status === "needs-repair") repaired.push(step.id);
      held.progress?.(`Step ${attempts.length + 1} of ${steps.length}: ${step.label}`);
      const stepStarted = Date.now();
      const stepStartedAt = new Date().toISOString();
      try {
        const recorded = await runStep({ step, vscode, context, folder, root, services: held, settings });
        const verified = await verifyStepArtifacts(step, root, manifest);
        receipt.steps[step.id] = { ...recorded, status: "installed", at: new Date().toISOString() };
        if (recorded.check) receipt.checks = recorded.check;
        ran.push(step.id);
        const attempt = attemptRecord(step, {
          status: "installed", startedAt: stepStartedAt, durationMs: Date.now() - stepStarted,
          attempts: recorded.attempts || 1, artifacts: verified, evidence: recorded.evidence,
          lockFallback: recorded.lockFallback || null,
        });
        attempts.push(attempt);
        await writeReceipt(workerDirectory, receipt);
        await safeAppend(root, { kind: "step", stepId: step.id, status: "installed", durationMs: attempt.durationMs, artifactsVerified: verified.verified, at: attempt.finishedAt });
      } catch (error) {
        const attempt = attemptRecord(step, {
          status: error.kind === "cancelled" ? "cancelled" : "failed",
          startedAt: stepStartedAt, durationMs: Date.now() - stepStarted,
          attempts: error.attempts || 1, exitCode: error.exitCode,
          error: error.message, hint: nextActionFor(error, step), command: commandLine(error),
          lockFallback: error.lockFallback || null,
          artifacts: await verifyStepArtifacts(step, root, manifest).catch(() => null),
        });
        attempts.push(attempt);
        failed.push(step.id);
        troubled.add(step.id);
        receipt.steps[step.id] = { ...(receipt.steps[step.id] || {}), lastAttempt: attempt };
        await writeReceipt(workerDirectory, receipt);
        await safeAppend(root, { kind: "step", stepId: step.id, status: attempt.status, exitCode: attempt.exitCode, durationMs: attempt.durationMs, error: attempt.error, at: attempt.finishedAt });
        held.progress?.(`${step.label} did not complete: ${attempt.error}`);
      }
    }

    const finishedAt = new Date().toISOString();
    // A retry runs a subset of the package plan, but the record is what the panel reads after a
    // reopen. It describes the whole package: the steps this run attempted, plus the steps this run
    // left alone whose files were re-checked and are still present.
    const carried = [];
    for (const step of stepsForPackage(packageId)) {
      if (selected.includes(step.id)) continue;
      const artifacts = await verifyStepArtifacts(step, root, manifest);
      const status = stepStatus(step, receipt, manifest.workerVersion, artifacts);
      if (status.status !== "installed") continue;
      carried.push({
        id: step.id, label: step.label, status: "installed", carried: true, durationMs: 0,
        startedAt: status.at || startedAt, finishedAt: status.at || finishedAt,
        evidence: status.evidence, artifacts,
      });
    }
    const rowsById = new Map([...carried, ...attempts].map((row) => [row.id, row]));
    const packageOrder = stepsForPackage(packageId).map((step) => step.id);
    const planSteps = [
      ...packageOrder.map((id) => rowsById.get(id)).filter(Boolean),
      ...[...rowsById.values()].filter((row) => !packageOrder.includes(row.id)),
    ];
    const record = {
      outcome: outcomeOf({ steps: planSteps, preflight: { ok: true, checks: preflight.checks } }),
      package: packageId, toolkitVersion: manifest.workerVersion,
      workspaceFolder: folder.name || root, startedAt, finishedAt,
      durationMs: Date.now() - Date.parse(startedAt),
      steps: planSteps,
      preflight: { ok: true, checks: preflight.checks, blockers: [] },
      hostTools: preflight.hostTools, lock: preflight.lock,
      // The record also states how much of the package plan it covers, so a record produced by a
      // retry cannot read as "the whole package is installed".
      packageSteps: {
        total: packageOrder.length,
        installed: planSteps.filter((row) => (row.status === "installed" || row.status === "skipped")
          && !(row.artifacts && row.artifacts.verified === false)).length,
      },
    };
    // The record points at itself so a reopened panel, or copied diagnostics, can name the file
    // an operator should open even before the log is read again.
    record.logFile = logPaths(root).statusFile;
    try {
      const statusFile = await writeStatus(root, record);
      await safeAppend(root, { kind: "plan", status: record.outcome, package: packageId, ran, skipped, repaired, failed, blocked, at: finishedAt });
      record.logFile = statusFile;
    } catch (error) {
      // Components were installed or not installed regardless of the log. Losing the record is
      // reported as a problem; it must not erase the verdict the steps earned.
      record.recordError = `The setup log could not be written: ${error.message}`;
    }
    return { receipt, ran, skipped, repaired, failed, blocked, selected, outcome: record.outcome, preflight, statusRecord: record, worker: workerDirectory };
  } finally {
    if (lock) await lock.release();
  }
}

/** Quick status refresh: re-read the receipt, the status record and the artifacts, without the functional check. */
async function refreshPlanStatus({ context, folder, packageId }) {
  const root = folder.uri.fsPath;
  const { manifest } = await bundle(context);
  let receipt;
  try { receipt = (await readReceipt(path.join(root, WORKER_FOLDER))) || {}; }
  catch (error) {
    // The refresh command must answer in operator language, not with a JSON parser message.
    throw new Error(`${path.join(WORKER_FOLDER, RECEIPT_NAME)} could not be read: ${error.message} Remove that receipt and run Set up package components again.`);
  }
  const statusRecord = await readStatus(root);
  const view = planView(packageId, receipt, manifest.workerVersion, await planArtifacts(packageId, root, manifest, statusRecord));
  const runtimes = await discoverRuntimes(root);
  const log = await readLog(root, 40);
  return {
    ...view,
    workerVersion: manifest.workerVersion,
    runtimes: runtimes.runtimes,
    activeRuntime: runtimes.active,
    verifiedAt: receipt.checks && receipt.checks.checkedAt ? receipt.checks.checkedAt : null,
    functionalCheckRun: false,
    receipt,
    statusRecord,
    logFiles: log.files,
  };
}

/** Steps that this release can refresh, i.e. recorded by an older toolkit version. */
function outdatedSteps(packageId, receipt, workerVersion) {
  return stepsForPackage(packageId).filter((step) => stepStatus(step, receipt, workerVersion).status === "outdated").map((step) => step.id);
}

/** Steps whose last attempt failed or was blocked, so the panel can offer a targeted retry. */
function failedSteps(packageId, statusRecord) {
  if (!statusRecord || !Array.isArray(statusRecord.steps)) return [];
  const offered = new Set(stepsForPackage(packageId).map((step) => step.id));
  return statusRecord.steps
    .filter((step) => offered.has(step.id) && ["failed", "blocked", "cancelled"].includes(step.status))
    .map((step) => step.id);
}

module.exports = {
  STEPS_BY_ID, COMPONENTS_BY_ID, RECEIPT_NAME, NOTEBOOK_PROJECT_NAME, NOTEBOOK_DEPENDENCIES,
  stepsForPackage, packageDeclaration, stepsForComponents, resolveStepSelection, explainStepSelection,
  readReceipt, writeReceipt, verifyStepArtifacts, stepStatus, componentStatus, planArtifacts, planView,
  overlayStepFor, inspectNotebookProject, writeOverlayFiles, overlayEvidence, commandLine, attemptRecord,
  runPlan, refreshPlanStatus, outdatedSteps, failedSteps,
};
