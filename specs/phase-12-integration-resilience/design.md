# Phase 12 design — integration resilience, guided installation and shared state (0.3.11, extended)

Companion to [spec.md](spec.md). Design decisions are numbered DD12-xx. Where a decision depends on an external fact,
the decision names the fact and the TBD id from [spec.md §5](spec.md) instead of inventing a value.

## DD12-11 — the Python outbound capability is now gated, not just reported

The request-path map found a real gap: `scripts/verify_vsix.py` collected `outbound_network_members` and reported them,
but never compared them to a reviewed set. JavaScript has had a named allowlist since 0.3.10 (`REVIEWED_JS_NETWORK_MEMBERS`);
Python had none. A second packaged `.py` member reaching the network would have passed the audit silently and only appeared
in the receipt text.

Measured on the packaged 0.3.11 payload, **two** members reach the network, not one:

| Member | Hosts it can reach | Bounds now named in the audit |
|---|---|---|
| `extension/worker/src/research_stack/research.py` | the three provider hosts, and loopback `localhost:23119` | `REQUEST_TIMEOUT_SECONDS = 15`, `MAX_RESPONSE_BYTES = 4 MiB`, `ZOTERO_LOCAL_API`, `_SameHostHTTPSRedirectHandler`, `_provider_request`; **2** `build_opener(` sites, **0** `urlopen(` |
| `extension/bundles/theological-research/scripts/crossref_lookup.py` | `api.crossref.org`, `api.openalex.org` | `CROSSREF_API`, `OPENALEX_API`, `TIMEOUT_SECONDS = 30`, `def fetch_json(`; **0** `build_opener(`, **1** `urlopen(` |

The audit now refuses in both directions: an outbound member that is not named, and a named member that no longer carries
its bounds or whose transport call-site count changes. Verified against the built 0.3.11 artifact: the two members pass,
and a synthetic third member is refused.

Two consequences that matter for the rest of this phase:

1. **The map's claim was narrower than the payload.** The code-level scan covered `src/research_stack/*.py` and correctly
   found one member there. The packaged payload contains a second outbound member inside a skill bundle. The gate is
   measured on shipped bytes, which is the half that matters.
2. **A downloader for INT-13B is now a visible decision, not an accident.** Adding one means naming a third member here
   with its pinned host, its size cap, its timeout and the reason it is needed. That is the honest place to make that
   decision, and it is where a reviewer will look.

## DD12-12 — the Toolkit cannot execute an installer, and that is a gate, not a preference

`PYTHON_FORBIDDEN_PRIMITIVE` (`verify_vsix.py:180-183`) forbids `subprocess`, `os.system`, `os.popen`, `os.exec*`, `pty`
and `multiprocessing` in **every** packaged `.py` member. The only reviewed process boundary in the package is
`extension/runner.js`, which exists to run the Toolkit's own worker commands. So there is no reviewed place in which the
Toolkit could launch a third-party installer.

INT-13B therefore ships as **verified staging with an operator-initiated launch**: fetch, verify, stage, name the file and
its digest in a consent step, validate the outcome by detection — and stop there. Unattended execution is not implemented,
and the reason is recorded rather than left as an omission. Guided installation (INT-13A) is unaffected: it needs no new
capability at all.

## DD12-15 — verified automatic installation is not offered, and the reason is a fact

[documentation-review.md](documentation-review.md) §C2 answers TBD-1 decisively: **Zotero publishes no checksum for its
installers.** Every candidate file (`…_x64_setup.exe.sha256`, `.dmg.sha256`, `.tar.xz.sha256`, `.asc`, `.sig`, `.sha512`,
`.md5`, `SHA256SUMS`, `checksums.txt`) returns 404 on the live release directory; the download page publishes none; the
official docs corpus contains none. The Zotero team's own stated position (forums, 8 February 2018) is that a checksum
adds little when the download is HTTPS from the publisher, and that macOS and Windows executables are signed **but Linux
does not support that**. The only officially checksummed Zotero artifacts are the `.mar` **update** archives, whose published
SHA-512 values were independently verified on 8 November 2026.

So the honest position is:

| Platform | What could be verified | Offered in this release |
|---|---|---|
| Windows | Authenticode, leaf `CN=Corporation for Digital Scholarship` (observed in the official artifact; **no official page states the publisher name**) | nothing executed; guided install |
| macOS | notarisation of the `.dmg` | nothing executed; guided install |
| Linux | **neither a checksum nor a signature exists** | guided install, and the Toolkit says why |

Combined with DD12-12 (packaged Python is forbidden any process-execution primitive by `PYTHON_FORBIDDEN_PRIMITIVE`, and the
only reviewed process boundary in the package is `extension/runner.js`, which exists to run the Toolkit's own worker
commands), INT-13B ships as **guided installation with an explanation**, not as verified staging with a consent step. A
downloader would add a third outbound Python member, a new capability gate entry, ~16 KB of payload, and a feature that
could not be tested on any platform in this container for an artifact the publisher does not checksum. Recording that as a
decision is more useful than shipping it and hoping.

`Get-AuthenticodeSignature` is quoted in the review for a reason: status `Valid` "means only that the signature is
syntactically valid. It does not imply trust in any way." A future INT-13B must check `Valid` **and** an allow-list on the
signer subject, and must treat `NotTrusted` as "this machine does not know the issuing root", not as tampering.

## DD12-16 — the anonymous rate limit is not the Toolkit's allowance

Official: unauthenticated requests are "rate-limited to 1000 requests per second **shared among all unauthenticated
users**", and unauthenticated users "share a single API key". A key gives "1 request per second **across all endpoints**".

Two consequences for wording and for the budget:

- The panel must not describe 1000 RPS as headroom the Toolkit has. It is a global pool shared with every other
  unauthenticated user, and a person making three requests can still be refused. The honest sentence is that a refusal on
  the anonymous route is not a fault in the operator's setup.
- The Toolkit's own budgets stay conservative and are labelled as the Toolkit's own, with the source named. The keyed
  budget must not exceed 1 request per second across all endpoints — the provider's allowance is not per endpoint, so a
  per-endpoint budget would multiply a limit that does not exist.

## DD12-17 — `Retry-After` is not a Semantic Scholar feature

No official Semantic Scholar page documents `Retry-After`, the OpenAPI specs contain no 429 or 403 entry at all, and none
was present on a real 429 or 403 observed on 8 November 2026. Exponential backoff is a **requirement** in the provider's own
release notes. The Toolkit therefore implements bounded backoff with jitter as the mechanism, keeps `Retry-After` parsing
because Zotero's write-authorization throttle does send one and other providers may, and never tells an operator that the
service named a wait unless the worker actually carried one.

## DD12-18 — two licences, and the Toolkit must name both

0.3.11 points its consent at the **Dataset** Licence Agreement (`api.semanticscholar.org/license/`), which restricts use to
"internal use … non-commercial, research and/or educational purposes" and requires a `utm_source=api` backlink plus the
name and logo on any public display. The **API** Licence (`semanticscholar.org/product/api/license`) is the agreement the
operator must actually tick on the key-application form, and it licenses use "solely in operation with compatible
third-party platforms and software". The S2AG datasets themselves are ODC-BY. A consent record that names one text while
the operator would have agreed to another is not a faithful record. Both URLs are offered, and the record keeps saying it
is not a grant of rights.

## DD12-19 — Zotero facts that change the probe, not the design

- `/connector/ping` is **not** gated on the local-API preference, so it separates "Zotero is running" from "the local API
  is enabled". That makes the three-state claim in INT-13A.3 evidence rather than inference.
- Zotero 10 **drops browser-looking requests without any response** unless `Zotero-Allowed-Request` is sent, and binds IPv4
  loopback only. A silent drop must be a reportable state, and the target must be `127.0.0.1`, not `localhost`.
- `Zotero-Server-ID` identifies the **database**, not the installation, and the official guidance is that clients storing
  data between runs partition it by that id. Any Zotero-derived stored data in this Toolkit must carry it.
- The local API imposes **no maximum `limit`**: omitting it returns the whole library in one response. An explicit limit is
  a safety requirement, not a performance preference.

## DD12-20 — supply-chain controls applied to dependencies, stated rather than assumed

