# Evidence — Research Stack Toolkit 0.3.7 (2026-11-02)

Everything in this folder was produced on the Linux development host by the commands named beside it.
No uv is installed on the host PATH; the uv binaries used are in `/tmp/uvs/` and are named explicitly.

| File | What it is | How to reproduce |
|---|---|---|
| [test-summary.md](test-summary.md) | Test counts for both suites and the artifact gates | the commands it names |
| [node-test-output.txt](node-test-output.txt) | Raw `cd extension && npm test` output — `tests 331`, `pass 331`, `fail 0`, `skipped 0` | `npm test` |
| [pytest-with-uv.txt](pytest-with-uv.txt) | Raw pytest output with a real uv binary — `207 passed in 99.84s` | `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6 .venv/bin/python -m pytest` |
| [pytest-without-uv.txt](pytest-without-uv.txt) | Raw pytest output without uv — `206 passed, 1 skipped in 99.42s` | `.venv/bin/python -m pytest` |
Both reproduction scripts write their receipt **into this folder** when run without `--out`, so re-running a
recorded command overwrites the recorded evidence. Pass `--out /tmp/<name>.json` to reproduce a run without
touching the tree; the recorded files below are the ones the release was gated on.

| [run_uv_matrix.py](run_uv_matrix.py) | The reproduction script: the exact `uv sync --locked …` command against the shipped pair and against the drifted 0.3.6 pair, on seven uv versions | `python3 evidence/quality-v0.3.7-2026-11-02/run_uv_matrix.py --uv /tmp/uvs/uv-0.5.0 … --uv /tmp/uvs/uv-0.13.6` |
| [uv-matrix.json](uv-matrix.json) | Its result: shipped pair accepted on all seven, drifted pair refused by all seven, exit codes 1 (uv ≥ 0.8) and 2 (uv 0.5.0–0.7.22) | same |
| [run_lock_provenance.py](run_lock_provenance.py) | The provenance script: `uv lock` on the 0.3.6 lock beside this release's manifest | `python3 evidence/quality-v0.3.7-2026-11-02/run_lock_provenance.py --uv /tmp/uvs/uv-0.13.6 --base v0.3.6` |
| [lock-provenance.json](lock-provenance.json) | Its result: `+2 / -2` line diff, 39 third-party pins unchanged, regenerated lock byte-identical to the packaged lock | same |
| [uv-lock-check.txt](uv-lock-check.txt) | `uv lock --check` green for all three shipped pairs with uv 0.13.6 | `cd <pair dir> && uv lock --check` |
| [lockintegrity-cli.json](lockintegrity-cli.json) | `python3 scripts/lockintegrity.py` verdict for the release tree | same |
| [vsix-audit.json](vsix-audit.json) | Raw `npm run verify-package` output for `dist/research-stack-toolkit-0.3.7.vsix` | `npm run verify-package` |
| [payload-check.json](payload-check.json) | Raw `npm run check:payload` output for the same artifact | `npm run check:payload` |
| [field-workspace.txt](field-workspace.txt) | The reported workspace, inspected read-only from this host: its `worker-0.3.6` pair flagged by both readers, refused by uv 0.11.23 (the reported host's version) with exit 1 and the same sentence the field log quotes; the shipped 0.3.7 pairs install at exit 0 | the commands it names |
| [packaged-uv-matrix.txt](packaged-uv-matrix.txt) | The **packaged** worker and notebook pairs installed with exit 0 on uv 0.5.0 → 0.13.6 and 0.11.23 | the commands it names |
| [notebook-fallback.txt](notebook-fallback.txt) | The notebook pair's gated fallback measured with real uv: `--locked` exit 2 (0.5.0) / exit 1 (0.13.6), `--frozen` exit 0, `uv.lock` byte-identical after every run | the commands it names |
| [sdist-name-uv-verdict.txt](sdist-name-uv-verdict.txt) | uv 0.13.6 `lock --check` exit 0 on a lock whose sdist filename names another version while the wheel agrees | the commands it names |
| [round5-e2e-wording.md](round5-e2e-wording.md) + `round5-e2e-*.json` | What the operator sees after the reporting fixes: refusal, fallback install, failed fallback — headline, step row, recorded command line, next action, pasteable re-run instruction | `bash /tmp/round5-wording-run.sh <extension dir>` (scratch harness, receipts copied here) |
| [clean-clone-rebuild.txt](clean-clone-rebuild.txt) | Two clean-clone builds of tag `v0.3.7` (commit `e0192ad`) produced the shipped artifact byte-for-byte: 332,448 bytes, sha256 `f221a9a8…`, both runs | `bash /tmp/repro_check.sh v0.3.7` (scratch harness, receipts copied here) |

`vsix-audit.json` and `payload-check.json` are raw command output, not pure JSON: each begins with the
two `npm notice run …` lines npm prints for the script, and the JSON payload starts after them. Strip
those lines before parsing them.

## What this folder does not contain

The field host. The failure was reported from Windows 11 x64 with `uv.exe` in the workspace
`Bankovní účet SVJ ČSA368`; installing the 0.3.7 VSIX there and re-running setup is still outstanding,
as are the G1–G4 reference-host receipts.
