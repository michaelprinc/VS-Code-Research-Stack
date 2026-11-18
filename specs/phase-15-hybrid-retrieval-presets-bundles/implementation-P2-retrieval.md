# Package P2 — hybrid retrieval in the store (HR-01…HR-06, HR-32, DD15-02)

Implemented against the 0.3.13 baseline (`6719415`). No version string was bumped, no dependency was
added, and nothing under `extension/**` was written by this package — the extension-side pairing
(`presets.py`, `extension/presets.json`, `functional_check.py`, the worker bundle) is recorded below as
done by the release packages, with the measurements this package supplied for them.

Files this package changed:

| File | Change |
| --- | --- |
| `src/research_stack/vectors.py` | new: the embedding backend (stdlib only) |
| `src/research_stack/records.py` | schema 4, `chunk_vectors`, retrieval modes, fusion, derived lab-state, `draft` |
| `src/research_stack/lab_server.py` | `mode` on `search_corpus`, new `embed_corpus` verb, titles/annotations |
| `src/research_stack/workspace.py` | lab-state is derived, `vectorSearch` no longer says `not-implemented` |
| `tests/test_vector_retrieval.py` | new, 17 tests (T15-01…T15-06) |
| `tests/test_lab_state.py` | new, 9 tests (T15-07, T15-08) |
| `tests/test_records.py`, `tests/test_lab_server.py` | `draft` accepted, unknown status still refused (T15-09) |
| `tests/test_migration.py` | a real 0.3.13 store opens, gains `chunk_vectors`, loses no row |
| `tests/test_workspace.py`, `tests/test_stdio.py` | table count 8 → 9 (an additive table changes the count; the tests were measuring it) |

`src/research_stack/cli.py` was deliberately not touched: `tests/test_stdio.py` byte-compares the shipped
worker copy of `cli.py`, and `cli.py` carries no retrieval verb.

---

## 1. The backend (HR-01, T15-02)

`src/research_stack/vectors.py` builds a **fixed-dimension lexical signature** over text. It is not an
embedding model, and the module says so in its docstring and in `backend_status()['nature']`:
`"lexical signature, not a trained semantic model"`.

Named, versioned constants — the recipe is the contract, and a stored vector names it:

| Constant | Value |
| --- | --- |
| `BACKEND_ID` | `rsk-hashing-v1` |
| `EMBEDDING_DIMENSIONS` | `256` |
| `TOKENIZER_ID` | `unicode-word-v1` |
| `CHAR_NGRAM_SIZES` | `(3, 4)` |
| `TOKEN_WEIGHT` / `NGRAM_WEIGHT` | `1.0` / `0.5` |
| `QUANT_SCALE` | `32767.0` |
| `VECTOR_ENCODING` | `base64-int16-le` |

Recipe, in the order the code runs it:

1. `normalise_text` — NFC, `casefold()`, whitespace collapse.
2. Features: word tokens **plus** character 3- and 4-grams. A gram counts only if it contains a letter or
   digit (`[^\W_]`), so punctuation runs contribute nothing.
3. Each feature hashes to a bucket and a sign: `sha256(f"{kind}\0{feature}")`, `digest[:4]` → bucket in
   `0..255`, `digest[4] & 1` → `+1/-1`. Signed feature hashing, no learned weights.
4. Weight per feature: `1 + ln(count)` (sublinear, so a spammy chunk cannot dominate a bucket).
5. Features are summed in **sorted feature order**, so summation is independent of counting order — the
   vector is reproducible across runs, processes and interpreters.
6. L2 normalised. Quantised to signed 16-bit and stored as base64 of `struct.pack('<256h', …)`.

`VectorError(ValueError)` codes: `VECTOR_INPUT` (empty/non-text input), `VECTOR_DIMENSION` (length
mismatch in `cosine_similarity`), `VECTOR_ENCODING` (undecodable stored vector, empty stored vector).

Measured on this host (CPython 3.12.16, single core), all reproducible:

| Measurement | Value |
| --- | --- |
| cosine(text, same text) | `1.0` exactly |
| cosine, same words reordered | `> ` unrelated text (asserted in `test_cosine_separates_shared_word_shape_from_unrelated_text`) |
| cosine, unrelated English pair in that test | below `0.35` by assertion; a separate probe measured `0.208587` |
| cosine, Czech stem variant vs the English query sharing surface forms | `0.641203` in one probe |
| `embed_text("--- ... !!! ???")` | the zero vector; cosine against it is `0.0` |
| encoded vector length | 684 characters per chunk (512 raw bytes) |
| round-trip | `encode_vector(decode_vector(encode_vector(v))) == encode_vector(v)`; `abs(cosine(v, decoded) - 1) < 1e-6` |
| `embed_text` cost | median `1.29 ms` for a 1 320-character chunk; `≈ 26 s` for 20 000 chunks |

**What this does not buy.** The signature matches *surface forms and their spelling neighbourhoods*. It
does not know that two sentences mean the same thing. Unrelated English text measured `≈ 0.21`, not `0`,
so **no cosine threshold is applied anywhere** — the modes rank, they do not decide relevance, and the
backend note in `store_status` says the same thing. The `noise < 0.35` assertion in the test is a floor on
the claim "this must not read as a semantic match", not a filter.

Storage cost, arithmetic from the measured encoding: 684 characters per vector row, so a 20 000-chunk
index carries ≈ 13 MB of vector text before SQLite page overhead. A measured 27-chunk store came to
192 512 bytes total (chunk text included).

