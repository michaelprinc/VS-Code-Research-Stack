"""Phase 14 (0.3.13): the Zotero read tool, the gated write tool, the snapshot and the RIS check.

Every Zotero behaviour here is answered by a scripted stand-in for the loopback server, in the house style
of `test_research.py`: no test reaches a port. The stand-in answers with the status codes the operator
measured against a real Zotero 10.0.8 on 14 November 2026 — 428 for a write with no version guard, 412 for
a write that raced a change, 401 with `WWW-Authenticate: Zotero-API-Key` for a write with no key.
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request

import pytest

from research_stack import research, zotero_store

ITEM_KEY = "ABCD1234"
ITEM_VERSION = 7
ITEM_DATA = {
    "key": ITEM_KEY,
    "version": ITEM_VERSION,
    "data": {
        "key": ITEM_KEY,
        "itemType": "journalArticle",
        "title": "Kodex kanonického práva",
        "creators": [{"creatorType": "author", "lastName": "Author", "firstName": "Ada"}],
        "date": "1983",
        "DOI": "10.1234/x",
        "tags": [{"tag": "access/metadata_only"}],
        "collections": [],
    },
}
ITEM_TYPES = [{"itemType": itemType} for itemType in ("book", "bookSection", "document", "journalArticle", "report", "standard", "statute", "thesis")]


class _Answer:
    def __init__(self, body: bytes, headers: dict[str, str]) -> None:
        self.body, self.headers = body, headers

    def read(self, *_args) -> bytes:
        return self.body

    def __enter__(self) -> "_Answer":
        return self

    def __exit__(self, *_args) -> bool:
        return False


class _ScriptedZotero:
    """A loopback Zotero that answers the endpoints 0.3.13 uses and records every request it received."""

    def __init__(self, *, library: list[dict[str, object]] | None = None, fulltext_empty: bool = True) -> None:
        self.items = {ITEM_KEY: json.loads(json.dumps(ITEM_DATA))} if library is None else {str(row["key"]): row for row in library}
        self.fulltext_empty = fulltext_empty
        self.requests: list[dict[str, object]] = []
        self.writes: list[dict[str, object]] = []

    def open(self, request, timeout=None):  # type: ignore[no-untyped-def]
        url = request.full_url
        path = url.split("/api", 1)[1] if "/api" in url else url
        method = request.get_method()
        headers = {name.lower(): value for name, value in request.header_items()}
        self.requests.append({"method": method, "path": path, "headers": headers, "body": request.data})
        if path in ("", "/"):
            return _Answer(b"Zotero local API", {"zotero-server-id": "fixture-server", "zotero-api-version": "3"})
        if path.startswith("/itemTypes"):
            return _Answer(json.dumps(ITEM_TYPES).encode(), {})
        if path.startswith("/users/0/items/") and "/fulltext" in path:
            return _Answer(b"canon 1006 \xc2\xa7 text", {"content-type": "text/plain"})
        if path.startswith("/users/0/fulltext"):
            if "since=" not in path:
                raise self._refused(400, "Bad Request", b'{"error":"since is required"}')
            return _Answer(b"{}" if self.fulltext_empty else b'{"ABCD1234":"canon text"}', {})
        if path.startswith("/users/0/tags"):
            return _Answer(json.dumps([{"data": {"tag": "access/metadata_only"}}, {"data": {"tag": "topic/canon-law"}}]).encode(), {"zotero-total-results": "2"})
        if path.startswith("/users/0/searches"):
            return _Answer(b"[]", {"zotero-total-results": "0"})
        if path.startswith("/users/0/collections"):
            if method == "HEAD":
                return _Answer(b"", {"zotero-server-id": "fixture-server"})
            if method == "POST":
                self._require_key(headers)
                name = json.loads(request.data or b"{}").get("name")
                return _Answer(json.dumps({"key": "COLLEC11", "data": {"name": name}}).encode(), {})
            return _Answer(json.dumps([{"key": "COLLEC11", "data": {"name": "CIC-1983", "parentCollection": False}}]).encode(), {"zotero-total-results": "1"})
        if path.startswith("/users/0/items"):
            if method == "POST":
                self._require_key(headers)
                body = json.loads(request.data or b"{}")
                self.writes.append({"op": "create_item", "body": body})
                return _Answer(json.dumps({"key": "NEWITEM1", "version": 8, "data": body}).encode(), {})
            if "format=bibtex" in path or "format=csv" in path:
                return _Answer(b"@article{a,\n title = {Kodex},\n annote = {access/metadata_only}\n}\n", {})
            if "format=csljson" in path:
                return _Answer(json.dumps([{"id": ITEM_KEY, "title": "Kodex kanonického práva", "type": "article"}]).encode(), {})
            if "?q=" in path or "&q=" in path:
                rows = list(self.items.values())
                return _Answer(json.dumps(rows).encode(), {"zotero-total-results": str(len(rows) + 4)})
            if "format=json" in path and "limit=1&" in path:
                return _Answer(json.dumps([self.items[ITEM_KEY]]).encode(), {"zotero-total-results": "43"})
            if "start=" in path:
                return _Answer(json.dumps(list(self.items.values())).encode(), {"zotero-total-results": "1"})
            key = path.split("/items/")[1].split("?")[0]
            if key not in self.items:
                raise self._refused(404, "Not Found", b'{"error":"Not found"}')
            if method == "PUT":
                self._require_key(headers)
                guard = headers.get("if-unmodified-since-version")
                if not guard:
                    raise self._refused(428, "Precondition Required", b'{"error":"If-Unmodified-Since-Version required"}')
                if int(guard) != int(self.items[key]["version"]):
                    raise self._refused(412, "Precondition Failed", b'{"error":"version mismatch"}')
                self.items[key] = {"key": key, "version": int(guard) + 1, "data": json.loads(request.data or b"{}")}
                self.writes.append({"op": "put", "key": key, "body": json.loads(request.data or b"{}")})
                return _Answer(b"", {})
            return _Answer(json.dumps(self.items[key]).encode(), {})
        raise self._refused(404, "Not Found", b'{"error":"No such endpoint"}')

    def _require_key(self, headers: dict[str, str]) -> None:
        if not headers.get("zotero-api-key"):
            raise self._refused(401, "Unauthorized", b'{"error":"No key"}', {"WWW-Authenticate": 'Zotero-API-Key realm="Zotero Local API"'})

    def _refused(self, code: int, reason: str, body: bytes, headers: dict[str, str] | None = None) -> urllib.error.HTTPError:
        return urllib.error.HTTPError("http://127.0.0.1:23119/api", code, reason, headers or {}, io.BytesIO(body))


@pytest.fixture()
def zotero(monkeypatch: pytest.MonkeyPatch) -> _ScriptedZotero:
    server = _ScriptedZotero()
    monkeypatch.setattr(research.urllib.request, "build_opener", lambda *_args: server)
    monkeypatch.delenv(research.ZOTERO_WRITE_KEY_ENV, raising=False)
    return server


# --- reading ---

def test_status_reports_what_this_zotero_answers_without_guessing(zotero: _ScriptedZotero) -> None:
    result = research.zotero_library_status()
    assert result["readOnly"] is True
    assert {"api-root", "collections", "items", "tags", "searches", "fulltext", "itemTypes"} <= set(result["answeredEndpoints"])
    assert result["counts"] == {"items": "43", "tags": 2, "savedSearches": 0}
    assert result["writeKeyPresent"] is False
    assert result["serverId"] == "fixture-server"
    # An empty full-text answer is reported with what it does and does not mean.
    assert "not proof" in result["fullTextProbe"]["note"]


def test_status_survives_one_refused_endpoint(zotero: _ScriptedZotero, monkeypatch: pytest.MonkeyPatch) -> None:
    original = zotero.open

    def half_working(request, timeout=None):  # type: ignore[no-untyped-def]
        if "/users/0/tags" in request.full_url:
            raise urllib.error.HTTPError("http://127.0.0.1:23119/api", 404, "Not Found", {}, io.BytesIO(b'{"error":"gone"}'))
        return original(request, timeout)

    monkeypatch.setattr(zotero, "open", half_working)
    result = research.zotero_library_status()
    refused = {probe["endpoint"]: probe for probe in result["endpoints"] if probe["state"] == "refused"}
    assert refused == {"tags": {"endpoint": "tags", "state": "refused", "code": "ZOTERO_NOT_FOUND", "said": '404 Not Found {"error":"gone"}'}}
    assert result["counts"]["items"] == "43", "one refused endpoint must not discard the rest of the read"


def test_export_refuses_a_format_the_local_api_does_not_answer_with_before_any_request(zotero: _ScriptedZotero) -> None:
    with pytest.raises(research.ResearchError) as error:
        research.zotero_export("markdown")
    assert error.value.code == "ZOTERO_EXPORT_FORMAT_UNSUPPORTED"
    assert zotero.requests == [], "a refusal has to precede the request it would have made"


def test_export_says_whether_access_labels_survive_the_format(zotero: _ScriptedZotero) -> None:
    csl = research.zotero_export("csljson")
    bibtex = research.zotero_export("bibtex")
    assert csl["accessLabelsInExport"] is False and "annote" not in csl["body"]
    assert bibtex["accessLabelsInExport"] is True and "annote" in bibtex["body"]


def test_library_search_reports_that_it_truncated(zotero: _ScriptedZotero) -> None:
    result = research.search_zotero_items("canon", limit=200)
    assert result["returned"] == 1
    assert result["totalResults"] == "5"
    assert result["truncated"] is True
    assert result["items"][0]["itemType"] == "journalArticle"


def test_fulltext_reads_the_item_endpoint_and_the_index_endpoint(zotero: _ScriptedZotero) -> None:
    one = research.zotero_fulltext(key=ITEM_KEY)
    assert one["fullTextAvailable"] is True and "canon" in one["text"]
    index = research.zotero_fulltext(query="canon")
    assert index["matches"] == []
    assert "not proof" in index["note"]
    index_requests = [entry for entry in zotero.requests if str(entry["path"]).startswith("/users/0/fulltext")]
    assert index_requests and all("since=0" in str(entry["path"]) for entry in index_requests), "the index endpoint answers 400 without `since`"


# --- writing: the gates first ---

def test_preview_sends_nothing_and_shows_the_exact_body_and_guard(zotero: _ScriptedZotero) -> None:
    plan = research.zotero_write_preview([{"op": "set_item_type", "key": ITEM_KEY, "itemType": "statute"}])
    assert plan["dryRun"] is True and plan["zoteroModified"] is False
    assert zotero.writes == []
    step = plan["planned"][0]
    assert step["method"] == "PUT" and step["guard"] == ITEM_VERSION
    assert step["body"]["itemType"] == "statute"
    assert step["changedFields"] == ["itemType"]
    assert step["before"] == {"itemType": "journalArticle"}


def test_apply_without_the_confirmation_literal_never_reaches_zotero(zotero: _ScriptedZotero, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(research.ZOTERO_WRITE_KEY_ENV, "fixture-key")
    with pytest.raises(research.ResearchError) as error:
        research.zotero_write_apply([{"op": "set_item_type", "key": ITEM_KEY, "itemType": "statute"}], confirm="yes")
    assert error.value.code == "WRITE_CONFIRM_REQUIRED"
    assert zotero.requests == []


def test_apply_without_a_key_reports_the_401_zotero_actually_gives(zotero: _ScriptedZotero) -> None:
    with pytest.raises(research.ResearchError) as error:
        research.zotero_write_apply([{"op": "create_collection", "name": "CIC-1983"}], confirm=research.ZOTERO_WRITE_CONFIRM)
    assert error.value.code == "ZOTERO_WRITE_KEY_MISSING"
    assert zotero.requests == [], "the Toolkit refuses before it makes Zotero answer 401"


def test_every_write_carries_the_version_guard_that_keeps_428_off(zotero: _ScriptedZotero, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(research.ZOTERO_WRITE_KEY_ENV, "fixture-key")
    result = research.zotero_write_apply([{"op": "add_tags", "key": ITEM_KEY, "tags": ["topic/canon-law"]}], confirm=research.ZOTERO_WRITE_CONFIRM)
    write = [entry for entry in zotero.requests if entry["method"] == "PUT"][-1]
    assert write["headers"]["if-unmodified-since-version"] == str(ITEM_VERSION)
    assert write["headers"]["zotero-api-key"] == "fixture-key"
    assert result["zoteroModified"] is True and result["applied"][0]["undoable"] is True
    sent_tags = [tag["tag"] for tag in json.loads(write["body"].decode("utf-8"))["tags"]]
    assert "topic/canon-law" in sent_tags and "access/metadata_only" in sent_tags, "an add keeps the tags the item already had"


def test_a_write_that_races_a_change_is_refused_and_overwrites_nothing(zotero: _ScriptedZotero, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(research.ZOTERO_WRITE_KEY_ENV, "fixture-key")
    original = zotero.open

    def changed(request, timeout=None):  # type: ignore[no-untyped-def]
        if request.get_method() == "PUT":
            raise urllib.error.HTTPError("http://127.0.0.1:23119/api", 412, "Precondition Failed", {}, io.BytesIO(b'{"error":"changed"}'))
        return original(request, timeout)

    monkeypatch.setattr(zotero, "open", changed)
    with pytest.raises(research.ResearchError) as error:
        research.zotero_write_apply([{"op": "update_fields", "key": ITEM_KEY, "fields": {"date": "1983"}}], confirm=research.ZOTERO_WRITE_CONFIRM)
    assert error.value.code == "ZOTERO_WRITE_CONFLICT"


def test_a_client_that_sends_no_guard_gets_the_428_the_operator_measured(zotero: _ScriptedZotero, monkeypatch: pytest.MonkeyPatch) -> None:
    """The 428 is proof the guard is not decoration: without it Zotero refuses the write outright."""
    monkeypatch.setenv(research.ZOTERO_WRITE_KEY_ENV, "fixture-key")
    with pytest.raises(research.ResearchError) as error:
        research._zotero_request(f"users/0/items/{ITEM_KEY}", timeout=5, method="PUT", body={"title": "x"}, extra_headers={"Zotero-API-Key": "fixture-key"}, write=True)
    assert error.value.code == "ZOTERO_WRITE_VERSION_REQUIRED"


def test_delete_and_merge_are_refused_by_name_before_any_request(zotero: _ScriptedZotero) -> None:
    for op in ("delete", "delete_item", "merge", "duplicate_check"):
        with pytest.raises(research.ResearchError) as error:
            research.zotero_write_preview([{"op": op, "key": ITEM_KEY}])
        assert error.value.code == "ZOTERO_WRITE_ACTION_UNSUPPORTED"
        assert "no restore" in str(error.value) or "no merge" in str(error.value)
    assert zotero.requests == []


def test_a_tag_outside_the_vocabulary_is_refused(zotero: _ScriptedZotero) -> None:
    with pytest.raises(research.ResearchError) as error:
        research.zotero_write_preview([{"op": "add_tags", "key": ITEM_KEY, "tags": ["important stuff"]}])
    assert error.value.code == "ZOTERO_TAG_OUT_OF_VOCABULARY"
    assert [entry for entry in zotero.requests if entry["method"] in ("PUT", "POST")] == [], "the item may be read, nothing may be written"


def test_an_item_type_zotero_does_not_list_is_refused(zotero: _ScriptedZotero) -> None:
    with pytest.raises(research.ResearchError) as error:
        research.zotero_write_preview([{"op": "set_item_type", "key": ITEM_KEY, "itemType": "canonicalDecree"}])
    assert error.value.code == "ZOTERO_ITEM_TYPE_UNKNOWN"
    assert "statute" in str(error.value)


def test_undo_replays_the_journal_and_refuses_an_item_that_moved(zotero: _ScriptedZotero, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(research.ZOTERO_WRITE_KEY_ENV, "fixture-key")
    applied = research.zotero_write_apply([{"op": "set_item_type", "key": ITEM_KEY, "itemType": "statute"}], confirm=research.ZOTERO_WRITE_CONFIRM)
    undone = research.zotero_write_undo(applied["applied"])
    assert undone["undone"] == [{"key": ITEM_KEY, "restoredFields": ["itemType"]}]
    assert research.zotero_write_undo([{"key": ITEM_KEY, "undoable": False}])["refused"][0]["reason"].startswith("recorded as not undoable")


# --- snapshot and journal (workspace files) ---

def test_snapshot_is_a_new_file_in_the_workspace_and_says_when_it_is_truncated(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    server = _ScriptedZotero()
    monkeypatch.setattr(research.urllib.request, "build_opener", lambda *_args: server)
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(tmp_path))
    written = zotero_store.write_snapshot(research.zotero_snapshot_document())
    assert written["itemCount"] == 1 and written["truncated"] is False
    assert (tmp_path / written["path"]).is_file()
    assert written["path"].startswith(zotero_store.SNAPSHOT_DIRECTORY)


def test_journal_keeps_the_before_values_and_names_what_it_dropped(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(tmp_path))
    applied = [{"op": "update_fields", "key": ITEM_KEY, "undoable": True, "before": {"title": "the title before the write " * 40}, "changedFields": ["title"]},
               {"op": "create_item", "key": "NEWITEM1", "undoable": False, "before": {"note": "far too large to keep " * 400}, "changedFields": []}]
    journal = zotero_store.write_journal(applied, snapshot={"path": ".research-toolkit/zotero-snapshots/x.json"})
    assert journal["bytes"] <= zotero_store.JOURNAL_MAX_BYTES
    assert journal["droppedEntries"] == 1 and journal["truncated"] is True
    read_back = zotero_store.read_journal(journal["journalId"])
    assert read_back["entries"][0]["before"]["title"].startswith("the title before the write")
    assert read_back["snapshot"] == ".research-toolkit/zotero-snapshots/x.json"


def test_an_undo_needs_a_real_journal_id(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(tmp_path))
    with pytest.raises(research.ResearchError) as error:
        zotero_store.read_journal("../../etc/passwd")
    assert error.value.code == "ZOTERO_JOURNAL_ID_INVALID"


def test_count_check_compares_what_zotero_said_before_and_after(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    server = _ScriptedZotero()
    monkeypatch.setattr(research.urllib.request, "build_opener", lambda *_args: server)
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(tmp_path))
    snapshot = research.zotero_snapshot_document()
    after = research.zotero_library_status()
    check = zotero_store.count_check(snapshot, after)
    assert check["consistent"] is True and check["before"] == "1" and check["after"] == "43"


# --- RIS ---

def test_ris_maps_the_types_the_translator_gets_wrong() -> None:
    text = research.to_ris([
        {"title": "Kodex kanonického práva", "publicationType": "statute", "doi": "10.1234/a", "tags": ["access/metadata_only", "topic/canon-law"]},
        {"title": "A dissertation", "publicationType": "thesis", "doi": "10.1234/b"},
    ])
    assert "TY  - STAT" in text and "TY  - THES" in text
    assert "KW  - access/metadata_only" in text and "KW  - topic/canon-law" in text
    assert "N1" not in text, "status lives in the filterable KW tag, never in a child note"


def test_validator_catches_the_shape_that_produced_61_empty_items() -> None:
    broken = "TY  - JOUR\nTY  - JOUR\nAU  - Someone\nPY  - 1998\nPY  - 1999\nXX  - junk\nthis is not a RIS line\nER  - \n"
    check = research.validate_ris_text(broken)
    found = {problem["problem"] for problem in check["problems"]}
    assert {"duplicate-record-marker", "repeated-field", "malformed-line", "unknown-tag"} <= found
    assert check["valid"] is False


def test_validator_warns_about_what_it_must_not_delete() -> None:
    text = research.to_ris([{"title": "Kodex", "publicationType": "GEN"}])
    check = research.validate_ris_text(text, expect=1)
    warned = {warning["problem"] for warning in check["warnings"]}
    assert {"generic-record-type", "record-without-identifier"} <= warned
    assert check["valid"] is True, "a record with no identifier is a record, not a defect to discard"
    assert research.validate_ris_text(text, expect=2)["valid"] is False


def test_the_generator_passes_its_own_validator() -> None:
    text = research.to_ris([{"title": "Evidence", "publicationType": "journal-article", "doi": "10.1/x", "authors": ["Ada Author"], "year": 2024}])
    assert research.validate_ris_text(text, expect=1)["valid"] is True


def test_a_zotero_that_refuses_every_read_is_reported_as_refused_not_as_an_empty_library(monkeypatch: pytest.MonkeyPatch) -> None:
    server = _ScriptedZotero()

    def refusing(request, timeout=None):  # type: ignore[no-untyped-def]
        raise urllib.error.HTTPError("http://127.0.0.1:23119/api", 403, "Forbidden", {}, io.BytesIO(b'{"error":"Local API is not enabled"}'))

    monkeypatch.setattr(research.urllib.request, "build_opener", lambda *_args: server)
    monkeypatch.setattr(server, "open", refusing)
    status = research.zotero_library_status()
    assert status["answeredEndpoints"] == [] and status["counts"] == {}
    assert status["libraryEmpty"] is None, "an unreadable library is not evidence that the library has items in it"
    assert {probe["code"] for probe in status["endpoints"]} == {"ZOTERO_API_DISABLED"}
