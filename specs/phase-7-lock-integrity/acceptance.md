# Phase 7 acceptance — 0.3.7

Each case names how it is proven on this host. "Verified" requires a test or a recorded receipt.

| Case | Scenario | Expected | Proof |
|---|---|---|---|
| T7-01 | The exact setup command against the **shipped 0.3.6** pair | exit 2 on uv 0.5.0 and exit 1 on uv 0.13.6, both with uv's "lockfile … needs to be updated" refusal | `evidence/quality-v0.3.7-2026-11-02/uv-matrix.json` (negative control) |
| T7-02 | The same command against the corrected 0.3.7 pair | exit 0 on uv 0.5.0 → 0.13.6, 40 packages installed | `evidence/quality-v0.3.7-2026-11-02/uv-matrix.json` |
| T7-03 | `uv lock` on the shipped manifest | two-line diff (`revision`, root `version`); the 39 third-party pins unchanged (the 40th entry is the root package, and it is the one that changed); output byte-identical to the shipped lock | `evidence/quality-v0.3.7-2026-11-02/lock-provenance.json` |
| T7-04 | A pair whose lock records a different root version | `lockintegrity.check_pair` names it, and the message says `uv sync --locked` would refuse it | `tests/test_lock_consistency.py` |
| T7-05 | A pair whose dependency specifier or group drifted | named in the problems list | `tests/test_lock_consistency.py` |
| T7-06 | `extension/worker/pyproject.toml` vs `extension/worker/uv.lock` in the release tree | consistent, and byte-equal to the reviewed root pair | `tests/test_lock_consistency.py` |
| T7-07 | A VSIX packaged from a stale tree | `scripts/verify_vsix.py` fails on the packaged pair | `tests/test_vsix.py` (stale-pair fixture) |
| T7-08 | Build a worker bundle from a stale pair | `scripts/build_worker_bundle.py` refuses and writes nothing | `tests/test_lock_consistency.py` |
| T7-09 | Development host has uv | `uv lock --check` passes for every shipped pair; without uv the case is skipped and named | `tests/test_lock_consistency.py` |
| T7-10 | Bundled worker pair disagrees | setup fails **before** any uv process, names both files and the disagreeing field, touches nothing | `extension/test/runtime.test.js` |
| T7-11 | uv refuses a lock as stale | the message names uv's own sentence, the toolkit's explanation, and is not retried as a transport failure | `extension/test/lockfile.test.js`, `extension/test/runner.test.js` |
| T7-12 | A recognised drift after `--locked` | exactly one `uv sync --frozen` attempt, recorded with its reason; plain `uv sync` never issued | `extension/test/runtime.test.js` |
| T7-13 | The fallback also fails | step `failed` with both attempts recorded; dependents blocked; plan continues past independent steps | `extension/test/runtime.test.js` ("an ordinary sync failure gets no fallback, and plain `uv sync` is never issued") and `extension/test/runtime.test.js` ("when the reviewed fallback also fails, the operator sees both refusals, not just the last one"), which drives `--frozen` to failure and asserts that both sentences, `attempts = 2` and the fallback marker reach the record; `extension/test/installer.test.js` ("a failure blocks only its dependents: independent steps still run") |
| T7-14 | A fallback install succeeded | the step is reported with the drift warning, and the verdict is distinguishable from a clean success | `extension/test/runtime.test.js` (the fallback is recorded on the runtime result), `extension/test/steps.test.js` (`lockFallbackNote` names it in the step evidence), `extension/test/status.test.js` (a step that installed through the lockfile fallback is not reported as a clean install), `extension/test/installer.test.js` (the fallback marker survives into the status record), and `extension/test/steps.test.js` (the notebook step gets the same one bounded tier, and an ordinary failure gets no fallback) |
| T7-15 | Host environment carries `UV_INDEX_URL`, `UV_LOCKED`, `UV_OFFLINE` | they are absent from the child environment; the five reviewed `UV_*` values are present, with `UV_PROJECT_ENVIRONMENT` derived from the project directory | `extension/test/runner.test.js` |
| T7-16 | managed folders `worker-0.3.6`, `worker-0.3.7`, `worker-0.3.6.1`, `worker-0.3` | the shaped ones are discovered (`thisRelease` true, activatable, selectable for rollback); the malformed ones are skipped because no release can name them | `extension/test/runtime.test.js` |
| T7-17 | `0.3.7` stated in five sources | identical, and a version `semver.valid` accepts | `tests/test_release_identity.py`, `extension/test/unit.test.js` |
| T7-18 | `npm run verify-package` / `check:payload` after a version bump | resolve the artifact from `extension/vsix-manifest.json` | `extension/package.json`, run receipts |
| T7-19 | `researchStack.setupTimeoutSeconds` raised | the reading check uses the raised bound, not a fixed 90 s | `extension/test/runtime.test.js` |
| T7-20 | A run retried after a timeout | the message reports the wall time across the attempts that ran | `extension/test/runner.test.js` |
| T7-21 | Module boundary audit | `lockfile.js` is in the reviewed set, `runner.js` remains the only `execFile` call site, a second boundary is rejected | `extension/test/module-boundaries.test.js`, `scripts/verify_vsix.py`, audit probes |

