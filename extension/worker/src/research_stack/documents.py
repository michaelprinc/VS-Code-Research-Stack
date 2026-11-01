"""Bounded document extraction, validated report writing and a shared report model.

Three guarantees hold across the module:

* source files are read only, and every result carries the source hash plus locators that
  identify where the text came from;
* a report is only written when each citation is well formed and, when it names a workspace
  file, that file exists with the cited hash;
* Markdown and DOCX render the **same** report model, so structure survives the export.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from docx import Document
from docx.oxml.ns import qn
from docx.table import Table
from docx.text.paragraph import Paragraph
from pypdf import PdfReader

MAX_INPUT_BYTES = 50 * 1024 * 1024
MAX_PDF_PAGES = 500
MAX_RESULT_CHARS = 1_000_000
MAX_TEXT_ITEMS = 200
TEXT_SUFFIXES = {".md", ".markdown", ".txt"}
DOCUMENT_SUFFIXES = {".pdf", ".docx"}
CITABLE_SUFFIXES = DOCUMENT_SUFFIXES | TEXT_SUFFIXES
_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")


class DocumentError(ValueError):
    """A bounded, user-actionable document processing error."""


@dataclass
class ExtractedDocument:
    path: str
    kind: str
    sha256: str
    text: str
    locators: list[dict[str, Any]]
    warnings: list[str]
    coverage: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ReportBlock:
    """One structural block of a report: heading, paragraph, bullet list, numbered list or table."""

    kind: str
    text: str = ""
    level: int = 0
    items: list[str] = field(default_factory=list)
    rows: list[list[str]] = field(default_factory=list)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _check_input(path: Path, suffixes: set[str], formats_code: str) -> Path:
    if path.suffix.lower() not in suffixes:
        raise DocumentError(f"UNSUPPORTED_FORMAT: {formats_code}")
    if not path.is_file():
        raise DocumentError("SOURCE_NOT_FOUND: selected document does not exist or is not a file.")
    if path.stat().st_size > MAX_INPUT_BYTES:
        raise DocumentError(f"INPUT_TOO_LARGE: limit is {MAX_INPUT_BYTES // (1024 * 1024)} MiB.")
    return path


def _docx_body_blocks(document: Document) -> list[tuple[str, str]]:
    """Body blocks in document order, so a paragraph/table/paragraph document stays in order."""
    blocks: list[tuple[str, str]] = []
    table_index = 0
    for child in document.element.body.iterchildren():
        if child.tag == qn("w:p"):
            blocks.append(("paragraph", Paragraph(child, document).text))
        elif child.tag == qn("w:tbl"):
            table_index += 1
            table = Table(child, document)
            for row_index, row in enumerate(table.rows, start=1):
                blocks.append((f"table-{table_index}-row", " | ".join(cell.text for cell in row.cells)))
    return blocks


def extract_document(path: Path, *, start: int = 1, count: int = 50) -> ExtractedDocument:
    """Extract a page/paragraph range; locators are 1-based and stable within the source."""
    path = _check_input(path, {".pdf", ".docx"}, "use a text-bearing PDF or DOCX file.")
    if start < 1 or count < 1 or count > 100:
        raise DocumentError("INVALID_RANGE: start must be positive and count must be 1..100.")

    warnings: list[str] = []
    locators: list[dict[str, Any]] = []
    parts: list[str] = []
    if path.suffix.lower() == ".pdf":
        try:
            reader = PdfReader(str(path), strict=False)
            if reader.is_encrypted:
                raise DocumentError("PDF_ENCRYPTED: provide an unlocked copy; the source was not changed.")
            page_total = len(reader.pages)
            if page_total > MAX_PDF_PAGES:
                raise DocumentError(f"PAGE_LIMIT: PDF has {page_total} pages; limit is {MAX_PDF_PAGES}.")
            if page_total == 0:
                raise DocumentError("PDF_EMPTY: document contains no pages.")
            end = min(page_total, start + count - 1)
            if start > page_total:
                raise DocumentError(f"INVALID_RANGE: PDF has {page_total} pages.")
            for page_number in range(start, end + 1):
                text = reader.pages[page_number - 1].extract_text() or ""
                parts.append(text)
                locators.append({"page": page_number, "characters": len(text)})
            if not any(p.strip() for p in parts):
                warnings.append("NO_TEXT_EXTRACTED: this may be a scanned PDF; OCR is not included in Phase 1.")
            kind = "pdf"
            coverage = {"totalUnits": page_total, "unit": "page", "returnedFrom": start, "returnedTo": end, "truncated": end < page_total}
        except DocumentError:
            raise
        except Exception as exc:
            raise DocumentError(f"PDF_PARSE_FAILED: {type(exc).__name__}; source was not changed.") from exc
    else:
        try:
            elements = _docx_body_blocks(Document(str(path)))
            if not elements:
                raise DocumentError("DOCX_EMPTY: no paragraphs or table rows were found.")
            end = min(len(elements), start + count - 1)
            if start > len(elements):
                raise DocumentError(f"INVALID_RANGE: DOCX has {len(elements)} extractable paragraphs/rows.")
            for index in range(start, end + 1):
                kind_name, text = elements[index - 1]
                parts.append(text)
                locators.append({"item": index, "kind": kind_name, "characters": len(text)})
            kind = "docx"
            coverage = {"totalUnits": len(elements), "unit": "paragraph or table row", "returnedFrom": start, "returnedTo": end, "truncated": end < len(elements)}
        except DocumentError:
            raise
        except Exception as exc:
            raise DocumentError(f"DOCX_PARSE_FAILED: {type(exc).__name__}; source was not changed.") from exc

    result = "\n\n".join(parts)
    if len(result) > MAX_RESULT_CHARS:
        raise DocumentError("RESULT_TOO_LARGE: reduce the requested range; extraction is never silently truncated.")
    return ExtractedDocument(str(path), kind, sha256_file(path), result, locators, warnings, coverage)


_PARAGRAPH_PATTERN = re.compile(r"\S.*?(?=(?:\r?\n[ \t]*\r?\n)|\Z)", flags=re.DOTALL)


def read_text_document(path: Path, *, start: int = 1, count: int = 20, locator: str | None = None, context: int = 1) -> ExtractedDocument:
    """Read a bounded range of a Markdown/text source using the same locators search returns.

    ``locator`` accepts a ``paragraph=N;chars=a-b`` value from a search hit and returns that
    paragraph plus ``context`` neighbours, so a hit can be reopened with its surroundings.
    """
    path = _check_input(path, TEXT_SUFFIXES, "read_text_source accepts UTF-8 Markdown and text files; use read_document for PDF or DOCX.")
    if count < 1 or count > MAX_TEXT_ITEMS:
        raise DocumentError(f"INVALID_RANGE: count must be 1..{MAX_TEXT_ITEMS} paragraphs.")
    if context < 0 or context > 5:
        raise DocumentError("CONTEXT_LIMIT: context must be 0..5 neighbouring paragraphs.")
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise DocumentError("INVALID_UTF8: source was not modified; convert or exclude it explicitly.") from exc

    paragraphs = [match.group(0).strip() for match in _PARAGRAPH_PATTERN.finditer(text)]
    paragraphs = [item for item in paragraphs if item]
    if not paragraphs:
        return ExtractedDocument(str(path), "text", sha256_file(path), "", [], ["EMPTY_SOURCE: this file produced no readable paragraphs."],
                                 {"totalUnits": 0, "unit": "paragraph", "returnedFrom": 0, "returnedTo": 0, "truncated": False})

    if locator:
        match = re.fullmatch(r"paragraph=(\d+)(?:;chars=(\d+)-(\d+))?", locator.strip())
        if not match:
            raise DocumentError("LOCATOR_INVALID: expected a locator such as paragraph=3;chars=120-980.")
        start = int(match.group(1))
        if start > len(paragraphs):
            raise DocumentError(f"LOCATOR_STALE: this source now has {len(paragraphs)} paragraphs; the locator points to paragraph {start}.")
        start = max(1, start - context)
        count = 1 + 2 * context

    end = min(len(paragraphs), start + count - 1)
    if start > len(paragraphs):
        raise DocumentError(f"INVALID_RANGE: the source has {len(paragraphs)} paragraphs.")
    parts: list[str] = []
    locators: list[dict[str, Any]] = []
    for index in range(start, end + 1):
        paragraph = paragraphs[index - 1]
        parts.append(paragraph)
        locators.append({"paragraph": index, "kind": "paragraph", "characters": len(paragraph), "locator": f"paragraph={index}"})
    result = "\n\n".join(parts)
    if len(result) > MAX_RESULT_CHARS:
        raise DocumentError("RESULT_TOO_LARGE: reduce the requested range; extraction is never silently truncated.")
    warnings = []
    if end < len(paragraphs):
        warnings.append(f"RANGE_TRUNCATED: {len(paragraphs) - end} later paragraphs were not returned; continue with start={end + 1}.")
    return ExtractedDocument(str(path), "text", sha256_file(path), result, locators, warnings,
                             {"totalUnits": len(paragraphs), "unit": "paragraph", "returnedFrom": start, "returnedTo": end, "truncated": end < len(paragraphs)})


def validate_sources(sources: list[dict[str, str]], *, root: Path | None = None) -> list[dict[str, Any]]:
    """Reject citations that cannot be checked: a malformed hash, or a workspace file that is absent or different."""
    if len(sources) > 100:
        raise DocumentError("TOO_MANY_SOURCES: maximum is 100 citations.")
    validated: list[dict[str, Any]] = []
    for item in sources:
        if not isinstance(item, dict) or not {"label", "reference", "sha256"}.issubset(item):
            raise DocumentError("INVALID_SOURCE: each source requires label, reference and sha256.")
        label = str(item["label"]).strip()
        reference = str(item["reference"]).strip()
        sha256 = str(item["sha256"]).strip().lower()
        if not label or not reference:
            raise DocumentError("INVALID_SOURCE: label and reference must be non-empty.")
        if not _SHA256_PATTERN.fullmatch(sha256):
            raise DocumentError(f"SOURCE_HASH_INVALID: the SHA-256 for {label!r} is not 64 hexadecimal characters. Cite the hash the toolkit reported for that source.")
        entry: dict[str, Any] = {"label": label, "reference": reference, "sha256": sha256}
        if item.get("locator"):
            entry["locator"] = str(item["locator"])
        external = re.match(r"^(https?://|doi:)", reference, flags=re.I)
        if root is not None and not external and Path(reference).suffix.lower() in CITABLE_SUFFIXES:
            candidate = (root / reference).resolve()
            try:
                candidate.relative_to(root.resolve())
            except ValueError as exc:
                raise DocumentError(f"SOURCE_OUTSIDE_WORKSPACE: {reference!r} resolves outside the workspace.") from exc
            if not candidate.is_file():
                raise DocumentError(f"SOURCE_NOT_FOUND: {reference!r} does not exist in this workspace; the citation was not written.")
            actual = sha256_file(candidate)
            if actual != sha256:
                raise DocumentError(f"SOURCE_HASH_MISMATCH: {reference!r} is {actual} now, not the cited {sha256}. Re-index the source before citing it.")
            entry["verifiedPath"] = reference
        validated.append(entry)
    return validated


def resolve_evidence(root: Path, chunk_ids: list[str]) -> list[dict[str, Any]]:
    """Resolve stored evidence chunk ids into validated citations, refusing unresolved ids."""
    from .records import StoreError, get_chunks

    if not chunk_ids:
        return []
    if len(chunk_ids) > 100:
        raise DocumentError("TOO_MANY_EVIDENCE: maximum is 100 evidence chunk ids per report.")
    try:
        resolved = get_chunks(root, chunk_ids)
    except StoreError as exc:
        raise DocumentError(f"EVIDENCE_UNAVAILABLE: {exc}") from exc
    found = {item["chunk_id"] for item in resolved}
    missing = sorted(set(chunk_ids) - found)
    if missing:
        raise DocumentError(f"EVIDENCE_UNRESOLVED: {', '.join(missing)} are not in the store. Index the source or drop the citation.")
    citations = []
    for item in resolved:
        citations.append({
            "label": f"{item['source_path']} · {item['locator']}",
            "reference": item["source_path"],
            "sha256": item["source_sha256"],
            "locator": item["locator"],
        })
    return citations


def report_model(title: str, body: str, sources: list[dict[str, Any]], evidence: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Parse a Markdown body into one structure that both writers render."""
    blocks: list[ReportBlock] = []
    lines = body.splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].rstrip()
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        heading = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if heading:
            blocks.append(ReportBlock(kind="heading", text=heading.group(2).strip(), level=len(heading.group(1))))
            index += 1
            continue
        if stripped.startswith("|") and stripped.endswith("|") and index + 1 < len(lines) and re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[index + 1]):
            header = [cell.strip() for cell in stripped.strip("|").split("|")]
            index += 2
            rows: list[list[str]] = []
            while index < len(lines) and lines[index].strip().startswith("|"):
                rows.append([cell.strip() for cell in lines[index].strip().strip("|").split("|")])
                index += 1
            blocks.append(ReportBlock(kind="table", text="", items=header, rows=rows))
            continue
        if re.match(r"^[-*]\s+", stripped):
            items: list[str] = []
            while index < len(lines) and re.match(r"^[-*]\s+", lines[index].strip()):
                items.append(re.sub(r"^[-*]\s+", "", lines[index].strip()))
                index += 1
            blocks.append(ReportBlock(kind="bullets", items=items))
            continue
        if re.match(r"^\d+[.)]\s+", stripped):
            ordered: list[str] = []
            while index < len(lines) and re.match(r"^\d+[.)]\s+", lines[index].strip()):
                ordered.append(re.sub(r"^\d+[.)]\s+", "", lines[index].strip()))
                index += 1
            blocks.append(ReportBlock(kind="numbered", items=ordered))
            continue
        paragraph: list[str] = [stripped]
        index += 1
        while index < len(lines):
            following = lines[index].strip()
            if not following or re.match(r"^(#{1,6}\s|[-*]\s|\d+[.)]\s|\|)", following):
                break
            paragraph.append(following)
            index += 1
        blocks.append(ReportBlock(kind="paragraph", text=" ".join(paragraph)))

    if evidence:
        blocks.append(ReportBlock(kind="heading", text="Evidence", level=2))
        blocks.append(ReportBlock(kind="bullets", items=[f"{item['label']} — `{item['sha256']}`" for item in evidence]))
    if sources:
        blocks.append(ReportBlock(kind="heading", text="Sources", level=2))
        blocks.append(ReportBlock(kind="bullets", items=[f"[{item['label']}]({item['reference']}) — `{item['sha256']}`" for item in sources]))
    return {"title": title.strip() or "Research report", "blocks": blocks}


