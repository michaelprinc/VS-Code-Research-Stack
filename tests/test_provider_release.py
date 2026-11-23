"""The 0.3.15 provider release, as one gate over three files and the evidence it shipped with.

Each case here is the part that only shows up when the pieces are read together: the claim a request leaves
behind, the word a readiness report is allowed to use, the field a provider only sends when asked for, and the
fixture that proves it. Nothing in this file opens a socket: the network measurement was run once, on purpose,
by `scripts/probe_providers.py`, and what it found is committed under `evidence/providers-2026-11-22/`.

Field evidence this file holds in place: `provider-receipts/probe25_out.txt` and `probe25b_out.txt` (the
reservation leak and its fix), `post_patch_check2_out.txt` (OpenAlex `referenceCount` 0/5, Crossref
`retracted` 0/3 through the search route, the retraction trio detected only on the single-DOI route), and the
21/22 November conclusion about the licence gate that had to be corrected the day after it was written.

The last section holds the adapter patch itself to those measurements: what `research.py` asks each provider
for, what it reads back out of the answer, and which route it took to get it. A field the adapter now reports
has to be a field the request named and the measurement saw, and a field the measurement could not reach
(Semantic Scholar) stays unclaimed.
"""

from __future__ import annotations

import json
import re
import urllib.parse
from datetime import UTC, datetime
from pathlib import Path

import pytest

from research_stack import integrations, machinefacts, provider_budget, research
from research_stack.integrations import ACCESS_STATES, TERMS_STATES

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence" / "providers-2026-11-22"
FIXTURES = EVIDENCE / "fixtures"
SENTINEL_KEY = "SENTINEL-PROVIDER-RELEASE-KEY-6d2f8b1a4c9e"
SENTINEL_TOKEN = "ghp_4Kd9xQ2mZ4vL8pR1sT6yW0aBcD3fH5jK"
COVERAGE_DOI = "10.32725/cetv.2017.022"
COVERAGE_WORK_ID = "W3206688818"
RETRACTION_DOIS = ("10.1016/S0140-6736(97)11096-0", "10.1038/nature00870", "10.1056/nejmoa1200303")


def fixture(name: str) -> dict[str, object]:
    """A committed measurement, read as data. A missing fixture is a failure, not a skip: the measurement
    is part of the release, and a test that skips when its own evidence is gone proves nothing."""
    path = FIXTURES / name
    assert path.exists(), f"{name} is part of the 0.3.15 provider evidence and it is not in the release"
    return json.loads(path.read_text(encoding="utf-8"))


# --- 1. The reservation leak cannot come back through the adapter -------------------------------------

@pytest.fixture
def isolated_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Where the budgets live for these tests: a temp directory, never the operator's per-user one."""
    directory = tmp_path / "release-budget"
    monkeypatch.setattr(provider_budget, "budget_directory", lambda _env=None: (directory, "isolated for this test"))
    return directory


def test_a_provider_that_refused_every_attempt_leaves_the_key_askable_again(isolated_budget: Path,
                                                                            monkeypatch: pytest.MonkeyPatch) -> None:
    """The crash as the adapter sees it: `research._provider_request`, not the budget module alone.

    On 21 November 2026 the operator's check produced four `PROVIDER_UNAVAILABLE` attempts and the next
    request for the same query died inside the Toolkit with `TypeError: 'bool' object is not subscriptable`.
    Reaching that path through `research.py` is the point: the deferral has to surface as a Toolkit error the
    CLI can print, never as an exception from inside the cache.
    """
    class Unavailable(Exception):
        code = "PROVIDER_UNAVAILABLE"

    def down(*_args: object):
        raise Unavailable()

    monkeypatch.setattr(research, "_request_json", down)
    monkeypatch.setattr(research, "_LAST_REQUEST_AT", {})
    monkeypatch.setattr(research, "_THROTTLE_LOCKS", {name: __import__("threading").Lock() for name in research._THROTTLE_LOCKS})
    url = "https://api.openalex.org/works?search=corpus%20iuris%20canonici"
    with pytest.raises(research.ResearchError) as first:
        research._provider_request("openalex", url, cache_key="query-1")
    assert first.value.code in ("PROVIDER_UNAVAILABLE", "PROVIDER_BUDGET_DEFERRED")

    def working(*_args: object):
        return ({"results": []}, {})

    monkeypatch.setattr(research, "_request_json", working)
    payload, _headers, budget = research._provider_request("openalex", url, cache_key="query-1")
    assert payload == {"results": []} and budget["attempts"] == 1 and budget["fromCache"] is False
    cache = json.loads((isolated_budget / "cache-openalex.json").read_text(encoding="utf-8"))
    assert cache["claims"] == {}, "the failed request still owns the key it was asked for"


def test_a_key_another_process_is_holding_defers_rather_than_duplicating_or_crashing(isolated_budget: Path) -> None:
    """`PROVIDER_BUDGET_DEFERRED` is the honest answer to somebody else already asking.

    Before 0.3.15 the same situation produced the `False` that the caller then indexed. A deferral carries
    `waitMs` so the caller has something to respect instead of a stack frame.
    """
    clock_start = 1_762_000_000_000

    def hold() -> provider_budget.ProviderBudget:
        return provider_budget.ProviderBudget("openalex", directory=isolated_budget,
                                             now_ms=lambda: clock_start, sleep_ms=lambda _ms: None)

    holder = hold()
    assert holder._reserve("anon:query-2", None) is True
    waiting = provider_budget.ProviderBudget("openalex", directory=isolated_budget,
                                            now_ms=lambda: clock_start, sleep_ms=lambda _ms: None)
    asked: list[str] = []
    result = waiting.run(lambda *_args: asked.append("asked"), "https://api.openalex.org/works", cache_key="query-2")
    assert asked == [] and result["deferred"] == "in-flight" and result["payload"] is None
    assert result["waitMs"] > 0 and result["attempts"] == 0
    assert json.loads((isolated_budget / "cache-openalex.json").read_text(encoding="utf-8"))["claims"]["anon:query-2"]["owner"] == holder.owner


