# Quality state — Research Stack Toolkit 0.3.14 (retrieval in the store, presets that name their tools, bundles that can be overwritten safely)

> **PHASE 15 IMPLEMENTED AND VERIFIED ON THE BUILD HOST — 17/18 November 2026. No tag on 0.3.14.** The release was
> driven by an operator's 0.3.13 report (Czech, sections ⚠1–5 and §8 "Co 0.3.13 nedělá"): retrieval planned but not
> implemented, `lab-state.json` not refreshed by the store's own writes, `researchStack.integrationTimeoutMs` named in
> the worker README but absent from Settings, the changelog describing a preset surface that was never shipped, the
> guide saying "Install the 0.3.12 VSIX", and a bundle repair path that could not overwrite a bundle the operator had
> edited. Plan of record: [specs/phase-15-hybrid-retrieval-presets-bundles/spec.md](../specs/phase-15-hybrid-retrieval-presets-bundles/spec.md)
> (HR-01…HR-33, DD15-01…DD15-12), [tasks.md](../specs/phase-15-hybrid-retrieval-presets-bundles/tasks.md),
> [acceptance.md](../specs/phase-15-hybrid-retrieval-presets-bundles/acceptance.md) (**T15-01…T15-21, all 21 proven**),
> with per-package notes `implementation-P2-retrieval.md`, `implementation-P3-bundle-archive.md`,
> `implementation-P4-integration-settings.md`, `implementation-P5b-copilot-selection.md`,
> `implementation-P5c-preset-surface.md`, `implementation-P7-docs.md` and the working checkpoint
> [phase-15-PROGRESS.md](phase-15-PROGRESS.md). The GitHub tool inventory the presets were built from is the tracked
> [research/github-mcp-tool-map-2026-11-17.md](../research/github-mcp-tool-map-2026-11-17.md).
>
> **What shipped.** (1) Retrieval inside the record store: `search_corpus(mode = lexical | vector | hybrid)`, the new
> `embed_corpus` verb, a dependency-free CPU backend (`rsk-hashing-v1`, 256 dimensions, signed feature hashing over
> words and 3/4-character n-grams, int16-quantised, stored base64 in the same SQLite file — standard library only, no
> model, no download, no new dependency), reciprocal-rank fusion (k = 60, 0.5 / 0.25 / 0.25), schema **4** with a
> reviewed `_migrate_3_to_4` that invents no vector, and a `lab-state.json` that every store verb refreshes from a
> `SELECT` on the same database. `draft` is an accepted claim status. (2) Presets that name what they count: cap raised
> **12 → 20** toolkit tools, three max presets (`research-max-github-full` 16 + **92 named** GitHub tools = 108 with
> exactly 20 tools of headroom; `research-max-github-limited` 20 + 42 named read-only tools with all 35 write tools
> named as excluded; `research-max-no-github` 20 + none), `research-workflow` 11 → **15** verbs and `corpus-lab` 11 →
> **12** so the whole journey is one preset, and `research-lab` / `research-lab-max` **retired but resolvable** — the
> unnamed "91 estimated external tools" they carried is exactly what 0.3.14 refuses to publish. (3)
> `researchToolkit.configurePresetTools` + `extension/presetselect.js`: the one writer of a preset's GitHub tool
> selection into the workspace `.mcp.json` (`mcpServers.github`, per-server `tools` allow-list), with 28 named refusals,
> a `//researchStackPreset` authorship marker, `${GITHUB_PERSONAL_ACCESS_TOKEN}` written instead of any token, and the
> bytes it replaces copied to `.research-toolkit/preset-tools/`. (4) Bundle force-update that can overwrite a bundle the
> operator edited, after a modal names every file and its state, with each replaced file archived under
> `.research-toolkit/bundles/archive/<bundleId>/<stamp>/` beside an `index.json` and an `archive.log` whose last field
> is the **absolute** archive path, plus `Show Bundle Archive History` and `Restore Bundle Archive Version`. (5) The two
> settings the worker README promised since 0.3.12: `researchStack.integrationTimeoutMs` (40 000–300 000 ms, default
> 80 000) and `researchStack.integrationCooldownSeconds` (5–300 s, default 10), resolved in one place
> (`integrationprobe.probeBounds()`) and reported as the bound actually in force. (6) F-01: a rollback now names the
> checker version and the runtime version and says what the weaker proof proves.
>
> **0.3.14 measured on the Linux development host that built it.** Node **525 tests, 525 pass, 0 fail, 0 skipped**.
> Python **444 passed, 0 failed** across 22 files. Panel renderer check **9 assertions, 9 pass, 0 not proven** (rows H
> and I added for the four new panel controls and the retirement text). Artifact
> **`research-stack-toolkit-0.3.14.vsix`, 121 members, 560 523 packed, 1 707 234 unpacked** under the re-measured
> ceiling **1 769 472** (headroom 62 238, 3.6 %), sha256
> `82cf6b8274df87b039b1b85bbf5740bebed2e1c7995476f2dc2da17e667fbae0`; `verify-package` and `check:payload` both
> `result: passed`. The +213 161 bytes over 0.3.13 are attributed member by member above `MAX_UNPACKED_BYTES`.
> `uv.lock` was re-resolved with uv 0.13.6, never hand-edited. **Tool budget:** 21
> preset-selectable verbs (5 documents + 5 research + 11 store; `all` publishes 24 with the three reviewed aliases),
> every preset ≤ 20 toolkit tools, widest total 108 of 128.
>
> **What 0.3.14 does not claim.** No `tools/list` was ever captured against a GitHub MCP server: 92 / 57 / 35 / 42 are
> vendor catalog **name** counts from 2026-11-17. That the Copilot harness honours a per-server `tools` allow-list, and
> tolerates the unknown marker member, is vendor-documented, not observed here. `rsk-hashing-v1` is a lexical signature,
> not a semantic model, and its ranking was never measured against the operator's own corpus; no cosine threshold exists
> anywhere. Qdrant, DuckDB, a learned embedding model, Playwright and the institutional adapters stay `kind: "planned"`;
> no OCR, no automatic acquisition of papers, no notebook kernel execution, no Zotero delete or merge. G1–G4 remain
> open, the reference-host / Extension Host / browser receipts for 0.3.9–0.3.14 were never produced, and
> `extension/test/browser.test.js` has never executed in this container. One shipped file keeps a stale 0.3.13 claim —
> `extension/bundles/theological-research/references/my-library.md` still says the toolkit provides no vector store; it
> is hashed by `extension/bundles/catalog.json` and was not re-hashed in this release.
>
> The 0.3.13 record follows, kept as history exactly as it was written.

## Defects found and closed in 0.3.14

