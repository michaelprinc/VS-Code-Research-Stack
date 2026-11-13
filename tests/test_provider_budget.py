"""The shared request budget, its retries, its cache and its files (INT-14.4..14.7, INT-15.5).

No test in this file opens a socket, waits in real time or writes to the operator's real per-user
directory: the clock, the sleep, the jitter source and the budget directory are all injected.
"""

from __future__ import annotations

import json
import random
from pathlib import Path, PureWindowsPath

import pytest

from research_stack import provider_budget, research

SENTINEL_KEY = "SENTINEL-KEY-8f3a1c-not-a-real-key"
URL = "https://api.semanticscholar.org/graph/v1/paper/search?query=bounded+evidence"


class Clock:
    """An injected clock. A sleep moves it forward and is recorded, so timing is provable."""

    def __init__(self, start: float = 1_762_000_000_000) -> None:
        self.now = start
        self.slept: list[float] = []

    def now_ms(self) -> float:
        return self.now

    def sleep_ms(self, ms: float) -> None:
        self.slept.append(ms)
        self.now += ms


class FakeTime:
    """The module-level `time` seam, so a test can drive research.py and provider_budget.py alike."""

    def __init__(self, clock: Clock) -> None:
        self.clock = clock

    def time(self) -> float:
        return self.clock.now / 1000.0

    def monotonic(self) -> float:
        return self.clock.now / 1000.0

    def sleep(self, seconds: float) -> None:
        self.clock.sleep_ms(seconds * 1000.0)


class FakeOs:
    def __init__(self, name: str) -> None:
        self.name = name


class FakeSys:
    def __init__(self, platform: str) -> None:
        self.platform = platform


class RateLimited(Exception):
    """Shaped like the provider errors research.py raises: a code, a message, an optional Retry-After."""

    def __init__(self, message: str = "Provider rate limit reached; the Toolkit's own bounded backoff applies, with any wait the provider named carried through.",
                 retry_after: str | None = None) -> None:
        super().__init__(message)
        self.code = "PROVIDER_RATE_LIMITED"
        self.retry_after = retry_after


class Unreachable(Exception):
    def __init__(self, message: str = "Provider request timed out or could not connect; no result count was inferred.") -> None:
        super().__init__(message)
        self.code = "PROVIDER_UNAVAILABLE"


@pytest.fixture
def budget_dir(tmp_path: Path) -> Path:
    return tmp_path / "budget"


@pytest.fixture
def shared_budget_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Where research.py's budget lives when a test reaches it: a tmp directory, never the operator's."""
    directory = tmp_path / "shared-budget"
    monkeypatch.setattr(provider_budget, "budget_directory", lambda _env=None: (directory, "isolated for this test"))
    return directory


@pytest.fixture
def injected_time(monkeypatch: pytest.MonkeyPatch) -> Clock:
    clock = Clock()
    monkeypatch.setattr(provider_budget, "time", FakeTime(clock))
    monkeypatch.setattr(research, "time", FakeTime(clock))
    monkeypatch.setattr(research, "_LAST_REQUEST_AT", {})
    return clock


def budget(directory: Path, clock: Clock, **kwargs) -> provider_budget.ProviderBudget:
    return provider_budget.ProviderBudget(kwargs.pop("provider", "crossref"), directory=directory,
                                          now_ms=clock.now_ms, sleep_ms=clock.sleep_ms, **kwargs)


def facts(directory: Path, provider: str = "crossref") -> dict[str, int]:
    return json.loads((directory / f"budget-{provider}.json").read_text(encoding="utf-8"))


def test_two_callers_with_separate_state_share_one_budget(budget_dir: Path) -> None:
    """INT-15.5: the budget is the file, not the instance, so a second caller is held by the first's spending."""
    first_clock = Clock()
    first = budget(budget_dir, first_clock, jitter=lambda: 0.0)
    assert first.acquire()["state"] == "allowed"
    assert first_clock.slept == []

    second_clock = Clock(first_clock.now)
    second = budget(budget_dir, second_clock, jitter=lambda: 0.0)
    decision = second.acquire()
    assert decision["state"] == "allowed"
    assert decision["waitedMs"] == provider_budget.MIN_SPACING_MS
    assert second_clock.slept == [provider_budget.MIN_SPACING_MS], "the wait is taken, not merely reported"
    assert facts(budget_dir)["permits"] == 2


