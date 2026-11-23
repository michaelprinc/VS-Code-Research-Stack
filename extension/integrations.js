"use strict";

/**
 * Integration state model for Zotero and Semantic Scholar (0.3.11): installation ("is the thing there"),
 * authorization ("has the operator agreed"), readiness ("does it answer right now") and onboarding ("has this
 * profile been through the guide") are kept apart because one `isReady` flag would make "installed but switched off"
 * and "never installed" say the same thing (DD11-03). No file, editor object, process, network transport
 * or clock; every
 * function is pure and returns a NEW record. It will not invent consent (DD11-05), delete a record on revoke
 * (DD11-11), or treat a 429 as a lost account. The operator wording lives here too. INT-15 adds one rule with a
 * test on it (DD12-02): a machine-level installation fact may move `installation` and nothing else, it carries
 * the moment it was taken, and the record says which of the two it came from — a check this profile ran, or
 * another window of the same OS user.
 */

const SCHEMA_VERSION = 1;
const PROVIDERS = Object.freeze(["zotero", "semantic-scholar"]);
const DIMENSIONS = Object.freeze({
  installation: ["not-detected", "detected", "not-applicable", "unknown"],
  authorization: ["not-required", "awaiting-consent", "authorized", "revoked"],
  readiness: ["unchecked", "ready", "unavailable", "degraded"],
  onboarding: ["not-started", "in-progress", "completed", "skipped"],
});
const LICENSE_REFERENCE = "s2-api-license-2026-11";
// Two official texts govern this provider and they do not say the same thing — see
// specs/phase-12-integration-resilience/documentation-review.md §A3. 0.3.11 named only the Dataset License
// Agreement, but the form an operator would fill in to get a key requires agreement to the API Licence.
// Offering one text while the operator would have agreed to the other is not a faithful consent record, so
// both are named and neither is presented as the whole picture.
const LICENSE_URL = "https://api.semanticscholar.org/license/"; // Dataset License Agreement
const API_LICENSE_URL = "https://www.semanticscholar.org/product/api/license"; // API Licence, last updated 17 May 2023
const MODES = ["anonymous", "api-key"];
// 0.3.15 (TASK P-3): the worker reports a practical state, not only an HTTP outcome, and the card says what
// that state means for this operator. `consent-stored-not-injected` is the 21 November 2026 confusion — the
// operator had confirmed both agreements, a check ran in a process that was not given the confirmation, and
// the receipt read as a missing confirmation. `consented-but-unusable` is 22 November: authorised, anonymous,
// no key, a 429 and no check that ever reached the service, which a bare "rate limited" hides.
const ACCESS_STATES = ["usable", "rate-limited", "awaiting-consent", "consent-stored-not-injected",
                       "consented-but-unusable", "unchecked"];
