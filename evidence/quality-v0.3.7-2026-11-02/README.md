# Evidence — Research Stack Toolkit 0.3.7 (2026-11-02)

Everything in this folder was produced on the Linux development host by the commands named beside it.
No uv is installed on the host PATH; the uv binaries used are in `/tmp/uvs/` and are named explicitly.

| File | What it is | How to reproduce |
|---|---|---|
| [test-summary.md](test-summary.md) | Test counts for both suites and the artifact gates | the commands it names |
| [node-test-output.txt](node-test-output.txt) | Raw `cd extension && npm test` output — 155 pass / 0 fail | `npm test` |
| [pytest-with-uv.txt](pytest-with-uv.txt) | Raw pytest output with a real uv binary — 132 passed | `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6 .venv/bin/python -m pytest` |
| [pytest-without-uv.txt](pytest-without-uv.txt) | Raw pytest output without uv — 131 passed, 1 skipped | `.venv/bin/python -m pytest` |
| [run_uv_matrix.py](run_uv_matrix.py) | The reproduction script: the exact `uv sync --locked …` command against the shipped pair and against the drifted 0.3.6 pair, on seven uv versions | `python3 evidence/quality-v0.3.7-2026-11-02/run_uv_matrix.py --uv /tmp/uvs/uv-0.5.0 … --uv /tmp/uvs/uv-0.13.6` |
| [uv-matrix.json](uv-matrix.json) | Its result: shipped pair accepted on all seven, drifted pair refused by all seven, exit codes 1 (uv ≥ 0.8) and 2 (uv 0.5.0–0.7.22) | same |
| [run_lock_provenance.py](run_lock_provenance.py) | The provenance script: `uv lock` on the 0.3.6 lock beside this release's manifest | `python3 evidence/quality-v0.3.7-2026-11-02/run_lock_provenance.py --uv /tmp/uvs/uv-0.13.6 --base v0.3.6` |
| [lock-provenance.json](lock-provenance.json) | Its result: `+2 / -2` line diff, 39 third-party pins unchanged, regenerated lock byte-identical to the packaged lock | same |
| [uv-lock-check.txt](uv-lock-check.txt) | `uv lock --check` green for all three shipped pairs with uv 0.13.6 | `cd <pair dir> && uv lock --check` |
| [lockintegrity-cli.json](lockintegrity-cli.json) | `python3 scripts/lockintegrity.py` verdict for the release tree | same |
| [vsix-audit.json](vsix-audit.json) | `npm run verify-package` result for `dist/research-stack-toolkit-0.3.7.vsix` | `npm run verify-package` |

## What this folder does not contain

The field host. The failure was reported from Windows 11 x64 with `uv.exe` in the workspace
`Bankovní účet SVJ ČSA368`; installing the 0.3.7 VSIX there and re-running setup is still outstanding,
as are the G1–G4 reference-host receipts.
