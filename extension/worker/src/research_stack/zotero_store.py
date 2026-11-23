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
# 0.3.15 raised it from 4096 to 65 536 (defect D8): the filing the operator ran on 19 November 2026 (P9) was
# 43 operations, and at 4 096 bytes a journal of that write drops most of its entries — which is a silent
# loss of the undo, because the operator cannot put back what the journal forgot to record.
JOURNAL_MAX_BYTES = 65_536
JOURNAL_ID_PATTERN = re.compile(r"^\d{8}T\d{6}Z-[a-z0-9]{6}$")
# The marker a write that raced the library leaves behind (defect D3 / interruption reporting). It sits in the
# journal directory under a name `JOURNAL_ID_PATTERN` cannot match, so it can never be read as a journal or
# undone as one; it is cleared by the act that unblocks the write, which is a fresh snapshot.
BLOCKED_WRITE_FILE = f"{JOURNAL_DIRECTORY}/blocked-write.json"
# The snapshot record is returned as the tool result, so the collection baseline it carries is bounded. A
# library with more collections than this is reported as a partial census (`baselineTruncated`), and a
# comparison against a collection outside the bound says so instead of reading it as an empty before-side.
SNAPSHOT_BASELINE_MAX_COLLECTIONS = 200


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


def collection_baseline(document: dict[str, Any]) -> dict[str, Any]:
    """The before-side of a membership comparison, read out of the snapshot document itself.

    `write_snapshot` answers with a summary, not with the library it stored. A check that took its before-side
    from that summary would be comparing against an empty library — every collection would look new
    (`existedBefore: false`), every `membersBefore` would read 0, and a filing that landed nowhere would be
    reported as consistent (found in review, 22 November 2026). So the summary carries the collection facts the
    snapshot really read: each collection's own `numItems`, and how many snapshot items listed it among their
    `data.collections` — the same fact `GET /collections/<key>/items` answers after the write (P5).

    Child notes are not counted as members (P5: 43 items arrived as 93 records). A truncated item read is
    recorded as truncated instead of being presented as the library's membership.
    """
    members: dict[str, int] = {}
    items_read = 0
    for row in document.get("items") or []:
        if not isinstance(row, dict) or not isinstance(row.get("data"), dict):
            continue
        items_read += 1
        if str(row["data"].get("itemType")) == "note" or row["data"].get("parentItem"):
            continue  # P5: a note travels with its parent; counting it as a member inflates the comparison
        for key in (row["data"].get("collections") or []):
            members[str(key)] = members.get(str(key), 0) + 1
    baseline: dict[str, dict[str, Any]] = {}
    for row in document.get("collections") or []:
        if not isinstance(row, dict) or not row.get("key"):
            continue
        key = str(row["key"])
        baseline[key] = {"key": key, "name": row.get("name"), "path": row.get("path"), "numItems": row.get("numItems"), "members": members.get(key, 0)}
    # An item can name a collection the listing did not answer. The membership still happened, so it belongs in
    # the before-side; `collection_check` then reports it as a collection the listing did not show.
    for key, count in members.items():
        baseline.setdefault(key, {"key": key, "name": None, "path": None, "numItems": None, "members": count})
    return {
        "collections": {key: baseline[key] for key in sorted(baseline)},
        "collectionCount": len(baseline),
        "itemsRead": items_read,
        "truncated": bool(document.get("truncated")),
    }


def write_snapshot(document: dict[str, Any], *, now: datetime | None = None) -> dict[str, Any]:
    """Write one library snapshot as a new file. An existing snapshot is never overwritten.

    Taking a snapshot is also the act that clears a blocked write: a block says "the version this write was
    built from is not the library's version", and the only honest way to lift it is to read the library again.
    """
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
    baseline = collection_baseline(document)
    if len(baseline["collections"]) > SNAPSHOT_BASELINE_MAX_COLLECTIONS:
        # The snapshot record is returned to the operator as the tool result, so the baseline is bounded. A
        # collection outside the bound is not silently missing: `baselineTruncated` says the census is partial,
        # and `collection_check` refuses to call such a comparison clean.
        kept = sorted(baseline["collections"])[:SNAPSHOT_BASELINE_MAX_COLLECTIONS]
        baseline = {**baseline, "collections": {key: baseline["collections"][key] for key in kept}, "baselineTruncated": True}
    return {
        "path": str(target.relative_to(root)),
        "bytes": len(body.encode("utf-8")),
        "itemCount": document.get("itemCount"),
        "totalResults": document.get("totalResults"),
        "truncated": document.get("truncated"),
        "collectionCount": len(document.get("collections") or []),
        "tagCount": len(document.get("tags") or []),
        "libraryVersion": document.get("libraryVersion"),
        "blockCleared": clear_write_block(),
        # The before-side `collection_check` compares against. It is in the record rather than re-derived from
        # the counts above, because the counts above say nothing about membership (review defect, 22 November 2026).
        "baseline": baseline,
    }


