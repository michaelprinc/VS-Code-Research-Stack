# ADR-006: Use authored, narrow adapters for official scholarly APIs

Date: 7 October 2026. Status: accepted for the Phase 2 prototype; production quotas, schema drift and live integration remain to be validated.

## Context

No reviewed community MCP package in the source register had an exact immutable identity and sufficient license, Windows behavior and tool-permission evidence. Configuring REST URLs as MCP servers would also be incorrect: the hosted APIs speak HTTP, while the project needs a local MCP transport.

## Decision

Use a local stdio MCP bridge implemented in the project. It calls only fixed HTTPS endpoints for OpenAlex, Crossref and Semantic Scholar with Python's standard library. API keys/contact details are optional provider-specific process environment values, not workspace configuration. Keep each provider failure separate and return provenance per field. Query only on explicit tool invocation.

## Consequences

- No new runtime SDK dependency or provider-specific package lock is required for metadata access.
- The implementation owns normalization and must track official endpoint schema/policy changes.
- Requests are bounded to 25 results, 15 seconds and one request per provider; automatic retries and persistent caching are disabled in the prototype.
- Semantic Scholar is disabled by default. A process-level `SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED=true` flag is required before requests; it is an operator acknowledgment only and does not grant rights. Public display, third-party/cloud transmission and VSIX product use need current license review/permission.
- OpenAlex/Semantic Scholar abstracts may carry third-party terms; the implementation does not persist them or bulk-export raw records.
- G2 still requires schema/fixture tests and low-volume live requests from the reference host.

## Reviewed upstream sources

- [OpenAlex API reference](https://help.openalex.org/api/) and [authentication/budgets](https://help.openalex.org/api/authentication/).
- [Crossref REST access/authentication and current rate headers](https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/).
- [Semantic Scholar Academic Graph API](https://api.semanticscholar.org/api-docs/).
- [Semantic Scholar API license](https://api.semanticscholar.org/license): ordinary use is scoped to internal non-commercial research/education; public data displays require an attributed Semantic Scholar link and name/logo; other uses require an expanded license. Product-release use is therefore an open licensing gate.
