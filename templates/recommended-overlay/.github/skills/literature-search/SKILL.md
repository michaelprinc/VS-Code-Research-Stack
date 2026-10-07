---
name: literature-search
description: Search scholarly metadata through selected providers and report identity, provenance, limits, and unresolved access.
---

# Literature search

- Ask for the topic, date range, language or other inclusion filters when they materially change the query.
- Select OpenAlex, Crossref, Semantic Scholar, or all; use bounded result counts and report which providers succeeded.
- Keep provider IDs, normalized DOI, query hash, and field provenance with each candidate.
- Preserve provider attribution in exported records. For public Semantic Scholar data displays, include the returned Semantic Scholar link with `utm_source=api` and the required Semantic Scholar name/logo; do not publish S2 data through this prototype unless the current API license permits that use.
- Merge records only on an exact normalized DOI. Keep preprint and published versions distinct unless an explicit relation is present.
- Distinguish an empty successful response from authentication failure, rate limit, outage, timeout, and partial provider results.
- Treat returned abstracts as provider metadata, not as full-text evidence. A reported PDF URL is not proof of permission or a license.
