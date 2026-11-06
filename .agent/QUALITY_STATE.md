# Quality state — Research Stack Toolkit 0.3.9 (direct PDF/DOCX ingestion, freshness, migration, topic skill bundles)

Objective: implement the 0.3.9 brief — index text-bearing PDF and DOCX into the local SQLite/BM25 research
store with original-document provenance; separate the indexed version from the present file (freshness,
transactional reindex, historical claim-linked chunks, tested 2→3 migration with backup/rollback on copies
of real 0.3.8 stores); ship a reviewed topic skill-bundle catalog with a staged, hash-verified install flow
and receipts; ship the theological-research PoC 2.0 as the first bundle with its adaptations and hashes
recorded; prove all of it on this container and say plainly what was not proven here.

Plan of record: [specs/phase-9-document-ingestion/](../specs/phase-9-document-ingestion/) —
[spec.md](../specs/phase-9-document-ingestion/spec.md) (findings D9-01…D9-18, requirements R9-01…R9-22),
[design.md](../specs/phase-9-document-ingestion/design.md) (DD9-01…DD9-24),
[acceptance.md](../specs/phase-9-document-ingestion/acceptance.md) (T9-01…T9-50),
[tasks.md](../specs/phase-9-document-ingestion/tasks.md).
Release report: [implementation-report-0.3.9.md](../docs/implementation/phase-9-document-ingestion/implementation-report-0.3.9.md).
Bundle record: [bundle-notes.md](../docs/implementation/phase-9-document-ingestion/bundle-notes.md).
Receipts: [evidence/quality-v0.3.9-2026-11-06/](../evidence/quality-v0.3.9-2026-11-06/README.md).
Audits: `.agent/0.3.9/A-python-core.md`, `B-extension-packaging.md`, `C-theology-bundle.md`.
The 0.3.8 state is kept at [.agent/0.3.8/QUALITY_STATE-0.3.8.md](0.3.8/QUALITY_STATE-0.3.8.md).

Status: **0.3.9 implemented, packaged and audited on this Linux development host.** Gates G1–G4 remain
open, as they were for 0.3.6–0.3.8. A live Windows VS Code / Copilot session is **not accessible from this
container** and nothing here claims one.

## What is proven (measured, not assumed)

- **Suites**: Python **257 passed, 1 skipped**; Node **355 tests, 355 pass, 0 fail, 0 skipped** (17 files).
  The packaged-artifact gate in `extension/test/hosttools.test.js` ran instead of skipping, because a 0.3.9
  artifact now exists. Receipts: `python-suite.txt`, `node-suite.txt`.
- **Artifact**: `dist/research-stack-toolkit-0.3.9.vsix`, 101 members, 400 486 bytes, unpacked
  **1 216 022** of the reviewed **1 310 720** ceiling (94 698 headroom), SHA-256
  `d5fe4675b4a9f3d1e489cfdff28ea1f8e4bc67ae05e7720db008dbc33f698ee4`; `sourceFilesMatch: true`;
  `npm run check:payload` → `result: passed`. Receipts: `vsix-audit.json`, `payload-check.json`, `package.txt`.
- **Two reviewed bundles ship**: `theological-research` 2.0 (11 files, 60 825 bytes, licence unresolved) and
  `document-corpus-bridge` 2.0 (1 file, 6 972 bytes, toolkit-authored, repository UNLICENSED). Both
  `publishable: false`. Catalog: 12 files, 67 797 bytes.
- **Chunk identity is unchanged for Markdown/text**: `tests/test_ingestion.py` recomputes the 0.3.8
  `chunk_id` / `content_id` formula independently of the module and asserts equality.
- **A real 0.3.8 store**: `tests/test_migration.py` exports `v0.3.8` with `git archive`, runs **that** code to
  build the store, then opens it with 0.3.9 — read refused with `STORE_SCHEMA_UPGRADE_REQUIRED`, component
  step migrates to 8 tables, chunk ids survive, migrated row `legacy`/`unchecked`/`last_verified_at = NULL`;
  backup works on the unmigrated file; restore stages and only `confirm=true` activates.
- **Freshness through real stdio MCP**: `extension/functional_check.py` calls `verify_sources` over the MCP
  client, confirms the indexed source, then reports it `changed` after the file is edited under the index
  (`freshnessVerified: true`, `changedSourceDetected: true`).
