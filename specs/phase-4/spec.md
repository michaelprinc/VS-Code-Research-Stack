# Phase 4 VSIX integrity and scalability preview specification

Revision: 0.3.4-preview. Status: GUI preferences, observed component inventory, modular onboarding, goal-based tool presets, package-aware component setup and the Full corpus index/record store implemented; G4 not passed.

## Objective

Produce an installable, privately distributed VS Code extension with GUI controls that make package preferences, interface options, readiness and help accessible without memorizing commands. The GUI must state that G1/G2/G3 remain open and must distinguish functional local worker setup from unverified complete profiles, external services and data lifecycle management.

## Preview requirements

| ID | Requirement | Acceptance |
|---|---|---|
| P4-01 | Package an installable VSIX with readiness and package-switch commands plus declared host minimum | T4P-01 |
| P4-02 | Activate at startup for the status-bar shortcut, on commands, or on sidebar access; no setup, downloads, service starts, network calls or subprocesses | T4P-02, T4P-03 |
| P4-09 | Switch Basic/Recommended Research/Full preference through Quick Pick and persist it in VS Code user settings | T4P-09 |
| P4-03 | Include an exact allow-listed file inventory, no runtime dependencies, and an auditable source-to-payload match | T4P-04 |
| P4-04 | Exercise the exact VSIX installation path in an isolated VS Code profile | T4P-05 |
| P4-05 | Exercise the packaged code in VS Code Extension Host and measure first activation plus repeated command responsiveness | T4P-06 |
| P4-06 | Stay below the proposed 50 MiB package ceiling and publish artifact hash/size/inventory | T4P-07 |
| P4-07 | Keep minimum-version, macOS, remote, profile integration, recovery, update and G4 claims unpassed until their actual acceptance evidence exists | T4P-08 |
| P4-10 | Provide Activity Bar shortcuts and a reusable control panel with package cards, settings, readiness, clipboard and local help | T4P-10 |
| P4-11 | Persist status-bar visibility and opt-in startup opening; synchronize GUI, sidebar and command/Settings changes | T4P-11 |
| P4-12 | Use local assets, nonce CSP, a validated message allowlist, accessible controls and responsive host-themed styling | T4P-12 |
| P4-13 | Show actual observed versions, scope/time and evidence separately from readiness; run bounded local checks only on request | T4P-13 |
| P4-15 | Install the isolated locked worker on explicit setup without changing project environments/configuration | T4P-15 |
| P4-16 | Verify real MCP PDF/DOCX reading, reports, search/RIS and selected-document source preservation | T4P-16 |
| P4-14 | Generate the guide hub from independent component guides, with onboarding, maintained official links and review dates | T4P-14 |
| P4-17 | Declare the install plan in the component registry (schemaVersion 2): install mode, owning step, verification method and next action for every component | T4P-17 |
| P4-18 | Run only the steps the selected package needs, in declared order, refuse a step whose prerequisites were not selected, and record each completed step in the workspace receipt | T4P-18 |
| P4-19 | Offer install/update actions per package and per component, detect steps recorded by an earlier toolkit release, and resume after a cancelled or failed run | T4P-19 |
| P4-20 | Never overwrite existing workspace or overlay files; hash-verify bundled overlay content and refuse linked paths instead of following them | T4P-20 |
| P4-21 | Ship the Full corpus index and research record store as five annotated verbs over a standard-library SQLite store, with source files read only | T4P-21 |
| P4-22 | Keep every preset inside the C-13 budget contract (at most 12 toolkit tools, at least 20 tools of headroom) and publish tool annotations plus a `tools/list` cache hint | T4P-22 |

## Scope boundary

The preview contributes a Research Toolkit Activity Bar container, native shortcut tree, control-panel webview and status-bar item. Package selection writes `researchStack.selectedPackage` (`basic`, `recommended`, or `full`; default `recommended`). Two boolean application-scoped settings control status-bar visibility (default true) and opening the panel at startup (default false). Changes are saved in the active VS Code user profile and shared by its windows. Readiness and clipboard output report that Basic G1, Research G2 and Full G3 are not passed. Workspace names and trust are read from the host for context. Help opens the generated component guide hub; Settings opens the extension-filtered editor. Package preference saves do not install components. Explicit local setup installs the isolated worker; explicit checks start temporary stdio MCP servers. Credentials, external service provisioning and updates are not managed. Build/test tools are excluded from the zero-production-dependency VSIX.

