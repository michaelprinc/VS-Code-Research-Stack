"use strict";

/**
 * Run a release-verification command against the artifact this release actually cuts.
 *
 * `npm run verify-package` and `npm run check:payload` used to name
 * `research-stack-toolkit-0.3.6.vsix` in `package.json`. After a version bump they audited the
 * *previous* artifact, or failed outright. The artifact name is derived from
 * `extension/vsix-manifest.json`, which is the file `scripts/package.js` builds the package path from,
 * so the verification can no longer point at stale bytes.
 *
 * Usage: node scripts/with-artifact.js <command> [args…]   — the artifact path is appended.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "vsix-manifest.json"), "utf8"));
if (!manifest.version) throw new Error("extension/vsix-manifest.json declares no version");
const artifact = path.resolve(projectRoot, "..", "dist", `research-stack-toolkit-${manifest.version}.vsix`);
if (!fs.existsSync(artifact)) throw new Error(`No artifact for this release: ${artifact}. Run npm run package first.`);

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Usage: node scripts/with-artifact.js <command> [args…]");
const attempted = [command, ...args, artifact].join(" ");

/**
 * A tool the shell cannot start is an instruction, not a stack trace (0.3.7 e2e review D9).
 * `Error: spawnSync uv ENOENT` named no command, did not say that uv was the missing tool, and
 * left the operator to guess that this build gate and the extension look for uv in different ways.
 */
function explainMissingTool(command) {
  const lines = [
    `This release gate could not run: ${command} was not found on PATH.`,
    "",
    `  Command attempted: ${attempted}`,
    "",
  ];
  if (command === "uv") {
    lines.push(
      "  What this gate needs: uv on the PATH of the shell that runs this npm script.",
      "  The audit runs as `uv run --locked python ../scripts/verify_vsix.py`, so with no uv on",
      "  PATH nothing was audited and nothing was verified.",
      "",
      "  This is not the lookup the extension performs. Setup resolves uv from the",
      "  researchStack.uvPath setting first, then PATH, then the documented install locations.",
      "  A researchStack.uvPath that works inside the editor does not put uv on this shell's PATH.",
      "",
      "  To run the gate: put the folder that holds the uv executable on PATH, for example",
      '      export PATH="/path/to/the/uv/folder:$PATH"',
      "  then run the same npm script again.",
    );
    return lines.join("\n");
  }
  lines.push(
    `  Install ${command}, or put the folder that holds it on the PATH of the shell that runs`,
    "  this npm script, then run the same npm script again.",
  );
  return lines.join("\n");
}

const run = spawnSync(command, [...args, artifact], { stdio: "inherit", cwd: projectRoot, shell: false });
if (run.error && run.error.code === "ENOENT") {
  console.error(explainMissingTool(command));
  process.exit(1);
}
if (run.error) throw run.error;
process.exitCode = run.status === null ? 1 : run.status;
