# Test receipts — Research Stack Toolkit 0.3.7

Host: Linux development host, Python 3.13.5 (`.venv`, CPython 3.12.16 available through uv's managed
installs), Node v24.22.0. No uv is installed on the host PATH; the uv binaries used below live in
`/tmp/uvs/` and are named explicitly.

## Node suite — the extension

```
cd extension && npm test          # exit 0
tests 250   suites 0   pass 250   fail 0   cancelled 0
```

`npm test` runs 16 files. `extension/test/` holds 18: `host.test.js` (real Extension Host, run by
`npm run test:host`) and `browser.test.js` (bundled Playwright renderer) are the reference-host receipts
and are deliberately not part of `npm test`. New in this release: `test/lockfile.test.js` (24 tests) and `test/lockfile-adversarial.test.js` (73 tests over 69 synthetic pairs whose uv verdict was measured), covering
the pyproject/uv.lock reader, uv's refusal signature, the shipped worker pair, and the shapes real uv
writes for extras, markers, dependency groups, optional dependencies and TOML literal strings). Raw output:
[node-test-output.txt](node-test-output.txt).

## Python suite — the toolkit and its build gates

```
RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6 .venv/bin/python -m pytest   # exit 0
185 passed in 94.31s
```

```
.venv/bin/python -m pytest                                        # exit 0
184 passed, 1 skipped in 96.24s
```

The single skip is `tests/test_lock_consistency.py`'s `uv lock --check` gate: uv 0.5.0 has no
`--check` subcommand and no uv is on the host PATH, so the test skips rather than pretending. With
`RESEARCH_STACK_UV` pointed at a real binary it runs and passes. Raw output:
[pytest-with-uv.txt](pytest-with-uv.txt), [pytest-without-uv.txt](pytest-without-uv.txt).

New in this release: `tests/test_lock_consistency.py` (65 tests — 64 always, 1 gated on a real uv binary — shipped pairs current, the bundled
pair byte-identical to the repository pair, the 39 third-party pins unchanged, the revision bound,
synthetic drift fixtures, extras and PEP 508 markers, optional dependencies and `provides-extras`,
`[dependency-groups]` include entries, the root `source` mode and path, malformed input that must
report rather than raise, the bundle builder's refusal, the CLI's exit codes, and the real
`uv lock --check` gate). `tests/test_vsix.py` grew five tests: a packaged worker whose lock is stale
is refused, the pair as this release ships it is accepted, and three that refuse an artifact whose packaged
text members carry CRLF — one where only the artifact is CRLF, one where the source tree is CRLF too, and
one that accepts the LF artifact this release now builds. `tests/test_release_identity.py` now
also asserts the release version is one `@vscode/vsce` can package.

## Build gates on the packaged artifact

```
npm run package        -> dist/research-stack-toolkit-0.3.7.vsix  (86 files, 312 471 bytes, 0 CRLF members)
sha256                 -> f4db025b12718b62336ebec091ba79523a059ffa9de3ba998f66549183666416
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
