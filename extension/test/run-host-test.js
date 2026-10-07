"use strict";

const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const executablePath = process.env.VSCODE_EXECUTABLE_PATH;
  if (!executablePath) throw new Error("Set VSCODE_EXECUTABLE_PATH to the tested VS Code Desktop executable.");
  const testRoot = process.env.VSCODE_TEST_ROOT;
  if (!testRoot) throw new Error("Set VSCODE_TEST_ROOT to a new disposable test-data directory.");
  const extensionPath = process.env.EXTENSION_DEVELOPMENT_PATH || path.resolve(__dirname, "..");
  await runTests({
    vscodeExecutablePath: executablePath,
    extensionDevelopmentPath: extensionPath,
    extensionTestsPath: path.resolve(__dirname, "host.test.js"),
    launchArgs: [
      "--disable-extensions",
      "--disable-gpu",
      "--disable-workspace-trust",
      `--user-data-dir=${path.join(testRoot, "user-data")}`,
      `--extensions-dir=${path.join(testRoot, "extensions")}`,
    ],
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
