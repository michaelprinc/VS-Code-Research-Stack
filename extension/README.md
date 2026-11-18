# Research Stack Toolkit

Research Stack Toolkit helps you set up a research workspace in VS Code. Use its control panel to install the components your chosen package needs, check their readiness, and give your assistant a focused set of research tools.

> **Public preview:** This release is experimental. Gates G1–G4 remain open and the complete onboarding, Copilot, external-provider and data-recovery workflows have not been accepted. Back up your research documents and configuration before trying setup or indexing. Validate citations against their sources. Report problems through the extension or the links below.

Requires VS Code Desktop 1.140.0 or later. Version 1.145.2 was tested with an isolated Windows Extension Host; the minimum version, other platforms, remote hosts and a live Copilot workflow remain unverified. Some components require separately installed software, accounts, provider terms or internet access. Qdrant, a CPU embedding model, DuckDB, Playwright and institutional adapters are planned rather than implemented (`kind: "planned"` in `components.json`); the vector and hybrid retrieval the Full store gained in 0.3.14 is the Toolkit's own dependency-free lexical-signature ranker, described below, and it installs no model and no vector database. See [SUPPORT.md](SUPPORT.md) and [SECURITY.md](SECURITY.md) for how to report a problem or a vulnerability.

**Version 0.3.14 · Phase 4 Preview**

## What you can do

- **Read and cite sources:** extract text from workspace PDF and DOCX files, search local notes, and create Markdown or DOCX reports.
- **Find and check references:** search scholarly metadata, check citations, and prepare a validated RIS file for Zotero.
- **Work with Zotero:** read your local library and, with a separately authorized key and confirmation, preview and apply supported changes.
- **Build a research record:** with the Full package, index selected sources, search that index by exact terms (`lexical`), by the Toolkit's own retrieval vectors (`vector`), or with both fused (`hybrid`), and record claims with evidence links.
- **Manage your setup:** inspect component status, repair or update managed components, and select a tool preset for the task at hand.

Start with the [onboarding walkthrough](guides/onboarding.md) or browse the [component guide hub](guides/index.md).

## Get started

