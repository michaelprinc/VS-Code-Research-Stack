"use strict";
/**
 * The 0.3.7 lock reader.
 *
 * 0.3.6 shipped `extension/worker/pyproject.toml` at version 0.3.6 beside a `uv.lock` whose root entry
 * still recorded 0.3.4. uv compares a lockfile with the project metadata before it honours `--locked`,
 * so every managed setup on a real host stopped with "The lockfile at `uv.lock` needs to be updated,
 * but `--locked` was provided." This module is the extension's own reader of that comparison: it runs
 * before any process does, and it recognises uv's refusal instead of reporting it as a generic failure.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DRIFT_SIGNATURE, canonicalName, isLockDrift, parseLock, parsePyproject, rootEntry,
  dependencyPins, pairProblems, EXPECTED_REVISION_MAX, lockMetadataRequiresDev, lockMetadataSpecifiers, lockPackageBlock,
} = require("../lockfile");

const WORKER = path.join(__dirname, "..", "worker");
const read = (file) => fs.readFileSync(file, "utf8");

const UV_REFUSAL = "Using CPython 3.12.16\nResolved 40 packages in 63ms\nerror: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.\n\nhint: To update the lockfile, run `uv lock`.\n";

test("the shipped worker pair is lock-current, so `uv sync --locked` will not refuse it", () => {
  const problems = pairProblems(read(path.join(WORKER, "pyproject.toml")), read(path.join(WORKER, "uv.lock")));
  assert.deepEqual(problems, [], `bundled worker pair is stale: ${problems.join("; ")}`);
});

test("the shipped notebook overlay pair is lock-current too", () => {
  const overlay = path.join(WORKER, "overlay", "notebooks", "analysis");
  assert.deepEqual(pairProblems(read(path.join(overlay, "pyproject.toml")), read(path.join(overlay, "uv.lock"))), []);
});

test("the bundled lock records the version the bundled manifest declares", () => {
  const project = parsePyproject(read(path.join(WORKER, "pyproject.toml")));
  const entry = rootEntry(parseLock(read(path.join(WORKER, "uv.lock"))));
  assert.equal(entry.version, project.version, "a lock that records another version is the 0.3.6 defect");
  assert.equal(entry.name, project.name);
});

test("the reader names the exact defect that shipped in 0.3.6", () => {
  const pyproject = read(path.join(WORKER, "pyproject.toml"));
  const shipped = parsePyproject(pyproject).version;
  const lock = read(path.join(WORKER, "uv.lock")).replace(
    `name = "research-stack-basic"\nversion = "${shipped}"`, 'name = "research-stack-basic"\nversion = "0.3.4"');
  const problems = pairProblems(pyproject, lock);
  assert.equal(problems.length, 1, "the shipped pair, with only the recorded root version wound back, is one defect");
  assert.match(problems[0], new RegExp(`lock root package version 0\.3\.4 does not match pyproject version ${shipped}`));
});

test("a dependency specifier added without a re-lock is named", () => {
  const pyproject = read(path.join(WORKER, "pyproject.toml")).replace('"pypdf==6.4.1"', '"pypdf==6.9.9"');
  const problems = pairProblems(pyproject, read(path.join(WORKER, "uv.lock")));
  assert.ok(problems.some((problem) => /dependency specifiers/.test(problem)), problems.join("; "));
});

test("a dependency group changed without a re-lock is named", () => {
  const pyproject = read(path.join(WORKER, "pyproject.toml")).replace('dev = ["pytest==8.4.2"]', 'dev = ["pytest==9.9.9"]');
  const problems = pairProblems(pyproject, read(path.join(WORKER, "uv.lock")));
  assert.ok(problems.some((problem) => /dependency group dev/.test(problem)), problems.join("; "));
});

test("a requires-python change without a re-lock is named", () => {
  const pyproject = read(path.join(WORKER, "pyproject.toml")).replace('requires-python = ">=3.12,<3.15"', 'requires-python = ">=3.13,<3.15"');
  const problems = pairProblems(pyproject, read(path.join(WORKER, "uv.lock")));
  assert.ok(problems.some((problem) => /requires-python/.test(problem)), problems.join("; "));
});

test("a pyproject this reader cannot read is refused, not guessed at", () => {
  assert.throws(() => parsePyproject('name = "no-section"\n'), /has no \[project\] section/);
  assert.throws(() => rootEntry(parseLock('version = 1\n[[package]]\nname = "pypdf"\nversion = "6.4.1"\nsource = { registry = "https://pypi.org/simple" }\n')), /no editable\/virtual root package entry/);
});

test("uv's lock refusal is recognised, and an ordinary failure is not", () => {
  assert.equal(isLockDrift({ stderr: UV_REFUSAL, message: "uv sync failed with exit code 1" }), true);
  assert.equal(isLockDrift({ stderr: "", message: UV_REFUSAL }), true, "the runner also carries the refusal in the message");
  assert.equal(isLockDrift({ stderr: "error: Request failed after 3 retries", message: "network" }), false);
  assert.equal(isLockDrift({ stderr: "error: failed to fetch https://pypi.org/simple/pypdf/" }), false);
  assert.equal(isLockDrift(undefined), false);
  assert.equal(isLockDrift({}), false);
  assert.ok(DRIFT_SIGNATURE.test("The lockfile at `uv.lock` needs to be updated, but `--check` was provided"), "the preflight refusal shape is recognised too");
});

test("the pins a lock holds are readable, so a re-lock can be reviewed before it is accepted", () => {
  const pins = dependencyPins(parseLock(read(path.join(WORKER, "uv.lock"))));
  assert.equal(pins.size, 39, "39 third-party packages are pinned; the project itself is not a pin");
  assert.ok(pins.has("pypdf@6.4.1") && pins.has("mcp@2.2.0") && pins.has("python-docx@1.2.0"));
  assert.ok(![...pins].some((pin) => pin.startsWith("research-stack-basic@")), "the project entry is not a dependency pin");
  assert.equal(canonicalName("Python_Docx"), "python-docx", "names compare the way uv compares them");
});

test("the reader starts no process and reaches no socket", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "lockfile.js"), "utf8");
  assert.ok(!/child_process|require\("node:(http|https|net|tls|dgram|worker_threads)"\)|\beval\(|\bFunction\(/.test(source));
  assert.ok(!/writeFile|mkdir|rm\(|rename\(/.test(source), "the reader writes nothing");
});

/**
 * The fixtures below are the shapes uv 0.13.6 writes on this host, trimmed to the entries the
 * reader has to survive: an extra inside a manifest array, a `marker` written before a
 * `specifier`, a sub-table after `requires-dev`, and a dependency group that includes another one.
 * They are inline and fixed, so no test here reaches uv, a socket or a temp directory.
 */
