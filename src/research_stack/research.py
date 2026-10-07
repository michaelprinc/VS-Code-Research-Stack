"""Bounded, provenance-preserving adapters for scholarly metadata and Zotero reads.

Provider credentials are read only from the process environment. The module has
no persistent cache and never writes to Zotero or downloads full text.
"""

from __future__ import annotations

import hashlib
import html
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

REQUEST_TIMEOUT_SECONDS = 15
MAX_RESULTS = 25
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
ZOTERO_LOCAL_API = "http://localhost:23119/api"
PROVIDERS = ("openalex", "crossref", "semantic_scholar")
_THROTTLE_LOCKS = {provider: threading.Lock() for provider in PROVIDERS}
_LAST_REQUEST_AT: dict[str, float] = {}
MIN_REQUEST_INTERVAL_SECONDS = 1.0


class ResearchError(RuntimeError):
    """An actionable provider or local-library error with a stable code."""

    def __init__(self, code: str, message: str, *, retry_after: str | None = None):
        super().__init__(message)
        self.code = code
        self.retry_after = retry_after

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
    if not value:
        return None
    doi = re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", value.strip(), flags=re.I)
    doi = html.unescape(doi).strip().rstrip(".,;)").lower()
    return doi if re.fullmatch(r"10\.\d{4,9}/\S+", doi) else None


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
            message = "Provider rate limit reached; wait for the indicated retry window."
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


def _provider_request(provider: str, url: str, headers: dict[str, str] | None = None) -> tuple[dict[str, Any] | list[Any], dict[str, str]]:
    # Serialize each provider and use a conservative one-request-per-second
    # process-local pacing floor until account-specific limits are proven.
    lock = _THROTTLE_LOCKS[provider]
    with lock:
        elapsed = time.monotonic() - _LAST_REQUEST_AT.get(provider, 0.0)
        if elapsed < MIN_REQUEST_INTERVAL_SECONDS:
            time.sleep(MIN_REQUEST_INTERVAL_SECONDS - elapsed)
        try:
            return _request_json(url, headers)
        finally:
            _LAST_REQUEST_AT[provider] = time.monotonic()


def _query_hash(provider: str, query: str) -> str:
    return hashlib.sha256(f"{provider}\0{query.strip()}".encode("utf-8")).hexdigest()


def _field(value: Any, provider: str, upstream_id: str, fetched_at: str, query_hash: str) -> dict[str, Any]:
    return {"value": value, "provenance": {"provider": provider, "upstreamId": upstream_id, "fetchedAt": fetched_at, "queryHash": query_hash}}


