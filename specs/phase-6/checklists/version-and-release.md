# Checklist — 0.3.6 release hygiene (R6-37…R6-39)

- [x] 0.3.6 in `pyproject.toml`, `src/research_stack/__init__.py`, `extension/package.json`, `extension/vsix-manifest.json`, `extension/runtime.js`. The extension-side files are asserted by tests; the Python pair is checked only by the new cross-language test named below.
- [x] `WORKER_FOLDER` is `.research-toolkit/managed/worker-0.3.6` and the bundle is rebuilt for it.
- [x] Acceptance tests assert 0.3.6 shapes (no hardcoded older version).
- [x] Guides state the status card, retry/continue behaviour, timeouts and uv resolution order.
- [x] `extension/README.md` and the root `README.md` describe the new settings and commands.
- [x] VSIX packaged, hashed, audited (`sourceFilesMatch: true`) and payload-checked.
- [x] Evidence for 0.3.6 recorded under `Research-Stack/evidence/`.
- [x] `evidence/phase-4/gate-report.md` keeps 0.3.2 receipts historical and names the 0.3.6 receipts.
- [x] G1–G4 remain open and the release text says so.
## Verification status — 1 November 2026

Version identity is asserted for the extension-side files — `extension/package.json`,
`extension/vsix-manifest.json`, `extension/runtime.js` and `extension/worker/bundle.json` — by
`test/unit.test.js` (manifest version derived from `package.json`, 25 contributed commands, preset labels
and command categories checked against the registries) and by `scripts/verify_vsix.py`, which fails if the
reviewed extension and worker versions disagree. No existing test compares `pyproject.toml` or
`src/research_stack/__init__.py` with the extension version; that cross-language identity is covered only
by `tests/test_release_identity.py`, being added in this pass. Packaged,
hashed, audited and payload-checked receipts are in
[`evidence/quality-v0.3.6-2026-11-01/`](../../../evidence/quality-v0.3.6-2026-11-01/README.md).

Residual limits: guides and READMEs describe 0.3.6 but no reference-host installation receipt exists, and
G1–G4 remain open.
