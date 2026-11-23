# GitHub MCP catalog check — 2026-11-22

Research evidence for phase 16 package **P2** (criteria **T16-02**) and the **P6 / T16-05** question.
Baseline `5995dfa` (0.3.14 + audit corrections). No code file was changed: this is a research document
plus [evidence/github-catalog-2026-11-22/](../evidence/github-catalog-2026-11-22/).
Vendor pages were fetched **2026-11-23T02:04Z–02:22Z**; the anonymous endpoint probe ran **2026-11-23T01:59Z**.

## 0. How every number in this file is labelled

* **[M]** measured here. There are exactly **six** [M] facts in this document and they are six HTTP
  responses (§2). **No `tools/list` was captured**; no GitHub MCP server, local or remote, was started.
* **[V]** vendor-documented — GitHub states it in the page cited.
* **[D]** derived here by counting a vendor-published list or the vendor source, from a file saved under
  [evidence/github-catalog-2026-11-22/](../evidence/github-catalog-2026-11-22/).
* **[C]** claimed by this repository (a label or tip inside `extension/presets.json`).
* **[O]** open — a number the repo states that this check could not close.

## 1. Claimed vs catalog vs today's catalog vs measured

| Item | Claimed **[C]** | 2026-11-17 map **[D]** | Vendor catalog today **[V]/[D]** | Measured **[M]** |
| --- | --- | --- | --- | --- |
| Published tool entries (local) | — | 93 entries | **96 entries** | none **[O]** |
| Unique published tool names (local) | 92 | 92 | **95** | none **[O]** |
| Documented remote-only names | 2 (`copilot_spaces`, `github_support_docs_search` as endpoints) | 2 toolsets, names not pinned | **4 names** (`create_pull_request_with_copilot`, `get_copilot_space`, `list_copilot_spaces`, `github_support_docs_search`) | none **[O]** |
| Read-only names | 57 (and 42 selected) | 57 | **57** — the same 57 names, name for name | none **[O]** |
| Write names | 35 | 35 | **38** | none **[O]** |
| `research-max-github-full` GitHub names | 92, `toolsEstimate: 92` | 92 | 92 of 95 named; **3 published names unnamed** | none **[O]** |
| `research-max-github-limited` GitHub names | 42, `toolsEstimate: 42` | 42 | 42 of 57 published read-only names | none **[O]** |
| Toolsets (local ids) | 22 named / 14 named | 23 exist | **23 exist** (`copilot_automations` still publishes 0 catalog entries) | none **[O]** |
| Published deprecated aliases | 24 | 24 | **25** | none **[O]** |
| Any live server offer | never claimed | never claimed | — | **six 401 responses only** |

Reading the rows: the read-only half of the claim is still exactly right against today's vendor
documentation; the write half is 3 names short; the total is 3 local names plus 4 remote-only names short.
None of these is an observation — every column but the last is documentation arithmetic.

## 2. The live `tools/list` could not be produced: the probe that proves it

There is no GitHub test account and no token in this container. One anonymous MCP handshake was sent to
each URL the shipped presets name (`research-max-github-full` → `…/mcp/x/all`, `research-max-github-limited`
→ `…/mcp/readonly`), each as `initialize` then `tools/list`, plus one `initialize` carrying the vendor's own
selection headers (`X-MCP-Toolsets: context,repos,git,issues,pull_requests,labels,users,orgs,gists`,
`X-MCP-Readonly: true`) so that the failure cannot be blamed on missing selection headers.
Full receipt: [probe/anonymous-probe-receipt.json](../evidence/github-catalog-2026-11-22/probe/anonymous-probe-receipt.json),
method: [probe/probe_anonymous_mcp.py](../evidence/github-catalog-2026-11-22/probe/probe_anonymous_mcp.py).

