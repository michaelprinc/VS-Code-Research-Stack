# Phase 4 VSIX package switching, integrity and scalability report

Date: 7 October 2026

Artifact: `research-stack-toolkit-0.2.0.vsix` (private preview)

Outcome: **package switching, settings persistence, packaging and Extension Host preview checks passed; G4 not passed**

Prerequisites: **G1, G2 and G3 remain open.** See [Phase 1](../phase-1/gate-report.md), [Phase 2](../phase-2/gate-report.md) and [Phase 3](../phase-3/gate-report.md).

## Package switching behavior

The extension contributes **Research Toolkit: Switch Package** and **Research Toolkit: Show Phase Readiness**. The switch command presents Basic, Recommended Research and Full in VS Code Quick Pick. It persists the selected ID in the application-scoped `researchStack.selectedPackage` user setting, defaulting to `recommended`; Settings UI/JSON can show the same value. Readiness output reports the selected preference and the gate status for each package.

The acceptance run installed the exact VSIX in an isolated VS Code profile and exercised its extracted package in the reference Extension Host. A fresh profile began at Recommended Research; the command switched Basic → Full → Recommended Research → Full. A second Extension Host launch reported Full as the persisted selection, then switched to Basic. A final read of the isolated profile's `settings.json` showed `"researchStack.selectedPackage": "basic"`. Unit coverage also verified that Quick Pick cancellation leaves the setting unchanged and unsupported package IDs are rejected.

Switching selects a preference only. It does not install, remove or configure Research Stack components. G1/G2/G3 are open, so this preview does not claim the profiles are supported or ready.

## Exact artifact integrity

| Check | Result |
|---|---|
| SHA-256 | `34f8c97c78d5659f68c093f4eef63c02cf50c7ff1f02e5f0111901da8d47cc1a` |
| Compressed VSIX | 4,478 bytes (4.37 KiB), below proposed 50 MiB target |
| Unpacked archive | 10,614 bytes (10.37 KiB), below preview 1 MiB ceiling |
| Archive members | Exactly 5: VSIX metadata, extension manifest, entry script and README |
| Source integrity | Packaged manifest/entry/README matched the reviewed VSIX staging sources |
| Dependencies | No production dependencies; development npm metadata excluded from the installed manifest |
| Static capability scan | No detectable HTTP(S)/fetch/WebSocket/process-launch primitives in the packaged entry point |
| VSIX install | VS Code CLI installed the exact artifact into a disposable profile and listed `michaelprinc.research-stack-toolkit@0.2.0` |

The file allowlist, safe archive paths, duplicate/symlink rejection, byte identity, manifest, and size limits are checked by `scripts/verify_vsix.py`. Its SHA-256 proves identity for this artifact but is not a digital signature or publisher-authenticity proof.

## Extension Host and load measurements

Reference environment: Windows 11 Pro build 26300, VS Code Desktop Stable 1.140.0 x64. The test launched two Extension Host processes from the isolated profile and loaded the installed package folder extracted from the exact VSIX. Both test stages passed:

| Stage | First readiness call | Warm command p95 (100 calls) | Package transitions |
|---|---:|---:|---|
| Fresh profile | 66.2 ms | 0.62 ms | Basic → Full → Recommended → Full |
| After Extension Host restart | 89.6 ms | 0.48 ms | Persisted Full → Basic |

Each stage also made 25 concurrent readiness calls and received identical results. Four Node unit tests and 31 repository Python tests passed. `npm audit` reported zero vulnerabilities. Unit coverage includes selector choices, cancellation, invalid IDs, command registration and a 10,000-render timing check. These measurements cover preference switching and a lightweight readiness command on one reference machine. They do not measure editor cold-start, memory under extended use, multiple windows, setup throughput, external runtime downloads, corpus indexing, embeddings, databases or provider/API scalability.

## Host observations and evidence limits

- VS Code CLI installation emitted a bundled Node.js `DEP0169` URL deprecation warning; it did not affect installation.
- The Extension Host run logged an `Error mutex already exists` message and initialized fallback application storage. User-setting persistence nevertheless passed across the two host launches. Track the host warning during clean-machine acceptance.
- VS Code built-in services emitted unauthenticated GitHub AgentHost/API activity in test logs. The extension entry point itself uses only the `vscode` API, but this is not a whole-editor offline/network audit.
- The VSIX is marked `UNLICENSED`; VSCE's missing-license-file validation was skipped for this local/private preview. Do not publicly redistribute or Marketplace-publish until repository license and publisher identity are resolved.
- Only Windows VS Code 1.140.0 was exercised. No minimum-version matrix, macOS, web or remote host is validated.

## Gate decision

Accept this artifact as a local Phase 4 package-preference and packaging/activation preview only. Keep G4 pending. Close G1–G3 or formally narrow advertised profiles, implement the real component installer and lifecycle workflows, and repeat exact-artifact acceptance on clean Windows and macOS hosts before support or release claims.
