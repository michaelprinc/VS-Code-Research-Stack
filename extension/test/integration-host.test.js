"use strict";

/**
 * 0.3.11 — the integration onboarding wired into the extension host.
 *
 * `integrations.test.js`, `onboarding.test.js` and `credential-security.test.js` prove the state model and the
 * storage adapter on their own. Those modules are only worth shipping if the controller the editor actually loads
 * uses them, so this file drives the real commands through the same harness the rest of the suite uses: the modal
 * the operator sees, the record the profile keeps, the secret the editor stores, the environment the research
 * worker is handed, and the refusals that must happen before any local access is granted.
 *
 * Nothing here reaches a network. The readiness probe is a worker verb, so the worker call is supplied the way the
 * other host tests supply a process boundary, and the assertions are about what the Toolkit asked for.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { makeHarness } = require("./harness");
const integrations = require("../integrations");
const integrationProbe = require("../integrationprobe");
const integrationStore = require("../integrationstore");
const bundle = require("../worker/bundle.json");

const KEY = "alpha9bravo9charlie9";
const RECOMMENDED_SERVER = "research_stack.recommended_server";
// A goal that really calls Semantic Scholar, so the injection assertions are about a server that exists.
const GOAL = { toolsPreset: "research-core" };

async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-integration-host-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const foldersFor = (root) => [{ name: "Research <draft>", uri: { scheme: "file", fsPath: root } }];

/** A workspace that really has the locked managed worker, so `managedRuntime` resolves and a probe can be asked for. */
async function withWorker(root) {
  const worker = path.join(root, ".research-toolkit", "managed", `worker-${bundle.workerVersion}`);
  for (const relative of Object.keys(bundle.files)) {
    const target = path.join(worker, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(__dirname, "..", "worker", relative), target);
  }
  await fs.writeFile(path.join(worker, "installation.json"), `${JSON.stringify({ workerVersion: bundle.workerVersion, checks: { toolSurface: true } })}\n`);
  const bin = path.join(worker, process.platform === "win32" ? ".venv/Scripts" : ".venv/bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, process.platform === "win32" ? "python.exe" : "python"), "#!/bin/sh\nexit 0\n");
  return worker;
}

async function workerWorkspace(t) {
  const root = await scratch(t);
  return { root, worker: await withWorker(root) };
}

const receipt = (overrides = {}) => JSON.stringify({
  zotero: { outcome: "not-installed", code: "ZOTERO_NOT_AVAILABLE", installed: false, detail: "No Zotero data directory was found." },
  semanticScholar: { outcome: "auth-required", code: "PROVIDER_TERMS_NOT_ACKNOWLEDGED", credentialConfigured: false, licenseAcknowledged: false },
  ...overrides,
});

const run = (harness, command, ...args) => harness.registered.get(command)(...args);
const record = (harness, provider) => harness.globalState.get(integrationStore.REGISTRY_STATE_KEY).providers[provider];
const viewOf = (harness, provider) => harness.api.state().integrations.views.find((view) => view.id === provider);

async function definitions(harness) {
  return harness.api.mcpProvider.provideMcpServerDefinitions();
}

/** The environment the server that actually calls Semantic Scholar is handed. */
async function injected(harness) {
  const server = (await definitions(harness)).find((definition) => definition.args.includes(RECOMMENDED_SERVER));
  assert.ok(server, "the selected goal uses the server that calls Semantic Scholar, so there is something to inject into");
  return server.env;
}

// --- what the operator is asked, and what is not asked ---

test("a fresh window reports both integrations with four separate states and asks for nothing", async (t) => {
  const harness = makeHarness({ folders: foldersFor(await scratch(t)), initial: GOAL });
  const panel = harness.api.state().integrations;
  assert.deepEqual(panel.views.map((view) => view.id), ["zotero", "semantic-scholar"], "the panel carries exactly the two integrations this release knows, in the order the operator reads them");
  for (const view of panel.views) {
    for (const dimension of ["installation", "authorization", "readiness", "onboarding"]) {
      assert.ok(typeof view[dimension] === "string" && view[dimension].length, `${view.id} reports its ${dimension} as its own fact instead of one merged status flag`);
      assert.ok(integrations.DIMENSIONS[dimension].includes(view[dimension]), `${view.id} reports its ${dimension} in the vocabulary the model defines, not in an invented word`);
    }
    assert.equal(view.readiness, "unchecked", `${view.id} is not claimed ready before a check has run`);
  }
  assert.equal(harness.events.messages.length, 0, "activation asks nothing: no modal, no prompt, no permission request appears on opening a window");
  assert.equal(harness.events.secrets.length, 0, "activation reads and writes no secret");
  assert.equal(viewOf(harness, "zotero").consentRequired, false, "Zotero local reading is not presented as an account decision");
  assert.equal(viewOf(harness, "semantic-scholar").consentRequired, true, "Semantic Scholar is presented as a decision the operator has to make");
  assert.equal(panel.lastProbeAt, null, "nothing has been probed in this profile yet");
  assert.ok(panel.cooldownMs > 0, "the panel is told the shared check budget, so several windows cannot stampede one service");
  const rows = harness.provider.getChildren();
  assert.ok(rows.some((row) => row.label === "Integrations & Accounts" && row.command.command === "researchToolkit.manageIntegrations"),
    "the Toolkit's own tree offers the integrations, so the flow is reachable without knowing a command id");
});

test("opening the licence is not activating: the record stays undecided and nothing is injected", async (t) => {
  const root = await scratch(t);
  await withWorker(root);
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, pickButton: "Read the API licence" });
  await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  const entry = record(harness, "semantic-scholar");
  assert.equal(entry.authorization, "awaiting-consent", "reading the licence leaves the decision open, exactly as it should");
  assert.equal(entry.license.acknowledged, false, "no acknowledgement is recorded on the operator's behalf");
  assert.equal(entry.onboarding, "in-progress", "the guide is recorded as started, so a second window does not open a second guide beside this one");
  assert.equal(harness.events.external, integrations.API_LICENSE_URL, "the licence was opened in the host browser, not paraphrased inside the Toolkit");
  const both = harness.events.messages.find((message) => message.kind === "warning").options.detail;
  assert.match(both, /semanticscholar\.org\/product\/api\/license/, "the confirmation names the API Licence it is a confirmation of");
  assert.match(both, /api\.semanticscholar\.org\/license/, "and names the Dataset License Agreement as a separate text");
  assert.equal(harness.secrets.size, 0, "no key was asked for and none was stored");
  const env = await injected(harness);
  assert.ok(!env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED, "an undecided integration is not handed to the research worker");
});

test("activating Semantic Scholar records the operator's own confirmation once, with a reference and a time", async (t) => {
  const harness = makeHarness({ folders: foldersFor(await scratch(t)), initial: GOAL, pickButton: "Activate without an API key" });
  const view = await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  const asked = harness.events.messages.find((message) => message.kind === "warning" && message.buttons.includes("Activate without an API key"));
  assert.ok(asked.options && asked.options.modal === true, "the licence decision is a modal the operator has to answer, not a toast that fades away");
  assert.match(asked.options.detail, /api\.semanticscholar\.org\/license/, "the confirmation names the licence it is a confirmation of");
  assert.match(asked.options.detail, /not a grant of rights/, "the confirmation says what it is not, so it cannot be read as a licence");
  assert.equal(view.authorization, "authorized", "the record now says the operator authorized it");
  assert.equal(view.mode, "anonymous", "activating without a key means anonymous, and the Toolkit does not quietly add a key mode");
  const entry = record(harness, "semantic-scholar");
  assert.equal(entry.license.acknowledged, true, "the acknowledgement is stored");
  assert.equal(entry.license.reference, integrations.LICENSE_REFERENCE, "the record names which licence text was confirmed, so a later change to the licence is visible");
  assert.ok(Number.isFinite(Date.parse(entry.license.acknowledgedAt)), "the record carries the time the operator pressed the button");
  assert.equal(entry.installation, "not-applicable", "Semantic Scholar has nothing to install on this machine, and the Toolkit does not pretend otherwise");
  assert.equal(entry.onboarding, "completed", "the guide is finished for this profile, so no later workspace starts it again");
});

test("the record is global to the profile, so a second workspace in the same profile does not ask again", async (t) => {
  const root = await scratch(t);
  await withWorker(root);
  const first = makeHarness({ folders: foldersFor(root), initial: GOAL, pickButton: "Activate without an API key" });
  await run(first, "researchToolkit.activateIntegration", "semantic-scholar");
  const saved = JSON.parse(JSON.stringify(first.globalState.get(integrationStore.REGISTRY_STATE_KEY)));
  assert.equal(saved.schemaVersion, integrations.SCHEMA_VERSION, "the saved record declares the format a later release can migrate from");

  const otherRoot = await scratch(t);
  await withWorker(otherRoot);
  const second = makeHarness({ folders: foldersFor(otherRoot), initial: GOAL, initialGlobalState: { [integrationStore.REGISTRY_STATE_KEY]: saved } });
  const view = viewOf(second, "semantic-scholar");
  assert.equal(view.authorization, "authorized", "a new workspace reads the decision the operator already made in this profile");
  assert.equal(view.consentRequired, false, "and it no longer presents the decision as open");
  assert.equal(second.events.messages.length, 0, "it asks nothing: no re-confirmation, no registration prompt, no key request");
  assert.equal(second.events.secrets.length, 0, "it does not even read the secret until a check is asked for");
  const env = await injected(second);
  assert.equal(env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED, "true", "the confirmation the operator already gave is what the worker is handed");
  assert.ok(!("SEMANTIC_SCHOLAR_API_KEY" in env), "no key is invented for an anonymous activation");
});

test("saying \"not now\" is a refusal, not a consent, and the guide can be resumed later", async (t) => {
  const root = await scratch(t);
  await withWorker(root);
  const declined = makeHarness({ folders: foldersFor(root), initial: GOAL, pickButton: "Not now" });
  const view = await run(declined, "researchToolkit.activateIntegration", "semantic-scholar");
  assert.equal(view.authorization, "awaiting-consent", "declining authorizes nothing, and the Toolkit does not read a refusal as an agreement");
  assert.equal(view.onboarding, "skipped", "the guide is recorded as not finished, which is what makes it resumable rather than lost");
  assert.equal(declined.secrets.size, 0, "no key was stored");
  const env = await injected(declined);
  assert.ok(!env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED && !("SEMANTIC_SCHOLAR_API_KEY" in env), "nothing is handed to the research worker");
  assert.match(declined.events.messages.map((message) => message.text).join("\n"), /resume it from Integrations & Accounts/, "the operator is told where to pick it back up");

  const saved = JSON.parse(JSON.stringify(declined.globalState.get(integrationStore.REGISTRY_STATE_KEY)));
  const later = makeHarness({ folders: foldersFor(root), initial: GOAL, initialGlobalState: { [integrationStore.REGISTRY_STATE_KEY]: saved }, pickButton: "Activate without an API key" });
  const resumed = await run(later, "researchToolkit.activateIntegration", "semantic-scholar");
  assert.equal(resumed.authorization, "authorized", "the same guide, opened later in the same profile, still works");
  assert.equal(resumed.onboarding, "completed", "and it finishes, rather than being refused because the guide was skipped once");
});

