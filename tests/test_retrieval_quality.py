"""The measurement itself is under test (T16-03).

Two things are proved here, and they are the only things that make ``evidence/retrieval-2026-11-22/``
worth reading:

* the arithmetic is right — Recall@10, Precision@10, nDCG@10 and the latency percentiles are checked
  against values computed by hand, because a metric that is quietly wrong reports a retrieval quality
  claim the release did not earn;
* the frozen inputs are still the frozen inputs — a corpus whose bytes moved, a query that cites a chunk
  the corpus no longer produces, or a group that lost its queries must stop the run instead of silently
  producing a new, incomparable number.

The recorded results file is re-derived on every test run and compared with the committed one, so the
committed evidence cannot drift away from the code that produced it.
"""
from __future__ import annotations

import copy
import functools
import importlib.util
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from research_stack import records

ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = ROOT / "scripts" / "measure_retrieval.py"
EVIDENCE = ROOT / "evidence" / "retrieval-2026-11-22"

_spec = importlib.util.spec_from_file_location("measure_retrieval", SCRIPT_PATH)
measure_retrieval = importlib.util.module_from_spec(_spec)
assert _spec and _spec.loader
_spec.loader.exec_module(measure_retrieval)


@functools.lru_cache(maxsize=1)
def measurement() -> dict[str, object]:
    """One measurement of the frozen inputs, shared by the tests that need its numbers.

    ``near_ceiling=False`` keeps the 20 000-chunk fixture out of the ordinary test run; the committed
    results file carries that fixture and is checked for it separately.
    """
    return measure_retrieval.measure(
        EVIDENCE, repetitions=2, k=10, seed=measure_retrieval.DEFAULT_SEED, near_ceiling=False
    )


# --------------------------------------------------------------------------------------
# The arithmetic
# --------------------------------------------------------------------------------------


def test_metrics_match_hand_computed_values() -> None:
    """Every metric is checked against a number computed by hand on a four-result ranking.

    Two relevant chunks, one of them second and one of them fourth out of four results:
    recall is 2/2, precision is 2/4, the discounted gain is 1/log2(3) + 1/log2(5) and the ideal gain is
    1/log2(2) + 1/log2(3), so nDCG is 1.0616/1.6309 = 0.6509.
    """
    relevant = {"A", "B"}
    ranked = ["X", "A", "Y", "B"]
    assert measure_retrieval.recall_at_k(relevant, ranked, 4) == pytest.approx(1.0)
    assert measure_retrieval.precision_at_k(relevant, ranked, 4) == pytest.approx(0.5)
    hand_ndcg = (1 / math.log2(3) + 1 / math.log2(5)) / (1 / math.log2(2) + 1 / math.log2(3))
    assert measure_retrieval.ndcg_at_k(relevant, ranked, 4) == pytest.approx(hand_ndcg)
    assert measure_retrieval.ndcg_at_k(relevant, ranked, 4) == pytest.approx(0.65093, abs=1e-5)

    # Cut the same ranking at 3 and the second answer falls outside the window: 1 of 2 relevant found, and
    # the one that was found sits at rank 2, so its gain is 1/log2(3) and not 1/log2(2).
    assert measure_retrieval.recall_at_k(relevant, ranked, 3) == pytest.approx(0.5)
    assert measure_retrieval.precision_at_k(relevant, ranked, 3) == pytest.approx(1 / 3)
    assert measure_retrieval.ndcg_at_k(relevant, ranked, 3) == pytest.approx(
        (1 / math.log2(3)) / (1 / math.log2(2) + 1 / math.log2(3))
    )

    # The ideal ranking scores 1.0, an empty answer scores 0, and a query with nothing relevant scores 0
    # rather than dividing by a zero ideal.
    assert measure_retrieval.ndcg_at_k({"A", "B"}, ["A", "B"], 2) == pytest.approx(1.0)
    assert measure_retrieval.ndcg_at_k({"A", "B"}, [], 10) == 0.0
    assert measure_retrieval.recall_at_k(set(), ["A"], 10) == 0.0
    assert measure_retrieval.ndcg_at_k(set(), ["A"], 10) == 0.0
    assert measure_retrieval.precision_at_k({"A"}, ["A", "B"], 0) == 0.0


