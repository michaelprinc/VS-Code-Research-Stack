# Phase 7 gate checklist

Each gate is a command that was run, not an intention. Run them from the repository root.

## Gate A — the failure is proven and the pair is fixed

- [x] `python3 evidence/quality-v0.3.7-2026-11-02/run_uv_matrix.py --uv /tmp/uvs/uv-0.5.0 … --uv /tmp/uvs/uv-0.13.6` → exit 0, `everyDriftRefused: true`, `everyShippedPairAccepted: true`
- [x] `python3 evidence/quality-v0.3.7-2026-11-02/run_lock_provenance.py --uv /tmp/uvs/uv-0.13.6 --base v0.3.6` → exit 0, `+2 / -2` lines, resolved set unchanged, regenerated lock byte-identical to the packaged lock
- [x] `python3 scripts/lockintegrity.py` → `"ok": true`

## Gate B — the drift cannot be shipped

- [x] `.venv/bin/python -m pytest tests/test_lock_consistency.py` → 64 passed, 1 skipped (the uv gate); 65 passed with `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6`
- [x] `.venv/bin/python -m pytest tests/test_vsix.py` → 14 passed, including the stale-pair VSIX fixture and the three CRLF reproducibility tests
- [x] `python3 scripts/build_worker_bundle.py` refuses a stale pair before writing (test `tests/test_lock_consistency.py::test_the_bundle_build_refuses_a_stale_source_pair`)

## Gate C — the runtime diagnoses and recovers

- [x] `cd extension && npm test` → 250 passed, 0 failed (16 files, `test/lockfile-adversarial.test.js` included)
- [x] `lockfile.js` appears in `extension/test/module-boundaries.test.js` with no dependencies of its own, and `runner.js` is still the only `execFile` call site
- [x] No path in `extension/` issues `uv lock` inside a managed runtime or a plain `uv sync`

## Gate D — the release identity is buildable

- [x] `.venv/bin/python -m pytest tests/test_release_identity.py` → passed, including `test_release_version_is_one_vsce_can_package`
- [x] `npm run verify-package` and `npm run check:payload` resolve the artifact from `extension/vsix-manifest.json`

## Gate E — the artifact

- [x] `cd extension && npm run package` → `dist/research-stack-toolkit-0.3.7.vsix`, 86 files, 312 471 bytes, 0 members carrying CRLF
- [x] `sha256sum dist/research-stack-toolkit-0.3.7.vsix` → `f4db025b12718b62336ebec091ba79523a059ffa9de3ba998f66549183666416`
- [x] `npm run verify-package` → `"result": "passed"`, `sourceFilesMatch: true` (`evidence/quality-v0.3.7-2026-11-02/vsix-audit.json`)
- [x] `npm run check:payload` → passed (`evidence/quality-v0.3.7-2026-11-02/payload-check.json`)
- [x] `uv-0.13.6 lock --check` on all three shipped pairs → exit 0 (`evidence/quality-v0.3.7-2026-11-02/uv-lock-check.txt`)
- [ ] Install the VSIX on the reference host (Windows 11 x64 / VS Code 1.141.0) and rerun the field workspace's setup — **open**, and the only way to close the field report for certain

## Gate F — added after the tag, from the review rounds

- [x] `cd extension && node --test test/lockfile-adversarial.test.js` → 73 passed: 69 synthetic pairs kept with the uv verdict measured for each, and the suite is now part of `npm test`
- [x] Both readers run over the same 69 extracted pairs (`extension/lockfile.js` `pairProblems`, `scripts/lockintegrity.py` `check_pair_text`): verdict divergences went 2 → 0, and all three shipped pairs read CLEAN in both readers
- [x] `python3 scripts/verify_vsix.py` refuses an artifact whose packaged text members carry CRLF; the rebuilt artifact has 0 CRLF members in its 86 (`python3` over the VSIX)
- [x] `.venv/bin/python -m pytest tests/test_vsix.py` → 14 passed, three of them about CRLF reproducibility
- [x] The notebook step's fallback tier measured with real uv on the notebook analysis pair in a temp copy: `uv sync --locked` exit 2 (uv 0.5.0) / exit 1 (uv 0.13.6) on a wound-back manifest, `uv sync --frozen` exit 0 on both
- [ ] Build the VSIX from a clean clone of the re-cut tag and compare digests with `dist/` — run at freeze; the CRLF fix is only proven by this comparison
