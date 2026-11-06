# Phase 9 design — 0.3.9

Decisions `DD9-xx` close the findings in [spec.md](spec.md). Contracts here are the ones the tests assert.

## 1. Shape of the change

```
documents.py   extraction of one source, in bounded batches, with per-unit locators   (parse layer)
full.py        unit → chunk identity, three versioned chunkers                        (identity layer)
records.py     store, schema v3, transactional run, freshness, export policy          (store layer)
lab_server.py  index_corpus / verify_sources / store_status — the MCP surface         (surface layer)
extension/*    control-panel steps: corpus ingestion + skill-bundle install           (host layer)
```

One rule holds the whole release together: **the identity of an existing chunk never changes.** Only new chunker
versions are introduced, so a 0.3.8 store keeps every chunk id, every locator and every claim link it had.

## 2. Decisions

| # | Decision | Why, and what it closes |
|---|---|---|
| **DD9-01** | Extraction stays in `documents.py`; `full.py` gains a binary branch that calls it. | `documents.py` already owns pypdf/python-docx, the byte caps, the encrypted/corrupt/empty taxonomy and the locator dicts (D9-01, D9-03). Splitting parsing into a new module would create a second reader with its own limits. |
| **DD9-02** | New `extract_source(path)` reads a whole document in batches of at most 100 units and returns ordered `DocumentUnit`s plus coverage, warnings, parser identity and an outcome. `extract_document` is unchanged. | A per-call limit cannot be allowed to truncate an index (D9-02). Keeping the old function intact keeps `read_document` and its 11 tests as they are. |
| **DD9-03** | Per-unit failures are captured per unit, not per file. A page whose text extraction raises yields an empty unit with a warning; the file becomes `partial`. | One damaged page must not destroy a 400-page index, and must not be reported as a clean read (D9-06, R9-05). |
| **DD9-04** | Three chunkers, each versioned in `chunker_id`: `paragraph-window-v1` (unchanged), `pdf-page-window-v1`, `docx-item-window-v1`. A chunk never spans a unit. | Existing ids stay byte-identical (D9-09, R9-04); a PDF chunk that crossed a page boundary would make its own locator false (D9-03). |
| **DD9-05** | Locator grammar extends, never replaces: `paragraph=N;chars=a-b` (existing), `page=N;chars=a-b`, `item=N;kind=…;chars=a-b`. `read_document` gains a `locator` argument that reopens a stored unit with its neighbours. | Provenance has to survive from a search hit to a reopened page (D9-03, R9-08). |
| **DD9-06** | Freshness is a stored check with a timestamp: `sources.verification` ∈ `verified|changed|missing|inaccessible|unchecked`, `sources.last_verified_at`. Indexing sets `verified` (it hashed the bytes it read); a new `verify_sources` verb re-hashes on demand; a migrated row is `unchecked`. | "The version in the index" and "the present hash was checked" are different facts (D9-04, R9-09). |
| **DD9-07** | The source is re-hashed after its last extraction batch. A mismatch aborts that source with `SOURCE_CHANGED_DURING_INDEX` and leaves its previous version in place. | Closes the read-while-it-changes window (D9-05, R9-11). |
| **DD9-08** | One call = one transaction. Per-source outcomes are collected; a failed or partial source is **not written** and keeps its previous row and chunks; successful sources in the same call are written. If nothing succeeded, the transaction rolls back. | Mixed-batch honesty without losing the good files (D9-06, R9-06, R9-07). |
| **DD9-09** | Cancellation is cooperative: `index_corpus(..., cancel=callable)` checks it between sources and between batches, rolls back, and reports `cancelled: true` with `written: 0`. | An interrupted update must leave the store exactly as it was (R9-11). |
| **DD9-10** | `index_runs` records one row per ingestion call: run id, mode, started/finished, source and chunk counts, status, `accepted_partial`, and the per-source outcome JSON. | A receipt a machine can re-read is the only proof a mixed batch ever happened (D9-11, R9-07). |
| **DD9-11** | Schema 3 is additive: `ALTER TABLE … ADD COLUMN` with defaults, no table rebuild, no row rewrite. Migrated `sources` rows get `outcome='legacy'`, `verification='unchecked'`, and coverage left at 0 rather than invented. | Chunk ids are content hashes; a rewrite would stale every claim link (D9-08, D9-09, R9-13). |
| **DD9-12** | `MAX_STORE_CHUNKS` stays 20 000 and stays the BM25 candidate limit; the projected-total check and the `LIMIT` are asserted to be the same constant in one test. | Closes the silent under-search (D9-10) instead of raising a cap nobody re-checked. |
| **DD9-13** | Binary sources are bounded by `MAX_BINARY_SOURCE_BYTES = 25 MiB` per file inside the existing 50 MiB per-call total; the reader's own 50 MiB / 500-page limits still apply. | A PDF is not a text file; the 5 MiB text cap would reject ordinary documents for no reason (D9-01). |
| **DD9-14** | Ingestion is exposed on `lab_server` (the persistent-index server), which already returns a structured `{"resultState":"error"}` envelope. `verify_sources` joins `LAB_TOOLS` (9 → 10 tools, 20 → 21 overall). | The mixed-batch result must be structured and the server named (D9-12, R9-07). Every surface gate is updated in the same change (D9-11). |
| **DD9-15** | Exports exclude stale **and** unverified references by default, count each exclusion, and label any included historical reference `"historical": true`. | A report must not cite a document that is gone or unverified without saying so (D9-07, R9-12). |
| **DD9-16** | Bundles are described by a checked-in catalog, `extension/bundles/catalog.json`, listing bundle id, version, topic, purpose, files with SHA-256, prerequisites and provenance. The catalog is generated from the staged tree by `scripts/build_bundle_catalog.py` and verified by a test that re-hashes the tree. | A bundle that is not hashed cannot be staged, verified or audited (D9-13, R9-14, R9-19). |
| **DD9-17** | Bundle files ship inside the worker payload beside the overlay, and `scripts/verify_vsix.py` compares every catalog digest with the packaged member and with the source tree. | Source → payload → VSIX integrity is one chain, not three claims (R9-19). |
| **DD9-18** | Installation writes to `<workspace>/.github/skills/<skill-id>/` through a staging directory, verifies each staged file's hash before any copy, and refuses a target whose present bytes match neither the recorded "installed" hash nor a hash the catalog knows. A conflict is reported and the user's file is left alone. | Preserves user edits and makes a partial install visible (R9-16). |
| **DD9-19** | A bundle install has its own receipt (`.research-toolkit/bundles/<bundle-id>.json`) and its own step id. The overlay receipt is never consulted as evidence for a bundle. | Closes the "0.3.8 receipt proves a 0.3.9 bundle" confusion (R9-17). |
| **DD9-20** | Three statuses are separate fields, never merged: `filesInstalled`, `hostDiscoveryVerified`, `workflowTested`. An automated install may set only the first; the other two are `false` with the reason the toolkit cannot observe them from this container. | Discovery and workflow truth belong to the host, not to the installer (R9-17, R9-22). |
| **DD9-21** | Shared-skill ownership is declared in the catalog (`"owners": {"<skill-id>": "<bundle-id>"}`). A skill owned by another bundle is reported as shared and is never removed. | Two bundles must not fight over one directory (R9-18). |
| **DD9-22** | The theological bundle ships with its 11 files, its `metadata.version: 2.0`, and a `BUNDLE-NOTES.md` recording every adaptation and every unresolved item, including the license. The scripts are shipped **with** the disclosed defects documented, and the two over-claims are corrected in the text: `dedupe_records.py` reports only the fields it actually compares and stops dropping records silently; `crossref_lookup.py` separates a service failure from "no plausible match". | Shipping a PoC unchanged would ship an over-claiming tool (D9-15, D9-16, R9-20). |
| **DD9-23** | `document-corpus-bridge` (the 0.3.8 workaround skill) is brought under the bundle catalog as a toolkit-owned skill and its text is corrected to say the toolkit now indexes PDF/DOCX directly. | One workspace must not carry two competing instructions (D9-18). |
| **DD9-24** | The license question is **not** answered by the toolkit. The catalog records `license: "unresolved — author consent required before publication"` and the packaging test refuses to mark the bundle as publishable while that field is unresolved. | An unresolved legal question must be visible in the artifact, not settled by an agent (D9-17, R9-20). |

