# Research Stack Toolkit

Research Stack Toolkit helps you set up a research workspace in VS Code. Use its control panel to install the components your chosen package needs, check their readiness, and give your assistant a focused set of research tools.

**Version 0.3.13 · Phase 4 Preview**

## What you can do

- **Read and cite sources:** extract text from workspace PDF and DOCX files, search local notes, and create Markdown or DOCX reports.
- **Find and check references:** search scholarly metadata, check citations, and prepare a validated RIS file for Zotero.
- **Work with Zotero:** read your local library and, with a separately authorized key and confirmation, preview and apply supported changes.
- **Build a research record:** with the Full package, index selected sources, search passages, and record claims with evidence links.
- **Manage your setup:** inspect component status, repair or update managed components, and select a tool preset for the task at hand.

Start with the [onboarding walkthrough](guides/onboarding.md) or browse the [component guide hub](guides/index.md).

## Get started

1. Build the 0.3.13 package from `extension/` (see [Build and verify](#build-and-verify)) and install it with **Extensions: Install from VSIX...**. The extension is **not yet published on the Marketplace**: a read-only Marketplace query for this publisher returns no extensions, so there is nothing to install from there yet.
2. Open a trusted local workspace in VS Code. Select the **Research Toolkit** beaker in the Activity Bar and open the control panel. You can also run **Research Toolkit: Open Control Panel** from the Command Palette.
3. Choose the workspace folder and a package, then select **Check components**. Review the component setup plan and select **Set up package components**.
4. Read **Installation status** for the result and any next action. If setup cannot find `uv`, install it or set its absolute path in `researchStack.uvPath`.
5. Choose a **Tools preset** for your goal. Try **Read selected PDF / DOCX**, or open a component guide for its first task.

Selecting a package or preset saves a preference; it does not install components. Setup runs when you start it. It checks workspace trust, required host tools and managed paths before running component commands. The worker and optional notebook setup may download locked dependencies. Completed steps are recorded so a later run can resume.

## Choose a package

| Package | Included setup |
|---|---|
| **Basic** | Isolated document worker for reading, local search and reports. |
| **Recommended Research** | Basic, a research overlay and scholarly metadata/Zotero tools; an analysis notebook environment is optional. |
| **Full** | Recommended Research plus a workspace corpus index and SQLite research record store; the notebook environment remains optional. |

Presets offer a smaller set of tools suited to a task, such as reading a document or preparing a Zotero import. Availability depends on the package. The panel shows the selected and applied preset, tool counts and the basis of its context estimate. Each preset offers at most 12 toolkit tools.

## Zotero and Semantic Scholar

Open **Integrations & Accounts** in the control panel to configure these services and check their readiness. Decisions are kept in your VS Code profile; installation, authorization and current readiness are reported separately.

### Zotero

For local reading, start Zotero and enable **Settings → Advanced → Allow other applications on this computer to communicate with Zotero**. Reading uses Zotero's local API and needs no write key. If a check fails, the panel reports the response where available. Zotero may take time to answer while its library loads; another program holding port 23119 can also prevent it from listening.

Version 0.3.13 provides `zotero_library` for status, collections, items, search, indexed full text and supported exports. `prepare_zotero_import` validates generated RIS before writing it. Importing that file is a separate action in Zotero.

For supported writes, select the **Zotero handoff** preset and use **Research Toolkit: Store the Zotero Write Key** to store a key issued by Zotero. `zotero_write` provides a preview that sends no write; applying a change requires the key and the explicit confirmation `write-to-zotero`. Before changes, the worker saves a bounded snapshot of library data read through the local API, journals replaced values, and uses version guards to refuse conflicts. The snapshot can be truncated and is not a copy of the Zotero database or a complete backup. Delete, merge and duplicate checking are not supported. Keys are kept in VS Code secret storage.

The write path has been tested against an emulated Zotero server, but **a Toolkit write to a real Zotero library has not yet been verified**. See the [changelog](CHANGELOG.md) for details and evidence limits.

### Semantic Scholar

Review the provider's API licence before activating the integration. Anonymous access is available after activation; a key is optional and can be added later. The Toolkit does not accept provider terms for you. Check readiness from the panel when needed.

## Manage and troubleshoot

- **Installation status** shows the last setup outcome and any blocked or failed step. Use **Retry failed component steps** to retry with prerequisites, or **Update outdated or repaired component steps** to repair missing managed files.
- **Check component status** runs bounded checks. **Refresh component status** rechecks recorded files without running the functional MCP reading check. An installed component is not necessarily ready for every task.
- **Open setup log** and **Copy installation diagnostics** help investigate setup problems. **Roll back managed runtime** verifies an earlier managed runtime before selecting it.
- For Full, **Index selected PDF / DOCX / text sources** indexes selected workspace sources; **Verify source freshness** checks indexed files against their present contents. Partial or failed extraction is not silently accepted by the panel.
- Use a component's **Guide** for setup and troubleshooting, or **Latest docs** for its maintained official documentation.

## Data and privacy

Managed runtimes, setup records and logs, the research store, and Zotero snapshots and journals are kept under `.research-toolkit/` in the workspace. The research overlay and optional notebook setup can also create files in the workspace; existing overlay files are preserved.

The worker also stores a shared request budget, a bounded provider-response cache and Zotero installation facts under `research-stack-toolkit/` in your operating system's user application-data directory: `%LOCALAPPDATA%\research-stack-toolkit\` on Windows, `~/Library/Application Support/research-stack-toolkit/` on macOS and `$XDG_DATA_HOME` or `~/.local/share/research-stack-toolkit/` on Linux. If that directory cannot be resolved, it reports a temporary-directory fallback. Integration consent is stored in the VS Code profile, and API keys are stored in VS Code secret storage. The shared files do not contain keys or workspace paths.

The extension can check the Marketplace for updates; `researchStack.checkForUpdates` controls that check. The problem-report command lets you review a redacted report before opening a draft in your mail application. See the [changelog](CHANGELOG.md) for release-specific behavior.

## Preview limitations

This is a preview. G1–G4 remain open; successful local checks do not close those gates. The 0.3.13 Zotero work was tested with an emulated server and MCP transport, while the operator's real-host brief provides limited observations from one Zotero library and no Toolkit write receipt. Reference-host installation, Extension Host and rendered-window receipts remain outstanding. Vector search, embeddings, DuckDB/Qdrant integration and notebook kernel setup are not provided by the current Full package. Scanned documents need OCR outside the Toolkit.

The package is a local deliverable. It is not published on the Marketplace, and the **Maximum research lab** preset registers 9 toolkit tools plus 91 external tools counted from their vendors' documentation (GitHub default 52, Playwright core 24, Zotero community 15) — 100 of the 128-tool client ceiling, 28 tools of headroom. Those external counts are the vendors' documented figures, not measurements taken here.

## Licence

The toolkit is under the MIT licence recorded in the `LICENSE` file at the root of its source repository. The `document-corpus-bridge` topic skill bundle is toolkit-authored and covered by it. The `theological-research` bundle is the work of s. Denisa and Michal and carries its own MIT licence inside the bundle — `bundles/theological-research/LICENSE`, `Copyright (c) 2026 s. Denisa + Michael`, with `license: MIT` in the skill's frontmatter — so both bundles are publishable. Publication is still gated on the open gates G1–G4, not on a licence.

## Build and verify

From `extension/`, run `npm ci`, `npm test`, `npm run package`, `npm run verify-package` and `npm run check:payload`. The repository also contains Extension Host, panel and browser checks; see `package.json` and the [guide maintenance notes](guides/maintenance.md). Release history is in the [changelog](CHANGELOG.md).
