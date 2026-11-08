"use strict";
/**
 * The 0.3.9 skill-bundle subsystem: the reviewed catalog, the staged installer, the receipt and the
 * repair path.
 *
 * Two kinds of case run here. Most of them work on a synthetic bundle in a temporary workspace, so a
 * state can be shown rather than asserted in the abstract. One case works on the shipped catalog and
 * the shipped bundle tree, because a catalog that is not re-hashed against its own payload is a list
 * of promises (DD9-16, R9-14, R9-19).
 *
 * What every case shares: the toolkit may write reviewed files and its own receipt, and nothing else.
 * A file the user changed, a file the toolkit never installed, a skill owned by another bundle, a
 * store, a claim and a user document all survive every run.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  CATALOG_SCHEMA_VERSION, SKILL_ROOT, RECEIPT_FOLDER, STAGING_FOLDER,
  readCatalog, validateCatalog, planInstall, installBundle, readReceipt, repairBundle, digest,
} = require("../bundles");

const CATALOG_PATH = path.join(__dirname, "..", "bundles", "catalog.json");
const PAYLOAD_PATH = path.join(__dirname, "..", "bundles");

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-bundle-test-"));
  t.after(async () => {
    assert.equal(path.dirname(await fs.realpath(root)), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("research-bundle-test-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

async function stagingRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "research-bundle-payload-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

/**
 * A synthetic bundle: `files` is `{ "<path under the bundle root>": "<content>" }`.
 * The catalog entries and the payload copy are both produced from it, so a hash in a test is always
 * a measured hash and never a typed one.
 */
async function syntheticBundle(t, { id = "theological-research", version = "2.0", skills, files, owners, license, publishable = false }) {
  const skillList = skills || [id];
  const payloadRoot = await stagingRoot(t);
  const entries = [];
  for (const [relative, content] of Object.entries(files)) {
    // An unsafe path is recorded but never written: a fixture that proves a path is refused must not
    // itself escape its own directory.
    const unsafe = path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some((part) => part === "" || part === "." || part === "..");
    if (!unsafe) {
      const target = path.join(payloadRoot, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content);
    }
    entries.push({ path: relative, sha256: digest(Buffer.from(content, "utf8")), bytes: Buffer.byteLength(content, "utf8") });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  const bundle = {
    id,
    version,
    topic: "theology",
    purpose: "Synthetic bundle used to show what the installer does.",
    skills: skillList,
    files: entries,
    prerequisites: ["Python 3.12 or newer, for the optional scripts."],
    provenance: { hashMethod: "sha256 measured by the test fixture", date: "2026-11-05" },
    owners: owners || Object.fromEntries(skillList.map((skill) => [skill, id])),
    license: license === undefined ? "unresolved — author consent required before publication" : license,
    publishable,
  };
  return { catalog: { schemaVersion: CATALOG_SCHEMA_VERSION, generatedBy: "scripts/build_bundle_catalog.py", bundles: [bundle] }, payloadRoot };
}

async function writeCatalog(t, root, catalog) {
  const file = path.join(root, "catalog.json");
  await fs.writeFile(file, JSON.stringify(catalog, null, 2) + "\n");
  return file;
}

async function exists(target) {
  return fs.lstat(target).then(() => true, () => false);
}

/** What is really in the workspace, in the shape `planInstall` is handed by a caller that looked. */
async function observedIn(root) {
  const found = await treeOf(path.join(root, ".github"));
  return new Map([...found].map(([relative, sha256]) => [`.github/${relative}`, sha256]));
}

async function read(target) {
  return fs.readFile(target, "utf8");
}

/** Every file under `root`, keyed by its POSIX path relative to `root`. */
async function treeOf(root) {
  const found = new Map();
  const walk = async (directory, prefix) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(absolute, relative); continue; }
      found.set(relative, digest(await fs.readFile(absolute)));
    }
  };
  await walk(root, "");
  return found;
}

// --- The shipped catalog and the shipped payload ---

