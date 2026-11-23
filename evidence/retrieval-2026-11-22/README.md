# Retrieval measurement — 2026-11-22 (T16-03)

Reproducible measurement of the three stored retrieval modes on a **frozen synthetic corpus**.
Run by `scripts/measure_retrieval.py`; produced for release 0.3.15, where the store ceiling gained its
read-side gate (T16-04) and the P4 recommendation asked for a measured cost of the full scan.

## What is in this directory

| File | What it is |
| --- | --- |
| `corpus/cz/*.md`, `corpus/en/*.md` | 10 hand-authored synthetic Markdown files, ~7 kB total. Every file names itself as fixture text in its own heading. No private text, no operator text. |
| `corpus-manifest.json` | The sha256 and byte count of every corpus file, and the **chunk inventory the index produces from those bytes**: 40 chunks with chunk id, source path, locator, text hash and a 70-character excerpt. Written by `--freeze`; checked on every run. |
| `queries.json` | 29 frozen queries in four groups, each with the chunk labels judged relevant (`source path#locator`) and the one-sentence basis for that judgement. |
| `results.json` | Machine-readable output of the measurement: every query, every mode, every metric, every latency sample. |
| `results.md` | The tables a person reads. |

Reproduce with:

```sh
.venv/bin/python scripts/measure_retrieval.py --repetitions 5      # measure; rewrites results.json and results.md
.venv/bin/python scripts/measure_retrieval.py --freeze             # re-record the manifest (deliberate act)
```

`--freeze` is separate from the measurement on purpose. A run that measured and re-froze in one step
could never fail on drift, and "the corpus is frozen" is only worth anything as a check that can fail.

## The frozen inputs

- Corpus: 10 files, 6 994 bytes, **40 chunks**, all 40 with a decodable signature (measured by
  decoding, not by row metadata).
- Queries: **29** — czech 10, english 10, diacritic-free-or-typo 5, no-relevant-answer 4.
- Backend: `rsk-hashing-v1`, 256 dimensions, `base64-int16-le`. Fusion unchanged from 0.3.14:
  k = 60, weights 0.5 / 0.25 / 0.25, candidate pool ceiling 50. No cosine threshold exists.
- Relevance rule (from `queries.json`): a passage is relevant when it states the answer the query
  asks for, in the language of the query, **on its own**. A paragraph that only answers in the context
  of the file around it is not judged relevant, because chunk retrieval is what is measured.

## Headline numbers (this host, `--repetitions 5`, k = 10)

| Mode | Recall@10 (25 assessed) | nDCG@10 | Precision@10 | Median latency | p95 |
| --- | --- | --- | --- | --- | --- |
| `lexical` | 0.940 | 0.882 | 0.104 | 1.09 ms | 1.44 ms |
| `vector` | 0.940 | 0.842 | 0.104 | 2.68 ms | 3.58 ms |
| `hybrid` | 0.940 | 0.887 | 0.104 | 3.33 ms | 4.38 ms |

Per language group, and the no-answer group, are in `results.md`. Ranking order was **not** changed to
produce these numbers and the default mode stayed `lexical` throughout.

Full-scan cost at the store ceiling, on a synthetic 20 000-chunk store (one repeated sentence, so no
ranking claim is made from it): `lexical` 254 ms median, `vector` 1 561 ms median, `hybrid` 1 570 ms
median per call, 20 000 chunks scored each call. These are the numbers a bounded candidate pre-filter
(P4's proposal) would have to beat, measured rather than extrapolated.

## Findings, in the order they matter

1. **Diacritic-free Czech is where retrieval actually fails, and the vector ranker does not rescue it.**
   For `ty-01` ("sandaly iluminacich kodexu") the lexical ranker finds **one** chunk out of 40 — BM25
   needs an exact shared token — and the vector ranker ranks the two judged-relevant passages at
   **14 and 19** of 40, outside the top ten. Recall@10 for that query is 0 in all three modes.
   `vectors.py` documents the character n-grams as "the reason the vector ranker can reach a chunk the
   BM25 ranker cannot". That is true for word stems inside a language (measured elsewhere, in
   `tests/test_vector_retrieval.py`), and it is **not** demonstrated here for Czech written without
   diacritics at k = 10. Reported, not fixed: no ranking change was made in 0.3.15.
2. **Inflected forms cost recall on the second answer passage.** For `cz-01` the lexical ranker places
   paragraph 2 at rank 3 and cannot reach paragraph 3 at all (11 lexical candidates in a 40-chunk
   corpus); the vector ranker reaches it at 28 and hybrid leaves it at 29. Recall@10 = 0.5 for that
   query. Paragraph 3 says "sandálů", the query says "sandály".
3. **Hybrid never ranked below lexical on any group** (nDCG@10 hybrid 0.887 vs lexical 0.882 vs
   vector 0.842 overall; per group hybrid ≥ lexical). It also never beat lexical by enough to justify a
   default-mode change, and the default mode is unchanged.
4. **A query with no relevant answer always gets hits.** All four no-answer queries returned hits in
   every mode — 7.5 hits on average in `lexical`, 10 in `vector` and `hybrid`, with the highest score
   returned reaching 7.33 BM25 and 0.98 fused. That is the designed behaviour (no threshold, weak score
   visible), and the honest reading of it is that the *score*, not the presence of a hit, is what an
   operator must look at.
5. **Determinism held**: 29 queries × 3 modes × 5 repetitions produced identical chunk-id sequences in
   every repetition, and the run produced no refusals.

## What this does not prove

- **The operator's own corpus was not measured.** It is not available in this environment. Every
  passage here is synthetic fixture text authored for this directory, and every relevance judgement is
  made by construction. The numbers are a reproducible baseline for comparing modes and releases, not a
  statement about the toolkit's quality on real research text.
- No real-host latency claim: one process, one thread, one x86-64 Linux host, and latency moves by a
  few milliseconds between runs on a loaded machine. `results.json` records the repetitions and the
  sample counts, not a smoothed figure.
- The 20 000-chunk fixture measures scan **cost** only. It says nothing about ranking quality at that
  size, because all 20 000 of its chunks carry the same sentence.
- Recall@10 and nDCG@10 here rest on 29 queries. That is enough to compare three modes on one corpus
  and not enough to support a published quality claim or a threshold decision.
- No ranking change, no fusion-parameter change and no relevance threshold was introduced to obtain
  these numbers. Findings 1 and 2 are open quality defects, recorded here for the release that wants to
  act on them.
