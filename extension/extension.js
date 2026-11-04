"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const TOOLKIT_VERSION = require("./package.json").version;
const DEFAULT_PACKAGE = "recommended";
const DEFAULT_PRESET = "package-default";
const STATE_KEY = "researchStack.selectedPackage";
const PRESET_STATE_KEY = "researchStack.toolsPreset";
const RECENT_PRESET_STATE_KEY = "researchStack.recentPresets";
const RECENT_PRESET_LIMIT = 3;
const { controlPanelHtml } = require("./ui");
const { baseInventory, checkInventory, inventoryText } = require("./diagnostics");
const { requireLocal, managedRuntime, setupRuntime, functionalCheck, bundle, discoverRuntimes, rollbackRuntime, WORKER_FOLDER, WORKER_VERSION, MANAGED_FOLDER } = require("./runtime");
const installer = require("./installer");
const setuplog = require("./setuplog");
const statusModel = require("./status");
const { clearStaleLock, inspectLock, setupWindowMs } = require("./preflight");
const { clearHostToolCache } = require("./hosttools");
const { PYTHON_FLAGS } = require("./runner");
const componentCatalog = require("./components.json");
const presetCatalog = require("./presets.json");
const COMPONENTS_BY_ID = new Map(componentCatalog.components.map((item) => [item.id, item]));
const PRESETS_BY_ID = new Map(presetCatalog.presets.map((item) => [item.id, item]));
const SERVERS_BY_MODULE = new Map(presetCatalog.servers.map((item) => [item.module, item]));
const PACKAGE_OPTIONS = Object.freeze([
  Object.freeze({ id: "basic", label: "Basic", detail: "Basic research tools — prototype; G1 not passed" }),
  Object.freeze({ id: "recommended", label: "Recommended Research", detail: "Research package — prototype; G2 not passed" }),
  Object.freeze({ id: "full", label: "Full", detail: "Full Research Lab — prototype foundation only; G3 not passed" }),
]);
const PACKAGES_BY_ID = new Map(PACKAGE_OPTIONS.map((item) => [item.id, item]));

/** Presets offered for a package: the goal list changes with the package choice. */
function presetsForPackage(packageId) {
  return presetCatalog.presets.filter((preset) => preset.packages.includes(packageId));
}

function defaultPresetFor(packageId) {
  const presets = presetsForPackage(packageId);
  const fallback = presets[0] || presetCatalog.presets[0];
  return (presets.find((preset) => (preset.defaultFor || []).includes(packageId)) || fallback).id;
}

/** Measured tokens for the toolkit tools a goal enables, from the real tools/list receipt. */
function measuredPresetTokens(preset, toolSurface, budget) {
  if (!toolSurface || !Array.isArray(toolSurface.servers)) return { measured: false, measuredTools: 0, tokens: 0, tools: 0 };
  const byName = new Map();
  for (const server of toolSurface.servers) for (const tool of server.tools || []) byName.set(tool.name, tool);
  let tokens = 0;
  let tools = 0;
  for (const name of preset.tools) {
    const tool = byName.get(name);
    if (!tool) continue;
    tools += 1;
    tokens += Number(tool.tokensEstimate) || 0;
  }
  if (!tools) return { measured: false, measuredTools: 0, tokens: 0, tools: 0 };
  const unmeasured = preset.tools.length - tools;
  return { measured: true, measuredTools: tools, tokens: tokens + unmeasured * budget.vendorTokensPerTool, tools: preset.tools.length };
}

/** Tool count and context cost of a preset, used by the control panel and the status bar. */
function presetEstimate(preset, toolSurface) {
  const budget = presetCatalog.budget;
  const toolkitTools = preset.tools.length;
  const thirdPartyTools = (preset.thirdParty || []).reduce((total, item) => total + item.toolsEstimate, 0);
  const totalTools = toolkitTools + thirdPartyTools;
  const measured = measuredPresetTokens(preset, toolSurface, budget);
  const tokens = measured.measured
    ? measured.tokens + thirdPartyTools * budget.vendorTokensPerTool
    : totalTools * budget.vendorTokensPerTool;
  const measuredTools = measured.measuredTools;
  const basis = !measured.measured ? "estimated" : measuredTools >= preset.tools.length ? "measured" : "partial";
  const level = totalTools > budget.clientCeiling ? "over-ceiling"
    : totalTools > budget.ceilingWarning ? "near-ceiling"
      : totalTools > budget.accuracyBand ? "watch" : "focused";
  return {
    presetId: preset.id,
    toolkitTools,
    thirdPartyTools,
    totalTools,
    headroom: budget.clientCeiling - totalTools,
    tokensEstimate: tokens,
    contextPercent: Math.round((tokens / budget.contextWindowReference) * 1000) / 10,
    measured: measured.measured,
    measuredTools,
    basis,
    level,
    servers: presetCatalog.servers.filter((server) => server.tools.some((tool) => preset.tools.includes(tool))).map((server) => server.module),
  };
}

function presetViews(toolSurface) {
  const views = {};
  for (const preset of presetCatalog.presets) views[preset.id] = presetEstimate(preset, toolSurface);
  return views;
}

/** One-line summary of what the workspace receipt says about this package's components. */
function setupSummary(plan) {
  if (!plan) return "Package setup: no component setup recorded in this workspace yet.";
  const installed = plan.steps.filter((step) => step.status === "installed").length;
  const outdated = plan.counts.outdated || 0;
  const missing = plan.counts.missing || 0;
  const repair = plan.counts["needs-repair"] || 0;
  const omitted = (plan.omittedOptional || []).length;
  const optional = plan.steps.filter((step) => step.optional).map((step) => step.label);
  return `Package setup for ${plan.package.label}: ${installed} of ${plan.steps.length} component steps installed`
    + (outdated ? `, ${outdated} outdated for this toolkit release` : "")
    + (missing ? `, ${missing} not installed` : "")
    + (repair ? `, ${repair} recorded but needing repair (files it produced are missing)` : "")
    + (omitted ? `, ${omitted} optional step(s) deliberately not installed` : "")
    + (optional.length && !omitted ? ` · optional: ${optional.join(", ")}` : "")
    + ` · ${plan.package.gate}.`;
}

function readinessText(selectedPackage = DEFAULT_PACKAGE, inventory, presetLabel, plan) {
  const selected = PACKAGES_BY_ID.get(selectedPackage) || PACKAGES_BY_ID.get(DEFAULT_PACKAGE);
  return [
    `Research Stack Toolkit ${TOOLKIT_VERSION} preview`,
    `Selected package preference: ${selected.label} (${selected.id})`,
    presetLabel ? `Selected tools preset: ${presetLabel}` : "Tools preset: package default",
    "Changing the package preference changes which components setup offers and which presets are available; nothing is installed silently.",
    "Toolkit controls and observed installation inventory are separate from complete profile support.",
    "Basic: prototype; G1 not passed",
    "Recommended Research: prototype; G2 not passed",
    "Full: prototype foundation only; G3 not passed",
    setupSummary(plan),
    "External services, editor sign-in and notebook kernels have their own prerequisites and are not installed by this extension.",
    ...(inventory ? ["", inventoryText(inventory)] : ["Component checks have not run."]),
  ].join("\n");
}