def _journal_entries(applied: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The journal shape: what to undo, and the value each field had before it."""
    return [
        {
            "op": entry.get("op"),
            "key": entry.get("key"),
            "undoable": bool(entry.get("undoable")),
            "before": entry.get("before") or {},
            "changedFields": entry.get("changedFields") or [],
            **({"undoReason": entry["undoReason"]} if entry.get("undoReason") else {}),
            **({"collectionKey": entry["collectionKey"]} if entry.get("collectionKey") else {}),
        }
        for entry in applied
    ]


# The journal is a file, not only a list of entries: `journalId`, `takenAt` and `snapshot` are written with it.
# Measuring the entries alone let a journal that "fit" land above the cap (reviewed defect, 22 November 2026:
# cap 7 960, reported `fits: true` and `dropped 0`, file written at 8 053 bytes). These stand-ins have the shape
# of the real values so the pre-write measurement counts the same bytes the write will produce.
JOURNAL_ID_STANDIN = "20261119T100000Z-abcdef"
JOURNAL_TAKEN_AT_STANDIN = "20261119T100000Z"
JOURNAL_SNAPSHOT_PATH_STANDIN = f"{SNAPSHOT_DIRECTORY}/20261119T100000Z.json"


def _journal_body(*, journal_id: str, taken_at: str, snapshot_path: str, entries: list[dict[str, Any]]) -> str:
    """The journal exactly as it will be written, so its size is measured and not estimated."""
    return json.dumps({"journalId": journal_id, "takenAt": taken_at, "snapshot": snapshot_path, "entries": entries}, ensure_ascii=False, sort_keys=True)


def journal_capacity_check(applied: list[dict[str, Any]], *, snapshot_path: str = JOURNAL_SNAPSHOT_PATH_STANDIN) -> dict[str, Any]:
    """Say before the write starts whether one journal can hold every operation it would record (defect D8).

    Refusing a write before it happens is the useful half of the rule; `write_journal` is the honest half that
    comes after a write has already happened, where throwing the journal away would be worse than writing a
    journal that says what it could not keep.
    """
    entries = _journal_entries(applied)
    needed = len(_journal_body(journal_id=JOURNAL_ID_STANDIN, taken_at=JOURNAL_TAKEN_AT_STANDIN, snapshot_path=snapshot_path, entries=entries).encode("utf-8"))
    undoable = sum(1 for entry in entries if entry["undoable"])
    return {
        "entries": len(entries),
        "undoableEntries": undoable,
        "bytesNeeded": needed,
        "maxBytes": JOURNAL_MAX_BYTES,
        "fits": needed <= JOURNAL_MAX_BYTES,
        "note": "This is the size of the whole journal file these operations would produce, wrapper included (`journalId`, `takenAt`, `snapshot`). When it does not fit, `apply` is refused before anything is sent, unless the operator accepts an incomplete journal with `allow_journal_truncation`.",
    }


def write_journal(applied: list[dict[str, Any]], *, snapshot: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
    """Record what a write changed, with the value each field had before it.

    An entry that will not fit is named, counted and reported as an incomplete undo (`droppedEntries`,
    `undoComplete: false`) rather than lost quietly. `apply` is meant to refuse such a write before it starts;
    this function runs after the library already changed, and the least dishonest thing it can do there is
    write the journal it can and say which entries it left out.
    """
    root = workspace_root()
    moment = _stamp(now)
    digest = hashlib.sha256(json.dumps(applied, sort_keys=True).encode("utf-8")).hexdigest()[:6]
    journal_id = f"{moment}-{digest}"
    entries = _journal_entries(applied)
    kept: list[dict[str, Any]] = []
    dropped = 0
    for entry in entries:
        candidate = kept + [entry]
        # The size measured is the size of the file, wrapper included — the same call `write_journal` writes
        # with. Measuring only the entries is what let a journal report `fits: true` and land over the cap.
        if len(_journal_body(journal_id=journal_id, taken_at=moment, snapshot_path=str(snapshot.get("path") or ""), entries=candidate).encode("utf-8")) > JOURNAL_MAX_BYTES:
            dropped += 1
            continue
        kept.append(entry)
    body = _journal_body(journal_id=journal_id, taken_at=moment, snapshot_path=str(snapshot.get("path") or ""), entries=kept)
    target = contained_write_path(root, f"{JOURNAL_DIRECTORY}/{journal_id}.json", must_exist=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(body)
    record = {
        "journalId": journal_id,
        "path": str(target.relative_to(root)),
        "bytes": len(body.encode("utf-8")),
        "maxBytes": JOURNAL_MAX_BYTES,
        "entries": len(kept),
        "entriesTotal": len(entries),
        "droppedEntries": dropped,
        "truncated": bool(dropped),
        "undoComplete": dropped == 0,
    }
    if dropped:
        record["warning"] = f"{dropped} of {len(entries)} operations are not in this journal, so `undo` cannot put them back. The snapshot is the only record of what they changed."
    return record


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


def _count(value: Any) -> int | None:
    """Read a Zotero count — a header string or a number — as a number, or say it was not one."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def count_check(snapshot: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    """Compare the library before and after a write, and say plainly when the two do not agree.

    Defect D3: 0.3.13 documented this as a comparison and then set `consistent` to "both numbers were
    readable", which reported a 1 → 43 jump as consistent. That is the opposite of DD14-11: a 200 or a 204 is
    not proof, and neither is a number that moved without the write explaining it. A difference is now
    reported as a difference (`mismatch: true`, with the size of it), and it stays a report rather than an
    error because a library count can move for reasons outside this write — which is exactly why
    `collection_check` exists next to it.
    """
    before = snapshot.get("totalResults")
    after_total = (after.get("counts") or {}).get("items")
    before_n, after_n = _count(before), _count(after_total)
    readable = before_n is not None and after_n is not None
    mismatch = readable and before_n != after_n
    truncated = bool(snapshot.get("truncated"))
    return {
        "before": before,
        "after": after_total,
        "serverId": after.get("serverId"),
        "readable": readable,
        "consistent": readable and not mismatch,
        "mismatch": mismatch,
        "difference": (after_n - before_n) if readable else None,
        "snapshotTruncated": truncated,
        "note": (
            "The count Zotero reported before the write and after it. The two disagree, and this write did not explain the difference."
            if mismatch else
            "The count Zotero reported before the write and after it. It did not move — which a filing does not: filing changes membership, not the number of items (measured 19 November 2026, P9). `collectionCheck` is what proves a filing."
            if readable else
            "One of the two counts could not be read, so no comparison was made. That is not a clean result."
        ),
    }


def collection_check(snapshot: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
    """Prove a filing by membership, not by a status code (DD14-11, defect D3).

    For every collection key the write named, two things are compared with what the snapshot read before the
    write: the collection's own `numItems`, and the items whose `data.collections` carry that key. The second
    is the decisive one — `numItems` is a number Zotero reports about a collection, while the membership list
    is the fact the operator asked for, and P5 measured `GET /collections/<key>/items` to be the only path
    that answers it (`GET /items?collection=<key>` is ignored). An item-count comparison cannot prove any of
    this: the 43-item filing of 19 November 2026 (P9) left the library holding the same 43 items it held
    before, and moved only membership.
    """
    applied = [entry for entry in (result.get("applied") or []) if isinstance(entry, dict)]
    keys = {str(key) for key in (result.get("collectionKeys") or []) if key}
    keys |= {str(entry["collectionKey"]) for entry in applied if entry.get("collectionKey")}
    state = {str(entry.get("key")): entry for entry in (result.get("collectionState") or []) if isinstance(entry, dict)}
    created = {str(key) for key in (result.get("createdKeys") or []) if key}
    filed_per_key: dict[str, int] = {}
    for entry in applied:
        key = entry.get("collectionKey")
        if key and entry.get("op") == "add_to_collection" and entry.get("request") is not False:
            filed_per_key[str(key)] = filed_per_key.get(str(key), 0) + 1

    # The before-side has to come from what the snapshot read, not from the short record `write_snapshot`
    # answered with. A missing baseline is stated as a gap, never filled in with zeros (review defect).
    baseline = snapshot.get("baseline") if isinstance(snapshot.get("baseline"), dict) else None
    baseline_source = "snapshot"
    if baseline is None and (snapshot.get("items") or snapshot.get("collections")):
        baseline, baseline_source = collection_baseline(snapshot), "snapshot document"
    if baseline is None:
        baseline_source = "missing"
    baseline_collections = {str(row.get("key")): row for row in (baseline or {}).get("collections", {}).values() if isinstance(row, dict)} if baseline else {}
    baseline_gap: str | None = None
    if baseline_source == "missing":
        baseline_gap = "this write was not checked against a snapshot baseline, so there is no before-side to compare against and nothing here is proven"
    elif baseline.get("truncated"):
        baseline_gap = f"the snapshot's item read stopped at {baseline.get('itemsRead')} items, so the members it listed are a lower bound rather than the collection's membership"
    elif baseline.get("baselineTruncated"):
        baseline_gap = f"the snapshot recorded a collection baseline for {baseline.get('collectionCount')} collections and stopped there, so a collection outside it has no known before-side"

    checked: list[dict[str, Any]] = []
    for key in sorted(keys):
        before_row = baseline_collections.get(key)
        after = state.get(key)
        members_before = before_row.get("members") if before_row is not None else None
        filed = filed_per_key.get(key, 0)
        record: dict[str, Any] = {
            "key": key,
            "name": (before_row or {}).get("name") or (after or {}).get("name"),
            "path": (after or {}).get("path") or (before_row or {}).get("path"),
            "existedBefore": before_row is not None,
            "numItemsBefore": (before_row or {}).get("numItems"),
            "numItemsAfter": (after or {}).get("numItems"),
            "membersBefore": members_before,
            "membersAfter": (after or {}).get("memberCount"),
            "recordsReadAfter": (after or {}).get("recordsRead"),
            "notesIncludedAfter": (after or {}).get("notesIncluded"),
            "filedOperations": filed,
        }
        reasons: list[str] = []
        if baseline_gap:
            reasons.append(baseline_gap)
        if after is None:
            reasons.append("the collection was not read back after the write, so nothing about it is proven")
        else:
            members_after = after.get("memberCount")
            if filed and members_after is None:
                reasons.append(f"{filed} filing operation(s) were sent and the membership path reported no member count afterwards")
            elif filed and members_before is not None and members_after is not None and members_after == members_before:
                reasons.append(f"{filed} filing operation(s) answered 204 and no member arrived: {key} held {members_before} members before the write and {members_after} after it")
            elif filed and members_before is not None and members_after is not None and members_after < members_before:
                reasons.append("fewer members are listed than before the write")
            elif filed and members_before is None and key not in created:
                reasons.append("the snapshot did not list this collection before the write, so the filing has no before-side to be proven against")
            num_items_after = _count(after.get("numItems"))
            if num_items_after is not None and members_after is not None and num_items_after != members_after:
                reasons.append(f"Zotero's own numItems ({num_items_after}) and the members the membership path reported ({members_after}) disagree")
        record["mismatch"] = bool(reasons)
        if reasons:
            record["reason"] = "; ".join(reasons)
        checked.append(record)
    any_mismatch = any(record["mismatch"] for record in checked)
    return {
        "collections": checked,
        "checkedKeys": sorted(keys),
        "baselineSource": baseline_source,
        "baselineCollectionCount": (baseline or {}).get("collectionCount"),
        "baselineItemsRead": (baseline or {}).get("itemsRead"),
        "mismatch": any_mismatch,
        "consistent": bool(keys) and baseline is not None and baseline_gap is None and not any_mismatch,
        "note": "Membership, read from `GET /collections/<key>/items` (P5), compared with what the snapshot read before the write. A 200 or 204 on a filing request is not in this comparison at all (DD14-11)." if keys else "No step of this write named a collection, so there was nothing to compare.",
    }


def mark_write_blocked(*, code: str, condition: str, detail: dict[str, Any] | None = None) -> dict[str, Any]:
    """Record that the last write raced the library, so the next apply is refused until the library is re-read."""
    root = workspace_root()
    target = contained_write_path(root, BLOCKED_WRITE_FILE, must_exist=False)
    target.parent.mkdir(parents=True, exist_ok=True)
    record = {"markedAt": _stamp(), "code": code, "condition": condition, **(detail or {})}
    target.write_text(json.dumps(record, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    return record


def read_write_block() -> dict[str, Any] | None:
    """The block this workspace is carrying, or None when it is not carrying one.

    A marker that is there but cannot be read is reported as a corrupt block, not as no block. It says a write
    stopped in this workspace and the Toolkit can no longer say which one; answering `None` would let the next
    write go ahead on the strength of a fact the workspace no longer holds (defect, 22 November 2026).
    """
    root = workspace_root()
    try:
        target = resolve_under(root, BLOCKED_WRITE_FILE, must_exist=True)
    except (OSError, ValueError):
        return None
    until = "run `zotero_write(action=\"snapshot\")`, which reads the library again and replaces this marker"
    try:
        document = json.loads(target.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"corrupt": True, "code": "ZOTERO_WRITE_BLOCK_UNREADABLE", "condition": f"the blocked-write marker is here and could not be read ({exc.__class__.__name__})", "until": until}
    if not isinstance(document, dict):
        return {"corrupt": True, "code": "ZOTERO_WRITE_BLOCK_UNREADABLE", "condition": "the blocked-write marker is here but is not a Toolkit record", "until": until}
    return document


def clear_write_block() -> bool:
    """True when a blocked-write marker was here and is gone now. A snapshot is what calls this."""
    root = workspace_root()
    try:
        target = resolve_under(root, BLOCKED_WRITE_FILE, must_exist=True)
    except (OSError, ValueError):
        return False
    try:
        target.unlink()
    except OSError:
        return False
    return True
