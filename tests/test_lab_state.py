"""``.research-toolkit/lab-state.json`` is derived from the store, not promised at setup (HR-05, T15-07, T15-08).

Each case re-reads the file from disk and compares it with a direct ``SELECT`` over the SQLite store
afterwards. A counter the file claims without the store backing it is the defect this file exists to
catch: 0.3.13 wrote the file once, in ``initialize_workspace``, and no store verb refreshed it.
"""
import json
import sqlite3
from pathlib import Path

from research_stack import lab_server, records
from research_stack.records import LAB_STATE_RELATIVE_PATH
from research_stack.workspace import init_lab_workspace

NOTES = "notes/dissertation.md"
OTHER = "notes/methods.md"


def workspace(tmp_path: Path) -> Path:
    (tmp_path / "notes").mkdir()
    (tmp_path / NOTES).write_text(
        "# Dissertation\n\nBarefoot sandals appear in the 14th-century illuminations. "
        "The stitching pattern is documented in the guild records.\n", encoding="utf-8")
    (tmp_path / OTHER).write_text("# Methods\n\nBM25 ranking over the stored chunks with provenance.\n", encoding="utf-8")
    return tmp_path


def lab_state(root: Path) -> dict:
    return json.loads((root / LAB_STATE_RELATIVE_PATH).read_text(encoding="utf-8"))


def select_counters(root: Path) -> dict[str, int]:
    """The numbers straight out of the store, with no toolkit code in the way."""
    connection = sqlite3.connect(records.store_path(root))
    try:
        return {
            "sources": connection.execute("SELECT COUNT(*) FROM sources").fetchone()[0],
            "chunks": connection.execute("SELECT COUNT(*) FROM chunks WHERE current = 1").fetchone()[0],
            "retainedChunks": connection.execute("SELECT COUNT(*) FROM chunks WHERE current = 0").fetchone()[0],
            "claims": connection.execute("SELECT COUNT(*) FROM claims").fetchone()[0],
            "claimEvidence": connection.execute("SELECT COUNT(*) FROM claim_evidence").fetchone()[0],
            "indexRuns": connection.execute("SELECT COUNT(*) FROM index_runs").fetchone()[0],
            "chunkVectors": connection.execute("SELECT COUNT(*) FROM chunk_vectors").fetchone()[0],
        }
    finally:
        connection.close()


def select_vector_state(root: Path) -> tuple[int, int]:
    """How many vector rows exist, and how many of them pass the current-backend check."""
    connection = sqlite3.connect(records.store_path(root))
    try:
        total = connection.execute("SELECT COUNT(*) FROM chunk_vectors").fetchone()[0]
        matching = connection.execute(
            "SELECT COUNT(*) FROM chunks c JOIN chunk_vectors v ON v.chunk_id = c.chunk_id "
            "WHERE c.current = 1 AND v.backend_id = ? AND v.dimensions = ? AND v.text_sha256 = c.text_sha256",
            (records.vectors.BACKEND_ID, records.vectors.EMBEDDING_DIMENSIONS),
        ).fetchone()[0]
        return total, matching
    finally:
        connection.close()


def test_init_lab_writes_a_derived_record_that_admits_being_derived(tmp_path: Path) -> None:
    root = tmp_path / "Research Workspace é"
    root.mkdir()
    report = init_lab_workspace(root)
    state = lab_state(root)
    assert report["profile"] == str(root / LAB_STATE_RELATIVE_PATH)
    assert state["derivedRecord"] is True
    assert "verify it with store_status" in state["deriveNote"], "the record must point at the real source of truth"
    assert state["schemaVersion"] == records.LAB_STATE_SCHEMA_VERSION == 2
    assert state["storeSchemaVersion"] == records.SCHEMA_VERSION
    assert state["counts"] == select_counters(root)
    assert state["refreshedBy"] == "initialize_workspace" and state["refreshedAt"]
    assert state["externalDatabases"] == "not-installed" and state["serviceMode"] == "local-stdio"


