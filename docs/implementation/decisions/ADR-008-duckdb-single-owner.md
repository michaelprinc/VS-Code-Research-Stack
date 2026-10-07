# ADR-008: DuckDB persistence owner for Full

Date: 7 October 2026. Status: candidate decision; G3 acceptance pending.

## Context

Full research records need durable source versions, ingestion runs, claims, evidence links and migration manifests. Phase 3 adds Qdrant as a separate vector store, which cannot participate in a DuckDB transaction. Notebook/editor processes must not introduce competing writes.

## Decision

Use embedded DuckDB behind one owning Full worker as the candidate architecture. Route writes through that worker; offer only a reviewed read-only or portable export interface to other processes. Pair DuckDB mutations with a durable outbox/journal and idempotent vector operations. Do not expose arbitrary SQL through MCP. Record source hashes, parser/chunker fingerprints, locators, claim review status and evidence relationship type.

## Consequences and limits

This avoids a separate database service and keeps settings portable. It requires explicit owner lifecycle, busy/error behavior, consistent backup/restore and cross-store reconciliation. Official DuckDB documentation describes its read-write concurrency within one process and distinguishes multi-process writing; the single-owner proposal must still be validated with the selected worker design ([concurrency model](https://duckdb.org/docs/stable/connect/concurrency.html)). No DuckDB database or migration is implemented by this ADR. Revisit if multi-process writes become a requirement.

## Required G3 evidence

Concurrent-reader/write behavior, worker death and replay, journal reconciliation, portable export/reload, consistent backup and restore into a separate root, and claim/evidence referential integrity.
