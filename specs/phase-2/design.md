# Phase 2 Researcher design

Revision: 0.1.0. Status: implementation prototype; not a G2 approval.

## Runtime and extension boundary

Keep Basic's `research-stack-basic` MCP process and configuration unchanged. The Recommended overlay adds a separate `research-stack-recommended` stdio MCP process using the existing locked worker environment and only Python standard-library HTTP support. No community research MCP, REST-as-MCP endpoint, additional MCP dependency, vector service, model or Docker prerequisite is introduced.

`research-stack add-recommended <workspace>` requires a Basic profile. It copies only missing owned templates and adapter modules, adds the Research MCP server if that identity is unused, and merges Python/Jupyter extension recommendations. It does not replace files or server definitions. A conflicting existing MCP server ID is preserved and reported for manual review.

## Provider adapter contract

Providers are allow-listed constants and fixed HTTPS base URLs. Search input is 1–500 characters; `limit` is 1–25; one result page/request is issued to each selected provider; request timeout is 15 seconds and JSON response cap is 4 MiB. A process-local lock paces each provider at one request per second until account-specific limits are validated. Provider redirects are accepted only on the same HTTPS host; Zotero redirects are disabled. Credentials are read from process environment only: `OPENALEX_API_KEY`, `CROSSREF_MAILTO`, `CROSSREF_PLUS_API_TOKEN` and `SEMANTIC_SCHOLAR_API_KEY`. The adapters never log or echo credential values.

Do not automatically retry in this prototype. Return a stable error class and `Retry-After` when supplied; a caller can wait and retry deliberately. This conservative zero-retry policy avoids exceeding unknown provider budgets. The `all` route returns successful providers and provider-scoped errors together and marks the result `partial`. There is no persistent cache; current queries are live requests. A future cache must include provider, query hash, schema version and freshness and must be provider-policy-reviewed before persisting abstracts.

Normalized fields carry their own value and provenance: provider, upstream ID, fetched timestamp and SHA-256 query hash. Merge exact normalized DOI values only, and retain conflicting values with all field sources. Records without DOI keep provider-scoped identities. No fuzzy title matching is performed.

## Zotero and import flow

Use only `http://localhost:23119/api/`, with proxy bypass and a short timeout. Expose collection and item GETs. Treat 403 as local API disabled and connection failure as Zotero unavailable. Never inspect Zotero's database files. `prepare_zotero_import` validates and creates a new RIS file under `research/imports/`; a person reviews and imports it from Zotero UI. Duplicate detection and the final import remain explicit human actions. Remote Zotero credentials are outside this prototype.

## Notebook and data boundaries

The analysis environment has a separate uv lock for `ipykernel` and `matplotlib`; it is not the MCP worker environment. The synthetic proof notebook records `sys.executable` and package versions, renders a deterministic table and chart, and contains no provider query. VS Code cell execution remains user-triggered. Extensions are recommended, not silently auto-installed by workspace initialization.

Provider-returned abstracts remain ephemeral tool responses. Do not export API payloads or abstracts wholesale. Semantic Scholar is disabled unless an operator explicitly acknowledges its current API license in the process environment; that setting does not expand the license. Review cloud-model sharing and product/public display permissions before enabling or distributing this route. Open-access URLs are hints only: no license is verified and no binary is retrieved. Full-text acquisition needs a later rights/access design and content hash/type checks.

## Cross-platform settings

Use relative workspace paths, uv project locks, environment variable names, loopback hostname, JSON/RIS/Notebook formats and LF-normalized text. Do not write drive letters, shell-specific environment syntax or platform-specific interpreter paths to templates. `uv` and VS Code resolve host-specific Python paths at runtime. This establishes portable configuration shape, not a macOS support claim.
