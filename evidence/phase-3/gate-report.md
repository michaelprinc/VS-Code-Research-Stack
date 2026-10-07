# Phase 3 implementation evidence report

Date: 7 October 2026

Implementation: Phase 3 Full / Research Lab prototype foundation, revision 0.1.0

Outcome: **partial foundation implemented; G3 not passed**

Prerequisites: **G1 and G2 remain open**. See [Phase 1](../phase-1/gate-report.md) and [Phase 2](../phase-2/gate-report.md).

## Implemented in this repository revision

| Area | Evidence | Result |
|---|---|---|
| Phase contract | `specs/phase-3/{spec,design,tasks,acceptance}.md` | Core/conditional scope, source identity, proposed API and G3 decision rule recorded; candidates clearly distinguished from supported components |
| Architecture decisions | [ADR-008](../../docs/implementation/decisions/ADR-008-duckdb-single-owner.md) through [ADR-011](../../docs/implementation/decisions/ADR-011-browser-and-institutional-capabilities.md) | DuckDB, local Qdrant, CPU embedding and optional connector choices recorded as unvalidated candidates |
| Source/chunk provenance | `src/research_stack/full.py`; `tests/test_full.py` | UTF-8 Markdown, immutable SHA-256 source versions, deterministic chunk IDs/locators and repeat-import identity |
| Lexical retrieval baseline | `src/research_stack/full.py`; `tests/test_full.py` | Standard-library Unicode tokenizer and deterministic BM25 results carry source/version/chunk evidence links |
| Dependency boundary | Phase 3 prototype imports only Python standard library | No vector service, model download or added dependency required for this prototype |
| Existing profile regression | Phase 1/2 tests | Run in the same verification invocation; results recorded with the commit |

## Reference-host observations

- Windows 11 Pro build 26300 was reported by the local OS inventory.
- Docker CLI client and server both reported `29.7.2`; this does not prove the Full service deployment route.
- Docker selected the `desktop-linux` context. The host reported approximately 95.3 GiB RAM and 469.9 GiB free on the K: project volume at inspection time; these values do not establish Docker's data-volume free space or model fit.
- The Docker engine already contains unrelated running containers and named volumes. They were inspected read-only and left unchanged; none was adopted for Research Stack.
- No Qdrant response was received from `127.0.0.1:6333` within the probe timeout.
- No Qdrant-specific running container, image or volume was observed in the inspected Docker inventory. The checkout contains no Qdrant image digest, model revision, licensed corpus or frozen query/relevance set.
- Docker Desktop's data-root capacity and ownership policies, model artifact sizes/license, and workload resource impact remain to be established before provisioning.
- macOS, VS Code Full MCP discovery, embedding/vector retrieval, DuckDB persistence, browser/provider options and backup/restore remain untested.

## Explicit non-claims and blockers

The prototype is not a Full installation. It supports only caller-selected UTF-8 Markdown/text files and in-memory lexical search. It has no PDF/DOCX parser integration, persistent index, Qdrant, embeddings, vector/hybrid retrieval, DuckDB, journal/outbox, claims API, MCP tool, model assets, benchmark fixture, clean-host reproduction or G3 acceptance evidence. It has not established retrieval quality or target-machine resource fit.

G1 and G2 are not passed, so M3-01 cannot be considered complete and Full implementation remains gated. Do not advertise Research Lab/Full as supported or package candidate services/models in the Phase 4 VSIX on this evidence. Complete the blocked prerequisites and service/resource/license review in `specs/phase-3/tasks.md` before provisioning local services or downloading model assets.

## Verification

The implementation was checked with the repository's locked Python environment: **27 tests passed**, including Basic/Research regression and the new Phase 3 unit fixtures. JSON catalog/settings contracts parsed and `git diff --check` passed. Test success establishes deterministic prototype behavior only and does not close G3.

## Decision

Continue Phase 3 as an implementation prototype. G3 stays pending until mandatory F-01–F-07 and F-11–F-13 have matched runtime/data/recovery/editor receipts, inherited Basic/Research regression passes, and the locked Full core reproduces on a second clean host. Optional browser or institutional support remains capability-specific.
