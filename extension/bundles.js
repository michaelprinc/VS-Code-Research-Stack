"use strict";

/**
 * Topic skill bundles: the reviewed catalog reader and the staged installer (0.3.9).
 *
 * A bundle is a reviewed set of files that lands in `<workspace>/.github/skills/<skill-id>/…`.
 * Nothing here is decided at install time: the catalog (`extension/bundles/catalog.json`, produced
 * by `scripts/build_bundle_catalog.py`) names every file and its SHA-256, and this module refuses
 * anything the catalog does not name.
 *
 * The rules this module exists to enforce:
 *   - staged and verified: every file is copied to a staging directory, hashed there against the
 *     catalog, and only after every staged file has verified does anything move into the workspace;
 *   - nothing is ever overwritten: workspace copies use `wx`, so an existing file fails the write
 *     and is reported. A file the user changed is left exactly as it is (R9-16, DD9-18);
 *   - nothing is ever deleted, and a skill owned by another bundle is never written or removed
 *     (R9-18, DD9-21);
 *   - three separate statuses, never merged (R9-17, DD9-20): `filesInstalled` is the only one an
 *     automated install may claim; host discovery and workflow truth belong to the host;
 *   - no network, no process, no `vscode` import, no write outside `.github/skills/…` and
 *     `.research-toolkit/bundles/…`. A store, a claim and a user document are never touched.
 *
 * The control panel owns the prompts and the presentation. Everything here is a plain function over
 * paths, so it can be tested without an editor and used from any entry point.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

const CATALOG_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 1;
/** Where a bundle's files land in the workspace, and where its receipt lives. */
const SKILL_ROOT = ".github/skills";
const RECEIPT_FOLDER = ".research-toolkit/bundles";
const STAGING_FOLDER = ".research-toolkit/bundles/staging";
/** The payload copy inside the extension: `extension/bundles/<catalog.json>` plus each bundle tree. */
const PAYLOAD_FOLDER = path.join(__dirname, "bundles");

const BUNDLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// One bundle-root-relative POSIX path: `<bundle-id>/<file>`, no "..", no ".", no backslash, no drive.
const BUNDLE_PATH_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

const HOST_DISCOVERY_REASON =
  "The toolkit wrote the reviewed files into .github/skills/. It cannot observe whether this host's "
  + "assistant discovers them there: no VS Code or Copilot host is reachable from the machine that ran "
  + "this install, and the toolkit has no way to ask a host whether it read a skill.";
const WORKFLOW_TESTED_REASON =
  "No workflow in this bundle was run by the toolkit. The bundle's scripts are user-invoked and the "
  + "installer never runs them, its evals were not scored, and no document of the user's was read.";

const digest = (content) => createHash("sha256").update(content).digest("hex");
const timestamp = () => new Date().toISOString();

