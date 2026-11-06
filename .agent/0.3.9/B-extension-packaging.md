# B — Extension control panel, overlay install, worker bundle & VSIX packaging (read-only audit for 0.3.9)

Scope: `extension/**`, `scripts/**`, `tests/**`, `templates/**`. No file was modified except this report.
Repo root below is `toolkit/`. All citations are `file:line` from the tree as of this read (0.3.8 shipped).

---

## 1. The control panel

**Command registration.** One helper, one place:

```js
// extension/extension.js:369
const register = (id, callback) => context.subscriptions.push(vscode.commands.registerCommand(id, callback));
```

22 commands go through it (`extension/extension.js:370,371,382,386,463,478,500,519,536,594,606,610,616,641,644,666,688,710,726,741,832,992`); three are registered directly on `vscode.commands` — `showPhaseReadiness` (`:913`), `switchPackage` (`:922`), `selectToolsPreset` (`:951`). All 25 are declared in `extension/package.json:106-245` and mirrored in `extension/vsix-manifest.json:106-245`.

**UI surfaces (four).**
| Surface | Where |
|---|---|
| Webview panel `researchToolkit.controls` | `extension/extension.js:820-831` (`createWebviewPanel` at `:822`, HTML from `controlPanelHtml` at `:827`, `onDidReceiveMessage(handleMessage)` at `:828`) |
| Tree view `researchToolkit.overview` ("Toolkit Controls") | provider `extension/extension.js:835-870`, registered `:871`; declared `extension/package.json:255-262` |
| QuickPick flows | `extension/extension.js:922` (package), `:951` (tools preset), `:992` (component step selection) |
| Status bar item + MCP definition provider | `extension/extension.js:250`; `extension/extension.js:593` (`vscode.lm.registerMcpServerDefinitionProvider`) |

Panel HTML is a pure function in `extension/ui.js:9-69` (`controlPanelHtml`), with a CSP nonce at `:10,:15` and a CSP-locked script tag at `:68` loading `extension/media/controls.js`.

**How a user chooses a workspace.** There is no folder *picker*; the panel offers a `<select>` of already-open folders. `extension/ui.js:41` region renders `#diagnostics-workspace`; the client sends `{type:"selectWorkspace", index}` (`extension/media/controls.js:462`), handled at `extension/extension.js:799-802`:

```js
// extension/extension.js:800-802
if (!Number.isInteger(message.index) || message.index < 0 || message.index >= (vscode.workspace.workspaceFolders || []).length)
  throw new TypeError("Choose an open workspace folder.");
diagnosticsWorkspace = message.index;
invalidateInventory();   // extension/extension.js:876-891 — measurements belong to the folder they were taken from
```

Every write path then re-derives the folder and re-checks it: `folderSelected()` → `requireLocal()` (`extension/runtime.js:48-52`) refuses untrusted, remote, or non-`file` folders.

**How a step is presented with status.** `installer.planView` (`extension/installer.js:280-336`) builds `{steps, counts, missing, omittedOptional, failed, outdated, needsRepair}` from the receipt plus observed artifacts; `stepStatus` (`extension/installer.js:209-241`) yields `missing | outdated | needs-repair | installed`. The controller puts it in `state()` (`extension/extension.js:316`) as `installPlan`, and the webview renders it at `extension/media/controls.js:313-360`. The separate **Installation status** card (`extension/ui.js:24-33`) renders `installation` at `extension/media/controls.js:249-311`; the verdict *wording* is owned by `extension/status.js:12-19` (`OUTCOME_LABEL`) and `:109-120` (`outcomeLine`), and `extension/test/module-boundaries.test.js:121-128` refuses to move that wording into `ui.js`.

**Exact functions to extend for a new "Install skill bundle" flow.**
1. `extension/ui.js:37` — add a button, e.g. `<button class="secondary" data-action="installBundle">Install skill bundle…</button>`. The generic wiring at `extension/media/controls.js:469-472` already sends `{type:"action", action:"installBundle"}` for any `data-action` button not in `dedicatedHandlers` (`:466`), so **no client change is needed** if the action is routed through the existing loop.
2. `extension/extension.js:762-769` — the `actions` map in `handleMessage`; add `installBundle: "researchToolkit.installSkillBundle"`.
3. A new `register("researchToolkit.installSkillBundle", …)` next to `extension/extension.js:519` / `:536` (the reading-check pair), guarded by `exclusive(...)` and `requireLocal`.
4. `extension/package.json:106` + `extension/vsix-manifest.json:106` — declare the command (the two manifests must stay byte-equal modulo `scripts`/`devDependencies`/`private`: `scripts/verify_vsix.py:170-189`).
5. Optionally a tree row in `extension/extension.js:843-856`.

---

## 2. The existing overlay install path

