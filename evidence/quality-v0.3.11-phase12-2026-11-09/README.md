# Quality evidence — 0.3.11 phase 12 (integration resilience and guided installation)

Captured 9 November 2026. Version stays **0.3.11**, uncommitted and unreleased: this phase extends the
same unreleased version rather than opening 0.3.12.

Plan of record: [specs/phase-12-integration-resilience/](../../specs/phase-12-integration-resilience/)
— spec.md, design.md (DD12-01…DD12-20), request-path-map.md, documentation-review.md, tasks.md,
acceptance.md (T12-01…T12-40, RG12-A…RG12-E).

## Receipts

| File | What it proves |
|---|---|
| `node-test.log` | `npm test` → **468 tests, 468 pass, 0 fail, 0 cancelled, 0 skipped** in 16.6 s. Baseline before this phase: 436. |
| `python-test.log` | `uv run --locked python -m pytest -o addopts="" -q tests/` → **352 passed, 0 failed, 0 skipped** in 141.8 s. Baseline before this phase: 273 at the 0.3.11 audit. |
| `package-build.log` | Guide index, worker bundle (**23 reviewed source/lock files**, 11 overlay templates, worker 0.3.11), `scripts/package.js`. |
| `vsix-audit.log` | `npm run verify-package` → `result: passed`, **110 members**, `packageBytes 473110`, `unpackedBytes 1420824`, `sourceFilesMatch: true`, and the boundary receipts quoted below. |
| `payload-check.log` | `npm run check:payload` → `result: passed`, **38 registered commands** (unchanged), 32 guides, integration section present in the packaged panel HTML, no credential value in it. |
| `vsix-sha256.txt` | `sha256 9230704d8cdd49700e83627b67fd16bbb7f70824ee5405100ff0d289806bd584`, and a second consecutive build produced the same digest. |

Artifact: `dist/research-stack-toolkit-0.3.11.vsix`, 473 110 bytes on disk.

## The byte ceiling was breached, and then re-measured

This is the one gate this phase failed before fixing, recorded rather than smoothed over.

| Measurement | Unpacked bytes | Members |
|---|---|---|
| 0.3.10 artifact | 1 276 822 | 104 |
| 0.3.11 recorded audit (8 Nov) | 1 343 649 | 108 |
| mid-phase build, after `provider_budget.py` | 1 365 400 | 109 |
| build after guided installation and the budget work | 1 383 104 | 109 |
| **final build, after INT-15** | **1 420 824** | **110** |

`npm run verify-package` failed against 1 376 256 at 1 383 104 — 6 848 bytes over. Nothing was moved out of the package
and no reviewed file was dropped, so the option the gate's own comment names was taken: re-measure. The ceiling is now
**1 441 792** (1.375 MiB), exactly one 1/16 MiB step of 65 536. The final build lands **20 968 bytes under it**
(1.5 % of the payload), so the ceiling was raised once, for a measured breach, and the phase then finished inside it.
Attribution of the growth from 1 343 649 to 1 420 824 — **77 175 bytes and two new members**:

| Member | Delta |
|---|---|
| `extension/worker/src/research_stack/provider_budget.py` | **+16 943** (new member — the cross-process request budget) |
| `extension/worker/src/research_stack/machinefacts.py` | **+10 293** (new member — the machine-level installation fact) |
| `extension/integrations.js` | +16 205 (one action list computed from the record, `keyDecision`, degraded wording, machine-fact application) |
| `extension/extension.js` | +12 418 (guided-install and key-request flows, two-agreement consent, the facts read when the integrations flow opens) |
| `extension/integrationprobe.js` | +5 609 (`rate-limited` / `auth-required` outcomes, `interpretFacts` and `factRejectionReason` at the shared 8 192 cap) |
| `extension/worker/src/research_stack/research.py` | +4 541 (loopback-only Zotero client, connector ping, budget consult) |
| `extension/readme.md` | +4 102 (the new §"What the Toolkit writes, and where") |
| `extension/media/controls.js` | +1 731 (renders `view.actions`, shows what the check saw and where a fact came from) |
| `extension/worker/src/research_stack/integrations.py` | +1 522 (three-state Zotero probe, confirmed setting wording, accurate "no workspace file" wording) |
| `extension/worker/src/research_stack/recommended.py` | +426 (both new worker modules listed for upgraded workspaces) |
| `extension/worker/src/research_stack/cli.py` | +261 (the `integration-facts` verb) |
| `extension/integrationstore.js` | +19 (exports the environment names so the facts call can be proven credential-free) |
| panel sheet, guides, manifests | +3 595 (coordinator wording edits; named as a group because no per-file baseline was recorded) |

## Capability boundaries, as measured over the built artifact

Quoted from `vsix-audit.log`, because these are the receipts that matter for this phase:

- **Process**: `extension/runner.js` remains the only process-execution call site in packaged JavaScript;
  all 22 packaged Python members were scanned and none executes a process.
