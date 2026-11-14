# Phase 14 acceptance — Zotero internalization (0.3.13)

Every row states what was actually run here and what was not. `proven` means a named test or a named command
produced the result on this Linux development host. `owed` means the requirement is real and this container cannot
produce it. Nothing in this file claims a real Zotero write.

## Gates run for this release

| Gate | Command | Result |
| --- | --- | --- |
| Python suites | `uv run --locked python -m pytest` | **413 passed** in 134 s |
| Node suites | `npm test` (in `extension/`) | **482 tests, 482 pass, 0 fail, 0 skipped** |
| Panel renderer | `npm run test:panel` | 7 assertions, 7 pass, 0 not proven |
| Package | `npm run package` | `dist/research-stack-toolkit-0.3.13.vsix`, 113 files, 508 994 bytes packed |
| Artifact audit | `npm run verify-package` | `result: passed` |
| Installed payload | `npm run check:payload` | `result: passed` |

Artifact identity: 113 members, **1 527 454 bytes unpacked** against the re-measured ceiling 1 572 864
(45 410 bytes of headroom, 3.0 %), sha256 `30fc220b372afac58ace0f1f8c9f11c9a5e1c8ff092d833ebb104a0fb553dd77`.
The growth from 0.3.12 (1 450 632) is attributed member by member in the comment above `MAX_UNPACKED_BYTES` in
[scripts/verify_vsix.py](../../scripts/verify_vsix.py), and the attribution sums to the measured 76 822 bytes exactly.

## Requirement acceptance

| Id | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| T14-01 | `zotero_library` reports which endpoints this Zotero answered, the counts Zotero reported, and whether a write key is present | proven | `tests/test_zotero_library.py::test_status_reports_what_this_zotero_answers_without_guessing` |
| T14-02 | One refused endpoint does not discard the answers the others gave | proven | `…::test_status_survives_one_refused_endpoint` |
| T14-03 | A library that could not be read is reported as unknown, not as "not empty" | proven | `…::test_a_zotero_that_refuses_every_read_is_reported_as_refused_not_as_an_empty_library` |
| T14-04 | An export format the local API does not answer with is refused **before** the request is made | proven | `…::test_export_refuses_a_format_the_local_api_does_not_answer_with_before_any_request` (asserts zero requests recorded) |
| T14-05 | The result says whether access labels survive the format (CSL-JSON no, BibTeX yes) | proven | `…::test_export_says_whether_access_labels_survive_the_format` |
| T14-06 | A search says when it truncated, with the total Zotero reported | proven | `…::test_library_search_reports_that_it_truncated` |
| T14-07 | Full text is read per item and through the index endpoint, always with `since`, and a zero answer is never called an empty index | proven | `…::test_fulltext_reads_the_item_endpoint_and_the_index_endpoint` |
| T14-08 | `preview` sends nothing and shows the exact body, the changed fields, the values before, and the version guard | proven | `…::test_preview_sends_nothing_and_shows_the_exact_body_and_guard` |
| T14-09 | `apply` without the literal `write-to-zotero` never reaches Zotero | proven | `…::test_apply_without_the_confirmation_literal_never_reaches_zotero` and, over the real MCP transport, `scripts/verify_recommended_mcp.py` → `zoteroWriteRefusedWithoutConfirm: "WRITE_CONFIRM_REQUIRED"` |
| T14-10 | A write with no authorized key is refused locally, before Zotero answers 401 | proven | `…::test_apply_without_a_key_reports_the_401_zotero_actually_gives` |
| T14-11 | Every write carries `If-Unmodified-Since-Version` and the key header | proven | `…::test_every_write_carries_the_version_guard_that_keeps_428_off` |
| T14-12 | 428 and 412 are honoured: 428 is `ZOTERO_WRITE_VERSION_REQUIRED`, 412 is `ZOTERO_WRITE_CONFLICT` and nothing is overwritten | proven | `…::test_a_write_that_races_a_change_is_refused_and_overwrites_nothing`, `…::test_a_client_that_sends_no_guard_gets_the_428_the_operator_measured` |
| T14-13 | `delete`, `delete_item`, `merge` and `duplicate_check` are refused by name before any request | proven | `…::test_delete_and_merge_are_refused_by_name_before_any_request` |
| T14-14 | A tag outside the reviewed vocabulary is refused; an item type Zotero does not list is refused | proven | `…::test_a_tag_outside_the_vocabulary_is_refused`, `…::test_an_item_type_zotero_does_not_list_is_refused` |
| T14-15 | Snapshot and undo journal are workspace files under `.research-toolkit/`, and a journal that will not fit names what it dropped | proven | `…::test_snapshot_is_a_new_file_in_the_workspace_and_says_when_it_is_truncated`, `…::test_journal_keeps_the_before_values_and_names_what_it_dropped` |
| T14-16 | `undo` replays the journal and refuses an entry Zotero reports as moved | proven | `…::test_undo_replays_the_journal_and_refuses_an_item_that_moved` |
| T14-17 | RIS validation catches the shape that produced 61 empty items, and warns without deleting a record it cannot deduplicate | proven | `…::test_validator_catches_the_shape_that_produced_61_empty_items`, `…::test_validator_warns_about_what_it_must_not_delete` |
| T14-18 | The RIS generator passes its own validator, and maps statute/report/thesis to `STAT`/`RPRT`/`THES` with `KW` tags | proven | `…::test_the_generator_passes_its_own_validator`, `…::test_ris_maps_the_types_the_translator_gets_wrong` |
| T14-19 | The bundle's standalone `validate_ris.py` implements the same rules as the worker's validator | proven | differential harness run by the bundle task: 14 samples × 3 `--expect` settings, **42 comparisons, 0 mismatches**; measured exit 0 / 1 / 2 on good, broken and missing files |
| T14-20 | A real Zotero 10 write on Windows, with the operator's own authorized key, snapshot, apply and undo | **owed** | Cannot be produced here: no Zotero, no Windows host, and the operator's library is not reachable. Recorded in [evidence/realhost-2026-11-14/README.md](../../evidence/realhost-2026-11-14/README.md) as the limit of that report. |
| T14-21 | The write key reaches only the worker that serves `zotero_write`, is never shown back, and is never written to a workspace file | proven | `extension/test/runtime.test.js` — key absent from every server without a stored secret, present only in the `research_stack.recommended_server` definitions with one, surface signature changes when it appears, key absent from panel messages and written files |
| T14-22 | `zotero_write` is offered by exactly one goal preset and by no package default | proven | `tests/test_presets.py::test_the_zotero_write_verb_is_offered_only_by_the_zotero_goal` |
| T14-23 | The replaced verbs stay available to a hand-written MCP entry and only there | proven | `tests/test_presets.py::test_the_replaced_zotero_read_verbs_stay_as_aliases_only_for_unmanaged_configurations`, `tests/test_presets.py` alias test for `search` |
| T14-24 | The C-13 budget contract still holds: 20 preset-selectable verbs, ≤ 12 toolkit tools per preset, ≥ 20 headroom | proven | `tests/test_presets.py` budget test, `extension/test/presets.test.js`, and `extension/scripts/check-installed-payload.js` asserting `toolCount === 20` and the widest preset at **100 tools** (9 toolkit + 91 external, 28 headroom) |
| T14-25 | The functional check's budget for `recommended_server` matches the surface it checks | proven | `extension/functional_check.py` `SERVER_BUDGETS` 6 → 8; `tests/test_functional_check.py` expects the eight names including the three unmanaged aliases |
| T14-26 | `scripts/verify_recommended_mcp.py` checks the surface it actually ships (defect F-04) | proven | Run here: exit 0, `"tools"` lists the eight names, `zoteroWriteRefusedWithoutConfirm: "WRITE_CONFIRM_REQUIRED"`, `zoteroWritePreviewDryRun: true`, `zoteroState.error.code: "ZOTERO_NOT_AVAILABLE"` with no Zotero present |
| T14-27 | Operator instruments stay read-only and are not packaged | proven | `scripts/zotero_local_check.py` and `scripts/zotero_library_audit.py` measured against an emulator in three states (local API on → exit 0 / 1, 403 → exit 1 / 2, nothing on the port → exit 1 / 2), truncation reported as `AUDIT SCOPE: truncated`; neither path appears in the VSIX member list the audit prints |
| T14-28 | No packaged member gained a network or process capability it did not have | proven | `npm run verify-package` outbound-primitive audit: `extension/worker/src/research_stack/research.py` still `build_opener(` × 2, `urlopen(` × 0; `zotero_store.py` contains no transport call at all |
| T14-29 | Skill bundle payload and staged tree are byte-identical and the catalog is re-derivable | proven | `uv run --locked python scripts/build_bundle_catalog.py --check` → `unchanged: 2 bundle(s), 14 files, 82 132 bytes`; both trees walked: 13 files each, no drift, no CRLF |

