"""Shared tool metadata for the Research Stack MCP servers.

Two things every shipped tool needs, per the October 2026 client guidance:

* behaviour annotations (``readOnlyHint`` / ``destructiveHint`` / ``idempotentHint``) so
  clients can display and gate read versus write tools, and
* a ``tools/list`` freshness hint so a client can cache a stable tool list instead of
  re-reading it for every request.

Annotations are hints for the client's approval UI. They are never a security control:
the toolkit's own guarantees come from the path policy and the write-mode rules.
"""

from __future__ import annotations

from mcp.server import CacheHint
from mcp_types import ToolAnnotations

TOOL_LIST_CACHE_HINTS = {"tools/list": CacheHint(ttl_ms=300_000, scope="private")}


def annotations(*, read_only: bool, destructive: bool = False, idempotent: bool = True, open_world_hint: bool = False) -> ToolAnnotations:
    """Build one behaviour annotation set for a toolkit tool.

    ``open_world_hint`` is True only for tools that reach outside the workspace (scholarly
    providers, the local Zotero API). Everything else stays closed-world so a client can tell
    which approvals involve an external service.
    """
    return ToolAnnotations(
        read_only_hint=read_only,
        destructive_hint=destructive,
        idempotent_hint=idempotent,
        open_world_hint=open_world_hint,
    )
