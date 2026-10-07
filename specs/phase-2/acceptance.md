# Phase 2 acceptance scenarios

Revision: 0.1.0. Synthetic fixtures are deterministic; live provider responses and rankings are observations, never golden result sets.

| Scenario | Method | Pass evidence |
|---|---|---|
| T2-01 | Apply overlay twice to a disposable Basic workspace with a sentinel user file and custom MCP server | First apply adds only missing files/settings; second is idempotent; sentinel and custom server hash unchanged; Basic tools remain configured |
| T2-02 | Provider fixtures for OpenAlex, Crossref and Semantic Scholar, plus one low-volume live request/provider when access permits | Schema fields normalize; bounded limit/timeout; upstream IDs and attribution are retained |
| T2-03 | Fixtures for DOI URL/case normalization, two providers with same DOI but conflicting titles, no DOI, non-Crossref DOI and similar-title distinct DOI | Exact DOI merges with conflicts/provenance; distinct/no DOI IDs stay separate; Crossref miss is unresolved |
| T2-04 | Zotero fake local API fixture, then a disposable real library if installed | Collections/items are read only; loopback URL fixed; RIS parses/imports in the disposable test collection and repeat behavior is recorded |
| T2-05 | Fixture links with PDF, login HTML, denied response, redirect, missing license | Current prototype must not download; reports link/rights uncertainty accurately. Full acquisition requires a separately reviewed implementation |
| T2-06 | Run notebook through a fresh VS Code Jupyter host after selecting analysis environment | `sys.executable`, package versions, synthetic table and deterministic chart captured; actual host proof required |
| T2-07 | Invoke all five skills and recommended tools from selected Copilot harness | Traceable record → citation review → user-selected text → source locators → scope-labeled report |
| T2-08 | Mock auth denial, rate limit with Retry-After, 5xx, timeout, malformed response and one failing provider in `all` | Stable errors, no false zero result, partial state and no automatic retry storm |
| T2-09 | Scan files/logs for keys; deny Zotero access; inspect MCP methods | No secrets in project/logs; GET-only Zotero client; RIS preparation writes a new file and does not call Zotero write endpoint |
| T2-10 | Reapply overlay, repair locked analysis environment and remove Research server entry on disposable copy | Basic/user files and unrelated VS Code extensions/kernels/library remain intact |

The current Windows run can pass only deterministic local scenarios. G2 cannot pass until the missing live/provider, Zotero sandbox, fresh VS Code Jupyter/Copilot and Basic regression receipts are attached.
