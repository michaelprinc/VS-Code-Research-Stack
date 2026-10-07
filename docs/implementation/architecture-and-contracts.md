# Shared architecture and implementation contracts

Status: proposed architecture for all four phases. A Windows Phase 1 prototype has local runtime receipts; no profile-wide or cross-platform support is established yet. See [Phase 1 evidence](../../evidence/phase-1/gate-report.md).

## A. Product structure

Use one functional TypeScript VS Code extension as an orchestrator. Keep detection, dependency resolution, installation recipes, configuration rendering, and diagnostics in a reusable TypeScript core that can also be invoked by a small local CLI during Phases 1–3. Keep Python document/research workers and third-party MCP servers in separately versioned environments.

The extension orchestrates external tools; its VSIX contains its own UI/core, schemas, profile templates, small authored skills, static documentation, and trusted catalog metadata. Downloaded models, services, large browsers, and Python environments live in managed storage outside the package.

Proposed separation:

    packages/
      core/                 # resolver, recipes, state, diagnostics, configuration
      cli/                  # reproducible local validation before final wizard
      extension/            # VS Code UI and lifecycle integration
    workers/
      documents/            # PDF/DOCX tools
      research/             # metadata and Zotero adapter
      rag/                  # ingestion, retrieval, evidence and DuckDB owner
    profiles/               # basic, research, full presets
    catalog/                # component identities and compatibility metadata
    schemas/                # versioned contract schemas
    templates/              # workspace and skill templates
    tests/fixtures/         # licensed or synthetic immutable inputs
    specs/                  # reviewed specifications and acceptance cases
    evidence/               # sanitized validation receipts

The current Phase 1 prototype provides the Python CLI/MCP worker, Basic profile/schema, catalog stub, workspace templates and a universal uv lock. The TypeScript core, extension, capability resolver, full catalog, later workers and production installer remain future implementation targets. Python workers may share source modules but should use distinct environment locks when ML dependencies would burden lighter profiles.

## B. Contract registry

| ID | Contract | Acceptance obligation |
| --- | --- | --- |
| C-01 | Profiles are capability presets over an acyclic dependency graph | Unknown IDs, cycles, conflicting versions and unsupported platforms fail before any mutation |
| C-02 | A component has immutable identity, ownership and install/update recipes | Exact package version/hash, commit, model revision or image digest; no implicit `latest` |
| C-03 | Installation is planned and journaled | Detect → resolve → preview → acquire → verify → stage → configure → validate → activate; reruns do not duplicate resources |
| C-04 | Configuration changes are merged and reversible | Preserve unrelated entries/comments where supported; validate syntax/schema; detect user edits before overwrite |
| C-05 | Runtime state and research data have separate lifecycles | Data survive extension updates, repairs, disablement, profile downgrade and uninstall by default |
| C-06 | Credentials are resolved at runtime | No credentials in manifests, workspace files, logs, receipts, exports or Git |
| C-07 | Health is a capability result with actionable causes | Distinguish installed, configured, reachable, authenticated, ready, disabled, degraded and blocked |
| C-08 | Evidence identifies effective runtime, not merely requested settings | Capture actual executable/environment/model/backend identity and real tool results |
| C-09 | MCP tool contracts are bounded and versioned | Initialization, discovery, input/output schema, errors, cancellation, timeout, result size and transport checked |
| C-10 | Updates preserve working state until candidate verification | Compatibility solver, preview, backup, side-by-side staging, migrations and rollback where supported |
| C-11 | Permission statements match implementation | Separate application controls, host trust/approvals, OS isolation, and descriptive agent instructions |
| C-12 | Support claims are conditional on validation | Exact target matrix; unsupported host modes cannot silently run an installation on the wrong machine |

## C. Profile, component and lock schemas

Profile fields: `schemaVersion`, `id`, `displayName`, `inherits`, `capabilities`, optional-capability defaults, default configuration, and platform constraints. Basic → Research → Full inheritance is expanded before resolution. Custom starts from a preset, then adds/removes capabilities with a preview of dependent removals. Dependency conflicts require an explicit choice; do not silently drop requested capabilities.

Component catalog fields:

| Field group | Required design information |
| --- | --- |
| Identity | Component ID, upstream publisher/repository, license, source URL, release version and immutable digest/revision |
| Role | Runtime, editor extension, application, Python package, Node package, MCP adapter, model, or service |
| Compatibility | OS/architecture, runtime ranges, host API minimum, protocol support, dependencies, known incompatibilities |
| Recipes | Detect, acquire, verify, install/adopt, configure, validate, update, rollback and remove |
| Ownership | `managed`, `adopted`, `external`; which paths/processes/resources belong to the toolkit |
| Permissions | Filesystem roots, output destinations, network domains, external writes, browser/session access |
| Data | Persistent paths, schema/storage versions, backup/restore steps, migration and reindex requirements |
| Operations | Expected downloads/resource budget, timeout, restart scope, administrator/reboot requirement and update mode |