test("the shipped catalog is the reviewed catalog for the shipped bundle tree", async () => {
  const catalog = await readCatalog(CATALOG_PATH);
  assert.equal(catalog.schemaVersion, CATALOG_SCHEMA_VERSION);
  assert.equal(catalog.generatedBy, "scripts/build_bundle_catalog.py");
  assert.deepEqual(catalog.bundles.map((bundle) => bundle.id), ["document-corpus-bridge", "theological-research"],
    "0.3.9 ships two reviewed bundles: the theological PoC and the document bridge that replaces the 0.3.8 workaround (DD9-23)");
  const bundle = catalog.bundles.find((item) => item.id === "theological-research");
  assert.equal(bundle.id, "theological-research");
  assert.equal(bundle.version, "2.0", "the bundle version is the PoC's own metadata.version");
  assert.deepEqual(bundle.skills, ["theological-research"]);
  assert.equal(bundle.publishable, true);
  assert.equal(bundle.license, "MIT");
  assert.ok(bundle.prerequisites.length >= 4, "the prerequisites are stated, not implied");
  assert.ok(bundle.prerequisites.some((line) => /crossref\.org/.test(line) && /openalex\.org/.test(line)), "the two hosts the optional script contacts are named");
  assert.ok(bundle.prerequisites.some((line) => /installer and the control panel never run it/.test(line)), "the install path is stated as never running the network script");
  assert.ok(bundle.prerequisites.some((line) => /No licensed database/.test(line)), "no licensed database access is claimed");

  const measured = await treeOf(path.join(PAYLOAD_PATH, "theological-research"));
  assert.equal(measured.size, bundle.files.length, "every file in the payload is in the catalog");
  for (const entry of bundle.files) {
    const relative = entry.path.replace(/^theological-research\//, "");
    assert.equal(measured.get(relative), entry.sha256, `${entry.path} drifted from the catalog`);
    assert.equal(entry.bytes, Buffer.byteLength(await read(path.join(PAYLOAD_PATH, entry.path)), "utf8"));
    assert.ok(entry.target.startsWith(`${SKILL_ROOT}/theological-research/`), `${entry.path} must land under the skill directory`);
  }
  assert.ok(bundle.files.some((entry) => entry.path === "theological-research/SKILL.md"));
  assert.ok(bundle.files.some((entry) => entry.path === "theological-research/scripts/dedupe_records.py"));
  assert.ok(bundle.files.some((entry) => entry.path === "theological-research/references/my-library.md"));
});

test("the shipped bundle carries the disclosed script behaviour", async () => {
  const skill = await read(path.join(PAYLOAD_PATH, "theological-research", "SKILL.md"));
  assert.match(skill, /version: "2\.0"/, "the single version marker is metadata.version");
  assert.match(skill, /## What this skill assumes about your machine/);
  assert.match(skill, /Python 3\.12 or newer/);
  assert.match(skill, /api\.crossref\.org`? and `?api\.openalex\.org/);
  assert.match(skill, /toolkit installer never runs it/);
  assert.match(skill, /No licensed database is provisioned/);
  assert.match(skill, /metadata candidate\*\*, never a verification performed by the toolkit/, "no sentence claims the toolkit validated a source");
  const dedupe = await read(path.join(PAYLOAD_PATH, "theological-research", "scripts", "dedupe_records.py"));
  assert.match(dedupe, /Fields compared: title .* and doi/, "the report names only the fields it compares");
  assert.doesNotMatch(dedupe, /Fields checked: title, doi, year, authors/);
  assert.match(dedupe, /DROPPED /, "every dropped record is reported");
  const lookup = await read(path.join(PAYLOAD_PATH, "theological-research", "scripts", "crossref_lookup.py"));
  assert.match(lookup, /SERVICE FAILURE \(this is not 'no match'\)/);
  assert.match(lookup, /bare_doi/, "OpenAlex resolver URLs and bare DOIs are one form");
  const library = await read(path.join(PAYLOAD_PATH, "theological-research", "references", "my-library.md"));
  assert.match(library, /This file is an empty template/, "the template cannot read as a record of the user's holdings");
});

// --- Catalog validation ---

test("readCatalog refuses a catalog this toolkit cannot vouch for", async (t) => {
  const root = await workspace(t);
  const { catalog } = await syntheticBundle(t, { files: { "theological-research/SKILL.md": "# skill\n" } });

  const stale = { ...catalog, schemaVersion: 2 };
  const stalePath = await writeCatalog(t, root, stale);
  await assert.rejects(readCatalog(stalePath), /Unsupported bundle catalog schema version 2/);

  const noBundles = { ...catalog, bundles: [] };
  await assert.rejects(readCatalog(await writeCatalog(t, root, noBundles)), /lists no bundles/);

  const notJson = path.join(root, "broken.json");
  await fs.writeFile(notJson, "{ not json");
  await assert.rejects(readCatalog(notJson), /not readable JSON/);

  const linked = path.join(root, "linked.json");
  await fs.symlink(await writeCatalog(t, root, catalog), linked);
  await assert.rejects(readCatalog(linked), /real file, not a link/);
});

test("a catalog file path that escapes the bundle root or the skill directory is refused", async (t) => {
  const root = await workspace(t);
  const escaping = {
    "theological-research/SKILL.md": "# skill\n",
    "theological-research/../../outside.md": "escape\n",
  };
  const { catalog } = await syntheticBundle(t, { files: escaping });
  assert.throws(() => validateCatalog(catalog), /must not contain "\.", "\.\." or an empty segment/);

  for (const bad of ["/etc/passwd", "C:\\Users\\x\\SKILL.md", "theological-research\\SKILL.md", "theological-research//SKILL.md", "theological-research/./SKILL.md"]) {
    const candidate = await syntheticBundle(t, { files: { [bad]: "x\n" } });
    assert.throws(() => validateCatalog(candidate.catalog), /bundle root|POSIX path|safe bundle file path|empty segment/i, `${bad} must not validate`);
  }

  const wrongRoot = await syntheticBundle(t, { files: { "other-bundle/SKILL.md": "x\n" } });
  assert.throws(() => validateCatalog(wrongRoot.catalog), /not under the bundle root/);

  const ungrouped = await syntheticBundle(t, { skills: ["alpha", "beta"], files: { "theological-research/SKILL.md": "x\n" } });
  assert.throws(() => validateCatalog(ungrouped.catalog), /not grouped under one of its skills/);

  const badHash = await syntheticBundle(t, { files: { "theological-research/SKILL.md": "x\n" } });
  badHash.catalog.bundles[0].files[0].sha256 = "deadbeef";
  assert.throws(() => validateCatalog(badHash.catalog), /no valid sha256/);

  const publishableWithNoLicense = await syntheticBundle(t, { files: { "theological-research/SKILL.md": "x\n" }, publishable: true });
  assert.throws(() => validateCatalog(publishableWithNoLicense.catalog), /license is unresolved, so it cannot be marked publishable/);

  const unknownOwner = await syntheticBundle(t, { files: { "theological-research/SKILL.md": "x\n" }, owners: { "theological-research": "someone-else" } });
  assert.throws(() => validateCatalog(unknownOwner.catalog), /owned by someone-else, which the catalog does not list/);

  const twoOwners = await syntheticBundle(t, { id: "bundle-b", skills: ["shared-skill"], files: { "bundle-b/SKILL.md": "x\n" } });
  const alsoClaims = await syntheticBundle(t, { id: "bundle-c", skills: ["shared-skill"], files: { "bundle-c/SKILL.md": "x\n" } });
  assert.throws(
    () => validateCatalog({ ...twoOwners.catalog, bundles: [twoOwners.catalog.bundles[0], alsoClaims.catalog.bundles[0]] }),
    /Skill shared-skill has two owners/,
    "a shared skill has one owner (DD9-21)",
  );
});

// --- planInstall ---

test("planInstall names the exact target and the state of every file, and writes nothing", async (t) => {
  const root = await workspace(t);
  const { catalog, payloadRoot } = await syntheticBundle(t, {
    files: {
      "theological-research/SKILL.md": "# skill\n",
      "theological-research/references/methods.md": "# methods\n",
      "theological-research/scripts/dedupe_records.py": "print()\n",
    },
  });

  const fresh = await planInstall({ workspaceRoot: root, catalog, bundleId: "theological-research" });
  assert.equal(fresh.bundleVersion, "2.0");
  assert.equal(fresh.wouldWrite, 3);
  assert.deepEqual(fresh.files.map((file) => file.state), ["new", "new", "new"]);
  assert.equal(fresh.files.find((file) => file.target.endsWith("SKILL.md")).absolute, path.join(root, ".github", "skills", "theological-research", "SKILL.md"));
  assert.equal(fresh.files.find((file) => file.target.endsWith("methods.md")).target, ".github/skills/theological-research/references/methods.md");
  assert.equal(await exists(path.join(root, ".github")), false, "a plan writes nothing");

  const hashes = new Map(validateCatalog(catalog).bundles[0].files.map((entry) => [entry.target, entry.sha256]));
  const identical = await planInstall({ workspaceRoot: root, catalog, bundleId: "theological-research", existingFiles: hashes });
  assert.deepEqual(identical.files.map((file) => file.state), ["identical", "identical", "identical"]);
  assert.equal(identical.wouldWrite, 0);

  // A file the toolkit installed and the user then changed.
  const modified = new Map(hashes);
  modified.set(".github/skills/theological-research/references/methods.md", digest(Buffer.from("user text\n")));
  await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  await fs.writeFile(path.join(root, ".github", "skills", "theological-research", "references", "methods.md"), "user text\n");
  const afterEdit = await planInstall({ workspaceRoot: root, catalog, bundleId: "theological-research", existingFiles: modified });
  assert.deepEqual(afterEdit.files.map((file) => file.state).sort(), ["identical", "identical", "user-modified"]);
  assert.equal(afterEdit.files.find((file) => file.target.endsWith("references/methods.md")).state, "user-modified");
  assert.equal(afterEdit.wouldWrite, 0, "a user-modified file is never rewritten");

  // A file the toolkit never installed.
  const foreign = await workspace(t);
  await fs.mkdir(path.join(foreign, ".github", "skills", "theological-research"), { recursive: true });
  await fs.writeFile(path.join(foreign, ".github", "skills", "theological-research", "SKILL.md"), "someone else's skill\n");
  const conflicted = await planInstall({
    workspaceRoot: foreign, catalog, bundleId: "theological-research",
    existingFiles: { ".github/skills/theological-research/SKILL.md": digest(Buffer.from("someone else's skill\n")) },
  });
  assert.equal(conflicted.files.find((file) => file.target.endsWith("SKILL.md")).state, "conflict");
  assert.equal(conflicted.conflicts.length, 1);
});

test("a plan that is not handed hashes reads the workspace rather than assuming it is empty", async (t) => {
  // The panel calls planInstall to answer "what would this write?". If a plan with no hashes assumed an
  // empty workspace, a control panel would offer to rewrite eleven files that are already the reviewed
  // bytes, and would call an operator's edit something it never installed.
  const root = await workspace(t);
  const synthetic = await syntheticBundle(t, {
    files: {
      "theological-research/SKILL.md": "# skill\n",
      "theological-research/references/methods.md": "# methods\n",
    },
  });
  const installed = await installBundle({
    workspaceRoot: root, catalog: synthetic.catalog, bundleId: "theological-research", sourceRoot: synthetic.payloadRoot,
  });
  assert.equal(installed.filesWritten, 2);

  const afterInstall = await planInstall({ workspaceRoot: root, catalog: synthetic.catalog, bundleId: "theological-research" });
  assert.deepEqual(Object.fromEntries(afterInstall.files.map((file) => [file.target, file.state])), {
    ".github/skills/theological-research/SKILL.md": "identical",
    ".github/skills/theological-research/references/methods.md": "identical",
  });
  assert.equal(afterInstall.wouldWrite, 0, "nothing to write: the reviewed bytes are already there");

  await fs.writeFile(path.join(root, ".github", "skills", "theological-research", "references", "methods.md"), "edited by the operator\n");
  const afterEdit = await planInstall({ workspaceRoot: root, catalog: synthetic.catalog, bundleId: "theological-research" });
  assert.deepEqual(Object.fromEntries(afterEdit.files.map((file) => [file.target, file.state])), {
    ".github/skills/theological-research/SKILL.md": "identical",
    ".github/skills/theological-research/references/methods.md": "user-modified",
  });
  assert.equal(afterEdit.wouldWrite, 0, "the operator's file is left exactly as it is");

  const foreign = await workspace(t);
  await fs.mkdir(path.join(foreign, ".github", "skills", "theological-research"), { recursive: true });
  await fs.writeFile(path.join(foreign, ".github", "skills", "theological-research", "SKILL.md"), "someone else's skill\n");
  const observed = await planInstall({ workspaceRoot: foreign, catalog: synthetic.catalog, bundleId: "theological-research" });
  assert.deepEqual(Object.fromEntries(observed.files.map((file) => [file.target, file.state])), {
    ".github/skills/theological-research/SKILL.md": "conflict",
    ".github/skills/theological-research/references/methods.md": "new",
  });
  assert.equal(observed.wouldWrite, 1);
});

test("a skill owned by another bundle is reported as shared and never written", async (t) => {
  const root = await workspace(t);
  const shared = await syntheticBundle(t, {
    id: "bundle-b", skills: ["shared-skill"],
    files: { "bundle-b/SKILL.md": "# owned by b\n" },
  });
  const other = await syntheticBundle(t, {
    id: "bundle-a", skills: ["shared-skill"],
    owners: { "shared-skill": "bundle-b" },
    files: { "bundle-a/SKILL.md": "# wants the same skill\n" },
  });
  const catalog = { ...shared.catalog, bundles: [shared.catalog.bundles[0], other.catalog.bundles[0]] };

  await installBundle({ workspaceRoot: root, catalog, bundleId: "bundle-b", sourceRoot: shared.payloadRoot });
  const plan = await planInstall({ workspaceRoot: root, catalog, bundleId: "bundle-a", sourceRoot: other.payloadRoot });
  assert.equal(plan.files[0].state, "shared-with-other-bundle");
  assert.equal(plan.wouldWrite, 0);

  const receipt = await installBundle({ workspaceRoot: root, catalog, bundleId: "bundle-a", sourceRoot: other.payloadRoot });
  assert.equal(receipt.filesInstalled, 0);
  assert.equal(receipt.filesWritten, 0);
  assert.equal(receipt.files[0].installed, false);
  assert.equal(await read(path.join(root, ".github", "skills", "shared-skill", "SKILL.md")), "# owned by b\n", "the owner bundle's file is untouched");

  const repaired = await repairBundle({ workspaceRoot: root, catalog, bundleId: "bundle-a", sourceRoot: other.payloadRoot });
  assert.equal(repaired.filesInstalled, 0);
  assert.equal(await read(path.join(root, ".github", "skills", "shared-skill", "SKILL.md")), "# owned by b\n", "repair never removes a skill owned by another bundle");
});

// --- installBundle ---

test("installBundle stages, verifies, writes the reviewed files and a receipt with three separate statuses", async (t) => {
  const root = await workspace(t);
  const { catalog, payloadRoot } = await syntheticBundle(t, {
    files: {
      "theological-research/SKILL.md": "# skill\n",
      "theological-research/references/methods.md": "# methods\n",
    },
  });
  const seen = [];
  const receipt = await installBundle({
    workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot,
    verifyFile: async ({ stagedPath, expected }) => { seen.push(stagedPath); assert.equal(digest(await fs.readFile(stagedPath)), expected); return true; },
  });

  assert.equal(await read(path.join(root, ".github", "skills", "theological-research", "SKILL.md")), "# skill\n");
  assert.equal(await read(path.join(root, ".github", "skills", "theological-research", "references", "methods.md")), "# methods\n");
  assert.equal(seen.length, 2, "every file is verified in staging before anything reaches the workspace");
  assert.equal(await exists(path.join(root, STAGING_FOLDER, "theological-research")), false, "the staging directory is the only thing the installer removes");

  const stored = await readReceipt(root, "theological-research");
  assert.deepEqual(stored, receipt);
  assert.equal(stored.bundleId, "theological-research");
  assert.equal(stored.bundleVersion, "2.0");
  assert.equal(stored.previousVersion, null);
  assert.equal(stored.catalogSchemaVersion, CATALOG_SCHEMA_VERSION);
  assert.equal(stored.filesInstalled, 2);
  assert.equal(stored.filesWritten, 2);
  assert.ok(stored.files.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256) && typeof entry.installedAt === "string"));
  assert.equal(stored.hostDiscoveryVerified, false, "the toolkit cannot observe host discovery");
  assert.match(stored.hostDiscoveryReason, /cannot observe whether this host's assistant discovers them/);
  assert.equal(stored.workflowTested, false, "no workflow was run by the install");
  assert.match(stored.workflowTestedReason, /No workflow in this bundle was run/);
  assert.match(stored.license, /^unresolved/);
  assert.equal(stored.publishable, false);
});

test("a payload that has drifted from the catalog never reaches the workspace", async (t) => {
  const root = await workspace(t);
  const { catalog, payloadRoot } = await syntheticBundle(t, {
    files: { "theological-research/SKILL.md": "# skill\n", "theological-research/references/methods.md": "# methods\n" },
  });
  await fs.writeFile(path.join(payloadRoot, "theological-research", "references", "methods.md"), "# quietly changed\n");
  await assert.rejects(
    installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot }),
    /does not match the catalog for theological-research\/references\/methods\.md\. Nothing was copied into the workspace/,
  );
  assert.equal(await exists(path.join(root, ".github")), false, "hash drift stops the install before any workspace copy");
  assert.equal(await readReceipt(root, "theological-research"), null, "a refused install writes no receipt");
});