| # | URL | JSON-RPC step | HTTP status | Response body | `www-authenticate` |
| --- | --- | --- | --- | --- | --- |
| 1 | `https://api.githubcopilot.com/mcp/x/all` | `initialize` | **401** | `bad request: missing required Authorization header` | `Bearer error="invalid_request", error_description="No access token was provided in this request", resource_metadata="…/.well-known/oauth-protected-resource/mcp/x/all"` |
| 2 | `…/mcp/x/all` | `tools/list` | **401** | same body | same |
| 3 | `…/mcp/x/all` | `initialize` + `X-MCP-Toolsets` | **401** | same body | same |
| 4 | `https://api.githubcopilot.com/mcp/readonly` | `initialize` | **401** | same body | same, `…/mcp/readonly` |
| 5 | `…/mcp/readonly` | `tools/list` | **401** | same body | same |
| 6 | `…/mcp/readonly` | `initialize` + `X-MCP-Toolsets` | **401** | same body | same |

`credential_used: false` is recorded in the receipt: no Authorization header, no bearer value, no OAuth flow,
no machine credential was used or read. **Consequence: every count in §1 and §4 is a documentation value and
the observed count owed by T16-02 remains owed.** The endpoints are alive and speak MCP-shaped errors, which
is the most that can be said from this container.

## 3. What the vendor documents today

Pages fetched and saved (URLs, UTC timestamps, bytes and SHA-256 in
[vendor-docs/manifest.json](../evidence/github-catalog-2026-11-22/vendor-docs/manifest.json)):

* `github/github-mcp-server` `main`: `README.md` (130 470 B) — toolset table `<!-- START AUTOMATED TOOLSETS -->`,
  tool catalog `<!-- START AUTOMATED TOOLS -->`, `### Additional Tools in Remote GitHub MCP Server`,
  `## Read-Only Mode`, `## Lockdown Mode`; `docs/remote-server.md`, `docs/server-configuration.md`,
  `docs/tool-renaming.md`, `docs/feature-flags.md`, `docs/toolsets-and-icons.md`,
  **`docs/scope-filtering.md`** (a page the 2026-11-17 map did not cite); `pkg/github/tools.go`,
  `pkg/github/server.go`, `pkg/github/inventory.go`, `pkg/github/deprecated_tool_aliases.go`.
* `docs.github.com`: *Configuring toolsets for the GitHub MCP Server* and *Setting up the GitHub MCP Server*
  (590 050 B and 827 174 B HTML; plain-text extracts saved alongside).
* Vendor Go source: the 84 non-test `pkg/github/*.go` blobs (path + blob SHA in
  [raw/pkg-github-tree.json](../evidence/github-catalog-2026-11-22/vendor-docs/raw/pkg-github-tree.json))
  parsed for `mcp.Tool.Name` + `Annotations.ReadOnlyHint` →
  [vendor-source-tool-hints.json](../evidence/github-catalog-2026-11-22/vendor-docs/vendor-source-tool-hints.json).

Counts read out of those files **[D from V]**:

| Count | Value | File it points at |
| --- | --- | --- |
| Local toolsets in the published table | 23 ids | `vendor-docs/text/github-mcp-server-README.md`, toolset table |
| Toolsets that carry catalog entries | 22 (23 − `copilot_automations`) | `catalog-comparison.json` → `toolsets_membership_per_toolset` |
| Published local entries / unique names | **96 / 95** (`get_label` is published in both `issues` and `labels`) | `catalog-comparison.json` → `vendor_today` |
| Documented remote-only names | 4 | `catalog-comparison.json` → `readme_remote_only_groups` |
| Read-only / write among the 95 | **57 / 38** | `vendor-source-tool-hints.json` (per-name `ReadOnlyHint` + blob SHA) |
| Names with no derivable hint | 4 (the remote-only four) | `catalog-comparison.json` → `names_without_hint` |
| Toolsets marked `Default: true` in source | 6: `context`, `repos`, `issues`, `pull_requests`, `users`, `copilot` | `vendor-source-tool-hints.json` → `toolset_metadata` |
| Source tool declarations overall (incl. feature-gated and automation names) | 132 unique names, 60 read / 62 write / 10 non-tool artifacts | `vendor-source-tool-hints.json` |
| Published deprecated aliases | 25 rows | `vendor-docs/text/github-mcp-server-docs-tool-renaming.md`, `…deprecated_tool_aliases.go` |
| `/readonly` vs `/x/all/readonly` | `/readonly` = **default toolsets** in read-only mode; `/x/all/readonly` = **all** toolsets in read-only mode **[V]** | `vendor-docs/text/github-mcp-server-docs-remote-server.md`, "URL Path Parameters" |

