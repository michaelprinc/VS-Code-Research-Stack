"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { runProcess, runFile, retryable, stderrTail, describe, setupEnvironment, conflictingUvVariables, conflictingPythonVariables, scrubbedUvVariables, uvCommandPolicy, CONFLICTING_UV_VARIABLES, REVIEWED_UV_ENVIRONMENT, MAX_BUFFER_BYTES, REPORT_LIMIT, asRunProcess } = require("../runner");

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

/**
 * W2 (HIGH, Windows portability review): a stopped run must take its whole process tree with it.
 *
 * `uv sync` is not one process — it starts a managed python and build children that write into the
 * step's own directory. The reviewer's probe (probe6_process_tree.js) showed a grandchild writing
 * its file 1.6 s after the RunError on this host. These tests spawn that shape for real: a direct
 * child that spawns a grandchild which writes on a timer, and assert that after a timeout or a
 * cancel the grandchild is dead, wrote nothing, and the promise still failed fast.
 */
async function treeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-tree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "grandchild-wrote-after-the-stop.txt");
  const grandScript = path.join(root, "grandchild.js");
  const childScript = path.join(root, "child.js");
  // Stands for a uv-spawned wheel build or managed python: it writes late, 1.2 s after it starts.
  await fs.writeFile(grandScript, `
    const fs = require("node:fs");
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(marker)}, "written " + new Date().toISOString() + "\\n");
      process.exit(0);
    }, 1200);
    process.on("SIGTERM", () => {
      fs.writeFileSync(${JSON.stringify(marker)} + ".sigterm", "grandchild received SIGTERM\\n");
      process.exit(0);
    });
  `);
  // Stands for uv.exe: it spawns the grandchild with the run's own stdio pipes and then hangs.
  await fs.writeFile(childScript, `
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, [${JSON.stringify(grandScript)}], { stdio: "inherit" });
    console.log("child pid " + process.pid);
    console.log("grandchild pid " + grandchild.pid);
    setTimeout(() => {}, 30000);
  `);
  return { root, marker, childScript };
}

const pidOf = (text, label) => {
  const match = new RegExp(`${label} pid (\\d+)`).exec(String(text || ""));
  return match ? Number(match[1]) : null;
};

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
};

/**
 * A pid in the process table is not the same thing as a process that can still write: a killed
 * grandchild stays in `/proc` as a zombie (state Z) until somebody reaps it, and `kill(pid, 0)`
 * answers "yes" to a zombie. On Linux `/proc` says which of the two this is; elsewhere the pid
 * check is all there is.
 */
const running = (pid) => {
  if (!alive(pid)) return false;
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).trim().split(" ")[0] !== "Z";
  } catch {
    return true; // no /proc on this platform: fall back to "the pid is still there"
  }
};

test("a timed-out run reaps its grandchildren, not only its direct child (W2, POSIX)", async (t) => {
  if (process.platform === "win32") return t.skip("the POSIX path is a process-group kill");
  const { root, marker, childScript } = await treeFixture(t);
  const started = Date.now();
  const error = await runProcess(node, [childScript], { cwd: root, timeout: 400, retry: false }).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error, "the run failed as a timeout");
  assert.equal(error.kind, "timeout");
  assert.equal(error.attempts, 1);
  assert.equal(error.timeoutMs, 400);
  assert.equal(error.command, node);
  assert.deepEqual(error.args, [childScript]);
  assert.equal(error.cwd, root);
  assert.equal(error.exitCode, null);
  assert.equal(error.reaped, true, "the boundary reports that it reaped the tree");
  assert.match(error.message, /did not finish within 400 ms per attempt/, "the operator-facing timeout sentence is unchanged");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500, `the step still failed fast (${elapsed} ms)`);

  const grandchild = pidOf(error.stdout, "grandchild");
  assert.ok(grandchild, "the grandchild's pid is reported as evidence");
  assert.ok(!await fs.stat(marker).catch(() => null), "the grandchild wrote nothing at the moment of the RunError");
  // SIGKILL is delivered asynchronously: the kernel takes a process a moment after kill() returns,
  // so "is it dead yet" is only answerable after a short settle. The write is the real proof.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(running(grandchild), false, "the grandchild is dead");
  await new Promise((resolve) => setTimeout(resolve, 1550));
  assert.ok(!await fs.stat(marker).catch(() => null), "the grandchild wrote nothing 1.8 s after the RunError either");
  assert.ok(!await fs.stat(`${marker}.sigterm`).catch(() => null), "it was killed outright, not asked politely");
});

