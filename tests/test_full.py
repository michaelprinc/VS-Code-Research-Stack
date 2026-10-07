from pathlib import Path

import pytest

from research_stack.full import FullPrototypeError, build_corpus, search_bm25


def test_markdown_corpus_has_stable_source_and_chunk_identity(tmp_path: Path) -> None:
    (tmp_path / "study.md").write_text("# Methods\n\nCzech výzkum about water.\n", encoding="utf-8")
    first = build_corpus(tmp_path, ["study.md"])
    repeated = build_corpus(tmp_path, ["study.md"])

    assert first == repeated
    assert first[0].source_path == "study.md"
    assert len(first[0].source_version_id) == 64
    assert "paragraph=" in first[0].locator


def test_bm25_returns_ranked_provenance_and_no_unrelated_results(tmp_path: Path) -> None:
    (tmp_path / "water.md").write_text("Water quality evidence from the river.", encoding="utf-8")
    (tmp_path / "forest.md").write_text("Lesní ekologie a biodiversita.", encoding="utf-8")
    chunks = build_corpus(tmp_path, ["water.md", "forest.md"])

    hits = search_bm25(chunks, "water quality")

    assert len(hits) == 1
    assert hits[0].chunk.source_path == "water.md"
    assert hits[0].chunk.source_version_id == chunks[0].source_version_id
    assert hits[0].retrieval_method == "bm25"


def test_long_paragraph_windows_are_bounded_and_deterministic(tmp_path: Path) -> None:
    (tmp_path / "long.txt").write_text("A" * 1000, encoding="utf-8")
    chunks = build_corpus(tmp_path, ["long.txt"], chunk_chars=400, overlap_chars=40)

    assert len(chunks) == 3
    assert all(len(chunk.text) <= 400 for chunk in chunks)
    assert chunks == build_corpus(tmp_path, ["long.txt"], chunk_chars=400, overlap_chars=40)


def test_rejects_path_escape_and_invalid_utf8(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside.md"
    outside.write_text("outside", encoding="utf-8")
    with pytest.raises(FullPrototypeError, match="SOURCE_OUTSIDE_ROOT"):
        build_corpus(tmp_path, ["../outside.md"])
    with pytest.raises(FullPrototypeError, match="SOURCE_OUTSIDE_ROOT"):
        build_corpus(tmp_path, [r"C:\private\secret.md"])

    (tmp_path / "broken.md").write_bytes(b"\xff\xfe")
    with pytest.raises(FullPrototypeError, match="INVALID_UTF8"):
        build_corpus(tmp_path, ["broken.md"])


def test_changed_source_gets_new_version_and_chunk_identity(tmp_path: Path) -> None:
    source = tmp_path / "study.md"
    source.write_text("Original evidence.", encoding="utf-8")
    original = build_corpus(tmp_path, ["study.md"])[0]
    source.write_text("Updated evidence.", encoding="utf-8")
    updated = build_corpus(tmp_path, ["study.md"])[0]

    assert original.source_version_id != updated.source_version_id
    assert original.chunk_id != updated.chunk_id
