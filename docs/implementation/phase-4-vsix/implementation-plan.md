# Phase 4 implementation plan — Complete VSIX extension

Status: planned, not implemented. Dependency: G1–G3, exact compatibility locks and proven installation/configuration/recovery recipes. Output: a complete installable Research Toolkit VSIX with Basic, Recommended, Full and Custom setup modes.

Shared obligations: [C-01 through C-12](../architecture-and-contracts.md). Tracker: [Phase 4 checklist](checklist.md). Input: [validated Complete stack](../phase-3-complete/implementation-plan.md).

## 1. Product objective and scope

Replace the reviewed CLI/manual orchestration with a guided VS Code experience using the same core, catalog, recipes and diagnostics. The extension installs/configures selected manageable components, guides upstream application/account prerequisites, validates actual readiness, supports repairs and profile changes, and updates toolkit-owned components where tested recovery is available.

Use one functional extension rather than a static extension pack. Keep profile choices declarative. The VSIX remains small and contains the complete orchestration/configuration logic, not the complete external runtime payload. No corpus, credentials, user databases, container images, embedding weights or browser binaries belong inside it.

Private VSIX distribution is the release target; Marketplace publishing is optional and a separate deliberate delivery step. A complete VSIX can orchestrate online acquisition without offering a fully offline bootstrap. Document that distinction and allow reuse of preverified caches where recipes support it.

## 2. Specification requirements

| ID | Requirement | Acceptance scenario |
| --- | --- | --- |
| V-01 | Ship an installable VSIX with reviewed manifests, licenses, hashes and tested host minimum | T4-01, T4-14 |
| V-02 | Offer Basic, recommended Research, Full and dependency-valid Custom selection | T4-02 |
| V-03 | Inspect existing resources and show a concrete install/change/permission preview | T4-03 |
| V-04 | Execute proven recipes idempotently with progress, cancellation, journals and recovery | T4-04, T4-05 |
| V-05 | Integrate native editor features, MCP, instructions and skills without duplicate definitions | T4-06, T4-07 |
| V-06 | Resolve provider-specific credentials securely and document portable export limits | T4-06, T4-13 |
| V-07 | Present actionable capability health, logs and safe planned fixes | T4-08 |
| V-08 | Check/preview/apply updates to compatible owned components and report upstream-managed ones | T4-09, T4-10 |
| V-09 | Preserve consistent data/config and prove failure rollback/migration/reindex paths | T4-10, T4-11 |
| V-10 | Support repair, profile change, disablement and uninstall with ownership-aware preservation | T4-11 |
| V-11 | Prevent wrong-host, untrusted and concurrent-operation mistakes | T4-05, T4-12, T4-13 |
| V-12 | Reproduce every advertised profile from the actual VSIX on clean reference installations | T4-03, T4-14 |

Nonfunctional targets: no downloads/installations/service starts on extension activation; proposed cached activation overhead below 500 ms and passive status loading below 2 seconds on the reference host. Slow diagnostics run explicitly in the background with cancellation. Proposed VSIX target at most 50 MiB, with actual size measured and any justified exception reviewed. Maintain keyboard-accessible setup/diagnostic flows and readable high-contrast UI.

## 3. Extension architecture and public interfaces

| Module | Responsibility |
| --- | --- |
| Extension entry point | Commands/contributions, context keys, trust/host checks, lazy core initialization |
| Setup controller | Wizard state, capability choices, preview, apply/resume and onboarding completion |
| Shared core | Reuse validated dependency resolver, installer recipes, configuration, health and transactions |
| Component adapters | Detection/install/update/validation for specific supported component types; no arbitrary shell evaluation |
| MCP definition provider | Supply owned stdio/HTTP definitions; resolve paths/credentials at startup; suppress exported duplicates |
| Workspace manager | Merge reviewed templates/settings/recommendations with backups and edit detection |
| Lifecycle manager | Ownership, service attachment, process/ref-counting, maintenance and state retention |
| Update manager | Trusted catalog/channel, compatibility resolution, staging, migration and rollback receipts |
| Diagnostics UI | Tree/status/details, redacted logs, actionable planned fixes and export |

Use native QuickPick/InputBox/progress/walkthrough/tree views for the first version. Add a webview only if comparison/preview complexity justifies it; then apply CSP, message validation and accessible keyboard flows. Avoid embedding an unnecessary custom chat UI. Existing Copilot chat and native notebook/document workflows are the integration surface.

Proposed command IDs and user labels:

| Command ID | User-facing label | Behavior |
| --- | --- | --- |
| `researchToolkit.setup` | Research Toolkit: Setup | Inspect, select, preview and apply reviewed setup |
| `researchToolkit.diagnose` | Research Toolkit: Diagnose | Run selected bounded capability checks |
| `researchToolkit.repair` | Research Toolkit: Repair | Preview fixes for a diagnosed owned component |
| `researchToolkit.changeProfile` | Research Toolkit: Change Profile | Resolve delta and show preservation/removal scope |
| `researchToolkit.exportConfiguration` | Research Toolkit: Export Configuration | Explicit portable export with credential instructions |
| `researchToolkit.checkUpdates` | Research Toolkit: Check for Updates | Read trusted catalog and show compatibility-aware choices |
| `researchToolkit.updateComponents` | Research Toolkit: Update Components | Apply selected compatible updates after preview |
| `researchToolkit.rollback` | Research Toolkit: Restore Previous Setup | Restore supported component/config/data set |
| `researchToolkit.exportDiagnostics` | Research Toolkit: Export Diagnostics | User-reviewed sanitized report |
| `researchToolkit.manageData` | Research Toolkit: Manage Stored Data | Show paths, ownership, size, retention and backup actions |

Settings include profile/capabilities, data/cache roots, selected backend/model IDs, managed versus export mode, diagnostics limits, update channel/policy, download concurrency and opt-in telemetry. Keep secrets out of settings. Use stable public APIs; select `engines.vscode` from the earliest Stable release actually passing required feature scenarios. Optional new contributions need tested fallback, not an unadvertised proposed API dependency.

## 4. Setup experience

1. **Inspect:** explain local host support and existing application/runtime state. Separate missing executable, configuration, entitlement, policy and service readiness.
2. **Choose profile:** Researcher is recommended; Basic/Full show what is added. Custom exposes capabilities, dependent additions/removals and compatibility conflicts.
3. **Choose ownership/backend:** reuse compatible existing apps/services, install toolkit-owned environments, or follow guided upstream prerequisite steps. Missing administrator/reboot actions are clearly manual and resumable.
4. **Review access/data flow:** source/output paths, external APIs, Copilot passage disclosure, Zotero writes/import, browser state and institutional entitlement. Optional capabilities remain off until selected.
5. **Preview:** display exact resolved versions, downloads, disk estimate, license/account requirements, config diff, owned/adopted resources, restarts and recovery limitations.
6. **Apply:** acquire/verify/stage, install, merge configuration, run health checks, activate only validated components. Show cancellation/progress and resume from journal.
7. **Complete:** open the research workspace/sample workflow; list ready/degraded/blocked capabilities and explicit user actions. Do not present “success” while mandatory selected components failed.

The wizard must distinguish installable dependency work from prerequisites it cannot supply, such as Copilot entitlement, institutional licenses, MFA, upstream application acceptance and organization policy. User-approved setup scope is stored; subsequent repair/update shows new changes rather than repeating unrelated questions.

## 5. Integration and configuration completion

Finalize the Phase 1 MCP provider prototype using `vscode.lm.registerMcpServerDefinitionProvider` and the corresponding contribution point. VS Code owns stdio MCP launch/termination; the extension owns persistent local services only if it created/adopted explicit lifecycle ownership. Resolve selected secrets through supported host authentication or SecretStorage at definition resolution, scoped to the corresponding process/header.

Portable export contains logical server identities and only tested client-compatible fields/variables; no secrets and no assumption of direct access to extension SecretStorage. Where paths are machine-specific, generate excluded local configuration plus a shareable template. Define per-server managed/export ownership so fresh windows never show duplicate toolkit tools.

Finish skill distribution: prefer tested `chatSkills` contributions for extension-provided defaults where supported, with a workspace-template mode for customized/copied skills and compatible hosts. Do not contribute every Full skill in Basic without its dependencies. Verify profile filtering if the host contribution mechanism is static; if necessary use template-only delivery for profile-dependent skills. Preserve user-edited skills and instructions on update.

Editor extension recommendations are profile-dependent. Do not use unconditional `extensionDependencies`/`extensionPack` to pull Python/Jupyter/Full tooling into Basic. Use dependency declarations only for true functional extension prerequisites. Installation uses documented editor flows/APIs or a visible guided fallback, and records actual versions instead of claiming an unenforced editor extension version pin.

## 6. Component update implementation

### Update policy

Ship notify/review as the default. Provide user-triggered checks and optional bounded scheduled checks only after opt-in. Respect offline mode, network policy and the selected stable/test channel. Automatic application can be a later opt-in limited to explicitly compatible, reversible, owned stateless patches. It never includes schema/index migrations, permission expansion or upstream application upgrades by default.