def _normalize(provider: str, raw: dict[str, Any], fetched_at: str, query_hash: str) -> dict[str, Any]:
    if provider == "openalex":
        upstream_id = str(raw.get("id", ""))
        authors = [a.get("author", {}).get("display_name") for a in raw.get("authorships", []) if a.get("author", {}).get("display_name")]
        location = raw.get("primary_location") or {}
        source = location.get("source") or {}
        doi = normalize_doi(raw.get("doi"))
        values = {"title": raw.get("title"), "authors": authors, "year": raw.get("publication_year"), "date": raw.get("publication_date"), "venue": source.get("display_name"), "publicationType": raw.get("type"), "abstract": _abstract_from_inverted_index(raw.get("abstract_inverted_index")), "url": upstream_id or None, "openAccessUrl": (raw.get("open_access") or {}).get("oa_url"), "license": None}
    elif provider == "crossref":
        upstream_id = str(raw.get("DOI", ""))
        authors = [" ".join(filter(None, (a.get("given"), a.get("family")))) for a in raw.get("author", [])]
        authors = [a for a in authors if a]
        title = (raw.get("title") or [None])[0]
        doi = normalize_doi(raw.get("DOI"))
        links = raw.get("link") or []
        values = {"title": title, "authors": authors, "year": ((raw.get("published-print") or raw.get("published-online") or raw.get("created") or {}).get("date-parts") or [[None]])[0][0], "date": None, "venue": (raw.get("container-title") or [None])[0], "publicationType": raw.get("type"), "abstract": _plain_text(raw.get("abstract")), "url": raw.get("URL"), "openAccessUrl": next((x.get("URL") for x in links if "pdf" in x.get("content-type", "").lower()), None), "license": None}
    else:
        upstream_id = str(raw.get("paperId", ""))
        external = raw.get("externalIds") or {}
        doi = normalize_doi(external.get("DOI"))
        types = raw.get("publicationTypes") or []
        values = {"title": raw.get("title"), "authors": [a.get("name") for a in raw.get("authors", []) if a.get("name")], "year": raw.get("year"), "date": raw.get("publicationDate"), "venue": raw.get("venue"), "publicationType": types[0] if types else None, "abstract": raw.get("abstract"), "url": raw.get("url"), "openAccessUrl": (raw.get("openAccessPdf") or {}).get("url"), "license": None}

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
        token = os.environ.get("CROSSREF_PLUS_API_TOKEN")
        headers = {"Crossref-Plus-API-Token": f"Bearer {token}"} if token else {}
        if mailto:
            headers["User-Agent"] = f"ResearchStack/0.2.0 (mailto:{mailto})"
        return f"https://api.crossref.org/works?{urllib.parse.urlencode(params)}", headers
    if provider == "semantic_scholar":
        params = {"query": query, "limit": limit, "fields": "paperId,title,authors,year,publicationDate,venue,abstract,externalIds,url,openAccessPdf"}
        headers = {"x-api-key": os.environ["SEMANTIC_SCHOLAR_API_KEY"]} if os.environ.get("SEMANTIC_SCHOLAR_API_KEY") else {}
        return f"https://api.semanticscholar.org/graph/v1/paper/search?{urllib.parse.urlencode(params)}", headers
    raise ResearchError("PROVIDER_UNKNOWN", "Choose openalex, crossref, semantic_scholar, or all.")


def _search_one(provider: str, query: str, limit: int) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    url, headers = _request_for(provider, query, limit)
    payload, response_headers = _provider_request(provider, url, headers)
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
    fetched_at = datetime.now(UTC).isoformat()
    query_hash = _query_hash(provider, query)
    return [_normalize(provider, row, fetched_at, query_hash) for row in rows[:limit] if isinstance(row, dict)], {"provider": provider, "reportedCount": meta.get("count", meta.get("totalResults")), "returned": min(len(rows), limit), "rateLimit": response_headers.get("x-rate-limit-limit"), "rateLimitInterval": response_headers.get("x-rate-limit-interval")}


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
            if existing["value"] is None:
                current[field] = incoming
            elif existing["value"] != incoming["value"]:
                current[field] = {"value": existing["value"], "provenance": [*existing_sources, incoming["provenance"]], "conflicts": [existing["value"], incoming["value"]]}
            else:
                current[field]["provenance"] = [*existing_sources, incoming["provenance"]]
    return list(merged.values())


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
    return {"queryHash": hashlib.sha256(query.encode("utf-8")).hexdigest(), "records": _merge_exact_doi(records), "providers": outcomes, "errors": errors, "warnings": ["Records are merged only by normalized exact DOI; title similarity is never treated as identity.", "Open-access links are reported but no files are downloaded; a reported link is not a verified license."], "resultState": "partial" if errors else "complete"}


def validate_citation(doi_value: str) -> dict[str, Any]:
    doi = normalize_doi(doi_value)
    if not doi:
        return {"status": "unresolved", "input": doi_value, "reason": "Input is not a syntactically valid DOI. This does not establish whether a work exists."}
    url = f"https://api.crossref.org/works/{urllib.parse.quote(doi, safe='/') }"
    try:
        payload, _ = _provider_request("crossref", url, {})
    except ResearchError as exc:
        if exc.code == "PROVIDER_NOT_FOUND":
            return {"status": "unresolved", "doi": doi, "reason": "Crossref has no matching record. This is not proof that the DOI or work is invalid; it may be registered elsewhere or metadata may be incomplete."}
        raise
    work = payload.get("message") if isinstance(payload, dict) else None
    if not isinstance(work, dict):
        raise ResearchError("PROVIDER_SCHEMA_UNEXPECTED", "Crossref DOI response has no work object.")
    fetched_at = datetime.now(UTC).isoformat()
    return {"status": "record-found", "doi": doi, "record": _normalize("crossref", work, fetched_at, _query_hash("crossref-doi", doi)), "interpretation": "Crossref metadata record found; this does not verify scientific claims or guarantee all bibliographic fields are correct."}


