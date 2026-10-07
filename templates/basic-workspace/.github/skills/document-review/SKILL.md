---
name: document-review
description: Review a selected PDF or DOCX while preserving source identity and reporting extraction limits.
---

1. Record the source filename and SHA-256 from the document tool.
2. Review the returned page or paragraph range; request further ranges when needed instead of accepting truncation.
3. Verify quotations against the original viewer when layout, tables, equations, or reading order matter.
4. Mark a scanned PDF as OCR-needed; Phase 1 does not include OCR.
5. Write a new review under `outputs/` with the source locator for each observation.
6. Never overwrite the source or an existing output.
