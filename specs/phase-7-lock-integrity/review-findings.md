# Phase 7 review findings and disposition

An independent read-only review of the 0.3.7 lock-integrity fix reproduced 21 defects in its first pass
(rows 1–21) by running both dependency readers against synthetic pairs. They are recorded here with what was done about each one,
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
| 28 | The 0.3.7 artifact was not reproducible from the tag: 17 packaged members (16 of the 32 guides and `extension/media/toolkit.svg`) carried CRLF in the VSIX while the committed tree holds LF, so a clean-clone build produced a different digest (301,300 bytes against 301,366) | Fixed: `extension/scripts/package.js` normalises the staged tree to LF before packaging, `scripts/verify_vsix.py` refuses CRLF in any packaged text member and compares payload bytes line-ending-normalised + 3 tests in `tests/test_vsix.py`; the working tree was renormalised from the index |
| 29 | `runner.js` described any recognised lock refusal as "the lockfile this toolkit ships does not match the project file it ships beside it", which is false whenever the toolkit's own reader reads the pair as current — the case the fallback exists for | Reworded to name it as a lockfile disagreement and to say that the toolkit's own check decides which side disagrees + test updated |
| 30 | On Windows the probe skipped the executability check entirely, so a 0-byte `uv.exe` left by an interrupted installer was reported as a usable tool and would fail later as a spawn error | Fixed in `extension/hosttools.js` (an empty file is refused as `notExecutable`) + test |
| 31 | The 61-test adversarial reader suite was not part of `npm test`, so the reviewed gate did not run it | Fixed: `test/lockfile-adversarial.test.js` is now in the `test` script |


### Windows risks the review recorded and this host could not close

The Windows pass probed the reviewed process boundary against simulated Windows paths. These items were
confirmed as real behaviour of the code but could not be fixed and re-verified on a Windows host, so
they are recorded rather than claimed:

- Path length was re-measured in UTF-16 units, which is what `MAX_PATH` counts: the toolkit appends
  `.research-toolkit\managed\worker-0.3.7` (38 characters, 39 with the separator) and the artifact the
  step verifies adds `.venv\Scripts\python.exe` (25 more) — 64 characters appended in total, so a
  workspace root may run to 196 characters before 260. The reported field root is 45 characters, putting
  its worker python at 109 with 151 characters of headroom. What is NOT safe is uv's own trees: the
  deepest path already created in that workspace by a managed install measured 200 characters, and
  crossing 260 needs the Windows long-path opt-in (registry `LongPathsEnabled` plus a `longPathAware`
  manifest), which Node does not request by itself.
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

| 44 | The two readers disagreed with each other on 2 of the 69 adversarial pairs — the PEP 735 `{ include = "dev" }` group and `dynamic = ["dependencies"]` are flagged by the JS reader and accepted by the Python reader, so `npm run package` and `python3 scripts/lockintegrity.py` would give different verdicts for the same pair | Fixed in both readers: `include-group` (what uv 0.13.6 accepts and flattens) flattens, `{ include = … }` (which uv 0.13.6 refuses outright and uv 0.5.0 locked as an empty group) is reported by both readers in the same words as a construct the reader cannot certify, and `dynamic = ["dependencies"]` / `dynamic = ["optional-dependencies"]` skip the manifest-half comparison in both, with the root entry's resolved dependencies checked instead. Re-measured over the same pairs: 0 verdict divergences, all three shipped pairs CLEAN in both readers |

One deliberate divergence is kept, with both uv verdicts recorded in the test rather than hidden:
`revision = 6` is read by uv 0.13.6 and 0.9.30 but refused by the toolkit as a support limit, now
worded as such. The two other divergences the campaign found were closed by the cross-reader round
below rather than left as characterisation rows.
One named gap remains: a lock whose dependency markers no longer cover the environments
`requires-python` allows is accepted by uv and not caught by either reader (adversarial UNCAUGHT row,
uv exit 1, "fork markers not covering the supported environments"). Closing it needs interval
arithmetic over uv's marker forks; an approximation would flag uv-accepted locks and block packaging.

## Round five — a thorough test of the re-cut release, then the fixes it asked for

