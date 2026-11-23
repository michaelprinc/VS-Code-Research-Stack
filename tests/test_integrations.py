from __future__ import annotations

import io
import json
import re
import urllib.error
from pathlib import Path

import pytest

from research_stack import integrations, machinefacts, research
from research_stack.cli import main

SENTINEL_KEY = "SENTINEL-SEMANTIC-SCHOLAR-KEY-4f9a1c"
# https://www.zotero.org/support/dev/web_api/v3/local_api (8 November 2026), quoted, not paraphrased.
OFFICIAL_ZOTERO_SETTING = "Settings → Advanced → 'Allow other applications on this computer to communicate with Zotero'"


@pytest.fixture(autouse=True)
def machine_facts(tmp_path_factory: pytest.TempPathFactory, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Every probe here records its fact into its own directory, never the operator's per-user one."""
    directory = tmp_path_factory.mktemp("machine-facts")
    monkeypatch.setattr(machinefacts, "facts_path", lambda _env=None: directory / machinefacts.FACTS_FILE_NAME)
    return directory


ROOT_ANSWER = {"status": 200, "zotero-api-version": "3", "zotero-server-id": "fixture-server"}
HEAD_ANSWER = {"status": 200}
# A port that refuses or drops one path refuses or drops `/api/` too, and a Zotero whose local-API preference
# is off answers 403 at `/api/` as well. Those three mirror themselves unless a test says otherwise.
_MIRROR_ROOT = ("ZOTERO_NOT_AVAILABLE", "ZOTERO_NO_ANSWER", "ZOTERO_API_DISABLED")


def _zotero(monkeypatch: pytest.MonkeyPatch, *, installed: bool, receipt: dict[str, object] | None = None,
            error: research.ResearchError | None = None, ping: bool = False,
            root: dict[str, object] | research.ResearchError | None = None) -> None:
    """Patch the reused adapter, the connector ping and the installation detection, so no test opens a socket."""
    monkeypatch.setattr(integrations, "detect_zotero_installation", lambda: {"installed": installed, "evidence": "fixture"})
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: ping)
    if root is None and error is not None and error.code in _MIRROR_ROOT:
        root = error
    if isinstance(root, research.ResearchError):
        def root_refused(refused: research.ResearchError = root) -> dict[str, object]:
            raise refused

        monkeypatch.setattr(research, "zotero_local_api_root", root_refused)
        monkeypatch.setattr(research, "zotero_collections_head", lambda: pytest.fail("a stage that got no answer is never followed by a later stage"))
    else:
        monkeypatch.setattr(research, "zotero_local_api_root", lambda: root or ROOT_ANSWER)
        monkeypatch.setattr(research, "zotero_collections_head", lambda: HEAD_ANSWER)
    if error is not None:
        def failing() -> dict[str, object]:
            raise error

        monkeypatch.setattr(research, "list_zotero_collections", failing)
        return
    monkeypatch.setattr(research, "list_zotero_collections", lambda: receipt or {"collections": [], "serverId": "fixture-server", "readOnly": True})


def _semantic_scholar(monkeypatch: pytest.MonkeyPatch, *, receipt: dict[str, object] | None = None, error: research.ResearchError | None = None) -> None:
    if error is not None:
        def failing(*_args: object) -> dict[str, object]:
            raise error

        monkeypatch.setattr(research, "search_literature", failing)
        return
    monkeypatch.setattr(research, "search_literature", lambda *_args: receipt or {"records": [{"id": "doi:10.1234/probe"}]})


def test_probe_of_one_provider_returns_only_that_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "no answer"))
    monkeypatch.setattr(research, "search_literature", lambda *_args: pytest.fail("an unrequested provider must not be probed"))
    result = integrations.probe_integrations("zotero")
    assert result["probe"] == "integrations"
    assert result["providers"] == ["zotero"]
    assert "zotero" in result and "semanticScholar" not in result
    assert any("read-only" in warning and "credential" in warning for warning in result["warnings"])


def test_unknown_provider_is_refused_naming_the_accepted_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(research, "list_zotero_collections", lambda: pytest.fail("refusal must precede any request"))
    with pytest.raises(ValueError, match="semantic_scholar") as error:
        integrations.probe_integrations("zotero,crossref")
    assert "zotero" in str(error.value) and "crossref" in str(error.value)
    with pytest.raises(ValueError, match="at least one provider"):
        integrations.probe_integrations("  ")


def test_zotero_unavailable_is_not_running_when_installed_and_not_installed_otherwise(monkeypatch: pytest.MonkeyPatch) -> None:
    _zotero(monkeypatch, installed=True, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "no answer"))
    configured = integrations.probe_zotero()
    assert configured["outcome"] == "not-running" and configured["installed"] is True
    assert configured["code"] == "ZOTERO_NOT_AVAILABLE"

    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "no answer"))
    absent = integrations.probe_zotero()
    assert absent["outcome"] == "not-installed" and absent["installed"] is False
    assert absent["code"] == "ZOTERO_NOT_AVAILABLE"


def test_zotero_api_disabled_is_never_reported_as_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    """The 403 is the case an operator can fix in seconds, so it must not read as "not installed"."""
    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_API_DISABLED", "403"), ping=True)
    result = integrations.probe_zotero()
    assert result["outcome"] == "api-disabled" and result["code"] == "ZOTERO_API_DISABLED"
    assert result["installed"] is True  # a 403 on the Zotero port is an answer, so Zotero is there
    detail = result["detail"]
    assert "appears to be running" in detail and "refuses local clients" in detail
    assert integrations.ZOTERO_LOCAL_API_SETTING_TEXT in detail and "no workspace file was written" in detail
    # TBD-4 is answered: this release now states the wording the official page states.
    assert OFFICIAL_ZOTERO_SETTING in detail and "403 Forbidden" in detail


def test_the_confirmed_setting_wording_is_quoted_and_no_other_setting_is_invented() -> None:
    """The one setting the official page names is named, with its source and access date, and nothing else is."""
    source = (Path(__file__).resolve().parents[1] / "src/research_stack/integrations.py").read_text(encoding="utf-8")
    text = integrations.ZOTERO_LOCAL_API_SETTING_TEXT
    assert text.startswith("The local API must be enabled in Zotero's preferences (") and "403 Forbidden" in text
    assert OFFICIAL_ZOTERO_SETTING in text
    assert "https://www.zotero.org/support/dev/web_api/v3/local_api" in source and "8 November 2026" in source
    assert "TBD-4" not in source
    assert source.count("Settings →") == 1, "only the setting the official page names is offered to the operator"
    for invented in ("General", "Export", "Cite", "Sync", "Defaults", "Keys", "Data Directory"):
        assert invented not in source, f"{invented} is a Zotero setting this release has not verified"


def test_the_connector_ping_is_a_fallback_never_an_extra_request(monkeypatch: pytest.MonkeyPatch) -> None:
    """An answered local API settles the probe; a third request to the same port would be noise."""
    _zotero(monkeypatch, installed=True)
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: pytest.fail("the ping is a fallback: it is not owed when the local API answered"))
    monkeypatch.setattr(integrations, "detect_zotero_installation", lambda: pytest.fail("an answered local API is the evidence; no path check is owed"))
    assert integrations.probe_zotero()["outcome"] == "ready"


