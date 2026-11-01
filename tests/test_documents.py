from pathlib import Path

import pytest
from docx import Document
from pypdf import PdfReader, PdfWriter

from research_stack.documents import (
    DocumentError,
    extract_document,
    read_text_document,
    report_model,
    render_markdown,
    validate_sources,
    write_docx_report,
    write_markdown_report,
)
from research_stack.bundle import export_bundle
from research_stack.paths import PathPolicyError, resolve_under


def fixtures(tmp_path: Path) -> tuple[Path, Path]:
    pdf = tmp_path / "czech paper č.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=300, height=300)
    # pypdf does not author text; use a DOCX for content and an empty PDF for OCR-state testing.
    with pdf.open("wb") as stream:
        writer.write(stream)
    docx = tmp_path / "notes space.docx"
    doc = Document()
    doc.add_paragraph("Výzkumná poznámka — Unicode test.")
    table = doc.add_table(rows=1, cols=2)
    table.cell(0, 0).text = "Evidence"
    table.cell(0, 1).text = "Table value"
    doc.save(docx)
    return pdf, docx


def test_docx_unicode_and_table_locators(tmp_path: Path) -> None:
    _, docx = fixtures(tmp_path)
    extracted = extract_document(docx)
    assert "Výzkumná poznámka" in extracted.text
    assert "Evidence | Table value" in extracted.text
    assert extracted.locators[0]["item"] == 1
    assert len(extracted.sha256) == 64


def test_scanned_pdf_is_explicitly_flagged(tmp_path: Path) -> None:
    pdf, _ = fixtures(tmp_path)
    extracted = extract_document(pdf)
    assert extracted.warnings and "OCR" in extracted.warnings[0]


def test_output_never_overwrites(tmp_path: Path) -> None:
    output = tmp_path / "report.md"
    output.write_text("keep", encoding="utf-8")
    with pytest.raises(DocumentError, match="OUTPUT_EXISTS"):
        write_markdown_report(output, "Title", "Body", [])
    assert output.read_text(encoding="utf-8") == "keep"


