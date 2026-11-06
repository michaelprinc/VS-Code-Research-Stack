# Research Stack Toolkit 0.3.9 — implementation report

Release: 0.3.9 · 6 November 2026 · built and verified in the development container
Spec: [specs/phase-9-document-ingestion/](../../specs/phase-9-document-ingestion/) —
[spec.md](../../specs/phase-9-document-ingestion/spec.md),
[design.md](../../specs/phase-9-document-ingestion/design.md),
[acceptance.md](../../specs/phase-9-document-ingestion/acceptance.md),
[tasks.md](../../specs/phase-9-document-ingestion/tasks.md)
Evidence: [evidence/quality-v0.3.9-2026-11-06/](../../evidence/quality-v0.3.9-2026-11-06/README.md)
Bundle record: [bundle-notes.md](bundle-notes.md)

**Status: implemented, packaged and audited on this Linux development host. Not verified on a Windows
11 host, in a VS Code Extension Host, or with Copilot.** Gates G1–G4 remain open, as they were for
0.3.6, 0.3.7 and 0.3.8.

---

## 1. What 0.3.9 changes

| Area | What it now does |
|---|---|
| Direct ingestion | Text-bearing **PDF** (pypdf, page by page) and **DOCX** (python-docx, item by item) are indexed into the same SQLite/BM25 store as Markdown and text, with the original document's provenance on every chunk. |
| Provenance | Each source records `kind`, `sha256` of the source bytes, `parser`, `chunker`, `coverage` (units read / with text / empty / failed / batches), `warnings`, and an `outcome` of `complete`, `partial` or `failed`. Each chunk carries `unit_kind`, `unit_index` and a character range, and its locator names a page or an item of the original file. |
| Freshness | The indexed version and the file on disk are separate facts. `verify_sources` re-reads each indexed source and records `verified`, `changed`, `missing` or `inaccessible` with the time of the check. Exports exclude stale and unverified references by default and report how many they dropped. |
| Transactional reindex | One `index_corpus` call is one transaction and leaves exactly one `index_runs` row — including a cancelled run. A partial or failed read never replaces an indexed version unless the operator passes `accept_partial: true`. |
| Migration | Schema 3, reached from 1 or 2 by additive `ALTER`s only. Migrated rows are labelled `legacy` / `unchecked` and never back-filled. Backup works on an unmigrated store; restore stages a candidate and only `confirm: true` activates it. |
| Topic skill bundles | A generated catalog (`extension/bundles/catalog.json`), a staged hash-verified installer (`extension/bundles.js`), receipts under `.research-toolkit/bundles/`, conflict and user-edit preservation, an upgrade path, and five new control-panel / Command Palette commands. |
| First bundle | `theological-research` 2.0 — 11 files, 60 825 bytes, packaged, installable, **not publishable** (licence unresolved). |
| Second bundle | `document-corpus-bridge` 2.0 — 1 file, 6 972 bytes: the PDF/DOCX indexing workflow, replacing the 0.3.8 derived-Markdown workaround (DD9-23). Toolkit-authored, repository UNLICENSED, so packaged but not publishable. |

## 2. Contracts that were held fixed

- **Chunk identity does not change.** A Markdown or text chunk keeps the 0.3.8 identity formula byte for
  byte (`paragraph-window-v1`). `tests/test_ingestion.py` recomputes the 0.3.8 `chunk_id` and `content_id`
  independently of the module and asserts equality. PDF and DOCX get their own chunker ids
  (`pdf-page-window-v1`, `docx-item-window-v1`), so a new kind can never silently renumber an old one.
- **Migration is additive.** No table is rebuilt, no column is dropped, no stored value is rewritten.
- **Reads never migrate.** An unmigrated store answers `STORE_SCHEMA_UPGRADE_REQUIRED`; the component step
  is what migrates, and it keeps a backup.
- **The worker overlay was not widened.** `extension/runtime.js` and `scripts/build_worker_bundle.py` still
  accept only `.github/skills/<id>/SKILL.md`. Bundles are a separate, separately audited payload group.
- **One constant bounds the store and the retrieval candidate set together** (`MAX_STORE_CHUNKS = 20000`),
  so a search cannot be shown a chunk the store refused to keep.

