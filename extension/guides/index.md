# Research Toolkit guide hub

Start with the [onboarding walkthrough](onboarding.md). Open the control panel and run **Check components** to compare observed installation with your selected package preference.

Installation and readiness are separate. Ready names a successful check, such as the running editor, a library test or a real local MCP document fixture workflow. Not verified means a separate MCP session, kernel, account or service task is still needed. Not detected describes inspected locations only. Planned describes an unimplemented toolkit integration, even if an unrelated application exists elsewhere.

Toolkit and Python worker versions are independent. Package selection does not install components. Inventory applies to the selected workspace and current editor host, with a last-check timestamp; it is not a machine-wide inventory.

Each component has an independent guide. Guide opens its bundled snapshot; Latest docs opens maintained official documentation on request. No documents are silently downloaded/replaced at activation. Current upstream instructions can differ from your installed/locked version.

**Who installs it** names the component step the control panel can run for you, or says plainly that a host tool, an editor extension, an external service or a planned integration is outside the toolkit's installer. Selecting a package never runs a step.

| Component guide | Group | Who installs it | Purpose | Current official source |
|---|---|---|---|---|
| [Research Stack Toolkit](toolkit.md) | Editor | You install this editor extension (Basic, Recommended, Full) | Manage package preferences, inspect components and find onboarding guides. | [Latest docs](https://github.com/michaelprinc/VS-Code-Research-Stack) |
| [VS Code Desktop](vscode-desktop.md) | Editor | You install this host tool (Basic, Recommended, Full) | Host research files and editor integrations. | [Latest docs](https://code.visualstudio.com/docs) |
| [uv environment manager](uv.md) | Basic | You install this host tool (Basic, Recommended, Full) | Create reproducible locked Python environments. | [Latest docs](https://docs.astral.sh/uv/guides/projects/) |
| [Workspace Python runtime](python.md) | Basic | Toolkit step: Isolated locked worker (Python 3.12) (Basic, Recommended, Full) | Run document tools in an isolated virtual environment. | [Latest docs](https://docs.python.org/3/tutorial/venv.html) |
| [Python MCP SDK](mcp-python-sdk.md) | Basic | Toolkit step: Isolated locked worker (Python 3.12) (Basic, Recommended, Full) | Provide the Python server protocol implementation. | [Latest docs](https://github.com/modelcontextprotocol/python-sdk) |
| [PDF tools (pypdf)](pypdf.md) | Basic | Toolkit step: Isolated locked worker (Python 3.12) (Basic, Recommended, Full) | Extract bounded text from supported PDFs. | [Latest docs](https://pypdf.readthedocs.io/en/stable/user/extract-text.html) |
| [Word tools (python-docx)](python-docx.md) | Basic | Toolkit step: Isolated locked worker (Python 3.12) (Basic, Recommended, Full) | Read DOCX sources and prepare Word reports. | [Latest docs](https://python-docx.readthedocs.io/en/latest/) |
| [Basic document worker](document-worker.md) | Basic | Toolkit step: Isolated locked worker (Python 3.12) (Basic, Recommended, Full) | Serve document reads and report creation through local MCP. | [Latest docs](https://github.com/michaelprinc/VS-Code-Research-Stack) |
| [Workspace MCP configuration](mcp-config.md) | Basic | Toolkit step: Isolated locked worker (Python 3.12) (Basic, Recommended, Full) | Connect reviewed local workers to your MCP client. | [Latest docs](https://code.visualstudio.com/docs/agent-customization/mcp-servers) |
| [Git](git-for-windows.md) | Basic | You install this host tool (Basic, Recommended, Full) | Track selected research files and source changes. | [Latest docs](https://git-scm.com/docs/gittutorial) |
| [GitHub Copilot editor integration](github-copilot.md) | Editor | You install this editor extension (Basic, Recommended, Full) | Use reviewed tools through an optional assistant client. | [Latest docs](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/extend-copilot-chat-with-mcp) |
| [GitHub remote MCP](github-remote-mcp.md) | Optional | External service or manual workflow | Use explicitly authorized remote repository tools. | [Latest docs](https://github.com/github/github-mcp-server) |
| [Manual NotebookLM handoff](notebooklm.md) | Optional | External service or manual workflow | Prepare selected files for manual source import. | [Latest docs](https://support.google.com/gemininotebook/answer/16215270) |
| [Research metadata adapter](research-stack-recommended-adapter.md) | Research | Toolkit step: Research overlay files (Recommended, Full) | Expose literature metadata and citation tools in a separate server. | [Latest docs](https://github.com/michaelprinc/VS-Code-Research-Stack) |
| [OpenAlex](openalex-rest-api.md) | Research | External service or manual workflow | Search scholarly metadata through the authored adapter. | [Latest docs](https://help.openalex.org/api/) |
| [Crossref](crossref-rest-api.md) | Research | External service or manual workflow | Look up DOI and bibliographic metadata. | [Latest docs](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) |
| [Semantic Scholar](semantic-scholar-academic-graph.md) | Research | External service or manual workflow | Use optional Academic Graph metadata search. | [Latest docs](https://api.semanticscholar.org/api-docs/) |
| [Zotero local integration](zotero-local-api.md) | Research | External service or manual workflow | Read bibliography metadata and prepare reviewed manual RIS import. | [Latest docs](https://www.zotero.org/support/dev/web_api/v3/local_api) |
| [VS Code Python extension](vscode-python-extension.md) | Research | You install this editor extension (Recommended, Full) | Select and work with project interpreters. | [Latest docs](https://code.visualstudio.com/docs/python/environments) |
| [VS Code Jupyter extension](vscode-jupyter-extension.md) | Research | You install this editor extension (Recommended, Full) | Open notebooks and select a research kernel. | [Latest docs](https://code.visualstudio.com/docs/datascience/jupyter-notebooks) |
| [Notebook analysis environment](research-analysis-python-environment.md) | Research | Toolkit step: Notebook analysis environment (Recommended, Full) | Isolate notebook dependencies from the MCP worker. | [Latest docs](https://docs.astral.sh/uv/guides/integration/jupyter/) |
| [Local lexical search prototype](research-stack-full-markdown-bm25-prototype.md) | Lab | Toolkit step: Isolated locked worker (Python 3.12) (Full) | Inspect the in-memory Markdown/text retrieval foundation. | [Latest docs](https://github.com/michaelprinc/VS-Code-Research-Stack) |
| [Qdrant vector database](qdrant-local-service.md) | Lab | Not implemented in the toolkit | Planned vector-store integration. | [Latest docs](https://qdrant.tech/documentation/quickstart/) |
| [Embedding runtime and model](cpu-embedding-runtime-and-model.md) | Lab | Not implemented in the toolkit | Planned CPU vector encoding. | [Latest docs](https://huggingface.co/docs/transformers/index) |
| [DuckDB record store](duckdb-research-record-store.md) | Lab | Not implemented in the toolkit | Planned persistent source/claim/evidence storage. | [Latest docs](https://duckdb.org/docs/stable/) |
| [Playwright browser integration](playwright-browser-capability.md) | Optional | Not implemented in the toolkit | Optional planned research browser capability. | [Latest docs](https://github.com/microsoft/playwright-mcp) |
| [Institutional access adapters](institutional-provider-adapters.md) | Optional | Not implemented in the toolkit | Provider-specific access remains unselected. | Provider not selected |
| [Workspace corpus index](research-corpus-index.md) | Lab | Toolkit step: Corpus index and record store (Full) | Persistent, reviewable index of selected Markdown/text sources with stable chunk identities. | [Latest docs](https://github.com/michaelprinc/VS-Code-Research-Stack) |
| [Research record store](research-record-store.md) | Lab | Toolkit step: Corpus index and record store (Full) | Local SQLite store for claims and their evidence links, with previewed maintenance. | [Latest docs](https://github.com/michaelprinc/VS-Code-Research-Stack) |

[Documentation maintenance](maintenance.md) · [Toolkit controls](toolkit.md)