## 3. Result — 2026-11-02

Every case names its proof, and every proof is a receipt in the tree or a test in a suite this host ran.
The failed-fallback half of T7-13, recorded as untested on 2 November, is now covered by
`extension/test/runtime.test.js` (“when the reviewed fallback also fails, the operator sees both refusals,
not just the last one”) and by the notebook equivalent in `extension/test/steps.test.js`.

| Group | Receipt |
| --- | --- |
| T7-01 … T7-03 | `evidence/quality-v0.3.7-2026-11-02/uv-matrix.json`, `lock-provenance.json`, produced by the two scripts stored beside them |
| T7-04 … T7-09 | `tests/test_lock_consistency.py` (79 tests with a real uv binary named by `RESEARCH_STACK_UV`; 78 pass and 1 skips without one) and `tests/test_vsix.py` (22 tests: the stale-pair fixture added for T7-07, three CRLF reproducibility tests, the ZIP build-epoch and permission-bit invariants, three runner-boundary refusals, a synchronous-primitive refusal and two capability-audit cases, all added after the tag) |
| T7-10 … T7-16, T7-19 … T7-21 | `extension/test/lockfile.test.js`, `runtime.test.js`, `runner.test.js`, `steps.test.js`, `module-boundaries.test.js`, `installer.test.js`, `status.test.js`, `hosttools.test.js`, `lockfile-adversarial.test.js` — 331/331 green across the sixteen files `npm test` runs |
| T7-17, T7-18 | `tests/test_release_identity.py`, `extension/test/unit.test.js`, `extension/scripts/with-artifact.js`, `evidence/quality-v0.3.7-2026-11-02/vsix-audit.json` |

Two findings changed the plan while it was executed, and both are recorded rather than smoothed over:

1. **The refusal's exit code is not stable.** uv 0.8.5 and newer exit 1 on a drifted pair; uv 0.5.0,
   0.6.10 and 0.7.22 exit 2 with the same sentence. Detection therefore matches
   `DRIFT_SIGNATURE` on stderr and never a number. Receipt: `uv-matrix.json`.
2. **A four-part version cannot be packaged.** `@vscode/vsce` validates the manifest with
   `semver.valid`, which returns null for `0.3.6.1` ([vscode-vsce #415](https://github.com/microsoft/vscode-vsce/issues/415),
   closed as designed). The release is 0.3.7 and `tests/test_release_identity.py` now fails on any
   version the packager would refuse, so the constraint is a guard instead of a surprise.

Still open, unchanged from Phase 6: the reference-host receipts (Windows 11 x64 / VS Code Desktop
1.141.0) for the G1–G4 profile gates. This release proves the install path on a Linux development
host with real uv binaries; it does not reproduce the field host.
