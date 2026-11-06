"""v0.3.9 direct ingestion: units, coverage, provenance and chunk identity for PDF and DOCX.

Every case here is about the promise the release makes: a PDF or DOCX is indexed as the document
it is, with the page or item a chunk came from, and with the coverage that decides whether the
read was complete, partial or failed. Nothing in this file writes to a source file.
"""
import hashlib
import json
from pathlib import Path

import pytest
from docx import Document
from pypdf import PdfReader, PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from research_stack import documents, full
from research_stack.full import FullPrototypeError, chunks_for_source, scan_sources


def text_pdf(path: Path, pages: list[str]) -> Path:
    """Author a small text-bearing PDF with pypdf alone, so the fixture is reproducible."""
    writer = PdfWriter()
    for text in pages:
        page = writer.add_blank_page(width=612, height=792)
        stream = DecodedStreamObject()
        escaped = text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
        stream.set_data(f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode("latin-1"))
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
    with path.open("wb") as handle:
        writer.write(handle)
    return path


def text_docx(path: Path, paragraphs: list[str], table_rows: list[tuple[str, str]] | None = None) -> Path:
    document = Document()
    for paragraph in paragraphs:
        document.add_paragraph(paragraph)
    if table_rows:
        table = document.add_table(rows=len(table_rows), cols=2)
        for row, (left, right) in enumerate(table_rows):
            table.cell(row, 0).text = left
            table.cell(row, 1).text = right
    document.save(path)
    return path


class _RaisingPage:
    def __init__(self, text: str | None) -> None:
        self._text = text

    def extract_text(self) -> str:
        if self._text is None:
            raise RuntimeError("simulated content-stream failure")
        return self._text


class _ReaderWithBrokenPages:
    def __init__(self, texts: list[str | None]) -> None:
        self.is_encrypted = False
        self.pages = [_RaisingPage(text) for text in texts]


def test_pdf_units_keep_page_identity_and_name_empty_pages(tmp_path: Path) -> None:
    source = text_pdf(tmp_path / "three pages.pdf",
                      ["First page sentence about sandals.", "", "Third page sentence about guild records."])
    extracted = documents.extract_source(source)

    assert extracted.kind == "pdf"
    assert extracted.sha256 == hashlib.sha256(source.read_bytes()).hexdigest()
    assert extracted.parser["id"] == documents.PDF_PARSER_ID
    assert extracted.parser["version"], "a parser identity without a version cannot be audited later"
    assert [unit.index for unit in extracted.units] == [1, 2, 3]
    assert [unit.kind for unit in extracted.units] == ["page", "page", "page"]
    coverage = extracted.coverage
    assert coverage["unit"] == "page" and coverage["totalUnits"] == 3 and coverage["unitsRead"] == 3
    assert coverage["unitsWithText"] == 2 and coverage["emptyUnits"] == [2] and coverage["failedUnits"] == []
    assert coverage["complete"] is True and coverage["textBearing"] is True
    assert extracted.outcome == "complete", "a page with no text is an empty page, not a failed read"
    assert any(warning.startswith("NO_TEXT_UNITS") for warning in extracted.warnings)
    assert not any(warning.startswith("UNITS_UNREADABLE") for warning in extracted.warnings)


def test_docx_units_are_ordered_paragraphs_and_table_rows(tmp_path: Path) -> None:
    source = text_docx(tmp_path / "notes.docx",
                       ["Opening paragraph.", "Second paragraph.", "Third paragraph."],
                       [("Evidence", "Table value"), ("Second row", "Second value"), ("Third row", "Third value")])
    extracted = documents.extract_source(source)

    assert extracted.kind == "docx" and extracted.parser["id"] == documents.DOCX_PARSER_ID
    kinds = [unit.kind for unit in extracted.units]
    assert len(kinds) == extracted.coverage["totalUnits"] == 6, "three paragraphs plus three table rows"
    assert kinds[:3] == ["paragraph"] * 3
    assert all(kind.startswith("table") for kind in kinds[3:]), "table rows are units in their own order"
    assert extracted.outcome == "complete" and extracted.coverage["complete"] is True
    assert extracted.units[3].text == "Evidence | Table value" and extracted.units[4].kind == "table-1-row"


def test_a_page_that_cannot_be_read_is_that_pages_failure_not_the_files_verdict(tmp_path: Path, monkeypatch) -> None:
    source = text_pdf(tmp_path / "one broken page.pdf", ["First page.", "Second page."])
    monkeypatch.setattr(documents, "PdfReader", lambda *args, **kwargs: _ReaderWithBrokenPages(["First page.", None, "Third page."]))
    extracted = documents.extract_source(source)

    assert extracted.outcome == "partial"
    assert extracted.coverage["failedUnits"] == [2] and extracted.coverage["unitsWithText"] == 2
    assert extracted.coverage["complete"] is False
    assert any(warning.startswith("UNITS_UNREADABLE") for warning in extracted.warnings)
    assert extracted.units[1].error.startswith("PDF_PAGE_PARSE_FAILED")
    assert extracted.units[0].text == "First page." and extracted.units[2].text == "Third page."
    assert source.read_bytes(), "the reader must not have touched the source"


