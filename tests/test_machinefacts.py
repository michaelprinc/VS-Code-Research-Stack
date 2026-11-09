"""The machine-level integration facts file: one directory, one file, no secrets, no paths (INT-15, DD12-02).

No test in this file writes to the operator's real per-user application-data directory: the directory
is resolved through `provider_budget.budget_directory`, which every test here redirects to a temp
directory. Nothing here opens a socket, contacts an application or runs a probe.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from research_stack import machinefacts, provider_budget

SENTINEL_KEY = "SENTINEL-MACHINE-FACTS-KEY-4f9a1c"
SENTINEL_TOKEN = "ghp_7Kd9xQ2mZ4vL8pR1sT6yW0aB"
SENTINEL_WORKSPACE_PATH = "research/notes.md"
SENTINEL_USER_FILE = "/home/nurse/Desktop/notes.md"
SENTINEL_LIBRARY_PATH = "/home/nurse/zotero/zotero.sqlite"
DETECTED_AT = 1_762_000_000_000


@pytest.fixture
def machine_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The machine-level directory for this test: a temp directory, never the operator's own."""
    directory = tmp_path / "research-stack-toolkit"
    monkeypatch.setattr(provider_budget, "budget_directory", lambda _env=None: (directory, "isolated for this test"))
    return directory


def facts_file(directory: Path) -> Path:
    return directory / machinefacts.FACTS_FILE_NAME


def record(**overrides) -> dict[str, object]:
    values: dict[str, object] = {"found": True, "classification": "api-disabled", "platform": "Linux",
                                 "detected_at_ms": DETECTED_AT, "code": "ZOTERO_API_DISABLED"}
    values.update(overrides)
    return machinefacts.write_fact("zotero", **values)


def test_a_fresh_read_holds_no_facts_and_makes_no_claim(machine_dir: Path) -> None:
    """An absent file is not an error and not a statement: it is a document that claims nothing."""
    assert not machine_dir.exists(), "a read must not create the machine-level directory"
    assert machinefacts.read_facts() == {"schemaVersion": 1, "facts": {}}
    assert not machine_dir.exists(), "reading a file that is not there leaves nothing behind"


def test_the_directory_is_the_budgets_own_and_this_module_invents_no_second_one(machine_dir: Path) -> None:
    """DD12-02 names one per-user location; a second platform table here would be a second location."""
    source = (Path(__file__).resolve().parents[1] / "src/research_stack/machinefacts.py").read_text(encoding="utf-8")
    for marker in ("LOCALAPPDATA", "XDG_DATA_HOME", "USERPROFILE", "Application Support", ".local/share"):
        assert marker not in source, "machinefacts.py must resolve the directory through provider_budget, not its own table"
    assert "provider_budget.budget_directory" in source, "the facts file lives in the directory the budget already resolves"
    assert facts_file(machine_dir) == machine_dir / "integration-facts.json", "one file, named once"


def test_two_profiles_with_different_environments_read_one_file(tmp_path: Path) -> None:
    """INT-15.2: the fact belongs to the OS user, so a second profile does not re-ask the question."""
    home = tmp_path / "user"
    home.mkdir()
    profile_a = {"HOME": str(home), "USERPROFILE": str(home), "LOCALAPPDATA": str(home),
                 "XDG_DATA_HOME": str(home), "TMPDIR": "/tmp/profile-a"}
    profile_b = {"HOME": str(home), "USERPROFILE": str(home), "LOCALAPPDATA": str(home),
                 "XDG_DATA_HOME": str(home), "TMPDIR": "/tmp/profile-b"}
    assert machinefacts.facts_path(profile_a) == machinefacts.facts_path(profile_b), \
        "two profiles of one OS user resolve to one machine-level file"
    written = machinefacts.write_fact("zotero", found=True, classification="not-running", platform="Linux",
                                      detected_at_ms=DETECTED_AT, code="ZOTERO_NOT_AVAILABLE", env=profile_a)
    assert written["written"] is True
    read_by_the_other_profile = machinefacts.read_facts(profile_b)
    assert read_by_the_other_profile["facts"]["zotero"]["classification"] == "not-running"
    assert [path.name for path in machinefacts.facts_path(profile_a).parent.iterdir()] == [machinefacts.FACTS_FILE_NAME], \
        "one profile's write did not leave a second file for the other to find"


