"use strict";

/**
 * 0.3.10 — the update channel.
 *
 * Every case here drives the decision logic with a recorded Marketplace reply. No test in this file opens
 * a socket: `fetchImpl` is a parameter of `checkPublishedVersion`, so the transport is the only code path
 * that reaches `node:https`, and `test/module-boundaries.test.js` proves that the module has exactly one
 * such path.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const updates = require("../updates");

const PUBLISHER = "michaelprinc";
const NAME = "research-stack-toolkit";

/** The reply shape the Marketplace actually returns for `/latest` (a version record, newest first). */
function marketplaceReply({ version = "0.3.11", engine = "^1.140.0", lastUpdated = "2026-11-07T10:00:00Z" } = {}) {
  return JSON.stringify({
    publisherId: "11111111-1111-1111-1111-111111111111",
    extensionId: "22222222-2222-2222-2222-222222222222",
    displayName: "Research Stack Toolkit",
    versions: [{
      version,
      lastUpdated,
      properties: [
        { name: "Microsoft.VisualStudio.Code.Engine", value: engine },
        { name: "Microsoft.VisualStudio.Code.ExtensionKind", value: "ui" },
      ],
    }],
  });
}

function transport(response) {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return response; };
  return { fetchImpl, calls };
}

test("parseVersion accepts only the shape the Marketplace accepts", () => {
  assert.deepEqual(updates.parseVersion("0.3.10"), { major: 0, minor: 3, patch: 10 });
  assert.deepEqual(updates.parseVersion(" 1.140.0 "), { major: 1, minor: 140, patch: 0 });
  // vsce rejects a four-part version and the Marketplace rejects a prerelease tag, so this parser must
  // refuse both rather than quietly truncating them into something that compares wrong.
  for (const rejected of ["0.3", "0.3.10.1", "v0.3.10", "0.3.10-beta", "0.3.x", "", null, undefined, "1.2.3.4", "0.3.10-rc.1", "latest"]) {
    assert.equal(updates.parseVersion(rejected), null, `${JSON.stringify(rejected)} is not a Marketplace version`);
  }
  assert.deepEqual(updates.parseVersion("0.3.10"), updates.parseVersion("0.3.10"), "parsing the same version twice gives the same answer");
});

test("compareVersions orders releases and refuses to guess about unknown ones", () => {
  assert.equal(updates.compareVersions("0.3.9", "0.3.10"), -1, "0.3.10 is newer than 0.3.9");
  assert.equal(updates.compareVersions("0.3.10", "0.3.9"), 1);
  assert.equal(updates.compareVersions("0.3.10", "0.3.10"), 0);
  assert.equal(updates.compareVersions("0.3.10", "0.10.0"), -1, "minor is compared as a number, not as text");
  assert.equal(updates.compareVersions("0.4.0", "0.3.99"), 1);
  assert.equal(updates.compareVersions("1.0.0", "0.999.999"), 1);
  assert.equal(updates.compareVersions("0.3.10", "0.3.10.1"), null, "an unparseable side is unknown, never treated as older");
  assert.equal(updates.compareVersions(null, "0.3.10"), null);
});

test("engineSatisfies answers the only two ranges vsce will publish", () => {
  assert.equal(updates.engineSatisfies("^1.140.0", "1.140.0"), true, "the floor itself satisfies");
  assert.equal(updates.engineSatisfies("^1.140.0", "1.145.2"), true, "the current stable editor satisfies");
  assert.equal(updates.engineSatisfies("^1.140.0", "1.139.9"), false, "an editor below the range cannot host the build");
  assert.equal(updates.engineSatisfies("^1.140.0", "2.0.0"), true, "caret allows the next major in the VS Code sense");
  assert.equal(updates.engineSatisfies(">=1.140.0", "1.141.0"), true);
  assert.equal(updates.engineSatisfies("1.140.0", "1.145.2"), false, "a bare range means exactly that version");
  assert.equal(updates.engineSatisfies("1.140.0", "1.140.0"), true);
  assert.equal(updates.engineSatisfies("^1.x.0", "1.145.2"), null, "an open-ended range is refused, not guessed at");
  assert.equal(updates.engineSatisfies("", "1.145.2"), null);
  assert.equal(updates.engineSatisfies("^1.140.0", "not-a-version"), null);
});

