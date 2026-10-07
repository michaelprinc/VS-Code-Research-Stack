# Phase 2 implementation plan — Recommended / Researcher

Status: implementation prototype added 7 October 2026; G1 prerequisite remains open and G2 is not passed. Dependency: G1 and frozen Basic lock. Output: portable Researcher overlay and bounded scholarly metadata workflow, still without a required vector database or model.

Frozen prototype artifacts: [specification](../../../specs/phase-2/spec.md), [design](../../../specs/phase-2/design.md), [tasks](../../../specs/phase-2/tasks.md), [acceptance](../../../specs/phase-2/acceptance.md). Shared obligations: [C-01 through C-12](../architecture-and-contracts.md). Tracker: [Phase 2 checklist](checklist.md). Previous: [Basic](../phase-1-basic/implementation-plan.md). Next: [Complete](../phase-3-complete/implementation-plan.md).

## 1. Scope and stories

The researcher can search literature across OpenAlex and Semantic Scholar, check bibliographic records through Crossref, acquire accessible documents, organize them in Zotero, analyze metadata in a selected Jupyter kernel, and export a cited synthesis. Provenance records which provider supplied each field and distinguishes abstract-only review from full-text review.

Required additions: adapters for OpenAlex/Crossref/Semantic Scholar, local Zotero reading and supported explicit import, VS Code Python/Jupyter integration, and literature-search, paper-review, citation-check, evidence-extraction and research-summary skills. API credentials and user application settings are part of onboarding, not silently supplied by the installer.

Exclude vector RAG, GPU/model dependencies, institutional paywall automation, arbitrary notebook execution by an agent, and compulsory Docker. Automated Jupyter MCP execution and Zotero write APIs may be optional additions if a selected implementation passes review; native notebook/kernel interaction and an explicit import workflow satisfy the baseline.

## 2. Specification requirements

| ID | Requirement | Acceptance scenario |
| --- | --- | --- |
| R-01 | Extend Basic using resolved Research capabilities without regressing or reinstalling its working components unnecessarily | T2-01, T2-10 |
| R-02 | Search/query all three provider APIs through evaluated or authored adapters with bounded requests | T2-02, T2-08 |
| R-03 | Normalize identities/metadata and retain per-field provenance, conflicts and uncertainty | T2-03 |
| R-04 | Read the selected local Zotero library and perform a reviewed supported import/export round trip | T2-04, T2-09 |
| R-05 | Acquire accessible full text with verified content type and explicit rights/access status | T2-05 |
| R-06 | Select and prove the effective VS Code Jupyter environment/kernel | T2-06 |
| R-07 | Deliver discoverable research skills and grounded review/synthesis output | T2-07 |
| R-08 | Handle provider quotas, pagination, caching, revocation and outages without losing local work | T2-02, T2-08 |
| R-09 | Keep credentials and Zotero state separate; prevent unsolicited external writes or notebook execution | T2-04, T2-09 |
| R-10 | Reproduce Research installation and retain Basic behavior, data and configurations on repair/downgrade | T2-01, T2-10 |

Original nonfunctional proposal: each provider request has a 30-second deadline, bounded pagination/request counts and cancellation; a retry budget of at most three transient retries with jitter and `Retry-After` handling. The current prototype freezes a stricter 15-second/25-result/one-page policy, one request per second, no automatic retries, and no persistent cache; broader cancellation, pagination, caching and recovery remain open. Daily-budget exhaustion is surfaced as a provider error; never present an outage as “zero matching papers”.

## 3. Adapter selection and contracts

Evaluate one narrow research MCP exposing separate provider tool namespaces, or several maintained independent servers if they meet the same contracts. Use upstream HTTP APIs; do not configure a REST URL as an MCP transport. A community adapter must pass the source/license/version/platform review in the [source register](../source-review-and-decisions.md). If none qualifies, implement a small bridge using an official MCP SDK and a locked HTTP client in the owned Research environment.

Suggested tools: `search_literature`, `get_work`, `validate_citation`, `list_zotero_collections`, `get_zotero_item`, `prepare_zotero_import` and `export_research_bundle`. Mutating imports use a separate explicit command/tool and permission path. Query tool schemas require provider selection, search/filter criteria, pagination limits and requested fields; return normalized records plus raw provider IDs and warning flags.

Minimum normalized research record:

| Field group | Contract |
| --- | --- |
| Identity | Toolkit record ID; normalized DOI when present; OpenAlex/S2/Zotero IDs; relation to work/version |
| Bibliography | Title, authors, year/date, venue, publication type, URLs and nullable abstract |
| Provenance | Provider, endpoint/query hash, fetched time, upstream ID, field source and conflicting values |
| Access | Full-text URL, known license, retrieval status, file type/hash and local source path if acquired |
| Evidence scope | `metadata-only`, `abstract-only`, `full-text`, or extraction-incomplete; source locations |
| Review state | Inclusion/exclusion reason, retraction/update indicators if available, verification status and notes |

Normalize DOI case/URL prefixes and Unicode; do not merge records solely because titles look similar. Use exact identifiers first, then candidate matching with confidence/review. A Crossref miss can mean another registration agency or incomplete metadata; mark unresolved and offer agency/resolver/manual validation. Bibliographic agreement is not evidence that a paper's scientific claims are correct.

## 4. Zotero, Jupyter and workflow design

Prefer Zotero Desktop's enabled local loopback API for read access to a selected test library/collection. Verify version-specific behavior and API availability. Keep local and Web API modes explicit: remote API credentials, group IDs and permissions are independent of desktop local settings. Do not copy or modify Zotero SQLite files while the application owns them.

Begin with user-reviewed RIS/BibTeX/CSL JSON export/import using a tested supported format. Evaluate authorized native local writes only where the installed desktop version and adapter support them. The user sees destination collection and duplicate handling before import; no write to the real research library during fixture acceptance. Capture versions/library identities so caches cannot be mixed between different instances or modes.

Use candidate VS Code extensions `ms-python.python` and `ms-toolsai.jupyter`, verifying publisher/IDs at selection. Create a workspace analysis environment from a reviewed lock with `ipykernel` and selected scientific packages such as pandas/matplotlib only when required by the fixture notebook. Do not force the ML environment into this profile. Select the interpreter and kernel explicitly; a cell records `sys.executable` and locked package versions. Register an owned kernelspec only if VS Code discovery needs it, and remove only that owned registration on cleanup.

Create `.github/skills/` workflows with explicit source-scope rules. Teach literature search, citation checking, evidence extraction and review to retain identifiers/locators and report contradictions. A synthesis can say “abstract-based” and cannot claim full-paper analysis when full text was unavailable. NotebookLM remains the manual export handoff established in Basic.

## 5. Future installation and configuration sequence

1. Re-run Basic diagnostics; record baseline data/config/source hashes and exact adopted versions.
2. Resolve Research inheritance and display only added environments, extensions, app steps, API credentials and external domains.
3. Detect Zotero. If absent, guide a supported upstream installation; if present, record version/library path without reading private records into diagnostics. Use a disposable test library/collection. Explain and guide the local API setting, leaving existing library/database intact.
4. Evaluate adapters and pin them in the catalog. Install the Research worker in an owned environment with its own lock; reuse Basic document tools through their contract.
5. Configure OpenAlex key/budget settings, Crossref client/contact identity where applicable, and Semantic Scholar key/limits for the user's access tier. Store credentials outside Git/workspace templates. Do not hard-code quota values from older articles.
6. Configure local Zotero endpoint, library/collection selection and supported import mode. Test local API readiness separately from app detection; keep the endpoint on loopback and never forward it for remote access.
7. Create/select the notebook environment and Python/Jupyter extensions; verify actual interpreter/kernel in VS Code after reopening. Preserve existing kernels/settings and keep execution user-triggered.
8. Extend workspace schemas/templates, cache/inventory paths and skills through reviewed merges. Render MCP definitions in the existing chosen mode, preserving server identities and avoiding duplicate tools.
9. Run provider fixture tests and small credentialed live smoke queries, Zotero round trip, notebook/review/export workflow and induced failures. Capture source/provider provenance and runtime identities.
10. Reproduce the locked install on a second clean test host, repeat Basic acceptance, and freeze Research compatibility/runbooks at G2.

Provider caches are derived state: key by provider/request identity and schema version, record freshness, and clearly label offline use. Store only permitted fields/payloads, with retention limits; do not treat all third-party metadata/abstracts as unrestricted redistribution material. User data do not enter public test artifacts.

## 6. Work packages

| ID | Work package and deliverable | Depends on | Requirements |
| --- | --- | --- | --- |
| M2-01 | Freeze Research spec/design/tasks, provider/account matrix, ADR-006/007, fixture set | G1 | R-01–R-10 |
| M2-02 | Provider adapter evaluation or authored bridge; locks and MCP contracts | M2-01 | R-02, R-08, R-09 |
| M2-03 | Identity normalization, citation validation, provenance/cache schema | M2-02 | R-03, R-05, R-08 |
| M2-04 | Zotero local read, explicit import/export and failure diagnostics | M2-01, M2-03 | R-04, R-09 |
| M2-05 | Legal/access-aware PDF acquisition using Basic document worker | M2-03 | R-05, R-09 |
| M2-06 | Notebook environment recipe, editor/kernel integration and example notebook | M2-01 | R-06, R-09 |
| M2-07 | Structured skills, review/export workflow and extended diagnostics | M2-04–M2-06 | R-07, R-08 |
| M2-08 | Live/fixture acceptance, repair/regression/reproduction and G2 lock/report | M2-07 | R-01–R-10 |

