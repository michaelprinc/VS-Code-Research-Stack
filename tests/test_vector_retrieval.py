"""Vector and hybrid retrieval over the workspace store (HR-01…HR-06, T15-01…T15-06).

Two kinds of proof live here. The backend cases measure the embedding itself — determinism,
dimension, cosine behaviour, the storage round-trip — because those claims have to be checked, not
asserted. The store cases check what a client sees: the ranking and shape a 0.3.13 client received,
the provenance the new modes add, and the refusal wording when a vector cannot be trusted.

One lexical case runs the release this release follows: the store and the lexical hits are produced
by the code at commit ``6719415`` (0.3.13) in a child process, then re-read by this build, and the
JSON is compared as text. That is the only way to show "unchanged" without assuming it.
"""
import json
import os
import sqlite3
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

from research_stack import lab_server, records, vectors
from research_stack.full import search_bm25
from research_stack.records import StoreError

REPO = Path(__file__).resolve().parents[1]
BASELINE_COMMIT = "6719415"  # release 0.3.13: the lexical behaviour this release must not change
NOTES = "notes/dissertation.md"
OTHER = "notes/methods.md"

DISSERATION = (
    "# Dissertation\n\nBarefoot sandals appear in the 14th-century illuminations. "
    "The stitching pattern is documented in the guild records.\n" * 3
)
METHODS = "# Methods\n\nBM25 ranking over the stored chunks with provenance.\n"


def workspace(tmp_path: Path) -> Path:
    (tmp_path / "notes").mkdir()
    (tmp_path / NOTES).write_text(DISSERATION, encoding="utf-8")
    (tmp_path / OTHER).write_text(METHODS, encoding="utf-8")
    return tmp_path


def indexed(tmp_path: Path) -> Path:
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES, OTHER])
    return root


def vector_rows(root: Path) -> list[sqlite3.Row]:
    connection = sqlite3.connect(records.store_path(root))
    connection.row_factory = sqlite3.Row
    try:
        return [dict(row) for row in connection.execute("SELECT * FROM chunk_vectors ORDER BY chunk_id")]
    finally:
        connection.close()


def baseline_source_tree(tmp_path: Path) -> Path:
    archive = subprocess.run(["git", "-C", str(REPO), "archive", BASELINE_COMMIT, "src/research_stack"], capture_output=True)
    if archive.returncode != 0:
        pytest.skip(f"the 0.3.13 tree is not available from this checkout: {archive.stderr.decode(errors='replace')[:200]}")
    tree = tmp_path / "baseline"
    tree.mkdir(parents=True, exist_ok=True)
    unpack = subprocess.run(["tar", "-x", "-C", str(tree)], input=archive.stdout, capture_output=True)
    if unpack.returncode != 0:
        pytest.skip("the 0.3.13 revision could not be unpacked")
    return tree / "src"


BASELINE_SCRIPT = textwrap.dedent("""
    import json, sys
    from research_stack import records
    root, mode, query = sys.argv[1], sys.argv[2], sys.argv[3]
    limit = int(sys.argv[4])
    if mode == "index":
        receipt = records.index_corpus(root, ["notes/dissertation.md", "notes/methods.md"])
        print(json.dumps({"schema": records.index_state(root)["schemaVersion"], "chunks": receipt["storeChunks"]}))
    else:
        hits = records.search_corpus(root, query, limit=limit)
        print(json.dumps([hit.as_dict() for hit in hits], ensure_ascii=False, sort_keys=True))
""")


def run_baseline(tmp_path: Path, *arguments: str) -> str:
    source = baseline_source_tree(tmp_path)
    result = subprocess.run([sys.executable, "-B", "-c", BASELINE_SCRIPT, str(tmp_path), *arguments],
                            cwd=str(tmp_path), capture_output=True, text=True,
                            env={**os.environ, "PYTHONPATH": str(source)})
    if result.returncode != 0:
        pytest.fail(f"the 0.3.13 code failed: {result.stderr[-400:]}")
    return result.stdout.strip()


