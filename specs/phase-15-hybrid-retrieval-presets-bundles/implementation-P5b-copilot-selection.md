# P5b implementation note — a preset's GitHub tools, written where Copilot reads them

Release 0.3.14, package **P5b** (spec **HR-11**, **HR-12**; design **DD15-01**, **DD15-03**, **DD15-06**,
**DD15-07**; `preset-selection.md` §7; acceptance **T15-13**; `research/github-mcp-tool-map-2026-11-17.md`
§1.2, §1.4, §5).
Written 2026-11-18 00:40Z from measurements taken on this working tree. Every number below is a measurement
of source files, not a claim about a packaged extension or about a running Copilot.

## What P5b changed

| File | Change |
|---|---|
| `extension/presetselect.js` | **new module**, 23,760 B / 418 lines as written by this package (24,450 B now: a maintainer edit at 00:10 that added the `server.excludeTools` reading). CommonJS, `"use strict"`, pure — no `require("vscode")`, no filesystem, no socket, no `child_process`, no `process.*`, no `eval`/`Function`. Text in, text out. |
| `extension/extension.js` | one command region (~1069–1200, between `researchToolkit.restoreBundleArchive` and `const mcpProvider = {`) plus the panel action entry (`:1905`). Head additions: `require("node:fs/promises")`, `directory` added to the `require("./runtime")` destructure, `require("./presetselect")`. No other region touched. |
| `extension/package.json`, `extension/vsix-manifest.json` | `contributes.commands` **42 → 43** (`researchToolkit.configurePresetTools`, "Configure Preset Tools for Copilot", category `Research Toolkit`, in the same position in both files); `files` **32 → 33** (`"presetselect.js"`). Version and the configuration block, including the `researchStack.toolsPreset` enum, were not touched by this package. |
| `extension/test/presetselect.test.js` | **new test file**, 19 cases (see "The test file" below). Added to the explicit `npm test` file list. |
| `extension/test/unit.test.js` | pins renegotiated: contributed commands 42 → **43** (`:66`), registered 42 → **43** (`:80`), disposals 43 → **44** (`:105`); `shippedAllowlist` gained `"presetselect.js"` (`:26`); the contributed-command loop gained the new id (`:73`). Each pin's sentence names the three 0.3.14 bundle commands **and** the new command. |
| `extension/test/integration-host.test.js` | both pinned registered counts → **43** (`:942`, `:947`). |
| `extension/scripts/check-installed-payload.js` | pinned registered count → **43** (`:275`) with the same sentence, and the id joined its "is registered" list (`:281`). |
| `extension/test/module-boundaries.test.js` | reviewed set gained `"presetselect.js": []` (`:44`) — no module requires, node builtins only — and `extension.js`'s allowed requires gained `"presetselect.js"` (`:46`). |
| `extension/scripts/package.js` | `"presetselect.js"` added to the explicit staging list (`:154`), otherwise the module would not ship. |

`extension/presets.json`, `extension/bundles.js`, `extension/runtime.js`, `extension/ui.js`,
`extension/integrations*.js`, `extension/worker/**`, `src/**`, `tests/**` and `scripts/verify_vsix.py` are
outside P5b's ownership and were not edited by it. `scripts/verify_vsix.py` now lists
`"extension/presetselect.js"` in its `EXPECTED` member set (`:52`) — that was the main agent's edit, not this
package's.

## The rule the module is built on (HR-11)

A selection's tool count is **the length of the names it lists**. `toolsEstimate` is compared against that
list once, at read time, and then never used: a preset whose estimate disagrees is refused rather than
trusted, and the refusal quotes both numbers. Read-only must be stated as `true` or `false` — an absent flag
is a refusal, never a default. A preset with no GitHub-shaped entry returns `null`, which is a real answer
(`research-max-no-github`, and every narrow preset) and writes nothing; a preset carrying two GitHub surfaces
is refused as ambiguous; a third-party entry that is not GitHub-shaped is never written silently.

