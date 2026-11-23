"""The store ceiling measured from the read side (T16-04, carries DD9-12 forward).

``index_corpus`` has always refused a write that would take the store past ``MAX_STORE_CHUNKS``.
That fact was then *assumed* by every path that scores chunks: ``embed_chunks`` and the three search
modes each load with ``LIMIT MAX_STORE_CHUNKS``, and a ``LIMIT`` proves only that the call read at
most that many rows. A store that did not arrive through ``index_corpus`` — a restored backup, a
store repaired by hand, a store written by an older build — never met the write-side gate, and the
read paths would answer from the first 20 000 rows in index order (source path, locator, chunk id)
and present the ranking as if it covered the index. The operator would have no way to see that a
slice was scored, because nothing in the reply said so.

0.3.15 closes that gap: the ACTUAL number of current chunks is counted in the same SQLite snapshot
the chunks are read from, and a store over the ceiling is refused with ``STORE_OVER_LIMIT_READ``
before anything is loaded, with the count, the limit, what scoring a slice would have meant, and the
remediation. The counters in ``lab-state.json`` are checked against what a query really decodes, not
against what the row labels claim — the two are different facts and 0.3.14 reported only the second.

Why the fixtures are direct SQL. A 20 000-chunk store cannot be produced by ``index_corpus`` in a
test that is meant to finish: it would need a corpus of that size, and the point of these cases is a
store that got its chunks **outside** the indexing path. The fixture is therefore the store file
itself, written with the schema the migrated store has, at the exact boundary and one past it. Every
number in this file is exact: 20 000 is supported, 20 001 is refused, 20 500 retired rows are not a
limit violation at all.
"""
import sqlite3
from pathlib import Path

import pytest

from research_stack import records, vectors
from research_stack.records import StoreError

LIMIT = records.MAX_STORE_CHUNKS
assert LIMIT == 20_000, "the reviewed ceiling this file measures against"

# One short chunk text, reused for the whole fixture store. Identical text keeps the fixture cheap
# (one embedding, one encoded blob) without changing what the cases are about: the count, the ceiling
# and the refusal. Chunk identity still varies — different source path, locator and chunk id.
CHUNK_TEXT = "The guild records name the stitching pattern of barefoot sandals."


