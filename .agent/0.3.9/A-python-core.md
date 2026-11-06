# 0.3.9 pre-work — Python core audit (documents → store → search → claims → MCP)

Read-only investigation of `toolkit` at release **0.3.8** (`pyproject.toml:3`, `src/research_stack/__init__.py`).
All citations are `file:line` in this repo. Verified environment facts (measured, `print`-only probes):
`.venv` is CPython **3.12.16**, `sqlite3.sqlite_version` **3.53.1**, and **FTS5/FTS4 modules are available**
(`fts5`, `fts5vocab`, `fts3tokenize` in `pragma_module_list`) — but **no FTS virtual table exists in the code today**:
retrieval is a pure-Python BM25 (`src/research_stack/full.py:210-245`). There is no `conftest.py` in `tests/`.

---

## 1. Document reader path (what reads PDF/DOCX today)

Module `src/research_stack/documents.py`. Limits at `documents.py:28-34`:

```python
MAX_INPUT_BYTES = 50 * 1024 * 1024      # documents.py:28
MAX_PDF_PAGES   = 500                   # documents.py:29
MAX_RESULT_CHARS = 1_000_000            # documents.py:30
MAX_TEXT_ITEMS  = 200                   # documents.py:31
TEXT_SUFFIXES     = {".md", ".markdown", ".txt"}   # :32
DOCUMENT_SUFFIXES = {".pdf", ".docx"}              # :33
CITABLE_SUFFIXES  = DOCUMENT_SUFFIXES | TEXT_SUFFIXES  # :34
```

* **Gatekeeper** `_check_input()` `documents.py:75-82` — suffix check, `is_file()`, size check.
  `UNSUPPORTED_FORMAT` is raised at **`documents.py:77`** (`raise DocumentError(f"UNSUPPORTED_FORMAT: {formats_code}")`).
* **PDF + DOCX reader** `extract_document(path, start=1, count=50)` `documents.py:100-156`.
  * Range validation `documents.py:103-104`: `count` must be **1..100** per call.
  * PDF branch `documents.py:109-133`: `pypdf.PdfReader(..., strict=False)` (`:111`); encrypted → `PDF_ENCRYPTED` (`:113`);
    `>500` pages → `PAGE_LIMIT` (`:116`); zero pages → `PDF_EMPTY` (`:118`); `start > page_total` → `INVALID_RANGE` (`:121`);
    text via `reader.pages[n-1].extract_text() or ""` (`:123`); locator `{"page": n, "characters": len(text)}` (`:125`);
    all-empty → warning `NO_TEXT_EXTRACTED: … OCR is not included in Phase 1.` (`:127`);
    coverage `{"totalUnits","unit":"page","returnedFrom","returnedTo","truncated"}` (`:129`);
    any parser exception → `PDF_PARSE_FAILED: <ExcType>; source was not changed.` (`:133`).
  * DOCX branch `documents.py:134-151`: `_docx_body_blocks()` (`:85-97`) walks `document.element.body.iterchildren()` so
    paragraph/table order is preserved (`w:p` → `("paragraph", text)`, `w:tbl` → one block per row, kind `table-{i}-row`,
    cells joined with `" | "`); empty → `DOCX_EMPTY` (`:138`); out-of-range → `INVALID_RANGE` (`:141`);
    locator `{"item": index, "kind": kind_name, "characters": len(text)}` (`:145`); coverage unit
    `"paragraph or table row"` (`:147`); failure → `DOCX_PARSE_FAILED` (`:151`).
  * Both branches: joined text over `MAX_RESULT_CHARS` → `RESULT_TOO_LARGE: … extraction is never silently truncated.` (`:154-155`).
  * Returns `ExtractedDocument(path, kind, sha256, text, locators, warnings, coverage)` `documents.py:42-53`
    (`kind` = `"pdf"|"docx"`; `sha256` from `sha256_file()` `:67-72`, 1 MiB streaming).
* **Markdown/text reader** `read_text_document(path, start=1, count=20, locator=None, context=1)` `documents.py:162-210`.
  `count` 1..`MAX_TEXT_ITEMS`(200) (`:169`), `context` 0..5 (`:171`), non-UTF-8 → `INVALID_UTF8` (`:176`),
  locator grammar `paragraph=(\d+)(?:;chars=(\d+)-(\d+))?` (`:185`), stale locator → `LOCATOR_STALE` (`:190`),
  locators `{"paragraph","kind","characters","locator":"paragraph=N"}` (`:202`), tail truncation emits a
  **warning** `RANGE_TRUNCATED: … continue with start=…` (`:207-208`).
* **Who raises `UNSUPPORTED_FORMAT` and where the 0.3.8 failure came from:** only two sites —
  `documents.py:77` (reader) and **`full.py:136`** (`FullPrototypeError("UNSUPPORTED_FORMAT: prototype accepts UTF-8 Markdown and text only.")`)
  inside `scan_sources()`. `index_corpus` → `records.index_corpus` (`records.py:443`) → `full.scan_sources` → `full.py:135-136`,
  converted to `StoreError` by `_prototype_error` (`records.py:139-146`) and re-coded by `lab_server._failure` (`lab_server.py:74-85`).
  Observed MCP behaviour is recorded in `docs/Research-Stack-Toolkit-Advanced-Research-Test-2026-11-05.md:20`
  (`resultState: error`, code `UNSUPPORTED_FORMAT`, **`is_error: false`** in the MCP envelope).
