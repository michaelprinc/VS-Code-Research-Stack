# Quality state — Research Stack Toolkit 0.3.7 (lock integrity release, verified on this host)

Objective: fix the reported field failure — 0.3.6 installed but the isolated worker step failed with
uv's "The lockfile at `uv.lock` needs to be updated, but `--locked` was provided" — and make that class
of defect impossible to ship. Spec-driven plan:
[specs/phase-7-lock-integrity/](../specs/phase-7-lock-integrity/) (findings D7-01…D7-08, requirements
R7-01…R7-17, decisions DD7-01…DD7-11, cases T7-01…T7-21, [gate checklist](../specs/phase-7-lock-integrity/checklists/gates.md)).
Release report: [implementation-report-0.3.7.md](../docs/implementation/phase-7-lock-integrity/implementation-report-0.3.7.md).
Evidence: [evidence/quality-v0.3.7-2026-11-02/](../evidence/quality-v0.3.7-2026-11-02/test-summary.md).
Previous release: 0.3.6 (Phase 6 install reliability) —
[implementation-report-0.3.6.md](../docs/implementation/phase-6-install-reliability/implementation-report-0.3.6.md).

Status: **0.3.7 implemented, verified on this Linux development host against seven real uv binaries, and
recorded as tag `v0.3.7`.** The root cause is proven, repaired, and gated at three
independent points. Gates G1–G4 (reference-host profile gates) remain open, as they were for 0.3.6.

## Root cause (proven, not assumed)

`extension/worker/pyproject.toml` declared `version = "0.3.6"` while the `uv.lock` shipped beside it
recorded the root package `research-stack-basic` at **0.3.4**. uv compares the lock with the project
metadata before honouring `--locked`, so it refused the pair on every managed setup. Reproduced with
real uv 0.5.0, 0.6.10, 0.7.22, 0.8.5, 0.9.30, 0.10.7 and 0.13.6: the drifted pair is refused by all
seven with the same sentence; the corrected pair syncs on all seven.
Receipt: [uv-matrix.json](../evidence/quality-v0.3.7-2026-11-02/uv-matrix.json).

## Verified now (3 November 2026, this host — re-cut after the review rounds)

| Item | Evidence |
|---|---|
| Node suite `cd extension && npm test` | **331 pass / 0 fail / 0 skipped** across the 16 files `npm test` runs (`host.test.js` / `browser.test.js` are the commands that would produce the reference-host receipts; they are not part of `npm test` and were not run for 0.3.7); `test/lockfile.test.js` (24 tests) and `test/lockfile-adversarial.test.js` (118 tests over 112 pairs) |
| Python suite `.venv/bin/python -m pytest` | **207 pass** with `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6`; **206 pass + 1 skip** without a uv binary; `tests/test_lock_consistency.py` 79 tests with a real uv binary (78 + 1 skip without), `tests/test_vsix.py` 22 tests |
| Lock integrity CLI `python3 scripts/lockintegrity.py` | `"ok": true` for all three shipped pairs (`lockintegrity-cli.json`) |
| Real `uv lock --check` (uv 0.13.6) | exit 0 on the worker pair, the overlay notebook pair and the repository pair (`uv-lock-check.txt`) |
| Real uv matrix | shipped pair exit 0 on uv 0.5.0 → 0.13.6; drifted pair refused by all seven; `uv sync --frozen` on the drifted pair exit 0 on all seven (`uv-matrix.json`, `run_uv_matrix.py`) |
| Lock provenance | `uv lock` (uv 0.13.6) on the 0.3.6 lock beside this release's manifest: `+2 / -2` lines, 39 third-party pins unchanged, output byte-identical to the packaged lock (`lock-provenance.json`) |
| Worker bundle | rebuilt: 19 reviewed source/lock files + 11 overlay templates, `workerVersion 0.3.7`, schemaVersion 2 |
| Packaged VSIX | `dist/research-stack-toolkit-0.3.7.vsix`, 332,448 bytes, 86 members, 0 carrying CRLF, every ZIP entry stamped at the fixed build epoch, every member 0644 except the 3 vsce writes, sha256 `f221a9a82a87541416770c7ff0fbe06b8e332dd4e952203d3b18b0ea1ac7ec16` (+ `.sha256` sidecar, verified with `sha256sum -c`) |
| VSIX audit `npm run verify-package` | `"result": "passed"`, 86 members, `sourceFilesMatch: true`, packaged worker + overlay pair checked (`vsix-audit.json`) |
| Installed-payload check `npm run check:payload` | passed on the packaged artifact; managed path resolves to `.research-toolkit/managed/worker-0.3.7` (`payload-check.json`) |
| Clean-clone rebuild | `bash /tmp/repro_check.sh v0.3.7` four times — twice against the release commit `e0192ad`, twice against the tag after the receipts commit: every clone built 332,448 bytes with sha256 `f221a9a8…`, identical to the shipped artifact (`clean-clone-rebuild.txt`) |

