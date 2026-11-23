"""Bounded, provenance-preserving adapters for scholarly metadata and Zotero.

Provider credentials are read only from the process environment. Requests are paced by a budget
shared across Toolkit processes (provider_budget.py), which also caches provider metadata and says
so when an answer came from that cache. Zotero reads go to the loopback local API and need no key.
Writing is a separate permission and a separate code path: `zotero_write` sends a change only with a
key the operator authorized in Zotero, the literal confirmation string, a version guard on every
request, and a snapshot of the library written before the first change. The module never opens
`zotero.sqlite`, never reads Zotero's own key file, never asks Zotero for its consent dialog, and
never sends a delete. It reads the full text Zotero itself has indexed; it does not download a
publisher's file.
"""

from __future__ import annotations

import hashlib
import html
import http.client
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime
from html.parser import HTMLParser
from typing import Any

from . import provider_budget

REQUEST_TIMEOUT_SECONDS = 15
MAX_RESULTS = 25
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
# IPv4 loopback, not `localhost`: Zotero binds IPv4 only, so a `localhost` that resolves to `[::1]` misses.
ZOTERO_LOCAL_API = "http://127.0.0.1:23119/api"
# The connector endpoint sits beside /api, not under it, and is not gated on the local-API preference: it is the
# one request that can tell "Zotero is running" from "the local API is off".
ZOTERO_CONNECTOR_PING = "http://127.0.0.1:23119/connector/ping"
ZOTERO_LOOPBACK_ORIGIN = "http://127.0.0.1:23119"
# Zotero answers the local API only after the library has finished loading, and its own Connector waits 15
# seconds for these endpoints. These are the waits one readiness check allows each stage of its own work.
ZOTERO_ROOT_TIMEOUT_SECONDS = 5
ZOTERO_LISTING_TIMEOUT_SECONDS = 12
ZOTERO_PING_TIMEOUT_SECONDS = 3
PROVIDERS = ("openalex", "crossref", "semantic_scholar")
_THROTTLE_LOCKS = {provider: threading.Lock() for provider in PROVIDERS}
_LAST_REQUEST_AT: dict[str, float] = {}
MIN_REQUEST_INTERVAL_SECONDS = 1.0
# Which environment variable makes a provider call a keyed call, so the keyed budget applies.
_KEYED_ENVIRONMENT = {"openalex": "OPENALEX_API_KEY", "crossref": "CROSSREF_PLUS_API_TOKEN", "semantic_scholar": "SEMANTIC_SCHOLAR_API_KEY"}


class ResearchError(RuntimeError):
    """An actionable provider or local-library error with a stable code."""

    def __init__(self, code: str, message: str, *, retry_after: str | None = None, evidence: str | None = None, report: dict[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after
        # What the local server actually answered, clipped: the readiness receipt carries it so an operator's
        # report says which answer Zotero gave instead of leaving the cause to be guessed.
        self.evidence = evidence
        # A write that stopped partway describes the library, not only the failure: the report names which
        # operations arrived and which did not, so refusing the rest does not erase what already happened.
        self.report = report

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {"code": self.code, "message": str(self)}
        if self.retry_after:
            result["retryAfter"] = self.retry_after
        if self.report:
            result["writeReport"] = self.report
        return result


class _SameHostHTTPSRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        original = urllib.parse.urlsplit(request.full_url)
        redirected = urllib.parse.urlsplit(newurl)
        if redirected.scheme != "https" or (redirected.hostname, redirected.port) != (original.hostname, original.port):
            raise urllib.error.HTTPError(newurl, code, "Cross-host or non-HTTPS provider redirect blocked", headers, fp)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        raise urllib.error.HTTPError(newurl, code, "Unexpected Zotero local API redirect blocked", headers, fp)


def normalize_doi(value: str | None) -> str | None:
    """Normalize a DOI while keeping balanced punctuation that belongs to the identifier.

    Trailing citation delimiters are removed; a closing bracket is kept when its opening
    bracket is present, so ``10.1234/example(2026)`` is not cut into ``10.1234/example(2026``.
    """
    if not value:
        return None
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", str(value).strip(), flags=re.I)
    doi = html.unescape(doi).strip().lower()
    while doi:
        last = doi[-1]
        if last in ".,;":
            doi = doi[:-1]
            continue
        if last == ")" and doi.count("(") < doi.count(")"):
            doi = doi[:-1]
            continue
        break
    doi = doi.rstrip()
    return doi if re.fullmatch(r"10\.\d{4,9}/\S+", doi) else None


def _dict_list(value: Any) -> list[dict[str, Any]]:
    """Keep only the well-formed entries of a provider list; malformed entries are dropped."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _first_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value or None
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str) and item:
                return item
    return None


def _first_date_part(value: Any) -> int | None:
    if not isinstance(value, dict):
        return None
    parts = value.get("date-parts")
    if isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0] and isinstance(parts[0][0], int):
        return parts[0][0]
    return None


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def _plain_text(value: str | None) -> str | None:
    if not value:
        return None
    parser = _TextExtractor()
    parser.feed(value)
    result = " ".join(" ".join(parser.parts).split())
    return result or None


def _abstract_from_inverted_index(index: dict[str, list[int]] | None) -> str | None:
    if not index:
        return None
    positions: dict[int, str] = {}
    for word, offsets in index.items():
        for offset in offsets:
            positions[offset] = word
    return " ".join(positions[i] for i in sorted(positions)) or None


def _request_json(url: str, headers: dict[str, str] | None = None) -> tuple[dict[str, Any] | list[Any], dict[str, str]]:
    request = urllib.request.Request(url, headers={"Accept": "application/json", **(headers or {})})
    try:
        opener = urllib.request.build_opener(_SameHostHTTPSRedirectHandler())
        with opener.open(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ResearchError("RESPONSE_TOO_LARGE", "Provider response exceeded the 4 MiB safety limit.")
            decoded = json.loads(raw.decode("utf-8"))
            if not isinstance(decoded, (dict, list)):
                raise ResearchError("PROVIDER_SCHEMA_UNEXPECTED", "Provider returned a non-object JSON response.")
            return decoded, {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            code = "PROVIDER_AUTH_REQUIRED"
            message = "Provider denied the request; check API access and credentials."
        elif exc.code == 404:
            code = "PROVIDER_NOT_FOUND"
            message = "Provider has no matching record. This does not prove the work or identifier is invalid."
        elif exc.code == 429:
            code = "PROVIDER_RATE_LIMITED"
            # The Toolkit's own bounded backoff is the mechanism; a wait the provider actually named is carried
            # with the error, and no provider is assumed to name one (Semantic Scholar documents none).
            message = "Provider rate limit reached; the Toolkit's own bounded backoff applies, with any wait the provider named carried through."
        elif exc.code >= 500:
            code = "PROVIDER_UNAVAILABLE"
            message = f"Provider returned HTTP {exc.code}; no result count was inferred."
        else:
            code = "PROVIDER_REQUEST_REJECTED"
            message = f"Provider rejected the request with HTTP {exc.code}."
        raise ResearchError(code, message, retry_after=exc.headers.get("Retry-After")) from exc
    except (TimeoutError, urllib.error.URLError) as exc:
        raise ResearchError("PROVIDER_UNAVAILABLE", "Provider request timed out or could not connect; no result count was inferred.") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ResearchError("PROVIDER_SCHEMA_UNEXPECTED", "Provider returned malformed JSON.") from exc


def _provider_request(provider: str, url: str, headers: dict[str, str] | None = None,
                      cache_key: str | None = None) -> tuple[dict[str, Any] | list[Any], dict[str, str], dict[str, Any]]:
    # Serialize each provider and use a conservative one-request-per-second
    # process-local pacing floor until account-specific limits are proven. The floor is only the fast
    # path: the shared per-user budget in provider_budget.py is authoritative, because the provider
    # limits the caller and several Toolkit processes are one caller to it (INT-15.5).
    lock = _THROTTLE_LOCKS[provider]
    with lock:
        elapsed = time.monotonic() - _LAST_REQUEST_AT.get(provider, 0.0)
        if elapsed < MIN_REQUEST_INTERVAL_SECONDS:
            time.sleep(MIN_REQUEST_INTERVAL_SECONDS - elapsed)
        budget = provider_budget.ProviderBudget(provider, keyed=bool(os.environ.get(_KEYED_ENVIRONMENT.get(provider, ""))))
        try:
            outcome = budget.run(_request_json, url, headers=headers, cache_key=cache_key)
        finally:
            _LAST_REQUEST_AT[provider] = time.monotonic()
    if outcome["deferred"]:
        carried = outcome.get("error") or {}
        if carried.get("code"):
            raise ResearchError(carried["code"], carried["message"], retry_after=carried.get("retryAfter"))
        seconds = str(max(1, -(-outcome["waitMs"] // 1000)))
        if outcome["deferred"] == "in-flight":
            # Not a rate limit. The provider was not refused, did not answer 429, and has not been asked
            # twice: a second Toolkit check is already asking this provider this exact query and is holding
            # the key for it. Saying "rate limit" here sends an operator to the wrong page.
            raise ResearchError("PROVIDER_BUDGET_DEFERRED",
                                f"Another Toolkit check is already asking {provider} this exact query, so this one was held back rather than asking the provider the same thing twice. Nothing failed and no limit was reported; ask again in {seconds} s.",
                                retry_after=seconds)
        raise ResearchError("PROVIDER_BUDGET_DEFERRED",
                            "Another Toolkit process is already waiting out this provider's rate limit; the Toolkit will not ask again before the shared budget opens.",
                            retry_after=seconds)
    return outcome["payload"], outcome["headers"], outcome


def _query_hash(provider: str, query: str) -> str:
    return hashlib.sha256(f"{provider}\0{query.strip()}".encode("utf-8")).hexdigest()


def _field(value: Any, provider: str, upstream_id: str, fetched_at: str, query_hash: str) -> dict[str, Any]:
    return {"value": value, "provenance": {"provider": provider, "upstreamId": upstream_id, "fetchedAt": fetched_at, "queryHash": query_hash}}


# --- provider vocabulary, all of it measured 22/23 November 2026 (evidence/providers-2026-11-22/) ---
# Crossref `type` is a vocabulary of near-synonyms, not a taxonomy. Measured on one book chapter
# (`fixtures/crossref-type-vocabulary.json`): `filter=type:book,doi:10.2307/j.ctt28524j.7` returns 0 rows,
# `filter=type:monograph,doi:…` returns 0, `filter=type:edited-book,doi:…` returns 0, and
# `filter=type:book-chapter,doi:…` returns 1. A plain query over the same work returned a mix of ten types.
# A family is therefore a named set, and a filter that means "books" has to say all five names.
CROSSREF_BOOK_TYPES = ("book", "monograph", "edited-book", "book-set", "reference-book")
CROSSREF_CHAPTER_TYPES = ("book-chapter", "book-part")
# The four Crossref date fields, in the order the adapter is allowed to read them. Measured apart
# (`fixtures/crossref-issued-vs-created.json`): `10.32725/cetv.2017.022` carries issued 2017-03-30 against
# created 2021-10-11, and `10.1056/nejmoa1200303` carries created 2013-02-25 before its issued 2013-04-04.
# `created` is the DOI registration date, so it comes last and it is never used without naming itself.
CROSSREF_DATE_FIELDS = ("issued", "published-online", "published-print", "created")
PROVIDER_LABELS = {"openalex": "OpenAlex", "crossref": "Crossref", "semantic_scholar": "Semantic Scholar"}


def crossref_type_filter(family: str) -> str:
    """The filter clause for a Crossref type family, as one repeated value: `type:book,monograph,…`.

    Crossref reads repeated values inside one filter name as an OR and different filter names as an AND, so
    the union of a family is one `type:` clause with comma-separated members. (The clause is built here so
    there is one writer of it; the run measured the single-name filters and refuses to claim what it did not
    ask — see `tests/test_provider_release.py::test_one_crossref_type_filter_is_not_books`.)
    """
    members = {"book": CROSSREF_BOOK_TYPES, "chapter": CROSSREF_CHAPTER_TYPES}.get(family)
    if members is None:
        raise ResearchError("PROVIDER_TYPE_FAMILY_UNKNOWN", f"The Toolkit has no Crossref type family named {family!r}; it names 'book' and 'chapter'.")
    return "type:" + ",".join(members)


def _crossref_date_parts(value: Any) -> str | None:
    """Crossref's `{"date-parts": [[2017, 3, 30]]}` as `2017-03-30`; a year-only list as `2017`."""
    if not isinstance(value, dict):
        return None
    parts = value.get("date-parts")
    if not (isinstance(parts, list) and parts and isinstance(parts[0], list) and parts[0]):
        return None
    numbers = [item for item in parts[0] if isinstance(item, int)]
    if not numbers:
        return None
    return str(numbers[0]) if len(numbers) == 1 else "-".join([str(numbers[0]), *[f"{item:02d}" for item in numbers[1:3]]])


def _crossref_date(raw: dict[str, Any]) -> tuple[str | None, str | None]:
    """The publication date and which Crossref field it came from — the field is part of the answer."""
    for field in CROSSREF_DATE_FIELDS:
        date = _crossref_date_parts(raw.get(field))
        if date:
            return date, field
    return None, None


def _crossref_retracted(raw: dict[str, Any]) -> bool | None:
    """`updated-by` is the only thing at Crossref that names a retraction, and it is route-dependent.

    Measured over three known retractions: `updated-by` is on the single-DOI route and on the `filter=doi:`
    route for all three, and on 0 of 25 plain search rows. So an absent key is `None` — this request did not
    see the field — and only a present `updated-by` is allowed to answer `False`, which is what "not
    retracted" would otherwise quietly mean for every search row the Toolkit has ever shown.
    """
    updated = raw.get("updated-by")
    if updated is None:
        return None
    entries = updated if isinstance(updated, list) else []
    return any(entry.get("type") == "retraction" for entry in entries if isinstance(entry, dict))


def _count(value: Any) -> int | None:
    """A count the provider sent, including a real zero. A field the provider omitted is not a zero."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _reference_count(raw: dict[str, Any]) -> int | None:
    """OpenAlex carries the works as `referenced_works`; the count is the length of that list, or absent."""
    works = raw.get("referenced_works")
    return len(works) if isinstance(works, list) else None


def _field_providers(record: dict[str, Any]) -> list[str]:
    """Every provider named behind this record's fields, in the order first seen, with no duplicates."""
    providers: list[str] = []
    for item in record.values():
        if not isinstance(item, dict):
            continue
        sources = item.get("provenance")
        for source in sources if isinstance(sources, list) else [sources]:
            name = source.get("provider") if isinstance(source, dict) else None
            if isinstance(name, str) and name and name not in providers:
                providers.append(name)
    return providers


def _normalize(provider: str, raw: dict[str, Any], fetched_at: str, query_hash: str) -> dict[str, Any]:
    if provider == "openalex":
        upstream_id = str(raw.get("id", ""))
        authors = [entry["author"].get("display_name") for entry in _dict_list(raw.get("authorships"))
                   if isinstance(entry.get("author"), dict) and entry["author"].get("display_name")]
        location = raw.get("primary_location") if isinstance(raw.get("primary_location"), dict) else {}
        source = location.get("source") if isinstance(location.get("source"), dict) else {}
        doi = normalize_doi(raw.get("doi"))
        open_access = raw.get("open_access") if isinstance(raw.get("open_access"), dict) else {}
        values = {"title": _first_text(raw.get("title")), "authors": authors, "year": raw.get("publication_year") if isinstance(raw.get("publication_year"), int) else None, "date": raw.get("publication_date") if isinstance(raw.get("publication_date"), (list, str)) else None, "venue": source.get("display_name"), "publicationType": raw.get("type"), "abstract": _abstract_from_inverted_index(raw.get("abstract_inverted_index") if isinstance(raw.get("abstract_inverted_index"), dict) else None), "url": upstream_id or None, "openAccessUrl": open_access.get("oa_url"), "license": None,
                  # Read from the fields the request now asks for (`_request_for`): the 21 November receipts
                  # showed these empty because `select=` did not name them, not because OpenAlex lacks them.
                  # An absent field stays None; `cited_by_count: 0` on W3206688818 stays 0.
                  "dateField": "publication_date" if raw.get("publication_date") else None, "retracted": raw.get("is_retracted") if isinstance(raw.get("is_retracted"), bool) else None, "citationCount": _count(raw.get("cited_by_count")), "referenceCount": _reference_count(raw)}
    elif provider == "crossref":
        upstream_id = str(raw.get("DOI", ""))
        authors = [" ".join(filter(None, (a.get("given"), a.get("family")))) for a in _dict_list(raw.get("author"))]
        authors = [a for a in authors if a]
        title = _first_text(raw.get("title"))
        doi = normalize_doi(raw.get("DOI"))
        links = _dict_list(raw.get("link"))
        # The year and the date come from the same field, in the measured precedence. Until 0.3.15 the year
        # was read from `published-print`, then `published-online`, then `created` — so a work whose `issued`
        # date Crossref states got its year from the DOI registration date, and `date` was written as None.
        date, date_field = _crossref_date(raw)
        values = {"title": title, "authors": authors, "year": _first_date_part(raw.get(date_field)) if date_field else None, "date": date, "dateField": date_field, "retracted": _crossref_retracted(raw), "citationCount": _count(raw.get("is-referenced-by-count")), "referenceCount": _count(raw.get("reference-count")), "venue": _first_text(raw.get("container-title")), "publicationType": raw.get("type"), "abstract": _plain_text(raw.get("abstract")) if isinstance(raw.get("abstract"), str) else None, "url": raw.get("URL"), "openAccessUrl": next((x.get("URL") for x in links if isinstance(x.get("content-type"), str) and "pdf" in x["content-type"].lower()), None), "license": None}
    else:
        upstream_id = str(raw.get("paperId", ""))
        external = raw.get("externalIds") if isinstance(raw.get("externalIds"), dict) else {}
        doi = normalize_doi(external.get("DOI"))
        types = [item for item in (raw.get("publicationTypes") if isinstance(raw.get("publicationTypes"), list) else []) if isinstance(item, str)]
        open_pdf = raw.get("openAccessPdf") if isinstance(raw.get("openAccessPdf"), dict) else {}
        values = {"title": _first_text(raw.get("title")), "authors": [a.get("name") for a in _dict_list(raw.get("authors")) if a.get("name")], "year": raw.get("year") if isinstance(raw.get("year"), int) else None, "date": raw.get("publicationDate"), "venue": _first_text(raw.get("venue")), "publicationType": types[0] if types else None, "abstract": raw.get("abstract") if isinstance(raw.get("abstract"), str) else None, "url": raw.get("url"), "openAccessUrl": open_pdf.get("url"), "license": open_pdf.get("license") if isinstance(open_pdf.get("license"), str) else None,
                  # Read when Semantic Scholar sends them (the request now asks: `fields=` carries
                  # publicationTypes, citationCount, referenceCount, isRetracted). Their fill is NOT proven
                  # here — every anonymous request in the 22 November run was refused with 429 — so an absent
                  # field stays absent and no test claims a value the provider never sent.
                  "dateField": "publicationDate" if raw.get("publicationDate") else None, "retracted": raw.get("isRetracted") if isinstance(raw.get("isRetracted"), bool) else None, "citationCount": _count(raw.get("citationCount")), "referenceCount": _count(raw.get("referenceCount"))}

    record_id = f"doi:{doi}" if doi else f"{provider}:{upstream_id or query_hash[:16]}"
    normalized: dict[str, Any] = {"id": record_id, "doi": _field(doi, provider, upstream_id, fetched_at, query_hash), "sourceIds": {provider: upstream_id} if upstream_id else {}, "attribution": [], "warnings": []}
    if provider == "semantic_scholar" and upstream_id:
        source_url = values.get("url") or f"https://www.semanticscholar.org/paper/{urllib.parse.quote(upstream_id, safe='')}"
        separator = "&" if "?" in source_url else "?"
        source_url = f"{source_url}{separator}utm_source=api"
        values["url"] = source_url
        normalized["attribution"].append({"provider": "Semantic Scholar", "url": source_url, "publicDisplayRequiresNameAndLogo": True})
    for name, value in values.items():
        if name == "abstract":
            value = _plain_text(value) if isinstance(value, str) else value
        normalized[name] = _field(value, provider, upstream_id, fetched_at, query_hash)
    if provider == "crossref" and values.get("dateField") == "created":
        # `created` is allowed to be used — a work with no publication date is better dated than dropped —
        # but never silently: the record carries the field it came from and this warning says what it means.
        normalized["warnings"].append("DATE_FIELD_IS_DOI_REGISTRATION: this date comes from Crossref `created`, the DOI registration date, not from `issued`, `published-online` or `published-print`.")
    normalized["evidenceScope"] = "abstract-only" if values.get("abstract") else "metadata-only"
    normalized["access"] = {"status": "link-reported" if values.get("openAccessUrl") else "unknown", "url": values.get("openAccessUrl"), "license": None, "retrieved": False}
    normalized["review"] = {"status": "unreviewed", "notes": []}
    return normalized


def _crossref_headers() -> dict[str, str]:
    """The configured Crossref request policy, used by search and by DOI lookup alike."""
    token = os.environ.get("CROSSREF_PLUS_API_TOKEN")
    headers = {"Crossref-Plus-API-Token": f"Bearer {token}"} if token else {}
    mailto = os.environ.get("CROSSREF_MAILTO")
    headers["User-Agent"] = f"ResearchStack/{__version_label()} (mailto:{mailto})" if mailto else f"ResearchStack/{__version_label()}"
    return headers


def __version_label() -> str:
    from . import __version__

    return __version__


# OpenAlex answers with the whole work by default and with ONLY the named fields when `select=` is used.
# Measured on W3206688818 (`evidence/providers-2026-11-22/fixtures/openalex-select-field-availability.json`):
# the default representation carries 58 keys — `type`, `is_retracted`, `cited_by_count`, `is_paratext` and
# `referenced_works` among them — and the response built with the adapter's old nine-name `select=` carried
# exactly those nine and none of the others. So every field `_normalize("openalex", …)` reads has to be named
# here, or the empty columns in the 21 November field receipts come back exactly as they were.
OPENALEX_SELECT_FIELDS = ("id", "doi", "title", "authorships", "publication_year", "publication_date",
                          "primary_location", "abstract_inverted_index", "open_access",
                          "type", "is_retracted", "cited_by_count", "is_paratext", "referenced_works")
# The four new names are asked for. Their fill is not claimed: what the 22 November run proved about
# Semantic Scholar is one anonymous 429, so a test may only assert what the adapter asks and reads.
SEMANTIC_SCHOLAR_FIELDS = ("paperId", "title", "authors", "year", "publicationDate", "venue", "abstract",
                           "externalIds", "url", "openAccessPdf", "publicationTypes", "citationCount",
                           "referenceCount", "isRetracted")


def _request_for(provider: str, query: str, limit: int) -> tuple[str, dict[str, str], str]:
    """Build the request, and name the route it is — a route is part of what an answer can prove.

    A query that is a DOI is an identifier, not a search phrase. Measured 22 November 2026 over
    `10.32725/cetv.2017.022` (OpenAlex W3206688818): `filter=doi:` returns it, Crossref's `works/{doi}`
    returns it, OpenAlex's own id and doi-lookup routes return it, and `works?search=<doi>` as free text
    returned 0 rows in that run. The DOI routes are also the routes measured to carry Crossref's
    `updated-by`, the only thing that names a retraction. A query that is not a DOI takes exactly the path
    0.3.14 took; nothing about it changes.
    """
    doi = normalize_doi(query)
    if provider == "openalex":
        params: dict[str, Any] = {"per_page": limit, "select": ",".join(OPENALEX_SELECT_FIELDS)}
        params["filter" if doi else "search"] = f"doi:{doi}" if doi else query
        encoded = urllib.parse.urlencode(params)
        key = os.environ.get("OPENALEX_API_KEY")
        if key:
            encoded += "&" + urllib.parse.urlencode({"api_key": key})
        return f"https://api.openalex.org/works?{encoded}", {}, "openalex-doi-filter" if doi else "openalex-search"
    if provider == "crossref":
        if doi:
            # The single-DOI route: measured to carry `updated-by` for all three retraction fixtures, where
            # the bibliographic search row carried it for two of the three and 0 of 25 plain search rows.
            return f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='/')}", _crossref_headers(), "crossref-single-doi"
        params = {"query.bibliographic": query, "rows": limit}
        mailto = os.environ.get("CROSSREF_MAILTO")
        if mailto:
            params["mailto"] = mailto
        return f"https://api.crossref.org/works?{urllib.parse.urlencode(params)}", _crossref_headers(), "crossref-bibliographic"
    if provider == "semantic_scholar":
        params = {"query": query, "limit": limit, "fields": ",".join(SEMANTIC_SCHOLAR_FIELDS)}
        headers = {"x-api-key": os.environ["SEMANTIC_SCHOLAR_API_KEY"]} if os.environ.get("SEMANTIC_SCHOLAR_API_KEY") else {}
        return f"https://api.semanticscholar.org/graph/v1/paper/search?{urllib.parse.urlencode(params)}", headers, "semantic-scholar-search"
    raise ResearchError("PROVIDER_UNKNOWN", "Choose openalex, crossref, semantic_scholar, or all.")


