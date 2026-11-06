"""The Full package record store: containment, durable evidence, claims and recovery.

Test names carry the v0.3.4 review evidence keys so each reproduced defect stays fixed.
"""
import hashlib
import os
import sqlite3
from pathlib import Path

import pytest

from research_stack import records
from research_stack.records import StoreError

NOTES = "notes/dissertation.md"
OTHER = "notes/methods.md"


def workspace(tmp_path: Path) -> Path:
    (tmp_path / "notes").mkdir()
    (tmp_path / NOTES).write_text(
        "# Dissertation\n\nBarefoot sandals appear in the 14th-century illuminations. "
        "The stitching pattern is documented in the guild records.\n" * 4,
        encoding="utf-8",
    )
    (tmp_path / OTHER).write_text("# Methods\n\nBM25 ranking over the stored chunks with provenance.\n", encoding="utf-8")
    return tmp_path


def test_reading_an_uninitialised_store_is_an_actionable_error(tmp_path):
    with pytest.raises(StoreError) as failure:
        records.index_state(tmp_path)
    assert "STORE_MISSING" in str(failure.value)
    assert records.store_path(tmp_path).parent.name == "store"
    assert not records.store_path(tmp_path).exists(), "the store file is created by the reviewed step, not by a read"


def test_init_creates_the_reviewed_schema_once_and_never_replaces_rows(tmp_path):
    root = workspace(tmp_path)
    first = records.init_store(root)
    assert first["ok"] is True and first["preexisting"] is False
    assert first["schemaVersion"] == records.SCHEMA_VERSION
    assert first["tableCount"] == 8, "schema 3 adds index_runs: one row per ingestion call"
    assert set(first["tables"]) == {"claims", "claim_evidence", "claim_events", "chunks", "index_runs", "meta", "source_versions", "sources"}
    records.index_corpus(root, [NOTES])
    again = records.init_store(root)
    assert again["preexisting"] is True
    assert again["counts"]["chunks"] > 0, "initialisation does not wipe an existing index"
    assert records.store_path(root).is_file()


def test_indexing_stores_provenance_and_leaves_source_files_untouched(tmp_path):
    root = workspace(tmp_path)
    before = hashlib.sha256((root / NOTES).read_bytes()).hexdigest()
    result = records.index_corpus(root, [NOTES, OTHER])
    assert result["indexedSources"] == [NOTES, OTHER]
    assert result["chunksStored"] >= 2 and result["storeChunks"] == result["chunksStored"]
    assert len(result["indexFingerprint"]) == 64 and result["sourceFilesModified"] is False
    assert hashlib.sha256((root / NOTES).read_bytes()).hexdigest() == before

    state = records.index_state(root)
    assert state["sourceCount"] == 2 and state["chunkCount"] == result["chunksStored"]
    assert state["indexFingerprint"] == result["indexFingerprint"]
    stored = records.stored_chunks(root)
    assert {chunk.source_path for chunk in stored} == {NOTES, OTHER}
    for chunk in stored:
        assert chunk.source_version_id and chunk.locator and chunk.chunker_id
        assert hashlib.sha256(chunk.text.encode("utf-8")).hexdigest() == chunk.text_sha256
        assert chunk.chunk_id and chunk.content_id


def test_reindexing_one_source_keeps_the_others(tmp_path):
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES, OTHER])
    (root / NOTES).write_text("# Dissertation\n\nA revised claim about the guild records.\n", encoding="utf-8")
    before = records.index_state(root)["indexFingerprint"]
    result = records.index_corpus(root, [NOTES])
    state = records.index_state(root)
    assert state["sourceCount"] == 2, "a partial re-index must not drop the rest of the index"
    assert state["indexFingerprint"] != before, "the fingerprint must change when a source changes"
    assert result["indexFingerprint"] == state["indexFingerprint"]
    assert {source["path"] for source in state["sources"]} == {NOTES, OTHER}
    removed = records.remove_sources(root, [OTHER, "notes/never-indexed.md"])
    assert removed["removedSources"] == [OTHER] and removed["notIndexed"] == ["notes/never-indexed.md"]
    assert {source["path"] for source in records.index_state(root)["sources"]} == {NOTES}