def test_the_dedup_decision_is_named_steps_and_cannot_hand_a_non_dict_to_the_caller() -> None:
    """The shape of the fix is asserted on the source, because the defect was a shape, not a value."""
    text = (ROOT / "src/research_stack/provider_budget.py").read_text(encoding="utf-8")
    assert "self._reserve(key, None) and None" not in text, "the nested cache/dedup expression is retired"
    assert "def _release(self, key: str)" in text and "held.get(\"owner\") == self.owner" in text, \
        "a claim is dropped only by the caller that holds it"
    assert "claimed = key is not None" in text and "self._release(key)" in text, \
        "every exit that stores no result hands the key back"
    assert re.search(r"def _claim\(self, key: str\) -> tuple\[", text), "the decision is a named function with a stated return shape"


# --- 2. One vocabulary across the worker, the facts file and the panel ---------------------------------

def test_the_worker_the_facts_file_and_the_panel_name_the_same_decisions_and_modes() -> None:
    """A state the worker can record has to be a state the panel can already show, or it reads as damage."""
    panel = (ROOT / "extension/integrations.js").read_text(encoding="utf-8")
    decisions = re.search(r"const KEY_DECISIONS = \[([^\]]*)\]", panel)
    modes = re.search(r"const MODES = \[([^\]]*)\]", panel)
    access = re.search(r"const ACCESS_STATES = \[([^\]]*)\]", panel)
    assert decisions and modes and access, "the panel's vocabularies could not be read to compare them"
    panel_decisions = {item.strip().strip('"') for item in decisions.group(1).split(",")}
    panel_modes = {item.strip().strip('"') for item in modes.group(1).split(",")}
    panel_access = {item.strip().strip('"').replace("\n", "").replace(" ", "")
                    for item in re.sub(r"\s+", " ", access.group(1)).split(",") if item.strip()}
    assert set(machinefacts.STATE_KEY_DECISIONS) == panel_decisions, "the facts file records a decision the panel cannot name"
    assert set(panel_modes) == {"anonymous", "api-key"} and set(machinefacts.STATE_MODES) == {"anonymous", "keyed"}, \
        "the panel's word for a stored key and the fact's word for it are deliberately different, and the mapping is in the worker"
    assert {state for state in ACCESS_STATES} <= panel_access, "the card has no wording for a state the worker can report"


def test_the_gate_states_are_named_and_the_extension_still_refuses_to_authorise_itself() -> None:
    """TASK P-2 keeps the gate deliberate: precision about consent is not permission to record consent."""
    assert set(TERMS_STATES) == {"PROVIDER_TERMS_ACKNOWLEDGED", "PROVIDER_TERMS_ACKNOWLEDGED_BY_SWITCH_ONLY",
                                 "PROVIDER_TERMS_STORED_BUT_NOT_INJECTED", "PROVIDER_TERMS_NOT_ACKNOWLEDGED"}
    panel = (ROOT / "extension/integrations.js").read_text(encoding="utf-8")
    assert "acknowledged !== true" in panel and "will not record it" in panel, \
        "authorizeSemanticScholar must keep refusing a confirmation the operator did not give"
    probe = (ROOT / "extension/integrationprobe.js").read_text(encoding="utf-8")
    assert 'SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED: "true"' in probe, \
        "the switch is carried only by a check the panel authorised, which is what makes the stored fact worth writing"


def test_the_card_can_say_consented_but_practically_unusable_and_names_no_credential() -> None:
    """TASK P-3: the reported state has to be able to hold 'authorised and never reached'."""
    panel = (ROOT / "extension/integrations.js").read_text(encoding="utf-8")
    assert '"confirmed-not-injected"' in panel and '"confirmed-anonymous-refused"' in panel, \
        "the two states the worker reports have no wording in the card"
    assert "accessState" in panel.split("entry.lastCheck = {")[1].split("};")[0], \
        "the practical state is not carried into the record, so a restart would lose it"
    wording = panel.split("const WORDING = {")[1].split("};")[0]
    clauses = panel.split("const KEY_CLAUSES = {")[1].split("};")[0]
    for marker in ("api_key", "secret", "Bearer", "passphrase", "token", "credential"):
        assert marker not in wording and marker not in clauses, \
            f"the sentence an operator reads names {marker!r}; a readiness report says whether a key exists, never what it is"


def test_the_worker_reports_booleans_for_the_gates_and_no_credential_value() -> None:
    """T12-11/T12-34 extended over the new fields: a receipt may say a key exists, never what it is."""
    source = (ROOT / "src/research_stack/integrations.py").read_text(encoding="utf-8")
    body = source.split("def probe_semantic_scholar")[1]
    assert "credentialConfigured" in body and "bool(os.environ.get(API_KEY_ENV))" in body
    assert "os.environ[API_KEY_ENV]" not in body and "API_KEY_ENV]" not in body.replace("bool(os.environ.get(API_KEY_ENV))", ""), \
        "a credential value is read nowhere in the probe's receipt"


# --- 3. What the providers actually send, as committed measurements ------------------------------------