| Finding (operator report / audit) | What was wrong | What the shipped build does |
| --- | --- | --- |
| ⚠1 / §8 "vector and hybrid retrieval is only planned" | `search_corpus` accepted only `lexical`; the store carried a `vectorSearch: "not-implemented"` marker. | `mode = lexical \| vector \| hybrid` with reciprocal-rank fusion; `embed_corpus(overwrite)`; `vectorSearch` is gone from the workspace writer and `retrieval` reports the state that a `SELECT` measured. |
| ⚠2 "lab-state.json drifts after the store's own writes" | Indexing through MCP updated SQLite but left the JSON counters behind. | Every store verb refreshes `lab-state.json` (schema 2) from the same database; a refresh failure is reported as a named reason with `nextAction`, never as a silently stale number. |
| ⚠3 `researchStack.integrationTimeoutMs` documented but missing | The worker README named it since 0.3.12; Settings had no such key, and the probe's bound was hard-coded. | `integrationTimeoutMs` (40 000–300 000 ms, default 80 000) and `integrationCooldownSeconds` (5–300 s, default 10) are contributed settings, resolved once in `integrationprobe.probeBounds()` and named in the probe result. Out-of-range values clamp with a note saying what was clamped. |
| ⚠4 changelog describes a preset surface that was never shipped | 0.3.13 published "9 toolkit tools + 91 estimated external tools = 100" for presets whose tool lists did not exist. | Every preset's third-party count is a **named** list whose length is its `toolsEstimate` (HR-11); estimates without names are refused by test and by code; `research-lab` and `research-lab-max` are retired, labelled as retired, and no longer offered. |
| ⚠5 / R15-05 guide says "Install the 0.3.12 VSIX" | `extension/guides/toolkit.md:7` and `worker-0.3.13/installation.json` in five guides. | Guides name the 0.3.14 VSIX and `worker-0.3.14/installation.json`, and the 0.3.13 preset table is annotated in place with a pointer to the current one. |
| Bundle cannot be force-updated after the operator edited it | `planInstall()` stopped at `user-modified` and `conflict`, so a hand-edited bundle could not be brought back to the Toolkit's source without deleting files by hand. | `force` reaches `user-modified` and `conflict` (never `shared-with-other-bundle`), only after a modal lists each file and its measured state; replaced bytes are archived before any write. |
| F-01 rollback proof was weaker than its wording | A rollback verified the checker, not the runtime it replaced, and said only "verified". | `rollbackRuntime` returns `checkerVersion`, `checkerMatchesRuntime` and a `verificationNote` that states which of the two was checked. |
| F-02 a retired preset could still be chosen | The Quick Pick and the settings enum carried `research-lab` / `research-lab-max` with estimates that no longer held. | Retired presets are filtered out of every picker, marked in the settings enum labels, refused on a new choice, and still resolvable for an existing saved value. |

## Open items and risks carried into the next round (0.3.14)

1. **No `tools/list` receipt.** 92 published GitHub names (57 read-only, 35 write), the 42-name limited subset and the
   21 / 14 toolset lists come from the vendor catalog as read on 2026-11-17, recorded in
   [research/github-mcp-tool-map-2026-11-17.md](../research/github-mcp-tool-map-2026-11-17.md). A live `tools/list`
   against `…/mcp/x/all` and `…/mcp/readonly` has never been captured here, so a name could be stale or renamed.
2. **Copilot behaviour is vendor-documented, not observed.** That `mcpServers[].tools` gates which tools the harness
   offers, and that `.mcp.json` tolerates the `//researchStackPreset` member, is what GitHub documents; nothing in this
   repository measured it.
3. **Retrieval quality is unmeasured.** `rsk-hashing-v1` is a 256-dimensional signed feature-hash signature: it finds
   lexically similar text, not paraphrase. No cosine threshold, no ranking-quality measurement against the operator's
   own corpus (8 sources / 2 067 chunks, not present in this container), no recall/precision figures anywhere.
4. **`extension/bundles/theological-research/references/my-library.md:10` still says the toolkit provides no vector
   store.** Re-hashing that bundle means moving `extension/bundles/catalog.json` and the bundle version; this release
   deliberately did not do it. Highest-value documentation fix in the next round.
5. **A stale hashed-bundle claim, one unmeasured backend, no reference-host receipts** — the Extension Host and browser
   renderer receipts are outstanding since 0.3.9, `extension/test/browser.test.js` has never executed here (the panel
   renderer check is the substitute), `scripts/verify_mcp.py:46` names a Windows executable and cannot run on POSIX, and
   `npm run test:host` was not run.
6. **Payload headroom is thin:** 62 238 bytes, 3.6 % of 1 769 472. A further guide expansion or another preset with a
   full name list needs the ceiling re-measured before it lands, not after.

## Next highest-value action (0.3.14, current)

1. Capture a real `tools/list` from the GitHub MCP server on a host with a token, and reconcile it against the 92 / 57 /
   35 map; where the server disagrees, correct `extension/presets.json` and the map in the same commit.
2. Re-hash the theological-research bundle so `references/my-library.md` describes schema 4 and the retrieval modes,
   and move its catalog entry — the last shipped file that still contradicts the build.
3. Measure retrieval on the operator's corpus: same 20 queries under `lexical`, `vector` and `hybrid`, ranked side by
   side, and record whether hybrid actually helps or only reorders ties. That is the evidence the mode needs before it
   becomes a default.
4. Produce the 0.3.14 Extension Host and browser-renderer receipts on a real host (four new panel controls and the
   retirement text have only the panel renderer check behind them).

## 0.3.13 (Zotero work internalized into the Toolkit's own worker) — the record that preceded 0.3.14

