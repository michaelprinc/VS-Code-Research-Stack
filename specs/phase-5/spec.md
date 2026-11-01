# Phase 5 stabilization and continuous research workflow specification

Revision: 0.3.5-preview. Status: planned. Input: [Research Stack Toolkit v0.3.4 Quality and Development Review](../../../docs/Research-Stack-Toolkit-v0.3.4-Quality-Report-2026-10-31.md) (findings F01–F18) and [analysis-0.3.4/IMPLEMENTATION-REPORT-0.3.4.md](../../../analysis-0.3.4/IMPLEMENTATION-REPORT-0.3.4.md). Tracker: [tasks.md](tasks.md), [design.md](design.md), [acceptance.md](acceptance.md), per-topic checklists in [checklists/](checklists/).

## Objective

Turn the v0.3.4 preview into a dependable preview: make the installed state observable, repairable and upgradeable; make the evidence trail durable across source changes, duplicates and empty files; and give the Full package one continuous **read → index → retrieve → record → report** workflow inside the existing tool budget. New infrastructure (vector search, DuckDB/Qdrant, browser and institutional connectors, saved literature sessions, Zotero discovery) stays out of scope until a measured need exists.

Gates G1–G4 stay open. Setup completeness and gate status stay separate lines.

## Scope decision (from the review's recommended sequence)

| Stage | In 0.3.5 | Out of 0.3.5 (recorded as a gap) |
|---|---|---|
| A — stabilize install + store | F01–F09, F12–F15 correctness, repaired acceptance tests | Multi-window journal/power-loss acceptance |
| B — one continuous research task | Coherent Full preset, bounded text/evidence resolver, validated claim→report export, DOCX order, document range navigation | Extraction→index bridge for PDF/DOCX (design recorded, not shipped) |
| C — reproducible Recommended | Provider state correctness, centralized request policy, bibliographic field comparison | Saved/paged search manifests, screening records, Zotero item discovery/paging, real kernel receipt |
| D — measured retrieval scale | Regression probes become tests | Labeled corpus benchmark, embeddings/hybrid, DuckDB/Qdrant |

## Requirements

### Store integrity and evidence durability

| ID | Requirement | Finding | Acceptance |
|---|---|---|---|
| R5-01 | One containment policy guards every toolkit-owned write (store directory, store file, backup directory, lab-state file, notebook environment, CLI destinations): absolute paths, traversal, symlinks, Windows junctions and reparse points are refused **before** the write, and re-checked at the write boundary. | F01 | T5-01 |
| R5-02 | Re-indexing never destroys evidence a claim still references. Current index membership is separate from retained evidence; retained chunks keep their source version, locator and text. | F02 | T5-02 |
| R5-03 | Every evidence link reports resolvability and freshness (`resolvable`, `current`, `stale`), so a claim can never read as `supported` over deleted evidence without a visible flag. | F02 | T5-02 |
| R5-04 | Identical content at two paths indexes successfully: chunk identity is per source occurrence, content identity is retained separately for deduplication. | F03 | T5-03 |
| R5-05 | A validated source inventory is kept independently of produced chunks: an empty or whitespace-only source replaces its previous index membership and returns an explicit empty-source outcome. | F04 | T5-04 |
| R5-06 | Backup reserves a unique destination exclusively, produces a consistent SQLite snapshot (safe while another client writes), validates integrity, and records schema version, counts and SHA-256. | F05 | T5-05 |
| R5-07 | Restore validates a backup, stages it as a candidate store, verifies the candidate, and only then activates it with explicit confirmation, preserving the previous live store. | F05 | T5-06 |
| R5-08 | Schema version is validated before any mutation: an unknown or newer schema is refused with an actionable error; a supported older schema is migrated explicitly. | F13 | T5-07 |
| R5-09 | Read paths open the store read-only and change no bytes; a preview neither creates a store nor writes. | F13 | T5-08 |
| R5-10 | Expected input and storage failures (missing source, constraint, busy, corrupt) are translated into the advertised stable error envelope rather than a generic protocol error. | F13 | T5-09 |
| R5-11 | Claim discovery filters in SQL before limiting, and supports cursor pagination over the whole store. | F14 | T5-10 |
| R5-12 | Claim creation is collision-safe (same statement in the same second) and supports an explicit idempotency key that returns the existing claim. | F14 | T5-11 |
| R5-13 | Evidence links carry a role (`supporting`, `contradicting`, `contextual`) and rationale, can be replaced or removed, and claim edits are recorded as an event history. | F02, F14 | T5-12 |
| R5-14 | `supported` is reported as a recorded assessment, never as proof; the store states that it does not verify scientific claims. | F14 | T5-12 |

### Setup, upgrade and repair lifecycle

