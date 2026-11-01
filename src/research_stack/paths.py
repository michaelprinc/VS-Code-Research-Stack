"""Workspace-root and containment checks shared by the CLI, MCP servers and the record store.

One policy guards every toolkit-owned write: the path must be workspace-relative, must not
traverse out of the root, and no component between the root and the target may be a symlink,
a Windows junction or another reparse point. The check runs when the path is planned and
again immediately before the write.
"""

from __future__ import annotations

import os
from pathlib import Path, PurePosixPath, PureWindowsPath

MAX_ANCESTOR_DEPTH = 64


class PathPolicyError(ValueError):
    pass


def is_redirect(path: Path) -> bool:
    """True when this exact path is a symlink, a Windows junction or another reparse point."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    if os.path.islink(path):
        return True
    is_junction = getattr(os.path, "isjunction", None)
    if is_junction is not None and is_junction(str(path)):
        return True
    return bool(getattr(info, "st_reparse_tag", 0))


def assert_relative(relative_path: str) -> PurePosixPath:
    """Reject absolute paths, drive letters, roots and traversal before anything touches the disk."""
    if not isinstance(relative_path, str) or not relative_path.strip():
        raise PathPolicyError("PATH_INVALID: provide a non-empty workspace-relative path.")
    candidate = PurePosixPath(relative_path.replace("\\", "/"))
    windows = PureWindowsPath(relative_path)
    if candidate.is_absolute() or windows.is_absolute() or windows.drive or windows.root:
        raise PathPolicyError("PATH_OUTSIDE_WORKSPACE: provide a workspace-relative path.")
    if ".." in candidate.parts or "." in candidate.parts:
        raise PathPolicyError("PATH_OUTSIDE_WORKSPACE: '..' and '.' segments are not accepted; select the file directly.")
    if len(candidate.parts) > MAX_ANCESTOR_DEPTH:
        raise PathPolicyError("PATH_TOO_DEEP: workspace-relative paths are bounded.")
    return candidate


def assert_no_redirect(root: Path, target: Path) -> Path:
    """Refuse a target that leaves the root or is reached through a link, junction or reparse point."""
    try:
        relative = target.relative_to(root)
    except ValueError as exc:
        raise PathPolicyError("PATH_OUTSIDE_WORKSPACE: resolved path leaves the configured workspace.") from exc
    current = root
    for part in relative.parts:
        current = current / part
        if is_redirect(current):
            raise PathPolicyError(
                f"PATH_IS_LINK: {current} is a link or junction. Toolkit writes stay in real workspace paths; "
                "replace it with a real directory or choose another location."
            )
    real_root = os.path.realpath(root)
    real_target = os.path.realpath(target)
    if real_target != real_root and not real_target.startswith(real_root + os.sep):
        raise PathPolicyError("PATH_OUTSIDE_WORKSPACE: resolved path leaves the configured workspace.")
    return target


def contained_write_path(root: Path, relative_path: str, *, must_exist: bool = False) -> Path:
    """Resolve a workspace-relative write target and refuse links on the way to it."""
    root = Path(root).expanduser().resolve(strict=True)
    candidate = assert_relative(relative_path)
    target = root / Path(*candidate.parts)
    assert_no_redirect(root, target)
    if must_exist and not target.exists():
        raise PathPolicyError("PATH_NOT_FOUND: the selected path does not exist inside the workspace.")
    return target


def resolve_under(root: Path, relative_path: str, *, must_exist: bool = True) -> Path:
    """Resolve a workspace-relative read path and reject absolute/traversal/escaping paths."""
    root = root.expanduser().resolve(strict=True)
    candidate = assert_relative(relative_path)
    target = root / Path(*candidate.parts)
    resolved = target.resolve(strict=must_exist)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise PathPolicyError("PATH_OUTSIDE_WORKSPACE: resolved path leaves the configured workspace.") from exc
    return resolved