> **PHASE 14 IMPLEMENTED, VERIFIED AND COMMITTED — 14 November 2026, commit `a42af03`; the presentation-correction
> round that follows it is committed as `56a990f`, `6607db9`, `c4f8816`, `39cb936`, `650416f` and `bcbf6fe`. No tag
> on 0.3.13.** An operator's brief about their own
> **Zotero 10.0.8** library (93 items = 43 top-level + 50 child notes, 37 with a DOI, **0 collections, 0 tags,
> 0 saved searches**, full-text index answering no match) drove the phase. Its claims are labelled by the operator
> themselves — [ZMĚŘENO] measured, [NAJDO] found in Zotero's source, [ZÁMĚR] deliberately not done — and the brief
> is kept as a tracked artifact with its limits in [evidence/realhost-2026-11-14/README.md](../evidence/realhost-2026-11-14/README.md).
> Plan of record: [specs/phase-14-zotero-internalization/spec.md](../specs/phase-14-zotero-internalization/spec.md)
> (ZT-01…ZT-18 with dispositions, DD14-01…DD14-11) and [design.md](../specs/phase-14-zotero-internalization/design.md);
> acceptance in [acceptance.md](../specs/phase-14-zotero-internalization/acceptance.md) (**T14-01…T14-29**, 28 proven,
> **T14-20 owed**).
>
> **What shipped.** Three Zotero tools became **two verbs in the Toolkit's own worker**: `zotero_library`
> (`status`, `collections`, `item`, `search`, `fulltext`, `export`) and `zotero_write` (`preview`, `snapshot`,
> `apply`, `journal`, `undo`) over seven operations (`create_item`, `set_item_type`, `update_fields`, `add_tags`,
> `remove_tags`, `create_collection`, `add_to_collection`). `delete`, `delete_item`, `merge` and `duplicate_check`
> are refused by name — Zotero's `server_localAPI.js` has **no duplicate-detection and no merge endpoint**. The dry
> run, the snapshot (`.research-toolkit/zotero-snapshots/`), the undo journal (`.research-toolkit/zotero-journal/`,
> 4 KiB, names what it dropped) and the version guard are inside the tool, not a procedure the operator must remember.
> The old names (`search`, `zotero_collections`, `zotero_item`) are registered **only** for unmanaged, hand-written
> MCP entries. New module `src/research_stack/zotero_store.py` does no network I/O at all.
>
> **Measured facts honoured, not assumed.** 428 for a write with no `If-Unmodified-Since-Version`; 412 for a write
> that raced a change; 401 + `WWW-Authenticate: Zotero-API-Key realm="Zotero Local API"` with no key; `since` is
> required by `GET /api/users/0/fulltext` (400 without it); `format=markdown` and `format=counts` are answered 400,
> so a Markdown bibliography is generated from records; CSL-JSON carries neither `extra` nor tags while BibTeX
> carries `extra` as `annote`; `KW` → tag, `M2` → `extra`, `N2` → abstract, `DP` → libraryCatalog, `N1` →
> **unfilterable child note**; `TY - GEN` → `journalArticle`; an import that returned HTTP success created
> **156 items, 61 of them empty**.
>
> **0.3.13 measured on the Linux development host that built it.** Node **482 tests, 482 pass, 0 fail, 0 skipped**.
> Python **413 passed, 0 failed** (25 of them in the new `tests/test_zotero_library.py`). Panel check **7 assertions,
> 7 pass**. Artifact **`research-stack-toolkit-0.3.13.vsix`, 113 members, 508 994 packed, 1 527 454 unpacked** under
> the re-measured ceiling **1 572 864** (headroom 45 410, 3.0 %), sha256
> `30fc220b372afac58ace0f1f8c9f11c9a5e1c8ff092d833ebb104a0fb553dd77`; `verify-package` and `check:payload` both
> `result: passed`. The +76 822 bytes over 0.3.12 are attributed member by member in the comment above
> `MAX_UNPACKED_BYTES` and the attribution **sums to the measured delta exactly**. `uv.lock` was re-resolved with
> uv 0.13.6, never hand-edited. **Tool budget unchanged:** 20 preset-selectable verbs, every preset ≤ 12 toolkit
> tools, widest preset `research-lab-max` now **9 toolkit + 91 external = 100** (was 101), 28 tools of headroom
> under the 128-tool ceiling; `zotero_write` appears in exactly one goal preset (`zotero-handoff`) and in no package
> default.
>
> **The same suites on the Windows host used for the 0.3.13 presentation corrections (15 November 2026).** Node
> **482 tests, 450 pass, 26 fail, 6 skipped**; Python **407 passed, 6 failed**; panel check **7 assertions, 7 pass**.
> Every one of the 32 failures is a property of this host, not of the code, and each is named: **26 node + 4 python
> failures are link creation** — an unprivileged Windows session cannot create a symlink or a junction (`EPERM` /
> `WinError 1314`), so the tests that prove a link, a junction or a reparse point cannot redirect a workspace file
> cannot run here (`extension/test/hosttools.test.js` probes a POSIX-mode fixture that Windows does not carry, which
> is why its tool-resolution assertions answer `null`); **1 python failure** is `tests/test_stdio.py::test_isolated_mode_ignores_PYTHONIOENCODING`,
> which this host's interpreter honours `PYTHONIOENCODING` even under `-I`; **1 python failure** is
> `tests/test_zotero_library.py::test_snapshot_is_a_new_file_in_the_workspace_and_says_when_it_is_truncated`, whose
> assertion compares a POSIX-relative member path against the `\\`-joined path Windows produced. **No failure
> reproduces a defect in the shipped behaviour, and both release gates pass on this host** (see the round below).
> The 482/482 and 413/0 figures above are therefore **host-scoped to the Linux build host**, and a maintainer
> reproducing them on Windows must expect exactly these 32 refusals.
>
> **Defects closed in this phase.** **F-04** — `scripts/verify_recommended_mcp.py` hard-coded five tool names and
> omitted `search_literature`; it now expects the real eight and also proves over the MCP transport that
> `zotero_write(apply)` refuses without the confirmation literal and that `preview` is a dry run (run here: exit 0).
> The RIS generator failed its own validator (`rstrip()` stripped the trailing space of the final `ER  - ` line and
> `tests/test_research.py` had pinned the defective text). `RIS_LEGAL_TITLE_PATTERN` was dead code. `libraryEmpty`
> reported `false` for a library the probe could not read. The installed-payload controller modelled no
> `SecretStorage`, which the write-key path exposed.
>
> **Still open, unchanged by this phase.** **F-01** (`extension/runtime.js:216-225` runs the current checker with
> the candidate's interpreter), **F-02** (`records.py:155` `CLAIM_STATUSES` lacks `draft` against
> `specs/phase-3/spec.md:42`). **G1–G4 remain open**: the four gate reports versioned in this repository say so in
> their own words — `evidence/phase-1/gate-report.md` "G1 not passed", `evidence/phase-2/gate-report.md` "G2 not
> passed" and "G1 remains open", `evidence/phase-3/gate-report.md` "G3 not passed", `evidence/phase-4/gate-report.md`
> "0.3.2 local document workflow passed; full G4 remains open". The `evidence/gates-2026-11-07/final-validation.json`
> that earlier rounds of this file cited, with `"gatesApproved": []`, is **not in this repository** — it was a
> host-local run, so it is named as out-of-repo evidence and no reader should go looking for it in `evidence/`.
> G3's named candidates (Qdrant, embeddings, DuckDB) are unimplemented. The 14 November real-host run is the
> strongest real-host evidence in this repository and it is a **report, not a gate receipt**.

## 0.3.13 presentation-correction round (15 November 2026)

A publication-readiness check of 0.3.13 for the VS Code Marketplace found that the presentation files claimed more
than the build delivers. Six commits followed, each its own stage:

