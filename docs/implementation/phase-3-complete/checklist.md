# Phase 3 checklist — Complete / Research Lab

Status: prototype foundation partial; G3 not passed. Plan: [Phase 3 implementation plan](implementation-plan.md). Prerequisite: G2 (still open). Shared contracts: [architecture](../architecture-and-contracts.md). Evidence: [Phase 3 report](../../../evidence/phase-3/gate-report.md).

Record optional capability selections before running tests. A disabled or credential-blocked capability has no passing compatibility receipt. Full core and each selected advanced capability have separate readiness results.

## A. Specification, corpus and decisions

- [ ] M3-01: Attach G2 receipts and frozen Basic/Research locks.
- [ ] M3-01: Freeze F-01–F-13, T3-01–T3-14, core/conditional scope and resource thresholds.
- [x] M3-01: Create phase specification/design/tasks/acceptance artifacts (revision 0.1.0; proposed acceptance values remain unfrozen).
- [ ] M3-01: Freeze English/Czech document corpus, hashes, queries and adjudicated relevance labels.
- [ ] M3-01: Define no-evidence cases, source traceability and grounding acceptance.
- [ ] M3-01: Record reference CPU/RAM/storage and measurement method.
- [x] M3-02: Record local backend candidate and ADR-009; live backend, volume and persistence decision remain unresolved.
- [x] M3-03: Record unselected CPU/model candidates and ADR-010; revisions, license, backend and runtime remain unresolved.
- [x] M3-04: Record DuckDB ownership/concurrency/provenance candidate and ADR-008; data worker/evidence tests remain pending.
- [x] M3-07: Record opt-in, provider-specific browser/connector boundary and ADR-011; no capability selected or validated.
- [ ] M3-04/M3-08: Approve cross-store journal, backup consistency and migration/reindex contracts.
- [x] M3-04/M3-05: Implement dependency-free Markdown source/chunk identity and deterministic BM25 prototype (`src/research_stack/full.py`); persistent/vector implementation remains pending.

## B. Planned local service/model installation

- [ ] F-01: Preview Full additions, hardware/storage needs, download sizes and permissions.
- [ ] F-01/F-02: Detect Docker/backend/virtualization/policy without disrupting existing workloads.
- [ ] F-02: Guide any missing system prerequisite explicitly; no hidden reboot/admin changes.
- [ ] F-02: Provision pinned Qdrant digest and record actual container/image/mount identities.
- [ ] F-02: Use persistent owned named volume and loopback listener bindings.
- [ ] F-02: Configure appropriate service authentication and port-conflict handling.
- [ ] F-03: Install isolated CPU RAG environment from reviewed binary-compatible lock.
- [ ] F-03: Download verified exact model/tokenizer revision into managed external cache.
- [ ] F-03: Validate model preprocessing, normalization, dimensions and finite embeddings.
- [ ] F-06: Initialize embedded DuckDB schema with an owning serialized-write worker.
- [ ] F-04/F-05: Configure source roots, chunking, BM25 version/tokenization and fusion parameters.
- [ ] F-04/F-06: Establish stable IDs, collection fingerprint and committed-index manifest.
- [ ] F-07: Add Research-RAG MCP and evidence/systematic/adversarial review skills.
- [ ] F-08: Install selected reranker/larger model only after preview and independent resource check.
- [ ] F-09: If selected, install pinned Playwright/browser pair and dedicated session storage.
- [ ] F-10: If selected, configure each institutional provider's documented route and entitlement.

## C. Retrieval, provenance and editor validation

- [ ] T3-01: Preflight missing-backend/low-resource failures are actionable before installation.
- [ ] T3-02: Qdrant create/upsert/query proves service/client compatibility.
- [ ] T3-02: Service and host restart preserve the intended volume/corpus.
- [ ] T3-03: Actual CPU model identity and selected optional model/reranker identities are captured.
- [ ] T3-04: Repeat/update/delete ingestion has no duplicates or stale searchable chunks.
- [ ] T3-04: Interrupted ingestion reconciles DuckDB/Qdrant/BM25 committed state.
- [ ] T3-04: Original source hashes remain unchanged and extraction issues are visible.
- [ ] T3-05: BM25, vector and hybrid baselines meet frozen retrieval evaluation procedure.
- [ ] T3-05: Selected reranker passes its quality/latency decision gate.
- [ ] T3-05: Recall/nDCG and English/Czech breakdown are published with matched configuration.
- [ ] T3-06: Fresh VS Code chat discovers/invokes RAG tools and selected skills.
- [ ] T3-06: Returned citations resolve to correct source version and page/paragraph spans.
- [ ] T3-06: No-evidence scenarios avoid fabricated support assertions/citations.
- [ ] T3-07: Claims/evidence relations preserve provenance and reviewed/draft distinction.
- [ ] T3-07: Exports/reload retain supporting/contradicting relations and reject dangling evidence.
- [ ] T3-08: Concurrent reads and worker-owned writes remain safe and recoverable.
- [ ] T3-09: Cold/warm latency, memory, CPU, ingestion and disk/backup footprint are measured.

## D. Optional advanced capability validation

- [ ] T3-10: Selected browser uses a matched binary/package revision and separate profile.
- [ ] T3-10: Public fixture actions, redirects, downloads and session expiry behave as specified.
- [ ] T3-10: Browser controls are described accurately without claiming OS sandboxing.
- [ ] T3-12: Each advertised institutional connector has real authorized account/access evidence.
- [ ] T3-12: Denied/expired access and unsupported entitlement produce clear fallback states.
- [ ] T3-12: Permitted retrieval/export retains source/provider provenance.
- [ ] F-08–F-10: Record disabled/blocked/excluded capability results and corresponding support labels.

## E. Persistence, migration and regression

- [ ] T3-11: Consistent quiesced/snapshot/export backup includes both stores and lexical/source manifests.
- [ ] F-11 / T3-11: Restore into a separate target passes counts, hashes, claims and retrieval comparison.
- [ ] T3-11: Failed migration leaves original data recoverable; unsafe binary downgrade is blocked.
- [ ] T3-11: Model/chunker change stages a separate index and can restore old encoder/index pair.
- [ ] T3-13: Rerun/repair/downgrade retains original sources, notebooks, claims and Zotero records.
- [ ] T3-13: Cleanup never deletes adopted resources or unrelated volumes/processes.
- [ ] T3-13: Basic/Research acceptance passes after Full installation and repair.
- [ ] F-12 / T3-13: Second clean environment reproduces the locked Full core route.
- [ ] T3-14: Listener/credential/cloud-flow/trust/wrong-host checks pass with documented limits.

## F. Gate G3 and handover

- [ ] M3-09: Freeze successful Full catalog, model/service digests and runtime compatibility locks.
- [ ] M3-09: Deliver benchmark, actual config/runtime receipts and source/data ownership map.
- [ ] M3-09: Deliver exact install, backup/restore, migration/reindex and troubleshooting runbooks.
- [ ] M3-09: Map all F requirements to evidence and list conditional capability exclusions.
- [ ] M3-09: Produce `evidence/phase-3/gate-report.md` and updated support matrix.
- [ ] G3: Close only with mandatory Full core/recovery/regression passes and honest optional scope.

Gate outcome: pending / G3 not passed. Specification revision: 0.1.0 (proposed thresholds not frozen). Evidence root: `evidence/phase-3/`. Reviewer/date: pending.
