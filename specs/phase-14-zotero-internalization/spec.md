# Phase 14 — Zotero work internalized in the Toolkit's own worker (0.3.13)

The brief for this phase is an operator's measurement report of **14 November 2026**, written after
working against a **real Zotero 10.0.8 library (93 items: 43 top-level + 50 child notes, 37 with a DOI,
0 collections, 0 tags, 0 saved searches, empty full-text index)** on Windows. It is kept as a tracked
artifact in [evidence/realhost-2026-11-14/](../../evidence/realhost-2026-11-14/README.md). Every claim
below carries the brief's own evidence label: **[ZMĚŘENO]** measured in that session, **[NAJDO]** found
and confirmed to exist but never installed or run, **[ZÁMĚR]** not yet done.

## 1. What the brief asks for, and what it measured

| # | Finding in the brief | Label | Consequence for 0.3.13 |
|---|---|---|---|
| 1 | Zotero 10's local API **writes**: `POST /api/users/0/items` → 200 with `key` + `version`; `PUT …/items/:key` with `If-Unmodified-Since-Version` → 204; `POST …/collections` → 200; `DELETE` → 204, and **428 when `If-Unmodified-Since-Version` is missing**. | [ZMĚŘENO] | The read-only limit is a limit of *this Toolkit's adapter*, not of Zotero. 0.3.13 adds a write path the operator controls. |
| 2 | An import returned HTTP success and created **156 items, 61 of them empty**. | [ZMĚŘENO] | A status code is not an import result. Validation before, a count check after, and a snapshot before any write. |
| 3 | `GET …/fulltext?q=…&since=0` → 200 (**400 without `since`**); the library's full-text index is **empty**; only 1 of 43 items has been read in full. | [ZMĚŘENO] | Full text is read through endpoints the local API already has; no third-party server is needed. |
| 4 | Export works without a plugin: `format=csljson\|bibtex\|biblatex\|csv` → 200; **`format=markdown` → 400**, `format=counts` → 400. In BibTeX `extra` survives as `annote`; in CSL-JSON `extra` and tags are **absent**. | [ZMĚŘENO] | An access label cannot be read out of a CSL-JSON export; it has to come from tags. |
| 5 | `server_localAPI.js` (1 654 lines) has **no duplicate-detection and no merge endpoint**; Zotero's "Duplicate Items" is UI-only. | [ZMĚŘENO, source read] | Deduplication stays a local operation over records the Toolkit already holds. |
| 6 | **3 of 43** imported records carry no DOI, ISBN or URL. | [ZMĚŘENO] | Those records cannot be deduplicated reliably. The Toolkit must say so instead of guessing. |
| 7 | `TY  - GEN` was mapped to `journalArticle` for the Codex of Canon Law and for apostolic constitutions. `/api/itemTypes` contains `statute`, `document`, `bookSection`, `thesis`, `report`, `standard`. `PUT` changes an item type (204). | [ZMĚŘENO] | A type fix is a write, not a re-import. |
| 8 | RIS field mapping: `KW` → tags (filterable), `M2` → `extra`, `N1` → **child notes** (not filterable), `N2` → abstract, `DP` → `libraryCatalog`, `ID` ignored, unknown fields → a note tagged `_RIS import`. | [ZMĚŘENO, translator read] | Access status and topic belong in `KW`, not in `N1`. |
| 9 | The library has **0 collections and 0 tags**; access status lives in `extra` and in 50 generated notes. | [ZMĚŘENO] | The largest gap is organization, not retrieval. |
| 10 | The local API key file is `…\AppData\Roaming\Zotero\Zotero\Profiles\<profile>\localAPIKeys.json` — **`Zotero` appears twice**; earlier documents named a path that does not exist. | [ZMĚŘENO] | Correct the path in the guide. Never read the file. |
| 11 | `search_literature` with `semantic_scholar` fails with `PROVIDER_TERMS_NOT_ACKNOWLEDGED`; no licensed database (ATLA, Scopus) is connected. | [ZMĚŘENO] | Out of scope for 0.3.13: that is an entitlement question, not a software one. Recorded, not fixed. |
| 12 | Recommended third-party MCP servers (`zotero-native-mcp`, `zotero-local-mcp`, `zotero-agent`, Better BibTeX). | [NAJDO] | **Not installed, not added to the component catalog.** The operator's instruction for 0.3.13 is to internalize the capability instead. |

