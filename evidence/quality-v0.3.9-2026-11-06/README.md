# Research Stack Toolkit 0.3.9 — quality evidence, 6 November 2026

Everything in this folder was produced in the development container described below. Nothing here was
produced on Windows 11, in a VS Code Extension Host, or with Copilot attached, and no receipt in this
folder should be read as if it had been.

## The machine that ran this

| | |
|---|---|
| Host | WSL2, Debian 13 (trixie), Linux 6.6 x86_64 |
| Python | `.venv` CPython 3.12.16 — mcp 2.2.0, pypdf 6.4.1, python-docx 1.2.0, pytest 8.4.2 |
| Node | v24.22.0, npm 12.2.0 |
| uv | pinned binaries at `/tmp/uvs` — the lock was written and checked with **uv 0.13.6** |
| SQLite | 3.53.1 |
| Repository | `main`, release tag `v0.3.8` = `7638898`; 0.3.9 is the working tree on top of it |

Tests never touch a live profile, a live chat session, a research store or a credential. Every fixture is
under `/tmp` and every store is disposable.

## Commands and results

| What ran | Command | Result | Receipt |
|---|---|---|---|
| Python suite | `.venv/bin/python -m pytest tests/ -o addopts="" -q` | **257 passed, 1 skipped** in 132.18 s | `python-suite.txt` |
| Node suite (17 test files) | `cd extension && PATH=/tmp/uvs:$PATH npm test` | **355 tests, 355 pass, 0 fail, 0 skipped** | `node-suite.txt` |
| Lock pair | `.venv/bin/python scripts/lockintegrity.py` | `"ok": true`, `"problems": []` | `lockintegrity-cli.json` |
| Lock, pinned uv | `/tmp/uvs/uv-0.13.6 lock --check` | `Resolved 40 packages in 3ms` | `uv-lock-check.txt` |
| Bundle catalog is generated, not hand-edited | `.venv/bin/python scripts/build_bundle_catalog.py --check` | 2 bundles, 12 files, 67 797 bytes, 1 unresolved licence, `publishable=False` | `bundle-catalog-check.txt` |
| Package | `cd extension && PATH=/tmp/uvs:$PATH npm run package` | `dist/research-stack-toolkit-0.3.9.vsix`, 101 members, **400 486 bytes** | `package.txt` |
| VSIX audit | `cd extension && PATH=/tmp/uvs:$PATH npm run verify-package` | `"result": "passed"` | `vsix-audit.txt`, `vsix-audit.json` |
| Installed-payload check | `cd extension && PATH=/tmp/uvs:$PATH npm run check:payload` | `"result": "passed"` | `payload-check.txt`, `payload-check.json` |
| Bundle install through the shipped module | `extension/bundles.js` driven from Node against a disposable workspace | 11 files installed, 11 written; second install writes 0; a user edit is reported `user-modified` and left alone; repair reports the drift and reinstalls 10 | `bundle-install-proof.json` |
| The artifact is buildable from the tag | `git archive v0.3.9` into a disposable tree, run `scripts/build_worker_bundle.py` there, then `verify(artifact, source_root=<tag tree>/extension)` | `"result": "passed"`, `sourceFilesMatch: true`, 101 members | `vsix-audit-from-tag.json` |

## The artifact

| | |
|---|---|
| Path | `dist/research-stack-toolkit-0.3.9.vsix` |
| SHA-256 | `d5fe4675b4a9f3d1e489cfdff28ea1f8e4bc67ae05e7720db008dbc33f698ee4` |
| Size | 400 486 bytes |
| Members | 101 |
| Unpacked | **1 216 022 bytes** of the reviewed ceiling **1 310 720** — 94 698 bytes of headroom |
| Source match | every member byte-equal to the reviewed source tree (`sourceFilesMatch: true`) |
| Bundle group | 2 bundles, 12 files, 67 797 bytes, both `publishable: false`, one unresolved licence |

The ceiling was raised from 1 048 576 for 0.3.9 and the reason is recorded beside the constant in
`scripts/verify_vsix.py`: 0.3.8 unpacked to 1 035 352 across 87 members; 0.3.9 adds the reviewed bundle
payload (67 797 over 12 files), its catalog, the bundle installer module and the 0.3.9 guide and worker
text. The projected figure in the design note was 1 141 977; the measured figure is 1 216 022, and the
measured figure is what the gate now holds.

## Three defects the packaging gates caught, and what they would have shipped

1. **`extension/bundles.js` was not in the packaged payload.** `extension/scripts/package.js` stages an
   explicit file list; the bundle work added the `bundles/` payload directory but not the module that reads
   it. `npm run check:payload` failed with `Cannot find module './bundles'` while loading the packaged
   `extension.js` — that is a shipped extension that activates and then fails. Fixed in `package.js`,
   `extension/package.json`, `extension/vsix-manifest.json` and the audit inventory (99 members in 0.3.8, 101 now).
2. **`scripts/check-installed-payload.js` still asserted the 0.3.8 surface.** It expected 19 tools, 25
   commands and a 10-tool corpus preset; 0.3.9 ships 20 tools, 30 commands and an 11-tool preset. The
   counts were updated and each one now names what changed, so the next release that changes a surface
   fails loudly instead of silently keeping an old number.
3. **A reviewed template was being skipped by every gate.** `templates/recommended-overlay/.github/skills/document-corpus-bridge/SKILL.md`
   was authored on 5 November and never packaged: `scripts/build_worker_bundle.py` iterates an explicit
   allowlist, `scripts/verify_vsix.py` checks what it expects, and nothing asked what the tree held. Its
   text also told the operator that PDF and DOCX had to be staged as derived Markdown — true of 0.3.8, false
   of 0.3.9. It is now the reviewed bundle `document-corpus-bridge` 2.0 (1 file, 6 972 bytes) with the 0.3.9
   workflow, and `assert_overlay_tree_is_reviewed` refuses a build whenever the overlay tree holds a template
   the allowlist does not name (`tests/test_lock_consistency.py`).

## What these receipts do not prove

- No Windows 11 install, no VS Code Extension Host, no Copilot session. `check:payload` runs the packaged
  `extension.js` against a synthetic harness in this container; it is not a real Extension Host.
- `hostDiscoveryVerified` and `workflowTested` are `false` in every bundle receipt, with the reason written
  into the receipt. Nothing here shows that any assistant discovers a skill placed in `.github/skills/`.
- The reading check (`extension/functional_check.py`) indexes a Markdown fixture, then verifies it and
  reports it `changed` after an edit. It does **not** index a PDF or a DOCX end to end; PDF and DOCX are
  proven by the Python suite (`tests/test_ingestion.py`, `tests/test_freshness.py`).
- The theological bundle is packaged and installable but **not publishable**: its licence is unresolved and
  `publishable: false` is enforced by the generator, the reader and the VSIX audit.
- The bundle's optional `scripts/crossref_lookup.py` makes outbound requests when a user runs it. It was
  never run here; the audit lists it under `outboundNetworkMembers` rather than pretending it is inert.
- Gates G1–G4 (the reference-host profile gates) remain open, as they were for 0.3.6, 0.3.7 and 0.3.8.