The target is local VS Code Desktop. The 0.3.2 reference is Windows 11 x64 / VS Code 1.141.0. The manifest declares `engines.vscode` `^1.140.0` retained from 0.2.0; the new GUI is not retested on 1.140.0. Older hosts, macOS, web and remote hosts are not validated. Private VSIX installation is tested; Marketplace publishing and redistribution are not authorized by this preview. No repository software license has been selected, so the package metadata is `UNLICENSED` and VSCE's missing-license check is skipped only for this private preview.

## Integrity and scale envelope

The 0.3.2 inventory starts with editor-only observations. On explicit **Check components**, trusted local workspaces may run uv/Git version commands and an isolated Python probe in the selected worker/project environment. Version/library probes have an eight-second timeout; protocol checks have a 70-second process bound and 55-second async deadline; setup has a four-minute bound with cancellation. All process output is bounded and no shell is used. The library probe tests MCP import and in-memory PDF/DOCX operations. Managed workers additionally undergo real stdio MCP reading/report/search/RIS tests; legacy source presence alone does not prove readiness. Configuration commands are never executed. Remote/virtual and restricted workspaces return editor-only inventory. No external services are queried. Workspace choice invalidates prior checks. Planned integrations remain planned even if an unrelated installation exists.

The package additionally includes diagnostics, the install-plan engine, the fixed Python probe, a component registry and 29 individual guides plus onboarding, maintenance and a generated index. Only the reviewed diagnostics module may use its single bounded process runner; other shipped JavaScript remains subject to the network/process primitive prohibition. Bundled guide snapshots carry review dates; **Latest docs** opens each fixed official URL in the user's browser and does not silently refresh offline content.

The packaging audit allows only VSIX metadata, controller/diagnostic/runtime sources, fixed Python probes, reviewed worker source and locks, registry/guides, and GUI assets. It rejects path traversal, duplicate entries, symlinks, secret/cache/model/database payloads, source-to-artifact drift, development-tool metadata leakage, statically detectable network/process primitives outside the reviewed bounded diagnostics runner, packages over 50 MiB and unpacked payloads over 1 MiB. The report includes SHA-256, archive size and exact entries. This is an integrity receipt, not a digital signature or publisher authenticity proof.

Measure first command activation against the proposed 500 ms target and warm command p95 across 100 invocations against a proposed 50 ms target on the reference host. Repeat those measurements across clean machines and host versions before treating them as support criteria. Concurrent workspaces, multiple windows, stress memory, full setup throughput, and cold extension-host startup remain outside this package-selection preview.

## 0.3.2 functional local slice

The GUI setup action previews the selected workspace, isolated `.research-toolkit/managed/worker-0.3.2` path, Python 3.12 and locked package downloads. The VSIX contains reviewed worker source/locks with a hash manifest, not a prebuilt runtime. Only this owned project is synced; unrelated project environments and existing MCP files remain unchanged. Fixed versioned paths, source integrity checks, exclusive workspace setup locks and retryable stages prevent silent source replacement and competing setup. Existing edited managed sources are preserved and block execution.

The stable MCP definition provider supplies managed Basic and Research servers without merging user JSONC. Provider construction uses the positional constructor verified against VS Code 1.141.0 and its published API reference, with `cwd` assigned separately. It returns no servers on restricted/remote workspaces or before a successful setup receipt. Real protocol tests verify synthetic PDF/DOCX extraction, source hashes/locators, report creation, local BM25 retrieval and RIS preparation. Selected-document reading is an explicit GUI file choice under the selected workspace, with a bounded preview and no source mutation. Blank/scanned PDFs remain failed text checks. Runtime/provider tests do not establish assistant authentication or external scholarly/Zotero access. Notebook kernel setup and planned vector/storage/browser integrations remain separate.

