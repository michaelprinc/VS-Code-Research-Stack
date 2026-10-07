# Source review and decision register

Reviewed: 7 October 2026. Sources below are official documentation or upstream-maintained repositories/model cards. These are documentation findings, not local install or interoperability results. Recheck version-sensitive facts when implementation starts and before each release.

## 1. Host and packaging findings

| Topic | Documentation finding | Consequence for this design |
| --- | --- | --- |
| MCP locations | VS Code documents portable workspace `.mcp.json` with `mcpServers`, native `.vscode/mcp.json` with `servers`, and portable user configuration | Prefer portable export after host validation; retain a tested format adapter for older hosts. [VS Code MCP configuration](https://code.visualstudio.com/docs/agent-customization/mcp-servers) |
| Copilot CLI | CLI reads project portable configuration; it does not directly read `.vscode/mcp.json` | CLI support needs its own parse/launch/trust checks. [GitHub CLI MCP guide](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) |
| MCP provider | An extension can contribute a definition provider and register it with `vscode.lm.registerMcpServerDefinitionProvider` | Prefer runtime resolution for managed mode; pin the tested host minimum. [MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp) |
| Credentials | SecretStorage provides encrypted platform-dependent storage; secrets are not synced | Resolve secrets at launch; portable exports require a separate client mechanism. [VS Code API](https://code.visualstudio.com/api/references/vscode-api#SecretStorage) |
| Skills | Workspace skills use supported directories such as `.github/skills/`; extensions can contribute `chatSkills` | Test discovery and explicit invocation on each advertised host/harness. [Agent skills](https://code.visualstudio.com/docs/agent-customization/agent-skills) |
| Trust | Workspace Trust has an extension support declaration and restricted-mode behavior | Setup and executable operations must check trust. [Extension Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust) |
| Distribution | `vsce package` creates a VSIX; `engines.vscode` declares host compatibility | Build the final installable artifact in Phase 4; validate the declared minimum. [Packaging guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) |
| Extension packs | `extensionPack` groups editor extensions; it is not an external service installer | Use a functional orchestrator, with profile-driven recommendations. [Extension manifest](https://code.visualstudio.com/api/references/extension-manifest) |

The attachment's portable MCP recommendation is supported by the reviewed current documentation. Do not generalize that claim to an untested older VS Code release. The host MCP documentation also describes Windows sandbox limitations and different trust behavior by configuration source; review actual behavior on the selected release rather than promising identical prompts everywhere.

## 2. Scientific tools and service findings

| Topic | Upstream reference | Planning consequence |
| --- | --- | --- |
| GitHub MCP | [Official GitHub MCP server](https://github.com/github/github-mcp-server) | Evaluate official remote route for Basic; constrain offered tools and authorization. Docker is not a Basic prerequisite. |
| PDF extraction | [pypdf extraction documentation](https://pypdf.readthedocs.io/en/stable/user/extract-text.html) | Candidate for text-bearing PDFs; scanned documents need explicit OCR handling and complex layouts need quality flags. |
| DOCX | [python-docx documentation](https://python-docx.readthedocs.io/en/latest/) | Candidate for document reading/authoring; page-layout fidelity is a separate acceptance case. |
| NotebookLM handoff | [Google source import help](https://support.google.com/notebooklm/answer/16215270?hl=en) | Document export and user-mediated upload are sufficient initially. Verify current supported types, limits and product naming during implementation; no assumed consumer automation API. |
| Python environment integration | [VS Code Python environments](https://code.visualstudio.com/docs/python/environments) | Verify the effective selected interpreter; terminal PATH detection is insufficient. |
| Reproducible Python environment | [uv locking and synchronization](https://docs.astral.sh/uv/concepts/projects/sync/) | Evaluate uv as the reference dependency manager; use reviewed locks and wheel availability. |
| Notebook kernel | [IPython kernel installation](https://ipython.readthedocs.io/en/stable/install/kernel_install.html) | Install/register only an owned environment kernel when needed; verify executable identity in VS Code. |
| Zotero | [Local API](https://www.zotero.org/support/dev/web_api/v3/local_api), [Web API basics](https://www.zotero.org/support/dev/web_api/v3/basics) | Prefer enabled loopback local API for reading. Local writes depend on desktop version and authorization; remote credentials are a separate mode. No direct database edits. |
| OpenAlex | [Authentication and budgets](https://help.openalex.org/api/authentication/) | Configure current key/budget behavior; use response metadata and bounded queries rather than historical quota assumptions. |
| Crossref | [REST API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) | Bibliographic validation and DOI agency distinctions; missing Crossref metadata is not proof that a DOI is invalid. |
| Semantic Scholar | [Academic Graph API schema](https://api.semanticscholar.org/api-docs/), [API tutorial](https://webflow.semanticscholar.org/product/api/tutorial), [dataset/API license](https://api.semanticscholar.org/license/) | Version-check fields and API keys; account for throttling and usage/attribution constraints. |
| Qdrant local deployment | [Local quickstart](https://qdrant.tech/documentation/quickstart/), [snapshot operations](https://qdrant.tech/documentation/operations/snapshots/) | Use a pinned local service deployment, persistent storage and tested restoration. The Windows quickstart notes named volumes may be needed. |
| Docker Desktop | [Windows requirements](https://docs.docker.com/desktop/setup/install/windows-install/) | Guided optional prerequisite with virtualization, backend, policy and license checks; no implicit reboot or system-setting change. |
| DuckDB | [Python API](https://duckdb.org/docs/current/clients/python/overview) | Use an embedded persistent database through its worker; no separate DuckDB service/container is required. |
| Playwright MCP | [Microsoft-maintained upstream](https://github.com/microsoft/playwright-mcp) | Pin adapter/browser pair; isolate session state. Its origin/file controls must not be presented as an OS security boundary. |
| Embedding runtime | [Sentence Transformers installation](https://www.sbert.net/docs/installation.html) | Verify CPU wheels and runtime lock first; add GPU backends only as separately tested options. |
| Small embedding model | [multilingual-e5-small model card](https://huggingface.co/intfloat/multilingual-e5-small/raw/main/README.md) | Evaluate a pinned revision, model-specific query/passage preprocessing and token-aware chunking. |
| Larger embedding model | [BGE-M3 model card](https://huggingface.co/BAAI/bge-m3) | Candidate advanced option; benchmark memory, latency, multilingual quality and reindex cost before selection. |
| Reranker | [BGE reranker v2 M3 model card](https://huggingface.co/BAAI/bge-reranker-v2-m3) | Candidate, not a confirmed default; compare a revision-pinned smaller alternative if CPU/resource targets fail. |

No community “Zotero MCP”, “Document MCP”, “OpenAlex MCP”, “Crossref MCP”, “Semantic Scholar MCP”, or “Jupyter MCP” package is selected by this roadmap. Their names in the attachment describe desired capabilities, not verified package identities. Before adoption, record upstream, maintainer, license, immutable version, release artifacts, supported operations, Windows behavior and real MCP receipts. A small authored MCP bridge to official APIs is the fallback where no suitable maintained implementation passes evaluation. Jupyter's editor/kernel integration can meet Phase 2 without a notebook-execution MCP server.

## 3. Proposed ADRs and decision deadlines

| ADR | Decision / recommendation | Resolve by | Evidence needed |
| --- | --- | --- | --- |
| ADR-001 | Windows 11 x64 first; supported targets expand only with receipts | Phase 1 specification | Host inventory and standard-user install |
| ADR-002 | One orchestrator VSIX; external scientific runtimes and models | Phase 1 design | Dependencies/size and lifecycle prototype |
| ADR-003 | uv-managed isolated Python workers; CPython 3.12 initial candidate | G1 | Binary wheels, parser fixtures, editor path proof; supported alternative if candidate fails |
| ADR-004 | Native editor tools before broad filesystem MCP; document bridge for missing capabilities | G1 | Workflow gap assessment and tool permission tests |
| ADR-005 | Managed provider mode plus explicit portable export, mutually exclusive per toolkit server | G1 prototype; G4 release | No duplicate tools, credential handoff and configuration persistence |
| ADR-006 | Official scholarly HTTP APIs behind an authored, narrow local MCP adapter | Phase 2 prototype | [ADR-006](decisions/ADR-006-official-research-api-adapters.md); fixture and low-volume live request receipts, with Semantic Scholar keyless route rate-limited |
| ADR-007 | Zotero fixed loopback read route; user-reviewed RIS import; no direct SQLite manipulation | Phase 2 prototype | [ADR-007](decisions/ADR-007-zotero-local-read-manual-ris.md); fake-server checks only, real Zotero unavailable on reference host |
| ADR-008 | DuckDB embedded worker with serialized writes and portable evidence exports | G3 | Concurrent-reader/write and backup/migration tests |
| ADR-009 | Qdrant in a local pinned Linux container on the Windows reference route | G3 | Backend/volume behavior, restart persistence and restoration; alternative backend tested separately |
| ADR-010 | CPU small multilingual embedding baseline; optional reranker/larger model | G3 | Frozen multilingual retrieval benchmark and resource measurements |
| ADR-011 | Dedicated Playwright sessions; institutional adapters opt-in and provider-specific | G3 | Session isolation, user-mediated login and authorized fixture workflow |
| ADR-012 | Notify/review updates; transactional updates for owned components | G4 | Successful managed update, failed-update recovery and persistent-data comparison |
| ADR-013 | Stable public VS Code APIs; minimum host chosen from tested features | G4 | Minimum/current Stable test pair; fallback for optional contributions |
| ADR-014 | Authored project templates/skills bundled; vendor binaries/licenses evaluated separately | G4 | SBOM, notices, artifact listing and skill discovery |

Individual ADR records for Phases 1–2 capture prototype decisions and their limits. The Phase 1 prototype provides evidence for Windows-first host selection, uv-managed isolation and portable MCP configuration. ADR-006/007 select explicit, limited research routes for further acceptance; they do not approve G1/G2 or a production release. A failed hypothesis changes the design and lock; it must not be hidden by weakening an acceptance criterion after the run.

## 4. Planning uncertainties

- Exact runtime, extension, parser, MCP, service and model versions remain unselected. A document-only research pass cannot establish their compatibility.
- CPU memory/latency targets in Phase 3 are proposed product thresholds; adjust them through a reviewed specification before benchmarking if reference hardware differs.
- NotebookLM remains an export/helper workflow. Automation or a paid/enterprise API would be a separately reviewed capability with explicit documented access.
- Institutional sources are not a universal connector: each provider/account can differ in API access, entitlement, login and permitted export behavior.
- External applications and live provider APIs have update constraints outside the VSIX's control. A complete product can guide them, observe versions and diagnose problems without owning every upgrade.
- Docker is absent from Basic and Recommended. It is required for the proposed Windows Full reference service route unless an independently validated non-Docker local backend is selected. Reusing a remote Qdrant service is a separate deployment mode and does not prove local service installation.
