# Word tools (python-docx)

Read DOCX sources and prepare Word reports.

## Setup

Use Set up package components to install through the isolated locked worker. Put a small paragraph/table DOCX under papers/. Generated reports must use a new name beneath outputs/.

## First task and readiness

The probe performs an in-memory DOCX paragraph write/read and displays the actual installed version. Next invoke read_document on your DOCX. The worker also provides write_docx for a new report with source references.

Use **Run MCP reading check** for real synthetic PDF/DOCX protocol and report tests, or **Read selected PDF / DOCX** for a read-only check of a source inside the workspace.

## Troubleshooting and limits

This handles .docx, not old .doc. Existing outputs are never overwritten. Ready covers the library test; complex layouts or tracked changes need manual review. Preserve source locators and hashes when preparing a report.

## Current documentation

[Current official documentation](https://python-docx.readthedocs.io/en/latest/). Local onboarding reviewed on 11 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