1. Build the 0.3.14 package from `extension/` (see [Build and verify](#build-and-verify)) and install it with **Extensions: Install from VSIX...**. The extension is **not yet published on the Marketplace**: a read-only Marketplace query for this publisher returns no extensions, so there is nothing to install from there yet.
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

Presets offer a smaller set of tools suited to a task, such as reading a document or preparing a Zotero import. Availability depends on the package. The panel shows the selected and applied preset, tool counts and the basis of its context estimate. Each preset offers at most **20** toolkit tools — the ceiling 0.3.14 raised from 12 — and a third-party part of a preset names the exact tools it selects rather than a vendor's estimate of how many a server might have.

**The presets 0.3.14 offers.** Ten presets are offered — `Read and cite a document`, `Search my own notes`, `Verify a citation`, `Prepare a Zotero import`, `Read, search, cite and write`, `Full research workflow (index, evidence, claims)` at 15 tools, `Index, search and record claims` at 12, and three max presets: **Maximum research: GitHub full plus the whole store** (16 Toolkit tools + 92 named GitHub tools = 108 of the 128-tool client ceiling, 20 tools of headroom), **Maximum research: GitHub as read-only evidence** (20 + 42 named read-only GitHub tools = 62, 66 tools of headroom) and **Maximum research: the whole local store, no GitHub** (20 Toolkit tools, no third-party surface). Each one names the tools it leaves out. `extension/presets.json` declares **12** preset ids in total: the ten offered plus the two retired ones below. `Documents + third-party evidence` and `Maximum research lab` are **retired**: a saved preference for either still resolves and the panel names the preset that replaces it, but no package offers them any more. Every GitHub figure above is a count of the tool names published in the vendor's catalog, not a measurement taken here — no GitHub MCP server was started on the build host, so the counts still need a `tools/list` on a real host.

**Configure Preset Tools for Copilot** is an explicit command, never part of setup. It writes the selected preset's exact GitHub tool list into the workspace `.mcp.json` that the Copilot harness reads, keeps a copy of the content it replaced, refuses to overwrite a `github` entry this Toolkit did not write, and refuses the older `.vscode/mcp.json` shape because that shape has no field for a tool list. It writes no credential: the token appears only as the environment reference `${GITHUB_PERSONAL_ACCESS_TOKEN}`. A preset that selects no GitHub surface says so and writes nothing. Whether a Copilot client then honours that file has not been verified on a real host here, and a read-only tool list is a filter on what a server offers — what your token may do is decided by GitHub, not by this Toolkit.

## Retrieval in the Full store (0.3.14)

`search_corpus` answers in three modes: `lexical` (the BM25 path shipped since 0.3.4, unchanged in ranking and in the shape of a hit), `vector`, and `hybrid`. The vectors are computed on CPU by the Toolkit's own backend — `rsk-hashing-v1`, 256 dimensions, word tokens plus character 3- and 4-grams — from the chunk text the store already holds: no model download, no network call, no new dependency, no third-party database. It is a **lexical signature, not a semantic model**: it reaches `iluminacích` from `iluminace`, and it does not know that "pilgrimage" and "journey" are the same idea. A vector is only used when its backend, its dimensions and the text it was made from all match what this backend computes today; otherwise it is reported as stale and the Toolkit refuses instead of ranking by a vector whose origin it cannot prove. Hybrid hits carry the rank and score of both rankers and the fusion rule they were scored by. **Run Research Toolkit's `embed_corpus`** (or re-run it after a backend change) to build the vectors: a store that predates 0.3.14 keeps every chunk and every claim link it had, but has no vectors, so `vector` and `hybrid` refuse until that verb has run. `store_status` and `.research-toolkit/lab-state.json` report the retrieval state as `not-built`, `partial`, `stale` or `ready`.

## Zotero and Semantic Scholar

Open **Integrations & Accounts** in the control panel to configure these services and check their readiness. Decisions are kept in your VS Code profile; installation, authorization and current readiness are reported separately.

### Zotero

For local reading, start Zotero and enable **Settings → Advanced → Allow other applications on this computer to communicate with Zotero**. Reading uses Zotero's local API and needs no write key. If a check fails, the panel reports the response where available. Zotero may take time to answer while its library loads; another program holding port 23119 can also prevent it from listening.

Version 0.3.13 introduced `zotero_library` for status, collections, items, search, indexed full text and supported exports, and 0.3.14 leaves that surface as it was. `prepare_zotero_import` validates generated RIS before writing it. Importing that file is a separate action in Zotero.

For supported writes, select the **Zotero handoff** preset and use **Research Toolkit: Store the Zotero Write Key** to store a key issued by Zotero. `zotero_write` provides a preview that sends no write; applying a change requires the key and the explicit confirmation `write-to-zotero`. Before changes, the worker saves a bounded snapshot of library data read through the local API, journals replaced values, and uses version guards to refuse conflicts. The snapshot can be truncated and is not a copy of the Zotero database or a complete backup. Delete, merge and duplicate checking are not supported. Keys are kept in VS Code secret storage.

The write path has been tested against an emulated Zotero server, but **a Toolkit write to a real Zotero library has not yet been verified**. See the [changelog](CHANGELOG.md) for details and evidence limits.

### Semantic Scholar

Review the provider's API licence before activating the integration. Anonymous access is available after activation; a key is optional and can be added later. The Toolkit does not accept provider terms for you. Check readiness from the panel when needed.

## Manage and troubleshoot

- **Installation status** shows the last setup outcome and any blocked or failed step. Use **Retry failed component steps** to retry with prerequisites, or **Update outdated or repaired component steps** to repair missing managed files.
- **Check component status** runs bounded checks. **Refresh component status** rechecks recorded files without running the functional MCP reading check. An installed component is not necessarily ready for every task.
- **Open setup log** and **Copy installation diagnostics** help investigate setup problems. **Roll back managed runtime** verifies an earlier managed runtime before selecting it.
- For Full, **Index selected PDF / DOCX / text sources** indexes selected workspace sources; **Verify source freshness** checks indexed files against their present contents. Partial or failed extraction is not silently accepted by the panel.
- **Topic skill bundles.** **Install Topic Skill Bundle** and **Repair Topic Skill Bundle** never overwrite a file you edited. If you want the reviewed version in place of your edits, **Force Update Topic Skill Bundle (Archive First)** lists every file it would replace and what state each is in, and copies the bytes it replaces into `.research-toolkit/bundles/archive/<bundleId>/<stamp>-<sequence>/` (for example `20261117T205542Z-0001`) before writing anything. **Show Bundle Archive History** lists the archived versions and their absolute paths; **Restore Bundle Archive Version** verifies an archived version, archives what it replaces and writes the older bytes back. Nothing in this design deletes an archive, and no retention limit is applied. The same routes are also buttons in the corpus-and-bundle row of the control panel (`ui.js`): **Force-update topic bundle where a file differs**, **Show bundle archive history**, **Restore an archived bundle version** and **Select the GitHub tools this preset offers Copilot**.
- **Readiness check timing.** `researchStack.integrationTimeoutMs` (default 80 000 ms, allowed 40 000–300 000) bounds how long one Zotero or Semantic Scholar check may run before the Toolkit stops its own worker and reports a timeout; `researchStack.integrationCooldownSeconds` (default 10 s, allowed 5–300 s) is the wait every window of your profile observes before another check starts, and the countdown shown on the card is the same number. A value outside the range is clamped and the clamp is reported. Neither setting makes a service answer sooner, and neither applies to component setup.
- Use a component's **Guide** for setup and troubleshooting, or **Latest docs** for its maintained official documentation.

## Data and privacy

Managed runtimes, setup records and logs, the research store (including the retrieval vectors built for it), Zotero snapshots and journals, and the topic bundle archive with its index and log are kept under `.research-toolkit/` in the workspace. The research overlay and optional notebook setup can also create files in the workspace; existing overlay files are preserved.

The worker also stores a shared request budget, a bounded provider-response cache and Zotero installation facts under `research-stack-toolkit/` in your operating system's user application-data directory: `%LOCALAPPDATA%\research-stack-toolkit\` on Windows, `~/Library/Application Support/research-stack-toolkit/` on macOS and `$XDG_DATA_HOME` or `~/.local/share/research-stack-toolkit/` on Linux. If that directory cannot be resolved, it reports a temporary-directory fallback. Integration consent is stored in the VS Code profile, and API keys are stored in VS Code secret storage. The shared files do not contain keys or workspace paths.

The extension can check the Marketplace for updates; `researchStack.checkForUpdates` controls that check. The problem-report command lets you review a redacted report before opening a draft in your mail application. See the [changelog](CHANGELOG.md) for release-specific behavior.

## Preview limitations

This is a preview. G1–G4 remain open; successful local checks do not close those gates. The 0.3.13 Zotero work was tested with an emulated server and MCP transport, while the operator's real-host brief provides limited observations from one Zotero library and no Toolkit write receipt. Reference-host installation, Extension Host and rendered-window receipts remain outstanding. **Corrected for 0.3.14:** this paragraph used to say that vector search was not provided by the Full package. The Full store now has a dependency-free lexical-signature vector ranker and a hybrid mode (see [Retrieval in the Full store](#retrieval-in-the-full-store-0314)), and it is still not a semantic model, has no benchmarked relevance study or retrieval-quality figures, and does not provide an embedding model, Qdrant, DuckDB or a vector service — those stay `kind: "planned"`. Notebook kernel setup is still not provided. Scanned documents need OCR outside the Toolkit.

The package is a local deliverable. It is not published on the Marketplace. The 0.3.14 artifact has been built and audited on the Linux host that cut the release, and `npm run verify-package` and `npm run check:payload` both report `result: passed` against it. The member count, the byte figures and the hash are recorded in `.agent/QUALITY_STATE.md` and in T15-21 of `specs/phase-15-hybrid-retrieval-presets-bundles/acceptance.md`, not here: this page is inside the payload, so the figures it would quote are the figures this page changes. What has not been produced is a run of this artifact in a real Extension Host on the operator's machine. **Corrected for 0.3.14, kept here where it was written:** this page used to state that the **Maximum research lab** preset registers 9 toolkit tools plus 91 external tools counted from their vendors' documentation (GitHub default 52, Playwright core 24, Zotero community 15) — 100 of the 128-tool client ceiling, 28 tools of headroom. That preset is retired in 0.3.14 and those three figures were vendor estimates for servers this Toolkit never inventoried; the published GitHub toolsets they stood on are 45 names for the default toolsets and 27 in read-only mode. The widest surface 0.3.14 measures is **Maximum research: GitHub full plus the whole store** at **16 Toolkit tools + 92 named GitHub tools = 108** of the 128-tool ceiling, **20 tools of headroom**; the read-only variant is 20 + 42 = 62 (66 tools of headroom) and the no-GitHub variant is 20 tools with 108 tools of headroom. The GitHub figures are counts of the names a preset selects, taken from the vendor's published catalog, and are not measurements taken here: no GitHub MCP server was started on the build host.

## Licence

The toolkit is under the MIT licence recorded in the `LICENSE` file at the root of its source repository. The `document-corpus-bridge` topic skill bundle is toolkit-authored and covered by it. The `theological-research` bundle is the work of s. Denisa and Michal and carries its own MIT licence inside the bundle — `bundles/theological-research/LICENSE`, `Copyright (c) 2026 s. Denisa + Michael`, with `license: MIT` in the skill's frontmatter — so both bundles are publishable. Publication is still gated on the open gates G1–G4, not on a licence.

## Build and verify

From `extension/`, run `npm ci`, `npm test`, `npm run package`, `npm run verify-package` and `npm run check:payload`. The repository also contains Extension Host, panel and browser checks; see `package.json` and the [guide maintenance notes](guides/maintenance.md). Release history is in the [changelog](CHANGELOG.md).
