# Phase 7 review findings and disposition

An independent read-only review of the 0.3.7 lock-integrity fix reproduced 19 defects by running both
dependency readers against synthetic pairs. They are recorded here with what was done about each one,
because several are latent: they do not affect the pair this release ships, and they would affect the
next one.

| # | Finding (confirmed by probe) | Disposition |
|---|---|---|
| 1 | JS reader truncates a dependency array at a nested `]`, so `["mcp[cli]==2.2.0", …]` reads as an empty set → false drift report | Fixed in `extension/lockfile.js` (array parsed to its real closing bracket) + test |
| 2 | Both readers keep `; marker` inside the specifier while uv records markers in a separate `marker` key → false drift report | Fixed in both readers + tests |
| 3 | Extras compared wrongly in both readers (`mcp[cli]==2.2.0` vs `specifier = "==2.2.0"`) → the next extra-bearing dependency would block `npm run package` | Fixed in both readers + tests |
| 4 | JS loses the specifier when uv writes `marker` before `specifier` | Fixed in `extension/lockfile.js` |
| 5 | JS `lockMetadataRequiresDev` bleeds into a following sub-table | Fixed in `extension/lockfile.js` |
| 6 | JS `lockPackageBlock` picks a registry entry over the local one on a name collision | Fixed in `extension/lockfile.js` |
| 7 | `[dependency-groups]` `include = "…"` mishandled by both (JS false report, Python `ValueError`) | Fixed in both readers |
| 8 | JS reader throws where Python reports; `setupRuntime` had no guard, so a malformed bundled pair produced a raw reader error | Fixed: `pairProblems` reports instead of throwing, and `runtime.js` now routes a reader failure through the packaging-defect refusal (`readBundledPair`) with a test |
| 9 | Python `check_pair_text` let `TOMLDecodeError` escape, so `verify_vsix.py` printed a traceback | Fixed in `scripts/lockintegrity.py` |
| 10 | Lock-revision ceiling existed only in the Python reader | Fixed in `extension/lockfile.js` |
| 11 | Shared false negatives: root `source` mode/path, `[tool.uv]` resolution inputs, a lock missing `requires-python`, several local entries, dynamic version with no recorded version | Partially fixed: `source` mode/path, missing `requires-python` and multiple local entries are now reported by the Python reader. `[tool.uv]` resolution inputs and dynamic-version-without-a-recorded-version remain **open** |
| 12 | The `--frozen` tier fired for any recognised refusal and had no real-uv receipt | Fixed: the tier now runs only when the toolkit's own reader finds the shipped pair consistent (a build the reader agrees is broken is refused with the packaging wording), and `uv sync --frozen` was measured against the drifted pair on all seven uv versions — exit 0 on every one (`evidence/quality-v0.3.7-2026-11-02/uv-matrix.json`) |
| 13 | `extension/scripts/package.js` copied the worker tree with no lock gate, so a direct run could ship a stale pair | Fixed: `assertWorkerPairCurrent` refuses before staging, verified against a deliberately drifted lock (exit 1, no artifact written) |
| 14 | `build_worker_bundle.py` wrote `bundle.json` before its post-write pair assertion | Fixed: the built pair is checked before the manifest is written |
| 15 | The notebook analysis pair had no runtime self-check | Fixed: `steps.js` reads the pair it just wrote and refuses before running uv (`notebookPairProblems`) + test |
| 16 | `runner.js` truncated captured output from the head, dropping uv's refusal which is printed last | Fixed: truncation keeps both ends |
| 17 | Scrubbing `UV_*` was silent; `conflictingUvVariables` was exported but never used | Fixed: `scrubbedUvVariables()` names the removed settings in the failure text + test. `UV_PYTHON_DOWNLOADS: "automatic"` stays a reviewed value on purpose — the managed worker needs a Python 3.12 the host may not have; recorded as decision DD7-09 |
| 18 | `scripts/lockintegrity.py` docstring claimed uv 0.5.0 and 0.13.6 both *write* `revision = 5` | Fixed: the docstring now states what the receipts show — 0.13.6 wrote it, 0.5.0 read it |
| 19 | `DRIFT_SIGNATURE` also matches `--check`, which shipped code never runs; refusals that name a staleness reason fell to the generic message | Partially fixed: the staleness-reason shapes are recognised by `isLockDrift`. Removing the `--check` alternative is **open** (it is harmless and would matter if a preflight pre-check is ever added) |
| 20 | `[project.optional-dependencies]` was invisible to both readers. uv records an optional dependency in `requires-dist` as `{ name = "pypdf", marker = "extra == 'pdf'", specifier = "==6.4.1" }` and names the groups in `provides-extras`, so a project with extras was reported as drift by both readers and would have been refused by `npm run package` (measured with uv 0.13.6 and uv 0.5.0) | Fixed in both readers + tests. Extras are folded into the declared set and the group names are compared with `provides-extras` **only when the lock records it** — uv 0.5.0 writes the same `requires-dist` entries and no `provides-extras`, so treating the missing key as drift would refuse a lock real uv accepts |
| 21 | Single-quoted TOML scalars: the JS reader only recognised `"…"` | Fixed in `extension/lockfile.js` (both quote styles) and already tolerant in the Python reader, where a test now proves it |

## What the review confirmed as already correct

The 0.3.6 defect itself is caught by both readers and by all three gates; added/removed/changed
dependencies, dev groups and `requires-python` are detected; comments and duplicate package names cause
no false positives; `isLockDrift` is reachable from the error object the runner builds; a drift refusal
is never mistaken for a transient failure and never retried; `--frozen` cannot run twice; no code path
issues a plain `uv sync` or `uv lock` inside a managed runtime; `--no-config` is still passed; the
scrub keeps cache, keyring and concurrency settings; the bundled self-check runs before any uv call,
any directory creation and any write; and `verify_vsix.py` compares both packaged pairs as packaged
bytes.

## Open items carried forward

1. `[tool.uv]` resolution inputs (`override-dependencies`, `constraint-dependencies`, `sources`,
   `environments`, `required-environments`, `default-groups`) are not read by either reader. A pair that
   is consistent in the two files but inconsistent with a `[tool.uv]` override still reaches a host.
2. A `dynamic = ["version"]` project with no recorded lock version is accepted by both readers.
3. `DRIFT_SIGNATURE` keeps a `--check` branch that shipped code never exercises.
4. The reference-host receipts (G1–G4) and the re-run of the reported field workspace are still open.
