# Phase 10 design — 0.3.10

Decisions `DD10-xx` close the findings in [spec.md](spec.md). Contracts here are the ones the tests assert.

## 1. Shape of the change

```
updates.js   one bounded GET to one host, version compare, verdict        (network layer, reviewed)
reports.js   compose → redact → bound → file + clipboard + mailto draft  (report layer, no network)
extension.js identity block, command wrappers that record failures,       (host layer)
             scheduled check on panel ready, three new commands
ui.js        "Updates & problem reports" section, verdict line, 3 buttons
media/controls.js  renders the verdict, disables "update now" unless an update exists
verify_vsix.py     reviewed-network exception, icon and manifest assertions
```

## 2. Decisions

**DD10-01 — the network capability is one named module, not a widened ban.**
`extension/updates.js` is the only packaged JavaScript member allowed to hold `require("node:https")`. The audit
(`scripts/verify_vsix.py`) now does two things instead of one: it fails if any *other* member gains an outbound
capability, **and** it fails if `updates.js` loses the reviewed bounds (`MARKETPLACE_HOST`, `REQUEST_TIMEOUT_MS`,
`MAX_RESPONSE_BYTES`, `CHECK_COOLDOWN_MS`, `function httpsGet(`, `fetchImpl`). A gate that only forbids is a gate that
silently passes when the reviewed code is deleted. `extension/test/module-boundaries.test.js` asserts the same shape
from the source side, including exactly one `require("node:https")` and exactly one `https.get(` call site.

**DD10-02 — the URL carries nothing personal.**
`GET https://marketplace.visualstudio.com/_apis/public/gallery/vscode/<publisher>/<name>/latest`. Publisher and name
come from `package.json`, which is already public. No workspace path, no file name, no user identity, no diagnostics.
`latestUri()` throws a `TypeError` if either half is not an identifier, so a malformed manifest cannot turn the request
into an arbitrary URL.

**DD10-03 — a check is bounded in four ways.** `REQUEST_TIMEOUT_MS = 8000`, `MAX_RESPONSE_BYTES = 64 * 1024`,
`CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1000`, and one `https.get(` call site (no redirect chain: a 3xx is
`invalid-response`). `fetchImpl` is injectable; `test/harness.js` and `check-installed-payload.js` inject a recorded
reply, so no test reaches the network.

**DD10-04 — a verdict is a sentence, not an exception.** `checkPublishedVersion` returns
`ok | not-published | check-failed | invalid-response | invalid-identity`; `updatePlan` returns
`up-to-date | update-available | editor-too-old | ahead-of-channel | not-published | retry`. `editor-too-old` compares
the published `Microsoft.VisualStudio.Code.Engine` range with `vscode.version`, so a build the editor cannot host is
never offered. `not-published` is the honest answer for this repository today, and the panel says so in words.

**DD10-05 — a kept verdict is labelled as kept.** When the cooldown holds, the previous verdict is reused and marked
`cached: true, held: true`; the panel appends "Kept from the check on …". Returning `checked-recently` instead would
hide the answer the operator asked for; dropping the stamp would present an old answer as a fresh one. Each branch of
`runUpdateCheck` builds a **local** verdict and returns it, because a scheduled panel check can finish during an
`await` and overwrite the shared variable (finding 5).

**DD10-06 — an update is applied by gallery identity.** `workbench.extensions.installExtension` is called with
`michaelprinc.research-stack-toolkit@<version>`, not with a downloaded `.vsix`. A gallery install carries the
Marketplace signature and returns a file-installed extension to normal automatic updating; a self-downloaded VSIX
would re-pin it. If the editor refuses, the Toolkit opens the Marketplace page and says that it did.

**DD10-07 — version parsing refuses what the Marketplace refuses.** Strict `major.minor.patch`. `0.3.10.1` and
`0.3.10-beta` are `invalid-identity`, because vsce validates with `semver.valid` and the Marketplace rejects a
prerelease tag: a quietly-compared four-part version would produce a verdict that cannot be acted on.

