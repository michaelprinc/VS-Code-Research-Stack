"""Zotero local-API check — a diagnostic for a person, not part of the Toolkit.

Run this on the computer where Zotero is installed. It is not packaged, not installed, and not
imported by the Toolkit. It asks the same loopback port the Toolkit asks, prints exactly what came
back, and says what each answer means. Nothing here writes anything, and nothing here leaves the
computer: every address below is loopback.

    python scripts/zotero_local_check.py

Exit code 0 means the Toolkit's own check would succeed. Exit code 1 means it would fail, and the
lines above the summary say why.
"""

import json
import sys
import urllib.error
import urllib.request

# Loopback only. These are the only two addresses this script can contact.
API_ROOT = "http://127.0.0.1:23119/api/"
COLLECTIONS_WITH_FORMAT = "http://127.0.0.1:23119/api/users/0/collections?limit=100&format=json"
COLLECTIONS_PLAIN = "http://127.0.0.1:23119/api/users/0/collections?limit=100"
COLLECTIONS_HEAD = "http://127.0.0.1:23119/api/users/0/collections"
CONNECTOR_PING = "http://127.0.0.1:23119/connector/ping"

MEANINGS = {
    200: "Zotero answered this request.",
    400: "Zotero rejected the request itself. The three documented reasons are a Host header it does not "
         "accept, a user ID other than 0, and an invalid format value. The body line below says which.",
    401: "Zotero refused this request as unauthenticated. A read needs no authentication, so this points at "
         "the request, not at a missing credential.",
    403: "Zotero refused a local client. If the body says 'Local API is not enabled' the cause is the "
         "setting: Settings -> Advanced -> 'Allow other applications on this computer to communicate with "
         "Zotero'. No restart is needed. If the body says 'Request not allowed' the setting is not the cause.",
    404: "Something is answering on port 23119 but did not recognise this path. Zotero is running; the "
         "request is not the one Zotero serves. Zotero before 7.0.16 has no local API at all.",
    405: "Something is answering on port 23119 but not to this method.",
    501: "Zotero answered that this API version or output format is not implemented.",
}


def ask(url, *, expect_json, method="GET"):
    """One bounded request to the loopback port. Returns a plain record; never raises."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(
        url,
        method=method,
        headers={"Accept": "application/json", "Zotero-API-Version": "3", "Zotero-Allowed-Request": "1"},
    )
    try:
        with opener.open(request, timeout=15) as response:
            raw = response.read(65_536)
            return {
                "url": url,
                "status": response.status,
                "headers": {k: v for k, v in response.headers.items() if k.lower().startswith("zotero") or k.lower() == "content-type"},
                "body": raw.decode("utf-8", "replace")[:240],
                "json": _maybe_json(raw) if expect_json else None,
            }
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read(4096).decode("utf-8", "replace")[:240]
        except Exception:
            body = ""
        return {"url": url, "status": exc.code, "headers": dict(exc.headers or {}), "body": body, "json": None}
    except urllib.error.URLError as exc:
        reason = getattr(exc, "reason", exc)
        refused = isinstance(reason, ConnectionRefusedError)
        return {"url": url, "status": None, "headers": {}, "body": str(reason)[:240],
                "json": None, "refused": refused}
    except Exception as exc:  # a closed connection, a reset, a timeout — all reported, never raised
        return {"url": url, "status": None, "headers": {}, "body": f"{type(exc).__name__}: {exc}"[:240], "json": None}


def _maybe_json(raw):
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


def report(record):
    print(f"\n  {record['url']}")
    if record["status"] is None:
        print(f"    No HTTP answer. {record['body']}")
        print("    Meaning: nothing usable replied on 127.0.0.1:23119.")
        return record
    print(f"    HTTP {record['status']} — {MEANINGS.get(record['status'], 'Zotero gave a status this check does not recognise.')}")
    for key, value in record["headers"].items():
        print(f"    header {key}: {str(value)[:120]}")
    if record["body"]:
        print(f"    body: {record['body'][:240]}")
    if isinstance(record["json"], list):
        print(f"    JSON list with {len(record['json'])} entries.")
    return record


def main():
    print("Zotero local API check — loopback only, nothing is written, nothing is sent off this computer.")
    print(f"Python {sys.version.split()[0]} on {sys.platform}")
    print("Zotero answers slowly when it is still loading your library, so each request here waits up to 15 s.")

    print("\n1. Is Zotero's HTTP server up at all? This answers even when the local API is off.")
    ping = report(ask(CONNECTOR_PING, expect_json=False))

    print("\n2. Is the path Zotero serves, and is this machine's Host header accepted?")
    print("   Zotero answers a HEAD before it consults the local-API setting, so this is a separate fact.")
    head = report(ask(COLLECTIONS_HEAD, expect_json=True, method="HEAD"))

    print("\n3. Is the local-API setting on, and can the library be read?")
    with_format = report(ask(COLLECTIONS_WITH_FORMAT, expect_json=True))

    print("\n4. The same request without the format parameter, in case the parameter is the problem.")
    plain = report(ask(COLLECTIONS_PLAIN, expect_json=True))

    print("\n5. The documented root, which Zotero says to ask first.")
    root = report(ask(API_ROOT, expect_json=True))

    all_of = (ping, head, with_format, plain, root)
    answered = [r for r in all_of if r["status"] is not None]
    refused = [r for r in all_of if r.get("refused")]
    collections_ok = any(r["status"] == 200 and isinstance(r["json"], list) for r in (with_format, plain))

    print("\n" + "=" * 78)
    if refused and not answered:
        print("RESULT: nothing answered on 127.0.0.1:23119.")
        print("  Zotero is not running, or its HTTP server is disabled, or another program holds the port")
        print("  (Zotero does not fall back to a different port), or Zotero was still starting when this ran.")
        print("  Run it again a minute after Zotero has fully opened.")
        return 1
    if ping["status"] == 200 and any(r["status"] == 403 for r in (with_format, plain, root)):
        print("RESULT: Zotero is running and its server is up, and it refuses the local API.")
        print("  Open Zotero: Settings -> Advanced -> 'Allow other applications on this computer to")
        print("  communicate with Zotero'. No restart is needed. Then run this script again.")
        return 1
    if any(r["status"] == 400 for r in answered):
        print("RESULT: Zotero rejected the request itself, with 400. The body line above names the reason.")
        return 1
    if collections_ok:
        print("RESULT: the Toolkit's own check would succeed. The collection listing answered.")
        return 0
    if answered:
        print("RESULT: something answered on 23119, but not with the collection listing the Toolkit asks for.")
        print("  Zotero is running. The request is the part that failed, and the status lines above say which.")
        print("  Send those lines to whoever maintains the Toolkit — they are the evidence the Toolkit")
        print("  itself cannot currently show you.")
        return 1
    print("RESULT: no usable answer from any endpoint.")
    print("  On Windows, if you ran this through something that sends a browser-style User-Agent, Zotero 8,")
    print("  9 and 10 close the connection without answering at all. Use python or curl.exe, not PowerShell's")
    print("  curl alias.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