test("a key the operator pastes lands in secret storage only, and never appears in state the panel renders", async (t) => {
  const harness = makeHarness({ folders: foldersFor(await scratch(t)), initial: GOAL, pickButton: "Activate without an API key", reportNote: KEY });
  await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  const view = await run(harness, "researchToolkit.setIntegrationApiKey", "semantic-scholar");
  assert.equal(harness.secrets.get(integrationStore.secretKey("semantic-scholar")), KEY, "the key is stored under the Toolkit's own secret name in the editor's secret storage");
  assert.equal(view.credentialConfigured, true, "the panel is told a key exists, which is all it is told");
  assert.equal(view.mode, "api-key", "adding a key moves the mode, so the operator can see which path is in use");
  assert.ok(!JSON.stringify(harness.globalState).includes(KEY), "the key is not in the profile state the Toolkit writes");
  assert.ok(!JSON.stringify(harness.api.state()).includes(KEY), "the key is not in the state the Control Panel renders");
  assert.ok(!harness.output.lines.join("\n").includes(KEY), "the key is not in the Toolkit output channel");
  assert.ok(!JSON.stringify(harness.events.messages).includes(KEY), "the key is never shown back to the operator or repeated in a message");
  assert.equal(harness.events.inputBox.password, true, "the key field is a password field, so it is not echoed on screen");
});

test("a value that cannot be a key is refused before anything is stored", async (t) => {
  const harness = makeHarness({ folders: foldersFor(await scratch(t)), initial: GOAL, pickButton: "Activate without an API key", reportNote: "short" });
  await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  await assert.rejects(() => run(harness, "researchToolkit.setIntegrationApiKey", "semantic-scholar"),
    /did not store the key/, "a value too short to be a provider key is refused with a sentence the operator can act on, not a stack trace");
  assert.equal(harness.secrets.size, 0, "and nothing was stored");
  assert.equal(viewOf(harness, "semantic-scholar").credentialConfigured, false, "the panel still says no key is stored");
});

test("a key is refused before activating, because the Toolkit stores keys only for what the operator authorized", async (t) => {
  const harness = makeHarness({ folders: foldersFor(await scratch(t)), initial: GOAL, reportNote: KEY });
  await assert.rejects(() => run(harness, "researchToolkit.setIntegrationApiKey", "semantic-scholar"),
    /Activate the integration before adding a key/, "the refusal says what to do first");
  assert.equal(harness.secrets.size, 0, "no secret was written for an integration that was never authorized");
  await assert.rejects(() => run(harness, "researchToolkit.setIntegrationApiKey", "zotero"),
    /no key/, "Zotero is refused too: local reading has no key to store, so the Toolkit does not offer a box for one");
});

test("turning an integration off removes the secret and stops handing anything to the worker", async (t) => {
  const root = await scratch(t);
  await withWorker(root);
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, pickButton: "Activate without an API key", reportNote: KEY });
  await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  await run(harness, "researchToolkit.setIntegrationApiKey", "semantic-scholar");
  assert.equal((await injected(harness)).SEMANTIC_SCHOLAR_API_KEY, KEY, "while it is on, the worker is handed the key");
  // Reached the way the operator reaches it: the Turn off button on the card, not a command id.
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "deactivateIntegration", provider: "semantic-scholar" });
  const view = viewOf(harness, "semantic-scholar");
  assert.equal(harness.secrets.size, 0, "turning it off removes the stored key");
  assert.equal(view.authorization, "revoked", "the record says the operator turned it off, which is a decision, not a failure");
  assert.equal(view.credentialConfigured, false, "and the panel knows no key is stored");
  const env = await injected(harness);
  assert.ok(!("SEMANTIC_SCHOLAR_API_KEY" in env) && !env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED, "the research worker is handed neither the key nor the licence flag");
  const entry = record(harness, "semantic-scholar");
  assert.equal(entry.license.acknowledged, false, "turning off withdraws the confirmation too, so nothing is handed out that the operator has just withdrawn");
  assert.equal(entry.onboarding, "completed", "but the guide is not undone: switching back on does not re-run the walkthrough");
  assert.equal(entry.readiness, "unchecked", "and no readiness from an earlier check is kept for a service that is off");
});

test("resetting withdraws the confirmation as well, and says so before it does it", async (t) => {
  const harness = makeHarness({ folders: foldersFor(await scratch(t)), initial: GOAL, pickButton: "Activate without an API key", reportNote: KEY });
  await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  await run(harness, "researchToolkit.setIntegrationApiKey", "semantic-scholar");
  const view = await run(harness, "researchToolkit.resetIntegration", "semantic-scholar");
  const warning = harness.events.messages.filter((message) => message.kind === "warning").at(-1);
  assert.ok(warning.options.modal === true, "reset is destructive to the authorization, so it is confirmed in a modal");
  assert.match(warning.options.detail, /Nothing in your workspace/, "the modal says plainly what reset does not touch");
  assert.equal(view.authorization, "awaiting-consent", "reset returns the integration to the state before the operator decided");
  assert.equal(record(harness, "semantic-scholar").license.acknowledged, false, "the confirmation is withdrawn too, not left behind as a stale claim");
  assert.equal(harness.secrets.size, 0, "and the key is gone");
});

// --- the check itself: what may run, and what must not ---

test("an untrusted workspace gets no local access and no probe", async (t) => {
  const harness = makeHarness({ folders: foldersFor(await scratch(t)), initial: GOAL, trusted: false });
  await assert.rejects(() => run(harness, "researchToolkit.checkIntegrations"),
    /trusted local workspace/, "the refusal names the reason the operator can act on: the workspace is not trusted");
  assert.ok(harness.api.state().integrations.views.every((view) => view.readiness === "unchecked"), "no readiness is recorded from a check that was refused");
  assert.equal(harness.globalState.get(integrationStore.REGISTRY_STATE_KEY), undefined, "a refused check writes nothing at all into the profile");
});

test("a workspace without the locked worker is told the check needs setup, instead of being reported as not ready", async (t) => {
  const harness = makeHarness({ folders: foldersFor(await scratch(t)), initial: GOAL });
  await assert.rejects(() => run(harness, "researchToolkit.checkIntegrations"),
    /Set up package components before checking integrations/, "the Toolkit refuses rather than reporting a service as absent when it has no worker to ask");
  assert.ok(harness.api.state().integrations.views.every((view) => view.readiness === "unchecked"), "a refused check leaves readiness unchecked, so the panel cannot show a false not-installed");
});

test("several windows share one check budget, and the second window is told to wait", async (t) => {
  const root = await scratch(t);
  await withWorker(root);
  let launched = 0;
  const services = { runProcess: async () => { launched += 1; return { exitCode: 0, stdout: receipt(), stderr: "" }; } };
  const first = makeHarness({ folders: foldersFor(root), initial: GOAL, pickButton: "Activate without an API key", diagnosticServices: services });
  await run(first, "researchToolkit.activateIntegration", "semantic-scholar");
  await run(first, "researchToolkit.checkIntegrations");
  assert.equal(launched, 1, "one check runs one worker call for both services");
  const saved = JSON.parse(JSON.stringify(first.globalState.get(integrationStore.REGISTRY_STATE_KEY)));
  assert.ok(Number.isFinite(saved.lastProbeAt), "the shared budget is stored as a readable instant, with the record rather than in a window that closes");
  const second = makeHarness({ folders: foldersFor(root), initial: GOAL, initialGlobalState: { [integrationStore.REGISTRY_STATE_KEY]: saved }, diagnosticServices: services });
  await assert.rejects(() => run(second, "researchToolkit.checkIntegrations"),
    /share one check budget/, "a second window in the same profile is refused with the reason, not silently rate limited by the provider");
  assert.equal(launched, 1, "and the refusal ran nothing");
});

test("the check is one worker call with the reviewed interpreter flags and no key until one is authorized", async (t) => {
  const { root } = await workerWorkspace(t);
  const calls = [];
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL,
    diagnosticServices: { runProcess: async (executable, args, options) => { calls.push({ executable, args, options }); return { exitCode: 0, stdout: receipt(), stderr: "" }; } },
  });
  await run(harness, "researchToolkit.checkIntegrations");
  assert.equal(calls.length, 1, "one check is one worker call, not a request per service");
  assert.deepEqual(calls[0].args, ["-I", "-B", "-X", "utf8", "-m", "research_stack.cli", "probe-integrations", "--providers", "zotero,semantic_scholar"],
    "the probe runs in the locked worker with the same interpreter flags the research tools use");
  assert.ok(!("SEMANTIC_SCHOLAR_API_KEY" in calls[0].options.env), "an integration nobody authorized is not handed a key");
  assert.ok(!calls[0].options.env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED, "nor the licence flag");
  assert.equal(calls[0].options.timeout, integrationProbe.PROBE_TIMEOUT_MS, "the check is bounded by a timeout, so a hung service cannot hold the window open — and by the bound the probe module publishes, not by a number repeated here");
  assert.equal(calls[0].options.cwd, root, "the check runs in the selected workspace, the same place the research tools run");
});

test("a rate-limited check keeps the authorization and the key, and records what the worker said", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL, pickButton: "Activate without an API key", reportNote: KEY,
    diagnosticServices: { runProcess: async (executable, args, options) => { harness.lastEnv = options.env; return { exitCode: 0, stdout: receipt({ semanticScholar: { outcome: "rate-limited", code: "RATE_LIMITED", retryAfter: "3600 seconds", credentialConfigured: true } }), stderr: "" }; } },
  });
  await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  await run(harness, "researchToolkit.setIntegrationApiKey", "semantic-scholar");
  await run(harness, "researchToolkit.checkIntegrations");
  assert.equal(harness.lastEnv.SEMANTIC_SCHOLAR_API_KEY, KEY, "an authorized api-key mode is handed the key, which is the only place a key reaches a process environment");
  assert.equal(harness.lastEnv.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED, "true", "and it is handed the confirmation the operator gave");
  const saved = harness.globalState.get(integrationStore.REGISTRY_STATE_KEY);
  assert.equal(saved.providers["semantic-scholar"].authorization, "authorized", "a 429 is not read as a withdrawal of consent");
  assert.equal(saved.providers["semantic-scholar"].mode, "api-key", "and it is not read as a reason to drop the key mode");
  assert.equal(saved.providers["semantic-scholar"].readiness, "degraded", "the panel shows the pause as its own state, not as a failure of the integration");
  assert.equal(saved.providers["semantic-scholar"].lastCheck.retryAfter, "3600 seconds", "the pause the service named is kept, so the operator is told a window and not a mood");
  assert.equal(saved.providers["semantic-scholar"].lastCheck.at, new Date(saved.lastProbeAt).toISOString(), "the check time is recorded with the verdict");
  assert.equal(saved.providers.zotero.readiness, "unavailable", "and Zotero is reported as the worker found it, separately from the other service");
  assert.match(viewOf(harness, "semantic-scholar").detail, /3600 seconds/, "the panel repeats the pause in the sentence the operator reads");
  const shown = harness.output.lines.at(-1);
  assert.match(shown, /rate limited/, "the output channel says what a pause means for the operator");
  assert.ok(!shown.includes(KEY), "the receipt is written to the output channel with the key removed from it");
  assert.equal(harness.secrets.get(integrationStore.secretKey("semantic-scholar")), KEY, "the stored key survives the pause untouched");
});

