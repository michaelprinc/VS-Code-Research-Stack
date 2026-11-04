"use strict";

/**
 * Adversarial pairs for `extension/lockfile.js`. Every verdict below was measured on this host with
 * real uv: `/tmp/uvs/uv-0.13.6 lock --check` and `sync --locked --dry-run --python 3.12`, plus
 * `uv-0.5.0 sync --locked --python 3.12` for the declared floor. The uv exit code each row records is
 * the measured one; the mini pairs are locks `uv 0.13.6` wrote itself, so uv's own verdict on them
 * is `lock --check` exit 0.
 *
 *   AGREES   — reader and uv give the same verdict.
 *   FLAGGED  — reader reports problems, uv accepts the pair: a false positive, which blocks
 *              `npm run package`. A row lives here only while the reader is still wrong.
 *   UNCAUGHT — reader reports no problems, uv refuses the pair: the 0.3.6 field failure shape, a
 *              shipped pair real uv rejects at install time. A row lives here only while the reader
 *              still misses it.
 *
 * Fixed defects are not left as characterization rows: a row that asserts a bug the reader no longer
 * has is a false record, so each fix moved its pair into AGREES with uv's measured verdict.
 *
 * These rows are also the cross-reader gate. `scripts/lockintegrity.py` is run over exactly the same
 * pairs (extracted from this file) and must reach the same verdict on every one of them: two gates that
 * answer the same pair differently is itself a defect. The two pairs that used to diverge — the PEP 735
 * group reference and `dynamic = ["dependencies"]` — are in AGREES now, each with the uv run that
 * justifies its place:
 *
 *   `{ include-group = "dev" }` flattens (uv 0.13.6 `lock --check` exit 0 on the pair it wrote, and
 *   `uv-0.5.0 sync --locked --python 3.12` exit 0 on the same pair), so both readers flatten it.
 *   `{ include = "dev" }` is refused by uv 0.13.6 against either lock (`lock --check` exit 2, "Group
 *   `test` contains an unknown dependency object specifier") even though uv 0.5.0 accepted it and locked
 *   the group as empty (`sync --locked --python 3.12` exit 0), so both readers report it as a construct
 *   they cannot certify — never as a group mismatch, and never as a clean pair.
 *   `dynamic = ["dependencies"]` skips the `requires-dist` comparison in both readers (uv 0.13.6
 *   `lock --check` exit 0 on the pair uv wrote) and both compare the lock against itself instead:
 *   emptying `requires-dist` while the resolved half still names the distributions is exit 1.
 *
 * uv is consulted only by the cross-check test at the end. It is looked up by absolute path, never
 * from PATH, and that test skips cleanly when no binary is present.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pairProblems, markerKey, requirementKey, specifierKey, splitRequirement, canonicalName,
  lockResolutionMarkerProblems } = require("../lockfile.js");

const WORKER = path.join(__dirname, "..", "worker");
const BASE_PY = fs.readFileSync(path.join(WORKER, "pyproject.toml"), "utf8");
const BASE_LOCK = fs.readFileSync(path.join(WORKER, "uv.lock"), "utf8");
const UV = ["/tmp/uvs/uv-0.13.6", "/tmp/uvs/uv", process.env.DSH_UV_BIN].find((p) => p && fs.existsSync(p));

const sub = (text, pairs) => pairs.reduce((acc, [from, to]) => acc.replace(from, to), text);
const pyWith = (pairs) => sub(BASE_PY, pairs);
const lockWith = (pairs) => sub(BASE_LOCK, pairs);
const packageStart = (lock, name) => lock.indexOf(`[[package]]\nname = "${name}"`);
const dropPackage = (lock, name) => {
  const start = packageStart(lock, name);
  return lock.slice(0, start) + lock.slice(lock.indexOf("[[package]]", start + 5));
};
const dupPackage = (lock, name) => {
  const start = packageStart(lock, name);
  const end = lock.indexOf("[[package]]", start + 5);
  const block = lock.slice(start, end);
  return lock.slice(0, start) + block + block + lock.slice(end);
};
const dropArtifacts = (lock, name) => {
  const start = packageStart(lock, name);
  const end = lock.indexOf("[[package]]", start + 5);
  const block = lock.slice(start, end).replace(/^sdist = \{.*\n/m, "").replace(/^wheels = \[\n(?:.*\n)*?\]\n/m, "");
  return lock.slice(0, start) + block + lock.slice(end);
};
const stray = (lock, at) => `${lock.slice(0, at)}[[package]]\nname = "other-member"\nversion = "1.0.0"\nsource = { editable = "packages/other-member" }\n\n${lock.slice(at)}`;
/** Rewrite one entry's `sdist = { … }` into the list form uv never writes. */
const sdistAsList = (lock, name = "pypdf") => {
  const start = packageStart(lock, name);
  const end = lock.indexOf("[[package]]", start + 5);
  const block = lock.slice(start, end).replace(/^sdist = \{ (.*) \}[ \t]*\r?\n/m, "sdist = [\n    { $1 },\n]\n");
  return lock.slice(0, start) + block + lock.slice(end);
};

/** Written by uv 0.13.6 for the manifest beside it (`lock --check` exit 0). */
const MINI_PY = `[project]\nname = "adv-demo"\nversion = "1.0.0"\nrequires-python = ">=3.12"\ndependencies = ["packaging==24.0"]\n\n[project.optional-dependencies]\ncli_tools = ["packaging==24.0"]\n\n[dependency-groups]\ndev = ["iniconfig==2.1.0"]\n`;
const MINI_LOCK = `version = 1\nrevision = 5\nrequires-python = ">=3.12"\n\n[[package]]\nname = "adv-demo"\nversion = "1.0.0"\nsource = { virtual = "." }\ndependencies = [\n    { name = "packaging" },\n]\n\n[package.optional-dependencies]\ncli-tools = [\n    { name = "packaging" },\n]\n\n[package.dev-dependencies]\ndev = [\n    { name = "iniconfig" },\n]\n\n[package.metadata]\nrequires-dist = [\n    { name = "packaging", specifier = "==24.0" },\n    { name = "packaging", marker = "extra == 'cli-tools'", specifier = "==24.0" },\n]\nprovides-extras = ["cli-tools"]\n\n[package.metadata.requires-dev]\ndev = [{ name = "iniconfig", specifier = "==2.1.0" }]\n\n[[package]]\nname = "iniconfig"\nversion = "2.1.0"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
/** `dynamic = ["dependencies"]` resolved from requirements.txt by setuptools; uv wrote this lock. */
const DYN_PY = `[project]\nname = "adv-dyn"\nversion = "1.0.0"\nrequires-python = ">=3.12"\ndynamic = ["dependencies"]\n\n[build-system]\nrequires = ["setuptools>=68"]\nbuild-backend = "setuptools.build_meta"\n\n[tool.setuptools.dynamic]\ndependencies = { file = ["requirements.txt"] }\n`;
const DYN_LOCK = `version = 1\nrevision = 5\nrequires-python = ">=3.12"\n\n[[package]]\nname = "adv-dyn"\nversion = "1.0.0"\nsource = { editable = "." }\ndependencies = [\n    { name = "iniconfig" },\n    { name = "packaging" },\n]\n\n[package.metadata]\nrequires-dist = [\n    { name = "iniconfig", specifier = "==2.1.0" },\n    { name = "packaging", specifier = "==24.0" },\n]\n\n[[package]]\nname = "iniconfig"\nversion = "2.1.0"\nsource = { registry = "https://pypi.org/simple" }\n\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
/** uv rewrote the manifest's `python_version` marker into `python_full_version` when it locked. */
const MARKER_PY = `[project]\nname = "adv-demo"\nversion = "1.0.0"\nrequires-python = ">=3.12"\ndependencies = ["packaging==24.0; python_version >= '3.13'"]\n`;
const MARKER_LOCK = `version = 1\nrevision = 5\nrequires-python = ">=3.12"\nresolution-markers = [\n    "python_full_version >= '3.13'",\n    "python_full_version < '3.13'",\n]\n\n[[package]]\nname = "adv-demo"\nversion = "1.0.0"\nsource = { virtual = "." }\ndependencies = [\n    { name = "packaging", marker = "python_full_version >= '3.13'" },\n]\n\n[package.metadata]\nrequires-dist = [{ name = "packaging", marker = "python_full_version >= '3.13'", specifier = "==24.0" }]\n\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
/** A compound marker, pair written by uv 0.13.6: uv hoists the python clause and keeps the rest. */
const COMPOUND_PY = `[project]\nname = "mk-compound"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.15"\ndependencies = ["packaging==24.0; sys_platform == 'win32' and python_version >= '3.13'"]\n`;
const COMPOUND_LOCK = `version = 1\nrevision = 5\nrequires-python = ">=3.12, <3.15"\nresolution-markers = [\n    "python_full_version >= '3.13' and sys_platform == 'win32'",\n    "python_full_version < '3.13' or sys_platform != 'win32'",\n]\n\n[[package]]\nname = "mk-compound"\nversion = "1.0.0"\nsource = { virtual = "." }\ndependencies = [\n    { name = "packaging", marker = "python_full_version >= '3.13' and sys_platform == 'win32'" },\n]\n\n[package.metadata]\nrequires-dist = [{ name = "packaging", marker = "python_full_version >= '3.13' and sys_platform == 'win32'", specifier = "==24.0" }]\n\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\nsdist = { url = "https://files.pythonhosted.org/packages/ee/b5/b43a27ac7472e1818c4bafd44430e69605baefe1f34440593e0332ec8b4d/packaging-24.0.tar.gz", hash = "sha256:eb82c5e3e56209074766e6885bb04b8c38a0c015d0a30036ebe7ece34c9989e9", size = 147882, upload-time = "2024-03-10T09:39:28.33Z" }\nwheels = [\n    { url = "https://files.pythonhosted.org/packages/49/df/1fceb2f8900f8639e278b056416d49134fb8d84c5942ffaa01ad34782422/packaging-24.0-py3-none-any.whl", hash = "sha256:2ddfb553fdf02fb784c234c7ba6ccc288296ceabec964ad2eae3777778130bc5", size = 53488, upload-time = "2024-03-10T09:39:25.947Z" },\n]\n`;