One defect the audit proved about the artifact itself: the 0.3.7 VSIX as first built was **not
reproducible from the tag**. 17 of its 86 members — 16 of the 32 `extension/guides/*.md` files and
`extension/media/toolkit.svg` — carried CRLF in the artifact while the committed tree holds LF
(`extension/guides/uv.md`: 2,372 bytes with 21 CRLF in that build, 2,351 bytes with none at
`git show v0.3.7:extension/guides/uv.md`), so a fresh clone produced a different digest.
`extension/scripts/package.js` now normalises the staged tree to LF and `scripts/verify_vsix.py`
rejects CRLF in packaged text members; the rebuilt artifact carries CRLF in none of its 86 members.

## What changed in this release (finding → implementation)

- **D7-01/D7-02 stale shipped pair** → `uv.lock` regenerated with pinned uv 0.13.6 (`revision 5`, root
  `0.3.7`); `scripts/lockintegrity.py` (uv-free reader + CLI) refuses a stale pair in
  `scripts/build_worker_bundle.py` (source pairs before staging, built pair before `bundle.json` is
  written) and in `scripts/verify_vsix.py` against the
  **packaged** bytes of the worker and the overlay notebook project.
- **D7-03 no runtime diagnosis** → new reviewed module `extension/lockfile.js` (`DRIFT_SIGNATURE`,
  `parseLock`, `parsePyproject`, `pairProblems`, `dependencyPins`, `isLockDrift`); `setupRuntime`
  self-checks the bundled pair **before any process or write** and throws naming both files;
  `runner.describe()` explains a refusal as a lockfile/project mismatch, explicitly not a network,
  proxy or interpreter problem.
- **D7-04 no recovery tier** → `--locked` first, then exactly one `--frozen` attempt only when drift is
  recognised, recorded through `steps.lockFallbackNote` so a fallback install is never reported as clean.
  Never `uv lock` in a managed runtime, never a plain `uv sync`.
- **D7-05 inherited `UV_*`** → `runner.setupEnvironment` strips 15 meaning-changing `UV_*` names, then
  applies the five reviewed `UV_*` values plus `UV_PROJECT_ENVIRONMENT`, derived from the project directory.