def test_the_file_holds_only_the_documented_keys(machine_dir: Path) -> None:
    """A fact is five fields and nothing else: no path, no detail text, no credential."""
    assert record()["written"] is True
    document = json.loads(facts_file(machine_dir).read_text(encoding="utf-8"))
    assert set(document) == {"schemaVersion", "facts"} and document["schemaVersion"] == 1
    assert set(document["facts"]) == {"zotero"}
    assert set(document["facts"]["zotero"]) == {"found", "classification", "platform", "detectedAtMs", "code"}
    assert document["facts"]["zotero"]["code"] == "ZOTERO_API_DISABLED"


def test_semantic_scholar_is_never_given_an_installation_fact_it_could_not_have_observed(machine_dir: Path) -> None:
    """A hosted endpoint has no installation on this machine; a fact for it would be an invented claim."""
    refused = machinefacts.write_fact("semantic_scholar", found=False, classification="unknown", platform="Linux",
                                      detected_at_ms=DETECTED_AT, code=None)
    assert refused["written"] is False and refused["code"] == "FACTS_PROVIDER_REFUSED"
    assert not facts_file(machine_dir).exists(), "a refused fact writes nothing at all"
    machine_dir.mkdir(parents=True, exist_ok=True)
    facts_file(machine_dir).write_text(json.dumps({"schemaVersion": 1, "facts": {
        "zotero": {"found": True, "classification": "ready", "platform": "Linux", "detectedAtMs": DETECTED_AT, "code": None},
        "semantic_scholar": {"found": True, "classification": "ready", "platform": "Linux", "detectedAtMs": DETECTED_AT, "code": None}}}),
        encoding="utf-8")
    assert set(machinefacts.read_facts()["facts"]) == {"zotero"}, "a fake installation fact is not read back as a fact"


@pytest.mark.parametrize(("field", "value", "code"), [
    ("platform", SENTINEL_KEY, "FACTS_SECRET_REFUSED"),
    ("code", SENTINEL_TOKEN, "FACTS_SECRET_REFUSED"),
    ("platform", "research/notes.md", "FACTS_PATH_REFUSED"),
    ("platform", SENTINEL_USER_FILE, "FACTS_PATH_REFUSED"),
    ("code", SENTINEL_LIBRARY_PATH, "FACTS_PATH_REFUSED"),
    ("platform", "C:\\Users\\nurse\\Desktop\\notes.md", "FACTS_PATH_REFUSED"),
])
def test_a_value_that_belongs_in_a_secret_store_or_a_workspace_is_refused_by_its_rule(
        machine_dir: Path, field: str, value: str, code: str) -> None:
    """T12-34: the machine-level file is not a place a key, a token or a path can be written to."""
    arguments: dict[str, object] = {"found": True, "classification": "ready", "platform": "Linux",
                                    "detected_at_ms": DETECTED_AT, "code": None}
    arguments[field] = value
    refused = machinefacts.write_fact("zotero", **arguments)
    assert refused["written"] is False and refused["code"] == code
    assert value not in json.dumps(refused), f"the refusal echoed the {field} it refused"
    assert not facts_file(machine_dir).exists(), "a refused value left no file behind"
    assert machinefacts.read_facts() == {"schemaVersion": 1, "facts": {}}


def test_a_refusal_names_the_rule_it_broke_in_words_an_operator_can_act_on(machine_dir: Path) -> None:
    """DD12-02: the answer says which rule held, so a refused write is diagnosable without a leak."""
    secret = machinefacts.write_fact("zotero", found=True, classification="ready", platform=SENTINEL_KEY,
                                     detected_at_ms=DETECTED_AT, code=None)
    path = machinefacts.write_fact("zotero", found=True, classification="ready", platform=SENTINEL_USER_FILE,
                                   detected_at_ms=DETECTED_AT, code=None)
    assert "secret" in secret["rule"] and "token" in secret["rule"] and "key" in secret["rule"]
    assert "workspace path" in path["rule"] and "Zotero library" in path["rule"]
    assert SENTINEL_KEY not in path["rule"] and SENTINEL_USER_FILE not in path["rule"]


