"""Exercise Recommended MCP discovery without calling a research provider or writing to Zotero."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

from mcp import Client
from mcp.client.stdio import StdioServerParameters
from research_stack.recommended import add_recommended_workspace
from research_stack.workspace import initialize_workspace


async def verify(root: Path, project: Path) -> dict[str, object]:
    root.mkdir(parents=True, exist_ok=True)
    worker_project = root / ".research-toolkit" / "worker"
    if worker_project.is_dir():
        command = shutil.which("uv") or "uv"
        args = ["run", "--locked", "--no-dev", "--project", str(worker_project), "python", "-m", "research_stack.recommended_server"]
        cwd = root
    else:
        command = shutil.which("uv") or "uv"
        args = ["run", "--locked", "--no-dev", "--project", str(project), "python", "-m", "research_stack.recommended_server"]
        cwd = project
    process_env = {**os.environ, "RESEARCH_STACK_WORKSPACE": str(root)}
    process_env.pop("VIRTUAL_ENV", None)
    parameters = StdioServerParameters(
        command=command,
        args=args,
        env=process_env,
        cwd=str(cwd),
    )
    async with Client(parameters) as client:
        listed = await client.list_tools()
        names = sorted(tool.name for tool in listed.tools)
        expected = ["check_citation", "prepare_zotero_import", "search", "zotero_collections", "zotero_item"]
        if names != expected:
            raise AssertionError(f"Unexpected Recommended tool set: {names}")
        failure = await client.call_tool("search", {"provider": "not-a-provider", "query": "fixture", "limit": 1})
        error = failure.structured_content.get("error", {})
        if error.get("code") != "PROVIDER_UNKNOWN":
            raise AssertionError(f"Expected explicit invalid-provider error, got {failure.structured_content}")
        prepared = await client.call_tool(
            "prepare_zotero_import",
            {
                "file_name": "fixture-import.ris",
                "records": [
                    {
                        "title": {"value": "Synthetic fixture"},
                        "publicationType": {"value": "journal-article"},
                        "doi": {"value": "10.1234/example"},
                        "authors": {"value": ["Ada Author"]},
                        "year": {"value": 2024},
                    }
                ],
            },
        )
        data = prepared.structured_content
        ris_path = root / data["path"]
        if data.get("zoteroModified") is not False or not ris_path.is_file() or "DO  - 10.1234/example" not in ris_path.read_text(encoding="utf-8"):
            raise AssertionError("RIS preparation did not create the expected new review file.")
        zotero = await client.call_tool("zotero_collections", {})
        return {"tools": names, "invalidProviderState": error.get("code"), "preparedRis": data["path"], "zoteroState": zotero.structured_content}


async def main() -> None:
    project = Path(__file__).resolve().parents[1]
    if len(sys.argv) > 1:
        result = await verify(Path(sys.argv[1]).expanduser().resolve(), project)
    else:
        with tempfile.TemporaryDirectory(prefix="research-stack-mcp-") as temporary:
            root = Path(temporary) / "basic-workspace"
            initialize_workspace(root)
            worker_package = root / ".research-toolkit" / "worker" / "src" / "research_stack"
            # Simulate a Basic workspace created before Research was added.
            for module in ("research.py", "recommended_server.py"):
                (worker_package / module).unlink(missing_ok=True)
            add_recommended_workspace(root)
            result = await verify(root, project)
            result["workspaceSetup"] = "basic-to-recommended-additive-upgrade"
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
