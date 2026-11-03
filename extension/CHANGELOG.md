# Changelog

## 0.3.7 — 2 November 2026 · A shipped lock that matches its own project file, and a refusal that says so

This release answers the report filed against 0.3.6: the VSIX installed and component setup ran, but the isolated worker step failed and the panel read **"Installation incomplete — 1 step(s) verified, 1 need attention (Isolated locked worker (Python 3.12)). 1 of 4 package steps are installed in this workspace."** The step log held the whole diagnosis — ``uv.exe sync failed with exit code 1: Resolved 40 packages in 63ms | The lockfile at `uv.lock` needs to be updated, but `--locked` was provided. To update the lockfile, run `uv lock`.`` in `.research-toolkit/managed/worker-0.3.6`. The cause was in the toolkit build, not in the workspace: `extension/worker/pyproject.toml` declared `version = "0.3.6"` while the `extension/worker/uv.lock` beside it still recorded the root package `research-stack-basic` at `0.3.4`. uv compares a lockfile with the project metadata *before* it honours `--locked`, so it refused the pair on every managed setup and on every uv version. It is a packaging defect in the toolkit build — not a network, proxy, interpreter or workspace problem — but 0.3.6 reported it as a generic step failure, which is why it took a field user to find it.

**The shipped pair, repaired with provenance**

- `extension/worker/uv.lock` was regenerated with a pinned uv 0.13.6 rather than hand-edited: `revision = 3 → 5` and the root entry `version = "0.3.4" → "0.3.7"`. The 40-package resolved set and the 39 third-party version pins are unchanged, and the regenerated file is byte-identical to the packaged one (`evidence/quality-v0.3.7-2026-11-02/lock-provenance.json`).

**Setup refuses its own build before it touches anything**

- New reviewed module `extension/lockfile.js`: a uv-free reader of `pyproject.toml` and `uv.lock` that reports every reason uv would call the pair stale — the lock's root package name and version, `requires-python`, the dependency specifiers and the dependency groups — and recognises uv's refusal from uv's own sentence (`DRIFT_SIGNATURE`), never from an exit code. It starts no process and writes nothing.
- `setupRuntime` in `extension/runtime.js` compares the bundled pair before it takes the setup lock, creates a directory or starts a process, and refuses a build whose pair disagrees: *"This toolkit build ships a locked dependency file that does not match its own project file: … No process ran and no file was written. Reinstall the Research Stack Toolkit VSIX; this is a defect in the toolkit build, not in this workspace."*

**One recorded fallback, never a silent one**

- The worker step still runs `uv sync --locked …` first. Only when uv's refusal is recognised as lock drift does it run exactly one `uv sync --frozen …`, which installs exactly the packages the shipped lock pins without rewriting it (`extension/runtime.js`). `lockFallbackNote` in `extension/steps.js` puts the detection, the problems and uv's own message into the step evidence, so the panel, the receipt and **Copy Installation Diagnostics** all name a fallback install as a fallback.
- Lock drift is not retried as a transient failure. The toolkit never runs `uv lock` inside a managed runtime — `extension/worker/bundle.json` hashes the shipped lock and `validateWorker` verifies that hash — and never issues a plain unlocked `uv sync`.

**Failure text a user can act on**

- `extension/runner.js` describes a lock refusal as a lockfile and a project file that do not match, explicitly *not* a network, proxy or interpreter problem, and keeps uv's own lines and the cwd. A timeout now reports the bound per attempt, how many attempts ran, and the total time waited across them.
- `runner.setupEnvironment` strips the 15 `UV_*` names that change what the reviewed command means (`UV_INDEX`, `UV_INDEX_URL`, `UV_DEFAULT_INDEX`, `UV_EXTRA_INDEX_URL`, `UV_FIND_LINKS`, `UV_NO_INDEX`, `UV_LOCKED`, `UV_FROZEN`, `UV_UPGRADE`, `UV_NO_SYNC`, `UV_OFFLINE`, `UV_NO_DEV`, `UV_SYSTEM_PYTHON`, `UV_EXCLUDE_NEWER`, `UV_PYTHON_PREFERENCE`) before applying the reviewed environment, so a host mirror or a stray `UV_LOCKED` can no longer make a correct lock look stale.

**Build gates**

