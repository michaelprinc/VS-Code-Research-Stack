# Research Stack Toolkit 0.3.6 — component install reliability and installation status

Recorded 1 November 2026 on the Linux development host.

Specification: [`specs/phase-6/spec.md`](../../specs/phase-6/spec.md) (findings D1–D8, requirements
R6-01…R6-39), [`design.md`](../../specs/phase-6/design.md) (decisions D6-01…D6-07),
[`tasks.md`](../../specs/phase-6/tasks.md), [`acceptance.md`](../../specs/phase-6/acceptance.md)
(T6-01…T6-28) and the six [checklists](../../specs/phase-6/checklists/).
Evidence: [`Research-Stack/evidence/quality-v0.3.6-2026-11-01/`](../../../evidence/quality-v0.3.6-2026-11-01/README.md).

## Why this release exists

The 0.3.5 VSIX installed successfully, but component setup left the Python environment and packages
uninstalled, and the interface gave no way to tell that apart from a successful run. The diagnosis in
`spec.md` names eight contributing defects:

| Finding | Defect | Where it lived |
|---|---|---|
| D1 | Host tools were looked up on PATH only, so a uv installed in a documented location was invisible | `diagnostics.findHostTool` |
| D2 | Failures were reported as canned strings; the tool's own stderr was discarded | `diagnostics.run` |
| D3 | 64 KiB capture cap and a 240 s worker timeout truncated or killed a first-run download | `diagnostics.run`, `runtime.setupRuntime` |
| D4 | A leftover `.setup.lock` was reported as a generic error, with no way to clear it | `runtime.acquireSetupLock` |
| D5 | Nothing recorded what a setup attempt did, so a reopened panel could not say what happened | `installer.runPlan` |
| D6 | The GUI had no overall verdict — only a plan and a progress line | `ui.js`, `extension.js` |
| D7 | The plan aborted at the first failure, so independent steps never ran and dependents looked "not installed" | `installer.runPlan` |
| D8 | `installer.js` and `diagnostics.js` had grown into multi-concern modules, so the failure paths were hard to isolate | `installer.js`, `diagnostics.js` |

## What 0.3.6 does

**Host tool resolution (`extension/hosttools.js`).** uv and git are resolved in a fixed order —
`researchStack.uvPath`, then absolute PATH entries, then a bounded documented list for the platform,
then the workspace's managed toolkit folder. Workspace-local executables are refused. A found tool is
version-probed (`--version`, 8 s bound); a tool whose version command fails, or that is older than the
registry minimum (`uv >= 0.5.0`), is reported as unusable rather than treated as installed. A miss
reports the searched categories with counts and the setting that can fix it. Resolution is cached for
the session and refreshed when the setting or folders change.

**Preflight before any write or run (`extension/preflight.js`).** Workspace trust, local (non-remote)
desktop workspace, the host tools the selected plan declares (read from `components.json`, not from
prose), managed-path realness, workspace writability and setup-lock state. A blocked preflight writes a
status record with outcome `blocked` and runs nothing. Lock state is `free | held | stale` with age and
owner pid; **Clear interrupted setup lock** removes only a lock classified stale (older than the setup
window, or older than 60 s with a dead owner process) and refuses a live one.

**One bounded process boundary (`extension/runner.js`).** Every external tool run goes through
`runProcess`, the only module that imports `node:child_process` and the only `execFile` call site in the
extension. It captures stdout, stderr, exit code, signal, duration and the command; classifies the
failure as `timeout | cancelled | spawn | buffer | exit | cwd`; builds the operator message from the
captured output rather than a canned string; reports truncation; applies the reviewed uv environment to
setup calls only; honours `shell: false`, `windowsHide: true`, an 8 s default probe timeout, an 8 MiB
capture cap and a bounded report size; refuses a working directory that is missing or a link; and retries
once only for transport-shaped failures (timeout, buffer overflow, network-flavoured tool output) — never
for a launch failure, a cancellation or a refusal.

**Per-step timeouts (`extension/components.json`, `extension/steps.js`).** Each install step declares
`timeoutSeconds` (worker 900, notebook-env 900, lab-store 120, research-overlay 60) and the host tools it
needs. `researchStack.setupTimeoutSeconds` (60–3600, default 900) raises a step's bound; it cannot lower
a step below its own floor.

**A plan that continues (`extension/installer.js`).** A failing step no longer aborts the plan.
Independent steps continue; steps that depend on a failure are recorded `blocked` with `blockedBy`; a
failed or blocked step is never recorded as installed; each attempt is recorded and the receipt keeps
`lastAttempt`. A step that never succeeded now reports `missing` with the last attempt's error instead of
a bare "not installed" or a misleading "outdated".