* CLI reader verb: `cli.py:53-56` + `cli.py:73` (`research-stack read <document> --start --count`).

---

## 2. Corpus indexing path (document → records/chunks in SQLite)

Store file: `.research-toolkit/store/research.sqlite3` (`records.py:31-32`), path policy `store_path()` `records.py:149-163`.

Flow: `lab_server.index_corpus(paths, mode)` (`lab_server.py:88-97`) → `records.index_corpus()` (`records.py:430-509`)
→ `full.scan_sources()` (`full.py:102-156`) → `full.chunks_for_source()` (`full.py:159-184`) → SQL writes (`records.py:467-481`).

`scan_sources` (`full.py:102-156`) is the format gate: 1..1000 paths (`:109-110`, `MAX_SOURCES=1000` `:16`),
relative-POSIX normalisation + traversal refusal (`:122-134`), **suffix allow-list `.md/.markdown/.txt` (`:135-136`)**,
`SOURCE_NOT_FOUND` (`:137-138`), `MAX_SOURCE_BYTES = 5 MiB` per file and `MAX_TOTAL_BYTES = 50 MiB` per call
(`:17-18`, enforced `:139-149`), `INVALID_UTF8` (`:151-154`), `SourceRecord(source_path, source_version_id=sha256(raw), bytes, text)` (`:155`).

Chunking (`full.py:76-99`, `159-184`): paragraph split `\S.*?(?=(?:\r?\n[ \t]*\r?\n)|\Z)` (`:79`), windows of
`chunk_chars` (default **1200**, allowed 100..`MAX_CHUNK_CHARS=4000`) with `overlap_chars` (default **120**) (`:161-162`);
`CHUNKER_ID = "paragraph-window-v1"` (`:20`) stored as fingerprint `f"{CHUNKER_ID}:{chunk_chars}:{overlap_chars}"` (`:164`).

Identity (`full.py:167-171`):

```python
locator    = f"paragraph={paragraph_index};chars={char_start}-{char_end}"          # full.py:167
content_id = _canonical_id((source_version_id, chunker_fingerprint, locator, text_hash))   # :168
chunk_id   = _canonical_id((source_path, source_version_id, chunker_fingerprint, locator, text_hash))  # :171
```

`_canonical_id` = sha256 of a JSON array (`full.py:71-73`); `_sha256(chunk_text)` → `text_sha256` (`:166`).
So **chunk identity is content+path derived** (64 hex chars), and identical bytes at two paths stay two occurrences
(`full.py:169-170`, proven by `tests/test_records.py:97-113`).

### Exact DDL today (`records.py:48-107`, `SCHEMA_VERSION = 2`, `records.py:36`)

```sql
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);                                   -- :49-52
CREATE TABLE IF NOT EXISTS source_versions (source_sha256 TEXT PRIMARY KEY, bytes INTEGER NOT NULL,
    first_seen_at TEXT NOT NULL);                                                                              -- :53-57
CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL, indexed_at TEXT NOT NULL);                                                   -- :58-64
CREATE TABLE IF NOT EXISTS chunks (chunk_id TEXT PRIMARY KEY, content_id TEXT NOT NULL, source_path TEXT NOT NULL,
    source_sha256 TEXT NOT NULL, locator TEXT NOT NULL, text TEXT NOT NULL, text_sha256 TEXT NOT NULL,
    chunker_id TEXT NOT NULL, chars INTEGER NOT NULL, current INTEGER NOT NULL DEFAULT 1, indexed_at TEXT NOT NULL); -- :65-77
CREATE INDEX IF NOT EXISTS chunks_source_idx  ON chunks (source_path);   -- :78
CREATE INDEX IF NOT EXISTS chunks_current_idx ON chunks (current);       -- :79
CREATE INDEX IF NOT EXISTS chunks_content_idx ON chunks (content_id);    -- :80
CREATE TABLE IF NOT EXISTS claims (claim_id TEXT PRIMARY KEY, statement TEXT NOT NULL, status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', idempotency_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);  -- :81-89
CREATE UNIQUE INDEX IF NOT EXISTS claims_idempotency_idx ON claims (idempotency_key)
    WHERE idempotency_key IS NOT NULL;                                        -- :90
CREATE TABLE IF NOT EXISTS claim_evidence (claim_id TEXT NOT NULL, chunk_id TEXT NOT NULL, locator TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'supporting', rationale TEXT NOT NULL DEFAULT '', added_at TEXT NOT NULL,
    PRIMARY KEY (claim_id, chunk_id));                                        -- :91-99
CREATE TABLE IF NOT EXISTS claim_events (event_id INTEGER PRIMARY KEY AUTOINCREMENT, claim_id TEXT NOT NULL,
    kind TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);  -- :100-106
```

**No `REFERENCES` clause anywhere** — `PRAGMA foreign_keys = ON` is set (`records.py:305`) but nothing is enforced;
dangling evidence is handled in application code (`records.py:586-612`, esp. `:608-610`).
**No FTS/FTS5 virtual table, no trigram/unicode61 tokenizer, no `bm25()` call** — BM25 is Python-side (§3).

Write semantics per indexed path (`records.py:467-484`):

