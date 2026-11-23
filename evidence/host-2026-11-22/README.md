# Host and portability receipt — 2026-11-22 / 2026-11-23 (P1, T16-10, part of T16-01)

Build host: Linux (Debian 13 trixie, x86_64), node v24.22.0, uv-managed CPython in `.venv`.
This is **not** the reference Windows host. Nothing here stands for a native Windows run; the Windows
lines below state what is still owed.

## 1. `scripts/verify_mcp.py` on POSIX — now runs, and says which launcher it used

0.3.14 named `.venv/Scripts/research-stack-mcp.exe` in its development-tree branch, so on this host the
gate died with `FileNotFoundError` before any MCP traffic (recorded in
`specs/phase-15-hybrid-retrieval-presets-bundles/implementation-P2-retrieval.md` and in the T15-21 row of
the 0.3.14 acceptance table). The launcher is now derived from the platform, with an interpreter fallback
and a named refusal when neither exists.

Run on this host (`python scripts/verify_mcp.py`):

```json
{
  "launcher": "venv entry point research-stack-mcp",
  "platform": "linux",
  "tools": ["read_document", "read_text_source", "search_local_text", "write_docx", "write_markdown"],
  "czechFixtureRead": true,
  "sourcePathWithSpaces": "/tmp/research-stack-é-…/papers/paper with spaces.docx",
  "sourceSha256": "6c3377fb667da3f2b19dd7af1c13abb86c40d358ec81b71c5a9ce22beaf3adb2",
  "markdownAndDocxReportsCreated": true
}
```

The fixture document is generated fresh for each run in a temporary directory, so `sourceSha256` and
`sourcePathWithSpaces` are this run's values and are not comparable between runs; what the run certifies is
that the hash the receipt reports equals the hash of the source it read, and that both reports were written.
The gate was re-run on the stamped 0.3.15 tree (`launcher: venv entry point research-stack-mcp`,
`platform: linux`, five tools, Czech fixture read, both reports created) with `tests/test_verify_mcp.py`
5 passed.

Discovery, a read of a Czech fixture whose path carries spaces and a diacritic, and both written reports,
with the source hash unchanged. Pinned by `tests/test_verify_mcp.py` (5 cases: the two venv layouts, the
exact-entry-point preference, the interpreter fallback, the named `WORKER_LAUNCHER_MISSING` refusal, and
the gate itself on this host).

**Owed:** the same run on the reference Windows host with `.venv/Scripts/research-stack-mcp.exe`, and the
isolated-worker branch (`uv run --locked --no-dev --project .research-toolkit/worker`) against an
installed worker.

## 2. Node tests that failed on Windows, and what was changed

The 19 November 2026 run recorded 68 of 73 Node tests passing. Two causes were reproduced against the
current tree:

1. **A dialog assertion that assumed a POSIX path.** `extension/extension.js:1178` writes
   `Copy of what it replaces: ${path.join(root, ".research-toolkit", "preset-tools")}` — on Windows that
   is `.research-toolkit\preset-tools`. The test asserted `/.research-toolkit\/preset-tools/`, which
   cannot match there. The case now derives the expected text from `path.join` (and does the same for the
   target file), so it asserts the same thing on both hosts.
2. **Link fixtures an unprivileged Windows process cannot build.** `extension/test/linkfixture.js` is now
   the only place a link fixture is built: directory links use a junction on Windows (no privilege
   needed) and a symlink elsewhere; file links are attempted and, where the host refuses, the test is
   skipped **with the reason recorded** rather than asserting a refusal it never got to exercise.
   Converted: `presetselect.test.js`, `preflight.test.js`, `installer.test.js` (two sites),
   `setuplog.test.js` (three sites), and in `bundles.test.js`.

**Owed, and named so it is not lost:** a junction is a reparse point. Whether
`lstat().isSymbolicLink()` reports it on Windows has not been measured here, and the file-link cases —
the ones a junction would actually be used for — are unproven until a Windows host with Developer Mode (or
an elevated shell) runs them. A skipped test is a recorded gap, not a pass.

## 3. `npm run test:host` states what it exercised

`extension/test/run-host-test.js` now refuses an ambiguous setup and writes a receipt naming the artifact:
`source-tree` (the 0.3.14 behaviour, still the default), `source-tree` with an explicit
`EXTENSION_DEVELOPMENT_PATH`, or `installed-candidate` from `VSCODE_TEST_VSIX` (digest + member count
recorded, `EXTENSION_DEVELOPMENT_PATH` refused in the same breath). Isolation is checked: both
`--user-data-dir` and `--extensions-dir` must live inside `VSCODE_TEST_ROOT`. Pinned by
`extension/test/host-runner.test.js` (8 cases, all passing on this host).

**Owed:** the run itself on the reference host, for a built 0.3.15 candidate, with the panel scenarios
(Force Update, Archive History, Restore, Configure Preset Tools including a refused confirmation), the
upgrade path starting from the 0.3.14 archive and bundle, and `VSCODE_TEST_RECEIPT_DIR` set so the run
leaves the receipt behind.

## 4. The browser renderer case ran for the first time here

`extension/test/browser.test.js` had never executed on this host: Playwright was not a declared
dependency. It is now pinned (`playwright 1.65.1` in `extension/package.json` devDependencies, never
shipped — `unit.test.js` still pins that the packaged manifest carries no `devDependencies`), with
`npm run test:browser` as the entry point. Browser binary fetched with `npx playwright install chromium`;
on this container Chromium also needed system libraries that `apt` could not install under the sandbox, so
they were fetched with `apt-get download` and unpacked into a scratch directory (`LD_LIBRARY_PATH`). That
is a container workaround for the build host only and is not part of the release.

Running it surfaced three defects **in the test**, each fixed against the shipped truth and annotated:

| What the case claimed | What the shipped build does |
| --- | --- |
| the Guide button hands `markdown.showPreview` a **string** `extension/guides/toolkit.md` | it hands a **Uri** — the same shape `unit.test.js:161` pins. The case could only pass while it never ran. |
| the `read-and-cite` preset's title is "Open one workspace PDF or DOCX" | `presets.json` says "Open one workspace PDF, DOCX or Markdown file, …" |
| host pushes and the theme reloads are independent | `refresh()` pushes state to the webview without awaiting it; a `page.reload()` started while such a push is in flight destroyed the execution context and the rejection surfaced at the call that posted it. Pushes are now tracked and settled before any navigation. |

Result: repeated passing runs, no renderer errors or CSP violations, and three full-page panel
screenshots as the artifact the case names — `evidence/quality-v0.3.15-2026-11-23/{dark,light,contrast}.png`
(dark and contrast at 1100 px, light at 390 px mobile width, each asserted to have no horizontal overflow).
The earlier pair under `evidence/quality-v0.3.14-2026-11-2x/` is the same case run against the un-stamped tree
and is kept because it is the run that found the three test defects.

**Coverage boundary, stated rather than implied:** this case renders the shipped panel markup and script in
Chromium. It is not a VS Code webview: no `acquireVsCodeApi` sandbox, no CSP the editor imposes, no
`workbench` theme variables beyond the ones the case injects. The scenarios only a real webview can
prove — modal dialogs, secret storage, `McpStdioServerDefinition` registration, the actual Settings
write — belong to `npm run test:host` and the reference-host panel pass.
