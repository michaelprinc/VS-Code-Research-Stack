# Zotero local integration

Read bibliography metadata, write through a key you authorized, and prepare reviewed manual RIS import.

## Setup

Install Zotero separately. Reading needs no account and no API key: the Toolkit uses loopback localhost:23119/api and read-only requests. If a read returns 403, enable the local API in Zotero under Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"; the Toolkit never changes that setting for you. Manual RIS import is a separate user action.

Writing is a different permission. Zotero 10 answers a write with `401 Unauthorized` and `WWW-Authenticate: Zotero-API-Key` until you have authorized a local key in Zotero's own consent dialog. The Toolkit never opens that dialog for you, never reads Zotero's key file, and never accepts a write consent on your behalf. You hand the key to the Toolkit once, as the `RESEARCH_STACK_ZOTERO_WRITE_KEY` secret in Research Toolkit → Integrations & Accounts, and it is passed to the worker's environment only.

## First task and readiness

Open Research Toolkit → Integrations & Accounts and run Check integrations. The Toolkit detects whether Zotero is installed, whether it answers, and whether its local API is refused, and remembers that decision for every workspace in this VS Code profile — it does not repeat the guide in a second project. A configured Zotero that is not running is reported as "not answering", not as "not installed".

`zotero_library` is the read verb: `status` reports what your Zotero actually answers, `collections` and `item` read them, `search` finds items, `fulltext` reads the text Zotero has indexed, `export` returns csljson, bibtex, biblatex or csv. `zotero_write` is the write verb: `preview` shows the exact request body and refuses to send it, `snapshot` copies the library into your workspace before anything changes, `apply` needs both the key and the literal `write-to-zotero`, `journal` lists what changed with the values it replaced, `undo` replays that journal.

## What this Zotero answered (measured, 14 November 2026)

Against a real Zotero 10.0.8 local API on a Windows host, with a 93-item library:

| Request | Answer |
| --- | --- |
| `GET /api/` | 200, server id and API version in the headers |
| `HEAD /api/users/0/collections` | 200 |
| `GET /api/users/0/collections` | 200, 0 collections |
| `GET /api/users/0/items?format=json` | 200, 43 top-level items, 50 child notes |
| `GET /api/users/0/tags?format=json` | 200, 0 tags |
| `GET /api/users/0/searches?format=json` | 200, 0 saved searches |
| `GET /api/users/0/fulltext?since=0&q=…` | 200, no match — `since` is required, without it the answer is 400 |
| `GET /api/itemTypes` | 200, the types this build accepts |
| `GET /api/users/0/items?format=csljson\|bibtex\|biblatex\|csv` | 200 |
| `GET /api/users/0/items?format=markdown` or `format=counts` | 400 — this build does not answer them |
| `PUT /api/users/0/items/<key>` with no `If-Unmodified-Since-Version` | 428 Precondition Required |
| `PUT` with a version that another change already moved | 412 Precondition Failed |
| `POST`/`PUT` with no authorized key | 401 with `WWW-Authenticate: Zotero-API-Key realm="Zotero Local API"` |

Two of these are the reason the Toolkit behaves as it does. A write without a version guard is refused outright, so every write the Toolkit plans carries the version it read. And there is no Markdown bibliography from Zotero: a Markdown list is generated from your records, not asked of the local API.

An empty full-text answer is not proof that the index is empty. It means the probe word found nothing. `zotero_library(status)` says which of its probes it actually got an answer to, so a read never presents a guess as a measurement.

## Writing, and what writing refuses

`zotero_write` accepts **eight** operations — `create_item`, `set_item_type`, `update_fields`, `add_tags`, `remove_tags`, `create_collection`, `ensure_collection` and `add_to_collection` (`ZOTERO_WRITE_OPS` in `src/research_stack/research.py`); anything else is refused with `ZOTERO_WRITE_ACTION_UNSUPPORTED`, which names the eight it offers. It refuses `delete`, `delete_item`, `duplicate_check` and `merge` by name (`ZOTERO_REFUSED_OPS`): a delete has no restore, and Zotero's local API has no duplicate-detection and no merge endpoint, so a merge would be a guess about which item survives.

**What the plan refuses before anything is sent** — the codes below are what `src/research_stack/research.py`, `src/research_stack/recommended_server.py` and `src/research_stack/zotero_store.py` actually raise, and `tests/test_zotero_collections.py` and `tests/test_zotero_library.py` exercise them:

- **`ZOTERO_WRITE_COUNT_INVALID`** — one confirmation authorizes at most **25 operations per batch × 4 batches = 100 operations** (`ZOTERO_WRITE_MAX_OPERATIONS`, `ZOTERO_WRITE_MAX_BATCHES`), and `preview` names what you are authorizing: `authorizedOperations`, `batchesNeeded`, `maxOperationsPerAuthorization`, and a note saying a longer list is refused before anything is sent.
- **`ZOTERO_COLLECTION_LISTING_TRUNCATED`** — a paged collection listing that did not finish is reported `truncated` and is **never used as a census**: `ensure_collection` and `add_to_collection` need the whole listing to tell whether a name is unique or which parent a collection has, so a partial listing stops the plan and names the counts it saw. **`ZOTERO_TOTAL_RESULTS_INVALID`** is the same discipline on the other side — a `totalResults` that does not match what was answered is refused rather than believed.
- **`ZOTERO_COLLECTION_PARENT_MISMATCH`** — `ensure_collection` never re-parents a collection: if the name you gave already exists under a different parent (including the library root, when the parent you named does not exist yet and this same write would create it), the plan refuses and names the key that exists, the parent it really has and the parent you asked for. `ZOTERO_COLLECTION_PARENT_INVALID`, `ZOTERO_COLLECTION_PARENT_NOT_FOUND`, `ZOTERO_COLLECTION_PARENT_UNRESOLVED` and `ZOTERO_COLLECTION_PARENT_DEPTH` (a chain deeper than four collections is not planned — give each level its own `ensure_collection`) are the neighbouring refusals; `ZOTERO_COLLECTION_AMBIGUOUS`, `ZOTERO_COLLECTION_NOT_FOUND` and `ZOTERO_COLLECTION_KEY_INVALID` cover names and keys.
- **`ZOTERO_COLLECTION_NAME_RESERVED`** and **`ZOTERO_WRITE_FIELD_REFUSED`** — Zotero's own special names before any request (below), and `collections` refused as a writable item field, because a filing is an update of the item (`PUT`/`PATCH /items/<key>` with `collections: [<key>]`, which answers 204) and not a field edit.
- **`ZOTERO_NOTE_NOT_FILEABLE`** — a document note is never filed, and the refusal precedes the write.
- **`ZOTERO_WRITE_VERSION_REQUIRED`** and **`ZOTERO_WRITE_VERSION_UNKNOWN`** — a write carries the version it read, and a second write to the same item inside one authorization stops the run rather than guessing the version the first write produced. **`ZOTERO_WRITE_CONFLICT`** is the 412 / 428 answer, and it blocks the next `apply` until the library is snapshotted again.
- **`ZOTERO_WRITE_NOTHING_TO_APPLY`** — `resume_after` that leaves no operation to send; the earlier run already reported what it applied. `ZOTERO_PLAN_SHAPE_INVALID`, `ZOTERO_WRITE_OPERATION_INVALID` and `ZOTERO_REQUEST_BODY_SHAPE_INVALID` are the shape refusals, the last one before a list body reaches the port.
- **`ZOTERO_JOURNAL_TOO_SMALL`** — a journal that cannot hold every operation of a write refuses the write instead of producing an undo record that would not survive its own write (defect D8, measured as 43 operations against the old cap); `ZOTERO_JOURNAL_EMPTY`, `ZOTERO_JOURNAL_UNREADABLE` and `ZOTERO_JOURNAL_ID_INVALID` cover the journal `undo` needs, and **`ZOTERO_WRITE_BLOCK_UNREADABLE`** stops a write when a blocked-write marker is in the workspace and cannot be read, because the Toolkit cannot say which write it stopped.
- **`ZOTERO_TAG_OUT_OF_VOCABULARY`** and `ZOTERO_TAGS_INVALID` keep tags inside the reviewed vocabulary; `ZOTERO_COLLECTION_TAGS_UNSUPPORTED` is a read refusal: **tags cannot be read for one collection** (`GET /collections/<key>/tags` answers 404, measured 19 November 2026 against Zotero 10.0.8) — read tags from `zotero_library(action="status")` or from each item's own record, and no request is made.