## 3. Verified in this container

| Claim | Evidence |
|---|---|
| PDF and DOCX are indexed with page/item locators, coverage, warnings and outcome | `tests/test_ingestion.py` (14 cases), including a PDF built in the test from a decoded content stream and a DOCX built with python-docx |
| A page that fails to parse is attributed, not swallowed | `UNITS_UNREADABLE` with `page=N:PDF_PAGE_PARSE_FAILED: <ExcType>`, proven by a reader monkeypatched to raise |
| A source that changes mid-read is detected | re-hash after the last batch → `SOURCE_CHANGED_DURING_INDEX`, previous version kept |
| Freshness works through real MCP, not only a Python call | `extension/functional_check.py` calls `verify_sources` over an MCP client, confirms the indexed source, then reports it `changed` after the file is edited under the index (`freshnessVerified: true`, `changedSourceDetected: true`) |
| Partial acceptance is opt-in | `tests/test_freshness.py`: a refused partial lands in `keptPreviousVersion` with the reason; nothing incomplete is written |
| A cancelled run still leaves a receipt | `index_runs` row written through `_connect(root, create=True)` |
| Schema 3 migration against a **real 0.3.8 store** | `tests/test_migration.py` exports `v0.3.8` with `git archive`, runs **that** code to build the store, then opens it with 0.3.9: read refused, `init_store` migrates to 8 tables, chunk ids preserved, migrated row `legacy`/`unchecked`/`last_verified_at = NULL` |
| Backup and restore on an unmigrated store | same file: backup reports `schemaVersion: 2` and `counts.index_runs: 0`; restore stages, then activates only with `confirm=True`, previous store preserved |
| CLI verbs the panel calls | `tests/test_stdio.py`: `index-corpus` prints a receipt a cp1252 stream can hold; `verify-sources` reports freshness without touching the source; a source outside the workspace is refused |
| Bundle install, idempotence, user-edit preservation, repair | `extension/test/bundles.test.js` (18 cases) and `evidence/…/bundle-install-proof.json`, which drives the shipped module against a disposable workspace: 11 installed → second install writes 0 → an operator edit is `user-modified` and left alone → repair reports the drift and reinstalls 10 |
| The packaged artifact carries the bundle **and the module that reads it** | `evidence/…/vsix-audit.json` (101 members, `sourceFilesMatch: true`) and `evidence/…/payload-check.json` (`result: passed`), which loads the packaged `extension.js` |
| The artifact is reproducible from the reviewed tree | same audit: byte-equal members, LF endings, 0644 modes, no build-clock stamps |
| Locks pair after the version bump | `lockintegrity-cli.json` (`"problems": []`), `uv-lock-check.txt` with the pinned uv 0.13.6 |
| Suites | `python-suite.txt`: **257 passed, 1 skipped**. `node-suite.txt`: **355 tests, 355 pass, 0 fail, 0 skipped** — the packaged-artifact gate in `hosttools.test.js` ran instead of skipping, because a 0.3.9 artifact now exists |

## 4. Not verified here, and what that means

- **No Windows 11 install, no VS Code Extension Host, no Copilot.** `check:payload` runs the packaged
  `extension.js` against a synthetic harness. It proves the payload loads and registers its 30 commands; it
  does not prove the panel renders in a real webview or that a user can click through an install.
- **Skill discovery is unproven.** Every bundle receipt carries `hostDiscoveryVerified: false` and
  `workflowTested: false`, each with a written reason. "Files installed" is the only claim an automated
  install makes.
- **The reading check does not index a PDF or a DOCX.** It indexes a Markdown fixture and then verifies it.
  PDF and DOCX are proven by the Python suite only.
- **The bundle's optional lookup script was never run.** `scripts/crossref_lookup.py` makes outbound
  requests when a user runs it; the audit lists it under `outboundNetworkMembers`.
- **The licence of the theological bundle is unresolved.** `publishable: false` is enforced by the catalog
  generator, the catalog reader and the VSIX audit. Author consent is a human decision, not a code fix.
- **G1–G4 remain open**, and the 0.3.8 field re-run (T8-18) is still outstanding.

