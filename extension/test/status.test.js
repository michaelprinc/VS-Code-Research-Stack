"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { outcomeOf, outcomeLine, firstProblem, stepRow, diagnosticsText, durationText, OUTCOMES } = require("../status");

const step = (id, status, extra = {}) => ({ id, label: id, status, durationMs: 1000, startedAt: "2026-11-01T08:00:00.000Z", finishedAt: "2026-11-01T08:00:01.000Z", ...extra });
const verified = { verified: true, missing: [] };

test("the outcome set is fixed and every member is produced by its own evidence (R6-23)", () => {
  assert.deepEqual(OUTCOMES, ["success", "partial", "failed", "blocked", "cancelled", "not-run"]);
  const cases = [
    [null, "not-run"],
    [{ steps: [] }, "not-run"],
    [{ steps: [step("worker", "installed", { artifacts: verified })] }, "success"],
    [{ steps: [step("worker", "skipped")] }, "success"],
    [{ steps: [step("worker", "installed", { artifacts: verified }), step("notebook-env", "failed", { error: "boom" })] }, "partial"],
    [{ steps: [step("worker", "failed", { error: "boom" }), step("lab-store", "blocked", { blockedBy: "worker" })] }, "failed"],
    [{ steps: [], preflight: { ok: false, checks: [{ id: "trust", label: "Workspace trust", status: "fail", detail: "not trusted" }] } }, "blocked"],
    [{ steps: [step("worker", "installed", { artifacts: verified }), step("notebook-env", "cancelled")] }, "cancelled"],
  ];
  for (const [record, expected] of cases) {
    assert.equal(outcomeOf(record), expected, JSON.stringify(record));
    assert.ok(OUTCOMES.includes(outcomeLine(record).outcome));
  }
});

test("a step that exits 0 but leaves no artifacts cannot produce a success verdict (T6-17, D6-07)", () => {
  const record = { steps: [step("worker", "installed", { artifacts: { verified: false, missing: [".venv/bin/python"] } })] };
  assert.equal(outcomeOf(record), "partial");
  const verdict = outcomeLine(record);
  assert.match(verdict.line, /Installation incomplete/);
  const problem = firstProblem(record);
  assert.equal(problem.label, "worker");
  assert.match(problem.detail, /1 file\(s\) it should have produced are missing: \.venv\/bin\/python/);
  assert.match(problem.action, /Repair this step/);
});

test("the verdict wording a user reads (R6-29)", () => {
  const lines = [
    [outcomeLine({ steps: [step("worker", "installed", { artifacts: verified }), step("lab-store", "skipped")] }).line, /^Installation complete — 2 component step\(s\) verified\.$/],
    [outcomeLine({ steps: [step("worker", "installed", { artifacts: verified }), step("notebook-env", "failed", { error: "uv sync failed with exit code 2" })] }).line, /^Installation incomplete — 1 step\(s\) verified, 1 need attention \(notebook-env\)\.$/],
    [outcomeLine({ steps: [step("worker", "failed", { error: "uv was not found" })] }).line, /^Installation failed — worker: uv was not found\.$/],
    [outcomeLine({ steps: [], preflight: { ok: false, checks: [{ id: "setup-lock", label: "Setup lock", status: "fail", detail: "a setup is running" }] } }).line, /^Setup blocked — a setup is running\.$/],
    [outcomeLine({ steps: [step("worker", "installed", { artifacts: verified }), step("notebook-env", "cancelled")] }).line, /^Setup cancelled — 1 step\(s\) already completed were kept\.$/],
    [outcomeLine(null).line, /^No component setup has run in this workspace yet$/],
  ];
  for (const [actual, expected] of lines) assert.match(actual, expected, actual);
});

test("a blocked step names what blocked it, and the first problem is the actionable one", () => {
  const record = { steps: [step("worker", "failed", { error: "uv sync failed with exit code 2: 503" }), step("lab-store", "blocked", { blockedBy: "worker" })] };
  const problem = firstProblem(record);
  assert.equal(problem.label, "worker", "the root failure is reported before its consequence");
  const row = stepRow(record.steps[1]);
  assert.match(row.statusText, /blocked · blocked by worker/);
  assert.equal(row.error, "");
  const failedRow = stepRow({ ...record.steps[0], exitCode: 2, attempts: 2 });
  assert.match(failedRow.statusText, /failed · exit 2 · 2 attempts/);
  assert.match(failedRow.duration, /1 s/);
  assert.equal(durationText(undefined), "—");
  assert.equal(durationText(183000), "3 m 03 s");
});

