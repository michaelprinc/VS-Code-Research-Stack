# Phase 3 Full / Research Lab task breakdown

Revision: 0.1.0. Status: prototype foundation; dependency gate G2 remains open.

| ID | Work | Deliverable | State |
|---|---|---|---|
| M3-01 | Freeze spec, resources, immutable English/Czech corpus and labeled queries; resolve ADR-008–011 | Spec, fixture hashes, decisions | Partial: contracts/ADRs documented; corpus and G2 receipts pending |
| M3-02 | Preflight local service route; pin Qdrant/client; verify ownership, loopback binding, persistence and restart | Service recipe, lock and receipts | Not started: service not available on loopback |
| M3-03 | Review and pin CPU embedding/tokenizer artifacts; validate preprocessing, dimensions and resources | Model lock and runtime receipt | Not started |
| M3-04 | Add source/chunk schema, parser provenance, DuckDB owner and journal/reconciliation | Data layer and recovery receipts | Partial: deterministic Markdown identity prototype only |
| M3-05 | Implement BM25/vector/hybrid and freeze retrieval benchmark | Benchmark and quality report | Partial: lexical BM25 prototype only |
| M3-06 | Add Research-RAG MCP, bounded evidence/claim operations and editor workflow proof | MCP tools and VS Code receipt | Not started |
| M3-07 | Evaluate an optional Playwright path and each selected institutional provider separately | Capability-specific ADR/receipt | Deferred; none selected |
| M3-08 | Validate backup/restore, migrations, reindexing and failure recovery | Runbook and fault-injection receipts | Not started |
| M3-09 | Run Full acceptance, Basic/Research regression, second-host reproduction and G3 review | Completed checklist and gate report | Not started; G2 prerequisite open |

## Immediate next steps

1. Close G1 and G2 using their existing reports and actual VS Code/Zotero/provider receipts.
2. Record a bounded Windows preflight including Docker context/backend, existing containers/volumes, RAM and free space without changing them.
3. Acquire or author a licensed/synthetic English/Czech fixture set; freeze document and relevance-label hashes before scoring models.
4. Decide/review ADR-008–011, including artifact license and settings/security boundaries.
5. Implement and validate parser/source inventory, owned DuckDB worker and ingestion journal before adding vectors.
6. Pin a Qdrant image digest and CPU model revisions; validate vectors/service on a named persistent volume.
7. Add hybrid retrieval, MCP, recovery, benchmarks and editor proof, then close each mandatory gate with linked evidence.

Do not install or start services/models until the preflight and artifact/license preview are recorded. Do not claim a Phase 3 or Phase 4 compatibility lock from candidate versions alone.
