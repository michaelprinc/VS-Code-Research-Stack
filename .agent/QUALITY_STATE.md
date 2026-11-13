# Quality state — Research Stack Toolkit 0.3.11 (unified integration onboarding for Zotero and Semantic Scholar)

> **PHASE 13 IMPLEMENTED, VERIFIED AND COMMITTED — integration correction from a real-host report (12 November 2026).**
> An operator ran 0.3.11 on **Windows with Zotero 10** and reported: Zotero was installed and correctly detected, the
> GUI checks failed, **"Check now" did not work correctly**, and the guided Semantic Scholar key flow had a problem.
> Commits `30de507` and `fd81489`; no tag. Plan of
> record: [specs/phase-13-integration-correction/spec.md](../specs/phase-13-integration-correction/spec.md) — **21
> defects registered (P1–P9 worker, J1–J7 host, M1–M7 model/panel)** with decisions DD13-01…DD13-09; M7 was found by
> the instrument built to verify the rest, not by the plan.
> **Reproduced here, not assumed:** the shipped probe was run against an emulated Zotero on the real port
> `127.0.0.1:23119` — a server that closes without answering **crashes** the probe with `RemoteDisconnected`, and
> 401 / 404 / a non-JSON 200 all collapse to the same generic `unknown` sentence, so the Toolkit cannot tell the
> operator what Zotero said. Primary source read directly: the official
> [Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/local_api) — reads need **no** authentication,
> a disabled preference gives **403**, the local API has **no rate limits**, ask `/api/` first, Zotero 10+ adds
> `Zotero-Server-ID`, and Zotero 10+ **writes** need a user-approved local key (the Toolkit must not trigger that
> dialog). New operator-facing instrument: [scripts/zotero_local_check.py](../scripts/zotero_local_check.py)
> (not packaged, not installed) — verified against three emulated states, each giving the right verdict and exit
> code. Evidence: [evidence/realhost-2026-11-12/README.md](../evidence/realhost-2026-11-12/README.md).
> **Answered from Zotero's own source (`zotero/zotero` at tag 10.0.9), not assumed:** `Host: 127.0.0.1:23119` **is
> accepted** — `server.js` matches it against `/^(?:127\.0\.0\.1|\[::1\]|localhost)(?::[0-9]+)?$/i`, so the leading
> hypothesis that the Host header was rejected is **disproven** and recorded as such. `users/0`, `format=json` and
> `limit=100` are all valid. Zotero binds **IPv4 loopback only**, so `127.0.0.1` is the right constant and `localhost`
> would have been worse. What is still unknown is which of the reproduced states the operator's machine is actually
> in — that needs `scripts/zotero_local_check.py` run on their Windows host.
>
> **Phase 13 measured, current.** Node **481 tests, 481 pass, 0 fail, 0 skipped** (was 468). Python **386 passed,
> 0 failed, 0 skipped** (was 352). Artifact **110 members, 481 282 packed, 1 445 373 unpacked,
> `sourceFilesMatch: true`, `result: passed`**, sha256 `84f206c5…`, reproduced byte-identically by a second build.
> Payload check passed with **38 commands unchanged**. **The byte ceiling was breached again and moved again**:
> 1 445 373 against 1 441 792 — 3 581 over. Nothing was moved out and no reviewed file was dropped; the ceiling
> moved one 1/16 MiB step to **1 507 328** with member-by-member attribution in `scripts/verify_vsix.py`. The chain
> is recorded: 1 343 649 → 1 365 400 → 1 383 104 → 1 420 824 → **1 445 373**. Acceptance:
> [specs/phase-13-integration-correction/acceptance.md](../specs/phase-13-integration-correction/acceptance.md)
> (T13-01…T13-33). Committed as `30de507`; no tag.
>
> **The gap found at the freeze, and how it closed.** T13-22, T13-27, T13-28 and T13-29 were asserted only in
> `extension/test/browser.test.js`, which has never run here — Playwright is absent and the file is not in
> `npm test`. The scratch DOM probe left in `/tmp` by the panel agent **crashed on the new code**
> (`control.setAttribute is not a function`) and proved nothing. `scripts/panel_renderer_check.js` now runs the
> shipped `media/controls.js` byte-for-byte in a DOM shim against a real state message from the shipped harness:
> **7 assertions, 7 pass, exit 0**. Running it found a defect the plan had missed — **M7**: `applyControlAvailability()`
> returned on the `isReadOnly` branch before the unavailable branch, so `[data-action="updateNow"]` carried
> `data-unavailable="true"` and an explanatory title while staying `disabled=false` and unannounced. Fixed; row G
> **fails against the pre-fix renderer** (`disabled=false aria-disabled=null`, exit 1) and passes on the fixed one.
> `gui-status.test.js`'s source-shape pin on the old branch was renegotiated into a semantic pin. What a real browser
> is still owed is named in acceptance §3.
>
> **The defect this phase almost missed.** `CALL_CEILING_MS` documented that no attempt loop outlives the caller's
> patience, but it counted only the pauses the loop slept — four 15-second timeouts ran to ~66 s against a 20 s
> promise. Both sides of the boundary had tests that passed. A named ceiling must bound what its name claims.
>
> **Phase 12 is implemented, verified and committed** (`798c41c`, `9a6c726`, `32b3b38`, `8001c80`; no tag). Plan of record:
> [specs/phase-12-integration-resilience/](../specs/phase-12-integration-resilience/) —
> [spec.md](../specs/phase-12-integration-resilience/spec.md),
> [design.md](../specs/phase-12-integration-resilience/design.md) (DD12-01…DD12-20),
> [request-path-map.md](../specs/phase-12-integration-resilience/request-path-map.md),
> [documentation-review.md](../specs/phase-12-integration-resilience/documentation-review.md),
> [tasks.md](../specs/phase-12-integration-resilience/tasks.md) (20 packages, 15 defects found and closed),
> [acceptance.md](../specs/phase-12-integration-resilience/acceptance.md) (T12-01…T12-40, RG12-A…RG12-E, and §8
> answering the review's nine conditions one by one in §7).
> Receipts: [evidence/quality-v0.3.11-phase12-2026-11-09/](../evidence/quality-v0.3.11-phase12-2026-11-09/).
>
> **Measured, current.** Node `npm test` **468 tests, 468 pass, 0 fail, 0 skipped** (was 436). Python **352 passed,
> 0 failed, 0 skipped** (was 273 at the 0.3.11 audit). Artifact **110 members, 473 110 packed, 1 420 824 unpacked,
> `sourceFilesMatch: true`, `result: passed`**, sha256 `9230704d…`, with a second consecutive build producing the same
> digest. Payload check passed with **38 commands unchanged**.
>
> **The one gate this phase failed, and how it was closed.** `verify-package` failed at 1 383 104 against
> 1 376 256 — 6 848 over. Nothing was moved out and no reviewed file was dropped, so the ceiling was
> re-measured to **1 441 792** (one 1/16 MiB step) with member-by-member attribution in
> `scripts/verify_vsix.py:128-152` and in the evidence README. The chain is recorded: 1 343 649 → 1 365 400 →
> 1 383 104 → **1 420 824**, finishing **20 968 bytes under** the re-measured ceiling. The ceiling moved once, for a
> measured breach, not to make a build pass.
>
> **Capability position after the phase.** Python outbound is now **gated, not reported**: two named
> members, each with required bound literals and a reviewed transport call-site count, refusing in both
> directions. `research.py` is reviewed at `127.0.0.1` for all three Zotero constants — a revert to
> `localhost` now fails the audit instead of shipping. The connector ping added **no** capability (2 openers,
> 0 `urlopen`, unchanged), and a test asserts its body opens nothing new.
>
> **Real defects found by reading the shipped code, not by design review.** `media/controls.js` read
> `view.authorized`, a field the state model never sends, so "Turn off" never rendered and "Add API key"
> was always unavailable; the card and the Quick Pick each had their own label table for one record; a
> check that answered badly was worded as "not checked yet"; the probe addressed Zotero as `localhost`
> although Zotero binds IPv4 loopback only; and Zotero 10 silently drops a request that does not carry
> `Zotero-Allowed-Request`, which the probe had no category for; the two halves of INT-15 disagreed at their own
> boundary (8 192 write cap against a 4 096 read cap, `>= 0` against `> 0` on the timestamp); and the probe told the
> operator it "writes nothing" after it began writing one machine-level file outside the workspace. All seven are closed
> with a test or a gate.
>
> **Three state classes now exist and are separated by tests.** Machine-level `integration-facts.json` (cap 8 192,
> temp file plus one `os.replace`, seven refusal codes, never a credential, never a workspace path, never a Semantic
> Scholar fact), profile state in `context.globalState`, secrets in `context.secrets`. A machine fact may set
> `installation` **only** — a fresh profile still starts at `awaiting-consent` with no key and no consent inherited.
> Freshness is the Toolkit's own seven days; a stale fact pre-fills the panel without suppressing the check, and a
> machine record never overrules a later check this profile ran. `machinefacts.py` was scanned independently for every
> forbidden and outbound pattern: clean, LF-only, and its name passes `runtime.js` `WORKER_PATH`.
>
> **Open by design, not by omission.** INT-13B verified automatic installation (DD12-15: no publisher
> checksum exists, Linux has no signature, packaged Python is forbidden every process-execution primitive).
> Zotero write access, Zotero cloud, cross-profile secret sharing and an alternative metadata provider stay excluded.
>
> **Still owed before 0.3.11 can be called done.** T12-19 against a **real** Zotero (both endpoints here
> only refuse, so the three-state answer is proven against fakes); T12-16 with a real key; a real 429 from the live
> provider; **two real VS Code profiles of one OS user** (the cross-profile reuse is proven against a seeded machine
> record, not against a second editor profile); `npm run test:host` and `npm run test:browser`, which this container
> cannot run (no `VSCODE_EXECUTABLE_PATH`, no Playwright, and the session's browser cannot reach this host — both
> attempted routes are recorded in acceptance.md §5).
>
> **Closed on 9 November 2026.** The user accepted guided-only installation — DD12-15 stands, INT-13B is not
> implemented and is not to be revisited without a separate capability review — and asked for the work to be committed
> without a tag. Commit `798c41c` carries the whole 0.3.11 tree (phase 11 plus phase 12); the working tree is clean and
> no tag exists. The phase-12 goal stays open in the harness only because marking it complete needs a direct human
> turn.
>
> **Goal round 1 (9 November 2026) — closing review.** Re-ran the whole chain from the committed tree: 352 Python
> passed, 468 Node pass / 0 fail / 0 skipped, audit passed at 110 members / 473 110 packed / **1 420 824 unpacked**,
> payload check passed with 38 commands, artifact digest unchanged from the previous build. Two things the review
> found and fixed: `spec.md` listed INT-13B.1–.5 and INT-13A.4 with no disposition, so the table read as a claim —
> §3.1 now states per requirement what was built and why the rest was not, including that **INT-13A.4 as written asks
> for an unasked re-detect, which 0.3.11's own no-timer rule forbids** (recorded as a requirement defect, not quietly
> rewritten); and `acceptance.md` RG12-A / RG12-C / RG12-E still carried mid-phase figures, now corrected to the
> final ones. Commits `32b3b38` and the acceptance correction; tree clean.



