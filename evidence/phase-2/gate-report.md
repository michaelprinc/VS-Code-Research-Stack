# Phase 2 G2 evidence report

Date: 7 October 2026

Implementation: Research Stack 0.2.0 Recommended / Researcher prototype

Outcome: **prototype implemented; G2 not passed**

Prerequisite: **G1 remains open** (see [Phase 1 report](../phase-1/gate-report.md)).

Compatibility record: [Recommended lock](../../.research-toolkit/compatibility-lock.recommended.json).

## Implemented and reproduced locally

| Area | Evidence | Result |
|---|---|---|
| Phase contract | `specs/phase-2/{spec,design,tasks,acceptance}.md` | Prototype requirements frozen at revision 0.1.0; scope exclusions explicit |
| Adapter decision | [ADR-006](../../docs/implementation/decisions/ADR-006-official-research-api-adapters.md) | Authored narrow bridge selected; no unreviewed third-party MCP package |
| Normalized record | `schemas/research-record.schema.json`; `tests/test_research.py` | DOI normalization, per-field provider/upstream/query provenance, exact DOI merge and conflict retention have deterministic fixtures |
| Bounded provider requests | `src/research_stack/research.py` | Fixed HTTPS hosts; 15-second per-request timeout; 4 MiB response limit; maximum 25 records/provider; process-local serialized 1 request/second; no automatic retries or persistent cache |
| Live provider smoke | One query, limit 1, through `search_literature("all", ...)` | OpenAlex returned one record; Crossref returned one record and current response rate headers; Semantic Scholar returned HTTP 429. Overall state was correctly `partial`, with two records and a provider-specific error, not zero results |
| Zotero boundary | [ADR-007](../../docs/implementation/decisions/ADR-007-zotero-local-read-manual-ris.md); Recommended MCP verifier | Collection read fixture and RIS preparation passed; actual local API was unavailable, and the tool reported `ZOTERO_NOT_AVAILABLE` without opening database files |
| VS Code analysis environment | `templates/recommended-overlay/notebooks/analysis/uv.lock`; proof notebook | Locked sync passed on CPython 3.12.13; `ipykernel 7.4.0`, `matplotlib 3.11.2`; notebook code rendered a deterministic chart and reported the environment executable |
| VS Code extensions | Local extension inventory | `ms-python.python@2026.8.0` and `ms-toolsai.jupyter@2025.9.1` are installed. Actual fresh-window kernel selection/execution remains unverified |
| Additive workspace setup | `research-stack add-recommended`; disposable pytest workspace | Dedicated MCP identity, extension recommendations and ignore rule merged; user file and custom MCP server preserved; second run added no files |
| Skills | Five files under `templates/recommended-overlay/.github/skills/` | Search, paper review, citation check, evidence extraction and research summary templates present; actual Copilot discovery unavailable while G1 is open |
| Deterministic regression | `uv run --locked pytest` | **22 passed** |
| MCP protocol and Basic regression | `uv run --locked python scripts/verify_recommended_mcp.py`; `scripts/verify_mcp.py` | Additive upgrade from a Basic workspace launched the copied worker and discovered five tools; synthetic RIS was created in a temporary workspace; Zotero outage remained explicit. Basic server still discovered all three tools and wrote fixture-backed reports |
| Lock and schema checks | `uv lock --check` for both projects; JSON Schema/Notebook JSON parse | Both locks matched their projects; schema and notebook document parsed successfully |

## Provider policies and account observations

- OpenAlex and Crossref each completed a low-volume live request without a credential configured for the process.
- Crossref supplied the current public-pool request headers. The adapter observes response headers and paces requests conservatively at one request per second; it does not assume historical quota limits.
- Semantic Scholar had no key configured and returned HTTP 429 on the one keyless smoke query. The adapter now blocks future Semantic Scholar calls unless `SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED=true` is explicitly set after operator license review; the flag does not expand the license. Its feature remains partial and must not be advertised as live-ready on this host until authorized access succeeds.
- The current Semantic Scholar API license limits ordinary use to internal non-commercial research/education; public data displays require a Semantic Scholar link using `utm_source=api` and the Semantic Scholar name/logo. Product distribution/use may need an expanded license. This is a Phase 4 release gate, not cleared by these tests. See the [current API license](https://api.semanticscholar.org/license).
- OpenAlex key, Crossref mailto/Plus token, and Semantic Scholar key values are not stored in the repo. The tested process had none configured.

## Gate blockers and unverified scenarios

- G1 has not passed because the actual Copilot workflow and clean-host/recovery conditions are still open. Phase 2 cannot pass G2 on top of an open G1 gate.
- Zotero is not installed on the reference machine. Its local API was unavailable; a disposable library, import/export round trip and duplicate behavior have not been tested.
- Jupyter extension and locked packages are installed, but this host did not provide a native Windows UI automation surface to select the kernel in a fresh VS Code window. The Python code was exercised from the locked environment only.
- Copilot is not available for discovery/invocation of the five skills and MCP tools. The Phase 1 Marketplace/bundled companion conflict remains recorded in G1.
- Semantic Scholar live access, higher-tier limits, and license suitability for the eventual VSIX are unresolved.
- Full-text acquisition is deliberately not implemented. Links are hints; no license is verified, no binary is downloaded and no login/paywall is bypassed.
- Persistent cache, multi-page pagination, automatic retry/backoff and broad 401/403/5xx fault matrix are not implemented. The prototype returns bounded explicit errors and Retry-After without automatic retry. These are remaining R-08 tasks.
- macOS remains untested. Platform-neutral paths, environment variable names, settings, locks and line endings do not establish macOS support.

## Decision

The Phase 2 package is viable as a bounded Windows metadata/MCP and analysis prototype. **Do not approve G2 or advertise the full Researcher profile as supported.** Next acceptance work needs G1 closure, an authorized Semantic Scholar route, disposable Zotero and fresh VS Code kernel/Copilot receipts, full failure/recovery coverage, and macOS validation before Phase 4 treats these recipes as installer steps.
