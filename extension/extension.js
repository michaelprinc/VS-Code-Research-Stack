"use strict";

const crypto = require("node:crypto");
// 0.3.14 (HR-12): reading and replacing the workspace `.mcp.json` needs real file calls, so the
// controller imports the same promises `fs` module `bundles.js` and `runtime.js` already use.
const fsAsync = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const TOOLKIT_VERSION = require("./package.json").version;
const PUBLISHER_ID = require("./package.json").publisher;
const EXTENSION_NAME = require("./package.json").name;
const EXTENSION_ID = `${PUBLISHER_ID}.${EXTENSION_NAME}`;
const DEFAULT_PACKAGE = "recommended";
const DEFAULT_PRESET = "package-default";
const STATE_KEY = "researchStack.selectedPackage";
const PRESET_STATE_KEY = "researchStack.toolsPreset";
const RECENT_PRESET_STATE_KEY = "researchStack.recentPresets";
const RECENT_PRESET_LIMIT = 3;
const { controlPanelHtml } = require("./ui");
const { baseInventory, checkInventory, inventoryText } = require("./diagnostics");
const { requireLocal, managedRuntime, setupRuntime, functionalCheck, bundle, directory, discoverRuntimes, rollbackRuntime, WORKER_FOLDER, WORKER_VERSION, MANAGED_FOLDER } = require("./runtime");
const installer = require("./installer");
const setuplog = require("./setuplog");
const statusModel = require("./status");
const { clearStaleLock, inspectLock, setupWindowMs } = require("./preflight");
const { clearHostToolCache } = require("./hosttools");
const { PYTHON_FLAGS, asRunProcess } = require("./runner");
const bundles = require("./bundles");
// 0.3.14 (HR-11, HR-12): the pure preset→Copilot selection module. It reads nothing and writes nothing;
// it turns one preset's named GitHub tool list into the text the Copilot harness reads, and refuses a
// preset whose stated tool count is not the length of that list.
const presetSelect = require("./presetselect");
// 0.3.10: the published-version check and the problem-report builder. `updates.js` is the one reviewed
// module in the package that may reach the network; `scripts/verify_vsix.py` names it on the shipped
// bytes and `test/module-boundaries.test.js` counts which modules do in the source tree.
const updates = require("./updates");
const reportBuilder = require("./reports");
// 0.3.11: the integration onboarding. Three pure modules — the state model, the storage adapter over
// the mementos VS Code hands us, and the worker probe's argv/receipt. None of them can reach a network
// transport: the readiness probe is a worker verb, so the reviewed network boundary stays where 0.3.10 measured it.
const integrations = require("./integrations");
const integrationStore = require("./integrationstore");
const integrationProbe = require("./integrationprobe");
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
// J3: the machine record is a small local file the Toolkit's own worker reads. The probe's 20 s is the bound for
// reaching a loopback app and a hosted API, not this read's timing contract; 20 s under the lock made "Check now" throw.
const MACHINE_FACT_READ_TIMEOUT_MS = 5_000;

/** Presets offered for a package: the goal list changes with the package choice. */
function presetsForPackage(packageId) {
  // A retired preset (DD15-07) is never offered: 0.3.14 does not present a surface whose third-party
  // tools it cannot name. It stays in PRESETS_BY_ID and in the worker, so an operator who saved it in
  // 0.3.13 keeps the surface they had instead of silently receiving a different one.
  return presetCatalog.presets.filter((preset) => !preset.retired && preset.packages.includes(packageId));
}

function defaultPresetFor(packageId) {
  const presets = presetsForPackage(packageId);
  const fallback = presets[0] || presetCatalog.presets[0];
  return (presets.find((preset) => (preset.defaultFor || []).includes(packageId)) || fallback).id;
}

/**
 * DD15-07: what a retired preset has to say out loud. A retired preset is never offered by a package and
 * never a package default, but a preference saved in 0.3.13 still resolves to it — that is the point of
 * retiring instead of deleting. So the replacement is named where the operator is looking (panel state,
 * the preset Quick Pick) rather than being implied by a row that is missing.
 * Returns undefined when the preset is not retired. Successors are named by id and label; the sentence
 * also says whether this package can actually take one, because naming only a preset the operator cannot
 * choose here would be advice they cannot follow. Nothing in this text claims the retirement changed
 * anything in the workspace: the preset still carries the same verbs, and no file was rewritten to retire it.
 */
