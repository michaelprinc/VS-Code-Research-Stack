# 0.3.9 skill bundles — what changed, what was measured, what is unresolved

Date: 6 November 2026 (UTC). Scope: the topic skill-bundle subsystem only — the reviewed catalog, the
staged installer, the theological bundle payload, its packaging and its audit. Contracts come from
[specs/phase-9-document-ingestion/design.md](../../../specs/phase-9-document-ingestion/design.md) §3.5
(DD9-16…DD9-24) and requirements R9-14…R9-20. Findings the bundle scripts had to answer come from
[.agent/0.3.9/C-theology-bundle.md](../../../.agent/0.3.9/C-theology-bundle.md) §3, §6, §7, §8.

## 1. Files created and changed

Created:

| Path | What it is |
|---|---|
| `extension/bundles.js` | catalog reader, installer, receipt reader, repair (CommonJS, no `vscode`, no network, no process) |
| `extension/bundles/catalog.json` | the reviewed catalog (generated, never hand-written) |
| `extension/bundles/theological-research/**` | the packaged bundle, 11 files, byte-identical to the staged tree |
| `scripts/build_bundle_catalog.py` | the only producer of the catalog; `--check` makes a stale catalog a failure |
| `extension/test/bundles.test.js` | 17 Node cases |
| this file | the record |

Changed: `templates/skill-bundles/theology/theological-research/{SKILL.md,README.md,references/my-library.md,scripts/dedupe_records.py,scripts/crossref_lookup.py}` (the adaptations in §5), `extension/package.json` (`files`, `scripts.test`), `extension/vsix-manifest.json` (`files`), `extension/scripts/package.js` (stage `bundles/`), `scripts/verify_vsix.py` (inventory, bundle audit, payload ceiling), and — with the parent's explicit approval — `extension/test/unit.test.js` (shipped allowlist) and `extension/test/module-boundaries.test.js` (`REVIEWED` map). No file outside those was touched; `src/**`, `tests/**.py` and `extension/worker/**` were not modified.

## 2. The catalog (`extension/bundles/catalog.json`)

`schemaVersion: 1`, `generatedBy: "scripts/build_bundle_catalog.py"`, `sharedSkillRule`, `bundles[]`,
`unresolvedLicenses[]`. Each bundle carries `id`, `version`, `topic`, `purpose`, `skills[]`, `files[]`
(`{path, sha256, bytes}`), `prerequisites[]`, `provenance` (source snapshot, staged tree, payload tree,
hash method, date, adaptations), `owners`, `license`, `publishable`.

Decisions that the design left open:

