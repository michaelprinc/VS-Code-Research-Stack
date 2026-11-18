# GitHub MCP tool map for the three "max" presets — 2026-11-17

Research input for phase 15 (HR-10, HR-11, HR-12, HR-13; DD15-01, DD15-03). Baseline `6719415` (0.3.13).
No code file was changed; this is a research document only.

## 0. How every number in this file is labelled

* **[V]** vendor-documented — GitHub states it in its docs/README/source. **[D]** derived here by counting GitHub's own
  published tool list or source on 2026-11-17. **[M]** measured here — **there are no [M] numbers in this file**: no
  GitHub MCP server (local or remote) was started and no `tools/list` was captured.
* GitHub publishes tool **names** per toolset but no per-toolset counts and no total **[V, absence]**, so every count
  below is **[D]** unless a Toolkit estimate is being quoted.

## 1. Findings

### 1.1 Toolsets that exist today (local server + remote-only)

From the vendor README toolset table and `pkg/github/tools.go` toolset metadata (branch `main`, 2026-11-17):
`context`*, `repos`*, `issues`*, `pull_requests`*, `users`*, `copilot`*, `actions`, `code_quality`, `code_security`,
`copilot_automations`, `copilot_issue_intents`, `dependabot`, `discussions`, `gists`, `git`, `governance`, `labels`,
`notifications`, `orgs`, `projects`, `secret_protection`, `security_advisories`, `stargazers` — 23 toolsets **[D]**
(`*` = `Default: true` in source, 6 of them). Remote-only: `copilot_spaces`, `github_support_docs_search` **[V]**.
Special keywords: `all`, `default` **[V]**.

* Not found today as toolset ids: `commits`, `branches`, `teams`, `projects_alpha`, `codesecurity`, `web_search`.
  Commit and branch tools live inside `repos`; team tools (`get_teams`, `get_team_members`) live inside `context`; the
  security id is `code_security` (underscore). `web_search` appears only in a GitHub **cloud**-docs example header and
  is absent from the vendor catalog and source — treat as unverified.
* `copilot_automations` has a toolset row and a remote URL (`/mcp/x/copilot_automations`) **[V]** but **no** entries in
  the published tool catalog; 11 automation names (`create_automation`, `update_automation`, `delete_automation`,
  `run_automation`, `get_automation*`, `list_automations`, `list_automation_revisions`,
  `list_available_automation_tools`, `list_available_automation_triggers`,
  `get_automations_configuration_for_repository`) exist in vendor source/snapshots **[D]** and are unverified live.
* Renames are real and aliased: 24 deprecated tool-name aliases are published (`list_workflows` → `actions_list`,
  `list_projects` → `projects_list`, …) **[V]**, so an allow-list written with old names silently loads the
  consolidated tool.

### 1.2 How selection works (vendor, current)

| Control | Remote server | Local server |
| --- | --- | --- |
| Toolsets | `X-MCP-Toolsets` header, or `/x/{toolset}` URL (single toolset only) | `--toolsets` flag or `GITHUB_TOOLSETS` env var (env wins) |
| Individual tools | `X-MCP-Tools` header | `--tools` flag or `GITHUB_TOOLS` env var (additive to toolsets) |
| Exclude tools | `X-MCP-Exclude-Tools` header | `--exclude-tools` flag or `GITHUB_EXCLUDE_TOOLS` env var |
| Read-only | `X-MCP-Readonly` header, or `/readonly` URL suffix | `--read-only` flag or `GITHUB_READ_ONLY` env var |
| Lockdown / insiders | `X-MCP-Lockdown`, `X-MCP-Insiders` | `--lockdown-mode` / `GITHUB_LOCKDOWN_MODE`, `--insiders` / `GITHUB_INSIDERS` |
| Feature flags | `X-MCP-Features` header or `?features=` | `--features` flag |

