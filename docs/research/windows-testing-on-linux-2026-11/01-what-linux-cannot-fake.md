# 01 · What Linux cannot fake, and what it can

Everything in this file was measured on the development host used for the Research Stack Toolkit
(Debian GNU/Linux 13 "trixie", x86_64, Python 3.12.16, Node 22, uv 0.13.6 pinned at `/tmp/uvs/uv-0.13.6`)
on 4 November 2026. Commands and raw output are in [probes/measured-output.txt](probes/measured-output.txt).

The point of this file is to stop the team from spending effort reproducing things Linux reproduces
faithfully, and to concentrate it on the four things Linux gets wrong.

---

## 1. The encoding failure class: two independent differences, not one

The 0.3.8 field defect was a Windows console code page (`cp1252`) meeting a Czech workspace path. It is
tempting to describe it as "Windows uses a code page". That is only half of it, and the missing half is
why the defect survived 200+ green tests.

Measured on this host, with the toolkit's own interpreter:

| Setting | `locale.getpreferredencoding(False)` | `sys.stdout.encoding` | `sys.stdout.errors` | `sys.stderr.errors` |
|---|---|---|---|---|
| default (this host) | `utf-8` | `utf-8` | **`surrogateescape`** | `backslashreplace` |
| `LC_ALL=C` | `utf-8` | `utf-8` | `surrogateescape` | `backslashreplace` |
| `LC_ALL=C.utf8` | `UTF-8` | `utf-8` | `surrogateescape` | `backslashreplace` |
| `PYTHONIOENCODING=cp1252` | **`utf-8`** | `cp1252` | `strict` | — |

On Windows the defaults are different in **two** ways:

1. `sys.stdout.encoding` comes from the console code page (`GetConsoleOutputCP`), typically `cp1252` for an
   English locale, `cp850`/`cp852` for others — not from a UTF-8 locale.
2. `sys.stdout.errors` is **`strict`**, not `surrogateescape`. POSIX gives `surrogateescape`, which is a
   permissive handler: it never raises for ordinary characters because the encoding is already UTF-8.

So a Linux test that only forces the *encoding* is already closer to Windows than the default, but the
faithful fixture forces **both**:

```python
sys.stdout.reconfigure(encoding="cp1252", errors="strict")
sys.stderr.reconfigure(encoding="cp1252", errors="strict")
```

`errors="surrogateescape"` still raises for `č` (the handler only rescues lone surrogates), which is why
the 0.3.8 reproduction works — but a character that *is* encodable in the target code page and *is* a
surrogate case would behave differently. Force `strict` and the fixture stops depending on that subtlety.

**Recommendation R-1.** Every code-page fixture in this repository sets `encoding` **and** `errors`.
`tests/test_stdio.py` currently forces the encoding only; the next round should add `errors="strict"`.

## 2. `PYTHONIOENCODING` does not change the locale — and `-I` deletes it

Measured: `PYTHONIOENCODING=cp1252` changes `sys.stdout.encoding` but leaves
`locale.getpreferredencoding(False)` at `utf-8`. On Windows that call returns `cp1252`. Consequences:

- Code that opens files with the **default** encoding (`open(path)` — PEP 597 made the default
  `encoding="locale"` explicit) reads a different codec on Windows than on Linux, and no environment
  variable you can set on Linux will make that match.
- Code that writes to **stdio** can be forced on Linux with `PYTHONIOENCODING`, but under `-I` (isolated
  mode) CPython ignores all `PYTHON*` environment variables: the docs state that `-I` "also implies `-E`
  and `-s`" ([docs.python.org/3/using/cmdline.html](https://docs.python.org/3/using/cmdline.html)).
  Measured for this repository: `PYTHONIOENCODING=cp1252 python -I -B -c …` reports `utf-8`.

This host has **no non-UTF-8 locale installed** (`locale -a` returns only `C`, `C.utf8`, `POSIX`), so the
"real" way to make the locale report a code page is not available without generating one
(`locale-gen en_US.ISO-8859-1`, which needs `locales` and root). Even then, a Linux locale is not the
Windows console: Windows' code page is a property of the *console*, changes with `chcp`, and differs
between input and output (`GetConsoleCP` vs `GetConsoleOutputCP`).

**Recommendation R-2.** Do not try to emulate the locale. Force the stream, and test the *default*
encoding path separately by passing `encoding=` explicitly in the code under test — which is what the
toolkit's Python package should do anyway.

## 3. Case-insensitivity is not a string property; it is a filesystem property

Measured: `mkdir $T/store` and `mkdir $T/STORE` both succeed on this host. On NTFS they are the same
directory, and the second `mkdir` fails or silently merges.