test("a worker that answers with garbage is a stated refusal, and nothing is claimed ready from it", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: "not json at all", stderr: "" }) } });
  await assert.rejects(() => run(harness, "researchToolkit.checkIntegrations"),
    /unreadable data\. Nothing was recorded from it/, "an unreadable receipt is refused with the promise that nothing was recorded");
  assert.equal(harness.globalState.get(integrationStore.REGISTRY_STATE_KEY), undefined, "nothing was written, so the shared budget is not spent on a check that produced nothing");
  assert.ok(harness.api.state().integrations.views.every((view) => view.readiness === "unchecked"), "no readiness is claimed from a receipt that could not be read");
});

test("a worker that fails is reported as a failed check, not as a service that is absent", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async () => ({ exitCode: 2, stdout: "", stderr: "error: no such command 'probe-integrations'" }) } });
  await assert.rejects(() => run(harness, "researchToolkit.checkIntegrations"),
    /integration check failed/, "a worker that refuses is named as a failed check");
  assert.ok(harness.api.state().integrations.views.every((view) => view.readiness === "unchecked"), "and no service is labelled not-installed because the Toolkit could not ask");
});

// --- what the research worker is handed ---

test("only the server that uses the provider receives the integration state, and its signature moves with the decision", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL, pickButton: "Activate without an API key", reportNote: KEY,
    diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt(), stderr: "" }) },
  });
  const before = await definitions(harness);
  assert.ok(before.length >= 2, "the managed worker offers the host the servers this goal uses, including the one that calls Semantic Scholar");
  for (const definition of before) {
    assert.ok(!("SEMANTIC_SCHOLAR_API_KEY" in definition.env) && !definition.env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED,
      `nothing is injected into "${definition.label}" before the operator decides`);
  }
  const beforeRecommended = before.find((definition) => definition.args.includes(RECOMMENDED_SERVER));
  await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  const after = await definitions(harness);
  const afterRecommended = after.find((definition) => definition.args.includes(RECOMMENDED_SERVER));
  assert.equal(afterRecommended.env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED, "true", "the server that calls Semantic Scholar is handed the confirmation the operator gave");
  assert.ok(!("SEMANTIC_SCHOLAR_API_KEY" in afterRecommended.env), "and no key, because the operator chose the anonymous mode");
  assert.notEqual(afterRecommended.version, beforeRecommended.version, "the server signature changes with the integration state, so the host does not keep a stale tool surface");
  assert.match(afterRecommended.version, new RegExp(`^${require("../package.json").version.replace(/\./g, "\\.")}\\+research-core:[0-9a-f]{12}$`), "the signature keeps its shape: this release's version, the goal and a digest, with no secret in it. The version is read from the shipped manifest — pinning it here is how a bump turns this into a false failure.");
  for (const definition of after.filter((item) => !item.args.includes(RECOMMENDED_SERVER))) {
    assert.ok(!("SEMANTIC_SCHOLAR_API_KEY" in definition.env) && !definition.env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED,
      `"${definition.label}" does not call this provider, so it is handed nothing`);
  }
  await run(harness, "researchToolkit.setIntegrationApiKey", "semantic-scholar");
  const withKey = (await definitions(harness)).find((definition) => definition.args.includes(RECOMMENDED_SERVER));
  assert.equal(withKey.env.SEMANTIC_SCHOLAR_API_KEY, KEY, "the key reaches the process environment of exactly the server that needs it");
  assert.ok(!withKey.version.includes(KEY) && withKey.version.length < 64, "the key is not folded into the signature the host logs");
});

test("an integration record from an older release is read, not discarded, and never invents a key", async (t) => {
  const root = await scratch(t);
  await withWorker(root);
  const legacy = {
    schemaVersion: 1,
    providers: {
      zotero: { installation: "unknown", authorization: "not-required", readiness: "unchecked", onboarding: "not-started" },
      "semantic-scholar": {
        installation: "not-applicable", authorization: "authorized", readiness: "ready", onboarding: "completed", mode: "api-key",
        credentials: { storage: "vscode-secret-storage", configured: true },
        license: { acknowledged: true, reference: "s2-api-license-2026-11", acknowledgedAt: "2026-11-01T00:00:00.000Z" },
      },
    },
  };
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL, initialGlobalState: { [integrationStore.REGISTRY_STATE_KEY]: legacy },
    diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt({ semanticScholar: { outcome: "ready", code: "OK" } }), stderr: "" }) },
  });
  const view = viewOf(harness, "semantic-scholar");
  assert.equal(view.authorization, "authorized", "a decision the operator already made is honoured after an upgrade");
  assert.equal(view.onboarding, "completed", "and the guide is not re-run in the new workspace");
  const env = await injected(harness);
  assert.ok(!("SEMANTIC_SCHOLAR_API_KEY" in env), "but no key is invented for the worker: the record claims one, secret storage has none");
  assert.equal(env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED, "true", "the confirmation the record carries is still handed over, because the operator gave it");
  await run(harness, "researchToolkit.checkIntegrations");
  assert.equal(viewOf(harness, "semantic-scholar").credentialConfigured, false, "and once the Toolkit has actually looked, the panel stops claiming a key that is not there");
});

test("a record that claims a confirmation it cannot show is treated as no confirmation", async (t) => {
  const root = await scratch(t);
  await withWorker(root);
  const lying = {
    schemaVersion: 1,
    providers: { "semantic-scholar": { authorization: "authorized", readiness: "ready", onboarding: "completed", mode: "api-key", license: { acknowledged: false } } },
  };
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, initialGlobalState: { [integrationStore.REGISTRY_STATE_KEY]: lying } });
  const view = viewOf(harness, "semantic-scholar");
  assert.equal(view.authorization, "awaiting-consent", "the Toolkit never assumes an agreement it cannot point to");
  assert.equal(view.readiness, "unchecked", "and the readiness that arrived with the unverifiable claim is not kept either");
  const env = await injected(harness);
  assert.ok(!env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED && !("SEMANTIC_SCHOLAR_API_KEY" in env), "nothing is handed to the research worker on the strength of a claim");
});

// --- guided installation and the guided key request (INT-13A, INT-14.1) ---

const labelsOffered = (harness) => harness.events.quickPicks.at(-1).items.map((item) => item.label);
const offers = (view, id) => view.actions.some(([action]) => action === id);
const lastMessage = (harness) => harness.events.messages.at(-1);

test("a Zotero the check could not find is offered the guided path, and the Toolkit states that it downloaded and ran nothing (T12-23)", async (t) => {
  const { root } = await workerWorkspace(t);
  const calls = [];
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL, quickPicks: ["Zotero", "Guided installation"], pickButton: "Open the official download page",
    diagnosticServices: {
      runProcess: async (executable, args) => {
        calls.push(args);
        // This machine record holds no fact, which is the negative case: the flow behaves exactly as it did
        // before INT-15 existed.
        return { exitCode: 0, stdout: args.includes("integration-facts") ? JSON.stringify({ schemaVersion: 1, facts: {} }) : receipt(), stderr: "" };
      },
    },
  });
  await run(harness, "researchToolkit.checkIntegrations");
  const view = viewOf(harness, "zotero");
  assert.equal(view.installation, "not-detected", "the check found no Zotero on this machine");
  assert.ok(offers(view, "guideInstall"), "the card is offered a guided installation");
  assert.ok(offers(view, "installedNow"), "and the re-check the operator asks for when the installation is finished");
  await run(harness, "researchToolkit.manageIntegrations");
  assert.ok(labelsOffered(harness).includes("Guided installation"), "the Quick Pick offers the same action the card offers, from the same record");
  assert.ok(labelsOffered(harness).includes("I have installed Zotero — check it now"), "including the operator-initiated re-check");
  const asked = lastMessage(harness);
  assert.equal(asked.options.modal, true, "the guide is a modal the operator answers, not a toast that fades");
  assert.match(asked.text, /downloaded nothing and ran nothing/, "the Toolkit says plainly what it did not do");
  assert.match(asked.text, /opened no installer, wrote no file and changed no setting/, "and names each thing it did not do");
  assert.match(asked.options.detail, /does not watch for the installation, poll for it or schedule anything/, "the re-check is the operator's act, not a timer (NF12-04, DD11-07)");
  assert.match(asked.options.detail, /www\.zotero\.org\/download/, "the guide names the official download page the repository already names");
  assert.equal(harness.events.external, integrations.ZOTERO_DOWNLOAD_URL, "the button opens that page in the host browser, through the reviewed mechanism, with no new capability");
  // Renegotiated for INT-15.2 (DD12-02), in the open rather than quietly relaxed. The bound used to read
  // "opening the guided-install flow launches nothing beyond the check the operator already asked for".
  // INT-15.2 requires a new profile to reuse a machine-level installation fact instead of re-asking, and the
  // only place to read that fact is the integrations flow the operator just opened. The bound is now stated
  // as: opening the integrations flow launches at most ONE worker call, it is `integration-facts` and nothing
  // else, it reaches no provider and reads no secret — and the guided-installation path itself still launches
  // nothing at all.
  const factsCalls = calls.filter((args) => args.includes("integration-facts"));
  const otherCalls = calls.filter((args) => !args.includes("integration-facts"));
  assert.equal(factsCalls.length, 1, "opening the integrations flow launched exactly one worker call: the machine-record read INT-15.2 exists to make, and no more");
  assert.deepEqual(factsCalls[0], ["-I", "-B", "-X", "utf8", "-m", "research_stack.cli", "integration-facts"], "it is the facts verb and nothing else — no probe, no download, no installer, no second read");
  assert.equal(otherCalls.length, 1, "the guided-install path itself launched no worker call: the only other call is the check the operator already asked for");
  assert.equal(harness.events.secrets.length, 0, "and the read reached no secret");
  assert.equal(viewOf(harness, "zotero").installation, "not-detected", "a machine record holding no fact changes nothing: with nothing to reuse, the flow behaves exactly as it did before INT-15");
  assert.deepEqual(harness.events.writtenFiles, [], "and no file was written on the way to an installation the Toolkit did not perform");
});