```python
connection.execute("UPDATE chunks SET current = 0 WHERE source_path = ?", (path,))            # :468
retained += _retained_count(connection, {path})                                               # :469
connection.execute("DELETE FROM sources WHERE path = ?", (path,))                            # :470
connection.execute("INSERT OR IGNORE INTO source_versions ...", ...)                         # :471
connection.execute("INSERT INTO chunks (...) VALUES (?,...) ON CONFLICT(chunk_id)
    DO UPDATE SET current = 1, indexed_at = excluded.indexed_at", ...)                       # :473-477
connection.execute("INSERT INTO sources (path, source_sha256, bytes, chunk_count, indexed_at) ...")  # :478-481
collected += _collect_retired(connection, {path})                                            # :484
```

One `commit()` at `records.py:488`, `rollback()` on `StoreError`/`sqlite3.Error` (`records.py:491-496`) — the run is
transactional today. Caps: `MAX_INDEX_SOURCES = 1000` (`:39`, enforced `:439-440`), `MAX_STORE_CHUNKS = 20000`
(`:40`, enforced as a projected total at `:458-462` → `STORE_CHUNK_LIMIT`).
`meta` keys written: `schema_version`, `created_at` (`:219-220`), `index_fingerprint` (`:387`, `:486`; sha256 of sorted
`(path, sha256)` pairs, `_fingerprint` `:338-340`), `indexed_at` (`:388`, `:487`), `migrated_from` (`:269`).

### Schema version / migration mechanism

`SCHEMA_VERSION = 2`, `SUPPORTED_SCHEMA_VERSIONS = (1, 2)` (`records.py:36-37`).
`_read_schema_version()` `records.py:195-205`; `_validate_or_migrate()` `records.py:212-230` (creates schema for a new
file, refuses `STORE_SCHEMA_UNSUPPORTED` for a newer version `:223-224`, refuses unreviewed versions `:227-228`);
`_migrate_to_current()` `records.py:239-270` is **additive only** (`ALTER TABLE chunks ADD COLUMN content_id/current`
`:244-247`, backfill `content_id` via `full._canonical_id` `:248-253`, `claims.idempotency_key` `:255-256`,
`claim_evidence.role/rationale` `:258-261`, re-run `SCHEMA` `:262`, seed `source_versions` with `bytes = 0` `:264-267`,
stamp `schema_version`/`migrated_from` `:268-269`). Reads open the DB **read-only** and refuse an un-migrated store
(`_connect` `records.py:273-311`, `STORE_SCHEMA_UPGRADE_REQUIRED` `:291-293`). Tests: `tests/test_records.py:310-349`.

---

## 3. Search, evidence resolution, claim↔chunk links, reindex behaviour

* `lab_server.search_corpus(query, limit)` (`lab_server.py:108-114`) → `records.search_corpus` (`records.py:540-550`)
  → `records.stored_chunks(root, limit=MAX_STORE_CHUNKS, include_retired=False)` (`records.py:512-537`,
  `WHERE current = 1 … ORDER BY source_path, locator, chunk_id LIMIT ?` `:518-521`) → `full.search_bm25` (`full.py:210-245`).
* BM25 is computed **per call over all current chunks in memory**: tokeniser `[^\W_]+` casefolded
  (`full.py:21-22`, `:206-207`), `k1=1.5, b=0.75` (`full.py:226`), Okapi-ish idf `log(1 + (N-df+0.5)/(df+0.5))` (`:239`),
  deterministic tie-break `(-score, source_path, locator, chunk_id)` (`:244`), `limit` 1..50 (`:212-213`).
  Hit shape: `SearchHit.as_dict()` = `{score, retrievalMethod:"bm25", **chunk.as_dict()}` (`full.py:57-64`).
* Evidence → source: `records.get_chunks()` (`records.py:553-583`) returns `sourcePath`, `sourceSha256`, `locator`,
  `text`, `textSha256`, `chunkerId`, `resolvable`, `current`, `stale`. MCP verb `evidence_read` adds `unresolved`
  (`lab_server.py:117-130`). Report-side resolution: `documents.resolve_evidence()` (`documents.py:248-272`) refuses
  unresolved ids with `EVIDENCE_UNRESOLVED` (`:263`) and builds citations `{label, reference=source_path, sha256, locator}` (`:265-271`).
* Claims: `claims_write` (`records.py:688-797`) creates or patches; `_reconcile_evidence` (`records.py:804-831`)
  validates every chunk id (`EVIDENCE_NOT_FOUND` `:815-816`), supports `append|replace|remove` (`EVIDENCE_MODES` `:111`),
  upserts `claim_evidence` `ON CONFLICT(claim_id, chunk_id) DO UPDATE SET role/rationale/locator` (`:821-825`),
  caps 200 links per call **and per claim** (`MAX_EVIDENCE_LINKS` `:44`, `:721-722`, `:769-771`).
  Hydration is a `LEFT JOIN` so a deleted chunk yields `resolvable:false` + `EVIDENCE_UNRESOLVABLE` warning (`:586-612`).
  Statuses `open|supported|contested|rejected|closed` (`:109`), roles `supporting|contradicting|contextual` (`:110`),
  `ASSESSMENT_NOTE` disclaimer (`:113-116`, surfaced by `read_claims`/`export_claims` `:680`, `:883`).
