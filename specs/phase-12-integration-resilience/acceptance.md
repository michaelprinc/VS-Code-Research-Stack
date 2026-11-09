# Phase 12 acceptance — integration resilience, guided installation and shared state (0.3.11, extended)

Each case states what it asserts, **how it is actually run in this container**, and **what it does not prove**. A case
that cannot be run here is marked `NOT RUN HERE` with the substitute named, never quietly replaced by a mock and reported
as passed.

Suites as they must read at the end of the phase: `npm test` (all Node test files), `uv run --locked python -m pytest -o addopts="" -q`,
`npm run verify-package`, `npm run check:payload`.

## 1. Semantic Scholar resilience (INT-14)

| ID | Case | Run here as | Proves / does not prove |
|---|---|---|---|
| T12-01 | A 429 with `Retry-After: 4` makes the Toolkit wait, and the wait is shared: a second, unrelated caller is refused until the instant passes. | `tests/test_provider_budget.py` with an injected clock and a fake transport that raises `urllib.error.HTTPError(url, 429, …, {"Retry-After": "4"}, None)`. | Proves the header is acted on and that the block is visible across two callers sharing the budget file. **Does not prove** the provider sends that header or that 4 seconds is the right wait. |
| T12-02 | A 429 without `Retry-After` produces a bounded schedule: a stated maximum number of attempts and a stated maximum total wait. | same, asserting the attempt count and the summed wait | Proves no infinite retry loop. Does not prove the schedule matches the provider's documented limits (TBD-2). |
| T12-03 | Jitter stays inside its stated bounds and is not degenerate. | seeded draws over many attempts, asserting min/max and that not all draws are equal | Proves the bounds hold and that processes will not all wake in step. |
| T12-04 | A provider that always returns 429 ends in a **degraded result**, not a hang and not an exception at the CLI. | the fake always 429s; assert the returned shape and that `cli.py` prints a receipt, not a traceback | Proves the failure is survivable end to end through the CLI boundary. |
| T12-05 | 401 and 403 are **not** retried and are worded differently from 429. | fake raises 401 and 403; assert exactly one attempt, `PROVIDER_AUTH_REQUIRED`, and that the detail differs from the 429 detail | Proves the two conditions stay distinct, which is the defect the operator reported. |
| T12-06 | `Retry-After` parsing handles delta-seconds, an HTTP-date, a garbage value, and a value above the clamp. | unit cases | Proves a hostile or malformed header cannot make the Toolkit wait forever. |
| T12-07 | Two callers asking for the same thing spend **one** permit, and the second gets the first's answer labelled as a cache hit. | injected clock + fake transport counting calls; assert the provider was called once | Proves dedup and that a cache hit is honestly labelled. |
| T12-08 | A stale in-flight claim does not deadlock: the second caller proceeds. | write a claim stamped in the past, then run the second caller | Proves a crashed process cannot freeze a request key. |
| T12-09 | A cache entry expires after its TTL and the provider is asked again. | advance the injected clock past the TTL | Proves the cache is a rate control, not a stale-data source. |
| T12-10 | **Concurrent agents respect one budget.** Several callers with separate in-memory state and one budget file produce a total request rate the budget allows, not N × the budget. | several callers against one budget file, asserting the issued-permit count | Proves the cross-process sharing that per-process pacing cannot give. **Does not prove** real MCP processes do this — see T12-20. |
| T12-11 | No key, key fragment or token-shaped string appears in the budget file, the cache file, the lock file, or any returned string. | sentinel key in the environment, then assert absence in every file written and in the JSON of every result | Proves the new shared files are not a leak path. |
| T12-12 | The budget file contains no workspace path and no absolute path to a user file. | read the written file and assert | Proves the machine-level file does not leak where the person was working. |
| T12-13 | A provider failure leaves the rest of the Toolkit working: a degraded Semantic Scholar answer does not disable the store tools. | existing store tool tests plus a degraded provider result | Proves NF12-06 at the tool level. |
| T12-14 | The guided key-request flow is offered when no key exists, and is **not** offered when one does. | `extension/test/integration-host.test.js` driving the real panel messages `requestApiKey`, `continueWithoutKey`, `testIntegrationKey` through the harness | **Proven.** The onboarding branch is state-aware, the three choices are offered with no key, replace/remove/test appear only with one, and "I already have a key" is withheld from an integration the operator has not authorized. The provider's page is the confirmed application form (`documentation-review.md`, TBD-3 closed) and the sentence "the provider emails the key to you" is asserted; **no real key was applied for and no real email was received** (T12-16). |
| T12-15 | A key the operator enters is validated before it is stored, and lands only in SecretStorage. | harness `secrets` recorder; assert the key is absent from globalState, the panel HTML, the output channel and every message | Proves INT-14.3 against the real wiring. |
| T12-16 | An invalid key produces the actionable message, not a retry loop. | fake 401 through the probe path | Proves the operator is told what to do. |

