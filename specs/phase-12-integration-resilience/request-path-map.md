# Phase 12 evidence — the measured Semantic Scholar request path (DD12-01)

Produced by a read-only audit of the repository on 8 November 2026. Every claim below carries a file:line reference in
the tree as it stood at 0.3.11. This file exists so the scheduler design is written against code, not against a plausible
model of it.

## 1. There is exactly one outbound Python member **inside the worker**

`src/research_stack/research.py` is the only file in `src/research_stack/` with a network primitive. The audit's own regexes
over all 17 `src/research_stack/*.py` files: only `research.py` matches `OUTBOUND_PYTHON`; `records.py` matches
`URL_PARSE_ONLY` (`urllib.parse` quoting only, `records.py:238`). `mcp_server.py`, `lab_server.py`, `integrations.py`,
`cli.py`, `documents.py`, `full.py` have none.

**Corrected after the gate was measured on shipped bytes.** The packaged payload contains a second outbound member that a
scan of `src/research_stack/` cannot see: `extension/bundles/theological-research/scripts/crossref_lookup.py` (10 701 bytes)
uses `urllib.request.urlopen` against `api.crossref.org` and `api.openalex.org` with `TIMEOUT_SECONDS = 30`. It is a script
a person runs from a terminal inside a skill bundle, not a worker module. The audit now names both members and gates them
(DD12-11). The lesson is recorded in `.agent/LESSONS.md`: a source-tree scan and a payload scan are different measurements,
and only the payload one is the release gate.

The transport: `_request_json(url, headers)` at `research.py:139-171` — `urllib.request.Request` +
`build_opener(_SameHostHTTPSRedirectHandler())`, `REQUEST_TIMEOUT_SECONDS = 15` (`:23`), `MAX_RESPONSE_BYTES = 4 MiB`
(`:25`) enforced by reading one byte more (`:144-146`), and a redirect handler that refuses unless the scheme is HTTPS
**and** host and port are unchanged (`:48-54`).

Call sites: OpenAlex `:256-261` (key as a **query parameter**, `:260`), Crossref `:262-267`, Semantic Scholar
`research.py:268-271` (`graph/v1/paper/search`, key as the `x-api-key` header at `:270`), DOI validation Crossref-only
`:418`, and the Zotero loopback client `:432-452` (`timeout=2`, proxies bypassed, every redirect refused).

## 2. The pacing that exists is per process, and it is a floor

`research.py:23-30` and `research.py:174-185`, verbatim:

```python
_THROTTLE_LOCKS = {provider: threading.Lock() for provider in PROVIDERS}
_LAST_REQUEST_AT: dict[str, float] = {}
MIN_REQUEST_INTERVAL_SECONDS = 1.0

def _provider_request(provider, url, headers=None):
    lock = _THROTTLE_LOCKS[provider]
    with lock:
        elapsed = time.monotonic() - _LAST_REQUEST_AT.get(provider, 0.0)
        if elapsed < MIN_REQUEST_INTERVAL_SECONDS:
            time.sleep(MIN_REQUEST_INTERVAL_SECONDS - elapsed)
        try:
            return _request_json(url, headers)
        finally:
            _LAST_REQUEST_AT[provider] = time.monotonic()
```

Consequences, stated plainly:

- **Per process.** A `threading.Lock` and a module dict. Two Toolkit processes pacing at 1 req/s produce 2 req/s at the
  provider. Nothing is written to disk.
- **Cold start is free** (`:179`): the first request per provider per process never waits.
- **No retry, no backoff, no jitter, no token bucket, no semaphore.** `Retry-After` is *carried* into the error
  (`:167`) and surfaced as `retryAfter` (`:41-45`); nothing acts on it.
- **Provider-reported limits are read and discarded**: `x-rate-limit-limit` and `x-rate-limit-interval` are captured into
  the outcome at `:309-311` and never used.
- **Zotero has no pacing at all** — `_zotero_request` bypasses `_provider_request`.
- **No injectable clock.** `time.monotonic()` and `time.sleep()` are called directly inside `_provider_request`; there is
  no clock seam anywhere in `research.py`. A scheduler test needs one.
- The bucket is keyed by provider only, so `validate_citation` shares the Crossref bucket with Crossref search (`:420`).

Host-side pacing is a different, already-shared budget: `PROBE_COOLDOWN_MS = 30_000` (`integrationprobe.js:12`) held in
`context.globalState`, so it is shared across windows of one profile but not with the MCP server processes.

## 3. The error taxonomy already distinguishes what the brief wants distinguished