* **What happens on reindex today:** old chunks flip to `current = 0` (`records.py:468`), new ids are inserted (content
  changed ⇒ new `source_sha256` ⇒ new `chunk_id`), chunks **still cited by a claim are retained** (`_collect_retired`
  excludes ids present in `claim_evidence`, `records.py:343-355`), uncited retired chunks are **deleted in the same call**
  (`records.py:484`), and `vacuum` collects the rest (`records.py:1032`). Retained evidence is flagged `stale`
  (`records.py:603`, `:580`) and is excluded from `export_claims` unless `include_stale=True` (`records.py:855-856`,
  counter `excludedStaleReferences` `:881`). Tests: `tests/test_records.py:130-151`, `:433-448`; `tests/test_lab_server.py:143-154`.
* Freshness today is **hash-based only**: `sources.source_sha256` vs `reindex_preview` (`records.py:887-929`, compares
  `currentSha256` vs `newSha256`, `changed` flag `:919`) and citation-time rehash in `validate_sources`
  (`SOURCE_HASH_MISMATCH` `documents.py:240-242`). There is **no mtime check and no live-file check at search time**.

---

## 4. Provenance stored today vs. what PDF/DOCX locators need

Present: `sources(path, source_sha256, bytes, chunk_count, indexed_at)` (`records.py:58-64`);
`source_versions(source_sha256, bytes, first_seen_at)` (`:53-57`); `chunks(source_path, source_sha256, locator,
text_sha256, chunker_id, chars, current, indexed_at)` (`:65-77`); `meta.index_fingerprint`/`indexed_at` (`:486-487`);
`ExtractedDocument.sha256` + `coverage` in the reader (`documents.py:42-53`).

Missing for 0.3.9:
1. **No format/kind column** — nothing records that a source is `pdf|docx|text`; `scan_sources` hard-codes the suffix set (`full.py:135`).
2. **No parser identity/version** — `chunker_id` records the chunker only (`full.py:20,164`); the pypdf/python-docx version
   that produced the text is nowhere stored (`pyproject.toml:10-11` pins them, but the store does not record them).
3. **No mtime / live-hash status** — only `indexed_at` + `source_sha256`; "live source-hash match vs indexed-version flag"
   (proposal `docs/Research-Stack-Toolkit-0.3.9-Development-Proposal.md:9-11`) has no column today.
4. **Locators are opaque strings** (`chunks.locator TEXT`, `records.py:70`) in the single shape `paragraph=N;chars=a-b`
   (`full.py:167`). PDF page locators from the reader are dicts `{"page": n, "characters": n}` (`documents.py:125`) and
   DOCX ones `{"item": n, "kind": "paragraph|table-N-row"}` (`documents.py:145`) — **neither shape is storable or
   reopenable today**: `read_text_source` parses only `paragraph=…` (`documents.py:185`) and `read_document` accepts
   `start/count`, not a locator (`mcp_server.py:61-64`).
5. **No per-source coverage / empty-page / warning record** — coverage exists only in a reader response
   (`documents.py:129`, `:147`), never persisted; `emptySources` is a call result only (`records.py:483`, `:501`).
6. **No ingestion-run / batch identity** (no run id, no per-run status, no partial-accept marker) — only `index_fingerprint`.
7. `source_versions.bytes` is written as `0` for migrated rows (`records.py:265-267`).

---

## 5. Export / report paths

* `records.export_claims` (`records.py:834-884`) → `{claims[], references[], unresolvedClaims, excludedStaleReferences,
  readOnly, assessment}`; a reference is `{label: "path · locator", reference: path, sha256, locator, chunkId, role, current}` (`:866-874`).
* `documents.validate_sources` (`documents.py:213-245`) — ≤100 citations (`:215`), 64-hex hash required (`:226-227`),
  workspace-file citations are re-hashed and must match (`:232-243`), `verifiedPath` added (`:243`); external
  `http(s)://`/`doi:` references are not file-checked (`:231`, `:232`).
* `documents.report_model` (`documents.py:275-330`) parses Markdown into `ReportBlock`s (`:56-64`) and appends
  `Evidence` (`:324-326`) and `Sources` (`:327-329`) bullet blocks with the sha256 inline.
* Writers: `write_markdown_report` (`documents.py:363-367`) via `_write_exclusive` `open("xb")` (`:353-360`,
  `OUTPUT_EXISTS` `:359`); `write_docx_report` (`documents.py:370-408`) stages to a `NamedTemporaryFile` in the target
  directory (`:397-407`) and copies into an `xb` handle. MCP entry `_write_report` (`mcp_server.py:73-88`) restricts
  output to `outputs/` (`:75-79`), asserts no link on the path (`:80-83`), caps body at 100 000 chars (`:84-85`),
  resolves stored evidence **before** writing (`:86`).
* RIS export: `research.to_ris` (`research.py:471-492`, 1..100 records) written only under `research/imports/` with
  `open("x")` (`recommended_server.py:71-91`, `OUTPUT_EXISTS` `:88-89`).
* NotebookLM handoff: `bundle.export_bundle` (`bundle.py:15-45`) copies PDF/DOCX/TXT/MD (`SUPPORTED` `:11`), verifies
  hash before/after copy (`:33-38`), writes `source-index.md` with per-file sha256 (`:40-43`), refuses an existing
  output dir (`:17-18`).

---

## 6. Error taxonomy