The [shared ownership matrix](../architecture-and-contracts.md) defines each component's update scope. At release, document every catalog entry as `managed-update`, `guided-upstream-update`, `remote-service-observed`, `manual`, or `unsupported`, including reasons. A remote service is observed; the VSIX cannot control or roll it back.

### Update transaction

1. Fetch only trusted, authenticated release/catalog metadata using normal TLS validation. If updates use an independent downloadable catalog, verify its signature with a pinned trust key and validate schema/version; alternatively ship catalog changes through signed/trusted extension releases. Reject executable workspace overrides.
2. Resolve the candidate graph against actual host/runtime/schema/index state, not just requested versions. Check licenses, disk, hashes, permissions and required dependent upgrades.
3. Show current → proposed versions, why chosen, data/index migration, download sizes, restart scope and rollback support. Block unsupported combinations.
4. Acquire and verify into side-by-side staging; run import/protocol/fixture checks. Do not mutate the active environment merely to test the candidate.
5. For stateful changes, quiesce writes, create a consistent verified backup/export and test migration against a copy or separate service/index. Space must include both candidate and retained rollback state.
6. Stop only verified toolkit-owned resources affected by the change. Activate the candidate pointer/config and perform actual capability smoke tests. Record all changes in the transaction journal.
7. On failure, restore the previous compatible config/environment/model+index or backup set and validate it. External application actions may be irreversible; guided updates declare that boundary before execution.
8. On success, persist observed identity, new lock and receipt. Retain the previous working set for a documented retention window; cleanup is ownership-aware and never removes user originals.

At least one managed Python/MCP adapter update must work end-to-end. Include a forced failure proving automatic restoration. For advertised service/schema/model updates, demonstrate their own data-compatible restore/reindex flows; a stateless package rollback does not prove database recovery.

VSIX self-updates remain separate from component updates. Marketplace releases use the editor's update behavior; private distribution uses a verified replacement VSIX and documented install flow. Component state migrations must remain compatible with a supported older controller, or explicitly block extension downgrade and provide export/recovery guidance.

## 7. Future build and distribution procedure

1. Freeze the Phase 4 specification, all gate receipts, catalog/locks, supported host rows and release scope. Remove or clearly label unvalidated capabilities.
2. Finalize extension identity/publisher, license, `engines.vscode`, contribution points, trust declaration and host support. Do not claim web/remote/cross-platform support without matching tests.
3. Install/build dependencies only during authorized implementation, using exact lockfiles. Bundle TypeScript extension code; keep build-only tooling separate from user runtime dependencies.
4. Audit package contents with an allowlist or `.vscodeignore` strategy, runtime dependency listing and secret scan. Include schemas/templates/small skills/notices; exclude caches, fixtures containing private material, model/browser/service payloads and environments.
5. Run unit/contract/fault tests and actual editor integration. Use the reviewed local `@vscode/vsce` build dependency to run the equivalent of `vsce package`; record package version, source revision and SHA-256. Packaging is distinct from publishing.
6. Install that exact resulting VSIX in isolated VS Code user-data/extension directories on clean reference machines, then perform Basic/Research/Full/Custom onboarding and update/recovery acceptance. Test both minimum supported Stable and current Stable.
7. Deliver the accepted VSIX plus checksum, compatibility catalog/lock, support/installation/update guides, SBOM/license notices, sanitized sample workspace and final gate report. Optional Marketplace publication has its own reviewed publisher/credential process.

Test offline VSIX installation/activation separately from dependency bootstrapping. Missing connectivity/cache must result in a resumable plan and an honest offline limitation, not a partial setup called complete.

## 8. Work packages

| ID | Work package and deliverable | Depends on | Requirements |
| --- | --- | --- | --- |
| M4-01 | Freeze release specification, API/host minimum, ownership matrix and ADR-012–ADR-014 | G1–G3 | V-01–V-12 |
| M4-02 | Functional extension scaffold, commands, trust/host guards and core binding | M4-01 | V-01, V-11 |
| M4-03 | Wizard, profile/Custom resolver, install preview and journals | M4-02 | V-02, V-03, V-04 |
| M4-04 | Workspace/native editor/MCP/credential/skill integration | M4-02, M4-03 | V-05, V-06 |
| M4-05 | Health UI, logs, safe repairs and diagnostics export | M4-03, M4-04 | V-07, V-11 |
| M4-06 | Trusted update metadata, staging/migration/rollback and lifecycle preservation | M4-03–M4-05 | V-08, V-09, V-10 |
| M4-07 | Fault/concurrency/permission/accessibility and real editor integration acceptance | M4-04–M4-06 | V-02–V-11 |
| M4-08 | Release build, package audit, actual VSIX clean-install/profile tests and G4 report | M4-07 | V-01, V-12 |