/** True when `file` is strictly inside `root` and reaches it without escaping through `..`. */
function under(root, file) {
  const relative = path.relative(root, file);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function assertBundleId(bundleId) {
  if (typeof bundleId !== "string" || !BUNDLE_ID_PATTERN.test(bundleId)) {
    throw new TypeError(`Unknown bundle id ${JSON.stringify(bundleId)}. A bundle id is lowercase letters, digits and hyphens.`);
  }
  return bundleId;
}

/**
 * Reject anything that is not a clean bundle-relative path.
 *
 * Absolute paths, Windows drives and separators, `.` and `..` segments and empty segments are all
 * refused here, so no later step has to re-derive safety from a string it was handed.
 */
function bundlePathParts(value, context) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${context} must be a non-empty string.`);
  if (value.includes("\\") || value.includes(":") || path.isAbsolute(value)) {
    throw new Error(`${context} must be a POSIX path relative to the bundle root, without a drive letter or a backslash: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${context} must not contain ".", ".." or an empty segment: ${value}`);
  }
  if (!BUNDLE_PATH_PATTERN.test(value)) {
    throw new Error(`${context} is not a safe bundle file path: ${value}`);
  }
  return parts;
}

/**
 * Which skill directory a bundle file lands in.
 *
 * A one-skill bundle installs its whole tree under that skill. A bundle that declares several skills
 * must group its files under a directory named after the skill, so the mapping from a catalog path to
 * `.github/skills/<skill-id>/…` is never guessed. `scripts/build_bundle_catalog.py` applies the same
 * rule when it writes the catalog.
 */
function skillForBundle(bundle, parts) {
  const within = parts.slice(1);
  if (bundle.skills.length === 1) return { skill: bundle.skills[0], within };
  const skill = within[0];
  if (!skill || !bundle.skills.includes(skill)) {
    throw new Error(`Bundle ${bundle.id}: ${parts.join("/")} is not grouped under one of its skills ${bundle.skills.join(", ")}.`);
  }
  return { skill, within: within.slice(1) };
}

/** The workspace-relative and absolute target a catalog file entry installs to. */
function targetForEntry(bundle, entry) {
  const parts = bundlePathParts(entry.path, `Bundle ${bundle.id} file path`);
  if (parts[0] !== bundle.id) {
    throw new Error(`Bundle ${bundle.id}: file path ${entry.path} is not under the bundle root ${bundle.id}/.`);
  }
  const { skill, within } = skillForBundle(bundle, parts);
  if (!SKILL_ID_PATTERN.test(skill)) throw new Error(`Bundle ${bundle.id}: unsafe skill id ${skill}.`);
  if (within.length === 0) throw new Error(`Bundle ${bundle.id}: ${entry.path} has no file inside the skill directory.`);
  const relative = `${SKILL_ROOT}/${skill}/${within.join("/")}`;
  if (!relative.startsWith(`${SKILL_ROOT}/${skill}/`)) {
    throw new Error(`Bundle ${bundle.id}: ${entry.path} does not resolve under ${SKILL_ROOT}/${skill}/.`);
  }
  return { skill, relative };}

function validateBundle(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("A bundle catalog entry must be an object.");
  const bundle = raw;
  if (typeof bundle.id !== "string" || !BUNDLE_ID_PATTERN.test(bundle.id)) throw new Error(`Bundle catalog has an unsafe bundle id: ${JSON.stringify(bundle.id)}`);
  for (const field of ["version", "topic", "purpose", "license"]) {
    if (typeof bundle[field] !== "string" || bundle[field].trim() === "") throw new Error(`Bundle ${bundle.id}: ${field} is required.`);
  }
  if (typeof bundle.publishable !== "boolean") throw new Error(`Bundle ${bundle.id}: publishable must be true or false.`);
  if (bundle.publishable && bundle.license.trim().toLowerCase().startsWith("unresolved")) {
    throw new Error(`Bundle ${bundle.id}: its license is unresolved, so it cannot be marked publishable.`);
  }
  if (!Array.isArray(bundle.skills) || bundle.skills.length === 0) throw new Error(`Bundle ${bundle.id}: skills must be a non-empty list.`);
  if (bundle.skills.some((id) => typeof id !== "string" || !SKILL_ID_PATTERN.test(id))) throw new Error(`Bundle ${bundle.id}: unsafe skill id in ${JSON.stringify(bundle.skills)}.`);
  if (new Set(bundle.skills).size !== bundle.skills.length) throw new Error(`Bundle ${bundle.id}: skills lists the same skill twice.`);
  if (!Array.isArray(bundle.prerequisites) || bundle.prerequisites.some((line) => typeof line !== "string" || line.trim() === "")) {
    throw new Error(`Bundle ${bundle.id}: prerequisites must be a list of plain statements.`);
  }
  if (!bundle.provenance || typeof bundle.provenance !== "object" || Array.isArray(bundle.provenance)) {
    throw new Error(`Bundle ${bundle.id}: provenance is required.`);
  }
  for (const field of ["hashMethod", "date"]) {
    if (typeof bundle.provenance[field] !== "string" || bundle.provenance[field].trim() === "") {
      throw new Error(`Bundle ${bundle.id}: provenance.${field} is required.`);
    }
  }
  if (!bundle.owners || typeof bundle.owners !== "object" || Array.isArray(bundle.owners)) throw new Error(`Bundle ${bundle.id}: owners is required.`);
  const ownerEntries = Object.entries(bundle.owners);
  if (new Set(ownerEntries.map(([skill]) => skill)).size !== bundle.skills.length || bundle.skills.some((skill) => !(skill in bundle.owners))) {
    throw new Error(`Bundle ${bundle.id}: owners must name exactly the skills it lists.`);
  }
  for (const [skill, owner] of ownerEntries) {
    if (!SKILL_ID_PATTERN.test(skill) || typeof owner !== "string" || !BUNDLE_ID_PATTERN.test(owner)) {
      throw new Error(`Bundle ${bundle.id}: owner entry ${skill} -> ${JSON.stringify(owner)} is unsafe.`);
    }
  }
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) throw new Error(`Bundle ${bundle.id}: files must be a non-empty list.`);
  const seen = new Set();
  const files = bundle.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError(`Bundle ${bundle.id}: every file entry must be an object.`);
    const { skill, relative } = targetForEntry(bundle, entry);
    if (seen.has(entry.path)) throw new Error(`Bundle ${bundle.id}: ${entry.path} is listed twice.`);
    seen.add(entry.path);
    if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) throw new Error(`Bundle ${bundle.id}: ${entry.path} has no valid sha256.`);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw new Error(`Bundle ${bundle.id}: ${entry.path} has no valid byte count.`);
    return { ...entry, skill, target: relative };
  });
  return { ...bundle, files };
}

/**
 * Read and validate the reviewed catalog.
 *
 * An unknown schema version is refused rather than read optimistically: a catalog written by a newer
 * toolkit can carry rules this version does not enforce, and installing from it would claim a review
 * this code never performed.
 */
async function readCatalog(catalogPath) {
  if (typeof catalogPath !== "string" || catalogPath.length === 0) throw new TypeError("readCatalog needs the path of the bundle catalog.");
  const info = await fs.lstat(catalogPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("The bundle catalog must be a real file, not a link.");
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  } catch (error) {
    throw new Error(`The bundle catalog is not readable JSON: ${error.message}`);
  }
  return validateCatalog(parsed);
}

function validateCatalog(catalog) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new TypeError("The bundle catalog must be an object.");
  if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(`Unsupported bundle catalog schema version ${JSON.stringify(catalog.schemaVersion)}. This toolkit reads version ${CATALOG_SCHEMA_VERSION}.`);
  }
  if (typeof catalog.generatedBy !== "string" || catalog.generatedBy.trim() === "") throw new Error("The bundle catalog must say what generated it.");
  if (!Array.isArray(catalog.bundles) || catalog.bundles.length === 0) throw new Error("The bundle catalog lists no bundles.");
  const bundles = catalog.bundles.map((entry) => validateBundle(entry));
  const ids = bundles.map((bundle) => bundle.id);
  if (new Set(ids).size !== ids.length) throw new Error("The bundle catalog lists the same bundle twice.");
  const ownership = new Map();
  for (const bundle of bundles) {
    for (const [skill, owner] of Object.entries(bundle.owners)) {
      if (owner !== bundle.id && !ids.includes(owner)) throw new Error(`Bundle ${bundle.id}: skill ${skill} is owned by ${owner}, which the catalog does not list.`);
      if (ownership.has(skill) && ownership.get(skill) !== owner) {
        throw new Error(`Skill ${skill} has two owners in the catalog: ${ownership.get(skill)} and ${owner}. A shared skill has one owner.`);
      }
      ownership.set(skill, owner);
    }
  }
  return { ...catalog, bundles };
}

function bundleFor(catalog, bundleId) {
  const validated = validateCatalog(catalog);
  assertBundleId(bundleId);
  const bundle = validated.bundles.find((entry) => entry.id === bundleId);
  if (!bundle) throw new Error(`Unknown bundle ${bundleId}. The catalog offers: ${validated.bundles.map((entry) => entry.id).join(", ")}.`);
  return bundle;
}

/** Look up one observed hash in `existingFiles`, which may be an object or a Map, keyed relative or absolute. */
function observedHash(existingFiles, workspaceRoot, relative) {
  if (existingFiles === undefined || existingFiles === null) return null;
  const read = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === "string") return value;
    if (typeof value === "object" && typeof value.sha256 === "string") return value.sha256;
    return null;
  };
  const absolute = path.resolve(workspaceRoot, relative);
  if (existingFiles instanceof Map) {
    for (const [key, value] of existingFiles) {
      if (key === relative || path.resolve(workspaceRoot, String(key)) === absolute) return read(value);
    }
    return null;
  }
  if (typeof existingFiles !== "object") throw new TypeError("existingFiles must be an object or a Map of path to sha256.");
  for (const [key, value] of Object.entries(existingFiles)) {
    if (key === relative || path.resolve(workspaceRoot, key) === absolute) return read(value);
  }
  return null;
}

/**
 * What an install would do, without writing anything.
 *
 * Every file gets its exact absolute target, its catalog hash and a state:
 *   `new`                    nothing is there; it would be written
 *   `identical`            what is there is byte-identical to the reviewed file
 *   `outdated`             what is there is the reviewed file this toolkit installed for an older
 *                          bundle version, and the catalog now names a different reviewed file
 *   `user-modified`        this toolkit installed the file and its bytes have since changed
 *   `conflict`             a file this toolkit never installed is in the way
 *   `shared-with-other-bundle` the skill belongs to another bundle; this bundle writes nothing there
 */
async function planInstall({ workspaceRoot, catalog, bundleId, existingFiles } = {}) {
  const bundle = bundleFor(catalog, bundleId);
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new TypeError("planInstall needs the workspace root.");
  const root = path.resolve(workspaceRoot);
  // A caller that did not look is not a caller that saw an empty workspace. When no hashes are handed
  // in, the plan reads the workspace itself — the same observation `installBundle` makes — so a panel
  // that asks "what would this write?" after an install is never told eleven files are new.
  const observed = existingFiles === undefined || existingFiles === null
    ? await observeWorkspace(root, bundle.files)
    : existingFiles;
  const receipt = await readReceipt(root, bundleId);
  const recorded = new Map((Array.isArray(receipt && receipt.files) ? receipt.files : [])
    .filter((entry) => entry && typeof entry.path === "string")
    .map((entry) => [entry.path, entry]));

  const files = bundle.files.map((entry) => {
    const owner = bundle.owners[entry.skill];
    const present = observedHash(observed, root, entry.target);
    const wasInstalled = recorded.has(entry.target);
    let state;
    if (owner !== bundle.id) state = "shared-with-other-bundle";
    else if (present === null) state = "new";
    else if (present === entry.sha256) state = "identical";
    else if (wasInstalled && recorded.get(entry.target).sha256 === present) state = "outdated";
    else if (wasInstalled) state = "user-modified";
    else state = "conflict";
    return {
      path: entry.path,
      skill: entry.skill,
      target: entry.target,
      absolute: path.join(root, entry.target),
      sha256: entry.sha256,
      bytes: entry.bytes,
      state,
      written: state === "new" || state === "outdated",
      reason: state === "identical" ? "Already the reviewed file; nothing to write."
        : state === "user-modified" ? "You changed this file after the toolkit installed it. It is left exactly as it is."
        : state === "conflict" ? "A file the toolkit never installed is at this path. It is left exactly as it is."
        : state === "outdated" ? "The toolkit installed a different reviewed version of this file; the catalog names a newer one."
        : state === "shared-with-other-bundle" ? `Skill ${entry.skill} is owned by bundle ${owner}; this bundle writes nothing there.`
        : "Not present; the reviewed file would be written.",
    };
  });

  const previousVersion = receipt && typeof receipt.bundleVersion === "string" ? receipt.bundleVersion : null;
  const upgrade = previousVersion && previousVersion !== bundle.version ? { from: previousVersion, to: bundle.version } : null;
  const counts = files.reduce((tally, file) => ({ ...tally, [file.state]: (tally[file.state] || 0) + 1 }), {});
  return {
    bundleId: bundle.id,
    bundleVersion: bundle.version,
    topic: bundle.topic,
    purpose: bundle.purpose,
    skills: bundle.skills,
    prerequisites: bundle.prerequisites,
    license: bundle.license,
    publishable: bundle.publishable,
    workspaceRoot: root,
    skillRoot: path.join(root, SKILL_ROOT),
    upgrade,
    previousVersion,
    files,
    counts,
    wouldWrite: files.filter((file) => file.written).length,
    conflicts: files.filter((file) => file.state === "user-modified" || file.state === "conflict").map((file) => ({ target: file.target, state: file.state })),
  };
}

/** Refuse a link anywhere on a path we are about to create or write into. */
async function ensureRealDirectory(root, relative, create = false) {
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (create) await fs.mkdir(current, { recursive: true }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const info = await fs.lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Bundle paths must be real directories, not links or files. Existing files were preserved.");
    }
  }
  return current;
}

async function writeReceiptFile(workspaceRoot, bundleId, receipt) {
  const folder = await ensureRealDirectory(workspaceRoot, RECEIPT_FOLDER, true);
  const receiptPath = path.join(folder, `${bundleId}.json`);
  try {
    const info = await fs.lstat(receiptPath);
    if (info.isSymbolicLink()) throw new Error("A bundle receipt must not be a link.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const payload = JSON.stringify(receipt, null, 2) + "\n";
  JSON.parse(payload);
  const temporary = path.join(folder, `${bundleId}.json.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    await fs.rm(temporary, { force: true });
    await fs.writeFile(temporary, payload, { flag: "wx" });
    await fs.rename(temporary, receiptPath);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return receiptPath;
}

