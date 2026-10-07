# Phase 3 Full / Research Lab design

Revision: 0.1.0. Status: implementation prototype; G2/G3 open.

## Runtime boundaries

The Phase 2 workers remain unchanged. Future Full capability uses a separately locked local worker and a separately configured Research-RAG MCP server. Heavy service/model assets live in managed user data/cache locations, never in the VSIX or source checkout. VS Code activation performs read-only detection; it does not install Docker, change virtualization, download models or start an unrequested service.

The current prototype is a pure Python module over explicitly selected UTF-8 Markdown files. It reads source bytes, retains their SHA-256 identity, segments deterministic paragraphs/windows and runs BM25 over those chunks in memory. It has no network access, hidden source scan, model execution, filesystem writes, persistent cache or claim generation. It is an acceptance seam, not a substitute for the Full core.

## Source/chunk identity

`sourceVersionId = sha256(source bytes)`. For a source path supplied by the caller, the stable locator is normalized to a workspace-relative POSIX path; the original absolute path is not included in result objects. A chunk ID is SHA-256 over a canonical JSON tuple of source-version ID, chunker ID, locator and chunk-text hash. The chunker fingerprints version, maximum character count and overlap. Re-import creates the same IDs; changed bytes create a new source version.

The first extractor handles UTF-8 Markdown/plain text only. Page-level PDF, DOCX, HTML, OCR and token-aware model chunking are later adapters and must add extractor/version/location metadata without changing source identity. It fails on invalid UTF-8, missing files, paths outside the selected root, oversized files, too many sources or empty input; it never silently truncates.

## Retrieval evolution

The first baseline uses a versioned Unicode alphanumeric tokenizer and BM25 with fixed `k1=1.5`, `b=0.75`, deterministic score ties, and a bounded result count. Results expose lexical score, source hash, relative path, chunk ID, locator, and excerpt. This baseline is usable for fixture comparison, not a claim of multilingual quality.

The production path adds a separately selected vector collection and revision-pinned encoder. Its index fingerprint includes model and tokenizer revisions, preprocessing/prefix rules, dimensions, normalization, distance metric, chunker/parser fingerprints and service/client identity. Compare BM25, vector, hybrid and selected reranker on identical immutable corpus/query labels. Build changed indexes under new identities, retain the previous pair until recovery checks pass, and switch an explicit active pointer only after validation.

## Persistence and recovery

ADR-008 proposes embedded DuckDB behind one owning worker. Other processes may use a tested read-only/export interface; they do not write to the same database file. The official DuckDB concurrency model supports read-write access within a single process and documents constraints for multi-process writes, which supports keeping a single owner as the initial portable contract ([DuckDB concurrency](https://duckdb.org/docs/stable/connect/concurrency.html)).

DuckDB and Qdrant cannot share one transaction. A durable ingestion outbox records source versions and operation IDs; idempotent lexical/vector upserts are reconciled before a committed manifest makes the batch visible. Backups quiesce the owner and use store-supported snapshot/export operations. Restore into a separate root/namespace first and verify counts, hashes, references and fixture retrieval before changing active state.

## Windows reference service and settings

ADR-009 keeps local Qdrant as a candidate. Qdrant's local quickstart documents persistent storage and notes that Windows may require named Docker volumes; the official installation guidance also cautions about Windows/WSL bind-mount file-system behavior. Therefore the Windows prototype route must validate a named volume, pinned image digest, loopback-only REST/gRPC bindings, health and persistence. Do not publish a remote endpoint as equivalent evidence ([Qdrant local quickstart](https://qdrant.tech/documentation/quickstart/), [Qdrant installation](https://qdrant.tech/documentation/install/)).

No Qdrant service responded on `127.0.0.1:6333` during this implementation. Docker CLI client/server reported 29.7.2, but that version pair alone is not evidence of a provisioned or compatible service. Existing container inventory must be reviewed before a later provisioning experiment.

Shared settings use profile ID, corpus ID, normalized workspace-relative source roots, service mode (`managed-local` or separately reviewed `remote`), loopback endpoint, named data/cache locations, model/index fingerprints and explicit optional-capability states. Credentials remain in the OS credential store or process environment and never enter project settings, logs or receipts.

## Current decision records

- ADR-008: single-owner embedded DuckDB is the candidate persistence boundary; G3 evidence pending.
- ADR-009: locally managed Qdrant in a pinned container with persistent named storage is the Windows candidate; G3 evidence pending.
- ADR-010: CPU small multilingual embedding is the candidate baseline; no model, revision or license is frozen. The upstream multilingual-e5-small model card requires model-specific `query:` and `passage:` prefixes; verify this and license at the selected immutable revision before use ([model card](https://huggingface.co/intfloat/multilingual-e5-small)).
- ADR-011: Playwright and provider-specific institutional connectors remain opt-in and unselected.

No optional browser or institutional connector is included in this prototype. Current Docker availability, RAM/free-storage measurements, extensions, exact Qdrant image, model revisions and persistent-volume behavior remain to be captured before choosing a reproducible Full lock.
