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
 *   - 0.3.14 (HR-20…HR-23, DD15-04): an overwrite is allowed only after the bytes it replaces are
 *     copied into an immutable archive under `.research-toolkit/bundles/archive/<bundleId>/<stamp>-<sequence>/`,
 *     recorded in `archive/index.json` and in the plain-text `archive/archive.log`. A force update is
 *     explicit at the call site (`force: true`); ownership by another bundle is not a force question
 *     and stays refused. No archive is ever rewritten or removed, so every version of every bundle
 *     this workspace has replaced stays recoverable.
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
/** 0.3.14: the immutable archive of every version this workspace has replaced, plus its two records. */
const ARCHIVE_SCHEMA_VERSION = 1;
const ARCHIVE_FOLDER = ".research-toolkit/bundles/archive";
const ARCHIVE_INDEX_FILE = "index.json";
const ARCHIVE_LOG_FILE = "archive.log";
const ARCHIVE_MANIFEST_FILE = "archive.json";
/** The payload copy inside the extension: `extension/bundles/<catalog.json>` plus each bundle tree. */
const PAYLOAD_FOLDER = path.join(__dirname, "bundles");

const BUNDLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// One bundle-root-relative POSIX path: `<bundle-id>/<file>`, no "..", no ".", no backslash, no drive.
const BUNDLE_PATH_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
// An archive id is one safe directory name: `<UTC stamp>-<sequence>`. No colon (Windows refuses it in a
// path), no slash, no dot, no space. The sequence is per bundle and monotonic, so two updates inside
// the same second still land in two different archives (HR-22).
const ARCHIVE_ID_PATTERN = /^[0-9]{8}T[0-9]{6}Z-[0-9]{4}$/;
const ARCHIVE_REASONS = ["force-update", "restore", "upgrade"];

/**
 * Named refusals (0.3.14). Every refusal this module raises for the archive and force paths carries
 * `error.refusal`, so a caller can tell *which* rule stopped it instead of matching prose. A refusal
 * is always "nothing was written", never "partly written".
 */
const REFUSALS = {
  UNSAFE_ARCHIVE_ID: "unsafe-archive-id",
  ARCHIVE_PATH_IS_LINK: "archive-path-is-link",
  ARCHIVE_SOURCE_NOT_A_FILE: "archive-source-not-a-file",
  ARCHIVE_WRITE_REFUSED: "archive-write-refused",
  ARCHIVE_HASH_MISMATCH: "archive-hash-mismatch",
  ARCHIVE_NOT_FOUND: "archive-not-found",
  ARCHIVE_MANIFEST_INVALID: "archive-manifest-invalid",
  ARCHIVE_INDEX_SCHEMA: "archive-index-unknown-schema",
  ARCHIVE_ID_EXHAUSTED: "archive-id-exhausted",
  RESTORE_PATH_OUT_OF_SCOPE: "restore-path-out-of-scope",
  TARGET_NOT_A_REGULAR_FILE: "target-not-a-regular-file",
  TARGET_CHANGED_MID_RUN: "target-changed-mid-run",
  OUTSIDE_WORKSPACE: "outside-workspace",
};

function refuse(refusal, message) {
  const error = new Error(message);
  error.refusal = refusal;
  return error;
}

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
 * Reject anything that is not a safe single archive directory name.
 *
 * An archive id comes from disk (a Quick Pick, a restored manifest) as easily as from a clock, so it is
 * checked as input here rather than trusted as something this module wrote earlier.
 */
function assertArchiveId(archiveId) {
  if (typeof archiveId !== "string" || !ARCHIVE_ID_PATTERN.test(archiveId)) {
    throw refuse(REFUSALS.UNSAFE_ARCHIVE_ID, `Unknown archive id ${JSON.stringify(archiveId)}. An archive id is one UTC stamp and a sequence, like 20261117T170000Z-0001.`);
  }
  return archiveId;
}