# The backend itself ---------------------------------------------------------------------------

def test_the_backend_is_named_and_the_same_text_always_gives_the_same_vector() -> None:
    status = vectors.backend_status()
    assert status["backendId"] == "rsk-hashing-v1" and status["dimensions"] == 256
    assert status["modelDownloaded"] is False and status["networkRequired"] is False

    first = vectors.embed_text("Barefoot sandals in the guild records.")
    second = vectors.embed_text("Barefoot sandals in the guild records.")
    assert first == second and len(first) == vectors.EMBEDDING_DIMENSIONS
    # Case, spacing and order of the same words must not change the signature.
    assert vectors.embed_text("  barefoot   SANDALS in the GUILD records.  ") == first
    latin = vectors.embed_text("Iluminace patnáctého století ukazují sandály.")
    other_run = vectors.embed_text("Iluminace patnáctého století ukazují sandály.")
    assert latin == other_run, "non-ASCII text must embed identically too"


def test_vectors_are_stored_compactly_and_decode_back_to_the_same_grid() -> None:
    vector = vectors.embed_text("The guild records document the stitching pattern.")
    encoded = vectors.encode_vector(vector)
    assert isinstance(encoded, str) and len(encoded) < 1024, "a stored vector is compact, not a JSON float dump"
    decoded = vectors.decode_vector(encoded)
    assert len(decoded) == vectors.EMBEDDING_DIMENSIONS
    assert vectors.encode_vector(decoded) == encoded, "the storage form is stable through a round-trip"
    assert abs(vectors.cosine_similarity(vector, decoded) - 1.0) < 1e-6
    with pytest.raises(vectors.VectorError) as refusal:
        vectors.decode_vector("not base64 at all !!")
    assert "VECTOR_ENCODING" in str(refusal.value)
    with pytest.raises(vectors.VectorError) as refusal:
        vectors.cosine_similarity([1.0, 0.0], [1.0])
    assert "VECTOR_DIMENSION" in str(refusal.value)


def test_cosine_separates_shared_word_shape_from_unrelated_text() -> None:
    """Measured behaviour of a lexical signature, stated as a number rather than as marketing."""
    query = vectors.embed_text("barefoot sandals stitching pattern")
    same_words = vectors.embed_text("the stitching pattern of barefoot sandals")
    stem_variant = vectors.embed_text("barefoot sandal stitching patterns")
    czech_variant = vectors.embed_text("vzor šití barefoot sandals")
    unrelated = vectors.embed_text("Quarterly financial reconciliation of the municipal water utility budget")

    assert round(vectors.cosine_similarity(query, query), 6) == 1.0
    shared = vectors.cosine_similarity(query, same_words)
    stem = vectors.cosine_similarity(query, stem_variant)
    cross_shape = vectors.cosine_similarity(query, czech_variant)
    noise = vectors.cosine_similarity(query, unrelated)
    assert shared > noise and stem > noise and cross_shape > noise, (
        "shared surface forms must outscore unrelated text")
    assert noise < 0.35, "a lexical signature must not read as a semantic match"

    # A chunk with no letter or digit carries no signature at all, and cosine against it is 0.
    assert vectors.is_zero_vector(vectors.embed_text("--- ... !!! ???"))
    assert vectors.cosine_similarity(vectors.embed_text("--- ... !!!"), query) == 0.0


def test_the_backend_imports_only_the_standard_library_and_the_package_it_ships_with() -> None:
    """T15-02: HR-01 has to hold on a locked worker environment with nothing new installed."""
    source = (REPO / "src/research_stack/vectors.py").read_text(encoding="utf-8")
    third_party = {"numpy", "scipy", "sklearn", "torch", "transformers", "sentence_transformers", "faiss", "qdrant_client"}
    imports = {line.split()[1].split(".")[0] for line in source.splitlines() if line.startswith(("import ", "from "))}
    assert imports <= {"__future__", "base64", "hashlib", "math", "re", "struct", "unicodedata", "collections"}, imports
    assert not (imports & third_party), imports
    assert "urllib" not in source and "socket" not in source and "http" not in source, "the embedding backend makes no network call"


