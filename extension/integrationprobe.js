"use strict";

/**
 * The readiness probe boundary (0.3.11): the argv for `research-stack probe-integrations`, the environment that call
 * may carry, and the worker's receipt read back into probe outcomes. The probing itself belongs to the Python
 * worker, which already owns the loopback-only Zotero opener, the HTTPS-only provider redirects, the response cap
 * and the pacing floor (DD11-01). This module builds and interprets and reaches nothing — no network
 * transport, no process, no timer, no editor import. An unknown provider is refused before a command
 * exists, and a key travels only with the mode that asked for it (DD11-06). A receipt this release cannot read is a verdict, never an exception.
 */

const integrations = require("./integrations");

// 10 s, not 30 s (0.3.11 phase 13, J7): the automatic check that follows "Activate" used to spend a 30 s
// budget, and the operator's deliberate "I have installed Zotero — check it now" was then refused. A press is
// not a stampede. The window still stops double-presses and cross-window repeats; `integrations.js` publishes
// the same number as its own default, and a test asserts the two agree. Since 0.3.14 this is a default, not a
// law: `researchStack.integrationCooldownSeconds` moves it, and `probeBounds` is the only place that happens.
const PROBE_COOLDOWN_MS = 10_000;
// 80 s, not 20 s (0.3.11 phase 13). Zotero answers its local API only after the library has loaded, and its
// own Connector allows 15 s for one request. The worker's Zotero stages are 5 + 5 + 12 + 12 (the retry) = 34 s
// worst case; the hosted side is bounded by the budget module's wall-clock ceiling (20 s) plus the one request
// already in flight when that ceiling is reached (15 s). This bound is above the sum of the two plus start-up.
// It is a kill bound, not a promise that a check finishes: a check that runs this long is a check whose
// services are not answering, and the receipt says so. Since 0.3.14 it is the published default of
// `researchStack.integrationTimeoutMs`; the clamp below is what keeps a value an operator set above that sum.
const PROBE_TIMEOUT_MS = 80_000;
// HR-30 (0.3.14, finding R15-04): a default with no stated range is a number an operator cannot safely
// change, and the two settings `researchStack.integrationTimeoutMs` and `researchStack.integrationCooldownSeconds`
// are now real settings. The range below is derived from the worker this call runs in, not invented here.
// Timeout: the Zotero stages are 5 + 5 + 12 + 12 = 34 s of request time (`research.py` ZOTERO_ROOT_TIMEOUT_SECONDS
// and ZOTERO_LISTING_TIMEOUT_SECONDS, read through `integrations.py` probe_zotero), the hosted side is the shared
// budget's wall-clock ceiling `CALL_CEILING_MS = 20 000` plus the one 15 s request already in flight when that
// ceiling is reached (`provider_budget.py` and `research.py` REQUEST_TIMEOUT_SECONDS) = 35 s. The published 80 s is
// above 34 + 35 with room for the interpreter start-up and the receipt write. The floor is 40 s — above the 34 s a
// Zotero-only check can spend, so the second listing, the one a library that is still loading makes the first
// request pay for, is never cut off — with about 6 s of start-up. The ceiling is 300 s: past five minutes the check
// is one whose services are not answering, and saying so is the Toolkit's job, not waiting longer.
// Cooldown: the window is measured from the moment a finished check was recorded (`extension.js` writes `lastProbeAt`
// after the worker answers), so its floor is about presses, not about request pacing — the worker's own
// one-request-per-second floor (`research.py` MIN_REQUEST_INTERVAL_SECONDS) is a separate guard. 5 s is the shortest
// window that still tells a double press or a press in a second window apart from a deliberate re-check; 300 s is
// the longest countdown the card will name.
// The manifest states the same four numbers to the Settings UI, and VS Code shows them without enforcing them on a
// hand-edited settings.json — which is why `probeBounds` clamps when it reads them instead of trusting the manifest.
const PROBE_TIMEOUT_MIN_MS = 40_000;
const PROBE_TIMEOUT_MAX_MS = 300_000;
const PROBE_COOLDOWN_MIN_SECONDS = 5;
const PROBE_COOLDOWN_MAX_SECONDS = 300;
// The worker names its providers with underscores; the host names them the way the panel does.
const WORKER_IDS = { zotero: "zotero", "semantic-scholar": "semantic_scholar" };
const OUTCOMES = ["ready", "not-installed", "not-running", "api-disabled", "rate-limited", "auth-required", "unreachable", "unknown"];

