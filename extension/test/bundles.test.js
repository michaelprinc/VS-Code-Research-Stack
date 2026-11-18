"use strict";
/**
 * The 0.3.9 skill-bundle subsystem: the reviewed catalog, the staged installer, the receipt and the
 * repair path — and, from 0.3.14, the force update with its immutable archive, its index, its log and
 * the restore back out of it (HR-20…HR-23, DD15-04).
 *
 * Two kinds of case run here. Most of them work on a synthetic bundle in a temporary workspace, so a
 * state can be shown rather than asserted in the abstract. One case works on the shipped catalog and
 * the shipped bundle tree, because a catalog that is not re-hashed against its own payload is a list
 * of promises (DD9-16, R9-14, R9-19).
 *
 * What every case shares: the toolkit may write reviewed files and its own receipt, and nothing else.
 * A file the user changed, a file the toolkit never installed, a skill owned by another bundle, a store,
 * a claim and a user document all survive every run — and from 0.3.14, every byte an approved overwrite
 * replaces survives in the archive, with a record that names where it is.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  CATALOG_SCHEMA_VERSION, SKILL_ROOT, RECEIPT_FOLDER, STAGING_FOLDER,
  ARCHIVE_FOLDER, ARCHIVE_INDEX_FILE, ARCHIVE_LOG_FILE, ARCHIVE_MANIFEST_FILE, ARCHIVE_REASONS, REFUSALS,
  readCatalog, validateCatalog, planInstall, installBundle, readReceipt, repairBundle,
  listArchives, restoreArchive, digest,
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

/**
 * The 0.3.14 fixture: a bundle installed at 1.0, then edited by the operator, then a file the toolkit
 * never installed, then a 2.0 catalog that wants all three paths. Every force-update and archive case
 * starts from exactly this state, because that is the state 0.3.13 could only report and refuse.
 */
async function driftedWorkspace(t, { id = "theological-research", skill } = {}) {
  const skillId = skill || id;
  const root = await workspace(t);
  const first = await syntheticBundle(t, {
    id, version: "1.0", skills: [skillId],
    files: {
      [`${id}/SKILL.md`]: "# skill 1.0\n",
      [`${id}/references/methods.md`]: "# methods 1.0\n",
    },
  });
  await installBundle({ workspaceRoot: root, catalog: first.catalog, bundleId: id, sourceRoot: first.payloadRoot });
  const skillPath = path.join(root, ".github", "skills", skillId);
  await fs.writeFile(path.join(skillPath, "references", "methods.md"), "# the operator rewrote this\n");
  await fs.mkdir(path.join(skillPath, "scripts"), { recursive: true });
  await fs.writeFile(path.join(skillPath, "scripts", "dedupe_records.py"), "# something else put this here\n");
  const next = await syntheticBundle(t, {
    id, version: "2.0", skills: [skillId],
    files: {
      [`${id}/SKILL.md`]: "# skill 2.0\n",
      [`${id}/references/methods.md`]: "# methods 2.0\n",
      [`${id}/scripts/dedupe_records.py`]: "# the reviewed script\n",
    },
  });
  return { root, skillPath, id, catalog: next.catalog, payloadRoot: next.payloadRoot };
}

/** The paths an archive case cares about, in one place. */
function archivePaths(root, bundleId, archiveId) {
  const directory = path.join(root, ARCHIVE_FOLDER, bundleId, archiveId);
  return { directory, manifest: path.join(directory, ARCHIVE_MANIFEST_FILE) };
}

