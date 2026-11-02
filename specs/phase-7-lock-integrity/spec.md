# Phase 7 specification — lockfile integrity and lock-drift recovery (0.3.7)

Date: 2 November 2026 (Europe/Prague). Predecessor: [specs/phase-6](../phase-6/spec.md) (0.3.6 install reliability).
Scope: a patch release. Nothing in Phase 6's contracts is widened; the process boundary, module set and
status vocabulary stay as reviewed.

## 1. Observed failure (field report, 2 November 2026)

Workspace `K:\Soukromé_aktivity\Bankovní účet SVJ ČSA368`, toolkit 0.3.6, package `full`. The panel reported:

> Installation incomplete — 1 step(s) verified, 1 need attention (Isolated locked worker (Python 3.12)).
> 1 of 4 package steps are installed in this workspace.
> `uv.exe sync failed with exit code 1: Resolved 40 packages in 63ms | The lockfile at `uv.lock` needs to be
> updated, but `--locked` was provided. To update the lockfile, run `uv lock`. (cwd …\.research-toolkit\managed\worker-0.3.6)`

`setup-20261102T151311Z.jsonl` records `{"kind":"step","stepId":"worker","status":"failed","exitCode":1,"durationMs":193}`
and `{"kind":"plan","status":"partial","failed":["worker"]}`. Phase 6's reporting worked exactly as designed: the
failing step, its exit code, uv's own words and the cwd were shown, the plan continued past the failure, and the
verdict survived a panel reopen. **What Phase 6 could not do is stop the toolkit from shipping a broken pair.**

## 2. Diagnosis