def test_an_answer_owes_no_ping_and_a_silence_owes_exactly_one(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 403 is itself an answer, so asking the ping after it proves nothing. A stage that answered nothing is the only case owed."""
    asked: list[str] = []
    refused = research.ResearchError("ZOTERO_API_DISABLED", "403", evidence="403 Forbidden Local API is not enabled")
    _zotero(monkeypatch, installed=False, root=refused, error=refused)
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: asked.append("connector/ping") or True)
    monkeypatch.setattr(integrations, "detect_zotero_installation", lambda: pytest.fail("the 403 answered, so no path check is owed"))
    result = integrations.probe_zotero()
    assert result["outcome"] == "api-disabled" and result["installed"] is True
    assert asked == [], "a refusal that answered is not followed by another request to the same port"

    silent = research.ResearchError("ZOTERO_NO_ANSWER", "dropped")
    _zotero(monkeypatch, installed=False, root=silent, error=silent, ping=True)
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: asked.append("connector/ping") or True)
    result = integrations.probe_zotero()
    assert asked == ["connector/ping"], "the ping is asked exactly when a stage got no answer"
    assert result["outcome"] == "unknown" and result["installed"] is True, "the ping answered, so a Zotero is running"
    assert "HTTP server is up" in result["detail"] and "documented root request produced no usable answer" in result["detail"], result["detail"]


def test_the_three_states_come_from_the_ping_not_from_a_guess(monkeypatch: pytest.MonkeyPatch) -> None:
    """One sentence used to cover "nothing answered"; the ping and the path check split it into states."""
    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_API_DISABLED", "403"), ping=True)
    refusing = integrations.probe_zotero()
    assert refusing["outcome"] == "api-disabled" and refusing["installed"] is True, "the 403 is the answer, and the setting is what it names"
    assert OFFICIAL_ZOTERO_SETTING in refusing["detail"]

    _zotero(monkeypatch, installed=True, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "refused"), ping=False)
    stopped = integrations.probe_zotero()
    assert stopped["outcome"] == "not-running" and stopped["installed"] is True

    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "refused"), ping=False)
    absent = integrations.probe_zotero()
    assert absent["outcome"] == "not-installed" and absent["installed"] is False

    details = [state["detail"] for state in (refusing, stopped, absent)]
    assert len(set(details)) == 3, details
    assert all("connector ping" in detail for detail in details[1:]), "both no-answer states say the ping was asked"


def test_a_refused_port_names_both_readings_and_never_a_missing_zotero(monkeypatch: pytest.MonkeyPatch) -> None:
    """Zotero opens 23119 late in startup, and starts no HTTP server at all when the port is already taken."""
    _zotero(monkeypatch, installed=True, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "refused"), ping=False)
    stopped = integrations.probe_zotero()["detail"]
    assert "late in its startup" in stopped and "already holds it" in stopped, stopped
    assert "not proof that Zotero is absent" in stopped, stopped
    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "refused"), ping=False)
    absent = integrations.probe_zotero()["detail"]
    assert "still starting answers nothing" in absent and "no evidence of Zotero was found" in absent, absent


def test_a_request_that_produced_no_answer_is_a_state_not_a_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    """Zotero 10 can drop a request without any response: the ping decides which state that silence leaves."""
    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_NO_ANSWER", "dropped"), ping=False)
    result = integrations.probe_zotero()
    assert result["outcome"] == "not-installed" and result["code"] == "ZOTERO_NO_ANSWER" and result["installed"] is False
    assert "connector ping" in result["detail"] and "no evidence of Zotero was found" in result["detail"], result["detail"]


def test_the_ping_reuses_the_loopback_only_client_and_the_hardened_request() -> None:
    """No new transport: the reviewed member keeps its two openers, its zero direct requests and its bounds."""
    source = (Path(__file__).resolve().parents[1] / "src/research_stack/research.py").read_text(encoding="utf-8")
    assert source.count("build_opener(") == 2, "the reviewed member keeps exactly two openers"
    assert source.count("urlopen(") == 0, "the reviewed member opens no direct request"
    assert 'ZOTERO_LOCAL_API = "http://127.0.0.1:23119/api"' in source, "Zotero binds IPv4 loopback only"
    assert 'ZOTERO_CONNECTOR_PING = "http://127.0.0.1:23119/connector/ping"' in source, "the ping is a sibling of /api, not a child of it"
    assert '"Zotero-Allowed-Request": "1"' in source, "Zotero 10 drops requests that look like browser requests"
    for name, bound in (("ZOTERO_ROOT_TIMEOUT_SECONDS", 5), ("ZOTERO_LISTING_TIMEOUT_SECONDS", 12), ("ZOTERO_PING_TIMEOUT_SECONDS", 3)):
        assert f"{name} = {bound}" in source, f"{name} is a reviewed bound, stated once and named at every call"
    api = source.split("def _zotero_request", 1)[1].split("def zotero_local_api_root", 1)[0]
    assert "ProxyHandler({})" in api and "_NoRedirectHandler()" in api
    assert "timeout=timeout" in api, "the one client waits the bound its caller states, and never a bound of its own"
    head = source.split("def zotero_collections_head", 1)[1].split("def zotero_connector_ping", 1)[0]
    assert 'method="HEAD"' in head and "build_opener" not in head and "urlopen" not in head, "the path check is a path through the same client"
    ping = source.split("def zotero_connector_ping", 1)[1]
    assert "_zotero_request(ZOTERO_CONNECTOR_PING" in ping, "the ping is a path through the same client"
    assert "build_opener" not in ping and "urlopen" not in ping
    assert "ZOTERO_PING_TIMEOUT_SECONDS" in ping, "the ping names the reviewed bound instead of inventing one"


def test_zotero_answered_badly_is_unknown_never_unreachable_and_keeps_its_code(monkeypatch: pytest.MonkeyPatch) -> None:
    """An answer this release cannot classify is `unknown`: it reached Zotero and learned nothing."""
    for code in ("ZOTERO_NOT_FOUND", "ZOTERO_REQUEST_FAILED", "ZOTERO_SCHEMA_UNEXPECTED", "ZOTERO_RESPONSE_TOO_LARGE",
                 "ZOTERO_REQUEST_REJECTED", "ZOTERO_REQUEST_NOT_ALLOWED", "ZOTERO_API_VERSION_UNSUPPORTED"):
        _zotero(monkeypatch, installed=False, error=research.ResearchError(code, "answered badly"))
        result = integrations.probe_zotero()
        assert result["outcome"] == "unknown" and result["code"] == code
        assert result["installed"] is True  # the answer itself is the installation evidence
        assert "which state applies is unknown" in result["detail"]


def _zotero_states(monkeypatch: pytest.MonkeyPatch) -> dict[str, dict[str, object]]:
    """The four Zotero situations 0.3.11 collapsed into one answer, each read from its own probe call."""
    cases = {"ready": (False, None),
             "not-running": (True, research.ResearchError("ZOTERO_NOT_AVAILABLE", "connection refused")),
             "api-disabled": (False, research.ResearchError("ZOTERO_API_DISABLED", "403")),
             "not-installed": (False, research.ResearchError("ZOTERO_NOT_AVAILABLE", "connection refused"))}
    states: dict[str, dict[str, object]] = {}
    for name, (installed, error) in cases.items():
        _zotero(monkeypatch, installed=installed, error=error)
        states[name] = integrations.probe_zotero()
    return states


def test_the_local_api_is_asked_first_and_its_answer_is_the_installation_evidence(monkeypatch: pytest.MonkeyPatch) -> None:
    """An answered local API settles installation, so no documented path is consulted at all."""
    _zotero(monkeypatch, installed=True)
    monkeypatch.setattr(integrations, "detect_zotero_installation", lambda: pytest.fail("an answered local API is the evidence; no path check is owed"))
    result = integrations.probe_zotero()
    assert result["outcome"] == "ready" and result["installed"] is True and result["serverId"] == "fixture-server"
    assert "local API" in result["detail"]


def test_the_four_zotero_situations_carry_four_different_sentences(monkeypatch: pytest.MonkeyPatch) -> None:
    """Collapsing these four into one answer is the defect this change fixes."""
    states = _zotero_states(monkeypatch)
    assert {name: state["outcome"] for name, state in states.items()} == {
        "ready": "ready", "not-running": "not-running", "api-disabled": "api-disabled", "not-installed": "not-installed"}
    details = [state["detail"] for state in states.values()]
    assert len(set(details)) == 4, details


def test_not_running_never_claims_that_zotero_is_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    """`not-running` and `not-installed` differ in what they say about the machine, not only in their label."""
    states = _zotero_states(monkeypatch)
    running, absent = states["not-running"]["detail"], states["not-installed"]["detail"]
    assert states["not-running"]["installed"] is True and states["not-installed"]["installed"] is False
    assert "no Zotero" not in running and "not installed" not in running.lower()
    assert "no Zotero" in absent and "not installed" not in absent.lower()


def test_the_five_zotero_outcomes_are_words_the_host_can_read(monkeypatch: pytest.MonkeyPatch) -> None:
    """`extension/integrationprobe.js` declares the outcome words a probe receipt may carry."""
    source = (Path(__file__).resolve().parents[1] / "extension/integrationprobe.js").read_text(encoding="utf-8")
    declared = set(re.findall(r'"([a-z-]+)"', source.split("const OUTCOMES = [", 1)[1].split("]", 1)[0]))
    produced = {state["outcome"] for state in _zotero_states(monkeypatch).values()}
    _zotero(monkeypatch, installed=True, error=research.ResearchError("ZOTERO_SCHEMA_UNEXPECTED", "malformed"))
    produced.add(integrations.probe_zotero()["outcome"])
    _zotero(monkeypatch, installed=True, error=research.ResearchError("ZOTERO_NO_ANSWER", "dropped"))
    produced.add(integrations.probe_zotero()["outcome"])
    assert produced <= declared, f"outcomes the host cannot read: {sorted(produced - declared)}"


def test_no_zotero_outcome_opens_a_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`Path.open` is the door a library file would come through; with it refused, every outcome still arrives."""
    library = tmp_path / "zotero.sqlite"
    library.write_text("library bytes", encoding="utf-8")
    (tmp_path / "zotero").write_text("stat-ed only, never opened", encoding="utf-8")
    monkeypatch.setattr(Path, "open", lambda *_args, **_kwargs: pytest.fail("the readiness probe must not open a file"))
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: False)
    monkeypatch.setattr(integrations.shutil, "which", lambda _name: str(tmp_path / "zotero"))
    for error in (None, research.ResearchError("ZOTERO_NOT_AVAILABLE", "refused"), research.ResearchError("ZOTERO_API_DISABLED", "403")):
        _zotero(monkeypatch, installed=True, error=error)
        assert integrations.probe_zotero()["outcome"] in {"ready", "not-running", "api-disabled"}
    assert open(library, encoding="utf-8").read() == "library bytes"


