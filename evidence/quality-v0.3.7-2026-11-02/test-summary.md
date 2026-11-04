# Test receipts — Research Stack Toolkit 0.3.7

Host: Linux development host, Python 3.13.5 (`.venv`, CPython 3.12.16 available through uv's managed
installs), Node v24.22.0. No uv is installed on the host PATH; the uv binaries used below live in
`/tmp/uvs/` and are named explicitly.

## Node suite — the extension

```
cd extension && npm test          # exit 0
tests 331   suites 0   pass 331   fail 0   cancelled 0   skipped 0
```

`npm test` runs 16 files. `extension/test/` holds 18: `host.test.js` (real Extension Host, run by
`npm run test:host`) and `browser.test.js` (bundled Playwright renderer) are the reference-host receipts
and are deliberately not part of `npm test`. New in this release: `test/lockfile.test.js` (24 tests) and `test/lockfile-adversarial.test.js` (118 tests over 112 synthetic pairs whose uv verdict was measured — 110 agree with uv, 2 are deliberate support-policy divergences recorded with both verdicts, and no pair is left uncaught), covering
the pyproject/uv.lock reader, uv's refusal signature, the shipped worker pair, and the shapes real uv
writes for extras, markers, dependency groups, optional dependencies and TOML literal strings). Raw output:
[node-test-output.txt](node-test-output.txt).

## Python suite — the toolkit and its build gates

```
RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6 .venv/bin/python -m pytest   # exit 0
207 passed in 99.84s
```

```
.venv/bin/python -m pytest                                        # exit 0
206 passed, 1 skipped in 99.42s
```

The single skip is `tests/test_lock_consistency.py`'s `uv lock --check` gate: uv 0.5.0 has no
`--check` subcommand and no uv is on the host PATH, so the test skips rather than pretending. With
`RESEARCH_STACK_UV` pointed at a real binary it runs and passes. Raw output:
[pytest-with-uv.txt](pytest-with-uv.txt), [pytest-without-uv.txt](pytest-without-uv.txt).

New in this release: `tests/test_lock_consistency.py` (79 tests with a real uv binary, 78 + 1 skip without — shipped pairs current, the bundled
pair byte-identical to the repository pair, the 39 third-party pins unchanged, the revision bound,
synthetic drift fixtures, extras and PEP 508 markers, optional dependencies and `provides-extras`,
`[dependency-groups]` include entries, the root `source` mode and path, malformed input that must
report rather than raise, the bundle builder's refusal, the CLI's exit codes, and the real
`uv lock --check` gate). `tests/test_vsix.py` holds 22 tests: a packaged worker whose lock is stale is refused, the pair as this
release ships it is accepted, three about CRLF (artifact only, source tree too, and the LF artifact this
release builds), two about ZIP metadata (an entry stamped with the build clock instead of the fixed build
epoch, and members carrying permission bits other than 0644), three refusing a drifted runner boundary (a
second unbounded spawn, `shell: true`, a dropped `kill(-pid)`), one refusing a synchronous process
primitive in the boundary, and two about the capability audit itself (a RegExp `.exec(` method call is not
a process capability; a bare `exec(` still is). `tests/test_release_identity.py` now
also asserts the release version is one `@vscode/vsce` can package.

## Build gates on the packaged artifact

```
npm run package        -> dist/research-stack-toolkit-0.3.7.vsix  (86 files, 332 448 bytes, 0 CRLF members,
                         every ZIP entry stamped 1980-01-01, every member 0644 except the 3 vsce writes)
sha256                 -> f221a9a82a87541416770c7ff0fbe06b8e332dd4e952203d3b18b0ea1ac7ec16
npm run verify-package -> "result": "passed", sourceFilesMatch: true   (see vsix-audit.json)
npm run check:payload  -> passed                                        (see payload-check.json)
python3 scripts/lockintegrity.py -> "ok": true                          (see lockintegrity-cli.json)
```

`verify-package` and `check:payload` resolve the artifact path from `extension/vsix-manifest.json`
through `extension/scripts/with-artifact.js`, so neither can audit an older VSIX.

## Real uv receipts on the shipped pairs

```
cd extension/worker && uv-0.13.6 lock --check                       # exit 0, Resolved 40 packages
cd templates/recommended-overlay/notebooks/analysis && uv-0.13.6 lock --check   # exit 0, 42 packages
cd . && uv-0.13.6 lock --check                                      # exit 0, 40 packages
```

Raw output: [uv-lock-check.txt](uv-lock-check.txt). These are the commands the readers in
`scripts/lockintegrity.py` and `extension/lockfile.js` are cross-checked against.

## Real uv experiments

* [uv-matrix.json](uv-matrix.json) — three commands per uv version, on uv 0.5.0, 0.6.10, 0.7.22,
  0.8.5, 0.9.30, 0.10.7 and 0.13.6: `uv sync --locked …` against the shipped pair (exit 0 on all
  seven); `uv sync --locked …` against the drifted 0.3.6 pair (refused by all seven); and
  `uv sync --frozen …` against the same drifted pair — the tier the extension runs only after it
  recognises drift — which exits 0 and installs the pinned set on all seven. Verdict block:
  `everyDriftRefused`, `everyShippedPairAccepted`, `frozenRecoveredOnEveryDriftedPair`. Reproduce with
  `python3 evidence/quality-v0.3.7-2026-11-02/run_uv_matrix.py --uv …`.
* [lock-provenance.json](lock-provenance.json) — `uv lock` (uv 0.13.6) on the 0.3.6 lock beside this
  release's manifest: a two-line diff, unchanged resolved set, byte-identical to the packaged lock.
  Reproduce with `python3 evidence/quality-v0.3.7-2026-11-02/run_lock_provenance.py`.

## Not covered here

The reference-host receipts (Windows 11 x64 / VS Code Desktop 1.141.0, real Extension Host and
browser renderer) are still open, as they were for 0.3.6. Nothing in this folder claims otherwise.

## Fifth round — the reporting and reader fixes, and what they produced

Receipts added by this round, all produced by commands named in them:

- [round5-e2e-wording.md](round5-e2e-wording.md) with `round5-e2e-broken-worker.json`,
  `round5-e2e-fallback-success.json`, `round5-e2e-fallback-failed.json` — the operator-visible headline,
  step row, recorded command line, next action and pasteable re-run instruction, driven through the
  unpacked VSIX code with the fixed modules.
- [field-workspace.txt](field-workspace.txt) — the reported workspace read read-only from this host: its
  `worker-0.3.6` pair (`pyproject.toml` 0.3.6 beside a lock root of 0.3.4) is flagged by both readers and
  refused by uv 0.11.23 — the version the report's host ran — with exit 1 and the same
  `Resolved 40 packages` line the field log quotes; the shipped 0.3.7 pairs install at exit 0.
- [packaged-uv-matrix.txt](packaged-uv-matrix.txt) — the packaged pairs, not the repository copies, install
  with exit 0 on uv 0.5.0 → 0.13.6 and on 0.11.23.
- [notebook-fallback.txt](notebook-fallback.txt) — the notebook pair's gated fallback measured with real uv
  (`--locked` exit 2 on 0.5.0 / exit 1 on 0.13.6 on a wound-back manifest, `--frozen` exit 0, lock unchanged).
- [sdist-name-uv-verdict.txt](sdist-name-uv-verdict.txt) — uv 0.13.6 `lock --check` exits 0 on a lock whose
  sdist filename names another version while the wheel agrees, which is why neither reader reports it.

Cross-reader re-measurement after the fixes: 112 extracted pairs, 0 verdict divergences, 0 reader crashes.