| Layer | Class | Base | Where |
|---|---|---|---|
| documents | `DocumentError` | `ValueError` | `documents.py:38-39` |
| corpus prototype | `FullPrototypeError` | `ValueError` | `full.py:25-26` |
| store | `StoreError` | `ValueError` | `records.py:119-121` |
| path policy | `PathPolicyError` | `ValueError` | `paths.py:17-18` |
| providers/Zotero | `ResearchError` | `RuntimeError`, carries `.code`, `.retry_after`, `.as_dict()` | `research.py:33-45` |
| presets | `PresetError` | `ValueError` | `presets.py:48-50` |

* Every message is **`CODE: sentence`**; the code is recovered by splitting on the first `:` (`lab_server.py:77-79`).
* `sqlite3` → `StoreError` translation: `STORE_CONSTRAINT`, `STORE_BUSY`, `STORE_CORRUPT`, `STORE_ERROR` (`records.py:127-136`);
  cross-module translation `_prototype_error` (`records.py:139-146`).
* **Structured failure vs transport failure** (the important asymmetry):
  * `lab_server` catches `(StoreError, PathPolicyError)` and returns `{"resultState":"error","error":{code,message}}`
    (`lab_server.py:74-85`); unexpected internals are sanitised to `STORE_UNEXPECTED` with only the exception **type name**
    so stored text cannot leak (`lab_server.py:80-84`). The MCP envelope stays `is_error: false` — confirmed by
    `docs/Research-Stack-Toolkit-Advanced-Research-Test-2026-11-05.md:20`.
  * `mcp_server` and `recommended_server` differ: `mcp_server` lets exceptions escape
    (`mcp_server.py:44-70` has no try/except) and the SDK converts them to `CallToolResult(..., is_error=True)` with
    `text=str(exc)` (`.venv/.../mcp/server/mcpserver/server.py:436-447`); `recommended_server` returns its own
    `{"resultState":"error","error":exc.as_dict()}` / `{"status":"unavailable",…}` envelopes (`recommended_server.py:39-68`).
  * CLI: `except (DocumentError, OSError, ValueError)` → stderr JSON + **exit 2** (`cli.py:78-80`); `StoreError` and
    `PathPolicyError` are `ValueError` subclasses, so they land there too. Encoding failures are separated from
    transport failures by signature in the extension (`extension/runner.js` `CODEC_SIGNATURE`, described in
    `.agent/QUALITY_STATE.md` §"D8-06").
* Provider codes: `PROVIDER_AUTH_REQUIRED|NOT_FOUND|RATE_LIMITED|UNAVAILABLE|REQUEST_REJECTED|SCHEMA_UNEXPECTED|TERMS_NOT_ACKNOWLEDGED`
  (`research.py:151-171`, `:374-376`); Zotero codes (`research.py:447-452`).

---

## 7. MCP tool surface (20 tools) and how servers are launched

Registration is preset-gated and name-sorted: `presets.register_tools()` (`presets.py:78-103`), preset from
`RESEARCH_STACK_TOOL_PRESET` (`presets.py:18-19`, `DEFAULT_PRESET="all"`), sets at `presets.py:21-45`.
Titles/annotations per server: `mcp_server.py:27-41`, `recommended_server.py:19-33`, `lab_server.py:34-58`;
shared `annotations()` + `tools/list` cache hint (`tool_meta.py:19-34`, ttl 300 000 ms private).
Input schemas are **generated by the SDK from the function signature + docstring** (pydantic `…Arguments` objects;
measured by registering each server in-process). Signatures:

`research_stack.mcp_server` (`mcp_server.py:101`, budget 5 — `extension/functional_check.py:27-31`)
* `read_document(path:string, start:int=1, count:int=50)` → `documents.extract_document` (`mcp_server.py:61-64`)
* `read_text_source(path:string, start:int=1, count:int=20, locator:string|null, context:int=1)` (`:67-70`)
* `search_local_text(paths:array<string>, query:string, limit:int=10)` — **in-memory**, `persistentIndex:false` (`:44-48`)
* `write_markdown(title, body, output_path, sources:array<object>, evidence_chunk_ids:array<string>|null)` (`:91-93`)
* `write_docx(…same…)` (`:96-98`)

`research_stack.recommended_server` (`recommended_server.py:103`, budget 6 incl. the deprecated alias)
* `search_literature(provider, query, limit=10)`, `check_citation(doi)`, `zotero_collections()`, `zotero_item(key)`,
  `prepare_zotero_import(records, file_name)`; plus `search` alias registered **only when no preset is selected**
  (`recommended_server.py:35-36`, `:94-111`).

`research_stack.lab_server` (`lab_server.py:194`, budget 9)
* `index_corpus(paths:array<string>, mode:string="index")` — `mode="remove"` is refused with `INDEX_MODE_REMOVED` (`:88-97`)
* `unindex_corpus(paths)` (`:100-105`), `search_corpus(query, limit=10)` (`:108-114`), `evidence_read(chunk_ids)` (`:117-130`),
  `claims_read(limit=50, claim_id, status, cursor)` (`:133-138`),
  `claims_write(statement, claim_id, status, note, evidence_chunk_ids, evidence_role="supporting", evidence_rationale="", evidence_mode="append", idempotency_key)` (`:141-160`),
  `claims_export(claim_ids, include_stale=false)` (`:163-168`), `store_status()` (`:171-176`),
  `store_maintenance(action="backup", confirm=false, backup_path)` (`:179-186`).

