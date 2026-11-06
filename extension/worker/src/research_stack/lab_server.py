"""Corpus index and research record MCP tools for the Full package.

Verbs are separated so a client can gate them by what they actually do:

``index_corpus``      build/refresh the workspace corpus index for selected sources (Markdown/text, PDF, DOCX)
``unindex_corpus``    drop selected sources from the current index (retained evidence stays)
``search_corpus``     BM25 retrieval over the current stored chunks, with provenance
``evidence_read``     resolve chunk ids to source path, locator, text hash and freshness
``verify_sources``    re-hash the indexed sources and record what the present files actually are
``claims_read``       list or read claims with hydrated, freshness-flagged evidence links
``claims_write``      create or patch one claim and reconcile its evidence links
``claims_export``     turn stored claims into validated report references
``store_status``      read the store's inventory, counters and freshness summary
``store_maintenance`` backup, candidate restore and confirmed vacuum

Everything is local to the workspace store under ``.research-toolkit/store/``. Source files
are read only. No vector search, embedding model or third-party database is implied.

A structured failure is returned as ``{"resultState": "error", "error": {"code", "message"}}`` with
the MCP envelope left non-error, exactly as in 0.3.8: the client is meant to read the code, not to
treat a domain refusal as a transport failure.
"""

from __future__ import annotations

import os
from pathlib import Path

from mcp.server import MCPServer

from . import records
from .paths import PathPolicyError
from .presets import register_tools
from .records import StoreError
from .tool_meta import TOOL_LIST_CACHE_HINTS, annotations

server = MCPServer("research-stack-lab", cache_hints=TOOL_LIST_CACHE_HINTS)

TOOL_TITLES = {
    "claims_export": "Export stored claims as validated report references",
    "claims_read": "Read claims and their evidence links",
    "claims_write": "Create or update a claim with evidence links",
    "evidence_read": "Resolve evidence chunk ids to source text and provenance",
    "index_corpus": "Index or re-index selected workspace sources (Markdown, text, PDF, DOCX)",
    "search_corpus": "Search the indexed corpus with provenance",
    "store_maintenance": "Back up, restore or vacuum the research record store",
    "store_status": "Inspect the research record store",
    "unindex_corpus": "Remove selected sources from the current index",
    "verify_sources": "Re-check the indexed sources against the files present now",
}

# Annotations describe the real effect of each verb: reads never write, the removal verb is
# destructive, and the maintenance verb is destructive because restore and vacuum rewrite files.
TOOL_ANNOTATIONS = {
    "claims_export": annotations(read_only=True),
    "claims_read": annotations(read_only=True),
    "claims_write": annotations(read_only=False, destructive=False, idempotent=False, open_world_hint=False),
    "evidence_read": annotations(read_only=True),
    "index_corpus": annotations(read_only=False, destructive=False, idempotent=True, open_world_hint=False),
    "search_corpus": annotations(read_only=True),
    "store_maintenance": annotations(read_only=False, destructive=True, idempotent=False, open_world_hint=False),
    "store_status": annotations(read_only=True),
    "unindex_corpus": annotations(read_only=False, destructive=True, idempotent=True, open_world_hint=False),
    # verify_sources re-reads source files and records the result in the store: it writes the store,
    # never a source, and re-running it is safe.
    "verify_sources": annotations(read_only=False, destructive=False, idempotent=True, open_world_hint=False),
}


def configured_root() -> Path:
    value = os.environ.get("RESEARCH_STACK_WORKSPACE")
    if not value:
        raise StoreError("CONFIG_REQUIRED: set RESEARCH_STACK_WORKSPACE to the selected research workspace.")
    try:
        root = Path(value).expanduser().resolve(strict=True)
    except OSError as exc:
        raise StoreError(f"CONFIG_INVALID: configured workspace is not an existing directory ({exc.strerror or exc}).") from exc
    if not root.is_dir():
        raise StoreError("CONFIG_INVALID: configured workspace must be a directory.")
    return root


def _failure(exc: Exception, **extra: object) -> dict[str, object]:
    if isinstance(exc, StoreError):
        message = str(exc)
        code = message.split(":", 1)[0] if ":" in message else "STORE_ERROR"
    elif isinstance(exc, PathPolicyError):
        message, code = str(exc), str(exc).split(":", 1)[0]
    else:
        # Unexpected internals are reported as a stable, sanitized envelope; the raw exception
        # type is kept only as a category so a stored source text can never leak into the reply.
        message = f"STORE_UNEXPECTED: the store operation failed ({type(exc).__name__}). Inspect store_status before retrying."
        code = "STORE_UNEXPECTED"
    return {"resultState": "error", "error": {"code": code, "message": message}, **extra}


def index_corpus(paths: list[str], mode: str = "index", accept_partial: bool = False) -> dict[str, object]:
    """Index or re-index selected Markdown, text, PDF or DOCX sources; removals belong to unindex_corpus.

    Every selected file is reported individually: ``indexedSources``, ``failedSources`` with its code,
    ``keptPreviousVersion`` for a file whose readable version was left alone, and ``partialSources``
    when ``accept_partial`` was set. A partial or failed read never replaces a good indexed version
    unless the caller asks for it.
    """
    try:
        if mode == "remove":
            return {"resultState": "error", "error": {"code": "INDEX_MODE_REMOVED", "message": "Removing sources is destructive and now has its own verb: call unindex_corpus with the same paths."}}
        if mode not in {"index", "reindex"}:
            raise StoreError("INDEX_MODE: expected index or reindex.")
        return {"mode": mode, **records.index_corpus(configured_root(), paths, accept_partial=accept_partial), "persistentIndex": True}
    except (StoreError, PathPolicyError) as exc:
        return _failure(exc)


