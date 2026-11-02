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
const run = spawnSync(command, [...args, artifact], { stdio: "inherit", cwd: projectRoot, shell: false });
if (run.error) throw run.error;
process.exitCode = run.status === null ? 1 : run.status;