def test_openalex_sends_type_retracted_citation_count_only_when_select_asks_for_them() -> None:
    """The measured reason the adapter's OpenAlex fields come back empty.

    The default representation carries `type`, `is_retracted`, `cited_by_count` and `is_paratext`. A `select=`
    request returns ONLY the listed fields — and the adapter's list does not name those four. So the empty
    columns in the 21 November receipt are a request-shape fact, not a provider that lacks the data.
    """
    document = fixture("openalex-select-field-availability.json")
    only = document["selectedOnlyFields"]
    assert set(only) == {"type", "is_retracted", "cited_by_count", "is_paratext"}
    assert all(entry["inDefault"] for entry in only.values()), "the provider does have these fields"
    assert not any(entry["withAdapterSelect"] for entry in only.values()), \
        "and the adapter's own select list is what leaves them out"
    assert "type" not in document["selectedKeys"] and "is_retracted" not in document["selectedKeys"]


def test_crossref_created_is_the_registration_date_and_issued_is_the_publication_date() -> None:
    """`created` is not a publication date: the frozen rows include the reprint-year case.

    The measured rows are kept rather than described: 21 November's receipts show `dateField: created` chosen
    for works whose `issued` date is present, and for at least one work `created` sits years after `issued`.
    """
    document = fixture("crossref-issued-vs-created.json")
    rows = [row for row in document["rows"] if row.get("allDates")]
    assert rows, "the probe returned no Crossref row carrying both dates"
    gaps = [{"doi": row["doi"], "issued": row["allDates"].get("issued"), "created": row["allDates"].get("created")}
            for row in rows if row["allDates"].get("created") and row["allDates"].get("issued")]
    later = [gap for gap in gaps if str(gap["created"]) > str(gap["issued"])]
    assert gaps and later, f"no row shows `created` later than `issued`: {gaps}"
    assert all(row.get("dateField") in ("issued", "published-print", "published-online", "created") for row in rows)


def test_crossref_names_a_retraction_through_updated_by_and_the_routes_differ() -> None:
    """The retraction trio, measured on the routes the Toolkit actually takes.

    21 November's receipts reported `retracted` for 0 of 3 records and concluded that Crossref has no retraction
    data. It does: `updated-by` carries an entry of type `retraction`, on the single-DOI route, on the DOI
    filter, and on some `query.bibliographic` rows — and never on the plain `query=` search rows, which is the
    route whose fill counts are measured below. A field the request never asked for is not a provider gap.
    """
    for doi in RETRACTION_DOIS:
        name = f"crossref-retraction-{doi.replace('/', '_').replace('(', '').replace(')', '')}.json"
        routes = fixture(name)["routes"]
        direct = routes["singleDoiRoute"]
        assert direct["hasUpdatedBy"] is True, f"{doi}: no `updated-by` on the single-DOI route"
        assert direct["retracted"] is True and any(entry["type"] == "retraction" for entry in direct["updatedBy"]), \
            f"{doi}: `updated-by` carried no entry of type `retraction`"
        assert direct["date"] and direct["dateField"], f"{doi}: the retraction row carries no usable date"
        assert routes["doiFilterRoute"]["foundAmongRows"] is True and routes["doiFilterRoute"]["hasUpdatedBy"] is True, \
            f"{doi}: the DOI filter route is the guaranteed second route and it did not hold"
        assert routes["bibliographicSearchRoute"].get("rowsReturned", 0) >= 1, f"{doi}: no bibliographic rows measured"
    search = json.loads((EVIDENCE / "receipt.json").read_text(encoding="utf-8"))["providers"]["crossref"]["searchFill"]
    assert search["fieldsAbsent"]["retracted"] == search["rowsReturned"], \
        "the plain search route reported `updated-by` for a row, and the claim above has to be re-read"


def test_a_zero_the_provider_sent_is_not_a_field_the_provider_omitted() -> None:
    """The distinction the 21 November receipts blurred, held as an arithmetic invariant."""
    receipt = json.loads((EVIDENCE / "receipt.json").read_text(encoding="utf-8"))
    blocks = [receipt["providers"]["crossref"]["searchFill"], receipt["providers"]["crossref"]["singleDoi"]["fill"],
              receipt["providers"]["openalex"]["searchFill"]]
    for block in blocks:
        rows = block["rowsReturned"]
        assert rows > 0
        for field in block["fieldsFilled"]:
            assert block["fieldsFilled"][field] + block["fieldsAbsent"][field] == rows, \
                f"{block['provider']} {field}: a row is counted twice or not at all"
            assert block["fieldsReportedZero"][field] <= block["fieldsFilled"][field]
    crossref_search = blocks[0]
    assert crossref_search["fieldsReportedZero"]["citationCount"] > 0 and crossref_search["fieldsAbsent"]["citationCount"] == 0, \
        "Crossref sends citation counts as real zeros; counting them as missing was the original error"
    openalex_search = blocks[2]
    assert openalex_search["fieldsAbsent"]["retracted"] == 0 and openalex_search["fieldsReportedZero"]["retracted"] == openalex_search["rowsReturned"], \
        "OpenAlex answers `is_retracted` for every row it returns, and none of them was retracted"


def test_one_crossref_type_filter_is_not_books() -> None:
    """Crossref `type` is a vocabulary of near-synonyms, measured on one work and four filters."""
    counts = fixture("crossref-type-vocabulary.json")["filterCounts"]
    union = {name.split(":", 1)[1]: state for name, state in counts.items() if name.startswith("union:")}
    assert set(union) == {"book", "monograph", "edited-book", "book-chapter"}
    assert union["book-chapter"]["returned"] == 1 and union["book-chapter"]["typeSeen"] == "book-chapter"
    for neighbouring in ("book", "monograph", "edited-book"):
        assert union[neighbouring]["returned"] == 0, f"{neighbouring} returned the book-chapter row, so the union claim is wrong"
    assert counts["typesSeenForQuery"], "no type mix was measured for a plain query"
    assert len(counts["typesSeenForQuery"]) >= 3, "a plain query returned one type, which proves nothing about the mix"


