"""Corpus inventory, chunk identity and lexical retrieval for the workspace record store.

The module owns three things and only three: which selected files are valid sources, what identity
a chunk of one of those sources carries, and how stored chunks are ranked. It does not persist an
index, create embeddings, access the network, or claim evidence truth.

Since 0.3.9 it knows two kinds of source. UTF-8 Markdown/text is read directly. A PDF or DOCX is
read through ``documents.extract_source`` — the same extraction the reader exposes to an assistant,
so indexing does not ask the user to prepare text first. A chunk never crosses a unit boundary, so a
PDF chunk's page number and a DOCX chunk's item index are true for the whole chunk.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath

MAX_SOURCES = 1000
MAX_SOURCE_BYTES = 5 * 1024 * 1024
MAX_BINARY_SOURCE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_BYTES = 50 * 1024 * 1024
MAX_CHUNK_CHARS = 4000
TEXT_SUFFIXES = {".md", ".markdown", ".txt"}
BINARY_SUFFIXES = {".pdf", ".docx"}
CHUNKER_ID = "paragraph-window-v1"
PDF_CHUNKER_ID = "pdf-page-window-v1"
DOCX_CHUNKER_ID = "docx-item-window-v1"
TOKENIZER_ID = "unicode-word-v1"
_TOKEN_PATTERN = re.compile(r"[^\W_]+", flags=re.UNICODE)


class FullPrototypeError(ValueError):
    """An actionable error from the bounded corpus layer."""


@dataclass(frozen=True)
class SourceUnit:
    """One extractable unit of a binary source, in source order, carrying its own text."""

    index: int
    kind: str
    text: str


@dataclass(frozen=True)
class EvidenceChunk:
    chunk_id: str
    content_id: str
    source_version_id: str
    source_path: str
    locator: str
    text: str
    text_sha256: str
    chunker_id: str
    unit_kind: str = "paragraph"
    unit_index: int = 0
    char_start: int = -1
    char_end: int = -1

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass(frozen=True)
class SourceRecord:
    """One validated selected source, independent of how many chunks it produced.

    The defaulted fields are the 0.3.9 provenance fields. A text source keeps the values it always
    had, so the same Markdown bytes produce the same chunk ids as they did in 0.3.8.
    """

    source_path: str
    source_version_id: str
    bytes: int
    text: str
    kind: str = "text"
    unit: str = "paragraph"
    parser: dict[str, str] = field(default_factory=dict)
    coverage: dict[str, object] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()
    outcome: str = "complete"
    units: tuple[SourceUnit, ...] = ()

    def as_dict(self) -> dict[str, object]:
        return {"source_path": self.source_path, "source_version_id": self.source_version_id, "bytes": self.bytes}


@dataclass(frozen=True)
class SearchHit:
    score: float
    chunk: EvidenceChunk
    retrieval_method: str = "bm25"

    def as_dict(self) -> dict[str, object]:
        return {"score": self.score, "retrievalMethod": self.retrieval_method, **self.chunk.as_dict()}


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical_id(parts: tuple[str, ...]) -> str:
    packed = json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return _sha256(packed)


def _split_text(text: str, chunk_chars: int, overlap_chars: int) -> list[tuple[int, str, int, int]]:
    """Return paragraph/window text and 0-based source character spans."""
    result: list[tuple[int, str, int, int]] = []
    paragraphs = re.finditer(r"\S.*?(?=(?:\r?\n[ \t]*\r?\n)|\Z)", text, flags=re.DOTALL)
    for paragraph_number, match in enumerate(paragraphs, start=1):
        raw = match.group(0)
        left_trim = len(raw) - len(raw.lstrip())
        right_trimmed = raw.rstrip()
        if not right_trimmed:
            continue
        start = match.start() + left_trim
        end = match.start() + len(right_trimmed)
        paragraph = text[start:end]
        if len(paragraph) <= chunk_chars:
            result.append((paragraph_number, paragraph, start, end))
            continue
        cursor = 0
        while cursor < len(paragraph):
            window_end = min(len(paragraph), cursor + chunk_chars)
            result.append((paragraph_number, paragraph[cursor:window_end], start + cursor, start + window_end))
            if window_end == len(paragraph):
                break
            cursor = window_end - overlap_chars
    return result


def _binary_source_record(normalized: str, source_path: Path) -> SourceRecord:
    """Read one PDF or DOCX through the shared extraction and carry its provenance forward.

    The hash recorded here is the hash of the source bytes, taken before the document was parsed,
    and `documents.extract_source` re-checks it after the last batch: a source that changed while it
    was being read never becomes a record.
    """
    from .documents import DocumentError, extract_source

    try:
        extracted = extract_source(source_path)
    except DocumentError as exc:
        # The reader's own code travels unchanged: PDF_ENCRYPTED stays PDF_ENCRYPTED.
        raise FullPrototypeError(str(exc)) from exc
    units = tuple(SourceUnit(unit.index, unit.kind, unit.text) for unit in extracted.units)
    return SourceRecord(
        source_path=normalized,
        source_version_id=extracted.sha256,
        bytes=source_path.stat().st_size,
        text="\n\n".join(unit.text for unit in units),
        kind=extracted.kind,
        unit=str(extracted.coverage.get("unit", "page")),
        parser=dict(extracted.parser),
        coverage=dict(extracted.coverage),
        warnings=tuple(extracted.warnings),
        outcome=extracted.outcome,
        units=units,
    )


def scan_sources(root: Path, relative_paths: list[str]) -> list[SourceRecord]:
    """Validate and hash every selected source — Markdown/text or PDF/DOCX — including one that yields no chunks.

    Paths must resolve under ``root``. Source files are read but never changed. Returned
    source references are normalized relative POSIX paths. This inventory is what lets an
    emptied source lose its previous index membership instead of leaving stale evidence.
    """
    if not relative_paths or len(relative_paths) > MAX_SOURCES:
        raise FullPrototypeError(f"SOURCE_COUNT: provide 1..{MAX_SOURCES} explicit files.")

    root_path = root.expanduser().resolve()
    if not root_path.is_dir():
        raise FullPrototypeError("ROOT_NOT_FOUND: selected corpus root is not a directory.")

    records: list[SourceRecord] = []
    seen: set[str] = set()
    total_bytes = 0
    for relative_path in relative_paths:
        if not isinstance(relative_path, str) or not relative_path.strip():
            raise FullPrototypeError("INVALID_SOURCE: paths must be non-empty relative strings.")
        candidate_rel = PurePosixPath(relative_path.replace("\\", "/"))
        windows_path = PureWindowsPath(relative_path)
        if candidate_rel.is_absolute() or windows_path.drive or windows_path.root or ".." in candidate_rel.parts:
            raise FullPrototypeError("SOURCE_OUTSIDE_ROOT: select files inside the corpus root.")
        normalized = candidate_rel.as_posix()
        if normalized in seen:
            continue
        seen.add(normalized)
        source_path = (root_path / Path(*candidate_rel.parts)).resolve()
        try:
            source_path.relative_to(root_path)
        except ValueError as exc:
            raise FullPrototypeError("SOURCE_OUTSIDE_ROOT: selected path resolves outside the corpus root.") from exc
        suffix = source_path.suffix.lower()
        if suffix not in TEXT_SUFFIXES | BINARY_SUFFIXES:
            raise FullPrototypeError("UNSUPPORTED_FORMAT: index_corpus accepts UTF-8 Markdown, text, PDF or DOCX only.")
        if not source_path.is_file():
            raise FullPrototypeError("SOURCE_NOT_FOUND: selected file is missing or is not a file.")
        size = source_path.stat().st_size
        per_file_limit = MAX_SOURCE_BYTES if suffix in TEXT_SUFFIXES else MAX_BINARY_SOURCE_BYTES
        remaining_total = MAX_TOTAL_BYTES - total_bytes
        if size > per_file_limit:
            if suffix in TEXT_SUFFIXES:
                raise FullPrototypeError(f"SOURCE_TOO_LARGE: per-file limit is {MAX_SOURCE_BYTES} bytes.")
            raise FullPrototypeError(f"SOURCE_TOO_LARGE: per-file limit for a {suffix} source is {MAX_BINARY_SOURCE_BYTES} bytes.")
        if remaining_total < 1:
            raise FullPrototypeError(f"CORPUS_TOO_LARGE: total limit is {MAX_TOTAL_BYTES} bytes.")
        if size > remaining_total:
            raise FullPrototypeError(f"CORPUS_TOO_LARGE: total limit is {MAX_TOTAL_BYTES} bytes.")
        total_bytes += size
        if suffix in BINARY_SUFFIXES:
            records.append(_binary_source_record(normalized, source_path))
            continue
        with source_path.open("rb") as stream:
            raw = stream.read(min(MAX_SOURCE_BYTES, remaining_total) + 1)
        if len(raw) > MAX_SOURCE_BYTES:
            raise FullPrototypeError(f"SOURCE_TOO_LARGE: per-file limit is {MAX_SOURCE_BYTES} bytes.")
        if len(raw) > remaining_total:
            raise FullPrototypeError(f"CORPUS_TOO_LARGE: total limit is {MAX_TOTAL_BYTES} bytes.")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise FullPrototypeError("INVALID_UTF8: source was not modified; convert or exclude it explicitly.") from exc
        records.append(SourceRecord(source_path=normalized, source_version_id=_sha256(raw), bytes=len(raw), text=text))
    return records


def _chunker_for(record: SourceRecord) -> str:
    if record.kind == "pdf":
        return PDF_CHUNKER_ID
    if record.kind == "docx":
        return DOCX_CHUNKER_ID
    return CHUNKER_ID


def chunks_for_source(record: SourceRecord, *, chunk_chars: int = 1200, overlap_chars: int = 120) -> list[EvidenceChunk]:
    """Chunk one validated source. Chunk identity is per source occurrence, content identity is separate.

    A text source is chunked exactly as in 0.3.8 — same chunker id, same locators, same ids. A PDF
    or DOCX is chunked **within** each unit: a chunk never spans a page or a table row, so the page
    number or item index in its locator is true for every character of the chunk.
    """
    if not 100 <= chunk_chars <= MAX_CHUNK_CHARS or not 0 <= overlap_chars < chunk_chars:
        raise FullPrototypeError("CHUNK_SETTINGS: chunk_chars must be 100..4000 and overlap smaller than the chunk.")
    chunker_fingerprint = f"{_chunker_for(record)}:{chunk_chars}:{overlap_chars}"
    if record.units:
        windows: list[tuple[SourceUnit, str, int, int]] = []
        for unit in record.units:
            if not unit.text.strip():
                continue
            for _inner, chunk_text, char_start, char_end in _split_text(unit.text, chunk_chars, overlap_chars):
                windows.append((unit, chunk_text, char_start, char_end))
    else:
        windows = []
        for paragraph_index, chunk_text, char_start, char_end in _split_text(record.text, chunk_chars, overlap_chars):
            windows.append((SourceUnit(paragraph_index, "paragraph", record.text), chunk_text, char_start, char_end))

    chunks: list[EvidenceChunk] = []
    for unit, chunk_text, char_start, char_end in windows:
        text_hash = _sha256(chunk_text.encode("utf-8"))
        if record.kind == "pdf":
            locator = f"page={unit.index};chars={char_start}-{char_end}"
        elif record.kind == "docx":
            locator = f"item={unit.index};kind={unit.kind};chars={char_start}-{char_end}"
        else:
            locator = f"paragraph={unit.index};chars={char_start}-{char_end}"
        content_id = _canonical_id((record.source_version_id, chunker_fingerprint, locator, text_hash))
        # The path is part of the occurrence identity so identical content at two paths stays two
        # traceable occurrences; `content_id` keeps the content-only identity for deduplication.
        chunk_id = _canonical_id((record.source_path, record.source_version_id, chunker_fingerprint, locator, text_hash))
        chunks.append(
            EvidenceChunk(
                chunk_id=chunk_id,
                content_id=content_id,
                source_version_id=record.source_version_id,
                source_path=record.source_path,
                locator=locator,
                text=chunk_text,
                text_sha256=text_hash,
                chunker_id=chunker_fingerprint,
                unit_kind=unit.kind,
                unit_index=unit.index,
                char_start=char_start,
                char_end=char_end,
            )
        )
    return chunks


def build_corpus(
    root: Path,
    relative_paths: list[str],
    *,
    chunk_chars: int = 1200,
    overlap_chars: int = 120,
) -> list[EvidenceChunk]:
    """Build an in-memory Markdown/text corpus from explicitly selected files.

    Source files are read but never changed. Returned source references are normalized
    relative POSIX paths.
    """
    return [
        chunk
        for record in scan_sources(root, relative_paths)
        for chunk in chunks_for_source(record, chunk_chars=chunk_chars, overlap_chars=overlap_chars)
    ]


def _tokens(text: str) -> list[str]:
    return [match.group(0).casefold() for match in _TOKEN_PATTERN.finditer(text)]


def search_bm25(chunks: list[EvidenceChunk], query: str, *, limit: int = 10) -> list[SearchHit]:
    """Return deterministic lexical hits; a score is relevance ranking only."""
    if not 1 <= limit <= 50:
        raise FullPrototypeError("RESULT_LIMIT: limit must be 1..50.")
    query_terms = _tokens(query)
    if not query_terms or not chunks:
        return []

    document_terms = [_tokens(chunk.text) for chunk in chunks]
    count = len(document_terms)
    average_length = sum(map(len, document_terms)) / count if count else 0.0
    document_frequency: dict[str, int] = {}
    for terms in document_terms:
        for term in set(terms):
            document_frequency[term] = document_frequency.get(term, 0) + 1

    k1, b = 1.5, 0.75
    hits: list[SearchHit] = []
    for chunk, terms in zip(chunks, document_terms, strict=True):
        frequencies: dict[str, int] = {}
        for term in terms:
            frequencies[term] = frequencies.get(term, 0) + 1
        length = len(terms)
        score = 0.0
        for term in query_terms:
            frequency = frequencies.get(term, 0)
            if not frequency:
                continue
            df = document_frequency[term]
            inverse_frequency = math.log(1.0 + (count - df + 0.5) / (df + 0.5))
            norm = frequency + k1 * (1.0 - b + b * length / max(average_length, 1.0))
            score += inverse_frequency * frequency * (k1 + 1.0) / norm
        if score > 0:
            hits.append(SearchHit(score=score, chunk=chunk))
    hits.sort(key=lambda hit: (-hit.score, hit.chunk.source_path, hit.chunk.locator, hit.chunk.chunk_id))
    return hits[:limit]
