# Phase 8 specification — UTF-8 output from the worker (0.3.8)

Date: 4 November 2026 (Europe/Prague). Predecessor: [specs/phase-7-lock-integrity](../phase-7-lock-integrity/spec.md) (0.3.7 lock integrity).
Scope: a patch release. Nothing in Phase 6 or Phase 7's contracts is widened: the process boundary stays
`extension/runner.js`, the module set and the status vocabulary stay as reviewed, and no step gains a new
recovery tier. What changes is what a worker is allowed to write, and how that is proven.

## 1. Observed failure (field report, 4 November 2026)

Workspace `k:\Soukromé_aktivity\Bankovní účet SVJ ČSA368`, toolkit 0.3.7, package `full`. The worker step
that Phase 7 fixed now installs cleanly; the next step does not:

```
{"kind":"step","stepId":"lab-store","status":"failed","exitCode":2,"durationMs":1678,
 "error":"python.exe -I failed with exit code 2: {\"error\": \"'charmap' codec can't encode character
  '\\\\u010d' in position 67: character maps to <undefined>\"} (cwd k:\\Soukromé_aktivity\\Bankovní účet SVJ ČSA368)"}
{"kind":"plan","status":"partial","ran":["research-overlay","notebook-env"],"skipped":["worker"],
 "repaired":[],"failed":["lab-store"],"blocked":[]}
```

The panel said what Phase 6 designed it to say — the step, its exit code, the tool's own words, the cwd,
and it continued past the failure. 3 of 4 steps are installed. **What the toolkit could not do is report
that the step it had just completed had actually completed.**

`setup-20261104T055902Z.jsonl` and `.research-toolkit/logs/last-setup.json` are the record; the host tool
line reads `uv 0.11.23 (path)`, so this is not the 0.3.6 uv problem returning.

## 2. Diagnosis

Every finding below was reproduced on this Linux development host before it was written down. Line numbers
refer to the **0.3.7 tree at the time of diagnosis** (`v0.3.7`, commit `80fe7ed`); they are evidence of what
was found, not pointers into the 0.3.8 source.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **D8-01** | The worker prints its receipt in whatever the host's console encoding is. `src/research_stack/cli.py:70` was `print(json.dumps(result, indent=2, ensure_ascii=False))`, and `init_lab_workspace` returns `{"workspace": str(target), "store": …, "profile": …}` — the workspace path, with `č` in it. | Read from `v0.3.7`. Reproduced with the exact command shape: `python -I -B -c "…sys.stdout.reconfigure(encoding='cp1252')…; from research_stack.cli import main; raise SystemExit(main())" init-lab --workspace "…/Bankovní účet SVJ ČSA368"` → **exit 2**, stderr `{"error": "'charmap' codec can't encode character '\\u010d' in position 57: character maps to <undefined>"}`. The field's position 67 is the same error over the longer `k:\Soukromé_aktivity\…` path. | A Czech, Polish, Hungarian or any non-Latin-1 workspace path makes the Full package's last step unreportable on a cp1252 host. |
| **D8-02** | The parent cannot fix this from the environment: `-I` implies `-E`, and isolated mode ignores `PYTHONIOENCODING`. | Measured on this host: `PYTHONIOENCODING=cp1252 python -I -B -c "import sys; print(sys.stdout.encoding)"` → `utf-8` (the variable is inert); the same command **without** `-I` → `cp1252` and the write dies. `PYTHONIOENCODING=cp1252 python -X utf8 …` → `cp1252`: the variable beats `-X utf8` when the child is *not* isolated. | Setting `PYTHONIOENCODING` in `runner.js` would have looked like a fix and done nothing. The child has to state its own encoding. |
| **D8-03** | The runner decodes every child as UTF-8, so a child writing another encoding is not an error there — it is silent corruption. | `extension/runner.js:145` `stream.setEncoding("utf8")`. Measured: a child writing cp1252 bytes for `Aplikovaná úč` arrives as `Aplikovan\uFFFD …` in Node. | Had the CLI printed ASCII-safe text with a cp1252 *path*, the step would have been recorded with a store path containing U+FFFD — a path the panel would later fail to find. |
| **D8-04** | The reporting failure is turned into a step failure by the CLI's own handler. | `UnicodeEncodeError` → `UnicodeError` → `ValueError`, and `cli.py:72` catches `(DocumentError, OSError, ValueError)`. `str(UnicodeEncodeError)` is ASCII, so the error line prints and the command exits 2. | `init_store` had already created `.research-toolkit/store/research.sqlite3` and `lab-state.json`. The operator is told the step failed, and a retry re-runs a step whose artifact exists. |
| **D8-05** | The class is not limited to `init-lab`. | `cli.py` `inspect` prints `str(Path(sys.executable).resolve())` and `shutil.which("uv"/"git"/"code")` — on a Czech host those carry the user-profile path; `init` and `add-recommended` return `{"workspace": str(target), …}` (`workspace.py:63`); `read` and `export-bundle` print document paths. The error path (`cli.py:73`) printed raw paths from `records.py:160`, `records.py:156/172/185/301` and `paths.py:60-63` with `ensure_ascii=False`. | On stdout the same command crashes; on stderr it does not crash (`sys.stderr` uses `backslashreplace`) and the operator's error sentence arrives garbled instead. |
| **D8-06** | No test in either suite covers output encoding. | Greps over `tests/` and `extension/test/` for `ensure_ascii`, `cp1252`, `charmap`, `PYTHONIOENCODING`, `-X utf8`: **0 hits**. `tests/test_workspace.py:59` calls `main(["init-lab", …])` **in process**, so `print()` writes into pytest's UTF-8 capture object — the test that looks like it covers this path does not, and it passes on Windows too. `tests/test_functional_check.py:16` runs the child with `subprocess.run(…, encoding='utf-8')`, which forces the harness's own decode. | The defect shipped because the suite's only "non-ASCII workspace" coverage is about *paths*, never about *what the child writes*. |
| **D8-07** | The MCP servers are UTF-8 only because of the vendored SDK. | `mcp/server/stdio.py:178-179` claims fd 1 and wraps it in `_UnownedTextWrapper(stdout_buffer, encoding="utf-8")` (its own comment at :170: "the std handles' platform encodings are unreliable"). Nothing in this repository guarantees it, and while serving the SDK diverts fd 1 to stderr (`:165-166`), so a stray `print()` in a future handler would go through the **original** cp1252 stream. | The guarantee for the servers the editor starts lives in a third-party file the toolkit does not test. |
| **D8-08** | A fix in `src/research_stack/` is not what the field host runs. | `extension/worker/src/research_stack/*.py` is a generated byte copy (`scripts/build_worker_bundle.py:62-71`, `read_bytes`/`write_bytes`); the failing command runs `extension/worker/src/research_stack/cli.py`. Only the `pyproject.toml`/`uv.lock` pair is byte-compared by a test (`tests/test_lock_consistency.py:70-75`); no test compares a shipped Python file with its source. | A source fix that is not re-bundled ships the defect, and the audit would not notice. |
| **D8-09** | The development gates print the same way. | `scripts/verify_recommended_mcp.py:86` `ensure_ascii=False`; `scripts/verify_vsix.py:432` and `scripts/lockintegrity.py:1844` write messages that can carry a path to stderr. | A maintainer on a cp1252 host gets a garbled — or crashing — release gate instead of a finding. |
| **D8-10** | Shipped documentation names the wrong release. | `README.md:38,40,47,53,56,58,61` still say "0.3.6 GUI preview", `worker-0.3.6`, `research-stack-toolkit-0.3.6.vsix`; `extension/guides/{document-worker,onboarding,python,toolkit}.md` carry 8 more `0.3.6`/`worker-0.3.6` references. `README.md` is copied into the worker bundle (`build_worker_bundle.py:62`) and hashed into `bundle.json`. Nothing tests guide or README version text except `check-installed-payload.js:271` on `extension/readme.md`. | The payload the operator reads in the managed runtime names a release that is two behind. |