def _search_one(provider: str, query: str, limit: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    url, headers, route = _request_for(provider, query, limit)
    query_hash = _query_hash(provider, query)
    payload, response_headers, budget = _provider_request(provider, url, headers, cache_key=query_hash)
    if provider == "openalex":
        rows = payload.get("results") if isinstance(payload, dict) else None
        meta = payload.get("meta", {}) if isinstance(payload, dict) else {}
    elif provider == "crossref":
        message = payload.get("message", {}) if isinstance(payload, dict) else {}
        if route == "crossref-single-doi":
            # `works/{doi}` answers with one work, not a list of items. Reading it as a list is what would
            # turn a found DOI into "the provider returned no result list".
            rows = [message] if isinstance(message, dict) and message.get("DOI") else []
            meta = {"totalResults": len(rows)}
        else:
            rows, meta = message.get("items"), {"totalResults": message.get("total-results")}
    else:
        rows = payload.get("data") if isinstance(payload, dict) else None
        meta = {"totalResults": payload.get("total") if isinstance(payload, dict) else None}
    if not isinstance(rows, list):
        raise ResearchError("PROVIDER_SCHEMA_UNEXPECTED", f"{provider} response did not contain a result list.")
    fetched_at = budget.get("retrievedAt") or datetime.now(UTC).isoformat()
    normalized: list[dict[str, Any]] = []
    skipped_rows = 0
    for row in rows[:limit]:
        if not isinstance(row, dict):
            skipped_rows += 1
            continue
        try:
            record = _normalize(provider, row, fetched_at, query_hash)
        except Exception:
            # One malformed row must not discard the provider's other results.
            skipped_rows += 1
            continue
        if not record["title"]["value"] and not record["doi"]["value"]:
            # A row with neither a title nor a DOI is unusable for a researcher: it is isolated
            # and reported instead of being shown as a result.
            skipped_rows += 1
            continue
        normalized.append(record)
    outcome = {"provider": provider, "state": "ok", "route": route,
               "reportedCount": meta.get("count", meta.get("totalResults")),
               "returned": len(normalized), "skippedRows": skipped_rows, "fromCache": bool(budget.get("fromCache")),
               "providerAttempts": budget.get("attempts"),
               "rateLimit": response_headers.get("x-rate-limit-limit"), "rateLimitInterval": response_headers.get("x-rate-limit-interval")}
    if skipped_rows:
        outcome["warnings"] = [f"PROVIDER_ROW_SKIPPED: {skipped_rows} malformed row(s) from {provider} were isolated; the remaining rows are returned."]
    return normalized, outcome


def _merge_exact_doi(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for record in records:
        doi = record["doi"]["value"]
        key = f"doi:{doi}" if doi else record["id"]
        if key not in merged:
            merged[key] = record
            continue
        current = merged[key]
        current["sourceIds"].update(record["sourceIds"])
        for attribution in record["attribution"]:
            if attribution not in current["attribution"]:
                current["attribution"].append(attribution)
        for field in ("title", "authors", "year", "date", "venue", "publicationType", "abstract", "url", "openAccessUrl", "license",
                      "dateField", "retracted", "citationCount", "referenceCount"):
            if field not in record or field not in current:
                continue
            incoming = record[field]
            existing = current[field]
            if incoming["value"] is None:
                continue
            existing_sources = existing["provenance"] if isinstance(existing["provenance"], list) else [existing["provenance"]]
            observations = existing.get("observations") or [{"value": existing["value"], "provenance": existing["provenance"]}]
            if field == "retracted" and incoming["value"] is True and existing["value"] is not True:
                # The one exception to "the first observed value stays displayed", and it is stated because
                # the generic rule below would display `False` whenever the provider whose route never carried
                # `updated-by` happened to answer first. A provider that names a retraction is never overridden
                # by a provider that has not seen the field: absence is not a refutation.
                observations = [*observations, {"value": True, "provenance": incoming["provenance"]}]
                current[field] = {"value": True, "provenance": incoming["provenance"], "observations": observations,
                                  "conflicts": [item["value"] for item in observations],
                                  "selectedReason": "a provider named a retraction; a provider that never carried the field cannot refute it"}
                continue
            if existing["value"] is None:
                current[field] = incoming
            elif existing["value"] == incoming["value"]:
                current[field] = {"value": existing["value"], "provenance": [*existing_sources, incoming["provenance"]], "observations": observations}
            else:
                # Documented selection rule: the first observed value stays displayed, and every
                # distinct provider observation is retained so no provider's evidence disappears.
                observations = [*observations, {"value": incoming["value"], "provenance": incoming["provenance"]}]
                current[field] = {"value": existing["value"], "provenance": [*existing_sources, incoming["provenance"]],
                                  "observations": observations, "conflicts": [item["value"] for item in observations]}
    for record in merged.values():
        _recompute_derived(record)
    return list(merged.values())


def _recompute_derived(record: dict[str, Any]) -> None:
    """Derived state follows the merged values, not the provider that happened to arrive first."""
    abstract = (record.get("abstract") or {}).get("value")
    record["evidenceScope"] = "abstract-only" if abstract else "metadata-only"
    open_access_url = (record.get("openAccessUrl") or {}).get("value")
    license_value = (record.get("license") or {}).get("value")
    record["access"] = {"status": "link-reported" if open_access_url else "unknown", "url": open_access_url, "license": license_value, "retrieved": False}


def search_literature(provider: str, query: str, limit: int = 10) -> dict[str, Any]:
    query = query.strip()
    if not query:
        raise ResearchError("QUERY_REQUIRED", "Enter a literature query.")
    if len(query) > 500:
        raise ResearchError("QUERY_TOO_LONG", "Literature queries are limited to 500 characters.")
    if not 1 <= limit <= MAX_RESULTS:
        raise ResearchError("RESULT_LIMIT_INVALID", f"limit must be between 1 and {MAX_RESULTS}.")
    providers = PROVIDERS if provider == "all" else (provider,)
    records: list[dict[str, Any]] = []
    outcomes: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    for selected in providers:
        if selected == "semantic_scholar" and os.environ.get("SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED", "").lower() != "true":
            exc = ResearchError("PROVIDER_TERMS_NOT_ACKNOWLEDGED", "Semantic Scholar is disabled until the current API license is reviewed and this process explicitly opts in.")
            errors.append({"provider": selected, **exc.as_dict()})
            if provider != "all":
                raise exc
            continue
        try:
            rows, outcome = _search_one(selected, query, limit)
            records.extend(rows)
            outcomes.append(outcome)
        except ResearchError as exc:
            errors.append({"provider": selected, **exc.as_dict()})
            if provider != "all":
                raise
    attempted = len(providers)
    succeeded = len(outcomes)
    merged = _merge_exact_doi(records)
    if succeeded == 0:
        result_state = "unavailable"
    elif succeeded < attempted:
        result_state = "partial"
    elif not merged:
        result_state = "empty"
    else:
        result_state = "complete"
    warnings = [
        "Records are merged only by normalized exact DOI; title similarity is never treated as identity.",
        "Open-access links are reported but no files are downloaded; a reported link is not a verified license.",
    ]
    if result_state == "unavailable":
        warnings.append("No provider answered. This is an outage or a configuration problem, not an empty result set.")
    if result_state == "empty":
        warnings.append("Every provider answered and returned no matching record.")
    if any(outcome.get("fromCache") for outcome in outcomes):
        warnings.append("At least one provider answer was served from the Toolkit's bounded cache; the provider was not asked again for that query.")
    for outcome in outcomes:
        if outcome.get("skippedRows"):
            warnings.extend(outcome.get("warnings", []))
    return {"queryHash": hashlib.sha256(query.encode("utf-8")).hexdigest(), "records": merged, "providers": outcomes, "errors": errors,
            "providersAttempted": attempted, "providersSucceeded": succeeded, "warnings": warnings, "resultState": result_state}


def validate_citation(doi_value: str) -> dict[str, Any]:
    doi = normalize_doi(doi_value)
    if not doi:
        return {"status": "unresolved", "input": doi_value, "reason": "Input is not a syntactically valid DOI. This does not establish whether a work exists."}
    url = f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='/') }"
    try:
        payload, _headers, budget = _provider_request("crossref", url, _crossref_headers(), cache_key=_query_hash("crossref-doi", doi))
    except ResearchError as exc:
        if exc.code == "PROVIDER_NOT_FOUND":
            return {"status": "unresolved", "doi": doi, "reason": "Crossref has no matching record. This is not proof that the DOI or work is invalid; it may be registered elsewhere or metadata may be incomplete."}
        raise
    work = payload.get("message") if isinstance(payload, dict) else None
    if not isinstance(work, dict):
        raise ResearchError("PROVIDER_SCHEMA_UNEXPECTED", "Crossref DOI response has no work object.")
    fetched_at = budget.get("retrievedAt") or datetime.now(UTC).isoformat()
    return {"status": "record-found", "doi": doi, "fromCache": bool(budget.get("fromCache")), "record": _normalize("crossref", work, fetched_at, _query_hash("crossref-doi", doi)), "interpretation": "Crossref metadata record found; this does not verify scientific claims or guarantee all bibliographic fields are correct."}


