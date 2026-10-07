# Phase 4 preview acceptance

Revision: 0.2.0-preview. This is not the G4 release acceptance.

| Test | Procedure | Preview pass condition |
|---|---|---|
| T4P-01 Manifest | Parse extension manifest and VSIX metadata | Declared ID/version/engine/command align; no proposed APIs or runtime dependencies |
| T4P-02 Lazy activation | Inspect activation events and activate through contributed command | No setup, install, service start, network or filesystem mutation on activation |
| T4P-03 Command behavior | Invoke readiness command in a real Extension Host | Output truthfully reports selected preference, G1/G2/G3 open and that component setup is disabled |
| T4P-04 Artifact integrity | Audit VSIX entry allowlist, paths, hashes, identities and source bytes | Exact file inventory; no traversal, duplicate/symlink/secret/heavy payload; SHA-256 and size receipt |
| T4P-05 Isolated install | Install exact VSIX using VS Code CLI with dedicated data and extension directories | Installation succeeds; isolated CLI lists `michaelprinc.research-stack-toolkit@0.2.0` |
| T4P-06 Extension Host scale | Test extracted packaged payload in reference Extension Host; invoke once then 100 warm times | First invocation <500 ms; warm command p95 <50 ms for this reference run |
| T4P-07 Package scale | Measure compressed and unpacked artifact | Compressed <=50 MiB; unpacked <=1 MiB for this preview |
| T4P-08 Regression/limits | Run Node/Python project tests and inspect report | Existing profiles regress; platform/minimum-version/full-profile gaps remain explicit |
| T4P-09 Package switching | Switch Basic/Full/Recommended/Full through the contributed command, restart Extension Host, then inspect readiness | All choices report correctly, final Full choice persists in profile user settings, and no components are installed/removed |

Current preview evaluation is limited to one Windows 11 x64 host with VS Code Desktop 1.140.0. Passing T4P tests does not pass any T4-01–T4-14 full-product scenario nor G4.