def test_every_store_writing_verb_refreshes_the_record_and_its_counters_are_true(tmp_path: Path) -> None:
    """T15-07: index_corpus, claims_write, unindex_corpus, verify_sources and store_maintenance."""
    root = workspace(tmp_path)
    init_lab_workspace(root)

    def check(verb: str) -> dict:
        state = lab_state(root)
        assert state["refreshedBy"] == verb, f"{verb} did not re-derive the record"
        assert state["counts"] == select_counters(root), f"{verb} left the record out of step with the store"
        total, matching = select_vector_state(root)
        assert state["vectorSearch"]["vectorCount"] == total
        assert state["vectorSearch"]["scoreableChunks"] == matching
        return state

    records.index_corpus(root, [NOTES, OTHER])
    indexed = check("index_corpus")
    assert indexed["counts"]["sources"] == 2 and indexed["counts"]["chunks"] >= 2
    assert indexed["counts"]["chunkVectors"] == indexed["vectorSearch"]["vectorCount"] >= 2

    chunk_id = records.search_corpus(root, "guild records")[0].chunk.chunk_id
    records.write_claim(root, "The guild records document the stitching pattern.",
                        evidence_chunk_ids=[chunk_id], status="supported")
    claimed = check("claims_write")
    assert claimed["counts"]["claims"] == 1 and claimed["counts"]["claimEvidence"] == 1

    records.verify_sources(root, [NOTES])
    check("verify_sources")

    backup = records.maintenance(root, "backup")
    assert backup["labState"]["refreshedBy"] == "store_maintenance:backup"
    check("store_maintenance:backup")

    vacuumed = records.maintenance(root, "vacuum", confirm=True)
    assert vacuumed["labState"]["refreshedBy"] == "store_maintenance:vacuum"
    check("store_maintenance:vacuum")

    records.remove_sources(root, [OTHER])
    removed = check("unindex_corpus")
    assert removed["counts"]["sources"] == 1 and removed["counts"]["chunks"] >= 1
    assert removed["counts"]["claims"] == 1, "the claim and its evidence link survive removing the source"


def test_store_status_reports_the_same_numbers_as_the_derived_record(tmp_path: Path) -> None:
    """HR-05: one set of numbers, two readers, so a reader can check one against the other."""
    root = workspace(tmp_path)
    init_lab_workspace(root)
    records.index_corpus(root, [NOTES, OTHER])
    chunk_id = records.search_corpus(root, "stitching")[0].chunk.chunk_id
    records.write_claim(root, "The stitching pattern is in the guild records.", evidence_chunk_ids=[chunk_id])

    state = lab_state(root)
    status = records.maintenance(root, "status")
    assert status["sourceCount"] == state["counts"]["sources"]
    assert status["chunkCount"] == state["counts"]["chunks"]
    assert status["retainedChunkCount"] == state["counts"]["retainedChunks"]
    assert status["claimCount"] == state["counts"]["claims"]
    assert status["vectorCount"] == state["counts"]["chunkVectors"]
    assert status["vectorSearch"] == state["vectorSearch"], "the two readers must not disagree about retrieval"
    assert status["schemaVersion"] == state["storeSchemaVersion"] == records.SCHEMA_VERSION


def test_the_record_states_the_retrieval_state_the_build_actually_has(tmp_path: Path) -> None:
    """T15-08: implemented, backend, dimensions, vector count, refreshedAt — no 'not-implemented' claim."""
    root = workspace(tmp_path)
    init_lab_workspace(root)
    before = lab_state(root)["vectorSearch"]
    assert before["state"] == "not-built" and before["implemented"] is True
    assert before["backendId"] == "rsk-hashing-v1" and before["dimensions"] == 256
    assert before["vectorCount"] == 0 and before["reindexVerb"] == "embed_corpus"
    assert "not-implemented" not in json.dumps(lab_state(root))

    records.index_corpus(root, [NOTES, OTHER])
    after = lab_state(root)["vectorSearch"]
    assert after["state"] == "ready" and after["vectorCount"] >= 2
    assert after["modes"] == ["lexical", "vector", "hybrid"]
    assert after["encoding"] == "base64-int16-le"
    assert after["currentChunkCount"] == lab_state(root)["counts"]["chunks"]



def test_the_record_separates_a_vector_that_matches_its_labels_from_one_a_query_can_decode(tmp_path: Path) -> None:
    """T16-04: the derived record reports what a query can actually read (HR-05).

    ``scoreableChunks`` used to be a metadata count: backend id, dimensions and the text hash matched,
    so a row with a truncated blob was reported as a usable vector, and the failure only appeared when
    a search tried to decode it. Expectation changed here (HR-41): the record now counts decodable
    vectors, names the difference as ``undecodableVectorCount``, and keeps the ceiling visible as
    ``chunkLimit`` / ``overLimit`` so a store bigger than the read paths will score is not presented as
    a store the read paths have scored.
    """
    root = workspace(tmp_path)
    init_lab_workspace(root)
    records.index_corpus(root, [NOTES, OTHER])

    state = lab_state(root)["vectorSearch"]
    assert state["metadataMatchChunks"] == state["scoreableChunks"] == state["currentChunkCount"]
    assert state["undecodableVectorCount"] == 0
    assert state["chunkLimit"] == records.MAX_STORE_CHUNKS and state["overLimit"] is False

    chunk_id = records.search_corpus(root, "stitching")[0].chunk.chunk_id
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("UPDATE chunk_vectors SET vector = ? WHERE chunk_id = ?", ("c3RvcmVkLWJ1dA", chunk_id))
    connection.commit()
    connection.close()
    records.refresh_lab_state(root, refreshed_by="test")

    state = lab_state(root)["vectorSearch"]
    assert state["metadataMatchChunks"] == state["currentChunkCount"], "the labels still match — that is the point"
    assert state["undecodableVectorCount"] == 1
    assert state["scoreableChunks"] == state["currentChunkCount"] - 1
    assert state["state"] == "partial"

    # The number the record reports is the number the search measured, not a count of rows.
    for mode in ("vector", "hybrid"):
        found = records.search_store(root, "stitching pattern", limit=10, mode=mode)
        assert found["retrieval"]["scoredChunks"] == state["scoreableChunks"]
    assert records.maintenance(root, "status")["vectorSearch"] == state, "both readers must agree about the same measurement"