## 3. Contracts the tests assert

### 3.1 Extraction (`documents.py`)

```python
@dataclass(frozen=True)
class DocumentUnit:
    index: int          # 1-based position in source order
    kind: str           # "page" | "paragraph" | "table-1-row"
    text: str
    characters: int
    error: str | None   # per-unit extraction failure, if any

@dataclass(frozen=True)
class ExtractedSource:
    path: str
    kind: str                     # "pdf" | "docx"
    sha256: str                   # source bytes, hashed before and re-checked after
    units: list[DocumentUnit]
    coverage: dict                # totalUnits, unitsRead, unitsWithText, emptyUnits, complete, batches
    warnings: list[str]
    parser: dict                  # {"id": "pypdf", "version": "6.4.1"} or {"id": "python-docx", …}
    outcome: str                  # "complete" | "partial" | "failed"
```

`extract_source(path)` raises `DocumentError` only for a file-level failure (`PDF_ENCRYPTED`, `PDF_PARSE_FAILED`,
`DOCX_PARSE_FAILED`, `PDF_EMPTY`, `DOCX_EMPTY`, `SOURCE_NOT_FOUND`, `INPUT_TOO_LARGE`, `PAGE_LIMIT`) or for
`SOURCE_CHANGED_DURING_INDEX`.

