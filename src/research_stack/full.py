"""Small deterministic Phase 3 corpus and lexical-retrieval prototype.

This module is intentionally local and dependency-free. It does not persist an
index, create embeddings, access the network, or claim evidence truth.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
from dataclasses import asdict, dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath

MAX_SOURCES = 1000
MAX_SOURCE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_BYTES = 50 * 1024 * 1024
MAX_CHUNK_CHARS = 4000
CHUNKER_ID = "paragraph-window-v1"
TOKENIZER_ID = "unicode-word-v1"
_TOKEN_PATTERN = re.compile(r"[^\W_]+", flags=re.UNICODE)


class FullPrototypeError(ValueError):
    """An actionable error from the bounded Phase 3 prototype."""


@dataclass(frozen=True)
class EvidenceChunk:
    chunk_id: str
    source_version_id: str
    source_path: str
    locator: str
    text: str
    text_sha256: str
    chunker_id: str

    def as_dict(self) -> dict[str, str]:
        return asdict(self)


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


def build_corpus(
    root: Path,
    relative_paths: list[str],
    *,
    chunk_chars: int = 1200,
    overlap_chars: int = 120,
) -> list[EvidenceChunk]:
    """Build an in-memory Markdown/text corpus from explicitly selected files.

    Paths must resolve under ``root``. Source files are read but never changed.
    Returned source references are normalized relative POSIX paths.
    """
    if not relative_paths or len(relative_paths) > MAX_SOURCES:
        raise FullPrototypeError(f"SOURCE_COUNT: provide 1..{MAX_SOURCES} explicit files.")
    if not 100 <= chunk_chars <= MAX_CHUNK_CHARS or not 0 <= overlap_chars < chunk_chars:
        raise FullPrototypeError("CHUNK_SETTINGS: chunk_chars must be 100..4000 and overlap smaller than the chunk.")

    root_path = root.expanduser().resolve()
    if not root_path.is_dir():
        raise FullPrototypeError("ROOT_NOT_FOUND: selected corpus root is not a directory.")

    chunks: list[EvidenceChunk] = []
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
        if source_path.suffix.lower() not in {".md", ".markdown", ".txt"}:
            raise FullPrototypeError("UNSUPPORTED_FORMAT: prototype accepts UTF-8 Markdown and text only.")
        if not source_path.is_file():
            raise FullPrototypeError("SOURCE_NOT_FOUND: selected file is missing or is not a file.")
        remaining_total = MAX_TOTAL_BYTES - total_bytes
        if source_path.stat().st_size > MAX_SOURCE_BYTES:
            raise FullPrototypeError(f"SOURCE_TOO_LARGE: per-file limit is {MAX_SOURCE_BYTES} bytes.")
        if remaining_total < 1:
            raise FullPrototypeError(f"CORPUS_TOO_LARGE: total limit is {MAX_TOTAL_BYTES} bytes.")
        with source_path.open("rb") as stream:
            raw = stream.read(min(MAX_SOURCE_BYTES, remaining_total) + 1)
        if len(raw) > MAX_SOURCE_BYTES:
            raise FullPrototypeError(f"SOURCE_TOO_LARGE: per-file limit is {MAX_SOURCE_BYTES} bytes.")
        if len(raw) > remaining_total:
            raise FullPrototypeError(f"CORPUS_TOO_LARGE: total limit is {MAX_TOTAL_BYTES} bytes.")
        total_bytes += len(raw)
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise FullPrototypeError("INVALID_UTF8: source was not modified; convert or exclude it explicitly.") from exc
        source_id = _sha256(raw)
        for paragraph_index, chunk_text, char_start, char_end in _split_text(text, chunk_chars, overlap_chars):
            text_hash = _sha256(chunk_text.encode("utf-8"))
            locator = f"paragraph={paragraph_index};chars={char_start}-{char_end}"
            chunker_fingerprint = f"{CHUNKER_ID}:{chunk_chars}:{overlap_chars}"
            chunk_id = _canonical_id((source_id, chunker_fingerprint, locator, text_hash))
            chunks.append(
                EvidenceChunk(
                    chunk_id=chunk_id,
                    source_version_id=source_id,
                    source_path=normalized,
                    locator=locator,
                    text=chunk_text,
                    text_sha256=text_hash,
                    chunker_id=chunker_fingerprint,
                )
            )
    return chunks


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
