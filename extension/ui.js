"use strict";

const { randomBytes } = require("node:crypto");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function controlPanelHtml(webview, extensionUri, Uri) {
  const nonce = randomBytes(24).toString("base64");
  const resource = (name) => escapeHtml(webview.asWebviewUri(Uri.joinPath(extensionUri, "media", name)));
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escapeHtml(webview.cspSource)}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${resource("controls.css")}"><title>Research Toolkit</title></head>
<body><main>
<header><div class="eyebrow">RESEARCH STACK TOOLKIT <span id="version"></span></div><h1>Your research, easier to manage.</h1>
<p>Set up your local research tools, verify reading, and manage your components.</p></header>
<section class="context" aria-label="Workspace context"><span id="workspace"></span><span id="trust"></span></section>
<section aria-labelledby="setup-heading"><h2 id="setup-heading">Component setup for this package</h2>
<p id="setup-summary">Loading the component plan…</p>
<div id="install-plan" class="steps" aria-live="polite"></div>
<div id="install-status" class="install-status" role="group" aria-labelledby="install-status-heading">
<h3 id="install-status-heading">Installation status</h3>
<p id="install-outcome" class="outcome" role="status" aria-live="polite" aria-atomic="true" aria-labelledby="install-status-heading"></p>
<p id="install-meta" class="meta"></p>
<ul id="install-steps" class="attempt-list"></ul>
<p id="install-evidence" class="meta"></p>
<p id="install-problem" class="problem"></p>
<p id="install-tools" class="meta"></p>
<div class="actions"><button id="retry-button">Retry failed component steps</button><button class="secondary" data-action="clearLock">Clear interrupted setup lock</button><button class="secondary" data-action="setupLog" data-readonly="true">Open setup log</button><button class="secondary" data-action="copySetup" data-readonly="true">Copy installation diagnostics</button></div>
</div>
<div class="actions"><button id="setup-button">Set up package components</button><button class="secondary" id="update-button">Update outdated or repaired component steps</button><button class="secondary" data-action="check">Check component status</button><button class="secondary" data-action="status">Refresh component status</button><button class="secondary" data-action="rollback">Roll back managed runtime</button></div>
<p id="setup-progress" role="status"></p>
<p class="check-disclosure">Setup writes only under the reviewed locations named in each step: the managed worker project, the research overlay files, notebooks/analysis and .research-toolkit/store. Your project .venv, source documents and existing MCP configuration are preserved. Steps marked "may download" fetch locked packages through uv. A step that finds different managed files stops instead of overwriting them, and a completed step is not repeated.</p>
<div class="actions"><button class="secondary" data-action="readingCheck">Run MCP reading check</button><button class="secondary" data-action="readDocument">Read selected PDF / DOCX</button></div>
<div id="reading-result" aria-live="polite"></div></section>
<section aria-labelledby="components-heading"><h2 id="components-heading">Installed components &amp; readiness</h2>
<p>The extension is installed. Other tools are checked independently of your package preference. Ready always describes the check shown in that row. Install and Update act on the component step that provides a toolkit component.</p>
<div class="inventory-toolbar"><label for="diagnostics-workspace">Workspace to inspect</label><select id="diagnostics-workspace" aria-label="Workspace to inspect"></select><button data-action="check">Check components</button></div>
<p id="inventory-scope"></p><p class="check-disclosure">Check components inspects toolkit environments and, when installed, starts temporary local MCP servers to verify synthetic PDF/DOCX reading, reports, local search, corpus indexing and record-store rules. Your project environment and research documents are preserved. External services are checked separately. Remote/restricted mode shows editor inventory only.</p>
<label for="component-search" class="sr-only">Find components</label><input id="component-search" type="search" placeholder="Find a component…">
<div id="component-list" class="component-list" aria-live="polite"></div>
<p><button class="secondary" data-action="help">Open onboarding & guide hub</button></p></section>
<section aria-labelledby="package-heading"><h2 id="package-heading">Package preference</h2>
<p>Save your preferred scope. The package decides which component steps setup offers and which tools presets are available. Nothing is installed or removed by choosing a package.</p>
<form id="package-form"><fieldset><legend class="sr-only">Choose a package</legend><div class="packages">
<label class="package"><input type="radio" name="package" value="basic"><span><strong>Basic</strong><span class="description">Read documents and prepare reports.</span><small>Prototype · G1 pending</small></span></label>
<label class="package"><input type="radio" name="package" value="recommended"><span><strong>Recommended Research <em>Default</em></strong><span class="description">Literature metadata, citations, Zotero and notebooks.</span><small>Prototype · G2 pending</small></span></label>
<label class="package"><input type="radio" name="package" value="full"><span><strong>Full</strong><span class="description">Research Lab with corpus index and record store.</span><small>Foundation · G3 pending</small></span></label>
</div></fieldset><div class="form-footer"><button type="submit" id="save-package">Save package preference</button><span id="saved-package"></span></div></form></section>
<section aria-labelledby="preset-heading"><h2 id="preset-heading">Tools preset</h2>
<p>Choose the goal you are working on. The preset decides which tools your assistant is offered: a narrow preset is easier to steer, a wide preset is available when a task genuinely needs it. Nothing is installed or removed.</p>
<form id="preset-form"><fieldset><legend class="sr-only">Choose a tools preset</legend><div id="preset-list" class="presets"></div>
<div class="form-footer"><button type="submit" id="save-preset">Save tools preset</button><button type="button" class="secondary" id="save-preset-workspace">Save for this workspace folder</button><button type="button" class="secondary" id="preset-follow">Follow the package default</button><span id="saved-preset"></span></div></form>
<div id="recent-presets" class="recent" aria-label="Recently used presets"></div>
<details id="preset-details"><summary>Context usage and tools in the selected preset</summary><div id="preset-estimate"></div>
<div class="actions"><button class="secondary" data-action="copyPreset">Copy preset summary</button><button class="secondary" data-action="diagnose">Diagnose tool limit</button></div></details>
<p class="check-disclosure" id="preset-note"></p></section>
<div class="columns"><section aria-labelledby="interface-heading"><h2 id="interface-heading">Interface options</h2>
<label class="option"><input type="checkbox" id="show-status-bar"><span>Show package in the status bar<small>Click it to reopen this panel.</small></span></label>
<label class="option"><input type="checkbox" id="open-on-startup"><span>Open this panel when VS Code starts<small>Off by default. Saved in your current profile.</small></span></label>
<button class="secondary" data-action="settings">Open extension settings</button></section>
<section aria-labelledby="readiness-heading"><h2 id="readiness-heading">Readiness & help</h2><p>Local checks describe detected components. Complete package gates remain open; MCP sessions, kernels and service access need their own first-task checks.</p>
<div class="actions"><button class="secondary" data-action="readiness">Show readiness</button><button class="secondary" data-action="copy">Copy readiness</button><button class="secondary" data-action="diagnose">Diagnose tool limit</button><button class="secondary" data-action="refresh">Refresh</button><button class="secondary" data-action="help">Help & getting started</button></div></section></div>
<p id="feedback" role="status" aria-live="polite"></p><noscript>Enable scripts in this VS Code webview to use the controls.</noscript>
</main><script nonce="${nonce}" src="${resource("controls.js")}"></script></body></html>`;
}

module.exports = { controlPanelHtml, escapeHtml };
