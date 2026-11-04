# What the operator sees after the fifth-round reporting fixes

Driven through the unpacked VSIX code (`extension.js → installer.runPlan → steps.js →
runtime.setupRuntime → runner.js`), with the fixed working-tree modules copied over the packaged tree,
in a scratch workspace whose path contains spaces and Czech diacritics. uv 0.13.6 invoked by absolute
path; the fallback scenarios use the stand-in uv from `/tmp/e2e-037/fakeuv` and `/tmp/e2e-037/fakeuv2`,
which replay the sentences captured from real uv runs and otherwise exec the real binary.

Full records: `round5-e2e-broken-worker.json`, `round5-e2e-fallback-success.json`,
`round5-e2e-fallback-failed.json`.

## A. A disagreeing pair in the shipped build (no process, no lockfile written)

Headline: `Installation incomplete — 1 step(s) verified, 2 need attention (Isolated locked worker
(Python 3.12), Notebook analysis environment). 1 of 3 package steps are installed in this workspace.`

Step row: `Isolated locked worker (Python 3.12) (worker): failed · no process ran · 0 s` — recorded
`attempts: 0`, no exit code, no fallback marker. Error names the pair and says no process ran and no
file was written; next action names a VSIX reinstall.

## B. The reviewed fallback installs (host uv refuses `--locked`)

Headline: `Installation complete — 3 component step(s) verified. 2 step(s) installed through a lockfile
fallback (Isolated locked worker (Python 3.12), Notebook analysis environment) — this host's uv refused
the shipped lockfile; see that step's evidence.`

Both steps record `attempts: 2` (the `--locked` refusal and the `--frozen` install) and carry the
fallback marker with uv's own message. Both lockfiles on disk stayed at the shipped hashes.

## C. The reviewed fallback also fails

Headline: `… 1 step(s) attempted the reviewed lockfile fallback and did not install (Isolated locked
worker (Python 3.12)) — this host's uv refused the shipped lockfile; see that step's evidence.`

Step row: `failed · exit 2 · 2 attempts · lockfile fallback attempted, step not installed`. Recorded
command line ends with `(in "<managed worker directory>")`. The error carries both uv sentences and
ends `Check the host tool version and network access, then retry setup.` — the success wording is gone.
The diagnostics block adds the pasteable instruction:

```
To re-run this step yourself, use a UTF-8 terminal:
cd '/tmp/round5/work-fail/Bankovní účet SVJ ČSA368/.research-toolkit/managed/worker-0.3.7'
'/tmp/e2e-037/fakeuv2/uv' 'sync' '--frozen' '--no-dev' '--python' '3.12' '--project' '/tmp/…/worker-0.3.7' '--no-config'
```

On Windows the first line also names `chcp 65001`; that branch is pinned by
`extension/test/installer.test.js`, not by this host.
