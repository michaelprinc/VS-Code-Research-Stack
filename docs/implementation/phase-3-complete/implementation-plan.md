# Phase 3 implementation plan — Complete / Research Lab

Status: prototype foundation partially implemented (7 October 2026); G2 prerequisite remains open and G3 is not passed. Dependency: G2, frozen Basic/Research locks and an acquired fixture corpus. Output: validated local advanced research stack and recovery/migration recipes suitable for the final installer.

Phase 3 revision 0.1.0 adds the specification/design/tasks/acceptance, ADR-008–ADR-011, and a dependency-free in-memory Markdown source/chunk identity plus BM25 prototype. It does not implement or validate Full installation, vector/hybrid retrieval, DuckDB, the Research-RAG MCP, or recovery. See [Phase 3 evidence report](../../../evidence/phase-3/gate-report.md). The Full gate stays closed while G1/G2 are open.

Shared obligations: [C-01 through C-12](../architecture-and-contracts.md). Tracker: [Phase 3 checklist](checklist.md). Previous: [Recommended](../phase-2-recommended/implementation-plan.md). Next: [VSIX completion](../phase-4-vsix/implementation-plan.md).

## 1. Scope and deployment policy

Full inherits Research and adds local corpus ingestion, Qdrant vector storage, revision-pinned embeddings, BM25 lexical retrieval and hybrid ranking, an optional selected reranker, embedded DuckDB research records, provenance and claim/evidence relationships. It exposes bounded retrieval and evidence operations to VS Code through Research-RAG MCP.

Playwright MCP and institutional connectors are available advanced capabilities, enabled separately. A Full installation must declare which optional capabilities are ready, disabled, blocked or excluded. Each advertised institutional connector needs its own provider/account validation; a generic browser demo does not establish institutional compatibility.

The Windows reference deployment uses a local Qdrant Linux container with pinned digest and persistent named volume. Docker Desktop is absent from lighter profiles; it is a prerequisite for this particular Full route. Detect and reuse a working supported Docker backend. If Docker is unavailable, either validate a separate non-Docker local service/backend route or report Full service installation blocked. A remote Qdrant connection and Qdrant client local mode are different deployment modes with separate contracts and receipts; do not silently substitute them.

CPU is the mandatory embedding/retrieval execution baseline. Candidate light model: `intfloat/multilingual-e5-small`. Candidate advanced model: `BAAI/bge-m3`. Candidate reranker: `BAAI/bge-reranker-v2-m3`, with a smaller maintained alternative evaluated if it misses CPU resource targets. All need fixed revisions, reviewed licenses and backend locks before selection. Local generation models, ROCm/CUDA setup and multi-user distributed RAG are outside the mandatory scope.

## 2. Specification requirements

| ID | Requirement | Acceptance scenario |
| --- | --- | --- |
| F-01 | Expand Research to Full with hardware/storage/backend preflight and explicit added permissions | T3-01, T3-13 |
| F-02 | Install/reuse Qdrant locally, preserve storage and prove actual service/image identity | T3-02, T3-11 |
| F-03 | Acquire/load exact models locally and validate preprocessing, dimensions and resource use | T3-03, T3-09 |
| F-04 | Ingest immutable sources into stable chunks with source/parser/model provenance | T3-04, T3-07 |
| F-05 | Implement BM25, vector and hybrid retrieval with benchmarked quality and bounded latency | T3-05, T3-09 |
| F-06 | Store claims/evidence/provenance in DuckDB and keep cross-store indexing recoverable | T3-07, T3-08, T3-11 |
| F-07 | Expose Research-RAG MCP and citation-bearing results in actual VS Code workflows | T3-06 |
| F-08 | Install and validate selected reranking/larger-model options independently | T3-03, T3-05, T3-09 |
| F-09 | Offer isolated Playwright automation with explicit session and tool scope | T3-10 |
| F-10 | Implement selected institutional source adapters with supported entitlement/login/export paths | T3-12 |
| F-11 | Back up, restore, migrate/reindex and recover without data loss or unsafe downgrade | T3-08, T3-11 |
| F-12 | Preserve Research/Basic behavior and demonstrate reproducible Full installation | T3-01, T3-13 |
| F-13 | Report accurate host/permission/data-flow boundaries and degraded readiness | T3-01, T3-10, T3-12, T3-14 |