/** Read an archive manifest off disk: a test asserting a record must read the record, not a return value. */
async function readManifest(root, bundleId, archiveId) {
  return JSON.parse(await read(archivePaths(root, bundleId, archiveId).manifest));
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
  assert.equal(bundle.publishable, true, "the bundle carries its own MIT licence, so it is publishable (supersedes DD9-24)");
  assert.match(bundle.license, /^MIT/, "the licence names MIT rather than an unresolved consent question");
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
  // Supersedes DD9-24: the bundle answers its own licence question by shipping the licence text.
  assert.ok(bundle.files.some((entry) => entry.path === "theological-research/LICENSE"),
    "the bundle ships its own licence file, as the 0.3.9 review required");
  const shippedLicense = await read(path.join(PAYLOAD_PATH, "theological-research", "LICENSE"));
  assert.match(shippedLicense, /^MIT License\n/);
  assert.match(shippedLicense, /Copyright \(c\) 2026 s\. Denisa \+ Michael/);
  const skillFrontmatter = await read(path.join(PAYLOAD_PATH, "theological-research", "SKILL.md"));
  assert.match(skillFrontmatter.slice(0, 1200), /^---\nname: theological-research\n/);
  assert.match(skillFrontmatter.slice(0, 1200), /metadata:\n(?:.*\n)*?\s+license: MIT\n/, "the frontmatter declares the licence");
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

// --- force update, the archive, the index and the log (HR-20…HR-22: T15-14, T15-15, T15-16) ---

test("a plan names every file an overwrite would replace, and only an explicit force offers it", async (t) => {
  const { root, skillPath, catalog } = await driftedWorkspace(t);
  const plain = await planInstall({ workspaceRoot: root, catalog, bundleId: "theological-research" });
  assert.equal(plain.force, false);
  assert.deepEqual(Object.fromEntries(plain.files.map((file) => [file.target, file.state])), {
    ".github/skills/theological-research/SKILL.md": "outdated",
    ".github/skills/theological-research/references/methods.md": "user-modified",
    ".github/skills/theological-research/scripts/dedupe_records.py": "conflict",
  }, "0.3.13 could only report this state and refuse it");
  assert.equal(plain.wouldWrite, 1, "without the force only the toolkit's own older copy is written");
  assert.deepEqual(plain.overwrites.map((file) => file.state), ["outdated"]);
  assert.deepEqual(plain.forceOverwrites, [], "and none of the operator's files are offered");

  const forced = await planInstall({ workspaceRoot: root, catalog, bundleId: "theological-research", force: true });
  assert.equal(forced.force, true);
  assert.equal(forced.wouldWrite, 3);
  assert.deepEqual(forced.forceOverwrites.map((file) => [file.target.split("/").pop(), file.state]),
    [["methods.md", "user-modified"], ["dedupe_records.py", "conflict"]],
    "the list a modal must show comes from the plan, not from a panel guessing");
  assert.equal(forced.archivePreview.absoluteDirectory, path.join(root, ARCHIVE_FOLDER, "theological-research"), "and so does where the archive will be written");
  assert.equal(await exists(path.join(root, ARCHIVE_FOLDER)), false, "a plan writes nothing, not even the archive folder");
  assert.equal(await read(path.join(skillPath, "references", "methods.md")), "# the operator rewrote this\n");
  await assert.rejects(planInstall({ workspaceRoot: root, catalog, bundleId: "theological-research", force: "yes" }),
    /force must be an explicit true or false/);
});

test("T15-14: a force update replaces the user-modified file and the conflict file and says which; without the force both survive", async (t) => {
  const { root, skillPath, catalog, payloadRoot } = await driftedWorkspace(t);
  assert.equal(await exists(path.join(root, ARCHIVE_FOLDER)), false, "an install of new files replaces nothing, so nothing is archived");

  const repaired = await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot });
  assert.equal(await read(path.join(skillPath, "references", "methods.md")), "# the operator rewrote this\n", "a repair leaves the operator's file exactly as it is");
  assert.equal(await read(path.join(skillPath, "scripts", "dedupe_records.py")), "# something else put this here\n", "and the file the toolkit never installed too");
  assert.deepEqual(repaired.repair.overwritten, [], "a repair that overwrote nothing says so");
  assert.deepEqual(repaired.repair.drift.map((entry) => entry.state).sort(), ["conflict", "user-modified"]);
  assert.equal(repaired.archive.reason, "upgrade", "and the one file it did replace was archived first");
  assert.equal(repaired.archive.files, 1);

  const forced = await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot, force: true });
  assert.deepEqual(forced.repair.overwritten.map((entry) => [entry.path, entry.state]), [
    [".github/skills/theological-research/references/methods.md", "user-modified"],
    [".github/skills/theological-research/scripts/dedupe_records.py", "conflict"],
  ], "the force names each file it replaced and from which state");
  assert.deepEqual(forced.repair.drift, [], "nothing was left drifted");
  assert.equal(await read(path.join(skillPath, "references", "methods.md")), "# methods 2.0\n");
  assert.equal(await read(path.join(skillPath, "scripts", "dedupe_records.py")), "# the reviewed script\n");
  assert.equal(forced.force, true, "the receipt records that this run was an authorised overwrite");
  assert.equal(forced.archive.reason, "force-update");
  assert.equal(forced.archive.files, 2);
  assert.equal(await read(path.join(forced.archive.absoluteDirectory, ".github/skills/theological-research/references/methods.md")),
    "# the operator rewrote this\n", "the bytes it replaced are readable in the archive");
  await assert.rejects(repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot, force: "yes" }),
    /force must be an explicit true or false/);
});

