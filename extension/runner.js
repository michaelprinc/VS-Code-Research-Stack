"use strict";

/**
 * The extension's single process boundary.
 *
 * Every external tool the toolkit runs goes through `runProcess` here. The VSIX audit names this
 * file as the reviewed boundary and rejects a second one. Keeping it in one module is what makes
 * the 0.3.6 status reporting possible: a failure carries its command, exit code, stderr and
 * duration instead of collapsing into a canned sentence, which is how the 0.3.5 setup failures
 * became untroubleshootable.
 *
 * 0.3.7 Windows review W2 — what a stopped run actually kills. `uv sync` is not one process: it
 * spawns a managed python and wheel-build children. A bound that only terminates the direct child
 * leaves those grandchildren alive and writing into the step's own directory after the toolkit has
 * already reported the step failed and released `.setup.lock`. So the boundary now owns the whole
 * tree: the child is started in its own process group (POSIX) and a stopped run is reaped with
 * `kill(-pid)`, or with `taskkill /PID <pid> /T /F` on Windows while the direct child is still
 * alive to name its tree.
 *
 * The same reap covers a run that **ended** badly — a non-zero exit (kind "exit") or a spawn failure
 * (kind "spawn") — not only a run the toolkit stopped. A tool can exit while its own children keep
 * running: the reported field failure is `uv sync --locked` refusing and exiting 1, and a build
 * grandchild outlives it. Measured on this host before this change, the direct child was gone and
 * the RunError had been reported at 35 ms, while the orphan grandchild wrote its file at 1.2 s —
 * into the step directory, after the step had been reported failed. A run that exits 0 is left
 * alone: nothing failed, so nothing is killed.
 *
 * Why the bounded run is a `spawn` and not an `execFile` (measured on this host, Node v24.22.0):
 * `execFile` builds its own spawn options internally and passes only
 * `cwd, env, gid, shell, signal, uid, windowsHide, windowsVerbatimArguments` — `detached` is
 * dropped, so an `execFile` child keeps the toolkit's own process group and `kill(-child.pid)`
 * would aim at the editor's group instead of the tool's. `execFile` is still the call site for the
 * Windows reaper, which needs no group of its own. The bounds are unchanged: `shell: false`,
 * `windowsHide: true`, `maxBuffer: MAX_BUFFER_BYTES`, one timeout per attempt, one call site.
 */

const path = require("node:path");
const os = require("node:os");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const { isLockDrift } = require("./lockfile");

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const REPORT_LIMIT = 64 * 1024;
const STDERR_TAIL_LINES = 6;
const RETRY_DELAY_MS = 2000;
const MAX_ATTEMPTS = 2;
/** The Windows tree reaper and how long the boundary is willing to wait for it (W2). */
const TASKKILL = "taskkill.exe";
const REAP_BOUND_MS = 2000;

/**
 * The interpreter flags every Python child this toolkit starts is given (0.3.8).
 *
 * `-I` isolation is what keeps a workspace's own files out of the worker's `sys.path`, and it also
 * makes `PYTHONIOENCODING` inert: measured on this host, `PYTHONIOENCODING=cp1252 python -I -c
 * "print('Č')"`. The variable is ignored, so the parent cannot make the child's stdio UTF-8
 * through the environment. `-X utf8` is the flag that does it, whatever the Windows console code
 * page is. The worker states the same promise itself (`src/research_stack/stdio.py`), which is
 * what covers a managed runtime from an older toolkit that this release can still activate.
 */
const PYTHON_FLAGS = ["-I", "-B", "-X", "utf8"];

/**
 * `/T` takes the whole tree rooted at the pid, `/F` forces it. The pid must still be alive when
 * this runs, which is why the reaper is called before the direct child is terminated.
 */
function taskkillArguments(pid) {
  return ["/PID", String(pid), "/T", "/F"];
}

