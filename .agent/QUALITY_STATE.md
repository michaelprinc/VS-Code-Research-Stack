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
| Node suite `cd extension && npm test` | **250 pass / 0 fail** across the 16 files `npm test` runs (`host.test.js` / `browser.test.js` are the commands that would produce the reference-host receipts; they are not part of `npm test` and were not run for 0.3.7); new `test/lockfile.test.js` (24 tests) and `test/lockfile-adversarial.test.js` (73 tests) |
| Python suite `.venv/bin/python -m pytest` | **185 pass** with `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6`; **184 pass + 1 skip** without a uv binary; `tests/test_lock_consistency.py` (65 tests — 64 always, 1 gated on a real uv binary) |
| Lock integrity CLI `python3 scripts/lockintegrity.py` | `"ok": true` for all three shipped pairs (`lockintegrity-cli.json`) |
| Real `uv lock --check` (uv 0.13.6) | exit 0 on the worker pair, the overlay notebook pair and the repository pair (`uv-lock-check.txt`) |
| Real uv matrix | shipped pair exit 0 on uv 0.5.0 → 0.13.6; drifted pair refused by all seven; `uv sync --frozen` on the drifted pair exit 0 on all seven (`uv-matrix.json`, `run_uv_matrix.py`) |
| Lock provenance | `uv lock` (uv 0.13.6) on the 0.3.6 lock beside this release's manifest: `+2 / -2` lines, 39 third-party pins unchanged, output byte-identical to the packaged lock (`lock-provenance.json`) |
| Worker bundle | rebuilt: 19 reviewed source/lock files + 11 overlay templates, `workerVersion 0.3.7`, schemaVersion 2 |
| Packaged VSIX | `dist/research-stack-toolkit-0.3.7.vsix`, 312,471 bytes, 86 members, 0 of them carrying CRLF, sha256 `f4db025b12718b62336ebec091ba79523a059ffa9de3ba998f66549183666416` (+ `.sha256` sidecar) |
| VSIX audit `npm run verify-package` | `"result": "passed"`, 86 members, `sourceFilesMatch: true`, packaged worker + overlay pair checked (`vsix-audit.json`) |
| Installed-payload check `npm run check:payload` | passed on the packaged artifact; managed path resolves to `.research-toolkit/managed/worker-0.3.7` (`payload-check.json`) |

One defect the audit proved about the artifact itself: the 0.3.7 VSIX as first built was **not
reproducible from the tag**. 17 of its 86 members — the 16 `extension/guides/*.md` files and
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
  `extension/test/lockfile-adversarial.test.js` keeps the pairs with uv's measured verdict: 62 agree,
  3 are deliberate divergences, 1 is a named gap.
- **Cross-reader check (row 44)** — both readers were run over the same extracted pairs. Two verdicts
  diverged (the PEP 735 `{ include = "dev" }` group reference and `dynamic = ["dependencies"]`), which
  meant `npm run package` and `python3 scripts/lockintegrity.py` could answer the same pair differently.
  Aligned with measurements from uv 0.13.6 and uv 0.5.0: `include-group` flattens, `{ include = … }` is
  reported by both readers as a construct neither can certify, and both skip the manifest-half
  comparison for a dynamic dependency list and check the root entry's resolved dependencies instead.
  Re-measured over 69 pairs: 0 divergences, all three shipped pairs clean in both readers.

Still open after all rounds (recorded, not hidden):

1. A lock whose dependency markers no longer cover the environments `requires-python` allows is accepted
   by uv and missed by both readers. Closing it needs marker-fork interval arithmetic.
2. `dynamic = ["dependencies"]` is resolved by a build backend. Both readers now skip the manifest-half
   comparison and check the root entry's resolved dependencies instead — what uv's own `lock --check`
   checks. Drift inside the dynamic source file is invisible to uv itself too (measured).
3. `DRIFT_SIGNATURE` keeps a `--check` branch that shipped code never runs.
4. The reference-host receipts (G1–G4) and the re-run of the reported field workspace.

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
   sidecars — 1.4 MB in total (`du -sh dist`) — and the six `acceptance-0.3.0 … acceptance-0.3.2-verified`
   trees the earlier text listed there, ~291 MB, are not on this host. [dist/README.md](../dist/README.md)
   now describes what is actually present. This is a storage decision rather than a defect.
5. **Drift detection is signature-based.** A future uv that rewords the refusal would fall through to the
   generic failure path; `DRIFT_SIGNATURE` also matches `--check`, and the staleness reasons uv prints
   are captured in the recorded problems.

## Next highest-value actions

1. Re-cut the VSIX after the last payload edit, re-run `npm run verify-package` and
   `npm run check:payload`, refresh `dist/research-stack-toolkit-0.3.7.vsix.sha256`, and re-record every
   size, digest and test count in this file, the CHANGELOG and the evidence folder.
3. Build from a clean clone of the re-cut tag and confirm the digest matches — the reproducibility
   invariant is only proven by that comparison.
4. Install the re-cut VSIX in the reported field workspace, run setup, and attach the new
   `.research-toolkit/logs/` attempt log to the evidence folder.
5. Produce the reference-host receipts (G1–G4) on Windows 11 x64 / VS Code 1.141.0.
6. Remove or archive `extension/dist/acceptance-0.3.2/`; consider a scheduled re-lock check in CI so a
   version bump cannot again ship an unre-locked pair.