Two vendor-side statements matter for how a preset should read its own numbers:

1. **`/readonly` is not "all read-only tools"** — it is the default toolsets filtered to read-only. The
   shipped `research-max-github-limited` entry uses `/readonly` and *simultaneously* sends
   `X-MCP-Toolsets` for its 14 toolsets **[C, `presetselect.remoteEntry`]**, so the toolsets header — not the
   URL suffix — is what fixes the surface. Nothing here measures which of the two wins in practice **[O]**.
2. **The server's own offer depends on the credential type** **[V, `docs/scope-filtering.md`]**: a classic
   PAT hides tools whose scopes it lacks at startup; fine-grained PATs, GitHub App and server-to-server
   tokens show everything. A captured `tools/list` is therefore only meaningful together with the auth mode
   and the account's permissions — T16-02's "date, endpoint, account, selection" wording is exactly this.

## 4. Name by name: the three buckets

`research-max-github-full` names 92 tools. The vendor's current catalog documents 99 names
(95 local + 4 remote-only). Full lists:
[catalog-comparison.md](../evidence/github-catalog-2026-11-22/vendor-docs/catalog-comparison.md) and
[catalog-comparison.json](../evidence/github-catalog-2026-11-22/vendor-docs/catalog-comparison.json).

| Bucket | Count | Exact names |
| --- | --- | --- |
| **In both** (shipped list ∩ current vendor catalog) | **92** | every name of the shipped list; the full list is byte-identical to the 2026-11-17 map's §3 table (`map92_equals_shipped92: true`) |
| **Shipped list only** — stale or renamed | **0** | — none. No shipped name was removed or renamed by the vendor since 2026-11-17. |
| **Vendor documents today, shipped list lacks** — new or missing | **7** | local catalog entries: `update_code_scanning_alert` (`code_security`), `update_dependabot_alert` (`dependabot`), `update_secret_scanning_alert` (`secret_protection`); documented remote-only: `create_pull_request_with_copilot` (`copilot`), `get_copilot_space`, `list_copilot_spaces` (`copilot_spaces`), `github_support_docs_search` (`github_support_docs_search`) |

Per-toolset membership moved in exactly three places (22 toolsets compared):

| Toolset | 2026-11-17 | Today | Change |
| --- | --- | --- | --- |
| `code_security` | 2 | 3 | + `update_code_scanning_alert` |
| `dependabot` | 2 | 3 | + `update_dependabot_alert` |
| `secret_protection` | 2 | 3 | + `update_secret_scanning_alert` |
| the other 19 | unchanged | unchanged | identical name sets |

The three new names all carry `ReadOnlyHint: false` in the vendor source today, which is why the write count
moved 35 → 38 while the read-only count stayed 57 name-for-name.

### 4.1 The 42-name read-only selection against today's published read-only names

| Bucket | Count | Names |
| --- | --- | --- |
| **Both** (selected and still published read-only) | **42** | the whole selection; none of it is stale and none of it names a tool that carries a write hint today (`named_names_with_write_hint_today: []`) |
| **Selected only** — stale, renamed, or mis-hinted | **0** | — |
| **Vendor publishes read-only, selection does not name** | **15** | `actions_get`, `actions_list`, `custom_properties_read`, `get_discussion`, `get_discussion_comments`, `get_job_logs`, `get_notification_details`, `list_discussion_categories`, `list_discussions`, `list_notifications`, `list_starred_repositories`, `projects_get`, `projects_list`, `repository_ruleset_read`, `ui_get` |

