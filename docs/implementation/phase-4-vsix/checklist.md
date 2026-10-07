# Phase 4 checklist — Complete VSIX extension

Status: readiness-only preview partial; G4 not passed. Plan: [Phase 4 implementation plan](implementation-plan.md). Prerequisite: G1–G3 (still open). Shared contracts: [architecture](../architecture-and-contracts.md). Preview scope/evidence: [specification](../../../specs/phase-4/spec.md), [gate report](../../../evidence/phase-4/gate-report.md).

Every release checkbox needs evidence from the exact packaged VSIX, where applicable. Development-harness success alone does not validate a distributed artifact.

## Preview evidence completed in this revision

- [x] Readiness-only extension manifest and lazy command entry point created; no runtime dependencies.
- [x] Exact allow-listed VSIX built and inspected for inventory, source-byte equality, safe paths, runtime dependency absence and SHA-256.
- [x] Exact VSIX installed in a separate disposable VS Code profile; ID/version observed in the isolated extension list.
- [x] Packaged bytes exercised in the installed reference VS Code Extension Host; activation and warm/concurrent command checks completed.
- [x] Current npm build/test dependency audit completed with zero reported vulnerabilities.
- [ ] G1–G3 closure, full installer/profile/update/recovery implementation, macOS/minimum-host validation and G4 acceptance remain open.

## A. Release specification and architecture

- [ ] M4-01: Attach successful G1/G2/G3 receipts, compatibility locks and declared exclusions.
- [ ] M4-01: Freeze V-01–V-12, T4-01–T4-14 and final release scope.
- [ ] M4-01: Create phase specification/design/tasks/acceptance artifacts.
- [ ] M4-01: Select tested Stable minimum, API/contribution fallback and unsupported host rows.
- [ ] M4-01: Approve complete per-component ownership/update/rollback matrix.
- [ ] M4-01: Review update metadata trust, integrity and schema-migration policy.
- [ ] M4-01: Resolve ADR-012–ADR-014 and final publisher/extension identity/license.
- [ ] M4-02: Bind functional TypeScript extension to proven shared core and recipes.
- [ ] M4-02: Declare trust/host support and prohibit install work on activation.

## B. Wizard, configuration and diagnostics

- [ ] V-02: Implement Basic/Research/Full profile selection with Research recommended.
- [ ] V-02: Implement valid Custom capability resolution and clear conflict/dependency handling.
- [ ] V-03: Detect existing managed/adopted/external resources and actual host/account policy.
- [ ] V-03: Show versions, downloads, storage, licenses, permissions, paths and config diff before apply.
- [ ] V-03: Explain cloud passage disclosure, local resources and institutional/browser prerequisites.
- [ ] V-04: Implement journaled setup, progress/cancellation and resumable prerequisite steps.
- [ ] V-04: Ensure missing admin/reboot/account actions remain explicit guided steps.
- [ ] V-05: Finalize MCP provider and portable export with per-server mode ownership.
- [ ] V-05: Preserve native editor functionality and profile-specific extension recommendations.
- [ ] V-05: Implement supported skill contribution/template modes without duplicate or wrong-profile skills.
- [ ] V-05: Preserve user-edited settings, instructions and skills on repair/update.
- [ ] V-06: Resolve scoped credentials at runtime; document independent portable-client provisioning.
- [ ] V-07: Implement capability-level health, actionable diagnostics and planned repairs.
- [ ] V-07: Implement explicit sanitized diagnostic export and readable logs.
- [ ] V-11: Implement transaction locking and verified owned service/process lifecycle.

## C. Component update and data lifecycle