# Vectors in the store -------------------------------------------------------------------------

def test_indexing_a_corpus_stores_a_traced_vector_per_chunk_and_store_status_counts_them(tmp_path: Path) -> None:
    """T15-01/HR-01, T15-03/HR-04."""
    root = workspace(tmp_path)
    receipt = records.index_corpus(root, [NOTES, OTHER])
    assert receipt["chunksStored"] >= 2 and receipt["vectorsWritten"] == receipt["chunksStored"]
    assert receipt["vectorBackend"] == {"backendId": vectors.BACKEND_ID, "dimensions": vectors.EMBEDDING_DIMENSIONS, "encoding": vectors.VECTOR_ENCODING}
    assert receipt["chunksWithoutSignature"] == 0

    rows = vector_rows(root)
    assert len(rows) == receipt["chunksStored"]
    for row in rows:
        assert row["backend_id"] == vectors.BACKEND_ID
        assert row["dimensions"] == vectors.EMBEDDING_DIMENSIONS
        assert len(row["text_sha256"]) == 64
        assert row["vector"], "a vector row without a vector is not a vector row"

    status = records.maintenance(root, "status")
    assert status["vectorCount"] == len(rows) == status["chunkCount"]
    assert status["vectorSearch"]["state"] == "ready" and status["vectorSearch"]["backendId"] == vectors.BACKEND_ID
    assert status["vectorSearch"]["scoreableChunks"] == status["chunkCount"]

    # Re-indexing the same bytes reuses the vectors instead of paying for them twice.
    again = records.index_corpus(root, [NOTES, OTHER])
    assert again["vectorsReused"] == receipt["vectorsWritten"] and again["vectorsWritten"] == 0


def test_removing_a_source_takes_its_vectors_with_it(tmp_path: Path) -> None:
    root = indexed(tmp_path)
    before = len(vector_rows(root))
    removed = records.remove_sources(root, [OTHER])
    assert removed["removedSources"] == [OTHER]
    connection = sqlite3.connect(records.store_path(root))
    orphaned = connection.execute(
        "SELECT COUNT(*) FROM chunk_vectors v LEFT JOIN chunks c ON c.chunk_id = v.chunk_id WHERE c.chunk_id IS NULL"
    ).fetchone()[0]
    after = connection.execute("SELECT COUNT(*) FROM chunk_vectors").fetchone()[0]
    connection.close()
    assert orphaned == 0, "a deleted chunk must not leave an orphan vector behind"
    assert after < before


def test_embed_corpus_builds_vectors_from_stored_text_and_is_idempotent(tmp_path: Path) -> None:
    root = indexed(tmp_path)
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("DELETE FROM chunk_vectors")
    connection.commit()
    connection.close()

    built = records.embed_chunks(root)
    assert built["vectorsWritten"] == built["currentChunks"] and built["vectorsReused"] == 0
    assert built["sourceFilesRead"] is False, "the re-index reads the store, not the researcher's files"
    assert built["after"]["state"] == "ready"

    again = records.embed_chunks(root)
    assert again["vectorsWritten"] == 0 and again["vectorsReused"] == again["currentChunks"]
    forced = records.embed_chunks(root, overwrite=True)
    assert forced["vectorsWritten"] == forced["currentChunks"]