test("a Zotero that answered is never offered an installation, in the card or in the Quick Pick (T12-22)", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL, quickPicks: ["Zotero", null],
    diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt({ zotero: { outcome: "ready", code: "OK", installed: true, serverId: "Zotero 7" } }), stderr: "" }) },
  });
  await run(harness, "researchToolkit.checkIntegrations");
  const view = viewOf(harness, "zotero");
  assert.equal(view.installation, "detected", "the check found Zotero");
  assert.equal(view.readiness, "ready", "and it answered");
  assert.ok(!offers(view, "guideInstall") && !offers(view, "installedNow"), "so no installation is offered to someone who has one");
  await run(harness, "researchToolkit.manageIntegrations");
  assert.ok(!labelsOffered(harness).some((label) => /install/i.test(label)), "the Quick Pick offers no installation either — the operator is not re-pitched");
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "guideIntegrationInstall", provider: "zotero" });
  assert.equal(harness.events.external, undefined, "and even a guided-install request is refused before any page is opened");
  assert.match(lastMessage(harness).text, /already installed/, "with the reason the operator can read");
});

test("a Zotero that refuses local clients is named as refusing, in the wording this repository already uses", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL,
    diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt({ zotero: { outcome: "api-disabled", code: "ZOTERO_API_DISABLED", installed: true } }), stderr: "" }) },
  });
  await run(harness, "researchToolkit.checkIntegrations");
  const view = viewOf(harness, "zotero");
  assert.equal(view.installation, "detected", "the Toolkit does not report an installed Zotero as missing");
  assert.ok(view.detail.includes(integrations.ZOTERO_LOCAL_API_SETTING), "the guidance names the Zotero setting");
  const guide = await fs.readFile(path.join(__dirname, "..", "guides", "zotero-local-api.md"), "utf8");
  assert.ok(guide.includes(integrations.ZOTERO_LOCAL_API_SETTING), "in the exact wording guides/zotero-local-api.md already uses — one wording, one place");
  assert.ok(!/not installed|no Zotero was found/i.test(`${view.label} ${view.detail}`), "and says nowhere that Zotero is missing");
  assert.ok(!offers(view, "guideInstall"), "no installation is offered for software that is there");
  assert.ok(offers(view, "apiGuide"), "the guidance action is offered instead");
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "guide", id: "zotero-local-api" });
  assert.ok(harness.invoked.some((item) => item.id === "researchToolkit.openComponentGuide" && item.args[0] === "zotero-local-api"), "the card's guidance button goes through the reviewed guide command, not a new one");
});

test("nothing in the shipped integration path schedules a poll or a timer (NF12-04)", () => {
  const fsSync = require("node:fs");
  for (const name of ["extension.js", "integrations.js", "integrationprobe.js", "integrationstore.js"]) {
    const source = fsSync.readFileSync(path.join(__dirname, "..", name), "utf8");
    assert.ok(!/setTimeout\(|setInterval\(|setImmediate\(/.test(source), `${name} schedules nothing: the operator asks for the re-check, the Toolkit never watches for one`);
  }
});

test("with no key the operator is offered the guided request and the anonymous route; with a key, replace, remove and test (T12-14)", async (t) => {
  const { root } = await workerWorkspace(t);
  const services = { runProcess: async () => ({ exitCode: 0, stdout: receipt({ semanticScholar: { outcome: "ready", code: "OK" } }), stderr: "" }) };
  const noKey = makeHarness({ folders: foldersFor(root), initial: GOAL, quickPicks: ["Semantic Scholar", null], diagnosticServices: services });
  await run(noKey, "researchToolkit.checkIntegrations");
  const offered = viewOf(noKey, "semantic-scholar");
  assert.ok(offers(offered, "requestKey"), "the guided key request is offered");
  assert.ok(offers(offered, "noKey"), "and continuing without a key is a stated choice, not an absence");
  assert.ok(!offers(offered, "provideKey"), "no key box is offered before the integration is authorized, because the Toolkit would refuse to store a key for it");
  await run(noKey, "researchToolkit.manageIntegrations");
  assert.ok(labelsOffered(noKey).includes("Request a personal API key") && labelsOffered(noKey).includes("Continue without a key"), "the Quick Pick offers the same choices from the same record");

  const keyed = makeHarness({ folders: foldersFor(root), initial: GOAL, quickPicks: ["Semantic Scholar", null], pickButton: "Activate without an API key", reportNote: KEY, diagnosticServices: services });
  await run(keyed, "researchToolkit.activateIntegration", "semantic-scholar");
  await run(keyed, "researchToolkit.setIntegrationApiKey", "semantic-scholar");
  const withKey = viewOf(keyed, "semantic-scholar");
  assert.ok(offers(withKey, "replaceKey") && offers(withKey, "removeKey") && offers(withKey, "testKey"), "with a key stored the card offers replace, remove and test");
  assert.ok(!offers(withKey, "requestKey") && !offers(withKey, "noKey"), "and does not re-offer the guided key request to someone who already has a key");
  await run(keyed, "researchToolkit.manageIntegrations");
  assert.ok(labelsOffered(keyed).includes("Test the key"), "the Quick Pick carries the test action too");
  assert.ok(!labelsOffered(keyed).some((label) => /Request a personal API key|Continue without a key/.test(label)), "with no re-pitch in either surface");
});

test("the guided key request opens the provider's own application page and states how the key is delivered", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, pickButton: "Open the official application page" });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "requestApiKey", provider: "semantic-scholar" });
  assert.equal(harness.events.external, integrations.API_KEY_APPLICATION_URL, "the confirmed official application page is opened in the host browser, through the reviewed mechanism");
  const asked = lastMessage(harness);
  assert.equal(asked.options.modal, true, "the guide is a modal the operator answers");
  assert.match(asked.options.detail, /emails the key to you/, "the guide says how the key arrives");
  assert.match(asked.options.detail, /never receives, stores or sees that email/, "and that the Toolkit is not in that path");
  assert.match(asked.options.detail, /secret storage for this VS Code profile only/, "and where the key will live once the operator pastes it");
  assert.match(asked.options.detail, /never in a workspace file, a setting, a log or a problem report/, "and where it will not");
  assert.match(asked.options.detail, /one request per second across all endpoints/, "the capacity a key buys is stated as the provider states it, not per endpoint");
  assert.equal(record(harness, "semantic-scholar").keyDecision, "guided", "the record keeps the choice the operator made");
  assert.equal(record(harness, "semantic-scholar").credentials.configured, false, "and records no key");
  assert.equal(harness.secrets.size, 0, "nothing was stored");
});

test("choosing to continue without a key records that choice and nothing the operator did not give", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt(), stderr: "" }) } });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "continueWithoutKey", provider: "semantic-scholar" });
  const entry = record(harness, "semantic-scholar");
  assert.equal(entry.keyDecision, "declined", "the choice is recorded as the choice, so a later run does not ask again as if nothing happened (NF12-05)");
  assert.equal(entry.authorization, "awaiting-consent", "no consent was recorded");
  assert.equal(entry.license.acknowledged, false, "and none was inferred from a decision about a key");
  assert.equal(entry.credentials.configured, false, "no key was recorded");
  assert.notEqual(entry.onboarding, "completed", "the walkthrough is not marked finished by a step the operator declined");
  assert.equal(entry.mode, "anonymous", "the access mode says which path is in use");
  assert.equal(harness.secrets.size, 0, "SecretStorage was never written");
  assert.deepEqual(harness.events.secrets, [], "and never read");
  const env = await injected(harness);
  assert.ok(!env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED && !("SEMANTIC_SCHOLAR_API_KEY" in env), "the research worker is handed nothing");
  assert.match(harness.events.messages.map((message) => message.text).join("\n"), /No key was stored, nothing was authorized/, "the operator is told what was not done");
});

test("a key the operator already has lands only in secret storage, after the guided request (T12-15)", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL, pickButton: "Activate without an API key", reportNote: KEY,
    diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt({ semanticScholar: { outcome: "ready", code: "OK" } }), stderr: "" }) },
  });
  await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "setIntegrationKey", provider: "semantic-scholar" });
  assert.equal(harness.secrets.get(integrationStore.secretKey("semantic-scholar")), KEY, "the key is in the editor's secret storage, under the reviewed name");
  assert.equal(record(harness, "semantic-scholar").keyDecision, "provided", "the record says the operator provided it, which is what happened");
  assert.ok(!JSON.stringify(harness.globalState).includes(KEY), "it is not in the profile state");
  assert.ok(!JSON.stringify(harness.api.state()).includes(KEY), "not in the state the panel renders");
  assert.ok(!harness.output.lines.join("\n").includes(KEY), "not in the output channel");
  assert.ok(!JSON.stringify(harness.events.messages).includes(KEY), "not in any message shown to the operator");
  assert.ok(!harness.panels.some((item) => JSON.stringify(item.messages).includes(KEY)), "and not in any panel message");
});

test("the Test the key action runs one check and reports what the service said", async (t) => {
  const { root } = await workerWorkspace(t);
  let launched = 0;
  const seen = [];
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL, pickButton: "Activate without an API key", reportNote: KEY,
    diagnosticServices: { runProcess: async (executable, args, options) => { launched += 1; seen.push(options.env); return { exitCode: 0, stdout: receipt({ semanticScholar: { outcome: "ready", code: "OK" } }), stderr: "" }; } },
  });
  await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  await run(harness, "researchToolkit.setIntegrationApiKey", "semantic-scholar");
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "testIntegrationKey", provider: "semantic-scholar" });
  assert.equal(launched, 1, "one check, one worker call — the action does not loop");
  assert.equal(seen[0].SEMANTIC_SCHOLAR_API_KEY, KEY, "the stored key is handed to the worker that needs it, and to nothing else");
  assert.match(harness.events.messages.map((message) => message.text).join("\n"), /Semantic Scholar answered/, "and the operator is told the result in one sentence");
  const refused = makeHarness({ folders: foldersFor(root), initial: GOAL });
  const refusedPanel = refused.api.openControlPanel();
  await refusedPanel.receive({ type: "testIntegrationKey", provider: "semantic-scholar" });
  assert.match(refusedPanel.messages.at(-1).error, /No key is stored/, "with no key stored the action refuses with the reason, rather than running a check that proves nothing");
});

