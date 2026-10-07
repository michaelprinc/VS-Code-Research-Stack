---
name: evidence-extraction
description: Extract structured evidence from user-selected papers and preserve source locations and extraction quality.
---

# Evidence extraction

- Work from the selected PDF or DOCX already available in the workspace. Do not automatically acquire full text.
- Capture bibliographic ID, study question, design, population/data, measures, findings, limitations and evidence locators.
- Mark unsupported, missing or ambiguous fields as unknown; do not fill them from general knowledge.
- Identify whether evidence came from the abstract or full text and whether OCR/layout extraction may be incomplete.
- Preserve conflicting values and source context rather than silently reconciling them.
- Write new results to a new file under `outputs/` and cite source path, page/paragraph locator and SHA-256.
