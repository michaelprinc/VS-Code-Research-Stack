"""v0.3.9 freshness, preservation and transactional indexing in the record store.

The release promise these cases hold: the store says which version it indexed, which file it has
actually re-hashed, and what it refused to write. A source file is never modified by any of this.
"""
import dataclasses
import inspect
import sqlite3
from pathlib import Path

import pytest

from research_stack import documents, records
from research_stack.records import StoreError

NOTES = "notes/dissertation.md"
PDF = "notes/paper.pdf"
BODY = ("# Dissertation\n\nBarefoot sandals appear in the 14th-century illuminations. "
        "The stitching pattern is documented in the guild records.\n") * 3


def workspace(tmp_path: Path) -> Path:
    (tmp_path / "notes").mkdir()
    (tmp_path / NOTES).write_text(BODY, encoding="utf-8")
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=612, height=792)
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 72 720 Td (Guild records about sandals.) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    font = DictionaryObject()
    font[NameObject("/Type")] = NameObject("/Font")
    font[NameObject("/Subtype")] = NameObject("/Type1")
    font[NameObject("/BaseFont")] = NameObject("/Helvetica")
    fonts = DictionaryObject()
    fonts[NameObject("/F1")] = writer._add_object(font)
    resources = DictionaryObject()
    resources[NameObject("/Font")] = writer._add_object(fonts)
    page[NameObject("/Resources")] = writer._add_object(resources)
    with (tmp_path / PDF).open("wb") as handle:
        writer.write(handle)
    return tmp_path


def claim_over(tmp_path: Path, chunk_id: str) -> str:
    written = records.write_claim(tmp_path, "The guild records document the stitching pattern.",
                                  evidence_chunk_ids=[chunk_id])
    return written["claim"]["claim_id"]


def test_indexing_records_the_version_it_read_and_marks_it_verified(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    receipt = records.index_corpus(root, [NOTES, PDF])

    assert receipt["status"] == "complete" and receipt["written"] == 2
    assert receipt["sourceFilesModified"] is False
    state = records.index_state(root)
    by_path = {source["path"]: source for source in state["sources"]}
    assert by_path[PDF]["kind"] == "pdf" and by_path[PDF]["unit"] == "page"
    assert by_path[PDF]["parser"]["id"] == documents.PDF_PARSER_ID and by_path[PDF]["parser"]["version"]
    assert by_path[PDF]["outcome"] == "complete" and by_path[PDF]["freshness"] == "verified"
    assert by_path[PDF]["units_total"] == 1 and by_path[PDF]["units_extracted"] == 1
    assert state["freshness"] == {"verified": 2}
    assert "recorded hash check" in state["freshnessNote"]


def test_verify_sources_labels_a_changed_file_as_changed(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES, PDF])
    before = records.verify_sources(root)
    assert before["verified"] == [NOTES, PDF] and before["changed"] == []
    assert before["sourceFilesModified"] is False

    (root / NOTES).write_text(BODY + "A sentence added after the index was built.\n", encoding="utf-8")
    after = records.verify_sources(root)
    assert after["changed"] == [NOTES] and after["verified"] == [PDF]
    assert after["uncheckedRemaining"] == 0
    state = records.index_state(root)
    freshness = {source["path"]: source["freshness"] for source in state["sources"]}
    assert freshness[NOTES] == "changed" and freshness[PDF] == "verified"
    assert state["freshness"] == {"changed": 1, "verified": 1}
    assert (root / NOTES).read_text(encoding="utf-8").endswith("added after the index was built.\n"), \
        "verify_sources reports the change, it does not repair or rewrite the source"


def test_a_deleted_source_is_missing_and_a_replaced_path_is_inaccessible(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES, PDF])
    (root / PDF).unlink()
    (root / "notes" / "dissertation.md").rename(root / "notes" / "moved.md")
    (root / NOTES).mkdir()

    checked = records.verify_sources(root)
    assert checked["missing"] == [PDF]
    assert checked["changed"] == [NOTES] or checked["inaccessible"] == [NOTES]
    assert checked["verified"] == []
    assert checked["uncheckedRemaining"] == 0


