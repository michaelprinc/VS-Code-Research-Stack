# Phase 4 preview package integrity and scalability report

Date: 7 October 2026

Artifact: `research-stack-toolkit-0.1.0.vsix` (private readiness-only preview)

Outcome: **package and Extension Host preview checks passed; G4 not passed**

Prerequisites: **G1, G2 and G3 remain open.** See [Phase 1](../phase-1/gate-report.md), [Phase 2](../phase-2/gate-report.md) and [Phase 3](../phase-3/gate-report.md).

## Exact artifact integrity

| Check | Result |
|---|---|
| SHA-256 | `c2186f08037a7dcbe01e835bd1f246091862ba7d4cd067efa120a2960f3a7811` |
| Compressed VSIX | 3,445 bytes (3.36 KiB), below proposed 50 MiB target |
| Unpacked archive | 6,633 bytes (6.48 KiB), below preview 1 MiB ceiling |
| Archive members | Exactly 5: VSIX metadata, extension manifest, entry script and README |
| Source integrity | Packaged manifest/entry/README matched the reviewed VSIX staging sources |
| Dependencies | No production dependencies; packaging audit rejects devDependencies/scripts/private metadata in installed manifest |
| Static capability scan | No detectable HTTP(S)/fetch/WebSocket/process-launch primitives in the packaged entry point |
| npm audit | 0 vulnerabilities reported across 149 development/build dependency packages on this date |
| VSIX install | VS Code CLI installed the exact artifact to a disposable data/extensions profile and listed `michaelprinc.research-stack-toolkit@0.1.0` |

The file allowlist, safe archive paths, duplicate/symlink rejection, byte identity, manifest, and size limits are checked by `scripts/verify_vsix.py`. Its SHA-256 proves identity for this artifact but is not a digital signature or publisher-authenticity proof.

## Extension Host and load measurements

Reference environment: Windows 11 Pro build 26300, VS Code Desktop Stable 1.140.0 x64, Node.js 24.16.0. The test launched an isolated VS Code Extension Host and loaded the installed package folder from the exact VSIX installation. The extension-host test passed:

- First readiness-command activation and response: **96.6 ms** against the proposed 500 ms target.
- 100 sequential warm command calls: **p95 0.94 ms** against the proposed 50 ms target.
- 25 concurrent command calls returned identical readiness output.
- The Node-only unit microbenchmark formatted status 10,000 times in about 3 ms on this run; 3 Node unit tests passed.
- Repository regression and archive-audit tests: **31 Python tests passed**.

These measurements cover one lightweight command on one reference machine. They do not measure editor cold-start, memory under extended use, multi-window locking, workspace throughput, external runtime downloads, corpus indexing, embeddings, databases or provider/API scalability. The proposed targets require clean-host repetition before adoption as release criteria.

## Host observations and evidence limits

- VS Code CLI installation succeeded. Its bundled Node process emitted a `DEP0169` URL deprecation warning; this came from VS Code's own CLI and did not affect installation.
- During Extension Host startup, VS Code logged an `Error mutex already exists` message and then initialized fallback application storage; the host test completed successfully. Treat this as a host-environment warning to investigate during clean-machine acceptance, not as an extension pass condition.
- The packaged extension code itself uses only the `vscode` API, but the host includes built-in VS Code services. Extension Host logs included unauthenticated GitHub AgentHost/API activity. This test is not a whole-editor offline/network audit.
- The VSIX is marked `UNLICENSED`; VSCE's missing-license-file validation was skipped for this local/private preview. Do not publicly redistribute or Marketplace-publish it until repository license and publisher identity are resolved.
- Only Windows VS Code 1.140.0 was exercised. No minimum-version matrix, macOS, web or remote host is validated.

## What this artifact does and does not prove

It proves that the current status-only package has a small audited inventory, installs through the VS Code CLI, and activates its readiness command in the reference Extension Host with low measured command latency. It accurately reports G1/G2/G3 as open and provides no profile setup functionality.

It does not implement or validate the Phase 4 installer, Basic/Research/Full/Custom setup, trust-aware previews, SecretStorage, MCP definition provider, skill contribution, workspace merge, repair, update, rollback, multi-window service lifecycle, accessibility or data-preserving uninstall. It does not close any T4-01–T4-14 full-product scenario or G4.

## Gate decision

Accept this artifact as a local Phase 4 packaging/activation preview only. Keep G4 pending. Resolve the software license, close G1–G3 or formally narrow the advertised scope, implement the full VSIX workflows against proven recipes, and repeat the exact-artifact acceptance on clean Windows and macOS hosts before support or release claims.
