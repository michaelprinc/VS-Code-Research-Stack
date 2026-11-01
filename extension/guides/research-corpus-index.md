# Workspace corpus index

Index the Markdown and text sources you select so searches return the same chunk identities every time.

## Setup

The **Corpus index and record store** component step (offered by the Full package) creates `.research-toolkit/store/research.sqlite3` in the selected workspace. The managed worker then serves `index_corpus`, `unindex_corpus` and `search_corpus` through the "Research Toolkit Corpus index & record store" MCP server, which the extension supplies automatically once setup has run. No third-party database, vector store or embedding model is installed.

Selecting the Full package alone installs nothing; the step runs only when you start it. These verbs reach the assistant through the **Full research workflow** preset (the Full default) or the **Index, search and record claims** preset; both state that the corpus index and record store step must be completed, and a preset the package does not offer falls back to the package default.

## First task and readiness

Call `index_corpus` with `paths: ["notes/your-notes.md"]` and `mode: "index"`. The result reports the sources indexed, the chunk count, an index fingerprint, and any source that produced no chunks (`emptySources`) — an emptied file stops being searchable instead of keeping its old text in the index. Then call `search_corpus` with `query: "your topic"` and a small limit; each hit carries `source_path`, `locator`, `chunk_id`, `content_id`, `text_sha256` and the source hash, and `read_text_source` reopens that passage with adjacent paragraphs. Identical content at two paths indexes as two traceable occurrences. `unindex_corpus` drops selected sources from the current index while keeping any chunk a stored claim still cites. Ready means the reading check indexed a synthetic fixture, searched the stored chunks and recorded a fingerprint.

## Troubleshooting and limits

`STORE_MISSING` means the store step has not run in this workspace. `SOURCE_COUNT` and `STORE_CHUNK_LIMIT` bound one call to 1000 files and the store to 20000 chunks; split large corpora across calls. A score is relevance ranking, not a truth claim. Re-indexing replaces the rows for the selected paths only, so a partial run cannot silently drop the rest of the index. Source files are read only and never modified. Vector and hybrid retrieval, embeddings, reranking and cross-workspace indexes remain planned.

## Current documentation

[Current official documentation](https://github.com/michaelprinc/VS-Code-Research-Stack). Local onboarding reviewed on 31 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