**Installation status in the GUI (`extension/status.js`, `extension/setuplog.js`, `extension/ui.js`,
`extension/media/controls.js`).** Setup writes `.research-toolkit/logs/last-setup.json` (atomically, via
a validated temp file and rename) and appends every attempt to `.research-toolkit/logs/setup-<utc>.jsonl`.
The panel's Installation status card reads the record on open, so the verdict survives a panel reopen and
an editor reload without re-running anything. The verdict is one of:

- `Installation complete — N component step(s) verified.`
- `Installation incomplete — N step(s) verified, M need attention (…)`
- `Installation failed — <step>: <error>.`
- `Setup blocked — <reason>.`
- `Setup cancelled — N step(s) already completed were kept.`
- `No component setup has run in this workspace yet`

A success verdict is **earned**: it requires post-run verification of the files each step was supposed to
produce (for the worker step, `.venv/bin/python` on Linux/macOS or `.venv/Scripts/python.exe` on Windows,
plus the managed `src/research_stack/mcp_server.py`). A step that exits 0 but leaves its artefacts behind
produces `Installation incomplete`, never a success. Four commands act on the card: **Retry Failed
Component Steps** (re-runs the failed steps and the steps blocked by them, keeping completed work),
**Clear Interrupted Setup Lock**, **Open Setup Log** and **Copy Installation Diagnostics** (verdict, host
tools, preflight results, per-step attempts and the log file path on the clipboard). The bootstrap
workspace's `.gitignore` now ignores `.research-toolkit/logs/`.

**Module boundaries (D8).** `runner.js`, `hosttools.js`, `preflight.js`, `setuplog.js`, `steps.js` and
`status.js` are new single-concern modules; `installer.js` keeps selection, step status, artefact
verification, receipt and plan execution; `diagnostics.js` no longer imports `node:child_process`;
`extension.js` wires commands and state only. `test/module-boundaries.test.js` enforces the reviewed
dependency direction, the single process boundary and the rule that no controller module builds a step
command itself.

## Defects found and fixed during the 0.3.6 pass

- `classify()` read the failure off the error object, which does not always carry the captured streams, so
  stderr was lost and a network-shaped failure was misclassified as non-retryable. The callback's
  `stdout`/`stderr` are now the primary source.
- Preflight printed `uv null resolved from …` when a resolver did not report a version; it now says
  "version not reported".
- The stored status record did not name its own file, so copied diagnostics could not point an operator at
  the log. `logFile` is now written into the record before it is stored.
- `runProcess` accepted any `cwd`, including a missing or link-redirected directory. It now refuses with a
  distinct `cwd` failure.
- `researchStack.toolsPreset` had 10 enum values but 9 `enumItemLabels`, so Settings showed the wrong label
  for `research-lab`, `research-lab-max` and `corpus-lab`. Labels now match `presets.json` in order, and a
  test fails if they drift.
- The four new commands were contributed under category "Research Stack" while the other 21 use
  "Research Toolkit"; all 25 now share one Command Palette group.
- `components.json` `reviewedAt` dates lagged the guides that 0.3.6 rewrote; the six affected components
  are dated 1 November 2026 and the guide hub was regenerated.
- The test harness answered modal prompts with the modal options object rather than a button, which made a
  setup confirmation look declined; only string items are treated as answers.
- The bootstrap `.gitignore` test now also requires the logs rule, so the ignore rule cannot silently
  regress.

## Independent evaluation pass (1 November 2026)

Six fresh reviewers examined the finished tree without access to the implementation reasoning: two
audited the release's claims against its evidence, one hunted installation failure modes with executable
probes, one judged the status card against the questions an operator actually arrives with, one assessed
whether the tests would catch a regression (including 63 mutation runs), and one audited release
integrity. Each confirmed defect was reproduced, fixed, and covered by a test that fails when the fix is
reverted. The VSIX was then re-cut and re-audited, so the artifact matches the fixed source.

**Blocking defects the evaluation found**

- Three of the four installation-card actions were inert. `media/controls.js` kept a set of actions it
  believed had dedicated handlers and skipped every other `data-action` in the generic wiring loop, so
  *Clear interrupted setup lock*, *Open setup log* and *Copy installation diagnostics* posted nothing. The
  set is gone, and a test now extracts every `data-action` the shipped panel renders and proves it is
  reachable in the webview and accepted by the host allowlist.
- uv's `.venv/bin/python` is a symlink to its managed base interpreter. Artefact verification counted it
  as missing, so a genuinely successful worker install reported `Installation incomplete` permanently,
  marked the step as needing repair, and re-downloaded the worker on every run.
- The notebook step resolved uv without the editor context and executed a workspace-local `bin/uv` that
  preflight had explicitly refused.

**Reliability and reporting defects**

- Lock classification could not converge: a recycled pid made a lock `held` forever (and the clear command
  refused it), an empty or half-written lock was `held` forever, and the fixed 15-minute window was shorter
  than a plan this release can legitimately take. The window is now derived from the selected steps' own
  timeouts, applied before pid liveness, with a separate rule for a lock whose contents were never written.