/** `2026-11-17T17:00:00.123Z` → `20261117T170000Z`: a UTC stamp that is legal in a path on every host. */
function archiveStamp(date = new Date()) {
  return `${date.toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
}

/** Split a validated archive id into its stamp and sequence, or null when it is not one. */
function parseArchiveId(value) {
  if (typeof value !== "string" || !ARCHIVE_ID_PATTERN.test(value)) return null;
  const [stamp, sequence] = value.split("-");
  return { stamp, sequence: Number(sequence) };
}

/**
 * A workspace-relative POSIX path this module may write, checked the same way a bundle path is.
 *
 * Archived manifests are read back from disk before a restore writes them, so a path stored in a
 * manifest is treated as untrusted input: no drive, no backslash, no `.` or `..`, and — for a restore —
 * nothing outside `.github/skills/…`, which is the only tree a bundle install ever writes.
 */
function workspacePathParts(value, context) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${context} must be a non-empty string.`);
  if (value.includes("\\") || value.includes(":") || path.isAbsolute(value)) {
    throw new Error(`${context} must be a POSIX path relative to the workspace root, without a drive letter or a backslash: ${value}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`${context} must not contain ".", ".." or an empty segment: ${value}`);
  }
  return parts;
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
 *
 * `force: true` changes only what a run is allowed to overwrite: `user-modified` and `conflict` become
 * writable, and the plan names each one under `forceOverwrites` before anything is asked of the
 * operator (HR-20). It changes no state, and it never reaches a shared skill or a path that is not a
 * regular file — those refusals are ownership and shape, not a question of permission.
 */
async function planInstall({ workspaceRoot, catalog, bundleId, existingFiles, force } = {}) {
  if (force !== undefined && typeof force !== "boolean") throw new TypeError("planInstall: force must be an explicit true or false.");
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
    .filter((entry) => entry && typeof entry.path === "string" && recordedInstallFlag(entry))
    .map((entry) => [entry.path, entry]));
  // `installedByToolkit` is provenance, not one run's verdict: only a file this toolkit actually wrote may
  // read as `outdated` or `user-modified`. A receipt also lists what it refused — a `conflict` it left
  // alone, a skill owned by another bundle — and counting those as installed would tell an operator "you
  // changed this file" about a file the toolkit never put there, which is the wrong sentence to show next
  // to a force-update confirmation.

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
    // A force update may only replace bytes it can measure. A link or a directory in the way is reported
    // as `conflict` whether or not force was asked for: writing through a link is not what the operator
    // approved, and ownership of another bundle's skill is not a permission this flag can grant.
    const forceable = (state === "user-modified" || state === "conflict") && typeof present === "string" && SHA256_PATTERN.test(present);
    const overwritten = force === true && forceable;
    return {
      path: entry.path,
      skill: entry.skill,
      target: entry.target,
      absolute: path.join(root, entry.target),
      sha256: entry.sha256,
      bytes: entry.bytes,
      state,
      forceable,
      written: state === "new" || state === "outdated" || overwritten,
      reason: state === "identical" ? "Already the reviewed file; nothing to write."
        : state === "user-modified" ? overwritten
          ? "You changed this file after the toolkit installed it. A force update archives your version and writes the reviewed one."
          : "You changed this file after the toolkit installed it. It is left exactly as it is."
        : state === "conflict" ? overwritten
          ? "A file the toolkit never installed is at this path. A force update archives it and writes the reviewed one."
          : "A file the toolkit never installed is at this path. It is left exactly as it is."
        : state === "outdated" ? "The toolkit installed a different reviewed version of this file; the catalog names a newer one."
        : state === "shared-with-other-bundle" ? `Skill ${entry.skill} is owned by bundle ${owner}; this bundle writes nothing there.`
        : "Not present; the reviewed file would be written.",
    };
  });

  const previousVersion = receipt && typeof receipt.bundleVersion === "string" ? receipt.bundleVersion : null;
  const upgrade = previousVersion && previousVersion !== bundle.version ? { from: previousVersion, to: bundle.version } : null;
  const counts = files.reduce((tally, file) => ({ ...tally, [file.state]: (tally[file.state] || 0) + 1 }), {});
  // `overwrites` is every file that is already present and would be replaced — the exact list a modal
  // must show before it asks (HR-20). `forceOverwrites` is the part of it that only a force unlocks,
  // so the panel can say which of these are the operator's own files rather than the toolkit's older ones.
  const overwrites = files.filter((file) => file.written && file.state !== "new")
    .map((file) => ({ target: file.target, absolute: file.absolute, state: file.state, sha256: file.sha256 }));
  const forceOverwrites = overwrites.filter((file) => file.state === "user-modified" || file.state === "conflict");
  const archivePreview = {
    directory: `${ARCHIVE_FOLDER}/${bundle.id}`,
    absoluteDirectory: path.join(root, ARCHIVE_FOLDER, bundle.id),
    note: "What each replaced file carries now is copied here, under a stamp no later run reuses, before anything is overwritten.",
  };
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
    force: force === true,
    overwrites,
    forceOverwrites,
    archivePreview,
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

/**
 * Whether a receipt entry says the toolkit wrote that file.
 *
 * From 0.3.14 an entry carries `installedByToolkit` explicitly. A 0.3.13 receipt has no such field, so its
 * entries are read from what 0.3.13 could tell: an entry marked installed was written by a run of this
 * installer, one reported as `user-modified` or `outdated` was written by an earlier run and changed since,
 * and one reported as `conflict` or `shared-with-other-bundle` never was. Reading a 0.3.13 conflict entry
 * as installed is what made a foreign file come back as "you changed this" on the next run.
 */
function recordedInstallFlag(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (typeof entry.installedByToolkit === "boolean") return entry.installedByToolkit;
  if (entry.installed === true) return true;
  return entry.state === "user-modified" || entry.state === "outdated";
}

/**
 * Whether a receipt entry for a path the toolkit wrote also names the bytes the toolkit wrote there.
 * The replacement guard may only replace bytes this installer recorded, so this is read from the entry
 * rather than inferred from the catalog.
 */
function recordedHash(entry) {
  return entry && typeof entry.sha256 === "string" && SHA256_PATTERN.test(entry.sha256) ? entry.sha256 : undefined;
}

const defaultVerifyFile = async ({ stagedPath, expected }) => digest(await fs.readFile(stagedPath)) === expected;

/* ---------------------------------------------------------------------------
 * The archive of every version this workspace has replaced (HR-21, HR-22, DD15-04).
 *
 * Layout, all of it inside the workspace root:
 *   .research-toolkit/bundles/archive/<bundleId>/<archiveId>/archive.json      the manifest, written once
 *   .research-toolkit/bundles/archive/<bundleId>/<archiveId>/<workspace path>  the bytes it replaced
 *   .research-toolkit/bundles/archive/index.json                              one entry per archive
 *   .research-toolkit/bundles/archive/archive.log                             one line per archive
 *
 * An archive is never rewritten and never removed: its manifest is created with `wx`, so immutability
 * is a filesystem fact rather than a promise, and the two records are replaced by temp-file + rename
 * exactly as the receipt is. That makes a crash leave the previous record intact; it is not a lock, and
 * it does not need to be — the archive directories are the ground truth, `listArchives` reads the tree
 * rather than the index, and an index that lost a race is rebuilt from what is on disk.
 * -------------------------------------------------------------------------- */

/** The folder a bundle's archives live in. With `create` it is made; without it a missing folder is null. */
async function bundleArchiveFolder(root, bundleId, create = false) {
  assertBundleId(bundleId);
  const relative = `${ARCHIVE_FOLDER}/${bundleId}`;
  if (!create) {
    const info = await fs.lstat(path.join(root, relative)).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return null;
  }
  await ensureRealDirectory(root, relative, create);
  return path.join(root, relative);
}

/**
 * Claim the next archive id for a bundle: this moment's UTC stamp plus the next sequence the bundle has
 * not used. `mkdir` without `recursive` is the claim — it fails when the directory already exists — so
 * two updates in the same second get `-0001` and `-0002`, and two processes cannot land on one archive.
 */
async function claimArchiveId(root, bundleId) {
  const folder = await bundleArchiveFolder(root, bundleId, true);
  const names = await fs.readdir(folder).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let highest = 0;
  for (const name of names) {
    const parsed = parseArchiveId(name);
    if (parsed) highest = Math.max(highest, parsed.sequence);
  }
  const stamp = archiveStamp();
  for (let sequence = highest + 1; sequence <= highest + 1000; sequence += 1) {
    const archiveId = `${stamp}-${String(sequence).padStart(4, "0")}`;
    const directory = path.join(folder, archiveId);
    try {
      await fs.mkdir(directory);
      return { archiveId, stamp, sequence, folder, directory };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw refuse(REFUSALS.ARCHIVE_ID_EXHAUSTED, `Bundle ${bundleId} has no unused archive sequence left next to stamp ${stamp}. Nothing was overwritten.`);
}

/** One index entry: enough to find and identify an archive without opening its manifest. */
function archiveIndexEntry(manifest) {
  return {
    archiveId: manifest.archiveId,
    bundleId: manifest.bundleId,
    bundleVersion: manifest.bundleVersion,
    archivedAt: manifest.archivedAt,
    reason: manifest.reason,
    files: manifest.files.length,
    directory: manifest.archiveDirectory,
    absoluteDirectory: manifest.absoluteArchiveDirectory,
    manifest: `${manifest.archiveDirectory}/${ARCHIVE_MANIFEST_FILE}`,
  };
}

/** What the panel and the receipt get back about an archive: identity and location, not the bytes. */
function archiveSummary(run) {
  if (!run) return null;
  return {
    archiveId: run.archiveId,
    reason: run.reason,
    files: run.files.length,
    archivedAt: run.archivedAt,
    directory: run.archiveDirectory,
    absoluteDirectory: run.absoluteArchiveDirectory,
    manifest: run.relativeManifestPath,
    absoluteManifest: run.manifestPath,
  };
}

/**
 * Check a manifest that came off disk before any of it is trusted.
 *
 * A manifest is the map a restore follows, so every field it drives is re-checked here: the ids, the
 * reason, the timestamp, and per file the path, the hash and the byte count. An archive that does not
 * check out is refused with a named code rather than partly honoured.
 */
function validateArchiveManifest(raw, expected = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, "An archive manifest must be an object.");
  }
  if (raw.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
    throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive manifest schema version ${JSON.stringify(raw.schemaVersion)} is not version ${ARCHIVE_SCHEMA_VERSION} this toolkit writes.`);
  }
  if (!parseArchiveId(raw.archiveId) || (expected.archiveId && raw.archiveId !== expected.archiveId)) {
    throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive manifest names archive id ${JSON.stringify(raw.archiveId)}, which is not the archive it was read from.`);
  }
  if (typeof raw.bundleId !== "string" || !BUNDLE_ID_PATTERN.test(raw.bundleId) || (expected.bundleId && raw.bundleId !== expected.bundleId)) {
    throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive manifest names bundle ${JSON.stringify(raw.bundleId)} for archive ${raw.archiveId}.`);
  }
  if (!ARCHIVE_REASONS.includes(raw.reason)) {
    throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive manifest for ${raw.archiveId} names reason ${JSON.stringify(raw.reason)}, which is not one of ${ARCHIVE_REASONS.join(", ")}.`);
  }
  if (typeof raw.archivedAt !== "string" || Number.isNaN(Date.parse(raw.archivedAt))) {
    throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive manifest for ${raw.archiveId} has no readable archivedAt.`);
  }
  if (typeof raw.bundleVersion !== "string" || raw.bundleVersion.trim() === "") {
    throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive manifest for ${raw.archiveId} does not say which bundle version its bytes came from.`);
  }
  if (raw.replacedVersion !== null && raw.replacedVersion !== undefined
    && (typeof raw.replacedVersion !== "string" || raw.replacedVersion.trim() === "")) {
    throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive manifest for ${raw.archiveId} names replacedVersion ${JSON.stringify(raw.replacedVersion)}, which is not a version or null.`);
  }
  if (!Array.isArray(raw.files) || raw.files.length === 0) {
    throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive manifest for ${raw.archiveId} names no files.`);
  }
  const files = raw.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive manifest for ${raw.archiveId} has a file entry that is not an object.`);
    }
    const parts = workspacePathParts(entry.path, `Archive ${raw.archiveId} file path`);
    if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256)) {
      throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive ${raw.archiveId}: ${parts.join("/")} has no valid sha256.`);
    }
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
      throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive ${raw.archiveId}: ${parts.join("/")} has no valid byte count.`);
    }
    if (typeof entry.replacedBySha256 !== "string" || !SHA256_PATTERN.test(entry.replacedBySha256)) {
      throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `Archive ${raw.archiveId}: ${parts.join("/")} does not name the hash that replaced it.`);
    }
    return { ...entry, path: parts.join("/") };
  });
  const archiveDirectory = `${ARCHIVE_FOLDER}/${raw.bundleId}/${raw.archiveId}`;
  return { ...raw, archiveDirectory, files };
}

