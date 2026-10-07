# Research Toolkit: four-phase implementation roadmap

Planning baseline: 7 October 2026. Language: English. Phase 1 G1 remains open on Windows 11 x64; Phase 2 has an additive implementation prototype but G2 is blocked; Phases 3–4 remain planned.

## Objective and boundary

First install and validate the scientific stack on a local reference workstation, documenting exact versions, installation steps, compatibility settings, integration behavior, and recovery. Then turn those proven procedures into a complete VS Code extension distributed as a VSIX. Component updates are part of the product design where ownership and upstream mechanisms make them feasible.

The original roadmap remains the project plan. Phase 1 implementation and live receipts are maintained alongside it in `specs/phase-1/`, `docs/implementation/phase-1-basic/`, and `evidence/phase-1/`. Phase 2 prototype specifications and deterministic receipts are maintained in `specs/phase-2/`, `docs/implementation/phase-2-recommended/`, and `evidence/phase-2/`. Until gate reports record supported results, both profiles are implementation prototypes rather than compatibility claims. Phase 2 does not download papers, write to Zotero, or execute notebooks automatically.

The starting input is the user-supplied Czech architecture proposal, titled “Ano. Pro váš cíl považuji `.vsix` balíček za velmi vhodnou distribuční vrstvu, …”. It proposes a small orchestrator extension, three cumulative profiles, optional capabilities, MCP, research skills, health checks, and externally installed services. This roadmap retains that architecture and makes installation validation a prerequisite for packaging.

## Phase sets

| Phase | Package / outcome | Plan | Checklist | Exit gate |
| --- | --- | --- | --- | --- |
| 1 | Basic / Research Starter: local documents, research workspace, Copilot, Git/GitHub, NotebookLM handoff | [Implementation plan](phase-1-basic/implementation-plan.md) | [Checklist](phase-1-basic/checklist.md) | G1: repeatable Basic installation and source-grounded document workflow |
| 2 | Recommended / Researcher: literature APIs, Zotero, Jupyter, research skills | [Implementation plan](phase-2-recommended/implementation-plan.md) | [Checklist](phase-2-recommended/checklist.md) | G2: reproducible literature-to-analysis workflow with graceful provider failures |
| 3 | Complete / Research Lab: local RAG, Qdrant, embeddings, BM25, reranking, DuckDB, provenance, browser and institutional connectors | [Implementation plan](phase-3-complete/implementation-plan.md) | [Checklist](phase-3-complete/checklist.md) | G3: local research pipeline, recovery, and selected advanced capabilities validated |
| 4 | Complete VSIX: wizard, capability resolver, installation/configuration, diagnostics, lifecycle and updates | [Implementation plan](phase-4-vsix/implementation-plan.md) | [Checklist](phase-4-vsix/checklist.md) | G4: installable VSIX repeats the validated procedures on a clean workstation |

Read the [shared architecture and contracts](architecture-and-contracts.md) before any phase and consult [source review and decision register](source-review-and-decisions.md) when selecting versions or adapters.

The fourth phase is product completion, not a fourth scientific profile. Custom is a capability selection mode in the final wizard. Phase 2 remains the recommended default. Full makes all advanced capabilities available; browser sessions, institutional access, and heavyweight models require explicit selection and prerequisites. A reduced Custom installation must not be reported as a fully validated Full installation.

## Spec-driven delivery loop

Each phase follows the same sequence:

1. **Specify:** write a versioned specification with stories, requirement IDs, acceptance scenarios, scope exclusions, error behavior, and nonfunctional constraints.
2. **Design:** define data contracts, dependency graph, installation recipe, configuration changes, ownership, and recovery. Record consequential decisions in an ADR.
3. **Plan:** map each work package to its requirement IDs, dependencies, deliverables, and acceptance scenarios. Review the specification before implementation.
4. **Implement:** execute only a reviewed phase specification. Capture every install/configuration action so it can later become an installer adapter.
5. **Verify:** run deterministic contract/fixture tests plus real local integration checks. Pin the successfully tested combination, not an untested “latest” combination.
6. **Close:** attach evidence to the checklist and gate report; document deviations and remaining limitations. A changed requirement reopens its affected tests.

This is a lightweight workflow; it does not depend on a particular spec-generation framework. During implementation, create `specs/phase-N/spec.md`, `design.md`, `tasks.md`, and `acceptance.md` from these plans. Do not substitute generated prose for executable acceptance checks.

## Reference platform and compatibility claim

