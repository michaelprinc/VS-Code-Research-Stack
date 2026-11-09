# Phase 11 tasks — 0.3.11

One row per implementation task, with the decision it carries out and where the result lives. Status is what this
container can prove today; nothing here stands for a Windows or live VS Code result.

| # | Task | Decision | Where it landed | Status |
|---|---|---|---|---|
| 1 | Baseline: measure what the 0.3.10 release really shipped before designing on top of it | — | `specs/phase-11-integration-onboarding/spec.md` §1 (390 JS tests, 258 Python tests, 33 commands, 1 276 822 unpacked bytes, 104 members) | done |
| 2 | Baseline: run the readiness question against this host and record what it actually answers | — | `spec.md` §1, `evidence/quality-v0.3.11-2026-11-08/probe-receipt.json` | done — Zotero `not-installed`, Semantic Scholar `auth-required` |
| 3 | Findings: the single-flag readiness model, the per-workspace re-asking, the missing consent record, the byte budget | — | `spec.md` §2 | done |
| 4 | State model: four dimensions, the vocabularies they allow, and the operator wording for each state | DD11-03, DD11-05, DD11-11 | `extension/integrations.js` — `DIMENSIONS`, `DEFAULTS`, `PROBE_EFFECTS`, `WORDING`, `integrationViews` | done, tested (10) |
| 5 | Storage adapter: one global record, one secret per provider, key validation, redaction, environment footprint | DD11-04, DD11-06 | `extension/integrationstore.js` — `REGISTRY_STATE_KEY`, `secretKey`, `validateApiKey`, `storeApiKey`, `readApiKey`, `hasApiKey`, `clearApiKey`, `redactSecrets`, `environmentFootprint` | done, tested (9) |
| 6 | Probe boundary: the argv, the environment that call may carry, the receipt read back into outcomes | DD11-01, DD11-06, DD11-09 | `extension/integrationprobe.js` — `probeArgv`, `probeEnvironment`, `interpretReceipt`, `describeProbeFailure`, `PROBE_COOLDOWN_MS`, `PROBE_TIMEOUT_MS` | done, tested (9) |
| 7 | Worker side of the probe: one CLI verb, no new network primitive, the existing loopback and HTTPS paths reused | DD11-01 | `src/research_stack/integrations.py`, `src/research_stack/cli.py` (`probe-integrations`), generated `extension/worker/src/research_stack/integrations.py` | done, tested (15) |
| 8 | Controller: five commands, the modal consent, the key prompt, turn off, reset, and the panel message branches | INT-01, INT-06, INT-10 | `extension/extension.js` — `manageIntegrations`, `activateIntegration`, `setIntegrationApiKey`, `checkIntegrations`, `resetIntegration`, `deactivateIntegration`, `runIntegrationProbe` | done, tested through the harness and the installed payload |
| 9 | Control panel: the "Integrations & Accounts" section, the cards, the four dimensions, the readiness rule | R11 panel | `extension/ui.js`, `extension/media/controls.js` — `renderIntegrations`, `extension/media/controls.css` | done, asserted in the packaged panel HTML |
| 10 | MCP injection: only the server that calls the provider, only when authorized; the fingerprint folded into the server signature | DD11-06 | `extension/extension.js` — `integrationEnvironment`, `presetSurfaceSignature`, the `research_stack.recommended_server` spread | done, tested |
| 11 | Migration: read an older record, keep what is honourable, name what was thrown away, never delete | DD11-08 | `extension/integrations.js` — `readRegistry`, `notes` | done, tested |
| 12 | Rate limiting stays in the worker; the host adds one shared check budget per profile | DD11-09 | `src/research_stack/research.py` (unchanged pacing), `integrations.js` — `probeCooldown`, `extension.js` — `lastProbeAt` | done, tested |
| 13 | Components and guides carry the onboarding affordance instead of a new component | — | `extension/components.json` (`install.verify: "integration"`, `nextAction`), `extension/guides/zotero-local-api.md`, `extension/guides/semantic-scholar-academic-graph.md`, regenerated `extension/guides/index.md` | done, tested by `guides.test.js` |
| 14 | Manifests: five commands, three new staged files, 0.3.11 | — | `extension/package.json`, `extension/vsix-manifest.json` (38 commands, 28 files) | done |
| 15 | Packaging gates: staged list, audit `EXPECTED`, re-measured byte ceiling, installed-payload assertions | DD11-02, DD11-10 | `extension/scripts/package.js`, `scripts/verify_vsix.py`, `extension/scripts/check-installed-payload.js` | done |
| 16 | Harness fidelity: `context.secrets`, a named modal button, a seeded profile store | finding 6 | `extension/test/harness.js` — `secrets`, `pickButton`, `initialGlobalState` | done |
| 17 | Seam defects found while wiring the model into the host, and fixed | — | see "Defects found and closed" below | done |
| 18 | Version identity across the five test-enforced sources; both locks re-resolved with uv 0.13.6 | R11 identity | `pyproject.toml`, `src/research_stack/__init__.py`, `extension/package.json`, `extension/vsix-manifest.json`, `extension/runtime.js`, `uv.lock` | done |
| 19 | Packaged documentation brought to 0.3.11 at its source | — | `README.md`, `extension/README.md`, `extension/guides/{onboarding,toolkit,document-worker,python}.md`, generated `extension/worker/README.md` | done |
| 20 | Evidence receipts for this release | — | `evidence/quality-v0.3.11-2026-11-08/` | done |
| 21 | Sharing the decision across VS Code profiles of the same OS user | INT-12 | — | **open — deliberately not implemented**: SecretStorage and globalState are per-profile, and a cross-profile store would need a location and a threat model this release has not written |
| 22 | Guided Zotero installation through the platform package manager | INT-13 | — | open — not implemented; the guide names the official installer instead, so the Toolkit never runs an installer it has not reviewed |
| 23 | A remote Zotero library | INT-14 | — | out of this release |
| 24 | Zotero write access | — | — | out of this release by decision: the probe reads, and the worker states that nothing was written |
| 25 | Windows 11, a live Extension Host, a real Zotero installation, a real Semantic Scholar key | — | — | open — not reachable from this container |

