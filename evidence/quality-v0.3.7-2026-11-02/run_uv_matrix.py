#!/usr/bin/env python3
"""Reproduce the 0.3.6 worker failure and prove the 0.3.7 pair is accepted, on real uv binaries.

Run from the repository root:

    python3 evidence/quality-v0.3.7-2026-11-02/run_uv_matrix.py \
        --uv /tmp/uvs/uv-0.5.0 --uv /tmp/uvs/uv-0.13.6

For every uv binary it runs the exact command `extension/runtime.js` issues, twice:

* `shipped`  — the worker tree as packaged in this release;
* `drifted`  — the same tree with only the lock's root package version wound back to 0.3.4,
               which is the pair 0.3.6 shipped.

It records exit code, duration and the stderr tail, and writes `uv-matrix.json` beside this file.
Nothing here is a mock: uv is the real binary and the project is a copy of the shipped worker.
"""

from __future__ import annotations

import argparse
import datetime
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKER = ROOT / "extension" / "worker"
COMMAND = ["sync", "--locked", "--no-dev", "--python", "3.12", "--no-config"]
FALLBACK_COMMAND = ["sync", "--frozen", "--no-dev", "--python", "3.12", "--no-config"]
DRIFT_MESSAGE = "The lockfile at `uv.lock` needs to be updated, but `--locked` was provided."


def worker_copy(target: pathlib.Path, *, drift_to: str | None) -> None:
    shutil.copytree(WORKER, target)
    shutil.rmtree(target / "bundle.json", ignore_errors=True)
    (target / "bundle.json").unlink(missing_ok=True)
    lock = target / "uv.lock"
    text = lock.read_text(encoding="utf-8")
    if drift_to is not None:
        block = re.compile(
            r'(name = "research-stack-basic"\nversion = ")[^"]+(")'
        )
        assert block.search(text), "the shipped lock has no root package entry to wind back"
        lock.write_text(block.sub(r"\g<1>" + drift_to + r"\g<2>", text, count=1), encoding="utf-8")


def run(uv: str, project: pathlib.Path, cache: pathlib.Path, mode: str = "--locked") -> dict:
    started = time.monotonic()
    command = COMMAND if mode == "--locked" else FALLBACK_COMMAND
    result = subprocess.run(
        [uv, *command, "--project", str(project)],
        cwd=project,
        capture_output=True,
        text=True,
        timeout=900,
        env={
            "PATH": "/usr/bin:/bin",
            # uv finds its managed CPython 3.12 under the real HOME; the project copy is not HOME.
            "HOME": str(pathlib.Path.home()),
            "UV_CACHE_DIR": str(cache),
            "UV_PYTHON_DOWNLOADS": "never",
        },
    )
    return {
        "exitCode": result.returncode,
        "durationMs": round((time.monotonic() - started) * 1000),
        "stderrTail": (result.stderr or "").strip().splitlines()[-3:],
        "stdoutTail": (result.stdout or "").strip().splitlines()[-2:],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--uv", action="append", required=True, help="path to a uv binary (repeatable)")
    parser.add_argument("--drift-to", default="0.3.4", help="root version to record in the negative control")
    parser.add_argument("--out", help="write the receipt here instead of overwriting the recorded evidence file")
    args = parser.parse_args()

    # The recorded receipt lives beside this script, and re-running the script rewrites it. Pass --out to
    # reproduce a run somewhere else and leave the recorded evidence alone.
    out = pathlib.Path(args.out) if args.out else pathlib.Path(__file__).resolve().parent / "uv-matrix.json"
    cache = pathlib.Path(tempfile.mkdtemp(prefix="research-stack-uv-cache-"))
    rows = []
    for uv in args.uv:
        uv_path = pathlib.Path(uv)
        version = subprocess.run([str(uv_path), "--version"], capture_output=True, text=True).stdout.strip()
        workspace = pathlib.Path(tempfile.mkdtemp(prefix="research-stack-uv-matrix-"))
        try:
            shipped_project = workspace / "shipped"
            drifted_project = workspace / "drifted"
            worker_copy(shipped_project, drift_to=None)
            worker_copy(drifted_project, drift_to=args.drift_to)
            shipped = run(str(uv_path), shipped_project, cache)
            drifted = run(str(uv_path), drifted_project, cache)
            # The tier `extension/runtime.js` issues after it recognises drift, on the same drifted
            # tree: `--frozen` skips the freshness check and installs exactly what the lock pins.
            frozen = run(str(uv_path), drifted_project, cache, mode="--frozen")
            rows.append({
                "uv": version,
                "uvBinary": str(uv_path),
                "command": ["uv", *COMMAND, "--project", "<managed worker>"],
                "shippedPair": shipped,
                "driftedPair": drifted,
                "frozenFallbackOnDriftedPair": frozen,
                "frozenRecovered": frozen["exitCode"] == 0,
                # The refusal sentence is identical everywhere; only the exit code moves
                # (1 on uv >= 0.8, 2 on 0.5.0 - 0.7.22), which is why the toolkit matches the
                # message and never the number. See extension/lockfile.js DRIFT_SIGNATURE.
                "driftedRefusedLock": drifted["exitCode"] != 0
                and any("needs to be updated" in line for line in drifted["stderrTail"]),
                "shippedAccepted": shipped["exitCode"] == 0,
            })
            print(
                f"{version:>10}  shipped exit={shipped['exitCode']} ({shipped['durationMs']} ms)  "
                f"drifted exit={drifted['exitCode']} ({drifted['durationMs']} ms)  "
                f"drift message seen={rows[-1]['driftedRefusedLock']}"
            )
        finally:
            shutil.rmtree(workspace, ignore_errors=True)
    shutil.rmtree(cache, ignore_errors=True)

    document = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "host": {
            "python": sys.version.split()[0],
            "platform": sys.platform,
            "note": "uv binaries were downloaded to /tmp/uvs; no uv is installed on the host PATH.",
        },
        "workerVersion": (WORKER / "pyproject.toml").read_text(encoding="utf-8").split('version = "')[1].split('"')[0],
        "commandIssuedBy": "extension/runtime.js -> extension/runner.js (shell: false, windowsHide: true)",
        "commands": {"tier 1": ["uv", *COMMAND, "--project", "<managed worker>"],
                     "tier 2 (only after a recognised drift)": ["uv", *FALLBACK_COMMAND, "--project", "<managed worker>"]},
        "negativeControl": f"lock root version wound back to {args.drift_to}, the pair 0.3.6 shipped",
        "rows": rows,
        "verdict": {
            "everyDriftRefused": all(row["driftedRefusedLock"] for row in rows),
            "everyShippedPairAccepted": all(row["shippedAccepted"] for row in rows),
            "frozenRecoveredOnEveryDriftedPair": all(row["frozenRecovered"] for row in rows),
        },
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {out}")
    verdict = document["verdict"]
    return 0 if (verdict["everyDriftRefused"] and verdict["everyShippedPairAccepted"]
                 and verdict["frozenRecoveredOnEveryDriftedPair"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
