# Quality state — Research Stack Toolkit 0.3.8 (UTF-8 stdio release, verified on this host)

Objective: fix the reported field failure — 0.3.7's isolated worker step now installs, and the next step,
**Corpus index and record store**, failed with
`'charmap' codec can't encode character '\u010d' in position 67: character maps to <undefined>` — and make
that class of defect impossible to ship. Spec-driven plan:
[specs/phase-8-utf8-stdio/](../specs/phase-8-utf8-stdio/) (findings D8-01…D8-11, requirements R8-01…R8-12,
decisions DD8-01…DD8-07, cases T8-01…T8-18, [gate checklist](../specs/phase-8-utf8-stdio/checklists/gates.md)).
Release report: [implementation-report-0.3.8.md](../docs/implementation/phase-8-utf8-stdio/implementation-report-0.3.8.md).
Evidence: [evidence/quality-v0.3.8-2026-11-04/](../evidence/quality-v0.3.8-2026-11-04/README.md).
Previous release: 0.3.7 (Phase 7 lock integrity) —
[implementation-report-0.3.7.md](../docs/implementation/phase-7-lock-integrity/implementation-report-0.3.7.md).

Status: **0.3.8 implemented and verified on this Linux development host.** Gates G1–G4 (reference-host
profile gates) remain open, as they were for 0.3.6 and 0.3.7.

## Root cause (proven, not assumed)

`init_lab_workspace()` **succeeded** — the store was created. What failed was the sentence reporting it.
At `v0.3.7`, `src/research_stack/cli.py` printed the receipt with `ensure_ascii=False`; the receipt
contains the workspace path `k:\Soukromé_aktivity\Bankovní účet SVJ ČSA368`, and `č` (U+010D) has no byte
in the host's cp1252 console code page. `UnicodeEncodeError` is a `ValueError`, so the CLI's own
`except (DocumentError, OSError, ValueError)` handler caught it, printed the error JSON (ASCII, because
`json.dumps` escapes `č` as `\u010d`) and returned **2** — the recorded `exitCode`. The parent could not
have fixed it from the environment: measured on this host, `PYTHONIOENCODING=cp1252 python -I -B -c …`
reports `sys.stdout.encoding = utf-8` (isolation ignores the variable), and
`PYTHONIOENCODING=cp1252 python -X utf8 -c …` reports `cp1252` (the variable beats the flag). Receipt:
[encoding-matrix.txt](../evidence/quality-v0.3.8-2026-11-04/encoding-matrix.txt).

The step is idempotent: the measured re-run exits 0 with `preexisting=True` and the same store path, so a
field retry reuses the store the failed run already created.

## Verified now (4 November 2026, this host)

| Item | Evidence |
|---|---|
| Node suite `cd extension && PATH=/tmp/uvs:$PATH npm test` | **336 pass / 0 fail / 0 skipped** (`node-suite.txt`), including `test/steps.test.js` (13) and `test/runner.test.js` (39) |
| Python suite `.venv/bin/python -m pytest tests/` | **219 pass** with `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6` (`pytest-with-uv.txt`); **218 pass + 1 skip** without a uv binary (`pytest-no-uv.txt`) |
| New encoding suite `tests/test_stdio.py` | 11 tests: the negative control that reproduces the field sentence, the `-I`/`PYTHONIOENCODING` measurement, the exact extension argv under a polluted environment, every CLI verb under a forced cp1252 stream, the error path, two helper unit cases, and the byte-equality of the bundled copy |
| Packaged-documentation gate | `tests/test_vsix.py` 23 tests, including the new refusal of a packaged guide that names another release; `docs-version-scan.txt` lists 18 version references, all 0.3.8 |
| Lock integrity `scripts/lockintegrity.py` | `"ok": true` for all three pairs; worker root `0.3.8` at `revision = 5` (`lockintegrity-cli.json`) |
| Real `uv lock --check` (uv 0.13.6) | exit 0 in the repository, `extension/worker` and the overlay notebook directory (`uv-lock-check.txt`) |
| Worker bundle | rebuilt: 20 reviewed source/lock files + 11 overlay templates, `workerVersion 0.3.8` |
| Packaged VSIX | `dist/research-stack-toolkit-0.3.8.vsix`, **336 634 bytes, 87 members**, 0 carrying CRLF, every ZIP entry stamped 1980-01-01, 84 members `0644` + 3 vsce writes `0664`, sha256 `fd42c2aab0977219fae44a24c2a697e0a4fb762aedad3baf1340e1d43967bdd2` (+ `.sha256` sidecar, verified with `sha256sum -c`) |
| VSIX audit `npm run verify-package` | `"result": "passed"`, `sourceFilesMatch: true`, `stdio.py` among the packaged worker members (`vsix-audit.json`) |
| Installed-payload check `npm run check:payload` | passed; managed path resolves to `.research-toolkit/managed/worker-0.3.8` (`payload-check.json`) |
| Clean-clone rebuild | `bash /tmp/repro_check.sh v0.3.8` twice — each clone of tag `v0.3.8` (commit `7638898`) built 336 634 bytes with sha256 `fd42c2aa…`, identical to the shipped artifact (`clean-clone-rebuild.txt`) |

## What changed in this release (finding → implementation)