test("a staged file that fails its verification stops the install before any workspace copy", async (t) => {
  const root = await workspace(t);
  const { catalog, payloadRoot } = await syntheticBundle(t, { files: { "theological-research/SKILL.md": "# skill\n" } });
  await assert.rejects(
    installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot, verifyFile: async () => false }),
    /staged file verification refused/,
  );
  assert.equal(await exists(path.join(root, ".github")), false);
});

test("installBundle never overwrites a file the user modified or a file it never installed", async (t) => {
  const root = await workspace(t);
  const { catalog, payloadRoot } = await syntheticBundle(t, { files: { "theological-research/SKILL.md": "# skill\n" } });
  const target = path.join(root, ".github", "skills", "theological-research", "SKILL.md");

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, "# mine\n");
  const first = await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  assert.equal(first.files[0].state, "conflict");
  assert.equal(first.filesInstalled, 0);
  assert.equal(await read(target), "# mine\n", "a file the toolkit never installed is left exactly as it is");

  await fs.rm(path.join(root, RECEIPT_FOLDER, "theological-research.json"));
  await fs.writeFile(target, "# skill\n");
  await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  await fs.writeFile(target, "# I edited this\n");
  const second = await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  assert.equal(second.files[0].state, "user-modified");
  assert.equal(second.filesInstalled, 0);
  assert.equal(second.conflicts.length, 1);
  assert.equal(await read(target), "# I edited this\n", "a user edit survives every later install");
});

