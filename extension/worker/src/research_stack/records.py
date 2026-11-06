"""Local SQLite record store for the Full package: corpus index, claims and evidence.

The store is a workspace file under ``.research-toolkit/store/``. It uses only the Python
standard library, so installing the Full package adds no third-party database. It is not a
backup system and it never touches research source files: sources are read, hashed and
chunked, and only the store file is written.

Schema version 2 separates three things that version 1 conflated:

* the **current index inventory** (``sources``, one row per selected path, even when that
  path currently produces no chunks),
* **immutable evidence** (``chunks`` rows are per source occurrence and are retained while a
  claim still references them; ``current`` marks live index membership only), and
* **recorded assessments** (``claims`` plus ``claim_events`` history; a ``supported`` status is
  what the researcher recorded, never proof supplied by the database).

Schema version 3 adds what 0.3.9 needs and changes nothing that version 2 already stated:

* **what a source is** (``kind``, ``unit``, ``parser_id``, unit counts, warnings and the ingestion
  ``outcome``), so a PDF, a DOCX and a Markdown note are distinguishable in the store;
* **whether the present file was actually checked** (``verification`` plus ``last_verified_at``),
  which is a different fact from "this version is in the index" — ``unchecked`` is never reported
  as ``verified``;
* **structured locators** (``unit_kind``, ``unit_index``, ``char_start``, ``char_end``) beside the
  existing locator text, so a PDF page or a DOCX table row is queryable and reopenable; and
* **one row per ingestion run** (``index_runs``), so a mixed batch that indexed nine files and
  refused one is a fact the store can still report afterwards.

A migrated row is labelled ``legacy``/``unchecked`` rather than back-filled: 0.3.8 did not record
coverage or a hash check, and inventing one would be a false claim about the past.
"""

from __future__ import annotations

import hashlib
import json
import os
import secrets
import sqlite3
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from .paths import PathPolicyError, assert_no_redirect, is_redirect

STORE_DIRECTORY = ".research-toolkit/store"
STORE_NAME = "research.sqlite3"
BACKUP_DIRECTORY = "backups"
RESTORE_PREFIX = "research-restore-"
PRE_RESTORE_PREFIX = "research-pre-restore-"
SCHEMA_VERSION = 3
SUPPORTED_SCHEMA_VERSIONS = (1, 2, 3)

MAX_INDEX_SOURCES = 1000
MAX_STORE_CHUNKS = 20000
MAX_CLAIMS = 2000
MAX_STATEMENT_CHARS = 2000
MAX_NOTE_CHARS = 4000
MAX_EVIDENCE_LINKS = 200
MAX_CLAIM_PAGE = 200
MAX_RATIONALE_CHARS = 1000