test("a cancelled run reaps its grandchildren too (W2, POSIX, the Cancel button)", async (t) => {
  if (process.platform === "win32") return t.skip("the POSIX path is a process-group kill");
  const { root, marker, childScript } = await treeFixture(t);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  const error = await runProcess(node, [childScript], { cwd: root, timeout: 8000, signal: controller.signal, retry: false }).then(
    () => null,
    (caught) => caught,
  );
  assert.ok(error, "the run failed as a cancellation");
  assert.equal(error.kind, "cancelled");
  assert.match(error.message, /was cancelled/, "the cancellation sentence is unchanged");
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500, `the step still failed fast (${elapsed} ms)`);

  const grandchild = pidOf(error.stdout, "grandchild");
  assert.ok(grandchild, "the grandchild's pid is reported as evidence");
  assert.ok(!await fs.stat(marker).catch(() => null), "the grandchild had written nothing when the cancellation was reported");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(running(grandchild), false, "the grandchild is dead");
  await new Promise((resolve) => setTimeout(resolve, 1550));
  assert.ok(!await fs.stat(marker).catch(() => null), "the cancelled run left no grandchild writing into the step directory");
});

/**
 * The other half of the same field failure: the tool **exits** with a non-zero code while its own
 * child is still alive. `uv sync --locked` refusing is exactly this shape — uv exits 1 and a build
 * child outlives it. Measured on this host before the reap was extended (scratch harness
 * /tmp/reap-exit/measure.js + probe-state.js): the RunError was reported at 35 ms with the
 * grandchild in `/proc` state R, and the orphan wrote its file at 1.2 s — into the step directory,
 * after the step had been reported failed.
 */
async function exitTreeFixture(t, exitCode) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-exit-tree-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const marker = path.join(root, "grandchild-wrote-after-the-failure.txt");
  const pidsFile = path.join(root, "pids.json");
  const grandScript = path.join(root, "grandchild.js");
  const childScript = path.join(root, "child.js");
  // Stands for a uv-spawned wheel build or managed python: it writes late, 1.2 s after it starts.
  await fs.writeFile(grandScript, `
    const fs = require("node:fs");
    setTimeout(() => {
      fs.writeFileSync(${JSON.stringify(marker)}, "written " + new Date().toISOString() + "\\n");
      process.exit(0);
    }, 1200);
    process.on("SIGTERM", () => {
      fs.writeFileSync(${JSON.stringify(marker)} + ".sigterm", "grandchild received SIGTERM\\n");
      process.exit(0);
    });
  `);
  // Stands for uv itself: it starts the build child, records both pids synchronously, and exits.
  await fs.writeFile(childScript, `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, [${JSON.stringify(grandScript)}], { stdio: "inherit" });
    fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
    console.log("child pid " + process.pid);
    console.log("grandchild pid " + grandchild.pid);
    process.exit(${exitCode});
  `);
  // The pids come from a file the child writes synchronously before it exits, so the measurement
  // never depends on whether the pipe's data event beat the exit event.
  const readPids = async () => JSON.parse(await fs.readFile(pidsFile, "utf8"));
  return { root, marker, childScript, readPids };
}

test("a run that exits non-zero reaps the tree it leaves alive (the field failure: uv exits 1, its build child keeps writing)", async (t) => {
  if (process.platform === "win32") return t.skip("the POSIX path is a process-group kill");
  const { root, marker, childScript, readPids } = await exitTreeFixture(t, 1);
  const started = Date.now();
  const error = await runProcess(node, [childScript], { cwd: root, timeout: 8000, retry: false }).then(
    () => null,
    (caught) => caught,
  );
  const elapsed = Date.now() - started;
  assert.ok(error, "the run failed as an exit failure");
  assert.equal(error.kind, "exit", "the kind the rest of the toolkit reads is unchanged");
  assert.equal(error.exitCode, 1);
  assert.equal(error.signal, null);
  assert.equal(error.launchCode, null);
  assert.equal(error.attempts, 1);
  assert.equal(error.cwd, root);
  assert.equal(retryable(error), false, "a refusal is still not retried");
  assert.match(error.message, /failed with exit code 1/, "the operator-facing exit sentence is unchanged");
  assert.ok(elapsed < 2500, `the failure was still reported fast (${elapsed} ms)`);

  const ids = await readPids();
  assert.equal(error.reaped, true, "the boundary reaped the tree before it reported the failure");
  assert.equal(error.reapTarget, `process group -${ids.child}`, "the tree is taken from the direct child's own group");
  assert.ok(!await fs.stat(marker).catch(() => null), "the grandchild wrote nothing at the moment of the RunError");
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(running(ids.grandchild), false, "the grandchild is not running once the kill has landed");
  await new Promise((resolve) => setTimeout(resolve, 1550));
  assert.equal(running(ids.grandchild), false, "the grandchild is still not running 1.8 s later");
  assert.ok(!await fs.stat(marker).catch(() => null), "the grandchild wrote nothing 1.8 s after the failure either");
  assert.ok(!await fs.stat(`${marker}.sigterm`).catch(() => null), "it was killed outright, not asked politely");
});