def test_coverage_is_measured_route_by_route_and_the_old_claim_is_retested() -> None:
    """`10.32725/cetv.2017.022` — Kanonické právo a spiritualita — on six routes.

    The provider ranking drawn on 21 November ("OpenAlex cannot find this work") was re-measured here, and the
    first run of this probe reported three working OpenAlex routes as blind because it compared a bare work id
    against the full id OpenAlex sends. Both the correction and the retest are in the fixture, because the
    mistake is the thing a later reader needs to know about this measurement.
    """
    document = fixture("openalex-coverage-10.32725-cetv.2017.022.json")
    assert document["workId"] == COVERAGE_WORK_ID and document["doi"] == COVERAGE_DOI
    assert document["crossrefDoiRoute"]["foundWork"] is True, "Crossref's DOI route does not have the work"
    assert document["openalexIdRoute"]["foundWork"] is True and document["openalexDoiRoute"]["foundWork"] is True, \
        "OpenAlex knows the work on its own routes"
    for name in ("openalexDoiFilter", "openalexTitleSearch", "openalexFreeTextDoiQuery"):
        state = document[name]
        assert isinstance(state["foundWork"], bool) and "returned" in state
        assert all(str(item).startswith("https://openalex.org/") for item in state["returned"]), \
            f"{name}: the ids the provider sent were rewritten before they were compared"
        assert state["foundWork"] == any(str(item).rstrip("/").rsplit("/", 1)[-1] == COVERAGE_WORK_ID
                                         for item in state["returned"]), \
            f"{name}: foundWork does not follow from the ids OpenAlex returned"
    assert document["retestOfThe21NovemberClaim"], "the retest sentence is missing from the fixture"
    receipt = json.loads((EVIDENCE / "receipt.json").read_text(encoding="utf-8"))
    assert any(COVERAGE_DOI in item for item in receipt["notProven"]), \
        "a coverage conclusion that did not reproduce is not written down as not proven"


def test_untitled_container_rows_are_a_measured_shape_not_a_missing_title_bug() -> None:
    """journal-issue and journal-volume rows carry a container and no work; the other types measured do not.

    The fixture keeps both directions on purpose. A claim that 'Crossref rows have no titles' would be read off
    a sample that only looked at two of the five types.
    """
    types = fixture("crossref-untitled-container-rows.json")["types"]
    assert set(types) >= {"journal-issue", "journal-volume", "component", "standard", "dataset"}
    untitled = {name for name, state in types.items() if "refused" not in state and state["untitledRows"] > 0}
    titled = {name for name, state in types.items() if "refused" not in state and state["titlesFilled"] > 0}
    assert {"journal-issue", "journal-volume"} <= untitled, "the two container-level types were not measured as untitled"
    assert titled and not (untitled & titled), f"the fixture no longer separates the two shapes: {sorted(untitled)} / {sorted(titled)}"
    for name, state in types.items():
        if "refused" not in state:
            assert state["untitledRows"] <= state["returned"] and state["titlesFilled"] <= state["returned"], \
                f"{name}: the counts do not describe {state['returned']} rows"


def test_the_evidence_dir_holds_no_credential_and_no_user_path() -> None:
    """T12-11 and T12-34 applied to the evidence the release now ships with."""
    files = sorted(path for path in EVIDENCE.rglob("*") if path.is_file())
    assert files, "the provider evidence directory is empty"
    for path in files:
        text = path.read_text(encoding="utf-8")
        for marker in (SENTINEL_KEY, SENTINEL_TOKEN, "api_key", "x-api-key", "Bearer ", "SEMANTIC_SCHOLAR_API_KEY="):
            assert marker not in text, f"{path.name} carries {marker!r}"
        for marker in ("/home/", "C:\\Users\\", "zotero.sqlite"):
            assert marker not in text, f"{path.name} carries a machine or library path"


def test_the_probe_is_paced_anonymous_and_sends_no_credential_header() -> None:
    """The probe's own rules, asserted on the script that produced the evidence above."""
    script = (ROOT / "scripts/probe_providers.py").read_text(encoding="utf-8")
    assert '"api.crossref.org": 1.3' in script, "Crossref's anonymous pool is one request per second shared by everyone"
    assert 'headers={"User-Agent": USER_AGENT, "Accept": "application/json"}' in script, \
        "the request builder sends exactly the two headers the probe declares"
    assert script.count("headers=") == 1, "a second request builder is where a credential header would appear"
    assert '"SEMANTIC_SCHOLAR_API_KEY", "SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED"' in script and "os.environ.pop(name, None)" in script, \
        "the probe clears the key from its own environment rather than using it"
    assert "no contact address supplied" in script, \
        "an invented contact address would be a claim about the operator this probe cannot make"
    assert "429 is not an empty field" in script, "the distinction the 21 November receipts blurred is stated in the tool"
    assert "_not_proven.append" in script, "what the run could not reach is recorded, not omitted"


def test_the_receipt_records_every_request_the_probe_made() -> None:
    """A frozen measurement is only frozen if the questions it asked are in the document."""
    receipt = json.loads((EVIDENCE / "receipt.json").read_text(encoding="utf-8"))
    requests = receipt["requests"]
    assert receipt["requestCount"] == len(requests) >= 30, "the probe stopped recording what it asked"
    assert {entry["host"] for entry in requests} == {"api.crossref.org", "api.openalex.org", "api.semanticscholar.org"}
    assert all(entry["url"].startswith("https://") and "key=" not in entry["url"] for entry in requests), \
        "a request URL carries a credential, or was asked over something other than https"
    asked = {entry["label"] for entry in requests}
    assert all(refusal["label"] in asked for refusal in receipt["refusals"]), \
        "a refusal is reported without the request that produced it"
    crossref_urls = [entry["url"] for entry in requests if entry["host"] == "api.crossref.org"]
    assert any("/works/10." in url for url in crossref_urls) and any("query=" in url for url in crossref_urls), \
        "the two Crossref routes the fill counts are labelled by are not both present in the request log"


