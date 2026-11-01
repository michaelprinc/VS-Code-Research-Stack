# Phase 4 checklist — Complete VSIX extension

Status: 0.3.6 GUI, local component inventory, modular guides and goal-based tool presets implemented; host receipts for 0.3.6 pending; G4 not passed. Plan: [Phase 4 implementation plan](implementation-plan.md). Prerequisite: G1–G3 (still open). Shared contracts: [architecture](../architecture-and-contracts.md). Preview scope/evidence: [specification](../../../specs/phase-4/spec.md), [gate report](../../../evidence/phase-4/gate-report.md).

Current release: **0.3.6**. Its receipts live in [`../evidence/quality-v0.3.6-2026-11-01/`](../../../../evidence/quality-v0.3.6-2026-11-01/README.md) relative to `toolkit/` — that is `Research-Stack/evidence/quality-v0.3.6-2026-11-01/`. The 0.3.2–0.3.5 sections below are historical.

Every release checkbox needs evidence from the exact packaged VSIX, where applicable. Development-harness success alone does not validate a distributed artifact.

## Preview evidence completed in this revision

- [x] Research Toolkit sidebar, graphical package controls, status-bar/startup options and readiness/help/settings/clipboard actions created; preference persists in VS Code user settings; no runtime dependencies.
- [x] Exact allow-listed VSIX built and inspected for inventory, source-byte equality, safe paths, runtime dependency absence and SHA-256.
- [x] Exact VSIX installed in a separate disposable VS Code profile; ID/version observed in the isolated extension list.
- [x] Packaged bytes exercised in VS Code 1.141.0 Extension Host; real renderer ready handshake, help opening, package/options persistence across restart and command checks passed.
- [x] Browser renderer keyboard/save/options/error/sync checks and dark/light/high-contrast screenshots passed; no CSP errors or narrow-layout horizontal overflow.
- [x] Current npm build/test dependency audit completed with zero reported vulnerabilities.
- [x] Observed inventory versions and independent readiness checked in the packaged Extension Host; malformed output, scope/trust/remote and stale-result cases covered.
- [x] All catalog component guides (27 at this revision; 29 components with 29 guides, plus the hub, onboarding and maintenance pages — 32 files in `extension/guides/` today), onboarding, latest-doc links and generated hub included; offline links and exact bytes verified.
- [x] Goal-based tools presets (7 at this revision; 9 in `extension/presets.json` today, package-aware with one default per package and visible fallback) implemented; preset reaches the workers through `RESEARCH_STACK_TOOL_PRESET` and unused servers are not offered. Verified by the automated Node suite and the packaged-artifact audit; Extension Host and renderer receipts for 0.3.3 are still to be produced.
- [x] Context-usage estimation measured from real `tools/list` schemas during setup, stored in the setup receipt and shown in the preset details view with tooltips; external servers stay labelled as vendor estimates.
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

- [ ] V-02: Implement Basic/Research/Full component setup. Preview only persists the selection and does not configure components.
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

## 0.3.2 functional local slice

The GUI setup action previews the selected workspace, isolated `.research-toolkit/managed/worker-0.3.2` path, Python 3.12 and locked package downloads. The VSIX contains reviewed worker source/locks with a hash manifest, not a prebuilt runtime. Only this owned project is synced; unrelated project environments and existing MCP files remain unchanged. Fixed versioned paths, source integrity checks, exclusive workspace setup locks and retryable stages prevent silent source replacement and competing setup. Existing edited managed sources are preserved and block execution.

The stable MCP definition provider supplies managed Basic and Research servers without merging user JSONC. Provider construction uses the positional constructor verified against VS Code 1.141.0 and its published API reference, with `cwd` assigned separately. It returns no servers on restricted/remote workspaces or before a successful setup receipt. Real protocol tests verify synthetic PDF/DOCX extraction, source hashes/locators, report creation, local BM25 retrieval and RIS preparation. Selected-document reading is an explicit GUI file choice under the selected workspace, with a bounded preview and no source mutation. Blank/scanned PDFs remain failed text checks. Runtime/provider tests do not establish assistant authentication or external scholarly/Zotero access. Notebook kernel setup and planned vector/storage/browser integrations remain separate.

## 0.3.3 goal-based tool presets

`extension/presets.json` defines seven presets by the goal they serve (3, 2, 2, 5, 9, 9+36, 9+91 tools), the packages that offer them and the default per package; `src/research_stack/presets.py` mirrors the mapping for the workers and both sides are cross-checked by tests. The control panel, sidebar, status bar, readiness text and a Select Tools Preset Quick Pick all report the effective preset, and the details view shows the tool count against the 128-tool client ceiling, headroom, and the estimated size of the tool definitions in the model's context. An unset preset value preserves the previous full surface; an unknown value fails closed with `TOOL_PRESET_UNKNOWN`. Presets install, remove and configure nothing and do not close G1–G4.

## 0.3.4 component install/update slice — development-host status (31 October 2026)

- [x] M4-08: Install plan declared in the registry (schemaVersion 2) for all 29 components: install mode, owning step, verification method, next action.
- [x] M4-08: Package-aware ordered step plans with explicit prerequisites — Basic 1, Recommended Research 3 (one optional), Full 4; a step is refused when its prerequisite is not selected.
- [x] M4-08: Setup receipt per workspace at `.research-toolkit/managed/worker-0.3.4/installation.json`, written after each step, symlink-refused, resumable after cancellation or failure.
- [x] M4-08: GUI install/update controls reachable from the panel, sidebar and Command Palette (19 commands): set up package components, update outdated components, check component status, per-component Install/Update, step Quick Pick.
- [x] M4-08: No silent overwrite — overlay files created once and hash-verified, existing files preserved, linked paths refused, edited managed source still blocks execution.
- [x] M4-08: Full package ships a real component: workspace corpus index and standard-library SQLite record store with five annotated verbs, bounded limits, previewed re-index, new-file-only backup and confirmed vacuum.
- [x] M4-08: Tool budget contract C-13 enforced by tests (≤12 toolkit tools per preset, ≥20 headroom); `corpus-lab` preset added; annotations and `tools/list` cache hints published by all three servers.
- [x] M4-08: Readiness/inventory report setup completeness and per-component next actions without claiming any gate; two new guides and a **Who installs it** hub column.
- [x] M4-08: Artifact audit passes for `research-stack-toolkit-0.3.4.vsix` (79 members, 226,352 compressed / 668,102 unpacked bytes, `sourceFilesMatch: true`); payload check runs the unpacked controller.
- [ ] M4-08: Install the exact 0.3.4 VSIX in a disposable profile and produce Extension Host and browser renderer receipts on the Windows 11 x64 / VS Code 1.141.0 reference host.
- [ ] M4-08: Produce a real setup receipt on the reference host containing the measured `toolSurface` and the four recorded steps.
- [ ] M4-08: Signed/trusted update inputs, staged updates, migration and failed-update rollback receipts; component compatibility graph; uninstall/data-ownership manifest.
- [ ] G1/G2/G3/G4: remain open. Component setup closes no gate.

Gate outcome: pending (0.3.4 verified on the development host only). Specification revision: 0.3.4-preview. VSIX hash/version: `08e68739aeab0007eaf61f9cd7b2aed1450cfc630ba925d23162de7d959c46d6` / 0.3.4. Evidence root: `evidence/phase-4/gui-0.3.4/`. Reviewer/date: automated development-host run, 31 October 2026.
