# Phase 7 gate checklist

Each gate is a command that was run, not an intention. Run them from the repository root.

## Gate A — the failure is proven and the pair is fixed

- [x] `python3 evidence/quality-v0.3.7-2026-11-02/run_uv_matrix.py --uv /tmp/uvs/uv-0.5.0 … --uv /tmp/uvs/uv-0.13.6` → exit 0, `everyDriftRefused: true`, `everyShippedPairAccepted: true` (add `--out /tmp/…` to reproduce without overwriting the recorded receipt)
- [x] `python3 evidence/quality-v0.3.7-2026-11-02/run_lock_provenance.py --uv /tmp/uvs/uv-0.13.6 --base v0.3.6` → exit 0, `+2 / -2` lines, resolved set unchanged, regenerated lock byte-identical to the packaged lock
- [x] `python3 scripts/lockintegrity.py` → `"ok": true`

## Gate B — the drift cannot be shipped

- [x] `.venv/bin/python -m pytest tests/test_lock_consistency.py` → 64 passed, 1 skipped (the uv gate); 65 passed with `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6`
- [x] `.venv/bin/python -m pytest tests/test_vsix.py` → 22 passed: the stale-pair VSIX fixture, three CRLF reproducibility tests, ZIP build-epoch and permission-bit invariants, three runner-boundary refusals (second spawn, `shell: true`, dropped `kill(-pid)`), a synchronous-primitive refusal, and two capability-audit cases (a RegExp `.exec(` accepted, a bare `exec(` refused)
- [x] `python3 scripts/build_worker_bundle.py` refuses a stale pair before writing (test `tests/test_lock_consistency.py::test_the_bundle_build_refuses_a_stale_source_pair`)

## Gate C — the runtime diagnoses and recovers

- [x] `cd extension && npm test` → 331 passed, 0 failed (16 files, `test/lockfile-adversarial.test.js` included)
- [x] `lockfile.js` appears in `extension/test/module-boundaries.test.js` with no dependencies of its own, and `runner.js` is still the only `execFile` call site
- [x] No path in `extension/` issues `uv lock` inside a managed runtime or a plain `uv sync`

## Gate D — the release identity is buildable

- [x] `.venv/bin/python -m pytest tests/test_release_identity.py` → passed, including `test_release_version_is_one_vsce_can_package`
- [x] `npm run verify-package` and `npm run check:payload` resolve the artifact from `extension/vsix-manifest.json`

## Gate E — the artifact

- [x] `cd extension && npm run package` → `dist/research-stack-toolkit-0.3.7.vsix`, 86 files, 332 448 bytes, 0 members carrying CRLF, every ZIP entry stamped at the fixed build epoch, every member 0644 except the three vsce generates
- [x] `sha256sum dist/research-stack-toolkit-0.3.7.vsix` → `f221a9a82a87541416770c7ff0fbe06b8e332dd4e952203d3b18b0ea1ac7ec16`
- [x] `npm run verify-package` → `"result": "passed"`, `sourceFilesMatch: true` (`evidence/quality-v0.3.7-2026-11-02/vsix-audit.json`)
- [x] `npm run check:payload` → passed (`evidence/quality-v0.3.7-2026-11-02/payload-check.json`)
- [x] `uv-0.13.6 lock --check` on all three shipped pairs → exit 0 (`evidence/quality-v0.3.7-2026-11-02/uv-lock-check.txt`)
- [ ] Install the VSIX on the reference host (Windows 11 x64 / VS Code 1.141.0) and rerun the field workspace's setup — **open**, and the only way to close the field report for certain

## Gate F — added after the tag, from the review rounds

- [x] `cd extension && node --test test/lockfile-adversarial.test.js` → 118 passed: 112 synthetic pairs kept with the uv verdict measured for each (110 agree, 2 deliberate support-policy divergences, no uncaught class), and the suite is part of `npm test`
- [x] Both readers run over the same extracted pairs (`extension/lockfile.js` `pairProblems`, `scripts/lockintegrity.py` `check_pair_text`): verdict divergences went 2 → 0 over the original 69 pairs and 0 over all 112 current pairs, with no reader crash; all three shipped pairs read CLEAN in both readers and the reported field pair is flagged in both
- [x] `python3 scripts/verify_vsix.py` refuses an artifact whose packaged text members carry CRLF; the rebuilt artifact has 0 CRLF members in its 86 (`python3` over the VSIX)
- [x] `.venv/bin/python -m pytest tests/test_vsix.py` → 16 passed: three about CRLF, one about ZIP entry timestamps, one about packaged permission bits
- [x] The notebook step's fallback tier measured with real uv on the notebook analysis pair in a temp copy: `uv sync --locked` exit 2 (uv 0.5.0) / exit 1 (uv 0.13.6) on a wound-back manifest, `uv sync --frozen` exit 0 on both, `uv.lock` byte-identical after every run (`evidence/quality-v0.3.7-2026-11-02/notebook-fallback.txt`)
- [x] `extension/scripts/package.js` stamps the staged tree with `SOURCE_DATE_EPOCH=315532800` and gives every staged file mode 0644; `scripts/verify_vsix.py` refuses packaged members carrying any other ZIP timestamp or mode other than 0644 (the three members vsce generates itself excepted) + 2 tests in `tests/test_vsix.py`
- [x] Build the VSIX from a clean clone of the re-cut tag and compare digests with `dist/`: clone builds and the tree build produce 332,448 bytes / sha256 `f221a9a82a87541416770c7ff0fbe06b8e332dd4e952203d3b18b0ea1ac7ec16`. Before this gate existed, two clone builds produced three different digests with byte-identical members
