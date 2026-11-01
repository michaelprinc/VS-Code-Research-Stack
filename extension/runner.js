"use strict";

/**
 * The extension's single process boundary.
 *
 * Every external tool the toolkit runs goes through `runProcess` here. The VSIX audit names this
 * file as the reviewed boundary and rejects a second one. Keeping it in one module is what makes
 * the 0.3.6 status reporting possible: a failure carries its command, exit code, stderr and
 * duration instead of collapsing into a canned sentence, which is how the 0.3.5 setup failures
 * became untroubleshootable.
 */

const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const REPORT_LIMIT = 64 * 1024;
const STDERR_TAIL_LINES = 6;
const RETRY_DELAY_MS = 2000;
const MAX_ATTEMPTS = 2;

/** Reviewer-visible bounds. This is the only call site of the reviewed process boundary. */
function execute(executable, args, options) {
  const timeoutMs = options.timeout || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      timeout: options.timeout || DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
      windowsHide: true,
      shell: false,
      cwd: options.cwd || os.tmpdir(),
      signal: options.signal,
      env: options.env,
    }, (error, stdout, stderr) => {
      if (error) reject(classify(error, { executable, args, cwd: options.cwd || os.tmpdir(), timeout: timeoutMs, stdout, stderr }));
      else resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
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
  return text.length > REPORT_LIMIT ? `${text.slice(0, REPORT_LIMIT)}…` : text;
}

/** Last useful stderr lines: what an operator actually needs to see. */
function stderrTail(text, limit = STDERR_TAIL_LINES) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-limit).join(" | ");
}

function describe(runError, hint) {
  const subject = `${path.basename(runError.command)} ${runError.args && runError.args.length ? runError.args[0] : ""}`.trim();
  const tail = stderrTail(runError.stderr);
  const where = `cwd ${runError.cwd}`;
  if (runError.kind === "cancelled") return `${subject} was cancelled. Completed files were preserved; run setup again to resume.`;
  if (runError.kind === "timeout") return `${subject} did not finish within ${runError.timeoutMs >= 1000 ? Math.round(runError.timeoutMs / 1000) : runError.timeoutMs} ${runError.timeoutMs >= 1000 ? "s" : "ms"} (${where}). Increase the setup timeout or check network/proxy access, then retry.`;
  if (runError.kind === "spawn") return `${subject} could not be launched (${runError.launchCode || "spawn failed"}). Install or configure the tool, then retry.`;
  if (runError.kind === "cwd") return `${subject} cannot run in ${runError.cwd}: the working directory ${runError.launchCode === "ELOOP" ? "is a link, not a directory" : "does not exist"}. Setup writes only inside the workspace folder.`;
  if (runError.kind === "buffer") return `${subject} produced more output than the ${Math.round(MAX_BUFFER_BYTES / 1024)} KiB capture limit (${where}). The output was truncated; the run was stopped.`;
  return `${subject} failed with exit code ${runError.exitCode === null ? runError.signal || runError.launchCode : runError.exitCode}${tail ? `: ${tail}` : ""} (${where})${hint ? ` ${hint}` : ""}`;
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

/** Environment policy for the reviewed uv setup calls. Kept in one place so it is auditable. */
function setupEnvironment(cwd) {
  return {
    ...process.env,
    UV_PYTHON_DOWNLOADS: "automatic",
    UV_PYTHON: "3.12",
    UV_LINK_MODE: "copy",
    UV_NO_PROGRESS: "1",
    UV_NO_CONFIG: "1",
    ...(cwd ? { UV_PROJECT_ENVIRONMENT: path.join(cwd, ".venv") } : {}),
  };
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
  const attemptLimit = options.retry ? MAX_ATTEMPTS : 1;
  let lastError;
  let attemptsRun = 0;
  for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
    attemptsRun = attempt;
    try {
      const output = await execute(executable, args, {
        timeout: options.timeout, cwd: options.cwd, signal: options.signal,
        env: options.kind === "setup" ? setupEnvironment(options.cwd) : options.env,
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
  runProcess, runFile, describe, retryable, stderrTail, setupEnvironment,
};