def test_an_unchecked_source_is_counted_and_not_accused(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    connection = sqlite3.connect(records.store_path(root))
    connection.execute("UPDATE sources SET verification = 'unchecked'")
    connection.commit()
    connection.close()

    state = records.index_state(root)
    assert state["freshness"] == {"unchecked": 1}
    exported = records.export_claims(root, [claim_over(root, records.stored_chunks(root)[0].chunk_id)])
    assert exported["references"], "an unchecked source is still the version the index holds"
    assert exported["uncheckedReferences"] == 1
    assert exported["references"][0]["sourceVerification"] == "unchecked"
    assert exported["references"][0]["historical"] is False


def test_export_excludes_stale_references_and_counts_them(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    chunk_id = records.stored_chunks(root)[0].chunk_id
    claim_id = claim_over(root, chunk_id)

    (root / NOTES).write_text(BODY + "Rewritten after the claim was made.\n", encoding="utf-8")
    records.index_corpus(root, [NOTES])

    default = records.export_claims(root, [claim_id])
    assert default["references"] == [] and default["excludedStaleReferences"] == 1
    assert default["claims"][0]["staleEvidenceCount"] == 1 and default["claims"][0]["usableEvidenceCount"] == 0

    with_history = records.export_claims(root, [claim_id], include_stale=True)
    assert len(with_history["references"]) == 1
    assert with_history["references"][0]["historical"] is True
    assert with_history["references"][0]["chunkId"] == chunk_id
    assert with_history["excludedStaleReferences"] == 0

    state = records.index_state(root)
    assert state["retainedChunkCount"] >= 1, "the claim's evidence must survive the reindex"


def test_export_excludes_a_source_that_no_longer_matches_unless_asked(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    claim_id = claim_over(root, records.stored_chunks(root)[0].chunk_id)
    (root / NOTES).write_text("Nothing about sandals survives in this file.\n", encoding="utf-8")
    records.verify_sources(root)

    default = records.export_claims(root, [claim_id])
    assert default["references"] == [] and default["excludedUnverifiedReferences"] == 1
    assert default["claims"][0]["unverifiedEvidenceCount"] == 1

    labelled = records.export_claims(root, [claim_id], include_unverified=True)
    assert len(labelled["references"]) == 1
    assert labelled["references"][0]["sourceVerification"] == "changed"
    assert labelled["references"][0]["historical"] is True


def test_a_partial_source_is_not_written_unless_the_operator_accepts_it(tmp_path: Path, monkeypatch) -> None:
    root = workspace(tmp_path)
    (root / "notes" / "partial.docx").write_bytes(b"placeholder")
    from docx import Document

    document = Document()
    document.add_paragraph("A paragraph that reads cleanly.")
    document.save(root / "notes" / "partial.docx")
    path = root / "notes" / "partial.docx"
    real_extract = documents.extract_source

    def partial_extract(source: Path):
        extracted = real_extract(source)
        coverage = dict(extracted.coverage)
        coverage.update({"complete": False, "failedUnits": [2], "unitsWithText": 1})
        return dataclasses.replace(extracted, outcome="partial", coverage=coverage,
                                   warnings=["UNITS_UNREADABLE: 1 of 2 paragraphs could not be read and was not indexed: 2."])

    monkeypatch.setattr(documents, "extract_source", partial_extract)
    refused = records.index_corpus(root, ["notes/partial.docx"])

    assert refused["status"] == "failed" and refused["written"] == 0
    refused_entry = refused["keptPreviousVersion"][0]
    assert refused_entry["path"] == "notes/partial.docx"
    assert refused_entry["reason"].startswith("accept_partial is false")
    assert refused_entry["outcome"] == "partial" and refused_entry["hadPreviousVersion"] is False
    assert records.index_state(root)["sourceCount"] == 0, "a partial read must not become the indexed version"

    accepted = records.index_corpus(root, ["notes/partial.docx"], accept_partial=True)
    assert accepted["written"] == 1 and accepted["acceptedPartial"] is True
    source = records.index_state(root)["sources"][0]
    assert source["outcome"] == "partial" and source["freshness"] == "verified"
    assert any(warning.startswith("UNITS_UNREADABLE") for warning in source["warnings"])


def test_a_cancelled_run_leaves_the_store_exactly_as_it_was(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    first = records.index_corpus(root, [NOTES])
    chunks_before = records.index_state(root)["chunkCount"]

    cancelled = records.index_corpus(root, [NOTES, PDF], cancel=lambda: True)
    assert cancelled["status"] == "cancelled" and cancelled["written"] == 0
    assert cancelled["indexFingerprint"] is None

    state = records.index_state(root)
    assert state["chunkCount"] == chunks_before and state["indexFingerprint"] == first["indexFingerprint"]
    assert [source["path"] for source in state["sources"]] == [NOTES]
    connection = sqlite3.connect(records.store_path(root))
    status = connection.execute("SELECT status FROM index_runs ORDER BY started_at").fetchall()
    connection.close()
    assert [row[0] for row in status] == ["complete", "cancelled"]


def test_one_call_is_one_transaction_when_one_source_fails(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    (root / "notes" / "corrupt.pdf").write_bytes(b"%PDF-1.4 not a real document\ntrailer\n%%EOF\n")

    receipt = records.index_corpus(root, [NOTES, "notes/corrupt.pdf", PDF])
    assert receipt["status"] == "partial" and receipt["written"] == 2
    assert receipt["failedSources"][0]["path"] == "notes/corrupt.pdf"
    assert receipt["failedSources"][0]["keptPreviousVersion"] is True
    assert receipt["failedSources"][0]["code"], "the receipt must carry the reader's own code"

    indexed = [source["path"] for source in records.index_state(root)["sources"]]
    assert indexed == [NOTES, PDF], "the readable sources are indexed; the unreadable one is reported, not guessed"


def test_every_index_call_leaves_one_run_row(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES])
    records.index_corpus(root, [PDF])
    records.index_corpus(root, [NOTES], cancel=lambda: True)

    connection = sqlite3.connect(records.store_path(root))
    rows = connection.execute("SELECT run_id, mode, status, source_count FROM index_runs ORDER BY started_at").fetchall()
    connection.close()
    assert len(rows) == 3 and len({row[0] for row in rows}) == 3
    assert [row[2] for row in rows] == ["complete", "complete", "cancelled"]


def test_the_store_chunk_ceiling_is_one_constant_not_two_numbers() -> None:
    default = inspect.signature(records.stored_chunks).parameters["limit"].default
    assert default == records.MAX_STORE_CHUNKS, (
        "the store ceiling and the retrieval candidate limit must be the same reviewed number")


def test_reindex_preview_names_what_a_reindex_would_replace(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    records.index_corpus(root, [NOTES, PDF])
    (root / "notes" / "gone.md").write_text("A file that is no longer here.\n", encoding="utf-8")
    records.index_corpus(root, ["notes/gone.md"])
    (root / "notes" / "gone.md").unlink()

    preview = records.reindex_preview(root, [NOTES, "notes/gone.md"])
    assert preview["unreadableSources"], "a source the store holds but the workspace no longer has must be named"
    named = {item["path"] for item in preview["unreadableSources"]}
    assert "notes/gone.md" in named


def test_a_source_count_over_the_limit_is_refused_before_anything_is_read(tmp_path: Path) -> None:
    root = workspace(tmp_path)
    with pytest.raises(StoreError) as failure:
        records.index_corpus(root, [NOTES] * (records.MAX_INDEX_SOURCES + 1))
    assert "SOURCE_COUNT" in str(failure.value)
    assert not records.store_path(root).exists()
