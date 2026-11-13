"use strict";

/**
 * 0.3.11 — the integration state model.
 *
 * The claim under test is not that the fields exist, it is that the four facts stay separate: an operator who is
 * rate limited has not lost their account, a Zotero that is installed and switched off has not become uninstalled,
 * and a record this release cannot read is replaced with a stated sentence rather than a crash or a silent guess.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const integrations = require("../integrations");
// The check window belongs to the probe module. The model's own default has to agree with it, so the test reads
// the published number instead of repeating it: the window can move without the suite going stale.
const { PROBE_COOLDOWN_MS } = require("../integrationprobe");

const AT = "2026-11-08T14:00:00.000Z";
const LATER = "2026-11-08T14:05:00.000Z";
const offers = (view, id) => view.actions.some(([action]) => action === id);

function authorized() {
  return integrations.authorizeSemanticScholar(integrations.emptyRegistry(), { acknowledged: true, at: AT });
}

test("the record keeps four separate facts, and the constants name exactly the values the design allows", () => {
  assert.equal(integrations.SCHEMA_VERSION, 1, "the record format this release writes");
  assert.deepEqual([...integrations.PROVIDERS], ["zotero", "semantic-scholar"], "the Toolkit onboards exactly the two services the packages name");
  assert.ok(Object.isFrozen(integrations.PROVIDERS), "the provider list cannot be extended by a caller at runtime");
  assert.deepEqual(integrations.DIMENSIONS.installation, ["not-detected", "detected", "not-applicable", "unknown"], "installation has the four states DD11-03 names");
  assert.deepEqual(integrations.DIMENSIONS.authorization, ["not-required", "awaiting-consent", "authorized", "revoked"], "authorization has the four states DD11-03 names");
  assert.deepEqual(integrations.DIMENSIONS.readiness, ["unchecked", "ready", "unavailable", "degraded"], "readiness has the four states DD11-03 names");
  assert.deepEqual(integrations.DIMENSIONS.onboarding, ["not-started", "in-progress", "completed", "skipped"], "onboarding has the four states DD11-03 names");
  assert.equal(integrations.LICENSE_REFERENCE, "s2-api-license-2026-11", "the consent record names which licence text was shown, so a later release can tell the operator what they agreed to");
  assert.equal(integrations.LICENSE_URL, "https://api.semanticscholar.org/license/", "the licence the operator is asked to read is a public address");

  const registry = integrations.emptyRegistry();
  assert.equal(registry.updatedAt, null, "a record that has not been saved has no save time");
  assert.equal(registry.lastProbeAt, null, "activation performs no probe (NF11-01), so a fresh record has never probed");
  assert.deepEqual(registry.providers.zotero, { installation: "unknown", authorization: "not-required", readiness: "unchecked", onboarding: "not-started", lastCheck: null, lastSuccessfulCheckAt: null }, "Zotero starts unknown, not guilty: nothing has been looked at yet");
  assert.equal(registry.providers["semantic-scholar"].installation, "not-applicable", "Semantic Scholar is a service, not a program on this machine, so installation is not a question about it");
  assert.equal(registry.providers["semantic-scholar"].authorization, "awaiting-consent", "Semantic Scholar waits for the operator's own confirmation");
  assert.deepEqual(registry.providers["semantic-scholar"].credentials, { storage: "vscode-secret-storage", configured: false }, "the record says where a key would live, and holds no key itself");
});

test("a rate limit degrades readiness and leaves the authorization, the mode and the stored key exactly as they were", () => {
  const before = authorized();
  const after = integrations.recordProbe(before, "semantic-scholar", { outcome: "rate-limited", code: "HTTP_429", detail: "429 Too Many Requests", retryAfter: "31 seconds" }, LATER);
  const entry = after.providers["semantic-scholar"];
  assert.equal(entry.readiness, "degraded", "a 429 is a pause, and `degraded` is the only readiness that says so");
  assert.equal(entry.authorization, "authorized", "a 429 is not a lost account: the operator's decision still stands");
  assert.equal(entry.mode, "anonymous", "a 429 does not change how the Toolkit reaches the service");
  assert.equal(entry.credentials.configured, false, "a 429 does not touch the credential record");
  assert.equal(entry.license.acknowledged, true, "a 429 does not withdraw a confirmation the operator already gave");
  assert.equal(entry.lastSuccessfulCheckAt, null, "a refused request is not a successful check");
  assert.equal(entry.lastCheck.retryAfter, "31 seconds", "the window the service named is kept so the panel can name it too");
  assert.equal(before.providers["semantic-scholar"].readiness, "unchecked", "the record the caller handed in is not modified — the stored record cannot be half-updated by accident");
});

test("a Zotero that is installed and switched off is never reported as not installed, and its guide does not restart", () => {
  let registry = integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "not-running", code: "ZOTERO_NO_ANSWER", installed: true }, AT);
  assert.equal(registry.providers.zotero.installation, "detected", "the Toolkit found Zotero on this machine");
  assert.equal(registry.providers.zotero.readiness, "unavailable", "and it did not answer right now");
  assert.equal(registry.providers.zotero.authorization, "not-required", "reading a local Zotero needs no consent, so there is nothing to re-grant");
  const view = integrations.integrationViews(registry).find((item) => item.id === "zotero");
  assert.equal(view.label, "Configured — Zotero is not answering", "the operator is told the truth: it is there, it is quiet");
  assert.ok(!view.label.toLowerCase().includes("not installed") && !view.detail.toLowerCase().includes("not installed"), "the panel must not send the operator to reinstall software they already have");
  assert.equal(view.nextAction, "Start Zotero, then check again.", "one action, in the operator's words");

  // The case that matters most: a completed guide stays completed when the service merely stops answering.
  registry = integrations.recordProbe(integrations.beginOnboarding(integrations.emptyRegistry(), "zotero", AT), "zotero", { outcome: "ready", installed: true }, AT);
  registry = integrations.recordProbe(registry, "zotero", { outcome: "not-running", installed: true }, LATER);
  assert.equal(registry.providers.zotero.onboarding, "in-progress", "a readiness probe never moves onboarding, so a quiet Zotero does not reopen the guide");
  assert.equal(integrations.recordProbe(registry, "zotero", { outcome: "api-disabled", installed: true }, LATER).providers.zotero.installation, "detected", "a switched-off interface is a setting, not a missing program");
});

test("readRegistry never throws, and it says out loud what it threw away", () => {
  for (const stored of [undefined, null, "", "not json", 42, [], true, {}, { providers: null }, { providers: [] }, { providers: { zotero: "gone" } }]) {
    const result = integrations.readRegistry(stored);
    assert.equal(result.registry.schemaVersion, 1, `an unreadable stored value (${JSON.stringify(stored)}) still yields a record this release can use`);
    assert.equal(result.registry.providers.zotero.readiness, "unchecked", `and it yields a record that claims nothing it did not measure (${JSON.stringify(stored)})`);
    assert.ok(Array.isArray(result.notes), `the discarded value is reported as sentences, not swallowed (${JSON.stringify(stored)})`);
  }
  assert.deepEqual(integrations.readRegistry(undefined).notes, [], "an empty profile has nothing to explain");
  assert.deepEqual(integrations.readRegistry("").notes, [], "an empty string is an empty profile, not a damaged one");

  const damaged = integrations.readRegistry({ schemaVersion: 1, providers: { zotero: { installation: "banana", readiness: "ready" }, "semantic-scholar": { authorization: "authorized", mode: "carrier-pigeon", license: { acknowledged: false } } } });
  assert.equal(damaged.registry.providers.zotero.installation, "unknown", "an unknown installation value resets that field only");
  assert.equal(damaged.registry.providers.zotero.readiness, "ready", "and leaves the field it does understand alone — one bad value does not discard the record");
  assert.equal(damaged.registry.providers["semantic-scholar"].mode, "anonymous", "an access mode this release cannot honour falls back to the one that needs no key");
  assert.equal(damaged.registry.providers["semantic-scholar"].authorization, "awaiting-consent", "a record that claims it is authorized without any licence confirmation is not believed: the Toolkit asks again rather than assume consent");
  assert.equal(damaged.registry.providers["semantic-scholar"].readiness, "unchecked", "and the readiness that arrived with that unverifiable claim goes with it: this release cannot have probed a hosted service it was not allowed to call");
  assert.equal(damaged.notes.length, 3, "each discarded value gets its own sentence, so the operator can see all of them");
  assert.ok(damaged.notes.some((note) => note.includes("Zotero") && note.includes("installation") && note.includes("banana")), "the note names the provider, the dimension and the rejected value");
  assert.ok(damaged.notes.some((note) => note.includes("mode")), "the discarded access mode is named too — nothing is thrown away in silence");
  assert.ok(damaged.notes.some((note) => note.includes("confirmation") && note.includes("readiness")), "the withdrawn claim is explained as a withdrawal, not left as a silent reset");
  assert.ok(damaged.notes.every((note) => !note.includes("{") && !note.includes("\"schemaVersion\"")), "notes are operator sentences, never a dump of the stored JSON");
});

test("a record written by another Toolkit version is replaced, and the operator is told it was", () => {
  const result = integrations.readRegistry({ schemaVersion: 2, updatedAt: AT, providers: { zotero: { readiness: "ready" }, "semantic-scholar": { authorization: "authorized", license: { acknowledged: true } } } });
  assert.equal(result.registry.providers["semantic-scholar"].authorization, "awaiting-consent", "a consent recorded by another release is not carried over as a fact this release can vouch for");
  assert.equal(result.registry.providers.zotero.readiness, "unchecked", "and a readiness measured by another release is not carried over either");
  assert.equal(result.notes.length, 1, "one sentence explains the whole replacement");
  assert.match(result.notes[0], /another Toolkit version/, "the note says who wrote it, so the operator does not hunt for a bug");
  assert.match(result.notes[0], /defaults|nothing was kept/, "the note says what was kept: nothing");
  assert.equal(integrations.readRegistry({ providers: { zotero: {} } }).registry.providers.zotero.onboarding, "not-started", "a record with no format number is treated as unusable, not as a guess");
});

test("the Toolkit refuses to record a consent it did not receive", () => {
  for (const acknowledged of [false, undefined, null, "true", 1, "yes", {}]) {
    assert.throws(() => integrations.authorizeSemanticScholar(integrations.emptyRegistry(), { acknowledged, at: AT }), TypeError, `${JSON.stringify(acknowledged)} is not the operator's own confirmation, so nothing is recorded`);
  }
  assert.throws(() => integrations.authorizeSemanticScholar(integrations.emptyRegistry(), { acknowledged: true, at: AT, mode: "carrier-pigeon" }), TypeError, "an access mode the Toolkit cannot honour is refused before any record is written");
  const registry = integrations.authorizeSemanticScholar(integrations.emptyRegistry(), { acknowledged: true, at: AT });
  assert.equal(registry.providers["semantic-scholar"].authorization, "authorized", "the operator's confirmation is what turns it on");
  assert.equal(registry.providers["semantic-scholar"].license.reference, integrations.LICENSE_REFERENCE, "the record names the licence text that was shown");
  assert.equal(registry.providers["semantic-scholar"].license.acknowledgedAt, AT, "and when it was confirmed");
  assert.equal(registry.updatedAt, AT, "the record carries the time it was saved");
});

test("skipping the guide is not consenting, and revoking keeps the record so the guide is not run twice", () => {
  const skipped = integrations.skipOnboarding(integrations.emptyRegistry(), "semantic-scholar", AT);
  assert.equal(skipped.providers["semantic-scholar"].onboarding, "skipped", "the Toolkit remembers that the operator declined to decide");
  assert.equal(skipped.providers["semantic-scholar"].authorization, "awaiting-consent", "declining the guide is not a licence confirmation, so the service stays off");
  assert.equal(integrations.needsConsent(skipped, "semantic-scholar"), true, "and the Toolkit still has to ask before it can use it");
  assert.equal(integrations.isAuthorized(skipped, "semantic-scholar"), false, "nothing was authorized");

  const revoked = integrations.revokeIntegration(authorized(), "semantic-scholar", LATER);
  assert.equal(revoked.providers["semantic-scholar"].authorization, "revoked", "the operator can turn it off again");
  assert.equal(revoked.providers["semantic-scholar"].license.acknowledged, false, "the confirmation is withdrawn with it");
  assert.equal(revoked.providers["semantic-scholar"].credentials.configured, false, "and the record no longer claims a key is stored");
  assert.equal(revoked.providers["semantic-scholar"].readiness, "unchecked", "a turned-off service is not measured, so no stale verdict survives it");
  assert.equal(revoked.providers["semantic-scholar"].lastSuccessfulCheckAt, null, "the last good check of a turned-off service is not quoted back as a promise");
  assert.equal(revoked.providers["semantic-scholar"].onboarding, "completed", "the guide is still marked done, so re-authorizing does not send the operator through it again");
  assert.equal(integrations.authorizeSemanticScholar(revoked, { acknowledged: true, at: LATER }).providers["semantic-scholar"].onboarding, "completed", "re-authorizing a revoked service does not re-run the guide");
});

test("the panel wording tells the operator the truth in each of the five states that mislead people", () => {
  const now = Date.parse("2026-11-08T15:00:00.000Z");
  const views = (registry) => integrations.integrationViews(registry, { now });

  // 1. Zotero configured earlier, not answering now.
  const quiet = views(integrations.recordProbe(authorized(), "zotero", { outcome: "not-running", installed: true }, AT)).find((item) => item.id === "zotero");
  assert.equal(quiet.label, "Configured — Zotero is not answering", "it is there and quiet, and the panel says exactly that");
  assert.equal(quiet.nextAction, "Start Zotero, then check again.", "the action is the operator's, not a reinstall");

  // 2. Zotero genuinely not found.
  const missing = views(integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "not-installed", installed: false }, AT)).find((item) => item.id === "zotero");
  assert.equal(missing.installation, "not-detected", "the Toolkit found nothing");
  assert.match(missing.nextAction, /official installer/, "the action names the official installer, not a search engine");
  assert.match(missing.nextAction, /zotero\.org/, "and names where the official installer is");
  assert.match(missing.detail, /installed nothing and ran nothing/, "and states plainly that it did nothing on this machine");
  assert.ok(offers(missing, "guideInstall") && offers(missing, "installedNow"), "a missing Zotero is offered the guided path and the operator-initiated re-check");

  // 2b. Zotero installed but refusing local clients (INT-13A.3): the case the operator can fix in ten seconds.
  const refused = views(integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "api-disabled", code: "ZOTERO_API_DISABLED", installed: true }, AT)).find((item) => item.id === "zotero");
  assert.equal(refused.installation, "detected", "the Toolkit found Zotero and says so");
  assert.match(refused.label, /Installed/, "the label starts from the installation it found, not from a guess that it is missing");
  assert.ok(!/not installed|no Zotero was found/i.test(`${refused.label} ${refused.detail}`), "nothing here sends the operator to reinstall software they already have");
  assert.ok(refused.detail.includes(integrations.ZOTERO_LOCAL_API_SETTING), "the sentence names the Zotero setting in the wording the repository's own guide already uses");
  assert.ok(!offers(refused, "guideInstall"), "an installed Zotero is not pitched an installation");
  assert.ok(offers(refused, "apiGuide"), "and it is offered the guidance that names the setting");

  // 3. Semantic Scholar rate limited (INT-14.7).
  const limited = views(integrations.recordProbe(authorized(), "semantic-scholar", { outcome: "rate-limited", code: "HTTP_429", retryAfter: "31 seconds" }, AT)).find((item) => item.id === "semantic-scholar");
  assert.equal(limited.readiness, "degraded", "a pause is its own state");
  assert.ok(limited.detail.includes("31 seconds"), "the panel names the window the check actually carried");
  assert.match(limited.detail, /authorization and your stored key are unchanged/, "and says plainly that nothing about the operator's account changed");
  assert.match(limited.detail, /share one capacity with every other unauthenticated user/, "the anonymous limit is named as a shared global pool, not as the Toolkit's own allowance");
  assert.match(limited.detail, /shares one request budget across Toolkit processes/, "and the shared cross-process budget is stated, which is what a per-process pause cannot promise");
  assert.match(limited.nextAction, /Nothing needs to be authorized again/, "the next step is not re-authorizing");
  assert.ok(!/wait \d|will retry in|retrying in/i.test(limited.detail), "the Toolkit promises no wait it cannot show");
  assert.equal(limited.retryAfter, "31 seconds", "the window is also carried as data, so a later release can act on it");
  const noWindow = views(integrations.recordProbe(authorized(), "semantic-scholar", { outcome: "rate-limited", code: "HTTP_429" }, AT)).find((item) => item.id === "semantic-scholar");
  assert.ok(!noWindow.detail.includes("pause of"), "when the check carried no pause, the sentence names none: the provider documents no wait window");

  // 4. Semantic Scholar awaiting consent.
  const waiting = views(integrations.emptyRegistry()).find((item) => item.id === "semantic-scholar");
  assert.equal(waiting.label, "Requires your confirmation", "the Toolkit says it is waiting for the operator, not that the service is broken");
  assert.equal(waiting.nextAction, "Read both agreements and activate", "and names both official texts, not one licence the operator might mistake for the whole agreement");
  assert.match(waiting.detail, /API Licence and the Dataset License Agreement/, "the card names the two agreements by name");
  assert.equal(waiting.consentRequired, true, "the panel is told consent is required, so it can show the licence text");

  // 5. A saved record that has never been probed in this workspace.
  const saved = views(authorized());
  for (const view of saved) {
    assert.equal(view.readiness, "unchecked", "nothing has been probed in this workspace yet");
    assert.match(view.label, /not checked in this workspace yet/i, "the label says not checked, never not working");
    assert.ok(!/not working|broken|failed/i.test(view.detail), "a record that has simply not been looked at is not described as a fault");
  }
  assert.equal(saved.length, 2, "one entry per provider, in the order the record lists them");
  assert.deepEqual(Object.keys(saved[0]).sort(), ["actions", "authorization", "consentRequired", "credentialConfigured", "detail", "evidence", "id", "installation", "installationFactAt", "installationFactStale", "installationProvenance", "installationSource", "label", "lastCheckAt", "lastOutcome", "lastSuccessfulCheckAt", "mode", "nextAction", "onboarding", "probeBlocked", "probeWaitMs", "readiness", "retryAfter", "serverId", "title", "workerDetail"].sort(), "the panel gets exactly the fields it renders — including what the check actually saw, whose installation fact the card is showing, which actions this record allows and whether the check can run at all — and no secret");
});

test("a probe writes a lastCheck for every outcome, and only a check that reached the service counts as successful", () => {
  let registry = integrations.emptyRegistry();
  for (const outcome of ["ready", "not-installed", "not-running", "api-disabled", "rate-limited", "auth-required", "unreachable"]) {
    registry = integrations.recordProbe(registry, "zotero", { outcome, code: `CODE_${outcome}`, retryAfter: outcome === "rate-limited" ? "12 seconds" : null }, LATER);
    const check = registry.providers.zotero.lastCheck;
    assert.equal(check.at, LATER, `${outcome} is recorded with the time it happened`);
    assert.equal(check.outcome, outcome, `${outcome} is recorded as what the worker said`);
    assert.equal(check.code, `CODE_${outcome}`, `${outcome} keeps the worker's code so a report can quote it`);
  }
  assert.equal(registry.providers.zotero.lastSuccessfulCheckAt, LATER, "the one probe that reached Zotero is remembered even though every probe after it failed");
  registry = integrations.recordProbe(registry, "zotero", { outcome: "ready" }, AT);
  assert.equal(registry.providers.zotero.lastSuccessfulCheckAt, AT, "a check that reached Zotero is remembered as the last good one");
  assert.equal(registry.providers.zotero.lastCheck.detail, null, "a probe with nothing to say does not invent a sentence");
  assert.equal(registry.lastProbeAt, Date.parse(AT), "the record remembers when the last probe ran, as an instant the cooldown can actually compare — an ISO string here would make every window believe no check had ever run");
  const stored = integrations.readRegistry({ schemaVersion: 1, providers: { zotero: { lastCheck: { at: AT } } }, lastProbeAt: registry.lastProbeAt });
  assert.equal(stored.registry.lastProbeAt, Date.parse(AT), "and the instant survives the round trip through the profile store");
  assert.deepEqual(integrations.probeCooldown({ lastProbeAt: stored.registry.lastProbeAt, now: Date.parse(LATER), cooldownMs: PROBE_COOLDOWN_MS }), { allowed: true, waitMs: 0 }, "a check long enough ago may run again");
  assert.equal(integrations.probeCooldown({ lastProbeAt: stored.registry.lastProbeAt, now: Date.parse(AT) + 1, cooldownMs: PROBE_COOLDOWN_MS }).allowed, false, "a check one millisecond ago is refused in every other window of the same profile");
  const legacyText = integrations.readRegistry({ schemaVersion: 1, providers: {}, lastProbeAt: AT });
  assert.equal(legacyText.registry.lastProbeAt, Date.parse(AT), "a record that stored the ISO text is still read as the same instant, so an upgrade does not forget the budget");

  const confused = integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "sideways", detail: "worker said something odd" }, AT);
  assert.equal(confused.providers.zotero.readiness, "unchecked", "an outcome this release does not know is not guessed at — nothing is claimed about readiness");
  assert.match(confused.providers.zotero.lastCheck.detail, /does not understand/, "and the operator is told the worker reported something unrecognised");
  assert.ok(confused.providers.zotero.lastCheck.detail.includes("sideways"), "the unknown outcome itself is quoted, so the fault can be traced");
  assert.ok(confused.providers.zotero.lastCheck.detail.includes("worker said something odd"), "the worker's own words survive into the record");

  const withKey = integrations.setCredentialConfigured(authorized(), "semantic-scholar", true, AT);
  assert.equal(integrations.recordProbe(withKey, "semantic-scholar", { outcome: "auth-required" }, LATER).providers["semantic-scholar"].readiness, "degraded", "a key is stored, so an unauthenticated refusal is a problem to fix, not a service that has gone away");
  assert.equal(integrations.recordProbe(authorized(), "semantic-scholar", { outcome: "auth-required" }, LATER).providers["semantic-scholar"].readiness, "unavailable", "with no key stored, the same refusal means the anonymous route did not answer");
});

test("one probe per window is allowed, and the second probe in the same window is refused", () => {
  const first = integrations.probeCooldown({ lastProbeAt: null, now: 1_000, cooldownMs: PROBE_COOLDOWN_MS });
  assert.deepEqual(first, { allowed: true, waitMs: 0 }, "a profile that has never probed may probe now");
  const second = integrations.probeCooldown({ lastProbeAt: 1_000, now: 1_001, cooldownMs: PROBE_COOLDOWN_MS });
  assert.equal(second.allowed, false, "a probe inside the window is refused: the probe starts a worker and reaches a live service");
  assert.equal(second.waitMs, PROBE_COOLDOWN_MS - 1, "and the operator is told how long is left, not how old the last check was");
  assert.deepEqual(integrations.probeCooldown({ lastProbeAt: 1_000, now: 1_000 + PROBE_COOLDOWN_MS, cooldownMs: PROBE_COOLDOWN_MS }), { allowed: true, waitMs: 0 }, "one window later a probe is allowed");
  assert.deepEqual(integrations.probeCooldown({ lastProbeAt: 1_000, now: 1_000 + PROBE_COOLDOWN_MS }), { allowed: true, waitMs: 0 }, "the model's own default is the window the probe module publishes, read from the module rather than repeated as a number, so the two cannot drift apart");
  assert.equal(integrations.probeCooldown({ lastProbeAt: 1_000, now: 1_001 }).waitMs, PROBE_COOLDOWN_MS - 1, "and the default is exactly that window, whatever number the probe module carries today");
});

test("the panel renderer only asks the state model for fields the state model actually sends", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "media", "controls.js"), "utf8");
  const sent = new Set(integrations.integrationViews(integrations.emptyRegistry(), { now: "2026-11-08T12:00:00.000Z" }).flatMap((view) => Object.keys(view)));
  const asked = new Set([...renderer.matchAll(/\bview\.([A-Za-z][A-Za-z0-9]*)/g)].map((match) => match[1]));
  // No exception is documented any more: the card used to accept a `title` the model did not send and fall back to
  // the provider id, which is how "zotero" reached the operator. The model sends it now. A second exception means
  // the panel is reading a field that does not exist and getting `undefined` without anyone noticing: 0.3.11
  // shipped `view.authorized`, which the model never sends, so the "Turn off" button never appeared and
  // "Add API key" was always marked unavailable.
  const documented = new Set();
  for (const field of [...asked].sort()) {
    assert.ok(sent.has(field) || documented.has(field), `media/controls.js reads view.${field}, which integrations.integrationViews never sends — whatever is built from it is built from undefined.`);
  }
  assert.ok(asked.has("authorization"), "the card reads the authorization dimension itself, not a boolean the model does not provide");
  assert.ok(asked.has("actions"), "and it renders the action list the model computed rather than deciding which buttons to show");
  // The same defect seen from the other side: an action the model offers but the card has no entry for is an offer
  // that silently never appears.
  const states = [
    integrations.emptyRegistry(),
    integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "not-installed", installed: false }, AT),
    integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "api-disabled", installed: true }, AT),
    integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "ready", installed: true }, AT),
    authorized(),
    integrations.setCredentialConfigured(authorized(), "semantic-scholar", true, AT),
    integrations.revokeIntegration(authorized(), "semantic-scholar", AT),
  ];
  const offered = new Set(states.flatMap((registry) => integrations.integrationViews(registry, { now: Date.parse(AT) }).flatMap((view) => view.actions.map(([id]) => id))));
  assert.ok(offered.size >= 12, `the states above reach most of the action vocabulary, not ${offered.size} of it`);
  for (const id of [...offered].sort()) {
    assert.ok(new RegExp(`\\n\\s+${id}: \\[`).test(renderer), `the state model offers "${id}" but media/controls.js has no card entry for it, so the offer would vanish without anyone noticing.`);
  }
});

test("the key step records the operator's choice and nothing the operator did not give (INT-14.1)", () => {
  const fresh = integrations.emptyRegistry();
  const asked = integrations.recordKeyDecision(fresh, "semantic-scholar", "guided", AT);
  assert.equal(asked.providers["semantic-scholar"].keyDecision, "guided", "asking how to get a key is recorded as asking, which is exactly what happened");
  assert.equal(asked.providers["semantic-scholar"].authorization, "awaiting-consent", "and it authorizes nothing");
  assert.equal(asked.providers["semantic-scholar"].license.acknowledged, false, "it records no consent");
  assert.equal(asked.providers["semantic-scholar"].credentials.configured, false, "it records no key");
  assert.equal(asked.providers["semantic-scholar"].onboarding, "not-started", "it does not finish the walkthrough");
  const declined = integrations.recordKeyDecision(fresh, "semantic-scholar", "declined", AT);
  assert.equal(declined.providers["semantic-scholar"].keyDecision, "declined", "declining a key is its own outcome, not a silent default");
  assert.equal(declined.providers["semantic-scholar"].onboarding, "not-started", "a declined step is not a completed walkthrough");
  assert.equal(declined.providers["semantic-scholar"].credentials.configured, false, "and nothing about a key was recorded");
  assert.throws(() => integrations.recordKeyDecision(fresh, "zotero", "declined", AT), TypeError, "Zotero local reading has no key to decide about, so the record is refused");
  assert.throws(() => integrations.recordKeyDecision(fresh, "semantic-scholar", "consented", AT), TypeError, "a decision this release does not record is refused rather than stored");
  assert.equal(integrations.readRegistry({ schemaVersion: 1, providers: { "semantic-scholar": { keyDecision: "declined" } } }).registry.providers["semantic-scholar"].keyDecision, "declined", "the decision survives a restart, so the same guide run twice does not re-ask (NF12-05)");
  const damaged = integrations.readRegistry({ schemaVersion: 1, providers: { "semantic-scholar": { keyDecision: "granted" } } });
  assert.equal(damaged.registry.providers["semantic-scholar"].keyDecision, "not-offered", "a key decision this release cannot honour falls back to nothing having been offered");
  assert.equal(damaged.notes.length, 1, "and the fallback is said out loud");
});

test("the offered actions follow the record, so one state cannot offer two different things (T12-14, T12-22)", () => {
  const scholar = (registry) => integrations.integrationViews(registry, { now: Date.parse(AT) }).find((item) => item.id === "semantic-scholar");
  const zotero = (registry) => integrations.integrationViews(registry, { now: Date.parse(AT) }).find((item) => item.id === "zotero");
  const fresh = scholar(integrations.emptyRegistry());
  assert.ok(offers(fresh, "requestKey") && offers(fresh, "noKey"), "with no key the operator is offered the guided request and the anonymous route");
  assert.ok(!offers(fresh, "provideKey"), "and no key box before the integration is authorized, because the Toolkit would refuse to store a key for it");
  assert.ok(!offers(fresh, "testKey") && !offers(fresh, "replaceKey"), "nothing is offered for a key that is not there");
  const keyed = scholar(integrations.setCredentialConfigured(authorized(), "semantic-scholar", true, AT));
  assert.deepEqual(keyed.actions.filter(([id]) => ["requestKey", "noKey", "provideKey"].includes(id)), [], "with a key stored, the guided key request is not offered again");
  assert.ok(offers(keyed, "replaceKey") && offers(keyed, "removeKey") && offers(keyed, "testKey"), "and replace, remove and test are offered instead");
  const quiet = zotero(integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "ready", installed: true }, AT));
  assert.ok(!offers(quiet, "guideInstall") && !offers(quiet, "installedNow"), "a Zotero that answered is not offered an installation (T12-22)");
  assert.ok(!offers(quiet, "apiGuide"), "and it is not offered a setting it never refused");
  assert.equal(offers(zotero(integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "not-running", installed: true }, AT)), "guideInstall"), false, "installed but quiet is a start-Zotero case, not a reinstall case");
});

// --- INT-15 (DD12-02): the machine-level installation fact -------------------------------------

const DETECTED_AT = Date.parse("2026-11-08T10:00:00.000Z");
const STALE_AT = Date.parse("2026-10-30T10:00:00.000Z");
const fact = (overrides = {}) => ({ found: true, classification: "ready", platform: "linux", detectedAtMs: DETECTED_AT, code: null, ...overrides });
const applied = (overrides = {}, at = AT) => integrations.applyMachineFact(integrations.emptyRegistry(), "zotero", fact(overrides), at);
const zoteroView = (registry, now = Date.parse(AT)) => integrations.integrationViews(registry, { now }).find((item) => item.id === "zotero");

test("a machine-level installation fact moves `installation` and nothing else (T12-33, T12-34)", () => {
  const entry = applied().providers.zotero;
  assert.equal(entry.installation, "detected", "the installation question is answered by the fact, which is the whole of INT-15.2");
  assert.equal(entry.installationSource, "machine-fact", "and the record says where the answer came from, so it cannot later read as this profile's own verdict");
  assert.equal(entry.installationFactAt, new Date(DETECTED_AT).toISOString(), "the record carries the moment the other window took the fact");
  assert.equal(entry.installationFactPlatform, "linux", "and the platform it was taken on");
  assert.equal(entry.authorization, "not-required", "reading a local Zotero needs no consent, and a fact about a machine grants none");
  assert.equal(entry.readiness, "unchecked", "the fact says Zotero was found, not that it answered: readiness stays unmeasured in this profile");
  assert.equal(entry.onboarding, "not-started", "a fact this profile never went through does not finish this profile's guide");
  assert.equal(entry.lastCheck, null, "a machine fact is not a check, so no check is recorded");
  const scholar = applied().providers["semantic-scholar"];
  assert.equal(scholar.authorization, "awaiting-consent", "the other integration inherits nothing from a Zotero fact");
  assert.equal(scholar.credentials.configured, false, "no key is invented for it");
  assert.equal(scholar.mode, "anonymous", "no access mode is inherited");
  assert.equal(scholar.license.acknowledged, false, "no consent is inherited");
  const smuggled = integrations.applyMachineFact(integrations.emptyRegistry(), "zotero", { ...fact(), authorization: "authorized", mode: "api-key", credentials: { configured: true }, license: { acknowledged: true }, onboarding: "completed" }, AT);
  assert.equal(smuggled.providers.zotero.onboarding, "not-started", "a field on the fact that is not an installation fact is ignored, not applied");
  assert.equal(smuggled.providers["semantic-scholar"].credentials.configured, false, "and it reaches the other integration no more than the honest fields do");
});

test("a machine fact this release cannot honour is refused with the reason, and the record is left exactly as it was", () => {
  const before = integrations.emptyRegistry();
  const refused = [
    [null, /not a record/],
    ["ready", /not a record/],
    [{ ...fact(), classification: "sideways" }, /sideways.*not an installation answer this release can read/],
    [{ ...fact(), found: "yes" }, /whether Zotero was found, as yes or no/],
    [{ ...fact(), found: false }, /contradict each other/],
    [{ ...fact(), classification: "not-installed", found: true }, /contradict each other/],
    [{ ...fact(), platform: "" }, /names the platform/],
    [{ ...fact(), platform: 7 }, /names the platform/],
    [{ ...fact(), platform: "x".repeat(60) }, /names the platform/],
    [{ ...fact(), detectedAtMs: undefined }, /carries the moment/],
    [{ ...fact(), detectedAtMs: 0 }, /carries the moment/],
    [{ ...fact(), detectedAtMs: 1.5 }, /carries the moment/],
    [{ ...fact(), detectedAtMs: Date.parse(LATER) + 1000 }, /later than this window asked for it/],
  ];
  for (const [value, reason] of refused) {
    assert.throws(() => integrations.applyMachineFact(before, "zotero", value, AT), (error) => {
      assert.ok(error instanceof TypeError, `${JSON.stringify(value)} is refused as a mistake to report, not stored as a fact`);
      assert.match(error.message, reason, `${JSON.stringify(value)} comes with the reason the operator can act on`);
      assert.match(error.message, /applied|used/, "and the refusal says plainly that nothing was changed");
      return true;
    }, JSON.stringify(value));
  }
  assert.deepEqual(before, integrations.emptyRegistry(), "a refusal leaves the record the caller handed in untouched");
  assert.throws(() => integrations.applyMachineFact(before, "semantic-scholar", fact(), AT), TypeError, "Semantic Scholar is a hosted service: it has no installation on this machine, so there is no fact to apply");
  assert.throws(() => integrations.applyMachineFact(before, "openalex", fact(), AT), TypeError, "a provider this release does not have is refused before anything is written");
});

test("the freshness window is stated, and a stale fact pre-fills the panel without suppressing the check (T12-36)", () => {
  assert.equal(integrations.MACHINE_FACT_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000, "the Toolkit's own stated interval: installing or removing an application is an act a person does, so a week is the span in which \"I installed Zotero last week\" is still a true answer");
  assert.equal(integrations.MACHINE_FACT_DAYS, 7, "the interval the card quotes is the interval the model applies, not a second number that can drift from it");
  const fresh = zoteroView(applied({ detectedAtMs: DETECTED_AT }));
  assert.equal(fresh.installation, "detected", "a fresh fact pre-fills the panel");
  assert.equal(fresh.installationFactStale, false, "and it is inside the window");
  assert.ok(!fresh.installationProvenance.includes("7-day"), "nothing about freshness is claimed when the fact is current");
  const old = zoteroView(applied({ detectedAtMs: STALE_AT }));
  assert.equal(old.installation, "detected", "a stale fact still pre-fills the panel — DD12-02 says so, and this test is the reason it is safe");
  assert.equal(old.installationFactStale, true, "and the model knows it is outside the window");
  assert.match(old.installationProvenance, /older than the Toolkit's 7-day window/, "the card says the fact is about a moment, not about now");
  assert.equal(old.installationFactAt, new Date(STALE_AT).toISOString(), "and names the moment it was taken, so the operator can judge it");
  assert.ok(offers(old, "check"), "the check is still offered: a stale fact does not suppress it");
  assert.ok(offers(old, "machineFact"), "and the machine record may be asked for again");
  assert.equal(old.nextAction, "Check integrations to see whether Zotero's local API answers.", "the next step is the check, not a reinstall and not a re-authorization");
});

test("the card says whose installation fact it is, and never lets a machine fact read as this profile's own check (INT-15.4)", () => {
  const machine = zoteroView(applied());
  assert.equal(machine.installationSource, "machine-fact");
  assert.match(machine.installationProvenance, /Installation found by another window of the same OS user on linux\./, "the sentence names the other window and the platform, not a check");
  assert.match(machine.installationProvenance, /This profile has not checked it\./, "and says plainly that this profile did not measure it");
  assert.match(machine.label, /^Found on this machine — not checked in this profile$/, "the label carries the same distinction, so the card cannot show a machine fact as a verdict");
  assert.match(machine.detail, /Nothing else was inherited/, "and the detail names what the fact did not bring across");
  assert.ok(!/this profile ran/.test(machine.installationProvenance), "nothing here claims this profile measured anything");
  assert.ok(offers(machine, "check") && !offers(machine, "guideInstall") && !offers(machine, "installedNow"), "T12-33: the installation question is not asked of a profile the machine already answered");

  const checked = zoteroView(integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "ready", code: "OK", installed: true }, AT));
  assert.equal(checked.installationSource, "profile-check", "a check this window ran is its own source, stated as such");
  assert.equal(checked.installationProvenance, "Installation recorded by a check this profile ran.");
  assert.equal(checked.installationFactAt, null, "the machine record's time is not quoted beside a provenance that is not the machine's");

  const outvoted = integrations.applyMachineFact(integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "not-installed", code: "ZOTERO_NOT_AVAILABLE", installed: false }, LATER), "zotero", fact({ detectedAtMs: DETECTED_AT }), LATER);
  assert.equal(outvoted.providers.zotero.installation, "not-detected", "a check this profile ran at 14:05 is not overruled by a machine fact taken at 10:00");
  assert.equal(outvoted.providers.zotero.installationSource, "profile-check", "and the provenance stays the check's");

  const unclear = zoteroView(applied({ found: false, classification: "unknown", code: "ZOTERO_UNKNOWN" }));
  assert.equal(unclear.installation, "unknown", "`unknown` names no installation state, so it sets none: DD12-02 forbids the guess");
  assert.equal(unclear.installationSource, null, "and it claims no source for a value it did not set");
  assert.match(unclear.installationProvenance, /looked for Zotero on this machine and could not tell what it found/, "the operator is still told that another window looked");
  assert.equal(unclear.label, "Not checked in this workspace yet", "and the card invents no state the fact did not name");

  const missing = zoteroView(applied({ found: false, classification: "not-installed", code: "ZOTERO_NOT_AVAILABLE" }));
  assert.equal(missing.installation, "not-detected", "a machine fact that found nothing pre-fills the other answer");
  assert.match(missing.label, /^Not found on this machine — not checked in this profile$/);
  assert.ok(offers(missing, "guideInstall") && offers(missing, "installedNow"), "and the guided offer behaves exactly as it does today when nothing was found");
  assert.match(missing.detail, /installed nothing and ran nothing/, "with the same statement about what the Toolkit did not do");

  const reset = integrations.resetIntegration(applied(), "zotero", LATER);
  assert.equal(reset.providers.zotero.installation, "unknown", "reset clears the pre-fill too: a profile that resets an integration starts from nothing again");
  assert.equal(reset.providers.zotero.installationSource, undefined, "and it keeps no claim about where the installation came from");

  const scholar = integrations.integrationViews(integrations.emptyRegistry(), { now: Date.parse(AT) }).find((item) => item.id === "semantic-scholar");
  assert.ok(!offers(scholar, "machineFact"), "Semantic Scholar is never offered a machine installation fact: a hosted API has nothing on this machine to install");
});

test("the installation provenance survives the profile store, and a source this release cannot name is dropped out loud", () => {
  const stored = integrations.readRegistry({ schemaVersion: 1, providers: { zotero: { installation: "detected", installationSource: "machine-fact", installationFactAt: "2026-11-08T10:00:00.000Z", installationFactPlatform: "linux" } } });
  assert.equal(stored.registry.providers.zotero.installationSource, "machine-fact", "a restart does not turn another window's fact into this profile's own verdict");
  assert.equal(stored.registry.providers.zotero.installationFactAt, "2026-11-08T10:00:00.000Z", "and the moment it was taken survives the round trip, so the card can still name it");
  assert.equal(stored.registry.providers.zotero.installationFactPlatform, "linux");
  assert.deepEqual(stored.notes, [], "a record this release understands needs no explanation");
  const damaged = integrations.readRegistry({ schemaVersion: 1, providers: { zotero: { installation: "detected", installationSource: "a-hunch", installationFactAt: "last tuesday", installationFactPlatform: 9 } } });
  assert.equal(damaged.registry.providers.zotero.installation, "detected", "the installation it can still vouch for is kept");
  assert.equal(damaged.registry.providers.zotero.installationSource, undefined, "the source it cannot vouch for is dropped rather than repeated");
  assert.equal(damaged.registry.providers.zotero.installationFactAt, undefined, "and so is a detection time it cannot read as a moment");
  assert.equal(damaged.registry.providers.zotero.installationFactPlatform, undefined, "and so is a platform that is not text");
  assert.equal(damaged.notes.length, 1, "the one drop is said out loud");
  assert.match(damaged.notes[0], /cannot vouch for/);
  assert.ok(!damaged.notes[0].includes("last tuesday"), "the note names the source it rejected, not the values it also threw away");
});

// --- Defect round on the shipped 0.3.11 model: a stale machine fact, an offer that outlived its purpose,
// and a check the workspace may not be able to run at all. --------------------------------------------

test("a stale machine installation fact no longer suppresses the guided installation (M1)", () => {
  const stale = zoteroView(applied({ detectedAtMs: STALE_AT }));
  assert.equal(stale.installation, "detected", "the stored fact is kept: a stale fact is still evidence about the moment it was taken");
  assert.equal(stale.installationSource, "machine-fact", "and it is still named as another window's fact");
  assert.equal(stale.installationFactStale, true, "the model knows it is past the window");
  assert.ok(offers(stale, "guideInstall"), "so the guided installation is offered again");
  assert.ok(offers(stale, "installedNow"), "and so is the operator's own re-check");
  assert.match(stale.detail, /older than the Toolkit's 7-day window/, "the card says plainly that the confirmation is old, so the offer is not read as a claim that Zotero is missing");
  assert.match(stale.installationProvenance, /older than the Toolkit's 7-day window/, "and the installation line still says it");
  assert.equal(applied({ detectedAtMs: STALE_AT }).providers.zotero.installationFactAt, new Date(STALE_AT).toISOString(), "nothing is deleted from the record to make the offer come back");

  const fresh = zoteroView(applied({ detectedAtMs: DETECTED_AT }));
  assert.ok(!offers(fresh, "guideInstall") && !offers(fresh, "installedNow"), "inside the window the machine's answer still stands (T12-33)");

  const ownCheck = zoteroView(integrations.recordProbe(applied({ detectedAtMs: STALE_AT }), "zotero", { outcome: "ready", code: "OK", installed: true }, AT));
  assert.equal(ownCheck.installationSource, "profile-check", "this profile measured the installation itself");
  assert.ok(!offers(ownCheck, "guideInstall") && !offers(ownCheck, "installedNow"), "an old machine record does not reopen the installation question after this profile found Zotero");

  const missing = zoteroView(applied({ found: false, classification: "not-installed", code: "ZOTERO_NOT_AVAILABLE", detectedAtMs: STALE_AT }));
  assert.ok(offers(missing, "guideInstall") && offers(missing, "installedNow"), "a stale fact that found nothing behaves as it always did");
});

test("the Zotero card stops offering Activate once there is nothing left to activate (M2)", () => {
  assert.ok(offers(zoteroView(integrations.emptyRegistry()), "activate"), "a profile that has never been through the guide is offered it");
  assert.ok(offers(zoteroView(integrations.beginOnboarding(integrations.emptyRegistry(), "zotero", AT)), "activate"), "a guide left half-way is offered again");
  assert.ok(!offers(zoteroView(integrations.skipOnboarding(integrations.emptyRegistry(), "zotero", AT)), "activate"), "an operator who closed the guide is not pitched it again");
  const ready = zoteroView(integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "ready", code: "OK", installed: true }, AT));
  assert.ok(!offers(ready, "activate"), "a Zotero that answered is ready: pressing Activate would re-open the modal and spend the shared 30-second check budget on the button the operator did not mean to press");
  assert.ok(offers(ready, "check"), "and the button they meant to press is still offered");
  assert.ok(offers(zoteroView(integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "not-running", code: "ZOTERO_NO_ANSWER", installed: true }, AT)), "activate"), "a Zotero that is there but quiet still has its guide open");
  const scholar = (registry) => integrations.integrationViews(registry, { now: Date.parse(AT) }).find((item) => item.id === "semantic-scholar");
  assert.ok(offers(scholar(integrations.emptyRegistry()), "activate"), "Semantic Scholar is unchanged: Activate is its consent step");
  assert.ok(offers(scholar(integrations.skipOnboarding(integrations.emptyRegistry(), "semantic-scholar", AT)), "activate"), "and closing its guide does not answer for the operator — the consent is still owed");
  assert.ok(!offers(scholar(authorized()), "activate"), "an authorized Semantic Scholar is not offered it again");
  assert.ok(offers(scholar(integrations.revokeIntegration(authorized(), "semantic-scholar", AT)), "activate"), "a turned-off service is offered it again");
});

test("the model says whether a check can run here at all, and how long the shared budget still has to wait (M6)", () => {
  const at = Date.parse(AT);
  const noWorker = integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "not-installed", code: "ZOTERO_NOT_AVAILABLE", installed: false }, AT);
  const blocked = integrations.integrationViews(noWorker, { now: at, canProbe: false });
  for (const view of blocked) {
    assert.equal(typeof view.probeBlocked, "string", `${view.id}: the reason is a sentence an operator can read`);
    assert.ok(view.probeBlocked.length > 40, "and not a code or a single word");
    assert.match(view.probeBlocked, /locked worker/, "it names what the check needs");
    assert.match(view.probeBlocked, /trusted local workspace/, "and the kind of workspace it needs");
  }
  const zoteroBlocked = blocked.find((view) => view.id === "zotero");
  assert.ok(offers(zoteroBlocked, "check") && offers(zoteroBlocked, "installedNow"), "the actions stay offered: the operator has to see what is unavailable, and why");
  const open = integrations.integrationViews(noWorker, { now: at, canProbe: true });
  assert.deepEqual(open.map((view) => view.probeBlocked), [null, null], "with the check available nothing is blocked");
  assert.deepEqual(integrations.integrationViews(noWorker, { now: at }), open, "a caller that says nothing about the worker gets exactly what it got before this field existed");
  assert.deepEqual(integrations.integrationViews(noWorker), integrations.integrationViews(noWorker, { canProbe: true }), "and the same with no clock handed in");

  assert.deepEqual(integrations.integrationViews(integrations.emptyRegistry(), { now: at }).map((view) => view.probeWaitMs), [0, 0], "a profile that has never checked has nothing to wait for");
  const justChecked = integrations.recordProbe(integrations.emptyRegistry(), "zotero", { outcome: "ready", code: "OK", installed: true }, AT);
  const remaining = integrations.probeCooldown({ lastProbeAt: justChecked.lastProbeAt, now: at + 1_000 }).waitMs;
  assert.ok(remaining > 0, "one second after a check the shared window has not passed");
  assert.deepEqual(integrations.integrationViews(justChecked, { now: at + 1_000 }).map((view) => view.probeWaitMs), [remaining, remaining], "immediately after a check both cards name the remaining wait the cooldown helper itself computes — one budget, one number, because one press checks both services");
  assert.deepEqual(integrations.integrationViews(justChecked, { now: Date.parse(LATER) }).map((view) => view.probeWaitMs), [0, 0], "five minutes on, the budget has refreshed");
  assert.deepEqual(integrations.integrationViews(justChecked).map((view) => view.probeWaitMs), [0, 0], "a view built with no clock reports no wait rather than reading a clock this module does not own");
});

test("the panel accepts a result only for a request it asked for, bounds its pending ids, and never prints the word undefined (M3, M4, M5, M6)", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const renderer = fs.readFileSync(path.join(__dirname, "..", "media", "controls.js"), "utf8");
  assert.ok(!/pendingRequests\.size\s*&&/.test(renderer), "an empty pending set must not accept any request id: a re-rendered panel starts with an empty set while the host is still finishing the previous action, and its late result would be painted onto the fresh panel as the answer to a press that never happened");
  assert.match(renderer, /if \(!pendingRequests\.has\(message\.requestId\)\) return;/, "a result is accepted only when this panel asked for that id");
  assert.match(renderer, /if \(message\.requestId !== undefined\) \{[\s\S]{0,200}?pendingRequests\.has\(message\.requestId\)/, "the id guard is its own branch, so a message with no id is handled as the host's own statement rather than falling through the guard");
  assert.match(renderer, /const PENDING_REQUEST_LIMIT = \d+;/, "the pending ids are bounded: a request whose result never arrives would otherwise stay in the set for the life of the window");
  assert.match(renderer, /pendingRequests\.delete\(pendingRequests\.values\(\)\.next\(\)\.value\)/, "the oldest id is the one dropped, and nothing polls or waits to do it (NF12-04)");
  assert.ok(!/setTimeout|setInterval|requestAnimationFrame/.test(renderer), "the bound is a bound, not a timer");
  assert.match(renderer, /message\.error \|\| message\.message \|\| "/, "the status line falls back to a sentence: the textContent setter turns undefined into the word \"undefined\" inside a live region");
  assert.match(renderer, /const startsACheck = id === "check" \|\| id === "installedNow";/, "exactly the two actions that start a check are the ones qualified");
  assert.match(renderer, /if \(startsACheck && blocked\) markUnavailable\(button, `\$\{blocked\}\$\{waitText\}`\)/, "a check this workspace cannot run is rendered as an explained unavailable button, not as one that answers a Zotero question with an error about package components");
  assert.match(renderer, /button\.title = `\$\{spec\[0\]\}\$\{waitText\}`/, "the remaining whole seconds are in the tooltip before the press");
});
