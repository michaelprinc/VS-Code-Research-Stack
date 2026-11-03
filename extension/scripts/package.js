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
    normalizeStagedLineEndings(stageRoot);
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