- **D7-06 identity not buildable** → the requested four-part `0.3.6.1` cannot be packaged
  (`@vscode/vsce` → `semver.valid`, [vscode-vsce #415](https://github.com/microsoft/vscode-vsce/issues/415));
  the release is **0.3.7** and `tests/test_release_identity.py::test_release_version_is_one_vsce_can_package`
  now rejects any version the packager would refuse. `WORKER_FOLDER_PATTERN` accepts exactly the folder
  names a release can produce.
- **D7-07 verification pointed at an old artifact** → `extension/scripts/with-artifact.js` derives the
  VSIX path from `extension/vsix-manifest.json`.
- **D7-08 Phase 6 residuals** → `functionalCheck` uses `Math.max(90000, setupTimeoutMs)`; a timeout
  reports per-attempt bound, attempt count and total waited time.
- **Windows review W2/W11/W12 (DD7-12)** → `extension/runner.js` is now one bounded `childProcess.spawn(`
  (own POSIX process group, reaped with `kill(-pid, SIGKILL)`) plus one `childProcess.execFile(` running
  `taskkill.exe /PID <pid> /T /F` on Windows, because Node's `execFile` drops `detached` and a stopped
  `uv sync` otherwise leaves its build children writing into the step directory; setup also scrubs
  `PYTHONPATH`/`PYTHONHOME` (measured reaching uv 0.13.6's non-isolated build python before the fix) and
  reports the environment it actually built; `uv lock …` and a plain `uv sync` are refused at the
  boundary (`kind: "policy"`, `attempts: 0`) before a process exists. `scripts/verify_vsix.py`,
  `extension/test/module-boundaries.test.js` and `tests/test_vsix.py` enforce the new shape. Receipts:
  `node --test test/runner.test.js test/module-boundaries.test.js` → 42 pass / 0 fail (13 new runner
  tests: 3 real process-tree spawns on this host, 2 no-spawn policy proofs using a real executable named
  `uv`, 2 labelled win32 shape tests, not proof). The reap was then extended to a run that **exits
  non-zero** or fails to spawn — the field shape, where `uv sync --locked` exits 1 — measured with real uv
  0.13.6 on a drifted pair: the group is empty at the error (`kill(-pid) ESRCH`) and nothing writes after
  it; with a faithful stand-in, a grandchild that wrote 1.2 s after the failure writes nothing. An exit-0
  run never reaps, and a tree with nothing left in it reports `reaped: false` honestly.

## Independent review rounds after the tag

Three further review passes ran against the tagged build, each with its findings recorded in
[review-findings.md](../specs/phase-7-lock-integrity/review-findings.md):

- **Second round (rows 22–31)** — a Windows portability review, an end-to-end install of the packaged
  VSIX and a claims audit of the release documentation. 10 defects, all fixed and tested: the
  case-sensitive `UV_*` scrub, a fallback install reported as clean, an unquotable re-run command, a
  lock refusal with no kind or hint, the notebook step's uv resolution and missing fallback tier, the
  non-reproducible CRLF artifact, an over-claiming refusal sentence, a 0-byte `uv.exe` offered as
  usable, and the adversarial suite being outside `npm test`.
- **Third round (rows 32–44)** — 69 synthetic pairs, each measured with real uv, driving both dependency
  readers. 12 defect classes fixed in the JS reader (markers, extras, `requires-python` in either file,
  hand-edited transitive pins against their artifact filenames, deleted and duplicated `[[package]]`
  blocks, `[tool.uv]` source mode, non-canonical extras, triple-quoted scalars, indented keys, stray
  local entries, parenthesised extras, PEP 440 normalisation) and the same classes in the Python reader.
  `extension/test/lockfile-adversarial.test.js` now keeps 112 pairs with uv's measured verdict: 110 agree,
  2 are deliberate support-policy divergences, none uncaught.
- **Reader false-alarm round (4 November 2026, both readers changed in the same change).** Nine classes
  the readers answered wrongly against uv, plus one class both readers missed. Fixed in
  `extension/lockfile.js` and `scripts/lockintegrity.py` together and re-measured against each other:
  a specifier compared as the **set of its bounds** (P63 — the shipped pair — P01, P64, P51, uv exit 0 on
  all seven; the shipped pair was being reported as drift); `[tool.uv]` keys uv records in the lock
  (P06/P07/P08 accepted, P09 `environments` still refused); `dynamic = ["optional-dependencies"]` beside
  `provides-extras` (P48, exit 0) and its removal (P49, exit 0 on 0.5.0 then 2/2/1/1/1/1); the sdist
  filename version check dropped while the wheel check stays (P25b exit 0 against P25c exit 2); root
  version spellings `v1.0.0` / `1.0-1` / `1.0.00` (P12/P11/P13, exit 0) without weakening real drift;
  `source = { editable = "./" }` (P31, exit 0); the BOM floor split per uv version (P21a/P21d: 0.5.0
  exit 2 "Failed to prepare distributions", 0.6.10 through 0.13.6 exit 0). Classes both readers missed
  and now catch: a transitive-only `[[package]]` block deleted or duplicated (P23/P24), lock header
  `version = 2` (P34), `sdist` written as a list (P25), `[manifest]` overrides without the manifest key
  (P10), a resolution-marker set that does not cover `requires-python` (P37), an entry with no `version`
  (P28), and TOML validity on the JS side (P19/P20/P29/P30/P36). `pairProblems` no longer dresses an
  internal reader failure up as a `lock comparison failed:` verdict — it propagates, and the callers
  (`readBundledPair`, `notebookPairProblems`) report it in their own words. Measured: 112 rows in
  `extension/test/lockfile-adversarial.test.js` (110 agree with uv, 2 deliberate support-policy
  divergences, `UNCAUGHT` empty), every row re-run through real uv 0.13.6 with **0 verdict mismatches**,
  both readers over those same 112 rows with **0 divergences and 0 reader crashes**, and over the 69
  receipt pairs with **0 divergences**. `cd extension && npm test` 331 pass / 0 fail;
  `pytest tests/` 207 passed with `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6`.
- **Fifth round (rows 45–73)** — the re-cut release was tested as a release: an operator-style end-to-end
  install of the unpacked VSIX, a Windows-portability pass, 69 further adversarial pairs, and a claims
  audit. 29 findings fixed and re-verified: the failed-fallback success wording, the missing `hint`/`cwd`,
  a failed fallback counted as an install, the notebook build-defect kind/hint, an operator's own project
  blamed on the build, attempt counts at both ends, the pasteable re-run instruction, the 0-byte tool on
  every platform, the `verify-package` ENOENT message, workspace-root resolution, PATH quoting and dedupe,
  the win32 location list, the process-tree reap (including failed exits), the enforced `uv lock` gate, the
  capability audit reading a RegExp `.exec(` as a process call, the missing `kind: "policy"` next action,
  and the reader false alarms and blind spots listed in the review record.
- **Cross-reader check (row 44)** — both readers were run over the same extracted pairs. Two verdicts
  diverged (the PEP 735 `{ include = "dev" }` group reference and `dynamic = ["dependencies"]`), which
  meant `npm run package` and `python3 scripts/lockintegrity.py` could answer the same pair differently.
  Aligned with measurements from uv 0.13.6 and uv 0.5.0: `include-group` flattens, `{ include = … }` is
  reported by both readers as a construct neither can certify, and both skip the manifest-half
  comparison for a dynamic dependency list and check the root entry's resolved dependencies instead.
  Re-measured over 69 pairs: 0 divergences, all three shipped pairs clean in both readers.

Still open after all rounds (recorded, not hidden):

1. **Closed in this round:** a lock whose `resolution-markers` no longer cover the Python range its own
   `requires-python` declares. Both readers now model the marker forks as `major.minor` intervals — a
   marker set that partitions the declared range covers it, a set that leaves a sub-range with no fork,
   or whose markers cannot intersect the declared range at all, does not. Measured: the shipped
   partition reads clean in both readers (uv 0.13.6 wrote it, `lock --check` exit 0), dropping one marker
   is refused (uv 0.13.6 exit 1), and pair P37 (a marker outside the declared range) is refused (exit 2
   on uv 0.6.10/0.7.22, exit 1 on 0.8.5–0.13.6).
2. **Named remaining gap: pair P32.** A `requires-dist` entry that names a registry distribution while
   every `[[package]]` entry of that name in the lock is a local (editable) source — uv refuses it (exit
   2 on all seven uv binaries) and neither reader reports it. The model is designed (compare the
   requirement's registry/local shape against the shape of the entries it resolves to) but not
   implemented on either side; it is the only class in the 69-pair set where uv refuses and both readers
   certify clean.
3. `dynamic = ["dependencies"]` is resolved by a build backend. Both readers now skip the manifest-half
   comparison and check the root entry's resolved dependencies instead — what uv's own `lock --check`
   checks. Drift inside the dynamic source file is invisible to uv itself too (measured).
4. `DRIFT_SIGNATURE` keeps a `--check` branch that shipped code never runs.
5. The reference-host receipts (G1–G4) and the re-run of the reported field workspace.

## Open defects and risks

1. **The field host has not been re-run.** The report came from Windows 11 x64 with `uv.exe`; everything
   here is a Linux development host with downloaded uv binaries. The 0.3.7 VSIX must be installed in the
   reported workspace and its setup re-run before this ticket can be closed.
2. **Gates G1–G4 remain open** (reference host Windows 11 x64 / VS Code Desktop 1.141.0, real Extension
   Host and browser renderer receipts). 0.3.7 does not claim them.
3. **`uv lock --check` coverage is conditional.** The gate skips when no uv binary is available; it runs
   and passes when `RESEARCH_STACK_UV` names one.
4. **One unpacked acceptance workspace is still on disk**: `extension/dist/acceptance-0.3.2`, 54 MB
   (`du -sh extension/dist/acceptance-0.3.2`). `dist/` holds only the release VSIXes and their `.sha256`
   sidecars — 1.5 MB in total, 18 files (`du -sh dist`) — and the six `acceptance-0.3.0 …
   acceptance-0.3.2-verified` trees the earlier text listed there, ~291 MB, are not on this host.
   [dist/README.md](../dist/README.md) now describes what is actually present. This is a storage decision
   rather than a defect.
5. **Drift detection is signature-based.** A future uv that rewords the refusal would fall through to the
   generic failure path; `DRIFT_SIGNATURE` also matches `--check`, and the staleness reasons uv prints
   are captured in the recorded problems.
6. **Windows behaviour is simulated, not observed.** The `taskkill /T /F` branch, the case-insensitive
   `UV_*` scrub, the quoted re-run instruction, the 0-byte `uv.exe` refusal, the junction and mapped-drive
   workspace-root cases and the non-UTF-8 code page path are pinned by tests that assert the shape of the
   call or the wording on a Linux host. Two named limits are recorded rather than claimed away:
   `taskkill /T` snapshots the tree and needs a live root, so a child that dies just before the bound or a
   grandchild created after the snapshot escapes (now visible as `reaped: false` plus `reapReason`); and
   `kill(-pid)` reaches only the child's own process group, so a grandchild that detaches into its own
   group escapes both reapers. Measured: real uv 0.13.6 build children do not detach.
7. **`scripts/lockintegrity.py <foreign-root>` prints `missing pair:` lines** for the repository's three
   standard pairs when pointed at a tree that is not the repository (for example the reported field
   workspace). The verdict and exit code are correct — it names the field pair and exits 1 — and the extra
   lines never mask the finding, so this is recorded as a wart rather than changed in a release round.
8. **The pasteable re-run instruction reaches the operator through Copy Installation Diagnostics and the
   output channel, not the panel card** (`extension/media/controls.js` does not render the `rerun` field).
   A workspace path containing `%` is still expanded by `cmd.exe` inside quotes; quoting cannot fix that.

## Next highest-value actions

1. **Done at the 4 November freeze:** the VSIX was re-cut after the last payload edit (332,448 bytes,
   sha256 `f221a9a8…`), `npm run verify-package` and `npm run check:payload` re-run, the `.sha256`
   sidecar refreshed in the documented `sha256sum` format and verified with `sha256sum -c`, and every
   size, digest and test count re-recorded in this file, the CHANGELOG, the gates and the evidence folder.
2. **Done after the re-tag:** four clean-clone builds of `v0.3.7` each produced the shipped artifact
   byte-for-byte — 332,448 bytes, sha256 `f221a9a8…` — recorded in
   [clean-clone-rebuild.txt](../evidence/quality-v0.3.7-2026-11-02/clean-clone-rebuild.txt).
3. Install the re-cut VSIX in the reported field workspace, run setup, and attach the new
   `.research-toolkit/logs/` attempt log to the evidence folder.
4. Produce the reference-host receipts (G1–G4) on Windows 11 x64 / VS Code 1.141.0.
5. Close C4/P32 in both readers (a registry requirement whose `[[package]]` entries were rewritten to a
   local source) with the uv receipts, if it is worth another reader round.
6. Remove or archive `extension/dist/acceptance-0.3.2/`; consider a scheduled re-lock check in CI so a
   version bump cannot again ship an unre-locked pair.
