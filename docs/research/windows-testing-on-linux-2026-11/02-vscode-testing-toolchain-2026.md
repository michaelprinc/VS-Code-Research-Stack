# 02 · The VS Code extension testing toolchain, as it actually is in November 2026

Versions below were read from the npm registry and from primary project sources on **4 November 2026**,
not from memory or from search snippets. Where a repo and its published package disagree, both are given.

Baseline: **VS Code stable 1.145.0, released 4 November 2026** (verified from
`update.code.visualstudio.com/api/releases/stable`: 1.145.0, 1.144.1, 1.144.0, 1.143.1, 1.143.0, 1.142.0).
Insiders is 1.146.0-insider. The toolkit's own reference-host gate names VS Code 1.141.0 — three minors
behind current stable.

| Tool | Version (2026-11-04) | What it is for |
|---|---|---|
| [`@vscode/test-cli`](https://www.npmjs.com/package/@vscode/test-cli) | **0.0.15** (2026-06-22) | the recommended entry point: config-driven runner, Mocha under the hood |
| [`@vscode/test-electron`](https://www.npmjs.com/package/@vscode/test-electron) | **3.1.0** (2026-07-24) | the library that downloads VS Code and launches the Extension Development Host |
| [`@vscode/test-web`](https://www.npmjs.com/package/@vscode/test-web) | **0.0.81** (2026-06-23) | the web extension host in a real browser (Playwright inside) |
| [`vscode-extension-tester`](https://www.npmjs.com/package/vscode-extension-tester) | **8.28.1** (2026-10-05) | black-box UI tests of a real VS Code (Selenium + ChromeDriver) |
| [`@vscode/vsce`](https://www.npmjs.com/package/@vscode/vsce) | **4.1.0** (2026-10-28) | packaging and publishing |
| [`ovsx`](https://www.npmjs.com/package/ovsx) | **1.3.0** (2026-10-16) | Open VSX publishing |
| [`@playwright/test`](https://www.npmjs.com/package/@playwright/test) | **1.64.1** (2026-10-14) | what Microsoft's own VS Code UI automation now uses |

---

## 1. `@vscode/test-cli` — the default in 2026

The docs put it under "Quick Setup: The test CLI" and call the hand-written `runTests` script
"Advanced setup" ([Testing Extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension)).
`microsoft/vscode-generator-code` scaffolds it, and `microsoft/vscode` itself has
`"test-extension": "vscode-test"`.

```js
// .vscode-test.mjs
import { defineConfig } from "@vscode/test-cli";
export default defineConfig([
  {
    label: "packageSteps",
    files: "test/**/*.test.js",
    version: "stable",                 // "insiders" | "1.143.1" | a commit hash
    workspaceFolder: "./sampleWorkspace",
    launchArgs: ["--disable-workspace-trust"],
    env: { RESEARCH_STACK_TOOL_PRESET: "basic" },
    mocha: { timeout: 20000 },
  },
]);
```

```bash
vscode-test                      # default config
vscode-test --label packageSteps # one labelled config
vscode-test --coverage --coverage-reporter lcov
```

Facts that matter, because common assumptions are wrong:

- **It is Mocha, not the Node test runner.** `mocha ^12` is a hard dependency. The toolkit's Node suite
  uses `node --test`; migrating is a real decision, not a config change.
- The config flag is **`--config <path>`**, not `--vscode-test-config`.
- Its **web** configuration type is annotated in source as *"incomplete, and does not yet function"* —
  use `@vscode/test-web` directly for web tests.
- Node floor across the toolchain is now **22** (`test-electron` 3.0.0 made it breaking in June 2026).

## 2. `@vscode/test-electron` — what it actually launches

`runTests()` starts a real VS Code with, among others:
`--no-sandbox --disable-gpu-sandbox --disable-updates --skip-welcome --skip-release-notes
--no-cached-data --disable-workspace-trust --extensionTestsPath=… --extensionDevelopmentPath=…`
and, unless you pass your own, `--extensions-dir=.vscode-test/extensions --user-data-dir=.vscode-test/user-data`
([lib/runTest.ts](https://github.com/microsoft/vscode-test/blob/main/lib/runTest.ts)).

- The version option is **`version`** (`'stable' | 'insiders' | '1.143.1' | <commit>`). There is **no
  `quality` option** in this package (that belongs to `@vscode/test-web`), and **no public
  `resolveLatestVersion`** — the internal inference reads `engines.vscode` from every
  `extensionDevelopmentPath` and picks the newest stable that satisfies it
  ([lib/download.ts](https://github.com/microsoft/vscode-test/blob/main/lib/download.ts)).
- **Electron has no headless mode.** On Linux CI you need a display: Microsoft's own sample runs
  `/usr/bin/Xvfb :99 -screen 0 1024x768x24 &` with `DISPLAY=:99.0`
  ([Continuous Integration](https://code.visualstudio.com/api/working-with-extensions/continuous-integration)).
- Extension tests can only run if **no other VS Code instance is running** — a real constraint when the
  developer has the Extension Development Host open.
- 32-bit Windows is gone for VS Code ≥ 1.85; server builds (`code-server`) are downloadable but are not in
  the typed platform union.

## 3. UI-level testing: Red Hat's ExTester

`extest setup-and-run './out/ui-test/**/*.test.js'` downloads VS Code + the matching ChromeDriver, packages
the extension with `vsce`, installs it, launches the editor and runs Mocha tests against the real workbench
([README](https://github.com/redhat-developer/vscode-extension-tester)).

- **Selenium, not Playwright.** `vscode-extension-test-api` no longer exists on npm; it is now
  `@redhat-developer/page-objects` + `@redhat-developer/locators`.
- **No headless mode exists.** Red Hat's own CI uses
  `xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24'` on Linux and runs Windows/macOS directly.
- Support window: the **published** 8.28.1 package records `supportedVersions: {vscode-min: 1.138.0,
  vscode-max: 1.140.0}`; the repository's current `package.json` records 1.141.2–1.143.1. **Verify the
  published package, not the repo** — this is the same lesson as a lockfile: the artifact is the truth.
  Hard floor is 1.90.0 (older VS Code ships a Chromium whose ChromeDriver can no longer be provisioned).
- Permanent limitation: since VS Code 1.87 the `title` attribute of `<select>` elements is not set on
  Windows/Linux ([microsoft/vscode#206897](https://github.com/microsoft/vscode/issues/206897), closed
  as not-planned), so some page objects throw there.
- Ubuntu 24.04 runners need `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0`.

## 4. What Microsoft uses on itself

`microsoft/vscode`'s `test/automation` (package `vscode-automation`, `"private": true`, **not on npm**) is now
**Playwright-based**: `playwright._electron.launch({ executablePath, args, recordVideo … })` plus the workbench
driver protocol enabled by `--enable-smoke-test-driver`. `vscode-automation-cli` is gone from both npm and the
repo. New surfaces cover the Agents window and chat; there is a new `test/scenario` runner
([test/automation](https://github.com/microsoft/vscode/tree/main/test/automation)).

Practical translation for an extension author: if you want Playwright on the desktop UI, write your own
`playwright._electron.launch()` harness around the VS Code binary with `--extensionDevelopmentPath`.
No community Playwright workbench driver was found (absence of evidence, not proof).

## 5. CLI flags: documented vs merely parsed

Determined from [`src/vs/platform/environment/node/argv.ts`](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/argv.ts):
`code --help` prints only options that have both a `description` and a category. So:

| Documented | Parsed but undocumented |
|---|---|
| `--install-extension <vsix>` (`--force`, `--pre-release`), `--list-extensions --show-versions`, `--uninstall-extension`, `--extensions-dir`, `--user-data-dir`, `--profile`, `--disable-extensions`, `--disable-extension`, `--enable-proposed-api`, `--transient`, `--status`, `--prof-startup`, `--verbose`, `--log`, `--disable-gpu`, `--disable-chromium-sandbox`, `--locale`, `--remote <authority>`, `--add-mcp` | `--extensionDevelopmentPath`, `--extensionTestsPath`, `--extensionDevelopmentKind`, `--extensionEnvironment`, `--disable-workspace-trust`, `--crash-reporter-directory`, `--no-sandbox`, `--disable-gpu-sandbox`, `--disable-updates`, `--skip-welcome`, `--skip-release-notes`, `--no-cached-data`, `--force-user-env`, `--enable-smoke-test-driver`, `--logsPath`, `--use-inmemory-secretstorage`, `--shared-data-dir` |

Two that are worth adopting in this project's scripts:

- **`--transient`** — "Run with temporary data and extension directories, as if launched for the first
  time." One flag instead of hand-managed `--user-data-dir`/`--extensions-dir`, for hermetic install tests.
- **`--extensionDevelopmentKind`** — force ui / workspace / web target while developing, which is how you
  test the extension-host split without a remote machine.

## 6. Packaging and publishing changes in 2026

- **`vsce publish --oidc`** (Trusted Publishing) publishes from GitHub Actions with
  `permissions: { id-token: write }` and no stored PAT. Global Azure DevOps PATs are **retired
  1 December 2026** ([Publishing Extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)).
  If this toolkit is published anywhere, its credential path must move before that date.
- Extension versions must be `major.minor.patch`; **pre-release tags like `1.2.3-beta.1` are not accepted**
  by the Marketplace — use `--pre-release` with an odd patch number. This confirms the toolkit's own rule
  (0.3.6.1 was unpackageable) and its test `test_release_version_is_one_vsce_can_package`.
- `engines.vscode` semantics: `1.8.0` is exact, `^1.8.0` means "1.8.0 and onwards"; date tags
  (`^1.56.0-20210428`) target Insiders builds.
- `vsce ls --tree` exists and is the quickest artifact review — the toolkit already uses it in
  `npm run package` output.

## 7. The version matrix worth running

Three VS Code versions, not one:

1. the **floor** named in `engines.vscode` (what your users on old installs get),
2. the **latest stable** (1.145.0 today),
3. **Insiders** (1.146.0-insider today) — the early-warning channel.

ExTester's own CI is `{ubuntu, macOS, windows} × {min, max}` plus a separate Insiders workflow. That is the
shape to copy.
