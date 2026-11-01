# Checklist — bounded process execution (D2, D3, R6-08…R6-15)

- [x] stdout, stderr, exit code, signal, duration and command are captured.
- [x] `RunError` carries them and the human message is built from them.
- [x] No canned error string replaces a captured failure.
- [x] Buffer cap is ≥1 MiB per stream and truncation is reported.
- [x] Timeouts come from the component registry per step, with the operator override applied.
- [x] The worker sync timeout is long enough for a first-run interpreter download.
- [x] One bounded retry for transport-shaped setup failures only.
- [x] Cancellation is distinguished from failure and never retried.
- [x] `shell: false`, `windowsHide: true` and the reviewed uv environment policy are preserved.
- [x] A run never uses a working directory that has not been verified as a real workspace path.

## Verification status — 1 November 2026

Covered by `test/runner.test.js`, `test/hosttools.test.js`, `test/preflight.test.js`,
`test/setuplog.test.js`, `test/status.test.js`, `test/steps.test.js` and `test/gui-status.test.js`
(104 Node tests, 104 pass, 0 fail), the 105-test Python suite, `scripts/verify_vsix.py` and the recorded
audit probes in [`audit-probe-results.json`](../../../evidence/quality-v0.3.6-2026-11-01/audit-probe-results.json).
Residual limits: no Extension Host receipt yet (`npm run test:host` and `test/browser.test.js` still
need a real host), and no real `uv` run on this machine — `uv` is absent from PATH here, so the
download path is exercised through injected fixtures rather than a live interpreter download.
