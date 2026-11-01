# Phase 4 local setup, MCP reading and GUI verification — 0.3.2

Tests: 11 October 2026. Report finalized: 12 October 2026. Outcome: **0.3.2 local document workflow passed; full G4 remains open.**

Artifact: `dist/research-stack-toolkit-0.3.2.vsix`. Source base: `d80d2dfa5d41426897e94929ff4dde2f0832156c`, with local changes. The exact package was installed and tested in a disposable VS Code profile. No remote publication or installation into the user's normal profile was performed. WireGuard was not changed. Earlier 0.3.0/0.3.1 receipts remain in their versioned directories.

## 0.3.3 status — implemented, reference-host verification pending

Source and packaging for 0.3.3 are complete and verified on the Linux development host: 31 Node tests pass (24 before this change), the guide hub and worker bundle rebuild cleanly (16 reviewed worker files, including `src/research_stack/presets.py`), and `scripts/verify_vsix.py` reports `result: passed` with `sourceFilesMatch: true` for `dist/research-stack-toolkit-0.3.3.vsix` (SHA-256 `2ea6ce2d32adc81c3814cef198d3a516740964f8db235854f2c79502f230bf0d`, 141,592 bytes, 394,285 unpacked; the hash identifies this build — repackaging identical content yields a different hash because packaging timestamps are embedded). A packaged-payload check (`npm run check:payload`, reproducible on any host with Node) extracted the VSIX and ran the shipped controller: it confirmed 14 registered commands, worker-bundle hash validation, no servers before a setup receipt, preset-driven server definitions (2 for `research-core`, 1 for `read-and-cite`, 1 for `verify-citations`, 2 for `research-lab-max`), the preset GUI state with a measured 1,390-token toolkit surface, and resolution of the packaged guides, `presets.json`, `functional_check.py` and `probe.py`.

Not yet produced for 0.3.3: the disposable-profile installation receipt, Extension Host receipts, browser renderer screenshots (`evidence/phase-4/gui-0.3.3/`), a real setup receipt containing the measured `toolSurface`, and an observed Copilot agent-mode session at the widest preset. Everything below is the 0.3.2 receipt set and remains the only installed-host evidence.

## 0.3.4 status — implemented, reference-host verification pending

Source, packaging and automated verification for 0.3.4 are complete on the Linux development host; the Windows reference-host receipts are not.

| Check | Result |
|---|---|
| Artifact | `dist/research-stack-toolkit-0.3.4.vsix`, SHA-256 `08e68739aeab0007eaf61f9cd7b2aed1450cfc630ba925d23162de7d959c46d6` |
| Size / members | 226,352 compressed, 668,102 unpacked, 79 members including 29 component guides, 19 worker source/lock files and 11 overlay templates |
| Source match | `scripts/verify_vsix.py`: `result: passed`, `sourceFilesMatch: true`, bundle `schemaVersion 2` with all 19 source and 11 overlay hashes matching repository sources |
| Node tests | 37 pass, 0 fail (was 31), including the new `extension/test/installer.test.js` plan/prerequisite/receipt/overlay/GUI-install tests |
| Python tests | 70 pass, 0 fail (was 52), including new `tests/test_records.py` and `tests/test_lab_server.py` |
| Real functional check | 3 stdio MCP servers, 15 measured tool definitions (2,193 tokens), titles and annotations on every tool, `tools/list` cache hint present, corpus index → search → claim write → claim read with evidence link → status → refused unconfirmed vacuum → backup |
| Packaged payload check | 19 registered commands, 8 presets for Full, per-preset server definitions (`read-and-cite` 1, `verify-citations` 1, `research-lab-max` 2, `corpus-lab` 1), install plan `{installed: 3, outdated: 1}` derived from a receipt recorded at 0.3.3, 32 guide files resolvable from the unpacked package |
| Receipts | [artifact audit](gui-0.3.4/artifact-audit.json), [installed payload](gui-0.3.4/installed-payload.json), [functional check](gui-0.3.4/functional-check.json), [test summaries](gui-0.3.4/README.md) |

What 0.3.4 changes about readiness honesty: the readiness text now reports `Package setup for <package>: n of m component steps installed…` from the workspace receipt, each component row states who installs it and its next action, and the guide hub carries a **Who installs it** column. This reports setup completeness only. **G1, G2 and G3 remain open**, and no gate claim is made by any 0.3.4 message.

Not produced for 0.3.4: the disposable-profile installation receipt, Extension Host receipts (`npm run test:host`), browser renderer screenshots, a real Windows setup receipt containing the measured `toolSurface`, an observed Copilot agent-mode session at the widest preset, and any verification of the corpus/record store on the reference host. The newest real installed-host evidence in this repository remains `gui-0.3.2/`, which describes 0.3.2.

