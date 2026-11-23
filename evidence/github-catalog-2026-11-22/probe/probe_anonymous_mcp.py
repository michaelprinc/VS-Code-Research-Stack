#!/usr/bin/env python3
"""Anonymous MCP JSON-RPC probe of the GitHub remote MCP server.

Purpose (release 0.3.15, package P2 / criteria T16-02):
prove the boundary of what this container can observe. There is no GitHub test
account and no token in this environment, so a real `tools/list` cannot be
captured. This script sends a normal MCP `initialize` and `tools/list`
JSON-RPC body over HTTP to the two endpoints the shipped presets name, with
NO Authorization header and NO credential of any kind, and records the exact
HTTP status and response body for each step.

Method receipt. Writes probe/anonymous-probe-receipt.json next to itself.
"""

import datetime
import json
import os
import socket
import ssl
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "anonymous-probe-receipt.json")

ENDPOINTS = [
    ("research-max-github-full server URL", "https://api.githubcopilot.com/mcp/x/all"),
    ("research-max-github-limited server URL", "https://api.githubcopilot.com/mcp/readonly"),
]

PROTOCOL_VERSION = "2025-06-18"

INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "research-stack-toolkit-catalog-check", "version": "0.3.15"},
    },
}

TOOLS_LIST = {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}


def utcnow() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def post(url: str, body: dict, session_id: str | None, extra_headers: dict | None = None) -> dict:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "User-Agent": "research-stack-toolkit/0.3.15 catalog-check (anonymous probe)",
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    if extra_headers:
        headers.update(extra_headers)
    # Deliberately no Authorization / Bearer / PAT header anywhere.
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    ctx = ssl.create_default_context()
    record = {"utc_timestamp": utcnow(), "url": url, "jsonrpc_body": body, "request_headers": dict(headers)}
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
            raw = resp.read()
            record["http_status"] = resp.status
            record["response_headers"] = dict(resp.headers.items())
            record["response_body"] = raw.decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        raw = exc.read() if exc.fp else b""
        record["http_status"] = exc.code
        record["error_class"] = "HTTPError"
        record["response_headers"] = dict(exc.headers.items()) if exc.headers else {}
        record["response_body"] = raw.decode("utf-8", "replace")
    except Exception as exc:  # noqa: BLE001 - record whatever the failure actually is
        record["http_status"] = None
        record["error_class"] = type(exc).__name__
        record["response_body"] = f"{type(exc).__name__}: {exc}"
    return record


def main() -> int:
    socket.setdefaulttimeout(30)
    results = []
    for label, url in ENDPOINTS:
        steps = []
        init = post(url, INITIALIZE, None)
        steps.append({"step": "initialize", **init})
        sid = None
        hdrs = init.get("response_headers") or {}
        for k, v in hdrs.items():
            if k.lower() == "mcp-session-id":
                sid = v
        steps.append({"step": "tools/list", **post(url, TOOLS_LIST, sid)})
        # Second pass: the same calls with the vendor's own selection headers,
        # still anonymous, to show that the 401 gate is authentication, not headers.
        steps.append(
            {
                "step": "initialize + X-MCP-Toolsets",
                **post(
                    url,
                    INITIALIZE,
                    None,
                    {"X-MCP-Toolsets": "context,repos,git,issues,pull_requests,labels,users,orgs,gists",
                     "X-MCP-Readonly": "true"},
                ),
            }
        )
        results.append(
            {
                "preset_server": label,
                "url": url,
                "authentication_used": "none (no token, no OAuth, no Authorization header)",
                "steps": steps,
            }
        )

    doc = {
        "captured_utc": utcnow(),
        "tool": "python3 urllib (no curl in this container)",
        "script": os.path.relpath(os.path.abspath(__file__), HERE),
        "python": sys.version.split()[0],
        "credential_used": False,
        "note": (
            "No GitHub test account and no token exist in this container, so no live tools/list "
            "could be captured. These are the raw anonymous responses that establish that boundary."
        ),
        "endpoints": results,
    }
    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    for r in results:
        for s in r["steps"]:
            body = (s.get("response_body") or "")[:400]
            print(f"{r['url']}  {s['step']:32s}  status={s.get('http_status')}  {s.get('error_class','')}")
            print(f"   body[:400] = {body!r}")
    print(f"\nWrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