const DYN_VERSION_PY = pyWith([['version = "0.3.7"\n', 'dynamic = ["version"]\n'],
  ["[tool.hatch.build.targets.wheel]", '[tool.hatch.version]\npath = "src/research_stack/__init__.py"\n\n[tool.hatch.build.targets.wheel]']]);
const NO_VERSION_LOCK = lockWith([['name = "research-stack-basic"\nversion = "0.3.7"', 'name = "research-stack-basic"']]);
const EXTRA_PY = pyWith([["[dependency-groups]", '[project.optional-dependencies]\npdf = ["pypdf==6.4.1"]\n\n[dependency-groups]']]);
const EMPTY_EXTRA_PY = pyWith([["[dependency-groups]", '[project.optional-dependencies]\npdf = []\n\n[dependency-groups]']]);
const PEP735_PY = pyWith([['dev = ["pytest==8.4.2"]', 'dev = ["pytest==8.4.2"]\ntest = [{ include = "dev" }]']]);
const PEP735_LOCK = lockWith([['dev = [{ name = "pytest", specifier = "==8.4.2" }]',
  'dev = [{ name = "pytest", specifier = "==8.4.2" }]\ntest = []']]);
/** `{ include-group = "dev" }`: what uv 0.13.6 accepts, and the lock it wrote for it (`lock --check` exit 0). */
const INCLUDE_GROUP_PY = PEP735_PY.replace('{ include = "dev" }', '{ include-group = "dev" }');
const INCLUDE_GROUP_LOCK = PEP735_LOCK.replace('test = []', 'test = [{ name = "pytest", specifier = "==8.4.2" }]');
/** The same dynamic pair with `requires-dist` emptied while the resolved half still names both. */
const DYN_LOCK_NO_METADATA = DYN_LOCK.replace(
  'requires-dist = [\n    { name = "iniconfig", specifier = "==2.1.0" },\n    { name = "packaging", specifier = "==24.0" },\n]',
  "requires-dist = []");
/** The manifest's own build-system removed, so the shipped `editable` lock no longer matches it. */
const NO_BUILDSYS_PY = pyWith([['[build-system]\nrequires = ["hatchling==1.27.0"]\nbuild-backend = "hatchling.build"\n\n', ""]]);
/** A marker the manifest added and the lock never recorded. */
const MARKER_ADDED_PY = pyWith([['"pypdf==6.4.1"', '"pypdf==6.4.1; python_version >= \'3.13\'"']]);

/**
 * A probe project uv 0.13.6 locked itself, used for the `[tool.uv]` resolution inputs. The lock is
 * byte-for-byte what uv wrote (receipts `/tmp/adv-037/pairs/P06-override-same.*` and friends) with the
 * `sdist`/`wheels` hash lines elided — they carry no part of the verdict.
 */
const PROBE_PY = `[project]\nname = "p-override-same"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.15"\ndependencies = ["packaging==24.0"]\n`;
const PROBE_LOCK = `version = 1\nrevision = 5\nrequires-python = ">=3.12, <3.15"\n\n[[package]]\nname = "p-override-same"\nversion = "1.0.0"\nsource = { virtual = "." }\ndependencies = [\n    { name = "packaging" },\n]\n\n[package.metadata]\nrequires-dist = [{ name = "packaging", specifier = "==24.0" }]\n\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
/** The same project with `dynamic = ["optional-dependencies"]` filled in by setuptools; uv wrote this lock. */
const DYN_EXTRA_PY = `[project]\nname = "p-dyn-extra"\nversion = "1.0.0"\nrequires-python = ">=3.12"\ndynamic = ["optional-dependencies"]\n\n[build-system]\nrequires = ["setuptools>=68"]\nbuild-backend = "setuptools.build_meta"\n\n[tool.setuptools.dynamic]\noptional-dependencies = { pdf = { file = ["extras.txt"] } }\n`;
const DYN_EXTRA_LOCK = `version = 1\nrevision = 5\nrequires-python = ">=3.12"\n\n[[package]]\nname = "p-dyn-extra"\nversion = "1.0.0"\nsource = { editable = "." }\ndependencies = [\n    { name = "packaging" },\n]\n\n[package.metadata]\nrequires-dist = [\n    { name = "packaging", marker = "extra == 'pdf'", specifier = "==24.0" },\n]\nprovides-extras = ["pdf"]\n\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
/** A probe pair whose root version uv normalised: manifest `1.0-1`, lock `1.0.post1`. */
const POST_PY = `[project]\nname = "p-post"\nversion = "1.0-1"\nrequires-python = ">=3.12"\ndependencies = ["packaging==24.0"]\n`;
const POST_LOCK = `version = 1\nrevision = 5\nrequires-python = ">=3.12"\n\n[[package]]\nname = "p-post"\nversion = "1.0.post1"\nsource = { virtual = "." }\ndependencies = [\n    { name = "packaging" },\n]\n\n[package.metadata]\nrequires-dist = [{ name = "packaging", specifier = "==24.0" }]\n\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
/** A marker whose atoms the manifest wrote in the other order than uv recorded them. */
const ATOM_ORDER_PY = `[project]\nname = "mk-atoms"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.15"\ndependencies = ["packaging==24.0; platform_machine == 'x86_64' and os_name == 'posix'"]\n`;
const ATOM_ORDER_LOCK = `version = 1\nrevision = 5\nrequires-python = ">=3.12, <3.15"\n\n[[package]]\nname = "mk-atoms"\nversion = "1.0.0"\nsource = { virtual = "." }\ndependencies = [\n    { name = "packaging", marker = "os_name == 'posix' and platform_machine == 'x86_64'" },\n]\n\n[package.metadata]\nrequires-dist = [{ name = "packaging", marker = "os_name == 'posix' and platform_machine == 'x86_64'", specifier = "==24.0" }]\n\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
/** `python_version ~= …` and `python_version in …`, each pair written by uv 0.13.6. */
const TILDE_PY = `[project]\nname = "mk-tilde"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.15"\ndependencies = ["packaging==24.0; python_version ~= '3.12'"]\n`;
const TILDE_LOCK = `version = 1\nrevision = 5\nrequires-python = ">=3.12, <3.15"\n\n[[package]]\nname = "mk-tilde"\nversion = "1.0.0"\nsource = { virtual = "." }\ndependencies = [\n    { name = "packaging", marker = "python_full_version >= '3.12' and python_full_version < '4'" },\n]\n\n[package.metadata]\nrequires-dist = [{ name = "packaging", marker = "python_full_version >= '3.12' and python_full_version < '4'", specifier = "==24.0" }]\n\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\n`;
const IN_PY = `[project]\nname = "mk-in"\nversion = "1.0.0"\nrequires-python = ">=3.12,<3.15"\ndependencies = ["packaging==24.0; python_version in '3.12 3.13'"]\n`;
const IN_LOCK = `version = 1\nrevision = 5\nrequires-python = ">=3.12, <3.15"\n\n[[package]]\nname = "mk-in"\nversion = "1.0.0"\nsource = { virtual = "." }\ndependencies = [\n    { name = "packaging", marker = "python_full_version >= '3.12' and python_full_version < '3.14'" },\n]\n\n[package.metadata]\nrequires-dist = [{ name = "packaging", marker = "python_full_version >= '3.12' and python_full_version < '3.14'", specifier = "==24.0" }]\n\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\n`;

