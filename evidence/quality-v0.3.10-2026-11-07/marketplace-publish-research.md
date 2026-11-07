# VS Code extension publishing — research report (as of 2026-11-07)

Research only. Nothing was published, no accounts created, no credential flow run.
Evidence sources: official Microsoft/VS Code docs, Azure DevOps docs + devblog, the
`microsoft/vscode-vsce` repo/npm packages, GitHub issues, and **local read-only
experiments** with `@vscode/vsce` 4.1.0 (`vsce ls/package` on a scratch extension in
`/tmp/ext-test`; `vsce publish` was only invoked with deliberately invalid manifests so
it failed before any auth/network step, plus read-only `vsce show`/`vsce search`).

Doc page dates used below:
- VS Code docs (`publishing-extension`, `extension-manifest`, `extension-marketplace`): last commit 2026-11-04 (vscode-docs, "VS Code release 1.145").
- Azure DevOps "Package and publish extensions": "Last updated on 2026-10-28".
- Azure DevOps "Use Personal Access Tokens": "Last updated on 2026-09-21".
- DevOps devblog "Retirement of Global PATs": published 2025-12-12, last updated 2026-10-23.
- DevOps blog "Trusted Publishing…": 2026-10-28.
- Azure DevOps Sprint 270 release notes: "Last updated on 2026-03-06".

---

## 1. Publisher creation

**Answer: `vsce create-publisher` no longer exists. A publisher must be created in the Marketplace management UI.**

Live check with vsce 4.1.0 (`vsce create-publisher my-new-publisher`):

> ERROR  The 'create-publisher' command is no longer available. You can create a publisher directly in the Marketplace: https://aka.ms/vscode-create-publisher

Same string in the shipped source: `@vscode/vsce@4.1.0/out/main.js` (`commander.on('command:*', …)` handler). The legacy npm package `vsce` (last release 2.15.0, 2022-12-02) already carried the same removal message; `@vscode/vsce` never had the command.

**Exact URL to create a publisher:** https://marketplace.visualstudio.com/manage → left pane **Create publisher** (short link https://aka.ms/vscode-create-publisher).

