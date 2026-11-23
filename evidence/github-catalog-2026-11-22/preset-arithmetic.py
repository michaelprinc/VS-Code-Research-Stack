#!/usr/bin/env python3
"""Re-derive the shipped preset numbers from extension/presets.json itself.

Release 0.3.15, P2 (HR-34 named tools, HR-35 coverage by toolset, HR-36 budget).
Nothing here trusts the labels: every number is the length of the array in the
shipped file, and the file's own `toolsEstimate` is compared with it.

Writes preset-arithmetic.json next to this script.
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PRESETS = os.path.join(REPO, "extension", "presets.json")
COMPARISON = os.path.join(HERE, "vendor-docs", "catalog-comparison.json")

IDS = ("research-max-github-full", "research-max-github-limited", "research-max-no-github")


def main() -> int:
    data = json.load(open(PRESETS, encoding="utf-8"))
    comp = json.load(open(COMPARISON, encoding="utf-8"))
    ceiling = data["budget"]["clientCeiling"]
    min_headroom = data["budget"]["minimumHeadroom"]
    toolkit_ceiling = data["budget"]["toolkitCeilingPerPreset"]
    by_id = {p["id"]: p for p in data["presets"]}
    inventory = [t for s in data["servers"] for t in s["tools"]]

    vendor_ro = set(comp["vendor_today"]["read_only_names_today"])
    vendor_wr = set(comp["vendor_today"]["write_names_today"])
    groups = {k: set(v) for k, v in comp["vendor_today"]["readme_local_groups"].items()}

    out = {"budget_block": data["budget"], "presets": {}, "hr34_estimate_check": {}, "hr36_budget_check": {}}

    for pid in IDS:
        p = by_id[pid]
        toolkit = p["tools"]
        tp = p["thirdParty"][0] if p["thirdParty"] else None
        rec = {
            "toolkit_tools_len": len(toolkit),
            "toolkit_tools_unique": len(set(toolkit)),
            "toolkit_subset_of_registered_inventory": set(toolkit) <= set(inventory),
        }
        if tp:
            gh, est = tp["tools"], tp.get("toolsEstimate")
            toolsets = tp["toolsets"]
            covered = set().union(*(groups.get(t, set()) for t in toolsets)) if toolsets else set()
            rec.update({
                "github_tools_len": len(gh),
                "github_tools_unique": len(set(gh)),
                "toolsEstimate": est,
                "hr34_estimate_equals_length": est == len(gh),
                "readOnly_flag": tp.get("readOnly"),
                "toolsets_len": len(toolsets),
                "toolsets_unique": len(set(toolsets)),
                "exclude_tools_len": len(tp["server"].get("excludeTools", [])),
                "remote_url": tp["server"].get("remoteUrl"),
                # HR-35: every named GitHub tool must sit in a toolset the preset names.
                "names_not_covered_by_named_toolsets": sorted(set(gh) - covered),
                "toolset_entry_names_not_named": sorted(covered - set(gh)),
                # Write tools must not appear in a read-only preset.
                "named_names_with_write_hint_today": sorted(set(gh) & vendor_wr),
                "named_names_with_readonly_hint_today": sorted(set(gh) & vendor_ro),
                "named_names_without_a_source_hint_today": sorted(set(gh) - vendor_ro - vendor_wr),
            })
            if tp.get("readOnly"):
                rec["exclude_list_equals_vendor_write_names_today"] = set(tp["server"]["excludeTools"]) == vendor_wr
                rec["exclude_list_missing"] = sorted(vendor_wr - set(tp["server"]["excludeTools"]))
                rec["exclude_list_extra"] = sorted(set(tp["server"]["excludeTools"]) - vendor_wr)
        total = len(toolkit) + (rec.get("github_tools_len", 0))
        headroom = ceiling - total
        rec["total_named_tools"] = total
        rec["headroom"] = headroom
        out["presets"][pid] = rec
        out["hr34_estimate_check"][pid] = {
            "github_tools_len": rec.get("github_tools_len", 0),
            "toolsEstimate": rec.get("toolsEstimate"),
            "agree": rec.get("toolsEstimate") == rec.get("github_tools_len", 0),
            "toolkit_len": len(toolkit),
            "toolkit_estimate_agrees": True,  # toolkit verbs carry no estimate field; the count is the list length
        }
        out["hr36_budget_check"][pid] = {
            "toolkit_len": len(toolkit),
            "toolkit_ceiling": toolkit_ceiling,
            "toolkit_within_ceiling": len(toolkit) <= toolkit_ceiling,
            "total": total,
            "headroom": headroom,
            "minimum_headroom": min_headroom,
            "headroom_ok": headroom >= min_headroom,
        }

    out["registered_toolkit_inventory"] = {"len": len(inventory), "unique": len(set(inventory)),
                                           "note": "sum of extension/presets.json `servers[].tools` (the verbs the toolkit can name)"}
    with open(os.path.join(HERE, "preset-arithmetic.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    print(json.dumps(out, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
