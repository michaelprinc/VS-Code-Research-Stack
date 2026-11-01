# Checklist — release evidence, tests and documentation (F18)

Findings addressed: F18 stale acceptance assertions, privilege-dependent fixtures, documentation drift, evidence pointers.

## Version identity

- [x] `pyproject.toml`, `extension/package.json`, `src/research_stack/__init__.py`, `extension/runtime.js` (`WORKER_FOLDER`, `WORKER_VERSION`), `extension/vsix-manifest.json` and the worker bundle all say 0.3.5.
- [x] Guides and READMEs reference 0.3.5; historical statements are labelled historical.
- [x] `extension/CHANGELOG.md` records the 0.3.5 changes with their finding ids.

## Acceptance tests

- [x] `extension/test/host.test.js` asserts the current version and drives setup through `runPlan` so `managedRuntime` finds a receipt.
- [x] `extension/test/browser.test.js` derives the expected preset count from `presets.json` instead of a hard-coded number.
- [x] `extension/test/installer.test.js` uses junction fixtures on Windows so no elevated privilege is needed.
- [x] `extension/test/runtime.test.js` covers the active-runtime pointer and prior-release discovery.
- [x] Python suite covers the new store contracts and the new verbs.

## Documentation

- [x] Outer `Research-Stack/README.md` opens with the current release.
- [x] Inner `toolkit/README.md` isolated-install example names the 0.3.5 VSIX.
- [x] `extension/README.md` states that both the worker and the notebook steps can download.
- [x] `extension/guides/research-corpus-index.md` and `research-record-store.md` state the required active preset.
- [x] `extension/guides/mcp-config.md` lists every preset id and per-server tool counts.
- [x] `.agent/QUALITY_STATE.md` points at files that exist in this checkout.
- [x] `evidence/phase-4/gate-report.md` records the 0.3.5 artifact and keeps G1–G4 open.

## Release receipts to produce on this host

- [x] `scripts/build_guide_index.py` and `scripts/build_worker_bundle.py` rebuilt.
- [x] `dist/research-stack-toolkit-0.3.5.vsix` built with a SHA-256 sidecar.
- [x] `scripts/verify_vsix.py` → `passed`, `sourceFilesMatch: true`.
- [x] `npm run check:payload` → passed with the 0.3.5 command/preset/plan inventory.
- [x] Real three-server stdio MCP functional check → `ok: true` with the new verbs.
- [x] v0.3.4 review probes re-run as 0.3.5 regression evidence in `evidence/quality-v0.3.5-<date>/`.
- [x] Outstanding reference-host items recorded as outstanding, not implied.
## Verification status — 31 October 2026

Version identity is 0.3.5 in `pyproject.toml`, `research_stack.__init__`, `extension/package.json`,
`extension/vsix-manifest.json` and `runtime.js` (`worker-0.3.5`). Guides rebuilt, VSIX packaged, audited
(`sourceFilesMatch: true`) and payload-checked; the 0.3.5 receipts live in
[`evidence/quality-v0.3.5-2026-10-31/`](../../../../evidence/quality-v0.3.5-2026-10-31/README.md) and the release
narrative in
[`docs/implementation/phase-5-stabilization/implementation-report-0.3.5.md`](../../../docs/implementation/phase-5-stabilization/implementation-report-0.3.5.md).
`evidence/phase-4/gate-report.md` now carries a 0.3.5 status section that keeps the 0.3.2 receipts historical.

Residual limits: no reference-host installation or Extension Host activation receipt exists for 0.3.5; the
private package remains `UNLICENSED` with the existing missing-license packaging check skipped. G1–G4 remain open.
