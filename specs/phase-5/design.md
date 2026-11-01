# Phase 5 design — 0.3.5 stabilization

Decisions D5-01…D5-14 are the implemented design. Each names the finding it resolves and the module that carries it.

## 1. One containment policy (F01)

`src/research_stack/paths.py` becomes the single guard:

- `assert_contained(root, relative)` — rejects absolute paths, drive letters, roots and `..` traversal.
- `assert_no_redirect(root, target)` — walks every existing component from `root` down to `target` and refuses symlinks (`is_symlink`), Windows junctions (`os.path.isjunction`) and any reparse point (`st_reparse_tag != 0`); then requires `realpath(target)` to stay under `realpath(root)`.
- `contained_write_path(root, relative, *, must_exist=False)` — the combination used by every toolkit-owned write; the check runs again immediately before `open(..., "x")`.

Applied to: `records.store_path`/store directory/backup directory, `workspace.initialize_workspace` template destinations, `workspace.init_lab_workspace` lab-state file, `documents` report outputs, `recommended_server.prepare_zotero_import`.

JavaScript side: `runtime.directory()` already refuses linked managed directories; 0.3.5 adds `runtime.linkInfo()` (uses `Stats.isJunction()` when the host provides it) and preflights `notebooks/analysis/.venv`, the store directory and the backup directory before the subprocess that would write through them.

## 2. Store schema version 2 (F02, F03, F04, F13, F14)

| Table | Role |
|---|---|
| `meta` | `schema_version`, `created_at`, `index_fingerprint`, `indexed_at` |
| `source_versions` | immutable content identity: `source_sha256` primary key, first-seen timestamp, byte size |
| `sources` | **current inventory** per workspace-relative path: `path` primary key, `current_sha256`, `bytes`, `chunk_count`, `indexed_at` (a zero-chunk source still has a row) |
| `chunks` | one row per **occurrence**: `chunk_id` primary key = hash(path, source_sha256, chunker fingerprint, locator, text hash); `content_id` = hash(source_sha256, chunker fingerprint, locator, text hash); `current` flag separates live index membership from retained evidence |
| `claims` | statement, status, note, `idempotency_key` (unique), created/updated |
| `claim_evidence` | claim ↔ chunk occurrence, with `role`, `rationale`, `added_at` |
| `claim_events` | append-only edit history: claim id, kind, detail, timestamp |

Rules:

- **Retention.** A re-index marks the replaced path's chunks `current = 0` instead of deleting them. Chunks that are no longer current **and** unreferenced by any claim are garbage-collected only by an explicit confirmed `store_maintenance` action. Retrieval searches `current = 1` only.
- **Inventory.** `full.scan_sources()` validates and hashes every selected path and returns a source record even when it produces zero chunks; `index_corpus` writes the inventory row for each selected path, so an emptied file loses its old membership.
- **Identity.** Occurrence ids make duplicate content at two paths two rows; `content_id` keeps the deduplication signal.
- **Schema lifecycle.** `open_store` reads `schema_version` before any write: newer → `STORE_SCHEMA_UNSUPPORTED`; older supported version → explicit migration function; existing store without a version → `STORE_SCHEMA_UNKNOWN`. Reads use `mode=ro` URIs and never run DDL.
- **Error translation.** `sqlite3.IntegrityError/OperationalError/DatabaseError` are translated to `StoreError` codes `STORE_CONSTRAINT`, `STORE_BUSY`, `STORE_CORRUPT`; `FullPrototypeError` is translated at the `records` boundary so the lab wrapper only ever sees `StoreError`.

## 3. Backup and restore (F05)

- `backup`: reserve `backups/research-<stamp>-<token>.sqlite3` with `O_CREAT|O_EXCL`, then `sqlite3.Connection.backup()` into it (safe with concurrent clients), then `PRAGMA quick_check`, counts, schema version and SHA-256 of the snapshot.
- `restore`: validate the chosen backup (quick_check + schema compatibility), stage it as `store/research-restore-<stamp>.sqlite3`, verify the candidate, and only with `confirm=true` move the live store to `store/research-pre-restore-<stamp>.sqlite3` and activate the candidate. Without confirmation the candidate is reported and the live store is untouched.
- `vacuum` keeps the confirm rule and additionally collects unreferenced non-current chunks.

## 4. Claims API (F14)

- SQL-side filtering (`WHERE status = ?`) before `LIMIT`; keyset cursor on `(updated_at, claim_id)` returned as `nextCursor`.
- `claim_id` = hash(statement, timestamp, random token) with a bounded retry; `idempotency_key` returns the existing claim with `created: false, idempotent: true`.
- `claims_write` takes `evidence_chunk_ids`, `evidence_role`, `evidence_rationale` and `evidence_mode` in `append | replace | remove`; omitted `status`/`note` are left unchanged (patch semantics) instead of silently reset.
- Every mutation appends a `claim_events` row. `claims_read` returns `evidenceAssessment` stating that status is a recorded judgement.

## 5. Setup lifecycle (F06, F07, F08, F09)

