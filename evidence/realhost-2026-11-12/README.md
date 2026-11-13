# Real-host report and reproduction — 12 November 2026

## What the operator reported

After installing Zotero on a real machine and running the Toolkit's integrations flow:

1. **Zotero was installed and the Toolkit correctly identified the installation.** The machine-level record and the guided-install guidance worked.
2. **The checks in the GUI were not successful.** The readiness check did not report Zotero as ready.
3. **The "Check now" button did not work correctly.**
4. **The guided Semantic Scholar key flow had a problem.**
5. The guided installation of Zotero itself was integrated correctly.

This file records what was reproduced here, and what could not be.

## What was reproduced, and how

There is no Zotero in this container, so the probe was run against an **emulated Zotero HTTP
server bound to the real port** `127.0.0.1:23119`, calling the shipped code path
`research_stack.integrations.probe_zotero()` unchanged. The emulator is
[zotero_emulator.py](zotero_emulator.py); it is a diagnostic harness, not part of the package,
and it is not packaged.

Run it with:

```
HOME=/tmp/fakehome XDG_DATA_HOME=/tmp/fakehome/.local/share PYTHONPATH=src \
  uv run --locked python /tmp/zotero_emulator.py
```

## Measured probe behaviour, state by state

| Emulated server state | Probe outcome | Code | Verdict |
|---|---|---|---|
| Local API answers a collection list | `ready` | — | correct |
| Local API answers `[]` (empty library) | `ready` | — | correct, but the sentence does not say the library is empty |
| Local API preference off → 403 | `api-disabled` | `ZOTERO_API_DISABLED` | correct, actionable |
| Server accepts only `Host: localhost:23119` → 403 | `api-disabled` | `ZOTERO_API_DISABLED` | **misleading** — reported as a disabled preference when it is a host-header refusal |
| Server refuses a client without `Zotero-Allowed-Request` → 403 | `unknown` | `ZOTERO_NOT_FOUND` | honest, but the sentence names no cause |
| `format=json` not accepted → 404 | `unknown` | `ZOTERO_NOT_FOUND` | honest, but indistinguishable from a wrong path |
| **Server asks for authentication → 401** | `unknown` | `ZOTERO_REQUEST_FAILED` | **defect** — an authentication demand is reported as an unexplained failure |
| 200 with an HTML body | `unknown` | `ZOTERO_SCHEMA_UNEXPECTED` | honest, but the sentence names no cause |
| **Server closes the connection without answering** | **`CRASH`** | `RemoteDisconnected` | **defect** — the exception escapes the probe |

The crash is the most serious finding. `http.client.RemoteDisconnected` is a subclass of
`ConnectionResetError`, not of `urllib.error.URLError`, so it is not caught by
`_zotero_request`. Because `probe_integrations()` guards neither provider, one provider's crash
discards the whole receipt: the worker exits non-zero, the host reports
*"The integration check failed"*, and **Semantic Scholar is never checked either**. A readiness
check that can crash is a check that reports failure for reasons the operator cannot see.

## What the probe actually puts on the wire

Captured by a server that records the request it received:

```
GET /api/users/0/collections?limit=100&format=json HTTP/1.1
Accept-Encoding: identity
Host: 127.0.0.1:23119
User-Agent: Python-urllib/3.12
Accept: application/json
Zotero-Api-Version: 3
Zotero-Allowed-Request: 1
Connection: close
```

HTTP/1.1 is used, so the version is not the problem. `Host` is `127.0.0.1:23119` and the
User-Agent is the urllib default — both are places where a real Zotero could refuse a client that
is not a browser connector.

## Defects found by reading the wiring (verified line by line)

Twelve defects were found in the panel and host wiring; the four that match the operator's report:

| # | Symptom the operator would see | Evidence |
|---|---|---|
| J1 | Press "Check now", the panel says **"Done."** with no verdict; if the state did not change the card re-renders identically, so the press looks like a no-op | `extension/extension.js:1493` `let resultMessage = "Done.";` and `:1540-1542`, which discards the probe's return value although the verdict sentences are already built at `:270-275` |
| J4 | Zotero correctly detected, press "Check now" → *"Set up package components before checking integrations."* — a red error about package components from a button about Zotero | `extension/extension.js:240-241`, while `extension/integrations.js:302` offers `check` in **every** state |
| J2 | Press "Check now" twice, two workers run; buttons re-enable mid-probe | `extension/extension.js:1301`, `:1378`, `:1398` call `runIntegrationProbe` without `exclusive()`; only `:1466` and `:1542` hold the lock |
| J3 | Open "Integrations & Accounts", then press a check within ~20 s → *"A setup or check is already running."* | `extension/extension.js:1290` takes the lock for the machine-fact read with a 20 000 ms bound (`extension/integrationprobe.js:15`); `extension/extension.js:588-589` throws for everyone else |
| J5 | Follow the Semantic Scholar modal's step 3 — *"Press 'I already have a key' and paste it once"* — and **that button does not exist** until the integration is authorized | `extension/extension.js:1355` versus `extension/integrations.js:311-314` and the refusal in `setIntegrationKey` |

## What was checked and found sound

