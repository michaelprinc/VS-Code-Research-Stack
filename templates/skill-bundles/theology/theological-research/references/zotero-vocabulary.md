# Zotero tag vocabulary

The controlled vocabulary for every tag this Toolkit writes into a Zotero library, and for the `KW`
lines of any RIS file you prepare yourself.

## Contents
- Why tags and not notes
- The four facets
- Rules that keep the vocabulary usable
- A copyable RIS record
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

## What the Toolkit refuses

- A tag outside `access/`, `topic/`, `type/`, `status/`.
- A delete, a merge, or a duplicate check: Zotero's local API has no such verb, so deduplication happens over your own records before the import.
- `zotero.sqlite`: it is never opened. Back the library up yourself before a bulk write.