- `installer.resolveStepSelection(packageId, requested, {receipt, workerVersion})` returns `{steps, added, satisfied}`: the closure is expanded, prerequisites already verified as installed are accepted, unknown steps are still refused. All four entry points use it.
- `installer.verifyStepArtifacts(step, root, context)` returns `{state, evidence}` where state ∈ `verified | missing | outdated | needs-repair | modified-preserved`. `stepStatus` combines the recorded receipt with the observation; `planView` exposes both. `runPlan` re-runs a recorded-current step whose artifacts are not verified (repair) and reports it as repaired.
- Overlay classification compares each existing destination with the bundled hash: identical → `current`, different → `modified-preserved` (never overwritten, reported in the step evidence and plan).
- Runtime activation: `.research-toolkit/managed/active.json` records `{workerVersion, worker, verifiedAt, check}`. Setup stages `worker-<version>`, verifies with the functional check, then writes the pointer atomically. `discoverInstallations(root)` reads every `managed/worker-*` receipt, so a 0.3.4 install is found by 0.3.5. `researchToolkit.rollbackRuntime` re-activates a previously verified runtime after confirmation.
- Notebook ownership: before `uv sync` the step compares `notebooks/analysis/{pyproject.toml,uv.lock,.python-version}` with the bundle. Absent → owned. Identical → owned-current. Different → accepted only if the existing project declares the reviewed requirements (ipykernel, matplotlib, requires-python); otherwise the step stops with `NOTEBOOK_PROJECT_foreign` guidance and runs no package management. After sync the interpreter **and** `import ipykernel, matplotlib` are verified.
- Receipts: write to `installation.json.tmp-<token>`, verify it parses, then rename over the target. The plan-wide lock is taken by `runPlan` (not only by `setupRuntime`).

## 6. Continuous workflow and tool surface (F10, F16)

Managed tools in 0.3.5 (16 distinct verbs):

| Server | Tools |
|---|---|
| `research_stack.mcp_server` | `read_document`, `read_text_source`, `search_local_text`, `write_markdown`, `write_docx` |
| `research_stack.recommended_server` | `search_literature`, `check_citation`, `zotero_collections`, `zotero_item`, `prepare_zotero_import` (+ deprecated `search` alias for the unmanaged `all` preset only) |
| `research_stack.lab_server` | `index_corpus`, `search_corpus`, `evidence_read`, `claims_read`, `claims_write`, `claims_export`, `store_maintenance` |

Presets (toolkit counts): `read-and-cite` 4, `find-in-notes` 3, `verify-citations` 2, `zotero-handoff` 5, `research-core` 9, **`research-workflow` 11 (new Full default)**, `research-lab` 9 (+ external estimates), `research-lab-max` 9 (+ external estimates), `corpus-lab` 8.

- `research-workflow` = 4 document verbs + `search_literature`, `check_citation` + 5 corpus/claims verbs = 11 toolkit tools, 117 tools of headroom.
- `read_text_source(path, start, count)` reads Markdown/text with the same paragraph/character locator vocabulary the search returns, plus adjacent context.
- `evidence_read(chunk_ids)` hydrates stored chunks (path, locator, text, hashes, `current`).
- `claims_export(claim_ids)` returns validated reference entries (label, reference with locator, sha256, resolvable flag) that `write_markdown`/`write_docx` accept as `sources`, plus `evidence_chunk_ids` on both writers so unresolved evidence is refused before export.
- `documents.report_model()` produces one block list (heading, paragraph, bullet, numbered, table, citation) rendered by both writers.

## 7. Preset identity and client state (F11, F12, F17)

- `presetSignature(preset, servers)` = `sha256(runtimeVersion | presetId | sorted tool names | sorted server modules)`; the MCP definition version becomes `<runtimeVersion>+<presetId>+<hash8>`. Applied state is recorded when the provider hands out definitions, so the panel can show *saved* versus *applied*.
- Control panel: setup/update buttons carry no `data-action`; the generic handler ignores elements with a dedicated handler; one message per click, correlated with a `requestId`.
- `toolSurface` is cleared on folder/trust/extension change; measurement is `measured` only when every preset tool was found, otherwise `partial` (mixed) or `estimated`; external counts are labelled vendor estimates.
- Configuration is read with the selected `WorkspaceFolder` scope and the panel's workspace save writes `ConfigurationTarget.WorkspaceFolder` when a folder is available; recently used presets are listed first in the Quick Pick.

## 8. Extraction and metadata (F15)

- DOCX: iterate `document.element.body` children in order, mapping `w:p` → paragraph and `w:tbl` → table rows, so a paragraph/table/paragraph document extracts in that order with `kind: table-N-row` locators.
- DOI: strip URL prefixes, unescape, lowercase, then remove trailing delimiters only when unbalanced, so `10.1234/example(2026)` survives intact.
- Merge: keep the first observed value as the displayed value and record every distinct observation with its provenance in `observations`; recompute `evidenceScope` and `access` from the merged values.
- Provider rows: validate nested shapes, skip malformed rows with a `PROVIDER_ROW_SKIPPED` warning.
- Result state: `complete` (all providers succeeded, ≥1 record), `empty` (all succeeded, 0 records), `partial` (some succeeded), `unavailable` (none succeeded).
- `validate_citation` uses the same Crossref request policy (mailto/User-Agent headers) as search.

## 9. Test strategy (F18)

Each reproduced defect becomes a named regression test with the review's evidence key in its name (`duplicateContent`, `emptyReindex`, `danglingEvidenceAfterReindex`, `backupCollision`, `futureSchema`, `readRepairsDatabase`, `previewOnFreshWorkspace`, `missingSourceEnvelope`, `claimFiltering`, `sameSecondClaim`, `docxOrder`, `doi`, `merge`, `providerNullAuthors`, `allProvidersFail`, `storeJunction`, `cliJunction`, `notebookVenvJunction`, `quickPickStep`, `partialUpdate`, `repairAfterInterpreterRemoved`, `overlayConflict`, `legacyUpgradeDiscovery`, `setupButtonClickMessages`, `presetIdentity`, `folderSwitch`, `notesReopen`, `unvalidatedCitation`). Windows-only link fixtures use junctions (`fs.symlink(..., "junction")`, `os.path.isjunction`) so no elevated privilege is required.
