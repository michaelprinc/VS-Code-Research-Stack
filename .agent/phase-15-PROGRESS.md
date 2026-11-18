# Phase 15 progress checkpoint (0.3.14) — working record, merged into QUALITY_STATE.md at the end

Goal id `goal-895ef2fa-1de8-4e33-8c76-e8eb20355c44`. Plan of record:
[spec.md](../specs/phase-15-hybrid-retrieval-presets-bundles/spec.md) ·
[tasks.md](../specs/phase-15-hybrid-retrieval-presets-bundles/tasks.md) ·
[acceptance.md](../specs/phase-15-hybrid-retrieval-presets-bundles/acceptance.md)

## Baseline (measured on this Linux host, 2026-11-17)

- Commit `6719415`, tree clean, no tag on 0.3.11–0.3.13.
- `npm test` in `extension/`: **482 tests, 482 pass, 0 fail, 0 skipped**.
- `uv run --locked pytest -q`: **413 passed, 0 failed** (uv replaced the checked-in Windows `.venv`
  with a Linux one; `.venv/` is gitignored, no tracked file changed).
- Toolchain: node v24.22.0, uv 0.13.6 (`~/.local/bin`), managed CPython 3.12.16, network reachable.

## Findings verified in the code before any change (R15-01…R15-11 in spec.md)

Every defect in the operator's 0.3.13 report was checked against the shipped source; two of its
claims were confirmed verbatim and one was located in a different file than the report names:

| Report claim | Verified where |
| --- | --- |
| `research-lab-max` carries no lab verb | `extension/presets.json:276-286` — nine document/metadata verbs only |
| `researchStack.integrationTimeoutMs` does not exist | `extension/integrationprobe.js:18,25` hold `10_000` / `80_000` literals; `extension/worker/README.md:54` claims the setting was added in 0.3.12 |
| `lab-state.json` is not refreshed by MCP writes | `src/research_stack/workspace.py:67-91` is the only writer, and it claims `vectorSearch: "not-implemented"` |
| changelog calls the widest preset "Full research workflow … 9 + 91 = 100" | `extension/CHANGELOG.md:20`; `research-workflow` is 11 toolkit tools with zero external |
| guide says "Install the 0.3.12 VSIX" | `extension/guides/toolkit.md:7` (and names `worker-0.3.13/installation.json`) |
| bundle repair cannot overwrite an edited bundle | `extension/bundles.js:279-300` (`user-modified`, `conflict`) and `:402-411` (copies use `wx`) |
| F-02 `draft` missing from claim statuses | `src/research_stack/records.py:155` |
| F-01 rollback checker/runtime mismatch unstated | `extension/runtime.js:216-225` |

## Operator decisions (2026-11-17)

