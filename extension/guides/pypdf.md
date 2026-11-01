# PDF tools (pypdf)

Extract bounded text from supported PDFs.

## Setup

Use Set up package components to install through the isolated locked worker environment. Put a small text-based PDF under papers/ and retain the original source.

## First task and readiness

Check components reads installed metadata and performs an in-memory PDF write/read. For a real task, invoke read_document on a bounded page range, or run `uv run --locked research-stack read "<paper.pdf>" --start 1 --count 2` from the source project.

Use **Run MCP reading check** for real synthetic PDF/DOCX protocol and report tests, or **Read selected PDF / DOCX** for a read-only check of a source inside the workspace.

## Troubleshooting and limits

The worker limits inputs to 50 MiB, 500 pages and 1,000,000 result characters. Scanned/image-only files require separate OCR. Ready confirms a library smoke test, not every document. The stable guide may document a newer release than your lock.

## Current documentation

[Current official documentation](https://pypdf.readthedocs.io/en/stable/user/extract-text.html). Local onboarding reviewed on 11 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
