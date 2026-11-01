# Local lexical search prototype

Inspect the in-memory Markdown/text retrieval foundation.

## Setup

**Set up package components** installs the bundled local text-search module. The Basic MCP server exposes `search_local_text` for explicitly selected workspace UTF-8 Markdown/text files. It returns provenance-bearing BM25 results without a persistent index or embedding model.

## First task and readiness

The reading check invokes search against a synthetic Markdown fixture and verifies a hit. For your first task, call `search_local_text` with `paths: ["notes/example.md"]`, `query: "your topic"` and a small limit. Inspect each returned source path, locator, hash and chunk before using it as evidence.

## Troubleshooting and limits

Ready means the local MCP fixture search worked. Selecting Full alone installs nothing. Vector/hybrid retrieval, models, persistent storage and recovery remain planned. Paths outside the workspace, binary files and oversized corpora are refused.

## Current documentation

[Current official documentation](https://github.com/michaelprinc/VS-Code-Research-Stack). Local onboarding reviewed on 11 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