def test_a_vector_from_another_backend_is_refused_and_names_the_verb_that_rebuilds_it(tmp_path: Path) -> None:
    """T15-03/HR-04: a stored vector is only usable when its origin matches what is running now."""
    root = indexed(tmp_path)
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("UPDATE chunk_vectors SET backend_id = 'rsk-hashing-v0'")
    connection.commit()
    connection.close()

    status = records.index_state(root)
    assert status["vectorSearch"]["state"] == "stale" and status["vectorSearch"]["staleVectorCount"] == status["chunkCount"]
    assert status["vectorSearch"]["scoreableChunks"] == 0, "a stale vector is never counted as usable"

    with pytest.raises(StoreError) as refusal:
        records.search_corpus(root, "guild records", mode="vector")
    assert "VECTOR_BACKEND_STALE" in str(refusal.value)
    assert "embed_corpus" in str(refusal.value) and "rsk-hashing-v1" in str(refusal.value)
    with pytest.raises(StoreError) as refusal:
        records.search_corpus(root, "guild records", mode="hybrid")
    assert "VECTOR_BACKEND_STALE" in str(refusal.value)

    assert records.search_corpus(root, "guild records"), "the lexical ranker is not held hostage by a stale vector"

    rebuilt = records.embed_chunks(root)
    assert rebuilt["vectorsWritten"] == status["chunkCount"]
    assert records.index_state(root)["vectorSearch"]["state"] == "ready"
    assert records.search_corpus(root, "guild records", mode="hybrid")


def test_a_vector_made_from_different_text_is_reported_stale_and_not_scored(tmp_path: Path) -> None:
    """HR-04 at row level: the vector must match the chunk text it claims to describe."""
    root = indexed(tmp_path)
    rows = vector_rows(root)
    target = rows[0]["chunk_id"]
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("UPDATE chunk_vectors SET text_sha256 = ? WHERE chunk_id = ?", ("0" * 64, target))
    connection.commit()
    connection.close()

    status = records.index_state(root)
    assert status["vectorSearch"]["state"] == "partial" and status["vectorSearch"]["staleVectorCount"] == 1

    found = records.search_store(root, "guild records", limit=10, mode="vector")
    assert found["retrieval"]["refusedStaleVectors"] == 1 and found["retrieval"]["staleVectorReasons"] == {"text": 1}
    assert all(hit.chunk.chunk_id != target for hit in found["hits"]), "the stale row is refused, not quietly used"
    assert all(hit.chunk.chunk_id != target for hit in records.search_store(root, "guild records", limit=10, mode="hybrid")["hits"])


def test_a_store_with_chunks_but_no_vectors_names_the_reason_and_the_verb(tmp_path: Path) -> None:
    """T15-06/HR-06: never a bare refusal."""
    root = indexed(tmp_path)
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("DELETE FROM chunk_vectors")
    connection.commit()
    connection.close()

    assert records.index_state(root)["vectorSearch"]["state"] == "not-built"
    for mode in ("vector", "hybrid"):
        with pytest.raises(StoreError) as refusal:
            records.search_corpus(root, "guild records", mode=mode)
        message = str(refusal.value)
        assert "VECTORS_MISSING" in message and "embed_corpus" in message and mode in message
        assert "no network" in message, "the answer also says what the rebuild will not do"


# The modes a client sees ----------------------------------------------------------------------

def test_lexical_search_returns_exactly_what_0_3_13_returned(tmp_path: Path) -> None:
    """T15-04/HR-03: the same store, the same query, the same bytes, one release apart."""
    root = workspace(tmp_path)
    built = json.loads(run_baseline(tmp_path, "index", "", "7"))
    assert built["schema"] == 3, "the fixture store was written by the 0.3.13 code"
    assert built["chunks"] >= 2

    query = "guild records stitching"
    baseline_hits = run_baseline(tmp_path, "search", query, "7")

    records.init_store(tmp_path)  # the reviewed 3 → 4 migration
    assert records.index_state(tmp_path)["schemaVersion"] == records.SCHEMA_VERSION == 4

    current_hits = json.dumps([hit.as_dict() for hit in records.search_corpus(tmp_path, query, limit=7)],
                              ensure_ascii=False, sort_keys=True)
    assert current_hits == baseline_hits, "the lexical ranking and the hit shape changed between 0.3.13 and this build"

    # And it still equals the BM25 ranker in full.py, ranked the same way, with the same keys.
    direct = [hit.as_dict() for hit in search_bm25(records.stored_chunks(tmp_path), query, limit=7)]
    assert [hit.chunk.chunk_id for hit in records.search_corpus(tmp_path, query, limit=7)] == [hit["chunk_id"] for hit in direct]
    assert all(set(hit) == {"score", "retrievalMethod", "chunk_id", "content_id", "source_version_id", "source_path",
                            "locator", "text", "text_sha256", "chunker_id", "unit_kind", "unit_index", "char_start",
                            "char_end"} for hit in direct)