`uv` documents an on-sync malware check against OSV advisories (`audit.malware-check = true` or `UV_MALWARE_CHECK=1`),
**preview, off by default, lockfile-scoped only**. It is recorded as an available control and is **not enabled by default**
in this release: it is preview, it is network-dependent, and a sync that fails because a advisory service is unreachable
would break setup for reasons the operator cannot see. The distinction the review insists on is kept in the record:
reproducibility (`uv.lock`), integrity (a digest), authenticity (who published it) and trustworthiness (whether it should
run) are four different questions and a lock file answers only the first.


## DD12-13 — the Zotero distinction already existed and was being thrown away

`research.py` already answers `ZOTERO_API_DISABLED` (403), `ZOTERO_NOT_READY` (503), `ZOTERO_NOT_FOUND` (404) and
`ZOTERO_NOT_AVAILABLE` (nothing listening). `integrations.py` collapsed all of them into `not-installed` because it asked
only "is there a library file?". The host vocabulary in `integrationprobe.js:15` already contains `not-running` and
`api-disabled`. INT-13A.3 is therefore a wiring change with no new capability — and the case the operator can fix in ten
seconds stops being reported as "not installed".

## DD12-14 — traps the map named, and what is done about each

| Trap | Consequence if ignored | Action |
|---|---|---|
| `recommended.py:14` hard-codes `WORKER_FILES = ("research.py", "recommended_server.py")` | an existing Basic→Recommended workspace gets a new module referenced but not copied → `ImportError` | extend the tuple and add a test that the upgrade copies every module in the import chain |
| `research.py` has no injectable clock | timing behaviour is untestable, and a scheduler test would need real sleeps | the new budget module takes `now_ms` / `sleep_ms` as parameters, house style |
| `extension/runtime.js:13` restricts worker names to `[a-z_]+\.py` | a module named `rate-limit.py` is rejected at runtime, not at build | name it `provider_budget.py` |
| `tests/test_integrations.py:184-190` caps `integrations.py` at 6 000 bytes (it is 5 998) | the classification table silently breaks a static test | the agent doing the Zotero wiring must report the size rather than raise the ceiling |
| `cli.py:126-128` catches only `(DocumentError, OSError, ValueError)` and `ResearchError` is a `RuntimeError` | a new exception path prints a traceback instead of a receipt | new exceptions are swallowed into probe outcomes where `integrations.py` already does |
| A byte ceiling with a stated headroom | the phase outgrows the reviewed ceiling mid-build and the first thing that measures it is a failing `verify-package` | measure per module, and re-measure the ceiling with attribution only if the phase genuinely cannot fit. **This trap was sprung, not avoided**: the build failed at 1 383 104 against 1 376 256 and the ceiling moved to 1 441 792 with member-by-member attribution. An early projection in this phase also claimed each new Python module counts **twice**; that is false — only `extension/worker/src/research_stack/` is packaged and `src/research_stack/` is the source it is byte-compared against. See `request-path-map.md` §6 and defect 13 in `tasks.md`. |

## DD12-01 — the request-path map (evidence)

The map is [request-path-map.md](request-path-map.md), written from a read-only audit of the tree at 0.3.11 with file:line
references. Its load-bearing findings for this design:

- One outbound member inside `src/research_stack/` (`research.py`), and — measured on the shipped bytes — a second inside a
  skill bundle. See DD12-11.
- Pacing is a **per-process, per-provider floor** (`research.py:23-30,174-185`): a `threading.Lock` plus a module dict,
  `MIN_REQUEST_INTERVAL_SECONDS = 1.0`, a free cold start, no retry, no backoff, no jitter, no token bucket. `Retry-After`
  is carried into the error and never acted on; `x-rate-limit-limit` and `x-rate-limit-interval` are captured at `:309-311`
  and discarded. Zotero has no pacing at all.
- The error taxonomy already separates 401/403 (`PROVIDER_AUTH_REQUIRED`) from 429 (`PROVIDER_RATE_LIMITED` + `retryAfter`)
  from transport failure (`PROVIDER_UNAVAILABLE`). INT-14.4 needs new *behaviour*, not new codes.
- The cache key already exists: `_query_hash(provider, query)` (`research.py:188-189`), already embedded in every field's
  provenance and in the top-level `queryHash`.
