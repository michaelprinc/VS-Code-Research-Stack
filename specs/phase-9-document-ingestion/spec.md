# Phase 9 specification — direct PDF/DOCX ingestion, freshness, and skill bundles (0.3.9)

Date: 5 November 2026 (Europe/Prague). Predecessor: [specs/phase-8-utf8-stdio](../phase-8-utf8-stdio/spec.md) (0.3.8 UTF-8 stdio).
Scope: a feature release with two deliverables that must land together — (a) indexing text-bearing PDF and DOCX files
into the existing local record store with original-document provenance, and (b) a reviewed topic **skill-bundle**
catalog installable from the Toolkit control panel, with the theological-research PoC as its first bundle.

Excluded, as briefed: OCR and scanned-image recognition, vector/embedding search, background ingestion, external
account provisioning, automatic paper acquisition. Development happens in the DeepSeek Harness container
(WSL2, Debian 13, CPython 3.12.16 venv, Node 24). A Windows VS Code/Copilot host is **not reachable from this
container**; no case below claims one.

## 1. Baseline that was measured, not assumed

| Fact | How it was measured here |
|---|---|
| The project venv has the extraction libraries: `mcp 2.2.0`, `pypdf 6.4.1`, `python-docx 1.2.0`, pytest 8.4.2; `duckdb`, `qdrant_client`, `fastapi`, `yaml` are absent. | `.venv/bin/python -c "import importlib …"` (3.12.16). The brief's note that `/usr/bin/python3` 3.13.5 lacks `mcp`/`pypdf`/`docx` is true **of that interpreter only**. |
| The reader already extracts PDF and DOCX with locators, coverage and warnings. | `extract_document()` on a synthetic 3-page PDF returned `coverage {totalUnits: 3, unit: page, returnedFrom: 1, returnedTo: 3, truncated: false}`, locators `{page: 1..3, characters: …}`, page 2 with `characters: 0`. |
| The reader refuses, honestly, the malformed cases. | `encrypted.pdf` → `PDF_ENCRYPTED`; `corrupt.pdf` → `PDF_PARSE_FAILED: PdfStreamError`; page-less PDF → `PDF_EMPTY`; DOCX with 3 paragraphs + a 3-row table → 7 ordered units, kinds `paragraph` and `table-1-row`. |
| The indexer refuses the same files. | `full.py:135-136` raises `UNSUPPORTED_FORMAT: prototype accepts UTF-8 Markdown and text only.` — the origin of the 0.3.8 field observation. |
| Retrieval is pure-Python BM25, not SQLite FTS. | `full.py:210-245` via `records.stored_chunks` (`records.py:512-537`). SQLite 3.53.1 in the venv does expose fts5; it is unused. |
| The store records no format, parser, coverage or hash-check state. | DDL at `records.py:48-107` (schema version 2, 7 tables). |

Full audits: [.agent/0.3.9/A-python-core.md](../../.agent/0.3.9/A-python-core.md) (Python core, 440 lines),
[.agent/0.3.9/B-extension-packaging.md](../../.agent/0.3.9/B-extension-packaging.md) (extension and packaging),
[.agent/0.3.9/C-theology-bundle.md](../../.agent/0.3.9/C-theology-bundle.md) (the PoC bundle, hashes and scripts).

## 2. Findings