def test_workspace_path_policy_rejects_escape(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    with pytest.raises(PathPolicyError, match="PATH_OUTSIDE_WORKSPACE"):
        resolve_under(root, "../outside.pdf", must_exist=False)


def test_manual_bundle_copies_and_indexes_without_changing_source(tmp_path: Path) -> None:
    _, docx = fixtures(tmp_path)
    digest = __import__("hashlib").sha256(docx.read_bytes()).hexdigest()
    result = export_bundle(tmp_path / "handoff", [docx])
    assert result["sourceCount"] == 1
    copied = tmp_path / "handoff" / "01-notes space.docx"
    assert copied.read_bytes() == docx.read_bytes()
    assert __import__("hashlib").sha256(docx.read_bytes()).hexdigest() == digest
    assert digest in (tmp_path / "handoff" / "source-index.md").read_text(encoding="utf-8")


def test_docx_report_contains_sources_and_never_overwrites(tmp_path: Path) -> None:
    _, source = fixtures(tmp_path)
    digest = __import__("hashlib").sha256(source.read_bytes()).hexdigest()
    report = tmp_path / "outputs" / "report.docx"
    result = write_docx_report(report, "Evidence report", "Finding one.\nFinding two.", [{"label": "Synthetic", "reference": "page 1", "sha256": digest}])
    assert result["sha256"] == __import__("hashlib").sha256(report.read_bytes()).hexdigest()
    content = "\n".join(p.text for p in Document(report).paragraphs)
    assert "Finding one." in content and "Synthetic" in content and digest in content
    with pytest.raises(DocumentError, match="OUTPUT_EXISTS"):
        write_docx_report(report, "Replacement", "", [])


def _paragraph_table_paragraph(tmp_path: Path) -> Path:
    docx = tmp_path / "ordered.docx"
    doc = Document()
    doc.add_paragraph("First paragraph before the table.")
    table = doc.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "Year"
    table.cell(0, 1).text = "Record"
    table.cell(1, 0).text = "1349"
    table.cell(1, 1).text = "Guild entry"
    doc.add_paragraph("Second paragraph after the table.")
    doc.save(docx)
    return docx


def test_docxOrder_extracts_body_blocks_in_document_order(tmp_path: Path) -> None:
    """F15: a paragraph/table/paragraph document must not extract as paragraph/paragraph/table."""
    extracted = extract_document(_paragraph_table_paragraph(tmp_path))
    kinds = [locator["kind"] for locator in extracted.locators]
    assert kinds == ["paragraph", "table-1-row", "table-1-row", "paragraph"]
    assert extracted.text.index("First paragraph") < extracted.text.index("Guild entry") < extracted.text.index("Second paragraph")
    assert extracted.coverage["totalUnits"] == 4 and extracted.coverage["truncated"] is False


def test_document_range_navigation_reports_coverage(tmp_path: Path) -> None:
    extracted = extract_document(_paragraph_table_paragraph(tmp_path), start=2, count=1)
    assert extracted.coverage["returnedFrom"] == 2 and extracted.coverage["returnedTo"] == 2
    assert extracted.coverage["truncated"] is True and extracted.coverage["totalUnits"] == 4
    assert extracted.locators[0]["kind"] == "table-1-row"


def test_notesReopen_reads_a_text_hit_with_adjacent_context(tmp_path: Path) -> None:
    """F16: a Markdown hit must be reopenable through a reader, not only through the PDF/DOCX reader."""
    note = tmp_path / "notes.md"
    note.write_text("First paragraph about the guild.\n\nSecond paragraph about the stitching pattern.\n\nThird paragraph about the guild archive.\n", encoding="utf-8")
    result = read_text_document(note, locator="paragraph=2", context=1)
    assert result.kind == "text" and len(result.sha256) == 64
    assert "stitching pattern" in result.text and "First paragraph" in result.text and "guild archive" in result.text
    assert [item["locator"] for item in result.locators] == ["paragraph=1", "paragraph=2", "paragraph=3"]
    assert result.coverage["totalUnits"] == 3

    windowed = read_text_document(note, start=3, count=1)
    assert "Third paragraph" in windowed.text and windowed.coverage["truncated"] is False

    with pytest.raises(DocumentError, match="LOCATOR_STALE"):
        read_text_document(note, locator="paragraph=9")
    with pytest.raises(DocumentError, match="UNSUPPORTED_FORMAT"):
        read_text_document(tmp_path / "notes.pdf")


def test_unvalidatedCitation_is_refused_before_any_report_is_written(tmp_path: Path) -> None:
    """F16: a citation naming a missing file or a malformed hash never reaches a report."""
    root = tmp_path / "workspace"
    (root / "papers").mkdir(parents=True)
    (root / "papers" / "present.pdf").write_bytes(b"synthetic")
    digest = __import__("hashlib").sha256(b"synthetic").hexdigest()
    with pytest.raises(DocumentError, match="SOURCE_HASH_INVALID"):
        validate_sources([{"label": "Broken", "reference": "papers/missing.pdf", "sha256": "not-a-hash"}], root=root)
    with pytest.raises(DocumentError, match="SOURCE_NOT_FOUND"):
        validate_sources([{"label": "Missing", "reference": "papers/missing.pdf", "sha256": digest}], root=root)
    with pytest.raises(DocumentError, match="SOURCE_HASH_MISMATCH"):
        validate_sources([{"label": "Stale", "reference": "papers/present.pdf", "sha256": "0" * 64}], root=root)
    with pytest.raises(DocumentError, match="SOURCE_OUTSIDE_WORKSPACE"):
        validate_sources([{"label": "Escape", "reference": "../papers/present.pdf", "sha256": digest}], root=root)
    validated = validate_sources([{"label": "Present", "reference": "papers/present.pdf", "sha256": digest}], root=root)
    assert validated[0]["verifiedPath"] == "papers/present.pdf"
    external = validate_sources([{"label": "Remote", "reference": "https://doi.org/10.1234/x", "sha256": digest}], root=root)
    assert "verifiedPath" not in external[0], "an external reference is not checked as a workspace file"


def test_report_model_renders_the_same_structure_in_markdown_and_docx(tmp_path: Path) -> None:
    body = "# Finding\n\nEvidence one with **detail**.\n\n- First point\n- Second point\n\n1. Step one\n2. Step two\n\n| Year | Record |\n| --- | --- |\n| 1349 | Guild entry |\n"
    model = report_model("Review", body, [])
    kinds = [block.kind for block in model["blocks"]]
    assert kinds == ["heading", "paragraph", "bullets", "numbered", "table"]
    rendered = render_markdown(model)
    assert "| 1349 | Guild entry |" in rendered and "- First point" in rendered and "1. Step one" in rendered

    report = tmp_path / "outputs" / "structured.docx"
    write_docx_report(report, "Review", body, [])
    document = Document(report)
    styles = [paragraph.style.name for paragraph in document.paragraphs]
    assert "List Bullet" in styles and "List Number" in styles
    assert any(name.startswith("Heading") for name in styles), "headings are rendered as headings, not body text"
    assert document.tables and document.tables[0].rows[1].cells[1].text == "Guild entry"
