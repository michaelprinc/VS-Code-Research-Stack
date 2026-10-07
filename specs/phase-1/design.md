# Phase 1 Basic design

Revision: 0.1.0
Status: implemented prototype; selected runtime evidence appears in the gate report.

## Runtime and configuration

- Python project, isolated with `uv`; `.python-version` proposes 3.12 and `uv.lock` pins the resolved graph.
- Core configuration and workspace templates contain no OS-specific absolute path. `uv` and Python paths are resolved by the selected host at runtime.
- The worker is copied into `.research-toolkit/worker/` within a project workspace. `.mcp.json` uses `${workspaceFolder}` and the portable `mcpServers` shape.
- Workspace-specific mutable files are separated from the product repo. Originals remain under `papers/`; output root is `outputs/`; the worker accepts only root-contained sources and outputs-contained writes.
- Runtime state is not user data. Removing `.research-toolkit/worker/.venv` must not remove workspace sources or reports.

## Data contract

Extraction response fields: `path`, `kind`, `sha256`, `text`, `locators`, `warnings`. PDF locators use 1-based page numbers. DOCX locators use a 1-based sequence of paragraphs then table rows. Scanned/empty PDF returns an OCR-needed warning. Parser failures include bounded diagnostic codes and do not return file contents.

## MCP contract

- `read_document(path, start=1, count=50)`: workspace-relative source; PDF/DOCX only; 100 pages/rows maximum per call.
- `write_markdown(title, body, output_path, sources)` and `write_docx(...)`: path must resolve below `outputs/`; create a new file only; body <=100,000 chars; <=100 citations.
- stdio protocol logs must never be written to stdout by the application. No network calls or credentials are needed.
- `.mcp.json` is the only registration. Do not also generate `.vscode/mcp.json` for this server.

## Phase 4 integration notes

Replace source-tree file copying with signed/bundled extension assets and an ownership journal. The extension must render both the internal registration model and client-specific exports, serialize paths per host, track server ownership, check Workspace Trust/restricted mode, and explain Windows' missing MCP sandbox. Preserve user-owned `.mcp.json` using a diff/adoption flow; the Phase 1 initializer preserves it wholesale.
