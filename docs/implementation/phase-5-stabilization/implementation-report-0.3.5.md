# Research Stack Toolkit 0.3.5 — implementation report

Recorded: 31 October 2026 (Europe/Prague), Linux development host.
Input: [Research Stack Toolkit v0.3.4 — Quality and Development Review](../../../../docs/Research-Stack-Toolkit-v0.3.4-Quality-Report-2026-10-31.md) (findings F01–F18).
Plans: [specification](../../../specs/phase-5/spec.md) · [design](../../../specs/phase-5/design.md) · [tasks](../../../specs/phase-5/tasks.md) · [acceptance cases](../../../specs/phase-5/acceptance.md) · [six phase checklists](../../../specs/phase-5/checklists/).
Receipts: [evidence/quality-v0.3.5-2026-10-31/](../../../../evidence/quality-v0.3.5-2026-10-31/README.md).

**Scope of this release.** 0.3.5 is a stabilization release, not a new profile. It closes the review's
Stage A findings, makes the shipped Full slice behave as one continuous workflow, and turns every review
probe into a permanent regression test. It does not open, advance or close any gate: **G1, G2, G3 and G4
remain open**, and the reference-host receipts for 0.3.5 are still outstanding.

## 1. Result at a glance

| Measure | 0.3.4 baseline | 0.3.5 now |
|---|---|---|
| Python tests | 70 | **105 collected / 105 pass / 0 fail** |
| Node tests | 37 | **43 pass / 0 fail** |
| Managed MCP verbs | 14 tools (5 + 5 + 5, plus a legacy alias) | **19 preset-selectable tools** (5 document + 5 metadata/Zotero + 9 record store); the functional check measures **20 definitions** at the unmanaged `all` preset, which still registers the deprecated `search` alias |
| Presets | 8 | **9**, with `research-workflow` (11 tools) as the Full default |
| MCP definition version | toolkit version only | `0.3.5+<presetId>:<12-hex tool-surface hash>` |
| Review probes that recorded a defect | 26 | **0** — all re-run and now record the corrected behaviour |
| Packaged artifact | `research-stack-toolkit-0.3.4.vsix` | `research-stack-toolkit-0.3.5.vsix`, 251,723 bytes, sha256 `b4d0b10f244830cb6c736460535b606202ca16b1b10f23d7b8589e80bceb6b52` |

## 2. Updated features

### 2.1 The record store is safe to keep (F01–F05)

- One containment policy (`src/research_stack/paths.py`) guards every toolkit-owned write: store directory,
  store file, backup directory, lab-state record, report outputs and CLI bootstrap destinations. Symlinks,
  Windows junctions and reparse tags are refused **before** the write and re-checked at the write boundary
  (`PATH_IS_LINK`).
- Schema version 2 with seven reviewed tables (`meta`, `sources`, `source_versions`, `chunks`, `claims`,
  `claim_evidence`, `claim_events`). A newer schema is refused (`STORE_SCHEMA_UNSUPPORTED`), an unreadable
  one is refused (`STORE_SCHEMA_UNKNOWN`), and a version-1 store is migrated explicitly. A file that is not
  a database is reported as `STORE_CORRUPT`, not as a driver error.
- Re-indexing an emptied source retires its chunks and reports `emptySources`. Re-indexing or
  `unindex_corpus` never deletes evidence a stored claim cites: the chunk is retained
  (`retainedEvidenceChunks`) and the link reports `resolvable: true`, `current: false`, `stale: true`.
- Identical bytes at two paths index as two traceable occurrences (distinct `chunk_id`, equal `content_id`).
- `backup` uses SQLite's online backup API, runs `PRAGMA quick_check`, records sha256 and counts, and never
  overwrites (`writeMode: "new-file-only"`). `restore` stages a validated candidate and only activates it on
  confirmation, preserving the previous store as `research-pre-restore-*`. `vacuum` still requires a prior
  `store_status` review plus an explicit confirm. A locked store returns `STORE_BUSY`.
- Reads use a read-only connection; `reindex_preview` writes nothing and creates no store.

### 2.2 Claim records that survive editing (F04, F13)