## The marker field

Written inside the server entry it produces:

```json
"//researchStackPreset": {
  "toolkit": "research-stack-toolkit",
  "presetId": "research-max-github-limited",
  "selectionId": "github-limited",
  "toolCount": 42,
  "readOnly": true,
  "writtenAt": "2026-11-17T22:00:00.000Z"
}
```

`isToolkitWritten()` requires `marker.toolkit === "research-stack-toolkit"` **and** a string `presetId`. That
is what separates "this Toolkit wrote this entry, so a later run may replace it" from "an entry the operator
wrote, which this Toolkit will not touch". A marker copied by hand into a hand-written entry does not license
an overwrite: the toolkit id and a preset id are both required, and an entry without a genuine marker is
refused with `server-entry-not-written-by-this-toolkit` and left alone.

## Refusal codes (28, verbatim)

`preset-is-not-a-preset`, `selection-id-invalid`, `preset-has-no-github-selection`,
`preset-has-multiple-github-surfaces`, `selection-does-not-state-its-surface`, `selection-names-no-tools`,
`selection-names-a-tool-twice`, `unsafe-tool-name`,
`selection-tool-count-does-not-match-its-named-list`, `unsafe-toolset-name`,
`selection-excludes-a-tool-it-also-selects`, `remote-url-is-not-the-reviewed-github-host`,
`unsafe-server-key`, `merge-option-not-accepted`, `literal-credential-refused`, `mcp-file-is-not-text`,
`mcp-file-is-not-valid-json`, `mcp-file-is-not-an-object`, `mcp-file-uses-the-editor-server-format`,
`mcp-servers-is-not-an-object`, `server-entry-is-not-an-object`,
`server-entry-not-written-by-this-toolkit`, `unknown-selection-shape`, `target-is-a-link`,
`target-changed-after-it-was-reviewed`, `outside-workspace`, `previous-copy-refused`,
`mcp-file-write-not-verified`.

`refuse()` sets both `error.refusal` and `error.code` (`bundles.js` sets `refusal` alone). A refusal is always
"nothing was produced": no partial file, no partly-merged object.

Three of them carry the design, so they are worth naming:

- `mcp-file-uses-the-editor-server-format` — a file whose top-level key is `servers` is refused, because the
  deprecated `.vscode/mcp.json` shape carries no per-server tool allow-list, so a tool subset written into it
  would be silently ignored (DD15-03).
- `literal-credential-refused` — no option of `mergeIntoMcpFile` accepts a token (`token`, `accessToken`,
  `pat`, `personalAccessToken`, `githubToken`, `authorization` are refused as option names), and the **whole
  produced text** is re-scanned for credential shapes (`ghp_/gho_/ghu_/ghs_/ghr_` prefixes, `github_pat_`), so
  a hand-written token that the merge would have preserved also refuses the run. The only token form that can
  appear is `${GITHUB_PERSONAL_ACCESS_TOKEN}`.
- `selection-excludes-a-tool-it-also-selects` — a surface cannot name a tool as both selected and excluded.

`mergeIntoMcpFile` accepts exactly `existingJson | preset | serverKey | variant ("remote" | "local") |
writtenAt`; anything else is `merge-option-not-accepted` / `unknown-selection-shape`.

## The command

**`researchToolkit.configurePresetTools`** — the only command in the Toolkit that writes a preset's GitHub
tool selection. Nothing else does: not a preset switch, not a setup step, not a panel refresh.

- Target: workspace-root **`.mcp.json`**, `mcpServers` object, server key `github`. The review text states
  in its own words why `.vscode/mcp.json` is not used.