const AGREES = [
  ["shipped worker pair", BASE_PY, BASE_LOCK, 0],
  ["root version bumped, lock not re-locked (the 0.3.6 defect)", pyWith([['version = "0.3.7"', 'version = "0.3.8"']]), BASE_LOCK, 1],
  ["dependency dropped from the manifest", pyWith([['  "pypdf==6.4.1",\n', ""]]), BASE_LOCK, 1],
  ["dependency specifier changed", pyWith([['"pypdf==6.4.1"', '"pypdf==6.9.9"']]), BASE_LOCK, 1],
  ["group added to the manifest", pyWith([['dev = ["pytest==8.4.2"]', 'dev = ["pytest==8.4.2"]\ntyping = ["typing-extensions==4.16.0"]']]), BASE_LOCK, 1],
  ["group dropped from the manifest", pyWith([['[dependency-groups]\ndev = ["pytest==8.4.2"]\n', ""]]), BASE_LOCK, 1],
  ["extras requirement mcp[cli] against a uv-written lock", pyWith([['"mcp==2.2.0"', '"mcp[cli]==2.2.0"']]),
    lockWith([['{ name = "mcp", specifier = "==2.2.0" }', '{ name = "mcp", extras = ["cli"], specifier = "==2.2.0" }']]), 0],
  ["extra dropped from the manifest, lock still lists provides-extras", BASE_PY,
    lockWith([["[package.metadata]\n", '[package.metadata]\nprovides-extras = ["pdf"]\n']]), 1],
  ["declared extra, lock records provides-extras = []", EXTRA_PY,
    lockWith([["[package.metadata]\n", "[package.metadata]\nprovides-extras = []\n"]]), 1],
  ["dynamic version: the uv-written lock root entry carries no version", DYN_VERSION_PY, NO_VERSION_LOCK, 0],
  ["dynamic version, but the lock records one anyway", DYN_VERSION_PY, BASE_LOCK, 1],
  ["static version, lock root entry carries none", BASE_PY, NO_VERSION_LOCK, 1],
  ["CRLF pyproject.toml", BASE_PY.replace(/\n/g, "\r\n"), BASE_LOCK, 0],
  ["CRLF uv.lock", BASE_PY, BASE_LOCK.replace(/\n/g, "\r\n"), 0],
  ["tabs, comments inside the array, trailing comma", pyWith([['  "mcp==2.2.0",\n  "mcp-types==2.2.0",\n  "pypdf==6.4.1",',
    '\t"mcp==2.2.0",  # transport\n\t"mcp-types==2.2.0",\n\t# pinned by the release\n\t"pypdf==6.4.1",']]), BASE_LOCK, 0],
  ["requires-python written as ==3.12.* on both sides", pyWith([['requires-python = ">=3.12,<3.15"', 'requires-python = "==3.12.*"']]),
    lockWith([['requires-python = ">=3.12, <3.15"', 'requires-python = "==3.12.*"']]), 0],
  ["=== and ~= specifiers, as uv recorded them", pyWith([['"pypdf==6.4.1"', '"pypdf===6.4.1"'], ['"python-docx==1.2.0"', '"python-docx~=1.2"']]),
    lockWith([['{ name = "pypdf", specifier = "==6.4.1" }', '{ name = "pypdf", specifier = "===6.4.1" }'],
      ['{ name = "python-docx", specifier = "==1.2.0" }', '{ name = "python-docx", specifier = "~=1.2" }']]), 0],
  ["project name in a non-canonical spelling", pyWith([['name = "research-stack-basic"', 'name = "Research_Stack.Basic"']]), BASE_LOCK, 0],
  ["lock spells the root name with underscores", BASE_PY, lockWith([['name = "research-stack-basic"', 'name = "research_stack_basic"']]), 0],
  ["uv's own marker rewrite (python_version -> python_full_version) is not drift",
    pyWith([['"pypdf==6.4.1"', '"pypdf==6.4.1; python_full_version >= \'3.13\'"']]),
    lockWith([['{ name = "pypdf", specifier = "==6.4.1" }', '{ name = "pypdf", marker = "python_full_version >= \'3.13\'", specifier = "==6.4.1" }']]), 0],
  ["marker pair exactly as uv wrote it", MARKER_PY, MARKER_LOCK, 0],
  ["manifest spells the marker python_full_version", MARKER_PY.replace("python_version", "python_full_version"), MARKER_LOCK, 0],
  ["compound marker pair exactly as uv wrote it (python clause hoisted, rest kept in order)", COMPOUND_PY, COMPOUND_LOCK, 0],
  ["comments and a trailing comment on a [[package]] header", BASE_PY,
    lockWith([['[[package]]\nname = "pypdf"', '# pinned by the release\n[[package]] # the pdf reader\nname = "pypdf"']]), 0],
  ["sdist and wheels lists removed from one package", BASE_PY, dropArtifacts(BASE_LOCK, "pypdf"), 0],
  ["[tool.uv] no-build-isolation-package added", BASE_PY + '\n[tool.uv]\nno-build-isolation-package = ["hatchling"]\n', BASE_LOCK, 0],
  ["[tool.uv] default-groups added (uv does not treat it as staleness)", BASE_PY + '\n[tool.uv]\ndefault-groups = ["dev"]\n', BASE_LOCK, 0],
  ["[tool.uv] index = [ … ] added (uv accepts the lock unchanged)", BASE_PY + '\n[tool.uv]\nindex = [{ name = "pypi", url = "https://pypi.org/simple" }]\n', BASE_LOCK, 0],
  ["[tool.uv] default-index added (uv accepts the lock unchanged)", BASE_PY + '\n[tool.uv]\ndefault-index = "https://pypi.org/simple"\n', BASE_LOCK, 0],
  ["[tool.uv] find-links added (measured with the directory present: uv accepts)", BASE_PY + '\n[tool.uv]\nfind-links = ["./wheels"]\n', BASE_LOCK, 0],
  ["[tool.uv] override-dependencies added without a re-lock", BASE_PY + '\n[tool.uv]\noverride-dependencies = ["pydantic==2.10.0"]\n', BASE_LOCK, 1],
  ["[tool.uv] constraint-dependencies added without a re-lock", BASE_PY + '\n[tool.uv]\nconstraint-dependencies = ["typing-extensions>=4.12"]\n', BASE_LOCK, 1],
  ["tool.uv.sources moved pypdf to a git source", BASE_PY + '\n[tool.uv]\nsources = { pypdf = { git = "https://github.com/py-pdf/pypdf" } }\n', BASE_LOCK, 1],
  ["[tool.uv] required-environments added", BASE_PY + "\n[tool.uv]\nrequired-environments = [\"sys_platform == 'win32'\"]\n", BASE_LOCK, 1],
  ["[tool.uv] environments added", BASE_PY + "\n[tool.uv]\nenvironments = [\"sys_platform == 'win32'\"]\n", BASE_LOCK, 1],
  ["[tool.uv] exclude-newer added", BASE_PY + '\n[tool.uv]\nexclude-newer = "3 days"\n', BASE_LOCK, 1],
  ["mini pair with the extra spelled cli-tools", MINI_PY.replace("cli_tools = ", "cli-tools = "), MINI_LOCK, 0],
  ["parenthesised extras mcp(cli), which no build backend accepts", pyWith([['"mcp==2.2.0"', '"mcp(cli)==2.2.0"']]), BASE_LOCK, 2],
  ["PEP 735 `{ include = \"dev\" }` against the uv 0.13.6 lock (uv 0.13.6 lock --check exit 2: unknown dependency object specifier; uv 0.5.0 sync --locked exit 0)", PEP735_PY, BASE_LOCK, 2],
  ["PEP 735 `{ include-group = \"dev\" }` pair exactly as uv 0.13.6 wrote it (uv 0.13.6 lock --check exit 0, uv 0.5.0 sync --locked exit 0)", INCLUDE_GROUP_PY, INCLUDE_GROUP_LOCK, 0],
  ["stray editable entry after the root entry (the Python reader flags this one)", BASE_PY, stray(BASE_LOCK, BASE_LOCK.length), 0],
  ["UTF-8 BOM on pyproject.toml (uv 0.6.10 through 0.13.6 read it, exit 0; uv 0.5.0 exits 2, \"Failed to prepare distributions\" — see the P21a/P21d rows)", "\ufeff" + BASE_PY, BASE_LOCK, 0],
  ["UTF-8 BOM on uv.lock", BASE_PY, "\ufeff" + BASE_LOCK, 0],
  // Fixed false positives: uv accepts these, the reader used to refuse them.
  ["requirement written as a triple-quoted multi-line string", pyWith([['"pypdf==6.4.1"', '"""pypdf==6.4.1"""']]), BASE_LOCK, 0],
  ["requirement written as a triple-single-quoted string", pyWith([['"pypdf==6.4.1"', "'''pypdf==6.4.1'''"]]), BASE_LOCK, 0],
  ["extra named cli_tools: uv canonicalises it to cli-tools", MINI_PY, MINI_LOCK, 0],
  ["extra named CLI_TOOLS: uv canonicalises it to cli-tools", MINI_PY.replace("cli_tools = ", "CLI_TOOLS = "), MINI_LOCK, 0],
  ["PEP 440 root version 0.3.7.0 (uv normalises it to 0.3.7)", pyWith([['version = "0.3.7"', 'version = "0.3.7.0"']]), BASE_LOCK, 0],
  ["valid TOML with leading whitespace before [project] keys", pyWith([['name = "research-stack-basic"', '  name = "research-stack-basic"'],
    ['version = "0.3.7"', '  version = "0.3.7"'], ["dependencies = [", "  dependencies = ["]]), BASE_LOCK, 0],
  ["stray editable entry before the root entry", BASE_PY, stray(BASE_LOCK, packageStart(BASE_LOCK, "research-stack-basic")), 0],
  // Fixed false negatives: uv refuses these, the reader used to call them current.
  ["marker added to a requirement, the lock records none", MARKER_ADDED_PY, BASE_LOCK, 1],
  ["marker changed on a requirement", MARKER_PY.replace(">= '3.13'", ">= '3.14'"), MARKER_LOCK, 1],
  ["marker removed from the manifest, lock keeps it", MARKER_PY.replace("; python_version >= '3.13'", ""), MARKER_LOCK, 1],
  ["extra added that reuses an existing pin (no new requirement text)", EXTRA_PY, BASE_LOCK, 1],
  ["extra declared with an empty list", EMPTY_EXTRA_PY, BASE_LOCK, 1],
  ["requires-python dropped from the manifest, lock keeps it", pyWith([['requires-python = ">=3.12,<3.15"\n', ""]]), BASE_LOCK, 1],
  ["requires-python dropped from the manifest, lock records uv's own default >=3.12 (uv 0.13.6 lock --check exit 0, warning: defaulting to >=3.12)", pyWith([['requires-python = ">=3.12,<3.15"\n', ""]]),
    lockWith([['requires-python = ">=3.12, <3.15"', 'requires-python = ">=3.12"']]), 0],
  ["requires-python line dropped from the lock", BASE_PY, lockWith([['requires-python = ">=3.12, <3.15"\n', ""]]), 2],
  ["transitive pin hand-edited in the lock (metadata untouched)", BASE_PY,
    lockWith([['name = "anyio"\nversion = "4.15.1"', 'name = "anyio"\nversion = "4.15.0"']]), 2],
  ["transitive pin hand-edited the other way (recorded version raised, filenames untouched)", BASE_PY,
    lockWith([['name = "iniconfig"\nversion = "2.3.1"', 'name = "iniconfig"\nversion = "2.3.2"']]), 2],
  ["whole [[package]] block of a direct dependency deleted", BASE_PY, dropPackage(BASE_LOCK, "pypdf"), 2],
  ["two [[package]] entries for one resolved dependency", BASE_PY, dupPackage(BASE_LOCK, "pypdf"), 2],
  ["[tool.uv] package = false against an editable lock", BASE_PY + "\n[tool.uv]\npackage = false\n", BASE_LOCK, 1],
  ["build-system removed from the manifest, lock still records editable", NO_BUILDSYS_PY, BASE_LOCK, 1],
  // Fixed false positives, measured against real uv in /tmp/align/*: the reader used to refuse both.
  ["dynamic = [\"dependencies\"] resolved from requirements.txt by setuptools (uv 0.13.6 lock --check exit 0)", DYN_PY, DYN_LOCK, 0],
  ["dynamic = [\"dependencies\"], requires-dist emptied while the resolved half still names iniconfig and packaging (uv 0.13.6 lock --check exit 1)", DYN_PY, DYN_LOCK_NO_METADATA, 1],
  ["PEP 735 `{ include = \"dev\" }` pair written by uv 0.5.0 (uv 0.5.0 sync --locked exit 0, uv 0.13.6 lock --check exit 2): the reader refuses to certify a manifest the pinned build uv rejects, and says so instead of reporting a group mismatch", PEP735_PY, PEP735_LOCK, 2],
  ["P06 [tool.uv] override-dependencies beside the lock uv wrote for it — the lock records [manifest] overrides (uv 0/0/0/0/0/0/0)",
    PROBE_PY + '[tool.uv]\noverride-dependencies = ["packaging==24.0"]\n',
    PROBE_LOCK.replace("\n[[package]]\nname = \"p-override-same\"",
      "\n[manifest]\noverrides = [{ name = \"packaging\", specifier = \"==24.0\" }]\n\n[[package]]\nname = \"p-override-same\""), 0],
  ["P07 [tool.uv] constraint-dependencies beside the lock uv wrote for it — the lock records [manifest] constraints (uv 0/0/0/0/0/0/0)",
    PROBE_PY.replace('name = "p-override-same"', 'name = "p-constraint-same"') + '[tool.uv]\nconstraint-dependencies = ["packaging>=20"]\n',
    PROBE_LOCK.replace('name = "p-override-same"', 'name = "p-constraint-same"')
      .replace("\n[[package]]\nname = \"p-constraint-same\"",
        "\n[manifest]\nconstraints = [{ name = \"packaging\", specifier = \">=20\" }]\n\n[[package]]\nname = \"p-constraint-same\""), 0],
  ["P08 [tool.uv] required-environments beside the lock uv wrote for it — the lock records required-markers (uv 0/0/0/0/0/0/0)",
    PROBE_PY.replace('name = "p-override-same"', 'name = "p-required-envs"') + "[tool.uv]\nrequired-environments = [\"sys_platform == 'linux'\"]\n",
    PROBE_LOCK.replace('name = "p-override-same"', 'name = "p-required-envs"')
      .replace('requires-python = ">=3.12, <3.15"\n', 'requires-python = ">=3.12, <3.15"\nrequired-markers = [\n    "sys_platform == \'linux\'",\n]\n'), 0],
  // ----------------------------------------------------------------------------------------------
  // 0.3.7 measurement round, pairs P01-P64 (receipts `/tmp/adv-037/`). Exit codes are given for
  // uv 0.5.0 / 0.6.10 / 0.7.22 / 0.8.5 / 0.9.30 / 0.10.7 / 0.13.6 in that order; uv 0.5.0 has no
  // `lock --check`, so its row is `uv sync --locked --python 3.12` on a faithful copy of the pair.
  //
  // Specifier ORDER is not drift: a specifier is the SET of its bounds.
  ["P63 shipped worker pair: manifest writes pypdf<7,>=6.4, uv writes specifier = \">=6.4,<7\" (uv 0/0/0/0/0/0/0)",
    pyWith([['"pypdf==6.4.1"', '"pypdf<7,>=6.4"']]),
    lockWith([['{ name = "pypdf", specifier = "==6.4.1" }', '{ name = "pypdf", specifier = ">=6.4,<7" }']]), 0],
  ["P01 probe pair, same reorder on packaging<25,>=24.0 (uv 0/0/0/0/0/0/0)",
    PROBE_PY.replace('dependencies = ["packaging==24.0"]', 'dependencies = ["packaging<25,>=24.0"]'),
    PROBE_LOCK.replace('{ name = "packaging", specifier = "==24.0" }', '{ name = "packaging", specifier = ">=24.0,<25" }'), 0],
  ["P64 shipped worker pair: manifest writes requires-python = \"<3.15,>=3.12\", the lock records \">=3.12, <3.15\" (uv 0/0/0/0/0/0/0)",
    pyWith([['requires-python = ">=3.12,<3.15"', 'requires-python = "<3.15,>=3.12"']]), BASE_LOCK, 0],
  ["P51 probe pair, the same reorder on a project uv locked itself (uv 0/0/0/0/0/0/0)",
    PROBE_PY.replace('requires-python = ">=3.12,<3.15"', 'requires-python = "<3.15,>=3.12"'), PROBE_LOCK, 0],
  ["P04 the same requirement written twice in [project.dependencies] is one requirement (uv 0/0/0/0/0/0/0)",
    pyWith([['  "pypdf==6.4.1",\n', '  "pypdf==6.4.1",\n  "pypdf==6.4.1",\n']]), BASE_LOCK, 0],
  ["P05 a dependency group whose key is quoted TOML: \"dev\" = [ … ] (uv 0/0/0/0/0/0/0)",
    pyWith([['dev = ["pytest==8.4.2"]', '"dev" = ["pytest==8.4.2"]']]), BASE_LOCK, 0],
  ["P18 version written as a triple-quoted TOML string (uv 0/0/0/0/0/0/0)",
    pyWith([['version = "0.3.7"', 'version = """0.3.7"""']]), BASE_LOCK, 0],
  ["P12 root version spelled v0.3.7 against the lock's 0.3.7 (uv 0/0/0/0/0/0/0)",
    pyWith([['version = "0.3.7"', 'version = "v0.3.7"']]), BASE_LOCK, 0],
  ["P13 root version spelled 0.3.07 against the lock's 0.3.7 (uv 0/0/0/0/0/0/0)",
    pyWith([['version = "0.3.7"', 'version = "0.3.07"']]), BASE_LOCK, 0],
  ["P11 root version spelled 1.0-1 against the lock uv wrote, 1.0.post1 (uv 0/0/0/0/0/0/0)", POST_PY, POST_LOCK, 0],
  ["P31 root entry source written as editable = \"./\" (uv 0/0/0/0/0/0/0)", BASE_PY,
    lockWith([['source = { editable = "." }', 'source = { editable = "./" }']]), 0],
  ["P25b the sdist FILENAME version disagrees with the entry version; uv validates wheels only (uv 0/0/0/0/0/0/0)", BASE_PY,
    lockWith([["pypdf-6.4.1.tar.gz", "pypdf-6.4.2.tar.gz"]]), 0],
  ["P27 a wheels entry whose filename key disagrees with its url (uv 0/0/0/0/0/0/0)", BASE_PY,
    lockWith([['{ url = "https://files.pythonhosted.org/packages/0c/e0/57f914ae9fedbc91fe3ebe74b78c88903943ec9c232b6da15947bb3bf8ab/pypdf-6.4.1-py3-none-any.whl"',
      '{ url = "https://files.pythonhosted.org/packages/0c/e0/57f914ae9fedbc91fe3ebe74b78c88903943ec9c232b6da15947bb3bf8ab/pypdf-6.4.1-py3-none-any.whl", filename = "pypdf-9.9.9-py3-none-any.whl" }']]), 0],
  ["P41 the manifest writes the two marker atoms in the opposite order to the lock uv wrote (uv 0/0/0/0/0/0/0)",
    ATOM_ORDER_PY, ATOM_ORDER_LOCK, 0],
  ["P45 an extra == 'pdf' marker on a plain dependency: uv resolves nothing, so the lock carries no entry for it (uv 0/0/0/0/0/0/0)",
    PROBE_PY.replace('dependencies = ["packaging==24.0"]', 'dependencies = ["packaging==24.0; extra == \'pdf\'"]'),
    PROBE_LOCK
      .replace('dependencies = [\n    { name = "packaging" },\n]\n\n', "")
      .replace('requires-dist = [{ name = "packaging", specifier = "==24.0" }]',
        'requires-dist = [{ name = "packaging", marker = "extra == \'pdf\'", specifier = "==24.0" }]')
      .replace('\n[[package]]\nname = "packaging"\nversion = "24.0"\nsource = { registry = "https://pypi.org/simple" }\n', ""), 0],
  ["P48 dynamic = [\"optional-dependencies\"] resolved by setuptools; uv records provides-extras (uv 0/0/0/0/0/0/0)",
    DYN_EXTRA_PY, DYN_EXTRA_LOCK, 0],
  ["P37b resolution-markers that hold no Python bound at all cover every Python version (uv 0/0/0/0/0/0/0)", BASE_PY,
    lockWith([['    "python_full_version >= \'3.14\'",\n    "python_full_version < \'3.14\'",',
      '    "sys_platform == \'linux\'",\n    "sys_platform != \'linux\'",']]), 0],
  ["P21a BOM plus CRLF plus a triple-quoted scalar on the manifest (uv 0.5.0 exit 2 \"Failed to prepare distributions\"; 0.6.10 through 0.13.6 exit 0)",
    "\ufeff" + BASE_PY.replace(/\n/g, "\r\n"), BASE_LOCK, 0],
  ["P21d BOM on the manifest alone (uv 0.5.0 exit 2 \"Failed to prepare distributions\"; 0.6.10 through 0.13.6 exit 0)",
    "\ufeff" + BASE_PY, BASE_LOCK, 0],
  ["P21e BOM on uv.lock alone (uv 0/0/0/0/0/0/0)", BASE_PY, "\ufeff" + BASE_LOCK, 0],
  // uv refuses these and the reader now refuses them too.
  ["P02 manifest specifier >=24.0 against the lock's >=24.0,<25 — a different SET of bounds (uv 2/2/2/1/1/1/1)",
    PROBE_PY.replace('dependencies = ["packaging==24.0"]', 'dependencies = ["packaging>=24.0"]'),
    PROBE_LOCK.replace('{ name = "packaging", specifier = "==24.0" }', '{ name = "packaging", specifier = ">=24.0,<25" }'), 1],
  ["P03 manifest specifier <25,>=24.0,!=24.1 against the lock's >=24.0,<25 (uv 2/2/2/1/1/1/1)",
    PROBE_PY.replace('dependencies = ["packaging==24.0"]', 'dependencies = ["packaging<25,>=24.0,!=24.1"]'),
    PROBE_LOCK.replace('{ name = "packaging", specifier = "==24.0" }', '{ name = "packaging", specifier = ">=24.0,<25" }'), 1],
  ["P09 [tool.uv] environments beside the lock uv wrote for it — uv does not record it, so it stays uncertifiable (uv 2/2/2/1/1/1/1)",
    PROBE_PY + "[tool.uv]\nenvironments = [\"python_full_version >= '3.12'\"]\n",
    PROBE_LOCK.replace("requires-python = \">=3.12, <3.15\"\n", "requires-python = \">=3.12, <3.15\"\nsupported-markers = [\n]\n"), 1],
  ["P42 manifest python_version ~= '3.13' beside the lock uv wrote for ~= '3.12' (uv 2/2/2/1/1/1/1)",
    TILDE_PY.replace("~= '3.12'", "~= '3.13'"), TILDE_LOCK, 1],
  ["P43 manifest python_version in '3.12 3.14' beside the lock uv wrote for in '3.12 3.13' (uv 2/2/2/1/1/1/1)",
    IN_PY.replace("in '3.12 3.13'", "in '3.12 3.14'"), IN_LOCK, 1],
  ["P28 a [[package]] entry with no version key at all (uv 0.13.6 exit 2, uv 0.5.0 exit 2; 0.6.10 through 0.10.7 read it)", BASE_PY,
    lockWith([['name = "pypdf"\nversion = "6.4.1"', 'name = "pypdf"']]), 2],
  ["P36 revision written as a TOML float, revision = 5.0 (uv 0.5.0 exit 0; 0.6.10 through 0.13.6 exit 2)", BASE_PY,
    lockWith([["revision = 5", "revision = 5.0"]]), 2],
  ["P34 the lock's schema version raised to version = 2 (uv 2/2/2/2/2/2/2)", BASE_PY,
    lockWith([["version = 1\nrevision = 5", "version = 2\nrevision = 5"]]), 2],
  ["P29 a duplicate version key inside one [[package]] block (uv 2/2/2/2/2/2/2)", BASE_PY,
    lockWith([['name = "pypdf"\nversion = "6.4.1"', 'name = "pypdf"\nversion = "6.4.1"\nversion = "6.4.1"']]), 2],
  ["P30 two local entries both claiming the source path \".\" (uv 2/2/2/2/2/2/2)", BASE_PY,
    lockWith([['[[package]]\nname = "research-stack-basic"\nversion = "0.3.7"\nsource = { editable = "." }',
      '[[package]]\nname = "research-stack-basic"\nversion = "0.3.7"\nsource = { editable = "." }\n\n[[package]]\nname = "research-stack-basic"\nversion = "0.3.7"\nsource = { editable = "." }']]), 2],
  ["P23 the whole [[package]] block of a transitive-only dependency deleted (uv 2/2/2/2/2/2/2)", BASE_PY,
    dropPackage(BASE_LOCK, "h11"), 2],
  ["P24 the same transitive-only block duplicated (uv 2/2/2/2/2/2/2)", BASE_PY, dupPackage(BASE_LOCK, "h11"), 2],
  ["P25 sdist written as a list (uv 2/2/2/2/2/2/2)", BASE_PY, sdistAsList(BASE_LOCK), 2],
  ["P26 a wheel belonging to another distribution pasted into the pypdf entry (uv 2/2/2/2/2/2/2)", BASE_PY,
    lockWith([["pypdf-6.4.1-py3-none-any.whl", "foreign-9.9.9-py3-none-any.whl"]]), 2],
  ["P19 the manifest declares [tool.uv] twice (uv 2/2/2/2/2/2/2)",
    BASE_PY + '[tool.uv]\npackage = true\n\n[tool.uv]\nno-build-isolation-package = ["hatchling"]\n', BASE_LOCK, 2],
  ["P20 the manifest declares version twice (uv 2/2/2/2/2/2/2)", pyWith([['version = "0.3.7"', 'version = "0.3.7"\nversion = "0.3.7"']]), BASE_LOCK, 2],
  ["P10 the lock records [manifest] overrides while the manifest declares no override-dependencies (uv 2/2/2/1/1/1/1)",
    PROBE_PY, PROBE_LOCK.replace("\n[[package]]\nname = \"p-override-same\"",
      "\n[manifest]\noverrides = [{ name = \"packaging\", specifier = \"==24.0\" }]\n\n[[package]]\nname = \"p-override-same\""), 1],
  ["one resolution-marker dropped from the lock, so part of requires-python has no fork (uv 0.13.6 exit 1)", BASE_PY,
    lockWith([['    "python_full_version < \'3.14\'",\n', ""]]), 1],
  ["P37 a resolution-marker that cannot select any Python version the lock's requires-python declares (uv 0.5.0 exit 0; 0.6.10 and 0.7.22 exit 2; 0.8.5 through 0.13.6 exit 1)",
    BASE_PY, lockWith([["python_full_version >= '3.14'", "python_full_version >= '3.20'"]]), 1],
  ["P49 provides-extras removed from a dynamic-optional lock that carries a revision (uv 0.5.0 exit 0; 0.6.10 and 0.7.22 exit 2; 0.8.5 through 0.13.6 exit 1)",
    DYN_EXTRA_PY, DYN_EXTRA_LOCK.replace('provides-extras = ["pdf"]\n', ""), 1],
];

