# Phase 4 VSIX integrity and scalability preview specification

Revision: 0.2.0-preview. Status: package preference switching and packaging/activation slice implemented; G4 not passed.

## Objective

Produce an installable, privately distributed VS Code extension artifact that proves package preference switching, packaging and host activation before the full orchestrator is implemented. The deliverable in this revision only saves the selected preference and reports readiness. It must state that G1/G2/G3 remain open and must not imply setup, supported profiles, or data management.

## Preview requirements

| ID | Requirement | Acceptance |
|---|---|---|
| P4-01 | Package an installable VSIX with readiness and package-switch commands plus declared host minimum | T4P-01 |
| P4-02 | Keep activation lazy and free of setup, downloads, service starts, network calls and subprocesses | T4P-02, T4P-03 |
| P4-09 | Switch Basic/Recommended Research/Full preference through Quick Pick and persist it in VS Code user settings | T4P-09 |
| P4-03 | Include an exact allow-listed file inventory, no runtime dependencies, and an auditable source-to-payload match | T4P-04 |
| P4-04 | Exercise the exact VSIX installation path in an isolated VS Code profile | T4P-05 |
| P4-05 | Exercise the packaged code in VS Code Extension Host and measure first activation plus repeated command responsiveness | T4P-06 |
| P4-06 | Stay below the proposed 50 MiB package ceiling and publish artifact hash/size/inventory | T4P-07 |
| P4-07 | Keep minimum-version, macOS, remote, profile integration, recovery, update and G4 claims unpassed until their actual acceptance evidence exists | T4P-08 |

## Scope boundary

The preview contributes `Research Toolkit: Show Phase Readiness` and `Research Toolkit: Switch Package`. Switching writes only the contributed `researchStack.selectedPackage` user setting (`basic`, `recommended`, or `full`; default `recommended`) and the readiness command reports the selection. The preference is shared by instances using that VS Code user profile. It reports that Basic G1, Research G2 and Full G3 are not passed. It does not install or start components, inspect workspaces, resolve secrets, connect to services, download files, or manage updates. Its JavaScript package has no production dependencies. Build/test tools are development-only and excluded from the VSIX.

The target is local VS Code Desktop. Current reference is Windows 11 x64 / VS Code 1.140.0. The manifest declares `engines.vscode` `^1.140.0` based on the installed reference version; older hosts, macOS, web and remote hosts are not validated. Private VSIX installation is tested; Marketplace publishing and redistribution are not authorized by this preview. No repository software license has been selected, so the package metadata is `UNLICENSED` and VSCE's missing-license check is skipped only for this private preview.

## Integrity and scale envelope

The packaging audit allows only VSIX metadata plus the extension manifest, entry script and README. It rejects path traversal, duplicate entries, symlinks, secret/cache/model/database payloads, source-to-artifact drift, development-tool metadata leakage, statically detectable network/process entry primitives, packages over 50 MiB and unpacked payloads over 1 MiB. The report includes SHA-256, archive size and exact entries. This is an integrity receipt, not a digital signature or publisher authenticity proof.

Measure first command activation against the proposed 500 ms target and warm command p95 across 100 invocations against a proposed 50 ms target on the reference host. Repeat those measurements across clean machines and host versions before treating them as support criteria. Concurrent workspaces, multiple windows, stress memory, full setup throughput, and cold extension-host startup remain outside this package-selection preview.
