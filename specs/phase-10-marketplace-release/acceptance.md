# Phase 10 acceptance — 0.3.10

Each case names how it is proven on this host. "Verified" requires a test or a recorded receipt. A case that only the
container ran says so; nothing here stands for a Windows or live VS Code result.

| Case | Scenario | Expected | Proof |
|---|---|---|---|
| T10-01 | A version string is parsed | `0.3.10`, `0.4.0`, `1.0.0` parse; `0.3.10.1`, `0.3.10-beta`, `v0.3.10`, `0.3` are refused | `extension/test/updates.test.js::parseVersion accepts only the shape the Marketplace accepts` |
| T10-02 | Two versions are compared | `0.3.9 < 0.3.10 < 0.4.0`; an unparseable half returns `0` rather than a guess | `…::compareVersions orders releases and refuses to guess about unknown ones` |
| T10-03 | A published engine range is compared with the editor | `^1.140.0` against `1.145.2` satisfies; against `1.139.0` does not | `…::engineSatisfies answers the only two ranges vsce will publish` |
| T10-04 | The request URL is built | one host, `marketplace.visualstudio.com`, the publisher and name from the manifest; a non-identifier half throws `TypeError` before any transport is reached | `…::latestUri names the one host and refuses an identity that is not an identifier`, `…::a bad identity is refused before any transport is reached` |
| T10-05 | A newer version is published | verdict `update-available`, `action: "update"`, the gallery id and the Marketplace page both named | `…::a published newer version becomes an update the operator can take` |
| T10-06 | The same version is published | verdict `up-to-date`, `action: "none"` | `…::the same version published is reported as up to date, not as an update` |
| T10-07 | The published build needs a newer editor | verdict `editor-too-old`, `action: "update-editor"`, no install offered | `…::a newer published build the editor cannot host is not offered as an update` |
| T10-08 | The install is ahead of the published channel | verdict `ahead-of-channel`, stated rather than hidden | `…::an install ahead of the published channel is stated as such` |
| T10-09 | The Marketplace has never published this extension (the state of this repository today) | verdict `not-published`, `action: "install-from-marketplace"`, a sentence in the panel, no exception | `…::an unpublished extension is reported as not published, with the manual install path`, `extension/test/unit.test.js::a Marketplace that has not published this extension is reported as such, not as a failure`, `extension/scripts/check-installed-payload.js` |
| T10-10 | The request fails, times out, or returns junk | `check-failed` / `invalid-response`, `action: "retry"`; the Toolkit keeps working | `…::a failed or malformed check is a verdict, never an exception` |
| T10-11 | The cooldown is measured | one check per 24 hours; `force` overrides it; a kept verdict is labelled `cached`/`held` | `…::the cooldown allows one check a day and never more`, `extension/test/unit.test.js::the version check is refused when the setting is off, and a published build becomes a stated update` |
| T10-12 | The transport is inspected | one `https.get(` call site, 8 000 ms timeout, 64 KiB cap, `fetchImpl` injectable, host pinned | `…::the transport is one HTTPS GET with a cap, and it is the module's own default`, `extension/test/module-boundaries.test.js` |
| T10-13 | Activation performs no request; the panel schedules one | the installed payload makes exactly the requests the assertions count, all to the reviewed URL, and no other host | `extension/scripts/check-installed-payload.js` (2 requests: two explicit checks plus the panel's scheduled check) |
| T10-14 | `researchStack.checkForUpdates` is off | verdict `disabled`, **zero** transport calls, and the panel says the setting is off | `extension/test/unit.test.js`, `extension/scripts/check-installed-payload.js` |
| T10-15 | An update is applied | `workbench.extensions.installExtension` receives `michaelprinc.research-stack-toolkit@<version>`; on refusal the Marketplace page is opened and the refusal is stated | `extension/test/unit.test.js` |
| T10-16 | The panel link and the install id agree with the manifest | both derive from `publisher` and `name` in `package.json` | `…::the panel link and the install identifier agree with the manifest` |
| T10-17 | A problem report is composed | sections for editor, platform, install kind, package preference, preset, workspace label, setup verdict, log tail, recent failures, note — and nothing personal | `extension/test/reports.test.js::a full report carries the sections a maintainer needs and nothing personal` |
| T10-18 | A Windows home directory appears in a log line and in the operator's note | `<home>` replaces it; no folder name survives | `…::a Windows home directory leaves no folder name behind` |
| T10-19 | A POSIX home directory and a bare absolute path appear | told apart: `<home>` for the home, `<path>` for the other | `…::a POSIX home directory and a bare absolute path are told apart` |
| T10-20 | `\\wsl$\…` and `\\server\share\…` appear | redacted as whole paths, not as prefixes | `…::WSL and UNC paths are redacted as whole paths, not as prefixes` |
| T10-21 | A public URL appears | it stays; a URL scheme is not mistaken for a Windows path | `…::a public URL stays in the report, because it is not a personal fact` |
| T10-22 | A token-shaped string appears, including inside a Marketplace API path | removed and counted; the API path itself is not shredded | `…::token-shaped material is removed and counted` |
| T10-23 | The workspace folder name appears in several places | every occurrence becomes `<workspace>` | `…::the workspace name is removed everywhere it appears` |
| T10-24 | The setup log is longer than the cap | the tail is kept and the report states how many lines were dropped | `…::the log tail keeps the end and says how much it dropped` |
| T10-25 | More failures happen than the ring holds | at most 12 entries, at most 400 characters each, newest kept | `…::the recent-failure ring is bounded in count and in length` |
| T10-26 | A fact is unknown | the report says it is unknown instead of inventing it | `…::a report states what is unknown instead of inventing it` |
| T10-27 | The report exceeds the byte ceiling | it is capped, the cap is stated in the report, and no UTF-8 character is split | `…::a report is capped, and says that it was capped` |
| T10-28 | The mail draft is built | subject names the report id; the body is bounded so the `mailto:` URI fits under Electron's `openExternal` limit, or the draft is refused | `…::the email draft names the report instead of carrying it`, `…::the mailto URI is built to fit, or it is refused` |
| T10-29 | The report module is inspected for sending capability | no transport, no socket, no fetch, no network import | `…::nothing in this module can send anything`, `extension/test/module-boundaries.test.js`, `scripts/verify_vsix.py` |
| T10-30 | The operator runs the command end to end | a file is written under storage, copied to the clipboard, opened, and only then a modal offers the mail draft | `extension/test/unit.test.js::the problem report writes a file the operator reads, copies it, and only then offers the mail draft` |
| T10-31 | The operator cancels the note | nothing written, nothing copied, nothing opened | `extension/test/unit.test.js::cancelling the note writes nothing, copies nothing and opens nothing` |
| T10-32 | The operator refuses the mail draft | the report file stays, nothing is sent | `extension/test/unit.test.js::refusing the mail draft keeps the report and sends nothing` |
| T10-33 | The maintainer address | `princ.michael@gmail.com` is a constant in `reports.js`, appears in the report and in `package.json` `bugs.email`, and is not a user setting | `extension/test/reports.test.js::the maintainer address is the one the release names, in the module and in the report`, `extension/scripts/check-installed-payload.js` |
| T10-34 | The control panel carries the affordances | `#update-state` plus `data-action="checkUpdates"`, `"updateNow"`, `"report"`; "update now" is unavailable unless an update is available; the panel states that the Toolkit sends nothing by itself | `extension/test/unit.test.js`, `extension/scripts/check-installed-payload.js` |
| T10-35 | The packaged payload carries the new modules, the icon and the manifest fields | `updates.js`, `reports.js`, `media/toolkit.png` (256 × 256 PNG), `bugs.email`, `homepage`, 33 commands, 25 allowlist entries | `scripts/verify_vsix.py`, `extension/scripts/check-installed-payload.js` |
| T10-36 | Release identity | 0.3.10 across the seven identity sources; both locks re-resolve with uv 0.13.6 | `tests/test_lock_consistency.py` / `test_release_identity.py`, `evidence/quality-v0.3.10-2026-11-07/lockintegrity-cli.json`, `uv-lock-check.txt` |
| T10-37 | The artifact is buildable from the tag | `git archive v0.3.10` → build → audit `passed`, `sourceFilesMatch: true`, 104 members | `evidence/quality-v0.3.10-2026-11-07/vsix-audit-from-tag.json` |
| T10-38 | Publication state | the publisher and extension do not exist; the pinned vsce has no `--oidc`; the bundles are `publishable: false` | `evidence/quality-v0.3.10-2026-11-07/marketplace-probe.json`, `vsce-publish-help.txt`, `vsce-4.1.0-publish-help.txt`, `bundle-catalog-check.txt` |

## Open, by design

| Item | Why it is not closed here |
|---|---|
| Publisher `michaelprinc` exists and is verified | Requires a human account at `https://marketplace.visualstudio.com/manage/createpublisher?managePageRedirect=true`. |
| A credential is chosen (PAT or Entra/OIDC trusted publishing) | Requires a human to create and hold a secret; nothing in this repository may hold one. |
| The repository licence | `UNLICENSED` today; publishing needs an explicit decision. |
| The two skill bundles | `document-corpus-bridge` is toolkit-authored but the repository is unlicensed; `theological-research` needs author consent. Both are `publishable: false` and the generator, the reader and the audit enforce it. |
| Whether 0.3.10 ships as `--pre-release` | A Marketplace presentation decision; the extension accepts either. |
| Windows 11 install, live Extension Host, Copilot attachment, a real mail client receiving the draft | Not reachable from this container. |
