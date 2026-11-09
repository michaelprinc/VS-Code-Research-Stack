# Phase 12 specification — integration resilience, guided installation and shared state (0.3.11, extended)

Date: 8 November 2026 (Europe/Prague). Predecessor: [specs/phase-11-integration-onboarding](../phase-11-integration-onboarding/spec.md)
(one-time onboarding, four-dimension state, SecretStorage, readiness probe as a worker verb). This phase **extends the
unreleased 0.3.11** rather than opening 0.3.12: 0.3.11 has not been committed or published, and the work below closes
gaps that 0.3.11 itself named as open (INT-12, INT-13) plus a failure the operator actually observed — Semantic Scholar
rate limiting.

Scope: four separable specifications.

| Spec | Scope | Why it is separable |
|---|---|---|
| **INT-13A** | Zotero **guided** installation: detect the platform, find an existing installation, guide the operator to the official download, then test the local API. | No download, no execution, no new capability. Lowest risk, highest user value. |
| **INT-13B** | **Verified** installer staging: fetch an artifact from a pinned official origin, verify it, and hand it over only after explicit consent. | Adds the only new outbound capability in this phase; needs its own gate and its own evidence. |
| **INT-14** | Semantic Scholar onboarding made resilient: guided key request, key validation, a **shared** request scheduler, bounded retries, caching, degraded mode. | Lives in the Python worker, where the network already is; testable with mocks. |
| **INT-15** | Shared integration management: three classes of state, machine-level discovery reuse, diagnostics and recovery. | Cross-cutting; the other three read and write the state it defines. |

Excluded, as briefed: Zotero write access and Zotero cloud/OAuth, automatic account creation, automatic API-key issuance,
sharing secrets between VS Code profiles, unattended execution of any installer, and any alternative metadata provider
(Crossref/OpenAlex) presented as equivalent to Semantic Scholar. Development happens in the DeepSeek Harness container
(Debian 13, CPython 3.12.16 venv, Node 24, uv 0.13.6). **A live Zotero installation, a real Semantic Scholar key, a live
Windows VS Code session and a real Extension Host are not reachable from this container**; no acceptance case claims one,
and every platform-specific behaviour that cannot be run here is named as unverified rather than implied.

## 1. Baseline that was measured, not assumed

| Fact | How it was measured here |
|---|---|
| 0.3.11 as it stands: Node 436/436 pass, Python 273 pass, artifact 108 members, 1 343 649 unpacked against a 1 376 256 ceiling — **32 607 bytes of headroom**. | `evidence/quality-v0.3.11-2026-11-08/` (`node-suite.txt`, `python-suite.txt`, `vsix-audit.json`). |
| The Python adapters already pace: a per-provider 1 req/s floor, a 4 MiB response cap, HTTPS-only same-host redirects, and a loopback-only Zotero opener that bypasses proxies and refuses every redirect. | `src/research_stack/research.py:26,48-59,139-185,432-452`. |
| `Retry-After` is already carried into the error text, but nothing acts on it. | `src/research_stack/research.py` (quoted in the request-path map, DD12-01). |
| The pacing is **per process**. Several processes can call the provider at the same time in one VS Code session. | Request-path map, DD12-01; the extension starts MCP server processes per preset. |
| Packaged JavaScript may open exactly one socket, in `updates.js`; packaged Python outbound capability is a **measured list**, not a ban. | `extension/test/module-boundaries.test.js:110-127`; `scripts/verify_vsix.py:142-154,187,362-378,535-546`. |
| `context.secrets` is used for integration keys; `globalState` holds the integration registry; `workspaceState` is unused. | `extension/integrationstore.js`, `extension/extension.js`. |
| The probe is a worker verb and performs no request for Semantic Scholar before consent: `PROVIDER_TERMS_NOT_ACKNOWLEDGED`. | `evidence/quality-v0.3.11-2026-11-08/probe-receipt.json`. |
| Zotero on this host answers `not-installed` / `ZOTERO_NOT_AVAILABLE` with the statement that no library file was opened. | `evidence/quality-v0.3.11-2026-11-08/probe-receipt-zotero.json`. |

## 2. Findings

1. **A 429 is not a lost account.** The observed failure — Semantic Scholar refusing requests — is the documented shape of
   a shared anonymous pool, not a fault in the Toolkit. A state model that maps 429 to "unavailable" and re-asks the
   operator to re-authorize is worse than the outage it describes. The fix is a scheduler that spaces requests, honours
   `Retry-After`, and reports a bounded wait instead of a failure.
