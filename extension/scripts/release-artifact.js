"use strict";

const fs = require("node:fs");
const path = require("node:path");

function releaseArtifact(development, packaged) {
  const validVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (development.name !== "research-stack-toolkit" || packaged.name !== development.name) {
    throw new Error("Extension manifest names do not match the release identity.");
  }
  if (typeof packaged.version !== "string" || !validVersion.test(packaged.version)) {
    throw new Error("Packaged manifest version must be a numeric major.minor.patch version.");
  }
  if (development.version !== packaged.version) {
    throw new Error("Development and packaged manifest versions differ.");
  }
  const version = packaged.version;
  const filename = `research-stack-toolkit-${version}.vsix`;
  return { version, filename, path: `dist/${filename}` };
}

if (require.main === module) {
  try {
    const root = path.resolve(__dirname, "..");
    const development = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const packaged = JSON.parse(fs.readFileSync(path.join(root, "vsix-manifest.json"), "utf8"));
    const result = releaseArtifact(development, packaged);
    process.stdout.write(`version=${result.version}\nfilename=${result.filename}\npath=${result.path}\n`);
  } catch (error) {
    console.error(`Cannot determine release artifact: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { releaseArtifact };