- Both shapes are computed and shown **before** the modal, so the two buttons ("Write the hosted entry (http)"
  / "Write the local entry (stdio)") choose between two plans the operator has already seen, not between a
  plan and an unseen one. Hosted: `type: "http"`, the reviewed `https://api.githubcopilot.com/…` URL, and
  `X-MCP-Toolsets` / `X-MCP-Readonly` / `X-MCP-Exclude-Tools`. Local: `type: "stdio"`, `github-mcp-server
  stdio`, `GITHUB_PERSONAL_ACCESS_TOKEN` left as a reference, `GITHUB_TOOLSETS`, `GITHUB_TOOLS`,
  `GITHUB_READ_ONLY`, `GITHUB_EXCLUDE_TOOLS`. Both shapes also carry the harness-side `tools` array.
- The review names: the file path, the server key, the toolsets, **every selected tool name and its count**,
  read-only yes/no, the write tools named as excluded, what is already in the file and what will be preserved,
  where the copy of the previous bytes will go, and that the file will hold a reference and never a value.
- Hosted URLs are only writable on `https://api.githubcopilot.com` with no userinfo and no query.
- After the operator answers, the file is **read again**; if its bytes changed while the modal was open, the
  run refuses with `target-changed-after-it-was-reviewed` and writes nothing.
- The previous bytes are copied to `.research-toolkit/preset-tools/<UTC stamp>-<0001…9999>.json` with `wx`,
  then re-read to prove the copy holds what it claims; the new text is staged to
  `.mcp.json.<uuid>.tmp` with `wx` and `rename`d into place, then read back. Links are refused by `lstat`
  before and after staging. A copy is kept whenever bytes existed — including when only the marker timestamp
  differs, because the copy answers "what was in the file before this command ran", and skipping it sometimes
  would make that answer depend on a timestamp collision. Nothing in that folder is ever deleted or rewritten.
- Outcome and the tool count are reported in the output channel as the plan record (JSON, with `filePath` and
  `previousBytesCopiedTo`), and in the information message.
- Presets: `preset.thirdParty[].server.excludeTools` is the exclude list; `preset.thirdParty[].tools` is the
  named selection.

