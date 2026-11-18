# P4 — `researchStack.integrationTimeoutMs` and `researchStack.integrationCooldownSeconds` as real settings (HR-30, finding R15-04)

Package P4 of [tasks.md](tasks.md), against requirement **HR-30** in [spec.md](spec.md) and case
**T15-18** in [acceptance.md](acceptance.md). Baseline `6719415` (0.3.13).

## 1. What landed

| File | Change |
| --- | --- |
| `extension/package.json` | two settings added to `contributes.configuration` only (version and the preset enum untouched) |
| `extension/vsix-manifest.json` | the same two properties mirrored — see §7, this is not optional |
| `extension/integrationprobe.js` | `probeBounds()` plus the four range constants; `PROBE_COOLDOWN_MS` / `PROBE_TIMEOUT_MS` still exported as the published defaults |
| `extension/integrations.js` | `integrationViews(..., { cooldownMs })` passes the window to `probeCooldown`; the module's own default is a named `PROBE_COOLDOWN_MS`, exported |
| `extension/extension.js` | **integration region only** (hunks at lines 226–371): `integrationBounds()` plus its four consumers |
| `extension/test/credential-security.test.js`, `extension/test/integrations.test.js`, `extension/test/integration-host.test.js` | pins renegotiated, drift coverage added (§5) |

## 2. The two settings

| id | type | default | minimum | maximum | scope |
| --- | --- | --- | --- | --- | --- |
| `researchStack.integrationTimeoutMs` | number | 80000 | 40000 | 300000 | application |
| `researchStack.integrationCooldownSeconds` | number | 10 | 5 | 300 | application |

### Why 40000 / 80000 / 300000 ms

Every number is arithmetic on the worker's own constants, read in this tree — none of it invented at the
host boundary:

| Part of the check | Where it is bounded | Worst case |
| --- | --- | --- |
| Zotero root | `src/research_stack/research.py:44` `ZOTERO_ROOT_TIMEOUT_SECONDS = 5` | 5 s |
| Zotero path check (HEAD) | same constant | 5 s |
| Zotero listing **and its one retry** | `research.py:45` `ZOTERO_LISTING_TIMEOUT_SECONDS = 12`, retried once in `integrations.py:175-185` `probe_zotero` | 12 + 12 s |
| Zotero connector ping | `research.py:46` `ZOTERO_PING_TIMEOUT_SECONDS = 3`, reached only on the short path where the root itself got no answer (5 + 3) | 3 s |
| Semantic Scholar side | `provider_budget.py:35` `CALL_CEILING_MS = 20_000` wall clock, plus the one request already in flight when that ceiling is reached, `research.py:33` `REQUEST_TIMEOUT_SECONDS = 15` | 35 s |

- **Zotero-only worst case 34 s** — the same figure `integrations.py:161-165` states in its own docstring.
- **Both services 34 + 35 = 69 s.**
- **Default 80 000 ms** is above 69 s with room for interpreter start-up and the receipt write. It was
  already 80 s in 0.3.13; the number did not move, what moved is that it is now published as a setting
  with a stated range.
- **Floor 40 000 ms** is the smallest bound that still lets a **Zotero-only** check spend its full 34 s,
  so the *second* listing request — the one that exists precisely because "Zotero's local API waits for
  the library to finish loading before it answers" (`integrations.py:154-157`) — is never cut off, with
  about 6 s for start-up and the receipt. Honouring 5 s or 1 s would kill exactly the case the bound is
  about, which is why the clamp refuses it instead of obeying it.
- **Ceiling 300 000 ms**: the bound is a *kill* bound. Past five minutes the check is one whose services
  are not answering, and the Toolkit's job is to say so, not to hold the window open longer. A provider's
  `Retry-After` does not extend it either — `provider_budget.py:36` `RETRY_AFTER_MAX_MS = 60_000` is
  "a longer block is reported, never waited out".
- The bound covers **the whole worker call**, not one request. It cannot raise the worker's own per-request
  limits (5 s, 12 s, 15 s), and it does not apply to component setup (`researchStack.setupTimeoutSeconds`)
  or to the machine-record read (`MACHINE_FACT_READ_TIMEOUT_MS = 5_000`, `extension.js:50`) — a test pins
  that the operator's bound does not leak into that call.

### Why 5 / 10 / 300 seconds

`lastProbeAt` is written **after** the worker answers (`extension.js:309`), so the window is measured from
the end of a finished check: it guards presses, not request pacing. The worker's own pacing floor is a
separate guard (`research.py:50` `MIN_REQUEST_INTERVAL_SECONDS = 1.0`, mirrored by
`provider_budget.py:32` `MIN_SPACING_MS = 1_000`).

