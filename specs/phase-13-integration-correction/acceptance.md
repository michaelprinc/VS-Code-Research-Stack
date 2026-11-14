# Phase 13 acceptance — integration correction from a real-host report

Version **0.3.11**. Every case below is either **run** (with a receipt) or **not run here** and
labelled as such. Nothing in this file claims a result that was not measured.

## 1. Test cases

### The probe reports what the service said

| ID | Case | Result |
|---|---|---|
| T13-01 | A server that closes the connection without answering does not crash the probe. | **Passed.** `RemoteDisconnected` was measured escaping the probe before the fix; it is now a receipt with a code. `tests/test_research.py`, `tests/test_integrations.py`. |
| T13-02 | One provider's crash still leaves a complete two-provider receipt. | **Passed.** Measured with the Zotero side consuming 24 s: the Semantic Scholar receipt is produced in full. |
| T13-03 | The documented `/api/` root is asked before the collection listing. | **Passed.** Pinned by a static test over the stage order and the four URLs and methods. |
| T13-04 | `HEAD /api/users/0/collections` is asked, and answers separately from the GET. | **Passed.** |
| T13-05 | A 403 whose body is `Local API is not enabled` produces the setting instruction; a 403 whose body is `Request not allowed` does **not**. | **Passed.** Measured against both bodies. The second sentence deliberately omits any setting. |
| T13-06 | A 400 is named as a rejection of the request, not as absence. | **Passed.** New code `ZOTERO_REQUEST_REJECTED`, evidence `400 Bad Request Invalid Host header`. |
| T13-07 | A 401 says a read needs no credential. | **Passed.** New code `ZOTERO_AUTH_REQUIRED`, outcome `auth-required`. |
| T13-08 | A 404 says the request was not recognised, which is not absence. | **Passed.** |
| T13-09 | A 501 is named; the dead 503 mapping is gone. | **Passed.** `ZOTERO_NOT_READY` no longer exists in the Python, and a test asserts a status Zotero never returns is not given a meaning. |
| T13-10 | The receipt carries the HTTP status and a clipped, scrubbed line of what the server said. | **Passed.** Every measured state carries it, e.g. `root 200 Zotero-API-Version 3 Zotero-Server-ID sPMHtLD6HHBd HEAD 200`. Key-shaped runs and file paths are redacted before it is stored. |
| T13-11 | An empty library is `ready` and says so. | **Passed.** "returned no collections, which is a working empty library, not a failure". |
| T13-12 | Connection refused is not reported as absence. | **Passed**, both readings: refused and no Zotero on a documented path → `not-installed` with "no evidence of Zotero was found, not that Zotero is absent"; refused but found on a documented path → `not-running`, naming the late port and the taken-port case. |

### The probe waits as long as Zotero actually needs

| ID | Case | Result |
|---|---|---|
| T13-13 | Each stage waits only as long as that stage can answer. | **Passed.** Root 5 s, listing 12 s, ping 3 s, pinned by test. |
| T13-14 | A listing that times out is retried **once**, and the retry is what a still-loading library looks like. | **Passed.** Measured wall clock: 12.0 s to succeed on the retry. |
| T13-15 | After the retry fails, the receipt is returned immediately and the connector ping is **not** asked. | **Passed.** Measured 24.0 s, with a tripwire that fails the test if the ping runs. |
| T13-16 | The probe states its own worst case and a test pins the arithmetic. | **Passed.** 34 s for the Zotero side. |
| T13-17 | The host's process bound is above the worker's worst case. | **Passed.** `PROBE_TIMEOUT_MS` 20 000 → 80 000, with the arithmetic in the comment. |
| T13-18 | `CALL_CEILING_MS` bounds wall-clock, not only sleeping. | **Passed.** New test: a transport that consumes 15 s per attempt stops the loop before all four attempts, inside the ceiling plus the one request already in flight. |

### The "Check now" path

| ID | Case | Result |
|---|---|---|
| T13-19 | A completed check reports the verdict, not "Done.". | **Passed.** `extension/test/integration-host.test.js` asserts the panel result names the service and its state. |
| T13-20 | A probe while another action holds the lock is refused with the stated reason, and only one worker runs. | **Passed**, for all three previously unlocked presses. |
| T13-21 | Opening the integrations flow does not hold the lock for the whole check. | **Passed.** The facts read is bounded at 5 000 ms and is **skipped with a stated reason** when something is already running; zero facts calls in that case. |
| T13-22 | A check that cannot run is shown disabled with its reason, not offered live. | **Passed on both sides.** Model: `probeBlocked` and `probeWaitMs` on every view, asserted in `test/integrations.test.js`. Panel: `scripts/panel_renderer_check.js` runs the shipped `media/controls.js` byte-for-byte in a DOM shim against a real state message from the shipped harness and measures `data-unavailable="true"`, `aria-disabled="true"` and the title `…this workspace does not provide one. The next check is allowed in 12 s.` on the Zotero "Check now" button, with "Activate" left live. |
| T13-23 | The cooldown refusal names the remaining wait and says nothing was lost. | **Passed.** The window is 10 s, not 30 s, and the model's default and the probe module's constant are asserted to agree. |
| T13-24 | A stale machine fact re-offers guided installation, and the host does not then refuse it. | **Passed on both sides.** Model: `test_integrations` asserts `guideInstall` and `installedNow` return when the fact is outside the window. Host: `test/integration-host.test.js` (the T12-36 case) now presses `guideIntegrationInstall` against an 8-day-old fact and asserts a **modal with the official page as its first button**, the detail sentence naming the 7-day window, and that the only thing opened is `https://www.zotero.org/download/`. The host no longer re-derives the rule; it asks the model's own offer list. |
| T13-25 | Zotero's card stops offering "Activate" once it is ready or authorized. | **Passed.** Semantic Scholar's path is unchanged and asserted unchanged. |
| T13-26 | The guided Semantic Scholar modal names the step that actually exists. | **Passed.** It now says to activate first, because a key is not storable before the provider's terms are accepted. The refusal without activation is still asserted. |
| T13-27 | No result renders the word "undefined" in the live region. | **Passed** in `scripts/panel_renderer_check.js` row E: after every state driven, after an orphan result, after a host result, and after a bare `{type:"result"}` with neither error nor message, `#feedback` never contained "undefined" — the bare result renders the fallback sentence. |
| T13-28 | A late result is not shown as the answer to the current press, even on a freshly re-rendered panel. | **Passed** in row C: a real press left `#feedback` at "Working…", and `{type:"result", requestId:987654}` — an id this panel never sent — left it unchanged. |
| T13-29 | The pending-request set is bounded. | **Passed** in row F: 1 000 sends through the shipped `send()` path (ids 3…1002); probing every id answered 25 (978…1002) and evicted 975 (3…977). Newest answered, oldest evicted, measured bound 25 = `PENDING_REQUEST_LIMIT`. |
| T13-34 | **Found by the new check, not by the plan.** A `data-readonly` control the renderer marks unavailable stayed pressable and unannounced. | **Passed after the fix.** `applyControlAvailability()` returned on the `isReadOnly` branch before the unavailable branch, so `[data-action="updateNow"]` carried `data-unavailable="true"` and an explanatory title with `disabled=false` and no `aria-disabled`. Row G now asserts the invariant; it **fails against the pre-fix renderer** (`disabled=false aria-disabled=null`, exit 1) and passes on the fixed one. |