def _zotero_request(path: str) -> tuple[dict[str, Any] | list[Any], dict[str, str]]:
    url = f"{ZOTERO_LOCAL_API}/{path.lstrip('/')}"
    # Bypass proxy settings for this fixed loopback-only address.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirectHandler())
    request = urllib.request.Request(url, headers={"Accept": "application/json", "Zotero-API-Version": "3"})
    try:
        with opener.open(request, timeout=2) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                raise ResearchError("ZOTERO_RESPONSE_TOO_LARGE", "Zotero response exceeded the 4 MiB safety limit.")
            payload = json.loads(raw.decode("utf-8"))
            if not isinstance(payload, (dict, list)):
                raise ResearchError("ZOTERO_SCHEMA_UNEXPECTED", "Zotero local API returned an unexpected response.")
            return payload, {key.lower(): value for key, value in response.headers.items()}
    except urllib.error.HTTPError as exc:
        code = "ZOTERO_API_DISABLED" if exc.code == 403 else "ZOTERO_NOT_READY" if exc.code == 503 else "ZOTERO_NOT_FOUND" if exc.code == 404 else "ZOTERO_REQUEST_FAILED"
        raise ResearchError(code, "Zotero local API request failed. Confirm Zotero is running and local API access is enabled.") from exc
    except (TimeoutError, urllib.error.URLError) as exc:
        raise ResearchError("ZOTERO_NOT_AVAILABLE", "Zotero local API is unavailable at localhost:23119; no library files were opened.") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ResearchError("ZOTERO_SCHEMA_UNEXPECTED", "Zotero local API returned malformed JSON.") from exc


def list_zotero_collections() -> dict[str, Any]:
    payload, headers = _zotero_request("users/0/collections?limit=100&format=json")
    rows = payload if isinstance(payload, list) else []
    collections = [{"key": row.get("key"), "name": (row.get("data") or {}).get("name"), "parentCollection": (row.get("data") or {}).get("parentCollection")} for row in rows if isinstance(row, dict)]
    return {"collections": collections, "serverId": headers.get("zotero-server-id"), "readOnly": True}


def get_zotero_item(key: str) -> dict[str, Any]:
    if not re.fullmatch(r"[A-Z0-9]{8}", key):
        raise ResearchError("ZOTERO_ITEM_KEY_INVALID", "Zotero item keys must be eight uppercase letters or digits.")
    payload, headers = _zotero_request(f"users/0/items/{key}?format=json")
    if not isinstance(payload, dict):
        raise ResearchError("ZOTERO_SCHEMA_UNEXPECTED", "Zotero local API item response was not an object.")
    return {"item": payload, "serverId": headers.get("zotero-server-id"), "readOnly": True}


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
        ris_type = "BOOK" if "book" in item_type else "CPAPER" if "proceeding" in item_type or "conference" in item_type else "JOUR" if "journal" in item_type or "article" in item_type else "GEN"
        lines.append(f"TY  - {ris_type}")
        for author in fields.get("authors") or []:
            lines.append(f"AU  - {_plain_text(str(author)) or ''}")
        mapping = (("title", "TI"), ("venue", "JO"), ("year", "PY"), ("doi", "DO"), ("url", "UR"), ("abstract", "AB"))
        for field, tag in mapping:
            value = fields.get(field)
            if value is not None:
                lines.append(f"{tag}  - {str(value).replace(chr(13), ' ').replace(chr(10), ' ')}")
        lines.append("ER  - ")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"
