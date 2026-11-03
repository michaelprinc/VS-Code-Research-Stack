"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { runProcess, runFile, retryable, stderrTail, describe, setupEnvironment, conflictingUvVariables, scrubbedUvVariables, CONFLICTING_UV_VARIABLES, REVIEWED_UV_ENVIRONMENT, MAX_BUFFER_BYTES, REPORT_LIMIT, asRunProcess } = require("../runner");

const node = process.execPath;

test("a successful run returns stdout, stderr, exit code and duration", async () => {
  const result = await runProcess(node, ["-e", 'console.log("out"); console.error("note");'], { cwd: os.tmpdir(), timeout: 8000 });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "out");
  assert.equal(result.stderr.trim(), "note");
  assert.equal(result.truncated, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.command, node);
  assert.equal(result.cwd, os.tmpdir());
  assert.ok(result.durationMs >= 0);
});

test("a non-zero exit keeps the exit code and the stderr lines the operator needs (R6-09, R6-10)", async () => {
  await assert.rejects(
    runProcess(node, ["-e", 'console.error("line one"); console.error("uv: request failed"); process.exit(4);'], { timeout: 8000 }),
    (error) => {
      assert.equal(error.name, "RunError");
      assert.equal(error.kind, "exit");
      assert.equal(error.exitCode, 4);
      assert.match(error.stderr, /uv: request failed/);
      assert.match(error.message, /exit code 4/, "the message names the exit code instead of a canned sentence");
      assert.match(error.message, /uv: request failed/, "the message carries the last stderr line");
      assert.match(error.message, /cwd /, "the message names where it ran");
      return true;
    },
  );
});

test("a timeout is reported as a timeout with its bound (R6-12)", async () => {
  await assert.rejects(
    runProcess(node, ["-e", "setTimeout(() => {}, 4000)"], { timeout: 400 }),
    (error) => {
      assert.equal(error.kind, "timeout");
      assert.equal(error.timeoutMs, 400);
      assert.match(error.message, /400 ms/);
      assert.match(error.message, /Increase the setup timeout/);
      return true;
    },
  );
});

test("a verbose child completes and the capture is reported as truncated (R6-11)", async () => {
  const result = await runProcess(node, ["-e", 'console.log("x".repeat(200000))'], { timeout: 20000 });
  assert.equal(result.ok, true, "the run itself is not aborted by the reporting limit");
  assert.ok(result.stdoutChars > REPORT_LIMIT);
  assert.equal(result.truncated, true, "the operator is told the capture was truncated");
  assert.ok(MAX_BUFFER_BYTES >= 1024 * 1024, "the hard capture bound is at least 1 MiB");
});

test("cancellation is a distinct outcome and is never retried (R6-14)", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(
    runProcess(node, ["-e", "setTimeout(() => {}, 4000)"], { timeout: 8000, signal: controller.signal, retry: true }),
    (error) => {
      assert.equal(error.kind, "cancelled");
      assert.match(error.message, /cancelled/);
      assert.match(error.message, /Completed files were preserved/);
      return true;
    },
  );
});

test("a missing executable is reported as a launch failure, not retried (R6-13)", async () => {
  await assert.rejects(
    runProcess(path.join(os.tmpdir(), "definitely-not-a-tool-0.3.6"), ["--version"], { timeout: 2000, retry: true }),
    (error) => {
      assert.equal(error.kind, "spawn");
      assert.equal(error.launchCode, "ENOENT");
      assert.match(error.message, /could not be launched/);
      return true;
    },
  );
});

test("retry classification: transport-shaped failures retry once, refusals do not (R6-13)", () => {
  const shape = (kind, stderr) => ({ kind, stderr, stdout: "" });
  assert.equal(retryable(shape("timeout", "")), true);
  assert.equal(retryable(shape("exit", "error: request failed to github.com: Connection timed out")), true);
  assert.equal(retryable(shape("exit", "HTTP status error: HTTP status code 503 Service Unavailable")), true);
  assert.equal(retryable(shape("exit", "Temporary failure in name resolution")), true);
  assert.equal(retryable(shape("exit", "project environment is not writable")), false, "a refusal is not retried");
  assert.equal(retryable(shape("spawn", "ENOENT")), false, "a missing tool is not retried");
  assert.equal(retryable(shape("cancelled", "")), false);
});