const registryPackages = [
  '[[package]]',
  'name = "mcp"',
  'version = "2.2.0"',
  'source = { registry = "https://pypi.org/simple" }',
  '',
  '[[package]]',
  'name = "pypdf"',
  'version = "6.4.1"',
  'source = { registry = "https://pypi.org/simple" }',
  '',
];
const lockOf = (rootBlock) => [
  "version = 1",
  "revision = 5",
  'requires-python = ">=3.12, <3.15"',
  "",
  ...registryPackages,
  rootBlock,
].join("\n");
const manifestOf = (lines) => [
  "[project]",
  'name = "demo"',
  'version = "0.1.0"',
  'requires-python = ">=3.12,<3.15"',
  ...lines,
  "",
].join("\n");
const rootOf = (tables) => [
  "[[package]]",
  'name = "demo"',
  'version = "0.1.0"',
  'source = { virtual = "." }',
  "",
  ...tables,
].join("\n");

// The 0.3.7 reader cut `dependencies = ["mcp[cli]==2.2.0", …]` at the `]` inside `mcp[cli`, so the
// declared set came out empty and a pair uv accepted was reported as drift.
test("an extras array is read whole, so a pair uv accepts is not reported as drift", () => {
  const pyproject = manifestOf(['dependencies = ["mcp[cli]==2.2.0", "pypdf==6.4.1"]']);
  const lock = lockOf(rootOf([
    "[package.metadata]",
    "requires-dist = [",
    '    { name = "mcp", extras = ["cli"], specifier = "==2.2.0" },',
    '    { name = "pypdf", specifier = "==6.4.1" },',
    "]",
  ]));
  const declared = parsePyproject(pyproject).dependencies.map((item) => `${item.name}${item.extras.length ? `[${item.extras.join(",")}]` : ""} ${item.specifier}`);
  assert.deepEqual(declared, ["mcp[cli] ==2.2.0", "pypdf ==6.4.1"], "both requirements are read, with the extra kept off the specifier");
  const problems = pairProblems(pyproject, lock);
  assert.deepEqual(problems, [], problems.join("; "));
});

