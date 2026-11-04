# 05 · CI playbook for this toolkit (what to run, where, and what each job may claim)

## Current state, measured 2026-11-04

- There is **no `.github/` directory in the repository** — no workflows, no CI. Every gate in the release
  process is run by hand on this Linux container.
- `extension/package.json` runs the suites through an **explicit file list**:

  ```json
  "test": "node --test test/unit.test.js test/diagnostics.test.js … test/gui-status.test.js"
  ```

  16 files are named. `test/python-argv.js` is a shared helper (required by six suites), so it is correctly
  absent — but **a new `test/*.test.js` file is silently not run** unless someone edits the script.
  `module-boundaries.test.js` already guards "a new shipped module cannot appear unreviewed"; the same idea
  is missing for test files.
- `test:host` (`test/run-host-test.js`) needs `VSCODE_EXECUTABLE_PATH`, `VSCODE_TEST_ROOT`, optional
  `VSCODE_TEST_WORKSPACE`, and `@vscode/test-electron`. It is a manual, human-invoked gate today.
- Python side is `uv`-locked (`uv.lock`, `requires-python = ">=3.12, <3.15"`).

## The three jobs to add

```yaml
# .github/workflows/verify.yml
name: verify
on:
  push: { branches: [main] }
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  node:
    # SHAPE + Linux behaviour. windows-latest is the job that turns shape claims into behaviour claims.
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest, macos-latest]
    runs-on: ${{ matrix.os }}
    defaults:
      run: { shell: bash }          # one shell everywhere; do not let cmd/PowerShell parsing vary per OS
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm, cache-dependency-path: extension/package-lock.json }
      - run: npm ci
        working-directory: extension
      - run: npm test
        working-directory: extension

  python:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        python: ["3.12", "3.13", "3.14"]     # matches requires-python ">=3.12, <3.15"
    runs-on: ${{ matrix.os }}
    defaults: { run: { shell: bash } }
    steps:
      - uses: actions/checkout@v4
      - uses: astral-sh/setup-uv@v6
        with: { enable-caching: true }
      - uses: actions/setup-python@v5
        with: { python-version: "${{ matrix.python }}" }
      - run: uv lock --check
      - run: uv run --locked pytest -q
      - run: uv run --locked python scripts/verify_vsix.py --help   # import smoke, no artifact needed

  extension-host:
    # Real Extension Development Host. Linux needs a virtual display; Windows does not.
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        vscode: ["stable", "1.140", "insiders"]
    runs-on: ${{ matrix.os }}
    defaults: { run: { shell: bash } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
        working-directory: extension
      - name: host tests (Linux)
        if: runner.os == 'Linux'
        run: xvfb-run --auto-servernum npm run test:host
        working-directory: extension
        env:
          VSCODE_TEST_ROOT: ${{ runner.temp }}/vscode-host-${{ matrix.vscode }}
      - name: host tests (Windows)
        if: runner.os == 'Windows'
        run: npm run test:host
        working-directory: extension
        env:
          VSCODE_TEST_ROOT: ${{ runner.temp }}/vscode-host-${{ matrix.vscode }}
```

`test/host.test.js` currently reads `VSCODE_EXECUTABLE_PATH` and fails if it is unset. **Prefer not to
install VS Code in CI at all**: `@vscode/test-electron` downloads the correct platform archive
(`win32-x64-archive`, `win32-arm64-archive`, `linux-x64`, …) into `.vscode-test/` from
`update.code.visualstudio.com`, and resolves the newest version satisfying `engines.vscode`. Change the
harness so the VS Code version is a matrix variable (`version: "stable" | "insiders" | "1.140.0"`) instead of
whatever executable happens to be on the machine. If a real `code` CLI is needed for an install round-trip,
Chocolatey's package id is `vscode` and winget's is `Microsoft.VisualStudioCode`; VS Code is not preinstalled
on any GitHub image.

Two more CI facts that change the shape of the jobs:

- **`xvfb` is preinstalled on the Ubuntu images**, so `xvfb-run` needs no setup step. Windows runners run in
  an interactive desktop session and need no display wrapper.
- **Package on Linux, test on Windows.** VS Code's own docs: "when building and publishing your extension
  from Windows, all the files included in the extension package will lack POSIX file attributes, namely the
  executable bit. Some `node_modules` dependencies rely on those attributes." This project ships a Python
  worker bundle, so packaging must stay on a Linux job.

