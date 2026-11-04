# 04 · Getting a real Windows: the options in November 2026, and what each one is good for

Facts below were fetched from primary sources on 4 November 2026 by a research delegation and spot-checked
by me (the `dockur/windows` repository, the GitHub runner-image table, and the CPython/PEP pages were
re-verified independently). Claims that could not be verified are labelled.

## The short answer

| Route | Real Windows semantics? | Automatable? | Cost | Use it for |
|---|---|---|---|---|
| GitHub Actions `windows-latest` | yes (Windows Server 2025) | fully | free on public repos; ~$0.010/min private | the always-on Windows signal in CI |
| `dockur/windows` (QEMU in a container) | yes | fully (`/oem` + `install.bat`) | free software, needs `/dev/kvm` | a repeatable reference VM you own |
| QEMU/KVM + Windows 11 Enterprise eval ISO | yes | semi (RDP/SSH/WinRM) | free, 90-day eval | the one-off host a human tests on |
| Wine 11.x | **partial** — code pages are wrong by default | fully | free | smoke-testing Windows *binaries*, not Windows semantics |
| ReactOS 0.4.16 | no (different OS) | semi | free | curiosity |
| Microsoft Dev Box | yes | — | **retiring: closing-down period began 2026-09-14, service ends 2028-09-18** | avoid for new work |
| Windows 365 / Azure Virtual Desktop | yes | semi | per-user licence (prices not verified) | a human tester with no local hypervisor |

---

## 1. Hosted Windows CI — the cheapest real Windows

