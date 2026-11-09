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

const PROBE_COOLDOWN_MS = 30_000;
const PROBE_TIMEOUT_MS = 20_000;
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

/** Only what the worker needs: a key travels with the mode that asked for it, a licence flag with a recorded consent. */
function probeEnvironment({ registry, apiKey } = {}) {
  const entry = registry?.providers?.["semantic-scholar"];
  if (!entry || !integrations.isAuthorized(registry, "semantic-scholar")) return {};
  const env = { SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED: "true" };
  if (entry.mode === "api-key" && typeof apiKey === "string" && apiKey.length) env.SEMANTIC_SCHOLAR_API_KEY = apiKey;
  return env;
}

// An outcome this release does not know is reported as unreachable, but the worker's own code and detail are kept so
// the operator sees what the worker said instead of guessing from a generic failure. `serverId` and `evidence` are kept
// for the same reason: they are how the panel says *which* Zotero answered and *where* an installation was found.
// Both are clipped to a short string, because they come from a worker and are shown to a person.
const clipped = (value) => typeof value === "string" && value.length ? value.slice(0, 120) : null;

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

module.exports = {
  PROBE_COOLDOWN_MS, PROBE_TIMEOUT_MS, FACT_PROVIDERS, MAX_FACTS_BYTES,
  probeArgv, probeEnvironment, interpretReceipt, describeProbeFailure,
  factsArgv, interpretFacts, factRejectionReason,
};
