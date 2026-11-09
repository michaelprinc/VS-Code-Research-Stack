from __future__ import annotations

import json
import re
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


def _zotero(monkeypatch: pytest.MonkeyPatch, *, installed: bool, receipt: dict[str, object] | None = None,
            error: research.ResearchError | None = None, ping: bool = False) -> None:
    """Patch the reused adapter, the connector ping and the installation detection, so no test opens a socket."""
    monkeypatch.setattr(integrations, "detect_zotero_installation", lambda: {"installed": installed, "evidence": "fixture"})
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: ping)
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
    """An answered local API settles the probe; a second request to the same port would be noise."""
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: pytest.fail("the ping is a fallback: it is not owed when the local API answered"))
    monkeypatch.setattr(integrations, "detect_zotero_installation", lambda: pytest.fail("an answered local API is the evidence; no path check is owed"))
    monkeypatch.setattr(research, "list_zotero_collections", lambda: {"collections": [], "serverId": "fixture-server", "readOnly": True})
    assert integrations.probe_zotero()["outcome"] == "ready"


def test_a_refused_local_api_makes_the_ping_worth_asking(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every way the local API can refuse gets the second look, and only a refusal gets it."""
    asked: list[str] = []
    monkeypatch.setattr(research, "zotero_connector_ping", lambda: asked.append("connector/ping") or True)
    monkeypatch.setattr(integrations, "detect_zotero_installation", lambda: pytest.fail("the ping answered, so no path check is owed"))
    for code in ("ZOTERO_NOT_AVAILABLE", "ZOTERO_API_DISABLED"):
        def refused(error: research.ResearchError = research.ResearchError(code, "refused")) -> dict[str, object]:
            raise error

        monkeypatch.setattr(research, "list_zotero_collections", refused)
        result = integrations.probe_zotero()
        assert result["outcome"] == "api-disabled" and result["installed"] is True and result["code"] == code
    assert asked == ["connector/ping", "connector/ping"]


def test_the_three_states_come_from_the_ping_not_from_a_guess(monkeypatch: pytest.MonkeyPatch) -> None:
    """One sentence used to cover "nothing answered"; the connector ping splits it into three states."""
    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "refused"), ping=True)
    refused = integrations.probe_zotero()
    assert refused["outcome"] == "api-disabled" and refused["installed"] is True, "the ping answers, so Zotero is running"
    assert OFFICIAL_ZOTERO_SETTING in refused["detail"]

    _zotero(monkeypatch, installed=True, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "refused"), ping=False)
    stopped = integrations.probe_zotero()
    assert stopped["outcome"] == "not-running" and stopped["installed"] is True

    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_NOT_AVAILABLE", "refused"), ping=False)
    absent = integrations.probe_zotero()
    assert absent["outcome"] == "not-installed" and absent["installed"] is False

    details = [state["detail"] for state in (refused, stopped, absent)]
    assert len(set(details)) == 3, details
    assert all("connector ping" in detail for detail in details[1:]), "both no-answer states say the ping was asked"


def test_a_request_that_produced_no_answer_is_a_state_not_a_crash(monkeypatch: pytest.MonkeyPatch) -> None:
    """Zotero 10 can drop a request without any response: that is `unknown`, not an absence and not a failure."""
    _zotero(monkeypatch, installed=False, error=research.ResearchError("ZOTERO_NO_ANSWER", "dropped"), ping=False)
    result = integrations.probe_zotero()
    assert result["outcome"] == "unknown" and result["code"] == "ZOTERO_NO_ANSWER" and result["installed"] is True
    assert "no usable answer" in result["detail"] and "which state applies is unknown" in result["detail"]


def test_the_ping_reuses_the_loopback_only_client_and_the_hardened_request() -> None:
    """No new transport: the reviewed member keeps its two openers, its zero direct requests and its bounds."""
    source = (Path(__file__).resolve().parents[1] / "src/research_stack/research.py").read_text(encoding="utf-8")
    assert source.count("build_opener(") == 2, "the reviewed member keeps exactly two openers"
    assert source.count("urlopen(") == 0, "the reviewed member opens no direct request"
    assert 'ZOTERO_LOCAL_API = "http://127.0.0.1:23119/api"' in source, "Zotero binds IPv4 loopback only"
    assert 'ZOTERO_CONNECTOR_PING = "http://127.0.0.1:23119/connector/ping"' in source, "the ping is a sibling of /api, not a child of it"
    assert '"Zotero-Allowed-Request": "1"' in source, "Zotero 10 drops requests that look like browser requests"
    api = source.split("def _zotero_request", 1)[1].split("def zotero_connector_ping", 1)[0]
    assert "ProxyHandler({})" in api and "_NoRedirectHandler()" in api and "timeout=2" in api
    ping = source.split("def zotero_connector_ping", 1)[1]
    assert "_zotero_request(ZOTERO_CONNECTOR_PING" in ping, "the ping is a path through the same client"
    assert "build_opener" not in ping and "urlopen" not in ping and "timeout=" not in ping


def test_zotero_answered_badly_is_unknown_never_unreachable_and_keeps_its_code(monkeypatch: pytest.MonkeyPatch) -> None:
    """An answer this release cannot classify is `unknown`: it reached Zotero and learned nothing."""
    for code in ("ZOTERO_NOT_READY", "ZOTERO_NOT_FOUND", "ZOTERO_REQUEST_FAILED", "ZOTERO_SCHEMA_UNEXPECTED", "ZOTERO_RESPONSE_TOO_LARGE"):
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
    monkeypatch.setattr(integrations, "detect_zotero_installation", lambda: pytest.fail("an answered local API is the evidence; no path check is owed"))
    monkeypatch.setattr(research, "list_zotero_collections", lambda: {"collections": [], "serverId": "fixture-server", "readOnly": True})
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
        if error is None:
            monkeypatch.setattr(research, "list_zotero_collections", lambda: {"collections": [], "serverId": "fixture-server", "readOnly": True})
        else:
            def failing(refused: research.ResearchError = error) -> dict[str, object]:
                raise refused

            monkeypatch.setattr(research, "list_zotero_collections", failing)
        assert integrations.probe_zotero()["outcome"] in {"ready", "not-running", "api-disabled"}
    assert open(library, encoding="utf-8").read() == "library bytes"


def test_zotero_ready_carries_the_server_id_and_states_that_nothing_was_written(monkeypatch: pytest.MonkeyPatch) -> None:
    _zotero(monkeypatch, installed=True, receipt={"collections": [{"key": "ABCD1234"}], "serverId": "fixture-server", "readOnly": True})
    result = integrations.probe_zotero()
    assert result["outcome"] == "ready" and result["code"] is None
    assert result["serverId"] == "fixture-server"
    assert "read-only collection listing succeeded" in result["detail"]
    assert "No library file was opened" in result["detail"] and "no configuration changed" in result["detail"]


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
    """A hosted endpoint has no installation on this machine, so the probe records nothing for it."""
    _semantic_scholar(monkeypatch, receipt={"records": []})
    assert integrations.probe_semantic_scholar()["outcome"] == "ready"
    integrations.probe_integrations("semantic_scholar")
    assert not (machine_facts / machinefacts.FACTS_FILE_NAME).exists(), "a hosted endpoint gains no installation fact"


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
    assert len(source.read_bytes()) < 7600, "the module is packaged in the worker copy and the artifact has a reviewed byte ceiling"