test("a rate-limited check says the Toolkit is rate limited and never sends the operator back to authorizing (INT-14.7)", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL, pickButton: "Activate without an API key", reportNote: KEY,
    diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt({ semanticScholar: { outcome: "rate-limited", code: "HTTP_429" } }), stderr: "" }) },
  });
  await run(harness, "researchToolkit.activateIntegration", "semantic-scholar");
  await run(harness, "researchToolkit.setIntegrationApiKey", "semantic-scholar");
  await run(harness, "researchToolkit.checkIntegrations");
  const view = viewOf(harness, "semantic-scholar");
  const shown = `${view.label} ${view.detail} ${view.nextAction}`;
  assert.equal(view.readiness, "degraded", "the pause is its own state");
  assert.match(view.label, /rate limited/i, "the card says plainly that the Toolkit is rate limited");
  assert.match(view.detail, /authorization and your stored key are unchanged/, "that the authorization and the key are untouched");
  assert.match(view.detail, /share one capacity with every other unauthenticated user/, "that the anonymous limit is a pool shared with everyone else, not the Toolkit's own allowance");
  assert.match(view.detail, /shares one request budget across Toolkit processes/, "that the worker now shares one budget across Toolkit processes");
  assert.match(view.detail, /bounded backoff/, "and what it does with that budget");
  assert.match(view.nextAction, /Nothing needs to be authorized again/, "the next step is not re-authorizing");
  assert.ok(!/authorize again|re-authoriz|activate again|sign ?up/i.test(shown), "nothing in the card suggests re-authorizing or registering");
  assert.ok(!view.detail.includes("pause of"), "with no pause carried by the check, none is promised");
  assert.equal(harness.secrets.get(integrationStore.secretKey("semantic-scholar")), KEY, "the stored key survives the pause untouched");
  assert.equal(record(harness, "semantic-scholar").authorization, "authorized", "and so does the authorization");
});

test("the re-check the operator asks for after an installation runs the real check, and nothing runs it beforehand (INT-13A.4, NF12-04)", async (t) => {
  const { root } = await workerWorkspace(t);
  let launched = 0;
  const services = { runProcess: async () => { launched += 1; return { exitCode: 0, stdout: receipt({ zotero: { outcome: "ready", code: "OK", installed: true, serverId: "Zotero 7" } }), stderr: "" }; } };
  const seeded = {
    schemaVersion: integrations.SCHEMA_VERSION, updatedAt: null, lastProbeAt: Date.now() - 60_000,
    providers: { zotero: { installation: "not-detected", authorization: "not-required", readiness: "unavailable", onboarding: "not-started", lastCheck: null, lastSuccessfulCheckAt: null } },
  };
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, initialGlobalState: { [integrationStore.REGISTRY_STATE_KEY]: seeded }, diagnosticServices: services });
  assert.ok(offers(viewOf(harness, "zotero"), "installedNow"), "the card carries the re-check the operator asks for once the installation is finished");
  assert.equal(launched, 0, "and opening the window ran nothing: no poll is waiting for an installation to appear");
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "checkIntegration", provider: "zotero" });
  assert.equal(launched, 1, "the check runs when the operator asks for it, once");
  const after = viewOf(harness, "zotero");
  assert.equal(after.installation, "detected", "and the re-detection changes the record, not the operator's claim about what they installed");
  assert.equal(after.readiness, "ready", "with the answer the local API actually gave");
  assert.ok(!offers(after, "guideInstall") && !offers(after, "installedNow"), "and both installation offers are gone the moment Zotero is found (T12-22)");
});

test("the new panel actions refuse a provider the Toolkit does not know, before they touch anything", async (t) => {
  const harness = makeHarness({ folders: foldersFor(await scratch(t)), initial: GOAL });
  const panel = harness.api.openControlPanel();
  for (const type of ["guideIntegrationInstall", "requestApiKey", "continueWithoutKey", "testIntegrationKey"]) {
    await panel.receive({ type, provider: "not-a-service" });
    assert.match(panel.messages.at(-1).error, /Unknown integration|no key|nothing to install|no key to request|Toolkit-stored key/, `${type} refuses an unknown service instead of acting on it`);
  }
  assert.equal(harness.events.external, undefined, "and no page was opened on the strength of a message body");
  assert.equal(harness.secrets.size, 0, "and no secret was touched");
  assert.deepEqual(harness.events.writtenFiles, [], "and no file was written");
});

// --- INT-15 (DD12-02): the machine-level installation fact through the real wiring -------------

// The worker's `integration-facts` answer, in the shape the contract fixes. `semantic_scholar` never appears
// in one: a hosted API has no installation on this machine.
const factsReceipt = (facts = { zotero: { found: true, classification: "ready", platform: "linux", detectedAtMs: Date.now(), code: "ZOTERO_READY" } }) =>
  JSON.stringify({ schemaVersion: 1, facts });
const factsServices = (facts, probe = () => receipt(), seen = []) => async (executable, args, options) => {
  seen.push({ executable, args, options });
  if (args.includes("integration-facts")) return { exitCode: 0, stdout: factsReceipt(facts), stderr: "" };
  return { exitCode: 0, stdout: probe(), stderr: "" };
};

test("opening the integrations flow reuses the machine installation fact, with no extra press (T12-33)", async (t) => {
  const { root } = await workerWorkspace(t);
  const calls = [];
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, quickPicks: ["Zotero", null], diagnosticServices: { runProcess: factsServices(undefined, undefined, calls) } });
  assert.equal(calls.length, 0, "activation reads the machine record no more than it probes: opening a window runs nothing");
  assert.equal(harness.globalState.get(integrationStore.REGISTRY_STATE_KEY), undefined, "the profile starts with no integration record at all");
  await run(harness, "researchToolkit.manageIntegrations");
  assert.equal(calls.length, 1, "opening the flow is the act that reads the machine record — once, not at activation, not on a timer, not twice for one opening");
  assert.deepEqual(calls[0].args, ["-I", "-B", "-X", "utf8", "-m", "research_stack.cli", "integration-facts"], "the facts verb runs in the locked worker with the same reviewed interpreter flags as the check, and no extra argument");
  assert.equal(calls[0].options.cwd, root, "in the selected workspace, the same place the research tools run");
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 5000, "the machine-record read is bounded by its own short bound (5 s at most): it is a local file read by the Toolkit's own worker, not a reach to two services");
  assert.ok(calls[0].options.timeout < integrationProbe.PROBE_TIMEOUT_MS, "and it is shorter than the probe's bound, so opening this flow cannot hold the operator's lock for the whole check and make \"Check now\" throw (J3)");
  assert.equal(harness.events.secrets.length, 0, "and the machine-fact path read no secret");
  assert.equal(record(harness, "zotero").installation, "detected", "the installation question is answered from the machine record instead of re-asked");
  assert.equal(record(harness, "zotero").installationSource, "machine-fact", "and the record says where the answer came from");
  const view = viewOf(harness, "zotero");
  assert.equal(view.installation, "detected", "the card says what the machine already knew");
  assert.match(view.installationProvenance, /Installation found by another window of the same OS user on linux\./, "the card names the other window, not a check");
  assert.match(view.installationProvenance, /This profile has not checked it\./, "and says plainly that this profile did not measure it");
  assert.ok(Number.isFinite(Date.parse(view.installationFactAt)), "and carries the moment the installation was detected");
  assert.equal(view.installationFactStale, false, "which is inside the Toolkit's freshness window");
  assert.match(view.label, /^Found on this machine — not checked in this profile$/, "the label carries the distinction, so a machine fact cannot read as this profile's verdict");
  assert.ok(!offers(view, "guideInstall") && !offers(view, "installedNow"), "so the card offers no installation to a profile the machine already answered");
  assert.ok(!labelsOffered(harness).some((label) => /installation/i.test(label)), "and the Quick Pick the operator is looking at offers none either — no re-asking in either surface");
  assert.ok(labelsOffered(harness).includes("What did this machine find?"), "the explicit re-read stays offered, because it is the only way to ask again on demand");
  assert.equal(harness.api.state().integrations.factsNote, null, "a record the Toolkit could use leaves no complaint behind");
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "ready" });
  const shown = panel.messages.filter((item) => item.type === "state").at(-1).integrations.views.find((item) => item.id === "zotero");
  assert.equal(shown.installation, "detected", "the panel the operator opens shows the reused fact, not a question");
  assert.match(shown.installationProvenance, /another window of the same OS user/, "with the provenance sentence on the card");
  await panel.receive({ type: "guideIntegrationInstall", provider: "zotero" });
  assert.match(lastMessage(harness).text, /found on this machine by another window of the same OS user/, "and if a stale panel still reaches the guided path, the refusal names whose fact it was");
  assert.match(lastMessage(harness).text, /This profile has not checked it/, "and says plainly that this profile did not verify it");
  assert.equal(harness.events.external, undefined, "and the refusal opened no download page");
});

test("the same machine fact inherits no consent, no access mode and no key (T12-34)", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: factsServices() } });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "readIntegrationFacts" });
  const entry = record(harness, "semantic-scholar");
  assert.equal(entry.authorization, "awaiting-consent", "a Zotero installation fact authorizes nothing for this profile");
  assert.equal(entry.license.acknowledged, false, "it records no consent");
  assert.equal(entry.credentials.configured, false, "it records no key");
  assert.equal(entry.mode, "anonymous", "it inherits no access mode");
  assert.equal(entry.onboarding, "not-started", "and it does not finish a guide this profile never went through");
  assert.equal(harness.secrets.size, 0, "no key exists, and none was created");
  assert.deepEqual(harness.events.secrets, [], "SecretStorage was never touched on the machine-fact path");
  const env = await injected(harness);
  assert.ok(!env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED && !("SEMANTIC_SCHOLAR_API_KEY" in env), "the research worker is handed nothing on the strength of a machine fact");
  const view = viewOf(harness, "semantic-scholar");
  assert.equal(view.consentRequired, true, "the operator still has to decide for this profile");
  assert.ok(offers(view, "requestKey") && offers(view, "noKey"), "and the key choices are offered exactly as in a profile that never read a machine record");
  assert.ok(!offers(view, "machineFact"), "Semantic Scholar is never offered a machine installation fact");
  assert.ok(!JSON.stringify(harness.api.state().integrations).includes("ZOTERO_READY"), "the worker's diagnostic code is not sprayed into the panel state");
});

