# Methodology: how to develop a Windows-targeted VS Code extension on Linux

*Research deliverable, 4 November 2026. Applies to Research Stack Toolkit 0.3.8 and the next releases.*

---

## 1. The one idea that matters

You cannot test Windows on Linux. You can test **a model of Windows** on Linux, and the only way to keep
that model honest is to **name, out loud, which layer each test lives at** and to **buy real Windows
behaviour as data** whenever you can afford it.

Every claim in this project should carry one of five labels. The label is not decoration: it decides what a
release note may say and what a gate may be closed on.

| Label | What the test actually does | What it proves | What it must never be cited as |
|---|---|---|---|
| **SHAPE** | asserts the call form: argv array, `shell:false`, `windowsHide:true`, absolute paths | the code asks Windows to do the right thing | "verified on Windows" |
| **EMULATED** | forces a Windows-like condition inside a Linux process (`PYTHONIOENCODING=cp1252`, injected `platform:"win32"`, `ntpath`) | the failure mode and the recovery path work when the *mechanism* is reproduced | "Windows behaviour" |
| **FIXTURE** | replays data recorded once on a real Windows machine (stdout, stderr, `taskkill` transcript, env block, directory listing) | the parser/classifier handles the real Windows bytes | "the behaviour was executed here" |
| **WINDOWS-BACKED** | executed on a real Windows OS (hosted CI runner, VM) | Windows behaviour | "the user's machine" (no Defender policy, no mapped drives, Server 2025 ≠ Windows 11) |
| **FIELD** | executed on the user's machine, with a receipt | the shipping decision | anything automated |

The 0.3.7 → 0.3.8 fix is a good example of the discipline working: the tests added in 0.3.8 are labelled
**EMULATED** (a forced cp1252 child on Linux) and the release note says so; the field log from the user's
machine supplied the **FIELD** evidence; and the Windows-backed layer is still open (gates G1–G4).

## 2. The fidelity ladder

