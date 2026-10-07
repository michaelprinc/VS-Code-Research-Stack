# Phase 1 local setup and operation

Status: Windows reference setup in progress. Commands use the same `uv` project workflow on Windows and macOS; shell activation and official Python/uv provisioning are host-specific. The package does not modify global PATH, machine Python, VS Code user settings, or Git configuration.

## Prerequisites

- VS Code Desktop Stable (optional except for editor integration).
- Git (optional for local history).
- uv and Python 3.12. `uv python install 3.12` installs a user-managed interpreter if needed; it does not replace other Python installs.
- Network access for first-time package/runtime acquisition. The document workflow itself makes no network requests after setup.

## Setup in this checkout

From the project directory:

```text
uv python install 3.12
uv sync --locked --python 3.12
uv run --locked research-stack inspect
uv run --locked research-stack init "<path to your research workspace>"
```

Open the workspace in VS Code. Review `.mcp.json`, confirm the workspace is trusted, then use **MCP: List Servers** and start `research-stack-basic`. Approve the server only after reviewing the local source/configuration. This MCP server can read PDF/DOCX under the selected workspace and create new Markdown files only under `outputs/`. It cannot rely on OS sandboxing on Windows; path checks in the application provide an additional restriction, not a Windows security boundary.

On the 1.140.0 reference host, installing `GitHub.copilot` through the CLI currently fails because its Marketplace companion requirement requests an older `GitHub.copilot-chat` than the editor-bundled version. Do not force a downgrade. Use the VS Code Extensions view to review the official extension's current compatibility/install options, then record the resulting versions before attempting Copilot integration. Sign-in and organization policy remain separate user-controlled steps.

## Manual CLI checks

```text
uv run --locked research-stack read "<path to file.pdf or file.docx>" --start 1 --count 20
```

Use the MCP tools to create new Markdown or DOCX reports. Output names must be new. For repeated/untrusted work, use a dedicated workspace with only the intended source files.

To prepare selected originals for manual NotebookLM import:

```text
uv run --locked research-stack export-bundle "<new bundle folder>" "<selected PDF/DOCX/TXT/MD>" ...
```

The helper copies the selected sources and creates `source-index.md` with SHA-256 identities. It does not upload files. NotebookLM is a cloud service; check your account, rights, and organization policy before manually importing private material.

Optional GitHub repository reading is documented separately in [GitHub read-only integration](github-readonly.md); it is not enabled in the default workspace config.

## Recovery and removal

- Re-run `uv sync --locked --python 3.12` to repair the managed project environment.
- Workspace initialization never overwrites existing top-level instructions, skills, recommendations or MCP configuration; review a diff and make manual edits if needed.
- Remove only `.research-toolkit/worker/.venv` to recreate the worker environment. Preserve `papers/`, `notes/`, and `outputs/`.
- Remove `.mcp.json` manually to stop future MCP launches, or disable the server in VS Code. No server remains running after its stdio client exits.