test("a retryable setup failure is attempted twice and the attempts are recorded", async () => {
  const marker = path.join(os.tmpdir(), `research-retry-${process.pid}-${Date.now()}`);
  const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(Number(require("node:fs").existsSync(${JSON.stringify(marker)})) + 1)); console.error("connection timed out"); process.exit(2);`;
  try {
    await assert.rejects(runProcess(node, ["-e", script], { timeout: 8000, retry: true }), /connection timed out/);
    assert.equal(await require("node:fs/promises").readFile(marker, "utf8"), "2", "the step was attempted exactly twice");
  } finally {
    await require("node:fs/promises").rm(marker, { force: true });
  }
});

test("the reviewed uv environment is applied only to setup calls (R6-15)", async () => {
  const result = await runProcess(node, ["-e", 'console.log(JSON.stringify({ uv: process.env.UV_NO_CONFIG, downloads: process.env.UV_PYTHON_DOWNLOADS, project: process.env.UV_PROJECT_ENVIRONMENT }))'], { kind: "setup", cwd: os.tmpdir(), timeout: 8000 });
  const seen = JSON.parse(result.stdout);
  assert.equal(seen.uv, "1");
  assert.equal(seen.downloads, "automatic");
  assert.equal(seen.project, path.join(os.tmpdir(), ".venv"));
  const plain = JSON.parse((await runProcess(node, ["-e", 'console.log(JSON.stringify({ uv: process.env.UV_NO_CONFIG || null }))'], { timeout: 8000 })).stdout);
  assert.equal(plain.uv, null, "a non-setup call does not inherit the setup environment");
  assert.equal(setupEnvironment(undefined).UV_LINK_MODE, "copy");
});

test("describe() and stderrTail() turn captured output into operator text", () => {
  const error = { kind: "exit", command: "/usr/local/bin/uv", args: ["sync", "--locked"], cwd: "/w/.research-toolkit/managed/worker-0.3.6", exitCode: 2, stderr: "a\nb\nerror: failed to fetch\n", timeoutMs: 900000 };
  const text = describe(error, "The first run can download Python.");
  assert.match(text, /^uv sync failed with exit code 2: a \| b \| error: failed to fetch/, text);
  assert.match(text, /cwd \/w\/\.research-toolkit\/managed\/worker-0\.3\.6/);
  assert.match(text, /The first run can download Python\./);
  assert.equal(stderrTail("one\ntwo\nthree\n", 2), "two | three");
});

test("asRunProcess keeps injected 0.3.x fixtures working without a second process boundary", async () => {
  const calls = [];
  const legacy = asRunProcess({ runFile: async (executable, args) => { calls.push([executable, args[0]]); return "legacy output"; } });
  const result = await legacy(node, ["--version"], { cwd: os.tmpdir() });
  assert.equal(result.stdout, "legacy output");
  assert.equal(result.ok, true);
  assert.deepEqual(calls[0][1], "--version");
  assert.equal(asRunProcess({}), runProcess, "with no injected service the real runner is used");
});

test("runFile keeps the 0.3.x contract of trimmed stdout", async () => {
  assert.equal(await runFile(node, ["-e", 'console.log("  trimmed  ")'], { timeout: 8000 }), "trimmed");
});

test("a run refuses a working directory that is missing or a link (R6-15)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-cwd-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const outside = path.join(root, "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(runProcess(node, ["-e", "process.exit(0)"], { cwd: path.join(root, "linked") }), (error) => {
    assert.equal(error.kind, "cwd", error.kind);
    assert.match(describe(error), /cannot run in .*: the working directory is a link, not a directory/, describe(error));
    return true;
  });
  await assert.rejects(runProcess(node, ["-e", "process.exit(0)"], { cwd: path.join(root, "absent") }), (error) => {
    assert.equal(error.kind, "cwd", error.kind);
    assert.match(describe(error), /the working directory does not exist/, describe(error));
    return true;
  });
  const real = await runProcess(node, ["-e", "process.stdout.write(process.cwd())"], { cwd: root });
  assert.equal(real.stdout.trim(), await fs.realpath(root), "a real directory is used as given");
});

/**
 * R6-15 (0.3.6 audit): the refusal used to escape as the classify() placeholder, so the GUI showed
 * "lab-store: failed · run failure" for a symlinked or missing working directory.
 */
test("a working-directory refusal is formatted through describe() and never retried (R6-15)", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-cwd-message-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "real"), { recursive: true });
  await fs.symlink(path.join(root, "real"), path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

  const absent = path.join(root, "absent");
  await assert.rejects(
    runProcess(node, ["sync", "--locked"], { cwd: absent, retry: true, timeout: 8000, hint: "Setup writes only inside the workspace folder." }),
    (error) => {
      assert.equal(error.kind, "cwd", "the refusal keeps its non-retryable kind");
      assert.equal(retryable(error), false, "a refused directory is never retried");
      assert.equal(error.attempts, 0, "no process ran, so no attempt is claimed");
      assert.notEqual(error.message, "run failure", "the placeholder message never reaches the GUI");
      assert.ok(!/run failure/.test(error.message), error.message);
      assert.match(error.message, /cannot run in .*absent: the working directory does not exist/, error.message);
      assert.ok(error.message.includes(absent), "the message names the directory it refused");
      return true;
    },
  );

  const linked = path.join(root, "linked");
  await assert.rejects(runProcess(node, ["sync", "--locked"], { cwd: linked, retry: true, timeout: 8000 }), (error) => {
    assert.equal(error.kind, "cwd");
    assert.equal(error.attempts, 0);
    assert.match(error.message, /cannot run in .*linked: the working directory is a link, not a directory/, error.message);
    return true;
  });
});

test("a non-retryable failure reports the attempts that actually ran, not the attempt limit (R6-13)", async () => {
  const marker = path.join(os.tmpdir(), `research-attempts-${process.pid}-${Date.now()}`);
  const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(Number(require("node:fs").existsSync(${JSON.stringify(marker)})) + 1)); console.error("error: the project environment is not writable"); process.exit(3);`;
  try {
    await assert.rejects(runProcess(node, ["-e", script], { timeout: 8000, retry: true }), (error) => {
      assert.equal(error.kind, "exit");
      assert.equal(error.attempts, 1, "one process ran, so the record says one attempt, not two");
      return true;
    });
    assert.equal(await fs.readFile(marker, "utf8"), "1", "the refusal ran exactly once");
  } finally {
    await fs.rm(marker, { force: true });
  }
});

