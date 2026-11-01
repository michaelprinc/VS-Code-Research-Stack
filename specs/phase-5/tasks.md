# Phase 5 tasks — 0.3.5 stabilization and continuous research workflow

Revision: 0.3.5-preview. Plan: [spec.md](spec.md), [design.md](design.md). Acceptance: [acceptance.md](acceptance.md). Topic checklists: [checklists/](checklists/).

Each phase is verified on its own before the next one starts. "Verified" means the named automated checks pass on this host **and** the defect probe that motivated the task no longer reproduces.

## Phase A1 — store integrity (F01–F05, F13, F14)

| ID | Work | Files | Checklist | State |
|---|---|---|---|---|
| A1-01 | Shared containment guard (traversal, symlink, junction, reparse) used by every toolkit-owned write | `src/research_stack/paths.py`, `records.py`, `workspace.py` | [store-integrity.md](checklists/store-integrity.md) | Planned |
| A1-02 | Store schema v2: `source_versions`, current-inventory `sources`, occurrence `chunks` with `content_id`/`current`, `claim_evidence.role`, `claim_events` | `src/research_stack/records.py` | store-integrity | Planned |
| A1-03 | Evidence retention across re-index and removal; freshness reported per link | `records.py` | store-integrity | Planned |
| A1-04 | Duplicate-content ingestion and empty-source re-index | `src/research_stack/full.py` (`scan_sources`), `records.py` | store-integrity | Planned |
| A1-05 | Consistent backup, candidate restore with explicit activation, referenced-aware vacuum | `records.py` | store-integrity | Planned |
| A1-06 | Schema validation before mutation, read-only reads, write-free preview, SQLite error translation | `records.py`, `lab_server.py` | store-integrity | Planned |
| A1-07 | SQL filtering, cursor pagination, collision-safe ids, idempotency key, evidence roles/modes, event history | `records.py`, `lab_server.py` | store-integrity | Planned |
| A1-08 | Regression tests named after the review evidence keys | `tests/test_records.py`, `tests/test_lab_server.py` | store-integrity | Planned |

**Phase exit:** index → claim → change source → re-index → claim evidence still resolvable and flagged; duplicate and empty sources index cleanly; backup/restore round trip validated; unknown schema refused; reads leave the file byte-identical.

## Phase A2 — extraction and metadata correctness (F15, F16 partial)

| ID | Work | Files | Checklist | State |
|---|---|---|---|---|
| A2-01 | DOCX body blocks in document order with table/row locators | `src/research_stack/documents.py` | [extraction-metadata.md](checklists/extraction-metadata.md) | Planned |
| A2-02 | Bounded text reader with locator-compatible context | `documents.py`, `mcp_server.py` | extraction-metadata | Planned |
| A2-03 | Document range navigation and coverage reporting | `documents.py`, `mcp_server.py` | extraction-metadata | Planned |
| A2-04 | Shared report model rendered by Markdown and DOCX; citation validation | `documents.py`, `mcp_server.py` | extraction-metadata | Planned |
| A2-05 | DOI normalization, merge observation retention, derived-scope recompute, malformed-row isolation, provider result states, shared request policy | `src/research_stack/research.py` | extraction-metadata | Planned |
| A2-06 | Regression tests for `docxOrder`, `doi`, `merge`, `providerNullAuthors`, `allProvidersFail`, `unvalidatedCitation`, `notesReopen` | `tests/test_documents.py`, `tests/test_research.py` | extraction-metadata | Planned |

**Phase exit:** paragraph/table/paragraph extracts in order; `10.1234/example(2026)` survives; three conflicting titles all remain; a merged abstract changes `evidenceScope`; a null-author row does not abort a search; a total outage is `unavailable`, not `partial`; a notes hit reopens.

## Phase A3 — setup, upgrade and repair lifecycle (F01 JS, F06–F09)

| ID | Work | Files | Checklist | State |
|---|---|---|---|---|
| A3-01 | One dependency resolver for every entry point (closure expansion, satisfied prerequisites accepted) | `extension/installer.js`, `extension/extension.js` | [setup-lifecycle.md](checklists/setup-lifecycle.md) | Planned |
| A3-02 | Artifact-aware status: recorded vs observed vs verified vs modified; repair run | `installer.js`, `runtime.js`, `diagnostics.js` | setup-lifecycle | Planned |
| A3-03 | Overlay classification `current` / `modified-preserved` with honest step evidence | `installer.js` | setup-lifecycle | Planned |
| A3-04 | Prior-release discovery, candidate staging, atomic activation pointer, rollback command | `runtime.js`, `installer.js`, `extension.js` | setup-lifecycle | Planned |
| A3-05 | Notebook ownership check, junction preflight, interpreter + import verification | `installer.js`, `runtime.js` | setup-lifecycle | Planned |
| A3-06 | Atomic receipts, plan-wide lock, store/backup directory preflight | `installer.js`, `runtime.js` | setup-lifecycle | Planned |
| A3-07 | Derived-data ignore rule and privacy note written by the store step | `installer.js`, `templates/basic-workspace/.gitignore` | setup-lifecycle | Planned |
| A3-08 | Regression tests `quickPickStep`, `partialUpdate`, `repairAfterInterpreterRemoved`, `overlayConflict`, `legacyUpgradeDiscovery`, `notebookVenvJunction` | `extension/test/installer.test.js`, `extension/test/runtime.test.js` | setup-lifecycle | Planned |