Launch: each server's `main()` calls `register_tools(...)` then `server.run(transport="stdio")`
(`mcp_server.py:104-107`, `recommended_server.py:106-111`, `lab_server.py:197-199`).
VS Code starts them through `McpStdioServerDefinition(runtime.python, [...PYTHON_FLAGS, "-m", server.module], {RESEARCH_STACK_WORKSPACE, RESEARCH_STACK_TOOL_PRESET})`,
filtered by the selected preset (`extension/extension.js:567-574`; `PYTHON_FLAGS = ["-I","-B","-X","utf8"]` from `extension/runner.js`).
Server/tool registry: `extension/presets.json` (`servers[]` + `presets[]` + `budget`). The Basic template `.mcp.json`
launches only the Basic server via `uv run --locked --no-dev --project .research-toolkit/worker research-stack-mcp`
(`templates/basic-workspace/.mcp.json`); `pyproject.toml:17-19` exposes only `research-stack` and `research-stack-mcp`
— **lab_server/recommended_server have no console entry point**; they are launched as `-m research_stack.lab_server`.
`corpus_status()` is a helper, not a tool (`lab_server.py:189-191`).

---

## 8. Least-disruptive insertion points for PDF/DOCX ingestion

**Extend, do not replace:**

1. `full.scan_sources()` (`full.py:102-156`) — the single format gate (`:135-136`) and the only place that produces
   `SourceRecord`. Add a binary branch that (a) keeps path normalisation/containment (`:122-134`), (b) keeps
   `source_version_id = sha256(raw)` (`:155`), (c) records `kind`, `parser_id`, `unit`, `coverage`, `warnings`.
   `SourceRecord` is a frozen dataclass with 4 fields (`full.py:44-54`) — extend it with defaulted fields so
   `chunks_for_source`/`reindex_preview` call sites (`records.py:450`, `:893-900`) keep working.
2. `full.chunks_for_source()` (`full.py:159-184`) — the only chunk-identity producer. A PDF/DOCX chunker must keep the
   `chunk_id`/`content_id` tuple contract (`:168`, `:171`) and emit a **versioned** `chunker_id`
   (e.g. `pdf-page-window-v1:1200:120`, `docx-block-window-v1:…`) instead of reusing `paragraph-window-v1` (`:20`, `:164`).
3. `records.index_corpus()` (`records.py:430-509`) — keep the per-path `current=0` → insert → `_collect_retired`
   sequence (`:468-484`) and the single commit/rollback (`:488-496`); add per-source coverage/kind/parser columns and a
   run/batch row. `reindex_preview()` (`records.py:887-929`) must gain the same format support or PDF previews will
   report `changed: True` with `currentSha256: None` (`:903-909`).
4. `records.stored_chunks()` (`records.py:512-537`) and `full.search_bm25()` (`full.py:210-245`) — the retrieval seam.
   If FTS5 is introduced, this is the only call site to swap (`records.py:545`), and `SearchHit.retrieval_method`
   (`full.py:61`) already carries the method label the servers echo as `"method": "bm25"` (`lab_server.py:112`).
5. `documents.py` — reuse `extract_document` (`:100-156`) as the batched extractor; add a locator-aware
   `read_document(path, locator=…)` in `mcp_server.py:61-64` so a stored PDF locator is reopenable (today only
   `read_text_source` understands `paragraph=…`, `documents.py:185`).
6. `lab_server.py` — new verbs must be added to `LAB_TOOLS` (`:194`), `TOOL_TITLES` (`:34-44`), `TOOL_ANNOTATIONS`
   (`:48-58`) and `presets.LAB_TOOLS` (`presets.py:23`), plus `extension/presets.json` servers/presets.

**New tables/columns needed (schema v3):**
* `sources`: `kind TEXT NOT NULL DEFAULT 'text'`, `unit TEXT`, `parser_id TEXT`, `coverage_units INTEGER`,
  `coverage_returned INTEGER`, `coverage_complete INTEGER`, `warnings TEXT` (JSON), `mtime_ns INTEGER`,
  `live_hash_matches INTEGER` (or compute at read time), `chunker_id TEXT`.
* `chunks`: structured locator columns `unit TEXT`, `unit_index INTEGER`, `char_start INTEGER`, `char_end INTEGER`
  (keep `locator TEXT` for compatibility with `documents.py:185` and `export_claims` labels `records.py:867`).
* New `index_runs(run_id, started_at, finished_at, mode, source_count, chunk_count, status, accepted_partial, error_code)`
  + `sources.run_id` for atomic-batch/cancellation evidence.
* Optional FTS5: `CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid=…)` +
  `AFTER INSERT/UPDATE/DELETE` triggers on `chunks` — requires `chunks.rowid` stability (today `chunk_id` is a TEXT PK,
  so rowid is implicit and stable only while rows are not deleted; `_collect_retired` deletes rows, `records.py:353-354`).
* Migration: bump `SCHEMA_VERSION` to 3 (`records.py:36`), add `3` to `SUPPORTED_SCHEMA_VERSIONS` (`:37`), extend
  `_migrate_to_current` (`:239-270`) with additive `ALTER TABLE … ADD COLUMN … DEFAULT` only, keep `executescript(SCHEMA)`
  (`:262`), stamp `migrated_from` (`:269`). Never mutate existing `chunks` rows: their ids are content hashes.