def render_markdown(model: dict[str, Any]) -> str:
    lines = [f"# {model['title']}", ""]
    for block in model["blocks"]:
        if block.kind == "heading":
            lines.append(f"{'#' * max(2, min(6, block.level))} {block.text}")
            lines.append("")
        elif block.kind == "paragraph":
            lines.extend([block.text, ""])
        elif block.kind == "bullets":
            lines.extend([f"- {item}" for item in block.items] + [""])
        elif block.kind == "numbered":
            lines.extend([f"{number}. {item}" for number, item in enumerate(block.items, start=1)] + [""])
        elif block.kind == "table":
            lines.append("| " + " | ".join(block.items) + " |")
            lines.append("|" + "|".join([" --- "] * len(block.items)) + "|")
            lines.extend("| " + " | ".join(row) + " |" for row in block.rows)
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def _write_exclusive(destination: Path, content: bytes) -> dict[str, str]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with destination.open("xb") as stream:
            stream.write(content)
    except FileExistsError as exc:
        raise DocumentError("OUTPUT_EXISTS: choose a new output filename; existing files are not overwritten.") from exc
    return {"path": str(destination), "sha256": sha256_file(destination)}


def write_markdown_report(output_path: Path, title: str, body: str, sources: list[dict[str, Any]], *, evidence: list[dict[str, Any]] | None = None) -> dict[str, str]:
    """Create a new Markdown report from the shared report model. Existing files are never overwritten."""
    output_path = output_path.expanduser().resolve()
    model = report_model(title, body, sources, evidence)
    return _write_exclusive(output_path, render_markdown(model).encode("utf-8"))