test("a second install is idempotent and says so", async (t) => {
  const root = await workspace(t);
  const { catalog, payloadRoot } = await syntheticBundle(t, {
    files: { "theological-research/SKILL.md": "# skill\n", "theological-research/references/methods.md": "# methods\n" },
  });
  const first = await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  const second = await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  assert.equal(first.filesWritten, 2);
  assert.equal(second.filesWritten, 0, "nothing was written the second time");
  assert.equal(second.filesInstalled, 2, "and the bundle is still fully installed");
  assert.deepEqual(second.files.map((entry) => entry.state), ["identical", "identical"]);
  assert.deepEqual(second.conflicts, []);
  const tree = await treeOf(path.join(root, ".github"));
  assert.equal(tree.size, 2, "a reinstall adds no stray files");
});

// --- repairBundle ---

test("repairBundle re-installs a missing file, reports drift and preserves what drifted", async (t) => {
  const root = await workspace(t);
  const { catalog, payloadRoot } = await syntheticBundle(t, {
    files: {
      "theological-research/SKILL.md": "# skill\n",
      "theological-research/references/methods.md": "# methods\n",
      "theological-research/scripts/dedupe_records.py": "print()\n",
    },
  });
  await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  const skill = path.join(root, ".github", "skills", "theological-research");
  await fs.rm(path.join(skill, "references", "methods.md"));
  await fs.writeFile(path.join(skill, "scripts", "dedupe_records.py"), "# the user changed this\n");

  const repaired = await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  assert.deepEqual(repaired.repair.reinstalled, [".github/skills/theological-research/references/methods.md"]);
  assert.equal(await read(path.join(skill, "references", "methods.md")), "# methods\n", "the missing reviewed file is back");
  assert.deepEqual(repaired.repair.drift.map((entry) => entry.path), [".github/skills/theological-research/scripts/dedupe_records.py"]);
  assert.equal(repaired.repair.drift[0].state, "user-modified");
  assert.equal(await read(path.join(skill, "scripts", "dedupe_records.py")), "# the user changed this\n", "drift is reported, not overwritten");
  assert.equal(repaired.repair.verified.length, 1);

  const stored = await readReceipt(root, "theological-research");
  assert.ok(stored.repair, "the repair is recorded in the receipt");
  assert.equal(stored.filesInstalled, 2, "one file is in place and verified, one is preserved as the user's");
});

