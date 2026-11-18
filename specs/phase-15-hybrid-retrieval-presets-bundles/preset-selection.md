# Phase 15 preset selection (0.3.14) — exact tools, arithmetic, and what the Toolkit writes

Input: [research/github-mcp-tool-map-2026-11-17.md](../../research/github-mcp-tool-map-2026-11-17.md).
No GitHub MCP server was started in this container, so every GitHub count below is a **name-list
count derived from the vendor catalog** ([D] in that document), never a measurement. A real host owes a
`tools/list` capture; the preset text says so.

## 1. The rule that replaced 0.3.13's

0.3.13 described a third-party surface as one number per server (`github-default: 52`), and the
12-tool cap forced the lab verbs out of the wide presets. 0.3.14 states:

- a preset names the **exact tool names** it means, and its count **is** the length of that list;
- a preset names only the verbs its objective uses; the verb it leaves out is stated;
- toolkit verbs ≤ **20** (DD15-01), total tools ≤ **108** so headroom stays ≥ 20 under 128;
- a preset may not offer a third-party surface whose tools the Toolkit cannot name from a reviewed
  source. That is why the 0.3.13 `playwright-core` (24) and `zotero-community` (15) estimates leave
  the preset file: they were numbers attached to servers this release has never inventoried.

## 2. The toolkit verb inventory after P2 (21 verbs)

`embed_corpus` is the verb 0.3.14 adds (P2): it builds the stored retrieval vectors from the chunk
text already in the store, on CPU, with the Toolkit's own named backend.

| Group | Verbs |
| --- | --- |
| Documents (5) | `read_document` `read_text_source` `search_local_text` `write_markdown` `write_docx` |
| Metadata & Zotero (5) | `search_literature` `check_citation` `zotero_library` `zotero_write` `prepare_zotero_import` |
| Corpus index & record store (11) | `index_corpus` `embed_corpus` `search_corpus` `evidence_read` `verify_sources` `claims_read` `claims_write` `claims_export` `store_status` `unindex_corpus` `store_maintenance` |

## 3. The three max presets

| Preset | Objective | Toolkit verbs | GitHub names it selects | Total | Headroom |
| --- | --- | --- | --- | --- | --- |
| `research-max-github-full` | The work lives on GitHub: repos, code, commits, issues, PRs, releases, alerts — read **and** act on it, while every finding is recorded in the local store. | 16 | **92** — every name in the vendor's local catalog (`--toolsets=all` / `/x/all`) | **108** | **20** (the minimum, exactly) |
| `research-max-github-limited` | GitHub as a **source of evidence** only: cite a file, a commit, a release, an issue or a PR, with no write at any layer. | 20 | **42** — 31 evidence tools + 11 read-only integrity tools, all `ReadOnlyHint: true` | 62 | 66 |
| `research-max-no-github` | The whole local research surface, no third-party GitHub surface at all. | 20 | **0** — the Toolkit writes no GitHub entry, and the preset names the operator steps that turn the built-in GitHub server off | 20 | 108 |

