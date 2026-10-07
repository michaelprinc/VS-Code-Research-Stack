# Optional GitHub repository reading

This optional VS Code portable MCP entry uses GitHub's hosted remote MCP service for the `repos` toolset in read-only mode. It is not enabled by the default Basic workspace and needs no local Docker or token in the workspace config.

Before enabling, disclose that repository requests go to GitHub, review workspace trust and organization policy, and sign in through the MCP host's supported OAuth flow. OAuth/account permission is controlled by GitHub; the server configuration itself is not proof of authorized repository access. Only public repository reading is expected without private-repository authorization. Private repositories and organization resources require additional granted access.

To opt in, merge the single `github-repos-readonly` entry from `templates/optional/github-repos-readonly.mcp.json` into the workspace-root `.mcp.json` under the existing `mcpServers` object. Preserve all other entries. Restart the server and verify the actual discovered tool set and a selected repository read. Remove this entry to disable future connections. Do not also add the same server through `.vscode/mcp.json` or a VS Code provider.

This is a remote service: its server release is controlled by GitHub. The `/x/repos/readonly` route asks for repository tools in read-only mode; it is not an authorization boundary for the user's account. Keep GitHub OAuth scope and repository access as narrow as the host supports. No repository write is part of Basic.
