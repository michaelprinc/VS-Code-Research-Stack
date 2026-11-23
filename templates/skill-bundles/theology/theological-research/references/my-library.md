# My library and my sources

> **This file is an empty template.** It is not filled in; no
> library inventory is recorded here. Every row below is a placeholder — `(library name)`,
> `(account)`, `(date)`. Nothing in this file states that the toolkit, the assistant or anyone
> else can reach anything, and an installed copy of this file is not a record of your holdings.
>
> - Name the service; never store a password, account number or token in this file.
> - The Research Stack Toolkit provisions no licensed database access and checks no entitlement.
> - What the toolkit's own index is — a lexical (BM25) ranker, and beside it a lexical-signature vector
>   ranker in the Full package's record store — is stated at the end of this file, under
>   "What the Toolkit's own index does". It provides no OCR and no scanned-image recognition; where a row
>   below names one, that is a gap to record, not a capability.
> - The toolkit installer never reads this file and never rewrites it. Once installed it is your data, and
>   "How this file is updated" states what an update does — and does not do — to a copy you have filled in.

Fill this in yourself. The agent must not assume any entry here is reachable; it checks access at run time. This file is the highest-value file in the skill, because it encodes what *you* can actually reach, which no general model knows.

## Contents
- Licensed and institutional access
- Open services
- Full-text collections I use
- Journals I follow
- Own document collection
- Terminology I use
- What the Toolkit's own index does
- How this file is updated

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

## What the Toolkit's own index does

This section describes what the toolkit you installed actually does, so that the rows above can be read against
it honestly. It says nothing about your documents: nothing in this bundle has read, indexed or searched anything
in this workspace, and nothing here is filled in.

- **One SQLite file, schema version 4.** The Full package's record store lives at
  `.research-toolkit/store/research.sqlite3`. Schema 4 has nine tables; the one added in 0.3.14 is
  `chunk_vectors`, which carries the retrieval vector of an indexed chunk beside the chunk itself.
- **Three retrieval modes, and the default is `lexical`.** `search_corpus(query, mode = …)` answers in
  `lexical` — the stored BM25 ranker, which is what 0.3.13 answered and what an untouched store answers
  today — or in `vector`, or in `hybrid`. `lexical` is the default mode.
- **The vectors are the toolkit's own CPU signature, backend `rsk-hashing-v1`:** 256 dimensions produced by
  signed feature hashing over word tokens and over 3- and 4-character n-grams of the chunk text, L2-normalised,
  quantised to signed 16-bit fixed point, base64-encoded, and stored in the same SQLite file as the chunks.
  Standard library only — no model, no download, no network call, no third-party package, no vector database.
- **`hybrid` fuses the two rankers** by reciprocal-rank fusion with `k = 60`, weighted 0.5 for the fused rank,
  0.25 for the lexical score and 0.25 for the vector score, and a hybrid hit reports which ranker contributed.
- **Vectors exist only where a verb built them.** `embed_corpus` builds them from the chunk text the store
  already holds (`overwrite: true` rebuilds ones that already match); `index_corpus` writes them for the chunks
  it stores. **A store migrated from 0.3.13 keeps every chunk and every claim link it had and reports its
  vector index as `not-built` until `embed_corpus` runs** — until then `vector` and `hybrid` refuse with
  `VECTORS_MISSING` and name that verb instead of quietly answering in another mode. `store_status` and
  `.research-toolkit/lab-state.json` state the index as `not-built`, `partial`, `stale` or `ready`, and a stored
  vector whose backend, dimensions or chunk-text hash no longer match is refused as `VECTOR_BACKEND_STALE`
  rather than ranked with.
- **The store is bounded at 20 000 current chunks** (`MAX_STORE_CHUNKS`, the same bound the store's own
  verbs apply). Indexing past that bound is refused with `STORE_CHUNK_LIMIT`; nothing is silently truncated.
- **What this ranker is not.** It is a lexical signature, not a semantic model. It reaches `iluminacích` from
  `iluminace`, and it does not know that "pilgrimage" and "journey" are the same idea; it is not cross-lingual,
  so it will not carry the Czech terms in the table above into the English terms a database is indexed in —
  that bridge stays yours, which is why that table exists. Its behaviour on a corpus like yours has never been
  measured, so no relevance figure is claimed for it here. And the rest of the retrieval roadmap — an embedding
  model, Qdrant, DuckDB, OCR, scanned-image recognition, any third-party database — is still not in the toolkit.

So: `lexical` needs nothing from you. `vector` and `hybrid` need the store's own `embed_corpus` to have run on
the chunks you indexed. A hit in either mode is a place worth looking at, not evidence that a passage supports a
claim — that judgement stays yours, recorded as a claim.

## How this file is updated

Once you have filled this file in it is your data, and this is what the toolkit's own update paths do to it:

- **A routine install or repair keeps your copy.** A normal install, a repair, or an upgrade to a newer reviewed
  bundle does not overwrite a file you changed after installing it: it reports that file as `user-modified` and
  leaves your bytes exactly as they are. The same holds for a file the toolkit never installed.
- **A confirmed force update replaces it — after archiving what it replaces.** `Force Update Topic Skill Bundle
  (Archive First)` first shows every file it would replace and the state each one is in, and only after you
  confirm does it write. Before any write, the bytes it is about to replace are copied to
  `.research-toolkit/bundles/archive/<bundleId>/<stamp>-<sequence>/`, where `<stamp>` is the UTC second of the
  run and `<sequence>` keeps two archives made in the same second in two different folders. Alongside them the
  workspace keeps `.research-toolkit/bundles/archive/index.json` — every archive this workspace holds, with the
  bundle, the version, the reason, the file count and the folder — and `.research-toolkit/bundles/archive/archive.log`,
  one plain-text line per archive whose last field is that folder's absolute path. The archive is a copy, never
  a move, and nothing in it is ever deleted or rewritten.
- **To get your version back:** `Show Bundle Archive History` lists the archived versions newest first, each with
  the folder it lives in; `Restore Bundle Archive Version` writes one of them back into the workspace and archives
  what it replaced on the way in. A restore is a write, so it replaces whatever is in the workspace now — including
  a newer copy you edited afterwards — so read the history entry, and check the file, before taking it.
- **A filled-in copy is never published.** Nothing in this file leaves your workspace through the toolkit: it is
  not packaged in the VSIX, not sent anywhere, and the archive under `.research-toolkit/` stays on that machine.
  Keep it out of a repository you share, and never write a password, account number or token in it.

