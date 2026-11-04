#!/usr/bin/env python3
"""Windows path-budget and case-collision probe, run on Linux.

Two questions this answers without a Windows machine:

1. Would the toolkit's own paths exceed MAX_PATH (260) under a realistic Windows root?
2. Do any two paths the toolkit owns collide when compared the way NTFS compares them?

`ntpath` is Python's Windows path module — the counterpart of Node's `path.win32`. Both parse Windows
paths faithfully on Linux; neither can tell you what the filesystem would do.
"""
import ntpath
import sys

# The toolkit's own layout under a workspace root (extension/runtime.js, extension/steps.js).
RELATIVE = [
    r".research-toolkit\managed\worker-0.3.8\Lib\site-packages\research_stack\__init__.py",
    r".research-toolkit\managed\worker-0.3.8\Lib\site-packages\research_stack\__pycache__\__init__.cpython-312.pyc",
    r".research-toolkit\managed\worker-0.3.8\Lib\site-packages\mcp\types.py",
    r".research-toolkit\managed\worker-0.3.8\Scripts\uv.exe",
    r".research-toolkit\managed\worker-0.3.8\.venv\Scripts\python.exe",
    r".research-toolkit\store\research.sqlite3",
    r".research-toolkit\logs\setup-attempt-01.log",
    r".research-toolkit\notebooks\.venv\Lib\site-packages\matplotlib\mpl-data\fonts\ttf\DejaVuSans.ttf",
]

ROOTS = [
    r"C:\Users\user",
    r"C:\Users\uživatel",
    r"C:\Users\Bankovní účet SVJ ČSA368",
    r"C:\Users\Very Long Department Name 0123456789",
    r"C:\Users\student\AppData\Roaming\Code\User\workspaceStorage\a1b2c3d4",
    r"D:\data\2026\Bankovní účet SVJ ČSA368",
    r"\\fileserver\sdilej\Bankovní účet SVJ ČSA368",
]

MAX_PATH = 260

worst = 0
worst_path = ""
print(f"{'chars':>6}  {'verdict':<12}  path")
for root in ROOTS:
    for rel in RELATIVE:
        full = ntpath.join(root, rel)
        n = len(full)
        worst, worst_path = max((n, full), (worst, worst_path))
        verdict = "OVER 260" if n > MAX_PATH else "fits"
        print(f"{n:>6}  {verdict:<12}  {full}")

print()
print(f"worst case: {worst} chars — {worst_path}")
print(f"headroom against MAX_PATH: {MAX_PATH - worst} chars")
print("Note: the modern long-path behaviour needs the LongPathsEnabled registry value AND a")
print("long-path-aware application manifest; the `\\\\?\\` prefix is the per-call escape hatch.")

print()
print("== case collisions between toolkit-owned paths (NTFS compares case-insensitively) ==")
normalised = {}
collision = False
for rel in RELATIVE:
    key = ntpath.normcase(ntpath.normpath(rel))
    normalised.setdefault(key, []).append(rel)
for key, group in normalised.items():
    distinct = {g for g in group}
    if len(group) > 1:
        collision = True
        print(f"COLLIDE: {key} <- {sorted(distinct)}")
if not collision:
    print("none — every owned path is distinct under ntpath.normcase")

print()
print("== what Linux cannot show ==")
print("mkdir store/ and mkdir STORE/ both succeed here; on NTFS they are one directory.")
print("ntpath.normcase() reports the collision; the filesystem here will not.")