- Vector scope: dependency-free CPU embeddings + hybrid fusion inside the store; no model download.
- Per-preset toolkit cap: **20**, with per-preset **exact** tool selection ("not all tools have to be
  enabled … research the topic to map suitable tools"; Copilot tool selection supported).
- GitHub: three max presets (full / limited / none) choosing exact tools per objective.
- Bundle archive: `.research-toolkit/bundles/archive/<bundleId>/<stamp>/`, keep all versions, index +
  text log naming the archive path, restore supported.
- Release discipline: bump to 0.3.14, all gates, build + audit the artifact, commit on main, no tag.

## Running work (delegated)

> Superseded by "Package status at the 0.3.14 cut" at the end of this file, which records the state each
> package actually landed in and the gates measured against the 0.3.14 artifact. Kept as the working record.

| Package | Owner | Status |
| --- | --- | --- |
| P1 GitHub MCP tool map + Copilot selection mechanism | subagent A | **done 2026-11-17** → [research/github-mcp-tool-map-2026-11-17.md](../research/github-mcp-tool-map-2026-11-17.md): 23 toolsets, 92 unique published names (57 read-only / 35 write), selection controls (`GITHUB_TOOLSETS`/`GITHUB_TOOLS`/`GITHUB_EXCLUDE_TOOLS`/`GITHUB_READ_ONLY`, remote `X-MCP-Toolsets`/`X-MCP-Tools`/`X-MCP-Exclude-Tools`/`X-MCP-Readonly`), Copilot-side `mcpServers[].tools` allow-list and the Tools tab. Every count is [D] vendor-name arithmetic — **no `tools/list` was measured here**. It also caught the coupling P5 must settle: `lab_server.py` now has 11 lab verbs while `presets.py` still lists 10, so `register_tools` drops `embed_corpus` from every preset including `all`. |
| P2 vector/hybrid retrieval + lab-state refresh + `draft` | subagent B | running → `src/research_stack/vectors.py`, `records.py`, `lab_server.py`, `workspace.py`, new tests |
| P3 bundle force-update + archive + index/log + restore | subagent C | **nearly done (checkpoint 2026-11-17)**: T15-14…T15-17 proven in `extension/test/bundles.test.js` (19 → 29 tests); archive at `.research-toolkit/bundles/archive/<bundleId>/<stamp+seq>/` with `archive.json` manifest, `index.json` (rebuilt from the tree if damaged), `archive.log` tab-lines carrying the **absolute** archive path; three commands wired (`forceUpdateTopicBundle`, `showBundleArchiveHistory`, `restoreBundleArchive`); command pins moved 39 → **42** in `package.json`, `vsix-manifest.json`, `unit.test.js`, `integration-host.test.js`, `scripts/check-installed-payload.js`. `npm test` **497 / 497 pass**. **Owed:** the panel button in `extension/media/ui.js` (host allow-list entries already added); `test:panel` + `check:payload` re-runs at hand-off |
| P4 `integrationTimeoutMs` + `integrationCooldownSeconds` | subagent E | **done 2026-11-17** → [implementation-P4-integration-settings.md](../specs/phase-15-hybrid-retrieval-presets-bundles/implementation-P4-integration-settings.md): two settings (default 80 000 ms in 40 000–300 000; default 10 s in 5–300 s) with bounds derived from the worker's own constants (34 s Zotero-only worst case, 35 s hosted ceiling), `integrationprobe.probeBounds()` as the single resolver with clamp sentences, `extension.js` `integrationBounds()` feeding four consumers, `vsix-manifest.json` mirrored (unit.test.js deep-equals the two manifests). Mutation evidence recorded. Its own suites 88/88 pass. **Flagged for P5/P8:** `extension/test/integration-host.test.js:939` and `extension/test/unit.test.js:53,65` pin the command count at **39** — P3's new commands must move those pins together with `scripts/check-installed-payload.js`. |
| P5 presets rework (three max presets, exact tool lists, cap 20) | main agent, after P1+P2 land | not started |
| P6 F-01 rollback honesty | main agent | **done 2026-11-17**: `extension/runtime.js` `rollbackRuntime` now returns `checkerVersion`, `checkerMatchesRuntime` and a `verificationNote` naming both releases and stating what the weaker proof proves; new test in `extension/test/runtime.test.js` proves the mismatch case and the matching case. `node --test test/runtime.test.js` → **19 tests, 19 pass, exit 0** |
| P7 documentation consistency | main agent | not started |
| P8 0.3.14 identity, gates, artifact, quality state | main agent | done: 0.3.14 identity, all five gates green, artifact built and audited, committed as `45a3b0b` on `main` with no tag (2026-11-18). |

## Next highest-value action

Reconcile P1's tool map and P2's new store verbs into the preset design (P5): the new verbs must be
in `LAB_TOOLS` in `src/research_stack/presets.py` and in the `servers` list of
`extension/presets.json`, and the three max presets must carry them (R15-01 is the defect that
started this release).

## Local evidence on the lab-state defect (measured 2026-11-17, with its limits)

- `toolkit/.research-toolkit/lab-state.json` reads `"toolkitVersion": "0.3.12"` in a tree that is at
  **0.3.13**, with `counts` all zero and `"vectorSearch": "not-implemented"`. The store beside it
  (`store/research.sqlite3`) has all seven tables at **0 rows**, so the counters happen to agree for
  the same reason the operator's report says they agree by accident: nothing has written since the
  file was created.
- The operator's own store — the one whose report quotes 8 sources / 2 067 chunks / 17 claims / 27
  evidence links / 12 index runs — is **not in this container** (`Research-Stack/.research-toolkit/`
  holds only `compatibility.lock.json`, no `store/`). The drift they describe is therefore **not
  reproducible here**; what is reproducible here is that no store verb refreshes the file, which is
  the mechanism behind it.
- Consequence for the acceptance test: T15-07 must be proven by writing through the verbs and
  comparing `lab-state.json` against a direct `SELECT`, not by arguing from any existing workspace.

## Package status at the 0.3.14 cut (measured 2026-11-18, this Linux host)

| Package | Owner | Landed |
| --- | --- | --- |
| P1 GitHub MCP tool map | subagent A | `research/github-mcp-tool-map-2026-11-17.md`. 92 unique published names (57 read-only / 35 write). Every count is a vendor **name-list** count: no `tools/list` was captured here. |
| P2 retrieval + lab-state + `draft` | subagent B | `src/research_stack/vectors.py` (new), `records.py` (schema 4, `_migrate_3_to_4`, RRF fusion, `embed_chunks`, `_vector_counters`), `lab_server.py` (`embed_corpus`, `search_corpus(mode=…)`), `workspace.py` (the `vectorSearch: "not-implemented"` placeholder is gone). Tests: `tests/test_vector_retrieval.py` (17), `tests/test_lab_state.py` (9), plus records/lab/migration/workspace/stdio extensions. |
| P3 bundle force-update + archive | subagent C | `extension/bundles.js` (+942 lines): `planInstall({force})`, archive-before-write, `archive.json` / `index.json` / `archive.log`, `listArchives`, `restoreArchive`, per-file `archivedTo`, receipt `installedByToolkit` (a 0.3.13 relabelling bug fixed). 3 commands. `bundles.test.js` 19 → 29. |
| P4 integration settings | subagent E | `researchStack.integrationTimeoutMs` (40 000–300 000, default 80 000) and `researchStack.integrationCooldownSeconds` (5–300 s, default 10), one resolver `probeBounds()`, four consumers in `extension.js`. |
| P5 preset catalog | main agent | `extension/presets.json` + `src/research_stack/presets.py`: cap 20, `embed_corpus` in `LAB_TOOLS`, `research-workflow` 15, `corpus-lab` 12, three max presets (16+92 / 20+42 / 20+0), `research-lab` and `research-lab-max` retired but resolvable. |
| P5b Copilot tool selection | subagent D | `extension/presetselect.js` (418 lines, pure, 28 refusal codes, `//researchStackPreset` marker) + `researchToolkit.configurePresetTools` in `extension.js` (modal, both entry shapes shown, previous bytes copied to `.research-toolkit/preset-tools/`), 43rd command contributed in both manifests, staging entry in `extension/scripts/package.js:154`. Note: `implementation-P5b-copilot-selection.md`. |
| P5c preset surface | subagent F | `extension.js` retirement handling (`presetsForPackage` filter, `presetRetirement`, refusal of a *new* choice of a retired preset, named-vs-estimated wording), `media/controls.js`, `ui.js` line 38 (4 buttons), `presets.test.js` rewritten (17 tests), `unit.test.js` enum pin derived, `panel_renderer_check.js` verdicts H and I. Note: `implementation-P5c-preset-surface.md`. |
| P6 F-01 rollback honesty | main agent | `rollbackRuntime` returns `checkerVersion`, `checkerMatchesRuntime`, `verificationNote`. |
| P7 documentation | main agent + subagent G | Guides on 0.3.14 numbers (`toolkit.md`, `onboarding.md` §5/§6, `research-corpus-index.md`, `cpu-embedding-runtime-and-model.md`, `python.md`, `document-worker.md`); changelogs and both READMEs by G. |
| P8 identity, gates, artifact | main agent | 0.3.14 in `extension/package.json`, `vsix-manifest.json`, `package-lock.json`, `pyproject.toml`, `src/research_stack/__init__.py`, `uv.lock`, regenerated `extension/worker/bundle.json`. `MAX_UNPACKED_BYTES` raised 1 572 864 → **1 769 472** with member-by-member attribution. |

### Decisions taken during the cut

- **DD15-09.** `research-max-github-limited` names 42 of the 57 published read-only names and excludes all 35 write names; 14 of the remaining 15 read-only names follow from the seven toolsets the preset does not enable, and `ui_get` is left out **by choice**. The preset's `note` now says this plainly instead of letting the count imply completeness. Adding `ui_get` (43) was rejected: it would move a number that guides, tests and two implementation notes already state, to gain nothing the operator asked for.
- **DD15-10.** Payload ceiling raised rather than the payload trimmed. Measured three times before it settled (121 members / 560 362 packed / 1 706 385 unpacked; then 560 523 / 1 707 234; then 561 483 / 1 710 106 — each after a documentation change that moved packaged bytes) and finally on the artifact now in `dist/`: **121 members / 561 509 packed / 1 710 211 unpacked** (headroom 59 261, 3.4 %). The READMEs no longer carry byte or hash figures, which is what stops this measurement from drifting again; the figures in `scripts/verify_vsix.py` and in `QUALITY_STATE.md` are the final ones; the two new members are `extension/presetselect.js` (+24 450) and `extension/worker/src/research_stack/vectors.py` (+9 936), the rest is named in the comment at `scripts/verify_vsix.py`.
- **DD15-11.** `scripts/verify_vsix.py` scans packaged **bytes** for transport and process names and cannot tell prose from code. The `presetselect.js` boundary paragraph therefore says "opens no outbound connection" rather than naming a transport; the reason is written in that same paragraph.
- **DD15-12.** `researchStack.toolsPreset` keeps the two retired ids in its `enum`, so a saved preference stays valid; they are removed from what the panel and the Quick Pick **offer**. Both doors refuse a new choice of a retired preset and name the three replacements.

### Owed, and honest about being owed

- No `tools/list` was ever captured against a running GitHub MCP server: every 92 / 57 / 35 / 42 figure is catalog arithmetic from 2026-11-17.
- That the Copilot harness honours the per-server `tools` allow-list, and tolerates the unknown `//researchStackPreset` member, is documented from vendor material, not observed here.
- No Zotero in this container: the 69 s timeout derivation is arithmetic over the worker's own ceilings, not a real-host timing (T14-20, T15-18).
- `extension/test/browser.test.js` has never executed here (no Playwright). `scripts/panel_renderer_check.js` rows A–I are the executed substitute.
- `scripts/verify_mcp.py` is Windows-only (`:46` names `.venv/Scripts/research-stack-mcp.exe`); the stdio path is proven by `tests/test_functional_check.py` and `tests/test_lab_server.py` instead.
- Ranking quality of `rsk-hashing-v1` on the operator's own corpus is unmeasured; no cosine threshold exists anywhere.
- `extension/bundles/theological-research/references/my-library.md` still states the toolkit "provides no vector store". It is a hashed bundle payload file pinned by `bundles/catalog.json`; changing it means a catalog re-hash and a bundle version move, which was not done in this cut. Recorded as the one shipped file whose 0.3.13 retrieval claim is now stale.
- Qdrant, DuckDB, a learned embedding model, Playwright and the institutional adapters stay `kind: "planned"`. No OCR, no automatic download, no notebook kernel, no Zotero delete or merge.

## Audit round after the release commit (18 November 2026)

An independent read-only audit of `45a3b0b` found nine statement-level contradictions — a preset whose
toolset list did not cover a tool it selected, panel comments and two READMEs describing the build as it was
before the buttons and the artifact existed, three guides with 0.3.13 or incomplete counts, an archive path
missing its sequence, an ellipsis standing in for a value, and retired presets whose goal text named servers
they no longer provide. All nine are fixed in the follow-up commit; the table is in
`QUALITY_STATE.md` under "Independent audit of the committed release". No behavioural defect in retrieval,
the archive or the settings was found, and the audit re-ran the five gates independently to the same numbers. After the fixes: **526 node tests / 526 pass**, panel **9 / 9**, **444 python tests passed in 152.51 s**, `verify-package` and `check:payload` both `result: passed` against the re-cut artifact (121 members, 561 509 packed, 1 710 211 unpacked).