## Defects found and closed

These were found by the wiring tests, not by reading the code, and each now has a test that fails if it returns.

| Defect | Why it mattered | Fix | Proof |
|---|---|---|---|
| `lastProbeAt` was stored as ISO text while `readRegistry` and `probeCooldown` only accept a number | The shared check budget silently never applied: every window believed no check had ever run, so several windows could stampede one service | `integrations.js` — `epoch()`, `recordProbe` stores an instant, `readRegistry` reads either spelling; `extension.js` stores `Date.parse(at)` | `integrations.test.js::a probe writes a lastCheck…`, `integration-host.test.js::several windows share one check budget…` |
| `integrationViews` required a numeric `now` while every caller passed ISO text | The "that check is more than 24 hours old" sentence could never appear | `integrations.js` — `epoch(now)` | `integrations.test.js::the panel wording…` |
| `extension.js` indexed the receipt with `"semantic-scholar"` while the worker answers `semanticScholar` | Semantic Scholar's verdict was silently discarded and the card kept a stale state | explicit mapping in `runIntegrationProbe`, plus tolerant key reading in `interpretReceipt` | `integration-host.test.js::a rate-limited check…`, `credential-security.test.js::the probe boundary…` |
| A migrated record could claim a stored key that secret storage does not hold | The panel would say "Stored key: present" forever, and an operator would look for a key that is not there | the check reconciles the claim with what it actually read, once, for an authorized integration | `integration-host.test.js::an integration record from an older release…` |
| A record claiming consent it cannot show kept its `readiness: "ready"` | A hosted API cannot have been probed without the consent, so the readiness was not evidence | the demotion also resets readiness and the last successful check, and says so in `notes` | `integrations.test.js::readRegistry never throws…`, `integration-host.test.js::a record that claims a confirmation…` |
| The byte-scan capability audit matched the word "socket" inside comments | The release gate reported a network capability that did not exist | the new modules say "network transport" instead | `scripts/verify_vsix.py` audit run, `module-boundaries.test.js` |
| The unpacked payload outgrew the reviewed ceiling | The gate would have failed with no stated way forward | ceiling re-measured to 1 376 256 with the growth attributed member by member (DD11-10) | `evidence/quality-v0.3.11-2026-11-08/vsix-audit.json` |