## 2. Primary-source facts about a Zotero 10 write

From [Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/local_api) and its
[source](https://github.com/zotero/zotero-docs/blob/main/content/dev/web_api/v3/local_api.md):

| Fact | Consequence for 0.3.13 |
|---|---|
| A write with no key, or with an unrecognized key, returns **401** with `WWW-Authenticate: Zotero-API-Key realm="Zotero Local API"`. | A 401 on a write means the key is missing or wrong. The Toolkit says exactly that. |
| A key is issued through `POST /api/local/authorize`, which **shows the user a consent dialog**. Keys are stored in the profile and are **not scoped**: one key allows writes to any library the user can edit. | The Toolkit never calls that endpoint and never accepts the consent on the operator's behalf (DD13-03 stands). The key is the operator's act. |
| Reads need no authentication; the local API is offline and has **no rate limits**. | A readiness check may make several small loopback requests. |
| Data-object versions are maintained locally and increment once per library per transaction, including local API writes. | `If-Unmodified-Since-Version` is the only honest guard against overwriting a change the user made in the meantime. |

## 3. Requirement register

| ID | Requirement | Disposition in 0.3.13 |
|---|---|---|
| ZT-01 | One tool reads the library: status, collections, one item, a bounded search, full text, and an export body. | **Built** as `zotero_library`. |
| ZT-02 | One tool writes the library, and every write is previewed before it can be applied. | **Built** as `zotero_write` with `preview` / `apply` / `undo` / `snapshot`. |
| ZT-03 | A write is impossible without the operator's explicit confirmation string and without a snapshot taken first. | **Built**: `confirm: "write-to-zotero"`, snapshot mandatory, refusal named by code. |
| ZT-04 | The Toolkit never opens `zotero.sqlite` and never reads `localAPIKeys.json`. | **Kept** (DD12-02, DD13-03). The snapshot is taken through the local API. |
| ZT-05 | The Toolkit never calls `/api/local/authorize` and never triggers Zotero's consent dialog. | **Kept.** |
| ZT-06 | No key value is ever stored, logged, echoed, reported or written to a file by the Toolkit. | **Built**: the key is read from the worker's environment only at request time; `status` reports presence, never value. |
| ZT-07 | No delete verb. | **Built as an exclusion**: `delete` is refused with `ZOTERO_WRITE_ACTION_UNSUPPORTED`. |
| ZT-08 | The tool surface does not grow: no preset exceeds 12 toolkit tools and the widest preset keeps ≥ 20 tools of headroom (C-13). | **Built**: preset-selectable surface stays 20; `zotero_write` appears only in `zotero-handoff` and `all`. |
| ZT-09 | Old hand-written MCP configurations and skills keep working. | **Built**: `zotero_collections` and `zotero_item` remain as deprecated aliases, registered only under the unmanaged `all` preset (the 0.3.4 `search` precedent). |
| ZT-10 | RIS is validated before it is offered to Zotero, and the validator names the defect that caused the 156-item import. | **Built**: `scripts/validate_ris.py` in the skill bundle, and the worker validates the RIS it generates. |
| ZT-11 | Access status and topic are carried in a filterable place (`KW` tags) from a controlled vocabulary. | **Built**: `references/zotero-vocabulary.md` + `KW` in the generated RIS + `add_tags` write action. |
| ZT-12 | A wrong item type is correctable without re-import. | **Built**: `set_item_type` write action against the item types `/api/itemTypes` reports. |
| ZT-13 | Deduplication is local, DOI-first, and honest about records that cannot be deduplicated. | **Built**: `dedupe_records.py` reports records with no identifier as `not-dedupeable` instead of dropping or merging them. |
| ZT-14 | The guide states which endpoints the running Zotero answers, and the corrected key-file path. | **Built**: `guides/zotero-local-api.md` rewritten from the measured table. |
| ZT-15 | Install third-party Zotero MCP servers or Better BibTeX. | **Not built** [NAJDO]. The operator's instruction is to internalize; the component catalog only lists reviewed components. |
| ZT-16 | Connect Semantic Scholar, ATLA, Scopus or any licensed database. | **Not built.** Entitlement, not software. Recorded as open. |
| ZT-17 | Vector / embedding search. | **Not built.** No recommended tool adds it; it remains a separate project. |
| ZT-18 | Retraction checking of the 43 records. | **Not built and not done.** The brief states it was never checked; 0.3.13 does not claim otherwise. |

## 4. Decisions

- **DD14-01 — one read tool, one write tool.** The brief's capabilities would naively be nine tools
  (`status`, `collections`, `item`, `search`, `fulltext`, `export`, `write`, `undo`, `snapshot`). They are
  two tools with an `action` argument. `zotero_collections` and `zotero_item` are removed from the managed
  surface and kept as aliases under `all` only.
- **DD14-02 — the budget does not move.** Preset-selectable tools stay 20. `zotero_write` is not added to
  any package default preset, so `research-core` (10), `research-workflow` (11) and `corpus-lab` (11) are
  unchanged and C-13 is untouched.
- **DD14-03 — a destructive verb is never in a default surface.** `zotero_write` is offered only in
  `zotero-handoff`, the one preset whose stated goal is the Zotero handoff, and in the unmanaged `all`.
- **DD14-04 — dry-run is not a switch the model can turn off.** `preview` is the only action available
  without a confirmation string; `apply` requires the exact literal `write-to-zotero`. A tool argument
  named `dry_run` would be a suggestion; a required literal is a gate.
- **DD14-05 — the backup is a library snapshot through the local API, not a copy of `zotero.sqlite`.**
  The brief recommends copying `zotero.sqlite`; DD12-02 forbids the Toolkit from opening the library
  database, and a snapshot taken through the same API that will write is the honest counterpart: it is
  what the Toolkit can read back. The guide still tells the operator to copy `zotero.sqlite` themselves
  before a bulk write, and says plainly that the Toolkit does not do it for them.
- **DD14-06 — the key is the operator's, carried in the worker's environment.** The Toolkit never
  stores, generates, requests, logs or displays it. `RESEARCH_STACK_ZOTERO_WRITE_KEY` is read at request
  time. `status` answers `writeKeyPresent: true|false` and nothing else about it. A later release that
  wants the guided key flow must first change the integration state model (Zotero's `authorization` is
  `not-required` today); that is recorded as owed, not done.
- **DD14-07 — no delete.** A delete is the one write the Toolkit cannot make safely: the local API has
  no restore, and the undo journal cannot put a deleted item back. Refused by name.
- **DD14-08 — one transport.** Every new request goes through the existing reviewed loopback client
  `_zotero_request`. No new `build_opener` or `urlopen` call site is added anywhere, so the packaged
  outbound audit keeps its reviewed counts.
- **DD14-09 — `openWorldHint` is corrected.** Three documents say network verbs are marked open-world and
  no shipped tool sets it true. The Zotero and metadata verbs now say `openWorldHint: true`, which is
  what the documents already claimed and what the client needs to gate them.
- **DD14-10 — `KW` carries what `N1` cannot.** Access status and topic become tags from a controlled
  vocabulary; `N1` stays a human note. The vocabulary file caps each facet so tags do not decay into
  dozens of variants.
- **DD14-11 — the count check is a failure, not a note.** After a write the Toolkit re-reads the counts
  it changed and reports a mismatch as an error, because 200/204 is not proof that the library is right.

## 5. What this phase does not claim

No Zotero exists in this container. Every Zotero behaviour 0.3.13 is tested against is an **emulated
Zotero on the real port 127.0.0.1:23119**, extended from the phase-13 harness to answer the write,
full-text, tag, collection and export endpoints with the status codes the operator measured. The
operator's own measurements are recorded as the operator's measurements, with their labels. A write
against a real Zotero 10 on Windows is **owed** (T14-20) and is not claimed here.