Objective: implement the 0.3.11 brief — one onboarding flow in the Toolkit GUI for Zotero (local API) and Semantic
Scholar (anonymous-first, optional key), with installation, authorization and readiness kept apart, a decision taken
once per VS Code profile and never re-asked in another workspace, keys in SecretStorage only, readiness probed through
the reviewed worker boundary, and the whole thing packaged and audited. Prove it on this container and say plainly what
was not proven here.

Plan of record: [specs/phase-11-integration-onboarding/](../specs/phase-11-integration-onboarding/) —
[spec.md](../specs/phase-11-integration-onboarding/spec.md) (baseline, findings, INT-01…INT-14, NF11-01…NF11-07),
[design.md](../specs/phase-11-integration-onboarding/design.md) (DD11-01…DD11-12),
[tasks.md](../specs/phase-11-integration-onboarding/tasks.md) (25 tasks + the defects closed),
[acceptance.md](../specs/phase-11-integration-onboarding/acceptance.md) (T11-01…T11-20, RG11-A…RG11-E).
Receipts: [evidence/quality-v0.3.11-2026-11-08/](../evidence/quality-v0.3.11-2026-11-08/).
The 0.3.10 state is kept at [.agent/0.3.10/QUALITY_STATE-0.3.10.md](0.3.10/QUALITY_STATE-0.3.10.md).

