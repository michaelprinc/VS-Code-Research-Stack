"""Measure lexical, vector and hybrid retrieval on a frozen synthetic corpus (T16-03).

What this measures
------------------
The Toolkit ships a named CPU retrieval backend (``vectors.BACKEND_ID``) and three modes
(``lexical``, ``vector``, ``hybrid``). 0.3.14 proved the modes are deterministic, that a stored
vector is traceable, and that a hybrid reorder is not a copy of the lexical order — it never measured
whether the ranking is *good*. This script closes that gap for the part of it that can be closed
honestly here, and names the part that cannot.

Inputs are frozen before anything runs and checked on every run:

* ``corpus/`` — ten synthetic Markdown files, ~2 400 words, Czech and English, each labelled in its
  own heading as fixture text;
* ``corpus-manifest.json`` — the sha256 of every corpus file and the chunk inventory the index
  produces from those bytes (chunk id, source path, locator, text hash). A run refuses if the corpus
  bytes or the inventory have drifted, so "frozen" is verified rather than asserted;
* ``queries.json`` — 29 queries with their language group, the chunk labels a human judged relevant
  (``source path#locator``) and the one-sentence basis for each judgement.

Outputs are written next to them: ``results.json`` (machine-readable, everything) and ``results.md``
(the tables a person reads): Recall@10, nDCG@10 and Precision@10 per mode and language group, the
no-answer group reported as *how often a hit is returned at all*, per-mode latency median and p95
over repeated runs, corpus size, vector coverage measured by decoding, and the backend identity.

What this corpus is not
-----------------------
The operator's own research corpus is not available in this environment and is not measured here.
These are synthetic passages written for this measurement, and the relevance judgements are made by
construction: the relevant passage is the one authored to answer the query. That makes the numbers a
reproducible baseline for comparing modes and releases, **not** a claim about how the toolkit performs
on real research text. ``results.md`` says this on every table it produces.

Determinism and offline behaviour
---------------------------------
No network call, no model download, no randomness: the ranking is a pure function of the stored bytes,
so repeated runs must return identical id sequences. That is checked in the run and reported, not
assumed. The seed is recorded so a comparison across machines names the configuration it used.

Usage::

    .venv/bin/python scripts/measure_retrieval.py                 # measure against the frozen manifest
    .venv/bin/python scripts/measure_retrieval.py --freeze        # re-record the manifest (deliberate act)
    .venv/bin/python scripts/measure_retrieval.py --repetitions 9 --k 10 --no-near-ceiling
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import shutil
import sqlite3
import statistics
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from research_stack import records, vectors

EVIDENCE_DIRECTORY = "evidence/retrieval-2026-11-22"
CORPUS_DIRECTORY = "corpus"
MANIFEST_NAME = "corpus-manifest.json"
QUERIES_NAME = "queries.json"
RESULTS_JSON = "results.json"
RESULTS_MD = "results.md"
DEFAULT_SEED = 20261122
GROUPS = ("czech", "english", "diacritic-free-or-typo", "no-relevant-answer")
CORPUS_NATURE = (
    "Synthetic fixture text authored for this measurement. It is not the operator's research corpus, "
    "and no private text is present in it. Relevance is judged by construction: the relevant passage "
    "is the passage written to answer the query."
)


class MeasurementError(ValueError):
    """A frozen input drifted, or a mode refused to answer: stated, not worked around."""


# --------------------------------------------------------------------------------------
# Metrics. Kept as plain functions so a test can check them against hand-computed values.
# --------------------------------------------------------------------------------------

def discounted_gain(rank: int) -> float:
    return 1.0 / math.log2(rank + 1.0)


def recall_at_k(relevant: set[str], ranked_ids: list[str], k: int) -> float:
    if not relevant:
        return 0.0
    return len(relevant & set(ranked_ids[:k])) / len(relevant)


def precision_at_k(relevant: set[str], ranked_ids: list[str], k: int) -> float:
    if k <= 0:
        return 0.0
    return len(relevant & set(ranked_ids[:k])) / k


def ndcg_at_k(relevant: set[str], ranked_ids: list[str], k: int) -> float:
    gain = sum(1.0 / math.log2(index + 2.0) for index, chunk_id in enumerate(ranked_ids[:k]) if chunk_id in relevant)
    ideal = sum(discounted_gain(rank) for rank in range(1, min(len(relevant), k) + 1))
    return gain / ideal if ideal else 0.0


def summarise(values: list[float]) -> dict[str, object]:
    if not values:
        return {"count": 0, "mean": 0.0, "median": 0.0, "min": 0.0, "max": 0.0}
    return {
        "count": len(values),
        "mean": round(statistics.fmean(values), 6),
        "median": round(statistics.median(values), 6),
        "min": round(min(values), 6),
        "max": round(max(values), 6),
    }


def latency_summary(samples_ms: list[float]) -> dict[str, object]:
    """Median and p95 over every timed call the run made for this mode."""
    if not samples_ms:
        return {"samples": 0}
    ordered = sorted(samples_ms)
    index = max(0, min(len(ordered) - 1, math.ceil(0.95 * len(ordered)) - 1))
    return {
        "samples": len(ordered),
        "medianMs": round(statistics.median(ordered), 3),
        "p95Ms": round(ordered[index], 3),
        "maxMs": round(ordered[-1], 3),
        "meanMs": round(statistics.fmean(ordered), 3),
    }


# --------------------------------------------------------------------------------------
# Frozen inputs
# --------------------------------------------------------------------------------------

def corpus_files(evidence: Path) -> list[Path]:
    root = evidence / CORPUS_DIRECTORY
    if not root.is_dir():
        raise MeasurementError(f"CORPUS_MISSING: expected synthetic fixture files under {root}")
    files = sorted(root.rglob("*.md"), key=lambda item: str(item.relative_to(root)))
    if len(files) < 6:
        raise MeasurementError(f"CORPUS_TOO_SMALL: expected a fixture corpus of at least 6 files, found {len(files)}.")
    return files


def build_inventory(root: Path) -> tuple[dict[str, object], list[dict[str, object]], Path]:
    """Index the fixture corpus in a throwaway workspace and read the inventory back out.

    The workspace is returned, not cleaned up here: the measurement runs against the store this
    indexing produced, and the caller removes it when the run ends.
    """
    workspace = Path(tempfile.mkdtemp(prefix="rs-measure-"))
    shutil.copytree(root / CORPUS_DIRECTORY, workspace / CORPUS_DIRECTORY)
    relative = [str(path.relative_to(workspace)) for path in sorted((workspace / CORPUS_DIRECTORY).rglob("*.md"),
                                                                    key=lambda item: str(item.relative_to(workspace)))]
    receipt = records.index_corpus(workspace, relative)
    if receipt["status"] != "complete" or receipt["failedSources"]:
        shutil.rmtree(workspace, ignore_errors=True)
        raise MeasurementError(f"CORPUS_INDEX_FAILED: {json.dumps(receipt['failedSources'], ensure_ascii=False)}")
    inventory = [
        {"chunkId": chunk.chunk_id, "sourcePath": chunk.source_path, "locator": chunk.locator,
         "chars": len(chunk.text), "text_sha256": chunk.text_sha256,
         "excerpt": " ".join(chunk.text.split())[:70]}
        for chunk in records.stored_chunks(workspace)
    ]
    return receipt, inventory, workspace


def corpus_hashes(evidence: Path) -> list[dict[str, object]]:
    return [{"path": str(path.relative_to(evidence)), "bytes": path.stat().st_size,
             "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in corpus_files(evidence)]


def freeze_manifest(evidence: Path) -> dict[str, object]:
    """Record the corpus bytes and the chunk inventory the index produces from them."""
    _receipt, inventory, _workspace = build_inventory(evidence)
    manifest = {
        "frozen": True,
        "nature": CORPUS_NATURE,
        "indexer": {
            "schemaVersion": records.SCHEMA_VERSION,
            "chunker": "full.chunks_for_source defaults (chunk_chars=1200, overlap_chars=120)",
            "storeChunkCeiling": records.MAX_STORE_CHUNKS,
            "backend": vectors.backend_status(),
        },
        "files": corpus_hashes(evidence),
        "chunkCount": len(inventory),
        "chunks": inventory,
    }
    (evidence / MANIFEST_NAME).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest


def load_queries(evidence: Path) -> list[dict[str, object]]:
    path = evidence / QUERIES_NAME
    if not path.is_file():
        raise MeasurementError(f"QUERIES_MISSING: frozen queries are expected at {path}")
    payload = json.loads(path.read_text(encoding="utf-8"))
    queries = payload["queries"]
    if len(queries) < 20:
        raise MeasurementError(f"QUERIES_TOO_FEW: the assessment needs at least 20 queries, found {len(queries)}.")
    groups = {str(query["group"]) for query in queries}
    missing = set(GROUPS) - groups
    if missing:
        raise MeasurementError(f"QUERIES_GROUP_GAP: no query for group(s) {', '.join(sorted(missing))}.")
    for query in queries:
        if query["group"] == "no-relevant-answer" and query["relevant"]:
            raise MeasurementError(f"QUERY_JUDGEMENT_INCONSISTENT: {query['id']} is in the no-answer group and lists relevant chunks.")
        if query["group"] != "no-relevant-answer" and not query["relevant"]:
            raise MeasurementError(f"QUERY_JUDGEMENT_INCONSISTENT: {query['id']} has no relevant chunk judgement.")
        if not query.get("basis"):
            raise MeasurementError(f"QUERY_JUDGEMENT_UNDOCUMENTED: {query['id']} records no relevance basis.")
    return queries


# --------------------------------------------------------------------------------------
# The measurement
# --------------------------------------------------------------------------------------

def resolve_relevance(queries: list[dict[str, object]], inventory: list[dict[str, object]]) -> list[dict[str, object]]:
    """Turn the frozen ``source path#locator`` labels into the chunk ids this index produced."""
    by_label = {f"{item['sourcePath']}#{item['locator']}": str(item["chunkId"]) for item in inventory}
    resolved: list[dict[str, object]] = []
    for query in queries:
        ids: list[str] = []
        for label in query["relevant"]:
            if label not in by_label:
                raise MeasurementError(
                    f"RELEVANCE_LABEL_UNRESOLVED: {query['id']} cites {label}, which this frozen corpus no longer produces.")
            ids.append(by_label[label])
        resolved.append({**query, "relevantChunkIds": sorted(set(ids))})
    return resolved


