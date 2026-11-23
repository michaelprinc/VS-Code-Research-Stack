# Store upgrade path measured across releases — T8-18 re-run, 2026-11-23 (part of T16-12)

**What this closes.** The 0.3.8 field retry recorded in
[evidence/quality-v0.3.8-2026-11-04/encoding-matrix.txt](../quality-v0.3.8-2026-11-04/encoding-matrix.txt)
line 18 measured `research-stack init-lab` twice on a workspace on **this** host, and the phase-16
acceptance row said plainly that repeating it today would not be the same measurement, because the store
from 0.3.8 is on an older record schema. That was a reasoned statement. It is now measured, and the
reasoning turned out to be right in its shape and wrong in one number: the 0.3.8 store is on **schema 2**,
not schema 1.

**How it was measured, so it can be repeated.** The 0.3.8 code was taken from the release commit
`7638898` (`git archive 7638898` into a scratch directory) and was not edited. Two fresh workspaces were
built **by that code**, each holding one text source with a Czech title line. Then the 0.3.15 working tree
read those stores. Full command output: [commands-and-output.txt](commands-and-output.txt).

## 1. What 0.3.8 built

```
schemaVersion 2, tableCount 7  (chunks, claim_events, claim_evidence, claims, meta, source_versions, sources)
preexisting: false
```

`SCHEMA_VERSION = 2` and `SUPPORTED_SCHEMA_VERSIONS = (1, 2)` in `records.py` at that commit, so the store
this build produced is the store an operator would still have from 0.3.8.

## 2. What 0.3.15 says when it meets that store, before any migration

| Verb | Result on the un-migrated store |
|---|---|
| `search_store("canon law")` | refused — `STORE_SCHEMA_UPGRADE_REQUIRED: schema version 2 must be migrated before reading. Run the corpus index and record store component step.` |
| `stored_chunks()` | refused — the same named refusal |
| `store_maintenance("status")` | refused — the same named refusal |
| the store file itself | **unchanged**, `schema_version` still `2` after all three refusals |

A refusal that mutates the store would be worse than the defect it prevents; the recorded schema was read
back after each refusal and had not moved.

## 3. What 0.3.15 can still do on that store, and what it refuses to invent

`store_maintenance(action="backup")` succeeds **before** migration, which is the 0.3.6 guarantee this build
is required to keep:

```
backup  -> research-2026-11-23T093741Z-f5c5b7.sqlite3, new-file-only, consistentSnapshot: true,
           sha256 843e6f75945f6e639e1ae892c262f0f3cdb804300f81e47cecda56de5faaa89f, 77 824 bytes
schema_version after the backup: 2   (no migration was smuggled in)
labState: refreshed: false, reason: STORE_SCHEMA_UPGRADE_REQUIRED,
          "the derived record was not rewritten with counters it did not measure"
```

The lab-state record is the part worth reading: the build does not write counters it could not measure. It
names the block and points at the store step.

## 4. The migration, and what the store is afterwards

`research-stack init-lab` (the corpus index and record store step) migrates 2 → 3 → 4 additively:

```
schemaVersion: 4, preexisting: true
tables gained: chunk_vectors, index_runs   (7 → 9)
meta: schema_version = 4, migrated_from = 2
```

Additive means no table is rebuilt and no stored chunk row is rewritten, so a chunk id — a hash of its
content — keeps citing the claims that reference it.

After the migration the store is an ordinary current store, and all three retrieval modes answer on it:

| Mode | First score | Counters |
|---|---|---|
| `lexical` | 1.5234 | `method: bm25` |
| `vector` | 0.45608 | `currentChunks: 2, scoredChunks: 2, refusedStaleVectors: 0, chunksWithoutVector: 0` |
| `hybrid` | 1.0 | `candidatePool: 2, hitsFoundByBoth: 2`, weights 0.5 / 0.25 / 0.25, `reciprocalRankConstant: 60` |

`vector_index_state` after the migration: `state: ready`, `backendId: rsk-hashing-v1`, `dimensions: 256`,
`vectorCount: 2`, `scoreableChunks: 2`.

## 5. Restoring the pre-migration backup is allowed, and says so afterwards

`store_maintenance(action="restore")` staged the schema-2 backup (`validated.schemaVersion: 2`,
`integrityCheck: ok`, `activated: false, stagedOnly: true`), and the confirmed run activated it. The store
was then on schema 2 again, and the next read answered the same named refusal, pointing back at the store
step. So a restore from a 0.3.8-era backup is not a silent upgrade and not a broken state: it is a
recorded state with a named way out.

## 6. What this does **not** prove

This is a store built by archived 0.3.8 code on **this** host, not the operator's own 0.3.8 workspace from
2026-11-04. The original workspace's file is not in the repository and its contents were not re-read. What
migrated here is a schema-2 store with the tables that release wrote; an operator store that was
hand-repaired, or that has claims and evidence accumulated since, is a different file and this run does not
speak for it. The claim this run supports is the shape of the path — named refusal before migration,
backup before migration, additive 2 → 4, readable afterwards, restore reversible — not a measurement of any
particular operator's data.
