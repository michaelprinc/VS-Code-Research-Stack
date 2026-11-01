# Phase 4 tasks — package integrity and scalability preview

Revision: 0.3.3-preview.

| ID | Work | Evidence | State |
|---|---|---|---|
| M4P-01 | Define a bounded VSIX preview scope and host/package targets | `specs/phase-4/{spec,design,tasks,acceptance}.md` | Complete for preview; G4 scope remains open |
| M4P-02 | Create readiness/package commands and discoverable GUI controls | `extension/vsix-manifest.json`, `extension/extension.js`, `extension/ui.js`, `extension/media/` | Implemented; preferences, observed inventory and modular guides |
| M4P-03 | Pin exact packaging/test tools and audit dependency closure | `extension/package-lock.json`, npm audit receipt | Implemented; rebuild checks required |
| M4P-04 | Build allow-listed VSIX and verify exact payload/hash/size | `dist/research-stack-toolkit-0.3.2.vsix`, package audit receipt | Complete for preview |
| M4P-05 | Install exact artifact in a disposable VS Code profile | isolated extension listing/installation receipt | Complete for Windows reference host |
| M4P-06 | Exercise all package selections, persistence across Extension Host restart and responsiveness | host test output | Complete for Windows reference host |
| M4P-07 | Rerun Phase 1–3 tests and document open G1–G3 blockers | 40 Python tests passed; gate report | Complete for preview; G1–G3 remain open |
| M4P-08 | Publish source/docs/receipts | Local source checkout and VSIX delivered; no remote publication requested | Pending remote publication |
| M4P-09 | Exercise renderer with keyboard, package/options/actions and invalid inputs | Browser renderer receipt and dark/light/high-contrast screenshots | Complete for mock-host renderer |
| M4P-10 | Verify fixed command boundary, failed-setting feedback and GUI asset integrity | 24 Node tests; Python asset-drift checks | Complete for preview |
| M4P-11 | Observe actual local versions and independent readiness; reject wrong-host/stale checks and unsafe messages | Diagnostics tests and packaged host inventory receipt | Complete for local preview |
| M4P-12 | Build scalable onboarding and independent component guides with current official links | 27 guides, registry, hub generator and guide/link/archive checks | Complete for preview |
| M4P-13 | Add goal-based tools presets with package-aware availability, defaults and fallback | `extension/presets.json`, `src/research_stack/presets.py`, `extension/test/presets.test.js` | Implemented for preview |
| M4P-14 | Gate worker tool registration by preset and pass it through the MCP provider environment | `src/research_stack/mcp_server.py`, `src/research_stack/recommended_server.py`, runtime provider tests | Implemented for preview |
| M4P-15 | Measure real tool-schema size in the setup receipt and show a context estimate with tooltips in the GUI | `extension/functional_check.py`, `extension/ui.js`, `extension/media/controls.js` | Implemented for preview; measured receipt pending on the reference host |
| M4P-16 | Run the packaged-payload install check on the built VSIX | `extension/scripts/check-installed-payload.js` (`npm run check:payload`), payload receipt | Complete for preview |
| M4P-17 | Produce 0.3.3 Extension Host, browser renderer and real Copilot 128-tool receipts | `evidence/phase-4/gui-0.3.3/` | Pending reference-host work |

## Follow-on work before full Phase 4

1. Close G1–G3 or narrow advertised profiles to those with verified receipts.
2. Resolve license and publisher identity; test minimum/current Stable on clean Windows and macOS.
3. Wire tested profile resolver, secure configuration/SecretStorage, MCP definition provider and workspace ownership/merge behavior.
4. Add setup preview/journal/cancellation/repair and actual component installation adapters only for locked recipes.
5. Add signed/trusted update inputs, staged updates, migration and failed-update recovery.
6. Verify exact release VSIX on clean hosts, multi-window/workspace concurrency, accessibility, data preservation and update/recovery scenarios before G4.

## 0.3.2 functional local slice

The GUI setup action previews the selected workspace, isolated `.research-toolkit/managed/worker-0.3.2` path, Python 3.12 and locked package downloads. The VSIX contains reviewed worker source/locks with a hash manifest, not a prebuilt runtime. Only this owned project is synced; unrelated project environments and existing MCP files remain unchanged. Fixed versioned paths, source integrity checks, exclusive workspace setup locks and retryable stages prevent silent source replacement and competing setup. Existing edited managed sources are preserved and block execution.