Dependency proof (T15-02): `test_the_backend_imports_only_the_standard_library_and_the_package_it_ships_with`
parses the module's own imports and fails on anything outside `base64, hashlib, math, re, struct,
unicodedata, collections, __future__` plus `research_stack` modules — no socket, no urllib, no
`httpx`, no model file. `pyproject.toml` and `uv.lock` were not modified, and `vectors.py` makes no
network call, so it must stay out of `REVIEWED_PYTHON_NETWORK_MEMBERS` in `scripts/verify_vsix.py`.

---

## 2. Vectors in the store (HR-04, T15-01, T15-03)

`SCHEMA_VERSION = 4`, `SUPPORTED_SCHEMA_VERSIONS = (1, 2, 3, 4)`. New table:

```sql
CREATE TABLE IF NOT EXISTS chunk_vectors (
    chunk_id TEXT PRIMARY KEY,
    backend_id TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    text_sha256 TEXT NOT NULL,
    vector TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunk_vectors_backend_idx ON chunk_vectors (backend_id, dimensions);
```

`text_sha256` is the hash of **the chunk text the vector was computed from**, so a vector cannot quietly
outlive the text it describes.

* `index_corpus` writes vectors for the chunks it stores (T15-01). `store_status` counts them
  (`indexState.vectorCount`, and the `vectorSearch` block below).
* `embed_corpus` computes vectors **from the chunk text already in the store** — no source file is opened
  — which is what makes a re-index possible for a store whose sources are gone.
* A vector row is usable only if all three hold: `backend_id == BACKEND_ID`,
  `dimensions == EMBEDDING_DIMENSIONS`, `text_sha256 == chunks.text_sha256`. A row failing any of them is
  counted in `staleVectorCount`, is **never** scored, and the reason is reported (`backend | dimensions |
  text | encoding`).
* `unindex_corpus` deletes vector rows together with the chunk rows they belong to — no orphan vectors
  (`test_removing_a_source_takes_its_vectors_with_it`).
* Retired-row collection includes `chunk_vectors`, so retention and pruning stay consistent.

### Refusal codes added by this package

| Code | When | Message shape (verbatim core) |
| --- | --- | --- |
| `SEARCH_MODE` | `mode` is not `lexical`, `vector` or `hybrid` | `SEARCH_MODE: expected lexical \| vector \| hybrid. The lexical mode is the stored BM25 path.` |
| `VECTORS_MISSING` | chunks exist, no vector rows (HR-06, T15-06) | `VECTORS_MISSING: the index holds {n} current chunks and no stored vectors, so the {mode} mode has nothing to score. Run embed_corpus: it builds the vectors from the chunk text already in the store (backend rsk-hashing-v1, 256 dimensions, no network, no model download). Lexical search on the same store is unchanged.` |
| `VECTOR_BACKEND_STALE` | vector rows exist but none passes the check (HR-04, T15-03) | `VECTOR_BACKEND_STALE: all {n} stored vectors fail the current backend check (expected backend rsk-hashing-v1, 256 dimensions, and a match on the chunk text hash; refused reasons: backend, dimensions, text, encoding). None of them is used. Run embed_corpus to rebuild them, or store_maintenance with action='restore' to return a store that matches this backend.` |
| `VECTOR_INPUT`, `VECTOR_DIMENSION`, `VECTOR_ENCODING` | backend-level input/shape/decode faults | raised as `research_stack.vectors.VectorError` (a `ValueError`) |
| `RESULT_LIMIT` | reused: vector and hybrid modes honour the same limit refusal as lexical | unchanged wording |

Every MCP refusal keeps the 0.3.13 envelope: `{"resultState": "error", "error": {"code", "message"}}`.
`VECTOR_*` codes surface through that envelope as a `StoreError`-shaped refusal with the code as the
message prefix; nothing new was invented for the transport. Existing codes (`STORE_MISSING`,
`STORE_SCHEMA_UPGRADE_REQUIRED`, `STORE_SCHEMA_UNSUPPORTED`, `INDEX_MODE`, `EVIDENCE_NOT_FOUND`,
`CLAIM_STATUS`, `WRITE_CONFIRM_REQUIRED`, …) are unchanged.

---

## 3. Retrieval modes and the fusion rule (HR-02, HR-03, T15-04, T15-05)

`search_corpus(root, query, *, limit=10, mode="lexical")` in `records.py`, and
`search_store(...) -> {"mode", "method", "hits", "retrieval"}` for the receipt form.

**Lexical is the 0.3.13 path, untouched.** Same `search_bm25(stored_chunks(root), …)` call, same ranking,
same hit fields, same verb envelope keys (`hits`, `method`, `persistentIndex`, `readOnly`), and no
`retrieval` key. The proof is not a hand-written expectation: `test_lexical_search_returns_exactly_what_0_3_13_returned`
runs the **pristine 0.3.13 tree** (`git archive 6719415`) in a subprocess, stores the hits it produced,
then compares the migrated store's lexical hits against them — chunk order and every score.

**Vector mode** scores every current chunk whose vector passes the check, by cosine against the query
vector, and names the backend, dimensions, encoding, `scoredChunks` and `refusedStaleVectors` in the
receipt. A query with no letter or digit produces the zero vector and is reported as a zero-signal query
rather than a ranking of nothing.

**Hybrid fusion**, `FUSION_RULE` as stored in the code and reported in the receipt:

> `fusedScore = 0.5 * reciprocal-rank-fusion(k=60, normalised so a chunk ranked first by both rankers
> scores 1.0) + 0.25 * (BM25 score / highest BM25 score in the candidate pool) + 0.25 * (max(0, cosine) /
> highest cosine in the candidate pool); a ranker that did not place the chunk contributes 0. Ties break
> on source path, then locator, then chunk id.`

Constants: `VECTOR_RRF_K = 60`, `FUSION_WEIGHTS = {reciprocalRankFusion: 0.5, lexicalScore: 0.25,
vectorScore: 0.25}` (they sum to 1.0, so a fused score is in 0..1), `MAX_FUSION_POOL = 50`, candidate
pool `min(50, max(limit * 3, 20))`, scores rounded to 6 decimal places. Determinism comes from the
documented tie-break and the fixed pool — the test recomputes `fusedScore` from the published rule and
asserts equality, and a repeated call returns the identical ordering.

Each vector/hybrid hit keeps every 0.3.13 provenance field (`source_path`, `locator`, `text`, `sha256`,
`chunk_id`, …) and adds:

```json
"retrieval": {"mode": "hybrid", "lexicalRank": 2, "lexicalScore": 0.121011,
              "vectorRank": 3, "vectorScore": 0.379179, "fusedScore": 0.979981,
              "backend": "rsk-hashing-v1"}
```

(measured on a 300-line synthetic corpus; `test_hybrid_reaches_a_chunk_the_lexical_ranker_cannot_see` shows a
chunk lexical search cannot reach appearing in the hybrid result, and `test_the_fused_score_is_the_documented_rule_and_ranks_first_by_both_first`
re-derives the number). `retrieval` is deliberately **absent** from lexical hits, so a 0.3.13 client sees
exactly what it saw before.

---

## 4. Migration 3 → 4 (HR-04, and the 0.3.13 upgrade case)

`_migrate_3_to_4` follows the file's existing style: it is called from the same chain
(`1 → 2`, `2 → 3`, `3 → 4`), records `schema_version = 4` and `migrated_from = 3`, and is idempotent — it
returns immediately if `chunk_vectors` already exists, otherwise `executescript(SCHEMA)` (every statement
in that script is `IF NOT EXISTS`).

It adds the table and nothing else. **No vector is invented during a migration**: computing a vector
needs the chunk text and the backend recipe, which is verb work, not schema work. A migrated store is
therefore `not-built` — chunks, no vectors — lexical search works, `vector`/`hybrid` refuse with
`VECTORS_MISSING` naming `embed_corpus`, and `embed_chunks` then makes the index `ready`.

`test_a_0_3_13_store_gains_the_vector_table_and_loses_no_row` builds a real 0.3.13 store (the pristine
tree from `6719415`, driven through its own verbs), then asserts: the store is readable before migration,
row counts of every real table are identical after migration (only `meta` differs), `schema_version == 4`,
`migrated_from == 3`, zero vectors, lexical ranking unchanged, hybrid refuses with `VECTORS_MISSING`
naming `embed_corpus`, and after `embed_chunks` hybrid hits carry `rsk-hashing-v1`.

---

## 5. `lab-state.json` as a derived record (HR-05, T15-07, T15-08)

`refresh_lab_state(root, refreshed_by=…)` recomputes everything from the DB and rewrites
`.research-toolkit/lab-state.json` through `contained_write_path` (a junctioned `.research-toolkit` is
refused, not followed). `workspace.py` no longer hand-builds a state dict and no longer claims
`vectorSearch: "not-implemented"`.

Refreshed after **every store-writing verb**: `index_corpus`, `unindex_corpus`, `claims_write`,
`verify_sources`, `store_maintenance`, `embed_corpus`, and after the store-maintenance actions that
change the store (backup/restore/vacuum report it as `labState` in their receipt). Read verbs
(`store_status`, `claims_read`, `evidence_read`, `search_corpus`) do **not** rewrite it — a record that a
read touches is not a derived record.

A real record, written by `index_corpus` on this host:

```json
{ "schemaVersion": 2, "derivedRecord": true,
  "deriveNote": "Derived record: every value in this file was recomputed from .research-toolkit/store/research.sqlite3 by the toolkit verb named in 'refreshedBy'. It is not a promise made at setup and it is not a second source of truth — verify it with store_status, and if the two disagree the store is the record.",
  "refreshedAt": "2026-11-17T21:49:46+00:00", "refreshedBy": "index_corpus",
  "profileId": "full", "toolkitVersion": "0.3.13",
  "storeSchemaVersion": 4, "tableCount": 9,
  "tables": ["chunk_vectors","chunks","claim_events","claim_evidence","claims","index_runs","meta","source_versions","sources"],
  "counts": {"sources": 1, "chunks": 1, "retainedChunks": 0, "claims": 0,
             "claimEvidence": 0, "indexRuns": 1, "chunkVectors": 1},
  "vectorSearch": {"state": "ready", "implemented": true, "backendId": "rsk-hashing-v1",
                   "dimensions": 256, "encoding": "base64-int16-le", "vectorCount": 1,
                   "currentChunkCount": 1, "scoreableChunks": 1, "staleVectorCount": 0,
                   "modes": ["lexical","vector","hybrid"], "reindexVerb": "embed_corpus",
                   "note": "Every current chunk has a vector made by this backend from this chunk text…"} }
```

`toolkitVersion` reads `0.3.13` because the identity bump belongs to the release package, not here.

`vectorSearch.state` is one of `not-built` (no rows), `stale` (current chunks, none usable), `partial`
(some usable, or stale rows present), `ready`. `scoreableChunks` counts only rows that pass all three
checks, so a stale row is never reported as a usable vector. `store_status` reports the same block, and
`test_store_status_reports_the_same_numbers_as_the_derived_record` asserts
`status["vectorSearch"] == state["vectorSearch"]`.

`test_every_store_writing_verb_refreshes_the_record_and_its_counters_are_true` compares `state["counts"]` against a direct
`SELECT` of every table afterwards — the record is checked against the store, not against itself.
`test_the_record_is_rewritten_over_any_edit_a_reader_made` proves a tampered file is overwritten, and
`test_a_store_on_an_older_schema_is_reported_instead_of_being_counted` proves the failure mode:
an unupgraded store produces `{"refreshed": False, "reason": "STORE_SCHEMA_UPGRADE_REQUIRED", "nextAction": …}`
rather than counters this schema cannot produce. That non-raising path exists for a reason: a 0.3.8 store
must still be backable before it is migrated (`test_backup_then_confirmed_restore_returns_the_pre_migration_store`).

`init_store` and the `_snapshot` counters include `chunk_vectors`; `init_store` also returns `createdAt`,
which the derived record stores as `storeCreatedAt`.

---

## 6. `draft` joins the claim statuses (HR-32 / F-02, T15-09)

`CLAIM_STATUSES = ("open", "draft", "supported", "contested", "rejected", "closed")`. `draft` means a
recorded statement that has not been assessed yet — it is a status the researcher chose, not a toolkit
judgement. An unknown status is still refused with `CLAIM_STATUS`, and the refusal lists the accepted
ones. Proven at both layers: `test_draft_is_an_accepted_claim_status_and_an_unknown_one_is_still_refused`
(`records.py`) and `test_draft_is_an_accepted_claim_status_through_the_verb_and_an_unknown_one_is_refused`
(the MCP verb, where `draft` also appears in the published `inputSchema` enum).

---

## 7. Verb surface this package produced

```python
search_corpus(query: str, limit: int = 10, mode: str = "lexical") -> dict   # lexical replies keep the 0.3.13 shape exactly
embed_corpus(overwrite: bool = False) -> dict
```

`embed_corpus` receipt keys: `currentChunks`, `vectorsWritten`, `vectorsReused`,
`staleVectorsReplaced`, `chunksWithoutSignature`, `overwrite`, `vectorBackend`, `before`, `after`
(both `before`/`after` are the full vector-state block: `state`, `implemented`, `backendId`,
`dimensions`, `encoding`, `vectorCount`, `currentChunkCount`, `scoreableChunks`, `staleVectorCount`,
`modes`, `reindexVerb`, `note`), `sourceFilesRead: False`, `sourceFilesModified: False`, `note`,
`labState`.

Measured behaviour: on a store whose index already built its vectors, `embed_corpus({})` returns
`vectorsWritten: 0, vectorsReused: 27, after.state: "ready"` — it does not rewrite identical rows.
`embed_corpus(overwrite=True)` returns `vectorsWritten: 27, vectorsReused: 0`. A chunk with no letter or
digit is reported in `chunksWithoutSignature` rather than stored as a zero vector.

Registration: `embed_corpus` is in `LAB_TOOLS`, carries a `TOOL_TITLES` entry and
`TOOL_ANNOTATIONS(read_only=False, destructive=False, idempotent=True, open_world_hint=False)`, and is
gated through `register_tools` like every other lab verb. Preset enablement (`presets.py`,
`extension/presets.json`), the `SERVER_BUDGETS` 10 → 11 change and the worker-bundle rebuild were made by
the release packages. Measured discovery through the shipped functional check, for their records:

| Server | toolCount | budget | characters | tokensEstimate | annotated |
| --- | --- | --- | --- | --- | --- |
| `research_stack.mcp_server` | 5 | 5 | 3 201 | 1 002 | 5/5 |
| `research_stack.recommended_server` | 8 | 8 | 3 618 | 1 227 | 8/8 |
| `research_stack.lab_server` | 11 | 11 | 7 065 | 2 210 | 11/11 |

Total registered surface: 24 tools. `embed_corpus` alone: 783 definition characters, ≈ 236 tokens,
`readOnlyHint: false`, `destructiveHint: false`, annotated.

---

## 8. Measured test results

| Run | Result |
| --- | --- |
| Baseline before this package (`6719415`, `uv run --locked pytest -q`) | **413 passed, 0 failed** |
| Suite size after this package (before the release packages landed their pairing) | 442 collected = 413 + 29 new tests |
| `tests/test_vector_retrieval.py` alone | 17 passed |
| `tests/test_lab_state.py` alone | 9 passed |
| `test_records + test_workspace + test_migration + test_lab_server + test_stdio` | 72 passed |
| Intermediate full run, before the worker bundle was rebuilt | 442 collected, **415 passed / 27 failed** — 23 `tests/test_vsix.py` (its expected-member list is derived from a glob of `src/research_stack/*.py`, so `vectors.py` demanded a packaged copy that did not exist yet) and 4 extension-side gates |
| **Final full run, `uv run --locked pytest -q`, 2026-11-17 21:41 UTC** | **444 collected, 444 passed, 0 failed** (444 = 413 + 29 from this package + 2 added by the release packages) |

One intermediate run showed a single `tests/test_functional_check.py` failure
(`test_check_discovers_the_full_surface_even_when_a_narrow_preset_is_selected`); three subsequent
invocations of that file returned 5/5, so the failure was load-related on a host where several packages
were running their own suites at the same time, not a standing defect.

Verification scripts, honestly:

* `uv run --locked python scripts/verify_recommended_mcp.py` — **ran and passed**, returning the JSON
  receipt: `tools` (8 recommended verbs), `invalidProviderState: "PROVIDER_UNKNOWN"`,
  `preparedRis: "research/imports/fixture-import.ris"`, `zoteroState: ZOTERO_NOT_AVAILABLE` with
  `"Nothing answered at 127.0.0.1:23119; no library files were opened."` (expected: no Zotero listener on
  this host), `zoteroLibraryState: "answered"`, `zoteroWriteRefusedWithoutConfirm: "WRITE_CONFIRM_REQUIRED"`,
  `zoteroWritePreviewDryRun: true`, `workspaceSetup: "basic-to-recommended-additive-upgrade"`.
* `uv run --locked python scripts/verify_mcp.py` — **cannot run on this host**: with no persistent
  `.research-toolkit/worker` directory it selects `.venv/Scripts/research-stack-mcp.exe`, a Windows path
  (`scripts/verify_mcp.py:46`), and fails with `FileNotFoundError` before any MCP traffic. This is a
  pre-existing host limitation, not a consequence of this package; the stdio path it would exercise is
  covered here by `tests/test_functional_check.py` (5 passed, real stdio MCP clients) and
  `tests/test_lab_server.py`.
* The shipped `extension/functional_check.py` was run directly and returns `{"ok": true, …,
  "corpusIndex": true, "recordStore": true, "vectorRetrieval": true, "hybridRetrieval": true,
  "retrievalModesRefused": true, "vectorsBuilt": 1}`. It passes as shipped; to see the earlier failure
  reason I ran a **copy in `/tmp` with the traceback printer added** — `extension/functional_check.py`
  itself was not edited by this package.

---

## 9. Owed, and what is not proven

* **No semantic-quality claim is made or tested.** The proven properties are determinism, dimension,
  round-trip stability, and that shared surface forms outscore unrelated text (unrelated English measured
  ≈ 0.21 against the same query). Ranking quality on a real research corpus is not measured here; the
  hybrid orderings proven in tests are synthetic fixtures, and the fusion rule is published so an operator
  can recompute any score rather than trust it.
* **No relevance threshold exists.** Vector and hybrid modes rank; they never filter, and cosine is
  reported raw (`vectorScore`) so a reader can see how weak the match actually was.
* **`verify_mcp.py` on a Linux host** remains unproven (Windows executable path). If that script is meant
  to run outside Windows, the transport selection at `scripts/verify_mcp.py:39-46` needs a POSIX branch —
  outside this package's files.
* **Store growth from vectors** is measured per vector (684 characters) and extrapolated, not measured on
  a large corpus; a 20 000-chunk index would carry ≈ 13 MB of encoded vectors and ≈ 26 s of CPU to build
  on one core. `MAX_STORE_CHUNKS` bounds the query the verb will accept.
* **Payload ceilings** (`scripts/verify_vsix.py` payload ceiling,
  `unreviewed_python_network_members`, `python_imports_without_boundary_note`) are the release package's
  re-baseline after the worker rebuild; this package only guarantees that `vectors.py` performs no network
  access and names its limits in its own docstring and `backend_status()`.
* `extension/functional_check.py`'s vector gate originally required `vectorsWritten` to be non-zero after
  an index that had already written the vectors; it now requires `after.vectorCount` and
  `after.state == "ready"`, which is the honest assertion given HR-01 makes indexing build the vectors.
