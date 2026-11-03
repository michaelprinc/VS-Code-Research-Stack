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
  // The lock-internal refusals measured with uv 0.13.6 (exit 2) are not drift and must not be
  // auto-repaired: uv could not parse the lock at all.
  for (const refusal of [
    "error: Failed to parse `uv.lock`\n  cause: TOML parse error at line 1, column 1\nmissing field `requires-python`",
    "error: Failed to parse `uv.lock`\n  cause: The entry for package `anyio` (4.15.0) has wheel `anyio-4.15.1-py3-none-any.whl` with inconsistent version (4.15.1)",
    "error: Failed to parse `uv.lock`\n  cause: Dependency `pypdf` has missing `source` field but has more than one matching package",
  ]) {
    assert.equal(isLockDrift({ stderr: refusal, message: "uv lock --check failed with exit code 2" }), false, refusal.split("\n")[0]);
  }
  // A refusal that carries uv's staleness sentence *and* a reason is not a version-only drift either.
  assert.equal(isLockDrift({ stderr: `${UV_REFUSAL}\nhint: mismatched requirements for: pypdf`, message: "uv sync failed" }), false);
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

// uv keeps the marker in its own key and writes it before the specifier, in its own spelling
// (`python_version` becomes `python_full_version`). Comparing the raw text invents drift; ignoring the
// marker misses a requirement uv refuses. Both are wrong, so the marker is compared after the rewrite.
test("a marker is compared in uv's own spelling, not as the text the manifest wrote", () => {
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

// uv expands an included group before it writes `requires-dev`. Measured on this host, in a temp copy of
// the shipped worker pair: `test = [{ include-group = "dev" }]` lands in the lock as
// `requires-dev.test = [{ name = "pytest", specifier = "==8.4.2" }]` and `uv-0.13.6 lock --check` on that
// pair exits 0 (`uv-0.5.0 sync --locked --python 3.12` on the same pair also exits 0), so the reader
// expands it too. `{ include = "test" }` is a different construct: uv 0.13.6 refuses the manifest
// outright against either lock (`lock --check` exit 2, "Group `test` contains an unknown dependency
// object specifier: {\"include\": \"dev\"}"), while uv 0.5.0 accepted it and locked the group as empty.
// The reader certifies the first and refuses to certify the second — naming it as a construct it cannot
// model, the way it names an unmodelled `[tool.uv]` input, never as a group mismatch it cannot prove.
// `scripts/lockintegrity.py` now answers both pairs the same way, in the same words.
test("a dependency group that includes another group is compared the way uv expands it", () => {
  const groups = [
    "dependencies = []",
    "",
    "[dependency-groups]",
    'test = ["pytest==8.4.2"]',
    'dev = [{ include-group = "test" }]',
  ];
  const pyproject = manifestOf(groups);
  const lock = lockOf(rootOf([
    "[package.metadata]",
    "requires-dist = []",
    "",
    "[package.metadata.requires-dev]",
    'test = [{ name = "pytest", specifier = "==8.4.2" }]',
    'dev = [{ name = "pytest", specifier = "==8.4.2" }]',
  ]));
  const problems = pairProblems(pyproject, lock);
  assert.deepEqual(problems, [], problems.join("; "));
  const drifted = pairProblems(pyproject.replace("pytest==8.4.2", "pytest==9.9.9"), lock);
  assert.equal(drifted.length, 2, drifted.join("; "));
  assert.ok(drifted.every((problem) => /dependency group/.test(problem)), drifted.join("; "));

  // The PEP 735 spelling, beside the lock uv 0.5.0 wrote for it: not a group mismatch, a construct.
  const legacyLock = lockOf(rootOf([
    "[package.metadata]",
    "requires-dist = []",
    "",
    "[package.metadata.requires-dev]",
    'test = [{ name = "pytest", specifier = "==8.4.2" }]',
    'dev = [{ name = "pytest", specifier = "==8.4.2" }]',
    'legacy = [{ name = "pytest", specifier = "==8.4.2" }]',
  ]));
  const legacy = pairProblems(manifestOf([...groups, 'legacy = [{ include = "test" }]']), legacyLock);
  assert.equal(legacy.length, 1, legacy.join("; "));
  assert.match(legacy[0], /dependency group legacy declares \{ include = "test" \}/, legacy[0]);
  assert.match(legacy[0], /cannot certify that group-reference spelling/, legacy[0]);
  assert.ok(!/does not match pyproject/.test(legacy[0]), "the reader names the construct, not a mismatch it cannot prove");

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
  const danglingInclude = pairProblems(manifestOf(["dependencies = []", "", "[dependency-groups]", 'lab = [{ include-group = "absent" }]']), unmodellableLock);
  assert.ok(danglingInclude.some((problem) => /includes "absent", which the manifest does not declare/.test(problem)), danglingInclude.join("; "));
});

// uv writes `requires-python = ">=3.12"` for a manifest that declares none and then accepts that lock:
// measured on this host with uv 0.13.6 (`lock --check` exit 0, warning "No `requires-python` value found
// in the workspace. Defaulting to `>=3.12`") and with uv 0.5.0 (`sync --locked --python 3.12` exit 0) on
// the shipped worker shape. Comparing the manifest's silence against uv's own sentence reported drift on
// a lock uv itself wrote. `scripts/lockintegrity.py` has always carried this exception; the reader now
// carries it too, so the two gates answer this pair the same way.
test("uv's own default requires-python is not drift", () => {
  const without = manifestOf(['dependencies = ["pypdf==6.4.1"]']).replace('requires-python = ">=3.12,<3.15"\n', "");
  const uvDefault = lockOf(rootOf(["[package.metadata]", 'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]']))
    .replace('requires-python = ">=3.12, <3.15"', 'requires-python = ">=3.12"');
  assert.deepEqual(pairProblems(without, uvDefault), [], pairProblems(without, uvDefault).join("; "));
  const upperBound = pairProblems(without, lockOf(rootOf(["[package.metadata]", 'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]'])));
  assert.equal(upperBound.length, 1, upperBound.join("; "));
  assert.match(upperBound[0], /pyproject declares no requires-python but the lock records ">=3\.12, <3\.15"/, "an upper bound is a constraint the manifest dropped, not uv's default");
});

// `dynamic = ["dependencies"]` is filled in by the build backend, so the manifest half of the
// `requires-dist` comparison does not exist. Measured with uv 0.13.6 in /tmp/align: the pair uv wrote for
// such a project passes `lock --check` (exit 0), and emptying `[package.metadata] requires-dist` while the
// root entry's resolved `dependencies` still names the distributions makes it exit 1. The reader skips the
// first comparison and runs the second — the same pair `scripts/lockintegrity.py` reports the same way.
test("a dynamic = [\"dependencies\"] pair is compared against the lock, not against the manifest", () => {
  const pyproject = [
    "[project]",
    'name = "demo"',
    'version = "0.1.0"',
    'requires-python = ">=3.12,<3.15"',
    'dynamic = ["dependencies"]',
    "",
    "[build-system]",
    'requires = ["setuptools>=68"]',
    'build-backend = "setuptools.build_meta"',
    "",
    "[tool.setuptools.dynamic]",
    'dependencies = { file = ["requirements.txt"] }',
  ].join("\n");
  const root = [
    "[[package]]",
    'name = "demo"',
    'version = "0.1.0"',
    'source = { editable = "." }',
    "dependencies = [",
    '    { name = "pypdf" },',
    "]",
    "",
    "[package.metadata]",
    'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
  ].join("\n");
  const lock = lockOf(root);
  assert.deepEqual(pairProblems(pyproject, lock), [], "an empty [project.dependencies] beside the resolved set is not drift");
  const emptied = pairProblems(pyproject, lock.replace('requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]', "requires-dist = []"));
  assert.equal(emptied.length, 1, emptied.join("; "));
  assert.match(emptied[0], /resolves pypdf but its \[package\.metadata\] records no such requirement/, emptied[0]);
});
// entries contradict each other or its project fails before any comparison happens. Each of these was
// measured with `/tmp/uvs/uv-0.13.6 lock --check` against a real pair (exit 2 for the lock-internal
// ones, exit 1 for the source-mode one) and none of it was visible to a reader that only compares
// metadata.
test("a lock whose own entries contradict the project or themselves is named, not certified", () => {
  const registry = (name, version, fileVersion) => [
    "[[package]]",
    `name = "${name}"`,
    `version = "${version}"`,
    'source = { registry = "https://pypi.org/simple" }',
    `sdist = { url = "https://files.pythonhosted.org/packages/00/00/${name}-${fileVersion}.tar.gz", hash = "sha256:0", size = 1 }`,
    "wheels = [",
    `    { url = "https://files.pythonhosted.org/packages/00/00/${name}-${fileVersion}-py3-none-any.whl", hash = "sha256:0", size = 1 },`,
    "]",
    "",
  ].join("\n");
  const root = [
    "[[package]]",
    'name = "demo"',
    'version = "0.1.0"',
    'source = { virtual = "." }',
    "dependencies = [",
    '    { name = "pypdf" },',
    "]",
    "",
    "[package.metadata]",
    'requires-dist = [{ name = "pypdf", specifier = "==6.4.1" }]',
    "",
  ].join("\n");
  const pyproject = manifestOf(['dependencies = ["pypdf==6.4.1"]']);
  const lock = ["version = 1", "revision = 5", 'requires-python = ">=3.12, <3.15"', "", registry("pypdf", "6.4.1", "6.4.1"), root].join("\n");
  assert.deepEqual(pairProblems(pyproject, lock), [], "the well-formed pair is current");

  const dropped = lock.replace(registry("pypdf", "6.4.1", "6.4.1"), "");
  assert.match(pairProblems(pyproject, dropped).join("; "), /resolves pypdf for the project but records no \[\[package\]\] entry for it/, "a dependency uv resolved has no entry to resolve to");

  const duplicated = lock.replace(registry("pypdf", "6.4.1", "6.4.1"), registry("pypdf", "6.4.1", "6.4.1") + registry("pypdf", "6.4.1", "6.4.1"));
  assert.match(pairProblems(pyproject, duplicated).join("; "), /2 \[\[package\]\] entries for pypdf/, "uv cannot pick one of two entries for the same dependency");

  const handEdited = lock.replace(registry("pypdf", "6.4.1", "6.4.1"), registry("pypdf", "6.4.2", "6.4.1"));
  assert.match(pairProblems(pyproject, handEdited).join("; "), /records version 6\.4\.2 but carries pypdf-6\.4\.1\.(tar\.gz|py3-none-any\.whl) with version 6\.4\.1/, "a pin edited without its filenames is a malformed entry");

  const noPython = lock.replace('requires-python = ">=3.12, <3.15"\n', "");
  assert.match(pairProblems(pyproject, noPython).join("; "), /the lockfile records none/, "uv refuses to parse a lock with no requires-python");

  const manifestNoPython = manifestOf(['dependencies = ["pypdf==6.4.1"]']).replace('requires-python = ">=3.12,<3.15"\n', "");
  assert.match(pairProblems(manifestNoPython, lock).join("; "), /pyproject declares no requires-python but the lock records/, "a lock that keeps a Python requirement the manifest dropped is stale");

  const packaged = manifestOf(['dependencies = ["pypdf==6.4.1"]', "", "[build-system]", 'requires = ["hatchling==1.27.0"]', 'build-backend = "hatchling.build"']);
  assert.match(pairProblems(packaged, lock).join("; "), /source is virtual = "\." but the manifest declares a \[build-system\]/, "uv records a packaged project as editable");
  assert.match(pairProblems(pyproject, lock.replace('source = { virtual = "." }', 'source = { editable = "packages/demo" }')).join("; "),
    /source path "packages\/demo" does not point at "\."/, "the root entry has to point at the project directory");
});

test("the local entry is used when a registry package shares the project name", () => {
  const pyproject = [
    "[project]",
    'name = "pypdf"',
    'version = "0.1.0"',
    'requires-python = ">=3.12,<3.15"',
    'dependencies = ["pypdf==6.4.1"]',
    "",
    // The lock below records the project as `editable`, which is what a manifest with a build-system
    // gets: without this table the pair is a source-mode mismatch as well as a shared-name case.
    "[build-system]",
    'requires = ["hatchling==1.27.0"]',
    'build-backend = "hatchling.build"',
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
// has to refuse the same lock or the two guards disagree about a shipped pair. The ceiling is what
// this toolkit supports, not what uv reads: uv 0.13.6 and 0.9.30 both accept `revision = 6`.
test("a lock revision above the supported maximum is named, as the Python guard names it", () => {
  const pyproject = manifestOf(['dependencies = ["pypdf==6.4.1"]']);
  const lock = lockOf(rootOf(["[package.metadata]", "requires-dist = [", '    { name = "pypdf", specifier = "==6.4.1" },', "]"]));
  assert.deepEqual(pairProblems(pyproject, lock), [], "the reviewed revision is accepted");
  const ahead = pairProblems(pyproject, lock.replace("revision = 5", "revision = 9"));
  assert.equal(ahead.length, 1, ahead.join("; "));
  assert.match(ahead[0], /lockfile revision 9 is above 5, the highest lockfile revision this toolkit supports/);
  assert.ok(/support limit, not uv's own ceiling/.test(ahead[0]), "the message says this is a support policy, not a uv limitation");
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


test("optional-dependencies are compared the way uv records them (review finding 20)", () => {
  const pyproject = read(path.join(WORKER, "pyproject.toml"));
  const shippedLock = read(path.join(WORKER, "uv.lock"));
  const withExtras = pyproject.replace("[project.scripts]", '[project.optional-dependencies]\npdf = ["pypdf==6.4.1"]\n\n[project.scripts]');
  const extraEntry = "    { name = \"pypdf\", marker = \"extra == 'pdf'\", specifier = \"==6.4.1\" },";
  const recorded = shippedLock.replace(
    '    { name = "python-docx", specifier = "==1.2.0" },\n]',
    `    { name = "python-docx", specifier = "==1.2.0" },\n${extraEntry}\n]\nprovides-extras = ["pdf"]`);
  assert.notEqual(recorded, shippedLock, "the fixture must actually reach the root package metadata");

  // Measured with `/tmp/uvs/uv-0.13.6 lock --check` and `sync --locked --dry-run --python 3.12` on
  // this pair: exit 0 both ways. uv writes the extra into `requires-dist` with an `extra ==` marker
  // and names the group in `provides-extras`; a reader that called that pair stale would refuse a
  // build uv is happy with.
  assert.deepEqual(pairProblems(withExtras, recorded), [], "uv records an optional dependency as a marked requirement plus a provides-extras name");

  // A pin the lock never recorded is drift even though the group name is nowhere in the lock.
  const wrongPin = pyproject.replace("[project.scripts]", '[project.optional-dependencies]\npdf = ["pypdf==6.4.2"]\n\n[project.scripts]');
  assert.ok(pairProblems(wrongPin, shippedLock).length >= 1, "an optional dependency the lock never recorded is drift");

  assert.ok(pairProblems(pyproject, recorded).length >= 1, "extras the manifest does not declare are drift");

  // The same `requires-dist` entries with no `provides-extras` at all — the shape a uv 0.5.0 lock has.
  // Measured on this host: uv 0.5.0 `sync --locked --python 3.12` accepts it (exit 0), uv 0.13.6
  // `lock --check` refuses it (exit 1). The reader follows the uv this toolkit ships against, so the
  // pair is a problem; the key is only forgiven when the manifest declares nothing for it to name,
  // which is the shipped case (`pairProblems(pyproject, shippedLock)` is empty below).
  const olderUv = shippedLock.replace(
    '    { name = "python-docx", specifier = "==1.2.0" },\n]',
    `    { name = "python-docx", specifier = "==1.2.0" },\n${extraEntry}\n]`);
  const missing = pairProblems(withExtras, olderUv);
  assert.equal(missing.length, 1, missing.join("; "));
  assert.match(missing[0], /provides-extras \(key absent\) does not match pyproject optional-dependencies pdf/);
  assert.deepEqual(pairProblems(pyproject, shippedLock), [], "a manifest with no extras beside a lock with no provides-extras is current");
});

test("a single-quoted TOML scalar is read, not mistaken for a version mismatch (review finding 21)", () => {
  const pyproject = read(path.join(WORKER, "pyproject.toml"));
  const lock = read(path.join(WORKER, "uv.lock"));
  const literal = pyproject.replace(/^version = "([^"]*)"/m, "version = '$1'");
  assert.notEqual(literal, pyproject, "the fixture must actually rewrite the version scalar");
  assert.deepEqual(pairProblems(literal, lock), [], "TOML literal strings are valid in a manifest the toolkit has to read");
});