## Functional behavior

The VSIX now includes reviewed Python worker source and a locked dependency manifest. **Set up local components** creates `.research-toolkit/managed/worker-0.3.2` and a dedicated Python 3.12 environment using uv. Setup is explicit, cancellable and protected by a workspace lock. Existing project environments, documents and MCP configuration are preserved. Edited managed sources block execution instead of being overwritten; symlink/junction redirection is rejected. Interrupted setup can be retried.

An unrelated project `.venv` is no longer selected as the toolkit runtime. Installation receipts and source hashes identify the managed worker. Extension and worker versions are 0.3.2; actual interpreter and dependency versions are observed independently. Package preference, installation and readiness remain separate.

Setup and **Run MCP reading check** launch actual stdio MCP servers and exercise synthetic text-bearing PDF and Czech DOCX fixtures, source hashes and locators, Markdown/DOCX reports, local BM25 search, and metadata-adapter discovery/local RIS preparation. Temporary fixtures are cleaned up. These checks send no provider requests. **Check components** repeats this protocol check for an installed managed runtime.

**Read selected PDF / DOCX** reads the first five pages/paragraphs of a selected document within the workspace, verifies unchanged source bytes and displays locators, warnings and a bounded preview. Documents resolving outside the workspace are refused. Scanned/blank PDFs fail the text check and require separate OCR. The selected preview is excluded from Copy readiness.

The extension provides two local MCP server definitions through the native VS Code API after successful setup. It uses the actual positional `McpStdioServerDefinition` constructor and workspace URI. Existing `.mcp.json` and `.vscode/mcp.json` are not rewritten. Assistant authentication, policy and authorization require the user's client checks.

The scalable guide hub covers all 27 catalog components and is generated from individual guides and registry entries. Onboarding explains setup, first reading task, interpretation of readiness, retry and external prerequisites. Bundled guides are release snapshots; Latest docs opens official maintained instructions. Package/interface preferences persist across restart.

## Exact artifact

| Check | Result |
|---|---|
| SHA-256 | `a21df42e1e5f812bee8a07d134c0bc17b64df161e2c9641f622dda9e9119e13d` |
| Compressed bytes | 127,946 |
| Unpacked bytes | 350,582 |
| Members | 60, including 27 component guides, runtime/check scripts and 16 worker bundle files |
| Source match | All shipped assets match; worker inventory and individual SHA-256 values pass |
| Runtime npm dependencies | None; build/test metadata excluded |
| Capability scan | One reviewed bounded, no-shell `execFile` runner in diagnostics; no detected network/process primitives in other shipped JavaScript |
| Isolated installation | `michaelprinc.research-stack-toolkit@0.3.2` |

See [artifact audit](gui-0.3.2/artifact-audit.json) and [installed identity](gui-0.3.2/installed-extension.txt). The checksum identifies the package; it is not a publisher signature. The VSIX contains source/locks, not prebuilt environments, research documents, model/browser binaries or credentials.

## Actual installed observations

The packaged setup adapter created its own worker in a disposable workspace with spaces and an accented name. Existing `.venv` and native MCP configuration sentinels remained unchanged. The test used the installed package's runtime and real uv, Python and MCP libraries, then reopened the same profile and workspace.

| Component | Observed version | Result |
|---|---|---|
| Toolkit | 0.3.2 | Running extension, Ready |
| VS Code | 1.141.0 | Running editor, Ready |
| uv | 0.11.23 | Version command, Ready |
| Git | 2.54.0.windows.1 | Version command, Ready |
| Managed Python | 3.12.13 | Dedicated runtime, Ready |
| MCP Python SDK | 2.2.0 | Import and real client/server protocol, Ready |
| pypdf | 6.4.1 | Real MCP PDF extraction, Ready |
| python-docx | 1.2.0 | Real MCP DOCX extraction/report, Ready |
| Basic document worker | 0.3.2 | Discovery, reads, writes and source checks, Ready |
| Local lexical search | 0.3.2 | Real MCP bounded BM25 query, Ready |
| Research metadata adapter | 0.3.2 | Discovery and local RIS preparation, Ready; provider connectivity unverified |

## Validation