**The allowlist lives in three places, and they must agree.**

| Layer | File:line | Content |
|---|---|---|
| Build allowlist | `scripts/build_worker_bundle.py:18-30` | `OVERLAY_FILES` — 11 explicit paths |
| Build path pattern | `scripts/build_worker_bundle.py:31-34` | `OVERLAY_PATTERN` |
| Runtime path pattern | `extension/runtime.js:17` | `OVERLAY_PATH` (a second copy of the same regex) |
| Shipped inventory | `extension/worker/bundle.json` `overlayFiles` | 11 entries, sha256 each |

```python
# scripts/build_worker_bundle.py:31-34
OVERLAY_PATTERN = re.compile(
    r"^(\.github/skills/[a-z0-9-]+/SKILL\.md|\.research-toolkit/recommended-profile\.json"
    r"|notebooks/analysis/(pyproject\.toml|uv\.lock|\.python-version)|notebooks/[a-z0-9-]+\.ipynb|research/README\.md)$"
)
```

`.github/skills/<id>/SKILL.md` is the **only** accepted shape under `.github/skills/` — one file, at exactly that depth. `references/`, `scripts/`, `evals/`, `README.md` inside a skill directory are rejected at build time (`:74-75`) and again at runtime (`extension/runtime.js:68-70`).

**How files are copied.** `extension/steps.js:82-105`:

```js
// extension/steps.js:88-100
if (overlayStepFor(relative) !== stepId) continue;
const destination = path.join(root, relative);
await directory(root, path.dirname(relative).replace(/\\/g, "/"), true);   // runtime.js:53-62 — refuses links
const content = await fs.readFile(path.join(source, "overlay", relative));
if (digestOf(content) !== expected) throw new Error(`Bundled overlay integrity check failed for ${relative}. …`);
try { await fs.writeFile(destination, content, { flag: "wx" }); created.push(relative); }
catch (error) {
  if (error.code !== "EEXIST") throw error;
  if ((await fs.lstat(destination)).isSymbolicLink()) throw new Error(`Existing overlay path is a link: ${relative}. Nothing was written.`);
  const existing = await fs.readFile(destination);
  (digestOf(existing) === expected ? current : modifiedPreserved).push(relative);
}
```

`wx` = create-or-fail. **Nothing is ever overwritten.** Step attribution is a prefix rule:

```js
// extension/steps.js:78-80
function overlayStepFor(relative) {
  return relative.startsWith("notebooks/analysis/") ? "notebook-env" : "research-overlay";
}
```

**Receipt.** `.research-toolkit/managed/worker-<version>/installation.json` — name `extension/installer.js:26`, read `:95-107` (refuses a link), write `:109-131` (link refusal + unique `.tmp` + `rename`, so a crash cannot poison the next attempt). Overlay evidence text: `extension/steps.js:107-115` → `"N overlay file(s) created, M unchanged file(s) preserved[, K file(s) changed by you and preserved (they differ from this release)]."`

**Conflict / user-edit handling today.** Hand-edited files land in `modifiedPreserved` and survive (`extension/test/installer.test.js:261-277` proves it). There is no merge, no prompt, no backup, no "restore the reviewed copy" action.

**Idempotency.** `wx` + hash compare (`steps.js:94-100`); the plan engine skips steps already recorded as installed (`extension/installer.js:463` `runPlan`, `:675` `outdatedSteps`, `:680` `failedSteps`); artifacts are re-verified on every panel open (`extension/installer.js:163-205` `verifyStepArtifacts`, `:267` `planArtifacts`) so a deleted overlay file shows as `needs-repair` (`:209-241`).

---

## 3. The worker bundle build

`scripts/build_worker_bundle.py` is the only producer of `extension/worker/**`.

```python
# scripts/build_worker_bundle.py:61-64
version = re.search(r'__version__ = "([^"]+)"', (ROOT / 'src/research_stack/__init__.py').read_text(...)).group(1)
files = ['pyproject.toml', 'uv.lock', '.python-version', 'README.md'] + [
    str(p.relative_to(ROOT)).replace('\\', '/') for p in sorted((ROOT / 'src/research_stack').glob('*.py'))
]
```

* `:58` `assert_locks_current(SOURCE_PAIRS)` — refuses to bundle a pair `uv sync --locked` would refuse (`:37-46`, via `lockintegrity.check_pair`).
* `:66-71` copies each source file into `extension/worker/` and records `sha256(content)`.
* `:72-83` copies each allowlisted overlay from `templates/recommended-overlay/` into `extension/worker/overlay/`, pattern-checked (`:74-75`) and existence-checked (`:77-78`).
* `:84-90` writes the manifest: `schemaVersion: 2`, `workerVersion`, `extensionVersion`, `files`, `overlayFiles`.
* `:91-95` re-checks the **just-copied** pair *before* the manifest exists, deliberately.
* `:96-98` refuses a bundle whose copied `pyproject.toml` version differs from `__version__`.

