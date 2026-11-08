# Phase 11 design — the unified integration onboarding (0.3.11)

Line numbers refer to the 0.3.10 tree (`v0.3.10`) unless stated. Each decision names the fact it
comes from and the gate it has to survive.

## DD11-01 — No packaged JavaScript module gains an outbound socket. The probe runs in the worker.

The 0.3.10 audit names `updates.js` as the only packaged JavaScript member that can reach a socket
(`extension/test/module-boundaries.test.js:110-127`, `scripts/verify_vsix.py:142-154,362-378`), and
names the Python members that can reach the network as a measured list. Zotero's local API
(`http://localhost:23119/api`, `src/research_stack/research.py:26`) and the Semantic Scholar endpoint
(`research.py:271`) are **already** reached from reviewed Python, with the reviewed protections:
loopback-only opener that bypasses proxies and refuses every redirect (`research.py:432-452`),
same-host HTTPS-only redirects for providers (`research.py:48-54`), a 4 MiB response cap, a
per-provider one-request-per-second pacing floor (`research.py:31-33,174-185`), and a `Retry-After`
carried into the error (`research.py:158-167`).

Decision: the readiness probe is a **worker verb** — `research-stack probe-integrations` — invoked
through the existing reviewed process boundary (`runner.js`), exactly like `index-corpus` and
`verify-sources` are (`extension.js:617-626`). The extension host keeps its zero-socket shape; the
new outbound member is a Python module that calls the reviewed adapters, not a second HTTP client.

Consequence the operator sees: an integration readiness check needs the managed worker, so a
workspace that has not run component setup reports `unchecked` with that sentence, not a failure.

## DD11-02 — Three new top-level modules, not a subdirectory.

`shippedModules()` enumerates top-level `extension/*.js` only
(`module-boundaries.test.js:42-47`) and the require scan regex
(`/require\("\.\/([A-Za-z0-9_.-]+?)(?:\.js)?"/g`, line 54) cannot see `require("./integrations/x")`.
A `extension/integrations/` directory would therefore join the shipped payload **outside** the
reviewed module graph — the exact hole the gate exists to close.

Decision: `extension/integrations.js`, `extension/integrationstore.js`, `extension/integrationprobe.js`,
added to `REVIEWED`, to the staged list in `extension/scripts/package.js`, to `files` in both manifests,
and to `EXPECTED` in `scripts/verify_vsix.py`. The brief's directory layout is deliberately not followed;
the gate is worth more than the layout.

## DD11-03 — Four dimensions, never one `isReady` flag.

| Dimension | Values |
|---|---|
| `installation` | `not-detected`, `detected`, `not-applicable`, `unknown` |
| `authorization` | `not-required`, `awaiting-consent`, `authorized`, `revoked` |
| `readiness` | `unchecked`, `ready`, `unavailable`, `degraded` |
| `onboarding` | `not-started`, `in-progress`, `completed`, `skipped` |

`degraded` is the state a rate limit produces: HTTP 429 keeps the authorization and the key, and
sets `readiness: "degraded"` with the `Retry-After` window. A configured Zotero that is simply not
running is `installation: "detected"`, `authorization: "not-required"`, `readiness: "unavailable"` —
the panel says "Configured — Zotero is not answering", and the onboarding guide does **not** restart.

## DD11-04 — One global record, one secret per provider.