function presetRetirement(preset, packageId) {
  if (!preset || !preset.retired) return undefined;
  const successors = (preset.successor || []).map((id) => PRESETS_BY_ID.get(id)).filter(Boolean);
  const offered = successors.filter((item) => !item.retired && item.packages.includes(packageId));
  const names = successors.map((item) => `${item.id} (${item.label})`).join(", ") || "none named";
  const where = offered.length
    ? `Replaced by: ${offered.map((item) => `${item.id} (${item.label})`).join(", ")}.`
    : `No replacement is offered by the ${packageId} package; the presets that replace it — ${names} — are offered by ${[...new Set(successors.flatMap((item) => item.packages))].join(" / ")}.`;
  return `Tools preset "${preset.label}" (${preset.id}) is retired in 0.3.14: its third-party surface was an unnamed toolset estimate, which 0.3.14 presets no longer allow. ${where} Your saved value still resolves to it until you choose one.`;
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

  // 0.3.10: the transport the version check uses. The shipped value is `updates.httpsGet`, the one
  // bounded HTTPS GET the packaging audit reviews. A host harness may replace it so the update logic is
  // driven with a recorded reply instead of a live request — the tests never reach the Marketplace, and
  // the shipped path is still the one the audit measured.
  const updateTransport = (diagnosticServices && diagnosticServices.updateTransport) || updates.httpsGet;

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
  // 0.3.10: what the last published-version check said, and what failed in this session. Both are
  // session state — neither is written to disk, and neither is sent anywhere by itself.
  let recentErrors = [];
  let updateCheck = null;
  let lastReport = null;
  // 0.3.11: the integration record is global to this VS Code profile, so a second workspace does not
  // re-run the guide. It is read once at activation and written only after an operator decision.
  let integrationRegistry = integrationStore.loadRegistry(context.globalState);
  // INT-15: why the machine installation record was not used, if it was not. Session state only — it is a
  // sentence for this window, never a fact written to the profile, and it is cleared by the next read.
  let integrationFactsNote = null;
  // J4: whether a readiness check could run here at all. The host learns it from the `managedRuntime` calls it
  // already makes, so the model can say "no check here" instead of offering a button that answers with a setup error.
  let managedWorkerPresent = false;
  /** The one place the host asks for the managed worker, so every ask also answers J4. */
  async function probeRuntime(folder) {
    managedWorkerPresent = false;
    const runtime = await managedRuntime(context, folder);
    managedWorkerPresent = Boolean(runtime);
    return runtime;
  }
  function probeCapability() {
    const folder = folderSelected();
    return Boolean(vscode.workspace.isTrusted && !vscode.env.remoteName && folder && folder.uri.scheme === "file" && managedWorkerPresent);
  }

  async function saveIntegrations(registry) {
    integrationRegistry = await integrationStore.saveRegistry(context.globalState, registry);
    changed.fire();
    return integrationRegistry;
  }
  /**
   * HR-30 (finding R15-04): the one place the two integration settings are read, and the one place their
   * values are clamped. `integrationprobe.js` publishes the defaults and the range; this function hands the
   * operator's numbers to that clamp and gives every caller the same result, so the timeout the worker call
   * runs under, the window the card counts down and the window a refused press is told are one resolved
   * value rather than three numbers kept in three files. A value the clamp replaced is not invisible: the
   * sentence naming the setting, what was set and what was used is written to the Toolkit output channel
   * beside the receipt it governed — this release does not show the bound on the card, and does not claim to.
   */
  function integrationBounds() {
    const config = vscode.workspace.getConfiguration("researchStack");
    return integrationProbe.probeBounds({
      integrationTimeoutMs: config.get("integrationTimeoutMs", integrationProbe.PROBE_TIMEOUT_MS),
      integrationCooldownSeconds: config.get("integrationCooldownSeconds", integrationProbe.PROBE_COOLDOWN_MS / 1000),
    });
  }
  /** The panel sees states and sentences. It never sees a stored key — only whether one exists. */
  function integrationPanelState() {
    const canProbe = probeCapability();
    const bounds = integrationBounds();
    return {
      // J4: the host states whether a check is possible here, and the model decides what the card says about it.
      views: integrations.integrationViews(integrationRegistry, { now: new Date().toISOString(), canProbe, cooldownMs: bounds.cooldownMs }),
      canProbe,
      // Names only: what the operator already configured outside the Toolkit, so it is reported and
      // preserved rather than silently replaced (DD11-08).
      environment: integrationStore.environmentFootprint(process.env),
      cooldownMs: bounds.cooldownMs,
      lastProbeAt: integrationRegistry.lastProbeAt || null,
      // INT-15: stated, not swallowed — the reason the machine record was not used, when it was not.
      factsNote: integrationFactsNote,
      licenseUrl: integrations.LICENSE_URL,
      // Both official texts, because they do not say the same thing and the operator would tick the other one.
      apiLicenseUrl: integrations.API_LICENSE_URL,
      licenseReference: integrations.LICENSE_REFERENCE,
    };
  }
  function integrationView(provider) {
    if (!integrations.PROVIDERS.includes(provider)) throw new TypeError("Unknown integration.");
    const bounds = integrationBounds();
    return integrations.integrationViews(integrationRegistry, { now: new Date().toISOString(), canProbe: probeCapability(), cooldownMs: bounds.cooldownMs }).find((item) => item.id === provider);
  }
  /** A readiness probe needs a worker, a trusted local folder, and the operator having asked for it. */
  async function runIntegrationProbe(provider) {
    const folder = folderSelected();
    if (!vscode.workspace.isTrusted || vscode.env.remoteName || !folder || folder.uri.scheme !== "file") {
      throw new Error("Integrations are checked only in a trusted local workspace folder. A remote or untrusted workspace gets no local access.");
    }
    // HR-30: resolved once per press, then handed to the window the press is measured against, to the worker
    // call, and to the log line that reports the receipt — the same numbers for all three.
    const bounds = integrationBounds();
    const cooldown = integrations.probeCooldown({ lastProbeAt: integrationRegistry.lastProbeAt, now: new Date().toISOString(), cooldownMs: bounds.cooldownMs });
    // J7: the number given is the wait that remains, not the age of the last check, and it says what to do next.
    if (!cooldown.allowed) throw new Error(`The next integration check is allowed in ${Math.ceil(cooldown.waitMs / 1000)} s. Several VS Code windows share one check budget, so wait that long and press Check now again — the last verdict is still on the card, and nothing you did was lost.`);
    const runtime = await probeRuntime(folder);
    if (!runtime) throw new Error("Set up package components before checking integrations. The check runs in the same locked worker that serves the research tools.");
    progressMessage = "Checking integrations…"; refresh();
    const apiKey = integrations.isAuthorized(integrationRegistry, "semantic-scholar") && integrationRegistry.providers["semantic-scholar"].mode === "api-key"
      ? await integrationStore.readApiKey(context.secrets, "semantic-scholar") : undefined;
    // A record carried over from an older release can claim a key this profile's secret storage does not hold.
    // Once the Toolkit has actually looked, the panel stops saying a key is present: the claim is corrected by
    // the evidence, and only for an integration the operator authorized.
    if (integrations.isAuthorized(integrationRegistry, "semantic-scholar")
      && integrationRegistry.providers["semantic-scholar"].credentials.configured !== Boolean(apiKey)) {
      await saveIntegrations(integrations.setCredentialConfigured(integrationRegistry, "semantic-scholar", Boolean(apiKey), new Date().toISOString()));
    }
    const executed = await asRunProcess(diagnosticServices || {})(runtime.python,
      [...PYTHON_FLAGS, "-m", "research_stack.cli", ...integrationProbe.probeArgv({ providers: provider ? [provider] : integrations.PROVIDERS })],
      { timeout: bounds.timeoutMs, cwd: folder.uri.fsPath, env: { ...process.env, ...integrationProbe.probeEnvironment({ registry: integrationRegistry, apiKey }) } });
    if (executed.exitCode !== 0) throw new Error(`The integration check failed: ${String(executed.stderr || "").slice(-300) || "the worker refused without a message."}`);
    let receipt;
    try { receipt = JSON.parse(executed.stdout); } catch { throw new Error("The integration check returned unreadable data. Nothing was recorded from it."); }
    const probed = integrationProbe.interpretReceipt(receipt);
    const at = new Date().toISOString();
    let next = integrationRegistry;
    // The receipt keys providers by the worker's own spelling; the record keys them by the Toolkit's.
    // Mapping them wrong would silently discard Semantic Scholar's verdict, so the mapping is explicit.
    for (const id of (provider ? [provider] : integrations.PROVIDERS)) {
      next = integrations.recordProbe(next, id, probed[id === "semantic-scholar" ? "semanticScholar" : id], at);
    }
    // The shared budget is a number in storage (see `recordProbe`); keeping the ISO text here would make the
    // cooldown unread and every window would probe again.
    next = { ...next, lastProbeAt: Date.parse(at) };
    await saveIntegrations(next);
    const ids = provider ? [provider] : integrations.PROVIDERS;
    const sentences = ids.map((id) => {
      const view = integrations.integrationViews(next, { now: at, cooldownMs: bounds.cooldownMs }).find((item) => item.id === id);
      // The worker's own sentence is the specific one; the model's is the one that names what it means
      // for the operator (a 429 keeps the authorization, a refused local API is not a missing app). The
      // provider's name leads it: a verdict that does not say which service it is about is not actionable.
      return `${view.title} — ${view.label}: ${view.detail}`;
    });
    // J6: a failure sentence is needed when the check did not answer, and is noise when it did. The old
    // filter looked for a word the model's sentence never says, so it never fired.
    const failures = ids
      .map((id) => ({ id, outcome: probed[id === "semantic-scholar" ? "semanticScholar" : id] }))
      .filter((item) => item.outcome.outcome !== "ready")
      .map((item) => integrationProbe.describeProbeFailure(item.id, item.outcome))
      .filter(Boolean);
    output.clear();
    // HR-30: a bound the clamp replaced is stated before the receipt it governed, so an operator who set a
    // number outside the range can see which number this check actually ran under. Written before the receipt
    // block, never after it, because the block stays the last line the panel path and the tests read.
    for (const sentence of bounds.clamped) output.appendLine(`Setting clamped: ${sentence}`);
    // The worker's own sentences come from a run that may have been handed the API key, so they are
    // scrubbed before anything is written to a channel an operator might paste somewhere.
    output.appendLine(`Integration check ${at} — the worker call ran under a ${bounds.timeoutMs} ms bound and the next check is allowed in ${bounds.cooldownSeconds} s\n${integrationStore.redactSecrets(JSON.stringify(probed, null, 2), [apiKey]).text}\n\n${sentences.join("\n")}${failures.length ? `\n${failures.join("\n")}` : ""}`);
    output.show(true);
    // J1: the verdict has to reach the panel that asked for it. "Done." told the operator nothing, and when the
    // state did not change the card re-rendered identically, so the press looked like a no-op.
    return { probed, summary: sentences.join(" · ") };
  }

  /**
   * INT-15 (DD12-02): the machine-level installation fact. It is read when the operator opens the integrations
   * flow, or presses the card's "What did this machine find?" to read it again — never at activation, never on
   * a timer, and at most once per opening. Nothing here reads a secret or probes a service: the call is the
   * worker's own `integration-facts` verb through the same bounded `runner.js` path the readiness check uses,
   * and the credential-shaped names this editor process happens to carry are removed from it before it is
   * built. A record this release cannot use is refused with the reason stated, kept in `integrationFactsNote`
   * so the panel and the Quick Pick can say it out loud, and the profile record is left exactly as it was.
   * J3: the call carries its own short bound (`MACHINE_FACT_READ_TIMEOUT_MS`), not the readiness check's — that
   * one reaches two services and is now the operator's setting (`researchStack.integrationTimeoutMs`); a local
   * file read by the Toolkit's own worker does not inherit it.
   */
  async function readIntegrationFacts() {
    integrationFactsNote = null;
    try {
      return await readMachineFacts();
    } catch (error) {
      integrationFactsNote = error instanceof Error ? error.message : "The machine installation record could not be read.";
      throw error;
    }
  }

  async function readMachineFacts() {
    const folder = folderSelected();
    if (!vscode.workspace.isTrusted || vscode.env.remoteName || !folder || folder.uri.scheme !== "file") {
      throw new Error("The machine installation record is read only in a trusted local workspace folder. A remote or untrusted workspace gets no local access.");
    }
    const runtime = await probeRuntime(folder);
    if (!runtime) throw new Error("Set up package components before reading the machine installation record: the Toolkit reads it through its own locked worker.");
    const environment = { ...process.env };
    for (const name of integrationStore.ENVIRONMENT_NAMES) delete environment[name];
    const executed = await asRunProcess(diagnosticServices || {})(runtime.python,
      [...PYTHON_FLAGS, "-m", "research_stack.cli", ...integrationProbe.factsArgv()],
      // J3: a local file read by the Toolkit's own worker gets its own short bound, not the readiness check's:
      // that bound reaches two services and the operator sets it, so this read must not follow it.
      { timeout: MACHINE_FACT_READ_TIMEOUT_MS, cwd: folder.uri.fsPath, env: environment });
    if (executed.exitCode !== 0) throw new Error(`The Toolkit could not read the machine installation record: ${String(executed.stderr || "").slice(-300) || "the worker refused without a message."} Nothing was changed.`);
    let parsed;
    try { parsed = JSON.parse(executed.stdout); } catch { throw new Error("The machine installation record came back unreadable. Nothing was changed."); }
    const facts = integrationProbe.interpretFacts(parsed);
    if (!facts) throw new Error(`The Toolkit did not use the machine installation record: ${integrationProbe.factRejectionReason(parsed)}. Nothing was changed.`);
    const at = new Date().toISOString();
    let next = integrationRegistry;
    const read = [];
    for (const provider of integrationProbe.FACT_PROVIDERS) {
      if (!facts[provider]) continue;
      next = integrations.applyMachineFact(next, provider, facts[provider], at);
      read.push(integrations.NAMES[provider]);
    }
    if (!read.length) return "The machine installation record holds no installation fact for this machine yet.";
    await saveIntegrations(next);
    const view = integrations.integrationViews(next, { now: at }).find((item) => item.id === "zotero");
    // The fact did not win: this profile's own check is the more recent evidence, and the operator is told
    // which of the two the record kept rather than left to compare two timestamps.
    const stands = next.providers.zotero.installationSource === "profile-check";
    return `Machine installation record read for ${read.join(", ")}. ${stands ? "This profile's own check is more recent than the machine record, so the check stands." : view.installationProvenance}`;
  }

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
      `${preset.label} · ${estimate.toolkitTools} toolkit tools${estimate.thirdPartyTools ? ` + ${estimate.thirdPartyTools} configured external tools${namedSurface(preset) ? " (tools the preset names)" : " (vendor estimates)"}` : ""} · ≈${Math.round(estimate.tokensEstimate / 100) / 10}k tokens (${estimateLabel(estimate)})`,
      installer.planView(packageId, receipt, WORKER_VERSION, planArtifacts));
  }

  /** True when every third-party entry of this preset names the tools it counts (HR-11). */
  function namedSurface(preset) {
    const entries = preset.thirdParty || [];
    return entries.length > 0 && entries.every((item) => Array.isArray(item.tools) && item.tools.length === item.toolsEstimate);
  }

  /**
   * Say what an external tool number actually is (HR-11). A preset that names its tools has a count that
   * is the length of its own list; a preset that names nothing is carrying a vendor toolset estimate.
   * Those are different claims and 0.3.14 does not use one wording for both. Neither wording claims that
   * the server was started or measured here — this extension neither starts nor measures them — and a
   * named count is still a vendor-published name list until the operator captures `tools/list` on their host.
   */
  function externalSurfaceText(preset) {
    const entries = preset.thirdParty || [];
    if (!entries.length) return "none";
    return entries.map((item) => {
      const named = Array.isArray(item.tools) ? item.tools.length : 0;
      return named && named === item.toolsEstimate
        ? `${item.label} — ${named} tools this preset names by name (vendor-published names, not measured by this extension)`
        : `${item.label} ≈${item.toolsEstimate} tools (vendor toolset estimate)`;
    }).join(" · ");
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
      // DD15-07: a summary of a retired preset has to say it is retired, or the operator pastes a surface
      // description that 0.3.14 no longer offers into a note and treats it as current.
      ...(presetRetirement(preset, selectedPackage(vscode)) ? [presetRetirement(preset, selectedPackage(vscode))] : []),
      `Goal: ${preset.goal}`,
      `Toolkit tools (${estimate.toolkitTools}): ${preset.tools.join(", ")}`,
      `Toolkit MCP servers offered: ${estimate.servers.join(", ") || "none"}`,
      `External tools you configure: ${externalSurfaceText(preset)}`,
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
      // DD15-07: the retirement is stated in the state, not left for the panel to infer from a missing row.
      // Text when the preset in force is retired, undefined otherwise — so a live preset gains no new claim.
      presetRetirement: presetRetirement(selectedPreset(), packageId),
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
      // 0.3.10: what the last published-version check said, and where the last problem report went.
      update: updateCheck ? {
        state: updateCheck.state,
        installedVersion: updateCheck.installedVersion || TOOLKIT_VERSION,
        publishedVersion: updateCheck.publishedVersion || null,
        requiredEngine: updateCheck.requiredEngine || null,
        checkedAtText: updateCheck.checkedAtText || null,
        held: Boolean(updateCheck.held),
        cached: Boolean(updateCheck.cached),
      } : null,
      report: lastReport,
      readiness: readinessSummary(packageId),
      integrations: integrationPanelState(),
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

  /**
   * A command that fails is recorded in a bounded in-session ring, so a later `Report a problem` can show
   * what actually went wrong instead of asking the operator to remember it. The error is rethrown
   * unchanged: recording a failure must not change what the operator sees when one happens.
   */
  const register = (id, callback) => context.subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
    try {
      return await callback(...args);
    } catch (error) {
      recentErrors = reportBuilder.errorRing({
        entries: recentErrors,
        kind: id.startsWith("researchToolkit.") ? id.slice("researchToolkit.".length) : id,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }));
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
        // J4: setup is what produces the worker a check needs, so the host re-reads it here; a failed setup
        // leaves it absent, which is the answer the panel needs, not a second error on top of the first.
        await probeRuntime(folder).catch(() => {});
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
    const runtime = await probeRuntime(folder);
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
    const runtime = await probeRuntime(folder);
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
  async function selectedWorkspaceSources(title, extensions) {
    const folder = folderSelected();
    const root = requireLocal(vscode, folder);
    const selected = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFolders: false, defaultUri: folder.uri,
      title, filters: { "Research sources": extensions } });
    if (!selected?.length) return undefined;
    const relative = [];
    for (const uri of selected) {
      const rel = path.relative(root, uri.fsPath);
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new Error(`Choose sources inside the selected workspace folder. ${uri.fsPath} is outside it, and nothing outside the workspace is indexed.`);
      }
      relative.push(rel.split(path.sep).join("/"));
    }
    return { root, relative };
  }
  /** Run one reviewed CLI verb and parse its receipt the way the component steps parse theirs. */
  async function workerReceipt(runtime, argv, cwd, timeout) {
    const executed = await asRunProcess({})(runtime.python, [...PYTHON_FLAGS, "-m", "research_stack.cli", ...argv], { timeout, cwd });
    if (String(executed.stdout || "").includes("\uFFFD")) {
      throw new Error("The worker's report was not valid UTF-8 text, so its receipt cannot be trusted and nothing is recorded from it. The store itself may already have changed; re-running the command is safe.");
    }
    let report;
    try { report = JSON.parse(executed.stdout); } catch { throw new Error("The worker returned invalid data. Nothing in the store was replaced."); }
    if (executed.exitCode !== 0) throw new Error(report?.error || String(executed.stderr || "").slice(-400) || "The worker command failed.");
    return report;
  }
  register("researchToolkit.indexSelectedSources", () => exclusive(async () => {
    const folder = folderSelected(); requireLocal(vscode, folder);
    const runtime = await probeRuntime(folder);
    if (!runtime) throw new Error("Set up package components before indexing sources.");
    const picked = await selectedWorkspaceSources("Choose PDF, DOCX or text sources to index into the research store", ["pdf", "docx", "md", "markdown", "txt"]);
    if (!picked) return undefined;
    progressMessage = `Indexing ${picked.relative.length} selected source(s) into the workspace research store…`; refresh();
    let report;
    try { report = await workerReceipt(runtime, ["index-corpus", "--workspace", picked.root, ...picked.relative], picked.root, 120000); }
    catch (error) { throw new Error(`Corpus indexing failed for ${picked.relative.length} selected source(s): ${error.message}`); }
    output.clear(); output.appendLine(JSON.stringify(report, null, 2)); output.show(true);
    void vscode.window.showInformationMessage(`Corpus index ${report.status}: ${report.written} source(s) written${report.failedSources?.length ? `; ${report.failedSources.length} refused and left at their previous version` : ""}. Source files were not modified.`);
    return report;
  }));
  register("researchToolkit.verifySourceFreshness", () => exclusive(async () => {
    const folder = folderSelected(); const root = requireLocal(vscode, folder);
    const runtime = await probeRuntime(folder);
    if (!runtime) throw new Error("Set up package components before checking source freshness.");
    progressMessage = "Re-hashing the indexed sources against the files that are present…"; refresh();
    const report = await workerReceipt(runtime, ["verify-sources", "--workspace", root], root, 120000);
    output.clear(); output.appendLine(JSON.stringify(report, null, 2)); output.show(true);
    void vscode.window.showInformationMessage(`Source freshness: ${report.verified.length} verified, ${report.changed.length} changed, ${report.missing.length} missing, ${report.inaccessible.length} inaccessible, ${report.uncheckedRemaining} still unchecked.`);
    return report;
  }));
  async function topicBundleChoice(title) {
    const catalog = await bundles.readCatalog(path.join(context.extensionUri.fsPath, "bundles", "catalog.json"));
    const choice = await vscode.window.showQuickPick(catalog.bundles.map((bundle) => ({
      id: bundle.id, label: `${bundle.id} ${bundle.version}`, description: `${bundle.topic} · ${bundle.skills.length} skill(s) · licence: ${bundle.license}`,
    })), { title, matchOnDescription: true });
    return choice ? { catalog, bundleId: choice.id } : undefined;
  }
  register("researchToolkit.installTopicBundle", () => exclusive(async () => {
    const folder = folderSelected(); const root = requireLocal(vscode, folder);
    const picked = await topicBundleChoice(`Install a topic skill bundle into ${folder.name}`);
    if (!picked) return undefined;
    const plan = await bundles.planInstall({ workspaceRoot: root, catalog: picked.catalog, bundleId: picked.bundleId });
    const detail = `${plan.files.length} reviewed file(s) into ${plan.skillRoot}. Writes: ${plan.wouldWrite}. Already in place: ${plan.counts.identical || 0}. `
      + `Conflicts preserved: ${plan.conflicts.length}. Prerequisites: ${plan.prerequisites.join(" ")} `
      + `Licence status: ${plan.license}. Installing records a receipt under .research-toolkit/bundles/ and never deletes a file.`;
    const choice = await vscode.window.showInformationMessage(`Install ${plan.bundleId} ${plan.bundleVersion} into ${folder.name}?`,
      { modal: true, detail }, "Install skill bundle");
    if (choice !== "Install skill bundle") return undefined;
    const receipt = await bundles.installBundle({ workspaceRoot: root, catalog: picked.catalog, bundleId: picked.bundleId });
    output.clear(); output.appendLine(JSON.stringify(receipt, null, 2)); output.show(true);
    void vscode.window.showInformationMessage(`Bundle ${plan.bundleId}: ${receipt.filesInstalled} file(s) installed and hash-verified. Host skill discovery and workflow testing are not claimed by this install.`);
    return receipt;
  }));
  register("researchToolkit.repairTopicBundle", () => exclusive(async () => {
    const folder = folderSelected(); const root = requireLocal(vscode, folder);
    const picked = await topicBundleChoice(`Repair a topic skill bundle in ${folder.name}`);
    if (!picked) return undefined;
    const receipt = await bundles.repairBundle({ workspaceRoot: root, catalog: picked.catalog, bundleId: picked.bundleId });
    output.clear(); output.appendLine(JSON.stringify(receipt, null, 2)); output.show(true);
    return receipt;
  }));
  register("researchToolkit.showBundleStatus", () => exclusive(async () => {
    const folder = folderSelected(); const root = requireLocal(vscode, folder);
    const catalog = await bundles.readCatalog(path.join(context.extensionUri.fsPath, "bundles", "catalog.json"));
    const status = [];
    for (const bundle of catalog.bundles) {
      const receipt = await bundles.readReceipt(root, bundle.id);
      const plan = await bundles.planInstall({ workspaceRoot: root, catalog, bundleId: bundle.id });
      status.push({ bundleId: bundle.id, version: bundle.version, installed: Boolean(receipt), filesInstalled: receipt?.filesInstalled ?? 0,
        inPlace: plan.counts.identical || 0, missing: plan.counts.new || 0, preserved: plan.conflicts.length,
        hostDiscoveryVerified: receipt?.hostDiscoveryVerified ?? false, workflowTested: receipt?.workflowTested ?? false,
        hostDiscoveryReason: bundles.HOST_DISCOVERY_REASON, workflowTestedReason: bundles.WORKFLOW_TESTED_REASON });
    }
    output.clear(); output.appendLine(JSON.stringify(status, null, 2)); output.show(true);
    return status;
  }));
  // 0.3.14 (HR-20…HR-23): the force update, the archive it writes, and the way back out of it. The plan
  // names what an overwrite would replace; the dialog lists exactly that and never invents its own list.
  const OVERWRITE_STATE_LABEL = {
    outdated: "a copy this Toolkit installed, at an older catalog version",
    "user-modified": "a file you changed after this Toolkit installed it",
    conflict: "a file this Toolkit never installed",
  };
  /** One line per file a run would overwrite, each named in the state the plan measured. */
  function overwriteLines(files) {
    return files.map((file) => `• ${file.target} — ${OVERWRITE_STATE_LABEL[file.state] || file.state}`).join("\n");
  }
  register("researchToolkit.forceUpdateTopicBundle", () => exclusive(async () => {
    const folder = folderSelected(); const root = requireLocal(vscode, folder);
    const picked = await topicBundleChoice(`Force-update a topic skill bundle in ${folder.name}`);
    if (!picked) return undefined;
    const plan = await bundles.planInstall({ workspaceRoot: root, catalog: picked.catalog, bundleId: picked.bundleId, force: true });
    const archiveTo = plan.archivePreview.absoluteDirectory;
    if (!plan.overwrites.length && !plan.wouldWrite) {
      void vscode.window.showInformationMessage(`Nothing to force-update for ${plan.bundleId} in ${folder.name}: `
        + `${plan.counts.identical || 0} file(s) already match the catalog, and ${plan.conflicts.length} file(s) the Toolkit will not write. Nothing was written and no archive was made.`);
      return plan;
    }
    // Two different decisions wear the same command: replacing bytes that are already there, and writing only
    // what is missing. The dialog says which one it is asking for, because "overwrite" would be a lie when
    // nothing is being replaced and no archive will be made.
    const overwriting = plan.overwrites.length > 0;
    const detail = overwriting
      ? `${plan.overwrites.length} file(s) in ${folder.name} would be overwritten:\n\n${overwriteLines(plan.overwrites)}\n\n`
        + `${plan.forceOverwrites.length} of these are preserved by a normal install or repair: they are overwritten only because you asked for this.\n\n`
        + `Before anything is written, what each of these files holds now is copied to:\n${archiveTo}\n\n`
        + `The Toolkit deletes nothing. Every version it replaces stays in that archive, and "Restore a bundle archive" puts one back. A skill owned by another bundle is never written, whatever this command is asked to do.`
      : `Nothing in ${folder.name} needs replacing for ${plan.bundleId}. ${plan.wouldWrite} reviewed file(s) are missing and will be written; `
        + `${plan.counts.identical || 0} already match the catalog, and ${plan.conflicts.length} file(s) the Toolkit will not write.\n\n`
        + `No file is overwritten, so no archive is made. A skill owned by another bundle is never written.`;
    const confirm = overwriting ? "Archive these files and overwrite them" : "Write the missing files";
    const choice = await vscode.window.showWarningMessage(
      `Force-update ${plan.bundleId} ${plan.bundleVersion} in ${folder.name}${overwriting ? ` — overwrite ${plan.overwrites.length} file(s)?` : " — write only the missing files?"}`,
      { modal: true, detail }, confirm);
    if (choice !== confirm) return undefined;
    // A receipt means this bundle was installed here, so the repair classification applies. Without one the
    // run is an install that is allowed to replace the files standing in its way.
    const installed = await bundles.readReceipt(root, picked.bundleId);
    const receipt = installed
      ? await bundles.repairBundle({ workspaceRoot: root, catalog: picked.catalog, bundleId: picked.bundleId, force: true })
      : await bundles.installBundle({ workspaceRoot: root, catalog: picked.catalog, bundleId: picked.bundleId, force: true });
    output.clear(); output.appendLine(JSON.stringify(receipt, null, 2)); output.show(true);
    void vscode.window.showInformationMessage(receipt.archive
      ? `Force update of ${plan.bundleId}: ${receipt.filesWritten} file(s) written; ${receipt.archive.files} file(s) archived at ${receipt.archive.absoluteDirectory}. Host skill discovery and workflow testing are not claimed by this run.`
      : `Force update of ${plan.bundleId}: ${receipt.filesWritten} file(s) written, and nothing was replaced, so no archive was made.`);
    return receipt;
  }));
  register("researchToolkit.showBundleArchiveHistory", () => exclusive(async () => {
    const folder = folderSelected(); const root = requireLocal(vscode, folder);
    const listed = await bundles.listArchives({ workspaceRoot: root });
    if (!listed.archives.length) {
      void vscode.window.showInformationMessage(`No archived bundle version for ${folder.name} yet. An archive is written only when a force update or a restore replaces a file, into ${listed.absoluteArchiveFolder}.`);
      return listed;
    }
    const choice = await vscode.window.showQuickPick(listed.archives.map((entry) => ({
      id: entry.archiveId, label: `${entry.bundleId} — ${entry.archiveId}`,
      description: `${entry.archivedAt} · ${entry.reason} · ${entry.fileCount} file(s) · archived from ${entry.replacedVersion || "an unrecorded version"} · ${entry.absoluteArchiveDirectory}`,
    })), { title: `Archived bundle versions in ${folder.name}`, matchOnDescription: true });
    if (!choice) return undefined;
    const entry = listed.archives.find((item) => item.archiveId === choice.id);
    output.clear(); output.appendLine(JSON.stringify(entry.manifest, null, 2)); output.show(true);
    void vscode.window.showInformationMessage(`Archive ${entry.archiveId}: ${entry.fileCount} file(s) of ${entry.bundleId}, archived ${entry.archivedAt} (${entry.reason}), at ${entry.absoluteArchiveDirectory}. Nothing is deleted from it.`);
    return entry;
  }));
  register("researchToolkit.restoreBundleArchive", () => exclusive(async () => {
    const folder = folderSelected(); const root = requireLocal(vscode, folder);
    const listed = await bundles.listArchives({ workspaceRoot: root });
    if (!listed.archives.length) {
      void vscode.window.showInformationMessage(`Nothing to restore in ${folder.name}: no bundle archive exists yet at ${listed.absoluteArchiveFolder}.`);
      return undefined;
    }
    const archivedBundles = [...new Map(listed.archives.map((entry) => [entry.bundleId, entry])).values()];
    const bundleChoice = archivedBundles.length === 1 ? { id: archivedBundles[0].bundleId } : await vscode.window.showQuickPick(archivedBundles.map((entry) => ({
      id: entry.bundleId, label: entry.bundleId,
      description: `${listed.archives.filter((item) => item.bundleId === entry.bundleId).length} archived version(s) · newest ${entry.archivedAt}`,
    })), { title: `Which bundle's archive do you want to restore in ${folder.name}?`, matchOnDescription: true });
    if (!bundleChoice) return undefined;
    const bundleId = bundleChoice.id;
    const candidates = listed.archives.filter((entry) => entry.bundleId === bundleId);
    const archiveChoice = await vscode.window.showQuickPick(candidates.map((entry) => ({
      id: entry.archiveId, label: entry.archiveId,
      description: `${entry.archivedAt} · ${entry.reason} · ${entry.fileCount} file(s) · ${entry.absoluteArchiveDirectory}`,
    })), { title: `Which archived version of ${bundleId}?`, matchOnDescription: true });
    if (!archiveChoice) return undefined;
    const entry = candidates.find((item) => item.archiveId === archiveChoice.id);
    const detail = `Writing back ${entry.fileCount} file(s) from ${entry.absoluteArchiveDirectory}:\n\n`
      + entry.files.map((file) => `• ${file.path}`).join("\n")
      + `\n\nWhatever those paths hold now is copied into a new archive under ${listed.absoluteArchiveFolder}/${bundleId}/ first, with reason "restore". Nothing is deleted, and a path the Toolkit cannot write safely — a link, a folder — is refused and reported rather than forced.`;
    const choice = await vscode.window.showWarningMessage(`Restore ${bundleId} ${entry.archiveId} (${entry.archivedAt}) into ${folder.name}?`,
      { modal: true, detail }, "Restore this archived version");
    if (choice !== "Restore this archived version") return undefined;
    const report = await bundles.restoreArchive({ workspaceRoot: root, bundleId, archiveId: entry.archiveId });
    output.clear(); output.appendLine(JSON.stringify(report, null, 2)); output.show(true);
    void vscode.window.showInformationMessage(report.archive
      ? `Restored ${report.filesRestored} file(s) of ${bundleId} from archive ${entry.archiveId}; ${report.archive.files} file(s) they replaced are archived at ${report.archive.absoluteDirectory}.`
      : `Restored ${report.filesRestored} file(s) of ${bundleId} from archive ${entry.archiveId}; nothing else was in place to archive.`);
    return report;
  }));
  // 0.3.14 (HR-12, DD15-03): the one command that writes a preset's GitHub tool selection where the
  // Copilot harness reads it. Nothing else writes it — no preset switch, no setup step, no panel refresh.
  // The selection itself (the names, the derived count, the entry shapes and every refusal rule) is
  // `presetselect.js`, which is pure and testable without an editor. This region owns only the operator's
  // review, the bytes, and the copy of the bytes it replaces.
  const PRESET_TOOLS_FOLDER = ".research-toolkit/preset-tools";
  const WRITE_REMOTE_ENTRY = "Write the hosted entry (http)";
  const WRITE_LOCAL_ENTRY = "Write the local entry (stdio)";
  /** True when `file` is strictly inside `root`, the same containment test `bundles.js` applies. */
  function underWorkspace(root, file) {
    const relative = path.relative(root, file);
    return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
  }
  /** `2026-11-17T22:00:00.000Z` → `20261117T220000Z`: a stamp that is legal in a path on every host. */
  function presetToolsStamp(date = new Date()) {
    return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
  }
  /** Read `.mcp.json`. A link or a folder is refused; "there is no file yet" is an answer, not an error. */
  async function readMcpFile(root) {
    const target = path.join(root, presetSelect.MCP_FILE_NAME);
    if (!underWorkspace(root, target)) throw presetSelect.refuse(presetSelect.REFUSALS.OUTSIDE_WORKSPACE, `Writing ${presetSelect.MCP_FILE_NAME} would land outside the workspace root. Nothing was written.`);
    const info = await fsAsync.lstat(target).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!info) return { target, text: undefined };
    if (info.isSymbolicLink() || !info.isFile()) {
      throw presetSelect.refuse(presetSelect.REFUSALS.TARGET_IS_LINK, `${presetSelect.MCP_FILE_NAME} in this workspace is not a regular file, so its bytes are not something this Toolkit will rewrite. Nothing was written.`);
    }
    return { target, text: await fsAsync.readFile(target, "utf8") };
  }
  /** Copy the whole previous file into `.research-toolkit/preset-tools/` with `wx`: a copy is never rewritten, and it is read back to prove it holds what it claims. */
  async function archiveMcpFileBytes(root, text) {
    const folder = await directory(root, PRESET_TOOLS_FOLDER, true);
    const stamp = presetToolsStamp();
    for (let sequence = 1; sequence <= 9999; sequence += 1) {
      const name = `${stamp}-${String(sequence).padStart(4, "0")}.json`;
      const copy = path.join(folder, name);
      // `directory()` returns the workspace root as the filesystem resolves it (a macOS temp dir is a link),
      // so containment is checked against that resolved folder rather than against the caller's spelling.
      if (!underWorkspace(folder, copy)) throw presetSelect.refuse(presetSelect.REFUSALS.OUTSIDE_WORKSPACE, `Copying ${presetSelect.MCP_FILE_NAME} would land outside ${PRESET_TOOLS_FOLDER}. Nothing was written.`);
      try { await fsAsync.writeFile(copy, text, { flag: "wx" }); }
      catch (error) {
        if (error.code === "EEXIST") continue;
        throw presetSelect.refuse(presetSelect.REFUSALS.BACKUP_WRITE_REFUSED, `The Toolkit could not copy the bytes it is about to replace (${error.code}). ${presetSelect.MCP_FILE_NAME} was left exactly as it was.`);
      }
      if (await fsAsync.readFile(copy, "utf8") !== text) {
        throw presetSelect.refuse(presetSelect.REFUSALS.BACKUP_WRITE_REFUSED, `The copy at ${copy} does not hold the bytes it was given. ${presetSelect.MCP_FILE_NAME} was left exactly as it was.`);
      }
      return copy;
    }
    throw presetSelect.refuse(presetSelect.REFUSALS.BACKUP_WRITE_REFUSED, `No free copy name is left in ${PRESET_TOOLS_FOLDER} for stamp ${stamp}. ${presetSelect.MCP_FILE_NAME} was left exactly as it was.`);
  }
  /** Stage the reviewed text to a unique temporary name with `wx`, then rename it into place, and read it back. */
  async function writeMcpFile(root, content) {
    const target = path.join(root, presetSelect.MCP_FILE_NAME);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    if (!underWorkspace(root, target) || !underWorkspace(root, temporary)) {
      throw presetSelect.refuse(presetSelect.REFUSALS.OUTSIDE_WORKSPACE, `Writing ${presetSelect.MCP_FILE_NAME} would land outside the workspace root. Nothing was written.`);
    }
    try { await fsAsync.writeFile(temporary, content, { flag: "wx" }); }
    catch (error) { throw presetSelect.refuse(presetSelect.REFUSALS.MCP_FILE_WRITE_UNVERIFIED, `The Toolkit could not stage ${presetSelect.MCP_FILE_NAME} (${error.code}). The file you reviewed was not changed.`); }
    const present = await fsAsync.lstat(target).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (present && (present.isSymbolicLink() || !present.isFile())) {
      await fsAsync.rm(temporary, { force: true });
      throw presetSelect.refuse(presetSelect.REFUSALS.TARGET_IS_LINK, `${presetSelect.MCP_FILE_NAME} became a link or a folder while this command was running. The staged copy was discarded and nothing was written.`);
    }
    await fsAsync.rename(temporary, target);
    if (await fsAsync.readFile(target, "utf8") !== content) {
      throw presetSelect.refuse(presetSelect.REFUSALS.MCP_FILE_WRITE_UNVERIFIED, `${presetSelect.MCP_FILE_NAME} does not hold the text that was reviewed. The copy of what it replaced is still in ${PRESET_TOOLS_FOLDER}.`);
    }
    return target;
  }
  register("researchToolkit.configurePresetTools", () => exclusive(async () => {
    const folder = folderSelected(); const root = requireLocal(vscode, folder);
    const preset = selectedPreset();
    const serverKey = "github";
    const selection = presetSelect.selectionForPreset(preset);
    if (!selection) {
      // A preset that selects no GitHub surface has nothing to write, and saying so is the outcome.
      const report = { presetId: preset.id, serverKey, githubToolsSelected: 0, written: false, reason: "this preset selects no GitHub MCP surface" };
      output.clear(); output.appendLine(JSON.stringify(report, null, 2)); output.show(true);
      void vscode.window.showInformationMessage(`Preset "${preset.id}" selects no GitHub MCP surface, so nothing was written in ${folder.name}. To take Copilot's built-in GitHub server out of the tool surface: add no "${serverKey}" entry to your MCP configuration, and uncheck the GitHub server group in Chat: Open Customizations → Tools.`);
      return report;
    }
    const current = await readMcpFile(root);
    // Both shapes are computed and shown before anything is written, so the button chooses between two
    // reviewed plans rather than choosing a shape the operator has not seen.
    const remote = presetSelect.mergeIntoMcpFile({ existingJson: current.text, preset, serverKey, variant: "remote" });
    const local = presetSelect.mergeIntoMcpFile({ existingJson: current.text, preset, serverKey, variant: "local" });
    const plan = remote.plan;
    // Read the two entries back out of the text that would be written, so the dialog describes the bytes
    // rather than a description this file maintains separately.
    const hosted = JSON.parse(remote.content).mcpServers[serverKey];
    const stdio = JSON.parse(local.content).mcpServers[serverKey];
    const state = current.text === undefined ? "no MCP file in this workspace yet — one will be created"
      : plan.replaced.length ? `the "${serverKey}" entry this Toolkit wrote before, which this replaces`
        : `no "${serverKey}" entry yet — one will be added`;
    const detail = [
      `File: ${path.join(root, presetSelect.MCP_FILE_NAME)}`,
      `Not .vscode/mcp.json: that deprecated editor shape ("servers") has no per-server tool allow-list, so a tool selection written there is ignored. The workspace-root ${presetSelect.MCP_FILE_NAME} with "mcpServers" is the file that carries one.`,
      ``,
      `Preset: "${preset.id}" — ${plan.selectionLabel}`,
      `Server key: "${serverKey}"`,
      `Toolsets (${plan.toolsets.length}): ${plan.toolsets.join(", ")}`,
      `Tools Copilot may call (${plan.toolCount} exact names, in the entry's "tools" field): ${plan.tools.join(", ")}`,
      `Server-side read-only switch: ${plan.readOnly ? "yes" : "no"}`,
      plan.excluded.length ? `Write tools also named as excluded (${plan.excluded.length}): ${plan.excluded.join(", ")}` : `Write tools named as excluded: none — this preset's GitHub surface is not read-only.`,
      ``,
      `Hosted entry: type ${hosted.type}, url ${hosted.url}, headers ${Object.keys(hosted.headers).join(", ")}`,
      `Local entry: type ${stdio.type}, command ${stdio.command} ${stdio.args.join(" ")}, env ${Object.keys(stdio.env).join(", ")}. Writing it does not mean a GitHub MCP server is installed here — this command installs nothing.`,
      `Already in that file: ${state}${plan.preserved.length ? `; ${plan.preserved.length} other server entry(ies) preserved: ${plan.preserved.join(", ")}` : ""}${plan.preservedTopLevel.length ? `; other top-level members preserved: ${plan.preservedTopLevel.join(", ")}` : ""}`,
      `Copy of what it replaces: ${path.join(root, PRESET_TOOLS_FOLDER)} under a UTC stamp${current.text === undefined ? " — this workspace has no MCP file yet, so there is nothing to copy" : ""}. Nothing in that folder is ever deleted or rewritten.`,
      `Credential: the file will hold ${presetSelect.TOKEN_ENV_REFERENCE} only — never a token value. This command reads no secret and stores none.`,
      `Not claimed: these ${plan.toolCount} names are GitHub's published catalog names as reviewed on 2026-11-17, not tools counted on this machine — no tools/list was captured here. ${plan.readOnly ? "A server-side read-only switch is a filter, not a permission boundary: it decides which tools the server offers, while your token decides what the account may do." : "This selection enables write tools: approval for each call still belongs to the host and to your token's scope."}`,
    ].join("\n");
    const choice = await vscode.window.showWarningMessage(`Write the GitHub selection of preset "${preset.id}" — ${plan.toolCount} tool(s) — into ${presetSelect.MCP_FILE_NAME} in ${folder.name}?`,
      { modal: true, detail }, WRITE_REMOTE_ENTRY, WRITE_LOCAL_ENTRY);
    if (choice !== WRITE_REMOTE_ENTRY && choice !== WRITE_LOCAL_ENTRY) return undefined;
    const variant = choice === WRITE_LOCAL_ENTRY ? "local" : "remote";
    const after = await readMcpFile(root);
    if ((after.text ?? "") !== (current.text ?? "")) {
      throw presetSelect.refuse(presetSelect.REFUSALS.TARGET_CHANGED_MID_RUN, `${presetSelect.MCP_FILE_NAME} changed after you reviewed it, so nothing was written. Run the command again to review the file as it is now.`);
    }
    const chosen = variant === "local" ? local : remote;
    // A copy is kept whenever there were bytes to replace. It is kept even when the new text differs only
    // in its marker timestamp, because "what was in the file before this command ran" is the question the
    // copy answers, and a run that skipped the copy would answer it differently each time.
    const previousCopy = current.text === undefined ? undefined : await archiveMcpFileBytes(root, current.text);
    const target = await writeMcpFile(root, chosen.content);
    const record = { ...chosen.plan, filePath: target, previousBytesCopiedTo: previousCopy || null };
    output.clear(); output.appendLine(JSON.stringify(record, null, 2)); output.show(true);
    const bytes = previousCopy ? `The file it replaces is copied at ${previousCopy}.` : "There was no MCP file before, so nothing was replaced.";
    void vscode.window.showInformationMessage(`Configured preset "${preset.id}" for Copilot in ${folder.name}: ${chosen.plan.toolCount} GitHub tool name(s) selected into ${chosen.plan.fileName} (${variant} entry, server read-only ${chosen.plan.readOnly ? "on" : "off"})${chosen.plan.preserved.length ? `, ${chosen.plan.preserved.length} server entry(ies) you wrote preserved` : ""}. ${bytes} GitHub counts here are catalog names, not tools counted on this machine.`);
    return record;
  }));
  const mcpProvider = {
    onDidChangeMcpServerDefinitions: changed.event,
    async provideMcpServerDefinitions() {
      const folder = folderSelected();
      if (!vscode.workspace.isTrusted || vscode.env.remoteName || !folder || folder.uri.scheme !== "file") return [];
      let runtime;
      try { runtime = await probeRuntime(folder); } catch { managedWorkerPresent = false; return []; }
      if (!runtime || folder !== folderSelected()) return [];
      receipt = runtime.receipt || receipt;
      toolSurface = runtime.receipt?.checks?.toolSurface || toolSurface;
      const preset = selectedPreset();
      const integrationEnv = await integrationEnvironment();
      const signature = presetSurfaceSignature(preset, runtime.version, integrationEnv.fingerprint);
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
            [...PYTHON_FLAGS, "-m", server.module],
            {
              RESEARCH_STACK_WORKSPACE: folder.uri.fsPath, RESEARCH_STACK_TOOL_PRESET: preset.id,
              // 0.3.11: only the server that actually uses a provider gets the integration state, and
              // only when the operator authorized it. An unauthorized integration injects nothing.
              ...(server.module === "research_stack.recommended_server" ? integrationEnv.env : {}),
            }, signature);
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
   * What the research worker is handed for the integration state the operator chose. A key reaches a
   * process environment only for an authorized integration that asked for one; the fingerprint folded
   * into the server signature names the mode and whether a key exists, never the key itself, so
   * authorizing or revoking refreshes the client's tool surface without re-installing a component.
   */
  async function integrationEnvironment() {
    const env = {};
    const record = integrationRegistry.providers["semantic-scholar"];
    let keyConfigured = false;
    if (integrations.isAuthorized(integrationRegistry, "semantic-scholar")) {
      env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED = "true";
      if (record.mode === "api-key") {
        const key = await integrationStore.readApiKey(context.secrets, "semantic-scholar");
        if (key) { env.SEMANTIC_SCHOLAR_API_KEY = key; keyConfigured = true; }
      }
    }
    // 0.3.13 (DD14-07): a Zotero write key is Zotero's own credential, issued by Zotero's own consent dialog.
    // The Toolkit never opens that dialog, never reads Zotero's `localAPIKeys.json`, and never asks for a key in
    // a chat or a file. It hands over only what the operator stored in this profile's secret storage, to the
    // worker that serves `zotero_write`, and the fingerprint below names only whether one exists.
    const zoteroWriteKey = await integrationStore.readApiKey(context.secrets, "zotero");
    if (zoteroWriteKey) env.RESEARCH_STACK_ZOTERO_WRITE_KEY = zoteroWriteKey;
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({
      semanticScholar: integrations.isAuthorized(integrationRegistry, "semantic-scholar") ? record.mode : "off",
      keyConfigured,
      zotero: integrationRegistry.providers.zotero.readiness,
      zoteroWriteKeyConfigured: Boolean(zoteroWriteKey),
    })).digest("hex").slice(0, 8);
    return { env, fingerprint };
  }

  /**
   * The version a client compares to decide whether a server's tools changed. It covers the
   * runtime, the goal's tool surface and the integration state, so switching preset or authorizing an
   * integration signals a tool refresh.
   */
  function presetSurfaceSignature(preset, runtimeVersion, integrationFingerprint = "") {
    const surface = crypto.createHash("sha256").update(JSON.stringify({ tools: [...preset.tools].sort(), integrations: integrationFingerprint })).digest("hex").slice(0, 12);
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
    const narrower = presetsForPackage(selectedPackage(vscode))
      .filter((item) => item.id !== preset.id)
      .map((item) => ({ preset: item, estimate: presetEstimate(item, toolSurface) }))
      .sort((left, right) => left.estimate.totalTools - right.estimate.totalTools)
      .slice(0, 3);
    const lines = [
      `Tool limit diagnosis · toolkit ${context.extension.packageJSON.version}`,
      `Client ceiling: ${budget.clientCeiling} tools can be enabled at once in Copilot agent mode. The toolkit cannot raise or enforce it.`,
      `Toolkit contribution now: ${estimate.toolkitTools} toolkit tools from ${estimate.servers.length} managed MCP server(s) (${estimate.servers.join(", ") || "none"}).`,
      `External tools you configured: ${estimate.thirdPartyTools} ${estimate.thirdPartyTools === 0
        ? "(none: this preset names no third-party surface)."
        : namedSurface(preset)
          ? `(the exact tool names this preset selects — ${externalSurfaceText(preset)}; a vendor-published name list, not a measurement, so confirm it with tools/list on your host).`
          : "(vendor-published toolset estimates; this extension neither starts nor measures those servers)."}`,
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

  /* ------------------------------------------------------------------------ 0.3.10: update channel */

  const UPDATE_STATE_KEY = "researchToolkit.updateCheck";

  function storedUpdateCheck() {
    const stored = context.globalState && typeof context.globalState.get === "function"
      ? context.globalState.get(UPDATE_STATE_KEY) : undefined;
    return stored && typeof stored === "object" ? stored : null;
  }

  function updateSettings() {
    return { checkForUpdates: vscode.workspace.getConfiguration("researchStack").get("checkForUpdates", true) !== false };
  }

  /**
   * Ask the Marketplace once, show what it said, and store when it was asked.
   * The request carries nothing about this machine: the URL is the publisher id and the extension name,
   * both already public. A failed check is reported as a failed check, never as a toolkit failure.
   */
  async function runUpdateCheck({ force = false, notify = false } = {}) {
    const settings = updateSettings();
    const previous = storedUpdateCheck();
    if (!settings.checkForUpdates) {
      const verdict = { state: "disabled", installedVersion: TOOLKIT_VERSION, action: "none", page: updates.marketplacePage(PUBLISHER_ID, EXTENSION_NAME) };
      updateCheck = verdict;
      refresh();
      if (notify) await vscode.window.showInformationMessage("Update checks are switched off in the Toolkit settings. Turn on “Check for a newer Toolkit version” to use this.");
      // Returned as a local object, not by re-reading `updateCheck`: a check the panel started earlier can
      // finish during the await above and replace the shared verdict. The caller gets the answer this call produced.
      return verdict;
    }
    if (!updates.shouldCheck({ enabled: true, lastCheckedAt: previous && previous.checkedAt, force })) {
      // The last verdict, kept and labelled as kept. Repeating "checked-recently" instead would hide the
      // one thing the operator asked for; hiding the stamp would present an old answer as a fresh one.
      const verdict = {
        ...(previous || {}),
        state: (previous && previous.state) || "checked-recently",
        installedVersion: TOOLKIT_VERSION,
        cached: true,
        held: true,
        page: updates.marketplacePage(PUBLISHER_ID, EXTENSION_NAME),
      };
      updateCheck = verdict;
      refresh();
      if (notify) await vscode.window.showInformationMessage(`The Toolkit already checked for a newer version today. Last check: ${previous.checkedAtText || "today"}.`);
      return verdict;
    }
    const published = await updates.checkPublishedVersion({ publisher: PUBLISHER_ID, name: EXTENSION_NAME, fetchImpl: updateTransport });
    const plan = updates.updatePlan({
      installedVersion: TOOLKIT_VERSION,
      publishedVersion: published.version,
      publishedEngine: published.engine,
      vscodeVersion: vscode.version,
      checkState: published.state === "ok" ? undefined : published.state,
    });
    const verdict = {
      ...plan,
      checkedAt: Date.now(),
      checkedAtText: new Date().toISOString(),
      page: updates.marketplacePage(PUBLISHER_ID, EXTENSION_NAME),
      publishedEngine: published.engine || null,
    };
    updateCheck = verdict;
    void Promise.resolve(context.globalState && typeof context.globalState.update === "function"
      ? context.globalState.update(UPDATE_STATE_KEY, { checkedAt: verdict.checkedAt, checkedAtText: verdict.checkedAtText, state: verdict.state, publishedVersion: verdict.publishedVersion || null })
      : undefined).catch(() => {});
    refresh();
    if (notify) {
      if (plan.state === "update-available") {
        const choice = await vscode.window.showInformationMessage(
          `Research Stack Toolkit ${plan.publishedVersion} is published; this window has ${TOOLKIT_VERSION}.`,
          "Update from the Marketplace", "Open the Marketplace page", "Later");
        if (choice === "Update from the Marketplace") await vscode.commands.executeCommand("researchToolkit.updateExtension");
        else if (choice === "Open the Marketplace page") await vscode.env.openExternal(vscode.Uri.parse(verdict.page));
      } else if (plan.state === "not-published") {
        await vscode.window.showInformationMessage("No published version of this Toolkit was found, so there is nothing to update to. This copy is the one you installed from a file.");
      } else if (plan.state === "editor-too-old") {
        await vscode.window.showInformationMessage(`Toolkit ${plan.publishedVersion} needs VS Code ${plan.requiredEngine} or newer. Update VS Code first.`);
      } else if (plan.state === "up-to-date") {
        await vscode.window.showInformationMessage(`This is the newest published Toolkit (${TOOLKIT_VERSION}).`);
      } else {
        await vscode.window.showWarningMessage(`The update check did not complete: ${plan.state}. The Toolkit itself is working — only the check failed.`);
      }
    }
    return verdict;
  }

  register("researchToolkit.checkForUpdates", () => runUpdateCheck({ force: true, notify: true }));

  /**
   * Hand the update to VS Code's own extension installer, addressed to the Marketplace id rather than to a
   * downloaded file. That matters: a gallery install carries the Marketplace signature and returns the
   * extension to normal automatic updating, while installing a VSIX the toolkit fetched itself would pin
   * the extension at one version and leave it unsigned.
   */
  register("researchToolkit.updateExtension", async () => {
    const page = updates.marketplacePage(PUBLISHER_ID, EXTENSION_NAME);
    const target = updateCheck && updateCheck.publishedVersion ? `${EXTENSION_ID}@${updateCheck.publishedVersion}` : EXTENSION_ID;
    try {
      await vscode.commands.executeCommand("workbench.extensions.installExtension", target, {
        justification: { reason: `Update Research Stack Toolkit to ${updateCheck && updateCheck.publishedVersion ? updateCheck.publishedVersion : "the published version"}.`, action: true },
      });
    } catch (error) {
      // The command is workbench-internal, not part of the extension API, so it is a convenience and not a
      // guarantee. If it is unavailable the operator still gets the page they can install from.
      await vscode.env.openExternal(vscode.Uri.parse(page));
      throw new Error(`VS Code could not start the update (${error instanceof Error ? error.message : "unknown reason"}). The Marketplace page was opened instead — press Install there.`);
    }
    const choice = await vscode.window.showInformationMessage(`Toolkit ${updateCheck && updateCheck.publishedVersion ? updateCheck.publishedVersion : "the published version"} is being installed. Reload this window to run it.`, "Reload window");
    if (choice === "Reload window") await vscode.commands.executeCommand("workbench.action.reloadWindow");
    return target;
  });

  /* ------------------------------------------------------------------- 0.3.10: problem reports */

  /**
   * Build a problem report, show it, and only then offer to open the operator's mail program.
   * The order is deliberate: the file is written and the text is on the clipboard before anything is
   * opened, because `env.openExternal` resolves successfully on the desktop even when the operating
   * system could not open anything. A fallback prepared afterwards is a fallback that never happens.
   */
  register("researchToolkit.reportProblem", async () => {
    const folder = folderSelected();
    await loadInstallationStatus();
    const log = folder && folder.uri.scheme === "file"
      ? await setuplog.readLog(folder.uri.fsPath, reportBuilder.MAX_LOG_LINES).catch(() => ({ files: [], lines: [] }))
      : { files: [], lines: [] };
    const setupText = statusModel.diagnosticsText(installationStatus, log);
    const headline = installationView().line || (recentErrors.length ? recentErrors[recentErrors.length - 1].message : "a problem in the Toolkit");

    const note = await vscode.window.showInputBox({
      title: "What went wrong? (optional)",
      prompt: "Say in your own words what you were doing. This text goes into the report.",
      placeHolder: "For example: I clicked Index sources and it stopped after a minute.",
      ignoreFocusLost: true,
    });
    if (note === undefined) throw new Error("Report cancelled. Nothing was written and nothing was opened.");

    const report = reportBuilder.buildReport({
      toolkitVersion: TOOLKIT_VERSION,
      workerVersion: WORKER_VERSION,
      vscodeVersion: vscode.version,
      platform: process.platform,
      osRelease: (() => { try { return os.release(); } catch { return null; } })(),
      architecture: process.arch,
      nodeVersion: process.versions.node,
      install: context.extension && context.extension.extensionPath ? "local folder (path not included)" : "not reported",
      package: selectedPackage(vscode),
      toolsPreset: PRESETS_BY_ID.get(selectedPresetId(vscode)).label,
      workspaceLabel: folder ? folder.name : null,
      setupStatusText: setupText,
      setupLogLines: (log.lines || []).map(reportBuilder.formatLogEntry),
      errors: recentErrors,
      note,
      updateState: updateCheck ? `${updateCheck.state}${updateCheck.publishedVersion ? ` (published ${updateCheck.publishedVersion})` : ""}` : null,
      workspaceNames: (vscode.workspace.workspaceFolders || []).map((item) => item.name),
    });

    const storageRoot = context.storageUri || context.globalStorageUri || context.logUri;
    let savedFile = null;
    if (storageRoot && vscode.workspace.fs && typeof vscode.workspace.fs.writeFile === "function") {
      const reportsDirectory = vscode.Uri.joinPath(storageRoot, "reports");
      await vscode.workspace.fs.createDirectory(reportsDirectory).catch(() => {});
      savedFile = vscode.Uri.joinPath(reportsDirectory, report.fileName);
      await vscode.workspace.fs.writeFile(savedFile, Buffer.from(report.text, "utf8"));
    }
    await vscode.env.clipboard.writeText(report.text);
    lastReport = { id: report.id, path: savedFile ? savedFile.fsPath : null, bytes: report.bytes, redactions: report.counts };
    if (savedFile) {
      const document = await vscode.workspace.openTextDocument(savedFile);
      await vscode.window.showTextDocument(document, { preview: true });
    }

    const draft = reportBuilder.emailDraft({
      id: report.id,
      toolkitVersion: TOOLKIT_VERSION,
      headline,
      note,
      reportFilePath: savedFile ? report.fileName : "not written — the full report is on your clipboard",
    });
    const mail = reportBuilder.mailtoUri({ subject: draft.subject, body: draft.body });
    const choice = await vscode.window.showInformationMessage(
      `Report ${report.id} is on your clipboard${savedFile ? ` and saved as ${report.fileName}` : ""}. Open your mail program with the address already filled in?`,
      {
        modal: true,
        detail: `Address: ${reportBuilder.MAINTAINER_EMAIL}\nSubject: ${draft.subject}\n\nNothing is sent by the Toolkit. Your mail program opens a draft and only you can press Send. The full report (${report.bytes} bytes) is on your clipboard and in the file you can attach.\nRemoved from the report before you saw it: ${report.counts.absolutePaths} path(s), ${report.counts.homePaths} home folder(s), ${report.counts.workspaceNames} workspace name(s), ${report.counts.secrets} token-shaped string(s).`,
      },
      "Open my mail program",
      "Stop here",
    );
    if (choice === "Open my mail program") {
      const opened = await vscode.env.openExternal(vscode.Uri.parse(mail.uri));
      await vscode.window.showInformationMessage(opened
        ? "Your mail program was asked to open a draft. Check the address and press Send there."
        : `No mail program opened. The report is already on your clipboard and saved as ${report.fileName} — paste or attach it in Gmail, Outlook or any mail program addressed to ${reportBuilder.MAINTAINER_EMAIL}.`);
    }
    refresh();
    return { id: report.id, path: lastReport.path, bytes: report.bytes, mailtoFits: mail.fits };
  });

  // --- 0.3.11: Integrations & Accounts ---------------------------------------------------------
  // Every path here is an operator decision. The Toolkit records a confirmation it was given; it never
  // infers one, never confirms a provider's licence on the operator's behalf, and never writes to Zotero.
  // Which actions exist at all is decided by the state model (`integrationViews().actions`, id and label), so the
  // card and the Quick Pick cannot offer different things from the same record.
  register("researchToolkit.manageIntegrations", async () => {
    // INT-15.2 (DD12-02): opening the integrations flow is the deliberate act that consults the machine
    // record, so a new profile of the same OS user is not asked again about an installation this machine has
    // already answered. One read, one worker call, no provider reached, no secret read, no probe. A record this
    // release cannot use is refused in the panel and in the row it concerns, never swallowed.
    // J3: the read keeps its place and loses its power to queue the operator. If a setup or a check already
    // holds the lock, this opening says so and carries on with the flow the operator asked for.
    if (operation || checking) {
      integrationFactsNote = "A setup or a check is already running, so this opening did not read the machine installation record. Press \"What did this machine find?\" once it finishes.";
    } else {
      await exclusive(() => readIntegrationFacts()).catch(() => null);
    }
    refresh();
    const views = integrations.integrationViews(integrationRegistry, { now: new Date().toISOString(), canProbe: probeCapability() });
    const picked = await vscode.window.showQuickPick(views.map((view) => ({
      id: view.id, label: view.title, description: view.label, detail: `${view.detail}\nNext: ${view.nextAction}${view.id === "zotero" && integrationFactsNote ? `\n${integrationFactsNote}` : ""}`,
    })), { title: "Integrations & Accounts — saved once for this VS Code profile", matchOnDescription: true });
    if (!picked) return undefined;
    const view = views.find((item) => item.id === picked.id);
    const action = await vscode.window.showQuickPick(view.actions.map(([id, label]) => ({ id, label })), { title: `${picked.label}: what do you want to do?` });
    if (!action) return undefined;
    const openGuide = () => vscode.commands.executeCommand("researchToolkit.openComponentGuide", picked.id === "zotero" ? "zotero-local-api" : "semantic-scholar-academic-graph");
    // J2: every probe goes through the one lock, from whichever surface it was pressed on. A probe outside the
    // lock reports `busy: false`, so the card re-enables mid-check and a second press starts a second worker.
    if (action.id === "check" || action.id === "installedNow") return exclusive(() => runIntegrationProbe(picked.id));
    if (action.id === "activate") return activateIntegration(picked.id);
    if (action.id === "guideInstall") return guideZoteroInstall(picked.id);
    if (action.id === "apiGuide") return openGuide();
    if (action.id === "machineFact") return exclusive(() => readIntegrationFacts());
    if (action.id === "requestKey") return requestApiKey(picked.id);
    if (action.id === "provideKey" || action.id === "replaceKey") return setIntegrationKey(picked.id);
    if (action.id === "noKey") return continueWithoutKey(picked.id);
    if (action.id === "removeKey") return clearIntegrationKey(picked.id);
    if (action.id === "testKey") return testIntegrationKey(picked.id);
    if (action.id === "deactivate") return deactivateIntegration(picked.id);
    return resetIntegration(picked.id);
  });

  /**
   * INT-13A.2 and DD12-12: the operator installs Zotero themselves, from the official page, in their own session.
   * There is no reviewed place in this package where the Toolkit could download or run an installer, so it names
   * the page, shows a numbered guide and re-checks only when the operator asks (NF12-04, DD11-07). Nothing polls.
   */
  async function guideZoteroInstall(provider) {
    if (provider !== "zotero") throw new TypeError("Semantic Scholar is a hosted service with nothing to install on this machine.");
    // The model decides whether the guided installation is offered, so the host asks the model rather than
    // re-deriving the rule here. A machine confirmation older than the Toolkit's window re-opens the offer,
    // and a host that refused anyway would contradict the button the operator just pressed.
    const entry = integrationRegistry.providers.zotero;
    const offered = integrationView("zotero").actions.some(([id]) => id === "guideInstall");
    if (entry.installation === "detected" && !offered) {
      // INT-15 (DD12-02): the refusal names whose fact it is. An installation another window of the same OS
      // user found must not be reported to this profile as if this profile had verified it.
      const fromMachine = entry.installationSource === "machine-fact";
      void vscode.window.showInformationMessage(fromMachine
        ? "Zotero was found on this machine by another window of the same OS user, so the Toolkit offers no installation for it. This profile has not checked it: check integrations to see whether its local API answers."
        : "Zotero is already installed on this machine, so the Toolkit offers no installation for it. Check integrations to see whether its local API answers.");
      return integrationView("zotero");
    }
    const reconfirmed = entry.installation === "detected";
    const choice = await vscode.window.showInformationMessage(
      "Guided Zotero installation. The Toolkit downloaded nothing and ran nothing: it opened no installer, wrote no file and changed no setting.",
      { modal: true, detail: `${reconfirmed ? "This machine's last confirmation that Zotero is installed is older than the Toolkit's 7-day window, so the guide is offered again. If Zotero is still there, install over it or skip straight to step 4.\n\n" : ""}1. Open the official Zotero download page: ${integrations.ZOTERO_DOWNLOAD_URL}\n2. Install Zotero with the installer that page offers for your operating system.\n3. Start Zotero.\n4. Press "I have installed Zotero — check it now". The Toolkit re-checks when you ask; it does not watch for the installation, poll for it or schedule anything.\n\nIt has no reviewed capability to download or run an installer, and it never writes to your Zotero library.` },
      "Open the official download page", "Open the Toolkit's Zotero guide", "Not now");
    if (choice === "Open the official download page") {
      if (!await vscode.env.openExternal(vscode.Uri.parse(integrations.ZOTERO_DOWNLOAD_URL))) throw new Error("Unable to open the official Zotero download page in the host browser.");
      return undefined;
    }
    if (choice === "Open the Toolkit's Zotero guide") return openZoteroGuide();
    if (choice === "Not now") return declineIntegration(provider);
    return undefined;
  }
  const openZoteroGuide = () => vscode.commands.executeCommand("researchToolkit.openComponentGuide", "zotero-local-api");

  /**
   * INT-14.1: the key step is a choice, not a box. The provider's own application page opens in the host browser
   * and the Toolkit never fills it in; the key reaches the operator by email, which the Toolkit never receives,
   * stores or sees. What the Toolkit records is which choice the operator made.
   */
  async function requestApiKey(provider) {
    if (provider !== "semantic-scholar") throw new TypeError("Zotero local reading needs no key, so there is no key to request.");
    await saveIntegrations(integrations.recordKeyDecision(integrationRegistry, provider, "guided", new Date().toISOString()));
    const choice = await vscode.window.showInformationMessage(
      "A Semantic Scholar API key is optional. The Toolkit asked you for nothing here and stored nothing.",
      { modal: true, detail: `1. Apply on the provider's own page: it asks for an academic or corporate address, your affiliation and what you will use the key for.\n2. The provider emails the key to you. The Toolkit never receives, stores or sees that email, and never asks for a key in a chat, a workspace file or a log.\n3. Activate the integration first — you must accept the provider's terms before the Toolkit will store or use a key. Press "Activate" on the Semantic Scholar card and confirm the two agreements there.\n4. Press "I already have a key" and paste it once. It is stored in VS Code secret storage for this VS Code profile only — never in a workspace file, a setting, a log or a problem report.\n\nWithout a key your requests share one capacity with every other unauthenticated user. A key buys one request per second across all endpoints, not per endpoint.` },
      "Open the official application page", "Open the Toolkit's Semantic Scholar guide", "Not now");
    if (choice === "Open the official application page") {
      if (!await vscode.env.openExternal(vscode.Uri.parse(integrations.API_KEY_APPLICATION_URL))) throw new Error("Unable to open the provider's API key application page in the host browser.");
      return undefined;
    }
    if (choice === "Open the Toolkit's Semantic Scholar guide") return vscode.commands.executeCommand("researchToolkit.openComponentGuide", "semantic-scholar-academic-graph");
    return integrationView(provider);
  }

  /** Declining a key is a decision about a key: not a consent, not a key, and not a finished guide. */
  async function continueWithoutKey(provider) {
    if (provider !== "semantic-scholar") throw new TypeError("Zotero local reading has no key to decline.");
    const at = new Date().toISOString();
    await saveIntegrations(integrations.setMode(integrations.recordKeyDecision(integrationRegistry, provider, "declined", at), provider, "anonymous", at));
    void vscode.window.showInformationMessage("Continuing without a key. No key was stored, nothing was authorized, and the guide is not marked finished: the key step is recorded as declined, not as done.");
    return integrationView(provider);
  }

  /** One check the operator asked for, with the stored key handed only to the worker that needs it. */
  async function testIntegrationKey(provider) {
    if (provider !== "semantic-scholar") throw new TypeError("Only Semantic Scholar has a Toolkit-stored key to test.");
    if (!integrationRegistry.providers[provider].credentials?.configured) throw new Error("No key is stored for this integration, so there is nothing to test.");
    const { probed } = await exclusive(() => runIntegrationProbe(provider));
    void vscode.window.showInformationMessage(integrationProbe.describeProbeFailure(provider, probed?.semanticScholar));
    return integrationView(provider);
  }

  /** Consent for Semantic Scholar is a button press after the licence is offered, never a default. */
  async function activateIntegration(provider) {
    if (!integrations.PROVIDERS.includes(provider)) throw new TypeError("Unknown integration.");
    // The record says the operator started the guide, so a workspace reopened later shows an unfinished
    // decision instead of a blank one — and an unfinished decision is still not a consent.
    await saveIntegrations(integrations.beginOnboarding(integrationRegistry, provider, new Date().toISOString()));
    if (provider === "zotero") {
      const view = integrationView(provider);
      const choice = await vscode.window.showInformationMessage(
        `Zotero needs no account and no key for a local read. ${view.detail}`,
        { modal: true, detail: "The Toolkit reads through Zotero's own loopback API and never writes to your library. If Zotero refuses with 403, enable its local API in Zotero's own Settings → Advanced; the Toolkit will not change that setting for you." },
        "Start checking Zotero", "Open the Zotero guide", "Not now");
      if (choice === "Open the Zotero guide") return vscode.commands.executeCommand("researchToolkit.openComponentGuide", "zotero-local-api");
      if (choice === "Not now") return declineIntegration(provider);
      if (choice !== "Start checking Zotero") return undefined;
      return exclusive(() => runIntegrationProbe("zotero"));
    }
    const choice = await vscode.window.showWarningMessage(
      "Activate Semantic Scholar for this VS Code profile?",
      { modal: true, detail: `Most public endpoints work with no account and no key. Before you activate, read the two agreements that govern this provider — they are not the same text.\n\nAPI Licence: ${integrations.API_LICENSE_URL}\nDataset License Agreement: ${integrations.LICENSE_URL}\n\nThe API Licence covers use in operation with third-party software. The Dataset Agreement limits use to internal, non-commercial research and education and requires the Semantic Scholar name and logo, with a utm_source=api link, on any public display. Pressing Activate records that you reviewed both, at a stated time, in this VS Code profile only. It is not a grant of rights, it does not judge your intended use, and it does not replace any consent the provider itself requires. You can add an API key later without re-running this step.` },
      "Read the API licence", "Activate without an API key", "Activate and add an API key", "Not now");
    if (choice === "Read the API licence") {
      if (!await vscode.env.openExternal(vscode.Uri.parse(integrations.API_LICENSE_URL))) throw new Error("Unable to open the licence in the host browser.");
      return undefined;
    }
    if (choice === "Not now") return declineIntegration(provider);
    if (choice !== "Activate without an API key" && choice !== "Activate and add an API key") return undefined;
    const next = integrations.authorizeSemanticScholar(integrationRegistry, { acknowledged: true, at: new Date().toISOString(), mode: choice === "Activate and add an API key" ? "api-key" : "anonymous" });
    await saveIntegrations(next);
    void vscode.window.showInformationMessage(`Semantic Scholar activated for this VS Code profile. Your confirmation is recorded against ${integrations.LICENSE_REFERENCE}. Other workspaces in this profile will not ask again.`);
    if (choice === "Activate and add an API key") return setIntegrationKey("semantic-scholar");
    return integrationView("semantic-scholar");
  }

  /** The key goes to VS Code's secret storage. It is never shown back, never logged, never written to a workspace. */
  async function setIntegrationKey(provider) {
    if (provider !== "semantic-scholar") throw new Error("Only Semantic Scholar uses a Toolkit-stored key. Zotero local reading needs no key.");
    if (!integrations.isAuthorized(integrationRegistry, provider)) throw new Error("Activate the integration before adding a key. The Toolkit stores a key only for an integration you have authorized.");
    const entered = await vscode.window.showInputBox({ title: "Semantic Scholar API key", prompt: "Paste the key the provider emailed you. It is stored in VS Code's secret storage for this profile and is never written into your project, your logs or a report.", password: true, ignoreFocusOut: true, placeHolder: "Paste the key, or leave empty to keep the current one" });
    if (entered === undefined) return undefined;
    if (!entered.trim()) return integrationView(provider);
    const stored = await integrationStore.storeApiKey(context.secrets, provider, entered);
    const at = new Date().toISOString();
    await saveIntegrations(integrations.setMode(integrations.setCredentialConfigured(integrations.recordKeyDecision(integrationRegistry, provider, "provided", at), provider, stored.configured, at), provider, "api-key", at));
    void vscode.window.showInformationMessage("API key stored in VS Code secret storage. It is not copied into your workspace, your settings, the setup log or a problem report.");
    return integrationView(provider);
  }
  /**
   * 0.3.13 (DD14-07): the Zotero write key is not a key the Toolkit can request from a provider. Zotero issues
   * it in its own authorization dialog, on the operator's machine, and the Toolkit never opens that dialog and
   * never reads Zotero's own key file. This command stores only a key the operator already has, and names where
   * it came from. It is the only path by which a write credential reaches the worker.
   */
  async function setZoteroWriteKey() {
    const stored = await integrationStore.hasApiKey(context.secrets, "zotero");
    const choice = await vscode.window.showInformationMessage(
      stored ? "This profile already stores a Zotero write key." : "This profile stores no Zotero write key. Reading your library needs none.",
      { modal: true, detail: "Zotero 10 issues a local write key in its own authorization dialog, on your machine, after you press Allow there. The Toolkit never opens that dialog, never accepts that consent for you, never reads Zotero's own key file, and never writes to your library without the literal confirmation `write-to-zotero`.\n\nStore pastes a key Zotero already gave you into VS Code secret storage for this VS Code profile only — never into a workspace file, a setting, a log or a problem report — and hands it only to the research worker's environment. Remove deletes it. Without a key the Toolkit reads your library and refuses every write before Zotero is asked." },
      stored ? "Replace the key" : "Store a key Zotero gave you", "Remove the stored key", "Not now");
    if (choice === "Not now" || choice === undefined) return integrationView("zotero");
    if (choice === "Remove the stored key") {
      await integrationStore.clearApiKey(context.secrets, "zotero");
      void vscode.window.showInformationMessage("Zotero write key removed from this profile. The Toolkit will refuse a Zotero write before it asks Zotero for anything.");
      return integrationView("zotero");
    }
    const entered = await vscode.window.showInputBox({ title: "Zotero write key", prompt: "Paste the key Zotero issued when you pressed Allow in its own authorization dialog. It is stored in VS Code's secret storage for this profile and is never written into your project, your logs or a report.", password: true, ignoreFocusOut: true, placeHolder: "Paste the key, or leave empty to keep the current one" });
    if (entered === undefined) return undefined;
    if (!entered.trim()) return integrationView("zotero");
    const result = await integrationStore.storeApiKey(context.secrets, "zotero", entered);
    void vscode.window.showInformationMessage(`Zotero write key stored for this profile${result.configured ? "" : " — the value was refused as a key"}. It is not copied into your workspace, your settings, the setup log or a problem report, and it is not sent to Zotero by any tool that does not name a write.`);
    return integrationView("zotero");
  }

  async function clearIntegrationKey(provider) {
    await integrationStore.clearApiKey(context.secrets, provider);
    const at = new Date().toISOString();
    await saveIntegrations(integrations.setMode(integrations.setCredentialConfigured(integrations.recordKeyDecision(integrationRegistry, provider, "removed", at), provider, false, at), provider, "anonymous", at));
    void vscode.window.showInformationMessage("Stored API key removed. The integration stays authorized and works anonymously.");
    return integrationView(provider);
  }
  /** "Not now" is a refusal to decide, not a decision: nothing is authorized and nothing is injected. */
  async function declineIntegration(provider) {
    await saveIntegrations(integrations.skipOnboarding(integrationRegistry, provider, new Date().toISOString()));
    void vscode.window.showInformationMessage(`${provider} is left as it is. Nothing was authorized, nothing was installed and nothing is handed to the research worker. The guide is marked as not finished, so you can resume it from Integrations & Accounts whenever you want.`);
    return integrationView(provider);
  }
  /** Turning off is not deleting: the record stays, so switching back on does not re-run the guide. */
  async function deactivateIntegration(provider) {
    const choice = await vscode.window.showWarningMessage(`Turn off ${provider} in this VS Code profile?`,
      { modal: true, detail: "The Toolkit stops handing this service to the research worker and removes any key it stored for it. Your confirmation record is kept so switching it back on does not ask you to read the guide again. Nothing in your workspace, and nothing you configured outside the Toolkit, is touched." },
      "Turn off integration", "Keep it on");
    if (choice !== "Turn off integration") return undefined;
    await integrationStore.clearApiKey(context.secrets, provider);
    await saveIntegrations(integrations.setCredentialConfigured(
      integrations.revokeIntegration(integrationRegistry, provider, new Date().toISOString()), provider, false, new Date().toISOString()));
    void vscode.window.showInformationMessage(`${provider} is off in this profile. The research worker no longer receives its settings.`);
    return integrationView(provider);
  }
  async function resetIntegration(provider) {
    const choice = await vscode.window.showWarningMessage(`Reset ${provider} in this VS Code profile?`,
      { modal: true, detail: "Your stored key for it is removed, its authorization is withdrawn and the Toolkit stops handing it to the research worker. Nothing in your workspace, and nothing you configured outside the Toolkit, is touched." },
      "Reset integration");
    if (choice !== "Reset integration") return undefined;
    await integrationStore.clearApiKey(context.secrets, provider);
    await saveIntegrations(integrations.resetIntegration(integrationRegistry, provider, new Date().toISOString()));
    return integrationView(provider);
  }
  register("researchToolkit.activateIntegration", (provider) => activateIntegration(provider));
  register("researchToolkit.setIntegrationApiKey", (provider) => setIntegrationKey(provider));
  register("researchToolkit.setZoteroWriteKey", () => setZoteroWriteKey());
  register("researchToolkit.checkIntegrations", () => exclusive(() => runIntegrationProbe(undefined)));
  register("researchToolkit.resetIntegration", (provider) => resetIntegration(provider));

  async function handleMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.type === "ready") {
      panelReady = true;
      // The first paint should already report whether each recorded step still has the files it produced.
      await loadPlanArtifacts();
      refresh();
      // 0.3.10: the update check runs when the operator is looking at the panel, not at activation. A
      // check nobody is reading is a request nobody can explain, and the cooldown keeps it to one a day.
      void runUpdateCheck({ force: false, notify: false }).catch(() => {});
      return;
    }
    const actions = {
      readiness: "researchToolkit.showPhaseReadiness", settings: "researchToolkit.openSettings",
      help: "researchToolkit.openHelp", copy: "researchToolkit.copyReadiness", refresh: "researchToolkit.refresh",
      check: "researchToolkit.checkComponents", diagnose: "researchToolkit.diagnoseToolLimit",
      readingCheck: "researchToolkit.runReadingCheck", readDocument: "researchToolkit.readSelectedDocument",
      copyPreset: "researchToolkit.copyPresetSummary", status: "researchToolkit.refreshComponentStatus", rollback: "researchToolkit.rollbackRuntime",
      retry: "researchToolkit.retryFailedSteps", clearLock: "researchToolkit.clearSetupLock", setupLog: "researchToolkit.openSetupLog", copySetup: "researchToolkit.copyInstallationDiagnostics",
      indexCorpus: "researchToolkit.indexSelectedSources", verifySources: "researchToolkit.verifySourceFreshness",
      installBundle: "researchToolkit.installTopicBundle", repairBundle: "researchToolkit.repairTopicBundle", bundleStatus: "researchToolkit.showBundleStatus",
      // 0.3.14: accepted here as the route the panel control takes. The three bundle commands are offered
      // both ways now — a button in `ui.js` and a Command Palette entry — and the panel check names the row.
      // An allowlist entry with no control would be a route, not an offer; that was true when this line was
      // written and `ui.js` changed it.
      forceBundleUpdate: "researchToolkit.forceUpdateTopicBundle", bundleArchives: "researchToolkit.showBundleArchiveHistory", restoreBundleArchive: "researchToolkit.restoreBundleArchive",
      // 0.3.14 (HR-12): accepted here on the same terms. The command writes a file, so the button and the
      // Command Palette entry both open the same review modal before anything is written; `ui.js` offers it
      // in the corpus-and-bundle row and the panel check asserts that row.
      configurePresetTools: "researchToolkit.configurePresetTools",
      report: "researchToolkit.reportProblem", checkUpdates: "researchToolkit.checkForUpdates", updateNow: "researchToolkit.updateExtension",
      integrations: "researchToolkit.manageIntegrations", checkIntegrations: "researchToolkit.checkIntegrations",
    };
    let resultMessage = "Done.";
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
        // DD15-07: the panel's radio list never shows a retired preset, so this is the other way in — a
        // message written by hand or replayed from an older panel. Refused, with the replacements named.
        if (message.id !== DEFAULT_PRESET && PRESETS_BY_ID.get(message.id).retired) {
          throw new TypeError(`Choose a tools preset this package still offers: ${presetRetirement(PRESETS_BY_ID.get(message.id), packageId)}`);
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
      } else if (message.type === "activateIntegration") {
        await activateIntegration(message.provider);
      } else if (message.type === "guideIntegrationInstall") {
        await guideZoteroInstall(message.provider);
      } else if (message.type === "requestApiKey") {
        await requestApiKey(message.provider);
      } else if (message.type === "continueWithoutKey") {
        await continueWithoutKey(message.provider);
      } else if (message.type === "testIntegrationKey") {
        await testIntegrationKey(message.provider);
      } else if (message.type === "checkIntegration") {
        if (!integrations.PROVIDERS.includes(message.provider)) throw new TypeError("Unknown integration.");
        // J1: the sentence the check produced is the panel's answer, not "Done.".
        resultMessage = (await exclusive(() => runIntegrationProbe(message.provider))).summary;
      } else if (message.type === "setIntegrationKey") {
        await setIntegrationKey(message.provider);
      } else if (message.type === "clearIntegrationKey") {
        await clearIntegrationKey(message.provider);
      } else if (message.type === "deactivateIntegration") {
        await deactivateIntegration(message.provider);
      } else if (message.type === "resetIntegration") {
        await resetIntegration(message.provider);
      } else if (message.type === "readIntegrationFacts") {
        resultMessage = await exclusive(() => readIntegrationFacts());
      } else if (message.type === "action" && Object.hasOwn(actions, message.action)) {
        await vscode.commands.executeCommand(actions[message.action]);
      } else {
        throw new TypeError("Unsupported control panel action.");
      }
      const echo = message.requestId === undefined ? {} : { requestId: message.requestId };
      if (panel) await panel.webview.postMessage({ type: "result", ...echo, message: message.type === "action" && message.action === "copy" ? "Readiness copied to clipboard." : resultMessage });
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
        ["Integrations & Accounts", "researchToolkit.manageIntegrations", "plug"],
      ].map(([label, command, icon]) => {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.command = { command, title: label };
        item.iconPath = new vscode.ThemeIcon(icon);
        item.tooltip = command === "researchToolkit.switchPackage" ? "Change saved package preference; the next setup offers this package's steps."
          : command === "researchToolkit.selectToolsPreset" ? "Choose the goal-shaped tools preset. It changes which tools the assistant is offered; nothing is installed."
            : command === "researchToolkit.setupLocalComponents" ? `Install this package's component steps (${pending} pending). Existing files and project environments are preserved.`
              : command === "researchToolkit.updateComponents" ? `Refresh component steps recorded by an earlier toolkit release. ${plan.counts.outdated || 0} outdated now.`
                : command === "researchToolkit.diagnoseToolLimit" ? "Explain the client tool ceiling and what this toolkit contributes to it."
                  : command === "researchToolkit.manageIntegrations" ? "Zotero and Semantic Scholar: what is installed, what you authorized, and whether either one answers. Saved once for this VS Code profile."
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
    // J4: the capability belongs to the folder it was measured in; a new folder has not been measured.
    managedWorkerPresent = false;
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
    try { runtime = await probeRuntime(folder); } catch { managedWorkerPresent = false; return; }
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
      // DD15-07: a retired preset is not in this list, so an operator whose saved value is one would see
      // only other people's goals. The retirement and its replacements are named on the row they can act on
      // (follow the package default) and in the line they read before choosing anything.
      const retirementHere = presetRetirement(PRESETS_BY_ID.get(currentId), packageId);
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
              ? `Default for this package: ${PRESETS_BY_ID.get(defaultPresetFor(packageId)).label}${retirementHere ? ` · ${retirementHere}` : ""}`
              : `${estimate.toolkitTools} toolkit tools · ≈${Math.round(estimate.tokensEstimate / 100) / 10}k tokens (${estimateLabel(estimate)})${recentlyUsed}${applied}`,
          };
        }),
        { title: "Choose a tools preset for your goal", placeHolder: retirementHere
          ? "Your saved preset is retired and is no longer offered; the presets that replace it are named on the last row" : "Fewer, goal-shaped tools usually make tool selection more reliable" },
      );
      if (!picked) return undefined;
      selectedId = picked.id;
    }
    if (selectedId !== DEFAULT_PRESET && (!PRESETS_BY_ID.has(selectedId) || !PRESETS_BY_ID.get(selectedId).packages.includes(packageId))) {
      throw new TypeError(`Unknown tools preset for the selected package: ${String(selectedId)}`);
    }
    // DD15-07: a retired id resolves when it is what the operator already saved, but it is not a choice the
    // Toolkit will make now — choosing it again would put an unnamed third-party estimate back into the
    // surface, which is exactly what 0.3.14 stopped allowing. The refusal names the replacements.
    const chosen = selectedId === DEFAULT_PRESET ? undefined : PRESETS_BY_ID.get(selectedId);
    if (chosen && chosen.retired) {
      throw new TypeError(`Choose a tools preset this package still offers: ${presetRetirement(chosen, packageId)}`);
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
  presetsForPackage, defaultPresetFor, presetRetirement, presetEstimate, presetViews, selectedPresetId, toolsPresetSetting,
  presetScope, readRecentPresets,
};
