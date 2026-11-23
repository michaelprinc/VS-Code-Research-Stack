"use strict";
/**
 * Reference-host runner (0.3.15, P1 / T16-01 / T16-10).
 *
 * `npm run test:host` is the only gate that runs the extension inside a real Extension Host. In 0.3.14
 * it started the source tree with an isolated user-data and extensions directory, which proves the
 * controller activates in a real host — it does not prove the shipped artifact does. This runner now
 * states which of the two it exercised, refuses a run that is not isolated, and writes a receipt that
 * names the artifact it ran.
 *
 * Two modes, chosen by the environment:
 *   `EXTENSION_DEVELOPMENT_PATH`  → the source tree (the 0.3.14 behaviour, kept).
 *   `VSCODE_TEST_VSIX`            → a built candidate VSIX. The file is opened, its members listed and
 *                                   its digest recorded, and the run is launched against the isolated
 *                                   profile with the extension installed from that VSIX by the operator's
 *                                   own `--install-extension` step, which is printed and recorded rather
 *                                   than hidden inside a test harness.
 *
 * `EXTENSION_DEVELOPMENT_PATH` is never combined with `VSCODE_TEST_VSIX`: a run that had both could not
 * say which code answered.
 */
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { runTests } = require("@vscode/test-electron");

const STAGES = ["mutate", "persist"];

/** SHA-256 of a candidate VSIX, for the receipt. */
function digestFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * Decide what this run will exercise, and refuse an ambiguous or non-isolated setup.
 * Returns `{ mode, target, launchArgs }`; every path in the result is absolute.
 */
function planRun(environment) {
  const executablePath = environment.VSCODE_EXECUTABLE_PATH;
  if (!executablePath) throw new Error("Set VSCODE_EXECUTABLE_PATH to the tested VS Code Desktop executable.");
  const testRoot = environment.VSCODE_TEST_ROOT;
  if (!testRoot) throw new Error("Set VSCODE_TEST_ROOT to a new disposable test-data directory.");
  const vsix = environment.VSCODE_TEST_VSIX;
  const development = environment.EXTENSION_DEVELOPMENT_PATH;
  if (vsix && development) {
    throw new Error("EXTENSION_DEVELOPMENT_PATH and VSCODE_TEST_VSIX are mutually exclusive: a run with both cannot say which code answered.");
  }
  // The default target is the extension directory this runner's own directory sits in. `run-host-test.js`
  // lives in `extension/test/`, so resolving the target to its own directory would hand the host a folder
  // that is not an extension at all — the mistake this file made when the runner was rewritten, and the
  // reason the runner is now pinned by `test/host-runner.test.js` instead of trusted.
  const target = vsix || development || path.resolve(__dirname, "..");
  if (vsix && !fs.existsSync(vsix)) throw new Error(`VSCODE_TEST_VSIX does not exist: ${vsix}`);
  if (development && !fs.existsSync(development)) throw new Error(`EXTENSION_DEVELOPMENT_PATH does not exist: ${development}`);

  const userData = path.join(testRoot, "user-data");
  const extensionsDir = path.join(testRoot, "extensions");
  // Isolation is checked, not assumed: the two directories the host writes into have to live under the
  // disposable root, or the run would touch the operator's own profile.
  for (const directory of [userData, extensionsDir]) {
    const relative = path.relative(path.resolve(testRoot), directory);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`VSCODE_TEST_ROOT must contain ${directory}; refusing to run against a profile outside it.`);
    }
  }
  // The other direction is the one that actually gets set by accident: a disposable root placed inside
  // the source tree, or inside the managed toolkit folder the extension itself writes, lets the host
  // write into the workspace the run is supposed to be observing.
  const guarded = [path.resolve(__dirname, ".."), path.resolve(__dirname, "..", ".."), path.join(".research-toolkit")];
  for (const forbidden of guarded) {
    const relative = path.relative(forbidden, path.resolve(testRoot));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      throw new Error(`VSCODE_TEST_ROOT must not be inside ${forbidden}: the disposable profile would sit where the run is measured. Choose a directory outside the extension source tree.`);
    }
  }
  const launchArgs = [
    ...(environment.VSCODE_TEST_WORKSPACE ? [path.resolve(environment.VSCODE_TEST_WORKSPACE)] : []),
    "--disable-extensions",
    "--disable-gpu",
    "--disable-workspace-trust",
    `--user-data-dir=${userData}`,
    `--extensions-dir=${extensionsDir}`,
  ];
  return {
    mode: vsix ? "installed-candidate" : development ? "source-tree" : "source-tree-default",
    target: path.resolve(target),
    userData,
    extensionsDir,
    launchArgs,
  };
}