// uv keeps the marker in its own key and writes it before the specifier; comparing the marker text,
// or requiring `specifier` to follow `name`, both invent drift.
test("a marker is compared on (name, extras, specifier), not on the marker text", () => {
  const pyproject = manifestOf([
    'dependencies = [',
    '  "pypdf==6.4.1; python_version >= \'3.13\'",',
    '  "mcp[cli]==2.2.0; sys_platform == \'win32\'",',
    ']',
  ]);
  const lock = lockOf(rootOf([
    "[package.metadata]",
    "requires-dist = [",
    '    { name = "pypdf", marker = "python_full_version >= \'3.13\'", specifier = "==6.4.1" },',
    '    { name = "mcp", extras = ["cli"], marker = "sys_platform == \'win32\'", specifier = "==2.2.0" },',
    "]",
  ]));
  const problems = pairProblems(pyproject, lock);
  assert.deepEqual(problems, [], problems.join("; "));
  const project = parsePyproject(pyproject);
  assert.deepEqual(project.dependencies.map((item) => item.marker), ["python_version >= '3.13'", "sys_platform == 'win32'"], "the marker is read off the specifier, not left glued to it");
});

test("a specifier that really differs under an extra or a marker is named", () => {
  const lock = lockOf(rootOf([
    "[package.metadata]",
    "requires-dist = [",
    '    { name = "pypdf", marker = "python_full_version >= \'3.13\'", specifier = "==6.4.1" },',
    '    { name = "mcp", extras = ["cli"], specifier = "==2.2.0" },',
    "]",
  ]));
  const underMarker = pairProblems(manifestOf(['dependencies = ["pypdf==6.9.9; python_version >= \'3.13\'", "mcp[cli]==2.2.0"]']), lock);
  assert.equal(underMarker.length, 1, underMarker.join("; "));
  assert.match(underMarker[0], /dependency specifiers .*pypdf ==6\.4\.1.* do not match pyproject .*pypdf ==6\.9\.9/);
  const droppedExtra = pairProblems(manifestOf(['dependencies = ["pypdf==6.4.1; python_version >= \'3.13\'", "mcp==2.2.0"]']), lock);
  assert.equal(droppedExtra.length, 1, droppedExtra.join("; "));
  assert.match(droppedExtra[0], /mcp\[cli\] ==2\.2\.0/, "an extra the manifest dropped is a different requirement, not the same one");
});

test("a sub-table after requires-dev is not read as a dependency group", () => {
  const pyproject = manifestOf(["dependencies = []", "", "[dependency-groups]", 'dev = ["pytest==8.4.2"]']);
  const requiresDev = [
    "[package.metadata]",
    "requires-dist = []",
    "",
    "[package.metadata.requires-dev]",
    'dev = [{ name = "pytest", specifier = "==8.4.2" }]',
  ];
  const lockWith = (tail) => lockOf(rootOf([...requiresDev, "", ...tail]));
  const entry = rootEntry(parseLock(lockWith(["[package.metadata.conditions]", 'env-markers = ["sys_platform == \'win32\'"]'])));
  assert.deepEqual(lockMetadataRequiresDev(lockWith(["[package.metadata.conditions]", 'env-markers = ["sys_platform == \'win32\'"]']), entry), { dev: ["pytest ==8.4.2"] }, "the keys of the following sub-table are not groups");
  const shapes = [
    ["a marker table", ["[package.metadata.conditions]", 'env-markers = ["sys_platform == \'win32\'"]']],
    ["a following key that shares a group name", ["[package.metadata.conditions]", 'dev = ["sys_platform == \'win32\'"]']],
    ["a following key holding requirement tables", ["[package.metadata.conditions]", 'env-markers = [{ name = "pytest", marker = "sys_platform == \'win32\'" }]']],
  ];
  for (const [label, tail] of shapes) {
    const problems = pairProblems(pyproject, lockWith(tail));
    assert.deepEqual(problems, [], `${label}: ${problems.join("; ")}`);
  }
});

