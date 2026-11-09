"""Cross-process request budget, bounded retries with jitter, cache and dedup (DD12-03..05).

The provider limits the caller, not the process, so one budget per provider per OS user lives in a
file outside every workspace: N processes that each pace themselves reach the provider at N requests
per second. Bounded backoff with jitter is the mechanism; a carried `Retry-After` is an
opportunity, not an expectation. No transport lives here — the request function, the clock, the sleep and the jitter
source are parameters — and no key, token, URL or path is ever stored.
"""

from __future__ import annotations

import json
import os
import random
import re
import sys
import time
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable

# --- The Toolkit's own conservative budget, never the provider's allowance (TBD-2 answered) ---
# Source: https://www.semanticscholar.org/product/api (accessed 8 November 2026). Unauthenticated endpoints are
# "rate-limited to 1000 requests per second shared among all unauthenticated users" — a global pool shared with
# every other anonymous caller, not an allowance this Toolkit owns, so the anonymous budget stays the Toolkit's
# own. A key gives "1 RPS on all endpoints": 1 request per second per key across all endpoints, not per
# endpoint, so a per-endpoint budget would multiply a limit that does not exist. These constants are per
# provider; MIN_SPACING_MS is research.py's own floor, so the two floors do not wait twice.
ANON_WINDOW_MS, ANON_PERMITS = 60_000, 10
KEYED_WINDOW_MS, KEYED_PERMITS = 60_000, 40
MIN_SPACING_MS = 1_000  # equals research.MIN_REQUEST_INTERVAL_SECONDS: one floor, not two
RETRY_BASE_MS, RETRY_FACTOR, RETRY_ATTEMPT_CAP_MS = 500, 2, 8_000
RETRY_MAX_ATTEMPTS, RETRY_MAX_TOTAL_MS, JITTER_MAX_MS = 4, 6_000, 250
CALL_CEILING_MS = 20_000  # no attempt loop outlives the caller's patience (DD12-05)
RETRY_AFTER_MAX_MS = 60_000  # a longer block is reported, never waited out
LOCK_STALE_MS, LOCK_POLL_MS, LOCK_MAX_WAITS = 30_000, 200, 25
CLAIM_STALE_MS, CLAIM_WAIT_MS, CLAIM_POLL_MS = 30_000, 5_000, 250
CACHE_TTL_MS, CACHE_MAX_ENTRIES, CACHE_MAX_ENTRY_BYTES = 900_000, 16, 32_768
BUDGET_DIR_NAME = "research-stack-toolkit"
RETRYABLE_CODES = ("PROVIDER_RATE_LIMITED", "PROVIDER_UNAVAILABLE")
CACHE_HEADERS = ("x-rate-limit-limit", "x-rate-limit-interval", "retry-after", "content-type")


def budget_directory(env: dict[str, str] | None = None) -> tuple[Path, str]:
    """The per-user directory the budgets live in, plus a diagnostic naming the rule that chose it.

    Never a workspace: %LOCALAPPDATA% on Windows, ~/Library/Application Support on macOS,
    $XDG_DATA_HOME or ~/.local/share on Linux, each under research-stack-toolkit/. With no user
    directory the budget falls back to the session temp directory and the diagnostic says it is not
    shared across workspaces.
    """
    env = os.environ if env is None else env
    home = env.get("HOME") or env.get("USERPROFILE") or ""
    if os.name == "nt":
        base = env.get("LOCALAPPDATA") or home
    elif sys.platform == "darwin":
        base = home and f"{home}/Library/Application Support"
    else:
        base = env.get("XDG_DATA_HOME") or (home and f"{home}/.local/share")
    if base:
        return Path(base) / BUDGET_DIR_NAME, "per-user application data"
    temp = env.get("TMPDIR") or env.get("TEMP") or env.get("TMP") or "/tmp"
    return Path(temp) / BUDGET_DIR_NAME, "no per-user application-data directory resolved; the budget is not shared across workspaces"