test("T15-15: every replaced file lands in the archive with a manifest, the index names the archive, and the log states its absolute path", async (t) => {
  const { root, skillPath, catalog, payloadRoot } = await driftedWorkspace(t);
  const forced = await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot, force: true });
  const archiveId = forced.archive.archiveId;
  const { directory, manifest } = archivePaths(root, "theological-research", archiveId);
  assert.equal(path.dirname(directory), path.join(root, ARCHIVE_FOLDER, "theological-research"), "archives live under <archive>/<bundleId>/<stamp>/");
  assert.match(archiveId, /^[0-9]{8}T[0-9]{6}Z-[0-9]{4}$/, "an archive id is a UTC stamp and a sequence: one safe path segment");

  const tree = await treeOf(directory);
  assert.deepEqual([...tree.keys()].sort(), [
    ".github/skills/theological-research/SKILL.md",
    ".github/skills/theological-research/references/methods.md",
    ".github/skills/theological-research/scripts/dedupe_records.py",
    ARCHIVE_MANIFEST_FILE,
  ], "each archived file keeps its workspace path inside the archive: the outdated copy and the two refused ones");
  assert.equal(await read(path.join(directory, ".github/skills/theological-research/SKILL.md")), "# skill 1.0\n");
  assert.equal(await read(path.join(directory, ".github/skills/theological-research/references/methods.md")), "# the operator rewrote this\n");
  assert.equal(await read(path.join(directory, ".github/skills/theological-research/scripts/dedupe_records.py")), "# something else put this here\n");

  const record = await readManifest(root, "theological-research", archiveId);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.archiveId, archiveId);
  assert.equal(record.bundleId, "theological-research");
  assert.equal(record.bundleVersion, "2.0", "the version being written when the archive was made");
  assert.equal(record.replacedVersion, "1.0", "and the version the archived bytes came from");
  assert.equal(record.reason, "force-update");
  assert.ok(ARCHIVE_REASONS.includes(record.reason));
  assert.ok(!Number.isNaN(Date.parse(record.archivedAt)), "the archive says when it was made");
  assert.deepEqual(record.skills, ["theological-research"]);
  assert.equal(record.absoluteArchiveDirectory, directory);
  const archived = Object.fromEntries(record.files.map((entry) => [entry.path, entry]));
  const methods = archived[".github/skills/theological-research/references/methods.md"];
  assert.equal(methods.workspacePath, path.join(skillPath, "references", "methods.md"), "the manifest names the workspace path of the original file");
  assert.equal(methods.sha256, digest(Buffer.from("# the operator rewrote this\n")), "with the hash of the archived copy");
  assert.equal(methods.bytes, Buffer.byteLength("# the operator rewrote this\n"), "and its byte count");
  const reviewed = catalog.bundles[0].files.find((entry) => entry.path.endsWith("references/methods.md"));
  assert.equal(methods.replacedBySha256, reviewed.sha256, "and the Toolkit catalog hash the file is being replaced by");

  const index = JSON.parse(await read(path.join(root, ARCHIVE_FOLDER, ARCHIVE_INDEX_FILE)));
  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(index.archives.map((entry) => entry.archiveId), [archiveId], "the index names the archive");
  assert.equal(index.archives[0].bundleId, "theological-research");
  assert.equal(index.archives[0].reason, "force-update");
  assert.equal(index.archives[0].files, 3, "the outdated copy and both refused files are all archived");
  assert.equal(index.archives[0].absoluteDirectory, directory);

  const log = await read(path.join(root, ARCHIVE_FOLDER, ARCHIVE_LOG_FILE));
  const lines = log.trim().split("\n");
  assert.equal(lines.length, 1, "one line per archive");
  assert.ok(lines[0].includes(archiveId) && lines[0].includes("bundle=theological-research")
    && lines[0].includes("reason=force-update") && lines[0].includes("files=3"), lines[0]);
  assert.ok(lines[0].includes(directory), "the log states the absolute path of the archived version");
});