Require a versioned JSON Schema for these fields and prohibit executable commands from workspace-controlled or unsigned catalog overrides. Recipes should refer to trusted adapter IDs and validated argument arrays. Do not evaluate arbitrary manifest shell strings.

Store desired profile/capabilities in `.research-toolkit/profile.json`. Store the tested resolution in `.research-toolkit/compatibility.lock.json` with exact versions, artifact hashes, schema revisions, and test receipt references. Store machine-specific runtime paths, journals and credentials separately. A lockfile is an install target, not evidence that the target is already present.

VS Code extension recommendations generally cannot enforce the same version lock as Python packages. Record observed editor extension versions, warn/block combinations outside the tested support row, and use isolated version-specific test installations for release acceptance. Do not disable global extension updates silently.

## D. Workspace and storage design

Suggested research workspace:

    AGENTS.md
    .github/copilot-instructions.md
    .github/skills/<skill-name>/SKILL.md
    .mcp.json                         # optional portable configuration mode
    .vscode/extensions.json
    .vscode/settings.json             # merge only toolkit-relevant settings
    .research-toolkit/profile.json
    .research-toolkit/compatibility.lock.json
    papers/                          # original sources, never modified by ingestion
    notes/
    outputs/
    notebooks/                       # Phase 2
    corpus/                          # Phase 3 derivative inventory
    database/                        # Phase 3, excluded from Git by default
    research/claims/
    research/evidence/
    research/reviews/

Use a configurable external data root for large corpus/index/model data. The default managed runtime root should be a durable toolkit directory under the user's local application-data area; exact layout is specified in Phase 1. The extension's `globalStorageUri` can hold small controller state, but important user data must not depend on its survival after uninstall.

Use stable workspace IDs and canonical path handling. Store source references relative to a declared workspace/corpus root where possible. Resolve Windows case, spaces, Unicode, drive changes, symlinks and junctions deliberately. Protect output writes from traversing outside approved directories. Machine-local configs with resolved absolute paths should be excluded from shared version control.

Docker state uses named volumes with recorded identity on the Windows reference route. Keep research data out of an extension directory or temporary container filesystem. Do not use destructive volume removal as a repair mechanism.

## E. VS Code and MCP integration modes

The host documentation distinguishes portable `.mcp.json` (`mcpServers`) from VS Code `.vscode/mcp.json` (`servers`). Treat these as different schemas and version-test the chosen renderer. The detailed host-format findings are in the [source ledger](source-review-and-decisions.md).

Two supported product modes are proposed:

1. **Managed extension mode:** the final extension supplies MCP definitions through `vscode.lm.registerMcpServerDefinitionProvider`. Resolve owned runtime paths and selected credentials only when needed. Use VS Code's lifecycle to launch stdio MCP servers; the extension manages separate persistent services such as Qdrant.
2. **Portable export mode:** render a client-tested `.mcp.json`, or a documented client-specific fallback. Configuration contains no actual secrets. The user must provision compatible environment variables or that client's credential mechanism. Export is explicit; provider definitions for the same toolkit-owned servers are suppressed to avoid duplicate discovery/startup.

Register and export the same logical tool IDs from a canonical internal model. Track collisions with preexisting user configurations and offer adoption or a diff. Do not claim VS Code SecretStorage can be directly referenced by every external MCP client. Do not generate an unsupported `${secret:...}` interpolation.

Prefer stdio for local workers and Streamable HTTP for actual remote MCP servers. A scholarly REST endpoint is not an MCP endpoint; expose it through an evaluated community adapter or an authored narrow bridge. Stdio logs go to stderr, protocol messages to stdout.

Use native file, Markdown, Git and notebook features where they meet the workflow. A broad filesystem MCP is optional: test whether it adds a needed capability before introducing a second route to local files. For GitHub, prefer the official server and the smallest sufficient read tools; access policies and available authorization are checked at implementation time.

Skill discovery must be tested in the actual selected Copilot harness. Use `.github/skills/` for workspace templates and evaluate the documented `chatSkills` contribution point during Phase 4. Provide a tested project-template fallback if the minimum supported host does not support it. Avoid registering and exporting identical skills simultaneously. Maintain `AGENTS.md` and Copilot instructions from a shared content model; do not assume every harness loads every instruction file.

## F. Installer and service lifecycle

The final CLI and extension should use the same core operations. The Phase 1 prototype currently implements `inspect`, `init`, `read`, `export-bundle`, and `research-stack-mcp`; `plan`, `apply`, `diagnose`, `export-config`, `check-updates`, `update`, and `rollback` remain future interfaces.

