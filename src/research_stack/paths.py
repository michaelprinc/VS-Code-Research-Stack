"""Workspace-root checks shared by the CLI and MCP server."""

from __future__ import annotations

from pathlib import Path


class PathPolicyError(ValueError):
    pass


def resolve_under(root: Path, relative_path: str, *, must_exist: bool = True) -> Path:
    """Resolve a workspace-relative path and reject absolute/traversal/symlink escapes."""
    root = root.expanduser().resolve(strict=True)
    supplied = Path(relative_path)
    if supplied.is_absolute() or supplied.drive:
        raise PathPolicyError("PATH_OUTSIDE_WORKSPACE: provide a workspace-relative path.")
    candidate = (root / supplied).resolve(strict=must_exist)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise PathPolicyError("PATH_OUTSIDE_WORKSPACE: resolved path leaves the configured workspace.") from exc
    return candidate