**Compatibility risks for existing Markdown/text records and BM25:**
* `init_store()["tableCount"]` and the exact table set are asserted: `tests/test_records.py:43-44` (`== 7`),
  `tests/test_workspace.py:46`, `:78` — any new table breaks three tests until updated.
* `chunker_id` is a stored fingerprint (`full.py:164`); changing the default `chunk_chars`/`overlap` or the paragraph
  regex (`full.py:79`) **re-ids every existing chunk** and silently turns every claim link stale
  (`records.py:603`). Keep `paragraph-window-v1` byte-compatible.
* `search_bm25` scores over the whole current set (`full.py:218-224`): adding PDF/DOCX chunks changes idf/avgdl, so
  existing Markdown ranking order can shift. Determinism is guaranteed by the sort key (`full.py:244`), not by the corpus.
* `MAX_STORE_CHUNKS = 20000` (`records.py:40`) is also the `stored_chunks` `LIMIT` (`:512`, `:520`): if PDF ingestion
  raises the cap, `stored_chunks` **silently truncates the BM25 candidate set** (§10).
* `scan_sources` byte caps (`full.py:17-18`) are text-oriented: a 5 MiB PDF is legal but a 5 MiB text file is the limit;
  `MAX_INPUT_BYTES = 50 MiB` in the reader (`documents.py:28`) is a different number — reconcile or document both.
* Tool-surface gates: `tests/test_lab_server.py:42-58` (`len(LAB_TOOLS) == 9`, exact title/annotation sets),
  `tests/test_functional_check.py:30-34` (`toolCount == 20`, exact verb lists), `extension/functional_check.py:27-34`
  (`SERVER_BUDGETS`, `EXPECTED_TOOLS`), `tests/test_presets.py:44-52` (registry ⇄ `presets.py` equality),
  `extension/presets.json` `budget.toolkitCeilingPerPreset = 12`.
* Packaging gates: every new `src/research_stack/*.py` must be added to `extension/worker/bundle.json` `files{}`
  (currently 16 python modules + 4 manifest files) and re-hashed, or `tests/test_vsix.py:147` (payload drift) and the worker-bundle tests
  (`tests/test_lock_consistency.py:70-95`) fail; `tests/test_release_identity.py` pins one 3-part version across
  `pyproject.toml`, `__init__.py`, `extension/package.json`, `vsix-manifest.json`, `runtime.js`, `worker/bundle.json`.

---

## 9. Test conventions to match

* Plain pytest, `tmp_path` only; **no conftest.py**, no shared fixtures; `testpaths = ["tests"]`, `addopts = "-q"`
  (`pyproject.toml:28-30`).
* Local builder helpers: `workspace(tmp_path)` writes `notes/dissertation.md` + `notes/methods.md`
  (`tests/test_records.py:15-27`); `fixtures(tmp_path)` builds a blank-page PDF with `PdfWriter` and a paragraph+table
  DOCX with `Document()` (`tests/test_documents.py:21-35`); `_paragraph_table_paragraph()` for ordering cases
  (`tests/test_documents.py:91-102`).
* MCP-server tests monkeypatch the workspace env through a fixture:
  `@pytest.fixture def workspace(tmp_path, monkeypatch): … monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(tmp_path))`
  (`tests/test_lab_server.py:30-38`) and call the tool functions **directly in-process** (`:71-101`).
* A `Recorder` stand-in replaces `MCPServer.tool()` to assert registration order/titles/annotations
  (`tests/test_lab_server.py:16-28`, `tests/test_presets.py:22-33`); registry cross-check reads
  `extension/presets.json` (`tests/test_lab_server.py:10`, `tests/test_presets.py:19`).
* Real transport is exercised by subprocess against `extension/functional_check.py` with `-I -B`
  (`tests/test_functional_check.py:12-19`); the check itself spawns real stdio servers with `-I -B -X utf8`
  (`extension/functional_check.py:38-42`).
* Store tests open the DB directly with `sqlite3.connect(records.store_path(root))` to inject defects
  (`tests/test_records.py:300-303`, `:314-317`, `:331-343`, `:489-493`) and assert **byte-identity** for read-only
  behaviour: `assert records.store_path(root).read_bytes() == before, "a preview writes nothing"` (`:280-285`, `:304-307`).
* Names carry the review evidence key in the docstring — `"""F03: …"""`, `"""F13: …"""`, `"""T5-01: …"""`
  (`tests/test_records.py:98`, `:289`, `:471`); failure assertions use `pytest.raises(StoreError)` then
  `assert "CODE" in str(failure.value)` (`:31-33`, `:451-467`) or `pytest.raises(..., match="UNSUPPORTED_FORMAT")`
  (`tests/test_documents.py:136`).
* Negative-space assertions carry a message: `assert not records.store_path(workspace).exists(), "a read created a store…"`
  (`tests/test_lab_server.py:184`), `assert not list(outside.iterdir()), "nothing was written through the link"`
  (`tests/test_records.py:363`).
* Time is frozen by monkeypatching `records._now` (`tests/test_records.py:378`).
* Counts today: 219 Python tests pass (`.agent/QUALITY_STATE.md` "Verified now"); per-file `def test_` counts:
  records 27, research 18, lock_consistency 79, vsix 19, presets 12, documents 11, stdio 9, lab_server 9, functional_check 5,
  workspace 6, full 5, release_identity 6, configuration 3.