- [ ] V-08: Check trusted update/catalog metadata and reject invalid/unsigned unsupported sources.
- [ ] V-08: Resolve candidate compatibility against actual observed runtime/schema/index state.
- [ ] V-08: Show current/proposed versions, dependencies, permissions, restarts and rollback limits.
- [ ] V-08: Keep notify/review as default and scheduled checks/automatic policies opt-in.
- [ ] V-08: Distinguish managed, guided, external and remote-service update behavior in UI.
- [ ] V-09: Stage owned candidate environments/components separately and verify artifact identities.
- [ ] V-09: Quiesce/backup consistent state for data migrations and prove separate restore path.
- [ ] V-09: Pair model updates with new matching indexes and retain old working pairs.
- [ ] V-09: Switch/validate candidate and restore original working set on failure.
- [ ] V-09: Journal recovery handles reload/power interruption at each switch boundary.
- [ ] V-10: Profile change/repair/uninstall preserve sources, claims, notebooks, Zotero and adopted resources.
- [ ] V-10: Separate VSIX self-update from component update and controller/data compatibility.
- [ ] V-10: Document retention, disk cleanup, manual recovery and blocked downgrade conditions.

## D. Actual editor and fault acceptance

- [ ] T4-01: Exact VSIX installs/activates on tested minimum/current Stable without starting setup.
- [ ] T4-02: All profile and valid/invalid Custom choices produce correct plans.
- [ ] T4-03: Actual VSIX repeats Basic acceptance on clean and existing reference setups.
- [ ] T4-03: Actual VSIX repeats Research provider/Zotero/kernel workflows.
- [ ] T4-03: Actual VSIX repeats Full local RAG/provenance and selected optional workflows.
- [ ] T4-04: Repeated/interrupted setup preserves state and safely resumes/rolls back.
- [ ] T4-05: Two windows/workspaces cannot corrupt journals or stop each other's owned service use.
- [ ] T4-05: Reload/crash during configuration/service operations recovers safely.
- [ ] T4-06: Fresh-window MCP discovery/real invocation and mode switching have no duplicate definitions.
- [ ] T4-06: Secret resolution and exported client configuration behave within advertised limits.
- [ ] T4-07: Profile-appropriate skills invoke correctly and user edits survive update.
- [ ] T4-08: Missing/auth/policy/version/readiness cases show correct diagnosis and safe repair scope.
- [ ] T4-09: One managed component update passes from actual old/new immutable artifacts.
- [ ] T4-09: Incompatible update is blocked before active-state modification.
- [ ] T4-10: Forced update failure restores and validates the original working environment.
- [ ] T4-10: Selected stateful service/schema/model update routes pass their own failure recovery tests.
- [ ] T4-11: Downgrade/disable/uninstall/reinstall retains data and reattaches intentionally.
- [ ] T4-12: Unsupported host modes and moved/Unicode/space paths are handled explicitly.
- [ ] T4-13: Trust, bad hash/catalog, credential expiry and manipulated-path/manifest tests pass.
- [ ] T4-14: Offline activation/bootstrap limitations are accurate and resumable.
- [ ] T4-14: Keyboard, contrast and proposed activation/status/package-size targets are measured.

## E. Packaging, documentation and gate G4

- [ ] M4-08: Freeze extension/package-manager locks and source revision for release.
- [ ] M4-08: Bundle production code and audit complete VSIX file/dependency inventory.
- [ ] M4-08: Exclude secrets, private fixtures, corpora, databases, environments, model/browser/image payloads.
- [ ] M4-08: Include needed schemas/templates/skills and license notices/SBOM.
- [ ] M4-08: Package with reviewed local vsce dependency and record VSIX SHA-256.
- [ ] M4-08: Validate the same checksum-identical VSIX on clean acceptance hosts.
- [ ] M4-08: Deliver versioned catalog/locks, support matrix and sanitized sample workspace.
- [ ] M4-08: Deliver setup/account/configuration, update/rollback and data-preservation guides.
- [ ] M4-08: Map each V requirement to artifact-based evidence and optional exclusions.
- [ ] M4-08: Produce `evidence/phase-4/gate-report.md` with final release decision.
- [ ] G4: Release only after advertised profiles, update/recovery and preservation checks pass.
- [ ] Distribution: Deliver private VSIX/checksum; record Marketplace publication separately if selected.

Gate outcome: pending. Specification revision: pending. VSIX hash/version: pending. Evidence root: pending. Reviewer/date: pending.
