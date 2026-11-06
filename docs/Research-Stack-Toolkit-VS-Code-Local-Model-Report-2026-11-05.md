# Research Stack Toolkit: VS Code and local-model field report

**Date:** 5 November 2026, Europe/Prague  
**Scope:** hands-on Windows VS Code inspection, synthetic Toolkit MCP check, and attempted Copilot interaction with the selected local model.  
**Result:** The Toolkit control panel and internal synthetic MCP check worked. The initial Copilot prompts were cancelled without answers; a later focused retry successfully used Qwen and the Toolkit Markdown-reading tool. See the retest section for the tool configuration changes and correction about the separate local provider endpoint.

## Environment and boundaries

- VS Code Desktop 1.145.0 x64; Toolkit extension `michaelprinc.research-stack-toolkit` 0.3.8 running in the Extension Host; Copilot Chat reported 0.73.0; Local Model Provider 1.1.3. The installed extension version was checked using the VS Code CLI and the panel. The local VSIX is 0.3.8, SHA-256 `fd42c2aab0977219fae44a24c2a697e0a4fb762aedad3baf1340e1d43967bdd2`; this does not independently prove the installed files match that VSIX.
- VS Code showed model identifier `qwen3.8-flash-next-iq3_xxs`, maximum context 240K, and Local Model Provider server `http://127.0.0.1:8197`. These are UI configuration labels; the active server and actual loaded model were not verified.
- The Toolkit source checkout inspected was commit `2e2ce9a`. The Toolkit project opened in a new window in Restricted Mode; its chat model and some extension features were unavailable there. Tests therefore used the already trusted workspace, with synthetic fixtures and prompts that requested no access to its documents. No workspace trust or service settings were changed.
- The panel's setup and inventory statements are scoped to that trusted workspace, not to every workspace on the machine. Times shown here use Prague local time. A pre-existing setup receipt was inspected, not a new installation.

## Observed tests

| Test | Result and evidence | Interpretation |
| --- | --- | --- |
| Open control panel from status bar | Passed: panel displayed Toolkit 0.3.8, trusted workspace, package controls, setup and inventory. | UI loaded in the real VS Code host. |
| Existing Full setup | Panel reported **4 of 4 steps installed**, including optional notebook environment; **G3 not passed**. Worker, overlay, notebook and SQLite store receipts were shown, recorded 4 November. | A receipt is installation evidence for these steps, not proof of every workflow or package gate. No setup was run for this report. |
| Run MCP reading check | Passed according to the panel: synthetic PDF/DOCX reading, source hashes and locators, reports, local search and RIS preparation. Its inventory also reported synthetic corpus indexing and stored-corpus search, one chunk and a fingerprint. Last check displayed 5 November at 20:56:30. | These are real local stdio MCP fixture checks launched by the Toolkit, separate from Copilot model tool invocation. External providers were not checked. |
| Copilot Agent synthetic prompt | No model answer before cancellation. Chat presented authentication for `evalstate/hf-mcp-server` and `huggingface/hf-mcp-server`; it also warned: **“The model only supports 128 tools, 82 tools were not provided to the model.”** | The Agent session's total available tool surface exceeded the limit. The omitted tool identities were not established; do not assume the Toolkit tools were among them or available to the model. No authentication was attempted. |
| Copilot Ask synthetic prompt | After switching to Ask and requesting one sentence without tools or files, chat remained at “Analyzing” and produced no answer during the observation; the request was cancelled. | Local inference through Copilot is unverified. This was not a latency benchmark and no model output was evaluated. |
| Local provider reachability | A local GET to `http://127.0.0.1:8197/v1/models` failed with connection refused; no listener on port 8197 appeared in the local listen inventory at that time. | The configured endpoint was unreachable at that moment. This endpoint belongs to the separate Local Model Provider extension; the selected model was later confirmed as Custom Endpoint/Strata (secured local). The refused connection does not establish the cause of the earlier stalled request. A Strata process was present, but process presence does not prove the model endpoint was serving. |

The synthetic requests asked the model not to read files or use tools. The Agent session did nevertheless initiate its configured MCP discovery/authentication flow, demonstrating why tool configuration matters even for a simple request. The authentication prompt and 128-tool warning were observed in VS Code; no third-party login was performed. The UI's existing chat session remains available for inspection.

## Available Toolkit features and their verification status