def _zotero_said(exc: Exception) -> str:
    """What the port actually answered, on one clipped line: for an HTTP answer its status, its reason line and
    the start of its body; for a transport failure, the name of what went wrong. The readiness receipt carries
    this so a report from another machine says which answer Zotero gave instead of leaving it to be guessed.
    """
    if isinstance(exc, urllib.error.HTTPError):
        try:
            body = exc.read(240).decode("utf-8", "replace")
        except Exception:  # a body this client cannot read is no reason to lose the status the operator needs
            body = ""
        return re.sub(r"\s+", " ", f"{exc.code} {exc.reason} {body}").strip()[:160]
    return f"{type(exc).__name__} {exc}".strip()[:160]


def _zotero_request(path: str, *, timeout: int, expect_json: bool = True, method: str = "GET", body: dict[str, Any] | list[dict[str, Any]] | None = None, body_is_list: bool = False, extra_headers: dict[str, str] | None = None, write: bool = False) -> tuple[Any, dict[str, str]]:
    """One bounded request to the fixed loopback Zotero port, and what the port said when it refused.

    A bare path is read under `/api`, so an empty path is `/api/` itself. A full URL is honoured only when it
    already names the reviewed loopback port, which is how the connector ping — a sibling of `/api` — reuses
    this one client. `Zotero-Allowed-Request` keeps the request from being dropped: Zotero 10 drops requests
    that look like browser requests without any response unless it is sent. The IPv4 loopback URL gives urllib
    a `Host` of `127.0.0.1:23119`, one of the three Zotero accepts. Every caller states its own `timeout`
    because the stages of one check are not equally cheap: Zotero answers the local API only after the library
    has loaded, so the listing waits far longer than the endpoints that answer before the preference is read.

    `body_is_list` is the caller's explicit statement of the JSON shape the endpoint wants, which is the fix
    for defect D1: measured 19 November 2026 (P1) against Zotero 10.0.8, `POST /api/users/0/collections` with
    one object answers `400 {"error":"Uploaded data must be a JSON array"}` and with an array `[{...}]` answers
    `200 {"success":{"0":"KEY"},"failed":{}}` — the same on `POST users/0/items`. `PUT` and `PATCH` are the
    opposite shape (P4: one object, 204). The shape is therefore a reviewed property of the request, not
    something inferred from what happened to be in the dict.
    """
    url = path if path.startswith(ZOTERO_LOOPBACK_ORIGIN) else f"{ZOTERO_LOCAL_API}/{path.lstrip('/')}"
    # Bypass proxy settings for this fixed loopback-only address.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler())
    headers = {"Accept": "application/json", "Zotero-API-Version": "3", "Zotero-Allowed-Request": "1", **(extra_headers or {})}
    payload: bytes | None = None
    if body is not None:
        if body_is_list and method != "POST":
            raise ResearchError("ZOTERO_REQUEST_BODY_SHAPE_INVALID", f"A JSON array body belongs to a POST. {method} on the local API takes one object (measured 19 November 2026: PUT/PATCH on an item answers 204 with an object body; POST users/0/collections answers 400 with one).")
        if body_is_list:
            payload = json.dumps(body if isinstance(body, list) else [body]).encode("utf-8")
        elif isinstance(body, list):
            raise ResearchError("ZOTERO_REQUEST_BODY_SHAPE_INVALID", "A list body was sent without `body_is_list`, so it would have been serialized as one object and answered 400 (P1). A POST states `body_is_list=True`.")
        else:
            payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ResearchError("ZOTERO_RESPONSE_TOO_LARGE", "Zotero response exceeded the 4 MiB safety limit.")
            headers = {key.lower(): value for key, value in response.headers.items()}
            if not expect_json:
                return raw.decode("utf-8", "replace"), headers
            # A write that changes something answers 204 with no body. That is a success, not a broken answer,
            # so it is not run through the JSON parser that a read needs.
            if not raw.strip():
                return None, headers
            document = json.loads(raw.decode("utf-8"))
            if not isinstance(document, (dict, list)):
                raise ResearchError("ZOTERO_SCHEMA_UNEXPECTED", "Zotero local API returned an unexpected response.")
            return document, headers
    except urllib.error.HTTPError as exc:
        said = _zotero_said(exc)
        if exc.code == 403 and "not allowed" in said.lower():
            raise ResearchError("ZOTERO_REQUEST_NOT_ALLOWED", "Zotero refused this request as one that looks like a browser request. No Zotero setting needs changing for this answer.", evidence=said) from exc
        if exc.code == 400:
            raise ResearchError("ZOTERO_REQUEST_REJECTED", "Zotero answered 400 and rejected this request itself. The port answered, so a Zotero is there; this request was not accepted.", evidence=said) from exc
        if exc.code == 401:
            # A read needs no authentication, so a 401 there means the request was not accepted. A write is the
            # one local API call that does ask for a key: 401 with `WWW-Authenticate: Zotero-API-Key` is Zotero
            # saying it has no authorized key for this client, which is a different fact and gets its own code.
            if write:
                raise ResearchError("ZOTERO_WRITE_KEY_MISSING", "Zotero refused this write because no local API write key was offered. Reads need no key; a write does, and only you can authorize one in Zotero.", evidence=said) from exc
            raise ResearchError("ZOTERO_AUTH_REQUIRED", "Something at 127.0.0.1:23119 answered 401, asking for authentication; a read needs none.", evidence=said) from exc
        if exc.code == 412:
            raise ResearchError("ZOTERO_WRITE_CONFLICT", "Zotero refused this write because the item changed since the version this request was built from. Nothing was overwritten.", evidence=said) from exc
        if exc.code == 428:
            raise ResearchError("ZOTERO_WRITE_VERSION_REQUIRED", "Zotero refused this write because it carried no version guard. The Toolkit sends one on every write; a client that does not is refused.", evidence=said) from exc
        if exc.code == 501:
            raise ResearchError("ZOTERO_API_VERSION_UNSUPPORTED", "Zotero does not implement the API version this request asked for.", evidence=said) from exc
        code = "ZOTERO_API_DISABLED" if exc.code == 403 else "ZOTERO_NOT_FOUND" if exc.code == 404 else "ZOTERO_REQUEST_FAILED"
        raise ResearchError(code, "Zotero local API request failed. Confirm Zotero is running and local API access is enabled.", evidence=said) from exc
    except urllib.error.URLError as exc:
        # A refused connection and a request that got no answer are different facts, and the probe says so.
        if isinstance(exc.reason, ConnectionRefusedError):
            raise ResearchError("ZOTERO_NOT_AVAILABLE", "Nothing answered at 127.0.0.1:23119; no library files were opened.", evidence=_zotero_said(exc)) from exc
        raise ResearchError("ZOTERO_NO_ANSWER", f"The request to 127.0.0.1:23119 produced no usable answer within {timeout} seconds.", evidence=_zotero_said(exc)) from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ResearchError("ZOTERO_SCHEMA_UNEXPECTED", "Zotero answered, but not with the JSON its local API returns.", evidence=_zotero_said(exc)) from exc
    except (http.client.HTTPException, OSError) as exc:
        # Closed mid-answer, half-answered, or out of time: the port answered nothing usable, which is a state.
        raise ResearchError("ZOTERO_NO_ANSWER", f"The request to 127.0.0.1:23119 produced no usable answer within {timeout} seconds.", evidence=_zotero_said(exc)) from exc


def zotero_local_api_root() -> dict[str, Any]:
    """Ask the documented root, `/api/`, first: its answer settles the local-API preference.

    A 403 here is the documented answer for the preference being off; `Zotero-Server-ID` proves a Zotero answered.
    """
    _, headers = _zotero_request("", timeout=ZOTERO_ROOT_TIMEOUT_SECONDS, expect_json=False)
    return {"status": 200, **headers}


def zotero_collections_head() -> dict[str, Any]:
    """`HEAD /api/users/0/collections`: the path answered, independently of the local-API preference.

    Zotero's own server answers a HEAD on a registered local-API path before it consults the preference, so a
    200 here says the path is registered and the Host header was accepted. That separates "this Zotero has no
    local API endpoint" from "the endpoint is there and the preference is off", which the GET alone cannot tell.
    """
    _, headers = _zotero_request("users/0/collections", timeout=ZOTERO_ROOT_TIMEOUT_SECONDS, expect_json=False, method="HEAD")
    return {"status": 200, **headers}


def zotero_connector_ping() -> bool:
    """Did Zotero's connector endpoint answer? It is not gated on the local-API preference.

    Fallback evidence for a request that got no answer, never an extra request when one arrived: the same
    loopback-only, proxy-bypassing, no-redirect client, reached by path, on its own 3 second bound. The answer
    is a short HTML page saying Zotero is running, so only the fact that it answered counts. A refused
    connection, or a request that got no answer at all, does not.
    """
    try:
        _zotero_request(ZOTERO_CONNECTOR_PING, timeout=ZOTERO_PING_TIMEOUT_SECONDS, expect_json=False)
        return True
    except ResearchError as exc:
        return exc.code not in ("ZOTERO_NOT_AVAILABLE", "ZOTERO_NO_ANSWER")


# The local API answers at most 100 rows per request, which is what 0.3.13 asked for and then treated as the
# whole library. The listing is paged instead, and the bound is reported instead of being assumed away (defect,
# 22 November 2026: `collectionCount` was stated as fact while the read could only have answered 100).
ZOTERO_COLLECTION_PAGE_LIMIT = 100
ZOTERO_COLLECTION_MAX_PAGES = 10


def _zotero_total_results(headers: dict[str, str], returned: int, endpoint: str) -> tuple[str | None, bool]:
    """Zotero's own total for a listing, and whether what came back falls short of it.

    A `Total-Results` header that is not a number is named, not guessed at: 0.3.13 ran `int(total)` and a
    malformed header raised a bare `ValueError` out of a read the tool layer only catches as `ResearchError`
    (defect, 22 November 2026).
    """
    raw = headers.get("zotero-total-results")
    if raw is None:
        return None, False
    total = _zotero_header_int(raw)
    if total is None:
        raise ResearchError("ZOTERO_TOTAL_RESULTS_INVALID", f"Zotero answered `Total-Results: {raw!r}` for {endpoint}, which is not a number, so this read cannot say whether it stopped early. The {returned} records it did answer are not presented as the whole answer.", evidence=None)
    return str(total), total > returned


