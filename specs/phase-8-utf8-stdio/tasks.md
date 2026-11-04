# Phase 8 tasks — 0.3.8

Stages run in order; each stage ends with its own gate. Checklists: [checklists/](checklists/).
Every tick names the command or test that produced it; the receipts are in
`evidence/quality-v0.3.8-2026-11-04/`.

## Stage A — prove the failure before changing anything

- [x] A1 Reproduce the field failure on this host with the real command shape and real pipes, and record
  the reproduction. (D8-01) → `tests/test_stdio.py::test_the_harness_reproduces_the_0_3_7_failure`
- [x] A2 Measure why the parent cannot fix it: `-I` ignores `PYTHONIOENCODING`; `PYTHONIOENCODING` beats
  `-X utf8` in a non-isolated child. (D8-02) → `tests/test_stdio.py::test_isolated_mode_ignores_PYTHONIOENCODING`,
  `encoding-matrix.txt` §1
- [x] A3 Measure what the runner does with a child that writes another encoding: U+FFFD, not an error.
  (D8-03) → `encoding-matrix.txt` §4, [review-findings.md](review-findings.md) D8-03
- [x] A4 **Gate A:** the reproduction produces the field sentence (`'charmap' codec can't encode …`) and
  a non-zero exit, so the later green test is driving the same path and not a different one.

## Stage B — make the worker state its own encoding

- [x] B1 `src/research_stack/stdio.py`: `ensure_utf8_stdio()`, reconfigure or wrap, never raise. (R8-02)
- [x] B2 `src/research_stack/cli.py`: call it first; print the receipt and the error line with
  `ensure_ascii=True`. (R8-03, R8-04)
- [x] B3 `extension/runner.js`: `PYTHON_FLAGS = ["-I", "-B", "-X", "utf8"]`, exported, used at every
  Python call site — `steps.js` ×2, `runtime.js`, `diagnostics.js`, `extension.js` (MCP definitions),
  `functional_check.py` (child servers). (R8-01)
- [x] B4 `steps.js::runLabStoreStep`: refuse a U+FFFD receipt. (R8-05)
- [x] B5 `runner.js`: `CODEC_SIGNATURE`, `isCodecFailure`, `describe()` branch; no retry. (R8-06)
- [x] B6 `scripts/verify_recommended_mcp.py`: ASCII-safe receipt. (R8-10)
- [x] B7 **Gate B:** the reproduction command now exits 0 and its stdout is pure ASCII, parseable, and
  names a store file that exists. → `tests/test_stdio.py::test_the_lab_store_command_reports_success_on_a_cp1252_stream`,
  `…test_the_command_the_extension_issues_is_ascii_clean_on_a_cp1252_host`

## Stage C — prove it where the failure lives

- [x] C1 `tests/test_stdio.py`: negative control, the ignored-variable measurement, the exact extension
  argv with a polluted environment, every CLI verb, the error path, two unit cases for the helper.
  (R8-07, R8-08) → 11 cases
- [x] C2 `tests/test_stdio.py`: the shipped worker copy of `stdio.py` and `cli.py` is byte-equal to the
  source, and the shipped CLI carries the guarantee. (R8-09)
- [x] C3 Node: the lab-store and notebook steps issue the reviewed flags; a U+FFFD report is refused;
  `isCodecFailure`/`describe`/`retryable` over the recorded field stderr. → `extension/test/steps.test.js`
  (13/13), `extension/test/runner.test.js` (39/39), `extension/test/python-argv.js`
- [x] C4 **Gate C:** both suites green with the new cases, and the fixtures that pinned `["-I","-B",…]`
  now assert the reviewed flags rather than tolerate their absence. → 336 passed Node, 219 passed Python

## Stage D — release identity

- [x] D1 Five identity strings to `0.3.8`; `uv lock` with the pinned uv 0.13.6; `scripts/lockintegrity.py`
  reports `"ok": true` for all three pairs. (R8-11) → `lockintegrity-cli.json`, `uv-lock-check.txt`
- [x] D2 `scripts/build_worker_bundle.py` regenerates `extension/worker/` — 20 source/lock files now that
  `stdio.py` is part of the package — and refuses a stale pair before `bundle.json` exists.
- [x] D3 Shipped documentation names 0.3.8: `README.md` and the four guides that still named 0.3.6, plus
  `extension/README.md` and `extension/worker/README.md`. (R8-12) → `docs-version-scan.txt`, 18 references
- [x] D4 **Gate D:** identity suite green; the version is one `semver.valid` accepts; the worker folder
  pattern accepts `worker-0.3.8`. → `tests/test_release_identity.py`, `check:payload` `managedPath`

## Stage E — package, audit, report

- [x] E1 `npm run package` → `dist/research-stack-toolkit-0.3.8.vsix`, 87 members, 336 634 bytes.
- [x] E2 `npm run verify-package` passes, including the packaged worker pair and the packaged payload
  bytes of `stdio.py`. → `vsix-audit.json`
- [x] E3 `npm run check:payload` passes; `managedPath` is `.research-toolkit/managed/worker-0.3.8`.
  → `payload-check.json`
- [x] E4 Evidence folder `evidence/quality-v0.3.8-2026-11-04/` with the reproduction, the encoding matrix
  and the audit results.
- [x] E5 CHANGELOG, release report, `.agent/QUALITY_STATE.md`, `.agent/LESSONS.md`, gate report.
- [x] E6 **Gate E:** full suites green; artifact hash recorded; commit + tag `v0.3.8`; clean-clone rebuild
  byte-identical. → 336 Node / 219 Python, `dist/research-stack-toolkit-0.3.8.vsix.sha256` verified with
  `sha256sum -c`, tag `v0.3.8` at `7638898`, and two clean-clone builds producing the shipped artifact
  byte-for-byte (`clean-clone-rebuild.txt`).