const FLAGGED = [
  ["revision = 6 (uv 0.13.6 and 0.9.30 read it; the toolkit supports up to 5)", BASE_PY, lockWith([["revision = 5", "revision = 6"]]), 0],
  // A deliberate divergence, recorded with both verdicts: uv 0.5.0 through 0.13.6 all read
  // `revision = 99`, and the toolkit still refuses to certify a lockfile format it has never read.
  ["revision = 99 (uv 0/0/0/0/0/0/0 reads it; the toolkit supports up to 5)", BASE_PY, lockWith([["revision = 5", "revision = 99"]]), 0],
];

// Nothing here is uncaught any more: every pair measured against real uv in this round is either
// agreed with uv or a support-policy divergence named in `FLAGGED` with both verdicts recorded.
const UNCAUGHT = [];

for (const [name, py, lock, uv] of AGREES) {
  test(`agrees with uv (exit ${uv}): ${name}`, () => {
    const problems = pairProblems(py, lock);
    if (uv === 0) assert.deepEqual(problems, [], `uv accepted this pair; the reader said: ${problems.join("; ")}`);
    else assert.ok(problems.length, `uv exit ${uv}; the reader reported nothing`);
  });
}
for (const [name, py, lock, uv] of FLAGGED) {
  test(`KNOWN FALSE POSITIVE (uv exit ${uv}): ${name}`, () => {
    assert.ok(pairProblems(py, lock).length, "characterization test: uv accepts this pair, so a fix must report no problem");
  });
}
for (const [name, py, lock, uv] of UNCAUGHT) {
  test(`KNOWN FALSE NEGATIVE (uv exit ${uv}): ${name}`, () => {
    assert.deepEqual(pairProblems(py, lock), [], "characterization test: uv refuses this pair, so a fix must report it");
  });
}