- **D8-01 the report, not the operation, failed** → `src/research_stack/stdio.py` (`ensure_utf8_stdio()`)
  reconfigures stdout and stderr to UTF-8 with `errors="backslashreplace"` before a shipped entry point
  writes anything, and never raises; `research_stack.cli` calls it first and prints both the receipt and
  the error line with `ensure_ascii=True`.
- **D8-02 the parent cannot use the environment** → `extension/runner.js` owns
  `PYTHON_FLAGS = ["-I", "-B", "-X", "utf8"]`, used at every Python call site: `steps.js` (lab-store,
  notebook import check), `runtime.js` (functional check), `diagnostics.js` (probe), `extension.js` (MCP
  server definitions), `functional_check.py` (child MCP servers). No `PYTHONIOENCODING` is injected (DD8-03).
- **D8-03 the boundary corrupts silently** → `steps.js::runLabStoreStep` refuses a receipt that is not
  valid UTF-8 text and records no store path, saying the store may already exist and re-running is safe.
- **D8-06 a codec failure is not a transport failure** → `runner.js` `CODEC_SIGNATURE` + `isCodecFailure`
  and a `describe()` branch naming it as a text-encoding failure, not a network, proxy or interpreter
  problem; `TRANSIENT_PATTERNS` does not match it, so it is never retried. Detection is by message, never
  by exit code.
- **D8-05 the harness could not see it** → `tests/test_stdio.py` runs real children with real pipes and a
  forced code page; the file's docstring names why the in-process `main()` tests in
  `tests/test_workspace.py` could not catch this.
- **D8-07 the shipped copy is what the field runs** → `tests/test_stdio.py` compares the bundled
  `stdio.py`/`cli.py` with the source byte-for-byte and refuses `ensure_ascii=False` in the shipped CLI.
- **D8-08 documentation named 0.3.6 inside a 0.3.7 build** → `scripts/verify_vsix.py` refuses packaged
  documentation naming another release; `README.md`, the four guides, `extension/README.md` and
  `extension/worker/README.md` now name 0.3.8, and `extension/README.md` carries a "What 0.3.8 fixes"
  section in operator language.
- **D8-09 fixtures that hard-code the release** → `extension/test/lockfile-adversarial.test.js` derives
  `SHIPPED_VERSION` from the shipped `pyproject.toml`; 16 `String.replace` searches that had silently
  matched nothing now build their drift from the pair under test, and the bump fixtures move to 0.4.0.
- **Machine-consumed receipts** → `scripts/verify_recommended_mcp.py` prints with `ensure_ascii=True`.

## Carried forward from 0.3.7 (unchanged in 0.3.8)

Lock self-check before any process or write (`extension/lockfile.js`, `setupRuntime`), `--locked` then one
recorded `--frozen` fallback, the `UV_*` scrub, the single bounded `spawn` + `execFile` process boundary
with the group reap and the `taskkill /T /F` branch, LF-normalised packaging and the CRLF gate, the
artifact derived from `extension/vsix-manifest.json`, and the 112-pair adversarial suite that keeps both
dependency readers aligned with measured uv verdicts.

## Open defects and risks

1. **The field host has not been re-run.** The report came from Windows 11 x64 with `uv.exe`; everything
   here is a Linux host with a forced code page. The 0.3.8 VSIX must be installed in
   `k:\Soukromé_aktivity\Bankovní účet SVJ ČSA368` and its setup re-run before this ticket closes.
2. **Gates G1–G4 remain open** (reference host Windows 11 x64 / VS Code Desktop 1.141.0). 0.3.8 does not
   claim them.
3. **Windows behaviour is simulated, not observed.** The UTF-8 guarantee is proven against a forced cp1252
   stream on Linux and against the measured `-I` behaviour; it is not a Windows console run.
4. **Deliberate residuals:** `scripts/verify_vsix.py:432` and `scripts/lockintegrity.py:1844` write to
   stderr without the guarantee. Both are developer-facing scripts, not installed payload; a garbled
   sentence there cannot fail a step.
5. **Codec detection is signature-based.** `CODEC_SIGNATURE` matches the sentence, not the exit code; a
   future CPython that rewords `UnicodeEncodeError` would fall through to the generic failure path.
6. **Pair P32** (a registry requirement whose `[[package]]` entries are local) is still certified clean by
   both dependency readers while uv refuses it. Unchanged from 0.3.7.
7. **`uv lock --check` coverage is conditional** — the gate skips when no uv binary is available.
8. **One unpacked acceptance workspace is still on disk**: `extension/dist/acceptance-0.3.2` (~54 MB).
   `dist/` holds the release VSIXes and their `.sha256` sidecars; [dist/README.md](../dist/README.md)
   describes what is present.

## Next highest-value actions

1. Install `research-stack-toolkit-0.3.8.vsix` in the reported field workspace, re-run package setup, and
   attach the new `.research-toolkit/logs/` attempt log to the evidence folder. The store step is
   idempotent, so the existing store is reused.
2. Produce the reference-host receipts (G1–G4) on Windows 11 x64 / VS Code 1.141.0.
3. Consider a host-encoding probe in `diagnostics.js` that reports the interpreter's own
   `sys.stdout.encoding` and `sys.flags.utf8_mode`, so a future codec problem is visible before a step
   fails.
4. Close P32 in both readers, if it is worth another reader round.
5. Remove or archive `extension/dist/acceptance-0.3.2/`.