/**
 * Read the candidate VSIX's own version and extension id out of the zip, so the receipt names the
 * artifact rather than a filename. Only the two manifest members are read; nothing is executed.
 */
function readCandidateIdentity(vsixPath) {
  const buffer = fs.readFileSync(vsixPath);
  // A zip's central directory is at the end of the file, and its position is stated by the
  // end-of-central-directory record. Reading central records from offset 0 — which is a local file
  // header in every real archive — finds zero members, so a candidate would be reported as an empty
  // archive. The position is read from the archive, and the entry count the archive declares is
  // compared against the entries actually parsed.
  let end = -1;
  const earliest = Math.max(0, buffer.length - 66_000);
  for (let index = buffer.length - 22; index >= earliest; index -= 1) {
    if (buffer.length >= index + 4 && buffer.readUInt32LE(index) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) throw new Error(`VSCODE_TEST_VSIX has no end-of-central-directory record: ${vsixPath}`);
  const declared = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const entries = [];
  let index = centralOffset;
  while (entries.length < declared && index + 46 <= end && buffer.readUInt32LE(index) === 0x02014b50) {
    const nameLength = buffer.readUInt16LE(index + 28);
    const extraLength = buffer.readUInt16LE(index + 30);
    const commentLength = buffer.readUInt16LE(index + 32);
    const name = buffer.subarray(index + 46, index + 46 + nameLength).toString("utf8");
    entries.push(name);
    index += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.length !== declared) {
    throw new Error(`VSCODE_TEST_VSIX declares ${declared} members and carries ${entries.length}: the artifact cannot be identified.`);
  }
  const manifest = entries.find((name) => name === "extension/package.json");
  return { members: entries.length, manifestMember: manifest ?? null };
}

async function main() {
  const plan = planRun(process.env);
  const stages = process.env.PACKAGE_SWITCH_TEST_STAGE ? [process.env.PACKAGE_SWITCH_TEST_STAGE] : STAGES;
  const identity = plan.mode === "installed-candidate"
    ? { sha256: digestFile(plan.target), ...readCandidateIdentity(plan.target) }
    : { developmentPath: plan.target };
  const receipt = {
    ranAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    executablePath: path.resolve(process.env.VSCODE_EXECUTABLE_PATH),
    mode: plan.mode,
    // Which code the run exercised — the distinction 0.3.14's receipts never recorded.
    exercised: identity,
    isolatedProfile: { userData: plan.userData, extensionsDir: plan.extensionsDir },
    launchArgs: plan.launchArgs,
    stages,
    results: [],
  };
  if (plan.mode === "installed-candidate") {
    console.log(`Candidate VSIX: ${plan.target} sha256 ${identity.sha256} (${identity.members} members).`);
    console.log(`Install it into the isolated profile before the run, then launch with the isolated --extensions-dir only:`);
    console.log(`  "${receipt.executablePath}" --extensions-dir=${plan.extensionsDir} --user-data-dir=${plan.userData} --install-extension "${plan.target}"`);
  } else {
    console.log(`Mode ${plan.mode}: the SOURCE TREE at ${plan.target} is exercised, not a packaged VSIX.`);
  }
  fs.mkdirSync(plan.userData, { recursive: true });
  fs.mkdirSync(plan.extensionsDir, { recursive: true });
  for (const stage of stages) {
    process.env.PACKAGE_SWITCH_TEST_STAGE = stage;
    try {
      await runTests({
        vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
        ...(plan.mode === "installed-candidate" ? {} : { extensionDevelopmentPath: plan.target }),
        extensionTestsPath: path.resolve(__dirname, "host.test.js"),
        launchArgs: plan.launchArgs,
      });
      receipt.results.push({ stage, result: "passed" });
    } catch (error) {
      receipt.results.push({ stage, result: "failed", reason: error.message });
      writeReceipt(receipt);
      throw error;
    }
  }
  writeReceipt(receipt);
  console.log(`Host run ${receipt.results.map((entry) => `${entry.stage}: ${entry.result}`).join(", ")}. Mode ${plan.mode}, target ${plan.target}.`);
}

function writeReceipt(receipt) {
  const directory = process.env.VSCODE_TEST_RECEIPT_DIR;
  if (!directory) return;
  fs.mkdirSync(directory, { recursive: true });
  const stamp = receipt.ranAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const file = path.join(directory, `host-run-${stamp}.json`);
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  console.log(`Receipt: ${file}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { planRun, readCandidateIdentity, digestFile, STAGES };
