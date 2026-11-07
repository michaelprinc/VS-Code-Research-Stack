# Phase 10 tasks — 0.3.10

One row per implementation task, with the decision it carries out and where the result lives. Status is what this
container can prove today; nothing here stands for a Windows or live VS Code result.

| # | Task | Decision | Where it landed | Status |
|---|---|---|---|---|
| 1 | Baseline: probe the Marketplace for the publisher and the extension before assuming either exists | — | `evidence/quality-v0.3.10-2026-11-07/marketplace-probe.json` | done |
| 2 | Baseline: capture what the pinned packager can and cannot do | — | `vsce-publish-help.txt`, `vsce-4.1.0-publish-help.txt`, `vsce-commands-help.txt`, `vsce-login-help.txt` | done — `--oidc` needs 4.1.0 |
| 3 | Source-checked publication research with quotes and page dates | — | `evidence/quality-v0.3.10-2026-11-07/marketplace-publish-research.md` | done |
| 4 | Fix the undefined identity constants | DD10-12 | `extension/extension.js` — `TOOLKIT_VERSION`, `PUBLISHER_ID`, `EXTENSION_NAME`, `EXTENSION_ID` | done, latent `ReferenceError` removed |
| 5 | One bounded HTTPS GET to one host, with an injectable transport | DD10-01, DD10-02, DD10-03 | `extension/updates.js` — `latestUri`, `httpsGet`, `checkPublishedVersion` | done, tested (14) |
| 6 | Verdicts instead of exceptions, including the engine range | DD10-04 | `extension/updates.js` — `updatePlan`, `engineSatisfies`, `parseVersion`, `compareVersions` | done, tested |
| 7 | Cooldown that keeps the last verdict and labels it | DD10-05 | `extension/updates.js` — `shouldCheck`; `extension/extension.js` — `storedUpdateCheck`, `UPDATE_STATE_KEY` | done, tested |
| 8 | Update applied through the gallery identity, with a stated refusal path | DD10-06 | `extension/extension.js` — `researchToolkit.updateExtension` | done, tested |
| 9 | Scheduled check on panel ready, never at activation, switchable off | R10-03 | `extension/extension.js` — `message.type === "ready"` branch, `updateSettings()` | done, tested through the installed payload |
| 10 | Report composition, redaction and byte bounds | DD10-08, DD10-09, DD10-10 | `extension/reports.js` — `redactText`, `buildReport`, `truncateToBytes` | done, tested (16) |
| 11 | Bounded in-memory failure ring recorded by every command | DD10-11 | `extension/extension.js` — `register()` wrapper; `extension/reports.js` — `errorRing` | done, tested |
| 12 | Manual-only send: file, clipboard, modal consent, `mailto:` draft | DD10-08 | `extension/extension.js` — `researchToolkit.reportProblem`; `extension/reports.js` — `emailDraft`, `mailtoUri` | done, tested end to end |
| 13 | Control-panel affordances and the verdict line | R10-34 | `extension/ui.js`, `extension/media/controls.js` | done, asserted in the panel HTML and the payload check |
| 14 | Manifest: three commands, one setting, icon, bugs, homepage, keywords | DD10-13 | `extension/package.json`, `extension/vsix-manifest.json` | done, 33 commands, 9 keywords |
| 15 | Gallery icon authored and verified | DD10-13 | `extension/scripts/make_icon.js`, `extension/media/toolkit.png` | done, 256 × 256 PNG verified |
| 16 | Gate change: the reviewed-network exception measured in both directions | DD10-01 | `scripts/verify_vsix.py`, `extension/test/module-boundaries.test.js` | done |
| 17 | Gate change: installed payload asserts the update channel and the new controls | R10-03, R10-04, R10-14 | `extension/scripts/check-installed-payload.js` | done |
| 18 | Harness fidelity: `Uri.joinPath` as a Uri, modal `options` recorded, storage writes, injected transport | finding 6 | `extension/test/harness.js` | done |
| 19 | Version identity across the seven sources; both locks re-resolved with uv 0.13.6 | R10-11 | `pyproject.toml`, `src/research_stack/__init__.py`, `extension/*`, `extension/worker/*`, `runtime.js` | done, `lockintegrity-cli.json`, `uv-lock-check.txt` |
| 20 | Packaged documentation brought to 0.3.10 at its source | finding 3 | `README.md`, `extension/README.md`, `extension/guides/*`, `extension/worker/README.md` (generated) | done |
| 21 | Publication runbook with the decisions named | DD10-14 | `docs/implementation/phase-10-marketplace-release/implementation-report-0.3.10.md` | done |
| 22 | Publish the release | §3 decisions | Marketplace | **open — needs the maintainer**: publisher, credential, licence, channel |
| 23 | Bump `@vscode/vsce` to ≥ 4.1.0 when trusted publishing is chosen | P-04 | `extension/package.json` devDependency | open — deliberately not done here, so the pinned toolchain stays what the receipts describe |
| 24 | Resolve the two skill-bundle licences | P-06 | `templates/recommended-overlay/.github/skills/`, `extension/bundles/catalog.json` | open — `publishable: false` enforced by generator, reader and audit |
| 25 | Windows 11 install, live Extension Host, Copilot attachment, a real mail client receiving the draft | — | — | open — not reachable from this container |
