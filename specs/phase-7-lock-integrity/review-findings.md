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


## Second review round (after the v0.3.7 tag)

Four independent reviews ran against the tagged release: a Windows portability review, an end-to-end
install test of the packaged VSIX, an adversarial test campaign against both dependency readers, and a
claims audit of the release documentation. Each row below was confirmed by a probe or a test on this
host before it was recorded.

| # | Finding (confirmed by probe) | Disposition |
|---|---|---|
| 22 | The `UV_*` scrub was case-sensitive. Windows reports environment names in the host's own spelling (`Uv_Index_Url`, `uv_locked`), so a host setting survived the scrub and reached the child, and the same name could appear twice in the child environment | Fixed in `extension/runner.js`: the dropped set is matched case-insensitively and now also covers the five reviewed names and the derived `UV_PROJECT_ENVIRONMENT`, so no spelling of a meaning-changing name reaches uv + test |
| 23 | A step that installed through the lockfile fallback was reported as a clean install: the panel headline, the step row and **Copy Installation Diagnostics** all omitted it | Fixed: `installer.js` carries `lockFallback` into the status record, `status.js` names it in the headline, the step row and the diagnostics note + tests in `status.test.js` and `installer.test.js` |
| 24 | The command an operator is told to re-run was not pasteable: `--project K:\Soukromé aktivity\Bankovní účet SVJ ČSA368\…` contains spaces and was printed unquoted (the reported field workspace is exactly such a path) | Fixed in `installer.js` (`commandLine` quotes any argument containing whitespace) + test |
| 25 | A lock-drift refusal carried no `kind`, exit code or hint, so the status record showed an empty command with no exit code and the next-action table answered "Retry this step" to a build defect a retry cannot fix | Fixed in `runtime.js` at both refusal sites: the refusal keeps the runner's `kind`/`exitCode`/`command`/`args`/`attempts` and carries the reinstall hint + test |
| 26 | `runNotebookStep` resolved uv with `root` where the resolver takes `roots: [root]`, so the workspace root was never passed and a workspace-local uv could be executed after the resolver had refused it | Fixed in `extension/steps.js` |
| 27 | The notebook step had no fallback tier: a host that refused the notebook lock had no reviewed path, unlike the worker step | Fixed in `extension/steps.js` with the same one bounded gated `--frozen` tier (DD7-06), the same refusal when the toolkit's own reader agrees the pair disagrees, and the same evidence note + test proving an ordinary sync failure still gets no fallback. Measured on the notebook analysis pair itself in a temp copy: `uv sync --locked` refuses it when the manifest version is wound back (exit 2 on uv 0.5.0, exit 1 on uv 0.13.6, the same sentence) and `uv sync --frozen` installs it (exit 0 on both) |
| 28 | The 0.3.7 artifact was not reproducible from the tag: 17 packaged members (16 guides and `extension/media/toolkit.svg`) carried CRLF in the VSIX while the committed tree holds LF, so a clean-clone build produced a different digest (301,300 bytes against 301,366) | Fixed: `extension/scripts/package.js` normalises the staged tree to LF before packaging, `scripts/verify_vsix.py` refuses CRLF in any packaged text member and compares payload bytes line-ending-normalised + 3 tests in `tests/test_vsix.py`; the working tree was renormalised from the index |
| 29 | `runner.js` described any recognised lock refusal as "the lockfile this toolkit ships does not match the project file it ships beside it", which is false whenever the toolkit's own reader reads the pair as current — the case the fallback exists for | Reworded to name it as a lockfile disagreement and to say that the toolkit's own check decides which side disagrees + test updated |
| 30 | On Windows the probe skipped the executability check entirely, so a 0-byte `uv.exe` left by an interrupted installer was reported as a usable tool and would fail later as a spawn error | Fixed in `extension/hosttools.js` (an empty file is refused as `notExecutable`) + test |
| 31 | The 61-test adversarial reader suite was not part of `npm test`, so the reviewed gate did not run it | Fixed: `test/lockfile-adversarial.test.js` is now in the `test` script |


### Windows risks the review recorded and this host could not close