function validateContext(vscode, context) {
  if (
    !vscode || !vscode.commands || !vscode.window ||
    typeof vscode.window.createOutputChannel !== "function" ||
    typeof vscode.window.showQuickPick !== "function" ||
    typeof vscode.commands.registerCommand !== "function" ||
    !vscode.workspace || typeof vscode.workspace.getConfiguration !== "function" ||
    !vscode.ConfigurationTarget || typeof vscode.ConfigurationTarget.Global !== "number" ||
    !context || !Array.isArray(context.subscriptions)
  ) {
    throw new TypeError("VS Code commands, Quick Pick, user settings configuration, and ExtensionContext subscriptions are required.");
  }
}

function activateWith(vscode, context, diagnosticServices) {
  validateContext(vscode, context);

  const output = vscode.window.createOutputChannel("Research Stack");
  context.subscriptions.push(output);
  const changed = new vscode.EventEmitter();
  context.subscriptions.push(changed);
  let panel;
  let panelReady = false;
  let writes = Promise.resolve();
  let inventory = baseInventory(vscode, context);
  let diagnosticsWorkspace = 0;
  let generation = 0;
  let checking;
  let operation;
  let readingResult;
  let progressMessage = "";
  let toolSurface;
  let receipt;
  let planArtifacts = new Map();
  let appliedPreset;
  let appliedPresetSignature;
  let installationStatus = null;
  let installationLock = null;

  /** Setup settings: where uv may be found and how long a downloading step may take. */
  function setupSettings() {
    const config = vscode.workspace.getConfiguration("researchStack");
    const timeout = Number(config.get("setupTimeoutSeconds", 900));
    return {
      uvPath: String(config.get("uvPath", "") || "").trim(),
      setupTimeoutSeconds: Number.isFinite(timeout) ? Math.min(3600, Math.max(60, timeout)) : 900,
      managedToolDir: folderSelected() && folderSelected().uri.scheme === "file" ? path.join(folderSelected().uri.fsPath, MANAGED_FOLDER) : undefined,
      minimumVersions: { uv: (componentCatalog.components.find((item) => item.id === "uv") || {}).minimumVersion || null },
    };
  }

  /** Read the recorded installation status for the selected folder, so the verdict survives a reopen. */
  async function loadInstallationStatus() {
    const folder = folderSelected();
    if (!folder || folder.uri.scheme !== "file") { installationStatus = null; installationLock = null; return null; }
    try { installationStatus = await setuplog.readStatus(folder.uri.fsPath); } catch { installationStatus = null; }
    // The lock is live state, not part of the record: a setup interrupted in another window still
    // blocks this workspace, and the card has to say so before any button is pressed.
    try { installationLock = await inspectLock(folder.uri.fsPath, { setupWindowMs: setupWindowMs(setupSettings()) }); } catch { installationLock = null; }
    return installationStatus;
  }

  /** The panel's installation card: verdict, per-step rows, host tools and preflight. */
  function installationView() {
    const record = installationStatus;
    if (record && record.damaged) {
      return { outcome: "damaged", line: "The recorded setup status could not be read. Run Set up package components again to get a verdict.", steps: [], hostTools: [], preflight: null, logFiles: [], lock: installationLock, statusFile: record.statusFile || null, package: null, toolkitVersion: TOOLKIT_VERSION, workspaceFolder: null, durationText: "—", attemptedAt: "not recorded",
        problem: { label: "Setup status record", detail: `${record.statusFile} is present but is not readable JSON.`, action: "Open the setup log, or remove that record and run setup again." } };
    }
    const verdict = statusModel.outcomeLine(record, { toolkitVersion: TOOLKIT_VERSION });
    if (!record) return { outcome: verdict.outcome, line: verdict.line, steps: [], hostTools: [], preflight: null, logFiles: [], lock: installationLock, statusFile: null, package: null, toolkitVersion: TOOLKIT_VERSION, workspaceFolder: null, durationText: "—", attemptedAt: "not recorded", problem: null };
    const problem = statusModel.firstProblem(record);
    // The card is a record; the plan is an observation. Re-check the recorded steps against the
    // files on disk so "complete" cannot sit next to a plan that says nothing is installed.
    const rows = (record.steps || []).map((step) => {
      const row = statusModel.stepRow(step);
      const observed = planArtifacts.get(step.id);
      if (row.status === "installed" && observed && observed.verified === false) {
        row.status = "unverified";
        row.statusText = "recorded as installed, files missing";
        row.error = `missing now: ${(observed.missing || []).slice(0, 3).join(", ")}`;
      }
      return row;
    });
    const gone = rows.filter((row) => row.status === "unverified");
    let outcome = verdict.outcome;
    let line = verdict.line;
    if (gone.length && outcome === "success") {
      outcome = "partial";
      line = `Installation incomplete — ${gone.length} step(s) were recorded as installed, but ${gone.reduce((sum, row) => sum + ((planArtifacts.get(row.id) || {}).missing || []).length, 0)} file(s) they produced are no longer present (${gone.map((row) => row.label).join(", ")}).`;
    }
    return {
      outcome,
      line,
      steps: rows,
      hostTools: record.hostTools || [],
      preflight: record.preflight || null,
      logFiles: (installationLogFiles || []).length ? installationLogFiles : (record.logFile ? [record.logFile] : []),
      lock: installationLock || record.lock || null,
      statusFile: record.logFile || null,
      package: record.package || null,
      toolkitVersion: record.toolkitVersion || TOOLKIT_VERSION,
      workspaceFolder: record.workspaceFolder || null,
      durationText: statusModel.durationText(record.durationMs),
      attemptedAt: statusModel.timeText(record.finishedAt || record.startedAt),
      problem: gone.length && !problem
        ? { label: "Recorded component steps", detail: line, action: "Run Set up package components again to repair the missing files." }
        : problem ? { label: problem.label, detail: problem.detail, action: problem.action } : null,
    };
  }
  const recentPresets = () => readRecentPresets(context);
  function rememberPreset(id) {
    if (!PRESETS_BY_ID.has(id) || !context.globalState || typeof context.globalState.update !== "function") return;
    const next = [id, ...recentPresets().filter((item) => item !== id)].slice(0, RECENT_PRESET_LIMIT);
    void Promise.resolve(context.globalState.update(RECENT_PRESET_STATE_KEY, next)).catch(() => {});
  }
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  statusBar.command = "researchToolkit.openControlPanel";
  statusBar.name = "Research Toolkit";
  context.subscriptions.push(statusBar);

  function presetCards(packageId) {
    return presetsForPackage(packageId).map((preset) => ({
      id: preset.id, label: preset.label, goal: preset.goal, tips: preset.tips,
      requires: preset.requires, tools: preset.tools, thirdParty: preset.thirdParty,
      isDefault: (preset.defaultFor || []).includes(packageId),
      isPackageDefault: defaultPresetFor(packageId) === preset.id,
      estimate: presetEstimate(preset, toolSurface),
    }));
  }

  function selectedPreset() {
    return PRESETS_BY_ID.get(selectedPresetId(vscode)) || PRESETS_BY_ID.get(defaultPresetFor(selectedPackage(vscode)));
  }

  function readinessSummary(packageId = selectedPackage(vscode)) {
    const preset = selectedPreset();
    const estimate = presetEstimate(preset, toolSurface);
    return readinessText(packageId, inventory,
      `${preset.label} · ${estimate.toolkitTools} toolkit tools${estimate.thirdPartyTools ? ` + ${estimate.thirdPartyTools} configured external tools (vendor estimates)` : ""} · ≈${Math.round(estimate.tokensEstimate / 100) / 10}k tokens (${estimateLabel(estimate)})`,
      installer.planView(packageId, receipt, WORKER_VERSION, planArtifacts));
  }

  /** Say what the number is: measured from this worker, partly measured, or a vendor estimate. */
  function estimateLabel(estimate) {
    if (estimate.basis === "measured") return "measured from this worker's tools/list";
    if (estimate.basis === "partial") return `partial: ${estimate.measuredTools} of ${estimate.toolkitTools} toolkit tools measured, the rest at the vendor estimate`;
    return `vendor estimate at ${presetCatalog.budget.vendorTokensPerTool} tokens per tool`;
  }

  /** Recompute the observed step artifacts for the selected package and folder. */
  let installationLogFiles = [];
  async function loadPlanArtifacts() {
    const folder = folderSelected();
    if (!folder || folder.uri.scheme !== "file") { planArtifacts = new Map(); installationStatus = null; installationLogFiles = []; return planArtifacts; }
    try { installationStatus = await loadInstallationStatus(); } catch { installationStatus = null; }
    try { installationLogFiles = (await setuplog.readLog(folder.uri.fsPath, 10)).files; } catch { installationLogFiles = []; }
    try {
      const { manifest } = await bundle(context);
      planArtifacts = await installer.planArtifacts(selectedPackage(vscode), folder.uri.fsPath, manifest, installationStatus);
    } catch { planArtifacts = new Map(); }
    return planArtifacts;
  }

  function presetSummaryText() {
    const preset = selectedPreset();
    const estimate = presetEstimate(preset, toolSurface);
    const budget = presetCatalog.budget;
    return [
      `Research Stack Toolkit ${context.extension.packageJSON.version} · tools preset "${preset.id}"`,
      `Goal: ${preset.goal}`,
      `Toolkit tools (${estimate.toolkitTools}): ${preset.tools.join(", ")}`,
      `Toolkit MCP servers offered: ${estimate.servers.join(", ") || "none"}`,
      `External tools you configure: ${estimate.thirdPartyTools ? (preset.thirdParty || []).map((item) => `${item.label} ≈${item.toolsEstimate}`).join(" · ") : "none"}`,
      `Total against the client ceiling: ${estimate.totalTools} of ${budget.clientCeiling} · headroom ${estimate.headroom} · level ${estimate.level}`,
      `Tool definitions per request: ≈${estimate.tokensEstimate} tokens (${estimate.contextPercent}% of a ${Math.round(budget.contextWindowReference / 1000)}k window) · ${estimate.measured ? "measured from the installed worker's tools/list schemas" : `vendor estimate at ${budget.vendorTokensPerTool} tokens per tool`}`,
      toolSurface ? `Installed worker surface: ${toolSurface.toolCount} tools across ${toolSurface.servers.length} servers · ≈${toolSurface.tokensEstimate} tokens` : "Installed worker surface: not measured yet (run component setup).",
      `Needs: ${preset.requires.join(" · ")}`,
      `Tips: ${preset.tips.join(" · ")}`,
    ].join("\n");
  }

  function state() {
    const config = vscode.workspace.getConfiguration("researchStack");
    const packageId = selectedPackage(vscode);
    const plan = installer.planView(packageId, receipt, WORKER_VERSION, planArtifacts);
    return {
      type: "state", version: context.extension.packageJSON.version,
      selectedPackage: packageId, packages: PACKAGE_OPTIONS,
      toolsPresetSetting: toolsPresetSetting(vscode), selectedToolsPreset: selectedPresetId(vscode),
      appliedToolsPreset: appliedPreset, appliedPresetSignature: appliedPresetSignature,
      presetApplied: appliedPreset === selectedPresetId(vscode) && Boolean(appliedPresetSignature),
      toolsPresetScope: presetScope(vscode.workspace.getConfiguration("researchStack", folderSelected())), recentPresets: recentPresets(),
      presets: presetCards(packageId), toolBudget: presetCatalog.budget, toolSurface,
      installPlan: plan, toolkitVersion: TOOLKIT_VERSION, installation: installationView(),
      showStatusBar: config.get("showStatusBar", true),
      openControlPanelOnStartup: config.get("openControlPanelOnStartup", false),
      workspace: (vscode.workspace.workspaceFolders || []).map((folder) => folder.name).join(", ") || "No workspace open",
      trusted: vscode.workspace.isTrusted,
      folders: (vscode.workspace.workspaceFolders || []).map((folder, index) => ({ index, name: folder.name })),
      diagnosticsWorkspace,
      inventory,
      readingResult, progressMessage, busy: Boolean(operation || checking),
      readiness: readinessSummary(packageId),
    };
  }

  function refresh() {
    const current = state();
    const preset = PRESETS_BY_ID.get(current.selectedToolsPreset);
    const estimate = presetEstimate(preset, toolSurface);
    statusBar.text = `$(beaker) Research: ${PACKAGES_BY_ID.get(current.selectedPackage).label}`;
    statusBar.tooltip = `Research Toolkit controls.\nTools preset: ${preset.label} — ${estimate.toolkitTools} toolkit tools`
      + (estimate.thirdPartyTools ? ` + ${estimate.thirdPartyTools} configured external tools` : "")
      + ` · ≈${Math.round(estimate.tokensEstimate / 100) / 10}k tokens of tool definitions per request.`
      + `\n${setupSummary(current.installPlan)}`;
    if (current.showStatusBar) statusBar.show(); else statusBar.hide();
    changed.fire();
    if (panel) void panel.webview.postMessage(current);
    return current;
  }

  function updateSetting(key, value, target = vscode.ConfigurationTarget.Global) {
    // A folder-scoped write must go through the folder's own configuration object, otherwise
    // the promise of a per-folder override is not kept.
    const scope = target === vscode.ConfigurationTarget.WorkspaceFolder ? folderSelected() : undefined;
    if (target === vscode.ConfigurationTarget.WorkspaceFolder && (!scope || scope.uri.scheme !== "file")) {
      throw new TypeError("Choose an open workspace folder before saving a folder-scoped setting.");
    }
    const configuration = vscode.workspace.getConfiguration("researchStack", scope);
    const write = writes.then(() => configuration.update(key, value, target));
    writes = write.catch(() => {});
    return write.then(() => refresh());
  }

  const register = (id, callback) => context.subscriptions.push(vscode.commands.registerCommand(id, callback));
  register("researchToolkit.openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:michaelprinc.research-stack-toolkit"));
  register("researchToolkit.openHelp", () => vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.joinPath(context.extensionUri, "guides", "index.md")));
  async function chooseComponent(requestedId) {
    let id = requestedId;
    if (id === undefined) {
      const picked = await vscode.window.showQuickPick(componentCatalog.components.map((item) => ({ id: item.id, label: item.title, detail: item.summary })), { title: "Choose a component guide" });
      if (!picked) return undefined;
      id = picked.id;
    }
    if (typeof id !== "string" || !COMPONENTS_BY_ID.has(id)) throw new TypeError("Unknown component guide.");
    return COMPONENTS_BY_ID.get(id);
  }
  register("researchToolkit.openComponentGuide", async (id) => {
    const item = await chooseComponent(id);
    if (item) return vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.joinPath(context.extensionUri, ...item.guide.split("/")));
  });
  register("researchToolkit.openComponentDocs", async (id) => {
    const item = await chooseComponent(id);
    if (!item) return;
    if (!item.officialUrl) throw new TypeError("Select a specific provider before opening its official documentation.");
    if (!await vscode.env.openExternal(vscode.Uri.parse(item.officialUrl))) throw new Error("Unable to open the official documentation in the host browser.");
  });
  const folderSelected = () => (vscode.workspace.workspaceFolders || [])[diagnosticsWorkspace];
  async function exclusive(action) {
    if (operation || checking) throw new Error("A setup or check is already running. Wait for it to finish.");
    operation = Promise.resolve().then(action);
    refresh();
    try { return await operation; }
    finally { operation = undefined; progressMessage = ""; refresh(); }
  }

  /** Record the effective preset and its measured surface so the workspace is auditable. */
  function presetReceiptBlock() {
    const preset = selectedPreset();
    const estimate = presetEstimate(preset, toolSurface);
    return {
      id: preset.id, label: preset.label, toolkitTools: estimate.toolkitTools, thirdPartyTools: estimate.thirdPartyTools,
      totalTools: estimate.totalTools, headroom: estimate.headroom, tokensEstimate: estimate.tokensEstimate,
      measured: estimate.measured, servers: estimate.servers, recordedAt: new Date().toISOString(),
    };
  }
  async function recordPresetInReceipt() {
    const folder = folderSelected();
    if (!folder || folder.uri.scheme !== "file") return;
    let current;
    try { current = await installer.readReceipt(path.join(folder.uri.fsPath, WORKER_FOLDER)); } catch { return; }
    if (!current) return;
    current.toolPreset = presetReceiptBlock();
    await installer.writeReceipt(path.join(folder.uri.fsPath, WORKER_FOLDER), current);
    receipt = current;
  }

  async function runComponentPlan({ packageId, stepIds, force = false, title }) {
    const folder = folderSelected();
    requireLocal(vscode, folder);
    const chosen = installer.resolveStepSelection(packageId, stepIds);
    if (!chosen.length) throw new Error("Select at least one component step to set up. The component list shows which steps this package offers.");
    const plan = installer.planView(packageId, receipt, WORKER_VERSION, planArtifacts);
    const labels = plan.steps.filter((step) => chosen.includes(step.id)).map((step) => step.label);
    const result = await exclusive(async () => {
      const currentGeneration = generation;
      const run = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() => controller.abort());
        try {
          return await installer.runPlan({
            vscode, context, folder, packageId, stepIds: chosen, force, settings: setupSettings(),
            services: {
              ...diagnosticServices, signal: controller.signal, settings: setupSettings(),
              progress(message) { progressMessage = message; progress.report({ message }); refresh(); },
            },
          });
        } finally { cancellation.dispose(); }
      });
      if (generation === currentGeneration) {
        receipt = run.receipt;
        toolSurface = run.receipt.checks?.toolSurface || toolSurface;
        await recordPresetInReceipt();
        await loadPlanArtifacts();
        inventory = await checkInventory(vscode, context, folder, { ...diagnosticServices, settings: setupSettings(), functionalResult: run.receipt.checks });
        readingResult = run.receipt.checks || readingResult;
      }
      changed.fire();
      output.appendLine(`Component setup ${run.outcome === "success" ? "completed" : run.outcome} in ${run.worker}: ran ${run.ran.length ? run.ran.join(", ") : "nothing"}`
        + (run.skipped.length ? `; skipped as already current and verified: ${run.skipped.join(", ")}` : "")
        + (run.failed.length ? `; failed: ${run.failed.join(", ")}` : "")
        + (run.blocked.length ? `; blocked: ${run.blocked.join(", ")}` : "")
        + (run.repaired.length ? `; repaired (recorded, but their files were missing): ${run.repaired.join(", ")}` : "") + ".");
      return { ...run, receipt: receipt || run.receipt };
    });
    return result;
  }

  register("researchToolkit.setupLocalComponents", async (stepIds) => {
    const folder = folderSelected();
    const root = requireLocal(vscode, folder);
    const packageId = selectedPackage(vscode);
    await loadPlanArtifacts();
    const plan = installer.planView(packageId, receipt, WORKER_VERSION, planArtifacts);
    const choice = await vscode.window.showInformationMessage(
      `Set up the ${plan.package.label} components in ${folder.name}?`,
      { modal: true, detail: `Steps: ${plan.steps.map((step) => `${step.label}${step.downloads ? " (may download)" : ""}`).join(" · ")}.\nWorker source and locks go under ${root}/${WORKER_FOLDER}; the notebook environment under notebooks/analysis; the record store under .research-toolkit/store. Your project .venv, source documents and existing MCP configuration are preserved. Toolkit servers are supplied by the extension.` },
      "Set up package components",
    );
    if (choice !== "Set up package components") return undefined;
    return runComponentPlan({ packageId, stepIds, title: "Research Toolkit component setup" });
  });

  register("researchToolkit.updateComponents", async () => {
    const folder = folderSelected();
    requireLocal(vscode, folder);
    const packageId = selectedPackage(vscode);
    await loadPlanArtifacts();
    const outdated = installer.outdatedSteps(packageId, receipt, WORKER_VERSION);
    const repair = planArtifactsNeedsRepair(packageId);
    if (!outdated.length && !repair.length) {
      const message = "No component step in this workspace needs updating: nothing is recorded by an earlier toolkit release, and every recorded step's files are present. Run component setup to install what is missing.";
      output.clear(); output.appendLine(message); output.show(true);
      return { ran: [], skipped: [], message };
    }
    const steps = [...new Set([...outdated, ...repair])];
    const choice = await vscode.window.showInformationMessage(
      `Update ${steps.length} component step(s) to toolkit ${WORKER_VERSION}?`,
      { modal: true, detail: `Steps: ${steps.join(", ")}.${repair.length ? ` ${repair.join(", ")} are recorded by this release but the files they produced are missing, so they are re-run as a repair.` : ""} Existing managed files that differ from this release are preserved and the step stops rather than overwriting them.` },
      "Update components",
    );
    if (choice !== "Update components") return undefined;
    return runComponentPlan({ packageId, stepIds: steps, force: true, title: "Research Toolkit component update" });
  });

  register("researchToolkit.installComponent", async (id) => {
    const folder = folderSelected();
    requireLocal(vscode, folder);
    const component = typeof id === "string" ? installer.COMPONENTS_BY_ID.get(id) : undefined;
    if (!component) throw new TypeError("Unknown component.");
    if (component.install.mode !== "managed" || !component.install.step) {
      throw new TypeError(`${component.title} is not installed by this extension. ${component.nextAction}`);
    }
    const packageId = selectedPackage(vscode);
    const steps = installer.stepsForComponents(packageId, [id]).map((step) => step.id);
    if (!steps.length) throw new TypeError(`${component.title} is not offered by the selected package. Switch the package preference first.`);
    return runComponentPlan({ packageId, stepIds: steps, title: `Research Toolkit: ${component.title}` });
  });

  function planArtifactsNeedsRepair(packageId) {
    const plan = installer.planView(packageId, receipt, WORKER_VERSION, planArtifacts);
    return plan.needsRepair;
  }

  register("researchToolkit.runReadingCheck", () => exclusive(async () => {
    const folder = folderSelected(); requireLocal(vscode, folder);
    const runtime = await managedRuntime(context, folder);
    if (!runtime) throw new Error("Set up package components before running the MCP reading check.");
    const currentGeneration = generation;
    progressMessage = "Running PDF/DOCX reading, corpus and record-store checks through local MCP…"; refresh();
    let result;
    try { result = await functionalCheck(context, runtime, folder, undefined, diagnosticServices); }
    catch (error) { if (generation === currentGeneration) readingResult = { ok: false, detail: error.message, checkedAt: new Date().toISOString() }; throw error; }
    if (generation === currentGeneration) {
      readingResult = result;
      toolSurface = result?.toolSurface || toolSurface;
      inventory = await checkInventory(vscode, context, folder, { ...diagnosticServices, functionalResult: result });
      await recordPresetInReceipt();
    }
    return result;
  }));
  register("researchToolkit.readSelectedDocument", () => exclusive(async () => {
    const folder = folderSelected(); requireLocal(vscode, folder);
    const runtime = await managedRuntime(context, folder);
    if (!runtime) throw new Error("Set up package components before reading a document.");
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, defaultUri: folder.uri,
      title: "Choose a workspace document for a read-only MCP check", filters: { "PDF or Word document": ["pdf", "docx"] } });
    if (!selected?.length) return undefined;
    const currentGeneration = generation;
    progressMessage = "Reading the selected document through local MCP…"; refresh();
    let result;
    try { result = await functionalCheck(context, runtime, folder, selected[0].fsPath, diagnosticServices); }
    catch (error) { if (generation === currentGeneration) readingResult = { ok: false, document: selected[0].fsPath.split(/[\\/]/).at(-1), detail: error.message, checkedAt: new Date().toISOString() }; throw error; }
    if (generation === currentGeneration) readingResult = result;
    output.clear(); output.appendLine(JSON.stringify(result, null, 2)); output.show(true);
    return result;
  }));
  const mcpProvider = {
    onDidChangeMcpServerDefinitions: changed.event,
    async provideMcpServerDefinitions() {
      const folder = folderSelected();
      if (!vscode.workspace.isTrusted || vscode.env.remoteName || !folder || folder.uri.scheme !== "file") return [];
      let runtime;
      try { runtime = await managedRuntime(context, folder); } catch { return []; }
      if (!runtime || folder !== folderSelected()) return [];
      receipt = runtime.receipt || receipt;
      toolSurface = runtime.receipt?.checks?.toolSurface || toolSurface;
      const preset = selectedPreset();
      const signature = presetSurfaceSignature(preset, runtime.version);
      appliedPreset = preset.id;
      appliedPresetSignature = signature;
      // A goal decides which tools are enabled; a server is only offered when that goal uses it.
      return presetCatalog.servers
        .filter((server) => server.tools.some((tool) => preset.tools.includes(tool)))
        .map((server) => {
          // VS Code starts these servers, not runner.js, so the reviewed interpreter flags have to be
          // stated here too: the protocol carries Czech document text, and a Windows console code page
          // is not UTF-8. The MCP SDK already writes UTF-8 bytes; this is the toolkit's own guarantee.
          const definition = new vscode.McpStdioServerDefinition(`Research Toolkit ${folder.name}: ${server.label}`, runtime.python,
            [...PYTHON_FLAGS, "-m", server.module], { RESEARCH_STACK_WORKSPACE: folder.uri.fsPath, RESEARCH_STACK_TOOL_PRESET: preset.id }, signature);
          definition.cwd = folder.uri;
          return definition;
        });
    },
    async resolveMcpServerDefinition(definition) {
      const current = await mcpProvider.provideMcpServerDefinitions();
      return current.find((item) => item.label === definition.label && item.command === definition.command);
    },
  };
  /**
   * The version a client compares to decide whether a server's tools changed. It covers the
   * runtime and the goal's tool surface, so switching preset signals a tool refresh.
   */
  function presetSurfaceSignature(preset, runtimeVersion) {
    const surface = crypto.createHash("sha256").update(JSON.stringify([...preset.tools].sort())).digest("hex").slice(0, 12);
    return `${runtimeVersion}+${preset.id}:${surface}`;
  }

  if (vscode.lm?.registerMcpServerDefinitionProvider) context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider("researchToolkit.local", mcpProvider));
  register("researchToolkit.checkComponents", () => {
    if (operation) throw new Error("Setup/reading is running. Wait for it to finish before checking components.");
    if (checking) return checking;
    const currentGeneration = generation;
    const folder = (vscode.workspace.workspaceFolders || [])[diagnosticsWorkspace];
    const task = checkInventory(vscode, context, folder, { ...diagnosticServices, settings: setupSettings() }).then((result) => {
      if (generation === currentGeneration) { inventory = result; refresh(); }
      return result;
    }).finally(() => { if (checking === task) { checking = undefined; refresh(); } });
    checking = task;
    return task;
  });
  register("researchToolkit.copyReadiness", async () => {
    await vscode.env.clipboard.writeText(readinessSummary());
    return "Readiness copied";
  });
  register("researchToolkit.copyPresetSummary", async () => {
    const summary = presetSummaryText();
    await vscode.env.clipboard.writeText(summary);
    output.clear(); output.appendLine(summary); output.show(true);
    return summary;
  });
  register("researchToolkit.diagnoseToolLimit", () => {
    const preset = selectedPreset();
    const estimate = presetEstimate(preset, toolSurface);
    const budget = presetCatalog.budget;
    const narrower = presetCatalog.presets
      .filter((item) => item.packages.includes(selectedPackage(vscode)) && item.id !== preset.id)
      .map((item) => ({ preset: item, estimate: presetEstimate(item, toolSurface) }))
      .sort((left, right) => left.estimate.totalTools - right.estimate.totalTools)
      .slice(0, 3);
    const lines = [
      `Tool limit diagnosis · toolkit ${context.extension.packageJSON.version}`,
      `Client ceiling: ${budget.clientCeiling} tools can be enabled at once in Copilot agent mode. The toolkit cannot raise or enforce it.`,
      `Toolkit contribution now: ${estimate.toolkitTools} toolkit tools from ${estimate.servers.length} managed MCP server(s) (${estimate.servers.join(", ") || "none"}).`,
      `External tools you configured: ${estimate.thirdPartyTools} (vendor-published toolset estimates; this extension neither starts nor measures those servers).`,
      `Total estimate: ${estimate.totalTools} of ${budget.clientCeiling} · headroom ${estimate.headroom} · level ${estimate.level}.`,
      `Tool definitions per request: ≈${estimate.tokensEstimate} tokens (${estimate.contextPercent}% of a ${Math.round(budget.contextWindowReference / 1000)}k window)${estimate.measured ? ", measured from the installed worker" : ", vendor estimate"}.`,
      `Accuracy guidance: assistants start choosing less reliably above about ${budget.accuracyBand} enabled tools; this extension warns from ${budget.ceilingWarning}.`,
      "Usual causes: the same server configured twice (portable .mcp.json plus native .vscode/mcp.json plus a provider-supplied copy), a third-party server at its default toolset, or a wide preset chosen for a narrow task.",
      narrower.length ? `Narrower presets this package offers: ${narrower.map((item) => `${item.preset.label} (${item.estimate.totalTools} tools)`).join(", ")}.` : "No narrower preset is offered by this package.",
      "Client-side controls: Chat: Open Customizations → Tools, Configure Tools for Local servers, and the virtual-tool grouping settings.",
    ];
    const text = lines.join("\n");
    output.clear(); output.appendLine(text); output.show(true);
    return text;
  });
  register("researchToolkit.refresh", async () => { await loadPlanArtifacts(); return refresh(); });

  /** R5-19: re-read the plan and re-verify artifacts, without running the functional check. */
  register("researchToolkit.refreshComponentStatus", async () => {
    const folder = folderSelected();
    requireLocal(vscode, folder);
    const packageId = selectedPackage(vscode);
    await loadPlanArtifacts();
    const status = await installer.refreshPlanStatus({ context, folder, packageId });
    receipt = status.receipt || receipt;
    const text = [
      `Component status refresh · toolkit ${TOOLKIT_VERSION} · ${new Date().toISOString()}`,
      setupSummary(status),
      `Steps: ${status.steps.map((step) => `${step.id}=${step.status}`).join(", ")}`,
      status.needsRepair.length ? `Needs repair: ${status.needsRepair.join(", ")}` : "No recorded step is missing its produced files.",
      status.omittedOptional.length ? `Deliberately omitted optional steps: ${status.omittedOptional.join(", ")}` : "No optional steps were skipped.",
      `Managed runtimes in this workspace: ${status.runtimes.map((item) => `${item.version}${item.active ? " (active)" : ""}${item.verified ? "" : " (unverified)"}`).join(", ") || "none"}`,
      "The functional MCP reading check was not run by this refresh; it stays a separate action.",
    ].join("\n");
    output.clear(); output.appendLine(text); output.show(true);
    refresh();
    return text;
  });

  /** R5-20: point the workspace back at a runtime an earlier release verified. */
  register("researchToolkit.rollbackRuntime", async () => {
    const folder = folderSelected();
    requireLocal(vscode, folder);
    const discovered = await discoverRuntimes(folder.uri.fsPath);
    const candidates = discovered.runtimes.filter((item) => !item.active);
    if (!candidates.length) throw new Error(`No other managed runtime exists in this workspace. Active: ${discovered.active ? discovered.active.version : WORKER_VERSION}.`);
    const picked = await vscode.window.showQuickPick(candidates.map((item) => ({
      id: item.version,
      label: `Runtime ${item.version}`,
      detail: `${item.folder}${item.recordedAt ? ` · recorded ${item.recordedAt}` : ""}${item.verified ? " · verified by its own setup" : " · no recorded verification"}`,
    })), { title: "Roll back to an earlier managed runtime", placeHolder: "The candidate is re-verified by the real reading check before it becomes active" });
    if (!picked) return undefined;
    const result = await exclusive(() => rollbackRuntime(vscode, context, folder, picked.id, diagnosticServices));
    output.clear();
    output.appendLine(`Rolled back to managed runtime ${result.version}. The previous runtime stays on disk. Active pointer: ${result.pointer}`);
    output.show(true);
    await loadPlanArtifacts();
    refresh();
    return result;
  });

  /** Re-run only the steps whose last attempt failed or was blocked. */
  register("researchToolkit.retryFailedSteps", async () => {
    const folder = folderSelected();
    requireLocal(vscode, folder);
    const packageId = selectedPackage(vscode);
    await loadInstallationStatus();
    const failed = installer.failedSteps(packageId, installationStatus);
    if (!failed.length) {
      await vscode.window.showInformationMessage(`No component step failed in ${folder.name}. Nothing to retry.`);
      return undefined;
    }
    const plan = installer.planView(packageId, receipt, WORKER_VERSION, await loadPlanArtifacts());
    const labels = plan.steps.filter((step) => failed.includes(step.id)).map((step) => step.label);
    const choice = await vscode.window.showInformationMessage(
      `Retry ${labels.length} component step(s) in ${folder.name}: ${labels.join(", ")}?`,
      { modal: true, detail: `The steps that completed stay as they are. Steps blocked by a failure are retried with their prerequisite. Preflight runs again before anything is written.` },
      "Retry failed steps",
    );
    if (choice !== "Retry failed steps") return undefined;
    return runComponentPlan({ packageId, stepIds: failed, title: "Research Toolkit: retry failed component steps" });
  });

  /** Remove only an interrupted setup lock, and only when it is classified stale. */
  register("researchToolkit.clearSetupLock", async () => {
    const folder = folderSelected();
    requireLocal(vscode, folder);
    const result = await clearStaleLock(folder.uri.fsPath);
    await loadInstallationStatus();
    refresh();
    if (result.removed) {
      await vscode.window.showInformationMessage(result.message);
      output.appendLine(result.message); output.show(true);
    } else {
      await vscode.window.showWarningMessage(result.message);
    }
    return result;
  });

  /** Open the recorded installation status and the setup log for reading. */
  register("researchToolkit.openSetupLog", async () => {
    const folder = folderSelected();
    requireLocal(vscode, folder);
    const { directory, statusFile } = setuplog.paths(folder.uri.fsPath);
    const log = await setuplog.readLog(folder.uri.fsPath, 60);
    const latest = log.files.length ? path.join(directory, log.files[log.files.length - 1]) : null;
    const target = latest || statusFile;
    const exists = await vscode.workspace.fs.stat(vscode.Uri.file(target)).then(() => true, () => false);
    if (!exists) throw new Error(`No setup log exists in ${folder.name} yet. Run Set up package components first.`);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    await vscode.window.showTextDocument(document, { preview: true });
    return target;
  });

  /** Copy the whole installation status as plain text for a report or an issue. */
  register("researchToolkit.copyInstallationDiagnostics", async () => {
    const folder = folderSelected();
    requireLocal(vscode, folder);
    await loadInstallationStatus();
    const log = await setuplog.readLog(folder.uri.fsPath, 40).catch(() => ({ files: [], lines: [] }));
    const text = statusModel.diagnosticsText(installationStatus, log);
    await vscode.env.clipboard.writeText(text);
    output.clear(); output.appendLine(text); output.show(true);
    await vscode.window.showInformationMessage("Installation diagnostics copied to the clipboard.");
    return text;
  });

  async function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.type === "ready") {
      panelReady = true;
      // The first paint should already report whether each recorded step still has the files it produced.
      await loadPlanArtifacts();
      refresh();
      return;
    }
    const actions = {
      readiness: "researchToolkit.showPhaseReadiness", settings: "researchToolkit.openSettings",
      help: "researchToolkit.openHelp", copy: "researchToolkit.copyReadiness", refresh: "researchToolkit.refresh",
      check: "researchToolkit.checkComponents", diagnose: "researchToolkit.diagnoseToolLimit",
      readingCheck: "researchToolkit.runReadingCheck", readDocument: "researchToolkit.readSelectedDocument",
      copyPreset: "researchToolkit.copyPresetSummary", status: "researchToolkit.refreshComponentStatus", rollback: "researchToolkit.rollbackRuntime",
      retry: "researchToolkit.retryFailedSteps", clearLock: "researchToolkit.clearSetupLock", setupLog: "researchToolkit.openSetupLog", copySetup: "researchToolkit.copyInstallationDiagnostics",
    };
    try {
      if (message.type === "setPackage") {
        if (!PACKAGES_BY_ID.has(message.id)) throw new TypeError("Choose a supported package.");
        await updateSetting("selectedPackage", message.id);
      } else if (message.type === "setOption") {
        if (!["showStatusBar", "openControlPanelOnStartup"].includes(message.key) || typeof message.value !== "boolean") {
          throw new TypeError("Unsupported interface option.");
        }
        await updateSetting(message.key, message.value);
      } else if (message.type === "setPreset") {
        const packageId = selectedPackage(vscode);
        if (message.id !== DEFAULT_PRESET && (!PRESETS_BY_ID.has(message.id) || !PRESETS_BY_ID.get(message.id).packages.includes(packageId))) {
          throw new TypeError("Choose a tools preset offered by the selected package.");
        }
        const target = message.scope === "workspaceFolder" ? vscode.ConfigurationTarget.WorkspaceFolder
          : message.scope === "workspace" ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await updateSetting("toolsPreset", message.id, target);
        if (message.id !== DEFAULT_PRESET) rememberPreset(message.id);
      } else if (message.type === "setup") {
        await runComponentPlan({ packageId: selectedPackage(vscode), stepIds: message.steps, title: "Research Toolkit component setup" });
      } else if (message.type === "update") {
        const packageId = selectedPackage(vscode);
        const outdated = installer.outdatedSteps(packageId, receipt, WORKER_VERSION);
        const requested = installer.resolveStepSelection(packageId, message.steps);
        const steps = requested.filter((id) => outdated.includes(id));
        if (!steps.length) throw new TypeError("No selected step is outdated for this toolkit release. Use Set up package components for missing steps.");
        await runComponentPlan({ packageId, stepIds: steps, force: true, title: "Research Toolkit component update" });
      } else if (message.type === "installComponent") {
        await vscode.commands.executeCommand("researchToolkit.installComponent", message.id);
      } else if (message.type === "selectWorkspace") {
        if (!Number.isInteger(message.index) || message.index < 0 || message.index >= (vscode.workspace.workspaceFolders || []).length) throw new TypeError("Choose an open workspace folder.");
        diagnosticsWorkspace = message.index;
        invalidateInventory();
      } else if (message.type === "guide" || message.type === "docs") {
        if (typeof message.id !== "string" || !COMPONENTS_BY_ID.has(message.id)) throw new TypeError("Unknown component guide.");
        await vscode.commands.executeCommand(message.type === "guide" ? "researchToolkit.openComponentGuide" : "researchToolkit.openComponentDocs", message.id);
      } else if (message.type === "action" && Object.hasOwn(actions, message.action)) {
        await vscode.commands.executeCommand(actions[message.action]);
      } else {
        throw new TypeError("Unsupported control panel action.");
      }
      const echo = message.requestId === undefined ? {} : { requestId: message.requestId };
      if (panel) await panel.webview.postMessage({ type: "result", ...echo, message: message.type === "action" && message.action === "copy" ? "Readiness copied to clipboard." : "Done." });
    } catch (error) {
      refresh();
      const echo = message.requestId === undefined ? {} : { requestId: message.requestId };
      if (panel) await panel.webview.postMessage({ type: "result", ...echo, error: error instanceof Error ? error.message : "Unable to complete this action." });
    }
  }

  function openControlPanel() {
    if (panel) { panel.reveal(vscode.ViewColumn.One); return panel; }
    panel = vscode.window.createWebviewPanel("researchToolkit.controls", "Research Toolkit", vscode.ViewColumn.One, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    const opened = panel;
    panelReady = false;
    opened.webview.html = controlPanelHtml(opened.webview, context.extensionUri, vscode.Uri);
    const messages = opened.webview.onDidReceiveMessage(handleMessage);
    const closed = opened.onDidDispose(() => { messages.dispose(); closed.dispose(); if (panel === opened) { panel = undefined; panelReady = false; } });
    return opened;
  }
  register("researchToolkit.openControlPanel", () => { openControlPanel(); });
  context.subscriptions.push({ dispose() { if (panel) panel.dispose(); } });

  const provider = {
    onDidChangeTreeData: changed.event,
    getTreeItem(item) { return item; },
    getChildren() {
      const current = state();
      const plan = current.installPlan;
      const pending = (plan.counts.missing || 0) + (plan.counts.outdated || 0);
      return [
        ["Open Control Panel", "researchToolkit.openControlPanel", "settings-gear"],
        [`Package: ${PACKAGES_BY_ID.get(current.selectedPackage).label}`, "researchToolkit.switchPackage", "package"],
        [`Tools preset: ${PRESETS_BY_ID.get(current.selectedToolsPreset).label}`, "researchToolkit.selectToolsPreset", "tools"],
        [`Components: ${plan.steps.filter((step) => step.status === "installed").length}/${plan.steps.length} steps ready`, "researchToolkit.setupLocalComponents", "cloud-download"],
        ["Set Up Local Components", "researchToolkit.setupLocalComponents", "tools"],
        ["Update Outdated Components", "researchToolkit.updateComponents", "cloud-upload"],
        ["Show Phase Readiness", "researchToolkit.showPhaseReadiness", "checklist"],
        ["Check Installed Components", "researchToolkit.checkComponents", "inspect"],
        ["Run MCP Reading Check", "researchToolkit.runReadingCheck", "check"],
        ["Read Selected Document", "researchToolkit.readSelectedDocument", "file-text"],
        ["Diagnose Tool Limit", "researchToolkit.diagnoseToolLimit", "warning"],
        ["Copy Readiness", "researchToolkit.copyReadiness", "copy"],
        ["Extension Settings", "researchToolkit.openSettings", "settings"],
        ["Component Guides & Onboarding", "researchToolkit.openHelp", "book"],
      ].map(([label, command, icon]) => {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.command = { command, title: label };
        item.iconPath = new vscode.ThemeIcon(icon);
        item.tooltip = command === "researchToolkit.switchPackage" ? "Change saved package preference; the next setup offers this package's steps."
          : command === "researchToolkit.selectToolsPreset" ? "Choose the goal-shaped tools preset. It changes which tools the assistant is offered; nothing is installed."
            : command === "researchToolkit.setupLocalComponents" ? `Install this package's component steps (${pending} pending). Existing files and project environments are preserved.`
              : command === "researchToolkit.updateComponents" ? `Refresh component steps recorded by an earlier toolkit release. ${plan.counts.outdated || 0} outdated now.`
                : command === "researchToolkit.diagnoseToolLimit" ? "Explain the client tool ceiling and what this toolkit contributes to it."
                  : label;
        return item;
      });
    },
  };
  context.subscriptions.push(vscode.window.registerTreeDataProvider("researchToolkit.overview", provider));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("researchStack.uvPath")) clearHostToolCache();
    if (event.affectsConfiguration("researchStack")) refresh();
  }));
  function invalidateInventory() {
    generation++;
    checking = undefined;
    inventory = baseInventory(vscode, context);
    readingResult = undefined;
    receipt = undefined;
    // Measurements belong to the folder they were taken from; a new folder starts unmeasured.
    toolSurface = undefined;
    planArtifacts = new Map();
    installationStatus = null;
    installationLogFiles = [];
    appliedPreset = undefined;
    appliedPresetSignature = undefined;
    refresh();
    void loadWorkspaceState();
  }

  /** Load the measured tool surface and component receipt from an existing workspace without blocking activation. */
  async function loadWorkspaceState() {
    const folder = folderSelected();
    if (!folder || folder.uri.scheme !== "file") return;
    const startedAt = generation;
    let runtime;
    try { runtime = await managedRuntime(context, folder); } catch { return; }
    if (startedAt !== generation) return;
    const measured = runtime?.receipt?.checks?.toolSurface;
    const changedSomething = Boolean(measured && measured !== toolSurface) || Boolean(runtime?.receipt && runtime.receipt !== receipt);
    if (measured) toolSurface = measured;
    if (runtime?.receipt) receipt = runtime.receipt;
    await loadPlanArtifacts();
    if (startedAt !== generation) return;
    if (changedSomething) refresh();
  }
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { diagnosticsWorkspace = 0; invalidateInventory(); }));
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(invalidateInventory));
  context.subscriptions.push(vscode.extensions.onDidChange(invalidateInventory));

  const showReadiness = vscode.commands.registerCommand("researchToolkit.showPhaseReadiness", () => {
    const status = readinessSummary();
    output.clear();
    output.appendLine(status);
    output.show(true);
    return status;
  });
  context.subscriptions.push(showReadiness);

  const switchPackage = vscode.commands.registerCommand("researchToolkit.switchPackage", async (requestedId) => {
    let selectedId = requestedId;
    if (selectedId === undefined) {
      const currentId = selectedPackage(vscode);
      const current = PACKAGES_BY_ID.get(currentId) || PACKAGES_BY_ID.get(DEFAULT_PACKAGE);
      const picked = await vscode.window.showQuickPick(
        PACKAGE_OPTIONS.map(({ id, label, detail }) => ({
          id,
          label,
          detail,
          description: id === current.id ? "Currently selected" : undefined,
        })),
        { title: "Select a Research Stack package", placeHolder: "This changes the saved preference and the component steps setup offers" },
      );
      if (!picked) return undefined;
      selectedId = picked.id;
    }
    const selected = PACKAGES_BY_ID.get(selectedId);
    if (!selected) throw new TypeError(`Unknown Research Stack package: ${String(selectedId)}`);

    await updateSetting("selectedPackage", selected.id);
    const status = readinessSummary(selected.id);
    output.clear();
    output.appendLine(status);
    output.show(true);
    return status;
  });
  context.subscriptions.push(switchPackage);

  const selectToolsPreset = vscode.commands.registerCommand("researchToolkit.selectToolsPreset", async (requestedId) => {
    const packageId = selectedPackage(vscode);
    const offered = presetsForPackage(packageId);
    const currentId = selectedPresetId(vscode);
    const recent = recentPresets();
    let selectedId = requestedId;
    if (selectedId === undefined) {
      const ordered = [...recent.filter((id) => offered.some((preset) => preset.id === id)).map((id) => offered.find((preset) => preset.id === id)),
        ...offered.filter((preset) => !recent.includes(preset.id))];
      const picked = await vscode.window.showQuickPick(
        [...ordered, { id: DEFAULT_PRESET, label: "Follow the package default", goal: "Use the preset recommended for the selected package." }].map((preset) => {
          const estimate = presetEstimate(PRESETS_BY_ID.get(preset.id) || PRESETS_BY_ID.get(defaultPresetFor(packageId)), toolSurface);
          const recentlyUsed = recent.includes(preset.id) ? " · recently used" : "";
          const applied = appliedPreset === preset.id ? " · applied" : "";
          return {
            id: preset.id,
            label: preset.label,
            detail: preset.goal,
            description: preset.id === DEFAULT_PRESET
              ? `Default for this package: ${PRESETS_BY_ID.get(defaultPresetFor(packageId)).label}`
              : `${estimate.toolkitTools} toolkit tools · ≈${Math.round(estimate.tokensEstimate / 100) / 10}k tokens (${estimateLabel(estimate)})${recentlyUsed}${applied}`,
          };
        }),
        { title: "Choose a tools preset for your goal", placeHolder: "Fewer, goal-shaped tools usually make tool selection more reliable" },
      );
      if (!picked) return undefined;
      selectedId = picked.id;
    }
    if (selectedId !== DEFAULT_PRESET && (!PRESETS_BY_ID.has(selectedId) || !PRESETS_BY_ID.get(selectedId).packages.includes(packageId))) {
      throw new TypeError(`Unknown tools preset for the selected package: ${String(selectedId)}`);
    }
    await updateSetting("toolsPreset", selectedId);
    if (selectedId !== DEFAULT_PRESET) rememberPreset(selectedId);
    const status = readinessSummary(packageId);
    output.clear();
    output.appendLine(status);
    output.show(true);
    return status;
  });
  context.subscriptions.push(selectToolsPreset);

  register("researchToolkit.selectComponentStep", async () => {
    const packageId = selectedPackage(vscode);
    await loadPlanArtifacts();
    const plan = installer.planView(packageId, receipt, WORKER_VERSION, planArtifacts);
    const picked = await vscode.window.showQuickPick(plan.steps.map((step) => ({
      id: step.id,
      label: step.label,
      detail: step.description,
      description: `${step.status === "installed" ? "Installed and verified" : step.status === "outdated" ? `Outdated (${step.installedVersion})` : step.status === "needs-repair" ? "Recorded, but files are missing — repair" : "Not installed"} · ${step.components.length} component(s)${step.downloads ? " · may download" : ""}${step.omitted ? " · optional, not installed" : ""}`,
    })), { title: `Run one ${plan.package.label} component step`, placeHolder: "Missing prerequisites are added automatically" });
    if (!picked) return undefined;
    return runComponentPlan({ packageId, stepIds: [picked.id], title: `Research Toolkit: ${picked.label}` });
  });

  refresh();
  void loadWorkspaceState();
  if (state().openControlPanelOnStartup) openControlPanel();
  return { openControlPanel, state, mcpProvider, isControlPanelReady: () => panelReady };
}