def test_latency_summary_takes_the_95th_sample_and_not_the_last_one() -> None:
    samples = [float(value) for value in range(1, 21)]
    summary = measure_retrieval.latency_summary(samples)
    assert summary["samples"] == 20
    assert summary["medianMs"] == pytest.approx(10.5)
    # ceil(0.95 * 20) - 1 = index 18, which is the value 19 — the 19th millisecond, not the 20th.
    assert summary["p95Ms"] == pytest.approx(19.0)
    assert summary["maxMs"] == pytest.approx(20.0)
    assert measure_retrieval.latency_summary([]) == {"samples": 0}
    assert measure_retrieval.summarise([])["count"] == 0


# --------------------------------------------------------------------------------------
# The frozen inputs
# --------------------------------------------------------------------------------------


def test_the_frozen_inputs_are_present_labelled_and_redistributable() -> None:
    """Nothing in the evidence directory may be the operator's text, and the labelling must say so."""
    files = measure_retrieval.corpus_files(EVIDENCE)
    assert len(files) == 10
    total_bytes = sum(path.stat().st_size for path in files)
    assert total_bytes < 50_000, "a fixture corpus this size is a fixture; larger stops being redistributable"
    for path in files:
        text = path.read_text(encoding="utf-8")
        marker = "synthetický" if "cz" in path.parts else "synthetic"
        assert marker in text, f"{path} is fixture text and must name itself as fixture text in its own body"

    queries = json.loads((EVIDENCE / measure_retrieval.QUERIES_NAME).read_text(encoding="utf-8"))
    assert queries["assessedQueries"] == len(queries["queries"]) == 29
    assert queries["assessedQueries"] >= 20
    assert queries["frozen"] is True
    assert "judgementRule" in queries and "labelFormat" in queries
    by_group: dict[str, int] = {}
    for query in queries["queries"]:
        by_group[query["group"]] = by_group.get(query["group"], 0) + 1
        assert query["basis"], f"{query['id']} states no basis for its relevance judgement"
        if query["group"] == "no-relevant-answer":
            assert query["relevant"] == []
        else:
            assert query["relevant"], f"{query['id']} is an assessed query with no judged answer"
    assert by_group == {"czech": 10, "english": 10, "diacritic-free-or-typo": 5, "no-relevant-answer": 4}


def test_the_manifest_records_the_bytes_and_the_chunks_the_index_produced() -> None:
    manifest = json.loads((EVIDENCE / measure_retrieval.MANIFEST_NAME).read_text(encoding="utf-8"))
    assert manifest["frozen"] is True
    assert manifest["chunkCount"] == len(manifest["chunks"]) == 40
    assert manifest["indexer"]["storeChunkCeiling"] == records.MAX_STORE_CHUNKS
    assert manifest["indexer"]["backend"]["backendId"] == "rsk-hashing-v1"
    labels = {f"{item['sourcePath']}#{item['locator']}" for item in manifest["chunks"]}
    assert len(labels) == 40, "a label that appears twice makes a relevance judgement ambiguous"
    # The labels the queries cite must be labels the corpus produces; the run checks this too, and this
    # test says which part of the check it is.
    queries = json.loads((EVIDENCE / measure_retrieval.QUERIES_NAME).read_text(encoding="utf-8"))
    cited = {label for query in queries["queries"] for label in query["relevant"]}
    assert cited <= labels


# --------------------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------------------


