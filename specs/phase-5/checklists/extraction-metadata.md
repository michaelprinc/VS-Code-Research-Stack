# Checklist — extraction, retrieval and metadata correctness (F15, F16)

Findings addressed: F15 DOCX order, DOI normalization, merge loss, stale derived scope, provider null tolerance, outage state; F16 notes reopening, evidence resolution, report validation, DOCX rendering.

## F15 — extraction

- [x] DOCX body blocks iterate in document order (`w:p` and `w:tbl` interleaved).
- [x] Table rows keep `table-N-row` locators and row numbers.
- [x] Probe `docxOrder` returns paragraph / table / paragraph in that order.
- [x] Range navigation reports total items/pages, the returned range and truncation.

## F15 — metadata

- [x] DOI keeps balanced punctuation; trailing delimiters are removed only when unbalanced.
- [x] Probe `doi`: `10.1234/example(2026)` normalizes to itself.
- [x] Merge keeps every distinct value with its provenance; no observation disappears.
- [x] Probe `merge` retains A, B and C.
- [x] `evidenceScope` and `access` are recomputed after a merge.
- [x] Probe `merge` reports `abstract-only` after an abstract is merged in.
- [x] Malformed provider rows are isolated with a warning.
- [x] Probe `providerNullAuthors` returns records instead of raising.
- [x] Result states distinguish `complete`, `empty`, `partial`, `unavailable`.
- [x] Probe `allProvidersFail` reports `unavailable`.
- [x] `validate_citation` uses the configured Crossref request policy (mailto/User-Agent), not empty headers.

## F16 — retrieval and reports

- [x] `read_text_source` accepts Markdown/text and the locator vocabulary the search returns.
- [x] A notes hit can be reopened with adjacent context.
- [x] Probe `notesReopen` no longer returns `UNSUPPORTED_FORMAT`.
- [x] `evidence_read` resolves chunk ids through MCP; `get_chunks` is exposed as a verb.
- [x] Claim reads hydrate source path, text hash and freshness.
- [x] Report sources require a 64-hex SHA-256 and a non-empty reference.
- [x] A workspace path in a citation is checked for existence and hash match.
- [x] `evidence_chunk_ids` are resolved against the store; unresolved ids abort the export.
- [x] `claims_export` produces validated references from stored claims.
- [x] Markdown and DOCX render one shared report model (headings, lists, tables, citations).
- [x] Probe `unvalidatedCitation` is refused instead of creating a report.
- [x] Exclusive output creation is preserved for both writers.
## Verification status — 31 October 2026

Covered by `test/test_documents.py`, `test/test_research.py`, `test/test_reports.py` and the recorded probes
`docxOrder`, `doi`, `merge`, `providerNullAuthors`, `allProvidersFail`, `notesReopen`, `unvalidatedCitation`
in [`python-probe-results.json`](../../../../evidence/quality-v0.3.5-2026-10-31/python-probe-results.json).

Residual limits: the DOI normalizer keeps balanced punctuation and strips unbalanced trailing delimiters; a
`dx.doi.org/` prefix is reported as `invalid` rather than stripped (T5-28 Partial). Provider row counts are
measured against synthetic provider fixtures, not live Crossref/OpenAlex/DOAJ traffic.