## 9. Acceptance scenarios

| Scenario | Procedure | Pass condition / receipt |
| --- | --- | --- |
| T4-01 | Build/audit/install exact VSIX on minimum and current supported Stable | Hash/manifest/runtime content match release; commands/UI work; no setup on activation |
| T4-02 | Choose Basic/Research/Full and valid/invalid Custom combinations | Same resolved graph as proven locks; dependency/conflict explanations before changes |
| T4-03 | Actual VSIX onboarding on clean and preconfigured hosts for each advertised profile | Repeats G1/G2/G3 workflows; correct adopted/owned resources, config diffs and receipts |
| T4-04 | Re-run setup and interrupt download/install/configure/validation phases | Idempotent resume/recovery, progress/cancellation and no duplicated resources |
| T4-05 | Reload/crash VS Code; run two windows and two workspaces concurrently | Transaction/service ownership locks work; one window cannot stop another's required service |
| T4-06 | Restart fresh window; invoke tools in managed mode, export and switch modes | Actual discovery/calls, correct runtime/credential handoff and no duplicated toolkit definitions |
| T4-07 | Select profiles, invoke extension/template skills and edit workspace templates | Correct visible skills and source-grounded behavior; user edits survive upgrade |
| T4-08 | Missing/disabled/auth-blocked/policy-blocked/version-mismatched component diagnosis and Fix | Accurate readiness; repair preview only intended resources; secrets absent from exported logs |
| T4-09 | Check/apply a compatible managed update and reject an incompatible candidate | Actual old/new artifacts, resolved dependencies, trusted metadata and successful smoke checks |
| T4-10 | Fail candidate validation, lose power/reload mid-switch, fail migration/reindex | Original working component/data set restored or safe blocked state with verified recovery |
| T4-11 | Profile downgrade, repair, extension update/disable/uninstall/reinstall | Sources, claims, Zotero/library data, notebooks and adopted resources survive; controller reattaches correctly |
| T4-12 | Attempt unsupported remote/web/architecture mode and moved workspace/drive | Clear support boundary, no wrong-machine install; owned references revalidated or repair offered |
| T4-13 | Untrusted workspace, unsigned/invalid catalog, bad digest, secret expiry and manipulated manifest/paths | Execution rejected appropriately; no unsafe interpolation, secret exposure or privilege escalation |
| T4-14 | Final release repeatability, offline activation, keyboard/contrast UI and diagnostic/performance checks | Actual artifact accepted with published support/limits; offline bootstrap limitation visible |

Run deterministic resolver/config/schema/protocol tests without external credentials; use small live tests for actual authentication/provider integration. Fault injection targets state boundaries and data preservation. UI checks exercise user-visible outcomes; they are not assertions that merely mirror internal implementation.

## 10. Risks and delivery limits

| Risk | Mitigation / completion rule |
| --- | --- |
| Installer becomes arbitrary command execution | Trusted typed adapters, validated schemas/paths and immutable metadata; no executable workspace manifest override |
| Package passed in development but VSIX omits worker/schema/assets | Install and validate the exact release artifact on clean machines |
| Updating one component breaks another | Compatibility graph and candidate smoke tests; whole required dependency delta shown |
| Stateful rollback is unsafe | Version-aware backup/export restoration and paired model/index retention |
| Shared application auto-update invalidates the lock | Observe/diagnose compatibility drift; guided supported update route and regenerated receipt |
| Remote/WSL path/host confusion | Explicit unsupported initial modes; later host-specific installer/service target contracts |
| Optional accounts unavailable | Per-capability blocked/excluded status; no broad support claim |
| Uninstall removes runtime/controller state | Durable external data/ownership manifest and deliberate reattach/import flow; no automatic data purge |

## 11. G4 completion and release criteria

The exact VSIX installs on declared minimum/current host rows and repeats all advertised profile workflows from clean environments. Setup/repair/profile change and cancellation/reload preserve data and unrelated configuration. Tools and skills work after a fresh window. A compatible owned component update and an induced failed-update rollback have real receipts. Every advertised stateful update route has its own restore/migration evidence.

Deliver `research-toolkit-<version>.vsix`, checksum, release manifest, catalog/tested locks, SBOM/notices, support matrix, install/update/restore guides, sanitized sample workspace, completed checklist and G4 report. The version/publisher/file name is finalized during implementation. Do not claim the VSIX includes every external component or can control every third-party update. Success means a compatible tested orchestrator that clearly manages, guides and diagnoses the complete selected installation process.
