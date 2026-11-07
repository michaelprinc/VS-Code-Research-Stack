# Workspace Python runtime

Run document tools in an isolated virtual environment.

## Setup

Use **Set up package components** to install locked Python 3.12 dependencies into the toolkit's own managed worker environment. Python downloads may be required. Your existing project `.venv` is preserved. Notebook kernels use a separate environment.

## First task and readiness

Checks prefer `.research-toolkit/managed/worker-0.3.10/.venv`, then the legacy worker environment. A root `.venv` is inspected only in a Research Stack source project. Unrelated environments are not reported as missing toolkit dependencies. The row shows the executing Python version and path.

## Troubleshooting and limits

Ready means the interpreter launched, not lock compatibility or MCP authorization. Create a missing environment with uv sync --locked. Global Python installations and arbitrary interpreter paths are not inspected.

## Current documentation

[Current official documentation](https://docs.python.org/3/tutorial/venv.html). Local onboarding reviewed on 6 November 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
