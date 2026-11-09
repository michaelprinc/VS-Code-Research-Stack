"use strict";
const assert = require("node:assert/strict");
const extension = require("../extension");
const fs = require("node:fs");
const path = require("node:path");

function makeHarness({ pickedId = "full", cancel = false, failUpdate = false, initial = {}, initialGlobalState = {}, folders, trusted = true, diagnosticServices, confirmSetup = true, confirmPrompt = true, documentPath, reportNote = "", reportCancel = false, storageDir = null, updateReply = { status: 404, body: "" }, pickButton = null, quickPicks = null } = {}) {
  const registered = new Map();
  const disposed = [];
  const values = new Map(Object.entries(initial));
  const workspaceValues = new Map();
  const folderValues = new Map();
  const globalState = new Map(Object.entries(initialGlobalState));
  // 0.3.11: `context.secrets` is the editor's SecretStorage. Every call is recorded, so a test can say exactly what
  // was stored, under which key, and that nothing outside that key was touched.
  const secretStore = new Map();
  const events = { messages: [], writtenFiles: [], createdDirectories: [], updateChecks: [], secrets: [], quickPicks: [] };
  // 0.3.11: the answers the operator gives to the integration Quick Picks, consumed in the order asked.
  const quickAnswers = Array.isArray(quickPicks) ? [...quickPicks] : [];
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
    Uri: {
      // A Uri-like result, not a bare string: the 0.3.10 report path reads `fsPath` off the Uri it wrote.
      joinPath(base, ...parts) {
        const joined = [typeof base === "string" ? base : String(base), ...parts].join("/");
        return { scheme: "file", fsPath: joined, path: joined, toString() { return joined; } };
      },
      parse(value) { return value; },
      file(value) { return { scheme: "file", fsPath: value, path: value, toString() { return value; } }; },
    },
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
        // 0.3.10: the problem report writes a file the operator reads. The harness writes into a real
        // temporary directory so a test can open what the shipped controller produced.
        async createDirectory(uri) {
          const target = typeof uri === "string" ? uri : uri.fsPath;
          fs.mkdirSync(target, { recursive: true });
          events.createdDirectories.push(target);
        },
        async writeFile(uri, contents) {
          const target = typeof uri === "string" ? uri : uri.fsPath;
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, contents);
          events.writtenFiles.push(target);
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
        // Modal option objects are not buttons; only string items are answers. The options are recorded
        // too, so a test can assert that a consent really was a modal and read what it told the operator.
        const buttons = items.filter((item) => typeof item === "string");
        events.messages.push({ kind: "information", text, buttons, options: items.find((item) => item && typeof item === "object") });
        // 0.3.11: a consent dialog has several buttons and which one the operator pressed is the whole
        // question. `pickButton` answers a named one; otherwise the first button stands for "yes".
        if (pickButton && buttons.includes(pickButton)) return pickButton;
        if (buttons.length) return confirmSetup && confirmPrompt ? buttons[0] : undefined;
        return confirmSetup ? "Set up package components" : undefined;
      },
      async showWarningMessage(text, ...items) {
        const buttons = items.filter((item) => typeof item === "string");
        events.messages.push({ kind: "warning", text, buttons, options: items.find((item) => item && typeof item === "object") });
        if (pickButton && buttons.includes(pickButton)) return pickButton;
        return confirmPrompt ? buttons[0] : undefined;
      },
      // 0.3.10: the problem report asks for a note first. Escape is `undefined`, and the controller must
      // treat that as "write nothing, open nothing".
      async showInputBox(options) { events.inputBox = options; return reportCancel ? undefined : reportNote; },
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
        events.quickPicks.push({ title: options.title, items });
        if (options.title === "Choose a tools preset for your goal") {
          const packageId = values.get("selectedPackage") || "recommended";
          const offered = extension.presetsForPackage(packageId).map((item) => item.id);
          assert.deepEqual([...items.map((item) => item.id)].sort(), [...offered, "package-default"].sort(), "the Quick Pick offers exactly the presets this package allows, in the order it chooses");
          assert.ok(items.slice(0, -1).every((item) => /toolkit tools/.test(item.description)));
          assert.match(items.at(-1).description, /Default for this package/);
          return cancel ? undefined : items.find((item) => item.id === pickedId);
        }
        if (options.title === "Select a Research Stack package") {
          assert.equal(items.length, 3);
          assert.equal(items.find((item) => item.id === "recommended").description, "Currently selected");
          return cancel ? undefined : items.find((item) => item.id === pickedId);
        }
        // 0.3.11: the two integration Quick Picks — which service, then which action. `quickPicks` stands for
        // what the operator chose, in order; a null entry stands for Escape. An action the controller did not
        // offer cannot be chosen, because the lookup is over the items the controller actually passed in.
        if (options.title === "Integrations & Accounts — saved once for this VS Code profile" || /: what do you want to do\?$/.test(options.title)) {
          const wanted = quickAnswers.shift();
          return wanted === null || wanted === undefined ? undefined : items.find((item) => item.label === wanted);
        }
        throw new Error(`the harness has no Quick Pick answer for "${options.title}"`);
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
    // 0.3.11: SecretStorage with the editor's own shape. The value is recorded because the test has to be able to
    // prove which key a credential landed under — and that it never landed in `globalState`.
    secrets: {
      async get(key) { const value = secretStore.get(key); events.secrets.push({ op: "get", key, value }); return value; },
      async store(key, value) { secretStore.set(key, value); events.secrets.push({ op: "store", key, value }); },
      async delete(key) { secretStore.delete(key); events.secrets.push({ op: "delete", key, value: undefined }); },
    },
    extensionUri: { fsPath: path.resolve(__dirname, ".."), toString() { return "extension"; } }, extension: { packageJSON: { version: require("../package.json").version } },
    // 0.3.10: the report file goes to the extension's own storage folder, exactly as in the editor.
    storageUri: storageDir ? { scheme: "file", fsPath: storageDir, path: storageDir, toString() { return storageDir; } } : undefined,
  };
  // 0.3.10: no test reaches the Marketplace. The harness supplies the transport the controller would
  // otherwise take from `updates.httpsGet`, so the update logic runs against a recorded reply and a test
  // can assert how many requests were made — including the case where the answer is none.
  const services = { ...(diagnosticServices || {}), updateTransport: async (url) => { events.updateChecks.push(url); return updateReply; } };
  const api = extension.activateWith(vscode, context, services);
  return { registered, context, disposed, output, values, workspaceValues, folderValues, globalState, secrets: secretStore, events, panels, statusBar, provider, invoked, api, vscode };
}

module.exports = { makeHarness };