/**
 * Kill everything the run left behind — a stopped run, or a run that exited badly with its own
 * children still alive — and never let the reaping itself become the failure.
 *
 * The returned promise always resolves — with what was reaped or with the reason it could not be.
 * A reaper that could reject is an unhandled rejection in the extension host, and a reaper with no
 * bound is a step that never reports.
 */
function reapTree(child) {
  const pid = child && child.pid;
  if (!pid) return Promise.resolve({ reaped: false, target: "no pid", reason: "the child never got a pid" });

  if (os.platform() === "win32") {
    return new Promise((resolve) => {
      let done = false;
      const finish = (outcome) => {
        if (done) return;
        done = true;
        clearTimeout(bound);
        // taskkill /T /F takes the root too; this is the backstop for the case where it refused.
        try { child.kill("SIGKILL"); } catch { /* the tree is already gone */ }
        resolve(outcome);
      };
      const bound = setTimeout(() => finish({ reaped: false, target: `${TASKKILL} /PID ${pid} /T /F`, reason: `${TASKKILL} did not answer within ${REAP_BOUND_MS} ms` }), REAP_BOUND_MS);
      try {
        childProcess.execFile(TASKKILL, taskkillArguments(pid), {
          timeout: REAP_BOUND_MS, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true, shell: false, cwd: os.tmpdir(),
        }, (error) => finish(error
          ? { reaped: false, target: `${TASKKILL} /PID ${pid} /T /F`, reason: `${TASKKILL} exited with ${error.code || error.signal || error.message}` }
          : { reaped: true, target: `${TASKKILL} /PID ${pid} /T /F` }));
      } catch (error) {
        finish({ reaped: false, target: `${TASKKILL} /PID ${pid} /T /F`, reason: `${TASKKILL} could not start: ${error.code || error.message}` });
      }
    });
  }

  // The child leads its own group (see `detached` in `execute`), so the group id is the child's pid
  // and every uv grandchild is in it. ESRCH means the group is already empty.
  try {
    process.kill(-pid, "SIGKILL");
    return Promise.resolve({ reaped: true, target: `process group -${pid}` });
  } catch (error) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    return Promise.resolve({ reaped: false, target: `process group -${pid}`, reason: `kill(-${pid}) ${error.code || error.message}` });
  }
}