test("a stale machine fact pre-fills the panel, and the check is still offered and still runs (T12-36)", async (t) => {
  const { root } = await workerWorkspace(t);
  const detectedAt = Date.now() - 8 * 86_400_000;
  let checks = 0;
  const services = {
    runProcess: async (executable, args, options) => {
      if (args.includes("integration-facts")) return { exitCode: 0, stdout: factsReceipt({ zotero: { found: true, classification: "ready", platform: "linux", detectedAtMs: detectedAt, code: "ZOTERO_READY" } }), stderr: "" };
      checks += 1;
      return { exitCode: 0, stdout: receipt({ zotero: { outcome: "ready", code: "OK", installed: true, serverId: "Zotero 7" } }), stderr: "" };
    },
  };
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: services });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "readIntegrationFacts" });
  const before = viewOf(harness, "zotero");
  assert.equal(before.installation, "detected", "the stale fact pre-fills the panel — DD12-02 says it may");
  assert.equal(before.installationFactStale, true, "and the model knows it is outside the freshness window");
  assert.match(before.installationProvenance, /older than the Toolkit's 7-day window, so it is a fact about the moment it was taken, not about now/, "the card says so in the operator's words");
  assert.equal(before.installationFactAt, new Date(detectedAt).toISOString(), "and names the moment it was detected, so the operator can judge it");
  assert.ok(offers(before, "check"), "the check is still offered");
  assert.equal(checks, 0, "and reading the fact ran no check");
  // M1: a confirmation older than the window re-opens the guided path, and the host must not then refuse the
  // button the card just offered. A refusal here would contradict the panel in the same screen.
  assert.ok(offers(before, "guideInstall") && offers(before, "installedNow"), "and the guided installation is offered again, because that confirmation is no longer current");
  await panel.receive({ type: "guideIntegrationInstall", provider: "zotero" });
  const guided = harness.events.messages.at(-1);
  assert.ok(guided.options && guided.options.modal === true, "pressing it opens the guide as a modal instead of refusing with an information message");
  assert.ok(guided.buttons.includes("Open the official download page"), "with the official page named as the first thing to do, which is the only thing the Toolkit can honestly point at");
  assert.match(guided.options.detail, /older than the Toolkit's 7-day window/, "and the guide says why it is being offered again to a machine that already reported an installation");
  assert.equal(harness.events.external, "https://www.zotero.org/download/", "and the only thing the Toolkit opens is the official page — it downloads nothing and runs nothing itself");
  await panel.receive({ type: "checkIntegration", provider: "zotero" });
  assert.equal(checks, 1, "the check still runs when the operator asks for it — a fact about a moment does not suppress it");
  const after = viewOf(harness, "zotero");
  assert.equal(after.installationSource, "profile-check", "and the record now says this profile checked it, not the machine");
  assert.equal(after.installationProvenance, "Installation recorded by a check this profile ran.", "in one sentence the card can show");
  assert.equal(after.readiness, "ready", "with the answer the local API actually gave");
  assert.equal(after.installationFactAt, null, "the stale machine time is not quoted beside a provenance that is not the machine's");
});

test("asking for the machine record twice duplicates nothing: no second fact, no second key, no second state key (T12-38)", async (t) => {
  const { root } = await workerWorkspace(t);
  const detectedAt = Date.now() - 3_600_000;
  const facts = { zotero: { found: true, classification: "ready", platform: "linux", detectedAtMs: detectedAt, code: "ZOTERO_READY" } };
  let reads = 0;
  const services = { runProcess: async (executable, args) => { if (args.includes("integration-facts")) { reads += 1; return { exitCode: 0, stdout: factsReceipt(facts), stderr: "" }; } return { exitCode: 0, stdout: receipt(), stderr: "" }; } };
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: services });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "readIntegrationFacts" });
  const first = JSON.parse(JSON.stringify(harness.globalState.get(integrationStore.REGISTRY_STATE_KEY)));
  await panel.receive({ type: "readIntegrationFacts" });
  const second = JSON.parse(JSON.stringify(harness.globalState.get(integrationStore.REGISTRY_STATE_KEY)));
  assert.equal(reads, 2, "the worker was asked twice, because the operator asked twice — nothing is polled or cached across a window it did not open");
  assert.equal(second.providers.zotero.installation, "detected", "and the installation it produced is the same one");
  assert.equal(second.providers.zotero.installationFactAt, first.providers.zotero.installationFactAt, "the same fact is recorded once, not appended to");
  assert.deepEqual(Object.keys(second.providers.zotero).sort(), Object.keys(first.providers.zotero).sort(), "no new field appears on the second run");
  assert.deepEqual([...harness.globalState.keys()], [integrationStore.REGISTRY_STATE_KEY], "no second state key was created");
  assert.equal(harness.secrets.size, 0, "no key was created");
  assert.deepEqual(harness.events.secrets, [], "and no secret was read");
  assert.deepEqual(harness.events.writtenFiles, [], "and no file was written by the machine-fact path");
  const view = viewOf(harness, "zotero");
  assert.equal(view.actions.filter(([id]) => id === "machineFact").length, 1, "the offer is not duplicated either");
  assert.equal(view.actions.filter(([id]) => id === "check").length, 1, "nor any other action");
});

test("a machine record this release cannot read is refused with the reason, and changes nothing", async (t) => {
  const { root } = await workerWorkspace(t);
  const now = Date.now();
  const refused = [
    ["an unknown classification", JSON.stringify({ schemaVersion: 1, facts: { zotero: { found: true, classification: "sideways", platform: "linux", detectedAtMs: now, code: null } } }), /sideways.*not an installation answer this release can read/],
    ["a fact naming Semantic Scholar", JSON.stringify({ schemaVersion: 1, facts: { semantic_scholar: { found: true, classification: "ready", platform: "linux", detectedAtMs: now, code: null } } }), /hosted service with nothing on this machine to install/],
    ["a fact with no detection time", JSON.stringify({ schemaVersion: 1, facts: { zotero: { found: true, classification: "ready", platform: "linux" } } }), /does not carry the moment it was taken/],
    ["a fact whose found contradicts its classification", JSON.stringify({ schemaVersion: 1, facts: { zotero: { found: false, classification: "ready", platform: "linux", detectedAtMs: now } } }), /does not say whether Zotero was found|contradict/],
    ["a record from another format", JSON.stringify({ schemaVersion: 2, facts: { zotero: { found: true, classification: "ready", platform: "linux", detectedAtMs: now } } }), /format 2, which this release cannot read/],
    ["a record over the size cap", JSON.stringify({ schemaVersion: 1, facts: { zotero: { found: true, classification: "ready", platform: "linux", detectedAtMs: now, code: "ZOTERO_READY" } }, padding: "x".repeat(9000) }), /it is \d+ characters, over the 8192 the Toolkit will read/],
    ["a diagnostic code longer than the host will read", JSON.stringify({ schemaVersion: 1, facts: { zotero: { found: true, classification: "ready", platform: "linux", detectedAtMs: now, code: "x".repeat(5000) } } }), /diagnostic code is not a short piece of text/],
    ["not JSON at all", "the worker printed a sentence", /came back unreadable/],
  ];
  for (const [what, stdout, reason] of refused) {
    const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout, stderr: "" }) } });
    const panel = harness.api.openControlPanel();
    await panel.receive({ type: "readIntegrationFacts" });
    assert.match(panel.messages.at(-1).error, /machine installation record/, `${what}: refused as a refusal the operator can read`);
    assert.match(panel.messages.at(-1).error, reason, `${what}: and the refusal names the actual defect`);
    assert.match(panel.messages.at(-1).error, /Nothing was changed\./, `${what}: and says plainly that nothing was changed`);
    assert.equal(harness.globalState.get(integrationStore.REGISTRY_STATE_KEY), undefined, `${what}: nothing was written to the profile`);
    assert.equal(viewOf(harness, "zotero").installation, "unknown", `${what}: the installation dimension keeps the value it had`);
    assert.equal(harness.secrets.size, 0, `${what}: and no secret was touched`);
  }
  const failed = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async () => ({ exitCode: 2, stdout: "", stderr: "error: no such command 'integration-facts'" }) } });
  const failedPanel = failed.api.openControlPanel();
  await failedPanel.receive({ type: "readIntegrationFacts" });
  assert.match(failedPanel.messages.at(-1).error, /could not read the machine installation record.*integration-facts/, "a worker that does not know the verb is named as a failed read, not as a machine with no Zotero");
  assert.equal(failed.globalState.get(integrationStore.REGISTRY_STATE_KEY), undefined, "and it writes nothing");
});

test("the machine-fact call carries no credential-shaped name, even one this editor process already had", async (t) => {
  const { root } = await workerWorkspace(t);
  const seen = [];
  process.env.SEMANTIC_SCHOLAR_API_KEY = KEY;
  process.env.CROSSREF_MAILTO = "anna@example.org";
  try {
    const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async (executable, args, options) => { seen.push(options.env); return { exitCode: 0, stdout: factsReceipt(), stderr: "" }; } } });
    const panel = harness.api.openControlPanel();
    await panel.receive({ type: "readIntegrationFacts" });
    assert.equal(harness.globalState.get(integrationStore.REGISTRY_STATE_KEY).providers.zotero.installation, "detected", "the read still worked");
    assert.ok(!("SEMANTIC_SCHOLAR_API_KEY" in seen[0]), "the key name was removed from the environment the call was built with, even though this process carried one");
    assert.ok(!("CROSSREF_MAILTO" in seen[0]), "and the same for every other name the Toolkit knows is credential-shaped");
    assert.ok(seen[0].PATH, "the call is still a normal worker call: it is scrubbed, not emptied");
    assert.equal(harness.secrets.size, 0, "nothing was written to SecretStorage");
    assert.deepEqual(harness.events.secrets, [], "and nothing was read from it");
    assert.ok(!JSON.stringify(harness.api.state()).includes(KEY), "the key is nowhere in the state the panel renders");
    assert.ok(!JSON.stringify(harness.panels.map((item) => item.messages)).includes(KEY), "nor in any panel message");
  } finally {
    delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    delete process.env.CROSSREF_MAILTO;
  }
});

test("nothing reads the machine record at activation, and the read is a panel message and a flow opening, not a 39th command", async (t) => {
  const { root } = await workerWorkspace(t);
  const seen = [];
  const services = { runProcess: async (executable, args) => { seen.push(args); return { exitCode: 0, stdout: args.includes("integration-facts") ? factsReceipt() : receipt(), stderr: "" }; } };
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: services });
  assert.equal(seen.length, 0, "opening a window ran no worker call at all");
  assert.ok(!seen.some((args) => args.includes("integration-facts")), "and no machine-fact read happened at activation");
  assert.equal(harness.events.secrets.length, 0, "and no secret was read");
  assert.equal(harness.registered.size, 39, "the machine-fact path added no command: the count the payload check asserts is unchanged since 0.3.13 added the Zotero write-key command");
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "readIntegrationFacts" });
  assert.equal(seen.length, 1, "the worker is asked only when the operator asks");
  assert.deepEqual(seen[0], ["-I", "-B", "-X", "utf8", "-m", "research_stack.cli", "integration-facts"], "and it is asked for the facts verb, not for a probe");
  assert.equal(harness.registered.size, 39, "and the command count is still 39 after the read");
  const picker = makeHarness({ folders: foldersFor(root), initial: GOAL, quickPicks: ["Zotero", "What did this machine find?"], diagnosticServices: services });
  const before = seen.length;
  await run(picker, "researchToolkit.manageIntegrations");
  const added = seen.slice(before);
  assert.equal(added.length, 2, "opening the Integrations & Accounts flow read the machine record once, and the operator's explicit press read it once more: two reads, both asked for, neither scheduled");
  assert.ok(added.every((args) => args.includes("integration-facts")), "both are the facts verb — the flow launched no probe, no download and no other worker call");
  assert.equal(picker.globalState.get(integrationStore.REGISTRY_STATE_KEY).providers.zotero.installation, "detected", "with the same effect on the record");
});

