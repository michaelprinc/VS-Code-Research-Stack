# Phase 8 design — 0.3.8

Decisions `DD8-xx` with what each one costs. Implementation map at the end.

## 1. Why three layers instead of one

**DD8-01 — the interpreter flag, the in-process reconfigure, and ASCII-safe receipts are all kept.**

Each layer covers a case the other two cannot, and the measurements in [spec.md](spec.md) §2 are the
reason, not preference:

| Layer | Where | What it covers | What it cannot cover |
|---|---|---|---|
| `-X utf8` in the reviewed argv | `extension/runner.js` `PYTHON_FLAGS`, used by `steps.js`, `runtime.js`, `diagnostics.js`, `extension.js`, `functional_check.py` | A managed runtime **from an older toolkit** that this release can still activate (Phase 7's T7-16 keeps `worker-0.3.6`/`worker-0.3.7` activatable): the flag comes from the extension, so an old worker gets UTF-8 stdio without being rebuilt. Also makes the child's stderr UTF-8, which is where a garbled operator message would otherwise live. | `PYTHONIOENCODING` beats `-X utf8` in a child that is **not** isolated (measured). All toolkit calls are isolated, so this holds — but it is a reason not to rely on the flag alone. |
| `ensure_utf8_stdio()` in the worker | `src/research_stack/stdio.py`, called by `cli.py` | The guarantee travels with the payload: it holds however the process was started, including a rollback runtime and an operator running `research-stack` in their own terminal. | A host that replaced `sys.stdout` with something with no `reconfigure` and no `buffer`. |
| `ensure_ascii=True` on parsed receipts | `cli.py`, `scripts/verify_recommended_mcp.py` | The case the layer above cannot: the receipt is pure ASCII bytes, so it is parseable even if the stream is cp1252, cp850 or a host replacement. Proven by a byte-level assertion in the suite. | Human-readable output: `ČSA368` prints as `ČSA368`. Accepted, because the extension parses the JSON and the operator sees the decoded text in the panel. |

**DD8-02 — the MCP server definitions get the flags too, even though the SDK is already safe.**
`extension/extension.js` hands VS Code the argv; VS Code, not `runner.js`, starts those servers, so a
runner-side rule cannot reach them. The SDK's UTF-8 wrapper is a third-party guarantee (D8-07) and it
diverts fd 1 while serving, so a future stray `print()` in a handler would hit the original code page.
Stating the flags costs one argv array and one test assertion and makes the guarantee this repository's.

**DD8-03 — the runner's environment policy is *not* extended for Python calls.**
Injecting `PYTHONIOENCODING` would be inert under `-I` (D8-02) and would add an environment variable the
audit has to explain for no effect. `runner.test.js` already pins that Python calls inherit the editor
environment; that stays.

**DD8-04 — the U+FFFD check lives in the step, not in the boundary.**
`runner.js` decodes; it cannot know whether replacement characters matter for the tool that produced
them (uv's progress lines, a host's own interpreter). The step that turns a report into a recorded path
is where a corrupt path would be recorded, so `runLabStoreStep` is where the receipt is refused. The
boundary keeps its one job.

**DD8-05 — a codec failure gets a named class in `describe()`, and no retry.**
Phase 7's lesson 3 ("match a tool's message, not its exit code") applies: this failure exits 2 here and
could exit 1 elsewhere, so detection is a signature over stderr, `CODEC_SIGNATURE`, exactly like
`DRIFT_SIGNATURE`. `retryable()` already ignores it — `TRANSIENT_PATTERNS` matches none of
`charmap`, `codec can't encode`, `character maps to <undefined>` — and a test now pins that.

**DD8-06 — the worker-copy guard is a test, not a build-time warning.**
`tests/test_lock_consistency.py:70-75` already proves the shipped `pyproject.toml`/`uv.lock` pair is
byte-equal to the reviewed pair. The same shape applied to `stdio.py` and `cli.py` catches D8-08 in the
suite, which is where it belongs: the audit that runs *after* packaging cannot stop a bundle built from
a stale source.

**DD8-07 — the release is 0.3.8, and the bump re-locks.**
Phase 7's lesson 1 is the rule: a version bump is a re-lock. `uv.lock` and `extension/worker/uv.lock`
are regenerated with the pinned uv 0.13.6 (the pair is already at lock `revision 5`, which
`scripts/lockintegrity.py:71` `EXPECTED_REVISION_MAX` accepts and a newer uv would not), then
`scripts/build_worker_bundle.py` regenerates the worker copy — never hand-edited.

## 2. Implementation map

| Requirement | Change |
|---|---|
| R8-01 | `extension/runner.js` `const PYTHON_FLAGS = ["-I", "-B", "-X", "utf8"]`, exported; `steps.js` (lab-store, notebook import check), `runtime.js` (`functionalCheck`), `diagnostics.js` (`probe.py`), `extension.js` (MCP server definitions), `extension/functional_check.py` (`parameters()` child servers) |
| R8-02 | new `src/research_stack/stdio.py` `ensure_utf8_stdio()`; called first in `cli.py::main` |
| R8-03, R8-04 | `cli.py` prints with `ensure_ascii=True` on both the result and the error line; `scripts/verify_recommended_mcp.py` likewise |
| R8-05 | `steps.js::runLabStoreStep` refuses a receipt containing U+FFFD and says the step is not recorded and re-running is safe |
| R8-06 | `runner.js` `CODEC_SIGNATURE`, `isCodecFailure()`, and a `describe()` branch before the generic exit sentence |
| R8-07, R8-08 | new `tests/test_stdio.py`: negative control that reproduces the field error, the `-I`-ignores-`PYTHONIOENCODING` measurement, the exact extension argv with a polluted environment, every CLI verb, the error path, and two unit cases for `ensure_utf8_stdio()` |
| R8-09 | `tests/test_stdio.py::test_the_shipped_worker_copy_carries_the_same_guarantee` |
| R8-10 | `scripts/verify_recommended_mcp.py` |
| R8-11 | five identity strings + re-locked pair + rebuilt bundle + re-cut VSIX |
| R8-12 | `README.md` and `extension/guides/{document-worker,onboarding,python,toolkit}.md` |

## 3. What this deliberately does not do

- It does not make the toolkit read a non-UTF-8 child correctly. It makes the toolkit's own children
  write UTF-8, and refuses a receipt it cannot read.
- It does not change `setupEnvironment` or add `PYTHON*` variables to any child (DD8-03).
- It does not touch the MCP SDK, the record-store schema, or any step's timeout or recovery tier.
- `scripts/verify_vsix.py:432` and `scripts/lockintegrity.py:1844` keep their plain stderr writes: they
  can garble a path on a cp1252 development host, they cannot crash, and both are outside the shipped
  payload. Recorded in [review-findings.md](review-findings.md) rather than changed in a patch round.
