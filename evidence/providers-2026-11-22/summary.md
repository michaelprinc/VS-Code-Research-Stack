# Provider measurement 2026-11-22 (0.3.15)

Generated 2026-11-23T05:45:27+00:00 by `scripts/probe_providers.py`. Anonymous, paced (Crossref 1.3 s, OpenAlex 0.6 s, Semantic Scholar 2.0 s), no credential sent.

## What was asked

58 requests, in order, each one recorded in `receipt.json` under `requests`. Crossref rows come from `works?query=` (search) and `works/{doi}` (single DOI); OpenAlex rows come from `works?search=` and `works/<id or doi-url>`. A field counted on one route is not a claim about another.

## Field fill over the rows the provider returned

Read each cell as `filled (z = sent as a real zero, a = field absent from the response)`. A zero and an
absent field are different facts, and a refused request is in neither count — it is listed under refusals.

| Provider | Route | Rows | title | authors | year | date | dateField | publicationType | retracted | citationCount | referenceCount | doi | venue |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| crossref | search | 25 | 25 (z0, a0) | 25 (z10, a0) | 25 (z0, a0) | 25 (z0, a0) | 25 (z0, a0) | 25 (z0, a0) | 0 (z0, a25) | 25 (z19, a0) | 25 (z22, a0) | 25 (z0, a0) | 24 (z0, a1) |
| crossref | single doi | 7 | 7 (z0, a0) | 7 (z2, a0) | 7 (z0, a0) | 7 (z0, a0) | 7 (z0, a0) | 7 (z0, a0) | 3 (z0, a4) | 7 (z3, a0) | 7 (z3, a0) | 7 (z0, a0) | 7 (z0, a0) |
| openalex | search | 25 | 25 (z0, a0) | 25 (z3, a0) | 25 (z0, a0) | 25 (z0, a0) | 25 (z0, a0) | 25 (z0, a0) | 25 (z25, a0) | 25 (z17, a0) | 25 (z22, a0) | 18 (z0, a7) | 23 (z0, a2) |

## 429 is not an empty field

Refusals recorded: 1
- semanticscholar anonymous raw: HTTP 429 — no reason given

## Crossref date fields

`issued` is the publication date; `created` is the DOI registration date. Rows where both exist:

- 10.32725/cetv.2017.022: {"issued": "2017-03-30", "published-print": "2017-03-30", "created": "2021-10-11"}
- 10.1056/nejmoa1200303: {"issued": "2013-04-04", "published-print": "2013-04-04", "created": "2013-02-25"}
- 10.1038/nature00870: {"issued": "2002-06-20", "published-online": "2002-06-20", "published-print": "2002-07-04", "created": "2002-07-28"}
- 10.1016/s0140-6736(97)11096-0: {"issued": "1998-02-01", "published-print": "1998-02-01", "created": "2002-07-25"}

## Crossref retraction routes (`updated-by`)

- 10.1016/S0140-6736(97)11096-0 — singleDoiRoute: updated-by=True retracted=True; doiFilterRoute: updated-by=True retracted=True; bibliographicSearchRoute: updated-by=True retracted=True
- 10.1038/nature00870 — singleDoiRoute: updated-by=True retracted=True; doiFilterRoute: updated-by=True retracted=True; bibliographicSearchRoute: updated-by=True retracted=True
- 10.1056/nejmoa1200303 — singleDoiRoute: updated-by=True retracted=True; doiFilterRoute: updated-by=True retracted=True; bibliographicSearchRoute: updated-by=False retracted=None

## Untitled container rows

- journal-issue: 3/3 rows with a container title and no work title (titles filled: 0; provider reports 1522937)
- journal-volume: 3/3 rows with a container title and no work title (titles filled: 0; provider reports 13474)
- component: 0/3 rows with a container title and no work title (titles filled: 1; provider reports 9518591)
- standard: 0/3 rows with a container title and no work title (titles filled: 3; provider reports 419493)
- dataset: 0/3 rows with a container title and no work title (titles filled: 3; provider reports 3456559)

## Crossref type vocabulary (why one filter is not 'books')

- book: {"reported": 799286}
- monograph: {"reported": 823796}
- edited-book: {"reported": 655013}
- book-set: {"reported": 667}
- reference-book: {"reported": 198355}
- journal-article: {"reported": 125427631}
- union:book: {"returned": 0, "typeSeen": null}
- union:monograph: {"returned": 0, "typeSeen": null}
- union:edited-book: {"returned": 0, "typeSeen": null}
- union:book-chapter: {"returned": 1, "typeSeen": "book-chapter"}
- typesSeenForQuery: {"reference-entry": 1, "book-chapter": 10, "book": 1, "component": 1, "dissertation": 1, "book-part": 1, "other": 2, "dataset": 1, "reference-book": 1, "journal-article": 1}

## OpenAlex `select=`

- Adapter list under test: `id,doi,title,authorships,publication_year,publication_date,primary_location,abstract_inverted_index,open_access`
- Present in the default representation: {"type": true, "is_retracted": true, "cited_by_count": true, "is_paratext": true}
- Present with the adapter's `select=`: {"type": false, "is_retracted": false, "cited_by_count": false, "is_paratext": false}

## Coverage: the same work on six routes

- W3206688818 — Kanonické právo a spiritualita (10.32725/cetv.2017.022)
  - crossrefDoiRoute: found=True
  - openalexIdRoute: found=True
  - openalexDoiRoute: found=True
  - openalexDoiFilter: found=True, provider reports 1
  - openalexTitleSearch: found=True, provider reports 20
  - openalexFreeTextDoiQuery: found=False, provider reports 0
  - retest: OpenAlex's topical search returned the work for the query used here, so the field conclusion that OpenAlex cannot find this DOI is not reproduced on this machine and is recorded as not proven.

## Semantic Scholar

- withoutAcknowledgement: {"code": "PROVIDER_TERMS_NOT_ACKNOWLEDGED", "message": "Semantic Scholar is disabled until the current API license is reviewed and this process explicitly opts in.", "requestsSent": 0}
- withAcknowledgement: {"code": "PROVIDER_RATE_LIMITED", "message": "Provider rate limit reached; the Toolkit's own bounded backoff applies, with any wait the provider named carried through.", "retryAfter": null}
- rawAnonymous: {"status": 429, "reason": "no reason given", "bodyExcerpt": "{\"message\": \"Too Many Requests. Please wait and try again or apply for a key for higher rate limits. https://www.semanticscholar.org/product/api#api-key-form\", \"code\": \"429\"}"}

## Not proven in this run

- The field conclusion that OpenAlex search cannot find 10.32725/cetv.2017.022 did not reproduce on this machine: OpenAlex's topical search returned the work. What this run proves is which routes return it, not that the earlier observation was wrong — its query string was not recorded in the field receipt.
- Semantic Scholar field fill could not be measured: every anonymous request was refused with HTTP 429 in this container, and an anonymous 429 is the provider's global pool, not this Toolkit's allowance.

## Refusals seen (full list)

```json
[
  {
    "label": "semanticscholar anonymous raw",
    "host": "api.semanticscholar.org",
    "status": 429,
    "reason": "no reason given",
    "bodyExcerpt": "{\"message\": \"Too Many Requests. Please wait and try again or apply for a key for higher rate limits. https://www.semanticscholar.org/product/api#api-key-form\", \"code\": \"429\"}"
  }
]
```
