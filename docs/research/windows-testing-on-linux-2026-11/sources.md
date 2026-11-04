# Sources

All fetched 4 November 2026 from this host. The session's `web_search` tool returned no results, so every
source below was fetched directly (npm registry, GitHub raw files, Microsoft Learn, code.visualstudio.com,
docs.python.org, peps.python.org, nodejs.org, update.code.visualstudio.com, jrsoftware.org, Docker Hub).
Items marked ⚠️ could **not** be verified against a primary source and are recorded as such.

## CPython and encoding

| Source | What it establishes |
|---|---|
| [sys — standard streams](https://docs.python.org/3/library/sys.html) | On Windows, UTF-8 for the console device; **the ANSI code page for pipes and redirected files**; stderr is `backslashreplace` |
| [PEP 540](https://peps.python.org/pep-0540/) | The authoritative table: piped Windows stdio uses `mbcs`; "There is no POSIX locale on Windows" |
| [PEP 528](https://peps.python.org/pep-0528/), [PEP 529](https://peps.python.org/pep-0529/) | Windows console I/O via `ReadConsoleW`/`WriteConsoleW`; filesystem encoding UTF-8 |
| [PEP 686](https://peps.python.org/pep-0686/) | **Final**, Python 3.15: UTF-8 mode becomes the default; `PYTHONUTF8=0` / `-X utf8=0` to disable |
| [Using Python on Windows](https://docs.python.org/3/using/windows.html) | UTF-8 mode section; long-path registry requirement; 3.15 change note |
| [Command line / environment](https://docs.python.org/3/using/cmdline.html) | `-I` implies `-E`/`-s`; `PYTHONIOENCODING` caveats; `PYTHONLEGACYWINDOWSSTDIO`, `PYTHONLEGACYWINDOWSFSENCODING` |
| [os](https://docs.python.org/3/library/os.html) | `os.killpg` is Unix-only; `os.kill` on Windows calls `TerminateProcess` |
| [subprocess](https://docs.python.org/3/library/subprocess.html) | `kill()` == `terminate()` on Windows; `CREATE_NO_WINDOW`, `CREATE_NEW_PROCESS_GROUP`; 3.12 hardened `shell=True` cmd search order |
| [signal](https://docs.python.org/3/library/signal.html) | Only SIGABRT/SIGFPE/SIGILL/SIGINT/SIGSEGV/SIGTERM/SIGBREAK on Windows |
| [json](https://docs.python.org/3/library/json.html) | `ensure_ascii=True` guarantees escaped output |
| [python.org/downloads](https://www.python.org/downloads/) | Stable CPython is 3.15.2, so PEP 686 is live |
| ⚠️ `pathlib.Path.home()` / `os.path.expanduser()` Windows behaviour | not fetched from primary docs |

## Windows platform semantics (Microsoft Learn)

| Source | What it establishes |
|---|---|
| [Naming a File](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) | Reserved names incl. `NUL.txt`, `COM¹`; illegal characters; no trailing space/period; 8.3 short names; NTFS case sensitivity is not the default |
| [Maximum Path Length Limitation](https://learn.microsoft.com/en-us/windows/win32/fileio/maximum-file-path-limitation) | MAX_PATH 260; `\\?\` forbids `/`, `.`, `..`, relative paths; `LongPathsEnabled` **and** `longPathAware` manifest; per-process caching |
| [Console Code Pages](https://learn.microsoft.com/en-us/windows/console/console-code-pages), [GetConsoleOutputCP](https://learn.microsoft.com/en-us/windows/console/getconsoleoutputcp), [SetConsoleOutputCP](https://learn.microsoft.com/en-us/windows/console/setconsoleoutputcp) | two code pages per console; raster-font caveat; "use Unicode instead" |
| [chcp](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/chcp) | OEM vs ANSI; already-started programs keep the old code page; 65001 not in the documented list |
| [Code Page Identifiers](https://learn.microsoft.com/en-us/windows/win32/intl/code-page-identifiers) | the code page catalogue |
| [Use UTF-8 code pages in Windows apps](https://learn.microsoft.com/en-us/windows/apps/design/globalizing/use-utf8-code-page) | the beta system-wide UTF-8 ACP and per-process `activeCodePage` manifest |
| [CreatePseudoConsole](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole) | ConPTY is UTF-8 end-to-end |
| [CreateProcessW](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw) | raw command line handed to the callee; `CREATE_UNICODE_ENVIRONMENT`; 32,767-char ANSI env block limit |
| [Parsing C command-line arguments](https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments) | the backslash-before-quote rule |
| [Everyone quotes command line arguments the wrong way](https://learn.microsoft.com/en-us/archive/blogs/twistylittlepassagesallalike/everyone-quotes-command-line-arguments-the-wrong-way) | cmd as a text preprocessor; the `"…\" &whoami` injection |
| [cmd](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd), [taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill), [subst](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/subst) | `/c` quote-stripping rules; `taskkill /T /F`; mapped drives |
| [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) | the real Windows process-group mechanism |
| [Environment Variables](https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables), [about_Environment_Variables](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables) | case-insensitive names on Windows vs case-sensitive on Linux/macOS |
| [about_Character_Encoding](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_character_encoding) | PS 5.1 UTF-16LE `>`/`Out-File`, `$OutputEncoding` ASCII default; PS 7 `utf8NoBOM`; CRLF when piping to native programs |
| [Symbolic links](https://learn.microsoft.com/en-us/windows/win32/fileio/symbolic-links), [Create symbolic links](https://learn.microsoft.com/en-us/windows/security/threat-protection/security-policy-settings/create-symbolic-links), [Hard Links and Junctions](https://learn.microsoft.com/en-us/windows/win32/fileio/hard-links-and-junctions) | `SeCreateSymbolicLinkPrivilege`, Developer Mode, junctions via reparse points |
| [File Streams](https://learn.microsoft.com/en-us/windows/win32/fileio/file-streams) | NTFS alternate data streams |
| [Configure process and opened file exclusions (Defender)](https://learn.microsoft.com/en-us/microsoft-365/security/defender-endpoint/configure-process-opened-file-exclusions-microsoft-defender-antivirus) | AV interferes with spawned processes; exclusions are a supported answer |
| [Process Monitor](https://learn.microsoft.com/en-us/sysinternals/downloads/procmon), [Process Explorer](https://learn.microsoft.com/en-us/sysinternals/downloads/process-explorer), [wevtutil](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/wevtutil), [Start-Transcript](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.host/start-transcript) | the Windows diagnostics a tester should collect |
| ⚠️ Mark-of-the-Web / `Zone.Identifier` | no current Microsoft Learn page found (15 candidate slugs 404'd); mechanism verified only as "NTFS ADS" plus real issue reports |
| ⚠️ `PATHEXT` | no current Learn page; behaviour verified indirectly via Node docs and [vscode#344072](https://github.com/microsoft/vscode/issues/344072) |

## Node.js

| Source | What it establishes |
|---|---|
| [child_process](https://nodejs.org/api/child_process.html) | `.bat`/`.cmd` cannot be `execFile`d; `windowsHide` default false; `detached` only in `spawn`; Windows signal mapping (`SIGWINCH` → `ENOSYS`, unknown → `ERR_UNKNOWN_SIGNAL`); env names case-insensitive when spawning, **first lexicographic match wins**; default shell from `ComSpec` |
| [process](https://nodejs.org/api/process.html) | `process.env` case-insensitive on Windows; `process.kill(pid, 0)` tests existence but "Windows platforms will throw an error if the pid is used to kill a process group" |
| [path](https://nodejs.org/api/path.html) | `path.toNamespacedPath` (the `\\?\` form); Windows accepts both separators |
| [os](https://nodejs.org/api/os.html) | `os.homedir()` uses `USERPROFILE`; `os.userInfo()` uid/gid `-1`; `os.EOL`; `os.devNull` |
| [deprecations DEP0190](https://nodejs.org/api/deprecations.html) | `shell:true` with args is a **runtime deprecation** in Node 24 |
| [node/lib/child_process.js](https://github.com/nodejs/node/blob/main/lib/child_process.js), [lib/path.js](https://github.com/nodejs/node/blob/main/lib/path.js) | the exact option whitelist `execFile` forwards; `_makeLong` == `toNamespacedPath` (DEP0080) |
| Measured here, Node v24.22.0 | `path.win32` works on Linux for normalize/parse/relative; `isAbsolute("/unix/path") === true`; `resolve()` uses the POSIX cwd; **no `path.win32.normcase`** |

## VS Code

| Source | What it establishes |
|---|---|
| [Testing extensions](https://code.visualstudio.com/api/working-with-extensions/testing-extension) | `@vscode/test-cli` + `@vscode/test-electron`; `version` (not `--quality`); "only supported if no other instance of Code is running" |
| [Continuous Integration](https://code.visualstudio.com/api/working-with-extensions/continuous-integration) | "In headless Linux CI machines `xvfb` is required"; the three-OS sample |
| [Publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) | **publish from Linux** (Windows builds lose POSIX exec bits); `--target` platform-specific VSIX (vsce ≥1.99.0); Trusted Publishing `--oidc`; **global Azure DevOps PATs retire 2026-12-01**; `engines.vscode`; verified publisher; `--pre-release` |
| [Extension manifest reference](https://code.visualstudio.com/api/references/extension-manifest), [Remote extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions) | `extensionKind` ui/workspace/both; a workspace extension runs in the remote host, so `process.platform` is the remote OS |
| [Setup on Windows](https://code.visualstudio.com/docs/setup/windows) | Inno Setup installer, `/mergetasks=!runcode`; `%USERPROFILE%\.vscode\extensions` |
| [Command line interface](https://code.visualstudio.com/docs/configure/command-line) | `--install-extension`, `--list-extensions --show-versions`, `--user-data-dir`, `--extensions-dir`, `--disable-gpu`, `--upload-logs` |
| [src/vs/platform/environment/node/argv.ts](https://github.com/microsoft/vscode/blob/main/src/vs/platform/environment/node/argv.ts) | the real flag set incl. `--no-sandbox`, `--logsPath`, `--crash-reporter-directory` |
| [Developing in WSL](https://code.visualstudio.com/docs/remote/wsl), [Remote-SSH](https://code.visualstudio.com/docs/remote/ssh), [What is WSL?](https://learn.microsoft.com/en-us/windows/wsl/about) | VS Code Server installed inside WSL; no shell startup scripts run |
| [Terminal profiles](https://code.visualstudio.com/docs/terminal/profiles) | the integrated terminal has its own env (`terminal.integrated.env.<platform>`), separate from the extension host |
| [Native Crash Issues (wiki)](https://github.com/microsoft/vscode/wiki/Native-Crash-Issues) | `--crash-reporter-directory` → `.dmp`; symbolication needs a macOS/Linux device |
| [Telemetry guide](https://code.visualstudio.com/api/extension-guides/telemetry) | `@vscode/extension-telemetry`, `isTelemetryEnabled` |
| [update.code.visualstudio.com/api/update/win32-x64-archive/stable/latest](https://update.code.visualstudio.com/api/update/win32-x64-archive/stable/latest) | live: VS Code **1.145.0** with `sha256hash` |
| [vscode-test](https://github.com/microsoft/vscode-test), [vscode-test-cli](https://github.com/microsoft/vscode-test-cli) | `runTests`/`downloadAndUnzipVSCode`, `win32-x64-archive` default, `defineConfig` with `version` |
| npm registry (measured here) | `@vscode/test-cli` 0.0.15, `@vscode/test-electron` 3.1.0 (Node ≥22), `@vscode/test-web` 0.0.81, `vscode-extension-tester` 8.28.1 (published `supportedVersions` 1.138.0–1.140.0), `@vscode/vsce` 4.1.0, `ovsx` 1.3.0 (`--trusted-publishing`, `ovsx verify`) |
| Windows-only VS Code defects (GitHub API) | [#344072](https://github.com/microsoft/vscode/issues/344072) stripped env → git/gh/node/python not recognised; [#332707](https://github.com/microsoft/vscode/issues/332707) `APPDATA` stripped → NuGet fails; [#344012](https://github.com/microsoft/vscode/issues/344012) `0xc0000142` on shutdown; [#320573](https://github.com/microsoft/vscode/issues/320573) orphaned child; [#137481](https://github.com/microsoft/vscode/issues/137481) console windows pop up; [#300594](https://github.com/microsoft/vscode/issues/300594) long paths in Extensions view; [#262667](https://github.com/microsoft/vscode/issues/262667) `Zone.Identifier` is a stream not a file; [#284872](https://github.com/microsoft/vscode/issues/284872) BOM breaks PowerShell; [vscode-python#24525](https://github.com/microsoft/vscode-python/issues/24525) venv not found on a mapped drive |

## CI

| Source | What it establishes |
|---|---|
| [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) | runner labels incl. `windows-2025`, `windows-11-arm`; no nested virtualisation on macOS runners |
| [Windows2025-Readme.md](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md) | image 20261030.317.1: Node 22.23.4, Python 3.12.10 (3.15.2 cached), Chocolatey 2.7.5, PowerShell 7.6.9, WSL2 3.0.3.0; **VS Code, Scoop, winget not installed** |
| [Ubuntu2404-Readme.md](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md) | `xvfb` is preinstalled |
| [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions) | public repos free; Windows 2-core $0.010/min vs Linux $0.006 |
| [actions/runner-images#183](https://github.com/actions/runner-images/issues/183), [josecelano/github-actions-virtualization-support](https://github.com/josecelano/github-actions-virtualization-support) | no `/dev/kvm` on shared runners |
| [Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) | up to 50 re-runs per run |
| [microsoft/vscode pr-win32-test.yml](https://github.com/microsoft/vscode/blob/main/.github/workflows/pr-win32-test.yml), [listprocesses.bat](https://github.com/microsoft/vscode/blob/main/build/azure-pipelines/win32/listprocesses.bat) | `--rerun-failed-files 2`, `tasklist /V` on `always()`, crash-dump artifacts named with `github.run_attempt` |
| [vscode-python pr-check.yml](https://github.com/microsoft/vscode-python/blob/main/.github/workflows/pr-check.yml) | platform-specific VSIX builds; `working-directory: './path with spaces'`; no macOS leg |
| [vscode-jupyter build-test.yml](https://github.com/microsoft/vscode-jupyter/blob/main/.github/workflows/build-test.yml), [aggregate-test-results.yml](https://github.com/microsoft/vscode-jupyter/blob/main/.github/workflows/aggregate-test-results.yml) | reduced-but-present Windows subset; logs on `failure()`; daily flake aggregation |
| [vscode-gitlens ci.yml](https://github.com/eamodio/vscode-gitlens/blob/main/.github/workflows/ci.yml), [vscode-java pr-verify.yml](https://github.com/redhat-developer/vscode-java/blob/main/.github/workflows/pr-verify.yml) | counter-examples: no Windows E2E / no Windows job at all |
| [vscode-vsce ci.yml](https://github.com/microsoft/vscode-vsce/blob/main/.github/workflows/ci.yml) | three-OS matrix plus a Linux-only keyring isolation test |
| [vscode-vsce src/package.ts](https://github.com/microsoft/vscode-vsce/blob/main/src/package.ts) | `SOURCE_DATE_EPOCH` pins ZIP mtimes **and** sorts entries |
| [Inno Setup command line](https://jrsoftware.org/ishelp/index.php?topic=setupcmdline) | `/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /MERGETASKS=`; ⚠️ `/MERGEENTASKS` not documented |
| [Chocolatey vscode package](https://community.chocolatey.org/packages/vscode), [winget manifest](https://github.com/microsoft/winget-pkgs/tree/master/manifests/m/Microsoft/VisualStudioCode) | `choco install vscode`, `Microsoft.VisualStudioCode`, `InstallerSha256` sidecar precedent |
| [Shift right to test in production](https://learn.microsoft.com/en-us/devops/deliver/shift-right-test-production), [deployment rings](https://learn.microsoft.com/en-us/windows/deployment/update/create-deployment-plan) | the field/insider-cohort vocabulary behind a "field host" gate |

## Python packaging and test runners

| Source | What it establishes |
|---|---|
| [uv resolution](https://docs.astral.sh/uv/concepts/resolution/), [uv CLI](https://docs.astral.sh/uv/reference/cli/) | `uv.lock` is a universal, portable resolution; `--python-platform windows`; `--locked` vs `--frozen`; `sys_platform == 'win32'` even on 64-bit; hardlink cache on Windows |
| [tox config](https://tox.wiki/en/latest/reference/config.html) | `testenv.platform` regex against `sys.platform`; `{/}` path separator |
| [pytest skipping](https://docs.pytest.org/en/stable/how-to/skipping.html), [tmp_path](https://docs.pytest.org/en/stable/how-to/tmp_path.html) | `skipif`/`xfail` conditions; `%TEMP%`-based temp tree depth vs MAX_PATH |
| [PEP 425](https://peps.python.org/pep-0425/) | wheel tags; pure-Python `*-none-any` means one VSIX is correct |

## Running Windows on a Linux host

| Source | What it establishes |
|---|---|
| [dockur/windows](https://github.com/dockur/windows), [docs/environment.md](https://github.com/dockur/windows/blob/master/docs/environment.md) | QEMU-in-a-container Windows; **`/dev/kvm` required**; `/oem` + `install.bat`; `Z:` share; version list; licence disclaimer |
| [Arch wiki QEMU](https://wiki.archlinux.org/title/QEMU), [virtio-win](https://github.com/virtio-win/virtio-win-pkg-scripts), [virt-install(1)](https://manpages.debian.org/bookworm/virtinst/virt-install.1.en.html) | Windows 11 needs UEFI + Secure Boot + TPM 2.0 (`swtpm`); virtio drivers are not in Windows |
| [Microsoft Evaluation Center](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise) | free 90-day Windows 11 Enterprise ISO; hourly shutdown after expiry |
| [PowerShell Direct](https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/user-guide/powershell-direct), [OpenSSH on Windows](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse), [pywinrm](https://pypi.org/project/pywinrm/), [FreeRDP](https://github.com/FreeRDP/FreeRDP/releases) | how to drive a Windows guest from Linux |
| [Wine source: `dlls/ntdll/unix/env.c`](https://github.com/wine-mirror/wine/blob/master/dlls/ntdll/unix/env.c), [`dlls/kernelbase/console.c`](https://github.com/wine-mirror/wine/blob/master/dlls/kernelbase/console.c), [`programs/chcp.com/main.c`](https://github.com/wine-mirror/wine/blob/master/programs/chcp.com/main.c), [`programs/cmd/wcmdmain.c`](https://github.com/wine-mirror/wine/blob/master/programs/cmd/wcmdmain.c) | Wine implements console code-page APIs, `chcp.com`, `PATHEXT` — but its default code page comes from the **Unix locale** (`WINEUNIXCP`, UTF-8 by default) |
| [Wine `VERSION`](https://github.com/wine-mirror/wine/blob/master/VERSION), [Wikidata Q188558](https://www.wikidata.org/wiki/Q188558) | Wine 11.0 stable (2026-01-13), 11.21 development (2026-10-30) |
| [claude-code#65697](https://github.com/anthropics/claude-code/issues/65697), [arcgis-gitops#314](https://github.com/Esri/arcgis-gitops/issues/314), [caffeinate#2](https://github.com/zet235/caffeinate/pull/2) | Electron apps under Wine break (clipboard, fonts, **subprocess handling**); `wine` holds the caller's pipes open; `.cmd` shims need PATHEXT walking |
| [Dev Box retirement guide](https://learn.microsoft.com/en-us/azure/dev-box/dev-box-retirement-guide), [Windows 365](https://learn.microsoft.com/en-us/windows-365/overview), [AVD licensing](https://learn.microsoft.com/en-us/azure/virtual-desktop/licensing) | Dev Box closing-down from 2026-09-14, ends 2028-09-18 → not a new choice |
| [reactos.org](https://reactos.org/) | ReactOS 0.4.16 (2026-08-29) |
| ⚠️ Wine AppDB rating for VS Code | WineHQ is behind a bot challenge from this host; not read |
| ⚠️ `blacktop/windows-box` | repo and Docker Hub both 404 on 2026-11-04 — treat as gone |

## Measured on this host (not a citation, an observation)

Kernel `6.18.33.1-microsoft-standard-WSL2`, Debian 13, Node v24.22.0, Python 3.12.16, uv 0.13.6. Repository
and the field workspace are both on `K:\` via 9p drvfs (`stat -f` → `v9fs`); `/data/dsh` is ext4; `/tmp` is
overlayfs. No `cmd.exe`/`powershell.exe`/`taskkill.exe`/`chcp` on PATH, no `/mnt/c`, no `/etc/wsl.conf`, no
`wine`, `qemu`, `docker`, `/dev/kvm`, `Xvfb`, `gcc`, `make`. Locales available: `C`, `C.utf8`, `POSIX`.
Full transcript: [probes/measured-output.txt](probes/measured-output.txt).
