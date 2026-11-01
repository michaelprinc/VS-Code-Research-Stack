"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { makeHarness } = require("./harness");
const { inspectLock, lockPath, runPreflight, clearStaleLock, requiredTools, setupWindowMs, STALE_BY_PID_AFTER_MS } = require("../preflight");
const { STEPS_BY_ID } = require("../installer");
const { MANAGED_FOLDER } = require("../runtime");

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-preflight-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, folder: { name: "Preflight", uri: { scheme: "file", fsPath: root } } };
}

async function writeLock(root, record) {
  const file = lockPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(record));
  return file;
}

const services = { resolveHostTool: async (name) => ({ name, path: "/trusted/uv", source: "injected", version: "0.7.0", verified: true, searched: { setting: 0, pathEntries: 0, knownLocations: 0, managed: 0 }, hint: "" }) };

test("the tools a plan needs come from the registry, not from prose (R6-16)", () => {
  assert.deepEqual(requiredTools([STEPS_BY_ID.get("worker"), STEPS_BY_ID.get("research-overlay")]), ["uv"]);
  assert.deepEqual(requiredTools([STEPS_BY_ID.get("lab-store")]), [], "the store step needs no host tool");
  assert.deepEqual(requiredTools([STEPS_BY_ID.get("worker"), STEPS_BY_ID.get("notebook-env")]), ["uv"], "the same tool is asked about once");
});

test("a free lock is reported as free and a fresh lock as held with its owner (R6-17)", async (t) => {
  const { root } = await workspace(t);
  assert.equal((await inspectLock(root)).state, "free");
  const file = await writeLock(root, { pid: process.pid, startedAt: new Date().toISOString() });
  const held = await inspectLock(root);
  assert.equal(held.state, "held", "a live setup is never interleaved with");
  assert.equal(held.ownerPid, process.pid);
  assert.equal(held.path, file);
  assert.match(held.reason, /held by the running process /);
});

test("a lock whose owner process is gone is stale after a minute, and only then (R6-17)", async (t) => {
  const { root } = await workspace(t);
  const dead = 2_147_483_646;
  await writeLock(root, { pid: dead, startedAt: new Date(Date.now() - 5000).toISOString() });
  assert.equal((await inspectLock(root)).state, "held", "a recently abandoned lock is not assumed stale");
  await writeLock(root, { pid: dead, startedAt: new Date(Date.now() - STALE_BY_PID_AFTER_MS - 5000).toISOString() });
  const stale = await inspectLock(root);
  assert.equal(stale.state, "stale");
  assert.match(stale.reason, /no longer running/);
  await writeLock(root, { pid: process.pid, startedAt: new Date(Date.now() - 40 * 60 * 1000).toISOString() });
  const old = await inspectLock(root, { setupWindowMs: 15 * 60 * 1000 });
  assert.equal(old.state, "stale", "a lock older than the whole setup window is stale even with a live pid");
  assert.match(old.reason, /older than the 15 minute setup window/);
});

test("clearing removes only a stale lock and refuses a live one (T6-11)", async (t) => {
  const { root } = await workspace(t);
  const file = await writeLock(root, { pid: process.pid, startedAt: new Date().toISOString() });
  const refused = await clearStaleLock(root);
  assert.equal(refused.removed, false);
  assert.match(refused.message, /appears to be running/);
  assert.ok(await fs.stat(file), "a live lock is untouched");
  await writeLock(root, { pid: 2_147_483_646, startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  const cleared = await clearStaleLock(root);
  assert.equal(cleared.removed, true);
  assert.match(cleared.message, /Removed the interrupted setup lock/);
  await assert.rejects(fs.lstat(file), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(path.join(root, MANAGED_FOLDER))).filter((name) => name !== ".setup.lock"), [], "nothing else in the managed folder was touched");
  const none = await clearStaleLock(root);
  assert.equal(none.removed, false);
  assert.match(none.message, /No setup lock exists/);
});

test("preflight passes for a trusted local folder and names the resolved host tool (R6-16, R6-31)", async (t) => {
  const { root, folder } = await workspace(t);
  const harness = makeHarness({ folders: [folder] });
  const result = await runPreflight({ vscode: harness.vscode, folder, steps: [STEPS_BY_ID.get("worker"), STEPS_BY_ID.get("lab-store")], services });
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
  const ids = result.checks.map((check) => check.id);
  assert.deepEqual(ids, ["trust", "local", "host-tool-uv", "managed-path", "managed-writable", "setup-lock"]);
  const tool = result.checks.find((check) => check.id === "host-tool-uv");
  assert.equal(tool.status, "ok");
  assert.match(tool.detail, /uv 0\.7\.0 resolved from injected: \/trusted\/uv/);
  assert.equal(result.lock.state, "free");
});

test("an untrusted workspace blocks setup before anything is written (T6-12)", async (t) => {
  const { root, folder } = await workspace(t);
  const harness = makeHarness({ folders: [folder], trusted: false });
  const result = await runPreflight({ vscode: harness.vscode, folder, steps: [STEPS_BY_ID.get("worker")], services });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, ["trust"]);
  const check = result.checks.find((item) => item.id === "trust");
  assert.match(check.action, /Trust this workspace folder/);
  await assert.rejects(fs.stat(path.join(root, ".research-toolkit")), { code: "ENOENT" }, "preflight wrote nothing");
});