- `windows-latest` = **Windows Server 2025 x64**; labels `windows-2025`, `windows-2025-vs2026`,
  `windows-2022`, and arm64 `windows-11-arm` / `windows-11-vs2026-arm`
  ([actions/runner-images](https://github.com/actions/runner-images/blob/main/README.md)).
- What is on the Windows 2025 image (build `20261030.317.1`): Node 22.23.4 (cached 24.22.2), Python 3.12.10
  default with 3.11/3.13/3.14/**3.15.2** cached, **Chocolatey 2.7.5**, PowerShell 7.6.9, Docker 29.7.2,
  Git 2.56, InnoSetup, WiX, CMake, WinAppDriver, WSL2 3.0.3.0. **VS Code is not installed** — install it with
  `choco install vscode`. Scoop and winget are absent.
- **No `/dev/kvm`, no nested virtualisation** on GitHub-hosted runners (documented for macOS; confirmed for
  Linux by [actions/runner-images#183](https://github.com/actions/runner-images/issues/183) and a dedicated
  test repo reporting "KVM/Libvirt is not supported on shared runners"). So a Windows *VM inside* a hosted
  job is out; a Windows *runner* is in.
- Billing (2026 model): public repos free; private repos draw included compute
  (Free $12/mo, Pro $18/mo) at **$0.010/min for a 2-core Windows runner** vs $0.006 Linux
  ([GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)).
  Self-hosted runners are free to use, and are the route that makes a KVM-capable Windows VM usable in CI.
- Azure Pipelines uses the same images and gives 1 free parallel job up to 1,800 min/month; AppVeyor has a
  free OSS plan with a 60-minute job cap.

**For this toolkit:** a `windows-latest` job that runs `node --test` over `extension/test/` converts every
"SHAPE TEST (not Windows proof)" into a behaviour test for free, on a public repository. That is the single
highest-value CI change available.

## 2. `dockur/windows` — Windows in a container, on your own KVM host

- 54,082 stars, last push 2026-11-02; `dockurr/windows` has 3.46 M pulls
  ([repo](https://github.com/dockur/windows)). QEMU inside a container, hands-free Windows install, web
  viewer on 8006, RDP on 3389.
- **Requires `/dev/kvm`** (`devices: [/dev/kvm, /dev/net/tun]`, `NET_ADMIN`, ≥2 GB RAM, ≥32 GB disk). Its own
  README says Docker Desktop on Linux/macOS/Windows 10 does not provide KVM to containers.
- Versions installable include `11`, `11e`, `11l`, `10`, `2025`, `2022`, Server Core editions, `tiny11`, and
  even `reactos`. ARM64 Windows via `dockur/windows-arm`.
- Automation hooks that matter: bind a folder to **`/oem`** → copied to `C:\OEM` with **`install.bat` run
  automatically**; `COMMAND:` for a single post-install command; `LANGUAGE`/`REGION`/`KEYBOARD`,
  `USERNAME`/`PASSWORD`, `RAM_SIZE`/`CPU_CORES`/`DISK_SIZE`, `VMX`, `HV`, `DISPLAY=web|vnc|disabled`.
  Bind `./share:/shared` → appears as drive **`Z:`** in the guest, which is how you hand the toolkit's
  VSIX and test workspace to Windows.
- Legality, in their own words: the project ships no Windows bits; the keys in it are generic trial keys;
  the licence is your responsibility.
- `blacktop/windows-box`, mentioned in older write-ups, **does not exist any more** (repo and Docker Hub both
  404 on 2026-11-04). Do not plan around it.

```yaml
services:
  windows:
    image: dockurr/windows
    environment: { VERSION: "11", RAM_SIZE: "8G", CPU_CORES: "4", DISK_SIZE: "64G",
                   USERNAME: "dev", PASSWORD: "Passw0rd!" }
    devices: ["/dev/kvm", "/dev/net/tun"]
    cap_add: ["NET_ADMIN"]
    ports: ["8006:8006", "3389:3389", "2222:22"]
    volumes: ["./win:/storage", "./oem:/oem", "./share:/shared"]
    stop_grace_period: 2m
```

In-guest automation: install the in-box OpenSSH Feature on Demand
(`Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0`) or enable WinRM and drive it with
`pywinrm` 0.5.0; `xfreerdp` (FreeRDP 3.33.0, 2026-11-02) for the human path.

## 3. Plain QEMU/KVM with a Microsoft evaluation ISO

- Windows 11 needs **UEFI + Secure Boot + TPM 2.0**: QEMU emulates the TPM with `swtpm`; a wrong
  `edk2-ovmf` vars file makes Setup claim "no TPM 2.0". **Virtio drivers are not in Windows** — attach
  `virtio-win.iso` as a second CD ([Arch wiki QEMU](https://wiki.archlinux.org/title/QEMU),
  [virtio-win](https://github.com/virtio-win/virtio-win-pkg-scripts)).
- `virt-install` supports `--boot uefi`, `--tpm emulator`, `--osinfo detect=on,require=on`
  ([man page](https://manpages.debian.org/bookworm/virtinst/virt-install.1.en.html)).
- **Microsoft's free evaluation ISO is current**: Windows 11 Enterprise (26H2) and LTSC, 90-day evaluation;
  on expiry the machine "shuts down every hour"
  ([Evaluation Center](https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise)).
- ⚠️ The old "Windows 11 for development" prebuilt VM image page now redirects to
  learn.microsoft.com/windows/dev-environment and no longer offers downloadable images. Plan on an eval ISO,
  not a prebuilt image.
- **PowerShell Direct is not available from Linux** (it needs a Hyper-V host). Use SSH, WinRM or RDP.

## 4. Wine: useful, and wrong in a specific, knowable way

- Wine stable **11.0** (2026-01-13); development line 11.21 (2026-10-30). Proton is a game-tuned fork; use
  plain Wine for CLI/productivity work.
- What Wine genuinely implements (verified in source): `GetConsoleCP`/`GetConsoleOutputCP` and the
  `SetConsole*` family (`dlls/kernelbase/console.c`); `chcp.com` as a real program with the same
  "redirected output falls back to `GetOEMCP()`" quirk Windows has; `PATHEXT` walking in `cmd`
  (`programs/cmd/wcmdmain.c`); drive letters; emulated Windows version via winecfg/`winetricks win11`.
- **The trap:** Wine's default code page is derived from the **Unix locale**
  (`init_unix_codepage()` maps `nl_langinfo(CODESET)`; `UTF8 → 65001`), exported to children as
  `WINEUNIXCP`. On a normal `LANG=en_US.UTF-8` Linux box a Wine prefix reports **65001, not cp1252**. A
  code-page test run under a default Wine prefix will therefore *pass* while the real Windows host fails.
  Force it (`WINEUNIXCP=1252`, a non-UTF-8 locale, or `chcp` inside the guest) or do not claim coverage.
- `cmd` is an independent reimplementation: quoting, `for`, `call`, redirection edge cases are not
  guaranteed identical.
- Electron desktop apps under Wine are fragile in 2026 (clipboard/font integration and **subprocess
  handling** break — reported for Claude Desktop, an Electron app). **Use the native Linux VS Code**; use
  Wine only for Windows binaries (`python.exe`, `uv.exe`, `npm.cmd`). ⚠️ The Wine AppDB rating for VS Code
  could not be read from this environment (WineHQ is behind a bot challenge) — check it yourself.
- Automation hazard worth knowing before you script it: `wine` starts `wineserver`/`services.exe` that keep
  the caller's pipes open, so a naive `spawnSync("wine", …)` in a test harness hangs.

## 5. What each option cannot do

| Cannot be reproduced | Wine | QEMU/dockur VM | GitHub `windows-latest` |
|---|---|---|---|
| cp1252/cp437 defaults, `chcp`, ConPTY | ✘ (UTF-8 by default) | ✔ | ✔ |
| `cmd.exe` quoting exactly as Windows | ✘ (reimplementation) | ✔ | ✔ |
| `taskkill /T`, job objects, `ERROR_SHARING_VIOLATION` | partial | ✔ | ✔ |
| Defender / SmartScreen / Mark-of-the-Web on a downloaded VSIX | ✘ | ✔ | ✔ |
| The user's real machine (their AV, their profile, their mapped drives) | ✘ | ✘ | ✘ |
| Nested `/dev/kvm` in the job | n/a | n/a | ✘ |

The last row is why a **field host** is a separate gate and never a CI job.