## What each job is allowed to claim

Write this table into the workflow comments; it is the part that prevents false confidence.

| Job | May be cited as | Must NOT be cited as |
|---|---|---|
| `node` on `ubuntu-latest` | logic, argv shape, `shell:false`, `windowsHide:true` present | Windows behaviour |
| `node` on `windows-latest` | **Windows behaviour**: `PATHEXT`, `.cmd` resolution, `taskkill`, env-var case, drive letters, real `python.exe` | the user's machine (no Defender, no mapped drives, Server 2025 not Windows 11) |
| `python` on `windows-latest` | stdio encoding on a real cp1252 host, `os.path` Windows semantics, MAX_PATH | Windows 11 desktop UX |
| `extension-host` | the extension API surface, commands, panel status, activation | GUI correctness (no screenshots), Windows-specific host behaviour unless the job is `windows-latest` |
| field host (manual, gate G1–G4) | the shipping decision | nothing automated |

## Evidence discipline (already partly in place, extend it)

The 0.3.8 release produced `evidence/quality-v0.3.8-2026-11-04/` receipts. Keep that habit and add:

1. **One receipt per gate**, JSON, with `gate`, `host`, `os`, `vscodeVersion`, `pythonVersion`,
   `nodeVersion`, `result`, `artifactSha256`, `at`. A gate with no receipt did not happen.
2. **Artifact identity in the job output**: `sha256sum dist/*.vsix` printed and stored as a job summary, so a
   CI-built VSIX and a locally-built VSIX can be compared byte-for-byte. (The 0.3.8 VSIX was rebuilt from a
   clean clone twice and matched; CI makes that routine instead of heroic.)
3. **A claim label in every test name.** The repo already does this in spirit ("SHAPE TEST (not Windows
   proof)"). Keep it, and make CI print how many tests carry each label, so a release note can say
   "336 Node tests, of which N are Windows-backed" instead of "all tests pass".

## A guard worth adding now

Add to `module-boundaries.test.js` (or a new `test-inventory.test.js`) a test that every
`test/*.test.js` file in the directory appears in `package.json`'s `scripts.test`. Today a Windows-semantics
test could be written, pass when run by hand, and never run in CI.

## Publishing: a dated deadline

`@vscode/vsce` 4.1.0 supports **Trusted Publishing with OIDC** (`--oidc`, `id-token: write`), and **global
Azure DevOps personal access tokens are retired on 1 December 2026**. If this project publishes with a
global PAT, that path closes in under a month. The publish job should look like:

```yaml
  publish:
    if: startsWith(github.ref, 'refs/tags/v')
    runs-on: ubuntu-latest
    permissions: { contents: read, id-token: write }     # required for --oidc
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci && npm run package && npm run verify-package && npm run check:payload
        working-directory: extension
      - run: npx --yes @vscode/vsce@4.1.0 publish --no-dependencies --oidc
        working-directory: extension
```

Keep `ovsx` 1.3.0 as the Open VSX mirror step; it needs its own PAT, which is unaffected by the Azure
DevOps retirement.

## Version matrix to keep (and why)

| Axis | Values | Reason |
|---|---|---|
| VS Code | `insiders`, `stable`, lowest supported (`1.140` per `engines.vscode: ^1.140.0`) | `engines` is a promise; only a matrix proves it |
| Node | 22 (the `@vscode/test-electron` 3.1.0 floor) and the Electron-bundled Node of the tested VS Code | the extension host is not your Node |
| Python | 3.12, 3.13, 3.14 | `requires-python = ">=3.12, <3.15"`; 3.15 is where UTF-8 mode becomes the default (PEP 686) and where `PurePath.is_reserved()` disappears |
| OS | ubuntu, **windows**, macos | Windows is the target platform; macOS is a cheap second non-Windows signal |

`vscode-extension-tester` 8.28.1 publishes `supportedVersions { vscode-min: 1.138.0, vscode-max: 1.140.0 }`,
which lags the repo's own range. If GUI-level tests are added, pin the tool and the VS Code versions it
actually supports, and record the pin in the receipt — otherwise a tool update silently changes what was tested.
