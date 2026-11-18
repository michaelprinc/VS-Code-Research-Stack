"""v0.3.9 migration: a real 0.3.8 store, opened by 0.3.9 code, plus backup and rollback.

The store under test is produced by the code at the `v0.3.8` tag, exported from this repository
into a disposable directory. Nothing here opens a user's store, and no source file is modified.
"""
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from research_stack import records

REPO = Path(__file__).resolve().parents[1]
LEGACY_TAG = "v0.3.8"
#: The release 0.3.13 commit this release's migration has to open: schema 3, no vector table.
BASELINE_COMMIT = "6719415"
NOTES = "notes/dissertation.md"
BODY = ("# Dissertation\n\nBarefoot sandals appear in the 14th-century illuminations. "
        "The stitching pattern is documented in the guild records.\n") * 3

LEGACY_SCRIPT = textwrap.dedent("""
    import json, sys
    from research_stack import records
    root = sys.argv[1]
    records.init_store(root)
    indexed = records.index_corpus(root, ["notes/dissertation.md"])
    stored = records.stored_chunks(root)
    claim = records.write_claim(root, "The guild records document the stitching pattern.",
                                evidence_chunk_ids=[stored[0].chunk_id])
    state = records.index_state(root)
    print(json.dumps({
        "schema": state["schemaVersion"],
        "chunkIds": [chunk.chunk_id for chunk in stored],
        "claimId": claim["claim"]["claim_id"],
        "chunkCount": state["chunkCount"],
        "indexFingerprint": state["indexFingerprint"],
        "indexed": indexed["indexFingerprint"],
    }))
""")


def legacy_source_tree(tmp_path: Path, revision: str = LEGACY_TAG) -> Path:
    """Export a release's source tree, so the store under test really was written by that release."""
    archive = subprocess.run(["git", "-C", str(REPO), "archive", revision, "src/research_stack"], capture_output=True)
    if archive.returncode != 0:
        pytest.skip(f"the {revision} tree is not available from this checkout: {archive.stderr.decode(errors='replace')[:200]}")
    tree = tmp_path / f"legacy-{revision[:8]}"
    tree.mkdir(parents=True, exist_ok=True)
    unpack = subprocess.run(["tar", "-x", "-C", str(tree)], input=archive.stdout, capture_output=True)
    if unpack.returncode != 0:
        pytest.skip("the release revision could not be unpacked")
    return tree / "src"


def legacy_workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "workspace"
    (workspace / "notes").mkdir(parents=True)
    (workspace / NOTES).write_text(BODY, encoding="utf-8")
    return workspace


