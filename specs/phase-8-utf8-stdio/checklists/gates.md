# Phase 8 gate checklist

Each gate is a command that was run, not an intention. Run them from the repository root. Receipts are in
`evidence/quality-v0.3.8-2026-11-04/`.

## Gate A — the failure is reproduced before anything is changed

- [x] `.venv/bin/python -m pytest tests/test_stdio.py -o addopts="" -q` → 11 passed, including
  `test_the_harness_reproduces_the_0_3_7_failure`, which exits non-zero and prints
  `'charmap' codec can't encode character '\u010d' … character maps to <undefined>` on this host with real pipes
- [x] `evidence/quality-v0.3.8-2026-11-04/encoding-matrix.txt` section 1 — the four-command measurement
  that shows `-I` ignores `PYTHONIOENCODING` and that `PYTHONIOENCODING` beats `-X utf8` when the child is
  not isolated
- [x] `evidence/quality-v0.3.8-2026-11-04/encoding-matrix.txt` section 4 — the Node boundary decodes a
  cp1250 child as U+FFFD with exit 0, and cannot find the path the child named

## Gate B — the worker states its own encoding

- [x] `tests/test_stdio.py::test_the_lab_store_command_reports_success_on_a_cp1252_stream` → exit 0,
  `ok: true`, `tableCount: 7`, the store and profile the report names exist, no U+FFFD
- [x] `tests/test_stdio.py::test_the_command_the_extension_issues_is_ascii_clean_on_a_cp1252_host` → the
  exact `["-I","-B","-X","utf8","-m","research_stack.cli","init-lab",…]` argv with
  `PYTHONIOENCODING=cp1252` in the child's environment: every stdout byte < 0x80
- [x] `tests/test_stdio.py::test_every_verb_prints_a_receipt_a_cp1252_stream_can_hold` → `inspect`, `init`,
  `init-lab` all pass under a forced cp1252 stream
- [x] `evidence/quality-v0.3.8-2026-11-04/encoding-matrix.txt` section 3 — the field retry is safe:
  second run exits 0 with `preexisting=True` and the same store path

## Gate C — proven where the failure lives

- [x] `cd extension && PATH=/tmp/uvs:$PATH npm test` → **336 passed, 0 failed, 0 skipped**
  (`evidence/quality-v0.3.8-2026-11-04/node-suite.txt`), including the new store/notebook flag assertions,
  the refused U+FFFD report, and `isCodecFailure` / `describe` / `retryable` over the recorded field stderr
- [x] `.venv/bin/python -m pytest tests/ -o addopts="" -q` with `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6` →
  **219 passed** (`pytest-with-uv.txt`); without uv on PATH → **218 passed, 1 skipped** (`pytest-no-uv.txt`)
- [x] `tests/test_stdio.py::test_the_shipped_worker_copy_carries_the_same_guarantee` → the bundled
  `stdio.py` and `cli.py` are byte-equal to the source and the shipped CLI carries no `ensure_ascii=False`
- [x] `runner.js` is still the only `execFile` call site and `extension/test/module-boundaries.test.js`
  passes with the new exports

## Gate D — release identity

- [x] Five identity strings at `0.3.8`: `pyproject.toml`, `src/research_stack/__init__.py`,
  `extension/package.json`, `extension/vsix-manifest.json`, `extension/runtime.js` (`WORKER_VERSION`)
- [x] `PATH=/tmp/uvs:$PATH .venv/bin/python scripts/lockintegrity.py` → `"ok": true`, all three pairs,
  worker root `0.3.8` at `revision = 5` (`lockintegrity-cli.json`)
- [x] `uv-0.13.6 lock --check` in all three pair directories → exit 0 (`uv-lock-check.txt`)
- [x] `scripts/build_worker_bundle.py` → "20 reviewed source/lock files and 11 overlay templates for
  worker 0.3.8"
- [x] `grep` over the shipped documentation → 18 version references, all 0.3.8 (`docs-version-scan.txt`);
  `scripts/verify_vsix.py` refuses a packaged guide that names another release, and
  `tests/test_vsix.py::…refuses_packaged_documentation_that_names_another_release` proves it

## Gate E — the artifact

- [x] `cd extension && npm run package` → `dist/research-stack-toolkit-0.3.8.vsix`, **87 members,
  336 634 bytes**, 0 members carrying CRLF, every ZIP entry stamped 1980-01-01, 84 members `0644` and the
  three vsce-generated members `0664`
- [x] `sha256sum dist/research-stack-toolkit-0.3.8.vsix` →
  `fd42c2aab0977219fae44a24c2a697e0a4fb762aedad3baf1340e1d43967bdd2` (sidecar written and verified)
- [x] `npm run verify-package` → `"result": "passed"`, `sourceFilesMatch: true`, `stdio.py` in the packaged
  worker member list (`vsix-audit.json`)
- [x] `npm run check:payload` → `"result": "passed"`, `managedPath` is
  `.research-toolkit/managed/worker-0.3.8` (`payload-check.json`)
- [ ] Install the VSIX in the reported field workspace (`k:\Soukromé_aktivity\Bankovní účet SVJ ČSA368`)
  on Windows 11 x64 / VS Code 1.141.0 and re-run package setup — **open**, and the only way to close the
  field report for certain. The step is idempotent, so the existing store is reused rather than rebuilt.

## Gate F — reproducibility from the tag

- [x] `bash /tmp/repro_check.sh v0.3.8`, twice — each run clones `v0.3.8` (commit `7638898`) into a fresh
  `mktemp -d`, builds there, and compares: **336 634 bytes, sha256
  `fd42c2aab0977219fae44a24c2a697e0a4fb762aedad3baf1340e1d43967bdd2`, identical to the shipped artifact
  both times** (`clean-clone-rebuild.txt`). The script now derives the artifact name from the clone's own
  `extension/vsix-manifest.json` instead of a hard-coded release string.