def run_mode(root: Path, query: str, mode: str, k: int) -> tuple[list[str], dict[str, object], float]:
    """One timed retrieval call. The timer covers the whole call: load, score, rank, build the reply."""
    started = time.perf_counter()
    found = records.search_store(root, query, limit=k, mode=mode)
    elapsed_ms = (time.perf_counter() - started) * 1000.0
    hits = found["hits"]
    return ([hit.chunk.chunk_id for hit in hits], [float(hit.score) for hit in hits],
            (found["retrieval"] or {}), elapsed_ms)


def measure(evidence: Path, *, repetitions: int, k: int, seed: int, near_ceiling: bool) -> dict[str, object]:
    manifest_path = evidence / MANIFEST_NAME
    if not manifest_path.is_file():
        raise MeasurementError(f"MANIFEST_MISSING: run --freeze once to record the frozen corpus inventory in {manifest_path}.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))

    receipt, inventory, workspace = build_inventory(evidence)
    try:
        frozen_chunks = manifest["chunks"]
        if [str(item["chunkId"]) for item in frozen_chunks] != [str(item["chunkId"]) for item in inventory]:
            raise MeasurementError(
                "CORPUS_INVENTORY_DRIFT: this build indexes the frozen corpus into a different chunk inventory "
                "than the manifest records. The corpus, the chunker or the identity of a chunk changed; re-measuring "
                "against the same queries is no longer a comparison.")
        frozen_hashes = {item["path"]: item["sha256"] for item in manifest["files"]}
        drift = [item["path"] for item in corpus_hashes(evidence) if frozen_hashes.get(item["path"]) != item["sha256"]]
        if drift:
            raise MeasurementError(f"CORPUS_BYTES_DRIFT: these fixture files changed since the freeze: {', '.join(sorted(drift))}.")

        queries = resolve_relevance(load_queries(evidence), inventory)
        modes = list(records.SEARCH_MODES)

        index_state = records.vector_index_state(workspace)
        coverage = {
            "currentChunks": index_state["currentChunkCount"],
            "vectorRows": index_state["vectorCount"],
            "decodableSignatures": index_state["scoreableChunks"],
            "metadataMatchOnly": index_state["metadataMatchChunks"],
            "undecodableSignatures": index_state["undecodableVectorCount"],
            "storeChunkCeiling": index_state["chunkLimit"],
            "overLimit": index_state["overLimit"],
            "coverageOfCurrentChunks": round(index_state["scoreableChunks"] / max(index_state["currentChunkCount"], 1), 6),
            "measuredBy": "decoded at query time by the search path; not inferred from row metadata (T16-04)",
        }

        per_query: list[dict[str, object]] = []
        latencies: dict[str, list[float]] = {mode: [] for mode in modes}
        refusals: list[dict[str, object]] = []
        deterministic = True

        for query in queries:
            row: dict[str, object] = {
                "id": query["id"], "query": query["query"], "group": query["group"],
                "basis": query["basis"], "relevantCount": len(query["relevantChunkIds"]),
                "relevantChunkIds": query["relevantChunkIds"], "modes": {},
            }
            for mode in modes:
                sequences: list[list[str]] = []
                top_scores: list[float] = []
                found_by: dict[str, int] = {"both": 0, "lexicalOnly": 0, "vectorOnly": 0}
                scored_chunks: object = None
                for _repeat in range(repetitions):
                    try:
                        hit_ids, hit_scores, retrieval, elapsed_ms = run_mode(workspace, str(query["query"]), mode, k)
                    except records.StoreError as exc:
                        refusals.append({"queryId": query["id"], "mode": mode,
                                         "code": str(exc).split(":", 1)[0], "message": str(exc)[:240]})
                        break
                    latencies[mode].append(elapsed_ms)
                    sequences.append(hit_ids)
                    scored_chunks = retrieval.get("scoredChunks")
                    if mode == "hybrid":
                        found_by = {
                            "both": int(retrieval.get("hitsFoundByBoth", 0)),
                            "lexicalOnly": int(retrieval.get("hitsFoundByLexicalOnly", 0)),
                            "vectorOnly": int(retrieval.get("hitsFoundByVectorOnly", 0)),
                        }
                    if hit_scores:
                        top_scores.append(max(hit_scores))
                if not sequences:
                    continue
                if any(sequence != sequences[0] for sequence in sequences[1:]):
                    deterministic = False
                hit_ids = sequences[0]
                relevant = set(query["relevantChunkIds"])
                row["modes"][mode] = {
                    "hitChunkIds": hit_ids,
                    "hitsReturned": len(hit_ids),
                    "relevantReturned": len(relevant & set(hit_ids)),
                    "recallAtK": round(recall_at_k(relevant, hit_ids, k), 6),
                    "precisionAtK": round(precision_at_k(relevant, hit_ids, k), 6),
                    "ndcgAtK": round(ndcg_at_k(relevant, hit_ids, k), 6),
                    "topScore": round(max(top_scores), 6) if top_scores else 0.0,
                    "foundBy": found_by,
                    "scoredChunks": scored_chunks,
                }
            per_query.append(row)

        aggregate = aggregate_results(per_query, modes, k)
        near = near_ceiling_measurement(k) if near_ceiling else None
    finally:
        shutil.rmtree(workspace, ignore_errors=True)

    return {
        "run": {
            "measuredAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "seed": seed,
            "repetitions": repetitions,
            "k": k,
            "modes": modes,
            "networkUsed": False,
            "modelDownloaded": False,
            "deterministicAcrossRepetitions": deterministic,
            "corpusNature": CORPUS_NATURE,
            "host": {
                "python": sys.version.split()[0],
                "machine": platform.machine(),
                "cpuCount": os.cpu_count(),
                "singleProcessSingleThread": True,
            },
            "indexReceipt": {
                "chunksStored": receipt["chunksStored"],
                "vectorsWritten": receipt["vectorsWritten"],
                "chunksWithoutSignature": receipt["chunksWithoutSignature"],
                "storeChunks": receipt["storeChunks"],
            },
            "backend": vectors.backend_status(),
            "fusion": {"reciprocalRankConstant": records.VECTOR_RRF_K, "weights": dict(records.FUSION_WEIGHTS),
                       "fusionPool": records.MAX_FUSION_POOL},
        },
        "corpus": {
            "files": len(manifest["files"]),
            "bytes": sum(int(item["bytes"]) for item in manifest["files"]),
            "chunkCount": len(inventory),
            "fileSha256": {item["path"]: item["sha256"] for item in manifest["files"]},
        },
        "vectorCoverage": coverage,
        "queries": {"total": len(per_query), "byGroup": {group: sum(1 for row in per_query if row["group"] == group) for group in GROUPS}},
        "latencyMs": {mode: latency_summary(latencies[mode]) for mode in modes},
        "refusals": refusals,
        "aggregate": aggregate,
        "perQuery": per_query,
        "nearCeilingFixture": near,
    }


def aggregate_results(per_query: list[dict[str, object]], modes: list[str], k: int) -> dict[str, object]:
    out: dict[str, object] = {}
    for mode in modes:
        by_group: dict[str, object] = {}
        for group in GROUPS:
            rows = [row for row in per_query if row["group"] == group]
            scored = [row for row in rows if row["modes"][mode].get("hitChunkIds") is not None]
            if group == "no-relevant-answer":
                by_group[group] = {
                    "queries": len(rows),
                    "queriesReturningAtLeastOneHit": sum(1 for row in scored if row["modes"][mode]["hitsReturned"] > 0),
                    "shareReturningAHit": round(sum(1 for row in scored if row["modes"][mode]["hitsReturned"] > 0) / max(len(rows), 1), 6),
                    "meanHitsReturned": round(statistics.fmean([row["modes"][mode]["hitsReturned"] for row in scored]) if scored else 0.0, 6),
                    "highestScoreReturned": round(max((row["modes"][mode]["topScore"] or 0.0) for row in scored) if scored else 0.0, 6),
                    "note": "Nothing in the corpus answers these queries, so every hit returned is a false positive. "
                            "Reported as a rate because the modes apply no relevance threshold.",
                }
                continue
            by_group[group] = {
                "queries": len(rows),
                "recallAtK": summarise([row["modes"][mode]["recallAtK"] for row in rows]),
                "ndcgAtK": summarise([row["modes"][mode]["ndcgAtK"] for row in rows]),
                "precisionAtK": summarise([row["modes"][mode]["precisionAtK"] for row in rows]),
                "queriesWithNoRelevantHit": sum(1 for row in rows if row["modes"][mode]["relevantReturned"] == 0),
            }
        out[mode] = {
            "groups": by_group,
            "overall": {
                "assessedQueries": sum(1 for row in per_query if row["group"] != "no-relevant-answer"),
                "recallAtK": summarise([row["modes"][mode]["recallAtK"] for row in per_query if row["group"] != "no-relevant-answer"]),
                "ndcgAtK": summarise([row["modes"][mode]["ndcgAtK"] for row in per_query if row["group"] != "no-relevant-answer"]),
                "precisionAtK": summarise([row["modes"][mode]["precisionAtK"] for row in per_query if row["group"] != "no-relevant-answer"]),
            },
        }
    return out


def near_ceiling_measurement(k: int) -> dict[str, object]:
    """Latency at the ceiling: a synthetic 20 000-chunk store, measured, not extrapolated (T16-04).

    This is not a relevance measurement — the fixture repeats one sentence 20 000 times so the store
    can be built in a test-sized budget. What it measures is the cost of the full scan every mode
    performs at the largest index the store is allowed to hold, which is the number a bounded
    candidate pre-filter would have to beat.
    """
    workspace = Path(tempfile.mkdtemp(prefix="rs-measure-ceiling-"))
    try:
        records.init_store(workspace)
        text = "The guild records name the stitching pattern of barefoot sandals."
        text_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
        blob = vectors.encode_vector(vectors.embed_text(text))
        stamp = "2026-11-22T00:00:00+00:00"
        connection = sqlite3.connect(records.store_path(workspace))
        try:
            connection.executemany(
                "INSERT INTO chunks (chunk_id, content_id, source_path, source_sha256, locator, text, text_sha256, "
                "chunker_id, chars, current, indexed_at, unit_kind, unit_index, char_start, char_end) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'paragraph', ?, 0, ?)",
                [(f"ceiling-{index:06d}", f"content-{index:06d}", f"notes/ceiling-{index // 1000}.md", f"{index:064x}"[:64],
                  f"paragraph={index % 1000};chars=0-{len(text)}", text, text_sha, "hashing:1200:120", len(text), stamp, index % 1000, len(text))
                 for index in range(records.MAX_STORE_CHUNKS)],
            )
            connection.executemany(
                "INSERT INTO chunk_vectors (chunk_id, backend_id, dimensions, text_sha256, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                [(f"ceiling-{index:06d}", vectors.BACKEND_ID, vectors.EMBEDDING_DIMENSIONS, text_sha, blob, stamp)
                 for index in range(records.MAX_STORE_CHUNKS)],
            )
            connection.commit()
        finally:
            connection.close()
        state = records.vector_index_state(workspace)
        probe_queries = ["guild records stitching", "barefoot sandals pattern", "stitching pattern guild records"]
        latencies: dict[str, list[float]] = {mode: [] for mode in records.SEARCH_MODES}
        scored: dict[str, int] = {}
        for mode in records.SEARCH_MODES:
            for query in probe_queries:
                _hits, _scores, retrieval, elapsed_ms = run_mode(workspace, query, mode, k)
                latencies[mode].append(elapsed_ms)
                # ``lexical`` answers with the 0.3.13 reply shape and carries no retrieval summary, so its
                # scanned set is the whole current index — the same number, read from the store instead.
                scored[mode] = int(retrieval.get("scoredChunks", state["currentChunkCount"]))
        return {
            "purpose": "full-scan cost at the store ceiling, on a synthetic repeated-sentence fixture",
            "notMeasured": "relevance quality: every chunk of this fixture has the same text, so no ranking claim is made from it",
            "currentChunks": state["currentChunkCount"],
            "decodableSignatures": state["scoreableChunks"],
            "probeQueries": len(probe_queries),
            "scoredChunksPerMode": scored,
            "latencyMs": {mode: latency_summary(latencies[mode]) for mode in records.SEARCH_MODES},
        }
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