test("stdout never drives the retry decision: a tool printing 502 in ordinary output runs once (R6-13)", async () => {
  const marker = path.join(os.tmpdir(), `research-stdout-${process.pid}-${Date.now()}`);
  const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(Number(require("node:fs").existsSync(${JSON.stringify(marker)})) + 1)); console.log("resolved 502 packages"); console.log("connection timed out is ordinary output here"); console.error("error: the cache directory is not writable"); process.exit(4);`;
  try {
    await assert.rejects(runProcess(node, ["-e", script], { timeout: 8000, retry: true }), (error) => {
      assert.equal(error.kind, "exit");
      assert.equal(error.attempts, 1, "a number in stdout is not a transport failure");
      assert.match(error.stdout, /resolved 502 packages/, "stdout is still reported as evidence");
      return true;
    });
    assert.equal(await fs.readFile(marker, "utf8"), "1", "the refusal ran exactly once");
  } finally {
    await fs.rm(marker, { force: true });
  }
});

test("retry classification reads stderr only, covers uv's transient shape, and drops certificate (R6-13)", () => {
  const shape = (kind, stderr, stdout = "") => ({ kind, stderr, stdout });
  assert.equal(retryable(shape("exit", "error: Request failed after 3 retries")), true, "uv's own transient transport shape is retried");
  assert.equal(retryable(shape("exit", "error: failed after 5 retries in download: uv-0.7.3")), true, "the general 'failed after N retries' shape is retried");
  assert.equal(retryable(shape("exit", "", "resolved 502 packages and 503 warnings")), false, "stdout is not a retry signal");
  assert.equal(retryable(shape("exit", "error: invalid peer certificate: UnknownIssuer")), false, "a certificate failure is not transient and must not be hidden by a retry");
  assert.equal(retryable(shape("cwd", "")), false, "a refused working directory is not retried");
  assert.equal(retryable(shape("buffer", "")), true, "an oversized capture is retried");
});

test("uv's transient stderr shape is attempted twice and both attempts are recorded (R6-13)", async () => {
  const marker = path.join(os.tmpdir(), `research-uv-transient-${process.pid}-${Date.now()}`);
  const script = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(Number(require("node:fs").existsSync(${JSON.stringify(marker)})) + 1)); console.error("error: Request failed after 3 retries"); process.exit(2);`;
  try {
    await assert.rejects(runProcess(node, ["-e", script], { timeout: 8000, retry: true }), /Request failed after 3 retries/);
    assert.equal(await fs.readFile(marker, "utf8"), "2", "the transient failure ran exactly twice");
  } finally {
    await fs.rm(marker, { force: true });
  }
});


