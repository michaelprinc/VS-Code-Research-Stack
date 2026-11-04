"use strict";
/** Step-level contracts: per-step timeouts from the registry, and uv resolution before any run. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { stepTimeout, resolveUv, lockFallbackNote, notebookPairProblems, runNotebookStep, runLabStoreStep, digestOf } = require("../steps");
const { STEPS_BY_ID, commandLine, rerunInstruction } = require("../installer");
const { runProcess } = require("../runner");
// The Python argv shape comes from the shipped runner, not from a fixture's memory of it (0.3.8).
const { PYTHON_FLAGS, pythonArgv } = require("./python-argv");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");

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

test("the notebook step gets the same one bounded lockfile fallback as the worker step (0.3.7 e2e defect 2)", async (t) => {
  const os = require("node:os");
  const fs = require("node:fs/promises");
  const { runNotebookStep } = require("../steps");
  const { makeHarness } = require("./harness");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-notebook-fallback-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const harness = makeHarness({ folders: [{ name: "research", uri: { scheme: "file", fsPath: dir } }] });
  const project = path.join(dir, "notebooks", "analysis");
  const calls = [];
  const services = {
    async resolveHostTool(name) { return { name, path: "/trusted/uv", source: "path", version: "0.13.6", verified: true, searched: {}, hint: "" }; },
    async runProcess(executable, args) {
      calls.push({ executable, args });
      if (args[0] === "sync") {
        if (args[1] === "--locked") {
          const error = new Error("run failure");
          error.kind = "exit"; error.exitCode = 1; error.attempts = 1;
          error.stderr = "Resolved 40 packages in 63ms\nerror: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.\nhint: To update the lockfile, run `uv lock`.";
          throw error;
        }
        const python = path.join(project, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
        await fs.mkdir(path.dirname(python), { recursive: true });
        await fs.writeFile(python, "fixture interpreter");
        return { stdout: "3.12.16 (main)\n", stderr: "", durationMs: 12 };
      }
      return { stdout: "3.12.16 (main)\n", stderr: "", durationMs: 5 };
    },
  };
  const result = await runNotebookStep({ root: dir, context: harness.context, services, settings: {}, step: STEPS_BY_ID.get("notebook-env"), vscode: harness.vscode });
  const syncs = calls.filter((call) => call.args[0] === "sync");
  assert.deepEqual(syncs.map((call) => call.args[1]), ["--locked", "--frozen"], "one locked attempt, one frozen fallback, nothing else");
  assert.ok(!syncs.some((call) => call.args[1] === "--locked" && call.args.includes("lock")), "the step never runs `uv lock` in the workspace");
  assert.ok(result.lockFallback, "the fallback is recorded on the step result");
  assert.match(result.evidence, /Warning: this host's uv refused the shipped lockfile/, "the component evidence names the fallback");
  assert.match(result.evidence, /without rewriting the lockfile/, result.evidence);
  assert.equal(result.attempts, 2, "two uv processes ran (locked, then frozen) and the step reports both (0.3.7 e2e D7)");

  // An ordinary notebook failure (a download problem) must not be softened into a frozen install.
  const plain = { ...services, runProcess: async (executable, args) => {
    calls.push({ executable, args });
    if (args[0] === "sync") { const error = new Error("run failure"); error.kind = "exit"; error.exitCode = 2; error.stderr = "error: failed to fetch https://pypi.org/simple/matplotlib/"; throw error; }
    return { stdout: "3.12.16\n", stderr: "", durationMs: 1 };
  } };
  const failure = await runNotebookStep({ root: dir, context: harness.context, services: plain, settings: {}, step: STEPS_BY_ID.get("notebook-env"), vscode: harness.vscode }).catch((error) => error);
  assert.equal(failure.exitCode, 2, "the runner's exit code reaches the operator");
  assert.match(failure.stderr, /failed to fetch/, "uv's own sentence is kept, not replaced by a lockfile story");
  assert.equal(failure.lockDrift, undefined, "a network failure is not reported as a lockfile problem");
  assert.deepEqual(calls.filter((call) => call.args[0] === "sync" && call.args[1] === "--frozen").length, 1, "no second fallback for an unrelated failure");
});

/** A bundle whose notebook overlay pair does not agree with itself, with the manifest re-hashed. */
async function patchedNotebookBundle(t, version) {
  const os = require("node:os");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-notebook-bundle-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.cp(path.join(__dirname, "..", "worker"), path.join(dir, "worker"), { recursive: true });
  const pyproject = path.join(dir, "worker", "overlay", "notebooks", "analysis", "pyproject.toml");
  const text = await fs.readFile(pyproject, "utf8");
  await fs.writeFile(pyproject, text.replace(/version = "0\.1\.0"/, `version = "${version}"`), "utf8");
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "worker", "bundle.json"), "utf8"));
  for (const group of ["files", "overlayFiles"]) {
    for (const relative of Object.keys(manifest[group] || {})) {
      const target = group === "overlayFiles" ? path.join(dir, "worker", "overlay", relative) : path.join(dir, "worker", relative);
      manifest[group][relative] = createHash("sha256").update(await fs.readFile(target)).digest("hex");
    }
  }
  await fs.writeFile(path.join(dir, "worker", "bundle.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { extensionUri: { fsPath: dir } };
}

async function notebookWorkspace(t, prefix) {
  const os = require("node:os");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ folders: [{ name: "research", uri: { scheme: "file", fsPath: dir } }] });
  const services = { async resolveHostTool(name) { return { name, path: "/trusted/uv", source: "path", version: "0.13.6", verified: true, searched: {}, hint: "" }; }, async runProcess() { throw new Error("no process may run in this test"); } };
  return { dir, harness, services };
}