## 2. Zotero guided installation (INT-13A)

| ID | Case | Run here as | Proves / does not prove |
|---|---|---|---|
| T12-17 | A local API that answers gives `ready`, and the result says the answer came from the local API. | `tests/test_integrations.py` with `list_zotero_collections` / `_zotero_request` faked | Proves the probe asks the API first. **Does not prove** a real Zotero answers — no Zotero exists in this container. |
| T12-18 | Nothing listening gives `not-running`, and the wording does **not** claim Zotero is absent. | fake raises `ZOTERO_NOT_AVAILABLE` | Proves the distinction the 0.3.11 probe destroyed. |
| T12-19 | HTTP 403 gives `api-disabled` and says Zotero appears to be running and is refusing local clients. | fake raises `ZOTERO_API_DISABLED` | **Proven against fakes.** The setting is quoted in Zotero's own words — Settings → Advanced → "Allow other applications on this computer to communicate with Zotero" — and a test asserts the sentence is a substring of `extension/guides/zotero-local-api.md`, so a variant cannot be invented, and that no other Zotero pane is named. **NOT RUN HERE: a real Zotero.** Both `/api/` and `/connector/ping` give `ConnectionRefusedError` on this host, so the three-state answer is proven only against transport fakes. |
| T12-20 | The four Zotero answers produce four pairwise different detail sentences. | assert pairwise distinctness over the four results | Proves the collapse defect cannot silently return. |
| T12-21 | No library file is opened by any Zotero case. | the existing no-read assertion, extended to all four cases | Proves read-only intent is enforced by a test, not by a promise. |
| T12-22 | Zotero already installed → **no installation prompt**. | harness: probe says detected, then assert the guided-install action is absent from **both** the card and the Quick Pick, and that the host refuses a `guideIntegrationInstall` panel message outright | **Proven.** The operator is not re-pitched, and the refusal is at the host, not only in the rendering, so a stale panel cannot reach the guided path either. |
| T12-23 | Zotero missing → guided installation is offered, and the Toolkit states it downloaded and ran nothing. | harness: probe says not-installed, drive the real panel message, assert the guide text, the single `openExternal` to `https://www.zotero.org/download/`, one worker call, zero files written | **Proven at the wiring level.** "The Toolkit downloaded nothing and ran nothing: it opened no installer, wrote no file and changed no setting" is asserted in the shipped text, and a static gate asserts that no shipped integration module contains `setTimeout(`, `setInterval(` or `setImmediate(` — the re-check is operator-asked, never polled. |
| T12-39 | A request that connected to Zotero but produced no answer is **not** reported as "not running". | `tests/test_research.py` + `tests/test_integrations.py` with transport fakes raising `TimeoutError` / `ConnectionResetError` against `ConnectionRefusedError` | **Proven against fakes.** New internal code `ZOTERO_NO_ANSWER` maps to the existing `unknown` outcome with a sentence naming the documented Zotero 10 silent drop; `ConnectionRefusedError` still maps to `ZOTERO_NOT_AVAILABLE`. No new outcome word was added, so the host vocabulary is unchanged. |
| T12-40 | The Zotero endpoints are pinned to IPv4 loopback, and the request carries the header Zotero 10 requires. | static assertions over `research.py`, plus transport fakes that record the URL, the headers and `timeout=2` | **Proven.** `ZOTERO_LOCAL_API`, `ZOTERO_CONNECTOR_PING` and `ZOTERO_LOOPBACK_ORIGIN` are all `127.0.0.1`; `Zotero-Allowed-Request: 1` is sent on both endpoints; all three constants are reviewed bound literals in `scripts/verify_vsix.py`, so reverting to `localhost` fails the audit instead of shipping. |
| T12-24 | Detection looks for an existing installation before proposing a download, on the platform's documented locations. | unit cases over a synthetic filesystem | Proves the order of operations. **Windows and macOS paths are NOT RUN HERE** — see §5. |
| T12-25 | Pointing the Toolkit at an existing Zotero reads existence and version facts only: no execution, no library write. | unit cases asserting no process call and no write | Proves INT-13A.5. |

