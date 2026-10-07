# Phase 1 G1 evidence report

Date: 7 October 2026
Specification: `specs/phase-1/spec.md` revision 0.1.0
Implementation: Research Stack Basic 0.1.0
Outcome: **partial prototype; G1 not passed**

## Reference host and resolved package set

- Windows 11 x64, build 10.0.26300; local VS Code Desktop Stable 1.140.0.
- Python candidate installed and used: CPython 3.12.13 through uv; project-local `.venv` only.
- uv 0.11.23, Git for Windows 2.54.0.windows.1.
- Runtime packages: MCP Python SDK 2.2.0, pypdf 6.4.1, python-docx 1.2.0. The reviewed `uv.lock` contains wheel/sdist SHA-256 values; whole lock SHA-256: `121B7F61211B39BC7286E6327D3075D6C44847326C309EDA4DF445EB6BC38A6E`.
- Setup did not change global PATH, machine Python, Git config, VS Code user MCP config, or credentials.

## Evidence

| Requirement/scenario | Result | Evidence |
|---|---|---|
| B-01 / T1-01 inspect | Passed for basic local inventory | `uv run --locked research-stack inspect`; reports runtime/tool versions, no credentials |
| B-02 / T1-02 locked install | Passed on current host | `uv sync --locked --python 3.12`; CPython 3.12.13, exact versions above |
| B-03 / T1-03 workspace init | Passed for synthetic Unicode/space path and repeat/preserve behavior | `uv run --locked pytest`, `test_workspace.py`; sample at `examples/Phase 1 workspace/` |
| B-04 / T1-04 extraction | Partial pass | Synthetic DOCX paragraphs/tables and blank PDF OCR warning pass; scholarly fixture quality and encrypted/malformed PDFs remain untested |
| B-05 / T1-05 report and sources | Passed for new Markdown/DOCX; overwrite blocked; source hash preserved | `uv run --locked pytest`; `scripts/verify_mcp.py` |
| B-06 / T1-06 MCP tool contract | Protocol passed; VS Code host not yet passed | Actual stdio process launched from copied sample workspace project using `uv` config; discovered `read_document`, `write_markdown`, `write_docx` and invoked all three |
| B-07 / T1-07 Git/GitHub | Local Git detected; optional official remote read-only config staged, OAuth/repository read not tested | Git 2.54.0.windows.1 found; optional fragment and setup note are separate from default config |
| B-08 NotebookLM handoff | Passed as local file-preparation helper | Bundle test verifies source copy and checksum; no account upload performed |
| B-09 setup re-run | Partial pass | Locked setup sync and workspace init rerun; power-loss/cancel recovery not tested |
| B-10 path/output boundaries | Partial pass | Relative traversal rejected; overwrite refused. Windows MCP OS sandbox unavailable; symlink/junction test pending |

Local verification executed:

- `uv sync --locked --python 3.12` — succeeded, resolved 40 packages (39 installed into the root environment including project; 33 production packages in workspace worker).
- `uv run --locked pytest` — 10 passed (workspace safety/idempotence, PDF/DOCX extraction and authoring, no-overwrite, bundle integrity, profile schema and portable MCP-template checks).
- `uv run --locked python scripts/verify_mcp.py` — discovered all three tools, read synthetic Czech DOCX via stdio, wrote new Markdown/DOCX reports and confirmed source SHA-256 unchanged.
- `uv sync --locked --no-dev --project "examples/Phase 1 workspace/.research-toolkit/worker" --python 3.12` — succeeded for copied workspace worker.
- `uv run --locked --no-sync python scripts/verify_mcp.py "examples/Phase 1 workspace"` — launched the copied worker through `uv`, discovered/called both tools and wrote a uniquely named output.

## Exclusions and blockers

- Official `GitHub.copilot` is not installed. The current host has a bundled `GitHub.copilot-chat` 0.68.0; `code --install-extension GitHub.copilot` failed because the Marketplace install attempted to downgrade that bundled companion to 0.48.1. No forced downgrade was made. The required fresh Copilot chat tool invocation is therefore not verified.
- GitHub remote read/auth, organization policy handling, and NotebookLM account import are intentionally not automated or proven.
- No clean second Windows host or macOS machine was used. This is a Windows-only support claim; macOS remains a future support row.
- Interruption/recovery, symlink/junction escape, encrypted/malformed/scientific layout fixture coverage, and application-level MCP UI startup remain pending.
- VS Code documentation states workspace `.mcp.json` uses `mcpServers` and that sandbox support for local MCP servers is currently unavailable on Windows. The worker path guard is application-level defense, not OS isolation.

## Gate decision

The local Basic package is viable as a locked document/MCP prototype on this Windows reference host. Do not advertise the full Basic profile as supported yet. G1 remains open until the VS Code host path is validated, missing Basic integration scope is implemented or explicitly descoped, and clean-host repeatability/recovery evidence is added. macOS support must remain unclaimed until a native macOS run passes.
