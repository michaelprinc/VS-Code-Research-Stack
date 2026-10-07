# Recommended profile setup

This overlay adds bounded metadata search, DOI record lookup, read-only Zotero local API access, five research skills and a user-run notebook to a Basic workspace. It does not replace Basic files, change global editor settings, install Zotero, or write to a Zotero library.

## Provider settings

- OpenAlex works without a key for casual queries. Set `OPENALEX_API_KEY` only if you choose to use an account key. Never put a key in `.mcp.json`, a workspace profile, a notebook, or Git.
- Crossref works without credentials. Set `CROSSREF_MAILTO` to a contact address if you want its polite pool; `CROSSREF_PLUS_API_TOKEN` is optional and belongs only in the process environment.
- Semantic Scholar accepts a key-free public route subject to its current limits. Set `SEMANTIC_SCHOLAR_API_KEY` in the VS Code process environment if you have a key. Do not commit it.

Semantic Scholar is disabled unless `SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED=true` is set in the MCP process environment. Set it only after you review the [current API license](https://api.semanticscholar.org/license) and determine the planned use is allowed; this flag records your choice and does not grant or expand a license. The current terms restrict ordinary use to internal, non-commercial research/education unless an expanded license is obtained. Public displays of its data require a Semantic Scholar link using `utm_source=api` and the Semantic Scholar name/logo. The adapter carries provider attribution metadata; this prototype does not publish results or add a logo to generated documents. Do not send results to a third-party model or service unless your license permits that sharing. Product distribution/use and cloud-model workflows remain license-review gates.

The adapters issue one bounded HTTPS request per provider and cap each provider result list at 25. A provider error is returned as an error or partial result; it is never reported as zero search hits. The in-process cache is intentionally not persistent. OpenAlex and Semantic Scholar links are not license checks. This phase does not download articles or bypass authentication.

## Zotero

Install or open Zotero using its supported distribution. In Zotero, enable **Settings → Advanced → Allow other applications on this computer to communicate with Zotero**. The MCP worker only connects to `http://localhost:23119/api/`; it never reads the SQLite database and never makes write requests. A disabled or unavailable local API is reported explicitly.

To transfer records, review the generated `.ris` file under `research/imports/` and import it through Zotero's UI into a disposable test collection first. Repeated imports and duplicate handling must be checked manually. No real-library import is automated by this prototype.

## Notebook

From the workspace root, run `uv sync --locked --project notebooks/analysis`, then open `notebooks/phase-2-metadata-proof.ipynb` and select the Python environment under `notebooks/analysis` as its kernel in VS Code. Notebook cells run only when the user selects **Run**. The first cell records the actual `sys.executable` and locked package versions. Review the workspace and notebook before execution. The proof environment is separate from the Basic/Research MCP worker.

## Repair and removal

`research-stack add-recommended <workspace>` is additive and idempotent. It creates missing template files, adds the separate `research-stack-recommended` MCP entry and merges Python/Jupyter extension recommendations. Existing files and an existing server entry with the same ID are preserved. Remove that one MCP entry and the Research-owned files to return to Basic; Zotero data, notebooks and user kernels are never deleted by the toolkit.
