# Phase 15 tasks and ownership (0.3.14)

Each package names the files it owns, so parallel work cannot collide. A package is done when its
tests pass and its claims are measured.

| # | Package | Owner | Files it may change | Acceptance link |
| --- | --- | --- | --- | --- |
| P1 | GitHub MCP tool map + Copilot tool-selection mechanism | subagent A | `research/github-mcp-tool-map-2026-11-17.md` (new), `docs/implementation/*` note | HR-10…HR-12 |
| P2 | Vector + hybrid retrieval in the store, lab-state derived refresh, `draft` claim status | subagent B | `src/research_stack/vectors.py` (new), `records.py`, `lab_server.py`, `workspace.py`, `tool_meta.py` if needed, `tests/test_vector_retrieval.py` (new), `tests/test_lab_state.py` (new) | HR-01…HR-06, HR-32 |
| P3 | Bundle force-update, versioned archive, index, log, list + restore | subagent C | `extension/bundles.js`, `extension/extension.js` (bundle command region only), `extension/media/controls.js` + panel state if a control is needed, `extension/test/bundles.test.js`, `scripts/panel_renderer_check.js` if a row is added | HR-20…HR-23 |
| P4 | `integrationTimeoutMs` + `integrationCooldownSeconds` as real settings | subagent E | `extension/integrationprobe.js`, `extension/integrations.js`, `extension/extension.js` (integration region only, ~l. 230-290), `extension/package.json` (configuration block only), `extension/test/credential-security.test.js`, `extension/test/integrations.test.js`, `extension/test/integration-host.test.js` | HR-30 |
| P5 | Preset rework: three max presets, exact tool lists, budget 20, Copilot selection written to the workspace | main agent + subagent D | `extension/presets.json`, `extension/package.json` (preset enum only), `extension/presetselect.js` (new), `extension/extension.js` (preset region), `src/research_stack/presets.py`, `extension/test/presets.test.js`, `extension/guides/toolkit.md` | HR-10…HR-14, HR-12 |
| P6 | F-01 rollback honesty | main agent | `extension/runtime.js`, `extension/test/runtime.test.js` | HR-31 |
| P7 | Documentation consistency: changelog, guides, worker README, marketplace notes | main agent | `extension/CHANGELOG.md`, `extension/MARKETPLACE-CHANGELOG.md`, `extension/README.md`, `README.md`, `extension/guides/*.md`, `extension/worker/README.md` | HR-33 |
| P8 | 0.3.14 identity bump, all gates, artifact build + audit, quality state | main agent | `extension/package.json` version, `extension/vsix-manifest.json`, `src/research_stack/__init__.py`, `scripts/verify_vsix.py` ceiling if measured, `.agent/QUALITY_STATE.md`, `dist/*` | DD15-05 |

Sequence: P1 → P5 (P5 needs P1's tool map). P2, P3, P4 are independent of each other and of P1.
`extension/extension.js` is shared by P3, P4 and P5: P3 and P4 run in parallel (disjoint regions),
P5 edits it only after both are merged.
