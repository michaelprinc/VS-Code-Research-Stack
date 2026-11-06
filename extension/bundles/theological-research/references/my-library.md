# My library and my sources

> **This file is an empty template.** It is not filled in; no
> library inventory is recorded here. Every row below is a placeholder — `(library name)`,
> `(account)`, `(date)`. Nothing in this file states that the toolkit, the assistant or anyone
> else can reach anything, and an installed copy of this file is not a record of your holdings.
>
> - Name the service; never store a password, account number or token in this file.
> - The Research Stack Toolkit provisions no licensed database access and checks no entitlement.
> - The toolkit provides a lexical (BM25) index over text sources. It provides no vector store, no
>   OCR and no scanned-image recognition; where a row below names one, that is a gap to record, not a capability.
> - The toolkit installer never reads this file and never rewrites it. Once installed it is your data.

Fill this in yourself. The agent must not assume any entry here is reachable; it checks access at run time. This file is the highest-value file in the skill, because it encodes what *you* can actually reach, which no general model knows.

## Contents
- Licensed and institutional access
- Open services
- Full-text collections I use
- Journals I follow
- Own document collection
- Terminology I use

## Licensed and institutional access

| Source | Access route | Verified working on | Notes |
|---|---|---|---|
| ATLA Religion Database | via (library name), (account) | (date) | Full text availability: (yes/no) |
| (library catalogue) | (URL / proxy) | (date) | |
| (diocesan or community library) | (how to search it) | (date) | |

## Open services

| Service | How the skill uses it | Verified working on |
|---|---|---|
| Crossref API | DOI and metadata verification (`scripts/crossref_lookup.py`) | (date) |
| OpenAlex | literature discovery, citation chaining | (date) |
| (publisher open-access pages) | full text | (date) |
| (repository, e.g. institutional or denominational) | full text | (date) |

## Full-text collections I actually consult

List only what you have personally used and can open. For each: what it contains, which language, whether the text is searchable, and known gaps (OCR quality, missing volumes, older translations).

- (collection 1) — coverage: … · language: … · limits: …
- (collection 2) — coverage: … · language: … · limits: …

## Journals and series I follow

- (journal) — style: … · open access from: … · relevant to: …

## Own document collection

Where the community's PDFs and notes are stored, how they are indexed, and what the index is known to miss.

- Location: (folder / drive / collection name)
- Search method: (file search / vector store / manual)
- Known gaps: (scanned volumes without OCR, missing pages, duplicate scans)

## Terminology I use (cs → en)

Keep this short and it will improve retrieval more than any other section.

| Czech term | English search term | Other |
|---|---|---|
| rešerše | literature review | |
| otcové církve | Church Fathers, patristics | Patrologia |
| koncil | ecumenical council | |
| teologie života / spiritualita | spirituality, theological anthropology | |
| (add your own) | | |
