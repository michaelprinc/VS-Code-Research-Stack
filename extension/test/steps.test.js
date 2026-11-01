"use strict";
/** Step-level contracts: per-step timeouts from the registry, and uv resolution before any run. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { stepTimeout, resolveUv } = require("../steps");
const { STEPS_BY_ID } = require("../installer");

test("each step's timeout comes from the component registry, not from a global guess (R6-12)", () => {
  assert.equal(stepTimeout(STEPS_BY_ID.get("worker")), 900_000, "the worker sync may download a 3.12 interpreter on first run");
  assert.equal(stepTimeout(STEPS_BY_ID.get("notebook-env")), 900_000);
  assert.equal(stepTimeout(STEPS_BY_ID.get("research-overlay")), 60_000, "a file-only step does not get a download-sized timeout");
  assert.equal(stepTimeout(STEPS_BY_ID.get("lab-store")), 120_000);
  for (const step of STEPS_BY_ID.values()) {
    assert.ok(Number.isInteger(step.timeoutSeconds) && step.timeoutSeconds >= 60 && step.timeoutSeconds <= 3600, `${step.id} declares a bounded timeoutSeconds`);
    assert.ok(Array.isArray(step.hostTools), `${step.id} declares which host tools it needs`);
  }
});

test("the operator override raises a step's bound and is clamped to the reviewed range (R6-12)", () => {
  assert.equal(stepTimeout(STEPS_BY_ID.get("research-overlay"), { setupTimeoutSeconds: 1800 }), 1_800_000);
  assert.equal(stepTimeout(STEPS_BY_ID.get("research-overlay"), { setupTimeoutSeconds: 30 }), 60_000, "a bound below the step's own floor is refused");
  assert.equal(stepTimeout(STEPS_BY_ID.get("worker"), { setupTimeoutSeconds: 99_999 }), 3_600_000, "the reviewed maximum is the ceiling");
  assert.equal(stepTimeout(STEPS_BY_ID.get("worker"), { setupTimeoutSeconds: "not a number" }), 900_000, "an invalid setting falls back to the registry");
});

test("uv is resolved through the reviewed order and the setting and registry minimum reach the resolver (R6-03, R6-07)", async () => {
  const seen = [];
  const services = { resolveHostTool: async (name, options) => { seen.push({ name, options }); return name === "uv" && options.configuredPath ? { name, path: options.configuredPath, source: "setting", version: "0.7.3", verified: true, minimumVersion: options.minimumVersion, searched: {}, hint: "" } : { name, path: null, verified: false, reason: `${name} was not found. Searched: 1 configured path(s), 12 absolute PATH entr(ies), 5 documented install location(s).`, hint: "Install uv, or set researchStack.uvPath to its full path.", searched: {} }; } };
  const tool = await resolveUv({ vscode: undefined, services, settings: { uvPath: "/configured/uv", minimumVersions: { uv: "0.5.0" } }, roots: ["/workspace"] });
  assert.equal(tool.path, "/configured/uv");
  assert.equal(tool.source, "setting");
  assert.equal(seen[0].options.configuredPath, "/configured/uv", "researchStack.uvPath is the first candidate");
  assert.equal(seen[0].options.minimumVersion, "0.5.0", "the registry minimum is enforced");
  assert.deepEqual(seen[0].options.roots, ["/workspace"], "workspace roots are passed so a workspace-local copy can be refused");

  const missing = await resolveUv({ vscode: undefined, services, settings: {}, roots: ["/workspace"] }).catch((error) => error);
  assert.match(missing.message, /uv was not found\. Searched: 1 configured path\(s\), 12 absolute PATH entr\(ies\), 5 documented install location\(s\)\./, missing.message);
  assert.match(missing.message, /researchStack\.uvPath/, "the refusal names the setting that can fix it");
  assert.equal(missing.resolution.verified, false);

  const legacy = await resolveUv({ vscode: undefined, services: { findHostTool: async () => undefined }, settings: {}, roots: ["/workspace"] }).catch((error) => error);
  assert.match(legacy.message, /uv was not found by the injected resolver/, "a 0.3.x fixture still produces a refusal, not a crash");

  const provided = await resolveUv({ vscode: undefined, services: { uv: "/injected/uv" }, settings: {}, roots: [] });
  assert.equal(provided.path, "/injected/uv", "an injected uv keeps 0.3.x fixtures working");
});

test("resolveUv survives a missing editor context instead of throwing a type error", async () => {
  const tool = await resolveUv({ services: { uv: "/injected/uv" } });
  assert.equal(tool.path, "/injected/uv");
  const failure = await resolveUv({}).catch((error) => error);
  assert.match(failure.message, /uv was not found/, failure.message);
});
