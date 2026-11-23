# Retrieval measurement 2026-11-22 (T16-03)

- Corpus: **10 synthetic fixture files**, 6994 bytes, 40 chunks. Synthetic fixture text authored for this measurement. It is not the operator's research corpus, and no private text is present in it. Relevance is judged by construction: the relevant passage is the passage written to answer the query.
- Backend: `rsk-hashing-v1`, 256 dimensions, `base64-int16-le` — lexical signature, not a trained semantic model. No model download, no network.
- Fusion: k = 60, weights {'reciprocalRankFusion': 0.5, 'lexicalScore': 0.25, 'vectorScore': 0.25}, candidate pool ceiling 50. Unchanged from 0.3.14.
- Queries: 29 assessed (czech 10, english 10, diacritic-free-or-typo 5, no-relevant-answer 4). Repetitions: 5. k = 10. Seed: 20261122.
- Vector coverage: 40 of 40 current chunks carry a signature that decodes at query time (100.00 %); 0 undecodable. Coverage is measured by decoding, not from row metadata.
- Deterministic across repetitions: **True**. Refusals during the run: 0.
- Host: 3.12.16 on x86_64, 16 logical CPUs, one process, one thread.

## Relevance per mode and language group

| Mode | Group | Queries | Recall@10 | nDCG@10 | Precision@10 | Queries with no relevant hit |
| --- | --- | --- | --- | --- | --- | --- |
| lexical | czech | 10 | 0.950 | 0.892 | 0.120 | 0 |
| lexical | english | 10 | 1.000 | 0.963 | 0.100 | 0 |
| lexical | diacritic-free-or-typo | 5 | 0.800 | 0.700 | 0.080 | 1 |
| lexical | **all assessed** | 25 | 0.940 | 0.882 | 0.104 | — |
| vector | czech | 10 | 0.950 | 0.867 | 0.120 | 0 |
| vector | english | 10 | 1.000 | 0.926 | 0.100 | 0 |
| vector | diacritic-free-or-typo | 5 | 0.800 | 0.626 | 0.080 | 1 |
| vector | **all assessed** | 25 | 0.940 | 0.842 | 0.104 | — |
| hybrid | czech | 10 | 0.950 | 0.892 | 0.120 | 0 |
| hybrid | english | 10 | 1.000 | 0.963 | 0.100 | 0 |
| hybrid | diacritic-free-or-typo | 5 | 0.800 | 0.726 | 0.080 | 1 |
| hybrid | **all assessed** | 25 | 0.940 | 0.887 | 0.104 | — |

The numbers above are means over the group. `Precision@10` is included because a mode that answers a
Czech query from an English passage is measurable there, and the vector ranker is not cross-lingual.

## Queries with no relevant answer

| Mode | Queries | Returning at least one hit | Share | Mean hits | Highest score returned |
| --- | --- | --- | --- | --- | --- |
| lexical | 4 | 4 | 100.0 % | 7.50 | 7.328 |
| vector | 4 | 4 | 100.0 % | 10.00 | 0.182 |
| hybrid | 4 | 4 | 100.0 % | 10.00 | 0.982 |

Nothing in the corpus answers these queries. A hit here is a false positive, and the modes return it
because no relevance threshold is applied — by design, so the weak score stays visible to the reader.

## Latency per mode

| Mode | Timed calls | Median | p95 | Max |
| --- | --- | --- | --- | --- |
| lexical | 145 | 1.09 ms | 1.44 ms | 1.55 ms |
| vector | 145 | 2.68 ms | 3.58 ms | 4.50 ms |
| hybrid | 145 | 3.33 ms | 4.38 ms | 5.57 ms |

## Cost of the full scan at the store ceiling

A synthetic store of exactly **20000** current chunks, 20000 of them with a decodable signature, probed with 3 queries. relevance quality: every chunk of this fixture has the same text, so no ranking claim is made from it.

| Mode | Chunks scored per call | Median | p95 |
| --- | --- | --- | --- |
| lexical | 20000 | 253.69 ms | 264.37 ms |
| vector | 20000 | 1560.64 ms | 1723.21 ms |
| hybrid | 20000 | 1570.20 ms | 1679.48 ms |

## Per query

| Query | Group | Relevant | lexical R@10 | vector R@10 | hybrid R@10 | hybrid nDCG@10 | hybrid found-by (L/V/both) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| cz-01 | czech | 2 | 0.500 | 0.500 | 0.500 | 0.307 | 0/0/10 |
| cz-02 | czech | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/8/2 |
| cz-03 | czech | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/8/2 |
| cz-04 | czech | 2 | 1.000 | 1.000 | 1.000 | 0.693 | 0/0/10 |
| cz-05 | czech | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/8/2 |
| cz-06 | czech | 2 | 1.000 | 1.000 | 1.000 | 0.920 | 0/7/3 |
| cz-07 | czech | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/8/2 |
| cz-08 | czech | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/5/5 |
| cz-09 | czech | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/4/6 |
| cz-10 | czech | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/9/1 |
| en-01 | english | 1 | 1.000 | 1.000 | 1.000 | 0.631 | 0/0/10 |
| en-02 | english | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/4/6 |
| en-03 | english | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0/10 |
| en-04 | english | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0/10 |
| en-05 | english | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0/10 |
| en-06 | english | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0/10 |
| en-07 | english | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0/10 |
| en-08 | english | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0/10 |
| en-09 | english | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0/10 |
| en-10 | english | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0/10 |
| ty-01 | diacritic-free-or-typo | 2 | 0.000 | 0.000 | 0.000 | 0.000 | 0/9/1 |
| ty-02 | diacritic-free-or-typo | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/8/2 |
| ty-03 | diacritic-free-or-typo | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/5/5 |
| ty-04 | diacritic-free-or-typo | 1 | 1.000 | 1.000 | 1.000 | 1.000 | 0/0/10 |
| ty-05 | diacritic-free-or-typo | 1 | 1.000 | 1.000 | 1.000 | 0.631 | 0/0/10 |
| na-01 | no-relevant-answer | 0 | 0.000 | 0.000 | 0.000 | 0.000 | 0/0/10 |
| na-02 | no-relevant-answer | 0 | 0.000 | 0.000 | 0.000 | 0.000 | 1/3/6 |
| na-03 | no-relevant-answer | 0 | 0.000 | 0.000 | 0.000 | 0.000 | 0/7/3 |
| na-04 | no-relevant-answer | 0 | 0.000 | 0.000 | 0.000 | 0.000 | 0/0/10 |

## What this does not show

- The operator's own corpus is **not** measured here: it is not available in this environment, and nothing
  in this directory quotes it. Every passage is synthetic fixture text.
- Relevance was judged by construction (the answer passage was authored for the query), which is enough to
  compare modes and releases and not enough to rank retrieval quality for a real researcher.
- `rsk-hashing-v1` is a lexical signature, not a semantic model: no synonym, no negation, no translation.
  Cross-language queries are expected to lose, and the Precision@10 column is where that shows.
- Latency is one process on one core of one host. It is a measured figure for this host, not a published
  performance claim.
- No ranking change was made to produce these numbers, and no cosine threshold exists.
