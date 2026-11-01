# Checklist — module boundaries (D8, R6-32…R6-36)

- [x] `extension.js` contains no install-step implementation and no process spawn.
- [x] `hosttools.js`, `runner.js`, `preflight.js`, `setuplog.js`, `steps.js`, `status.js` exist with one concern each.
- [x] `installer.js` keeps only selection, step status, artifact verification, receipt and plan execution.
- [x] `diagnostics.js` no longer imports `node:child_process`.
- [x] Exactly one module imports `node:child_process`, and the audit names it.
- [x] No import cycle between the new modules.
- [x] Each new module has its own test file with injected fakes.
- [x] The 0.3.5 tests still pass, with one deliberate rewrite: the test that asserted `runPlan` rejects when a step fails was rewritten to assert the new returned outcome — the failure, the blocked dependents and the plan outcome — because that contract changed in 0.3.6.
- [x] `scripts/package.js` and `scripts/verify_vsix.py` inventory list the new modules.
- [x] The audit still rejects a second process boundary or a network capability.

## Verification status — 1 November 2026

Covered by `test/runner.test.js`, `test/hosttools.test.js`, `test/preflight.test.js`,
`test/setuplog.test.js`, `test/status.test.js`, `test/steps.test.js` and `test/gui-status.test.js`
(104 Node tests, 104 pass, 0 fail), the 105-test Python suite, `scripts/verify_vsix.py` and the recorded
audit probes in [`audit-probe-results.json`](../../../evidence/quality-v0.3.6-2026-11-01/audit-probe-results.json).
Residual limits: no Extension Host receipt yet (`npm run test:host` and `test/browser.test.js` still
need a real host), and no real `uv` run on this machine — `uv` is absent from PATH here, so the
download path is exercised through injected fixtures rather than a live interpreter download.
