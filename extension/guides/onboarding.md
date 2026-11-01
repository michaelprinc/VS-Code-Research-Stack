# Your first research workspace

Use this walkthrough for a first usable document workflow. The extension supplies the controls and inventory; Python workers and external applications are separate installations. Start with Basic, then add the research tools you need.

## 1. Open the toolkit

Install `research-stack-toolkit-0.3.6.vsix` through **Extensions: Install from VSIX…** and reload VS Code if requested. Click the beaker Activity Bar icon and **Open Control Panel**, or use **Research Toolkit: Open Control Panel**. The top of the panel shows the running extension version. An existing package preference is preserved when upgrading.

Choose **Basic**, **Recommended Research**, or **Full** and click **Save package preference**. This records your intended scope. It does not mean that package was installed. Recommended is the default preference, but Basic is the shortest path to a first document task. Full remains a prototype foundation with several planned integrations.

## 2. See what is already available

Select your intended research folder in **Workspace to inspect** and click **Check components**. With multiple folders open, only the chosen folder is checked. Open **Component setup for this package** to see which steps this package offers and which are already installed. An unrelated project `.venv` (such as WireGuard's Python environment) is preserved and no longer treated as an incomplete toolkit installation. Each row shows installation, actual version, readiness, evidence and the next action to take. Rows the toolkit can install offer **Install** or **Update**.

| Label | Meaning and next step |
|---|---|
| Installed | The running controller, editor registry or Python environment supplied installation evidence. Read the evidence for scope. |
| Files prepared / Configuration present | Source/configuration was found; it is not proof that a runtime or server works. Complete its guide. |
| Ready | The named check succeeded: host running, version command, SDK import or in-memory library test. The row explains what remains untested. |
| Not verified | Perform the guide's first task in the MCP client, notebook or external application. |
| Not detected | No match in the checked host/locations. It can still exist elsewhere or be disabled in this profile. |
| Check failed / Needs attention | Inspect environment setup or configuration using the individual guide, then rerun the check. |
| Planned / Not bundled | This toolkit integration is not implemented or shipped. Selecting Full does not create it. |

Editor inventory is available before a scan and in restricted mode. Explicit trusted-local checks run host version commands and the isolated library probe. If the 0.3.6 managed worker is installed, they also start temporary local MCP servers and test synthetic PDF/DOCX fixtures, reports, source preservation, local search, RIS preparation and a corpus-index → evidence → claim → export round trip, including a staged restore that is not activated. They do not read your research documents or contact providers. Review/trust the workspace and environment before executing installed libraries. Remote/virtual workspaces show editor inventory only.

**Refresh** refreshes displayed preferences/context; **Check components** reruns installation checks. A scan is a timestamped observation kept in this editor session. Recheck after changing environments, installing software or reopening VS Code. Copy readiness includes the current component evidence; review it before sharing.

## 3. Run the component steps your package needs

Install [uv](uv.md), then click **Set up package components** in **Component setup for this package**. Setup starts with a preflight: workspace trust, a local (non-remote) desktop workspace, the host tools the plan needs, the managed paths being real directories rather than links, a writable workspace, and the setup-lock state. Nothing is written or downloaded until that preflight passes, and each failure names the action that clears it. uv is resolved from `researchStack.uvPath`, then absolute `PATH` entries, then the documented install locations for your platform, then the workspace's managed toolkit folder; a uv that does not answer `uv --version`, or that is older than 0.5.0, is reported as unusable rather than as installed. Review the workspace and installation path in the confirmation. Setup copies reviewed worker source and its lock from the VSIX into `.research-toolkit/managed/worker-0.3.6`, then uses uv to create a dedicated Python 3.12 environment. Python and packages may be downloaded; a downloading step may run for `researchStack.setupTimeoutSeconds` (default 900 s, allowed 60–3600 s). You do not need a separate source checkout. Setup does not change your existing project `.venv`, source documents, `.mcp.json`, `.vscode/mcp.json`, assistant instructions or editor extensions.

Setup verifies real stdio MCP discovery; text-bearing PDF and Czech DOCX reading; hashes and locators; Markdown/DOCX report creation; local BM25 search; the Research adapter's local RIS preparation; and, for the Full package, indexing a synthetic source, searching the stored chunks, reopening a hit, resolving and exporting the evidence a claim cites, and staging a restore without activating it. Temporary fixtures and reports are cleaned up. A successful setup produces Ready rows for the steps and tested local capabilities. Version 0.3.6 applies to both this extension and its bundled worker; installed library versions are observed independently.

The plan is ordered and honest about prerequisites: Basic offers the worker step; Recommended Research adds the reviewed research overlay and the optional locked `notebooks/analysis` environment; Full adds the workspace corpus index and record store. A step that needs another step pulls its prerequisite in and says why, instead of failing the click. Each completed step is recorded in `.research-toolkit/managed/worker-0.3.6/installation.json`, so a cancelled or failed run resumes at the first missing step instead of repeating finished work, and **Update or repair component steps** re-runs the steps an earlier toolkit release recorded **and** any recorded step whose produced files are missing. An optional step you did not install is reported as a deliberate omission rather than a failure. A failing step no longer stops the rest of the plan: steps that do not depend on it continue, and its dependents are recorded as blocked with the step that blocked them.

After the run, read the **Installation status** card. It states one verdict — `Installation complete — N component step(s) verified.`, `Installation incomplete — N step(s) verified, M need attention (step ids).`, `Installation failed — <step>: <error>.`, `Setup blocked — <reason>.`, `Setup cancelled — N step(s) already completed were kept.` or `No component setup has run in this workspace yet` — plus a row per step with its status, duration, attempt count, exit code and error, the host tools setup resolved, and the action that clears the failing or blocked step. A complete verdict is only given when the files each step was supposed to produce were re-checked on disk after the run. The card is read from `.research-toolkit/logs/last-setup.json`, so it survives a panel reopen or a window reload, and `.research-toolkit/logs/setup-<timestamp>.jsonl` keeps the append-only attempt log; the bootstrap workspace's `.gitignore` ignores `.research-toolkit/logs/`.

After an interrupted download or setup, use **Retry Failed Component Steps**: it re-runs the steps whose last attempt failed or was blocked, together with their prerequisites, and keeps the work that completed. A timeout, an over-large output or a network-flavoured failure is retried once automatically; a missing executable, a cancellation or an explicit refusal is not. Reviewed source files are reused and existing overlay files (`.github/skills/…`, `research/README.md`, `notebooks/…`) are preserved, never overwritten. A workspace lock blocks competing setup operations. If a crashed setup leaves a lock behind, **Clear Interrupted Setup Lock** removes only a lock classified as stale — older than the setup window, or older than 60 seconds with a dead owner process — and refuses a live one. **Open Setup Log** opens the newest attempt log, and **Copy Installation Diagnostics** copies the verdict, host tools, preflight results, per-step attempts and the log file path to the clipboard. User edits to managed worker sources are preserved and block execution instead of being overwritten. If managed source was edited, move that managed worker directory aside for recovery and rerun setup. Keep a copy of any edits you need.

For the older CLI/manual workflow, obtain the [Research Stack source checkout](https://github.com/michaelprinc/VS-Code-Research-Stack) separately. Its workspace templates remain available:

```text
uv sync --locked --python 3.12
uv run --locked research-stack init "<research folder>"
uv sync --locked --python 3.12 --project "<research folder>/.research-toolkit/worker"
```

These are intentional setup commands, which can download locked dependencies. Use your actual folder in place of `<research folder>`. Python 3.12 must be available to uv; follow its current Python-installation instructions if needed. Review preserved existing configuration instead of overwriting it. Open the resulting research folder in VS Code. It has `papers/`, `notes/`, `outputs/`, source instructions, a profile and a portable MCP configuration.

The older CLI creates `.research-toolkit/worker` and portable configuration. Keep one active definition of a given worker in your client. The extension provider applies to the new managed worker; it does not adopt or rewrite old server definitions. Legacy worker presence remains Not verified until a real invocation is performed.

## 4. Complete one document task

Click **Run MCP reading check** to repeat the synthetic protocol test. Then click **Read selected PDF / DOCX** and choose a small text-bearing source inside the selected workspace. The tool reads the first five pages/paragraphs through the actual worker, checks its hash and unchanged source bytes, and shows locators, warnings and a text preview. No account is needed for these GUI checks. Outside-workspace documents and links resolving outside it are refused. Blank/scanned PDFs fail the text check and point to separate OCR.

For assistant use, open **MCP: List Servers** and choose **Research Toolkit <workspace>: Basic documents & local search**. The extension supplies the Python executable, arguments and workspace scope through VS Code's provider; your existing MCP files need no edits. Complete your assistant client's authentication, policy and tool authorization separately. Disable an older duplicate document-worker definition before using the new provider if you previously configured one manually.

Ask the client to call **read_document** on the selected workspace-relative path with a small range. Check returned page/paragraph locators and source hash. Then call **write_markdown** or **write_docx** using a new path under `outputs/` and source references. Open the report and compare its evidence to the source. The worker preserves source files and refuses to overwrite an existing output. Scanned PDFs need separate OCR.

The worker's Ready row now records the timestamped real MCP fixture test. It proves the local protocol and document workflow; it does not prove that an assistant account or organization permits invocation. Selected-document previews are displayed locally and are not included in Copy readiness. See [MCP configuration](mcp-config.md), [PDF](pypdf.md), [Word](python-docx.md) and [worker](document-worker.md) for troubleshooting.

## 5. Choose a tools preset for the task

Assistant clients cap how many tools one session may enable — Copilot agent mode refuses more than **128 enabled tools** — and tool selection becomes less reliable well before that, around 30–50 tools. Under **Tools preset** choose the goal you are working on instead of a server:

| Goal | Preset | Toolkit tools |
|---|---|---|
| Read one PDF/DOCX and write a cited report | Read and cite a document | 4 |
| Find passages in your own notes | Search my own notes | 3 |
| Check a DOI and compare references | Verify a citation | 2 |
| Collect references and prepare a RIS import | Prepare a Zotero import | 5 |
| Read, search, cite and write in one session | Read, search, cite and write | 10 |
| Read → index → retrieve → resolve evidence → record a claim → report (Full default) | Full research workflow (index, evidence, claims) | 11 |
| Toolkit plus GitHub and Playwright servers | Documents, citations and third-party evidence | 10 (+36 estimated external) |
| Widest supported surface under the ceiling | Maximum research lab (128-tool budget) | 10 (+91 estimated external) |
| Index your own notes and keep claims linked to evidence | Index, search and record claims (Full only) | 10 |

Basic offers the first two, Recommended Research the first five, and Full all nine. Click **Save tools preset**, then open **Context usage and tools in the selected preset** to see the tool count, the headroom under the 128-tool ceiling, and the estimated size of the tool definitions in the model's context. No preset ships more than 12 toolkit tools, and the widest preset keeps at least 20 tools of headroom for servers you add yourself. After **Set up package components** the toolkit part is measured from the worker's real tool schemas; servers you configure yourself stay labelled as vendor estimates.

The saved preset reaches the managed workers as `RESEARCH_STACK_TOOL_PRESET`. Only the tools that serve the goal are registered, and a server whose tools the goal does not use is not offered at all. A preset the selected package does not offer falls back to that package's default preset and the panel says so. Changing a preset installs and removes nothing. If you configure the workers by hand instead of using the extension's servers, the same gating is available through `RESEARCH_STACK_TOOL_PRESET` — see [Workspace MCP configuration](mcp-config.md).

## 6. Add the corpus index and record store (Full)

Run the **Corpus index and record store** step. The Full package's default preset, **Full research workflow (index, evidence, claims)**, already carries the journey verbs; **Index, search and record claims** adds the rest of the store surface. The toolkit creates `.research-toolkit/store/research.sqlite3` in the selected workspace and serves nine verbs from one server: `index_corpus`, `unindex_corpus`, `search_corpus`, `evidence_read`, `claims_read`, `claims_write`, `claims_export`, `store_status` and `store_maintenance`. Start with one file you own: index `notes/your-notes.md`, search a phrase you expect, reopen the passage with `read_text_source`, write a claim linked to the chunk id the search returned, read it back, and export it as a validated report reference. A claim cannot be linked to a chunk id that is not in the index. Re-indexing or un-indexing a source never deletes evidence a stored claim still cites: the link stays resolvable and is flagged `stale`. `store_maintenance` refuses a vacuum until you confirm it after reviewing `store_status`, and a restore is staged as a validated candidate before it is activated. Source files are read only. There is no vector search, embedding model or third-party database in this slice. See the [corpus index](research-corpus-index.md) and [record store](research-record-store.md) guides.

## 7. Add research capabilities gradually

Local setup includes **Research Toolkit <workspace>: Research metadata & RIS** in the provider. Its discovery/local RIS test is Ready after setup. Read the [adapter guide](research-stack-recommended-adapter.md) and individual [Crossref](crossref-rest-api.md), [OpenAlex](openalex-rest-api.md) and [Semantic Scholar](semantic-scholar-academic-graph.md) guides before a provider call. Provider connectivity, quotas, accounts and policy stay Not verified because the local check sends no network queries. Start with a small known-DOI lookup and verify attribution. The older `add-recommended` CLI overlay is optional if you want its research skills and notebook templates.

For bibliography work, install/configure [Zotero](zotero-local-api.md) separately and review its version-specific local API access. For notebooks, install the [Python](vscode-python-extension.md) and [Jupyter](vscode-jupyter-extension.md) editor integrations, sync the [analysis environment](research-analysis-python-environment.md), select its kernel and verify `sys.executable` with one intentional cell. A visible editor extension does not prove its kernel or account works.

Keep optional [GitHub remote MCP](github-remote-mcp.md) and [NotebookLM handoff](notebooklm.md) separate from local document readiness. Qdrant, DuckDB, embeddings, browser and institutional integrations remain planned. The GUI overview explains their purpose without presenting them as installed. The SQLite store in this release is the toolkit's own implementation, not DuckDB.

## 8. Find current instructions quickly

Use **Guide** for the component's local setup, first task and troubleshooting; use **Latest docs** for the maintained official source. The guide hub is assembled from individual guides and registry entries. Bundled text is a reviewed release snapshot, not a live mirror. Official stable/latest docs may cover a newer release than your installed lock, so check version compatibility before adopting a new feature or upgrading. No guide updates or downloads occur silently.

[Browse every component guide](index.md) · [Toolkit controls](toolkit.md)
