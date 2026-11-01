# Quality state — Research Stack Toolkit 0.3.6 (release pass complete on this host)

Objective: fix the reported field failure — the VSIX installs but component setup leaves the Python
environment and packages uninstalled — make component setup reliable, and report the installation outcome
in the GUI. Spec-driven plans: [specs/phase-6/](../specs/phase-6/) (findings D1–D8, R6-01…R6-39,
T6-01…T6-28, decisions D6-01…D6-07).
Release report: [docs/implementation/phase-6-install-reliability/implementation-report-0.3.6.md](../docs/implementation/phase-6-install-reliability/implementation-report-0.3.6.md).
Previous release: 0.3.5 (Phase A stabilization) — see
[docs/implementation/phase-5-stabilization/implementation-report-0.3.5.md](../docs/implementation/phase-5-stabilization/implementation-report-0.3.5.md).

Status: **0.3.6 implemented, independently evaluated and re-verified on this Linux development host.** Six
fresh reviewers audited the tree (claims vs evidence, failure-mode hunting, GUI usefulness, test strength,
release integrity); every defect they confirmed was reproduced, fixed, covered by a new test, and the VSIX
was re-cut and re-audited. Reference-host receipts are outstanding. Gates G1–G4 remain open.

## Verified now (1 November 2026, this host)

| Item | Evidence |
|---|---|
| Node suite `npm test` (14 suites) | **134 pass / 0 fail**, including new `runner`, `hosttools`, `preflight`, `setuplog`, `status`, `steps`, `module-boundaries` and `gui-status` suites |
| Python suite `.venv/bin/python -m pytest` | **113 collected / 113 pass / 0 fail** (exit 0), including the release-identity suite and the bootstrap `.gitignore` rule for `.research-toolkit/logs/` |
| Real MCP functional check | `ok: true`; 3 stdio servers; **20 measured tool definitions** |
| Worker bundle | rebuilt: 19 reviewed source/lock files + 11 overlay templates, `workerVersion 0.3.6`, schemaVersion 2 |
| Packaged VSIX | `dist/research-stack-toolkit-0.3.6.vsix`, 288,704 bytes (85 members), sha256 `7d772cd2b42686ffbdf705cde08d427710aa6ae6e240ab537c6c61998bd10235` (+ `.sha256` sidecar) |
| VSIX audit `scripts/verify_vsix.py` | `result: "passed"`, `sourceFilesMatch: true`; the reviewed process boundary is now `extension/runner.js` and the inventory names the six new modules |
| Audit integrity probes | `evidence/quality-v0.3.6-2026-11-01/audit-probe-results.json` — a second `node:child_process` boundary, `shell: true` and a second `execFile(` call are each **rejected** |
| Installed-payload check `npm run check:payload` | `result: "passed"`: 25 registered commands, status card + four actions in the packaged panel, new settings shipped, and a **reproduced failed component setup** reported as `Installation incomplete — 1 step(s) verified, 2 need attention (…)` with the dependent step blocked, status record, attempt log and a retry that selects exactly the failed and blocked steps |
| Review probes re-run | `python-probe-results.json` and `node-probe-results.json` in `evidence/quality-v0.3.6-2026-11-01/` — no 0.3.5 behaviour regressed |

## What changed in this release (finding → implementation)

- **D1 host tools** — new `extension/hosttools.js`: setting → absolute PATH entries → documented per-platform
  locations → managed folder; workspace-local executables refused; `--version` probe with its own bound;
  registry `minimumVersion` (`uv >= 0.5.0`) enforced; found-but-unverified is never "installed"; session cache
  with refresh; a miss reports searched categories with counts and the `researchStack.uvPath` remedy.
- **D2/D3 process execution** — new `extension/runner.js` is the only `node:child_process` importer and the only
  `execFile` call site: captures stdout/stderr/exit/signal/duration/command, classifies `timeout | cancelled |
  spawn | buffer | exit | cwd`, builds messages from captured output, reports truncation, 8 MiB capture cap,
  8 s default probe bound, `shell: false`, `windowsHide: true`, reviewed uv environment for setup calls only,
  refuses a missing or link-redirected cwd, and retries once only for transport-shaped failures.
- **D4 lock** — `preflight.inspectLock` returns `free | held | stale` with age and owner pid;
  `clearStaleLock` removes only a stale regular file; new command **Clear interrupted setup lock**.
- **D5 evidence** — new `extension/setuplog.js`: `.research-toolkit/logs/last-setup.json` written atomically
  (validated temp + rename, link refused, 256 KiB cap) and `setup-<utc>.jsonl` append-only attempt log; the
  bootstrap `.gitignore` ignores `.research-toolkit/logs/`.
- **D6 GUI verdict** — new `extension/status.js` computes `success | partial | failed | blocked | cancelled |
  not-run` from **post-run artefact verification**, and the panel's Installation status card shows the verdict,
  per-step attempt rows, host tools, preflight, the first actionable problem and the log pointer; verdict
  survives a panel reopen because it is read from disk. Commands **Retry Failed Component Steps**, **Open setup
  log**, **Copy installation diagnostics** act on it.
- **D7 plan resilience** — `installer.runPlan` runs preflight, continues past a failure, records `blocked`
  with `blockedBy`, keeps `lastAttempt`, never records a failed step as installed, and a step whose only record
  is a failed attempt now reports `missing` with that attempt's error.
- **D8 module boundaries** — `runner.js`, `hosttools.js`, `preflight.js`, `setuplog.js`, `steps.js`, `status.js`
  are single-concern modules; `installer.js` keeps selection/status/verification/receipt/plan; `diagnostics.js`
  no longer imports `node:child_process`; `test/module-boundaries.test.js` enforces the reviewed graph.