def test_zotero_ready_carries_the_server_id_and_states_that_nothing_was_written(monkeypatch: pytest.MonkeyPatch) -> None:
    _zotero(monkeypatch, installed=True, receipt={"collections": [{"key": "ABCD1234"}], "serverId": "fixture-server", "readOnly": True})
    result = integrations.probe_zotero()
    assert result["outcome"] == "ready" and result["code"] is None
    assert result["serverId"] == "fixture-server"
    assert "read-only collection listing succeeded" in result["detail"]
    assert "No library file was opened" in result["detail"] and "no configuration changed" in result["detail"]


def _answered_error(code: str, http_code: int, reason: str, body: bytes) -> research.ResearchError:
    """A refusal shaped the way `research.py` raises one: its own code over what the server actually said."""
    answer = urllib.error.HTTPError("http://127.0.0.1:23119/api", http_code, reason, {}, io.BytesIO(body))
    return research.ResearchError(code, "the adapter's own sentence", evidence=research._zotero_said(answer))


def _dropped_error(code: str, cause: Exception) -> research.ResearchError:
    """The same shape for a failure with no HTTP answer behind it."""
    return research.ResearchError(code, "the adapter's own sentence", evidence=research._zotero_said(cause))


def test_the_documented_root_is_asked_before_the_collection_listing(monkeypatch: pytest.MonkeyPatch) -> None:
    """Root, then the path check, then the listing — and no fourth request once all three answered."""
    asked: list[str] = []
    monkeypatch.setattr(research, "zotero_local_api_root", lambda: asked.append("root") or ROOT_ANSWER)
    monkeypatch.setattr(research, "zotero_collections_head", lambda: asked.append("head") or HEAD_ANSWER)
    monkeypatch.setattr(research, "list_zotero_collections", lambda: asked.append("listing") or {"collections": [], "serverId": "fixture-server", "readOnly": True})
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: pytest.fail("an answered root, path check and listing owe no fourth request"))
    assert integrations.probe_zotero()["outcome"] == "ready"
    assert asked == ["root", "head", "listing"], "cheap stages first, and the ping stays a fallback"


