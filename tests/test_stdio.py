"""The worker's own report survives a Windows console code page (0.3.8).

Field failure, workspace `k:\\Soukromé_aktivity\\Bankovní účet SVJ ČSA368`, toolkit 0.3.7:

    {"kind":"step","stepId":"lab-store","status":"failed","exitCode":2,
     "error":"python.exe -I failed with exit code 2: {\"error\": \"'charmap' codec can't encode
      character '\\\\u010d' in position 67: character maps to <undefined>\"} (cwd …)"}

The store was created. What failed was the *report* that proves it: `research_stack.cli` printed
`json.dumps(result, ensure_ascii=False)` into a stdout whose encoding was the host's code page
(cp1252 on an English-locale Windows 11), `č` has no cp1252 byte, `UnicodeEncodeError` is a
`ValueError`, and the CLI's own error handler turned it into exit 2.

These tests are written so the failure can actually be driven on a Linux development host, because
`-I` alone cannot reproduce it here: measured, `PYTHONIOENCODING=cp1252 python -I -B -c
"import sys; print(sys.stdout.encoding)"` prints `utf-8` — isolated mode ignores the variable — while
the same command without `-I` prints `cp1252`. So the fixture forces the codec **inside** the child,
which is the condition a Windows host hands the child, and one case pins the ignored-variable fact
itself.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from research_stack.stdio import ensure_utf8_stdio

REPO = Path(__file__).resolve().parents[1]
FIELD_WORKSPACE = "Bankovní účet SVJ ČSA368"
# The interpreter flags `extension/runner.js` gives every Python child (PYTHON_FLAGS).
EXTENSION_FLAGS = ["-I", "-B", "-X", "utf8"]
# The 0.3.7 shape, kept verbatim so the negative control proves this harness can produce the field
# error rather than asserting that it could.
SHAPE_037 = "import json\nprint(json.dumps({'workspace': %r}, ensure_ascii=False))" % (
    "k:\\Soukromé_aktivity\\Bankovní účet SVJ ČSA368"
)
FORCE_CP1252 = (
    "import sys\n"
    "sys.stdout.reconfigure(encoding='cp1252')\n"
    "sys.stderr.reconfigure(encoding='cp1252')\n"
)


def run(*args: str, env: dict[str, str] | None = None, cwd: Path | None = None) -> subprocess.CompletedProcess[bytes]:
    """Run a real child with real pipes: no `text=True`, no forced decode in the harness."""
    environment = dict(os.environ)
    environment.pop("PYTHONIOENCODING", None)
    environment.update(env or {})
    return subprocess.run([sys.executable, *args], capture_output=True, cwd=cwd, env=environment)


def decoded(payload: bytes) -> str:
    """What `extension/runner.js` sees: `stream.setEncoding("utf8")` over the child's bytes."""
    return payload.decode("utf-8", errors="replace")


def cp1252_cli(command: str, *argv: str, cwd: Path | None = None) -> subprocess.CompletedProcess[bytes]:
    """The shipped CLI in a child whose stdout and stderr are a Windows code page."""
    return run("-I", "-B", "-c", f"{FORCE_CP1252}{command}", *argv, cwd=cwd)


def test_the_harness_reproduces_the_0_3_7_failure(tmp_path: Path) -> None:
    """Negative control: the fixture really produces the field error, on this host, with real pipes."""
    result = run("-B", "-c", SHAPE_037, env={"PYTHONIOENCODING": "cp1252"})
    assert result.returncode != 0
    failure = decoded(result.stderr)
    assert "charmap" in failure and "codec can't encode" in failure, failure
    assert "\\u010d" in failure, failure


def test_isolated_mode_ignores_PYTHONIOENCODING() -> None:
    """Why the parent cannot fix this from the environment, and `-X utf8` / in-code reconfigure can."""
    isolated = run("-I", "-B", "-c", "import sys; print(sys.stdout.encoding)", env={"PYTHONIOENCODING": "cp1252"})
    inherited = run("-B", "-c", "import sys; print(sys.stdout.encoding)", env={"PYTHONIOENCODING": "cp1252"})
    assert isolated.stdout.decode().strip() == "utf-8", "isolated mode must ignore PYTHONIOENCODING"
    assert inherited.stdout.decode().strip() == "cp1252", "without -I the variable is what the child gets"


def test_the_lab_store_command_reports_success_on_a_cp1252_stream(tmp_path: Path) -> None:
    """The exact 0.3.7 failure path: store created, report printable, step recorded."""
    workspace = tmp_path / FIELD_WORKSPACE
    workspace.mkdir()
    result = cp1252_cli("from research_stack.cli import main\nraise SystemExit(main())",
                        "init-lab", "--workspace", str(workspace))
    assert result.returncode == 0, decoded(result.stderr)
    text = decoded(result.stdout)
    assert "\uFFFD" not in text, f"the runner would decode this as a replacement character: {text}"
    report = json.loads(text)
    assert report["ok"] is True and report["tableCount"] == 7, report
    assert Path(report["store"]).is_file(), "the store the report names does not exist"
    assert Path(report["profile"]).is_file()


