# Evidence — 0.3.8 (UTF-8 stdio release), 4 November 2026

Repository: Research Stack Toolkit. Tag: `v0.3.8`. Spec:
[specs/phase-8-utf8-stdio/](../../specs/phase-8-utf8-stdio/). Release report:
[implementation-report-0.3.8.md](../../docs/implementation/phase-8-utf8-stdio/implementation-report-0.3.8.md).

Everything here was run on this Linux development host (Python 3.12.16, uv 0.13.6 pinned at
`/tmp/uvs/uv-0.13.6`). The reported failure came from Windows 11 x64; the reproduction forces the same
console codec on this host rather than claiming a Windows run.

| File | What it is |
| --- | --- |
| [encoding-matrix.txt](encoding-matrix.txt) | The measured encoding matrix: why `PYTHONIOENCODING` cannot fix it under `-I`, the 0.3.7 shape failing with the field sentence, the 0.3.8 command succeeding with pure-ASCII stdout, the idempotent retry, and the U+FFFD the Node boundary sees |
| [node-suite.txt](node-suite.txt) | `cd extension && PATH=/tmp/uvs:$PATH npm test` → 336 passed, 0 failed, 0 skipped |
| [pytest-with-uv.txt](pytest-with-uv.txt) | `RESEARCH_STACK_UV=/tmp/uvs/uv-0.13.6 .venv/bin/python -m pytest tests/ -o addopts="" -q` → 219 passed |
| [pytest-no-uv.txt](pytest-no-uv.txt) | Same suite with no uv on `PATH` → 218 passed, 1 skipped |
| [lockintegrity-cli.json](lockintegrity-cli.json) | `scripts/lockintegrity.py` → `"ok": true`, three pairs, worker root `0.3.8` at `revision = 5` |
| [uv-lock-check.txt](uv-lock-check.txt) | `uv-0.13.6 lock --check` in the three pair directories → exit 0 |
| [uv-lock-check-across-versions.txt](uv-lock-check-across-versions.txt) | `uv lock --check` on `extension/worker` with uv 0.5.0 … 0.13.6: exit 0 on 0.6.10 and above; uv 0.5.0 predates the subcommand (exit 2, usage error) |
| [vsix-audit.json](vsix-audit.json) | `npm run verify-package` → `"result": "passed"`, `sourceFilesMatch: true`, `stdio.py` among the packaged worker members |
| [payload-check.json](payload-check.json) | `npm run check:payload` → `"result": "passed"`, `managedPath` `.research-toolkit/managed/worker-0.3.8` |
| [docs-version-scan.txt](docs-version-scan.txt) | Every `worker-*` / `research-stack-toolkit-*` reference in the shipped documentation: 18 references, all 0.3.8 |
| [clean-clone-rebuild.txt](clean-clone-rebuild.txt) | `git archive v0.3.8` rebuilt in a clean directory, compared with the shipped artifact |

## The artifact

```
dist/research-stack-toolkit-0.3.8.vsix   336 634 bytes, 87 members
sha256  fd42c2aab0977219fae44a24c2a697e0a4fb762aedad3baf1340e1d43967bdd2
```

0 members carry CRLF; every ZIP entry is stamped 1980-01-01 (`SOURCE_DATE_EPOCH`); 84 members are `0644`
and the three vsce-generated members are `0664`. The `.sha256` sidecar was written with
`sha256sum dist/… > dist/….sha256` and verified with `sha256sum -c`.

For comparison, 0.3.7 was 332 448 bytes / 86 members / sha256 `f221a9a8…`. The member count rises by one
because `src/research_stack/stdio.py` is part of the package and is bundled.

## The field record this release answers

```json
{"kind":"step","stepId":"lab-store","status":"failed","exitCode":2,"durationMs":1678,
 "error":"python.exe -I failed with exit code 2: {\"error\": \"'charmap' codec can't encode character '\\u010d' in position 67: character maps to <undefined>\"} (cwd k:\\Soukromé_aktivity\\Bankovní účet SVJ ČSA368)"}
{"kind":"plan","status":"partial","ran":["research-overlay","notebook-env"],"skipped":["worker"],
 "repaired":[],"failed":["lab-store"],"blocked":[]}
```

Panel: "Installation incomplete — 3 step(s) verified, 1 need attention (Corpus index and record store)."