def test_search_returns_ranked_hits_with_source_path_locator_and_hashes(tmp_path):
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES, OTHER])
    hits = records.search_corpus(root, "guild records stitching", limit=3)
    assert hits and hits[0].chunk.source_path and hits[0].chunk.locator.startswith("paragraph=")
    assert hits[0].retrieval_method == "bm25"
    assert len(hits[0].chunk.chunk_id) == 64 and len(hits[0].chunk.text_sha256) == 64


def test_duplicateContent_indexes_identical_bytes_at_two_paths(tmp_path):
    """F03: identical content at two paths is two traceable occurrences, not a constraint failure."""
    root = workspace(tmp_path)
    (root / "notes" / "copy.md").write_bytes((root / NOTES).read_bytes())
    result = records.index_corpus(root, [NOTES, "notes/copy.md"])
    assert set(result["indexedSources"]) == {NOTES, "notes/copy.md"}
    state = records.index_state(root)
    assert state["sourceCount"] == 2
    counts = {source["path"]: source["chunk_count"] for source in state["sources"]}
    assert counts[NOTES] == counts["notes/copy.md"] > 0
    stored = records.stored_chunks(root)
    ids = [chunk.chunk_id for chunk in stored]
    assert len(ids) == len(set(ids)), "occurrence ids stay unique for identical content"
    by_content = {}
    for chunk in stored:
        by_content.setdefault(chunk.content_id, set()).add(chunk.source_path)
    assert any(len(paths) == 2 for paths in by_content.values()), "content identity still links the duplicates"


def test_emptyReindex_removes_the_stale_membership_and_reports_the_empty_source(tmp_path):
    """F04: an emptied source must stop being searchable."""
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    (root / NOTES).write_text(" \n\n", encoding="utf-8")
    result = records.index_corpus(root, [NOTES])
    assert result["emptySources"] == [NOTES]
    assert result["indexedSources"] == [NOTES]
    assert not records.search_corpus(root, "guild"), "the old text is no longer part of the current index"
    state = records.index_state(root)
    source = next(item for item in state["sources"] if item["path"] == NOTES)
    assert source["chunk_count"] == 0 and source["bytes"] > 0, "the inventory keeps the source even with no chunks"


def test_danglingEvidenceAfterReindex_keeps_claim_evidence_resolvable_and_flagged(tmp_path):
    """F02: re-indexing must not destroy the evidence a claim still cites."""
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    chunk_id = records.stored_chunks(root)[0].chunk_id
    claim = records.write_claim(root, "Guild records support this claim.", status="supported", evidence_chunk_ids=[chunk_id])["claim"]
    (root / NOTES).write_text("New contradictory material.", encoding="utf-8")
    records.index_corpus(root, [NOTES])

    after = records.read_claims(root)["claims"][0]
    link = after["evidence"][0]
    assert link["chunk_id"] == chunk_id
    assert link["resolvable"] is True, "retained evidence stays resolvable"
    assert link["current"] is False and link["stale"] is True, "the link is flagged as historical"
    assert link["sourcePath"] == NOTES and len(link["textSha256"]) == 64
    assert after["staleEvidenceCount"] == 1
    assert "recorded assessment" in records.read_claims(root)["assessment"]

    resolved = records.get_chunks(root, [chunk_id])
    assert resolved and resolved[0]["text"].startswith("# Dissertation"), "the retained chunk still carries its text"
    assert not any(hit.chunk.chunk_id == chunk_id for hit in records.search_corpus(root, "guild records")), "retired evidence is not searchable as current"

    records.write_claim(root, "New open question.")
    supported = records.read_claims(root, status="supported", limit=1)["claims"]
    assert supported and supported[0]["claim_id"] == claim["claim_id"]


def test_removeSources_retains_cited_evidence_and_collects_the_rest(tmp_path):
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES, OTHER])
    chunk_id = records.stored_chunks(root)[0].chunk_id
    records.write_claim(root, "A claim that must keep its evidence.", evidence_chunk_ids=[chunk_id])
    removed = records.remove_sources(root, [NOTES, OTHER])
    assert removed["removedSources"] == [NOTES, OTHER]
    assert removed["retainedEvidenceChunks"] >= 1
    state = records.index_state(root)
    assert state["sourceCount"] == 0 and state["chunkCount"] == 0
    assert state["retainedChunkCount"] >= 1
    assert records.get_chunks(root, [chunk_id])[0]["resolvable"] is True