def test_the_summary_and_receipt_are_the_same_measurement_as_the_fixtures() -> None:
    """A summary that drifted from its receipt is a worse document than no summary."""
    receipt = json.loads((EVIDENCE / "receipt.json").read_text(encoding="utf-8"))
    summary = (EVIDENCE / "summary.md").read_text(encoding="utf-8")
    assert receipt["credentialsSent"] is False
    assert receipt["providers"]["semanticScholar"]["withoutAcknowledgement"]["code"] == "PROVIDER_TERMS_NOT_ACKNOWLEDGED"
    assert "Semantic Scholar is disabled until the current API license is reviewed" in \
        receipt["providers"]["semanticScholar"]["withoutAcknowledgement"]["message"], \
        "the exact refusal text the gate produces is part of the evidence, not a paraphrase of it"
    for doi in RETRACTION_DOIS:
        assert doi in summary, f"{doi} is measured and the summary does not name it"
    assert COVERAGE_WORK_ID in summary and "not proven" in summary.lower()


# --- 4. The adapter patch, held to the same measurements ---------------------------------------------

FETCHED_AT = "2026-11-23T05:45:27+00:00"  # the moment the probe recorded what is asserted below
OLD_OPENALEX_SELECT = ("id", "doi", "title", "authorships", "publication_year", "publication_date",
                       "primary_location", "abstract_inverted_index", "open_access")


def measured_crossref_rows() -> list[dict[str, object]]:
    """The seven measured Crossref rows, put back into the shape Crossref sends.

    The committed fixture keeps a date as its ISO text (`allDates`) and drops Crossref's `date-parts`
    wrapper; this re-encodes the recorded text into that wrapper. Every date below is a date the probe
    recorded for this DOI, and the DOI, `title` and `type` are the fixture's own — nothing here is invented.
    """
    rows: list[dict[str, object]] = []
    for row in fixture("crossref-issued-vs-created.json")["rows"]:
        raw: dict[str, object] = {"DOI": row["doi"], "title": [row["title"]], "type": row["publicationType"]}
        for name, iso in row["allDates"].items():
            raw[name] = {"date-parts": [[int(part) for part in str(iso).split("-")]]}
        rows.append(raw)
    return rows


def measured_crossref_row(doi: str) -> dict[str, object]:
    matches = [row for row in measured_crossref_rows() if str(row["DOI"]).lower() == doi.lower()]
    assert matches, f"{doi} is not among the measured Crossref rows"
    return matches[0]


def normalized_crossref(row: dict[str, object]) -> dict[str, object]:
    return research._normalize("crossref", row, FETCHED_AT, research._query_hash("crossref", str(row["DOI"])))


def test_the_openalex_request_names_every_field_the_adapter_now_reads() -> None:
    """HR-41 for item 1: the empty OpenAlex columns were a request shape, so the request is what changes.

    `fixtures/openalex-select-field-availability.json`: the default representation carries 58 keys —
    `type`, `is_retracted`, `cited_by_count`, `is_paratext` and `referenced_works` among them — while a
    `select=` response carries only the names it was given. The adapter's old list produced exactly its nine
    keys and none of those five, so `_normalize` was reading fields that were never in the answer.
    """
    document = fixture("openalex-select-field-availability.json")
    assert document["adapterSelectList"].split(",") == list(OLD_OPENALEX_SELECT), "the 0.3.14 request shape is the one under test"
    url, _headers, _route = research._request_for("openalex", "corpus iuris canonici", 5)
    select = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["select"][0].split(",")
    assert set(OLD_OPENALEX_SELECT) <= set(select), "a field the adapter used to read is no longer asked for"
    for name in ("type", "is_retracted", "cited_by_count", "is_paratext", "referenced_works"):
        assert name in document["defaultKeys"], f"{name} is not in the default representation the fixture recorded"
        assert name in select, f"`_normalize` reads {name} and the request does not ask for it"
    assert len(select) == len(set(select)) == len(OLD_OPENALEX_SELECT) + 5, "the five names are added; none of the nine is dropped or duplicated"


def test_openalex_answers_are_read_from_the_fields_the_request_named_and_a_real_zero_stays_a_zero() -> None:
    """HR-41 for item 2: `retracted`, `citationCount`, `referenceCount` and `publicationType` come from
    `is_retracted`, `cited_by_count`, `len(referenced_works)` and `type` — and a missing field is not a zero."""
    document = fixture("openalex-coverage-10.32725-cetv.2017.022.json")
    row = document["openalexRow"]
    record = research._normalize("openalex", row, FETCHED_AT, research._query_hash("openalex", COVERAGE_DOI))
    assert record["retracted"]["value"] is False and row["is_retracted"] is False, "OpenAlex answers `is_retracted` for every row it returned, and none of them was retracted"
    assert record["citationCount"]["value"] == 0, "`cited_by_count: 0` is a count the provider sent, not an absence"
    assert record["referenceCount"]["value"] == len(row["referenced_works"]) == 2, "the count is the list the provider carried"
    assert record["publicationType"]["value"] == row["type"] == "article", "the row keeps its own type"
    assert record["date"]["value"] == row["publication_date"] and record["dateField"]["value"] == "publication_date"
    assert record["citationCount"]["provenance"]["provider"] == "openalex"

    blind = {key: value for key, value in row.items() if key not in ("type", "is_retracted", "cited_by_count", "is_paratext", "referenced_works")}
    old_shape = research._normalize("openalex", blind, FETCHED_AT, research._query_hash("openalex", COVERAGE_DOI))
    assert old_shape["retracted"]["value"] is None and old_shape["citationCount"]["value"] is None \
        and old_shape["referenceCount"]["value"] is None, "a field the response never carried is reported as absent — never as a guessed 0"
    assert old_shape["publicationType"]["value"] is None, "and the 0.3.14 shape still reports no type, which is what the fixture proves about it"


