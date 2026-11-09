# Quality state — Research Stack Toolkit 0.3.10 (update channel, problem reports, Marketplace publication runbook)

Objective: implement the 0.3.10 brief — give a Toolkit installed from a `.vsix` file a real update channel (one
bounded Marketplace version check, a stated verdict, an update handed to VS Code's own installer), give the operator a
problem report that can be sent to `princ.michael@gmail.com` from the Toolkit GUI without the Toolkit sending anything,
verify the Marketplace publication requirements by measurement and citation, and write the runbook a maintainer
follows. Prove all of it on this container and say plainly what was not proven here.

Plan of record: [specs/phase-10-marketplace-release/](../specs/phase-10-marketplace-release/) —
[spec.md](../specs/phase-10-marketplace-release/spec.md) (baseline, findings 1–8, requirements R10-01…R10-11),
[design.md](../specs/phase-10-marketplace-release/design.md) (DD10-01…DD10-14),
[acceptance.md](../specs/phase-10-marketplace-release/acceptance.md) (T10-01…T10-38),
[tasks.md](../specs/phase-10-marketplace-release/tasks.md).
Release report and runbook: [implementation-report-0.3.10.md](../docs/implementation/phase-10-marketplace-release/implementation-report-0.3.10.md).
Receipts: [evidence/quality-v0.3.10-2026-11-07/](../evidence/quality-v0.3.10-2026-11-07/README.md), including
[marketplace-publish-research.md](../evidence/quality-v0.3.10-2026-11-07/marketplace-publish-research.md).
The 0.3.9 state is kept at [.agent/0.3.9/QUALITY_STATE-0.3.9.md](0.3.9/QUALITY_STATE-0.3.9.md).

Status: **0.3.10 implemented, packaged and audited on this Linux development host; publication is open and blocked on
four human decisions.** Gates G1–G4 remain open, as they were for 0.3.6–0.3.9. A live Windows VS Code / Copilot session
is **not accessible from this container** and nothing here claims one.

## What is proven (measured, not assumed)

- **Suites**: Node **390 tests, 390 pass, 0 fail, 0 skipped** (19 files, 35 new); Python **258 passed** in 133.33 s.
  Receipts: `node-suite.txt`, `python-suite.txt`.
- **Artifact**: `dist/research-stack-toolkit-0.3.10.vsix`, 104 members, 426 351 bytes, unpacked **1 276 822** of the
  reviewed **1 310 720** ceiling (33 898 headroom), SHA-256
  `c24e24157899c198e429e7d5af4d97cb575d893afc6dd929ee266444d97b20f2`; `sourceFilesMatch: true`; two consecutive builds
  byte-identical. `npm run check:payload` → `result: passed`, 33 commands. Receipts: `vsix-audit.json`,
  `payload-check.json`, `package.txt`.
- **The network capability is one named module, measured in both directions.** `reviewedNetworkBoundary` names
  `extension/updates.js` as the only packaged JavaScript member with outbound capability, and the audit fails if it
  loses the reviewed bounds. `extension/reports.js` has none, asserted by
  `reports.test.js::nothing in this module can send anything`.
- **The installed payload behaves as designed**: a disabled setting reaches no transport at all; a 404 is the verdict
  `not-published`, not an exception; every request went to the reviewed URL; the panel carries `#update-state` and the
  three new controls. Receipt: `payload-check.json`.
- **The publication state is measured, not assumed**: `extensionquery` `TotalCount: 0`, `/publishers/michaelprinc` 404,
  `/vscode/michaelprinc.research-stack-toolkit/latest` 404. Receipt: `marketplace-probe.json`.
- **The toolchain gap is measured**: pinned `@vscode/vsce` 4.0.0 has no `--oidc`; 4.1.0 does. Receipts:
  `vsce-publish-help.txt`, `vsce-4.1.0-publish-help.txt`. `create-publisher` is gone from both.
- **Icon**: `extension/media/toolkit.png`, 256 × 256 RGBA, 6 875 bytes, SHA-256 `dbe4f22b…c4c7a`, asserted by the audit
  and the payload check.

## Open items and risks

1. **Publication is blocked on four human decisions**: create the publisher `michaelprinc` (permanent ID); choose a
   credential (Trusted publishing `--oidc` or a PAT whose retirement date is disputed — VS Code docs say 2026-12-01, the
   DevOps blog postpones it to 2027-01-27); decide the repository licence (`UNLICENSED` today, and the Marketplace
   renders no License row without a licence file); decide whether 0.3.10 ships as `--pre-release`.
2. **`@vscode/vsce` stays pinned at 4.0.0** so the receipts describe a pinned toolchain. Trusted publishing needs
   `>= 4.1.0`; the bump is deliberately not made here.
3. **The two skill bundles are `publishable: false`** — `theological-research` needs author consent,
   `document-corpus-bridge` is toolkit-authored inside an unlicensed repository. Enforced by generator, reader and audit.
4. **Unconfirmed Marketplace behaviour**: gallery propagation time (no documented SLA), the literal
   `extensions.autoUpdate` default, Marketplace-side handling of `bugs.email` and `scripts`, `engines.vscode: "*"`.
   Flagged in the research file rather than asserted.
5. **A real mail client is not in this container.** The draft is proven up to `openExternal`; whether a client preserves
   a 1 400-byte body unchanged is not proven.
6. **Windows paths with spaces are over-redacted** when no separator names their end. Deliberate, documented in
   `reports.js`, and it can remove information a maintainer wanted.
7. **`private: true` in `extension/package.json`** is ignored by vsce; it is kept as an npm guard and stripped from the
   packaged manifest by `extension/scripts/package.js`, with `verify_vsix.py` refusing a leak.
8. **The packaged artifact carries no Changelog asset.** `extension/readme.md` ships (40 552 bytes, with the 0.3.10
   section) and is the Marketplace Details asset, but `extension/CHANGELOG.md` is 72 875 bytes against 33 898 bytes of
   headroom under the reviewed 1 310 720 unpacked ceiling. Shipping it whole means raising a reviewed limit; shipping a
   generated current-release-only section means a new generated member. Both options are written into the runbook;
   neither was decided here.
8. Carried from 0.3.9: the bundle reference note ("Anchors verified in this session"), `dedupe_records.py` unbounded
   report, and T8-18 (the 0.3.8 field re-run).

## Decisions taken in this release

- **Manual send only.** File + clipboard + modal consent + a `mailto:` draft in the operator's own mail program. No
  upload, no server, no background send, and no setting that turns one on. The maintainer address is a constant in
  `reports.js`, not a user setting.
- **Updates go through the gallery identity** `michaelprinc.research-stack-toolkit@<version>`, never through a
  self-downloaded VSIX — a gallery install is signed and returns a file-installed extension to normal automatic
  updating.
- **One reviewed network module, bounded four ways** (host, 8 000 ms timeout, 64 KiB cap, 24 h cooldown, one call site),
  with the audit failing in both directions. Activation performs no request.
- **A failed check is a sentence, not an exception**, and a kept verdict is labelled as kept.
- **Redaction before presentation**, counted in the report, with a public URL deliberately kept and over-redaction as
  the documented default.
- **Version parsing refuses what the Marketplace refuses** (`0.3.10.1`, `0.3.10-beta`).
- **Publish the audited artifact** with `vsce publish --packagePath`, never a fresh CLI packaging run.

## Next highest-value action

Outside this container, in order: create the publisher `michaelprinc`, then publish 0.3.10 with the runbook in
`docs/implementation/phase-10-marketplace-release/implementation-report-0.3.10.md` §4 — Trusted publishing needs the
vsce bump to 4.1.0 and a Trusted Publishing policy; the PAT path needs the licence decision made first. Inside the
repository, the next value is the licence decision (it changes the manifest, the audit's publication claim and both
bundle receipts) and a Windows 11 / VS Code / Copilot pass against `dist/research-stack-toolkit-0.3.10.vsix` recorded as
a new evidence folder.