That 15 splits exactly as the preset's own note claims **[C]**: 14 belong to the nine toolsets the limited
preset does not enable (`actions`, `copilot`, `copilot_automations`, `copilot_issue_intents`, `discussions`,
`governance`, `notifications`, `projects`, `stargazers`) and `ui_get` is left out by choice. The note is
still arithmetically true against today's catalog — but it is true because 57 read-only names are published
today, which is a **[D from V]** value, not a measurement.

### 4.2 The exclusion list is now three names short

`research-max-github-limited` states it excludes "all 35 write tools" **[C]**. Its `server.excludeTools`
array is 35 names long and equals the 2026-11-17 write set
(`shipped_exclude_equals_map_writes: true`), but it **misses** the three names the vendor added:
`update_code_scanning_alert`, `update_dependabot_alert`, `update_secret_scanning_alert`
(`exclude_list_missing`). The server-side read-only switch is still written as well
(`GITHUB_READ_ONLY` / `X-MCP-Readonly`), so the safety net is not the exclude list — the point is that HR-35's
"coverage checked by toolset" now reports a named gap, and the gap is in the alert-update trio.

## 5. Re-derivation from the shipped file (HR-34)

Recounted straight out of `extension/presets.json`, not from any label
([preset-arithmetic.json](../evidence/github-catalog-2026-11-22/preset-arithmetic.json)):

| Preset | Toolkit `tools` length | GitHub names length | `toolsEstimate` | HR-34: estimate = length? | Toolsets length | `excludeTools` length | Total named | Headroom vs 128 | HR-36 (≥ 20)? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `research-max-github-full` | 16 | **92** (92 unique, no duplicates) | 92 | **yes** | 22 (22 unique) | 0 | **108** | **20** | yes, exactly at the floor |
| `research-max-github-limited` | 20 | **42** (42 unique) | 42 | **yes** | 14 (14 unique) | 35 | **62** | 66 | yes |
| `research-max-no-github` | 20 | 0 (`thirdParty: []`) | — (no estimate field) | not applicable | — | — | 20 | 108 | yes |

Additional checks the same script ran: no duplicate name in any list; every toolkit verb in the three presets
is a member of the registered inventory in `servers[].tools`, which today holds **21** verbs
(`embed_corpus` included) against a per-preset ceiling of 20; all 92 and all 42 names sit inside the toolsets
the preset names (`names_not_covered_by_named_toolsets: []`).

**HR-34 is satisfied as shipped: both `toolsEstimate` values equal the length of their arrays.** What the
file does *not* satisfy is the implication of its own budget note — "a preset may not offer a surface whose
tools the toolkit cannot name from a reviewed source": the surface it points at (`/x/all`) is documented
today as wider than the 92 names it lists (95 local + 4 remote-only, and `/x/all` also enables
`copilot_automations`, whose 11 names exist in source and publish no catalog entry). If the harness honours
the `tools` allow-list, the named 92 cap the surface and headroom stays 20; if it does not, the offer is at
least 95 and 16 + 95 = 111 leaves **17**, below the 20-tool floor. Which of those happens is P6/T16-11
territory and is unmeasured here **[O]**.

## 6. The toolset variant question

