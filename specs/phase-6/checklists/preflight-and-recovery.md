# Checklist — preflight, lock and plan resilience (D4, D7, R6-16…R6-20)

- [x] Preflight runs before any file write or subprocess.
- [x] Checks cover trust, locality, host tools, managed-path realness, writability and lock state.
- [x] Each failing check names the action that clears it.
- [x] Lock state is `free | held | stale` with age and owner pid.
- [x] A stale lock is cleared by an explicit command that removes only that file.
- [x] A live lock is refused with the owning pid and age.
- [x] A failed step does not stop independent steps.
- [x] Dependents of a failed step are reported `blocked` with `blockedBy`.
- [x] A blocked or failed step is never recorded as installed.
- [x] The receipt keeps `lastAttempt` for a step whose last attempt failed, was cancelled or was blocked; a step that installed, or was skipped as already current, carries no `lastAttempt`.
- [x] An interrupted plan is resumable: completed steps stay skipped-as-current.

## Verification status — 1 November 2026

Covered by `test/runner.test.js`, `test/hosttools.test.js`, `test/preflight.test.js`,
`test/setuplog.test.js`, `test/status.test.js`, `test/steps.test.js` and `test/gui-status.test.js`
(104 Node tests, 104 pass, 0 fail), the 105-test Python suite, `scripts/verify_vsix.py` and the recorded
audit probes in [`audit-probe-results.json`](../../../evidence/quality-v0.3.6-2026-11-01/audit-probe-results.json).
Residual limits: no Extension Host receipt yet (`npm run test:host` and `test/browser.test.js` still
need a real host), and no real `uv` run on this machine — `uv` is absent from PATH here, so the
download path is exercised through injected fixtures rather than a live interpreter download.