A panel button now ships for it (`extension/ui.js:38`, `data-action="configurePresetTools"`, "Select the
GitHub tools this preset offers Copilot") — added by the main agent after this package's own report, which
had recorded the allow-list entry only. An allow-list entry is a route; a button is an offer.

## The vendor arithmetic, as measured against `research/github-mcp-tool-map-2026-11-17.md` §3

| Quantity | Measured |
|---|---|
| §3 table rows | 93 entries, **92 unique names** |
| Unique read-only names | **57** |
| Unique write names | **35** |
| `research-max-github-full` GitHub selection | **92 names = the whole unique set**; 21 toolsets; read-only off |
| `research-max-github-limited` GitHub selection | **42 names, all 42 read-only**; 14 toolsets; read-only on; **35 excluded = exactly the write set** |
| Read-only names neither selected nor excluded | **15**: `ui_get`, `get_notification_details`, `list_notifications`, `projects_get`, `projects_list`, `get_discussion`, `get_discussion_comments`, `list_discussion_categories`, `list_discussions`, `list_starred_repositories`, `actions_get`, `actions_list`, `get_job_logs`, `custom_properties_read`, `repository_ruleset_read` |
| Arithmetic | 42 + 35 + 15 = 92 |
| Toolsets only in the full surface | `copilot`, `actions`, `discussions`, `governance`, `notifications`, `projects`, `stargazers` |
| Toolkit tools (from `extension/presets.json`) | full 16, limited 20, no-github 20 |
| Totals against the ceilings | 16 + 92 = 108, 20 + 42 = 62, 20 + 0 = 20, all under `clientCeiling` 128 |

No tool name in a preset was invented by this package: the shipped names are the §3 names, and
`test/presetselect.test.js` asserts the selections against `extension/presets.json` as it is on disk.

## Measured results

- `node --test test/presetselect.test.js` — **19 tests, 19 pass, 0 fail** (also at 00:36, after the maintainer
  edits to `presetselect.js` and `presets.json`).
- `npm test` — **525 tests, 524 pass, 0 fail, 1 skipped** at 00:19. The single skip is
  `test/lockfile-adversarial.test.js:568` ("no uv binary at a reviewed path"), pre-existing and unrelated.
  Earlier in this package the same gate read 498/494/4 at hand-off (the brief stated 497/497/0) and 525/523/2
  at 23:47; both remaining failures then were outside P5b's ownership — the `researchStack.toolsPreset` enum
  pin in `test/unit.test.js:29`, and `test/module-boundaries.test.js` objecting to a scratch file
  `extension/.tmp-preset-audit.js` whose own header says it is deleted after its numbers are recorded. Both
  were cleared by their owners, not by this package.
- `npm run test:panel` — **9 assertions, 9 pass, 0 fail, 0 not proven** at 00:25; `scripts/panel_renderer_check.js:678`
  now asserts the `configurePresetTools` action and its label.
- `node --check` clean on `presetselect.js`, `extension.js` and `test/presetselect.test.js`; every file this
  package touched is **LF-only** (`.gitattributes` is `* text=auto eol=lf`).
- Payload size, measured but **not** gated: the staged file set of `vsix-manifest.json` sums to **1,705,372 B**
  against `scripts/verify_vsix.py`'s `MAX_UNPACKED_BYTES = 1_572_864` — already over it at 1,681,612 B without
  `presetselect.js` (23,760 B). This is a staged-tree sum, not a zip-member sum. `dist/` still holds no 0.3.14
  artifact (newest is 0.3.9), so `npm run verify-package` and `npm run check:payload` cannot agree with these
  pins until 0.3.14 is packaged; the ceiling needs a measured decision by whoever packages it.

## The test file, and who wrote what

`extension/test/presetselect.test.js` on disk is **this package's file**: 29,240 B, 19 `test(` cases, written
by this package at 22:05–23:50. An earlier 13-case version of the same file (13 pure-module cases) existed in
the tree and was **overwritten** by this package's 19-case version; the parent agent's message describes that
13-case state. The merge into the main agent's tree deliberately kept the 19-case file: the extra 6 cases are
the ones that drive the shipped command through `test/harness.js` against real `mkdtempSync` workspaces —
no answer means no write; the hosted write and its count in the output channel; the local write and the token
left as a reference; nothing written for a preset with no GitHub surface; refusal when the file changed after
the review; refusal and byte-identity when a hand-written `github` entry is in the way (and the same case with
`.mcp.json` as a link). If the 13-case file is the version the release wants, that is a deliberate replacement
decision, not something to be resolved by writing over a file.

## Not claimed, and owed

- **No `tools/list` was captured on this host.** Every tool name here is a catalog name as reviewed on
  2026-11-17; the command's own review text says so in its last line. "92 names exist on a running GitHub MCP
  server" is not claimed anywhere in this package.
- **Not proven that Copilot honours what is written.** That the harness reads the per-server `tools` array in
  `.mcp.json`, and that it tolerates the unknown `//researchStackPreset` member in a server entry, needs a real
  VS Code / Copilot run. `extension/test/browser.test.js` has never run in this container and
  `npm run test:host` was not run here.
- **`GITHUB_TOOLS` is additive.** It can only widen what the local server offers, never narrow it, so for the
  local entry the real cap is the harness-side `tools` array, not the environment variable. That caveat is
  written into the module and the review text; it is documented, not measured.
- **`target-changed-after-it-was-reviewed` is proven only by a patched harness modal** that changes the file in
  the same breath as answering. A real operator racing the command is not simulated here.
- **A read-only switch is a filter, not a permission boundary.** It decides which tools the server offers; the
  token decides what the account may do. The full surface enables write tools, and approval for each call still
  belongs to the host and to the token's scope. The review text states this; nothing here enforces it.
- **No retention policy** for `.research-toolkit/preset-tools/`: copies are never pruned or rewritten, and no
  limit is implemented or claimed.
- `MAX_UNPACKED_BYTES` (above) is an open packaging decision, and the 0.3.14 artifact does not exist yet.
