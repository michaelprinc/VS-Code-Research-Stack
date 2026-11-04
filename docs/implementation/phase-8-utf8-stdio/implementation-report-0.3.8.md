# Research Stack Toolkit 0.3.8 — the worker writes UTF-8, whatever the host console is

**Release:** 0.3.8 · 4 November 2026 · tag `v0.3.8`
**Artifact:** `dist/research-stack-toolkit-0.3.8.vsix` — 336 634 bytes, 87 members,
sha256 `fd42c2aab0977219fae44a24c2a697e0a4fb762aedad3baf1340e1d43967bdd2`
**Specification:** [specs/phase-8-utf8-stdio/](../../specs/phase-8-utf8-stdio/) — findings D8-01…D8-11,
requirements R8-01…R8-12, decisions DD8-01…DD8-07, acceptance cases T8-01…T8-18,
[gate checklist](../../specs/phase-8-utf8-stdio/checklists/gates.md)
**Evidence:** [evidence/quality-v0.3.8-2026-11-04/](../../evidence/quality-v0.3.8-2026-11-04/README.md)
**Previous release:** [0.3.7 — lockfile integrity and lock-drift recovery](../phase-7-lock-integrity/implementation-report-0.3.7.md)

---

## Why this release exists

0.3.7 fixed the reported install failure. The field user re-ran package setup in
`k:\Soukromé_aktivity\Bankovní účet SVJ ČSA368` on Windows 11 x64 and got one step further: the isolated
worker installed, and the next step did not.

```json
{"kind":"step","stepId":"lab-store","status":"failed","exitCode":2,"durationMs":1678,
 "error":"python.exe -I failed with exit code 2: {\"error\": \"'charmap' codec can't encode character '\\u010d' in position 67: character maps to <undefined>\"} (cwd k:\\Soukromé_aktivity\\Bankovní účet SVJ ČSA368)"}
{"kind":"plan","status":"partial","ran":["research-overlay","notebook-env"],"skipped":["worker"],
 "repaired":[],"failed":["lab-store"],"blocked":[]}
```

> Installation incomplete — 3 step(s) verified, 1 need attention (Corpus index and record store).
> 3 of 4 package steps are installed in this workspace. Host tools used by setup: uv 0.11.23.

The step is *Corpus index and record store*. Its command is
`python.exe -I -B -m research_stack.cli init-lab --workspace <root>`, and the report says the failure is
in a codec: `'charmap' codec can't encode character '\u010d'`. The character is the `č` in the user's own
workspace name. Nothing in the message mentions a network, a proxy, uv, or the store.

The panel also listed **uv 0.11.23** as the host tool setup used. That is not implicated here: the store
step starts no uv process at all — it is a plain `python -m research_stack.cli` call — and the step that
does use uv, the isolated locked worker, is one of the three that verified. For completeness, uv 0.6.10,
0.7.22, 0.8.5, 0.9.30, 0.10.7 and 0.13.6 each accept this release's worker pair with
`uv lock --check` exit 0 (`uv-lock-check-across-versions.txt`); uv 0.5.0 predates that subcommand and was
covered in 0.3.7 by `uv sync --locked`.

## The root cause, in the order it was established

**1. The operation succeeded; the report of it failed.** `init_lab_workspace()` had already returned a
result. At `v0.3.7`, `src/research_stack/cli.py` ended with:

```python
        print(json.dumps(result, indent=2, ensure_ascii=False))   # ← UnicodeEncodeError here
        return 0
    except (DocumentError, OSError, ValueError) as exc:           # UnicodeEncodeError IS a ValueError
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
```

The result contains the workspace path. `č` (U+010D) has no byte in cp1252, the console code page of an
English-locale Windows 11 host, so the print raised. The handler caught it as a domain error, printed the
error JSON — which survived, because `json.dumps` escapes `č` as `\u010d` and the sentence is pure ASCII —
and returned **2**. That is the recorded `exitCode`, and that is why the panel's sentence is a JSON object
rather than a traceback. The record store exists on that machine.

**2. The parent could not have fixed it from the environment.** Measured on this host
([encoding-matrix.txt](../../evidence/quality-v0.3.8-2026-11-04/encoding-matrix.txt) §1):

| Command | `sys.stdout.encoding` |
| --- | --- |
| `PYTHONIOENCODING=cp1252 python -B -c …` | `cp1252` |
| `PYTHONIOENCODING=cp1252 python -X utf8 -c …` | `cp1252` — the variable beats the flag |
| `PYTHONIOENCODING=cp1252 python -I -B -c …` | `utf-8` — **isolated mode ignores the variable** |
| `PYTHONIOENCODING=cp1252 python -I -B -X utf8 -c …` | `utf-8` |

`-I` implies `-E`. Injecting `PYTHONIOENCODING` into children would therefore do nothing for the isolated
steps and would override `-X utf8` for the non-isolated ones. It is not used (DD8-03).

