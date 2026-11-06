# C — Theology bundle: PoC → shippable 0.3.9 skill bundle (read-only audit)

Date of audit: 2026-11-05 (UTC). Mode: read-only inspection; the only file written is this one.
Snapshot (source of truth): `…/Aplikovaná umělá inteligence pro sestry karmelitky/theological-research/`
Staged copy (repo): `…/Research-Stack/toolkit/templates/skill-bundles/theology/theological-research/`

## 1. Byte-identity verdict: IDENTICAL (11/11)

`sha256sum` on all 11 files in both trees; `diff -r` reported no differences. No file exists in one tree and not the other. No hidden files, no extra entries.

| Path (relative to bundle root) | sha256 (identical in both trees) | Match | Bytes |
|---|---|---|---|
| README.md | ab68739b7121868a5763672cee16f9d948c4557262ab23df03d07766729b7bf7 | MATCH | 3392 |
| SKILL.md | 52f86ed96f55e03071c919e5719d6722091f96b50d514ac07ffa841f4eda94c4 | MATCH | 7431 |
| evals/evals.json | 162a5951eec9ad0aaa08abd185edbf5d89f4927fe9bbfe686125fd79f45f21ec | MATCH | 3224 |
| references/citation-standards.md | aae444bcdda0c5899214e3d7fd7f7377b142925306775db065efd63641df3ae0 | MATCH | 2639 |
| references/methods.md | ff17c68ab4e08009e10bc671c7aae8bf9ed8a67a42e8cd32877f7118f2e39a3d | MATCH | 4819 |
| references/my-library.md | e52a65c1624a0bca986856660b8482eeddbe4540751466e31a9b26e75bc4573d | MATCH | 2342 |
| references/report-templates.md | 432f41cd49f60b77c49d0233009b4562db12d66eaa01cfe75684c10ecc191641 | MATCH | 2545 |
| references/source-evaluation.md | cf6ca30ec556070886acf3598a81d84e9f2c66f5b1a863ebaa598f65fa37ebfd | MATCH | 3446 |
| references/theology-and-social-sciences.md | 7bc0ed6c0a4ee264fb9ed92330199bbe928cdd6940086f787b6e88b2a4b3b3c9 | MATCH | 8106 |
| scripts/crossref_lookup.py | 544b23d59a380ed68bbee2c0e3470de6563f67761cfb656d59cc4f9bb0d0439a | MATCH | 7973 |
| scripts/dedupe_records.py | f045e35e6cb6c54e173922cf365528f3ebf27fc491ba0a9a0b4152a2dc3ae6ec | MATCH | 3802 |

Non-content differences (relevant to packaging, not to content integrity):
- File modes differ: snapshot `-rw-------` (0600), staged copy `-rwxrwxrwx` (0777). Staged scripts keep the executable bit and a `#!/usr/bin/env python3` shebang.
- Snapshot mtimes 2026-10-29 10:21–10:30; staged copy preserves them.
- `git status` in the toolkit repo: `?? templates/skill-bundles/` — the staged bundle is **untracked / not yet committed**; `git log` for that path is empty.
- The bundle is **not wired** into any shipped artifact: `extension/worker/bundle.json` lists only the five existing overlay skills (`citation-check`, `evidence-extraction`, `literature-search`, `paper-review`, `research-summary`); no `theolog` match anywhere in `extension/`.

## 2. What the skill is

A single Agent Skills bundle: `SKILL.md` (101 lines) + 6 references + 2 scripts + 4 eval scenarios.

Declared version: `metadata.version: "2.0"` in SKILL.md frontmatter (line 6). Also `metadata.author: "s. Denisa + Michal"`, `metadata.languages: "cs,en"`. The version string is duplicated in the script constant `USER_AGENT = "theological-research-skill/2.0 (contact: set-your-email@example.org)"` — two places to keep in sync.

Format compliance checked mechanically: `name: theological-research` (20 chars, valid `[a-z0-9-]`, no leading/trailing hyphen); `description` 430 chars (≤1024), third person, states what and when; body 101 lines (<500); the only reference over 100 lines (`theology-and-social-sciences.md`, 107) has a Contents TOC at the top; all links are one level deep with forward slashes. No `license` frontmatter field.

