# Phase 10 specification — update channel, problem reports, and publishing to the Marketplace (0.3.10)

Date: 7 November 2026 (Europe/Prague). Predecessor: [specs/phase-9-document-ingestion](../phase-9-document-ingestion/spec.md) (0.3.9 PDF/DOCX ingestion and skill bundles).
Scope: a release-engineering phase with three deliverables that must land together — (a) an **update channel** so a
Toolkit installed from a `.vsix` file can learn that a newer published version exists and hand the update to VS Code's
own installer, (b) a **problem report** the operator can compose in the Toolkit control panel and send to
`princ.michael@gmail.com` from their own mail program, with personal paths and token-shaped strings removed before the
operator ever sees the text, and (c) a **verified publication runbook** for the Visual Studio Marketplace, with the
requirements measured rather than assumed.

Excluded, as briefed: a background updater, a self-downloading VSIX installer, an anonymous telemetry endpoint, an
error-report server, crash reporting services, account provisioning, and any automatic send. Development happens in the
DeepSeek Harness container (WSL2, Debian 13, CPython 3.12.16 venv, Node 24). A Windows 11 host and a live VS Code
Extension Host are **not reachable from this container**; no case below claims one.

## 1. Baseline that was measured, not assumed

| Fact | How it was measured here |
|---|---|
| The publisher `michaelprinc` and the extension `michaelprinc.research-stack-toolkit` do not exist on the Marketplace. | `POST /_apis/public/gallery/extensionquery` with `filterType: 7`, value `michaelprinc.research-stack-toolkit` → `TotalCount: 0`; `GET /vscode/michaelprinc.research-stack-toolkit/latest` → 404; `GET /publishers/michaelprinc` → 404; `GET …/vsextensions/research-stack-toolkit/latest/vspackage` → 404 `ExtensionAssetNotFoundException`. Receipt: [marketplace-probe.json](../../evidence/quality-v0.3.10-2026-11-07/marketplace-probe.json). |
| The pinned packager (`@vscode/vsce` **4.0.0**, devDependency) has **no** `--oidc` option. `--oidc` first appears in **4.1.0**. | `vsce publish --help` on 4.0.0 and on 4.1.0, diffed. Receipts: [vsce-publish-help.txt](../../evidence/quality-v0.3.10-2026-11-07/vsce-publish-help.txt), [vsce-4.1.0-publish-help.txt](../../evidence/quality-v0.3.10-2026-11-07/vsce-4.1.0-publish-help.txt). |
| vsce 4.0.0 has no `create-publisher` command; it has `ls-publishers`, `login`, `logout`, `delete-publisher`, `verify-pat`, `unpublish`, `generate-manifest`, `verify-signature`. | `vsce --help`. Receipt: [vsce-commands-help.txt](../../evidence/quality-v0.3.10-2026-11-07/vsce-commands-help.txt). |
| What vsce would actually ship for this manifest: **102 files**, and the packaged VSIX holds **104 members** — the two extras are `extension.vsixmanifest` and `[Content_Types].xml`, added by the packager. | `vsce ls` (no prompt, no warning) beside `scripts/verify_vsix.py` member inventory. Receipts: [vsce-ls.txt](../../evidence/quality-v0.3.10-2026-11-07/vsce-ls.txt), [vsix-audit.json](../../evidence/quality-v0.3.10-2026-11-07/vsix-audit.json). |
| VS Code does not update an extension installed from a file. | Documented behaviour of `extensions.autoUpdate` plus the fact that a VSIX install has no gallery identity to update. This is the reason 0.3.10 exists. |
| The repository is `UNLICENSED` and the two skill bundles are **not publishable** as they stand. | `scripts/build_bundle_catalog.py --check` → `2 bundles, 12 files, 67797 bytes, 1 unresolved license(s), publishable=False`. Receipt: [bundle-catalog-check.txt](../../evidence/quality-v0.3.10-2026-11-07/bundle-catalog-check.txt). |
| The package has no icon today, and the Marketplace requires a **PNG** icon of at least 128 × 128 (an SVG is refused). | `extension/package.json` had no `icon` field; `extension/media/toolkit.png` was authored for this release (256 × 256 RGBA, 6 875 bytes, SHA-256 `dbe4f22b…c4c7a`) and `scripts/make_icon.js --verify` re-measures it. |
| The Toolkit already records everything a useful bug report needs, locally: component inventory, setup verdict, setup log, tool surface, host inventory. | `extension/diagnostics.js`, `extension/extension.js` (`state()`), the setup log path used by `researchToolkit.openSetupLog`. |
| Nothing in the shipped JavaScript could reach the network, and the audit enforced that with a byte scan. | `scripts/verify_vsix.py` `FORBIDDEN_ENTRY` list and `extension/test/module-boundaries.test.js`. 0.3.10 changes this deliberately, under review — see §3 R10-02. |

## 2. Findings

Line numbers refer to the 0.3.9 tree (`v0.3.9`) unless stated. Each finding is a thing that would have shipped, or a
requirement that had to be measured because the documentation and the tool disagreed.

1. **`EXTENSION_NAME` was used and never defined.** `extension/extension.js` referenced it while building diagnostic
   text. Nothing reached that line in the suites, so it was a latent `ReferenceError` in a shipped file. 0.3.10 defines
   the identity block once, from `package.json`: `TOOLKIT_VERSION`, `PUBLISHER_ID`, `EXTENSION_NAME`, `EXTENSION_ID`.