**3. The extension's own decoder hides the failure when it does not crash it.** `extension/runner.js`
reads children with `stream.setEncoding("utf8")`. A child that writes cp1250 bytes exits 0 and the runner
sees `'workspace: Bankovn\ufffd \ufffd\ufffdet SVJ \ufffdSA368'` (§4). No error, no non-zero exit — a store
path containing U+FFFD that the panel would later fail to find and blame on the workspace.

**4. The harness could not see any of this.** `tests/test_workspace.py` calls `main()` in process, so
`print()` writes into pytest's UTF-8 capture. 200+ green Python tests shipped a defect that only exists
when the child's stdout is a Windows code page.

## What 0.3.8 does

Three layers, deliberately redundant, because the toolkit cannot know how a Python process was started.

**1. The interpreter is told.** `extension/runner.js` now owns one reviewed flag set,
`PYTHON_FLAGS = ["-I", "-B", "-X", "utf8"]`, and every Python child the toolkit starts is started with it:
the store step and the notebook import check (`extension/steps.js`), the functional check
(`extension/runtime.js`), the diagnostics probe (`extension/diagnostics.js`), the MCP server definitions
handed to VS Code (`extension/extension.js`), and the child MCP servers `extension/functional_check.py`
starts. `-X utf8` also covers stderr, and it covers managed runtimes that were rolled back to an older
build where the flag is the only lever.

**2. The worker states its own encoding.** New module `src/research_stack/stdio.py`:
`ensure_utf8_stdio()` reconfigures stdout and stderr to UTF-8 with `errors="backslashreplace"`, or wraps
the underlying buffer when the stream has no `reconfigure`, and swallows
`(AttributeError, ValueError, OSError)` — a reporting failure must never become the step's failure. It
returns the encodings it observed. `research_stack.cli` calls it as the first statement of `main()`, so the
guarantee holds however the process was launched.

**3. The receipt is ASCII.** `research_stack.cli` prints both the result and the error line with
`ensure_ascii=True`. A workspace path in a report can then neither crash the command that prints it nor
arrive garbled. `ČSA368` appears escaped in the raw JSON and correctly in the panel, which parses it.
`scripts/verify_recommended_mcp.py` got the same treatment.

**A report the extension cannot read is refused, not recorded.** `runLabStoreStep` in `extension/steps.js`
rejects a receipt whose bytes are not valid UTF-8 text:

> The worker's store-initialisation report was not valid UTF-8 text, so its store path cannot be trusted
> and this step is not recorded. The store itself may already exist; re-running this step is safe.

**A codec failure is its own class.** `extension/runner.js` adds `CODEC_SIGNATURE` and `isCodecFailure`,
and `describe()` now says:

> … could not write its own result in this host's console encoding … This is a text-encoding failure, not
> a network, proxy or interpreter problem. This release starts every Python child with `-X utf8` …

Detection is by message, never by exit code — the Phase 7 lesson. `TRANSIENT_PATTERNS` does not match it,
so the step is not retried: retrying a cp1252 host produces the same bytes.

**The shipped copy is the one the field runs.** `extension/worker/src/research_stack/` is a byte-for-byte
bundle. `tests/test_stdio.py` compares the bundled `stdio.py` and `cli.py` with their sources and refuses
`ensure_ascii=False` in the shipped CLI, so a source fix that is not re-bundled now fails the suite.

## Findings that changed the plan

- **D8-02** — the plan started as "set `PYTHONIOENCODING` in the child environment". The measurement above
  killed it before it was written.
- **D8-03** — the U+FFFD measurement moved the guard from the process boundary to the step. The boundary
  cannot tell a path from a corrupted path; the step can.
- **D8-08** — while bumping the identity strings, the shipped guides and `extension/worker/README.md` were
  found still telling the operator to install `research-stack-toolkit-0.3.6.vsix` and look in
  `worker-0.3.6/`, inside a 0.3.7 build. Nothing checked it. `scripts/verify_vsix.py` now refuses packaged
  documentation that names another release, and `tests/test_vsix.py` proves the refusal by re-stamping a
  shipped guide back to 0.3.6.
- **D8-09** — re-locking to 0.3.8 broke `extension/test/lockfile-adversarial.test.js`: 16
  `String.replace` searches hard-coded `version = "0.3.7"`, matched nothing, and six "drift" fixtures
  compared an unmutated pair and reported the opposite verdict from uv. The fixtures now derive
  `SHIPPED_VERSION` from the shipped `pyproject.toml` and bump to 0.4.0, so the drift is real. Same class
  as D8-08: a check that encodes a value instead of a relation.

## What was deliberately not changed

- **No `PYTHONIOENCODING` is injected into children** (DD8-03): inert under `-I`, overriding where it is
  not.
- **No retry on a codec failure** (DD8-05): it is deterministic.
- **No Windows-only branch.** The guarantee is stated in the worker and on the argv for every host; a
  code-page-specific workaround would be untestable here and wrong on the next locale.
- **`scripts/verify_vsix.py:432` and `scripts/lockintegrity.py:1844` still write to stderr without the
  guarantee.** Both are developer-facing scripts run from a terminal, not installed payload; a garbled
  sentence there cannot fail a step. Recorded as residuals rather than silently carried.