test("a run that exits 0 leaves its tree alone — no reap after a successful run", async (t) => {
  if (process.platform === "win32") return t.skip("the POSIX path is a process-group kill");
  const { root, marker, childScript, readPids } = await exitTreeFixture(t, 0);
  const result = await runProcess(node, [childScript], { cwd: root, timeout: 8000, retry: false });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.reaped, undefined, "a successful run claims no reap");
  const ids = await readPids();
  assert.equal(running(ids.grandchild), true, "the grandchild the tool left behind is untouched");
  assert.ok(!await fs.stat(marker).catch(() => null), "it had not written yet when the run resolved");
  await new Promise((resolve) => setTimeout(resolve, 1800));
  assert.ok(await fs.stat(marker), "the tree was left alone: the grandchild wrote its own file at 1.2 s");
});

test("a spawn failure keeps its spawn shape and says what the reaper did (kind unchanged)", async () => {
  const missing = path.join(os.tmpdir(), "definitely-not-a-tool-reap-0.3.7");
  const error = await runProcess(missing, ["--version"], { timeout: 2000, retry: true }).then(() => null, (e) => e);
  assert.equal(error.name, "RunError");
  assert.equal(error.kind, "spawn");
  assert.equal(error.launchCode, "ENOENT");
  assert.equal(error.exitCode, null);
  assert.equal(error.attempts, 1, "a missing tool is still not retried");
  assert.match(error.message, /could not be launched/, "the operator-facing spawn sentence is unchanged");
  assert.equal(error.reaped, false, "nothing was started, so nothing was reaped — and the boundary says so");
  assert.equal(error.reapTarget, "no pid");
  assert.match(error.reapReason, /never got a pid/, error.reapReason);
});

test("SHAPE TEST (not Windows proof): a reaper that never answers cannot hang the failure (W2 bound, on the exit path)", async (t) => {
  // The win32 branch is taken by stubbing the platform, and its reaper is a real process that is
  // started and never answers. Nothing here observes Windows: no taskkill.exe, no TerminateProcess,
  // no job object. What is measured is the bound — the failure arrives, and it arrives on time.
  const os = require("node:os");
  const childProcess = require("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-reap-bound-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const childScript = path.join(root, "exit-1.js");
  await fs.writeFile(childScript, 'console.log("child pid " + process.pid); process.exit(1);');
  const calls = [];
  let hung = null;
  const realPlatform = os.platform;
  const realExecFile = childProcess.execFile;
  const realSpawn = childProcess.spawn;
  os.platform = () => "win32";
  childProcess.execFile = (file, args, options) => {
    calls.push({ file, args, options });
    // A reaper that starts and never answers: the callback is never called, the process stays up.
    hung = realSpawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { cwd: os.tmpdir(), shell: false, stdio: "ignore" });
    return hung;
  };
  try {
    const started = Date.now();
    const error = await runProcess(node, [childScript], { cwd: root, timeout: 8000, retry: false }).then(
      () => null,
      (caught) => caught,
    );
    const elapsed = Date.now() - started;
    assert.ok(error, "the run still fails as an exit failure when the reaper hangs");
    assert.equal(error.kind, "exit");
    assert.equal(error.exitCode, 1);
    assert.equal(calls.length, 1, "exactly one reaper call");
    assert.equal(calls[0].file, "taskkill.exe", "the reaper that hung is the reviewed one");
    assert.equal(calls[0].options.timeout, 2000, "the reaper call itself carries the bound");
    assert.equal(error.reaped, false, "a reaper that never answers is honestly reported as not reaped");
    assert.match(error.reapReason, /did not answer within 2000 ms/, error.reapReason);
    assert.ok(elapsed >= 1900, `the boundary waited for the reaper (${elapsed} ms)`);
    assert.ok(elapsed < 2800, `and it gave up inside the bound (${elapsed} ms)`);
  } finally {
    os.platform = realPlatform;
    childProcess.execFile = realExecFile;
    if (hung) { try { hung.kill("SIGKILL"); } catch { /* already gone */ } }
  }
});