def list_zotero_collections() -> dict[str, Any]:
    """Every collection this Zotero lists, with the numbers it reports and the path its parent chain spells.

    A name is not an identifier (P2, measured 19 November 2026: two collections with the same name are two
    different collections with two different keys), so the key stays the identity while `numItems` and
    `numCollections` are Zotero's own counts and `path` is spelled from `parentCollection` (P3) — the two
    fields 0.3.13 read and then threw away (defect D4). `collectionCount` is what `zotero_library_status`
    needs before a filing, and `path` is what tells an operator which `projekty` a filing lands in.
    """
    collections: list[dict[str, Any]] = []
    by_key: dict[str, dict[str, Any]] = {}
    server_id: str | None = None
    total_results: str | None = None
    truncated = True
    for page in range(ZOTERO_COLLECTION_MAX_PAGES):
        # `start` is left off the first page: `start=0` is what the local API assumes anyway, and the request a
        # reviewed test pins is the one-page request a library of this size actually needs.
        query = f"users/0/collections?limit={ZOTERO_COLLECTION_PAGE_LIMIT}&format=json" if page == 0 else f"users/0/collections?limit={ZOTERO_COLLECTION_PAGE_LIMIT}&start={page * ZOTERO_COLLECTION_PAGE_LIMIT}&format=json"
        payload, headers = _zotero_request(query, timeout=ZOTERO_LISTING_TIMEOUT_SECONDS)
        rows = payload if isinstance(payload, list) else []
        server_id = headers.get("zotero-server-id") or server_id
        total_results = headers.get("zotero-total-results") or total_results
        for row in rows:
            if not isinstance(row, dict):
                continue
            data = row.get("data") or {}
            entry = {
                "key": str(row.get("key") or ""),
                "name": data.get("name"),
                "parentCollection": data.get("parentCollection"),
                "numItems": data.get("numItems"),
                "numCollections": data.get("numCollections"),
            }
            by_key[entry["key"]] = entry
            collections.append(entry)
        total_number = _zotero_total_results(headers, len(collections), "users/0/collections")[1]
        if len(rows) < ZOTERO_COLLECTION_PAGE_LIMIT and not total_number:
            truncated = False
            break
    for entry in collections:
        entry["path"] = _zotero_collection_path(entry, by_key)
    return {
        "collections": collections,
        "collectionCount": len(collections),
        "returnedCount": len(collections),
        "totalCount": total_results,
        "truncated": truncated,
        "serverId": server_id,
        "readOnly": True,
        "note": "The count is what this read answered. `truncated` says whether that is the whole library: `ensure_collection` and `add_to_collection` refuse to match names over a partial listing, because half a census cannot tell an operator whether a name is unique (P2).",
    }


def _zotero_collection_path(entry: dict[str, Any], by_key: dict[str, dict[str, Any]]) -> str:
    """Spell one collection's place in the tree from `parentCollection`, which P3 measured to be the parent key."""
    parts = [str(entry.get("name") or "")]
    seen = {str(entry.get("key") or "")}
    parent = entry.get("parentCollection")
    for _ in range(10):  # a collection tree is not ten levels deep in practice; the bound is what keeps a cycle from looping
        if not isinstance(parent, str) or not parent:
            break
        if parent in seen:
            parts.append("(cycle)")
            break
        ancestor = by_key.get(parent)
        if ancestor is None:
            parts.append(f"?{parent}")  # the parent exists but was outside the 100 collections this listing read
            break
        parts.append(str(ancestor.get("name") or ""))
        seen.add(parent)
        parent = ancestor.get("parentCollection")
    return " / ".join(reversed(parts))


def zotero_collection_items(key: str, limit: int = 100) -> dict[str, Any]:
    """Read what is in one collection — the only way the local API answers that question.

    Measured 19 November 2026 (P5): `GET /collections/<key>/items` → 200, and it answers with the items AND
    their notes (43 items → 93 records), while `GET /items?collection=<key>` is IGNORED and answers with the
    whole library and `?noCollections=1` is ignored too. So the notes are reported apart: a bibliography that
    counted `returned` would count 50 child notes as 50 works. `members` is the membership fact — records
    whose own `data.collections` carries this key, notes excluded.
    """
    if not ZOTERO_ITEM_KEY_PATTERN.fullmatch(key):
        raise ResearchError("ZOTERO_COLLECTION_KEY_INVALID", "Zotero collection keys must be eight uppercase letters or digits.")
    bounded = max(1, min(int(limit), 100))
    document, headers = _zotero_request(f"users/0/collections/{key}/items?format=json&limit={bounded}", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS)
    rows = [row for row in (document if isinstance(document, list) else []) if isinstance(row, dict) and isinstance(row.get("data"), dict)]
    records = [_zotero_record(row) for row in rows]
    notes = [row for row in rows if str(row["data"].get("itemType")) in ZOTERO_NOTE_ITEM_TYPES or row["data"].get("parentItem")]
    members = [str(row.get("key")) for row in rows if key in (row["data"].get("collections") or []) and row not in notes]
    total, truncated_total = _zotero_total_results(headers, len(records), f"users/0/collections/{key}/items")
    return {
        "readOnly": True,
        "key": key,
        "items": records,
        "returned": len(records),
        "notesIncluded": len(notes),
        "members": members,
        "memberCount": len(members),
        "totalResults": total,
        "truncated": truncated_total,
        "serverId": headers.get("zotero-server-id"),
        "note": "The answer carries child notes as records of their own (P5: 43 items arrived as 93 records). `notesIncluded` says how many; `members` counts only the records whose own `data.collections` names this collection.",
    }


def zotero_collection_tags(key: str) -> dict[str, Any]:
    """Refuse a collection-scoped tag read instead of answering it with an empty list (defect D7).

    Measured 19 November 2026 (P5): `GET /collections/<key>/tags` → 404 on Zotero 10.0.8. An empty list would
    read as "this collection has no tags", which is a claim the port never made, so the refusal is made here,
    before any request, and names the tag reads that do exist.
    """
    if not ZOTERO_ITEM_KEY_PATTERN.fullmatch(key):
        raise ResearchError("ZOTERO_COLLECTION_KEY_INVALID", "Zotero collection keys must be eight uppercase letters or digits.")
    raise ResearchError("ZOTERO_COLLECTION_TAGS_UNSUPPORTED", f"Tags cannot be read for one collection. Measured 19 November 2026 against Zotero 10.0.8: GET /collections/{key}/tags answers 404. Read tags from `zotero_library(action=\"status\")`, which counts the library's tags, or from each item's own record. No request was made.")


def get_zotero_item(key: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Z0-9]{8}", key):
        raise ResearchError("ZOTERO_ITEM_KEY_INVALID", "Zotero item keys must be eight uppercase letters or digits.")
    payload, headers = _zotero_request(f"users/0/items/{key}?format=json", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS)
    if not isinstance(payload, dict):
        raise ResearchError("ZOTERO_SCHEMA_UNEXPECTED", "Zotero local API item response was not an object.")
    return {"item": payload, "serverId": headers.get("zotero-server-id"), "readOnly": True}


# --- Zotero library reading and controlled writing (0.3.13, phase 14) ---
# Measured by the operator against a real Zotero 10.0.8 on 14 November 2026 and confirmed against
# https://www.zotero.org/support/dev/web_api/v3/local_api: a write needs a key the operator authorized in
# Zotero itself; a write with no version guard is refused with 428; a write that races a change the
# operator made in the meantime is refused with 412. The Toolkit never calls `/api/local/authorize`, never
# reads the file Zotero keeps its keys in, and never returns a key value to a caller.
ZOTERO_WRITE_KEY_ENV = "RESEARCH_STACK_ZOTERO_WRITE_KEY"
# A literal the caller must reproduce exactly. A boolean named `dryRun` would be a suggestion the model can
# drop; a required string is a gate (DD14-04).
ZOTERO_WRITE_CONFIRM = "write-to-zotero"
# The number of operations one batch carries, and how many batches one write may carry. 0.3.15 kept 25 as the
# reviewable size of one batch but made it a batch limit instead of a limit on the whole write: the operator
# filed 43 items on 19 November 2026 (P9), which is two batches, and a Toolkit that refused the list outright
# left a 43-item filing to be hand-split by the caller with no record of where the split was (defect D8).
ZOTERO_WRITE_MAX_OPERATIONS = 25
ZOTERO_WRITE_MAX_BATCHES = 4
ZOTERO_TAG_MAX_LENGTH = 64
# The facets `references/zotero-vocabulary.md` defines. A tag outside them is refused before it reaches the
# library, because an unbounded vocabulary decays into dozens of near-identical tags.
ZOTERO_TAG_FACETS = ("access/", "topic/", "type/", "status/")
ZOTERO_WRITE_OPS = ("add_tags", "add_to_collection", "create_collection", "create_item", "ensure_collection", "remove_tags", "set_item_type", "update_fields")
# Named so the refusal says why: the local API has no merge endpoint and no restore, so a delete cannot be
# undone by the Toolkit (DD14-07), and duplicate detection is UI-only in Zotero.
ZOTERO_REFUSED_OPS = ("delete", "delete_item", "duplicate_check", "merge")
ZOTERO_EXPORT_FORMATS = ("csljson", "bibtex", "biblatex", "csv")
ZOTERO_ITEM_KEY_PATTERN = re.compile(r"[A-Z0-9]{8}")
# `collections` is deliberately NOT in this list. Membership is not a field this Toolkit edits as a plain
# item field: measured 19 November 2026 (P4), filing is set by `PUT`/`PATCH` on the ITEM with
# `collections:[key]` → 204, `POST /collections/<key>/items` answers 405, and `PATCH` on a document NOTE with
# `collections` answers 500. `add_to_collection` owns that one field, its key validation, its note guard and
# its plan-shape guard; an attempt to write `collections` through `update_fields` is refused as a field the
# Toolkit does not write (defect D9).
ZOTERO_WRITABLE_FIELDS = frozenset({"title", "creators", "date", "itemType", "abstractNote", "DOI", "url", "extra", "libraryCatalog", "publisher", "volume", "issue", "pages", "accessDate", "shortTitle", "language"})
ZOTERO_STATUS_ENDPOINTS = ("api-root", "collections", "items", "tags", "searches", "fulltext", "itemTypes")
# The actions `zotero_library` answers, in one place so the dispatcher and the message that enumerates them
# cannot drift apart (defect D4).
ZOTERO_LIBRARY_ACTIONS = ("status", "collections", "collection_items", "item", "search", "fulltext", "export")
# Not an action, and not a request either: measured 19 November 2026 (P5), `GET /collections/<key>/tags`
# answers 404 on Zotero 10.0.8. The dispatcher still recognises the name so a caller who asks for it is
# answered with that fact instead of with an empty list that reads as "this collection has no tags".
ZOTERO_UNSUPPORTED_LIBRARY_ACTIONS = ("collection_tags",)
# Zotero's own special collections (defect D7). Measured 19 November 2026 (P8): the local API does not see
# them at all — `GET /collections/<key>` answers 404 — so a collection carrying one of these names is an
# imitation with its own key, never My Publications. The names are refused exactly, case-sensitive, because
# `projekty / My Publications` is a filing decision the operator made, not a spelling accident.
ZOTERO_RESERVED_COLLECTION_NAMES = frozenset({"My Publications", "Unfiled Items", "Duplicate Items", "Retracted Items", "New Items", "Feed Documents"})
# Measured 19 November 2026 (P4): a document NOTE is a child record, and a write that puts `collections` on it
# answers 500. It is filed through its parent item, which the Toolkit does not do silently.
ZOTERO_NOTE_ITEM_TYPES = frozenset({"note"})


def zotero_write_key_present() -> bool:
    """Whether the operator put a write key in this worker's environment. The value is never read out."""
    return bool(os.environ.get(ZOTERO_WRITE_KEY_ENV, "").strip())


def _zotero_write_headers(*, version: int | None = None) -> dict[str, str]:
    key = os.environ.get(ZOTERO_WRITE_KEY_ENV, "").strip()
    if not key:
        raise ResearchError("ZOTERO_WRITE_KEY_MISSING", "No Zotero write key is configured for this worker. Reads need none; a write needs one you authorized in Zotero. See guides/zotero-local-api.md.")
    headers = {"Zotero-API-Key": key}
    if version is not None:
        headers["If-Unmodified-Since-Version"] = str(version)
    return headers


def _zotero_probe(name: str, path: str, *, timeout: int = ZOTERO_ROOT_TIMEOUT_SECONDS, expect_json: bool = True, method: str = "GET") -> dict[str, Any]:
    """One readiness probe that reports its own failure instead of ending the whole status read.

    The local API states no rate limit and nothing leaves the machine, so asking seven small questions is
    how the Toolkit can say which endpoint this Zotero answers rather than guessing from one answer.
    """
    try:
        document, headers = _zotero_request(path, timeout=timeout, expect_json=expect_json, method=method)
    except ResearchError as exc:
        return {"endpoint": name, "state": "refused", "code": exc.code, "said": exc.evidence}
    record: dict[str, Any] = {"endpoint": name, "state": "answered"}
    if headers.get("zotero-total-results"):
        record["totalResults"] = headers["zotero-total-results"]
    if headers.get("zotero-server-id"):
        record["serverId"] = headers["zotero-server-id"]
    if isinstance(document, list):
        record["returned"] = len(document)
    elif isinstance(document, dict):
        record["returned"] = len(document)
    return record


def zotero_library_status(*, fulltext_probe: str = "zotero") -> dict[str, Any]:
    """What this Zotero answers right now, and how much the library actually holds."""
    probes = [
        _zotero_probe("api-root", "", expect_json=False),
        _zotero_probe("collections", "users/0/collections", method="HEAD", expect_json=False),
        _zotero_probe("items", "users/0/items?limit=1&format=json"),
        _zotero_probe("tags", "users/0/tags?limit=100&format=json"),
        _zotero_probe("searches", "users/0/searches?limit=100&format=json"),
        _zotero_probe("fulltext", f"users/0/fulltext?since=0&q={urllib.parse.quote(fulltext_probe)}"),
        _zotero_probe("itemTypes", "itemTypes"),
    ]
    answered = {probe["endpoint"] for probe in probes if probe["state"] == "answered"}
    counts: dict[str, Any] = {}
    for probe in probes:
        if probe["endpoint"] == "items" and probe.get("totalResults"):
            counts["items"] = probe["totalResults"]
        if probe["endpoint"] == "tags" and "returned" in probe:
            counts["tags"] = probe["returned"]
        if probe["endpoint"] == "searches" and "returned" in probe:
            counts["savedSearches"] = probe["returned"]
    fulltext = next((probe for probe in probes if probe["endpoint"] == "fulltext"), {})
    # One more small loopback read, for a number the HEAD probe cannot give (defect D4). The `collections`
    # probe above stays a HEAD because a HEAD answers before Zotero consults the local-API preference and so
    # separates "endpoint missing" from "endpoint switched off"; a HEAD carries no body and therefore no
    # count. A list read is the only honest source of `collectionCount`, and it is also the read that names
    # the collections a filing would target — which `ensure_collection` and `add_to_collection` need anyway.
    try:
        listing = list_zotero_collections()
    except ResearchError as exc:
        collection_count = None
        collection_note = f"Collection count was not read: {exc.code}."
    else:
        collection_count = listing["collectionCount"]
        collection_note = None
    if collection_count is not None:
        counts["collectionCount"] = collection_count
    return {
        "readOnly": True,
        "endpoints": probes,
        "answeredEndpoints": sorted(answered),
        "counts": counts,
        "collectionNote": collection_note,
        # An empty full-text answer does not distinguish "the index is empty" from "nothing matched this
        # word", and the Toolkit says so instead of reporting an empty index as a fact.
        "fullTextProbe": {"matches": fulltext.get("returned"), "note": "A zero-answer means no match for this probe word; it is not proof that the full-text index is empty."},
        "writeKeyPresent": zotero_write_key_present(),
        "serverId": next((probe.get("serverId") for probe in probes if probe.get("serverId")), None),
        # `false` would be a claim about a library this probe could not read. An unanswered item count is
        # reported as unknown, not as "not empty".
        "libraryEmpty": (counts.get("items") in ("0", 0)) if "items" in counts else None,
    }


