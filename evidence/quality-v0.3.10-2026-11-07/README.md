# Research Stack Toolkit 0.3.10 — quality evidence, 7 November 2026

Everything in this folder was produced in the development container described below. Nothing here was produced on
Windows 11, in a VS Code Extension Host, or with Copilot attached, and no receipt in this folder should be read as if it
had been. **Nothing was published**: no publisher was created, no credential was requested, no `vsce publish` was run
against a real publisher.

## The machine that ran this

| | |
|---|---|
| Host | WSL2, Debian 13 (trixie), Linux 6.6 x86_64 |
| Python | `.venv` CPython 3.12.16 — mcp 2.2.0, pypdf 6.4.1, python-docx 1.2.0, pytest 8.4.2 |
| Node | v24.22.0, npm 12.2.0 |
| uv | pinned binaries at `/tmp/uvs` — the locks were written and checked with **uv 0.13.6** |
| Packager | `@vscode/vsce` **4.0.0** (pinned devDependency); **4.1.0** inspected for its `--oidc` option |
| Repository | `main`, release tag `v0.3.10`; 0.3.9 was `v0.3.9` |

Tests never touch a live profile, a live chat session, a research store or a credential. Every fixture is under `/tmp`
and every store is disposable. No test reaches the network: `extension/updates.js` takes its transport as an argument
and both harnesses inject a recorded reply.

## Commands and results

| What ran | Command | Result | Receipt |
|---|---|---|---|
| Python suite | `.venv/bin/python -m pytest tests/ -o addopts=""` | **258 passed** in 133.33 s | `python-suite.txt` |
| Node suite (19 test files) | `cd extension && PATH=/tmp/uvs:$PATH npm test` | **390 tests, 390 pass, 0 fail, 0 skipped** | `node-suite.txt` |
| Lock pair | `.venv/bin/python scripts/lockintegrity.py` | `"ok": true`, `"problems": []` | `lockintegrity-cli.json` |
| Locks, pinned uv | `/tmp/uvs/uv-0.13.6 lock --check` (root, then `--project extension/worker`) | `Resolved 40 packages` both times | `uv-lock-check.txt` |
| Bundle catalog is generated, not hand-edited | `.venv/bin/python scripts/build_bundle_catalog.py --check` | 2 bundles, 12 files, 67 797 bytes, 1 unresolved licence, `publishable=False` | `bundle-catalog-check.txt` |
| Package | `cd extension && PATH=/tmp/uvs:$PATH npm run package` | `dist/research-stack-toolkit-0.3.10.vsix`, 104 members, **426 351 bytes** | `package.txt` |
| VSIX audit | `cd extension && PATH=/tmp/uvs:$PATH npm run verify-package` | `"result": "passed"` | `vsix-audit.txt`, `vsix-audit.json` |
| Installed-payload check | `cd extension && PATH=/tmp/uvs:$PATH npm run check:payload` | `"result": "passed"`, 33 commands, 32 guides | `payload-check.txt`, `payload-check.json` |
| What vsce would ship for this manifest | `cd extension && npx @vscode/vsce ls` | **102 files**, no warning, no prompt | `vsce-ls.txt` |
| The pinned packager's publish options | `npx @vscode/vsce@4.0.0 publish --help` | no `--oidc`; `--skip-license`, `--allow-missing-repository`, `--packagePath`, `--pre-release`, `--skip-duplicate` present | `vsce-publish-help.txt` |
| The current packager's publish options | `npx @vscode/vsce@4.1.0 publish --help` | adds `--oidc` — *"Use OpenID Connect trusted publishing for authentication"* | `vsce-4.1.0-publish-help.txt` |
| Packager command surface | `npx @vscode/vsce@4.0.0 --help`, `… login --help` | no `create-publisher`; `ls-publishers`, `login`, `verify-pat`, `unpublish` present | `vsce-commands-help.txt`, `vsce-login-help.txt` |
| Is the extension already published? | Node `https` probes of the public gallery | `extensionquery` `TotalCount: 0`; `/vscode/…/latest` 404; `/publishers/michaelprinc` 404; `…/vspackage` 404 `ExtensionAssetNotFoundException` | `marketplace-probe.json` |
| Publication requirements, source-checked | docs + vsce source + local read-only packaging probes | 296-line report with quotes and page dates | `marketplace-publish-research.md` |
| The artifact is reproducible | `npm run package` twice, `sha256sum` both | identical: `c24e2415…b20f2` | `package.txt` |
| The artifact is buildable from the tag | `git archive v0.3.10` into a disposable tree, run `scripts/build_guide_index.py` and `scripts/build_worker_bundle.py` there, then `node scripts/package.js` and `scripts/verify_vsix.py` with `source_root` = the tag tree | `"result": "passed"`, `sourceFilesMatch: true`, 104 members, and **byte-identical** to the working-tree build (`identicalToWorkingTreeBuild: true`) | `vsix-audit-from-tag.json` (produced from the tagged tree, in the commit that follows the tag) |
| The digest an operator should check after downloading | `sha256sum dist/research-stack-toolkit-0.3.10.vsix` | `c24e24157899c198e429e7d5af4d97cb575d893afc6dd929ee266444d97b20f2`, 426 351 bytes | `vsix.sha256.txt` |

