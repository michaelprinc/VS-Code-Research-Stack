# Phase 8 acceptance — 0.3.8

Each case names how it is proven on this host. "Verified" requires a test or a recorded receipt.

| Case | Scenario | Expected | Proof |
|---|---|---|---|
| T8-01 | The 0.3.7 print shape into a cp1252 stdout, real pipes | non-zero exit, stderr carries `'charmap' codec can't encode character '\u010d'` | `tests/test_stdio.py::test_the_harness_reproduces_the_0_3_7_failure` (negative control) |
| T8-02 | `PYTHONIOENCODING=cp1252` with `-I -B`, and the same without `-I` | `utf-8` with `-I`, `cp1252` without it | `tests/test_stdio.py::test_isolated_mode_ignores_PYTHONIOENCODING` |
| T8-03 | `init-lab` in a workspace named `Bankovní účet SVJ ČSA368`, child stdout and stderr forced to cp1252 | exit 0; stdout parses as JSON with `ok: true`, `tableCount: 7`; the store and lab-state files the report names exist; no U+FFFD anywhere | `tests/test_stdio.py::test_the_lab_store_command_reports_success_on_a_cp1252_stream` |
| T8-04 | The exact argv `extension/runner.js` issues (`-I -B -X utf8 -m research_stack.cli init-lab --workspace …`) with `PYTHONIOENCODING=cp1252` in the child's environment and cwd = the Czech workspace | exit 0; every stdout byte < 0x80; JSON parses; `.research-toolkit/store/research.sqlite3` exists | `tests/test_stdio.py::test_the_command_the_extension_issues_is_ascii_clean_on_a_cp1252_host` |
| T8-05 | `inspect`, `init`, `init-lab` under a forced cp1252 stream | each exits 0 with parseable text; `inspect` is exercised on this host's own non-ASCII interpreter path | `tests/test_stdio.py::test_every_verb_prints_a_receipt_a_cp1252_stream_can_hold` |
| T8-06 | A failure whose message names a Czech path (`WORKSPACE_NOT_FOUND: …`) | exit 2, readable error JSON, no U+FFFD | `tests/test_stdio.py::test_an_error_that_names_a_czech_path_still_reaches_the_operator` |
| T8-07 | `ensure_utf8_stdio()` over a cp1252 stream | the stream reports UTF-8 afterwards and the write lands as UTF-8 bytes | `tests/test_stdio.py::test_ensure_utf8_stdio_changes_a_code_page_stream` |
| T8-08 | `sys.stdout` replaced by an object with no `reconfigure` and no `buffer` | the helper reports the encoding it found and does not raise | `tests/test_stdio.py::test_a_stream_that_cannot_be_reconfigured_is_reported_not_raised` |
| T8-09 | `extension/worker/src/research_stack/{stdio.py,cli.py}` in the release tree | byte-equal to `src/research_stack/`, and the shipped CLI carries `ensure_utf8_stdio()` with no `ensure_ascii=False` | `tests/test_stdio.py::test_the_shipped_worker_copy_carries_the_same_guarantee` |
| T8-10 | The lab-store step's argv | exactly `[…PYTHON_FLAGS, "-m", "research_stack.cli", "init-lab", "--workspace", root]`; the notebook import check carries the same flags | `extension/test/steps.test.js` |
| T8-11 | A worker report that arrived as U+FFFD | the step rejects with the "not valid UTF-8 text" sentence, records no store path, and says re-running is safe | `extension/test/steps.test.js` |
| T8-12 | The recorded field stderr through the boundary | `isCodecFailure` true; `describe()` names a text-encoding failure and says it is not a network, proxy or interpreter problem; `retryable()` false; a uv lock sentence and a transport failure are not misread as this class | `extension/test/runner.test.js` |
| T8-13 | MCP server definitions handed to VS Code, and the child servers `functional_check.py` starts | both carry `-I -B -X utf8` | `extension/test/host.test.js` (definition argv), `extension/test/runtime.test.js` (functional-check argv), `extension/functional_check.py` (`StdioServerParameters`) |
| T8-14 | `0.3.8` stated in the five identity sources | identical, three-part, `semver.valid` accepts it, `worker-0.3.8` matches `WORKER_FOLDER_PATTERN` | `tests/test_release_identity.py`, `extension/test/runtime.test.js` (`WORKER_VERSION`, `WORKER_FOLDER_PATTERN`) |
| T8-15 | The three shipped `pyproject.toml`/`uv.lock` pairs after the bump | `scripts/lockintegrity.py` `"ok": true`; the worker pair byte-equal to the root pair; 39 third-party pins unchanged | `tests/test_lock_consistency.py`, `evidence/quality-v0.3.8-2026-11-04/lockintegrity-cli.json` |
| T8-16 | The packaged artifact | `verify_vsix.py` passes with `stdio.py` in the member set and the packaged worker pair current; `check:payload` resolves `managedPath` to `worker-0.3.8` | `evidence/quality-v0.3.8-2026-11-04/vsix-audit.json`, `payload-check.json` |
| T8-17 | Shipped documentation | `README.md`, the four guides and `extension/readme.md` name 0.3.8; no `worker-0.3.6` survives in a packaged member | `evidence/quality-v0.3.8-2026-11-04/docs-version-scan.txt` |
| T8-18 | A retry of the failed step in the field workspace | the step re-runs against a store that already exists and reports `preexisting: true` rather than a second store | `tests/test_workspace.py::test_init_lab_creates_the_store_and_records_only_what_exists` (`again["preexisting"] is True`) + `evidence/…/encoding-matrix.txt` §3 (the measured second run: exit 0, `preexisting=True`, same store path) |

## Result on this host (4 November 2026)

T8-01 … T8-17 are verified by a test or a recorded receipt, in the runs captured in
[evidence/quality-v0.3.8-2026-11-04/](../../evidence/quality-v0.3.8-2026-11-04/README.md):
11 cases in `tests/test_stdio.py`, 23 in `tests/test_vsix.py`, 336 Node assertions-suite, 219 Python
tests, `lockintegrity.py` `"ok": true`, `verify-package` and `check:payload` both `"result": "passed"`,
and the tag rebuilt byte-for-byte in two clean clones.

T8-18 is verified in the harness and measured on this host, but the **field re-run is still open**: the
reported workspace is on Windows 11 x64 and this release has not been installed there. That row is the
one that closes the ticket, and it is listed as open in the release report.
