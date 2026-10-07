# Phase 3 Full / Research Lab acceptance

Revision: 0.1.0. Status: criteria proposed; G3 not passed.

| Test | Procedure | Pass evidence |
|---|---|---|
| T3-01 Preflight | Preview install over Research on clean and constrained hosts | Required RAM/disk/backend/license/permissions are calculated and actionable before downloads; existing resources unchanged |
| T3-02 Service | Create/query/restart local Qdrant using the selected client and named volume | Immutable image digest, client identity, loopback listeners, collection query and persistence receipts |
| T3-03 Encoder | Load exact CPU model/tokenizer artifacts | Revisions, license, preprocessing, dimensions, finite outputs, memory, cold load and cache identity recorded |
| T3-04 Ingest | Import twice; mutate/delete; interrupt around each store operation | Original hashes unchanged, IDs stable/idempotent, journal reconciles both indexes and committed inventory |
| T3-05 Retrieval | Compare BM25, vector, hybrid and selected reranker on frozen queries | Recall@10, nDCG@10, no-answer and per-language results plus matched latency/resource configuration |
| T3-06 Editor | Fresh VS Code/Copilot workflow invokes Research-RAG and opens evidence | Real tool discovery and invocation; every citation resolves to exact source hash/location; no-answer behavior is grounded |
| T3-07 Claims | Add draft/reviewed claims and supporting/contradicting/context evidence | Provenance retained; invalid/dangling references rejected; portable export/reload matches |
| T3-08 Concurrency | Concurrent reads, owner writes and worker termination/replay | Single-owner semantics, bounded busy behavior and consistent committed corpus |
| T3-09 Resources | Measure cold/warm retrieval, ingestion, RAM and disk on declared host | Effective hardware/config and target decisions published; proposed limits frozen before measurement |
| T3-10 Browser | If selected, exercise public fixture in isolated Playwright session | Pinned browser/package, separate state, bounded navigation/download and honest sandbox limits |
| T3-11 Recovery | Backup, restore to separate target, migration/reindex failure | Store-supported consistent backup and matching source/claim/index counts; old compatible pair remains recoverable |
| T3-12 Provider | If selected, validate provider documentation, entitlement, expiry and permitted export | Live authorized evidence per advertised provider; denial never causes bypass |
| T3-13 Regression | Re-run Basic/Research workflows, repair and clean Full install | Existing documents/notebooks/records/config survive; second host reproduces frozen Full core |
| T3-14 Boundary | Inspect listener, credentials, data flow, workspace trust and execution host | Loopback/network boundaries and secrets redaction verified; unsupported isolation claims absent |

## G3 decision rule

G3 passes only when mandatory F-01–F-07 and F-11–F-13 have evidence, Basic/Research regression passes, and the frozen Full route reproduces on a second clean host. F-08–F-10 must pass individually when advertised; otherwise they are explicitly excluded. Proposed benchmark values are frozen before measurement or revised with recorded rationale before any pass/fail decision. A plan, synthetic unit test, service health response or candidate model card is not a live compatibility receipt.

Current result: **pending / not passed**. G2 prerequisite is open. No vector service, model, corpus benchmark, Research-RAG editor invocation or backup/restore evidence is claimed by this specification revision.
