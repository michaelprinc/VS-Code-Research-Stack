# Phase 6 tasks — 0.3.6

Stages run in order; each stage ends with its own verification gate. Checklists:
[checklists/](checklists/).

## Stage A — isolate the install path (no behaviour change)

- [x] A1 Create `hosttools.js`: `resolveHostTool`, `probeVersion`, per-session cache, `searched` report. (R6-01…R6-07)
- [x] A2 Create `runner.js`: `runProcess`, `RunError`, per-kind environment, buffer cap, retry policy, cancellation. (R6-08…R6-15)
- [x] A3 Move the `execFile` boundary out of `diagnostics.js`; `diagnostics.js` and `runtime.js` take injected services. (R6-08, R6-33)
- [x] A4 Move the four step bodies out of `installer.js` into `steps.js`; `installer.js` keeps selection, status, artifacts, receipt, plan. (R6-33)
- [x] A5 Split status/outcome text out of `diagnostics.js` into `status.js`. (R6-33)
- [x] A6 New test files `test/hosttools.test.js`, `test/runner.test.js`, `test/status.test.js`; keep every 0.3.5 test green. (R6-34, R6-35)
- [x] **Gate A:** `npm test` green with the refactored modules and the same public contracts.

## Stage B — resolution and execution reliability

- [x] B1 Known-location search list per platform, bounded and documented; report the searched categories. (R6-01, R6-02)
- [x] B2 `researchStack.uvPath` setting: validate, honour, report the source. (R6-05)
- [x] B3 Version probe with bounded timeout; `minimumVersion` in `components.json`; `unverified` state. (R6-03, R6-04)
- [x] B4 Runner captures stdout/stderr/exit/signal/duration; structured `RunError`; evidence-based messages. (R6-09, R6-10)
- [x] B5 1 MiB buffer with `truncated` reporting; per-step timeouts from the registry; `researchStack.setupTimeoutSeconds`. (R6-11, R6-12)
- [x] B6 One bounded retry for transport-shaped setup failures; attempts recorded; no retry on cancellation or `ENOENT`. (R6-13, R6-14)
- [x] **Gate B:** unit tests prove each behaviour with real child processes and fake hosts.

## Stage C — preflight, log, attempt records, plan resilience

- [x] C1 `preflight.js`: trust/locality, host tools, managed path realness, writability, lock state. (R6-16, R6-18)
- [x] C2 Lock classification `free | held | stale` with age and pid; `researchToolkit.clearSetupLock`. (R6-17)
- [x] C3 `setuplog.js`: append-only JSONL log + `last-setup.json`, atomic writes, workspace-contained. (R6-21, R6-22, R6-25)
- [x] C4 `runPlan` continues after a failure; dependents become `blocked` with `blockedBy`. (R6-19)
- [x] C5 Receipt keeps `lastAttempt` per step; a failed or blocked step is never recorded installed. (R6-20)
- [x] C6 Preflight result stored in the status record and shown before a setup is attempted. (R6-31)
- [x] **Gate C:** integration tests prove partial-failure behaviour and resumability.

## Stage D — installation status in the GUI

- [x] D1 `status.js` outcome computation over the fixed outcome set. (R6-23, R6-24)
- [x] D2 Panel installation-status card: outcome line, package/version/folder/timestamp/duration. (R6-26, R6-29)
- [x] D3 Per-step rows with last attempt, duration, exit code and error summary. (R6-27)
- [x] D4 Actions: Retry failed steps, Clear interrupted setup lock, Open setup log, Copy installation diagnostics. (R6-28)
- [x] D5 Status read from the workspace record so a reopen or reload shows the same verdict. (R6-30)
- [x] D6 Host-tool line in the panel (found path + version, or searched categories). (R6-31)
- [x] **Gate D:** GUI tests assert the outcome wording, the failing-step row, the actions, and reopen persistence.

## Stage E — release hygiene

- [x] E1 Version 0.3.6 in `pyproject.toml`, `research_stack/__init__.py`, `extension/package.json`, `extension/vsix-manifest.json`, `runtime.js`. (R6-37)
- [x] E2 `scripts/package.js` copy list and `scripts/verify_vsix.py` `EXPECTED` + reviewed process-boundary pattern. (R6-36)
- [x] E3 Bootstrap overlay `.gitignore` covers `.research-toolkit/logs/`. (R6-22)
- [x] E4 Guides and READMEs: status card, retry/continue, timeouts, uv resolution order, new settings. (R6-38)
- [x] E5 Rebuild guide index + worker bundle, package the VSIX, audit it, run the installed-payload check. (R6-36)
- [x] E6 Full verification sweep: Python suite, Node suite, MCP functional check, VSIX audit, payload check, re-run review probes.
- [x] E7 `docs/implementation/phase-6-install-reliability/implementation-report-0.3.6.md` with updated features and gaps. (R6-39)

## Verification commands

```bash
# from toolkit/
.venv/bin/python -m pytest -q
.venv/bin/python scripts/build_guide_index.py
.venv/bin/python scripts/build_worker_bundle.py
cd extension && node scripts/package.js && cd ..
sha256sum dist/research-stack-toolkit-0.3.6.vsix | tee dist/research-stack-toolkit-0.3.6.vsix.sha256
.venv/bin/python scripts/verify_vsix.py dist/research-stack-toolkit-0.3.6.vsix
.venv/bin/python extension/functional_check.py
cd extension && npm test && npm run check:payload
```
## Stage gates — 1 November 2026

All five stages are implemented and gated by recorded evidence: Stage A by `test/runner.test.js`,
`test/hosttools.test.js` and `test/module-boundaries.test.js`; Stage B by `test/preflight.test.js` and
`test/installer.test.js` (including the T6-13 independent-step case); Stage C by `test/setuplog.test.js`,
`test/status.test.js` and `tests/test_workspace.py`; Stage D by `test/gui-status.test.js` and
`npm run check:payload` against the packaged panel; Stage E by `test/unit.test.js`,
`scripts/verify_vsix.py`, `audit_probes.py` and
[`evidence/quality-v0.3.6-2026-11-01/`](../../../evidence/quality-v0.3.6-2026-11-01/README.md).

Residual: the host-side halves of T6-27 and T6-28 (real Extension Host, real browser renderer, real uv run)
remain unexecuted, so G1–G4 stay open.