The Windows pass probed the reviewed process boundary against simulated Windows paths. These items were
confirmed as real behaviour of the code but could not be fixed and re-verified on a Windows host, so
they are recorded rather than claimed:

- A workspace root longer than about 94 characters leaves no headroom before the fixed 166-character
  tail (`.research-toolkit/managed/worker-0.3.7/.venv/Scripts/python.exe`) approaches `MAX_PATH`.
- A step timeout kills the direct child only; there is no process group, so a grandchild uv or python
  process can survive the timeout on Windows.
- `knownLocations("win32")` mixes `\`-joined paths with a literal `C:\Program Files\uv`, which is
  correct but inconsistent to read and easy to extend wrongly.
- The 13 behaviours the review listed as unprovable without a Windows host (spawn error shapes,
  `windowsHide` behaviour, reparse-point handling on junctions, drive-letter and UNC paths, the
  Extension Host receipt itself) remain unproven here.


## Third review round: adversarial pairs measured against real uv

An adversarial campaign built 69 synthetic `pyproject.toml` / `uv.lock` pairs, locked or checked each
one with real uv (`/tmp/uvs/uv-0.13.6 lock --check`, `sync --locked --dry-run --python 3.12`, and
`uv-0.5.0 sync --locked` for the declared floor), and recorded where each reader disagreed with uv.
`extension/test/lockfile-adversarial.test.js` keeps those pairs with uv's measured verdict, so the
divergence is now a test rather than an opinion: 67 rows agree with uv, 1 is a deliberate divergence
and 1 is a named gap. Every uv run happened in a temp copy, never in the repository tree.

| # | Finding (confirmed by probe) | Disposition |
|---|---|---|
| 32 | A `marker` added to, changed on, or removed from a requirement was invisible to the JS reader, although uv records it in its own `marker` key and refuses a lock whose marker no longer matches the manifest | Fixed in `extension/lockfile.js`: markers are parsed, normalised the way uv re-serialises them (`python_version >= "3.12"` → `python_full_version >= "3.12"`, `<= "3.13"` → `< "3.14"`, `== "3.13"` → `== "3.13.*"`, clause hoisting in conjunctions) and compared + 3 adversarial rows flipped to AGREES with uv's measured exit 1, plus a 18-spelling unit test |
| 33 | An extra that reuses an existing pin, and an extra declared as an empty list, were not compared | Fixed: `provides-extras` is canonicalised and required when the manifest declares an extra (its absence is forgiven only when the manifest declares none — uv 0.5.0 does not write the key) + 2 rows flipped, measured `lock --check` exit 1 / `sync --locked` exit 1 |
| 34 | `requires-python` dropped from the manifest, or the `requires-python` line deleted from the lock, was not reported | Fixed + 2 rows flipped (uv: exit 1 with a defaulting warning; exit 2 with "missing field `requires-python`") |
| 35 | A hand-edited transitive pin (entry version changed, artifact filenames left alone) was invisible: `dependencyPins` was computed and never consulted | Fixed: each lock entry's sdist/wheel filenames are parsed and cross-checked against the entry version + 2 rows (both directions) with uv's own cause recorded ("wheel `anyio-4.15.1-py3-none-any.whl` with inconsistent version") |
| 36 | A deleted `[[package]]` block, and a duplicated one, were not reported | Fixed: every resolved dependency edge must name exactly one non-root entry + 2 rows (uv exit 2, "has missing `source` field but has more than one matching package") |
| 37 | `[tool.uv] package = false`, and a removed `[build-system]`, change the source mode uv expects (editable vs virtual) and were invisible | Fixed: the package header's mode and source path are read and compared + 2 rows (uv exit 1 each) |
| 38 | Non-canonical extra names (`cli_tools`, `PDF`) produced false drift | Fixed: declared and recorded extras are canonicalised before comparison (uv writes `cli-tools`) + 2 rows flipped to AGREES |
| 39 | Triple-quoted requirements, `[project]` keys with leading whitespace, and a stray local entry before the root entry each broke the JS reader | Fixed (multi-line strings, whitespace-tolerant table and key matching, root entry selected by source path `.`) + 3 rows flipped to AGREES with uv exit 0 |
| 40 | `mcp(cli)==2.2.0` was reported as an unclosed array instead of as the requirement it is | Fixed: bracket matching counts parentheses + test; uv's own verdict on that pair is exit 2 from the build backend |
| 41 | A PEP 440 root version (`0.3.7.0` beside a lock recording `0.3.7`) was reported as drift | Fixed: root versions compared in normalised form + row flipped to AGREES (uv exit 0) |
| 42 | `STALENESS_REASONS` implied the toolkit could tell the exit-1 staleness classes apart from a malformed lock | Documented and hardened: uv prints the identical sentence for a marker change, a missing extra, a dropped `requires-python` and a version drift, so no signature separates them; the measured exit-2 parse signatures ("Failed to parse `uv.lock`", "inconsistent version", "has missing `source` field", "missing field", "malformed dependency groups") were added so a malformed lock is never classified as auto-repairable drift + test asserting `isLockDrift` is false for all three measured exit-2 refusals |
| 43 | The adversarial suite's own `dropArtifacts` helper matched nothing, so the "sdist and wheels lists removed" row had been asserting against a fixture that removed nothing | Fixed and re-measured: uv `lock --check` exit 0, reader clean |

| 44 | The two readers disagreed with each other on 2 of the 66 adversarial pairs — the PEP 735 `{ include = "dev" }` group and `dynamic = ["dependencies"]` are flagged by the JS reader and accepted by the Python reader, so `npm run package` and `python3 scripts/lockintegrity.py` would give different verdicts for the same pair | Fixed in both readers: `include-group` (what uv 0.13.6 accepts and flattens) flattens, `{ include = … }` (which uv 0.13.6 refuses outright and uv 0.5.0 locked as an empty group) is reported by both readers in the same words as a construct the reader cannot certify, and `dynamic = ["dependencies"]` / `dynamic = ["optional-dependencies"]` skip the manifest-half comparison in both, with the root entry's resolved dependencies checked instead. Re-measured over the same pairs: 0 verdict divergences, all three shipped pairs CLEAN in both readers |

One deliberate divergence is kept, with both uv verdicts recorded in the test rather than hidden:
`revision = 6` is read by uv 0.13.6 and 0.9.30 but refused by the toolkit as a support limit, now
worded as such. The two other divergences the campaign found were closed by the cross-reader round
below rather than left as characterisation rows.
One named gap remains: a lock whose dependency markers no longer cover the environments
`requires-python` allows is accepted by uv and not caught by either reader (adversarial UNCAUGHT row,
uv exit 1, "fork markers not covering the supported environments"). Closing it needs interval
arithmetic over uv's marker forks; an approximation would flag uv-accepted locks and block packaging.

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

1. A lock whose dependency markers no longer cover the environments `requires-python` allows is
   accepted by uv and missed by both readers (adversarial UNCAUGHT row). Closing it needs interval
   arithmetic over uv's marker forks; an approximation would refuse locks real uv accepts and block
   packaging.
2. `dynamic = ["dependencies"]` is filled in by a build backend, which a uv-free static reader cannot
   run. Both readers now skip the manifest-half comparison and check the root entry's resolved
   dependencies instead — the comparison uv's own `lock --check` makes. Drift inside the dynamic source
   file is invisible to uv itself (measured: changing `pypdf==6.4.1` to `==6.9.9` in `requirements.txt`
   leaves `lock --check` at exit 0).
3. `DRIFT_SIGNATURE` keeps a `--check` branch that shipped code never exercises. It is harmless today
   and would matter if a preflight pre-check ever ran `uv lock --check`.
4. The reference-host receipts (G1–G4) and the re-run of the reported field workspace are still open.

Closed in the third round: `[tool.uv]` resolution inputs are now read by both readers — the six keys
measured to change uv's resolution (`override-dependencies`, `constraint-dependencies`, `sources`,
`environments`, `required-environments`, `exclude-newer`) are reported as unmodelled inputs, while the
keys measured not to change it (`default-groups`, `index`, `default-index`, `find-links`,
`no-build-isolation-package`) are deliberately not flagged. A `dynamic = ["version"]` project is now
handled by both readers.