| Question | Answer from today's vendor pages **[V]/[D]** |
| --- | --- |
| Which toolset names does the vendor document today? | 23 local ids in the README table: `actions`, `code_quality`, `code_security`, `context`, `copilot`, `copilot_automations`, `copilot_issue_intents`, `dependabot`, `discussions`, `gists`, `git`, `governance`, `issues`, `labels`, `notifications`, `orgs`, `projects`, `pull_requests`, `repos`, `secret_protection`, `security_advisories`, `stargazers`, `users`; plus 2 remote-only ids `copilot_spaces`, `github_support_docs_search`; plus the special `all` and `default`. Same 23 local ids as 2026-11-17 — **no toolset was added or removed**. |
| Does that match the 22-list of `full`? | Yes: 23 − `copilot_automations`, which still publishes **0** catalog entries while keeping a table row and a `/x/copilot_automations` URL. The preset's stated reason is still accurate. |
| Does that match the 14-list of `limited`? | Yes: all 14 ids (`context`, `repos`, `git`, `issues`, `pull_requests`, `labels`, `users`, `orgs`, `gists`, `code_quality`, `code_security`, `secret_protection`, `dependabot`, `security_advisories`) are vendor ids today. |
| Membership wording differences | The README labels catalog groups by display name (`Repositories`, `Organizations`, `Security Advisories`, `Code Quality`…) while the ids and URLs use `repos`, `orgs`, `security_advisories`, `code_quality`. `get_label` is published in two groups (`issues`, `labels`): 96 entries, 95 names — HR-35's "one name may be published in several toolsets" is visible in the vendor table itself. |
| Default toolsets — the disagreement is still open **[O]** | Vendor source: 6 with `Default: true` (`context`, `repos`, `issues`, `pull_requests`, `users`, `copilot`). docs.github.com *Configuring toolsets*: "default toolsets ( `repos`, `issues`, and `pull_requests` )". docs.github.com also calls `copilot` a **remote-only** toolset, while the README publishes a local `copilot` group with 2 catalog entries and the source marks it `Default: true`. Nothing in this container can decide which text is current. |
| Names the vendor documents that are not toolset ids | Still none of `commits`, `branches`, `teams`, `codesecurity`, `web_search`. `web_search` did not appear in any page fetched here. |
| Source-only surfaces a preset count cannot cover | `copilot_automations` (11 names in `pkg/github/agent_automations.go`, 0 catalog entries), the granular feature flags (`issues_granular`, `pull_requests_granular` — the parsed source carries 132 names in total), insiders mode, and the new `--features=skills` MCP Skills block, which replaces server instructions rather than adding tool names. Any preset count is void with those on. |

## 7. T16-05 as a question: what a read-only `verifyPresetTools` could and could not close

`verifyPresetTools` does not exist in this tree — the only mention of it is the proposal in
`specs/phase-16-next-release-recommendations/recommendations.md` §P6; the shipped writer is
`extension/presetselect.js` (`remoteEntry` / `localEntry` / `mergeIntoMcpFile`, command
`researchToolkit.configurePresetTools`), and no verify verb or command is registered.

* **What it can verify from a captured `tools/list`:** the file the Toolkit wrote — that the `github` entry
  is Toolkit-owned (the `//researchStackPreset` marker names this toolkit and its presetId), that the variant
  (remote `type: "http"` + `url` or local `type: "stdio"` + `command`) matches the plan, that the `tools`
  array is exactly the expected set with no duplicates, that the selection headers / env vars carry the named
  toolsets, the read-only switch and the exclude list, and that no authorization value is present in the
  output or in the diffs it reports. Compared against a **captured** `tools/list` it can also name the drift
  in the other direction: which names the server actually offered that the preset does not name (today, on
  documentation alone, that is 3 local + 4 remote-only names), and whether the server offered a name the
  preset treats as read-only with a write hint. Both directions are file-vs-list comparisons, which is what a
  read-only check can honestly do.
* **What it cannot verify:** that Copilot honours `mcpServers[].tools` at all. The per-server `tools`
  allow-list is vendor-documented for the native `mcpServers` format (2026-11-17 map §1.4; P6), and the
  deprecated editor `servers` format has no such field — a verify verb reading the file proves the file, not
  the harness. It also cannot see the Tools-tab state, cannot see what a session actually offered, cannot
  decide which of `X-MCP-Toolsets`, `X-MCP-Readonly` and the URL suffix the remote server applied, and cannot
  turn `ReadOnlyHint` into a permission boundary: what the token may do is decided by GitHub.
* **What must be captured on the reference host for the claim to close:** (a) a full, paged `tools/list` per
  configuration — `/mcp/x/all`, `/mcp/x/all/readonly`, and the two effective configurations `remoteEntry()`
  writes for the full and limited presets, with the limited run using its exact headers — each recorded with
  date, endpoint, auth mode and the account's permission scope, names only and no tokens; (b) the same names
  Copilot itself offers in a new session for that server entry; and (c) T16-11's control case, a configuration
  in which the server offers at least one name the allow-list forbids, so the observation tests the effect of
  `tools` directly. (a) closes the count claim of T16-02, (b) and (c) close T16-05's and T16-11's behaviour
  claim. Without (a) the numbers in this repository stay catalog values, and the honest status of T16-02 is
  "open, with the documentation half done and the measurement owed".

