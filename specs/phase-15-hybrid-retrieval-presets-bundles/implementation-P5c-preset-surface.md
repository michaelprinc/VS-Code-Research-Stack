# P5c — preset surface honesty (0.3.14): renegotiated pins, measured counts, gates

Scope of this package: the preset *surface* — `extension/test/presets.test.js`, the preset enum and
labels in `extension/package.json` + `extension/vsix-manifest.json`, the panel document
(`extension/ui.js`), the panel renderer's preset wording (`extension/media/controls.js`), the controller's
preset state/picker/diagnosis (`extension/extension.js`), the `presetselect.js` boundary statement, and the
panel check (`scripts/panel_renderer_check.js`). `extension/presets.json` was **not** touched: every number
below is read out of it, not written into it.

Requirements this makes testable: HR-10…HR-14, DD15-01, DD15-06, DD15-07, DD15-08, T15-10, T15-11, T15-12.

## 1. Counts measured from `extension/presets.json` on this host (2026-11-18)

Servers: `research_stack.mcp_server` 5 verbs · `research_stack.recommended_server` 5 ·
`research_stack.lab_server` 11 (includes `embed_corpus`) → **21 verbs** in the preset-selectable inventory,
no verb shared between servers.

| Preset | Toolkit verbs | Named external tools | Total | Headroom | Level | Offered by | Default for |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `read-and-cite` | 4 | 0 | 4 | 124 | focused | basic/recommended/full | basic |
| `find-in-notes` | 3 | 0 | 3 | 125 | focused | basic/recommended/full | — |
| `verify-citations` | 2 | 0 | 2 | 126 | focused | recommended/full | — |
| `zotero-handoff` | 5 | 0 | 5 | 123 | focused | recommended/full | — |
| `research-core` | 9 | 0 | 9 | 119 | focused | recommended/full | recommended |
| `research-workflow` | 15 | 0 | 15 | 113 | focused | full | full |
| `research-lab` **(retired)** | 9 | 0 | 9 | 119 | focused | none offered (packages list kept) | — |
| `research-lab-max` **(retired)** | 9 | 0 | 9 | 119 | focused | none offered (packages list kept) | — |
| `corpus-lab` | 12 | 0 | 12 | 116 | focused | full | — |
| `research-max-github-full` | 16 | 92 | **108** | **20** | near-ceiling | full | — |
| `research-max-github-limited` | 20 | 42 | 62 | 66 | watch | full | — |
| `research-max-no-github` | 20 | 0 | 20 | 108 | focused | full | — |

12 presets registered; 2 retired; offered counts: basic 2, recommended 5, full 10.
Budget as shipped: `clientCeiling 128`, `toolkitCeilingPerPreset 20`, `minimumHeadroom 20`,
`accuracyBand 50`, `ceilingWarning 96`, `vendorTokensPerTool 640`.

GitHub counts are **name-list counts** from `research/github-mcp-tool-map-2026-11-17.md` (`[D]` there):
no GitHub MCP server was started in this container, so no `tools/list` measurement backs 92, 42 or 35, and
the preset tips, the panel row and the diagnosis line all say so.
`research-max-github-full` at the vendor estimate: ≈69 120 tokens per request = 54 % of a 128 k window.

Verb distribution the tests now pin:
`research-max-github-full` 16 = 21 − `search_local_text`, `zotero_write`, `prepare_zotero_import`,
`unindex_corpus`, `store_maintenance` (each named in its own tips, HR-14).
`research-max-github-limited` 20 = 21 − `store_maintenance` only — it **keeps** `unindex_corpus`.
`research-max-no-github` 20 = 21 − `store_maintenance`.
`research-workflow` 15 = 21 − `zotero_write`, `prepare_zotero_import`, `unindex_corpus`, `store_maintenance`.
`corpus-lab` 12 = the 11 lab verbs + `read_text_source`.

## 2. Renegotiated pins (old → new, and why)

