# Local lexical search prototype

Inspect the in-memory Markdown/text retrieval foundation.

## Setup

**Set up package components** installs the bundled local text-search module. The Basic MCP server exposes `search_local_text` for explicitly selected workspace UTF-8 Markdown/text files. It returns provenance-bearing BM25 results without a persistent index or embedding model.

## First task and readiness

The reading check invokes search against a synthetic Markdown fixture and verifies a hit. For your first task, call `search_local_text` with `paths: ["notes/example.md"]`, `query: "your topic"` and a small limit. Inspect each returned source path, locator, hash and chunk before using it as evidence.

## Troubleshooting and limits

Ready means the local MCP fixture search worked. Selecting Full alone installs nothing. This component's own verb stays what it has always been: `search_local_text` ranks the files you name, in memory, per call, with no index left behind. It is not the record store, and it is not where the store's retrieval lives: the Corpus index and record store component (Full) ships `search_corpus` with `mode: "lexical" | "vector" | "hybrid"` and `embed_corpus` over a persistent SQLite store on backend `rsk-hashing-v1` — a CPU lexical signature, not a model — as the [corpus index guide](research-corpus-index.md) and the [record store guide](research-record-store.md) describe; this reading check proves nothing about them. A learned embedding model, a Qdrant or DuckDB service, reranking and any recognition of text in scanned images remain planned. Paths outside the workspace, binary files and oversized corpora are refused.

## Current documentation

[Current official documentation](https://github.com/michaelprinc/VS-Code-Research-Stack). Local onboarding reviewed on 11 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