// Why the anonymous pool is what it is, in the operator's own recorded decision. Naming the decision is what
// makes the sentence actionable; "rate limited" is not a next step.
const KEY_CLAUSES = {
  declined: "your record shows you chose to continue without a key",
  removed: "the key this profile had was removed",
  provided: "a key is recorded for this profile, and this check asked anonymously",
  guided: "the way to a key was shown here and none was taken",
  "not-offered": "no key has been offered in this profile yet",
};
const NAMES = { zotero: "Zotero", "semantic-scholar": "Semantic Scholar" };
// The official Zotero download page — the one `guides/zotero-local-api.md` names, kept in one place so the card,
// the guide action and the wording cannot drift to three different addresses.
const ZOTERO_DOWNLOAD_URL = "https://www.zotero.org/download/";
// The Zotero setting, in the exact wording `guides/zotero-local-api.md` already uses (confirmed against
// zotero.org/support/dev/web_api/v3/local_api, 8 November 2026). This is the only line a later review corrects.
const ZOTERO_LOCAL_API_SETTING = "Settings → Advanced → \"Allow other applications on this computer to communicate with Zotero\"";
// The provider's own key application form, confirmed against semanticscholar.org/product/api, 8 November 2026.
// The Toolkit opens it; it never fills it in and never sees the email the key arrives in.
const API_KEY_APPLICATION_URL = "https://www.semanticscholar.org/product/api#api-key-form";
// What the operator decided about a key, kept apart from whether a key exists: asking how to get one is not
// having one, and declining one is not getting one.
const KEY_DECISIONS = ["not-offered", "guided", "provided", "declined", "removed"];
// INT-15 (DD12-02): a machine-level installation fact is evidence about a moment, recorded by the Toolkit's own
// worker outside this profile. `MACHINE_FACT_MAX_AGE_MS` is the Toolkit's own choice, not a provider's and not
// the editor's — no provider is involved, and VS Code states no lifetime for an installation. Installing or
// removing an application is an act a person does, so the window is a week: longer than a working week plus the
// weekend after it, which is the span in which "I installed Zotero last week" is still a true answer. Past that
// the fact still pre-fills the panel, but the card says when it was taken and the check is still offered,
// because a fact about last month is not a fact about now.
const MACHINE_FACT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MACHINE_FACT_DAYS = MACHINE_FACT_MAX_AGE_MS / 86_400_000;
// What the worker's machine record may say about an installation, and what each answer means for the
// installation dimension. `unknown` names no installation state, so it sets none: DD12-02 forbids the guess.
const FACT_CLASSIFICATIONS = Object.freeze(["ready", "api-disabled", "not-running", "not-installed", "unknown"]);
const FACT_INSTALLATION = { ready: "detected", "api-disabled": "detected", "not-running": "detected", "not-installed": "not-detected" };
// Whether `found` and the classification agree. A record that says "not-installed" and found=true is damaged,
// and reading it either way would be a guess about the operator's machine.
const FACT_FOUND = { ready: true, "api-disabled": true, "not-running": true, "not-installed": false };
// Where the installation dimension got its value, stored with it, so the card can tell "this profile checked
// it" apart from "another window of the same OS user found this" (INT-15.4).
const INSTALLATION_SOURCES = Object.freeze(["profile-check", "machine-fact"]);
// The model is told only that a check cannot run, not which requirement failed.
const PROBE_BLOCKED_SENTENCE = "The check runs in the Toolkit's locked worker in a trusted local workspace folder, and this workspace does not provide one.";
const DEFAULTS = {
  zotero: { installation: "unknown", authorization: "not-required", readiness: "unchecked", onboarding: "not-started", lastCheck: null, lastSuccessfulCheckAt: null },
  "semantic-scholar": { installation: "not-applicable", authorization: "awaiting-consent", readiness: "unchecked", onboarding: "not-started", mode: "anonymous", license: { acknowledged: false, reference: null, acknowledgedAt: null }, credentials: { storage: "vscode-secret-storage", configured: false }, keyDecision: "not-offered", lastCheck: null, lastSuccessfulCheckAt: null },
};
const emptyRegistry = () => ({ schemaVersion: SCHEMA_VERSION, updatedAt: null, lastProbeAt: null, providers: structuredClone(DEFAULTS) });

/** Never throws: what this release cannot understand is replaced by defaults, and each replacement is named in `notes`. */
function readRegistry(stored) {
  const registry = emptyRegistry();
  const notes = [];
  if (stored === undefined || stored === null || stored === "") return { registry, notes };
  const broken = typeof stored !== "object" || Array.isArray(stored) ? "was not readable"
    : stored.schemaVersion !== SCHEMA_VERSION ? `came from another Toolkit version (record format ${stored.schemaVersion ?? "not stated"})`
    : !stored.providers || typeof stored.providers !== "object" ? "named no services" : null;
  if (broken) return { registry, notes: [`The stored integration record ${broken}: both services start from their defaults.`] };
  for (const provider of PROVIDERS) {
    const entry = stored.providers[provider];
    if (!entry || typeof entry !== "object") continue;
    const target = registry.providers[provider];
    for (const dimension of Object.keys(DIMENSIONS)) {
      const value = entry[dimension];
      if (value === undefined) continue;
      if (DIMENSIONS[dimension].includes(value)) target[dimension] = value;
      else notes.push(`${NAMES[provider]}: ${dimension} was "${String(value).slice(0, 40)}", not a value this release understands; reset to "${target[dimension]}".`);
    }
    if (typeof entry.lastSuccessfulCheckAt === "string") target.lastSuccessfulCheckAt = entry.lastSuccessfulCheckAt;
    if (entry.lastCheck) target.lastCheck = Object.fromEntries(["at", "outcome", "code", "detail", "retryAfter", "accessState"].map((field) => [field, entry.lastCheck[field] ?? null]));
    // INT-15: where the installation value came from travels with it, so a restart does not turn another
    // window's fact into this profile's own verdict. A source this release cannot name is dropped out loud.
    if (entry.installationSource !== undefined) {
      if (INSTALLATION_SOURCES.includes(entry.installationSource)) target.installationSource = entry.installationSource;
      else notes.push(`${NAMES[provider]}: the record says its installation came from "${String(entry.installationSource).slice(0, 40)}", which this release cannot vouch for; the installation is kept and its stated source is dropped.`);
    }
    if (typeof entry.installationFactAt === "string" && Number.isFinite(Date.parse(entry.installationFactAt))) target.installationFactAt = entry.installationFactAt;
    if (typeof entry.installationFactPlatform === "string" && entry.installationFactPlatform.length) target.installationFactPlatform = entry.installationFactPlatform.slice(0, 40);
    if (provider === "zotero") continue;
    if (entry.mode !== undefined) {
      if (MODES.includes(entry.mode)) target.mode = entry.mode;
      else notes.push("Semantic Scholar: the stored access mode is not one this release offers, so it is back to anonymous without a key.");
    }
    const license = entry.license || {};
    target.license = { acknowledged: license.acknowledged === true, reference: typeof license.reference === "string" ? license.reference : null, acknowledgedAt: typeof license.acknowledgedAt === "string" ? license.acknowledgedAt : null };
    target.credentials.configured = entry.credentials?.configured === true;
    if (entry.keyDecision !== undefined) {
      if (KEY_DECISIONS.includes(entry.keyDecision)) target.keyDecision = entry.keyDecision;
      else notes.push("Semantic Scholar: the stored key decision is not one this release records, so it is back to not offered.");
    }
    // Consent a record claims but cannot show is treated as none: the Toolkit never assumes an agreement.
    // The readiness that arrived with that claim goes with it — this release cannot have probed a hosted API
    // it was not allowed to call, so a "ready" next to a missing confirmation is not evidence.
    if (target.authorization === "authorized" && !target.license.acknowledged) {
      target.authorization = "awaiting-consent";
      target.readiness = "unchecked";
      target.lastSuccessfulCheckAt = null;
      notes.push("Semantic Scholar: the record claimed your confirmation but does not carry one, so the confirmation and the readiness that came with it are both back to their starting state.");
    }
  }
  if (typeof stored.updatedAt === "string") registry.updatedAt = stored.updatedAt;
  // A record written by this release stores the budget as a number; an older or hand-edited one may hold the
  // ISO text. Both are read as the same instant so a saved check is never forgotten.
  const probeAt = epoch(stored.lastProbeAt);
  if (probeAt !== null) registry.lastProbeAt = probeAt;
  return { registry, notes };
}

