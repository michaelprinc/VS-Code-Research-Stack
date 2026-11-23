"""Host portability of the MCP verifier (0.3.15, P1 / T16-10).

`scripts/verify_mcp.py` is the only gate that starts the shipped stdio worker and reads a Czech
fixture through MCP. In 0.3.14 its development-tree branch named
`.venv/Scripts/research-stack-mcp.exe` unconditionally, so the gate could not run at all on the POSIX
build host — recorded in [implementation-P2-retrieval.md](../specs/phase-15-hybrid-retrieval-presets-bundles/implementation-P2-retrieval.md)
and in T15-21 of the 0.3.14 acceptance table. These tests pin the platform rule itself, so a future
edit cannot put one platform's path back into the default branch, and they pin the named refusal the
script gives when no launcher exists instead of a `FileNotFoundError` from inside the transport.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path

import pytest

_VERIFIER_PATH = Path(__file__).resolve().parents[1] / "scripts" / "verify_mcp.py"
_SPEC = importlib.util.spec_from_file_location("research_stack_mcp_verifier", _VERIFIER_PATH)
assert _SPEC is not None and _SPEC.loader is not None
_VERIFIER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_VERIFIER)

POSIX = ("posix", "nt")


def _launcher_for(tmp_path: Path, platform: str) -> Path:
    """Ask the script what launcher this platform's venv layout produces."""
    original = os.name
    os.name = platform
    try:
        return _VERIFIER.venv_launcher(tmp_path)
    finally:
        os.name = original


def test_the_launcher_follows_the_platform_not_one_vendor_layout(tmp_path: Path) -> None:
    # The two shapes a uv virtual environment really has; a test that only knew one of them is how
    # 0.3.14 shipped a verifier that could not run on the host that built the release.
    posix = _launcher_for(tmp_path, "posix")
    windows = _launcher_for(tmp_path, "nt")

    assert posix.relative_to(tmp_path).as_posix() == ".venv/bin/research-stack-mcp"
    assert windows.relative_to(tmp_path).as_posix() == ".venv/Scripts/research-stack-mcp.exe"
    assert windows.name.endswith(".exe"), "Windows entry points are executables with a suffix"
    assert not posix.name.endswith(".exe"), "POSIX entry points are shebang scripts without one"


def test_resolve_launcher_prefers_the_exact_entry_point_of_the_running_platform(tmp_path: Path) -> None:
    host = os.name
    launcher = _launcher_for(tmp_path, host)
    launcher.parent.mkdir(parents=True, exist_ok=True)
    launcher.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")

    command, args, note = _VERIFIER.resolve_launcher(tmp_path)

    assert command == str(launcher)
    assert args == [], "the installed entry point needs no interpreter arguments"
    assert launcher.name in note, "the receipt names the launcher it actually used"


def test_a_venv_without_an_entry_point_is_reached_through_its_interpreter(tmp_path: Path) -> None:
    # Some venv creators write no wrapper script. The interpreter is still there, and the point of the
    # gate is to start the shipped worker rather than to insist on one wrapper file.
    host = os.name
    environment = tmp_path / ".venv" / ("Scripts" if host == "nt" else "bin")
    environment.mkdir(parents=True)
    python = environment / ("python.exe" if host == "nt" else "python")
    python.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")

    command, args, note = _VERIFIER.resolve_launcher(tmp_path)

    assert command == str(python)
    assert args == ["-m", "research_stack.mcp_server"]
    assert "fallback" in note, "the receipt says it did not use the entry point"


def test_a_missing_launcher_is_a_named_refusal_with_the_paths_it_looked_for(tmp_path: Path) -> None:
    with pytest.raises(SystemExit) as raised:
        _VERIFIER.resolve_launcher(tmp_path)
    message = str(raised.value)
    assert message.startswith("WORKER_LAUNCHER_MISSING"), message
    for fragment in (".venv", "research-stack-mcp", "uv sync"):
        assert fragment in message, f"the refusal must name {fragment}: {message}"


def test_the_verifier_reads_the_czech_fixture_through_the_platform_launcher() -> None:
    """The gate itself, run on this host.

    This is the POSIX half of T16-10: discovery, a read of a fixture whose name carries spaces and a
    diacritic, and two written reports, through the launcher this platform's venv actually produced.
    """
    import asyncio

    project = Path(__file__).resolve().parents[1]
    command, args, _ = _VERIFIER.resolve_launcher(project)
    if not Path(command).exists():
        pytest.skip("no project virtual environment on this host: the gate needs `uv sync` first")

    import tempfile

    with tempfile.TemporaryDirectory(prefix="research-stack-é-") as temp:
        asyncio.run(_VERIFIER.verify(Path(temp), project))
    assert command and args is not None