def unindex_corpus(paths: list[str]) -> dict[str, object]:
    """Remove selected sources from the current index; evidence a claim still cites is retained."""
    try:
        return {"mode": "remove", **records.remove_sources(configured_root(), paths), "persistentIndex": True}
    except (StoreError, PathPolicyError) as exc:
        return _failure(exc)


def search_corpus(query: str, limit: int = 10) -> dict[str, object]:
    """Search the stored corpus chunks; a score is relevance ranking only, not a truth claim."""
    try:
        hits = records.search_corpus(configured_root(), query, limit=limit)
        return {"hits": [hit.as_dict() for hit in hits], "method": "bm25", "persistentIndex": True, "readOnly": True}
    except (StoreError, PathPolicyError) as exc:
        return _failure(exc, readOnly=True)


def evidence_read(chunk_ids: list[str]) -> dict[str, object]:
    """Resolve chunk ids from search_corpus or claims_read into stored source text and provenance."""
    try:
        resolved = records.get_chunks(configured_root(), chunk_ids)
        requested = list(chunk_ids or [])
        found = {item["chunk_id"] for item in resolved}
        return {
            "readOnly": True,
            "evidence": resolved,
            "unresolved": sorted(set(requested) - found),
            "note": "current=false means the chunk is retained historical evidence, not part of the current index.",
        }
    except (StoreError, PathPolicyError) as exc:
        return _failure(exc, readOnly=True)


def claims_read(limit: int = 50, claim_id: str | None = None, status: str | None = None, cursor: str | None = None) -> dict[str, object]:
    """List stored claims with hydrated evidence links, or read one claim by id."""
    try:
        return {"readOnly": True, **records.read_claims(configured_root(), claim_id=claim_id, limit=limit, status=status, cursor=cursor)}
    except (StoreError, PathPolicyError) as exc:
        return _failure(exc, readOnly=True)


def claims_write(
    statement: str,
    claim_id: str | None = None,
    status: str | None = None,
    note: str | None = None,
    evidence_chunk_ids: list[str] | None = None,
    evidence_role: str = "supporting",
    evidence_rationale: str = "",
    evidence_mode: str = "append",
    idempotency_key: str | None = None,
) -> dict[str, object]:
    """Create a claim or patch one by id; omitted status and note keep their stored values."""
    try:
        return {"writeMode": "create-or-patch", **records.write_claim(
            configured_root(), statement, claim_id=claim_id, status=status, note=note,
            evidence_chunk_ids=evidence_chunk_ids, evidence_role=evidence_role, evidence_rationale=evidence_rationale,
            evidence_mode=evidence_mode, idempotency_key=idempotency_key,
        )}
    except (StoreError, PathPolicyError) as exc:
        return _failure(exc)


def claims_export(claim_ids: list[str], include_stale: bool = False, include_unverified: bool = False) -> dict[str, object]:
    """Resolve stored claims into report-ready references; unresolved evidence is reported, not invented."""
    try:
        return {"readOnly": True, **records.export_claims(configured_root(), claim_ids, include_stale=include_stale, include_unverified=include_unverified)}
    except (StoreError, PathPolicyError) as exc:
        return _failure(exc, readOnly=True)


def verify_sources(paths: list[str] | None = None) -> dict[str, object]:
    """Re-hash the indexed sources against the files present now, and record what each one is.

    This is the verb that may call a source ``verified``. The result separates ``verified``,
    ``changed``, ``missing`` and ``inaccessible``, and counts what is still ``unchecked`` — a source
    nobody has looked at is not a source that is fine.
    """
    try:
        return {"readOnly": False, "writeMode": "store-only", **records.verify_sources(configured_root(), paths), "persistentIndex": True}
    except (StoreError, PathPolicyError) as exc:
        return _failure(exc)


def store_status() -> dict[str, object]:
    """Report the store's schema, inventory, counters and available backups."""
    try:
        return {"readOnly": True, "action": "status", **records.maintenance(configured_root(), "status")}
    except (StoreError, PathPolicyError) as exc:
        return _failure(exc, readOnly=True)


def store_maintenance(action: str = "backup", confirm: bool = False, backup_path: str | None = None) -> dict[str, object]:
    """Create a consistent backup, stage/activate a restore, or vacuum the store after confirmation."""
    try:
        if action == "status":
            return {"readOnly": True, **records.maintenance(configured_root(), "status")}
        return records.maintenance(configured_root(), action, confirm=confirm, backup_path=backup_path)
    except (StoreError, PathPolicyError) as exc:
        return _failure(exc)


def corpus_status(root: Path) -> dict[str, object]:
    """Index state used by setup and the component check; not an MCP tool."""
    return records.index_state(root)


LAB_TOOLS = (claims_export, claims_read, claims_write, evidence_read, index_corpus, search_corpus, store_maintenance, store_status, unindex_corpus, verify_sources)


def main() -> None:
    register_tools(server, LAB_TOOLS, TOOL_TITLES, TOOL_ANNOTATIONS)
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