/** An unknown provider is refused before anything is built, so a typo cannot create a half-written record. */
function staged(registry, provider, at) {
  if (!PROVIDERS.includes(provider)) throw new TypeError(`The Toolkit has no integration called "${String(provider).slice(0, 40)}".`);
  const copy = structuredClone(registry && registry.providers ? registry : emptyRegistry());
  copy.schemaVersion = SCHEMA_VERSION;
  copy.updatedAt = at;
  return copy;
}

const assertMode = (mode) => { if (!MODES.includes(mode)) throw new TypeError(`"${String(mode).slice(0, 40)}" is not an access mode the Toolkit offers.`); };
// A moment is either an epoch number or the ISO text a caller was given; both are read as the same instant.
const epoch = (value) => Number.isFinite(value) ? value : Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const edit = (registry, provider, at, apply) => { const copy = staged(registry, provider, at); apply(copy.providers[provider]); return copy; };

/** Consent, recorded. The acknowledgement must come from the operator, never from this module (DD11-05). */
function authorizeSemanticScholar(registry, { acknowledged, at, mode = "anonymous" } = {}) {
  if (acknowledged !== true) throw new TypeError("You have not confirmed the Semantic Scholar API licence, so the Toolkit will not record it.");
  assertMode(mode);
  return edit(registry, "semantic-scholar", at, (entry) => Object.assign(entry, { authorization: "authorized", onboarding: "completed", mode, license: { acknowledged: true, reference: LICENSE_REFERENCE, acknowledgedAt: at } }));
}

// Skipping the guide is a refusal to decide, not a decision: consent stays exactly where it was.
const beginOnboarding = (registry, provider, at) => edit(registry, provider, at, (entry) => { entry.onboarding = "in-progress"; });
const skipOnboarding = (registry, provider, at) => edit(registry, provider, at, (entry) => { entry.onboarding = "skipped"; });
const resetIntegration = (registry, provider, at) => { const copy = staged(registry, provider, at); copy.providers[provider] = structuredClone(DEFAULTS[provider]); return copy; };

/** Off, not erased: the record survives so re-authorizing does not re-run the guide (DD11-11). */
const revokeIntegration = (registry, provider, at) => edit(registry, provider, at, (entry) => {
  Object.assign(entry, { authorization: "revoked", readiness: "unchecked", lastSuccessfulCheckAt: null });
  if (entry.license) { entry.license.acknowledged = false; entry.credentials.configured = false; }
});

const setMode = (registry, provider, mode, at) => {
  if (provider !== "semantic-scholar") throw new TypeError(`${NAMES[provider] || provider} has no access mode to change.`);
  assertMode(mode);
  return edit(registry, provider, at, (entry) => { entry.mode = mode; });
};

