# Checklist — installation status in the GUI (D5, D6, R6-21…R6-31)

- [x] Attempt records exist per step with status, timestamps, duration, exit code, error and hint.
- [x] `.research-toolkit/logs/setup-<utc>.jsonl` is append-only and workspace-contained.
- [x] `.research-toolkit/logs/last-setup.json` is written atomically and read by the panel.
- [x] The bootstrap overlay `.gitignore` ignores `.research-toolkit/logs/`.
- [x] Outcome set is `success | partial | failed | blocked | cancelled | not-run`.
- [x] Outcome is computed from verified artifacts, not from the absence of an exception.
- [x] The panel shows the outcome line with package, version, folder, timestamp and duration.
- [x] Each step row shows status, last attempt, duration, and on failure the exit code and error summary.
- [x] Retry failed steps, Clear interrupted setup lock, Open setup log and Copy installation diagnostics are offered as commands.
- [x] A successful setup states "Installation complete" in plain words.
- [x] The verdict survives a panel reopen and an editor reload.
- [x] Host-tool resolution is visible before a setup is attempted.
- [x] No log or status record contains research document text.

## Verification status — 1 November 2026

Covered by `test/runner.test.js`, `test/hosttools.test.js`, `test/preflight.test.js`,
`test/setuplog.test.js`, `test/status.test.js`, `test/steps.test.js` and `test/gui-status.test.js`
(104 Node tests, 104 pass, 0 fail), the 105-test Python suite, `scripts/verify_vsix.py` and the recorded
audit probes in [`audit-probe-results.json`](../../../evidence/quality-v0.3.6-2026-11-01/audit-probe-results.json).
Residual limits: no Extension Host receipt yet (`npm run test:host` and `test/browser.test.js` still
need a real host), and no real `uv` run on this machine — `uv` is absent from PATH here, so the
download path is exercised through injected fixtures rather than a live interpreter download.
