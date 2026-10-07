# Phase 1 Basic specification

Revision: 0.1.0 (implementation baseline, 7 October 2026)
Status: implemented prototype; acceptance is recorded in `evidence/phase-1/gate-report.md`.

## User outcome

Create a source-grounded local research workspace, extract text and locators from selected text-bearing PDF/DOCX files, create new Markdown outputs without overwriting, and optionally expose those document operations to a compatible MCP host. Local work remains usable without Copilot or network credentials.

## Requirements

| ID | Requirement | Phase 1 prototype acceptance |
|---|---|---|
| B-01 | Inspect the host and selected runtimes without mutation | `research-stack inspect`; no credentials collected |
| B-02 | Use exact package identities in an isolated runtime | `uv.lock`; `uv sync --locked`; no global Python/PATH change |
| B-03 | Create a Basic workspace idempotently | `research-stack init`; existing managed paths preserved |
| B-04 | Extract bounded PDF/DOCX text with stable source locators | `read_document`, CLI read; unsupported/scanned cases explicit |
| B-05 | Create new Markdown and DOCX reports with source identities | MCP `write_markdown` and `write_docx`; existing output refused |
| B-06 | Expose the same operations through one MCP registration | `.mcp.json` portable mode; actual host invocation remains separately receipted |
| B-07 | Use local Git and offer minimal remote GitHub read access | Local Git detect-only; optional official read-only repos MCP fragment provided; OAuth/repository read not verified |
| B-08 | Prepare NotebookLM handoff | `research-stack export-bundle` copies selected PDF/DOCX/TXT/Markdown sources with SHA-256 index; upload remains manual |
| B-09 | Record readiness and recoverable setup | `inspect`, locked setup, repeatable workspace initializer, receipts |
| B-10 | Restrict source/output access | Workspace root checks, outputs-only writes, caps, no overwrite |

## Supported prototype scope

- Windows 11 x64 local reference host; Python 3.12–3.14 candidate range, uv-managed environment.
- macOS is a design target for Phase 4; it is not runtime-tested in this phase.
- VS Code Desktop with compatible portable MCP configuration; MCP sandbox is unavailable on Windows, so trust and application-level path guards remain essential.
- PDF text extraction (no OCR/layout reconstruction); DOCX paragraphs and table rows (not rendered pagination).
- Copilot, GitHub remote operations and live NotebookLM import are optional account-controlled follow-ups.

## Explicit limits

Maximum input 50 MiB, maximum PDF 500 pages, maximum output text 1,000,000 characters, read range 1–100 pages/paragraph rows. No silent truncation. Output writes target a new file under `outputs/`. Inputs are not modified.

## Acceptance scenarios

See `acceptance.md`. A test pass does not substitute for fresh VS Code Copilot tool discovery/invocation, organizational-policy compatibility, or a second clean Windows host.