## 3. Verified installation staging (INT-13B)

**Status: not implemented, so T12-26 … T12-32 are NOT RUN and are not claimed.** The feature was rejected before it was
built (DD12-15): the publisher publishes no checksum for any installer, Linux builds have neither checksum nor signature,
and packaged Python is forbidden every process-execution primitive (DD12-12), so there is no reviewed place in the package
to stage, verify or hand over an artifact. T12-29 is the one case in this section that **is** proven — it is the gate that
proves the absence is real rather than a feature that was forgotten. The rest are written down so that if INT-13B is ever
attempted it has acceptance criteria before it has code, and so that nobody reads this section as a passing suite.

| ID | Case | Run here as | Proves / does not prove |
|---|---|---|---|
| T12-26 | An artifact whose digest does not match the pinned expectation is refused, and the refusal names the mismatch. | synthetic file with a wrong digest | Proves verification is real, not decorative. |
| T12-27 | A corrupted or truncated artifact is refused before any consent step is offered. | synthetic truncated file | Proves the operator is never asked to consent to a bad artifact. |
| T12-28 | A fetch that would leave the pinned host, or exceed the size cap, is refused. | injected transport returning an off-host redirect and an oversized body | Proves the bounds are enforced by the fetch, not by prose. **No real download is performed here.** |
| T12-29 | Nothing is executed. There is no code path in the package that launches an installer. | the audit's `PYTHON_FORBIDDEN_PRIMITIVE` scan plus `module-boundaries.test.js`'s single process boundary | Proves DD12-12 by gate, not by claim. |
| T12-30 | When verification is unavailable on the platform, the Toolkit says so and offers the guided path. | unit case over a platform with no verification support | Proves INT-13B.4 is a real branch, not a fallback that never runs. |
| T12-31 | Consent names the file, the origin and the digest before anything is handed over. | harness modal text assertion | Proves the consent is informed. |
| T12-32 | Installation outcome is validated by detection, not by an exit code. | unit case: staged artifact "installed" but detection fails → result says not installed | Proves INT-13B.5. |

## 4. Shared state across profiles (INT-15)

**Status: implemented in this build.** `src/research_stack/machinefacts.py` is the machine-level class, `context.globalState` the profile class and `context.secrets` the secret class, with the reuse boundary enforced by tests. T12-35, T12-36 and T12-37 are proven below. T12-33 and T12-34 are proven through the harness with a seeded machine record; **two real VS Code profiles of one OS user are NOT RUN HERE**, so the reuse is proven against a seeded record rather than against a second editor profile. The budget files are a second machine-level class and are **not** the installation fact: they record request timing, not installation.

| ID | Case | Run here as | Proves / does not prove |
|---|---|---|---|
| T12-33 | A fresh profile reads the machine-level installation fact and does **not** re-ask the installation question. | harness with a seeded machine file and an empty profile state | Proves INT-15.2. **Two real VS Code profiles are NOT RUN HERE.** |
| T12-34 | A fresh profile does **not** inherit another profile's consent, access mode or key. | seeded machine file with no consent; assert `awaiting-consent` and no key | Proves the reuse boundary. This is the case that keeps INT-12 honest. |
| T12-35 | The machine-level file is written atomically and is size-capped; an oversized write is refused, not truncated. | `tests/test_machinefacts.py` — the `os.replace` source/destination pair is recorded, and an oversized write is attempted against the real file | **Proven.** Temp file `integration-facts.json.<pid>-<seq>.tmp` opened `"xb"` then one `os.replace`; cap `MAX_FACTS_BYTES = 8 192` stated as the Toolkit's own bound; an oversized write returns `FACTS_TOO_LARGE` with the rule named and leaves the file byte-identical. No `fcntl`, no lock. |
| T12-36 | A stale machine-level fact pre-fills the panel but does not suppress the check. | `extension/test/integration-host.test.js` with an eight-day-old fact | **Proven.** `MACHINE_FACT_MAX_AGE_MS` is seven days, `MACHINE_FACT_DAYS` is derived from it so the sentence the card quotes cannot drift from the interval the model applies; the card names the moment the fact was taken and the check stays offered and still runs. |
| T12-37 | Restart does not repeat setup: the same machine fact read twice produces the same state and no new prompt. | `tests/test_machinefacts.py` — two reads, file bytes and mtime compared | **Proven at the file level.** Two reads are identical, no new file appears, and the file is not rewritten. |
| T12-38 | Running the same guide twice does not duplicate state, keys or files. | harness, two runs | Proves NF12-05 for the guide specifically. |