def _real_tables(connection: sqlite3.Connection) -> set[str]:
    """The tables the store itself created, without SQLite's internal bookkeeping tables."""
    return {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'") if not row[0].startswith("sqlite_")}


def build_0_3_8_store(tmp_path: Path) -> tuple[Path, dict]:
    source = legacy_source_tree(tmp_path)
    workspace = legacy_workspace(tmp_path)
    result = subprocess.run([sys.executable, "-B", "-c", LEGACY_SCRIPT, str(workspace)],
                            cwd=str(workspace), capture_output=True, text=True,
                            env={**os.environ, "PYTHONPATH": str(source)})
    if result.returncode != 0:
        pytest.fail(f"the 0.3.8 code could not build the store: {result.stderr[-400:]}")
    built = json.loads(result.stdout)
    assert built["schema"] == 2, "the fixture must be a genuine 0.3.8 store"
    return workspace, built


def build_0_3_13_store(tmp_path: Path) -> tuple[Path, dict]:
    """A store written by the release this one follows (commit 6719415, schema 3, no vector table)."""
    source = legacy_source_tree(tmp_path, BASELINE_COMMIT)
    workspace = legacy_workspace(tmp_path)
    result = subprocess.run([sys.executable, "-B", "-c", LEGACY_SCRIPT, str(workspace)],
                            cwd=str(workspace), capture_output=True, text=True,
                            env={**os.environ, "PYTHONPATH": str(source)})
    if result.returncode != 0:
        pytest.fail(f"the 0.3.13 code could not build the store: {result.stderr[-400:]}")
    built = json.loads(result.stdout)
    assert built["schema"] == 3, "the fixture must be a genuine 0.3.13 store"
    return workspace, built


def test_a_0_3_8_store_is_refused_for_reading_until_the_component_step_migrates_it(tmp_path: Path) -> None:
    root, legacy = build_0_3_8_store(tmp_path)

    with pytest.raises(records.StoreError) as refusal:
        records.index_state(root)
    assert "STORE_SCHEMA_UPGRADE_REQUIRED" in str(refusal.value)
    assert "schema version 2" in str(refusal.value)

    migrated = records.init_store(root)
    assert migrated["ok"] is True and migrated["preexisting"] is True
    assert migrated["schemaVersion"] == 4 and migrated["tableCount"] == 9

    state = records.index_state(root)
    assert state["schemaVersion"] == records.SCHEMA_VERSION == 4
    assert state["chunkCount"] == legacy["chunkCount"]
    assert {source["path"] for source in state["sources"]} == {NOTES}

    connection = sqlite3.connect(records.store_path(root))
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "index_runs" in tables
    row = connection.execute("SELECT outcome, verification, kind, unit, last_verified_at FROM sources").fetchone()
    assert row == ("legacy", "unchecked", "text", "paragraph", None), (
        "a migrated row is labelled legacy and unchecked; it is never back-filled with claims about freshness")
    stored_ids = {chunk_id for (chunk_id,) in connection.execute("SELECT chunk_id FROM chunks")}
    connection.close()
    assert set(legacy["chunkIds"]) <= stored_ids, "migration must not change a stored chunk identity"

    claim = records.read_claims(root, claim_id=legacy["claimId"])
    link = claim["claims"][0]["evidence"][0]
    assert link["resolvable"] is True and link["stale"] is False
    assert link["sourceVerification"] == "unchecked"
    assert state["freshness"] == {"unchecked": 1}


def test_the_migration_runs_once_and_a_second_open_changes_nothing(tmp_path: Path) -> None:
    root, legacy = build_0_3_8_store(tmp_path)
    records.init_store(root)
    connection = sqlite3.connect(records.store_path(root))
    columns = {row[1] for row in connection.execute("PRAGMA table_info(sources)")}
    runs = connection.execute("SELECT COUNT(*) FROM index_runs").fetchone()[0]
    version = connection.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()[0]
    connection.close()
    assert {"kind", "outcome", "verification", "parser_id", "units_total"} <= columns
    assert runs == 0 and version == "4"

    second = records.index_state(root)
    assert second["schemaVersion"] == 4 and second["chunkCount"] == legacy["chunkCount"]
    assert second["indexFingerprint"] == legacy["indexFingerprint"]


def test_a_migrated_source_is_only_verified_after_verify_sources_looks_at_the_file(tmp_path: Path) -> None:
    root, _legacy = build_0_3_8_store(tmp_path)
    records.init_store(root)

    checked = records.verify_sources(root)
    assert checked["verified"] == [NOTES] and checked["uncheckedRemaining"] == 0
    assert records.index_state(root)["freshness"] == {"verified": 1}

    (root / NOTES).write_text(BODY + "Written after 0.3.8 stored this version.\n", encoding="utf-8")
    assert records.verify_sources(root)["changed"] == [NOTES]


def test_reindexing_a_migrated_store_keeps_the_claim_on_its_original_evidence(tmp_path: Path) -> None:
    root, legacy = build_0_3_8_store(tmp_path)
    receipt = records.index_corpus(root, [NOTES])

    assert receipt["status"] == "complete" and receipt["written"] == 1
    connection = sqlite3.connect(records.store_path(root))
    current_ids = {chunk_id for (chunk_id,) in connection.execute("SELECT chunk_id FROM chunks WHERE current = 1")}
    retained = connection.execute("SELECT COUNT(*) FROM chunks WHERE current = 0").fetchone()[0]
    connection.close()
    assert set(legacy["chunkIds"]) == current_ids, (
        "the same Markdown bytes must produce the same chunk ids, or a stored claim loses its evidence")
    assert retained == 0

    link = records.read_claims(root, claim_id=legacy["claimId"])["claims"][0]["evidence"][0]
    assert link["resolvable"] is True and link["stale"] is False
    assert link["sourceVerification"] == "verified", "0.3.9 indexing hashed the bytes it read"


def test_backup_then_confirmed_restore_returns_the_pre_migration_store(tmp_path: Path) -> None:
    root, legacy = build_0_3_8_store(tmp_path)
    backup = records.maintenance(root, "backup")
    assert backup["action"] == "backup" and backup["integrityCheck"] == "ok"
    assert backup["schemaVersion"] == 2, "a 0.3.8 store must be backable up before any migration runs"
    assert backup["counts"]["index_runs"] == 0
    backup_file = Path(backup["backup"])
    assert backup_file.is_file()

    records.index_corpus(root, [NOTES])
    (root / "notes" / "second.md").write_text("# Second\n\nA second source added after the backup.\n", encoding="utf-8")
    records.index_corpus(root, ["notes/second.md"])
    grown = records.index_state(root)
    assert {source["path"] for source in grown["sources"]} == {NOTES, "notes/second.md"}

    staged = records.maintenance(root, "restore", backup_path=str(backup_file))
    assert staged["activated"] is False and staged["stagedOnly"] is True and staged["candidate"]
    assert {source["path"] for source in records.index_state(root)["sources"]} == {NOTES, "notes/second.md"}, (
        "staging a candidate must not change the live store")

    activated = records.maintenance(root, "restore", backup_path=str(backup_file), confirm=True)
    assert activated["activated"] is True and Path(activated["previousStorePreserved"]).is_file()

    with pytest.raises(records.StoreError) as refusal:
        records.index_state(root)
    assert "STORE_SCHEMA_UPGRADE_REQUIRED" in str(refusal.value), (
        "the activated store is the 0.3.8 backup, not the post-backup state")

    records.init_store(root)
    restored = records.index_state(root)
    assert {source["path"] for source in restored["sources"]} == {NOTES}
    assert restored["chunkCount"] == legacy["chunkCount"]
    connection = sqlite3.connect(records.store_path(root))
    runs = connection.execute("SELECT COUNT(*) FROM index_runs").fetchone()[0]
    outcome = connection.execute("SELECT outcome FROM sources").fetchone()[0]
    connection.close()
    assert runs == 0 and outcome == "legacy", "the restored store is the backup, not the post-backup state"

    claim = records.read_claims(root, claim_id=legacy["claimId"])
    assert claim["claims"][0]["evidence"][0]["resolvable"] is True


def test_a_restore_without_a_named_backup_is_refused_before_anything_is_staged(tmp_path: Path) -> None:
    root, _legacy = build_0_3_8_store(tmp_path)
    with pytest.raises(records.StoreError) as failure:
        records.maintenance(root, "restore")
    assert "RESTORE_SOURCE_REQUIRED" in str(failure.value)
    with pytest.raises(records.StoreError) as missing:
        records.maintenance(root, "restore", backup_path=str(root / "nope.sqlite3"))
    assert "RESTORE_SOURCE_MISSING" in str(missing.value)


def test_the_backup_file_is_a_snapshot_of_the_store_that_existed(tmp_path: Path) -> None:
    root, legacy = build_0_3_8_store(tmp_path)
    backup = records.maintenance(root, "backup")
    digest = hashlib.sha256(Path(backup["backup"]).read_bytes()).hexdigest()

    connection = sqlite3.connect(f"file:{backup['backup']}?mode=ro", uri=True)
    chunks = connection.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    stored_claim = connection.execute("SELECT COUNT(*) FROM claims").fetchone()[0]
    connection.close()
    assert chunks == legacy["chunkCount"] and stored_claim == 1
    assert digest, "the backup must be a real file whose bytes can be hashed"


def test_a_0_3_13_store_gains_the_vector_table_and_loses_no_row(tmp_path: Path) -> None:
    """T15-07/HR-04 groundwork: the store this release follows must open, migrate and keep every row."""
    root, built = build_0_3_13_store(tmp_path)
    tables_before = {"sources", "chunks", "claims", "claim_evidence", "claim_events", "index_runs", "meta", "source_versions"}

    connection = sqlite3.connect(records.store_path(root))
    before_tables = _real_tables(connection)
    before_counts = {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in sorted(tables_before - {"meta"})}
    connection.close()
    assert before_tables == tables_before, "the 0.3.13 store has no vector table to migrate"
    assert before_counts["chunks"] >= 1 and before_counts["claims"] == 1

    with pytest.raises(records.StoreError) as refusal:
        records.index_state(root)
    assert "STORE_SCHEMA_UPGRADE_REQUIRED" in str(refusal.value), "a schema-3 store is read-refused until the reviewed migration runs"

    migrated = records.init_store(root)
    assert migrated["schemaVersion"] == records.SCHEMA_VERSION == 4

    connection = sqlite3.connect(records.store_path(root))
    after_tables = _real_tables(connection)
    after_counts = {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in sorted(tables_before - {"meta"})}
    vectors = connection.execute("SELECT COUNT(*) FROM chunk_vectors").fetchone()[0]
    meta = {row[0]: row[1] for row in connection.execute("SELECT key, value FROM meta")}
    stored_ids = {row[0] for row in connection.execute("SELECT chunk_id FROM chunks")}
    connection.close()
    assert after_counts == before_counts, "an additive migration must neither lose a row nor invent one"
    assert after_tables == tables_before | {"chunk_vectors"}
    assert vectors == 0, "the migration adds the table; only a verb may compute vectors"
    assert meta["schema_version"] == "4" and meta["migrated_from"] == "3", (
        "the migration records where it came from instead of hiding it")
    assert set(built["chunkIds"]) <= stored_ids, "migration must not change a stored chunk identity"

    state = records.index_state(root)
    assert state["vectorSearch"]["state"] == "not-built" and state["vectorSearch"]["vectorCount"] == 0
    assert records.search_corpus(root, "guild records"), "the lexical path still works on a migrated 0.3.13 store"
    with pytest.raises(records.StoreError) as refusal:
        records.search_corpus(root, "guild records", mode="hybrid")
    assert "VECTORS_MISSING" in str(refusal.value) and "embed_corpus" in str(refusal.value), (
        "HR-06: the answer names the reason and the verb to run")

    rebuilt = records.embed_chunks(root)
    assert rebuilt["vectorsWritten"] == state["chunkCount"] and rebuilt["sourceFilesRead"] is False
    hits = records.search_corpus(root, "guild records", mode="hybrid")
    assert hits and hits[0].retrieval["backend"] == records.vectors.BACKEND_ID