/** Reviewer-visible bounds. This is the only call site of the reviewed process boundary. */
function execute(executable, args, options) {
  const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd || os.tmpdir();
  return new Promise((resolve, reject) => {
    const call = { executable, args, cwd, timeout: timeoutMs, stdout: "", stderr: "" };
    if (options.signal && options.signal.aborted) {
      // Cancelled before anything ran: do not start a process that is about to be killed.
      reject(classify(cancelledError(), call));
      return;
    }

    const child = childProcess.spawn(executable, args, {
      cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      // POSIX only: the child becomes its own group and session leader so `kill(-pid)` can take the
      // whole tree. On Windows the tree is taken by `taskkill /T` instead.
      detached: os.platform() !== "win32",
    });

    const out = { parts: [], total: 0 };
    const err = { parts: [], total: 0 };
    let overflow = false;
    let stopped = null;
    let spawnError = null;
    let exitInfo = null;
    let reapPromise = null;
    let reapOutcome = null;
    let timer = null;
    let reapBound = null;
    let abortListener = null;
    let settled = false;

    const collect = (stream, sink) => {
      if (!stream) return;
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (sink.total >= MAX_BUFFER_BYTES) {
          if (!overflow) { overflow = true; stop("buffer"); }
          return;
        }
        sink.parts.push(chunk);
        sink.total += chunk.length;
      });
      // A killed child's stream errors are a consequence of the kill, never the failure itself.
      stream.on("error", () => {});
    };
    collect(child.stdout, out);
    collect(child.stderr, err);

    const clear = () => {
      if (timer) clearTimeout(timer);
      if (reapBound) clearTimeout(reapBound);
      if (abortListener && options.signal) options.signal.removeEventListener("abort", abortListener);
    };

    /**
     * Reap the child's tree. The rejection waits for the reaper so the step is not reported failed
     * while a uv grandchild is still writing into the step's directory — bounded by REAP_BOUND_MS so
     * a reaper that never answers cannot hang the promise.
     */
    const beginReap = () => {
      if (reapPromise) return;
      reapBound = setTimeout(() => settle(true), REAP_BOUND_MS);
      reapPromise = reapTree(child);
      reapPromise.then((outcome) => { reapOutcome = outcome; settle(false); }, (error) => {
        // reapTree is written never to reject; this is the belt on the braces.
        reapOutcome = { reaped: false, target: "reaper", reason: `the reaper raised ${error && error.message}` };
        settle(false);
      });
    };

    /** Stop a run that is still going and reap its tree. */
    const stop = (cause) => {
      if (reapPromise) return;
      stopped = stopped || cause;
      beginReap();
    };

    const settle = (forced) => {
      if (settled) return;
      const childGone = Boolean(spawnError || exitInfo);
      // A run that ended badly can still have left the tree alive: the direct child is gone but its
      // build grandchild is not, and the grandchild writes into the step directory after the step
      // has been reported failed. Reap before reporting; a clean exit 0 is left alone.
      const failed = Boolean(spawnError) || overflow || Boolean(stopped)
        || Boolean(exitInfo && (exitInfo.code !== 0 || exitInfo.signal !== null));
      if (!forced && childGone && failed && !reapPromise) { beginReap(); return; }
      const reaperAnswered = !reapPromise || Boolean(reapOutcome);
      if (!forced && (!childGone || !reaperAnswered)) return;
      settled = true;
      clear();
      if (forced) {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        // The bound expired before the reaper answered. Say so rather than report a failure that
        // looks like no reap was attempted.
        if (reapPromise && !reapOutcome) {
          reapOutcome = { reaped: false, target: "reaper", reason: `the reaper did not answer within ${REAP_BOUND_MS} ms` };
        }
      }
      const stdout = out.parts.join("");
      const stderr = err.parts.join("");
      const evidence = { ...call, stdout, stderr };
      /** Every failure the boundary reports carries what the reaper did, when it ran one. */
      const rejectFailure = (runError) => {
        if (reapOutcome) {
          runError.reaped = reapOutcome.reaped;
          runError.reapTarget = reapOutcome.target;
          if (reapOutcome.reason) runError.reapReason = reapOutcome.reason;
        }
        reject(runError);
      };
      if (spawnError) { rejectFailure(classify(spawnError, evidence)); return; }
      const code = exitInfo ? exitInfo.code : null;
      const signal = exitInfo ? exitInfo.signal : null;
      if (!forced && !overflow && !stopped && code === 0 && signal === null) {
        resolve({ stdout, stderr });
        return;
      }
      rejectFailure(classify(stoppedError({ stopped, overflow, code, signal, timeoutMs }), evidence));
    };

    child.on("exit", (code, signal) => { exitInfo = { code, signal }; settle(false); });
    child.on("error", (error) => { spawnError = error; settle(false); });

    timer = setTimeout(() => stop("timeout"), timeoutMs);
    if (options.signal) {
      abortListener = () => stop("cancelled");
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}

function cancelledError() {
  const error = new Error("The run was aborted");
  error.name = "AbortError";
  return error;
}

/**
 * Shape the exit into the error `classify` already understands, so a spawn-based boundary reports
 * exactly the kinds the rest of the toolkit was reviewed against: cancelled, timeout, buffer, exit.
 */
function stoppedError({ stopped, overflow, code, signal, timeoutMs }) {
  if (stopped === "cancelled") return cancelledError();
  if (overflow) {
    const error = new Error(`Exceeded the ${MAX_BUFFER_BYTES} byte capture limit`);
    error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    error.signal = signal || null;
    return error;
  }
  if (stopped === "timeout") {
    const error = new Error(`Command timed out after ${timeoutMs} ms`);
    error.killed = true;
    error.signal = signal || null;
    return error;
  }
  const error = new Error("Command failed");
  error.code = typeof code === "number" ? code : null;
  error.signal = signal || null;
  return error;
}

function classify(error, call) {
  const code = error.code;
  const kind = call.cwdProblem ? "cwd"
    : error.name === "AbortError" ? "cancelled"
    : code === "ETIMEDOUT" || error.killed ? "timeout"
    : code === "ENOENT" || code === "EACCES" || code === "ENOEXEC" ? "spawn"
    : String(code).includes("MAXBUFFER") ? "buffer"
    : "exit";
  const runError = new Error("run failure");
  runError.name = "RunError";
  runError.kind = kind;
  runError.exitCode = typeof error.code === "number" ? error.code : null;
  runError.launchCode = typeof code === "string" ? code : null;
  runError.signal = error.signal || null;
  runError.command = call.executable;
  runError.args = call.args;
  runError.cwd = call.cwd;
  runError.timeoutMs = call.timeout;
  // Node does not always attach the captured streams to the error object, so the callback
  // values are the primary source and the error properties are the fallback.
  runError.stdout = truncate(String(call.stdout || error.stdout || (error.buffer ? error.buffer.toString() : "") || ""));
  runError.stderr = truncate(String(call.stderr || error.stderr || ""));
  return runError;
}

function truncate(text) {
  if (text.length <= REPORT_LIMIT) return text;
  // Keep both ends. uv prints the actionable refusal last ("The lockfile at `uv.lock` needs to be
  // updated…") and the context first; cutting the tail would remove the sentence the lock-drift
  // detection depends on, cutting the head would remove which command failed.
  const half = Math.floor(REPORT_LIMIT / 2);
  return `${text.slice(0, half)} … ${text.length - REPORT_LIMIT} characters omitted … ${text.slice(-half)}`;
}

/** Last useful stderr lines: what an operator actually needs to see. */
function stderrTail(text, limit = STDERR_TAIL_LINES) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-limit).join(" | ");
}