| Condition | Code today | Line |
|---|---|---|
| HTTP 401 / 403 | `PROVIDER_AUTH_REQUIRED` | `research.py:151-171` |
| HTTP 404 | `PROVIDER_NOT_FOUND` | same block |
| HTTP 429 | `PROVIDER_RATE_LIMITED` + `retryAfter` from the header | same block |
| HTTP ≥ 500 | `PROVIDER_UNAVAILABLE` | same block |
| other HTTP | `PROVIDER_REQUEST_REJECTED` | same block |
| timeout / connection failure | `PROVIDER_UNAVAILABLE` | same block |
| malformed JSON | `PROVIDER_SCHEMA_UNEXPECTED` | same block |
| body over 4 MiB | `RESPONSE_TOO_LARGE` | `:144-146` |
| licence not acknowledged | `PROVIDER_TERMS_NOT_ACKNOWLEDGED`, **before any request is built** | `:374-379` |

Zotero codes: `ZOTERO_API_DISABLED` (403), `ZOTERO_NOT_READY` (503), `ZOTERO_NOT_FOUND` (404), `ZOTERO_NOT_AVAILABLE`
(timeout/refused), `ZOTERO_REQUEST_FAILED`, `ZOTERO_SCHEMA_UNEXPECTED`, `ZOTERO_RESPONSE_TOO_LARGE` (`:446-452`).

**Finding that changes INT-13A.** The distinction "Zotero is installed but its local API refuses local clients" versus
"nothing is listening" **already exists** as `ZOTERO_API_DISABLED` versus `ZOTERO_NOT_AVAILABLE`. 0.3.11 collapsed both
into `not-installed` because `integrations.py` looks for a library file rather than asking the local API. The guided
onboarding is therefore mostly a wiring change, not a new capability.

Structured-vs-exception split: `research.py` always raises `ResearchError`; `recommended_server.py:39-68` converts every
domain refusal into a structured envelope (`{"resultState": "error", "error": exc.as_dict()}`,
`{"status": "unavailable", …}`, `{"readOnly": True, "error": …}`). A `provider="all"` search never raises for one
provider — it collects `errors[]` and reports `complete | partial | empty | unavailable` (`research.py:388-411`).
`cli.py:126-128` catches only `(DocumentError, OSError, ValueError)`, and `ResearchError` is a `RuntimeError`: it does not
escape today only because `integrations.py:92-109` swallows it into probe outcomes. **Any new code that can raise must be
caught at the same place, or the CLI prints a traceback.**

## 4. Nothing is cached, and the cache keys already exist

`research.py:1-5`: "The module has no persistent cache". No `lru_cache`, no cache file. The only dedup is
`_merge_exact_doi()` (`:317-349`), which merges across providers by normalized exact DOI and warns that title similarity
is never identity (`:400`).

But `_query_hash(provider, query)` — sha256 of `f"{provider}\0{query.strip()}"` (`:188-189`) — is already computed for
every request, embedded in every field's provenance (`:192-193`) and in the top-level `queryHash` (`:410`), and `fetchedAt`
is recorded per response (`:289`). **A cache and an in-flight claim can be keyed on a hash that already exists.**

The record store is workspace SQLite (`.research-toolkit/store/research.sqlite3`, `records.py:44-46`), has a generic
`meta(key, value)` table (`:65-68`) and already handles concurrent writers as `STORE_BUSY` (`:178-179`), but has **no
provider table**. Adding provider metadata there would couple the rate limiter to the corpus schema; the phase keeps them
apart.

## 5. How many processes can call the provider at once

`extension/extension.js:784-822` builds one `McpStdioServerDefinition` per server module that the selected preset needs,
from the three modules in `extension/presets.json:13-52`. Per window: 1–3 servers depending on preset, and **only
`research_stack.recommended_server` is ever handed the Semantic Scholar credential** (`extension.js:812`). So one window
has at most one credential-carrying MCP process.

Concurrent callers in a real session: that server, **plus** the readiness probe CLI (`extension.js:245-247`, which does
call Semantic Scholar through `integrations.py:79`), **plus** any hand-written `.mcp.json` duplicate
(`templates/optional/recommended-mcp.json`; `extension/guides/mcp-config.md:7` warns a duplicate doubles the tools),
**plus** a hand-run `research-stack` CLI (`pyproject.toml [project.scripts]`), **times** the number of open windows and
profiles. Each paces itself independently. This is the measured basis for INT-15.5.

## 6. What a new Python module has to pass

- `src/research_stack/` and `extension/worker/src/research_stack/` are **byte-identical**; the worker copy is generated by
  `scripts/build_worker_bundle.py` (`:82-91`). Edit the source tree, rebuild, never hand-edit the copy.
- The worker inventory is derived from a filesystem glob (`verify_vsix.py:85-88`) and compared exactly (`:236-237`);
  `bundle.json` must be regenerated or `:458-475` fails with an inventory or hash mismatch.
- `extension/runtime.js:13` restricts worker module names to `src/research_stack/[a-z_]+\.py`. `provider_budget.py`
  passes; `rate-limit.py` or `budget2.py` is rejected.
