# Phase 2 checklist — Recommended / Researcher

Status: implementation prototype; G1 prerequisite open; G2 not passed. Plan: [Phase 2 implementation plan](implementation-plan.md). Specification: [phase-2 spec set](../../../specs/phase-2/spec.md). Shared contracts: [architecture](../architecture-and-contracts.md).

Record requirement/scenario IDs and evidence paths for completed items. Credentials, blocked provider access and external exclusions must be stated separately from deterministic fixture passes.

## A. Specification and readiness

- [x] M2-01: Freeze prototype R-01–R-10, T2-01–T2-10 and scope exclusions in `specs/phase-2/`.
- [x] M2-01: Attach the open G1 report and Phase 1 lock as an explicit unmet prerequisite.
- [x] M2-01: Create versioned spec, design, tasks and acceptance artifacts.
- [x] M2-01: Review current official API authentication/rate documentation and Semantic Scholar license; public/product permission remains a release gate.
- [x] M2-01: Define field provenance, exact-identity/conflict handling, access state and evidence-scope schema.
- [x] M2-01: Define synthetic record invariants in deterministic tests; no third-party paper payload is committed.
- [x] M2-02: Select authored narrow bridge; no unreviewed community MCP package is used.
- [x] M2-02: Freeze adapter dependencies to Python standard library and existing Basic MCP lock.
- [x] M2-03: Record prototype policy: 1 result page/provider (maximum 25), 15-second request deadline, process-local 1 request/second, zero automatic retries, no persistent cache, exact-DOI merge.
- [x] M2-04: Resolve prototype route in ADR-007: fixed loopback read-only API and reviewed manual RIS import. No Zotero version/library is installed on the host yet.
- [x] M2-01/M2-02: Record ADR-006 and consequences in the source/decision register.

## B. Planned installation and settings

- [x] R-01: Capture Basic baseline from G1 and implement the Research-only workspace delta; G1 remains open.
- [x] R-02: Install/sync the locked analysis environment and add authored providers to the locked MCP worker package.
- [ ] R-02/R-08: Configure OpenAlex current key/budget handling.
- [ ] R-02/R-08: Configure Crossref identity/contact where appropriate and response policy.
- [ ] R-02/R-08: Configure Semantic Scholar key, selected fields and throttle policy.
- [ ] R-09: Keep all provider secrets outside shared manifests and logs.
- [x] R-04: Detect Zotero/local API status without touching any library files; Zotero is absent on this host.
- [ ] R-04: Prepare disposable test collection/library and record its identity.
- [ ] R-04: Enable/check local API and keep it loopback-only.
- [ ] R-04: Configure reviewed import format, destination and duplicate policy.
- [ ] R-04: Document separate remote Zotero mode if implemented.
- [x] R-06: Verify Python/Jupyter extension IDs and install Jupyter recommendation on the Windows host.
- [ ] R-06: Create locked analysis environment and select/verify its kernel in a fresh VS Code window.
- [ ] R-06: Record any owned kernelspec; preserve unrelated environments/registrations.
- [x] R-07: Add all five structured research skills and provenance-aware templates.
- [x] R-01/R-07: Merge workspace/MCP settings additively in deterministic disposable-workspace acceptance.

## C. Provider and scientific workflow acceptance

- [ ] T2-01: Basic-to-Research upgrade preserves existing working resources and user data.
- [x] T2-02: OpenAlex fixture and one low-volume live smoke query passed.
- [x] T2-02: Crossref fixture and one low-volume live smoke query passed; public rate headers observed.
- [ ] T2-02: Semantic Scholar schema fixture passes, but keyless live query returned HTTP 429; authorized live readiness remains unverified.
- [ ] T2-02: Multi-page pagination/cancellation are not implemented; one-page/result bounds are tested.
- [x] T2-03: DOI syntax normalization and unresolved Crossref miss are covered by deterministic fixtures; found/missing/non-Crossref live cases remain pending.
- [x] R-03 / T2-03: Conflicting metadata on exact DOI records preserves field provenance.
- [x] T2-03: Similar-title works with different DOI remain separate in fixtures.
- [ ] T2-04: Local Zotero read fixtures pass, but the host has no Zotero API and no explicit import/export round trip receipt.
- [ ] T2-04: Repeat import obeys duplicate policy and leaves unrelated records untouched.
- [ ] R-05 / T2-05: Accessible PDF bytes/type/hash and source identity validate.
- [ ] T2-05: Login HTML, inaccessible/redirected full text and unknown license are handled.
- [ ] T2-06: Fresh VS Code window/kernel selection is not verified.
- [x] T2-06: Locked kernel executable and versions were captured from its Python environment; deterministic chart code executed. VS Code host output is still pending.
- [ ] T2-07: Actual Copilot discovers/invokes the research tools and selected skills.
- [ ] T2-07: End-to-end synthesis retains bibliography, field provenance and page/paragraph evidence.
- [ ] T2-07: Abstract-only records remain labeled; unsupported full-text claims are absent.
- [ ] T2-07: Markdown/DOCX/NotebookLM handoff exports preserve source index and citations.

## D. Failure, repair and regression

- [ ] T2-08: Full 401/403/revocation, quota exhaustion, timeout and 5xx matrix remains pending; 429/Retry-After and Zotero-unavailable are covered.
- [x] T2-08: Partial provider errors and malformed identity inputs yield explicit states; broader schema drift fixtures remain pending.
- [ ] T2-08: Persistent/offline cache is not implemented; stale-cache workflow is deferred.
- [ ] T2-09: Zotero write denial is respected; no hidden database/real-library modification.
- [ ] T2-09: Notebook execution remains user-triggered and trust-gated.
- [ ] T2-09: Diagnostic/configuration exports contain no secrets or private library content.
- [x] T2-10: Repeated additive setup is idempotent in a disposable Basic workspace; interruption/repair remains pending.
- [ ] T2-10: Profile downgrade retains Zotero records, notebooks and user kernels.
- [ ] T2-10: Mandatory Basic scenarios pass after Research installation/repair.
- [ ] T2-10: Second clean environment reproduces the frozen Research profile.

## E. Gate G2 and handover

- [x] M2-08: Freeze the Recommended catalog and analysis/worker locks with current host receipts.
- [x] M2-08: Deliver setup commands, provider settings and recovery boundaries in the overlay runbook.
- [x] M2-08: Map all requirements to acceptance scenarios and record current account/policy blockers.
- [x] M2-08: Deliver the synthetic proof notebook, Zotero manual workflow and privacy boundaries.
- [x] M2-08: Produce `evidence/phase-2/gate-report.md`; support-matrix compatibility remains unapproved.
- [ ] G2: Approve gate only after mandatory provider, Zotero, notebook and Basic regression checks pass.

Gate outcome: **not passed**. Specification revision: 0.1.0. Evidence root: `evidence/phase-2/gate-report.md`. Reviewer/date: pending. G2 remains blocked by the open G1 prerequisite, unverified Semantic Scholar access/license, missing Zotero install/test library, and absent fresh-window VS Code kernel/Copilot receipts.
