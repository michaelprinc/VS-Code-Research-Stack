# Evidence — Research Stack Toolkit 0.3.11 (8 November 2026)

Unified integration onboarding for Zotero and Semantic Scholar. Every number below was produced on this Linux
development container. Nothing here was run on a Windows host, in a live VS Code Extension Host, against a real Zotero
installation or with a real Semantic Scholar key; `specs/phase-11-integration-onboarding/acceptance.md` names the
container-side substitute for each case that needs one.

## How to reproduce

```bash
export PATH="$HOME/.local/bin:$PATH"          # uv 0.13.6 lives in ~/.local/bin and is not on PATH here
cd Research-Stack/toolkit/extension
npm test                                      # node --test, 435 tests
npm run package                               # guide index → worker bundle → vsce package
npm run verify-package                        # scripts/verify_vsix.py against the built artifact
npm run check:payload                         # scripts/check-installed-payload.js against the built artifact
cd .. && uv run --locked python -m pytest -o addopts="" -q
uv run --locked python -m research_stack.cli probe-integrations
```

`-o addopts=""` is required for the pytest summary line to appear. Package after the last edit to a packaged file:
`verify_vsix.py` byte-compares packaged members against the source tree.

## Receipts

| File | What it records |
|---|---|
| `node-suite.txt` | 436 tests, 436 pass, 0 fail, 0 skipped |
| `python-suite.txt` | 273 passed (duration as measured in that run) |
| `vsix-audit.json` | `result: passed`, 108 members, 448 515 packed bytes, 1 343 649 unpacked of the 1 376 256 ceiling, `sourceFilesMatch: true`, 38 commands, 32 guides, 9 presets, `reviewedNetworkBoundary` naming `extension/updates.js` as the only outbound JS member |
| `payload-check.json` | `result: passed` — 38 registered commands, the integration section in the packaged panel HTML, four dimensions per integration in the packaged state, Zotero `consentRequired: false`, Semantic Scholar `awaiting-consent`, no credential value in the panel HTML, outbound members unchanged |
| `vsix-sha256.txt` | `aed24d76db0dda0bb52199c29d1ba067fcebf364152e7a41c52d97c73f5a48fe` — produced by two consecutive builds |
| `probe-receipt.json` | The readiness question asked of this host: Zotero `not-installed` / `ZOTERO_NOT_AVAILABLE` ("Nothing answered at localhost:23119 and no installation was detected. No library file was opened, nothing was written, no configuration changed."); Semantic Scholar `auth-required` / `PROVIDER_TERMS_NOT_ACKNOWLEDGED` ("No request was sent; the missing step is the operator's acknowledgement of the Semantic Scholar API licence.") |
| `probe-receipt-zotero.json` | One provider asked for, one provider answered — the receipt carries only Zotero |
| `probe-refusal-unknown-provider.txt` | `{"error": "Unknown provider(s) bogus; accepted providers: zotero, semantic_scholar."}` |

## What changed in the artifact, member by member

104 → 108 members, +66 827 unpacked bytes against the 0.3.10 artifact:
`extension/extension.js` +20 069; `extension/integrations.js` +15 513, `extension/integrationprobe.js` +4 889,
`extension/integrationstore.js` +4 176; `extension/worker/src/research_stack/integrations.py` +5 998 with `cli.py` +339
and `bundle.json` +110; `extension/media/controls.js` +4 224, `extension/media/controls.css` +4 023,
`extension/ui.js` +970; `extension/readme.md` +3 126, `extension/worker/README.md` +825; the two guides +1 382;
`extension/package.json` +923, `extension/components.json` +189.

This is why the reviewed unpacked ceiling was re-measured from 1 310 720 to 1 376 256 (DD11-10), leaving 32 607 bytes of
headroom. The attribution is written into `scripts/verify_vsix.py` next to the number.

## Not proven here

A Zotero answering on `localhost:23119`; a real Semantic Scholar key and the `api-key` mode end to end; a live VS Code
Extension Host (`npm run test:host` needs `VSCODE_EXECUTABLE_PATH`); Windows paths and installs; sharing the decision
across VS Code profiles of the same OS user (INT-12, deliberately unimplemented); guided Zotero installation through the
platform package manager (INT-13, deliberately unimplemented); Zotero write access (out of scope).
