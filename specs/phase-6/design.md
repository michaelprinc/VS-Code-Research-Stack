# Phase 6 design — install engine split, bounded execution, recorded status

Decisions **D6-xx** are binding for 0.3.6. Requirements are in [spec.md](spec.md).

## 1. Module map after the refactor

```
extension/
  extension.js      activation, commands, panel wiring, MCP provider      (no install logic)
  hosttools.js      host executable resolution + version probe + cache    (R6-01…R6-07)
  runner.js         THE ONLY process boundary: bounded execFile wrapper   (R6-08…R6-15)
  preflight.js      pre-execution checks, setup-lock classification       (R6-16…R6-18)
  setuplog.js       append-only JSONL log + last-setup.json status record (R6-21…R6-25)
  steps.js          worker / research-overlay / notebook-env / lab-store   (step bodies)
  installer.js      plan engine: selection, status, artifacts, receipt     (R6-19…R6-20)
  status.js         outcome computation + human diagnostics text          (R6-23…R6-31)
  runtime.js        bundle integrity, managed runtime, runtime lifecycle
  diagnostics.js    component inventory + inventory text (no process spawn)
  ui.js / media/controls.js   panel markup + client behaviour
```

**D6-01 — one process boundary.** `runner.js` owns `require("node:child_process")`. `diagnostics.js` and
`installer.js` receive the runner as an injected service. The audit pattern moves from `extension/diagnostics.js`
to `extension/runner.js` and still requires exactly one import, one call site, `windowsHide: true`, `shell: false`,
a default timeout and a bounded buffer.

**D6-02 — dependency direction.** `runner → (nothing)`, `hosttools → runner`, `preflight → hosttools, runtime`,
`steps → runner, runtime, hosttools`, `installer → steps, setuplog`, `status → (pure)`, `diagnostics → hosttools,
runtime, installer`, `extension.js → all`. No cycles; `status.js` is pure so the GUI can be tested without a host.

**D6-03 — services stay injectable.** Every module that can touch the machine takes `services = {}` overrides
(`runFile`, `findHostTool`, `progress`, `signal`, `now`), so the Node suites drive the whole install path with
fake subprocesses and disposable temp workspaces, as they already do for 0.3.5.

## 2. Host tool resolution

```
resolveHostTool(name, { roots, configuredPath, platform, env })
→ { name, path, version, source: "setting" | "path" | "known-location" | "managed",
    verified: true,  searched: { setting, pathEntries, knownLocations, managed }, probedAt }
→ { name, path: null, source: null, verified: false, searched: {…}, reason, hint }
```

Search order (R6-01): configured setting → `PATH` → platform known locations → managed. Known locations are a
**bounded, documented list**, not a filesystem walk:

- win32: `%USERPROFILE%\.local\bin`, `%LOCALAPPDATA%\Programs\uv`, `%APPDATA%\Python\Python*\Scripts`,
  `%USERPROFILE%\scoop\shims`, `%LOCALAPPDATA%\Microsoft\WinGet\Links`
- darwin: `/usr/local/bin`, `/opt/homebrew/bin`, `$HOME/.local/bin`, `$HOME/.cargo/bin`
- linux: `/usr/local/bin`, `/usr/bin`, `$HOME/.local/bin`, `$HOME/.cargo/bin`

Rules kept from 0.3.5: entries must be absolute; a resolved executable inside a workspace folder is refused
(R6-07); links are resolved before the containment test.

**D6-04 — a found-but-unverified tool is not installed.** `--version` must answer within 8 s or the tool is
reported `unverified` with the path, and setup refuses to run with it (R6-03).

**D6-05 — minimum version is registry data.** `components.json` host components gain `minimumVersion`
(uv `0.5.0`), so the requirement is reviewable and reported, not buried in code (R6-04).

## 3. Runner contract

```
runProcess(executable, args, { timeout, cwd, env, signal, kind })
→ { ok: true, stdout, stderr, exitCode: 0, durationMs, truncated, command }
→ throws RunError { name: "RunError", kind: "timeout" | "cancelled" | "exit" | "spawn" | "buffer",
                    command, cwd, exitCode, signal, stderrTail, durationMs, hint }
```

- `maxBuffer` 1 MiB per stream; `truncated: true` when the cap is hit (R6-11).
- `kind` selects the reviewed environment: `setup` (uv policy), `python` (`-I -B` isolation is the caller's
  argument choice, environment inherited), `probe` (short default timeout).
- Retry (R6-13): `kind: "setup"` retries once after 2 s when the failure looks transport-shaped
  (`timeout`, `spawn` `ENOENT` is **not** retried, network-flavoured stderr). The attempt number is recorded.
- Cancellation (R6-14): `AbortSignal` → `kind: "cancelled"`, no retry, completed files preserved.
- Error text is assembled from evidence: `uv sync failed (exit 2): <last stderr lines> · cwd <dir> · 41.3 s`
  plus the registry `hint` (R6-10).

## 4. Preflight

```
runPreflight({ vscode, context, folder, packageId, steps, settings })
→ { ok: boolean, checks: [{ id, label, status: "ok"|"warn"|"fail"|"n-a", detail, action }],
    hostTools: [...], lock: { state: "free"|"held"|"stale", path, ageMs, pid }, blockers: [id] }
```

