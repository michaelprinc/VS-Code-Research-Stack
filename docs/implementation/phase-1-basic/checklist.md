# Phase 1 checklist — Basic / Research Starter

Status: in progress. Selected implementation and protocol checks have receipts; every unchecked row remains incomplete. See the [G1 evidence report](../../../evidence/phase-1/gate-report.md). Plan: [Phase 1 implementation plan](implementation-plan.md). Shared contracts: [architecture](../architecture-and-contracts.md).

For each checked row, record the specification revision, task/requirement ID, acceptance result, reviewer and evidence path. `Blocked`, `not-tested` and optional exclusions stay visible; an unchecked row cannot be treated as a successful validation.

## A. Specification and design

- [ ] M1-01: Review and freeze `specs/phase-1/spec.md` with B-01–B-10 and all T1 scenarios.
- [ ] M1-01: Confirm Windows 11 x64, local Desktop host and standard-user boundary.
- [ ] M1-01: Document mandatory cloud/account prerequisites and local degraded mode.
- [ ] M1-01: Approve PDF/DOCX limits, fidelity scope and unsupported/OCR behavior.
- [ ] M1-01: Create immutable English/Czech synthetic or licensed fixtures with hashes.
- [ ] M1-02: Review profile/component/lock schemas, dependency graph and ownership model.
- [ ] M1-02: Decide managed runtime/data roots and configuration backup/merge rules.
- [ ] M1-03: Resolve ADR-003 with exact runtime/package-manager versions and wheel checks.
- [ ] M1-04–M1-06: Resolve ADR-004/005, document tool schemas and MCP mode behavior.
- [ ] M1-01–M1-06: Record reviewed design/tasks/acceptance and ADR-001–ADR-005.

## B. Planned local installation

- [ ] B-01: Capture redacted host, editor, extensions, trust/policy, Git and Python inventory.
- [ ] B-02: Produce download/version/path/change preview before applying setup.
- [ ] B-02: Detect and preserve compatible adopted VS Code, Git and runtime installations.
- [ ] B-02: Acquire artifacts from selected upstreams and verify hashes/signatures.
- [ ] B-02: Create owned document environment from the reviewed lock.
- [ ] B-02: Record actual interpreter path and installed dependency identities.
- [ ] B-02: Verify Basic has no Docker, database, Jupyter or model dependency.
- [ ] B-03: Create/merge folders, ignores, research instructions and workspace recommendations.
- [ ] B-03: Install/template `research-basic` and `document-review` skills without duplicates.
- [ ] B-04/B-05: Install/select document worker and validate all advertised read/write operations.
- [ ] B-06: Configure exactly one MCP registration mode for each toolkit server.
- [ ] B-06: Validate portable/native schemas and Windows argument/path handling.
- [ ] B-07: Verify current Copilot extension arrangement, user sign-in and entitlement.
- [ ] B-07: Configure minimal GitHub access using the selected official route.
- [ ] B-08: Create NotebookLM handoff templates, source index and supported export formats.

## C. Compatibility and integration validation

- [ ] B-09 / T1-01: Inspect/diagnose before and after setup; passive probes make no changes and produce actionable receipts.
- [ ] T1-02: Clean Basic installation passes with immutable component identities.
- [ ] T1-03: Rerun is idempotent and unrelated config entries/comments survive.
- [ ] T1-03: User-edited managed config produces an actionable merge conflict.
- [ ] T1-04: Text-bearing English/Czech PDFs and DOCX yield expected text and locators.
- [ ] T1-04: Tables/layout limitations, encrypted/scanned/malformed inputs are reported correctly.
- [ ] T1-05: Markdown/DOCX output preserves source hashes and references.
- [ ] T1-05: DOCX fixture rendering and structure are inspected in an available viewer.
- [ ] T1-05: NotebookLM bundle validates; live account import has its own result/exclusion.
- [ ] T1-06: Fresh VS Code window discovers and invokes the document MCP tool.
- [ ] T1-06: Explicit skill invocation produces source-grounded output.
- [ ] T1-06: Duplicate toolkit server/tool/skill registrations are absent.
- [ ] T1-07: Local Git workflow and selected GitHub repository read succeed.
- [ ] T1-07: Missing/revoked credentials give recoverable, separate readiness results.
- [ ] T1-10: Spaces/Unicode and multiple runtime installations resolve the correct executable.

## D. Failure, recovery and permissions

- [ ] T1-08: Interrupted download and cancellation resume or roll back safely.
- [ ] T1-08: Config-phase interruption restores prior config or resumes from journal.
- [ ] T1-08: Induced worker validation failure leaves the prior working environment available.
- [ ] T1-08: Cleanup targets only verified owned processes/resources.
- [ ] T1-09: Traversal and junction/symlink escape attempts are rejected by the worker.
- [ ] T1-09: Output overwrite, oversized response and parse-time limits behave as specified.
- [ ] T1-09: Untrusted workspace cannot execute setup or toolkit workers.
- [ ] T1-10: Secrets and private bodies are absent from shared configs/logs/receipt exports.
- [ ] C-05/C-11: Data lifecycle and Windows permission/isolation limitations are documented.

## E. Gate G1 and handover

- [ ] M1-08: Repeat the frozen installation on a second clean disposable reference environment.
- [ ] M1-08: Freeze Basic profile, catalog entries and compatibility lock from successful receipts.
- [ ] M1-08: Deliver actual installation commands, configuration diffs and troubleshooting runbook.
- [ ] M1-08: Link each B requirement to T1 evidence and list blocked/excluded external checks.
- [ ] M1-08: Produce `evidence/phase-1/gate-report.md` with support matrix and reviewer decision.
- [ ] G1: Close only when all mandatory checks pass; carry declared optional exclusions forward.

Gate outcome: pending. Specification revision: pending. Evidence root: pending. Reviewer/date: pending.
