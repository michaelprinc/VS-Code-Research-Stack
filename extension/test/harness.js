"use strict";
const assert = require("node:assert/strict");
const extension = require("../extension");
const fs = require("node:fs");
const path = require("node:path");

function makeHarness({ pickedId = "full", cancel = false, failUpdate = false, initial = {}, folders, trusted = true, diagnosticServices, confirmSetup = true, confirmPrompt = true, documentPath } = {}) {
  const registered = new Map();
  const disposed = [];
  const values = new Map(Object.entries(initial));
  const workspaceValues = new Map();
  const folderValues = new Map();
  const globalState = new Map();
  const events = { messages: [] };
  const panels = [];
  const invoked = [];
  const statusBar = { show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
  let provider;
  class Emitter {
    event = (callback) => { this.callback = callback; return { dispose() {} }; };
    fire() { if (this.callback) this.callback(); }
    dispose() {}
  }
  const globalTarget = 1;
  const output = {
    lines: [],
    clear() { this.lines = []; },
    appendLine(value) { this.value = value; this.lines.push(value); },
    show() { this.shown = true; },
    dispose() { disposed.push("output"); },
  };
  const vscode = {
    version: "1.141.0",
    extensions: {
      getExtension() { return undefined; },
      onDidChange(callback) { events.extensions = callback; return { dispose() {} }; },
    },
    EventEmitter: Emitter,
    StatusBarAlignment: { Left: 1 },
    ViewColumn: { One: 1 },
    TreeItemCollapsibleState: { None: 0 },
    TreeItem: class { constructor(label) { this.label = label; } },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    McpStdioServerDefinition: class { constructor(label, command, args, env, version) { Object.assign(this, { label, command, args, env, version }); } },
    lm: { registerMcpServerDefinitionProvider(id, value) { events.mcpProvider = value; return { dispose() {} }; } },
    ProgressLocation: { Notification: 15 },
    Uri: { joinPath(base, ...parts) { return [base, ...parts].join("/"); }, parse(value) { return value; }, file(value) { return { scheme: "file", fsPath: value, path: value, toString() { return value; } }; } },
    env: { clipboard: { async writeText(text) { events.clipboard = text; } }, async openExternal(uri) { events.external = uri; return true; } },
    ConfigurationTarget: { Global: globalTarget, Workspace: 2, WorkspaceFolder: 3 },
    workspace: {
      async openTextDocument(uri) {
        const target = typeof uri === "string" ? uri : uri.fsPath;
        events.openedDocument = target;
        return { uri: { fsPath: target }, getText() { return fs.readFileSync(target, "utf8"); }, lineAt() { return { text: "" }; }, lineCount: 1 };
      },
      fs: {
        async stat(uri) {
          const target = typeof uri === "string" ? uri : uri.fsPath;
          try { return { type: 1, ctime: 0, mtime: 0, size: fs.statSync(target).size }; }
          catch { const error = new Error(`Entry not found: ${target}`); error.code = "FileNotFound"; throw error; }
        },
      },
      workspaceFolders: folders || [{ name: "Research <draft>", uri: { scheme: "file", fsPath: "fixture" } }], isTrusted: trusted,
      onDidChangeConfiguration(callback) { events.config = callback; return { dispose() {} }; },
      onDidChangeWorkspaceFolders(callback) { events.folders = callback; return { dispose() {} }; },
      onDidGrantWorkspaceTrust(callback) { events.trust = callback; return { dispose() {} }; },
      getConfiguration(section) {
        assert.equal(section, "researchStack");
        return {
          get(key, fallback) { return values.has(key) ? values.get(key) : fallback; },
          inspect(key) { return { key, defaultValue: undefined, globalValue: values.get(key), workspaceValue: workspaceValues.get(key), workspaceFolderValue: folderValues.get(key) }; },
          async update(key, value, target) {
            assert.ok(target === globalTarget || target === 2 || target === 3);
            if (target === 2) workspaceValues.set(key, value);
            if (target === 3) folderValues.set(key, value);
            if (failUpdate) throw new Error("Settings are read-only");
            values.set(key, value);
          },
        };
      },
    },
    window: {
      async showInformationMessage(text, ...items) {
        // Modal option objects are not buttons; only string items are answers.
        const buttons = items.filter((item) => typeof item === "string");
        events.messages.push({ kind: "information", text, buttons });
        if (buttons.length) return confirmSetup && confirmPrompt ? buttons[0] : undefined;
        return confirmSetup ? "Set up package components" : undefined;
      },
      async showWarningMessage(text, ...items) {
        const buttons = items.filter((item) => typeof item === "string");
        events.messages.push({ kind: "warning", text, buttons });
        return confirmPrompt ? buttons[0] : undefined;
      },
      async showTextDocument(document) { events.shownDocument = document.uri.fsPath; return { dispose() {} }; },
      async showOpenDialog() { return documentPath ? [{ fsPath: documentPath }] : undefined; },
      async withProgress(options, callback) { return callback({ report(value) { events.progress = value; } }, { onCancellationRequested() { return { dispose() {} }; } }); },
      createStatusBarItem() { return statusBar; },
      registerTreeDataProvider(id, value) { assert.equal(id, "researchToolkit.overview"); provider = value; return { dispose() {} }; },
      createWebviewPanel(type, title, column, options) {
        const panel = {
          type, title, options, messages: [], revealed: 0,
          webview: {
            cspSource: "vscode-resource:", asWebviewUri(uri) { return uri; },
            onDidReceiveMessage(callback) { panel.receive = callback; return { dispose() { panel.listenerDisposed = true; } }; },
            async postMessage(message) { panel.messages.push(message); return true; },
          },
          reveal() { this.revealed++; },
          onDidDispose(callback) { this.close = callback; return { dispose() {} }; },
          dispose() { this.close(); },
        };
        panels.push(panel);
        return panel;
      },
      createOutputChannel(name) { assert.equal(name, "Research Stack"); return output; },
      async showQuickPick(items, options) {
        events.quickPick = { title: options.title, items };
        if (options.title === "Choose a tools preset for your goal") {
          const packageId = values.get("selectedPackage") || "recommended";
          const offered = extension.presetsForPackage(packageId).map((item) => item.id);
          assert.deepEqual([...items.map((item) => item.id)].sort(), [...offered, "package-default"].sort(), "the Quick Pick offers exactly the presets this package allows, in the order it chooses");
          assert.ok(items.slice(0, -1).every((item) => /toolkit tools/.test(item.description)));
          assert.match(items.at(-1).description, /Default for this package/);
          return cancel ? undefined : items.find((item) => item.id === pickedId);
        }
        assert.equal(options.title, "Select a Research Stack package");
        assert.equal(items.length, 3);
        assert.equal(items.find((item) => item.id === "recommended").description, "Currently selected");
        return cancel ? undefined : items.find((item) => item.id === pickedId);
      },
    },
    commands: {
      async executeCommand(id, ...args) {
        invoked.push({ id, args });
        return registered.has(id) ? registered.get(id)(...args) : undefined;
      },
      registerCommand(id, callback) {
        registered.set(id, callback);
        return { dispose() { disposed.push(id); } };
      },
    },
  };
  const context = {
    subscriptions: [],
    globalState: { get: (key) => globalState.get(key), async update(key, value) { globalState.set(key, value); return true; } },
    extensionUri: { fsPath: path.resolve(__dirname, ".."), toString() { return "extension"; } }, extension: { packageJSON: { version: require("../package.json").version } },
  };
  const api = extension.activateWith(vscode, context, diagnosticServices);
  return { registered, context, disposed, output, values, workspaceValues, folderValues, globalState, events, panels, statusBar, provider, invoked, api, vscode };
}

module.exports = { makeHarness };