Before `apply`, the Toolkit writes a snapshot of the library into `.research-toolkit/zotero-snapshots/` in your workspace. After `apply`, the values it replaced are recorded in `.research-toolkit/zotero-journal/`, and `undo` replays them. A record that Zotero reports as moved on is refused by `undo` rather than overwritten. A collection this write **created** is recorded `undoable: false` with the reason named — the Toolkit has no delete verb (DD14-07) — so `undo` refuses that entry and the snapshot is what a created collection can be checked against. The Toolkit never opens `zotero.sqlite` and never reads `%APPDATA%\Zotero\Zotero\Profiles\<profile>\localAPIKeys.json` — that path has `Zotero` twice, and it is Zotero's file, not yours to hand over.

**How much of the above is proven, and how far.** Every behaviour in this section is pinned by the Toolkit's own suites against an emulated Zotero 10 that answers with the responses measured on the operator's host (`tests/test_zotero_collections.py`, `tests/test_zotero_library.py`): the shapes, the codes, the version guards and the membership re-read are what the code does, and the endpoint answers it is modelled on are the 14 and 19 November 2026 measurements against Zotero 10.0.8 above. **No Toolkit write has been made against a live Zotero 10 library** — that receipt (T14-20) is still owed, and it is the one thing in this guide that no local test can supply.

**Corrected in 0.3.15, against what the 19 November 2026 measurement showed.** `POST …/items` and `POST …/collections` take a JSON **array** body and answer `200 {"success":{"0":"<KEY>"},"failed":{}}`; a PUT or PATCH takes **one object** and answers 204. 0.3.13 sent one object where an array belongs, the local API answered 400, and the Toolkit reported a write it never made. A list body sent without the marker is now refused before it reaches the port. The created keys are read out of `success`, and anything in `failed` is reported as `serverFailures` rather than swallowed. Membership is proved by re-reading `GET /collections/<key>/items` — the only membership read this API answers — after the write and comparing it with the snapshot's before-side — a 200 or 204 on a filing request is not in that comparison at all, which is how a filing that answered 204 into a collection it never reached used to read as success. `export` can be scoped to a collection and says so (`scope: "collection"`) while stating `membershipInExport: false`, because no export format this API answers with carries membership. Zotero's own special collection names (`My Publications`, `Unfiled Items`, `Duplicate Items`, `Retracted Items`, `New Items`, `Feed Documents`) are refused before any request: the local API cannot see a special collection — `GET /collections/<key>` answers 404 — so a collection of that name made by the Toolkit would be an imitation. Pinned by `tests/test_zotero_collections.py`; a write to a real Zotero 10 library is still unverified (T14-20).

Tags are the only thing in a Zotero library you can filter on. `zotero_write` accepts tags from the reviewed vocabulary in the theological-research skill bundle (`access/`, `topic/`, `type/`, `status/`) and refuses anything else, because an uncontrolled tag becomes a dozen spellings of one idea that no search finds.

## RIS import, and the 61 empty items

An import that returned HTTP success created 156 items, 61 of them empty (14 November 2026). A status code is not an import result. Run `python3 scripts/validate_ris.py file.ris --expect N` from the theological-research skill bundle before Zotero sees the file, and compare the record count you wrote with the library count afterwards.

The mapping the RIS translator performed, measured on that import: `KW` becomes a tag, `M2` becomes `extra`, `N2` becomes the abstract, `DP` becomes the library catalogue, and `N1` becomes a child note — a child note is not filterable, so a status written in `N1` is invisible to every later search. `TY - GEN` arrives as `journalArticle`, which is wrong for a code of canon law, a conciliar text or a magisterial document: use `STAT`, and `RPRT` for a report, `THES` for a dissertation. A wrong type is corrected by editing the item, not by importing again.

Zotero's own export carries no access label in CSL-JSON — neither `extra` nor tags survive it — while BibTeX carries `extra` as `annote`. `zotero_library(export)` tells you which of the formats it fetched keeps your access labels.

## Troubleshooting and limits

Diagnostics makes no request until you press Check integrations, so "not checked yet" does not mean absent. A 403 means the local API is off, not that Zotero is missing; a refused connection means Zotero is not running. A 401 on a write means the key is missing or was never authorized. A 428 or 412 means the library changed underneath the plan — re-read it and preview again. Review version-specific instructions before attempting any separate write integration: these facts are a snapshot of Zotero 10.0.8, not a promise about your build.

## Current documentation

[Current official documentation](https://www.zotero.org/support/dev/web_api/v3/local_api). Local onboarding reviewed on 8 November 2026; the endpoint table above was measured against a running Zotero 10.0.8 on 14 November 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