# --------------------------------------------------------------------------------------
# Human-readable report
# --------------------------------------------------------------------------------------

def _joined_counts(counts: dict[str, object]) -> str:
    return ", ".join(f"{group} {count}" for group, count in counts.items())


def render_markdown(results: dict[str, object]) -> str:
    run = results["run"]
    lines = [
        "# Retrieval measurement 2026-11-22 (T16-03)",
        "",
        f"- Corpus: **{results['corpus']['files']} synthetic fixture files**, {results['corpus']['bytes']} bytes, "
        f"{results['corpus']['chunkCount']} chunks. {run['corpusNature']}",
        f"- Backend: `{run['backend']['backendId']}`, {run['backend']['dimensions']} dimensions, "
        f"`{run['backend']['encoding']}` — {run['backend']['nature']}. No model download, no network.",
        f"- Fusion: k = {run['fusion']['reciprocalRankConstant']}, weights {run['fusion']['weights']}, "
        f"candidate pool ceiling {run['fusion']['fusionPool']}. Unchanged from 0.3.14.",
        f"- Queries: {results['queries']['total']} assessed "
        f"({_joined_counts(results['queries']['byGroup'])}). "
        f"Repetitions: {run['repetitions']}. k = {run['k']}. Seed: {run['seed']}.",
        f"- Vector coverage: {results['vectorCoverage']['decodableSignatures']} of "
        f"{results['vectorCoverage']['currentChunks']} current chunks carry a signature that decodes at query time "
        f"({results['vectorCoverage']['coverageOfCurrentChunks'] * 100:.2f} %); "
        f"{results['vectorCoverage']['undecodableSignatures']} undecodable. Coverage is measured by decoding, "
        "not from row metadata.",
        f"- Deterministic across repetitions: **{run['deterministicAcrossRepetitions']}**. "
        f"Refusals during the run: {len(results['refusals'])}.",
        f"- Host: {run['host']['python']} on {run['host']['machine']}, {run['host']['cpuCount']} logical CPUs, "
        "one process, one thread.",
        "",
        "## Relevance per mode and language group",
        "",
        "| Mode | Group | Queries | Recall@10 | nDCG@10 | Precision@10 | Queries with no relevant hit |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ]
    for mode in run["modes"]:
        for group, values in results["aggregate"][mode]["groups"].items():
            if group == "no-relevant-answer":
                continue
            lines.append(
                f"| {mode} | {group} | {values['queries']} | {values['recallAtK']['mean']:.3f} | "
                f"{values['ndcgAtK']['mean']:.3f} | {values['precisionAtK']['mean']:.3f} | {values['queriesWithNoRelevantHit']} |")
        overall = results["aggregate"][mode]["overall"]
        lines.append(f"| {mode} | **all assessed** | {overall['assessedQueries']} | {overall['recallAtK']['mean']:.3f} | "
                     f"{overall['ndcgAtK']['mean']:.3f} | {overall['precisionAtK']['mean']:.3f} | — |")
    lines += [
        "",
        "The numbers above are means over the group. `Precision@10` is included because a mode that answers a",
        "Czech query from an English passage is measurable there, and the vector ranker is not cross-lingual.",
        "",
        "## Queries with no relevant answer",
        "",
        "| Mode | Queries | Returning at least one hit | Share | Mean hits | Highest score returned |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for mode in run["modes"]:
        values = results["aggregate"][mode]["groups"]["no-relevant-answer"]
        lines.append(f"| {mode} | {values['queries']} | {values['queriesReturningAtLeastOneHit']} | "
                     f"{values['shareReturningAHit'] * 100:.1f} % | {values['meanHitsReturned']:.2f} | {values['highestScoreReturned']:.3f} |")
    lines += [
        "",
        "Nothing in the corpus answers these queries. A hit here is a false positive, and the modes return it",
        "because no relevance threshold is applied — by design, so the weak score stays visible to the reader.",
        "",
        "## Latency per mode",
        "",
        "| Mode | Timed calls | Median | p95 | Max |",
        "| --- | --- | --- | --- | --- |",
    ]
    for mode in run["modes"]:
        latency = results["latencyMs"][mode]
        lines.append(f"| {mode} | {latency['samples']} | {latency['medianMs']:.2f} ms | {latency['p95Ms']:.2f} ms | {latency['maxMs']:.2f} ms |")
    near = results.get("nearCeilingFixture")
    if near:
        lines += [
            "",
            "## Cost of the full scan at the store ceiling",
            "",
            f"A synthetic store of exactly **{near['currentChunks']}** current chunks, "
            f"{near['decodableSignatures']} of them with a decodable signature, probed with "
            f"{near['probeQueries']} queries. {near['notMeasured']}.",
            "",
            "| Mode | Chunks scored per call | Median | p95 |",
            "| --- | --- | --- | --- |",
        ]
        for mode in run["modes"]:
            latency = near["latencyMs"][mode]
            lines.append(f"| {mode} | {near['scoredChunksPerMode'][mode]} | {latency['medianMs']:.2f} ms | {latency['p95Ms']:.2f} ms |")
    lines += [
        "",
        "## Per query",
        "",
        "| Query | Group | Relevant | lexical R@10 | vector R@10 | hybrid R@10 | hybrid nDCG@10 | hybrid found-by (L/V/both) |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for row in results["perQuery"]:
        modes = row["modes"]
        found = modes["hybrid"]["foundBy"]
        lines.append(
            f"| {row['id']} | {row['group']} | {row['relevantCount']} | {modes['lexical']['recallAtK']:.3f} | "
            f"{modes['vector']['recallAtK']:.3f} | {modes['hybrid']['recallAtK']:.3f} | {modes['hybrid']['ndcgAtK']:.3f} | "
            f"{found['lexicalOnly']}/{found['vectorOnly']}/{found['both']} |")
    lines += [
        "",
        "## What this does not show",
        "",
        "- The operator's own corpus is **not** measured here: it is not available in this environment, and nothing",
        "  in this directory quotes it. Every passage is synthetic fixture text.",
        "- Relevance was judged by construction (the answer passage was authored for the query), which is enough to",
        "  compare modes and releases and not enough to rank retrieval quality for a real researcher.",
        "- `rsk-hashing-v1` is a lexical signature, not a semantic model: no synonym, no negation, no translation.",
        "  Cross-language queries are expected to lose, and the Precision@10 column is where that shows.",
        "- Latency is one process on one core of one host. It is a measured figure for this host, not a published",
        "  performance claim.",
        "- No ranking change was made to produce these numbers, and no cosine threshold exists.",
        "",
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Measure lexical, vector and hybrid retrieval on the frozen synthetic corpus.")
    parser.add_argument("--evidence-dir", default=str(Path(__file__).resolve().parents[1] / EVIDENCE_DIRECTORY))
    parser.add_argument("--repetitions", type=int, default=5)
    parser.add_argument("--k", type=int, default=10)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--freeze", action="store_true", help="re-record the frozen corpus manifest (deliberate act)")
    parser.add_argument("--no-near-ceiling", action="store_true", help="skip the 20 000-chunk full-scan measurement")
    arguments = parser.parse_args(argv)

    evidence = Path(arguments.evidence_dir).expanduser().resolve()
    if arguments.freeze:
        manifest = freeze_manifest(evidence)
        print(f"FROZEN {manifest['chunkCount']} chunks from {len(manifest['files'])} corpus files into {evidence / MANIFEST_NAME}")
        return 0
    if not 1 <= arguments.k <= 50:
        print("RESULT_LIMIT: k must be 1..50 (the store answers at most 50 hits per call).", file=sys.stderr)
        return 2
    if arguments.repetitions < 1:
        print("REPETITIONS: pass a positive number of repetitions.", file=sys.stderr)
        return 2

    results = measure(evidence, repetitions=arguments.repetitions, k=arguments.k, seed=arguments.seed,
                      near_ceiling=not arguments.no_near_ceiling)
    (evidence / RESULTS_JSON).write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (evidence / RESULTS_MD).write_text(render_markdown(results), encoding="utf-8")

    for mode in results["run"]["modes"]:
        overall = results["aggregate"][mode]["overall"]
        latency = results["latencyMs"][mode]
        print(f"{mode:8s} recall@{results['run']['k']}={overall['recallAtK']['mean']:.3f} "
              f"ndcg@{results['run']['k']}={overall['ndcgAtK']['mean']:.3f} "
              f"median={latency['medianMs']:.2f}ms p95={latency['p95Ms']:.2f}ms")
    print(f"wrote {evidence / RESULTS_JSON} and {evidence / RESULTS_MD}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except MeasurementError as failure:
        print(f"{type(failure).__name__}: {failure}", file=sys.stderr)
        sys.exit(1)