test("repairBundle refuses to invent a repair for a workspace that has no bundle receipt", async (t) => {
  const root = await workspace(t);
  const { catalog } = await syntheticBundle(t, { files: { "theological-research/SKILL.md": "# skill\n" } });
  await assert.rejects(repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research" }), /No bundle receipt for theological-research/);
  assert.equal(await exists(path.join(root, ".github")), false);
});

// --- upgrade ---

test("an upgrade reports old to new, replaces only files it installed itself, and records previousVersion", async (t) => {
  const root = await workspace(t);
  const old = await syntheticBundle(t, { version: "2.0", files: { "theological-research/SKILL.md": "# skill 2.0\n", "theological-research/references/methods.md": "# methods 2.0\n" } });
  await installBundle({ workspaceRoot: root, catalog: old.catalog, bundleId: "theological-research", sourceRoot: old.payloadRoot });

  const next = await syntheticBundle(t, { version: "2.1", files: { "theological-research/SKILL.md": "# skill 2.1\n", "theological-research/references/methods.md": "# methods 2.1\n", "theological-research/references/new.md": "# new in 2.1\n" } });
  const present = await observedIn(root);
  const plan = await planInstall({ workspaceRoot: root, catalog: next.catalog, bundleId: "theological-research", existingFiles: present });
  assert.deepEqual(plan.upgrade, { from: "2.0", to: "2.1" });
  assert.deepEqual(Object.fromEntries(plan.files.map((entry) => [entry.target, entry.state])), {
    ".github/skills/theological-research/SKILL.md": "outdated",
    ".github/skills/theological-research/references/methods.md": "outdated",
    ".github/skills/theological-research/references/new.md": "new",
  }, "the files this toolkit installed are outdated; the file 2.1 adds is new");

  const upgraded = await installBundle({ workspaceRoot: root, catalog: next.catalog, bundleId: "theological-research", sourceRoot: next.payloadRoot });
  assert.equal(upgraded.previousVersion, "2.0", "the new receipt records the version it replaced");
  assert.equal(upgraded.bundleVersion, "2.1");
  assert.equal(upgraded.filesInstalled, 3);
  const skill = path.join(root, ".github", "skills", "theological-research");
  assert.equal(await read(path.join(skill, "SKILL.md")), "# skill 2.1\n");
  assert.equal(await read(path.join(skill, "references", "new.md")), "# new in 2.1\n");

  // A file the user changed is not replaced by an upgrade either.
  await fs.writeFile(path.join(skill, "references", "methods.md"), "# my methods\n");
  const later = await syntheticBundle(t, { version: "2.2", files: { "theological-research/SKILL.md": "# skill 2.2\n", "theological-research/references/methods.md": "# methods 2.2\n", "theological-research/references/new.md": "# new in 2.2\n" } });
  const afterUpgrade = await installBundle({ workspaceRoot: root, catalog: later.catalog, bundleId: "theological-research", sourceRoot: later.payloadRoot });
  assert.equal(afterUpgrade.previousVersion, "2.1");
  assert.equal(afterUpgrade.files.find((entry) => entry.path.endsWith("references/methods.md")).state, "user-modified");
  assert.equal(await read(path.join(skill, "references", "methods.md")), "# my methods\n");
  assert.equal(await read(path.join(skill, "SKILL.md")), "# skill 2.2\n");
});

// --- what it never touches ---

test("nothing is deleted: a bundle install and repair leave user files, stores and documents alone", async (t) => {
  const root = await workspace(t);
  const { catalog, payloadRoot } = await syntheticBundle(t, { files: { "theological-research/SKILL.md": "# skill\n" } });
  await fs.mkdir(path.join(root, ".github", "skills", "theological-research"), { recursive: true });
  await fs.mkdir(path.join(root, ".github", "skills", "citation-check"), { recursive: true });
  await fs.mkdir(path.join(root, ".research-toolkit", "store"), { recursive: true });
  await fs.mkdir(path.join(root, ".research-toolkit", "managed", "worker-0.3.8"), { recursive: true });
  await fs.mkdir(path.join(root, "research"), { recursive: true });
  const kept = {
    ".github/skills/theological-research/my-notes.md": "# my own skill note\n",
    ".github/skills/citation-check/SKILL.md": "# an overlay skill from 0.3.8\n",
    ".research-toolkit/store/research.sqlite3": "store bytes",
    ".research-toolkit/managed/worker-0.3.8/installation.json": "{\"workerVersion\":\"0.3.8\"}\n",
    "research/report.md": "# my report\n",
  };
  for (const [relative, content] of Object.entries(kept)) await fs.writeFile(path.join(root, relative), content);

  await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  await fs.rm(path.join(root, ".github", "skills", "theological-research", "SKILL.md"));
  await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });

  for (const [relative, content] of Object.entries(kept)) {
    assert.equal(await read(path.join(root, relative)), content, `${relative} must survive every bundle run`);
  }
  assert.equal(await read(path.join(root, ".github", "skills", "theological-research", "SKILL.md")), "# skill\n");
  const tree = await treeOf(root);
  assert.ok([...tree.keys()].every((relative) => !relative.startsWith(".github/skills/theological-research/")
    || [".github/skills/theological-research/SKILL.md", ".github/skills/theological-research/my-notes.md"].includes(relative)),
  "the bundle writes only its own reviewed files under its skill directory");
});