test("a machine record that holds no fact yet is stated as holding no fact, and writes nothing", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async (executable, args) => ({ exitCode: 0, stdout: args.includes("integration-facts") ? factsReceipt({}) : receipt(), stderr: "" }) } });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "readIntegrationFacts" });
  assert.match(panel.messages.at(-1).message, /holds no installation fact for this machine yet/, "an empty machine record is an honest answer, not a failure and not a verdict about the operator's machine");
  assert.equal(panel.messages.at(-1).error, undefined, "so it is not reported as an error");
  assert.equal(harness.globalState.get(integrationStore.REGISTRY_STATE_KEY), undefined, "and it writes nothing to the profile");
  assert.equal(viewOf(harness, "zotero").installation, "unknown", "the installation stays unknown: an absent fact is not evidence of absence");
});

test("a machine fact older than this profile's own check does not overrule that check", async (t) => {
  const { root } = await workerWorkspace(t);
  const detectedAt = Date.now() - 2 * 86_400_000;
  const services = {
    runProcess: async (executable, args) => ({
      exitCode: 0, stderr: "",
      stdout: args.includes("integration-facts")
        ? factsReceipt({ zotero: { found: true, classification: "ready", platform: "linux", detectedAtMs: detectedAt, code: "ZOTERO_READY" } })
        : JSON.stringify({ zotero: { outcome: "not-installed", code: "ZOTERO_NOT_AVAILABLE", installed: false }, semanticScholar: { outcome: "auth-required", code: "PROVIDER_TERMS_NOT_ACKNOWLEDGED" } }),
    }),
  };
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: services });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "checkIntegration", provider: "zotero" });
  assert.equal(viewOf(harness, "zotero").installation, "not-detected", "this profile checked and found nothing");
  await panel.receive({ type: "readIntegrationFacts" });
  const view = viewOf(harness, "zotero");
  assert.equal(view.installation, "not-detected", "a machine fact from two days ago does not overrule a check this profile just ran");
  assert.equal(view.installationSource, "profile-check", "and the record still says whose evidence it is");
  assert.match(panel.messages.at(-1).message, /This profile's own check is more recent than the machine record, so the check stands\./, "and the operator is told which of the two the record kept");
  assert.ok(offers(view, "guideInstall"), "the guided offer follows the check this profile ran, not the older machine fact");
});

test("with no machine record to reuse, opening the integrations flow behaves exactly as it did before INT-15", async (t) => {
  const { root } = await workerWorkspace(t);
  const calls = [];
  const services = { runProcess: async (executable, args) => { calls.push(args); return { exitCode: 0, stdout: args.includes("integration-facts") ? JSON.stringify({ schemaVersion: 1, facts: {} }) : receipt(), stderr: "" }; } };
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, quickPicks: ["Zotero", null], diagnosticServices: services });
  await run(harness, "researchToolkit.manageIntegrations");
  assert.equal(calls.length, 1, "one read was attempted, and it found nothing to reuse");
  const view = viewOf(harness, "zotero");
  assert.equal(view.installation, "unknown", "nothing was invented: an absent machine record is not evidence of absence");
  assert.equal(view.installationSource, null, "and no provenance is claimed");
  assert.equal(view.installationProvenance, null, "the card says nothing about another window, because no window reported anything");
  assert.equal(harness.globalState.get(integrationStore.REGISTRY_STATE_KEY), undefined, "and the profile record is still unwritten, exactly as before");
  assert.deepEqual(view.actions.map(([id]) => id), ["check", "activate", "machineFact", "reset"], "the offers are the ones a fresh profile has always been given, plus the explicit re-read");
  assert.equal(harness.api.state().integrations.factsNote, null, "and an honest empty record leaves no complaint in the panel");
});

test("a machine record the Toolkit could not read is said in the panel and in the row it concerns, and the flow still works", async (t) => {
  const root = await scratch(t);
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, quickPicks: ["Zotero", null] });
  await run(harness, "researchToolkit.manageIntegrations");
  const note = harness.api.state().integrations.factsNote;
  assert.match(note, /Set up package components before reading the machine installation record/, "the reason is stated, not swallowed");
  const row = harness.events.quickPicks[0].items.find((item) => item.id === "zotero");
  assert.match(row.detail, /Set up package components before reading the machine installation record/, "and it is in front of the operator in the flow they just opened");
  const view = viewOf(harness, "zotero");
  assert.equal(view.installation, "unknown", "nothing was invented about the operator's machine");
  assert.ok(offers(view, "check") && offers(view, "activate"), "and a failed read does not lock the flow: the integration choices are still offered");
  assert.equal(harness.globalState.get(integrationStore.REGISTRY_STATE_KEY), undefined, "and nothing was written");
  assert.deepEqual(harness.events.writtenFiles, [], "not even a file");
});

test("the reader accepts a record at the writer's own size bound and refuses one past it", async (t) => {
  const { root } = await workerWorkspace(t);
  const now = Date.now();
  const pad = (length) => JSON.stringify({ schemaVersion: 1, facts: { zotero: { found: true, classification: "ready", platform: "linux", detectedAtMs: now, code: "ZOTERO_READY" } }, padding: "x".repeat(length) });
  assert.ok(pad(7000).length <= 8192 && pad(9000).length > 8192, "the two cases straddle the writer's MAX_FACTS_BYTES = 8 192 (machinefacts.py), which the reader matches rather than undercutting");
  const inside = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async (executable, args) => ({ exitCode: 0, stdout: args.includes("integration-facts") ? pad(7000) : receipt(), stderr: "" }) } });
  await inside.api.openControlPanel().receive({ type: "readIntegrationFacts" });
  assert.equal(viewOf(inside, "zotero").installation, "detected", "a record the Toolkit itself could have written is read, not refused for its size");
  const outside = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async (executable, args) => ({ exitCode: 0, stdout: args.includes("integration-facts") ? pad(9000) : receipt(), stderr: "" }) } });
  const panel = outside.api.openControlPanel();
  await panel.receive({ type: "readIntegrationFacts" });
  assert.match(panel.messages.at(-1).error, /over the 8192 the Toolkit will read/, "one past the bound is refused whole, with the number named");
  assert.equal(outside.globalState.get(integrationStore.REGISTRY_STATE_KEY), undefined, "and the refusal writes nothing");
});

// --- the reported defects: the press, the lock, the bound, the capability, the guided path ----------
// Each of these is a thing a real operator hit: a button that answered "Done.", a second press that
// started a second worker, a flow opening that held the lock for 20 s, a check offered where no check
// can run, and a guided modal that named a button the card never shows.

/** Let the host's own async work reach its worker call before pressing again. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(condition, tries = 200) {
  for (let i = 0; i < tries && !condition(); i += 1) await settled();
  return condition();
}

/** A worker call that stays open until the test releases it, so the lock is visibly held. */
function heldWorker(reply = () => receipt()) {
  const held = { launched: 0, facts: 0, release: null };
  held.gate = new Promise((resolve) => { held.release = resolve; });
  held.runProcess = async (executable, args) => {
    held.launched += 1;
    if (args.includes("integration-facts")) { held.facts += 1; return { exitCode: 0, stdout: factsReceipt(), stderr: "" }; }
    await held.gate;
    return { exitCode: 0, stdout: reply(), stderr: "" };
  };
  return held;
}

const lastResult = (panel) => panel.messages.filter((item) => item.type === "result").at(-1);

test("pressing Check now answers the panel with the verdict the check produced, not with \"Done.\" (J1)", async (t) => {
  const { root } = await workerWorkspace(t);
  const answering = makeHarness({
    folders: foldersFor(root), initial: GOAL,
    diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt({ zotero: { outcome: "ready", code: "OK", installed: true, serverId: "Zotero 7" } }), stderr: "" }) },
  });
  const panel = answering.api.openControlPanel();
  await panel.receive({ type: "checkIntegration", provider: "zotero", requestId: 41 });
  const answer = lastResult(panel);
  assert.equal(answer.requestId, 41, "the verdict is matched to the press that asked for it");
  assert.equal(answer.error, undefined, "the check ran, so the panel is not shown an error");
  assert.notEqual(answer.message, "Done.", "the panel is not left with a word that says nothing about the service");
  assert.match(answer.message, /^Zotero — Ready: The last check reached the service\.$/, "the sentence names the service and the state the check found, in the card's own words");

  const missing = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt(), stderr: "" }) } });
  const missingPanel = missing.api.openControlPanel();
  await missingPanel.receive({ type: "checkIntegration", provider: "zotero", requestId: 42 });
  const verdict = lastResult(missingPanel);
  assert.match(verdict.message, /^Zotero — Not installed: No Zotero was found on this machine\./, "a check that found nothing says so back to the button that asked for it");
  assert.ok(!/Done\./.test(verdict.message), "and the operator is never told \"Done.\" about a service the check could not find");

  const both = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt(), stderr: "" }) } });
  await run(both, "researchToolkit.checkIntegrations");
  const shown = both.output.lines.at(-1);
  assert.match(shown, /Zotero — Not installed:/, "the Output channel keeps the same sentences the panel was given");
  assert.match(shown, /Semantic Scholar — Requires your confirmation:/, "for both services, in the order the operator reads them");
});

test("a second check while one is running is refused with the reason, instead of starting a second worker (J2)", async (t) => {
  const { root } = await workerWorkspace(t);
  const held = heldWorker();
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL, quickPicks: ["Zotero", "Check now"], pickButton: "Start checking Zotero",
    diagnosticServices: { runProcess: held.runProcess },
  });
  const running = run(harness, "researchToolkit.checkIntegrations");
  try {
    assert.ok(await until(() => held.launched >= 1), "the first check reached its worker call");
    assert.equal(harness.api.state().busy, true, "and the panel is told a check is running, so its buttons are not live mid-check");
    const panel = harness.api.openControlPanel();
    await panel.receive({ type: "checkIntegration", provider: "zotero" });
    assert.match(lastResult(panel).error, /already running\. Wait for it to finish\./, "the card's Check now is refused with the reason, not queued behind the first check");
    await assert.rejects(() => run(harness, "researchToolkit.activateIntegration", "zotero"), /already running/, "so is the guided \"Start checking Zotero\" press");
    await assert.rejects(() => run(harness, "researchToolkit.manageIntegrations"), /already running/, "and so is the Quick Pick's \"Check now\"");
    assert.equal(held.launched, 1, "none of the three presses started a second worker, and none spent the shared check budget");
  } finally {
    held.release();
    await running;
  }
  assert.equal(held.launched, 1, "the one check that was allowed ran exactly once");
  assert.equal(harness.api.state().busy, false, "and the lock is released when it finishes");
});

