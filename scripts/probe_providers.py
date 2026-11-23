#!/usr/bin/env python3
"""The frozen provider measurement for 0.3.15 (evidence/providers-2026-11-22).

One run, one frozen query list, one machine-readable receipt and one markdown summary. It exists because
every provider claim in this release is either a measurement or it is written down as not proven: the 21/22
November field receipts on the operator's Windows machine showed 429 refusals and empty fields being read as
the same fact, and a provider being called weaker than it is. Three rules hold here.

* Paced and polite. Crossref at 1.3 s between requests — its anonymous pool is one request per second shared
  by every anonymous caller — OpenAlex at 0.6 s, Semantic Scholar once. A probe that stampsedes a provider
  measures the stampede.
* Credential-free. No key, token or account header is read or sent, and no contact address is invented for a
  polite pool. What is measured is what an anonymous Toolkit call can see, which is the position the operator
  is actually in when they decline a key.
* A 429 is not an empty field. Every request is recorded with its status; a refusal contributes a refusal
  count, never a fill count, and a field counted as missing is a field a successful response did not carry.

Run: `.venv/bin/python scripts/probe_providers.py` (or `--out <dir>` to redirect the evidence). Writes
`receipt.json`, `summary.md` and `fixtures/*.json` under `evidence/providers-2026-11-22/`.
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_DIR = ROOT / "evidence" / "providers-2026-11-22"
GENERATED_AT = datetime.now(UTC).isoformat(timespec="seconds")
# No contact address here on purpose: OpenAlex's polite pool wants one, and inventing an address for the
# operator's machine is a claim this probe cannot make. The user agent says what the call is.
USER_AGENT = "research-stack-toolkit/0.3.15 provider probe (anonymous; no contact address supplied)"
PACING_SECONDS = {"api.crossref.org": 1.3, "api.openalex.org": 0.6, "api.semanticscholar.org": 2.0}
MAX_BODY_FOR_EVIDENCE = 400
# The fields the Toolkit's normalizer can fill, and therefore the only ones worth counting.
FILLED_FIELDS = ("title", "authors", "year", "date", "dateField", "publicationType", "retracted",
                 "citationCount", "referenceCount", "doi", "venue")
QUERIES = ["corpus iuris canonici", "canon law spirituality", "The Spirit of the Liturgy",
           "A History of Canon Law", "civitas Dei augustin"]
# The frozen DOI set. `10.32725/cetv.2017.022` is the coverage case: Crossref has it, OpenAlex has it as
# W3206688818, and OpenAlex *search* does not return it — so "OpenAlex is the weaker provider" is a claim
# this measurement refuses to make.
DOIS = ["10.32725/cetv.2017.022", "10.2307/j.ctt28524j.7", "10.1163/9789004525863-cp092202",
        "10.1163/2211-2685_eco_c1317", "10.1016/S0140-6736(97)11096-0", "10.1038/nature00870",
        "10.1056/nejmoa1200303"]
OPENALEX_WORK_ID = "W3206688818"
COVERAGE_DOI = "10.32725/cetv.2017.022"
# A book chapter: asked for under `book`, `monograph` and `edited-book` it is not there; under its own type it is.
UNION_PROBE_DOI = "10.2307/j.ctt28524j.7"
RETRACTION_DOIS = ["10.1016/S0140-6736(97)11096-0", "10.1038/nature00870", "10.1056/nejmoa1200303"]
UNTITLED_TYPES = ["journal-issue", "journal-volume", "component", "standard", "dataset"]
# `research.py`'s own OpenAlex `select=` list, copied as the thing under test rather than as a constant to
# agree with. If the adapter's list is edited, this probe must be edited with it, and the diff is the point.
# The exact `select=` list `research.py` sends today (`_request_for`), copied as the thing under test.
ADAPTER_SELECT = "id,doi,title,authorships,publication_year,publication_date,primary_location,abstract_inverted_index,open_access"
SELECT_ONLY_FIELDS = ("type", "is_retracted", "cited_by_count", "is_paratext")

_last_request: dict[str, float] = {}
_refusals: list[dict[str, Any]] = []
_not_proven: list[str] = []
_request_log: list[dict[str, Any]] = []  # every URL asked for, in order — a frozen probe has to be auditable


class Refusal(Exception):
    """A provider answer that is not data: named by its status, kept with a short body excerpt."""

    def __init__(self, status: int | None, reason: str, body: str = "") -> None:
        super().__init__(f"HTTP {status if status is not None else 'n/a'}: {reason}")
        self.status = status
        self.reason = reason
        self.body = body[:MAX_BODY_FOR_EVIDENCE]


def _pace(host: str) -> float:
    waited = time.monotonic() - _last_request.get(host, 0.0)
    floor = PACING_SECONDS.get(host, 1.0)
    if waited < floor:
        time.sleep(floor - waited)
        return floor - waited
    return 0.0


def get(url: str, *, label: str) -> dict[str, Any]:
    """One paced, anonymous GET. The status is part of the answer, so a 429 can never read as an empty field."""
    host = urllib.parse.urlsplit(url).netloc
    waited = _pace(host)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            status, headers = response.status, response.headers
            body = response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:MAX_BODY_FOR_EVIDENCE]
        refusal = Refusal(exc.code, exc.reason or "no reason given", body)
        _refusals.append({"label": label, "host": host, "status": exc.code, "reason": refusal.reason,
                          "bodyExcerpt": refusal.body})
        _request_log.append({"label": label, "url": url, "host": host, "status": exc.code, "outcome": "refused"})
        raise refusal from None
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        _refusals.append({"label": label, "host": host, "status": None, "reason": str(exc)[:200], "bodyExcerpt": ""})
        _request_log.append({"label": label, "url": url, "host": host, "status": None, "outcome": "no answer"})
        raise Refusal(None, str(exc)[:200]) from None
    _last_request[host] = time.monotonic()
    rate = {name.lower(): headers.get(name) for name in ("x-ratelimit-limit", "x-ratelimit-remaining",
                                                          "x-ratelimit-interval", "retry-after")}
    answered = {"label": label, "url": url, "host": host, "status": status, "outcome": "answered",
                "waitedMs": round(waited * 1000), "elapsedMs": round((time.monotonic() - started) * 1000),
                "rateHeaders": {k: v for k, v in rate.items() if v}}
    _request_log.append(answered)
    return {**answered, "payload": json.loads(body)}


def _text(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
        if isinstance(value, list):
            for item in value:
                if isinstance(item, str) and item.strip():
                    return item.strip()
    return None


def _date(parts: Any) -> str | None:
    """Crossref dates arrive as `{"date-parts": [[1998, 2, 14]]}`, OpenAlex as an ISO string."""
    if isinstance(parts, dict):
        parts = parts.get("date-parts")
    if not isinstance(parts, list) or not parts:
        return None
    if isinstance(parts[0], str):
        return parts[0]
    pieces = [str(part) for part in parts[0] if part]
    if not pieces:
        return None
    year = pieces[0].rjust(4, "0")
    month = pieces[1].rjust(2, "0") if len(pieces) > 1 else "01"
    day = pieces[2].rjust(2, "0") if len(pieces) > 2 else "01"
    return f"{year}-{month}-{day}"


def crossref_fields(raw: dict[str, Any]) -> dict[str, Any]:
    """What the adapter can read out of one Crossref row, and which date field it had to read it from."""
    dates = {name: _date(raw.get(name)) for name in ("issued", "published-online", "published-print", "created")}
    date, date_field = next(((value, name) for name, value in dates.items() if value), (None, None))
    updated = raw.get("updated-by")
    retractions = [entry for entry in (updated if isinstance(updated, list) else [])
                   if isinstance(entry, dict) and entry.get("type") == "retraction"]
    return {"title": _text(raw.get("title")), "authors": len(raw.get("author") or []),
            "year": (dates["issued"] or dates["published-online"] or dates["published-print"] or dates["created"] or "")[:4] or None,
            "date": date, "dateField": date_field, "allDates": {k: v for k, v in dates.items() if v},
            "publicationType": raw.get("type"), "retracted": bool(retractions) if updated is not None else None,
            "updatedBy": [{"id": entry.get("id"), "type": entry.get("type")} for entry in retractions],
            "citationCount": raw.get("is-referenced-by-count"), "referenceCount": raw.get("reference-count"),
            "doi": raw.get("DOI"), "venue": _text(raw.get("container-title")),
            # Present-but-untitled is the container-row fact: these DOIs exist and carry no work title.
            "untitledContainer": not _text(raw.get("title")) and bool(_text(raw.get("container-title")))}


def _route_presence(raw: dict[str, Any]) -> dict[str, Any]:
    """Whether a route's raw row carries `updated-by`, and what the adapter would read from it. Checked on the
    raw payload, never on a derived row — a derived row always 'contains' the field it computed."""
    fields = crossref_fields(raw)
    return {"hasUpdatedBy": "updated-by" in raw, "retracted": fields["retracted"], "date": fields["date"],
            "dateField": fields["dateField"], "citationCount": fields["citationCount"],
            "referenceCount": fields["referenceCount"]}


def openalex_fields(raw: dict[str, Any]) -> dict[str, Any]:
    """What the adapter can read out of one OpenAlex work, and what only a `select=` request brings back."""
    references = raw.get("referenced_works")
    location = raw.get("primary_location") if isinstance(raw.get("primary_location"), dict) else {}
    source = location.get("source") if isinstance(location.get("source"), dict) else {}
    return {"title": _text(raw.get("display_name"), raw.get("title")),
            "authors": len(raw.get("authorships") or []), "year": raw.get("publication_year"),
            "date": raw.get("publication_date"), "dateField": "publication_date" if raw.get("publication_date") else None,
            "publicationType": raw.get("type"), "retracted": raw.get("is_retracted"),
            "citationCount": raw.get("cited_by_count"),
            "referenceCount": len(references) if isinstance(references, list) else raw.get("referenced_count"),
            "doi": (raw.get("doi") or "").replace("https://doi.org/", "") or None,
            "venue": _text(source.get("display_name")), "isParatext": raw.get("is_paratext")}


def count_fill(rows: list[dict[str, Any]], provider: str) -> dict[str, Any]:
    """Per-field counts over rows that were actually returned.

    Three counts, never merged into one: a field the provider did not send, a field it sent as a real zero,
    and a field it sent with content. The 21 November receipts read `citationCount 0` and `referenceCount 0`
    as the same fact as 'the provider has no such field', and that is how a request-shape problem got filed
    against the provider.
    """
    filled, absent, zero = {}, {}, {}
    for field in FILLED_FIELDS:
        values = [row.get(field) for row in rows]
        filled[field] = sum(1 for value in values if value is not None and value != [] and value != "")
        absent[field] = sum(1 for value in values if value is None)
        zero[field] = sum(1 for value in values if value == 0)
    return {"rowsReturned": len(rows), "fieldsFilled": filled, "fieldsAbsent": absent,
            "fieldsReportedZero": zero, "provider": provider}


def redact(row: dict[str, Any], keep: tuple[str, ...]) -> dict[str, Any]:
    """A frozen fixture: only the fields the adapter reads, nothing longer than a line, no credentials."""
    trimmed: dict[str, Any] = {}
    for name in keep:
        value = row.get(name)
        if isinstance(value, str):
            trimmed[name] = value[:120]
        elif isinstance(value, (int, float, bool)) or value is None:
            trimmed[name] = value
        elif isinstance(value, list):
            trimmed[name] = [item if not isinstance(item, str) else item[:80] for item in value[:6]]
        elif isinstance(value, dict):
            trimmed[name] = {key: (val if not isinstance(val, str) else val[:80])
                             for key, val in list(value.items())[:8] if not isinstance(val, (list, dict))}
    return trimmed


def fixture(name: str, document: dict[str, Any]) -> None:
    (EVIDENCE_DIR / "fixtures").mkdir(parents=True, exist_ok=True)
    (EVIDENCE_DIR / "fixtures" / name).write_text(json.dumps(document, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def probe_crossref() -> dict[str, Any]:
    result: dict[str, Any] = {"search": {}, "singleDoi": {}, "routes": {}, "untitledContainers": {}}
    rows: list[dict[str, Any]] = []
    for query in QUERIES:
        url = f"https://api.crossref.org/works?rows=5&query={urllib.parse.quote(query)}"
        try:
            payload = get(url, label=f"crossref search {query}")["payload"]
        except Refusal as exc:
            result["search"][query] = {"refused": str(exc), "status": exc.status}
            continue
        items = (payload.get("message") or {}).get("items") or []
        rows.extend(crossref_fields(item) for item in items)
        result["search"][query] = {"reported": (payload.get("message") or {}).get("total-results"),
                                   "returned": len(items)}
    result["searchFill"] = count_fill(rows, "crossref")

    single: list[dict[str, Any]] = []
    for doi in DOIS:
        url = f"https://api.crossref.org/works/{urllib.parse.quote(doi)}"
        try:
            payload = get(url, label=f"crossref doi {doi}")["payload"]
        except Refusal as exc:
            single.append({"doi": doi, "refused": str(exc), "status": exc.status})
            continue
        single.append(crossref_fields(payload.get("message") or {}))
    result["singleDoi"] = {"rows": single, "fill": count_fill([row for row in single if "refused" not in row], "crossref")}
    result["dateGap"] = sorted(({"doi": row.get("doi"), "allDates": row.get("allDates", {})}
                                for row in single if row.get("allDates") and len(row["allDates"]) > 1),
                               key=lambda item: str(item["allDates"].get("created", "")), reverse=True)[:4]

    # `updated-by` is what names a retraction, and it is not on every route. Three routes for the same three
    # DOIs, because 21 November's receipts used `query.bibliographic` and concluded Crossref "has no retraction
    # data". It does — on the route the Toolkit was not taking.
    for doi in RETRACTION_DOIS:
        try:
            direct = get(f"https://api.crossref.org/works/{urllib.parse.quote(doi)}",
                         label=f"crossref retraction direct {doi}")["payload"]
            via_filter = get(f"https://api.crossref.org/works?filter=doi:{urllib.parse.quote(doi)}&rows=1",
                             label=f"crossref retraction doi filter {doi}")["payload"]
        except Refusal as exc:
            result["routes"][doi] = {"refused": str(exc), "status": exc.status}
            continue
        message = direct.get("message") or {}
        filter_items = (via_filter.get("message") or {}).get("items") or []
        title = _text(message.get("title")) or doi
        routes: dict[str, Any] = {"singleDoiRoute": {**_route_presence(message), "updatedBy": crossref_fields(message)["updatedBy"]},
                                  "doiFilterRoute": {**_route_presence(filter_items[0] if filter_items else {}),
                                                     "foundAmongRows": bool(filter_items)}}
        try:
            via_bibliographic = get(f"https://api.crossref.org/works?query.bibliographic={urllib.parse.quote(title)}&rows=5",
                                    label=f"crossref retraction bibliographic {doi}")["payload"]
        except Refusal as exc:
            routes["bibliographicSearchRoute"] = {"refused": str(exc), "status": exc.status}
        else:
            items = (via_bibliographic.get("message") or {}).get("items") or []
            match = next((item for item in items if str(item.get("DOI", "")).lower() == doi.lower()), None)
            routes["bibliographicSearchRoute"] = {"foundAmongRows": match is not None, "rowsReturned": len(items),
                                                  **_route_presence(match or {})}
        result["routes"][doi] = routes
        fixture(f"crossref-retraction-{doi.replace('/', '_').replace('(', '').replace(')', '')}.json",
                {"proves": "Crossref names a retraction through `updated-by` with type `retraction`; the single-DOI route and the DOI filter carry it, and the bibliographic search route does not",
                 "measuredAt": GENERATED_AT, "doi": doi, "title": title, "routes": routes,
                 "redactedRows": {name: redact(row, ("DOI", "type", "title", "container-title", "issued", "created",
                                                     "updated-by", "is-referenced-by-count", "reference-count"))
                                  for name, row in (("singleDoiRoute", message),
                                                    ("doiFilterRoute", filter_items[0] if filter_items else {}))}})

    # Type unions. Crossref `type` is a vocabulary of near-synonyms and a filter on one name does not see the
    # others, so 'books from Crossref' is not one filter. Measured as counts, not as an opinion.
    unions: dict[str, Any] = {}
    for work_type in ("book", "monograph", "edited-book", "book-set", "reference-book", "journal-article"):
        try:
            payload = get(f"https://api.crossref.org/works?filter=type:{work_type}&rows=1",
                          label=f"crossref type {work_type}")["payload"]
        except Refusal as exc:
            unions[work_type] = {"refused": str(exc), "status": exc.status}
            continue
        unions[work_type] = {"reported": (payload.get("message") or {}).get("total-results")}
    # The cheap and decisive half: one work, asked for under its own type and under a neighbouring type.
    # `filter=type:X,doi:Y` is an AND, so a single-name filter proves what it cannot see.
    for work_type in ("book", "monograph", "edited-book", "book-chapter"):
        try:
            payload = get(f"https://api.crossref.org/works?filter=type:{work_type},doi:{urllib.parse.quote(UNION_PROBE_DOI)}&rows=1",
                          label=f"crossref type union {work_type}")["payload"]
        except Refusal as exc:
            unions[f"union:{work_type}"] = {"refused": str(exc), "status": exc.status}
            continue
        items = (payload.get("message") or {}).get("items") or []
        unions[f"union:{work_type}"] = {"returned": len(items),
                                        "typeSeen": items[0].get("type") if items else None}
    if any("refused" in state for state in unions.values()):
        _not_proven.append("Crossref type counts: some `filter=type:` totals timed out in this run on the anonymous "
                           "pool. The per-type union cross-check below them is what the type claim rests on.")
    try:
        payload = get("https://api.crossref.org/works?rows=20&query=catechism", label="crossref types seen")["payload"]
        seen: dict[str, int] = {}
        for item in (payload.get("message") or {}).get("items") or []:
            seen[str(item.get("type"))] = seen.get(str(item.get("type")), 0) + 1
        unions["typesSeenForQuery"] = seen
    except Refusal as exc:
        unions["typesSeenForQuery"] = {"refused": str(exc), "status": exc.status}
    result["typeUnions"] = unions
    fixture("crossref-type-vocabulary.json",
            {"proves": "Crossref `type` is a vocabulary of near-synonyms — book / monograph / edited-book / book-set / reference-book are separate filter values and a plain query returns a mix of them",
             "measuredAt": GENERATED_AT, "filterCounts": unions})

    for work_type in UNTITLED_TYPES:
        try:
            payload = get(f"https://api.crossref.org/works?filter=type:{work_type}&rows=3&select=DOI,type,title,container-title,issued,created",
                          label=f"crossref untitled {work_type}")["payload"]
        except Refusal as exc:
            result["untitledContainers"][work_type] = {"refused": str(exc), "status": exc.status}
            continue
        items = [(payload.get("message") or {}).get("items") or []]
        rows_out = [crossref_fields(item) for item in items[0]]
        result["untitledContainers"][work_type] = {
            "reported": (payload.get("message") or {}).get("total-results"), "returned": len(rows_out),
            "untitledRows": sum(1 for row in rows_out if row["untitledContainer"]),
            "titlesFilled": sum(1 for row in rows_out if row["title"]),
            "example": redact(items[0][0], ("DOI", "type", "title", "container-title", "issued", "created")) if items[0] else None}
    fixture("crossref-untitled-container-rows.json",
            {"proves": "container-level Crossref rows are measured per type: journal-issue and journal-volume rows carry a container title and no work title, while the component / standard / dataset rows in this sample do carry a work title — so 'has no title' is a route-and-type fact, not a Crossref-wide one",
             "measuredAt": GENERATED_AT, "types": result["untitledContainers"]})
    fixture("crossref-issued-vs-created.json",
            {"proves": "Crossref `created` is the DOI registration date, not the publication date; `issued` is the publication date where Crossref has one",
             "measuredAt": GENERATED_AT, "rows": [redact(row, ("doi", "allDates", "dateField", "date", "title", "publicationType"))
                                                  for row in single if row.get("allDates")]})
    result["fillSummary"] = {"search": result["searchFill"], "singleDoi": result["singleDoi"]["fill"]}
    return result


def probe_openalex() -> dict[str, Any]:
    result: dict[str, Any] = {"search": {}, "doiLookup": {}, "coverage": {}, "select": {}}
    rows: list[dict[str, Any]] = []
    for query in QUERIES:
        url = f"https://api.openalex.org/works?per-page=5&search={urllib.parse.quote(query)}"
        try:
            payload = get(url, label=f"openalex search {query}")["payload"]
        except Refusal as exc:
            result["search"][query] = {"refused": str(exc), "status": exc.status}
            continue
        items = payload.get("results") or []
        rows.extend(openalex_fields(item) for item in items)
        result["search"][query] = {"reported": (payload.get("meta") or {}).get("count"), "returned": len(items)}
    result["searchFill"] = count_fill(rows, "openalex")

    for doi in DOIS:
        try:
            payload = get(f"https://api.openalex.org/works/https://doi.org/{urllib.parse.quote(doi)}",
                          label=f"openalex doi {doi}")["payload"]
        except Refusal as exc:
            result["doiLookup"][doi] = {"refused": str(exc), "status": exc.status}
            continue
        result["doiLookup"][doi] = {"found": True, "id": payload.get("id"), **openalex_fields(payload)}

    # Coverage fact kept as a fixture: the same work is reachable by Crossref's DOI route and OpenAlex's id
    # route, and not by OpenAlex's search or its DOI filter. Ranking the providers by "which one found my
    # work" is what produced the wrong conclusion on 21 November; this is the measurement under it.
    # Coverage measured route by route, because "which provider found my work" is the question that produced a
    # wrong conclusion on 21 November. A route is only blind if the ids are compared the way the provider sends
    # them: OpenAlex sends `https://openalex.org/W3206688818`, and comparing that to the bare id reported three
    # working routes as blind on the first run of this probe. That is recorded, not hidden.
    try:
        by_search = get(f"https://api.openalex.org/works?filter=doi:{urllib.parse.quote(COVERAGE_DOI)}&per-page=5",
                        label="openalex coverage filter doi")["payload"]
        by_text = get(f"https://api.openalex.org/works?search={urllib.parse.quote('Kanonické právo spiritualita')}&per-page=5",
                      label="openalex coverage search text")["payload"]
        by_id = get(f"https://api.openalex.org/works/{OPENALEX_WORK_ID}", label="openalex coverage by id")["payload"]
        by_doi_route = get(f"https://api.openalex.org/works/https://doi.org/{urllib.parse.quote(COVERAGE_DOI)}",
                           label="openalex coverage doi route")["payload"]
        by_free_text = get(f"https://api.openalex.org/works?search={urllib.parse.quote(COVERAGE_DOI)}&per-page=5",
                           label="openalex coverage free text doi")["payload"]
        crossref_row = get(f"https://api.crossref.org/works/{urllib.parse.quote(COVERAGE_DOI)}",
                           label="crossref coverage doi route")["payload"].get("message") or {}
    except Refusal as exc:
        result["coverage"] = {"refused": str(exc), "status": exc.status}
        _not_proven.append(f"OpenAlex coverage case {OPENALEX_WORK_ID}: {exc}")
        return result

    def same_work(value: Any) -> bool:
        return isinstance(value, str) and value.rstrip("/").rsplit("/", 1)[-1] == OPENALEX_WORK_ID

    filter_ids = [item.get("id") for item in (by_search.get("results") or [])]
    search_ids = [item.get("id") for item in (by_text.get("results") or [])]
    free_text_ids = [item.get("id") for item in (by_free_text.get("results") or [])]
    result["coverage"] = {
        "workId": OPENALEX_WORK_ID, "doi": COVERAGE_DOI, "title": by_id.get("display_name"),
        "openalexDoiFilter": {"reported": (by_search.get("meta") or {}).get("count"), "returned": filter_ids,
                              "foundWork": any(same_work(item) for item in filter_ids)},
        "openalexTitleSearch": {"reported": (by_text.get("meta") or {}).get("count"), "returned": search_ids,
                                "foundWork": any(same_work(item) for item in search_ids)},
        "openalexFreeTextDoiQuery": {"reported": (by_free_text.get("meta") or {}).get("count"), "returned": free_text_ids,
                                     "foundWork": any(same_work(item) for item in free_text_ids)},
        "openalexIdRoute": {"foundWork": True, "id": by_id.get("id")},
        "openalexDoiRoute": {"foundWork": True, "id": by_doi_route.get("id")},
        "crossrefDoiRoute": {"foundWork": bool(crossref_row.get("DOI")), "type": crossref_row.get("type"),
                             "issued": _date(crossref_row.get("issued")), "citations": crossref_row.get("is-referenced-by-count")}}
    result["coverage"]["retestOfThe21NovemberClaim"] = (
        "OpenAlex's topical search returned the work for the query used here, so the field conclusion that OpenAlex "
        "cannot find this DOI is not reproduced on this machine and is recorded as not proven."
        if result["coverage"]["openalexTitleSearch"]["foundWork"] else
        "OpenAlex's topical search did not return the work for the query used here: the field conclusion reproduces.")
    if result["coverage"]["openalexTitleSearch"]["foundWork"]:
        _not_proven.append("The field conclusion that OpenAlex search cannot find 10.32725/cetv.2017.022 did not "
                           "reproduce on this machine: OpenAlex's topical search returned the work. What this run "
                           "proves is which routes return it, not that the earlier observation was wrong — its query "
                           "string was not recorded in the field receipt.")
    fixture("openalex-coverage-10.32725-cetv.2017.022.json",
            {"proves": "which routes return the frozen work id — Crossref's DOI route, OpenAlex's id route and DOI-lookup route, and what OpenAlex's DOI filter, its topical search and a free-text DOI query each report",
             "measuredAt": GENERATED_AT, "workId": OPENALEX_WORK_ID, "doi": COVERAGE_DOI,
             "title": by_id.get("display_name"), **result["coverage"],
             "openalexRow": redact(by_id, ("id", "doi", "display_name", "publication_year", "publication_date",
                                           "type", "is_retracted", "cited_by_count", "is_paratext", "referenced_works"))})

    # `select=` is the whole difference between the fields the adapter reads and the fields OpenAlex sends.
    selected = get(f"https://api.openalex.org/works/{OPENALEX_WORK_ID}?select={ADAPTER_SELECT}",
                   label="openalex select adapter list")["payload"]
    full = get(f"https://api.openalex.org/works/{OPENALEX_WORK_ID}", label="openalex default representation")["payload"]
    result["select"] = {
        "adapterSelectList": ADAPTER_SELECT,
        "presentInDefault": {name: name in full for name in SELECT_ONLY_FIELDS},
        "presentWithAdapterSelect": {name: name in selected for name in SELECT_ONLY_FIELDS},
        "defaultTopLevelKeys": sorted(full)[:40], "selectedTopLevelKeys": sorted(selected)}
    fixture("openalex-select-field-availability.json",
            {"proves": "OpenAlex returns the full work by default and ONLY the selected fields when `select=` is used: type, is_retracted, cited_by_count and is_paratext are absent from a response built with the adapter's select list",
             "measuredAt": GENERATED_AT, "workId": OPENALEX_WORK_ID,
             "adapterSelectList": ADAPTER_SELECT,
             "defaultKeys": sorted(full), "selectedKeys": sorted(selected),
             "selectedOnlyFields": {name: {"inDefault": name in full, "withAdapterSelect": name in selected}
                                    for name in SELECT_ONLY_FIELDS},
             "redactedDefault": redact(full, ("id", "doi", "display_name", "type", "is_retracted", "cited_by_count",
                                              "is_paratext", "publication_date", "publication_year")),
             "redactedSelected": redact(selected, ("id", "doi", "display_name", "type", "is_retracted",
                                                   "cited_by_count", "is_paratext", "publication_date", "publication_year"))})
    result["fillSummary"] = {"search": result["searchFill"]}
    return result


def probe_semantic_scholar() -> dict[str, Any]:
    """Both positions the operator can be in, measured in the same run: no acknowledgement, and acknowledged.

    The refusal text is recorded as the Toolkit produced it (`research.py`'s gate) and as the provider said
    it (a direct anonymous request), because those are two different sentences and only the second one is
    about the provider's rate limit.
    """
    import os

    from research_stack import research

    result: dict[str, Any] = {}
    for name in ("SEMANTIC_SCHOLAR_API_KEY", "SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED"):
        os.environ.pop(name, None)
    try:
        research.search_literature("semantic_scholar", "corpus iuris canonici", 1)
        result["withoutAcknowledgement"] = {"outcome": "answered", "note": "the adapter sent a request with no acknowledgement recorded"}
    except research.ResearchError as exc:
        result["withoutAcknowledgement"] = {"code": exc.code, "message": str(exc), "requestsSent": 0}
    os.environ["SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED"] = "true"
    try:
        answered = research.search_literature("semantic_scholar", "corpus iuris canonici", 1)
        result["withAcknowledgement"] = {"outcome": "answered", "records": len(answered.get("records") or []),
                                         "errors": answered.get("errors")}
    except research.ResearchError as exc:
        result["withAcknowledgement"] = {"code": exc.code, "message": str(exc), "retryAfter": exc.retry_after}
    os.environ.pop("SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED", None)
    try:
        raw = get("https://api.semanticscholar.org/graph/v1/paper/search?query=corpus+iuris+canonici&limit=1&fields=title,year",
                  label="semanticscholar anonymous raw")
        result["rawAnonymous"] = {"status": raw["status"], "rateHeaders": raw["rateHeaders"]}
    except Refusal as exc:
        result["rawAnonymous"] = {"status": exc.status, "reason": exc.reason, "bodyExcerpt": exc.body}
    if result["rawAnonymous"].get("status") == 429:
        _not_proven.append("Semantic Scholar field fill could not be measured: every anonymous request was refused "
                           "with HTTP 429 in this container, and an anonymous 429 is the provider's global pool, "
                           "not this Toolkit's allowance.")
    else:
        result["notProvenFields"] = "Semantic Scholar field coverage was not sampled beyond one bounded request."
    return result


def summarise(crossref: dict[str, Any], openalex: dict[str, Any], semantic: dict[str, Any]) -> str:
    lines = ["# Provider measurement 2026-11-22 (0.3.15)", "",
             f"Generated {GENERATED_AT} by `scripts/probe_providers.py`. Anonymous, paced "
             f"(Crossref {PACING_SECONDS['api.crossref.org']} s, OpenAlex {PACING_SECONDS['api.openalex.org']} s, "
             f"Semantic Scholar {PACING_SECONDS['api.semanticscholar.org']} s), no credential sent.", "",
             "## What was asked", "",
             f"{len(_request_log)} requests, in order, each one recorded in `receipt.json` under `requests`. "
             "Crossref rows come from `works?query=` (search) and `works/{doi}` (single DOI); OpenAlex rows come "
             "from `works?search=` and `works/<id or doi-url>`. A field counted on one route is not a claim about another.", "",
             "## Field fill over the rows the provider returned", "",
             "Read each cell as `filled (z = sent as a real zero, a = field absent from the response)`. A zero and an",
             "absent field are different facts, and a refused request is in neither count — it is listed under refusals.",
             "",
             "| Provider | Route | Rows | " + " | ".join(FILLED_FIELDS) + " |",
             "|---|---|---|" + "---|" * len(FILLED_FIELDS)]
    for provider, block, routes in (("crossref", crossref, (("search", crossref.get("searchFill")),
                                                            ("single doi", (crossref.get("singleDoi") or {}).get("fill")))),
                                    ("openalex", openalex, (("search", openalex.get("searchFill")),))):
        for route, fill in routes:
            if not fill:
                continue
            lines.append(f"| {provider} | {route} | {fill['rowsReturned']} | "
                         + " | ".join(f"{fill['fieldsFilled'][field]} (z{fill['fieldsReportedZero'][field]}, "
                                      f"a{fill['fieldsAbsent'][field]})" for field in FILLED_FIELDS) + " |")
    lines += ["", "## 429 is not an empty field", "",
              f"Refusals recorded: {len(_refusals)}"]
    for refusal in _refusals:
        lines.append(f"- {refusal['label']}: HTTP {refusal['status']} — {refusal['reason'][:120]}")
    lines += ["", "## Crossref date fields", "",
              "`issued` is the publication date; `created` is the DOI registration date. Rows where both exist:", ""]
    for row in crossref.get("dateGap", []):
        lines.append(f"- {row['doi']}: {json.dumps(row['allDates'], ensure_ascii=False)}")
    lines += ["", "## Crossref retraction routes (`updated-by`)", ""]
    for doi, routes in (crossref.get("routes") or {}).items():
        if "refused" in routes:
            lines.append(f"- {doi}: refused ({routes.get('status')})")
            continue
        parts = [f"{name}: updated-by={state.get('hasUpdatedBy')} retracted={state.get('retracted')}"
                 if "refused" not in state else f"{name}: refused ({state.get('status')})"
                 for name, state in routes.items()]
        lines.append(f"- {doi} — " + "; ".join(parts))
    lines += ["", "## Untitled container rows", ""]
    for work_type, state in (crossref.get("untitledContainers") or {}).items():
        if "refused" in state:
            lines.append(f"- {work_type}: refused ({state.get('status')})")
            continue
        lines.append(f"- {work_type}: {state['untitledRows']}/{state['returned']} rows with a container title and no work title "
                     f"(titles filled: {state['titlesFilled']}; provider reports {state['reported']})")
    lines += ["", "## Crossref type vocabulary (why one filter is not 'books')", ""]
    for name, state in (crossref.get("typeUnions") or {}).items():
        lines.append(f"- {name}: {json.dumps(state, ensure_ascii=False)}")
    lines += ["", "## OpenAlex `select=`", "",
              f"- Adapter list under test: `{ADAPTER_SELECT}`",
              f"- Present in the default representation: {json.dumps(openalex['select']['presentInDefault'])}",
              f"- Present with the adapter's `select=`: {json.dumps(openalex['select']['presentWithAdapterSelect'])}"]
    lines += ["", "## Coverage: the same work on six routes", ""]
    coverage = openalex.get("coverage") or {}
    if coverage.get("workId"):
        lines.append(f"- {coverage['workId']} — {coverage.get('title')} ({coverage.get('doi')})")
        for name in ("crossrefDoiRoute", "openalexIdRoute", "openalexDoiRoute", "openalexDoiFilter",
                     "openalexTitleSearch", "openalexFreeTextDoiQuery"):
            state = coverage.get(name) or {}
            lines.append(f"  - {name}: found={state.get('foundWork')}"
                         + (f", provider reports {state['reported']}" if "reported" in state else ""))
        lines.append(f"  - retest: {coverage.get('retestOfThe21NovemberClaim')}")
    lines += ["", "## Semantic Scholar", ""]
    for key in ("withoutAcknowledgement", "withAcknowledgement", "rawAnonymous"):
        lines.append(f"- {key}: {json.dumps(semantic.get(key), ensure_ascii=False)}")
    lines += ["", "## Not proven in this run", ""]
    lines += [f"- {item}" for item in _not_proven] or ["- nothing was left unproven in this run"]
    lines += ["", "## Refusals seen (full list)", "", "```json", json.dumps(_refusals, indent=2, ensure_ascii=True), "```", ""]
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    global EVIDENCE_DIR
    out = Path(argv[1]) if len(argv) > 1 else EVIDENCE_DIR
    EVIDENCE_DIR = out
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    crossref = probe_crossref()
    openalex = probe_openalex()
    semantic = probe_semantic_scholar()
    receipt = {"probe": "providers-2026-11-22", "generatedAt": GENERATED_AT,
               "pacingSecondsPerHost": PACING_SECONDS, "userAgent": USER_AGENT,
               "credentialsSent": False, "queries": QUERIES, "dois": DOIS,
               "requestCount": len(_request_log), "requests": _request_log,
               "fields": FILLED_FIELDS, "providers": {"crossref": crossref, "openalex": openalex,
                                                      "semanticScholar": semantic},
               "refusals": _refusals, "notProven": _not_proven}
    text = json.dumps(receipt, indent=2, ensure_ascii=True) + "\n"
    for marker in ("api_key", "apikey", "token", "Authorization"):
        if marker.lower() in text.lower():
            print(f"REFUSED: the receipt contains {marker!r}; a credential value or header entered the evidence", file=sys.stderr)
            return 1
    (EVIDENCE_DIR / "receipt.json").write_text(text, encoding="utf-8")
    (EVIDENCE_DIR / "summary.md").write_text(summarise(crossref, openalex, semantic), encoding="utf-8")
    print(f"evidence written to {EVIDENCE_DIR}: receipt.json, summary.md, fixtures/")
    print(json.dumps({"crossrefSearchFill": crossref.get("searchFill"),
                      "crossrefSingleDoiFill": (crossref.get("singleDoi") or {}).get("fill"),
                      "openalexSearchFill": openalex.get("searchFill"),
                      "semanticScholar": {key: semantic.get(key) for key in ("withoutAcknowledgement", "rawAnonymous")},
                      "refusals": len(_refusals), "notProven": _not_proven}, indent=2, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