def test_the_listing_is_the_only_stage_asked_twice_and_only_after_it_answered_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """The first listing pays for the library to load; the second is the cheap question, and it is the only repeat."""
    asked: list[str] = []
    attempts = {"listing": 0}

    def slow_then_answer() -> dict[str, object]:
        attempts["listing"] += 1
        if attempts["listing"] == 1:
            raise research.ResearchError("ZOTERO_NO_ANSWER", "no answer within 12 seconds", evidence="TimeoutError ")
        return {"collections": [{"key": "ABCD1234"}], "serverId": "fixture-server", "readOnly": True}

    monkeypatch.setattr(research, "zotero_local_api_root", lambda: asked.append("root") or ROOT_ANSWER)
    monkeypatch.setattr(research, "zotero_collections_head", lambda: asked.append("head") or HEAD_ANSWER)
    monkeypatch.setattr(research, "list_zotero_collections", lambda: asked.append("listing") or slow_then_answer())
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: pytest.fail("a listing that answered owes no ping"))
    result = integrations.probe_zotero()
    assert asked == ["root", "head", "listing", "listing"], "one retry of the listing, and nothing else repeated"
    assert result["outcome"] == "ready" and result["code"] is None
    assert "first attempt got no answer within 12 seconds and the second answered" in result["detail"], result["detail"]
    assert "library that was still loading" in result["detail"], "the operator is told what the timeout meant"


def test_a_listing_that_answers_nothing_twice_is_reported_without_spending_more_time(monkeypatch: pytest.MonkeyPatch) -> None:
    """The probe degrades instead of running on: after the retry it answers at once, and spends nothing further."""
    asked: list[str] = []
    silent = research.ResearchError("ZOTERO_NO_ANSWER", "no answer within 12 seconds", evidence="TimeoutError ")

    def failing() -> dict[str, object]:
        asked.append("listing")
        raise silent

    monkeypatch.setattr(research, "zotero_local_api_root", lambda: asked.append("root") or ROOT_ANSWER)
    monkeypatch.setattr(research, "zotero_collections_head", lambda: asked.append("head") or HEAD_ANSWER)
    monkeypatch.setattr(research, "list_zotero_collections", failing)
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: pytest.fail("the listing already settled this probe"))
    monkeypatch.setattr(integrations, "detect_zotero_installation", lambda: pytest.fail("the root answered, so no path check is owed"))
    result = integrations.probe_zotero()
    assert asked == ["root", "head", "listing", "listing"], "exactly one retry, then the receipt"
    assert result["outcome"] == "unknown" and result["code"] == "ZOTERO_NO_ANSWER" and result["installed"] is True
    detail = result["detail"]
    assert "collection listing produced no usable answer within 12 seconds" in detail, detail
    assert "asked a second time and produced none either" in detail and "library has finished loading" in detail, detail
    assert "root 200" in (result["evidence"] or ""), "the receipt still says the local API itself answered"


def test_the_stages_add_up_to_the_worst_case_the_probe_promises() -> None:
    """The host kills the probe process on a clock; the sum of the stage bounds is what that clock must clear."""
    worst_case = 2 * research.ZOTERO_ROOT_TIMEOUT_SECONDS + 2 * research.ZOTERO_LISTING_TIMEOUT_SECONDS
    assert worst_case == 34, "root, path check, listing and its one retry: the number the host's bound is set against"
    source = (Path(__file__).resolve().parents[1] / "src/research_stack/integrations.py").read_text(encoding="utf-8")
    assert "34 seconds" in source, "the probe states its own worst case where the host can check it"
    assert "never asked after the listing has been retried" in source, "the probe degrades instead of spending the rest of the budget"


def test_a_401_is_authentication_required_and_is_never_a_missing_credential(monkeypatch: pytest.MonkeyPatch) -> None:
    """The official page says a read needs no authentication, so a 401 is named without inventing a key flow."""
    refused = _answered_error("ZOTERO_AUTH_REQUIRED", 401, "Unauthorized", b"WWW-Authenticate: Zotero-API-Key")
    _zotero(monkeypatch, installed=False, root=refused, error=refused)
    result = integrations.probe_zotero()
    assert result["outcome"] == "auth-required" and result["code"] == "ZOTERO_AUTH_REQUIRED"
    assert result["installed"] is True, "a 401 is an answer on the Zotero port, so Zotero is there"
    detail = result["detail"]
    assert "401" in detail and "no authentication" in detail and "not a missing credential" in detail, detail
    assert "401" in (result["evidence"] or ""), "the receipt carries the status the port actually returned"


def test_the_root_answering_and_the_listing_refused_is_never_reported_as_absent(monkeypatch: pytest.MonkeyPatch) -> None:
    """A 404 after an answered root means this request was not accepted, not that Zotero is missing."""
    _zotero(monkeypatch, installed=False, error=_answered_error("ZOTERO_NOT_FOUND", 404, "Not Found", b"<html><body>Not Found</body></html>"))
    result = integrations.probe_zotero()
    assert result["outcome"] == "unknown" and result["code"] == "ZOTERO_NOT_FOUND" and result["installed"] is True
    detail = result["detail"]
    assert "answered at /api/" in detail and "did not recognise this request" in detail, detail
    assert "not installed" not in detail.lower() and "is absent" not in detail.lower(), detail
    assert "404" in result["evidence"] and "Not Found" in result["evidence"], result["evidence"]
    assert "root 200" in result["evidence"] and "fixture-server" in result["evidence"], "the root's own headers travel too"


def test_a_403_after_an_answered_root_is_not_reported_as_the_preference_being_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """The root already said the local API is enabled, so sending the operator to that setting would be wrong."""
    _zotero(monkeypatch, installed=False, root=ROOT_ANSWER, error=research.ResearchError("ZOTERO_API_DISABLED", "403", evidence="403 Forbidden"))
    result = integrations.probe_zotero()
    assert result["outcome"] == "unknown" and result["code"] == "ZOTERO_API_DISABLED" and result["installed"] is True
    detail = result["detail"]
    assert "answered at /api/" in detail and "a later request was refused with 403" in detail, detail
    assert OFFICIAL_ZOTERO_SETTING not in detail, "the setting is not the fact this evidence supports"


def test_a_connection_closed_without_an_answer_is_a_state_the_receipt_names(monkeypatch: pytest.MonkeyPatch) -> None:
    """Measured defect: this crash used to destroy the whole check instead of being reported."""
    closed = _dropped_error("ZOTERO_NO_ANSWER", ConnectionResetError(104, "Connection reset by peer"))
    _zotero(monkeypatch, installed=False, root=closed, error=closed, ping=True)
    result = integrations.probe_zotero()
    assert result["outcome"] == "unknown" and result["code"] == "ZOTERO_NO_ANSWER" and result["installed"] is True
    assert "no usable answer" in result["detail"] and "which state applies is unknown" in result["detail"]
    assert "ConnectionResetError" in (result["evidence"] or ""), "the receipt says what the port did"


def test_an_answer_that_is_not_the_local_api_json_says_what_arrived(monkeypatch: pytest.MonkeyPatch) -> None:
    """The classification stays honest, and the sentence now names the answer instead of shrugging."""
    wrong = _dropped_error("ZOTERO_SCHEMA_UNEXPECTED", json.JSONDecodeError("Expecting value", "<html><body>Zotero</body></html>", 0))
    _zotero(monkeypatch, installed=True, error=wrong)
    result = integrations.probe_zotero()
    assert result["outcome"] == "unknown" and result["code"] == "ZOTERO_SCHEMA_UNEXPECTED"
    assert "not the JSON the local API returns" in result["detail"], result["detail"]