Workflow it defines (7 stages): 1) frame the question (subject/period/tradition/question type/output/constraints; at most one clarifying question); 2) probe which tools actually exist before promising anything; 3) build multilingual search terms (cs/en + Hebrew/Greek/Latin/Syriac), 3–6 focused searches, citation chaining, logged; 4) verify every citation with the two scripts, mark unresolved records `unverified`; 5) synthesize by thesis/school/chronology with confidence labels; 6) a copyable 9-item pre-delivery checklist; 7) fixed output structure with access-status labels. Hard rules 1–7 forbid invented titles/DOIs/quotations and forbid implying a verification succeeded.

Six references: `methods.md` (per-discipline method: biblical, patristic, historical, systematic, practical, comparative + review-type table); `source-evaluation.md` (what each source type can/cannot establish, 6 access labels, 4 confidence labels, 9-field evaluation table); `citation-standards.md` (Chicago default, record fields, DOI verification steps, dedupe guidance, locator rules, 5 failure patterns); `theology-and-social-sciences.md` (5 modes of engagement, which discipline is competent for which claim, how to read a social-science study, research with one's own religious community incl. consent/confession boundaries, mixed-methods rules, plus 4 "anchors verified in this session"); `my-library.md` (user-filled access inventory — see §5); `report-templates.md` (5 skeletons: short orientation, narrative review, structured review, research log, evidence matrix).

Two scripts: `crossref_lookup.py` verifies one citation against Crossref then OpenAlex; `dedupe_records.py` dedupes a JSON array of records and flags suspicious near-duplicates.

## 3. Script analysis

### scripts/crossref_lookup.py (179 lines) — NOT EXECUTED (requires network)
- CLI: positional `title`; `--author` (str, default ""), `--year` (int, default 0), `--container` (str), `--mailto` (str), `--openalex` (flag, skips Crossref). Verified via `python3 scripts/crossref_lookup.py --help` on a /tmp copy (argparse only, no request issued); `py_compile` OK.
- Working-directory assumptions: **none inside the script** — it performs no file I/O and reads no env vars. The cwd assumption lives in the docs: SKILL.md:56 and README.md:50 invoke `python3 scripts/crossref_lookup.py …`, which only resolves if cwd = the skill directory.
- Network: HTTPS GET to `https://api.crossref.org/works` (params `query.bibliographic`, `query.author`, `query.container-title`, `mailto`, `rows=5`) and `https://api.openalex.org/works` (`search`, `per_page=5`, `filter=from_publication_date:<y-1>-01-01,to_publication_date:<y+1>-12-31`). Timeout 30 s. No auth, no proxy, no retry/backoff/rate-limit. `--mailto` defaults to empty → requests do **not** enter Crossref's polite pool; the User-Agent contact is the placeholder `set-your-email@example.org`.
- Subprocess calls: none. Third-party imports: **none** — `argparse, json, re, sys, unicodedata, urllib.{error,parse,request}, difflib.SequenceMatcher` are all stdlib. Nothing from the toolkit dependency set (mcp 2.2.0 / pypdf 6.4.1 / python-docx 1.2.0 / pytest 8.4.2) is used, and nothing it imports is missing from it.
- Output: **stdout only** (JSON candidate + prose). Nothing written to disk.
- Failure modes (code-level, not executed): `HTTPError/URLError/TimeoutError/OSError/JSONDecodeError` are caught per service and collected in `errors`. Exit codes: 0 plausible match with author+year agreeing; 2 no plausible match **or** a match whose author/year disagrees (line 171–173); 3 both services failed and no candidate. Defects found by reading:
  - A service failure is silently swallowed when the other service returned a weak candidate: the exit-2 branches (lines 152–157, 164–167) never print `errors`, so "Crossref down" is reported as "no plausible match" — the exact confusion the skill's own rules forbid.
  - Exit code 2 carries three different meanings (no match / weak match / author-year mismatch); README.md:54 documents only "no credible candidate".
  - DOI shape is inconsistent between services: Crossref yields a bare DOI, OpenAlex `doi`/`ids.doi` yields a full `https://doi.org/…` URL (lines 98–99) → feeds the dedupe mismatch in §3.2.
  - Ranking is title-similarity driven (`SequenceMatcher` ≥ 0.80) with only ±0.1 author and ±0.05 year adjustments, and only the single best candidate is shown; a reprint or translation can outrank the intended work.
  - OpenAlex year filter is ±1 year, so a genuine older work (reprint, critical edition of a 1950 monograph) is filtered out and reported as "no match".
  - `--year 0` default means "no year given" is indistinguishable from a real year 0; `--author` is a normalized substring test, so short surnames match loosely.

### scripts/dedupe_records.py (108 lines) — EXECUTED against /tmp copies only
- CLI: one positional path; **defaults to the relative filename `records.json` in the current working directory** (line 51). No argparse → `--help` is treated as a filename and fails with `ERROR: --help not found` (exit 2). No stdin support: piping JSON in was ignored and the script read `./records.json` instead (verified).
- Working-directory assumption: real and load-bearing. Verified: run from `/tmp` with no `records.json` there → exit 2; run with an absolute path → exit 0.
- Network/subprocess: none. Imports: `json, re, sys, unicodedata, difflib` — stdlib only. `py_compile` OK.
- Output: deduped JSON array to **stdout**, report to **stderr**; nothing written to disk (the user must redirect). Verified behaviours:
  - Missing file → `ERROR: nope.json not found…`, exit 2. Invalid JSON → exit 2. Valid JSON that is not an array → `ERROR: expected a JSON array of records.`, exit 2. Clean input → exit 0. Any problem → exit 1.
  - **Records are silently removed from the output** in three cases: a record with no title, a record that is not an object, and a near-duplicate whose year equals the kept record's. A record with no identifier is kept and flagged.
  - DOI dedupe is an exact string match after `strip().lower()`: `10.1093/9780191790355.001.0001` and `https://doi.org/10.1093/9780191790355.001.0001` are **not** recognised as the same work (verified — the pair survived the DOI rule and was only caught by the title rule).
  - Near-duplicate threshold 0.92 on normalized title alone produces false positives on short titles: `"Distinct Work A"` vs `"Distinct Work B"` scored 0.93 and one was dropped.
  - The script prints `Fields checked: title, doi, year, authors`, but only title and doi are compared; year is used solely to annotate a near-duplicate. This overstates what was checked.
  - Scale/report volume: 3000 synthetic records ran in 0.43 s (O(n²) is not a practical problem) but emitted ~2 900 near-duplicate lines on stderr with no cap — an unbounded report that can flood an assistant's context.

## 4. Host prerequisites

| Prerequisite | Status | Evidence / command |
|---|---|---|
| Python 3 interpreter | VERIFIED HERE (container only) | `python3 --version` → 3.13.5 at `/usr/bin/python3`; toolkit venv `/…/toolkit/.venv/bin/python` → 3.12.16; `.python-version` = 3.12. Both compile both scripts (`python3 -m py_compile`). Not verified on the VS Code host. |
| Third-party Python deps for the scripts | VERIFIED — none needed | Import scan: stdlib only in both scripts. Toolkit venv holds mcp 2.2.0, pypdf 6.4.1, python-docx 1.2.0, pytest 8.4.2 (`importlib.metadata`); none is imported by the bundle, so the bundle adds no dependency requirement. |
| `uv` | NOT VERIFIED | `command -v uv` → not found on PATH in this container. Not required by the bundle itself. |
| Network egress to `api.crossref.org` / `api.openalex.org` | NOT VERIFIED (deliberately not tested) | `crossref_lookup.py` requires it; per instructions the script was not executed. Only `--help` and `py_compile` were run. |
| npm package `skills-ref` (README.md:44 `npx --yes skills-ref validate`) | NOT VERIFIED | `npx` 12.2.0 / `node` v24.22.0 present, but the package was not resolved (needs the npm registry). Format rules were instead checked directly against the Agent Skills constraints. |
| A filled `references/my-library.md` (the user's real access inventory) | NOT VERIFIED — file is an empty template | Read in full; every row is a `(placeholder)`. |
| A corpus of the community's PDFs (assumed by `evals/evals.json` eval-04, "V naší sbírce PDF") | NOT VERIFIED | No corpus exists in either tree; nothing in the bundle points at one. |
| A licensed database connection (ATLA and similar, SKILL.md:35) | NOT VERIFIED | No connector, credential or entitlement exists in the bundle or in the toolkit overlay presets. |
| VS Code Copilot skills discovery at `.github/skills/<skill-id>/` | NOT VERIFIED HERE | The path convention is documented in `docs/Research-Stack-Toolkit-0.3.9-Development-Summary-and-Skill-Bundles.md:35` and the five existing overlay skills ship under `extension/worker/overlay/.github/skills/`, but no live VS Code/Copilot host is reachable from this container and the theology bundle is absent from `extension/worker/bundle.json`. |
| A bundle catalog entry / manifest for the theology bundle | NOT VERIFIED — does not exist | `templates/skill-bundles/` is untracked; `catalog/*.json` contains only component profiles; no `theolog` reference in `extension/`. |

## 5. `references/my-library.md`: template, no personal data — but not shippable as-is

It is an **unfilled template**. First 15 lines, quoted:

```
# My library and my sources

Fill this in yourself. The agent must not assume any entry here is reachable; it checks access at run time. This file is the highest-value file in the skill, because it encodes what *you* can actually reach, which no general model knows.

## Contents
- Licensed and institutional access
- Open services
- Full-text collections I use
- Journals I follow
- Own document collection
- Terminology I use

## Licensed and institutional access

| Source | Access route | Verified working on | Notes |
|---|---|---|---|
```

Everything below is placeholder-shaped: `(library name)`, `(account)`, `(URL / proxy)`, `(date)`, `(collection 1)`, `(journal)`, `(folder / drive / collection name)`. The only concrete content is a 4-row Czech→English terminology seed (rešerše, otcové církve, koncil, teologie života / spiritualita). **No personal data, no credentials, no real institution names are present.**

Shipping as-is is acceptable **only as a clearly-labelled template**, with three caveats: (a) the row `| ATLA Religion Database | via (library name), (account) |` invites a user to store an account identifier in a file the assistant will read — the template should say "name the service, never paste credentials"; (b) the file is presented as "the highest-value file in the skill", so an installer that ships it empty is shipping a skill whose most important input is missing — the install flow should surface "library inventory: not filled in"; (c) two rows conflict with the 0.3.9 exclusions (§8).

## 6. Licensing: unresolved

- No license file in either tree (`find` for `*licen*`/`*copy*` returned nothing). No `license` field in SKILL.md frontmatter. The neighbouring `DOPORUCENI.md` (line 31) itself notes that the optional `license` field is absent.
- Authorship is stated only as free text: `metadata.author: "s. Denisa + Michal"` (SKILL.md:5). README.md says nothing about authorship, ownership or reuse; it describes format rules and development workflow only.
- The toolkit repo declares `"license": "UNLICENSED"` in `extension/package.json`, i.e. the host product is not openly licensed either.
- The 0.3.9 brief already flags this: "The original directory did not include a license file; clarify redistribution terms before publishing the bundle."

Must be resolved before redistribution: (1) an explicit license or distribution statement for the bundle, agreed with the named authors (s. Denisa and Michal), covering the six reference texts and both scripts; (2) a `license` field in SKILL.md frontmatter plus a `LICENSE` file inside the bundle so terms travel with the installed copy; (3) confirmation that the authors consent to bundling their names into a product distributed to third-party workspaces, and whether attribution must be displayed in the control panel; (4) a decision on whether user edits to `my-library.md` stay user-owned (they must — the skill is user data after install); (5) third-party terms the skill *invokes* even though it does not bundle them: Crossref (CC0 metadata, polite-pool etiquette), OpenAlex (CC BY 4.0 for its metadata — relevant if records are exported into user reports), and the npm `skills-ref` validator named in README.md.

## 7. Required adaptations, PoC → shippable bundle

1. **Stable skill id and directory contract.** Install target `.github/skills/<skill-id>/` must use `theological-research` verbatim (it already equals `name`, which the format requires). Decide the id once; a later rename breaks receipts and upgrades.
2. **Version field the installer can read.** `metadata.version: "2.0"` is a quoted string nested under `metadata`, not a top-level field, and the same version is duplicated in the script's `USER_AGENT`. Promote a single canonical version (plus bundle-level version distinct from skill-level) and keep them in sync or derive one from the other.
3. **Manifest / catalog metadata that does not exist yet.** The 0.3.9 brief requires stable identifiers, version, topic, purpose, complete file list with hashes, compatibility and provenance. Nothing in `catalog/` or `extension/worker/bundle.json` describes this bundle. Add a catalog entry carrying the 11 SHA-256 values from §1, the file list, prerequisites, and the source snapshot path.
4. **Path resolution that does not assume a cwd.** Both documented invocations (`python3 scripts/…`) and `dedupe_records.py`'s implicit `records.json` depend on the current working directory. Ship absolute/`<skill-dir>`-relative examples, and make `dedupe_records.py` require an explicit path (or accept stdin) instead of defaulting to a cwd file.
5. **Network disclosure text.** The bundle contacts `api.crossref.org` and `api.openalex.org` at runtime. The install UI and the bundle README must state the hosts, that requests are user/assistant-initiated (never by the installer), that no credentials are sent, and that a placeholder contact email is currently in the User-Agent. Set `--mailto` guidance and remove `set-your-email@example.org` from a shipped artifact.
6. **Dependency disclosure.** State plainly: stdlib-only, no toolkit dependency required, Python 3.x, and that `uv`/the toolkit venv are irrelevant to these two scripts. Also disclose that README's `npx --yes skills-ref validate` is an optional authoring tool that fetches an npm package — either drop it from the shipped copy or mark it as development-only.
7. **Near-duplicate output must be reviewable, not authoritative.** The 0.3.9 brief already requires this. Concretely: document that `dedupe_records.py` **deletes** records (no-title, non-object, same-year near-duplicates), that its DOI rule misses `https://doi.org/…` vs bare-DOI forms, and that its 0.92 title threshold can drop genuinely different works. Recommended fix: emit a `review/` sidecar instead of dropping, normalize DOI form before comparison, and cap or summarize the report.
8. **Text that overstates validation.** Fix these: `dedupe_records.py` printing `Fields checked: title, doi, year, authors` when only title and doi are compared; `crossref_lookup.py` reporting "NO PLAUSIBLE MATCH" while hiding a service failure (exit 2 instead of 3); the exit-2 triple meaning; and `theology-and-social-sciences.md` §"Anchors verified in this session" — four DOIs asserted as Crossref-verified on 2026-10-29, which **cannot be re-verified here** (no network test performed) and which a shipped bundle should label as "author-verified on <date>, not re-verified by the toolkit".
9. **Honest capability boundary in SKILL.md §2.** The probe list names a licensed database and a file search over the user's documents. In 0.3.9 those are not provided by the bundle; the text should say what the toolkit actually offers (the overlay's OpenAlex/Crossref/Semantic Scholar metadata MCP and the local text index) and what the user must supply.
10. **Post-install honesty.** The 0.3.9 brief requires separate statuses for "files installed", "host discovery verified" and "workflow tested", and states that bundle presence must not be presented as the assistant having used or validated it. The bundle's own checklist ("copy it and tick it") must not be rendered as evidence that any check ran.
11. **Id collision / shared-skill ownership check.** `templates/recommended-overlay/.github/skills/` already holds six skills (`citation-check`, `evidence-extraction`, `literature-search`, `paper-review`, `research-summary`, plus an untracked 0.3.8 workaround skill `document-corpus-bridge`). None of them declares a version field, so the theology bundle's `metadata.version` is a new convention that needs a repo-wide rule. The overlap between `citation-check`/`literature-search` and the theology bundle's §4 + `citation-standards.md` is real: decide which skill owns DOI verification so an install does not create two competing instructions in the same workspace.
12. **Provenance and reproducibility.** Commit `templates/skill-bundles/` (currently untracked), record the snapshot→payload hash chain, and preserve the 0600→0777 mode change as a deliberate, documented decision (or normalize to 0644/0755).

## 8. Conflicts with the 0.3.9 exclusions

Exclusions (0.3.9 brief, final paragraph): OCR, scanned-image recognition, vector/embedding search, background ingestion, external account provisioning, automatic paper acquisition.

| Bundle location | Text | Conflict | Action |
|---|---|---|---|
| `references/my-library.md:46` | `Search method: (file search / vector store / manual)` | Names **vector/embedding search** as an option the skill will use | Remove "vector store" or label it explicitly as not provided by 0.3.9 |
| `references/my-library.md:32,47` | "known gaps (OCR quality, missing volumes…)"; "Known gaps: (scanned volumes without OCR…)" | Touches **OCR / scanned-image recognition** | Acceptable only as a limitation statement; add "the toolkit does not perform OCR" so it cannot be read as a capability |
| `evals/evals.json` eval-04 | "Names indexing gaps (missing OCR…)"; "treating an index hit as proof" | Same OCR boundary, plus assumes a corpus and an index that do not exist | Re-scope the scenario to the toolkit's lexical/BM25 text index, or mark the scenario as requiring user-supplied documents |
| `references/my-library.md:17` | `via (library name), (account)` | Invites **external account provisioning** / credential storage | Reword to "name the service; never store credentials here" |
| `SKILL.md:35` | "Is a licensed database (ATLA and similar) actually connected and entitled?" | Borderline: probes an entitlement the toolkit does not provision | Keep, but state that the toolkit neither provisions nor checks such entitlements |
| `SKILL.md:37` ladder | "publisher and repository pages" | Could be read as directing **paper acquisition** | Clarify: metadata and access-status determination only; the toolkit does not download papers |
| `scripts/crossref_lookup.py` | Live HTTPS calls to two external APIs | Conflicts with "the interface … must not … run model requests or connect to outside services" if the installer or control panel ever invokes it | Keep invocation strictly user/assistant-initiated and disclosed; never run it during install or verification |
| Background ingestion | — | No conflict: both scripts are foreground, single-shot, user-invoked; nothing persists or schedules | None |

## 9. Commands run (evidence)

`find` on both trees; `sha256sum` + `wc -c` per file; `diff -r`; `ls -la` / `ls -l --time-style=long-iso`; `grep` for imports, network/subprocess/file-write markers, non-ASCII counts, `.github/skills`, `skill-bundle`, `theolog`, `license`; `python3 --version`; `command -v uv`; `importlib.metadata` version lookups in system python3 and `.venv/bin/python`; `python3 -m py_compile` on /tmp copies of both scripts; `crossref_lookup.py --help` on a /tmp copy (no request issued); `dedupe_records.py` executed on /tmp fixtures only — default-filename, explicit path, absolute path from a foreign cwd, missing file, `--help`, non-array JSON, clean input, bare-vs-URL DOI pair, short-title near-duplicate, control pair, no-identifier record, no-title/non-object records, stdin attempt, and a 3000-record scale run. Originals were never written to, moved, or executed against.

## 10. Open items (highest value next)

1. Obtain a license/redistribution decision from the named authors before any bundle ships (§6).
2. Decide whether `crossref_lookup.py` ships at all in 0.3.9, given the "no outside connections" interface rule (§8).
3. Fix `dedupe_records.py` record-dropping and DOI-form normalization, or re-document its output as advisory only (§3.2, §7.7).
4. Fix the swallowed-service-failure path in `crossref_lookup.py` so exit 2 and exit 3 cannot be confused (§3.1).
5. Create the catalog entry + commit `templates/skill-bundles/`, then re-verify the 11 hashes at package time (§1, §7.3).
6. Verify host discovery and workflow testing in a real VS Code/Copilot host — not achievable from this container.