| ID | Requirement | Finding | Acceptance |
|---|---|---|---|
| R5-15 | One dependency resolver serves every entry point (command, panel button, Quick Pick, per-component install): the dependency closure is expanded, already-satisfied prerequisites are accepted, and only steps needing work run. | F06 | T5-13 |
| R5-16 | Step status separates recorded installation, observed artifacts, verification result and file compatibility. A recorded-current step whose artifacts are missing is reported as needing repair and repair is offered. | F07 | T5-14 |
| R5-17 | Preserved overlay files are classified `current` or `modified-preserved`; a step never reports upgrade completion over an incompatible asset, and modified files are never overwritten. | F07 | T5-15 |
| R5-18 | Optional steps are reported as deliberate omissions, not as unmet required steps. | F07 | T5-14 |
| R5-19 | A quick status refresh re-reads the plan receipt and re-verifies artifacts without running the functional MCP check; the functional check stays a separate action. | F07 | T5-16 |
| R5-20 | Setup discovers receipts recorded by earlier toolkit releases, stages the new runtime as a candidate, verifies it, and activates it through one atomic record; the previous verified runtime stays usable and rollback is offered. | F08 | T5-17 |
| R5-21 | The notebook step identifies project ownership before running package management: an unrelated or incompatible project is not synced, a compatible existing project is reported as such, and the reviewed interpreter plus required imports are verified. | F09 | T5-18 |
| R5-22 | Receipts are written atomically (validated temp file plus rename) and the setup lock covers the whole multi-step plan. | F01, review §6.4 | T5-19 |
| R5-23 | Derived research data (store, backups) is declared in the workspace ignore rules and explained, so copied source text is not silently shareable. | review §6.5 | T5-20 |

### Continuous research workflow and tool surface

| ID | Requirement | Finding | Acceptance |
|---|---|---|---|
| R5-24 | The Full package offers one preset that can read a source, index it, retrieve a passage, resolve that evidence, record a claim and export a report, within the C-13 budget (≤12 toolkit tools, ≥20 headroom). | F10 | T5-21 |
| R5-25 | Preset labels, goals and tips describe the tools actually enabled; a preset that omits the corpus/claims tools says so. | F10 | T5-21 |
| R5-26 | A notes/corpus hit can be reopened: a bounded text reader accepts the returned locator and returns the passage plus adjacent context. | F16 | T5-22 |
| R5-27 | Evidence can be resolved by chunk id through MCP, and claim reads hydrate source path, text hash and freshness. | F16 | T5-23 |
| R5-28 | Report writers validate citations: a source needs a well-formed SHA-256, a workspace path is checked for existence and hash match, and unresolved evidence is refused rather than printed. | F16 | T5-24 |
| R5-29 | Claims and evidence can be exported into a report's reference list from the store, and Markdown and DOCX render one shared report model (headings, lists, tables, citations). | F16 | T5-24 |
| R5-30 | Document reading reports coverage honestly: range navigation, total items/pages, and explicit truncation indicators. | review §4 | T5-25 |
| R5-31 | Tool annotations match actual effects: `index_corpus` remove mode is destructive, `store_maintenance` is split where approval semantics differ, network tools are open-world, and read tools do not write. | review §6.6 | T5-26 |

### Extraction and metadata correctness

| ID | Requirement | Finding | Acceptance |
|---|---|---|---|
| R5-32 | DOCX body blocks are extracted in document order with table/row locators. | F15 | T5-27 |
| R5-33 | DOI normalization preserves balanced identifier punctuation and separates citation delimiters from DOI content. | F15 | T5-28 |
| R5-34 | Merging retains every distinct value and its provenance under a documented selection rule; no provider observation disappears. | F15 | T5-29 |
| R5-35 | Derived scope and access are recomputed after a merge, so a merged abstract changes `evidenceScope`. | F15 | T5-29 |
| R5-36 | Malformed provider rows are isolated with a warning instead of aborting an otherwise useful result. | F15 | T5-30 |
| R5-37 | Provider outcomes distinguish unavailable/error, genuinely empty success, partial success and complete success. | F15 | T5-31 |
| R5-38 | Search and DOI lookup share one request policy (configured Crossref headers, pacing, timeouts). | review §6.1 | T5-31 |

### Client state, UI and release evidence

| ID | Requirement | Finding | Acceptance |
|---|---|---|---|
| R5-39 | The MCP definition version carries the runtime **and** the effective preset/tool-surface identity, so a preset change signals a tool refresh. | F11 | T5-32 |
| R5-40 | Saved versus applied preset state is visible, and switching a preset is reported as applied or pending. | F11 | T5-32 |
| R5-41 | One user action produces exactly one control-panel message; setup/update buttons do not also emit a generic action message. | F12 | T5-33 |
| R5-42 | Measured state is bound to the selected folder/runtime; changing folder clears prior measurements, and partial coverage is labelled as mixed, not measured. | F17 | T5-34 |
| R5-43 | External-server tool counts are labelled as vendor estimates, never as observed session totals. | F17 | T5-34 |
| R5-44 | Preset scope is honest: configuration is read and written with the selected workspace folder when a folder override is promised, and recently used presets are ordered first in the Quick Pick. | F17 | T5-35 |
| R5-45 | Acceptance tests assert the current release and the current plan shape; Windows boundary fixtures work without elevated symlink privileges. | F18 | T5-36 |
| R5-46 | Documentation states the current version, the preset dependency of the corpus tools, and keeps historical status explicitly historical. | F18 | T5-37 |

## Non-negotiable invariants retained

- C-13 tool budget: ≤12 toolkit tools per preset, ≥20 tools of headroom under the 128-tool client ceiling.
- Source files are read only; toolkit-owned writes stay inside the selected workspace.
- No network calls, downloads or service starts during activation or component checks (setup is explicit).
- Existing user files, project environments and MCP configuration are preserved; nothing is silently overwritten.
- Preview status stays visible: G1–G4 remain open and unpassed.

## Out of scope for 0.3.5

Vector/hybrid retrieval, embedding models, DuckDB, Qdrant, Playwright/institutional connectors, saved literature search sessions, Zotero item discovery and import preview, automatic Zotero writes, multi-window journaling/power-loss acceptance, real reference-host receipts (still outstanding and recorded as such).
