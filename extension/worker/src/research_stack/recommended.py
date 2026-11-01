"""Add the Recommended profile to an existing Basic workspace without overwrites."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from . import __version__
from .paths import resolve_under

PROJECT_ROOT = Path(__file__).resolve().parents[2]
OVERLAY_ROOT = PROJECT_ROOT / "templates" / "recommended-overlay"
WORKER_FILES = ("research.py", "recommended_server.py")
OVERLAY_FILES = (
    ".research-toolkit/recommended-profile.json",
    "research/README.md",
    "notebooks/phase-2-metadata-proof.ipynb",
    "notebooks/analysis/.python-version",
    "notebooks/analysis/pyproject.toml",
    "notebooks/analysis/uv.lock",
    ".github/skills/literature-search/SKILL.md",
    ".github/skills/paper-review/SKILL.md",
    ".github/skills/citation-check/SKILL.md",
    ".github/skills/evidence-extraction/SKILL.md",
    ".github/skills/research-summary/SKILL.md",
)


def _merge_json(path: Path, additions: dict[str, object]) -> tuple[list[str], list[str]]:
    created: list[str] = []
    preserved: list[str] = []
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(additions, indent=2) + "\n", encoding="utf-8", newline="\n")
        return [str(path)], preserved
    existing = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(existing, dict):
        raise ValueError(f"CONFIG_INVALID: {path.name} must contain a JSON object; it was not changed.")
    before = json.dumps(existing, sort_keys=True)
    for key, value in additions.items():
        if key not in existing:
            existing[key] = value
        elif key == "recommendations" and isinstance(existing[key], list) and isinstance(value, list):
            existing[key] = list(dict.fromkeys([*existing[key], *value]))
        elif key == "mcpServers" and isinstance(existing[key], dict) and isinstance(value, dict):
            for server_id, server in value.items():
                if server_id not in existing[key]:
                    existing[key][server_id] = server
                else:
                    preserved.append(f"{path.name}:mcpServers.{server_id}")
        else:
            preserved.append(f"{path.name}:{key}")
    if json.dumps(existing, sort_keys=True) != before:
        path.write_text(json.dumps(existing, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
        created.append(str(path))
    return created, preserved


def _merge_ignore_line(path: Path, line: str) -> tuple[list[str], list[str]]:
    if not path.exists():
        path.write_text(f"{line}\n", encoding="utf-8", newline="\n")
        return [str(path)], []
    content = path.read_text(encoding="utf-8")
    if line in {part.strip() for part in content.splitlines()}:
        return [], [f"{path.name}:{line}"]
    separator = "" if not content or content.endswith(("\n", "\r")) else "\n"
    path.write_text(content + separator + line + "\n", encoding="utf-8", newline="\n")
    return [str(path)], []


def add_recommended_workspace(target: Path) -> dict[str, object]:
    root = target.expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("WORKSPACE_INVALID: select an existing Basic workspace directory.")
    basic_profile = root / ".research-toolkit" / "profile.json"
    if not basic_profile.is_file():
        raise ValueError("BASIC_PROFILE_REQUIRED: run `research-stack init` first; Recommended extends rather than replaces Basic.")
    profile = json.loads(basic_profile.read_text(encoding="utf-8"))
    if profile.get("id") != "basic":
        raise ValueError("BASIC_PROFILE_REQUIRED: the selected workspace profile is not Research Starter / Basic.")

    worker = resolve_under(root, ".research-toolkit/worker/src/research_stack", must_exist=True)
    if not worker.is_dir():
        raise ValueError("BASIC_WORKER_REQUIRED: initialize the Basic workspace before adding Recommended.")
    # Fail before creating any files if existing configuration is malformed.
    for relative in (".mcp.json", ".vscode/extensions.json"):
        path = resolve_under(root, relative, must_exist=False)
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                raise ValueError(f"CONFIG_INVALID: {relative} is not valid JSON; it was not changed.") from exc
            if not isinstance(data, dict):
                raise ValueError(f"CONFIG_INVALID: {relative} must contain a JSON object; it was not changed.")
            key = "mcpServers" if relative == ".mcp.json" else "recommendations"
            expected = dict if key == "mcpServers" else list
            if key in data and not isinstance(data[key], expected):
                raise ValueError(f"CONFIG_INVALID: {relative}:{key} has an unexpected type; it was not changed.")

    created: list[str] = []
    preserved: list[str] = []
    for relative in OVERLAY_FILES:
        source = OVERLAY_ROOT / relative
        destination = resolve_under(root, relative, must_exist=False)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists():
            preserved.append(relative)
        else:
            shutil.copyfile(source, destination)
            created.append(relative)

    for name in WORKER_FILES:
        destination = resolve_under(root, f".research-toolkit/worker/src/research_stack/{name}", must_exist=False)
        if destination.exists():
            preserved.append(str(destination.relative_to(root)))
        else:
            shutil.copyfile(PROJECT_ROOT / "src" / "research_stack" / name, destination)
            created.append(str(destination.relative_to(root)))

    server_fragment = json.loads((PROJECT_ROOT / "templates" / "optional" / "recommended-mcp.json").read_text(encoding="utf-8"))
    mcp_server = server_fragment.get("mcpServers", {})
    mcp_created, mcp_preserved = _merge_json(resolve_under(root, ".mcp.json", must_exist=False), {"mcpServers": mcp_server})
    created.extend([str(Path(p).relative_to(root)) for p in mcp_created])
    preserved.extend(mcp_preserved)

    ext_created, ext_preserved = _merge_json(resolve_under(root, ".vscode/extensions.json", must_exist=False), {"recommendations": ["ms-python.python", "ms-toolsai.jupyter"]})
    created.extend([str(Path(p).relative_to(root)) for p in ext_created])
    preserved.extend(ext_preserved)
    ignore_created, ignore_preserved = _merge_ignore_line(resolve_under(root, ".gitignore", must_exist=False), "notebooks/analysis/.venv/")
    created.extend([str(Path(p).relative_to(root)) for p in ignore_created])
    preserved.extend(ignore_preserved)
    return {"workspace": str(root), "profile": "recommended", "created": created, "preserved": preserved, "note": f"Research Stack {__version__}; credentials remain external to workspace files; Zotero access is loopback read-only and import is manual."}