test("T15-16: two force updates of one bundle leave two archives with different ids, both listed, neither deleted", async (t) => {
  const { root, skillPath, catalog, payloadRoot } = await driftedWorkspace(t);
  const firstRun = await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot, force: true });
  await fs.writeFile(path.join(skillPath, "references", "methods.md"), "# edited a second time\n");
  const third = await syntheticBundle(t, {
    version: "3.0",
    files: {
      "theological-research/SKILL.md": "# skill 3.0\n",
      "theological-research/references/methods.md": "# methods 3.0\n",
      "theological-research/scripts/dedupe_records.py": "# the reviewed script 3.0\n",
    },
  });
  const secondRun = await repairBundle({ workspaceRoot: root, catalog: third.catalog, bundleId: "theological-research", sourceRoot: third.payloadRoot, force: true });

  assert.notEqual(secondRun.archive.archiveId, firstRun.archive.archiveId, "two updates in the same second still get two ids");
  const listed = await listArchives({ workspaceRoot: root, bundleId: "theological-research" });
  assert.equal(listed.count, 2);
  assert.deepEqual(listed.archives.map((entry) => entry.archiveId), [secondRun.archive.archiveId, firstRun.archive.archiveId], "newest first");
  assert.deepEqual(listed.archives.map((entry) => entry.reason), ["force-update", "force-update"]);
  assert.deepEqual(listed.refused, []);
  for (const entry of listed.archives) assert.equal(await exists(entry.absoluteArchiveDirectory), true, "neither archive is removed to make room");
  assert.equal(await read(path.join(listed.archives[0].absoluteArchiveDirectory, ".github/skills/theological-research/references/methods.md")),
    "# edited a second time\n", "the second edit is recoverable");
  assert.equal(await read(path.join(listed.archives[1].absoluteArchiveDirectory, ".github/skills/theological-research/references/methods.md")),
    "# the operator rewrote this\n", "and so is the first");
  assert.equal(await read(path.join(skillPath, "references", "methods.md")), "# methods 3.0\n", "the workspace holds the newest reviewed file");
  const index = JSON.parse(await read(path.join(root, ARCHIVE_FOLDER, ARCHIVE_INDEX_FILE)));
  assert.deepEqual(index.archives.map((entry) => entry.archiveId), [firstRun.archive.archiveId, secondRun.archive.archiveId], "the index is append-only: the first entry is still there");
  const logLines = (await read(path.join(root, ARCHIVE_FOLDER, ARCHIVE_LOG_FILE))).trim().split("\n");
  assert.equal(logLines.length, 2);
  assert.ok(logLines[0].includes(firstRun.archive.absoluteDirectory) && logLines[1].includes(secondRun.archive.absoluteDirectory), "both absolute paths are in the log");
});

// --- restore (HR-23: T15-17) ---