def test_a_measurement_run_reports_every_number_the_release_needs_and_refuses_nothing() -> None:
    results = measurement()
    run = results["run"]
    assert run["networkUsed"] is False
    assert run["modelDownloaded"] is False
    assert run["seed"] == measure_retrieval.DEFAULT_SEED
    assert run["repetitions"] == 2
    assert run["k"] == 10
    # The rankers measured are the rankers the release ships, in shipped order, with ``lexical`` first —
    # the measurement does not quietly evaluate a mode that is not the default.
    assert run["modes"] == list(records.SEARCH_MODES) == ["lexical", "vector", "hybrid"]
    assert run["deterministicAcrossRepetitions"] is True
    assert results["refusals"] == [], "the frozen corpus is inside the chunk ceiling, so no read may be refused"

    assert run["fusion"] == {"reciprocalRankConstant": 60,
                             "weights": {"reciprocalRankFusion": 0.5, "lexicalScore": 0.25, "vectorScore": 0.25},
                             "fusionPool": 50}, "the measurement must run on the published fusion parameters"
    assert run["backend"]["backendId"] == "rsk-hashing-v1"

    coverage = results["vectorCoverage"]
    assert coverage["currentChunks"] == results["corpus"]["chunkCount"] == 40
    # Coverage is what a query can decode, not what a row claims: both counts are reported so the gap is
    # visible the day it appears (T16-04).
    assert coverage["decodableSignatures"] == 40
    assert coverage["undecodableSignatures"] == 0
    assert coverage["metadataMatchOnly"] == 40
    assert coverage["coverageOfCurrentChunks"] == 1.0

    assert results["queries"]["total"] == 29
    assert results["queries"]["byGroup"] == {"czech": 10, "english": 10, "diacritic-free-or-typo": 5, "no-relevant-answer": 4}
    for mode in run["modes"]:
        # 29 queries x 2 timed repetitions each, and the report says how many samples its percentiles rest on.
        assert results["latencyMs"][mode]["samples"] == 29 * 2
        assert results["latencyMs"][mode]["medianMs"] > 0.0
        assert results["latencyMs"][mode]["p95Ms"] >= results["latencyMs"][mode]["medianMs"]

    aggregate = results["aggregate"]
    for mode in run["modes"]:
        overall = aggregate[mode]["overall"]
        assert overall["assessedQueries"] == 25
        for metric in ("recallAtK", "ndcgAtK", "precisionAtK"):
            assert overall[metric]["count"] == 25
            assert 0.0 <= overall[metric]["mean"] <= 1.0
        for group in measure_retrieval.GROUPS:
            assert group in aggregate[mode]["groups"]
        assessed_group = aggregate[mode]["groups"]["czech"]
        assert assessed_group["queries"] == 10
        assert "queriesWithNoRelevantHit" in assessed_group
        no_answer = aggregate[mode]["groups"]["no-relevant-answer"]
        assert no_answer["queries"] == 4
        # No relevance threshold exists in 0.3.x, so a query with no relevant answer still returns hits.
        # The group exists to keep that visible; the assertion is that it stayed visible.
        assert no_answer["shareReturningAHit"] > 0.5
        assert no_answer["queriesReturningAtLeastOneHit"] == 4

    for row in results["perQuery"]:
        for mode, per_mode in row["modes"].items():
            assert per_mode["hitsReturned"] == len(per_mode["hitChunkIds"])
            assert per_mode["hitsReturned"] <= 10
            if mode in ("vector", "hybrid"):
                # Every current chunk gets a cosine against the query, so both rankers fill the window.
                assert per_mode["hitsReturned"] == 10
                assert per_mode["scoredChunks"] == 40
            else:
                # ``lexical`` returns only the chunks BM25 scored above zero: a query sharing no token with
                # a chunk cannot be answered by it. On this corpus the window is filled for 15 of the 29
                # queries and is partly empty for the rest, which is what the recall columns are reading.
                assert 1 <= per_mode["hitsReturned"] <= 10
        hybrid = row["modes"]["hybrid"]
        counts = hybrid["foundBy"]
        assert counts["both"] + counts["lexicalOnly"] + counts["vectorOnly"] == hybrid["hitsReturned"], (
            "T16-04: every returned hybrid hit is attributed to a ranker, so the counts must add up to the hits"
        )


