# Python MCP SDK

Provide the Python server protocol implementation.

## Setup

Use Set up package components to install the SDK using the bundled worker lock. The dependency belongs in that environment, not the VSIX. Avoid global package upgrades to fix a workspace mismatch.

## First task and readiness

The probe reads the installed mcp distribution version and imports MCPServer, which this prototype requires. Ready confirms this import; it does not start an MCP session.

Use **Run MCP reading check** for real synthetic PDF/DOCX protocol and report tests, or **Read selected PDF / DOCX** for a read-only check of a source inside the workspace.

## Troubleshooting and limits

An import failure can indicate a missing dependency or incompatible SDK API. Reproduce the lock, then start the reviewed server in your client and invoke a real document tool. See the MCP configuration guide.

## Current documentation

[Current official documentation](https://github.com/modelcontextprotocol/python-sdk). Local onboarding reviewed on 1 November 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
