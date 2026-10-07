"use strict";

const DEFAULT_PACKAGE = "recommended";
const STATE_KEY = "researchStack.selectedPackage";
const PACKAGE_OPTIONS = Object.freeze([
  Object.freeze({ id: "basic", label: "Basic", detail: "Basic research tools — prototype; G1 not passed" }),
  Object.freeze({ id: "recommended", label: "Recommended Research", detail: "Research package — prototype; G2 not passed" }),
  Object.freeze({ id: "full", label: "Full", detail: "Full Research Lab — prototype foundation only; G3 not passed" }),
]);
const PACKAGES_BY_ID = new Map(PACKAGE_OPTIONS.map((item) => [item.id, item]));

function readinessText(selectedPackage = DEFAULT_PACKAGE) {
  const selected = PACKAGES_BY_ID.get(selectedPackage) || PACKAGES_BY_ID.get(DEFAULT_PACKAGE);
  return [
    "Research Stack Phase 4 preview",
    `Selected package preference: ${selected.label} (${selected.id})`,
    "Changing this preference does not install, remove, or configure components.",
    "This VSIX verifies package preference switching, packaging, and activation only.",
    "Basic: prototype; G1 not passed",
    "Recommended Research: prototype; G2 not passed",
    "Full: prototype foundation only; G3 not passed",
    "Component setup, downloads, service starts, and updates are disabled.",
  ].join("\n");
}

function validateContext(vscode, context) {
  if (
    !vscode || !vscode.commands || !vscode.window ||
    typeof vscode.window.createOutputChannel !== "function" ||
    typeof vscode.window.showQuickPick !== "function" ||
    typeof vscode.commands.registerCommand !== "function" ||
    !vscode.workspace || typeof vscode.workspace.getConfiguration !== "function" ||
    !vscode.ConfigurationTarget || typeof vscode.ConfigurationTarget.Global !== "number" ||
    !context || !Array.isArray(context.subscriptions)
  ) {
    throw new TypeError("VS Code commands, Quick Pick, user settings configuration, and ExtensionContext subscriptions are required.");
  }
}

function selectedPackage(vscode) {
  const configured = vscode.workspace.getConfiguration("researchStack").get("selectedPackage", DEFAULT_PACKAGE);
  return PACKAGES_BY_ID.has(configured) ? configured : DEFAULT_PACKAGE;
}

function activateWith(vscode, context) {
  validateContext(vscode, context);

  const output = vscode.window.createOutputChannel("Research Stack");
  context.subscriptions.push(output);

  const showReadiness = vscode.commands.registerCommand("researchToolkit.showPhaseReadiness", () => {
    const status = readinessText(selectedPackage(vscode));
    output.clear();
    output.appendLine(status);
    output.show(true);
    return status;
  });
  context.subscriptions.push(showReadiness);

  const switchPackage = vscode.commands.registerCommand("researchToolkit.switchPackage", async (requestedId) => {
    let selectedId = requestedId;
    if (selectedId === undefined) {
      const currentId = selectedPackage(vscode);
      const current = PACKAGES_BY_ID.get(currentId) || PACKAGES_BY_ID.get(DEFAULT_PACKAGE);
      const picked = await vscode.window.showQuickPick(
        PACKAGE_OPTIONS.map(({ id, label, detail }) => ({
          id,
          label,
          detail,
          description: id === current.id ? "Currently selected" : undefined,
        })),
        { title: "Select a Research Stack package", placeHolder: "This changes the saved preference only" },
      );
      if (!picked) return undefined;
      selectedId = picked.id;
    }
    const selected = PACKAGES_BY_ID.get(selectedId);
    if (!selected) throw new TypeError(`Unknown Research Stack package: ${String(selectedId)}`);

    await vscode.workspace.getConfiguration("researchStack").update(
      "selectedPackage",
      selected.id,
      vscode.ConfigurationTarget.Global,
    );
    const status = readinessText(selected.id);
    output.clear();
    output.appendLine(status);
    output.show(true);
    return status;
  });
  context.subscriptions.push(switchPackage);
}

function activate(context) {
  return activateWith(require("vscode"), context);
}

module.exports = { activate, activateWith, readinessText, PACKAGE_OPTIONS, DEFAULT_PACKAGE, STATE_KEY };
