"""Idempotent workspace bootstrap from versioned, platform-neutral templates."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from . import __version__

TEMPLATE_ROOT = Path(__file__).resolve().parents[2] / "templates" / "basic-workspace"


def initialize_workspace(target: Path) -> dict[str, object]:
    target = target.expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    managed: list[str] = []
    preserved: list[str] = []
    for relative in ("papers/.gitkeep", "notes/.gitkeep", "outputs/.gitkeep", "research/evidence/.gitkeep"):
        dest = target / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            dest.write_text("", encoding="utf-8")
            managed.append(relative)
    for relative in ("AGENTS.md", ".github/copilot-instructions.md", ".github/skills/research-basic/SKILL.md", ".github/skills/document-review/SKILL.md", ".gitignore", ".vscode/extensions.json", ".research-toolkit/profile.json"):
        src, dest = TEMPLATE_ROOT / relative, target / relative
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            preserved.append(relative)
        else:
            shutil.copyfile(src, dest)
            managed.append(relative)
    worker_root = target / ".research-toolkit" / "worker"
    worker_root.mkdir(parents=True, exist_ok=True)
    project_root = Path(__file__).resolve().parents[2]
    for relative in ("pyproject.toml", "uv.lock", ".python-version", "README.md"):
        source, destination = project_root / relative, worker_root / relative
        if source.exists() and not destination.exists():
            shutil.copyfile(source, destination)
            managed.append(str(destination.relative_to(target)))
    package_source = project_root / "src" / "research_stack"
    package_target = worker_root / "src" / "research_stack"
    if not package_target.exists():
        shutil.copytree(package_source, package_target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        managed.append(".research-toolkit/worker/src/research_stack")
    mcp_config = target / ".mcp.json"
    if not mcp_config.exists():
        shutil.copyfile(TEMPLATE_ROOT / ".mcp.json", mcp_config)
        managed.append(".mcp.json")
    else:
        preserved.append(".mcp.json")
    profile_path = target / ".research-toolkit/profile.json"
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    profile.setdefault("workspaceId", target.name)
    profile["initializedBy"] = f"research-stack-basic/{__version__}"
    profile_path.write_text(json.dumps(profile, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"workspace": str(target), "created": managed, "preserved": preserved}
