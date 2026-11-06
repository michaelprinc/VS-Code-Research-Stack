#!/usr/bin/env python3
"""Verify one bibliographic record against Crossref, then OpenAlex as a fallback.

Usage:
    python3 scripts/crossref_lookup.py "Practical Theology: An Introduction" --author Osmer --year 2008

NETWORK DISCLOSURE — read this before running it, and read it before installing this skill.
  - This script sends HTTPS GET requests to api.crossref.org and api.openalex.org. It sends
    no credentials and reads no file.
  - It is OPTIONAL. The Research Stack Toolkit installer never runs it, the control panel never
    runs it, and installing this bundle makes no network request of any kind. Only you, or the
    assistant you are working with, run it — from the command line, in the foreground, one
    citation at a time.
  - The User-Agent below carries a PLACEHOLDER contact address. Replace it, or pass your own
    address with --mailto, so Crossref's polite pool can identify the request.
  - Working directory: this script performs no file I/O, so it does not care where you run it
    from. The `scripts/...` spelling in SKILL.md assumes you are standing in the skill folder.

Why two services: Crossref is strong for journal articles and weak for monographs,
which is most of theological bibliography. OpenAlex covers books and reviews but mixes
them together, so a human always confirms the match.

No third-party packages required (stdlib only). Needs network access.
Exit codes — a service failure is never reported as "no match":
  0 = plausible candidate, author and year agree, and every service queried answered
  2 = NO PLAUSIBLE MATCH: the services answered and nothing matched
  3 = SERVICE FAILURE with no usable candidate: the lookup did not happen
  4 = a candidate was found but at least one service FAILED: partial evidence, not a verification
  5 = a candidate was found but its author or year does not match the request: resolve by eye
"No match" never means the work does not exist, and a service failure never means it either.
"""

import argparse
import json
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher

CROSSREF_API = "https://api.crossref.org/works"
OPENALEX_API = "https://api.openalex.org/works"
TIMEOUT_SECONDS = 30        # both APIs are slower at peak hours than a local call
CROSSREF_ROWS = 5           # enough candidates to disambiguate, few enough to read
OPENALEX_ROWS = 5
TITLE_MATCH_RATIO = 0.80    # below this the titles name different works, not spelling variants
# Placeholder on purpose: it is disclosed in SKILL.md and in README.md, and --mailto overrides it.
USER_AGENT = "theological-research-skill/2.0 (contact: set-your-email@example.org)"

SERVICE_ERRORS = (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError)
DOI_PREFIXES = ("https://doi.org/", "http://doi.org/", "info:doi/", "doi:")


