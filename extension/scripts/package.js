"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createVSIX } = require("@vscode/vsce");

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "research-stack-vsix-stage-"));
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "vsix-manifest.json"), "utf8"));
  const outputPath = path.resolve(projectRoot, "..", "dist", `research-stack-toolkit-${manifest.version}.vsix`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    fs.writeFileSync(path.join(stageRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    for (const file of [
      "extension.js", "ui.js", "diagnostics.js", "runner.js", "hosttools.js", "preflight.js",
      "setuplog.js", "steps.js", "status.js", "runtime.js", "installer.js", "probe.py",
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
