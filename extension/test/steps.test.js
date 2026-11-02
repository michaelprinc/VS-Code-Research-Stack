"use strict";
/** Step-level contracts: per-step timeouts from the registry, and uv resolution before any run. */
const test = require("node:test");
const assert = require("node:assert/strict");
const { stepTimeout, resolveUv, lockFallbackNote, notebookPairProblems } = require("../steps");
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
  // The real resolver, but on an empty host. A uv in a documented per-user location of the machine
  // running the suite is not part of this assertion, and made it fail on a host that has one.
  const emptyHost = { resolveHostTool: (name, options = {}) => require("../hosttools").resolveHostTool(name, {
    ...options, roots: [], env: { PATH: "", HOME: "", USERPROFILE: "", APPDATA: "", LOCALAPPDATA: "", XDG_BIN_HOME: "" },
  }) };
  const failure = await resolveUv({ services: emptyHost }).catch((error) => error);
  assert.match(failure.message, /uv was not found/, failure.message);
  assert.equal(failure.resolution.verified, false, "the refusal carries the resolution that produced it");
});

test("a fallback install is reported as a fallback, not as a clean install (R7-10, T7-14)", () => {
  assert.equal(lockFallbackNote(null), "", "a clean locked install carries no warning");
  assert.equal(lockFallbackNote(undefined), "");
  const note = lockFallbackNote({ uvMessage: "error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.", detectedAt: "2026-11-02T15:13:11.812Z" });
  assert.match(note, /Warning: this host's uv refused the shipped lockfile/);
  assert.match(note, /needs to be updated/, "uv's own sentence reaches the component evidence");
  assert.match(note, /without rewriting the lockfile/, "the evidence says what the toolkit did and did not do");
  assert.match(lockFallbackNote({}), /the lockfile did not match the project file/, "a fallback with no captured output is still named");
});


test("the notebook project this toolkit writes is checked before uv is pointed at it (R7-07)", async (t) => {
  const os = require("node:os");
  const path = require("node:path");
  const fs = require("node:fs/promises");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-notebook-pair-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const worker = path.join(__dirname, "..", "worker");
  await fs.copyFile(path.join(worker, "pyproject.toml"), path.join(dir, "pyproject.toml"));
  await fs.copyFile(path.join(worker, "uv.lock"), path.join(dir, "uv.lock"));
  assert.deepEqual(await notebookPairProblems(dir), [], "the shipped pair reads clean");

  const lock = await fs.readFile(path.join(dir, "uv.lock"), "utf8");
  await fs.writeFile(path.join(dir, "uv.lock"), lock.replace('name = "research-stack-basic"\nversion = "', 'name = "research-stack-basic"\nversion = "0.3.4"\n# '), "utf8");
  const problems = await notebookPairProblems(dir);
  assert.ok(problems.length >= 1, "a stale notebook pair is named before uv runs");

  await fs.writeFile(path.join(dir, "pyproject.toml"), "[project\nname = \"x\"\nversion = \"", "utf8");
  const unreadable = await notebookPairProblems(dir);
  assert.equal(unreadable.length, 1, "a reader failure is a problem, not an exception");
});