def search_zotero_items(query: str, limit: int = 25) -> dict[str, Any]:
    """Search the local library by keyword through the local API, with the same record shape every read returns."""
    if not query or not query.strip():
        raise ResearchError("ZOTERO_QUERY_EMPTY", "A library search needs a query.")
    bounded = max(1, min(int(limit), 100))
    document, headers = _zotero_request(f"users/0/items?q={urllib.parse.quote(query.strip())}&format=json&limit={bounded}", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS)
    rows = document if isinstance(document, list) else []
    items = [_zotero_record(row) for row in rows if isinstance(row, dict) and isinstance(row.get("data"), dict)]
    total, truncated_total = _zotero_total_results(headers, len(items), "users/0/items?q=…")
    return {"readOnly": True, "query": query.strip(), "items": items, "returned": len(items), "totalResults": total, "truncated": truncated_total, "serverId": headers.get("zotero-server-id")}


def _zotero_record(row: dict[str, Any]) -> dict[str, Any]:
    data = row.get("data") or {}
    return {
        "key": row.get("key"),
        "version": row.get("version"),
        "itemType": data.get("itemType"),
        "title": data.get("title"),
        "creators": [creator.get("name") or f"{creator.get('lastName', '')}, {creator.get('firstName', '')}".strip(", ") for creator in data.get("creators") or [] if isinstance(creator, dict)],
        "date": data.get("date"),
        "DOI": data.get("DOI"),
        "url": data.get("url"),
        "tags": [tag.get("tag") for tag in data.get("tags") or [] if isinstance(tag, dict)],
        "collections": data.get("collections") or [],
    }


def zotero_fulltext(*, key: str = "", query: str = "") -> dict[str, Any]:
    """Read stored full text through the two endpoints the local API already has; no new service is called."""
    if key:
        if not ZOTERO_ITEM_KEY_PATTERN.fullmatch(key):
            raise ResearchError("ZOTERO_ITEM_KEY_INVALID", "Zotero item keys must be eight uppercase letters or digits.")
        document, headers = _zotero_request(f"users/0/items/{key}/fulltext", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS, expect_json=False)
        text = document if isinstance(document, str) else ""
        return {"readOnly": True, "key": key, "fullTextAvailable": bool(text.strip()), "characters": len(text), "text": text[:200_000], "serverId": headers.get("zotero-server-id")}
    if not query.strip():
        raise ResearchError("ZOTERO_QUERY_EMPTY", "A full-text search needs a query, or an item key to read one item.")
    document, headers = _zotero_request(f"users/0/fulltext?since=0&q={urllib.parse.quote(query.strip())}", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS)
    matches = document if isinstance(document, dict) else {}
    return {"readOnly": True, "query": query.strip(), "matches": [{"key": item_key, "characters": len(value) if isinstance(value, str) else None} for item_key, value in sorted(matches.items())], "note": "Zotero answers this only for text its own indexer stored. A zero-answer is not proof that no full text exists."}


# What the 19 November 2026 measurement says about notes in an export (P6). A format that was not measured
# gets a sentence saying it was not measured, which is not the same as being silent about notes.
ZOTERO_EXPORT_NOTE_MEASUREMENTS = {
    "csljson": "CSL-JSON carries document notes as records of their own: 93 records arrived for 43 items. A bibliography counted from this export counts 50 notes as 50 works.",
    "bibtex": "BibTeX carried no document notes: 43 records for the same 43 items.",
}


def zotero_export(fmt: str = "csljson", limit: int = 50, collection_key: str = "") -> dict[str, Any]:
    """Ask Zotero for its own export body, whole library or one collection. `markdown` and `counts` are not formats this API answers with.

    Defect D5: 0.3.13 could only export the whole library, and a whole-library export carries no membership
    at all (P6, measured 19 November 2026 — 43 items, 0 membership facts). With a collection key the export
    goes through `users/0/collections/<key>/items?format=…`, the path P5 measured to answer `format=`, and the
    result says which scope it is, which collection it came from, and that membership is still not in the body.
    """
    if fmt not in ZOTERO_EXPORT_FORMATS:
        raise ResearchError("ZOTERO_EXPORT_FORMAT_UNSUPPORTED", f"Zotero's local API exports {', '.join(ZOTERO_EXPORT_FORMATS)}. It refused markdown and counts in the 14 November 2026 measurement; a Markdown bibliography has to be generated from the records.", evidence=f"asked for {fmt}")
    bounded = max(1, min(int(limit), 100))
    scope = "library"
    collection_name: str | None = None
    path = f"users/0/items?format={fmt}&limit={bounded}"
    if collection_key:
        if not ZOTERO_ITEM_KEY_PATTERN.fullmatch(collection_key):
            raise ResearchError("ZOTERO_COLLECTION_KEY_INVALID", "Zotero collection keys must be eight uppercase letters or digits.")
        listing = list_zotero_collections()
        match = next((row for row in listing["collections"] if row.get("key") == collection_key), None)
        if match is None:
            raise ResearchError("ZOTERO_COLLECTION_NOT_FOUND", f"Nothing was exported: this Zotero does not list a collection {collection_key}. A special collection (My Publications, Unfiled Items, Duplicate Items) is invisible to the local API — GET /collections/<key> answers 404 (measured 19 November 2026) — so it cannot be exported through this path either.", evidence=f"{listing['collectionCount']} collection(s) listed")
        collection_name = match.get("name")
        scope = "collection"
        path = f"users/0/collections/{collection_key}/items?format={fmt}&limit={bounded}"
    document, headers = _zotero_request(path, timeout=ZOTERO_LISTING_TIMEOUT_SECONDS, expect_json=(fmt == "csljson"))
    body = document if isinstance(document, str) else json.dumps(document, ensure_ascii=False)
    return {
        "readOnly": True,
        "format": fmt,
        "characters": len(body),
        "body": body,
        "totalResults": headers.get("zotero-total-results"),
        # Measured 14 November 2026: CSL-JSON carries neither `extra` nor tags, so an access label cannot be
        # read out of this export. BibTeX carries `extra` as `annote`.
        "accessLabelsInExport": fmt in ("bibtex", "biblatex"),
        "scope": scope,
        "collectionKey": collection_key or None,
        "collectionName": collection_name,
        # P6: no export format this API answers with carries collection membership, not even the scoped one.
        # The membership fact lives in each item's `data.collections`, read through `collection_items`.
        "membershipInExport": False,
        "noteWarning": ZOTERO_EXPORT_NOTE_MEASUREMENTS.get(fmt) or f"The note behaviour of a {fmt} export was not measured: the 19 November 2026 measurement covers csljson and bibtex only.",
    }


def _zotero_tag_list(tags: Any) -> list[str]:
    if not isinstance(tags, list) or not tags or len(tags) > 25:
        raise ResearchError("ZOTERO_TAGS_INVALID", "A tag operation needs a list of 1 to 25 tags.")
    cleaned: list[str] = []
    for tag in tags:
        if not isinstance(tag, str) or not tag.strip() or len(tag.strip()) > ZOTERO_TAG_MAX_LENGTH:
            raise ResearchError("ZOTERO_TAG_OUT_OF_VOCABULARY", f"A tag must be 1-{ZOTERO_TAG_MAX_LENGTH} characters of text: {tag!r}.")
        value = tag.strip()
        if not value.startswith(ZOTERO_TAG_FACETS):
            raise ResearchError("ZOTERO_TAG_OUT_OF_VOCABULARY", f"Tags must come from the facets {', '.join(ZOTERO_TAG_FACETS)} defined in references/zotero-vocabulary.md. Refused: {value!r}.")
        cleaned.append(value)
    return cleaned


def _zotero_item_types() -> list[str]:
    document, _ = _zotero_request("itemTypes", timeout=ZOTERO_ROOT_TIMEOUT_SECONDS)
    rows = document if isinstance(document, list) else []
    return sorted({str(row.get("itemType")) for row in rows if isinstance(row, dict) and row.get("itemType")})


def _zotero_item_data(key: str) -> tuple[dict[str, Any], int]:
    if not ZOTERO_ITEM_KEY_PATTERN.fullmatch(key):
        raise ResearchError("ZOTERO_ITEM_KEY_INVALID", "Zotero item keys must be eight uppercase letters or digits.")
    document, _ = _zotero_request(f"users/0/items/{key}?format=json", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS)
    if not isinstance(document, dict) or not isinstance(document.get("data"), dict):
        raise ResearchError("ZOTERO_SCHEMA_UNEXPECTED", "Zotero did not return an item for that key.")
    return document["data"], int(document.get("version") or 0)


def _zotero_collection_name(name: Any) -> str:
    """Validate a collection name and refuse Zotero's own special-collection names (defect D7)."""
    cleaned = str(name or "").strip()
    if not cleaned or len(cleaned) > 200:
        raise ResearchError("ZOTERO_COLLECTION_NAME_INVALID", "A collection needs a name of 1-200 characters.")
    if cleaned in ZOTERO_RESERVED_COLLECTION_NAMES:
        raise ResearchError("ZOTERO_COLLECTION_NAME_RESERVED", f"{cleaned!r} is one of Zotero's own special collections ({', '.join(sorted(ZOTERO_RESERVED_COLLECTION_NAMES))}). The local API cannot see a special collection at all: GET /collections/<key> answers 404 (P8, measured 19 November 2026). A collection this Toolkit created with that name would carry a key of its own and be an imitation, not My Publications. No HTTP request was made.", evidence=None)
    return cleaned


def _zotero_plan_guard(step: dict[str, Any]) -> None:
    """Refuse, on the way into the plan, a request shape the measured Zotero cannot answer.

    `POST /collections/<key>/items` answers 405 (P4, measured 19 November 2026) and is the shape a filing
    instinct reaches for first. Membership is set on the ITEM — `PUT`/`PATCH …/items/<key>` with
    `collections:[key]` → 204 — which is what `add_to_collection` builds. The guard sits on the plan rather
    than on one caller so that a later operation cannot reintroduce the bad shape (defect D9).
    """
    method = str(step.get("method") or "")
    path = str(step.get("path") or "")
    if method == "POST" and re.fullmatch(r"users/0/collections/[A-Z0-9]{8}/items", path):
        raise ResearchError("ZOTERO_PLAN_SHAPE_INVALID", "A write step tried to POST users/0/collections/<key>/items. Measured 19 November 2026 (P4): that request answers 405. A filing is a PUT on the item with `collections:[key]`, which is what `add_to_collection` builds.")
    if method in ("PUT", "PATCH") and isinstance(step.get("body"), list):
        raise ResearchError("ZOTERO_PLAN_SHAPE_INVALID", f"A {method} step carries a JSON array body. Measured (P1/P4): a POST takes an array, PUT and PATCH take one object.")
    if method == "POST" and step.get("bodyIsList") is not True:
        raise ResearchError("ZOTERO_PLAN_SHAPE_INVALID", "A POST step must state `bodyIsList: true`. With an object body the local API answers 400 \"Uploaded data must be a JSON array\" (P1, defect D1).")


def _zotero_plan_append(plan: list[dict[str, Any]], step: dict[str, Any]) -> dict[str, Any]:
    """The only way a step enters a plan: past the shape guard."""
    _zotero_plan_guard(step)
    plan.append(step)
    return step


def _zotero_collection_parent(name: str, plan: list[dict[str, Any]], rows: list[dict[str, Any]], planned: dict[str, dict[str, Any]], depth: int) -> tuple[str | None, int | None]:
    """Resolve a `parentCollection` given as a NAME: find it, or plan its own creation first.

    Returns the key when the parent is already in the library, or the plan position of the step that will
    create it — a key a parent creates cannot be known before that POST answers (P1: the key arrives in its
    `success` map), so the child says which step it comes from instead of inventing one.
    """
    if depth > 3:
        raise ResearchError("ZOTERO_COLLECTION_PARENT_DEPTH", "A `parentCollection` chain deeper than four collections is not planned. Name each level with its own `ensure_collection` operation so the operator sees every collection a write creates.")
    matches = [row for row in rows if row.get("name") == name]
    if len(matches) > 1:
        raise ResearchError("ZOTERO_COLLECTION_AMBIGUOUS", f"The parent name {name!r} matches {len(matches)} collections: {', '.join(sorted(str(row.get('key')) for row in matches))}. A name is not an identifier (P2), so no parent is chosen and nothing is planned. Give the parent by key.", evidence=f"{len(matches)} exact-name matches")
    if matches:
        return str(matches[0].get("key")), None
    already_planned = planned.get(name)
    if already_planned is not None:
        return None, plan.index(already_planned)
    _zotero_ensure_collection_step(name, parent_name="", plan=plan, rows=rows, planned=planned, depth=depth + 1)
    return None, plan.index(plan[-1])


