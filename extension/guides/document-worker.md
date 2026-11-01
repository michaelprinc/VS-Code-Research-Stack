# Basic document worker

Serve document reads and report creation through local MCP.

## Setup

In a trusted local workspace, choose **Set up package components**. The VSIX includes reviewed worker source and dependency locks; uv installs Python 3.12 and dependencies into `.research-toolkit/managed/worker-0.3.6/.venv`. The environment is separate from your project's packages. Your source documents and MCP configuration are preserved. The step is reported as installed only after `.venv/bin/python` (Linux/macOS) or `.venv/Scripts/python.exe` (Windows) and the managed `src/research_stack/mcp_server.py` are re-checked on disk.

## First task and readiness

Setup discovers real MCP tools, reads synthetic PDF/DOCX sources with hashes/locators, and creates Markdown/DOCX reports. **Run MCP reading check** repeats it. **Read selected PDF / DOCX** reads the first five pages/paragraphs of your selected workspace source and displays a local preview. Ready includes protocol evidence and timestamp, rather than module presence alone. The **Installation status** card reports this step's outcome, duration and — when it failed — its exit code and error.

## Troubleshooting and limits

Use MCP: List Servers to start the provided Basic documents server for assistant use; client authorization remains separate from the local check. A first run can download a managed Python 3.12 and the locked packages; if it needs longer than the default 900 seconds, raise `researchStack.setupTimeoutSeconds` (60–3600) and use **Retry Failed Component Steps**, which re-runs the failed step and the steps it blocked while keeping completed work. A timeout or a network-flavoured failure is retried once automatically; a missing executable or a cancellation is not. **Open Setup Log** shows the recorded attempts. Changed managed source blocks setup/execution and is preserved. Missing uv, unavailable downloads, encrypted/damaged files and image-only PDFs have distinct remediation in onboarding/PDF guides. Legacy manual workers remain Not verified by presence alone. The provider passes `RESEARCH_STACK_TOOL_PRESET`, so the tools this worker registers follow the goal you selected; a manually configured worker without that variable keeps the full surface. An unknown preset value stops the worker with `TOOL_PRESET_UNKNOWN` instead of exposing every tool.

## Current documentation

[Current official documentation](https://github.com/michaelprinc/VS-Code-Research-Stack). Local onboarding reviewed on 1 November 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