## 8. What this does not prove

1. **Nothing about a live GitHub MCP server.** The only observation is that both preset URLs answer 401 to an
   anonymous MCP request. No tool name, count, ordering, pagination, description or hint was observed.
2. **The 95 / 57 / 38 / 99 figures are vendor documentation read today, not what a server offers.** The
   published catalog is generated from the vendor source on `main` at fetch time; a released binary, a pinned
   container image, an insiders build, a feature-flag build, or a token whose scopes hide tools can all offer
   a different set.
3. **The read/write split is a hint, not a permission.** `ReadOnlyHint: false` on the three new alert tools
   says the vendor marks them as writes; it does not say a read-only switch or an exclude list makes anything
   safe, and no write call was attempted anywhere here.
4. **The three buckets compare names against documentation.** "Stale or renamed" = "the vendor's published
   catalog no longer lists it today", not "a server would reject it". A removed name might still resolve
   through the alias table, and the alias table itself grew from 24 rows to 25.
5. **The vendor's own pages disagree** (default toolsets 3 vs 6; `copilot` remote-only vs local with catalog
   entries). This check records the disagreement; it does not resolve it.
6. **The preset numbers are self-consistent, not correct.** HR-34's estimate = length holds and HR-36's
   headroom holds *as written*; whether the surface those numbers describe is the surface a host offers is
   still P1/P6 evidence **[O]**.
7. **Other agents were editing the tree during this run.** `extension/presets.json` and
   `research/github-mcp-tool-map-2026-11-17.md` were verified unmodified (SHA-256 in the evidence README),
   but `src/research_stack/*`, `scripts/*`, `tests/*` and other `extension/*` files were not, and nothing
   here speaks for them. No file outside `research/` and `evidence/github-catalog-2026-11-22/` was written
   and no commit was made.

## 9. Next highest-value action

Capture the `tools/list` receipts named in §7(a) on the reference host with a test account, then re-run
`compare_catalog.py` against the captured lists instead of the vendor README. Until then the two edits P2
would otherwise justify — naming the three new local catalog entries in `research-max-github-full` (which
would push 108 → 111 and break HR-36's floor, so the headroom decision has to move with it) and adding the
same three names to `research-max-github-limited`'s exclude list — should stay a decision backed by a
measurement, not by this document.

## 10. Sources

* GitHub MCP server repository (fetched 2026-11-23): [README](https://github.com/github/github-mcp-server) ·
  [docs/remote-server.md](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) ·
  [docs/server-configuration.md](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md) ·
  [docs/tool-renaming.md](https://github.com/github/github-mcp-server/blob/main/docs/tool-renaming.md) ·
  [docs/feature-flags.md](https://github.com/github/github-mcp-server/blob/main/docs/feature-flags.md) ·
  [docs/toolsets-and-icons.md](https://github.com/github/github-mcp-server/blob/main/docs/toolsets-and-icons.md) ·
  [docs/scope-filtering.md](https://github.com/github/github-mcp-server/blob/main/docs/scope-filtering.md) ·
  [pkg/github/tools.go](https://github.com/github/github-mcp-server/blob/main/pkg/github/tools.go) ·
  [pkg/github/deprecated_tool_aliases.go](https://github.com/github/github-mcp-server/blob/main/pkg/github/deprecated_tool_aliases.go)
* GitHub product documentation: [Configuring toolsets for the GitHub MCP Server](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/configure-toolsets) ·
  [Setting up the GitHub MCP Server](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/set-up-the-github-mcp-server)
* Tracked catalog this preset surface was built from: [research/github-mcp-tool-map-2026-11-17.md](github-mcp-tool-map-2026-11-17.md)
* Evidence folder: [evidence/github-catalog-2026-11-22/README.md](../evidence/github-catalog-2026-11-22/README.md)