- **`README.md` keeps its historical link to the 0.3.6 install-reliability specification**, and
  `tests/test_release_identity.py` keeps its generic `worker-0.3.6 / worker-0.3.7 / worker-0.4.0` sample
  list: both name releases on purpose, and the new gate allows a version reference that is not the current
  one only where it is not presented as the artifact to install.

## Verification

All commands run on this Linux development host (Python 3.12.16, uv 0.13.6 pinned at `/tmp/uvs/uv-0.13.6`).
Receipts: [evidence/quality-v0.3.8-2026-11-04/](../../evidence/quality-v0.3.8-2026-11-04/README.md).

| Gate | Command | Result |
| --- | --- | --- |
| A | `pytest tests/test_stdio.py -o addopts="" -q` | 11 passed, including the negative control that reproduces the field sentence with real pipes |
| A | `encoding-matrix.txt` §1, §4 | the four-command encoding measurement; the U+FFFD the runner sees |
| B | `pytest tests/test_stdio.py -k "cp1252 or ascii"` | the store command exits 0 on a forced cp1252 stream, `ok: true`, `tableCount: 7`, the store and profile it names exist; the exact extension argv under `PYTHONIOENCODING=cp1252` produces stdout with every byte < 0x80 |
| B | `encoding-matrix.txt` §3 | the field retry: second run exits 0, `preexisting=True`, same store path |
| C | `cd extension && PATH=/tmp/uvs:$PATH npm test` | **336 passed, 0 failed, 0 skipped** (`node-suite.txt`) |
| C | `pytest tests/ -o addopts="" -q` | **219 passed** with `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6`; **218 passed, 1 skipped** without uv (`pytest-with-uv.txt`, `pytest-no-uv.txt`) |
| D | `PATH=/tmp/uvs:$PATH .venv/bin/python scripts/lockintegrity.py` | `"ok": true`, three pairs, worker root `0.3.8` at `revision = 5` |
| D | `uv-0.13.6 lock --check` in the three pair directories | exit 0 (`uv-lock-check.txt`) |
| D | `scripts/build_worker_bundle.py` | 20 reviewed source/lock files + 11 overlay templates for worker 0.3.8 |
| D | version scan of the shipped documentation | 18 references, all 0.3.8 (`docs-version-scan.txt`) |
| E | `npm run package` | `dist/research-stack-toolkit-0.3.8.vsix`, 87 members, 336 634 bytes, 0 members with CRLF, every ZIP entry stamped 1980-01-01, 84 × `0644` + 3 × `0664` |
| E | `npm run verify-package` | `"result": "passed"`, `sourceFilesMatch: true`, `stdio.py` packaged |
| E | `npm run check:payload` | `"result": "passed"`, `managedPath` `.research-toolkit/managed/worker-0.3.8` |
| E | `sha256sum … > ….sha256` then `sha256sum -c` | OK |
| F | `bash /tmp/repro_check.sh v0.3.8`, twice | each clean clone built 336 634 bytes with sha256 `fd42c2aa…`, identical to the shipped artifact (`clean-clone-rebuild.txt`) |

Test counts moved from 331 → 336 (Node) and 218 → 219 (Python) against the 0.3.7 baseline: 11 new cases in
`tests/test_stdio.py`, 1 new VSIX gate, 5 new Node assertions across `steps.test.js` (13) and
`runner.test.js` (39), and a shared `extension/test/python-argv.js` helper so fixtures assert the reviewed
flags instead of reading `args[2]`.

## What the field user should do now

1. Install `research-stack-toolkit-0.3.8.vsix` and re-run **Install Research Stack packages**.
2. The store step is idempotent. The store created by the failed 0.3.7 run is reused — the step reports
   `preexisting: true` — so nothing in `\.research-toolkit\store\` is rebuilt or overwritten.
3. If a step still fails, **Copy Installation Diagnostics** now says whether it is a text-encoding
   problem, a lock problem, or a transport problem, in that first sentence.

## What remains open

1. **The field host has not been re-run.** Everything above is a Linux host with a forced code page and a
   measured `-I` behaviour. The 0.3.8 VSIX must be installed in the reported workspace on Windows 11 x64 /
   VS Code 1.141.0 and its setup re-run before this ticket closes. Gates G1–G4 remain open, as in 0.3.6 and
   0.3.7.
2. **Codec detection is signature-based.** `CODEC_SIGNATURE` matches the sentence, not the exit code; a
   future CPython that rewords `UnicodeEncodeError` would fall through to the generic failure path.
3. **`ensure_utf8_stdio()` returns the encodings it observed, and nothing records them yet.** A diagnostics
   probe that reports the interpreter's own `sys.stdout.encoding` and `sys.flags.utf8_mode` is the next
   highest-value addition: it would show a codec problem before a step fails.
4. **Pair P32** (a registry requirement whose `[[package]]` entries are local) is still certified clean by
   both dependency readers while uv refuses it. Unchanged from 0.3.7.
5. `extension/dist/acceptance-0.3.2` (~54 MB) is still on disk; `dist/` itself holds only the release
   VSIXes and their sidecars.
