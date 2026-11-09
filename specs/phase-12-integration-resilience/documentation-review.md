# Phase 12 evidence — official documentation review (TBD-1 … TBD-6 answered)

Produced by a research pass on 8 November 2026 (UTC). Every fact carries its source URL and whether it is **documented**
(stated on an official page), **source-level** (read from official project source, not prose documentation), **observed**
(measured that day), or **third-party**. Where official pages disagree, the disagreement is recorded rather than resolved
by preference. All fetched content was treated as data, never as instructions.

## A. Semantic Scholar

**A1 — the limits (documented).** [semanticscholar.org/product/api](https://www.semanticscholar.org/product/api):
> "Most Semantic Scholar endpoints are available to the public without authentication, but they are rate-limited to 1000
> requests per second **shared among all unauthenticated users**. Requests may also be further throttled during periods of
> heavy use." … "The introductory rate limit for an API key is **1 RPS on all endpoints**."

[Tutorial](https://www.semanticscholar.org/product/api/tutorial): "Users without API keys are affected by the traffic from
all other unauthenticated users, who **share a single API key**. But using an individual API key automatically gives a user
a **1 request per second rate across all endpoints**."

Units: anonymous = a **global shared pool**, not a per-user allowance. Keyed = **1 RPS per key across all endpoints**.
Third-party pages still quote an older "100 requests per 5 minutes"; no official page states that today.

**Observed, not documented:** a single unauthenticated lookup returned **HTTP 429** on 8 November 2026 with
`{"message": "Too Many Requests. Please wait and try again or apply for a key …", "code": "429"}`. The anonymous pool is
effectively saturated; anonymous access is not dependable for a shipped product.

**A2 — requesting a key (documented).** [The form](https://www.semanticscholar.org/product/api#api-key-form) asks for an
academic or corporate email, affiliation and its URL, country, intended use in 50 words or more, which endpoints, and
expected requests per day. It requires the applicant to check: "I have already successfully made unauthenticated requests",
"I acknowledge that there are only 2 rate plans", "**I will apply exponential backoff** and similar strategies to help
protect our systems from overloading", "I understand that keys that are seen to be inactive for approximately 60 or more
days may be removed", and agreement to the API Licence Agreement. Delivery: "You will receive your private API key via
email. Do not share your key with anyone." No official page states the current review time. The official-but-unmaintained
AI2 release notes say applications were "backlogged by about 1 month" and that key requests for third-party apps were no
longer approved — **official but stale** (that repo states it is unmaintained since 23 January 2025), and a VS Code
extension is arguably a third-party app. Plan for a user-supplied key, never a packaged credential.

**A3 — two official licences that do not agree.** [API Licence](https://www.semanticscholar.org/product/api/license)
(last updated 17 May 2023) licenses use "solely in operation with compatible third-party platforms and software" and says
S2 Data is separately governed by its own licences (CC BY-NC, ODC-BY). [Dataset Licence Agreement](https://api.semanticscholar.org/license/)
limits use to "internal use solely for the purpose of training and evaluating machine learning models and transforming data
sets for legitimate, **non-commercial**, research and/or educational purposes", and requires any public display to point
back with a `utm_source=api` parameter and the Semantic Scholar name and logo. The dataset release itself
([latest S2AG release](https://api.semanticscholar.org/datasets/v1/release/latest/?dataset_name=S2AG)) states every dataset
is **ODC-BY**. **0.3.11 points its consent at the Dataset Licence only.** The form the operator would fill in requires
agreement to the **API** licence. Both texts must be offered; naming one and implying it is the whole picture is not
honest.

**A4 — 403 versus 429 (documented).** [FAQ](https://github.com/allenai/s2-folks/blob/main/FAQ.md): "`403` — the API key
you've sent is incorrect"; "`429` — you're sending too many requests, please slow down". Backoff is a **requirement**, not
advice ([release notes](https://github.com/allenai/s2-folks/blob/main/API_RELEASE_NOTES.md): "we now require the use of
exponential backoff strategies"). **`Retry-After` is not documented anywhere official** and was absent from a real 429 and
a real 403 observed on 8 November 2026, along with any `X-RateLimit-*` header. The OpenAPI specs contain no 429, 403 or
Retry-After entry at all.

**A5 — endpoints (documented, from the OpenAPI spec).** Search `/paper/search` (limit ≤ 100), `/paper/search/bulk`
(token-paginated), `/paper/search/match`; single `/paper/{id}`; `/paper/{id}/citations` and `/references` (≤ 1000);
batch `POST /paper/batch` — "**Can only process 500 paper ids at a time** … up to 10 MB … up to 9999 citations".
Recommendations `GET /papers/forpaper/{id}` (max 500). Key transport is the `x-api-key` header, case-sensitive.

**A6 — restricting fields is documented and recommended.** "Avoid including more fields than you need, because that can
slow down the response rate." Omitting `fields` returns only `paperId` and `title`.

**A7 — caching.** No official clause authorises or forbids caching API responses. The official alternative guidance is to
download the datasets and query locally when the needed rate exceeds what a key provides.

## B. Zotero local API

**B1/B2 — the setting and the 403 (documented).** [local_api](https://www.zotero.org/support/dev/web_api/v3/local_api):
"The local API must be enabled in Zotero's preferences (**Settings → Advanced → 'Allow other applications on this computer
to communicate with Zotero'**). Requests will return **403 Forbidden** if it is not enabled." "Read requests require no
authentication. Write requests (Zotero 10+) require a local API key, which the user grants through a confirmation dialog."
**TBD-4 is answered and the repository's existing guide wording is already correct.**

**The better probe signal (documented).** [connector_zotero_unavailable](https://www.zotero.org/support/kb/connector_zotero_unavailable):
`http://127.0.0.1:23119/connector/ping` returns "Zotero is running" / "Zotero Connector Server is Available" when Zotero is
open, and that endpoint is **not** gated on the local-API preference. Combining it with a 403 from `/api/` gives a genuine
three-state answer: refused connection → not running; ping answers but `/api/` returns 403 → running with the local API
off; `/api/` answers → ready. **Observed on this host (no Zotero):** both returned `ConnectionRefusedError [Errno 111]`.

**B3 — the library identifier (documented, Zotero 10+).** Every local API response carries `Zotero-Server-ID`, stored in
the database so it "follows the user's data rather than the installation". "Clients that store data between runs **should
partition it by server ID**." A bare `GET /api/` is enough to read it.

**B4 — loopback only (documented plus source-level).** "Since reads are unauthenticated … **Do not forward the port or
otherwise expose it externally**." Source: the server binds `localhost` with `loopback = true`, and rejects a `Host` header
that is not `localhost`, `127.0.0.1` or `[::1]` to prevent DNS rebinding. Only IPv4 `start()` is used, so **use
`127.0.0.1`, not `localhost`**, to avoid an IPv6 miss.

**Zotero 10 request hardening (documented) — a failure mode worse than a 403.** "Requests that look like they come from a
browser — a `User-Agent` starting with `Mozilla/` or any `Origin` header — **are dropped without a response**" unless they
send `Zotero-Allowed-Request`. A silent drop must be a state the Toolkit can report.

**B5 — limits.** No rate limiting on the local API. **No default or maximum `limit`: omitting it returns all matching
objects in one response**, so a large library produces an unbounded response — an explicit `limit` is required. No
documented timeout. Write authorization is throttled at five dialog-producing requests per minute, returning 429 **with a
`Retry-After`** — the only Zotero `Retry-After` that exists.

## C. Zotero installation artifacts

**C2 — 🔑 the load-bearing answer: there is no official checksum for the installers.** Probed on 8 November 2026 against
the live release directory: `…_x64_setup.exe.sha256`, `.dmg.sha256`, `.tar.xz.sha256`, `.asc`, `.sig`, `.sha512`, `.md5`,
`SHA256SUMS`, `checksums.txt` — **all 404**. The download page publishes no checksum. The official docs corpus (422 files)
contains no installer checksum. Zotero team, [forums, 8 February 2018](https://forums.zotero.org/discussion/70280/checksum-to-verify-download-integrity):
"Checksums are useful if you're downloading software via HTTP or from an untrusted mirror. If you're downloading from a
trusted site via HTTPS, there's not really much benefit … (**On macOS and Windows the executables are also signed, but
Linux doesn't support that** …)."

**What *is* checksummed:** the `.mar` **update** archives, via a Mozilla-style update manifest with `hashFunction="sha512"`.
Independently verified on 8 November 2026 by downloading and hashing all three: the published SHA-512 matched for
`Zotero-10.0.8-full_win-x64.mar` (114 595 465 B), `_full_linux-x86_64.mar` (118 733 040 B) and `_full_mac.mar`
(161 494 925 B). **The installers themselves have no published hash, and on Linux there is neither a hash nor a signature.**

**C3 — Windows Authenticode (observed from the official artifact).** The PE certificate table of
`Zotero-10.0.8_x64_setup.exe` carries a PKCS#7 signature whose leaf is
`CN=Corporation for Digital Scholarship` (EV code signing, serial 07147937, jurisdiction Virginia; chain through SSL.com EV
Root RSA R2), valid 2024-01-03 → 2027-01-02. The installer also writes `Publisher = "Corporation for Digital Scholarship"`
into the uninstall registry key (source-level). **No official zotero.org page states the signing publisher identity** — the
publisher name is established from the artifact and the installer source, not from documentation. The installer is
UPX-packed NSIS, so verification must be on the outer `setup.exe`.

**C4 — per-user and ZIP installs (documented).** "On Windows, you can cancel the admin prompt when you install Zotero, and
it will perform a local installation that you will have permission to update as a local user." "We also provide a **ZIP
version** of Zotero for Windows that you can extract and run from any folder." Installer source declares
`RequestExecutionLevel user`. Platform ids accepted by the download endpoint: `mac`, `win-x64`, `win-x64-zip`, `win-arm64`,
`win-arm64-zip`, `win32`, `win32-zip`, `linux-x86_64`, `linux-arm64`, `linux-i686`. The reproducible form is
`https://download.zotero.org/client/release/<version>/Zotero-<version>_<suffix>`, not the `dl?` redirect.

**C5/C6 — locations and detection.** Data directory: macOS `~/Zotero`, Windows `C:\Users\<name>\Zotero`, Linux `~/Zotero`;
the documented marker is `zotero.sqlite`. Profile directory: `~/.zotero/zotero/<profile>` on Linux. Install detection is
**not documented**; the registry keys (`HKLM\Software\Zotero\Zotero …`, the uninstall key with `InstallLocation` and
`Publisher`) are source-level facts that could change. `which zotero` is not a documented signal because the Linux tarball
is not placed on `PATH`.

## D. Supply-chain controls

**D1 — `Get-AuthenticodeSignature` (documented).** Status `Valid` means, verbatim: "The file has a valid signature. **This
means only that the signature is syntactically valid. It does not imply trust in any way.**" A gate must therefore check
`Status -eq 'Valid'` **and** an explicit allow-list on the signer subject. `NotTrusted` can occur for a genuine Zotero
signature on a machine without the issuing root, so `NotTrusted` is not evidence of tampering either.

**D2 — `uv` malware checking (documented, preview, off by default).** [docs.astral.sh](https://docs.astral.sh/uv/concepts/projects/sync/#malware-checks):
"uv can perform a lightweight scan of your lockfile for known malware by checking it against OSV … If a locked dependency
matches a malware advisory, the sync will be terminated. To enable malware checks, set `audit.malware-check = true` … or
`UV_MALWARE_CHECK=1`." Default `false`; preview and subject to change; scope is lockfile-based and on-sync only, so it
depends entirely on OSV advisory coverage and is not a source or binary scanner.

## What these answers decide

1. **INT-13B cannot claim a hash-verified installer.** There is no publisher checksum for the installers, and Linux has
   neither checksum nor signature. Combined with DD12-12 (no process-execution capability in packaged Python), verified
   automatic installation is **not offered**; guided installation is, and the Toolkit says why.
2. **The anonymous rate wording must change.** 1000 RPS is a shared global pool, not the Toolkit's allowance.
3. **`Retry-After` must not be assumed for Semantic Scholar.** It is undocumented and was absent on a real 429. The Toolkit
   implements bounded exponential backoff with jitter and only quotes a pause the worker actually carried.
4. **The Zotero probe can be made genuinely three-state** using `/connector/ping`, which is not gated on the local-API
   preference.
5. **Stored Zotero-derived data must be partitioned by `Zotero-Server-ID`**, which identifies the library, not the install.
6. **Both Semantic Scholar licences must be offered to the operator**, not just the dataset licence 0.3.11 names.