function probeArgv({ providers } = {}) {
  const ids = [];
  for (const provider of providers?.length ? providers : integrations.PROVIDERS) {
    if (!WORKER_IDS[provider]) throw new TypeError(`The Toolkit has no integration called "${String(provider).slice(0, 40)}", so no probe command was built.`);
    if (!ids.includes(WORKER_IDS[provider])) ids.push(WORKER_IDS[provider]);
  }
  return ["probe-integrations", "--providers", ids.join(",")];
}

/**
 * Only what the worker needs: a key travels with the mode that asked for it, a licence flag with a recorded consent.
 *
 * Since 0.3.15 the two facts that make that consent a fact travel with it: the moment the operator confirmed
 * the licence in this profile (`license.acknowledgedAt`) and what they answered when a key was offered
 * (`keyDecision`). Sent as the names the worker already reads — `SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED_AT`
 * and `SEMANTIC_SCHOLAR_KEY_DECISION` (`src/research_stack/integrations.py`). Carrying only the boolean left
 * the worker's own machine-level record (`machinefacts.read_provider_state`) holding a consent this process
 * was never told about, so a stored confirmation reported as `PROVIDER_TERMS_STORED_BUT_NOT_INJECTED`: the
 * card said confirmed, the check behaved as unconfirmed. Nothing here records a consent on the operator's
 * behalf — `authorizeSemanticScholar` still refuses to write one the operator did not give, and this function
 * forwards only what that record already holds. A credential value appears in the object only when the mode
 * the operator chose asked for one.
 */
function probeEnvironment({ registry, apiKey } = {}) {
  const entry = registry?.providers?.["semantic-scholar"];
  if (!entry || !integrations.isAuthorized(registry, "semantic-scholar")) return {};
  const env = { SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED: "true" };
  if (typeof entry.license?.acknowledgedAt === "string" && entry.license.acknowledgedAt.length) {
    env.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED_AT = entry.license.acknowledgedAt;
  }
  if (integrations.KEY_DECISIONS.includes(entry.keyDecision)) env.SEMANTIC_SCHOLAR_KEY_DECISION = entry.keyDecision;
  if (entry.mode === "api-key" && typeof apiKey === "string" && apiKey.length) env.SEMANTIC_SCHOLAR_API_KEY = apiKey;
  return env;
}

// An outcome this release does not know is reported as unreachable, but the worker's own code and detail are kept so
// the operator sees what the worker said instead of guessing from a generic failure. `serverId` and `evidence` are kept
// for the same reason: they are how the panel says *which* Zotero answered and *where* an installation was found.
// Both are clipped to a short string, because they come from a worker and are shown to a person.
// 160, matching the worker's own clip, so the host is never the half that loses the answer the operator needs.
const clipped = (value) => typeof value === "string" && value.length ? value.slice(0, 160) : null;

const normalized = (raw) => raw && typeof raw === "object"
  ? { outcome: OUTCOMES.includes(raw.outcome) ? raw.outcome : "unreachable", code: raw.code || null, detail: raw.detail || null, retryAfter: raw.retryAfter ?? null, installed: typeof raw.installed === "boolean" ? raw.installed : null, serverId: clipped(raw.serverId), evidence: clipped(raw.evidence) }
  : { outcome: "unreachable", code: "PROBE_RECEIPT_MISSING", detail: "The readiness worker sent no result for this service.", retryAfter: null, installed: null, serverId: null, evidence: null };

function interpretReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    const invalid = { outcome: "unreachable", code: "PROBE_RECEIPT_INVALID", detail: "The readiness worker returned something the Toolkit could not read.", retryAfter: null, installed: null };
    return { zotero: { ...invalid }, semanticScholar: { ...invalid } };
  }
  // The worker spells the second provider `semanticScholar`; the older spellings are accepted so a
  // receipt from an earlier worker is still read rather than silently dropped.
  return { zotero: normalized(receipt.zotero), semanticScholar: normalized(receipt.semanticScholar ?? receipt.semantic_scholar ?? receipt["semantic-scholar"]) };
}