def _zotero_ensure_collection_step(name: str, *, parent_name: str, plan: list[dict[str, Any]], rows: list[dict[str, Any]], planned: dict[str, dict[str, Any]], depth: int) -> None:
    """Plan one `ensure_collection`: take the collection that is already there, or create the missing one.

    An exact-name match is taken as it is (P2: a name is not an identifier), and several matches are named
    rather than guessed. A match that does not sit under the parent the operator named is an ambiguity, not a
    licence to create a second collection of the same name. A missing collection is a POST array
    `[{name, parentCollection}]` (P1/P3) whose key comes back in `success`.
    """
    clean = _zotero_collection_name(name)
    parent_key: str | None = None
    parent_from_step: int | None = None
    if parent_name:
        parent_key, parent_from_step = _zotero_collection_parent(parent_name, plan, rows, planned, depth)
    matches = [row for row in rows if row.get("name") == clean]
    elsewhere: list[str] = []
    if matches and parent_name:
        if parent_key is not None:
            elsewhere = sorted(str(row.get("key")) for row in matches if str(row.get("parentCollection") or "") != parent_key)
            matches = [row for row in matches if str(row.get("parentCollection") or "") == parent_key]
        elif matches:
            # The parent does not exist yet — this write is about to create it (P3). A collection already in the
            # library cannot sit under a parent that does not exist, so adopting the same-name match would leave
            # the operator's child beside the new parent rather than under it, and moving a collection is not
            # something `ensure_collection` was asked to do. Refused, with the two parents named (reviewed defect,
            # 22 November 2026: a root `projekt/krestanstvi` was adopted as existing while `projekty` was created).
            row = matches[0]
            actual = f"collection {row.get('parentCollection')}" if row.get("parentCollection") else "the library root"
            raise ResearchError(
                "ZOTERO_COLLECTION_PARENT_MISMATCH",
                f"{clean!r} already exists as {row.get('key')}, under {actual}. This write asked for it under {parent_name!r}, which does not exist yet and would be created by the same write, so the name does not identify one collection. `ensure_collection` does not re-parent a collection as a side effect. File into {row.get('key')} by key with `add_to_collection`, or name the parent {row.get('key')} really has.",
                evidence=f"{clean!r} found at {actual}; parent {parent_name!r} not in the library",
            )
    if len(matches) > 1:
        raise ResearchError("ZOTERO_COLLECTION_AMBIGUOUS", f"{len(matches)} collections carry the name {clean!r}: {', '.join(sorted(str(row.get('key')) for row in matches))}. A name is not an identifier (P2), so nothing is planned and no key is guessed. Target one by key with `add_to_collection`, or name a `parentCollection` that separates them.", evidence=f"{len(matches)} exact-name matches")
    if matches:
        row = matches[0]
        step = {
            "op": "ensure_collection", "action": "existing", "write": False, "method": None, "path": None, "body": None,
            "key": row.get("key"), "collectionKey": row.get("key"), "collectionName": clean, "name": clean,
            "collectionPath": row.get("path"), "undoable": False, "before": None, "changedFields": [],
            "note": f"Already there: {row.get('key')} ({row.get('path') or clean}). `ensure_collection` sends no request for it.",
        }
        if elsewhere:
            step["alsoNamedElsewhere"] = elsewhere
            step["note"] += f" {', '.join(elsewhere)} carry this name somewhere else; none of them is adopted or touched."
        _zotero_plan_append(plan, step)
        planned[clean] = plan[-1]
        return
    if parent_name and parent_key is None and parent_from_step is None:
        raise ResearchError("ZOTERO_COLLECTION_PARENT_NOT_FOUND", f"No collection {parent_name!r} exists and no step creates it, so {clean!r} has nowhere to be created.", evidence=None)
    body: list[dict[str, Any]] = [{"name": clean}]
    if parent_key:
        body[0]["parentCollection"] = parent_key
    step: dict[str, Any] = {
        "op": "ensure_collection", "action": "create", "write": True, "method": "POST", "path": "users/0/collections",
        "body": body, "bodyIsList": True, "key": None, "collectionKey": None, "collectionName": clean, "name": clean,
        "parentCollectionName": parent_name or None, "parentFromStep": parent_from_step,
        "undoable": False,
        "undoReason": "recorded as not undoable: this write created a collection and the Toolkit has no delete verb (DD14-07), so `undo` refuses this entry and names it. The snapshot is what a created collection can be checked against.",
        "before": None, "changedFields": [],
    }
    if parent_from_step is not None:
        step["bodyNote"] = f"`parentCollection` is filled in at apply time from the key step {parent_from_step} creates: a key cannot be known before that POST answers (P1: it arrives in the `success` map)."
    if elsewhere:
        # P2 again: the library can hold this name somewhere else. Creating it under the named parent is what
        # was asked for; the other collections of the same name are named so the operator sees them instead of
        # finding out afterwards that the Toolkit picked one.
        step["alsoNamedElsewhere"] = elsewhere
        step["note"] = f"This write creates {clean!r} under {parent_name!r}. The library also holds {', '.join(elsewhere)} under this name somewhere else; none of them is touched or adopted."
    planned[clean] = _zotero_plan_append(plan, step)


def _zotero_plan(changes: Any) -> list[dict[str, Any]]:
    """Turn the requested changes into the exact requests a write would send, reading what is there now.

    `preview` and `apply` share this one planner so that what the operator saw in the preview is the same
    body the apply sends. A plan that cannot be built is refused here, before any request is made.

    The body shape is a property of the plan, not something apply improvises: a POST to `…/collections` or
    `…/items` carries a JSON array — 0.3.13 sent one object and the local API answered 400, so neither
    `create_collection` nor `create_item` ever worked while the preview showed them as valid (defect D1, P1) —
    and a PUT on an item carries one object (P4). Every step passes `_zotero_plan_guard` on its way in.
    """
    if not isinstance(changes, list) or not changes:
        raise ResearchError("ZOTERO_WRITE_COUNT_INVALID", "A Zotero write takes at least one operation.")
    if len(changes) > ZOTERO_WRITE_MAX_OPERATIONS * ZOTERO_WRITE_MAX_BATCHES:
        raise ResearchError("ZOTERO_WRITE_COUNT_INVALID", f"A Zotero write takes 1 to {ZOTERO_WRITE_MAX_OPERATIONS * ZOTERO_WRITE_MAX_BATCHES} operations, sent in batches of at most {ZOTERO_WRITE_MAX_OPERATIONS}. `preview` reports `batchesNeeded` for the list you give it.")
    known_item_types: list[str] | None = None
    collection_rows: list[dict[str, Any]] | None = None
    planned_collections: dict[str, dict[str, Any]] = {}
    written_items: dict[str, int] = {}
    plan: list[dict[str, Any]] = []

    def collections() -> list[dict[str, Any]]:
        """The collections this Zotero lists, read at most once per plan (P2: identity is the key, not the name).

        A listing that stopped early is refused rather than used. Whether a name is unique, whether a named
        parent exists, and where a collection sits are questions about the whole library, and a partial census
        answers none of them — it would let `ensure_collection` create a second collection of a name that
        already exists past the bound (defect, 22 November 2026).
        """
        nonlocal collection_rows
        if collection_rows is None:
            listing = list_zotero_collections()
            if listing["truncated"]:
                raise ResearchError("ZOTERO_COLLECTION_LISTING_TRUNCATED", f"This Zotero reports {listing['totalCount']} collections and the listing stopped after {listing['returnedCount']}, so these names are not the library's names. `ensure_collection` and `add_to_collection` need the whole listing to tell whether a name is unique (P2) or which parent a collection has (P3). Name the collection by its key, which needs no census.", evidence=None)
            collection_rows = listing["collections"]
        return collection_rows

    for change in changes:
        if not isinstance(change, dict):
            raise ResearchError("ZOTERO_WRITE_OPERATION_INVALID", "Every Zotero write operation is an object with an `op`.")
        op = str(change.get("op") or "")
        if op in ZOTERO_REFUSED_OPS:
            raise ResearchError("ZOTERO_WRITE_ACTION_UNSUPPORTED", f"`{op}` is not offered: the local API has no merge endpoint and no restore, so the Toolkit cannot undo a delete or a merge. Do it in Zotero's own interface.")
        if op not in ZOTERO_WRITE_OPS:
            raise ResearchError("ZOTERO_WRITE_ACTION_UNSUPPORTED", f"Unknown Zotero write operation {op!r}. Offered: {', '.join(ZOTERO_WRITE_OPS)}.")
        if op == "create_collection":
            name = _zotero_collection_name(change.get("name"))
            body: list[dict[str, Any]] = [{"name": name}]
            parent = str(change.get("parentCollection") or "")
            if parent:
                if not ZOTERO_ITEM_KEY_PATTERN.fullmatch(parent):
                    raise ResearchError("ZOTERO_COLLECTION_PARENT_INVALID", "`parentCollection` on `create_collection` is the parent's 8-character key. Give a name to `ensure_collection`, which finds the parent or creates it first (P3: `data.parentCollection` returns the parent key).")
                if not any(row.get("key") == parent for row in collections()):
                    raise ResearchError("ZOTERO_COLLECTION_NOT_FOUND", f"No collection {parent} exists, so nothing was planned under it. Create the parent first, or use `ensure_collection` with `parentCollection` as a name.", evidence=None)
                body[0]["parentCollection"] = parent
            _zotero_plan_append(plan, {
                "op": op, "action": "create", "write": True, "method": "POST", "path": "users/0/collections",
                "body": body, "bodyIsList": True, "key": None, "collectionKey": None, "collectionName": name, "name": name,
                "undoable": False, "before": None, "changedFields": [],
                "undoReason": "recorded as not undoable: this write created a collection and the Toolkit has no delete verb (DD14-07), so `undo` refuses this entry and names it. The snapshot is what a created collection can be checked against.",
            })
            continue
        if op == "ensure_collection":
            # The reserved-name refusal is checked before the library is read, so asking for a special
            # collection sends no request at all (defect D7).
            _zotero_collection_name(change.get("name"))
            _zotero_ensure_collection_step(str(change.get("name") or ""), parent_name=str(change.get("parentCollection") or "").strip(), plan=plan, rows=collections(), planned=planned_collections, depth=0)
            continue
        if op == "create_item":
            title = str(change.get("title") or "").strip()
            if not title:
                raise ResearchError("ZOTERO_ITEM_TITLE_REQUIRED", "A created item needs a title.")
            item_type = str(change.get("itemType") or "document")
            known_item_types = known_item_types or _zotero_item_types()
            if known_item_types and item_type not in known_item_types:
                raise ResearchError("ZOTERO_ITEM_TYPE_UNKNOWN", f"Zotero does not list an item type {item_type!r}. It lists: {', '.join(known_item_types)}.", evidence=None)
            item_body: dict[str, Any] = {"itemType": item_type, "title": title}
            creators = change.get("creators") or []
            if not isinstance(creators, list):
                raise ResearchError("ZOTERO_CREATORS_INVALID", "Creators must be a list of names.")
            item_body["creators"] = [_zotero_creator(creator) for creator in creators]
            for field in ("date", "DOI", "url", "abstractNote", "extra", "publisher"):
                if change.get(field) is not None:
                    item_body[field] = str(change[field])
            if change.get("tags") is not None:
                item_body["tags"] = [{"tag": tag} for tag in _zotero_tag_list(change["tags"])]
            _zotero_plan_append(plan, {
                "op": op, "action": "create", "write": True, "method": "POST", "path": "users/0/items",
                "body": [item_body], "bodyIsList": True, "key": None, "undoable": False, "before": None, "changedFields": [],
                "undoReason": "recorded as not undoable: the local API has no restore for a created item",
            })
            continue
        data, version = _zotero_item_data(str(change.get("key") or ""))
        body = dict(data)
        collection_key: str | None = None
        if op == "set_item_type":
            item_type = str(change.get("itemType") or "")
            known_item_types = known_item_types or _zotero_item_types()
            if known_item_types and item_type not in known_item_types:
                raise ResearchError("ZOTERO_ITEM_TYPE_UNKNOWN", f"Zotero does not list an item type {item_type!r}. It lists: {', '.join(known_item_types)}.")
            body["itemType"] = item_type
        elif op == "update_fields":
            fields = change.get("fields")
            if not isinstance(fields, dict) or not fields:
                raise ResearchError("ZOTERO_WRITE_FIELDS_INVALID", "`update_fields` needs a `fields` object.")
            refused = sorted(set(fields) - ZOTERO_WRITABLE_FIELDS)
            if refused:
                raise ResearchError("ZOTERO_WRITE_FIELD_REFUSED", f"These item fields are not written by the Toolkit: {', '.join(refused)}. Tags and collections have their own operations.")
            body.update({name: value for name, value in fields.items()})
        elif op in ("add_tags", "remove_tags"):
            wanted = _zotero_tag_list(change.get("tags"))
            current = [tag.get("tag") for tag in data.get("tags") or [] if isinstance(tag, dict) and tag.get("tag")]
            merged = current if op == "remove_tags" else list(dict.fromkeys([*current, *wanted]))
            if op == "remove_tags":
                merged = [tag for tag in current if tag not in wanted]
            body["tags"] = [{"tag": tag} for tag in merged]
        else:  # add_to_collection
            collection_key = str(change.get("collectionKey") or "")
            if not ZOTERO_ITEM_KEY_PATTERN.fullmatch(collection_key):
                raise ResearchError("ZOTERO_COLLECTION_KEY_INVALID", "Zotero collection keys must be eight uppercase letters or digits.")
            row = next((item for item in collections() if item.get("key") == collection_key), None)
            if row is None:
                raise ResearchError("ZOTERO_COLLECTION_NOT_FOUND", f"No collection {collection_key} exists in this Zotero, so nothing was sent. Create it first with `ensure_collection`. A special collection (My Publications, Unfiled Items, Duplicate Items) is invisible to the local API — GET /collections/<key> answers 404 (P8) — and cannot be filed into from here.", evidence=None)
            if str(data.get("itemType")) in ZOTERO_NOTE_ITEM_TYPES or data.get("parentItem"):
                raise ResearchError("ZOTERO_NOTE_NOT_FILEABLE", f"{change.get('key')} is a document note. Measured 19 November 2026 (P4): PATCH on a note with `collections` answers 500, so a note is not filed directly — file the item the note belongs to ({data.get('parentItem') or 'its parent'}) and the note travels with it. No write request was made.", evidence=None)
            current = [str(item) for item in data.get("collections") or []]
            body["collections"] = list(dict.fromkeys([*current, collection_key]))
        changed = {name: value for name, value in body.items() if data.get(name) != value}
        step: dict[str, Any] = {
            "op": op, "action": "modify", "write": True, "key": str(change.get("key")), "method": "PUT",
            "path": f"users/0/items/{change.get('key')}", "body": body, "guard": version,
            "changedFields": sorted(changed), "undoable": True, "before": {name: data.get(name) for name in changed},
        }
        if collection_key:
            step["collectionKey"] = collection_key
            step["collectionName"] = next((item.get("name") for item in collections() if item.get("key") == collection_key), None)
        earlier = written_items.get(str(change.get("key")))
        if earlier is not None:
            # Two operations, one item. The plan read the item once, so this step's body and guard came from a
            # library the earlier step has already changed. The preview says so instead of showing two requests
            # that would answer 412 against each other (review 2).
            step["sameItemAsStep"] = earlier
            step["sameItemNote"] = f"Step {earlier} writes {change.get('key')} first in this write. A PUT replaces the whole item, so this step is sent as that step's body plus {', '.join(sorted(changed)) or 'no fields'}; its version guard is the version that step's response reports, not the one this plan read."
        written_items[str(change.get("key"))] = len(plan)
        _zotero_plan_append(plan, step)
    return plan


def _zotero_creator(creator: Any) -> dict[str, str]:
    if isinstance(creator, dict):
        return {key: str(value) for key, value in creator.items() if key in {"creatorType", "firstName", "lastName", "name"} and value is not None} or {"creatorType": "author", "name": str(creator)}
    text = str(creator).strip()
    if "," in text:
        family, _, given = text.partition(",")
        return {"creatorType": "author", "lastName": family.strip(), "firstName": given.strip()}
    return {"creatorType": "author", "name": text}


