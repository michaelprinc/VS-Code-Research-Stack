# Implementation report — 0.3.10 (Phase 10): the update channel, problem reports, and how to publish this Toolkit

Date: 7 November 2026 (Europe/Prague). Release tag: `v0.3.10`. Artifact: `dist/research-stack-toolkit-0.3.10.vsix`.
Specs: [spec](../../../specs/phase-10-marketplace-release/spec.md) · [design](../../../specs/phase-10-marketplace-release/design.md) · [acceptance](../../../specs/phase-10-marketplace-release/acceptance.md) · [tasks](../../../specs/phase-10-marketplace-release/tasks.md).
Evidence: [evidence/quality-v0.3.10-2026-11-07/](../../../evidence/quality-v0.3.10-2026-11-07/) — including
[marketplace-publish-research.md](../../../evidence/quality-v0.3.10-2026-11-07/marketplace-publish-research.md), the
source-checked publication research this report is built on.

Everything measured here was measured in the development container (WSL2, Debian 13, Node 24, CPython 3.12.16, pinned
uv 0.13.6). **Nothing was published, no publisher was created, and no credential was requested.** Sections 2 and 3
state publication requirements with the command or the source that establishes each one; section 4 is the runbook a
maintainer follows.

---

## 1. What 0.3.10 shipped

| Piece | File | What it does |
|---|---|---|
| Update channel | `extension/updates.js` (new, 230 lines) | One bounded HTTPS GET to `marketplace.visualstudio.com`, version compare, engine compare, a verdict. |
| Problem reports | `extension/reports.js` (new, ~330 lines) | Compose → redact → bound → file + clipboard → `mailto:` draft to `princ.michael@gmail.com`. No network capability at all. |
| Host wiring | `extension/extension.js` | Identity block from `package.json`; `register()` records every command failure into a bounded in-memory ring; three new commands; a scheduled check when the panel reports ready. |
| Control panel | `extension/ui.js`, `extension/media/controls.js` | "Updates & problem reports" section: verdict line `#update-state`, buttons `checkUpdates`, `updateNow`, `report`. |
| Manifest | `extension/package.json`, `extension/vsix-manifest.json` | 33 commands, `researchStack.checkForUpdates`, `icon`, `bugs.email`, `homepage`, `keywords`. |
| Icon | `extension/media/toolkit.png` | 256 × 256 RGBA PNG, 6 875 bytes, authored by `extension/scripts/make_icon.js`. |
| Gates | `scripts/verify_vsix.py`, `extension/test/module-boundaries.test.js`, `extension/scripts/check-installed-payload.js` | The reviewed-network exception, the icon and manifest assertions, the installed-payload behaviour assertions. |

Suites at the tag: **390 Node tests (390 pass, 0 fail)**, **258 Python tests**, VSIX audit `passed`, installed-payload
check `passed`.

---

## 2. Publication requirements, verified

Two kinds of fact are kept apart. **Measured here** means a command ran in this container and its output is in the
evidence folder. **Documented** means it comes from a Microsoft page or the vsce source, cited with a link; the full
quote list is in [marketplace-publish-research.md](../../../evidence/quality-v0.3.10-2026-11-07/marketplace-publish-research.md).

### 2.1 The blocking facts

