# Checklist — control panel, workspace scope and client state (F12, F17)

Findings addressed: F12 double dispatch, F17 stale scope, mixed measurement labels, preset scope wording, recent preset ordering.

## F12 — one message per action

- [x] Setup and update buttons have no `data-action` attribute.
- [x] The generic delegated handler ignores controls with a dedicated handler.
- [x] Each user action sends exactly one message, carrying a `requestId`.
- [x] The controller correlates the result to the request.
- [x] Probe `setupButtonClickMessages`: a setup click produces one `{type:"setup"}` message and no `{type:"action"}` message.

## F17 — scope and measurement honesty

- [x] `toolSurface` is cleared when the selected folder, trust state or extension set changes.
- [x] Measurements are bound to the folder and runtime identity that produced them.
- [x] Measurement states are `measured` (every preset tool found), `partial` (some estimated) or `estimated` (none found).
- [x] External-server counts are labelled as vendor estimates, never as configured/observed totals.
- [x] The static 50-tool guidance is presented as accuracy guidance, not a measured threshold.
- [x] Configuration is read with the selected `WorkspaceFolder` scope.
- [x] The panel's workspace save writes `ConfigurationTarget.WorkspaceFolder` when a folder is selected, and the UI labels the scope it used.
- [x] Recently used presets appear first in the preset Quick Pick.
- [x] Probe `folderSwitch`: a fresh folder with no managed runtime shows no prior folder surface.
## Verification status — 31 October 2026

Covered by `test/unit.test.js`, `test/presets.test.js`, `test/host.test.js` and the recorded probes
`presetIdentity`, `folderSwitch`, `setupButtonClickMessages` (one message per click, each carrying a
`requestId` that the extension echoes on the matching result) in
[`node-probe-results.json`](../../../../evidence/quality-v0.3.5-2026-10-31/node-probe-results.json).

Residual limits: `test/host.test.js` (real Extension Host) and `test/browser.test.js` (renderer) are updated for
0.3.5 but have not been run on this Linux host; no browser-renderer or Windows-host receipt exists for 0.3.5, so
T5-36 is Partial and G1–G4 remain open.