- `scripts/lockintegrity.py` is the uv-free pair reader, and a CLI (`python3 scripts/lockintegrity.py`, exit 1 on drift). `scripts/build_worker_bundle.py` refuses a stale source pair before anything is staged, and re-checks the built worker pair before `bundle.json` is written; `scripts/verify_vsix.py` refuses a packaged worker or packaged notebook overlay whose pair is stale; `tests/test_lock_consistency.py` gates the repository pairs, the bundled bytes against the repository bytes, the unchanged pins, the lock revision the declared uv floor can read, 37 synthetic pair fixtures, the bundle builder's refusal and acceptance, the CLI's exit codes, and uv's own `uv lock --check` when `RESEARCH_STACK_UV` names a real uv.
- `npm run verify-package` and `npm run check:payload` derive the artifact path from `extension/vsix-manifest.json` through `extension/scripts/with-artifact.js`, so a gate can no longer audit the previous release's bytes.

**Timeouts and the reading check**

- The MCP reading check honours the operator's bound — `Math.max(90000, researchStack.setupTimeoutSeconds)` — instead of a fixed 90 s floor (`extension/runtime.js`), so a longer setup timeout is not silently cut by the check that follows the sync.

**Release identity and verification**

- Version 0.3.7 in `pyproject.toml`, `src/research_stack/__init__.py`, `extension/package.json`, `extension/vsix-manifest.json` and `extension/runtime.js` `WORKER_VERSION`; the managed worker folder is `.research-toolkit/managed/worker-0.3.7`. A four-part version such as `0.3.6.1` cannot be packaged at all: `@vscode/vsce` validates the extension manifest with `semver.valid`, which accepts at most three numbers ([microsoft/vscode-vsce #415](https://github.com/microsoft/vscode-vsce/issues/415), closed as designed), so the release is 0.3.7 and `tests/test_release_identity.py` now rejects any identity the packager would refuse.
- `cd extension && npm test` → **250 passed, 0 failed** across the sixteen test files the script runs, new `test/lockfile.test.js` (24 tests over the pyproject/uv.lock reader, uv's refusal signature, the shipped worker pair and the shapes real uv writes for extras, markers, dependency groups, optional dependencies and TOML literal strings) and `test/lockfile-adversarial.test.js` (73 tests over 69 synthetic pairs, each with its uv verdict measured) among them. `.venv/bin/python -m pytest` → **185 passed** with `RESEARCH_STACK_UV` naming a real uv, **184 passed + 1 skipped** without one; the skip is `tests/test_lock_consistency.py`'s `uv lock --check` gate, and that file holds 65 tests. `dist/research-stack-toolkit-0.3.7.vsix` (86 files, 312 471 bytes) passes `npm run verify-package`, including the packaged-pair check, and `npm run check:payload`. Receipts: `evidence/quality-v0.3.7-2026-11-02/`.
- Detection is signature-based because uv's refusal exit code is not stable: on a drifted pair uv 0.8.5, 0.9.30, 0.10.7 and 0.13.6 exit 1 while uv 0.5.0, 0.6.10 and 0.7.22 exit 2, all seven printing the same sentence (`evidence/quality-v0.3.7-2026-11-02/uv-matrix.json`).
- Out of scope for this release, unchanged from 0.3.6: the real reference-host receipts for the G1–G4 profile gates on Windows 11 x64 / VS Code Desktop 1.141.0, including the Extension Host and browser renderer receipts, are **still outstanding**, and the reported field workspace has not yet been re-run with this VSIX. Basic and Research remain prototypes; the toolkit still does not install uv itself, does not run setup silently or in the background, does not execute notebook kernels, does not connect to external providers, and does not build the extraction-to-index bridge. This version does not complete G4.

### Repaired after the release was reviewed (same 0.3.7 artifact)

The tagged 0.3.7 build was then reviewed by four independent passes — a Windows portability review, an
end-to-end install of the packaged VSIX, an adversarial test campaign against both dependency readers,
and a claims audit of the release documentation. Each finding below was confirmed by a probe or a test
before it was fixed; the full record is [review-findings.md](../specs/phase-7-lock-integrity/review-findings.md).

- **The artifact was not reproducible from the tag.** 17 of its 86 members (16 guides and `extension/media/toolkit.svg`) carried CRLF in the VSIX while the committed tree holds LF, so a fresh clone built a different digest. `extension/scripts/package.js` now normalises the staged tree to LF and `scripts/verify_vsix.py` refuses CRLF in any packaged text member; the payload comparison is line-ending-normalised so a member that only matches after rewriting is caught by the reproducibility invariant, not silently accepted.
- **A host `UV_*` setting survived the scrub if Windows spelled it differently** (`Uv_Index_Url`, `uv_locked`). The deny-list is now matched case-insensitively and also drops the five reviewed names and the derived `UV_PROJECT_ENVIRONMENT`, so no spelling of a meaning-changing name reaches uv and no name appears twice in the child environment.
- **A fallback install was reported as a clean install.** The panel headline, the step row and **Copy Installation Diagnostics** now name a lockfile fallback, and the marker survives into the status record.
- **When the reviewed fallback itself failed, the first refusal disappeared** and the operator was left with a network-looking error for a lockfile problem. Both sentences are now reported, with the attempt count and the fallback marker on the record.
- **The notebook step had no fallback tier** and resolved uv without the workspace roots, so a workspace-local uv could have been executed after the resolver refused it. It now uses the same gated one-shot tier as the worker step, with the same refusal when the toolkit's own reader agrees the pair disagrees.
- **A lock refusal was described as a mismatch of the shipped pair**, which is false in exactly the case the fallback exists for. The wording now names it a lockfile disagreement and says the toolkit's own check decides which side disagrees.
- **A lock-drift refusal carried no kind, exit code or hint**, so the next-action table answered "Retry this step" to a build defect. Both refusal sites keep the runner's metadata and carry the reinstall hint.
- **The command an operator is told to re-run was not pasteable** when a path contains spaces — the reported field workspace is such a path. Arguments containing whitespace are now quoted.
- **A 0-byte `uv.exe` in a documented Windows location was offered as a usable tool.** It is now refused as unusable.
- **Both dependency readers were hardened against 22 measured divergences from uv** (markers, extras, `requires-python`, hand-edited transitive pins against their artifact filenames, deleted and duplicated `[[package]]` blocks, `[tool.uv]` source mode and resolution inputs, `dynamic`, PEP 440 normalisation, PEP 735 `include`, BOMs, single-quoted and triple-quoted scalars, indented keys, stray local entries). `extension/test/lockfile-adversarial.test.js` keeps 69 synthetic pairs with the uv verdict measured for each: 67 agree, 1 is a deliberate divergence recorded with both verdicts (a lockfile revision above the toolkit's support ceiling, which uv itself reads), 1 is a named gap. That suite is now part of `npm test`.
- **The two readers disagreed with each other** on the PEP 735 `{ include = "dev" }` group reference and on `dynamic = ["dependencies"]`: the JS reader reported drift where the Python reader was silent, so `npm run package` and `python3 scripts/lockintegrity.py` could answer the same pair differently. Measured with uv 0.13.6 and uv 0.5.0: `{ include-group = … }` is what uv 0.13.6 accepts and flattens, `{ include = … }` is refused by 0.13.6 whatever the lock says and was locked as an empty group by 0.5.0. Both readers now flatten only the first, name the second as a construct neither can certify, skip the manifest-half comparison for a dynamic dependency list and check the root entry's resolved dependencies instead — the comparison uv's own `lock --check` actually makes. Run over the same 69 pairs: 0 verdict divergences.

What this host cannot prove: the Windows-specific repairs (the case-insensitive `UV_*` scrub, the
empty-`uv.exe` refusal, the quoted re-run command) were verified on Linux against simulated Windows
paths and a Windows-shaped environment, not on a Windows host. The MAX_PATH headroom a deep workspace
plus the managed worker path leaves, and what happens to a grandchild process when a step times out on
Windows, are recorded as open risks in [review-findings.md](../specs/phase-7-lock-integrity/review-findings.md)
and are not claimed as fixed.

## 0.3.6 — 1 November 2026 · Component installation that works, and a status that says what happened

This release answers the report filed against 0.3.5: the VSIX installed and activated, but **no component was installed** and the panel said only "Not installed in this workspace". The causes were host-tool lookup limited to the editor process `PATH`, subprocess failures collapsed into three canned sentences, a 240 s first-run timeout, a plan that aborted at the first failure, a lock with no age or owner check, and a GUI with no verdict. Each is fixed, and the install path is now split into modules that can be tested on their own.

**Host tool resolution**

- `uv` is resolved in a fixed order: `researchStack.uvPath`, then absolute `PATH` entries, then a bounded list of documented install locations for the platform (Windows: `%USERPROFILE%\.local\bin`, `%LOCALAPPDATA%\Programs\uv`, `%APPDATA%\Python\Python312\Scripts`, `%APPDATA%\Python\Scripts`, scoop shims, WinGet Links, `C:\Program Files\uv`; macOS/Linux: `/usr/local/bin`, `/opt/homebrew/bin`, `/usr/bin`, `~/.local/bin`, `~/.cargo/bin`, `$XDG_BIN_HOME`), then the workspace's managed toolkit folder. No recursive search and no home-directory walk.
- A found tool is version-probed with `uv --version` under a bounded timeout, reading both output streams. A tool whose version command fails, or whose version is below the registry minimum (`minimumVersion: "0.5.0"` for uv in `components.json`), is reported as unusable with the version found and the version required — never as installed, and never used by setup. A workspace-local executable is still refused as a host tool.
- A host tool that exists but cannot be used is named as itself, not as missing: a file that is not executable reports `uv was found at <path> but it is not executable`, and a `uv.cmd` or `uv.bat` batch wrapper is reported as a wrapper setup cannot launch directly, with `researchStack.uvPath` pointed at the `uv.exe` it calls — and is never started. A `researchStack.uvPath` that is quoted, relative, a directory, or ends in a separator or a space reports `uv was not used: the configured path "<value>" <why>` instead of "not found". Relative `PATH` entries are refused and counted in the "searched" summary, and duplicate entries are probed once.
- A "not found" result names the categories searched and how many directories each held, and points at `researchStack.uvPath` as the remedy. Resolution results are cached per session and re-checked when the setting or the workspace folders change.

**Preflight, lock recovery and plan continuation**

- Before any component command, a preflight reports workspace trust, a local (non-remote) desktop workspace, the host tools the plan needs from the component registry, the managed path being a real directory rather than a link or junction, workspace writability, and the setup-lock state. A blocked preflight writes a status record with outcome `blocked` and touches no file and no process; each failure names the action that clears it.
- The setup lock is classified `free`, `held`, `stale` or `invalid`. The setup window is derived from the plan's own timeouts — each selected step's timeout (or `researchStack.setupTimeoutSeconds`, whichever is longer) doubled, plus a margin — so a legitimately slow setup is never mistaken for an abandoned one. A lock older than that window is `stale` even if its recorded pid now belongs to a different process; a lock younger than the window is `held` while its owner is alive, and becomes `stale` once the owner is gone or after a minute if its contents could never be read (a crash between claiming the file and writing it is aged by the file's own modification time). A lock that is a directory or a link is `invalid` and is named with the remedy. **Clear Interrupted Setup Lock** removes only a `stale` lock or the link at the lock path, never a live one, and a plan that finds a stale lock clears it before acquiring its own instead of aborting with no verdict.
- A failing step no longer aborts the plan. Independent steps continue (the research overlay needs no interpreter), steps that depend on the failure are recorded as `blocked` with `blockedBy`, and a blocked step is never recorded as installed. **Retry Failed Component Steps** re-runs the failed steps and the steps blocked by them, keeping completed work.
- Transient failures — a timeout, output over the capture limit, or network-flavoured tool output — are retried once with a bounded delay, and both attempts are recorded. A launch failure (`ENOENT`), a cancellation or an explicit refusal is not retried.

**One bounded process boundary**

- Every external tool run now goes through `extension/runner.js`: one `execFile` call site with `windowsHide: true`, `shell: false`, an 8-second default timeout for probes, an 8 MiB output cap and bounded report text. A failure returns a structured `RunError` carrying the command, arguments, working directory, exit code, signal, stderr tail and duration, and the message an operator sees is assembled from those — no canned sentence replaces them.
- Setup runs with a reviewed uv environment: pinned Python 3.12, copy link mode, no progress spinners, no user config file, and a workspace-contained project environment. The worker and notebook syncs honour `researchStack.setupTimeoutSeconds`.

**Installation status you can read and act on**

- New **Installation status** card in the control panel: the overall outcome, package, toolkit version, workspace folder, last attempt and duration, then a row per step with its status, duration, attempt count, exit code, the command that ran and its error, plus the host tools setup resolved, the setup log and status record the verdict came from, the live setup-lock state, and the next action. The wording is exactly one of: `Installation complete — N component step(s) verified.`, `Installation incomplete — N step(s) verified, M need attention (step ids).`, `Installation failed — <step>: <error>.`, `Setup blocked — <reason>.`, `Setup cancelled — N step(s) already completed were kept.`, `No component setup has run in this workspace yet`, or — when the record on disk is present but is not readable JSON — `The recorded setup status could not be read. Run Set up package components again to get a verdict.` A verdict recorded by an earlier release is qualified with `Recorded by toolkit <version>; this release has not run in this workspace yet.` instead of being reused as this release's result.
- The card is re-checked against the workspace when it reopens: a step recorded as installed whose files are no longer present is shown as `recorded as installed, files missing` with the missing paths, and a recorded `Installation complete` becomes `Installation incomplete` naming those steps. A step is never counted in "N verified" and in "M need attention" at the same time.
- A success verdict is earned, not assumed: every selected step is only counted when the files it was supposed to produce were re-checked on disk after the run — for the worker step, `.venv/bin/python` on Linux/macOS, `.venv/Scripts/python.exe` on Windows, and the managed `src/research_stack/mcp_server.py`. A step that exits 0 and leaves no interpreter produces `Installation incomplete` with the missing file named.
- Evidence stays in the workspace: `.research-toolkit/logs/last-setup.json` (the status record the panel reads when it reopens, so the verdict survives a reload) and `.research-toolkit/logs/setup-<timestamp>.jsonl` (append-only attempt log). The status record is written atomically — validated temporary file, then rename — the log is append-only, and neither record contains document text or secrets. The bootstrap workspace's `.gitignore` now ignores `.research-toolkit/logs/` alongside the existing derived-data rules.
- New commands (25 in the manifest): **Retry Failed Component Steps** (`researchToolkit.retryFailedSteps`), **Clear Interrupted Setup Lock** (`researchToolkit.clearSetupLock`), **Open Setup Log** (`researchToolkit.openSetupLog`) and **Copy Installation Diagnostics** (`researchToolkit.copyInstallationDiagnostics`), which copies the verdict, host tools, preflight results, per-step attempts and the log file path to the clipboard.
- New settings: `researchStack.uvPath` (string, default `""`, application scope) and `researchStack.setupTimeoutSeconds` (number, default 900, 60–3600).

**Module boundaries**

- The install path is split so it can be tested and changed in isolation: `hosttools.js` (resolution), `runner.js` (the single process boundary), `preflight.js`, `setuplog.js` (log and status record), `steps.js` (the four step bodies), `installer.js` (plan engine: selection, status, artifacts, receipt), `status.js` (outcome computation and human wording, pure), `runtime.js` (bundle and managed runtime), `diagnostics.js` (inventory and text rendering, no process spawn). `extension.js` keeps activation, command registration and panel wiring. Each new module takes injected services and has its own test file.
- The VSIX inventory and the audit's reviewed process-boundary pattern move to `extension/runner.js`; a second boundary or a new network capability still fails the audit.

**Release identity and verification**

- Version 0.3.6 in `pyproject.toml`, `src/research_stack/__init__.py`, `extension/package.json` and `extension/vsix-manifest.json`; the managed worker folder is `.research-toolkit/managed/worker-0.3.6`. Runtimes an earlier release installed stay discoverable and rollback-able.
- Covered by the new node test files `test/hosttools.test.js`, `test/runner.test.js`, `test/preflight.test.js`, `test/setuplog.test.js`, `test/status.test.js`, `test/steps.test.js`, `test/module-boundaries.test.js` and `test/gui-status.test.js`, alongside the 0.3.5 regression tests for step selection, artifact repair, rollback and preset identity.
- Out of scope for this release: installing uv itself, silent or background setup, notebook kernel execution, external provider connectivity, the extraction-to-index bridge, and the G1–G4 acceptance gates. The real Extension Host and browser renderer receipts for 0.3.6 are **still outstanding** on the Windows 11 / VS Code 1.141.0 reference host, and this version does not complete G4.

## 0.3.5 — 31 October 2026 · Repairable setup, durable evidence, and one continuous research workflow

This release answers the 0.3.4 quality and development review (findings F01–F18). It stabilizes what 0.3.4 shipped before adding anything, and turns the review's probes into permanent regression tests.

**Store integrity (the record store is now safe to trust with your own corpus)**

- A store path that is a symlink or a Windows junction is refused (`PATH_IS_LINK`) instead of followed; the same guard covers the store directory, the backups directory and every relative write target.
- A store from a **newer** schema is refused with `STORE_SCHEMA_UNSUPPORTED`, and an unreadable one with `STORE_SCHEMA_UNKNOWN`; a schema-version-1 store is migrated to version 2 explicitly (indexes dropped before columns), never silently relabelled. A store that is not a database at all is reported as `STORE_CORRUPT` rather than as a raw driver error.
- Re-indexing a source that is now empty retires its chunks and reports `emptySources`, so an emptied file stops being searchable instead of serving stale text. Re-indexing or `unindex_corpus` **never deletes evidence a stored claim still cites**: the chunk is retained, reported in `retainedEvidenceChunks`, and the claim's link is flagged `stale` while staying `resolvable`.
- `backup` writes through SQLite's online backup API, runs `PRAGMA quick_check`, records the sha256 and counts, and never overwrites an existing file (`writeMode: "new-file-only"`). `restore` stages a validated candidate under a temporary name and only activates it after you confirm, preserving the previous store as `research-pre-restore-*`. `vacuum` still requires a prior `status` review and an explicit confirm.
- Reads use a read-only connection; the seven reviewed tables (`meta`, `sources`, `source_versions`, `chunks`, `claims`, `claim_evidence`, `claim_events`) are the whole schema, and SQLite internals are not reported as components.

**Record semantics**

- `claims_read` filters in SQL before applying its limit, pages with a keyset cursor (`nextCursor`, `matchingClaimCount`) instead of skipping rows, and returns each claim's edit history from `claim_events`.
- `claims_write` with an existing `claim_id` patches that claim instead of creating a duplicate; an `idempotency_key` makes a retried write return the original claim. Evidence links carry `role` and `rationale`, and are reconciled against the index on every write.
- New verbs: `unindex_corpus`, `evidence_read`, `claims_export`, `store_status`. `claims_export` emits a report reference only when the cited file still exists with the recorded hash. The everyday workflow verbs are separated from the destructive maintenance verbs in the read-only/destructive annotations.

**Extraction and citation integrity**

- DOCX reading walks the document **body** in order, so paragraphs and tables come out in the order you see them (`docxOrder` regression test) instead of all paragraphs first, then all tables.
- `read_text_document` supports locator and range navigation with adjacent context and reports `coverage`; a locator that no longer matches the file returns `LOCATOR_STALE` rather than wrong text. `read_text_source` is now a shipped tool so a search hit can be reopened.
- `validate_sources` verifies each path inside the workspace and its recorded hash (`SOURCE_HASH_INVALID`, `SOURCE_NOT_FOUND`, `SOURCE_HASH_MISMATCH`, `SOURCE_OUTSIDE_WORKSPACE`) and returns a `verifiedPath`; `resolve_evidence` fails closed with `EVIDENCE_UNRESOLVED`.
- DOI normalization keeps balanced punctuation (`10.1234/example(2026)` survives), Crossref requests always send a `User-Agent` (`ResearchStack/<version>`, with `mailto:` when `CROSSREF_MAILTO` is set) for search and citation validation alike, provider rows that are not objects or carry neither a title nor a DOI are skipped and reported (`skippedRows`, `PROVIDER_ROW_SKIPPED`), null author lists no longer crash a provider, and when every provider fails the result says `resultState: "unavailable"` with `providersAttempted`/`providersSucceeded` instead of presenting an empty list as a complete answer.
- Exact-DOI merging keeps the observations and conflicts it collected, recomputes derived fields, and reports `access { status, url, license, retrieved }` from the provider's open-access record. Markdown and DOCX reports are rendered from one shared block model, so both formats carry the same headings, bullets, numbered items and tables.

**Setup that reports what it actually did**

- A step counts as **installed** only when the files it produced are still on disk. A recorded step whose artifacts are gone is **needs repair** and is re-run by **Update or repair component steps**; an optional step you did not install is reported as a **deliberate omission**, not as a missing requirement.
- A step that needs another step now pulls the prerequisite closure in and explains why (`explainStepSelection`), instead of failing the click with an unusable error.
- The setup receipt and the active-runtime pointer are written atomically (temp file + rename, JSON validated before publishing), and one `.setup.lock` covers the whole plan so two windows cannot interleave steps.
- The notebook step verifies that `notebooks/analysis` really is the reviewed `research-stack-analysis` project, refuses a reparse-point `.venv`, and records the interpreter version plus `importsVerified` after importing `ipykernel` and `matplotlib` in the environment it created.
- Overlay files are classified on re-run as unchanged or **changed by you and preserved**, with the classification reported in the run result.
- New commands **Refresh Component Status** (re-reads the plan and re-verifies produced files, and states that the functional MCP check was not run) and **Roll Back Managed Runtime** (lists the managed runtimes in the workspace, re-verifies a candidate with the real reading check, then activates it). A previous release's runtime stays on disk instead of being orphaned.

**Tool surface and UI state**

- New **`research-workflow`** preset (11 tools) is the Full package default and carries the whole journey: `read_document`, `read_text_source`, `search_local_text`, `write_markdown`, `write_docx`, `search_literature`, `check_citation`, `index_corpus`, `search_corpus`, `evidence_read`, `claims_read`, `claims_write` — read a source, index it, search it, reopen the passage, resolve the evidence, record the claim, and write the report. `corpus-lab` now carries all ten record-store/document tools. No preset exceeds 12 toolkit tools and the widest keeps ≥20 tools of headroom.
- The MCP definition version is now `0.3.5+<presetId>:<tool-surface hash>`, so a saved preset change is visible to the client instead of being cached away; the panel distinguishes the preset you **saved** from the one currently **applied**.
- Context figures state their basis — **measured from this worker's `tools/list`**, **partial**, or **vendor estimate at 640 tokens per tool definition** — and the preset-selectable surface is **19 tools** across three servers (5 document, 5 metadata/Zotero, 9 record store).
- Panel buttons no longer send a duplicate generic action message per click; steps needing repair are pre-selected; the update button counts outdated **and** repair-needed steps; the summary reports repairs and deliberate omissions.

**Verification**

- Every probe in the 0.3.4 review is now a named regression test (`duplicateContent`, `emptyReindex`, `danglingEvidenceAfterReindex`, `backupCollision`, `futureSchema`, `readRepairsDatabase`, `previewOnFreshWorkspace`, `missingSourceEnvelope`, `claimFiltering`, `sameSecondClaim`, `docxOrder`, `doi`, `merge`, `providerNullAuthors`, `allProvidersFail`, `store-junction`, `cli-junction`, `notebookVenvJunction`, `quickPickStep`, `partialUpdate`, `repairAfterInterpreterRemoved`, `overlayConflict`, `legacyUpgradeDiscovery`, `setupButtonClickMessages`, `presetIdentity`, `folderSwitch`, `notesReopen`, `unvalidatedCitation`).
- The functional check discovers the surface at the unmanaged `all` preset and measures **20 tool definitions** across three servers (5 document, 6 metadata/Zotero including the deprecated `search` alias, 9 record store), reopens a search hit through `read_text_source`, resolves and exports claim evidence, asserts `schemaVersion == 2`, stages a restore without activating it, and checks evidence retention after `unindex_corpus` plus the stale link afterwards.
- Python and node suites, the real worker functional check and the packaged-VSX audit for this release are recorded in `evidence/quality-v0.3.5-2026-10-31/`. The real Extension Host and browser renderer receipts for 0.3.5 are **still outstanding** on the Windows 11 / VS Code 1.141.0 reference host, G1/G2/G3 remain open, and this version does not complete G4.

## 0.3.4 — 31 October 2026 · Package-aware component setup, corpus index and record store

- **Component installation is now declarative and package-aware.** `components.json` (schemaVersion 2) states for every one of the 29 components who installs it, which step provides it, how it is verified and what to do next; `installSteps`/`packages` declare the ordered steps each package needs. A new `installer.js` engine resolves that plan against the workspace receipt, runs only missing or outdated steps, and records each step in `.research-toolkit/managed/worker-0.3.4/installation.json`.
- **Four reviewed steps**: isolated document worker; reviewed research overlay (skills, profile, `research/` files); optional locked `notebooks/analysis` environment (`uv sync --locked`, no kernel started); workspace corpus index and record store. Basic offers 1, Recommended Research 3, Full 4. A step that needs another step is refused with the reason instead of half-installing.
- **GUI install/update controls**: a *Component setup for this package* section with per-step status (installed / outdated / missing), **Set up package components**, **Update outdated components**, **Check component status**, per-component **Install**/**Update** buttons, and a Quick Pick step chooser. Runs are resumable, cancellable, and never overwrite existing files: overlay files are created once, hash-verified against the bundle, and preserved; a linked path is refused rather than followed.
- **Full now ships real components instead of only plans**: a persistent workspace corpus index and a standard-library SQLite research record store under `.research-toolkit/store/`, served by a third managed MCP server with five verbs — `index_corpus`, `search_corpus`, `claims_read`, `claims_write`, `store_maintenance`. Reads and writes are separated and annotated so a client can gate them. No third-party database, embedding model or HTTP index service is installed, and source files are never modified.
- **New `corpus-lab` preset** (Full only) offers those five verbs and only the record-store server. `research-core`, `research-lab` and `research-lab-max` keep the 9-tool document/metadata surface, so no preset exceeds the new **C-13 budget contract**: at most 12 toolkit tools per preset and at least 20 tools of headroom under the 128-tool client ceiling.
- `search` is renamed **`search_literature`**. The old name is registered only for the unmanaged `all` preset, so hand-written 0.3.2/0.3.3 MCP configurations keep working; managed presets get no duplicate tool.
- **Tool metadata and caching**: every shipped tool publishes a title plus read-only/destructive/idempotent/open-world annotations, tools are registered in sorted name order, and all three workers answer `tools/list` with a 300-second private cache hint (SEP-2549).
- **Readiness reports setup completeness without claiming gates**: `Package setup for Full: 3 of 4 component steps installed, 1 outdated for this toolkit release · optional: Notebook analysis environment · G3 not passed.` Component rows now carry installation mode, owning step and a concrete next action; the workspace MCP row reports the running extension version; the notebook row distinguishes an environment from a project without one.
- Presets can be saved for the workspace folder (`application-overridable` scope), recently used presets are offered first, and **Copy preset summary** and **Diagnose tool limit** are available from the panel, sidebar and Command Palette (19 commands).
- Two new component guides (workspace corpus index, research record store) bring the hub to 29 component guides. Worker bundle, receipt and managed path move to `worker-0.3.4`; `uv.lock` is re-locked with uv 0.11.23 and now pins `mcp-types==2.2.0` explicitly.
- Verified here by 37 node tests (new `test/installer.test.js`), 70 pytest tests (new `tests/test_records.py`, `tests/test_lab_server.py`), a real three-server functional check (15 measured tool definitions, 2,193 tokens, corpus/claim round trip) and the packaged-VSX audit (`evidence/phase-4/gui-0.3.4/`). Real Extension Host and browser renderer receipts for 0.3.4 are still outstanding, and G1/G2/G3 remain open.

## 0.3.3 — 31 October 2026 · Goal-based tool presets and context budget

- Add seven **tools presets chosen by the goal you are working on**, not by MCP server: Read and cite a document, Search my own notes, Verify a citation, Prepare a Zotero import, Read/search/cite/write, Full research workspace, and Maximum research lab (128-tool budget).
- Presets follow the package preference: Basic offers 2, Recommended Research 5, Full 7. Each package has exactly one default preset, and a saved preset that the chosen package does not offer falls back to that default instead of being applied silently.
- The effective preset reaches the managed workers through `RESEARCH_STACK_TOOL_PRESET`, so only the tools that serve the goal are registered. A server whose tools the goal does not use is not offered at all. An unknown preset value fails closed with `TOOL_PRESET_UNKNOWN` rather than exposing the whole surface; an unset value keeps the 0.3.2 behaviour.
- Control panel gains a **Tools preset** section: goal cards with tooltips, tips and requirements, a **Context usage and tools in the selected preset** details view, and a package-default button. The sidebar row, status-bar tooltip, readiness text and a new **Research Toolkit: Select Tools Preset** Quick Pick report the same choice.
- **Context estimation** is measured from the installed worker's real `tools/list` schemas (name + title + description + input schema; characters ÷ 4 plus 40 tokens of framing per tool) and stored in the setup receipt. External servers use published vendor counts and are labelled as estimates, never as measurements.
- Budget guidance is explicit: 128-tool client ceiling, ~50-tool accuracy band, 96-tool warning. The widest preset is 100 tools (9 toolkit + 91 estimated external, ≈64k tokens ≈ 50% of a 128k window); the narrowest is 2–3 tools.
- All nine toolkit tools now publish a human-readable **title** in `tools/list`.
- Worker bundle, setup receipt and managed worker path move to 0.3.3; the VSIX audit and functional checks now also verify the measured tool surface.

## 0.3.2 — Functional local components and reading checks

- GUI setup bundles reviewed worker source/locks and installs an isolated Python 3.12 environment without changing project packages or existing MCP configuration.
- Real stdio MCP discovery, PDF/DOCX reading with hashes/locators, source preservation, Markdown/DOCX reports, local BM25 search and RIS preparation are verified.
- Selected workspace document reading shows a local text preview and actionable errors for scanned/damaged/outside files.
- Native MCP provider supplies managed Basic and Research servers; actual versions/readiness persist through a setup receipt and fresh checks.
- Unrelated project virtual environments are excluded from toolkit dependency detection. Interrupted setup can be retried; concurrent setup and edited source are handled without overwriting user data.
- Guides updated for the self-contained setup workflow. External services/accounts, notebook kernels and unimplemented Full integrations retain explicit prerequisites.

## 0.3.1 — 11 October 2026

- Add an observed inventory separating installation, detected version and evidence-based readiness from package preference.
- Add explicit trusted-local checks for uv/Git, workspace Python, library smoke tests, worker files and MCP configuration; keep client/kernel/service readiness unverified until its own task is tested.
- Add folder selection, component search, timestamps and safe handling of restricted/remote/virtual scopes.
- Add 27 individual component guides, a first-workspace walkthrough and a registry-generated guide hub with current official documentation links.
- Audit every packaged diagnostic/guide asset and preserve existing package/interface preferences.

## 0.3.0 — 11 October 2026

- Add Research Toolkit Activity Bar shortcuts and a graphical control panel for Basic, Recommended Research and Full preferences.
- Add a configurable status-bar shortcut and opt-in opening of controls at startup.
- Add readiness, clipboard, refresh, filtered settings and bundled help actions.
- Synchronize preferences across GUI, commands and Settings; preserve the existing package setting when upgrading.
- Add keyboard controls, responsive theme-aware layouts, validated webview messages and packaged GUI asset auditing.
- Preserve the Phase 4 preview scope: component installation and lifecycle workflows remain pending.

## 0.2.0 — 7 October 2026

- Add persistent package preference switching and phase readiness commands.