- A stale lock made the plan abort on `EEXIST` with no verdict recorded — the same "nothing happened"
  symptom 0.3.6 exists to remove. The plan now clears a preflight-classified stale lock first, and a lock
  it cannot take produces a `blocked` record naming the recovery action.
- A step recorded as installed whose files had disappeared was counted in "N verified" and in "M need
  attention" at the same time; a retry wrote a record containing only the retried steps, so a reopened
  panel reported `Installation failed` while an independent step was installed. Verified and troubled sets
  are now disjoint, recorded rows are re-checked against live artefacts, a carried step keeps its own
  re-verified evidence, and the record states `packageSteps: {total, installed}` so a partial record cannot
  read as a complete package.
- `attempts` reported the attempt limit rather than the processes that ran; a cwd refusal printed the
  placeholder `run failure`; retry classification read stdout, so a tool printing "502" in normal output was
  retried while a hard TLS refusal was also retried.
- Host tools: `knownLocations("win32", env)` produced `undefined` when `%APPDATA%` was unset and threw a
  `TypeError`; a misconfigured `researchStack.uvPath`, a non-executable file and a `uv.cmd` wrapper all
  reported "uv was not found"; the version probe read only stdout and ignored the caller's bound.
- Accessibility and density: the success verdict colour measured 3.86:1 against the dark editor background
  (below 4.5:1); the whole status group was a live region, so every step row re-announced; a 449-character
  error was dumped inline and could widen the sidebar.
- `module-boundaries.test.js` hard-coded its module list and allowed a `steps.js → installer.js` edge that
  made the reviewed graph cyclic; `extension/worker/README.md` was a byte-identical copy of the repository
  README, so a shipped worker carried instructions for a different project.

**Decisions added by the evaluation**

- **D6-08** — the card is a record, the plan is an observation: a reopened panel re-checks recorded rows
  against live artefacts, and a verdict recorded by another release is qualified, never reused.
- **D6-09** — a log or status write failure may never erase a verdict; the record carries `recordError` and
  the run still returns its outcome.
- **D6-10** — the age window is the authority for a lock older than the plan; a pid re-check cannot
  resurrect it, because a pid recorded long ago may belong to another process now.

## Verification

- Node: **134 tests, 134 pass, 0 fail** (14 suites, 9 new/extended). Python: **113 tests, 0 failures**.
- Real MCP functional check: `ok: true`, 20 measured tool definitions.
- `scripts/verify_vsix.py`: `result: "passed"`, `sourceFilesMatch: true`, 288,704 bytes packaged,
  879,713 unpacked, 85 members, sha256 `7d772cd2b42686ffbdf705cde08d427710aa6ae6e240ab537c6c61998bd10235`.
- `npm run check:payload`: passed against the packaged bytes, including a **reproduced failed component
  setup** that the packaged controller reports as `Installation incomplete — 1 step(s) verified, 2 need
  attention (…)` with the dependent step blocked, a status record, an attempt log and a retry that selects
  exactly the failed and blocked steps.
- Audit integrity probes: three tampered packages (second process boundary, `shell: true`, second
  `execFile(` call) are each rejected — see `audit-probe-results.json`.
- The 0.3.4/0.3.5 review probes re-run against 0.3.6 sources with no regression.

## Deliberate contract changes from 0.3.5

- `runPlan` no longer throws when a step fails (R6-19/R6-20). It continues, blocks dependents, records
  attempts and returns an outcome. The 0.3.5 test that asserted a rejection was rewritten to assert the
  recorded failure, the blocked dependents and the outcome.
- Host-tool lookup moved from `diagnostics.js` to `hosttools.js`, and the reviewed process boundary moved
  from `diagnostics.js` to `runner.js`; `verify_vsix.py` names the new module.

## Out of scope for 0.3.6

Installing uv itself; silent or background setup; notebook kernel execution; external provider and Zotero
connectivity; the extraction→index bridge; and the G1–G4 product gates.

## Residual limits and next actions

1. No reference-host receipts: `npm run test:host`, `node test/browser.test.js`, a real component setup
   receipt, Windows junction fixtures and a Copilot agent-mode session all still need a real host.
   **G1–G4 remain open.**
2. This host has no `uv` on PATH, so the interpreter-download path is proven through injected fixtures
   rather than a live `uv sync`. A host with uv should record one real setup receipt and one real
   "uv not found → blocked" run.
3. The panel does not probe host tools at open (no subprocess at panel open by design); the resolution is
   visible through **Check component status** and in the preflight results after a run. Deciding whether an
   open-time, subprocess-free resolution preview is worth the cost is an open design question.
4. `status.js` names only the first problem's label in the `Installation incomplete` line; a full list of
   offending steps is a wording improvement to evaluate with the reference-host receipts.