| Area | Available behavior | What this test establishes |
| --- | --- | --- |
| Setup and repair | Package-dependent component plan; explicit setup, component status checks, repair/update, retry, setup logs, diagnostics, stale-lock handling and managed-runtime rollback. | Controls and existing 4/4 receipt visible. Installation, repair, rollback and lock clearing were not exercised. |
| Packages | Basic for reading/reporting; Recommended Research adds research overlay and optional notebook environment; Full adds corpus index and SQLite research store. Preferences select scope; selecting one does not itself install components. | Full was selected and visible. G3 remains open; G1/G2 are also documented as pending. Package switching was not tested. |
| Documents | Read bounded PDF/DOCX/Markdown text with source hashes and locators; produce Markdown or DOCX reports. | Synthetic protocol check passed for PDF/DOCX, hashes/locators and reports. No user document or model-authored report was tested. OCR is separate. |
| Local text search | Search selected Markdown/text using a lexical BM25 prototype and reopen passages with provenance. | Panel reported a fixture search passed; not a test of real-world corpus relevance or assistant use. |
| Corpus and claims | Full offers persistent indexing/search, evidence resolution, claims and evidence links, exports and maintenance through a SQLite schema-2 store. | Synthetic indexing/search reported passed. Existing workspace store was present, but its inventory status was **Not verified** and its contents were not inspected. Claim write/export and maintenance were not manually tested. |
| Metadata and bibliography | Citation comparison/DOI resolution, scholarly provider adapters, Zotero reading and preparation of RIS for manual import. | Synthetic local RIS preparation passed. Crossref, OpenAlex, Semantic Scholar, Zotero connectivity, account access and actual import were not tested. |
| Notebook support | Optional locked Python 3.12 notebook environment with `ipykernel` and `matplotlib`. | Receipt reported Python 3.12.13 and successful imports; panel marked kernel operation **Not verified**. No notebook cell was executed. |
| Component inventory and guides | Detect versions/readiness, search components, access bundled guides and official documentation links. | Panel inventory rendered and supplied version/status evidence; guide links and every component action were not individually exercised. |
| Presets | Goal-shaped tool surfaces and estimated context cost, selectable independently of package installation. | All nine Full choices were visible. The saved preset was “Documents, citations and third-party evidence”: panel estimated 10 Toolkit + 36 external tools and about 24.5k tokens/request. This is a preset estimate, not the actual total enabled in Copilot. |
| Planned/external | Vector search, embeddings, Qdrant, DuckDB, institutional adapters and the Toolkit's Playwright integration were marked planned/not bundled; external GitHub and service integrations need separate setup. | Not tested. The existence of separate editor MCP servers does not mean these integrations are bundled or working. |

The inventory also reported `uv` 0.11.23, Python MCP SDK 2.2.0, pypdf 6.4.1, and the running Toolkit worker 0.3.8. These status checks have their own scopes: an SDK import is not proof of editor authorization, and a configured MCP provider is not proof of a running authorized chat session.

## Preset comparison

The panel and bundled README describe these counts; external counts and token costs are estimates, and enabled tools from other extensions or MCP configurations can add to the real session total.

| Preset | Toolkit tools | Estimated external tools | Intended use |
| --- | ---: | ---: | --- |
| Read and cite a document | 4 | 0 | One document and cited output |
| Search my own notes | 3 | 0 | Selected local text search |
| Verify a citation | 2 | 0 | DOI and reference comparison |
| Prepare a Zotero import | 5 | 0 | References and reviewed RIS |
| Read, search, cite and write | 10 | 0 | Documents and metadata |
| Full research workflow | 11 | 0 | Read, index, evidence, claims and report |
| Documents, citations and third-party evidence | 10 | 36 | Document tools plus estimated GitHub/Playwright surface |
| Maximum research lab | 10 | 91 | Broadest documented surface |
| Index, search and record claims | 10 | 0 | Corpus and evidence-linked claims |

The observed warning shows that the saved preset's 46-tool estimate did not describe the complete Copilot session: VS Code reported 82 tools omitted beyond 128. The test did not determine exactly which configured sources contributed or whether the saved preset was actually applied to each running server. The panel's “46 tools … well inside” message should therefore be read as a preset-level estimate, not a guarantee that the whole editor session stays under the limit.

## Recommended retest

1. Inspect the Local Model Provider's actual server configuration and the live Strata/model endpoint; restore the intended endpoint through the user's normal controls. A process running is not sufficient: verify the endpoint responds and identifies the intended model. Any service interruption should be separately authorized.
2. In a suitable trusted test workspace containing only synthetic data, start a fresh Copilot Ask chat and verify a short answer with the selected model. Record response and time; then test a Czech sentence and a small reasoning task.
3. In Agent mode, inspect **Configure Tools**, disable unrelated toolsets for the test, and verify the resulting actual enabled count is below the client limit. Select a narrow Toolkit preset appropriate to the task; verify both its saved and applied states. Resolve external authentication only if that service is needed.
4. Run a small end-to-end task: read a synthetic PDF or Markdown file using an identified Toolkit MCP tool, cite the returned locator/hash, and produce a report. Inspect the tool call and output. Then separately test corpus indexing, retrieval, evidence and claims with disposable fixtures if Full is the goal.
5. Separately check notebook kernel execution, external metadata/Zotero access, and relevant package gates. Keep those results distinct from the internal synthetic check.