- `claims_read` filters in SQL before applying its limit, pages with a keyset cursor (`nextCursor`,
  `matchingClaimCount`), and returns each claim's edit history from `claim_events`.
- `claims_write` with an existing `claim_id` patches that claim; an `idempotency_key` makes a retried write
  return the original instead of a duplicate. Evidence links carry `role` and `rationale` and are reconciled
  against the index on every write.
- New verbs: `unindex_corpus`, `evidence_read`, `claims_export`, `store_status`. `claims_export` emits a
  report reference only when the cited file still exists with the recorded hash. Read-only and destructive
  annotations now match real effects.

### 2.3 Extraction and citation integrity (F14–F16)

- DOCX extraction walks `document.element.body`, so a paragraph/table/paragraph document comes out in that
  order with table-row locators.
- `read_text_source` is a shipped tool: a `search_corpus` or `search_local_text` hit can be reopened by
  locator with adjacent context. Range navigation reports `coverage`; a locator that no longer matches the
  file returns `LOCATOR_STALE`.
- `validate_sources` verifies each path inside the workspace and its recorded hash before any report is
  written (`SOURCE_HASH_INVALID`, `SOURCE_NOT_FOUND`, `SOURCE_HASH_MISMATCH`, `SOURCE_OUTSIDE_WORKSPACE`);
  `resolve_evidence` fails closed with `EVIDENCE_UNRESOLVED`.
- Markdown and DOCX reports are rendered from one shared block model, so both carry the same headings,
  bullets, numbered items and tables.
- DOI normalization keeps balanced punctuation (`10.1234/example(2026)` survives) while stripping citation
  delimiters. Crossref requests always send a `User-Agent` (`ResearchStack/<version>`, plus `mailto:` when
  `CROSSREF_MAILTO` is set) for search and citation validation alike. Provider rows that are not objects, or
  carry neither a title nor a DOI, are skipped and reported (`skippedRows`, `PROVIDER_ROW_SKIPPED`); null
  author lists no longer crash a provider. Total provider outage is `resultState: "unavailable"` with
  `providersAttempted`/`providersSucceeded`, distinct from `empty` and `partial`. Exact-DOI merging keeps
  every observation and conflict, recomputes derived fields, and reports `access { status, url, license,
  retrieved }` from the provider's open-access record.

### 2.4 Setup that reports what it actually did (F06–F12)

- A step is **installed** only while the files it produced are present. A recorded step whose artifacts are
  gone is **needs repair** and is re-run by **Update or repair component steps**. An optional step that was
  never installed is a **deliberate omission**, reported separately from a missing requirement; an optional
  step an earlier release installed is still reported with its real status.
- A step that needs another step pulls the prerequisite closure in and explains why
  (`explainStepSelection`) instead of failing the click.
- The setup receipt and the active-runtime pointer are written atomically (temp file + rename, JSON
  validated before publishing); one `.setup.lock` covers the whole plan.
- Overlay files are classified on re-run as `created | current | modified-preserved`; a hand-edited file is
  preserved byte-for-byte and the step does not claim a clean upgrade.
- The notebook step identifies project ownership before any package manager runs: the reviewed
  `research-stack-analysis` project is owned and synced; a project that declares `ipykernel` and
  `matplotlib` under another name is accepted and reported as a **compatible existing project**; anything
  else is refused with the reason. A linked `pyproject.toml` or linked `.venv` is refused. After syncing, the
  step verifies that the environment's own interpreter imports `ipykernel` and `matplotlib` and records the
  interpreter version.
- New commands: **Refresh Component Status** (re-reads the plan and re-verifies produced files, and states
  that the functional MCP check was not run) and **Roll Back Managed Runtime** (lists the managed runtimes,
  re-verifies a candidate with the real reading check, then activates it). A previous release's runtime stays
  on disk and is discovered rather than orphaned.

### 2.5 One continuous Full workflow (F17)