2. **The capability gate is a byte scan, so it also scans prose.** Adding the update check made `verify_vsix.py` report
   `packaged JavaScript introduces network capability: ['extension/extension.js']` — the trigger was the *word*
   "socket" inside a comment. The gate was kept strict and the comment was reworded; the reviewed exception is now an
   explicit, named single module rather than a widened ban (R10-02).
3. **A packaged document is generated from a source outside `extension/`.** The audit reported
   `packaged documentation names a release other than 0.3.10: ['extension/worker/README.md: 0.3.9']`. That file is
   produced by `scripts/build_worker_bundle.py` from the repository-root `README.md`; fixing the copy inside
   `extension/` would be overwritten by the next build. The root README is the file that carries the fix.
4. **Redaction is harder than it looks, and the failures were silent in both directions.** Four defects were found by
   the new tests: a URL scheme was eaten as a Windows path (`https://` → `http<path>`); a token-shaped pattern matched
   the Marketplace API path (`com/_apis/public/gallery/…`); `\\wsl$` and UNC paths were not matched at all; and the
   report cap was exceeded because the footer and the operator's note were not inside the budget. A Windows path may
   contain spaces, so its end is not always knowable — the module now over-redacts on purpose and says so.
5. **A verdict could be overwritten by a check the panel started.** `runUpdateCheck` returned the shared `updateCheck`
   variable after an `await`. A scheduled panel check that finished during that await replaced the value the command
   returned: the payload audit saw `not-published` where the setting said `disabled`. Each branch now builds a local
   verdict and returns that.
6. **The test harness was not a faithful stand-in for two VS Code surfaces.** `Uri.joinPath` returned a bare string, so
   `savedFile.fsPath` was undefined; `showInformationMessage` dropped its `options` argument, so a modal dialog could
   not be asserted. Both were fixed in `test/harness.js`, and three existing assertions moved to `.fsPath`.
7. **`pytest -q` on top of `addopts = "-q"` is `-qq` and prints no summary.** The suite ran and the receipt looked
   empty. The evidence commands now pass `-o addopts=""`.
8. **Publication is blocked by facts, not by effort.** The publisher does not exist; the pinned vsce cannot do trusted
   publishing; the bundles are not publishable; the repository declares no licence. Each one is a decision for the
   maintainer, listed in [docs/implementation/phase-10-marketplace-release/implementation-report-0.3.10.md](../../docs/implementation/phase-10-marketplace-release/implementation-report-0.3.10.md)
   with the command that resolves it.

## 3. Requirements

| # | Requirement | Proven by |
|---|---|---|
| R10-01 | The Toolkit can ask the Marketplace for the newest published version of **this** extension and state the answer as a verdict, never as an exception. | `extension/test/updates.test.js` (14), `extension/test/unit.test.js` |
| R10-02 | Exactly one shipped JavaScript module can reach the network, it can reach one host, once per call, with a timeout, a byte cap and a 24-hour cooldown, and the audit fails if that module loses the capability **or** if any other member gains it. | `scripts/verify_vsix.py` (`REVIEWED_JS_NETWORK_*`), `extension/test/module-boundaries.test.js` |
| R10-03 | Activation performs no network request. The check is scheduled when the control panel reports ready, and a setting switches it off completely. | `extension/test/unit.test.js`, `extension/scripts/check-installed-payload.js` |
| R10-04 | An update is applied through the gallery identity `michaelprinc.research-stack-toolkit@<version>`, not through a self-downloaded file, and the refusal path opens the Marketplace page and says so. | `extension/test/unit.test.js`, `extension/scripts/check-installed-payload.js` |
| R10-05 | A version string that the Marketplace would reject (`0.3.10.1`, `0.3.10-beta`) is refused by the parser instead of being quietly compared. | `extension/test/updates.test.js` |
| R10-06 | A problem report is composed locally, written to the extension's own storage, copied to the clipboard, and only then offered as a `mailto:` draft to `princ.michael@gmail.com` in the operator's own mail program. Nothing is sent by the Toolkit. | `extension/test/reports.test.js` (16), `extension/test/unit.test.js` |
| R10-07 | Absolute paths, home directories (Windows, POSIX, `\\wsl$`, UNC), workspace names and token-shaped strings are removed before the operator sees the report, the removal is counted in the report, and a public URL is deliberately kept. | `extension/test/reports.test.js` |
| R10-08 | The report is bounded in bytes, log lines, error entries and note length, and a bound is enforced by truncation that cannot split a UTF-8 character. | `extension/test/reports.test.js` |
| R10-09 | Cancelling the note, or refusing the mail draft, changes nothing on disk and sends nothing. | `extension/test/unit.test.js` |
| R10-10 | The publication requirements are recorded with the command that measured each one, and the runbook names the decisions only the maintainer can make. | `docs/implementation/phase-10-marketplace-release/implementation-report-0.3.10.md`, `evidence/quality-v0.3.10-2026-11-07/` |
| R10-11 | Release identity holds across all seven sources, both locks re-resolve with the pinned uv, and the artifact is buildable from the tag. | `test_release_identity.py`, `scripts/lockintegrity.py`, `evidence/quality-v0.3.10-2026-11-07/vsix-audit-from-tag.json` |

## 4. What this phase does not claim

No Windows 11 install, no VS Code Extension Host, no Copilot session, and no Marketplace write. `check:payload` runs the
packaged `extension.js` against a synthetic harness in this container. The `mailto:` step is proven up to the
`openExternal` call; what the operator's mail program does with the draft is outside this container. The publisher was
not created, no credential was requested, and nothing was published — the runbook is the deliverable, and the human
decisions in it are listed as open.
