# Phase 7 tasks — 0.3.7

Stages run in order; each stage ends with its own gate. Checklists: [checklists/](checklists/).

## Stage A — prove the failure, then fix the pair

- [x] A1 Reproduce the field failure on this host with real uv, and record the reproduction (R7-01 evidence). → `evidence/quality-v0.3.7-2026-11-02/run_uv_matrix.py`, `uv-matrix.json`
- [x] A2 Regenerate `uv.lock` with the pinned uv so the root entry matches `pyproject.toml`; confirm the package set is unchanged. (R7-06) → `lock-provenance.json`: two-line diff, 39 third-party pins unchanged
- [x] A3 **Gate A:** the exact command `runtime.js` issues exits 0 on the corrected pair on uv 0.5.0 → 0.13.6, and still refuses the 0.3.6 pair on all seven with uv's lock sentence. The refusal's **exit code is not stable** (1 on uv ≥ 0.8, 2 on 0.5.0–0.7.22), which is why detection matches the message and never the number.

## Stage B — make the drift impossible to ship

- [x] B1 `scripts/lockintegrity.py`: uv-free reader of the fields uv compares; CLI + JSON + exit code. (R7-01)
- [x] B2 `scripts/build_worker_bundle.py`: refuse a stale pair, re-check what it wrote. (R7-02)
- [x] B3 `scripts/verify_vsix.py`: compare the **packaged** worker pair. (R7-03)
- [x] B4 `tests/test_lock_consistency.py`: shipped pairs, byte-equality of the bundled pair, synthetic drift fixture, revision bound, real `uv lock --check` when uv exists. (R7-04, R7-05)
- [x] B5 **Gate B:** the suite fails against a deliberately drifted copy and passes against the release tree. → `tests/test_lock_consistency.py` (37 synthetic pair fixtures — `grep -c "_fixture(" tests/test_lock_consistency.py` gives 38, the helper's own definition included), `tests/test_vsix.py::test_vsix_verifier_refuses_a_packaged_worker_whose_lock_is_stale`

## Stage C — diagnose and recover at runtime

- [x] C1 `extension/lockfile.js`: drift signature, lock/pyproject readers, `pairProblems`, `dependencyPins`. (R7-07, R7-08)
- [x] C2 `extension/runtime.js`: bundled-pair self-check before any uv call. (R7-07)
- [x] C3 `extension/runner.js`: precise lock-drift message; wall time across attempts. (R7-08, R7-17)
- [x] C4 `extension/runtime.js`: one logged `--frozen` fallback after a recognised drift; never plain `uv sync`. (R7-09, R7-10)
- [x] C5 `extension/runner.js`: scrub conflicting inherited `UV_*`, keep the five reviewed `UV_*` values plus the derived `UV_PROJECT_ENVIRONMENT`. (R7-11)
- [x] C6 `extension/test/lockfile.test.js` plus runtime tests for the self-check, the tier, and the message. (R7-07…R7-10)
- [x] C7 **Gate C:** `npm test` green with the new module in the reviewed boundary set. → green at freeze: 331/331 Node and 207 Python, `lockfile.js` declared in `test/module-boundaries.test.js`

## Stage D — release identity

- [x] D1 Release identity kept **three-part** and now asserted as a version `@vscode/vsce` can package; `WORKER_FOLDER_PATTERN` accepts exactly the folder names a release can produce. (R7-13, R7-14) — the requested `0.3.6.1` is impossible to package (D7-06), so the release is 0.3.7.
- [x] D2 npm scripts resolve the artifact from `extension/vsix-manifest.json`. (R7-15)
- [x] D3 `functionalCheck` honours `researchStack.setupTimeoutSeconds`. (R7-16)
- [x] D4 **Gate D:** identity suite green for `0.3.7`; the identity is a version vsce can package, and malformed managed-folder names are skipped.

## Stage E — package, audit, report

- [x] E1 Rebuild guide index + worker bundle; cut `dist/research-stack-toolkit-0.3.7.vsix` + `.sha256`.
- [x] E2 `scripts/verify_vsix.py` passes on the new artifact, including the packaged-pair check.
- [x] E3 `npm run check:payload` passes on the new artifact.
- [x] E4 Evidence folder `evidence/quality-v0.3.7-2026-11-02/` with the reproduction, the uv-version matrix and the audit results.
- [x] E5 CHANGELOG, release report, `.agent/QUALITY_STATE.md`, gate report.
- [x] E6 **Gate E:** full suites green (250 Node / 185 Python with a real uv, 184 + 1 skip without); artifact hash recorded; commit + tag `v0.3.7`, re-cut after the review rounds.
