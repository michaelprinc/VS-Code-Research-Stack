"use strict";
/**
 * The 0.3.6 refactor is only worth having if the boundaries stay in place. This test reads the
 * shipped modules and enforces the reviewed dependency direction, the single process boundary and
 * the rule that no controller module implements an install step itself.
 *
 * The module list is enumerated from the directory rather than hard-coded, so a new module cannot
 * join the shipped set without being reviewed here and in the VSIX inventory.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const REVIEWED = {
  "runner.js": ["lockfile.js"],
  "hosttools.js": ["runner.js"],
  "setuplog.js": [],
  "status.js": [],
  "lockfile.js": [],
  "preflight.js": ["hosttools.js", "runtime.js"],
  "steps.js": ["runner.js", "runtime.js", "hosttools.js", "lockfile.js"],
  "installer.js": ["runtime.js", "steps.js", "preflight.js", "setuplog.js", "status.js"],
  "diagnostics.js": ["runner.js", "hosttools.js", "runtime.js", "installer.js"],
  "runtime.js": ["runner.js", "hosttools.js", "lockfile.js"],
  // 0.3.9: the skill-bundle catalog reader and staged installer. It reaches no other extension
  // module, no process and no socket — it is paths, hashes and `fs` only.
  "bundles.js": [],
  "ui.js": [],
  "extension.js": ["ui.js", "diagnostics.js", "runtime.js", "installer.js", "setuplog.js", "status.js", "preflight.js", "steps.js", "hosttools.js", "runner.js", "bundles.js"],
};
const DATA_FILES = ["components.json", "presets.json", "package.json", "vsix-manifest.json"];

/** Every shipped module at the top level of the extension (media/ is webview code, test/ is not shipped). */
function shippedModules() {
  return fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name)
    .sort();
}

function localRequires(file) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  const modules = new Set();
  const data = new Set();
  // `require("./x")` and `require("./x.js")` are the same edge; a suffix must not hide a dependency.
  for (const match of source.matchAll(/require\("\.\/([A-Za-z0-9_.-]+?)(?:\.js)?"/g)) {
    const name = match[1];
    if (name.endsWith(".json")) data.add(name);
    else modules.add(`${name}.js`);
  }
  return { source, found: [...modules].sort(), data: [...data].sort() };
}

test("the shipped module set is exactly the reviewed set, so a new module cannot appear unreviewed", () => {
  assert.deepEqual(shippedModules(), Object.keys(REVIEWED).sort(), "extension/*.js must match the reviewed module list");
});

test("each module requires only the reviewed modules below it, so the graph has no cycle", () => {
  for (const file of shippedModules()) {
    const { found, data } = localRequires(file);
    const allowed = REVIEWED[file];
    const unexpected = found.filter((name) => !allowed.includes(name));
    assert.deepEqual(unexpected, [], `${file} requires ${unexpected.join(", ")} which is not in its reviewed layer`);
    const unexpectedData = data.filter((name) => !DATA_FILES.includes(name));
    assert.deepEqual(unexpectedData, [], `${file} requires ${unexpectedData.join(", ")} which is not a reviewed data file`);
  }
  // The reviewed layers must not contain an edge back up the graph.
  for (const [file, allowed] of Object.entries(REVIEWED)) {
    for (const dependency of allowed) {
      assert.ok(!REVIEWED[dependency].includes(file), `${file} -> ${dependency} -> ${file} would be a cycle`);
    }
  }
});

