# Research Stack — Phase 1 Basic

This checkout contains the Windows reference implementation prototype for the Basic / Research Starter package. It is designed around portable workspace content, `uv` project configuration, and a local stdio MCP document worker.

## Quick start

```text
uv python install 3.12
uv sync --locked --python 3.12
uv run --locked research-stack inspect
uv run --locked research-stack init "<your research workspace path>"
```

Open the created workspace in VS Code, inspect `.mcp.json`, trust the workspace only after reviewing the configuration, and use **MCP: List Servers** to start the `research-stack-basic` server. It can read selected PDF/DOCX documents and write new Markdown/DOCX reports. The document workflow has no external account requirement. Copilot, GitHub remote access and NotebookLM import are optional and not included in this prototype's verified integration.

See [setup and operation](docs/implementation/phase-1-basic/setup-and-operation.md), the [Phase 1 specification](specs/phase-1/spec.md), and the live [gate report](evidence/phase-1/gate-report.md).

To make a user-mediated NotebookLM bundle, run `uv run --locked research-stack export-bundle "<new output folder>" "<selected source 1>" "<selected source 2>"`. Supported copies are PDF, DOCX, TXT and Markdown. This only prepares files and a checksum index; it does not connect to NotebookLM.