test("the local entry is used when a registry package shares the project name", () => {
  const pyproject = [
    "[project]",
    'name = "pypdf"',
    'version = "0.1.0"',
    'requires-python = ">=3.12,<3.15"',
    'dependencies = ["pypdf==6.4.1"]',
    "",
  ].join("\n");
  const lock = [
    "version = 1",
    "revision = 5",
    'requires-python = ">=3.12, <3.15"',
    "",
    "[[package]]",
    'name = "pypdf"',
    'version = "6.4.1"',
    'source = { registry = "https://pypi.org/simple" }',
    "",
    "[package.metadata]",
    'requires-dist = [{ name = "not-the-project", specifier = "==1.0" }]',
    "",
    "[[package]]",
    'name = "pypdf"',
    'version = "0.1.0"',
    'source = { editable = "." }',
    "",
    "[package.metadata]",
    'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
    "",
  ].join("\n");
  const parsed = parseLock(lock);
  const entry = rootEntry(parsed);
  assert.equal(entry.version, "0.1.0", "the editable entry is the project, not the registry package of the same name");
  assert.match(lockPackageBlock(lock, entry), /editable = "\."/);
  assert.deepEqual(lockMetadataSpecifiers(lock, entry), ["pypdf ==6.4.1"]);
  const problems = pairProblems(pyproject, lock);
  assert.deepEqual(problems, [], problems.join("; "));
  assert.ok(dependencyPins(parsed).has("pypdf@6.4.1"), "the registry package of the same name is still a pin");
});

// scripts/lockintegrity.py refuses a lock whose revision is above the reviewed maximum; this reader
// has to refuse the same lock or the two guards disagree about a shipped pair.
test("a lock revision above the reviewed maximum is named, as the Python guard names it", () => {
  const pyproject = manifestOf(['dependencies = ["pypdf==6.4.1"]']);
  const lock = lockOf(rootOf(["[package.metadata]", "requires-dist = [", '    { name = "pypdf", specifier = "==6.4.1" },', "]"]));
  assert.deepEqual(pairProblems(pyproject, lock), [], "the reviewed revision is accepted");
  const ahead = pairProblems(pyproject, lock.replace("revision = 5", "revision = 9"));
  assert.equal(ahead.length, 1, ahead.join("; "));
  assert.match(ahead[0], /lockfile revision 9 is above the reviewed maximum 5/);
  assert.equal(EXPECTED_REVISION_MAX, 5, "the ceiling is the one scripts/lockintegrity.py holds");
  assert.ok(parseLock(read(path.join(WORKER, "uv.lock"))).revision <= EXPECTED_REVISION_MAX);
  assert.ok(parseLock(read(path.join(WORKER, "overlay", "notebooks", "analysis", "uv.lock"))).revision <= EXPECTED_REVISION_MAX);
});

// `pairProblems` is what the shipped runtime calls while a setup is already running: a pair this
// reader cannot read is a reported defect, never an exception the user sees as a toolkit crash.
test("a pair this reader cannot read is a reported problem, not a thrown one", () => {
  const lock = lockOf(rootOf(["[package.metadata]", "requires-dist = [", '    { name = "pypdf", specifier = "==6.4.1" },', "]"]));
  const unclosed = pairProblems('[project]\nname = "demo"\nversion = "0.1.0"\ndependencies = ["pypdf==6.4.1",\n', lock);
  assert.equal(unclosed.length, 1, unclosed.join("; "));
  assert.match(unclosed[0], /pyproject\.toml could not be read/);
  const noSection = pairProblems('name = "no-section"\n', lock);
  assert.equal(noSection.length, 1);
  assert.match(noSection[0], /has no \[project\] section/);
  const emptyLock = pairProblems(manifestOf(['dependencies = ["pypdf==6.4.1"]']), "revision = 5\nrequires-python = \">=3.12\"\n");
  assert.equal(emptyLock.length, 1);
  assert.match(emptyLock[0], /uv\.lock could not be read/);
  assert.equal(pairProblems(manifestOf(['dependencies = ["pypdf==6.4.1"]']), "").length, 1, "an empty lock is a problem, not an exception");
  assert.equal(pairProblems(undefined, undefined).length, 1, "missing text is a problem, not an exception");
  const commented = manifestOf(['dependencies = ["pypdf==6.4.1"]']).replace("[project]", "[project] # the manifest this lock belongs to");
  assert.deepEqual(pairProblems(commented, lock), [], "a header carrying a comment is ordinary TOML, not drift");
});