const setCredentialConfigured = (registry, provider, configured, at) => {
  if (typeof configured !== "boolean") throw new TypeError("The Toolkit records a key as stored or not stored; anything else is refused.");
  return edit(registry, provider, at, (entry) => { entry.credentials = { storage: "vscode-secret-storage", configured }; });
};

/**
 * The key step records one thing: what the operator decided about a key. It never records a consent, never
 * records a key, and never closes the guide — a step the operator finished is not the whole walkthrough (INT-14.1).
 */
function recordKeyDecision(registry, provider, decision, at) {
  if (provider !== "semantic-scholar") throw new TypeError("Zotero local reading has no key to decide about.");
  if (!KEY_DECISIONS.includes(decision)) throw new TypeError(`"${String(decision).slice(0, 40)}" is not a key decision the Toolkit records.`);
  return edit(registry, provider, at, (entry) => { entry.keyDecision = decision; });
}

/**
 * INT-15 (DD12-02): a machine-level fact may set `installation` and nothing else. It never sets
 * `authorization`, `credentials.configured`, `mode`, `license` or `onboarding` — those are this profile's own
 * facts, and a fresh profile starts at `not-required` / `awaiting-consent` / `not-started` even when the fact
 * says Zotero is ready. A fact this module cannot honour is refused with the reason stated, and the record the
 * caller handed in is left untouched.
 */
function applyMachineFact(registry, provider, fact, at) {
  if (!PROVIDERS.includes(provider)) throw new TypeError(`The Toolkit has no integration called "${String(provider).slice(0, 40)}".`);
  if (provider !== "zotero") throw new TypeError(`${NAMES[provider]} is a hosted service: it has no installation on this machine, so there is no installation fact to apply.`);
  const record = fact && typeof fact === "object" && !Array.isArray(fact) ? fact : null;
  if (!record) throw new TypeError("The machine installation record is not a record, so nothing was applied.");
  if (!FACT_CLASSIFICATIONS.includes(record.classification)) throw new TypeError(`"${String(record.classification).slice(0, 40)}" is not an installation answer this release can read, so nothing was applied.`);
  if (typeof record.found !== "boolean") throw new TypeError("An installation answer has to say whether Zotero was found, as yes or no, so nothing was applied.");
  if (FACT_FOUND[record.classification] !== undefined && FACT_FOUND[record.classification] !== record.found) throw new TypeError(`The machine record says "${record.classification}" and found=${record.found}, which contradict each other, so nothing was applied.`);
  if (typeof record.platform !== "string" || !record.platform.length || record.platform.length > 40) throw new TypeError("An installation answer names the platform it was taken on; this one does not, so nothing was applied.");
  if (!Number.isInteger(record.detectedAtMs) || record.detectedAtMs <= 0) throw new TypeError("An installation answer carries the moment it was taken; this one does not, so nothing was applied.");
  const asked = epoch(at);
  if (asked === null) throw new TypeError("The Toolkit needs the moment it read the machine record to judge how current it is.");
  if (record.detectedAtMs > asked) throw new TypeError(`The machine record is dated ${new Date(record.detectedAtMs).toISOString()}, later than this window asked for it, so it was not used.`);
  const installation = FACT_INSTALLATION[record.classification];
  return edit(registry, "zotero", at, (entry) => {
    // A check this profile actually ran is better evidence for this profile's record than a fact another
    // window took earlier, so an older machine fact never overrules a fresher own check.
    const own = epoch(entry.lastCheck?.at);
    if (own !== null && own >= record.detectedAtMs) return;
    entry.installationFactAt = new Date(record.detectedAtMs).toISOString();
    entry.installationFactPlatform = record.platform;
    // `unknown` sets no installation and claims no source: it says the other window looked and could not tell.
    if (installation) { entry.installation = installation; entry.installationSource = "machine-fact"; }
  });
}

// Each outcome moves only the dimensions it is evidence about. `rate-limited` moves readiness alone: a 429 is not a
// lost account, and clearing consent or the key over one would make the operator re-decide what they already decided.
const PROBE_EFFECTS = {
  ready: { readiness: "ready" },
  "not-installed": { installation: "not-detected", readiness: "unavailable" },
  "not-running": { installation: "detected", readiness: "unavailable" },
  "api-disabled": { installation: "detected", readiness: "unavailable" },
  "rate-limited": { readiness: "degraded" },
  unreachable: { readiness: "unavailable" },
  // "unknown" is the worker saying it could not tell which state this is. That is not a failure to reach
  // anything and it is not a verdict about the installation, so readiness goes back to unchecked and the
  // installation dimension keeps whatever it already had. Assuming a failure here would be a guess.
  unknown: { readiness: "unchecked" },
};

