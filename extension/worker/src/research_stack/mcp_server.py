"""Local stdio MCP server, rooted in an explicitly configured workspace."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from mcp.server import MCPServer

from .documents import (
    DocumentError,
    extract_document,
    read_document_at_locator,
    read_text_document,
    resolve_evidence,
    validate_sources,
    write_docx_report,
    write_markdown_report,
)
from .full import build_corpus, search_bm25
from .paths import PathPolicyError, resolve_under
from .presets import register_tools
from .tool_meta import TOOL_LIST_CACHE_HINTS, annotations

server = MCPServer("research-stack-basic", cache_hints=TOOL_LIST_CACHE_HINTS)

TOOL_TITLES = {
    "search_local_text": "Search selected workspace notes and documents",
    "read_document": "Read a workspace PDF or DOCX, by range or by a stored locator",
    "read_text_source": "Read a workspace Markdown or text source",
    "write_markdown": "Write a cited Markdown report",
    "write_docx": "Write a cited DOCX report",
}

TOOL_ANNOTATIONS = {
    "read_document": annotations(read_only=True),
    "read_text_source": annotations(read_only=True),
    "search_local_text": annotations(read_only=True),
    "write_docx": annotations(read_only=False, destructive=False, idempotent=False, open_world_hint=False),
    "write_markdown": annotations(read_only=False, destructive=False, idempotent=False, open_world_hint=False),
}


def search_local_text(paths: list[str], query: str, limit: int = 10) -> dict[str, object]:
    """Search explicitly selected workspace Markdown, text, PDF or DOCX files with local BM25 results."""
    chunks = build_corpus(configured_root(), paths)
    return {"hits": [hit.as_dict() for hit in search_bm25(chunks, query, limit=limit)], "method": "bm25", "persistentIndex": False,
            "reopenWith": "read_text_source(path, locator=<hit locator>) for Markdown/text, read_document(path, locator=<hit locator>) for PDF or DOCX"}


def configured_root() -> Path:
    value = os.environ.get("RESEARCH_STACK_WORKSPACE")
    if not value:
        raise ValueError("CONFIG_REQUIRED: set RESEARCH_STACK_WORKSPACE to the selected research workspace.")
    root = Path(value).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("CONFIG_INVALID: configured workspace must be a directory.")
    return root


def read_document(path: str, start: int = 1, count: int = 50, locator: str | None = None, context: int = 1) -> dict[str, object]:
    """Read a selected PDF or DOCX under the configured workspace; returns text, locators and coverage.

    Pass a stored locator (``page=3;chars=120-980`` or ``item=4;kind=table-1-row;chars=0-13``) to
    reopen a search or evidence hit at the unit it came from, with ``context`` neighbouring units.
    """
    source = resolve_under(configured_root(), path, must_exist=True)
    if locator:
        return read_document_at_locator(source, locator, context=context).as_dict()
    return extract_document(source, start=start, count=count).as_dict()


def read_text_source(path: str, start: int = 1, count: int = 20, locator: str | None = None, context: int = 1) -> dict[str, object]:
    """Read a selected Markdown/text file under the workspace, or reopen a search hit by its locator."""
    source = resolve_under(configured_root(), path, must_exist=True)
    return read_text_document(source, start=start, count=count, locator=locator, context=context).as_dict()


def _write_report(root: Path, output_path: str, writer, title: str, body: str, sources: list[dict[str, str]], evidence_chunk_ids: list[str] | None) -> dict[str, str]:
    output = resolve_under(root, output_path, must_exist=False)
    allowed = (root / "outputs").resolve()
    try:
        output.relative_to(allowed)
    except ValueError as exc:
        raise PathPolicyError("OUTPUT_OUTSIDE_APPROVED_ROOT: report writers accept only outputs/ paths.") from exc
    if output.parent.exists():
        from .paths import assert_no_redirect

        assert_no_redirect(root, output)
    if len(body) > 100_000:
        raise DocumentError("BODY_TOO_LARGE: report body limit is 100000 characters.")
    evidence = resolve_evidence(root, list(evidence_chunk_ids or []))
    validated = validate_sources(list(sources or []), root=root)
    return writer(output, title, body, validated, evidence=evidence)


def write_markdown(title: str, body: str, output_path: str, sources: list[dict[str, str]], evidence_chunk_ids: list[str] | None = None) -> dict[str, str]:
    """Create a new Markdown report under outputs/; every citation and stored evidence id is validated first."""
    return _write_report(configured_root(), output_path, write_markdown_report, title, body, sources, evidence_chunk_ids)


def write_docx(title: str, body: str, output_path: str, sources: list[dict[str, str]], evidence_chunk_ids: list[str] | None = None) -> dict[str, str]:
    """Create a new DOCX report under outputs/ with the same validated citations and structure as Markdown."""
    return _write_report(configured_root(), output_path, write_docx_report, title, body, sources, evidence_chunk_ids)


DOCUMENT_TOOLS = (search_local_text, read_document, read_text_source, write_markdown, write_docx)


def main() -> None:
    register_tools(server, DOCUMENT_TOOLS, TOOL_TITLES, TOOL_ANNOTATIONS)
    # MCP SDK routes protocol output through stdio; never print application logs to stdout.
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