## Retest and tool-limit investigation — 5 November, 21:05–21:08

**Result: passed for one focused Markdown-reading workflow.** In a fresh VS Code Copilot Agent chat, the selected `Custom Endpoint/Strata (secured local)/qwen3.8-flash-next-iq3_xxs` called the Toolkit's **Read a workspace Markdown or text source** MCP tool on a new synthetic fixture. VS Code showed the call completed with input `toolkit-synthetic-test-2026-11-05/source.md`. The final answer correctly reported 12 shaded and 18 sunlit seedlings, seven days, the three paragraph locators and the absence of a causal conclusion. Its SHA-256 `52e938ab9c279cf0b6e5b50103baeb94c446f802928d48fa70b16d1f496d1ee9` matched the independently computed file hash. The chat showed completion in 1 minute 27 seconds and reported 91,096 input and 499 output tokens; these are UI-reported totals, not a controlled token-cost measurement. No 128-tool or Hugging Face authentication warning appeared in that new chat. This is one successful case, not an exhaustive evaluation of other tools or the model.

**Correction to the original endpoint interpretation:** the `127.0.0.1:8197` status item belongs to the separate `krevas.local-model-provider` extension. The chat response identifies the actual selected model as a different Custom Endpoint/Strata secured-local provider. Port 8197 refused a connection on both attempts, but that does not diagnose the selected provider or explain the earlier cancellation. The earlier 48-second Ask request was stopped too soon to rule out a working slower response; the successful retest took longer. Strata was not restarted or reconfigured.

### Why the earlier session exceeded the limit

Copilot's own tool manager showed independent enabled MCP registrations in addition to Toolkit servers. The earlier warning said 82 tools were omitted beyond 128, implying 210 candidates in that request as reported by the UI. This is a session-specific count; exact counts per server and which tools were omitted were not captured. The Toolkit panel's 46 is a preset-level estimate, not a complete inventory of all editor/agent sources. Copilot also displayed enabled built-ins: 17 Copilot, 5 VS Code, 4 Tasks and Problems, 10 Integrated Browser and 5 Jupyter Notebook tools, plus extension tools. These counts cannot simply be added to the earlier 210 without a contemporaneous complete enumeration.

The manager showed the Toolkit's **Basic documents & local search** and **Research metadata & RIS** servers running and enabled. Expanding the Basic server displayed five tool entries: read PDF/DOCX, read Markdown/text, search selected notes, and write cited DOCX and Markdown reports. The saved workspace preset remained **Documents, citations and third-party evidence**; it was not changed. A user-level setting also named `research-lab`, so the panel's workspace-effective state should not be confused with the global setting. Neither the preset estimate nor the tool-manager group list independently establishes a complete actual per-request tool count.

### Changes made for the focused test

In Copilot Customizations → Tools, these previously enabled independent servers were switched off: `evalstate/hf-mcp-server`, `huggingface/hf-mcp-server`, `gcp-vm-ssh`, `github/github-mcp-server`, `github-mcp-server`, `io.github.ChromeDevTools/chrome-devtools-mcp`, `microsoft/markitdown`, `microsoftdocs/mcp`, and `pylance mcp server`. The manager explicitly labeled each **Disabled (Globally)**. This can affect other Copilot chats; re-enable any needed server in the same manager. The Toolkit servers were left enabled, as were the built-in and extension tool groups. No MCP configuration was deleted and no Toolkit package or preset changed. The test fixture remains at `toolkit-synthetic-test-2026-11-05/source.md` in the trusted workspace, containing fictional non-sensitive data.

The missing warning and successful tool call show that this focused request proceeded without the previously observed limit problem; they do not prove an exact current total or that every future chat will remain under 128. The large reported input total also warrants further inspection of chat instructions, other enabled built-ins and context if performance matters.
## Sources and evidence

- Live VS Code control panel, status bar, chat prompts, warning and local connection check described above; screenshots were inspected during the session but not saved as separate evidence files.
- [Extension README](../extension/README.md): feature descriptions, presets, setup and preview scope.
- [0.3.8 release evidence](../evidence/quality-v0.3.8-2026-11-04/README.md): earlier Linux-based automated and package results. Those results are historical and are not represented as tests run in this session.
- [Toolkit project README](../README.md).

This report is a field assessment, not an exhaustive acceptance test. The retest establishes one successful Qwen response and Toolkit tool call; external service access and completion of the Toolkit research gates remain unverified.


