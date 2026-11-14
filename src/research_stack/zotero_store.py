"""Workspace-side Zotero safety files: the snapshot a write is checked against, and the undo journal.

No network here. The library is read by `research.py` through the local API; this module only writes what
that read produced into the workspace, under the same containment policy every other Toolkit write uses.
A snapshot is not a copy of `zotero.sqlite` (DD12-02, DD14-05): it is what the Toolkit read through the
same API that will write, and therefore the only thing it can honestly compare a write against.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .paths import contained_write_path, resolve_under
from .research import ResearchError

SNAPSHOT_DIRECTORY = ".research-toolkit/zotero-snapshots"
JOURNAL_DIRECTORY = ".research-toolkit/zotero-journal"
# One journal per applied write. The cap is what a journal is allowed to cost in the workspace, and a
# journal that would exceed it says so instead of silently dropping the entries an operator would need.
JOURNAL_MAX_BYTES = 4096
JOURNAL_ID_PATTERN = re.compile(r"^\d{8}T\d{6}Z-[a-z0-9]{6}$")


def workspace_root() -> Path:
    value = os.environ.get("RESEARCH_STACK_WORKSPACE")
    if not value:
        raise ResearchError("CONFIG_REQUIRED", "Set RESEARCH_STACK_WORKSPACE to the selected workspace.")
    root = Path(value).expanduser().resolve(strict=False)
    if not root.is_dir():
        raise ResearchError("CONFIG_INVALID", "Configured research workspace must be a directory.")
    return root


def _stamp(now: datetime | None = None) -> str:
    moment = (now or datetime.now(UTC)).astimezone(UTC)
    return moment.strftime("%Y%m%dT%H%M%SZ")


def write_snapshot(document: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """Write one library snapshot as a new file. An existing snapshot is never overwritten."""
    root = workspace_root()
    name = f"{_stamp(now)}.json"
    target = contained_write_path(root, f"{SNAPSHOT_DIRECTORY}/{name}", must_exist=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps(document, ensure_ascii=False, sort_keys=True)
    try:
        with target.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(body)
    except FileExistsError:
        raise ResearchError("ZOTERO_SNAPSHOT_EXISTS", "A snapshot was already taken this second. Wait a second and try again.") from None
    return {
        "path": str(target.relative_to(root)),
        "bytes": len(body.encode("utf-8")),
        "itemCount": document.get("itemCount"),
        "totalResults": document.get("totalResults"),
        "truncated": document.get("truncated"),
        "collectionCount": len(document.get("collections") or []),
        "tagCount": len(document.get("tags") or []),
    }


def write_journal(applied: list[dict[str, Any]], *, snapshot: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """Record what a write changed, with the value each field had before it."""
    root = workspace_root()
    moment = _stamp(now)
    digest = hashlib.sha256(json.dumps(applied, sort_keys=True).encode("utf-8")).hexdigest()[:6]
    journal_id = f"{moment}-{digest}"
    entries = [
        {
            "op": entry.get("op"),
            "key": entry.get("key"),
            "undoable": bool(entry.get("undoable")),
            "before": entry.get("before") or {},
            "changedFields": entry.get("changedFields") or [],
        }
        for entry in applied
    ]
    kept: list[dict[str, Any]] = []
    dropped = 0
    for entry in entries:
        candidate = kept + [entry]
        if len(json.dumps({"entries": candidate}, ensure_ascii=False).encode("utf-8")) > JOURNAL_MAX_BYTES:
            dropped += 1
            continue
        kept.append(entry)
    body = json.dumps({"journalId": journal_id, "takenAt": moment, "snapshot": snapshot.get("path"), "entries": kept}, ensure_ascii=False, sort_keys=True)
    target = contained_write_path(root, f"{JOURNAL_DIRECTORY}/{journal_id}.json", must_exist=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(body)
    return {
        "journalId": journal_id,
        "path": str(target.relative_to(root)),
        "bytes": len(body.encode("utf-8")),
        "entries": len(kept),
        "droppedEntries": dropped,
        "truncated": bool(dropped),
    }


def read_journal(journal_id: str) -> dict[str, Any]:
    """Read one journal back, refusing an id that is not a journal id."""
    root = workspace_root()
    if not JOURNAL_ID_PATTERN.fullmatch(journal_id or ""):
        raise ResearchError("ZOTERO_JOURNAL_ID_INVALID", "An undo needs the journalId a write reported, in the form 20261114T120000Z-ab12cd.")
    target = resolve_under(root, f"{JOURNAL_DIRECTORY}/{journal_id}.json", must_exist=True)
    try:
        document = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ResearchError("ZOTERO_JOURNAL_UNREADABLE", f"The journal {journal_id} could not be read: {exc}") from exc
    if not isinstance(document, dict) or not isinstance(document.get("entries"), list):
        raise ResearchError("ZOTERO_JOURNAL_UNREADABLE", f"The journal {journal_id} is not a Toolkit Zotero journal.")
    return document


def count_check(snapshot: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """Compare the library before and after a write. A 200 or 204 is not treated as proof (DD14-11)."""
    before = snapshot.get("totalResults")
    after_total = after.get("counts", {}).get("items")
    return {
        "before": before,
        "after": after_total,
        "serverId": after.get("serverId"),
        "consistent": before is not None and after_total is not None,
        "note": "The count Zotero reported before the write and after it. A difference the write did not explain is a defect in the write, not a rounding.",
    }