def test_an_empty_library_is_ready_and_the_receipt_says_so(monkeypatch: pytest.MonkeyPatch) -> None:
    """An empty library is a working library: the operator is told that, not left to infer it."""
    _zotero(monkeypatch, installed=True, receipt={"collections": [], "serverId": "fixture-server", "readOnly": True})
    result = integrations.probe_zotero()
    assert result["outcome"] == "ready" and result["code"] is None and result["installed"] is True
    assert "working empty library" in result["detail"] and "not a failure" in result["detail"], result["detail"]


def test_the_servers_own_words_reach_the_receipt_clipped_and_scrubbed(monkeypatch: pytest.MonkeyPatch) -> None:
    """What the port said is worth carrying, but never a whole answer, a key-shaped run or a file path."""
    body = rb"see C:\Users\operator\Zotero\zotero.sqlite and the key a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6 now"
    _zotero(monkeypatch, installed=True, error=_answered_error("ZOTERO_REQUEST_FAILED", 500, "Server Error", body))
    evidence = integrations.probe_zotero()["evidence"] or ""
    assert len(evidence) <= 160, f"the receipt carries a short line, not the server's whole answer: {evidence!r}"
    assert "zotero.sqlite" not in evidence and "Users" not in evidence, evidence
    assert "a1b2c3d4" not in evidence, evidence
    assert "500" in evidence and "Server Error" in evidence, evidence


def test_a_probe_that_crashes_still_leaves_a_complete_two_provider_receipt(monkeypatch: pytest.MonkeyPatch) -> None:
    """Measured defect: one provider's crash destroyed the whole receipt, so the other was never checked."""
    def broken() -> dict[str, object]:
        raise RuntimeError("the Zotero probe itself broke")

    monkeypatch.setattr(integrations, "probe_zotero", broken)
    _semantic_scholar(monkeypatch, receipt={"records": [{"id": "doi:10.1234/probe"}]})
    result = integrations.probe_integrations("zotero, semantic_scholar")
    assert result["providers"] == ["zotero", "semantic_scholar"]
    assert result["zotero"]["outcome"] == "unknown" and result["zotero"]["code"] == "PROBE_ZOTERO_FAILED"
    assert "RuntimeError" in result["zotero"]["detail"], result["zotero"]["detail"]
    assert result["semanticScholar"]["outcome"] == "ready", "the other provider is still checked"


def test_a_crashed_probe_still_exits_zero_and_prints_both_receipts(monkeypatch: pytest.MonkeyPatch,
                                                                    capsys: pytest.CaptureFixture[str]) -> None:
    """A readiness check that crashes must not leave the host reporting "The integration check failed"."""
    def broken() -> dict[str, object]:
        raise RuntimeError("the Semantic Scholar probe itself broke")

    monkeypatch.setattr(integrations, "probe_semantic_scholar", broken)
    _zotero(monkeypatch, installed=True, receipt={"collections": [{"key": "ABCD1234"}], "serverId": "fixture-server", "readOnly": True})
    assert main(["probe-integrations", "--providers", "zotero,semantic_scholar"]) == 0, "a readiness check never exits non-zero"
    printed = json.loads(capsys.readouterr().out)
    assert printed["zotero"]["outcome"] == "ready" and printed["semanticScholar"]["code"] == "PROBE_SEMANTIC_SCHOLAR_FAILED"


def test_semantic_scholar_rate_limit_is_degraded_and_carries_retry_after(monkeypatch: pytest.MonkeyPatch) -> None:
    _semantic_scholar(monkeypatch, error=research.ResearchError("PROVIDER_RATE_LIMITED", "429", retry_after="30"))
    result = integrations.probe_semantic_scholar()
    assert result["outcome"] == "rate-limited" and result["code"] == "PROVIDER_RATE_LIMITED"
    assert result["retryAfter"] == "30"
    assert "no full text" in result["detail"]


def test_semantic_scholar_licence_gate_is_auth_required_naming_the_missing_step(monkeypatch: pytest.MonkeyPatch) -> None:
    _semantic_scholar(monkeypatch, error=research.ResearchError("PROVIDER_TERMS_NOT_ACKNOWLEDGED", "licence gate"))
    result = integrations.probe_semantic_scholar()
    assert result["outcome"] == "auth-required" and result["code"] == "PROVIDER_TERMS_NOT_ACKNOWLEDGED"
    assert "licence" in result["detail"]

    _semantic_scholar(monkeypatch, error=research.ResearchError("PROVIDER_AUTH_REQUIRED", "401"))
    assert integrations.probe_semantic_scholar()["outcome"] == "auth-required"
    _semantic_scholar(monkeypatch, error=research.ResearchError("PROVIDER_UNAVAILABLE", "no answer"))
    assert integrations.probe_semantic_scholar()["outcome"] == "unreachable"
    _semantic_scholar(monkeypatch, error=research.ResearchError("QUERY_TOO_LONG", "unexpected shape"))
    unexpected = integrations.probe_semantic_scholar()
    assert unexpected["outcome"] == "unreachable" and unexpected["code"] == "QUERY_TOO_LONG"


def test_semantic_scholar_answering_with_no_record_is_ready_not_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    _semantic_scholar(monkeypatch, receipt={"records": []})
    result = integrations.probe_semantic_scholar()
    assert result["outcome"] == "ready" and result["code"] is None
    assert "not a failure" in result["detail"]


def test_credentials_are_reported_as_booleans_and_never_as_values(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SEMANTIC_SCHOLAR_API_KEY", SENTINEL_KEY)
    monkeypatch.setenv("SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED", "true")
    _semantic_scholar(monkeypatch, receipt={"records": []})
    result = integrations.probe_integrations("semantic_scholar")
    gates = result["semanticScholar"]
    assert gates["credentialConfigured"] is True and gates["licenseAcknowledged"] is True
    assert isinstance(gates["credentialConfigured"], bool) and isinstance(gates["licenseAcknowledged"], bool)
    assert SENTINEL_KEY not in json.dumps(result)

    monkeypatch.delenv("SEMANTIC_SCHOLAR_API_KEY", raising=False)
    monkeypatch.delenv("SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED", raising=False)
    unconfigured = integrations.probe_semantic_scholar()
    assert unconfigured["credentialConfigured"] is False and unconfigured["licenseAcknowledged"] is False
    assert SENTINEL_KEY not in json.dumps(unconfigured)


def test_one_unavailable_provider_never_fails_the_other_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    _zotero(monkeypatch, installed=True, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "no answer"))
    _semantic_scholar(monkeypatch, error=research.ResearchError("PROVIDER_UNAVAILABLE", "no answer"))
    result = integrations.probe_integrations("zotero, semantic_scholar")
    assert result["providers"] == ["zotero", "semantic_scholar"]
    assert result["zotero"]["outcome"] == "not-running" and result["semanticScholar"]["outcome"] == "unreachable"


