# Phase 8 review findings — 0.3.8

Findings are ordered by the moment they were established. Each names the evidence that established it,
so a later reader can re-run it instead of trusting the sentence.

---

## D8-01 · The step that failed had already done its work

The field record for `lab-store` is `{"status":"failed","exitCode":2,"error":"python.exe -I failed with
exit code 2: {\"error\": \"'charmap' codec can't encode character '\\u010d' in position 67: character maps
to <undefined>\"}"}`. Reading `src/research_stack/cli.py` at `v0.3.7` shows why the exit code is 2 and why
the message is a JSON error object rather than a traceback:

```python
        print(json.dumps(result, indent=2, ensure_ascii=False))   # ← raised here
        return 0
    except (DocumentError, OSError, ValueError) as exc:           # UnicodeEncodeError is a ValueError
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2
```

`init_lab_workspace()` had already returned. The store was created. The failure is in the sentence the
worker uses to say so, because that sentence contains the workspace path
`k:\Soukromé_aktivity\Bankovní účet SVJ ČSA368` and `č` (U+010D) has no byte in cp1252. The error line
itself printed cleanly because `json.dumps` escapes `č` as `\u010d` — ASCII, so the code page could carry
it. The toolkit therefore reported a successful operation as a failed one.

**Consequence for the field:** re-running the step is safe. `init-lab` is idempotent and reports
`preexisting: true` (measured in `evidence/quality-v0.3.8-2026-11-04/encoding-matrix.txt`, section 3).

## D8-02 · The parent cannot fix this through the environment

Measured on this host (`encoding-matrix.txt`, section 1):

| Command | `sys.stdout.encoding` |
| --- | --- |
| `PYTHONIOENCODING=cp1252 python -B -c …` | `cp1252` |
| `PYTHONIOENCODING=cp1252 python -X utf8 -c …` | `cp1252` — the variable wins over the flag |
| `PYTHONIOENCODING=cp1252 python -I -B -c …` | `utf-8` — **isolation ignores the variable** |
| `PYTHONIOENCODING=cp1252 python -I -B -X utf8 -c …` | `utf-8` |

Two conclusions, both recorded in [design.md](design.md) as DD8-02 and DD8-03: injecting
`PYTHONIOENCODING` into children would be inert under `-I` and would override `-X utf8` where it is not
inert, so it is not used; `-X utf8` on the argv is the flag that actually holds.

## D8-03 · The Node boundary corrupts a foreign encoding silently

`extension/runner.js` reads children with `stream.setEncoding("utf8")`. A child that writes cp1250 bytes
exits 0 and the runner sees `'workspace: Bankovn\ufffd \ufffd\ufffdet SVJ \ufffdSA368'`
(`encoding-matrix.txt`, section 4). No error, no non-zero exit — a store path containing U+FFFD that the
panel would later fail to find, and would blame on the workspace. This is why the U+FFFD guard belongs in
`runLabStoreStep` (DD8-04): the boundary cannot tell the difference between a path and a corrupted path,
the step can.

## D8-04 · The reproduction lands on the same sentence, not the same number

The local reproduction of the 0.3.7 shape reports `position 59`–`63` depending on the temporary prefix;
the field record says `position 67`. The number counts characters before the first unencodable one in
that workspace's own report, so it is a property of the path, not of the defect. The assertion that
matters is the one the tests make: the same codec, the same character, the same exit code, the same
sentence (`tests/test_stdio.py::test_the_harness_reproduces_the_0_3_7_failure`).

## D8-05 · The suite that should have caught this could not

`tests/test_workspace.py` calls `research_stack.cli.main()` in process. `print()` then writes into
pytest's UTF-8 capture, so a stream that cannot encode the path never exists during the test run. 0.3.7
shipped with 200+ green Python tests and a defect that only appears when the child's stdout is a Windows
code page. `tests/test_stdio.py` exists to make that class of defect visible in the harness: every case
that matters runs a real child with real pipes and a forced code page.

## D8-06 · Codec failure must not be classified as a transport failure

`TRANSIENT_PATTERNS` in `extension/runner.js` matches network, proxy, lock-contention and reaper
sentences. It does not match a codec sentence, so the step is not retried — retrying a cp1252 host would
produce the same bytes. Detection is by message (`CODEC_SIGNATURE`), never by exit code, following the
Phase 7 lesson that exit codes are shared by unrelated causes. `runner.test.js` asserts
`isCodecFailure` over the recorded field stderr and that `retryable` stays false for it.

## D8-07 · The shipped copy is the one the field host runs

`extension/worker/src/research_stack/` is a byte-for-byte bundle of `src/research_stack/`, produced by
`scripts/build_worker_bundle.py` and hashed in `bundle.json`. A fix in the source that is not re-bundled
fixes nothing in the field. `tests/test_stdio.py::test_the_shipped_worker_copy_carries_the_same_guarantee`
compares the two copies byte-for-byte and asserts the shipped CLI has no `ensure_ascii=False`.

## D8-08 · 0.3.7 shipped documentation that named 0.3.6

`extension/guides/*.md` and `extension/worker/README.md` told the operator to install
`research-stack-toolkit-0.3.6.vsix` and to look in `.research-toolkit/managed/worker-0.3.6/`, inside a
0.3.7 build. Nothing checked it. `scripts/verify_vsix.py` now refuses a packaged member that names
another release, and `tests/test_vsix.py` proves the refusal by re-stamping a shipped guide back to
0.3.6. `evidence/quality-v0.3.8-2026-11-04/docs-version-scan.txt` lists every version reference in the
shipped documentation; all 18 name 0.3.8.

## D8-09 · Test fixtures that hard-code the release break on the release

`extension/test/lockfile-adversarial.test.js` built its drift fixtures with
`pyWith([['version = "0.3.7"', 'version = "0.3.8"']])`. Re-locking the pair to 0.3.8 made 16
`String.replace` searches match nothing: a "drift" fixture compared an unmutated pair, and six tests
reported the opposite verdict from uv. Fixed by deriving `SHIPPED_VERSION` from the shipped
`pyproject.toml` and building every search string from it, with the bump fixtures moving to 0.4.0 so the
drift is real. The same class of defect as D8-08: a check that encodes a value instead of a relation.

## D8-10 · Deliberate residuals

`scripts/verify_vsix.py:432` and `scripts/lockintegrity.py:1844` write to stderr without the guarantee.
Both are developer-facing scripts run from a terminal, not part of the installed payload; a garbled
sentence there cannot crash a step. Left as-is and recorded rather than silently carried.

## D8-11 · Reference-host gates remain open

G1–G4 (Windows 11 x64, VS Code 1.141.0) are not closed by this release, as they were not by 0.3.6 or
0.3.7. The 0.3.8 evidence is a reproduction of the reported failure on this Linux host with a forced
code page, plus the measured encoding matrix. It is not a Windows run, and the report says so.