Docs, "Create a publisher" (https://code.visualstudio.com/api/working-with-extensions/publishing-extension#create-a-publisher):

> 1. Go to the Visual Studio Marketplace publisher management page.
> 1. Log in with the same Microsoft account you used to create the Personal Access Token …
> 1. Click **Create publisher** in the pane on the left.
> - **ID**: the **unique** identifier for your publisher in Marketplace that will be used in your extension URLs. **ID cannot be changed once created.**
> - **Name**: the **unique** name of your publisher that will be displayed in Marketplace with your extensions.

Azure DevOps side (https://learn.microsoft.com/en-us/azure/devops/extend/publish/overview#create-a-publisher, 2026-10-28):

> Sign in to the Visual Studio Marketplace Publishing Portal.
> If you aren't part of an existing publisher, select **+ Create a publisher**.
> Enter a publisher name; the ID field autofills based on your entry.
> **Note:** Ensure your publisher name is within 16 characters for multibyte characters.
> Save the publisher ID—you need it in your extension's manifest file.
> Set a unique publisher identifier, such as `mycompany-myteam`. Use this value for the `publisher` attribute in your manifest.
> Review the Marketplace Publisher Agreement, then select **Create**.

vsce's own ID rule (`out/validation.js`): publisher and extension `name` must match `/^[a-z0-9][a-z0-9\-]*$/i`.

> Invalid extension "publisher": "…" in package.json. Expected the identifier of a publisher, not its human-friendly name.

Extension name/display name uniqueness is enforced by the Marketplace:

> The Marketplace requires the extension name to be unique for every extension. … The same rule applies for the display name of an extension.

Still-present publisher commands in vsce 4.1.0: `login <publisher>`, `logout <publisher>`, `ls-publishers` (local known-publisher store), `delete-publisher <publisher>`.

---

## 2. Authentication for `vsce publish`

### 2a. Azure DevOps personal access tokens

**Scope + organization requirement** (https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-an-extension-using-personal-access-tokens-not-recommended):

> - Organization: **All accessible organizations**
> - Scopes: **Custom defined**:
>   - click **Show all scopes** link below the **Scopes** section
>   - in the Scopes list, scroll to **Marketplace** and select **Manage** scope

FAQ:

> One easy mistake to make when creating the PAT (Personal Access Token) is to select a specific organization instead of **All accessible organizations** in the **Organizations** field dropdown. Another possible mistake is incorrect scope - you should set the Authorized Scopes to `Marketplace (Manage)` for the publish to work.

**Retirement timeline — sources conflict; the blog is the more recent authority.**

| Source | Date of page | What it states |
|---|---|---|
| VS Code docs (`publishing-extension`) | 2026-11-04 | "On **December 1, 2026**, global Personal Access Tokens (PATs) in Azure DevOps are retired." (stated twice, in an IMPORTANT callout) |
| DevOps devblog *Retirement of Global PATs* | published 2025-12-12, **updated 2026-10-23** | "~~March 15, 2026~~ – Creation of new global PATs … will be blocked" + "(**Update 03/05: We will no longer be proceeding with blocking global PAT creation on March 15.** You may continue creating global PATs until they are decommissioned.)" and "~~December 1, 2026~~ **January 27, 2027** – All existing global PATs will be fully decommissioned. Tokens will stop working after this date. (**Update 10/23: This retirement has been postponed to avoid disruption during the December holiday season.**)" (the Dec 1 2026 date is inside `<del datetime="2026-10-23T17:04:45+00:00">`) |
| Azure DevOps *Use Personal Access Tokens* | 2026-09-21 | Internally inconsistent: "All existing global PATs stop working on **January 27, 2027**." (Important callout) vs "Global PATs stop working on **December 1, 2026**." (Create PATs section) |
| Azure DevOps Sprint 270 release notes | 2026-03-06 | Outdated: "On March 15, 2026, creation and regeneration of global PATs will be blocked. December 1, 2026, all existing global PATs will be fully decommissioned." |

**Most recent authority = the devblog (updated 2026-10-23): decommission = 2027-01-27; the March 15 2026 creation block was cancelled.** The VS Code publishing docs (2026-11-04) still print December 1, 2026 — treat Dec 1 2026 as the conservative planning date and note the official postponement.

Also: "No changes will be made to global PATs in the Azure DevOps **Server** product."

### 2b. OIDC / Trusted Publishing

**vsce flag:** `--oidc` (only on `vsce publish`; **not** available on `vsce package`, `vsce verify-pat`, `vsce unpublish`). Mutually exclusive with `--pat` and `--azure-credential`:

> error: option '--oidc' cannot be used with option '-p, --pat <token>'
> error: option '--oidc' cannot be used with option '--azure-credential'

**Minimum vsce version:** OIDC support landed in **v4.0.0** (PR #1291 "auth: support OIDC trusted publishing", released 2026-09-14), but 4.0.0 also shipped #1297 "Hide OIDC option from publish help". v4.1.0 (2026-10-28) shipped #1337 "oidc: align token exchange with the Marketplace contract" and #1348 "cli: Show OIDC publishing in help". **Recommend `@vscode/vsce` >= 4.1.0.** The VS Code docs still carry an unpublished TODO: "Document the minimum stable @vscode/vsce version that supports --oidc before publication."

**Required GitHub Actions permissions block** (VS Code docs and vsce README, identical):

```yaml
jobs:
  publish:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx @vscode/vsce publish --oidc
```

Failure text if `id-token: write` is missing: "GitHub Actions did not provide an OIDC token request URL and token. Add `permissions: id-token: write` to the workflow or job."

**Token exchange (from `@vscode/vsce@4.1.0/out/oidc.js`, confirmed against the README):**
- OIDC audience: `marketplace.visualstudio.com` (`OIDC_AUDIENCE`)
- Endpoint: `POST https://marketplace.visualstudio.com/_apis/gallery/token?api-version=7.2-preview.1`
- Header: `Authorization: FederatedToken <GitHub OIDC JWT>` (+ `Content-Type: application/json`, `User-Agent: vsce`)
- Body: `{"publisherName": "<publisher id>"}`; response field `credential` is then used in place of a PAT.
- GitHub OIDC token is requested from `ACTIONS_ID_TOKEN_REQUEST_URL` with `?audience=marketplace.visualstudio.com`.

**Lifetime / single use** (VS Code docs + vsce README + devblog):

> The Marketplace credential expires after **15 minutes**. Each GitHub OIDC token can be exchanged only **once**.

> Short-lived access — for GitHub Actions, Marketplace issues a temporary credential that expires after 15 minutes.

**Prerequisites** (VS Code docs "Publish with GitHub Actions and Trusted Publishing"; Azure DevOps overview; devblog):
1. The publisher must already exist; open it and select **Trusted Publishing** → **Create**.
2. Policy fields: **Policy name**, **Repository owner** (exact GitHub org/user login), **Repository** (name without owner), **Workflow** (filename under `.github/workflows`), **Environment** (optional, exact GitHub environment name, otherwise empty).
3. Private repositories: "run the configured workflow **within 48 hours** after creating the policy. The first successful token exchange **permanently activates** the policy." If unused, "it expires and can be reopened for another 48 hours."
4. No fallback: "It does not fall back to a PAT when token acquisition or exchange fails."
5. Provider support: "Marketplace Trusted Publishing doesn't currently support other OIDC providers." Azure Pipelines uses Entra workload-identity federation instead — "No Marketplace policy is required", but the identity must be added to the publisher with the **Contributor** role.
6. vsce 4.1.0 also sends an `X-Market-CI-Provider` header (PR #1345) on Marketplace requests.

### 2c. Other supported auth

- `-p, --pat <token>` — "Personal Access Token (defaults to `VSCE_PAT` environment variable)". **The flag itself is not deprecated** in vsce 4.1.0; what is discouraged is PAT-based publishing (docs heading: "Publish an extension using Personal Access Tokens (**Not Recommended**)").
- `VSCE_PAT` env var — also bypasses the native credential store (vsce README).
- `vsce login <publisher>` — prompts for the PAT and stores the publisher in the local known-publisher list; `vsce logout <publisher>` removes the new entry (does not revoke the PAT).
- Credential store: `@napi-rs/keyring` (system Secret Service / kernel keyring); `VSCE_STORE=file` reverts to the plaintext file store. Legacy `keytar` entries are offered for migration (skipped in CI).
- `--azure-credential` — Microsoft Entra ID token via Azure Identity `ChainedTokenCredential` (`EnvironmentCredential`, `AzureCliCredential`, `ManagedIdentityCredential`, `AzurePowerShellCredential`, `AzureDeveloperCliCredential`), resource `499b84ac-1321-427f-aa17-267ca6975798/.default`. Available on `publish`, `verify-pat`, `unpublish`. Requires the managed identity / service principal to be a **Contributor** on the publisher.
- `VSCE_MARKETPLACE_URL` — overrides `https://marketplace.visualstudio.com`.
- Wire format for PATs: `getBasicHandler('OAuth', pat)` (Basic auth with the `OAuth:<PAT>` user), from `out/util.js`.
- **`--githubPat` does not exist in vsce** — checked published builds `vsce@1.0.0`, `1.66.0`, `1.75.0`, `1.86.0`, `1.99.0`, `@vscode/vsce@2.15.0`, `2.16.0`, `2.30.0`, `3.0.0`, `4.1.0`: the string never appears. (It is not a vsce flag; likely confused with GitHub-PAT samples or `tfx-cli`/`VsixPublisher`.)

---

## 3. Manifest requirements vsce enforces or warns about

Hard errors (`validateManifestForPackaging` / `validateManifestForPublishing`, verified locally with vsce 4.1.0):

| Field | Rule | Evidence |
|---|---|---|
| `publisher` | Required for **publish** (packaging is allowed without it: "allow users to package an extension without a publisher for testing reasons"); must match `/^[a-z0-9][a-z0-9\-]*$/i`; `vscode-samples` is banned | `Missing extension "publisher": "<ID>" in package.json.` / `It's not allowed to use the 'vscode-samples' publisher.` |
| `name` | Required, `/^[a-z0-9][a-z0-9\-]*$/i`, unique in Marketplace | `Invalid extension "name": …`; docs: "should be all lowercase with no spaces. The name must be unique to the Marketplace." |
| `displayName` | Optional; defaults to `name`; must be unique | `displayName: manifest.displayName ?? manifest.name`; docs: "The display name must be unique to the Marketplace." |
| `description` | Optional; defaults to `''` | `description: manifest.description ?? ''` |
| `version` | Required, `semver.valid()` → **4-part versions rejected**; **prerelease tags accepted by `vsce package` but rejected by `vsce publish`** | Local: `vsce package` with `1.0.0.0` → `ERROR Invalid extension "version": "1.0.0.0"`; with `1.0.0-beta.1` → packaged fine; `vsce publish` with `1.0.0-beta.1` → `ERROR The VS Marketplace doesn't support prerelease versions: '1.0.0-beta.1'.` Docs: "We only support `major.minor.patch` for extension versions, `semver` pre-release tags are **not supported**." |
| `engines.vscode` | Required (`Manifest missing field: engines`); must match `/^\*$\|(\^\|>=)?((\d+)\|x)\.((\d+)\|x)\.((\d+)\|x)(\-.*)?$/` — so `*` is accepted by vsce even though the manifest reference says "Cannot be `*`" (docs/source conflict) | Local: `vsce package` with `"vscode": "*"` succeeded. Date tag rule: "To target an Insiders build by date, append a date tag in `YYYYMMDD` format … VS Code 1.57 and later enforce the date tag." `--target` needs `>=1.61`; `--pre-release` needs `>=1.63`. `@types/vscode` must not be newer than `engines.vscode`. |
| `icon` | **PNG only, SVG hard-rejected**; minimum 128x128 (256x256 for Retina) — size is a docs rule, not enforced by vsce | `ERROR SVGs can't be used as icons: icon.svg`; docs: "The icon provided in `package.json` may not be an SVG." / "a relative path to a PNG file of at least 128x128px" |
| `repository` | **Warning + interactive y/N prompt**; in non-TTY/CI vsce auto-answers `y`, so it does **not** fail | `WARNING A 'repository' field is missing from the 'package.json' manifest file.\nUse --allow-missing-repository to bypass.` (`out/util.js`: `if (process.env['VSCE_TESTS'] \|\| !process.stdout.isTTY) return Promise.resolve('y')`) |
| `license` file | **Warning + prompt** if no `LICENSE`/`LICENSE.md`/`LICENSE.txt`; bypass with `--skip-license` | `WARNING LICENSE, LICENSE.md, or LICENSE.txt not found` |
| `keywords` | vsce does **not** limit them; the Marketplace rejects >30 total tags | Docs FAQ: "The Visual Studio Marketplace does not allow an extension package to have more than 30 `keywords` … Limit the number of keywords/tags to maximum 30." Local: 31 keywords packaged fine. Note vsce auto-adds tags from `contributes`, activation events, languages, themes, `__web_extension`, `__sponsor_extension`, so 30 keywords can still exceed 30 tags. |
| `categories` | Free-form in vsce; docs list allowed values | Docs: "Allowed values: `[Programming Languages, Snippets, Linters, Themes, Debuggers, Formatters, Keymaps, SCM Providers, Other, Extension Packs, Language Packs, Data Science, Machine Learning, Visualization, Notebooks, Education, Testing]`" |
| `pricing` | Hard error if not `Free`/`Trial`; default `Free` | `ERROR Pricing can only be "Free" or "Trial"`; docs: "Allowed values are: `Free` and `Trial` (case-sensitive). When the `pricing` property is not specified, the default value is `Free`." Needs vsce >= 2.10.0. |
| `private: true` | **Ignored by vsce** (npm-only field) — packaging succeeded with it | Local test |
| `.vscodeignore` vs `files` | **Hard error if both are present** | `ERROR Both a .vscodeignore file and a "files" property in package.json were found. VSCE does not support combining both strategies.` |
| neither `.vscodeignore` nor `files` | Warning only | `WARNING Neither a .vscodeignore file nor a "files" property in package.json was found. …` |
| unused `files` patterns | **Hard error**, bypass with `--allow-unused-files-pattern` | `ERROR The following include patterns in the "files" property in package.json do not match any files packaged in the extension: … => Run vsce ls --tree … => Use --allow-unused-files-pattern to skip this check` |
| `README` | Not required, but if `--readme-path` is given and missing → hard error; relative links are rewritten from `repository` (GitHub/GitLab auto-detected, `main` branch by default) or fail | `ERROR Couldn't detect the repository where this extension is published. The link 'docs/more.md' will be broken in README.md. …` / `ERROR The provided readme file (NOPE.md) could not be found.` |
| `CHANGELOG` | Optional; hard error only if `--changelog-path` is given and missing | `ERROR The provided changelog file (CHANGELOG.md) could not be found.` |
| `qna` | `marketplace` (default) → `enableMarketplaceQnA`; string → custom link; `false` → disabled | Docs: "Set to `marketplace` to enable the default Marketplace Q & A site. Set to a string … Set to `false` to disable Q & A altogether." |
| `badges` | HTTPS only; SVG only from approved hosts | `ERROR Badge URLs must come from an HTTPS source: …` / `ERROR Badge SVGs are restricted. Please use other file image formats, such as PNG: …` |
| `preview` / galleryFlags | `preview: true` → `<GalleryFlags>Public Preview</GalleryFlags>`; default `Public` | Local vsixmanifest inspection (`<GalleryFlags>Public</GalleryFlags>`); docs: "Sets the extension to be flagged as a Preview in the Marketplace." |
| Other hard errors seen in source | `main`/`browser` vs `activationEvents` mismatch; `dependencies: { "vscode": … }`; proposed API without `--allow-all-proposed-apis`; duplicate case-insensitive paths; `extensionKind` as string (warning); `activationEvents: ["*"]` (prompt) | `"Manifest needs either a 'main' or 'browser' property, given it has a 'activationEvents' property."` / `You should not depend on 'vscode' in your 'dependencies'.` / `Extensions using proposed API (enableProposedApi: true) can't be published to the Marketplace.` |
| Secrets | vsce runs secretlint: `.env` files and detected secrets fail packaging unless `--allow-package-env-file`, `--allow-package-secrets <TYPE>`, or `--allow-package-all-secrets` | `out/secretLint.js`, CLI flags in `vsce package --help` |

---

## 4. Exact vsce commands and flags (from `vsce --help`, `@vscode/vsce` 4.1.0, Node >= 22)

Top level: `ls`, `package|pack [version]`, `publish [version]`, `unpublish [extensionid]`, `generate-manifest`, `verify-signature`, `ls-publishers`, `delete-publisher <publisher>`, `login <publisher>`, `logout <publisher>`, `verify-pat [publisher]`, `show <extensionid>`, `search <text>`.

| Item | Status in 4.1.0 |
|---|---|
| `vsce ls` | Present. `--tree`, `--yarn/--no-yarn`, `--packagedDependencies <path>`, `--ignoreFile <path>`, `--dependencies/--no-dependencies`, `--readme-path <path>`, `--follow-symlinks` |
| `vsce package` | Present. `-o/--out`, `-t/--target`, `--ignore-other-target-folders`, `--readme-path`, `--changelog-path`, `-m/--message`, `--no-git-tag-version`, `--no-update-package-json`, `--githubBranch`, `--gitlabBranch`, `--no-rewrite-relative-links`, `--baseContentUrl`, `--baseImagesUrl`, `--yarn/--no-yarn`, `--ignoreFile`, `--no-gitHubIssueLinking`, `--no-gitLabIssueLinking`, `--dependencies/--no-dependencies`, `--pre-release`, `--allow-star-activation`, `--allow-missing-repository`, `--allow-unused-files-pattern`, `--allow-package-secrets`, `--allow-package-all-secrets`, `--allow-package-env-file`, `--skip-license`, `--sign-tool`, `--follow-symlinks` |
| `vsce publish` | Present. `-p/--pat`, `--azure-credential`, `--oidc`, `-t/--target <targets...>`, `--ignore-other-target-folders`, `--readme-path`, `--changelog-path`, `-m/--message`, `--no-git-tag-version`, `--no-update-package-json`, **`-i/--packagePath <paths...>`**, `--manifestPath`, `--signaturePath`, `--sigzipPath`, `--sign-tool`, `--githubBranch`, `--gitlabBranch`, `--baseContentUrl`, `--baseImagesUrl`, `--yarn/--no-yarn`, `--no-verify` (**marked deprecated: use `--allow-all-proposed-apis`**), `--allow-proposed-apis`, `--allow-all-proposed-apis`, `--allow-package-*`, `--ignoreFile`, `--dependencies/--no-dependencies`, `--pre-release`, `--allow-star-activation`, `--allow-missing-repository`, `--allow-unused-files-pattern`, `--skip-duplicate`, `--skip-license`, `--follow-symlinks` |
| `vsce show <id>` | Present; `--json`. Works unauthenticated (read-only gallery API) — verified live. |
| `vsce search <text>` | Present; `--json`, `--stats`, `-p/--pagesize [value]` (default 100). Verified live. |
| `vsce verify-pat [publisher]` | Present; `-p/--pat`, `--azure-credential`. **No `--oidc`.** Docs example output: "The Personal Access Token verification succeeded for the publisher '<publisher id>'." |
| `vsce login <publisher>` | Present; no options. |
| `--skip-license` | Present on both `package` and `publish` ("Allow publishing without license file"). First appears in `@vscode/vsce` 2.30.0 builds; requested in issue #779. |
| `--allow-missing-repository` | Present on both. |
| `--pre-release` | Present on both. With `--packagePath`, the VSIX must already have been packaged as pre-release: "Cannot use '--pre-release' flag with a package that was not packaged as pre-release." |
| `--no-dependencies` | Present on `ls`, `package`, `publish` (dependency detection via npm/yarn). Docs elsewhere recommend `--no-dependencies` when bundling. |
| `--baseImagesUrl` | Present (also `--baseContentUrl`). Can also be set in `package.json` under `"vsce": { "baseImagesUrl": … , "dependencies": true, "yarn": false }`. |
| `--yarn` / `--no-yarn` | Present; auto-inferred from `yarn.lock`/`.yarnrc`. Supported package managers: `npm >=6`, `yarn >=1 <2` (docs: "You can either use npm or yarn v1"). |
| `--githubPat` | **Does not exist** in any vsce version checked (1.0.0 → 4.1.0). |
| `-p/--pat` | Present, **not deprecated** as a flag (defaults to `VSCE_PAT`); PAT publishing itself is labelled "Not Recommended". |
| Prebuilt `.vsix` | **Yes**: `vsce publish --packagePath <path>` (repeatable). Cannot be combined with a `[version]` positional or with `--target`: "Both options not supported simultaneously: 'packagePath' and 'target'. Use 'vsce package --target <target>' to first create a platform specific package, then use 'vsce publish --packagePath <path>' to publish it." Docs example: `vsce package --target win32-x64` then `vsce publish --packagePath PATH_TO_WIN32X64_VSIX`. |
| Version bumping | `vsce publish minor` / `vsce publish 1.1.0` (runs `npm version` first). `premajor/preminor/prepatch/prerelease/from-git` are rejected: "Not supported: …". In a git repo vsce also creates a version commit and tag; `-m` sets the message (`%s` = version). |
| Duplicate version | `--skip-duplicate` → "Version 1.2.3 is already published. Skipping publish." (also swallows HTTP 409) |

Minimal first-time sequence: `vsce ls --tree` → `vsce package` → `vsce publish` (or `vsce publish --oidc` in CI). `vsce verify-pat <publisher>` before the first publish when using a PAT.

---

## 5. Marketplace-side rules after publishing

**Version immutability** (https://code.visualstudio.com/api/working-with-extensions/publishing-extension#removing-specific-extension-versions):

> On the **Manage** tab, select **Delete this version**. … This action is **irreversible**.
> **IMPORTANT:** Once deleted, **you can't reuse this version number for a new publish**. Additionally, **you cannot delete the latest version of an extension**.

Re-uploading the same version fails: vsce pre-checks the gallery and throws `<publisher>.<name> v<version> already exists.` (or logs "Version … is already published. Skipping publish." with `--skip-duplicate`). Marketplace-side: "Increment the version in the manifest with every update." (Azure DevOps overview) and, for VS extensions, "any change to VS extension now needs the extension version to be bumped up … guarantees end users that the extension is immutable, description, license and any other metadata is mapped to an extension version." (https://github.com/microsoft/vsmarketplace/issues/544)

**Unpublish vs remove** (VS Code docs):

> Once unpublished, the extension's Availability status is changed to **Unpublished** and it will no longer be available for download from both the Marketplace and Visual Studio Code … the Marketplace preserves the extension statistics. The extension remains publicly discoverable and available via an existing API.

> Extension names are unique identifiers in the Visual Studio Code Marketplace. **Once an extension is removed, its extension name is permanently reserved and cannot be reused, even by the original publisher.**

Azure DevOps overview adds the gating rules: "Only free extensions might be unpublished." / "Your extension must have zero (0) installs to be removed."

**How long a new version takes to appear in VS Code's gallery — NOT officially documented.** No Microsoft page states an SLA. What is documented:
- "Microsoft runs a virus scan on each new and updated extension package published. Until the scan is all clear, we don't publish the extension in the Marketplace for public usage." (Azure DevOps overview, 2026-10-28)
- Marketplace-side validations exist and failures are reported by email and in the publisher portal: "whenever you publish a new extension or an update to an existing extension on the Marketplace, there are a few extension validations that are performed. You would be receiving an email in case of version validation failing. Additionally you would even be able to see the same in the Marketplace publisher portal for your publisher." (Microsoft's kesane-msft, https://github.com/microsoft/vscode/issues/82746)
- Marketplace web UI caching can lag behind the gallery API: the VS Code extension list showed 0.1.6 while the marketplace website still showed 0.1.5 — "Could be a caching issue on market place." (same issue)

**Auto-update defaults** (https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#extension-auto-update):

> VS Code checks for extension updates and installs them automatically. … You can also configure the `extensions.autoUpdate` setting.

> By default, VS Code waits a short time after an update is published before it installs the update automatically. Use the `extensions.autoUpdateDelay` setting to configure the delay, in hours. **The default value is `12` hours.** Set the value to `0` to install updates as soon as they are published. This delay only applies when auto-update is `on`. To update an extension immediately, select the **Update** button for the extension, which bypasses the delay.

> If you don't want VS Code to even check for updates, you can set the `extensions.autoCheckUpdates` setting to false.

(`extensions.autoUpdate` default is `true` — the docs describe auto-update as on by default and provide Disable/Enable Auto Update for Extensions commands; the literal default value is not printed on the page.)

**VSIX-installed extensions:**

> When you install an extension via VSIX, [auto update] for that extension is **disabled by default**.

**`workbench.extensions.installExtension` with `publisher.name@version`: Yes.** From VS Code `main`, `src/vs/workbench/contrib/extensions/browser/extensions.contribution.ts`:

> id: 'workbench.extensions.installExtension', … args: [{ name: 'extensionIdOrVSIXUri', description: "Extension id or VSIX resource uri", … }]

and the handler does `const [id, version] = getIdAndVersion(arg);` with (`src/vs/platform/extensionManagement/common/extensionManagementUtil.ts`):

> `EXTENSION_IDENTIFIER_WITH_VERSION_REGEX = /^([^.]+\..+)@((prerelease)|(\d+\.\d+\.\d+(-.*)?))$/;`

so `publisher.name@1.2.3`, `publisher.name@prerelease` and plain `publisher.name` are all accepted. Optional 2nd argument supports `installPreReleaseVersion`, `donotSync`, `justification`, `enable`, `installOnlyNewlyAddedFromExtensionPackVSIX`. Feature request https://github.com/microsoft/vscode/issues/136313 was closed 2022-01-18 with label `insiders-released`.

Pre-release versioning rule (docs): "Versions must be different between pre-release and regular releases. That is, if `1.2.3` is uploaded as a pre-release, the next regular release must be uploaded with a distinct version, such as `1.2.4`." and "we recommend that extensions use `major.EVEN_NUMBER.patch` for release versions and `major.ODD_NUMBER.patch` for pre-release versions."

---

## 6. `mailto:`, `bugs.email`, `scripts` validation failures

- **`mailto:` links in README/CHANGELOG — historical vsce failure, fixed in 2020.** Issue https://github.com/microsoft/vscode-vsce/issues/228 (2017-12-12): "Error: Couldn't detect the repository where this extension is published. The link 'mailto:me@website.com?Subject=Repro' will be broken in README.md." Fixed by PR #472 "Prevent mailto links from being joined with prefix" (merged 2020-08-03). Current vsce skips them (`if (/^mailto:/i.test(link))` in `out/package.js`). **Verified locally with vsce 4.1.0:** a README containing `[Email me!](mailto:someone@example.com?Subject=Hi)` packaged cleanly, while a relative link `docs/more.md` in the same README still failed without a `repository`.
- **Relative links without a `repository` are the real failure mode**, not mailto: "Couldn't detect the repository where this extension is published. The image will be broken in … GitHub/GitLab repositories will be automatically detected. Otherwise, please provide the repository URL in package.json or use the `--baseContentUrl` and `--baseImagesUrl` options."
- **`bugs.email`** is accepted and converted to a `mailto:` link in the VSIX manifest: `getBugsUrl()` returns ``mailto:${manifest.bugs.email}`` → `<Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="mailto:someone@example.com" />` (verified locally). With `bugs.url` present, `bugs.url` wins. **No Marketplace rejection was found or reproduced** — flag as unverified server-side behaviour.
- **`package.json` `scripts`** — no Marketplace-side failure found. vsce keeps `scripts` in the packaged `package.json` and runs `npm run vscode:prepublish` before packaging (verified locally: "Executing prepublish script 'npm run vscode:prepublish'..."). Docs: "You can add a pre-publish step to your manifest file, which will be called every time the extension is packaged." The only failure mode is the script itself failing. **Flag: no documented Marketplace validation issue for `scripts`.**
- Related real-world Marketplace-side failures worth citing in a runbook: `TF400898: An Internal Error Occurred` on `vsce publish` while the web upload worked (https://github.com/microsoft/vscode-vsce/issues/811, 2023-01); "Upload Error: Your extension has suspicious content." (Microsoft Q&A 5891990); "You exceeded the number of allowed tags of 30".

---

## 7. Licence file / `UNLICENSED`

- A licence file is **not required** by the Marketplace, but vsce prompts: `WARNING LICENSE, LICENSE.md, or LICENSE.txt not found` + `Do you want to continue? [y/N]`. In CI/non-TTY vsce auto-answers `y`, so it only warns. Bypass explicitly with `--skip-license`. Docs recommend: "Add a `LICENSE` file to the root of your extension with the information about the extension's license."
- `license` value semantics (manifest reference): "If you do have a `LICENSE` file in the root of your extension, the value for `license` should be `"SEE LICENSE IN <filename>"`." vsce honours that: `/^SEE LICENSE IN (.*)$/` selects that exact file; otherwise it looks for `extension/licen[cs]e(\.(md|txt))?`.
- **`UNLICENSED` is accepted by vsce** (it is just an npm SPDX placeholder; vsce does not validate the SPDX value and does not error). But because `UNLICENSED` is not `SEE LICENSE IN …`, vsce still looks for a `LICENSE*` file and warns/prompts if absent. **Flag: no Microsoft page explicitly mentions `UNLICENSED`.**
- **What the Marketplace shows when no licence is declared:** the licence asset is simply omitted. vsce only writes `<License>extension/LICENSE.txt</License>` and `<Asset Type="Microsoft.VisualStudio.Services.Content.License" …>` when a licence file was found (`delete this.vsix.license` in the processor constructor; verified locally). On the item page, the Resources block then renders an empty label — observed live in the item-page payload:
  - with a licence: `"Resources":{"LicenseText":"License","ChangelogText":"Changelog",…}` (e.g. `ms-vscode.live-server`, `czh.czh-verilog-snippet`)
  - without: `"Resources":{"LicenseText":"","ChangelogText":"Changelog",…}` (e.g. `AryaAnish.Snippet`, `rohit-chouhan.sqlite-snippet`, `devil-cyber.keras-snippet`)
  i.e. **no "License" row appears at all** (same mechanism for Changelog: `"ChangelogText":""` when no `CHANGELOG.md`).
- The manifest reference maps the Resources section as: Issues ← `bugs:url`, Repository ← `repository:url`, License ← `license`.

---

## Conflicts and unconfirmed items (flag these in the runbook)

1. **PAT retirement date conflict.** VS Code publishing docs (2026-11-04) say **December 1, 2026**; the authoritative devblog (updated 2026-10-23) strikes that through and says **January 27, 2027**, and cancels the March 15, 2026 creation block. Sprint 270 notes (2026-03-06) and parts of the Learn PAT page still say Dec 1, 2026. → Plan for Dec 1 2026, document the postponement.
2. **`engines.vscode: "*"`** — manifest reference says "Cannot be `*`", but vsce 4.1.0 accepts it (verified). Marketplace behaviour with `*` unverified.
3. **Gallery propagation time** — no official SLA found; only the virus-scan gate, validation emails, and Marketplace UI caching anecdotes.
4. **`extensions.autoUpdate` literal default** — described as on by default; the page never prints `true`.
5. **`--githubPat`** — not a vsce flag in any version checked.
6. **`bugs.email` / `scripts` Marketplace-side validation** — no documented failure found; treated as unconfirmed.
7. **Minimum vsce version for `--oidc`** — inferred (4.0.0 added it, hidden from help; 4.1.0 aligned the API contract and re-exposed it). The VS Code docs contain an explicit TODO to state this version, so it is not officially published.
8. **Publisher ID character rules in the UI** — docs state uniqueness + immutability and a 16-character multibyte limit for the *name*; the exact ID regex enforced by the web form was not verified (management UI requires sign-in, which was out of scope).