| Commit | What it changed |
| --- | --- |
| `56a990f` | Records the **MIT** licence (holder Michael Princ) in a new `LICENSE`, in `extension/package.json` and `extension/vsix-manifest.json` (`"license": "MIT"`), in the catalog generator and in the bundle test. `document-corpus-bridge` becomes `publishable: true`; `theological-research` stays `publishable: false` because only its author can grant that consent. |
| `6607db9` | `extension/CHANGELOG.md` now carries **only the 0.3.13 entry**; 0.2.0–0.3.12 moved to the new `extension/CHANGELOG-archive.md`. Reconstruction of the old 111 622-byte file from the two parts is byte-identical. |
| `c4f8816` | The packaged Details page (`extension/README.md`, 9 187 B) rewritten so every claim matches the shipped build. |
| `39cb936` | The repository `README.md` corrected (21 796 B, 102 lines) and the artifacts derived from it regenerated: `extension/bundles/catalog.json`, `extension/worker/README.md` (byte-copied from the root README), `extension/worker/bundle.json`, `scripts/build_guide_index.py`, `scripts/build_worker_bundle.py`. |
| `650416f` | `extension/scripts/package.js` stamps and normalizes the artifact: `process.env.TZ = "UTC"` and `normalizePackagedModes()`. |
| `bcbf6fe` | The release notes are packaged as `extension/changelog.md`, so the Marketplace Changelog tab exists. |

**Claims corrected.** The gate status was the serious one: an earlier draft of this round's README said G2, G3 and G4
had passed. All four gate reports say they have not, and the corrected README quotes them. Also corrected: the
0.3.4/0.3.9 corpus-index attribution, the measured 28-command headroom under the 128-tool ceiling, the licence and
publishability section, and the range of evidence that is versioned in this repository versus evidence that was only
ever produced on a development host.

**Two packaging defects found while rebuilding, both closed rather than gated around.**
1. **Timestamps.** vsce sets every entry's mtime from `SOURCE_DATE_EPOCH` (1980-01-01) but yazl writes it in the
   host's local zone; this host is UTC+1, so every member was stamped `1980-01-01 01:00:00` and `scripts/verify_vsix.py`
   refused the artifact as unstamped. `process.env.TZ = "UTC"` in the packager fixes it.
2. **Permission bits.** Windows cannot express 0644: `fs.chmodSync(target, 0o644)` succeeds and the file still reports
   0666, so a build from this tree was refused by the gate while the same tag built cleanly on a POSIX host. vsce
   collects staged files without a mode, so yazl inherits the host's. `normalizePackagedModes()` now states the two
   values the gate expects in the finished artifact's central directory — 0644 for members copied from the tree, 0664
   for vsce's four generated members — refusing ZIP64 and validating its cursor rather than writing blindly.
   Content, order, timestamps and compressed sizes are untouched.

**Artifact after this round.** `research-stack-toolkit-0.3.13.vsix`, **114 members, 497 185 packed, 1 492 505 unpacked**
under the unchanged ceiling **1 572 864** (headroom 80 359, 5.4 %), sha256
`f3108128275106df4707504d07f1a7f560e7eb846bca6582d4b66a529b0e34f0`, every member stamped 1980-01-01 00:00:00, modes
0644 ×110 and 0664 ×4. `npm run verify-package` and `npm run check:payload` both `result: passed` on this Windows
host. The payload delta across the round is attributed member by member in the comment above `MAX_UNPACKED_BYTES`.

**Publication verdict at the end of this round.** The listing is not publishable. `theological-research` was still
`publishable: false` — its licence needs its author's consent, which no amount of editing here can supply, so the
catalog's `publishable: false` was correct at this point. `@vscode/vsce` remains pinned at 4.0.0. G1–G4 remain open.
0.3.13 has no tag. A live Marketplace probe returns `TotalCount 0` for the extension id and 404 for the listing, the
changelog and the publish endpoint. *(The licence half of this verdict is superseded by the licence round below, same
date; the rest stands.)*

**Open items from the 0.3.10/0.3.11 rounds that this round closes.** The list under "Open items and risks" in the
0.3.12 section below is kept as written at the time, and three of its entries no longer hold: the **repository
licence** decision is taken (MIT, holder Michael Princ, recorded in `LICENSE` and in both manifests, with the scope
note that it does not cover `theological-research`); the packaged artifact **does** carry a Changelog asset from
`bcbf6fe`; and there is **one** `publishable: false` skill bundle, not two, because `document-corpus-bridge` is
toolkit-authored and covered by the recorded licence. The publisher, credential and pre-release decisions and the
vsce pin are untouched by this round. The last of those licence entries closes in the round below.

---

## 0.3.13 theological-research licence round (15 November 2026)

The licence blocker the presentation round above left open is closed. The `theological-research` bundle is the work of
s. Denisa and Michal, staged from their working copy, and it has been substantially updated since that initial
cooperation. Its holders chose **MIT** for it, so the bundle now answers its own licence question instead of
inheriting one from the repository:

- **`theological-research/LICENSE`** in both trees — `MIT License`, `Copyright (c) 2026 s. Denisa + Michael`, plus a
  scope note stating that it covers the bundle (the skill instruction, seven references, three scripts, `evals.json`)
  and grants nothing over the works, provider records or licensed databases the bundle only refers to. LF-only,
  1 815 bytes, byte-identical in `templates/skill-bundles/theology/theological-research/` and
  `extension/bundles/theological-research/`.
- **`license: MIT`** added to the `metadata` block of the bundle's `SKILL.md` frontmatter (11 532 → 11 547 bytes).
  `author: s. Denisa + Michal` and `version: "2.0"` are unchanged — the bundle's own version was not bumped.
- **`scripts/build_bundle_catalog.py`** records the MIT licence string and `publishable: True` for the bundle. The
  now-unused `LICENSE_UNRESOLVED` constant became `UNRESOLVED_LICENSE_PREFIX = "unresolved"`, which the refusal gate
  still tests. **All three gates are untouched**: the generator, `extension/bundles.js` and `scripts/verify_vsix.py`
  each still refuse a bundle marked `publishable: true` whose `license` starts with `unresolved`.
- **Catalog regenerated**: `2 bundle(s), 15 files, 83962 bytes, 0 unresolved license(s), publishable=True`, and
  `--check` agrees. The bundle is 14 files / 76 990 bytes; the bridge is unchanged at 1 file / 6 972 bytes.
- **Tests**: `extension/test/bundles.test.js` now asserts `publishable: true` and `/^MIT/` on the shipped catalog,
  that the bundle ships a `LICENSE` member carrying the MIT text and its copyright line, and that the frontmatter
  declares the licence; the five shipped-bundle file counts go 13 → 14. The synthetic fixtures that test the refusal
  rule (an unresolved licence marked publishable, a 13-file synthetic bundle) are deliberately unchanged — the rule
  stays under test.