test("readReceipt refuses a receipt that is a link", async (t) => {
  const root = await workspace(t);
  const { catalog, payloadRoot } = await syntheticBundle(t, { files: { "theological-research/SKILL.md": "# skill\n" } });
  await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  const receiptPath = path.join(root, RECEIPT_FOLDER, "theological-research.json");
  const real = await read(receiptPath);
  await fs.rm(receiptPath);
  await fs.symlink(path.join(root, "research", "notes.md"), receiptPath);
  await assert.rejects(readReceipt(root, "theological-research"), /must not be a link/);
  await fs.rm(receiptPath);
  await fs.writeFile(receiptPath, real);
  assert.deepEqual((await readReceipt(root, "theological-research")).bundleId, "theological-research");
});

test("the shipped theological bundle installs into a disposable workspace and reports what the toolkit cannot know", async (t) => {
  const root = await workspace(t);
  const catalog = await readCatalog(CATALOG_PATH);
  const plan = await planInstall({ workspaceRoot: root, catalog, bundleId: "theological-research" });
  assert.equal(plan.files.length, 12);
  assert.ok(plan.files.every((file) => file.absolute.startsWith(path.join(root, ".github", "skills", "theological-research", ""))));

  const receipt = await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research" });
  assert.equal(receipt.filesInstalled, 12);
  assert.equal(receipt.filesWritten, 12);
  assert.equal(receipt.hostDiscoveryVerified, false);
  assert.equal(receipt.workflowTested, false);
  const installed = await treeOf(path.join(root, ".github", "skills", "theological-research"));
  assert.equal(installed.size, 12);
  for (const entry of catalog.bundles.find((item) => item.id === "theological-research").files) {
    const relative = entry.path.replace(/^theological-research\//, "");
    assert.equal(installed.get(relative), entry.sha256, `${entry.path} is not the reviewed file after install`);
  }
  const repaired = await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research" });
  assert.deepEqual(repaired.repair.drift, []);
  assert.deepEqual(repaired.repair.reinstalled, []);
  assert.equal(repaired.filesInstalled, 12);
});

test("the document bridge ships as a reviewed bundle and no longer tells the operator PDF and DOCX are unsupported", async (t) => {
  // DD9-23: the 0.3.8 workaround skill existed in the template tree, was never packaged, and told the
  // operator to stage derived Markdown because the indexer refused PDF and DOCX. 0.3.9 indexes them, so
  // the same workspace must not carry the old instruction.
  const root = await workspace(t);
  const catalog = await readCatalog(CATALOG_PATH);
  const bridge = catalog.bundles.find((item) => item.id === "document-corpus-bridge");
  assert.ok(bridge, "the bridge is a reviewed bundle, not an unwired template");
  assert.deepEqual(bridge.skills, ["document-corpus-bridge"]);
  assert.equal(bridge.publishable, true);
  assert.equal(bridge.license, "MIT");

  const receipt = await installBundle({ workspaceRoot: root, catalog, bundleId: "document-corpus-bridge" });
  assert.equal(receipt.filesInstalled, 2);
  assert.equal(receipt.filesWritten, 2);
  const target = path.join(root, ".github", "skills", "document-corpus-bridge", "SKILL.md");
  const text = await fs.readFile(target, "utf8");
  assert.match(text, /^---\nname: document-corpus-bridge\n/, "the skill keeps its frontmatter identity");
  assert.match(text, /indexes text-bearing \*\*PDF\*\* and \*\*DOCX\*\* directly|0\.3\.9 indexes text-bearing/, "the text names direct ingestion");
  assert.doesNotMatch(text, /not native PDF\/DOCX indexing/, "the workaround framing is gone");
  assert.match(text, /page=N;chars=a-b/, "the locator it tells the operator to cite is the 0.3.9 locator");
  assert.match(text, /verify_sources/, "freshness is part of the workflow it instructs");
  assert.match(text, /cannot observe whether the host discovered this skill|can prove\s+only that/, "it does not claim the host discovered it");
});
