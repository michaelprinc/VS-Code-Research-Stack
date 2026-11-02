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
      "functional_check.py", "components.json", "presets.json",
    ]) {
      fs.copyFileSync(path.join(projectRoot, file), path.join(stageRoot, file));
    }
    fs.cpSync(path.join(projectRoot, "media"), path.join(stageRoot, "media"), { recursive: true });
    fs.cpSync(path.join(projectRoot, "guides"), path.join(stageRoot, "guides"), { recursive: true });
    fs.cpSync(path.join(projectRoot, "worker"), path.join(stageRoot, "worker"), { recursive: true });
    fs.copyFileSync(path.join(projectRoot, "README.md"), path.join(stageRoot, "README.md"));
    await createVSIX({
      cwd: stageRoot,
      packagePath: outputPath,
      dependencies: false,
      rewriteRelativeLinks: false,
      skipLicense: true,
    });
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