- **Records superseded, not deleted**: D9-17 closed, DD9-24 marked superseded, T9-47 and phase-9 task 15 annotated,
  phase-10 P-05/P-06, T10-38, the "Open, by design" rows and tasks 22/24 annotated, and `bundle-notes.md` §7 item 1
  closed. Each carries a dated note and keeps the 0.3.9/0.3.10 wording and receipts as written.
  `extension/CHANGELOG-archive.md` and everything under `evidence/` were not touched.

**What is deliberately not recorded.** No catalog field or document names who decided or documents any individual's
consent. The bundle's own licence file is the record, and nothing here claims consent on anyone's behalf.

**Artifact after this round.** `research-stack-toolkit-0.3.13.vsix`, **115 members, 499 223 packed, 1 496 331
unpacked** under the unchanged ceiling **1 572 864** (headroom 76 533, 5.1 %), sha256
`c4f249c8837c68c7d8b697a73bf76b9ef404f45121b02b308083cad64ba77738`. The +3 826 unpacked bytes are attributed member
by member in the comment above `MAX_UNPACKED_BYTES`. `npm run verify-package` reports `publishable: true` with
`unresolvedLicenses: []`, and `npm run check:payload` reports `result: passed`, both on this Windows host.

**Publication verdict, changed in one respect only.** The licence blocker is gone: both bundles are MIT and
publishable, and `scripts/verify_vsix.py` no longer reports `publishable: false`. 0.3.13 is **still not
publishable**: G1–G4 remain open, 0.3.13 has no tag, `@vscode/vsce` remains pinned at 4.0.0, the reference-host,
Extension Host and rendered-window receipts are still outstanding, and a live Marketplace probe returns
`TotalCount 0` for the extension id and 404 for the listing, the changelog and the publish endpoint.

---

# Quality state — Research Stack Toolkit 0.3.12 (the 0.3.11 integration onboarding, corrected against a real Zotero 10)