/** Read the bundle receipt, or null when this workspace has none. A link is refused, not followed. */
async function readReceipt(workspaceRoot, bundleId) {
  assertBundleId(bundleId);
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new TypeError("readReceipt needs the workspace root.");
  const receiptPath = path.join(path.resolve(workspaceRoot), RECEIPT_FOLDER, `${bundleId}.json`);
  try {
    const info = await fs.lstat(receiptPath);
    if (info.isSymbolicLink()) throw new Error("A bundle receipt must not be a link.");
    if (!info.isFile()) throw new Error("A bundle receipt must be a file.");
    const receipt = JSON.parse(await fs.readFile(receiptPath, "utf8"));
    return receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt : null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const defaultVerifyFile = async ({ stagedPath, expected }) => digest(await fs.readFile(stagedPath)) === expected;

/**
 * Hash what is actually at each target path right now.
 *
 * A link or a directory in the way is recorded with a marker instead of a hash: it is present, it is
 * not the reviewed file, and the copy phase reports it as a conflict rather than writing through it.
 */
const NOT_A_FILE = "not-a-file";
async function observeWorkspace(root, files) {
  const observed = new Map();
  for (const entry of files) {
    const absolute = path.join(root, entry.target);
    const info = await fs.lstat(absolute).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    observed.set(entry.target, info.isFile() ? digest(await fs.readFile(absolute)) : NOT_A_FILE);
  }
  return observed;
}

/**
 * Stage every reviewed file, verify every staged file, and only then copy into the workspace.
 *
 * The two phases are the point: a payload that does not match the catalog never reaches the user's
 * `.github/skills/`, and a workspace file that is not the reviewed file is never replaced. Copies use
 * `wx`, so an existing path fails the write instead of being overwritten. The one exception is an
 * upgrade of a file this toolkit itself installed and recorded (`outdated`): its bytes are known, it
 * is written to a unique temporary name in the same directory, hashed, and renamed into place — the
 * same crash-safety the setup receipt uses. A `user-modified`, `conflict` or shared file is skipped.
 */
async function installBundle({ workspaceRoot, catalog, bundleId, verifyFile, sourceRoot } = {}) {
  const bundle = bundleFor(catalog, bundleId);
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new TypeError("installBundle needs the workspace root.");
  const root = path.resolve(workspaceRoot);
  const payloadRoot = path.resolve(sourceRoot || PAYLOAD_FOLDER);
  const verify = verifyFile || defaultVerifyFile;

  const plan = await planInstall({ workspaceRoot: root, catalog, bundleId, existingFiles: await observeWorkspace(root, bundle.files) });
  const staging = path.join(root, STAGING_FOLDER, bundle.id);
  await fs.rm(staging, { recursive: true, force: true });
  await ensureRealDirectory(root, `${STAGING_FOLDER}/${bundle.id}`, true);

  // Phase 1: copy the reviewed payload into staging and hash every staged file against the catalog.
  const staged = [];
  for (const file of plan.files) {
    const source = path.join(payloadRoot, file.path);
    if (!under(payloadRoot, source)) throw new Error(`Bundle ${bundle.id}: ${file.path} resolves outside the reviewed payload.`);
    const info = await fs.lstat(source).catch(() => null);
    if (!info || info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Bundle ${bundle.id}: the reviewed payload is missing ${file.path}. Nothing was copied into the workspace.`);
    }
    const content = await fs.readFile(source);
    if (digest(content) !== file.sha256) {
      throw new Error(`Bundle ${bundle.id}: the reviewed payload does not match the catalog for ${file.path}. Nothing was copied into the workspace.`);
    }
    const stagedPath = path.join(staging, file.target);
    await ensureRealDirectory(root, `${STAGING_FOLDER}/${bundle.id}/${file.target.split("/").slice(0, -1).join("/")}`, true);
    await fs.writeFile(stagedPath, content, { flag: "wx" });
    if (digest(await fs.readFile(stagedPath)) !== file.sha256) {
      throw new Error(`Bundle ${bundle.id}: staged file does not match the catalog: ${file.path}. Nothing was copied into the workspace.`);
    }
    const verified = await verify({ stagedPath, relative: file.target, expected: file.sha256, bundleId: bundle.id });
    if (verified !== true) {
      throw new Error(`Bundle ${bundle.id}: staged file verification refused for ${file.path}. Nothing was copied into the workspace.`);
    }
    staged.push({ file, content, stagedPath });
  }

  // Phase 2: copy into the workspace. Nothing here overwrites a file the toolkit did not install.
  const installedAt = timestamp();
  const recordedReceipt = await readReceipt(root, bundle.id);
  const recordedHashes = new Map((Array.isArray(recordedReceipt && recordedReceipt.files) ? recordedReceipt.files : [])
    .filter((entry) => entry && typeof entry.path === "string" && typeof entry.sha256 === "string")
    .map((entry) => [entry.path, entry.sha256]));
  const receiptFiles = [];
  let filesWritten = 0;
  for (const { file, content } of staged) {
    const destination = file.absolute;
    const entry = {
      path: file.target,
      bundlePath: file.path,
      skill: file.skill,
      sha256: file.sha256,
      bytes: file.bytes,
      state: file.state,
      installed: false,
      reason: file.reason,
    };
    if (file.state === "identical") {
      entry.installed = true;
      entry.reason = "Already the reviewed file; nothing was written.";
      receiptFiles.push(entry);
      continue;
    }
    if (file.state === "user-modified" || file.state === "conflict" || file.state === "shared-with-other-bundle") {
      receiptFiles.push(entry);
      continue;
    }
    const directory = path.dirname(destination);
    await fs.mkdir(directory, { recursive: true });
    const existing = await fs.lstat(destination).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      entry.state = "conflict";
      entry.reason = existing.isSymbolicLink()
        ? "The path is a link. The toolkit does not write through links, so nothing was written there."
        : "The path is not a regular file. Nothing was written there.";
      receiptFiles.push(entry);
      continue;
    }
    try {
      await fs.writeFile(destination, content, { flag: "wx" });
      entry.installed = true;
      entry.installedAt = installedAt;
      filesWritten += 1;
      receiptFiles.push(entry);
      continue;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    // The path appeared between the plan and the write, or the plan said `outdated`.
    const present = await fs.readFile(destination);
    const presentDigest = digest(present);
    if (presentDigest === file.sha256) {
      entry.state = "identical";
      entry.installed = true;
      entry.reason = "Already the reviewed file; nothing was written.";
      receiptFiles.push(entry);
      continue;
    }
    const recorded = recordedHashes.get(file.target);
    if (file.state !== "outdated" || recorded === undefined || presentDigest !== recorded) {
      entry.state = recorded === undefined ? "conflict" : "user-modified";
      entry.reason = recorded === undefined
        ? "A file the toolkit never installed is at this path. It is left exactly as it is."
        : "The file changed after the plan was built. It is left exactly as it is.";
      receiptFiles.push(entry);
      continue;
    }
    // Upgrade of a file this toolkit installed and recorded: replace it, but never blindly.
    const temporary = path.join(directory, `${path.basename(destination)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
    try {
      await fs.writeFile(temporary, content, { flag: "wx" });
      if (digest(await fs.readFile(temporary)) !== file.sha256) {
        throw new Error(`Bundle ${bundle.id}: the replacement for ${file.path} failed its own hash check. The existing file was left in place.`);
      }
      if (digest(await fs.readFile(destination)) !== recorded) {
        entry.state = "user-modified";
        entry.reason = "The file changed while this install was running. It is left exactly as it is.";
        receiptFiles.push(entry);
        continue;
      }
      await fs.rename(temporary, destination);
      entry.installed = true;
      entry.installedAt = installedAt;
      entry.reason = `Replaced the reviewed ${recorded.slice(0, 12)}… copy recorded by the ${plan.previousVersion} receipt.`;
      filesWritten += 1;
      receiptFiles.push(entry);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  const filesInstalled = receiptFiles.filter((entry) => entry.installed).length;
  const previousVersion = plan.previousVersion;
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    bundleId: bundle.id,
    bundleVersion: bundle.version,
    previousVersion,
    upgrade: plan.upgrade,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    installedAt,
    workspace: path.basename(root),
    skills: bundle.skills,
    license: bundle.license,
    publishable: bundle.publishable,
    // `filesInstalled` counts reviewed files that are in place and byte-identical to the catalog after
    // this run — written now or already there. `filesWritten` says what this run actually created, so a
    // reinstall that changed nothing cannot read as an install that did nothing.
    filesInstalled,
    filesWritten,
    preserved: receiptFiles.filter((entry) => !entry.installed).length,
    files: receiptFiles,
    conflicts: receiptFiles.filter((entry) => entry.state === "user-modified" || entry.state === "conflict")
      .map((entry) => ({ path: entry.path, state: entry.state, reason: entry.reason })),
    hostDiscoveryVerified: false,
    hostDiscoveryReason: HOST_DISCOVERY_REASON,
    workflowTested: false,
    workflowTestedReason: WORKFLOW_TESTED_REASON,
  };
  await writeReceiptFile(root, bundle.id, receipt);
  // The staging directory holds only files this install created; it is the one thing this module removes.
  await fs.rm(staging, { recursive: true, force: true });
  return receipt;
}

/**
 * Re-check what a previous install recorded, and restore only what is missing.
 *
 * A file that is present but different is reported as drift and left alone — repair restores what
 * disappeared, it does not overwrite what a user or another tool changed. A file the catalog no
 * longer names is reported as retired and left in place: nothing here deletes.
 */
async function repairBundle({ workspaceRoot, catalog, bundleId, verifyFile, sourceRoot } = {}) {
  const bundle = bundleFor(catalog, bundleId);
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new TypeError("repairBundle needs the workspace root.");
  const root = path.resolve(workspaceRoot);
  const receipt = await readReceipt(root, bundleId);
  if (!receipt) throw new Error(`No bundle receipt for ${bundle.id} in this workspace. Nothing was changed.`);

  const plan = await planInstall({ workspaceRoot: root, catalog, bundleId, existingFiles: await observeWorkspace(root, bundle.files) });
  const recorded = Array.isArray(receipt.files) ? receipt.files : [];
  const planned = new Map(plan.files.map((file) => [file.target, file]));
  const retired = recorded.filter((entry) => entry && typeof entry.path === "string" && !planned.has(entry.path));

  const install = await installBundle({ workspaceRoot: root, catalog, bundleId, verifyFile, sourceRoot });
  const drift = [];
  const verified = [];
  for (const entry of install.files) {
    if (entry.state === "new" || entry.state === "outdated") continue;
    if (entry.state === "identical") { verified.push(entry.path); continue; }
    drift.push({ path: entry.path, state: entry.state, reason: entry.reason });
  }
  const repairedAt = timestamp();
  const updated = {
    ...install,
    installedAt: receipt.installedAt || install.installedAt,
    previousVersion: receipt.previousVersion || install.previousVersion,
    repair: {
      repairedAt,
      reinstalled: install.files.filter((entry) => entry.installed && entry.state === "new").map((entry) => entry.path),
      replaced: install.files.filter((entry) => entry.installed && entry.state === "outdated").map((entry) => entry.path),
      verified,
      drift,
      retired: retired.map((entry) => ({ path: entry.path, reason: "The catalog no longer names this file. It was left in place; nothing is deleted." })),
    },
  };
  await writeReceiptFile(root, bundle.id, updated);
  return { ...updated, bundleId: bundle.id, repairedAt };
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  SKILL_ROOT,
  RECEIPT_FOLDER,
  STAGING_FOLDER,
  HOST_DISCOVERY_REASON,
  WORKFLOW_TESTED_REASON,
  readCatalog,
  validateCatalog,
  bundleFor,
  planInstall,
  installBundle,
  readReceipt,
  repairBundle,
  digest,
};