def test_the_lexical_reply_through_the_verb_keeps_the_0_3_13_envelope(tmp_path: Path, monkeypatch) -> None:
    root = indexed(tmp_path)
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(root))
    reply = lab_server.search_corpus("guild records stitching", limit=5)
    assert set(reply) == {"hits", "method", "persistentIndex", "readOnly"}, "the default reply grew keys it does not need"
    assert reply["method"] == "bm25" and reply["readOnly"] is True
    assert all("retrieval" not in hit for hit in reply["hits"]), "a lexical hit is byte-compatible with 0.3.13"

    vector = lab_server.search_corpus("guild records stitching", limit=5, mode="vector")
    assert vector["method"] == "vector" and vector["mode"] == "vector" and set(vector) == {"hits", "method", "mode", "retrieval", "persistentIndex", "readOnly"}
    for rank, hit in enumerate(vector["hits"], start=1):
        provenance = hit["retrieval"]
        assert provenance["mode"] == "vector" and provenance["vectorRank"] == rank
        assert provenance["lexicalRank"] is None and provenance["fusedScore"] is None
        assert provenance["backend"] == vectors.BACKEND_ID
        assert {"chunk_id", "source_path", "locator", "text_sha256", "score"} <= set(hit)


def test_an_unknown_mode_is_refused_with_a_named_code(tmp_path: Path, monkeypatch) -> None:
    root = indexed(tmp_path)
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(root))
    reply = lab_server.search_corpus("guild records", mode="semantic")
    assert reply["resultState"] == "error" and reply["error"]["code"] == "SEARCH_MODE"
    assert "lexical | vector | hybrid" in reply["error"]["message"]
    assert reply["readOnly"] is True, "a refused read stays labelled a read"
    assert lab_server.search_corpus("guild records")["method"] == "bm25", "the default mode is unchanged"


def test_the_verb_reports_a_missing_vector_index_as_an_action_not_a_dead_end(tmp_path: Path, monkeypatch) -> None:
    root = indexed(tmp_path)
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("DELETE FROM chunk_vectors")
    connection.commit()
    connection.close()
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(root))

    reply = lab_server.search_corpus("guild records", mode="hybrid")
    assert reply["resultState"] == "error" and reply["error"]["code"] == "VECTORS_MISSING"
    assert "embed_corpus" in reply["error"]["message"]

    rebuilt = lab_server.embed_corpus()
    assert rebuilt["writeMode"] == "store-only" and rebuilt["vectorsWritten"] >= 1
    assert lab_server.search_corpus("guild records", mode="hybrid")["method"] == "hybrid"


