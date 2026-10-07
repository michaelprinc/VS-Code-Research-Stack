"""Read-only scholarly metadata and Zotero MCP tools for the Research profile."""

from __future__ import annotations

import os
import re
from pathlib import Path

from mcp.server import MCPServer

from .paths import resolve_under
from .research import ResearchError, get_zotero_item, list_zotero_collections, search_literature, to_ris, validate_citation

server = MCPServer("research-stack-recommended")


@server.tool()
def search(provider: str, query: str, limit: int = 10) -> dict[str, object]:
    """Search one or all scholarly metadata providers with bounded requests and per-field provenance."""
    try:
        return search_literature(provider, query, limit)
    except ResearchError as exc:
        return {"resultState": "error", "error": exc.as_dict()}


@server.tool()
def check_citation(doi: str) -> dict[str, object]:
    """Resolve a DOI against Crossref; a miss is unresolved and does not prove that a citation is invalid."""
    try:
        return validate_citation(doi)
    except ResearchError as exc:
        return {"status": "unavailable", "error": exc.as_dict()}


@server.tool()
def zotero_collections() -> dict[str, object]:
    """Read collections from Zotero's fixed localhost API endpoint; the operation is read-only."""
    try:
        return list_zotero_collections()
    except ResearchError as exc:
        return {"readOnly": True, "error": exc.as_dict()}


@server.tool()
def zotero_item(key: str) -> dict[str, object]:
    """Read one Zotero item by key through the localhost-only API."""
    try:
        return get_zotero_item(key)
    except ResearchError as exc:
        return {"readOnly": True, "error": exc.as_dict()}


@server.tool()
def prepare_zotero_import(records: list[dict[str, object]], file_name: str) -> dict[str, object]:
    """Create a new RIS file under research/imports/ for user review and manual Zotero import; no Zotero write occurs."""
    root_value = os.environ.get("RESEARCH_STACK_WORKSPACE")
    if not root_value:
        return {"error": {"code": "CONFIG_REQUIRED", "message": "Set RESEARCH_STACK_WORKSPACE to the selected workspace."}}
    root = Path(root_value).expanduser().resolve(strict=True)
    if not root.is_dir():
        return {"error": {"code": "CONFIG_INVALID", "message": "Configured research workspace must be a directory."}}
    if not file_name or Path(file_name).name != file_name or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.ris", file_name, flags=re.I):
        return {"error": {"code": "IMPORT_FILENAME_INVALID", "message": "Choose a simple .ris filename without path components."}}
    try:
        ris = to_ris(records)
        output = resolve_under(root, f"research/imports/{file_name}", must_exist=False)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(ris)
        return {"path": str(output.relative_to(root)), "recordCount": len(records), "writeMode": "new-file-only", "zoteroModified": False, "reviewRequired": True}
    except FileExistsError:
        return {"error": {"code": "OUTPUT_EXISTS", "message": "Choose a new filename; existing import files are never overwritten."}}
    except ResearchError as exc:
        return {"error": exc.as_dict()}


def main() -> None:
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
