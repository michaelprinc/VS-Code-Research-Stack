"""Dependency-free CPU embedding backend for the workspace record store.

What this is (HR-01, HR-04, DD15-02)
-----------------------------------
A **lexical-signature** embedding: each stored chunk of text is turned into a fixed-length,
L2-normalised vector by *signed feature hashing* (the hashing trick used by classical hashing
vectorisers). No model is downloaded, no network is contacted, no third-party package is used,
and no GPU is involved — the module imports the Python standard library only, and the same text
always produces the same vector on any machine this toolkit runs on.

Two feature families are hashed into ``EMBEDDING_DIMENSIONS`` buckets:

* **word tokens** — the same Unicode word pattern the lexical ranker uses (``TOKENIZER_ID``),
  weighted ``1 + ln(count)`` so a term repeated ten times is not ten times as strong;
* **character n-grams** of sizes 3 and 4 over the casefolded text — this is what lets
  ``sandals`` and ``sandal``, or ``iluminace`` and ``iluminacích``, land in overlapping buckets.
  It is the reason the vector ranker can reach a chunk the BM25 ranker cannot, because BM25 only
  scores an exact shared token. A window only counts when it contains a letter or a digit, so
  punctuation alone carries no signature.

For each feature the backend takes ``sha256(f"{kind}\\0{feature}")``: the first four bytes pick
the bucket, one further byte picks the sign. Signed hashing keeps unrelated features from
pushing every coordinate in the same direction, which is what makes the cosine between two
unrelated texts come out near zero instead of near one. Coordinates are accumulated in sorted
feature order (so the summation order is fixed, not insertion-dependent), then the vector is
L2-normalised, quantised to signed 16-bit fixed point at 1/32767, and stored base64-encoded.

What this is **not** — stated plainly, not marketed
--------------------------------------------------
* It is **not a semantic model**. It knows which surface forms appear in a chunk. It does not
  know what a chunk is about, cannot resolve a synonym that shares no letters
  ("pilgrimage" vs "journey"), cannot handle negation ("no sandals" scores like "sandals"), and
  has no idea what theology, a manuscript, or a citation is.
* It is **not cross-lingual**. Character n-grams help within a language; they do not translate.
* It is **not a ranking guarantee**. A high cosine here means "these two texts share many surface
  forms weighted by this recipe". The Toolkit reports it as retrieval provenance, never as
  evidence that a passage supports a claim (that stays the researcher's recorded assessment).
* It is **not comparable to another backend's vectors**. A vector is only meaningful together
  with ``BACKEND_ID`` and ``EMBEDDING_DIMENSIONS``; the store keeps both on every row and the
  search layer refuses a row whose backend, dimensions or source text hash do not match what it
  would compute today (HR-04). Changing this recipe means changing ``BACKEND_ID``, which forces a
  re-index instead of a silent mismatch.

Because the vectors are lexical signatures, the practical use in this toolkit is recall: the
vector ranker brings back chunks that share word-stems and word shapes with the query but not the
exact query token, and the hybrid mode fuses that with BM25's exact-term precision.
"""

from __future__ import annotations

import base64
import hashlib
import math
import re
import struct
import unicodedata
from collections import Counter

#: Named, versioned backend identity (HR-04). A stored vector is traceable to this recipe;
#: changing the recipe below means changing this id, which makes the store re-index instead of
#: mixing incomparable vectors.
BACKEND_ID = "rsk-hashing-v1"
EMBEDDING_DIMENSIONS = 256
#: Same Unicode word pattern as ``full.TOKENIZER_ID`` so both rankers see the same words.
TOKENIZER_ID = "unicode-word-v1"
CHAR_NGRAM_SIZES = (3, 4)
TOKEN_WEIGHT = 1.0
NGRAM_WEIGHT = 0.5
QUANT_SCALE = 32767.0
VECTOR_ENCODING = "base64-int16-le"

_TOKEN_PATTERN = re.compile(r"[^\W_]+", flags=re.UNICODE)
_WORD_CHARACTER_PATTERN = re.compile(r"[^\W_]", flags=re.UNICODE)
_WHITESPACE_PATTERN = re.compile(r"\s+")


class VectorError(ValueError):
    """An actionable error from the embedding backend."""


def backend_status() -> dict[str, object]:
    """What this backend is, in the form the store and the verbs report."""
    return {
        "backendId": BACKEND_ID,
        "dimensions": EMBEDDING_DIMENSIONS,
        "tokenizerId": TOKENIZER_ID,
        "features": "tokens + character 3-grams + character 4-grams, signed feature hashing",
        "encoding": VECTOR_ENCODING,
        "modelDownloaded": False,
        "networkRequired": False,
        "nature": "lexical signature, not a trained semantic model",
    }


def normalise_text(text: str) -> str:
    """Casefold, NFC-normalise and collapse whitespace, so the same text hashes the same way."""
    if not isinstance(text, str):
        raise VectorError("VECTOR_INPUT: embed a text string.")
    collapsed = _WHITESPACE_PATTERN.sub(" ", unicodedata.normalize("NFC", text).casefold())
    return collapsed.strip()