## 5. Platform behaviour, stated honestly

| Platform | What is exercised here | What is NOT RUN HERE |
|---|---|---|
| Linux (this container) | budget file location, lock takeover, atomic replace, detection paths, local-API classification through fakes | a real Zotero, a real provider, a real VS Code Extension Host |
| Windows | unit cases over a synthetic `%LOCALAPPDATA%` and synthetic install paths | the real registry, Authenticode publisher verification, a real installer, a real VS Code session |
| macOS | unit cases over a synthetic `~/Library/Application Support` | a real `.dmg`, a real notarised application |
| Remote / SSH Extension Host | the existing untrusted-and-remote-workspace gate (`NF11-06`) still refuses local access | a real remote host with a real Zotero on the remote machine |

`npm run test:host` needs `VSCODE_EXECUTABLE_PATH`, which this container does not have. It remains the named gap, exactly
as in 0.3.11, and this phase does not claim to have closed it.

`extension/test/browser.test.js` is **not** in `npm test` and was not run either: it requires the `playwright` module, which
is not installed here and is not a shipped dependency. A second route was attempted and failed, and the attempt is recorded
so the next person does not repeat it — the shipped `ui.js` panel HTML was rendered standalone through the real harness and
served on loopback, and the session's Playwright browser could not reach it: it blocks the `file://` scheme and its
loopback is a different network namespace from this shell's, so `http://127.0.0.1:<port>` was refused. **The card's real
browser rendering of the new action buttons is therefore unproven in this container.** What is proven instead is the model
level — the action list `integrationViews` sends — plus the gate that every action id the model can offer has an entry in
the card's rendering table, and `npm run check:payload`, which asserts the integration section is present in the packaged
panel HTML.

## 6. Release gates

| Gate | Condition | Result and evidence |
|---|---|---|
| RG12-A | Every Node test passes, 0 skipped, and the new files are in `package.json` `scripts.test`. | **Passed.** 451 tests, 451 pass, 0 fail, 0 cancelled, 0 skipped — [evidence/quality-v0.3.11-phase12-2026-11-09/node-test.log](../../evidence/quality-v0.3.11-phase12-2026-11-09/node-test.log). `extension/test/browser.test.js` is **not** in `npm test` and was not run: Playwright is absent from this container. |
| RG12-B | Every Python test passes, and the new module has its own test file. | **Passed.** 351 passed, 0 failed, 0 skipped — [python-test.log](../../evidence/quality-v0.3.11-phase12-2026-11-09/python-test.log). `provider_budget.py` has `tests/test_provider_budget.py` (36 cases) and `machinefacts.py` has `tests/test_machinefacts.py` (20 cases). |
| RG12-C | `npm run verify-package` reports `sourceFilesMatch: true` and passes, **including the new Python outbound gate** (DD12-11): the named members pass, a synthetic third is refused. | **Passed.** 109 members, `packageBytes 461492`, `unpackedBytes 1383104`, `sourceFilesMatch: true` — [vsix-audit.log](../../evidence/quality-v0.3.11-phase12-2026-11-09/vsix-audit.log). The reviewed set is `research.py` (two openers, `127.0.0.1` on all three Zotero constants) and `crossref_lookup.py` (one `urlopen`); the connector ping added no transport. |
| RG12-D | `npm run check:payload` passes and the new commands and panel section are present in the installed payload. | **Passed.** 38 registered commands — **unchanged**, because the guided flows are panel messages and existing commands, not new commands — [payload-check.log](../../evidence/quality-v0.3.11-phase12-2026-11-09/payload-check.log). |
| RG12-E | Two consecutive builds are byte-identical, and the unpacked size is under the reviewed ceiling **or** the ceiling was re-measured with member-by-member attribution. | **Passed, both halves.** Two builds give sha256 `0529685aaa04fc717626357f4f94d5b4ab443aa80149456b61afbeff2c8ef5df`. The build **failed** against 1 376 256 at 1 383 104, and the ceiling was re-measured to 1 441 792 with the attribution table in [evidence/…/README.md](../../evidence/quality-v0.3.11-phase12-2026-11-09/README.md) and in `scripts/verify_vsix.py:128-152`. The failure is recorded, not smoothed over. |