**`extension/worker/src/research_stack/**` is a byte copy** of `src/research_stack/**` produced by `:62-71` (verified: `diff -rq` shows only `__pycache__`). It is kept in sync **only by running the build**, and drift is caught by three independent checks:

* `scripts/verify_vsix.py:366-369` — packaged member vs repository source, per file.
* `tests/test_lock_consistency.py:70` `test_worker_bundle_carries_the_reviewed_pair_byte_for_byte`.
* `tests/test_stdio.py` — byte-equality of the bundled `stdio.py`/`cli.py` (see `.agent/QUALITY_STATE.md`, D8-07).

**Runtime integrity.** `extension/runtime.js:64-74`:

```js
if (manifest.schemaVersion !== 2 || manifest.workerVersion !== WORKER_VERSION) throw new Error("Unsupported worker bundle. Reinstall the VSIX.");
for (const [group, pattern] of [["files", WORKER_PATH], ["overlayFiles", OVERLAY_PATH]]) {
  for (const [relative, expected] of Object.entries(manifest[group] || {})) {
    if (!pattern.test(relative) || !/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Invalid ${group} inventory in the worker bundle.`);
    if (digest(await fs.readFile(source)) !== expected) throw new Error(`Bundled … integrity check failed. Reinstall the VSIX.`);
  }
}
```

`WORKER_PATH` (`extension/runtime.js:16`) is `pyproject.toml|uv.lock|.python-version|README.md|src/research_stack/[a-z_]+\.py` — **no digits, no hyphens, `.py` only**. Managed-copy integrity: `extension/runtime.js:101-107` (`validateWorker`) and `:307-314` (`wx` write, hash mismatch → "Managed worker files differ from this release").

---

## 4. VSIX packaging + audit

**Artifact name derivation.**

```js
// extension/scripts/package.js:82-83
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "vsix-manifest.json"), "utf8"));
const outputPath = path.resolve(projectRoot, "..", "dist", `research-stack-toolkit-${manifest.version}.vsix`);
```

So the filename comes from **`extension/vsix-manifest.json:5`**, not from `extension/package.json`. Staging is an explicit copy list (`extension/scripts/package.js:87-97`): 16 named files, then `media/`, `guides/`, `worker/` recursively, then `README.md`. `worker/` is copied whole (`:96`), so **any new file under `extension/worker/**` is packaged automatically** — but only if the audit expects it. Reproducibility normalisers: LF (`:38-56`), mode `0644` (`:67-76`), `SOURCE_DATE_EPOCH = "315532800"` (`:106`).

**`scripts/verify_vsix.py` checks, enumerated.**

| # | Check | Line |
|---|---|---|
| 1 | `EXPECTED` inventory (26 literal members) | `:16-44` |
| 2 | worker members derived from `src/research_stack/*.py` | `:69-72` |
| 3 | **overlay members derived from `bundle.json.overlayFiles`** | `:73-77` |
| 4 | component guides must be `guides/<id>.md` | `:78-82` |
| 5 | package ≤ 50 MiB | `:83`, `:138-140` |
| 6 | **unpacked payload ≤ 1 MiB** | `:84`, `:157-159` |
| 7 | sensitive paths (`.venv`, `node_modules`, `corpus`, `models`, `secrets`, `.git`, `.env`) | `:85`, `:148-149` |
| 8 | unsafe archive path / symlink member / duplicate member | `:146-155` |
| 9 | exact inventory equality `set(names) != EXPECTED` | `:160-162` |
| 10 | manifest name + version match `vsix-manifest.json`; no runtime deps; no dev-only fields | `:163-169` |
| 11 | packaged `extension/package.json` == repository `extension/package.json` minus `scripts`/`devDependencies`/`private` | `:170-189` |
| 12 | JS forbidden network/process primitives | `:92-97`, `:252-253` |
| 13 | `runner.js` boundary: exactly 1 `childProcess.spawn(` + 1 `execFile(`, no `shell: true`, no `execSync/spawnSync/forkSync/.exec(/.fork(`, 12 required bound literals | `:194-251` |
| 14 | Python forbidden primitives (`subprocess`, `eval(`, `exec(`, `__import__(`, `os.system/popen/exec*`, `pty`, `multiprocessing`) with one reviewed allowlist entry | `:107-122`, `:254-278` |
| 15 | packaged **JavaScript** network capability → hard fail | `:280-284` |
| 16 | packaged **Python** outbound network → *reported only* | `:285-294`, `:408-419` |
| 17 | every packaged member byte-matches its source (LF-normalised) | `:295-312` |
| 18 | no CRLF in text members | `:313-318` |
| 19 | every ZIP entry stamped `1980-01-01` | `:319-329` |
| 20 | every copied member mode `0644` | `:330-342` |
| 21 | bundle schema/inventory + version agreement with `runtime.js` | `:343-359` |
| 22 | bundle sha256 per member **and** drift vs repository source | `:360-369` |
| 23 | packaged `pyproject.toml`/`uv.lock` pairs are lock-current | `:370-381` |
| 24 | packaged docs must not name another release (`worker-<ver>`, `research-stack-toolkit-<ver>`) | `:382-397` |

**What must change for new bundle files.**
* `EXPECTED` self-extends from `bundle.json` (`:73-77`) — so overlay additions need **no** `EXPECTED` edit, but they must pass `OVERLAY_PATTERN` (`scripts/build_worker_bundle.py:31-34`) and `OVERLAY_PATH` (`extension/runtime.js:17`).
* **The 1 MiB unpacked ceiling is nearly exhausted.** Measured on `dist/research-stack-toolkit-0.3.8.vsix`: 87 members, **1 035 352 unpacked bytes of 1 048 576 — 13 224 bytes of headroom**. `templates/skill-bundles/theology/theological-research/` is 49 719 bytes across 11 files. Adding it naively fails check 6 *after* packaging. Either raise `MAX_UNPACKED_BYTES` (`scripts/verify_vsix.py:84`) with a recorded reason, or ship the bundle outside `worker/overlay/`.
* A new top-level shipped file (e.g. `extension/skill-bundles.json`) must be added to **four** lists: `extension/scripts/package.js:87-92, media/guides/worker at :94-96, README at :97`, `extension/package.json:292-314`, `extension/vsix-manifest.json:292-314`, `scripts/verify_vsix.py:16-44`.
* A new shipped `.js` module must be added to `extension/test/module-boundaries.test.js:53` (see §7).

---

## 5. Extension ↔ Python worker / MCP servers

**Interpreter.** The managed worker's own venv python: `extension/runtime.js:125` (`.venv/bin/python` / `.venv/Scripts/python.exe`).

**Flags — one constant, every call site.**

```js
// extension/runner.js:63
const PYTHON_FLAGS = ["-I", "-B", "-X", "utf8"];
```

Used at `extension/steps.js:279` (lab-store), `extension/runtime.js:221` (functional check), `extension/diagnostics.js` (probe), `extension/extension.js:574` (MCP server definitions), `extension/functional_check.py:43` (child MCP servers). Fixtures read the flags rather than hard-coding indices: `extension/test/python-argv.js:15-38`.

**argv shapes.**
```js
// extension/steps.js:279-281  — a CLI verb against the workspace
asRunProcess(services)(runtime.python, [...PYTHON_FLAGS, "-m", "research_stack.cli", "init-lab", "--workspace", root],
  { timeout: stepTimeout(step, settings), cwd: root, signal: services.signal })

// extension/runtime.js:221-227 — a script with a validated document
args.push("--workspace", root, "--document", path.relative(root, resolved));
```

**MCP servers are started by VS Code, not by `runner.js`** — `extension/extension.js:573-576`:
```js
new vscode.McpStdioServerDefinition(`Research Toolkit ${folder.name}: ${server.label}`, runtime.python,
  [...PYTHON_FLAGS, "-m", server.module],
  { RESEARCH_STACK_WORKSPACE: folder.uri.fsPath, RESEARCH_STACK_TOOL_PRESET: preset.id }, signature);
```

**Env scrubbing is asymmetric.** The `UV_*`/`PYTHONPATH` scrub applies **only when `options.kind === "setup"`**: `extension/runner.js:539` (policy), `:559` (`env: options.kind === "setup" ? setupEnvironment(...) : options.env`). `setupEnvironment` is `:449-471`, `REVIEWED_UV_ENVIRONMENT` `:401-407`, `CONFLICTING_UV_VARIABLES` `:408-412`, `CONFLICTING_PYTHON_VARIABLES` `:418`, case-insensitive matching `:424-427`. Python calls pass no `env`, so they inherit the editor environment and rely on `-I` isolation (`extension/runner.js:55-62`).

**Timeouts / bounds.** `DEFAULT_TIMEOUT_MS = 8000` (`runner.js:43`), `MAX_BUFFER_BYTES = 8 MiB` (`:44`), `REPORT_LIMIT = 64 KiB` (`:45`), `MAX_ATTEMPTS = 2` / `RETRY_DELAY_MS = 2000` (`:47-48`), per-step bound from the registry (`extension/steps.js:25-30`, registry values `extension/components.json` `timeoutSeconds` 900/60/900/120), functional-check bound `Math.max(90000, setupTimeoutMs)` (`extension/runtime.js:231`). Process-tree reaping: `runner.js:49-51`, `:19-34`.

**How a new ingestion command would be invoked.** Copy `runLabStoreStep` (`extension/steps.js:275-291`) exactly: resolve `managedRuntime`, then `asRunProcess(services)(runtime.python, [...PYTHON_FLAGS, "-m", "research_stack.cli", "<new-verb>", "--workspace", root, …], { timeout: stepTimeout(step, settings), cwd: root, signal: services.signal })`, parse stdout as JSON, and refuse a payload containing `U+FFFD` (`extension/steps.js:285-286`) before trusting any path in it.

---

## 6. Document reading today, and file selection

**Tool exposure.** `read_document` is an MCP tool on the Basic server: `src/research_stack/mcp_server.py:61` (with `search_local_text` `:44`, `read_text_source` `:67`, `write_markdown`/`write_docx` `:91-98`; registered `:101,:105`). Extraction itself: `src/research_stack/documents.py:100-156` (`DOCUMENT_SUFFIXES = {".pdf", ".docx"}` `:33`, `MAX_INPUT_BYTES = 50 MiB` `:28`, `MAX_PDF_PAGES = 500` `:29`).

**A file picker already exists** — one, single-select, PDF/DOCX-filtered:

```js
// extension/extension.js:540-542  (command researchToolkit.readSelectedDocument, registered :536)
const selected = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFolders: false, defaultUri: folder.uri,
  title: "Choose a workspace document for a read-only MCP check", filters: { "PDF or Word document": ["pdf", "docx"] } });
```

Panel button `extension/ui.js:37` (`data-action="readDocument"`) → generic client wiring `extension/media/controls.js:469-472` → `extension/extension.js:766` (`readDocument: "researchToolkit.readSelectedDocument"`) → `functionalCheck(context, runtime, folder, selected[0].fsPath)` → `extension/runtime.js:220-238`, which re-validates containment and size (`:224-226`) and converts to a **relative** path (`:227`). `vscode.workspace.findFiles` is used nowhere in the shipped extension.

**Indexing does not accept PDF/DOCX today.** `records.index_corpus` (`src/research_stack/records.py:430-443`) → `full.scan_sources` →

```python
# src/research_stack/full.py:135-136
if source_path.suffix.lower() not in {".md", ".markdown", ".txt"}:
    raise FullPrototypeError("UNSUPPORTED_FORMAT: prototype accepts UTF-8 Markdown and text only.")
```

So capability (a) is a **new ingestion path**, not a flag change. Note the two different size regimes: `full.py:16-17` (`MAX_SOURCE_BYTES = 5 MiB`, `MAX_TOTAL_BYTES = 50 MiB`) vs `documents.py:28` (`MAX_INPUT_BYTES = 50 MiB`) and `runtime.js:226` (50 MiB gate).

---

## 7. JS test harness conventions

* **Stubbed editor.** `extension/test/harness.js:7` `makeHarness({pickedId, cancel, failUpdate, initial, folders, trusted, diagnosticServices, confirmSetup, confirmPrompt, documentPath})` builds a whole `vscode` object (`:32` onward): `Emitter` `:19-23`, `TreeItem`/`ThemeIcon` `:42-43`, `McpStdioServerDefinition` + `lm.registerMcpServerDefinitionProvider` `:44-45`, `Uri.file/parse/joinPath` `:47`, `workspace.workspaceFolders` `:63`, `getConfiguration("researchStack")` `:67` (asserts the section name), webview panels, `api.state()`, `panel.receive(message)`.
* **Injected services, not real processes.** Tests pass `diagnosticServices` / `services` with `runProcess`, `resolveHostTool`, `uv` substituted — e.g. `extension/test/steps.test.js:32-43`.
* **Temp workspaces.** `fs.mkdtemp(path.join(os.tmpdir(), "research-…-"))`: `test/installer.test.js:23`, `:335`, `:395`; `test/runtime.test.js:16`; `test/preflight.test.js:13`; `test/runner.test.js:145,169,338,458,558,605,680`; `test/hosttools.test.js:14,471`; `test/gui-status.test.js:22`; `test/browser.test.js:18`; `test/diagnostics.test.js:14`.
* **Enumeration is explicit.** `extension/package.json:316` lists **16** test files by name; `:317` `test:host` runs the real editor via `extension/test/run-host-test.js:7-30` → `test/host.test.js`. A 17th file passes by hand and never runs in CI — recorded as `.agent/LESSONS.md:42`.
* **The shipped-module guard.** `extension/test/module-boundaries.test.js:53-56`:

```js
const shipped = fs.readdirSync(ROOT).filter((f) => f.endsWith(".js")).sort();
assert.deepEqual(shipped, REVIEWED, "the shipped module set differs from the reviewed set");
assert.deepEqual(shipped.filter((f) => !REVIEWED.includes(f)), [], "a new shipped module requires review here and in scripts/verify_vsix.py");
```
plus `:57-61` (every shipped module must appear in `verify_vsix.py`'s `EXPECTED`), `:63-71` (every registry component must have a packaged guide), `:116-119` (only `runner.js` may require `node:child_process`), `:121-128` (verdict wording lives in `status.js`).

---

## 8. Version / release mechanics

Six declarations, two of them derived:

| Source | Line | Written by |
|---|---|---|
| `pyproject.toml` `[project].version` | `pyproject.toml` | hand |
| `src/research_stack/__init__.py` `__version__` | `src/research_stack/__init__.py` | hand |
| `extension/package.json` `version` | `extension/package.json:5` | hand |
| `extension/vsix-manifest.json` `version` | `extension/vsix-manifest.json:5` | hand (drives the artifact name) |
| `extension/runtime.js` `WORKER_VERSION` | `extension/runtime.js:9` | hand (drives `WORKER_FOLDER` `:11`) |
| `extension/worker/pyproject.toml` `version` | `extension/worker/pyproject.toml:3` | derived (`build_worker_bundle.py:62-71`) |
| `extension/worker/bundle.json` `workerVersion`/`extensionVersion` | `extension/worker/bundle.json` | derived (`build_worker_bundle.py:84-99`) |

**Enforcing tests/checks:** `tests/test_release_identity.py:68-76` (`declared_versions`), `:79-83` (exactly one version), `:86-89` (each source equals pyproject), `:92-99` (`WORKER_FOLDER` template), `:102-110` (bundle records the extension version), `:113-128` (`WORKER_FOLDER_PATTERN` accepts this release and rejects `worker-0.3.6.1`), `:131-137` (three-part version vsce can package). Plus `scripts/verify_vsix.py:350-359`, `scripts/build_worker_bundle.py:96-98`, `tests/test_lock_consistency.py:78`.

**Docs are part of the release identity.** `scripts/verify_vsix.py:386-397` refuses any packaged guide, `extension/readme.md` or `extension/worker/README.md` naming a release other than the built one. Operator-facing text that is *not* packaged but must still be bumped: `README.md:38,40,47,53`, `extension/README.md:1,7,31,44,135,143`, `extension/CHANGELOG.md`, `extension/worker/README.md`.

**Bump order that cannot be skipped:** edit the four hand sources → `npm run package` (`extension/package.json:318`) runs `build_guide_index.py` → `build_worker_bundle.py` → `package.js` → `npm run verify-package` (`:319`) → `npm run check:payload` (`:320`).

---

## 9. Concrete insertion points for 0.3.9

### (a) PDF/DOCX indexing commands in the panel

| Change | File:line |
|---|---|
| New CLI verb (`index-documents` or similar) | `src/research_stack/cli.py:44-59` (`add_parser` block) + dispatch `:61-74` |
| New ingestion module — **name must match `[a-z_]+\.py`** | pattern `extension/runtime.js:16`; auto-globbed by `scripts/build_worker_bundle.py:63` and `scripts/verify_vsix.py:70` |
| Extract-then-chunk bridge (documents → `SourceRecord` → chunks) | `src/research_stack/documents.py:100-156` → `src/research_stack/full.py:102-147` (`scan_sources` suffix gate `:135`) → `src/research_stack/records.py:430-490` |
| Keep containment | `src/research_stack/paths.py:35-47` (`assert_relative` refuses absolute, `.` and `..`), `:82-92` (`resolve_under`) |
| New component step (`id`, `timeoutSeconds`, `prerequisites: ["worker"]`, `components`) | `extension/components.json` `installSteps` + `packages` → consumed `extension/installer.js:24,29-33` |
| New step runner + `STEP_RUNNERS` entry | `extension/steps.js:275-298` (copy `runLabStoreStep`) |
| Artifact verification branch | `extension/installer.js:190-205` |
| Panel button + action route + command | `extension/ui.js:37`, `extension/extension.js:762-769`, new `register(...)` near `:536`, `extension/package.json:106` + `extension/vsix-manifest.json:106` |
| Multi-select picker + absolute→relative conversion | precedent `extension/extension.js:540-542` (set `canSelectMany: true`) and `extension/runtime.js:224-227` (realpath, `under()`, `path.relative`) |
| Packaging/audit delta | none for `EXPECTED` (worker `.py` members are auto-derived, `scripts/verify_vsix.py:69-72`); **one new guide required** per new component id (`scripts/verify_vsix.py:78-82`); new test file must be added to `extension/package.json:316` |

### (b) Skill-bundle catalog + install flow

| Change | File:line |
|---|---|
| Bundle payload must be buildable | `scripts/build_worker_bundle.py:18-34` — `OVERLAY_FILES` + `OVERLAY_PATTERN` currently accept only `.github/skills/<id>/SKILL.md`; `references/`, `scripts/`, `evals/`, `README.md` are rejected at `:74-75` |
| Runtime pattern must match the build pattern | `extension/runtime.js:17` (second copy of the same regex) |
| Catalog file (ids, versions, file lists, target path) | new `extension/skill-bundles.json` → must be added to `extension/scripts/package.js:87-92, media/guides/worker at :94-96, README at :97`, `extension/package.json:292-314`, `extension/vsix-manifest.json:292-314`, `scripts/verify_vsix.py:16-44` |
| New shipped JS module (if the flow is factored out) | add to `extension/test/module-boundaries.test.js:53` **and** `scripts/verify_vsix.py:16-44` |
| Install routine | reuse `extension/steps.js:82-105` with a bundle-scoped manifest, or a new `installSkillBundle()`; keep `flag:"wx"`, keep the link refusal (`:98`), keep `directory()` (`extension/runtime.js:53-62`) |
| Receipt that proves what was installed | `extension/installer.js:109-131` writes only `installation.json` inside the worker dir; a bundle receipt needs bundle id + version + per-file sha256, because `verifyStepArtifacts` (`:198-203`) checks **existence only** |
| Step attribution | `extension/steps.js:78-80` `overlayStepFor` — a new bundle path defaults to `research-overlay` |
| Packaging/audit delta | `MAX_UNPACKED_BYTES` (`scripts/verify_vsix.py:84`) — 13 224 bytes of headroom today; `EXPECTED` auto-extends from `bundle.json` (`:73-77`); bundled `.py` skill scripts are scanned for forbidden primitives (`:254-269`) but outbound network is only reported (`:285-294`) |

---

## 10. Risks

1. **A reviewed template is already being silently skipped.** `templates/recommended-overlay/.github/skills/document-corpus-bridge/SKILL.md` exists but is absent from `scripts/build_worker_bundle.py:18-30`. Nothing compares the template tree against the allowlist, so a template can exist, be reviewed, and never ship. `components.json` still advertises "five research skills" (`extension/components.json` `installSteps[1].description`).
2. **Two copies of the same allowlist regex.** `scripts/build_worker_bundle.py:31-34` vs `extension/runtime.js:17`. Editing one silently drops files at the other layer — build-time (`:74-75`) or a hard runtime refusal of the whole bundle (`extension/runtime.js:68-70`).
3. **`overlayStepFor` default-attributes everything to `research-overlay`** (`extension/steps.js:78-80`), and `writeOverlayFiles` skips anything whose step does not match (`:88`). A new bundle path is either installed by "Set up package components" with no separate confirmation, or skipped by both steps with no message.
4. **Existence-only verification for overlay files.** `extension/installer.js:198-203` checks that each overlay path exists; it does not hash it. A hand-replaced `SKILL.md` still reports `installed`. Contrast `validateWorker` (`extension/runtime.js:101-107`), which hashes every worker file.
5. **`wx` + "preserved" wording can read as success.** `extension/steps.js:94-100` classifies a conflicting file as `current` or `modifiedPreserved`; `extension/steps.js:107-115` counts both as preserved. A bundle that installed **zero** files because every path collided reports "0 created, 11 unchanged preserved" — indistinguishable from a clean install in the receipt.
6. **1 MiB unpacked ceiling is 98.7 % consumed.** `scripts/verify_vsix.py:84` with 1 035 352 / 1 048 576 measured on 0.3.8. The theological bundle is 49 719 bytes. The failure appears only at audit time, after packaging.
7. **Outbound-network Python ships without failing the audit.** `scripts/verify_vsix.py:252-253` applies the network ban to `.js` only; `:285-294` merely *lists* outbound Python. `templates/skill-bundles/theology/theological-research/scripts/crossref_lookup.py:21-23,48-49` uses `urllib.request`/`urlopen`. Bundled, it would land in the user's workspace under an audit summary that opens "Measured over every packaged member. Packaged JavaScript: no member matched fetch…" (`:409-411`).
8. **Receipt claims wider than the evidence.** `extension/steps.js:127` records "verified through real local MCP reading, reports, search and RIS preparation" from `functionalCheck`, whose default run is `scope: "Temporary synthetic fixtures through real local stdio MCP"` (`extension/runtime.js:237`, fixtures built in `extension/functional_check.py:121-191`) — never the user's documents. `extension/steps.js:290` records table counts taken from the child's own JSON.
9. **Bundle state is invisible to the plan unless it is a step.** `installer.js:29-33` builds the plan from `packages[<id>].steps`; `outdatedSteps` (`:675`) and `failedSteps` (`:680`) only know step ids. A bundle installed outside the step model is never shown as outdated, never offered for repair, and never retried.
10. **Receipt location.** `installation.json` lives inside the versioned worker folder (`extension/installer.js:26` + `extension/runtime.js:11`). A bundle installed for a workspace whose package has no overlay step (Basic: `packages.basic.steps = ["worker"]`) has no natural place to be recorded, and a workspace with no worker has no receipt at all.
11. **Absolute paths from the picker vs the worker's relative-path policy.** `showOpenDialog` returns absolute paths (`extension/extension.js:540`); `src/research_stack/paths.py:35-47` refuses absolute paths, drive letters, `.` and `..`. A naive pass-through fails with `PATH_OUTSIDE_WORKSPACE`. On the measured NTFS/9p host (`.agent/QUALITY_STATE.md`, case-insensitivity section) two spellings of one file can index twice or collide.
12. **Two different size limits for the same document.** `src/research_stack/documents.py:28` (50 MiB) and `extension/runtime.js:226` (50 MiB) allow a PDF that `src/research_stack/full.py:16` (5 MiB per source) would refuse at index time.
13. **No test-inventory guard.** `extension/package.json:316` enumerates 16 files by hand; `extension/test/module-boundaries.test.js` guards shipped modules but not test files (`.agent/LESSONS.md:42`). A new `test/skillbundles.test.js` would pass locally and never run.
14. **Adding a shipped module is a four-list change.** `extension/scripts/package.js:87-92, media/guides/worker at :94-96, README at :97`, `extension/package.json:292-314`, `extension/vsix-manifest.json:292-314`, `scripts/verify_vsix.py:16-44`, `extension/test/module-boundaries.test.js:53` — miss one and either the payload or the suite fails, in different places, at different times.

---

## Highest-value next actions

1. Decide the bundle payload location **before** writing code: `worker/overlay/` (auto-expected, but 13 224 bytes of headroom and two regex allowlists to widen) vs a new top-level `extension/skill-bundles/` (four lists to update, one `EXPECTED` entry per file).
2. Make `scripts/build_worker_bundle.py` fail when `templates/recommended-overlay/**` contains a file the allowlist does not name — closes risk 1 permanently and would have caught `document-corpus-bridge`.
3. Hash-verify overlay artifacts in `verifyStepArtifacts` (`extension/installer.js:198-203`), not just existence, before a bundle receipt claims per-file integrity.
4. Add the missing test-inventory guard (risk 13) before a 0.3.9 test file is written.

---

## 11. Cross-reference: `specs/phase-9-document-ingestion/` already fixes two of these choices

The repository already contains `specs/phase-9-document-ingestion/spec.md` and `design.md` (untracked at this read). Two decisions there change the packaging arithmetic in §9(b):

* **`design.md:133-138` puts the payload at `extension/bundles/`** (`catalog.json` + a `bundle.json` per bundle, sha256 per file) and the receipt at **`.research-toolkit/bundles/<bundle-id>.json`** — outside the worker folder. That resolves risk 10, but it means `scripts/verify_vsix.py:73-77` (which auto-extends `EXPECTED` only from `bundle.json.overlayFiles`) **will not** expect these members: every `extension/bundles/**` file must be added to `EXPECTED` (`scripts/verify_vsix.py:16-44`) or the exact-inventory gate at `:160-161` fails. It also needs a copy line in `extension/scripts/package.js:87-97` and an entry in both `files` arrays (`extension/package.json:292-314`, `extension/vsix-manifest.json:292-314`).
* **The 1 MiB unpacked ceiling (§4, risk 6) is unaffected by that choice** — it is a whole-archive limit (`scripts/verify_vsix.py:84`, `:158`), and 0.3.8 already consumes 1 035 352 of 1 048 576 bytes. `extension/bundles/` is not exempt.
* **`spec.md:104` (R9-17)** — "A completed 0.3.8 overlay receipt is never treated as evidence that a bundle is installed … Only the first [of three statuses] may be claimed by an automated install" — is the direct answer to risks 4, 5 and 8. Implementing it means `verifyStepArtifacts` (`extension/installer.js:198-203`) must not be the bundle's verification path at all.
* **`spec.md:108` (R9-19)** — "source → worker payload → VSIX member, with the digests compared" — already exists for the worker tree (`scripts/verify_vsix.py:360-369`); it does **not** exist for `extension/bundles/`, because that check iterates `bundle['files']` + `bundle['overlayFiles']` only.
* **`spec.md:110` (R9-20)** requires the bundle scripts' network assumptions to be disclosed. Today the audit only *lists* outbound Python (`scripts/verify_vsix.py:285-294`) — disclosure exists in the audit JSON, but nothing fails if it appears (risk 7).
