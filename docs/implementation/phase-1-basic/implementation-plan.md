# Phase 1 implementation plan — Basic / Research Starter

Status: local Windows prototype implemented; G1 remains open. Dependency: reviewed project scope. Output: a locked Basic document/MCP worker and reusable setup recipes for later VSIX orchestration.

Shared obligations: [C-01 through C-12](../architecture-and-contracts.md). Execution tracker: [Phase 1 checklist](checklist.md). Next phase: [Recommended package](../phase-2-recommended/implementation-plan.md).

## 1. Scope and stories

The researcher can open a prepared workspace, read selected PDF/DOCX sources, create grounded notes and a DOCX report, manage local Git history, access a selected GitHub repository, and prepare a NotebookLM import bundle. Copilot supports the analysis when the user's account and policy permit it. Local document tools remain useful when cloud AI is unavailable, with that limitation visible.

Basic must not require Docker, Qdrant, Zotero, Jupyter, embedding models or GPU drivers. A small isolated Python runtime is acceptable for document functionality; detect/reuse a compatible runtime or guide its explicit installation. Avoid a machine-wide dependency merely for optional viewer convenience.

## 2. Specification requirements

| ID | Requirement | Acceptance scenario |
| --- | --- | --- |
| B-01 | Detect host, VS Code, Copilot, Git, runtime paths and organization restrictions without changing them | T1-01 |
| B-02 | Resolve/install only Basic dependencies using immutable identities and owned isolated environments | T1-02, T1-08 |
| B-03 | Create/merge research folders, instructions, skills, extension recommendations and ignores | T1-03 |
| B-04 | Read text-bearing PDF and DOCX with source locators and explicit extraction limitations | T1-04 |
| B-05 | Write Markdown and DOCX outputs while preserving sources and existing user files | T1-05 |
| B-06 | Make document tools discoverable and usable from actual VS Code Copilot chat | T1-06 |
| B-07 | Integrate local Git and minimal GitHub read access with recoverable authentication failures | T1-07 |
| B-08 | Prepare a documented, user-mediated NotebookLM import bundle | T1-05 |
| B-09 | Produce actionable health/installation receipts and resume or recover interrupted setup | T1-01, T1-08 |
| B-10 | Bound source/output access, preserve config, redact credentials and respect trust/ownership | T1-03, T1-09, T1-10 |

Nonfunctional acceptance: standard-user runtime setup on the reference host; no hidden global PATH or policy changes; deterministic dependency lock; no repeated downloads when verified artifacts are cached; passive diagnostics complete within a proposed 10 seconds on a responsive host, while timed-out network checks become separate results. Installer and long-running parsing must expose cancellation.

Define document-tool timeout, input size/page limit, extracted-result size, and memory ceiling before fixture testing. Proposed initial limits are 60 seconds per document, 50 MiB input, 500 pages, and 1 MiB returned text per MCP response; support pagination/chunk reads rather than truncating silently. Validate these limits against a real scholarly fixture set and change them through specification review if unsuitable.

## 3. Component selection and VS Code integration

| Component | Proposed route | Compatibility proof |
| --- | --- | --- |
| VS Code Desktop | Reuse supported Stable; guide official installation only if missing | Exact version, local extension host, minimum-feature checks |
| GitHub Copilot / Chat | Detect current supported arrangement; candidate IDs `GitHub.copilot` and `GitHub.copilot-chat` are verified before recommendations | Authenticated chat and actual document-tool call, not just extension presence |
| Git | Reuse compatible Git for Windows; otherwise guide supported upstream/package-manager route | Effective executable and local commit/diff fixture |
| Python and environment manager | Evaluate CPython 3.12 x64 and uv; use an owned document environment | Exact interpreter path, binary dependency availability, lock and import/parser checks |
| PDF extraction | Evaluate pinned pypdf behind an authored or selected document MCP | Page locators, Unicode, malformed/encrypted/scanned error handling |
| DOCX extraction/authoring | Evaluate pinned python-docx in the same light worker | Paragraph/table locators and fixture-specific round trip |
| PDF/DOCX preview | Start with external system viewer and extracted-text preview; optionally recommend an evaluated viewer extension | UI rendering tested independently of extraction; no Microsoft Word requirement |
| Markdown | Native VS Code editing/preview | UTF-8, links and research note template |
| GitHub MCP | Evaluate official remote MCP authorization and minimal read tools | Actual discovery plus selected repository read; block optional writes |
| Filesystem MCP | Add only if native tools leave a proven gap | Roots/operation restrictions and no redundant tools |
| NotebookLM helper | Export supported local files with source index and handoff instructions | Bundle inspection; live manual import if account available |

