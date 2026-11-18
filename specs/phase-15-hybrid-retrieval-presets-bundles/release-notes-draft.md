# 0.3.14 release notes — draft for the final stage (figures measured from the tree; the release gate run is still owed)

Drafted 2026-11-17. The wording below is what 0.3.14 must be able to say; every figure is filled in
from what the tree measures before it goes into `extension/CHANGELOG.md`. A line stays in brackets here
until it is measured. Filled 2026-11-17 (P7) from `extension/presets.json`, `src/research_stack/records.py`,
`src/research_stack/vectors.py`, `src/research_stack/presets.py`, `src/research_stack/lab_server.py`,
`extension/bundles.js`, `extension/package.json`, `extension/integrationprobe.js` and
`research/github-mcp-tool-map-2026-11-17.md`. The gate-run line at the end stays open: no 0.3.14 artifact has
been built or audited in this tree, so its test, package and sha256 figures are recorded as owed.

## 0.3.14 — 17 November 2026 · the store retrieves, the presets reach the store, and a bundle you edited is not lost

**Retrieval got a second ranker, and it is honest about what it is.** `search_corpus` now answers in
three modes — `lexical` (the BM25 path, unchanged in ranking and in shape), `vector`, and `hybrid`.
The vectors are computed by the Toolkit's own CPU backend (`rsk-hashing-v1`, 256 dimensions, tokens +
character 3- and 4-grams, signed feature hashing) from the chunk text already in the store: no model
download, no network call, no new dependency, no third-party database. It is a **lexical signature**,
not a semantic model — it reaches `iluminacích` from `iluminace`, and it does not know that
"pilgrimage" and "journey" are the same idea. A stored vector carries the backend id, the dimensions
and the hash of the text it came from, so a backend change forces a re-index instead of quietly
mixing incomparable vectors. `embed_corpus` is the new verb that builds them.

**`lab-state.json` is now derived, not promised.** Every store-writing verb rewrites it from the
database, and `store_status` answers from the same query. The 0.3.13 report was right that the
numbers matched only by accident; the file now says what it is, when it was refreshed, which verb
refreshed it, and which retrieval state the store is actually in (`not-built`, `partial`, `stale` or
`ready`, each with the verb to run), together with `vectorCount`, `currentChunkCount`,
`scoreableChunks` and `staleVectorCount`. A store this build must migrate before it can be read — a
backup or an activated restore on an older schema — is reported as a refusal naming the schema code and
the step to run, never as counters it did not measure.

**Twelve presets, three of them max, and each one names its tools.** `extension/presets.json`
(`schemaVersion: 1`) declares 12 preset ids — ten offered by a package, two retired; `budget.toolkitCeilingPerPreset` is **20** (0.3.13 shipped 12),
`clientCeiling` is 128 and `minimumHeadroom` is 20. The worker registers 21 verbs across the three managed
servers — 5 document verbs, 5 metadata/Zotero verbs, 11 store verbs, `embed_corpus` being the new one.

| Preset | Toolkit verbs | Named third-party tools | Total | Headroom under 128 |
| --- | --- | --- | --- | --- |
| `research-max-github-full` | 16 | **92** — every name in GitHub's published local catalog (`GITHUB_TOOLSETS=all`, remote `/x/all`) | **108** | **20**, exactly the minimum |
| `research-max-github-limited` | 20 | **42** read-only names, behind the server's own read-only switch and an `excludeTools` list naming all **35** write tools | 62 | 66 |
| `research-max-no-github` | 20 | 0 | 20 | 108 |

Each preset names the verbs it leaves out: `research-max-github-full` drops `search_local_text`,
`zotero_write`, `prepare_zotero_import`, `unindex_corpus` and `store_maintenance` (16 of 21);
`research-max-github-limited` drops `store_maintenance`; `research-max-no-github` drops
`search_local_text`. `research-workflow`, the Full default, moves 11 → 15 verbs and `corpus-lab` 11 → 12.
`research-lab` and `research-lab-max` are **retired, not deleted**: `retired: true` with a named
`successor` in the preset file, the ids still registered in `src/research_stack/presets.py` so a saved
0.3.13 preference resolves to a stated retirement instead of falling back in silence, and neither is
offered by any package any more. They are retired because their whole third-party content was an unnamed
estimate (52 GitHub + 24 Playwright + 15 Zotero tools for servers this Toolkit never inventoried), which
the new rule no longer allows — and `research-lab-max` was the preset carrying **no lab verb at all**, the
defect that started this release. Every GitHub figure in the new presets is a name count from the vendor
catalog as recorded in [research/github-mcp-tool-map-2026-11-17.md](../../research/github-mcp-tool-map-2026-11-17.md):
no GitHub MCP server was started here and no `tools/list` was captured.