test("the reviewed uv environment removes host variables that would change the command's meaning (R7-11)", () => {
  const host = {
    PATH: "/usr/bin", HOME: "/home/researcher",
    UV_INDEX_URL: "https://mirror.example.org/simple/", UV_DEFAULT_INDEX: "https://mirror.example.org/simple",
    UV_LOCKED: "1", UV_FROZEN: "1", UV_OFFLINE: "1", UV_NO_DEV: "1", UV_EXCLUDE_NEWER: "2020-01-01",
    UV_UPGRADE: "1", UV_SYSTEM_PYTHON: "1",
    // Cost and authentication are the user's business: they do not change what the command means.
    UV_CACHE_DIR: "/home/researcher/.cache/uv", UV_KEYRING: "on",
  };
  assert.deepEqual([...conflictingUvVariables(host)].sort(), ["UV_DEFAULT_INDEX", "UV_EXCLUDE_NEWER", "UV_FROZEN", "UV_INDEX_URL", "UV_LOCKED", "UV_NO_DEV", "UV_OFFLINE", "UV_SYSTEM_PYTHON", "UV_UPGRADE"]);
  const env = setupEnvironment("/w/.research-toolkit/managed/worker-0.3.6.1", host);
  for (const name of CONFLICTING_UV_VARIABLES) assert.equal(env[name], undefined, `${name} must not reach uv`);
  assert.equal(env.UV_CACHE_DIR, "/home/researcher/.cache/uv", "a cache location is not a meaning change");
  assert.equal(env.UV_KEYRING, "on");
  assert.equal(env.PATH, "/usr/bin");
  assert.deepEqual({ UV_PYTHON_DOWNLOADS: env.UV_PYTHON_DOWNLOADS, UV_PYTHON: env.UV_PYTHON, UV_LINK_MODE: env.UV_LINK_MODE, UV_NO_PROGRESS: env.UV_NO_PROGRESS, UV_NO_CONFIG: env.UV_NO_CONFIG },
    REVIEWED_UV_ENVIRONMENT, "the reviewed values are always set");
  assert.equal(env.UV_PROJECT_ENVIRONMENT, path.join("/w/.research-toolkit/managed/worker-0.3.6.1", ".venv"));
});

test("a real setup child never sees a host mirror or a host lock mode", async () => {
  const previous = { UV_INDEX_URL: process.env.UV_INDEX_URL, UV_LOCKED: process.env.UV_LOCKED };
  process.env.UV_INDEX_URL = "https://mirror.example.org/simple/";
  process.env.UV_LOCKED = "1";
  try {
    const result = await runProcess(node, ["-e", 'console.log(JSON.stringify({index: process.env.UV_INDEX_URL, locked: process.env.UV_LOCKED, noConfig: process.env.UV_NO_CONFIG, python: process.env.UV_PYTHON}))'], { cwd: os.tmpdir(), timeout: 8000, kind: "setup" });
    const seen = JSON.parse(result.stdout.trim());
    assert.equal(seen.index, undefined, "the child must not inherit a mirror");
    assert.equal(seen.locked, undefined, "the child must not inherit a lock mode");
    assert.equal(seen.noConfig, "1");
    assert.equal(seen.python, "3.12");
  } finally {
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process[name] = value; }
  }
});