| # | Where | Old pin | New pin | Why |
| --- | --- | --- | --- | --- |
| 1 | presets.test.js "preset tools come from the shipped worker servers…" | `shipped.size === 20` ("twenty tools across three servers") | `shipped.size === 21`, plus a derived check that it equals the sum of the three server lists | DD15-08: `embed_corpus` joins the inventory. Pinned as a surface, cross-checked against the file so a shared verb cannot hide a double count. |
| 2 | same test | `budget.toolkitCeilingPerPreset === 12` ("C-13: no preset may ship more than twelve") | `=== 20`, read from the shipped budget, and applied to every preset in the loop | HR-13 / DD15-01 (operator raised the cap to 20). The 12 cap was R15-02 — the thing that forced store verbs out of wide presets. |
| 3 | same test | no total-tool rule | `totalTools ≤ clientCeiling − minimumHeadroom` (108) for **every** preset, derived from the budget | T15-12: the cap on verbs alone would let a wide third-party surface lean on it. |
| 4 | same test | `widest = PRESETS_BY_ID["research-lab-max"]`, `toolkitTools === 9`, `thirdPartyTools === 91`, `totalTools === 100`, "at least 28 tools of headroom" | widest derived as the largest `totalTools` across the catalog → `research-max-github-full`, `16 + 92 = 108`, headroom **exactly 20**, `level === "near-ceiling"`; retired `research-lab-max` asserted to carry **0** external tools | R15-11: 0.3.13's changelog called `research-lab-max` the widest preset; it is retired and no longer carries an unnamed estimate. New assertion catches a preset that re-acquires an estimate. |
| 5 | presets.test.js (new test "HR-13…") | — | `Math.max(toolkitTools) === 20`; `108`, `20`, `16`, `92`, `42`, `62`, `0` for the three max presets | T15-12 pinned as shipped surface, with the rule versions alongside. |
| 6 | presets.test.js "the corpus goal registers all twelve corpus and record tools" (0.3.13 wording: 11 verbs, "all ten store tools plus read_text_source") | `corpus.toolkitTools === 11` | `corpus.toolkitTools === 12`, **derived**: equal to `lab_server.tools.length + 1`, with every lab verb (11, derived from the file) asserted present, plus `read_text_source`, plus `servers` deep-equal `[mcp_server, lab_server]` | The lab server now registers 11 verbs including `embed_corpus`, so the corpus surface is 12, not 11. Derived so the next store verb moves the pin by itself. |
| 7 | presets.test.js "the Full default reaches eleven toolkit tools" | `workflow.toolkitTools === 11` | `=== 15` (literal, plan of record §6), with `embed_corpus`, `verify_sources`, `claims_export`, `store_status` asserted individually | HR-10: the journey was broken at the evidence end (`verify_sources` was in `corpus-lab` only). 11 → 15 is the fix. |
| 8 | presets.test.js Quick Pick / status test | `pickedId: "research-lab-max"`, status `…Maximum research lab (128-tool budget) · 9 toolkit tools + 91 configured external tools (vendor estimates)` | `pickedId: "research-max-github-full"`, status `<registry label> · 16 toolkit tools + 92 configured external tools (tools the preset names)` + `!vendor estimates` | T15-11: the external number for a named preset must not be called a vendor estimate. The label is read from the registry so only the numbers are pinned. |
| 9 | presets.test.js "a preset saved in 0.3.13 keeps working across a package change" | 4 assertions about fallback + `presets` list + readiness `Read and cite a document · 4 toolkit tools` | kept, plus `presetRetirement === undefined` when the preset **in force** is a live one | DD15-07: the retirement text must follow the preset in force, not the saved id. |
| 10 | presets.test.js readiness pins | `Selected tools preset: Maximum research lab (128-tool budget) · 9 toolkit tools` (in the Quick Pick test) | `Selected tools preset: Maximum research lab (retired) · 9 toolkit tools` | The registry label changed when the preset was retired; the readiness line must carry the current label and the real count. |
| 11 | new test "the diagnosis line names what the external number is…" | — | `External tools you configured: 92 (the exact tool names this preset selects … a vendor-published name list, not a measurement …)`; `0 (none: this preset names no third-party surface)` for `research-max-no-github`; narrower suggestions derived from `presetsForPackage("full")` | HR-11 honesty for a preset that names tools. The diagnosis previously called every preset's external number a "vendor-published toolset estimate" and could suggest a **retired** preset as "narrower" (it iterated the whole catalog). |
| 12 | new test "the copied preset summary…" | — | `GitHub MCP, every published toolset — 92 tools this preset names by name (vendor-published names, not measured by this extension)`; a retired preset's summary carries the retirement sentence first | HR-11 + DD15-07 in the text an operator pastes into a note. |
| 13 | unit.test.js manifest test | `enum` deep-equal to the literal 10-id list | derived: `["package-default", …registry ids]`, `enum.length === 13`, and exactly two retired ids (`research-lab`, `research-lab-max`) still present | DD15-07: a saved 0.3.13 value must stay a value the editor accepts. Deriving the list catches a preset that joins the settings without joining the registry. |
| 14 | unit.test.js label test (already red at hand-off) | enum labels had to equal registry labels; manifests carried the 0.3.13 labels | manifests now carry `Documents + third-party evidence (retired)` and `Maximum research lab (retired)` | The registry label is the source of truth; the manifests were the stale side, so the manifests moved, not the test. |
| 15 | browser.test.js preset region (never executed here) | 7 preset cards; click `Maximum research lab (128-tool budget)`; `100 of 128`; `find-in-notes` = "2 of 128 / search_local_text, read_document" | 10 cards; retired label asserted **absent**; click `Maximum research: GitHub full plus the whole store`; `108 of 128`, `92 named tools`; `3 of 128 / search_local_text, read_text_source, read_document`; new assertions for the retired-preset panel state | The old file asserted a surface 0.3.14 does not ship. **Not proven here**: Playwright is not installed in this container and this file has never run on this host. |
| 16 | `extension/package.json` + `extension/vsix-manifest.json` | enum/labels 10 entries | enum/labels 13 entries in the same order, retired ids kept with "(retired)" labels, setting description states why retired ids stay | Both manifests moved together; `unit.test.js` deep-equals them and they still do. `version` untouched by this package (it is 0.3.14 because the main agent bumped it). |
| 17 | `extension/ui.js` bundle row | 3 bundle buttons | 3 existing + `forceBundleUpdate`, `bundleArchives`, `restoreBundleArchive`, `configurePresetTools`, plus a disclosure paragraph naming the archive path and "writes no credential" | Panel reach for the commands that already exist; labels do not promise an overwrite ("where a file differs") and do not say "install GitHub". |
| 18 | `scripts/panel_renderer_check.js` | 7 assertions (A–G) | 9 assertions (A–I): H = the four new controls exist in the shipped document with the shipped labels; I = a real retired-preset state renders the retirement in `#preset-note` and `#saved-preset` with 10/10 cards and no "undefined" | Both new rows measure the shipped document/renderer; each names what it does **not** prove (modal, archive-before-overwrite, keyboard/screen-reader behaviour). |