- **Bundle flow through the shipped module**: `extension/test/bundles.test.js` (18 cases) plus
  `bundle-install-proof.json` — 11 installed, second install writes 0, an operator edit is `user-modified`
  and left alone, repair reports the drift and reinstalls 10.
- **Release identity**: six sources read 0.3.9; `uv.lock` re-locked with pinned uv 0.13.6 (one line,
  `0.3.8 → 0.3.9`, 40 packages and 39 pins unchanged); `lockintegrity-cli.json` reports `"problems": []`.

## Defects found by the gates during this release, and fixed

1. `extension/bundles.js` was not staged by `extension/scripts/package.js`: the packaged controller failed
   to load with `Cannot find module './bundles'`. `check:payload` caught it; the audit inventory went 99 → 100.
2. `planInstall` reported every file as `new` when the caller supplied no hashes — the control panel is such
   a caller. It now observes the workspace itself when no hashes are handed in.
3. `scripts/check-installed-payload.js` still asserted the 0.3.8 surface (19 tools, 25 commands, 10-tool
   corpus preset); now 20 / 30 / 11, each with the reason beside it.
4. `tests/test_vsix.py` hard-coded `worker-0.3.8` in its stale-documentation fixture; the fixture now derives
   the version from `extension/vsix-manifest.json`.
5. Two packaged guides understated the store (schema 2 / seven tables / five verbs; no `verify_sources`, no
   PDF or DOCX). Both now describe 0.3.9.
6. An authored overlay template (`document-corpus-bridge`, 5 November) was skipped by every gate and its text
   was already false for 0.3.9. It is now a reviewed bundle with corrected text (DD9-23), and
   `scripts/build_worker_bundle.py::assert_overlay_tree_is_reviewed` refuses a build when the overlay tree
   holds a template the allowlist does not name.

## Open, in order of value

1. **Publication licences.** `theological-research` is unresolved — author consent is required.
   `document-corpus-bridge` is toolkit-authored but the repository is UNLICENSED. Both are `publishable: false`
   and enforced by the generator, the reader and the VSIX audit. These are human decisions, not code fixes.
2. **No Windows 11 / VS Code / Copilot pass.** Install the VSIX, run the control panel, install a bundle in a
   real workspace, record whether the assistant discovers the skill. `hostDiscoveryVerified` and
   `workflowTested` are `false` in every receipt, with reasons.
3. **The reading check does not index a PDF or DOCX end to end** — it indexes a Markdown fixture and verifies
   it. PDF/DOCX are proven by the Python suite only.
4. **`references/theology-and-social-sciences.md` still says "Anchors verified in this session"** — recorded
   in bundle-notes.md, not edited.
5. **`dedupe_records.py` drops records at 0.92 title similarity** — now reported on stderr, report unbounded.
6. **`evals.json` has never been scored**; the bundle's `USER_AGENT` carries a placeholder contact address.
7. **T8-18** (the 0.3.8 field re-run) is still open.

## Decisions taken in this release

- **Non-negotiable**: existing chunk identity never changes. `paragraph-window-v1` stays byte-compatible; PDF
  and DOCX get their own chunker ids (`pdf-page-window-v1`, `docx-item-window-v1`).
- Migration is additive `ALTER`s only; migrated rows are labelled `legacy`/`unchecked`, never back-filled;
  reads never migrate.
- Partial acceptance is opt-in (`accept_partial`); a partial or failed read never replaces an indexed version.
- One index call is one transaction and leaves exactly one `index_runs` row, including a cancelled run.
- Bundles ship at `extension/bundles/` as a separate audited payload group; the worker overlay allowlist
  (`.github/skills/<id>/SKILL.md`) was **not** widened.
- The unpacked ceiling moved 1 048 576 → 1 310 720 with the measured numbers beside the constant; the
  measured 1 216 022 replaced the projected 1 141 977 in the record.
- **Install is allowed while publication is not.** The panel shows the licence status in the confirmation and
  the receipt records it; `publishable: false` blocks publication and the audit's publication claim, not a
  local install of files the operator already owns in their own template tree.

## Next highest-value action

Nothing further can be proven for 0.3.9 inside this container. The next value is outside it: author consent
for the bundle licence, and a Windows 11 / VS Code / Copilot pass against
`dist/research-stack-toolkit-0.3.9.vsix` recorded as a new evidence folder. Inside the repo, the remaining
code-level items are the bundle reference note (open item 4) and `dedupe_records.py` (open item 5).
