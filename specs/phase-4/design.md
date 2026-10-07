# Phase 4 packaging and verification design

Revision: 0.2.0-preview. G1–G3 remain open; this design covers package preference, packaging, and activation seams.

## Source and extension boundary

`extension/` is an independent CommonJS extension package with exact development-tool versions in `package-lock.json`. A separate `vsix-manifest.json` is materialized into a temporary package staging directory so npm scripts, dev dependencies and `private` metadata do not leak into the installed extension manifest. Runtime uses stable `vscode` APIs: contributed commands, Quick Pick, user configuration and an output channel. The selected package is an application-scoped user setting, with one value per VS Code user profile, defaulting to `recommended`; it can also be viewed or changed in Settings. Activation is command-triggered; it does not initialize the Python worker or run setup. No `extensionDependencies`, extension packs, webviews or proposed APIs are used.

VS Code requires an extension manifest at the root of the package and an `engines.vscode` compatibility range ([manifest reference](https://code.visualstudio.com/api/references/extension-manifest)). This preview declares 1.140.0 as its minimum candidate because that exact Desktop version is installed on the reference host; only this host row will be validated. `vsce` is Microsoft's packaging tool and accepts `.vscodeignore` or a package `files` allowlist; this package uses `files` only and invokes the pinned tool ([VS Code packaging guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)).

## Integrity chain

1. `npm ci` resolves the checked-in exact lock. `npm audit --omit=dev` validates there are no shipped production dependencies; full `npm audit` covers build/test dependencies.
2. `vsce package --no-dependencies` creates one VSIX without npm runtime dependencies.
3. `scripts/verify_vsix.py` opens the archive, validates path/type and exact member allowlist, reads every CRC-checked member, compares package payload bytes against the source files, verifies the extension identity and absence of network/process primitives, computes SHA-256 and enforces package/unpacked size ceilings.
4. `code --install-extension` installs the exact file into a disposable `--user-data-dir` and `--extensions-dir`; the isolated CLI listing confirms the installed identity/version.
5. `@vscode/test-electron` launches the installed reference VS Code executable and loads the extension payload extracted from the VSIX. The Extension Host checks contributed command discovery, Basic/Full/Recommended/Full transitions, persisted preference after a host restart, truthfulness of G1–G3 status, first-command time and warm command p95 over 100 invocations.

The hash proves byte identity for this artifact only. No code signature, trusted catalog, Marketplace publisher, SBOM of the whole repo or runtime lock has been established. VSCE packaging warnings for the absent repository license are not suppressed by claiming a license; the private preview marks itself `UNLICENSED` and explicitly skips the missing-license-file check.

## Scalability interpretation

The preview establishes that a tiny zero-runtime-dependency extension can be installed and invoke a status command with low in-process overhead. It does not establish multi-window transaction safety or scalability of future downloads, databases, embeddings, corpus indexing or provider APIs. The Phase 4 package target of 50 MiB remains a proposed release budget; the audit also records unpacked bytes to catch compressed payload bloat.

## Known gaps

No setup wizard, resolver, component adapters, catalog loader, SecretStorage, workspace merge, MCP definition provider, health tree, repair/update journal or data lifecycle is wired into this extension. It does not accept custom profiles and does not install, remove, or configure components when the selection changes. G1/G2/G3 are prerequisite failures, not silently remapped readiness states. The package does not use a full runtime installer or service/model payload.
