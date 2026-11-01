# Checklist — store integrity and evidence durability (F01–F05, F13, F14)

Findings addressed: F01 containment, F02 dangling evidence, F03 duplicate content, F04 empty re-index, F05 backup semantics, F13 schema/read-only/error contracts, F14 claim limits.

## F01 — containment

- [x] `paths.assert_contained` rejects absolute paths, drive letters, roots and `..` traversal.
- [x] `paths.assert_no_redirect` rejects symlinks, junctions (`os.path.isjunction`) and reparse points (`st_reparse_tag`) on every existing component between the root and the target.
- [x] `paths.contained_write_path` re-checks at the write boundary.
- [x] Store directory, store file, backup directory and lab-state file all go through the guard.
- [x] `workspace.initialize_workspace` template destinations go through the guard (`.github` junction case).
- [x] Probe `store-junction` no longer writes outside the workspace.
- [x] Probe `cli-junction` no longer writes outside the workspace.

## F02 — evidence durability

- [x] Re-index marks replaced chunks non-current instead of deleting them.
- [x] Retained chunks keep source version, locator, text and text hash.
- [x] Retrieval searches current chunks only.
- [x] `claims_read` reports `resolvable`, `current` and `stale` per link.
- [x] Removal keeps referenced evidence and reports what was retained.
- [x] Garbage collection of unreferenced non-current chunks is explicit and confirmed.
- [x] Probe `danglingEvidenceAfterReindex` now reports retained, flagged evidence.

## F03 — duplicate content

- [x] `chunk_id` is a per-occurrence identity (path + source version + chunker + locator + text hash).
- [x] `content_id` keeps the content-only identity.
- [x] Two identical files index into two rows with correct per-source chunk counts.
- [x] Probe `duplicateContent` succeeds instead of raising `IntegrityError`.

## F04 — empty sources

- [x] `full.scan_sources` validates and hashes every selected path independently of chunking.
- [x] A zero-chunk source still gets a current inventory row.
- [x] Re-indexing an emptied file removes its previous membership.
- [x] The response names the empty source explicitly.
- [x] Probe `emptyReindex` no longer returns the old "guild" evidence.

## F05 — backup and restore

- [x] Backup destination is reserved with exclusive creation and a collision-proof name.
- [x] Snapshot uses `sqlite3.Connection.backup` (safe with concurrent clients).
- [x] Integrity is validated (`PRAGMA quick_check`) and counts/schema recorded.
- [x] SHA-256 of the snapshot is reported.
- [x] Restore validates the backup, stages a candidate, verifies it, and activates only with `confirm=true`, preserving the previous live store.
- [x] Probe `backupCollision` produces two distinct files.

## F13 — schema, read-only and error contracts

- [x] `schema_version` is validated before any mutation; newer → `STORE_SCHEMA_UNSUPPORTED`.
- [x] Supported older schema → explicit migration; existing store without a version → `STORE_SCHEMA_UNKNOWN`.
- [x] Read paths open `mode=ro` and run no DDL or inserts.
- [x] `reindex_preview` creates nothing.
- [x] `sqlite3` failures map to `STORE_CONSTRAINT`, `STORE_BUSY`, `STORE_CORRUPT`.
- [x] `FullPrototypeError` is translated at the `records` boundary so the lab wrapper sees only `StoreError`.
- [x] Probes `futureSchema`, `readRepairsDatabase`, `previewOnFreshWorkspace`, `missingSourceEnvelope` produce the fixed outcomes.

## F14 — claim editing and discovery

- [x] Status filtering happens in SQL before `LIMIT`.
- [x] Keyset cursor pagination returns every stored claim.
- [x] Same-second identical statements do not collide.
- [x] `idempotency_key` returns the existing claim.
- [x] Evidence links carry role and rationale and support append/replace/remove.
- [x] Omitted `status`/`note` are left unchanged on update (patch semantics).
- [x] Claim mutations append to `claim_events`.
- [x] The accumulated link count is bounded, not just the submitted batch.
- [x] `supported` is reported as a recorded assessment.
- [x] Probes `claimFiltering` and `sameSecondClaim` produce the fixed outcomes.
## Verification status — 31 October 2026

Every item above is implemented and covered by the Python suite (`test/test_records.py`,
`test/test_workspace.py`, `test/test_paths.py`) and by the re-run review probes recorded in
[`evidence/quality-v0.3.5-2026-10-31/python-probe-results.json`](../../../../evidence/quality-v0.3.5-2026-10-31/python-probe-results.json)
(`duplicateContent`, `emptyReindex`, `danglingEvidenceAfterReindex`, `backupCollision`, `futureSchema`,
`readRepairsDatabase`, `previewOnFreshWorkspace`, `missingSourceEnvelope`, `claimFiltering`, `sameSecondClaim`,
`store-junction`, `cli-junction`).

Residual limit: the junction fixtures are exercised as POSIX symlinks on this Linux host. Windows
`mklink /J` reparse-point fixtures are implemented (`os.path.isjunction`, `st_reparse_tag`) but have not been
run on a Windows host, so T5-01 is Partial until that fixture runs.
