"""Idempotent workspace bootstrap from versioned, platform-neutral templates."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from . import __version__
from .paths import contained_write_path
from .records import init_store

TEMPLATE_ROOT = Path(__file__).resolve().parents[2] / "templates" / "basic-workspace"


def initialize_workspace(target: Path) -> dict[str, object]:
    target = target.expanduser().resolve()
    target.mkdir(parents=True, exist_ok=True)
    managed: list[str] = []
    preserved: list[str] = []
    for relative in ("papers/.gitkeep", "notes/.gitkeep", "outputs/.gitkeep", "research/evidence/.gitkeep"):
        dest = contained_write_path(target, relative)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest = contained_write_path(target, relative)
        if not dest.exists():
            dest.write_text("", encoding="utf-8")
            managed.append(relative)
    for relative in ("AGENTS.md", ".github/copilot-instructions.md", ".github/skills/research-basic/SKILL.md", ".github/skills/document-review/SKILL.md", ".gitignore", ".vscode/extensions.json", ".research-toolkit/profile.json"):
        src = TEMPLATE_ROOT / relative
        dest = contained_write_path(target, relative)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest = contained_write_path(target, relative)
        if dest.exists():
            preserved.append(relative)
        else:
            shutil.copyfile(src, dest)
            managed.append(relative)
    worker_root = contained_write_path(target, ".research-toolkit/worker")
    worker_root.mkdir(parents=True, exist_ok=True)
    worker_root = contained_write_path(target, ".research-toolkit/worker")
    project_root = Path(__file__).resolve().parents[2]
    for relative in ("pyproject.toml", "uv.lock", ".python-version", "README.md"):
        source, destination = project_root / relative, contained_write_path(target, f".research-toolkit/worker/{relative}")
        if source.exists() and not destination.exists():
            shutil.copyfile(source, destination)
            managed.append(str(destination.relative_to(target)))
    package_source = project_root / "src" / "research_stack"
    package_target = contained_write_path(target, ".research-toolkit/worker/src/research_stack")
    if not package_target.exists():
        shutil.copytree(package_source, package_target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        managed.append(".research-toolkit/worker/src/research_stack")
    mcp_config = contained_write_path(target, ".mcp.json")
    if not mcp_config.exists():
        shutil.copyfile(TEMPLATE_ROOT / ".mcp.json", mcp_config)
        managed.append(".mcp.json")
    else:
        preserved.append(".mcp.json")
    profile_path = contained_write_path(target, ".research-toolkit/profile.json")
    profile = json.loads(profile_path.read_text(encoding="utf-8"))
    profile.setdefault("workspaceId", target.name)
    profile["initializedBy"] = f"research-stack-basic/{__version__}"
    profile_path.write_text(json.dumps(profile, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {"workspace": str(target), "created": managed, "preserved": preserved}


def init_lab_workspace(target: Path) -> dict[str, object]:
    """Initialise the Full-package workspace store and write an honest lab-state record.

    The shipped Full slice has no HTTP index service, so it does not write a
    ``full-profile.json`` instance claiming a loopback endpoint. The lab-state file
    records only what actually exists in this workspace.
    """
    target = target.expanduser().resolve()
    if not target.is_dir():
        raise ValueError("WORKSPACE_NOT_FOUND: select an existing research workspace directory.")
    store = init_store(target)
    state_path = contained_write_path(target, ".research-toolkit/lab-state.json")
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path = contained_write_path(target, ".research-toolkit/lab-state.json")
    state = {
        "schemaVersion": 1,
        "profileId": "full",
        "toolkitVersion": __version__,
        "storePath": ".research-toolkit/store/research.sqlite3",
        "storeSchemaVersion": store["schemaVersion"],
        "tables": store["tables"],
        "counts": store["counts"],
        "preexisting": store["preexisting"],
        "initialisedAt": store.get("createdAt"),
        "serviceMode": "local-stdio",
        "vectorSearch": "not-implemented",
        "externalDatabases": "not-installed",
    }
    state_path.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return {
        "ok": True,
        "workspace": str(target),
        "store": store["store"],
        "schemaVersion": store["schemaVersion"],
        "tableCount": store["tableCount"],
        "tables": store["tables"],
        "counts": store["counts"],
        "preexisting": store["preexisting"],
        "profile": str(state_path),
    }