Precedence **[V]**: read-only overrides everything (a write tool is dropped even if named in `--tools`);
excluded tools override toolsets and individual tools; unknown **toolset** names are silently ignored remotely,
unknown **tool** names are a hard error remotely.
Default toolsets when nothing is set: `context`, `repos`, `issues`, `pull_requests`, `users` **[V, README +
`server-configuration.md`]** — note docs.github.com currently states only `repos, issues, pull_requests` for the
remote default; that page looks stale.

**Names the task brief asked about that could not be confirmed as current:** `GITHUB_ALLOWED_TOOLS`,
`GITHUB_EXCLUDED_TOOLS`, `X-MCP-ExcludedTools`, `GITHUB_EXCLUDED_TOOLSETS`. They do not appear in the current README,
`docs/server-configuration.md`, `docs/remote-server.md` or `cmd/github-mcp-server/main.go`. Current equivalents are
`GITHUB_TOOLS`/`X-MCP-Tools` (allow) and `GITHUB_EXCLUDE_TOOLS`/`X-MCP-Exclude-Tools` (deny). **[V, absence]**
No `/context` endpoint exists; the context toolset is reached as `https://api.githubcopilot.com/mcp/x/context` **[V]**.

### 1.3 Counts

| Item | Value | Label |
| --- | --- | --- |
| Toolsets in the published catalog table | 23 (22 carry tool entries) | [D] |
| Tool entries in the published catalog table | 93 entries; **92 unique names** (`get_label` is listed in both `issues` and `labels`) | [D] |
| Default toolsets (`context,repos,issues,pull_requests,users`) | 45 names | [D] |
| Default toolsets in read-only mode | 27 names | [D] |
| Everything (`all`) in read-only mode | 57 names | [D] |
| Everything (`all`) with writes | 92 names | [D] |
| Feature-gated granular variants (`--features=issues_granular,pull_requests_granular`) | extra names such as `create_issue`, `update_issue_state`, `update_pull_request_body`, `resolve_review_thread` (source parse found 119 names in total) | [D] |
| Toolkit 0.3.13 estimate `github-default: 52` | stale vs 45 above | [D vs published estimate] |
| Toolkit 0.3.13 estimate `github-readonly: 12` | stale vs 27 above for the same five toolsets | [D vs published estimate] |

Read/write split was derived by matching the published names to each tool's `ReadOnlyHint` value in `pkg/github/*.go`.
It is a vendor-source fact, not a runtime probe.

### 1.4 How GitHub Copilot in VS Code selects/limits MCP tools (what exists today)

Confirmed from VS Code docs (`microsoft/vscode-docs`, main, 2026-11-11 stamp):