Implementation artifacts: `specs/phase-2/{spec,design,tasks,acceptance}.md`, Research profile/catalog delta, adapter decision receipts, scientific dependency locks, provider schema fixtures, immutable sample metadata and papers, kernel proof notebook, Zotero test-library runbook and sanitized gate report.

## 7. Acceptance scenarios

| Scenario | Procedure | Pass condition and receipt |
| --- | --- | --- |
| T2-01 | Upgrade Basic to Research and compare prior resource/config identities | Basic tools still work; only planned additions; source/user data hashes preserved |
| T2-02 | Query each provider with deterministic fixtures and a small live request; exercise pagination/cancellation | All selected adapters initialize/discover/call; results normalized with provenance; bounded traffic |
| T2-03 | Validate known DOI, non-Crossref/unresolved DOI, missing DOI and conflicting author/year/title fixtures | Correct identity/nullable fields, unresolved/conflict flags; no unjustified validity or merge claims |
| T2-04 | Read selected test Zotero collection, prepare/import/export sample references, repeat import | Correct library/collection; readable round trip; duplicate policy applied; no real-library mutation |
| T2-05 | Acquire open-access PDF; encounter a login page, inaccessible source, redirect and missing license | Verify bytes/type/hash; unauthorized HTML never indexed as PDF; access state and fallback recorded |
| T2-06 | Reopen VS Code, select kernel, execute small metadata-analysis notebook | `sys.executable` matches locked analysis environment; known table/chart outputs and package identity captured |
| T2-07 | Question → search → citation check → acquire → Zotero → review → notebook → export | Traceable identifiers and source locations; no invented citations; abstract/full-text scopes shown |
| T2-08 | Inject 401/403/429/daily-budget exhaustion/5xx/timeouts and changed/missing fields | Backoff/limits respected; distinguish denied, unavailable, partial and stale; local work remains available |
| T2-09 | Inspect credentials/logs; deny Zotero write; open untrusted notebook/workspace | No credential exposure or implicit write/execution; rejected action produces actionable state |
| T2-10 | Repeat setup, repair an owned environment, downgrade profile and reproduce frozen Research install | No duplication or user-library deletion; Basic passes; adopted applications and user kernels preserved |

For the end-to-end fixture, use 10–20 papers/records including duplicate DOI, preprint/published variants, missing abstract, missing full text and conflicting metadata. Freeze expected invariants and hashes. Live provider ranking counts are observations, not fixed golden outputs. Full profile advancement requires the mandatory APIs and local Zotero/kernel checks to have real receipts; cached fixtures alone are insufficient.

## 8. Risks, fallback and compatibility settings

| Risk | Required setting / design | Recovery |
| --- | --- | --- |
| Zotero unavailable/API disabled/version change | Separate application detection, local API and import-mode checks | Guided setting/startup; read/export fallback with explicit limitation |
| Research API throttling/schema drift | Provider-specific quota/cursor/cache settings and tolerant validated fields | Bounded retries, pinned adapter update, stale cache visibly marked |
| Proxy/TLS restrictions | Reuse approved OS/host certificate configuration; diagnose per runtime | Guided approved certificate/proxy setup; never disable TLS verification |
| Wrong Jupyter kernel | Explicit environment selection and cell-side path check | Re-select owned kernel; do not overwrite unrelated kernels |
| Citation conflicts or incomplete metadata | Per-field provenance and unresolved status | Human review/alternate official resolver; retain original record |
| Full-text unavailable | Access-aware downloader and explicit evidence scope | Manual permitted import or abstract-only review; no paywall bypass |

## 9. G2 exit criteria and handover

All mandatory R requirements pass, and Basic regression remains green. Each provider has a documented identity/schema check and live readiness receipt. The Zotero test-library workflow and actual VS Code notebook kernel are validated. At least one complete research fixture retains provenance from question to final export; failure cases recover without losing work.

Deliver frozen Research catalog/lock, credential/setup instructions, API usage policies, Zotero/Notebook runbooks, structured skills, privacy/data-flow notes, effective integration receipts, completed checklist and G2 report. Phase 3 consumes the acquired corpus and provenance contracts without replacing Zotero or the notebook environment.
