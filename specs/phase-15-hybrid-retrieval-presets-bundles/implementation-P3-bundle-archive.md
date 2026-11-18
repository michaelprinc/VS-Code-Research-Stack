# P3 implementation note — force update, bundle archive, index, log, restore

Release 0.3.14, package **P3** (spec HR-20…HR-23, design DD15-04, acceptance T15-14…T15-17).
Written while the release is still in progress: the numbers below are measurements taken on this tree on
2026-11-17, not claims about the packaged extension.

## What P3 changed

| File | Change |
|---|---|
| `extension/bundles.js` | +942 lines: archive, force, index, log, `listArchives`, `restoreArchive`. No new module — `test/module-boundaries.test.js` requires `bundles.js` to depend on nothing but node builtins, and a new top-level `.js` would leave the shipped-module set. |
| `extension/test/bundles.test.js` | 19 → 29 tests, +360 lines: T15-14…T15-17 plus refusal, provenance and damaged-index cases. |
| `extension/extension.js` | +97 lines, bundle command region only (`@@ -877,0 +906,93 @@` and the action map `@@ -1569,0 +1691,4 @@`). The integration region (lines ~227–374, another agent's) was not touched. |
| `extension/package.json`, `extension/vsix-manifest.json` | `contributes.commands` 39 → 42, in the same position in both files. Version and the configuration block were not touched. |
| `extension/test/unit.test.js` | pins renegotiated (53, 65, 93) + one new command-level test. |
| `extension/test/integration-host.test.js` | two pinned command counts renegotiated (their own comments say why). |
| `extension/scripts/check-installed-payload.js` | pinned registered count renegotiated, sentence names the three new commands, and the three ids joined its "is registered" list. |
| `extension/test/harness.js` | +12 lines: `showQuickPick` answers from `quickPicks` for a title it has no dedicated rule for, and still throws when a test passed no answers. Without this no test can drive a bundle Quick Pick. |

## Archive layout

```
<workspace>/.research-toolkit/bundles/archive/
  index.json                                  schema-versioned, append-only listing
  archive.log                                 one line per archive, plain text
  <bundleId>/<archiveId>/                     the archived bytes, workspace-relative path kept
  <bundleId>/<archiveId>/archive.json         the manifest for that archive
```

`archiveId` is `<UTC stamp>-<sequence>`: `20261117T205542Z-0001`. The stamp is the run's UTC second, the
sequence is the next free number in that bundle's folder for that second, and the claim is a `mkdir` **without**
`recursive` — the failure of a second `mkdir` on the same path is what makes two runs in the same second take
different ids without a lock file. `.research-toolkit/bundles/archive` is a single component created by
`ensureRealDirectory`, so a link anywhere on that path is refused, and every archive id is matched against
`/^[0-9]{8}T[0-9]{6}Z-[0-9]{4}$/` before it is used in a path.

Archiving is a copy, never a move, and it happens **before** any target is written. Each copy is written with
`flag: "wx"` into a directory nothing else writes to, then re-read and hashed; a mismatch aborts the run with
"Nothing was overwritten." Nothing in this design deletes an archive.

## Manifest (`archive.json`)

`schemaVersion, archiveId, stamp, sequence, bundleId, bundleVersion (the version being written),
replacedVersion (the version whose bytes were archived), skills, archivedAt, reason, workspace,
archiveDirectory, absoluteArchiveDirectory, files[]` where each file carries
`path` (workspace-relative), `workspacePath` (absolute source), `archivePath`, `sha256` **of the archived copy**,
`bytes`, `state` (`outdated | user-modified | conflict`), `replacedBySha256` and `replacedBy`
(the catalog file the bytes are being replaced by).

`reason` is one of `force-update`, `restore`, `upgrade`: `upgrade` is the normal repair replacing an older copy
this Toolkit installed, `force-update` is an operator-authorized overwrite of a `user-modified` or `conflict`
file, `restore` is what a restore wrote out of the way.

## Index and log

`index.json`: `{ schemaVersion: 1, updatedAt, archives: [ { archiveId, bundleId, bundleVersion, archivedAt,
reason, files, directory, absoluteDirectory, manifest } ] }` — appended by temp file + rename, the same
crash discipline as `writeReceiptFile`. A damaged index is rebuilt from the tree and reported as
`index: { readable: false, rebuilt: true, count }`; an index of an unknown schema version is refused
(`archive-index-unknown-schema`) and the tree is still listed. A non-directory or a folder that is not a bundle
id is reported in `refused`, never invented into an archive.

`archive.log`, one tab-separated line per archive:

```
2026-11-17T20:55:42.512Z\t20261117T205542Z-0001\tbundle=theological-research\treason=force-update\tfiles=1\tarchive=/tmp/…/archive/theological-research/20261117T205542Z-0001
```

The last field is the **absolute** path, so the log is readable from anywhere without knowing the workspace root.
It is appended by temp file + rename, so a reader never sees a half line.

## Force and refusal codes

`installBundle`/`repairBundle` take `force` as an **explicit** `true` or `false`; anything else is a
`TypeError`. No call site inherits force from a default. Force reaches exactly two states — `user-modified`
and `conflict` — and only when the file is a regular file whose current bytes are recorded. `shared-with-other-bundle`
is never forceable: ownership by another bundle is not a force question. `planInstall({force:true})` returns
`overwrites` (every present file a run would replace, with its state) and `forceOverwrites` (the part a normal
run preserves) plus `archivePreview.absoluteDirectory`, so the caller can name the files before asking.

New refusal codes, attached as `error.refusal`:
`unsafe-archive-id`, `archive-path-is-link`, `archive-source-not-a-file`, `archive-write-refused`,
`archive-hash-mismatch`, `archive-not-found`, `archive-manifest-invalid`, `archive-index-unknown-schema`,
`archive-id-exhausted`, `restore-path-out-of-scope`, `target-not-a-regular-file`, `target-changed-mid-run`,
`outside-workspace`. Each message states what was not done ("Nothing was overwritten.").

`restoreArchive` stages the archived bytes under `.research-toolkit/bundles/staging/restore/<bundleId>/<archiveId>`,
hash-verifies archive → staging → the file it will write, then archives what it replaces (reason `restore`) and
renames the staged copies in, rechecking the target hash immediately before each rename. A restore receipt
rewrites `bundleVersion` to the version being restored, records `previousVersion`, and keeps `force: false`.

## Commands

- `researchToolkit.forceUpdateTopicBundle` — picks the bundle, plans with `force: true`, then a modal that lists
  **every** file it would overwrite with the state it measured ("a file you changed after this Toolkit installed
  it", "a copy this Toolkit installed, at an older catalog version", "a file this Toolkit never installed"), how
  many of those a normal run would preserve, and the absolute folder the replaced bytes go to. Declining writes
  nothing. With nothing to replace it asks nothing and says so.
- `researchToolkit.showBundleArchiveHistory` — lists archives newest first, then shows one manifest in the output
  channel, naming the absolute archive directory.
- `researchToolkit.restoreBundleArchive` — bundle, then archive, then a modal naming each file that will be
  written back and stating that what is there now is archived first.

Contributed in `package.json` and `vsix-manifest.json` as "Force Update Topic Skill Bundle (Archive First)",
"Show Bundle Archive History", "Restore Bundle Archive Version", category `Research Toolkit`. Registered count
36 → 39, contributed 39 → 42; every registered command is still contributed.

## Measured results

- `node --test test/bundles.test.js` — **29 pass, 0 fail**.
- `node --test test/module-boundaries.test.js` — 5 pass. `node --test test/gui-status.test.js` — 12 pass.
- `npm run test:panel` — 7 assertions, **7 pass, 0 fail, 0 not proven**.
- `npm test` — **498 tests, 494 pass, 4 fail** at 22:10 (P3's own files: `bundles.test.js` 29/29,
  `integration-host.test.js` 55/55, `gui-status.test.js` 12/12, `unit.test.js` 15/16). Baseline before this
  package was 482/482; P3's tests are all green. The 4 failures are all outside P3's ownership and appeared while
  other packages were mid-edit after P3's own suite was green (497/497 at 20:25):
  `preset tools come from the shipped worker servers and never exceed the client ceiling` (21 tools vs a pin of 20),
  `Quick Pick lists only presets the package offers and keeps the choice in the budget`,
  `the settings contributions describe the shipped presets and commands without drift`
  (`presets.json` label `Documents + third-party evidence (retired)` vs the manifest label
  `Documents, citations and third-party evidence`) — `extension/presets.json` was edited at 20:28 and
  `src/research_stack/presets.py` at 20:32, both outside P3's ownership and both still being edited — and
  `the shipped module set is exactly the reviewed set…`, because `extension/presetselect.js` (HR-11/HR-12, added
  at 22:05 by the preset→Copilot package) is not yet in `test/module-boundaries.test.js`'s reviewed list. They
  are reported, not rewritten.
- Throwaway smoke run (`/tmp/p3smoke.mjs`, deleted): a force run archived 3 files, a restore wrote 3 back and
  created a second archive with reason `restore`, a second force run inside the same second took sequence
  `0003`, and `listArchives` reported 3 archives newest first.

## Not claimed, and owed

- **No live VS Code run.** The command behaviour is proven through `test/harness.js`, which fakes the editor.
  `extension/test/browser.test.js` has never run in this container, and `npm run test:host` was not run here.
- **No panel buttons.** `extension/ui.js` is outside P3's ownership. The host allowlist already accepts
  `forceBundleUpdate`, `bundleArchives` and `restoreBundleArchive`, so offering them is one line in the bundle row
  of `ui.js` (line ~38), next to the existing `installBundle` / `repairBundle` / `bundleStatus` buttons:
  `data-action="forceBundleUpdate"`, `data-action="bundleArchives"`, `data-action="restoreBundleArchive"`.
  Until that line exists the three commands are Command Palette commands, not panel controls: an allowlist entry
  is a route, not an offer.
- **`npm run check:payload` ran and fails, for a packaging-order reason.** `scripts/with-artifact.js` names the
  artifact from `vsix-manifest.json`, which still declares **0.3.13** — the 0.3.14 version bump has not been made
  in this tree — so the gate audited `dist/research-stack-toolkit-0.3.13.vsix`, a payload that predates the three
  new commands, and reported `39 !== 42`. The pin describes the source this release cuts, so that gate can only
  agree once 0.3.14 is versioned and packaged. `npm run verify-package` was not run for the same reason. The
  manifest and command mirrors are covered by `test/release-artifact.test.js` and `test/unit.test.js`, which pass.
- An archive is never pruned and no archive is ever deleted: growth is by design, and no retention policy is
  implemented or claimed here.
- `listArchives` reads the tree, so an archive whose manifest is missing or invalid is reported in `refused`
  rather than summarized. A manifest whose recorded hashes no longer match its archived bytes fails
  `restoreArchive` with `archive-hash-mismatch`; that is proven for a tampered archived file, not for a tampered
  manifest claiming a hash it never had.