- **Dynamic code**: no `eval(`, `exec(`, `__import__(`, `os.system`, `os.popen`, `os.exec*`, `pty`,
  `multiprocessing` in any packaged Python member, with one reviewed allowlist entry (`extension/probe.py`).
- **Outbound network**: JavaScript — `extension/updates.js` only. Python — exactly two named members,
  `extension/worker/src/research_stack/research.py` and
  `extension/bundles/theological-research/scripts/crossref_lookup.py`, each still carrying its stated
  hosts, timeout and byte cap, **and each keeping the reviewed number of transport call sites** (the
  worker: two openers — the same-host HTTPS provider client and the loopback-only Zotero client; the
  bundle script: one direct `urlopen`). No other packaged Python member matched `urllib.request`,
  `urlopen`, `build_opener`, `socket` or `http.client`.

The connector ping added no capability: it reuses the existing loopback opener, so the reviewed count
stayed 2 openers / 0 `urlopen`, and a test asserts that the ping body contains no opener, no `urlopen`
and no second timeout.

## New writable footprint, and its bound

The worker now writes, under the OS user's per-user application-data directory in
`research-stack-toolkit/`, one budget file per provider, one response cache per provider, and one machine-level
installation record. Budget files hold only `windowStartMs`, `permits`, `nextAllowedMs`, `blockedUntilMs`. The cache is
bounded at 16 entries × 32 768 bytes (≈ 0.5 MB worst case) and holds provider metadata only — no key, no token, no URL,
no workspace path. The installation record `integration-facts.json` is capped at **8 192 bytes**, holds only
`found`, `classification`, `platform`, `detectedAtMs` and `code`, and refuses a value shaped like a secret, a token, a
workspace path or a user-file path without echoing it. Locks are `O_CREAT|O_EXCL` with a 30 s stale takeover; no `fcntl`.
The operator-facing description of all three files, with the per-platform locations, is `extension/readme.md`
§"What the Toolkit writes, and where".

Verified statically, by scanning the packaged bytes directly rather than trusting a report: `provider_budget.py`,
`machinefacts.py`, `integrations.py`, `cli.py` and `recommended.py` contain none of `subprocess`, `eval(`, `exec(`,
`__import__(`, `os.system`, `os.popen`, `os.exec*`, `pty`, `multiprocessing`, and none of `urllib`, `urlopen`,
`build_opener`, `socket`, `http.client` or `fetch(` — including in comments. All are LF-only, no trailing whitespace,
final newline present. `machinefacts.py` matches `extension/runtime.js:16` `WORKER_PATH`.

## What is proven, and what is not

Proven in this container, through real commands and real panel messages rather than helper calls:
T12-22 (no install offer when Zotero is detected, in the card **and** the Quick Pick, and the host
refusing a guided request outright), T12-23 (guided offer states "downloaded nothing and ran nothing",
opens only the official URL, makes one worker call, writes no file), INT-14.7 (degraded wording never
suggests re-authorizing and never promises a pause the check did not carry), T12-15 (a key reaches
`context.secrets` only — absent from globalState, panel state, output channel and every message), the
declined-key honesty case (no key, no consent, walkthrough not marked finished, secrets untouched), the machine-fact
reuse cases (a fresh profile with a seeded record gets `installation` pre-filled and no guided-install offer, while
`authorization`, `mode`, `credentials` and `onboarding` all start fresh), the machine-fact refusals (unknown
classification, missing platform, missing or non-positive timestamp, `found`/classification contradiction, an unreadable
format, a record over the cap, a record claiming an installation for Semantic Scholar — each refused with the reason
stated and nothing changed), and a static gate that no shipped integration module contains `setTimeout(`, `setInterval(`
or `setImmediate(`.

**Not proven here, and not claimed:**

- **T12-19 against a real Zotero.** Both `http://127.0.0.1:23119/api/` and `/connector/ping` give
  `ConnectionRefusedError` on this host. The three-state answer is proven against transport fakes only.
- **T12-16 with a real Semantic Scholar key**, and any real 429 against the live API.
- **Two real VS Code profiles of one OS user.** The cross-profile reuse is proven against a seeded machine record, not
  against a second editor profile.
- **`extension/test/browser.test.js`** — Playwright is not installed in this container, so the card's
  real-browser rendering of the new action buttons is unproven here. A second route was attempted and failed: the panel
  HTML was rendered standalone through the real harness and served on loopback, but the session's Playwright browser
  blocks `file://` and its loopback is a different network namespace from this shell's. It is proven at the model level
  (the action list) plus the card-coverage gate and `npm run check:payload`.
- **`npm run test:host`** — needs `VSCODE_EXECUTABLE_PATH`, which this container does not have.
- A real Windows host, a real Extension Host, and the installer-signature behaviour that only a real
  Windows machine can show.