- New **`research-workflow`** preset (11 tools) is the Full default: `read_document`, `read_text_source`,
  `search_local_text`, `write_markdown`, `write_docx`, `search_literature`, `check_citation`, `index_corpus`,
  `search_corpus`, `evidence_read`, `claims_read`, `claims_write`. `corpus-lab` now carries all ten
  record-store/document tools. No preset exceeds 12 toolkit tools; the widest (101 tools) keeps 27 tools of
  headroom under the 128-tool ceiling.
- The MCP definition version is `0.3.5+<presetId>:<tool-surface hash>`, so a preset change is visible to the
  client instead of being cached away. The panel distinguishes the preset you **saved** from the one currently
  **applied**, and the Quick Pick marks recent and applied presets.
- Context figures state their basis: **measured from this worker's `tools/list`**, **partial** (n of m
  measured), or **vendor estimate at 640 tokens per tool definition**.
- Panel buttons send exactly one message per click, each carrying a `requestId` that the extension echoes on
  the matching result, so a late answer cannot be shown as the result of a newer action. Steps needing repair
  are pre-selected; the update button counts outdated **and** repair-needed steps; the summary reports repairs
  and deliberate omissions; a workspace preset save is labelled with the scope it wrote.

### 2.6 Release hygiene (F18)

- Version 0.3.5 across `pyproject.toml`, `src/research_stack/__init__.py`, `extension/package.json`,
  `extension/vsix-manifest.json` and `extension/runtime.js` (`WORKER_FOLDER = .research-toolkit/managed/worker-0.3.5`).
- Current-facing docs, guides and the guide hub state 0.3.5 behaviour; `specs/phase-4`,
  `docs/implementation/phase-4-vsix` and `evidence/phase-4` are explicitly historical.
- The bootstrap workspace's `.gitignore` now ignores `.research-toolkit/store/`, `.research-toolkit/backups/`,
  `.research-toolkit/lab-state.json` and `.research-toolkit/managed/.setup.lock`.
- `scripts/verify_vsix.py` no longer hardcodes a release: it derives the expected extension and worker
  versions from the reviewed source and fails if they disagree.

## 3. Finding → change → evidence

| Finding | Change | Evidence (test / probe / receipt) |
|---|---|---|
| F01 containment | `paths.py` policy used by `records.py`, `workspace.py`, `mcp_server.py`; JS `runtime.isReparsePoint`/`assertRealPath` | `test_store_junction_…`, `test_backupDirectoryJunction_…`, `test_labStateJunction_…`, `test_cliJunction_…`, `test_workspace_path_policy_rejects_escape`, "linked managed directories cannot redirect installation outside the workspace" |
| F02 duplicate content | occurrence rows with shared `content_id` | `test_duplicateContent_indexes_identical_bytes_at_two_paths`; probe `duplicateContent` |
| F03 empty re-index | chunk retirement + `emptySources` | `test_emptyReindex_…`, `test_removeSources_retains_cited_evidence_and_collects_the_rest`; probe `emptyReindex` |
| F04 claim semantics | SQL filtering, keyset cursor, patch semantics, idempotency, roles/rationale, history | `test_claimFiltering_…`, `test_sameSecondClaim_…`, `test_claim_evidence_roles_modes_and_history`; probes `claimFiltering`, `sameSecondClaim` |
| F05 backup/restore | online backup + integrity check + staged restore | `test_maintenance_backs_up_new_files_only_…`, `test_restore_stages_a_candidate_then_activates_it_and_preserves_the_previous_store`; probe `backupCollision`; functional check staged restore |
| F06 dependency closure | closure expansion + explanation | "a component selection pulls in its prerequisites…", "runPlan runs missing steps in order…"; probes `quickPickStep`, `partialUpdate` |
| F07 artifact-aware status | `verifyStepArtifacts` + `needs-repair` | "the receipt distinguishes missing, installed and outdated steps…"; probe `repairAfterInterpreterRemoved` |
| F08 atomic receipt + lock | temp+rename, validated JSON, plan-wide lock | "a workspace setup lock blocks competing windows…", receipt ENOENT assertions |
| F09 notebook ownership | pre-sync classification + import verification | "the notebook step identifies project ownership before any package management"; probe `notebookVenvJunction` (win32) |
| F10 overlay honesty | `created / current / modified-preserved` | "overlay files are created once, hash-verified, and never overwrite project files"; probe `overlayConflict` |
| F11 runtime lifecycle | discovery, atomic pointer, verified rollback | "a runtime an earlier release installed is discovered, re-verified and can be rolled back to"; probes `legacyUpgradeDiscovery` |
| F12 status vs check | `researchToolkit.refreshComponentStatus` | installer GUI test assertions; installed-payload check |
| F13 lab surface separation | 9 annotated verbs | `test_the_shipped_lab_surface_is_nine_verbs…`, `test_unindex_corpus_is_the_destructive_verb…` |
| F14 DOCX order | body iteration | `test_docxOrder_extracts_body_blocks_in_document_order`; probe `docxOrder` |
| F15 reopen + coverage | `read_text_source`, `coverage`, `LOCATOR_STALE` | `test_notesReopen_reads_a_text_hit_with_adjacent_context`, `test_document_range_navigation_reports_coverage`; functional check reopen |
| F16 citation + provider hygiene | hash validation, DOI rules, provider isolation, result states | `test_unvalidatedCitation_…`, `test_doi_keeps_balanced_punctuation…`, `test_providerNullAuthors…`, `test_malformed_provider_rows…`, `test_allProvidersFail…`, `test_merge_keeps_every_provider_observation…`, `test_crossref_validation_uses_the_same_identifying_headers…` |
| F17 preset identity | `research-workflow` default, definition fingerprint, saved vs applied, measurement basis | `test_the_registry_labels_match_the_tools_they_enable`, runtime version-regex test, probes `presetIdentity`, `fullDefaultModules`, `folderSwitch`, `presetScope` |
| F18 hygiene | versions, docs, ignore rules, current assertions | `test_the_bootstrap_workspace_ignores_every_derived_record_store_path`, guide/README 0.3.5 statements, suite assertions on 0.3.5 |