function recordProbe(registry, provider, probe, at) {
  const copy = staged(registry, provider, at);
  const entry = copy.providers[provider];
  const report = probe && typeof probe === "object" ? probe : {};
  let detail = report.detail || null;
  const hosted = entry.installation === "not-applicable"; // a hosted API is not something this machine installs
  if (PROBE_EFFECTS[report.outcome]) Object.assign(entry, PROBE_EFFECTS[report.outcome]);
  // With a key configured the account is there and this request was refused; without one it is not reachable.
  else if (report.outcome === "auth-required") entry.readiness = provider === "semantic-scholar" && entry.credentials?.configured ? "degraded" : "unavailable";
  else {
    entry.readiness = "unchecked";
    detail = `The readiness worker reported "${report.outcome ?? "nothing"}", which this release does not understand.${detail ? ` Worker detail: ${detail}` : ""}`;
  }
  // 0.3.15 (TASK P-2): a check the worker was never allowed to ask says nothing about whether the service
  // answers. Recording it as "not answering" is how a consent the operator had already given read, on
  // 21 November 2026, as a provider that was broken — and sent them to confirm something twice. The state is
  // applied after the outcome rules so it overrides the readiness they would otherwise stamp, and it never
  // touches authorization, consent or the key.
  if (report.accessState === "consent-stored-not-injected") entry.readiness = "unchecked";
  if (typeof report.installed === "boolean") entry.installation = report.installed ? "detected" : "not-detected";
  // A hosted API is not something this machine installs: no probe verdict makes it "not installed".
  if (hosted) entry.installation = "not-applicable";
  // A check this window ran is the strongest source the installation dimension can have, and it replaces a
  // pre-fill another window left behind (INT-15.4).
  if (provider === "zotero") entry.installationSource = "profile-check";
  entry.lastCheck = { at, outcome: report.outcome ?? null, code: report.code || null, detail, retryAfter: report.retryAfter || null, serverId: report.serverId || null, evidence: report.evidence || null,
    // 0.3.15: the worker's named practical state, kept as data beside the sentence. An unknown word is stored
    // as null rather than passed through, so a future worker cannot invent a state the card has no wording for.
    accessState: ACCESS_STATES.includes(report.accessState) ? report.accessState : null };
  if (report.outcome === "ready") entry.lastSuccessfulCheckAt = at; // only a check that reached the service counts
  // The shared budget is compared as a number, so it is stored as one. An ISO string here would make every
  // window believe no check had ever run, and several windows would stampede the same service.
  copy.lastProbeAt = epoch(at);
  return copy;
}

const isAuthorized = (registry, provider) => registry?.providers?.[provider]?.authorization === "authorized";

/** Local Zotero reading needs no Toolkit-side consent; Semantic Scholar needs the operator's own confirmation. */
const needsConsent = (registry, provider) => provider === "semantic-scholar" && registry?.providers?.[provider]?.license?.acknowledged !== true;