def test_hybrid_reaches_a_chunk_the_lexical_ranker_cannot_see(tmp_path: Path) -> None:
    """T15-05/HR-02: the fusion has to earn its place on a case BM25 alone cannot solve."""
    root = workspace(tmp_path)
    (tmp_path / "notes" / "stems.md").write_text(
        "# Stems\n\nA sandal found in the illuminations of the fourteenth century, "
        "with sandal straps and a sandal sole.\n", encoding="utf-8")
    records.index_corpus(root, [NOTES, OTHER, "notes/stems.md"])

    exact = records.search_corpus(root, "sandals", limit=10)
    lexical_ids = {hit.chunk.chunk_id for hit in exact}
    lexical_paths = {hit.chunk.source_path for hit in exact}

    stem_only = records.search_store(root, "sandal straps", limit=10, mode="vector")
    stem_paths = {hit.chunk.source_path for hit in stem_only["hits"]}
    assert "notes/stems.md" in stem_paths

    fused = records.search_store(root, "sandals", limit=10, mode="hybrid")
    hybrid_paths = {hit.chunk.source_path for hit in fused["hits"]}
    assert "notes/stems.md" in hybrid_paths, "hybrid must surface the stem-shaped chunk lexical alone misses"
    assert any(hit.retrieval["lexicalRank"] is None for hit in fused["hits"]), (
        "the fused answer must contain a hit the lexical ranker did not place")

    for hit in fused["hits"]:
        provenance = hit.retrieval
        assert provenance["mode"] == "hybrid" and provenance["backend"] == vectors.BACKEND_ID
        assert provenance["fusedScore"] is not None and 0.0 <= provenance["fusedScore"] <= 1.0
        assert provenance["lexicalRank"] is not None or provenance["vectorRank"] is not None
        assert hit.retrieval_method == "hybrid" and hit.score == provenance["fusedScore"]

    scores = [hit.score for hit in fused["hits"]]
    assert scores == sorted(scores, reverse=True), "a fused score is the ranking the reply shows"
    assert fused["retrieval"]["fusionWeights"] == records.FUSION_WEIGHTS and fused["retrieval"]["reciprocalRankConstant"] == 60
    assert "reciprocal-rank-fusion" in fused["retrieval"]["fusionRule"]


def test_the_fused_score_is_the_documented_rule_and_ranks_first_by_both_first(tmp_path: Path) -> None:
    root = indexed(tmp_path)
    query = "guild records stitching illuminations"
    lexical = records.search_store(root, query, limit=10, mode="lexical")["hits"]
    vector = records.search_store(root, query, limit=10, mode="vector")["hits"]
    fused = records.search_store(root, query, limit=10, mode="hybrid")

    by_id = {hit.chunk.chunk_id: hit for hit in lexical + vector}
    lexical_max = max(hit.score for hit in lexical)
    vector_max = max(hit.score for hit in vector)
    expected: dict[str, float] = {}
    for rank, hit in enumerate(lexical, start=1):
        entry = expected.setdefault(hit.chunk.chunk_id, {"rrf": 0.0, "lex": 0.0, "vec": 0.0})
        entry["rrf"] += 1.0 / (60 + rank)
        entry["lex"] = hit.score / lexical_max
    for rank, hit in enumerate(vector, start=1):
        entry = expected.setdefault(hit.chunk.chunk_id, {"rrf": 0.0, "lex": 0.0, "vec": 0.0})
        entry["rrf"] += 1.0 / (60 + rank)
        entry["vec"] = max(0.0, hit.score) / vector_max
    for chunk_id, entry in expected.items():
        entry["fused"] = round(0.5 * entry["rrf"] * 61 / 2 + 0.25 * entry["lex"] + 0.25 * entry["vec"], 6)

    assert {hit.chunk.chunk_id for hit in fused["hits"]} == set(expected), "hybrid returns the union of both candidate sets"
    for hit in fused["hits"]:
        assert hit.score == expected[hit.chunk.chunk_id]["fused"], f"{hit.chunk.chunk_id} is not the documented fusion value"
        assert by_id[hit.chunk.chunk_id].chunk.text == hit.chunk.text

    fused_order = [hit.chunk.chunk_id for hit in fused["hits"]]
    lexical_order = [hit.chunk.chunk_id for hit in lexical if hit.chunk.chunk_id in fused_order]
    assert fused_order != lexical_order, (
        "HR-02: the fused ranking must not be a copy of the lexical ranking — on this fixture the chunk "
        "the vector ranker puts first outranks the chunk BM25 puts first")
    assert fused_order[0] != lexical_order[0], "the reorder has to reach the top of the reply"
    assert all(0.0 <= hit.score <= 1.0 for hit in fused["hits"]), "the documented weights keep a fused score in 0..1"


def test_hybrid_on_a_query_with_no_letters_or_digits_reports_why_it_returned_nothing(tmp_path: Path) -> None:
    root = indexed(tmp_path)
    found = records.search_store(root, "??? --- !!!", limit=5, mode="vector")
    assert found["hits"] == []
    assert "no letter or digit" in found["retrieval"]["queryNote"]
