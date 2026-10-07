# Phase 3 Full / Research Lab specification

Revision: 0.1.0. Status: prototype scope; G2 prerequisite open; G3 not passed.

## Purpose

Extend the Phase 2 Research profile with a local, source-grounded corpus workflow for English and Czech research documents. Phase 3 produces a tested Windows prototype and portable integration contracts for the Phase 4 VSIX. Basic and Research data and settings remain independently usable.

## Scope and readiness labels

The Full core is local corpus inventory and ingestion, stable source/chunk identities, provenance, a lexical baseline, vector and hybrid retrieval, an embedded research-record store, recovery/reindex procedures and a citation-bearing Research-RAG MCP workflow. A deterministic standard-library lexical prototype is included in revision 0.1.0. It does not provide embeddings, vector storage, persistent indexing or MCP integration.

Qdrant, embedding models, reranking, Playwright and institutional adapters are separate components. Conditional components are advertised only after their own live, authorized compatibility evidence. CPU is the required model execution baseline. Local generation, GPU setup, distributed multi-user RAG and access-control bypass are out of scope.

The Windows reference service candidate is local Qdrant in a pinned Linux container using persistent storage. Docker Desktop is a prerequisite for that route. A remote service or Qdrant in-process/local client mode is a different deployment decision and requires a separate contract. Do not stop, adopt or change existing containers as part of preflight.

## Functional requirements

| ID | Requirement | Status in 0.1.0 |
|---|---|---|
| F-01 | Preview host resources, storage, dependencies, data flow and permissions before Full installation | Contract defined; installer not implemented |
| F-02 | Provision/reuse an explicitly owned local vector service and prove image, port, volume and persistence | Design only; local service unavailable during this implementation |
| F-03 | Load exact, reviewed, revision-pinned CPU embedding artifacts and verify preprocessing, dimensions and finite vectors | Candidate selection only; not run |
| F-04 | Inventory immutable source versions and generate stable chunks with extraction and location provenance | Markdown UTF-8 prototype implemented; PDF/DOCX integration pending |
| F-05 | Provide comparable BM25, vector and hybrid retrieval and a frozen benchmark | Deterministic lexical baseline implemented; vector/hybrid/benchmark pending |
| F-06 | Persist source, ingestion, claim and evidence relations through a serialized owner | Schema/design contract only; DuckDB store pending |
| F-07 | Expose bounded retrieval and source-resolvable citations through Research-RAG MCP and real VS Code workflow | Not implemented |
| F-08 | Independently validate selected larger-model and reranking options | Conditional; not selected or tested |
| F-09 | If selected, validate isolated Playwright session and browser operations | Conditional; not selected |
| F-10 | If selected, validate each institutional adapter against documented entitlement and permitted access | Conditional; no provider selected |
| F-11 | Back up, restore, migrate and reindex without losing original sources or reviewed records | Contract only; not implemented |
| F-12 | Preserve and regress Basic and Research behavior through Full installation/repair | Inherited gate is open; regression not yet demonstrated for Full |
| F-13 | Report actual host, permissions, network/data flow and degraded readiness accurately | Evidence report records current blockers; installer checks pending |

F-01–F-07 and F-11–F-13 are mandatory for G3. F-08–F-10 apply when selected or advertised; a skipped feature is a declared exclusion. Current proposed retrieval/resource thresholds in the implementation plan are planning values and must be frozen before a scored benchmark.

## Data and safety invariants

- Preserve imported originals byte-for-byte. Identify a source version by SHA-256 of its content.
- Identify a chunk by source hash, chunker fingerprint, stable location and chunk text hash. Re-importing unchanged content is idempotent.
- Every result carries a source version and a resolvable locator. Relevance score is not factual support.
- Keep claims in draft until human review; represent supporting, contradicting and contextual evidence explicitly.
- Do not expose uncommitted cross-store ingestion batches. Journal/reconcile Qdrant and DuckDB writes idempotently.
- Do not execute arbitrary SQL, load remote model code or read outside operator-selected source roots through MCP.
- Keep database/service/cache paths configurable and outside extension installation files. Never silently switch from local to remote service mode.

## Portability and release boundary

Use JSON contracts, relative paths, UTF-8, LF text, explicit environment-variable names and runtime-resolved executable paths. Keep OS-specific service recipes in platform adapters with a common manifest. Windows prototype evidence does not establish macOS compatibility. Phase 4 may package only components whose versions, licenses, install/repair/update behavior and clean-host evidence have been reviewed.