// [label, detail, nextAction]. "not checked in this workspace yet" is deliberate: a saved record is not a broken one.
const WORDING = {
  consent: ["Requires your confirmation", "Your confirmation of the two Semantic Scholar agreements — the API Licence and the Dataset License Agreement — is not recorded yet. The Toolkit's record grants nothing beyond them.", "Read both agreements and activate"],
  revoked: ["Turned off", "You turned this service off in this profile. The Toolkit sends nothing to it and passes no key.", "Activate it again."],
  degraded: ["Active — temporarily rate limited", "The Toolkit is rate limited by this service. Your authorization and your stored key are unchanged. Anonymous requests share one capacity with every other unauthenticated user of the service, so a refusal is not a fault in your setup. The research worker shares one request budget across Toolkit processes and waits out a bounded backoff of its own before the next request.", "Nothing needs to be authorized again. Check integrations again after a pause."],
  ready: ["Ready", "The last check reached the service.", "Nothing to do."],
  unchecked: ["Not checked in this workspace yet", "Saved in this profile; not checked in this workspace yet.", "Check integrations."],
  "not-detected": ["Not installed", "No Zotero was found on this machine. The Toolkit installed nothing and ran nothing.", `Guided installation opens the official installer page at ${ZOTERO_DOWNLOAD_URL}. The Toolkit downloads nothing and runs nothing.`],
  "not-answering": ["Configured — Zotero is not answering", "Zotero is installed, but its local API did not answer. Your setup is unchanged and the guide will not run again.", "Start Zotero, then check again."],
  "api-refused": [`Installed — Zotero is refusing local access`, `Zotero appears to be running and is refusing local clients. Nothing is missing and no library file was opened. The setting to change is Zotero's own ${ZOTERO_LOCAL_API_SETTING}; the Toolkit will not change it for you.`, "Open the Zotero guide, change that setting in Zotero, then check integrations again."],
  unknown: ["Not answering", "The service did not answer, and this release cannot tell whether it is installed.", "Check integrations again."],
  // INT-15 (DD12-02): an installation this profile took from the machine record rather than measured here.
  // Distinct from `unchecked` above, where nothing at all has been established: here something was established
  // about this machine by another window, and the card has to say whose fact it is instead of letting it read
  // as a verdict this profile reached. Distinct from `not-detected` too: the guided offer is the same, the
  // claim about who found it is not.
  "machine-found": ["Found on this machine — not checked in this profile", "Another window of the same OS user found Zotero on this machine, and this profile has taken that as its installation fact. Nothing else was inherited: your authorization, your access mode and any stored key belong to this profile alone, and no readiness check has run here.", "Check integrations to see whether Zotero's local API answers."],
  "machine-missing": ["Not found on this machine — not checked in this profile", "Another window of the same OS user found no Zotero on this machine, and this profile has taken that as its installation fact. Nothing else was inherited: your authorization and any stored key belong to this profile alone. The Toolkit installed nothing and ran nothing.", `Guided installation opens the official installer page at ${ZOTERO_DOWNLOAD_URL}. The Toolkit downloads nothing and runs nothing.`],
  // Distinct from `unknown` above: here something *did* answer, and the Toolkit could not read what it said.
  // Saying "not checked yet" after a check that answered would be a lie about the check that just ran.
  "answered-badly": ["Answered, but not readable", "Something answered where the Toolkit expected to find the service, but the answer was not one this release can read. Nothing was assumed about your setup.", "Check integrations again. If it repeats, open the integration guide."],
  unavailable: ["Not answering right now", "The last check did not reach the service. Your confirmation and your key are unchanged.", "Check again."],
  // 0.3.15 (TASK P-3): two states the worker now names, both of which used to read as "not answering".
  // `confirmed-not-injected` is the 21 November 2026 confusion — the operator had confirmed both agreements,
  // the check ran in a process that was not given the confirmation, and the card implied a missing
  // confirmation. `confirmed-anonymous-refused` is 22 November: authorised, anonymous, no key taken, HTTP 429
  // and no check that ever reached the service — which a bare "temporarily rate limited" hides.
  "confirmed-not-injected": ["Confirmed — this check did not carry it", "Your confirmation of the Semantic Scholar agreements is recorded on this machine. The check ran in a worker process that was not given that confirmation, so nothing was asked of the service; your confirmation and your key are unchanged.", "Use Check now on this card: it is the path that carries your confirmation to the worker. Nothing needs to be confirmed again."],
  "confirmed-anonymous-refused": ["Confirmed — refused while anonymous", "This provider is authorised here and no check has reached it on this machine. The Toolkit asks anonymously, where every unauthenticated caller shares one global request pool, ", "Choose a key in the Semantic Scholar guide, or check again after a pause."],
};

/**
 * What this record may offer, as [id, operator label] pairs, decided by the model and not by the renderer: an
 * operator who has Zotero is not pitched an installer (T12-22), an operator who has a key is not asked whether they
 * want one, and an integration nobody authorized is not offered a key box it would refuse to fill (INT-14.1).
 * One list feeds the card and the Quick Pick, so the two cannot offer different things from one record.
 */
const ACTION_LABELS = {
  check: "Check now", activate: "Activate", guideInstall: "Guided installation",
  installedNow: "I have installed Zotero — check it now", apiGuide: "Allow local access in Zotero",
  machineFact: "What did this machine find?",
  requestKey: "Request a personal API key", provideKey: "I already have a key", noKey: "Continue without a key",
  replaceKey: "Replace key", removeKey: "Remove key", testKey: "Test the key", deactivate: "Turn off", reset: "Reset",
};

function offeredActions(entry, provider, { installationUnconfirmed = false } = {}) {
  const ids = ["check"];
  if (provider === "zotero") {
    // A machine installation fact past its window is still evidence and is still stored, but it no longer answers
    // the installation question: a month-old confirmation is not a fact about now. The guided offer and the
    // re-check come back; nothing is deleted.
    if (entry.installation === "not-detected" || installationUnconfirmed) ids.push("guideInstall", "installedNow");
    if (entry.lastCheck?.outcome === "api-disabled") ids.push("apiGuide");
    // Zotero's guide has no consent step, so `activate` there is the walkthrough, not a grant. Once the operator
    // has closed it, or a check has reached Zotero, it re-opens the modal and spends the shared 30-second budget.
    const guideStillOpen = entry.onboarding === "not-started" || entry.onboarding === "in-progress";
    if (guideStillOpen && entry.readiness !== "ready" && entry.authorization !== "authorized") ids.push("activate");
    // INT-15: the machine record is consulted only when the operator asks for it. It is never consulted on
    // opening a window, and Semantic Scholar is never offered it — a hosted API has no installation fact.
    ids.push("machineFact");
  } else if (entry.authorization !== "authorized") ids.push("activate");
  if (provider === "semantic-scholar") {
    if (entry.credentials?.configured) ids.push("replaceKey", "removeKey", "testKey");
    else ids.push("requestKey", ...(entry.authorization === "authorized" ? ["provideKey"] : []), "noKey");
  }
  if (entry.authorization === "authorized") ids.push("deactivate");
  return ids.concat("reset").map((id) => [id, ACTION_LABELS[id]]);
}

