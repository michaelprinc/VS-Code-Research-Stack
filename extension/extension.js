"use strict";

const GATE_STATUS = Object.freeze({
  basic: "prototype; G1 not passed",
  research: "prototype; G2 not passed",
  full: "prototype foundation only; G3 not passed",
});

function readinessText() {
  return [
    "Research Stack Phase 4 preview",
    "This VSIX verifies extension packaging and activation only.",
    `Basic: ${GATE_STATUS.basic}`,
    `Research: ${GATE_STATUS.research}`,
    `Full: ${GATE_STATUS.full}`,
    "Setup, downloads, service starts, profile changes, and updates are disabled.",
  ].join("\n");
}

function activateWith(vscode, context) {
  if (!vscode || !vscode.commands || !vscode.window || !context || !Array.isArray(context.subscriptions)) {
    throw new TypeError("A VS Code API object and ExtensionContext subscriptions are required.");
  }

  const output = vscode.window.createOutputChannel("Research Stack");
  context.subscriptions.push(output);
  const command = vscode.commands.registerCommand("researchToolkit.showPhaseReadiness", () => {
    const status = readinessText();
    output.clear();
    output.appendLine(status);
    output.show(true);
    return status;
  });
  context.subscriptions.push(command);
}

function activate(context) {
  return activateWith(require("vscode"), context);
}

module.exports = { activate, activateWith, readinessText };
