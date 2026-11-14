# Phase 13 — Integration correction from real-host evidence

Version stays **0.3.11** while this phase is written: it corrects the integration work of phase 12
against what an operator actually saw on a real machine. **It shipped as 0.3.12** — at the operator's
request the corrections became their own release rather than a re-issue of the 0.3.11 artifact, so
0.3.11 stays exactly as it was published and 0.3.12 is the artifact to install. Everything below was
written for 0.3.11 and re-verified on the 0.3.12 tree; the receipts in
[acceptance.md](acceptance.md) carry the 0.3.12 numbers.

## 1. The report

An operator ran the Toolkit on **Windows with Zotero 10 installed** (the current release) and
reported:

1. Zotero was installed and the Toolkit **correctly identified the installation**.
2. The checks in the GUI **were not successful**.
3. The **"Check now" button did not work correctly**.
4. The **guided Semantic Scholar key flow** had a problem.
5. The guided installation of Zotero was integrated correctly.

Reported symptoms are evidence. They are not diagnoses, and this document keeps the two apart.

## 2. What was reproduced here

There is no Zotero in this container. The shipped probe path was run unchanged against an
**emulated Zotero HTTP server bound to the real port** `127.0.0.1:23119`. The harness and the
measured matrix are in [evidence/realhost-2026-11-12/README.md](../../evidence/realhost-2026-11-12/README.md).

The decisive measurements:

- A server that **closes the connection without answering crashes the probe**.
  `http.client.RemoteDisconnected` is a `ConnectionResetError`, not a `URLError`, so it escapes
  `_zotero_request`. `probe_integrations()` guards neither provider, so **one provider's crash
  discards the whole receipt** and Semantic Scholar is never checked either.
- **HTTP 401, HTTP 404 and a non-JSON 200 all collapse to outcome `unknown` with the same generic
  sentence.** The Toolkit cannot tell the operator what the service actually said. On the operator's
  machine that is the difference between a fixable problem and an unexplainable one.
- A server that accepts only `Host: localhost:23119` is reported as **"the local API preference is
  off"** — a wrong instruction about a setting that may already be on.

## 3. Primary-source facts about Zotero 10's local API

From [Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/local_api):

| Fact | Consequence for the Toolkit |
|---|---|
| "Read requests require no authentication." | A 401 on a read is **not** Zotero asking for a credential. It means the request itself was not accepted. The Toolkit must not imply a missing credential. |
| "The local API must be enabled in Zotero's preferences (Settings → Advanced → 'Allow other applications on this computer to communicate with Zotero'). Requests will return `403 Forbidden` if it is not enabled." | The 403 mapping is correct and is the strongest actionable signal Zotero gives. |
| Base URL `http://localhost:23119/api/`; *"request `/api/` first and read the `Zotero-API-Version` response header"*. | The probe should ask the documented root **before** the collection listing. A 403 at the root has a documented meaning; a 404 at the listing does not. |
| "Because nothing touches the network, the local API works offline, **has no rate limits**." | A second small loopback request is harmless. There is no rate-limit reason to avoid root-then-listing. |
| Zotero 10+ every response carries `Zotero-Server-ID`. | Its presence is positive evidence that a Zotero 10+ answered, and identifies which instance. |
| Zotero 10+ **writes** need a runtime-authorized local key via `POST /api/local/authorize`, which shows the user a dialog; a missing key gives 401 with `WWW-Authenticate: Zotero-API-Key realm="Zotero Local API"`. | The Toolkit writes nothing to Zotero and must not call the authorize endpoint. That dialog belongs to the user's decision, not to a readiness check. |

