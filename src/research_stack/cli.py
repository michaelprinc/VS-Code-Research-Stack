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
from .workspace import initialize_workspace


def inspect() -> dict[str, object]:
    packages = {}
    for package in ("mcp", "pypdf", "python-docx"):
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="research-stack")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("inspect", help="show redacted host/runtime inventory")
    init = commands.add_parser("init", help="create missing Basic research workspace files")
    init.add_argument("workspace", type=Path)
    recommended = commands.add_parser("add-recommended", help="add the Researcher profile to an existing Basic workspace")
    recommended.add_argument("workspace", type=Path)
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
        elif args.command == "export-bundle":
            result = export_bundle(args.output, args.sources)
        else:
            result = extract_document(args.document, start=args.start, count=args.count).as_dict()
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except (DocumentError, OSError, ValueError) as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