test("latestUri names the one host and refuses an identity that is not an identifier", () => {
  assert.equal(
    updates.latestUri(PUBLISHER, NAME),
    "https://marketplace.visualstudio.com/_apis/public/gallery/vscode/michaelprinc/research-stack-toolkit/latest",
    "the only request the Toolkit makes online, in full",
  );
  for (const bad of [["michael princ", NAME], [PUBLISHER, "../other"], [PUBLISHER, ""], ["", NAME], [PUBLISHER, "a?x"], [PUBLISHER, "a#x"]]) {
    assert.throws(() => updates.latestUri(...bad), TypeError, `${JSON.stringify(bad)} cannot be interpolated into a URL`);
  }
});

test("a published newer version becomes an update the operator can take", async () => {
  const { fetchImpl, calls } = transport({ status: 200, body: marketplaceReply({ version: "0.3.11" }) });
  const result = await updates.checkPublishedVersion({ publisher: PUBLISHER, name: NAME, fetchImpl });
  assert.equal(result.state, "ok");
  assert.equal(result.version, "0.3.11");
  assert.equal(result.engine, "^1.140.0", "the engine range is read from the property vsce writes");
  assert.equal(result.lastUpdated, "2026-11-07T10:00:00Z");
  assert.deepEqual(calls, [updates.latestUri(PUBLISHER, NAME)], "exactly one request, to the reviewed URL");

  const plan = updates.updatePlan({
    installedVersion: "0.3.10", publishedVersion: result.version, publishedEngine: result.engine,
    vscodeVersion: "1.145.2", checkState: result.state,
  });
  assert.deepEqual(plan, {
    state: "update-available", installedVersion: "0.3.10", publishedVersion: "0.3.11",
    requiredEngine: "^1.140.0", action: "update",
  });
});

test("the same version published is reported as up to date, not as an update", async () => {
  const { fetchImpl } = transport({ status: 200, body: marketplaceReply({ version: "0.3.10" }) });
  const result = await updates.checkPublishedVersion({ publisher: PUBLISHER, name: NAME, fetchImpl });
  const plan = updates.updatePlan({ installedVersion: "0.3.10", publishedVersion: result.version, publishedEngine: result.engine, vscodeVersion: "1.145.2", checkState: result.state });
  assert.equal(plan.state, "up-to-date");
  assert.equal(plan.action, "none");
});

test("a newer published build the editor cannot host is not offered as an update", () => {
  const plan = updates.updatePlan({
    installedVersion: "0.3.10", publishedVersion: "0.4.0", publishedEngine: "^1.150.0",
    vscodeVersion: "1.145.2", checkState: "ok",
  });
  assert.equal(plan.state, "editor-too-old");
  assert.equal(plan.action, "update-vscode");
  assert.equal(plan.requiredEngine, "^1.150.0", "the operator is told which VS Code the build needs");
});

test("an install ahead of the published channel is stated as such", () => {
  const plan = updates.updatePlan({
    installedVersion: "0.3.11", publishedVersion: "0.3.10", publishedEngine: "^1.140.0",
    vscodeVersion: "1.145.2", checkState: "ok",
  });
  assert.equal(plan.state, "ahead-of-channel");
  assert.equal(plan.action, "none", "downgrading is never offered as an update");
});

test("an unpublished extension is reported as not published, with the manual install path", async () => {
  const { fetchImpl } = transport({ status: 404, body: "" });
  const result = await updates.checkPublishedVersion({ publisher: PUBLISHER, name: NAME, fetchImpl });
  assert.equal(result.state, "not-published");
  const plan = updates.updatePlan({ installedVersion: "0.3.10", checkState: result.state });
  assert.equal(plan.state, "not-published");
  assert.equal(plan.action, "install-from-marketplace");
});