- **Registry-driven timeouts and tool needs** — `components.json` install steps declare `hostTools` and
  `timeoutSeconds`; `researchStack.setupTimeoutSeconds` (60–3600, default 900) raises a step's bound;
  `researchStack.uvPath` supplies an explicit uv path.
- **Manifest hygiene found during the pass** — `researchStack.toolsPreset` had 10 enum values with 9 labels
  (misaligned Settings labels); the four new commands were categorised "Research Stack" against 21
  "Research Toolkit"; `components.json` `reviewedAt` dates lagged the rewritten guides. All three fixed and
  covered by a drift test.

## Open / not yet verified

- No 0.3.6 reference-host receipts: `npm run test:host`, `node test/browser.test.js`, a real component setup
  receipt, Windows junction fixtures and a Copilot agent-mode session. **G1–G4 stay open.**
- No `uv` on this host's PATH: the interpreter-download path is exercised through injected fixtures, not a live
  `uv sync`; a uv host should record one real setup and one real "uv not found → blocked" run.
- The panel does not probe host tools at open (no subprocess at panel open by design); resolution is visible via
  **Check component status** and in preflight results after a run.
- `functionalCheck` still has a fixed 90 s bound that does not follow `researchStack.setupTimeoutSeconds`.
- A retried timeout understates total wall time in `describe()`: the message reports the second attempt's
  bound, not the two attempts together.
- A Windows host whose only uv is a `.cmd`/`.bat` wrapper is now detected and explained, but setup still
  cannot use it (`shell: false` is a hard rule); the remedy is `researchStack.uvPath` pointed at the `uv.exe`.
- The live setup-lock state shown by the card is refreshed on panel open and on refresh, not continuously.
- Extraction→index bridge for PDF/DOCX remains designed but unshipped; `read_text_source` still does not echo
  the locator it resolved.

## Spec-driven records

All six checklists in [specs/phase-6/checklists/](../specs/phase-6/checklists/) are marked against recorded
evidence (63 items) with verification-status footers naming the residual limits. Phase 5 records remain in
[specs/phase-5/checklists/](../specs/phase-5/checklists/) (161 items). `evidence/phase-4/gate-report.md` keeps
the 0.3.2 and 0.3.5 receipts historical and names the 0.3.6 receipts.

## Next highest-value action

1. Run the 0.3.6 acceptance path on a real host: `npm run test:host`, `node test/browser.test.js`, a real
   component setup with uv present (record `last-setup.json` and the attempt log), a deliberate "uv not found"
   run (record the blocked verdict), the Windows junction fixtures, and a Copilot agent-mode session — then file
   the receipts under `Research-Stack/evidence/`. Until then T6-27, T6-28 host halves and G1–G4 stay open.
2. Evaluate an open-time host-tool preview that costs no subprocess (filesystem search only, no version probe).
3. Ship the extraction→index bridge designed in `specs/phase-5/design.md` as the next coherent step of the Full
   workflow.

## Final validation sweep — 1 November 2026 (run against the shipped 0.3.6 tree)

| # | Check | Command | Result |
|---|---|---|---|
| 1 | Python suite | `.venv/bin/python -m pytest -q` | exit 0 — 113 tests, 0 failures |
| 2 | Node suite | `cd extension && npm test` | exit 0 — **134 tests, 134 pass, 0 fail** (14 suites) |
| 3 | Guide hub + worker bundle rebuild (determinism) | `scripts/build_guide_index.py`, `scripts/build_worker_bundle.py` | exit 0 — 29 guides; 19 source/lock files + 11 overlay templates for worker 0.3.6; artifact hash unchanged, so the rebuild is byte-identical |
| 4 | Real MCP functional check | `.venv/bin/python extension/functional_check.py --workspace <tmp>` | exit 0 — `ok: true`, 20 measured tool definitions |
| 5 | VSIX audit | `.venv/bin/python scripts/verify_vsix.py dist/research-stack-toolkit-0.3.6.vsix` | exit 0 — `result: "passed"`, `sourceFilesMatch: true`, 288,704 packaged / 879,713 unpacked |
| 6 | Installed-payload check | `cd extension && npm run check:payload` | exit 0 — `result: "passed"`, 25 commands, reproduced failed setup reported as `Installation incomplete … 1 of 3 package steps are installed in this workspace.` |
| 7 | Audit integrity probes | `.venv/bin/python ../evidence/quality-v0.3.6-2026-11-01/audit_probes.py` | exit 0 — `allRejected: true` (3 tampered packages rejected) |
| 8 | 0.3.4/0.3.5 review probes | `review_probes.py`, `review_probes.js` | exit 0 both — no regression |
| 9 | Version identity | grep of `pyproject.toml`, `src/research_stack/__init__.py`, `extension/package.json`, `extension/vsix-manifest.json`, `extension/runtime.js` | `0.3.6` in all five; `WORKER_VERSION = "0.3.6"` |
| 10 | Artifact vs sidecar | `sha256sum dist/…0.3.6.vsix` vs `dist/…0.3.6.vsix.sha256` | identical: `7d772cd2b42686ffbdf705cde08d427710aa6ae6e240ab537c6c61998bd10235` |

Consistency review after the sweep: test counts in the release report, evidence README and gate report match
the run (134 Node / 113 Python); all 63 checklist items and 35 task items in `specs/phase-6/` are marked with
footers naming the residual limits; no debug or temporary files remain in the tree; the packaged inventory
equals the reviewed module set including the six new modules; the reviewed process boundary is
`extension/runner.js` in both the audit and `test/module-boundaries.test.js`.

Not claimed: any real-host receipt. `npm run test:host`, `node test/browser.test.js`, a real uv-driven setup,
Windows junction fixtures and a Copilot agent-mode session remain unexecuted, so **G1–G4 stay open**.