/** Saved package preference; unknown values fall back to the shipped default. */
function selectedPackage(vscode) {
  const configured = vscode.workspace.getConfiguration("researchStack").get("selectedPackage", DEFAULT_PACKAGE);
  return PACKAGES_BY_ID.has(configured) ? configured : DEFAULT_PACKAGE;
}

/** Saved preset id, or "package-default" when the preset follows the package choice. */
function toolsPresetSetting(vscode) {
  const configured = vscode.workspace.getConfiguration("researchStack").get("toolsPreset", DEFAULT_PRESET);
  return typeof configured === "string" && (configured === DEFAULT_PRESET || PRESETS_BY_ID.has(configured)) ? configured : DEFAULT_PRESET;
}

/** Where the preset value is coming from: the user profile or a workspace-folder override. */
function presetScope(configuration) {
  const detail = typeof configuration.inspect === "function" ? configuration.inspect("toolsPreset") : undefined;
  if (!detail) return "profile";
  if (detail.workspaceFolderValue !== undefined) return "workspaceFolder";
  if (detail.workspaceValue !== undefined) return "workspace";
  return "profile";
}

/** The preset actually in force: a saved preset must also be offered by the current package. */
function selectedPresetId(vscode) {
  const packageId = selectedPackage(vscode);
  const configured = toolsPresetSetting(vscode);
  const preset = PRESETS_BY_ID.get(configured);
  if (configured === DEFAULT_PRESET || !preset || !preset.packages.includes(packageId)) return defaultPresetFor(packageId);
  return configured;
}

/** Last presets the operator used, newest first, so switching back is one click. */
function readRecentPresets(context) {
  const store = context.globalState && typeof context.globalState.get === "function" ? context.globalState.get(RECENT_PRESET_STATE_KEY) : undefined;
  return Array.isArray(store) ? store.filter((id) => PRESETS_BY_ID.has(id)).slice(0, RECENT_PRESET_LIMIT) : [];
}

function activate(context) {
  return activateWith(require("vscode"), context);
}

module.exports = {
  activate, activateWith, readinessText, setupSummary, PACKAGE_OPTIONS, DEFAULT_PACKAGE, STATE_KEY,
  PRESET_STATE_KEY, RECENT_PRESET_STATE_KEY, DEFAULT_PRESET, PRESETS_BY_ID, presetCatalog,
  presetsForPackage, defaultPresetFor, presetEstimate, presetViews, selectedPresetId, toolsPresetSetting,
  presetScope, readRecentPresets,
};
