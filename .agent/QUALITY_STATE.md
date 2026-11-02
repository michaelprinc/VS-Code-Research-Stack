# Quality state — Research Stack Toolkit 0.3.7 (lock integrity release, verified on this host)

Objective: fix the reported field failure — 0.3.6 installed but the isolated worker step failed with
uv's "The lockfile at `uv.lock` needs to be updated, but `--locked` was provided" — and make that class
of defect impossible to ship. Spec-driven plan:
[specs/phase-7-lock-integrity/](../specs/phase-7-lock-integrity/) (findings D7-01…D7-08, requirements
R7-01…R7-17, decisions DD7-01…DD7-08, cases T7-01…T7-21, [gate checklist](../specs/phase-7-lock-integrity/checklists/gates.md)).
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

## Verified now (2 November 2026, this host)

| Item | Evidence |
|---|---|
| Node suite `cd extension && npm test` | **168 pass / 0 fail** across the 15 files `npm test` runs (`host.test.js` / `browser.test.js` are the reference-host receipts, run separately); new `test/lockfile.test.js` (21 tests) |
| Python suite `.venv/bin/python -m pytest` | **155 pass** with `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6`; **154 pass + 1 skip** without a uv binary; new `tests/test_lock_consistency.py` (38 tests) |
| Lock integrity CLI `python3 scripts/lockintegrity.py` | `"ok": true` for all three shipped pairs (`lockintegrity-cli.json`) |
| Real `uv lock --check` (uv 0.13.6) | exit 0 on the worker pair, the overlay notebook pair and the repository pair (`uv-lock-check.txt`) |
| Real uv matrix | shipped pair exit 0 on uv 0.5.0 → 0.13.6; drifted pair refused by all seven; `uv sync --frozen` on the drifted pair exit 0 on all seven (`uv-matrix.json`, `run_uv_matrix.py`) |
| Lock provenance | `uv lock` (uv 0.13.6) on the 0.3.6 lock beside this release's manifest: `+2 / -2` lines, 39 third-party pins unchanged, output byte-identical to the packaged lock (`lock-provenance.json`) |
| Worker bundle | rebuilt: 19 reviewed source/lock files + 11 overlay templates, `workerVersion 0.3.7`, schemaVersion 2 |
| Packaged VSIX | `dist/research-stack-toolkit-0.3.7.vsix`, 301,366 bytes, 86 members, sha256 `2595facbf4f0f8271ebaca791a7443dc8915c2eb41b539f9edb64331e5abfb84` (+ `.sha256` sidecar) |
| VSIX audit `npm run verify-package` | `"result": "passed"`, 86 members, `sourceFilesMatch: true`, packaged worker + overlay pair checked (`vsix-audit.json`) |
| Installed-payload check `npm run check:payload` | passed on the packaged artifact; managed path resolves to `.research-toolkit/managed/worker-0.3.7` (`payload-check.json`) |

## What changed in this release (finding → implementation)

- **D7-01/D7-02 stale shipped pair** → `uv.lock` regenerated with pinned uv 0.13.6 (`revision 5`, root
  `0.3.7`); `scripts/lockintegrity.py` (uv-free reader + CLI) refuses a stale pair in
  `scripts/build_worker_bundle.py` (before and after writing) and in `scripts/verify_vsix.py` against the
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
  applies the reviewed six.
- **D7-06 identity not buildable** → the requested four-part `0.3.6.1` cannot be packaged
  (`@vscode/vsce` → `semver.valid`, [vscode-vsce #415](https://github.com/microsoft/vscode-vsce/issues/415));
  the release is **0.3.7** and `tests/test_release_identity.py::test_release_version_is_one_vsce_can_package`
  now rejects any version the packager would refuse. `WORKER_FOLDER_PATTERN` accepts exactly the folder
  names a release can produce.
- **D7-07 verification pointed at an old artifact** → `extension/scripts/with-artifact.js` derives the
  VSIX path from `extension/vsix-manifest.json`.
- **D7-08 Phase 6 residuals** → `functionalCheck` uses `Math.max(90000, setupTimeoutMs)`; a timeout
  reports per-attempt bound, attempt count and total waited time.

## Independent review outcome

A read-only review subagent probed both readers with synthetic pairs and confirmed 21 defects; all but
three are fixed and tested. [review-findings.md](../specs/phase-7-lock-integrity/review-findings.md)
records each finding with its disposition. The class of defect matters: a reader that reports drift where
uv sees none would have refused `npm run package` on the *next* dependency change, and a reader that
misses drift re-opens this release's own bug.

Still open after the review (recorded, not hidden):

1. `[tool.uv]` resolution inputs (`override-dependencies`, `constraint-dependencies`, `sources`,
   `environments`, `required-environments`, `default-groups`) are read by neither reader. No shipped
   manifest uses them.
2. `dynamic = ["version"]` with no recorded lock version is accepted by both readers.
3. `DRIFT_SIGNATURE` keeps a `--check` branch that shipped code never runs.
4. Markers are deliberately not compared (uv re-serialises them), so a marker-only change is not
   detected. Extras **are** compared.

## Open defects and risks

1. **The field host has not been re-run.** The report came from Windows 11 x64 with `uv.exe`; everything
   here is a Linux development host with downloaded uv binaries. The 0.3.7 VSIX must be installed in the
   reported workspace and its setup re-run before this ticket can be closed.
2. **Gates G1–G4 remain open** (reference host Windows 11 x64 / VS Code Desktop 1.141.0, real Extension
   Host and browser renderer receipts). 0.3.7 does not claim them.
3. **`uv lock --check` coverage is conditional.** The gate skips when no uv binary is available; it runs
   and passes when `RESEARCH_STACK_UV` names one.
4. **Unpacked acceptance workspaces are still on disk** (`dist/acceptance-0.3.2*`,
   `extension/dist/acceptance-0.3.2`, ~250 MB total). [dist/README.md](../dist/README.md) documents them
   as retained evidence, so this is a storage decision rather than a defect — but the 0.3.6 quality state
   described them as archived, which is not what the tree shows.
5. **Drift detection is signature-based.** A future uv that rewords the refusal would fall through to the
   generic failure path; `DRIFT_SIGNATURE` also matches `--check`, and the staleness reasons uv prints
   are captured in the recorded problems.

## Next highest-value actions

1. Install `dist/research-stack-toolkit-0.3.7.vsix` in the reported field workspace, run setup, and
   attach the new `.research-toolkit/logs/` attempt log to the evidence folder.
2. Produce the reference-host receipts (G1–G4) on Windows 11 x64 / VS Code 1.141.0.
3. Remove or archive `extension/dist/acceptance-0.3.2/`.
4. Consider a scheduled re-lock check in CI so a version bump cannot again ship an unre-locked pair.