## 4. Acceptance walk (T5-01 … T5-37)

Status legend — **verified here**: executed on this host with recorded output. **Partial**: a documented
sub-case is not exercisable on this host. **Not verified here**: needs the reference host.

| Case | Status | Evidence |
|---|---|---|
| T5-01 Containment | Partial | Store, backups, lab-state and CLI destinations verified with symlinks; Windows junction fixtures and the notebook `.venv` junction need a `win32` host |
| T5-02 Evidence durability | Verified | `test_danglingEvidenceAfterReindex_…`; probe shows `resolvable/current/stale` |
| T5-03 Duplicate content | Verified | `test_duplicateContent_…` |
| T5-04 Empty source | Verified | `test_emptyReindex_…` |
| T5-05 Backup | Verified | `test_maintenance_backs_up_new_files_only_…`; probe `backupCollision` |
| T5-06 Restore | Verified | `test_restore_stages_a_candidate_then_activates_it_and_preserves_the_previous_store`; functional check stages without activating |
| T5-07 Schema lifecycle | Verified | `test_futureSchema_is_refused_before_any_mutation`, `test_schema_migration_from_version_one_preserves_the_index` |
| T5-08 Read-only reads | Verified | `test_readRepairsDatabase_leaves_the_file_byte_identical`, `test_previewOnFreshWorkspace_creates_no_store` |
| T5-09 Error envelope | Verified | missing source, mode/action mistakes, confirmation, and `test_a_locked_store_reports_STORE_BUSY_instead_of_a_raw_driver_error` |
| T5-10 Claim discovery | Verified | `test_claimFiltering_filters_before_limiting_and_pages_with_a_cursor` (cursor paging proven with `limit=1`; a 200-claim corpus was not generated) |
| T5-11 Claim identity | Verified | `test_sameSecondClaim_is_collision_safe_and_idempotent_retries_return_the_claim` |
| T5-12 Evidence semantics | Verified | `test_claim_evidence_roles_modes_and_history` |
| T5-13 Dependency closure | Verified | installer plan tests; probes `quickPickStep`, `partialUpdate` |
| T5-14 Artifact-aware status | Verified | installer test asserts `needsRepair` and `omittedOptional`; probe `repairAfterInterpreterRemoved` |
| T5-15 Overlay conflicts | Verified | overlay classification test; probe `overlayConflict` |
| T5-16 Status vs check | Verified | `refreshComponentStatus` output states the functional check was not run (installer test + payload check) |
| T5-17 Upgrade lifecycle | Verified | discovery of a `worker-0.3.3` runtime, one atomic active pointer, verified rollback, and a rollback candidate that fails the reading check without moving the pointer are all tested; the probe records that no active runtime is invented when no pointer record exists |
| T5-18 Notebook ownership | Verified | three-case test (reviewed / refused / compatible existing) plus the linked-`pyproject` case; end-to-end sync of a compatible custom project is exercised only through the fixture runner |
| T5-19 Atomic state | Verified | atomic receipt assertions + setup-lock test |
| T5-20 Derived-data hygiene | Verified | `test_the_bootstrap_workspace_ignores_every_derived_record_store_path`, `test_init_lab_creates_the_store_and_records_only_what_exists` |
| T5-21 Continuous workflow | Verified | preset registry tests + payload check (`research-workflow` Full default, 11 tools, headroom) |
| T5-22 Notes reopening | Verified | documents test + functional check reopen through `read_text_source` |
| T5-23 Evidence resolution | Verified | `test_an_invented_evidence_id_is_refused…`, `test_export_claims_produces_validated_references…`; functional check `evidenceResolved` |
| T5-24 Report validation | Verified | `test_unvalidatedCitation_…`, `test_report_model_renders_the_same_structure_in_markdown_and_docx` |
| T5-25 Coverage honesty | Verified | `test_document_range_navigation_reports_coverage` |
| T5-26 Annotation audit | Verified | `test_the_shipped_lab_surface_is_nine_verbs_with_titles_annotations_and_cache_hints`; functional check `toolAnnotations` |
| T5-27 DOCX order | Verified | `test_docxOrder_…`; probe `docxOrder` |
| T5-28 DOI normalization | Verified | `test_doi_keeps_balanced_punctuation_and_strips_citation_delimiters` (`dx.doi.org` prefix not asserted explicitly) |
| T5-29 Merge retention | Verified | `test_merge_keeps_every_provider_observation_and_recomputes_derived_state` |
| T5-30 Malformed rows | Verified | `test_malformed_provider_rows_are_isolated_and_reported` |
| T5-31 Provider states | Verified | `unavailable` / `partial` / `empty` assertions + Crossref header test |
| T5-32 Preset identity | Verified | runtime test asserts `0.3.5+<preset>:<hash>`; probe `presetIdentity` shows the fingerprint changing |
| T5-33 Single dispatch | Verified | probe `setupButtonClickMessages` now records one message per click, each carrying a `requestId` that the extension echoes on the matching result; a unit test asserts the correlation |
| T5-34 Scope binding | Verified | probe `folderSwitch`; diagnostics test "changing selected folder discards a scan for the previous workspace" |
| T5-35 Preset scope | Verified | folder-scope save test + recent-preset ordering test; probe `presetScope` reports `workspaceFolder` |
| T5-36 Current acceptance tests | Partial | Node and Python suites are green and assert 0.3.5 shapes; `npm run test:host` and `node test/browser.test.js` need the reference host |
| T5-37 Documentation truth | Verified | current-facing docs state 0.3.5; phase-4 records marked historical; corpus presets state their step dependency; the downloader claim is limited to the notebook step |