def test_claimFiltering_filters_before_limiting_and_pages_with_a_cursor(tmp_path):
    """F14: status filtering happens in SQL, and every stored claim is reachable."""
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    chunk_id = records.stored_chunks(root)[0].chunk_id
    records.write_claim(root, "A supported claim about the guild records.", status="supported", evidence_chunk_ids=[chunk_id])
    records.write_claim(root, "A newer open question.")
    filtered = records.read_claims(root, status="supported", limit=1)
    assert filtered["claimCount"] == 1 and filtered["claims"][0]["status"] == "supported"
    assert filtered["matchingClaimCount"] == 1

    seen = set()
    cursor = None
    for _ in range(10):
        page = records.read_claims(root, limit=1, cursor=cursor)
        seen.update(claim["claim_id"] for claim in page["claims"])
        cursor = page["nextCursor"]
        if not cursor:
            break
    assert len(seen) == 2, "pagination reaches every claim"


def test_sameSecondClaim_is_collision_safe_and_idempotent_retries_return_the_claim(tmp_path):
    """F14: identical statements in the same second must not fail, and retries must not duplicate."""
    root = workspace(tmp_path)
    first = records.write_claim(root, "Same claim")
    second = records.write_claim(root, "Same claim")
    assert first["claim"]["claim_id"] != second["claim"]["claim_id"]
    third = records.write_claim(root, "Same claim", idempotency_key="retry-1")
    fourth = records.write_claim(root, "Same claim", idempotency_key="retry-1")
    assert third["created"] is True
    assert fourth["created"] is False and fourth["idempotent"] is True and fourth["claim"]["claim_id"] == third["claim"]["claim_id"]
    assert records.read_claims(root)["claimCount"] == 3


def test_claim_evidence_roles_modes_and_history(tmp_path):
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES, OTHER])
    first, second = (chunk.chunk_id for chunk in records.stored_chunks(root)[:2])
    written = records.write_claim(root, "The stitching pattern is documented.", status="supported",
                                  evidence_chunk_ids=[first], evidence_role="supporting", evidence_rationale="Direct statement in the guild records.")
    claim_id = written["claim"]["claim_id"]
    records.write_claim(root, "The stitching pattern is documented.", claim_id=claim_id,
                        evidence_chunk_ids=[second], evidence_role="contradicting", evidence_rationale="The methods note disputes the dating.")
    claim = records.read_claims(root, claim_id=claim_id)["claims"][0]
    roles = {link["role"] for link in claim["evidence"]}
    assert roles == {"supporting", "contradicting"}
    assert all(link["rationale"] for link in claim["evidence"])

    records.write_claim(root, "The stitching pattern is documented.", claim_id=claim_id, evidence_chunk_ids=[second], evidence_mode="remove")
    claim = records.read_claims(root, claim_id=claim_id)["claims"][0]
    assert [link["chunk_id"] for link in claim["evidence"]] == [first]

    records.write_claim(root, "Revised statement.", claim_id=claim_id)
    claim = records.read_claims(root, claim_id=claim_id)["claims"][0]
    assert claim["status"] == "supported", "an omitted status keeps its stored value"
    kinds = [event["kind"] for event in claim["history"]]
    assert "created" in kinds and "updated" in kinds and "evidence-added" in kinds and "evidence-removed" in kinds


def test_claims_link_to_stored_chunks_and_reject_invented_evidence(tmp_path):
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    chunk_id = records.stored_chunks(root)[0].chunk_id
    result = records.write_claim(root, "Barefoot sandals appear in the illuminations.", evidence_chunk_ids=[chunk_id])
    assert result["created"] is True and result["claim"]["evidence"][0]["chunk_id"] == chunk_id
    with pytest.raises(StoreError) as failure:
        records.write_claim(root, "A claim with no source.", evidence_chunk_ids=["not-a-real-chunk"])
    assert "EVIDENCE_NOT_FOUND" in str(failure.value)
    assert records.read_claims(root)["claimCount"] == 1, "the rejected write left no second claim behind"