/** Read one archive's manifest, refusing a link and refusing a manifest that does not check out. */
async function readArchiveManifest(root, bundleId, archiveId) {
  const manifestPath = path.join(root, ARCHIVE_FOLDER, bundleId, archiveId, ARCHIVE_MANIFEST_FILE);
  const info = await fs.lstat(manifestPath).catch((error) => {
    if (error.code === "ENOENT") throw refuse(REFUSALS.ARCHIVE_NOT_FOUND, `No archive ${archiveId} for bundle ${bundleId} in this workspace. Nothing was changed.`);
    throw error;
  });
  if (info.isSymbolicLink()) throw refuse(REFUSALS.ARCHIVE_PATH_IS_LINK, "An archive manifest must be a real file, not a link.");
  if (!info.isFile()) throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `The archive manifest for ${archiveId} is not a file.`);
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
  catch (error) { throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, `The archive manifest for ${archiveId} is not readable JSON: ${error.message}`); }
  return validateArchiveManifest(parsed, { bundleId, archiveId });
}

/**
 * Every archive the tree actually holds, newest first, plus the entries it refused.
 *
 * The tree is read rather than the index because the index is a record *about* the archives: if the two
 * disagree, the directories are what exists. A stray directory or an unreadable manifest is named in
 * `refused` instead of stopping the history — an operator who cannot list what is archived cannot decide
 * anything about it.
 */
async function scanArchives(root, bundleId) {
  const archives = [];
  const refused = [];
  const wanted = [];
  if (bundleId === undefined || bundleId === null) {
    const entries = await fs.readdir(path.join(root, ARCHIVE_FOLDER), { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    // The archive folder's own records are not bundles; anything else at that level is named in `refused`
    // rather than read as one.
    for (const entry of entries) {
      if (entry.name === ARCHIVE_INDEX_FILE || entry.name === ARCHIVE_LOG_FILE) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        refused.push({ bundleId: entry.name, name: null, reason: "Not a real directory: the toolkit archives into directories, never through links." });
        continue;
      }
      if (!BUNDLE_ID_PATTERN.test(entry.name)) {
        refused.push({ bundleId: entry.name, name: null, reason: "Not a bundle id, so this folder is not read as a bundle archive." });
        continue;
      }
      wanted.push(entry.name);
    }
  } else {
    wanted.push(assertBundleId(bundleId));
  }
  for (const name of wanted) {
    // A link anywhere on the bundle's archive path is refused here, before anything under it is listed.
    const folder = await bundleArchiveFolder(root, name);
    if (!folder) continue;
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        refused.push({ bundleId: name, name: entry.name, reason: "Not a real directory: the toolkit archives into directories, never through links." });
        continue;
      }
      if (!parseArchiveId(entry.name)) {
        refused.push({ bundleId: name, name: entry.name, reason: "Not an archive id (a UTC stamp and a sequence), so it is not read as an archive." });
        continue;
      }
      try { archives.push(await readArchiveManifest(root, name, entry.name)); }
      catch (error) { refused.push({ bundleId: name, name: entry.name, reason: error.message, refusal: error.refusal || null }); }
    }
  }
  archives.sort((one, two) => two.archivedAt.localeCompare(one.archivedAt) || two.archiveId.localeCompare(one.archiveId));
  return { archives, refused };
}