Full preset's 16 verbs: `read_document` `read_text_source` `write_markdown` `write_docx`
`search_literature` `check_citation` `zotero_library` `index_corpus` `embed_corpus` `search_corpus`
`evidence_read` `verify_sources` `claims_read` `claims_write` `claims_export` `store_status`.
The five it drops, and why: `search_local_text` (the stored index is this preset's search surface),
`zotero_write` and `prepare_zotero_import` (a GitHub-centred goal does not write a reference
library), `unindex_corpus` and `store_maintenance` (the destructive pair lives in `corpus-lab` and
`research-max-no-github`). 92 GitHub names leave exactly 20 tools of headroom, so the toolkit side
cannot take more; that is the arithmetic DD15-01 accepts.

Limited preset's 20 verbs: all 21 except `store_maintenance` — reading GitHub evidence does not need
a vacuum or a restore, and a destructive verb belongs where the operator is working on the store.

No-GitHub preset's 20 verbs: all 21 except `search_local_text` — the goal is the *stored* corpus, and
`search_corpus` is its search verb.

## 4. The 42 names in `research-max-github-limited`

Core evidence (31): `get_me` `get_teams` `get_team_members` `get_file_contents` `get_commit`
`list_commits` `list_branches` `list_tags` `get_tag` `list_releases` `get_latest_release`
`get_release_by_tag` `list_repository_collaborators` `search_repositories` `search_code`
`search_commits` `get_repository_tree` `issue_read` `list_issues` `search_issues` `list_issue_types`
`list_issue_fields` `get_label` `list_label` `pull_request_read` `list_pull_requests`
`search_pull_requests` `search_users` `search_orgs` `get_gist` `list_gists`

Read-only integrity (11): `get_code_quality_finding` `get_code_scanning_alert`
`list_code_scanning_alerts` `get_secret_scanning_alert` `list_secret_scanning_alerts`
`get_dependabot_alert` `list_dependabot_alerts` `get_global_security_advisory`
`list_global_security_advisories` `list_org_repository_security_advisories`
`list_repository_security_advisories`

Read-only names the preset **does not** select (15): `actions_get` `actions_list` `get_job_logs`
`custom_properties_read` `repository_ruleset_read` `ui_get` `get_discussion`
`get_discussion_comments` `list_discussions` `list_discussion_categories` `get_notification_details`
`list_notifications` `list_starred_repositories` `projects_get` `projects_list`. Every write name
(35 in the catalog) is on the preset's explicit exclude list as well as behind
`GITHUB_READ_ONLY` / `X-MCP-Readonly`.

## 5. The two retired presets

`research-lab` and `research-lab-max` are retired, not deleted: the ids stay registered so a saved
0.3.13 preference resolves instead of falling back silently, they no longer appear in the picker, and
the panel names the preset that replaces each one. They are retired because their whole content was
an unnamed third-party estimate — 52, 24, 15 tools for servers the Toolkit had never inventoried —
and rule 1 above no longer allows that shape. `research-lab-max` is also the preset the operator's
report caught carrying **no lab verb**; its successors carry 16–20 toolkit verbs, nine to eleven of
them store verbs.

## 6. Other presets that change

| Preset | Change |
| --- | --- |
| `research-workflow` (Full default) | 11 → 15 verbs: `embed_corpus`, `verify_sources`, `claims_export`, `store_status` join. The 0.3.13 journey ended at `claims_write`; a journey that produces evidence a report cites has to reach the export and the freshness check. |
| `corpus-lab` | 11 → 12 verbs: `embed_corpus` joins the ten store verbs plus `read_text_source`. |
| `research-core`, `read-and-cite`, `find-in-notes`, `verify-citations`, `zotero-handoff` | unchanged; their surfaces are already the objective. |

## 7. What the Toolkit writes for Copilot (HR-12), and what it does not

`Research Toolkit: Configure Preset Tools for Copilot` (explicit command, never automatic) writes the
selected preset's GitHub selection into the workspace file the Copilot harness reads for `mcpServers`
(workspace-root `.mcp.json`), with:

- `type` + `url` (`…/mcp/x/all` for full, `…/mcp/readonly` for limited) **or** the local
  `ghcr.io/github/github-mcp-server` form with `GITHUB_TOOLSETS` / `GITHUB_READ_ONLY` /
  `GITHUB_EXCLUDE_TOOLS`;
- the per-server **`tools`** array = exactly the names the preset selected (the native Copilot
  format's only tool-subset field; the deprecated `.vscode/mcp.json` `servers` format has none, and
  the command says so instead of writing something that will not be honoured);
- **no token, ever**: `${GITHUB_PERSONAL_ACCESS_TOKEN}` is an environment reference, and the command
  refuses to write a literal credential it was handed.

It reviews the target file first, refuses to overwrite a file it did not write, keeps a copy of the
previous content, and states plainly that a server-side read-only switch is a filter, not a
permission boundary — what the account may do is decided by the token, not by the Toolkit.
