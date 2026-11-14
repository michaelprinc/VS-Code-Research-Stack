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

`zotero_write` accepts `create_item`, `set_item_type`, `update_fields`, `add_tags`, `remove_tags`, `create_collection` and `add_to_collection`. It refuses `delete` and any merge or duplicate-check operation by name: a delete has no restore, and Zotero's local API has no duplicate-detection and no merge endpoint, so a merge would be a guess about which item survives.

Before `apply`, the Toolkit writes a snapshot of the library into `.research-toolkit/zotero-snapshots/` in your workspace. After `apply`, the values it replaced are recorded in `.research-toolkit/zotero-journal/`, and `undo` replays them. A record that Zotero reports as moved on is refused by `undo` rather than overwritten. The Toolkit never opens `zotero.sqlite` and never reads `%APPDATA%\Zotero\Zotero\Profiles\<profile>\localAPIKeys.json` — that path has `Zotero` twice, and it is Zotero's file, not yours to hand over.

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
