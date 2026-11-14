# Phase 14 design — the two Zotero tools, the snapshot and the journal

## 1. Tool surface before and after

| | 0.3.12 | 0.3.13 |
|---|---|---|
| Zotero verbs in a managed preset | `zotero_collections`, `zotero_item`, `prepare_zotero_import` (3) | `zotero_library`, `zotero_write`, `prepare_zotero_import` (3) |
| Capabilities behind them | 2 | 10 actions (6 read, 4 write) |
| Preset-selectable toolkit tools | 20 | 20 |
| Registered under the unmanaged `all` preset | 21 (20 + `search`) | 23 (20 + `search`, `zotero_collections`, `zotero_item`) |
| Widest preset | research-workflow 11, corpus-lab 11 | unchanged |
| `recommended_server` functional-check budget | 6 | 8 |

`zotero_write` is in `zotero-handoff` and `all` only (DD14-03). `research-core`, `research-lab`,
`research-lab-max`, `research-workflow` and every Basic preset keep the read tool and never see the
write tool.

## 2. `zotero_library` — read-only

`zotero_library(action: str, key: str = "", query: str = "", limit: int = 25, format: str = "json")`
Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
`openWorldHint: true`.

| `action` | Request | Returns | Bound |
|---|---|---|---|
| `status` | `/api/`, `HEAD …/collections`, `…/collections`, `…/tags`, `…/searches`, `…/fulltext?since=0&q=…`, `…/items?format=csljson&limit=1`, `…/itemTypes` | what the running Zotero answers, `serverId`, item/collection/tag/saved-search counts, `fullTextIndexEmpty`, `writeKeyPresent` (boolean only), `libraryEmpty` | 8 small loopback requests; the local API states no rate limit |
| `collections` | `…/collections?limit=100&format=json` | the 0.3.12 `zotero_collections` body | 100 |
| `item` | `…/items/{key}?format=json` | the 0.3.12 `zotero_item` body | key must match `[A-Z0-9]{8}` |
| `search` | `…/items?q=…&format=json&limit=…` | up to `limit` records, each with `key`, `itemType`, `title`, `creators`, `date`, `DOI`, `version`, plus `truncated` | `limit` ≤ 100 |
| `fulltext` | `…/fulltext?since=0&q=…` or `…/items/{key}/fulltext` | the stored full text, or `fullTextUnavailable` naming which answer Zotero gave | 4 MiB response cap already in the client |
| `export` | `…/items?format=csljson\|bibtex\|biblatex\|csv` | the export body inline, plus `accessLabelsInExport: false` for CSL-JSON | `limit` ≤ 100 |

Every action answers with `readOnly: true`. A refusal is a `ResearchError` code, never an empty list.

## 3. `zotero_write` — destructive, gated