Four test tracks were run against the re-cut artifact and its code, and every confirmed defect was
fixed and re-verified. Track receipts: `/tmp/e2e-037/receipts/` (54 files, indexed by its README),
`/tmp/win-037/` (probe1–probe7 plus a README), `/tmp/adv-037/` (69 new pairs, `verdicts.json`,
`pairs/`, `gate-demo/`), `/tmp/docs-037/` (`audit-notes.md`, `commands.sh`, `clone1/`,
`cross-reader-comparison.json`). End-to-end receipts for the fixed reporting are
`/tmp/e2e-037/receipts/22a-round5-broken-worker.json`, `22b-round5-fallback-success.json`,
`22c-round5-fallback-failed.json`.

What the tracks proved about the release itself:

- The reporting workspace is mounted on this host and was inspected read-only. Its managed worker tree
  holds `pyproject.toml` at 0.3.6 beside a `uv.lock` whose root entry records 0.3.4; both readers flag
  that exact pair. uv 0.11.23 — the version the reporting host ran — refuses it with exit 1 and the same
  `Resolved 40 packages in 513ms` line the field record quotes, and installs the shipped 0.3.7 worker and
  notebook pairs with exit 0 (`evidence/quality-v0.3.7-2026-11-02/field-workspace.txt`).
- The packaged pairs, not the repository copies, install with exit 0 on uv 0.5.0, 0.6.10, 0.7.22, 0.8.5,
  0.9.30, 0.10.7, 0.11.23 and 0.13.6 (`packaged-uv-matrix.txt`).
- A full install driven through the unpacked VSIX code completes in a workspace whose path contains spaces
  and Czech diacritics; the worker and notebook environments stay separate; a disagreeing pair is refused
  with no lockfile written; mixed-case host `UV_*` variables reach neither uv nor the child environment
  twice; a 0-byte uv is refused; a step that installed through the lockfile fallback is not reported as a
  clean install.
- A clean clone of the tag builds the shipped artifact byte-for-byte, twice, seconds apart.

