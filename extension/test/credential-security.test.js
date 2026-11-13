"use strict";

/**
 * 0.3.11 — credential rules.
 *
 * A Semantic Scholar key is the only secret this release handles, and the property that matters is not that it is
 * stored but that it stays contained: it is refused before it is unusable, it is written to one place under one name,
 * it is never returned to a panel, never quoted in an error, never copied into the integration record, never sent to
 * a probe that did not ask for it, and never used to decide anything about the operator's own environment variables.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const integrations = require("../integrations");
const store = require("../integrationstore");
const probe = require("../integrationprobe");
const { makeHarness } = require("./harness");

const AT = "2026-11-08T14:00:00.000Z";
const KEY = "s2k-0123456789abcdef0123456789abcdef"; // 36 characters, the shape a real key arrives in

function authorizedRegistry(mode = "anonymous") {
  return integrations.setMode(integrations.authorizeSemanticScholar(integrations.emptyRegistry(), { acknowledged: true, at: AT }), "semantic-scholar", mode, AT);
}

test("validateApiKey accepts a realistic key and refuses every shape that would fail later, somewhere harder to see", () => {
  assert.equal(KEY.length, 36, "the accepted case is a length a real key actually has");
  assert.deepEqual(store.validateApiKey(KEY), { ok: true, reason: null }, "a normal key is accepted, so the operator is not fought by the form");
  const refused = ["", "abc", "abcdefg", "x".repeat(300), "abcdefgh\n", "abcdefgh\t", " abcdefgh", "abcdefgh ", 7, null, undefined, {}, [], "abcčdefghij", "abcdéefghij", "abcd\u0000efgh"];
  for (const value of refused) {
    const result = store.validateApiKey(value);
    assert.equal(result.ok, false, `${JSON.stringify(value)} is refused: storing it would produce a key that fails inside the worker, where the operator cannot see why`);
    assert.ok(typeof result.reason === "string" && result.reason.length > 0, `${JSON.stringify(value)} comes with a sentence the operator can act on`);
    if (typeof value === "string" && value.length > 2) assert.ok(!result.reason.includes(value), `the reason for refusing ${JSON.stringify(value)} does not quote the value back`);
  }
  assert.equal(store.validateApiKey("a".repeat(8)).ok, true, "8 characters is the floor, inclusive");
  assert.equal(store.validateApiKey("a".repeat(256)).ok, true, "256 characters is the ceiling, inclusive");
  assert.equal(store.validateApiKey("a".repeat(257)).ok, false, "one character past the ceiling is refused, so a pasted blob cannot become a stored key");
  assert.equal(store.validateApiKey("abcd!#%&*+-./:;=?@_~").ok, true, "ordinary punctuation is allowed: real keys contain it, and refusing it would be a defect with a friendly face");
});

test("a refusal to store a key states the rule and contains none of the value", async () => {
  const harness = makeHarness();
  for (const value of ["abc", "x".repeat(300), "abcdefgh\n", "abcdefgh\t", " abcdefgh", "abcčdefghij", 12345, null]) {
    await assert.rejects(() => store.storeApiKey(harness.context.secrets, "semantic-scholar", value), (error) => {
      assert.ok(error instanceof Error, "a refusal is an Error the controller can report, not a silent null");
      assert.match(error.message, /did not store the key/, "the message names what the Toolkit did not do, so the operator is not left guessing");
      if (typeof value === "string" && value.length > 2) assert.ok(!error.message.includes(value), `the refusal of ${JSON.stringify(value)} quotes none of it — an error message is copied into logs and reports`);
      if (typeof value === "string") assert.ok(!error.message.includes("\n") || !value.includes("\n"), "a refused line break is not reproduced in the message the operator will paste into a report");
      return true;
    });
  }
  assert.equal(harness.secrets.size, 0, "nothing was stored: a refused key is not stored in part, in a placeholder, or anywhere else");
  assert.deepEqual(harness.events.secrets, [], "and the Toolkit never touched SecretStorage at all while refusing");
});

test("storeApiKey writes exactly one SecretStorage entry, under exactly the name this release names", async () => {
  const harness = makeHarness();
  const result = await store.storeApiKey(harness.context.secrets, "semantic-scholar", KEY);
  assert.deepEqual(result, { configured: true, provider: "semantic-scholar" }, "the Toolkit reports what it did in the shape the controller can turn into a record update");
  assert.equal(store.secretKey("semantic-scholar"), "researchStack.integration/semantic-scholar/apiKey", "one provider, one key name, stated in full");
  assert.equal(store.secretKey("zotero"), "researchStack.integration/zotero/apiKey", "the same shape for the other provider, so a later release cannot invent a second location");
  assert.equal(harness.secrets.size, 1, "exactly one entry was written — no copy, no backup, no second place a secret can leak from");
  assert.deepEqual([...harness.secrets.keys()], ["researchStack.integration/semantic-scholar/apiKey"], "under exactly the reviewed name, and no other");
  assert.equal(harness.secrets.get(store.secretKey("semantic-scholar")), KEY, "the value stored is the value the operator typed, unaltered");
  assert.deepEqual(harness.events.secrets, [{ op: "store", key: store.secretKey("semantic-scholar"), value: KEY }], "the write is the only SecretStorage call the Toolkit made");
  assert.equal(harness.globalState.size, 0, "and nothing at all went into globalState, where the integration record lives");

  await store.clearApiKey(harness.context.secrets, "semantic-scholar");
  assert.equal(harness.secrets.size, 0, "clearing removes it: a revoked integration's key is really gone, not merely unlisted");
  assert.deepEqual(harness.events.secrets.map((event) => event.op), ["store", "delete"], "the Toolkit both stored and deleted, which is what a revoke has to do");
});

test("hasApiKey answers yes or no and never hands the key back", async () => {
  const harness = makeHarness();
  assert.equal(await store.hasApiKey(harness.context.secrets, "semantic-scholar"), false, "with nothing stored the answer is no");
  await store.storeApiKey(harness.context.secrets, "semantic-scholar", KEY);
  const answer = await store.hasApiKey(harness.context.secrets, "semantic-scholar");
  assert.equal(answer, true, "with a key stored the answer is yes");
  assert.equal(typeof answer, "boolean", "the panel gets a boolean, because a panel that receives a key is a panel that can display one");
  assert.ok(!String(answer).includes(KEY), "the key is not in the answer");
  assert.equal(await store.readApiKey(harness.context.secrets, "semantic-scholar"), KEY, "reading the key is a separate, named act, so the controller has to ask for it deliberately");
  assert.equal(await store.readApiKey(harness.context.secrets, "zotero"), undefined, "a provider with no stored key reads as nothing, not as an empty string that looks configured");
});

test("redactSecrets removes a key from a sentence every time it appears, and counts what it removed", () => {
  const sentence = `the probe failed for ${KEY} after ${KEY} was rejected twice; the worker said 401 for ${KEY}`;
  const result = store.redactSecrets(sentence, [KEY]);
  assert.equal(result.removed, 3, "every occurrence is counted, so the operator can see how much was taken out");
  assert.ok(!result.text.includes(KEY), "and none of it survives — a partial redaction is a leak with a clean conscience");
  assert.equal(result.text.split("<secret>").length - 1, 3, "each removal is visible as a placeholder, not silent");
  assert.match(result.text, /the probe failed for <secret> after <secret> was rejected twice/, "the sentence still reads as a sentence, so the report is still useful");

  const punctuation = store.redactSecrets(`header x-api-key: a+b.c*d?e=f failed`, ["a+b.c*d?e=f"]);
  assert.equal(punctuation.removed, 1, "a key made of regex punctuation is still found, because a key is literal text and not a pattern");
  assert.equal(store.redactSecrets("nothing to remove", ["", null, undefined]).removed, 0, "an empty value removes nothing, and is not counted as a removal");
  assert.equal(store.redactSecrets(undefined, [KEY]).text, "", "no text in means no text out, and no crash on the way");
  assert.equal(store.redactSecrets("a key in a log line", []).removed, 0, "with no known secrets there is nothing to claim to have removed");
});

test("environmentFootprint reports the names the host already carries and cannot report their values", () => {
  const environment = { SEMANTIC_SCHOLAR_API_KEY: KEY, CROSSREF_MAILTO: "anna@example.org", PATH: "/usr/bin" };
  const footprint = store.environmentFootprint(environment);
  assert.ok(footprint.names.includes("SEMANTIC_SCHOLAR_API_KEY"), "the Toolkit says plainly that this variable already exists, so the operator is not told to create it twice");
  assert.ok(footprint.names.includes("CROSSREF_MAILTO"), "and the same for the Crossref identity it would otherwise set");
  assert.equal(footprint.present, true, "the panel gets a yes or no, not a list it has to interpret");
  assert.ok(!footprint.names.includes("PATH"), "a variable the Toolkit has no interest in is not reported as one it has");
  assert.equal(Object.prototype.hasOwnProperty.call(footprint, "SEMANTIC_SCHOLAR_API_KEY"), false, "the footprint has no field named after the variable, so it cannot carry its value by accident");
  assert.ok(!JSON.stringify(footprint).includes(KEY), "the value is nowhere in what comes back — DD11-08 reports what exists and deletes nothing");
  assert.ok(!JSON.stringify(footprint).includes("anna@example.org"), "an identity the operator already configured is named, not copied");
  assert.deepEqual(store.environmentFootprint({}).names, [], "an environment with none of them is reported as such");
  assert.deepEqual(store.environmentFootprint(undefined), { names: [], present: false }, "and no environment at all is still an answer, not a crash");
  assert.deepEqual(store.environmentFootprint({ SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED: "" }).names, [], "a variable set to an empty string is not a decision the operator made");
});

test("probeEnvironment carries a key only to the probe that asked for it, and carries nothing for a service that is off", () => {
  const anonymous = probe.probeEnvironment({ registry: authorizedRegistry("anonymous"), apiKey: KEY });
  assert.deepEqual(anonymous, { SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED: "true" }, "an anonymous check needs the licence flag and no credential, even though a key was handed to the call");
  assert.ok(!Object.keys(anonymous).includes("SEMANTIC_SCHOLAR_API_KEY"), "the key is absent entirely, not empty — an empty key would still be a signal that one exists");

  const keyed = probe.probeEnvironment({ registry: authorizedRegistry("api-key"), apiKey: KEY });
  assert.equal(keyed.SEMANTIC_SCHOLAR_API_KEY, KEY, "the mode the operator chose is the mode the worker is told about");
  assert.equal(keyed.SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED, "true", "and the consent travels with it, because the worker refuses the provider without it");

  const noKey = probe.probeEnvironment({ registry: authorizedRegistry("api-key") });
  assert.deepEqual(Object.keys(noKey), ["SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED"], "a mode that wants a key, with no key stored, sends no key: the worker falls back and says so");

  const off = probe.probeEnvironment({ registry: integrations.revokeIntegration(authorizedRegistry("api-key"), "semantic-scholar", AT), apiKey: KEY });
  assert.deepEqual(off, {}, "a revoked integration gets nothing at all — no licence claim, no key (DD11-06)");
  assert.deepEqual(probe.probeEnvironment({ registry: integrations.emptyRegistry(), apiKey: KEY }), {}, "and a profile that never consented gets nothing either");
  assert.deepEqual(probe.probeEnvironment({}), {}, "a probe with no record sends nothing, so a missing record cannot leak a default");
  for (const env of [anonymous, keyed, noKey, off]) assert.ok(!Object.keys(env).some((name) => /ZOTERO/i.test(name)), "Zotero is a local service: the probe environment carries nothing for it");
});

test("the probe boundary builds one reviewed worker call and refuses an unknown provider before a command exists", () => {
  assert.deepEqual(probe.probeArgv({ providers: ["zotero", "semantic-scholar"] }), ["probe-integrations", "--providers", "zotero,semantic_scholar"], "the host's names become the worker's names in one argv, with no shell involved");
  assert.deepEqual(probe.probeArgv({ providers: ["semantic-scholar", "zotero", "semantic-scholar"] }), ["probe-integrations", "--providers", "semantic_scholar,zotero"], "in the order asked, de-duplicated, so one probe checks each service once");
  assert.deepEqual(probe.probeArgv({}), ["probe-integrations", "--providers", "zotero,semantic_scholar"], "asked for nothing, it probes exactly the two services this release knows");
  for (const provider of ["openalex", "ZOTERO", "", null, 7]) assert.throws(() => probe.probeArgv({ providers: [provider] }), TypeError, `${JSON.stringify(provider)} is refused before any command is built, so a typo cannot become a process call`);
  assert.equal(probe.PROBE_COOLDOWN_MS, 10_000, "one probe per 10 seconds: enough that a panel refresh cannot hammer a live service, short enough that the operator's deliberate 'I have installed Zotero — check it now' is not refused because an automatic check spent the window");
  assert.equal(integrations.probeCooldown({ lastProbeAt: Date.now(), now: Date.now() }).waitMs, probe.PROBE_COOLDOWN_MS, "and the model's own default is the window the probe module publishes, so the two halves cannot drift apart");
  assert.equal(probe.PROBE_TIMEOUT_MS, 80_000, "and the call has a stated timeout (NF11-03), so a hung service cannot hold the panel open — and it is above the worker's own worst case, so a Zotero still loading its library is not killed mid-check");

  const receipt = probe.interpretReceipt({ zotero: { outcome: "not-running", code: "ZOTERO_NO_ANSWER", installed: true }, semantic_scholar: { outcome: "rate-limited", code: "HTTP_429", retryAfter: "31 seconds" } });
  assert.deepEqual(Object.keys(receipt), ["zotero", "semanticScholar"], "the worker's underscore names become the host's camelCase names here, once: a caller that indexes the receipt by `semantic-scholar` gets nothing and silently records no verdict");
  assert.deepEqual(receipt.zotero, { outcome: "not-running", code: "ZOTERO_NO_ANSWER", detail: null, retryAfter: null, installed: true, serverId: null, evidence: null }, "Zotero's own words are kept as they arrived, including which Zotero answered and where an installation was found");
  assert.equal(receipt.semanticScholar.retryAfter, "31 seconds", "and the pause window survives into the record the panel reads");
  const half = probe.interpretReceipt({ zotero: { outcome: "ready", installed: true } });
  assert.equal(half.zotero.outcome, "ready", "a receipt that answers for one service is still read for that service");
  assert.equal(half.semanticScholar.outcome, "unreachable", "and the missing half is a stated verdict, not an exception the panel never sees");
  assert.equal(half.semanticScholar.code, "PROBE_RECEIPT_MISSING", "with a code that says what was missing");
  const odd = probe.interpretReceipt({ zotero: { outcome: "sideways", code: "WEIRD_1", detail: "the worker said this" } });
  assert.equal(odd.zotero.outcome, "unreachable", "an outcome this release does not know becomes unreachable, which is the honest floor");
  assert.equal(odd.zotero.code, "WEIRD_1", "but the worker's code and detail are kept, so the operator can see what the worker actually said");
  assert.equal(probe.interpretReceipt("not a receipt").zotero.code, "PROBE_RECEIPT_INVALID", "a receipt that is not a record at all is still a verdict");
  assert.equal(probe.interpretReceipt(null).semanticScholar.outcome, "unreachable", "for both services, so neither is left claiming it was checked");
  assert.match(probe.describeProbeFailure("semantic-scholar", { outcome: "rate-limited", retryAfter: "31 seconds" }), /31 seconds/, "the failure sentence names the window the service asked for");
  assert.match(probe.describeProbeFailure("zotero", { outcome: "not-running" }), /Start it, then check again/, "and names the action the operator can take");
});

test("no module in this release can reach a socket, a process or the editor itself", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const name of ["integrations.js", "integrationstore.js", "integrationprobe.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", name), "utf8");
    for (const primitive of ["node:https", "node:http", "node:net", "node:tls", "node:dgram", "node:child_process", "node:worker_threads", "node:fs", "node:crypto", "require(\"vscode\")", "Function(", "eval(", "fetch(", "XMLHttpRequest", "WebSocket"]) {
      assert.ok(!source.includes(primitive), `${name} does not import or call ${primitive} — the probe runs in the reviewed worker (DD11-01) and updates.js stays the only packaged member with a socket (NF11-02)`);
    }
  }
  const edges = { "integrations.js": [], "integrationstore.js": ["./integrations"], "integrationprobe.js": ["./integrations"] };
  for (const [name, allowed] of Object.entries(edges)) {
    const source = fs.readFileSync(path.join(__dirname, "..", name), "utf8");
    const found = [...source.matchAll(/require\("\.\/([A-Za-z0-9_.-]+?)(?:\.js)?"/g)].map((match) => `./${match[1]}`);
    assert.deepEqual(found, allowed, `${name} requires exactly ${allowed.length ? allowed.join(", ") : "no local module"}, so the reviewed module graph stays acyclic (DD11-02)`);
  }
});
