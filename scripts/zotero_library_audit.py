"""Zotero library audit — a read-only look at a library, for the person who owns it.

Run this on the computer where Zotero is installed. It is not packaged, not installed, and not imported
by the Toolkit. It reads a library through the same loopback port the Toolkit reads, and reports what
needs a human decision: records with no identifier, records whose item type looks wrong, and access
labels that an export will silently drop.

    python scripts/zotero_library_audit.py
    python scripts/zotero_library_audit.py --probe "gratia" --max-pages 30

What this script is allowed to do, in full:

  * GET and HEAD against http://127.0.0.1:23119 and nothing else. No POST, no PUT, no DELETE, no
    /api/local/authorize, no write key, and Zotero's localAPIKeys.json is never read.
  * Standard library only: urllib, json, re, argparse. No third-party package, no Zotero Python API.
  * It never writes a file, never opens zotero.sqlite, and never prints a credential. Everything it
    finds goes to the screen, where the operator can read it and decide.

Exit codes: 0 nothing to review · 1 items to review · 2 Zotero not reachable or the local API refused.

The library is read in pages of 100 items, up to a stated bound. When the bound is reached the audit
says so in the verdict and calls itself partial. A partial audit is never presented as a complete one.
"""

import argparse
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

# Loopback only. Every URL this script can build starts with this prefix, and only GET and HEAD are sent.
ALLOWED_PREFIX = "http://127.0.0.1:23119/"
CONNECTOR_PING = "connector/ping"
ITEMS_PAGE = "api/users/0/items?limit={limit}&start={start}&format=json"
COLLECTIONS = "api/users/0/collections?limit=100&format=json"
TAGS = "api/users/0/tags?limit=100&format=json"
SEARCHES = "api/users/0/searches?limit=100&format=json"
ITEM_TYPES = "api/itemTypes"

PAGE_SIZE = 100          # what Zotero's own API caps a page at
DEFAULT_MAX_PAGES = 20   # 2 000 items
MAX_PAGES_LIMIT = 50     # the most this script will ever be told to read: 5 000 items
REQUEST_TIMEOUT = 15
MAX_LISTED = 40          # how many rows of a list are printed before it says how many more there are

DEFAULT_PROBE = "canon law"

# The access labels the Toolkit's vocabulary uses. An access label in `extra` is a good place for it;
# what matters is that a CSL-JSON export will not carry it.
ACCESS_LABELS = ("metadata_only", "abstract_available", "full_text_available",
                 "partial_text_available", "access_denied", "unverified")

# Titles that read like Church legislation rather than an article about one. Measured cause: a RIS
# import mapped `TY - GEN` to journalArticle for the Codex of Canon Law and for apostolic constitutions.
LEGAL_TITLE_PATTERNS = (
    ("codex", r"codex"),
    ("kanonick / canonic", r"kanonick|canonic"),
    ("constitutio / constitution", r"constitutio|constitution"),
    ("encyclica / encyclical", r"encyclica|encyclical|encycl"),
    ("exhortation", r"exhortation|exhortatio"),
    ("decretum / dekret", r"decretum|dekret|decret"),
)
LEGAL_TITLE_RE = re.compile("|".join(f"(?:{pattern})" for _, pattern in LEGAL_TITLE_PATTERNS), re.IGNORECASE)

# An item type that is not a bibliographic record. A child note has no DOI because a note is not a
# publication, so counting it as a record with no identifier would be a false finding.
NON_BIBLIOGRAPHIC_TYPES = {"note", "attachment", "annotation"}

MEANINGS = {
    400: "Zotero rejected the request itself. The documented reasons are a Host header it does not accept, "
         "a user ID other than 0, and an invalid format value.",
    401: "Zotero refused this as unauthenticated. A read needs no authentication, so this points at the "
         "request, not at a missing credential.",
    403: "Zotero refused a local client. If the body says 'Local API is not enabled' the cause is the "
         "setting: Settings -> Advanced -> 'Allow other applications on this computer to communicate with "
         "Zotero'. No restart is needed.",
    404: "Something is answering on port 23119 but did not recognise this path. Zotero before 7.0.16 has "
         "no local API at all.",
    405: "Something is answering on port 23119 but not to this method.",
    501: "Zotero answered that this API version or output format is not implemented.",
}


