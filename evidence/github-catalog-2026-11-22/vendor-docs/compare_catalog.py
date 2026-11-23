#!/usr/bin/env python3
"""Name-by-name comparison: shipped preset lists vs the vendor's current catalog.

Release 0.3.15, P2 / T16-02. Inputs (all files inside this evidence folder or
the repository, each one re-read, never transcribed):

  vendor-docs/text/github-mcp-server-README.md              published catalog today  [V]
  vendor-docs/vendor-source-tool-hints.json                 read/write hints today   [D from vendor source]
  ../../research/github-mcp-tool-map-2026-11-17.md          the 2026-11-17 map       [D from vendor, 2026-11-17]
  ../../extension/presets.json                              the shipped presets      [file as shipped]

Writes catalog-comparison.json and catalog-comparison.md next to this script.
"""

import json
import os
import re
import collections

HERE = os.path.dirname(os.path.abspath(__file__))
EVIDENCE = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(EVIDENCE))

README = os.path.join(HERE, "text", "github-mcp-server-README.md")
HINTS = os.path.join(HERE, "vendor-source-tool-hints.json")
MAPMD = os.path.join(REPO, "research", "github-mcp-tool-map-2026-11-17.md")
PRESETS = os.path.join(REPO, "extension", "presets.json")

# README group heading -> toolset id used by the vendor in tools.go / remote URLs.
GROUP_TO_TOOLSET = {
    "Actions": "actions",
    "Code Quality": "code_quality",
    "Code Security": "code_security",
    "Context": "context",
    "Copilot": "copilot",
    "Copilot Issue Intents": "copilot_issue_intents",
    "Copilot Spaces": "copilot_spaces",
    "Dependabot": "dependabot",
    "Discussions": "discussions",
    "Gists": "gists",
    "Git": "git",
    "GitHub Support Docs Search": "github_support_docs_search",
    "Governance": "governance",
    "Issues": "issues",
    "Labels": "labels",
    "Notifications": "notifications",
    "Organizations": "orgs",
    "Projects": "projects",
    "Pull Requests": "pull_requests",
    "Repositories": "repos",
    "Secret Protection": "secret_protection",
    "Security Advisories": "security_advisories",
    "Stargazers": "stargazers",
    "Users": "users",
}
ICON_RE = re.compile(r"<picture>.*?</picture>")


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def parse_readme_catalog(md):
    start = md.index("<!-- START AUTOMATED TOOLS -->")
    end = md.index("<!-- END AUTOMATED TOOLS -->")
    section = md[start:end]
    groups = collections.OrderedDict()
    current = None
    for line in section.splitlines():
        s = line.strip()
        if s.startswith("<summary>"):
            title = ICON_RE.sub("", s).replace("<summary>", "").replace("</summary>", "").strip()
            current = title
            groups.setdefault(current, [])
        elif s.startswith("- **") and current:
            m = re.match(r"- \*\*([a-z0-9_]+)\*\*", s)
            if m:
                groups[current].append(m.group(1))
    # Remote-only section, outside the automated block.
    remote_marker = "### Additional Tools in Remote GitHub MCP Server"
    rstart = md.index(remote_marker)
    rend = md.index("## Read-Only Mode", rstart)
    remote = collections.OrderedDict()
    current = None
    for line in md[rstart:rend].splitlines():
        s = line.strip()
        if s.startswith("<summary>"):
            current = ICON_RE.sub("", s).replace("<summary>", "").replace("</summary>", "").strip()
            remote.setdefault(current, [])
        elif s.startswith("- **") and current:
            m = re.match(r"- \*\*([a-z0-9_]+)\*\*", s)
            if m:
                remote[current].append(m.group(1))
    # Toolsets table (local catalog).
    tstart = md.index("<!-- START AUTOMATED TOOLSETS -->")
    tend = md.index("<!-- END AUTOMATED TOOLSETS -->")
    toolsets = re.findall(r"\|\s*`([a-z_]+)`\s*\|", ICON_RE.sub("", md[tstart:tend]))
    return groups, remote, toolsets


def parse_map_table(md):
    start = md.index("## 3. Tool names by toolset")
    end = md.index("## 4. The three max presets", start)
    rows = {}
    for line in md[start:end].splitlines():
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) < 4 or cells[0] in ("Toolset", "") or "Total" in cells[0] or set(cells[1]) <= set("-: "):
            continue
        toolset = cells[0].replace("*", "")
        names = lambda col: re.findall(r"`([a-z0-9_]+)`", col)
        rows[toolset] = {"read": names(cells[2]), "write": names(cells[3])}
    rows.pop("copilot_automations", None)  # 0 published entries in the 2026-11-17 catalog
    all_names = sorted({n for r in rows.values() for n in r["read"] + r["write"]})
    read_names = sorted({n for r in rows.values() for n in r["read"]})
    write_names = sorted({n for r in rows.values() for n in r["write"]})
    entries = sum(len(r["read"]) + len(r["write"]) for r in rows.values())
    return rows, all_names, read_names, write_names, entries