The connector endpoints in [HTTP Citing Protocol](https://www.zotero.org/support/dev/client_coding/http_integration_protocol)
are documented at `http://127.0.0.1:23119/connector/...`, so `127.0.0.1` is an accepted loopback
form for the connector. Whether the local API accepts `Host: 127.0.0.1:23119` is **not documented**,
and is recorded here as an open question rather than answered.

## 4. Defect register

### Python worker (`src/research_stack/`)

| ID | Defect | Severity |
|---|---|---|
| P1 | A closed connection raises `RemoteDisconnected` out of the probe; `probe_integrations()` guards neither provider, so the whole check fails and the second provider is never assessed. | blocks the user |
| P2 | HTTP 401 is reported as `ZOTERO_REQUEST_FAILED` / `unknown` with a sentence naming no cause. | blocks diagnosis |
| P3 | HTTP 404 is indistinguishable, in the operator's sentence, from a wrong path or an absent Zotero. | degrades the message |
| P4 | A non-JSON 200 is reported as `unknown` with a sentence naming no cause. | degrades the message |
| P5 | An empty library yields `ready` without saying the library is empty. | degrades the message |
| P6 | The probe never asks the documented `/api/` root, so the one answer with a documented meaning is never obtained. | blocks diagnosis |
| P7 | The receipt carries no record of what the service actually returned, so a failure on the operator's machine cannot be reported usefully. | blocks diagnosis |
| P8 | **Found while fixing P6/P7.** `CALL_CEILING_MS` is documented as "no attempt loop outlives the caller's patience", but it counted only the pauses the loop *slept*. Four requests that each timed out after 15 s slept almost nothing, so the loop ran to about 66 s against a 20 s promise. A ceiling that does not bound what its own comment says it bounds. | blocks the check |
| P9 | `machinefacts.CLASSIFICATIONS` had no word for the 401 answer, so that probe result was refused as `FACTS_CLASSIFICATION_REFUSED` and silently discarded. | loses evidence |

### Extension host (`extension/extension.js`)

| ID | Defect | Severity |
|---|---|---|
| J1 | A completed check reports **"Done."** — the verdict sentences are built at `:270-275` and discarded at `:1540-1542`. This is the reported "button did not work". | blocks the user |
| J2 | Three of the five probe call sites bypass `exclusive()` (`:1301`, `:1378`, `:1398`), so buttons re-enable mid-probe and two presses start two workers. | degrades correctness |
| J3 | Opening "Integrations & Accounts" holds the lock for up to 20 000 ms (`:1290` with `PROBE_TIMEOUT_MS`), and `exclusive()` **throws** for everyone else (`:588-589`). | blocks the user |
| J4 | `check` is offered in every state while the host refuses it without a managed worker (`:240-241`), so a Zotero button produces an error about package components. | blocks the user |
| J5 | The Semantic Scholar modal's step 3 (`:1355`) orders the operator to press **"I already have a key"**, which is not offered until the integration is authorized (`integrations.js:311-314`) and is refused by `setIntegrationKey`. **This is the reported Semantic Scholar problem.** | blocks the guided flow |
| J6 | A dead output filter at `:276-278` never fires. | cosmetic |
| J7 | The 30 s shared cooldown is spent by the automatic check after Activate, then refuses the operator's deliberate "I have installed Zotero — check it now". | blocks the user temporarily |

### State model and panel (`extension/integrations.js`, `extension/media/controls.js`)

| ID | Defect | Severity |
|---|---|---|
| M1 | A machine installation fact older than 7 days is only annotated, never treated as unconfirmed, so `guideInstall` and `installedNow` never return. | removes a needed action |
| M2 | Zotero's card offers "Activate" forever, because only `authorizeSemanticScholar` ever writes `onboarding: "completed"`. Pressing it spends the shared check budget. | degrades the message |
| M3 | `controls.js:638` renders the literal word "undefined" when a result carries neither error nor message. | cosmetic, latent |
| M4 | `controls.js:634`'s `pendingRequests.size &&` term makes an **empty** pending set accept any request id — the opposite of the stated intent. | degrades correctness |
| M5 | `pendingRequests` grows without bound. | cosmetic |
| M6 | A button that cannot run is rendered as if it could, with no reason on it. | blocks the user |
| M7 | **Found by `scripts/panel_renderer_check.js`, not by the plan.** `applyControlAvailability()` returned on the `isReadOnly` branch before the unavailable branch, so a `data-readonly` control the renderer marked unavailable — `[data-action="updateNow"]`, measured — stayed `disabled=false` with no `aria-disabled` while carrying `data-unavailable="true"` and an explanatory title. | degrades correctness and accessibility |

## 5. Decisions

- **DD13-01 — the probe must report what the service said.** Root-then-listing, the HTTP status and
  a short clipped excerpt of the answer carried in the receipt's existing `evidence` field. A
  readiness check whose failure cannot be described is not a check.
- **DD13-02 — a readiness check must never crash.** Each provider is guarded; a crash becomes an
  `unknown` outcome with a code, and the receipt for the other provider is still produced.
- **DD13-03 — no write, no authorize call, no Zotero dialog.** Zotero 10's write authorization shows
  the user a dialog naming the application. A readiness check must not cause that.
- **DD13-04 — a 401 on a read is not a missing credential.** The sentence must not imply one.
- **DD13-05 — the verdict reaches the panel.** The check's own sentence is the result message.
- **DD13-06 — an action that cannot run is shown disabled with its reason**, not offered live and
  refused after the press.
- **DD13-07 — the guided key flow must describe the path that exists.** A key is not storable before
  the provider's terms are accepted; the modal must say to activate first.
- **DD13-08 — a stale machine fact is evidence, not a permanent veto.**
- **DD13-09 — the operator gets a diagnostic they can run themselves.**
  [scripts/zotero_local_check.py](../../scripts/zotero_local_check.py) is not packaged and not
  installed; it prints what Zotero actually answered and what each answer means.

## 6. What Zotero 10 actually does — answered from Zotero's own source

Read directly from `zotero/zotero` at tag **10.0.9**: `chrome/content/zotero/xpcom/server/server.js`,
`server_localAPI.js`, `server_connector.js`, `xpcom/zotero.js`, `defaults/preferences/zotero.js`, and
Zotero's own tests `server_localAPITest.js`.

**The Toolkit's request is correct.** Every part of it that looked suspicious is accepted by Zotero 10:

| Our request | Zotero 10's answer |
|---|---|
| `Host: 127.0.0.1:23119` | **Accepted.** The check is `/^(?:127\.0\.0\.1\|\[::1\]\|localhost)(?::[0-9]+)?$/i` (`server.js:325-330`). A wrong Host gives **400**, not 403. |
| `users/0` | **Correct.** It resolves to the local library with no sign-in (`server_localAPI.js:281-302`). Any other user ID gives 400. |
| `?format=json`, `?limit=100` | Both valid. JSON is the default, so `format=json` is a no-op. `format=atom` gives 501. |
| `Zotero-API-Version: 3` | Correct. A different value gives 501, except on `/api/`, which accepts any version by design. |
| `Zotero-Allowed-Request: 1` | Harmless. The browser gate only fires for a User-Agent starting with `Mozilla/` or a request carrying `Origin`; we send neither. |
| `User-Agent: Python-urllib/3.12` | Accepted. No allow-list exists. |
| `ProxyHandler({})` | **Required on Windows.** `urllib`'s default opener reads the registry proxy settings, and the `<local>` bypass does not cover `127.0.0.1` because the host contains dots. |
| IPv4 only | Correct choice. Zotero binds `PR_AF_INET` loopback only; `[::1]:23119` is refused. **Do not switch to `localhost`.** |

**What actually fails, and why:**

1. **`extensions.zotero.httpServer.localAPI.enabled` defaults to `false`** (`defaults/preferences/zotero.js:163`).
   A fresh Zotero answers **403** with the body `Local API is not enabled`. That is the expected answer, not a fault.
   No restart is needed for this preference.
2. **The local API waits for the library to load before answering anything** —
   `library.waitForDataLoad('item')` at `server_localAPI.js:306-309` — and the handler runs on Zotero's main
   thread, behind sync, full-text indexing and database writes. **Zotero's own Connector uses a 15 second
   timeout. The Toolkit uses 2 seconds.** On a real library, especially just after an update, a 2 second
   request times out and the Toolkit reports "no usable answer". **This is the leading explanation for the
   operator's report.**
3. **Connection refused is not absence.** Zotero opens the port late in startup, and if 23119 is already taken
   it does **not** fall back to another port — it logs an error and starts no HTTP server at all.
4. **`503` is dead code.** The local API never returns it. `400` is a real answer and the Toolkit does not map it.
5. **`/connector/ping` returns `text/html`**, body `<!DOCTYPE html><html><body>Zotero is running</body></html>`,
   and answers **whether or not the local-API preference is on**. It needs no browser extension.
6. **`HEAD /api/users/0/collections` short-circuits to 200 before the preference check** (`server.js:369-370`),
   so it proves "path registered and Host accepted" independently of the preference. That is a third distinct
   fact the Toolkit can obtain cheaply.
7. **Zotero 8, 9 and 10 close the connection with zero bytes** for a browser-lookalike request — deliberately,
   so web content cannot learn whether Zotero is running. Zotero 7 answered 403 `Request not allowed` instead.
   On Windows the usual trigger is PowerShell's `curl` alias, which sends a `Mozilla/` User-Agent.
8. **`/api` without the trailing slash is not registered** and returns 404.

## 7. Open questions, recorded rather than answered

- Whether the operator's VS Code host was local at all. If the Extension Host is remote (WSL, a dev container,
  Remote-SSH), `127.0.0.1` is not the Windows host and Zotero's loopback-only bind is unreachable. This is an
  inference from the binding evidence, **not** a documented Zotero behaviour, and it is a hypothesis to test.
- Whether Windows Firewall or third-party endpoint software blocks loopback to 23119 on the operator's machine.
  Zotero's own troubleshooting page names security software and proxy interception as causes; Windows Firewall
  itself is not documented as one.
- The recommended User-Agent for a third-party local client: **not documented anywhere found.**
- Semantic Scholar: **no documented 401 and no documented `Retry-After`.** The official swagger documents only
  200, 400 and 404; the 403-is-a-wrong-key and 429-are-too-fast meanings come from the AllenAI FAQ.

