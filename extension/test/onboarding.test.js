"use strict";

/**
 * 0.3.11 — the one-time onboarding flow.
 *
 * The flow is the product: the Toolkit asks once per VS Code profile, remembers the answer in every later workspace,
 * and never asks for a decision it already has. These tests walk the flow in order — ask, decide, probe, revoke,
 * decide again — and finish by putting the record through the editor's own storage to prove the flow survives a
 * restart without carrying a secret with it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const integrations = require("../integrations");
const store = require("../integrationstore");
const { makeHarness } = require("./harness");

const AT = "2026-11-08T14:00:00.000Z";
const LATER = "2026-11-08T14:10:00.000Z";

test("a fresh profile needs a decision for Semantic Scholar and needs none for Zotero", () => {
  const registry = integrations.emptyRegistry();
  assert.equal(integrations.needsConsent(registry, "semantic-scholar"), true, "Semantic Scholar is off until the operator has read and confirmed its API licence");
  assert.equal(integrations.needsConsent(registry, "zotero"), false, "reading a local Zotero over loopback needs no Toolkit-side consent, so the Toolkit does not ask for one it cannot mean");
  assert.equal(integrations.isAuthorized(registry, "semantic-scholar"), false, "nothing is authorized before the operator decides");
  assert.equal(integrations.isAuthorized(registry, "zotero"), false, "and Zotero is not 'authorized' either — its authorization is `not-required`, which is a different fact");
  assert.equal(registry.providers.zotero.authorization, "not-required", "the record says plainly that no consent is needed here");

  const started = integrations.beginOnboarding(registry, "semantic-scholar", AT);
  assert.equal(started.providers["semantic-scholar"].onboarding, "in-progress", "the guide is recorded as started, so a second window does not open a second guide");
  assert.equal(started.providers["semantic-scholar"].authorization, "awaiting-consent", "opening the guide is not the same as agreeing to anything");
});

test("authorizing records the licence reference and the time, and the panel stops asking", () => {
  const registry = integrations.authorizeSemanticScholar(integrations.beginOnboarding(integrations.emptyRegistry(), "semantic-scholar", AT), { acknowledged: true, at: AT });
  const entry = registry.providers["semantic-scholar"];
  assert.equal(entry.authorization, "authorized", "the operator's confirmation is what turns the service on");
  assert.equal(entry.onboarding, "completed", "and it closes the guide in the same act, because the confirmation is the guide's only decision");
  assert.equal(entry.license.acknowledged, true, "the consent is recorded as a fact with a date, not as a checkbox that vanishes");
  assert.equal(entry.license.reference, integrations.LICENSE_REFERENCE, "the record names which licence text was shown, so a later release can tell the operator what they agreed to");
  assert.equal(entry.license.acknowledgedAt, AT, "and when they agreed to it");
  assert.equal(entry.mode, "anonymous", "authorizing does not quietly start using a key: the key stays optional (INT-04)");
  assert.equal(integrations.needsConsent(registry, "semantic-scholar"), false, "the Toolkit will not ask this profile again");
  assert.equal(registry.updatedAt, AT, "the record carries the time it was saved, so the panel can call it saved rather than live");
  assert.equal(integrations.emptyRegistry().providers["semantic-scholar"].authorization, "awaiting-consent", "authorizing one record does not alter the template the next profile starts from");
});

test("a probe receipt moves readiness only, and never the authorization or the consent", () => {
  let registry = integrations.authorizeSemanticScholar(integrations.emptyRegistry(), { acknowledged: true, at: AT });
  registry = integrations.setCredentialConfigured(registry, "semantic-scholar", true, AT);
  for (const outcome of ["ready", "unreachable", "rate-limited", "auth-required", "not-installed"]) {
    registry = integrations.recordProbe(registry, "semantic-scholar", { outcome, code: `CODE_${outcome}`, retryAfter: outcome === "rate-limited" ? "30 seconds" : null }, LATER);
    const entry = registry.providers["semantic-scholar"];
    assert.equal(entry.authorization, "authorized", `a ${outcome} probe does not take the operator's decision away`);
    assert.equal(entry.license.acknowledged, true, `a ${outcome} probe does not withdraw a confirmation`);
    assert.equal(entry.credentials.configured, true, `a ${outcome} probe does not claim a stored key has gone`);
    assert.equal(entry.onboarding, "completed", `a ${outcome} probe does not reopen the guide`);
    assert.equal(integrations.needsConsent(registry, "semantic-scholar"), false, `after a ${outcome} probe the Toolkit still does not need to ask again`);
  }
  assert.equal(registry.providers["semantic-scholar"].readiness, "unavailable", "the last word is the last probe's, and it is about readiness alone");
  assert.equal(registry.providers["semantic-scholar"].installation, "not-applicable", "a probe never claims a service is or is not installed on this machine");
  registry = integrations.recordProbe(registry, "semantic-scholar", { outcome: "ready", installed: true }, LATER);
  assert.equal(registry.providers["semantic-scholar"].installation, "not-applicable", "not even a receipt that says installed: Semantic Scholar is a hosted API, and the panel must not offer to install it");
  assert.equal(registry.providers["semantic-scholar"].readiness, "ready", "the readiness verdict still lands, and it is the only thing that moved");
});

test("revoking and re-authorizing does not send the operator through the guide a second time", () => {
  const authorized = integrations.authorizeSemanticScholar(integrations.emptyRegistry(), { acknowledged: true, at: AT });
  const revoked = integrations.revokeIntegration(authorized, "semantic-scholar", LATER);
  assert.equal(revoked.providers["semantic-scholar"].authorization, "revoked", "the operator can turn the service off from the same panel that turned it on");
  assert.equal(revoked.providers["semantic-scholar"].onboarding, "completed", "the record survives, so the guide is not re-run (DD11-11)");
  assert.equal(integrations.needsConsent(revoked, "semantic-scholar"), true, "turning it off withdraws the confirmation, so switching it on again asks once more — the Toolkit never reuses an old agreement for a new decision");
  const again = integrations.authorizeSemanticScholar(revoked, { acknowledged: true, at: LATER });
  assert.equal(again.providers["semantic-scholar"].onboarding, "completed", "re-authorizing lands in the same completed state, without a second guide");
  assert.equal(again.providers["semantic-scholar"].license.acknowledgedAt, LATER, "and the new confirmation carries its own time, not the old one");
  assert.equal(again.providers["semantic-scholar"].credentials.configured, false, "a revoked service's key flag is cleared, so the panel cannot claim a key that SecretStorage no longer holds");
});

test("setMode refuses a mode the Toolkit cannot honour, and refuses to change a mode Zotero does not have", () => {
  const registry = integrations.authorizeSemanticScholar(integrations.emptyRegistry(), { acknowledged: true, at: AT });
  for (const mode of ["apikey", "API-KEY", "", null, undefined, 1, "oauth"]) {
    assert.throws(() => integrations.setMode(registry, "semantic-scholar", mode, LATER), TypeError, `${JSON.stringify(mode)} is not a mode the Toolkit can honour, so the record is not written`);
  }
  assert.throws(() => integrations.setMode(registry, "zotero", "api-key", LATER), TypeError, "Zotero has no access mode to change, so a request to change one is a mistake to report, not a no-op to hide");
  assert.throws(() => integrations.setCredentialConfigured(registry, "semantic-scholar", "yes", LATER), TypeError, "a key flag is a yes or a no; anything else is refused rather than coerced");
  assert.throws(() => integrations.beginOnboarding(registry, "openalex", LATER), TypeError, "the Toolkit has no integration called openalex in this release, so a typo cannot invent a provider record");

  const keyed = integrations.setMode(registry, "semantic-scholar", "api-key", LATER);
  assert.equal(keyed.providers["semantic-scholar"].mode, "api-key", "the operator can choose to use a key");
  assert.equal(keyed.providers["semantic-scholar"].authorization, "authorized", "choosing a mode does not re-ask for consent or undo it");
  assert.equal(registry.providers["semantic-scholar"].mode, "anonymous", "and the record the operator handed in is left alone until it is saved");
  assert.equal(integrations.setMode(keyed, "semantic-scholar", "anonymous", LATER).providers["semantic-scholar"].mode, "anonymous", "choosing anonymous again is allowed, and is how a key stops being used");
});

test("resetIntegration returns one service to its defaults and leaves the other one alone", () => {
  let registry = integrations.authorizeSemanticScholar(integrations.emptyRegistry(), { acknowledged: true, at: AT });
  registry = integrations.recordProbe(registry, "zotero", { outcome: "ready", installed: true }, LATER);
  const reset = integrations.resetIntegration(registry, "zotero", LATER);
  assert.deepEqual(reset.providers.zotero, integrations.emptyRegistry().providers.zotero, "Zotero is back to the state a profile that has never looked at it is in");
  assert.equal(reset.providers["semantic-scholar"].authorization, "authorized", "resetting Zotero does not touch the decision the operator made about Semantic Scholar");
  assert.equal(reset.providers["semantic-scholar"].license.acknowledged, true, "a confirmation the operator gave is not collateral damage");
  assert.equal(reset.providers.zotero.lastSuccessfulCheckAt, null, "the reset also drops the verdicts, so the panel cannot show a good check that no longer belongs to this record");

  const resetScholar = integrations.resetIntegration(registry, "semantic-scholar", LATER);
  assert.equal(resetScholar.providers["semantic-scholar"].authorization, "awaiting-consent", "resetting Semantic Scholar asks again instead of assuming the earlier answer still stands");
  assert.equal(resetScholar.providers["semantic-scholar"].mode, "anonymous", "and it stops claiming a mode it no longer has a key for");
  assert.equal(resetScholar.providers["semantic-scholar"].credentials.configured, false, "the credential flag goes back to not stored, which is what SecretStorage will say after a clear");
  assert.equal(resetScholar.providers["semantic-scholar"].license.reference, null, "the licence reference goes too: a reset record claims nothing it did not just record");
  assert.equal(resetScholar.providers.zotero.readiness, "ready", "Zotero's measured readiness survives a reset of the other service");
});

test("the record survives the editor's own storage, and the key never travels with it", async () => {
  const harness = makeHarness();
  assert.equal(store.loadRegistry(harness.context.globalState).providers["semantic-scholar"].authorization, "awaiting-consent", "a profile with nothing stored starts at the question, not at an answer");
  assert.deepEqual(store.loadRegistry(undefined).providers.zotero, integrations.emptyRegistry().providers.zotero, "a caller with no storage at all still gets a usable record instead of a crash");

  const registry = integrations.authorizeSemanticScholar(store.loadRegistry(harness.context.globalState), { acknowledged: true, at: AT });
  const key = "s2k-0123456789abcdef0123456789abcdef";
  await store.storeApiKey(harness.context.secrets, "semantic-scholar", key);
  const saved = await store.saveRegistry(harness.context.globalState, integrations.setCredentialConfigured(registry, "semantic-scholar", true, AT));
  assert.equal(saved.providers["semantic-scholar"].credentials.configured, true, "the record says a key is stored, without holding one");

  const reloaded = store.loadRegistry(harness.context.globalState);
  assert.equal(reloaded.providers["semantic-scholar"].authorization, "authorized", "the decision is still there after the profile reloads, so no later workspace asks again");
  assert.equal(reloaded.providers["semantic-scholar"].license.reference, integrations.LICENSE_REFERENCE, "and so is the licence it was based on");
  assert.ok(!JSON.stringify(harness.globalState.get(store.REGISTRY_STATE_KEY)).includes(key), "the key never entered globalState — the record and the credential are stored apart (DD11-04)");
  assert.equal(harness.secrets.get(store.secretKey("semantic-scholar")), key, "the key is in SecretStorage, under the one name this release uses");
  assert.deepEqual(harness.events.secrets.map((event) => `${event.op} ${event.key}`), [`store ${store.secretKey("semantic-scholar")}`], "exactly one secret write happened, under exactly one key name");
  assert.equal(await store.hasApiKey(harness.context.secrets, "zotero"), false, "Zotero needs no key, and none was stored for it");
});