test("a notebook pair this toolkit wrote is refused as a build defect, the way the worker pair is (0.3.7 e2e D5)", async (t) => {
  const { dir, harness, services } = await notebookWorkspace(t, "research-notebook-builddefect-");
  const context = await patchedNotebookBundle(t, "0.2.0");
  const error = await runNotebookStep({ root: dir, context, services, settings: {}, step: STEPS_BY_ID.get("notebook-env"), vscode: harness.vscode }).catch((item) => item);
  assert.match(error.message, /does not match its own project file/, error.message);
  assert.match(error.message, /This is a defect in the toolkit build, not in this workspace\./, "the build-defect wording the worker refusal uses");
  assert.equal(error.kind, "lock-drift", "the same kind the worker refusal sets, so the next-action table does not fall through to a retry");
  assert.equal(error.exitCode, null, "no process ran, so there is no exit code to report");
  assert.equal(error.attempts, 0, "no process ran, and the record says so");
  assert.match(error.hint, /Reinstall the VSIX from this release/, "the same next action the worker refusal gives");
  assert.equal(commandLine(error), "", "no command is invented for a refusal that ran nothing");
  await assert.rejects(fs.stat(path.join(dir, "notebooks", "analysis", ".venv")), /ENOENT/, "uv was not run inside the project");
});