- `PYTHON_FORBIDDEN_PRIMITIVE` (`verify_vsix.py:180-183`) forbids `subprocess`, `eval(`, `exec(`, `__import__(`,
  `os.system|popen|exec*`, `pty`, `multiprocessing` in **every** packaged `.py`. `fcntl`, `msvcrt`, `threading`,
  `sqlite3`, `os.replace` and `time` are permitted. **This is why the Toolkit cannot execute an installer from Python.**
- Python outbound capability **was** reported-only when this map was written: `verify_vsix.py` collected
  `outbound_network_members` with no Python equivalent of `REVIEWED_JS_NETWORK_MEMBERS`, so a second Python
  member with `urllib.request` would have passed the audit silently. **Gap DD12-11 closes deliberately**: the
  audit now refuses unreviewed outbound members, refuses a reviewed member that has gone missing, requires the
  bound literals of each reviewed member, and counts the transport call sites per member. Running the gate
  against the built artifact — not against the source tree — is what found the second member this map had
  missed, `extension/bundles/theological-research/scripts/crossref_lookup.py`.
- `recommended.py:14` hard-codes `WORKER_FILES` for the Basic→Recommended upgrade. A new module imported by
  `recommended_server.py` would **not** be copied into an existing upgraded workspace and would `ImportError`.
  Any new module in that import chain must be added here, with a test. `provider_budget.py` is listed.
- `MAX_UNPACKED_BYTES` is a gate, and **each packaged Python module counts once, not twice**: only
  `extension/worker/src/research_stack/` is packaged, `src/research_stack/` is the source tree it is byte-compared
  against. An early projection in this phase assumed a double copy and reported a breach that the measured build
  did not have. The ceiling was 1 376 256 with 10 856 bytes of headroom at the start of the phase; the phase
  ended 6 848 bytes over it and re-measured to 1 441 792, attributed member by member in
  `scripts/verify_vsix.py:128-152`.
- Adding a *tool* (not a module) would break `extension/functional_check.py:26-35`, `tests/test_functional_check.py:31`,
  `tests/test_presets.py:43-62` and `extension/test/presets.test.js`. This phase adds no tool.

## 7. Writable locations and existing lock practice

Workspace-rooted Python writes all go through `paths.py` (`assert_relative` `:35-47`, `assert_no_redirect` `:50-68`,
`contained_write_path` `:71-79`, `resolve_under` `:82-92`): `research/imports/*.ris`, `outputs/**`,
`.research-toolkit/store/`, `.research-toolkit/lab-state.json`, `.research-toolkit/worker/**`, `.mcp.json`.

Managed JS writes: `.research-toolkit/managed/`, `worker-0.3.11/`, `active.json`, `.setup.lock`, `installation.json`,
`.venv`, `.research-toolkit/logs/last-setup.json`.

The only cross-process lock in the repository is JS and covers setup only: `runtime.js:246-256 acquireSetupLock` writes
the lock file with `flag: "wx"` and refuses `EEXIST`; `preflight.js:52-95 inspectLock` classifies it
`free | invalid | held | stale` with `STALE_BY_PID_AFTER_MS = 60000` and a setup window; `installer.js:478-491` clears a
stale one. Atomic replace exists in JS (`runtime.js:178-195`: temp with `wx`, then `rename`) and in Python
(`records.py:1365-1373` `open(candidate, "xb")` on a random name; `records.py:1452,1456` `os.replace`). **There is no
`fcntl`, `msvcrt.locking`, `portalocker` or `O_EXCL` lock file anywhere in `src/research_stack/`.**

## 8. Test conventions a new module must follow

Python: pytest only (`pytest==8.4.2`), no conftest, no mocking library. The seam is `monkeypatch.setattr(research,
"_request_json", response)` (`tests/test_research.py:22-29,190`), `_search_one` for provider outcomes (`:54-66`), and
`monkeypatch.setattr(research.urllib.request, "build_opener", …)` with an opener whose `open()` raises
`urllib.error.HTTPError(url, 429, "slow down", {"Retry-After": "4"}, None)` — the only test that exercises the real
`_request_json` body (`:89-98`). Gates that must prevent a request are proven by making the fake call `pytest.fail`
(`:71,120-126`). Secrets are proven absent with `SENTINEL_KEY` (`tests/test_integrations.py:11,121-135`). No-write is
proven by asserting a directory is unchanged (`:164-171`). Capability is proven statically by reading the module source
and asserting forbidden primitives are absent **plus a byte ceiling** (`:184-190`).

JS: `node:test` + `node:assert/strict`, transport injected as a parameter (`updates.js:126 fetchImpl = httpsGet`;
`updates.test.js:6-9` "No test in this file opens a socket"), and the real transport asserted statically against the
module source (`updates.test.js:197-203`). `integrationstore.js` and `integrationprobe.js` take `globalState`, `secrets`
and `registry` as parameters for the same reason.
