# Manual NotebookLM handoff

Prepare selected files for manual source import.

## Setup

From the source checkout, run `uv run --locked research-stack export-bundle "<new bundle folder>" "<source 1>" "<source 2>"`. PDF, DOCX, TXT and Markdown copies receive a SHA-256 source index.

## First task and readiness

Review the copies/index, then import chosen files manually through NotebookLM's current source interface. This is a file handoff, not an authenticated extension connector.

## Troubleshooting and limits

The toolkit never uploads, signs in or tests this service. Format/account limits change; consult Latest docs. Check suitability of source content for the destination and preserve local hashes for traceability.

## Current documentation

[Current official documentation](https://support.google.com/gemininotebook/answer/16215270). Local onboarding reviewed on 11 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
