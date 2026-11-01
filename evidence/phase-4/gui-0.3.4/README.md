# 0.3.4 GUI and package evidence (automated, 31 October 2026)

Machine-generated receipts from the 0.3.4 build on this Linux test machine. Nothing here was hand-edited.

| File | Produced by | What it proves |
|---|---|---|
| `artifact-audit.json` | `python scripts/verify_vsix.py dist/research-stack-toolkit-0.3.4.vsix` | 79 packaged entries, no unexpected or sensitive member, every packaged byte equal to its repository source, worker bundle `schemaVersion 2` with 19 source/lock hashes and 11 overlay hashes matching, `workerVersion`/`extensionVersion` `0.3.4`. 226,352 packaged bytes, 668,102 unpacked |
| `installed-payload.json` | `node extension/scripts/check-installed-payload.js dist/…-0.3.4.vsix` | The unpacked VSIX activates in a fake Extension Host: 19 declared commands registered, 8 presets for Full, per-package MCP server definitions for `read-and-cite`, `verify-citations`, `research-lab-max` and `corpus-lab`, install plan `{installed: 3, outdated: 1}` from a receipt recorded at `0.3.3` for the notebook step, 32 guide files reachable |
| `functional-check.json` | `uv run --locked python extension/functional_check.py --workspace <temp>` | Real stdio MCP round trip against the packaged worker source: 3 servers, 15 measured tool definitions (2,193 tokens), titles and annotations present on every tool, `tools/list` cache hint present, corpus index → search → claim write → claim read with evidence link → status → refused unconfirmed vacuum → backup |
| `js-tests.txt` | `npm test` in `extension/` | 37 node tests, 0 failures (unit, diagnostics, guides, runtime, presets, installer) |
| `python-tests.txt` | `uv run --locked pytest` | 70 pytest tests, 0 failures (documents, research, full, presets, workspace, records, lab_server, functional check, vsix, configuration) |

## What these receipts do not prove

* No real VS Code Extension Host or browser renderer receipt for 0.3.4 exists yet. `npm run test:host` and `node test/browser.test.js` need the Windows 11 x64 / VS Code Desktop 1.141.0 reference host, which is not available on this machine. The 0.3.2 host/renderer receipts in `../gui-0.3.2/` are the newest real-host evidence in this repository and describe 0.3.2, not 0.3.4.
* Gates G1, G2 and G3 remain open. The readiness line `Package setup for …: n of m component steps installed` reports workspace setup completeness only.
* No external provider, Zotero endpoint, notebook kernel or assistant authorization was contacted or verified.
* The functional check uses synthetic fixtures in a temporary workspace; it does not read the researcher's own documents.