/**
 * A tool that died while writing its own result (0.3.8).
 *
 * The 0.3.7 field failure is `{"error": "'charmap' codec can't encode character '\\u010d' in
 * position 67: character maps to <undefined>"}` from `python.exe -I -B -m research_stack.cli
 * init-lab` in a Czech workspace on a cp1252 host: the store was created, and the worker then
 * could not print the report that proves it. Naming the class matters because the generic exit
 * sentence points the operator at the tool, while the cause is the host's console encoding.
 */
const CODEC_SIGNATURE = /codec can't (?:en|de)code|UnicodeEncodeError|UnicodeDecodeError|character maps to <undefined>/i;

function isCodecFailure(runError) {
  return CODEC_SIGNATURE.test(`${(runError && runError.stderr) || ""}\n${(runError && runError.message) || ""}`);
}

function describe(runError, hint) {
  const subject = `${path.basename(runError.command)} ${runError.args && runError.args.length ? runError.args[0] : ""}`.trim();
  const tail = stderrTail(runError.stderr);
  const where = `cwd ${runError.cwd}`;
  const seconds = (ms) => `${ms >= 1000 ? Math.round(ms / 1000) : ms} ${ms >= 1000 ? "s" : "ms"}`;
  if (runError.kind === "cancelled") return `${subject} was cancelled. Completed files were preserved; run setup again to resume.`;
  if (runError.kind === "policy") return `${subject} was refused before it ran: ${runError.policyReason || LOCK_POLICY_SENTENCE} (${where}). No process was started.`;
  if (runError.kind === "timeout") {
    // The bound is per attempt. When more than one attempt ran, the operator waited for all of them,
    // and saying so is the difference between "increase the timeout" and "the network is the problem".
    const attempts = Number(runError.attempts) || 1;
    const wall = runError.durationMs === undefined ? "" : ` Total time waited across ${attempts} attempt(s): ${seconds(runError.durationMs)}.`;
    return `${subject} did not finish within ${seconds(runError.timeoutMs)} per attempt (${attempts} attempt(s) ran) (${where}).${wall} Increase the setup timeout or check network/proxy access, then retry.`;
  }
  if (runError.kind === "spawn") return `${subject} could not be launched (${runError.launchCode || "spawn failed"}). Install or configure the tool, then retry.`;
  if (runError.kind === "cwd") return `${subject} cannot run in ${runError.cwd}: the working directory ${runError.launchCode === "ELOOP" ? "is a link, not a directory" : "does not exist"}. Setup writes only inside the workspace folder.`;
  if (runError.kind === "buffer") return `${subject} produced more output than the ${Math.round(MAX_BUFFER_BYTES / 1024)} KiB capture limit (${where}). The output was truncated; the run was stopped.`;
  if (runError.kind === "exit" && isLockDrift(runError)) {
    return `${subject} refused the locked dependency file: ${tail} (${where}). This is a lockfile disagreement — not a network, proxy or interpreter problem; the toolkit's own check of the pair says whether this build is broken or this host's uv disagreed with a lockfile the toolkit reads as current. ${hint || "Retry setup; if it repeats, report this build."}${runError.scrubbedUv || ""}`;
  }
  if (runError.kind === "exit" && isCodecFailure(runError)) {
    return `${subject} could not write its own result in this host's console encoding: ${tail} (${where}). This is a text-encoding failure, not a network, proxy or interpreter problem. This release starts every Python child with \`-X utf8\` and its worker states UTF-8 output itself, so re-run setup; if it repeats, the tool being run is not the toolkit's own worker.`;
  }
  return `${subject} failed with exit code ${runError.exitCode === null ? runError.signal || runError.launchCode : runError.exitCode}${tail ? `: ${tail}` : ""} (${where})${hint ? ` ${hint}` : ""}${runError.scrubbedUv || ""}`;
}