def test_installation_detection_reports_only_what_it_found(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The Windows candidates come from the two documented base folders; a path is stat-ed, never run."""
    monkeypatch.setattr(integrations.platform, "system", lambda: "Windows")
    monkeypatch.setattr(integrations.shutil, "which", lambda _name: None)
    program_files = tmp_path / "Program Files"
    installed_at = program_files / "Zotero" / "zotero.exe"
    installed_at.parent.mkdir(parents=True)
    installed_at.write_text("stat-ed only, never executed", encoding="utf-8")
    monkeypatch.setenv("PROGRAMFILES", str(program_files))
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "AppData"))
    detected = integrations.detect_zotero_installation()
    assert detected["installed"] is True and str(installed_at) in detected["evidence"]

    installed_at.unlink()
    absent = integrations.detect_zotero_installation()
    assert absent["installed"] is False and "no Zotero installation" in absent["evidence"]


def test_the_probe_writes_nothing_in_the_workspace(tmp_path: Path, machine_facts: Path,
                                                  monkeypatch: pytest.MonkeyPatch) -> None:
    """INT-15.1: the workspace stays untouched; the one thing a probe writes is the machine-level fact."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "note.md").write_text("untouched", encoding="utf-8")
    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "no answer"))
    _semantic_scholar(monkeypatch, error=research.ResearchError("PROVIDER_UNAVAILABLE", "no answer"))
    integrations.probe_integrations("zotero,semantic_scholar")
    assert [path.name for path in tmp_path.iterdir()] == ["note.md"]
    assert (tmp_path / "note.md").read_text(encoding="utf-8") == "untouched"
    assert [path.name for path in machine_facts.iterdir()] == [machinefacts.FACTS_FILE_NAME], \
        "the probe's one write is the machine-level fact, outside the workspace"
    assert json.loads((machine_facts / machinefacts.FACTS_FILE_NAME).read_text(encoding="utf-8"))["facts"]["zotero"]["classification"] == "not-installed"


def test_cli_probe_integrations_round_trips_and_refuses_a_bad_provider(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "no answer"))
    assert main(["probe-integrations", "--providers", "zotero"]) == 0
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["probe"] == "integrations" and receipt["zotero"]["outcome"] == "not-installed"

    assert main(["probe-integrations", "--providers", "crossref"]) == 2
    assert "accepted providers" in capsys.readouterr().err


def test_each_zotero_state_records_the_classification_it_reached(monkeypatch: pytest.MonkeyPatch,
                                                                  machine_facts: Path) -> None:
    """INT-15.1: what a later profile reuses is the classification this probe actually reached."""
    recorded: list[str] = []
    for name, (installed, error) in (("ready", (False, None)),
                                     ("not-running", (True, research.ResearchError("ZOTERO_NOT_AVAILABLE", "connection refused"))),
                                     ("api-disabled", (False, research.ResearchError("ZOTERO_API_DISABLED", "403"))),
                                     ("not-installed", (False, research.ResearchError("ZOTERO_NOT_AVAILABLE", "connection refused")))):
        _zotero(monkeypatch, installed=installed, error=error)
        result = integrations.probe_zotero()
        fact = machinefacts.read_facts()["facts"]["zotero"]
        assert fact["classification"] == result["outcome"] == name
        assert fact["found"] is result["installed"] and fact["code"] == result["code"]
        assert isinstance(fact["detectedAtMs"], int) and fact["detectedAtMs"] > 0, "a fact carries the moment it was measured at"
        assert fact["platform"], "a fact says which platform it was measured on"
        recorded.append(fact["classification"])
    assert recorded == ["ready", "not-running", "api-disabled", "not-installed"]


def test_a_refused_fact_write_leaves_the_probe_answer_untouched(monkeypatch: pytest.MonkeyPatch,
                                                                 machine_facts: Path) -> None:
    """DD12-02: a fact the file will not take must not turn a good readiness check into a failed one."""
    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_API_DISABLED", "403"), ping=True)
    first = integrations.probe_zotero()
    stored = (machine_facts / machinefacts.FACTS_FILE_NAME).read_bytes()
    monkeypatch.setattr(machinefacts, "write_fact", lambda *_args, **_kwargs: {
        "written": False, "code": "FACTS_TOO_LARGE",
        "rule": "the file would pass the Toolkit's own size bound; the write is refused, not truncated"})
    again = integrations.probe_zotero()
    assert again == first and again["outcome"] == "api-disabled", "the probe answers the same question the same way"
    assert (machine_facts / machinefacts.FACTS_FILE_NAME).read_bytes() == stored, \
        "a refused write left the recorded facts exactly as they were"


def test_semantic_scholar_is_never_recorded_as_an_installation(monkeypatch: pytest.MonkeyPatch,
                                                                machine_facts: Path) -> None:
    """A hosted endpoint has no installation on this machine, so nothing lands in the installation section.

    0.3.15 changed what this case asserts, and why: the probe now also records what the operator decided and
    whether the service was ever reached, in the decision section of the same file. "No file at all" was only
    ever a stand-in for "no installation fact", and the stand-in would now hide the fact the fix adds. The
    assertion is made on the section that matters, in the file that now legitimately exists.
    """
    _semantic_scholar(monkeypatch, receipt={"records": []})
    assert integrations.probe_semantic_scholar()["outcome"] == "ready"
    integrations.probe_integrations("semantic_scholar")
    document = json.loads((machine_facts / machinefacts.FACTS_FILE_NAME).read_text(encoding="utf-8"))
    assert document["facts"] == {} and "semantic_scholar" not in document["facts"], "a hosted endpoint gains no installation fact"
    assert machinefacts.read_provider_state()["semantic_scholar"]["lastSuccessfulCheckAt"], \
        "what the probe reached is recorded as a fact about this machine, not only as a receipt that disappears"


# --- 0.3.15: consent is a fact on this machine, and readiness says what it is like in practice ----------
# Field evidence 21/22 November 2026: the operator had consented in the panel, a hand-run check said
# `PROVIDER_TERMS_NOT_ACKNOWLEDGED`, and the 21 November conclusion drawn from it had to be corrected the
# next day. The switch lives only in the process the extension launched; the consent lives in the profile.

CARRIED_AT = "2026-11-21T13:08:00+00:00"
CARRIED_CHECK = "2026-11-21T13:20:00+00:00"


def _consented(machinefacts_dir_env: object = None, **overrides) -> None:
    """Seed the machine-level decision record the way the extension would have left it."""
    values: dict[str, object] = {"mode": "anonymous", "updated_at_ms": 1_762_000_000_000,
                                 "license_acknowledged_at": CARRIED_AT, "key_decision": "declined"}
    values.update(overrides)
    assert machinefacts.write_state("semantic_scholar", **values)["written"] is True


def _env(monkeypatch: pytest.MonkeyPatch, *, switch: bool, key: bool = False,
         instant: str | None = None, decision: str | None = None) -> None:
    for name in (integrations.LICENSE_ENV, integrations.API_KEY_ENV, integrations.LICENSE_INSTANT_ENV,
                 integrations.KEY_DECISION_ENV):
        monkeypatch.delenv(name, raising=False)
    if switch:
        monkeypatch.setenv(integrations.LICENSE_ENV, "true")
    if key:
        monkeypatch.setenv(integrations.API_KEY_ENV, SENTINEL_KEY)
    if instant:
        monkeypatch.setenv(integrations.LICENSE_INSTANT_ENV, instant)
    if decision:
        monkeypatch.setenv(integrations.KEY_DECISION_ENV, decision)