**Phase exit:** a single-step request for `lab-store` after a full install succeeds; a partial update runs only the outdated step; a deleted interpreter is detected and repaired; a 0.3.4 receipt is discovered by 0.3.5 and the prior runtime stays usable.

## Phase A4 — presets, MCP identity and client state (F10, F11, F12, F17)

| ID | Work | Files | Checklist | State |
|---|---|---|---|---|
| A4-01 | `research-workflow` preset (11 tools) as the Full default; accurate labels/goals/tips | `extension/presets.json`, `src/research_stack/presets.py` | [presets-and-surface.md](checklists/presets-and-surface.md) | Planned |
| A4-02 | `evidence_read` and `claims_export` verbs; `read_text_source` in notes/corpus presets | `src/research_stack/lab_server.py`, `mcp_server.py` | presets-and-surface | Planned |
| A4-03 | Annotation audit (destructive remove mode, split maintenance semantics, open-world network hints) | `lab_server.py`, `mcp_server.py`, `recommended_server.py` | presets-and-surface | Planned |
| A4-04 | Preset/tool-surface identity in the MCP definition version; saved vs applied state | `extension/extension.js` | presets-and-surface | Planned |
| A4-05 | One message per click in the control panel | `extension/media/controls.js`, `extension/extension.js` | [ui-and-state.md](checklists/ui-and-state.md) | Planned |
| A4-06 | Folder-bound measurements, partial-measurement labelling, vendor-estimate wording | `extension/extension.js`, `extension/ui.js` | ui-and-state | Planned |
| A4-07 | Folder-scoped configuration reads/writes; recent presets ordered first | `extension/extension.js`, `extension/package.json` | ui-and-state | Planned |
| A4-08 | Regression tests `presetIdentity`, `setupButtonClickMessages`, `folderSwitch`, budget invariants | `extension/test/presets.test.js`, `extension/test/unit.test.js` | presets-and-surface | Planned |

**Phase exit:** one preset covers read → index → search → resolve → claim → export within budget; a preset change changes the definition version; a click sends one message; a folder switch clears stale measurements.

## Phase A5 — release evidence and documentation (F18)

| ID | Work | Files | Checklist | State |
|---|---|---|---|---|
| A5-01 | Version bump to 0.3.5 across manifest, worker bundle, runtime paths, guides | `pyproject.toml`, `extension/package.json`, `src/research_stack/__init__.py`, `runtime.js` | [docs-and-release.md](checklists/docs-and-release.md) | Planned |
| A5-02 | Repair `host.test.js` (current version, `runPlan` setup path) and `browser.test.js` (preset count from the catalog) | `extension/test/host.test.js`, `extension/test/browser.test.js` | docs-and-release | Planned |
| A5-03 | Privilege-free Windows link fixtures | `extension/test/installer.test.js`, `extension/test/runtime.test.js` | docs-and-release | Planned |
| A5-04 | README/guide corrections: current version, isolated-install example, downloader claim, corpus preset dependency, historical status marked historical | `README.md`, `extension/README.md`, `extension/guides/*` | docs-and-release | Planned |
| A5-05 | Rebuild bundle, build VSIX, run `verify_vsix.py`, `check:payload`, real functional check | `scripts/`, `dist/` | docs-and-release | Planned |
| A5-06 | Re-run the v0.3.4 review probes as a 0.3.5 regression receipt | `evidence/quality-v0.3.5-*/` | docs-and-release | Planned |
| A5-07 | Update `.agent/QUALITY_STATE.md`, CHANGELOG, gate report and the 0.3.5 implementation report | `.agent/`, `extension/CHANGELOG.md`, `evidence/phase-4/gate-report.md`, `analysis-0.3.5/` | docs-and-release | Planned |

**Phase exit:** the built VSIX audits clean, the payload check reports the 0.3.5 plan and preset set, the functional check passes with the new verbs, and every review probe is re-run with its fixed outcome recorded.
