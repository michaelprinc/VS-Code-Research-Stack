---
name: document-corpus-bridge
description: Index user-selected PDF or DOCX files into the Research Stack Toolkit corpus and cite them by the page or item of the original document. Use for explicit document-to-corpus work — reading across a set of files, building a citable evidence base, or preparing a report from PDFs and Word documents. Do not use for one-off reading of a single file.
---

# Document corpus bridge

Research Stack Toolkit 0.3.9 indexes text-bearing **PDF** and **DOCX** directly. The store holds the
extracted text, the hash of the original file, the parser and chunker that produced the text, and a locator
that names a **page** of the PDF or an **item** of the DOCX. This skill is the workflow that turns that into
evidence you can rely on and cite. It is not a workaround for missing ingestion, and it does not stage
derived Markdown as its normal path.

## What this toolkit does and does not do here

- It reads text from PDF (pypdf, page by page) and DOCX (python-docx, item by item). It performs **no OCR
  and no scanned-image recognition**: a PDF whose text lives only in images is reported as a source with no
  text units, and that report is the result, not a failure to hide.
- It indexes only what you select, in the trusted workspace, when you ask. Nothing is indexed in the
  background.
- It makes no network request while indexing or searching. It does not fetch papers, and it does not
  provision or check entitlement to any database.
- It writes to its own store and its own receipt files. It never modifies your sources.

## Prerequisites

- The **Corpus index and record store** component step has run in this workspace, and the reading check has
  passed.
- A preset that carries the store verbs: **Index, search and record claims** carries all ten
  (`index_corpus`, `unindex_corpus`, `search_corpus`, `evidence_read`, `verify_sources`, `claims_read`,
  `claims_write`, `claims_export`, `store_status`, `store_maintenance`); **Full research workflow** carries
  `index_corpus` and `search_corpus`. Confirm the preset is applied to a new or restarted server session and
  that the verbs are actually offered. If one is missing, say which and stop; do not describe a step you
  cannot perform.

## 1. Index, and read what the index says about the file

Call `index_corpus` with the workspace-relative paths you were given. One call is one transaction and leaves
exactly one run record. Read the receipt before doing anything else:

- `status`, `indexedSources`, `written`, `chunksStored`, `indexFingerprint`, `indexedAt`.
- `emptySources` — the file produced no chunks. `failedSources` — it could not be read.
  `partialSources` — it was read only partly, and only when you passed `accept_partial: true`.
- `keptPreviousVersion` — a partial or failed read left the previously indexed version in place, with the
  reason. That is the preservation working, not a silent overwrite.

Then call `store_status` and read what it says about each source: `parser`, `chunker`, `outcome`
(`complete`, `partial` or `failed`), `coverage` (units read, units with text, empty units, failed units,
batches) and `warnings` (`UNITS_UNREADABLE`, `NO_TEXT_UNITS`, `NO_TEXT_EXTRACTED`).

**Report coverage before you report findings.** If a document indexed `partial`, or a page failed to parse,
say which file and which page. Never present a partial index as the whole document, and never fill a gap
from memory.

`accept_partial: true` is a decision you make with the user, not a default. Indexing half a document is
legitimate only when the user knows which half.

## 2. Search, and cite the original — not the extraction

`search_corpus` returns hits with `source_path`, `locator`, `chunk_id`, `content_id`, `text_sha256` and the
source hash. A locator is a place in the original file:

- `page=N;chars=a-b` — page N of a PDF.
- `paragraph=N;chars=a-b` — the Nth paragraph of a DOCX.
- `item=N;kind=table-1-row;chars=a-b` — the Nth body item of a DOCX, here a row of a table.

Quote with that locator. `read_text_source` reopens the passage with adjacent units, so a quotation can be
checked against its surroundings rather than trusted from a snippet.

Identical text at two paths indexes as two traceable occurrences. A chunk id identifies one occurrence, not
"the passage" in the abstract.

## 3. Keep the index honest about the files on disk

The indexed version and the file you have now are separate facts. Call `verify_sources` before you rely on
a citation, and again after any editing session: it re-reads each indexed source, compares its hash with the
stored version, and records `verified`, `changed`, `missing` or `inaccessible` with the time of the check.
It reads your files and writes only to the store.

`claims_export` drops references whose source is stale or unverified by default and reports how many it
dropped. `include_stale: true` and `include_unverified: true` put them back when the user wants to see them
— and then the report must say they are unverified. A `changed` source is not a broken citation; it is a
citation to a version the user no longer has.

## 4. Claims

`claims_write` links a claim to stored chunk ids with an optional role and rationale. `evidence_read`
reports whether each link is `resolvable`, `current` and `stale`. The store records what you linked; it does
not judge whether a page supports your claim, and it does not know what the page actually says. State the
locator, the source hash and the verification state with the claim, and keep the limits of the extraction
visible.

## 5. The fallback, and only the fallback

Some files cannot be indexed: a PDF or DOCX over 25 MiB is refused before it is opened
(`SOURCE_TEXT_TOO_LARGE` covers a file whose extracted text passes 5 000 000 characters). If the user needs
such a file in the corpus, stage a derived UTF-8 Markdown copy in a new directory such as
`outputs/document-corpus/<run>/`, one file per document unit, and record in each file: **derived extraction,
not the original**; the original path and its SHA-256; the exact page or item number and kind; the extraction
date; and every warning or gap. Index the derived files, and label every citation from them as a citation to
a derived copy whose mapping to the original was recorded by hand rather than validated by the store. If you
cannot verify the mapping, stop and say so.

## 6. What you must not claim

- That a `complete` outcome means the extraction is correct. It means every unit was read. Layout, figures,
  table structure and reading order can still be wrong.
- That the toolkit verified the document supports the claim. It verified that a stored chunk came from a
  hashed file at a locator.
- That the host discovered this skill. The toolkit wrote these files into `.github/skills/` and can prove
  only that. Whether an assistant reads them, and whether they help, belong to the host and are recorded as
  unverified in every install receipt.