F-08–F-10 are conditional requirements: selected/advertised capabilities must pass their associated scenarios. Skipping one yields a declared exclusion, not a complete acceptance receipt for that capability. F-01–F-07 and F-11–F-13 are mandatory for the Full core.

## 3. Resource and retrieval acceptance baseline

Define a reference CPU host in the specification. Proposed planning envelope: 16 GiB system RAM minimum candidate for the small-model route, 32 GiB preferred for testing, and at least 20 GiB free for the pilot plus estimated download/index/backup requirements. Preflight calculates actual required space from selected artifacts/corpus; these numbers are estimates, not established minimum support claims.

Proposed benchmark fixture: 50–100 licensed/synthetic English and Czech documents, approximately 1,000–5,000 chunks, and 30 adjudicated retrieval queries with frozen relevance labels, including five queries with no supporting evidence. Preserve hashes, parser settings, model revisions, token limits and machine identity. Freeze relevance before comparing candidates.

| Measurement | Proposed acceptance target | Method |
| --- | --- | --- |
| Source traceability | Every returned evidence item resolves to its actual source version/location | Inspect hashes/locators against the fixture corpus |
| Retrieval quality | Recall@10 at least 0.80 on answerable fixtures; report nDCG@10 and language breakdown | Compare BM25, vector, hybrid, and selected reranker on identical inputs |
| Hybrid regression | Overall nDCG@10 no worse than the better baseline by more than 0.02 absolute | Repeated identical runs, versioned score table and reviewed tradeoff |
| Warm retrieval latency | Proposed p95 at most 5 seconds without reranking; at most 10 seconds with the selected CPU reranker | Exclude download/cold initialization; report 3 warmups and 5 measured runs per query |
| Process/backend memory | Proposed combined working memory at most 8 GiB for light route | Observe worker, model and database processes/backend; record host/backend overhead separately |
| Ingestion | No lost, duplicate or stale searchable chunks on replay/update/delete | Inject interruption at journal boundaries and compare inventories |
| No-answer scope | Five no-evidence cases produce no fabricated citation or support assertion | Grounding evaluation; retrieval similarity alone is not a factual support oracle |

If these proposed limits are inappropriate for the agreed host/corpus, revise them before measurement and record the rationale. Failing results trigger a design/selection decision; do not quietly rename a failing candidate as compatible. Record cold load, throughput, model download sizes, CPU use and total disk/backup footprint even where no pass threshold is defined.

## 4. Ingestion, storage and evidence contracts

Pipeline: source acquisition/import → hash/inventory → document extraction → token-aware chunking with page/paragraph spans → metadata/provenance → lexical and vector indexing → hybrid search → optional reranking → source-linked evidence → reviewed claims.

Preserve originals. Store derived documents, chunks, embeddings and indexes under workspace/corpus IDs. Define stable source-version IDs from content hashes; chunk IDs include source version, parser/chunker fingerprint and span. Each collection/index has a fingerprint including embedding revision, vector dimension, normalization, preprocessing, parser/chunker versions and distance metric. For E5, validate required query/passage prefixes using the model card; never assume every embedding model shares that policy.

DuckDB is embedded in the RAG worker, not a separate service. Use it for sources, ingestion runs, chunk metadata, claims, evidence links, review states and migration records. Store claims as drafts until reviewed. Suggested claim/evidence fields: claim ID/text/status/reviewer, evidence ID, source hash/version, chunk/page/paragraph span, exact excerpt/offsets, supporting/contradicting/context relation, extraction method/version, created time and analysis/run provenance. Confidence/similarity is not proof. A separate graph database is unnecessary for the first relational claim graph.

Serialize writes through a single owning worker; notebooks query exports or a reviewed read interface rather than competing direct writes. Disable arbitrary SQL/file/network extension use through MCP and allow only bounded parameterized research operations. Use portable JSONL/Parquet exports as additional recovery/interoperability artifacts.

Qdrant and DuckDB do not form one ACID transaction. Use a persistent ingestion journal/outbox with idempotent upserts and a committed manifest. Expose only committed batches to retrieval; reconcile pending batches after failure. Re-ingestion, deletion and model changes must address both stores. Build new model/chunker indexes under separate identities and switch only after validation; never query old vectors with a new incompatible encoder.

## 5. Future installation/configuration procedure