def _connect(root: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def _insert_chunks(connection: sqlite3.Connection, *, current: int, retired: int, blob: str, text_sha: str) -> None:
    """Write ``current`` live chunks and ``retired`` retained-evidence chunks straight into the store."""
    stamp = "2026-11-22T00:00:00+00:00"
    rows = []
    for group, is_current in (("live", 1), ("retired", 0)):
        wanted = current if is_current else retired
        for index in range(wanted):
            source_path = f"notes/fixture-{group}-{index // 1000}.md"
            rows.append((
                f"{group}-{index:06d}", f"content-{group}-{index:06d}", source_path, f"{index:064x}"[:64],
                f"paragraph={index % 1000};chars=0-{len(CHUNK_TEXT)}", CHUNK_TEXT, text_sha, "hashing:1200:120",
                len(CHUNK_TEXT), is_current, stamp, "paragraph", index % 1000, 0, len(CHUNK_TEXT),
            ))
    connection.executemany(
        "INSERT INTO chunks (chunk_id, content_id, source_path, source_sha256, locator, text, text_sha256, "
        "chunker_id, chars, current, indexed_at, unit_kind, unit_index, char_start, char_end) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", rows)
    if current:
        per_path: dict[str, list] = {}
        for row in rows:
            if row[9] == 1:
                per_path.setdefault(row[2], [row[3], 0])[1] += 1
        connection.executemany(
            "INSERT OR REPLACE INTO sources (path, source_sha256, bytes, chunk_count, indexed_at, outcome, verification) "
            "VALUES (?, ?, ?, ?, ?, 'complete', 'verified')",
            [(path, sha, 4096, chunk_count, stamp) for path, (sha, chunk_count) in sorted(per_path.items())],
        )
    if current and blob:
        connection.executemany(
            "INSERT INTO chunk_vectors (chunk_id, backend_id, dimensions, text_sha256, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [(row[0], vectors.BACKEND_ID, vectors.EMBEDDING_DIMENSIONS, text_sha, blob, stamp) for row in rows if row[9] == 1],
        )


def fixture_store(tmp_path: Path, *, current: int, retired: int = 0, with_vectors: bool = True) -> Path:
    """A schema-4 store with an exact number of current and retired chunks, built outside index_corpus."""
    records.init_store(tmp_path)
    text_sha = _text_sha(CHUNK_TEXT)
    blob = vectors.encode_vector(vectors.embed_text(CHUNK_TEXT)) if with_vectors else ""
    connection = _connect(tmp_path)
    try:
        _insert_chunks(connection, current=current, retired=retired, blob=blob, text_sha=text_sha)
        connection.commit()
    finally:
        connection.close()
    return tmp_path


def _text_sha(text: str) -> str:
    import hashlib
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def counts(root: Path) -> tuple[int, int]:
    connection = sqlite3.connect(records.store_path(root))
    try:
        current = connection.execute("SELECT COUNT(*) FROM chunks WHERE current = 1").fetchone()[0]
        retired = connection.execute("SELECT COUNT(*) FROM chunks WHERE current = 0").fetchone()[0]
    finally:
        connection.close()
    return current, retired


# The supported boundary -----------------------------------------------------------------------

def test_a_store_with_exactly_the_ceiling_of_current_chunks_is_supported_and_fully_scored(tmp_path: Path) -> None:
    """20 000 current chunks: the boundary itself, not a round number someone liked.

    The store is at the limit, so the ceiling must not refuse it and must not quietly score 19 999
    of it. Every reader — the query summary, the store status and the derived record — has to agree
    on 20 000, and a vector query has to decode 20 000 signatures, not 20 000 labels.
    """
    root = fixture_store(tmp_path, current=LIMIT)
    assert counts(root) == (LIMIT, 0)

    for mode in ("lexical", "vector", "hybrid"):
        found = records.search_store(root, "guild records stitching", limit=10, mode=mode)
        summary = found["retrieval"]
        assert summary is not None or mode == "lexical"
        if summary is not None:
            assert summary["currentChunks"] == LIMIT, "the ceiling must not truncate a store that is exactly at it"
            assert summary["scoredChunks"] == LIMIT, "every current chunk was decoded and scored, not a slice"
            assert summary["chunkLimit"] == LIMIT
        assert found["hits"], f"the {mode} mode returned nothing on a supported boundary store"

    status = records.maintenance(root, "status")
    assert status["chunkCount"] == LIMIT and status["retainedChunkCount"] == 0
    assert status["vectorSearch"]["currentChunkCount"] == LIMIT
    assert status["vectorSearch"]["scoreableChunks"] == LIMIT
    assert status["vectorSearch"]["undecodableVectorCount"] == 0
    assert status["vectorSearch"]["overLimit"] is False

    built = records.embed_chunks(root)
    assert built["currentChunks"] == LIMIT
    assert built["chunkAccounting"] == {
        "totalCurrentChunks": LIMIT, "embeddedNow": 0, "reusedExistingVector": LIMIT,
        "rebuiltUnreadableVector": 0, "noSignatureProduced": 0, "sumsToCurrentChunks": True,
    }, "at the ceiling the re-embed reuses every readable vector and pays for none of them"
    assert built["chunkLimit"] == LIMIT


# Over the ceiling -----------------------------------------------------------------------------

@pytest.mark.parametrize("mode", ["lexical", "vector", "hybrid"])
def test_one_chunk_past_the_ceiling_is_refused_by_every_search_mode(tmp_path: Path, mode: str) -> None:
    """20 001 current chunks: the same store, one chunk more, and no answer at all.

    The refusal has to name the numbers, because "the store is too big" does not tell an operator
    whether the store is one chunk over or twice over, nor what scoring a slice would have produced.
    """
    root = fixture_store(tmp_path, current=LIMIT + 1)
    assert counts(root) == (LIMIT + 1, 0)

    with pytest.raises(StoreError) as refusal:
        records.search_store(root, "guild records stitching", limit=10, mode=mode)
    message = str(refusal.value)
    assert message.startswith(records.STORE_OVER_LIMIT_READ_CODE)
    assert f"{LIMIT + 1} current chunks" in message and str(LIMIT) in message
    assert "slice" in message, "the consequence is named, not implied"
    assert "unindex_corpus" in message and "vacuum" in message, "the refusal carries the way back under the ceiling"
    detail = refusal.value.detail
    assert detail["currentChunkCount"] == LIMIT + 1 and detail["limit"] == LIMIT and detail["overBy"] == 1
    assert "first 20000" in detail["consequence"]
    assert any("unindex_corpus" in step for step in detail["remediation"])


def test_the_vector_and_hybrid_runtimes_refuse_before_any_chunk_is_decoded(tmp_path: Path) -> None:
    """``search_corpus`` is the shape a client uses; the refusal reaches it in all three modes."""
    root = fixture_store(tmp_path, current=LIMIT + 1)
    for mode in ("lexical", "vector", "hybrid"):
        with pytest.raises(StoreError) as refusal:
            records.search_corpus(root, "guild records stitching", limit=5, mode=mode)
        assert str(refusal.value).startswith(records.STORE_OVER_LIMIT_READ_CODE)

    with pytest.raises(StoreError) as refusal:
        records.embed_chunks(root)
    assert str(refusal.value).startswith(records.STORE_OVER_LIMIT_READ_CODE)
    assert refusal.value.detail["currentChunkCount"] == LIMIT + 1

    # The candidate loader and the shared chunk loader refuse on their own too: the guard is on the
    # read paths, not only on the verb that a client happens to call.
    with pytest.raises(StoreError) as refusal:
        records.stored_chunks(root)
    assert str(refusal.value).startswith(records.STORE_OVER_LIMIT_READ_CODE)


def test_an_over_ceiling_store_is_not_stuck_because_the_write_path_is_where_the_fix_happens(tmp_path: Path) -> None:
    """The refusal says how to get back under the ceiling; it does not freeze the store.

    ``index_corpus`` still answers with its own write-side name, and pruning retired evidence or
    removing a source is what brings the count down. A read refusal that offered no way back would
    be a dead end, which is the failure mode HR-06 rules out.
    """
    root = fixture_store(tmp_path, current=LIMIT + 1, retired=500)
    with pytest.raises(StoreError) as refusal:
        records.index_corpus(root, ["notes/live-0000.md"])
    assert str(refusal.value).startswith(records.STORE_CHUNK_LIMIT_CODE)

    status = records.maintenance(root, "status")
    assert status["vectorSearch"]["overLimit"] is True
    assert status["vectorSearch"]["currentChunkCount"] == LIMIT + 1
    assert status["retainedChunkCount"] == 500, "retired evidence is counted separately, and named in the remediation"


# Retired evidence does not consume the ceiling ------------------------------------------------

def test_retired_rows_past_the_ceiling_are_not_an_over_limit_store(tmp_path: Path) -> None:
    """20 500 rows in the table, 100 of them scoreable.

    Retired chunks are retained evidence a claim still cites; they are not index membership and were
    never meant to eat the ceiling. A guard that counted rows instead of current chunks would turn a
    normal, healthy store into one that refuses every query — which is exactly the kind of defect a
    limit fix can introduce, so it is asserted here in the direction that must NOT refuse.
    """
    root = fixture_store(tmp_path, current=100, retired=LIMIT + 500)
    assert counts(root) == (100, LIMIT + 500)

    for mode in ("lexical", "vector", "hybrid"):
        found = records.search_store(root, "guild records stitching", limit=10, mode=mode)
        if found["retrieval"] is not None:
            assert found["retrieval"]["currentChunks"] == 100
            assert found["retrieval"]["scoredChunks"] == 100
        assert found["hits"], f"{mode} refused a store that is well within the ceiling"

    status = records.maintenance(root, "status")
    assert status["chunkCount"] == 100 and status["retainedChunkCount"] == LIMIT + 500
    assert status["vectorSearch"]["overLimit"] is False
    assert status["vectorSearch"]["currentChunkCount"] == 100
    built = records.embed_chunks(root)
    assert built["currentChunks"] == 100 and built["chunkAccounting"]["reusedExistingVector"] == 100


# A counter that matches the labels is not a vector a query can read --------------------------

def _corrupt_blob(root: Path, chunk_id: str, blob: str) -> None:
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("UPDATE chunk_vectors SET vector = ? WHERE chunk_id = ?", (blob, chunk_id))
    connection.commit()
    connection.close()


def test_a_row_whose_labels_match_but_whose_blob_cannot_be_decoded_is_not_counted_as_scoreable(tmp_path: Path) -> None:
    """The difference 0.3.14 could not see, and the fixture that proves 0.3.15 can.

    Expectation changed here (HR-41). In 0.3.14 ``scoreableChunks`` counted rows whose backend id,
    dimensions and text hash matched — metadata only — and a truncated blob passed every one of those
    checks. The derived record then reported the chunk as having a usable vector, ``embed_corpus``
    reported its row as reused, and the failure showed up only when a query tried to decode it, in
    the middle of a ranking, reported as ``encoding`` in a summary nobody had read yet.

    Now the same two checks run in the same order in both places, so the counter and the query are
    one number: a row that matches its labels but cannot be read is named ``undecodableVectorCount``,
    is not counted as scoreable, and is rebuilt rather than reused by the next embed run.
    """
    root = fixture_store(tmp_path, current=4)
    connection = sqlite3.connect(records.store_path(root))
    target = connection.execute("SELECT chunk_id FROM chunks WHERE current = 1 ORDER BY chunk_id LIMIT 1").fetchone()[0]
    connection.close()
    _corrupt_blob(root, target, "not-a-vector-at-all")

    state = records.vector_index_state(root)
    assert state["currentChunkCount"] == 4
    assert state["metadataMatchChunks"] == 4, "the labels still match — that was never the whole story"
    assert state["undecodableVectorCount"] == 1
    assert state["scoreableChunks"] == 3, "three chunks have a vector a query can actually read"
    assert state["state"] == "partial" and state["reindexVerb"] == "embed_corpus"

    # The derived record says the same thing, because it is the same function over the same store.
    records.refresh_lab_state(root, refreshed_by="test")
    record = json_loads_lab_state(root)
    assert record["vectorSearch"]["scoreableChunks"] == state["scoreableChunks"] == 3
    assert record["vectorSearch"]["undecodableVectorCount"] == 1

    for mode in ("vector", "hybrid"):
        found = records.search_store(root, "guild records stitching", limit=10, mode=mode)
        assert found["retrieval"]["scoredChunks"] == state["scoreableChunks"], (
            "the counter is only worth having if a query measured the same number")
        assert found["retrieval"]["refusedStaleVectors"] == 1
        assert found["retrieval"]["staleVectorReasons"] == {"unreadable": 1}
        if mode == "vector":
            assert all(hit.chunk.chunk_id != target for hit in found["hits"]), "the unreadable row is refused, not used as a 0.0 hit"
        else:
            # In hybrid the same chunk can still be returned — by the lexical ranker, which needs no
            # vector. That is the honest answer, and the provenance now shows it: no vector rank, no
            # vector score, no vector contribution.
            hit = next(item for item in found["hits"] if item.chunk.chunk_id == target)
            assert hit.retrieval["vectorRank"] is None and hit.retrieval["vectorScore"] is None
            assert hit.retrieval["foundBy"] == "lexicalOnly"
            assert hit.retrieval["contributions"]["vectorScore"] == 0.0

    rebuilt = records.embed_chunks(root)
    assert rebuilt["chunkAccounting"]["rebuiltUnreadableVector"] == 1
    assert rebuilt["chunkAccounting"]["reusedExistingVector"] == 3
    assert records.vector_index_state(root)["scoreableChunks"] == 4
    assert records.vector_index_state(root)["undecodableVectorCount"] == 0
    assert rebuilt["after"]["state"] == "ready"
    assert records.search_store(root, "guild records stitching", limit=10, mode="vector")["retrieval"]["scoredChunks"] == 4


def test_an_all_zero_vector_row_is_refused_as_if_it_had_no_vector(tmp_path: Path) -> None:
    """A row that decodes but decodes to nothing usable is not a searchable chunk either.

    ``vectors.embed_text`` never stores a zero vector and the store deletes it when it appears, so a
    zero row in a store means it was restored or edited in from outside. Scoring it would put a
    0.0-cosine chunk into a reply as if the ranker had found something in it.
    """
    root = fixture_store(tmp_path, current=3)
    connection = sqlite3.connect(records.store_path(root))
    target = connection.execute("SELECT chunk_id FROM chunks WHERE current = 1 ORDER BY chunk_id LIMIT 1").fetchone()[0]
    connection.close()
    _corrupt_blob(root, target, vectors.encode_vector([0.0] * vectors.EMBEDDING_DIMENSIONS))

    state = records.vector_index_state(root)
    assert state["scoreableChunks"] == 2 and state["undecodableVectorCount"] == 1
    found = records.search_store(root, "guild records stitching", limit=10, mode="vector")
    assert found["retrieval"]["staleVectorReasons"] == {"zero": 1}
    assert all(hit.chunk.chunk_id != target for hit in found["hits"])
    assert all(hit.score > 0.0 for hit in found["hits"])

    rebuilt = records.embed_chunks(root)
    assert rebuilt["chunkAccounting"]["rebuiltUnreadableVector"] == 1
    assert rebuilt["chunkAccounting"]["noSignatureProduced"] == 0, "the chunk has a signature; only the stored row was unusable"


def json_loads_lab_state(root: Path) -> dict:
    import json
    return json.loads((root / records.LAB_STATE_RELATIVE_PATH).read_text(encoding="utf-8"))
