# Phase 6 specification — reliable component installation and visible installation status (0.3.6)

Date: 1 November 2026 (Europe/Prague). Predecessor: [specs/phase-5](../phase-5/spec.md) (0.3.5 stabilization).

## 1. Observed failure

The 0.3.5 VSIX installed successfully in VS Code, and the extension activated. **The individual
components were not installed**: the managed Python environment and its packages were never created,
and the control panel gave no explanation beyond per-component "Not installed in this workspace".

The user's request for 0.3.6:

1. Detailed installation status reporting in the GUI.
2. An explicit overall outcome — "installation successful" or a specific status that supports troubleshooting.
3. Component installation and management that actually works.
4. Isolate the individual functions of the large extension modules.

## 2. Diagnosis from the shipped 0.3.5 source

Each item names the code that produces the behaviour. None of it is speculation about the user's machine;
each is a defect that would produce exactly the reported symptom, and each is fixed in 0.3.6.

| # | Defect | Evidence in 0.3.5 | Consequence on a real host |
|---|---|---|---|
| D1 | Host tools are found only on absolute `PATH` entries of the Extension Host process. | `diagnostics.findHostTool` iterates `process.env.PATH.split(path.delimiter)` and `continue`s on any non-absolute entry; nothing else is searched. `checkInventory` states it: "No executable found on absolute, non-workspace PATH entries. Other installation locations were not searched." | uv installed in a per-user location that the editor process did not inherit (installed after VS Code started, or through an installer that only adds it to a login shell) is invisible. `setupRuntime` throws before touching any file: "Install uv using its component guide, restart VS Code, and retry setup. No packages were changed." **No step runs, so nothing is installed.** |
| D2 | Every subprocess failure is collapsed into one of three canned strings; exit code, stderr and the command are discarded. | `diagnostics.runFile` maps the error to `"Setup cancelled…"`, `"Operation timed out…"` or `"Runtime operation failed. Check uv/Python availability and network/proxy access…"`. `stderr` is not even captured (`execFile` callback uses `(error, stdout)`). | The operator cannot tell a missing interpreter from a proxy refusal from a lock-file conflict. Troubleshooting is impossible, which is exactly what the report asked to fix. |
| D3 | Output buffer is 64 KiB and the first-run sync timeout is 240 s. | `runFile` passes `maxBuffer: 65536`; `setupRuntime` uses `timeout: 240000` for `uv sync --locked --python 3.12`; `notebook-env` uses 600000. | A first `uv sync` that downloads a managed CPython 3.12 plus wheels on a slow or proxied connection exceeds 240 s → "Operation timed out" → the worker step fails and every dependent step is skipped. A verbose child can also trip `ERR_CHILD_PROCESS_STDOUT_MAXBUFFER`, reported as "Runtime operation failed". |
| D4 | Setup starts subprocesses before checking anything, and a stale lock blocks every later attempt. | `setupRuntime` acquires `.research-toolkit/managed/.setup.lock` with `wx` and reports `EEXIST` as "Another setup is running, or a prior setup was interrupted. If no setup is running, remove only … and retry." No age or owner check, no GUI action. | One interrupted run (cancelled download, editor reload) permanently blocks setup until the user deletes a file by hand — with no button and no status explaining it. |
| D5 | Failures are not recorded anywhere. | `runPlan` writes the receipt only after a step succeeds (`receipt.steps[id] = { …, status: "installed" }`); `stepStatus` then reports `missing` / "Not installed in this workspace." | After a partial setup the panel cannot distinguish "never attempted" from "attempted and failed", nor show what was attempted, when, or why. |
| D6 | The GUI has no installation outcome. | `runComponentPlan` returns the run object; on a thrown step error it propagates out of `register(...)` (no `try`/`catch` in the command registration). The panel receives `progressMessage` and step statuses only. | The user sees a transient toast and a panel that still says "Not installed", with no verdict, no failing step, and no next action. |
| D7 | The plan aborts at the first failure. | `runPlan` loops `for (const id of selected)` and lets any `runStep` rejection escape. | A uv/network failure in the `worker` step prevents `research-overlay` — which needs no network and no interpreter — from being installed at all. |
| D8 | Module boundaries have outgrown their names. | `extension.js` 899 lines (commands, panel, presets, MCP provider, inventory, setup orchestration); `installer.js` 488 lines (selection, status, artifact verification, notebook project inspection, overlay writing, four step implementations, plan execution); `diagnostics.js` 210 lines (inventory, JSON probing, the process boundary, host tool search, text rendering). | The install path cannot be tested or changed in isolation, which is why D1–D7 survived four releases. |

## 3. Requirements

`R6-xx` are normative. `→` names the finding they close.

### 3.1 Host tool resolution (D1)

- **R6-01** Host tool lookup searches, in order: an explicit configured path, `PATH`, then a bounded list of
  documented per-user install locations for the current platform, then the toolkit's own managed location.
- **R6-02** Every searched location is reported. A "not found" result names the categories searched and the
  count of directories, so the operator knows where to look.
- **R6-03** A resolved tool is verified by running its version command with a bounded timeout; a tool that
  exists but does not answer is reported as `unverified`, not as installed.
- **R6-04** A minimum version is declared in the component registry and enforced; an older tool is reported
  with the version found and the version required.
- **R6-05** A configured path (`researchStack.uvPath`) is honoured, validated as an existing absolute
  non-workspace executable, and reported as the resolution source.
- **R6-06** Resolution results are cached per session with the reason and timestamp, and are re-checked when
  the setting or the workspace folders change.