## 3. Requirements

`R8-xx` are normative. `→` names the finding they close.

### 3.1 The worker's output encoding is stated, not inherited (D8-01, D8-02, D8-05)

- **R8-01** Every Python child this toolkit starts is started with one reviewed set of interpreter
  flags, `-I -B -X utf8`, defined once in `extension/runner.js` and used at every call site — including
  the MCP server definitions the editor starts and the child servers `functional_check.py` starts.
- **R8-02** Every shipped Python entry point states its own output encoding before it writes anything:
  stdout and stderr become UTF-8 whatever the host handed the process. A stream the host replaced with
  something that cannot be reconfigured is reported honestly and never becomes the step's failure.
- **R8-03** A JSON receipt another program parses is ASCII-only. Text the operator reads in a terminal
  stays readable; text the extension parses cannot be garbled by a stream it cannot control.
- **R8-04** An error message that names a Czech path reaches the operator as readable text, not as
  replacement characters.

### 3.2 A step is recorded only from a report that can be read (D8-03, D8-04)

- **R8-05** The store step records a store path only when the worker's report decoded cleanly. A report
  containing U+FFFD is a named failure that says the step is not recorded and that re-running it is safe.
- **R8-06** A codec failure is recognised as its own class in the reviewed boundary: the operator is told
  it is a text-encoding failure and explicitly not a network, proxy or interpreter problem, and it is
  never retried as a transport failure.

### 3.3 The guarantee is proven where the failure actually happens (D8-06, D8-07, D8-08, D8-09)

- **R8-07** A test drives the real failure with real pipes and a forced non-UTF-8 stream, and a negative
  control proves the fixture can produce the field error on this host. An in-process `print()` into a
  UTF-8 capture is not accepted as coverage of this class.
- **R8-08** Every CLI verb is exercised, not only `init-lab`.
- **R8-09** The test suite compares the shipped worker copy of the modules that carry this guarantee with
  their source, so a fix that was not re-bundled fails the suite.
- **R8-10** The development gates print ASCII-safe receipts too.

### 3.4 Release identity (Phase 7's rules, unchanged)

- **R8-11** The release is **0.3.8**: three-part, identical in the five identity sources, one `@vscode/vsce`
  can package, and every shipped `pyproject.toml`/`uv.lock` pair is re-locked with the pinned uv before the
  bundle is built (Phase 7's R7-01…R7-06 still apply).
- **R8-12** Shipped documentation names the release it ships in.

## 4. Out of scope for 0.3.8

- Replacing the MCP SDK's transport, or re-testing the SDK's own UTF-8 handling.
- The reference-host gates G1–G4 (Windows 11 x64 / VS Code 1.141.0), still open since 0.3.6.
- Phase 7's named remaining reader gap (pair P32) and the `DRIFT_SIGNATURE` `--check` branch.
- The two dev-gate stderr writes that garble but cannot crash (`verify_vsix.py:432`, `lockintegrity.py:1844`):
  recorded as residuals, not changed in a patch round.