Each plan includes identity, dependency order, downloads, estimated storage, changed paths, permissions, existing resources to reuse, restarts, and recovery. Require a user-triggered setup/update action. Extension activation only inspects lightweight state and exposes UI.

Use separate download/install concurrency limits and a host/workspace transaction lock. A journal records completed steps, prior config hashes and ownership. Hash/download signature verification precedes execution. Retain staging until completion or a safe resume; handle cancellation and power loss. Cross-component installation is not intrinsically atomic: rollback must state which changes are reversible and which external applications remain installed.

Adopt compatible existing resources without claiming ownership. Never stop an adopted process, replace a shared Python environment, change global PATH, or restart unrelated containers implicitly. A port conflict is a diagnosis, not permission to terminate the listener.

For owned services, record PID/container ID, executable/image identity, selected ports, data root and start time. Cleanup only verified owned resources. Multiple VS Code windows must attach to a single owned instance or use distinct namespaces; one window closing must not disrupt another workspace's service.

## G. Credential and permission model

During CLI validation use session environment variables or the platform credential store. In managed extension mode use VS Code SecretStorage and approved host authentication flows. Pass credentials only to their owning worker/header at launch/request time; sanitize both normal and error output. Authentication is provider-specific; a GitHub login is not authorization for scholarly APIs or institutional services.

Document processing defaults to selected source roots and writes to outputs only. Metadata bridges implement read operations; Zotero import/writes are separate explicit actions. Browser automation uses dedicated state and visible scope. Prompt instructions and MCP read-only annotations are not OS access controls. On Windows, test application-level restrictions and available host/OS isolation; do not advertise undocumented MCP sandbox support.

Corpus ingestion and local retrieval must not call a cloud embedding provider by default. Copilot answers may send retrieved passages to the selected model provider. Preview this data flow during setup and allow a documents-only mode when AI/cloud access is unavailable.

## H. Health and receipt schema

Health record: `capabilityId`, desired/observed version, ownership, host mode, state, last check timestamp, check duration, diagnostic code, redacted details and suggested action. Fast checks use passive detection; full diagnostics can run explicitly consented probes without modifying research records.

Example diagnostic codes: `RUNTIME_MISSING`, `HOST_UNSUPPORTED`, `AUTH_REQUIRED`, `POLICY_BLOCKED`, `PORT_IN_USE`, `MODEL_MISSING`, `MODEL_INDEX_MISMATCH`, `PARSER_UNSUPPORTED`, `SERVICE_UNREACHABLE`, `MIGRATION_REQUIRED`, `CONFIG_CONFLICT`. Fix invokes a new plan, not arbitrary agent-generated commands.

Receipt fields: run ID, UTC timestamps, specification/code revision, manifest/lock hash, host fingerprint, exact component artifacts, effective interpreter/model/service paths, scenario IDs, result, input fixture hashes, output locations/hashes, elapsed time, resource observations, config diff, redacted diagnostic data, and recovery result. Store permission-sensitive raw artifacts locally and export a sanitized report by explicit action.

## I. Update ownership and policy

| Component | Default update handling | Rollback limit |
| --- | --- | --- |
| Toolkit VSIX | VS Code/Marketplace or a replacement downloaded VSIX | Extension version rollback does not automatically reverse data migrations |
| Managed Python/Node environments and authored MCP adapters | Stage a new locked environment, validate, switch active pointer | Keep old environment and config until acceptance |
| Managed embedding/reranker models | Download exact revision, validate, build separate candidate index if needed | Old model AND matching index must remain available |
| Toolkit-owned Qdrant | Digest-pinned candidate, backup, controlled service maintenance | Restore compatible snapshot/export to a separate instance; never assume older binaries read newer storage |
| DuckDB worker/schema | Candidate dependency lock and explicit migration on a copied/quiesced database | Restore verified backup/export; downgrade compatibility is tested |
| Browser package and binaries | Install matched package/browser revisions in isolated cache | Keep old tested pair and separate session-state handling |
| Zotero, Git, Python installation, VS Code, Docker Desktop | Detect and guide upstream update; automate only an explicitly adopted supported package-manager route | Upstream policy and database compatibility may prevent downgrade |
| Editor extensions | VS Code manages updates; observe and validate versions | Version-specific isolated test route; normal installation policy remains visible |
| Public API / remote MCP service | Update local adapter; monitor remote compatibility | Remote service cannot be rolled back by the toolkit |

Phase 4 requires at least one successful managed component update and one induced-failure rollback. Initial policy is notify and review before apply. An opt-in automatic patch policy is permitted only for proven reversible managed stateless components. Model/index changes, data migrations, application upgrades and policy/permission changes stay explicit.