1. Validate Research baseline; capture source/config/data inventories and available storage/CPU/RAM. Preview model downloads, browser permissions, service backend and backup overhead.
2. Detect Docker backend/version, virtualization availability, organization policy and existing workloads. Guide missing Docker Desktop/backend setup explicitly; any administrator action or reboot is a separate visible prerequisite. Do not change system virtualization settings during extension activation.
3. Resolve Full dependency graph and locks, including service digest, Qdrant client/server pair, embedding/tokenizer/runtime, DuckDB, BM25 implementation and chosen browser/optional adapters.
4. Provision only a toolkit-owned named volume/container identity. Bind exposed database ports to loopback; configure service authentication if appropriate to the threat model. Record actual image digest, mounts, ports and service readiness. Choose a different approved port on conflict instead of stopping the current listener.
5. Create an owned CPU RAG environment from its reviewed lock. Confirm Torch/Sentence Transformers or chosen equivalent binary availability on the selected Python/OS pair. Keep this environment separate from Basic documents and Research notebooks.
6. Download selected model revisions into a managed cache after size/license preview and integrity checks. Prefer safe artifact formats; do not enable arbitrary remote model code as a silent fallback. Test finite output values, expected dimensions and preprocessing on fixture text.
7. Initialize DuckDB schema and Qdrant collection namespaces; configure corpus/data/cache paths and retention. Record migration versions and actual ownership. Set a named BM25 implementation/tokenization version and hybrid-fusion parameters.
8. Ingest the immutable fixture corpus through the existing document worker. Validate journal/replay, source spans, retrieval and claim/evidence export before accepting a user's real corpus.
9. Register Research-RAG MCP in the existing selected configuration mode; prove actual Copilot discovery and citation-bearing tool invocation. Add evidence-review, systematic-review and adversarial-review skills, preserving source-scope and approval rules.
10. If selected, install exact Playwright MCP/browser revisions in isolated caches; create a dedicated browser profile and validate safe public/test-site interaction. Browser downloads are explicit capabilities, not bundled into Basic.
11. If selected, evaluate an institutional provider's documented API/access route. Configure endpoint, entitlement, account/session storage, permitted domain/content scope and user-mediated login. Verify access with an approved small test corpus/account; record manual-only or blocked features honestly.
12. Run benchmarks, migration/recovery simulations and Research/Basic regression. Reproduce the frozen Full core on a second clean host, then freeze catalog/lock and close G3.

Store future Compose/service templates outside installed extension code and preserve configured volume identities. A successful container start is insufficient: validate collection creation, upsert, retrieval and persistence with a real worker.

## 6. Browser and institutional integration

Playwright is not an OS sandbox. Use a dedicated toolkit browser context/profile, no reuse of the personal default profile, explicit navigation/download scope and approved client tool permissions. A domain list is a convenience guardrail; test redirects and session handling. Do not expose authenticated cookies, headers or private screenshots through general diagnostics.

Institutional connector work is provider-specific. At least one selected provider needs a documented endpoint/access method, credentials/SSO/VPN/proxy prerequisites, entitlement checks, download/export policy, provenance and a live authorized receipt before it is labeled supported. ScienceDirect/Elsevier and JSTOR from the attachment are candidates requiring their own evaluation; no universal MCP adapter or automatic TDM permission is assumed.

The connector can be a metadata API, supported full-text API, link resolver or user-assisted browser handoff. An expired session yields re-authentication, not credential replay or access bypass. Never automate CAPTCHA/MFA avoidance. If institutional access is unavailable, retain the connector design and declare it blocked/excluded; Full core can pass with that explicit scope limit.

## 7. Work packages

| ID | Work package and deliverable | Depends on | Requirements |
| --- | --- | --- | --- |
| M3-01 | Freeze Full specification, fixture benchmark, resource envelope, ADR-008–ADR-011 | G2 | F-01–F-13 |
| M3-02 | Local Qdrant/backend recipe, data identity, client pair and health probes | M3-01 | F-01, F-02, F-13 |
| M3-03 | CPU embedding/model recipes, fingerprints and optional model/reranker evaluation | M3-01 | F-03, F-08 |
| M3-04 | Ingestion, source/chunk/provenance schema, DuckDB owner and journal/reconciliation | M3-02, M3-03 | F-04, F-06, F-11 |
| M3-05 | BM25/vector/hybrid retrieval, benchmark and selected reranker | M3-04 | F-05, F-08 |
| M3-06 | Research-RAG MCP, claim/evidence operations and research skills | M3-04, M3-05 | F-06, F-07, F-13 |
| M3-07 | Selected Playwright and provider-specific institutional adapters | M3-01, M3-06 | F-09, F-10, F-13 |
| M3-08 | Backup/restore, schema migration and encoder/chunker reindex prototypes | M3-04–M3-06 | F-02, F-06, F-11 |
| M3-09 | Full acceptance, Basic/Research regression, reproduction and G3 report/lock | M3-07, M3-08 | F-01–F-13 |