/** The index as it stands, or `{ archives: [], rebuilt: true }` when it cannot be trusted as a record. */
async function readArchiveIndex(root) {
  const indexFile = path.join(root, ARCHIVE_FOLDER, ARCHIVE_INDEX_FILE);
  let info = null;
  try { info = await fs.lstat(indexFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!info) return { archives: [], rebuilt: true };
  if (info.isSymbolicLink()) throw refuse(REFUSALS.ARCHIVE_PATH_IS_LINK, "The bundle archive index must not be a link.");
  if (!info.isFile()) throw refuse(REFUSALS.ARCHIVE_MANIFEST_INVALID, "The bundle archive index is not a file.");
  let parsed;
  try { parsed = JSON.parse(await fs.readFile(indexFile, "utf8")); }
  catch { return { archives: [], rebuilt: true }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.archives)) return { archives: [], rebuilt: true };
  if (parsed.schemaVersion !== ARCHIVE_SCHEMA_VERSION) {
    throw refuse(REFUSALS.ARCHIVE_INDEX_SCHEMA, `The bundle archive index is schema version ${JSON.stringify(parsed.schemaVersion)}; this toolkit writes version ${ARCHIVE_SCHEMA_VERSION} and will not guess at a newer record.`);
  }
  return { archives: parsed.archives.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry)), rebuilt: false };
}

