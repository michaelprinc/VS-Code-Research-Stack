# Workspace MCP configuration

Connect reviewed local workers to your MCP client.

## Setup

GUI setup registers Basic documents/local search and Research metadata/RIS servers through the extension's MCP definition provider. Existing `.vscode/mcp.json` and `.mcp.json` remain untouched. The provider binds the managed interpreter to the selected workspace and passes `RESEARCH_STACK_TOOL_PRESET`, so the registered tools follow the saved goal preset; a server whose tools the preset does not use is not offered. Older CLI initialization prepares portable `.mcp.json` with `mcpServers`; native `.vscode/mcp.json` uses `servers`. Use one active definition for each worker to avoid duplicates: a duplicated server definition doubles the tools it registers and is the usual cause of a client tool-limit error. The shipped servers contribute these tool counts when a preset selects them — `research_stack.mcp_server` 5 (`read_document`, `read_text_source`, `search_local_text`, `write_markdown`, `write_docx`), `research_stack.recommended_server` 5 (`search_literature`, `check_citation`, `zotero_collections`, `zotero_item`, `prepare_zotero_import`), `research_stack.lab_server` 9 (`index_corpus`, `unindex_corpus`, `search_corpus`, `evidence_read`, `claims_read`, `claims_write`, `claims_export`, `store_status`, `store_maintenance`). The deprecated `search` alias appears only in a manual definition that selects no preset, which registers all 19 tools. A manually written definition without `RESEARCH_STACK_TOOL_PRESET` registers the full toolkit surface. To gate a manual definition by goal, add the variable with a preset id from the control panel:

```jsonc
// .vscode/mcp.json — optional goal gating for a manual worker definition
{
  "servers": {
    "research-stack-basic": {
      "command": "<managed worker python>",
      "args": ["-I", "-B", "-m", "research_stack.mcp_server"],
      "env": {
        "RESEARCH_STACK_WORKSPACE": "${workspaceFolder}",
        "RESEARCH_STACK_TOOL_PRESET": "read-and-cite"
      }
    }
  }
}
```

Valid preset ids are `read-and-cite`, `find-in-notes`, `verify-citations`, `zotero-handoff`, `research-core`, `research-workflow`, `research-lab`, `research-lab-max` and `corpus-lab`. An unknown id stops the worker with `TOOL_PRESET_UNKNOWN` instead of exposing every tool.

## First task and readiness

Run the GUI **MCP reading check** for account-free protocol verification, then use **MCP: List Servers** to start the Research Toolkit Basic documents server for assistant use. Invoke `read_document` on a workspace-relative source. Assistant authentication and organization policy are separate prerequisites; the GUI check does not grant those permissions.

## Troubleshooting and limits

Configuration present does not mean running. Diagnostics parses bounded portable JSON, records native JSONC presence and never executes configured commands. Correct malformed portable JSON manually. Follow current host instructions for supported configuration sources.

## Current documentation

[Current official documentation](https://code.visualstudio.com/docs/agent-customization/mcp-servers). Local onboarding reviewed on 31 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
