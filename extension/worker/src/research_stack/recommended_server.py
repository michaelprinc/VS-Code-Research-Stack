"""Scholarly metadata and Zotero MCP tools for the Research profile.

0.3.13 (phase 14) puts the Zotero work behind two tools instead of three: `zotero_library` reads,
`zotero_write` writes under a confirmation the operator has to reproduce, and `prepare_zotero_import`
stays the no-key manual path. The old read verbs remain as aliases registered only for the unmanaged
`all` preset, the same way `search` was kept after it was renamed `search_literature`.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from mcp.server import MCPServer

from . import research, zotero_store
from .paths import resolve_under
from .presets import DEFAULT_PRESET, register_tools, selected_preset
from .research import ResearchError, to_ris, validate_ris_text
from .tool_meta import TOOL_LIST_CACHE_HINTS, annotations

server = MCPServer("research-stack-recommended", cache_hints=TOOL_LIST_CACHE_HINTS)

TOOL_TITLES = {
    "search_literature": "Search scholarly metadata providers",
    "check_citation": "Check a DOI against Crossref",
    "zotero_library": "Read the local Zotero library",
    "zotero_write": "Write to the local Zotero library",
    "prepare_zotero_import": "Prepare a validated RIS file for manual Zotero import",
}

TOOL_ANNOTATIONS = {
    "check_citation": annotations(read_only=True, open_world_hint=True),
    "prepare_zotero_import": annotations(read_only=False, destructive=False, idempotent=False),
    "zotero_library": annotations(read_only=True, open_world_hint=True),
    "zotero_write": annotations(read_only=False, destructive=True, idempotent=False, open_world_hint=True),
    "search_literature": annotations(read_only=True, open_world_hint=True),
}

DEPRECATED_ALIAS = "search"
DEPRECATED_READ_ALIASES = ("zotero_collections", "zotero_item")
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


def zotero_library(action: str, key: str = "", query: str = "", limit: int = 25, export_format: str = "csljson") -> dict[str, object]:
    """Read the local Zotero library through its loopback API: `status`, `collections`, `item`, `search`, `fulltext` or `export`. Nothing is written."""
    try:
        if action == "status":
            return research.zotero_library_status(fulltext_probe=query or "zotero")
        if action == "collections":
            return research.list_zotero_collections()
        if action == "item":
            return research.get_zotero_item(key)
        if action == "search":
            return research.search_zotero_items(query, limit)
        if action == "fulltext":
            return research.zotero_fulltext(key=key, query=query)
        if action == "export":
            return research.zotero_export(export_format, limit)
        raise ResearchError("ZOTERO_ACTION_UNSUPPORTED", f"`zotero_library` reads {', '.join(('status', 'collections', 'item', 'search', 'fulltext', 'export'))}. A write is a separate tool, `zotero_write`.")
    except ResearchError as exc:
        return {"readOnly": True, "error": exc.as_dict()}


def zotero_write(action: str, changes: list[dict[str, object]] = [], key: str = "", journal_id: str = "", confirm: str = "") -> dict[str, object]:
    """Write to the local Zotero library. `preview` sends nothing; `apply` needs confirm="write-to-zotero" and takes a library snapshot first; `undo` replays one journal backwards."""
    try:
        if action == "preview":
            return research.zotero_write_preview(changes)
        if action == "snapshot":
            return {"snapshot": zotero_store.write_snapshot(research.zotero_snapshot_document()), "zoteroModified": False}
        if action == "apply":
            if confirm != research.ZOTERO_WRITE_CONFIRM:
                raise ResearchError("WRITE_CONFIRM_REQUIRED", f"A Zotero write needs confirm={research.ZOTERO_WRITE_CONFIRM!r}. Run `preview` first and read what it says you would change.")
            snapshot = zotero_store.write_snapshot(research.zotero_snapshot_document())
            result = research.zotero_write_apply(changes, confirm=confirm)
            journal = zotero_store.write_journal(result["applied"], snapshot=snapshot)
            after = research.zotero_library_status()
            return {**result, "snapshot": snapshot, "journal": journal, "countCheck": zotero_store.count_check(snapshot, after)}
        if action == "undo":
            journal = zotero_store.read_journal(journal_id)
            result = research.zotero_write_undo(journal.get("entries"))
            return {**result, "journalId": journal_id, "snapshot": journal.get("snapshot")}
        raise ResearchError("ZOTERO_WRITE_ACTION_UNSUPPORTED", f"`zotero_write` offers {', '.join(('preview', 'apply', 'snapshot', 'undo'))}. `delete`, `merge` and `duplicate_check` are refused: the local API has no merge endpoint and no restore.")
    except (ResearchError, zotero_store.ResearchError) as exc:
        return {"dryRun": action != "apply", "zoteroModified": False, "error": exc.as_dict()}
    except Exception as exc:  # a workspace path policy error is a refusal the operator has to see as a refusal
        return {"dryRun": action != "apply", "zoteroModified": False, "error": {"code": "ZOTERO_WRITE_REFUSED", "message": f"{type(exc).__name__}: {exc}"}}


def prepare_zotero_import(records: list[dict[str, object]], file_name: str) -> dict[str, object]:
    """Create a new, structurally validated RIS file under research/imports/ for manual Zotero import; no Zotero write occurs."""
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
        check = validate_ris_text(ris, expect=len(records))
        if not check["valid"]:
            return {"error": {"code": "RIS_INVALID", "message": "The RIS this tool would have written fails its own structural check, so it was not written. An HTTP success is not an import result: 61 empty items arrived from one in 14 November 2026.", "evidence": check["problems"][:12], "recordCount": check["recordCount"]}}
        output = resolve_under(root, f"research/imports/{file_name}", must_exist=False)
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(ris)
        return {
            "path": str(output.relative_to(root)),
            "recordCount": len(records),
            "writeMode": "new-file-only",
            "zoteroModified": False,
            "reviewRequired": True,
            "validation": {"recordCount": check["recordCount"], "warnings": check["warnings"][:12]},
        }
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


def zotero_collections() -> dict[str, object]:
    """Deprecated alias for `zotero_library(action="collections")`, registered only for the unmanaged `all` preset."""
    return zotero_library("collections")


def zotero_item(key: str) -> dict[str, object]:
    """Deprecated alias for `zotero_library(action="item")`, registered only for the unmanaged `all` preset."""
    return zotero_library("item", key=key)


RESEARCH_TOOLS = (search_literature, check_citation, zotero_library, zotero_write, prepare_zotero_import)


def main() -> None:
    register_tools(server, RESEARCH_TOOLS, TOOL_TITLES, TOOL_ANNOTATIONS)
    if selected_preset() == DEFAULT_PRESET:
        # Hand-written .mcp.json definitions and 0.3.2 skills still call these names.
        server.tool(title=DEPRECATED_ALIAS_TITLE, annotations=TOOL_ANNOTATIONS["search_literature"])(search)
        server.tool(title="List Zotero collections (deprecated alias for zotero_library)", annotations=TOOL_ANNOTATIONS["zotero_library"])(zotero_collections)
        server.tool(title="Read one Zotero item (deprecated alias for zotero_library)", annotations=TOOL_ANNOTATIONS["zotero_library"])(zotero_item)
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