## 0.3.3 goal-based tool presets

Revision 0.3.3-preview adds a **tools preset selected by the goal the operator is working on**, not by MCP server. Requirements:

- The offered preset list follows the selected package: Basic 2 presets, Recommended Research 5, Full 7. Each package has exactly one default preset.
- A saved preset that the selected package does not offer must fall back to that package's default and the control panel must state the fallback instead of applying the saved value silently.
- The effective preset must reach the managed workers through `RESEARCH_STACK_TOOL_PRESET`; only the tools serving that goal are registered, and a server whose tools the goal does not use is not offered at all.
- An unknown preset value must fail closed with `TOOL_PRESET_UNKNOWN`. An unset value must preserve the previous full surface so existing manual MCP configurations keep working.
- No preset may exceed the 128-tool client ceiling. The widest shipped preset is 100 tools (9 toolkit tools plus 91 vendor-estimated external tools); the narrowest is 2 tools.
- The control panel must show, for the selected preset: the goal, tips, prerequisites, toolkit tool count, external estimate, total against the ceiling, headroom, and an estimated size of the tool definitions against a 128k reference window. The toolkit part must be measured from real `tools/list` schemas recorded in the setup receipt; external parts must be labelled as published vendor estimates.
- Preset selection installs, removes and configures nothing, and must remain visibly separate from component readiness.

## 0.3.4 package-aware component setup and record store

Revision 0.3.4-preview makes component installation **declarative, package-aware and repeatable**, and gives the Full package a real shipped slice instead of a plan only.

- `components.json` (schemaVersion 2) is the single source of truth: every component states its install mode (`managed`, `host`, `editor`, `external`, `planned`), the step that provides it, how it is verified, and the operator's next action. `installSteps` declare ordered steps with explicit prerequisites and the components each provides; `packages` declare which steps a package needs plus its gate and support level.
- The engine runs only missing or outdated steps for the selected package, in plan order, and records each one in `.research-toolkit/managed/worker-0.3.4/installation.json`. A step whose prerequisite is not in the selection is refused with the reason. A cancelled or failed run keeps the completed steps recorded so the next run resumes.
- GUI access is required, not optional: the control panel shows the plan with per-step status (installed / outdated / missing), **Set up package components**, **Update outdated components**, **Check component status**, per-component **Install**/**Update**, and a Quick Pick step chooser. The sidebar and readiness text report the same counts.
- Existing content is never replaced. Overlay files are written once (`wx`), hash-verified against the bundle manifest, and preserved on re-run; a linked directory is refused rather than followed. Only the notebook step downloads packages, and it is optional.
- The Full slice is a persistent workspace corpus index and a standard-library SQLite record store under `.research-toolkit/store/`, served by a third managed MCP server with five verbs: `index_corpus`, `search_corpus`, `claims_read`, `claims_write`, `store_maintenance`. Reads and writes are separated and annotated; `store_maintenance` refuses `vacuum` without explicit confirmation; claims cannot link to chunk ids that are not in the index; source files are never modified. No third-party database, embedding model or HTTP index service is installed, and no `full-profile.json` is written claiming a service the toolkit does not run.
- **C-13 tool budget contract**: no preset ships more than 12 toolkit tools and the widest preset keeps at least 20 tools of headroom under the 128-tool client ceiling. `research-core`, `research-lab` and `research-lab-max` keep the 9-tool document/metadata surface; the new `corpus-lab` preset (Full only) offers the five corpus verbs from one server. Full now offers 8 presets.
- Every shipped tool publishes a title and read-only/destructive/idempotent/open-world annotations, registration order is sorted by name, and all three workers answer `tools/list` with a 300-second private cache hint. `search` is renamed `search_literature`; the old name is registered only for the unmanaged `all` preset so hand-written 0.3.2/0.3.3 configurations keep working.
- Readiness reports setup completeness (`Package setup for <package>: n of m component steps installed…`) without claiming any gate. G1, G2 and G3 remain open in 0.3.4 exactly as in 0.3.3.