test("opening the integrations flow reads the machine record on its own short bound, not the probe's 20 s (J3)", async (t) => {
  const { root } = await workerWorkspace(t);
  const calls = [];
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, quickPicks: ["Zotero", null], diagnosticServices: { runProcess: factsServices(undefined, undefined, calls) } });
  await run(harness, "researchToolkit.manageIntegrations");
  assert.equal(calls.length, 1, "opening the flow still consults the machine record once — the deliberate read survives the fix");
  assert.deepEqual(calls[0].args, ["-I", "-B", "-X", "utf8", "-m", "research_stack.cli", "integration-facts"], "and it is still the facts verb and nothing else");
  assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 5000, "the read is bounded by its own short bound (5 s at most): it is a local file read by the Toolkit's own worker, not a reach to two services");
  assert.ok(calls[0].options.timeout < integrationProbe.PROBE_TIMEOUT_MS, "and it is shorter than the probe's bound, so opening this flow cannot hold the operator's lock for the whole check");
});

test("opening the integrations flow while a check is running skips the machine-record read and says why (J3)", async (t) => {
  const { root } = await workerWorkspace(t);
  const held = heldWorker();
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, quickPicks: ["Zotero", null], diagnosticServices: { runProcess: held.runProcess } });
  const running = run(harness, "researchToolkit.checkIntegrations");
  try {
    assert.ok(await until(() => held.launched >= 1), "a check is running when the operator opens the integrations flow");
    await run(harness, "researchToolkit.manageIntegrations");
    assert.equal(held.facts, 0, "no machine-record read was launched while the check held the lock, and none was queued behind it");
    const note = harness.api.state().integrations.factsNote;
    assert.match(note, /A setup or a check is already running, so this opening did not read the machine installation record/, "the reason is said in the panel instead of the read being attempted anyway");
    assert.match(note, /Press "What did this machine find\?" once it finishes\./, "and the operator is told how to get it afterwards");
    const row = harness.events.quickPicks[0].items.find((item) => item.id === "zotero");
    assert.match(row.detail, /did not read the machine installation record/, "and it is in front of the operator in the flow they just opened");
    assert.equal(held.launched, 1, "opening the flow added no worker call of any kind");
  } finally {
    held.release();
    await running;
  }
  assert.equal(held.facts, 0, "and the skipped read stayed skipped");
});

test("the host states whether a check could run here at all, so a workspace with no worker is not offered one (J4)", async (t) => {
  const noWorker = makeHarness({ folders: foldersFor(await scratch(t)), initial: GOAL });
  await assert.rejects(() => run(noWorker, "researchToolkit.checkIntegrations"),
    /Set up package components before checking integrations/, "the actionable error is kept for a press that does get through");
  assert.equal(noWorker.api.state().integrations.canProbe, false, "and the host has already told the model that no check can run in this workspace");

  const { root } = await workerWorkspace(t);
  const services = { runProcess: async () => ({ exitCode: 0, stdout: receipt(), stderr: "" }) };
  const withWorker = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: services });
  await run(withWorker, "researchToolkit.checkIntegrations");
  assert.equal(withWorker.api.state().integrations.canProbe, true, "in a workspace that has the locked worker the host says a check can run");

  const untrusted = makeHarness({ folders: foldersFor(root), initial: GOAL, trusted: false, diagnosticServices: services });
  await assert.rejects(() => run(untrusted, "researchToolkit.checkIntegrations"), /trusted local workspace/);
  assert.equal(untrusted.api.state().integrations.canProbe, false, "an untrusted workspace gets no check, whatever files it has on disk");
});

test("the host passes its probe capability into the state model, as the contract fixes it (J4)", async (t) => {
  const { root } = await workerWorkspace(t);
  const seen = [];
  const real = integrations.integrationViews;
  integrations.integrationViews = (registry, options) => { seen.push(options); return real(registry, options); };
  t.after(() => { integrations.integrationViews = real; });
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt(), stderr: "" }) } });
  await run(harness, "researchToolkit.checkIntegrations");
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "ready" });
  assert.ok(seen.some((options) => options.canProbe === true), "the model is asked for its views with `canProbe: true` in a workspace that has the locked worker");
  const state = panel.messages.filter((item) => item.type === "state").at(-1);
  assert.equal(state.integrations.canProbe, true, "and the panel state carries the same answer the model was given");
  assert.ok(Number.isFinite(state.integrations.cooldownMs) && state.integrations.cooldownMs > 0, "the cooldown budget is still handed to the panel beside it");
  assert.ok(Number.isFinite(state.integrations.lastProbeAt), "and so is the instant of the last check, which is what a wait is measured from");
});

test("the guided key request names the step that actually exists: activate first, then \"I already have a key\" (J5)", async (t) => {
  const { root } = await workerWorkspace(t);
  const harness = makeHarness({ folders: foldersFor(root), initial: GOAL, pickButton: "Open the official application page" });
  const panel = harness.api.openControlPanel();
  await panel.receive({ type: "requestApiKey", provider: "semantic-scholar" });
  const detail = lastMessage(harness).options.detail;
  assert.match(detail, /Activate the integration first/, "the modal names the activation step, because it is the step that makes a key storable at all");
  assert.match(detail, /you must accept the provider's terms before the Toolkit will store or use a key/, "and says why the order is what it is");
  assert.ok(detail.indexOf("Activate the integration first") < detail.indexOf("\"I already have a key\""), "the key box comes after activation, not before it");
  assert.match(detail, /emails the key to you/, "every existing promise is kept: how the key arrives");
  assert.match(detail, /never receives, stores or sees that email/, "that the Toolkit is not in that path");
  assert.match(detail, /never asks for a key in a chat, a workspace file or a log/, "and never asks for one anywhere else");
  assert.match(detail, /secret storage for this VS Code profile only/, "and where the key lives once pasted");
  assert.match(detail, /never in a workspace file, a setting, a log or a problem report/, "and where it does not");
  assert.match(detail, /one request per second across all endpoints/, "and what a key buys");
  assert.equal(harness.secrets.size, 0, "the modal stored nothing and asked for nothing");

  const guided = makeHarness({ folders: foldersFor(root), initial: GOAL, pickButton: "Activate without an API key", reportNote: KEY });
  assert.ok(!offers(viewOf(guided, "semantic-scholar"), "provideKey"), "before activating, the card offers no key box — which is exactly why the modal says activate first");
  await run(guided, "researchToolkit.activateIntegration", "semantic-scholar");
  assert.ok(offers(viewOf(guided, "semantic-scholar"), "provideKey"), "after activating, the button the modal named is on the card");
  await run(guided, "researchToolkit.setIntegrationApiKey", "semantic-scholar");
  assert.equal(guided.secrets.get(integrationStore.secretKey("semantic-scholar")), KEY, "and the key lands where the modal said it would");
  const unactivated = makeHarness({ folders: foldersFor(root), initial: GOAL, reportNote: KEY });
  await assert.rejects(() => run(unactivated, "researchToolkit.setIntegrationApiKey", "semantic-scholar"),
    /Activate the integration before adding a key/, "the refusal the modal describes is still the refusal the host gives");
});

test("the Output channel carries a failure sentence only when the check did not answer (J6)", async (t) => {
  const { root } = await workerWorkspace(t);
  const ready = makeHarness({
    folders: foldersFor(root), initial: GOAL,
    diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt({ zotero: { outcome: "ready", code: "OK", installed: true, serverId: "Zotero 7" }, semanticScholar: { outcome: "ready", code: "OK" } }), stderr: "" }) },
  });
  await run(ready, "researchToolkit.checkIntegrations");
  const shown = ready.output.lines.at(-1);
  assert.match(shown, /Zotero — Ready: The last check reached the service\./, "the verdict sentence is there");
  assert.ok(!/Zotero answered\.|Semantic Scholar answered\./.test(shown), "and no failure sentence is printed beside a check that answered — the old filter never fired, so both were");

  const refused = makeHarness({
    folders: foldersFor(root), initial: GOAL,
    diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt({ zotero: { outcome: "api-disabled", code: "ZOTERO_API_DISABLED", installed: true } }), stderr: "" }) },
  });
  await run(refused, "researchToolkit.checkIntegrations");
  const bad = refused.output.lines.at(-1);
  const sentence = integrationProbe.describeProbeFailure("zotero", { outcome: "api-disabled", code: "ZOTERO_API_DISABLED", detail: null, retryAfter: null, installed: true, serverId: null, evidence: null });
  assert.ok(sentence, "the probe has a failure sentence for a refusing Zotero");
  assert.match(bad, /Zotero — Installed — Zotero is refusing local access/, "the verdict sentence names what the check found");
  assert.ok(bad.includes(sentence), "and the probe's own sentence is printed under it, where the operator reads it");
});

test("a refused re-check names the seconds that remain and what to do next (J7)", async (t) => {
  const { root } = await workerWorkspace(t);
  const seeded = {
    schemaVersion: integrations.SCHEMA_VERSION, updatedAt: null, lastProbeAt: Date.now() - 1_000,
    providers: { zotero: { installation: "detected", authorization: "not-required", readiness: "ready", onboarding: "not-started", lastCheck: null, lastSuccessfulCheckAt: null } },
  };
  const harness = makeHarness({
    folders: foldersFor(root), initial: GOAL, initialGlobalState: { [integrationStore.REGISTRY_STATE_KEY]: seeded },
    diagnosticServices: { runProcess: async () => ({ exitCode: 0, stdout: receipt({ zotero: { outcome: "ready", code: "OK", installed: true, serverId: "Zotero 7" } }), stderr: "" }) },
  });
  const remaining = Math.ceil((integrationProbe.PROBE_COOLDOWN_MS - 1_000) / 1000);
  await assert.rejects(() => run(harness, "researchToolkit.checkIntegrations"), (error) => {
    assert.match(error.message, new RegExp(`allowed in ${remaining} s`), "the refusal names the wait that remains, in seconds, whatever the shared budget is set to");
    assert.match(error.message, /press Check now again/, "and says what the operator does next, instead of leaving the press hanging");
    assert.match(error.message, /share one check budget/, "and why several windows cannot all probe");
    assert.match(error.message, /the last verdict is still on the card/, "and says that nothing they did was lost");
    assert.ok(!/is \d+ s old/.test(error.message), "it is not the age of the last check, which is a different number from the wait");
    return true;
  }, "the guided re-check refusal is actionable at the moment it is read");
});
