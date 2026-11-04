# 03 · The host we already have: WSL2 with the Windows drive mounted

This is the most useful thing this research found, and it applies to this project specifically. It was
measured on 4 November 2026 in the same session that produced 0.3.8.

## What the environment actually is

```
$ cat /proc/version
Linux version 6.18.33.1-microsoft-standard-WSL2 …        # a WSL2 kernel

$ mount | grep 9p
K:\ on /data/dsh/home/…/Research-Stack type 9p (rw,…,aname=drvfs;path=K:\;metadata;symlinkroot=/mnt/host/,…)
K:\ on /mnt/k/Soukromé_aktivity      type 9p (rw,…,aname=drvfs;path=K:\,…)

$ stat -f -c "%T" …/Research-Stack   → v9fs        (Windows NTFS behind a 9p drvfs translation layer)
$ stat -f -c "%T" /data/dsh          → ext2/ext3   (the Linux side)
$ stat -f -c "%T" /tmp               → overlayfs
```

So: **the toolkit repository itself lives on the Windows filesystem of the machine that reported the
0.3.7 defect.** The Linux side is a container on top of WSL2; the project tree is a Windows drive.

## What that gives you, for free

### a) Real NTFS name semantics

```
$ F="…/.research-toolkit/store/research.sqlite3"
$ stat "$(dirname "$F")/RESEARCH.SQLITE3"   → 77824 bytes
$ stat "$(dirname "$F")/research.Sqlite3"   → 77824 bytes     # same file
$ stat /data/dsh/HOME                       → No such file or directory   # ext4 side is case-sensitive
```

Case-insensitive lookup, case-preserving names, and a case-insensitive *namespace* — the real thing, not an
emulation. `ext4 casefold` (`mke2fs -O casefold`, `chattr +F`) is not available here anyway: `chattr`,
`lsattr` and `mke2fs` are not installed.

**Recommendation.** Put the case-collision tests in a directory on the Windows-backed mount and skip them
elsewhere:

```js
const windowsBacked = fs.statfsSync(workspaceRoot).type === "v9fs";   // or a probe of the mount
if (!windowsBacked) return t.skip("needs the Windows-backed workspace mount");
```

Be honest about the limits: 9p drvfs reproduces **name lookup**, not Windows as a whole. Alternate data
streams are not surfaced (`os.listxattr()` on the mount returns `[]`), reparse points/junctions are not
visible as such, and file *locking* semantics (`ERROR_SHARING_VIOLATION`) are not the Windows ones.

### b) The field evidence of the defect you are fixing

The reported workspace is reachable read-only from this session:

```
/mnt/k/Soukromé_aktivity/Bankovní účet SVJ ČSA368/.research-toolkit/
├── lab-state.json
├── managed/active.json          → "version": "0.3.7", "folder": "K:\\Soukromé_aktivity\\…\\worker-0.3.7",
│                                   "activatedAt": "2026-11-04T05:57:58.063Z", "reason": "verified-setup"
├── logs/setup-20261104T055831Z.jsonl
└── store/research.sqlite3       → 77 824 bytes, mtime 2026-11-04 05:58
```

and the attempt log for the failing step is the record the user pasted:

```json
{"kind":"step","stepId":"lab-store","status":"failed","exitCode":2,"durationMs":1678,
 "error":"python.exe -I failed with exit code 2: {\"error\": \"'charmap' codec can't encode character '\\u010d' in position 67: …\"} (cwd k:\\Soukromé_aktivity\\Bankovní účet SVJ ČSA368)",
 "at":"2026-11-04T05:58:31.489Z"}
```

**The store file exists, timestamped in the same minute as the failed step.** That is direct field proof of
the 0.3.8 root cause — the operation completed, the report failed — obtained without touching a Windows
shell. It also proves the 0.3.7 lock fix worked in the field (`active.json`: worker-0.3.7 activated,
`reason: verified-setup`).

**Recommendation.** When a field report names a workspace path, check whether that path is reachable from
the development host before theorising. On a WSL2 host it usually is, and the toolkit's own
`.research-toolkit/logs/*.jsonl` is a complete, timestamped account of what the extension did.

### c) Windows wrapper shims, already in the tree

`extension/node_modules/.bin/` contains `vsce.cmd`, `vsce.ps1`, `marked.cmd`, `semver.cmd`, `is-docker.cmd`
— the Windows shims npm creates. They are visible from Linux and are a ready-made fixture population for
any test that must *refuse* to launch a `.cmd` (the toolkit's `hosttools.js` behaviour).

## What it does not give you

```
$ command -v cmd.exe powershell.exe tasklist.exe taskkill.exe where.exe chcp.exe python.exe uv.exe
(not on PATH)   — for all of them
$ ls /mnt
k                 # only K: is mounted; there is no /mnt/c and no /mnt/host
$ cat /etc/wsl.conf
No such file or directory
```

**WSL→Windows interop is not available in this container**: no Windows binaries, no `chcp`, no
`taskkill.exe`, no `python.exe`. So the Windows *process* and *console* semantics still cannot be observed
here, only the Windows *filesystem* semantics. That is the boundary to state in any claim this project makes.

## The ladder this implies for this repository

| Layer | Available here today | Proves |
|---|---|---|
| Unit + shape tests with injected `platform`/`run` | yes | the call form: argv, `shell:false`, `windowsHide:true` |
| Forced code page in a Python child (`PYTHONIOENCODING=cp1252`, or in-child `reconfigure`) | yes | the encode failure and the U+FFFD the Node boundary sees |
| Windows-backed NTFS mount (`K:\` via 9p) | **yes** | case-insensitive lookup, case collisions, non-ASCII paths on a real Windows volume |
| Windows console (`GetConsoleOutputCP`, `chcp`), `taskkill /T`, job objects, `PATHEXT`, ADS/MotW, Defender | **no** | needs a real Windows process — hosted CI or a VM |
| Real VS Code Extension Development Host on Linux | yes (`@vscode/test-cli`) | the extension API surface, commands, GUI panel behaviour |
| Real VS Code on Windows | no (no Windows binaries here) | hosted CI (`windows-latest`) or the reference host |