test("T15-17: a restore puts the archived bytes back into the workspace and archives what it replaced", async (t) => {
  const { root, skillPath, catalog, payloadRoot } = await driftedWorkspace(t);
  const forced = await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot, force: true });
  const archived = (await listArchives({ workspaceRoot: root, bundleId: "theological-research" })).archives[0];
  assert.equal(archived.fileCount, 3);
  assert.deepEqual(archived.files.map((entry) => entry.path).sort(), [
    ".github/skills/theological-research/SKILL.md",
    ".github/skills/theological-research/references/methods.md",
    ".github/skills/theological-research/scripts/dedupe_records.py",
  ], "a restore is driven by the manifest's own file list");

  const report = await restoreArchive({ workspaceRoot: root, bundleId: "theological-research", archiveId: archived.archiveId });
  assert.equal(report.filesRestored, 3);
  assert.deepEqual(report.refused, []);
  assert.equal(await read(path.join(skillPath, "SKILL.md")), "# skill 1.0\n");
  assert.equal(await read(path.join(skillPath, "references", "methods.md")), "# the operator rewrote this\n", "the operator's bytes are back in the workspace");
  assert.equal(await read(path.join(skillPath, "scripts", "dedupe_records.py")), "# something else put this here\n");

  assert.equal(report.archive.reason, "restore", "the restore archived what it replaced first (HR-23)");
  assert.equal(report.archive.files, 3);
  assert.equal(await read(path.join(report.archive.absoluteDirectory, ".github/skills/theological-research/references/methods.md")),
    "# methods 2.0\n", "the reviewed bytes the restore displaced are preserved too");
  const after = await listArchives({ workspaceRoot: root, bundleId: "theological-research" });
  assert.equal(after.count, 2, "both archives are still there: nothing is deleted");
  assert.deepEqual(after.archives.map((entry) => entry.reason), ["restore", "force-update"]);

  const receipt = await readReceipt(root, "theological-research");
  assert.equal(receipt.bundleVersion, "1.0", "the receipt names the version whose bytes are in the workspace now");
  assert.equal(receipt.previousVersion, "2.0");
  // Sorted because the order is the catalog's own file order, which a locale-aware sort puts as
  // `references/…`, `scripts/…`, `SKILL.md` — not the order a reader would type.
  assert.deepEqual([...receipt.restore.files].sort(), [
    ".github/skills/theological-research/SKILL.md",
    ".github/skills/theological-research/references/methods.md",
    ".github/skills/theological-research/scripts/dedupe_records.py",
  ]);
  assert.equal(receipt.restore.archiveId, archived.archiveId);

  const plan = await planInstall({ workspaceRoot: root, catalog, bundleId: "theological-research" });
  assert.deepEqual(Object.fromEntries(plan.files.map((file) => [file.target.split("/").pop(), file.state])), {
    "SKILL.md": "outdated", "methods.md": "outdated", "dedupe_records.py": "outdated",
  }, "a restored file is the toolkit's own recorded copy, not an operator edit");
  assert.equal(plan.wouldWrite, 3);
});

test("a restore stages and hash-checks, and refuses an unsafe archive id, a missing archive and tampered archived bytes", async (t) => {
  const { root, skillPath, catalog, payloadRoot } = await driftedWorkspace(t);
  const forced = await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot, force: true });
  const archiveId = forced.archive.archiveId;
  const archivedFile = path.join(forced.archive.absoluteDirectory, ".github/skills/theological-research/references/methods.md");

  await assert.rejects(restoreArchive({ workspaceRoot: root, bundleId: "theological-research", archiveId: `../${archiveId}` }),
    (error) => error.refusal === REFUSALS.UNSAFE_ARCHIVE_ID);
  assert.equal(await exists(path.join(root, STAGING_FOLDER, "restore")), false, "an unsafe id is refused before anything is staged");
  await assert.rejects(restoreArchive({ workspaceRoot: root, bundleId: "theological-research", archiveId: "29991231T235959Z-0001" }),
    (error) => error.refusal === REFUSALS.ARCHIVE_NOT_FOUND);

  await fs.writeFile(archivedFile, "# quietly different\n");
  const before = await read(path.join(skillPath, "references", "methods.md"));
  await assert.rejects(restoreArchive({ workspaceRoot: root, bundleId: "theological-research", archiveId }),
    (error) => error.refusal === REFUSALS.ARCHIVE_HASH_MISMATCH);
  assert.equal(await read(path.join(skillPath, "references", "methods.md")), before, "a refused restore writes nothing into the workspace");
  // The toolkit does not delete the archive either: putting the archived bytes back is the operator's call.
  await fs.writeFile(archivedFile, "# the operator rewrote this\n");
  const restored = await restoreArchive({ workspaceRoot: root, bundleId: "theological-research", archiveId });
  assert.equal(restored.filesRestored, 3, "and once the archive matches its manifest again, the restore runs");

  // A verifier is honoured on the restore path too, on the staged copy.
  await assert.rejects(restoreArchive({
    workspaceRoot: root, bundleId: "theological-research", archiveId, verifyFile: async () => false,
  }), /refused the staged copy/);
  assert.equal(await read(path.join(skillPath, "references", "methods.md")), "# the operator rewrote this\n");
});

