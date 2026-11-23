# Evidence: GitHub MCP catalog check, 2026-11-22

Release 0.3.15, package **P2** (criteria **T16-02**) with the **P6 / T16-05** assessment.
Repository baseline: `5995dfa` (0.3.14 + audit corrections), working tree as left by other agents.
Run window: **2026-11-23T01:30Z – 04:30Z** (every receipt carries its own UTC timestamp).
Analysis document: [research/github-mcp-catalog-check-2026-11-22.md](../../research/github-mcp-catalog-check-2026-11-22.md).

Inputs were read, never modified:

| Input | SHA-256 | State |
| --- | --- | --- |
| `extension/presets.json` | `ad0391ce860af1941af4759cfe22d0092b7d446c9d4c531e150653372b283223` | clean against `5995dfa` |
| `research/github-mcp-tool-map-2026-11-17.md` | `14baf6ab3ec9956302d5cd45d54ed34543f334ed99b4def0f56e66b7a3f6b035` | clean against `5995dfa` |

## What is in this folder

| File | What it is | Label |
| --- | --- | --- |
| `probe/anonymous-probe-receipt.json` | 6 MCP JSON-RPC requests (`initialize`, `tools/list`, plus one with the vendor's selection headers) against the two URLs the shipped presets name, with **no** Authorization header, no token, no OAuth. Exact HTTP status, response headers and response body for each. | **[M]** observation |
| `probe/probe_anonymous_mcp.py` | The script that produced that receipt (method, so the probe is reproducible). | method |
| `vendor-docs/manifest.json` | URL, fetch UTC timestamp, HTTP status, bytes, SHA-256 for every page fetched. | method |
| `vendor-docs/raw/*`, `vendor-docs/text/*` | The fetched pages: raw bytes, and plain text for the two `docs.github.com` HTML pages. | **[V]** vendor documentation |
| `vendor-docs/raw/pkg-github-tree.json` | Git-tree receipt (path, blob SHA, size) for the 84 non-test `pkg/github/*.go` blobs on `main` that the hint parser read. The Go blobs themselves are not stored here. | method |
| `vendor-docs/derive_vendor_source_hints.py` | Parser that reads those blobs and records, per tool declaration, the toolset constant and `Annotations.ReadOnlyHint`. | method |
| `vendor-docs/vendor-source-tool-hints.json` | Derived per-tool table: name → toolset id, `ReadOnlyHint`, declaring file, blob SHA. Plus the toolset metadata (ids, `Default: true`). | **[D]** from vendor source |
| `vendor-docs/compare_catalog.py`, `catalog-comparison.json`, `catalog-comparison.md` | Name-by-name comparison of the shipped lists against the vendor's current published catalog, with the three buckets and the per-toolset membership diff. | **[D]** |
| `preset-arithmetic.py`, `preset-arithmetic.json` | Re-derivation of every shipped count straight out of `extension/presets.json` (array lengths, `toolsEstimate` agreement, HR-35 toolset coverage, HR-36 headroom). | **[D]** from the shipped file |

No tokens, authorization headers, account identifiers or session ids appear in any file here: the probe used no credential, and the documentation pages are public.

## One-line status of each claim this folder touches

| Claim in the repo | Status after this check |
| --- | --- |
| 92 published GitHub tool names | catalog value as of 2026-11-17; today's vendor catalog publishes **95** local names. Open, and now known to be 3 names behind. |
| 57 read-only / 35 write | read-only **57** still agrees today; write is **38** today (the 3 alert-update tools). Open. |
| 42-name read-only selection | all 42 names are still published and still carry a read-only hint today. Selection itself is a choice, not a vendor count. |
| 22 / 14 toolset lists | both lists name toolset ids the vendor still publishes today; the 22-list now leaves 3 published names unnamed. |
| Any observed count | **no observation exists**; the only measured facts here are six 401 responses. |