Candidates are not installation instructions to run now. Freeze actual package versions, extension IDs, dependency ranges and artifact hashes after evaluation. The [source review](../source-review-and-decisions.md) records upstream references and unresolved adapter choices.

The document worker exposes narrow tools such as reading document metadata, reading page/paragraph ranges and writing a report to a selected output path. Do not expose shell execution or unrestricted path reads as document functionality. Text extraction is not reliable layout reconstruction or OCR. Scanned inputs return an explicit `PARSER_UNSUPPORTED`/OCR-needed result; OCR is a future optional capability.

## 4. Spec and design artifacts to create during implementation

- `specs/phase-1/spec.md`: B-01–B-10, stories, limits, host scope, no-cloud behavior, acceptance cases and exclusions.
- `specs/phase-1/design.md`: C-contract application, dependency graph, runtime/data roots, MCP/tool schemas, configuration ownership and installer journal.
- `specs/phase-1/tasks.md`: M1 work packages with owners, dependencies and estimate.
- `specs/phase-1/acceptance.md`: fixture hashes, scenario procedures and expected invariant checks.
- ADR-001–ADR-005 records; `profiles/basic` and initial catalog/schema/lock files.
- Redacted baseline host inventory and original-config backups; no private corpus in fixtures.

Choose a source-controlled spec revision before implementation. On review, resolve any ambiguity over cloud content disclosure, GitHub read scope, document fidelity and portable/client support.

## 5. Future installation procedure

1. **Inventory:** collect host/architecture, VS Code and extension versions, trust/policy, Git and Python/uv executable identities, proxy/certificate needs and candidate storage roots. Do not print tokens or credentials. Detect preexisting configuration, conflicting toolkit IDs and occupied ports if applicable.
2. **Plan:** expand Basic capabilities and mark each resource managed/adopted/external. Show downloads, versions, paths, config diff, account prerequisites and any manual application steps. Keep VS Code/Git installation separate from toolkit-owned environments.
3. **Prepare:** acquire verified runtime/package artifacts through approved upstream routes. Reuse compatible Python; if missing, offer user-level supported installation. Select an owned managed root and keep it separate from global site-packages and unrelated virtual environments.
4. **Build the document environment:** create a versioned isolated environment; install from the reviewed lock using a reproducible package-manager mode. Resolve binary wheels and dependency constraints; avoid ad hoc fallback compilation as the user-facing default. Record effective interpreter and package hashes.
5. **Integrate the editor:** apply verified profile-specific extension recommendations; install only selected editor extensions through supported VS Code mechanisms. Guide Copilot sign-in/entitlement without trying to supply or purchase it. Confirm the actual active host/extension versions.
6. **Prepare the workspace:** create missing folders, source index, instructions and two skills (`research-basic`, `document-review`). Merge `.gitignore`, recommendations and relevant settings with a preview; leave unrelated entries intact. Avoid committing documents/credentials or initializing/publishing a remote repository implicitly.
7. **Configure tools:** choose managed provider prototype OR tested portable configuration mode. Reference the owned interpreter/worker using properly serialized arguments. Verify `mcpServers` versus `servers` schema, environment variable resolution and working directory on Windows. Do not register both modes for the same server.
8. **Authenticate:** user authorizes Copilot/GitHub through supported host flows. Minimal repository read access is independent of local Git installation. Runtime credentials remain outside workspace configuration.
9. **Validate:** run fixture document operations, actual Copilot invocation, Git/GitHub smoke checks, export bundle inspection, diagnostics, rerun and recovery. Attach redacted receipts.
10. **Freeze:** record known-good versions in the compatibility lock, publish the local runbook and close G1. Nothing is a production VSIX yet.

Illustrative future operations are “create isolated environment”, “synchronize reviewed lock”, “show MCP configuration diff” and “run Basic diagnostics”. The concrete OS/package-manager commands are derived from selected versions, captured verbatim in the implementation runbook and routed through argument arrays rather than unsafe shell interpolation.

## 6. Work packages