def parse_retry_after(value: str | None, *, now_ms: float) -> int | None:
    """A Retry-After — delta-seconds or an HTTP date — as an absolute instant, clamped."""
    text = str(value or "").strip()
    if not text:
        return None
    if text.isdigit() and len(text) < 10:
        delta = int(text) * 1000
    else:
        try:
            moment = parsedate_to_datetime(text)
        except (TypeError, ValueError):
            return None
        delta = int((moment if moment.tzinfo else moment.replace(tzinfo=UTC)).timestamp() * 1000) - int(now_ms) if moment else 0
    return int(now_ms) + max(0, min(delta, RETRY_AFTER_MAX_MS))


def backoff_ms(attempt: int, jitter_value: float) -> int:
    """Exponential backoff with jitter, capped per attempt. attempt starts at 1; jitter is 0..1."""
    raw = RETRY_BASE_MS * (RETRY_FACTOR ** max(0, attempt - 1))
    return int(min(raw + max(0.0, min(float(jitter_value), 1.0)) * JITTER_MAX_MS, RETRY_ATTEMPT_CAP_MS))


def _facts(data: dict[str, Any]) -> dict[str, int]:
    """The four facts a budget file holds, and nothing else."""
    return {key: int(data.get(key) or 0) for key in ("windowStartMs", "permits", "nextAllowedMs", "blockedUntilMs")}


