# Checklist — host tool resolution (D1, R6-01…R6-07)

- [x] Search order is setting → PATH → documented known locations → managed.
- [x] Known locations are a bounded documented list per platform, not a filesystem walk.
- [x] The result names the source that resolved the tool.
- [x] A miss reports the searched categories with counts and an actionable hint.
- [x] Workspace-local executables are still refused.
- [x] `researchStack.uvPath` is validated (absolute, existing, executable, outside the workspace). The tests cover the outside-the-workspace refusal and a missing path today; the absolute and executable checks are enforced only by the resolver in `extension/hosttools.js`.
- [x] Version probe has its own bounded timeout and a `unverified` state.
- [x] `minimumVersion` lives in `components.json` and is enforced and reported.
- [x] Resolution is cached per session and invalidated when the setting or folders change.
- [x] `checkInventory` reports the resolved path and version for uv.
## Verification status — 1 November 2026

Covered by `test/hosttools.test.js` (search order, bounded documented locations, refusal with searched
categories and counts, workspace-executable refusal, unverified version, registry minimum, session cache and
refresh, injected-resolver adapter, a real interpreter resolved on this host) and by
`test/gui-status.test.js` (the resolved path, source and registry minimum are visible through
**Check component status** before any component runs).

Residual limits: this host has no `uv` on PATH, so the documented-location hits are proven with fixtures
under a temporary `HOME`; a uv host should record one real resolution. A configured path that exists but is
not executable is refused by the resolver without a test asserting it today; that test is being added in
this pass.