def ask(path, *, method="GET", expect_json=True):
    """One bounded request to the loopback port. Returns a plain record; never raises."""
    url = ALLOWED_PREFIX + path.lstrip("/")
    if method not in ("GET", "HEAD") or not url.startswith(ALLOWED_PREFIX):
        # Unreachable with the constants above. Kept so that a future edit cannot widen the surface.
        return {"url": url, "status": None, "headers": {}, "body": "refused by the loopback guard",
                "json": None, "error_class": "LoopbackGuard", "refused": False}
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(
        url,
        method=method,
        headers={"Accept": "application/json", "Zotero-API-Version": "3", "Zotero-Allowed-Request": "1"},
    )
    try:
        with opener.open(request, timeout=REQUEST_TIMEOUT) as response:
            raw = response.read(4_194_304)
            return {
                "url": url,
                "status": response.status,
                "headers": {k: v for k, v in response.headers.items() if k.lower().startswith("zotero")
                            or k.lower() == "content-type"},
                "json": _maybe_json(raw) if expect_json else None,
                "error_class": None,
                "refused": False,
            }
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read(4096).decode("utf-8", "replace")[:240]
        except Exception:
            body = ""
        return {"url": url, "status": exc.code, "headers": dict(exc.headers or {}), "json": None,
                "body": body, "error_class": None, "refused": False}
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        return {"url": url, "status": None, "headers": {}, "json": None, "body": str(reason)[:240],
                "error_class": type(reason).__name__, "refused": isinstance(reason, ConnectionRefusedError)}
    except Exception as exc:  # a closed connection, a reset, a timeout — all reported, never raised
        return {"url": url, "status": None, "headers": {}, "json": None,
                "body": f"{type(exc).__name__}: {exc}"[:240], "error_class": type(exc).__name__, "refused": False}


def _maybe_json(raw):
    try:
        value = json.loads(raw.decode("utf-8"))
    except Exception:
        return None
    return value if isinstance(value, list) else None


def total_results(record):
    """Zotero's own count for this request, or None when Zotero did not send the header."""
    for key, value in (record.get("headers") or {}).items():
        if key.lower() == "zotero-total-results":
            return str(value)
    return None


def count_of(record, fallback):
    """Zotero's count when it gave one, otherwise what this audit actually read."""
    total = total_results(record)
    if total is not None:
        return total, "Zotero-Total-Results"
    return str(fallback), "counted from the page Zotero returned (no Zotero-Total-Results header)"


def not_answering(record, ping):
    """The actionable sentence for a Zotero that is not reading out its library."""
    print("\n" + "=" * 78)
    if record.get("refused") and ping.get("refused"):
        print("RESULT: nothing answered on 127.0.0.1:23119, so the library could not be audited.")
        print("  Zotero is not running, or its HTTP server is disabled, or another program holds the port")
        print("  (Zotero does not fall back to a different port), or Zotero was still starting when this ran.")
        print("  Open Zotero, wait a minute after the library finishes loading, and run this script again.")
        return 2
    if record["status"] is None:
        print(f"RESULT: no HTTP answer from {record['url']} — {record.get('error_class')}: {record['body']}")
        print("  Zotero's server did not reply to the library read. Run scripts/zotero_local_check.py")
        print("  for the endpoint-by-endpoint picture, then fix what it names.")
        return 2
    if record["status"] == 200:
        print("RESULT: Zotero answered 200, but the answer was not the list of items the local API returns.")
        print("  Nothing was audited. Run scripts/zotero_local_check.py: it prints the body and the headers")
        print("  of every request, which is what is needed to say what this Zotero actually returned.")
        return 2
    print(f"RESULT: Zotero answered the library read with HTTP {record['status']}, so nothing was audited.")
    print(f"  {MEANINGS.get(record['status'], 'Zotero gave a status this audit does not recognise.')}")
    if record.get("body"):
        print(f"  body: {record['body'][:240]}")
    if record["status"] == 403:
        print("  Open Zotero: Settings -> Advanced -> 'Allow other applications on this computer to")
        print("  communicate with Zotero'. No restart is needed. Then run this script again.")
    else:
        print("  Run scripts/zotero_local_check.py: it prints what each endpoint answered, which is the")
        print("  evidence needed to say which part of the request Zotero is refusing.")
    return 2


def read_items(max_pages):
    """Paginate the library. Returns (items, pages, first_record, truncated, total_reported)."""
    items = []
    pages = 0
    total_reported = None
    for page in range(max_pages):
        record = ask(ITEMS_PAGE.format(limit=PAGE_SIZE, start=page * PAGE_SIZE))
        if record["status"] != 200:
            return items, pages, record, False, total_reported
        pages += 1
        body = record["json"]
        if not isinstance(body, list):
            return items, pages, record, False, total_reported
        items.extend(body)
        total_reported = total_results(record) or total_reported
        if total_reported is not None and len(items) >= _as_int(total_reported, len(items)):
            return items, pages, None, False, total_reported
        if len(body) < PAGE_SIZE:
            return items, pages, record, False, total_reported
    truncated = total_reported is not None and len(items) < _as_int(total_reported, len(items) + 1)
    return items, pages, None, truncated, total_reported