Line numbers refer to the 0.3.8 tree (`v0.3.8`, commit `7638898`) unless stated.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **D9-01** | Two format gates. The reader accepts PDF/DOCX; the indexer refuses them. | `documents.py:75-82` vs `full.py:135-136`; the refusal reaches the client through `records.py:443` → `_prototype_error` (`records.py:139-146`) → `lab_server.py:74-85`. | A PDF can be *read* by an assistant and cannot be *indexed* by the same toolkit. |
| **D9-02** | A reader call is bounded at 100 units and 1 000 000 characters. | `documents.py:103-104` (`count` 1..100), `documents.py:154-155` (`RESULT_TOO_LARGE`). A 500-page PDF needs 5 calls. | Indexing that reuses the reader must batch and **prove** coverage; one call silently covers only part of a document. |
| **D9-03** | PDF/DOCX locators are dicts and are not storable or reopenable. | `documents.py:125` `{"page": n, "characters": n}`, `documents.py:145` `{"item": n, "kind": …}`; the store's only locator grammar is `paragraph=N;chars=a-b` (`full.py:167`) and only `read_text_source` parses it (`documents.py:185`). | A stored PDF hit cannot be reopened at its page; provenance dies at the store boundary. |
| **D9-04** | The store has no format, parser identity, coverage, outcome or hash-check column. | `records.py:58-77`. `get_chunks` reports `stale = not current` only (`records.py:580`). | "Indexed version" and "present hash actually checked" are the same non-fact today. |
| **D9-05** | A source is hashed once, while it is read. | `full.py:144-155`. Nothing re-hashes after extraction. | A file that changes during a long extraction is indexed as one version with no evidence it changed. |
| **D9-06** | One bad file aborts the whole batch. | `records.py:443-452` raises on the first failing source; the receipt names no per-file outcome. | A corrupt PDF among 20 selected files blocks the other 19 and the receipt cannot say which file failed. |
| **D9-07** | Exports know "stale" but not "unverified". | `records.py:855-856`, `:881`. A claim citing a chunk whose source file is now missing exports as if it were live. | A report can cite a document that no longer exists, without saying so. |
| **D9-08** | Migration is 1→2 only, additive. | `records.py:239-270`, `SUPPORTED_SCHEMA_VERSIONS = (1, 2)` (`:37`). | 0.3.9 needs a reviewed 2→3 migration with tested backup/rollback against real 0.3.8 stores. |
| **D9-09** | Chunk identity is content-derived, so any change to the text chunker re-ids every existing chunk. | `full.py:167-171`; `chunker_id = "paragraph-window-v1:1200:120"` (`full.py:20,164`); claim links then flip to `stale` (`records.py:603`) and uncited retired chunks are deleted in the same call (`records.py:484`). | The PDF/DOCX chunker must be a **new** versioned chunker; `paragraph-window-v1` stays byte-compatible. |
| **D9-10** | `MAX_STORE_CHUNKS = 20000` is both a hard cap and the BM25 candidate `LIMIT`. | `records.py:40`, `:461-462`, `:518-521`. | Raising one without the other produces a silent under-search once PDFs are indexed. |
| **D9-11** | The tool surface and the packaging are cross-language gates. | `tests/test_lab_server.py:42-58` (`len(LAB_TOOLS) == 9`), `tests/test_functional_check.py:30-44` (`toolCount == 20`), `extension/functional_check.py:27-34`, `tests/test_presets.py:44-52`, `tests/test_records.py:43-44` (`tableCount == 7`), `tests/test_vsix.py:147`, `tests/test_release_identity.py`. | A new verb, table or module must be added in Python, `extension/presets.json`, `extension/functional_check.py`, `extension/worker/bundle.json` and the Node tests **in the same change**. |
| **D9-12** | Error envelopes differ per server. | `lab_server.py:74-85` returns `{"resultState":"error"}` with MCP `is_error: false`; `mcp_server.py:44-70` lets exceptions become SDK `is_error: true`. | A mixed-batch ingestion result must be structured, and the server that carries it must be named. |
| **D9-13** | The theological bundle is staged but not wired. | `templates/skill-bundles/theology/theological-research/` is untracked; `extension/worker/bundle.json` lists only the 5 overlay skills; no catalog, manifest or hash record exists. | "The PoC exists" is not "the bundle interface exists". |
| **D9-14** | The PoC's 11 files are byte-identical to the staged copy, and its scripts are stdlib-only. | `sha256sum` over both trees, `diff -r` clean (C-theology-bundle.md). | The bundle can be hashed and reviewed as-is; the adaptations are content and disclosure, not dependencies. |
| **D9-15** | `dedupe_records.py` silently drops records and overstates what it checked. | Run on `/tmp` copies: records without a title, non-object rows and same-year near-duplicates are dropped; it prints "Fields checked: title, doi, year, authors" while comparing only title and doi; a 0.92 title threshold merges "Distinct Work A" with "Distinct Work B" (0.93). | Shipped as-is it would present a lossy, over-claiming tool as authoritative. |
| **D9-16** | `crossref_lookup.py` swallows a service failure as "NO PLAUSIBLE MATCH" and contacts Crossref/OpenAlex with a placeholder contact address. | Read-only review + `py_compile`; not executed (network). OpenAlex returns `https://doi.org/…`, Crossref returns bare DOIs. | Network disclosure and a distinct service-failure exit are required before shipping it. |
| **D9-17** | The bundle has no license. | No license file in either tree; no `license` frontmatter; authorship only as `metadata.author: "s. Denisa + Michal"`; the extension itself is `UNLICENSED`. | Redistribution terms must be settled before publishing the bundle. |
| **D9-18** | An untracked 6th overlay skill (`document-corpus-bridge`) overlaps the new direct ingestion. | `templates/recommended-overlay/.github/skills/document-corpus-bridge/` (untracked, added 5 November 2026). | Ownership must be decided so one workspace does not carry two competing instructions for the same job. |

## 3. Requirements

`R9-xx` are normative. `→` names the finding they close.