// --- INT-15 (DD12-02): the machine-level installation fact -------------------------------------
// The worker owns the machine-level file and the reading of it. This module builds the argv for the
// `integration-facts` verb and reads the receipt back — no transport, no file read, no process, no timer, no
// editor import. The call goes through the same bounded `runner.js` path `probe-integrations` uses, and the
// Toolkit makes it when the operator opens the integrations flow or presses the card's re-read — never at
// activation, never on a timer, and at most once per opening.
const FACTS_ARGV = ["integration-facts"];
// Only Zotero has an installation on this machine. A machine record naming Semantic Scholar is a damaged
// record, not a provider whose fact is missing: a hosted API is not something this machine installs.
const FACT_PROVIDERS = Object.freeze(["zotero"]);
// The worker's machine file is size-capped at `MAX_FACTS_BYTES = 8 192` (machinefacts.py, INT-15.3) and a write
// that would pass its own bound is refused whole rather than truncated. The reader uses the same number: a read
// cap below the write cap would turn a record the Toolkit itself wrote into a refusal, which is a defect
// invented at the boundary. The host measures the compact form of what it parsed, which is never larger than
// the indented file the writer measured, so the reader can only be more permissive, never less. The field caps
// below are wider than the writer's (platform 32, code 48) for the same reason.
const MAX_FACTS_BYTES = 8192;
const MAX_FACT_PLATFORM = 40;
const MAX_FACT_CODE = 80;

const factsArgv = () => [...FACTS_ARGV];

/**
 * The one validation, in one place: `{ facts, reason }`, exactly one of them null. `interpretFacts` is the
 * verdict the caller acts on; `factRejectionReason` is the sentence that goes with a `null`, so a refusal can
 * be stated to the operator instead of inferred from an absence. Nothing here fills in a shape it could not
 * read: an unknown classification, a `found` that contradicts the classification, a missing detection time, a
 * record with no detection time at all, or a record over the cap is a refusal.
 */
function readFacts(receipt) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return { facts: null, reason: "it was not a machine record at all" };
  let text;
  try { text = JSON.stringify(receipt); } catch { return { facts: null, reason: "its size could not be measured" }; }
  if (text.length > MAX_FACTS_BYTES) return { facts: null, reason: `it is ${text.length} characters, over the ${MAX_FACTS_BYTES} the Toolkit will read` };
  if (receipt.schemaVersion !== 1) return { facts: null, reason: `it is format ${typeof receipt.schemaVersion === "number" ? receipt.schemaVersion : "not stated"}, which this release cannot read` };
  const recorded = receipt.facts;
  if (!recorded || typeof recorded !== "object" || Array.isArray(recorded)) return { facts: null, reason: "it named no services" };
  const facts = {};
  for (const name of Object.keys(recorded)) {
    const provider = name === "semantic_scholar" ? "semantic-scholar" : name;
    if (!integrations.PROVIDERS.includes(provider)) return { facts: null, reason: `"${String(name).slice(0, 40)}" is not a service the Toolkit has` };
    if (provider !== "zotero") return { facts: null, reason: "it recorded an installation for Semantic Scholar, which is a hosted service with nothing on this machine to install" };
    const fact = recorded[name];
    if (!fact || typeof fact !== "object" || Array.isArray(fact)) return { facts: null, reason: "its Zotero entry is not a record" };
    if (!integrations.FACT_CLASSIFICATIONS.includes(fact.classification)) return { facts: null, reason: `its Zotero entry says "${String(fact.classification).slice(0, 40)}", which is not an installation answer this release can read` };
    if (typeof fact.found !== "boolean") return { facts: null, reason: "its Zotero entry does not say whether Zotero was found" };
    if (integrations.FACT_FOUND[fact.classification] !== undefined && integrations.FACT_FOUND[fact.classification] !== fact.found) return { facts: null, reason: `its Zotero entry says "${fact.classification}" and found=${fact.found}, which contradict each other` };
    if (typeof fact.platform !== "string" || !fact.platform.length || fact.platform.length > MAX_FACT_PLATFORM) return { facts: null, reason: "its Zotero entry does not name the platform it was taken on" };
    if (!Number.isInteger(fact.detectedAtMs) || fact.detectedAtMs <= 0) return { facts: null, reason: "its Zotero entry does not carry the moment it was taken" };
    if (fact.code !== undefined && fact.code !== null && (typeof fact.code !== "string" || !fact.code.length || fact.code.length > MAX_FACT_CODE)) return { facts: null, reason: "its Zotero diagnostic code is not a short piece of text" };
    facts.zotero = { found: fact.found, classification: fact.classification, platform: fact.platform, detectedAtMs: fact.detectedAtMs, code: typeof fact.code === "string" ? fact.code : null };
  }
  return { facts, reason: null };
}

/** The facts this release can use, or `null`. A `null` is never a guess: the reason is in `factRejectionReason`. */
const interpretFacts = (receipt) => readFacts(receipt).facts;
const factRejectionReason = (receipt) => readFacts(receipt).reason;