/**
 * Transport-shaped failures are worth one more attempt; a missing binary or a refusal is not.
 *
 * The decision reads the tool's **stderr** and the failure message only. stdout is ordinary
 * program output: a tool that prints "502" in a progress line is not a transport failure, and
 * retrying it runs the same command a second time for no reason. uv's own transient shape
 * ("Request failed after 3 retries") is included because uv reports an exhausted internal retry
 * on stderr and a second attempt from the toolkit is a different request. A certificate failure
 * is not transient: it is a configuration or proxy problem, and retrying it hides it behind a
 * slower failure.
 */
const TRANSIENT_PATTERNS = /timed? out|timeout|connection|network|proxy|TLS|SSL|temporary failure|try again|50[234]|read timeout|Temporary failure in name resolution|Could not resolve|failed after \d+ retries|Request failed after \d+ retries/i;

function retryable(runError) {
  if (runError.kind === "timeout" || runError.kind === "buffer") return true;
  if (runError.kind !== "exit") return false;
  return TRANSIENT_PATTERNS.test(`${runError.stderr || ""}\n${runError.message || ""}`);
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/**
 * Environment policy for the reviewed uv setup calls. Kept in one place so it is auditable.
 *
 * `--no-config` disables persistent configuration **files**; uv states that environment variables
 * take precedence over them. A host's `UV_INDEX_URL`, `UV_LOCKED`, `UV_OFFLINE` or `UV_NO_DEV`
 * therefore changes what the reviewed command means — including making a byte-correct lockfile look
 * stale — so the variables that alter the command's meaning are removed before the reviewed values
 * are set. Cache location, keyring and concurrency are left alone: they change cost, not meaning.
 */
const REVIEWED_UV_ENVIRONMENT = {
  UV_PYTHON_DOWNLOADS: "automatic",
  UV_PYTHON: "3.12",
  UV_LINK_MODE: "copy",
  UV_NO_PROGRESS: "1",
  UV_NO_CONFIG: "1",
};
const CONFLICTING_UV_VARIABLES = [
  "UV_INDEX", "UV_INDEX_URL", "UV_DEFAULT_INDEX", "UV_EXTRA_INDEX_URL", "UV_FIND_LINKS", "UV_NO_INDEX",
  "UV_LOCKED", "UV_FROZEN", "UV_UPGRADE", "UV_NO_SYNC", "UV_OFFLINE", "UV_NO_DEV", "UV_SYSTEM_PYTHON",
  "UV_EXCLUDE_NEWER", "UV_PYTHON_PREFERENCE",
];
// W12: the toolkit's own python calls are isolated with `-I`, but a python that **uv** starts for a
// source build is not. Measured with uv 0.13.6 building a package whose PEP 517 backend dumps its own
// environment: `isolated 0`, `no_site 0`, `safe_path false`, `PYTHONPATH` present in the child's
// environment **and** in its `sys.path`. A host `PYTHONPATH` therefore reaches the code that builds a
// locked dependency, and `PYTHONHOME` can point that python at the wrong prefix.
const CONFLICTING_PYTHON_VARIABLES = ["PYTHONHOME", "PYTHONPATH"];
// Windows environment names are case-insensitive and Node keeps the OS spelling in `process.env`, so a
// host can hold `uv_locked` or `Uv_Index_Url`. Matching only the exact spellings let such a variable
// reach `uv.exe` — where it is the same setting — while the toolkit reported that it had removed it.
// `uv sync --locked` with a host `UV_EXCLUDE_NEWER` set fails with uv's lockfile-staleness sentence,
// which is exactly the symptom this release was asked to fix.
const CONFLICTING_UV_NAMES = new Set(
  [...CONFLICTING_UV_VARIABLES, ...Object.keys(REVIEWED_UV_ENVIRONMENT), "UV_PROJECT_ENVIRONMENT"].map((name) => name.toLowerCase()),
);
const CONFLICTING_PYTHON_NAMES = new Set(CONFLICTING_PYTHON_VARIABLES.map((name) => name.toLowerCase()));
// Reported in the reviewed order so the same host always produces the same sentence.
const OVERRIDDEN_UV_VARIABLES = [...CONFLICTING_UV_VARIABLES, ...Object.keys(REVIEWED_UV_ENVIRONMENT), "UV_PROJECT_ENVIRONMENT"];

function matchingNames(candidates, environment) {
  const hostNames = Object.keys(environment);
  return candidates.flatMap((candidate) => hostNames.filter((name) => name.toLowerCase() === candidate.toLowerCase()));
}

function conflictingUvVariables(environment = process.env) {
  return matchingNames(OVERRIDDEN_UV_VARIABLES, environment);
}

function conflictingPythonVariables(environment = process.env) {
  return matchingNames(CONFLICTING_PYTHON_VARIABLES, environment);
}

/**
 * Build the environment a setup call actually receives. `base` is the environment the caller asked
 * for — `options.env` when one was given, the editor process otherwise — so the caller's own
 * environment is the thing being scrubbed (W11), not an unrelated `process.env`.
 */
function setupEnvironment(cwd, environment = process.env) {
  const kept = {};
  for (const [name, value] of Object.entries(environment)) {
    // Every name the toolkit sets itself is dropped from the inherited environment too, whatever the
    // host spelled it: a host `uv_link_mode=hardlink` sitting beside `UV_LINK_MODE=copy` leaves the
    // child free to read the host's copy, and `copy` was chosen precisely to avoid the Windows
    // cross-device hardlink failure. The python interpreter variables are dropped for the same
    // reason: they change which interpreter a uv-spawned build runs, which is meaning, not cost.
    if (CONFLICTING_UV_NAMES.has(name.toLowerCase()) || CONFLICTING_PYTHON_NAMES.has(name.toLowerCase())) continue;
    kept[name] = value;
  }
  return {
    ...kept,
    ...REVIEWED_UV_ENVIRONMENT,
    ...(cwd ? { UV_PROJECT_ENVIRONMENT: path.join(cwd, ".venv") } : {}),
  };
}

/**
 * What the toolkit removed from the inherited environment, in the operator's own terms. Stripping a
 * variable silently makes a host-specific problem look like a generic one, so the names are reported
 * alongside the failure they may have caused — and they are the names of the environment the command
 * was actually built from (W11), not of whatever the editor process happens to hold.
 */
function scrubbedUvVariables(environment = process.env) {
  const uvNames = conflictingUvVariables(environment);
  const pythonNames = conflictingPythonVariables(environment);
  if (!uvNames.length && !pythonNames.length) return "";
  if (!pythonNames.length) {
    return ` Before this command ran, the toolkit removed ${uvNames.length} uv setting(s) inherited from the editor process (${uvNames.join(", ")}) and applied its own reviewed uv settings; if this command depends on those settings, run it yourself in a terminal.`;
  }
  const parts = [];
  if (uvNames.length) parts.push(`${uvNames.length} uv setting(s) (${uvNames.join(", ")})`);
  if (pythonNames.length) parts.push(`${pythonNames.length} python interpreter setting(s) (${pythonNames.join(", ")})`);
  return ` Before this command ran, the toolkit removed ${uvNames.length + pythonNames.length} setting(s) inherited from the environment this command was built from — ${parts.join(" and ")} — and applied its own reviewed uv settings; if this command depends on those settings, run it yourself in a terminal.`;
}

/**
 * gates.md: "No path in extension/ issues `uv lock` inside a managed runtime or a plain `uv sync`."
 * The claim used to be true only by inspection. It is enforced here, at the one place a tool can be
 * started, so a future release cannot add `uv lock` to a managed step without a test failing.
 */
const UV_EXECUTABLE_NAME = /^uv(\.exe|\.cmd|\.bat|\.com)?(-[\w.]+)?$/i;
const LOCK_POLICY_SENTENCE = "the toolkit never runs `uv lock` in a managed runtime and never runs a plain `uv sync`";

/** @returns the refusal reason, or null when the command is one the toolkit is allowed to run. */
function uvCommandPolicy(executable, args) {
  const name = path.basename(String(executable || "")).toLowerCase();
  if (!UV_EXECUTABLE_NAME.test(name)) return null;
  const list = (Array.isArray(args) ? args : []).map((arg) => String(arg));
  if (list.includes("lock")) {
    return { reason: "the toolkit never runs `uv lock` in a managed runtime — it does not rewrite a lockfile inside the workspace, it installs from the lockfile this build ships" };
  }
  if (list.includes("sync") && !list.includes("--locked") && !list.includes("--frozen")) {
    return { reason: "a managed uv sync must carry `--locked`, or the recorded `--frozen` fallback — a plain `uv sync` would resolve dependencies outside the lockfile this build ships" };
  }
  return null;
}

/**
 * Run one bounded external tool invocation.
 *
 * @returns { ok, stdout, stderr, exitCode, durationMs, attempts, truncated, command, args, cwd }
 * @throws RunError with kind, exit code, stderr tail, duration and the command that produced them.
 */
async function runProcess(executable, args, options = {}) {
  const started = Date.now();
  const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;
  // A working directory is only used when it is a real directory in the workspace: a missing or
  // link-redirected directory would run the tool somewhere the plan never intended.
  if (options.cwd) {
    const info = await fs.lstat(options.cwd).catch(() => null);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) {
      const cwdProblem = info ? "it is a link, not a directory" : "it does not exist";
      // The refusal is a RunError like any other outcome, so it goes through describe() before it
      // is thrown: the GUI gets the directory and the reason, not the classify() placeholder
      // "run failure". No process ran, so the attempt count is 0 and the kind stays non-retryable.
      const rejection = classify(Object.assign(new Error(cwdProblem), { code: info ? "ELOOP" : "ENOENT" }), {
        executable, args, cwd: options.cwd, timeout: timeoutMs, stdout: "", stderr: "", cwdProblem,
      });
      rejection.attempts = 0;
      rejection.durationMs = Date.now() - started;
      rejection.hint = options.hint || "";
      rejection.message = describe(rejection, rejection.hint);
      throw rejection;
    }
  }
  // The reviewed uv commands are the ones a managed directory is built from. A call that would
  // rewrite the lockfile, or resolve outside it, is refused here rather than discovered later in
  // uv's own output — and nothing is spawned, so nothing can have been written.
  const policy = options.kind === "setup" ? uvCommandPolicy(executable, args) : null;
  if (policy) {
    const rejection = classify(new Error(policy.reason), { executable, args, cwd: options.cwd || os.tmpdir(), timeout: timeoutMs, stdout: "", stderr: "" });
    rejection.kind = "policy";
    rejection.policyReason = policy.reason;
    rejection.attempts = 0;
    rejection.durationMs = Date.now() - started;
    rejection.hint = options.hint || "";
    rejection.message = describe(rejection, rejection.hint);
    throw rejection;
  }
  const baseEnvironment = options.env || process.env;
  const attemptLimit = options.retry ? MAX_ATTEMPTS : 1;
  let lastError;
  let attemptsRun = 0;
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    attemptsRun = attempt;
    try {
      const output = await execute(executable, args, {
        timeout: options.timeout, cwd: options.cwd, signal: options.signal,
        env: options.kind === "setup" ? setupEnvironment(options.cwd, baseEnvironment) : options.env,
      });
      const durationMs = Date.now() - started;
      return {
        ok: true,
        stdout: truncate(output.stdout),
        stderr: truncate(output.stderr),
        stdoutChars: output.stdout.length,
        truncated: output.stdout.length > REPORT_LIMIT || output.stderr.length > REPORT_LIMIT,
        exitCode: 0,
        durationMs,
        attempts: attempt,
        command: executable,
        args,
        cwd: options.cwd || os.tmpdir(),
      };
    } catch (error) {
      lastError = error;
      if (error.kind === "cancelled" || !options.retry || !retryable(error) || attempt >= attemptLimit) break;
      await delay(RETRY_DELAY_MS, options.signal);
      if (options.signal && options.signal.aborted) {
        lastError = { ...lastError };
        lastError.kind = "cancelled";
        break;
      }
    }
  }
  lastError.durationMs = Date.now() - started;
  // The attempts that actually ran. The loop breaks early for a non-retryable failure, so
  // reporting the limit here would tell the operator "2 attempts" when one process ran.
  lastError.attempts = attemptsRun;
  lastError.hint = options.hint || "";
  if (options.kind === "setup") lastError.scrubbedUv = scrubbedUvVariables(baseEnvironment);
  lastError.message = describe(lastError, lastError.hint);
  throw lastError;
}