/**
 * `mcp(cli)==2.2.0` is refused by uv 0.13.6 (exit 2: the build backend rejects the requirement), and
 * the reader refuses it too — but the old message blamed an unclosed bracket, because `bracketEnd`
 * counted `[ ] { }` and not `( )`. The verdict was right for the wrong reason.
 */
test("a parenthesised extras requirement is reported as the requirement it is, not as a broken bracket", () => {
  const problems = pairProblems(pyWith([['"mcp==2.2.0"', '"mcp(cli)==2.2.0"']]), BASE_LOCK);
  assert.equal(problems.length, 1, problems.join("; "));
  assert.ok(!/not closed/.test(problems[0]), problems[0]);
  assert.match(problems[0], /mcp\[cli\] ==2\.2\.0/, "the requirement is named with its extras");
  assert.deepEqual(splitRequirement("mcp(cli)==2.2.0"), { name: "mcp", extras: ["cli"], specifier: "==2.2.0", marker: "" });
});

/** The marker rewrite uv performs, atom by atom, measured with uv 0.13.6 on this host. */
test("a marker is normalised the way uv re-serialises it", () => {
  // Every row here is a `uv lock` uv 0.13.6 wrote for the manifest beside it, on this host
  // (`lock --check` on the pair it wrote exits 0). A conjunction is compared as a SET of atoms
  // (adversarial pair P41), so the spelling below is sorted, not uv's own clause order.
  const measured = [
    ["python_version >= '3.12'", "python_full_version >= '3.12'"],
    ["python_version >= '3.12.0'", "python_full_version >= '3.12'"],
    ["python_version >= '3.12.1'", "python_full_version >= '3.13'"],
    ["python_version >= '3.12.2'", "python_full_version >= '3.13'"],
    ["python_version >= '4.0.0'", "python_full_version >= '4'"],
    ["python_version >= '3'", "python_full_version >= '3'"],
    ["python_version > '3.12'", "python_full_version >= '3.13'"],
    ["python_version > '3.12.0'", "python_full_version >= '3.13'"],
    ["python_version > '3.12.1'", "python_full_version >= '3.13'"],
    ["python_version > '3'", "python_full_version >= '3.1'"],
    ["python_version < '3.14'", "python_full_version < '3.14'"],
    ["python_version < '3.13.0'", "python_full_version < '3.13'"],
    ["python_version < '3.13.1'", "python_full_version < '3.14'"],
    ["python_version < '3'", "python_full_version < '3'"],
    ["python_version <= '3.13'", "python_full_version < '3.14'"],
    ["python_version <= '3.12.0'", "python_full_version < '3.13'"],
    ["python_version <= '3.12.1'", "python_full_version < '3.13'"],
    ["python_version <= '3'", "python_full_version < '3.1'"],
    ["python_version == '3.13'", "python_full_version == '3.13.*'"],
    ["python_version == '3.13.0'", "python_full_version == '3.13.*'"],
    ["python_version == '3'", "python_full_version == '3.0.*'"],
    ["python_version != '3.13'", "python_full_version != '3.13.*'"],
    ["python_version != '3.13.0'", "python_full_version != '3.13.*'"],
    ["python_version ~= '3.12'", "python_full_version < '4' and python_full_version >= '3.12'"],
    ["python_version in '3.12 3.13'", "python_full_version < '3.14' and python_full_version >= '3.12'"],
    ["python_version in '3.12 3.14'", "python_full_version == '3.12.*' or python_full_version == '3.14.*'"],
    ["python_version in '3 3.12'", "python_full_version == '3.0.*' or python_full_version == '3.12.*'"],
    ["python_version not in '3.12 3.14'", "python_full_version < '3.12' or python_full_version == '3.13.*' or python_full_version >= '3.15'"],
    ["python_version not in '3.12 3.13 3.14'", "python_full_version < '3.12' or python_full_version >= '3.15'"],
    ["python_full_version > '3.12'", "python_full_version > '3.12'"],
    ["os_name == 'posix'", "os_name == 'posix'"],
    ["implementation_name == 'cpython' and python_version >= '3.13'", "implementation_name == 'cpython' and python_full_version >= '3.13'"],
    ["sys_platform == 'win32' and python_version >= '3.13'", "python_full_version >= '3.13' and sys_platform == 'win32'"],
    ["sys_platform == 'win32' or python_version >= '3.13'", "python_full_version >= '3.13' or sys_platform == 'win32'"],
    ["python_version >= \"3.13\"", "python_full_version >= '3.13'"],
    ["extra == 'cli_tools'", "extra == 'cli-tools'"],
  ];
  for (const [written, asUvWritesIt] of measured) {
    assert.equal(markerKey(written), asUvWritesIt, `marker ${written}`);
  }
  assert.equal(markerKey(""), "");
  // Measured, and therefore left unmodelled rather than guessed at: uv 0.13.6 writes
  // `python_version < '0'` for `python_version == '3.12.1'` and `~= '3.12.1'`, drops the marker for
  // `!= '3.12.1'` and for `~= '3'`, and parenthesises a conjunction inside a disjunction
  // (`python_version not in '3.12 4'` -> `… < '3.12' or … >= '4.1' or (… >= '3.13' and … < '4.0')`).
  for (const unmodelled of [
    "(python_version >= '3.13' or sys_platform == 'win32') and os_name == 'posix'",
    "python_version == '3.12.1'", "python_version != '3.12.1'",
    "python_version ~= '3.12.1'", "python_version ~= '3'",
    "python_version not in '3.12 4'", "python_version in '3.12 3.13 3.15'",
    "python_version >= '3.13.*'",
  ]) {
    assert.equal(markerKey(unmodelled), null, `marker ${unmodelled} is not modelled`);
  }
  // A marker is part of the requirement: the same name and specifier under two markers are two keys.
  assert.notEqual(requirementKey(splitRequirement("pypdf==6.4.1; python_version >= '3.13'")),
    requirementKey(splitRequirement("pypdf==6.4.1")), "a marker added to a requirement changes its identity");
  assert.equal(requirementKey(splitRequirement("pypdf==6.4.1; python_version >= '3.13'")),
    requirementKey({ name: "pypdf", extras: [], specifier: "==6.4.1", marker: "python_full_version >= '3.13'" }),
    "uv's own spelling of the same marker is the same key");
  // A specifier is the set of its bounds (adversarial pairs P63, P01, P02, P03).
  assert.equal(specifierKey("<7,>=6.4"), specifierKey(">=6.4, <7"));
  assert.notEqual(specifierKey(">=6.4"), specifierKey(">=6.4,<7"));
  assert.notEqual(specifierKey("<7,>=6.4,!=6.5"), specifierKey(">=6.4,<7"));
});