test("a notebook project the operator already owns is named and answered, not blamed on the build (0.3.7 e2e D6)", async (t) => {
  const { dir, harness, services } = await notebookWorkspace(t, "research-notebook-owned-");
  const project = path.join(dir, "notebooks", "analysis");
  // The workspace already holds the operator's own project: the shipped files, with their own manifest.
  await fs.cp(path.join(__dirname, "..", "worker", "overlay", "notebooks", "analysis"), project, { recursive: true });
  const pyproject = path.join(project, "pyproject.toml");
  const text = await fs.readFile(pyproject, "utf8");
  await fs.writeFile(pyproject, text.replace(/version = "0\.1\.0"/, 'version = "0.9.9"'), "utf8");
  const before = { pyproject: digestOf(await fs.readFile(pyproject)), lock: digestOf(await fs.readFile(path.join(project, "uv.lock"))) };

  const error = await runNotebookStep({ root: dir, context: harness.context, services, settings: {}, step: STEPS_BY_ID.get("notebook-env"), vscode: harness.vscode }).catch((item) => item);
  assert.match(error.message, /notebooks\/analysis\/pyproject\.toml/, `the file the toolkit preserved is named, got: ${error.message}`);
  assert.match(error.message, /preserved/, "the operator reads that their files were left alone");
  assert.ok(!/This is a defect in the toolkit build/.test(error.message), `the operator's own project is not blamed on the build: ${error.message}`);
  assert.ok(!/this toolkit wrote/.test(error.message), error.message);
  assert.match(error.hint, /restore it from this toolkit's overlay files or remove the folder/i, `the next action is the one the uv-refusal branch already gives: ${error.hint}`);
  assert.equal(error.kind, "lock-drift");
  assert.equal(error.attempts, 0, "no process ran");
  assert.deepEqual(error.lockDrift.preservedFiles, ["notebooks/analysis/pyproject.toml"], "the preserved files are recorded for the setup log");
  assert.equal(digestOf(await fs.readFile(pyproject)), before.pyproject, "the operator's project file was not rewritten");
  assert.equal(digestOf(await fs.readFile(path.join(project, "uv.lock"))), before.lock, "the operator's lockfile was not rewritten");
  await assert.rejects(fs.stat(path.join(project, ".venv")), /ENOENT/, "uv was not run inside the operator's project");
});

/** The same stand-in uv as in runtime.test.js, so the notebook tier is tested through the reviewed runner. */
const STUB_UV = [
  "const a = process.argv.slice(1);",
  "if (a[0] !== 'sync') { console.error('unexpected args: ' + a.join(' ')); process.exit(9); }",
  "if (a[1] === '--locked') {",
  "  console.error('Using CPython 3.12.16');",
  "  console.error('Resolved 40 packages in 180ms');",
  "  console.error('error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.');",
  "  console.error('hint: To update the lockfile, run `uv lock`.');",
  "  process.exit(1);",
  "}",
  "console.error('Request failed after 3 retries in 6.2s');",
  "console.error('  Caused by: Failed to fetch: https://127.0.0.1:1/simple/matplotlib/');",
  "console.error('  Caused by: tcp connect error: Connection refused (os error 111)');",
  "process.exit(2);",
].join(" "); // one line, so the recorded command stays one line

test("a failed notebook fallback never repeats the success wording, and names the next action and the directory (0.3.7 e2e D1, D3, D4)", async (t) => {
  const os = require("node:os");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-notebook-fallback-fail-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ folders: [{ name: "research", uri: { scheme: "file", fsPath: dir } }] });
  const project = path.join(dir, "notebooks", "analysis");
  const calls = [];
  const services = {
    uv: process.execPath,
    runProcess: (executable, args, options) => {
      calls.push({ args });
      return runProcess(process.execPath, ["-e", STUB_UV, ...args], options);
    },
  };
  const error = await runNotebookStep({ root: dir, context: harness.context, services, settings: {}, step: STEPS_BY_ID.get("notebook-env"), vscode: harness.vscode }).catch((item) => item);
  const syncs = calls.filter((call) => call.args[0] === "sync");
  assert.deepEqual(syncs.map((call) => call.args[1]), ["--locked", "--frozen"], "one locked attempt and one gated fallback, through the reviewed runner");
  assert.match(error.message, /The locked notebook install was refused by this host's uv/, error.message);
  assert.match(error.message, /needs to be updated/, "the first refusal's sentence survives");
  assert.match(error.message, /The reviewed fallback that installs exactly what the notebook lock pins also failed/, error.message);
  assert.match(error.message, /Failed to fetch/, "and so does the second one");
  assert.ok(!error.message.includes("Installed exactly the packages the notebook lock pins"), "a failed step never carries the tier's success wording (D1)");
  assert.match(error.message, /Check the host tool version and network access, then retry the notebook step\./, "the failure sentence the code intends to say (D1)");
  assert.match(error.hint, /Check the host tool version and network access, then retry the notebook step\./, "the status layer gets a next action, not the generic retry (D3)");
  assert.equal(error.cwd, project, "the failure carries the directory the fallback ran in (D4)");
  const line = commandLine(error);
  assert.ok(line.includes("(in ") && line.includes(project), `the recorded command line names the working directory, got ${line} (D4)`);
  assert.ok(!line.includes("working directory not recorded"), line);
  const rerun = rerunInstruction(error).split("\n");
  assert.ok(rerun.some((entry) => entry.startsWith("cd ") && entry.includes(project)), `the pasteable instruction gets a real cd line: ${rerun.join(" | ")}`);
  assert.equal(error.attempts, 2, "two uv processes ran and the record says two");
  assert.equal(error.exitCode, 2);
  await assert.rejects(fs.stat(path.join(project, ".venv")), /ENOENT/, "the failed fallback created no environment");
});