- **Path shape.** A file path is relative to the bundle root (`extension/bundles/`), so it starts with
  the bundle id: `theological-research/SKILL.md`. The install target is
  `<workspace>/.github/skills/<skill-id>/…`. A **one-skill bundle** installs its whole payload tree
  under that skill (this is why the theological bundle's payload directory is also its skill directory).
  A **multi-skill bundle** must group its files under a directory named after the skill
  (`<bundle-id>/<skill-id>/…`), so the mapping is never guessed. Both `extension/bundles.js` and
  `scripts/build_bundle_catalog.py` enforce the same rule.
- **Ownership.** `owners` maps every declared skill to exactly one bundle. The catalog reader refuses a
  skill with two owners (`Skill X has two owners … A shared skill has one owner`, DD9-21). A bundle that
  lists a skill it does not own reports every one of that skill's files as `shared-with-other-bundle`
  and writes nothing there.
- **Determinism.** No generation timestamp. Sorted keys, sorted file paths, LF, trailing newline. The
  authored half (id, version, purpose, prerequisites, provenance, license) lives in
  `scripts/build_bundle_catalog.py`; the measured half (sha256, bytes) is never typed. `--check`
  compares the file on disk byte-for-byte with the regenerated one, so a catalog that no longer matches
  its payload fails the build instead of shipping.
- **License gate.** `publishable: true` while `license` starts with `unresolved` is refused by the
  generator, by `readCatalog`/`validateCatalog`, and by `scripts/verify_vsix.py`. The theological bundle
  is `publishable: false`.

Run: `.venv/bin/python scripts/build_bundle_catalog.py` →
`bundles/catalog.json unchanged: 1 bundle(s), 11 files, 60825 bytes, 1 unresolved license(s), publishable=False`

## 3. The installer (`extension/bundles.js`) — the API the control panel should use

Exports: `CATALOG_SCHEMA_VERSION`, `RECEIPT_SCHEMA_VERSION`, `SKILL_ROOT` (`.github/skills`),
`RECEIPT_FOLDER` (`.research-toolkit/bundles`), `STAGING_FOLDER` (`.research-toolkit/bundles/staging`),
`HOST_DISCOVERY_REASON`, `WORKFLOW_TESTED_REASON`, and:

| Function | Shape |
|---|---|
| `readCatalog(catalogPath)` | → validated catalog. Refuses a link, non-JSON, an unknown `schemaVersion`, an unsafe bundle/skill/file id, an absolute path, a drive letter, a backslash, `.`/`..`/empty segments, a path not under the bundle root, a file not under a declared skill, a bad `sha256` or `bytes`, a duplicate entry, a missing `provenance.hashMethod`/`date`, a skill with two owners, `publishable` with an unresolved license. |
| `validateCatalog(catalog)` | the same validation on an object already parsed (used by `bundleFor`, so a hand-built catalog is held to the same rules). |
| `bundleFor(catalog, bundleId)` | → the validated bundle, or a named error listing what the catalog offers. |
| `planInstall({workspaceRoot, catalog, bundleId, existingFiles})` | → `{bundleId, bundleVersion, topic, purpose, skills, prerequisites, license, publishable, workspaceRoot, skillRoot, upgrade, previousVersion, files[], counts, wouldWrite, conflicts[]}`. Writes nothing. `existingFiles` is an object or Map of workspace-relative (or absolute) path → `sha256` or `{sha256}`; the caller is the one that looked. Each `files[]` entry: `{path, skill, target, absolute, sha256, bytes, state, written, reason}`. |
| `installBundle({workspaceRoot, catalog, bundleId, verifyFile?, sourceRoot?})` | → the receipt. `verifyFile({stagedPath, relative, expected, bundleId})` is the injected verification seam (default: hash the staged file and compare). `sourceRoot` defaults to `extension/bundles/`, which is what the shipped extension uses; a test can point it at a fixture. |
| `readReceipt(workspaceRoot, bundleId)` | → the receipt or `null`. A receipt that is a link is refused, not followed. |
| `repairBundle({workspaceRoot, catalog, bundleId, verifyFile?, sourceRoot?})` | → `{…receipt fields, bundleId, repairedAt, repair:{repairedAt, reinstalled[], replaced[], verified[], drift[], retired[]}}`. Refuses to invent a repair for a workspace with no receipt. |
| `digest(buffer)` | the module's own SHA-256 helper, exported so a test measures rather than remembers. |

**States.** `new` (absent, would be written) · `identical` (present bytes are the reviewed file) ·
`outdated` (present bytes are the reviewed file **this toolkit installed and recorded** for an older
bundle version, and the catalog now names a different reviewed file) · `user-modified` (this toolkit
installed it and its bytes have since changed) · `conflict` (a file this toolkit never installed is in
the way, or the path is a link or not a regular file) · `shared-with-other-bundle`.

**Staged install.** Phase 1 copies every reviewed file into
`<workspace>/.research-toolkit/bundles/staging/<bundle-id>/…`, hashes the source against the catalog
and the staged copy against the catalog, and runs `verifyFile` on each. Only after **all** of them
verify does phase 2 touch the workspace. A payload that drifted from the catalog therefore never
reaches `.github/skills/`, and no receipt is written.

**Never overwritten.** Workspace copies use `flag: "wx"`. `user-modified`, `conflict` and shared files
are skipped and reported. The one deliberate exception is `outdated` in an upgrade: the file is one this
toolkit itself installed and whose hash the receipt recorded, so it is written to a unique temporary
name in the same directory, hashed again, the destination is re-checked against the recorded hash, and
only then renamed into place. If the destination moved in the meantime it is reclassified
`user-modified` and left alone. This is the only path in the module that replaces a file, and it is
bounded to files the toolkit owns the previous copy of.

**Never deleted.** The only removal is the staging directory the install itself created. A file the
catalog no longer names is reported as `retired` and left in place. No bundle removes a skill, and none
removes a skill owned by another bundle. A store, a claim and a user document are never on any path
this module writes.

**Three separate statuses (R9-17).** The receipt carries `filesInstalled` (reviewed files in place and
byte-identical to the catalog after the run), `filesWritten` (what this run actually created — so a
reinstall that changed nothing cannot read as an install that did nothing), `preserved`, and:

```json
"hostDiscoveryVerified": false,
"hostDiscoveryReason": "The toolkit wrote the reviewed files into .github/skills/. It cannot observe whether this host's assistant discovers them there: no VS Code or Copilot host is reachable from the machine that ran this install, and the toolkit has no way to ask a host whether it read a skill.",
"workflowTested": false,
"workflowTestedReason": "No workflow in this bundle was run by the toolkit. The bundle's scripts are user-invoked and the installer never runs them, its evals were not scored, and no document of the user's was read."
```

Those two are constants in this module: no code path can set them true.

**Receipt** (`.research-toolkit/bundles/<bundle-id>.json`, written temp-file + rename like the setup
receipt): `schemaVersion`, `bundleId`, `bundleVersion`, `previousVersion`, `upgrade`,
`catalogSchemaVersion`, `installedAt`, `workspace`, `skills`, `license`, `publishable`, `filesInstalled`,
`filesWritten`, `preserved`, `files[]` (`{path, bundlePath, skill, sha256, bytes, state, installed,
installedAt, reason}`), `conflicts[]`, and the three status fields above. `repairBundle` adds
`repair{}` and keeps `previousVersion`.

**Command ids the panel should register** (I did not register or declare them — `extension/extension.js`
and the two manifests are the parent's): `researchToolkit.installBundle` (catalog → `planInstall` →
confirm → `installBundle`), `researchToolkit.repairBundle` (`repairBundle`), `researchToolkit.bundleStatus`
(`readReceipt` + `planInstall`). Each must be added to `contributes.commands` in **both**
`extension/package.json` and `extension/vsix-manifest.json`, which `extension/test/unit.test.js` compares
byte-for-byte, and to `REVIEWED["extension.js"]` in `extension/test/module-boundaries.test.js` once
`extension.js` requires `./bundles`.

## 4. Packaging: bundles are a separate payload group

- `extension/scripts/package.js` stages `bundles/` with the same `cpSync` shape as `media/`, `guides/`
  and `worker/`; the existing LF and 0644 normalisation then applies to it unchanged.
- `"bundles"` added to the `files` array of `extension/package.json` and `extension/vsix-manifest.json`
  (kept byte-equal, as `unit.test.js` requires).
- `scripts/verify_vsix.py` now expects 99 members: `extension/bundles/catalog.json` plus the 11 catalog
  file paths. It refuses an unsafe catalog path at import time, and in `verify()` it checks that the
  packaged catalog equals the repository catalog, that every catalog file is present, hashes to the
  catalog's `sha256`, matches the catalog's `bytes`, and is byte-identical to the staged template tree
  named in `provenance.stagedTree` (the same source-only gate the worker bundle uses). A bundle marked
  `publishable` with an unresolved license fails the audit (DD9-24). The audit result now reports
  `skillBundleCatalog{}` and `reviewedBundleBoundary`.
- **The worker overlay regex was not widened.** `scripts/build_worker_bundle.py:24` and
  `extension/runtime.js:17` accept only `.github/skills/<id>/SKILL.md`, and the theological bundle
  carries `references/`, `scripts/`, `evals/` and `README.md`. Widening that regex would have let the
  overlay writer install unreviewed files into a workspace. Instead the bundle group is recorded in
  `extension/bundles/catalog.json` (which this subsystem owns) and audited from there;
  `extension/worker/bundle.json` was not touched. This is a deliberate deviation from DD9-17's wording
  ("ship inside the worker payload beside the overlay"): the bundles ship at `extension/bundles/`, not
  under `extension/worker/overlay/`, because the overlay inventory and its allowlist are a different
  contract with a different gate. The B audit §11 recommends the same split.
- **Payload ceiling raised deliberately.** `MAX_UNPACKED_BYTES` was `1 * 1024 * 1024` (1 048 576).
  Measured: the 0.3.8 artifact unpacked to **1 035 352** bytes over 87 members; the 0.3.9 working tree
  over those same 87 members measures **1 075 616** bytes — already 27 040 over the old gate before any
  bundle file, from the 0.3.9 worker and guide growth. The bundle adds **60 825** bytes over 11 files and
  `catalog.json` adds **5 536**, so the projected 0.3.9 payload is **1 141 977** bytes. The ceiling is
  now `1_310_720` (1.25 MiB) with those numbers written beside it: 168 743 bytes of headroom, still a
  gate, and the comment says the fix when it is exceeded is to move payload out of the VSIX or
  re-measure — never to drop a reviewed file.

## 5. The theological bundle: every adaptation

Version stays `metadata.version: "2.0"` in `SKILL.md` frontmatter — the single version marker. The
`USER_AGENT` string in `crossref_lookup.py` still repeats `2.0`; keeping the two in step is listed as an
open item.

| File | Change | Closes |
|---|---|---|
| `references/my-library.md` | A banner at the top: **"This file is an empty template."** It states that it is not filled in, that no library inventory is recorded, that every row is a placeholder, and that an installed copy is not a record of the user's holdings. It also states: name the service but never store a credential; the toolkit provisions no licensed database access and checks no entitlement; the toolkit provides a lexical (BM25) index and no vector store, OCR or scanned-image recognition; the installer never reads or rewrites the file. No other line changed. | C §4.1, §7.2, §7.4, §7.5, §7.11 |
| `scripts/dedupe_records.py` | Every dropped record is now printed on stderr with its reason (`DROPPED record 3: dropped - near-duplicate (0.93) …`), and the summary reads `records in: N kept: K dropped: D flagged for review: F`, with a self-check that `kept + dropped == in`. `normalize_doi()` makes `10.x/y` and `https://doi.org/10.x/y` the same identifier (the C audit's Osmer pair is now caught by the DOI rule, not by a title guess). The report line is now `Fields compared: title … and doi …` plus `Not compared: authors. Year is used only to annotate a near-duplicate …` — the old `Fields checked: title, doi, year, authors` named fields it never compared. `argparse` gives a real `--help`, and the input path is an explicit argument documented as resolved against the **current working directory** (the default `records.json` still works); the missing-file message names the cwd it looked in. A final line states that the script verified nothing against a catalogue. | C §3.2, §7.7, §7.8, §7.9 |
| `scripts/crossref_lookup.py` | Service failure is now distinct from "no plausible match": `0` candidate matched, `2` no plausible match (services answered), `3` service failure with no candidate, `4` a candidate was found but a service failed, `5` a candidate was found but author or year disagrees. The old code returned `2` for all of those. `report_service_failures()` prints `SERVICE FAILURE (this is not 'no match'): …` and says the lookup is incomplete. `bare_doi()` normalises OpenAlex resolver URLs to bare DOIs (Crossref already bare), so one record no longer appears as two. The header carries an explicit NETWORK DISCLOSURE block: the two hosts, no credentials, the script is optional, **the toolkit installer never runs it**, the User-Agent address is a placeholder, `--mailto` overrides it. The closing line no longer says "Verified at metadata level"; it says the toolkit did not read the work and access status stays `metadata_only`. | C §3.1, §7.1, §7.6, §7.7, §8 |
| `SKILL.md` | New section **"What this skill assumes about your machine"**: Python 3.12+ as `python3` for the two scripts (stdlib only, no pip, no `uv`, no toolkit venv); network to `api.crossref.org` and `api.openalex.org` only when the user runs the optional lookup, and the installer never runs it; **no licensed database is provisioned** and no entitlement is checked; what the toolkit does provide (local lexical BM25 index, MCP reading tools) and what it does not (vector/embedding search, OCR, scanned-image recognition, automatic downloading of papers); `references/my-library.md` ships empty. §2 now states the toolkit provisions none of the ladder's rungs and checks none of them. §4 states that both scripts are user-run, shows an explicit path argument, lists the new exit codes, and adds: "A script result is a **metadata candidate**, never a verification performed by the toolkit or by the assistant." No sentence claims the toolkit or the assistant validated a source. Body is 115 lines (limit 500). | C §7.3, §7.4, §7.5, §7.10, §8 |
| `README.md` (Czech) | Exit-code table for both scripts, the network disclosure and "instalátor toolkitu ani ovládací panel žádný z nich nespustí", the placeholder-contact disclosure, the explicit working-directory rule, the Python 3.12 requirement, and a note that `npx --yes skills-ref validate` is a development-only command that the toolkit never runs. | C §7.6, §7.9 |
| `evals/evals.json`, `references/{methods,source-evaluation,citation-standards,theology-and-social-sciences,report-templates}.md` | **Unchanged**, as instructed. | — |

## 6. Measured numbers

Node suite (`cd extension && npm test`): **353 tests, 352 pass, 1 fail** — 336 before this change,
+17 from `extension/test/bundles.test.js`. The one failure is not in this subsystem:
`extension/test/presets.test.js:39` asserts the shipped surface is 19 tools and the tree now ships 20,
because `verify_sources` and `index_corpus` were added to `extension/presets.json` and
`extension/worker/src/research_stack/lab_server.py` by the corpus-ingestion work. D9-11 requires that
gate to be updated in the same change; it is the other agent's to close.

Python suite (`.venv/bin/python -m pytest tests/`): **251 passed, 1 skipped, 1 failed** in this tree at
the time of writing. The failure is `tests/test_stdio.py::test_the_shipped_worker_copy_carries_the_same_guarantee`
(the `src/**` ↔ `extension/worker/src/**` copy gate) while that pair was being edited by the other
agent; `tests/test_vsix.py` passes 23/23 with the 12 new members.

Payload: 0.3.8 artifact 1 035 352 unpacked bytes / 87 members / 336 634 packaged bytes; 0.3.9 tree over
the same 87 members 1 075 616; bundle payload 60 825 / 11 files; catalog 5 536; projected 0.3.9 payload
1 141 977 against the new 1 310 720 ceiling.

Catalog hashes (staged tree → payload copy → catalog, all three byte-identical; the 2026-11-05 audit
hash is the pre-adaptation one):

| File | Bytes | sha256 (0.3.9) | sha256 (0.3.8-era audit) |
|---|---|---|---|
| `README.md` | 5 070 | `0998116a9cd7…` | `ab68739b…` (changed) |
| `SKILL.md` | 9 895 | `5f4f9d205f19…` | `52f86ed9…` (changed) |
| `evals/evals.json` | 3 224 | `162a5951eec9…` | unchanged |
| `references/citation-standards.md` | 2 639 | `aae444bcdda0…` | unchanged |
| `references/methods.md` | 4 819 | `ff17c68ab4e0…` | unchanged |
| `references/my-library.md` | 3 188 | `a071dad31f2b…` | `e52a65c1…` (changed) |
| `references/report-templates.md` | 2 545 | `432f41cd49f6…` | unchanged |
| `references/source-evaluation.md` | 3 446 | `cf6ca30ec556…` | unchanged |
| `references/theology-and-social-sciences.md` | 8 106 | `7bc0ed6c0a4e…` | unchanged |
| `scripts/crossref_lookup.py` | 10 701 | `eb5ae6556ed6…` | `544b23d5…` (changed) |
| `scripts/dedupe_records.py` | 7 192 | `8bd24daca167…` | `f045e35e…` (changed) |

Script behaviour was exercised on disposable fixtures with the project venv (Python 3.12.16): a mixed
record set produced `records in: 8 kept: 4 dropped: 4` with all four drops named, the bare-DOI /
`https://doi.org/` pair caught as one work, `--help` working, the default `records.json` path working,
a missing file exiting 2, and a clean input exiting 0. `crossref_lookup.py` was compiled and its
`--help` and exit-code contract checked; **it was not run against the live APIs** — no network call was
made from this work, and the container's outbound access was not assumed.

## 7. Unresolved

1. **License (blocks publication, not installation).** `license: "unresolved — author consent required
   before publication"`, `publishable: false`. No license was invented. The bundle is packaged and
   audited, and three separate gates refuse to call it publishable. A decision from s. Denisa and Michal
   is needed before 0.3.9 is published anywhere outside this repository.
2. **Host discovery and workflow truth.** Both receipt fields are always false with a reason. No VS
   Code or Copilot host is reachable from this container, so nothing here can say a host read the skill
   or that the seven-stage workflow produced a better report. That is a host-side follow-up (R9-22).
3. **`dedupe_records.py` still drops on title similarity.** `NEAR_DUPLICATE_RATIO = 0.92` is unchanged
   on purpose, and it still drops genuinely different works whose titles are close — the fixture
   `Distinct Work A` / `Distinct Work B` is dropped at 0.93. What changed is that the drop is now
   reported with its reason and counted, so the output is a reviewable draft rather than a silent loss.
   A real fix needs author comparison or a human decision rule; that is a 0.4.0 question.
4. **The stderr report is unbounded.** A 3 000-record near-duplicate set still prints thousands of
   lines (C §3.2). Every one is now visible, which is the requirement; a cap or a `--report-file` option
   is not implemented, because hiding records is exactly the defect being fixed.
5. **`USER_AGENT` still carries `set-your-email@example.org`** and repeats the version string. Kept as
   instructed, disclosed in the header, in `SKILL.md` and in `README.md`.
6. **`references/theology-and-social-sciences.md` line 101 still says "Anchors verified in this
   session."** The instruction was not to change the six reference documents' research content beyond
   the `my-library.md` labelling, so it stands. In a shipped bundle that sentence should read
   "author-verified on 2026-10-29", not "this session". Flagged, not changed.
7. **`evals/evals.json` has never been run** — no scored run exists, and `workflowTested` says so.
8. **No 0.3.9 VSIX exists yet.** `scripts/verify_vsix.py` was therefore not run against a 0.3.9
   artifact. Run against the recorded 0.3.8 artifact it fails, correctly, on inventory: the 0.3.8
   archive does not contain the 12 new members. Building a 0.3.9 artifact was not attempted because
   `extension/scripts/package.js` writes `dist/research-stack-toolkit-<manifest version>.vsix` and the
   manifest still says 0.3.8, which would overwrite the released artifact whose digest is recorded in
   `dist/research-stack-toolkit-0.3.8.vsix.sha256`. The audit path is exercised instead by
   `tests/test_vsix.py`, which builds artifacts from the real `extension/` tree including the bundle
   members (23/23 pass).
9. **`extension/bundles.js` is not yet reachable from a shipped entry point.** `module-boundaries.test.js`
   has no reachability rule, so nothing fails today; it becomes reachable when the panel wiring lands.

## 8. Changes needed outside my scope

- **`extension/extension.js`** (parent): register `researchToolkit.installBundle`,
  `researchToolkit.repairBundle`, `researchToolkit.bundleStatus` against the API in §3, and add
  `"bundles.js"` to `REVIEWED["extension.js"]` in `extension/test/module-boundaries.test.js` when it
  requires `./bundles`.
- **`extension/package.json` + `extension/vsix-manifest.json`** (parent owns `contributes.commands`;
  I own only the `files` arrays): every new command needs an entry in **both** manifests, which stay
  byte-equal under `unit.test.js`.
- **`extension/test/presets.test.js:39`**: `assert.equal(shipped.size, 19, …)` must become 20 (and the
  design's "21 across the three servers" reconciled with what actually ships) as part of the
  `index_corpus` / `verify_sources` change. This is the one failing Node case.
- **`tests/test_stdio.py`**: the `src/**` ↔ `extension/worker/src/**` copy gate failed while that pair
  was being edited; the corpus-ingestion owner should re-run it after their edits settle.
- **`extension/runtime.js` / `extension/installer.js`** (parent): if the control panel shows bundle
  status beside the install plan, it should read `readReceipt`/`planInstall` and must not route bundle
  verification through `verifyStepArtifacts` — B audit §11 risk 4 and R9-17 say an overlay receipt is
  not evidence about a bundle.
- **`extension/scripts/check-installed-payload.js`** (not mine): if the release wants the installed
  payload to report bundle state, it should read `extension/bundles/catalog.json` from the installed
  payload and the workspace receipt. Nothing there breaks today.
- **`README.md` / `extension/README.md`** (not mine): a user-facing sentence about what installing a
  bundle does and does not claim belongs there, and it should repeat that `filesInstalled` is the only
  status an automated install may state.

## 6. document-corpus-bridge 2.0 — the second bundle (DD9-23)

**What it was.** `templates/recommended-overlay/.github/skills/document-corpus-bridge/SKILL.md` was authored
on 5 November 2026, during the phase-9 survey, as a workaround for the 0.3.8 indexer's refusal of PDF and
DOCX: the assistant was told to call `read_document`, write one derived Markdown file per document unit,
record the mapping back to the original by hand, and index the derived files. It was **never packaged** —
`scripts/build_worker_bundle.py` iterates an explicit allowlist and the file was not in it — so it sat in the
overlay tree, reviewed, invisible to every gate, and described a job 0.3.9 now does natively.

**What 0.3.9 ships.** The skill is now a reviewed bundle: `extension/bundles/document-corpus-bridge/SKILL.md`,
1 file, 6 972 bytes, owned by its own bundle id, installed to `.github/skills/document-corpus-bridge/SKILL.md`
by the same staged, hash-verified installer as the theological bundle. Its text was rewritten:

- Direct ingestion is stated as the normal path, with the receipt fields the operator must read
  (`status`, `emptySources`, `failedSources`, `partialSources`, `keptPreviousVersion`) and the per-source
  `outcome`, `coverage` and `warnings` from `store_status`.
- The 0.3.8 locators are replaced by the 0.3.9 ones: `page=N;chars=a-b`, `paragraph=N;chars=a-b`,
  `item=N;kind=table-1-row;chars=a-b`.
- `verify_sources` and the default exclusion of stale and unverified references in `claims_export` are part
  of the workflow, not an optional extra.
- The derived-Markdown staging survives **only** as the fallback for files the indexer genuinely refuses
  (over 25 MiB, or extracted text over 5 000 000 characters), and every citation from it must be labelled as
  a citation to a derived copy whose mapping was recorded by hand.
- The closing section states what must not be claimed: that `complete` means correct, that the store judged
  whether a page supports a claim, or that the host discovered the skill.

**Licence.** `toolkit-authored; the Research Stack Toolkit repository is UNLICENSED — publication requires an
explicit licence decision`, `publishable: false`. Packaging is not publication.

**The gate that was missing.** `scripts/build_worker_bundle.py` now compares the overlay tree with its own
allowlist and refuses the build when a template is not named (`assert_overlay_tree_is_reviewed`, tested in
`tests/test_lock_consistency.py`). Without it, the next authored template is skipped exactly as this one was.