def test_the_crossref_date_order_is_the_measured_one_and_names_the_field_it_used() -> None:
    """HR-41 for item 3: `issued` → `published-online` → `published-print` → `created`, recorded as `dateField`.

    Every assertion below reads the `date` and `dateField` the fixture recorded for that DOI. The precedence
    steps beneath the measured one are tested by taking the higher-precedence fields off the same measured
    row, which is the only way to test the order without inventing a work the probe never asked for.
    """
    measured = {row["doi"]: row for row in fixture("crossref-issued-vs-created.json")["rows"]}
    for row in measured_crossref_rows():
        record = normalized_crossref(row)
        claim = measured[str(row["DOI"])]
        assert record["date"]["value"] == claim["date"], f"{claim['doi']}: the date the adapter chose is not the date the probe recorded"
        assert record["dateField"]["value"] == claim["dateField"], f"{claim['doi']}: the record does not say which Crossref field the date came from"
        assert record["year"]["value"] == int(str(claim["date"])[:4]), "the year follows the same field the date came from"

    cetv = normalized_crossref(measured_crossref_row(COVERAGE_DOI))
    assert cetv["date"]["value"] == "2017-03-30" and cetv["dateField"]["value"] == "issued"
    assert cetv["year"]["value"] == 2017, "the work is not dated 2021-10-11, which is when its DOI was registered"

    mediterranean = normalized_crossref(measured_crossref_row("10.1056/nejmoa1200303"))
    assert mediterranean["date"]["value"] == "2013-04-04" and mediterranean["dateField"]["value"] == "issued", \
        "this is the measured row where `created` (2013-02-25) precedes `issued` (2013-04-04): an earlier registration date does not outrank the publication date"

    nature = measured_crossref_row("10.1038/nature00870")
    without_issued = {key: value for key, value in nature.items() if key != "issued"}
    online = normalized_crossref(without_issued)
    assert online["date"]["value"] == "2002-06-20" and online["dateField"]["value"] == "published-online", "the second field in the order is `published-online`, and it beats `published-print` (2002-07-04)"
    printed = normalized_crossref({key: value for key, value in without_issued.items() if key != "published-online"})
    assert printed["date"]["value"] == "2002-07-04" and printed["dateField"]["value"] == "published-print", "third comes `published-print`, still before `created` (2002-07-28)"

    registration_only = normalized_crossref(measured_crossref_row("10.2307/j.ctt28524j.7"))
    assert registration_only["dateField"]["value"] == "created" and registration_only["date"]["value"] == "2017-09-07"
    assert any("DOI_REGISTRATION" in warning for warning in registration_only["warnings"]), \
        "`created` may be used when nothing else exists, but never silently: the record names what it used"


def test_the_adapter_reads_a_crossref_retraction_from_updated_by_and_its_absence_as_unknown() -> None:
    """HR-41 for item 4: `updated-by` entries of type `retraction` become `retracted`; no `updated-by` is `None`.

    The scan is over every entry: two of the three measured rows lead with a `correction` or an `erratum`, so
    reading only the first entry would have reported "not retracted" for a retracted Lancet paper.
    """
    for doi in RETRACTION_DOIS:
        name = f"crossref-retraction-{doi.replace('/', '_').replace('(', '').replace(')', '')}.json"
        measurement = fixture(name)
        route = measurement["routes"]["singleDoiRoute"]
        raw = dict(measured_crossref_row(doi))
        raw["updated-by"] = measurement["redactedRows"]["singleDoiRoute"]["updated-by"]
        raw["is-referenced-by-count"] = route["citationCount"]
        raw["reference-count"] = route["referenceCount"]
        record = normalized_crossref(raw)
        assert record["retracted"]["value"] is True, f"{doi}: `updated-by` named a retraction and the adapter did not read it"
        assert record["citationCount"]["value"] == route["citationCount"] and record["referenceCount"]["value"] == route["referenceCount"], f"{doi}: Crossref's own counts are not carried into the record"
        assert record["date"]["value"] == route["date"] and record["dateField"]["value"] == route["dateField"], f"{doi}: the retraction row lost its date"

    search_shape = dict(measured_crossref_row("10.1056/nejmoa1200303"))
    assert "updated-by" not in search_shape, "the fixture's plain rows carry no `updated-by`, which is the shape the receipt measured 25 of 25 times"
    assert normalized_crossref(search_shape)["retracted"]["value"] is None, \
        "absence is reported as absence: 0 of 25 plain search rows carried `updated-by`, so `False` here would be a claim the route never made"

    lancet = fixture("crossref-retraction-10.1016_S0140-67369711096-0.json")
    corrections_only = dict(measured_crossref_row("10.1016/S0140-6736(97)11096-0"))
    corrections_only["updated-by"] = [entry for entry in lancet["redactedRows"]["singleDoiRoute"]["updated-by"]
                                      if entry.get("type") != "retraction"]
    assert corrections_only["updated-by"], "the measured row carries a correction beside its retraction, so this is a real shape"
    assert normalized_crossref(corrections_only)["retracted"]["value"] is False, "a present `updated-by` with no retraction entry is the only answer allowed to say False"


