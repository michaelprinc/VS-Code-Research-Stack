# Phase 9 tasks — 0.3.9

One row per implementation task, with the decision it carries out and where the result lives. Status is
what this container can prove today; nothing here stands for a Windows or live VS Code result.

| # | Task | Decision | Where it landed | Status |
|---|---|---|---|---|
| 1 | Baseline: measure what 0.3.8 really does before changing it (reader vs indexer, retrieval limit, schema, VSIX headroom) | — | `specs/phase-9-document-ingestion/spec.md` §1; `.agent/0.3.9/A-python-core.md`, `B-extension-packaging.md`, `C-theology-bundle.md` | done |
| 2 | Batched whole-source extraction with coverage and outcome | DD9-01, DD9-02, DD9-03 | `src/research_stack/documents.py` — `DocumentUnit`, `ExtractedSource`, `extract_source`, `parser_identity` | done, tested |
| 3 | Chunk inside a unit so a chunk never crosses a page or an item | DD9-04, DD9-05 | `src/research_stack/full.py` — `SourceUnit`, `PDF_CHUNKER_ID`, `DOCX_ITEM…`/`DOCX_CHUNKER_ID`, `chunks_for_source` | done, tested |
| 4 | Indexer accepts PDF/DOCX and carries provenance forward | DD9-06 | `src/research_stack/full.py` — `_binary_source_record`, `scan_sources`, `SourceRecord` | done, tested |
| 5 | Schema 3 by additive migration; `index_runs` table | DD9-07, DD9-08 | `src/research_stack/records.py` — `SCHEMA_VERSION = 3`, `_migrate_2_to_3` | done, tested against a real 0.3.8 store |
| 6 | Transactional reindex with per-file outcomes and partial policy | DD9-09, DD9-10 | `src/research_stack/records.py` — `index_corpus(…, accept_partial, cancel)` | done, tested |
| 7 | Freshness as a recorded check; `verify_sources` | DD9-11 | `src/research_stack/records.py` — `verify_sources`; `lab_server.py`; `presets.py`; `extension/presets.json` | done, tested through real MCP |
| 8 | Exports carry freshness and exclude stale/unverified by default | DD9-12 | `src/research_stack/records.py` — `export_claims`, `_evidence_links` | done, tested |
| 9 | Reopen a stored locator in its source | DD9-13 | `src/research_stack/documents.py` — `locator_unit`, `read_document_at_locator`; `mcp_server.py` `read_document` | done, tested |
| 10 | CLI verbs the panel calls | DD9-14 | `src/research_stack/cli.py` — `index-corpus`, `verify-sources` | done, tested |
| 11 | Backup/restore that works on an unmigrated store | DD9-15 | `src/research_stack/records.py` — `_snapshot` counts only tables the snapshot has | done, tested |
| 12 | Reviewed bundle catalog, generated not hand-written | DD9-16, DD9-21 | `scripts/build_bundle_catalog.py`, `extension/bundles/catalog.json` | done, `--check` gate |
| 13 | Staged, hash-verified install with receipts, conflicts and upgrade path | DD9-17…DD9-20 | `extension/bundles.js` | done, 17 Node cases |
| 14 | Control-panel and Command Palette surface for ingestion, freshness and bundles | DD9-18 | `extension/extension.js`, `extension/ui.js`, `extension/package.json`, `extension/vsix-manifest.json` | done; the panel's real behaviour on a live Extension Host is **not** verified here |
| 15 | Theological bundle 2.0 as the first reviewed bundle, with its adaptations | DD9-22, DD9-24 | `templates/skill-bundles/theology/theological-research/`, `extension/bundles/theological-research/`, `docs/implementation/phase-9-document-ingestion/bundle-notes.md` | done; **licence unresolved**, `publishable: false` |
| 15b | The 0.3.8 document workaround becomes a reviewed bundle with corrected text, and the overlay tree is checked against its allowlist | DD9-23 | `templates/skill-bundles/toolkit/document-corpus-bridge/SKILL.md`, `extension/bundles/document-corpus-bridge/SKILL.md`, `scripts/build_worker_bundle.py` (`assert_overlay_tree_is_reviewed`) | done, tested (T9-51, T9-52) |
| 16 | Packaging and VSIX audit carry the bundle group | DD9-19 | `extension/scripts/package.js`, `scripts/verify_vsix.py`, `extension/package.json`, `extension/vsix-manifest.json` | done in the packaging lists and the audit; the 0.3.9 artifact audit itself is **open** |
| 17 | Unpacked-payload ceiling raised deliberately | DD9-19 | `scripts/verify_vsix.py` `MAX_UNPACKED_BYTES` with the measured numbers beside it | done; re-measure against the built artifact |
| 18 | Release identity 0.3.9 across the six sources, with a re-lock | — | `pyproject.toml`, `src/research_stack/__init__.py`, `extension/package.json`, `extension/vsix-manifest.json`, `extension/runtime.js`, `extension/worker/bundle.json`, `uv.lock` | done, `lockintegrity` clean |
| 19 | Packaged documentation names 0.3.9 | — | `extension/README.md`, `extension/worker/README.md`, `extension/guides/*.md`, `extension/CHANGELOG.md`, `README.md` | in progress; `scripts/verify_vsix.py` refuses a stale guide |
| 20 | Evidence folder and release report with the verified / not-verified split | — | `evidence/quality-v0.3.9-2026-11-06/`, `docs/implementation/phase-9-document-ingestion/implementation-report-0.3.9.md` | open |

## Sequencing that is still open

1. Build and audit the 0.3.9 VSIX, then `npm run check:payload`.
2. Record the suite runs, the lock receipts and the VSIX audit in the evidence folder.
3. Write the release report, including the explicit "not verified in this container" list:
   Windows 11 install, VS Code Extension Host, Copilot skill discovery, the bundle install in a real
   workspace, and any Crossref/OpenAlex egress from the bundle's optional lookup script.