- Concurrent callers in a real session: one credential-carrying MCP server per window (`extension.js:812`), plus one probe
  CLI per window (`extension.js:245-247`), plus hand-written `.mcp.json` duplicates, plus a hand-run CLI — each pacing
  itself. This is the measured basis for INT-15.5.
- The only cross-process lock in the repository is JS and covers setup only (`runtime.js:246-256`, `preflight.js:52-95`).
  There is no `fcntl`, `msvcrt.locking` or `O_EXCL` lock anywhere in `src/research_stack/`.


## DD12-02 — three classes of state, three locations

| Class | Lives in | Written by | Read by | May contain |
|---|---|---|---|---|
| **Machine-level discovery** | one JSON file under the OS user's per-user application-data location, path derived per platform (Windows `%LOCALAPPDATA%`, macOS `~/Library/Application Support`, Linux `$XDG_DATA_HOME` or `~/.local/share`), directory `research-stack-toolkit/` | the Python worker, after a detection or a probe | any profile of the same OS user, and the extension host through the worker | provider id, whether the application was found, a *classification* of what was found, the platform, the time of detection, a non-sensitive diagnostic code |
| **Profile state** | `context.globalState` key `researchToolkit.integrations` (unchanged from 0.3.11) | the extension host | that profile only | the four dimensions, consent with reference and time, chosen access mode, last check, cooldown budget |
| **Secrets** | `context.secrets`, key `researchStack.integration/<provider>/apiKey` (unchanged) | the extension host | that profile only | the key, and nothing else |

Rules that a test enforces:

- A secret, a key fragment, a token-shaped string, a workspace path and an absolute path to a user file never enter the
  machine-level file. The file is size-capped; a write that would exceed the cap is refused, not truncated.
- The machine-level file is written with a temp file plus an atomic replace, never in place.
- A profile that reads a machine-level fact may set `installation` from it. It may **not** set `authorization`,
  `credentials.configured`, `mode` or `license` from it. Those are profile facts and start from `not-required` /
  `awaiting-consent` / `not-started` in a fresh profile.
- A machine-level fact is *evidence about a moment*, so it carries its detection time and is treated as stale after a
  stated interval; a stale fact pre-fills the panel but does not suppress the check.

Why not a shared credential store: sharing a key across profiles would move a secret out of the encrypted store into a
plain file, which is exactly the leak path INT-07 closes. Reuse of *installation facts* gets most of the convenience with
none of that exposure.

## DD12-03 — one shared request budget, held in a file

The provider limits the caller, not the process, so the budget must outlive a process. Design:

- One budget file per provider per OS user, next to the machine-level discovery record.
- Contents: the window start, the number of permits issued in the window, the earliest next-allowed instant, and an
  optional `blockedUntil` instant written from a provider `Retry-After`.
- **Locking is portable**: an `O_CREAT | O_EXCL` lock file whose name carries a creation time. A lock older than a
  stated stale timeout may be removed by the process that finds it, so a crashed process cannot freeze the budget
  forever. `fcntl.flock` is not used because the target platforms include Windows.
- A caller: take the lock, read the budget, decide (allow / wait / refuse), update the budget, atomic replace, release.
  The wait is bounded by DD12-05; a caller never waits on a lock indefinitely.
