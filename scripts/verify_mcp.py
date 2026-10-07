"""Launch the real stdio worker and exercise discovery plus both tools."""

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


async def main() -> None:
    project = Path(__file__).resolve().parents[1]
    if len(sys.argv) > 1:
        await verify(Path(sys.argv[1]).expanduser().resolve(strict=True), project)
    else:
        with tempfile.TemporaryDirectory(prefix="research-stack-é-") as temp:
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
        worker_project = root / ".research-toolkit" / "worker"
        command = shutil.which("uv") or "uv"
        args = ["run", "--locked", "--no-dev", "--project", str(worker_project), "research-stack-mcp"]
        cwd = root
    else:
        worker_project = project
        command = str(project / ".venv" / "Scripts" / "research-stack-mcp.exe")
        args = []
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
    print(json.dumps({"workerProject": str(worker_project), "tools": sorted(tool_names), "sourceSha256": original_hash, "markdownAndDocxReportsCreated": True}, indent=2))


if __name__ == "__main__":
    asyncio.run(main())