Node's `path.win32` is genuinely useful here and works on Linux:

```
p.win32.normalize("C:\\Users\\uživatel\\.research-toolkit\\store\\research.sqlite3")
  → C:\Users\uživatel\.research-toolkit\store\research.sqlite3
p.win32.isAbsolute("/data/x")            → true      (POSIX would say true too; win32 also accepts it)
p.win32.parse("k:\\Soukromé_aktivity\\Bankovní účet SVJ ČSA368").root → "k:\\"
p.win32.normalize("K:\\A").toLowerCase() === p.win32.normalize("k:\\a").toLowerCase() → true
```

What `path.win32` gives you is **parsing** fidelity (separators, drive roots, `..` folding, `delimiters`).
What it cannot give you is **lookup** fidelity: it will not tell you that `Store/` and `store/` collide,
because the collision happens in the filesystem, not in the string.

**Recommendation R-3.** Two separate guards:
- parse Windows-shaped paths with `path.win32` in unit tests on Linux (cheap, faithful);
- detect case collisions statically — for every path the toolkit creates or deletes, compare the
  lower-cased Windows-normalised form against every other path it owns, and fail the test if two differ
  only by case. This is a test, not an emulation, and it is the only way to see the class on Linux.

## 4. Path length: measurable without Windows

`MAX_PATH` is 260 characters; extended-length paths need the `\\?\` prefix and, for the modern
long-path behaviour, both a registry value (`LongPathsEnabled`) and an application manifest
([Microsoft Learn](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation)).
Node and Electron are not manifest-declared long-path-aware by default, so a toolkit that writes a deep
managed runtime tree can hit 260 on a machine where Linux would happily go to 4096.

Measured budget for the toolkit's own paths (see [probes/path_budget.py](probes/path_budget.py)):

```
 101 chars  fits 260  C:\Users\uživatel\.research-toolkit\managed\worker-0.3.8\Lib\site-packages\research_stack\__init__.py
  87 chars  fits 260  C:\Users\Bankovní účet SVJ ČSA368\.research-toolkit\managed\worker-0.3.8\Scripts\uv.exe
  86 chars  fits 260  C:\Users\very.long.department.name-012345123456789\.research-toolkit\store\research.sqlite3
```

The headroom is real but not large: a user profile name of 60 characters plus a deep virtual-environment
tree consumes most of it. **Recommendation R-4.** Keep the probe in the repository and run it in CI with a
deliberately long synthetic root; assert the worst case stays under 260, or make the toolkit emit `\\?\`
prefixed paths where it is legal.

## 5. Process trees: the one thing you must not reason about from Linux

Linux gives you process groups, `kill(-pid, SIGKILL)`, and a signal model. Windows gives you none of
those. `taskkill /PID <pid> /T /F` walks the current tree once (`/T`), and a child that dies just before
the walk, or a grandchild that creates its own group afterwards, escapes
([taskkill docs](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)).
Job objects are the mechanism that actually bounds a tree, and Node does not create one for you.

This is not emulatable on Linux at all. What you can do:

- **Contract tests**: assert the exact call form (which binary, which argv, which options) — the toolkit
  already does this in `extension/test/runner.test.js`.
- **Recorded-replay tests**: capture the real Windows output once (a sentence, a process list, an exit
  code) and replay it as a fixture, labelled as a replay.
- **A real Windows run** for the one behaviour that matters (does the tree die?) — hosted CI or a VM.

**Recommendation R-5.** Never describe a Linux shape test as proof of Windows behaviour. Label it in the
test name and in the release record. The 0.3.7 record already does this ("labelled win32 shape tests, not
proof"); keep doing it, and make the label machine-visible (a test-name prefix like `win32-shape:`) so a
gate can count how much of the Windows surface is actually observed.

## 6. What Linux *does* reproduce well

Do not over-emulate these; they are faithful already:

- **UTF-8 text handling** in Node and Python when the streams are UTF-8 — the toolkit's normal case.
- **`path.win32` parsing**, `path.delimiter`/`path.sep` per-platform logic, and any pure string logic
  behind a platform seam.
- **JSON/IPC contracts** between the Node boundary and the Python worker — byte-level, platform-neutral.
- **Lockfile and manifest semantics** (uv's behaviour is the same on Linux and Windows; the 0.3.7 matrix
  proved it across seven uv versions).
- **Extension API behaviour** in the Extension Development Host — `@vscode/test-electron` /
  `@vscode/test-cli` run a real VS Code on Linux, so the API surface is real; only the OS underneath is
  different.