def test_the_budget_file_holds_only_the_four_documented_facts(budget_dir: Path) -> None:
    budget(budget_dir, Clock()).acquire()
    assert set(facts(budget_dir)) == {"windowStartMs", "permits", "nextAllowedMs", "blockedUntilMs"}


def test_the_window_cap_stops_callers_at_the_documented_limit(budget_dir: Path) -> None:
    clock = Clock()
    for _ in range(provider_budget.ANON_PERMITS):
        assert budget(budget_dir, clock).acquire()["state"] == "allowed"
        clock.now += provider_budget.MIN_SPACING_MS
    decision = budget(budget_dir, clock).acquire()
    assert decision["state"] == "deferred" and decision["reason"] == "blocked"
    assert decision["waitMs"] == provider_budget.ANON_WINDOW_MS - provider_budget.ANON_PERMITS * provider_budget.MIN_SPACING_MS
    assert facts(budget_dir)["permits"] == provider_budget.ANON_PERMITS, "the documented cap is not exceeded"
    clock.now += decision["waitMs"]
    assert budget(budget_dir, clock).acquire()["state"] == "allowed"
    assert facts(budget_dir)["permits"] == 1, "the window reopens instead of the cap being stretched"


def test_a_keyed_call_and_an_anonymous_call_have_different_budgets(budget_dir: Path) -> None:
    clock = Clock()
    for _ in range(provider_budget.ANON_PERMITS):
        budget(budget_dir, clock).acquire()
        clock.now += provider_budget.MIN_SPACING_MS
    keyed = budget(budget_dir, clock, provider="semantic_scholar", keyed=True)
    assert keyed.acquire()["waitedMs"] == 0
    assert facts(budget_dir, "semantic_scholar")["permits"] == 1


def test_a_429_with_retry_after_makes_every_other_process_wait(budget_dir: Path) -> None:
    """INT-14.5 / DD12-03: one 429 must quiet every Toolkit process, not only the one that received it."""
    clock = Clock()
    start = clock.now
    asked: list[str] = []

    def rate_limited_once(url: str, _headers: dict[str, str] | None = None):
        asked.append(url)
        if len(asked) == 1:
            raise RateLimited(retry_after="4")
        return ({"data": []}, {"retry-after": "4"})

    result = budget(budget_dir, clock, provider="semantic_scholar").run(rate_limited_once, URL, cache_key="hash-1")
    assert asked == [URL, URL] and result["attempts"] == 2
    assert clock.slept == [4000], "the provider's own wait was taken"
    assert facts(budget_dir, "semantic_scholar")["blockedUntilMs"] == start + 4000

    other_clock = Clock(start)
    other = budget(budget_dir, other_clock, provider="semantic_scholar")
    decision = other.acquire()
    assert decision["state"] == "allowed" and decision["waitedMs"] >= 4000
    assert other_clock.slept == [decision["waitedMs"]], "the second process waits out a block it was never told about"


