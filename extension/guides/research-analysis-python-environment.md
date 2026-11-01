# Notebook analysis environment

Isolate notebook dependencies from the MCP worker.

## Setup

The optional **Notebook analysis environment** step (Recommended Research and Full) writes the reviewed `notebooks/analysis` project files and syncs its locked environment with `uv sync --locked`. Before any package manager runs it identifies what is already there: the reviewed `research-stack-analysis` project is owned and synced; a project that declares `ipykernel` and `matplotlib` under a different name is accepted and reported as a **compatible existing project**; anything else is refused with the reason and nothing is synced or overwritten. A linked `pyproject.toml` or a linked `.venv` is refused rather than followed. After syncing, the step verifies that the environment's own interpreter can import `ipykernel` and `matplotlib` and records that interpreter version. It creates no kernel, changes no notebook, and is the only component step that downloads packages for notebooks. Existing `notebooks/analysis` files you have edited are preserved.

After adding Recommended, run `uv sync --locked --project "<research folder>/notebooks/analysis"`. Its lock manages ipykernel and matplotlib. Do not replace the worker lock.

## First task and readiness

Choose notebooks/analysis/.venv in the notebook kernel picker. Run a small import and inspect sys.executable. Keep notebook outputs/provenance with the research record.

## Troubleshooting and limits

Environment detected means its known Python executable exists; no kernel was launched. If absent, add the overlay and sync analysis. Installing the Jupyter editor extension alone is insufficient. The step's sync is bounded by `researchStack.setupTimeoutSeconds` (default 900 s, allowed 60–3600 s); a sync that runs longer is reported as timed out, and **Retry Failed Component Steps** re-runs this step without repeating the steps that already completed. If the worker step failed, this step is reported as blocked rather than attempted.

## Current documentation

[Current official documentation](https://docs.astral.sh/uv/guides/integration/jupyter/). Local onboarding reviewed on 1 November 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