def main():
    readme = read(README)
    groups, remote_groups, readme_toolsets = parse_readme_catalog(readme)
    hints = json.loads(read(HINTS))
    hint_by_name = {}
    for t in hints["tool_declarations"]:
        if t["read_only_hint"] is not None:
            hint_by_name.setdefault(t["name"], t["read_only_hint"])
    map_rows, map_all, map_read, map_write, map_entries = parse_map_table(read(MAPMD))
    presets = json.loads(read(PRESETS))
    p = {x["id"]: x for x in presets["presets"]}
    shipped_full = p["research-max-github-full"]["thirdParty"][0]["tools"]
    shipped_limited = p["research-max-github-limited"]["thirdParty"][0]["tools"]
    shipped_toolsets_full = p["research-max-github-full"]["thirdParty"][0]["toolsets"]
    shipped_toolsets_limited = p["research-max-github-limited"]["thirdParty"][0]["toolsets"]
    shipped_exclude = p["research-max-github-limited"]["thirdParty"][0]["server"]["excludeTools"]

    vendor_local = sorted({n for names in groups.values() for n in names})
    vendor_local_entries = sum(len(v) for v in groups.values())
    vendor_remote_only = sorted({n for names in remote_groups.values() for n in names})
    vendor_all_today = sorted(set(vendor_local) | set(vendor_remote_only))

    mapped_groups = {GROUP_TO_TOOLSET.get(g, g): v for g, v in groups.items()}
    S = set(shipped_full)
    M = set(map_all)
    V = set(vendor_local)
    VA = set(vendor_all_today)
    ro_today = sorted(n for n in vendor_all_today if hint_by_name.get(n) is True)
    wr_today = sorted(n for n in vendor_all_today if hint_by_name.get(n) is False)
    no_hint = sorted(n for n in vendor_all_today if n not in hint_by_name)
    L = set(shipped_limited)

    out = {
        "generated_utc": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(timespec="seconds"),
        "labels": {
            "vendor_catalog": "[V] names GitHub publishes today in the vendor README automated catalog",
            "vendor_source_hints": "[D] read/write classification parsed from vendor Go source today",
            "map_2026_11_17": "[D] names recorded in the tracked catalog map on 2026-11-17",
            "shipped_presets": "[file] lists as shipped in extension/presets.json",
            "measured": "none: no tools/list was captured (see probe/anonymous-probe-receipt.json)",
        },
        "vendor_today": {
            "readme_local_groups": {GROUP_TO_TOOLSET.get(k, k): v for k, v in groups.items()},
            "readme_local_entries": vendor_local_entries,
            "readme_local_unique": len(vendor_local),
            "readme_remote_only_groups": {GROUP_TO_TOOLSET.get(k, k): v for k, v in remote_groups.items()},
            "readme_remote_only_unique": len(vendor_remote_only),
            "readme_toolset_table_ids": readme_toolsets,
            "readme_toolset_table_count": len(readme_toolsets),
            "source_toolset_metadata_ids": sorted(hints["toolset_metadata"]),
            "source_default_true_toolsets": sorted(k for k, v in hints["toolset_metadata"].items() if v["default"]),
            "read_only_names_today": ro_today,
            "write_names_today": wr_today,
            "names_without_hint": no_hint,
        },
        "map_2026_11_17": {
            "catalog_entries": map_entries,
            "unique_names": len(map_all),
            "read_only_names": len(map_read),
            "write_names": len(map_write),
            "toolsets_with_entries": len(map_rows),
            "per_toolset": {k: {"read": v["read"], "write": v["write"]} for k, v in map_rows.items()},
            "names": map_all,
            "read_names": map_read,
            "write_names": map_write,
        },
        "shipped_presets": {
            "full_tools_len": len(shipped_full),
            "full_tools_estimate": p["research-max-github-full"]["thirdParty"][0]["toolsEstimate"],
            "full_toolsets_len": len(shipped_toolsets_full),
            "limited_tools_len": len(shipped_limited),
            "limited_tools_estimate": p["research-max-github-limited"]["thirdParty"][0]["toolsEstimate"],
            "limited_toolsets_len": len(shipped_toolsets_limited),
            "limited_exclude_len": len(shipped_exclude),
            "full_toolkit_len": len(p["research-max-github-full"]["tools"]),
            "limited_toolkit_len": len(p["research-max-github-limited"]["tools"]),
            "nogh_toolkit_len": len(p["research-max-no-github"]["tools"]),
        },
        "consistency": {
            "map92_equals_shipped92": M == S,
            "map92_symmetric_difference": sorted(M ^ S),
            "shipped_limited_subset_of_shipped_full": set(shipped_limited) <= S,
            "shipped_limited_subset_of_map_readonly": set(shipped_limited) <= set(map_read),
            "shipped_exclude_equals_map_writes": set(shipped_exclude) == set(map_write),
            "shipped_exclude_symmetric_difference": sorted(set(shipped_exclude) ^ set(map_write)),
        },
        "buckets_full_vs_vendor_today": {
            "both": sorted(S & VA),
            "shipped_only_stale_or_renamed": sorted(S - VA),
            "vendor_only_new_or_missing": sorted(VA - S),
            "counts": {
                "both": len(S & VA),
                "shipped_only_stale_or_renamed": len(S - VA),
                "vendor_only_new_or_missing": len(VA - S),
            },
        },
        "buckets_limited42_vs_vendor_readonly_today": {
            "both": sorted(set(shipped_limited) & set(ro_today)),
            "shipped_only": sorted(set(shipped_limited) - set(ro_today)),
            "vendor_readonly_only": sorted(set(ro_today) - set(shipped_limited)),
            "gap_from_toolsets_not_enabled": sorted(set().union(*[
                (set(mapped_groups.get(t, [])) & set(ro_today))
                for t in set(readme_toolsets) - set(shipped_toolsets_limited)
            ])),
            "gap_by_choice": sorted((set(ro_today) - L) - set().union(*[
                (set(mapped_groups.get(t, [])) & set(ro_today))
                for t in set(readme_toolsets) - set(shipped_toolsets_limited)
            ])),
            "toolsets_not_enabled_in_limited": sorted(set(readme_toolsets) - set(shipped_toolsets_limited)),
            "counts": {
                "both": len(set(shipped_limited) & set(ro_today)),
                "shipped_only": len(set(shipped_limited) - set(ro_today)),
                "vendor_readonly_only": len(set(ro_today) - set(shipped_limited)),
            },
        },
        "toolsets_membership_per_toolset": {
            k: {
                "vendor_today_entries": len(mapped_groups.get(k, [])),
                "map_2026_11_17_entries": len(map_rows.get(k, {}).get("read", [])) + len(map_rows.get(k, {}).get("write", [])),
                "new_in_vendor": sorted(set(mapped_groups.get(k, [])) - set(map_rows.get(k, {}).get("read", []) + map_rows.get(k, {}).get("write", []))),
                "gone_from_vendor": sorted(set(map_rows.get(k, {}).get("read", []) + map_rows.get(k, {}).get("write", [])) - set(mapped_groups.get(k, []))),
            }
            for k in sorted({GROUP_TO_TOOLSET.get(g, g) for g in groups} | set(map_rows))
        },
        "toolsets": {
            "vendor_readme_local_toolset_ids": sorted(readme_toolsets),
            "vendor_readme_local_toolset_ids_with_catalog_entries": sorted(GROUP_TO_TOOLSET.get(k, k) for k in groups),
            "vendor_source_toolset_ids": sorted(k for k in hints["toolset_metadata"] if k not in ("all", "default")),
            "shipped_full_toolsets": shipped_toolsets_full,
            "shipped_limited_toolsets": shipped_toolsets_limited,
            "full_toolsets_not_named_by_vendor": sorted(set(shipped_toolsets_full) - set(hints["toolset_metadata"])),
            "vendor_local_toolsets_not_in_full_preset": sorted(
                {k for k in readme_toolsets} - set(shipped_toolsets_full) - {"all", "default"}),
        },
    }

    with open(os.path.join(HERE, "catalog-comparison.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    lines = ["# Catalog comparison (generated by compare_catalog.py)", ""]
    b = out["buckets_full_vs_vendor_today"]
    lines.append(f"vendor catalog today (local README): {out['vendor_today']['readme_local_entries']} entries / "
                 f"{out['vendor_today']['readme_local_unique']} unique names")
    lines.append(f"vendor remote-only names today: {out['vendor_today']['readme_remote_only_unique']}")
    lines.append(f"map 2026-11-17: {out['map_2026_11_17']['catalog_entries']} entries / "
                 f"{out['map_2026_11_17']['unique_names']} unique / read {out['map_2026_11_17']['read_only_names']} / "
                 f"write {out['map_2026_11_17']['write_names']}")
    lines.append(f"vendor read-only names today (source hints): {len(out['vendor_today']['read_only_names_today'])}; "
                 f"write names today: {len(out['vendor_today']['write_names_today'])}")
    lines.append("")
    for k in ("both", "shipped_only_stale_or_renamed", "vendor_only_new_or_missing"):
        lines.append(f"## {k} ({len(b[k])})")
        lines.extend(f"- {n}" for n in b[k])
        lines.append("")
    b2 = out["buckets_limited42_vs_vendor_readonly_today"]
    for k in ("both", "shipped_only", "vendor_readonly_only"):
        lines.append(f"## limited42 vs vendor read-only today: {k} ({len(b2[k])})")
        lines.extend(f"- {n}" for n in b2[k])
        lines.append("")
    with open(os.path.join(HERE, "catalog-comparison.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))
    print(json.dumps({"vendor_local_unique": out["vendor_today"]["readme_local_unique"],
                      "vendor_local_entries": out["vendor_today"]["readme_local_entries"],
                      "vendor_remote_only": out["vendor_today"]["readme_remote_only_unique"],
                      "map_unique": out["map_2026_11_17"]["unique_names"],
                      "buckets": b["counts"], "limited_buckets": out["buckets_limited42_vs_vendor_readonly_today"]["counts"],
                      "consistency": {k: v for k, v in out["consistency"].items() if isinstance(v, bool)},
                      "no_hint": out["vendor_today"]["names_without_hint"]}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