test("the archive index is rebuilt from the archive tree when it is damaged, and a stray entry is named rather than read", async (t) => {
  const { root, catalog, payloadRoot } = await driftedWorkspace(t);
  const forced = await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot, force: true });
  const indexFile = path.join(root, ARCHIVE_FOLDER, ARCHIVE_INDEX_FILE);
  await fs.writeFile(indexFile, "{ this is not JSON\n");
  await fs.mkdir(path.join(root, ARCHIVE_FOLDER, "not a bundle id"), { recursive: true });

  const listed = await listArchives({ workspaceRoot: root });
  assert.equal(listed.count, 1, "the archives themselves are the record");
  assert.equal(listed.index.rebuilt, true);
  assert.deepEqual(listed.refused.map((entry) => entry.bundleId), ["not a bundle id"]);
  assert.match(listed.refused[0].reason, /Not a bundle id/);
  assert.equal(await exists(indexFile), true, "a damaged index is left until a write replaces it; nothing is deleted here");

  await restoreArchive({ workspaceRoot: root, bundleId: "theological-research", archiveId: forced.archive.archiveId });
  const index = JSON.parse(await read(indexFile));
  assert.equal(index.schemaVersion, 1);
  assert.deepEqual(index.archives.map((entry) => entry.archiveId).sort(),
    [forced.archive.archiveId, (await listArchives({ workspaceRoot: root })).archives[0].archiveId].sort(),
    "the rebuilt index names every archive on disk, including the one the restore just made");
});

test("a force update never reaches a skill another bundle owns, and it archives nothing it did not replace", async (t) => {
  const root = await workspace(t);
  const owned = await syntheticBundle(t, { id: "bundle-b", skills: ["shared-skill"], files: { "bundle-b/SKILL.md": "# owned by b\n" } });
  const other = await syntheticBundle(t, {
    id: "bundle-a", skills: ["shared-skill"], owners: { "shared-skill": "bundle-b" },
    files: { "bundle-a/SKILL.md": "# wants the same skill\n" },
  });
  const catalog = { ...owned.catalog, bundles: [owned.catalog.bundles[0], other.catalog.bundles[0]] };
  await installBundle({ workspaceRoot: root, catalog, bundleId: "bundle-b", sourceRoot: owned.payloadRoot });

  const plan = await planInstall({ workspaceRoot: root, catalog, bundleId: "bundle-a", force: true });
  assert.deepEqual(plan.forceOverwrites, [], "ownership is not a permission question, so a force plan offers nothing");
  const forced = await installBundle({ workspaceRoot: root, catalog, bundleId: "bundle-a", sourceRoot: other.payloadRoot, force: true });
  assert.equal(forced.files[0].state, "shared-with-other-bundle");
  assert.equal(forced.files[0].installed, false);
  assert.equal(forced.filesWritten, 0);
  assert.equal(forced.archive, null, "no overwrite, so no archive is claimed");
  assert.equal(await read(path.join(root, ".github", "skills", "shared-skill", "SKILL.md")), "# owned by b\n");
  assert.equal(await exists(path.join(root, ARCHIVE_FOLDER)), false);
});

test("a force update does not write through a link or over a directory, and it archives nothing it cannot read", async (t) => {
  const root = await workspace(t);
  const { catalog, payloadRoot } = await syntheticBundle(t, {
    files: { "theological-research/SKILL.md": "# skill\n", "theological-research/references/methods.md": "# methods\n" },
  });
  const skill = path.join(root, ".github", "skills", "theological-research");
  await fs.mkdir(path.join(skill, "references"), { recursive: true });
  await fs.writeFile(path.join(root, "somewhere-else.md"), "# the real file\n");
  await fs.symlink(path.join(root, "somewhere-else.md"), path.join(skill, "SKILL.md"));
  await fs.mkdir(path.join(skill, "references", "methods.md"));

  const forced = await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: payloadRoot, force: true });
  assert.deepEqual(forced.files.map((entry) => entry.state), ["conflict", "conflict"], "a link and a directory are refused whatever the operator asked for");
  assert.equal(forced.filesWritten, 0);
  assert.equal(forced.archive, null, "there are no bytes to archive, so no archive is claimed");
  assert.equal(await exists(path.join(root, ARCHIVE_FOLDER)), false);
  assert.equal(await read(path.join(root, "somewhere-else.md")), "# the real file\n", "the toolkit does not write through a link");
  assert.equal((await fs.lstat(path.join(skill, "references", "methods.md"))).isDirectory(), true, "the directory stays a directory");
});