- Budget numbers come from TBD-2 (the provider's own documented limits) and are stated as constants with a comment
  naming the source URL and the date read. An anonymous budget and a keyed budget are different constants, because the
  documented limits are different.

## DD12-04 — deduplication and a bounded response cache

- A request key is the normalized provider request (endpoint, sorted parameters, access mode) hashed. It is not the raw
  query text, so a query string does not accumulate in a file.
- Before a provider call, a bounded cache is consulted. Cache entries carry the retrieval time and a TTL; entries older
  than the TTL are not served. The cache holds provider *metadata*, never a key, and is size-capped with the oldest
  entries dropped first.
- A claim marker records that a request key is in flight. A second caller with the same key does not spend a second
  permit: it waits a bounded time for the first result, and if the first caller does not finish, it proceeds rather than
  deadlocking.
- The cache is a performance and rate control, not a source of truth: a cache hit is labelled as such in the result so a
  reader knows whether the provider was actually asked.

## DD12-05 — bounded retries, and the difference between 401/403 and 429

| Provider answer | Meaning the Toolkit states | Retries | Result shape |
|---|---|---|---|
| 429 | the provider is rate-limiting this caller; the Toolkit is not broken | honour `Retry-After` when present; otherwise exponential backoff with jitter; at most N attempts and at most T total wait, both stated constants | a **degraded** result with the wait already computed and the next allowed instant |
| 401 / 403 | the key is missing, invalid, or not accepted for this use | **none** — retrying cannot fix a credential | an actionable result pointing at the onboarding flow, with the key never echoed |
| 404 | the record was not found | none | a normal "not found" answer |
| timeout / connection failure | the provider did not answer | the same bounded schedule as 429 | a degraded result naming the timeout |
| malformed body | the provider answered with something unexpected | none | a refusal that quotes the shape, not the content |

Backoff: base interval, factor 2, jitter drawn per attempt, capped per attempt and capped in total. Jitter is required
because several Toolkit processes share one budget and would otherwise wake in step and hit the provider together.

**No attempt loop may outlive the caller's patience.** The MCP-facing budget is the smaller of the retry schedule and a
stated per-call ceiling; when the schedule would exceed it, the Toolkit returns degraded rather than blocking the agent.

## DD12-06 — degraded mode is a first-class answer

A provider failure returns a structured degraded answer, not an exception, so that a search tool can say "Semantic
Scholar is rate-limiting; here is what the Toolkit already has locally, and here is when it will ask again" while every
other tool keeps working. Degraded is a *readiness* value in the state model (already present in 0.3.11), so the panel,
the tool answer and the stored record all use the same word for the same condition.

## DD12-07 — Zotero: guided installation is the default, automatic is conditional

Guided path (INT-13A), no new capability:

1. Detect: platform, then the platform's documented install and data locations (TBD-6), then whether the local API
   answers.
2. If found → no installation prompt. Show what was found and run the connection test.
3. If not found → offer the official download page (TBD-6) and the platform's documented install shape, and say plainly
   that the Toolkit did not download or run anything.
4. If found but the local API refuses → name the exact Zotero setting (TBD-4) and re-test on request.
5. After the operator says installation is finished → re-detect and test, without being asked.

Automatic path (INT-13B), gated on facts:

- Offered **only** when the artifact can be verified: a pinned expected digest from an official source (TBD-1), or a
  platform signature check against an expected publisher identity. If neither is available, the Toolkit says so and
  offers the guided path. This is not a fallback to hide behind; it is the requirement.
- Fetch: one pinned official host, HTTPS only, a size cap, a stated timeout, and a redirect policy that refuses to leave
  the pinned host. The fetched bytes go to a staging location, never to a workspace.
- Verify before anything is run: digest first; on Windows, a publisher identity check against the expected name, not
  merely "a valid signature".
- Consent: a modal that names the file, the origin, the digest and what running it would do. Declining leaves the staged
  file in place for inspection or deletes it, and the guided path is offered.
- Validate the outcome by detection (INT-13B.5). An installer's exit code is not evidence that the application exists.

## DD12-08 — where the new capability lives, and what the audit must say

No packaged JavaScript gains a transport (NF12-01). The fetch, the verification and the detection all live in the Python
worker, which already owns outbound HTTP and the loopback Zotero client. A new outbound member is added to the audit's
reviewed list **with its host, cap and timeout named in the audit itself**, the way 0.3.10 named `updates.js` rather
than letting a transport appear unreviewed. The capability audit is a byte scan, so the new module's comments are part of
the reviewed text and are written to be accurate.

## DD12-09 — byte budget

Headroom at the start of this phase: **32 607 bytes** under the reviewed 1 376 256 ceiling. Every new Python module
counts twice (source tree and packaged worker copy). Plan: keep the new Python modules small and single-purpose, keep the
JS additions in the existing integration modules rather than new files where the content fits, and measure the growth
member by member. If the phase cannot fit, the ceiling is re-measured with the same attribution discipline as DD11-10 and
the reason is written down — not raised silently.

## DD12-10 — what stays unchanged from 0.3.11

The four-dimension state model, the probe as a worker verb, the consent reference `s2-api-license-2026-11`, SecretStorage
as the only key location, the cooldown budget, "off is not deleted", migration that reads and never deletes, and the rule
that nothing probes at activation. This phase adds facts and a scheduler around that model; it does not replace it.