2. **Per-process pacing is the wrong unit.** The provider limits the *caller*, not the process. In a real session the
   Toolkit can have several MCP server processes plus CLI invocations alive at once; each pacing itself at 1 req/s
   multiplies the rate by the number of processes. A shared budget has to live outside the process, which means a file,
   which means a lock, which means a location that is not the workspace.
3. **The workspace is the wrong place for a shared budget.** Two windows on two different projects are the exact case the
   operator complained about. A budget kept per workspace does not fix it. This is the same reason INT-12 needs a
   machine-level record: installation facts and rate budgets belong to the *machine and user*, consent and credentials
   belong to the *profile*, keys belong to *SecretStorage*. Three classes, three locations, no mixing.
4. **Guided installation and automatic installation are different products.** Guided needs no new capability: open the
   official page, detect afterwards, test the local API. Automatic needs an outbound fetch, a verification decision, and
   a consent gate before anything runs. Doing the first well is worth more than doing the second quickly, and the second
   is only honest if the publisher's artifact can actually be verified — which is a fact to be established, not assumed
   (see §5, TBD-1).
5. **"Downloaded over HTTPS from the official site" is not verification.** HTTPS proves the channel, not the artifact.
   A signature proves the publisher only if the expected publisher identity is also checked; a valid signature by an
   unrelated signer is not evidence. If no independently obtainable checksum or pinned digest exists for the artifact,
   the Toolkit must say *guided* and must not run the installer.
6. **Zotero's local API gives the distinction the state model needs.** "Installed but not running", "running but refusing
   local clients" and "ready" are three different answers at `localhost:23119`, and the third one tells the operator
   exactly which Zotero setting to change. 0.3.11 collapsed these into `not-installed` because it only looked for a
   library file.
7. **The byte budget is a real constraint on this phase.** 32 607 bytes of headroom, and every new Python module ships
   twice (source tree and packaged worker copy). The phase must either fit inside the reviewed ceiling or re-measure it
   with member-by-member attribution as 0.3.11 did (DD11-10). Silently exceeding it is not an option.

## 3. Requirements

| ID | Requirement | Spec | Priority |
|---|---|---|---|
| INT-15.1 | Setup state is stored in three classes with three locations: machine-level discovery, profile state, secrets. A secret never enters the first two. | INT-15 | P0 |
| INT-15.2 | A new VS Code profile reuses a machine-level *installation* fact instead of re-asking, and never inherits another profile's consent or key. | INT-15 | P0 |
| INT-15.3 | The machine-level record is non-sensitive, size-capped, atomically written, documented, and testably free of credential-shaped content. | INT-15 | P0 |
| INT-15.4 | Diagnostics name the state class each fact came from and how to recover from a wrong one. | INT-15 | P1 |
| INT-14.1 | Semantic Scholar onboarding offers the official API-key application as a step, explains how the key is delivered, and never asks the operator to paste a key into a workspace file or a chat. | INT-14 | P0 |
| INT-14.2 | An existing key is detected and tested with one lightweight request before any onboarding is offered. | INT-14 | P0 |
| INT-14.3 | A key entered by the operator is validated and stored in SecretStorage only. | INT-14 | P0 |
| INT-14.4 | HTTP 401/403 and HTTP 429 produce different codes, different wording and different next actions. | INT-14 | P0 |
| INT-15.5 | All Toolkit callers share one request budget per provider per user, across processes. | INT-15 | P0 |
| INT-14.5 | A rate-limited request honours `Retry-After` when supplied, otherwise exponential backoff with jitter, with a stated maximum number of attempts and a stated maximum total wait. | INT-14 | P0 |
| INT-14.6 | Identical concurrent requests are deduplicated; a bounded response cache is consulted before a provider call. | INT-14 | P0 |
| INT-14.7 | When the provider is unavailable the Toolkit returns a degraded result that keeps the rest of the Toolkit working, and says what to do next. | INT-14 | P0 |
| INT-13A.1 | The Toolkit detects the platform and looks for an existing Zotero installation before proposing any download. | INT-13A | P0 |
| INT-13A.2 | When Zotero is missing, the Toolkit offers guided installation from the official source and does not download or run anything. | INT-13A | P0 |
| INT-13A.3 | When Zotero is installed but its local API refuses, the Toolkit names the exact Zotero setting to change. | INT-13A | P0 |
| INT-13A.4 | After installation the Toolkit re-detects and runs a connection test, without being asked to. | INT-13A | P1 |
| INT-13A.5 | Pointing the Toolkit at an existing Zotero is read-only: existence and version facts, no execution, no library write. | INT-13A | P0 |
| INT-13B.1 | An installer is fetched only from a pinned official origin, over HTTPS, with a size cap and a redirect policy that cannot leave that origin. | INT-13B | P1 |
| INT-13B.2 | An artifact is verified against a pinned expected digest before it may be executed; the expected publisher identity is checked where the platform supports it. | INT-13B | P1 |
| INT-13B.3 | Nothing is executed without an explicit consent step that names the file, its origin and its digest. | INT-13B | P1 |
| INT-13B.4 | If verification is unavailable on the platform, the Toolkit offers guided installation and says why automatic installation is not offered. | INT-13B | P0 |
| INT-13B.5 | After any installation the Toolkit validates the outcome by detection, not by the installer's exit code. | INT-13B | P1 |
| NF12-01 | No packaged JavaScript member other than `updates.js` gains a network transport. | all | P0 |
| NF12-02 | Any new outbound capability in Python is named in the audit's reviewed list with its host, its cap and its timeout. | INT-13B | P0 |
| NF12-03 | The unpacked artifact stays under the reviewed ceiling, or the ceiling is re-measured with member-by-member attribution. | all | P0 |
| NF12-04 | Activation performs no probe, no request and no file write outside the documented locations. | all | P0 |
| NF12-05 | Setup actions are idempotent: running the same guide twice does not duplicate state, keys or files. | all | P0 |
| NF12-06 | A failure in one provider does not disable unrelated Toolkit components. | all | P0 |
| NF12-07 | Every platform-specific behaviour not exercised in this container is documented as unverified. | all | P0 |