## 3. Coverage that did not exist before (each fails when the behaviour is removed)

- **HR-11 / T15-11** (`"HR-11: a third-party entry's count is the length of the tools it names"`): every
  entry must carry a non-empty `tools` array with no repeated name, `toolsEstimate === tools.length`, a
  `readOnly` boolean, a non-empty `toolsets` list, the reviewed `remoteUrl` form, a named local form, and an
  exclusion list that never overlaps its own selection. Also: the limited preset's 42 names and 14 toolsets
  must be a **subset** of the full preset's 92 names and 21 toolsets, so a preset cannot invent a name.
- **HR-13 / T15-12**: per-preset verb cap and the 108 total rule; widest exactly 108 / headroom exactly 20;
  at least one preset reaches the 20-verb cap.
- **HR-10 / T15-10 (closes R15-01)**: `index_corpus`, `embed_corpus`, `search_corpus`, `evidence_read`,
  `claims_read`, `claims_write` in each of the three max presets; every verb the preset leaves out is named
  in its own tips (HR-14); `research-max-github-limited` `readOnly: true` + `…/mcp/readonly` endpoint + 35
  excluded write names; `research-max-github-full` `readOnly: false` + `…/mcp/x/all`; the destructive pair
  (`unindex_corpus`, `store_maintenance`) present in `corpus-lab` and `research-max-no-github`, absent from
  `research-max-github-full` and `research-workflow`, present-but-partial in the limited preset.