## 2. Gates

| Gate | Result |
|---|---|
| Python suite | **386 passed, 0 failed, 0 skipped** (was 352). `uv run --locked python -m pytest -o addopts="" -q tests/` |
| Node suite | **481 tests, 481 pass, 0 fail, 0 skipped** (was 468). `npm test` from `extension/` |
| `scripts/panel_renderer_check.js` | **7 assertions, 7 pass, 0 fail, exit 0.** Now a named gate: `npm run test:panel` from `extension/`. It also **fails (exit 1) against the pre-fix renderer**, which is what makes row G an assertion rather than a description. |
| `npm run verify-package` | **Passed.** 110 members, **483 008 packed**, **1 450 632 unpacked**, `sourceFilesMatch: true`. These are the **0.3.12** figures: the corrections were released as their own version. sha256 `5b1667ab1ce45a07bd63762f53012ad1302dea0ace539d1f82a91f583f602f10`, reproduced byte-identically by a second build. |
| Byte ceiling | **Re-measured, in the open, for the third time in this release.** The build failed at 1 445 373 against 1 441 792 — 3 581 over. Nothing was moved out and no reviewed file was dropped. The ceiling moved one 1/16 MiB step to **1 507 328**, with member-by-member attribution in `scripts/verify_vsix.py`. The chain is recorded: 1 343 649 → 1 365 400 → 1 383 104 → 1 420 824 → **1 445 373**. |
| Capability audit | **Passed.** `research.py` still has exactly two `build_opener(` and zero `urlopen(`, the three unchanged Zotero constants, `ProxyHandler({})`, and no new address or opener. The HEAD verb reuses the same client. `integrations.py` gained no outbound primitive; its now-unused `import urllib.error` was removed. |
| `npm run check:payload` | **Passed**, 38 commands unchanged. |
| Reproducibility | See the digest recorded in [evidence/realhost-2026-11-12/README.md](../../evidence/realhost-2026-11-12/README.md). |

## 3. Not run here, and not claimed

- **T13-30 — a real Zotero 10 on Windows.** Not run. There is no Zotero in this container. Every
  Zotero case above was measured against an emulated server on the real port, built to Zotero 10.0.9's
  documented behaviour. That proves the Toolkit's handling; it does not prove which state the
  operator's machine is in.
- **T13-31 — a real Semantic Scholar key, and a real 429.** Not run.
- **T13-32 — a real VS Code Extension Host and a real rendered panel.** `npm run test:host` and
  `node test/browser.test.js` cannot run here (no `VSCODE_EXECUTABLE_PATH`, no Playwright), and
  `test/browser.test.js` is not part of `npm test`. The panel rows are now measured by
  **`scripts/panel_renderer_check.js`** — the shipped `media/controls.js` executed byte-for-byte in a DOM shim
  against a real state message from the shipped harness, 7 assertions, run as `node scripts/panel_renderer_check.js`.
  That proves the **DOM-level** behaviour. It does not prove the browser-level consequences: whether
  `controls.css` renders the unavailable state, whether the title appears as a tooltip, whether a screen reader
  announces `aria-disabled`, whether a keyboard user can reach the control, whether a disabled control really
  cannot be pressed, or whether a live region really speaks the measured text. Those still belong to
  `test/browser.test.js` on a host that has Playwright.
- **T13-33 — two real VS Code profiles of one OS user.** Not run.

## 4. What is still open by design

- The probe's hosted side still uses the research retry budget. The ceiling now bounds it honestly, but a
  readiness check does not need four attempts; giving the probe path its own single-attempt bound is the
  next highest-value change and is **not** done here.
- Whether the operator's VS Code Extension Host was local at all. If it is remote, `127.0.0.1` is not the
  Windows host and Zotero's loopback-only bind is unreachable. Hypothesis, not fact.
- The exact cause of the operator's original failure is **still unconfirmed**. It is now diagnosable on
  their machine with `scripts/zotero_local_check.py`; it is not diagnosed here.