/**
 * Adapter for callers and test fixtures that provide the 0.3.x `runFile` service instead of
 * `runProcess`. It keeps one process boundary while letting injected fakes stay unchanged.
 */
function asRunProcess(services = {}) {
  if (typeof services.runProcess === "function") return services.runProcess;
  if (typeof services.runFile === "function") {
    return async (executable, args, options = {}) => {
      const stdout = await services.runFile(executable, args, options);
      return { ok: true, stdout: String(stdout || ""), stderr: "", stdoutChars: String(stdout || "").length, truncated: false, exitCode: 0, durationMs: 0, attempts: 1, command: executable, args, cwd: options.cwd || "" };
    };
  }
  return runProcess;
}

/** 0.3.x-compatible wrapper: resolves trimmed stdout, rejects with an evidence-based message. */
async function runFile(executable, args, options = {}) {
  const result = await runProcess(executable, args, options);
  return result.stdout.trim();
}

module.exports = {
  DEFAULT_TIMEOUT_MS, asRunProcess, MAX_BUFFER_BYTES, REPORT_LIMIT, RETRY_DELAY_MS, MAX_ATTEMPTS,
  CONFLICTING_UV_VARIABLES, REVIEWED_UV_ENVIRONMENT, PYTHON_FLAGS, CODEC_SIGNATURE,
  runProcess, runFile, describe, retryable, stderrTail, setupEnvironment, conflictingUvVariables, conflictingPythonVariables, scrubbedUvVariables, uvCommandPolicy, isCodecFailure,
};