| Level | Available in this repo today | Cost | Proves |
|---|---|---|---|
| **L0** unit + shape tests with injected `{platform, run}` | yes — 336 Node tests | free | the call form |
| **L1** Linux-emulated Windows semantics | yes — `probes/codepage_probe.py`, forced-encoding children, `path.win32`/`ntpath` | free | the mechanism of the bug and the fix |
| **L2** recorded Windows fixtures replayed on Linux | **no** — nothing recorded yet | low (one CI job) | the parsers against real Windows bytes |
| **L3** the Windows-backed filesystem this host already has (`K:\` over 9p) | **yes** — measured, unused by the test suite | free | real NTFS case-insensitivity, real field paths |
| **L4** hosted Windows CI (`windows-latest`) | **no CI at all** | free on a public repo | real Windows process/env/encoding behaviour |
| **L5** the field host (the user's Windows 11 machine + VS Code) | open gates G1–G4 | human time | the shipping decision |

The gap is not L0–L1 — those are strong. The gap is **L2, L3 and L4, all three of which are nearly free and
none of which is used.**

## 3. Buy Windows behaviour as data (L2), the highest-leverage technique

A Linux-only developer's best tool is not an emulator, it is a **captured transcript**. Run something once on
real Windows, store the exact bytes in the repo, and let every Linux test assert against them forever.

What to capture, and what each capture unlocks:

| Capture (run on `windows-latest` once) | Store as | Unlocks a Linux test for |
|---|---|---|
| `python.exe -I -B -X utf8 -m research_stack.cli …` stdout+stderr, with a Czech workspace path | JSON with `stdout`, `stderr`, `exitCode`, `sys.stdout.encoding` | that the shipped flags really produce UTF-8 on a real cp1252 host, and that `classify()` reads the real error text |
| the same command **without** `-X utf8` | JSON | the exact `'charmap' codec can't encode character '\u010d' in position 67` string the 0.3.8 classifier must recognise — including its escaped form on stderr |
| `taskkill /PID <pid> /T /F` transcript + exit code, with a `uv` grandchild alive | text + exit code | `reapTree()`'s expected success/failure shapes |
| `process.env` dump from a VS Code extension host on Windows (mixed-case `Path`, `ComSpec`, `PATHEXT`, `APPDATA`) | JSON | `hosttools.js` discovery against a realistic env, and against the stripped-env case |
| `dir /s` of `.research-toolkit/` and of `%USERPROFILE%\.vscode\extensions\…` | text | path-depth budget arithmetic against real depths, not invented ones |
| `chcp` output on the runner's default console | text | what "the user's code page" actually is on a stock machine |

Store them under `evidence/windows-fixtures/<capture-id>.json` with `os`, `osBuild`, `vscodeVersion`,
`pythonVersion`, `nodeVersion`, `capturedAt`, and a `label: "WINDOWS-BACKED (recorded)"` field. A fixture
without provenance is just another made-up expectation.

## 4. Use the Windows filesystem you already have (L3)

This development host is WSL2 on the machine that reported the defect, and the repository is on `K:\` through
a 9p drvfs mount (see [03](03-this-host-wsl2-with-the-windows-drive.md)). Real NTFS name semantics are
therefore free: case-insensitive lookup, case-preserving names, non-ASCII paths, and the actual field
workspace. Gate those tests on the mount type (`fs.statfsSync(root).type === "v9fs"`) and skip them
elsewhere. What the mount does **not** give you: alternate data streams, reparse-point visibility, Windows
file locking, or any process semantics.

## 5. Get real Windows in CI (L4), and what to make it run

The single highest-value change available to this project is a `windows-latest` job that runs the existing
336 Node tests and the 219 Python tests. It converts a large fraction of **SHAPE** claims into
**WINDOWS-BACKED** claims at zero monetary cost on a public repository. Concrete shape in
[05-ci-playbook.md](05-ci-playbook.md); the four fidelity tricks that actually find bugs:

1. **Run the job from a path containing spaces and diacritics** — mirror the field root
   (`Bankovní účet SVJ ČSA368`). Microsoft's own vscode-python job does this on purpose.
2. **`PYTHONUTF8=1` in the job env** — CI captures stdout through a pipe, and on Windows a pipe means the
   ANSI code page. Note the subtlety: this affects *your test runs*, not the toolkit's own children, because
   the toolkit spawns with `-I`, which drops `PYTHONUTF8`.
3. **A short `--basetemp` for pytest** — `pytest-of-<user>/pytest-N/<long test name>` under `%TEMP%` is how a
   Windows-only `MAX_PATH` failure arrives in an otherwise green suite.
4. **Keep Windows blocking but bounded** — `fail-fast: false`, `timeout-minutes`, `tasklist /V` on
   `always()`, logs and crash dumps uploaded with `github.run_attempt` in the name. Skipping Windows
   (vscode-java, GitLens) is a known pattern; it is also how Windows defects reach users.

## 6. Emulation, used honestly

Emulation is legitimate when the **mechanism** is reproduced and the label says so. It is dishonest when it
reproduces the *symptom* while the mechanism differs.

| Legitimate here | Why | Not legitimate | Why |
|---|---|---|---|
| `PYTHONIOENCODING=cp1252` in a Python child on Linux | reproduces "stdout is cp1252/strict, stderr is cp1252/backslashreplace" exactly as a piped Windows child behaves | forcing a non-UTF-8 **locale** on Linux | mangles argv with `surrogateescape` first — a failure Windows does not have |
| `path.win32` / `ntpath` for parsing, `ntpath.normcase` for case folding | pure string semantics, OS-independent | `path.win32.resolve()` on Linux | resolves against the **POSIX** cwd, producing garbage; and `ntpath.normpath` mangles `\\?\` prefixes that Node preserves |
| injecting `{platform:"win32", run}` into `hosttools.js` | the module is designed for it | monkey-patching `os.platform` broadly | hides which branch is under test |
| a Windows-shaped env fixture (`Path`, `ComSpec`, `PATHEXT`, stripped) | matches the real block's mixed case | asserting `windowsHide` works | it is a no-op on Linux; only a Windows run can show the missing console window |
| `PureWindowsPath("CON.txt").is_reserved()` as a name oracle | CPython implements the Windows rule | `os.path.isreserved()` on Linux | does not exist there (added to `ntpath` in 3.14); `PurePath.is_reserved()` is removed in 3.15 |
| Wine 11.x for "does `python.exe`/`npm.cmd` start" | PATHEXT, `chcp.com`, drive letters are implemented | Wine for code-page bugs | Wine's default code page comes from the **Unix locale** (`WINEUNIXCP`, UTF-8 by default), so a default prefix tests UTF-8 behaviour while claiming to test cp1252 |

## 7. Per-release protocol

For every release, in this order:

1. **L0/L1 gate (blocking, already in place).** `npm test` + `pytest` + `verify-package` + `check:payload`.
   Receipt per gate, JSON, with host, versions, artifact sha256, timestamp.
2. **L4 gate (blocking once CI exists).** `windows-latest` Node + Python jobs; extension-host job on
   `stable` and `insiders`. A Windows job failure blocks the tag.
3. **L2 refresh (every 2–3 releases, or after any change to `runner.js`/`hosttools.js`/`steps.js`).** Re-run
   the capture job on Windows, diff the fixtures against the stored ones. A changed fixture is a Windows
   behaviour change and belongs in the release notes.
4. **L3 spot checks (free, run whenever paths or names change).** Case-collision and name-reservation
   probes on the `K:\` mount; MAX_PATH budget probe against the real field root.
5. **L5 gate (blocking for a release that changes Windows behaviour).** The reference host checklist
   (gates G1–G4): Windows 11 x64, VS Code stable, install the VSIX from a clean download, run setup, run a
   step with a non-ASCII path, kill a running step, read the setup log. No receipt → no release.
6. **Claims audit.** Read the release notes and check that every "fixed", "verified", "handles" maps to a
   labelled test or a receipt. This is the step that prevents the 0.3.7 class of mistake — a fix believed
   because it passed locally.

## 8. Next actions for this repository, ranked by value per unit of work

| # | Action | Ladder level | Effort | Why it pays |
|---|---|---|---|---|
| 1 | Add a `test-inventory` guard: every `test/*.test.js` must appear in `scripts.test` | L0 | 15 min | today a new test file silently never runs |
| 2 | Record `process.platform`, `process.arch`, `os.release()` in the setup log and in `status` | L5 support | 20 min | every future field report becomes classifiable without asking the user |
| 3 | `uv pip compile pyproject.toml --python-platform windows --python-version 3.12` as a CI step | L1 | 5 min | proves the universal `uv.lock` really resolves Windows wheels **from this Linux box** |
| 4 | Windows-shaped env fixtures in `hosttools` tests: mixed-case `Path`/`Temp`/`ComSpec`/`PATHEXT`, and a stripped env | L1 | 1 h | matches the two open VS Code defects where spawned envs lose `PATHEXT`/`APPDATA` |
| 5 | Static guard over generated names: reserved device names, illegal characters, trailing dot/space, case collisions (`ntpath.normcase`) | L1 | 1–2 h | Linux happily creates `CON`, `nul`, `aux`, `COM1`, `dir.`, `name ` — measured here |
| 6 | CRLF-tolerant JSONL reader test for the setup log | L1 | 30 min | `os.EOL` is `\r\n` on Windows; a `\n`-only reader leaves `\r` in every field |
| 7 | CI with `windows-latest` running the existing suites | **L4** | 2–3 h | converts most SHAPE claims into WINDOWS-BACKED claims, free on a public repo |
| 8 | A Windows **capture** job that writes fixtures to `evidence/windows-fixtures/` | **L2** | 3–4 h | the only way Linux tests can assert against real Windows bytes |
| 9 | ESLint flat config with `no-restricted-syntax` selectors: `shell:true`, `execFile` outside `runner.js`, `ensure_ascii=False`, hard-coded release strings, `path.join` on Windows-shaped literals | L0 | 2 h | replaces the current regex counts in `module-boundaries.test.js` with AST rules |
| 10 | CI checkout path with spaces **and** diacritics | L4 | 15 min | mirrors the field root that produced the 0.3.7 defect |
| 11 | `SOURCE_DATE_EPOCH` + `.sha256` sidecar in the packaging job | release hygiene | 15 min | makes the byte-identical rebuild routine instead of heroic |
| 12 | Switch publishing to `vsce publish --oidc` / `ovsx publish --trusted-publishing` | release hygiene | 1 h | **global Azure DevOps PATs are retired on 1 December 2026** |
| 13 | A `dockur/windows` container (needs `/dev/kvm`, so a VPS or the field machine) as the repeatable reference host | L5 | half a day | turns gates G1–G4 from "someone's laptop" into a reproducible host |
| 14 | Publish the 0.3.8 VSIX to the field host and close G1–G4 | **L5** | human time | **still open — 0.3.8 has not been installed on the machine that reported the defect** |

## 9. Runbook for a new field report

1. Check whether the reported workspace path is **reachable from this host** (`/mnt/k/…`). On a WSL2 host it
   usually is, and `.research-toolkit/logs/*.jsonl` is a complete, timestamped account of what the extension
   did — including the exact error string and cwd.
2. Classify the host before theorising: Windows-native extension host, or a remote/WSL host where
   `process.platform` is `linux`. (Today this requires asking the user; action 2 above removes that.)
3. Reproduce at the **lowest adequate ladder level**: L1 if the mechanism is encoding or parsing, L2 if a
   fixture is needed, L4 if it involves processes, env or the shell, L5 only if it involves the user's
   security software or their drive layout.
4. Fix at the lowest level that makes the failure impossible, then raise the label of the test that now
   covers it.

## 10. Anti-patterns to refuse

- Calling a passing Linux test "Windows-tested".
- Treating the 9p `K:\` mount as Windows rather than as Windows *names*.
- Using Wine with its default UTF-8 code page to "verify code-page behaviour".
- Using `ntpath` as an oracle for `\\?\`-namespaced paths (it mangles them; Node does not).
- Expecting `-X fileencoding`/`-X filesystemencoding` to emulate Windows (measured: no observable effect).
- Testing `windowsHide`, `PATHEXT`, `taskkill`, Defender, or Mark-of-the-Web on Linux and counting them as
  covered.
- Skipping the Windows CI leg because it is slow — the mature answer is a reduced but **blocking** Windows
  leg, not an absent one.
- Letting a fix ship on the strength of a local pass. The 0.3.7 defect was exactly this: the operation
  succeeded, the report failed, and nothing on Linux could see the difference.