def zotero_write_preview(changes: Any) -> dict[str, Any]:
    """Everything a write would do, with nothing sent. This is the only action available without confirmation."""
    plan = _zotero_plan(changes)
    return {
        "dryRun": True,
        "zoteroModified": False,
        "planned": plan,
        "operationCount": len(plan),
        "operationsPerBatch": ZOTERO_WRITE_MAX_OPERATIONS,
        # D8: the batch split is stated where the operator can see it before authorizing. The 43-item filing
        # the operator ran on 19 November 2026 (P9) is two batches; 0.3.13 could only say "not allowed".
        "batchesNeeded": -(-len(plan) // ZOTERO_WRITE_MAX_OPERATIONS),
        # What one confirmation actually authorizes, stated rather than left to be inferred from a batch size.
        # 0.3.13 refused more than 25 operations per call; 0.3.15 sends a longer plan in batches of 25, so the
        # number the operator is agreeing to is the whole plan, not the batch (reviewed 22 November 2026).
        "authorizedOperations": len(plan),
        "maxOperationsPerAuthorization": ZOTERO_WRITE_MAX_OPERATIONS * ZOTERO_WRITE_MAX_BATCHES,
        "authorizationNote": f"confirm={ZOTERO_WRITE_CONFIRM!r} authorizes all {len(plan)} operations of this plan, sent in {-(-len(plan) // ZOTERO_WRITE_MAX_OPERATIONS)} batch(es) of at most {ZOTERO_WRITE_MAX_OPERATIONS}. The ceiling one authorization can cover is {ZOTERO_WRITE_MAX_OPERATIONS * ZOTERO_WRITE_MAX_BATCHES} operations; a longer list is refused with `ZOTERO_WRITE_COUNT_INVALID` before anything is sent.",
        "writeKeyPresent": zotero_write_key_present(),
        # D2: the preview names the answer apply will read back, so what the operator read and what the Toolkit
        # read are the same fact. Measured 19 November 2026 (P1, P4).
        "responseShapes": {
            "POST": "200 with {\"success\":{\"<position>\":\"<KEY>\"},\"failed\":{}} — an array body only; an object body answers 400 (P1). The key comes from `success`; anything in `failed` is reported as `serverFailures`.",
            "PUT": "204 with no body (P4). Membership arrives on the item, never on a collection request.",
            "no request": "An `ensure_collection` that found the collection already there plans no request at all.",
        },
        "notUndoable": [{"op": step.get("op"), "key": step.get("key"), "name": step.get("name") or step.get("collectionName"), "collectionName": step.get("collectionName"), "reason": step.get("undoReason") or "recorded as not undoable: the local API has no restore for a created item"} for step in plan if not step.get("undoable")],
        "nextStep": f"Apply with confirm={ZOTERO_WRITE_CONFIRM!r}. A snapshot of the library is taken first and its path is reported. Apply then re-reads the item count and, for every collection a step names, that collection's own `numItems` and the items whose `data.collections` carry its key; the result carries `countCheck` and `collectionCheck`, and a 200 or 204 on its own is not treated as proof (DD14-11).",
    }


def _zotero_header_int(value: Any) -> int | None:
    """Read a Zotero version header as a number, or say it was not one."""
    try:
        return int(str(value))
    except (TypeError, ValueError):
        return None


def zotero_collection_state(keys: list[str]) -> list[dict[str, Any]]:
    """Read each affected collection back, the way P5 says the API answers membership.

    `numItems` is Zotero's own number for the collection; `members` is what the membership path reports. Both
    are read after the write so that a 204 is checked against a library fact instead of being taken as one.
    """
    listing = {str(row.get("key")): row for row in list_zotero_collections()["collections"]}
    state: list[dict[str, Any]] = []
    for key in keys:
        row = listing.get(key) or {}
        read = zotero_collection_items(key)
        state.append({
            "key": key,
            "name": row.get("name"),
            "path": row.get("path"),
            "listed": key in listing,
            "numItems": row.get("numItems"),
            "numCollections": row.get("numCollections"),
            "members": read["members"],
            "memberCount": read["memberCount"],
            "recordsRead": read["returned"],
            "notesIncluded": read["notesIncluded"],
        })
    return state


def zotero_write_apply(changes: Any, *, confirm: str, resume_after: int = 0) -> dict[str, Any]:
    """Apply a previewed plan in batches of at most 25 operations, then read back what the write did.

    A 200 or 204 is not treated as proof (DD14-11), which 0.3.13 asserted without doing (defects D2, D3):
    a created key is read out of the server's own `success` map (P1), every entry of `failed` is reported, the
    library version is taken from the response, and every collection a step named is read back through
    `GET /collections/<key>/items` — the one path that answers membership (P5).

    A plan that stops partway raises with the item-level report attached to the error (`error.writeReport`,
    surfaced by the tool as `error.writeReport` too): which operations arrived, which did not, and the next
    batch `resume_after` would run. A 412 or 428 marks that report `blocked`, because the version guards the
    plan was built from no longer describe this library.
    """
    if confirm != ZOTERO_WRITE_CONFIRM:
        raise ResearchError("WRITE_CONFIRM_REQUIRED", f"A Zotero write needs confirm={ZOTERO_WRITE_CONFIRM!r}. Run `preview` first and read it.")
    plan = _zotero_plan(changes)
    if isinstance(resume_after, bool) or not isinstance(resume_after, int) or resume_after < 0 or resume_after > len(plan):
        raise ResearchError("ZOTERO_WRITE_RESUME_INVALID", f"`resume_after` is how many operations an earlier apply already reported as applied: 0 to {len(plan) - 1} for this plan. It is the number the earlier report's `nextBatch.resumeAfter` named.")
    if resume_after == len(plan):
        # An authorization that sends nothing is not a completed write, and journaling it would make it look
        # like one. The number that skips every operation is the number that says the write is already over.
        raise ResearchError("ZOTERO_WRITE_NOTHING_TO_APPLY", f"`resume_after={resume_after}` leaves no operation to send for this plan of {len(plan)}. The earlier apply reported what it applied; nothing here would be added to it. Re-run `preview` to plan against the library as it is now.")
    batches_needed = -(-len(plan) // ZOTERO_WRITE_MAX_OPERATIONS)
    applied: list[dict[str, Any]] = []
    created_keys: list[str] = []
    server_failures: list[dict[str, Any]] = []
    collection_keys: list[str] = []
    created_by_name: dict[str, str] = {}
    library_version: int | None = None
    # What this write has already changed, item by item: the version each write's own response reported. A
    # second operation on the same item is guarded by that, not by the single plan-time read (defect, 22 November 2026).
    versions_by_key: dict[str, int | None] = {}
    guard_from_step: dict[str, int] = {}
    bodies_by_key: dict[str, tuple[int, dict[str, Any]]] = {}
    applied_fields_by_key: dict[str, set[str]] = {}

    def describe(index: int, step: dict[str, Any]) -> dict[str, Any]:
        return {"index": index, "batch": index // ZOTERO_WRITE_MAX_OPERATIONS + 1, "op": step.get("op"), "key": step.get("key"), "collectionName": step.get("collectionName")}

    def stop(index: int, exc: ResearchError) -> None:
        """Say which operations arrived, which did not, and what the next batch would be — then refuse the rest."""
        remaining = list(range(index, len(plan)))
        report: dict[str, Any] = {
            "applied": list(applied),
            "notApplied": [describe(i, plan[i]) for i in remaining],
            "stoppedAtIndex": index,
            "stoppedBatch": index // ZOTERO_WRITE_MAX_OPERATIONS + 1,
            "batchesNeeded": batches_needed,
            "operationsPerBatch": ZOTERO_WRITE_MAX_OPERATIONS,
            "createdKeys": sorted(set(created_keys)),
            "serverFailures": list(server_failures),
            "libraryVersion": library_version,
            "nextBatch": {
                "resumeAfter": index,
                "batchesRemaining": -(-len(remaining) // ZOTERO_WRITE_MAX_OPERATIONS),
                "operations": [describe(i, plan[i]) for i in remaining[:ZOTERO_WRITE_MAX_OPERATIONS]],
                "note": "Apply again with `resume_after` set to `resumeAfter` and the same `changes` list: these are the operations that were not sent. An applied step is not sent again blindly — its version guard came from a library that has since changed.",
            },
        }
        if exc.code in ("ZOTERO_WRITE_CONFLICT", "ZOTERO_WRITE_VERSION_REQUIRED"):
            report["blocked"] = {
                "code": exc.code,
                "condition": "the library version this plan was built from is not the library's version any more",
                "blocksNextApply": True,
                "until": "re-read the library: `zotero_write(action=\"snapshot\")`, then `preview` again, then apply the new plan",
            }
        if collection_keys:
            try:
                report["collectionState"] = zotero_collection_state(sorted(set(collection_keys)))
            except ResearchError as read_exc:
                report["collectionStateNote"] = f"The read-back after the interruption did not complete: {read_exc.code}."
        exc.report = report
        raise exc

    for index in range(resume_after, len(plan)):
        step = plan[index]
        batch = index // ZOTERO_WRITE_MAX_OPERATIONS + 1
        if step.get("write") is False:
            # `ensure_collection` found the collection already there. It planned no request and sends none.
            applied.append({**describe(index, step), "request": False, "action": step.get("action"), "method": None, "version": None, "created": False, "undoable": False, "before": None, "changedFields": [], "collectionKey": step.get("collectionKey"), "collectionName": step.get("collectionName"), "note": step.get("note")})
            collection_keys.append(str(step.get("collectionKey")))
            continue
        body: Any = step["body"]
        if step.get("parentFromStep") is not None and isinstance(body, list) and body:
            parent_name = str(step.get("parentCollectionName") or "")
            parent_key = created_by_name.get(parent_name)
            if not parent_key:
                stop(index, ResearchError("ZOTERO_COLLECTION_PARENT_UNRESOLVED", f"The step that was to create the parent collection {parent_name!r} produced no key, so {step.get('collectionName')!r} was not created loose. Nothing was sent for this operation.", evidence=None))
            body = [{**body[0], "parentCollection": parent_key}]
        guard = step.get("guard")
        guard_source = "snapshot"
        step_key = str(step.get("key") or "")
        if step.get("method") in ("PUT", "PATCH") and step_key and step_key in versions_by_key:
            # Two operations on one item in one authorized write (reviewed defect, 22 November 2026). The plan
            # read the item once, so both steps carry the same `If-Unmodified-Since-Version`; the first write
            # moves the item's version and the second would answer 412 while the first stays applied. The guard
            # is taken from the version this library actually reported for that item, because that is the version
            # the second request is allowed to claim. Without a reported version the step is refused before it is
            # sent rather than sent unguarded, which Zotero answers with 428.
            fresh = versions_by_key[step_key]
            if fresh is None:
                stop(index, ResearchError("ZOTERO_WRITE_VERSION_UNKNOWN", f"Step {index} ({step.get('op')}) is the second write to item {step_key} in this authorization, and the earlier write to it reported no version to build a guard from. Nothing was sent for this operation. Re-snapshot and preview to finish the rest.", evidence=None))
            guard, guard_source = fresh, f"the version step {guard_from_step[step_key]} reported for {step_key}"
        if step.get("method") in ("PUT", "PATCH") and step_key and isinstance(body, dict) and step_key in bodies_by_key:
            # A PUT replaces the whole item. A second step for the same item was planned from the same single
            # read, so its body carries the library as it was *before* the first step of this write — sending it
            # as planned would quietly undo what the first step changed (a filing erased by a later tag edit on
            # the same item). The step is sent as the body the earlier step actually sent, plus the fields this
            # step changes, which is the same field-by-field shape the journal undoes with (review 2).
            earlier_index, earlier_body = bodies_by_key[step_key]
            changed = [str(name) for name in (step.get("changedFields") or []) if name in body]
            overwritten = sorted(set(changed) & applied_fields_by_key.get(step_key, set()))
            body = {**earlier_body, **{name: body[name] for name in changed}}
            entry_note = f"sent as the body step {earlier_index} wrote for {step_key}, plus {', '.join(changed) or 'no fields'}; the plan-time read of this item is out of date by that step"
        else:
            entry_note = None
            overwritten = []
        try:
            document, response_headers = _zotero_request(step["path"], timeout=ZOTERO_LISTING_TIMEOUT_SECONDS, method=step["method"], body=body, body_is_list=step.get("bodyIsList") is True, extra_headers=_zotero_write_headers(version=guard), write=True)
        except ResearchError as exc:
            stop(index, exc)
        entry: dict[str, Any] = {**describe(index, step), "request": True, "action": step.get("action"), "method": step["method"], "key": step.get("key"), "version": None, "created": step.get("action") == "create", "undoable": bool(step.get("undoable")), "before": step.get("before"), "changedFields": step.get("changedFields"), "undoReason": step.get("undoReason"), "guard": guard, "guardSource": guard_source}
        if entry_note:
            entry["builtFrom"] = entry_note
        if overwritten:
            entry["overwritesFields"] = overwritten
        if step["method"] == "POST":
            success = document.get("success") if isinstance(document, dict) else None
            failed = document.get("failed") if isinstance(document, dict) else None
            created = sorted({str(value) for value in (success or {}).values() if isinstance(value, str)})
            created_keys.extend(created)
            if len(created) == 1:
                entry["key"] = created[0]
            elif created:
                entry["keys"] = created
            if isinstance(failed, dict):
                for position, reason in sorted(failed.items(), key=lambda pair: str(pair[0])):
                    server_failures.append({"index": index, "batch": batch, "op": step.get("op"), "position": str(position), "reason": reason})
            if not created and not (isinstance(failed, dict) and failed):
                server_failures.append({"index": index, "batch": batch, "op": step.get("op"), "position": None, "reason": "the POST answered without a created key in `success`, so the Toolkit cannot name what it created", "success": success if isinstance(success, dict) else None})
            if step.get("collectionName") and isinstance(entry.get("key"), str):
                # A child collection named its parent by name (P3), and the only key that parent has is the one
                # this response just returned. Remembering it is what lets a later step in the same write file
                # under it instead of inventing a key.
                created_by_name[str(step["collectionName"])] = str(entry["key"])
        version = _zotero_header_int(response_headers.get("last-modified-version"))
        if version is None and isinstance(document, dict):
            version = _zotero_header_int(document.get("version"))
        if version is not None:
            library_version = version if library_version is None else max(library_version, version)
        entry["version"] = version
        if step.get("method") in ("PUT", "PATCH") and step_key:
            # What this library now reports for the item this step changed. A later step of the same write is
            # guarded by this number instead of by the one read the plan was built from.
            versions_by_key[step_key] = version
            guard_from_step[step_key] = index
            if isinstance(body, dict):
                bodies_by_key[step_key] = (index, dict(body))
            applied_fields_by_key.setdefault(step_key, set()).update(str(name) for name in (step.get("changedFields") or []))
        named_key = step.get("collectionKey") or (entry["key"] if step.get("collectionName") else None)
        if named_key:
            entry["collectionKey"] = str(named_key)
            entry["collectionName"] = step.get("collectionName")
            collection_keys.append(entry["collectionKey"])
        elif step.get("collectionName"):
            entry["collectionName"] = step.get("collectionName")
        applied.append(entry)

    result: dict[str, Any] = {
        "dryRun": False,
        # `ensure_collection` that found the collection already there sent nothing, and a write that sent
        # nothing did not modify the library. Saying `true` there would be a claim about a request that never happened.
        "zoteroModified": any(entry.get("request") for entry in applied),
        "applied": applied,
        "operationCount": len(applied),
        "batchesNeeded": batches_needed,
        "operationsPerBatch": ZOTERO_WRITE_MAX_OPERATIONS,
        "resumedAfter": resume_after,
        # A resume skips operations on the strength of the earlier report. They are named here so that a write
        # which sends 14 of 43 operations cannot be read as a write of 43.
        "skippedOperations": [describe(i, plan[i]) for i in range(resume_after)],
        "skippedNote": (
            f"These {resume_after} operations were not sent again: an earlier apply reported them as applied. The Toolkit did not re-read them to confirm that, so this receipt covers only the {len(plan) - resume_after} operations it sent."
            if resume_after else None
        ),
        "createdKeys": sorted(set(created_keys)),
        "serverFailures": server_failures,
        "libraryVersion": library_version,
        "collectionKeys": sorted(set(collection_keys)),
        "notUndoable": [{"op": entry["op"], "key": entry.get("key"), "collectionName": entry.get("collectionName"), "reason": entry.get("undoReason") or "recorded as not undoable: the local API has no restore for a created item"} for entry in applied if not entry["undoable"]],
        "nextStep": "Compare the write with the snapshot before trusting it. The tool result carries `countCheck` (item counts before and after, with `mismatch` named) and, for every collection a step named, `collectionCheck` (that collection's `numItems` and the items whose `data.collections` carry its key, before and after). An item count that did not move is normal for a filing — filing moves membership, not the number of items (P9) — which is why `collectionCheck` is the check that proves a filing (DD14-11).",
    }
    if result["collectionKeys"]:
        try:
            result["collectionState"] = zotero_collection_state(result["collectionKeys"])
        except ResearchError as exc:
            result["collectionStateNote"] = f"The collections this write named were not read back: {exc.code}. `collectionCheck` reports that as a mismatch rather than as a clean result."
    return result


ZOTERO_SNAPSHOT_PAGE_LIMIT = 100
ZOTERO_SNAPSHOT_MAX_PAGES = 20


def zotero_snapshot_document() -> dict[str, Any]:
    """Read the library back through the same API that will write it, page by page.

    The brief recommends copying `zotero.sqlite`. DD12-02 forbids the Toolkit from opening the library
    database, and a snapshot taken through the local API is the counterpart the Toolkit can actually read
    again. Pagination is bounded, and a library bigger than the bound is reported as truncated rather than
    presented as complete.
    """
    items: list[Any] = []
    truncated = True
    total_results: str | None = None
    library_version: int | None = None
    for page in range(ZOTERO_SNAPSHOT_MAX_PAGES):
        document, headers = _zotero_request(f"users/0/items?format=json&limit={ZOTERO_SNAPSHOT_PAGE_LIMIT}&start={page * ZOTERO_SNAPSHOT_PAGE_LIMIT}", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS)
        rows = document if isinstance(document, list) else []
        items.extend(rows)
        total_results = headers.get("zotero-total-results")
        library_version = _zotero_header_int(headers.get("last-modified-version")) or library_version
        if len(rows) < ZOTERO_SNAPSHOT_PAGE_LIMIT:
            truncated = False
            break
    collections = list_zotero_collections()["collections"]
    try:
        tags_document, _ = _zotero_request("users/0/tags?limit=100&format=json", timeout=ZOTERO_ROOT_TIMEOUT_SECONDS)
        tags = [row.get("data", {}).get("tag") for row in tags_document if isinstance(row, dict)] if isinstance(tags_document, list) else []
    except ResearchError as exc:
        tags = []
        tag_note = f"Tags were not read: {exc.code}."
    else:
        tag_note = None
    return {
        "takenAt": datetime.now(UTC).isoformat(timespec="seconds"),
        "itemCount": len(items),
        "totalResults": total_results,
        "truncated": truncated,
        # The library version the snapshot was taken at. `If-Unmodified-Since-Version` guards come from item
        # versions read at plan time; this is the library-level number the version-conflict report names.
        "libraryVersion": library_version,
        "items": items,
        # Each entry carries `key`, `name`, `parentCollection`, `numItems`, `numCollections` and `path`, which
        # is what `zotero_store.collection_check` compares the post-write read against (D3/D4).
        "collections": collections,
        "tags": [tag for tag in tags if tag],
        "tagNote": tag_note,
    }


def zotero_write_undo(entries: Any) -> dict[str, Any]:
    """Replay one journal backwards, refusing any item the operator touched in the meantime."""
    if not isinstance(entries, list) or not entries:
        raise ResearchError("ZOTERO_JOURNAL_EMPTY", "There is nothing recorded to undo.")
    undone: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    for entry in reversed(entries):
        if not isinstance(entry, dict) or not entry.get("undoable") or not entry.get("key"):
            # A created collection or a created item is refused with the reason it was recorded with, so the
            # operator reads the same sentence in the preview, in the journal and in the refusal (D7).
            stated = entry.get("undoReason") if isinstance(entry, dict) else None
            refused.append({"key": (entry or {}).get("key"), "reason": stated or "recorded as not undoable: the local API has no restore for a created item"})
            continue
        data, version = _zotero_item_data(str(entry["key"]))
        body = dict(data)
        for name, value in (entry.get("before") or {}).items():
            body[name] = value
        try:
            _zotero_request(f"users/0/items/{entry['key']}", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS, method="PUT", body=body, extra_headers=_zotero_write_headers(version=version), write=True)
        except ResearchError as exc:
            refused.append({"key": entry["key"], "reason": exc.code, "said": exc.evidence})
            continue
        undone.append({"key": entry["key"], "restoredFields": sorted(entry.get("before") or {})})
    return {"dryRun": False, "zoteroModified": bool(undone), "undone": undone, "refused": refused}


def _ris_date(value: Any) -> str | None:
    """The record's normalized date as one RIS `DA` value; a list becomes a dashed date."""
    if isinstance(value, (list, tuple)):
        value = "-".join(str(item) for item in value if isinstance(item, (str, int)))
    if value is None:
        return None
    text = str(value).replace("\r", " ").replace("\n", " ").strip()
    return text or None


def _ris_provenance_note(record: dict[str, Any], date_text: str | None) -> str | None:
    """Which providers answered, and which provider's which date field the `DA` value came from.

    `M2` is the field Zotero's RIS translator keeps as `extra` (measured 14 November 2026), so this is the one
    place in the imported library where a later reader can see that a 2021 date was a DOI registration date
    rather than a publication date. It says what was measured; it never restates a provider's claim as the
    Toolkit's own.
    """
    parts: list[str] = []
    providers = _field_providers(record)
    if providers:
        parts.append("providers: " + ", ".join(PROVIDER_LABELS.get(name, name) for name in providers))
    field = record.get("dateField")
    if date_text and isinstance(field, dict) and isinstance(field.get("value"), str):
        source = field.get("provenance")
        label = PROVIDER_LABELS.get(source.get("provider", ""), "") if isinstance(source, dict) else ""
        parts.append(f"date from {label or 'the provider'} {field['value']!r}")
        if field["value"] == "created":
            parts.append("Crossref 'created' is the DOI registration date")
    elif date_text:
        parts.append("date field not recorded by the provider")
    return "; ".join(parts)[:240] or None


def to_ris(records: list[dict[str, Any]]) -> str:
    if not records or len(records) > 100:
        raise ResearchError("IMPORT_COUNT_INVALID", "Prepare between 1 and 100 records per reviewed Zotero import.")
    lines: list[str] = []
    for record in records:
        fields = {name: item.get("value") if isinstance(item, dict) else item for name, item in record.items()}
        s2_attribution = next((a for a in fields.get("attribution", []) if a.get("provider") == "Semantic Scholar"), None)
        if s2_attribution:
            fields["url"] = s2_attribution["url"]
        item_type = str(fields.get("publicationType") or "").lower()
        # Measured 14 November 2026: this build's RIS translator turns `TY  - GEN` into `journalArticle`,
        # which is wrong for a code of canon law and for an apostolic constitution. An unmapped type is
        # therefore named in `ris_warnings` instead of being quietly written as GEN.
        # The book and chapter tests are family tests, not substring tests, because Crossref's `type` is a
        # vocabulary: `monograph` was written as GEN and `book-part` as BOOK, and a chapter asked for under
        # `type:book` is not returned at all (`fixtures/crossref-type-vocabulary.json`). Chapter-like is
        # checked first: `book-chapter` and `book-part` both contain the word "book".
        if "statute" in item_type or "legislat" in item_type:
            ris_type = "STAT"
        elif "thesis" in item_type or "dissert" in item_type:
            ris_type = "THES"
        elif "report" in item_type:
            ris_type = "RPRT"
        elif item_type in CROSSREF_CHAPTER_TYPES or "chapter" in item_type or "booksection" in item_type:
            ris_type = "CHAP"
        elif item_type in CROSSREF_BOOK_TYPES or "book" in item_type:
            ris_type = "BOOK"
        elif "proceeding" in item_type or "conference" in item_type:
            ris_type = "CPAPER"
        elif "journal" in item_type or "article" in item_type:
            ris_type = "JOUR"
        else:
            ris_type = "GEN"
        lines.append(f"TY  - {ris_type}")
        for author in fields.get("authors") or []:
            lines.append(f"AU  - {_plain_text(str(author)) or ''}")
        mapping = (("title", "TI"), ("venue", "JO"), ("year", "PY"), ("doi", "DO"), ("url", "UR"), ("abstract", "AB"))
        for field, tag in mapping:
            value = fields.get(field)
            if value is not None:
                lines.append(f"{tag}  - {str(value).replace(chr(13), ' ').replace(chr(10), ' ')}")
        # `DA` is the normalized date, and `M2` says where it came from: the 21 November receipts dated works
        # by Crossref `created`, which is the DOI registration date, and a reader of the library cannot tell
        # that back out of a bare year. `DA` and `M2` are both in `RIS_KNOWN_TAGS` and neither is repeatable
        # in Zotero's translator, so exactly one of each is written per record.
        date_text = _ris_date(fields.get("date"))
        if date_text:
            lines.append(f"DA  - {date_text}")
        provenance_note = _ris_provenance_note(record, date_text)
        if provenance_note:
            lines.append(f"M2  - {provenance_note}")
        # `KW` is the one RIS field Zotero turns into tags, and tags are the only thing in the library a
        # later reader can filter on. `N1` becomes a child note, which cannot be filtered (measured 14 Nov 2026).
        if fields.get("tags"):
            for tag in _zotero_tag_list(fields["tags"]):
                lines.append(f"KW  - {tag}")
        lines.append("ER  - ")
        lines.append("")
    # `rstrip()` without an argument would eat the trailing space of the last `ER  - ` line, and a validator
    # that reads its own output as malformed is worse than the defect it was written to catch.
    return "\n".join(lines).rstrip("\n") + "\n"


# --- RIS validation (0.3.13) ---
# The 14 November 2026 import returned HTTP success and created 156 items, 61 of them empty. A status code
# is not an import result, so the RIS text is checked before it is offered to Zotero and the record count is
# compared after. `scripts/validate_ris.py` in the skill bundle applies the same rules from the command line.
# A RIS line is `XX  - value`. The space after the dash is part of the format, and `ER  - ` carries no value;
# a file written by another tool may leave the trailing space off, so the shape is checked and the trailing
# space is not.
RIS_TAG_PATTERN = re.compile(r"^([A-Z][A-Z0-9]) {2}- ?(.*)$")
RIS_SINGLE_TAGS = ("TY", "ER")
RIS_NON_REPEATABLE = ("PY", "DO", "AB", "TI", "JO", "J2", "LA", "SN", "UR", "CY", "PB", "VL", "IS", "SP", "T2")
RIS_KNOWN_TAGS = frozenset({"TY", "AU", "A2", "A3", "A4", "AB", "AD", "AN", "AU", "CY", "DA", "DO", "DP", "ET", "ID", "IS", "JO", "J2", "KW", "LA", "M1", "M2", "N1", "N2", "PB", "PY", "SN", "SP", "ST", "T1", "T2", "TI", "TY", "UR", "VL", "ER", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10"})
RIS_TYPE_CODES = ("ART", "BOOK", "CHAP", "CONF", "CPAPER", "DATA", "GEN", "JOUR", "MAP", "MUSIC", "NEWS", "PAT", "PCOMP", "REF", "RPRT", "SLIDE", "STAT", "THES", "UNPD", "WEB")
# No title-pattern rule here on purpose. `TY  - GEN` is warned on every record because the RIS translator
# measured on 14 November 2026 maps it to `journalArticle` whatever the title says, and guessing a genre
# from a title would be a claim the validator cannot support. The operator chooses STAT, RPRT or THES.


def validate_ris_text(text: str, *, expect: int | None = None) -> dict[str, Any]:
    """Structural truth about a RIS text: record count, malformed lines, repeated and unknown tags, gaps.

    Two findings are warnings, not refusals. A record with no identifier is a real record that simply
    cannot be deduplicated reliably — refusing to write it would lose it. A `TY  - GEN` is a type the
    translator maps wrongly, and the operator may still want it. Both are reported, neither blocks the file.
    """
    problems: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    records = 0
    current: dict[str, Any] = {"tags": [], "start": 0}
    for index, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.rstrip("\r")
        if not line.strip():
            continue
        match = RIS_TAG_PATTERN.match(line)
        if not match:
            problems.append({"line": str(index), "problem": "malformed-line", "detail": f"Expected `XX  - value`, found {line[:40]!r}."})
            continue
        tag = match.group(1)[:2]
        value = match.group(2)
        if tag not in RIS_KNOWN_TAGS:
            problems.append({"line": str(index), "problem": "unknown-tag", "detail": f"{tag} is not a tag Zotero's RIS translator reads; it becomes a note tagged `_RIS import`."})
        if tag in RIS_SINGLE_TAGS and tag in current["tags"]:
            problems.append({"line": str(index), "problem": "duplicate-record-marker", "detail": f"{tag} appears twice in one record."})
        if tag in RIS_NON_REPEATABLE and tag in current["tags"]:
            problems.append({"line": str(index), "problem": "repeated-field", "detail": f"{tag} is not repeatable; the second value would be dropped or concatenated."})
        current["tags"].append(tag)
        if tag == "TY":
            records += 1
            current["start"] = index
            code = value.strip()
            if code not in RIS_TYPE_CODES:
                problems.append({"line": str(index), "problem": "unknown-record-type", "detail": f"TY {code!r} is not a type Zotero's RIS translator maps."})
            elif code == "GEN":
                warnings.append({"line": str(index), "problem": "generic-record-type", "detail": "TY GEN is mapped to journalArticle by the RIS translator in the build measured on 14 November 2026. For a legal, conciliar or magisterial text use STAT; for a report RPRT; for a dissertation THES."})
        if tag == "ER":
            if "TY" not in current["tags"]:
                problems.append({"line": str(index), "problem": "record-without-type", "detail": "A record ended without a TY line."})
            if not any(t in ("AU", "A2", "T1", "TI", "ST") for t in current["tags"]):
                problems.append({"line": str(current["start"]), "problem": "record-without-author-or-title", "detail": "This record has neither an author nor a title, which is how an empty item arrives in the library."})
            if not any(t in ("DO", "ID", "UR", "SN") for t in current["tags"]):
                warnings.append({"line": str(current["start"]), "problem": "record-without-identifier", "detail": "No DOI, ID, URL or ISBN: this record cannot be deduplicated reliably."})
            current = {"tags": [], "start": 0}
    if current["tags"]:
        problems.append({"line": str(current["start"] or 1), "problem": "record-without-end", "detail": "A record opened and never closed with ER."})
    if expect is not None and expect != records:
        problems.append({"line": "0", "problem": "record-count-mismatch", "detail": f"Expected {expect} records, found {records}."})
    return {"valid": not problems, "recordCount": records, "lineCount": len(text.splitlines()), "problems": problems, "warnings": warnings}
