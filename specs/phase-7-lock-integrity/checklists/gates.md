# Phase 7 gate checklist

Each gate is a command that was run, not an intention. Run them from the repository root.

## Gate A — the failure is proven and the pair is fixed

- [x] `python3 evidence/quality-v0.3.7-2026-11-02/run_uv_matrix.py --uv /tmp/uvs/uv-0.5.0 … --uv /tmp/uvs/uv-0.13.6` → exit 0, `everyDriftRefused: true`, `everyShippedPairAccepted: true`
- [x] `python3 evidence/quality-v0.3.7-2026-11-02/run_lock_provenance.py --uv /tmp/uvs/uv-0.13.6 --base v0.3.6` → exit 0, `+2 / -2` lines, resolved set unchanged, regenerated lock byte-identical to the packaged lock
- [x] `python3 scripts/lockintegrity.py` → `"ok": true`

## Gate B — the drift cannot be shipped

- [x] `.venv/bin/python -m pytest tests/test_lock_consistency.py` → 37 passed, 1 skipped (the uv gate); 38 passed with `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6`
- [x] `.venv/bin/python -m pytest tests/test_vsix.py` → 11 passed, including the stale-pair VSIX fixture
- [x] `python3 scripts/build_worker_bundle.py` refuses a stale pair before writing (test `test_bundle_builder_refuses_a_stale_pair`)

## Gate C — the runtime diagnoses and recovers

- [x] `cd extension && npm test` → 168 passed, 0 failed
- [x] `lockfile.js` appears in `extension/test/module-boundaries.test.js` with no dependencies of its own, and `runner.js` is still the only `execFile` call site
- [x] No path in `extension/` issues `uv lock` inside a managed runtime or a plain `uv sync`

## Gate D — the release identity is buildable

- [x] `.venv/bin/python -m pytest tests/test_release_identity.py` → passed, including `test_release_version_is_one_vsce_can_package`
- [x] `npm run verify-package` and `npm run check:payload` resolve the artifact from `extension/vsix-manifest.json`

## Gate E — the artifact

- [x] `cd extension && npm run package` → `dist/research-stack-toolkit-0.3.7.vsix`, 86 files, 301 366 bytes
- [x] `sha256sum dist/research-stack-toolkit-0.3.7.vsix` → `2595facbf4f0f8271ebaca791a7443dc8915c2eb41b539f9edb64331e5abfb84`
- [x] `npm run verify-package` → `"result": "passed"`, `sourceFilesMatch: true` (`evidence/quality-v0.3.7-2026-11-02/vsix-audit.json`)
- [x] `npm run check:payload` → passed (`evidence/quality-v0.3.7-2026-11-02/payload-check.json`)
- [x] `uv-0.13.6 lock --check` on all three shipped pairs → exit 0 (`evidence/quality-v0.3.7-2026-11-02/uv-lock-check.txt`)
- [ ] Install the VSIX on the reference host (Windows 11 x64 / VS Code 1.141.0) and rerun the field workspace's setup — **open**, and the only way to close the field report for certain