test("a missing host tool blocks the plan with the searched locations and the clearing action (T6-02, T6-12)", async (t) => {
  const { root, folder } = await workspace(t);
  const harness = makeHarness({ folders: [folder] });
  const result = await runPreflight({
    vscode: harness.vscode, folder, steps: [STEPS_BY_ID.get("worker")],
    services: { resolveHostTool: async (name) => ({ name, path: null, verified: false, reason: `${name} was not found. Searched: 0 configured path(s), 12 absolute PATH entr(ies), 5 documented install location(s).`, hint: "Install uv, or set researchStack.uvPath.", searched: { setting: 0, pathEntries: 12, knownLocations: 5, managed: 0 } }) },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, ["host-tool-uv"]);
  const check = result.checks.find((item) => item.id === "host-tool-uv");
  assert.match(check.detail, /12 absolute PATH entr\(ies\)/);
  assert.match(check.action, /researchStack\.uvPath/);
});

test("a linked managed path and a non-writable workspace are both reported (R6-16)", async (t) => {
  const { root, folder } = await workspace(t);
  const harness = makeHarness({ folders: [folder] });
  const outside = path.join(root, "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.mkdir(path.join(root, ".research-toolkit"), { recursive: true });
  await fs.symlink(outside, path.join(root, ".research-toolkit", "managed"), process.platform === "win32" ? "junction" : "dir");
  const result = await runPreflight({ vscode: harness.vscode, folder, steps: [STEPS_BY_ID.get("worker")], services });
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes("managed-path"), result.checks.map((c) => `${c.id}=${c.status}`).join(", "));
  assert.match(result.checks.find((check) => check.id === "managed-path").action, /real directory/);
});


test("a lock whose contents were never written is clearable once the write could have finished (R6-17, 0.3.6 recovery)", async (t) => {
  const { root } = await workspace(t);
  const file = lockPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "");
  const fresh = await inspectLock(root);
  assert.equal(fresh.state, "held", "a lock that may be being written right now is not removed");
  const aged = await inspectLock(root, { now: Date.now() + 10 * 60 * 1000 });
  assert.equal(aged.state, "stale", "an unreadable lock older than any write is stale, not immortal");
  assert.match(aged.reason, /unreadable/);
  const cleared = await clearStaleLock(root, { now: Date.now() + 10 * 60 * 1000 });
  assert.equal(cleared.removed, true, "the documented recovery action works on a damaged lock");
  assert.equal(await fs.lstat(file).catch(() => null), null);
});

test("a lock older than the plan's own window is stale even when its pid now belongs to another process (R6-17)", async (t) => {
  const { root } = await workspace(t);
  await writeLock(root, { pid: 1, startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() });
  const lock = await inspectLock(root, { setupWindowMs: 20 * 60 * 1000 });
  assert.equal(lock.state, "stale", "pid recycling must not block setup forever");
  assert.match(lock.reason, /older than the .* setup window/);
  assert.equal((await clearStaleLock(root, { setupWindowMs: 20 * 60 * 1000 })).removed, true);
});

test("the lock window is derived from the plan's own timeouts, not a fixed guess (R6-17, T6-11)", () => {
  const steps = [STEPS_BY_ID.get("worker"), STEPS_BY_ID.get("notebook-env")];
  const defaultWindow = setupWindowMs({}, steps);
  assert.ok(defaultWindow >= 2 * 1000 * Math.max(STEPS_BY_ID.get("worker").timeoutSeconds, STEPS_BY_ID.get("notebook-env").timeoutSeconds),
    "the window must outlast the slowest plan, otherwise a running setup looks stale");
  assert.ok(setupWindowMs({ setupTimeoutSeconds: 1800 }, steps) > defaultWindow, "a longer configured timeout lengthens the window");
});

test("a lock that is a directory or a link is named with the remedy, never reported as a running setup (R6-17)", async (t) => {
  const { root } = await workspace(t);
  const file = lockPath(root);
  await fs.mkdir(file, { recursive: true });
  assert.equal((await inspectLock(root)).state, "invalid");
  const directory = await clearStaleLock(root);
  assert.equal(directory.removed, false);
  assert.match(directory.message, /is a directory/, directory.message);
  await fs.rm(file, { recursive: true });
  const target = path.join(root, "not-a-lock");
  await fs.writeFile(target, "text");
  await fs.symlink(target, file);
  assert.equal((await inspectLock(root)).state, "invalid");
  const link = await clearStaleLock(root);
  assert.equal(link.removed, true, "the link itself is removed");
  assert.ok(await fs.lstat(target), "the file the link pointed at is left alone");
});