| ID | Work package and deliverable | Depends on | Requirements |
| --- | --- | --- | --- |
| M1-01 | Review specification, reference-host matrix, fixture/license inventory and ADR-001/002 | — | B-01–B-10 |
| M1-02 | Detection core, schemas, catalog, capability graph and dry-run plan | M1-01 | B-01, B-02, B-09 |
| M1-03 | Owned runtime/environment recipe, download verification, journal and resume | M1-02 | B-02, B-09, B-10 |
| M1-04 | Document tools, source-location schema, limits and report/export formats | M1-03 | B-04, B-05, B-08, B-10 |
| M1-05 | Workspace merge/templates, instructions, skills and recommendation selection | M1-02 | B-03, B-10 |
| M1-06 | Minimal VS Code/MCP harness, mode selection, credentials and GitHub route | M1-04, M1-05 | B-06, B-07, B-10 |
| M1-07 | Basic health checks and all positive/failure/recovery scenarios | M1-03–M1-06 | B-01–B-10 |
| M1-08 | Independent repeat-install run, compatibility lock, support notes and G1 report | M1-07 | B-02, B-09, B-10 |

Do not implement the final webview wizard in this phase. A development harness and reviewed CLI/runbook are sufficient to validate the installer/core interfaces.

## 7. Acceptance scenarios and evidence

| Scenario | Procedure | Required evidence / pass condition |
| --- | --- | --- |
| T1-01 | Run inspect/diagnose before and after setup | Passive checks mutate nothing; real versions and clear missing/policy/auth states |
| T1-02 | Install Basic on a clean disposable reference environment | Only Basic graph installed; no Docker/DB/model; hashes and effective environment recorded |
| T1-03 | Apply setup twice to an existing workspace, then modify a managed config entry | Second run duplicates nothing; unrelated content survives; user conflict gets a diff, not overwrite |
| T1-04 | Read synthetic/licensed English and Czech PDFs/DOCX, including tables, scanned, encrypted and malformed cases | Expected text/locators on supported fixtures; explicit limitations/errors on unsupported cases |
| T1-05 | Generate Markdown/DOCX and NotebookLM bundle from selected sources | Source hashes unchanged; output structure verified; source inventory/locators retained; manual handoff documented |
| T1-06 | Invoke document tool and skill from a new actual Copilot chat on a fresh VS Code window | Tool discovery plus real invocation output and a cited page/paragraph; no duplicate toolkit tools |
| T1-07 | Local Git fixture and selected GitHub repository read, then revoke/omit authorization | Correct local executable and remote identity; auth failure leaves document workflow intact |
| T1-08 | Cancel during download/configure, interrupt after a journaled step, rerun, then induce validation failure | Safe resume or rollback, previous config intact, no orphaned owned processes; external applications accurately reported |
| T1-09 | Attempt traversal, junction/symlink escape, oversized result and forbidden output overwrite; run in restricted mode | Worker rejects out-of-scope operations; executable setup blocked in untrusted workspace; bounded errors |
| T1-10 | Use a path with spaces/Czech characters and multiple Python installations; inspect logs/export | Correct interpreter/arguments; no credentials/private file bodies in diagnostic export |

For the DOCX report, inspect the fixture's headings, tables, references and readable rendering in an available viewer; lack of pixel-identical layout is an explicit scope limit. Preserve immutable originals. If live NotebookLM import cannot be checked, record the helper's file validation separately from account-side import readiness; do not call the cloud integration validated.

## 8. Risks and recovery

| Risk | Prevention | Recovery / scope decision |
| --- | --- | --- |
| No binary wheels or candidate runtime mismatch | Resolve on exact Windows/Python pair first | Select a supported runtime/lock and repeat tests; do not alter global Python |
| PDF extraction misses formulas/reading order | Fixture quality annotations and source previews | Flag low confidence; preserve document; optional richer parser evaluated later |
| Copilot/GitHub unavailable or policy-blocked | Preflight identity/entitlement/policy | Local document mode; AI/GitHub acceptance remains blocked, not passed |
| Viewer extension stale/unavailable | Viewer-independent extraction contract | External open plus text preview; document any preview exclusion |
| Workspace config conflicts | Backups, ownership hashes and merge preview | Restore previous config or retain user's edit; replan |
| Portable config credential mismatch | Test each export client's variables/trust | Managed provider route or documented per-client fallback |

## 9. G1 exit criteria

All mandatory B requirements and T1 scenarios pass on the declared reference row. Installation is reproduced on a second clean disposable environment with the frozen artifacts. Basic can be rerun and recover from interrupted setup; sources/configuration/credentials remain protected. The gate report records any unavailable external account functionality as blocked or explicitly excluded, with no unsupported broad claim.

Hand over catalog/schema/core interfaces, Basic profile, exact lock, effective environment receipts, fixture set, installation/configuration runbook, credential/data-flow notes, recovery instructions and the completed checklist. Phase 2 expands those contracts rather than replacing the working Basic foundation.