## 5. Verification record

| Gate | Command | Result |
|---|---|---|
| Python suite | `.venv/bin/python -m pytest -q` | 105 collected / 105 pass / 0 fail (exit 0) |
| Node suite | `npm test` (6 files) | 43 pass / 0 fail |
| Real MCP functional check | `.venv/bin/python extension/functional_check.py` | `ok: true`; 20 measured tool definitions (5 + 6 + 9) ≈ 3,084 tokens; `evidenceResolved`, `claimsExported`, `backupCreated`, `evidenceRetainedAfterUnindex` all true |
| VSIX audit | `.venv/bin/python scripts/verify_vsix.py dist/research-stack-toolkit-0.3.5.vsix` | `result: "passed"`, `sourceFilesMatch: true` |
| Installed payload | `npm run check:payload` | `result: "passed"` — 9 presets for Full, 19 preset-selectable tools, 21 registered commands, repair/omission states observed |
| Review probes | `review_probes.py`, `review_probes.js` | every 0.3.4 defect probe records the corrected behaviour |
| Artifact | `dist/research-stack-toolkit-0.3.5.vsix` | 251,723 bytes, sha256 `b4d0b10f244830cb6c736460535b606202ca16b1b10f23d7b8589e80bceb6b52` |

## 6. Defects found while verifying this release

