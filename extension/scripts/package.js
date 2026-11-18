"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createVSIX } = require("@vscode/vsce");
const { pairProblems } = require("../lockfile");

/**
 * Refuse to package a worker whose lock does not match its own project file.
 *
 * `npm run package` runs the Python gates first, but this script can also be run directly (and vsce
 * can be run by hand), and 0.3.6 shipped exactly this way: a worker lock that still recorded the
 * 0.3.4 project version, which every host's uv then refused. The check is the same reader the shipped
 * extension uses, so the packager cannot ship a pair its own runtime would refuse.
 */
function assertWorkerPairCurrent(projectRoot) {
  const worker = path.join(projectRoot, "worker");
  const pyproject = fs.readFileSync(path.join(worker, "pyproject.toml"), "utf8");
  const lock = fs.readFileSync(path.join(worker, "uv.lock"), "utf8");
  const problems = pairProblems(pyproject, lock);
  if (problems.length) {
    throw new Error(`Refusing to package a stale worker dependency pair: ${problems.join("; ")}. Run: python3 scripts/build_worker_bundle.py`);
  }
}

/**
 * Rewrite every staged text file to LF line endings.
 *
 * `.gitattributes` says `* text=auto eol=lf`, but a maintainer's tree can still hold CRLF copies of the
 * guides (git normalises them on commit, so `git status` stays clean while the file on disk keeps CRLF).
 * vsce copies those bytes verbatim, which makes the artifact depend on the build host: the 0.3.7 build
 * from this tree and a build from a fresh clone of the same tag differed in 17 members. The release
 * digest has to be reproducible from the tag, so the staged tree is normalised here.
 */
const TEXT_EXTENSIONS = new Set([".md", ".js", ".cjs", ".mjs", ".json", ".py", ".toml", ".txt", ".svg", ".css", ".html", ".yml", ".yaml"]);

function normalizeStagedLineEndings(stageRoot) {
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(target); continue; }
      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const bytes = fs.readFileSync(target);
      if (!bytes.includes(0x0d)) continue;
      const normalized = Buffer.alloc(bytes.length);
      let written = 0;
      for (let index = 0; index < bytes.length; index += 1) {
        if (bytes[index] === 0x0d && bytes[index + 1] === 0x0a) continue;
        normalized[written++] = bytes[index];
      }
      fs.writeFileSync(target, normalized.subarray(0, written));
    }
  };
  walk(stageRoot);
}

/**
 * Give every staged file the same permission bits.
 *
 * vsce records the mode of each file it packs in the ZIP entry headers. A maintainer's tree and a fresh
 * clone of the same tag are not the same tree: 32 members of the 0.3.7 build carried 0664 here and 0644
 * in a clone, byte-identical content, different digests. The packaged files are read by VS Code and by
 * uv, never executed directly, so the staged copies are normalised to 0644. The source tree is not
 * touched.
 */
function normalizeStagedModes(stageRoot) {
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(target); continue; }
      fs.chmodSync(target, 0o644);
    }
  };
  walk(stageRoot);
}

/**
 * Rewrite the permission bits recorded in the finished artifact's central directory.
 *
 * `normalizeStagedModes` is the intent, but on Windows it cannot be expressed: `fs.chmodSync(target,
 * 0o644)` succeeds and the file still reports 0o666, because NTFS has no owner/group/other bits. vsce
 * passes `f.mode` to yazl, that is `undefined` for every file it collected from the staged tree, so yazl
 * falls back to `stats.mode` (yazl/index.js:34) and writes 0o666 for all 109 copied members where a POSIX
 * host writes 0o644. `scripts/verify_vsix.py` refuses those bits, so the same tag produced a publishable
 * artifact on Linux and an unpublishable one here.
 *
 * The bits live only in the central directory header (the local file header has no such field), at a fixed
 * offset, and no CRC covers them. Rewriting them in place therefore changes the mode without touching a
 * single content byte, a member order, a timestamp or a compressed size — which is exactly what the gate
 * asks for, and it makes the artifact identical on every host instead of dependent on one.
 *
 * The values are the ones a POSIX build already produces: vsce's three generated members are packed with
 * `addBuffer` and no mode, so yazl defaults them to 0o664; everything copied from the staged tree is
 * 0o644. This function states that outcome rather than inheriting it from the build host.
 */
const GENERATED_VSIX_MEMBERS = new Set(["[Content_Types].xml", "extension.vsixmanifest", "extension/readme.md", "extension/changelog.md"]);
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