/** One sentence per outcome, with the pause window when the service named one. */
function describeProbeFailure(provider, probe) {
  const report = probe && typeof probe === "object" ? probe : {};
  const name = provider === "semantic-scholar" ? "Semantic Scholar" : "Zotero";
  // The provider documents no wait window, so a pause is reported only when the check actually carried one.
  const pause = report.retryAfter ? ` The check carried a pause of ${String(report.retryAfter).slice(0, 40)}.` : "";
  const said = report.detail ? ` The worker said: ${String(report.detail).slice(0, 160)}.` : "";
  const lines = {
    ready: `${name} answered.`,
    "not-installed": `${name} is not installed on this machine.`,
    "not-running": `${name} is installed but not answering. Start it, then check again.`,
    "api-disabled": `${name} is installed, but its API interface is switched off.`,
    "rate-limited": `${name} is rate limited. Your authorization and your key are unchanged, and nothing needs to be authorized again.`,
    "auth-required": `${name} refused the request as unauthenticated. Check the key or the mode.`,
    unreachable: `${name} could not be reached from this machine.`,
    unknown: `${name}: the Toolkit could not tell which state this is, and assumed nothing about your machine. Run the check again, or open the integration guide.`,
  };
  return `${lines[report.outcome] || `${name}: the readiness worker reported "${report.outcome ?? "nothing"}", which this release does not understand.`}${report.outcome === "ready" ? "" : `${pause}${said}`}`;
}

/** One clamp, in one place (HR-30): what the operator set becomes what the callers use. `undefined` means the
 *  operator set nothing, which is the published default and not a clamp. Anything else that is not a finite
 *  number — a string, a boolean, NaN, an Infinity, a list — is replaced, and the replacement is *said*: `clamped`
 *  holds one sentence per value the Toolkit changed, naming the setting, what was set and what was used, so a
 *  panel or a log can show that the bound in force is not the one in settings.json. A value in range is used as
 *  given, rounded to a whole unit; nothing here reads a setting, a clock or the editor. */
function probeBounds({ integrationTimeoutMs, integrationCooldownSeconds } = {}) {
  const described = (value) => {
    if (value === null) return "nothing";
    if (typeof value === "string") return `"${value.slice(0, 40)}"`;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value)) return "a list";
    if (typeof value === "object") return "an object";
    return `a ${typeof value}`;
  };
  const bounded = ({ value, setting, unit, min, max, fallback }) => {
    if (value === undefined) return { used: fallback, clamped: null };
    const given = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
    if (given === null) return { used: fallback, clamped: `${setting} is ${described(value)}, which is not a number this release can use, so the check ran under its published ${fallback}${unit}.` };
    if (given < min) return { used: min, clamped: `${setting} is ${given}${unit}, below the ${min}${unit} the Toolkit will run a check at, so ${min}${unit} was used.` };
    if (given > max) return { used: max, clamped: `${setting} is ${given}${unit}, above the ${max}${unit} the Toolkit will wait for a check, so ${max}${unit} was used.` };
    return { used: given, clamped: null };
  };
  const timeout = bounded({ value: integrationTimeoutMs, setting: "researchStack.integrationTimeoutMs", unit: " ms", min: PROBE_TIMEOUT_MIN_MS, max: PROBE_TIMEOUT_MAX_MS, fallback: PROBE_TIMEOUT_MS });
  const cooldown = bounded({ value: integrationCooldownSeconds, setting: "researchStack.integrationCooldownSeconds", unit: " seconds", min: PROBE_COOLDOWN_MIN_SECONDS, max: PROBE_COOLDOWN_MAX_SECONDS, fallback: PROBE_COOLDOWN_MS / 1000 });
  // `cooldownMs` is what `integrations.probeCooldown` and the panel's countdown take; the seconds are the unit
  // the operator set and the unit the sentence is written in. Both are returned so no caller re-derives one from the other.
  return {
    timeoutMs: timeout.used, cooldownSeconds: cooldown.used, cooldownMs: cooldown.used * 1000,
    timeoutClamped: timeout.clamped !== null, cooldownClamped: cooldown.clamped !== null,
    clamped: [timeout.clamped, cooldown.clamped].filter(Boolean),
  };
}

module.exports = {
  PROBE_COOLDOWN_MS, PROBE_TIMEOUT_MS, FACT_PROVIDERS, MAX_FACTS_BYTES,
  PROBE_TIMEOUT_MIN_MS, PROBE_TIMEOUT_MAX_MS, PROBE_COOLDOWN_MIN_SECONDS, PROBE_COOLDOWN_MAX_SECONDS,
  probeArgv, probeEnvironment, interpretReceipt, describeProbeFailure, probeBounds,
  factsArgv, interpretFacts, factRejectionReason,
};