def test_a_retry_after_longer_than_the_clamp_is_reported_not_waited_out(budget_dir: Path) -> None:
    clock = Clock()

    def always_limited(url: str, _headers: dict[str, str] | None = None):
        raise RateLimited(retry_after=str(provider_budget.RETRY_AFTER_MAX_MS // 1000 + 1))

    result = budget(budget_dir, clock, provider="crossref").run(always_limited, URL)
    assert result["deferred"] == "blocked" and result["payload"] is None
    assert result["waitMs"] == provider_budget.RETRY_AFTER_MAX_MS, "the wait is clamped before it is honoured"
    assert facts(budget_dir)["blockedUntilMs"] == clock.now + provider_budget.RETRY_AFTER_MAX_MS


def test_backoff_without_retry_after_is_a_bounded_schedule(budget_dir: Path) -> None:
    """INT-14.5: attempts, total wait and jitter all have stated bounds, and all three are enforced."""
    clock = Clock()
    calls: list[str] = []

    def always_limited(url: str, _headers: dict[str, str] | None = None):
        calls.append(url)
        raise RateLimited()

    result = budget(budget_dir, clock).run(always_limited, URL, headers=None)
    assert len(calls) == provider_budget.RETRY_MAX_ATTEMPTS
    assert result["attempts"] == provider_budget.RETRY_MAX_ATTEMPTS
    assert result["deferred"] == "exhausted"
    assert sum(clock.slept) == result["waitedMs"] <= provider_budget.RETRY_MAX_TOTAL_MS
    assert all(wait <= provider_budget.RETRY_ATTEMPT_CAP_MS for wait in clock.slept)


def test_a_timeout_uses_the_same_bounded_schedule_as_a_429(budget_dir: Path) -> None:
    clock = Clock()
    result = budget(budget_dir, clock).run(lambda *_args: (_ for _ in ()).throw(Unreachable()), URL)
    assert result["deferred"] == "exhausted" and result["attempts"] == provider_budget.RETRY_MAX_ATTEMPTS
    assert result["error"]["code"] == "PROVIDER_UNAVAILABLE"
    assert sum(clock.slept) <= provider_budget.RETRY_MAX_TOTAL_MS


def test_a_slow_request_counts_against_the_ceiling_as_much_as_a_sleep_does(budget_dir: Path) -> None:
    """Defect P8: `CALL_CEILING_MS` says no attempt loop outlives the caller's patience.

    It used to count only the pauses the loop slept. Four requests that each timed out after 15 seconds
    slept almost nothing, so the loop ran to about 66 seconds against a 20-second promise — and that is what
    killed the readiness probe mid-check. A request that takes 15 seconds has spent the patience too, whether
    or not the loop slept.
    """
    clock = Clock()
    calls: list[str] = []

    def slow_then_fail(url: str, _headers: dict[str, str] | None = None):
        calls.append(url)
        clock.now += 15_000  # the request itself consumed the time; no sleep was involved
        raise Unreachable()

    result = budget(budget_dir, clock).run(slow_then_fail, URL)
    assert result["deferred"] == "exhausted", "the loop still reports what it ran out of, rather than pretending it finished"
    assert len(calls) < provider_budget.RETRY_MAX_ATTEMPTS, (
        f"the loop stopped after {len(calls)} slow request(s) instead of spending all "
        f"{provider_budget.RETRY_MAX_ATTEMPTS} attempts, because the time the requests took counts")
    assert len(calls) * 15_000 <= provider_budget.CALL_CEILING_MS + 15_000, (
        "the whole loop stayed inside the stated ceiling plus the one request already in flight when it was "
        "reached, so a caller that set a bound gets a bound")


def test_jitter_stays_inside_its_bounds_across_seeded_draws() -> None:
    rng = random.Random(20261108)
    for attempt in range(1, provider_budget.RETRY_MAX_ATTEMPTS + 2):
        base = provider_budget.RETRY_BASE_MS * provider_budget.RETRY_FACTOR ** (attempt - 1)
        ceiling = min(base + provider_budget.JITTER_MAX_MS, provider_budget.RETRY_ATTEMPT_CAP_MS)
        draws = [provider_budget.backoff_ms(attempt, rng.random()) for _ in range(400)]
        assert min(draws) >= base and max(draws) <= ceiling
        if base < provider_budget.RETRY_ATTEMPT_CAP_MS:
            assert len(set(draws)) > 1, "jitter must actually vary, or shared budgets wake in step"
    assert provider_budget.backoff_ms(9, 1.0) == provider_budget.RETRY_ATTEMPT_CAP_MS
    assert provider_budget.backoff_ms(1, -1.0) == provider_budget.RETRY_BASE_MS


@pytest.mark.parametrize(("value", "expected"), [
    ("4", 4_000),
    ("0", 0),
    ("999999", provider_budget.RETRY_AFTER_MAX_MS),
    ("Sun, 06 Nov 2028 20:00:00 GMT", provider_budget.RETRY_AFTER_MAX_MS),
    ("not a retry window", None),
    ("", None),
    (None, None),
])
def test_retry_after_parsing_covers_both_forms_and_the_clamp(value: str | None, expected: int | None) -> None:
    now = 1_762_000_000_000
    parsed = provider_budget.parse_retry_after(value, now_ms=now)
    if expected is None:
        assert parsed is None
    else:
        assert parsed == now + expected


def test_an_http_date_retry_after_is_parsed_as_an_instant() -> None:
    now = 1_794_168_000_000  # 2026-11-08T20:00:00Z
    assert provider_budget.parse_retry_after("Sun, 08 Nov 2026 20:00:05 GMT", now_ms=now) == now + 5_000
    assert provider_budget.parse_retry_after("Sun, 08 Nov 2026 19:55:00 GMT", now_ms=now) == now


def test_a_denial_that_is_not_rate_limiting_is_never_retried(budget_dir: Path) -> None:
    """DD12-05: 401/403/404 are not retryable, and retrying them is a defect, not patience."""
    clock = Clock()
    calls: list[str] = []

    class Denied(Exception):
        code = "PROVIDER_AUTH_REQUIRED"

    def denied(url: str, _headers: dict[str, str] | None = None):
        calls.append(url)
        raise Denied("Provider denied the request; check API access and credentials.")

    with pytest.raises(Denied):
        budget(budget_dir, clock).run(denied, URL)
    assert len(calls) == 1 and clock.slept == []


def test_a_provider_that_always_refuses_produces_a_degraded_answer_not_a_hang(budget_dir: Path) -> None:
    """Acceptance 6: bounded retries, informative feedback, no infinite loop."""
    clock = Clock()
    result = budget(budget_dir, clock).run(lambda *_args: (_ for _ in ()).throw(RateLimited(retry_after="1")), URL)
    assert result["payload"] is None and result["fromCache"] is False
    assert result["deferred"] in {"blocked", "exhausted"}
    assert result["waitMs"] > 0 and result["blockedUntilMs"] > clock.now
    assert result["error"]["code"] == "PROVIDER_RATE_LIMITED"
    assert result["error"]["message"] == "Provider rate limit reached; the Toolkit's own bounded backoff applies, with any wait the provider named carried through."


def test_identical_concurrent_requests_do_not_spend_a_second_permit(budget_dir: Path) -> None:
    """INT-14.6 / DD12-04: the second caller waits for the first's result instead of asking again."""
    clock = Clock()
    first = budget(budget_dir, clock)
    assert first._reserve("anon:hash-2", None) is True
    assert first.acquire()["state"] == "allowed"
    spent = facts(budget_dir)["permits"]

    second_clock = Clock(clock.now)

    def finishing_sleep(ms: float) -> None:
        second_clock.sleep_ms(ms)
        first._reserve("anon:hash-2", first._entry({"message": {"items": []}}, {"x-rate-limit-limit": "50"}))

    second = provider_budget.ProviderBudget("crossref", directory=budget_dir, now_ms=second_clock.now_ms,
                                            sleep_ms=finishing_sleep, jitter=lambda: 0.0)
    result = second.run(lambda *_args: pytest.fail("the provider must not be asked twice for one request"), URL, cache_key="hash-2")
    assert result["fromCache"] is True and result["attempts"] == 0
    assert facts(budget_dir)["permits"] == spent, "the second caller spent no permit"


def test_a_stale_in_flight_claim_does_not_deadlock_the_second_caller(budget_dir: Path) -> None:
    clock = Clock()
    store = budget(budget_dir, clock)
    (budget_dir / "cache-crossref.json").write_text(json.dumps(
        {"entries": {}, "claims": {"anon:hash-3": {"atMs": int(clock.now) - provider_budget.CLAIM_STALE_MS - 1,
                                                   "owner": "999999-0"}}}), encoding="utf-8")
    asked: list[str] = []

    def ok(url: str, _headers: dict[str, str] | None = None):
        asked.append(url)
        return ({"message": {"items": []}}, {})

    result = store.run(ok, URL, cache_key="hash-3")
    assert result["fromCache"] is False and asked == [URL] and clock.slept == []


def test_a_cache_hit_is_served_without_asking_the_provider_and_is_labelled(budget_dir: Path) -> None:
    """INT-14.6: a hit is a hit, and the result says so, and it expires."""
    clock = Clock()
    store = budget(budget_dir, clock)
    asked: list[str] = []

    def ok(url: str, _headers: dict[str, str] | None = None):
        asked.append(url)
        return ({"message": {"items": [{"DOI": "10.1234/cached"}]}}, {"x-rate-limit-limit": "50"})

    first = store.run(ok, URL, cache_key="hash-4")
    assert first["fromCache"] is False and asked == [URL]
    hit = store.run(lambda *_args: pytest.fail("a cache hit must not reach the provider"), URL, cache_key="hash-4")
    assert hit["fromCache"] is True and hit["attempts"] == 0
    assert hit["payload"] == {"message": {"items": [{"DOI": "10.1234/cached"}]}}
    assert hit["headers"] == {"x-rate-limit-limit": "50"} and hit["retrievedAt"], "the hit keeps the retrieval time it actually happened at"

    clock.now += provider_budget.CACHE_TTL_MS + 1
    after_ttl = store.run(ok, URL, cache_key="hash-4")
    assert after_ttl["fromCache"] is False and len(asked) == 2


def test_the_cache_is_size_capped_and_drops_the_oldest_entries(budget_dir: Path) -> None:
    clock = Clock()
    store = budget(budget_dir, clock)
    for index in range(provider_budget.CACHE_MAX_ENTRIES + 5):
        clock.now += 1
        assert store._reserve(f"anon:hash-{index}", store._entry({"index": index}, {})) is True
    entries = json.loads((budget_dir / "cache-crossref.json").read_text(encoding="utf-8"))["entries"]
    assert len(entries) == provider_budget.CACHE_MAX_ENTRIES
    assert entries[f"anon:hash-{provider_budget.CACHE_MAX_ENTRIES + 4}"]["payload"] == {"index": provider_budget.CACHE_MAX_ENTRIES + 4}
    assert f"anon:hash-0" not in entries, "the oldest entry is the one that goes"


def test_no_credential_or_url_ever_enters_a_file_or_a_returned_string(budget_dir: Path) -> None:
    """INT-15.3 in the budget's shape: the key is passed through, never stored, never echoed back."""
    clock = Clock()
    keyed = budget(budget_dir, clock, provider="semantic_scholar", keyed=True)

    def transport(url: str, headers: dict[str, str] | None = None):
        assert headers and headers["x-api-key"] == SENTINEL_KEY, "the transport still receives the key"
        return ({"data": []}, {"x-rate-limit-limit": "1", "authorization": SENTINEL_KEY, "set-cookie": SENTINEL_KEY})

    result = keyed.run(transport, f"{URL}&api_key={SENTINEL_KEY}", headers={"x-api-key": SENTINEL_KEY}, cache_key="hash-5")
    assert SENTINEL_KEY not in json.dumps(result) and "api.semanticscholar.org" not in json.dumps(result)
    written = [path for path in budget_dir.rglob("*") if path.is_file()]
    assert written, "the budget and the cache must actually have been written"
    for path in written:
        body = path.read_text(encoding="utf-8")
        assert SENTINEL_KEY not in body, f"{path.name} carries the sentinel key"
        assert "api.semanticscholar.org" not in body, f"{path.name} carries the request URL"
        assert str(budget_dir) not in body, f"{path.name} carries an absolute path"
    assert SENTINEL_KEY not in keyed.diagnostic


def test_a_stale_lock_left_by_a_dead_process_is_taken_over(budget_dir: Path) -> None:
    """DD12-03: a crashed process cannot freeze the budget forever."""
    clock = Clock()
    budget_dir.mkdir(parents=True, exist_ok=True)
    lock = budget_dir / "budget-crossref.json.lock"
    lock.write_text(str(int(clock.now) - provider_budget.LOCK_STALE_MS - 1), encoding="ascii")
    decision = budget(budget_dir, clock).acquire()
    assert decision["state"] == "allowed" and clock.slept == []
    assert not lock.exists(), "the taken-over lock was released"


def test_a_live_lock_is_respected_and_the_caller_gives_up_rather_than_waiting_forever(budget_dir: Path) -> None:
    clock = Clock()
    budget_dir.mkdir(parents=True, exist_ok=True)
    lock = budget_dir / "budget-crossref.json.lock"
    lock.write_text(str(int(clock.now)), encoding="ascii")
    decision = budget(budget_dir, clock).acquire()
    assert decision["state"] == "unavailable", "the budget degrades to this process only; the request still goes"
    assert len(clock.slept) == provider_budget.LOCK_MAX_WAITS
    assert lock.exists(), "a live holder's lock is not stolen"


def test_the_budget_directory_is_per_user_and_never_a_workspace(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setattr(provider_budget, "os", FakeOs("posix"))
    monkeypatch.setattr(provider_budget, "sys", FakeSys("linux"))
    directory, diagnostic = provider_budget.budget_directory({"XDG_DATA_HOME": str(tmp_path / "xdg"), "HOME": str(tmp_path)})
    assert directory == tmp_path / "xdg" / provider_budget.BUDGET_DIR_NAME and diagnostic == "per-user application data"
    fallback_home, _ = provider_budget.budget_directory({"HOME": str(tmp_path)})
    assert fallback_home == tmp_path / ".local" / "share" / provider_budget.BUDGET_DIR_NAME
    monkeypatch.setattr(provider_budget, "sys", FakeSys("darwin"))
    macos, _ = provider_budget.budget_directory({"HOME": str(tmp_path)})
    assert macos == tmp_path / "Library" / "Application Support" / provider_budget.BUDGET_DIR_NAME
    orphan, diagnostic = provider_budget.budget_directory({"TMPDIR": str(tmp_path / "tmp")})
    assert orphan == tmp_path / "tmp" / provider_budget.BUDGET_DIR_NAME
    assert "not shared across workspaces" in diagnostic, "the fallback is recorded, not hidden"
    monkeypatch.setattr(provider_budget, "os", FakeOs("nt"))
    monkeypatch.setattr(provider_budget, "Path", PureWindowsPath)
    windows, _ = provider_budget.budget_directory({"LOCALAPPDATA": "C:\\Users\\nurse\\AppData\\Local"})
    assert windows == PureWindowsPath("C:\\Users\\nurse\\AppData\\Local") / provider_budget.BUDGET_DIR_NAME


def test_the_atomic_write_leaves_no_temp_file_behind(budget_dir: Path) -> None:
    budget(budget_dir, Clock()).acquire()
    assert sorted(path.name for path in budget_dir.iterdir()) == ["budget-crossref.json"], \
        "a temp file opened for exclusive creation is replaced, and the lock is released"


def test_search_literature_labels_a_cache_hit_and_does_not_ask_again(shared_budget_dir: Path, injected_time: Clock,
                                                                     monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []

    def response(url: str, _headers: dict[str, str] | None = None):
        asked.append(url)
        return ({"message": {"items": [{"DOI": "10.1234/cached", "title": ["Cached record"]}], "total-results": 1}}, {})

    monkeypatch.setattr(research, "_request_json", response)
    first = research.search_literature("crossref", "cached query", 5)
    second = research.search_literature("crossref", "cached query", 5)
    assert len(asked) == 1, "the second identical query never reaches the transport"
    assert first["providers"][0]["fromCache"] is False and second["providers"][0]["fromCache"] is True
    assert any("bounded cache" in warning for warning in second["warnings"])
    assert second["records"][0]["title"]["value"] == "Cached record"
    stored = next(iter(json.loads((shared_budget_dir / "cache-crossref.json").read_text(encoding="utf-8"))["entries"].values()))["fetchedAt"]
    assert second["records"][0]["title"]["provenance"]["fetchedAt"] == stored, "a cached answer keeps the time it was retrieved, not the time it was re-read"


def test_exhausted_retries_keep_the_existing_code_and_wording(shared_budget_dir: Path, injected_time: Clock,
                                                              monkeypatch: pytest.MonkeyPatch) -> None:
    """The new scheduler must not invent a code for a provider refusal it already names."""
    def response(url: str, _headers: dict[str, str] | None = None):
        raise research.ResearchError("PROVIDER_RATE_LIMITED",
                                     "Provider rate limit reached; the Toolkit's own bounded backoff applies, with any wait the provider named carried through.", retry_after="2")

    monkeypatch.setattr(research, "_request_json", response)
    with pytest.raises(research.ResearchError) as error:
        research.search_literature("crossref", "limited query", 5)
    assert error.value.code == "PROVIDER_RATE_LIMITED"
    assert error.value.retry_after == "2"
    assert error.value.as_dict()["message"] == "Provider rate limit reached; the Toolkit's own bounded backoff applies, with any wait the provider named carried through."


def test_a_shared_block_refuses_before_any_request_is_built(shared_budget_dir: Path, injected_time: Clock,
                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    """A new condition needs a new code: the Toolkit holding back because a sibling was refused."""
    monkeypatch.setattr(research, "_request_json", lambda *_args: pytest.fail("the budget must refuse before the transport is reached"))
    blocked = provider_budget.ProviderBudget("crossref", directory=shared_budget_dir,
                                             now_ms=injected_time.now_ms, sleep_ms=injected_time.sleep_ms)
    blocked.note_blocked(str(provider_budget.RETRY_AFTER_MAX_MS // 1000))
    with pytest.raises(research.ResearchError) as error:
        research.search_literature("crossref", "blocked query", 5)
    assert error.value.code == "PROVIDER_BUDGET_DEFERRED"
    assert int(error.value.retry_after) >= 20


def test_the_budget_constants_carry_the_confirmed_source_not_the_providers_allowance() -> None:
    """TBD-2 is answered (DD12-16): the numbers stay the Toolkit's own, and say where the limits came from."""
    source = (Path(__file__).resolve().parents[1] / "src/research_stack/provider_budget.py").read_text(encoding="utf-8")
    assert "TBD-2 is unanswered" not in source and "pending the provider's documented limits" not in source
    assert "https://www.semanticscholar.org/product/api" in source and "accessed 8 November 2026" in source
    assert "1000 requests per second shared among all unauthenticated users" in source
    assert "not an allowance this Toolkit owns" in source, "a global pool shared with every anonymous caller is not this Toolkit's budget"
    assert "1 RPS on all endpoints" in source and "not per" in source and "per provider" in source
    assert provider_budget.ANON_PERMITS < 100 and provider_budget.KEYED_PERMITS < 100, "no constant presents the shared pool as this Toolkit's rate"


def test_the_keyed_budget_stays_at_one_request_per_second_across_all_endpoints(budget_dir: Path) -> None:
    """A key buys 1 request per second per key across all endpoints, so the floor — not the window — enforces it."""
    clock = Clock()
    keyed = budget(budget_dir, clock, provider="semantic_scholar", keyed=True)
    assert [keyed.acquire()["waitedMs"] for _ in range(3)] == [0, provider_budget.MIN_SPACING_MS, provider_budget.MIN_SPACING_MS]
    assert clock.slept == [provider_budget.MIN_SPACING_MS, provider_budget.MIN_SPACING_MS]


def test_the_two_pacing_floors_are_one_floor() -> None:
    """research.py and provider_budget.py must not each wait a second for the same request."""
    assert provider_budget.MIN_SPACING_MS == int(research.MIN_REQUEST_INTERVAL_SECONDS * 1000)


def test_a_carried_retry_after_is_an_opportunity_not_an_expectation(budget_dir: Path) -> None:
    """DD12-17: the bounded backoff is the mechanism, and only a wait a provider actually carried is honoured."""
    source = (Path(__file__).resolve().parents[1] / "src/research_stack/provider_budget.py").read_text(encoding="utf-8")
    assert "opportunity, not an expectation" in source
    clock = Clock()
    assert budget(budget_dir, clock, provider="openalex").note_blocked(None) == 0, "no carried wait invents a block"
    assert budget(budget_dir, clock, provider="semantic_scholar").note_blocked("4") == clock.now + 4_000


def test_the_module_carries_no_forbidden_or_outbound_primitive() -> None:
    """The VSIX audit rule (scripts/verify_vsix.py:180-183), stated as a test.

    Byte ceiling: the work package asked for 7 000 bytes. The measured module is larger, because the
    required feature set (portable lock, atomic budget file, shared Retry-After, bounded retries,
    bounded cache and in-flight claims) does not fit in 7 000 bytes. The number below is the measured
    size plus headroom, so it cannot drift upward silently; the artifact ceiling itself is re-measured
    under DD12-09 by the coordinator.
    """
    source = Path(__file__).resolve().parents[1] / "src/research_stack/provider_budget.py"
    text = source.read_text(encoding="utf-8")
    for primitive in ("subprocess", "eval(", "exec(", "__import__(", "os.system", "os.popen", "pty", "multiprocessing",
                      "fcntl", "msvcrt", "urllib.request", "urlopen", "build_opener", "socket", "http.client"):
        assert primitive not in text, f"provider_budget.py must not contain {primitive}"
    # 17 600, raised from 17 000 (0.3.11 phase 13, defect P8). `CALL_CEILING_MS` claimed no attempt loop
    # outlives the caller's patience, but it only counted the pauses the loop slept: four 15-second requests
    # that each timed out ran to ~66 seconds against a 20-second promise, which is what killed the readiness
    # probe mid-check. The loop now measures wall-clock as well as waiting. That is four lines of arithmetic
    # in a module that ships twice, and the alternative — trimming the sentence that explains why the ceiling
    # is wall-clock — would remove the only place the reason is written down.
    assert len(source.read_bytes()) < 17_600, "the module ships twice and the artifact has a reviewed byte ceiling"
