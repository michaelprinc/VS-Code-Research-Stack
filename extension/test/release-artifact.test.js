"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { releaseArtifact } = require("../scripts/release-artifact");

const manifest = (version) => ({ name: "research-stack-toolkit", version });

test("release names follow the packaged version, including a future release", () => {
  assert.deepEqual(releaseArtifact(manifest("0.3.11"), manifest("0.3.11")), {
    version: "0.3.11", filename: "research-stack-toolkit-0.3.11.vsix",
    path: "dist/research-stack-toolkit-0.3.11.vsix",
  });
  assert.equal(releaseArtifact(manifest("1.2.3"), manifest("1.2.3")).filename, "research-stack-toolkit-1.2.3.vsix");
});

test("release refuses mismatched or unsafe manifest identities", () => {
  assert.throws(() => releaseArtifact(manifest("0.3.10"), manifest("0.3.11")), /versions differ/);
  for (const version of ["0.3.11-beta", "0.3.11/other", "01.3.11", "0.3", "0.3.11\npath=evil"]) {
    assert.throws(() => releaseArtifact(manifest(version), manifest(version)), /numeric major.minor.patch/);
  }
  assert.throws(() => releaseArtifact(manifest("0.3.11"), { name: "other", version: "0.3.11" }), /names/);
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("CLI resolves a 0.3.11 checkout and emits safe workflow outputs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-release-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(path.join(__dirname, "../scripts/release-artifact.js"), path.join(root, "scripts/release-artifact.js"));
  for (const filename of ["package.json", "vsix-manifest.json"]) {
    fs.writeFileSync(path.join(root, filename), JSON.stringify(manifest("0.3.11")));
  }
  const result = spawnSync(process.execPath, [path.join(root, "scripts/release-artifact.js")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "version=0.3.11\nfilename=research-stack-toolkit-0.3.11.vsix\npath=dist/research-stack-toolkit-0.3.11.vsix\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest("0.3.10")));
  const mismatch = spawnSync(process.execPath, [path.join(root, "scripts/release-artifact.js")], { encoding: "utf8" });
  assert.notEqual(mismatch.status, 0);
  assert.equal(mismatch.stdout, "");
});