> **PHASE 13 IMPLEMENTED, VERIFIED AND COMMITTED — integration correction from a real-host report (12 November 2026).**
> An operator ran 0.3.11 on **Windows with Zotero 10** and reported: Zotero was installed and correctly detected, the
> GUI checks failed, **"Check now" did not work correctly**, and the guided Semantic Scholar key flow had a problem.
> Commits `30de507` and `fd81489`; no tag. Plan of
> record: [specs/phase-13-integration-correction/spec.md](../specs/phase-13-integration-correction/spec.md) — **21
> defects registered (P1–P9 worker, J1–J7 host, M1–M7 model/panel)** with decisions DD13-01…DD13-09; M7 was found by
> the instrument built to verify the rest, not by the plan.
> **Reproduced here, not assumed:** the shipped probe was run against an emulated Zotero on the real port
> `127.0.0.1:23119` — a server that closes without answering **crashes** the probe with `RemoteDisconnected`, and
> 401 / 404 / a non-JSON 200 all collapse to the same generic `unknown` sentence, so the Toolkit cannot tell the
> operator what Zotero said. Primary source read directly: the official
> [Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/local_api) — reads need **no** authentication,
> a disabled preference gives **403**, the local API has **no rate limits**, ask `/api/` first, Zotero 10+ adds
> `Zotero-Server-ID`, and Zotero 10+ **writes** need a user-approved local key (the Toolkit must not trigger that
> dialog). New operator-facing instrument: [scripts/zotero_local_check.py](../scripts/zotero_local_check.py)
> (not packaged, not installed) — verified against three emulated states, each giving the right verdict and exit
> code. Evidence: [evidence/realhost-2026-11-12/README.md](../evidence/realhost-2026-11-12/README.md).
> **Answered from Zotero's own source (`zotero/zotero` at tag 10.0.9), not assumed:** `Host: 127.0.0.1:23119` **is
> accepted** — `server.js` matches it against `/^(?:127\.0\.0\.1|\[::1\]|localhost)(?::[0-9]+)?$/i`, so the leading
> hypothesis that the Host header was rejected is **disproven** and recorded as such. `users/0`, `format=json` and
> `limit=100` are all valid. Zotero binds **IPv4 loopback only**, so `127.0.0.1` is the right constant and `localhost`
> would have been worse. What is still unknown is which of the reproduced states the operator's machine is actually
> in — that needs `scripts/zotero_local_check.py` run on their Windows host.
>
> **0.3.12 measured, current.** The phase-13 corrections were released as their own version at the operator's
> request. Node **481 tests, 481 pass, 0 fail, 0 skipped**. Python **386 passed, 0 failed, 0 skipped**. Panel check
> **7 assertions, 7 pass** (`npm run test:panel`). Artifact **`research-stack-toolkit-0.3.12.vsix`, 110 members,
> 483 008 packed, 1 450 632 unpacked** under the 1 507 328 ceiling, `sourceFilesMatch: true`, `result: passed`,
> sha256 `5b1667ab1ce45a07bd63762f53012ad1302dea0ace539d1f82a91f583f602f10`, reproduced byte-identically by a second
> build. Payload check passed with **38 commands unchanged**. `uv.lock` was re-resolved with uv 0.13.6, not hand-edited.
> Unpacked-size chain for this release line: 1 343 649 → 1 365 400 → 1 383 104 → 1 420 824 → 1 445 373 → 1 446 993 →
> 1 447 197 → **1 450 632**, ceiling 1 507 328, headroom 56 696. Acceptance:
> [specs/phase-13-integration-correction/acceptance.md](../specs/phase-13-integration-correction/acceptance.md)
> (T13-01…T13-34). Phase 13 code was committed as `30de507` and `fd81489`; the 0.3.12 identity bump follows in this
> round's commit. No tag.
>
> **The gap found at the freeze, and how it closed.** T13-22, T13-27, T13-28 and T13-29 were asserted only in
> `extension/test/browser.test.js`, which has never run here — Playwright is absent and the file is not in
> `npm test`. The scratch DOM probe left in `/tmp` by the panel agent **crashed on the new code**
> (`control.setAttribute is not a function`) and proved nothing. `scripts/panel_renderer_check.js` now runs the
> shipped `media/controls.js` byte-for-byte in a DOM shim against a real state message from the shipped harness:
> **7 assertions, 7 pass, exit 0**. Running it found a defect the plan had missed — **M7**: `applyControlAvailability()`
> returned on the `isReadOnly` branch before the unavailable branch, so `[data-action="updateNow"]` carried
> `data-unavailable="true"` and an explanatory title while staying `disabled=false` and unannounced. Fixed; row G
> **fails against the pre-fix renderer** (`disabled=false aria-disabled=null`, exit 1) and passes on the fixed one.
> `gui-status.test.js`'s source-shape pin on the old branch was renegotiated into a semantic pin. What a real browser
> is still owed is named in acceptance §3.
>
> **The defect this phase almost missed.** `CALL_CEILING_MS` documented that no attempt loop outlives the caller's
> patience, but it counted only the pauses the loop slept — four 15-second timeouts ran to ~66 s against a 20 s
> promise. Both sides of the boundary had tests that passed. A named ceiling must bound what its name claims.
>
> **Phase 12 is implemented, verified and committed** (`798c41c`, `9a6c726`, `32b3b38`, `8001c80`; no tag). Plan of record:
> [specs/phase-12-integration-resilience/](../specs/phase-12-integration-resilience/) —
> [spec.md](../specs/phase-12-integration-resilience/spec.md),
> [design.md](../specs/phase-12-integration-resilience/design.md) (DD12-01…DD12-20),
> [request-path-map.md](../specs/phase-12-integration-resilience/request-path-map.md),
> [documentation-review.md](../specs/phase-12-integration-resilience/documentation-review.md),
> [tasks.md](../specs/phase-12-integration-resilience/tasks.md) (20 packages, 15 defects found and closed),
> [acceptance.md](../specs/phase-12-integration-resilience/acceptance.md) (T12-01…T12-40, RG12-A…RG12-E, and §8
> answering the review's nine conditions one by one in §7).
> Receipts: [evidence/quality-v0.3.11-phase12-2026-11-09/](../evidence/quality-v0.3.11-phase12-2026-11-09/).
>
> **Measured, current.** Node `npm test` **468 tests, 468 pass, 0 fail, 0 skipped** (was 436). Python **352 passed,
> 0 failed, 0 skipped** (was 273 at the 0.3.11 audit). Artifact **110 members, 473 110 packed, 1 420 824 unpacked,
> `sourceFilesMatch: true`, `result: passed`**, sha256 `9230704d…`, with a second consecutive build producing the same
> digest. Payload check passed with **38 commands unchanged**.
>
> **The one gate this phase failed, and how it was closed.** `verify-package` failed at 1 383 104 against
> 1 376 256 — 6 848 over. Nothing was moved out and no reviewed file was dropped, so the ceiling was
> re-measured to **1 441 792** (one 1/16 MiB step) with member-by-member attribution in
> `scripts/verify_vsix.py:128-152` and in the evidence README. The chain is recorded: 1 343 649 → 1 365 400 →
> 1 383 104 → **1 420 824**, finishing **20 968 bytes under** the re-measured ceiling. The ceiling moved once, for a
> measured breach, not to make a build pass.
>
> **Capability position after the phase.** Python outbound is now **gated, not reported**: two named
> members, each with required bound literals and a reviewed transport call-site count, refusing in both
> directions. `research.py` is reviewed at `127.0.0.1` for all three Zotero constants — a revert to
> `localhost` now fails the audit instead of shipping. The connector ping added **no** capability (2 openers,
> 0 `urlopen`, unchanged), and a test asserts its body opens nothing new.
>
> **Real defects found by reading the shipped code, not by design review.** `media/controls.js` read
> `view.authorized`, a field the state model never sends, so "Turn off" never rendered and "Add API key"
> was always unavailable; the card and the Quick Pick each had their own label table for one record; a
> check that answered badly was worded as "not checked yet"; the probe addressed Zotero as `localhost`
> although Zotero binds IPv4 loopback only; and Zotero 10 silently drops a request that does not carry
> `Zotero-Allowed-Request`, which the probe had no category for; the two halves of INT-15 disagreed at their own
> boundary (8 192 write cap against a 4 096 read cap, `>= 0` against `> 0` on the timestamp); and the probe told the
> operator it "writes nothing" after it began writing one machine-level file outside the workspace. All seven are closed
> with a test or a gate.
>
> **Three state classes now exist and are separated by tests.** Machine-level `integration-facts.json` (cap 8 192,
> temp file plus one `os.replace`, seven refusal codes, never a credential, never a workspace path, never a Semantic
> Scholar fact), profile state in `context.globalState`, secrets in `context.secrets`. A machine fact may set
> `installation` **only** — a fresh profile still starts at `awaiting-consent` with no key and no consent inherited.
> Freshness is the Toolkit's own seven days; a stale fact pre-fills the panel without suppressing the check, and a
> machine record never overrules a later check this profile ran. `machinefacts.py` was scanned independently for every
> forbidden and outbound pattern: clean, LF-only, and its name passes `runtime.js` `WORKER_PATH`.
>
> **Open by design, not by omission.** INT-13B verified automatic installation (DD12-15: no publisher
> checksum exists, Linux has no signature, packaged Python is forbidden every process-execution primitive).
> Zotero write access, Zotero cloud, cross-profile secret sharing and an alternative metadata provider stay excluded.
>
> **Still owed before 0.3.11 can be called done.** T12-19 against a **real** Zotero (both endpoints here
> only refuse, so the three-state answer is proven against fakes); T12-16 with a real key; a real 429 from the live
> provider; **two real VS Code profiles of one OS user** (the cross-profile reuse is proven against a seeded machine
> record, not against a second editor profile); `npm run test:host` and `npm run test:browser`, which this container
> cannot run (no `VSCODE_EXECUTABLE_PATH`, no Playwright, and the session's browser cannot reach this host — both
> attempted routes are recorded in acceptance.md §5).
>
> **Closed on 9 November 2026.** The user accepted guided-only installation — DD12-15 stands, INT-13B is not
> implemented and is not to be revisited without a separate capability review — and asked for the work to be committed
> without a tag. Commit `798c41c` carries the whole 0.3.11 tree (phase 11 plus phase 12); the working tree is clean and
> no tag exists. The phase-12 goal stays open in the harness only because marking it complete needs a direct human
> turn.
>
> **Goal round 1 (9 November 2026) — closing review.** Re-ran the whole chain from the committed tree: 352 Python
> passed, 468 Node pass / 0 fail / 0 skipped, audit passed at 110 members / 473 110 packed / **1 420 824 unpacked**,
> payload check passed with 38 commands, artifact digest unchanged from the previous build. Two things the review
> found and fixed: `spec.md` listed INT-13B.1–.5 and INT-13A.4 with no disposition, so the table read as a claim —
> §3.1 now states per requirement what was built and why the rest was not, including that **INT-13A.4 as written asks
> for an unasked re-detect, which 0.3.11's own no-timer rule forbids** (recorded as a requirement defect, not quietly
> rewritten); and `acceptance.md` RG12-A / RG12-C / RG12-E still carried mid-phase figures, now corrected to the
> final ones. Commits `32b3b38` and the acceptance correction; tree clean.



