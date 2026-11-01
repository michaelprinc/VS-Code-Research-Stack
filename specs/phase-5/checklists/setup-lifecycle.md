# Checklist — setup, upgrade and repair lifecycle (F06–F09)

Findings addressed: F06 prerequisite rejection, F07 receipt-only status, F08 cross-release lifecycle, F09 notebook sync over foreign projects.

## F06 — one dependency resolver

- [x] `resolveStepSelection` expands the dependency closure instead of refusing.
- [x] A prerequisite already verified as installed is accepted.
- [x] The result names which prerequisites were added and which were already satisfied.
- [x] Unknown steps and non-list requests are still refused.
- [x] Command route, panel button route, `selectComponentStep` Quick Pick and per-component install all use the same resolver.
- [x] Probe `quickPickStep`: choosing `lab-store` after a full install succeeds.
- [x] Probe `partialUpdate`: current `worker` plus outdated `notebook-env` runs only `notebook-env`.

## F07 — artifact-aware status and repair

- [x] `verifyStepArtifacts` checks the artifacts each step actually produces (interpreter, overlay files, notebook project/environment, store file).
- [x] `stepStatus` separates recorded installation, observed artifacts, verification result and file compatibility.
- [x] A recorded-current step with a missing artifact reports `needs-repair` and names the artifact.
- [x] `runPlan` re-runs such a step without `force` and reports it as repaired.
- [x] Overlay files are classified `current` or `modified-preserved`; a modified file is never overwritten and never counted as upgraded.
- [x] Optional steps are reported as deliberate omissions, not as unmet required steps.
- [x] A quick status action re-reads the receipt and re-verifies artifacts without running the functional MCP check.
- [x] Probe `repairAfterInterpreterRemoved`: normal setup re-runs the worker step and restores the interpreter.
- [x] Probe `overlayConflict`: an incompatible README is preserved and reported, not certified.

## F08 — cross-release lifecycle

- [x] `discoverInstallations` finds receipts recorded under earlier `managed/worker-*` directories.
- [x] Setup stages the new runtime, verifies it with the functional check, then activates it through one atomic pointer record.
- [x] `managedRuntime` prefers the active pointer and falls back honestly when it does not validate.
- [x] The previous verified runtime stays on disk and rollback re-activates it after confirmation.
- [x] A failed candidate leaves the previously active runtime in force.
- [x] Probe `legacyUpgradeDiscovery`: a workspace holding only a 0.3.4 receipt is reported as an upgrade candidate.

## F09 — notebook ownership

- [x] Existing `notebooks/analysis/{pyproject.toml,uv.lock,.python-version}` are compared with the bundle before any package management.
- [x] An unrelated project is refused with an actionable message and no `uv sync`.
- [x] A compatible existing project is accepted and labelled as such.
- [x] `notebooks/analysis/.venv` is preflighted for links/junctions before `uv sync`.
- [x] After sync the interpreter is verified **and** the required imports are verified.
- [x] Kernel execution stays a separate deliberate action.

## Concurrency and hygiene

- [x] Receipts are written atomically (validated temp file, then rename).
- [x] The setup lock covers the whole multi-step plan, not only the worker step.
- [x] Store and backup directories are preflighted before the subprocess that writes them.
- [x] `.research-toolkit/store/` and its backups are covered by the workspace ignore rules, and the store step explains what the store contains.
## Verification status — 31 October 2026

Covered by `test/installer.test.js`, `test/runtime.test.js` and the recorded probes `quickPickStep`,
`partialUpdate`, `repairAfterInterpreterRemoved`, `overlayConflict`, `legacyUpgradeDiscovery` and
`notebookVenvJunction` in [`node-probe-results.json`](../../../../evidence/quality-v0.3.5-2026-10-31/node-probe-results.json).
`discoverInstallations` shipped as `discoverRuntimes`. A rollback candidate that fails the reading check is now
covered by a test that asserts the active pointer does not move.

Residual limits: the notebook `.venv` junction probe runs only on `win32`; the Linux symlink case is covered in
`test/installer.test.js`. Kernel execution remains a separate deliberate action and is not automated here.