---

## 10. Silent truncation / silent overwrite inventory

| # | Behaviour | file:line |
|---|---|---|
| 1 | PDF/DOCX range clamps to the document end with **no warning** (only `coverage.truncated`); the text reader does emit `RANGE_TRUNCATED` | `documents.py:119` + `:129`; `documents.py:139` + `:147`; contrast `documents.py:207-208` |
| 2 | `stored_chunks` applies `LIMIT ?` (default `MAX_STORE_CHUNKS`) to the BM25 candidate set — a store larger than the cap would be silently under-searched | `records.py:512`, `:518-521` |
| 3 | `claim_events` detail is cut to 400 chars | `records.py:801` (`detail[:400]`) |
| 4 | `read_claims` returns only the last 20 history events (`write_claim` returns all) | `records.py:639-640` vs `:775` |
| 5 | `export_claims` drops stale references unless `include_stale=True` (counted, but the reference disappears) | `records.py:855-856`, `:881` |
| 6 | `_collect_retired` **deletes** retired chunks that no claim cites, on every reindex and on vacuum | `records.py:343-355`, `:484`, `:1032` |
| 7 | Reindex flips `current = 0` then `DELETE FROM sources` per path before inserting (delete-then-insert; transactional, but a partial path list silently leaves the rest of the index untouched) | `records.py:468-481`; `remove_sources` `:380-382` |
| 8 | Chunk upsert updates only `current`/`indexed_at` — `text`, `locator`, `text_sha256` are **not** rewritten on conflict | `records.py:473-477` |
| 9 | `INSERT OR REPLACE` on `meta` keys overwrites the previous fingerprint/timestamp without history | `records.py:387-388`, `:486-487`, `:219-220` |
| 10 | Migration seeds `source_versions.bytes = 0` (a provenance value that looks real) | `records.py:265-267` |
| 11 | `scan_sources` silently dedupes repeated paths (`continue`) | `full.py:127-128` |
| 12 | `search_bm25` returns `hits[:limit]` with `limit ≤ 50`; no "more results exist" signal | `full.py:212-213`, `:245` |
| 13 | `read_text_document` caps `count` at 200 and `context` at 5 (errors, not truncation) | `documents.py:31`, `:169-172` |
| 14 | `read_document` caps `count` at 100 per call; a 500-page PDF needs 5 calls | `documents.py:103-104`, `:29` |
| 15 | Report body limit 100 000 chars; ≤100 citations; ≤100 evidence ids (errors) | `mcp_server.py:84-85`; `documents.py:215`, `:254-255` |
| 16 | `workspace.initialize_workspace` rewrites `.research-toolkit/profile.json` in place (fields preserved, file replaced) | `workspace.py:58-62` |
| 17 | Confirmed restore replaces the live store with `os.replace` (previous store preserved under a new name) | `records.py:1014-1024` |
| 18 | `_reconcile_evidence` `mode="replace"` deletes all links for a claim before re-adding | `records.py:809-812` |
| 19 | `claim_evidence.locator` is copied from the chunk at link time and later overwritten by the chunk's locator on re-link — it is not an independent historical locator | `records.py:821-825` |
| 20 | Non-overwriting guarantees that must be preserved: `open("xb")` report writes, `open("x")` RIS write, bundle refuses an existing directory | `documents.py:353-360`, `:402-405`; `recommended_server.py:85-89`; `bundle.py:17-18` |

---

## 11. Top risks for 0.3.9 (highest value first)

1. **Two different format gates.** `documents.py:77` accepts PDF/DOCX; `full.py:135-136` refuses them. Fixing only one
   produces a reader that indexes nothing, or an index whose chunks cannot be reopened by any reader.
2. **Locator incompatibility.** Stored locators are `paragraph=N;chars=a-b` (`full.py:167`) and only
   `read_text_source` parses them (`documents.py:185`); PDF page/offset locators (`documents.py:125`) have no storage
   column and no reopen path (`mcp_server.py:61-64`).
3. **Chunk-id churn turns claims stale.** Any change to `CHUNKER_ID`, defaults, or the paragraph regex re-ids existing
   chunks (`full.py:20`, `:161-171`) and flips every claim link to `stale` (`records.py:603`), while uncited retired
   chunks are deleted in the same call (`records.py:484`).
4. **No FTS today + a shared 20 000-chunk cap.** BM25 is in-memory per call (`full.py:210-245`, `records.py:512-520`);
   PDF ingestion multiplies chunk counts, so the cap becomes both a hard failure (`STORE_CHUNK_LIMIT`, `records.py:461-462`)
   and a silent under-search if raised inconsistently.
5. **Surface/packaging gates are strict and cross-language.** 20 tools, per-server budgets, preset equality, worker-bundle
   hashes and one 3-part version are all asserted (`tests/test_functional_check.py:30-44`, `tests/test_presets.py:44-52`,
   `tests/test_lab_server.py:42-58`, `tests/test_vsix.py:147`, `tests/test_release_identity.py`); a new verb or module
   must be added in Python, `extension/presets.json`, `extension/functional_check.py`, `extension/worker/bundle.json`
   and the Node tests in the same change.