- All **24 Node tests** passed, covering GUI/preferences, diagnostics, guide coverage, isolated setup, idempotency, failure/retry, workspace lock, restricted/remote boundaries, cancellation, provider definitions and junction/source preservation.
- All **40 Python tests** passed, including actual MCP fixture checks, selected Czech DOCX reading, scanned-PDF rejection, malformed/outside-document handling and VSIX tampering checks.
- `npm audit` reported zero vulnerabilities; [receipt](gui-0.3.2/npm-audit.json).
- Browser renderer checks passed for keyboard controls, setup/reading actions, preview, options, search, guide links, dark/light/high-contrast themes and mobile overflow. No renderer/CSP errors were observed. [Receipt](gui-0.3.2/renderer-test.json), [dark](gui-0.3.2/dark.png), [light](gui-0.3.2/light.png), [contrast](gui-0.3.2/contrast.png). This uses a mock host and fixture versions, not installation evidence.
- Both actual VS Code Extension Host launches passed with the final artifact. Packaged renderer handshake, panel reuse, guide opening, command registration, setup, real protocol checks, selected-document extraction, provider definitions and restart persistence were verified. Each stage exercised 25 concurrent readiness calls. Clipboard contents were restored. [Compact receipts](gui-0.3.2/host-receipts.json), [host log](gui-0.3.2/host-test.log).

| Host stage | First readiness command | Warm p95 (100 calls) |
|---|---:|---:|
| Fresh profile | 107.39 ms | 3.20 ms |
| Restart | 84.70 ms | 2.16 ms |

Timings cover readiness command execution/activation on this host, not editor startup or external performance. The actual host exercised the installed setup adapter directly; native confirmation/cancellation interactions were covered by deterministic GUI/unit checks. Provider definitions were checked against real VS Code API classes; assistant chat invocation was not performed.

## Remaining scope

External provider/account connectivity, Zotero access, editor integrations and notebook kernels remain separately unverified. Qdrant, embeddings, DuckDB, browser and institutional integrations remain planned. Choosing Full does not install them or make the complete stack Ready.

Validation covers Windows desktop VS Code 1.141.0. The manifest retains `^1.140.0`; other editor versions, macOS, full multi-window acceptance and lifecycle update/rollback remain pending. Restricted/remote behavior has deterministic tests, not supported remote runtime acceptance. Browser checks do not establish complete accessibility certification.

VS Code emitted built-in Copilot/GitHub and shared-storage warnings; both launches exited successfully. This is not a whole-editor network audit. The private package remains `UNLICENSED`, with the existing missing-license-file packaging check skipped. Accept 0.3.2 for the verified local document workflow; complete profile readiness and the broader G1–G4 product gates remain open.

## 0.3.5 status — stabilization shipped; this report stays historical for 0.3.2

Recorded 31 October 2026. The receipts above validate the **0.3.2** package on the Windows 11 / VS Code 1.141.0
reference host and are not retracted or restated by later releases.

The current release is `dist/research-stack-toolkit-0.3.5.vsix` (251,723 bytes,
sha256 `b4d0b10f244830cb6c736460535b606202ca16b1b10f23d7b8589e80bceb6b52`). Its automated receipts — Python
and Node suites, the real three-server MCP functional check, the packaged-VSX audit, the installed-payload
check and the re-run review probes — are in
[`evidence/quality-v0.3.5-2026-10-31/`](../../../evidence/quality-v0.3.5-2026-10-31/README.md), and the
release narrative is in
[`docs/implementation/phase-5-stabilization/implementation-report-0.3.5.md`](../../docs/implementation/phase-5-stabilization/implementation-report-0.3.5.md).

No reference-host installation, Extension Host activation or browser renderer receipt exists for 0.3.5 yet.
**G1, G2, G3 and G4 remain open**, and 0.3.5 does not claim otherwise.

## 0.3.6 status — component install reliability and installation status reporting

Recorded 1 November 2026. The 0.3.2 receipts above remain historical and are not restated; the 0.3.5
section above them is likewise unchanged.

The current release is `dist/research-stack-toolkit-0.3.6.vsix` (288,704 bytes,
sha256 `7d772cd2b42686ffbdf705cde08d427710aa6ae6e240ab537c6c61998bd10235`). Its automated receipts —
134 Node tests, 113 Python tests, the real three-server MCP functional check, the packaged-VSX audit, the
installed-payload check (which reproduces a failed component setup against the packaged bytes), the audit
integrity probes, the re-run review probes and the independent evaluation pass that found and closed
sixteen further defects — are in
[`evidence/quality-v0.3.6-2026-11-01/`](../../../evidence/quality-v0.3.6-2026-11-01/README.md), and the
release narrative is in
[`docs/implementation/phase-6-install-reliability/implementation-report-0.3.6.md`](../../docs/implementation/phase-6-install-reliability/implementation-report-0.3.6.md).

0.3.6 closes the 0.3.6 diagnosis findings D1–D8 (PATH-only tool lookup, discarded tool output, capture and
timeout bounds, unclassified setup lock, unrecorded attempts, no GUI verdict, plan abort at first failure,
oversized modules). It does not install uv, does not run notebook kernels, and does not connect to external
providers.

No reference-host installation, Extension Host activation, browser renderer receipt or real component setup
receipt exists for 0.3.6. **G1, G2, G3 and G4 remain open**, and 0.3.6 does not claim otherwise.