def test_claim_input_limits_are_enforced(tmp_path):
    root = workspace(tmp_path)
    for statement, code in ((None, "CLAIM_EMPTY"), ("", "CLAIM_EMPTY"), ("x" * 2001, "CLAIM_TOO_LONG")):
        with pytest.raises(StoreError) as failure:
            records.write_claim(root, statement)
        assert code in str(failure.value)
    records.write_claim(root, "A valid claim")
    with pytest.raises(StoreError) as failure:
        records.read_claims(root, limit=500)
    assert "CLAIM_LIMIT" in str(failure.value)
    with pytest.raises(StoreError) as failure:
        records.read_claims(root, status="maybe")
    assert "CLAIM_STATUS" in str(failure.value)
    with pytest.raises(StoreError) as failure:
        records.write_claim(root, "A claim", status="maybe")
    assert "CLAIM_STATUS" in str(failure.value)
    with pytest.raises(StoreError) as failure:
        records.write_claim(root, "A claim", note="x" * 4001)
    assert "CLAIM_NOTE_TOO_LONG" in str(failure.value)
    with pytest.raises(StoreError) as failure:
        records.write_claim(root, "A claim", evidence_chunk_ids=["x"] * 201)
    assert "EVIDENCE_LIMIT" in str(failure.value)
    with pytest.raises(StoreError) as failure:
        records.write_claim(root, "A claim", claim_id="missing")
    assert "CLAIM_NOT_FOUND" in str(failure.value)
    with pytest.raises(StoreError) as failure:
        records.write_claim(root, "A claim", evidence_role="opinion")
    assert "EVIDENCE_ROLE" in str(failure.value)
    with pytest.raises(StoreError) as failure:
        records.read_claims(root, cursor="not-a-cursor")
    assert "CLAIM_CURSOR_INVALID" in str(failure.value)


def test_reindex_preview_reports_changes_without_writing(tmp_path):
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES, OTHER])
    (root / OTHER).write_text("# Methods\n\nA revised method about BM25 ranking.\n", encoding="utf-8")
    before = records.store_path(root).read_bytes()
    preview = records.reindex_preview(root, [NOTES, OTHER])
    assert preview["written"] is False and preview["preview"] is True
    assert preview["changedSources"] == [OTHER] and preview["unchangedSources"] == [NOTES]
    assert preview["sources"][OTHER]["currentChunks"] >= 1 and preview["sources"][OTHER]["newChunks"] >= 1
    assert records.store_path(root).read_bytes() == before, "a preview writes nothing"


def test_previewOnFreshWorkspace_creates_no_store(tmp_path):
    """F13: a preview must not create a database in a workspace that has none."""
    root = workspace(tmp_path)
    preview = records.reindex_preview(root, [NOTES])
    assert preview["written"] is False and preview["storePresent"] is False
    assert not records.store_path(root).exists(), "the preview created a store"


def test_readRepairsDatabase_leaves_the_file_byte_identical(tmp_path):
    """F13: reads are read-only; a missing metadata row is reported, not repaired."""
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("DELETE FROM meta WHERE key = 'created_at'")
    connection.commit()
    connection.close()
    before = records.store_path(root).read_bytes()
    read = records.read_claims(root)
    assert read["claimCount"] == 0
    assert records.store_path(root).read_bytes() == before, "a read changed the store file"


def test_futureSchema_is_refused_before_any_mutation(tmp_path):
    """F13: an unknown newer schema is never silently relabelled."""
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("UPDATE meta SET value = '999' WHERE key = 'schema_version'")
    connection.commit()
    connection.close()
    before = records.store_path(root).read_bytes()
    with pytest.raises(StoreError) as failure:
        records.init_store(root)
    assert "STORE_SCHEMA_UNSUPPORTED" in str(failure.value)
    with pytest.raises(StoreError) as read_failure:
        records.read_claims(root)
    assert "STORE_SCHEMA_UNSUPPORTED" in str(read_failure.value)
    assert records.store_path(root).read_bytes() == before, "refusing an unsupported schema must not change the file"


def test_schema_migration_from_version_one_preserves_the_index(tmp_path):
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("UPDATE meta SET value = '1' WHERE key = 'schema_version'")
    connection.execute("DROP TABLE source_versions")
    connection.execute("DROP TABLE claim_events")
    connection.execute("DROP INDEX IF EXISTS claims_idempotency_idx")
    connection.execute("DROP INDEX IF EXISTS chunks_content_idx")
    connection.execute("DROP INDEX IF EXISTS chunks_current_idx")
    connection.execute("ALTER TABLE claims DROP COLUMN idempotency_key")
    connection.execute("ALTER TABLE claim_evidence DROP COLUMN role")
    connection.execute("ALTER TABLE claim_evidence DROP COLUMN rationale")
    connection.execute("ALTER TABLE chunks DROP COLUMN content_id")
    connection.execute("ALTER TABLE chunks DROP COLUMN current")
    connection.commit()
    connection.close()
    migrated = records.init_store(root)
    assert migrated["schemaVersion"] == records.SCHEMA_VERSION
    state = records.index_state(root)
    assert state["schemaVersion"] == records.SCHEMA_VERSION and state["chunkCount"] >= 1
    assert records.search_corpus(root, "guild records"), "the migrated index is still searchable"