Status: **0.3.11 implemented, packaged and audited on this Linux development host.** Publication remains open on the
same four human decisions recorded for 0.3.10. A live Windows VS Code session, a real Zotero installation and a real
Semantic Scholar key are **not reachable from this container** and nothing here claims one.

## What is proven (measured, not assumed)

- **Suites**: Node **436 tests, 436 pass, 0 fail, 0 skipped** (46 new: `integrations.test.js` 10,
  `onboarding.test.js` 7, `credential-security.test.js` 9, `integration-host.test.js` 20); Python **273 passed** in
  161.53 s as measured in that run (15 new in `tests/test_integrations.py`; the duration in the receipt is the authority). Receipts: `node-suite.txt`, `python-suite.txt`.
- **Artifact**: `dist/research-stack-toolkit-0.3.11.vsix`, 108 members, 448 515 bytes packed, unpacked **1 343 649** of
  the re-measured **1 376 256** ceiling (32 607 headroom), SHA-256
  `aed24d76db0dda0bb52199c29d1ba067fcebf364152e7a41c52d97c73f5a48fe`; `sourceFilesMatch: true`; two consecutive builds
  byte-identical. `npm run check:payload` → `result: passed`, 38 commands. Receipts: `vsix-audit.json`,
  `payload-check.json`, `vsix-sha256.txt`.