test("the lock's own package entries are cross-checked against the dependency edges and the artifacts", () => {
  const { parseLock, rootEntry, lockDependencyEdges, lockPackageBlocks, packageArtifacts, artifactIdentity, versionKey } = require("../lockfile.js");
  const parsed = parseLock(BASE_LOCK);
  const entry = rootEntry(parsed);
  assert.equal(entry.mode, "editable", "the shipped root entry is an editable one pointing at the project directory");
  assert.equal(entry.path, ".");
  const edges = [...new Set(lockDependencyEdges(BASE_LOCK))];
  assert.ok(edges.includes("pypdf") && edges.includes("python-docx") && edges.includes("pytest"),
    "the root entry's own edges are read");
  assert.ok(edges.includes("h11") && edges.includes("anyio"),
    "and so are the edges only a transitive entry names — the class a root-only reader never sees (adversarial pairs P23, P24)");
  assert.equal(edges.length, 39, "the shipped worker lock resolves 39 distinct dependency edges");
  assert.deepEqual(artifactIdentity("anyio-4.15.1-py3-none-any.whl"), { name: "anyio", version: "4.15.1" });
  assert.deepEqual(artifactIdentity("rpds_py-2026.9.1.tar.gz"), { name: "rpds_py", version: "2026.9.1" });
  const blockOf = (lock, name) => lockPackageBlocks(lock).find((item) => canonicalName(item.name) === name).block;
  assert.deepEqual(packageArtifacts(blockOf(BASE_LOCK, "pypdf")), ["pypdf-6.4.1.tar.gz", "pypdf-6.4.1-py3-none-any.whl"],
    "the shipped lock records the filenames the recorded version has to agree with");
  assert.deepEqual(packageArtifacts(blockOf(dropArtifacts(BASE_LOCK, "pypdf"), "pypdf")), [],
    "an entry with its sdist and wheels removed records no artifacts at all, and uv accepts that");
  assert.equal(versionKey("0.3.7.0"), versionKey("0.3.7"), "PEP 440 trailing zeros are the same version");
  assert.notEqual(versionKey("4.15.0"), versionKey("4.15.1"), "a hand-edited pin is not the same version");
});

