# Zotero tag vocabulary

The controlled vocabulary for every tag this Toolkit writes into a Zotero library, and for the `KW`
lines of any RIS file you prepare yourself.

## Contents
- Why tags and not notes
- The four facets
- Rules that keep the vocabulary usable
- A copyable RIS record
- Collections are not tags
- What the Toolkit refuses

## Why tags and not notes

Tags are the only thing in a Zotero library that a later reader can filter on. A fact that is not a tag
is a fact you cannot search for, sort by, or hand over to someone else as a saved view.

`KW` becomes a tag. `N1` becomes a child note attached to the item, and a child note cannot be filtered
(measured 14 November 2026). So access status, topic, type and work status go in `KW`. `N1` is for prose
you will read but never search for.

## The four facets

Only these four facets exist. A tag outside them is refused.

### `access/` — what was actually reached

One per record. It states what this session saw, not what the work contains.

- `access/metadata_only` — title, authors and year only.
- `access/abstract_available` — an abstract was read.
- `access/full_text_available` — the full text is reachable from where you are.
- `access/partial_text_available` — some of it is reachable (a first page, an open-access chapter, a preview).
- `access/access_denied` — a paywall or a missing entitlement blocked it.
- `access/unverified` — the record itself is not confirmed; do not build on it.

### `topic/` — your own subject terms

Free choice of terms, **at most 4 per record**. Keep them stable: the same subject written five ways
stops being a filter.

### `type/` — the kind of text

- `type/canon-law` — a code of canon law, a canon, decretal collections.
- `type/conciliar` — council acts, decrees, constitutions.
- `type/magisterial` — encyclicals, apostolic exhortations, catechetical texts.
- `type/patristic` — Fathers and early Christian writing.
- `type/spiritual-theology` — spirituality, ascetic and mystical theology.
- `type/social-science` — empirical work on religious practice.
- `type/history` — historical scholarship about any of the above.

### `status/` — what still has to be done

- `status/needs-identifier` — the record has no DOI, ISBN or URL, so it cannot be deduplicated reliably.
- `status/needs-type-fix` — the Zotero item type is wrong (typically a `TY  - GEN` that arrived as `journalArticle`).
- `status/read-in-full` — you read the whole work. Never set it from an abstract or a snippet.

## Rules that keep the vocabulary usable

1. Tags are the only filterable place in the library, so anything you will want to filter on is a tag.
2. `KW` → tag; `N1` → unfilterable child note (measured 14 November 2026).
3. A tag outside these four facets is refused by the Toolkit's `zotero_write` before it reaches the library. A tag longer than 64 characters is refused too.
4. Keep at most 4 `topic/` tags per record. More than that decays into dozens of near-variants and the facet stops being filterable.
5. `status/needs-identifier` marks a record you cannot match reliably against another record. Mark it instead of guessing that two records are the same work.
6. `status/needs-type-fix` marks a record whose item type is wrong. Fix it by editing the item, not by re-importing the file.
7. Tags carry no private information: no name of a person who asked for a text, no note content.

## A copyable RIS record

```
TY  - STAT
TI  - Codex Iuris Canonici auctoritate Joannis Pauli PP. II promulgatus
AU  - Pontificium Consilium Legum Textui Interpretando
CY  - Roma
PB  - Libreria Editrice Vaticana
PY  - 1983
SN  - 978-88-15-03957-3
LA  - la
KW  - access/metadata_only
KW  - topic/canon-law
KW  - type/canon-law
ER  - 
```

`TY  - STAT` because a code of law is not a journal article: `TY  - GEN` arrives as `journalArticle`.
`SN` is present so the record can be matched against another copy of the same work. The three `KW`
lines are filterable; the same three facts written into `N1` would not be.

## Collections are not tags

A tag labels a record. A collection is where a record is filed. `zotero_write` does both, and they are two
different writes with different refusals. What it offers: `add_tags`, `remove_tags`, `ensure_collection`,
`create_collection`, `add_to_collection`, `update_fields`, `set_item_type`, `create_item`. What it refuses
outright: `delete`, `delete_item`, `duplicate_check`, `merge` — the local API has no merge endpoint and no
restore.

- **`ensure_collection` never re-parents a collection.** If the name you gave is already in the library under a
  different parent — including the library root, when the parent you named does not exist yet and this same
  write is about to create it — the plan refuses with `ZOTERO_COLLECTION_PARENT_MISMATCH` and names the key that
  exists, the parent it actually has (or `the library root`), and the parent you asked for. File into that key
  with `add_to_collection`, or name the parent it really has. Moving a collection is not a side effect this
  Toolkit takes.