## 8. Acceptance scenarios

| Scenario | Procedure | Required pass condition / evidence |
| --- | --- | --- |
| T3-01 | Full preflight/install over Research, including insufficient resources and missing backend | Accurate plan/diagnostics; existing stack preserved; blockers before expensive work |
| T3-02 | Create fixture collection, upsert/query, stop/start owned service and restart host | Real digest/client identity; corpus survives; service attaches to intended volume |
| T3-03 | Load exact small model and selected advanced/reranker candidates | CPU actual runtime, dimensions, finite vectors, token/preprocessing policy and immutable cache identity |
| T3-04 | Ingest twice; change/delete one source; interrupt before/after vector upsert | No duplicates/stale chunks; committed inventory matches both stores; source hashes unchanged |
| T3-05 | Benchmark BM25/vector/hybrid and selected reranker on identical corpus/queries | Frozen quality targets and score table, per-language results and valid source links |
| T3-06 | Actual VS Code Copilot question invokes Research-RAG and opens cited evidence | Correct source version/page or paragraph; skill/tool discovery; grounded/no-answer behavior |
| T3-07 | Create supporting and contradicting evidence plus reviewed/draft claims, export/reload | Relationships and locators preserved; invalid/dangling evidence rejected |
| T3-08 | Use concurrent notebook reader/worker writer; kill worker mid-ingest; replay | Serialized writes, recoverable outbox and consistent committed corpus; clear busy/timeout behavior |
| T3-09 | Measure cold load, warm query p95, memory, disk and ingestion under reference load | Published effective hardware/model/backend configuration and threshold decisions |
| T3-10 | Selected Playwright public fixture, dedicated session, restricted roots/redirects and session expiry | Matched browser revision, separate state, bounded actions and honest permission limits |
| T3-11 | Back up consistent stores, restore separately, simulate migration/reindex failure | Restored counts/hashes/claims and retrieval; no blind binary downgrade; old working pair preserved |
| T3-12 | Selected provider authentication/entitlement, retrieval, expiry/denial and permitted export | Live authorized receipt per advertised connector; denied access does not bypass protection |
| T3-13 | Rerun/repair/downgrade, second clean Full core install and Basic/Research scenarios | Data/config retained, only owned changes removed, frozen artifacts reproduce |
| T3-14 | Review network listeners, secrets, cloud data flow, untrusted host and wrong execution host | Loopback/service scope, redaction and host/trust checks pass; no unsupported isolation claim |

## 9. Recovery and update groundwork

Before schema/service migration, stop or quiesce writes and record a consistent manifest across DuckDB, Qdrant, lexical index and source inventory. Use the selected version's supported snapshot/export procedure; do not assume a live file copy is consistent. Test restoration into a separate namespace/data root and compare counts, source hashes, claim/evidence links and fixture retrieval.

Model/retrieval-setting changes can require complete reindexing even if vector dimensions match. Stage a new encoder/index pair, benchmark it, retain the old matching pair, and switch a recorded active pointer. Failure returns to the old pair. Storage-format changes require a compatible backup/export restore path; merely reinstalling the old binary is not rollback.

General update UI belongs to Phase 4, but this phase must provide proven validation/backup/migration/restore operations. Mark unsupported automated upgrade/downgrade paths as guided or blocked. Do not delete original sources or user claims to make an index repair appear successful.

## 10. G3 exit criteria and handover

Mandatory Full core requirements pass with real local Qdrant, CPU models, hybrid retrieval, provenance and recovery receipts. Selected advanced capabilities pass or are explicitly excluded; public release support labels reflect those outcomes. Benchmark and resource targets are met on the declared host. Repeat installation and inherited profile regression pass.

Deliver Full profile/catalog/locks, immutable model/service identities, retrieval benchmark, effective runtime proofs, data schema/ownership map, backup/restore/reindex runbooks, selected browser/provider setup notes, completed checklist and G3 report. Phase 4 packages these proven procedures and cannot treat an untested recipe as a supported component.