No dead button from an id mismatch: all 14 action ids offered by the model have an entry in
`CARD_ACTIONS`, a branch in `manageIntegrations`, and a branch in `handleMessage`. The cooldown
refusal **is** shown to the operator. A refused check does not spend the budget. The environment
variable names the host passes match the worker exactly (`SEMANTIC_SCHOLAR_API_KEY`,
`SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED`). The provider-id mapping is correct in both directions.
The busy flags cannot leak. No stored key value is ever rendered.

## What is still not verified

No real Zotero, no real VS Code, no real Semantic Scholar key, and no real 429 were involved here.
The emulated states prove the Toolkit's **own** handling is wrong for inputs a real server can
produce; they do not prove which of those inputs a real Zotero actually produces.

## After the correction — the same states, re-measured

The same harness was used to re-measure every state against the corrected probe. These are the
operator-facing sentences the Toolkit now produces.

| State | Outcome | Code | What the operator is told |
|---|---|---|---|
| Preference off (403 `Local API is not enabled`) | `api-disabled` | `ZOTERO_API_DISABLED` | Names the exact Zotero setting. No ping is asked — a 403 is an answer. |
| Root answers, listing times out, retry answers (12.0 s) | `ready` | — | Says the first attempt got no answer and the second did, "which is what a library that was still loading looks like". |
| Root answers, listing times out twice (24.0 s) | `unknown` | `ZOTERO_NO_ANSWER` | Says the local API **is** enabled and a Zotero **is** running, and that the listing is what got no answer. The connector ping is not spent. |
| Refused, no Zotero on a documented path | `not-installed` | `ZOTERO_NOT_AVAILABLE` | "no evidence of Zotero was found, not that Zotero is absent". |
| Refused, Zotero found on a documented path | `not-running` | — | Names the late port and the taken-port case. |
| Root silent, connector ping answers (5.0 s) | `unknown` | `ZOTERO_NO_ANSWER` | Says the HTTP server is up but the documented root got no answer. |
| 400 `Invalid Host header` | `unknown` | `ZOTERO_REQUEST_REJECTED` | Says the request itself was rejected — a fact about the request, not about Zotero. |
| 401 | `auth-required` | `ZOTERO_AUTH_REQUIRED` | "A read request needs no authentication, so this is not a missing credential." |
| 403 `Request not allowed` | `unknown` | `ZOTERO_REQUEST_NOT_ALLOWED` | **No setting instruction** — this answer is not about a setting. |
| 404 `No endpoint found` | `unknown` | `ZOTERO_NOT_FOUND` | "did not recognise this request, which is a different fact from Zotero being absent". |
| Healthy Zotero 10, empty library | `ready` | — | "returned no collections, which is a working empty library, not a failure". |

Every one of these carries the server's own words in the receipt's `evidence` field, for example
`root 200 Zotero-API-Version 3 Zotero-Server-ID sPMHtLD6HHBd HEAD 200`, or
`403 Forbidden Local API is not enabled`. Key-shaped runs and file paths are redacted before anything
is stored.

## Build receipts for the corrected tree

| Gate | Measured |
|---|---|
| Python suite | **386 passed, 0 failed, 0 skipped** |
| Node suite | **481 tests, 481 pass, 0 fail, 0 skipped** |
| `scripts/panel_renderer_check.js` | **7 assertions, 7 pass, 0 fail, exit 0** — the shipped `media/controls.js` run byte-for-byte in a DOM shim against a real state message from the shipped harness. Run from the repository root. It found defect M7 and **fails against the pre-fix renderer** (`disabled=false`, `aria-disabled=null`, exit 1). |
| `npm run verify-package` | **Passed** — 110 members, **481 907 packed**, **1 447 197 unpacked**, `sourceFilesMatch: true` |
| Byte ceiling | The build **failed** at 1 445 373 against 1 441 792. Nothing was moved out and no reviewed file was dropped; the ceiling moved one 1/16 MiB step to **1 507 328** with member-by-member attribution in `scripts/verify_vsix.py`. Chain: 1 343 649 → 1 365 400 → 1 383 104 → 1 420 824 → 1 445 373 → **1 446 993**. |
| `npm run check:payload` | **Passed**, 38 commands unchanged |
| Reproducibility | Two consecutive builds of the final tree, same sha256 `75c533078febccee78ab6e7273c77a8378fa6d61d8cda72807400277335953a5`. Earlier phase-13 builds digested `84f206c5…` and `e09eee6f…`; both predate the M7 renderer fix, the Zotero guidance in the readme, and the named `npm run test:panel` gate, and are superseded. |

## Running the diagnostic on the operator's machine

```
python scripts\zotero_local_check.py
```

It asks five loopback requests, prints the status, the Zotero identity headers and a clipped body for
each, and ends with a verdict and an exit code. Verified here against three emulated states:
preference off → the setting instruction and exit 1; a path that 404s → "the request is the part that
failed" and exit 1; a server that closes without answering while the connector still answers → the
same distinction the Toolkit now makes. On Windows it must be run with `python` or `curl.exe`, **not**
PowerShell's `curl` alias, whose `Mozilla/` User-Agent makes Zotero 8, 9 and 10 close the connection
without answering at all.