/** Append one archive to the index: read, append, write to a temp name, rename (never edit in place). */
async function appendArchiveIndex(root, manifest) {
  const folder = await ensureRealDirectory(root, ARCHIVE_FOLDER, true);
  const indexFile = path.join(folder, ARCHIVE_INDEX_FILE);
  const current = await readArchiveIndex(root);
  const entries = current.rebuilt
    ? (await scanArchives(root)).archives.map(archiveIndexEntry)
    : current.archives.map(archiveIndexEntryFromRecord).filter(Boolean);
  if (!entries.some((entry) => entry.archiveId === manifest.archiveId && entry.bundleId === manifest.bundleId)) entries.push(archiveIndexEntry(manifest));
  const payload = JSON.stringify({ schemaVersion: ARCHIVE_SCHEMA_VERSION, updatedAt: timestamp(), archives: entries }, null, 2) + "\n";
  JSON.parse(payload);
  const temporary = path.join(folder, `${ARCHIVE_INDEX_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    await fs.rm(temporary, { force: true });
    await fs.writeFile(temporary, payload, { flag: "wx" });
    await fs.rename(temporary, indexFile);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return { indexFile, entryCount: entries.length, rebuilt: current.rebuilt };
}

/** Keep an index record that still describes an archive by the shape this version writes; drop nothing else. */
function archiveIndexEntryFromRecord(record) {
  if (!parseArchiveId(record.archiveId) || typeof record.bundleId !== "string") return null;
  return {
    archiveId: record.archiveId,
    bundleId: record.bundleId,
    bundleVersion: typeof record.bundleVersion === "string" ? record.bundleVersion : null,
    archivedAt: typeof record.archivedAt === "string" ? record.archivedAt : null,
    reason: ARCHIVE_REASONS.includes(record.reason) ? record.reason : null,
    files: Number.isSafeInteger(record.files) ? record.files : null,
    directory: `${ARCHIVE_FOLDER}/${record.bundleId}/${record.archiveId}`,
    absoluteDirectory: record.absoluteDirectory,
    manifest: `${ARCHIVE_FOLDER}/${record.bundleId}/${record.archiveId}/${ARCHIVE_MANIFEST_FILE}`,
  };
}

/**
 * Append the human line for one archive.
 *
 * One line per archive, tab-separated so a path with a space stays one field: the stamp, the archive id,
 * the bundle, the reason, the file count, and the absolute path of the archived version. The log is
 * rewritten as a whole (old lines + the new one) through a temp file and a rename, so an interrupted run
 * leaves the log it had, never half a line.
 */
async function appendArchiveLog(root, manifest) {
  const folder = await ensureRealDirectory(root, ARCHIVE_FOLDER, true);
  const logFile = path.join(folder, ARCHIVE_LOG_FILE);
  let previous = "";
  try {
    const info = await fs.lstat(logFile);
    if (info.isSymbolicLink()) throw refuse(REFUSALS.ARCHIVE_PATH_IS_LINK, "The bundle archive log must not be a link.");
    if (info.isFile()) previous = await fs.readFile(logFile, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const line = [manifest.archivedAt, manifest.archiveId, `bundle=${manifest.bundleId}`, `reason=${manifest.reason}`,
    `files=${manifest.files.length}`, `archive=${manifest.absoluteArchiveDirectory}`].join("\t") + "\n";
  const temporary = path.join(folder, `${ARCHIVE_LOG_FILE}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
  try {
    await fs.rm(temporary, { force: true });
    await fs.writeFile(temporary, (previous ? `${previous.replace(/\n?$/, "")}\n` : "") + line, { flag: "wx" });
    await fs.rename(temporary, logFile);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return logFile;
}

/**
 * Copy the bytes about to be replaced into a new immutable archive, then record it.
 *
 * The copy keeps each file's workspace-relative path inside the archive, so a restore maps an archived
 * file back to where it came from without guessing, and the manifest names the hash of the reviewed bytes
 * that will replace them. Every copy is re-hashed after it is written: a mismatch refuses the archive,
 * and a refused archive stops the overwrite that asked for it.
 *
 * `bundleVersion` is the version being written; `replacedVersion` is the version whose bytes are going
 * into the archive, when a receipt recorded one. Both are stated because the two are different facts and
 * a reader needs both to know what an archive is a copy *of*.
 */
async function writeArchive({ root, bundleId, bundleVersion, replacedVersion = null, skills, reason, entries }) {
  if (!ARCHIVE_REASONS.includes(reason)) throw new TypeError(`writeArchive: reason must be one of ${ARCHIVE_REASONS.join(", ")}.`);
  if (!Array.isArray(entries) || entries.length === 0) throw new TypeError("writeArchive needs at least one file to archive.");
  const { archiveId, stamp, sequence, directory } = await claimArchiveId(root, bundleId);
  const archivedAt = timestamp();
  const files = [];
  for (const entry of entries) {
    const parts = workspacePathParts(entry.target, "File to archive");
    const source = path.join(root, ...parts);
    if (!under(root, source)) throw refuse(REFUSALS.OUTSIDE_WORKSPACE, `Archiving ${parts.join("/")} would read outside the workspace root. Nothing was overwritten.`);
    const info = await fs.lstat(source).catch((error) => {
      if (error.code === "ENOENT") throw refuse(REFUSALS.ARCHIVE_SOURCE_NOT_A_FILE, `${parts.join("/")} is no longer there to archive. Nothing was overwritten.`);
      throw error;
    });
    if (info.isSymbolicLink() || !info.isFile()) {
      throw refuse(REFUSALS.ARCHIVE_SOURCE_NOT_A_FILE, `${parts.join("/")} is not a regular file, so its bytes cannot be archived. Nothing was overwritten.`);
    }
    const content = await fs.readFile(source);
    const sha256 = digest(content);
    const archived = path.join(directory, ...parts);
    if (!under(directory, archived)) throw refuse(REFUSALS.OUTSIDE_WORKSPACE, `Archiving ${parts.join("/")} would write outside the archive directory. Nothing was overwritten.`);
    if (parts.length > 1) await ensureRealDirectory(root, `${ARCHIVE_FOLDER}/${bundleId}/${archiveId}/${parts.slice(0, -1).join("/")}`, true);
    await fs.writeFile(archived, content, { flag: "wx" });
    if (digest(await fs.readFile(archived)) !== sha256) {
      throw refuse(REFUSALS.ARCHIVE_HASH_MISMATCH, `The archived copy of ${parts.join("/")} does not match the bytes it was copied from. Nothing was overwritten.`);
    }
    if (typeof entry.replacedBySha256 !== "string" || !SHA256_PATTERN.test(entry.replacedBySha256)) {
      throw new TypeError(`writeArchive: ${parts.join("/")} must name the reviewed hash it is being replaced by.`);
    }
    files.push({
      path: parts.join("/"),
      workspacePath: source,
      archivePath: `${ARCHIVE_FOLDER}/${bundleId}/${archiveId}/${parts.join("/")}`,
      sha256,
      bytes: content.length,
      state: typeof entry.state === "string" ? entry.state : null,
      replacedBySha256: entry.replacedBySha256,
      replacedBy: typeof entry.replacedBy === "string" ? entry.replacedBy : null,
    });
  }
  const manifest = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    archiveId,
    stamp,
    sequence,
    bundleId,
    bundleVersion,
    replacedVersion: typeof replacedVersion === "string" && replacedVersion.trim() !== "" ? replacedVersion : null,
    skills: Array.isArray(skills) ? skills.slice() : [],
    archivedAt,
    reason,
    workspace: path.basename(root),
    archiveDirectory: `${ARCHIVE_FOLDER}/${bundleId}/${archiveId}`,
    absoluteArchiveDirectory: directory,
    files,
  };
  const manifestPath = path.join(directory, ARCHIVE_MANIFEST_FILE);
  // `wx` is the immutability: an archive that already has a manifest cannot be given another one.
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await appendArchiveIndex(root, manifest);
  await appendArchiveLog(root, manifest);
  return { ...manifest, manifestPath, relativeManifestPath: `${manifest.archiveDirectory}/${ARCHIVE_MANIFEST_FILE}` };
}

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
 *
 * `force: true` (HR-20, 0.3.14) extends that replacement to a `user-modified` or `conflict` file whose
 * overwrite the operator has approved — and only after the bytes being replaced are archived. The flag
 * must be an explicit boolean at the call site: no entry point of this module defaults to overwriting,
 * and a skill owned by another bundle is not forceable whatever the caller asks for.
 */
async function installBundle({ workspaceRoot, catalog, bundleId, verifyFile, sourceRoot, force } = {}) {
  if (force !== undefined && typeof force !== "boolean") {
    throw new TypeError("installBundle: force must be an explicit true or false. Overwriting an operator's file is never the default.");
  }
  const bundle = bundleFor(catalog, bundleId);
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new TypeError("installBundle needs the workspace root.");
  const root = path.resolve(workspaceRoot);
  const payloadRoot = path.resolve(sourceRoot || PAYLOAD_FOLDER);
  const verify = verifyFile || defaultVerifyFile;

  const observed = await observeWorkspace(root, bundle.files);
  const plan = await planInstall({ workspaceRoot: root, catalog, bundleId, existingFiles: observed, force });
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

  // Phase 1b: archive everything this run is about to overwrite, before a single byte is overwritten
  // (HR-21). A run that replaces nothing writes no archive. `shared-with-other-bundle` never reaches this
  // list whatever `force` says — ownership of another bundle's skill is not a permission question — and
  // neither does a path that is not a regular file, because there are no bytes to preserve.
  const toArchive = [];
  for (const { file } of staged) {
    const replaces = file.state === "outdated" || (force === true && (file.state === "user-modified" || file.state === "conflict"));
    if (!replaces || observed.get(file.target) === NOT_A_FILE) continue;
    toArchive.push({
      target: file.target,
      state: file.state,
      replacedBySha256: file.sha256,
      replacedBy: `catalog ${bundle.id} ${bundle.version} ${file.path}`,
    });
  }
  const archiveRun = toArchive.length
    ? await writeArchive({
      root, bundleId: bundle.id, bundleVersion: bundle.version,
      replacedVersion: plan.previousVersion,
      skills: bundle.skills, reason: force === true ? "force-update" : "upgrade", entries: toArchive,
    })
    : null;
  // The hashes this run measured on the way into the archive: an overwrite may only replace bytes that
  // are still exactly what was archived, so a file that changed after the plan was built is left alone.
  const archivedBytes = new Map(archiveRun ? archiveRun.files.map((entry) => [entry.path, entry.sha256]) : []);

  // Phase 2: copy into the workspace. Nothing here overwrites a file the toolkit did not install, unless
  // the operator asked for that overwrite and the bytes it replaces are already archived.
  const installedAt = timestamp();
  const recordedReceipt = await readReceipt(root, bundle.id);
  const recordedFiles = Array.isArray(recordedReceipt && recordedReceipt.files) ? recordedReceipt.files : [];
  const recordedHashes = new Map(recordedFiles
    .filter((entry) => entry && typeof entry.path === "string" && typeof entry.sha256 === "string")
    .map((entry) => [entry.path, entry.sha256]));
  // What the workspace already knows about each path: whether the toolkit wrote it at some point. A file it
  // refused is not "installed", so a later run cannot be told the operator edited it.
  const recordedInstallFlags = new Map(recordedFiles
    .filter((entry) => entry && typeof entry.path === "string")
    .map((entry) => [entry.path, recordedInstallFlag(entry)]));
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
      // Provenance, carried forward from the previous receipt: `installed` says what this run found or
      // wrote, `installedByToolkit` says whether this installer ever put bytes at this path.
      installedByToolkit: recordedInstallFlags.get(file.target) === true,
      reason: file.reason,
    };
    // A force run may replace an operator's file or a file this toolkit never installed, and only because
    // Phase 1b archived those bytes under a new archive id. `archivedBytes.has` is the gate: a file whose
    // bytes are not safely archived is not replaced, whatever the caller asked for.
    const forceOverwrite = force === true && (file.state === "user-modified" || file.state === "conflict") && archivedBytes.has(file.target);
    if (file.state === "identical") {
      entry.installed = true;
      entry.installedByToolkit = true;
      entry.reason = "Already the reviewed file; nothing was written.";
      receiptFiles.push(entry);
      continue;
    }
    if (file.state === "user-modified" || file.state === "conflict" || file.state === "shared-with-other-bundle") {
      if (!forceOverwrite) {
        receiptFiles.push(entry);
        continue;
      }
      // Named per file, not per run: the archive keeps each replaced file under its own workspace path, and
      // the receipt has to point at that copy, because it is the only place those bytes still exist.
      entry.archivedTo = path.join(archiveRun.absoluteArchiveDirectory, file.target);
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
      entry.installedByToolkit = true;
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
      entry.installedByToolkit = true;
      entry.reason = "Already the reviewed file; nothing was written.";
      receiptFiles.push(entry);
      continue;
    }
    const recorded = recordedHashes.get(file.target);
    // The bytes this run is entitled to replace: what Phase 1b archived, or — for an `outdated` file whose
    // archiving was skipped — what the previous receipt recorded. Anything else is left exactly as it is.
    const expectedBytes = archivedBytes.get(file.target) ?? recorded;
    if (!(file.state === "outdated" || forceOverwrite) || expectedBytes === undefined || presentDigest !== expectedBytes) {
      entry.state = recorded === undefined ? "conflict" : "user-modified";
      entry.reason = recorded === undefined
        ? "A file the toolkit never installed is at this path. It is left exactly as it is."
        : "The file changed after the plan was built. It is left exactly as it is.";
      receiptFiles.push(entry);
      continue;
    }
    // Replace a file this run is entitled to replace — an upgrade of the toolkit's own recorded copy, or a
    // force overwrite whose bytes are archived — but never blindly.
    const temporary = path.join(directory, `${path.basename(destination)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
    try {
      await fs.writeFile(temporary, content, { flag: "wx" });
      if (digest(await fs.readFile(temporary)) !== file.sha256) {
        throw new Error(`Bundle ${bundle.id}: the replacement for ${file.path} failed its own hash check. The existing file was left in place.`);
      }
      if (digest(await fs.readFile(destination)) !== expectedBytes) {
        entry.state = "user-modified";
        entry.reason = forceOverwrite
          ? "The file changed while this run was archiving it. It is left exactly as it is."
          : "The file changed while this install was running. It is left exactly as it is.";
        receiptFiles.push(entry);
        continue;
      }
      await fs.rename(temporary, destination);
      entry.installed = true;
      entry.installedByToolkit = true;
      entry.installedAt = installedAt;
      entry.reason = forceOverwrite
        ? `Overwritten on an explicit force update. What it held is archived at ${archiveRun.absoluteArchiveDirectory}.`
        : `Replaced the reviewed ${expectedBytes.slice(0, 12)}… copy recorded by the ${plan.previousVersion} receipt.`;
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
    // `force` records that this run was authorised to overwrite, and `archive` where the bytes it replaced
    // were put. An install that archived nothing says `archive: null` rather than leaving the field out,
    // so a reader can tell "nothing was replaced" from "the record is missing".
    force: force === true,
    archive: archiveSummary(archiveRun),
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
 *
 * `force: true` (HR-20) is the operator's explicit answer to that drift: the reviewed file is written over
 * the drifted one, and `repair.overwritten` names each file it replaced. What it replaced is archived
 * first, so the drift is still readable afterwards — the force changes the workspace, never the record.
 */
async function repairBundle({ workspaceRoot, catalog, bundleId, verifyFile, sourceRoot, force } = {}) {
  if (force !== undefined && typeof force !== "boolean") {
    throw new TypeError("repairBundle: force must be an explicit true or false. A repair that overwrites is never the default.");
  }
  const bundle = bundleFor(catalog, bundleId);
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new TypeError("repairBundle needs the workspace root.");
  const root = path.resolve(workspaceRoot);
  const receipt = await readReceipt(root, bundleId);
  if (!receipt) throw new Error(`No bundle receipt for ${bundle.id} in this workspace. Nothing was changed.`);

  const plan = await planInstall({ workspaceRoot: root, catalog, bundleId, existingFiles: await observeWorkspace(root, bundle.files) });
  const recorded = Array.isArray(receipt.files) ? receipt.files : [];
  const planned = new Map(plan.files.map((file) => [file.target, file]));
  const retired = recorded.filter((entry) => entry && typeof entry.path === "string" && !planned.has(entry.path));

  const install = await installBundle({ workspaceRoot: root, catalog, bundleId, verifyFile, sourceRoot, force });
  const drift = [];
  const verified = [];
  const overwritten = [];
  for (const entry of install.files) {
    if (entry.state === "new" || entry.state === "outdated") continue;
    if (entry.state === "identical") { verified.push(entry.path); continue; }
    if (entry.installed && entry.archivedTo) { overwritten.push({ path: entry.path, state: entry.state, archivedTo: entry.archivedTo }); continue; }
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
      // Only a force run can fill this. A repair that left everything alone says `overwritten: []`, which
      // is a different claim from a repair that archived and replaced the drifted files.
      overwritten,
      retired: retired.map((entry) => ({ path: entry.path, reason: "The catalog no longer names this file. It was left in place; nothing is deleted." })),
    },
  };
  await writeReceiptFile(root, bundle.id, updated);
  return { ...updated, bundleId: bundle.id, repairedAt };
}

/**
 * Every archived version this workspace holds, newest first, with its manifest (HR-23).
 *
 * The archive tree is read, not the index: the directories are what the toolkit actually archived, and a
 * record that lost a write race cannot hide an archive that exists. `indexed` says whether the index
 * agrees, and `refused` names anything in the archive folder this version will not read as an archive —
 * a stray directory or an unreadable manifest is reported rather than silently skipped, and rather than
 * stopping the history.
 */
async function listArchives({ workspaceRoot, bundleId } = {}) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new TypeError("listArchives needs the workspace root.");
  const root = path.resolve(workspaceRoot);
  const scoped = bundleId === undefined || bundleId === null ? null : assertBundleId(bundleId);
  const { archives, refused } = await scanArchives(root, scoped);
  let index = { readable: true, rebuilt: false, count: 0, refusal: null, reason: null };
  try {
    const read = await readArchiveIndex(root);
    index = { readable: true, rebuilt: read.rebuilt, count: read.archives.length, refusal: null, reason: null };
  } catch (error) {
    if (error.refusal !== REFUSALS.ARCHIVE_INDEX_SCHEMA) throw error;
    index = { readable: false, rebuilt: false, count: 0, refusal: error.refusal, reason: error.message };
  }
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    workspaceRoot: root,
    archiveFolder: ARCHIVE_FOLDER,
    absoluteArchiveFolder: path.join(root, ARCHIVE_FOLDER),
    bundleId: scoped,
    count: archives.length,
    archives: archives.map((manifest) => ({
      archiveId: manifest.archiveId,
      bundleId: manifest.bundleId,
      bundleVersion: manifest.bundleVersion,
      replacedVersion: manifest.replacedVersion ?? null,
      archivedAt: manifest.archivedAt,
      reason: manifest.reason,
      fileCount: manifest.files.length,
      archiveDirectory: manifest.archiveDirectory,
      absoluteArchiveDirectory: path.join(root, manifest.archiveDirectory),
      manifestPath: `${manifest.archiveDirectory}/${ARCHIVE_MANIFEST_FILE}`,
      absoluteManifestPath: path.join(root, manifest.archiveDirectory, ARCHIVE_MANIFEST_FILE),
      files: manifest.files,
      manifest,
    })),
    refused,
    index,
  };
}

/**
 * Write one archive's bytes back into the workspace (HR-23).
 *
 * The same discipline as an install, in the same order: stage every archived file and re-hash it against
 * its manifest; archive whatever the restore is about to replace, with reason `restore`; only then rename
 * the staged copies into place, and only while the destination still holds the bytes that were archived.
 * A mismatch anywhere in that chain stops the restore before the first workspace write, and the receipt is
 * rewritten to record the version that is actually in the workspace now — otherwise the next plan would
 * call the restored bytes "user-modified".
 */
async function restoreArchive({ workspaceRoot, bundleId, archiveId, verifyFile } = {}) {
  if (typeof workspaceRoot !== "string" || workspaceRoot.length === 0) throw new TypeError("restoreArchive needs the workspace root.");
  const root = path.resolve(workspaceRoot);
  const manifest = await readArchiveManifest(root, assertBundleId(bundleId), assertArchiveId(archiveId));
  const archiveFolder = await ensureRealDirectory(root, manifest.archiveDirectory);
  const verify = verifyFile || defaultVerifyFile;
  const staging = path.join(root, STAGING_FOLDER, "restore", bundleId, archiveId);
  await fs.rm(staging, { recursive: true, force: true });
  await ensureRealDirectory(root, `${STAGING_FOLDER}/restore/${bundleId}/${archiveId}`, true);

  // Phase 1: nothing enters the workspace until every archived file in this archive has re-hashed.
  const staged = [];
  for (const entry of manifest.files) {
    const parts = workspacePathParts(entry.path, `Archive ${archiveId} file path`);
    const relative = parts.join("/");
    // `.github/skills/<skill-id>/<file>`: four real segments, the third a safe skill id. Anything else in a
    // manifest is refused before it can drive a write, because a manifest is data this module did not author.
    if (parts.length < 4 || !relative.startsWith(`${SKILL_ROOT}/`) || !SKILL_ID_PATTERN.test(parts[2])) {
      throw refuse(REFUSALS.RESTORE_PATH_OUT_OF_SCOPE, `Archive ${archiveId} names ${relative}, which is outside ${SKILL_ROOT}/<skill-id>/. A restore writes only bundle files.`);
    }
    const archived = path.join(archiveFolder, ...parts);
    if (!under(archiveFolder, archived)) throw refuse(REFUSALS.OUTSIDE_WORKSPACE, `Archive ${archiveId} names ${parts.join("/")}, which resolves outside its archive directory.`);
    const info = await fs.lstat(archived).catch((error) => {
      if (error.code === "ENOENT") throw refuse(REFUSALS.ARCHIVE_NOT_FOUND, `Archive ${archiveId} no longer holds ${parts.join("/")}. Nothing was written to the workspace.`);
      throw error;
    });
    if (info.isSymbolicLink() || !info.isFile()) {
      throw refuse(REFUSALS.ARCHIVE_PATH_IS_LINK, `The archived copy of ${parts.join("/")} is not a real file. Nothing was written to the workspace.`);
    }
    const content = await fs.readFile(archived);
    if (digest(content) !== entry.sha256) {
      throw refuse(REFUSALS.ARCHIVE_HASH_MISMATCH, `The archived copy of ${parts.join("/")} is not the bytes archive ${archiveId} records. Nothing was written to the workspace.`);
    }
    const stagedPath = path.join(staging, ...parts);
    if (parts.length > 1) await ensureRealDirectory(root, `${STAGING_FOLDER}/restore/${bundleId}/${archiveId}/${parts.slice(0, -1).join("/")}`, true);
    await fs.writeFile(stagedPath, content, { flag: "wx" });
    if (digest(await fs.readFile(stagedPath)) !== entry.sha256) {
      throw refuse(REFUSALS.ARCHIVE_HASH_MISMATCH, `The staged copy of ${parts.join("/")} does not match the archive. Nothing was written to the workspace.`);
    }
    if (await verify({ stagedPath, relative: parts.join("/"), expected: entry.sha256, bundleId, archiveId }) !== true) {
      throw refuse(REFUSALS.ARCHIVE_WRITE_REFUSED, `The verifier refused the staged copy of ${parts.join("/")}. Nothing was written to the workspace.`);
    }
    staged.push({ entry, parts, content, stagedPath });
  }

  // Phase 2: archive what this restore replaces, before it replaces anything (HR-23).
  const previous = await readReceipt(root, bundleId);
  const replaced = [];
  for (const item of staged) {
    const relative = item.parts.join("/");
    const destination = path.join(root, ...item.parts);
    if (!under(root, destination)) throw refuse(REFUSALS.OUTSIDE_WORKSPACE, `Restoring ${relative} would write outside the workspace root. Nothing was written.`);
    const info = await fs.lstat(destination).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink() || !info.isFile()) {
      item.blocked = info.isSymbolicLink()
        ? "The path is a link. The toolkit does not write through links, so nothing was written there."
        : "The path is not a regular file. Nothing was written there.";
      continue;
    }
    const presentDigest = digest(await fs.readFile(destination));
    if (presentDigest === item.entry.sha256) { item.identical = true; continue; }
    item.presentDigest = presentDigest;
    replaced.push({
      target: relative,
      state: "restore-replaces",
      replacedBySha256: item.entry.sha256,
      replacedBy: `archive ${archiveId} (${manifest.bundleVersion}) ${relative}`,
    });
  }
  // The version an archive's bytes came from is `replacedVersion`; `bundleVersion` is what replaced them.
  // A restore puts the *archived* version back, so that is the version named on the workspace and in the
  // archive it creates. When an archive recorded no `replacedVersion`, the version it was archived under is
  // named instead, and its per-file `replacedBy` still says where the bytes actually came from.
  const restoringVersion = typeof manifest.replacedVersion === "string" && manifest.replacedVersion.trim() !== ""
    ? manifest.replacedVersion
    : manifest.bundleVersion;
  const archiveRun = replaced.length
    ? await writeArchive({
      root, bundleId,
      bundleVersion: restoringVersion,
      replacedVersion: previous && typeof previous.bundleVersion === "string" ? previous.bundleVersion : null,
      skills: manifest.skills, reason: "restore", entries: replaced,
    })
    : null;

  // Phase 3: rename the staged copies in, one destination at a time, each one checked against the bytes
  // this run archived from it.
  const restoredAt = timestamp();
  const restored = [];
  const refusedFiles = [];
  for (const item of staged) {
    const relative = item.parts.join("/");
    const destination = path.join(root, ...item.parts);
    const identity = { path: relative, sha256: item.entry.sha256, bytes: item.content.length };
    if (item.blocked) {
      refusedFiles.push({ ...identity, refusal: REFUSALS.TARGET_NOT_A_REGULAR_FILE, reason: item.blocked });
      continue;
    }
    if (item.identical) {
      restored.push({ ...identity, written: false, reason: "The workspace already holds these bytes; nothing was written." });
      continue;
    }
    const directory = path.dirname(destination);
    await fs.mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `${path.basename(destination)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`);
    try {
      await fs.writeFile(temporary, item.content, { flag: "wx" });
      if (digest(await fs.readFile(temporary)) !== item.entry.sha256) {
        throw refuse(REFUSALS.ARCHIVE_HASH_MISMATCH, `The staged copy for ${relative} failed its own hash check. The file in the workspace was left in place.`);
      }
      const present = await fs.lstat(destination).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (present && (present.isSymbolicLink() || !present.isFile())) {
        refusedFiles.push({ ...identity, refusal: REFUSALS.TARGET_NOT_A_REGULAR_FILE, reason: "The path became a link or a non-file while this restore ran. Nothing was written there." });
        continue;
      }
      if (present && digest(await fs.readFile(destination)) !== item.presentDigest) {
        refusedFiles.push({ ...identity, refusal: REFUSALS.TARGET_CHANGED_MID_RUN, reason: "The file changed while this restore was archiving it. It is left exactly as it is." });
        continue;
      }
      await fs.rename(temporary, destination);
      if (digest(await fs.readFile(destination)) !== item.entry.sha256) {
        throw refuse(REFUSALS.ARCHIVE_HASH_MISMATCH, `The restored ${relative} does not match its archive after the write.`);
      }
      restored.push({ ...identity, written: true, reason: `Restored from archive ${archiveId}.` });
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  // The restore staging directory holds only copies this run made; it is the one thing here is removed.
  await fs.rm(staging, { recursive: true, force: true });

  const receipt = await writeRestoreReceipt({ root, bundleId, manifest, restoringVersion, archiveId, restored, refused: refusedFiles, archiveRun, restoredAt, previous });
  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    bundleId,
    archiveId,
    restoredAt,
    workspaceRoot: root,
    archiveDirectory: manifest.archiveDirectory,
    absoluteArchiveDirectory: archiveFolder,
    bundleVersionRestored: restoringVersion,
    filesRestored: restored.filter((item) => item.written).length,
    restored,
    refused: refusedFiles,
    archive: archiveSummary(archiveRun),
    receipt,
  };
}

/**
 * The receipt after a restore.
 *
 * A restore changes which version's bytes are in the workspace, so the receipt has to change with it: the
 * file entries carry the restored hashes and say which archive they came from, `bundleVersion` names the
 * version now in place, and `previousVersion` keeps the one it replaced. Without this the next plan would
 * read the restored files as if the operator had edited them.
 */
async function writeRestoreReceipt({ root, bundleId, manifest, restoringVersion, archiveId, restored, refused, archiveRun, restoredAt, previous }) {
  const written = new Map(restored.map((item) => [item.path, item]));
  const kept = (Array.isArray(previous && previous.files) ? previous.files : [])
    .filter((entry) => entry && typeof entry.path === "string" && !written.has(entry.path))
    .map((entry) => ({ ...entry }));
  const files = kept.concat(restored.map((item) => ({
    path: item.path,
    bundlePath: null,
    skill: item.path.split("/")[2] || null,
    sha256: item.sha256,
    bytes: item.bytes,
    state: item.written ? "restored" : "identical",
    installed: true,
    // A restore is this installer putting bytes at this path, so the provenance the next plan reads is true.
    installedByToolkit: true,
    installedAt: item.written ? restoredAt : (previous && typeof previous.installedAt === "string" ? previous.installedAt : restoredAt),
    restoredFrom: archiveId,
    reason: item.reason,
  })));
  const receipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    bundleId,
    bundleVersion: restoringVersion,
    previousVersion: previous && typeof previous.bundleVersion === "string" ? previous.bundleVersion : null,
    upgrade: null,
    catalogSchemaVersion: CATALOG_SCHEMA_VERSION,
    installedAt: previous && typeof previous.installedAt === "string" ? previous.installedAt : restoredAt,
    workspace: path.basename(root),
    skills: Array.isArray(manifest.skills) && manifest.skills.length ? manifest.skills.slice() : (Array.isArray(previous && previous.skills) ? previous.skills.slice() : []),
    license: previous && typeof previous.license === "string" ? previous.license : "not recorded by the archive this restore came from",
    publishable: previous && typeof previous.publishable === "boolean" ? previous.publishable : false,
    filesInstalled: files.filter((entry) => entry.installed).length,
    filesWritten: restored.filter((item) => item.written).length,
    preserved: refused.length + kept.filter((entry) => !entry.installed).length,
    // A restore is not a force update: it writes archived bytes, and it refuses a target it cannot write
    // safely rather than overwriting it. `archive` is what the restore preserved before it wrote.
    force: false,
    archive: archiveSummary(archiveRun),
    files,
    conflicts: kept.filter((entry) => entry.state === "user-modified" || entry.state === "conflict")
      .map((entry) => ({ path: entry.path, state: entry.state, reason: entry.reason })),
    hostDiscoveryVerified: false,
    hostDiscoveryReason: HOST_DISCOVERY_REASON,
    workflowTested: false,
    workflowTestedReason: WORKFLOW_TESTED_REASON,
    restore: {
      restoredAt,
      archiveId,
      // The archive's own recorded version, and the version its bytes came from: the second is what the
      // workspace holds after this restore, and the receipt's `bundleVersion` says so.
      archiveVersion: manifest.bundleVersion,
      restoredVersion: restoringVersion,
      files: restored.map((item) => item.path),
      refused,
      archivedReplacement: archiveSummary(archiveRun),
    },
  };
  await writeReceiptFile(root, bundleId, receipt);
  return receipt;
}

module.exports = {
  CATALOG_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  SKILL_ROOT,
  RECEIPT_FOLDER,
  STAGING_FOLDER,
  ARCHIVE_SCHEMA_VERSION,
  ARCHIVE_FOLDER,
  ARCHIVE_INDEX_FILE,
  ARCHIVE_LOG_FILE,
  ARCHIVE_MANIFEST_FILE,
  ARCHIVE_REASONS,
  REFUSALS,
  HOST_DISCOVERY_REASON,
  WORKFLOW_TESTED_REASON,
  readCatalog,
  validateCatalog,
  bundleFor,
  planInstall,
  installBundle,
  readReceipt,
  repairBundle,
  listArchives,
  restoreArchive,
  digest,
};
