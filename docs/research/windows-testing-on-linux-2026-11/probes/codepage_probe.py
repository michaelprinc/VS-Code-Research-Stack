#!/usr/bin/env python3
"""Code-page fidelity probe: what this Linux host can and cannot make look like Windows.

Run from anywhere:  python3 probes/codepage_probe.py
Read-only. Prints one line per technique, and says what each technique does NOT change.
"""
import locale
import subprocess
import sys
from pathlib import Path

CHILD = r"""
import locale, sys
print(f"  preferred={locale.getpreferredencoding(False)!r} "
      f"stdout={sys.stdout.encoding!r}/{sys.stdout.errors!r} "
      f"stderr={sys.stderr.encoding!r}/{sys.stderr.errors!r}")
try:
    print("\u010d")            # č — the character from the 0.3.8 field report
except UnicodeEncodeError as exc:
    print(f"  encode of U+010D failed: {exc}")
"""

CASES = [
    ("default (host locale)", [], {}),
    ("LC_ALL=C", ["-c", CHILD], {"LC_ALL": "C"}),
    ("LC_ALL=C.utf8", ["-c", CHILD], {"LC_ALL": "C.utf8"}),
    ("PYTHONIOENCODING=cp1252", ["-c", CHILD], {"PYTHONIOENCODING": "cp1252"}),
    ("PYTHONIOENCODING=cp1252 with -I (isolated)", ["-I", "-B", "-c", CHILD], {"PYTHONIOENCODING": "cp1252"}),
    ("-X utf8 with PYTHONIOENCODING=cp1252", ["-X", "utf8", "-c", CHILD], {"PYTHONIOENCODING": "cp1252"}),
    ("-I -B -X utf8 (the 0.3.8 argv)", ["-I", "-B", "-X", "utf8", "-c", CHILD], {"PYTHONIOENCODING": "cp1252"}),
    ("child reconfigures to cp1252, errors=strict (the faithful fixture)",
     ["-c", "import sys\nsys.stdout.reconfigure(encoding='cp1252', errors='strict')\n" + CHILD], {}),
]

print(f"interpreter: {sys.executable}")
print(f"Python {sys.version.split()[0]} on {sys.platform}")
print(f"installed locales (locale -a): {subprocess.run(['locale','-a'],capture_output=True,text=True).stdout.split()}")
print()
for label, args, env in CASES:
    print(f"== {label}")
    run_env = {"PATH": "/usr/bin:/bin", **env}
    argv = args if args else ["-c", CHILD]
    r = subprocess.run([sys.executable, *argv], capture_output=True, text=True, env=run_env)
    print("".join(line if line.startswith("  ") else f"  {line}"
                  for line in (r.stdout + r.stderr).splitlines(keepends=True)))
    print(f"  exit={r.returncode}")