test("exactly one module reaches an external tool, and it is the reviewed runner", () => {
  const importers = shippedModules().filter((file) => /require\("node:child_process"\)/.test(localRequires(file).source));
  assert.deepEqual(importers, ["runner.js"], "the VSIX audit names runner.js as the single process boundary");
  const { source } = localRequires("runner.js");
  // DD7-12: the boundary is one bounded run plus one reaper, both in this module. Counting
  // `execFile(` alone proved the wrong thing — it found the reaper and missed the run itself.
  const count = (pattern) => (source.match(pattern) || []).length;
  assert.equal(count(/childProcess\.spawn\(/g), 1, "one bounded tool run, in one place");
  assert.equal(count(/childProcess\.execFile\(/g), 1, "one taskkill reaper call, in the same place");
  assert.equal(count(/\bspawn\(/g), 1, "no second spawn anywhere in the boundary");
  assert.equal(count(/\bexecFile\(/g), 1, "no second execFile either");
  assert.equal(count(/require\("node:child_process"\)/g), 1, "one import of the process module");
  for (const bound of ['const DEFAULT_TIMEOUT_MS = 8000;', "windowsHide: true", "shell: false", "maxBuffer: MAX_BUFFER_BYTES"]) {
    assert.ok(source.includes(bound), `runner.js must keep ${bound}`);
  }
  assert.ok(count(/shell: false/g) >= 2, "shell:false guards both call sites");
  assert.ok(count(/windowsHide: true/g) >= 2, "windowsHide:true guards both call sites");
  assert.equal(count(/shell:\s*true/g), 0, "the boundary never runs a tool through a shell");
  // W2: a stopped run must be able to take its whole tree with it.
  assert.ok(/detached: os\.platform\(\) !== "win32"/.test(source), "the POSIX child leads its own process group");
  assert.ok(/process\.kill\(-pid, "SIGKILL"\)/.test(source), "a stopped run kills the process group, not only the direct child");
  assert.ok(/"taskkill\.exe"/.test(source) && /function taskkillArguments\(pid\)/.test(source), "the Windows tree is taken by taskkill /T /F");
  assert.ok(/sink\.total >= MAX_BUFFER_BYTES/.test(source), "the capture limit is enforced by the boundary itself");
  // No other shipped module may reach a process, a socket or dynamic code at all.
  for (const file of shippedModules().filter((name) => name !== "runner.js")) {
    const { source: other } = localRequires(file);
    assert.ok(!/child_process|require\("node:(http|https|net|dgram|tls|worker_threads)"\)|\bFunction\(|\beval\(/.test(other),
      `${file} must not reach a process, a socket or dynamic code`);
  }
});

test("no controller module implements an install step or a uv command itself", () => {
  for (const file of ["extension.js", "installer.js", "diagnostics.js"]) {
    const { source } = localRequires(file);
    assert.ok(!/runProcess\(|runFile\(uv|args: \["sync"/.test(source), `${file} must not execute a step command itself`);
  }
  const { source: steps } = localRequires("steps.js");
  assert.ok(steps.includes('"sync"') && steps.includes("--project"), "steps.js is where the reviewed uv commands are built");
  assert.ok(steps.includes("research_stack.cli"), "steps.js owns the store command the lab step runs");
  assert.ok(localRequires("runtime.js").source.includes("functional_check.py"), "runtime.js owns the reading check that proves the worker works");
  const { source: installer } = localRequires("installer.js");
  assert.ok(installer.includes('require("./steps")'), "the plan engine delegates step bodies to steps.js");
  assert.ok(installer.includes("runPreflight"), "the plan engine runs preflight before any step");
  const { source: controller } = localRequires("extension.js");
  assert.ok(!controller.includes("runProcess") && !controller.includes("execFile"), "the controller never executes a tool directly");
});

test("the status wording lives in status.js and the panel only renders it", () => {
  const { source: ui } = localRequires("ui.js");
  const controls = fs.readFileSync(path.join(ROOT, "media", "controls.js"), "utf8");
  for (const phrase of ["Installation complete", "Installation incomplete", "Setup blocked", "Setup cancelled"]) {
    assert.ok(fs.readFileSync(path.join(ROOT, "status.js"), "utf8").includes(phrase), `status.js owns the wording for ${phrase}`);
    assert.ok(!ui.includes(phrase), `ui.js does not invent verdict wording for ${phrase}`);
  }
  assert.match(controls, /installation\.line/, "the webview renders the verdict the controller computed");
});