## 5. Defects found by the gates during this release

1. **`extension/bundles.js` was not packaged.** `extension/scripts/package.js` stages an explicit list; the
   bundle payload directory was added, the module was not. `npm run check:payload` failed with
   `Cannot find module './bundles'` while loading the packaged `extension.js`. Without that gate this
   shipped as an extension that activates and then fails to load.
2. **`planInstall` reported every file as `new` when the caller supplied no hashes.** The control panel is
   exactly such a caller, so it would have offered to rewrite eleven files that were already the reviewed
   bytes and called an operator's edit something it never installed. `planInstall` now observes the
   workspace itself when no hashes are handed in; `installBundle` already did.
3. **`scripts/check-installed-payload.js` still asserted the 0.3.8 surface** (19 tools, 25 commands, a
   10-tool corpus preset). Updated to 20 / 30 / 11, each with the reason beside it.
4. **`tests/test_vsix.py` hard-coded `worker-0.3.8` in its stale-documentation fixture.** After the guides
   moved to 0.3.9 the fixture matched nothing and the gate proved nothing. The fixture now derives the
   version from `extension/vsix-manifest.json`.
5. **Two packaged guides understated the store** — `research-record-store.md` said schema 2 / seven tables
   and five verbs; `research-corpus-index.md` never mentioned `verify_sources`, PDF or DOCX. Both now
   describe what 0.3.9 actually does, because an operator follows those texts.
6. **A reviewed template was being skipped by every gate, and its instruction was already false.**
   `templates/recommended-overlay/.github/skills/document-corpus-bridge/SKILL.md` (authored 5 November) was
   absent from `scripts/build_worker_bundle.py`'s allowlist, so it was never packaged, while its text told
   the operator to stage derived Markdown because the indexer refused PDF and DOCX. DD9-23 is now
   implemented: it ships as the reviewed bundle **document-corpus-bridge 2.0** (1 file, 6 972 bytes) with the
   0.3.9 workflow — direct ingestion, coverage and warnings read from the receipt, `page=N` / `item=N`
   locators, `verify_sources` before a citation, derived Markdown only as the refusal fallback — and
   `assert_overlay_tree_is_reviewed` refuses a worker build whenever the overlay tree holds a template the
   allowlist does not name.

## 6. Open items, in order of value

1. Licence consent for `theological-research` (blocks `publishable`).
2. A Windows 11 / VS Code / Copilot pass: install the VSIX, run the control panel, install a bundle in a
   real workspace, and record whether the assistant discovers the skill.
3. `references/theology-and-social-sciences.md` still says "Anchors verified in this session" — recorded in
   [bundle-notes.md](bundle-notes.md), not edited.
4. `dedupe_records.py` drops records at 0.92 title similarity; it now reports them on stderr instead of
   silently, and its report is unbounded.
5. `evals.json` in the bundle has never been scored.
6. The bundle's `USER_AGENT` carries a placeholder contact address.
7. T8-18 (the 0.3.8 field re-run) is still open.

## 7. Numbers

| | |
|---|---|
| Python suite | 257 passed, 1 skipped (258 collected) — 34 new cases in `test_ingestion.py`, `test_freshness.py`, `test_migration.py`, 3 CLI-verb cases in `test_stdio.py`, 2 overlay-tree cases in `test_lock_consistency.py` |
| Node suite | 355 tests, 355 pass, 0 fail, 0 skipped, 17 test files — 19 bundle cases |
| Shipped tool surface | 20 unique tools (5 document, 5 research, 10 store); `corpus-lab` 11; per-preset ceiling 12 |
| Commands | 30 contributed, 30 registered |
| VSIX | 101 members, 400 486 bytes, unpacked 1 216 022 of the reviewed 1 310 720 ceiling |
| Artifact SHA-256 | `d5fe4675b4a9f3d1e489cfdff28ea1f8e4bc67ae05e7720db008dbc33f698ee4` |
| Bundle catalog | 2 bundles, 12 files, 67 797 bytes, both `publishable: false`, 1 unresolved licence |
| Store schema | version 3, 8 tables, supported for reading 1, 2 and 3 |