def write_docx_report(output_path: Path, title: str, body: str, sources: list[dict[str, Any]], *, evidence: list[dict[str, Any]] | None = None) -> dict[str, str]:
    """Create a new DOCX report from the same report model: headings, lists and tables are rendered."""
    output_path = output_path.expanduser().resolve()
    if output_path.suffix.lower() != ".docx":
        raise DocumentError("OUTPUT_FORMAT: DOCX reports need a .docx extension.")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    model = report_model(title, body, sources, evidence)
    doc = Document()
    doc.add_heading(model["title"], level=1)
    for block in model["blocks"]:
        if block.kind == "heading":
            doc.add_heading(block.text, level=max(1, min(4, block.level)))
        elif block.kind == "paragraph":
            doc.add_paragraph(block.text)
        elif block.kind == "bullets":
            for item in block.items:
                doc.add_paragraph(item, style="List Bullet")
        elif block.kind == "numbered":
            for item in block.items:
                doc.add_paragraph(item, style="List Number")
        elif block.kind == "table":
            table = doc.add_table(rows=1 + len(block.rows), cols=max(1, len(block.items)))
            for column, header in enumerate(block.items):
                table.rows[0].cells[column].text = header
            for row_index, row in enumerate(block.rows, start=1):
                for column, value in enumerate(row[: len(block.items)]):
                    table.rows[row_index].cells[column].text = value
    with tempfile.NamedTemporaryFile(prefix=".research-stack-", suffix=".docx", dir=output_path.parent, delete=False) as temp:
        staging = Path(temp.name)
    try:
        doc.save(staging)
        try:
            with output_path.open("xb") as destination, staging.open("rb") as source:
                shutil.copyfileobj(source, destination)
        except FileExistsError as exc:
            raise DocumentError("OUTPUT_EXISTS: choose a new output filename; existing files are not overwritten.") from exc
    finally:
        staging.unlink(missing_ok=True)
    return {"path": str(output_path), "sha256": sha256_file(output_path)}