SOURCE_KINDS = ("text", "pdf", "docx")
INGESTION_OUTCOMES = ("complete", "partial", "failed", "legacy")
VERIFICATION_STATES = ("verified", "changed", "missing", "inaccessible", "unchecked")
RUN_STATUSES = ("complete", "partial", "failed", "cancelled")

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_versions (
    source_sha256 TEXT PRIMARY KEY,
    bytes INTEGER NOT NULL,
    first_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
    path TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    chunk_count INTEGER NOT NULL,
    indexed_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'text',
    unit TEXT NOT NULL DEFAULT 'paragraph',
    parser_id TEXT NOT NULL DEFAULT '',
    units_total INTEGER NOT NULL DEFAULT 0,
    units_extracted INTEGER NOT NULL DEFAULT 0,
    empty_units TEXT NOT NULL DEFAULT '[]',
    warnings TEXT NOT NULL DEFAULT '[]',
    outcome TEXT NOT NULL DEFAULT 'legacy',
    verification TEXT NOT NULL DEFAULT 'unchecked',
    last_verified_at TEXT
);
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    source_sha256 TEXT NOT NULL,
    locator TEXT NOT NULL,
    text TEXT NOT NULL,
    text_sha256 TEXT NOT NULL,
    chunker_id TEXT NOT NULL,
    chars INTEGER NOT NULL,
    current INTEGER NOT NULL DEFAULT 1,
    indexed_at TEXT NOT NULL,
    unit_kind TEXT NOT NULL DEFAULT 'paragraph',
    unit_index INTEGER NOT NULL DEFAULT 0,
    char_start INTEGER NOT NULL DEFAULT -1,
    char_end INTEGER NOT NULL DEFAULT -1
);
CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks (source_path);
CREATE INDEX IF NOT EXISTS chunks_current_idx ON chunks (current);
CREATE INDEX IF NOT EXISTS chunks_content_idx ON chunks (content_id);
CREATE INDEX IF NOT EXISTS chunks_unit_idx ON chunks (source_path, unit_index);
CREATE TABLE IF NOT EXISTS claims (
    claim_id TEXT PRIMARY KEY,
    statement TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS claims_idempotency_idx ON claims (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS claim_evidence (
    claim_id TEXT NOT NULL,
    chunk_id TEXT NOT NULL,
    locator TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'supporting',
    rationale TEXT NOT NULL DEFAULT '',
    added_at TEXT NOT NULL,
    PRIMARY KEY (claim_id, chunk_id)
);
CREATE TABLE IF NOT EXISTS claim_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS index_runs (
    run_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    mode TEXT NOT NULL,
    source_count INTEGER NOT NULL DEFAULT 0,
    chunk_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    accepted_partial INTEGER NOT NULL DEFAULT 0,
    detail TEXT NOT NULL DEFAULT ''
);
"""

CLAIM_STATUSES = ("open", "supported", "contested", "rejected", "closed")
EVIDENCE_ROLES = ("supporting", "contradicting", "contextual")
EVIDENCE_MODES = ("append", "replace", "remove")

ASSESSMENT_NOTE = (
    "Claim status is a recorded assessment made by the researcher. The store does not verify "
    "that a source supports a claim; check each link's resolvable and current flags."
)


class StoreError(ValueError):
    """An actionable error from the workspace record store."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _translate(exc: sqlite3.Error) -> StoreError:
    text = str(exc)
    lowered = text.lower()
    if isinstance(exc, sqlite3.IntegrityError):
        return StoreError(f"STORE_CONSTRAINT: the store rejected this write ({text}).")
    if "locked" in lowered or "busy" in lowered:
        return StoreError("STORE_BUSY: another process is writing the store. Wait for it to finish, then retry.")
    if "corrupt" in lowered or "malformed" in lowered or "disk image" in lowered or "not a database" in lowered:
        return StoreError("STORE_CORRUPT: the store could not be read. Restore a verified backup; do not edit the file.")
    return StoreError(f"STORE_ERROR: the store operation failed ({type(exc).__name__}).")


def _prototype_error(exc: Exception) -> StoreError:
    from .full import FullPrototypeError

    if isinstance(exc, FullPrototypeError):
        return StoreError(str(exc))
    if isinstance(exc, PathPolicyError):
        return StoreError(str(exc))
    return _translate(exc) if isinstance(exc, sqlite3.Error) else StoreError(str(exc))


def store_path(root: Path) -> Path:
    """Workspace-relative store path, refused when any component is a link or junction."""
    root_path = Path(root).expanduser().resolve(strict=True)
    target = root_path / STORE_DIRECTORY / STORE_NAME
    try:
        assert_no_redirect(root_path, target.parent)
    except PathPolicyError as exc:
        raise StoreError(str(exc)) from exc
    if target.parent.exists() and not target.parent.is_dir():
        raise StoreError("STORE_PATH_INVALID: the store path must be a directory.")
    if is_redirect(target):
        raise StoreError(f"PATH_IS_LINK: {target} is a link or junction; replace it with a real file before using the store.")
    if target.exists() and not target.is_file():
        raise StoreError("STORE_PATH_INVALID: the store file must be a regular file.")
    return target


def _store_directory(root: Path) -> Path:
    root_path = Path(root).expanduser().resolve(strict=True)
    directory = root_path / STORE_DIRECTORY
    try:
        assert_no_redirect(root_path, directory)
    except PathPolicyError as exc:
        raise StoreError(str(exc)) from exc
    if directory.exists() and not directory.is_dir():
        raise StoreError("STORE_PATH_INVALID: the store path must be a directory.")
    if is_redirect(directory):  # pragma: no cover - defensive, assert_no_redirect already covers it
        raise StoreError("PATH_IS_LINK: the store directory is a link or junction.")
    return directory


def _backup_directory(root: Path) -> Path:
    directory = _store_directory(root) / BACKUP_DIRECTORY
    try:
        assert_no_redirect(Path(root).expanduser().resolve(strict=True), directory)
    except PathPolicyError as exc:
        raise StoreError(str(exc)) from exc
    if directory.exists() and not directory.is_dir():
        raise StoreError("STORE_PATH_INVALID: the backup path must be a directory.")
    return directory


def _read_only_uri(path: Path) -> str:
    return "file:" + urllib.parse.quote(str(path), safe="/~") + "?mode=ro"


def _read_schema_version(connection: sqlite3.Connection) -> int | None:
    tables = {row["name"] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    if "meta" not in tables:
        return None
    row = connection.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
    if row is None:
        return None
    try:
        return int(row["value"])
    except (TypeError, ValueError):
        return None


def _table_names(connection: sqlite3.Connection) -> set[str]:
    return {row["name"] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}


def _validate_or_migrate(connection: sqlite3.Connection, *, existed_before: bool) -> int:
    """Check the recorded schema before mutating anything, then migrate a supported older store."""
    version = _read_schema_version(connection)
    if version is None:
        if existed_before:
            raise StoreError("STORE_SCHEMA_UNKNOWN: this store has no recorded schema version. Restore a verified backup or start a new store.")
        connection.executescript(SCHEMA)
        connection.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
        connection.execute("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)", (_now(),))
        connection.commit()
        return SCHEMA_VERSION
    if version > SCHEMA_VERSION:
        raise StoreError(f"STORE_SCHEMA_UNSUPPORTED: this store records schema version {version}; toolkit {_toolkit_version()} supports up to {SCHEMA_VERSION}. No migration was attempted and nothing was changed.")
    if version == SCHEMA_VERSION:
        return version
    if version not in SUPPORTED_SCHEMA_VERSIONS:
        raise StoreError(f"STORE_SCHEMA_UNSUPPORTED: schema version {version} has no reviewed migration.")
    _migrate_to_current(connection, version)
    return SCHEMA_VERSION


def _toolkit_version() -> str:
    from . import __version__

    return __version__


def _migrate_to_current(connection: sqlite3.Connection, from_version: int) -> None:
    """Reviewed migrations: 1 → 2 (durable evidence), 2 → 3 (document provenance and freshness).

    Additive only. No table is rebuilt and no stored chunk row is rewritten: a chunk id is a hash of
    its content, so rewriting a row would stale every claim that cites it.
    """
    if from_version >= SCHEMA_VERSION:
        return
    if from_version == 1:
        _migrate_1_to_2(connection)
    _migrate_2_to_3(connection)
    connection.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
    connection.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_from', ?)", (str(from_version),))
    connection.commit()


def _migrate_1_to_2(connection: sqlite3.Connection) -> None:
    """Version 1 → 2: add the columns the durable-evidence model needs."""
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(chunks)")}
    if "content_id" not in columns:
        connection.execute("ALTER TABLE chunks ADD COLUMN content_id TEXT NOT NULL DEFAULT ''")
    if "current" not in columns:
        connection.execute("ALTER TABLE chunks ADD COLUMN current INTEGER NOT NULL DEFAULT 1")
    rows = connection.execute("SELECT chunk_id, source_sha256, locator, text_sha256, chunker_id FROM chunks").fetchall()
    for row in rows:
        from .full import _canonical_id

        content_id = _canonical_id((row["source_sha256"], row["chunker_id"], row["locator"], row["text_sha256"]))
        connection.execute("UPDATE chunks SET content_id = ? WHERE chunk_id = ?", (content_id, row["chunk_id"]))
    claim_columns = {row["name"] for row in connection.execute("PRAGMA table_info(claims)")}
    if "idempotency_key" not in claim_columns:
        connection.execute("ALTER TABLE claims ADD COLUMN idempotency_key TEXT")
    evidence_columns = {row["name"] for row in connection.execute("PRAGMA table_info(claim_evidence)")}
    if "role" not in evidence_columns:
        connection.execute("ALTER TABLE claim_evidence ADD COLUMN role TEXT NOT NULL DEFAULT 'supporting'")
    if "rationale" not in evidence_columns:
        connection.execute("ALTER TABLE claim_evidence ADD COLUMN rationale TEXT NOT NULL DEFAULT ''")
    connection.executescript(SCHEMA)
    stamp = _now()
    for row in connection.execute("SELECT DISTINCT source_sha256 FROM chunks").fetchall():
        connection.execute("INSERT OR IGNORE INTO source_versions (source_sha256, bytes, first_seen_at) VALUES (?, ?, ?)", (row["source_sha256"], 0, stamp))
    for row in connection.execute("SELECT path, source_sha256 FROM sources").fetchall() if "sources" in _table_names(connection) else []:
        connection.execute("INSERT OR IGNORE INTO source_versions (source_sha256, bytes, first_seen_at) VALUES (?, ?, ?)", (row["source_sha256"], 0, stamp))


def _migrate_2_to_3(connection: sqlite3.Connection) -> None:
    """Version 2 → 3: document provenance, structured locators, freshness and one row per run.

    A migrated source row lands on ``outcome = 'legacy'`` and ``verification = 'unchecked'``. That is
    the honest value: 0.3.8 recorded no coverage and never re-checked a present hash, and a default
    that read like a real measurement would be a claim the store cannot support.
    """
    source_additions = {
        "kind": "TEXT NOT NULL DEFAULT 'text'",
        "unit": "TEXT NOT NULL DEFAULT 'paragraph'",
        "parser_id": "TEXT NOT NULL DEFAULT ''",
        "units_total": "INTEGER NOT NULL DEFAULT 0",
        "units_extracted": "INTEGER NOT NULL DEFAULT 0",
        "empty_units": "TEXT NOT NULL DEFAULT '[]'",
        "warnings": "TEXT NOT NULL DEFAULT '[]'",
        "outcome": "TEXT NOT NULL DEFAULT 'legacy'",
        "verification": "TEXT NOT NULL DEFAULT 'unchecked'",
        "last_verified_at": "TEXT",
    }
    columns = {row["name"] for row in connection.execute("PRAGMA table_info(sources)")}
    for name, definition in source_additions.items():
        if name not in columns:
            connection.execute(f"ALTER TABLE sources ADD COLUMN {name} {definition}")
    chunk_additions = {
        "unit_kind": "TEXT NOT NULL DEFAULT 'paragraph'",
        "unit_index": "INTEGER NOT NULL DEFAULT 0",
        "char_start": "INTEGER NOT NULL DEFAULT -1",
        "char_end": "INTEGER NOT NULL DEFAULT -1",
    }
    chunk_columns = {row["name"] for row in connection.execute("PRAGMA table_info(chunks)")}
    for name, definition in chunk_additions.items():
        if name not in chunk_columns:
            connection.execute(f"ALTER TABLE chunks ADD COLUMN {name} {definition}")
    connection.executescript(SCHEMA)


def _connect(root: Path, *, create: bool = False) -> sqlite3.Connection:
    """Open the store. Writes validate the schema first; reads open the file read-only."""
    path = store_path(root)
    if not create:
        if not path.is_file():
            raise StoreError("STORE_MISSING: run the corpus index and record store step, or index_corpus, before reading the store.")
        try:
            connection = sqlite3.connect(_read_only_uri(path), uri=True)
            connection.row_factory = sqlite3.Row
            version = _read_schema_version(connection)
        except sqlite3.Error as exc:
            raise _translate(exc) from exc
        if version is None:
            connection.close()
            raise StoreError("STORE_SCHEMA_UNKNOWN: this store has no recorded schema version. Restore a verified backup or re-run the store step.")
        if version > SCHEMA_VERSION:
            connection.close()
            raise StoreError(f"STORE_SCHEMA_UNSUPPORTED: this store records schema version {version}; this toolkit supports up to {SCHEMA_VERSION}.")
        if version < SCHEMA_VERSION:
            connection.close()
            raise StoreError(f"STORE_SCHEMA_UPGRADE_REQUIRED: schema version {version} must be migrated before reading. Run the corpus index and record store component step.")
        return connection
    directory = path.parent
    directory.mkdir(parents=True, exist_ok=True)
    try:
        assert_no_redirect(Path(root).expanduser().resolve(strict=True), directory)
    except PathPolicyError as exc:
        connection.close()
        raise StoreError(str(exc)) from exc
    existed_before = path.is_file() and path.stat().st_size > 0
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        _validate_or_migrate(connection, existed_before=existed_before)
    except StoreError:
        connection.close()
        raise
    return connection


def init_store(root: Path) -> dict[str, object]:
    """Create the store file and schema without replacing an existing store or its schema version."""
    path = store_path(root)
    existed = path.is_file()
    connection = _connect(root, create=True)
    try:
        tables = sorted(name for name in _table_names(connection) if not name.startswith("sqlite_"))
        counts = {table: connection.execute(f"SELECT COUNT(*) AS n FROM {table}").fetchone()["n"] for table in ("sources", "chunks", "claims", "claim_evidence", "index_runs")}
        connection.commit()
    finally:
        connection.close()
    return {
        "ok": True,
        "store": str(path),
        "schemaVersion": SCHEMA_VERSION,
        "tableCount": len(tables),
        "tables": tables,
        "counts": counts,
        "preexisting": existed,
        "contains": "Stored chunk text and your claims; source files are read only. Backups copy this material.",
        "writeMode": "create-or-open; existing rows and the recorded schema version are never replaced by initialisation",
    }


def _fingerprint(sources: list[tuple[str, str]]) -> str:
    packed = json.dumps(sorted(sources), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(packed).hexdigest()


def _collect_retired(connection: sqlite3.Connection, paths: set[str]) -> int:
    """Delete retired chunks for these paths only when no claim still references them."""
    if not paths:
        return 0
    placeholders = ",".join("?" for _ in paths)
    rows = connection.execute(
        f"SELECT chunk_id FROM chunks WHERE current = 0 AND source_path IN ({placeholders}) "
        "AND chunk_id NOT IN (SELECT chunk_id FROM claim_evidence)",
        tuple(paths),
    ).fetchall()
    for row in rows:
        connection.execute("DELETE FROM chunks WHERE chunk_id = ?", (row["chunk_id"],))
    return len(rows)


def _retained_count(connection: sqlite3.Connection, paths: set[str]) -> int:
    if not paths:
        return 0
    placeholders = ",".join("?" for _ in paths)
    return connection.execute(
        f"SELECT COUNT(*) AS n FROM chunks WHERE current = 0 AND source_path IN ({placeholders})",
        tuple(paths),
    ).fetchone()["n"]


def remove_sources(root: Path, relative_paths: list[str]) -> dict[str, object]:
    """Drop the selected sources from the current index; evidence a claim still cites is retained."""
    if not relative_paths or len(relative_paths) > MAX_INDEX_SOURCES:
        raise StoreError(f"SOURCE_COUNT: remove 1..{MAX_INDEX_SOURCES} explicit files per call.")
    connection = _connect(root, create=True)
    try:
        removed: list[str] = []
        affected: set[str] = set()
        for path in relative_paths:
            existing = connection.execute("SELECT path FROM sources WHERE path = ?", (path,)).fetchone()
            if existing is None:
                continue
            connection.execute("UPDATE chunks SET current = 0 WHERE source_path = ?", (path,))
            affected.add(path)
            connection.execute("DELETE FROM sources WHERE path = ?", (path,))
            removed.append(path)
        retained = _retained_count(connection, affected)
        collected = _collect_retired(connection, affected)
        sources = [(row["path"], row["source_sha256"]) for row in connection.execute("SELECT path, source_sha256 FROM sources")]
        connection.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('index_fingerprint', ?)", (_fingerprint(sources),))
        connection.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('indexed_at', ?)", (_now(),))
        connection.commit()
        chunks = connection.execute("SELECT COUNT(*) AS n FROM chunks WHERE current = 1").fetchone()["n"]
    except sqlite3.Error as exc:
        connection.rollback()
        raise _translate(exc) from exc
    finally:
        connection.close()
    return {
        "removedSources": removed,
        "notIndexed": sorted(set(relative_paths) - set(removed)),
        "storeChunks": chunks,
        "retainedEvidenceChunks": retained,
        "collectedUnreferencedChunks": collected,
        "indexFingerprint": _fingerprint(sources),
        "sourceFilesModified": False,
    }


def index_state(root: Path) -> dict[str, object]:
    connection = _connect(root)
    try:
        sources = [dict(row) for row in connection.execute(
            "SELECT path, source_sha256, bytes, chunk_count, indexed_at, kind, unit, parser_id, units_total, units_extracted, "
            "empty_units, warnings, outcome, verification, last_verified_at FROM sources ORDER BY path")]
        meta = {row["key"]: row["value"] for row in connection.execute("SELECT key, value FROM meta")}
        chunk_count = connection.execute("SELECT COUNT(*) AS n FROM chunks WHERE current = 1").fetchone()["n"]
        retained = connection.execute("SELECT COUNT(*) AS n FROM chunks WHERE current = 0").fetchone()["n"]
        claim_count = connection.execute("SELECT COUNT(*) AS n FROM claims").fetchone()["n"]
    finally:
        connection.close()
    for source in sources:
        source["emptyUnits"] = json.loads(source.pop("empty_units") or "[]")
        source["warnings"] = json.loads(source.pop("warnings") or "[]")
        source["parser"] = json.loads(source.pop("parser_id") or "{}") if source.get("parser_id") else {}
        source["lastVerifiedAt"] = source.pop("last_verified_at")
        source["freshness"] = source.pop("verification")
    freshness_counts: dict[str, int] = {}
    for source in sources:
        freshness_counts[source["freshness"]] = freshness_counts.get(source["freshness"], 0) + 1
    return {
        "schemaVersion": int(meta.get("schema_version", SCHEMA_VERSION)),
        "created_at": meta.get("created_at"),
        "indexFingerprint": meta.get("index_fingerprint"),
        "indexedAt": meta.get("indexed_at"),
        "sourceCount": len(sources),
        "chunkCount": chunk_count,
        "retainedChunkCount": retained,
        "claimCount": claim_count,
        "freshness": freshness_counts,
        "freshnessNote": (
            "Freshness is a recorded hash check, not an inference from the index. 'unchecked' means the "
            "present file has never been hashed against this index; run verify_sources to check it."
        ),
        "sources": sources,
    }


def _code_of(message: str) -> tuple[str, str]:
    """Split a ``CODE: sentence`` into its code and its sentence."""
    code, _, rest = str(message).partition(":")
    return code.strip(), rest.strip()


class _Cancelled(Exception):
    """Internal signal: the caller asked for this run to stop, so nothing is committed."""


def _cancelled_report(run_id: str, started_at: str, *, written: int) -> dict[str, object]:
    return {
        "runId": run_id,
        "status": "cancelled",
        "indexedSources": [],
        "keptPreviousVersion": [],
        "failedSources": [],
        "partialSources": [],
        "emptySources": [],
        "acceptedPartial": False,
        "written": written,
        "storeChunks": None,
        "retainedEvidenceChunks": 0,
        "collectedUnreferencedChunks": 0,
        "indexFingerprint": None,
        "indexedAt": started_at,
        "cancelled": True,
        "sourceFilesModified": False,
        "note": "The run was cancelled before it committed. The store is exactly as it was.",
    }


def _record_cancelled_run(root: Path, run_id: str, started_at: str, source_count: int) -> None:
    """Leave an audit row for a run that stopped before it committed.

    The data transaction is already rolled back, so this is a separate write into the audit table
    only. It is skipped when no store exists yet: cancelling an index call must not create a store
    the operator never asked for. A failure to write the audit row is not turned into an error,
    because the cancellation itself already succeeded.
    """
    if not store_path(root).is_file():
        return
    connection = _connect(root, create=True)
    try:
        connection.execute(
            "INSERT INTO index_runs (run_id, started_at, finished_at, mode, source_count, chunk_count, status, accepted_partial, detail) "
            "VALUES (?, ?, ?, 'index', ?, 0, 'cancelled', 0, ?)",
            (run_id, started_at, _now(), source_count, json.dumps({"cancelled": True, "sourcesRequested": source_count}, ensure_ascii=False)),
        )
        connection.commit()
    except sqlite3.Error:
        connection.rollback()
    finally:
        connection.close()


def index_corpus(
    root: Path,
    relative_paths: list[str],
    *,
    chunk_chars: int = 1200,
    overlap_chars: int = 120,
    accept_partial: bool = False,
    cancel=None,
) -> dict[str, object]:
    """Index the selected Markdown/text, PDF or DOCX sources with original-document provenance.

    Source files are read only. The selected paths become the current index membership for those
    paths, including a path that now produces no chunks at all. Chunks a claim still references are
    retained as historical evidence instead of being deleted.

    Three rules make a mixed batch honest:

    * every source is read and chunked **before** anything is written, and one call is one
      transaction — a failure after the writes began rolls the whole call back;
    * a source that could not be read, or that was only partly readable, is reported per file and
      is **not** written: its previous indexed version stays current. With ``accept_partial=True`` a
      partial source is written and labelled partial;
    * if nothing could be written, nothing is written, and the receipt says so.
    """
    from .full import MAX_TOTAL_BYTES, chunks_for_source, scan_sources

    if not relative_paths or len(relative_paths) > MAX_INDEX_SOURCES:
        raise StoreError(f"SOURCE_COUNT: index 1..{MAX_INDEX_SOURCES} explicit files per call.")
    if cancel is not None and not callable(cancel):
        raise StoreError("CANCEL_TOKEN: pass a callable that returns True to stop, or nothing.")
    root_path = Path(root).expanduser().resolve()
    run_id = f"{_now().replace(':', '').replace('+0000', 'Z')}-{secrets.token_hex(4)}"
    started_at = _now()

    prepared: dict[str, tuple] = {}
    failed: list[dict[str, object]] = []
    total_bytes = 0
    for relative_path in dict.fromkeys(relative_paths):
        if cancel is not None and cancel():
            _record_cancelled_run(root_path, run_id, started_at, len(dict.fromkeys(relative_paths)))
            return _cancelled_report(run_id, started_at, written=0)
        try:
            records = scan_sources(root_path, [relative_path])
        except Exception as exc:
            code, message = _code_of(str(exc))
            if code in {"SOURCE_COUNT", "ROOT_NOT_FOUND", "INVALID_SOURCE", "SOURCE_OUTSIDE_ROOT"}:
                # A malformed request is not a per-file outcome; the whole call is refused.
                raise _prototype_error(exc) from exc
            failed.append({"path": relative_path, "code": code, "message": message, "outcome": "failed", "keptPreviousVersion": True})
            continue
        if not records:
            continue
        record = records[0]
        total_bytes += record.bytes
        if total_bytes > MAX_TOTAL_BYTES:
            failed.append({"path": record.source_path, "code": "CORPUS_TOO_LARGE",
                           "message": f"total limit is {MAX_TOTAL_BYTES} bytes for one index call.",
                           "outcome": "failed", "keptPreviousVersion": True})
            continue
        try:
            chunks = chunks_for_source(record, chunk_chars=chunk_chars, overlap_chars=overlap_chars)
        except Exception as exc:
            code, message = _code_of(str(exc))
            failed.append({"path": record.source_path, "code": code, "message": message, "outcome": "failed", "keptPreviousVersion": True})
            continue
        prepared[record.source_path] = (record, chunks)

    connection = _connect(root, create=True)
    committed = False
    try:
        paths = set(prepared)
        placeholders = ",".join("?" for _ in paths) if paths else "''"
        current_total = connection.execute("SELECT COUNT(*) AS n FROM chunks WHERE current = 1").fetchone()["n"]
        current_for_paths = connection.execute(f"SELECT COUNT(*) AS n FROM chunks WHERE current = 1 AND source_path IN ({placeholders})", tuple(paths)).fetchone()["n"] if paths else 0
        incoming = sum(len(chunks) for _, chunks in prepared.values())
        if current_total - current_for_paths + incoming > MAX_STORE_CHUNKS:
            raise StoreError(f"STORE_CHUNK_LIMIT: the store holds at most {MAX_STORE_CHUNKS} current chunks.")
        stamp = started_at
        indexed: list[str] = []
        kept: list[dict[str, object]] = []
        partial_sources: list[dict[str, object]] = []
        empty_sources: list[str] = []
        retained = 0
        collected = 0
        for path, (record, chunks) in sorted(prepared.items()):
            if cancel is not None and cancel():
                raise _Cancelled()
            if record.outcome in ("partial", "failed") and not accept_partial:
                existing = connection.execute("SELECT source_sha256, chunk_count FROM sources WHERE path = ?", (path,)).fetchone()
                kept.append({
                    "path": path,
                    "outcome": record.outcome,
                    "hadPreviousVersion": existing is not None,
                    "previousChunks": existing["chunk_count"] if existing is not None else 0,
                    "reason": "accept_partial is false: an incomplete read never replaces an indexed version.",
                })
                continue
            connection.execute("UPDATE chunks SET current = 0 WHERE source_path = ?", (path,))
            retained += _retained_count(connection, {path})
            connection.execute("DELETE FROM sources WHERE path = ?", (path,))
            connection.execute("INSERT OR REPLACE INTO source_versions (source_sha256, bytes, first_seen_at) VALUES (?, ?, ?)", (record.source_version_id, record.bytes, stamp))
            for chunk in chunks:
                connection.execute(
                    "INSERT INTO chunks (chunk_id, content_id, source_path, source_sha256, locator, text, text_sha256, chunker_id, chars, current, indexed_at, "
                    "unit_kind, unit_index, char_start, char_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(chunk_id) DO UPDATE SET current = 1, indexed_at = excluded.indexed_at",
                    (chunk.chunk_id, chunk.content_id, chunk.source_path, chunk.source_version_id, chunk.locator, chunk.text, chunk.text_sha256, chunk.chunker_id,
                     len(chunk.text), stamp, chunk.unit_kind, chunk.unit_index, chunk.char_start, chunk.char_end),
                )
            coverage = record.coverage or {}
            connection.execute(
                "INSERT INTO sources (path, source_sha256, bytes, chunk_count, indexed_at, kind, unit, parser_id, units_total, units_extracted, "
                "empty_units, warnings, outcome, verification, last_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?)",
                (path, record.source_version_id, record.bytes, len(chunks), stamp, record.kind, record.unit,
                 json.dumps(record.parser, ensure_ascii=False) if record.parser else "",
                 int(coverage.get("totalUnits", 0) or 0), int(coverage.get("unitsRead", 0) or 0),
                 json.dumps(coverage.get("emptyUnits", []), ensure_ascii=False), json.dumps(list(record.warnings), ensure_ascii=False),
                 record.outcome, stamp),
            )
            if not chunks:
                empty_sources.append(path)
            if record.outcome == "partial":
                partial_sources.append({"path": path, "unitsTotal": coverage.get("totalUnits"), "unitsExtracted": coverage.get("unitsRead"),
                                        "emptyUnits": coverage.get("emptyUnits", []), "accepted": True})
            collected += _collect_retired(connection, {path})
            indexed.append(path)
        if not indexed:
            # Nothing was writable: leave the store byte-for-byte as it was.
            connection.rollback()
            sources = [(row["path"], row["source_sha256"]) for row in connection.execute("SELECT path, source_sha256 FROM sources")]
            return {
                "runId": run_id,
                "status": "failed",
                "indexedSources": [],
                "keptPreviousVersion": kept,
                "failedSources": failed,
                "partialSources": [],
                "emptySources": [],
                "acceptedPartial": accept_partial,
                "written": 0,
                "storeChunks": current_total,
                "retainedEvidenceChunks": 0,
                "collectedUnreferencedChunks": 0,
                "indexFingerprint": _fingerprint(sources),
                "indexedAt": stamp,
                "sourceFilesModified": False,
                "note": "No selected source could be indexed. Nothing in the store changed.",
            }
        sources = [(row["path"], row["source_sha256"]) for row in connection.execute("SELECT path, source_sha256 FROM sources")]
        connection.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('index_fingerprint', ?)", (_fingerprint(sources),))
        connection.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('indexed_at', ?)", (stamp,))
        status = "complete" if not failed and not kept and not partial_sources else "partial"
        connection.execute(
            "INSERT INTO index_runs (run_id, started_at, finished_at, mode, source_count, chunk_count, status, accepted_partial, detail) "
            "VALUES (?, ?, ?, 'index', ?, ?, ?, ?, ?)",
            (run_id, started_at, _now(), len(indexed), sum(len(chunks) for path, (_, chunks) in prepared.items() if path in indexed),
             status, 1 if accept_partial else 0,
             json.dumps({"indexed": indexed, "kept": kept, "failed": failed, "partial": partial_sources, "empty": empty_sources}, ensure_ascii=False)),
        )
        connection.commit()
        committed = True
        stored = connection.execute("SELECT COUNT(*) AS n FROM chunks WHERE current = 1").fetchone()["n"]
        retained_total = connection.execute("SELECT COUNT(*) AS n FROM chunks WHERE current = 0").fetchone()["n"]
    except _Cancelled:
        connection.rollback()
        _record_cancelled_run(root_path, run_id, started_at, len(prepared))
        return _cancelled_report(run_id, started_at, written=0)
    except StoreError:
        connection.rollback()
        raise
    except sqlite3.Error as exc:
        connection.rollback()
        raise _translate(exc) from exc
    finally:
        connection.close()
    return {
        "runId": run_id,
        "status": status,
        "indexedSources": indexed,
        "keptPreviousVersion": kept,
        "failedSources": failed,
        "partialSources": partial_sources,
        "emptySources": sorted(empty_sources),
        "acceptedPartial": accept_partial,
        "written": len(indexed),
        "chunksStored": sum(len(chunks) for path, (_, chunks) in prepared.items() if path in indexed),
        "storeChunks": stored,
        "retainedEvidenceChunks": retained_total,
        "collectedUnreferencedChunks": collected,
        "indexFingerprint": _fingerprint(sources),
        "indexedAt": stamp,
        "committed": committed,
        "sourceFilesModified": False,
    }


def verify_sources(root: Path, relative_paths: list[str] | None = None) -> dict[str, object]:
    """Re-hash the sources the index claims and record what the present file actually is.

    This is the only verb that may call a source ``verified``. Indexing sets the flag because it
    hashed the bytes it read; a store migrated from 0.3.8 starts ``unchecked`` and stays unchecked
    until this verb has looked at the file. Source files are read only.
    """
    from .documents import sha256_file
    from pathlib import PurePosixPath

    if relative_paths is not None and (not relative_paths or len(relative_paths) > MAX_INDEX_SOURCES):
        raise StoreError(f"SOURCE_COUNT: verify 1..{MAX_INDEX_SOURCES} explicit files per call.")
    root_path = Path(root).expanduser().resolve()
    connection = _connect(root, create=True)
    try:
        if relative_paths is None:
            rows = connection.execute("SELECT path, source_sha256 FROM sources ORDER BY path").fetchall()
        else:
            rows = []
            for relative_path in dict.fromkeys(relative_paths):
                candidate = PurePosixPath(str(relative_path).replace("\\", "/"))
                if candidate.is_absolute() or ".." in candidate.parts:
                    raise StoreError("SOURCE_OUTSIDE_ROOT: verify paths inside the workspace root.")
                rows.append(connection.execute("SELECT path, source_sha256 FROM sources WHERE path = ?", (candidate.as_posix(),)).fetchone())
            rows = [row for row in rows if row is not None]
        stamp = _now()
        buckets: dict[str, list[str]] = {state: [] for state in VERIFICATION_STATES}
        for row in rows:
            target = root_path / Path(*PurePosixPath(row["path"]).parts)
            if not target.exists():
                state = "missing"
            elif not target.is_file():
                state = "inaccessible"
            else:
                try:
                    actual = sha256_file(target)
                except OSError:
                    state = "inaccessible"
                else:
                    state = "verified" if actual == row["source_sha256"] else "changed"
            connection.execute("UPDATE sources SET verification = ?, last_verified_at = ? WHERE path = ?", (state, stamp, row["path"]))
            buckets[state].append(row["path"])
        unchecked = connection.execute("SELECT COUNT(*) AS n FROM sources WHERE verification = 'unchecked'").fetchone()["n"]
        connection.commit()
    except StoreError:
        connection.rollback()
        raise
    except sqlite3.Error as exc:
        connection.rollback()
        raise _translate(exc) from exc
    finally:
        connection.close()
    return {
        "checked": len(rows),
        "verified": sorted(buckets["verified"]),
        "changed": sorted(buckets["changed"]),
        "missing": sorted(buckets["missing"]),
        "inaccessible": sorted(buckets["inaccessible"]),
        "uncheckedRemaining": unchecked,
        "checkedAt": stamp,
        "sourceFilesModified": False,
        "note": "Freshness is a recorded check. A source is 'verified' only when its present bytes were hashed in this call.",
    }


def stored_chunks(root: Path, *, limit: int = MAX_STORE_CHUNKS, include_retired: bool = False):
    """Load stored chunks as the shared evidence-chunk records used by retrieval.

    ``limit`` defaults to ``MAX_STORE_CHUNKS`` on purpose: the same constant bounds the store in
    ``index_corpus`` and bounds the candidate set here, so the index can never grow past the set
    search is willing to rank. A test asserts the two uses agree.
    """
    from .full import EvidenceChunk

    connection = _connect(root)
    try:
        clause = "" if include_retired else "WHERE current = 1"
        rows = connection.execute(
            f"SELECT chunk_id, content_id, source_sha256, source_path, locator, text, text_sha256, chunker_id, "
            f"unit_kind, unit_index, char_start, char_end FROM chunks {clause} ORDER BY source_path, locator, chunk_id LIMIT ?",
            (limit,),
        ).fetchall()
    finally:
        connection.close()
    return [
        EvidenceChunk(
            chunk_id=row["chunk_id"],
            content_id=row["content_id"],
            source_version_id=row["source_sha256"],
            source_path=row["source_path"],
            locator=row["locator"],
            text=row["text"],
            text_sha256=row["text_sha256"],
            chunker_id=row["chunker_id"],
            unit_kind=row["unit_kind"],
            unit_index=row["unit_index"],
            char_start=row["char_start"],
            char_end=row["char_end"],
        )
        for row in rows
    ]


def search_corpus(root: Path, query: str, *, limit: int = 10):
    """BM25 over the current stored chunks; every hit carries source path, locator and hashes."""
    from .full import search_bm25

    try:
        hits = search_bm25(stored_chunks(root), query, limit=limit)
    except StoreError:
        raise
    except Exception as exc:
        raise _prototype_error(exc) from exc
    return hits


def get_chunks(root: Path, chunk_ids: list[str]) -> list[dict[str, object]]:
    """Resolve chunk ids to their stored provenance, including whether they are still current."""
    if not chunk_ids or len(chunk_ids) > MAX_EVIDENCE_LINKS:
        raise StoreError(f"CHUNK_IDS: provide 1..{MAX_EVIDENCE_LINKS} chunk ids.")
    connection = _connect(root)
    try:
        placeholders = ",".join("?" for _ in chunk_ids)
        rows = connection.execute(
            f"SELECT c.chunk_id, c.content_id, c.source_path, c.source_sha256, c.locator, c.text, c.text_sha256, c.chunker_id, c.current, "
            f"c.unit_kind, c.unit_index, c.char_start, c.char_end, s.verification, s.last_verified_at, s.kind, s.outcome "
            f"FROM chunks c LEFT JOIN sources s ON s.path = c.source_path WHERE c.chunk_id IN ({placeholders})",
            tuple(chunk_ids),
        ).fetchall()
    finally:
        connection.close()
    resolved = []
    for row in rows:
        record = {
            "chunk_id": row["chunk_id"],
            "content_id": row["content_id"],
            "sourcePath": row["source_path"],
            "sourceSha256": row["source_sha256"],
            "locator": row["locator"],
            "text": row["text"],
            "textSha256": row["text_sha256"],
            "chunkerId": row["chunker_id"],
            "unitKind": row["unit_kind"],
            "unitIndex": row["unit_index"],
            "charStart": row["char_start"],
            "charEnd": row["char_end"],
            "sourceKind": row["kind"] if row["kind"] else "text",
            "resolvable": True,
            "current": bool(row["current"]),
        }
        record["stale"] = not record["current"]
        # A retired chunk came from a version the index no longer holds, so the freshness of the
        # present file says nothing about it: it is labelled historical instead. For a current chunk
        # the freshness is the store's own recorded check of that exact path and version.
        if record["stale"]:
            record["sourceVerification"] = "historical"
            record["sourceLastVerifiedAt"] = None
            record["verificationNote"] = "Retained evidence from an earlier version of this source; the store no longer indexes that version."
        else:
            record["sourceVerification"] = row["verification"] if row["verification"] else "unindexed"
            record["sourceLastVerifiedAt"] = row["last_verified_at"]
        resolved.append(record)
    resolved.sort(key=lambda item: item["chunk_id"])
    return resolved


def _evidence_links(connection: sqlite3.Connection, claim_id: str) -> list[dict[str, object]]:
    rows = connection.execute(
        "SELECT e.chunk_id, e.locator, e.role, e.rationale, e.added_at, c.source_path, c.source_sha256, c.text_sha256, c.current, "
        "s.verification, s.last_verified_at "
        "FROM claim_evidence e LEFT JOIN chunks c ON c.chunk_id = e.chunk_id LEFT JOIN sources s ON s.path = c.source_path "
        "WHERE e.claim_id = ? ORDER BY e.added_at, e.chunk_id",
        (claim_id,),
    ).fetchall()
    links: list[dict[str, object]] = []
    for row in rows:
        link = {
            "chunk_id": row["chunk_id"],
            "locator": row["locator"],
            "role": row["role"],
            "rationale": row["rationale"],
            "addedAt": row["added_at"],
            "resolvable": row["source_path"] is not None,
            "current": bool(row["current"]) if row["source_path"] is not None else False,
        }
        link["stale"] = not link["current"]
        if row["source_path"] is not None:
            link["sourcePath"] = row["source_path"]
            link["sourceSha256"] = row["source_sha256"]
            link["textSha256"] = row["text_sha256"]
            if link["stale"]:
                link["sourceVerification"] = "historical"
                link["sourceLastVerifiedAt"] = None
            else:
                link["sourceVerification"] = row["verification"] if row["verification"] else "unindexed"
                link["sourceLastVerifiedAt"] = row["last_verified_at"]
        else:
            link["sourcePath"] = None
            link["sourceVerification"] = "unresolvable"
            link["warning"] = "EVIDENCE_UNRESOLVABLE: this chunk id is no longer in the store."
        links.append(link)
    return links


def _claim_rows(connection: sqlite3.Connection, claim_id: str | None, limit: int, status: str | None, cursor: tuple[str, str] | None) -> list[dict[str, object]]:
    if claim_id is not None:
        rows = connection.execute("SELECT * FROM claims WHERE claim_id = ?", (claim_id,)).fetchall()
    else:
        sql = "SELECT * FROM claims"
        conditions: list[str] = []
        params: list[object] = []
        if status is not None:
            conditions.append("status = ?")
            params.append(status)
        if cursor is not None:
            conditions.append("(updated_at < ? OR (updated_at = ? AND claim_id < ?))")
            params.extend([cursor[0], cursor[0], cursor[1]])
        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        sql += " ORDER BY updated_at DESC, claim_id DESC LIMIT ?"
        params.append(limit)
        rows = connection.execute(sql, tuple(params)).fetchall()
    results: list[dict[str, object]] = []
    for row in rows:
        record = dict(row)
        record["evidence"] = _evidence_links(connection, row["claim_id"])
        record["evidenceCount"] = len(record["evidence"])
        record["staleEvidenceCount"] = sum(1 for link in record["evidence"] if link["stale"])
        record["history"] = [dict(item) for item in connection.execute(
            "SELECT kind, detail, at FROM claim_events WHERE claim_id = ? ORDER BY event_id DESC LIMIT 20", (row["claim_id"],))]
        results.append(record)
    return results


def _decode_cursor(cursor: str | None) -> tuple[str, str] | None:
    if not cursor:
        return None
    try:
        updated_at, claim_id = cursor.split("|", 1)
    except ValueError as exc:
        raise StoreError("CLAIM_CURSOR_INVALID: pass the nextCursor value returned by the previous read.") from exc
    if not updated_at or not claim_id:
        raise StoreError("CLAIM_CURSOR_INVALID: pass the nextCursor value returned by the previous read.")
    return updated_at, claim_id


def read_claims(root: Path, *, claim_id: str | None = None, limit: int = 50, status: str | None = None, cursor: str | None = None) -> dict[str, object]:
    if not 1 <= limit <= MAX_CLAIM_PAGE:
        raise StoreError(f"CLAIM_LIMIT: limit must be 1..{MAX_CLAIM_PAGE}.")
    if status is not None and status not in CLAIM_STATUSES:
        raise StoreError(f"CLAIM_STATUS: expected one of {', '.join(CLAIM_STATUSES)}.")
    start = _decode_cursor(cursor)
    connection = _connect(root)
    try:
        claims = _claim_rows(connection, claim_id, limit + 1 if claim_id is None else 1, status, start)
        total = connection.execute("SELECT COUNT(*) AS n FROM claims" + (" WHERE status = ?" if status is not None else ""), ((status,) if status is not None else ())).fetchone()["n"]
    finally:
        connection.close()
    next_cursor = None
    if claim_id is None and len(claims) > limit:
        claims = claims[:limit]
        last = claims[-1]
        next_cursor = f"{last['updated_at']}|{last['claim_id']}"
    return {
        "claims": claims,
        "claimCount": len(claims),
        "matchingClaimCount": total,
        "nextCursor": next_cursor,
        "readOnly": True,
        "assessment": ASSESSMENT_NOTE,
    }


def _new_claim_id(statement: str, stamp: str) -> str:
    return hashlib.sha256(f"{stamp}\n{statement}\n{secrets.token_hex(8)}".encode("utf-8")).hexdigest()[:16]


def write_claim(
    root: Path,
    statement: str,
    *,
    claim_id: str | None = None,
    status: str | None = None,
    note: str | None = None,
    evidence_chunk_ids: list[str] | None = None,
    evidence_role: str = "supporting",
    evidence_rationale: str = "",
    evidence_mode: str = "append",
    idempotency_key: str | None = None,
) -> dict[str, object]:
    """Create or patch one claim and reconcile its links to stored evidence chunks.

    Omitted ``status`` and ``note`` keep their stored values; only supplied fields change.
    Evidence links are appended, replaced or removed according to ``evidence_mode``.
    """
    if not isinstance(statement, str) or not statement.strip():
        raise StoreError("CLAIM_EMPTY: a claim needs a statement you can check.")
    if len(statement) > MAX_STATEMENT_CHARS:
        raise StoreError(f"CLAIM_TOO_LONG: the statement limit is {MAX_STATEMENT_CHARS} characters.")
    if status is not None and status not in CLAIM_STATUSES:
        raise StoreError(f"CLAIM_STATUS: expected one of {', '.join(CLAIM_STATUSES)}.")
    if note is not None and len(note) > MAX_NOTE_CHARS:
        raise StoreError(f"CLAIM_NOTE_TOO_LONG: the note limit is {MAX_NOTE_CHARS} characters.")
    if evidence_role not in EVIDENCE_ROLES:
        raise StoreError(f"EVIDENCE_ROLE: expected one of {', '.join(EVIDENCE_ROLES)}.")
    if evidence_mode not in EVIDENCE_MODES:
        raise StoreError(f"EVIDENCE_MODE: expected one of {', '.join(EVIDENCE_MODES)}.")
    if len(evidence_rationale) > MAX_RATIONALE_CHARS:
        raise StoreError(f"EVIDENCE_RATIONALE_TOO_LONG: the rationale limit is {MAX_RATIONALE_CHARS} characters.")
    evidence_chunk_ids = list(evidence_chunk_ids or [])
    if len(evidence_chunk_ids) > MAX_EVIDENCE_LINKS:
        raise StoreError(f"EVIDENCE_LIMIT: at most {MAX_EVIDENCE_LINKS} evidence links per call.")
    if idempotency_key is not None and (not isinstance(idempotency_key, str) or not idempotency_key.strip() or len(idempotency_key) > 200):
        raise StoreError("IDEMPOTENCY_KEY: provide a short non-empty string, or omit it.")

    connection = _connect(root, create=True)
    try:
        stamp = _now()
        if idempotency_key is not None:
            existing = connection.execute("SELECT claim_id FROM claims WHERE idempotency_key = ?", (idempotency_key,)).fetchone()
            if existing is not None:
                claim_id = existing["claim_id"]
        created = False
        if claim_id is None:
            count = connection.execute("SELECT COUNT(*) AS n FROM claims").fetchone()["n"]
            if count >= MAX_CLAIMS:
                raise StoreError(f"CLAIM_LIMIT: the store holds at most {MAX_CLAIMS} claims.")
            for _ in range(5):
                candidate = _new_claim_id(statement, stamp)
                try:
                    connection.execute(
                        "INSERT INTO claims (claim_id, statement, status, note, idempotency_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (candidate, statement.strip(), status or "open", note or "", idempotency_key, stamp, stamp),
                    )
                    claim_id = candidate
                    created = True
                    break
                except sqlite3.IntegrityError:
                    connection.rollback()
            else:
                raise StoreError("CLAIM_ID_COLLISION: the claim id could not be reserved; retry the write.")
            _log_event(connection, claim_id, "created", statement.strip(), stamp)
        else:
            current = connection.execute("SELECT * FROM claims WHERE claim_id = ?", (claim_id,)).fetchone()
            if current is None:
                raise StoreError(f"CLAIM_NOT_FOUND: no claim with id {claim_id!r}. Create it first.")
            connection.execute(
                "UPDATE claims SET statement = ?, status = ?, note = ?, updated_at = ? WHERE claim_id = ?",
                (statement.strip(), status if status is not None else current["status"], note if note is not None else current["note"], stamp, claim_id),
            )
            changes = [name for name, (given, stored) in {
                "statement": (statement.strip(), current["statement"]),
                "status": (status, current["status"]),
                "note": (note, current["note"]),
            }.items() if given is not None and given != stored]
            _log_event(connection, claim_id, "updated", ", ".join(changes) or "no field change", stamp)

        linked = _reconcile_evidence(connection, claim_id, evidence_chunk_ids, evidence_role, evidence_rationale, evidence_mode, stamp)
        total_links = connection.execute("SELECT COUNT(*) AS n FROM claim_evidence WHERE claim_id = ?", (claim_id,)).fetchone()["n"]
        if total_links > MAX_EVIDENCE_LINKS:
            raise StoreError(f"EVIDENCE_LIMIT: a claim holds at most {MAX_EVIDENCE_LINKS} evidence links; remove links before adding more.")
        connection.commit()
        row = connection.execute("SELECT * FROM claims WHERE claim_id = ?", (claim_id,)).fetchone()
        evidence = _evidence_links(connection, claim_id)
        events = [dict(item) for item in connection.execute("SELECT kind, detail, at FROM claim_events WHERE claim_id = ? ORDER BY event_id", (claim_id,))]
    except StoreError:
        connection.rollback()
        raise
    except sqlite3.Error as exc:
        connection.rollback()
        raise _translate(exc) from exc
    finally:
        connection.close()
    record = dict(row)
    record["evidence"] = evidence
    record["evidenceCount"] = len(evidence)
    record["staleEvidenceCount"] = sum(1 for link in evidence if link["stale"])
    record["history"] = events
    return {
        "claim": record,
        "created": created,
        "idempotent": idempotency_key is not None and not created,
        "evidenceLinked": linked["added"],
        "evidenceRemoved": linked["removed"],
        "sourceFilesModified": False,
        "assessment": ASSESSMENT_NOTE,
    }


def _log_event(connection: sqlite3.Connection, claim_id: str, kind: str, detail: str, stamp: str) -> None:
    connection.execute("INSERT INTO claim_events (claim_id, kind, detail, at) VALUES (?, ?, ?, ?)", (claim_id, kind, detail[:400], stamp))


def _reconcile_evidence(connection: sqlite3.Connection, claim_id: str, chunk_ids: list[str], role: str, rationale: str, mode: str, stamp: str) -> dict[str, int]:
    if not chunk_ids:
        return {"added": 0, "removed": 0}
    removed = 0
    added = 0
    if mode == "replace":
        removed = connection.execute("SELECT COUNT(*) AS n FROM claim_evidence WHERE claim_id = ?", (claim_id,)).fetchone()["n"]
        connection.execute("DELETE FROM claim_evidence WHERE claim_id = ?", (claim_id,))
        _log_event(connection, claim_id, "evidence-replaced", f"{removed} link(s) cleared", stamp)
    for chunk_id in chunk_ids:
        chunk = connection.execute("SELECT chunk_id, locator FROM chunks WHERE chunk_id = ?", (chunk_id,)).fetchone()
        if chunk is None:
            raise StoreError(f"EVIDENCE_NOT_FOUND: chunk {chunk_id!r} is not in the store. Run index_corpus first, or cite a retained chunk id.")
        if mode == "remove":
            deleted = connection.execute("DELETE FROM claim_evidence WHERE claim_id = ? AND chunk_id = ?", (claim_id, chunk["chunk_id"]))
            removed += deleted.rowcount
            continue
        inserted = connection.execute(
            "INSERT INTO claim_evidence (claim_id, chunk_id, locator, role, rationale, added_at) VALUES (?, ?, ?, ?, ?, ?) "
            "ON CONFLICT(claim_id, chunk_id) DO UPDATE SET role = excluded.role, rationale = excluded.rationale, locator = excluded.locator",
            (claim_id, chunk["chunk_id"], chunk["locator"], role, rationale, stamp),
        )
        added += inserted.rowcount
    if added:
        _log_event(connection, claim_id, "evidence-added", f"{added} link(s) as {role}", stamp)
    if removed and mode == "remove":
        _log_event(connection, claim_id, "evidence-removed", f"{removed} link(s) removed", stamp)
    return {"added": added, "removed": removed}


UNVERIFIED_SOURCE_STATES = ("changed", "missing", "inaccessible", "unresolvable")


def export_claims(root: Path, claim_ids: list[str], *, include_stale: bool = False, include_unverified: bool = False) -> dict[str, object]:
    """Resolve stored claims into report-ready references with validated source identity.

    A reference is only produced when the cited chunk still resolves in the store. Two exclusions
    apply by default, and both are counted in the receipt:

    * **stale** — the chunk is retained evidence from a version the index no longer holds;
    * **unverified** — the source file is known to be `changed`, `missing`, `inaccessible`, or the
      chunk no longer resolves at all.

    A source that is `unchecked` is included and counted separately: it is the version the index
    holds, and the honest statement about it is "the present file has never been re-hashed", not
    "it is wrong". Anything included against the default is labelled, never quietly merged into the
    live references.
    """
    if not claim_ids or len(claim_ids) > MAX_EVIDENCE_LINKS:
        raise StoreError(f"CLAIM_IDS: export 1..{MAX_EVIDENCE_LINKS} claim ids per call.")
    connection = _connect(root)
    try:
        references: list[dict[str, object]] = []
        claims: list[dict[str, object]] = []
        unresolved: list[str] = []
        excluded_stale = 0
        excluded_unverified = 0
        unchecked_references = 0
        for claim_id in claim_ids:
            row = connection.execute("SELECT * FROM claims WHERE claim_id = ?", (claim_id,)).fetchone()
            if row is None:
                unresolved.append(claim_id)
                continue
            links = _evidence_links(connection, claim_id)
            usable: list[dict[str, object]] = []
            for link in links:
                if not link["resolvable"]:
                    excluded_unverified += 1
                    if not include_unverified:
                        continue
                elif link["sourceVerification"] in UNVERIFIED_SOURCE_STATES:
                    excluded_unverified += 1
                    if not include_unverified:
                        continue
                elif link["stale"] and not include_stale:
                    excluded_stale += 1
                    continue
                usable.append(link)
            claims.append({
                "claim_id": row["claim_id"],
                "statement": row["statement"],
                "status": row["status"],
                "evidenceCount": len(links),
                "usableEvidenceCount": len(usable),
                "staleEvidenceCount": sum(1 for link in links if link["stale"]),
                "unverifiedEvidenceCount": sum(1 for link in links if link["sourceVerification"] in UNVERIFIED_SOURCE_STATES),
            })
            for link in usable:
                if link["sourceVerification"] == "unchecked":
                    unchecked_references += 1
                references.append({
                    "label": f"{link['sourcePath']} · {link['locator']}",
                    "reference": link["sourcePath"],
                    "sha256": link["sourceSha256"],
                    "locator": link["locator"],
                    "chunkId": link["chunk_id"],
                    "role": link["role"],
                    "current": link["current"],
                    "sourceVerification": link["sourceVerification"],
                    "historical": bool(link["stale"]) or link["sourceVerification"] in UNVERIFIED_SOURCE_STATES,
                })
    finally:
        connection.close()
    return {
        "claims": claims,
        "references": references,
        "unresolvedClaims": sorted(unresolved),
        "excludedStaleReferences": excluded_stale,
        "excludedUnverifiedReferences": excluded_unverified,
        "uncheckedReferences": unchecked_references,
        "readOnly": True,
        "assessment": ASSESSMENT_NOTE,
        "freshnessNote": (
            "References marked historical are retained evidence from a version this index no longer holds, "
            "or from a source whose present file was found changed, missing or inaccessible. References marked "
            "unchecked are the indexed version, but the present file has never been re-hashed against it."
        ),
    }


def reindex_preview(root: Path, relative_paths: list[str]) -> dict[str, object]:
    """Show what an index run would change, without creating or writing anything.

    A source that cannot be read appears in ``unreadableSources`` with its own code instead of
    aborting the preview: the point of a preview is to see the whole batch before committing to it.
    """
    from .full import chunks_for_source, scan_sources

    root_path = Path(root).expanduser().resolve()
    store_exists = store_path(root).is_file()
    affected: dict[str, dict[str, object]] = {}
    unreadable: list[dict[str, object]] = []
    for relative_path in dict.fromkeys(relative_paths):
        try:
            records = scan_sources(root_path, [relative_path])
        except Exception as exc:
            code, message = _code_of(str(exc))
            unreadable.append({"path": relative_path, "code": code, "message": message})
            continue
        if not records:
            continue
        record = records[0]
        try:
            new_chunks = len(chunks_for_source(record))
        except Exception as exc:
            code, message = _code_of(str(exc))
            unreadable.append({"path": record.source_path, "code": code, "message": message})
            continue
        affected[record.source_path] = {
            "currentSha256": None,
            "newSha256": record.source_version_id,
            "currentChunks": 0,
            "newChunks": new_chunks,
            "changed": True,
            "kind": record.kind,
            "outcome": record.outcome,
            "unitsTotal": record.coverage.get("totalUnits", 0) or None,
        }
    if store_exists:
        connection = _connect(root)
        try:
            for path, detail in affected.items():
                existing = connection.execute("SELECT source_sha256, chunk_count FROM sources WHERE path = ?", (path,)).fetchone()
                if existing is None:
                    continue
                detail["currentSha256"] = existing["source_sha256"]
                detail["currentChunks"] = existing["chunk_count"]
                detail["changed"] = existing["source_sha256"] != detail["newSha256"]
        finally:
            connection.close()
    return {
        "preview": True,
        "storePresent": store_exists,
        "sources": affected,
        "changedSources": sorted(path for path, detail in affected.items() if detail["changed"]),
        "unchangedSources": sorted(path for path, detail in affected.items() if not detail["changed"]),
        "unreadableSources": unreadable,
        "written": False,
    }


def _reserve_unique(directory: Path, prefix: str, suffix: str) -> Path:
    for _ in range(5):
        candidate = directory / f"{prefix}{_now().replace(':', '').replace('+0000', 'Z')}-{secrets.token_hex(3)}{suffix}"
        try:
            with open(candidate, "xb"):
                return candidate
        except FileExistsError:  # pragma: no cover - the token makes collisions vanishingly rare
            continue
    raise StoreError("BACKUP_NAME_UNAVAILABLE: no unique backup filename could be reserved; nothing was overwritten.")


def _snapshot(source: Path, destination: Path) -> dict[str, object]:
    """Copy a live SQLite database consistently and validate the copy."""
    source_connection = sqlite3.connect(_read_only_uri(source), uri=True)
    destination_connection = sqlite3.connect(destination)
    destination_connection.row_factory = sqlite3.Row
    try:
        source_connection.backup(destination_connection)
        destination_connection.commit()
        check = destination_connection.execute("PRAGMA quick_check").fetchone()
        if check is None or check[0] != "ok":
            raise StoreError("BACKUP_INVALID: the snapshot failed its integrity check; the live store was not changed.")
        meta = {row[0]: row[1] for row in destination_connection.execute("SELECT key, value FROM meta")}
        # A store written by an older toolkit has no newer tables. Counting only what the snapshot
        # really has is what makes `backup` work on a 0.3.8 store, before any migration has run.
        existing = _table_names(destination_connection)
        counts = {}
        for table in ("sources", "chunks", "claims", "claim_evidence", "index_runs"):
            counts[table] = destination_connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] if table in existing else 0
    except sqlite3.Error as exc:
        raise _translate(exc) from exc
    finally:
        destination_connection.close()
        source_connection.close()
    payload = destination.read_bytes()
    return {
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
        "schemaVersion": int(meta.get("schema_version", 0)),
        "counts": counts,
        "integrityCheck": "ok",
    }


def maintenance(root: Path, action: str, *, confirm: bool = False, backup_path: str | None = None) -> dict[str, object]:
    """Store status, consistent backup, candidate restore and confirmed vacuum."""
    if action not in {"status", "backup", "restore", "vacuum"}:
        raise StoreError("STORE_ACTION: expected status, backup, restore or vacuum.")
    path = store_path(root)
    if action == "status":
        backups = sorted(str(item.name) for item in _backup_directory(root).glob("research-*.sqlite3")) if _backup_directory(root).is_dir() else []
        return {"action": "status", "store": str(path), "backupCount": len(backups), "backups": backups[-10:], **index_state(root)}
    if not path.is_file():
        raise StoreError("STORE_MISSING: nothing to back up, restore into or vacuum; run the store step first.")
    if action == "backup":
        directory = _backup_directory(root)
        directory.mkdir(parents=True, exist_ok=True)
        try:
            assert_no_redirect(Path(root).expanduser().resolve(strict=True), directory)
        except PathPolicyError as exc:
            raise StoreError(str(exc)) from exc
        target = _reserve_unique(directory, "research-", ".sqlite3")
        try:
            report = _snapshot(path, target)
        except StoreError:
            target.unlink(missing_ok=True)
            raise
        return {"action": "backup", "store": str(path), "backup": str(target), "writeMode": "new-file-only", "consistentSnapshot": True, **report}
    if action == "restore":
        if not backup_path:
            raise StoreError("RESTORE_SOURCE_REQUIRED: pass the backup file to restore from.")
        source = Path(backup_path).expanduser()
        if not source.is_file():
            raise StoreError("RESTORE_SOURCE_MISSING: the named backup file does not exist.")
        report = {"action": "restore", "store": str(path), "source": str(source)}
        candidate_directory = path.parent
        candidate = _reserve_unique(candidate_directory, RESTORE_PREFIX, ".sqlite3")
        try:
            staged = _snapshot(source, candidate)
        except StoreError:
            candidate.unlink(missing_ok=True)
            raise
        report.update({"candidate": str(candidate), "validated": staged, "activated": False, "stagedOnly": True,
                       "nextAction": "Run store_maintenance with action='restore', confirm=true to activate this candidate."})
        if not confirm:
            return report
        preserved = candidate_directory / f"{PRE_RESTORE_PREFIX}{_now().replace(':', '').replace('+0000', 'Z')}-{secrets.token_hex(3)}.sqlite3"
        os.replace(path, preserved)
        try:
            activated = _snapshot(candidate, path)
        except StoreError:
            os.replace(preserved, path)
            candidate.unlink(missing_ok=True)
            raise
        candidate.unlink(missing_ok=True)
        report.update({"activated": True, "stagedOnly": False, "previousStorePreserved": str(preserved), "activatedStore": activated,
                       "nextAction": "Verify the restored store with store_maintenance action='status'."})
        return report
    if not confirm:
        raise StoreError("CONFIRM_REQUIRED: vacuum rewrites the store file and collects retired chunks that no claim references; call store_maintenance with confirm=true after reviewing store status.")
    connection = _connect(root, create=True)
    try:
        before = connection.execute("SELECT COUNT(*) AS n FROM chunks WHERE current = 1").fetchone()["n"]
        retired = connection.execute("SELECT COUNT(*) AS n FROM chunks WHERE current = 0").fetchone()["n"]
        collected = _collect_retired(connection, {row["source_path"] for row in connection.execute("SELECT DISTINCT source_path FROM chunks WHERE current = 0")})
        connection.execute("VACUUM")
        connection.commit()
    except sqlite3.Error as exc:
        raise _translate(exc) from exc
    finally:
        connection.close()
    return {"action": "vacuum", "store": str(path), "chunksBefore": before, "retiredChunksBefore": retired, "collectedUnreferencedChunks": collected, "bytes": path.stat().st_size, "confirmed": True}