- **DD15-07 / T15-10**: exactly two retired presets; never offered by any package; never a package default;
  successors exist, are not retired and are max presets with more verbs than what they replace; a saved
  `research-lab-max` under Full still resolves and `state.presetRetirement` names it, says "retired in
  0.3.14" and names all three successors with their labels; the panel card list carries no retired entry;
  the Quick Pick carries no retired row but names the retirement on the default row; **both doors** (the
  command and the panel message) refuse a *new* choice of a retired preset with a message naming the
  replacements and leave the saved value unchanged; a live preset gains no retirement text anywhere.
- **Manifest side of DD15-07** (`"a saved 0.3.13 preset id stays valid across the 0.3.14 package change"`):
  both manifests contain every registry id, each label equals the registry label at the same position, and
  each retired label ends with `(retired)`.

Controller behaviour this package added (not only tests):
`presetRetirement(preset, packageId)` exported from `extension.js`; `state().presetRetirement`; Quick Pick
default-row description + placeHolder; refusals in `selectToolsPreset` and in the panel `setPreset` handler;
`presetSummaryText` and `diagnoseToolLimit` now distinguish a named selection from a vendor estimate and say
"none" when there is no external surface; the diagnosis's "narrower presets" now come from
`presetsForPackage` so a retired preset can never be suggested; `media/controls.js` preset rows say "named
tool" and name the basis for a named surface, and paint the retirement when the preset in force has no card.

## 4. Gate results measured on this host

All three gates re-run at 01:00 UTC against the tree as it stood then (`presets.json` sha256
`de4a94c9…db84` verified unchanged after the mutation test in §5):

| Gate | Command (from `extension/`) | Result |

| --- | --- | --- |
| Unit/behaviour suite | `npm test` | **525 tests, 525 pass, 0 fail, 0 skipped** (hand-off baseline was 498 / 495 pass / 3 fail: `presets.test.js` ×2, `unit.test.js` label drift ×1; `module-boundaries.test.js` was also red ×2 while `extension/presetselect.js` was unreviewed) |
| Panel renderer | `npm run test:panel` | **assertions run: 9, pass: 9, fail: 0, not proven: 0** (was 7/7/0) |
| Preset suites alone | `node --test test/presets.test.js test/unit.test.js test/module-boundaries.test.js` | 38 tests, 38 pass, 0 fail |
| Installed payload | `npm run check:payload` | **Red — not from this package's files.** It runs against the freshly built `dist/research-stack-toolkit-0.3.14.vsix` (built 2026-11-18 00:21) and fails on stale preset pins inside `extension/scripts/check-installed-payload.js`, which the main agent is editing live. See §6. |

`check:payload` earlier in this package refused before running — `No artifact for this release:
dist/research-stack-toolkit-0.3.14.vsix. Run npm run package first.` — which is the honest answer until the
main agent builds it. It was not built here.

## 5. Mutation evidence (the new pins bite)

`extension/presets.json` was copied to `/tmp`, mutated, tested, and restored; the restored file's
`sha256` is `de4a94c96544af46815a9befcaa39c72b4fa55024e34b1172f82b9b2a170db84`, identical before and after,
and `"retired": true` appears twice again. Mutations: `toolsEstimate 92 → 91` on the full preset, and
`research-lab-max` un-retired. Result: **6 of 17** `presets.test.js` tests failed with the messages
"the count IS the length of the named list", "16 toolkit verbs + 92 named GitHub tools = 108",
"0.3.14 retires research-lab and research-lab-max, and only those two", "the widest preset is described by
its real counts…", the diagnosis external-tools line, and the copied-summary line — plus 1 `unit.test.js`
failure (the retired-id/label pin). Nothing was re-greened by editing the test back.