### 3.2 Identity (`full.py`)

```python
CHUNKER_ID            = "paragraph-window-v1"      # unchanged
PDF_CHUNKER_ID        = "pdf-page-window-v1"
DOCX_CHUNKER_ID       = "docx-item-window-v1"
```

Locators produced: `paragraph=N;chars=a-b` · `page=N;chars=a-b` · `item=N;kind=table-1-row;chars=a-b`.
`chunk_id` and `content_id` keep the existing tuple shape (`full.py:168,171`), with the new chunker fingerprint in
place of the old one.

### 3.3 Store (`records.py`, schema version 3)

```sql
ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE sources ADD COLUMN unit TEXT NOT NULL DEFAULT 'paragraph';
ALTER TABLE sources ADD COLUMN parser_id TEXT NOT NULL DEFAULT '';
ALTER TABLE sources ADD COLUMN units_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN units_extracted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN empty_units TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sources ADD COLUMN warnings TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sources ADD COLUMN outcome TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE sources ADD COLUMN verification TEXT NOT NULL DEFAULT 'unchecked';
ALTER TABLE sources ADD COLUMN last_verified_at TEXT;
ALTER TABLE chunks  ADD COLUMN unit_kind TEXT NOT NULL DEFAULT 'paragraph';
ALTER TABLE chunks  ADD COLUMN unit_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chunks  ADD COLUMN char_start INTEGER NOT NULL DEFAULT -1;
ALTER TABLE chunks  ADD COLUMN char_end INTEGER NOT NULL DEFAULT -1;
CREATE TABLE IF NOT EXISTS index_runs (
    run_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, finished_at TEXT,
    mode TEXT NOT NULL, source_count INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
    accepted_partial INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '');
```

`index_corpus(root, paths, *, chunk_chars, overlap_chars, accept_partial=False, cancel=None)` returns:

```json
{"runId": "…", "status": "complete|partial|failed|cancelled",
 "indexedSources": ["a.pdf"], "keptPreviousVersion": ["b.pdf"],
 "failedSources": [{"path": "c.pdf", "code": "PDF_ENCRYPTED", "message": "…"}],
 "partialSources": [{"path": "d.pdf", "unitsTotal": 12, "unitsExtracted": 11, "emptyUnits": [4]}],
 "acceptedPartial": false, "written": 1, "storeChunks": 42,
 "retainedEvidenceChunks": 3, "collectedUnreferencedChunks": 0,
 "indexFingerprint": "…", "indexedAt": "…", "sourceFilesModified": false}
```

`verify_sources(root, paths=None)` returns `{"checked": n, "verified": […], "changed": […], "missing": […],
"inaccessible": […], "uncheckedRemaining": n, "sourceFilesModified": false}`.

### 3.4 MCP surface (`lab_server.py`)

`index_corpus(paths, mode="index", accept_partial=false)` and the new `verify_sources(paths)` join `LAB_TOOLS`
(10 tools; 21 across the three servers). Both keep the `{"resultState":"error","error":{"code","message"}}` envelope
for a structured failure.

### 3.5 Bundles (`extension/bundles/`)

`catalog.json` — reviewed catalog; `bundle.json` per bundle: id, version, topic, purpose, skills[], files[] with
sha256, prerequisites[], provenance, license status, owners. Install receipt
`.research-toolkit/bundles/<bundle-id>.json` with per-file state, hashes, timestamps and the three separate status
fields.

## 4. What this release does not do

No OCR. No embeddings or vector search. No background or automatic ingestion — every file is named by the user.
No network call from the installer. No change to a user's presets, profile, store contents or existing skills.
No claim about a Windows host, a live VS Code extension host, Copilot skill discovery, or the assistant having used
the theological bundle.
