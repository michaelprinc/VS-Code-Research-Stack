# Real-host report — Zotero 10.0.8, 14 November 2026

## Provenance

The artifact is the operator's own brief **„Doporučení: rozšíření nástrojů pro práci se zdroji“**, written on
14 November 2026 after working with their own Zotero library on a Windows 11 host. The operator labelled every
claim themselves:

- **[ZMĚŘENO]** — measured against the running Zotero on their machine.
- **[NAJDO]** — found in Zotero's own source or documentation, not executed there.
- **[ZÁMĚR]** — deliberately not done.

The brief is transcribed below rather than attached: the operator's raw notes, their library and their logs stay
on their machine. Nothing in this folder was produced by a Toolkit run on that host, and no Toolkit write was
ever sent to that library.

## The library it was measured against

93 items in total — 43 top-level items and 50 child notes. 37 items carry a DOI. **0 collections, 0 tags,
0 saved searches.** The full-text index answered no match for the probe word.

## Measured on that host [ZMĚŘENO]

| What was asked of the local API | What answered |
| --- | --- |
| `GET /api/` | 200 with `Zotero-Server-ID` and the API version |
| `HEAD` and `GET /api/users/0/collections` | 200, 0 collections |
| `GET /api/users/0/items?format=json` | 200, 43 top-level items |
| `GET /api/users/0/tags?format=json` | 200, 0 tags |
| `GET /api/users/0/searches?format=json` | 200, 0 saved searches |
| `GET /api/users/0/fulltext?q=…` **without `since`** | **400** |
| `GET /api/users/0/fulltext?since=0&q=…` | 200, no match |
| `GET /api/itemTypes` | 200 |
| `GET /api/users/0/items?format=csljson\|bibtex\|biblatex\|csv` | 200 |
| `GET /api/users/0/items?format=markdown` and `format=counts` | **400** |
| A RIS import that returned HTTP success | created **156 items, 61 of them empty** |
| `TY - GEN` through the RIS translator | arrived as **`journalArticle`** |
| `KW` / `M2` / `N2` / `DP` / `N1` | tag / `extra` / abstract / library catalogue / **child note** |

The empty-items result is the single most consequential measurement in the brief: a status code is not an import
result, and the Toolkit had been preparing RIS files with no structural check of its own output.

## Found in Zotero's own source [NAJDO]

- A write with no `If-Unmodified-Since-Version` is answered **428 Precondition Required**; a write whose version
  was already moved is answered **412 Precondition Failed**.
- A write with no authorized key is answered **401** with `WWW-Authenticate: Zotero-API-Key realm="Zotero Local API"`,
  after a consent dialog Zotero shows itself.
- `server_localAPI.js` exposes **no duplicate-detection endpoint and no merge endpoint**.
- The key file is `%APPDATA%\Zotero\Zotero\Profiles\<profile>\localAPIKeys.json` — the path contains `Zotero` twice,
  which is why a hand-written instruction to find it fails.
- CSL-JSON export carries neither `extra` nor tags; BibTeX carries `extra` as `annote`.

## Deliberately not done [ZÁMĚR]

- **No write was executed against the operator's library.** Every write-path fact above is [NAJDO], not [ZMĚŘENO].
- No third-party Zotero MCP server was installed or evaluated for adoption.
- No licensed bibliographic database and no vector search was attempted.
- The 61 empty items were not deleted by any tool; the operator repaired them by hand.

## What 0.3.13 changed because of this brief

| Finding | Change in 0.3.13 | Where it is proven |
| --- | --- | --- |
| RIS output was never checked | `validate_ris_text()` in the worker, and `scripts/validate_ris.py` in the theological-research skill bundle; `prepare_zotero_import` refuses its own invalid output (`RIS_INVALID`) | `tests/test_zotero_library.py`, `extension/test/bundles.test.js` |
| `fulltext` needs `since` | the probe always sends `since=0` and a zero answer is reported as *no match*, never as *empty index* | `tests/test_zotero_library.py` |
| `markdown` and `counts` are 400 | `zotero_library(export)` refuses an unsupported format **before** making the request, and says a Markdown bibliography is generated from the records | `tests/test_zotero_library.py` |
| 428 / 412 on writes | every planned write carries the version it read; 428 → `ZOTERO_WRITE_VERSION_REQUIRED`, 412 → `ZOTERO_WRITE_CONFLICT`, and a conflicted entry is refused by `undo` rather than overwritten | `tests/test_zotero_library.py` |
| 401 without a key | the Toolkit refuses before asking Zotero (`ZOTERO_WRITE_KEY_MISSING`); the key arrives only through `RESEARCH_STACK_ZOTERO_WRITE_KEY` in the worker environment | `tests/test_zotero_library.py`, `extension/test/runtime.test.js` |
| No merge or duplicate endpoint | `delete`, `delete_item`, `merge` and `duplicate_check` are refused by name before any request | `tests/test_zotero_library.py` |
| `TY - GEN` → `journalArticle` | `to_ris` emits `STAT`, `RPRT`, `THES`, `CHAP`, `BOOK`, `CPAPER` instead of `GEN`, and the validator warns on every `GEN` | `tests/test_zotero_library.py`, bundle validator |
| `N1` is an unfilterable child note | status goes in `KW` tags from a reviewed vocabulary; `zotero_write` refuses a tag outside it | `references/zotero-vocabulary.md`, `tests/test_zotero_library.py` |
| CSL-JSON drops the access label | `zotero_library(export)` reports `accessLabelsInExport` per format | `tests/test_zotero_library.py` |

## Limits of this evidence

1. **One library, one host, one operator.** 93 items is not a sample.
2. **No logs from that host are held here.** The brief is the artifact; its numbers cannot be re-derived from a
   receipt in this repository.
3. **The write path was never executed on that library.** Its behaviour is proven here two ways only: against an
   emulated loopback server that answers with the status codes the brief names (`tests/test_zotero_library.py`),
   and over the real MCP stdio transport with no Zotero present (`scripts/verify_recommended_mcp.py`, which shows
   `WRITE_CONFIRM_REQUIRED` and a dry-run preview without touching a port).
4. **A real Zotero 10 write on Windows is still owed** — recorded as T14-20 in
   [specs/phase-14-zotero-internalization/acceptance.md](../../specs/phase-14-zotero-internalization/acceptance.md).
   It cannot be produced in this container.