def token_features(text: str) -> Counter:
    """Word-token counts, using the toolkit's Unicode word pattern."""
    return Counter(match.group(0) for match in _TOKEN_PATTERN.finditer(normalise_text(text)))


def ngram_features(text: str) -> Counter:
    """Character n-gram counts over the normalised text, at ``CHAR_NGRAM_SIZES``.

    A window only counts when it contains at least one letter or digit: punctuation and spacing
    alone carry no signature, so a chunk of dashes does not get a vector of its own.
    """
    normalised = normalise_text(text)
    counts: Counter = Counter()
    for size in CHAR_NGRAM_SIZES:
        if len(normalised) < size:
            continue
        for start in range(len(normalised) - size + 1):
            window = normalised[start:start + size]
            if not _WORD_CHARACTER_PATTERN.search(window):
                continue
            counts[window] += 1
    return counts


def _bucket_and_sign(feature: str, kind: str) -> tuple[int, float]:
    digest = hashlib.sha256(f"{kind}\0{feature}".encode("utf-8")).digest()
    bucket = int.from_bytes(digest[:4], "big") % EMBEDDING_DIMENSIONS
    sign = 1.0 if digest[4] & 1 else -1.0
    return bucket, sign


def embed_text(text: str) -> list[float]:
    """Embed one text into ``EMBEDDING_DIMENSIONS`` L2-normalised coordinates.

    Deterministic: the accumulation walks the features in sorted order, so the float summation
    order is fixed. A text with no word token and no character n-gram yields the all-zero vector;
    the store refuses to index a zero vector as if it were searchable, and cosine against it is 0.
    """
    tokens = token_features(text)
    ngrams = ngram_features(text)
    if not tokens and not ngrams:
        return [0.0] * EMBEDDING_DIMENSIONS
    coordinates = [0.0] * EMBEDDING_DIMENSIONS
    for feature, count in sorted(tokens.items()):
        bucket, sign = _bucket_and_sign(feature, "token")
        coordinates[bucket] += sign * TOKEN_WEIGHT * (1.0 + math.log(count))
    for feature, count in sorted(ngrams.items()):
        bucket, sign = _bucket_and_sign(feature, "ngram")
        coordinates[bucket] += sign * NGRAM_WEIGHT * (1.0 + math.log(count))
    norm = math.sqrt(sum(value * value for value in coordinates))
    if norm == 0.0:
        return [0.0] * EMBEDDING_DIMENSIONS
    return [value / norm for value in coordinates]


def is_zero_vector(vector: list[float]) -> bool:
    return all(value == 0.0 for value in vector)


def quantise_vector(vector: list[float]) -> list[int]:
    """Quantise normalised coordinates to signed 16-bit fixed point at 1/32767."""
    if len(vector) != EMBEDDING_DIMENSIONS:
        raise VectorError(f"VECTOR_DIMENSION: expected {EMBEDDING_DIMENSIONS} coordinates, got {len(vector)}.")
    quantised: list[int] = []
    for value in vector:
        scaled = int(round(value * QUANT_SCALE))
        quantised.append(max(-32767, min(32767, scaled)))
    return quantised


def encode_vector(vector: list[float]) -> str:
    """Compact deterministic storage form: base64 of little-endian signed 16-bit coordinates."""
    return base64.b64encode(struct.pack(f"<{EMBEDDING_DIMENSIONS}h", *quantise_vector(vector))).decode("ascii")


def decode_vector(encoded: str) -> list[float]:
    """Decode a stored vector back to coordinates (dequantised to the same 1/32767 grid)."""
    if not isinstance(encoded, str) or not encoded:
        raise VectorError("VECTOR_ENCODING: the stored vector is empty; it cannot be decoded.")
    try:
        packed = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise VectorError(f"VECTOR_ENCODING: the stored vector is not base64 ({exc}).") from exc
    expected = EMBEDDING_DIMENSIONS * 2
    if len(packed) != expected:
        raise VectorError(f"VECTOR_ENCODING: the stored vector is {len(packed)} bytes, expected {expected}.")
    return [value / QUANT_SCALE for value in struct.unpack(f"<{EMBEDDING_DIMENSIONS}h", packed)]


def cosine_similarity(left: list[float], right: list[float]) -> float:
    """Cosine of two vectors: 1.0 identical signature, 0.0 nothing shared, -1.0 opposite.

    Stored vectors are L2-normalised before quantisation, so for stored rows this is the dot
    product; the norms are still computed here so a hand-made vector cannot fake a score.
    """
    if len(left) != len(right):
        raise VectorError(f"VECTOR_DIMENSION: cannot compare {len(left)} coordinates with {len(right)}.")
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_norm = math.sqrt(sum(value * value for value in left))
    right_norm = math.sqrt(sum(value * value for value in right))
    if left_norm == 0.0 or right_norm == 0.0:
        return 0.0
    return dot / (left_norm * right_norm)