These were found by the release pass itself, not by the original review, and each is fixed and covered:

1. `rollbackRuntime` looked for `<runtime>/.venv/.venv/bin/python` on non-Windows hosts, so a rollback could
   never verify its candidate. Fixed; covered by the rollback test.
2. `inspectNotebookProject` refused a compatible project that pinned a version (`"ipykernel>=6"`) and refused
   any project whose name differed, even when it declared the imports the notebooks use. Both fixed; the
   three T5-18 cases are now tested.
3. `planView` counted an optional step installed by an earlier release as a "deliberate omission", hiding a
   genuinely outdated step. `omitted` now means "optional and never installed".
4. `runtime.readJsonFile` crashed on a directory or unreadable JSON where a record was expected; workspace
   discovery now reports such a runtime as unverified instead of failing.
5. `controls.js` suppressed the duplicate generic action message only when the element exposed its `id`; the
   guard now also covers the dedicated action names.
6. `scripts/verify_vsix.py` hardcoded `0.3.4` in the worker-bundle check, so no later release could pass the
   audit. It now derives the expected versions from the reviewed source and fails when the reviewed extension
   and worker versions disagree.
7. The VSIX capability audit flags any `.exec(` call. The shipped code now uses `.match()` rather than
   weakening the audit.

## 7. Implementation gaps and risks

| Gap | State | Why it matters |
|---|---|---|
| Reference-host receipts | **Outstanding** | No 0.3.5 run on Windows 11 / VS Code 1.141.0: Extension Host activation, webview renderer, real setup receipt, Copilot session with the shipped surface. `npm run test:host` and `node test/browser.test.js` are written but unrun. G1–G4 stay open. |
| Windows junction fixtures | Not exercisable here | Junction-based containment and the notebook `.venv` junction probe run only on `win32`. Symlink equivalents pass here. |
| Extraction → index bridge | Designed, not shipped | `design.md` describes indexing PDF/DOCX text into the corpus store. Today `index_corpus` indexes Markdown/text; a PDF or DOCX must be read with `read_document` first. The workflow is continuous for text sources, not for binary sources. |
| `read_text_source` locator echo | Open polish item | It returns the passage and context but does not echo the locator it resolved, which makes a follow-up citation slightly harder to copy. |
| 200-claim pagination corpus | Not generated | Cursor paging is proven with `limit=1` over a small corpus; the §9 wording mentions paging past 200 claims. |
| `dx.doi.org` prefix | Not asserted | DOI tests cover `https://doi.org/`, balanced punctuation and delimiter stripping; the `dx.doi.org` form is handled by the same prefix rule but is not asserted. |
| Third-party server counts | Vendor estimates | `research-lab` and `research-lab-max` totals (46 and 101 tools) use published vendor figures, labelled as estimates; they are not measurements taken by this extension. |
| Gates G1–G4 | Open | Nothing in 0.3.5 closes a gate; readiness text says so. |

## 8. Next highest-value actions

1. Run the 0.3.5 VSIX on the Windows 11 / VS Code 1.141.0 reference host: `npm run test:host`,
   `node test/browser.test.js`, a real component setup, and one Copilot agent-mode session with the
   `research-workflow` preset; record the receipts beside this report.
2. Ship the extraction → index bridge so `index_corpus` can ingest PDF/DOCX text with the same provenance
   rules it already applies to Markdown/text.
3. Close the two small honesty gaps: echo the resolved locator in `read_text_source`, and add a
   pagination fixture with a few hundred claims.
4. Re-run the review probes on the reference host so the Windows junction fixtures are covered by receipts
   rather than by code paths.
