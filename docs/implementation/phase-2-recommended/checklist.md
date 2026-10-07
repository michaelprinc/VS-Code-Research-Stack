# Phase 2 checklist — Recommended / Researcher

Status: not started. Plan: [Phase 2 implementation plan](implementation-plan.md). Prerequisite: G1. Shared contracts: [architecture](../architecture-and-contracts.md).

Record requirement/scenario IDs and evidence paths for completed items. Credentials, blocked provider access and external exclusions must be stated separately from deterministic fixture passes.

## A. Specification and readiness

- [ ] M2-01: Review/freeze R-01–R-10, T2-01–T2-10 and Research scope exclusions.
- [ ] M2-01: Attach G1 receipts and frozen Basic manifest/lock.
- [ ] M2-01: Create phase specification, design, tasks and acceptance artifacts.
- [ ] M2-01: Confirm current provider authentication, budgets, terms and approved network access.
- [ ] M2-01: Define field provenance, identity matching, access and evidence-scope schema.
- [ ] M2-01: Freeze licensed/synthetic fixture set and expected invariants.
- [ ] M2-02: Evaluate exact MCP package identities or decide to author narrow bridges.
- [ ] M2-02: Review licenses/maintainers/artifacts and freeze adapter dependencies.
- [ ] M2-03: Approve pagination, retry/deadline, cache/retention and DOI conflict policies.
- [ ] M2-04: Resolve ADR-007 with selected Zotero version and import/read modes.
- [ ] M2-01/M2-02: Record ADR-006 and all consequences in the source/decision register.

## B. Planned installation and settings

- [ ] R-01: Capture Basic baseline and preview the Research-only delta.
- [ ] R-02: Install owned Research environment and selected provider adapters from lock.
- [ ] R-02/R-08: Configure OpenAlex current key/budget handling.
- [ ] R-02/R-08: Configure Crossref identity/contact where appropriate and response policy.
- [ ] R-02/R-08: Configure Semantic Scholar key, selected fields and throttle policy.
- [ ] R-09: Keep all provider secrets outside shared manifests and logs.
- [ ] R-04: Detect/install through a guided supported Zotero route; preserve existing library.
- [ ] R-04: Prepare disposable test collection/library and record its identity.
- [ ] R-04: Enable/check local API and keep it loopback-only.
- [ ] R-04: Configure reviewed import format, destination and duplicate policy.
- [ ] R-04: Document separate remote Zotero mode if implemented.
- [ ] R-06: Install/select verified Python/Jupyter editor extensions.
- [ ] R-06: Create locked analysis environment and select interpreter/kernel explicitly.
- [ ] R-06: Record any owned kernelspec; preserve unrelated environments/registrations.
- [ ] R-07: Add all five structured research skills and provenance-aware templates.
- [ ] R-01/R-07: Merge workspace/MCP settings without duplicate tools/skills.

## C. Provider and scientific workflow acceptance

- [ ] T2-01: Basic-to-Research upgrade preserves existing working resources and user data.
- [ ] T2-02: OpenAlex fixture/schema and small live smoke query pass.
- [ ] T2-02: Crossref fixture/schema and small live smoke query pass.
- [ ] T2-02: Semantic Scholar fixture/schema and small live smoke query pass.
- [ ] T2-02: Pagination, result bounds and cancellation work for each provider.
- [ ] T2-03: Known/missing/non-Crossref DOI cases have justified resolution states.
- [ ] R-03 / T2-03: Conflicting metadata and publication variants preserve separate provenance.
- [ ] T2-03: Similar titles do not cause unjustified automatic merges.
- [ ] T2-04: Local Zotero read and explicit import/export round trip pass.
- [ ] T2-04: Repeat import obeys duplicate policy and leaves unrelated records untouched.
- [ ] R-05 / T2-05: Accessible PDF bytes/type/hash and source identity validate.
- [ ] T2-05: Login HTML, inaccessible/redirected full text and unknown license are handled.
- [ ] T2-06: Fresh VS Code window executes the notebook in the intended environment.
- [ ] T2-06: Kernel-side executable/packages and deterministic table/chart outputs are captured.
- [ ] T2-07: Actual Copilot discovers/invokes the research tools and selected skills.
- [ ] T2-07: End-to-end synthesis retains bibliography, field provenance and page/paragraph evidence.
- [ ] T2-07: Abstract-only records remain labeled; unsupported full-text claims are absent.
- [ ] T2-07: Markdown/DOCX/NotebookLM handoff exports preserve source index and citations.

## D. Failure, repair and regression

- [ ] T2-08: 401/403/revocation, quota exhaustion, 429/backoff, timeouts and 5xx behave as specified.
- [ ] T2-08: Provider schema change and partial/missing fields yield explicit warnings/errors.
- [ ] T2-08: Offline/stale cache status is visible and never treated as a fresh query.
- [ ] T2-09: Zotero write denial is respected; no hidden database/real-library modification.
- [ ] T2-09: Notebook execution remains user-triggered and trust-gated.
- [ ] T2-09: Diagnostic/configuration exports contain no secrets or private library content.
- [ ] T2-10: Interrupted/repeated setup and owned-environment repair are safe.
- [ ] T2-10: Profile downgrade retains Zotero records, notebooks and user kernels.
- [ ] T2-10: Mandatory Basic scenarios pass after Research installation/repair.
- [ ] T2-10: Second clean environment reproduces the frozen Research profile.

## E. Gate G2 and handover

- [ ] M2-08: Freeze Research catalog, scientific package locks and compatibility lock from receipts.
- [ ] M2-08: Deliver exact installation/configuration commands, provider settings and recovery runbooks.
- [ ] M2-08: Map every R requirement to T2 evidence and list account/policy limitations.
- [ ] M2-08: Deliver fixture notebook, Zotero workflow and privacy/permission/data-flow notes.
- [ ] M2-08: Produce `evidence/phase-2/gate-report.md` and updated support matrix.
- [ ] G2: Approve gate only after mandatory provider, Zotero, notebook and Basic regression checks pass.

Gate outcome: pending. Specification revision: pending. Evidence root: pending. Reviewer/date: pending.
