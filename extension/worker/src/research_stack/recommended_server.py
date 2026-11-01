"""Read-only scholarly metadata and Zotero MCP tools for the Research profile."""

from __future__ import annotations

import os
import re
from pathlib import Path

from mcp.server import MCPServer

from . import research
from .paths import resolve_under
from .presets import DEFAULT_PRESET, register_tools, selected_preset
from .research import ResearchError, to_ris
from .tool_meta import TOOL_LIST_CACHE_HINTS, annotations

server = MCPServer("research-stack-recommended", cache_hints=TOOL_LIST_CACHE_HINTS)

TOOL_TITLES = {
    "search_literature": "Search scholarly metadata providers",
    "check_citation": "Check a DOI against Crossref",
    "zotero_collections": "List Zotero collections (read-only)",
    "zotero_item": "Read one Zotero item (read-only)",
    "prepare_zotero_import": "Prepare a RIS file for manual Zotero import",
}

TOOL_ANNOTATIONS = {
    "check_citation": annotations(read_only=True),
    "prepare_zotero_import": annotations(read_only=False, destructive=False, idempotent=False),
    "zotero_collections": annotations(read_only=True),
    "zotero_item": annotations(read_only=True),
    "search_literature": annotations(read_only=True),
}

DEPRECATED_ALIAS = "search"
DEPRECATED_ALIAS_TITLE = "Search scholarly metadata (deprecated alias for search_literature)"


def search_literature(provider: str, query: str, limit: int = 10) -> dict[str, object]:
    """Search one or all scholarly metadata providers with bounded requests and per-field provenance."""
    try:
        return research.search_literature(provider, query, limit)
    except ResearchError as exc:
        return {"resultState": "error", "error": exc.as_dict()}


def check_citation(doi: str) -> dict[str, object]:
    """Resolve a DOI against Crossref; a miss is unresolved and does not prove that a citation is invalid."""
    try:
        return research.validate_citation(doi)
    except ResearchError as exc:
        return {"status": "unavailable", "error": exc.as_dict()}


def zotero_collections() -> dict[str, object]:
    """Read collections from Zotero's fixed localhost API endpoint; the operation is read-only."""
    try:
        return research.list_zotero_collections()
    except ResearchError as exc:
        return {"readOnly": True, "error": exc.as_dict()}


def zotero_item(key: str) -> dict[str, object]:
    """Read one Zotero item by key through the localhost-only API."""
    try:
        return research.get_zotero_item(key)
    except ResearchError as exc:
        return {"readOnly": True, "error": exc.as_dict()}


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


def search(provider: str, query: str, limit: int = 10) -> dict[str, object]:
    """Deprecated alias for search_literature, kept only for unmanaged 0.3.2/0.3.3 MCP configurations.

    It is registered only when no tools preset is selected. Move prompts, skills and
    hand-written MCP entries to ``search_literature``; the alias is removed in the next release.
    """
    return search_literature(provider, query, limit)


RESEARCH_TOOLS = (search_literature, check_citation, zotero_collections, zotero_item, prepare_zotero_import)


def main() -> None:
    register_tools(server, RESEARCH_TOOLS, TOOL_TITLES, TOOL_ANNOTATIONS)
    if selected_preset() == DEFAULT_PRESET:
        # Hand-written .mcp.json definitions and 0.3.2 skills still call `search`.
        server.tool(title=DEPRECATED_ALIAS_TITLE, annotations=TOOL_ANNOTATIONS["search_literature"])(search)
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