The stable MCP definition provider supplies managed Basic and Research servers without merging user JSONC. Provider construction uses the positional constructor verified against VS Code 1.141.0 and its published API reference, with `cwd` assigned separately. It returns no servers on restricted/remote workspaces or before a successful setup receipt. Real protocol tests verify synthetic PDF/DOCX extraction, source hashes/locators, report creation, local BM25 retrieval and RIS preparation. Selected-document reading is an explicit GUI file choice under the selected workspace, with a bounded preview and no source mutation. Blank/scanned PDFs remain failed text checks. Runtime/provider tests do not establish assistant authentication or external scholarly/Zotero access. Notebook kernel setup and planned vector/storage/browser integrations remain separate.

## 0.3.3 goal-based tool presets

Verified by the automated suite on the Linux development host (31 Node tests) and by the packaging audit of `dist/research-stack-toolkit-0.3.3.vsix` (SHA-256 `2ea6ce2d32adc81c3814cef198d3a516740964f8db235854f2c79502f230bf0d`, 141,592 bytes, 394,285 unpacked; the hash identifies this build — repackaging identical content yields a different hash because packaging timestamps are embedded, `sourceFilesMatch: true`): preset/package mapping and defaults, saved-preset fallback, preset validation and rejection of unknown or cross-package values, preset environment propagation, omission of unused servers, measured-versus-estimated context accounting, and the registry/worker mapping invariants.

Not yet verified on the reference host: the real Extension Host provider receipt, the browser renderer receipt, a measured `tools/list` receipt written by a real setup run, and observed behaviour of a real Copilot agent-mode session at the 128-tool ceiling. Preset selection is a preference and tool-registration filter; it does not close G1–G4 and does not prove that an assistant account or organization permits invocation.

## 0.3.4 package-aware component setup and record store — completed on the development host

1. Move `extension/components.json` to schemaVersion 2: `install {mode, step, verify, toolkitVersion}` and `nextAction` on all 29 components; `installSteps` with ordered `prerequisites`, provided `components` and per-package `packages` entries carrying `gate` and `support`.
2. Add `extension/installer.js`: plan resolution (`stepsForPackage`, `stepsForComponents`, `resolveStepSelection`), receipt read/write with symlink refusal, `stepStatus`/`componentStatus`/`planView`, outdated detection, `runStep` for the four reviewed steps, and `runPlan` that records each step and skips current ones.
3. Add the workspace corpus index and record store: `src/research_stack/records.py` (standard-library SQLite, `sources`/`chunks`/`claims`/`claim_evidence`/`meta`, bounded limits, previewed re-index, confirmed vacuum, new-file-only backup) and `src/research_stack/lab_server.py` (five annotated verbs over one stdio server), with `research-stack.cli init-lab --workspace` and `workspace.init_lab_workspace` writing an honest `lab-state.json` instead of a service profile.
4. Add the `corpus-lab` preset and the C-13 budget contract (`toolkitCeilingPerPreset: 12`, `minimumHeadroom: 20`); rename `search` → `search_literature` with the deprecated alias registered only for the unmanaged `all` preset; publish tool annotations, sorted registration order and a 300-second private `tools/list` cache hint from all three servers.
5. Expose the plan through the GUI: *Component setup for this package* section, per-step status and selection, **Set up package components**, **Update outdated components**, **Check component status**, per-component Install/Update, `selectComponentStep` Quick Pick, `diagnoseToolLimit`, `copyPresetSummary`, workspace-scoped preset saving and recently used presets (19 commands).
6. Report setup completeness in readiness, sidebar and inventory text without claiming gates; add the two new component guides and the **Who installs it** column to the generated hub.
7. Verify with 37 Node tests, 70 pytest tests, the real three-server functional check and the packaged-VSX/payload audits; record receipts in `evidence/phase-4/gui-0.3.4/`.

Still open for 0.3.4: the reference-host receipts (T4P-05, T4P-06, T4P-12, T4P-14), a real setup receipt written on Windows, an observed agent-mode session at the widest preset, signed/trusted update inputs and staged/migrating updates, and every planned integration (vector search, embeddings, DuckDB/Qdrant, browser, institutional adapters). G1, G2 and G3 remain open.
