#!/usr/bin/env python3
"""Derive today's read/write split for the GitHub MCP server from vendor source.

Release 0.3.15, P2 / T16-02. Fetches every non-test `pkg/github/*.go` blob on
branch `main` of github/github-mcp-server, parses each `NewTool(...)` declaration
for (toolset metadata constant, mcp.Tool Name, Annotations.ReadOnlyHint), and
writes a per-tool table next to this script.

Source receipt: the git tree API listing (paths, blob SHAs, sizes) is saved as
raw/pkg-github-tree.json so every parsed line is traceable to a blob SHA. The
Go blobs themselves are not stored in the evidence tree.

Vendor-source derived [D]. Not a live `tools/list` observation.
"""

import datetime
import json
import os
import re
import socket
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw")
REPO = "github/github-mcp-server"
REF = "main"
UA = {"User-Agent": "research-stack-toolkit/0.3.15 catalog-check", "Accept": "application/vnd.github+json"}

NAME_RE = re.compile(r'Name:\s*"([a-zA-Z0-9_]+)"')
RO_RE = re.compile(r"ReadOnlyHint:\s*(true|false)")
TOOLSET_RE = re.compile(r"ToolsetMetadata([A-Za-z0-9]+)")
CONST_RE = re.compile(r"Toolset(?:Metadata)?([A-Za-z0-9]+)\s*=\s*inventory\.ToolsetMetadata\{")


def get(url: str) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()


def snake(camel: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", camel).lower()


def main() -> int:
    socket.setdefaulttimeout(60)
    os.makedirs(RAW, exist_ok=True)
    tree = json.loads(get(f"https://api.github.com/repos/{REPO}/git/trees/{REF}?recursive=1"))
    blobs = [
        t for t in tree["tree"]
        if t["type"] == "blob" and t["path"].startswith("pkg/github/") and t["path"].endswith(".go")
        and not t["path"].endswith("_test.go")
    ]
    os.makedirs(RAW, exist_ok=True)
    with open(os.path.join(RAW, "pkg-github-tree.json"), "w", encoding="utf-8") as fh:
        json.dump({"fetched_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
                   "repo": REPO, "ref": REF, "sha_of_root_tree": tree.get("sha"),
                   "note": "blob paths + SHAs for every non-test pkg/github/*.go parsed by this script",
                   "blobs": [{"path": b["path"], "sha": b["sha"], "size": b["size"]} for b in blobs]},
                  fh, indent=2)
        fh.write("\n")

    tools = []
    toolsets = {}
    for b in blobs:
        src = get(f"https://raw.githubusercontent.com/{REPO}/{REF}/{b['path']}").decode("utf-8", "replace")
        # Toolset metadata declarations: ID + Default flag.
        consts = list(CONST_RE.finditer(src))
        for i, m in enumerate(consts):
            const = m.group(1)
            nxt = consts[i + 1].start() if i + 1 < len(consts) else m.start() + 900
            block = src[m.start():min(nxt, m.start() + 900)]
            id_m = re.search(r'ID:\s*"([a-z0-9_]+)"', block)
            default = bool(re.search(r"Default:\s*true", block))
            if id_m:
                toolsets[id_m.group(1)] = {"const": "ToolsetMetadata" + const, "default": default,
                                           "declared_in": b["path"], "blob_sha": b["sha"]}
        # Tool declarations: mcp.Tool{ Name: "...", ... Annotations: ... ReadOnlyHint: bool }
        # The toolset constant appears just before the mcp.Tool literal, in the NewTool[...] call.
        # Tool names are either string literals or Go constants (e.g. Name: DeleteRepositoryToolName).
        consts = dict(re.findall(r'([A-Za-z0-9_]+)\s*=\s*"([a-z0-9_]+)"', src))
        for m in re.finditer(r'Name:\s*(?:"([a-zA-Z0-9_]+)"|([A-Za-z][A-Za-z0-9_]*))', src):
            raw = m.group(1) or consts.get(m.group(2))
            if raw is None:
                continue
            tail = src[m.end():m.end() + 2500]
            head = src[max(0, m.start() - 500):m.start()]
            # Only treat it as a tool declaration when a ReadOnlyHint follows in the same literal
            # and a toolset constant precedes it.
            ro = RO_RE.search(tail)
            ts = None
            for ts_m in reversed(list(TOOLSET_RE.finditer(head))):
                ts = ts_m
                break
            if not ro and not ts:
                continue
            if ts is None:
                head2 = src[max(0, m.start() - 1500):m.start()]
                for ts_m in reversed(list(TOOLSET_RE.finditer(head2))):
                    ts = ts_m
                    break
            tools.append({
                "name": raw,
                "toolset_const": (("ToolsetMetadata" + ts.group(1)) if ts.group(1) != "Labels" else "ToolsetLabels") if ts else None,
                "toolset_id": snake(ts.group(1)) if ts else None,
                "read_only_hint": (ro.group(1) == "true") if ro else None,
                "file": b["path"],
                "blob_sha": b["sha"],
            })

    out = {
        "derived_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "repo": REPO,
        "ref": REF,
        "labels": "vendor source parse [D]; no tools/list was captured",
        "toolset_metadata": toolsets,
        "tool_declarations": tools,
    }
    with open(os.path.join(HERE, "vendor-source-tool-hints.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    names = sorted({t["name"] for t in tools})
    ro = sorted({t["name"] for t in tools if t["read_only_hint"] is True})
    wr = sorted({t["name"] for t in tools if t["read_only_hint"] is False})
    unknown = sorted({t["name"] for t in tools if t["read_only_hint"] is None})
    print("blobs parsed:", len(blobs))
    print("declarations:", len(tools), "unique names:", len(names))
    print("readOnlyHint true:", len(ro), " false:", len(wr), " unset:", len(unknown))
    print("toolset metadata ids:", len(toolsets), sorted(toolsets))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