- **Default 10 s** is the 0.3.11 J7 decision, unchanged: long enough that a double press or a second
  window cannot re-ask two services, short enough that the deliberate "I have installed Zotero — check it
  now" is not refused because an automatic check spent the window.
- **Floor 5 s** is the shortest window that still tells a double press, or a press in another window of the
  same profile, apart from a deliberate re-check. Below it the window stops meaning anything while every
  failing check still takes tens of seconds.
- **Ceiling 300 s** is the longest countdown the card will name (`media/controls.js:481` puts the remaining
  wait in the button's tooltip); above it the card reads as broken to the person looking at it.
- Fractional seconds are used as whole seconds (`Math.round`), which is the unit every countdown and
  refusal is stated in — stated in the setting description, not hidden in the clamp.

## 3. The clamp

`integrationprobe.js` — pure, no editor object, no clock, no setting read:

```js
probeBounds({ integrationTimeoutMs, integrationCooldownSeconds })
// → { timeoutMs, cooldownSeconds, cooldownMs, timeoutClamped, cooldownClamped, clamped }
```

- `undefined` means *the operator set nothing*: the published default is used and **nothing is reported as
  clamped** — a default nobody chose is not a correction.
- A finite number in range is used as given (rounded to a whole unit), `clamped` stays empty.
- A finite number outside the range is replaced by the range bound, and `clamped` carries one sentence
  naming the setting, what was set and what ran, e.g.
  `researchStack.integrationTimeoutMs is 1000 ms, below the 40000 ms the Toolkit will run a check at, so 40000 ms was used.`
- Anything that is **not a finite number** (`NaN`, `±Infinity`, `"80000"`, `"fast"`, `null`, `true`, `{}`,
  `[]`, a bigint) falls back to the published bound and says so — never to 0, which would be the worst
  possible reading of a broken setting.
- `cooldownMs` and `cooldownSeconds` are both returned so no caller re-derives one from the other.

`clamped` is the field a panel can show. This release shows it in the Toolkit **output channel**, written
before the receipt block it governed (`extension.js`), and the receipt line itself now names the bounds it
came under:

```
Setting clamped: researchStack.integrationCooldownSeconds is 900 seconds, above the 300 seconds the Toolkit will wait for a check, so 300 seconds was used.
Integration check 2026-11-17T18:44:02.504Z — the worker call ran under a 40000 ms bound and the next check is allowed in 300 s
```

## 4. One resolution point

`extension.js` `integrationBounds()` is the only place the two settings are read; it hands the resolved
value to the four things that must agree:

1. the worker call's `timeout` (`runner.js` kill bound),
2. `integrations.probeCooldown(..., cooldownMs)` — the window a press is refused against,
3. `integrations.integrationViews(..., cooldownMs)` — the countdown the card names,
4. the log line that reports the receipt.

Before this package those were three numbers kept in three files (`integrationprobe.js` literals,
`integrations.js:392` default parameter, `extension.js` call sites), which is the drift HR-30 forbids.

## 5. Renegotiated pins (nothing deleted, everything re-pointed)

| Pin | Was | Now | Why |
| --- | --- | --- | --- |
| `credential-security.test.js:140` | `PROBE_COOLDOWN_MS === 10_000` | manifest default × 1000 === `PROBE_COOLDOWN_MS`, and `integrations.PROBE_COOLDOWN_MS === probe.PROBE_COOLDOWN_MS` | 0.3.13 proved a number in a source file while the manifest named no such setting — which is how the operator's report could say the setting "does not exist". The claim that matters is that the shipped default **is the published default**. |
| `credential-security.test.js:141` | no-arg `probeCooldown().waitMs === PROBE_COOLDOWN_MS` | kept, plus `integrations.PROBE_COOLDOWN_MS === probe.PROBE_COOLDOWN_MS` | still the anti-drift pin between the two halves; it is now direct instead of inferred from a computed wait. |
| `credential-security.test.js:142` | `PROBE_TIMEOUT_MS === 80_000` | manifest default === `PROBE_TIMEOUT_MS`; manifest `minimum`/`maximum` === `PROBE_TIMEOUT_MIN_MS`/`MAX_MS`; and `PROBE_TIMEOUT_MS > 34_000 + 35_000`, `PROBE_TIMEOUT_MIN_MS > 34_000` | the literal is replaced by the two facts the literal was standing in for: Settings and the clamp state one range, and the bound is above the worker's worst case. Changing the default below the worker's worst case now fails. |
| `integration-host.test.js:294` | `calls[0].options.timeout === PROBE_TIMEOUT_MS` | `=== probeBounds({}).timeoutMs` **and** `=== PROBE_TIMEOUT_MS` | the default path still has to hold (an operator who set nothing gets 80 s), but it is now pinned through the resolver the host actually calls, so the pair cannot drift. Comment names the new tests that cover the set path. |
| `integration-host.test.js:692, 1049→1122` | `facts read timeout < PROBE_TIMEOUT_MS` | kept unchanged | the fact is still true and still worth pinning. |
| `integration-host.test.js` J3 test title | "…not the probe's **20 s**" | "…whatever the operator set the check bound to (J3, HR-30)" | "20 s" was stale 0.3.11 wording; the claim is now proven against the ceiling of the operator's setting, which is the version that could actually break. |
| `integrations.test.js:470` comment | "the shared **30-second** check budget" | names `researchStack.integrationCooldownSeconds`, 10 s by default | 0.3.12 removed the 20 s blocking wait; the comment quoted a budget that had not existed for two releases. |
| `integrations.test.js:212-236`, `integration-host.test.js:1169` (J7) | read `PROBE_COOLDOWN_MS` from the module instead of repeating it | kept unchanged | already semantic pins; they survive the change, which is the point of having written them that way. |

New coverage (4 tests, all added in P4's own files):

- *the two integration settings are clamped to the range the manifest states, and a clamp is said out loud
  (HR-30)* — defaults with nothing set; in-range values used as set; 4 sub-floor and 2 over-ceiling timeout
  cases; 5 cooldown clamp cases; 10 non-numeric shapes; whole-second rounding; one sentence per clamp.
- *an operator-set check budget moves the card's countdown and the refusal together, never one of them
  (HR-30)* — `integrationViews(..., { cooldownMs })` vs `probeCooldown(..., { cooldownMs })` under the same
  window, and the floor case where the card says "allowed" while the default window would still refuse.
- *the bound the operator set is the bound the worker call runs under, and a bound outside the range is
  clamped and said (HR-30)* — 120 s honoured; 1 s refused at the floor with the clamp sentences in the log;
  the receipt line names the bounds it ran under; a text-valued setting falls back to the published bound
  and the check still runs.
- *an operator-set check budget changes the wait the panel reports, the seconds a refusal names, and when a
  press is allowed (HR-30)* — 30 s budget → refusal in 29 s, `panel.cooldownMs === 30000`, both cards'
  `probeWaitMs` inside the resolved window; the **same seeded record** with no setting → refused in 9 s; a
  5 s budget lets a press run 6 s after a check (behaviour, not wording), and the check's own timeout is
  untouched by it.
- *opening the integrations flow reads the machine record on its own short bound, whatever the operator set
  the check bound to* — at the ceiling of `integrationTimeoutMs` the facts read stays ≤ 5 s.

### Mutation evidence (the tests bite)

Two temporary mutations were applied, measured, and reverted:

| Mutation applied | Tests that failed |
| --- | --- |
| `extension.js` worker call back to the literal `PROBE_TIMEOUT_MS`, **and** `integrations.js` `integrationViews` dropping `cooldownMs` | `the bound the operator set is the bound the worker call runs under…`, `an operator-set check budget changes the wait…`, `an operator-set check budget moves the card's countdown…` — 3 fail / 75 pass |
| `probeBounds` clamp branches disabled (`given < min && false`, `given > max && false`) | `the two integration settings are clamped…`, `the bound the operator set… clamped and said…` — 2 fail / 63 pass |

Both mutations were reverted (`git diff` re-checked; no `&& false` remains; all files LF-only).

## 6. Measured results (this host, 2026-11-17)

| Run | Result |
| --- | --- |
| `npm test` before any P4 change | **482 tests, 482 pass, 0 fail, 0 skipped** (baseline reproduced) |
| `npm test` with P4 landed, before other packages' next edit | **487 tests, 487 pass, 0 fail, 0 skipped**, exit 0 |
| `node --test` on P4's three suites at hand-off | **88 tests, 88 pass, 0 fail, 0 skipped** (`credential-security 10/10`, `integrations 23/23`, `integration-host 55/55`) |
| `npm run test:panel` (`scripts/panel_renderer_check.js`) | **7 assertions, 7 pass, 0 fail, 0 not proven** |
| test-function counts vs `HEAD` | credential-security 9→10, integrations 22→23, integration-host 53→55 (**P4: +4 tests**); `runtime.test.js` 18→19 is **P6**'s test — together they are the 482→487 delta measured above |
| `npm test` at hand-off, whole tree | **496 tests, 493 pass, 3 fail** — all three in `test/bundles.test.js` |

### The three failures at hand-off are not P4's, and P4 did not touch them

They are P3's in-flight bundle work (`test/bundles.test.js` against `extension/bundles.js`; neither file is
in P4's file list and neither appears in P4's diff):

| Test | Observed assertion |
| --- | --- |
| T15-14 force update names each replaced file and its state | `deepStrictEqual`: the second file is reported `user-modified` where the test expects `conflict` |
| T15-15 archive index/log row | `==` on the log row `… reason=force-update files=3 archive=/tmp/…/archive/theological-research/20261117T192412Z-0001` |
| T15-17 restore re-archives what it replaced | `deepStrictEqual` mismatch |

`git diff --stat` at the same moment shows `extension/bundles.js` +891 and `extension/test/bundles.test.js`
+335 — P3 still writing. P4's own diff, by added/removed lines (`git diff --numstat`):
`integrationprobe.js` 62/3, `integrations.js` 14/4, `extension/extension.js` 37/9 (hunks 226–371 only),
`package.json` 16/0, `vsix-manifest.json` 16/0, `credential-security.test.js` 73/3,
`integration-host.test.js` 87/3, `integrations.test.js` 23/3.

No P4 change touched a test in another package's file; `git diff` at hand-off shows
`extension/extension.js` changed only in hunks 226–371 (the integration region), and the bundle-command
region, `bundles.js`, `presets.json` and `bundles.test.js` changes in the same diff belong to P2/P3/P6.

## 7. Outside the nominal file list, and why it was unavoidable

`extension/vsix-manifest.json` carries the **packaged** `contributes.configuration`. Two checks compare it
byte-for-byte with `extension/package.json` — `test/unit.test.js` ("development and packaged contribution
manifests agree") and `scripts/verify_vsix.py` (the packaged manifest must equal the repository manifest).
Adding the settings to `package.json` alone broke `unit.test.js` and would have shipped 0.3.14 with the
settings **absent from the artifact VS Code reads** — the same defect R15-04 reports, re-made. So the two
properties were mirrored verbatim. P8's identity bump and artifact audit should treat this as part of P4's
change, not as its own edit. Payload headroom is unaffected: the 0.3.13 artifact unpacks to 1 216 022
bytes against `MAX_UNPACKED_BYTES = 1_572_864`, and P4 adds ≈ 5 KB to the shipped members.

`extension/worker/README.md:54` still claims the setting was added in **0.3.12**. It is true of 0.3.14 and
false of 0.3.12; the wording belongs to **P7**, which owns that file. Nothing in this package edits a
README or changelog.

## 8. Panel visibility: what this release shows, and what a real VS Code host owes

- **Shown in the panel:** the resolved cooldown. `integrations.integrationViews(..., { cooldownMs })` feeds
  `view.probeWaitMs`, which `media/controls.js:481` puts in the "Check now" / "I have installed Zotero"
  tooltips as `The next check is allowed in N s.` An operator who raises the budget sees a longer countdown,
  and the host's refusal counts down the same seconds. `media/controls.js` was not touched.
- **Not shown in the panel:** the timeout bound and the clamp sentences. Surfacing them needs a new row in
  the integration card plus a row in `scripts/panel_renderer_check.js`, both in P3's declared region this
  release. The bound is therefore visible **in the log the Toolkit writes beside the receipt** — which the
  tests read and quote — and in the Settings UI's own `minimum`/`maximum`. `integrationPanelState()` does
  hand the panel `cooldownMs` (resolved) and the views carry the resolved wait; no field was added that the
  renderer does not render, because `integrations.test.js:193` pins the view's field set to exactly what the
  panel draws.
- **What a real VS Code host owes, and cannot be proven in this container:**
  1. `minimum`/`maximum` are advisory in the Settings UI: VS Code shows them, it does not refuse a
     hand-edited `settings.json` that breaks them. The clamp is the enforcement, and the log sentence is
     the announcement. `probeBounds` never reads a setting itself for that reason.
  2. VS Code's typed configuration supplies numbers for these two settings; the harness supplies whatever a
     test puts in `initial`. The non-numeric shapes in §3 are what a hand-edited file can actually contain,
     and they are proven against the harness only.
  3. The 34 s / 35 s derivation is arithmetic on the worker's own constants read in this tree. **No slow
     Zotero was measured here** — this container has no Zotero, and `probe-integrations` here answers
     `not-installed` in well under a second. The bound's floor is derived, not observed; T15-18 is proven
     for the JS halves, and the "a Zotero still loading its library is not killed" half stays a real-host
     measurement.
  4. The DOM-level panel behaviour is measured by `scripts/panel_renderer_check.js`; the browser-level
     behaviour (tooltip really appearing, a disabled control really being unreachable) is still owed by
     `extension/test/browser.test.js`, which has never run in this container.