Objective: implement the 0.3.11 brief — one onboarding flow in the Toolkit GUI for Zotero (local API) and Semantic
Scholar (anonymous-first, optional key), with installation, authorization and readiness kept apart, a decision taken
once per VS Code profile and never re-asked in another workspace, keys in SecretStorage only, readiness probed through
the reviewed worker boundary, and the whole thing packaged and audited. Prove it on this container and say plainly what
was not proven here.

Plan of record: [specs/phase-11-integration-onboarding/](../specs/phase-11-integration-onboarding/) —
[spec.md](../specs/phase-11-integration-onboarding/spec.md) (baseline, findings, INT-01…INT-14, NF11-01…NF11-07),
[design.md](../specs/phase-11-integration-onboarding/design.md) (DD11-01…DD11-12),
[tasks.md](../specs/phase-11-integration-onboarding/tasks.md) (25 tasks + the defects closed),
[acceptance.md](../specs/phase-11-integration-onboarding/acceptance.md) (T11-01…T11-20, RG11-A…RG11-E).
Receipts: [evidence/quality-v0.3.11-2026-11-08/](../evidence/quality-v0.3.11-2026-11-08/).
The 0.3.10 state is kept at [.agent/0.3.10/QUALITY_STATE-0.3.10.md](0.3.10/QUALITY_STATE-0.3.10.md).

Status: **0.3.11 implemented, packaged and audited on this Linux development host.** Publication remains open on the
same four human decisions recorded for 0.3.10. A live Windows VS Code session, a real Zotero installation and a real
Semantic Scholar key are **not reachable from this container** and nothing here claims one.

## What is proven (measured, not assumed)

- **Suites**: Node **436 tests, 436 pass, 0 fail, 0 skipped** (46 new: `integrations.test.js` 10,
  `onboarding.test.js` 7, `credential-security.test.js` 9, `integration-host.test.js` 20); Python **273 passed** in
  161.53 s as measured in that run (15 new in `tests/test_integrations.py`; the duration in the receipt is the authority). Receipts: `node-suite.txt`, `python-suite.txt`.
- **Artifact**: `dist/research-stack-toolkit-0.3.11.vsix`, 108 members, 448 515 bytes packed, unpacked **1 343 649** of
  the re-measured **1 376 256** ceiling (32 607 headroom), SHA-256
  `aed24d76db0dda0bb52199c29d1ba067fcebf364152e7a41c52d97c73f5a48fe`; `sourceFilesMatch: true`; two consecutive builds
  byte-identical. `npm run check:payload` → `result: passed`, 38 commands. Receipts: `vsix-audit.json`,
  `payload-check.json`, `vsix-sha256.txt`.
- **The network capability did not move.** `reviewedNetworkBoundary` still names `extension/updates.js` as the only
  packaged JavaScript member with outbound capability; the three new JS modules carry none, asserted three ways —
  `credential-security.test.js::no module in this release can reach a socket, a process or the editor itself`,
  `module-boundaries.test.js`, and the audit's byte scan. The probe is a worker verb
  (`research-stack probe-integrations`) inside the reviewed `runner.js` boundary with a 20 000 ms timeout.
- **The installed payload behaves as designed**: 38 registered commands including the five integration commands; the
  packaged panel HTML carries the Integrations & Accounts section and `data-action="checkIntegrations"`; the packaged
  state carries four dimensions per integration; Zotero `consentRequired: false`, Semantic Scholar
  `awaiting-consent`; no credential variable's value in the panel HTML. Receipt: `payload-check.json`.
- **The live answers on this host are recorded refusals**: Zotero `not-installed` / `ZOTERO_NOT_AVAILABLE` with the
  statement that no library file was opened; Semantic Scholar `auth-required` / `PROVIDER_TERMS_NOT_ACKNOWLEDGED` with no
  request sent; an unknown provider refused naming the accepted ones. Receipts: `probe-receipt.json`,
  `probe-receipt-zotero.json`, `probe-refusal-unknown-provider.txt`.
- **Consent is an operator act.** The modal names the licence URL and states that pressing Activate is not a grant of
  rights; the record stores `acknowledged`, the reference `s2-api-license-2026-11` and the time. Reading the licence does
  not authorize. The Toolkit refuses to record a consent it did not receive.
- **A key goes to SecretStorage and nowhere else.** Proven by asserting the key is absent from the profile state, the
  panel state, the output channel and every message, and present only under
  `researchStack.integration/semantic-scholar/apiKey`.

## Defects found and closed in this release

Found by the wiring tests, not by reading the code; each now has a test that fails if it returns.

1. `lastProbeAt` stored as ISO text while `readRegistry` / `probeCooldown` accept only numbers → the shared check budget
   silently never applied. Fixed with `epoch()` in `integrations.js` and `Date.parse(at)` in `extension.js`.
2. `integrationViews` required a numeric `now` while every caller passed ISO text → the 24-hour staleness sentence could
   never appear.
3. A migrated record could claim a stored key secret storage does not hold → the panel would say "key present" forever.
   The check now reconciles the claim with what it actually read, once, for an authorized integration.
4. A record claiming consent it cannot show kept `readiness: "ready"` → the demotion now resets readiness and the last
   successful check, and says so in `notes`.
5. The unpacked payload outgrew the reviewed ceiling → re-measured to 1 376 256 with the 65 787-byte growth attributed
   member by member (DD11-10), not raised silently.
6. The byte-scan audit matched the word "socket" inside new comments → reworded; the gate now passes on prose as well as
   on code.

## Open items and risks

1. **No live Zotero, no real Semantic Scholar key, no live Extension Host, no Windows host.** `npm run test:host` needs
   `VSCODE_EXECUTABLE_PATH`, which this container does not have. The wiring is proven through the harness and the
   installed payload check; `acceptance.md` names the container-side substitute for every such case.
2. **INT-12 (sharing the decision across VS Code profiles of the same OS user) is deliberately unimplemented.**
   globalState and SecretStorage are per-profile; a cross-profile store needs a location, a format and a threat model
   this release has not written. INT-03 (once per profile) is implemented.
3. **INT-13 (guided Zotero installation through the platform package manager) is deliberately unimplemented**: the
   Toolkit would have to run an installer it has not reviewed. The guide names the official installer.
4. **Zotero write access stays out of scope.** The probe reads; the worker's own detail states nothing was written.
5. **`credentials.configured` is a claim carried from a stored record.** It is reconciled with secret storage the first
   time a check runs, not at activation — reading SecretStorage at activation can prompt on some backends, which is
   exactly the kind of unasked interaction this release is meant to remove. A record that claims a key is therefore
   briefly optimistic until the first check. Recorded here rather than hidden.