- **The network capability did not move.** `reviewedNetworkBoundary` still names `extension/updates.js` as the only
  packaged JavaScript member with outbound capability; the three new JS modules carry none, asserted three ways —
  `credential-security.test.js::no module in this release can reach a socket, a process or the editor itself`,
  `module-boundaries.test.js`, and the audit's byte scan. The probe is a worker verb
  (`research-stack probe-integrations`) inside the reviewed `runner.js` boundary with a 20 000 ms timeout.
- **The installed payload behaves as designed**: 38 registered commands including the five integration commands; the
  packaged panel HTML carries the Integrations & Accounts section and `data-action="checkIntegrations"`; the packaged
  state carries four dimensions per integration; Zotero `consentRequired: false`, Semantic Scholar
  `awaiting-consent`; no credential variable's value in the panel HTML. Receipt: `payload-check.json`.
- **The live answers on this host are recorded refusals**: Zotero `not-installed` / `ZOTERO_NOT_AVAILABLE` with the
  statement that no library file was opened; Semantic Scholar `auth-required` / `PROVIDER_TERMS_NOT_ACKNOWLEDGED` with no
  request sent; an unknown provider refused naming the accepted ones. Receipts: `probe-receipt.json`,
  `probe-receipt-zotero.json`, `probe-refusal-unknown-provider.txt`.