def test_a_consent_recorded_on_this_machine_is_not_reported_as_a_missing_consent(monkeypatch: pytest.MonkeyPatch) -> None:
    """The correction of 22 November 2026, as a state the receipt has to carry.

    Same refusal from the same gate, two different situations. With a stored consent the answer names the
    record and the path that carries it; it does not send the operator back to a confirmation they gave.
    """
    _env(monkeypatch, switch=False)
    _consented()
    _semantic_scholar(monkeypatch, error=research.ResearchError(
        "PROVIDER_TERMS_NOT_ACKNOWLEDGED", "Semantic Scholar is disabled until the current API license is reviewed and this process explicitly opts in."))
    result = integrations.probe_semantic_scholar()
    assert result["code"] == "PROVIDER_TERMS_STORED_BUT_NOT_INJECTED"
    assert result["termsState"] == "PROVIDER_TERMS_STORED_BUT_NOT_INJECTED"
    assert result["accessState"] == "consent-stored-not-injected"
    assert result["outcome"] == "auth-required", "the host's vocabulary is unchanged; the precision is in the named state"
    assert "recorded on this machine" in result["detail"] and "not given that confirmation" in result["detail"]
    assert "Nothing needs to be confirmed again" in result["detail"]
    assert not re.search(r"read both agreements|acknowledgement of the Semantic Scholar API licence", str(result["detail"]))
    assert result["providerState"]["licenseAcknowledgedAt"] == CARRIED_AT, "the stored consent travels into the receipt"


def test_no_consent_recorded_says_awaiting_consent_and_writes_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    """The gate stays deliberate: an absent switch is reported as it is, and no consent is recorded for the operator."""
    _env(monkeypatch, switch=False)
    _semantic_scholar(monkeypatch, error=research.ResearchError("PROVIDER_TERMS_NOT_ACKNOWLEDGED", "licence gate"))
    result = integrations.probe_semantic_scholar()
    assert result["termsState"] == "PROVIDER_TERMS_NOT_ACKNOWLEDGED" == result["code"]
    assert result["accessState"] == "awaiting-consent"
    assert "API licence" in result["detail"], "the missing step is still named, because it really is missing here"
    assert machinefacts.read_provider_state() == {}, "the Toolkit never records a consent on the operator's behalf"


def test_the_consent_the_extension_carries_becomes_a_machine_fact(monkeypatch: pytest.MonkeyPatch) -> None:
    """TASK P-2: the authorisation the extension performs is what turns a stored consent into a fact."""
    _env(monkeypatch, switch=True, instant=CARRIED_AT, decision="declined")
    _semantic_scholar(monkeypatch, receipt={"records": []})
    assert integrations.probe_semantic_scholar()["termsState"] == "PROVIDER_TERMS_ACKNOWLEDGED"
    state = machinefacts.read_provider_state()["semantic_scholar"]
    assert state["licenseAcknowledgedAt"] == CARRIED_AT and state["keyDecision"] == "declined"
    assert state["mode"] == "anonymous" and state["updatedAtMs"] > 0
    assert state["lastSuccessfulCheckAt"], "the check that reached the provider is what makes it a readiness fact"


def test_a_switch_alone_is_named_as_a_switch_and_records_no_instant(monkeypatch: pytest.MonkeyPatch) -> None:
    """A variable is not proof of permitted use, so a switch with no carried consent states exactly that."""
    _env(monkeypatch, switch=True)
    _semantic_scholar(monkeypatch, receipt={"records": []})
    result = integrations.probe_semantic_scholar()
    assert result["termsState"] == "PROVIDER_TERMS_ACKNOWLEDGED_BY_SWITCH_ONLY"
    assert machinefacts.read_provider_state()["semantic_scholar"]["licenseAcknowledgedAt"] is None, \
        "no consent instant is invented for a switch this process cannot account for"


def test_authorised_anonymous_and_never_reached_is_reported_as_such(monkeypatch: pytest.MonkeyPatch) -> None:
    """TASK P-3: 'rate-limited' alone hides the operator's actual position on 22 November 2026.

    Measured position: consent given, mode anonymous, key declined, HTTP 429 repeated, and no check had ever
    reached the provider. The outcome word stays in the host's vocabulary; the named state says what the
    operator is actually looking at.
    """
    _env(monkeypatch, switch=True)
    _consented(key_decision="declined")
    _semantic_scholar(monkeypatch, error=research.ResearchError("PROVIDER_RATE_LIMITED", "429", retry_after="31 seconds"))
    result = integrations.probe_semantic_scholar()
    assert result["outcome"] == "rate-limited" and result["retryAfter"] == "31 seconds"
    assert result["accessState"] == "consented-but-unusable"
    assert result["providerState"] == {"mode": "anonymous", "keyDecision": "declined",
                                       "licenseAcknowledgedAt": CARRIED_AT, "lastSuccessfulCheckAt": None}
    assert "no key was taken" in result["detail"] and "Your confirmation stands unchanged" in result["detail"]


def test_a_pause_after_a_check_that_reached_the_provider_stays_a_pause(monkeypatch: pytest.MonkeyPatch) -> None:
    """The same 429 with a successful check behind it is not the same situation, and does not read as one."""
    _env(monkeypatch, switch=True)
    _consented(key_decision="provided", last_successful_check_at=CARRIED_CHECK)
    _semantic_scholar(monkeypatch, error=research.ResearchError("PROVIDER_RATE_LIMITED", "429", retry_after="31 seconds"))
    result = integrations.probe_semantic_scholar()
    assert result["accessState"] == "rate-limited"
    assert "no key was taken" not in result["detail"], "a pause is not turned into a verdict about the operator's choices"
    assert result["providerState"]["lastSuccessfulCheckAt"] == CARRIED_CHECK


def test_the_two_gate_states_and_the_practical_state_are_always_from_the_named_vocabulary(monkeypatch: pytest.MonkeyPatch) -> None:
    """A state an operator could be shown has to be a state this release can name."""
    for index, error in enumerate((research.ResearchError("PROVIDER_RATE_LIMITED", "429"),
                                   research.ResearchError("PROVIDER_AUTH_REQUIRED", "401"),
                                   research.ResearchError("PROVIDER_UNAVAILABLE", "no answer"),
                                   research.ResearchError("QUERY_TOO_LONG", "unexpected"))):
        _env(monkeypatch, switch=bool(index % 2))
        if index >= 2:
            _consented()
        _semantic_scholar(monkeypatch, error=error)
        result = integrations.probe_semantic_scholar()
        assert result["termsState"] in integrations.TERMS_STATES, result
        assert result["accessState"] in integrations.ACCESS_STATES, result