- Initial release target: Windows 11 x64, local VS Code Desktop Stable, standard user account, CPU execution available for every mandatory local research workflow.
- Initial Python candidate: CPython 3.12 x64, subject to package-wheel, security-support, and integration validation. It is not yet a selected or tested runtime.
- Select a currently supported Node.js LTS only if a selected adapter needs external Node. The extension's VS Code runtime is a separate dependency.
- Record exact Windows build, VS Code/Copilot versions, host mode, architecture, runtime paths, package locks, model revisions, and service image digests for each run.
- WSL, Remote SSH, Dev Containers, macOS, Linux, ARM64, VS Code Web, and alternative AI clients are separate support rows. Initially mark them untested or unsupported, with an explanatory UI state. Add support only after matching validation.
- A local stack may still contact GitHub/Copilot and public research APIs. “Local installation” does not imply offline AI or that document content remains on the workstation when a cloud model is used.

Compatibility means that a specific declared combination passed its required installation, workflow, failure, and recovery scenarios. It is not a claim of compatibility with every future release of every component.

## Capability coverage

| Capability | Basic | Recommended | Complete | Implementation policy |
| --- | --- | --- | --- | --- |
| Markdown, project folders, instructions | Required | Inherited | Inherited | Prefer native VS Code features |
| PDF extraction, DOCX read/write | Required | Inherited | Inherited | Isolated document worker; constrained outputs |
| Copilot research workflow | Required for AI acceptance | Inherited | Inherited | User account/entitlement and organization policy prerequisites |
| Git and GitHub | Required integration | Inherited | Inherited | Local Git; minimal GitHub access; no unsolicited publication |
| Basic skills and NotebookLM export helper | Required helper | Inherited | Inherited | Prepare files and manual handoff; cloud account separate |
| OpenAlex, Crossref, Semantic Scholar | — | Required adapters | Inherited | Official HTTP APIs behind tested MCP adapter(s) |
| Zotero | — | Required local read/import workflow | Inherited | Local API reading plus explicit import; remote mode optional |
| Jupyter | — | Required | Inherited | VS Code Python/Jupyter and isolated kernel |
| Structured research skills | — | Required | Inherited | Discovered by selected Copilot harness; explicit invocation tested |
| Local vector RAG and Qdrant | — | — | Required | CPU baseline; persistent local Qdrant reference deployment |
| Embeddings, BM25, hybrid ranking | — | — | Required | Revision-pinned model; deterministic lexical baseline |
| Reranker and larger embedding model | — | — | Selectable advanced capability | Benchmark before promotion; selected reranker must be tested |
| DuckDB, provenance, claims/evidence | — | — | Required | Embedded store; serialized writes through worker |
| Playwright MCP | — | — | Selectable | Dedicated browser state and bounded automation |
| Institutional sources | — | — | Selectable | Provider-specific access and acceptance evidence |
| Custom profile and component updates | Recipe groundwork | Expanded recipes | Migration groundwork | Completed in Phase 4 |

## Gate and evidence rules

Each gate report must include specification revision, code revision, resolved manifest hash, host fingerprint, scenario results, immutable artifact identifiers, redacted logs, config diffs, failures, recovery results, and reviewer decision. A missing credential yields `blocked` or `not-tested`, never `passed`.

Checklist rows use requirement or work-package IDs. Each completed row must link to a task, scenario, or evidence receipt. The template's completion checkboxes represent future implementation acceptance, not approval of this planning document.

Allowed gate outcomes: `passed`, `failed`, `blocked`, `passed-with-declared-exclusions`. The last outcome is limited to optional capabilities and must produce a support matrix entry. Mandatory profile failures prevent the corresponding profile from being advertised as supported.

Live cloud answers and literature rankings change. Test schemas, identity, attribution, tool invocation, and bounded recovery with deterministic fixtures; use a small live smoke test for authentication and endpoint behavior. Do not compare exact LLM wording as an acceptance oracle.

## Delivery dependencies and indicative effort

| Phase | Prerequisite | Indicative effort for one experienced implementer |
| --- | --- | --- |
| 1 | Specification review and a reference workstation | 2–3 weeks |
| 2 | G1, API/account access, Zotero sandbox library | 3–5 weeks |
| 3 | G2, adequate hardware/storage, approved local service backend | 4–7 weeks |
| 4 | G1–G3 receipts and proven recipes | 4–6 weeks |

These are planning estimates, approximately 13–21 working weeks in total, not promised dates. Account provisioning, institutional access, review, upstream regressions, and cross-platform support can add time. Re-estimate after G1 and after the retrieval benchmark in Phase 3.

A small development extension or MCP integration harness may be used during Phases 1–3 to test actual VS Code behavior. Final wizard, release packaging, and production lifecycle belong to Phase 4. This keeps early integration checks real without delaying all editor testing until packaging.

## Release deliverables

The eventual release must include the VSIX, SHA-256 checksum, component catalog and tested compatibility lock, installation guide, update/rollback guide, support matrix, license notices/SBOM, sanitized sample workspace, and release acceptance report. Models, research corpora, credentials, user databases, and container images remain outside the VSIX.

The roadmap is grounded in the [VS Code MCP documentation](https://code.visualstudio.com/docs/agent-customization/mcp-servers) and [VSIX packaging documentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension); the detailed source ledger separates documented host features from proposed project behavior.
