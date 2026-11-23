#!/usr/bin/env python3
"""Fetch the vendor's current documentation of the GitHub MCP server.

Release 0.3.15, package P2 (criteria T16-02). Downloads the pages GitHub
publishes today about the GitHub MCP server (tool names + toolset groupings),
stores the raw bytes under vendor-docs/raw/, a plain-text extract under
vendor-docs/text/, and writes vendor-docs/manifest.json with URL, fetch
timestamp, HTTP status, bytes and SHA-256 for every file.

Method receipt. No credential is used; every URL here is public documentation.
"""

import datetime
import hashlib
import html
import json
import os
import re
import socket
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
TEXT = os.path.join(HERE, "text")

PAGES = [
    # Vendor repository (github/github-mcp-server), branch main, raw markdown.
    ("github-mcp-server-README.md", "https://raw.githubusercontent.com/github/github-mcp-server/main/README.md"),
    ("github-mcp-server-docs-toolsets-and-icons.md", "https://raw.githubusercontent.com/github/github-mcp-server/main/docs/toolsets-and-icons.md"),
    ("github-mcp-server-docs-remote-server.md", "https://raw.githubusercontent.com/github/github-mcp-server/main/docs/remote-server.md"),
    ("github-mcp-server-docs-server-configuration.md", "https://raw.githubusercontent.com/github/github-mcp-server/main/docs/server-configuration.md"),
    ("github-mcp-server-docs-tool-renaming.md", "https://raw.githubusercontent.com/github/github-mcp-server/main/docs/tool-renaming.md"),
    ("github-mcp-server-docs-feature-flags.md", "https://raw.githubusercontent.com/github/github-mcp-server/main/docs/feature-flags.md"),
    ("github-mcp-server-docs-scope-filtering.md", "https://raw.githubusercontent.com/github/github-mcp-server/main/docs/scope-filtering.md"),
    # GitHub product documentation (docs.github.com).
    ("docs.github-com-configure-toolsets.html", "https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/configure-toolsets"),
    ("docs.github-com-set-up-the-github-mcp-server.html", "https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/set-up-the-github-mcp-server"),
    # Vendor source: toolset registry and the published tool catalog source of truth.
    ("github-mcp-server-pkg-github-tools.go", "https://raw.githubusercontent.com/github/github-mcp-server/main/pkg/github/tools.go"),
]

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\n{3,}")


def utcnow() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def html_to_text(raw: str) -> str:
    raw = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", raw)
    raw = re.sub(r"(?is)<br\s*/?>", "\n", raw)
    raw = re.sub(r"(?is)</(p|div|li|tr|h1|h2|h3|h4|section)>", "\n", raw)
    txt = html.unescape(TAG_RE.sub(" ", raw))
    txt = "\n".join(" ".join(line.split()) for line in txt.splitlines())
    return WS_RE.sub("\n\n", txt).strip()


def main() -> int:
    socket.setdefaulttimeout(40)
    os.makedirs(RAW, exist_ok=True)
    os.makedirs(TEXT, exist_ok=True)
    manifest = {"fetched_utc_start": utcnow(), "pages": []}
    for name, url in PAGES:
        req = urllib.request.Request(url, headers={"User-Agent": "research-stack-toolkit/0.3.15 catalog-check"})
        entry = {"name": name, "url": url, "fetched_utc": utcnow()}
        try:
            with urllib.request.urlopen(req) as resp:
                body = resp.read()
                entry["http_status"] = resp.status
                entry["content_type"] = resp.headers.get("Content-Type")
        except Exception as exc:  # noqa: BLE001
            entry["http_status"] = getattr(exc, "code", None)
            entry["error"] = f"{type(exc).__name__}: {exc}"
            manifest["pages"].append(entry)
            print(f"FAIL {name}: {entry['error']}")
            continue
        text = body.decode("utf-8", "replace")
        entry["bytes"] = len(body)
        entry["sha256"] = hashlib.sha256(body).hexdigest()
        raw_path = os.path.join(RAW, name)
        with open(raw_path, "wb") as fh:
            fh.write(body)
        entry["raw_file"] = os.path.relpath(raw_path, HERE)
        plain = html_to_text(text) if name.endswith(".html") else text
        text_path = os.path.join(TEXT, name.replace(".html", ".txt"))
        with open(text_path, "w", encoding="utf-8") as fh:
            fh.write(plain)
        entry["text_file"] = os.path.relpath(text_path, HERE)
        entry["text_chars"] = len(plain)
        manifest["pages"].append(entry)
        print(f"OK   {name}: {entry['http_status']} {entry['bytes']} B -> {entry['text_file']}")
    manifest["fetched_utc_end"] = utcnow()
    with open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
