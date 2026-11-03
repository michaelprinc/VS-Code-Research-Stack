# Research Stack Toolkit 0.3.7 — lockfile integrity and lock-drift recovery

Recorded 2 November 2026 on the Linux development host.

Specification: [`specs/phase-7-lock-integrity/spec.md`](../../specs/phase-7-lock-integrity/spec.md)
(findings D7-01…D7-08, requirements R7-01…R7-17), [`design.md`](../../specs/phase-7-lock-integrity/design.md)
(decisions DD7-01…DD7-11), [`tasks.md`](../../specs/phase-7-lock-integrity/tasks.md),
[`acceptance.md`](../../specs/phase-7-lock-integrity/acceptance.md) (T7-01…T7-21) and the
[gate checklist](../../specs/phase-7-lock-integrity/checklists/gates.md).
Evidence: [`evidence/quality-v0.3.7-2026-11-02/`](../../../evidence/quality-v0.3.7-2026-11-02/test-summary.md).

## Why this release exists

A field workspace (`Bankovní účet SVJ ČSA368`, toolkit 0.3.6, package *full*) reported:

> Installation incomplete — 1 step(s) verified, 1 need attention (Isolated locked worker (Python 3.12)).
> 1 of 4 package steps are installed in this workspace.

The worker step's log line was the whole diagnosis:

```json
{"kind":"step","stepId":"worker","status":"failed","exitCode":1,"durationMs":193,
 "error":"uv.exe sync failed with exit code 1: Resolved 40 packages in 63ms | The lockfile at `uv.lock` needs to be updated, but `--locked` was provided. To update the lockfile, run `uv lock`. (cwd …\\.research-toolkit\\managed\\worker-0.3.6)…"}
```

**0.3.6 shipped an inconsistent pair.** `extension/worker/pyproject.toml` declared
`version = "0.3.6"` while the `uv.lock` beside it still recorded the root package
`research-stack-basic` at **0.3.4** — the lock had been copied forward from an earlier release without
a re-lock. uv compares a lockfile with the project metadata *before* it honours `--locked`, so it
refused the pair on every managed setup, on every uv version. It was a packaging defect in the
toolkit build, not a network, proxy, interpreter or workspace problem — but the toolkit reported it as
a generic step failure, and the user had no way to tell which of those it was.

## What 0.3.7 does

**The pair is repaired, with provenance.** `uv.lock` was regenerated with a pinned uv 0.13.6 rather
than hand-edited. The diff against the 0.3.6 lock is two lines — `revision = 3 → 5` and the root
`version = "0.3.4" → "0.3.7"` — and the 39 third-party pins are unchanged
([`lock-provenance.json`](../../../evidence/quality-v0.3.7-2026-11-02/lock-provenance.json)).

**A build cannot ship a lock uv will refuse** (`scripts/lockintegrity.py`). A uv-free reader of exactly
the fields uv compares — the lock's root `[[package]]` entry, its `requires-python`, its dependency
specifiers and `requires-dev`, against `[project]` in `pyproject.toml`. It runs in
`scripts/build_worker_bundle.py` on the source pairs before anything is staged, and again on the built
worker pair before `bundle.json` is written, in `scripts/verify_vsix.py`
against the **packaged** bytes of the worker and the overlay notebook project, in
`tests/test_lock_consistency.py`, and as a CLI (`python3 scripts/lockintegrity.py`, exit 1 on drift).

**Setup refuses its own build before it touches anything** (`extension/lockfile.js`,
`extension/runtime.js`). `setupRuntime` reads the bundled pair first. If they disagree it throws
naming both files and the disagreeing field — *"This toolkit build ships a locked dependency file that
does not match its own project file: … No process ran and no file was written. Reinstall the Research
Stack Toolkit VSIX; this is a defect in the toolkit build, not in this workspace."* — and no uv process
is started and nothing is written into the workspace.

**One recorded fallback, never a silent one** (`extension/runtime.js`, `extension/steps.js`). The worker
step runs `uv sync --locked …`. Only when uv's own refusal is recognised as lock drift does it run
exactly one `uv sync --frozen …`, and the step evidence and setup log carry a
`lockFallbackNote` naming the detection, the problems and uv's message, so a fallback install is never
reported as a clean one. The toolkit never runs `uv lock` inside a managed runtime — that would break
the `bundle.json` hashes the setup verifies — and never issues a plain unlocked `uv sync`.

**The child process gets the reviewed environment** (`extension/runner.js`). `--no-config` disables
config *files*; environment variables win over them. `setupEnvironment` now strips the `UV_*` names that
would change what the reviewed command means (`UV_INDEX`, `UV_INDEX_URL`, `UV_DEFAULT_INDEX`,
`UV_EXTRA_INDEX_URL`, `UV_FIND_LINKS`, `UV_NO_INDEX`, `UV_LOCKED`, `UV_FROZEN`, `UV_UPGRADE`,
`UV_NO_SYNC`, `UV_OFFLINE`, `UV_NO_DEV`, `UV_SYSTEM_PYTHON`, `UV_EXCLUDE_NEWER`,
`UV_PYTHON_PREFERENCE`) and then applies the five reviewed `UV_*` values plus `UV_PROJECT_ENVIRONMENT`,
which it derives from the project directory. A user's mirror or a stray `UV_LOCKED` can
no longer make a correct lock look stale.