def test_an_oversized_write_is_refused_and_the_file_is_left_exactly_as_it_was(machine_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """T12-35: the file cannot grow silently, and it cannot be cut down to fit either."""
    assert record()["written"] is True
    before = facts_file(machine_dir).read_bytes()
    monkeypatch.setattr(machinefacts, "MAX_FACTS_BYTES", 64)
    refused = record(classification="ready", platform="Windows", code=None)
    assert refused["written"] is False and refused["code"] == "FACTS_TOO_LARGE"
    assert "refused, not truncated" in refused["rule"], "the refusal says which happened"
    assert facts_file(machine_dir).read_bytes() == before, "the file on disk is the file that was already there"
    assert machinefacts.read_facts()["facts"]["zotero"]["classification"] == "api-disabled"
    assert [path.name for path in machine_dir.iterdir()] == [machinefacts.FACTS_FILE_NAME], "no partial write was left behind"


def test_the_size_bound_is_the_toolkits_own_and_is_stated_in_the_module() -> None:
    """The cap is a number this Toolkit chose and names, not one inherited from a provider."""
    source = (Path(__file__).resolve().parents[1] / "src/research_stack/machinefacts.py").read_text(encoding="utf-8")
    assert machinefacts.MAX_FACTS_BYTES == 8_192
    assert "MAX_FACTS_BYTES = 8_192" in source and "The Toolkit's own bound" in source
    assert "Nothing is ever truncated" in source


def test_the_file_is_replaced_atomically_and_never_written_in_place(machine_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """T12-35: a temp file in the same directory, then one replace — a reader never sees half a file."""
    recorded: list[tuple[str, str]] = []

    class RecordingOs:
        def getpid(self) -> int:
            return os.getpid()

        def replace(self, source: Path, destination: Path) -> None:
            recorded.append((str(source), str(destination)))
            os.replace(source, destination)

    recorder = RecordingOs()
    monkeypatch.setattr(machinefacts, "os", recorder)
    assert record()["written"] is True
    assert record(classification="not-installed", code="ZOTERO_NOT_AVAILABLE")["written"] is True
    assert [destination for _source, destination in recorded] == [str(facts_file(machine_dir))] * 2
    for source, destination in recorded:
        assert source != destination, "the file was written in place"
        assert Path(source).parent == machine_dir, "the temp file is in the same directory, or the replace is not atomic"
        assert Path(source).name.endswith(".tmp")
    assert [path.name for path in machine_dir.iterdir()] == [machinefacts.FACTS_FILE_NAME], \
        "the temp file was replaced, not left behind next to the facts"
    assert machinefacts.read_facts()["facts"]["zotero"]["classification"] == "not-installed"


def test_reading_the_same_fact_twice_gives_the_same_state_and_writes_nothing_new(machine_dir: Path) -> None:
    """T12-37: a second read is not a second setup — no new file, no new write, no new prompt."""
    assert record()["written"] is True
    first = machinefacts.read_facts()
    names = sorted(path.name for path in machine_dir.iterdir())
    body = facts_file(machine_dir).read_bytes()
    stamp = facts_file(machine_dir).stat().st_mtime_ns
    second = machinefacts.read_facts()
    assert first == second == {"schemaVersion": 1, "facts": {"zotero": {
        "found": True, "classification": "api-disabled", "platform": "Linux",
        "detectedAtMs": DETECTED_AT, "code": "ZOTERO_API_DISABLED"}}}
    assert sorted(path.name for path in machine_dir.iterdir()) == names, "the second read created no file"
    assert facts_file(machine_dir).read_bytes() == body and facts_file(machine_dir).stat().st_mtime_ns == stamp, \
        "the second read wrote nothing"


def test_a_file_that_is_not_the_document_this_module_writes_reads_as_no_facts(machine_dir: Path) -> None:
    """A damaged or foreign file is not a crash and not a claim: it answers as a machine nothing was said about."""
    machine_dir.mkdir(parents=True, exist_ok=True)
    for body in ("not json at all", "[]", '{"schemaVersion": 2, "facts": {}}', '{"schemaVersion": 1, "facts": "none"}',
                 '{"schemaVersion": 1, "facts": {"zotero": {"found": "yes", "classification": "ready", "platform": "Linux", "detectedAtMs": 1, "code": null}}}',
                 '{"schemaVersion": 1, "facts": {"zotero": {"found": true, "classification": "ready", "platform": "/home/nurse/notes.md", "detectedAtMs": 1, "code": null}}}'):
        facts_file(machine_dir).write_text(body, encoding="utf-8")
        assert machinefacts.read_facts() == {"schemaVersion": 1, "facts": {}}, body


def test_a_classification_the_host_cannot_read_is_refused(machine_dir: Path) -> None:
    """The five words are the host's vocabulary; a sixth word would be a claim the panel cannot show."""
    refused = record(classification="probably-there")
    assert refused["written"] is False and refused["code"] == "FACTS_CLASSIFICATION_REFUSED"
    assert set(machinefacts.CLASSIFICATIONS) == {"ready", "api-disabled", "not-running", "not-installed", "unknown"}
    assert not facts_file(machine_dir).exists()


def test_a_fact_written_by_a_probe_carries_the_time_it_was_measured_at(machine_dir: Path) -> None:
    """DD12-02: a fact is evidence about a moment, so the moment travels with it."""
    recorded = machinefacts.record_zotero({"outcome": "not-running", "code": "ZOTERO_NOT_AVAILABLE", "installed": True},
                                          now_ms=lambda: DETECTED_AT / 1000.0)
    assert recorded["written"] is True
    fact = machinefacts.read_facts()["facts"]["zotero"]
    assert fact["detectedAtMs"] == DETECTED_AT and fact["classification"] == "not-running" and fact["found"] is True
    assert fact["code"] == "ZOTERO_NOT_AVAILABLE" and fact["platform"]


def test_a_fact_with_no_moment_is_refused_because_the_reader_would_reject_it(machine_dir: Path) -> None:
    """The writer and the reader must not disagree, or the Toolkit refuses its own record.

    The host reader (`extension/integrationprobe.js`) requires `detectedAtMs > 0`. A writer that accepted 0
    would produce a file this module can write and neither side can use — the same class of defect as a read
    cap below the write cap. Both sides now refuse a non-positive moment, and a zero-dated fact is refused
    rather than written and then dropped.
    """
    for moment in (0, -1):
        refused = machinefacts.write_fact("zotero", found=True, classification="ready", platform="linux",
                                          detected_at_ms=moment, code=None)
        assert refused["written"] is False, f"a fact dated {moment} must not be written"
        assert refused["code"] == "FACTS_VALUE_REFUSED", f"the refusal must name the value rule, got {refused}"
    assert not machine_dir.exists() or not list(machine_dir.glob("integration-facts.json*")), \
        "a refused fact must leave no file behind"
    assert machinefacts.read_facts()["facts"] == {}, "and the read still holds no claim"


def test_the_module_carries_no_forbidden_or_outbound_primitive() -> None:
    """The VSIX audit rule (scripts/verify_vsix.py:180-183), stated as a test.

    Byte ceiling: 11 500 is the measured module plus headroom, stated so it cannot drift upward
    silently. The module ships once, in the worker copy, and the artifact ceiling itself is measured
    by the coordinator under DD12-09.
    """
    source = Path(__file__).resolve().parents[1] / "src/research_stack/machinefacts.py"
    text = source.read_text(encoding="utf-8")
    for primitive in ("subprocess", "eval(", "exec(", "__import__(", "os.system", "os.popen", "os.exec", "pty",
                      "multiprocessing", "fcntl", "msvcrt", "urllib", "urlopen", "build_opener", "socket", "http.client"):
        assert primitive not in text, f"machinefacts.py must not contain {primitive}"
    assert len(source.read_bytes()) < 11_500, "the module is packaged in the worker copy and the artifact has a reviewed byte ceiling"
