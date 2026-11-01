# Checklist — presets, tool surface and MCP identity (F10, F11, F16 surface)

Findings addressed: F10 disconnected Full surfaces, F11 unchanged definition version, F16 missing resolver verbs.

## F10 — one coherent Full workflow

- [x] New preset `research-workflow` covers read → index → search → resolve → claim → export.
- [x] It is the Full package default.
- [x] Toolkit tool count stays ≤12 with ≥20 tools of headroom (C-13).
- [x] `research-lab` and `research-lab-max` goals state that they do not include the corpus/claims verbs.
- [x] `corpus-lab` can read a text source and export claims, not only index them.
- [x] Preset `requires` names the component step the verbs depend on.
- [x] Python `TOOL_PRESETS` and `extension/presets.json` stay in lockstep (both test suites assert it).

## F16 — resolver verbs

- [x] `read_text_source` is registered on the document server and enabled in the notes, corpus and workflow presets.
- [x] `evidence_read` resolves chunk ids through MCP.
- [x] `claims_export` returns validated references usable as report `sources`.
- [x] Server budgets and the functional check expectations match the new verb counts.

## F11 — definition identity

- [x] Definition version = runtime version + preset id + tool-surface fingerprint.
- [x] Changing the preset changes the definition version for the same runtime.
- [x] The provider records the applied signature; the panel shows saved versus applied.
- [x] The 300-second `tools/list` cache hint stays, and the refresh path is exercised by a test.

## Annotation audit

- [x] `index_corpus` remove mode is annotated destructive (or split into a separate verb).
- [x] `store_maintenance` verbs are separated where approval semantics differ.
- [x] Network verbs are marked open-world.
- [x] Read verbs perform no writes.
- [x] Every tool keeps a title and annotations, and registration stays sorted.
## Verification status — 31 October 2026

Covered by `test/test_presets.py` (Python) and `test/presets.test.js` (Node), the real three-server functional
check ([`functional-check.json`](../../../../evidence/quality-v0.3.5-2026-10-31/functional-check.json): 5 + 5 + 9
verbs, 20 definitions at the unmanaged `all` preset, 19 preset-selectable toolkit tools) and the installed
payload check (`toolSurface.toolCount === 19`, widest total 101 tools, C-13 headroom ≥20).

Residual limit: external (non-toolkit) server counts in the tool-limit diagnosis remain vendor estimates and are
labelled as such; they are not measured against a configured client surface.