// uv expands an included group before it writes `requires-dev` (measured on this host with uv 0.13.6:
// `dev = [{ include-group = "test" }]` lands in the lock as `dev = [{ name = "pytest", … }]` beside the
// group it includes), so the reader expands it too. `include` is the PEP 735 spelling, which uv 0.13.6
// refuses outright; either way it is a group reference, never a package named `include`. A group
// holding an object this reader cannot model is skipped instead of being guessed at.
test("a dependency group that includes another group is compared the way uv expands it", () => {
  const pyproject = manifestOf([
    "dependencies = []",
    "",
    "[dependency-groups]",
    'test = ["pytest==8.4.2"]',
    'dev = [{ include-group = "test" }]',
    'legacy = [{ include = "test" }]',
  ]);
  const lock = lockOf(rootOf([
    "[package.metadata]",
    "requires-dist = []",
    "",
    "[package.metadata.requires-dev]",
    'test = [{ name = "pytest", specifier = "==8.4.2" }]',
    'dev = [{ name = "pytest", specifier = "==8.4.2" }]',
    'legacy = [{ name = "pytest", specifier = "==8.4.2" }]',
  ]));
  const problems = pairProblems(pyproject, lock);
  assert.deepEqual(problems, [], problems.join("; "));
  const drifted = pairProblems(pyproject.replace("pytest==8.4.2", "pytest==9.9.9"), lock);
  assert.equal(drifted.length, 3, drifted.join("; "));
  assert.ok(drifted.every((problem) => /dependency group/.test(problem)), drifted.join("; "));
  const unmodellableLock = lockOf(rootOf([
    "[package.metadata]",
    "requires-dist = []",
    "",
    "[package.metadata.requires-dev]",
    'lab = [{ name = "pytest", specifier = "==8.4.2" }]',
  ]));
  const unmodellable = pairProblems(manifestOf(["dependencies = []", "", "[dependency-groups]", 'lab = [{ set = "virtual-group" }]']), unmodellableLock);
  assert.deepEqual(unmodellable, [], "a group object this reader does not model is skipped, not reported as a missing group");
  const missingGroup = pairProblems(manifestOf(["dependencies = []"]), unmodellableLock);
  assert.equal(missingGroup.length, 1, missingGroup.join("; "));
  assert.match(missingGroup[0], /dependency group lab/, "a group the lock holds and the manifest dropped is still drift");
});


test("optional-dependencies are compared the way uv records them (review finding 20)", () => {
  const pyproject = read(path.join(WORKER, "pyproject.toml"));
  const shippedLock = read(path.join(WORKER, "uv.lock"));
  const withExtras = pyproject.replace("[project.scripts]", '[project.optional-dependencies]\npdf = ["pypdf==6.4.1"]\n\n[project.scripts]');
  const extraEntry = "    { name = \"pypdf\", marker = \"extra == 'pdf'\", specifier = \"==6.4.1\" },";
  const recorded = shippedLock.replace(
    '    { name = "python-docx", specifier = "==1.2.0" },\n]',
    `    { name = "python-docx", specifier = "==1.2.0" },\n${extraEntry}\n]\nprovides-extras = ["pdf"]`);
  assert.notEqual(recorded, shippedLock, "the fixture must actually reach the root package metadata");

  assert.deepEqual(pairProblems(withExtras, recorded), [], "uv 0.13.6 writes optional dependencies into requires-dist with an extra marker and names the group in provides-extras; a reader that called that pair stale would refuse a valid build");

  // A pin the lock never recorded is drift even though the group name is nowhere in the lock.
  const wrongPin = pyproject.replace("[project.scripts]", '[project.optional-dependencies]\npdf = ["pypdf==6.4.2"]\n\n[project.scripts]');
  assert.ok(pairProblems(wrongPin, shippedLock).length >= 1, "an optional dependency the lock never recorded is drift");

  assert.ok(pairProblems(pyproject, recorded).length >= 1, "extras the manifest does not declare are drift");

  // uv 0.5.0 records the same requires-dist entries but writes no provides-extras at all, so the
  // missing key is not staleness — otherwise the reader would refuse a lock uv accepts.
  const olderUv = shippedLock.replace(
    '    { name = "python-docx", specifier = "==1.2.0" },\n]',
    `    { name = "python-docx", specifier = "==1.2.0" },\n${extraEntry}\n]`);
  assert.deepEqual(pairProblems(withExtras, olderUv), [], "a lock written by an older uv is not stale just because it omits provides-extras");
});

test("a single-quoted TOML scalar is read, not mistaken for a version mismatch (review finding 21)", () => {
  const pyproject = read(path.join(WORKER, "pyproject.toml"));
  const lock = read(path.join(WORKER, "uv.lock"));
  const literal = pyproject.replace(/^version = "([^"]*)"/m, "version = '$1'");
  assert.notEqual(literal, pyproject, "the fixture must actually rewrite the version scalar");
  assert.deepEqual(pairProblems(literal, lock), [], "TOML literal strings are valid in a manifest the toolkit has to read");
});
