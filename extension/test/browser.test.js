"use strict";

// Browser renderer test. Use the bundled Playwright via NODE_PATH; it is not a shipped dependency.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { WORKER_FOLDER } = require("../runtime");
const TOOLKIT_VERSION = require("../package.json").version;
const { chromium } = require("playwright");
const { makeHarness } = require("./harness");
const { controlPanelHtml } = require("../ui");
// The Python argv shape comes from the shipped runner, not from a fixture's memory of it (0.3.8).
const { hasPythonFlags, runsPythonFile } = require("./python-argv");

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "research-gui-test-"));
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    const documentPath = path.join(root, "Selected fixture.docx"); fs.writeFileSync(documentPath, "browser fixture");
    const harness = makeHarness({ folders: [{ name: "Research <draft>", uri: { scheme: "file", fsPath: root } }], documentPath,
      diagnosticServices: { async findHostTool(name) { return `/host/${name}`; }, async runFile(executable, args) {
        if (args[0] === "sync") {
          const project = args[args.indexOf("--project") + 1];
          const allowed = [path.join(root, WORKER_FOLDER), path.join(root, "notebooks", "analysis")];
          if (!allowed.includes(project)) throw new Error(`browser fixture refuses an unexpected sync target: ${project}`);
          const python = path.join(project, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
          fs.mkdirSync(path.dirname(python), { recursive: true }); fs.writeFileSync(python, "fixture python"); return "";
        }
        if (args[0] === "--version") return `${executable} 9.8.7-browser-fixture`;
        assert.ok(hasPythonFlags(args), `every Python child carries the reviewed flags, got ${args.join(" ")}`);
        if (runsPythonFile(args, "probe.py")) return JSON.stringify({ python: "3.12.99-browser-fixture", packages: Object.fromEntries(["mcp-python-sdk", "mcp-types", "pypdf", "python-docx", "document-worker"].map((id) => [id, { version: id === "document-worker" ? TOOLKIT_VERSION : "9.8.7-browser-fixture", ok: true, detail: "Browser fixture check" }])), recommended: true, full: true, lab: true });
        assert.ok(runsPythonFile(args, "functional_check.py"), `the only other reviewed Python child is the reading check, got ${args.join(" ")}`);
        return JSON.stringify({ ok: true, pdfRead: true, docxRead: true, ...(args.includes("--document") ? { document: "Selected fixture.docx", preview: "Safe selected document preview <not markup>", detail: "Source unchanged." } : {}) });
      } } });
    const panel = harness.api.openControlPanel();
    panel.webview.cspSource = "https://toolkit.test";
    const html = controlPanelHtml(panel.webview, "https://toolkit.test/extension", { joinPath: (base, ...parts) => [base, ...parts].join("/") });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    let theme = "dark";
    const themes = {
      dark: { foreground: "#d4d4d4", "editor-background": "#1e1e1e", "descriptionForeground": "#b3b3b3", "panel-border": "#555555", "sideBar-background": "#252526", "focusBorder": "#70b9ff", "editor-selectionHighlightBackground": "#26405a", "button-background": "#0e639c", "button-foreground": "#ffffff", "button-hoverBackground": "#1177bb", "button-secondaryBackground": "#3a3d41", "button-secondaryForeground": "#ffffff", "button-secondaryHoverBackground": "#45494e", "errorForeground": "#ff9090" },
      light: { foreground: "#222222", "editor-background": "#ffffff", "descriptionForeground": "#595959", "panel-border": "#bbbbbb", "sideBar-background": "#f3f3f3", "focusBorder": "#005fb8", "editor-selectionHighlightBackground": "#e6f1ff", "button-background": "#005fb8", "button-foreground": "#ffffff", "button-hoverBackground": "#004b91", "button-secondaryBackground": "#e5e5e5", "button-secondaryForeground": "#222222", "button-secondaryHoverBackground": "#d5d5d5", "errorForeground": "#b00020" },
      contrast: { foreground: "#ffffff", "editor-background": "#000000", "descriptionForeground": "#ffffff", "panel-border": "#ffffff", "sideBar-background": "#000000", "focusBorder": "#ffff00", "editor-selectionHighlightBackground": "#222222", "button-background": "#000000", "button-foreground": "#ffffff", "button-border": "#ffffff", "button-hoverBackground": "#222222", "button-secondaryBackground": "#000000", "button-secondaryForeground": "#ffffff", "button-secondaryHoverBackground": "#222222", "errorForeground": "#ff9090" },
    };
    await page.route("https://toolkit.test/**", async (route) => {
      const name = new URL(route.request().url()).pathname;
      if (name === "/") return route.fulfill({ contentType: "text/html", body: html });
      const file = name.split("/").at(-1);
      if (!["controls.css", "controls.js"].includes(file)) return route.abort();
      const content = fs.readFileSync(path.join(__dirname, "..", "media", file), "utf8");
      const variables = Object.entries(themes[theme]).map(([key, value]) => `--vscode-${key}:${value};`).join("");
      return route.fulfill({ contentType: file.endsWith("css") ? "text/css" : "text/javascript", body: file.endsWith("css") ? `:root{${variables}--vscode-font-family:Segoe UI,sans-serif;--vscode-font-size:13px;}\n${content}` : content });
    });
    await page.exposeFunction("toolkitMessage", (message) => panel.receive(message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: (message) => window.toolkitMessage(message) }); });
    panel.webview.postMessage = async (data) => { await page.evaluate((message) => window.dispatchEvent(new MessageEvent("message", { data: message })), data); return true; };
    await page.goto("https://toolkit.test/");
    await page.getByText("Saved: Recommended Research", { exact: true }).waitFor();
    assert.equal(await page.locator('input[value="recommended"]').isChecked(), true);
    assert.equal(await page.locator("#workspace").textContent(), "Research <draft>");
    await page.locator("#component-search").fill("Research Stack Toolkit");
    await page.locator(".component-row").getByText(new RegExp(`Version: ${TOOLKIT_VERSION}.*Readiness: Ready`)).waitFor();
    await page.locator(".component-row").getByRole("button", { name: "Guide", exact: true }).click();
    await page.waitForFunction(() => !document.getElementById("component-search").disabled);
    assert.ok(harness.invoked.some((item) => item.id === "markdown.showPreview" && item.args[0] === "extension/guides/toolkit.md"));
    await page.getByRole("button", { name: "Check components", exact: true }).click();
    await page.waitForFunction(() => !document.getElementById("component-search").disabled);
    await page.locator("#component-search").fill("uv environment");
    await page.locator(".component-row").getByText(/9.8.7-browser-fixture/).waitFor();
    await page.locator(".component-row").getByRole("button", { name: "Latest docs" }).click();
    await page.waitForFunction(() => !document.getElementById("component-search").disabled);
    assert.equal(harness.events.external, "https://docs.astral.sh/uv/guides/projects/");
    await page.locator("#component-search").fill("Qdrant");
    await page.locator(".component-row").getByText(/Not bundled.*Planned/).waitFor();
    await page.locator("#component-search").fill("");
    await page.getByRole("button", { name: "Set up package components", exact: true }).click();
    await page.waitForFunction(() => !document.getElementById("component-search").disabled);
    await page.locator("#reading-result").getByText(/MCP check passed/).waitFor();
    await page.locator("#component-search").fill("Basic document worker");
    await page.locator(".component-row").getByText(new RegExp(`Installed.*Version: ${TOOLKIT_VERSION}.*Readiness: Ready`)).waitFor();
    await page.getByRole("button", { name: "Run MCP reading check", exact: true }).click();
    await page.waitForFunction(() => !document.getElementById("component-search").disabled);
    await page.getByRole("button", { name: "Read selected PDF / DOCX", exact: true }).click();
    await page.locator("#reading-result pre").getByText("Safe selected document preview <not markup>", { exact: true }).waitFor();
    await page.waitForFunction(() => !document.getElementById("component-search").disabled);
    await page.locator("#component-search").fill("");
    await page.locator('input[value="basic"]').focus();
    await page.keyboard.press("Space");
    await page.getByRole("button", { name: "Save package preference" }).focus();
    await page.keyboard.press("Enter");
    await page.getByText("Saved: Basic", { exact: true }).waitFor();
    assert.equal(harness.values.get("selectedPackage"), "basic");
    await page.getByText("Following the package default: Read and cite a document", { exact: true }).waitFor();
    assert.equal(await page.locator('input[value="read-and-cite"]').isChecked(), true);
    assert.equal(await page.locator("#preset-list .preset").count(), 2, "Basic offers only the two narrow presets");
    assert.match(await page.locator("#preset-list .preset").first().getAttribute("title"), /Open one workspace PDF or DOCX/);
    await page.locator("#preset-list").getByText("Search my own notes", { exact: true }).click();
    await page.getByRole("button", { name: "Save tools preset" }).click();
    await page.waitForFunction(() => !document.getElementById("save-preset").disabled);
    assert.equal(harness.values.get("toolsPreset"), "find-in-notes");
    await page.getByText("Saved: Search my own notes", { exact: true }).waitFor();
    await page.locator("#preset-details summary").click();
    await page.locator("#preset-estimate").getByText("2 of 128").waitFor();
    await page.locator("#preset-estimate").getByText("Toolkit tools in this preset: search_local_text, read_document.").waitFor();
    await page.locator("#preset-note").getByText(/Focused preset/).waitFor();
    await page.evaluate(() => window.toolkitMessage({ type: "setPreset", id: "research-lab-max" }));
    await page.getByText("Choose a tools preset offered by the selected package.", { exact: true }).waitFor();
    assert.equal(harness.values.get("toolsPreset"), "find-in-notes");
    await page.locator("#show-status-bar").uncheck();
    await page.waitForFunction(() => !document.getElementById("show-status-bar").disabled);
    assert.equal(harness.statusBar.visible, false);
    await page.locator("#open-on-startup").check();
    await page.waitForFunction(() => !document.getElementById("open-on-startup").disabled);
    assert.equal(harness.values.get("openControlPanelOnStartup"), true);
    await page.getByRole("button", { name: "Copy readiness" }).click();
    await page.getByText("Readiness copied to clipboard.", { exact: true }).waitFor();
    assert.match(harness.events.clipboard, /Basic \(basic\)/);
    await page.evaluate(() => window.toolkitMessage({ type: "setPackage", id: "bad" }));
    await page.getByText("Choose a supported package.", { exact: true }).waitFor();
    assert.equal(harness.values.get("selectedPackage"), "basic");
    harness.values.set("selectedPackage", "full");
    await harness.registered.get("researchToolkit.refresh")();
    await page.getByText("Saved: Full", { exact: true }).waitFor();
    await page.getByText("Saved: Search my own notes", { exact: true }).waitFor();
    assert.equal(await page.locator("#preset-list .preset").count(), 7, "Full offers the whole preset range");
    await page.locator("#preset-list").getByText("Maximum research lab (128-tool budget)", { exact: true }).click();
    await page.getByRole("button", { name: "Save tools preset" }).click();
    await page.waitForFunction(() => !document.getElementById("save-preset").disabled);
    assert.equal(harness.values.get("toolsPreset"), "research-lab-max");
    await page.locator("#preset-note").getByText(/Close to the limit: 100 of 128 tools/).waitFor();
    await page.locator("#preset-estimate").getByText("100 of 128").waitFor();
    harness.values.set("selectedPackage", "basic");
    await harness.registered.get("researchToolkit.refresh")();
    await page.getByText('Saved preset "research-lab-max" is not offered by this package · using Read and cite a document', { exact: true }).waitFor();
    assert.equal(await page.locator('input[value="read-and-cite"]').isChecked(), true);
    harness.values.set("selectedPackage", "full");
    await harness.registered.get("researchToolkit.refresh")();
    await page.getByText("Saved: Maximum research lab (128-tool budget)", { exact: true }).waitFor();
    const receiptRoot = path.resolve(__dirname, "..", "..", "evidence", "quality-v" + TOOLKIT_VERSION + "-" + new Date().toISOString().slice(0, 10));
    fs.mkdirSync(receiptRoot, { recursive: true });
    for (const [name, width] of [["dark", 1100], ["light", 390], ["contrast", 1100]]) {
      theme = name;
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await page.getByText("Saved: Full", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${name}: no horizontal overflow`);
      await page.screenshot({ path: path.join(receiptRoot, `${name}.png`), fullPage: true });
    }
    assert.deepEqual(errors, [], "no renderer errors or CSP violations");
    console.log(JSON.stringify({ test: "gui-browser-renderer", packageSaveByKeyboard: true, toolPresets: true, presetContextEstimate: true, presetFallbackAcrossPackages: true, invalidPresetRejected: true, interfaceOptions: true, clipboard: true, invalidMessageRejected: true, externalSettingSync: true, componentSearch: true, observedVersions: true, independentGuidesAndLatestDocs: true, setupAndReadingActions: true, selectedDocumentPreview: true, themes: ["dark", "light-mobile", "high-contrast"], errors }));
  } finally {
    await browser.close();
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("research-gui-test-"));
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