## 4. Acceptance conditions the operator named

Each maps to a case in [acceptance.md](acceptance.md).

1. Zotero already installed → no redundant installation prompt.
2. Zotero missing → guided installation offered.
3. Corrupted or untrusted installer → execution blocked.
4. Zotero running with the local API disabled → actionable instructions.
5. Semantic Scholar key missing → onboarding offered without blocking unrelated features.
6. Semantic Scholar HTTP 429 → bounded retries, informative feedback, no infinite loop.
7. Multiple concurrent agent requests → one shared rate limit respected.
8. Restart or profile change → installation rediscovered, setup not repeated.
9. Windows, macOS, Linux and remote Extension Host → documented behaviour per platform, with what is untested stated.

## 5. Facts that were established before the design was fixed

All six were answered on 8 November 2026 by [documentation-review.md](documentation-review.md), which carries the source
URL, the access date and whether each statement is documented, source-level, observed or third-party. The decisions they
forced are DD12-15 through DD12-20.

| ID | Question | Answer | Decision it forced |
|---|---|---|---|
| TBD-1 | Does Zotero publish an official checksum for its installers? | **No.** Every candidate file 404s; the only official checksums are SHA-512 for `.mar` update archives. Linux has neither checksum nor signature. | DD12-15 — verified automatic installation is not offered |
| TBD-2 | The documented Semantic Scholar limits and their unit? | 1000 RPS **shared among all unauthenticated users**; a key gives 1 RPS **across all endpoints**. | DD12-16 — budgets stay the Toolkit's own and conservative |
| TBD-3 | The official API-key application page and delivery? | `https://www.semanticscholar.org/product/api#api-key-form`; the key arrives **by email**; the form requires an academic or corporate email and a promise to apply exponential backoff. | INT-14.1 wording |
| TBD-4 | What does the Zotero local API return when disabled, and can a client tell? | **403 Forbidden**, and the setting is Settings → Advanced → "Allow other applications on this computer to communicate with Zotero". `/connector/ping` is not gated on it, which gives a genuine three-state probe. | DD12-19 |
| TBD-5 | An identifier for the loaded Zotero library? | `Zotero-Server-ID` (Zotero 10+), identifies the **database**, and clients should partition stored data by it. | DD12-19 |
| TBD-6 | Official download endpoints, artifact types, install and data locations? | `download.zotero.org/client/release/<version>/…` is the reproducible form; ten platform ids; per-user install by cancelling the UAC prompt; a ZIP variant; data directory `~/Zotero` on all three platforms. Install detection is **not documented**. | DD12-15 |


## 6. What this phase will not claim

It will not claim a verified automatic installation on a platform whose installer it could not verify. It will not claim
a rate limit it did not read from the provider's own documentation. It will not claim a live Zotero connection, a real
key, a Windows run or a real Extension Host session from container-side tests. Where a case cannot be run here, the
acceptance file names the container-side substitute and states what it does and does not prove.
