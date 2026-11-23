"""Launch the real stdio worker and exercise discovery plus both tools.

Host portability (0.3.15, T16-10): this script runs on the reference Windows host and on the POSIX
build host, so the worker launcher is derived from the platform instead of hard-coded. A uv virtual
environment puts its entry points in ``.venv/Scripts/`` with an ``.exe`` suffix on Windows and in
``.venv/bin/`` without a suffix everywhere else; the 0.3.14 copy named only the Windows form, which
means the script could not start a worker at all on POSIX — the same class of host-dependent defect
the 19 November Windows run recorded for the Node test paths. A launcher that is not there is a
named refusal with the two paths it looked for, never a FileNotFoundError from deep inside the
transport.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

from docx import Document
from mcp import Client
from mcp.client.stdio import StdioServerParameters


def venv_launcher(project: Path) -> Path:
    """The worker entry point inside the project's own virtual environment, for this platform."""
    scripts = "Scripts" if os.name == "nt" else "bin"
    suffix = ".exe" if os.name == "nt" else ""
    return project / ".venv" / scripts / f"research-stack-mcp{suffix}"


def resolve_launcher(project: Path) -> tuple[str, list[str], str]:
    """Return (command, args, launcherNote) for the development tree.

    The exact file is preferred. When it is missing but the sibling directory exists, the same
    entry point is reached through the interpreter of that environment: a POSIX venv created by a
    tool that writes no wrapper, or a Windows venv whose wrapper was not created, both still have a
    working interpreter, and the point of this script is to start the shipped worker, not to insist
    on one particular wrapper file.
    """
    exact = venv_launcher(project)
    if exact.exists():
        return str(exact), [], f"venv entry point {exact.name}"
    environment = project / ".venv" / ("Scripts" if os.name == "nt" else "bin")
    python = environment / ("python.exe" if os.name == "nt" else "python")
    if environment.is_dir() and python.exists():
        return str(python), ["-m", "research_stack.mcp_server"], f"fallback: {python} -m research_stack.mcp_server"
    raise SystemExit(
        "WORKER_LAUNCHER_MISSING: no worker entry point for this platform. Looked for "
        f"{exact} and {python}. Run `uv sync` in {project} first, or pass a workspace that already "
        "has an installed worker."
    )


async def main() -> None:
    project = Path(__file__).resolve().parents[1]
    if len(sys.argv) > 1:
        await verify(Path(sys.argv[1]).expanduser().resolve(strict=True), project)
    else:
        with tempfile.TemporaryDirectory(prefix="research-stack-é-") as temp:
            # The diacritic in the prefix is the point: the whole run reads and writes a path the
            # host had to carry through a non-ASCII name, on either platform.
            await verify(Path(temp), project)


async def verify(root: Path, project: Path) -> None:
    persistent = (root / ".research-toolkit" / "worker").is_dir()
    (root / "papers").mkdir(parents=True, exist_ok=True)
    (root / "outputs").mkdir(parents=True, exist_ok=True)
    source = root / "papers" / "paper with spaces.docx"
    if not source.exists():
        doc = Document()
        doc.add_paragraph("Synthetic Czech source: Výzkum a evidence.")
        doc.save(source)
    original_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if persistent:
        # A workspace that already installed its own worker: the same `uv` route the editor starts.
        worker_project = root / ".research-toolkit" / "worker"
        command = shutil.which("uv") or "uv"
        args = ["run", "--locked", "--no-dev", "--project", str(worker_project), "research-stack-mcp"]
        cwd = root
        launcher_note = "isolated worker via uv run --locked --no-dev"
    else:
        worker_project = project
        command, args, launcher_note = resolve_launcher(project)
        cwd = project
    parameters = StdioServerParameters(
        command=command,
        args=args,
        env={**os.environ, "RESEARCH_STACK_WORKSPACE": str(root)},
        cwd=cwd,
    )
    async with Client(parameters, read_timeout_seconds=30) as client:
        listed = await client.list_tools()
        tool_names = {tool.name for tool in listed.tools}
        assert {"read_document", "write_markdown", "write_docx"} <= tool_names, sorted(tool_names)
        read = await client.call_tool("read_document", {"path": "papers/paper with spaces.docx"})
        extracted = read.structured_content
        assert "Výzkum a evidence" in extracted["text"]
        assert extracted["locators"][0]["item"] == 1
        output_name = f"mcp-validation-{uuid.uuid4().hex[:8]}.md"
        written = await client.call_tool(
            "write_markdown",
            {
                "title": "Synthetic MCP validation",
                "body": "A fixture-backed statement.",
                "output_path": f"outputs/{output_name}",
                "sources": [{"label": "Synthetic source", "reference": "paper with spaces.docx paragraph 1", "sha256": extracted["sha256"]}],
            },
        )
        assert written.structured_content["path"].endswith(output_name)
        report = root / "outputs" / output_name
        assert "Synthetic source" in report.read_text(encoding="utf-8")
        docx_name = f"mcp-validation-{uuid.uuid4().hex[:8]}.docx"
        written_docx = await client.call_tool(
            "write_docx",
            {
                "title": "Synthetic MCP DOCX validation",
                "body": "A second fixture-backed statement.",
                "output_path": f"outputs/{docx_name}",
                "sources": [{"label": "Synthetic source", "reference": "paper with spaces.docx paragraph 1", "sha256": extracted["sha256"]}],
            },
        )
        assert written_docx.structured_content["path"].endswith(docx_name)
        assert "Synthetic source" in "\n".join(paragraph.text for paragraph in Document(root / "outputs" / docx_name).paragraphs)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == original_hash
    print(json.dumps({
        "workerProject": str(worker_project),
        "launcher": launcher_note,
        "platform": sys.platform,
        "tools": sorted(tool_names),
        "czechFixtureRead": "Výzkum a evidence" in extracted["text"],
        "sourcePathWithSpaces": str(source),
        "sourceSha256": original_hash,
        "markdownAndDocxReportsCreated": True,
    }, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