def test_the_command_the_extension_issues_is_ascii_clean_on_a_cp1252_host(tmp_path: Path) -> None:
    """`extension/runner.js`'s argv, with the host environment polluted by a code page."""
    workspace = tmp_path / FIELD_WORKSPACE
    workspace.mkdir()
    result = run(*EXTENSION_FLAGS, "-m", "research_stack.cli", "init-lab", "--workspace", str(workspace),
                 env={"PYTHONIOENCODING": "cp1252"}, cwd=workspace)
    assert result.returncode == 0, decoded(result.stderr)
    assert all(byte < 0x80 for byte in result.stdout), "the receipt must be pure ASCII bytes"
    report = json.loads(decoded(result.stdout))
    assert report["ok"] is True
    assert (workspace / ".research-toolkit" / "store" / "research.sqlite3").is_file()


@pytest.mark.parametrize("argv", [
    ["inspect"],
    ["init", "{workspace}"],
    ["init-lab", "--workspace", "{workspace}"],
])
def test_every_verb_prints_a_receipt_a_cp1252_stream_can_hold(argv: list[str], tmp_path: Path) -> None:
    """`inspect` reports `sys.executable` and `shutil.which` results: on this host those paths are
    non-ASCII, so every verb is exercised against the real failure condition, not only `init-lab`."""
    workspace = tmp_path / FIELD_WORKSPACE
    workspace.mkdir()
    argv = [item.format(workspace=str(workspace)) for item in argv]
    result = cp1252_cli("from research_stack.cli import main\nraise SystemExit(main())", *argv)
    assert result.returncode == 0, decoded(result.stderr)
    text = decoded(result.stdout)
    assert "\uFFFD" not in text and json.loads(text), text


def test_an_error_that_names_a_czech_path_still_reaches_the_operator(tmp_path: Path) -> None:
    """The error path is the same class: 0.3.7 printed it with ensure_ascii=False into cp1252."""
    result = cp1252_cli("from research_stack.cli import main\nraise SystemExit(main())",
                        "init-lab", "--workspace", str(tmp_path / FIELD_WORKSPACE / "absent"))
    assert result.returncode == 2
    text = decoded(result.stderr)
    assert "\uFFFD" not in text, f"the operator's error sentence arrived garbled: {text}"
    assert json.loads(text)["error"].startswith("WORKSPACE_NOT_FOUND"), text


def test_ensure_utf8_stdio_changes_a_code_page_stream() -> None:
    raw = io.BytesIO()
    stream = io.TextIOWrapper(raw, encoding="cp1252")
    saved = sys.stdout
    sys.stdout = stream
    try:
        observed = ensure_utf8_stdio()
        assert observed["stdout"].replace("-", "").lower() == "utf8", observed
        print("Bankovní účet SVJ ČSA368")
        sys.stdout.flush()
    finally:
        sys.stdout = saved
    written = raw.getvalue()
    assert written.decode("utf-8").startswith("Bankovní účet SVJ ČSA368"), written


def test_a_stream_that_cannot_be_reconfigured_is_reported_not_raised() -> None:
    """A host that replaces `sys.stdout` must not turn a reporting step into the step's failure."""

    class Opaque:
        encoding = "cp1252"

        def write(self, text: str) -> int:
            return len(text)

    saved = sys.stdout
    sys.stdout = Opaque()
    try:
        observed = ensure_utf8_stdio()
    finally:
        sys.stdout = saved
    assert observed["stdout"] == "cp1252", observed


def test_the_shipped_worker_copy_carries_the_same_guarantee() -> None:
    """The field host runs `extension/worker/src/research_stack/`, not `src/research_stack/`.

    `scripts/build_worker_bundle.py` copies the package byte-for-byte, so a source fix that was not
    re-bundled ships the defect. This is the same guard `tests/test_lock_consistency.py` applies to
    the `pyproject.toml` / `uv.lock` pair.
    """
    for name in ("stdio.py", "cli.py"):
        shipped = REPO / "extension/worker/src/research_stack" / name
        source = REPO / "src/research_stack" / name
        assert shipped.is_file(), f"{name} is not in the worker bundle"
        assert shipped.read_bytes() == source.read_bytes(), f"extension/worker/src/research_stack/{name} is not the reviewed source"
    worker_cli = (REPO / "extension/worker/src/research_stack/cli.py").read_text(encoding="utf-8")
    assert "ensure_ascii=False" not in worker_cli, "the shipped CLI still prints non-ASCII JSON"
    assert "ensure_utf8_stdio()" in worker_cli, "the shipped CLI does not state its output encoding"