## What was found wrong on the way and fixed

- The RIS generator's own output failed its own validator: `rstrip()` stripped the trailing space off the final
  `ER  - ` line, and `tests/test_research.py` had pinned the defective text. Fixed in the generator, tolerated by
  the validator, and the pinned assertion now states what the format requires.
- `RIS_LEGAL_TITLE_PATTERN` was defined and never used. Removed rather than left as dead code; the design note in
  [design.md](design.md) now says why `TY  - GEN` is warned on every record instead of guessed from a title.
- `zotero_library_status` reported `libraryEmpty: false` for a library it could not read. It reports `null` now.
- `scripts/verify_recommended_mcp.py` hard-coded five tool names and omitted `search_literature` (defect **F-04**).
  Fixed and re-run.
- The installed-payload controller activated the shipped extension with no `SecretStorage` in its host model, which
  the Zotero write-key path exposed. The controller now models an empty store and asserts that activation and an
  empty definition request read no secret.

## What remains open after this release

1. **T14-20** — a real Zotero 10 write on a real host. Nothing in this release may be described as verified against
   a live library.
2. **G1–G4 remain open.** The 14 November real-host report exercised the tools the gates ask for and is recorded as
   a report, not a receipt. `evidence/gates-2026-11-07/final-validation.json` records `"gatesApproved": []`; the
   newest G1–G4 receipts predate 0.3.10 and live outside this repository's tracked evidence.
3. **G3's named candidates are unimplemented** — Qdrant, embeddings, DuckDB. A gate cannot be closed on components
   that do not exist.
4. **Defect F-01** (`extension/runtime.js` runs the current checker with the candidate's interpreter) and
   **F-02** (`records.py` `CLAIM_STATUSES` lacks `draft` while `specs/phase-3/spec.md` names it) are unchanged by
   this phase and remain recorded in `.agent/QUALITY_STATE.md`.
5. **The guided key flow is minimal.** `Research Toolkit: Store the Zotero Write Key` stores and removes the key;
   the Zotero integration card does not yet show whether one is stored. That is a card change, not a security gap.