**DD10-08 — a report leaves the machine only through the operator.** `researchToolkit.reportProblem` composes the
report, writes it under `context.storageUri` (then `globalStorageUri`, then `logUri`) in a `reports/` folder, copies it
to the clipboard, opens the file, and only then shows a modal whose affirmative button opens a `mailto:` draft to
`princ.michael@gmail.com` in the operator's own mail program. There is no upload, no server, no background send, and no
setting that turns one on. Cancelling the note writes nothing; choosing "Stop here" sends nothing.

**DD10-09 — redaction happens before the operator sees the text.** Absolute paths → `<path>`, home directories
(Windows, POSIX, `\\wsl$`, UNC) → `<home>`, workspace folder names → `<workspace>`, labelled secrets and token-shaped
strings → `<redacted>` / `<redacted-token>`. The report ends with a count of each removal. A public URL is kept on
purpose: a failed-download report without its address is not a report. A Windows path may contain spaces, so where no
separator names its end the rest of the line goes with it — over-redaction is the documented default.

**DD10-10 — every bound is a byte bound.** `MAX_REPORT_BYTES = 24 000`, `MAX_MAILTO_BODY_BYTES = 1 400`,
`MAX_MAILTO_URI_BYTES = 1 800` (Electron's `shell.openExternal` is capped near 2 081 characters on Windows),
`MAX_LOG_LINES = 40`, `MAX_ERROR_ENTRIES = 12`, `MAX_ERROR_CHARS = 400`, `MAX_NOTE_CHARS = 2 000`. The report budget
takes the footer and the note first, then truncates the log tail with `truncateToBytes`, which backs off rather than
splitting a UTF-8 character.

**DD10-11 — failures are recorded in a bounded ring, never on disk.** Every command registered through `register()`
records `{ kind, message }` into `recentErrors` before rethrowing. The ring is capped at 12 entries and 400 characters
each, lives in the extension host's memory, and is read only when the operator asks for a report.

**DD10-12 — identity comes from the manifest once.** `TOOLKIT_VERSION`, `PUBLISHER_ID`, `EXTENSION_NAME`,
`EXTENSION_ID` are read from `./package.json` at the top of `extension.js`. The update URL, the gallery id, the panel
text and the report header all derive from those four, so a version bump cannot produce a report that names a
different release than the one that failed.

**DD10-13 — the icon is a PNG, authored, and verified.** `extension/media/toolkit.png`, 256 × 256 RGBA, produced by
`extension/scripts/make_icon.js` and re-measured with `--verify`. The Marketplace refuses an SVG icon and requires at
least 128 × 128; `verify_vsix.py` and `check-installed-payload.js` assert the manifest field and the file.

**DD10-14 — publication prerequisites are recorded, not decided here.** Publisher creation, credential choice, the
licence status of the repository and the two skill bundles are maintainer decisions. The runbook in
[docs/implementation/phase-10-marketplace-release/implementation-report-0.3.10.md](../../docs/implementation/phase-10-marketplace-release/implementation-report-0.3.10.md)
names each one with the command that resolves it and the receipt that proves the current state.

## 3. What the gates now hold

| Gate | New assertion |
|---|---|
| `scripts/verify_vsix.py` | `extension/updates.js` and `extension/reports.js` are expected members; `extension/media/toolkit.png` is expected and measured; the reviewed-network exception is measured in both directions; packaged documentation must name 0.3.10. |
| `extension/test/module-boundaries.test.js` | `updates.js` is the single socket-capable member; one `require("node:https")`; one `https.get(`; bound constants present; `marketplace.visualstudio.com` is the only host named. |
| `extension/scripts/check-installed-payload.js` | 33 commands registered; `researchStack.checkForUpdates` default/scope/description; `updates.js` and `reports.js` present; a disabled setting reaches no transport; a 404 is a stated verdict; every request went to the reviewed URL; the panel carries the verdict line and the three new controls. |
| `extension/test/unit.test.js` | 33 commands, 33 registered, 34 disposals, 25 shipped allowlist entries; report file + clipboard + modal + `mailto:` flow; cancel writes nothing; refusing the draft sends nothing; disabled-vs-published check through the panel; 404 verdict. |
| `test_release_identity.py` | 0.3.10 across the seven identity sources. |