test("a uv lock refusal is reported as a lock problem, not as a generic exit code (R7-08)", () => {
  const refusal = "error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.\n\nhint: To update the lockfile, run `uv lock`.";
  const error = { kind: "exit", exitCode: 1, command: "/usr/local/bin/uv.exe", args: ["sync", "--locked"], cwd: "/w/.research-toolkit/managed/worker-0.3.6", stderr: refusal, message: "run failure", timeoutMs: 900000 };
  const text = describe(error, "The first run can download a managed Python 3.12 and the locked packages.");
  assert.match(text, /refused the locked dependency file/);
  assert.match(text, /This is a lockfile disagreement/, "the refusal is classified without asserting the shipped pair is broken");
  assert.match(text, /the toolkit's own check of the pair says whether this build is broken/);
  assert.match(text, /not a network, proxy or interpreter problem/);
  assert.match(text, /needs to be updated/, "uv's own sentence is kept, not replaced");
  assert.equal(retryable(error), false, "a manifest/lock disagreement is not retried");
});

test("a retried timeout reports the wall time the operator actually waited (R7-17)", () => {
  const error = { kind: "timeout", exitCode: null, command: "/usr/local/bin/uv", args: ["sync"], cwd: "/w", stderr: "", message: "run failure", timeoutMs: 900000, attempts: 2, durationMs: 1_803_000 };
  const text = describe(error);
  assert.match(text, /did not finish within 900 s per attempt \(2 attempt\(s\) ran\)/);
  assert.match(text, /Total time waited across 2 attempt\(s\): 1803 s/);
  const single = describe({ ...error, attempts: 1, durationMs: 900000 });
  assert.match(single, /Total time waited across 1 attempt\(s\): 900 s/);
});


test("a stripped host uv setting is named in the failure the operator reads (R7-11)", async () => {
  const path = require("node:path");
  const host = { ...process.env, UV_OFFLINE: "1", UV_INDEX_URL: "https://mirror.example/simple/" };
  const previous = process.env;
  process.env = host;
  try {
    assert.equal(scrubbedUvVariables(host), " Before this command ran, the toolkit removed 2 uv setting(s) inherited from the editor process (UV_INDEX_URL, UV_OFFLINE) and applied its own reviewed uv settings; if this command depends on those settings, run it yourself in a terminal.");
    assert.equal(scrubbedUvVariables({ PATH: "/usr/bin" }), "", "nothing to report when nothing was removed");
    const message = describe({
      kind: "exit", exitCode: 2, command: "uv", args: ["sync", "--locked"], cwd: "/w",
      stderr: "error: Request failed after 3 retries", attempts: 1, durationMs: 1200, timeoutMs: 900000,
      scrubbedUv: scrubbedUvVariables(host),
    }, "hint");
    assert.match(message, /removed 2 uv setting\(s\) inherited from the editor process \(UV_INDEX_URL, UV_OFFLINE\)/);
  } finally {
    process.env = previous;
  }
});

test("a host uv setting is removed whatever spelling the host used (0.3.7 Windows review D1)", () => {
  const previous = process.env;
  try {
    // Windows environment names are case-insensitive and Node keeps the OS spelling in process.env.
    const host = {
      PATH: "/usr/bin", uv_locked: "1", Uv_Index_Url: "https://evil.example", uv_python: "3.11",
      UV_NO_CONFIG: "0", uv_offline: "1", Uv_Frozen: "1", uv_exclude_newer: "2024-01-01",
      uv_system_python: "1", uv_project_environment: "/somewhere/else/.venv",
      // Reviewed names too: a host `uv_link_mode=hardlink` beside UV_LINK_MODE=copy leaves the child
      // free to read the host's copy, and `copy` exists to avoid the Windows cross-device failure.
      uv_link_mode: "hardlink", Uv_No_Progress: "0", uv_python_downloads: "never",
    };
    process.env = host;
    const removed = conflictingUvVariables(host);
    assert.deepEqual(removed.map((name) => name.toLowerCase()).sort(), ["uv_exclude_newer", "uv_frozen", "uv_index_url", "uv_link_mode", "uv_locked", "uv_no_config", "uv_no_progress", "uv_offline", "uv_project_environment", "uv_python", "uv_python_downloads", "uv_system_python"],
      "the operator is told the spelling their own environment used, for every name the toolkit overrides");
    const env = setupEnvironment("/w/.research-toolkit/managed/worker-0.3.7", host);
    const lowered = Object.keys(env).map((name) => name.toLowerCase());
    assert.equal(new Set(lowered).size, lowered.length, `no name may appear twice in different spellings: ${lowered.join(", ")}`);
    for (const name of ["uv_locked", "uv_index_url", "uv_offline", "uv_frozen", "uv_exclude_newer", "uv_system_python", "uv_link_mode", "uv_no_progress", "uv_python_downloads", "uv_no_config", "uv_project_environment"]) {
      assert.ok(!lowered.includes(name) || lowered.filter((item) => item === name).length === 1, `${name} survived the scrub`);
    }
    assert.equal(env.UV_LINK_MODE, "copy");
    assert.equal(env.UV_PYTHON_DOWNLOADS, "automatic");
    assert.equal(env.UV_NO_CONFIG, "1");
    assert.equal(env.UV_PROJECT_ENVIRONMENT, path.join("/w/.research-toolkit/managed/worker-0.3.7", ".venv"));
    assert.equal(env.PATH, "/usr/bin", "settings that only change cost are left alone");
    assert.match(scrubbedUvVariables(host), /uv_exclude_newer/);
    assert.ok(removed.includes("Uv_Index_Url"), "the sentence names the host's own spelling, not the toolkit's");
  } finally {
    process.env = previous;
  }
});