## 7. The nine conditions from the review, each with a verdict

The review that opened this phase named nine behaviours it wanted to be true. They are answered one by one, including the
ones this build does not satisfy.

| # | Condition | Verdict in this build |
|---|---|---|
| 1 | Zotero is installed → no redundant installation prompt | **Met and tested.** T12-22: the offer is absent from the card and the list, and the host refuses the guided panel message outright when the record says `detected`. |
| 2 | Zotero is missing → guided installation | **Met and tested.** T12-23: numbered guide, one `openExternal` to the official download page, the sentence "downloaded nothing and ran nothing", no timer anywhere in a shipped integration module. |
| 3 | A corrupted installer is blocked | **Not applicable, by decision rather than by omission.** There is no installer path to corrupt: packaged Python is forbidden every process-execution primitive (DD12-12) and verified automatic installation was rejected on the published facts (DD12-15). T12-29 is the gate that proves the absence. If a path is ever added, T12-26 … T12-28 are its criteria. |
| 4 | The local API is disabled → an actionable message | **Met and tested against fakes.** T12-19: `api-disabled`, Zotero's own setting wording quoted verbatim and asserted against the shipped guide, and the Toolkit states it will not change the setting for you. A real Zotero is still owed. |
| 5 | A key is missing → onboarding that does not block | **Met and tested.** T12-14 plus the declined-key case: "Continue without a key" records `declined`, stores nothing, authorizes nothing, and does not mark the walkthrough finished. Research without a key keeps working. |
| 6 | A 429 produces bounded retries, never an infinite loop | **Met and tested.** T12-05 … T12-09: `RETRY_MAX_ATTEMPTS = 4` **and** `RETRY_MAX_TOTAL_MS = 6 000` (two independent bounds), jitter injected, `Retry-After` honoured only when a provider sent one, and 401/403 never retried at all. |
| 7 | Concurrent agents respect one shared limit | **Met at the budget level, not at the process level.** T12-10 proves several callers sharing one budget file produce the budget's rate rather than N × it, across separate processes with a real lock. It does not prove that two real MCP server processes do this end to end. |
| 8 | A restart or a profile change rediscovered the state | **Met for both halves, against a seeded record.** A restart is proven for the machine-level budget (the window, the spacing and any carried block are read back from the file, and a stale lock is taken over) and for the installation fact (two reads identical, nothing rewritten). A profile change is proven by opening the integrations flow in a fresh profile with a seeded machine record: `installation` is pre-filled, the guided-install offer is not made, and `authorization`, `mode`, `credentials` and `onboarding` all start fresh with no key and no secret read. **What is not proven here is two real VS Code profiles of one OS user** — the reuse is tested against the record the Toolkit itself writes, not against a second editor profile. Secrets correctly do **not** cross profiles. |
| 9 | Behaviour is documented per platform | **Documented, not exercised.** §5 names what runs on Linux here and what is synthetic on Windows and macOS. No Windows host, no Authenticode check, no real `.dmg` and no real remote Extension Host was reachable. |


## 8. Open by design

- **Unattended execution of an installer is not implemented**, and the reason is a gate, not a preference (DD12-12).
- **Secrets are never shared between profiles.** INT-15 reuses installation facts only, and even those are not yet shared.
- **Zotero write access stays out of scope.**
- **No alternative metadata provider is presented as equivalent** to Semantic Scholar.
- **A real Zotero, a real key, a real Windows host and a real Extension Host remain unreachable here**, and no case above
  claims one.