def test_the_recorded_results_file_is_what_the_frozen_inputs_produce_now() -> None:
    """The committed evidence is re-derived and compared, so it cannot quietly lag behind the code.

    Ranking order, recall, precision and nDCG are deterministic; only the latency and top-score columns
    depend on the machine, so those are compared as shape and presence, not as values.
    """
    recorded = json.loads((EVIDENCE / measure_retrieval.RESULTS_JSON).read_text(encoding="utf-8"))
    fresh = measurement()

    assert recorded["corpus"] == fresh["corpus"]
    assert recorded["queries"] == fresh["queries"]
    assert recorded["vectorCoverage"] == fresh["vectorCoverage"]
    assert recorded["run"]["modes"] == fresh["run"]["modes"]
    assert recorded["run"]["fusion"] == fresh["run"]["fusion"]
    assert recorded["run"]["backend"] == fresh["run"]["backend"]

    for mode in fresh["run"]["modes"]:
        assert recorded["aggregate"][mode]["overall"] == fresh["aggregate"][mode]["overall"], (
            f"{mode} metrics in the committed results no longer match a fresh run over the frozen corpus"
        )
        assert recorded["aggregate"][mode]["groups"] == fresh["aggregate"][mode]["groups"]
    assert [row["id"] for row in recorded["perQuery"]] == [row["id"] for row in fresh["perQuery"]]
    for recorded_row, fresh_row in zip(recorded["perQuery"], fresh["perQuery"]):
        for mode in fresh["run"]["modes"]:
            assert recorded_row["modes"][mode]["hitChunkIds"] == fresh_row["modes"][mode]["hitChunkIds"]
            assert recorded_row["modes"][mode]["recallAtK"] == fresh_row["modes"][mode]["recallAtK"]
            assert recorded_row["modes"][mode]["ndcgAtK"] == fresh_row["modes"][mode]["ndcgAtK"]

    # The near-ceiling fixture lives only in the committed file: the ordinary run leaves it out so the
    # suite stays test-sized. Its point is the chunk count it scored, so that is what is asserted.
    near = recorded["nearCeilingFixture"]
    assert near["currentChunks"] == records.MAX_STORE_CHUNKS == 20_000
    assert near["decodableSignatures"] == records.MAX_STORE_CHUNKS
    assert near["scoredChunksPerMode"] == {"lexical": 20_000, "vector": 20_000, "hybrid": 20_000}
    assert "notMeasured" in near, "the fixture must say that it measures cost and not quality"
    assert recorded["latencyMs"]["lexical"]["medianMs"] < recorded["latencyMs"]["vector"]["medianMs"] < recorded["latencyMs"]["hybrid"]["medianMs"], (
        "the lexical ranker is the cheapest of the three; a recorded run that says otherwise is a measurement problem"
    )


# --------------------------------------------------------------------------------------
# The checks that must be able to fail
# --------------------------------------------------------------------------------------


def _copy_evidence(destination: Path) -> Path:
    shutil.copytree(EVIDENCE, destination)
    return destination


def test_corpus_bytes_that_moved_since_the_freeze_stop_the_run(tmp_path: Path) -> None:
    """A frozen corpus whose bytes no longer match the manifest must stop the run.

    The manifest hash is what is tampered with here, so the chunk inventory still lines up and the run
    fails on the byte check alone. The other gate — a corpus edited so it indexes differently — is the
    next test.
    """
    evidence = _copy_evidence(tmp_path / "evidence")
    manifest_path = evidence / measure_retrieval.MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["files"][0]["sha256"] = "0" * 64
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    with pytest.raises(measure_retrieval.MeasurementError) as raised:
        measure_retrieval.measure(evidence, repetitions=1, k=10, seed=1, near_ceiling=False)
    assert "CORPUS_BYTES_DRIFT" in str(raised.value)
    assert manifest["files"][0]["path"] in str(raised.value)


def test_a_corpus_that_now_indexes_into_a_different_chunk_inventory_stops_the_run(tmp_path: Path) -> None:
    """Text added to a fixture file is a different corpus: comparing its numbers with the frozen ones
    would compare two different indexes, so the run says so instead of reporting metrics."""
    evidence = _copy_evidence(tmp_path / "evidence")
    target = evidence / "corpus" / "cz" / "iluminace.md"
    target.write_text(target.read_text(encoding="utf-8") + "\nAn extra sentence added after the freeze.\n", encoding="utf-8")
    with pytest.raises(measure_retrieval.MeasurementError) as raised:
        measure_retrieval.measure(evidence, repetitions=1, k=10, seed=1, near_ceiling=False)
    assert "CORPUS_INVENTORY_DRIFT" in str(raised.value)


def test_a_query_citing_a_chunk_the_corpus_no_longer_produces_stops_the_run(tmp_path: Path) -> None:
    evidence = _copy_evidence(tmp_path / "evidence")
    queries = json.loads((evidence / measure_retrieval.QUERIES_NAME).read_text(encoding="utf-8"))
    queries["queries"][0]["relevant"] = ["corpus/cz/iluminace.md#paragraph=99;chars=0-10"]
    (evidence / measure_retrieval.QUERIES_NAME).write_text(json.dumps(queries, ensure_ascii=False, indent=2), encoding="utf-8")
    with pytest.raises(measure_retrieval.MeasurementError) as raised:
        measure_retrieval.measure(evidence, repetitions=1, k=10, seed=1, near_ceiling=False)
    assert "RELEVANCE_LABEL_UNRESOLVED" in str(raised.value)
    assert queries["queries"][0]["id"] in str(raised.value)