A side effect worth recording: `module-boundaries.test.js` failed while a scratch analysis file
(`extension/.tmp-preset-audit.js`) sat in the extension directory — the test refused the unreviewed
`.js` exactly as designed. The scratch file was deleted; no shipped file came from it.

## 6. Handed on (not red because of this package, but red for the release)

`extension/scripts/check-installed-payload.js` — preset pins the main agent is moving live, re-read at
01:00 UTC. Already moved: panel `state.presets.length` 9 → 10; `state.toolSurface.toolCount` 20 → 21; and
the widest-preset block, now `state.presets.find((item) => item.id === "research-max-github-full")` with
`totalTools === 108` and `clientCeiling − totalTools === minimumHeadroom` (lines 259–268). Still stale, with
the measured values they need:

| Line | Stale pin | Must become |
| --- | --- | --- |
| 337 | `/Toolkit contribution now: 11 toolkit tools from 3 managed MCP server\(s\)/` | `15` — **this is the current failure text** |
| 341 | `corpusPreset.tools.length === 11` with the "ten store verbs" comment | `12` (11 store verbs incl. `embed_corpus`, plus `read_text_source`) |
| 343 | `Toolkit tools \\(11\\): …` | `\\(12\\)` |
| 346 | `Selected tools preset: Index, search and record claims · 11 toolkit tools` | `· 12 toolkit tools` |
| 223–226 | probe still named `report.presets.researchLabMax` | works as-is (a retired preset still resolves), but the name should say what it proves; the three max presets' server surfaces (full 3, limited 3, no-github 3) are not probed |
| ~269–280 | panel HTML assertions | four new `data-action`s ship: `forceBundleUpdate`, `bundleArchives`, `restoreBundleArchive`, `configurePresetTools` (proven in `panel_renderer_check.js` row H) |


Documentation status re-checked at 01:10 UTC: `extension/guides/onboarding.md` §5 now carries the 0.3.14
table (4 / 3 / 2 / 5 / 9 / 15 / 12 / 16+92 / 20+42 / 20), the retirement paragraph, and the "What the 0.3.14
max presets changed" paragraph — it is no longer a 0.3.13 surface, and this package did not edit it.
`extension/CHANGELOG*` and `README.md` were not touched by this package.

**One surface inconsistency found while reading `presets.json` (not edited here — the file is out of this
package's scope).** `research-max-github-limited` names 42 read-only names and excludes 35 write names, so
15 of the catalog's 57 read-only names are neither named nor excluded. 14 of them are accounted for: they
belong to the seven toolsets the limited preset drops (`actions` 3, `discussions` 4, `notifications` 2,
`projects` 2, `stargazers` 1, governance reads 2; `copilot` publishes no read-only names). The 15th is
**`ui_get`**, which belongs to the `context` toolset that the limited preset **does** enable, while its
siblings `get_me`, `get_team_members` and `get_teams` are named. With a per-server `tools` allow-list the
omission wins, so the shipped effect is that a "read-only evidence" preset silently drops one published
read-only tool whose toolset it claims to enable. `presets.test.js` cannot see this: it pins 42 names, 35
exclusions, 14 toolsets, the no-overlap rule and the subset-of-full rule, all of which hold. Either the name
joins the list (43) or the guide and the preset tips stop implying that every read-only name in an enabled
toolset is offered.

Not run here: `extension/test/browser.test.js` (Playwright absent) — its preset region was renegotiated to
the measured 0.3.14 surface, so it asserts the shipped design, but no executed proof exists on this host;
`panel_renderer_check.js` rows H and I are the executed substitute for the two panel claims it used to make.

