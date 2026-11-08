# Phase 11 specification — one-time integration onboarding for Zotero and Semantic Scholar (0.3.11)

Date: 8 November 2026 (Europe/Prague). Predecessor: [specs/phase-10-marketplace-release](../phase-10-marketplace-release/spec.md) (0.3.10 update channel, problem reports, publication runbook).
Scope: a **Unified Integration Onboarding** — one place in the Toolkit that detects the two external
research services the Recommended and Full packages already name, asks for a decision only where a
decision is genuinely needed, stores that decision once per VS Code profile, and stops asking again
in every other workspace. Three processes are separated deliberately: **installation** (is the thing
there), **authorization** (has the operator agreed), **readiness** (does it answer right now).

Excluded, as briefed: writing to Zotero (the Toolkit still prepares RIS files for a manual import),
cloud Zotero and OAuth, automatic account creation, automatic API-key issuance, any cross-profile
secret sharing, and any network call the operator did not ask for. Development happens in the
DeepSeek Harness container (Debian 13, CPython 3.12.16 venv, Node 24, uv 0.13.6). A live Zotero
installation, a live Windows VS Code / Copilot session and a real Semantic Scholar key are **not
reachable from this container**; no case in [acceptance.md](acceptance.md) claims one.

## 1. Baseline that was measured, not assumed

| Fact | How it was measured here |
|---|---|
| Both services are already declared, with no activation and no verification: `install.mode: "external"`, `install.verify: "none"`, `step: null`. | `extension/components.json:356-375` (`semantic-scholar-academic-graph`), `:377-396` (`zotero-local-api`). |
| The Python adapters already exist and are already bounded: loopback-only Zotero opener that bypasses proxies and refuses every redirect, same-host HTTPS-only provider redirects, 4 MiB response cap, per-provider 1 req/s pacing floor, `Retry-After` carried into the error. | `src/research_stack/research.py:26,48-59,139-185,432-452`. |
| Semantic Scholar is gated on an explicit acknowledgement, and its key is read from the process environment only. | `research.py:270` (`x-api-key`), `research.py:374-379` (`SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED`). |
| The MCP server definitions pass exactly two environment variables today, and no provider credential. | `extension/extension.js:718-721`. |
| `context.secrets` and `context.workspaceState` are never used anywhere in the extension; `globalState` holds two keys. | `extension/extension.js:14,265-270,900-906,961-963`; grep over `extension/*.js`. |
| Packaged JavaScript may open exactly one socket, in `updates.js`, and the audit enforces it in both directions. | `extension/test/module-boundaries.test.js:110-127`; `scripts/verify_vsix.py:142-154,362-378`. |
| Packaged Python outbound capability is a measured list, not a ban. | `scripts/verify_vsix.py:187,362-378,535-546`. |
| The artifact has 33 898 bytes of headroom under the reviewed unpacked ceiling. | `dist/research-stack-toolkit-0.3.10.vsix` → 1 276 822 unpacked against `MAX_UNPACKED_BYTES = 1_310_720` (`scripts/verify_vsix.py:122`). |
| `shippedModules()` sees top-level `extension/*.js` only, and its require regex cannot see a subdirectory import. | `extension/test/module-boundaries.test.js:42-47,54`. |
| Baseline before this phase: Node 390/390 pass, Python 258 pass. | `npm test` and `uv run --locked python -m pytest -o addopts="" -q` on 8 November 2026. |

## 2. Findings

1. **`install.verify: "none"` is the whole problem.** The Toolkit knows Zotero and Semantic Scholar
   exist as components and knows nothing else about them: no detection, no consent record, no
   readiness, no per-workspace memory of what the operator already decided. Every workspace therefore
   starts from the same blank guide.
2. **A single boolean would be a defect, not a simplification.** "Zotero configured earlier, not
   running now" and "Zotero never installed" produce the same connection failure at
   `localhost:23119` and must not produce the same message: the first must not restart onboarding,
   the second must offer the installer. A 429 from Semantic Scholar must not look like a lost account.
3. **The obvious implementation would break a reviewed gate.** A Zotero probe written in the extension
   host would add a second socket-carrying JavaScript module and fail
   `module-boundaries.test.js:119` and `verify_vsix.py:367-371`. The reviewed capability already
   exists in the Python worker, with better protections than a new host client would have.
4. **The proposed `extension/integrations/` directory would escape the module gate.** `shippedModules()`
   lists top-level files and the require regex has no `/` in its character class, so a subdirectory
   module joins the payload unreviewed.
5. **`globalState` is per profile, and the brief's "once in the whole VS Code installation" is
   stronger than it.** Claiming cross-profile onboarding from `globalState` would be a false promise;
   the honest first release is once per profile, stated as such, with cross-profile sharing named as
   an open item (INT-12).
6. **The licence acknowledgement is not a checkbox.** Semantic Scholar's API licence limits the use
   to non-commercial research and education and requires attribution on public display
   (`research.py:224-229` already carries `publicDisplayRequiresNameAndLogo`). A Toolkit record of
   "acknowledged" must not be presented as a licence grant.
7. **A secret has four leak paths that a test has to close**: the MCP definition env, the child
   process argv, the diagnostics text the Toolkit copies to the clipboard, and the problem report.
   `reports.js` already removes token-shaped strings; the new code must not depend on that as its
   first line of defence.

## 3. Requirements

| ID | Requirement | Priority |
|---|---|---|
| INT-01 | One onboarding flow in the Toolkit GUI covers Zotero and Semantic Scholar. | P0 |
| INT-02 | Existing installations, existing environment configuration and existing consent are detected, not re-asked. | P0 |
| INT-03 | An authorization decision is taken once per VS Code profile and is not repeated in another workspace. | P0 |
| INT-04 | Zotero local reading needs no Toolkit account and no Toolkit key. | P0 |
| INT-05 | Semantic Scholar works with no API key once the operator has acknowledged the licence. | P0 |
| INT-06 | A required condition is confirmed by the operator, explicitly, and the confirmation is recorded with a reference and a time. | P0 |
| INT-07 | A key the operator chooses is stored in VS Code SecretStorage and never appears in a workspace file, a log, a diagnostic or a report. | P0 |
| INT-08 | Detection, probing and repair are asynchronous, bounded, and resumable after a failure. | P0 |
| INT-09 | Installation, authorization and readiness are separate stored dimensions with separate wording. | P0 |
| INT-10 | The operator can deactivate an integration, replace its key, and reset it. | P0 |
| INT-11 | Existing environment configuration is reported and preserved; nothing is deleted or silently overridden. | P0 |
| INT-12 | Sharing the decision across VS Code profiles of the same OS user. | P1 — open |
| INT-13 | Optional guided Zotero installation through the platform's package manager. | P1 — open |
| INT-14 | A remote Zotero library. | P2 — out of this release |

## 4. Non-functional requirements

| ID | Requirement |
|---|---|
| NF11-01 | Activation performs no probe and no request. |
| NF11-02 | No packaged JavaScript member other than `updates.js` gains a socket; the audit still names one. |
| NF11-03 | A readiness probe runs through the reviewed process boundary (`runner.js`) with a stated timeout. |
| NF11-04 | The unpacked artifact stays under the reviewed 1 310 720 byte ceiling. |
| NF11-05 | The webview keeps its CSP, its nonce, and its message whitelist; no secret is sent to it. |
| NF11-06 | An untrusted or remote workspace gets no local access and no probe. |
| NF11-07 | Warm readiness work stays inside the host-test budget the 0.3.10 release measured. |