test("a file the toolkit refused stays a conflict on the next run: the receipt keeps provenance, not one verdict", async (t) => {
  // 0.3.13 recorded every path it looked at, refused ones included, and read that record back as
  // "installed" — so the run after a refusal called a foreign file `user-modified`, the wrong sentence to
  // put next to a force-update confirmation. 0.3.14 carries `installedByToolkit` and carries it forward.
  const { root, skillPath, catalog } = await driftedWorkspace(t);
  const first = await planInstall({ workspaceRoot: root, catalog, bundleId: "theological-research" });
  assert.equal(first.files.find((file) => file.target.endsWith("dedupe_records.py")).state, "conflict");
  const refused = await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research", sourceRoot: (await syntheticBundle(t, {
    files: { "theological-research/SKILL.md": "# skill 2.0\n", "theological-research/references/methods.md": "# methods 2.0\n", "theological-research/scripts/dedupe_records.py": "# the reviewed script\n" },
  })).payloadRoot });
  const byPath = Object.fromEntries(refused.files.map((entry) => [entry.path, entry]));
  assert.equal(byPath[".github/skills/theological-research/scripts/dedupe_records.py"].installedByToolkit, false);
  assert.equal(byPath[".github/skills/theological-research/references/methods.md"].installedByToolkit, true, "the toolkit did write that one; the operator changed it afterwards");
  assert.equal(await read(path.join(skillPath, "references", "methods.md")), "# the operator rewrote this\n");

  const second = await planInstall({ workspaceRoot: root, catalog, bundleId: "theological-research" });
  assert.deepEqual(Object.fromEntries(second.files.map((file) => [file.target, file.state])), {
    ".github/skills/theological-research/SKILL.md": "identical",
    ".github/skills/theological-research/references/methods.md": "user-modified",
    ".github/skills/theological-research/scripts/dedupe_records.py": "conflict",
  }, "each path keeps the state the toolkit actually earned");
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
  // 14 files: the 13 the bundle shipped with through 0.3.12 (including `scripts/validate_ris.py` and
  // `references/zotero-vocabulary.md`, added in 0.3.13), plus `LICENSE`, which the bundle carries from
  // 0.3.13 so its licence is resolved rather than outstanding.
  assert.equal(plan.files.length, 14);
  assert.ok(plan.files.every((file) => file.absolute.startsWith(path.join(root, ".github", "skills", "theological-research", ""))));

  const receipt = await installBundle({ workspaceRoot: root, catalog, bundleId: "theological-research" });
  assert.equal(receipt.filesInstalled, 14);
  assert.equal(receipt.filesWritten, 14);
  assert.equal(receipt.hostDiscoveryVerified, false);
  assert.equal(receipt.workflowTested, false);
  const installed = await treeOf(path.join(root, ".github", "skills", "theological-research"));
  assert.equal(installed.size, 14);
  for (const entry of catalog.bundles.find((item) => item.id === "theological-research").files) {
    const relative = entry.path.replace(/^theological-research\//, "");
    assert.equal(installed.get(relative), entry.sha256, `${entry.path} is not the reviewed file after install`);
  }
  const repaired = await repairBundle({ workspaceRoot: root, catalog, bundleId: "theological-research" });
  assert.deepEqual(repaired.repair.drift, []);
  assert.deepEqual(repaired.repair.reinstalled, []);
  assert.equal(repaired.filesInstalled, 14);
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
  assert.equal(bridge.publishable, true, "the toolkit-authored bridge is covered by the repository's MIT licence");
  assert.match(bridge.license, /^MIT/);

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
