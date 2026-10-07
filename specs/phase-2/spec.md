# Phase 2 Researcher specification

Revision: 0.1.0 (implementation prototype, 7 October 2026)

State: frozen for this prototype; G2 not passed.

Prerequisite: the published G1 report remains open. Phase 2 work is additive and does not imply that the Basic gate has passed.

## User outcome

A researcher can search OpenAlex, Crossref and Semantic Scholar through bounded read-only adapters, carry exact provider identifiers and per-field provenance into a normalized record, resolve a DOI against Crossref without overstating the result, read a selected Zotero library through Zotero's loopback API, prepare but not execute a reviewed RIS import, and analyze synthetic or user-selected metadata in an explicitly selected VS Code notebook kernel.

## Requirements and acceptance mapping

| ID | Requirement | Prototype scope | Acceptance |
|---|---|---|---|
| R-01 | Extend Basic additively and retain Basic behavior | `add-recommended` adds a dedicated MCP server and missing files, merges editor recommendations, and preserves existing files | T2-01 |
| R-02 | Search all three scholarly metadata APIs with bounded requests | One HTTPS request per provider/query; max 25 records/provider; max 15-second request timeout | T2-02, T2-08 |
| R-03 | Normalize identities and retain field provenance/conflicts | DOI-normalized stable identity; provider, upstream ID, fetched time and query hash per field; exact DOI-only merge | T2-03 |
| R-04 | Read local Zotero and support reviewed import | Loopback-only collection/item GET; generate new RIS for manual UI import; no API/database writes | T2-04, T2-09 |
| R-05 | Report accessible full-text information safely | Expose provider-reported OA links but label license unknown; no automatic download | T2-05 partial; acquisition scenarios deferred |
| R-06 | Select and prove the notebook runtime | Dedicated uv lock, synthetic proof notebook; Jupyter extension/kernel host run remains external acceptance | T2-06 partial |
| R-07 | Provide structured research skills | Five scoped skills cover search, review, citation check, extraction and synthesis | T2-07 partial; real Copilot discovery pending |
| R-08 | Handle quotas and outages without false zero results | Bounded calls, distinct auth/rate-limit/outage errors, `Retry-After` reporting, partial `all` results; no automatic retry or persistent cache | T2-02, T2-08 partial |
| R-09 | Keep secrets and Zotero writes under user control | Secrets read from process environment; no secret files; Zotero read-only; manual import; user-run notebook | T2-04, T2-09 partial |
| R-10 | Preserve Basic on upgrade/repair | Separate server identity and additive files; preserve conflicts; same locked MCP worker environment | T2-01, T2-10 partial |

## Scope and boundaries

- Metadata search and bibliographic identity are not assessments of scientific validity.
- Search may be incomplete, stale or provider-dependent; an API error is never converted to zero results.
- DOI misses in Crossref are unresolved, not invalid.
- Semantic Scholar requests require an explicit process-level license acknowledgment. The setting records operator review but does not expand rights; no public display, third-party/cloud transmission or product use is authorized by it.
- Merge only exact normalized DOI matches. Similar titles and preprint/published versions are not automatically merged.
- Do not download articles, bypass logins/paywalls, write to Zotero, execute notebook cells from an agent, or store provider credentials in workspace files.
- The Basic G1 gate, a live Zotero test collection, S2 account credentials, and VS Code Jupyter host/kernel proof are prerequisites for a future G2 decision.
- No macOS compatibility claim is made until the native run and host integration pass.
