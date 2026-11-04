"""UTF-8 standard streams for the entry points this toolkit ships.

Why this module exists (0.3.8 field report, workspace `k:\\Soukromé_aktivity\\Bankovní účet
SVJ ČSA368`): the extension reads a worker's stdout as UTF-8 (`extension/runner.js` sets
`setEncoding("utf8")`), but a Windows child process inherits the **system code page**, not UTF-8.
On an English-locale Windows 11 host that is cp1252, which has no `č`. The `lab-store` step ran
`python.exe -I -B -m research_stack.cli init-lab --workspace <root>`, the store was created, and
then `print(json.dumps(result, ensure_ascii=False))` raised `UnicodeEncodeError` on the workspace
path in the report. `UnicodeEncodeError` is a `ValueError`, so the CLI's own error handler caught
it and reported the step as a failure with exit 2 and
`{"error": "'charmap' codec can't encode character '\\u010d' …"}`.

Two facts make this the worker's job, not the parent's:

* `python -I` (isolated mode) ignores `PYTHONIOENCODING`, so the extension cannot fix the child's
  stream encoding from the environment. Measured: `PYTHONIOENCODING=cp1252 python -I -c "print('Č')"`
  prints `Č` — the variable is ignored; without `-I` the same command dies with the charmap error.
* The parent decodes with UTF-8 whatever the child produces, so a cp1252 byte sequence is not an
  error there: it decodes to U+FFFD and the recorded store path is silently corrupted.

So every shipped entry point states its own output encoding before it writes anything. The CLI
additionally serialises its machine-consumed receipts with `ensure_ascii=True`, which is the layer
that still holds if a host replaces `sys.stdout` with something that cannot be reconfigured.
"""

from __future__ import annotations

import io
import sys

UTF8 = "utf-8"
_UTF8_NAMES = {"utf8", "utf_8", "u8", "utf", "cp65001"}


def _is_utf8(stream: object) -> bool:
    encoding = str(getattr(stream, "encoding", "") or "").strip().lower().replace("-", "").replace("_", "")
    return encoding in _UTF8_NAMES


def ensure_utf8_stdio() -> dict[str, str]:
    """Force stdout and stderr to UTF-8 and report what each stream now claims.

    Returns ``{"stdout": <encoding>, "stderr": <encoding>}`` after the change, so a caller can
    record the encoding it actually wrote in. A stream the host replaced with something that
    cannot be reconfigured is left as it is and reported honestly — never raised, because a
    reporting failure must not become the step's failure.
    """
    observed: dict[str, str] = {}
    for name in ("stdout", "stderr"):
        stream = getattr(sys, name, None)
        if stream is None:
            continue
        if not _is_utf8(stream):
            buffer = getattr(stream, "buffer", None)
            try:
                if hasattr(stream, "reconfigure"):
                    stream.reconfigure(encoding=UTF8, errors="backslashreplace")
                elif buffer is not None:
                    setattr(sys, name, io.TextIOWrapper(buffer, encoding=UTF8, errors="backslashreplace"))
            except (AttributeError, ValueError, OSError):
                pass
        observed[name] = str(getattr(getattr(sys, name, None), "encoding", "") or "unknown")
    return observed
