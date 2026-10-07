# ADR-007: Read Zotero locally; make imports explicit and user-mediated

Date: 7 October 2026. Status: accepted for the Phase 2 prototype; real desktop-version round trip remains pending.

## Context

The Phase 2 workflow needs bibliography context without taking ownership of the user's library/database. Current Zotero documentation describes a local HTTP API on loopback, with unauthenticated reads and version-dependent write authorization.

## Decision

Read only from the fixed `http://localhost:23119/api/` endpoint. Do not forward the port, inspect/copy the SQLite database, or issue any HTTP write method. Prepare new RIS files under `research/imports/`; the user reviews them and performs an import through Zotero's own UI, first into a disposable collection. Remote Zotero API mode is excluded from this prototype.

## Consequences

- The library stays under Zotero's management; the adapter only reads collections/items.
- Local API disabled/unavailable is a distinct diagnostic and never triggers a database fallback.
- Duplicate policy is visible and remains a human decision; round-trip/duplicate fixtures are required before G2.
- Zotero is not installed on the current reference host, so only fake-server acceptance is possible here.

## Reviewed upstream source

- [Zotero Local API documentation](https://www.zotero.org/support/dev/web_api/v3/local_api).