**A bundle you edited can be updated without losing your edits.** A normal install or repair still never
writes over a file you changed. **Force Update Topic Skill Bundle (Archive First)** plans with
`force: true`, lists every file it would replace and the state it measured for each ("a file you changed
after this Toolkit installed it", "a copy this Toolkit installed, at an older catalog version", "a file
this Toolkit never installed"), says how many a normal run would preserve and the absolute folder the
replaced bytes go to, and writes nothing until you accept. The bytes it replaces are **copied** — before
any target is written, never moved — into `.research-toolkit/bundles/archive/<bundleId>/<archiveId>/`,
where `archiveId` is a UTC stamp plus a sequence (`20261117T205542Z-0001`), keeping each file's
workspace-relative path beside an `archive.json` manifest that carries the sha256 of the archived copy.
`archive/index.json` lists one entry per archive; `archive/archive.log` carries one tab-separated line per
archive whose last field is the **absolute** archive path, so the log reads from anywhere. A damaged index
is rebuilt from the tree and says it was. An archive is never rewritten and never deleted. **Show Bundle
Archive History** lists archives newest first and prints one manifest; **Restore Bundle Archive Version**
hash-verifies the archived bytes into staging, archives what it replaces (reason `restore`) and only then
renames the copies in, and its receipt names the version restored and the version it replaced.

**The integration bounds are settings now.** `researchStack.integrationTimeoutMs` (80 000 ms,
40 000–300 000) and `researchStack.integrationCooldownSeconds` (10 s, 5–300 s) are read in one place,
clamped with a sentence that names what was set and what ran, and feed the worker call, the cooldown
and the card's countdown. The worker README has claimed since 0.3.12 that a timeout setting existed;
in 0.3.14 it does.

**Four new commands, and one of them writes a file you can read afterwards.** `contributes.commands` goes
from 39 to **43**: **Force Update Topic Skill Bundle (Archive First)**, **Show Bundle Archive History**,
**Restore Bundle Archive Version** and **Configure Preset Tools for Copilot**. The last one writes the
selected preset's exact GitHub tool selection into the workspace file the Copilot harness reads for
`mcpServers` (workspace-root `.mcp.json`, per-server `tools` array), keeps a copy of the content it
replaced, refuses to overwrite an entry this Toolkit did not write, refuses the deprecated
`.vscode/mcp.json` `servers` shape because that shape has no tool-subset field, and never writes a token —
the credential appears only as the environment reference `${GITHUB_PERSONAL_ACCESS_TOKEN}`. A preset that
selects no GitHub surface says so and writes nothing.

**Two long-standing defects closed.** F-01: a runtime rollback now names the checker release and the
runtime release and says what their mismatch proves. F-02: `draft` is a claim status.

**Corrected, not rewritten.** The 0.3.13 changelog said the widest preset was "Full research workflow
at 9 toolkit + 91 external = 100"; `research-workflow` was 11 toolkit tools and zero external, and
9 + 91 = 100 was `research-lab-max`. The guide told operators to install the 0.3.12 VSIX. Those
sentences are kept where they were written and annotated here, as 0.3.13's records were annotated
before them.

**What 0.3.14 still does not do.** No embedding model is downloaded and no vector service is
installed: Qdrant, DuckDB, a CPU embedding model, Playwright and institutional adapters stay
`kind: "planned"`, and this release does not change that. No OCR, no automatic full-text download, no
notebook kernel, no delete or merge in Zotero. A real Zotero write on Windows is still owed (T14-20).
G1–G4 remain open, and the GitHub tool numbers in the new presets are vendor catalog names — no
GitHub MCP server was started on the build host, so a `tools/list` on a real host is still owed.

**Measured so far, on the Linux build host (package runs, not a release gate run).** `src/research_stack` and
its pytest suites were exercised by the retrieval package: new `tests/test_vector_retrieval.py` (17 cases)
and `tests/test_lab_state.py` (9 cases), plus renegotiated cases in `tests/test_records.py`,
`tests/test_lab_server.py`, `tests/test_migration.py`, `tests/test_workspace.py` and `tests/test_stdio.py`
(table count 8 → 9, which is what an additive table does). Extension side: `node --test test/bundles.test.js`
**29 pass, 0 fail**; `npm run test:panel` **7 assertions, 7 pass**; the integration-settings package reported
**88 / 88** in its own suites and the rollback package **19 / 19** in `test/runtime.test.js`. The whole
`npm test` suite was last reported at **498 collected / 494 pass / 4 fail** at 22:10 with all four failures
outside the bundle package's ownership and traced to files still being edited by other packages (the 21-verb
pin, the retired-preset label drift between `extension/presets.json` and `vsix-manifest.json`, and
`extension/presetselect.js` not yet in `test/module-boundaries.test.js`'s reviewed module list).

**Still owed before this release is packaged (gate run, host `TBC`).** `npm test` for the whole suite,
`uv run --locked pytest -q`, `npm run verify-package` and `npm run check:payload` for a **0.3.14** artifact,
the artifact's member count / packed bytes / unpacked bytes against the ceiling, and its sha256 — none of
these have been produced for 0.3.14 in this tree. `extension/package.json` and `extension/vsix-manifest.json`
now carry the **0.3.14** stamp and declare **43** commands, but no `research-stack-toolkit-0.3.14.vsix` exists
in `dist/`: `research-stack-toolkit-0.3.14.vsix` was built and audited after this draft was written — 121 members, 561 509 bytes packed, 1 710 211 unpacked, sha256 `dba2c8040aa607e4d3aa4940e4fbd5760502729efba59d69c7eb95e17305f1dc`, `verify-package` and `check:payload` both `result: passed`
new commands, so `check:payload` can only agree with the 43-command pin once the 0.3.14 artifact is built. A
built artifact and its audit are the release package's work; until they exist, the figures above are
host-scoped package measurements and not release evidence.