/**
 * A workspace with this release's managed worker already installed, so the lab-store step has a
 * runtime to run. The worker folder is the shipped one, so `managedRuntime` re-verifies it the way
 * a real workspace would.
 */
async function managedWorkerWorkspace(t, prefix) {
  const os = require("node:os");
  const { WORKER_FOLDER, bundle } = require("../runtime");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const context = { extensionUri: { fsPath: path.resolve(__dirname, "..") } };
  const worker = path.join(dir, WORKER_FOLDER);
  await fs.mkdir(path.dirname(worker), { recursive: true });
  await fs.cp(path.join(__dirname, "..", "worker"), worker, { recursive: true });
  const { manifest } = await bundle(context);
  await fs.writeFile(path.join(worker, "installation.json"), JSON.stringify({ workerVersion: manifest.workerVersion, updatedAt: "2026-11-04T00:00:00.000Z", checks: { ok: true } }), "utf8");
  const python = path.join(worker, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  await fs.mkdir(path.dirname(python), { recursive: true });
  await fs.writeFile(python, "fixture interpreter");
  return { dir, context, folder: { name: "research", uri: { scheme: "file", fsPath: dir } }, worker, python };
}

test("the lab-store step runs the worker module behind the reviewed Python flags, and nothing else (0.3.8)", async (t) => {
  const { dir, context, folder, python } = await managedWorkerWorkspace(t, "research-labstore-argv-");
  const calls = [];
  const store = path.join(dir, ".research-toolkit", "store", "research.sqlite3");
  const services = { async runProcess(executable, args, options) {
    calls.push({ executable, args, options });
    return { ok: true, stdout: JSON.stringify({ ok: true, store, schemaVersion: 2, tableCount: 7, profile: "full" }), stderr: "", exitCode: 0, durationMs: 5, attempts: 1 };
  } };
  const step = STEPS_BY_ID.get("lab-store");
  const result = await runLabStoreStep({ root: dir, context, folder, services, settings: {}, step });
  assert.equal(calls.length, 1, "the step runs exactly one process");
  assert.equal(calls[0].executable, python, "with the managed interpreter, not a host python");
  assert.deepEqual(calls[0].args, pythonArgv("-m", "research_stack.cli", "init-lab", "--workspace", dir),
    `the store command is the reviewed module call behind ${PYTHON_FLAGS.join(" ")} — -X utf8 is what keeps the report readable on a cp1252 host`);
  assert.equal(calls[0].options.cwd, dir, "the worker runs in the workspace root");
  assert.equal(calls[0].options.timeout, stepTimeout(step, {}), "under the step's own bound");
  assert.equal(result.store, store, "a valid UTF-8 report is recorded");
  assert.match(result.evidence, /SQLite record store initialised at .*schema 2; 7 tables/, result.evidence);
});

test("the notebook step verifies its imports through a reviewed Python child (0.3.8)", async (t) => {
  const os = require("node:os");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "research-notebook-argv-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { makeHarness } = require("./harness");
  const harness = makeHarness({ folders: [{ name: "research", uri: { scheme: "file", fsPath: dir } }] });
  const project = path.join(dir, "notebooks", "analysis");
  const interpreter = path.join(project, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const calls = [];
  const services = {
    async resolveHostTool(name) { return { name, path: "/trusted/uv", source: "path", version: "0.13.6", verified: true, searched: {}, hint: "" }; },
    async runProcess(executable, args) {
      calls.push({ executable, args });
      if (args[0] === "sync") {
        await fs.mkdir(path.dirname(interpreter), { recursive: true });
        await fs.writeFile(interpreter, "fixture interpreter");
        return { ok: true, stdout: "", stderr: "Resolved 40 packages in 63ms", exitCode: 0, durationMs: 12, attempts: 1 };
      }
      return { ok: true, stdout: "3.12.16 (main)\n", stderr: "", exitCode: 0, durationMs: 5, attempts: 1 };
    },
  };
  const result = await runNotebookStep({ root: dir, context: harness.context, services, settings: {}, step: STEPS_BY_ID.get("notebook-env"), vscode: harness.vscode });
  const imports = calls.filter((call) => call.args[0] !== "sync");
  assert.equal(imports.length, 1, "one interpreter check after the locked sync");
  assert.deepEqual(imports[0].args, pythonArgv("-c", "import ipykernel, matplotlib, sys; print(sys.version)"),
    `the import check is the reviewed -c call behind ${PYTHON_FLAGS.join(" ")}`);
  assert.equal(imports[0].executable, interpreter, "the check runs with the notebook environment's own interpreter");
  assert.equal(result.importsVerified, true);
  assert.match(result.pythonVersion, /^3\.12\.16/, "the version the child reported reaches the evidence");
});

test("a store report that is not valid UTF-8 text is refused, and no store path is recorded (0.3.8 field failure)", async (t) => {
  const { dir, context, folder } = await managedWorkerWorkspace(t, "research-labstore-codec-");
  const calls = [];
  const store = path.join(dir, ".research-toolkit", "store", "research.sqlite3");
  // The 0.3.7 shape: the store was created, and the report that proves it came back through the
  // host's console encoding, so the runner's UTF-8 decode produced U+FFFD. A path containing U+FFFD
  // is a path the panel would record and later fail to find.
  const damaged = JSON.stringify({ ok: true, store: `k:\\Soukrom\u00e9_aktivity\\Bankovn\u00ed \uFFFDcet SVJ \\store\\research.sqlite3`, schemaVersion: 2, tableCount: 7, profile: "full" });
  const services = { async runProcess(executable, args, options) {
    calls.push({ executable, args, options });
    return { ok: true, stdout: damaged, stderr: "", exitCode: 0, durationMs: 5, attempts: 1 };
  } };
  const step = STEPS_BY_ID.get("lab-store");
  const failure = await runLabStoreStep({ root: dir, context, folder, services, settings: {}, step }).catch((error) => error);
  assert.ok(failure instanceof Error, "the step rejects instead of returning a result");
  assert.match(failure.message, /report was not valid UTF-8 text/, failure.message);
  assert.match(failure.message, /its store path cannot be trusted and this step is not recorded/, failure.message);
  assert.match(failure.message, /The store itself may already exist; re-running this step is safe\./, failure.message);
  assert.equal(failure.store, undefined, "no store path reaches the receipt");
  assert.equal(failure.evidence, undefined, "and no evidence line either");
  assert.equal(calls.length, 1, "the worker did run; the refusal is about its report");
  await assert.rejects(fs.stat(store), /ENOENT/, "the step records a store it cannot name");

  // The check is about the replacement character, not about non-ASCII text: the Czech workspace
  // path is exactly what a correct UTF-8 report carries.
  const good = JSON.stringify({ ok: true, store: `k:\\Soukrom\u00e9_aktivity\\Bankovn\u00ed \u00fa\u010det SVJ \u010CSA368\\.research-toolkit\\store\\research.sqlite3`, schemaVersion: 2, tableCount: 7, profile: "full" });
  const result = await runLabStoreStep({ root: dir, context, folder, settings: {}, step, services: { async runProcess() { return { ok: true, stdout: good, stderr: "", exitCode: 0, durationMs: 5, attempts: 1 }; } } });
  assert.match(result.store, /Bankovn\u00ed \u00fa\u010det SVJ \u010CSA368/, "a UTF-8 report with the workspace's own characters is accepted");
});