| # | Requirement | State for this repository | Evidence |
|---|---|---|---|
| P-01 | A publisher must exist, and its ID is what the manifest's `publisher` must match. | **Absent.** `michaelprinc` does not exist. | `POST /_apis/public/gallery/extensionquery` → `TotalCount: 0`; `GET /publishers/michaelprinc` → 404; `GET /vscode/michaelprinc.research-stack-toolkit/latest` → 404. [marketplace-probe.json](../../../evidence/quality-v0.3.10-2026-11-07/marketplace-probe.json) |
| P-02 | `vsce create-publisher` no longer exists; the publisher is created in the Marketplace management UI. | Action for the maintainer. | vsce 4.1.0 prints: *"The 'create-publisher' command is no longer available. You can create a publisher directly in the Marketplace: https://aka.ms/vscode-create-publisher"*. `vsce --help` lists no such command: [vsce-commands-help.txt](../../../evidence/quality-v0.3.10-2026-11-07/vsce-commands-help.txt) |
| P-03 | Publisher ID and extension name are permanent. | Choose `michaelprinc` deliberately. | [publishing-extension](https://code.visualstudio.com/api/working-with-extensions/publishing-extension): *"ID cannot be changed once created."* Removal: *"Once an extension is removed, its extension name is permanently reserved and cannot be reused, even by the original publisher."* |
| P-04 | Trusted publishing needs `@vscode/vsce` **≥ 4.1.0**. | The repository pins **4.0.0**, whose `publish --help` has no `--oidc`. | Diff of the two help outputs: [vsce-publish-help.txt](../../../evidence/quality-v0.3.10-2026-11-07/vsce-publish-help.txt) vs [vsce-4.1.0-publish-help.txt](../../../evidence/quality-v0.3.10-2026-11-07/vsce-4.1.0-publish-help.txt). OIDC landed in 4.0.0 but was hidden from help and its token exchange was corrected in 4.1.0 (`vsce` #1291, #1297, #1337, #1348). |
| P-05 | The repository declares no licence. | `license: "UNLICENSED"`, no `LICENSE` file. | `extension/package.json`; vsce warns *"LICENSE, LICENSE.md, or LICENSE.txt not found"* and offers `--skip-license`. |
| P-06 | The two skill bundles are not publishable as they stand. | `publishable: false`, one unresolved licence. | `scripts/build_bundle_catalog.py --check` → *"2 bundle(s), 12 files, 67797 bytes, 1 unresolved license(s), publishable=False"*. [bundle-catalog-check.txt](../../../evidence/quality-v0.3.10-2026-11-07/bundle-catalog-check.txt) |

### 2.2 Manifest rules, checked against this manifest

| Rule | Source of the rule | This manifest |
|---|---|---|
| `version` must be `major.minor.patch`; a 4-part version is a hard error | vsce validates with `semver.valid`; tested rejection: *"Invalid extension "version": "1.0.0.0""* | `0.3.10` — valid |
| A prerelease tag packages fine but **publish** refuses it | *"The VS Marketplace doesn't support prerelease versions: '1.0.0-beta.1'."* | `0.3.10` has no tag — valid. `updates.js` refuses `0.3.10-beta` at parse time (DD10-07) |
| `publisher` and `name` must match `/^[a-z0-9][a-z0-9\-]*$/i` | vsce `out/validation.js` | `michaelprinc` / `research-stack-toolkit` — valid |
| `engines.vscode` required; `@types/vscode` must not exceed it | manifest reference | `^1.140.0`, no `@types/vscode` (plain JavaScript extension) — valid; latest stable editor is 1.145.x |
| `icon` must be a **PNG**, at least 128 × 128 (256 × 256 for Retina); an SVG is refused | *"SVGs can't be used as icons"* | `media/toolkit.png`, 256 × 256 RGBA, 6 875 bytes. `verify_vsix.py` and `check-installed-payload.js` assert the field and the file. Note: `contributes.views…icon: "media/toolkit.svg"` is a **view** icon and is unaffected — only the gallery icon has the PNG rule |
| `repository` missing → warning + prompt | vsce | Present (`github.com/michaelprinc/VS-Code-Research-Stack`) — relative links in the packaged README are rewritten automatically |
| `license` should read `SEE LICENSE IN <file>` when a licence file exists | vsce regex `/^SEE LICENSE IN (.*)$/` | `UNLICENSED` — see P-05. With no licence file the Marketplace item page renders **no License row at all** (`"LicenseText": ""`) |
| `keywords` ≤ 30, enforced **server-side**, and vsce adds extra tags from `contributes` | *"You exceeded the number of allowed tags of 30"* | 9 keywords added in 0.3.10 — headroom kept |
| `categories` from the fixed list | manifest reference | `["Other", "Education"]` — valid values |
| `pricing` only `Free` or `Trial` | tested rejection: *"Pricing can only be "Free" or "Trial""* | Absent → Free |
| `.vscodeignore` **and** `files` together is a hard error | tested: *"VSCE does not support combining both strategies"* | No `.vscodeignore`; a 25-entry `files` allowlist — valid |
| An unused `files` pattern is a hard error | tested: *"…do not match any files packaged in the extension…"* | `vsce ls` lists 102 files with no warning — valid. (`media/toolkit.png` is covered by the `media` entry; naming it again would be the error) |
| `private: true` is ignored by vsce | tested | Present in `extension/package.json` as an npm guard; it is stripped from the packaged manifest by `extension/scripts/package.js` and `verify_vsix.py` fails if it leaks |
| Secrets and `.env` are blocked by secretlint | vsce | None present; the audit refuses sensitive paths independently |
| `bugs.email` is accepted and becomes a support link | vsce converts it to `mailto:` in the VSIX manifest (`Microsoft.VisualStudio.Services.Links.Support`) | `bugs.email: princ.michael@gmail.com` — this is the same address the report command uses |
| A `mailto:` link in the README is safe | historical failure fixed in 2020 (`vscode-vsce` #228 → PR #472) | The panel and README `mailto:` links are not rewritten into broken links |
| No runtime `dependencies` | vsce hard error for `dependencies.vscode` | None; `verify_vsix.py` refuses any runtime dependency |
| The gallery page reads its description from the **Details** asset and its release notes from a **Changelog** asset | vsce emits `Microsoft.VisualStudio.Services.Content.Details` (and `…Content.Changelog` when a changelog is packaged) | The artifact carries `extension/readme.md` (40 552 bytes, which opens with a "What 0.3.10 adds" section) but **no changelog asset**: `extension/CHANGELOG.md` is 72 875 bytes and the unpacked payload has 33 898 bytes of headroom under the reviewed 1 310 720 ceiling. Shipping it whole would raise a reviewed limit; shipping the current release's section alone would need a new generated member. Recorded as a pre-publish decision, not decided here. |
| `bugs.url` wins over `bugs.email` for the Support link | vsce uses `getBugsUrl()`; the email becomes `mailto:` only when no URL is present | Both are set, so the Marketplace Support button goes to GitHub issues. The address `princ.michael@gmail.com` still reaches users through the report command and the packaged README. |

### 2.3 Authentication, and the date conflict that matters

| Path | How it works | Notes for this repository |
|---|---|---|
| **Azure DevOps PAT** (`-p`, or `VSCE_PAT`) | Scope **Marketplace (Manage)**, Organization **All accessible organizations** | Docs still call this "not recommended". The FAQ names the usual failure: *"One easy mistake … is to select a specific organization instead of All accessible organizations."* |
| **Global PAT retirement** | **Conflicting sources.** VS Code docs (updated 2026-11-04): *"On December 1, 2026, global Personal Access Tokens (PATs) in Azure DevOps are retired."* The DevOps blog (updated 2026-10-23) strikes that through: ~~December 1, 2026~~ → **January 27, 2027**, *"Tokens will stop working after this date."* The Learn "Use PATs" page (2026-09-21) contains **both** dates. | Plan to **1 December 2026** as the working assumption; cite the postponement. Do not build the release process around a token that may stop working inside its own documentation window. |
| **Entra ID** (`--azure-credential`) | Chained token credential; the identity must be a **Contributor** on the publisher | Works with `verify-pat --azure-credential`. No `--oidc` on `verify-pat`. |
| **Trusted publishing** (`--oidc`, vsce ≥ 4.1.0) | GitHub OIDC token → `POST https://marketplace.visualstudio.com/_apis/gallery/token?api-version=7.2-preview.1`, header `Authorization: FederatedToken <JWT>`, body `{"publisherName": "michaelprinc"}` → a **15-minute, single-use** Marketplace credential | Needs a Trusted Publishing policy on the publisher page (policy name, repository owner, repository name, workflow file). *"It does not fall back to a PAT when token acquisition or exchange fails."* For a private repository: run the configured workflow **within 48 hours** of creating the policy — the first successful exchange activates it permanently. |
| `vsce login <publisher>` | Prompts for a PAT and stores it (keyring; `VSCE_STORE=file` falls back to plaintext) | Fine for a one-off manual publish on the maintainer's own machine. |
| `--githubPat` | **Does not exist** in any vsce version from 1.0.0 to 4.1.0 | Do not put it in a workflow. |

### 2.4 What happens after a publish

| Fact | Source | Consequence for this Toolkit |
|---|---|---|
| A version number cannot be re-uploaded, and a deleted number is burned | *"Once deleted, you can't reuse this version number for a new publish. Additionally, you cannot delete the latest version of an extension."* | A bad 0.3.10 publish means 0.3.11, not a re-upload. `--skip-duplicate` exists for CI re-runs. |
| Unpublish keeps the listing discoverable; **remove** is irreversible and burns the name | Azure DevOps docs; removal requires **zero installs** | Prefer publishing a fix over removing the extension. |
| Every package is virus-scanned before it appears | *"Until the scan is all clear, we don't publish the extension in the Marketplace for public usage."* | Expect a delay measured in minutes-to-hours, not seconds. **No official propagation SLA is documented.** |
| `extensions.autoUpdate` is on by default; `extensions.autoUpdateDelay` defaults to **12 hours** | extension-marketplace docs: *"The default value is 12 hours. Set the value to 0 to install updates as soon as they are published."* | A Marketplace-installed Toolkit updates itself within about half a day. |
| **A `.vsix` install has auto-update disabled** | *"When you install an extension via VSIX, auto update for that extension is disabled by default."* | This is the whole reason 0.3.10 exists: those users get the verdict in the panel instead of silence. |
| `workbench.extensions.installExtension` accepts a gallery id with a version | Handler regex `^([^.]+\..+)@((prerelease)|(\d+\.\d+\.\d+(-.*)?))$` | `researchToolkit.updateExtension` uses `michaelprinc.research-stack-toolkit@<version>` (DD10-06), which restores normal automatic updating. |
| Pre-release and regular versions must differ | *"if 1.2.3 is uploaded as a pre-release, the next regular release must be uploaded with a distinct version, such as 1.2.4"* | If 0.3.10 goes out as `--pre-release`, the next regular release must be 0.3.11. |

---

## 3. Decisions only the maintainer can make

| Decision | Options | What the tooling already assumes |
|---|---|---|
| Publisher ID | `michaelprinc` (already in the manifest, permanent once created) | `updates.js` builds its URL from `package.json`, so the ID must match exactly or the update check answers `not-published` forever |
| Licence | keep `UNLICENSED`, or add a `LICENSE` file and set `"license": "SEE LICENSE IN LICENSE"` | The Marketplace shows no License row without a licence file; publishing an unlicensed package is legal but leaves users without terms |
| Credential | Trusted publishing (`--oidc`, GitHub Actions) **or** a PAT with Marketplace (Manage) | Trusted publishing needs vsce ≥ 4.1.0; a PAT needs renewal before the retirement date, whichever date turns out to be the real one |
| Channel | regular release, or `--pre-release` | `--pre-release` requires `engines.vscode >= 1.63` (satisfied) and forces the next regular release to a different number |
| Skill bundles | publish the repository as-is (bundles ship inside the VSIX) or resolve the licences first | `document-corpus-bridge` is toolkit-authored but the repository is unlicensed; `theological-research` needs the author's consent. Both are `publishable: false` and the generator, the reader and the audit enforce that |

---

## 4. The runbook

### Step 0 — Decide, then re-audit

Decide the four items in §3. If the licence changes, re-run the gates before publishing:

```bash
cd extension
PATH=/tmp/uvs:$PATH npm test              # 390 tests
PATH=/tmp/uvs:$PATH npm run package       # builds dist/research-stack-toolkit-0.3.10.vsix
PATH=/tmp/uvs:$PATH npm run verify-package
PATH=/tmp/uvs:$PATH npm run check:payload
sha256sum dist/research-stack-toolkit-0.3.10.vsix
```

Publish the **audited artifact**, not a fresh packaging run: `vsce publish --packagePath` takes the file the gates
measured. Packaging again from the CLI would re-run the packager and could produce a byte-different artifact from the
one the receipts describe.

### Step 1 — Create the publisher (browser, one time)

1. Open <https://marketplace.visualstudio.com/manage> (or <https://aka.ms/vscode-create-publisher>) and sign in.
2. **Create publisher** → Name `Michael Princ` (display name; keep it within 16 characters if it uses non-ASCII
   characters), ID **`michaelprinc`**. The ID autofills from the name; the ID is immutable and must match
   `publisher` in `extension/package.json` exactly.
3. Accept the publisher agreement.
4. Confirm from the terminal that the publisher is known:

```bash
npx @vscode/vsce ls-publishers          # michaelprinc should appear
```

### Step 2 — Give the publisher a credential

**Option A — Trusted publishing (recommended, no secret to store).**

1. Publisher page → **Trusted Publishing** → **Create**: policy name `vs-code-research-stack-publish`,
   Repository owner `michaelprinc`, Repository `VS-Code-Research-Stack`, Workflow `publish-marketplace.yml`,
   Environment empty.
2. If the repository is private, run the workflow **within 48 hours** — the first successful exchange activates the
   policy permanently.
3. Bump the packager, because 4.0.0 does not expose `--oidc`:

```bash
cd extension && npm install --save-dev @vscode/vsce@^4.1.0
```

4. Add the workflow (`.github/workflows/publish-marketplace.yml`):

```yaml
name: Publish to the VS Code Marketplace
on:
  push:
    tags: ["v*"]
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write          # without this: "GitHub Actions did not provide an OIDC token request URL and token."
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - uses: actions/setup-node@v4
        with: { node-version: "22" }     # vsce 4.x requires Node >= 22
      - name: Install uv (the locks are written by uv 0.13.6)
        run: pip install uv==0.13.6
      - name: Install Node dependencies
        run: npm ci
        working-directory: extension
      - name: Build the audited payload (guide index + worker bundle + VSIX)
        run: npm run package
        working-directory: extension
      - name: Audit the artifact before publishing
        run: npm run verify-package && npm run check:payload
        working-directory: extension
      - name: Publish
        run: npx @vscode/vsce publish --packagePath ../dist/research-stack-toolkit-0.3.10.vsix --oidc --skip-license --no-dependencies
        working-directory: extension
```

**Option B — a PAT (works today, needs a date in the calendar).**

1. Azure DevOps → User settings → Personal access tokens → **New token**: scope **Custom → Marketplace → Manage**,
   Organization **All accessible organizations**.
2. Verify it before publishing:

```bash
VSCE_PAT=<token> npx @vscode/vsce verify-pat michaelprinc
```

3. Publish from the maintainer's machine (§Step 3). Never commit the token; `vsce login michaelprinc` stores it in the
   OS keyring instead of a file.

### Step 3 — Publish

From `extension/`, with the artifact already built and audited:

```bash
npx @vscode/vsce publish \
  --packagePath ../dist/research-stack-toolkit-0.3.10.vsix \
  --skip-license \
  --no-dependencies \
  --pat <token>            # or --oidc in CI, or --azure-credential
```

Flags that matter here, and why:

| Flag | Why this repository needs it |
|---|---|
| `--packagePath` | Publishes the file the gates measured. Do **not** pass a positional version — `vsce publish 0.3.11` runs `npm version`, rewrites `package.json`, and creates a commit and tag, which would break the seven-source identity process. |
| `--skip-license` | There is no `LICENSE` file. Without it vsce prompts `y/N`; in a non-interactive shell vsce auto-answers `y`, so a CI job would silently publish an unlicensed package. Saying it out loud is better. |
| `--no-dependencies` | The extension has no runtime dependencies; this keeps the packager from adding any. |
| `--allow-missing-repository` | **Not needed** — `repository` is present. Listed only so it is not added by mistake. |
| `--allow-unused-files-pattern` | **Not needed** — `vsce ls` reports no unused pattern. Listed for the same reason. |
| `--pre-release` | Only if the maintainer chooses the pre-release channel (§3). |
| `--skip-duplicate` | Useful in CI re-runs: *"Version 0.3.10 is already published. Skipping publish."* |

### Step 4 — Confirm that it is really there

```bash
npx @vscode/vsce show michaelprinc.research-stack-toolkit
npx @vscode/vsce search "research stack toolkit"
```

and the same probe that proved it was absent before ([marketplace-probe.json](../../../evidence/quality-v0.3.10-2026-11-07/marketplace-probe.json)):
`extensionquery` should return `TotalCount: 1`, and
`GET https://marketplace.visualstudio.com/vscode/michaelprinc.research-stack-toolkit/latest` should return JSON with
`versions[0].version = "0.3.10"` and the `Microsoft.VisualStudio.Code.Engine` property.

Until that JSON exists, the Toolkit's own panel says **"No published version of this Toolkit was found"** — which is
the correct answer, not a defect.

### Step 5 — What changes for users after the publish

| Install route | Before 0.3.10 | After 0.3.10, once published |
|---|---|---|
| Installed from a `.vsix` file | Silent forever; auto-update is disabled by VS Code | Panel shows *an update is available*; **Update from the Marketplace** installs the signed gallery build, which returns the extension to normal automatic updating |
| Installed from the Marketplace | Automatic within ~12 h | Unchanged |
| `researchStack.checkForUpdates` off | — | No request at all; the panel says the check is switched off |

### Step 6 — Failure playbook

| Symptom | Meaning | Action |
|---|---|---|
| `ERROR The 'create-publisher' command is no longer available` | Expected: the command was removed | Create the publisher in the browser (§Step 1) |
| `403` / `401` from publish | Wrong scope, or a specific organization instead of **All accessible organizations** | Re-create the token with Marketplace **Manage** + all organizations; `vsce verify-pat michaelprinc` first |
| `michaelprinc.research-stack-toolkit v0.3.10 already exists` | Version numbers are immutable | Publish 0.3.11, or use `--skip-duplicate` in CI |
| `Invalid extension "version": "0.3.10.0"` | Four-part versions are refused | Keep `major.minor.patch`; the identity test enforces it |
| `The VS Marketplace doesn't support prerelease versions` | A `-beta` tag reached the manifest | Remove it; `updates.js` refuses such strings too |
| `SVGs can't be used as icons` | The gallery `icon` points at an SVG | Point `icon` at the PNG (the view icon may stay SVG) |
| `VSCE does not support combining both strategies` | `.vscodeignore` and `files` both present | Keep the `files` allowlist only |
| `…do not match any files packaged in the extension` | An unused `files` pattern | Remove the pattern, or pass `--allow-unused-files-pattern` deliberately |
| `You exceeded the number of allowed tags of 30` | Server-side keyword limit, and vsce adds tags from `contributes` | Trim `keywords` |
| `GitHub Actions did not provide an OIDC token request URL and token` | Missing `permissions: id-token: write` | Add it to the job |
| Publish succeeds, extension not visible yet | Virus scan and gallery propagation, no documented SLA | Wait; check the publisher portal for validation messages |
| Panel keeps saying `not-published` after a successful publish | The manifest `publisher`/`name` do not match the created publisher | Fix the manifest; the URL is built from those two fields |

---

## 5. Defects this release found and fixed

1. **`EXTENSION_NAME` was referenced and never defined** in `extension/extension.js` — a latent `ReferenceError` in a
   shipped file, invisible to every suite that had run before. Fixed by the identity block.
2. **The capability gate is a byte scan, so prose trips it.** `verify_vsix.py` reported a new network capability in
   `extension.js` because a comment contained the word "socket". The gate was kept strict; the comment was reworded and
   the exception is now an explicit, named, two-directional rule.
3. **A generated packaged document was stale.** `extension/worker/README.md` is produced from the repository-root
   `README.md`; the fix belongs in the root file.
4. **Four redaction defects** in `reports.js`: a URL scheme eaten as a Windows path; a token pattern eating the
   Marketplace API path; `\\wsl$` and UNC paths not matched; and the byte cap exceeded because the footer and the note
   were outside the budget. Each is now a test.
5. **A verdict could be overwritten by a concurrent check.** `runUpdateCheck` returned the shared `updateCheck`
   variable after an `await`, so a panel-scheduled check finishing during that await replaced the value a command had
   returned — the payload audit saw `not-published` where the setting said `disabled`. Each branch now builds and
   returns a local verdict.
6. **The test harness was not faithful** for `Uri.joinPath` (returned a bare string) and for modal
   `showInformationMessage` (dropped `options`). Both fixed; three existing assertions moved to `.fsPath`.
7. **`pytest -q` on top of `addopts = "-q"` is `-qq`** and prints no summary, which made an empty-looking receipt out of
   a passing suite. Evidence commands now pass `-o addopts=""`.

---

## 6. What this report does not prove

No Windows 11 install, no live VS Code Extension Host, no Copilot session, no real mail client receiving the draft, and
no Marketplace write. `check:payload` runs the packaged `extension.js` against a synthetic harness. The publication
requirements are established by measured probes plus cited documentation; the parts Microsoft does not document —
gallery propagation time, the literal `extensions.autoUpdate` default, Marketplace-side handling of `bugs.email` — are
flagged as unconfirmed in the research file rather than asserted.