`zotero_write(action: str, changes: list[dict] | None = None, key: str = "", journal_id: str = "", confirm: str = "")`
Annotations: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`,
`openWorldHint: true`.

| `action` | Needs | Behaviour |
|---|---|---|
| `preview` | `changes` | Reads each target item's current `version`, builds the exact JSON body it would send, reports the diff and the guard it would send (`If-Unmodified-Since-Version: <version>`), and **sends nothing**. This is the only action available without `confirm`. |
| `apply` | `changes` **and** `confirm == "write-to-zotero"` | Takes a snapshot first, then applies, then re-reads and compares. Refused with `WRITE_CONFIRM_REQUIRED` when the literal is absent. |
| `snapshot` | — | Writes a library snapshot into the workspace and returns its path, item count and whether it was truncated. |
| `undo` | `journal_id` | Replays one journal backwards. Reports every entry it could not undo and why. |

`changes` is a list of at most 25 operations, each one of:

| `op` | Fields | Request |
|---|---|---|
| `create_item` | `itemType`, `title`, `creators`, `date`, `DOI`, `url`, `tags` | `POST …/items` |
| `set_item_type` | `key`, `itemType` | `PUT …/items/:key` |
| `update_fields` | `key`, `fields` (a subset of the item's own data keys) | `PUT …/items/:key` |
| `add_tags` | `key`, `tags` | `PUT …/items/:key` |
| `remove_tags` | `key`, `tags` | `PUT …/items/:key` |
| `create_collection` | `name` | `POST …/collections` |
| `add_to_collection` | `key`, `collectionKey` | `PUT …/items/:key` |
| `delete`, `delete_item`, `merge`, `duplicate_check` | — | refused: `ZOTERO_WRITE_ACTION_UNSUPPORTED`, with the reason (DD14-07; the local API has no merge and no restore) |

Item types accepted for `set_item_type` are checked against what `/api/itemTypes` reports, so a typo is
refused before it reaches the library. Tags are checked against the controlled vocabulary
(`references/zotero-vocabulary.md`): a facet outside `access/`, `topic/`, `type/`, `status/` or a tag
longer than 64 characters is refused with `ZOTERO_TAG_OUT_OF_VOCABULARY`.

## 4. Snapshot and journal

- Snapshot: `.research-toolkit/zotero-snapshots/<UTC stamp>.json` in the workspace — items (paginated
  `…/items?format=json`), collections and tags. `limit` per page 100, at most 20 pages, then
  `truncated: true` with the count it did not reach. Never a copy of `zotero.sqlite` (DD14-05).
- Journal: `.research-toolkit/zotero-journal/<journal id>.json` — for each applied operation the target
  key, the `version` read before the write, and the inverse operation. Cap 4096 bytes per journal, one
  journal per `apply`. `undo` re-reads the current version and refuses an entry whose item moved in the
  meantime (`ZOTERO_WRITE_CONFLICT`) instead of overwriting a change the operator made by hand.
- A created item is recorded as `undoable: false` with the reason: there is no restore verb (DD14-07).
  The snapshot is what a created item can be checked against.

## 5. Key handling

`RESEARCH_STACK_ZOTERO_WRITE_KEY` is read from the worker's environment at request time and put in the
`Zotero-API-Key` header. It is never returned, never logged, never written to a file, never included in
a snapshot, journal, report or problem report. `/api/local/authorize` is never called. A write with no
key answers `ZOTERO_WRITE_KEY_MISSING` and names the 401 + `WWW-Authenticate` meaning. `status` reports
`writeKeyPresent` as a boolean.

## 6. RIS

- `to_ris` maps `statute` → `STAT`, `thesis` → `THES`, `report` → `RPRT`, `book` → `BOOK`,
  `bookSection`/`chapter` → `CHAP`, conference/proceeding → `CPAPER`, journal article → `JOUR`, and
  anything else → `GEN` **with a warning naming the type it could not map**, because the operator
  measured `GEN` arriving as `journalArticle`.
- Access status and topic become `KW  - access/metadata_only` and `KW  - topic/canon-law` lines from the
  controlled vocabulary. `N1` is not used for machine-readable status.
- `prepare_zotero_import` runs the same structural validation as `scripts/validate_ris.py` over the text
  it generated and refuses to write a file that fails it (`RIS_INVALID`).
- `validate_ris.py` checks: exactly one `TY` and one `ER` per record, the `XX  - ` line shape,
  non-repeatable tags not repeated, unknown tags, a record with neither author nor title, and a record
  with no identifier at all (a warning, not a defect — it is a record that cannot be deduplicated
  reliably, not one to discard). `TY  - GEN` is a warning on every record that carries it: the translator
  measured on 14 November 2026 maps GEN to `journalArticle` whatever the title says, and a validator that
  guessed a genre from a title would be making a claim it cannot support. Exit 0 clean, 1 defects found,
  2 usage error; `--expect N` compares the record count.

## 7. What stays out

`zotero.sqlite` is never opened. `localAPIKeys.json` is never read. `/api/local/authorize` is never
called. No delete. No third-party MCP server, no Better BibTeX, no cloud zotero.org request. No automatic
download of paywalled full text. No retraction claim. No vector search.
