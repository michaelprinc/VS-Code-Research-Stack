"""Command line entry points for inspection, workspace setup and document tools."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import platform
import shutil
import sys
from pathlib import Path

from . import __version__
from .bundle import export_bundle
from .documents import DocumentError, extract_document
from .recommended import add_recommended_workspace
from .stdio import ensure_utf8_stdio
from .workspace import initialize_workspace, init_lab_workspace


def inspect() -> dict[str, object]:
    packages = {}
    for package in ("mcp", "mcp-types", "pypdf", "python-docx"):
        try:
            packages[package] = importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            packages[package] = None
    return {
        "researchStack": __version__,
        "python": sys.version.split()[0],
        "pythonExecutable": str(Path(sys.executable).resolve()),
        "platform": platform.platform(),
        "architecture": platform.machine(),
        "tools": {"uv": shutil.which("uv"), "git": shutil.which("git"), "code": shutil.which("code")},
        "packages": packages,
        "status": "ready" if all(packages.values()) else "dependencies-missing",
    }


def _workspace_relative(workspace: Path, sources: list[Path]) -> list[str]:
    """Turn selected paths into workspace-relative POSIX paths, refusing anything outside."""
    root = workspace.expanduser().resolve()
    if not root.is_dir():
        raise DocumentError("ROOT_NOT_FOUND: selected workspace is not a directory.")
    relative: list[str] = []
    for source in sources:
        candidate = Path(source).expanduser()
        # A relative source names a file inside the workspace the operator selected, not a file under
        # whatever directory the caller happened to run from. An absolute path is still checked below.
        target = (root / candidate if not candidate.is_absolute() else candidate).resolve()
        try:
            relative.append(target.relative_to(root).as_posix())
        except ValueError as exc:
            raise DocumentError("SOURCE_OUTSIDE_ROOT: every selected source must be inside the workspace.") from exc
    return relative


def index_corpus_cli(workspace: Path, sources: list[Path], *, accept_partial: bool = False) -> dict[str, object]:
    """Index the selected sources into the workspace store. Source files are read only."""
    from .records import index_corpus

    return index_corpus(workspace, _workspace_relative(workspace, sources), accept_partial=accept_partial)


def verify_sources_cli(workspace: Path, sources: list[Path]) -> dict[str, object]:
    """Re-hash the indexed sources, or only the named ones, and record the result."""
    from .records import verify_sources

    return verify_sources(workspace, _workspace_relative(workspace, sources) if sources else None)


def main(argv: list[str] | None = None) -> int:
    # The child inherits the host console code page, not UTF-8, and `-I` ignores
    # PYTHONIOENCODING: state the output encoding here instead (see .stdio).
    ensure_utf8_stdio()
    parser = argparse.ArgumentParser(prog="research-stack")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("inspect", help="show redacted host/runtime inventory")
    init = commands.add_parser("init", help="create missing Basic research workspace files")
    init.add_argument("workspace", type=Path)
    recommended = commands.add_parser("add-recommended", help="add the Researcher profile to an existing Basic workspace")
    recommended.add_argument("workspace", type=Path)
    lab = commands.add_parser("init-lab", help="initialise the workspace corpus index and research record store")
    lab.add_argument("--workspace", type=Path, required=True)
    index = commands.add_parser("index-corpus", help="index selected Markdown/text, PDF or DOCX sources into the workspace store")
    index.add_argument("--workspace", type=Path, required=True)
    index.add_argument("sources", type=Path, nargs="+")
    index.add_argument("--accept-partial", action="store_true", help="accept a source whose extraction was only partial")
    verify = commands.add_parser("verify-sources", help="re-hash the indexed sources and record what the present files are")
    verify.add_argument("--workspace", type=Path, required=True)
    verify.add_argument("sources", type=Path, nargs="*")
    read = commands.add_parser("read", help="extract a bounded range from PDF or DOCX")
    read.add_argument("document", type=Path)
    read.add_argument("--start", type=int, default=1)
    read.add_argument("--count", type=int, default=50)
    bundle = commands.add_parser("export-bundle", help="prepare a manual NotebookLM import folder")
    bundle.add_argument("output", type=Path)
    bundle.add_argument("sources", type=Path, nargs="+")
    args = parser.parse_args(argv)
    try:
        if args.command == "inspect":
            result = inspect()
        elif args.command == "init":
            result = initialize_workspace(args.workspace)
        elif args.command == "add-recommended":
            result = add_recommended_workspace(args.workspace)
        elif args.command == "init-lab":
            result = init_lab_workspace(args.workspace)
        elif args.command == "index-corpus":
            result = index_corpus_cli(args.workspace, args.sources, accept_partial=args.accept_partial)
        elif args.command == "verify-sources":
            result = verify_sources_cli(args.workspace, args.sources)
        elif args.command == "export-bundle":
            result = export_bundle(args.output, args.sources)
        else:
            result = extract_document(args.document, start=args.start, count=args.count).as_dict()
        # `ensure_ascii=True` is the second layer: the receipt this extension parses is pure
        # ASCII bytes, so it stays parseable even on a host whose stream cannot be reconfigured.
        print(json.dumps(result, indent=2, ensure_ascii=True))
        return 0
    except (DocumentError, OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=True), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