def test_store_junction_cannot_redirect_the_store_outside_the_workspace(tmp_path):
    """F01: a linked store path is refused instead of followed."""
    root = workspace(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    store_directory = root / ".research-toolkit" / "store"
    store_directory.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(str(outside), str(store_directory), target_is_directory=True)
    with pytest.raises(StoreError) as failure:
        records.index_corpus(root, [NOTES])
    assert "PATH_IS_LINK" in str(failure.value)
    assert not list(outside.iterdir()), "nothing was written through the link"


def test_a_corrupt_store_is_reported_as_corrupt_not_as_a_protocol_error(tmp_path):
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    records.store_path(root).write_bytes(b"definitely not a sqlite database")
    with pytest.raises(StoreError) as failure:
        records.read_claims(root)
    assert "STORE_CORRUPT" in str(failure.value)


def test_maintenance_backs_up_new_files_only_and_blocks_an_unconfirmed_vacuum(tmp_path, monkeypatch):
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    monkeypatch.setattr(records, "_now", lambda: "2026-10-31T12:00:00+00:00")
    first = records.maintenance(root, "backup")
    records.write_claim(root, "A claim added between the two backups.")
    second = records.maintenance(root, "backup")
    assert first["backup"] != second["backup"], "same-second backups must not overwrite each other"
    assert first["writeMode"] == "new-file-only" and second["writeMode"] == "new-file-only"
    assert Path(first["backup"]).is_file() and Path(second["backup"]).is_file()
    assert first["integrityCheck"] == "ok" and second["integrityCheck"] == "ok"
    assert first["sha256"] == hashlib.sha256(Path(first["backup"]).read_bytes()).hexdigest()
    assert first["counts"]["claims"] == 0 and second["counts"]["claims"] == 1, "each snapshot keeps its own state"
    assert first["schemaVersion"] == records.SCHEMA_VERSION

    status = records.maintenance(root, "status")
    assert status["action"] == "status" and status["chunkCount"] > 0 and status["store"] == str(records.store_path(root))
    assert status["backupCount"] == 2

    with pytest.raises(StoreError) as failure:
        records.maintenance(root, "vacuum")
    assert "CONFIRM_REQUIRED" in str(failure.value)
    vacuumed = records.maintenance(root, "vacuum", confirm=True)
    assert vacuumed["confirmed"] is True and vacuumed["chunksBefore"] > 0
    assert records.index_state(root)["chunkCount"] == vacuumed["chunksBefore"], "vacuum must not remove current chunks"

    with pytest.raises(StoreError) as failure:
        records.maintenance(root, "delete-everything")
    assert "STORE_ACTION" in str(failure.value)


def test_restore_stages_a_candidate_then_activates_it_and_preserves_the_previous_store(tmp_path):
    """F05: restore is a validated candidate with explicit activation, not a blind overwrite."""
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    backup = records.maintenance(root, "backup")
    records.write_claim(root, "A claim that the restore will discard.")
    assert records.read_claims(root)["claimCount"] == 1

    staged = records.maintenance(root, "restore", backup_path=backup["backup"])
    assert staged["activated"] is False and staged["stagedOnly"] is True
    assert Path(staged["candidate"]).is_file() and staged["validated"]["integrityCheck"] == "ok"
    assert records.read_claims(root)["claimCount"] == 1, "an unconfirmed restore leaves the live store alone"

    activated = records.maintenance(root, "restore", backup_path=backup["backup"], confirm=True)
    assert activated["activated"] is True
    assert Path(activated["previousStorePreserved"]).is_file(), "the previous live store is preserved"
    assert records.read_claims(root)["claimCount"] == 0, "the restored store reflects the backup"
    assert records.index_state(root)["chunkCount"] >= 1

    with pytest.raises(StoreError) as failure:
        records.maintenance(root, "restore")
    assert "RESTORE_SOURCE_REQUIRED" in str(failure.value)
    with pytest.raises(StoreError) as failure:
        records.maintenance(root, "restore", backup_path=str(root / "nope.sqlite3"))
    assert "RESTORE_SOURCE_MISSING" in str(failure.value)


def test_export_claims_produces_validated_references_and_reports_unresolved_evidence(tmp_path):
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    chunk_id = records.stored_chunks(root)[0].chunk_id
    claim = records.write_claim(root, "The guild records document the stitching pattern.", status="supported", evidence_chunk_ids=[chunk_id])["claim"]
    exported = records.export_claims(root, [claim["claim_id"], "missing-claim"])
    assert exported["unresolvedClaims"] == ["missing-claim"]
    reference = exported["references"][0]
    assert reference["reference"] == NOTES and len(reference["sha256"]) == 64 and reference["locator"].startswith("paragraph=")
    assert reference["role"] == "supporting" and reference["current"] is True

    (root / NOTES).write_text("Replaced content.", encoding="utf-8")
    records.index_corpus(root, [NOTES])
    after = records.export_claims(root, [claim["claim_id"]])
    assert after["references"] == [] and after["excludedStaleReferences"] == 1
    assert records.export_claims(root, [claim["claim_id"]], include_stale=True)["references"][0]["current"] is False


def test_index_limits_and_source_errors_stay_actionable(tmp_path):
    """0.3.9 separates the two kinds of failure a batch can have.

    A malformed request (no paths, a path that escapes the root) is refused for the whole call. A
    file that cannot be read is a per-file outcome in the receipt, because one unreadable file must
    not block the files that did read — and the error code still travels unchanged.
    """
    root = workspace(tmp_path)
    with pytest.raises(StoreError) as failure:
        records.index_corpus(root, [])
    assert "SOURCE_COUNT" in str(failure.value)
    with pytest.raises(StoreError) as failure:
        records.index_corpus(root, ["../outside.md"])
    assert "SOURCE_OUTSIDE_ROOT" in str(failure.value)

    mixed = records.index_corpus(root, [NOTES, "notes/missing.md"])
    assert mixed["status"] == "partial" and mixed["indexedSources"] == [NOTES] and mixed["written"] == 1
    assert mixed["failedSources"] == [{"path": "notes/missing.md", "code": "SOURCE_NOT_FOUND",
                                       "message": "selected file is missing or is not a file.",
                                       "outcome": "failed", "keptPreviousVersion": True}]

    refused = records.index_corpus(root, ["notes/notes.doc"])
    assert refused["status"] == "failed" and refused["written"] == 0 and refused["indexedSources"] == []
    assert refused["failedSources"][0]["code"] == "UNSUPPORTED_FORMAT"

    with pytest.raises(StoreError) as failure:
        records.get_chunks(root, [])
    assert "CHUNK_IDS" in str(failure.value)


def test_backupDirectoryJunction_cannot_move_store_backups_outside_the_workspace(tmp_path):
    """T5-01: the backup destination is guarded by the same containment policy as the store."""
    root = workspace(tmp_path)
    records.init_store(root)
    outside = tmp_path / "outside-backups"
    outside.mkdir()
    backups = root / ".research-toolkit" / "store" / "backups"
    backups.parent.mkdir(parents=True, exist_ok=True)
    os.symlink(str(outside), str(backups), target_is_directory=True)
    with pytest.raises(StoreError) as failure:
        records.maintenance(root, "backup")
    assert "PATH_IS_LINK" in str(failure.value)
    assert not list(outside.iterdir()), "no backup was written through the link"


def test_a_locked_store_reports_STORE_BUSY_instead_of_a_raw_driver_error(tmp_path):
    """T5-09: a busy store is an actionable envelope code, not a SQLite traceback."""
    root = workspace(tmp_path)
    records.init_store(root)
    holder = sqlite3.connect(records.store_path(root))
    holder.execute("BEGIN IMMEDIATE")
    holder.execute("INSERT INTO claims (claim_id, statement, status, created_at, updated_at) VALUES (?,?,?,?,?)",
                   ("holder-1", "Holding the write lock", "open", "2026-10-31T12:00:00+00:00", "2026-10-31T12:00:00+00:00"))
    try:
        with pytest.raises(StoreError) as failure:
            records.write_claim(root, "Blocked claim")
        assert "STORE_BUSY" in str(failure.value)
    finally:
        holder.rollback()
        holder.close()
    assert records.read_claims(root)["claimCount"] == 0, "the blocked write left no partial state"