// The window this model falls back to when a caller hands in none. `integrationprobe.js` publishes the same
// number as `PROBE_COOLDOWN_MS`, and a test in `credential-security.test.js` asserts the two agree: at run time
// the controller passes the resolved `researchStack.integrationCooldownSeconds`, so the card's countdown, the
// refusal a press gets and the bound the worker call runs under all come from that one resolved value (HR-30).
const PROBE_COOLDOWN_MS = 10_000;

function integrationViews(registry, { now, canProbe = true, cooldownMs = PROBE_COOLDOWN_MS } = {}) {
  const base = registry?.providers ? registry : emptyRegistry();
  const instant = epoch(now);
  // The check budget belongs to the record, not to a window, so the card can name the wait before the press.
  // `probeCooldown` gets the caller's instant only: with no clock handed in the wait is 0 — this module owns none.
  // The window is the caller's too: a card that counts down a different number from the one the press is refused
  // with is the drift HR-30 names.
  const probeWaitMs = instant === null ? 0 : probeCooldown({ lastProbeAt: base.lastProbeAt, now: instant, cooldownMs }).waitMs;
  return PROVIDERS.map((provider) => {
    const entry = base.providers[provider] || structuredClone(DEFAULTS[provider]);
    const consentRequired = needsConsent(base, provider);
    const retryAfter = entry.lastCheck?.retryAfter ? String(entry.lastCheck.retryAfter) : null;
    // INT-15 (DD12-02): whose installation fact this is. A machine fact shown without its source reads exactly
    // like a verdict this profile measured, which is the one thing this feature must never do.
    const factAt = typeof entry.installationFactAt === "string" && Number.isFinite(Date.parse(entry.installationFactAt)) ? entry.installationFactAt : null;
    const factAge = factAt !== null && instant !== null ? instant - Date.parse(factAt) : null;
    const factStale = factAge !== null && factAge > MACHINE_FACT_MAX_AGE_MS;
    const factWindow = factStale ? ` That record is older than the Toolkit's ${MACHINE_FACT_DAYS}-day window, so it is a fact about the moment it was taken, not about now.` : "";
    const platform = typeof entry.installationFactPlatform === "string" && entry.installationFactPlatform.length ? ` on ${entry.installationFactPlatform}` : "";
    const fromMachine = provider === "zotero" && entry.installationSource === "machine-fact";
    const machine = fromMachine && entry.readiness === "unchecked" && entry.installation !== "unknown";
    // Only where the installation rests on the stale fact: one this profile measured stands on its own.
    const installationUnconfirmed = provider === "zotero" && factStale && entry.installationSource !== "profile-check";
    let provenance = null;
    let provenanceAt = null;
    if (fromMachine) {
      provenance = `Installation ${entry.installation === "detected" ? "found" : "not found"} by another window of the same OS user${platform}. This profile has not checked it.${factWindow}`;
      provenanceAt = factAt;
    } else if (provider === "zotero" && entry.installationSource === "profile-check") provenance = "Installation recorded by a check this profile ran.";
    else if (provider === "zotero" && factAt) {
      provenance = `Another window of the same OS user looked for Zotero on this machine and could not tell what it found. This profile has not checked it.${factWindow}`;
      provenanceAt = factAt;
    }
    // The worker's named practical state is consulted before the outcome word, because it is the more
    // specific fact: a 429 that never reached the service and a 429 after a successful check carry the same
    // outcome and deserve different sentences.
    const accessState = entry.lastCheck?.accessState ?? null;
    const key = consentRequired ? "consent" : entry.authorization === "revoked" ? "revoked"
      : accessState === "consent-stored-not-injected" ? "confirmed-not-injected"
      : accessState === "consented-but-unusable" ? "confirmed-anonymous-refused"
      : entry.lastCheck?.outcome === "unknown" ? "answered-badly"
      : machine ? (entry.installation === "detected" ? "machine-found" : "machine-missing")
      : entry.readiness === "degraded" || entry.readiness === "ready" || entry.readiness === "unchecked" ? entry.readiness
      : provider === "zotero" ? (entry.installation === "detected" ? (entry.lastCheck?.outcome === "api-disabled" ? "api-refused" : "not-answering") : entry.installation === "not-detected" ? "not-detected" : "unknown") : "unavailable";
    const [label, detail, nextAction] = WORDING[key];
    const view = {
      id: provider, title: NAMES[provider], installation: entry.installation, authorization: entry.authorization, readiness: entry.readiness,
      onboarding: entry.onboarding, mode: entry.mode || null, consentRequired, label, nextAction, retryAfter,
      credentialConfigured: entry.credentials?.configured === true,
      // What the check actually saw, kept separate from the sentence so a person can tell the two apart.
      serverId: entry.lastCheck?.serverId ?? null, evidence: entry.lastCheck?.evidence ?? null,
      workerDetail: entry.lastCheck?.detail ?? null, lastOutcome: entry.lastCheck?.outcome ?? null,
      // INT-15: the installation dimension's own provenance, and how old the fact behind it is.
      installationSource: entry.installationSource ?? null, installationProvenance: provenance,
      installationFactAt: provenanceAt, installationFactStale: provenanceAt !== null && factStale,
      actions: offeredActions(entry, provider, { installationUnconfirmed }),
      // Whether a check can run here, and how long the shared budget has to wait.
      probeBlocked: canProbe === false ? PROBE_BLOCKED_SENTENCE : null, probeWaitMs,
      // A pause is named only when the check actually carried one: the provider does not document a wait window,
      // so promising one would be a promise the Toolkit cannot keep.
      detail: key === "degraded" && retryAfter ? `${detail} The check carried a pause of ${retryAfter}.` : detail,
      lastCheckAt: entry.lastCheck?.at ?? null, lastSuccessfulCheckAt: entry.lastSuccessfulCheckAt,
    };
    // A "ready" verdict is only as good as the check behind it, and nothing probes on its own (DD11-07).
    if (key === "ready" && instant !== null && entry.lastSuccessfulCheckAt && instant - Date.parse(entry.lastSuccessfulCheckAt) > 86_400_000) view.detail += " That check is more than 24 hours old.";
    // An installer offer beside a found-on-this-machine line has to say why it is back.
    if (installationUnconfirmed) view.detail += ` The guided installation is offered again because that confirmation is older than the Toolkit's ${MACHINE_FACT_DAYS}-day window.`;
    // 0.3.15 (TASK P-3): the anonymous refusal names the operator's own recorded decision, because "rate
    // limited" is not a next step and the decision is what makes one. What is named is the decision, never a
    // key: `keyDecision` says whether the operator was offered one and what they answered, and no credential
    // value is stored anywhere in this record.
    if (key === "confirmed-anonymous-refused") {
      view.detail += `${KEY_CLAUSES[entry.keyDecision] ?? "no key decision is recorded in this profile"}.`
        + ` Last check that reached this service from this machine: ${entry.lastSuccessfulCheckAt ?? "none"}.`;
    }
    return view;
  });
}