`globalState` key `researchToolkit.integrations`, schema version 1:

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-11-08T14:00:00.000Z",
  "providers": {
    "zotero": {
      "installation": "detected",
      "authorization": "not-required",
      "readiness": "ready",
      "onboarding": "completed",
      "lastCheck": { "at": "…", "outcome": "ready", "code": null, "detail": "…" },
      "lastSuccessfulCheckAt": "…"
    },
    "semantic-scholar": {
      "installation": "not-applicable",
      "authorization": "authorized",
      "mode": "anonymous",
      "license": { "acknowledged": true, "reference": "s2-api-license-2026-11", "acknowledgedAt": "…" },
      "credentials": { "storage": "vscode-secret-storage", "configured": false },
      "readiness": "unchecked",
      "onboarding": "completed",
      "lastCheck": null,
      "lastSuccessfulCheckAt": null
    }
  },
  "lastProbeAt": null
}
```

`lastProbeAt` lives in `globalState`, not in memory, because several VS Code windows share it and
T11-12 asks that they not exceed one shared budget together.

SecretStorage keys: `researchStack.integration/semantic-scholar/apiKey`. Nothing secret goes into
`globalState`, `workspaceState`, `.mcp.json`, `settings.json`, a workspace file, the setup log, the
diagnostics clipboard text, or the problem report.

`globalState` is per VS Code profile. Cross-profile sharing (INT-12) is **not** implemented in
0.3.11 and the panel says so rather than implying it.

## DD11-05 — Consent is an operator act, recorded with a reference.

Semantic Scholar's API licence is acknowledged by an explicit operator action in the panel or a
modal, never by the Toolkit. The record stores the reference string and the timestamp, and the panel
links the licence text. A Toolkit version bump does not re-ask; a revocation does. The panel states
that the Toolkit's record does not replace any consent the provider itself requires and does not
grant rights beyond the licence.

The Python gate `SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED` (`research.py:374`) stays the enforcement
point. The host sets it in the child environment **only** when the record says authorized.

## DD11-06 — Credentials reach a worker only when authorized, and only the worker that needs them.

`provideMcpServerDefinitions` (`extension.js:699-723`) currently passes exactly two environment
variables. It gains, for the `research_stack.recommended_server` definition only:

* `SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED: "true"` when the record is authorized;
* `SEMANTIC_SCHOLAR_API_KEY` from SecretStorage when `mode: "api-key"` and a key is stored.

The signature (`presetSurfaceSignature`, `extension.js:733-736`) gains an integration fingerprint so
authorizing or revoking refreshes the client's tool surface **without re-installing any component**.
An unauthorized integration injects nothing. A key is never read into the webview, and the panel
reports only `configured: true|false`.

## DD11-07 — Nothing probes at activation.

Activation performs no probe and no request. A readiness probe runs when the operator presses Check
integrations, runs a command, or activates an integration. Zotero's probe is loopback-only; Semantic
Scholar's probe is a real provider request and therefore only ever follows an explicit action.
A cooldown read from `globalState` bounds how often any window may probe.

## DD11-08 — Migration reads, never deletes.

`migrationFromEnvironment` reports what the host process already carries — `SEMANTIC_SCHOLAR_API_KEY`,
`SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED`, `CROSSREF_MAILTO`, `CROSSREF_PLUS_API_TOKEN`,
`OPENALEX_API_KEY` — as "already configured outside the Toolkit", with the value never read into the
record, never displayed, and never removed. A workspace-level setting is not silently overwritten by
the global record; the panel states which layer the worker will actually see.

## DD11-09 — Rate limiting stays where it is measured.

The per-provider pacing floor in `research.py` is process-local and stays. The host adds a
cross-window probe cooldown from `globalState` (`PROBE_COOLDOWN_MS = 30 000`) so several windows do
not each fire a readiness probe. A `degraded` verdict carries `retryAfter` from the provider.

## DD11-10 — Byte budget.

The 0.3.10 artifact unpacks to 1 276 822 of the reviewed 1 310 720 ceiling
(`scripts/verify_vsix.py:122`) — 33 898 bytes of headroom. No new guide file is added: the existing
`guides/zotero-local-api.md` and `guides/semantic-scholar-academic-graph.md` are updated in place,
and `components.json` gains the onboarding affordance through `nextAction` and a new
`install.verify` value rather than a new component. The new modules are measured against the ceiling
by the audit, not assumed to fit.

## DD11-11 — The state machine.

```
onboarding:  not-started ──▶ in-progress ──▶ completed
                    └───────────────────────▶ skipped
authorization: not-required (zotero)          awaiting-consent ──▶ authorized ⇄ revoked
               not-required (semantic-scholar, before consent)
readiness:     unchecked ──▶ ready | unavailable | degraded
               ready ⇄ unavailable ⇄ degraded      (never clears authorization)
installation:  unknown ──▶ detected | not-detected   (semantic-scholar: not-applicable)
```

Revoking sets `authorization: "revoked"`, clears the stored secret, and stops injection. It does not
delete the record: the operator can re-authorize without re-running the guide.

## DD11-12 — What this container cannot prove.

No live Zotero installation, no live VS Code Extension Host, no Windows host, and no real Semantic
Scholar key are reachable here. Every case that needs one is recorded as open in `acceptance.md`,
with the container-side substitute named.