Checks: `workspace-local`, `trust`, `host-tool` (per tool the plan needs), `managed-path`, `managed-writable`,
`setup-lock`. A `fail` blocks the plan (R6-18) and each check carries the action that clears it.

**D6-06 — stale-lock classification is conservative.** A lock is `stale` only when the recorded pid is not a
live process **or** its age exceeds the setup window (max step timeout + 5 min). Otherwise it is `held` and setup
refuses. Clearing is a separate command that deletes exactly one reviewed file path.

## 5. Plan execution with continuation

```
runPlan(...) → { receipt, ran, skipped, repaired, blocked, failed, selected, outcome, log, statusRecord }
```

- Steps run in plan order. After a failure, remaining steps whose prerequisites include the failed step are
  marked `blocked` with `blockedBy` (R6-19); independent steps continue.
- Every step gets an attempt record (R6-21) written to the log immediately, and the receipt keeps
  `steps[id].lastAttempt` while `status` stays `installed` only for verified steps (R6-20).
- The receipt is written after each step, so an interrupted plan is resumable — unchanged from 0.3.5.

## 6. Status record and outcome

`.research-toolkit/logs/last-setup.json` (schemaVersion 1):

```
{ schemaVersion, outcome, package, toolkitVersion, workspaceFolder, startedAt, finishedAt,
  durationMs, steps: [{ id, label, status, attempts, durationMs, exitCode, error, hint,
                        artifacts: { verified, missing } }],
  preflight: { ok, blockers }, hostTools: [...], logFile }
```

Outcome rules (R6-23, R6-24) — evaluated in order:

| Outcome | Condition |
|---|---|
| `not-run` | no status record exists |
| `cancelled` | any step ended `cancelled` and nothing failed for another reason |
| `blocked` | preflight failed before any step ran |
| `failed` | every selected step failed or was blocked |
| `partial` | at least one step installed/verified **and** at least one failed, blocked or unverified |
| `success` | every selected step is `installed` with verified artifacts |

**D6-07 — "successful installation" is earned, not assumed.** A step counts only when its produced files are
re-verified after the run (`verifyStepArtifacts`), so a `uv sync` that exits 0 but leaves no interpreter is
`partial` with a named missing artifact.

## 7. GUI

New card in the control panel, above the component plan:

```
Installation status: Installation complete — 4 component step(s) verified
Full · toolkit 0.3.6 · <folder> · 1 Nov 2026 09:14 · 3 m 12 s
worker installed 2 m 41 s · research-overlay installed 0.4 s
notebook-env failed (exit 2) 1 m 03 s — uv sync failed: request timed out after 900 s
lab-store blocked — prerequisite notebook-env did not complete      [Retry failed] [Open log] [Copy diagnostics]
```

- Outcome wording: `success` → "Installation complete"; `partial` → "Installation incomplete — N step(s) need
  attention"; `failed` → "Installation failed — <first reason>"; `blocked` → "Setup blocked — <preflight reason>";
  `cancelled` → "Setup cancelled — completed steps were kept"; `not-run` → "No component setup has run in this
  workspace yet".
- Buttons are wired to commands, not to ad-hoc panel logic: `retryFailedSteps`, `clearSetupLock`,
  `openSetupLog`, `copyInstallationDiagnostics` (R6-28).
- The card is rendered from `status.js` output read out of the workspace record, so a reopen shows the same
  verdict (R6-30).

## 8. Compatibility and packaging

- `EXPECTED` in `scripts/verify_vsix.py` and the copy list in `extension/scripts/package.js` gain the new modules;
  the audit's process-boundary pattern moves to `extension/runner.js`.
- `runtime.js` `WORKER_FOLDER`/`WORKER_VERSION` become `worker-0.3.6`/`0.3.6`; runtimes an earlier release
  installed stay discoverable and rollback-able (0.3.5 behaviour preserved).
- `.gitignore` in the bootstrap overlay gains `.research-toolkit/logs/`.
- New settings: `researchStack.uvPath` (string, default ""), `researchStack.setupTimeoutSeconds`
  (number, default 900, clamped 60–3600).

## 9. Testing strategy

| Layer | How |
|---|---|
| Unit | `hosttools.test.js` (fake PATH + fake known dirs + configured path), `runner.test.js` (real child processes: exit 1, timeout, cancellation, buffer, retry), `preflight.test.js` (free/held/stale lock, missing tool), `setuplog.test.js` (atomic write, append-only, ignore rules), `status.test.js` (every outcome rule) |
| Integration | `installer.test.js` extended: a failing `worker` step still installs `research-overlay` and marks `lab-store` blocked; attempts recorded |
| GUI | `presets.test.js`/`unit.test.js` harness: outcome card text, failing step row, buttons present, status survives reopen |
| Functional | `extension/functional_check.py` unchanged in contract; new `setup` evidence asserted by `check-installed-payload.js` |
| Release | `scripts/verify_vsix.py` (inventory + single boundary + source match), `npm run check:payload` |