def test_a_source_whose_units_all_fail_is_classified_failed(tmp_path: Path, monkeypatch) -> None:
    source = text_pdf(tmp_path / "unreadable.pdf", ["First page."])
    monkeypatch.setattr(documents, "PdfReader", lambda *args, **kwargs: _ReaderWithBrokenPages([None, None]))
    extracted = documents.extract_source(source)

    assert extracted.outcome == "failed"
    assert extracted.coverage["failedUnits"] == [1, 2] and extracted.coverage["unitsWithText"] == 0
    assert extracted.coverage["textBearing"] is False


def test_a_source_that_changes_while_it_is_being_read_is_refused(tmp_path: Path, monkeypatch) -> None:
    source = text_pdf(tmp_path / "moving.pdf", ["First page.", "Second page.", "Third page."])
    real_units = documents._pdf_units

    def units_that_write(reader, start, end, *, tolerate_unit_failure):
        result = real_units(reader, start, end, tolerate_unit_failure=tolerate_unit_failure)
        if start == 1:
            source.write_bytes(source.read_bytes() + b"\n")  # the file moves under the reader
        return result

    monkeypatch.setattr(documents, "_pdf_units", units_that_write)
    with pytest.raises(documents.DocumentError) as failure:
        documents.extract_source(source)
    assert "SOURCE_CHANGED_DURING_INDEX" in str(failure.value)


def test_a_long_pdf_is_read_in_bounded_batches_and_coverage_proves_it(tmp_path: Path) -> None:
    pages = [f"Page {number} of the long document." for number in range(1, 251)]
    source = text_pdf(tmp_path / "long.pdf", pages)
    extracted = documents.extract_source(source)

    assert extracted.coverage["totalUnits"] == 250
    assert extracted.coverage["batchLimit"] == documents.MAX_BATCH_UNITS == 100
    assert extracted.coverage["batches"] == 3 and extracted.coverage["unitsRead"] == 250
    assert extracted.outcome == "complete" and extracted.coverage["complete"] is True