### 3.1 Direct ingestion with original provenance (D9-01…D9-06, D9-12)

- **R9-01** `index_corpus` accepts explicitly selected workspace PDF and DOCX files beside Markdown/text. Source
  files are read only; the store is the only file written.
- **R9-02** Ingestion reuses the shared structured extraction in `documents.py`, in bounded batches, and proves
  coverage: a source is *complete* only when every unit the source reports was read. A per-call limit may never
  silently truncate an index.
- **R9-03** A PDF chunk carries its original page number and its offsets in that page's extracted text. A DOCX chunk
  carries its ordered item index, the item kind (`paragraph` or `table-N-row`) and offsets. No line numbers, bounding
  boxes, or DOCX page numbers are invented.
- **R9-04** The Markdown/text chunker `paragraph-window-v1` stays byte-compatible: existing chunk ids, locators and
  BM25 behaviour are unchanged for existing sources.
- **R9-05** Every indexed source records: relative path, source-byte SHA-256, byte size, kind, parser identity and
  version, chunker identity, unit count, units read, units with no extractable text, warnings, and an outcome of
  `complete`, `partial` or `failed`.
- **R9-06** Partial acceptance is explicit. Default is *do not accept*: a partial or failed attempt never replaces a
  previously indexed complete version of that source.
- **R9-07** A mixed batch reports per-file outcomes. A failure of one file does not undo the others; if every file
  fails, nothing is written. Structured application failures keep their `CODE: sentence`; they are never reported as
  a transport failure.
- **R9-08** A stored PDF/DOCX locator is reopenable: the reader accepts the locator a search or an evidence read
  returned and returns that unit with its neighbours.

### 3.2 Freshness, preservation, migration (D9-04, D9-05, D9-07, D9-08, D9-10)

- **R9-09** Freshness is a recorded check, not an inference: `verified`, `changed`, `missing`, `inaccessible` or
  `unchecked`, each with the time the check ran. `unchecked` is never presented as `verified`.
- **R9-10** Search hits, evidence resolution, claim links and exports carry the freshness of the source they came from.
- **R9-11** Reindexing is transactional. A source whose bytes change while it is being extracted is refused with
  `SOURCE_CHANGED_DURING_INDEX` and keeps its previous indexed version. Cancellation rolls the whole run back.
- **R9-12** Chunks a claim still cites are retained as historical evidence, are labelled historical, and are excluded
  from an export unless the caller asks for them. Stale **and** unverified references are excluded by default and
  counted when excluded.
- **R9-13** Schema version 3 is reached by an additive, reviewed 2→3 migration. Existing claims, chunk ids,
  identifiers and user rows are preserved; migrated rows are labelled `legacy`, not back-filled with invented
  coverage. Backup, staged restore and rollback are proven against a store built by the 0.3.8 code.

### 3.3 Skill bundles (D9-13…D9-18)

- **R9-14** A reviewed built-in catalog names each bundle by stable id, version, topic, purpose, its complete file
  list with SHA-256 per file, compatibility and provenance.
- **R9-15** The control panel shows the chosen workspace, the exact target paths, the prerequisites and the per-file
  state **before** anything is written. It installs reviewed catalog files only: no preset change, no model request,
  no connection to an outside service.
- **R9-16** Installation is staged and verified, writes a per-skill receipt and a log, and can be retried or repaired.
  A file the user modified is preserved and reported as a conflict; it is never overwritten silently.
- **R9-17** A completed 0.3.8 overlay receipt is never treated as evidence that a bundle is installed. Three separate
  statuses are reported: files installed, host discovery verified, workflow tested. Only the first may be claimed by
  an automated install.
- **R9-18** A skill shared by two bundles has one owner and a stated rule; uninstalling one bundle never removes a
  shared skill, a user document, a claim or a store.
- **R9-19** Bundle files are packaged, hashed and audited: source → worker payload → VSIX member, with the digests
  compared. Existing package settings, workspaces and user preferences are untouched.
- **R9-20** The theological bundle ships as version 2.0 with every adaptation documented, its 11 file hashes
  recorded, its scripts' network and working-directory assumptions disclosed, near-duplicate bibliographic output
  labelled reviewable, and its license status stated as unresolved until the author decides.

### 3.4 Verification (D9-11, and the brief's boundary)

- **R9-21** Every acceptance case is proven on this container with disposable fixtures and isolated stores. Existing
  suites stay green: 336 Node cases and 219 Python cases as recorded for 0.3.8.
- **R9-22** No case claims a Windows or live VS Code/Copilot result. Where only the container ran, the receipt says
  so, and the host-side question is recorded as an open follow-up.