/**
 * The coverage rule, in both directions.
 *
 * A marker set that partitions the declared range covers it, and a set that leaves a sub-range of the
 * declared range with no marker, or whose markers cannot intersect the declared range at all, does not.
 * The first direction is what the shipped locks look like — `requires-python = ">=3.12, <3.15"` beside
 * `resolution-markers = ["python_full_version >= '3.14'", "python_full_version < '3.14'"]` — and a rule
 * that flags it is a false alarm on the pair the toolkit ships.
 */
test("resolution-markers that partition requires-python are accepted; a range left uncovered is refused", () => {
  const verdict = (markers, requiresPython) => lockResolutionMarkerProblems(
    { resolutionMarkers: markers, requiresPython }, "lockfile");

  // Accepted: the shipped partition, and other partitions of the same range.
  assert.deepEqual(verdict(["python_full_version >= '3.14'", "python_full_version < '3.14'"], ">=3.12, <3.15"), [],
    "the shipped partition covers >=3.12, <3.15 and must read clean");
  assert.deepEqual(verdict(["python_full_version >= '3.13'", "python_full_version < '3.13'"], ">=3.12, <3.15"), []);
  assert.deepEqual(verdict(["python_full_version < '3.13'",
    "python_full_version >= '3.13' and python_full_version < '3.14'",
    "python_full_version >= '3.14'"], ">=3.12, <3.15"), [], "a three-way partition covers it too");
  assert.deepEqual(verdict(["python_full_version >= '3.12'"], ">=3.12, <3.15"), [],
    "one marker that contains the whole declared range covers it");
  assert.deepEqual(verdict(["python_version >= '3.14'", "python_version < '3.14'"], ">=3.12, <3.15"), [],
    "uv's own python_version spelling of the same partition covers it");
  // A lock with no resolution-markers at all is not a gap: uv 0.5.0 wrote none (adversarial pair P22).
  assert.deepEqual(verdict(undefined, ">=3.12, <3.15"), []);
  assert.deepEqual(verdict([], ">=3.12, <3.15"), []);

  // Refused: a sub-range of the declared range with no marker beside it.
  assert.equal(verdict(["python_full_version >= '3.14'"], ">=3.12, <3.15").length, 1,
    "3.12 and 3.13 have no fork, and uv 0.13.6 refuses that lock (exit 1)");
  assert.equal(verdict(["python_full_version < '3.13'"], ">=3.12, <3.15").length, 1,
    "and the mirror image of the same hole");
  assert.equal(verdict(["python_full_version >= '3.12' and python_full_version < '3.13'",
    "python_full_version >= '3.14'"], ">=3.12, <3.15").length, 1,
    "a partition with 3.13 missing from it");
  // Refused: markers that cannot select any Python the lock itself declares (adversarial pair P37).
  assert.equal(verdict(["python_full_version >= '3.20'", "python_full_version < '3.14'"], ">=3.12, <3.15").length, 1,
    "the >=3.20 fork is outside the declared range: uv 0.6.10 and 0.7.22 exit 2, 0.8.5 through 0.13.6 exit 1");
  // A marker this reader does not model is left alone rather than guessed at.
  assert.deepEqual(verdict(["(python_full_version >= '3.13' or os_name == 'posix') and sys_platform == 'win32'"],
    ">=3.12, <3.15"), [], "an unmodelled marker is not evidence of a gap");
});

