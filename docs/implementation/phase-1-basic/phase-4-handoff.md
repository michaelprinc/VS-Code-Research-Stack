# Phase 1 observations for Phase 4 VSIX

Updated: 7 October 2026. This is a living implementation note; recheck host APIs before release.

## Decisions and observations

1. One canonical internal configuration is needed. Portable `.mcp.json` uses `mcpServers`; VS Code's `.vscode/mcp.json` format instead uses `servers`. Current VS Code documentation recommends portable `.mcp.json` for new configurations and describes portable user config at `~/.copilot/mcp-config.json`.
2. Use `${workspaceFolder}` in the portable workspace config and a local package environment under `.research-toolkit/worker`. Never bake Windows drive paths into templates. Verify variable expansion in the actual supported host and each export client.
3. Each toolkit capability currently uses an explicit local stdio server. Phase 1's Basic worker and Phase 2's Recommended worker have distinct MCP identities so an additive overlay does not duplicate or replace Basic tools. Phase 1 bootstrap preserves a user-owned existing config; the Phase 2 prototype merges only an unused `research-stack-recommended` entry and reports a same-ID conflict.
4. Windows VS Code MCP sandbox is unavailable according to current docs. Keep server operations narrow, workspace-rooted and outputs-only. Never describe those checks as an OS security boundary.
5. The extension should own a versioned user-level runtime outside workspace and extension folders, while generated portable config references the runtime using a host-compatible mechanism. The workspace copy used in Phase 1 is validation scaffolding, not a final install location.
6. A locked sync can bootstrap runtime dependencies independently of editor extension installation. VS Code/Copilot/GitHub account and organization policy are separate capabilities with separate health states.
7. On the reference VS Code 1.140.0, `GitHub.copilot-chat` is bundled at 0.68.0, but the attempted Marketplace install of `GitHub.copilot` requested companion version 0.48.1 and was rejected as a downgrade. The VSIX resolver must detect bundled editor components and version constraints rather than blindly installing extension packs or fixed companion IDs.
8. Keep GitHub remote access opt-in. The repo includes an isolated read-only `repos` endpoint fragment with no token. Phase 4 must disclose cloud passage and invoke the host's account flow only after the user selects that capability.
9. Phase 2 provider credentials are read from MCP process environment variables only. Phase 4 should resolve secrets from VS Code SecretStorage at launch, never write them into portable `.mcp.json`, profiles, workspace settings, telemetry, or logs.
10. The Phase 2 extension recommendations and uv lock are platform-neutral inputs, not macOS receipts. The eventual runtime resolver must select an OS/architecture-compatible Python and preserve the separately locked Jupyter kernel environment.
11. Phase 2's Zotero adapter reads from fixed loopback only and prepares new RIS files for manual import. The VSIX must preserve the explicit human confirmation boundary unless Zotero's supported local write authorization is separately reviewed and tested.

## Settings and state to carry forward

- Portable desired profile: `.research-toolkit/profile.json`.
- Machine runtime/path/journal state: external durable application-data root; never source control.
- Workspace MCP config: `.mcp.json`, only when absent or explicitly adopted; no secret values.
- Source files: `papers/`; generated research files: `notes/`, `outputs/`; package environment: `.research-toolkit/worker/.venv` in the prototype.
- User-authored instructions and skills survive setup re-runs. Updates need three-way merge/ownership hashes and must not replace edits.
- Distinguish installation, config, MCP reachability, Copilot authentication/policy, Git availability, and remote authorization in the eventual diagnostics view.

## Open Phase 4 actions

- Validate Windows path/variable semantics and macOS runtime acquisition with clean machines.
- Test fresh-window tool discovery, invocation, permissions and duplicate detection on declared minimum/current VS Code.
- Design secure package asset extraction and an owned runtime path resolver for Windows/macOS.
- Replace template-only skill installation with the extension's profile-aware contribution mechanism when support is verified.
- Define config diff/adoption, runtime update transaction, receipt schema and sanitized diagnostic export.
- Add uninstall/repair behavior that removes only verified owned runtime code and keeps all research data.
