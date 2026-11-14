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

    def __init__(self, code: str, message: str, *, retry_after: str | None = None, evidence: str | None = None):
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after
        # What the local server actually answered, clipped: the readiness receipt carries it so an operator's
        # report says which answer Zotero gave instead of leaving the cause to be guessed.
        self.evidence = evidence

    def as_dict(self) -> dict[str, object]:
        result: dict[str, object] = {"code": self.code, "message": str(self)}
        if self.retry_after:
            result["retryAfter"] = self.retry_after
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
        raise ResearchError("PROVIDER_BUDGET_DEFERRED",
                            "Another Toolkit process is already waiting out this provider's rate limit; the Toolkit will not ask again before the shared budget opens.",
                            retry_after=str(max(1, -(-outcome["waitMs"] // 1000))))
    return outcome["payload"], outcome["headers"], outcome


def _query_hash(provider: str, query: str) -> str:
    return hashlib.sha256(f"{provider}\0{query.strip()}".encode("utf-8")).hexdigest()


def _field(value: Any, provider: str, upstream_id: str, fetched_at: str, query_hash: str) -> dict[str, Any]:
    return {"value": value, "provenance": {"provider": provider, "upstreamId": upstream_id, "fetchedAt": fetched_at, "queryHash": query_hash}}


def _normalize(provider: str, raw: dict[str, Any], fetched_at: str, query_hash: str) -> dict[str, Any]:
    if provider == "openalex":
        upstream_id = str(raw.get("id", ""))
        authors = [entry["author"].get("display_name") for entry in _dict_list(raw.get("authorships"))
                   if isinstance(entry.get("author"), dict) and entry["author"].get("display_name")]
        location = raw.get("primary_location") if isinstance(raw.get("primary_location"), dict) else {}
        source = location.get("source") if isinstance(location.get("source"), dict) else {}
        doi = normalize_doi(raw.get("doi"))
        open_access = raw.get("open_access") if isinstance(raw.get("open_access"), dict) else {}
        values = {"title": _first_text(raw.get("title")), "authors": authors, "year": raw.get("publication_year") if isinstance(raw.get("publication_year"), int) else None, "date": raw.get("publication_date") if isinstance(raw.get("publication_date"), (list, str)) else None, "venue": source.get("display_name"), "publicationType": raw.get("type"), "abstract": _abstract_from_inverted_index(raw.get("abstract_inverted_index") if isinstance(raw.get("abstract_inverted_index"), dict) else None), "url": upstream_id or None, "openAccessUrl": open_access.get("oa_url"), "license": None}
    elif provider == "crossref":
        upstream_id = str(raw.get("DOI", ""))
        authors = [" ".join(filter(None, (a.get("given"), a.get("family")))) for a in _dict_list(raw.get("author"))]
        authors = [a for a in authors if a]
        title = _first_text(raw.get("title"))
        doi = normalize_doi(raw.get("DOI"))
        links = _dict_list(raw.get("link"))
        values = {"title": title, "authors": authors, "year": _first_date_part(raw.get("published-print")) or _first_date_part(raw.get("published-online")) or _first_date_part(raw.get("created")), "date": None, "venue": _first_text(raw.get("container-title")), "publicationType": raw.get("type"), "abstract": _plain_text(raw.get("abstract")) if isinstance(raw.get("abstract"), str) else None, "url": raw.get("URL"), "openAccessUrl": next((x.get("URL") for x in links if isinstance(x.get("content-type"), str) and "pdf" in x["content-type"].lower()), None), "license": None}
    else:
        upstream_id = str(raw.get("paperId", ""))
        external = raw.get("externalIds") if isinstance(raw.get("externalIds"), dict) else {}
        doi = normalize_doi(external.get("DOI"))
        types = [item for item in (raw.get("publicationTypes") if isinstance(raw.get("publicationTypes"), list) else []) if isinstance(item, str)]
        open_pdf = raw.get("openAccessPdf") if isinstance(raw.get("openAccessPdf"), dict) else {}
        values = {"title": _first_text(raw.get("title")), "authors": [a.get("name") for a in _dict_list(raw.get("authors")) if a.get("name")], "year": raw.get("year") if isinstance(raw.get("year"), int) else None, "date": raw.get("publicationDate"), "venue": _first_text(raw.get("venue")), "publicationType": types[0] if types else None, "abstract": raw.get("abstract") if isinstance(raw.get("abstract"), str) else None, "url": raw.get("url"), "openAccessUrl": open_pdf.get("url"), "license": open_pdf.get("license") if isinstance(open_pdf.get("license"), str) else None}

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


def _request_for(provider: str, query: str, limit: int) -> tuple[str, dict[str, str]]:
    encoded = urllib.parse.urlencode({"search": query, "per_page": limit, "select": "id,doi,title,authorships,publication_year,publication_date,primary_location,abstract_inverted_index,open_access"})
    if provider == "openalex":
        key = os.environ.get("OPENALEX_API_KEY")
        if key:
            encoded += "&" + urllib.parse.urlencode({"api_key": key})
        return f"https://api.openalex.org/works?{encoded}", {}
    if provider == "crossref":
        params = {"query.bibliographic": query, "rows": limit}
        mailto = os.environ.get("CROSSREF_MAILTO")
        if mailto:
            params["mailto"] = mailto
        return f"https://api.crossref.org/works?{urllib.parse.urlencode(params)}", _crossref_headers()
    if provider == "semantic_scholar":
        params = {"query": query, "limit": limit, "fields": "paperId,title,authors,year,publicationDate,venue,abstract,externalIds,url,openAccessPdf"}
        headers = {"x-api-key": os.environ["SEMANTIC_SCHOLAR_API_KEY"]} if os.environ.get("SEMANTIC_SCHOLAR_API_KEY") else {}
        return f"https://api.semanticscholar.org/graph/v1/paper/search?{urllib.parse.urlencode(params)}", headers
    raise ResearchError("PROVIDER_UNKNOWN", "Choose openalex, crossref, semantic_scholar, or all.")


def _search_one(provider: str, query: str, limit: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    url, headers = _request_for(provider, query, limit)
    query_hash = _query_hash(provider, query)
    payload, response_headers, budget = _provider_request(provider, url, headers, cache_key=query_hash)
    if provider == "openalex":
        rows = payload.get("results") if isinstance(payload, dict) else None
        meta = payload.get("meta", {}) if isinstance(payload, dict) else {}
    elif provider == "crossref":
        message = payload.get("message", {}) if isinstance(payload, dict) else {}
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
    outcome = {"provider": provider, "state": "ok", "reportedCount": meta.get("count", meta.get("totalResults")),
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
        for field in ("title", "authors", "year", "date", "venue", "publicationType", "abstract", "url", "openAccessUrl", "license"):
            incoming = record[field]
            existing = current[field]
            if incoming["value"] is None:
                continue
            existing_sources = existing["provenance"] if isinstance(existing["provenance"], list) else [existing["provenance"]]
            observations = existing.get("observations") or [{"value": existing["value"], "provenance": existing["provenance"]}]
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


def _zotero_request(path: str, *, timeout: int, expect_json: bool = True, method: str = "GET", body: dict[str, Any] | None = None, extra_headers: dict[str, str] | None = None, write: bool = False) -> tuple[Any, dict[str, str]]:
    """One bounded request to the fixed loopback Zotero port, and what the port said when it refused.

    A bare path is read under `/api`, so an empty path is `/api/` itself. A full URL is honoured only when it
    already names the reviewed loopback port, which is how the connector ping — a sibling of `/api` — reuses
    this one client. `Zotero-Allowed-Request` keeps the request from being dropped: Zotero 10 drops requests
    that look like browser requests without any response unless it is sent. The IPv4 loopback URL gives urllib
    a `Host` of `127.0.0.1:23119`, one of the three Zotero accepts. Every caller states its own `timeout`
    because the stages of one check are not equally cheap: Zotero answers the local API only after the library
    has loaded, so the listing waits far longer than the endpoints that answer before the preference is read.
    """
    url = path if path.startswith(ZOTERO_LOOPBACK_ORIGIN) else f"{ZOTERO_LOCAL_API}/{path.lstrip('/')}"
    # Bypass proxy settings for this fixed loopback-only address.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler())
    headers = {"Accept": "application/json", "Zotero-API-Version": "3", "Zotero-Allowed-Request": "1", **(extra_headers or {})}
    payload: bytes | None = None
    if body is not None:
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


def list_zotero_collections() -> dict[str, Any]:
    payload, headers = _zotero_request("users/0/collections?limit=100&format=json", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS)
    rows = payload if isinstance(payload, list) else []
    collections = [{"key": row.get("key"), "name": (row.get("data") or {}).get("name"), "parentCollection": (row.get("data") or {}).get("parentCollection")} for row in rows if isinstance(row, dict)]
    return {"collections": collections, "serverId": headers.get("zotero-server-id"), "readOnly": True}


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
ZOTERO_WRITE_MAX_OPERATIONS = 25
ZOTERO_TAG_MAX_LENGTH = 64
# The facets `references/zotero-vocabulary.md` defines. A tag outside them is refused before it reaches the
# library, because an unbounded vocabulary decays into dozens of near-identical tags.
ZOTERO_TAG_FACETS = ("access/", "topic/", "type/", "status/")
ZOTERO_WRITE_OPS = ("add_tags", "add_to_collection", "create_collection", "create_item", "remove_tags", "set_item_type", "update_fields")
# Named so the refusal says why: the local API has no merge endpoint and no restore, so a delete cannot be
# undone by the Toolkit (DD14-07), and duplicate detection is UI-only in Zotero.
ZOTERO_REFUSED_OPS = ("delete", "delete_item", "duplicate_check", "merge")
ZOTERO_EXPORT_FORMATS = ("csljson", "bibtex", "biblatex", "csv")
ZOTERO_ITEM_KEY_PATTERN = re.compile(r"[A-Z0-9]{8}")
ZOTERO_WRITABLE_FIELDS = frozenset({"title", "creators", "date", "itemType", "abstractNote", "DOI", "url", "extra", "libraryCatalog", "publisher", "volume", "issue", "pages", "accessDate", "shortTitle", "language"})
ZOTERO_STATUS_ENDPOINTS = ("api-root", "collections", "items", "tags", "searches", "fulltext", "itemTypes")


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
    return {
        "readOnly": True,
        "endpoints": probes,
        "answeredEndpoints": sorted(answered),
        "counts": counts,
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
    total = headers.get("zotero-total-results")
    return {"readOnly": True, "query": query.strip(), "items": items, "returned": len(items), "totalResults": total, "truncated": bool(total and int(total) > len(items)), "serverId": headers.get("zotero-server-id")}


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


def zotero_export(fmt: str = "csljson", limit: int = 50) -> dict[str, Any]:
    """Ask Zotero for its own export body. `markdown` and `counts` are not formats this API answers with."""
    if fmt not in ZOTERO_EXPORT_FORMATS:
        raise ResearchError("ZOTERO_EXPORT_FORMAT_UNSUPPORTED", f"Zotero's local API exports {', '.join(ZOTERO_EXPORT_FORMATS)}. It refused markdown and counts in the 14 November 2026 measurement; a Markdown bibliography has to be generated from the records.", evidence=f"asked for {fmt}")
    bounded = max(1, min(int(limit), 100))
    document, headers = _zotero_request(f"users/0/items?format={fmt}&limit={bounded}", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS, expect_json=(fmt == "csljson"))
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


def _zotero_plan(changes: Any) -> list[dict[str, Any]]:
    """Turn the requested changes into the exact requests a write would send, reading what is there now.

    `preview` and `apply` share this one planner so that what the operator saw in the preview is the same
    body the apply sends. A plan that cannot be built is refused here, before any request is made.
    """
    if not isinstance(changes, list) or not changes or len(changes) > ZOTERO_WRITE_MAX_OPERATIONS:
        raise ResearchError("ZOTERO_WRITE_COUNT_INVALID", f"A Zotero write takes 1 to {ZOTERO_WRITE_MAX_OPERATIONS} operations.")
    known_item_types: list[str] | None = None
    known_collections: set[str] | None = None
    plan: list[dict[str, Any]] = []
    for change in changes:
        if not isinstance(change, dict):
            raise ResearchError("ZOTERO_WRITE_OPERATION_INVALID", "Every Zotero write operation is an object with an `op`.")
        op = str(change.get("op") or "")
        if op in ZOTERO_REFUSED_OPS:
            raise ResearchError("ZOTERO_WRITE_ACTION_UNSUPPORTED", f"`{op}` is not offered: the local API has no merge endpoint and no restore, so the Toolkit cannot undo a delete or a merge. Do it in Zotero's own interface.")
        if op not in ZOTERO_WRITE_OPS:
            raise ResearchError("ZOTERO_WRITE_ACTION_UNSUPPORTED", f"Unknown Zotero write operation {op!r}. Offered: {', '.join(ZOTERO_WRITE_OPS)}.")
        if op == "create_collection":
            name = str(change.get("name") or "").strip()
            if not name or len(name) > 200:
                raise ResearchError("ZOTERO_COLLECTION_NAME_INVALID", "A collection needs a name of 1-200 characters.")
            plan.append({"op": op, "method": "POST", "path": "users/0/collections", "body": {"name": name}, "undoable": False, "before": None})
            continue
        if op == "create_item":
            title = str(change.get("title") or "").strip()
            if not title:
                raise ResearchError("ZOTERO_ITEM_TITLE_REQUIRED", "A created item needs a title.")
            item_type = str(change.get("itemType") or "document")
            known_item_types = known_item_types or _zotero_item_types()
            if known_item_types and item_type not in known_item_types:
                raise ResearchError("ZOTERO_ITEM_TYPE_UNKNOWN", f"Zotero does not list an item type {item_type!r}. It lists: {', '.join(known_item_types)}.", evidence=None)
            body: dict[str, Any] = {"itemType": item_type, "title": title}
            creators = change.get("creators") or []
            if not isinstance(creators, list):
                raise ResearchError("ZOTERO_CREATORS_INVALID", "Creators must be a list of names.")
            body["creators"] = [_zotero_creator(creator) for creator in creators]
            for field in ("date", "DOI", "url", "abstractNote", "extra", "publisher"):
                if change.get(field) is not None:
                    body[field] = str(change[field])
            if change.get("tags") is not None:
                body["tags"] = [{"tag": tag} for tag in _zotero_tag_list(change["tags"])]
            plan.append({"op": op, "method": "POST", "path": "users/0/items", "body": body, "undoable": False, "before": None})
            continue
        data, version = _zotero_item_data(str(change.get("key") or ""))
        body = dict(data)
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
            listing = list_zotero_collections()
            known_collections = {str(row.get("key")) for row in listing["collections"]}
            if collection_key not in known_collections:
                raise ResearchError("ZOTERO_COLLECTION_NOT_FOUND", f"No collection {collection_key} exists. Create it first with `create_collection`.")
            current = [str(item) for item in data.get("collections") or []]
            body["collections"] = list(dict.fromkeys([*current, collection_key]))
        changed = {name: value for name, value in body.items() if data.get(name) != value}
        plan.append({"op": op, "key": str(change.get("key")), "method": "PUT", "path": f"users/0/items/{change.get('key')}", "body": body, "guard": version, "changedFields": sorted(changed), "undoable": True, "before": {name: data.get(name) for name in changed}})
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
        "writeKeyPresent": zotero_write_key_present(),
        "nextStep": f"Apply with confirm={ZOTERO_WRITE_CONFIRM!r}. A snapshot of the library is taken first and its path is reported.",
    }


def zotero_write_apply(changes: Any, *, confirm: str) -> dict[str, Any]:
    """Apply a previewed plan, then read the counts back. A 200 or 204 is not treated as proof."""
    if confirm != ZOTERO_WRITE_CONFIRM:
        raise ResearchError("WRITE_CONFIRM_REQUIRED", f"A Zotero write needs confirm={ZOTERO_WRITE_CONFIRM!r}. Run `preview` first and read it.")
    plan = _zotero_plan(changes)
    applied: list[dict[str, Any]] = []
    for step in plan:
        headers = _zotero_write_headers(version=step.get("guard"))
        document, _ = _zotero_request(step["path"], timeout=ZOTERO_LISTING_TIMEOUT_SECONDS, method=step["method"], body=step["body"], extra_headers=headers, write=True)
        key = (document or {}).get("key") if isinstance(document, dict) else step.get("key")
        version = (document or {}).get("version") if isinstance(document, dict) else None
        applied.append({"op": step["op"], "key": key, "version": version, "undoable": step["undoable"], "before": step.get("before"), "changedFields": step.get("changedFields")})
    return {
        "dryRun": False,
        "zoteroModified": True,
        "applied": applied,
        "operationCount": len(applied),
        "notUndoable": [entry for entry in applied if not entry["undoable"]],
        "nextStep": "Check the library against the snapshot: the Toolkit re-reads the item count and reports a mismatch as an error.",
    }


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
    for page in range(ZOTERO_SNAPSHOT_MAX_PAGES):
        document, headers = _zotero_request(f"users/0/items?format=json&limit={ZOTERO_SNAPSHOT_PAGE_LIMIT}&start={page * ZOTERO_SNAPSHOT_PAGE_LIMIT}", timeout=ZOTERO_LISTING_TIMEOUT_SECONDS)
        rows = document if isinstance(document, list) else []
        items.extend(rows)
        total_results = headers.get("zotero-total-results")
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
        "items": items,
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
            refused.append({"key": (entry or {}).get("key"), "reason": "recorded as not undoable: the local API has no restore for a created item"})
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
        if "statute" in item_type or "legislat" in item_type:
            ris_type = "STAT"
        elif "thesis" in item_type or "dissert" in item_type:
            ris_type = "THES"
        elif "report" in item_type:
            ris_type = "RPRT"
        elif "chapter" in item_type or "booksection" in item_type:
            ris_type = "CHAP"
        elif "book" in item_type:
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