| # | Finding | Disposition |
|---|---|---|
| 45 | A failed `--frozen` fallback told the operator the packages had been installed: the failure sentence interpolated `fallbackError.hint`, which is always the success hint, so the intended "check the host tool version and network access" advice was unreachable (`runtime.js`, `steps.js`) | Fixed + tests (`test/runtime.test.js`, `test/steps.test.js`); re-measured end to end — the recorded error now ends "The shipped lockfile was not rewritten. Check the host tool version and network access, then retry setup." |
| 46 | The combined fallback error carried no `hint` and no `cwd`, so the next-action table answered "Retry this step" to a captured host failure and the recorded command line lost its working directory | Fixed + tests; the recorded command line carries `(in "<cwd>")` and the pasteable instruction carries a real `cd` line |
| 47 | `status.js` counted a step whose recorded status is `failed` in the "installed through a lockfile fallback" headline and step row | Fixed + 3 tests: `fallbackState()` answers "installed" only for installed/skipped/repaired; a failed fallback now reads "1 step(s) attempted the reviewed lockfile fallback and did not install" and the row reads "lockfile fallback attempted, step not installed" |
| 48 | The notebook build-defect refusal set `lockDrift` but no `kind`/`hint`, so it got retry wording while the worker equivalent named a reinstall | Fixed + test: `kind: "lock-drift"`, `exitCode: null`, `attempts: 0`, the same reinstall sentence as the worker refusal |
| 49 | A workspace's own `notebooks/analysis` project, preserved by the overlay step, was described as "the project this toolkit wrote … a defect in the toolkit build" | Fixed + test: the refusal branches on the preserved files, names them, and answers "restore it from this toolkit's overlay files or remove the folder and re-run the step"; the operator's file hashes are asserted unchanged |
| 50 | Attempt counts were wrong at both ends: `attempts 1` recorded where no process ran (`error.attempts \|\| 1` turns 0 into 1), and `attempts 1` recorded where two uv processes ran | Fixed + tests at both ends: `runWorkerStep`/`runNotebookStep`/`setupRuntime` publish `attempts` (1 clean locked, 2 when the gated fallback ran); `runAttempts()` preserves 0; a refusal where nothing ran reads "no process ran" |
| 51 | The re-run command an operator is told to paste ended with prose after the command, which cmd and PowerShell parse as a command block, and quoting fired only on whitespace, so a path containing `&` was emitted bare | Fixed + tests: `commandLine()` stays the single-line data form; `rerunInstruction()` is a separate pasteable form with `cd "<cwd>"` and every argument quoted by CommandLineToArgvW rules (spaces, `&`, embedded `"`, trailing `\`, the Czech field path, POSIX form, and an argument containing a newline) |
| 52 | The 0-byte-tool check was win32-only: on Linux a 0-byte mode-0755 uv spawned, exited 0 silently and was reported `usable: true` | Fixed + 2 tests: refused on every platform as "an empty file (0 bytes), which cannot be a tool", never spawned, and a 0-byte file earlier in PATH no longer masks a usable uv later in PATH. Measured: a directory and a mode-000 file were already refused |
| 53 | `npm run verify-package` died with a raw `spawnSync uv ENOENT` stack trace when uv is not on PATH | Fixed + test: exit 1 with the attempted command, what the gate needs, why a working `researchStack.uvPath` does not help this shell, and how to put uv on PATH; the uv-present path is unchanged (a shim exiting 3 still passes its status through) |
| 54 | Workspace roots were compared unresolved while tool candidates were realpath-resolved, so a workspace-local uv reached through a link was spawned instead of refused | Fixed + test (symlink variant measured here; junction and mapped-drive variants are code-reading cases — no NTFS reparse points on this host) |
| 55 | PATH dedupe was case-sensitive, quoted PATH entries were joined into candidates and silently skipped, and the win32 known-locations list was built with `path.join` so it was not testable on a POSIX host | Fixed + 2 tests: entries de-quoted and probed, dedupe case-folded on win32 only, list built with `path.win32.join` (all 7 entries win32-absolute and normalize-stable) |
| 56 | HIGH: no process-tree kill — a timeout or a cancel killed the direct child only, and a uv/python grandchild kept writing into the managed step directory 1.6 s after the step was reported failed, while `.setup.lock` was released | Fixed + tests. Measured with the reviewer's own probe: grandchild marker 1.6 s after the RunError **no** (was yes); cancelled-run grandchild wrote its file anyway **no** (was yes); `kind=timeout … reaped=true target=process group` after 413 ms. Windows uses `taskkill.exe /PID <pid> /T /F` while the root is alive, with a backstop `child.kill()`; the win32 branch is a labelled shape test, not Windows proof |
| 57 | gates.md claimed "no `uv lock` inside a managed runtime" with no test and no verifier behind it | Fixed: the boundary refuses a `lock` subcommand and a `sync` carrying neither `--locked` nor `--frozen`, before starting anything (`kind: "policy"`, `attempts: 0`), with 2 no-spawn tests that a real executable named `uv` proves by the absence of its marker file. Measured on this host: `uv lock --check` refused, plain `uv sync` refused, `uv sync --locked` runs (exit 0, attempts 1). Consequence recorded: a future read-only `uv lock --check` diagnostic would need a reviewed exception |
| 58 | Both readers refused a requirement whose bounds are written in the other order (`pypdf<7,>=6.4` beside the `>=6.4,<7` uv itself writes), and the same for `requires-python`; uv accepts those pairs, and `scripts/build_worker_bundle.py` would have refused to build the release | Fixed in both readers: bounds compared as sets of parsed bounds + adversarial rows |
| 59 | Both readers certified clean a lock with a deleted or duplicated transitive-only `[[package]]` block (uv exit 2 "Failed to parse `uv.lock`") — each reader checked only the root entry's edges | Fixed in both readers: every `[[package]]` entry is cross-checked, not only the root's + rows |
| 60 | Missed by both readers: lock header `version = 2`; `sdist = [ … ]` written as a list; a registry entry rewritten to `source = { editable = "vendor/pypdf" }`; `[manifest]` override entries with no `override-dependencies` in the manifest; `resolution-markers` that cannot intersect the declared `requires-python`; `provides-extras` removed from a dynamic-optional lock | Fixed / recorded with the measured uv verdict for each |
| 61 | False alarms in both readers: `override-dependencies`, `constraint-dependencies`, `required-environments` beside the lock uv wrote for them (uv exit 0 on all seven); `dynamic = ["optional-dependencies"]` with `provides-extras`; sdist filename/version disagreement; `source = { editable = "./" }`; a leading `v` in a version | Fixed in both readers: accepted where uv accepts, with the accepted shape named in the reader comment |
| 62 | The JS reader had no TOML validity pass (duplicate `[tool.uv]`, duplicate `version`, duplicate key in a lock entry, two root entries, `revision = 5.0`) and stripped version epoch and local parts (`1!0.3.7`, `0.3.7+local` read as equal to `0.3.7`) | Fixed + rows |
| 63 | The Python reader skipped a `[[package]]` entry with no `version` key, preferred a stale `filename` key over `url`, demanded an entry for a requirement no marker can select, counted a requirement listed twice, and skipped `~=`/`in` marker atoms the JS reader catches | Fixed in both readers |
| 64 | `scripts/lockintegrity.py` documented a `[root]` argument and ignored it (`__main__` called `main()` with no argv) | Fixed + test |
| 65 | Floor divergence recorded wrongly: a UTF-8 BOM on the worker `pyproject.toml` is read by uv 0.9.30 and 0.13.6 but refused by uv 0.5.0 — the declared floor — while both readers strip it; the suite row had been measured on 0.13.6 only | Re-measured per uv version and corrected |
| 66 | A reader bug found while fixing the above: the new marker-coverage rule flagged the **shipped** worker pair (`requires-python = ">=3.12,<3.15"` with markers `>= '3.14'` and `< '3.14'`, which partition the range) and would have blocked packaging | Fixed: a marker set that partitions the declared range is accepted; the rule keeps refusing markers that cannot intersect the range or that leave a sub-range uncovered. `uv 0.13.6 lock --check` and `uv sync --locked` exit 0 on the shipped pair, and both readers read it CLEAN |
| 67 | The capability audit in `scripts/verify_vsix.py` read `MINOR_POINT.exec(text)` — a RegExp read in `extension/lockfile.js` — as an unreviewed process capability, so 11 of its own tests aborted before the boundary checks ran | Fixed + 3 tests: an unqualified `exec(`/`execFile(`/`spawn(`/`Sync` form is still refused, a method call on an object is not, and the reviewed file additionally refuses `execSync`, `spawnSync`, `forkSync`, `.exec(` and `.fork(` outright, because a synchronous run keeps the call-site counts intact and would pass a count-only audit |
| 68 | `nextActionFor()` had no branch for the new `kind: "policy"` refusal, so a refusal raised by the toolkit's own gate fell through to "Retry this step" | Fixed + test: answered as a build defect ("this toolkit build asked uv to do something its reviewed policy refuses. Reinstall the VSIX from this release."), with the five other failure classes asserted to keep their own answers |
| 69 | The documented "how to reproduce" commands overwrite the recorded evidence: `run_uv_matrix.py` and `run_lock_provenance.py` write their JSON into the evidence folder, and following the README's own line modified two tracked receipts and created a third file that a later `git checkout --` plus `rm -f` destroyed | Fixed: both take `--out` (creating the parent directory); the evidence README and gates.md say so |
| 70 | MAX_PATH claim in the review record was wrong: the fixed tail quoted as 166 characters is 63 (64 appended with the separator), and the derived 94-character root budget was unsupported | Corrected with measured UTF-16 arithmetic: 64 appended, 196-character root budget, field root 45, worker python at 109, deepest uv-created path in the field workspace 200 |
| 71 | `acceptance.md` said "the 40 package pins unchanged" (39 third-party pins are unchanged; the 40th entry is the root, which is the one that changed) and still recorded the T7-13 failed-fallback gap as untested after it had been closed | Corrected |
| 72 | "does not connect to external providers" overstated a release whose Research overlay presets call literature services when a tool is invoked | Reworded to what setup actually does: setup reaches nothing beyond PyPI through the host's uv |
| 73 | The 0.3.7 reproducibility fixes (`SOURCE_DATE_EPOCH` stamping, staged-mode normalisation, the two new `tests/test_vsix.py` tests) were undocumented in the CHANGELOG, the implementation report and the evidence folder | Documented |

### Windows risks recorded in this round, not claimed as fixed

The Windows track ran on a Linux host. These are recorded with what was measured and what was only read:

- **Fixed and pinned by a test, Windows mechanism unobserved:** the case-insensitive `UV_*` scrub and the
  `PYTHONPATH`/`PYTHONHOME` scrub (both measured against a real uv build on this host), the 0-byte tool
  refusal, the quoted re-run instruction and the `chcp 65001` note, the win32 documented-location list
  built with `path.win32.join`, case-folded PATH dedupe, and the `taskkill /PID <pid> /T /F` call shape.
- **Recorded, not fixed:** four win32 install locations the resolver does not look in; `fs.access(W_OK)`
  answering "accepts writes" where an ACL denies them; a junction inside the managed worker `.venv` path;
  case-sensitive reparse-point comparison in the workspace-root check; a Czech path pasted into a non-UTF-8
  code page; a UTF-16LE `pyproject.toml` misdiagnosed as a malformed manifest; an uncaught rejection from
  `runPreflight` when the workspace is a OneDrive placeholder; the uv cache and the managed CPython living
  outside the workspace; case-sensitive `worker-x.y.z` discovery; `pidAlive` treating EPERM as "alive".
- **Two limits of the reap itself, on either platform:** `taskkill /T` snapshots the tree and needs a live
  root, so a child that dies just before the bound or a grandchild created after the snapshot escapes —
  now visible as `reaped: false` plus `reapReason` instead of being silent; and `kill(-pid)` reaches only
  the child's own process group, so a grandchild that detaches into its own group escapes both reapers.
  Measured here: real uv 0.13.6 build children stay inside uv's group, so the group kill reaches them.

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

1. **Closed in the fifth round.** A lock whose `resolution-markers` no longer cover the environments
   `requires-python` allows was accepted by uv and missed by both readers. Both readers now model the
   marker forks as `major.minor` intervals: a marker set that partitions the declared range covers it, a
   set that leaves a sub-range with no fork, or whose markers cannot intersect the declared range at all,
   does not. Measured in both directions — the shipped partition reads clean in both readers (uv 0.13.6
   wrote it, `lock --check` exit 0), dropping one marker is refused (uv 0.13.6 exit 1), and a marker outside
   the declared range is refused (exit 2 on 0.6.10/0.7.22, exit 1 on 0.8.5–0.13.6). The first attempt at
   this rule was itself a defect: its interval merge collapsed the shipped partition into a hole and would
   have blocked packaging (row 66).
2. **New named gap: pair P32.** A `requires-dist` entry that names a registry distribution while every
   `[[package]]` entry of that name in the lock is a local (editable) source — uv refuses it (exit 2 on all
   seven uv binaries) and neither reader reports it. It is the only remaining uv-refuses/readers-clean class
   in the pair set. The model is designed (compare the requirement's registry/local shape against the shape
   of the entries it resolves to) but not implemented on either side.
3. `dynamic = ["dependencies"]` is filled in by a build backend, which a uv-free static reader cannot
   run. Both readers now skip the manifest-half comparison and check the root entry's resolved
   dependencies instead — the comparison uv's own `lock --check` makes. Drift inside the dynamic source
   file is invisible to uv itself (measured: changing `pypdf==6.4.1` to `==6.9.9` in `requirements.txt`
   leaves `lock --check` at exit 0).
4. `DRIFT_SIGNATURE` keeps a `--check` branch that shipped code never exercises. It can no longer be
   reached by a future preflight pre-check either: since the fifth round the boundary refuses any
   `uv lock …`, `uv lock --check` included, before a process exists, so a read-only lock diagnostic would
   need a reviewed exception.
5. `scripts/lockintegrity.py <foreign-root>` correctly exits 1 and names the pair it was pointed at, but
   also prints `missing pair:` lines for the repository's three standard pairs. Honest for a VSIX audit and
   never masking a finding; recorded as a wart rather than changed inside a release round.
6. The reference-host receipts (G1–G4) and the re-run of the reported field workspace are still open, as
   are the Windows-only behaviours listed under "Windows risks recorded in this round" above.

Closed in the third round: `[tool.uv]` resolution inputs are now read by both readers — the six keys
measured to change uv's resolution (`override-dependencies`, `constraint-dependencies`, `sources`,
`environments`, `required-environments`, `exclude-newer`) are reported as unmodelled inputs, while the
keys measured not to change it (`default-groups`, `index`, `default-index`, `find-links`,
`no-build-isolation-package`) are deliberately not flagged. A `dynamic = ["version"]` project is now
handled by both readers.