def _as_int(value, fallback):
    try:
        return int(value)
    except (TypeError, ValueError):
        return fallback


def _data(item):
    value = item.get("data")
    return value if isinstance(value, dict) else {}


def _text(item, field):
    value = _data(item).get(field)
    return value.strip() if isinstance(value, str) else ""


def _title(item):
    return _text(item, "title") or "(no title in the record)"


def _key(item):
    return item.get("key") or _data(item).get("key") or "(no key)"


def _print_list(rows, note):
    for row in rows[:MAX_LISTED]:
        print(f"    {row}")
    if len(rows) > MAX_LISTED:
        print(f"    … and {len(rows) - MAX_LISTED} more, not listed here. The count above is the whole finding.")
    if note:
        print(f"    {note}")


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="zotero_library_audit.py",
        description="Audit a Zotero library through the loopback local API: counts, records with no "
                    "identifier, item types to review, and access labels an export will drop.",
        epilog="Read-only: GET and HEAD against 127.0.0.1:23119 only. No POST, PUT or DELETE, no "
               "/api/local/authorize, no write key, and Zotero's localAPIKeys.json is never read. No file "
               "is written and zotero.sqlite is never opened. Exit 0: nothing to review. Exit 1: items to "
               "review. Exit 2: Zotero not reachable or the local API refused.",
    )
    parser.add_argument("--probe", default=DEFAULT_PROBE, metavar="WORD",
                        help="probe word for the full-text index (default: %(default)s)")
    parser.add_argument("--max-pages", type=int, default=DEFAULT_MAX_PAGES, metavar="N",
                        help=f"how many pages of {PAGE_SIZE} items to read, 1 to {MAX_PAGES_LIMIT} "
                             f"(default: {DEFAULT_MAX_PAGES}, i.e. {DEFAULT_MAX_PAGES * PAGE_SIZE} items)")
    args = parser.parse_args(argv)

    max_pages = max(1, min(args.max_pages, MAX_PAGES_LIMIT))
    bound = max_pages * PAGE_SIZE

    print("Zotero library audit — read-only, loopback only, nothing is written and nothing is sent off this computer.")
    print(f"Python {sys.version.split()[0]} on {sys.platform}")
    print(f"Items are read in pages of {PAGE_SIZE}, at most {max_pages} pages, so at most {bound} items are read.")
    print("Zotero answers slowly while it is still loading a library, so each request waits up to "
          f"{REQUEST_TIMEOUT} s.")
    if args.max_pages != max_pages:
        print(f"  --max-pages {args.max_pages} was clamped to {max_pages}.")

    ping = ask(CONNECTOR_PING, expect_json=False)
    items, pages, first_bad, truncated, total_reported = read_items(max_pages)
    if first_bad is not None:
        return not_answering(first_bad, ping)

    print("\n1. Counts, as Zotero reported them.")
    counts = {}
    for label, path in (("collections", COLLECTIONS), ("tags", TAGS), ("saved searches", SEARCHES)):
        record = ask(path)
        if record["status"] == 200:
            counts[label], counts[label + " source"] = count_of(record, len(record["json"] or []))
        else:
            counts[label], counts[label + " source"] = "not answered", f"HTTP {record['status']}"
    counts["items"], counts["items source"] = count_of(
        {"headers": {"Zotero-Total-Results": total_reported} if total_reported is not None else {}}, len(items))
    for label in ("items", "collections", "tags", "saved searches"):
        print(f"    {label:<16} {counts[label]:>8}   ({counts[label + ' source']})")
    item_types = ask(ITEM_TYPES)
    if item_types["status"] == 200 and isinstance(item_types["json"], list):
        print(f"    item types Zotero lists: {len(item_types['json'])}")
    else:
        print(f"    item types: not answered (HTTP {item_types['status']})")

    print(f"\n2. Full-text index, probed with the word: {args.probe}")
    fulltext = ask("api/users/0/fulltext?since=0&q=" + urllib.parse.quote(args.probe) + "&limit=1")
    if fulltext["status"] == 200:
        matches = total_results(fulltext)
        if matches is None:
            print("    Zotero answered 200 but sent no Zotero-Total-Results header, so the number of matches is unknown.")
        else:
            print(f"    Zotero answers {matches} match(es) for this probe word.")
        print("    Caveat, and it matters: a zero answer is not proof the full-text index is empty. It says")
        print("    this probe word found nothing. Zotero's index only holds items Zotero has read in full,")
        print("    so an index that is empty for one word is empty for that word, and says nothing about the rest.")
    else:
        reason = MEANINGS.get(fulltext["status"], "no HTTP answer") if fulltext["status"] else fulltext.get("body", "")
        print(f"    The full-text endpoint did not answer (HTTP {fulltext['status']}). {reason}")
        print("    The endpoint needs `since`; without it Zotero answers 400. This audit sent since=0.")

    bibliographic = [item for item in items if _data(item).get("itemType") not in NON_BIBLIOGRAPHIC_TYPES]
    skipped = len(items) - len(bibliographic)

    print(f"\n3. Records with no DOI, no ISBN and no URL: {len(bibliographic)} bibliographic records were checked.")
    if skipped:
        print(f"    {skipped} child notes/attachments were skipped: a note has no DOI because a note is not a")
        print("    publication, and listing it here would be a false finding.")
    no_identifier = [item for item in bibliographic
                     if not _text(item, "DOI") and not _text(item, "ISBN") and not _text(item, "url")]
    if no_identifier:
        _print_list([f"{_key(item)}  {_title(item)}" for item in no_identifier],
                    "These records carry no identifier at all, so they cannot be deduplicated reliably. "
                    "No DOI, no ISBN and no URL means there is nothing to compare two copies against, and a "
                    "match guessed from a title alone is a guess.")
    else:
        print("    None. Every bibliographic record read carries a DOI, an ISBN or a URL.")

    print("\n4. Item type to review: journalArticle records whose title reads like legislation.")
    type_review = []
    for item in bibliographic:
        if _data(item).get("itemType") != "journalArticle":
            continue
        matched = [label for label, pattern in LEGAL_TITLE_PATTERNS if re.search(pattern, _title(item), re.IGNORECASE)]
        if matched:
            type_review.append((item, matched))
    if type_review:
        _print_list([f"{_key(item)}  {_title(item)}  <- {', '.join(matched)}" for item, matched in type_review],
                    "Reported as a type to review, not as a wrong type: Zotero's local API has no merge "
                    "endpoint and no duplicate endpoint, so a type fix is an edit of the item itself "
                    "(PUT api/users/0/items/<key> with If-Unmodified-Since-Version). This audit is read-only "
                    "and changes nothing.")
    else:
        print("    None. No journalArticle title matched codex, kanonick/canonic, constitutio/constitution, "
              "encyclica/encyclical, exhortation or decretum/dekret.")

    print("\n5. Access labels carried in the `extra` field.")
    labelled = []
    with_extra = 0
    for item in bibliographic:
        extra = _text(item, "extra")
        if not extra:
            continue
        with_extra += 1
        found = [label for label in ACCESS_LABELS if label in extra.lower()]
        if found:
            labelled.append((item, found))
    print(f"    {with_extra} record(s) carry a non-empty `extra`; {len(labelled)} carry a recognised access label.")
    if labelled:
        _print_list([f"{_key(item)}  {_title(item)}  <- {', '.join(found)}" for item, found in labelled],
                    "The label is in the right place. What follows from it: a CSL-JSON export carries "
                    "neither `extra` nor tags, so the access label is simply absent from a CSL-JSON export; "
                    "BibTeX carries `extra` as `annote`. An access label read out of CSL-JSON is missing, "
                    "not false — read it from the item, or carry it as a tag.")

    print("\n" + "=" * 78)
    review = len(no_identifier) + len(type_review)
    if truncated:
        print(f"AUDIT SCOPE: truncated. {len(items)} items were read out of {total_reported} Zotero reported, "
              f"within the bound of {bound}. The findings above cover the items read, not the whole library.")
    elif total_reported is not None and len(items) == _as_int(total_reported, len(items)):
        print(f"AUDIT SCOPE: complete. {len(items)} items read over {pages} page(s); Zotero reported {total_reported}.")
    else:
        print(f"AUDIT SCOPE: {len(items)} items read over {pages} page(s). Zotero sent no Zotero-Total-Results "
              "header, so this audit cannot say whether it read the whole library.")
    if review:
        print(f"VERDICT: {review} item(s) to review — {len(no_identifier)} with no identifier, "
              f"{len(type_review)} with an item type to review.")
        print("  An access label in `extra` is not counted as a defect here: it is where the label belongs. "
              "What it means is that a CSL-JSON export will not carry it.")
        return 1
    print("VERDICT: nothing to review. Every bibliographic record read carries an identifier, and no "
          "journalArticle title reads like Church legislation.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