/** One probe per window across every window of the profile, so the cooldown comes from storage, not memory (DD11-09).
 *  The default is the window this module publishes above, which a test pins to the one `integrationprobe.js`
 *  publishes; the controller hands in the resolved setting whenever the operator has one. */
function probeCooldown({ lastProbeAt, now = Date.now(), cooldownMs = PROBE_COOLDOWN_MS } = {}) {
  const started = epoch(lastProbeAt);
  const instant = epoch(now);
  if (started === null || started <= 0 || instant === null) return { allowed: true, waitMs: 0 };
  const waited = instant - started;
  return waited >= cooldownMs ? { allowed: true, waitMs: 0 } : { allowed: false, waitMs: cooldownMs - waited };
}

module.exports = {
  SCHEMA_VERSION, PROVIDERS, DIMENSIONS, LICENSE_REFERENCE, LICENSE_URL, API_LICENSE_URL, KEY_DECISIONS, ZOTERO_DOWNLOAD_URL,
  PROBE_COOLDOWN_MS,
  ZOTERO_LOCAL_API_SETTING, API_KEY_APPLICATION_URL, MACHINE_FACT_MAX_AGE_MS, MACHINE_FACT_DAYS, FACT_CLASSIFICATIONS,
  INSTALLATION_SOURCES, FACT_FOUND, NAMES, PROBE_BLOCKED_SENTENCE, emptyRegistry, readRegistry, authorizeSemanticScholar,
  beginOnboarding, skipOnboarding, revokeIntegration, resetIntegration, setMode, setCredentialConfigured,
  recordKeyDecision, applyMachineFact, recordProbe, isAuthorized, needsConsent, integrationViews, probeCooldown,
};
