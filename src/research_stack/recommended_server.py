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


def zotero_library(action: str, key: str = "", query: str = "", limit: int = 25, export_format: str = "csljson", collection_key: str = "") -> dict[str, object]:
    """Read the local Zotero library through its loopback API: `status`, `collections`, `collection_items`, `item`, `search`, `fulltext` or `export`. Nothing is written."""
    try:
        if action == "status":
            return research.zotero_library_status(fulltext_probe=query or "zotero")
        if action == "collections":
            return research.list_zotero_collections()
        if action == "collection_items":
            # The only read that answers membership: `GET /items?collection=<key>` is ignored by the local API
            # and answers with the whole library (measured 19 November 2026, P5).
            return research.zotero_collection_items(key, limit)
        if action in research.ZOTERO_UNSUPPORTED_LIBRARY_ACTIONS:
            return research.zotero_collection_tags(key)
        if action == "item":
            return research.get_zotero_item(key)
        if action == "search":
            return research.search_zotero_items(query, limit)
        if action == "fulltext":
            return research.zotero_fulltext(key=key, query=query)
        if action == "export":
            return research.zotero_export(export_format, limit, collection_key)
        raise ResearchError("ZOTERO_ACTION_UNSUPPORTED", f"`zotero_library` reads {', '.join(research.ZOTERO_LIBRARY_ACTIONS)}. A write is a separate tool, `zotero_write`.")
    except ResearchError as exc:
        return {"readOnly": True, "error": exc.as_dict()}


def zotero_write(action: str, changes: list[dict[str, object]] = [], key: str = "", journal_id: str = "", confirm: str = "", resume_after: int = 0, allow_journal_truncation: bool = False) -> dict[str, object]:
    """Write to the local Zotero library. `preview` sends nothing; `apply` needs confirm="write-to-zotero", takes a library snapshot first and re-reads every collection it touched; `undo` replays one journal backwards."""
    try:
        if action == "preview":
            preview = research.zotero_write_preview(changes)
            return {**preview, "journalFit": zotero_store.journal_capacity_check(preview["planned"])}
        if action == "snapshot":
            return {"snapshot": zotero_store.write_snapshot(research.zotero_snapshot_document()), "zoteroModified": False}
        if action == "apply":
            if confirm != research.ZOTERO_WRITE_CONFIRM:
                raise ResearchError("WRITE_CONFIRM_REQUIRED", f"A Zotero write needs confirm={research.ZOTERO_WRITE_CONFIRM!r}. Run `preview` first and read what it says you would change.")
            blocked = zotero_store.read_write_block()
            if blocked:
                if blocked.get("corrupt"):
                    # A marker that cannot be read is not the absence of a marker. Something stopped a write in
                    # this workspace and the Toolkit can no longer say what; that is a reason to refuse, not a
                    # reason to carry on as if the library were clean.
                    raise ResearchError("ZOTERO_WRITE_BLOCK_UNREADABLE", "A blocked-write marker is in this workspace and cannot be read, so the Toolkit cannot say which write it stopped. No write is sent. `zotero_write(action=\"snapshot\")` reads the library again and replaces the marker, which is what clears it.", report=blocked)
                raise ResearchError("ZOTERO_WRITE_BLOCKED", f"The last Zotero write in this workspace stopped on {blocked.get('code')}: {blocked.get('condition')}. Its version guards no longer describe this library, so no write is sent until the library is read again: `zotero_write(action=\"snapshot\")`, then `preview`, then `apply`.", report=blocked)
            plan = research.zotero_write_preview(changes)["planned"]
            fit = zotero_store.journal_capacity_check(plan)
            if not fit["fits"] and not allow_journal_truncation:
                raise ResearchError("ZOTERO_JOURNAL_TOO_SMALL", f"Nothing was written. One journal cannot hold all {fit['entries']} operations of this write: it would need {fit['bytesNeeded']} bytes and the cap is {fit['maxBytes']}. Split the write into smaller previews, or pass allow_journal_truncation=true to accept a journal that names what it left out.", evidence=fit["note"])
            snapshot = zotero_store.write_snapshot(research.zotero_snapshot_document())
            try:
                result = research.zotero_write_apply(changes, confirm=confirm, resume_after=resume_after)
            except ResearchError as exc:
                report = exc.report or {}
                blocked: dict[str, object] = {}
                if report.get("blocked"):
                    blocked = {**report["blocked"], "marked": zotero_store.mark_write_blocked(code=exc.code, condition=str(report["blocked"].get("condition")), detail={"stoppedAtIndex": report.get("stoppedAtIndex"), "appliedCount": len(report.get("applied") or []), "snapshot": snapshot.get("path")})}
                # A batch that stopped partway is reported item by item: what arrived, what did not, and the
                # next batch `resume_after` would run. Erasing that because the write ended in a refusal would
                # leave the operator to guess which of their 43 items are in the collection now.
                # An interrupted write still gets the membership comparison, when the collections it named could
                # be read back at all. Review 2 (22 November 2026) named the gap: the receipt carried
                # `collectionState` with no `collectionCheck`, so the operator saw numbers and no verdict.
                interrupted_keys = sorted({str(entry.get("collectionKey")) for entry in (report.get("applied") or []) if isinstance(entry, dict) and entry.get("collectionKey")})
                interrupted_checks: dict[str, object] = {}
                if interrupted_keys:
                    interrupted_checks["collectionCheck"] = zotero_store.collection_check(snapshot, {
                        "applied": report.get("applied") or [],
                        "collectionKeys": interrupted_keys,
                        "collectionState": report.get("collectionState") or [],
                        "createdKeys": report.get("createdKeys") or [],
                    })
                    if report.get("collectionStateNote"):
                        interrupted_checks["collectionCheckNote"] = report["collectionStateNote"]
                return {
                    "dryRun": False,
                    "zoteroModified": bool(report.get("applied")),
                    "snapshot": snapshot,
                    "applied": report.get("applied") or [],
                    "notApplied": report.get("notApplied") or [],
                    "nextBatch": report.get("nextBatch"),
                    "createdKeys": report.get("createdKeys") or [],
                    "serverFailures": report.get("serverFailures") or [],
                    "libraryVersion": report.get("libraryVersion"),
                    "collectionState": report.get("collectionState"),
                    **interrupted_checks,
                    "blocked": blocked or None,
                    "error": exc.as_dict(),
                }
            journal = zotero_store.write_journal(result["applied"], snapshot=snapshot)
            after = research.zotero_library_status()
            checks: dict[str, object] = {"countCheck": zotero_store.count_check(snapshot, after)}
            if result["collectionKeys"]:
                checks["collectionCheck"] = zotero_store.collection_check(snapshot, result)
            else:
                checks["collectionCheck"] = {"checkedKeys": [], "consistent": False, "mismatch": False, "note": "No step of this write named a collection, so membership was not checked."}
            return {**result, **checks, "snapshot": snapshot, "journal": journal, "journalFit": fit}
        if action == "undo":
            journal = zotero_store.read_journal(journal_id)
            result = research.zotero_write_undo(journal.get("entries"))
            return {**result, "journalId": journal_id, "snapshot": journal.get("snapshot"), "journalUndoComplete": journal.get("undoComplete", True)}
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
