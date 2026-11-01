# Phase 6 acceptance — 0.3.6

Each case names how it is proven on this host. "Verified" requires a test or a recorded receipt.

| Case | Scenario | Expected | Proof |
|---|---|---|---|
| T6-01 | uv is absent from `PATH` but present in a documented per-user location | resolved from `known-location`, with the searched categories reported | `test/hosttools.test.js` |
| T6-02 | uv is nowhere | resolution fails with `reason` + `hint` + searched counts; no file or process is touched | `test/hosttools.test.js`, `test/preflight.test.js` |
| T6-03 | `researchStack.uvPath` points at a real executable | used as the resolution source; a workspace-local configured path is refused and recorded in `workspaceRefusals`, and a missing path resolves to nothing. A present-but-non-executable path is refused by the resolver's executable check in `extension/hosttools.js`; a test for that half is being added in this pass | `test/hosttools.test.js` (setting honoured, workspace-local refusal, missing path) |
| T6-04 | tool exists but `--version` times out | reported `unverified`, setup refuses to use it | `test/hosttools.test.js` |
| T6-05 | tool version below the registry minimum | reported with found vs required version | `test/hosttools.test.js` |
| T6-06 | a subprocess exits non-zero | `RunError` carries `kind`, exit code, captured `stderr`, `command`, `cwd` and `durationMs`. The tests assert `kind`, `exitCode`, `stderr` and the `message` (which names the exit code, the last stderr line and the cwd). `durationMs` is produced but not asserted, and the stderr tail is assembled into the message by `describe()`, not stored as a separate field | `test/runner.test.js` |
| T6-07 | a subprocess exceeds its timeout | `kind: "timeout"`, bounded duration, no unbounded wait | `test/runner.test.js` |
| T6-08 | a subprocess writes ~200 000 characters | the captured output is truncated at the 64 KiB report limit and reported (`truncated: true`), and the run still completes; the 8 MiB capture bound is asserted only as a constant (`MAX_BUFFER_BYTES >= 1 MiB`) | `test/runner.test.js` |
| T6-09 | an AbortSignal fires | `kind: "cancelled"`, no retry, completed files preserved | `test/runner.test.js` |
| T6-10 | a transport-shaped setup failure | exactly one bounded retry, both attempts recorded | `test/runner.test.js`, `test/installer.test.js` |
| T6-11 | a stale setup lock (owner pid gone) | classified `stale`; `clearSetupLock` removes only that file; a live lock is refused | `test/preflight.test.js` |
| T6-12 | preflight fails | no step runs, outcome `blocked`, the panel names the clearing action | `test/preflight.test.js`, GUI test |
| T6-13 | `worker` fails, `research-overlay` is independent | a failing step does not abort the plan; steps that do not declare the failed step as a prerequisite continue, and every step that does declare it is recorded `blocked` with `blockedBy` | `extension/test/installer.test.js` (the worker-failure case), `extension/scripts/check-installed-payload.js` (the packaged reproduction) |
| T6-14 | a step fails twice | receipt records `lastAttempt` with the error; the step is not `installed` | `test/installer.test.js` |
| T6-15 | setup log and status record | JSONL is append-only, `last-setup.json` is atomic, both inside the workspace and ignored by git | `test/setuplog.test.js`, `tests/test_workspace.py` |
| T6-16 | outcome rules | each of `success`, `partial`, `failed`, `blocked`, `cancelled`, `not-run` is produced by its own fixture | `test/status.test.js` |
| T6-17 | a step exits 0 but leaves no interpreter | outcome is `partial` with the missing artifact named | `test/installer.test.js`, `test/status.test.js` |
| T6-18 | panel after a successful setup | "Installation complete — N component step(s) verified" with per-step durations | GUI test |
| T6-19 | panel after a partial setup | failing step row with exit code and error summary; Retry/Clear lock/Open log/Copy diagnostics offered | GUI test |
| T6-20 | panel reopened after a failure | same verdict read from the workspace record, not from memory | GUI test |
| T6-21 | host-tool line | shows resolved path + version, or the searched categories | GUI test |
| T6-22 | 0.3.5 behaviour preserved | selection closure, artifact repair, rollback, preset identity, single-dispatch tests still pass | existing Node suites |
| T6-23 | Python behaviour preserved | full Python suite green at 0.3.6 | `.venv/bin/python -m pytest` |
| T6-24 | real MCP functional check | `ok: true`, 20 measured tool definitions, lab journey checks pass | `extension/functional_check.py` |
| T6-25 | VSIX audit | inventory matches the reviewed module set; exactly one process boundary in `extension/runner.js`; packaged bytes equal source | `scripts/verify_vsix.py` |
| T6-26 | installed-payload check | presets, tool surface, commands and the new status card asserted against the packaged artifact | `npm run check:payload` |
| T6-27 | version identity | 0.3.5 → 0.3.6 in all five identity files; audit derives it from source | extension-side identity — `extension/package.json`, `extension/vsix-manifest.json`, `extension/runtime.js` and `extension/worker/bundle.json` — is checked by `scripts/verify_vsix.py` and `extension/test/unit.test.js`; cross-language identity (`pyproject.toml` ↔ `src/research_stack/__init__.py` ↔ the extension manifest) is asserted by `tests/test_release_identity.py`, a new test being added in this pass |
| T6-28 | honesty | no 0.3.6 real-host receipt is claimed; G1–G4 stay open | report + evidence README |

## Traceability

Test names in `extension/test/gui-status.test.js` cite T6 numbers. The mapping between a case and its
proof is authoritative in this file, not in the test names; the GUI test names were corrected in this
pass so that the numbers they cite match the behaviour those tests actually exercise.