def normalize(text: str) -> str:
    """Lowercase, strip diacritics and punctuation so translated titles can be compared."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^a-z0-9 ]", " ", text.lower())
    return " ".join(text.split())


def similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, normalize(a), normalize(b)).ratio()


def bare_doi(value) -> str:
    """OpenAlex returns `https://doi.org/10.x/y`, Crossref returns `10.x/y`. Record one form."""
    doi = str(value or "").strip().lower()
    for prefix in DOI_PREFIXES:
        if doi.startswith(prefix):
            doi = doi[len(prefix):]
            break
    return doi.strip(" /")


def fetch_json(url: str) -> dict:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        return json.load(response)


def from_crossref(args) -> list:
    params = {"query.bibliographic": args.title, "rows": CROSSREF_ROWS}
    if args.author:
        params["query.author"] = args.author
    if args.container:
        params["query.container-title"] = args.container
    if args.mailto:
        params["mailto"] = args.mailto
    payload = fetch_json(f"{CROSSREF_API}?{urllib.parse.urlencode(params)}")
    out = []
    for item in payload.get("message", {}).get("items", []):
        titles = item.get("title") or [""]
        out.append({
            "service": "crossref",
            "title": titles[0],
            "authors": [f"{a.get('family', '')}, {a.get('given', '')}".strip(", ")
                        for a in item.get("author", [])],
            "year": (item.get("published", {}).get("date-parts", [[None]])[0][0]),
            "container": (item.get("container-title") or [""])[0],
            "type": item.get("type", ""),
            "doi": bare_doi(item.get("DOI", "")),
            "url": item.get("URL", ""),
            "pages": item.get("page", ""),
            "volume": item.get("volume", ""),
            "publisher": item.get("publisher", ""),
        })
    return out


def from_openalex(args) -> list:
    search = args.title if not args.author else f"{args.title} {args.author}"
    params = {"search": search, "per_page": OPENALEX_ROWS}
    if args.year:
        params["filter"] = f"from_publication_date:{args.year - 1}-01-01,to_publication_date:{args.year + 1}-12-31"
    payload = fetch_json(f"{OPENALEX_API}?{urllib.parse.urlencode(params)}")
    out = []
    for item in payload.get("results", []):
        source = (item.get("primary_location") or {}).get("source") or {}
        out.append({
            "service": "openalex",
            "title": item.get("display_name", ""),
            "authors": [a.get("display_name", "") for a in item.get("authorships", [])],
            "year": item.get("publication_year"),
            "container": source.get("display_name", ""),
            "type": item.get("type", ""),
            # Normalised here: OpenAlex hands back a resolver URL, Crossref a bare handle.
            "doi": bare_doi(item.get("doi") or item.get("ids", {}).get("doi", "")),
            "url": item.get("ids", {}).get("doi", "") or item.get("id", ""),
            "pages": item.get("biblio", {}).get("begin_page", ""),
            "volume": item.get("biblio", {}).get("volume", ""),
            "publisher": (item.get("primary_location") or {}).get("publisher", {}).get("display_name", "")
                          if (item.get("primary_location") or {}).get("publisher") else "",
        })
    return out


def rank(candidates: list, args) -> dict:
    best, best_score = None, -1.0
    for c in candidates:
        title_score = similarity(args.title, c["title"])
        author_ok = (not args.author) or any(normalize(args.author) in normalize(a) for a in c["authors"])
        year_ok = (not args.year) or (c["year"] == args.year)
        score = title_score + (0.1 if author_ok else -0.2) + (0.05 if year_ok else -0.05)
        if score > best_score:
            c["title_similarity"] = round(title_score, 3)
            c["author_match"] = author_ok
            c["year_match"] = year_ok
            best, best_score = c, score
    return best


def report_service_failures(errors: list) -> None:
    print("SERVICE FAILURE (this is not 'no match'): " + " | ".join(errors))
    print("At least one service did not answer, so the lookup is incomplete. Treat the record as "
          "unverified. Do not conclude from this that the work does not exist.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify one citation against Crossref and OpenAlex")
    parser.add_argument("title", help="Title as exactly as it is known")
    parser.add_argument("--author", default="", help="Family name, if known")
    parser.add_argument("--year", type=int, default=0, help="Publication year, if known (0 means 'no year given')")
    parser.add_argument("--container", default="", help="Journal or book title, if known")
    parser.add_argument("--mailto", default="", help="Your contact email for Crossref's polite pool")
    parser.add_argument("--openalex", action="store_true", help="Skip Crossref and query OpenAlex only")
    args = parser.parse_args()

    errors = []
    candidates = []
    if not args.openalex:
        try:
            candidates = from_crossref(args)
        except SERVICE_ERRORS as exc:
            errors.append(f"crossref: {exc}")

    best = rank(candidates, args) if candidates else None
    if best is None or best["title_similarity"] < TITLE_MATCH_RATIO:
        try:
            oa = from_openalex(args)
        except SERVICE_ERRORS as exc:
            errors.append(f"openalex: {exc}")
            oa = []
        alt = rank(oa, args) if oa else None
        if alt and alt["title_similarity"] >= TITLE_MATCH_RATIO:
            best = alt

    if best is not None and best["title_similarity"] < TITLE_MATCH_RATIO:
        if errors:
            report_service_failures(errors)
            print(f"The only candidate was '{best['title']}' at title similarity {best['title_similarity']} "
                  "- a different work, and it does not make up for the service that failed.")
            return 4
        print(f"NO PLAUSIBLE MATCH. Closest candidate was '{best['title']}' "
              f"(title similarity {best['title_similarity']}) - that is a different work, not a citation.")
        print("Re-search with an alternative spelling or translated title, or check a library catalogue.")
        print("Until confirmed, mark the citation unverified or drop it.")
        return 2

    if best is None:
        if errors:
            report_service_failures(errors)
            return 3
        print("NO PLAUSIBLE MATCH in Crossref or OpenAlex.")
        print("Books in theology are often absent from both. Check a library catalogue (WorldCat, KNK) or the publisher.")
        print("Until confirmed, mark the citation unverified or drop it.")
        return 2

    print("CANDIDATE MATCH (confirm by eye before citing):")
    print(json.dumps(best, ensure_ascii=False, indent=2))
    if errors:
        report_service_failures(errors)
        print(f"The candidate above came from {best['service']} alone. It is partial evidence, not a verification.")
        return 4
    if not best["author_match"] or not best["year_match"]:
        print("WARNING: author or year does not match the request. Resolve before citing.")
        return 5
    print(f"Metadata candidate from {best['service']}. Nothing here means the work was read or checked by "
          "the toolkit: access status stays metadata_only until the text itself is read.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