def test_a_source_whose_text_exceeds_the_index_ceiling_is_refused(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(documents, "MAX_INDEX_CHARS", 50)
    source = text_pdf(tmp_path / "too much.pdf", ["First page with a long sentence about sandals. ", "Second page with a long sentence about guilds. "])
    with pytest.raises(documents.DocumentError) as failure:
        documents.extract_source(source)
    assert "SOURCE_TEXT_TOO_LARGE" in str(failure.value)
    assert "limit is 50" in str(failure.value), "the receipt must name the ceiling it applied"


def test_the_public_range_contract_is_unchanged(tmp_path: Path) -> None:
    source = text_pdf(tmp_path / "range.pdf", ["First page.", "Second page."])
    with pytest.raises(documents.DocumentError) as failure:
        documents.extract_document(source, start=1, count=documents.MAX_BATCH_UNITS + 1)
    assert "INVALID_RANGE: start must be positive and count must be 1..100." in str(failure.value)
    with pytest.raises(documents.DocumentError) as beyond:
        documents.extract_document(source, start=9)
    assert "INVALID_RANGE: PDF has 2 pages." in str(beyond.value)


def test_a_stored_locator_reopens_the_unit_it_came_from_with_its_neighbours(tmp_path: Path) -> None:
    source = text_pdf(tmp_path / "locator.pdf", ["First page.", "Second page.", "Third page."])
    reopened = documents.read_document_at_locator(source, "page=2;chars=0-12", context=1)
    assert reopened.coverage["returnedFrom"] == 1 and reopened.coverage["returnedTo"] == 3
    assert "Second page." in reopened.text and "First page." in reopened.text
    assert reopened.locators[1] == {"page": 2, "characters": 12}
    with pytest.raises(documents.DocumentError) as invalid:
        documents.locator_unit("page-2")
    assert "LOCATOR_INVALID" in str(invalid.value)


def test_pdf_chunks_never_cross_a_page_and_carry_the_page_they_came_from(tmp_path: Path) -> None:
    root = tmp_path
    page_one = " ".join(f"sandals-{number}" for number in range(60))
    page_three = " ".join(f"guilds-{number}" for number in range(60))
    text_pdf(root / "paper.pdf", [page_one, "", page_three])
    record = scan_sources(root, ["paper.pdf"])[0]
    chunks = chunks_for_source(record, chunk_chars=200, overlap_chars=20)

    assert record.kind == "pdf" and record.parser["id"] == documents.PDF_PARSER_ID
    assert record.outcome == "complete" and record.units and len(record.units) == 3
    assert chunks, "a text-bearing PDF must yield chunks"
    assert all(chunk.chunker_id.startswith(full.PDF_CHUNKER_ID) for chunk in chunks)
    pages = {chunk.locator.split(";")[0] for chunk in chunks}
    assert pages == {"page=1", "page=3"}, "the textless page yields no chunk and no chunk borrows from it"
    for chunk in chunks:
        page_number = int(chunk.locator.split("=")[1].split(";")[0])
        unit_text = record.units[page_number - 1].text
        assert chunk.text in unit_text, f"chunk crossed a page boundary: {chunk.locator}"
        start, end = (int(value) for value in chunk.locator.split("chars=")[1].split("-"))
        assert unit_text[start:end] == chunk.text, "the character span is not the span of the text it names"
        assert chunk.unit_kind == "page" and chunk.unit_index == page_number
        assert chunk.char_start == start and chunk.char_end == end


def test_docx_chunks_name_the_item_kind_and_never_cross_an_item(tmp_path: Path) -> None:
    root = tmp_path
    text_docx(root / "notes.docx", [" ".join(f"paragraph-{number}" for number in range(60))],
              [(" ".join(f"left-{number}" for number in range(40)), " ".join(f"right-{number}" for number in range(40)))])
    record = scan_sources(root, ["notes.docx"])[0]
    chunks = chunks_for_source(record, chunk_chars=200, overlap_chars=20)

    assert record.kind == "docx" and all(chunk.chunker_id.startswith(full.DOCX_CHUNKER_ID) for chunk in chunks)
    items = {chunk.locator.split(";")[0] for chunk in chunks}
    assert len(items) >= 2, "a chunk that spans two items would collapse them into one locator"
    for chunk in chunks:
        item_index = int(chunk.locator.split("=")[1].split(";")[0])
        unit = record.units[item_index - 1]
        assert chunk.text in unit.text, f"chunk crossed an item boundary: {chunk.locator}"
        assert f"kind={unit.kind}" in chunk.locator and chunk.unit_kind == unit.kind
        assert unit.text[chunk.char_start:chunk.char_end] == chunk.text


def test_a_mixed_batch_is_accepted_and_an_unsupported_format_is_named(tmp_path: Path) -> None:
    root = tmp_path
    text_pdf(root / "paper.pdf", ["A PDF sentence about sandals."])
    text_docx(root / "notes.docx", ["A DOCX sentence about sandals."])
    (root / "memo.md").write_text("A Markdown sentence about sandals.\n", encoding="utf-8")
    (root / "legacy.doc").write_bytes(b"\xd0\xcf\x11\xe6legacy binary")

    records = scan_sources(root, ["paper.pdf", "notes.docx", "memo.md"])
    assert [record.kind for record in records] == ["pdf", "docx", "text"]
    assert [record.unit for record in records] == ["page", "paragraph or table row", "paragraph"]

    with pytest.raises(FullPrototypeError) as failure:
        scan_sources(root, ["legacy.doc"])
    assert "UNSUPPORTED_FORMAT: index_corpus accepts UTF-8 Markdown, text, PDF or DOCX only." in str(failure.value)


def test_text_source_chunk_identity_is_unchanged_from_0_3_8(tmp_path: Path) -> None:
    """The 0.3.8 identity formula, recomputed here from the documented parts, not from the module."""
    root = tmp_path
    body = "# Dissertation\n\nBarefoot sandals appear in the 14th-century illuminations. " \
           "The stitching pattern is documented in the guild records.\n" * 4
    (root / "dissertation.md").write_text(body, encoding="utf-8")
    record = scan_sources(root, ["dissertation.md"])[0]
    chunks = chunks_for_source(record, chunk_chars=1200, overlap_chars=120)

    assert chunks and all(chunk.chunker_id == "paragraph-window-v1:1200:120" for chunk in chunks)
    assert all(chunk.unit_kind == "paragraph" and chunk.char_start >= 0 for chunk in chunks)
    for chunk in chunks:
        paragraph_index = int(chunk.locator.split("=")[1].split(";")[0])
        assert chunk.locator.startswith(f"paragraph={paragraph_index};chars=")
        text_hash = hashlib.sha256(chunk.text.encode("utf-8")).hexdigest()
        fingerprint = "paragraph-window-v1:1200:120"
        expected = hashlib.sha256(json.dumps(
            [record.source_path, record.source_version_id, fingerprint, chunk.locator, text_hash],
            ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        assert chunk.chunk_id == expected, "chunk identity changed: stored claims would lose their evidence"
        content = hashlib.sha256(json.dumps(
            [record.source_version_id, fingerprint, chunk.locator, text_hash],
            ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        assert chunk.content_id == content

    stored = chunks[0].as_dict()
    for legacy_key in ["chunk_id", "content_id", "source_version_id", "source_path", "locator", "text", "text_sha256", "chunker_id"]:
        assert legacy_key in stored, f"0.3.8 consumers of {legacy_key} would break"


def test_a_pdf_source_record_carries_coverage_warnings_and_the_source_hash(tmp_path: Path) -> None:
    root = tmp_path
    text_pdf(root / "sparse.pdf", ["First page sentence.", "", "Third page sentence."])
    record = scan_sources(root, ["sparse.pdf"])[0]

    assert record.source_version_id == hashlib.sha256((root / "sparse.pdf").read_bytes()).hexdigest()
    assert record.outcome == "complete"
    assert record.coverage["emptyUnits"] == [2] and record.coverage["totalUnits"] == 3
    assert any(warning.startswith("NO_TEXT_UNITS") for warning in record.warnings)
    assert record.units and record.units[1].text == ""