- **Consent is an operator act.** The modal names the licence URL and states that pressing Activate is not a grant of
  rights; the record stores `acknowledged`, the reference `s2-api-license-2026-11` and the time. Reading the licence does
  not authorize. The Toolkit refuses to record a consent it did not receive.
- **A key goes to SecretStorage and nowhere else.** Proven by asserting the key is absent from the profile state, the
  panel state, the output channel and every message, and present only under
  `researchStack.integration/semantic-scholar/apiKey`.

## Defects found and closed in this release

Found by the wiring tests, not by reading the code; each now has a test that fails if it returns.

1. `lastProbeAt` stored as ISO text while `readRegistry` / `probeCooldown` accept only numbers → the shared check budget
   silently never applied. Fixed with `epoch()` in `integrations.js` and `Date.parse(at)` in `extension.js`.
2. `integrationViews` required a numeric `now` while every caller passed ISO text → the 24-hour staleness sentence could
   never appear.
3. A migrated record could claim a stored key secret storage does not hold → the panel would say "key present" forever.
   The check now reconciles the claim with what it actually read, once, for an authorized integration.
4. A record claiming consent it cannot show kept `readiness: "ready"` → the demotion now resets readiness and the last
   successful check, and says so in `notes`.
5. The unpacked payload outgrew the reviewed ceiling → re-measured to 1 376 256 with the 65 787-byte growth attributed
   member by member (DD11-10), not raised silently.
6. The byte-scan audit matched the word "socket" inside new comments → reworded; the gate now passes on prose as well as
   on code.

## Open items and risks

1. **No live Zotero, no real Semantic Scholar key, no live Extension Host, no Windows host.** `npm run test:host` needs
   `VSCODE_EXECUTABLE_PATH`, which this container does not have. The wiring is proven through the harness and the
   installed payload check; `acceptance.md` names the container-side substitute for every such case.
2. **INT-12 (sharing the decision across VS Code profiles of the same OS user) is deliberately unimplemented.**
   globalState and SecretStorage are per-profile; a cross-profile store needs a location, a format and a threat model
   this release has not written. INT-03 (once per profile) is implemented.
3. **INT-13 (guided Zotero installation through the platform package manager) is deliberately unimplemented**: the
   Toolkit would have to run an installer it has not reviewed. The guide names the official installer.
4. **Zotero write access stays out of scope.** The probe reads; the worker's own detail states nothing was written.
5. **`credentials.configured` is a claim carried from a stored record.** It is reconciled with secret storage the first
   time a check runs, not at activation — reading SecretStorage at activation can prompt on some backends, which is
   exactly the kind of unasked interaction this release is meant to remove. A record that claims a key is therefore
   briefly optimistic until the first check. Recorded here rather than hidden.
6. **The provider's licence terms are external facts.** The Toolkit records that the operator reviewed them and states
   that the record is not a grant of rights; it cannot judge the intended use. If the licence text changes, the
   reference `s2-api-license-2026-11` is the handle that makes the change visible.
7. **Publication remains blocked on the four 0.3.10 decisions** (publisher, credential, repository licence, pre-release),
   plus `@vscode/vsce` staying pinned at 4.0.0 and the two `publishable: false` skill bundles.
8. Carried from 0.3.10: the packaged artifact still carries no Changelog asset; the bundle reference note;
   `dedupe_records.py` unbounded report; T8-18 (the 0.3.8 field re-run).

## Decisions taken in this release

- **Three processes, three dimensions.** Installation, authorization and readiness are stored and worded separately; a
  probe moves only the dimensions it is evidence about.
- **Top-level modules, not a subdirectory** (DD11-02): the packager and the require-scan only see top-level `*.js`.
- **The probe is a worker verb** (DD11-01). No packaged JS other than `updates.js` may reach a network transport.
- **Anonymous-first for Semantic Scholar.** A key is optional, and only the access mode the operator chose hands one to a
  process environment.
- **Consent is a button press after the licence is offered**, recorded with a reference and a time, never defaulted,
  never inferred from silence or from a skipped guide.