def test_no_credential_value_enters_a_receipt_or_the_machine_file(monkeypatch: pytest.MonkeyPatch,
                                                                   machine_facts: Path) -> None:
    """T12-11/T12-34 extended to the new states: a key is reported as a boolean, and a token that arrives in
    a consent field is dropped rather than recorded or echoed."""
    _env(monkeypatch, switch=True, key=True, instant=SENTINEL_KEY, decision="provided")
    _semantic_scholar(monkeypatch, receipt={"records": []})
    result = integrations.probe_integrations("semantic_scholar")
    assert result["semanticScholar"]["credentialConfigured"] is True
    assert isinstance(result["semanticScholar"]["credentialConfigured"], bool)
    assert SENTINEL_KEY not in json.dumps(result), "the receipt holds no credential value"
    assert machinefacts.read_provider_state()["semantic_scholar"]["licenseAcknowledgedAt"] is None, \
        "a key-shaped value in the consent-instant field is dropped, not stored"
    written = (machine_facts / machinefacts.FACTS_FILE_NAME).read_bytes()
    assert SENTINEL_KEY not in written.decode("utf-8")
    assert machinefacts.MAX_FACTS_BYTES >= len(written), "the state section still fits the Toolkit's own bound on the file"


def test_the_integration_facts_verb_reads_the_file_and_reaches_no_probe(machine_facts: Path,
                                                                        monkeypatch: pytest.MonkeyPatch,
                                                                        capsys: pytest.CaptureFixture[str]) -> None:
    """INT-15.2: reading the machine-level fact is a file read — no probe, no request, no Zotero contact."""
    monkeypatch.setattr(integrations, "probe_zotero", lambda: pytest.fail("the facts verb must not run a probe"))
    monkeypatch.setattr(integrations, "probe_semantic_scholar", lambda: pytest.fail("the facts verb must not run a probe"))
    monkeypatch.setattr(research, "list_zotero_collections", lambda: pytest.fail("the facts verb must not contact Zotero"))
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: pytest.fail("the facts verb must not contact Zotero"))
    monkeypatch.setattr(research, "search_literature", lambda *_args: pytest.fail("the facts verb must not contact a provider"))
    assert main(["integration-facts"]) == 0
    printed = capsys.readouterr().out
    assert json.loads(printed) == {"schemaVersion": 1, "facts": {}}
    assert '"schemaVersion": 1' in printed, "the verb prints with the indent-2 convention the other verbs use"
    assert not (machine_facts / machinefacts.FACTS_FILE_NAME).exists(), "a read of an absent file creates nothing"
    machinefacts.write_fact("zotero", found=True, classification="ready", platform="Linux",
                            detected_at_ms=1_762_000_000_000, code=None)
    assert main(["integration-facts"]) == 0
    assert json.loads(capsys.readouterr().out)["facts"]["zotero"]["classification"] == "ready"


def test_the_module_carries_no_forbidden_or_outbound_primitive() -> None:
    """The VSIX audit rule (scripts/verify_vsix.py:164-187), stated as a test."""
    source = Path(__file__).resolve().parents[1] / "src/research_stack/integrations.py"
    text = source.read_text(encoding="utf-8")
    for primitive in ("subprocess", "eval(", "exec(", "__import__(", "urllib.request", "urlopen", "build_opener", "socket", "http.client"):
        assert primitive not in text, f"integrations.py must not contain {primitive}"
    # Guard history, on the record. 6 000 held when the module sat at 5 998. Raised to 6 200 when the
    # five-state Zotero classification added operator-facing detail text, and to 7 400 when the confirmed
    # Zotero setting wording and the silent-drop sentence were added (module then 7 302). Both raises were
    # reported before they were made, the capability assertions above are unchanged in both cases, and
    # neither added a capability. Only the extension/worker copy is packaged, so the module counts once in
    # the artifact, not twice — the earlier wording here was wrong and is corrected with the measurement.
    # INT-15 added 46 bytes and the guard stayed at 7 400: the machine-level fact file lives in
    # `machinefacts.py`, and `probe_zotero` carries only the decorator that records what it already
    # classified.
    # Raised again to 7 600 (module now 7 520) for a correctness fix, not a feature: the probe used to tell the
    # operator it "writes nothing" and "nothing was written", which stopped being true the moment it began
    # recording one machine-level fact outside the workspace. The sentences now say "no workspace file", which
    # is accurate, and the module docstring names the fact file and states that it holds a classification and a
    # timestamp and never a credential. Trimming that statement to keep the old ceiling would have kept a false
    # operator-facing claim in the shipped text, so the guard moved instead. Capability assertions unchanged.
    # Raised to 13 900 (module now 13 753) for the measured probe defects, not for a new capability. The module
    # now (a) asks the documented `/api/` root before the listing and carries its `Zotero-API-Version` and
    # `Zotero-Server-ID` headers into the receipt, (b) gives a 401, a 404 and a non-JSON answer their own
    # operator-facing sentence instead of one generic "unknown", (c) carries what the port actually said — the
    # status, the reason line and the start of the body — clipped to 160 characters with key-shaped runs and
    # file paths taken out, and (d) returns a complete two-provider receipt when a probe itself raises, because
    # a readiness check must never crash. No transport call site was added: the module still holds no
    # `urllib.request`, `build_opener`, `urlopen`, `socket` or `http.client`, all asserted above, and those
    # assertions are unchanged. The artifact's own ceiling is measured by `scripts/verify_vsix.py`, not here.
    # Raised again to 17 500 (module now 17 397) for the same measured defects, and still for no new capability.
    # The probe now asks three stages in place of one request — `/api/`, then `HEAD /api/users/0/collections`,
    # then the listing — because each answers a different question and the old single request could only answer
    # one. It states its own worst case (34 seconds) in the probe's docstring because the host kills the probe
    # process on a clock, retries the listing once because Zotero answers the local API only after the library has
    # loaded, names which stage got no answer instead of one generic "no usable answer", says what a 400, a 403
    # that is not the preference, a 501 and a 404 each mean in the operator's words, and says what a refused port
    # can and cannot mean. No transport call site was added: the module still holds no `urllib.request`,
    # `build_opener`, `urlopen`, `socket` or `http.client`, all asserted above, and those assertions are unchanged.
    # Raised to 26 000 (module now 25 681) for 0.3.15 TASK P-2/P-3, and it is a capability, not padding: the
    # receipt now names which consent situation this process is really in (four states instead of one boolean),
    # copies the consent the extension carried into the machine-level fact, and says what the provider is like
    # for this operator in practice ("authorised, anonymous, no key taken, never reached") instead of reporting
    # a bare 429. That is the correction of the 21 November field conclusion. No transport call site was added:
    # the module still holds no `urllib.request`, `build_opener`, `urlopen`, `socket` or `http.client`, all
    # asserted above, and those assertions are unchanged. The artifact's own ceiling is measured by
    # `scripts/verify_vsix.py`, not here.
    assert len(source.read_bytes()) < 26_000, "the module is packaged in the worker copy and the artifact has a reviewed byte ceiling"
