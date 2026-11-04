# Testing Windows-targeted software from Linux — VS Code extensions and their Python workers

Research report for **Research Stack Toolkit**, compiled **4 November 2026**.

The question was: *how do you test Windows-located software on a Linux-focused development setup, with VS
Code and its extensions as the concrete case?* The intent is not a survey — it is a set of practices this
project should adopt so that the next Windows defect is caught before a user finds it.

Why this matters concretely: release 0.3.7 shipped a defect that **only existed on Windows** — the Python
worker wrote its JSON report through a cp1252 pipe and crashed on `č` in a Czech workspace path, after the
real work had already succeeded. Every local test passed. 0.3.8 fixed it. This report is about not needing a
user to be the one who finds the next one.

## Read in this order

| File | What it answers |
|---|---|
| [methodology.md](methodology.md) | **The deliverable.** The fidelity ladder, the five claim labels, the per-release protocol, and 14 ranked next actions. |
| [01-what-linux-cannot-fake.md](01-what-linux-cannot-fake.md) | What a Linux machine genuinely can and cannot reproduce, with measurements from this host. |
| [02-vscode-testing-toolchain-2026.md](02-vscode-testing-toolchain-2026.md) | The current VS Code extension testing tools and their real limits: `@vscode/test-cli`, `test-electron`, `test-web`, `vscode-extension-tester`, Playwright, `vsce`, `ovsx`. |
| [03-this-host-wsl2-with-the-windows-drive.md](03-this-host-wsl2-with-the-windows-drive.md) | **The surprise finding:** this development host is WSL2 on the machine that reported the defect, and the repository sits on `K:\` through a 9p mount — real NTFS semantics, already available and unused. |
| [04-getting-a-real-windows.md](04-getting-a-real-windows.md) | Hosted CI, `dockur/windows`, QEMU/KVM with an evaluation ISO, Wine — what each can and cannot prove, and what each costs in November 2026. |
| [05-ci-playbook.md](05-ci-playbook.md) | Concrete workflow YAML for this repository, what each job may claim, evidence receipts, and the 1 December 2026 publishing deadline. |
| [06-windows-semantics-checklist.md](06-windows-semantics-checklist.md) | Encoding, paths, processes, environment, VS Code specifics — each mapped to **handled / gap / needs Windows proof** against the 0.3.8 code. |
| [sources.md](sources.md) | Every source, what it establishes, and what could not be verified. |
| [probes/](probes/) | The two probes written for this report and their captured output: [codepage_probe.py](probes/codepage_probe.py), [path_budget.py](probes/path_budget.py), [measured-output.txt](probes/measured-output.txt). |

## The five findings that matter most

1. **You are probably closer to Windows than you think.** This host is WSL2, the repo is on a Windows NTFS
   volume mounted through 9p, and the field workspace that produced the defect is readable at
   `/mnt/k/Soukromé_aktivity/Bankovní účet SVJ ČSA368/.research-toolkit/` — including the attempt log with
   the exact failure line and a `research.sqlite3` created in the same minute. Before planning emulation,
   check what the development host already is.

2. **The mechanism of the 0.3.7 defect is documented, not folklore.** CPython uses UTF-8 for the Windows
   *console device* but the **ANSI code page for pipes and redirected files**. `execFile` gives the child a
   pipe. Therefore a Python child on Windows writes cp1252 and Node decodes it as UTF-8. The fix in 0.3.8
   (`-I -B -X utf8` plus `ensure_ascii=True`) is the documented remedy — and `-I` implies `-E`, so an
   env-var-only fix (`PYTHONUTF8`) would not have worked.

3. **Three nearly-free layers are unused.** Recorded Windows fixtures (L2), the Windows-backed mount this
   host already has (L3), and `windows-latest` CI (L4, free on a public repository). The layers already in
   use — 336 Node tests and 219 Python tests at L0/L1 — are strong; the gap is above them.

4. **Emulation is only worth what its label says it is worth.** Forcing `PYTHONIOENCODING=cp1252` in a Linux
   child reproduces the real mechanism and is honest. Running Wine with its default code page is not: Wine
   derives its code page from the Unix locale, so a default prefix silently tests UTF-8 while claiming to
   test cp1252.

5. **Two dated facts.** Global Azure DevOps PATs are retired on **1 December 2026**, so publishing must move
   to `vsce publish --oidc` / `ovsx publish --trusted-publishing`. And **PEP 686 is Final in Python 3.15**:
   UTF-8 mode becomes the default, which is exactly the behaviour the toolkit forces with `-X utf8` for the
   3.12–3.14 runtimes it supports (`requires-python = ">=3.12, <3.15"`).

## Status of this project's Windows gates

Open as of this writing: **G1–G4** — the 0.3.8 VSIX has not yet been installed on the Windows 11 machine
that reported the defect. The fix is proven at the emulated layer and at the field-evidence layer; it is not
yet proven on a Windows-backed run. That is the honest state, and closing it is action 14 in
[methodology.md](methodology.md).