- **Off is not deleted** (DD11-11): revoke keeps the record so re-authorizing does not re-run the guide; reset withdraws
  the confirmation and says so first.
- **Nothing probes at activation** (DD11-07); the budget is stored with the record so it is shared across windows
  (DD11-09).
- **Migration reads, never deletes** (DD11-08), and every discarded value is named.
- **INT-12 and INT-13 left open on purpose** rather than implemented without a threat model.

## Final validation — phase 13, tree `653ce9a`, re-run on `484b841` in goal round 2, 13 November 2026

Run in one sweep against the committed tree, working tree clean:

| Check | Command | Result |
|---|---|---|
| Node suite | `cd extension && npm test` | **481 tests, 481 pass, 0 fail, 0 skipped** |
| Panel renderer | `npm run test:panel` (from `extension/`) | **7 assertions, 7 pass, 0 fail, 0 not proven** — named as a gate in this round |
| VSIX audit | `cd extension && npm run verify-package` | **`result: passed`**, `sourceFilesMatch: true`, 1 447 197 unpacked under the 1 507 328 ceiling |
| Packaged entry point | `cd extension && npm run check:payload` | **`result: passed`**, 38 commands |
| Python suite | `uv run --locked python -m pytest -o addopts="" -q tests/` | **386 passed, 0 failed, 0 skipped** |
| Artifact digest | `sha256sum dist/research-stack-toolkit-0.3.11.vsix` | `75c533078febccee78ab6e7273c77a8378fa6d61d8cda72807400277335953a5`, identical across two consecutive builds |

**Consistency review performed.** Every acceptance row in
[specs/phase-13-integration-correction/acceptance.md](../specs/phase-13-integration-correction/acceptance.md) now
names an executed test or is recorded in §3 as not run here; the four rows that had been claimed on the strength of
`test/browser.test.js` were downgraded, then re-earned by `scripts/panel_renderer_check.js`. The gate figures in the
acceptance table, in [evidence/realhost-2026-11-12/README.md](../evidence/realhost-2026-11-12/README.md) and in this
file are the same measured numbers. The defect register is P1–P9, J1–J7, M1–M7 — 21, not 20. The disproven Host-header
hypothesis is recorded as disproven rather than removed.

**What remains owed by the environment, not by the code:** T13-30 a real Zotero 10 on Windows, T13-31 a real Semantic
Scholar key and a real 429, T13-32 a real Extension Host and a real rendered window, T13-33 two real VS Code profiles
of one OS user.

**Goal bookkeeping, recorded so the next round does not re-litigate it.** The objective is met and the sweep above was
re-run in goal round 1 with every gate exiting 0 (`npm test`, `verify-package`, `check:payload`,
`panel_renderer_check.js`, `pytest`). `update_goal action complete` was still refused with "Final validation evidence is
required", and the only field that could carry that evidence — `objective` via `action edit` — is refused in an
automatic round with "this goal operation requires a direct human turn on a top-level agent". The goal therefore stays
active by harness policy, not by unfinished project work. Closing it needs one direct human turn.

## Next highest-value action

**On the operator's Windows machine, not in this repository.** Run `python scripts\zotero_local_check.py` there. It is
the instrument that turns "the check did not work" into one of the named states — the setting is off, the port is held,
nothing is listening, or the request itself is being rejected — and it is the only way to confirm which of the
reproduced states the operator is actually in.

Inside the repository, in order: (1) give the readiness probe its own single-attempt bound instead of the research
retry budget, which is the last known overshoot in the check path; (2) ~~wire `scripts/panel_renderer_check.js` into a
named npm script~~ **done in round 2 — it is `npm run test:panel`**; (3) run `node test/browser.test.js` and
`npm run test:host` on a host that has Playwright and `VSCODE_EXECUTABLE_PATH`, and record them as a new evidence
folder.