def test_a_missing_group_a_missing_judgement_and_a_missing_basis_each_stop_the_run(tmp_path: Path) -> None:
    """Each of these would turn the report into a number whose meaning changed without being renamed."""
    evidence = _copy_evidence(tmp_path / "evidence")
    queries_path = evidence / measure_retrieval.QUERIES_NAME
    document = json.loads(queries_path.read_text(encoding="utf-8"))

    without_group = copy.deepcopy(document)
    without_group["queries"] = [query for query in document["queries"] if query["group"] != "no-relevant-answer"]
    queries_path.write_text(json.dumps(without_group, ensure_ascii=False, indent=2), encoding="utf-8")
    with pytest.raises(measure_retrieval.MeasurementError) as raised:
        measure_retrieval.measure(evidence, repetitions=1, k=10, seed=1, near_ceiling=False)
    assert "QUERIES_GROUP_GAP" in str(raised.value)

    without_basis = copy.deepcopy(document)
    without_basis["queries"][0]["basis"] = ""
    queries_path.write_text(json.dumps(without_basis, ensure_ascii=False, indent=2), encoding="utf-8")
    with pytest.raises(measure_retrieval.MeasurementError) as raised:
        measure_retrieval.measure(evidence, repetitions=1, k=10, seed=1, near_ceiling=False)
    assert "QUERY_JUDGEMENT_UNDOCUMENTED" in str(raised.value)

    too_few = copy.deepcopy(document)
    too_few["queries"] = document["queries"][:19]
    queries_path.write_text(json.dumps(too_few, ensure_ascii=False, indent=2), encoding="utf-8")
    with pytest.raises(measure_retrieval.MeasurementError) as raised:
        measure_retrieval.measure(evidence, repetitions=1, k=10, seed=1, near_ceiling=False)
    assert "QUERIES_TOO_FEW" in str(raised.value)


def test_a_manifest_that_is_not_there_is_refused_as_a_missing_freeze(tmp_path: Path) -> None:
    evidence = _copy_evidence(tmp_path / "evidence")
    (evidence / measure_retrieval.MANIFEST_NAME).unlink()
    with pytest.raises(measure_retrieval.MeasurementError) as raised:
        measure_retrieval.measure(evidence, repetitions=1, k=10, seed=1, near_ceiling=False)
    assert "MANIFEST_MISSING" in str(raised.value)


# --------------------------------------------------------------------------------------
# The command line
# --------------------------------------------------------------------------------------


def test_the_command_line_writes_a_machine_file_and_a_human_file_without_touching_the_evidence(
    tmp_path: Path,
) -> None:
    """The script writes its own outputs, and ``--evidence-dir`` is what keeps a verification run from
    rewriting the committed results."""
    evidence = _copy_evidence(tmp_path / "evidence")
    completed = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--evidence-dir", str(evidence),
         "--repetitions", "1", "--k", "10", "--no-near-ceiling"],
        capture_output=True, text=True, cwd=ROOT, timeout=600,
    )
    assert completed.returncode == 0, completed.stderr
    results = json.loads((evidence / measure_retrieval.RESULTS_JSON).read_text(encoding="utf-8"))
    assert results["run"]["repetitions"] == 1
    assert results["nearCeilingFixture"] is None
    assert results["queries"]["total"] == 29
    assert results["run"]["deterministicAcrossRepetitions"] is True
    for mode in results["run"]["modes"]:
        assert results["latencyMs"][mode]["samples"] == 29
        assert results["aggregate"][mode]["overall"] == measurement()["aggregate"][mode]["overall"]

    markdown = (evidence / measure_retrieval.RESULTS_MD).read_text(encoding="utf-8")
    for heading in ("## Relevance per mode and language group", "## Queries with no relevant answer",
                    "## Latency per mode", "## Per query", "## What this does not show"):
        assert heading in markdown
    for mode in ("lexical", "vector", "hybrid"):
        assert f"| {mode} |" in markdown
    assert "synthetic" in markdown, "the report must carry the nature of the corpus it measured"


def test_a_run_against_a_directory_with_no_corpus_fails_with_a_named_problem(tmp_path: Path) -> None:
    completed = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--evidence-dir", str(tmp_path / "nothing-here")],
        capture_output=True, text=True, cwd=ROOT, timeout=120,
    )
    assert completed.returncode == 1
    assert "MANIFEST_MISSING" in completed.stderr