## The artifact

| | |
|---|---|
| Path | `dist/research-stack-toolkit-0.3.10.vsix` |
| SHA-256 | `c24e24157899c198e429e7d5af4d97cb575d893afc6dd929ee266444d97b20f2` |
| Size | 426 351 bytes |
| Members | 104 (102 from `vsce ls` + `extension.vsixmanifest` + `[Content_Types].xml`) |
| Unpacked | **1 276 822 bytes** of the reviewed ceiling **1 310 720** — 33 898 bytes of headroom |
| Source match | every member byte-equal to the reviewed source tree (`sourceFilesMatch: true`) |
| Icon | `extension/media/toolkit.png`, 256 × 256 RGBA, 6 875 bytes, SHA-256 `dbe4f22bd7cbe6807acb83f3012334907d4d31181291808dbf4cf3fb67bc4c7a` |
| Bundle group | 2 bundles, 12 files, 67 797 bytes, both `publishable: false`, one unresolved licence |

## The reviewed network boundary, as the audit states it

`reviewedNetworkBoundary` in `vsix-audit.json` is measured over every packaged member:

- Packaged JavaScript outbound capability: **`extension/updates.js` only** — reviewed as one bounded HTTPS GET to
  `marketplace.visualstudio.com` with a timeout, a byte cap and a 24-hour cooldown. No other packaged JavaScript
  matched `fetch`, `XMLHttpRequest`, `WebSocket`, `require("node:http|https|net|tls")`, `urllib.request`, `socket` or
  `http.client`.
- Packaged Python outbound network: `extension/bundles/theological-research/scripts/crossref_lookup.py` and
  `extension/worker/src/research_stack/research.py` — both pre-existing, both listed rather than hidden.
- `urllib` imported without outbound capability (URL quoting only) in `extension/worker/src/research_stack/records.py`.

`extension/reports.js` — the module that composes the problem report — has **no** outbound capability, and
`extension/test/reports.test.js::nothing in this module can send anything` asserts it.

## Four defects the gates caught, and what they would have shipped

1. **`EXTENSION_NAME` was used and never defined** in `extension/extension.js`. A latent `ReferenceError` in a shipped
   file, invisible to every suite that had run before 0.3.10.
2. **The capability gate is a byte scan, so it also scans prose.** `verify_vsix.py` reported
   `packaged JavaScript introduces network capability: ['extension/extension.js']` because a *comment* contained the
   word "socket". The gate was kept strict and the comment reworded; the exception is now an explicit named module
   measured in both directions — the audit fails if `updates.js` loses the reviewed bounds as well as if another member
   gains a capability.
3. **A generated packaged document was stale.** `packaged documentation names a release other than 0.3.10:
   ['extension/worker/README.md: 0.3.9']`. That file is generated from the repository-root `README.md` by
   `scripts/build_worker_bundle.py`; the fix belongs in the root file, and that is where it was made.
4. **A verdict could be overwritten by a check the panel started.** `runUpdateCheck` returned the shared `updateCheck`
   variable after an `await`; a scheduled panel check that finished during that await replaced the value the command had
   returned, and `check:payload` saw `not-published` where the setting said `disabled`. Each branch now builds and
   returns a local verdict, and the payload assertions were moved before any panel interaction so the request counts
   belong to the calls being asserted.

## What these receipts do not prove

- No Windows 11 install, no VS Code Extension Host, no Copilot session. `check:payload` runs the packaged
  `extension.js` against a synthetic harness in this container; it is not a real Extension Host.
- The `mailto:` step is proven up to `vscode.env.openExternal`. What the operator's mail program does with the draft —
  including whether the body survives a client that re-wraps long lines — is outside this container.
- The Marketplace state is a **read-only** probe. No publisher was created, no credential was requested, nothing was
  published, and the runbook in `docs/implementation/phase-10-marketplace-release/implementation-report-0.3.10.md` is
  therefore a plan, not a receipt.
- The theological bundle is packaged and installable but **not publishable**: its licence is unresolved and
  `publishable: false` is enforced by the generator, the reader and the VSIX audit. The repository itself is
  `UNLICENSED`.
- The bundle's optional `scripts/crossref_lookup.py` makes outbound requests when a user runs it. It was never run
  here; the audit lists it under `outboundNetworkMembers` rather than pretending it is inert.
- Gates G1–G4 (the reference-host profile gates) remain open, as they were for 0.3.6 through 0.3.9.