6. **The provider's licence terms are external facts.** The Toolkit records that the operator reviewed them and states
   that the record is not a grant of rights; it cannot judge the intended use. If the licence text changes, the
   reference `s2-api-license-2026-11` is the handle that makes the change visible.
7. **Publication remains blocked on the four 0.3.10 decisions** (publisher, credential, repository licence, pre-release),
   plus `@vscode/vsce` staying pinned at 4.0.0 and the two `publishable: false` skill bundles.
8. Carried from 0.3.10: the packaged artifact still carries no Changelog asset; the bundle reference note;
   `dedupe_records.py` unbounded report; T8-18 (the 0.3.8 field re-run).

## Decisions taken in this release

- **Three processes, three dimensions.** Installation, authorization and readiness are stored and worded separately; a
  probe moves only the dimensions it is evidence about.
- **Top-level modules, not a subdirectory** (DD11-02): the packager and the require-scan only see top-level `*.js`.
- **The probe is a worker verb** (DD11-01). No packaged JS other than `updates.js` may reach a network transport.
- **Anonymous-first for Semantic Scholar.** A key is optional, and only the access mode the operator chose hands one to a
  process environment.
- **Consent is a button press after the licence is offered**, recorded with a reference and a time, never defaulted,
  never inferred from silence or from a skipped guide.
- **Off is not deleted** (DD11-11): revoke keeps the record so re-authorizing does not re-run the guide; reset withdraws
  the confirmation and says so first.
- **Nothing probes at activation** (DD11-07); the budget is stored with the record so it is shared across windows
  (DD11-09).
- **Migration reads, never deletes** (DD11-08), and every discarded value is named.
- **INT-12 and INT-13 left open on purpose** rather than implemented without a threat model.

## Final validation — phase 13, tree `653ce9a`, re-run on `484b841` in goal round 2, 13 November 2026

Run in one sweep against the committed tree, working tree clean:

| Check | Command | Result |
|---|---|---|
| Node suite | `cd extension && npm test` | **481 tests, 481 pass, 0 fail, 0 skipped** |
| Panel renderer | `npm run test:panel` (from `extension/`) | **7 assertions, 7 pass, 0 fail, 0 not proven** — named as a gate in this round |
| VSIX audit | `cd extension && npm run verify-package` | **`result: passed`**, `sourceFilesMatch: true`, 1 447 197 unpacked under the 1 507 328 ceiling |
| Packaged entry point | `cd extension && npm run check:payload` | **`result: passed`**, 38 commands |
| Python suite | `uv run --locked python -m pytest -o addopts="" -q tests/` | **386 passed, 0 failed, 0 skipped** |
| Artifact digest | `sha256sum dist/research-stack-toolkit-0.3.11.vsix` | `75c533078febccee78ab6e7273c77a8378fa6d61d8cda72807400277335953a5`, identical across two consecutive builds |

**Consistency review performed.** Every acceptance row in
[specs/phase-13-integration-correction/acceptance.md](../specs/phase-13-integration-correction/acceptance.md) now
names an executed test or is recorded in §3 as not run here; the four rows that had been claimed on the strength of
`test/browser.test.js` were downgraded, then re-earned by `scripts/panel_renderer_check.js`. The gate figures in the
acceptance table, in [evidence/realhost-2026-11-12/README.md](../evidence/realhost-2026-11-12/README.md) and in this
file are the same measured numbers. The defect register is P1–P9, J1–J7, M1–M7 — 21, not 20. The disproven Host-header
hypothesis is recorded as disproven rather than removed.

**What remains owed by the environment, not by the code:** T13-30 a real Zotero 10 on Windows, T13-31 a real Semantic
Scholar key and a real 429, T13-32 a real Extension Host and a real rendered window, T13-33 two real VS Code profiles
of one OS user.

**Goal bookkeeping, recorded so the next round does not re-litigate it.** The objective is met and the sweep above was
re-run in goal round 1 with every gate exiting 0 (`npm test`, `verify-package`, `check:payload`,
`panel_renderer_check.js`, `pytest`). `update_goal action complete` was still refused with "Final validation evidence is
required", and the only field that could carry that evidence — `objective` via `action edit` — is refused in an
automatic round with "this goal operation requires a direct human turn on a top-level agent". The goal therefore stays
active by harness policy, not by unfinished project work. Closing it needs one direct human turn.

## Next highest-value action (0.3.12 era, kept as history)

**On the operator's Windows machine, not in this repository.** Run `python scripts\zotero_local_check.py` there. It is
the instrument that turns "the check did not work" into one of the named states — the setting is off, the port is held,
nothing is listening, or the request itself is being rejected — and it is the only way to confirm which of the
reproduced states the operator is actually in.

Inside the repository, in order: (1) give the readiness probe its own single-attempt bound instead of the research
retry budget, which is the last known overshoot in the check path; (2) ~~wire `scripts/panel_renderer_check.js` into a
named npm script~~ **done in round 2 — it is `npm run test:panel`**; (3) run `node test/browser.test.js` and
`npm run test:host` on a host that has Playwright and `VSCODE_EXECUTABLE_PATH`, and record them as a new evidence
folder.


## Next highest-value action (0.3.13, superseded by the 0.3.14 action list above)

**On the operator's Windows machine, and nowhere else in this container.** Two runs, in this order:

1. `python scripts\zotero_library_audit.py` against their Zotero 10.0.8 — it is the instrument that turns the
   brief's numbers into a repeatable report (counts, records with no DOI/ISBN/URL, `journalArticle` titles that read
   as legal or magisterial texts, access labels in `extra`, `AUDIT SCOPE: complete|truncated`).
2. Then the write path, once, on a library they have backed up: **Research Toolkit: Store the Zotero Write Key**,
   `zotero_write(preview)`, `zotero_write(snapshot)`, `zotero_write(apply)` with `write-to-zotero`, and
   `zotero_write(undo)`. That is **T14-20**, the only requirement of this phase that cannot be produced here, and
   until it is run no sentence in this repository may describe the write path as verified against a live library.

Inside the repository, in order: (1) close **F-01** (`extension/runtime.js:216-225` runs the current checker with
the candidate's interpreter) and **F-02** (`records.py:155` `CLAIM_STATUSES` lacks `draft`); (2) show on the Zotero
integration card whether a write key is stored, so the card matches the command that stores it; (3) run
`node test/browser.test.js` and `npm run test:host` on a host that has Playwright and `VSCODE_EXECUTABLE_PATH` and
record them as a new evidence folder — G2 cannot close without them; (4) decide G3 explicitly: its named candidates
(Qdrant, embeddings, DuckDB) are unimplemented, so G3 is either re-specified or recorded as not closable.