1. **Native Copilot MCP files** — `mcpServers` in `$COPILOT_HOME/mcp-config.json` (`~/.copilot/mcp-config.json`) or
   workspace-root `.mcp.json`. Per-server fields: `type`, `command`, `args`, `cwd`, `env`, `url`, `headers`,
   `oauthClientId`, and **`tools`** = array of tool names (`["*"]` = all, a name list = the exact subset, and "this
   doesn't bypass tool approvals"). Env refs `${NAME}` / `${NAME:-default}` are supported. Workspace-root
   `.mcp.json` is offered in **MCP: Add Server** only when experimental `chat.mcp.workspaceRootConfig.enabled` is on.
2. **Editor-managed (deprecated Local harness) format** — `.vscode/mcp.json` / profile `mcp.json` with `servers` +
   `inputs` + `sandbox`; server fields `type`, `command`, `args`, `cwd`, `env`, `envFile`, `dev`, `sandboxEnabled`,
   `sandbox` (`filesystem.allowWrite|denyRead|denyWrite`, `network.allowedDomains|deniedDomains`), `url`, `headers`,
   `oauth`. **No per-server tool allow/deny field exists in this format.**
3. **Tools tab in the Agent Customizations editor** (**Chat: Open Customizations**) — per-group and per-tool
   checkboxes for client-provided tools including MCP servers, with enabled/total counts; persists per
   harness/host/profile, is not session-only, and is separate from approvals. Local sessions use **Configure Tools**.
4. **Custom agent files** (`*.agent.md` front matter): `tools:` takes built-in aliases plus `github`, `github/*`,
   `github/<tool name>`, `<server name>/*`; Copilot-schema fields `github:` (`toolsets` array + `permissions` map),
   `mcp-servers:` (per-agent server map with its own `tools: [...]`), `deferred-tool-loading`, `strict-tools-list`.
   **Conversion limit:** on conversion to SDK custom-agent configuration, `mcp-servers`, `github`,
   `deferred-tool-loading`, `strict-tools-list`, `model-policy` and `include-custom-instructions` are **not forwarded**.
5. **Copilot in the cloud (GitHub.com)** — `.github/mcp.json` with `mcpServers` and the same `tools` field; agent
   `tools` semantics: omitted = all, `[]` = none, explicit list = only those. The out-of-the-box `github` MCP exposes
   **read-only tools by default** with a token scoped to the source repository; override order is built-in → agent →
   repository settings; Copilot code review uses a tool only when `annotations.readOnlyHint` is `true`.
6. **Hard client limit**: at most 128 tools per request (matches the Toolkit's `clientCeiling`);
   `github.copilot.chat.virtualTools.threshold` is the documented relief valve.
7. **Approval-related settings**: `chat.permissions.default` (`default` | `autoApprove` | `autopilot`),
   `chat.tools.global.autoApprove` (documented as disabling critical protections), `chat.tools.eligibleForAutoApproval`,
   `chat.tools.urls.autoApprove`, `chat.tools.terminal.autoApprove`, `chat.tools.edits.autoApprove`,
   `chat.mcp.access`, `chat.mcp.autostart`, `chat.mcp.discovery.enabled`, `chat.mcp.serverSampling`,
   `chat.mcp.apps.enabled`, `chat.agent.sandbox.mcpServers`.

**Not supported (stated plainly):** no per-tool deny list in `.mcp.json` (only the `tools` allow-list); no
per-tool approval setting for MCP tools (approval is per-server/per-session/per-tool-call at runtime, not per name);
no VS Code setting that filters a server's tools; no per-tool enablement in the deprecated `.vscode/mcp.json` schema;
tool availability ≠ tool approval, and `readOnlyHint` is a hint, not a permission boundary.

### 1.5 Toolkit verbs shipped today (0.3.13, verified in code)

`extension/presets.json` registers 3 servers; `src/research_stack/presets.py` `ALL_TOOLS` = 5 + 5 + 10 = **20 preset-selectable
verbs** (confirmed against `TOOL_TITLES`/`register_tools` in `mcp_server.py`, `recommended_server.py`, `lab_server.py`).
Deprecated aliases (`search`, `zotero_collections`, `zotero_item`) are registered only for the unmanaged `all` preset
and are **not** counted as verbs. `budget.toolkitCeilingPerPreset` is still `12` in the shipped file; phase 15 (R15-02,
HR-13, T15-12) raises the cap to 20.

| Verb | Objective fit (one line) |
| --- | --- |
| `read_document` | Read bounded text from a workspace PDF/DOCX with page/item locators. |
| `read_text_source` | Read or reopen a workspace Markdown/text source with paragraph provenance. |
| `search_local_text` | BM25 search across explicitly selected workspace files; no index written. |
| `write_markdown` | Create a cited Markdown report under `outputs/`. |
| `write_docx` | Create the same report as DOCX. |
| `search_literature` | Bounded scholarly metadata search (OpenAlex/Crossref/Semantic Scholar). |
| `check_citation` | Resolve one DOI against Crossref; a miss is "unresolved", not "wrong". |
| `zotero_library` | Read the local Zotero library (status/collections/item/search/fulltext/export). |
| `zotero_write` | Preview→confirm→apply Zotero writes with snapshot and undo (kept out of package defaults). |
| `prepare_zotero_import` | Write a validated `.ris` under `research/imports/` for manual import. |
| `index_corpus` | Build/refresh the stored corpus index for selected sources. |
| `unindex_corpus` | Remove selected sources from the index (destructive). |
| `search_corpus` | BM25 retrieval over stored chunks with provenance. |
| `evidence_read` | Resolve chunk ids to source path, locator, text hash, freshness. |
| `verify_sources` | Re-hash indexed sources; the only verb that may mark a source verified. |
| `claims_read` | List/read claims with hydrated, freshness-flagged evidence links. |
| `claims_write` | Create or patch a claim and reconcile evidence links. |
| `claims_export` | Turn stored claims into validated report references. |
| `store_status` | Read store inventory, counters, freshness, available backups. |
| `store_maintenance` | Backup, staged restore, confirmed vacuum (destructive). |

> **Working-tree note, read 2026-11-17 (not part of 0.3.13):** an in-progress phase-15 edit adds an 11th lab verb,
> `embed_corpus`, to `src/research_stack/lab_server.py` (`LAB_TOOLS`), while `src/research_stack/presets.py` still lists
> 10 lab verbs in `LAB_TOOLS`/`ALL_TOOLS`. Because `register_tools` registers only names in `enabled_tools(preset)`,
> `embed_corpus` is currently dropped by every preset including `all`, and 21 verbs would exceed the 20-verb cap: the
> cap, the registry and the lab server have to move together.

## 2. Sources

* [github/github-mcp-server README](https://github.com/github/github-mcp-server) — toolset table, `--toolsets`,
  `GITHUB_TOOLSETS`, `--tools`/`GITHUB_TOOLS`, `all`/`default`, `--read-only`, published tool catalog.
* [docs/server-configuration.md](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md)
  and [docs/remote-server.md](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) — remote
  header vs local env var, precedence, `/readonly`, `/x/all`, `/x/{toolset}`, `X-MCP-Toolsets`, `X-MCP-Tools`,
  `X-MCP-Exclude-Tools`, `X-MCP-Readonly`, `X-MCP-Lockdown`, `X-MCP-Insiders`, `X-MCP-Features`.
* [docs/tool-renaming.md](https://github.com/github/github-mcp-server/blob/main/docs/tool-renaming.md) and
  `pkg/github/deprecated_tool_aliases.go` (24 aliases); `pkg/github/tools.go` + `pkg/github/*.go` for toolset IDs,
  `Default: true` flags and per-tool `ReadOnlyHint` (branch `main`, read 2026-11-17).
* [Configuring toolsets for the GitHub MCP Server](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/configure-toolsets) (its default-toolset list looks stale) and [Setting up the GitHub MCP Server](https://docs.github.com/en/copilot/how-tos/copilot-in-your-ide/customize-copilot/extend-copilot-with-tools-and-context/set-up-the-github-mcp-server) (OAuth vs PAT).
* [MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [Add and use MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers.md), [Manage MCP servers](https://code.visualstudio.com/docs/agents/run/manage-mcp-servers.md) — `mcpServers`, per-server `tools` field, deprecated editor `servers` format, settings list.
* [Manage available tools](https://code.visualstudio.com/docs/agents/run/tools.md) — Tools tab, per-tool checkboxes, 128-tool limit, `github.copilot.chat.virtualTools.threshold`.
* [AI Settings reference](https://code.visualstudio.com/docs/agents/reference/ai-settings.md) and [Approvals](https://code.visualstudio.com/docs/agents/run/approvals.md) — `chat.mcp.*`, `chat.tools.*`, `chat.permissions.default`.
* [Custom agent file reference](https://code.visualstudio.com/docs/agents/reference/custom-agent-file-reference.md) and [Custom agents configuration (cloud)](https://docs.github.com/en/copilot/reference/custom-agents-configuration) — `tools`, `github/*`, `github/<tool>`, `github.toolsets`, `mcp-servers`, conversion limits.
* [Configure MCP servers for your repository](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/configure-mcp-servers) — `.github/mcp.json`, `/readonly` + `X-MCP-Toolsets` example, `readOnlyHint` rule for Copilot code review.

## 3. Tool names by toolset (published catalog; R = read-only, W = write per vendor source)

| Toolset | n | Read-only names | Write names |
| --- | --- | --- | --- |
| context | 4 | `get_me`, `get_team_members`, `get_teams`, `ui_get` | — |
| repos | 20 | `get_commit`, `get_file_contents`, `get_latest_release`, `get_release_by_tag`, `get_tag`, `list_branches`, `list_commits`, `list_releases`, `list_repository_collaborators`, `list_tags`, `search_code`, `search_commits`, `search_repositories` | `create_branch`, `create_or_update_file`, `create_repository`, `delete_file`, `delete_repository`, `fork_repository`, `push_files` |
| issues | 10 | `get_label`, `issue_read`, `list_issue_fields`, `list_issue_types`, `list_issues`, `search_issues` | `add_issue_comment`, `issue_write`, `sub_issue_write`, `update_issue_comment` |
| pull_requests | 10 | `list_pull_requests`, `pull_request_read`, `search_pull_requests` | `add_comment_to_pending_review`, `add_reply_to_pull_request_comment`, `create_pull_request`, `merge_pull_request`, `pull_request_review_write`, `update_pull_request`, `update_pull_request_branch` |
| users | 1 | `search_users` | — |
| orgs | 1 | `search_orgs` | — |
| labels | 3 | `get_label` (shared with issues), `list_label` | `label_write` |
| git | 1 | `get_repository_tree` | — |
| gists | 4 | `get_gist`, `list_gists` | `create_gist`, `update_gist` |
| notifications | 6 | `get_notification_details`, `list_notifications` | `dismiss_notification`, `manage_notification_subscription`, `manage_repository_notification_subscription`, `mark_all_notifications_read` |
| projects | 3 | `projects_get`, `projects_list` | `projects_write` |
| discussions | 5 | `get_discussion`, `get_discussion_comments`, `list_discussion_categories`, `list_discussions` | `discussion_comment_write` |
| stargazers | 3 | `list_starred_repositories` | `star_repository`, `unstar_repository` |
| actions | 4 | `actions_get`, `actions_list`, `get_job_logs` | `actions_run_trigger` |
| code_quality | 1 | `get_code_quality_finding` | — |
| code_security | 2 | `get_code_scanning_alert`, `list_code_scanning_alerts` | — |
| secret_protection | 2 | `get_secret_scanning_alert`, `list_secret_scanning_alerts` | — |
| dependabot | 2 | `get_dependabot_alert`, `list_dependabot_alerts` | — |
| security_advisories | 4 | `get_global_security_advisory`, `list_global_security_advisories`, `list_org_repository_security_advisories`, `list_repository_security_advisories` | — |
| governance | 4 | `custom_properties_read`, `repository_ruleset_read` | `create_repository_ruleset`, `custom_properties_write` |
| copilot | 2 | — | `assign_copilot_to_issue`, `request_copilot_review` |
| copilot_issue_intents | 1 | — | `assign_copilot_to_issue_with_intent` |
| copilot_automations | 0 published | (11 names exist in source/snapshots, not in the catalog) | (same 11) |
| **Total (local catalog)** | **93 entries / 92 unique** | **57 unique** | **35 unique** |

## 4. The three max presets

All three carry the **same 20 toolkit verbs** (the full inventory, so the lab verbs are present — closes R15-01):
`read_document, read_text_source, search_local_text, write_markdown, write_docx, search_literature, check_citation,
zotero_library, zotero_write, prepare_zotero_import, index_corpus, unindex_corpus, search_corpus, evidence_read,
verify_sources, claims_read, claims_write, claims_export, store_status, store_maintenance` — 20 = the new cap
**[HR-13]**; `zotero_write`, `unindex_corpus` and `store_maintenance` stay behind their confirmation flows.
Tool-budget arithmetic (128-tool client ceiling **[V]**, `minimumHeadroom: 20` from `extension/presets.json`):

| Preset | Toolkit verbs | GitHub tools | Enabled | Headroom |
| --- | --- | --- | --- | --- |
| max-github-full | 20 | 92 (all local toolsets) | 112 | 16 — **below the 20-tool headroom rule** |
| max-github-full (recommended variant) | 20 | 79 (`all` minus `copilot` 2, `copilot_issue_intents` 1, `governance` 4, `notifications` 6) | 99 | 29 |
| max-github-limited | 20 | 31 core (+11 optional read-only integrity tools = 42) | 51 / 62 | 77 / 66 |
| max-no-github | 20 | 0 | 20 | 108 |

### 4.1 `research-max-github-full`

Objective: complete repository, issue and PR surface for work that lives on GitHub, plus the full local research store.
Toolkit verbs: all 20. GitHub selection: every locally published toolset — the 92 names of §3, equivalently
`--toolsets=all` / `GITHUB_TOOLSETS=all` or the remote `/x/all` URL. Recommended shipped default is the 79-name variant
above so the headroom rule is not broken; which variant ships is a maintainer decision.

### 4.2 `research-max-github-limited` (read-only)

Objective: read GitHub as a **source of evidence** — cite a file, a commit, a release, an issue or a PR — with no
write, comment, push, merge or delete capability at any layer.
* Toolkit verbs: all 20.
* GitHub selection (31 names, all `ReadOnlyHint: true` per §3):

  `get_me, get_teams, get_team_members, get_file_contents, get_commit, list_commits, list_branches, list_tags,
  get_tag, list_releases, get_latest_release, get_release_by_tag, list_repository_collaborators,
  search_repositories, search_code, search_commits, get_repository_tree, issue_read, list_issues, search_issues,
  list_issue_types, list_issue_fields, get_label, list_label, pull_request_read, list_pull_requests,
  search_pull_requests, search_users, search_orgs, get_gist, list_gists`

  Optional read-only integrity add-on (11 names, all read-only; ship them all or none): `get_code_quality_finding,
  get_code_scanning_alert, list_code_scanning_alerts, get_secret_scanning_alert, list_secret_scanning_alerts,
  get_dependabot_alert, list_dependabot_alerts, get_global_security_advisory, list_global_security_advisories,
  list_org_repository_security_advisories, list_repository_security_advisories`.
* Explicitly excluded writes (deny list, belt and braces): `issue_write, add_issue_comment, update_issue_comment,
  sub_issue_write, label_write, create_pull_request, merge_pull_request, update_pull_request, update_pull_request_branch,
  pull_request_review_write, add_comment_to_pending_review, add_reply_to_pull_request_comment, create_branch,
  create_or_update_file, create_repository, delete_file, delete_repository, fork_repository, push_files, create_gist,
  update_gist, projects_write, star_repository, unstar_repository, dismiss_notification, manage_notification_subscription,
  manage_repository_notification_subscription, mark_all_notifications_read, discussion_comment_write, actions_run_trigger,
  assign_copilot_to_issue, request_copilot_review, assign_copilot_to_issue_with_intent, create_repository_ruleset,
  custom_properties_write` (= every write name of §3).

### 4.3 `research-max-no-github`

Objective: the whole local research surface with **no third-party GitHub surface at all**.
* Toolkit verbs: all 20.
* GitHub selection: none. The Toolkit writes no GitHub server entry, and the preset must actively disable the built-in
  GitHub MCP that Copilot offers out of the box (see §5.3).

## 5. Config text the Toolkit should offer the operator

### 5.1 Local GitHub MCP server (`ghcr.io/github/github-mcp-server` or built binary)

FULL (native Copilot file, `~/.copilot/mcp-config.json` or workspace-root `.mcp.json`):

```json
{ "mcpServers": { "github": {
  "type": "stdio", "command": "github-mcp-server", "args": ["stdio"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}", "GITHUB_TOOLSETS": "all" },
  "tools": ["*"] } } }
```

FULL, 79-name headroom variant — the same entry with `GITHUB_TOOLSETS` set to `all` minus `copilot`,
`copilot_issue_intents`, `governance` and `notifications`:
`context,repos,issues,pull_requests,users,orgs,labels,git,gists,projects,discussions,stargazers,actions,code_quality,code_security,secret_protection,dependabot,security_advisories`.

LIMITED (server-side read-only + exact client subset + explicit deny list):

```json
{ "mcpServers": { "github": {
  "type": "stdio", "command": "github-mcp-server", "args": ["stdio"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}",
           "GITHUB_TOOLSETS": "context,repos,git,issues,pull_requests,labels,users,orgs,gists",
           "GITHUB_READ_ONLY": "true",
           "GITHUB_EXCLUDE_TOOLS": "create_branch,create_or_update_file,create_repository,delete_file,delete_repository,fork_repository,push_files,issue_write,add_issue_comment,update_issue_comment,sub_issue_write,label_write,create_pull_request,merge_pull_request,update_pull_request,update_pull_request_branch,pull_request_review_write,add_comment_to_pending_review,add_reply_to_pull_request_comment,create_gist,update_gist,projects_write,star_repository,unstar_repository" },
  "tools": ["get_file_contents","get_commit","list_commits","list_branches","list_tags","get_tag","list_releases","get_latest_release","get_release_by_tag","list_repository_collaborators","search_repositories","search_code","search_commits","issue_read","list_issues","search_issues","list_issue_types","list_issue_fields","pull_request_read","list_pull_requests","search_pull_requests","search_users","search_orgs","get_repository_tree","get_me","get_teams","get_team_members","get_label","list_label","get_gist","list_gists"] } } }
```

`GITHUB_READ_ONLY` is the safety net: it removes write tools even if a toolset or a `GITHUB_TOOLS` entry asks for one.
To make the **server** expose only the exact subset, replace `GITHUB_TOOLSETS` with
`"GITHUB_TOOLS": "<the 31 names, comma-separated>"` — `GITHUB_TOOLS` is additive to toolsets, so do not set both when
the intent is a hard cap.

### 5.2 Remote hosted server

FULL:

```json
{ "mcpServers": { "github": {
  "type": "http", "url": "https://api.githubcopilot.com/mcp/x/all", "tools": ["*"] } } }
```

LIMITED:

```json
{ "mcpServers": { "github": {
  "type": "http", "url": "https://api.githubcopilot.com/mcp/readonly",
  "headers": { "X-MCP-Toolsets": "context,repos,git,issues,pull_requests,labels,users,orgs,gists",
               "X-MCP-Readonly": "true",
               "X-MCP-Exclude-Tools": "issue_write,add_issue_comment,update_issue_comment,label_write,create_pull_request,merge_pull_request,update_pull_request,update_pull_request_branch,pull_request_review_write,create_gist,update_gist,projects_write,star_repository,unstar_repository" },
  "tools": ["…the same 31 names as §4.2…"] } } }
```

Operator text must carry: `X-MCP-Toolsets` accepts several toolsets (a URL path accepts only one); unknown toolset
names are ignored, unknown tool names stop the server; `/readonly` and `X-MCP-Readonly` are the same switch;
authentication (OAuth or PAT) decides **what the account can do** while these settings only decide **what the agent may
ask for**; never put a PAT literally in a shared `.mcp.json`.

### 5.3 Copilot / VS Code shapes the Toolkit can write (on explicit operator action only)

* Per-server exact subset — the `tools` array shown above (native Copilot `mcpServers` file or workspace `.mcp.json`);
  for the deprecated editor format `.vscode/mcp.json` (`servers`) there is **no** tool-subset field, so there the only
  options are the server's own env/headers plus the Tools tab.
* Custom agent file (`.agent.md`) for a repeatable narrow surface:

  ```yaml
  ---
  name: research-readonly-github
  description: Read GitHub evidence only; no writes.
  tools: ['read', 'search', 'github/get_file_contents', 'github/list_commits', 'github/pull_request_read']
  ---
  # for the no-GitHub preset, the tools list simply carries no github/* reference:
  # tools: ['read', 'search', 'edit', 'todo']
  ```

  Caveat to print with it: `github:` (`toolsets` + `permissions`) and `mcp-servers:` in agent files are validated by
  the editor but **not forwarded** when the file is converted to SDK custom-agent configuration.
* NO-GITHUB enforcement steps to show the operator: (1) do not add a `github` entry to the native MCP file;
  (2) in **Chat: Open Customizations → Tools**, uncheck the GitHub server group; (3) for Copilot in the cloud, the
  out-of-the-box `github` MCP is read-only by default and is only removed by an explicit `tools:` list that omits it;
  (4) `chat.mcp.access` is a global MCP switch, not a per-server switch.

## 6. What is uncertain / what a maintainer must verify on a real host

1. **Nothing here is measured.** No `tools/list` was captured from the local binary or from
   `https://api.githubcopilot.com/mcp/`; every count is vendor-name-list arithmetic **[D]**. Before shipping, run
   `mcpcurl` (or the Toolkit's probe) against the default URL, `/readonly` and `/x/all` and record real counts.
2. **Docs disagree about the remote default toolsets** (README/source: 5 including `context` and `users`;
   docs.github.com: 3). Verify with a live `tools/list`.
3. **`web_search`, `copilot_spaces`, `github_support_docs_search` and `copilot_automations`** are remote or
   catalog-absent surfaces whose names could not be confirmed; unknown names are a hard error remotely, so any
   allow-list for them must be validated live.
4. **Granular feature flags** (`--features=issues_granular,pull_requests_granular`, `X-MCP-Features`) replace
   consolidated tools with single-purpose ones (`create_issue`, `update_issue_state`, `resolve_review_thread`, …), so
   neither the LIMITED nor the FULL list is valid with a flag on. Recommended default: never enable feature flags.
5. **Insiders mode** (`--insiders`, `GITHUB_INSIDERS`, `/insiders`) adds tools outside the catalog; preset counts are
   void with it.
6. **`ReadOnlyHint` is a vendor hint, not a guarantee**, and read-only mode is only a server-side filter: a
   write-scope PAT plus another MCP server or agent plugin can still change GitHub. Prove it on a scratch repo: no
   write call may succeed in the LIMITED preset.
7. **Alias drift**: 24 published aliases resolve silently; if the Toolkit pins names, it must pin canonical ones and
   re-check the alias table each release.
8. **Headroom conflict is a decision, not a fact**: 20 toolkit verbs + 92 GitHub names = 112 leaves 16 headroom,
   breaking the shipped `minimumHeadroom: 20`. Either ship the 79-name FULL variant, lower the headroom rule in the
   budget block, or adopt `github.copilot.chat.virtualTools.threshold` — the phase-15 budget test has to say which.
9. **Copilot-side behaviour** (Tools-tab persistence per harness/host/profile, `.mcp.json` `tools` enforcement in the
   Copilot harness vs the deprecated Local harness, and the agent-file conversion limits) is documented but not
   verified here; test on a real VS Code + Copilot host before the Toolkit claims it writes a working selection.
10. `extension/presets.json` still carries `toolkitCeilingPerPreset: 12` and the stale third-party estimates
    (`github-default` 52, `github-readonly` 12); both need renegotiation in 0.3.14 with the numbers derived above
    re-measured on the target host.