test("diagnostics text carries the verdict, host tools, preflight, steps and the log pointer (R6-28)", () => {
  const record = {
    outcome: "partial", package: "full", toolkitVersion: "0.3.6", workspaceFolder: "Research",
    startedAt: "2026-11-01T08:00:00.000Z", finishedAt: "2026-11-01T08:03:12.000Z", durationMs: 192000,
    hostTools: [{ name: "uv", path: "/home/u/.local/bin/uv", version: "0.7.3", source: "known-location" }, { name: "git", path: null, reason: "git was not found." }],
    preflight: { ok: true, checks: [{ id: "trust", label: "Workspace trust", status: "ok", detail: "trusted" }, { id: "setup-lock", label: "Setup lock", status: "warn", detail: "stale", action: "Clear interrupted setup lock" }] },
    steps: [
      { id: "worker", label: "Isolated locked worker", status: "installed", durationMs: 170000, finishedAt: "2026-11-01T08:02:50.000Z", artifacts: verified },
      { id: "notebook-env", label: "Notebook analysis environment", status: "failed", durationMs: 21000, exitCode: 2, error: "uv sync failed with exit code 2: 503", hint: "Retry this step.", finishedAt: "2026-11-01T08:03:11.000Z" },
    ],
    logFile: "/w/.research-toolkit/logs/last-setup.json",
  };
  const text = diagnosticsText(record, { files: ["setup-20261101T080000Z.jsonl"], lines: [{ file: "setup-20261101T080000Z.jsonl", record: { kind: "step", stepId: "notebook-env", status: "failed" } }] });
  assert.match(text, /^Research Stack component setup — Installation incomplete/);
  assert.match(text, /Package: full · Toolkit: 0\.3\.6 · Workspace: Research/);
  assert.match(text, /Duration: 3 m 12 s/);
  assert.match(text, /uv: 0\.7\.3 at \/home\/u\/\.local\/bin\/uv \(resolved from known-location\)/);
  assert.match(text, /git: not found — git was not found\./);
  assert.match(text, /Setup lock: warn — stale → Clear interrupted setup lock/);
  assert.match(text, /\(notebook-env\): failed · exit 2 · 21 s/);
  assert.match(text, /error: uv sync failed with exit code 2: 503/);
  assert.match(text, /next action: Retry this step\./);
  assert.match(text, /Setup log file: \/w\/\.research-toolkit\/logs\/last-setup\.json/);
  assert.equal(diagnosticsText(null, null), "Component setup status: no setup has run in this workspace yet.");
});


test("an installed step whose files are gone is troubled, named by the missing files, and never counted as verified (T6-17, T6-24)", () => {
  const record = { steps: [step("worker", "installed", { artifacts: { verified: false, missing: [".research-toolkit/managed/worker-0.3.6/.venv/bin/python"], observedCount: 1 } })] };
  assert.equal(outcomeOf(record), "partial");
  const line = outcomeLine(record).line;
  assert.equal(line, "Installation incomplete — 0 step(s) verified, 1 need attention (worker).", line);
  assert.equal(stepRow(record.steps[0]).artifactsText, "missing: .research-toolkit/managed/worker-0.3.6/.venv/bin/python");
});

test("a verdict recorded by another release is qualified instead of reused (0.3.6 upgrade path)", () => {
  const record = { toolkitVersion: "0.3.5", steps: [step("worker", "installed", { artifacts: verified })] };
  assert.match(outcomeLine(record, { toolkitVersion: "0.3.6" }).line,
    /Recorded by toolkit 0\.3\.5; this release has not run in this workspace yet\./);
  assert.equal(outcomeLine(record, { toolkitVersion: "0.3.5" }).line, "Installation complete — 1 component step(s) verified.");
});

test("the headline stays one sentence and names every troubled step (0.3.6 density)", () => {
  const record = { steps: [step("worker", "installed", { artifacts: verified }), step("notebook-env", "failed", { error: "x".repeat(400) }), step("lab-store", "blocked", { blockedBy: "worker" })] };
  const line = outcomeLine(record).line;
  assert.ok(line.length < 160, `the headline must fit one line, got ${line.length} characters`);
  assert.match(line, /2 need attention \(notebook-env, lab-store\)/, line);
  assert.ok(!/\.\./.test(line), `no doubled full stops: ${line}`);
  assert.match(diagnosticsText(record), /x{80}/, "the full error text is still available in the diagnostics");
});

test("a host tool that was found but cannot be used is not printed as resolved (0.3.6 host tools)", () => {
  const record = { steps: [step("worker", "blocked", { error: "uv was not usable" })], hostTools: [
    { name: "uv", path: "C:\\tools\\uv.cmd", version: null, source: "path", verified: false, usable: false, reason: "it is a Windows batch wrapper" },
    { name: "uv", path: null, version: null, source: "path", verified: false, usable: false, reason: "uv was not found" },
  ] };
  const text = diagnosticsText(record);
  assert.match(text, /uv: not usable — it is a Windows batch wrapper/, text);
  assert.match(text, /uv: not found — uv was not found/, text);
  assert.ok(!/resolved from path/.test(text), "an unusable tool is never reported as resolved");
});

test("a step that installed through the lockfile fallback is not reported as a clean install (0.3.7 e2e defect 1)", () => {
  const fallback = { detectedAt: "2026-11-02T21:00:00.000Z", problems: [], uvMessage: "error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided." };
  const record = { package: "full", steps: [step("worker", "installed", { lockFallback: fallback })] };
  const verdict = outcomeLine(record);
  assert.match(verdict.line, /lockfile fallback/, verdict.line);
  assert.match(verdict.line, /refused the shipped lockfile/, verdict.line);
  const row = stepRow(record.steps[0]);
  assert.match(row.statusText, /lockfile fallback used/, row.statusText);
  assert.match(row.note, /installed through a lockfile fallback/, row.note);
  assert.match(diagnosticsText(record), /note: installed through a lockfile fallback/, diagnosticsText(record));

  const clean = outcomeLine({ package: "full", steps: [step("worker", "installed")] }).line;
  assert.ok(!/fallback/.test(clean), "a normal install keeps its plain headline");
});