**Failure text a user can act on** (`extension/runner.js`). A lock refusal is described as a lockfile
and project file that do not match, explicitly *not* a network, proxy or interpreter problem. A timeout
now reports the bound per attempt, how many attempts ran, and the total time waited.

**Verification points at the artifact the release cut** (`extension/scripts/with-artifact.js`).
`npm run verify-package` and `npm run check:payload` derive the VSIX path from
`extension/vsix-manifest.json` instead of a hard-coded 0.3.6 filename.

**The reading check honours the operator's bound** (`extension/runtime.js`):
`Math.max(90000, researchStack.setupTimeoutSeconds)` instead of a fixed 90 s.

## Findings that changed the plan

1. **The recovery tier is real, and measured.** `uv sync --frozen …` against the drifted 0.3.6 pair
   exits 0 and installs the pinned set on all seven uv versions, while `uv sync --locked …` against the
   same tree is refused by all seven. The tier is also gated: it runs only when the toolkit's own reader
   finds the shipped pair consistent, so a genuinely broken build is refused with the packaging wording
   instead of being softened into a warning.
2. **uv's refusal exit code is not stable.** On a drifted pair, uv 0.8.5, 0.9.30, 0.10.7 and 0.13.6
   exit 1; uv 0.5.0, 0.6.10 and 0.7.22 exit 2 — all seven print the same sentence. Detection matches
   `DRIFT_SIGNATURE` on stderr and never a number. Receipt:
   [`uv-matrix.json`](../../../evidence/quality-v0.3.7-2026-11-02/uv-matrix.json).
3. **A four-part version cannot be packaged.** The requested `0.3.6.1` is rejected by
   `@vscode/vsce`'s `validateVersion` → `semver.valid`, and the Marketplace accepts "one to three
   numbers" ([vscode-vsce #415](https://github.com/microsoft/vscode-vsce/issues/415), closed as
   designed). `npm run package` stopped with `Invalid extension "version": "0.3.6.1"`. The release is
   **0.3.7**, and `tests/test_release_identity.py::test_release_version_is_one_vsce_can_package` now
   fails on any version the packager would refuse, so the constraint is a guard rather than a surprise
   discovered at release time.

## What was deliberately not changed

No second process boundary and no `shell: true`; `extension/runner.js` remains the only `execFile` call
site in packaged JavaScript. The reviewed 40-package locked set, its versions and its hashes are
unchanged. No user project lockfile is touched — the toolkit reads and repairs only the pairs it ships.
No `uv lock` is ever run inside a managed runtime.

## Verification

`cd extension && npm test` → **250 passed, 0 failed** (16 files run; `host.test.js` and `browser.test.js`
are the commands that would produce the reference-host receipts — they are not part of `npm test` and
were not run for 0.3.7, which is why G1–G4 remain open; `test/lockfile.test.js` (24 tests) and `test/lockfile-adversarial.test.js` (73 tests) are new). `.venv/bin/python -m pytest` → **185 passed** with `RESEARCH_STACK_UV` pointing at uv 0.13.6,
**184 passed + 1 skipped** without one (`tests/test_lock_consistency.py`, 65 tests). `dist/research-stack-toolkit-0.3.7.vsix` — 86 files,
312 471 bytes, sha256 `f4db025b12718b62336ebec091ba79523a059ffa9de3ba998f66549183666416` — passes
`npm run verify-package` (including the packaged-pair check, `sourceFilesMatch: true`) and
`npm run check:payload`. `uv lock --check` (uv 0.13.6) exits 0 on all three shipped pairs.

**The artifact as first built was not reproducible from the tag.** 17 of its 86 packaged members — the
16 guides under `extension/guides/` and `extension/media/toolkit.svg` — carried CRLF line endings while
the committed tree holds LF: `extension/guides/uv.md` was 2,372 bytes with 21 CRLF in that build, against
2,351 bytes and no CRLF at `git show v0.3.7:extension/guides/uv.md`. A fresh clone of the tag therefore
produced a different digest from the one recorded above. `extension/scripts/package.js` now rewrites the
staged tree to LF, and `scripts/verify_vsix.py` refuses an artifact whose packaged text members contain
CRLF; the rebuilt artifact carries CRLF in none of its 86 members.

## What remains open

The field report came from Windows 11 x64 with `uv.exe`. This release proves the install path on a
Linux development host against seven real uv binaries; it does not reproduce that host. The reference-host
receipts for the G1–G4 profile gates, and the actual re-run of the field workspace's setup with the
0.3.7 VSIX, are still to be produced. Basic and Research remain prototypes; the toolkit still does not
install uv itself, does not run setup in the background, does not execute notebook kernels and does not
connect to external providers.