function normalizePackagedModes(archivePath) {
  const buffer = fs.readFileSync(archivePath);
  let end = -1;
  for (let offset = buffer.length - 22; offset >= 0 && offset >= buffer.length - 65557; offset--) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) { end = offset; break; }
  }
  if (end === -1) throw new Error(`Refusing to package: no end-of-central-directory record in ${archivePath}`);
  const memberCount = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  if (cursor === 0xffffffff || memberCount === 0xffff) {
    throw new Error("Refusing to package: this packager does not rewrite modes in a ZIP64 central directory");
  }
  const before = [];
  const after = [];
  for (let seen = 0; seen < memberCount; seen++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Refusing to package: corrupt central directory entry ${seen} in ${archivePath}`);
    }
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    before.push((buffer.readUInt32LE(cursor + 38) >> 16) & 0o777);
    buffer.writeUInt32LE((0o100000 | (GENERATED_VSIX_MEMBERS.has(name) ? 0o664 : 0o644)) << 16 >>> 0, cursor + 38);
    after.push((buffer.readUInt32LE(cursor + 38) >> 16) & 0o777);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (cursor !== end) throw new Error(`Refusing to package: central directory length does not match ${archivePath}`);
  fs.writeFileSync(archivePath, buffer);
  return { memberCount, before, after };
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  assertWorkerPairCurrent(projectRoot);
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "research-stack-vsix-stage-"));
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "vsix-manifest.json"), "utf8"));
  const outputPath = path.resolve(projectRoot, "..", "dist", `research-stack-toolkit-${manifest.version}.vsix`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    fs.writeFileSync(path.join(stageRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    for (const file of [
      "extension.js", "ui.js", "diagnostics.js", "runner.js", "hosttools.js", "preflight.js",
      "setuplog.js", "steps.js", "status.js", "lockfile.js", "runtime.js", "installer.js", "probe.py",
      "functional_check.py", "components.json", "presets.json", "bundles.js",
      // 0.3.10: the published-version check and the problem-report builder. Both are staged explicitly,
      // like every other shipped module, so nothing reaches the artifact that this list did not name.
      "updates.js", "reports.js",
      // 0.3.11: the integration onboarding. Staged explicitly like every other shipped module, so
      // nothing reaches the artifact that this list did not name.
      "integrations.js", "integrationstore.js", "integrationprobe.js",
      // 0.3.14 (HR-11, HR-12): the preset→Copilot selection module. `extension.js` requires it at
      // activation, so a package that contributes the command without this module activates and fails.
      "presetselect.js",
    ]) {
      fs.copyFileSync(path.join(projectRoot, file), path.join(stageRoot, file));
    }
    fs.cpSync(path.join(projectRoot, "media"), path.join(stageRoot, "media"), { recursive: true });
    fs.cpSync(path.join(projectRoot, "guides"), path.join(stageRoot, "guides"), { recursive: true });
    fs.cpSync(path.join(projectRoot, "worker"), path.join(stageRoot, "worker"), { recursive: true });
    // 0.3.9: the reviewed skill-bundle catalog and the bundle payload ship beside the worker, and
    // `scripts/verify_vsix.py` compares every `extension/bundles/catalog.json` digest with the member
    // it packs and with the staged template tree the catalog was generated from.
    fs.cpSync(path.join(projectRoot, "bundles"), path.join(stageRoot, "bundles"), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, "README.md"), path.join(stageRoot, "README.md"));
    // 0.3.10: the licence, support and security notices the Marketplace listing and the Details page
    // point at. vsce's LicenseProcessor claims the first `extension/LICENSE(.md|.txt)` member it sees
    // and records it as the package's licence asset, so `skipLicense` is no longer passed.
    fs.copyFileSync(path.join(projectRoot, "LICENSE.txt"), path.join(stageRoot, "LICENSE.txt"));
    for (const file of ["SUPPORT.md", "SECURITY.md"]) fs.copyFileSync(path.join(projectRoot, file), path.join(stageRoot, file));
    // The Marketplace Changelog tab is filled from `extension/changelog.md`, which vsce's ChangelogProcessor
    // reads from the staged root (out/package.js: `options.changelogPath ?? 'changelog.md'`). Without the
    // staged copy the listing ships a Details page that links to a changelog the Marketplace does not have.
    // The staged source is MARKETPLACE-CHANGELOG.md, not CHANGELOG.md: the Marketplace tab carries the
    // curated notes for the release being published, while `extension/CHANGELOG.md` stays the full
    // release history in the source repository.
    fs.copyFileSync(path.join(projectRoot, "MARKETPLACE-CHANGELOG.md"), path.join(stageRoot, "CHANGELOG.md"));
    normalizeStagedLineEndings(stageRoot);
    normalizeStagedModes(stageRoot);
    // Line endings are only half of a reproducible artifact. vsce writes the copy time of each staged
    // file, and a new Date(), into the ZIP entry headers, so two builds of the same commit produced
    // 312,471-byte artifacts with byte-identical members and different digests. vsce honours the
    // SOURCE_DATE_EPOCH convention (out/package.js: it sets every entry's mtime to that epoch and sorts
    // the members by path), so the build is stamped with 1980-01-01T00:00:00Z, the earliest date the
    // ZIP format can record.
    process.env.SOURCE_DATE_EPOCH = "315532800";
    // The epoch is an instant, but the ZIP local header stores a *local* date and time. vsce converts
    // the epoch to a Date and yazl writes it in the host's zone, so a host at UTC+1 stamped every member
    // 1980-01-01 01:00 and scripts/verify_vsix.py refused the artifact as unstamped. Node reads
    // process.env.TZ when it resolves a Date, so pinning it here makes the stamped members identical on
    // every host and every zone.
    process.env.TZ = "UTC";
    await createVSIX({
      cwd: stageRoot,
      packagePath: outputPath,
      dependencies: false,
      rewriteRelativeLinks: false,
    });
    normalizePackagedModes(outputPath);
    const stats = fs.statSync(outputPath);
    process.stdout.write(JSON.stringify({
      packagePath: outputPath,
      packageBytes: stats.size,
    }, null, 2) + "\n");
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