def test_the_type_families_the_adapter_builds_are_the_measured_vocabulary() -> None:
    """HR-41 for item 5: book-like and chapter-like are named sets, and the filter is one repeated value.

    The measured proof is `filter=type:book,doi:10.2307/j.ctt28524j.7` → 0 rows against
    `filter=type:book-chapter,doi:…` → 1 row. The Toolkit ships no request that filters Crossref by type
    today (the only place a Crossref `type` is compared is the RIS record type), so this test holds the
    builder to the measured vocabulary instead of pretending a filter was run.
    """
    counts = fixture("crossref-type-vocabulary.json")["filterCounts"]
    book_filter = research.crossref_type_filter("book")
    chapter_filter = research.crossref_type_filter("chapter")
    assert research.CROSSREF_BOOK_TYPES == ("book", "monograph", "edited-book", "book-set", "reference-book")
    assert research.CROSSREF_CHAPTER_TYPES == ("book-chapter", "book-part")
    for name in research.CROSSREF_BOOK_TYPES:
        assert name in counts and "reported" in counts[name], f"{name} is not a Crossref type this run measured a count for"
        assert name in book_filter.split(":", 1)[1].split(","), f"a filter meaning 'books' leaves out {name}, which is the defect this replaces"
    for name in research.CROSSREF_CHAPTER_TYPES:
        assert name in counts["typesSeenForQuery"], f"no plain query ever returned {name}, so naming it as a family is unmeasured"
    assert set(research.CROSSREF_BOOK_TYPES).isdisjoint(research.CROSSREF_CHAPTER_TYPES), "the families overlap, so a filter cannot say which member a row matched"
    assert book_filter.startswith("type:") and book_filter.count(",") == len(research.CROSSREF_BOOK_TYPES) - 1, \
        "one repeated `type:` clause — Crossref reads repeated values in one filter name as an OR"
    assert chapter_filter == "type:book-chapter,book-part"
    assert counts["union:book-chapter"]["returned"] == 1 and counts["union:book-chapter"]["typeSeen"] == "book-chapter"
    for neighbouring in ("book", "monograph", "edited-book"):
        assert counts[f"union:{neighbouring}"]["returned"] == 0, f"{neighbouring} returned the chapter row, so the family claim has to be re-read"
    with pytest.raises(research.ResearchError) as error:
        research.crossref_type_filter("publication")
    assert error.value.code == "PROVIDER_TYPE_FAMILY_UNKNOWN", "an unknown family is refused, not silently narrowed to one name"


def test_a_doi_query_takes_the_routes_the_coverage_measurement_proved_and_says_which_one_it_took() -> None:
    """HR-41 for item 6: a DOI is looked up by DOI. `search=<doi>` returned 0 rows for this work in this run.

    The route is named in the outcome (see `test_a_doi_query_is_looked_up_not_searched_in_research.py`), so a
    receipt says how an answer was found instead of leaving a 0 to be read as 'the work does not exist'.
    """
    document = fixture("openalex-coverage-10.32725-cetv.2017.022.json")
    assert document["openalexFreeTextDoiQuery"]["reported"] == 0 and document["openalexDoiFilter"]["reported"] == 1
    assert document["openalexDoiFilter"]["foundWork"] is True and document["crossrefDoiRoute"]["foundWork"] is True

    url, _headers, route = research._request_for("openalex", COVERAGE_DOI, 5)
    assert route == "openalex-doi-filter" and "search=" not in url, url
    assert "filter=doi%3A10.32725%2Fcetv.2017.022" in url, url
    assert all(name in url for name in OLD_OPENALEX_SELECT), "the DOI route asks for the same fields as the search route"

    url, _headers, route = research._request_for("crossref", COVERAGE_DOI, 5)
    assert route == "crossref-single-doi" and url == f"https://api.crossref.org/works/{urllib.parse.quote(COVERAGE_DOI, safe='/')}", url

    url, _headers, route = research._request_for("openalex", "canon law", 5)
    assert route == "openalex-search" and "search=canon+law" in url and "filter=" not in url, "a query that is not a DOI takes exactly the 0.3.14 path"
    url, _headers, route = research._request_for("crossref", "canon law", 5)
    assert route == "crossref-bibliographic" and "query.bibliographic=canon+law" in url, "and the same for Crossref"


def test_the_semantic_scholar_request_asks_for_the_new_fields_without_claiming_what_it_never_saw() -> None:
    """HR-41 for item 7: `fields=` carries the four names and keeps `externalIds`; their fill is not claimed.

    The 22 November run reached Semantic Scholar exactly once, anonymously, and it answered 429. So the only
    honest assertions here are about what the request asks for and about what the adapter does when a field
    is not there — a synthetic row, labelled as one, standing in for a provider that was never reached.
    """
    url, _headers, _route = research._request_for("semantic_scholar", "canon law", 5)
    fields = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)["fields"][0].split(",")
    for name in ("publicationTypes", "citationCount", "referenceCount", "isRetracted"):
        assert name in fields, f"{name} is not asked for, so reading it back would read nothing"
    assert "externalIds" in fields, "the DOI the merge keys on comes from `externalIds`: dropping it breaks merging, not just a column"

    row = {"paperId": "adapter-shape-1", "title": "Adapter-shape row", "externalIds": {"DOI": "10.1234/adapter-shape"}}
    record = research._normalize("semantic_scholar", row, FETCHED_AT, research._query_hash("semantic_scholar", "adapter-shape"))
    assert record["retracted"]["value"] is None and record["citationCount"]["value"] is None and record["referenceCount"]["value"] is None, \
        "a provider that sent nothing is reported as having sent nothing — this row is the Toolkit's own shape, not a Semantic Scholar measurement"
    filled = research._normalize("semantic_scholar", {**row, "citationCount": 0, "referenceCount": 7, "isRetracted": False, "publicationTypes": ["JournalArticle"]},
                                 FETCHED_AT, research._query_hash("semantic_scholar", "adapter-shape"))
    assert filled["citationCount"]["value"] == 0 and filled["referenceCount"]["value"] == 7 and filled["retracted"]["value"] is False
    assert filled["publicationType"]["value"] == "JournalArticle", "the first type the provider sent is the one displayed"

    receipt = json.loads((EVIDENCE / "receipt.json").read_text(encoding="utf-8"))
    assert receipt["providers"]["semanticScholar"]["rawAnonymous"]["status"] == 429
    assert any("Semantic Scholar" in item for item in receipt["notProven"]), "the run records that Semantic Scholar field fill was not measured"
    summary = (EVIDENCE / "summary.md").read_text(encoding="utf-8")
    assert "Semantic Scholar field fill could not be measured" in summary, "and the summary says the same, so no test may claim a fill rate"


