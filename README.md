# VS Code Research Stack — Phase 1 Basic, Phase 2 Researcher, Phase 3 Research Lab

This repository contains the Windows reference implementation prototype for the Basic / Research Starter package and an additive Phase 2 Researcher prototype. Both use portable workspace content, locked `uv` projects, and local stdio MCP workers. **G1 remains open and Phase 2 G2 has not passed; this repository is not yet a supported cross-platform release.**

## Quick start

```text
uv python install 3.12
uv sync --locked --python 3.12
uv run --locked research-stack inspect
uv run --locked research-stack init "<your research workspace path>"
```

Open the created workspace in VS Code, inspect `.mcp.json`, trust the workspace only after reviewing the configuration, and use **MCP: List Servers** to start the `research-stack-basic` server. It can read selected PDF/DOCX documents and write new Markdown/DOCX reports. The document workflow has no external account requirement. Copilot, GitHub remote access and NotebookLM import are optional and not included in this prototype's verified integration.

See [setup and operation](docs/implementation/phase-1-basic/setup-and-operation.md), the [Phase 1 specification](specs/phase-1/spec.md), and the live [gate report](evidence/phase-1/gate-report.md).

## Phase 2 Researcher prototype

Add the Phase 2 overlay to a disposable Basic workspace with:

```text
uv run --locked research-stack add-recommended "<workspace path>"
```

The overlay adds a separate MCP server for bounded OpenAlex, Crossref and Semantic Scholar metadata searches; exact-DOI citation lookup; loopback read-only Zotero access; and reviewed RIS preparation. It adds five research skills and recommends the VS Code Python and Jupyter extensions. It does not download papers, write to Zotero, or run notebook cells automatically. See the [Phase 2 setup guide](templates/recommended-overlay/research/README.md), [specification](docs/implementation/phase-2-recommended/spec.md), and [G2 evidence report](evidence/phase-2/gate-report.md).

To make a user-mediated NotebookLM bundle, run `uv run --locked research-stack export-bundle "<new output folder>" "<selected source 1>" "<selected source 2>"`. Supported copies are PDF, DOCX, TXT and Markdown. This only prepares files and a checksum index; it does not connect to NotebookLM.

## Phase 3 Research Lab foundation

Phase 3 adds a dependency-free prototype for explicit UTF-8 Markdown/text corpus selection, stable source/chunk identities, provenance-bearing BM25 results and cross-platform Full-profile settings/catalog contracts. It does not yet provide vector or hybrid search, persistent storage, embeddings, a Research-RAG MCP or backup/recovery. Qdrant, DuckDB, embedding models, Playwright and institutional connectors remain unvalidated candidates. G1/G2 are prerequisites and G3 has not passed. See the [Phase 3 specification](specs/phase-3/spec.md), [implementation plan](docs/implementation/phase-3-complete/implementation-plan.md), [checklist](docs/implementation/phase-3-complete/checklist.md), and [evidence report](evidence/phase-3/gate-report.md).
