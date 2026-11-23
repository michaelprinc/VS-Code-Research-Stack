# Fixture 08 — Retrieval methods measured in this toolkit (synthetic text)

Lexical search ranks with BM25: shared tokens are rewarded, long documents are penalised, and a term that appears
in many documents carries less weight. A query typed without diacritics, or with a typo, is a different token to
this ranker and may match nothing.

Vector search ranks a lexical signature: hashed word tokens together with character three-grams and four-grams.
It reaches word shapes the lexical ranker cannot see, but it does not know what a passage is about and it does not
translate between languages.

Hybrid search fuses the two rankings with a published rule: reciprocal-rank fusion carries half of the fused score
and each ranker's own normalised score carries a quarter. No relevance threshold is applied, so a weak match is
returned with its weak score visible.