def _read(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


_seq = 0


def _write(path: Path, value: dict[str, Any]) -> None:
    """Never in place: a temp file opened for exclusive creation, then one atomic replace."""
    global _seq
    _seq += 1
    temp = Path(f"{path}.{os.getpid()}-{_seq}.tmp")
    try:
        with open(temp, "xb") as handle:
            handle.write(json.dumps(value, separators=(",", ":")).encode("utf-8"))
        os.replace(temp, path)
    except OSError:
        temp.unlink(missing_ok=True)
        raise


class ProviderBudget:
    """One provider's budget for one OS user. The file is the state; the instance is cheap."""

    def __init__(self, provider: str, *, keyed: bool = False, directory: Path | str | None = None,
                 now_ms: Callable[[], float] = lambda: time.time() * 1000.0,
                 sleep_ms: Callable[[float], None] = lambda ms: time.sleep(max(0.0, ms) / 1000.0),
                 jitter: Callable[[], float] = random.random) -> None:
        if not re.fullmatch(r"[a-z_]{1,32}", provider):
            raise ValueError("provider must be a lowercase identifier")
        self.directory, self.diagnostic = (budget_directory() if directory is None
                                           else (Path(directory), "directory given by the caller"))
        self.provider, self.keyed, self.owner = provider, keyed, f"{os.getpid()}-{id(self)}"
        self.now_ms, self.sleep_ms, self.jitter = now_ms, sleep_ms, jitter
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
        except OSError:
            self.diagnostic = "the budget directory could not be created; only this process is paced"

    def _path(self, kind: str) -> Path:
        return self.directory / f"{kind}-{self.provider}.json"

    def _lock(self) -> Path | None:
        """Portable O_EXCL lock carrying its own creation stamp; a dead holder's lock is taken over."""
        lock = Path(f"{self._path('budget')}.lock")
        for _ in range(LOCK_MAX_WAITS):
            now = int(self.now_ms())
            try:
                handle = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            except FileExistsError:
                try:
                    stamp = int(lock.read_text(encoding="ascii"))
                except (OSError, ValueError):
                    stamp = int(lock.stat().st_mtime * 1000)
                if now - stamp > LOCK_STALE_MS:
                    lock.unlink(missing_ok=True)
                else:
                    self.sleep_ms(LOCK_POLL_MS)
            except OSError:
                return None
            else:
                os.write(handle, str(now).encode("ascii"))
                os.close(handle)
                return lock
        return None

    def _mutate(self, kind: str, change: Callable[[dict[str, Any]], Any]) -> Any:
        """Read one file, let `change` edit it, replace it atomically, release the lock."""
        try:
            lock = self._lock()
        except OSError:
            return None
        if lock is None:
            return None
        try:
            data = _read(self._path(kind))
            changed, value = change(data)
            if changed:
                _write(self._path(kind), data)
        except OSError:
            value = None
        finally:
            lock.unlink(missing_ok=True)
        return value

    def _issue(self, data: dict[str, Any], now: int) -> tuple[bool, tuple[int, dict[str, int]]]:
        """Decide, and when the answer is "ask now", spend the permit in that same write."""
        window, limit = (KEYED_WINDOW_MS, KEYED_PERMITS) if self.keyed else (ANON_WINDOW_MS, ANON_PERMITS)
        budget = _facts(data)
        start, permits = budget["windowStartMs"], budget["permits"]
        if not start or now - start >= window:
            start, permits = now, 0
        wait = max(budget["blockedUntilMs"] - now, budget["nextAllowedMs"] - now, 0)
        if permits >= limit:
            wait = max(wait, start + window - now)
        if wait == 0:
            permits += 1
            budget["nextAllowedMs"] = now + MIN_SPACING_MS
        budget["windowStartMs"], budget["permits"] = start, permits
        data.update(budget)
        return (wait == 0, (wait, budget))

    def acquire(self, ceiling_ms: int = CALL_CEILING_MS) -> dict[str, Any]:
        """Spend one permit, waiting out a block another process brought on, within the ceiling."""
        waited = 0
        while True:
            now = int(self.now_ms())
            step = self._mutate("budget", lambda data: self._issue(data, now))
            if step is None:
                return {"state": "unavailable", "reason": None, "waitedMs": waited, "waitMs": 0, "blockedUntilMs": 0}
            wait, budget = step
            if wait == 0:
                return {"state": "allowed", "reason": None, "waitedMs": waited, "waitMs": 0, "blockedUntilMs": budget["blockedUntilMs"]}
            if wait > ceiling_ms - waited:
                return {"state": "deferred", "reason": "blocked", "waitedMs": waited, "waitMs": wait, "blockedUntilMs": budget["blockedUntilMs"]}
            self.sleep_ms(wait)
            waited += wait

    def state(self) -> dict[str, int]:
        """The shared budget as it stands. No lock: a replace is atomic, so a reader never sees half a file."""
        return _facts(_read(self._path("budget")))

    def _block(self, until: int) -> int:
        def change(data: dict[str, Any]) -> tuple[bool, int]:
            budget = _facts(data)
            budget["blockedUntilMs"] = max(budget["blockedUntilMs"], until)
            data.update(budget)
            return (True, budget["blockedUntilMs"])

        return self._mutate("budget", change) or until

    def note_blocked(self, retry_after: str | None) -> int:
        """Write a carried Retry-After into the shared budget when a provider sent one; the backoff is the mechanism."""
        until = parse_retry_after(retry_after, now_ms=self.now_ms())
        return self._block(until) if until is not None else self.state()["blockedUntilMs"]

    def _cached(self, key: str) -> dict[str, Any] | None:
        entry = (_read(self._path("cache")).get("entries") or {}).get(key)
        if not isinstance(entry, dict) or self.now_ms() - int(entry.get("atMs") or 0) > CACHE_TTL_MS:
            return None
        return entry

    def _entry(self, payload: Any, headers: dict[str, str]) -> dict[str, Any]:
        now = int(self.now_ms())
        return {"atMs": now, "fetchedAt": datetime.fromtimestamp(now / 1000.0, UTC).isoformat(), "payload": payload,
                "headers": {k.lower(): str(v) for k, v in (headers or {}).items() if k.lower() in CACHE_HEADERS}}

    def _reserve(self, key: str, entry: dict[str, Any] | None) -> bool:
        """Edit the cache file under the lock: claim a key, or store its result and release the claim.

        With no entry the answer is whether this caller now holds the in-flight marker — False when a
        live caller already holds it. With an entry the oldest ones past the cap are dropped first.
        """
        now = int(self.now_ms())

        def change(data: dict[str, Any]) -> tuple[bool, bool]:
            entries = data.get("entries") or {}
            claims = data.get("claims") or {}
            held = claims.get(key)
            if entry is None:
                if held and held.get("owner") != self.owner and now - int(held.get("atMs") or 0) <= CLAIM_STALE_MS:
                    return (False, False)
                claims[key] = {"atMs": now, "owner": self.owner}
            else:
                if len(json.dumps(entry)) <= CACHE_MAX_ENTRY_BYTES:
                    entries[key] = entry
                if held is None or held.get("owner") == self.owner:
                    claims.pop(key, None)
                while len(entries) > CACHE_MAX_ENTRIES:
                    entries.pop(min(entries, key=lambda k: int(entries[k].get("atMs") or 0)))
            data.clear()
            data.update({"entries": entries, "claims": claims})
            return (True, True)

        return self._mutate("cache", change) is True

    def _await(self, key: str) -> dict[str, Any] | None:
        """Wait a bounded time for the caller already asking this key. Never deadlock on it."""
        for _ in range(CLAIM_WAIT_MS // CLAIM_POLL_MS):
            hit = self._cached(key)
            if hit is not None:
                return hit
            held = (_read(self._path("cache")).get("claims") or {}).get(key)
            if not isinstance(held, dict) or self.now_ms() - int(held.get("atMs") or 0) > CLAIM_STALE_MS:
                return None
            self.sleep_ms(CLAIM_POLL_MS)
        return None

    def _defer(self, step: dict[str, Any], attempts: int, exc: Exception | None = None) -> dict[str, Any]:
        """A degraded answer: no request was made, and the wait to respect is already computed."""
        error = None if exc is None else {"code": getattr(exc, "code"), "message": str(exc), "retryAfter": getattr(exc, "retry_after", None)}
        return {"payload": None, "headers": {}, "fromCache": False, "attempts": attempts, "deferred": step["reason"],
                "waitMs": step["waitMs"], "waitedMs": step["waitedMs"], "blockedUntilMs": step["blockedUntilMs"], "error": error}

    def run(self, transport: Callable[..., Any], url: str, *, headers: dict[str, str] | None = None,
            cache_key: str | None = None) -> dict[str, Any]:
        """Ask the provider under the shared budget: cache, dedup, bounded retries, shared Retry-After.

        The URL goes to the transport and is never stored. The result states whether the provider was
        asked, how many attempts it took, and — when it was not asked — the wait to respect instead.
        """
        key = f"{'keyed' if self.keyed else 'anon'}:{cache_key}" if cache_key else None
        if key:
            hit = self._cached(key) or (None if self._reserve(key, None) else self._await(key) or (self._reserve(key, None) and None))
            if hit is not None:
                return {"payload": hit["payload"], "headers": dict(hit.get("headers") or {}), "fromCache": True,
                        "attempts": 0, "deferred": None, "retrievedAt": hit.get("fetchedAt")}
        decision = self.acquire()
        if decision["state"] == "deferred":
            return self._defer(decision, 0)
        backoff_ceiling = min(RETRY_MAX_TOTAL_MS, CALL_CEILING_MS)
        for attempt in range(1, RETRY_MAX_ATTEMPTS + 1):
            try:
                payload, response_headers = transport(url, headers)
                out = {k.lower(): str(v) for k, v in (response_headers or {}).items() if k.lower() in CACHE_HEADERS}
                if key:
                    self._reserve(key, self._entry(payload, out))
                return {"payload": payload, "headers": out, "fromCache": False, "attempts": attempt, "deferred": None}
            except Exception as exc:
                if getattr(exc, "code", "") not in RETRYABLE_CODES:
                    raise
                blocked = self.note_blocked(getattr(exc, "retry_after", None))
                pause = backoff_ms(attempt, self.jitter())
                if attempt == RETRY_MAX_ATTEMPTS or decision["waitedMs"] + pause > backoff_ceiling:
                    return self._defer({"reason": "exhausted", "waitMs": pause, "waitedMs": decision["waitedMs"], "blockedUntilMs": blocked}, attempt, exc)
                if not getattr(exc, "retry_after", None):
                    blocked = self._block(int(self.now_ms()) + pause)
                step = self.acquire(max(0, backoff_ceiling - decision["waitedMs"]))
                if step["state"] != "allowed":
                    return self._defer({**step, "reason": step["reason"] or "exhausted"}, attempt, exc)
                decision["waitedMs"] += step["waitedMs"]
        raise AssertionError("the attempt loop always returns or raises")