test("SHAPE TEST (not Windows proof): the win32 branch calls taskkill with /PID <pid> /T /F and shell:false (W2)", async (t) => {
  // This is a shape test on a Linux host: the platform is stubbed so the win32 branch is taken, and
  // the reaper's execFile is stubbed so the exact call can be read. It proves the arguments and the
  // options the Windows code path uses. It does NOT prove anything about Windows itself — no
  // taskkill.exe, no TerminateProcess, no job object was observed here.
  const os = require("node:os");
  const childProcess = require("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-win32-shape-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const childScript = path.join(root, "hang.js");
  await fs.writeFile(childScript, 'console.log("child pid " + process.pid); setTimeout(() => {}, 30000);');
  const calls = [];
  const realPlatform = os.platform;
  const realExecFile = childProcess.execFile;
  os.platform = () => "win32";
  childProcess.execFile = (file, args, options, callback) => {
    calls.push({ file, args, options });
    setImmediate(() => callback(null, "", ""));
    return { kill: () => true };
  };
  try {
    const error = await runProcess(node, [childScript], { cwd: root, timeout: 400, retry: false }).then(
      () => null,
      (caught) => caught,
    );
    assert.ok(error, "the run still fails as a timeout when the reaper is stubbed");
    assert.equal(error.kind, "timeout");
    assert.equal(error.timeoutMs, 400);
    assert.equal(error.attempts, 1);
    assert.equal(error.exitCode, null);
    assert.equal(error.command, node);
    assert.equal(error.cwd, root);
    assert.match(error.message, /did not finish within 400 ms per attempt/);

    assert.equal(calls.length, 1, "exactly one reaper call");
    assert.equal(calls[0].file, "taskkill.exe");
    assert.deepEqual(calls[0].args.slice(0, 1), ["/PID"], `the first argument is /PID: ${JSON.stringify(calls[0].args)}`);
    assert.ok(/^\d+$/.test(calls[0].args[1]), `the pid is passed as a string: ${JSON.stringify(calls[0].args)}`);
    assert.deepEqual(calls[0].args.slice(2), ["/T", "/F"], "/T takes the tree, /F forces it");
    assert.deepEqual(calls[0].args, ["/PID", calls[0].args[1], "/T", "/F"]);
    assert.equal(calls[0].args[1], String(pidOf(error.stdout, "child")), "the tree is taken from the direct child's own pid");
    assert.equal(calls[0].options.shell, false, "the reaper is not a shell");
    assert.equal(calls[0].options.windowsHide, true, "no console window flashes on the desktop");
    assert.equal(calls[0].options.maxBuffer, MAX_BUFFER_BYTES);
    assert.ok(calls[0].options.timeout > 0, "the reaper itself is bounded, so it cannot hang the step");
  } finally {
    os.platform = realPlatform;
    childProcess.execFile = realExecFile;
  }
});

test("the timeout and cancellation error shape the rest of the toolkit reads is unchanged (W2 regression)", async (t) => {
  const { root, childScript } = await treeFixture(t);
  const timedOut = await runProcess(node, [childScript], { cwd: root, timeout: 300, retry: false }).then(() => null, (e) => e);
  assert.equal(timedOut.kind, "timeout");
  assert.equal(timedOut.name, "RunError");
  assert.equal(timedOut.exitCode, null);
  assert.equal(timedOut.launchCode, null);
  assert.equal(timedOut.attempts, 1, "one bounded attempt ran");
  assert.equal(timedOut.command, node);
  assert.deepEqual(timedOut.args, [childScript]);
  assert.equal(timedOut.cwd, root);
  assert.equal(typeof timedOut.durationMs, "number");
  assert.equal(typeof timedOut.stderr, "string");
  assert.equal(retryable(timedOut), true, "a timeout is still transport-shaped");

  const controller = new AbortController();
  controller.abort();
  const cancelled = await runProcess(node, [childScript], { cwd: root, timeout: 8000, signal: controller.signal, retry: true }).then(() => null, (e) => e);
  assert.equal(cancelled.kind, "cancelled");
  assert.equal(cancelled.exitCode, null);
  assert.equal(cancelled.signal, null);
  assert.equal(retryable(cancelled), false);
});

/**
 * gates.md:21 claims "No path in extension/ issues `uv lock` inside a managed runtime or a plain
 * `uv sync`." Until now the `uv lock` half was true only by inspection — nothing failed if a future
 * release added one. These tests are the enforced form of that rule: the boundary refuses the
 * command before a process exists, and the marker file proves nothing was spawned.
 */
async function fakeUv(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-policy-uv-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ran = path.join(root, "uv-actually-ran.txt");
  const uvScript = path.join(root, "uv");
  await fs.writeFile(uvScript, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(ran)}, "a uv process ran");\nconsole.log("uv ran " + process.argv.slice(2).join(" "));\n`);
  await fs.chmod(uvScript, 0o755);
  return { root, ran, uvScript };
}

test("the boundary refuses `uv lock` in a managed setup call and never spawns it (gates.md lock policy)", async (t) => {
  const { root, ran, uvScript } = await fakeUv(t);
  const error = await runProcess(uvScript, ["lock", "--project", root], { kind: "setup", cwd: root, timeout: 8000, retry: true }).then(() => null, (e) => e);
  assert.ok(error, "the command is refused");
  assert.equal(error.name, "RunError");
  assert.equal(error.kind, "policy");
  assert.equal(error.exitCode, null);
  assert.equal(error.attempts, 0, "no process ran, so no attempt is claimed");
  assert.equal(error.command, uvScript);
  assert.deepEqual(error.args, ["lock", "--project", root]);
  assert.equal(error.cwd, root);
  assert.equal(retryable(error), false, "a policy refusal is not retried");
  assert.match(error.message, /was refused before it ran: the toolkit never runs `uv lock` in a managed runtime/, error.message);
  assert.match(error.message, /does not rewrite a lockfile inside the workspace/, error.message);
  assert.match(error.message, /No process was started\./, error.message);
  assert.ok(!await fs.stat(ran).catch(() => null), "nothing was spawned");
});

test("the boundary refuses a plain `uv sync` and accepts the reviewed --locked and --frozen forms (gates.md lock policy)", async (t) => {
  const { root, ran, uvScript } = await fakeUv(t);
  const plain = await runProcess(uvScript, ["sync", "--no-dev", "--python", "3.12", "--project", root, "--no-config"], { kind: "setup", cwd: root, timeout: 8000, retry: true }).then(() => null, (e) => e);
  assert.ok(plain, "a sync with no lock mode is refused");
  assert.equal(plain.kind, "policy");
  assert.equal(plain.attempts, 0);
  assert.match(plain.message, /a managed uv sync must carry `--locked`, or the recorded `--frozen` fallback/, plain.message);
  assert.match(plain.message, /No process was started\./, plain.message);
  assert.ok(!await fs.stat(ran).catch(() => null), "nothing was spawned");

  // The shipped argument lists must pass unchanged.
  const locked = await runProcess(uvScript, ["sync", "--locked", "--no-dev", "--python", "3.12", "--project", root, "--no-config"], { kind: "setup", cwd: root, timeout: 8000 });
  assert.equal(locked.ok, true);
  assert.match(locked.stdout, /uv ran sync --locked/);
  await fs.rm(ran, { force: true });
  const frozen = await runProcess(uvScript, ["sync", "--frozen", "--no-dev", "--python", "3.12", "--project", root, "--no-config"], { kind: "setup", cwd: root, timeout: 8000 });
  assert.equal(frozen.ok, true);
  assert.match(frozen.stdout, /uv ran sync --frozen/);
  assert.equal(uvCommandPolicy(uvScript, ["--version"]), null, "a tool probe is not a managed uv command");
  assert.equal(uvCommandPolicy("python3", ["lock"]), null, "the policy is about uv, not about any tool holding the word lock");
});

test("a setup call built from an explicit environment scrubs that environment, not process.env (W11)", async () => {
  const previous = process.env;
  process.env = { PATH: process.env.PATH, HOME: process.env.HOME, UV_LOCKED: "1", UV_CACHE_DIR: "/from-editor" };
  try {
    const result = await runProcess(node, ["-e", 'console.log(JSON.stringify({ index: process.env.UV_INDEX_URL, locked: process.env.UV_LOCKED, cache: process.env.UV_CACHE_DIR, noConfig: process.env.UV_NO_CONFIG, project: process.env.UV_PROJECT_ENVIRONMENT, path: process.env.PATH }))'], {
      kind: "setup", cwd: os.tmpdir(), timeout: 8000,
      env: { PATH: process.env.PATH, UV_INDEX_URL: "https://mirror.example.org/simple/", UV_CACHE_DIR: "/from-caller" },
    });
    const seen = JSON.parse(result.stdout.trim());
    assert.equal(seen.index, undefined, "the mirror in the caller's environment is scrubbed like any other");
    assert.equal(seen.locked, undefined, "process.env is not silently merged into an explicit environment");
    assert.equal(seen.cache, "/from-caller", "the caller's environment is the base the reviewed values are applied to");
    assert.equal(seen.noConfig, "1");
    assert.equal(seen.project, path.join(os.tmpdir(), ".venv"));
    assert.ok(seen.path, "PATH still reaches the child");
  } finally {
    process.env = previous;
  }
});

test("the scrubbed-setting sentence names the environment the command was actually built from (W11)", async () => {
  const previous = process.env;
  process.env = { PATH: "/usr/bin", UV_OFFLINE: "1" };
  try {
    const error = await runProcess(node, ["-e", 'console.error("error: Request failed after 3 retries"); process.exit(2);'], {
      kind: "setup", cwd: os.tmpdir(), timeout: 8000, retry: false,
      env: { PATH: "/usr/bin", UV_INDEX_URL: "https://mirror.example.org/simple/" },
    }).then(() => null, (e) => e);
    assert.ok(error);
    assert.match(error.scrubbedUv, /removed 1 uv setting\(s\) inherited from the editor process \(UV_INDEX_URL\)/, error.scrubbedUv);
    assert.ok(!error.scrubbedUv.includes("UV_OFFLINE"), "the sentence names what the command was built from, not what the editor process happens to hold");
  } finally {
    process.env = previous;
  }
});

test("PYTHONPATH and PYTHONHOME do not reach a setup child, whatever spelling the host used (W12)", async () => {
  const previous = process.env;
  process.env = { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONPATH: "/host/site-packages", pythonhome: "/host/python", UV_CACHE_DIR: "/cache" };
  try {
    assert.deepEqual(conflictingPythonVariables(process.env).map((name) => name.toLowerCase()).sort(), ["pythonhome", "pythonpath"]);
    const env = setupEnvironment("/w/.research-toolkit/managed/worker-0.3.7", process.env);
    assert.equal(env.PYTHONPATH, undefined, "a host PYTHONPATH must not reach uv or the python uv starts for a build");
    assert.equal(env.PYTHONHOME, undefined);
    assert.equal(env.UV_CACHE_DIR, "/cache", "a cache location is still left alone");
    assert.match(scrubbedUvVariables(process.env), /python interpreter setting\(s\)/, scrubbedUvVariables(process.env));
    assert.match(scrubbedUvVariables(process.env), /PYTHONPATH/, scrubbedUvVariables(process.env));
    assert.match(scrubbedUvVariables(process.env), /pythonhome/, "the host's own spelling is named");

    const seen = JSON.parse((await runProcess(node, ["-e", 'console.log(JSON.stringify({ pythonpath: process.env.PYTHONPATH, pythonhome: process.env.PYTHONHOME }))'], { kind: "setup", cwd: os.tmpdir(), timeout: 8000 })).stdout.trim());
    assert.equal(seen.pythonpath, undefined, "the real setup child never sees it");
    assert.equal(seen.pythonhome, undefined);

    const plain = JSON.parse((await runProcess(node, ["-e", 'console.log(JSON.stringify({ pythonpath: process.env.PYTHONPATH }))'], { cwd: os.tmpdir(), timeout: 8000 })).stdout.trim());
    assert.equal(plain.pythonpath, "/host/site-packages", "the scrub is scoped to the reviewed setup calls");
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
