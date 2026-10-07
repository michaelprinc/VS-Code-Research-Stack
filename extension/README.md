# Research Stack Toolkit — Phase 4 Preview

This private VSIX preview registers one command: **Research Toolkit: Show Phase Readiness**. It displays the current project gate state.

The extension is intentionally readiness-only. It does not install dependencies, download files, start services, inspect or modify workspaces, access networks, update components, or manage research data. Basic and Research remain prototypes with G1/G2 open; Full is a Phase 3 foundation with G3 open. This preview does not represent completion of Phase 4 or a supported Research Stack profile.

The package is tested against VS Code Desktop 1.140.0 on Windows 11 x64. The manifest's `engines.vscode` floor is a package compatibility declaration, not evidence that every host/version has been tested. macOS, web, remote, clean-host and minimum-version support remain unverified.

## Install

Use VS Code's **Extensions: Install from VSIX...** command and select `research-stack-toolkit-0.1.0.vsix`. Review the readiness status before relying on any project profile. Do not use this preview to install or update runtime components.

## Package boundary

Only the extension manifest, JavaScript entry point and this README belong in the VSIX. The package contains no Python environment, corpus, credential, database, model, browser or container image. The local source and package-integrity receipt are maintained in the project repository.