- **R6-07** Workspace-local executables are still refused (a `.venv/bin/uv` inside the workspace is not a host tool).

### 3.2 Process execution (D2, D3)

- **R6-08** Exactly one module in the extension may spawn a process, and the VSIX audit names it.
- **R6-09** The runner captures `stdout`, `stderr`, exit code, signal, duration and the resolved command, and
  returns them as a structured result or a structured `RunError`.
- **R6-10** Failure messages name the executable, the subcommand, the exit code and the last useful stderr
  lines. No canned string may replace them.
- **R6-11** Output capture is bounded but generous (≥1 MiB), and a truncated capture is reported as truncated.
- **R6-12** Timeouts are declared per step in the component registry, with a first-run allowance for steps that
  download, and an operator override (`researchStack.setupTimeoutSeconds`).
- **R6-13** A step that fails for a retryable reason is retried once with a bounded delay, and both attempts
  are recorded.
- **R6-14** Cancellation is preserved: an aborted run reports `cancelled`, keeps completed files, and never
  retries.
- **R6-15** The runner never uses a shell, never inherits a workspace working directory it has not verified,
  and keeps the reviewed environment policy for uv.

### 3.3 Preflight and recovery (D4, D7)

- **R6-16** Before any subprocess, setup runs a preflight that reports: workspace trust and locality, host tool
  resolution, the managed path's realness (no link/junction), disk writability of the managed folder, and the
  setup-lock state.
- **R6-17** A lock is reported with its age and owner pid. A lock whose owner process is gone, or that is
  older than the configured setup window, is classified `stale` and can be cleared by an explicit command
  that removes only that file.
- **R6-18** Preflight failures stop the plan **before** any file or process is touched, and each failure names
  the action that would clear it.
- **R6-19** A plan continues after a step failure: steps that do not depend on the failed step still run
  (overlay files need no interpreter), and dependents are reported as `blocked` with the reason.
- **R6-20** A blocked step is never recorded as installed, and the receipt keeps the last attempt for every step.

### 3.4 Installation status record (D5)

- **R6-21** Each attempt is recorded per step: status, started/finished timestamps, duration, command summary,
  exit code, error text, attempt number, and the artifacts verified afterwards.
- **R6-22** The workspace holds an append-only setup log (`.research-toolkit/logs/setup-<utc>.jsonl`) and a
  current status record (`.research-toolkit/logs/last-setup.json`) that the GUI reads; both are inside the
  workspace ignore rules.
- **R6-23** The status record carries an overall outcome from a fixed set:
  `success`, `partial`, `failed`, `blocked`, `cancelled`, `not-run`.
- **R6-24** The outcome is computed from evidence, not from the absence of an exception: every selected step is
  either installed-and-artifact-verified, skipped-as-current, or has a named failure.
- **R6-25** Log and status records are written atomically and never contain document text or secrets.

### 3.5 GUI reporting (D6)

- **R6-26** The control panel shows an installation status card: overall outcome, package, toolkit version,
  workspace folder, timestamp, and the failing or blocked step with its reason.
- **R6-27** Each step row shows status, last attempt time, duration, and — when it failed — the exit code and
  error summary.
- **R6-28** The panel offers, as applicable: **Retry failed steps**, **Clear interrupted setup lock**,
  **Open setup log**, **Copy installation diagnostics**.
- **R6-29** A successful setup says so in plain words ("Installation complete — N component step(s) verified")
  and a failed one says what to do next.
- **R6-30** Status survives a panel reopen and an editor reload: it is read from the workspace record, not from
  in-memory state.
- **R6-31** Host tool resolution is shown (found path + version, or the searched categories) so a missing tool
  is visible before a setup is attempted.

### 3.6 Module boundaries (D8)

- **R6-32** `extension.js` keeps activation, command registration and panel wiring only.
- **R6-33** One module per concern: `hosttools.js` (resolution), `runner.js` (the single process boundary),
  `preflight.js`, `setuplog.js` (log + status record), `steps.js` (the four step implementations),
  `installer.js` (plan engine: selection, status, artifacts, receipt), `status.js` (outcome computation and
  diagnostics text), `runtime.js` (bundle, managed runtime, runtime lifecycle), `diagnostics.js` (inventory and
  text rendering).
- **R6-34** Each new module is unit-testable with injected fakes and has its own test file.
- **R6-35** Public behaviour of 0.3.5 that tests already assert (selection closure, artifact verification,
  repair, rollback, preset identity) stays intact; the refactor is proven by keeping those tests green.
- **R6-36** The VSIX inventory and the audit's reviewed process-boundary pattern are updated to the new module
  set, and the audit still fails if a second process boundary or a network capability appears.

### 3.7 Release hygiene

- **R6-37** Version 0.3.6 in `pyproject.toml`, `research_stack.__version__`, `extension/package.json`,
  `extension/vsix-manifest.json` and `runtime.js` (`worker-0.3.6`), with the audit deriving it from source.
- **R6-38** Guides and README describe the new status card, the retry/continue behaviour, the timeout setting and
  the uv resolution order.
- **R6-39** No claim of a successful real-host installation is made without a receipt for 0.3.6. G1–G4 stay open.

## 4. Out of scope for 0.3.6

- Installing uv itself, or any other third-party binary. The toolkit reports where it looked and what it found.
- Silent network installs, background setup, or setup during activation. Setup stays an explicit operator action.
- Kernel execution, provider connectivity, and the extraction→index bridge designed in phase 5.
- Closing G1–G4. Reference-host receipts remain the gate.