- **Zotero's own special collections are not names you may use.** `My Publications`, `Unfiled Items`,
  `Duplicate Items`, `Retracted Items`, `New Items` and `Feed Documents` are refused with
  `ZOTERO_COLLECTION_NAME_RESERVED` **before any HTTP request**: the local API cannot see a special collection at
  all — `GET /collections/<key>` for one answers 404 (measured 19 November 2026 against Zotero 10.0.8). A
  collection this Toolkit created with one of those names would carry a key of its own and be an imitation.
- **`collections` is not an item field you can write.** `update_fields` refuses it with
  `ZOTERO_WRITE_FIELD_REFUSED`: tags and collections have their own operations. A filing is an update of the
  item — `PUT`/`PATCH /items/<key>` with `collections: [<key>]`, which answers 204 — and that is what
  `add_to_collection` builds. `POST /collections/<key>/items`, the shape a filing instinct reaches for first,
  answers 405 and is refused on the way into the plan with `ZOTERO_PLAN_SHAPE_INVALID`.
- **The only membership read is `GET /collections/<key>/items`**, which is `zotero_library(action="collection_items")`.
  `GET /items?collection=<key>` is ignored by Zotero and answers with the whole library, and
  `POST /collections/<key>/items` answers 405 (measured 19 November 2026). That read carries child notes as
  records of their own — 43 items arrived as 93 records — so `members` and `memberCount` (records whose own
  `data.collections` names this collection, notes excluded) are the membership fact, not `returned`.
- **Tags cannot be read for one collection.** `GET /collections/<key>/tags` answers 404 (measured 19 November
  2026), so the Toolkit answers `ZOTERO_COLLECTION_TAGS_UNSUPPORTED` and makes no request at all, rather than
  return an empty list that would read as "this collection has no tags". Read tags from
  `zotero_library(action="status")`, which counts the library's tags, or from each item's own record.
- **A note travels with its item.** `ZOTERO_NOTE_NOT_FILEABLE` refuses the filing of a document note — `PATCH`
  on a note with `collections` answers 500 (measured 19 November 2026) — and names the item the note belongs to.
  File the item and the note comes with it: the same fact `KW` and `N1` state for tags.
- **A capped listing is never a census.** A collection listing that stops at the paging bound is reported
  `truncated` with `totalCount`, and `ensure_collection` and `add_to_collection` refuse with
  `ZOTERO_COLLECTION_LISTING_TRUNCATED` instead of deciding from part of the library whether a name is unique or
  where a collection sits. Name the collection by its key, which needs no census.
- **One confirmation covers a counted plan.** `confirm: "write-to-zotero"` authorizes up to
  `ZOTERO_WRITE_MAX_OPERATIONS` (25) × `ZOTERO_WRITE_MAX_BATCHES` (4) = 100 operations, sent in batches of at
  most 25. The preview states `authorizedOperations` and `batchesNeeded`, so a 43-item filing is a 43-operation
  confirmation, not a 25-operation one; a longer plan is refused with `ZOTERO_WRITE_COUNT_INVALID` before
  anything is sent.
- **A created collection is not undoable, and a block that cannot be read is still a block.** A collection this
  Toolkit created is recorded `undoable: false` with its reason named — there is no delete verb to take it back
  with — so `undo` refuses that entry and the snapshot taken before the write is what it can be checked against.
  A blocked-write marker in the workspace that cannot be read is named `ZOTERO_WRITE_BLOCK_UNREADABLE` and no
  write is sent; it is not read as "no block".

**How much of this is proven.** Every sentence above is proven against the Toolkit's own Zotero 10 emulator and
its scripted transport fake, both of which answer with the responses measured against a real Zotero 10.0.8 local
API on 18 and 19 November 2026, version guards included — a write sent without `If-Unmodified-Since-Version` is
refused 428, and a write racing a change the operator made in the meantime is refused 412. **No write has been
verified against a live Zotero library**: the local API was not running on the host these tests were written on,
and that verification is still owed (T14-20). Read this section as what this Toolkit refuses and how its client
behaves, not as a measurement of your library.

## What the Toolkit refuses

- A tag outside `access/`, `topic/`, `type/`, `status/`.
- A delete, a merge, or a duplicate check: Zotero's local API has no such verb, so deduplication happens over your own records before the import.
- A collection write the measured local API cannot answer, or a collection name that is one of Zotero's own: see **Collections are not tags** above.
- `zotero.sqlite`: it is never opened. Back the library up yourself before a bulk write.