Each finding names the artefact that produces it. D7-01 was reproduced on this host with real uv, not
inferred. Line numbers below refer to the **0.3.6 tree at the time of diagnosis** — they are evidence of
what was found, not pointers into the 0.3.7 source. [review-findings.md](review-findings.md) records what
was done about each finding.

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| **D7-01** | The shipped worker pair is internally inconsistent: `extension/worker/pyproject.toml` declares `version = "0.3.6"` while `extension/worker/uv.lock:623-624` records `name = "research-stack-basic"`, `version = "0.3.4"`. | Read from the packaged 0.3.6 VSIX (`extension/worker/pyproject.toml`, `extension/worker/uv.lock`). The root pair has the same split. `git show 235df2e -- uv.lock` shows the lock was last re-locked for **0.3.4**; the 0.3.5 and 0.3.6 version bumps never re-ran `uv lock`. | uv compares a lockfile with the project metadata before honouring `--locked` ([uv docs — Locking and syncing](https://docs.astral.sh/uv/concepts/projects/sync/)), and a project-version bump counts as drift ([uv #15643](https://github.com/astral-sh/uv/issues/15643), [uv #21854](https://github.com/astral-sh/uv/issues/21854)). Every managed worker setup on a real host stops before installing anything. |
| **D7-02** | Nothing in the build, the audit or the test suite compares a `pyproject.toml` with the `uv.lock` beside it. | `scripts/build_worker_bundle.py` copies both files and hashes them without comparing them. `scripts/verify_vsix.py` compares hashes and inventory only. No test in `tests/` or `extension/test/` reads both files. | The same defect shipped in 0.3.5 and 0.3.6. A release that bumps a version cannot be proven lock-current. |
| **D7-03** | A lock-drift failure is reported as an ordinary non-zero exit. | `extension/runner.js:44-89` classifies it `kind: "exit"` and `describe()` prints uv's stderr tail. `retryable()` correctly does not retry it. | The operator sees uv's message but no toolkit-side explanation: which file is stale, whether their machine caused it, or what to do. The generic hint ("The first run can download a managed Python 3.12 and the locked packages.") points at the wrong cause. |
| **D7-04** | Setup has no recovery tier between "locked" and "give up". | `extension/runtime.js:270` issues exactly one command shape: `sync --locked --no-dev --python 3.12 --project <worker> --no-config`. | A byte-correct lock that a host's uv calls stale (mirror/index env, uv-version differences — [hermes-agent #122740](https://github.com/NousResearch/hermes-agent/issues/122740), [uv #20635](https://github.com/astral-sh/uv/issues/20635)) has no path to a working environment. |
| **D7-05** | The uv child inherits the user's `UV_*` environment. | `extension/runner.js:118-128` spreads `process.env` and sets six `UV_*` values; `--no-config` disables config **files** only, and uv states environment variables take precedence over persistent configuration ([uv docs — Configuration files](https://docs.astral.sh/uv/concepts/configuration-files/)). | A user's `UV_INDEX_URL`, `UV_DEFAULT_INDEX`, `UV_LOCKED`, `UV_FROZEN`, `UV_OFFLINE` or `UV_EXCLUDE_NEWER` silently changes what the reviewed command means, and can make a correct lock look stale. |
| **D7-06** | Nothing in the build proves the release version is one the packager accepts. | `extension/node_modules/@vscode/vsce/out/validation.js:66` `validateVersion` → `semver.valid`, which returns null for `0.3.6.1`; the Marketplace message is "one to three numbers" ([vscode-vsce #415](https://github.com/microsoft/vscode-vsce/issues/415), closed as designed). | The requested `0.3.6.1` cannot be packaged at all: `npm run package` stops with `Invalid extension "version": "0.3.6.1" in package.json`. The identity was only a convention, so the first patch-of-a-patch release discovered the constraint at packaging time instead of at design time. |
| **D7-07** | `npm run verify-package` and `npm run check:payload` hard-code `research-stack-toolkit-0.3.6.vsix`. | `extension/package.json:318-319`. | After a release they audit the **previous** artifact, or fail. Release verification silently points at the wrong bytes. |
| **D7-08** | Two Phase 6 residuals are cheap to close in a patch. | `extension/runtime.js:201` fixes `functionalCheck` at 90 s regardless of `researchStack.setupTimeoutSeconds`; `extension/runner.js:84` reports the last attempt's bound, not the wall time across attempts. | A long setup timeout is not honoured by the verification run; a retried timeout understates how long the operator actually waited. |

## 3. Requirements

`R7-xx` are normative. `→` names the finding they close.

### 3.1 Lock integrity at build time (D7-01, D7-02)

- **R7-01** Every `pyproject.toml` / `uv.lock` pair this toolkit builds, bundles or ships is compared the way uv
  compares it — root package name, root package version, `requires-python`, declared dependency specifiers and
  declared dependency groups — with no uv, no network and no environment.
- **R7-02** `scripts/build_worker_bundle.py` refuses to write a worker bundle when any shipped pair is stale, and
  re-checks the pair it just wrote.
- **R7-03** `scripts/verify_vsix.py` checks the **packaged** worker pair, not only the source tree, so an artifact
  cut from a stale tree cannot pass the audit.
- **R7-04** The Python test suite fails when any shipped pair is stale, and proves the detector catches a
  version-only bump (the exact 0.3.6 defect) with a synthetic fixture.
- **R7-05** When a `uv` is available on the development host, the suite also runs the authoritative check
  (`uv lock --check`) against the shipped pairs; when it is absent the case is skipped and named, never silently
  passed.
- **R7-06** The shipped `uv.lock` is the bytes a pinned `uv` produced from the shipped `pyproject.toml`; the pin
  and the measured uv versions are recorded in the release evidence.

### 3.2 Lock-drift diagnosis and recovery at runtime (D7-03, D7-04, D7-05)

- **R7-07** Before any uv process runs, setup compares the **bundled** worker pair in-process. A mismatch is
  reported as a packaging defect of this build, names both files, and no process and no file is touched.
- **R7-08** A uv lock-drift refusal is recognised as its own failure class. The operator gets uv's own sentence
  and hint, the toolkit's explanation of which file disagrees, and the fact that this is not a network or
  interpreter problem. It is never retried blindly.
- **R7-09** After a lock-drift refusal, setup makes exactly one bounded fallback attempt with `uv sync --frozen`
  — install exactly what the shipped lock pins, without rewriting the shipped lock — and records the fallback,
  its reason and the drift in the attempt log, the receipt and the panel. Plain `uv sync` is never used: it would
  rewrite a file the release hashed.
- **R7-10** The fallback never hides the defect: the step is reported with a warning, the verdict stays
  distinguishable from a clean success, and the panel names the drift.
- **R7-11** The uv child environment carries only the reviewed `UV_*` values. Inherited `UV_*` variables that
  change the meaning of the reviewed command are removed, and the removal is visible in the diagnostics.
- **R7-12** `uv lock --check` is used only when the host's uv supports it; a uv that does not know the flag is
  not treated as a failure.

### 3.3 Release identity that the packager can actually build (D7-06, D7-07)

- **R7-13** `0.3.7` is stated identically in `pyproject.toml`, `src/research_stack/__init__.py`,
  `extension/package.json`, `extension/vsix-manifest.json` and `extension/runtime.js`, and the identity tests
  reject any version `@vscode/vsce` would refuse to package (one to three numbers).
- **R7-14** Managed runtime discovery accepts exactly the folder names this toolkit can ship — `worker-<three-part>`
  — and skips malformed ones, so the current runtime is discoverable, activatable and roll-back-able.
- **R7-15** `npm run verify-package` and `npm run check:payload` resolve the artifact name from
  `extension/vsix-manifest.json` instead of a hard-coded version.

### 3.4 Phase 6 residuals closed in this patch (D7-08)

- **R7-16** `functionalCheck` honours `researchStack.setupTimeoutSeconds` the same way the setup steps do.
- **R7-17** A retried run reports the total wall time of the attempts it actually made, not the last attempt's bound.

## 4. Explicit non-goals

- No second process boundary, no `shell: true`, no new `execFile` call site (Phase 6's audit rule stands).
- No rewriting a shipped, hash-manifested file in the managed directory. `uv lock` is not run against the managed
  worker: it would break `validateWorker`'s integrity promise for a cosmetic version label.
- No change to the reviewed dependency set: the 40 locked packages and their hashes are unchanged in 0.3.7.
- No auto-update of the user's own project lockfiles. This toolkit only manages its own worker project.
