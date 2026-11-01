# Research record store

Keep claims and their evidence links in one local, inspectable file.

## Setup

The **Corpus index and record store** component step (Full package) creates `.research-toolkit/store/research.sqlite3` with the reviewed schema version 2: `meta`, `sources`, `source_versions`, `chunks`, `claims`, `claim_evidence` and `claim_events` — seven tables, and SQLite's own internals are not reported as part of the schema. The managed worker serves `claims_read`, `claims_write`, `claims_export`, `evidence_read` and `store_maintenance`. A store written by schema version 1 is migrated explicitly; a store from a newer schema is refused rather than relabelled. The store is a workspace file: it is not packaged in the VSIX, not shared between workspaces, and it is ignored by the bootstrap workspace's `.gitignore` because it holds copied source text. These verbs reach the assistant through the **Full research workflow** preset (the Full default) or the **Index, search and record claims** preset; both require the corpus index and record store step.

## First task and readiness

Write a claim with `claims_write` and link it to chunk ids already in the index (`evidence_chunk_ids: ["<chunk_id>"]`, optionally with `evidence_role` and `evidence_rationale`), then read it back with `claims_read`: every link reports `resolvable`, `current` and `stale`, and the claim carries its edit history. `claims_write` with a `claim_id` patches that claim instead of creating a duplicate, and an `idempotency_key` makes a retried write return the original. `claims_export` turns stored claims into report references only when the named file still exists with the recorded hash. `store_status` reports source, chunk and claim counts plus the index fingerprint; `store_maintenance` with `action: "backup"` writes a validated snapshot to a new file under `.research-toolkit/store/backups/` (never overwriting an earlier one), and `action: "restore"` stages a candidate that only becomes the live store after you confirm it, preserving the previous one. Ready means the reading check created a claim, linked it to a stored chunk, resolved the evidence, exported it, read it back, created a backup, staged a restore without activating it, and refused an unconfirmed vacuum.

## Troubleshooting and limits

`EVIDENCE_NOT_FOUND` means the chunk id is not in the index — run `index_corpus` first. `CLAIM_NOT_FOUND` means the id does not exist yet; create it. `CONFIRM_REQUIRED` blocks `vacuum` until you pass `confirm: true` after reviewing `status`. Limits: 2000 claims, 2000 characters per statement, 200 evidence links per claim. Mutating actions are separated from reads so the assistant's approval UI can gate them. DuckDB, Qdrant and other engines remain unselected candidates; this store uses only the Python standard library.

## Current documentation

[Current official documentation](https://github.com/michaelprinc/VS-Code-Research-Stack). Local onboarding reviewed on 31 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
