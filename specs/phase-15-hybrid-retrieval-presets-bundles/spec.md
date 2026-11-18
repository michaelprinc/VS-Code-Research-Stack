# Phase 15 — hybrid retrieval, distinct max presets, bundle force-update with archive (0.3.14)

Status: **plan of record, 2026-11-17.** Baseline commit `6719415` (0.3.13, no tag).

## 1. Baseline measured before this phase opened

| Measurement | Result on this Linux host |
| --- | --- |
| `npm test` (extension/) | 482 tests, 482 pass, 0 fail, 0 skipped |
| `uv run --locked pytest -q` | 413 passed, 0 failed |
| Toolchain | node v24.22.0, uv 0.3.13-line uv 0.13.6, managed CPython 3.12.16 |
| Working tree | clean at `6719415`; tags exist up to `v0.3.10`; 0.3.11–0.3.13 untagged |

Note: running the python suite re-created `.venv` (the checked-in tree carries a Windows
`.venv`, which uv replaced with a Linux one). `.venv` is ignored; no tracked file changed.

## 2. Findings that drive the phase (each verified in code, not assumed)

| id | Finding | Evidence read |
| --- | --- | --- |
| R15-01 | `research-lab-max`, the widest preset, carries **no lab verb at all**: `index_corpus`, `search_corpus`, `evidence_read`, `claims_read`, `claims_write`, `verify_sources`, `store_status` are absent from it, while the workspace store is full. | `extension/presets.json:276-286` |
| R15-02 | The per-preset toolkit cap (`toolkitCeilingPerPreset: 12`) is what forces lab verbs out of the wide presets; the operator has raised the cap to **20** for this release and asked for **per-preset exact tool selection** rather than whole-server surfaces. | `extension/presets.json:10-11`, operator answer 2026-11-17 |
| R15-03 | Third-party surfaces are carried as a single `toolsEstimate` number per server, so the Toolkit cannot say *which* GitHub tools a preset means, and cannot tell Copilot which subset to enable. | `extension/presets.json:245-306`, `extension/extension.js` `presetEstimate` |
| R15-04 | `researchStack.integrationTimeoutMs` does not exist. `PROBE_TIMEOUT_MS = 80_000` and `PROBE_COOLDOWN_MS = 10_000` are literals in `integrationprobe.js` and tests pin the literals. The worker README claims the setting exists. | `extension/integrationprobe.js:18,25`; `extension/test/credential-security.test.js:140-142`; `extension/worker/README.md` |
| R15-05 | `.research-toolkit/lab-state.json` is written **once**, by `initialize_workspace`. No store verb refreshes it, so its counters and its `vectorSearch: "not-implemented"` claim drift from the DB and from what the build now implements. | `src/research_stack/workspace.py:67-91` |
| R15-06 | Vector and hybrid retrieval are the named unimplemented part of the Full core (G3's candidates). `vectorSearch` is reported as `"not-implemented"` with no code path behind it. | `specs/phase-3/spec.md:11-25`, `src/research_stack/workspace.py:91` |
| R15-07 | A bundle install/repair **refuses to touch** a file the operator edited (`user-modified`) or a file the Toolkit never installed (`conflict`); there is no way to force the reviewed source files back over an edited bundle, and nothing preserves the edited version. | `extension/bundles.js:279-300,402-411` |
| R15-08 | `CLAIM_STATUSES` has no `draft`, against `specs/phase-3/spec.md:42`. (open defect **F-02**) | `src/research_stack/records.py:155` |
| R15-09 | `rollbackRuntime` runs the **installed** checker against the **candidate** runtime's interpreter, and says nothing about that mismatch. (open defect **F-01**) | `extension/runtime.js:216-225` |
| R15-10 | `guides/toolkit.md` still tells the operator to "Install the 0.3.12 VSIX" and names `worker-0.3.13/installation.json`. | `extension/guides/toolkit.md:7` |
| R15-11 | The 0.3.13 changelog claims the widest preset is "*Full research workflow* at 9 toolkit + 91 external = 100". `research-workflow` is 11 toolkit tools and zero external; 9 + 91 = 100 is `research-lab-max`. | `extension/CHANGELOG.md` 0.3.13 entry vs `extension/presets.json:188-311` |

## 3. Requirements

### Retrieval and the store

- **HR-01** Implement stored **vector retrieval** over the existing corpus index: embeddings are
  computed by the Toolkit's own worker on CPU, from the stored chunk text, with no new runtime
  dependency and no network call, and are persisted in the workspace store.
- **HR-02** Implement **hybrid retrieval** that combines the existing BM25 ranking and the vector
  ranking and states, for every returned hit, which rankers contributed and with what score.
- **HR-03** `search_corpus` exposes the mode (`lexical` | `vector` | `hybrid`) without changing the
  provenance shape any 0.3.8+ hit already carries; the lexical default stays byte-compatible.
- **HR-04** The embedding backend is **named and versioned in the store** so a stored vector can be
  traced to the backend that made it, and a backend change forces a re-index rather than a silent
  mismatch.
- **HR-05** `.research-toolkit/lab-state.json` becomes a **derived** record: every store-writing verb
  refreshes it from the DB, `store_status` reports the same numbers, and the file names the vector
  state truthfully (implementation, backend id, dimensions, vector count, last refresh). A reader
  must be able to tell that the file is derived, not a promise made at setup.
- **HR-06** A store that has chunks but no vectors yet says so, and says what to run. It never
  reports a vector search as unavailable without a reason and a next action.

### Presets and the tool surface

- **HR-10** Ship **three distinct max presets**: one with **full** GitHub MCP support, one with
  **limited** GitHub MCP support, one with **no GitHub MCP** at all. Each states its objective and
  carries the toolkit verbs that objective actually needs — the lab verbs are present in the max
  presets (closes R15-01).
- **HR-11** A preset names the **exact third-party tools** it means, not only a toolset estimate:
  per-server allow-lists of GitHub MCP tool names, with the count derived from the list.
- **HR-12** The Toolkit supports **tool selection for GitHub Copilot**: the preset's chosen subset
  is expressed in the form the editor reads (server toolset/environment selection for the GitHub
  MCP server, and the workspace-level allow/deny the operator can approve), written only on an
  explicit operator action, reviewed before writing, and never installed silently.
- **HR-13** The per-preset toolkit cap moves from 12 to **20**; the 128-tool client ceiling and the
  ≥20-tool headroom rule stay, and the budget test is renegotiated to the new cap instead of
  being removed.
- **HR-14** Non-max presets keep their narrow surfaces; a verb that fits an objective is enabled in
  the preset that has that objective (closes the "lab verbs exist in no wide preset" defect).

### Bundles

- **HR-20** A **force update** option lets the reviewed source files of a bundle overwrite files the
  operator edited or that the Toolkit never installed. The force is explicit, modal, and names every
  file it will overwrite.
- **HR-21** Before any overwrite, every file being replaced is copied into an **immutable archive**
  under `.research-toolkit/bundles/archive/<bundleId>/<stamp>/`, the archive is recorded in an
  **index** (`archive/index.json`) and in a **plain-text log** that states the absolute path of the
  archived version.
- **HR-22** Archiving is **scalable**: several archived versions of the same bundle coexist, each
  with its own id, timestamp, reason, file list and hashes; nothing is deleted automatically.
- **HR-23** An archived version can be **listed** and **restored** back into the workspace, and a
  restore of an archive is itself archived (the version it replaces is preserved first).

### Settings, defects, records

- **HR-30** `researchStack.integrationTimeoutMs` and `researchStack.integrationCooldownSeconds`
  exist as real settings, bounded, clamped to a stated range, read by the probe and the model from
  one place, and covered by tests that fail if the two halves drift.
- **HR-31** F-01: a rollback states the checker/runtime version mismatch instead of hiding it.
- **HR-32** F-02: `draft` joins the claim statuses, with the store and the tests updated.
- **HR-33** `guides/toolkit.md`, the changelog and the worker README stop claiming what the build
  does not do (R15-04, R15-10, R15-11).

## 4. Not in this phase (named, not implied)

- Qdrant, DuckDB, a downloaded embedding model, Playwright and institutional provider adapters stay
  `kind: "planned"` in `components.json`. HR-01/HR-02 make retrieval work without them; the
  adapters get a named backend boundary, not an installer.
- OCR, automatic full-text download, writing to a real Zotero on Windows (T14-20), delete/merge in
  Zotero, and starting a notebook kernel stay out, exactly as 0.3.13 stated them.
- No new network-capable code path in the packaged payload. `reviewedNetworkBoundary` must still
  name `extension/updates.js` as the only packaged JavaScript member with outbound capability.

## 5. Operator decisions taken for this release

| id | Decision |
| --- | --- |
| DD15-01 | Per-preset toolkit cap raised to **20**; presets select the tools that suit their objective instead of whole servers; suitable third-party tools are researched and mapped before selection. |
| DD15-02 | Retrieval: dependency-free CPU embeddings + hybrid fusion inside the store. No model download, no new dependency in the locked worker environment. |
| DD15-03 | GitHub MCP: three presets (full / limited / none) with exact tool allow-lists; the Toolkit writes the selection only on an explicit operator action. |
| DD15-04 | Bundle archive lives in the workspace at `.research-toolkit/bundles/archive/<bundleId>/<stamp>/`, keeps **all** versions, and carries both an index and a text log naming the archive path. |
| DD15-05 | Release as **0.3.14**: bump the manifests, run every gate, build and audit the artifact, commit on `main`, no tag. |
| DD15-06 | The headroom conflict the research map names (20 toolkit verbs + 92 GitHub names = 112, headroom 16 < 20) is settled by **trimming the toolkit side, not the GitHub side**: `research-max-github-full` selects **all 92 published GitHub names** and **16** toolkit verbs, giving 108 tools and exactly the minimum 20 headroom. The map's 79-name variant is recorded as the alternative and is not shipped. Chosen because the release's promise is a *full* GitHub preset; a preset that silently drops four GitHub toolsets would not be that. |
| DD15-07 | `research-lab` and `research-lab-max` are **retired, not deleted**: the ids keep resolving so a saved 0.3.13 preference does not fall back in silence, they are no longer offered in the picker, and the panel names their successors. They are retired because their third-party surfaces were unnamed estimates (`github-default: 52`, `playwright-core: 24`, `zotero-community: 15`) that HR-11 no longer allows and that the research map shows to be wrong (45 for the default toolsets, 27 read-only). |
| DD15-08 | The toolkit verb inventory becomes **21** with `embed_corpus`. A preset may carry at most 20 of them, and each preset states which verb it leaves out and why. |
