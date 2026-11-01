"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { paths, appendRecord, writeStatus, readStatus, readLog, STATUS_SCHEMA_VERSION, LOG_DIR } = require("../setuplog");

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-log-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("the status record is written atomically and read back with its schema (R6-22, R6-25)", async (t) => {
  const root = await workspace(t);
  const record = { outcome: "success", package: "full", toolkitVersion: "0.3.6", workspaceFolder: "Research", startedAt: "2026-11-01T08:00:00.000Z", finishedAt: "2026-11-01T08:03:00.000Z", durationMs: 180000, steps: [{ id: "worker", status: "installed", durationMs: 170000 }] };
  const file = await writeStatus(root, record);
  assert.equal(file, path.join(root, LOG_DIR, "last-setup.json"));
  assert.deepEqual((await fs.readdir(path.join(root, LOG_DIR))).filter((name) => name.endsWith(".tmp")), [], "no temporary file is left behind");
  const read = await readStatus(root);
  assert.equal(read.schemaVersion, STATUS_SCHEMA_VERSION);
  assert.equal(read.outcome, "success");
  assert.equal(read.steps[0].id, "worker");
  await writeStatus(root, { ...record, outcome: "partial" });
  assert.equal((await readStatus(root)).outcome, "partial", "the record is replaced in place");
});

test("a missing or damaged status record reads as no record instead of throwing (R6-30)", async (t) => {
  const root = await workspace(t);
  assert.equal(await readStatus(root), null, "a workspace that never ran setup has no verdict");
  await fs.mkdir(path.join(root, LOG_DIR), { recursive: true });
  await fs.writeFile(path.join(root, LOG_DIR, "last-setup.json"), "{ not json");
  const damaged = await readStatus(root);
  assert.equal(damaged.damaged, true, "a record that exists but cannot be read is reported as damaged, not as nothing having run");
  assert.ok(damaged.statusFile.endsWith("last-setup.json"), "the damaged record names the file an operator should open");
  await writeStatus(root, { outcome: "failed", steps: [] });
  assert.equal((await readStatus(root)).outcome, "failed");
});

test("the setup log is append-only JSONL and keeps every attempt (R6-21, R6-22)", async (t) => {
  const root = await workspace(t);
  const first = await appendRecord(root, { kind: "step", stepId: "worker", status: "failed", error: "boom", at: "2026-11-01T08:00:00Z" }, { now: new Date("2026-11-01T08:00:00Z") });
  await appendRecord(root, { kind: "step", stepId: "worker", status: "installed", durationMs: 1200 }, { now: new Date("2026-11-01T08:00:00Z") });
  await appendRecord(root, { kind: "plan", status: "success", ran: ["worker"] }, { now: new Date("2026-11-01T08:00:00Z") });
  assert.match(first, /setup-20261101T080000Z\.jsonl$/);
  const text = await fs.readFile(first, "utf8");
  const lines = text.trim().split("\n");
  assert.equal(lines.length, 3, "attempts are appended, never rewritten");
  assert.deepEqual(lines.map((line) => JSON.parse(line).status), ["failed", "installed", "success"]);
  const log = await readLog(root);
  assert.deepEqual(log.files, ["setup-20261101T080000Z.jsonl"]);
  assert.equal(log.lines.length, 3);
  assert.equal(log.lines[0].record.stepId, "worker");
});

test("an empty workspace has no log files and reading it is not an error", async (t) => {
  const root = await workspace(t);
  const log = await readLog(root);
  assert.deepEqual(log.files, []);
  assert.deepEqual(log.lines, []);
});

test("the log refuses to write through a link and stays inside the workspace (R6-25)", async (t) => {
  const root = await workspace(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "research-log-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, LOG_DIR), { recursive: true });
  await fs.writeFile(path.join(root, LOG_DIR, "last-setup.json"), "{}");
  await fs.symlink(path.join(outside, "stolen.jsonl"), path.join(root, LOG_DIR, "setup-20261101T080000Z.jsonl"), process.platform === "win32" ? "junction" : "file");
  await assert.rejects(appendRecord(root, { kind: "plan", status: "success" }, { now: new Date("2026-11-01T08:00:00Z") }), /link/, "a linked log path is refused");
  await fs.writeFile(path.join(root, LOG_DIR, "last-setup.json"), "{}");
  await fs.rm(path.join(root, LOG_DIR, "last-setup.json"));
  await fs.symlink(path.join(outside, "elsewhere.json"), path.join(root, LOG_DIR, "last-setup.json"), process.platform === "win32" ? "junction" : "file");
  await assert.rejects(writeStatus(root, { outcome: "success", steps: [] }), /link/, "the status record refuses to replace a link");
  const outsideFiles = await fs.readdir(outside);
  assert.deepEqual(outsideFiles.filter((name) => name.includes("setup")), [], "nothing was written outside the workspace");
});

test("the log directory is created inside the workspace when it does not exist yet", async (t) => {
  const root = await workspace(t);
  const file = await appendRecord(root, { kind: "plan", status: "success" });
  const relative = path.relative(root, file);
  assert.ok(relative.startsWith(LOG_DIR), relative);
  assert.ok(!path.isAbsolute(relative) && !relative.startsWith(".."), "the log stays workspace-contained");
});


test("a linked log directory is refused and nothing is written through it (R6-22)", async (t) => {
  const root = await workspace(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "research-log-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, ".research-toolkit"), { recursive: true });
  await fs.symlink(outside, path.join(root, LOG_DIR));
  await assert.rejects(() => appendRecord(root, { kind: "step", stepId: "worker", status: "installed" }), /must be a real directory/);
  assert.deepEqual(await fs.readdir(outside), [], "nothing was written through the link");
});

test("one plan writes one attempt log and the log directory ignores itself (R6-21)", async (t) => {
  const root = await workspace(t);
  const runStamp = "20261101T080000Z";
  await appendRecord(root, { kind: "step", stepId: "worker", status: "installed" }, { runStamp });
  await appendRecord(root, { kind: "step", stepId: "lab-store", status: "installed" }, { runStamp });
  const logs = (await fs.readdir(path.join(root, LOG_DIR))).filter((name) => name.endsWith(".jsonl"));
  assert.deepEqual(logs, [`setup-${runStamp}.jsonl`], "the attempts of one plan stay in one file");
  assert.match(await fs.readFile(path.join(root, LOG_DIR, ".gitignore"), "utf8"), /\*\n$/, "the log directory carries its own ignore rule");
  const log = await readLog(root);
  assert.equal(log.lines.length, 2, "both attempts are readable back");
});

test("a status record that cannot be read says so instead of reporting nothing (R6-25)", async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, LOG_DIR), { recursive: true });
  await fs.writeFile(path.join(root, LOG_DIR, "last-setup.json"), "");
  const damaged = await readStatus(root);
  assert.equal(damaged.damaged, true);
  assert.equal(damaged.outcome, undefined);
  assert.equal(await readStatus(path.join(root, "absent")), null, "a workspace that never ran setup has no record at all");
});