test("a failed or malformed check is a verdict, never an exception", async () => {
  const cases = [
    [{ status: 500, body: "" }, "check-failed"],
    [{ status: 0, body: "", error: "timed out after 8000 ms" }, "check-failed"],
    [{ status: 200, body: "<html>proxy</html>" }, "invalid-response"],
    [{ status: 200, body: JSON.stringify({ versions: [] }) }, "invalid-response"],
    [{ status: 200, body: JSON.stringify({ versions: [{ version: "" }] }) }, "invalid-response"],
    [null, "check-failed"],
  ];
  for (const [response, expected] of cases) {
    const fetchImpl = async () => response;
    const result = await updates.checkPublishedVersion({ publisher: PUBLISHER, name: NAME, fetchImpl });
    assert.equal(result.state, expected, `${JSON.stringify(response)} reads as ${expected}`);
    assert.ok(typeof result.detail === "string" && result.detail.length > 0, "every failed verdict says why in words");
    const plan = updates.updatePlan({ installedVersion: "0.3.10", checkState: result.state });
    assert.equal(plan.action, "retry", "a failed check does not disable the toolkit, it only says try again");
  }
  const throwing = async () => { throw new Error("socket closed"); };
  const result = await updates.checkPublishedVersion({ publisher: PUBLISHER, name: NAME, fetchImpl: throwing });
  assert.equal(result.state, "check-failed");
  assert.equal(result.detail, "socket closed");
});

test("a bad identity is refused before any transport is reached", async () => {
  let reached = 0;
  const fetchImpl = async () => { reached += 1; return { status: 200, body: "{}" }; };
  const result = await updates.checkPublishedVersion({ publisher: "bad publisher", name: NAME, fetchImpl });
  assert.equal(result.state, "invalid-identity");
  assert.equal(result.url, null);
  assert.equal(reached, 0, "nothing is sent when the identity is not an identifier");
});

test("the cooldown allows one check a day and never more", () => {
  const now = 1_760_000_000_000;
  assert.equal(updates.shouldCheck({ enabled: true, lastCheckedAt: 0, now }), true, "first run in a fresh profile");
  assert.equal(updates.shouldCheck({ enabled: true, lastCheckedAt: now - 60_000, now }), false, "a check a minute ago is enough");
  assert.equal(updates.shouldCheck({ enabled: true, lastCheckedAt: now - updates.CHECK_COOLDOWN_MS + 1, now }), false);
  assert.equal(updates.shouldCheck({ enabled: true, lastCheckedAt: now - updates.CHECK_COOLDOWN_MS, now }), true, "the window has passed");
  assert.equal(updates.shouldCheck({ enabled: false, lastCheckedAt: 0, now }), false, "switched off means no request, ever");
  assert.equal(updates.shouldCheck({ enabled: false, lastCheckedAt: 0, now, force: true }), false, "even an explicit press is refused when the setting is off");
  assert.equal(updates.shouldCheck({ enabled: true, lastCheckedAt: now - 60_000, now, force: true }), true, "the operator can always ask again by hand");
  assert.equal(updates.shouldCheck({ enabled: true, lastCheckedAt: undefined, now }), true, "a missing stamp is treated as never checked");
  assert.equal(updates.CHECK_COOLDOWN_MS, 24 * 60 * 60 * 1000);
  assert.equal(updates.REQUEST_TIMEOUT_MS, 8000, "a check that hangs must not hold the panel");
});

test("the panel link and the install identifier agree with the manifest", () => {
  assert.equal(updates.marketplacePage(PUBLISHER, NAME), `https://marketplace.visualstudio.com/items?itemName=${PUBLISHER}.${NAME}`);
  const manifest = require("../package.json");
  assert.equal(updates.latestUri(manifest.publisher, manifest.name), updates.latestUri(PUBLISHER, NAME), "the request uses the manifest identity, not a hard-coded one");
  assert.equal(updates.marketplacePage(manifest.publisher, manifest.name), updates.marketplacePage(PUBLISHER, NAME));
  assert.equal(updates.MARKETPLACE_HOST, "marketplace.visualstudio.com");
});

test("the transport is one HTTPS GET with a cap, and it is the module's own default", () => {
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "updates.js"), "utf8");
  assert.equal((source.match(/https\.get\(/g) || []).length, 1, "one request call site");
  assert.match(source, /const MAX_RESPONSE_BYTES = 64 \* 1024;/, "the reply is capped, so a bad answer cannot balloon the panel");
  assert.match(source, /timeout: timeoutMs/, "the request carries its timeout into the transport");
  assert.match(source, /Accept: "application\/json"/, "it asks for JSON, not an HTML page");
  assert.equal(typeof updates.httpsGet, "function");
});