/**
 * The pairs the toolkit ships must read clean in BOTH readers, and a reader that breaks must not hand
 * back a verdict-shaped string. `pairProblems` returning `lock comparison failed: …` is a crash wearing
 * a finding's clothes: it blocks the release gate (`setupRuntime`, `npm run package`) while saying
 * nothing about the dependency files. An internal failure now propagates to the caller, which reports it
 * in its own words.
 */
test("the shipped pairs read clean in both readers, and an internal failure is never a verdict", () => {
  const repo = path.join(__dirname, "..", "..");
  const shipped = [
    [WORKER, "the worker pair the VSIX ships"],
    [repo, "the toolkit root pair"],
    [path.join(repo, "templates", "recommended-overlay", "notebooks", "analysis"), "the shipped notebook overlay pair"],
  ];
  for (const [dir, label] of shipped) {
    const py = fs.readFileSync(path.join(dir, "pyproject.toml"), "utf8");
    const lock = fs.readFileSync(path.join(dir, "uv.lock"), "utf8");
    const problems = pairProblems(py, lock);
    assert.deepEqual(problems, [], `${label} must read clean in the JS reader`);
  }
  // The same tree through the Python reader: two gates that answer the shipped pair differently is a defect.
  const report = JSON.parse(execFileSync("python3", [path.join(repo, "scripts", "lockintegrity.py"), repo],
    { encoding: "utf8" }));
  assert.equal(report.ok, true, `the Python reader said: ${(report.problems || []).join("; ")}`);
  assert.deepEqual(report.problems, [], "the Python reader must find nothing in the shipped pairs either");

  // A marker the lock added to a requirement, or dropped from one, is the documented divergence — a
  // marker drift — not a crash.
  const markerless = pairProblems(BASE_PY, lockWith([['{ name = "pypdf", specifier = "==6.4.1" }',
    '{ name = "pypdf", marker = "sys_platform == \'win32\'", specifier = "==6.4.1" }']]));
  assert.ok(markerless.length, "a marker the lock added to a requirement is a finding");
  assert.ok(!/^lock comparison failed:/.test(markerless[0]), markerless[0]);

  // And no pair in this file, parsed or unparsed, may produce that string.
  for (const [name, py, lock] of [...AGREES, ...FLAGGED, ...UNCAUGHT]) {
    let problems;
    try {
      problems = pairProblems(py, lock);
    } catch (error) {
      problems = [String((error && error.message) || error)];
    }
    for (const problem of problems) {
      assert.ok(!/^lock comparison failed:/.test(problem), `${name}: ${problem}`);
    }
  }
});

test("uv cross-check: shipped pair accepted, 0.3.6 drift refused", { skip: UV ? false : "no uv binary at a reviewed path" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lockadv-"));
  try {
    for (const entry of fs.readdirSync(WORKER)) fs.cpSync(path.join(WORKER, entry), path.join(dir, entry), { recursive: true });
    fs.rmSync(path.join(dir, ".venv"), { recursive: true, force: true });
    const run = (py, lock) => {
      fs.writeFileSync(path.join(dir, "pyproject.toml"), py);
      fs.writeFileSync(path.join(dir, "uv.lock"), lock);
      try {
        execFileSync(UV, ["lock", "--check"], { cwd: dir, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, UV_CACHE_DIR: "/tmp/uvcache" } });
        return 0;
      } catch (error) { return error.status; }
    };
    assert.equal(run(BASE_PY, BASE_LOCK), 0, "uv accepts the shipped pair");
    assert.equal(run(pyWith([['version = "0.3.7"', 'version = "0.3.8"']]), BASE_LOCK), 1, "uv refuses the drifted pair");
    // The rows the alignment moved, re-measured here so the exit code each row names is not a claim
    // carried over from a notebook: the two group-reference spellings get opposite verdicts from uv,
    // and the reader now splits them the same way.
    assert.equal(run(PEP735_PY, BASE_LOCK), 2, "uv 0.13.6 refuses the `{ include = … }` manifest outright");
    assert.equal(run(PEP735_PY, PEP735_LOCK), 2, "and refuses it against the lock uv 0.5.0 wrote for it too");
    assert.equal(run(INCLUDE_GROUP_PY, INCLUDE_GROUP_LOCK), 0, "uv 0.13.6 accepts `{ include-group = … }` beside the lock it wrote");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

module.exports = { AGREES, FLAGGED, UNCAUGHT };