def test_the_record_is_rewritten_over_any_edit_a_reader_made(tmp_path: Path) -> None:
    """The file is derived: an edit to it is not a fact the toolkit believes."""
    root = workspace(tmp_path)
    init_lab_workspace(root)
    records.index_corpus(root, [NOTES])
    path = root / LAB_STATE_RELATIVE_PATH
    tampered = json.loads(path.read_text(encoding="utf-8"))
    tampered["counts"]["claims"] = 99
    tampered["vectorSearch"]["state"] = "ready"
    tampered["refreshedBy"] = "a-hand-edit"
    path.write_text(json.dumps(tampered, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    records.write_claim(root, "A claim that re-derives the record.")
    state = lab_state(root)
    assert state["counts"]["claims"] == 1 and state["counts"] == select_counters(root)
    assert state["refreshedBy"] == "claims_write"


def test_a_read_verb_leaves_the_derived_record_alone(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    init_lab_workspace(root)
    records.index_corpus(root, [NOTES])
    written = (root / LAB_STATE_RELATIVE_PATH).read_bytes()

    records.maintenance(root, "status")
    records.search_corpus(root, "guild")
    records.search_corpus(root, "guild", mode="hybrid")
    records.read_claims(root)
    records.index_state(root)

    assert (root / LAB_STATE_RELATIVE_PATH).read_bytes() == written, "a read must not rewrite the record it reports on"


def test_a_store_on_an_older_schema_is_reported_instead_of_being_counted(tmp_path: Path) -> None:
    """The 0.3.6 guarantee stands: an unmigrated store is backed up, and nothing invents counters for it."""
    root = workspace(tmp_path)
    init_lab_workspace(root)
    records.index_corpus(root, [NOTES])

    connection = sqlite3.connect(records.store_path(root))
    connection.execute("UPDATE meta SET value = '3' WHERE key = 'schema_version'")
    connection.commit()
    connection.close()

    backup = records.maintenance(root, "backup")
    assert backup["labState"]["refreshed"] is False
    assert backup["labState"]["reason"] == "STORE_SCHEMA_UPGRADE_REQUIRED"
    assert "init-lab" in backup["labState"]["nextAction"]
    assert "did not measure" in backup["labState"]["message"]
    assert lab_state(root)["refreshedBy"] != "store_maintenance:backup", "no counters were written for a store this build cannot read"


def test_the_vector_counters_follow_a_rebuild_without_re_reading_a_source(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    init_lab_workspace(root)
    records.index_corpus(root, [NOTES, OTHER])
    source_before = (root / NOTES).read_bytes()

    connection = sqlite3.connect(records.store_path(root))
    connection.execute("DELETE FROM chunk_vectors")
    connection.commit()
    connection.close()
    # A hand-edit of the store is not a verb: the live read reports the truth immediately, while the
    # derived record only changes when a store verb re-derives it.
    assert records.index_state(root)["vectorSearch"]["vectorCount"] == 0

    built = records.embed_chunks(root)
    state = lab_state(root)
    assert built["sourceFilesRead"] is False
    assert state["refreshedBy"] == "embed_corpus"
    assert state["counts"] == select_counters(root)
    assert state["vectorSearch"]["state"] == "ready"
    assert (root / NOTES).read_bytes() == source_before, "re-embedding never touches the researcher's file"


def test_the_verb_surface_reports_the_same_derived_state_over_a_real_store(tmp_path: Path, monkeypatch) -> None:
    root = workspace(tmp_path)
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(root))
    indexed = lab_server.index_corpus([NOTES, OTHER])
    assert indexed["labState"]["path"] == LAB_STATE_RELATIVE_PATH
    state = lab_state(root)
    assert state["counts"] == select_counters(root)
    status = lab_server.store_status()
    assert status["vectorSearch"] == state["vectorSearch"]

    unindexed = lab_server.unindex_corpus([OTHER])
    assert unindexed["labState"]["refreshedBy"] == "unindex_corpus"
    assert lab_state(root)["counts"] == select_counters(root)
