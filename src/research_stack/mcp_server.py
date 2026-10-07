"""Local stdio MCP server, rooted in an explicitly configured workspace."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from mcp.server import MCPServer

from .documents import DocumentError, extract_document, write_docx_report, write_markdown_report
from .paths import PathPolicyError, resolve_under

server = MCPServer("research-stack-basic")


def configured_root() -> Path:
    value = os.environ.get("RESEARCH_STACK_WORKSPACE")
    if not value:
        raise ValueError("CONFIG_REQUIRED: set RESEARCH_STACK_WORKSPACE to the selected research workspace.")
    root = Path(value).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("CONFIG_INVALID: configured workspace must be a directory.")
    return root


@server.tool()
def read_document(path: str, start: int = 1, count: int = 50) -> dict[str, object]:
    """Read a selected PDF or DOCX under the configured workspace; returns text and page/paragraph locators."""
    source = resolve_under(configured_root(), path, must_exist=True)
    return extract_document(source, start=start, count=count).as_dict()


@server.tool()
def write_markdown(title: str, body: str, output_path: str, sources: list[dict[str, str]]) -> dict[str, str]:
    """Create a new Markdown report under outputs/ and cite each source with its locator/reference and SHA-256."""
    root = configured_root()
    output = resolve_under(root, output_path, must_exist=False)
    allowed = (root / "outputs").resolve()
    try:
        output.relative_to(allowed)
    except ValueError as exc:
        raise PathPolicyError("OUTPUT_OUTSIDE_APPROVED_ROOT: write_markdown accepts only outputs/ paths.") from exc
    if len(body) > 100_000:
        raise DocumentError("BODY_TOO_LARGE: report body limit is 100000 characters.")
    if len(sources) > 100:
        raise DocumentError("TOO_MANY_SOURCES: maximum is 100 citations.")
    for source in sources:
        if not {"label", "reference", "sha256"}.issubset(source):
            raise DocumentError("INVALID_SOURCE: each source requires label, reference and sha256.")
    return write_markdown_report(output, title, body, sources)


@server.tool()
def write_docx(title: str, body: str, output_path: str, sources: list[dict[str, str]]) -> dict[str, str]:
    """Create a new DOCX report under outputs/ with source references; existing files are never overwritten."""
    root = configured_root()
    output = resolve_under(root, output_path, must_exist=False)
    allowed = (root / "outputs").resolve()
    try:
        output.relative_to(allowed)
    except ValueError as exc:
        raise PathPolicyError("OUTPUT_OUTSIDE_APPROVED_ROOT: write_docx accepts only outputs/ paths.") from exc
    if len(body) > 100_000:
        raise DocumentError("BODY_TOO_LARGE: report body limit is 100000 characters.")
    if len(sources) > 100:
        raise DocumentError("TOO_MANY_SOURCES: maximum is 100 citations.")
    for source in sources:
        if not {"label", "reference", "sha256"}.issubset(source):
            raise DocumentError("INVALID_SOURCE: each source requires label, reference and sha256.")
    return write_docx_report(output, title, body, sources)


def main() -> None:
    # MCP SDK routes protocol output through stdio; never print application logs to stdout.
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