def test_stored_consent_is_the_fact_and_the_environment_switch_is_only_the_switch(
        isolated_budget: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """HR-41 for item 7's consent half: a stored decision is read from the facts file; the env var is the
    switch the extension carries, and a stored consent never licenses a process by itself.

    This is the pair the operator saw in the field: the card said confirmed, the check behaved as
    unconfirmed. `PROVIDER_TERMS_STORED_BUT_NOT_INJECTED` is the named state for exactly that, and the
    extension carries the stored instant and the stored key decision so the worker stops reading a recorded
    confirmation as a missing one (`extension/test/integrations.test.js` covers the host half).
    """
    acknowledged_at = "2026-11-22T09:15:00+00:00"
    machinefacts.write_state("semantic_scholar", mode="anonymous", updated_at_ms=1_763_000_000_000,
                             license_acknowledged_at=acknowledged_at, key_decision="declined")
    stored = machinefacts.read_provider_state()["semantic_scholar"]
    assert stored["licenseAcknowledgedAt"] == acknowledged_at and stored["keyDecision"] == "declined"

    monkeypatch.delenv("SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED", raising=False)
    monkeypatch.setattr(research, "_request_json", lambda *_args: pytest.fail("a stored consent must not license a request of its own"))
    with pytest.raises(research.ResearchError) as refused:
        research.search_literature("semantic_scholar", "corpus iuris canonici", 1)
    assert refused.value.code == "PROVIDER_TERMS_NOT_ACKNOWLEDGED"

    report = integrations.probe_semantic_scholar()
    assert report["termsState"] == "PROVIDER_TERMS_STORED_BUT_NOT_INJECTED", "the state that names 'recorded here, never handed to this process'"
    assert report["code"] == "PROVIDER_TERMS_STORED_BUT_NOT_INJECTED" and report["accessState"] == "consent-stored-not-injected"
    assert report["providerState"]["licenseAcknowledgedAt"] == acknowledged_at, "the receipt reads the stored instant from the facts file instead of inventing one"
    assert report["providerState"]["keyDecision"] == "declined", "and the key decision the operator gave is not lost"

    monkeypatch.setenv("SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED", "true")
    monkeypatch.setenv("SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED_AT", acknowledged_at)
    monkeypatch.setenv("SEMANTIC_SCHOLAR_KEY_DECISION", "provided")
    monkeypatch.setattr(research, "search_literature", lambda *_args, **_kwargs: (_ for _ in ()).throw(
        research.ResearchError("PROVIDER_UNAVAILABLE", "no live provider in this test")))
    carried = integrations.probe_semantic_scholar()
    assert carried["termsState"] == "PROVIDER_TERMS_ACKNOWLEDGED", "the switch is what lets this process ask, and only the switch"
    assert machinefacts.read_provider_state()["semantic_scholar"]["licenseAcknowledgedAt"] == acknowledged_at, \
        "the instant written to the machine record is the one the extension carried, not one this probe made up"
    assert machinefacts.read_provider_state()["semantic_scholar"]["keyDecision"] == "provided"


def test_an_in_flight_sibling_is_named_as_another_check_and_not_as_a_rate_limit(
        isolated_budget: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """HR-41 for item 9: `deferred == "in-flight"` becomes `PROVIDER_BUDGET_DEFERRED` with the wait carried.

    The provider was not refused and never said 429: a second Toolkit process is holding the key for this
    exact query. Telling the operator "rate limit" sends them to the wrong page and invites them to authorize
    something again that is already authorized.
    """
    holder = provider_budget.ProviderBudget("openalex", directory=isolated_budget)
    assert holder._reserve("anon:query-9", None) is True, "a sibling is asking this exact query right now"
    monkeypatch.setattr(research, "_request_json", lambda *_args: pytest.fail("a deferred request never reaches the transport"))
    monkeypatch.setattr(research, "_LAST_REQUEST_AT", {})
    monkeypatch.setattr(research, "_THROTTLE_LOCKS", {name: __import__("threading").Lock() for name in research._THROTTLE_LOCKS})
    with pytest.raises(research.ResearchError) as deferred:
        research._provider_request("openalex", "https://api.openalex.org/works?search=corpus%20iuris", cache_key="query-9")
    message = str(deferred.value)
    assert deferred.value.code == "PROVIDER_BUDGET_DEFERRED"
    assert "already asking openalex this exact query" in message and "held back" in message
    assert "rate limit" not in message.lower(), "an in-flight deferral is not a rate limit, and the wording must not say one"
    assert 1 <= int(deferred.value.retry_after) <= provider_budget.CLAIM_STALE_MS // 1000, \
        "the wait the shared budget named is carried to the caller as `retryAfter`, in whole seconds"
    assert json.loads((isolated_budget / "cache-openalex.json").read_text(encoding="utf-8"))["claims"]["anon:query-9"]["owner"] == holder.owner, \
        "the deferral left the sibling's claim where it found it"
