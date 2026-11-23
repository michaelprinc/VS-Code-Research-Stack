"""0.3.15: Zotero collections — the shapes a real Zotero 10.0.8 answers, and what the Toolkit proves after a write.

The ground truth is the operator's measurement of 18/19 November 2026 against a real Zotero 10.0.8 local API
on 127.0.0.1:23119 (user 0), cited throughout this file by its evidence label:

* **P1** `POST users/0/collections` with an OBJECT body → `400 {"error":"Uploaded data must be a JSON array"}`;
  with an ARRAY body → `200 {"success":{"0":"KEY"},"failed":{}}`. Same on `POST users/0/items`.
* **P2** two collections with the same name are two collections with two keys: a name is not an identifier.
* **P3** `parentCollection` in the collection body works, and `data.parentCollection` returns the parent key.
* **P4** membership is set by `PUT`/`PATCH` on the ITEM with `collections:[key]` → 204;
  `POST /collections/<key>/items` → 405; `PATCH` on a document NOTE with `collections` → 500.
* **P5** `GET /collections/<key>/items` → 200 with the items AND their notes (43 items → 93 records) and it
  answers `?format=csljson|bibtex|csv`; `GET /items?collection=<key>` is IGNORED; `?noCollections=1` is
  IGNORED; `GET /collections/<key>/tags` → 404.
* **P6** a whole-library export carries no membership at all; csljson includes the notes (93 records),
  bibtex does not (43).
* **P7** `PATCH /collections/<key>` renames (204). The Toolkit has no rename operation and this suite proves
  none is smuggled in as a side effect.
* **P8** special collections are invisible to the local API: `GET /collections/<key>` → 404.
* **P9** the real run: `projekty` (KV9DK2XF) → child `projekt/krestanstvi` (2UYDMSR2), 43 items filed (43× 204),
  library version 342 → 385, `numItems: 43`.

No Zotero exists in this container and no test reaches a port — the rule `test_zotero_library.py` states and the
reason T12-40 pins the endpoint. The emulator below stands in for the loopback server and answers the pinned
`127.0.0.1:23119` URL with the measured codes and shapes; every scenario disposes its disposable library
through a test finalizer. A real Zotero 10 write is still owed (T14-20) and nothing here claims one.
"""

from __future__ import annotations

import io
import itertools
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from research_stack import recommended_server, research, zotero_store

SERVER_ID = "emulated-zotero-10.0.8"
# The keys the operator's real library gave these two collections (P9). Using them here keeps each scenario
# readable against the measurement it is modelled on; nothing in the Toolkit knows them.
PROJECT_KEY = "KV9DK2XF"
CHILD_KEY = "2UYDMSR2"
SPECIAL_KEY = "MY000PUB"  # a special collection has no key this API will answer for (P8)
ITEM_KEYS = [f"ITEM{index:04d}" for index in range(1, 44)]  # 43 items, like the measured library
NOTE_KEYS = [f"NOTE{index:04d}" for index in range(1, 51)]  # 50 child notes → 93 records (P5)
ITEM_TYPES = [{"itemType": itemType} for itemType in ("book", "bookSection", "document", "journalArticle", "note", "report", "standard", "statute", "thesis")]
WRITE_KEY = "disposable-fixture-write-key"


def _measured_library() -> list[dict[str, Any]]:
    """43 top-level items and 50 child notes, nothing filed — the state the operator's library was in (P9)."""
    items: list[dict[str, Any]] = [
        {
            "key": key,
            "version": 100 + position,
            "data": {
                "key": key,
                "itemType": "journalArticle",
                "title": f"Record {position + 1}",
                "creators": [{"creatorType": "author", "lastName": "Sestry", "firstName": "Karmelitky"}],
                "date": "2024",
                "DOI": f"10.1234/record{position + 1}",
                "tags": [{"tag": "access/metadata_only"}],
                "collections": [],
            },
        }
        for position, key in enumerate(ITEM_KEYS)
    ]
    items.extend(
        {
            "key": key,
            "version": 100 + position,
            "data": {
                "key": key,
                "itemType": "note",
                "parentItem": ITEM_KEYS[position % len(ITEM_KEYS)],
                "note": f"<p>note {position + 1}</p>",
                "collections": [],
            },
        }
        for position, key in enumerate(NOTE_KEYS)
    )
    return items


class _Answer:
    def __init__(self, body: bytes, headers: dict[str, str]) -> None:
        self.body, self.headers = body, headers

    def read(self, *_args) -> bytes:
        return self.body

    def __enter__(self) -> "_Answer":
        return self

    def __exit__(self, *_args) -> bool:
        return False


class _EmulatedZotero10:
    """The measured Zotero 10.0.8 local API, answered through the reviewed loopback client.

    Every status code and body shape below is one of P1–P9. Two rules are fixtures rather than measurements
    and say so where they run: a POST row whose name or title contains `FAIL` arrives in the answer's `failed`
    map (what is measured is that `success`/`failed` is the shape of a POST answer, not which input a real
    Zotero puts into `failed`), and `fail_at_item_write`, `external_edit_at_item_write`,
    `deny_key_at_item_write` and `hide_version_at_item_write` stand in for a request that got no usable answer,
    for the operator editing an item in Zotero's own interface mid-write, for the port refusing a key it had
    accepted a moment before, and for a write that answered without reporting a version.
    """

    def __init__(self, *, items: list[dict[str, Any]] | None = None, collections: dict[str, dict[str, Any]] | None = None, library_version: int = 342) -> None:
        self.items: dict[str, Any] = {str(row["key"]): row for row in (items if items is not None else _measured_library())}
        self.collections: dict[str, Any] = dict(collections or {})
        self.next_collection_keys = [PROJECT_KEY, CHILD_KEY]
        self.library_version = library_version
        self.requests: list[dict[str, Any]] = []
        self.writes: list[dict[str, Any]] = []
        self.item_writes = 0
        self.disposed = False
        self.fail_at_item_write: int | None = None
        self.external_edit_at_item_write: int | None = None
        self.external_edit_key: str | None = None
        self.deny_key_at_item_write: int | None = None
        self.hide_version_at_item_write: int | None = None

    # --- library bookkeeping -------------------------------------------------------------

    def _member_keys(self, collection_key: str) -> set[str]:
        return {key for key, row in self.items.items() if collection_key in (row["data"].get("collections") or [])}

    def _collection_rows(self, params: dict[str, list[str]] | None = None) -> list[dict[str, Any]]:
        rows = [
            {
                "key": key,
                "data": {
                    "key": key,
                    "name": row.get("name"),
                    "parentCollection": row.get("parentCollection") or False,
                    "numItems": len(self._member_keys(key)),
                    "numCollections": sum(1 for other in self.collections.values() if other.get("parentCollection") == key),
                },
            }
            for key, row in sorted(self.collections.items())
        ]
        if params is None:
            return rows
        start = int((params.get("start") or ["0"])[0])
        limit = int((params.get("limit") or [str(len(rows))])[0])
        return rows[start:start + limit]

    def _bump_library(self) -> None:
        # Zotero increments the library version once per transaction, local API writes included. P9 measured
        # 342 → 385 across 43 filings: one bump per write.
        self.library_version += 1

    def _version_headers(self) -> dict[str, str]:
        return {"last-modified-version": str(self.library_version)}

    def _require_key(self, headers: dict[str, str]) -> None:
        if not headers.get("zotero-api-key"):
            raise self._refused(401, "Unauthorized", b'{"error":"No key"}', {"WWW-Authenticate": 'Zotero-API-Key realm="Zotero Local API"'})

    def _refused(self, code: int, reason: str, body: bytes, headers: dict[str, str] | None = None) -> urllib.error.HTTPError:
        return urllib.error.HTTPError("http://127.0.0.1:23119/api", code, reason, headers or {}, io.BytesIO(body))

    def _next_collection_key(self) -> str:
        if self.next_collection_keys:
            return self.next_collection_keys.pop(0)
        return f"COL{len(self.collections) + 1:05d}"

    # --- the opener the reviewed client uses -----------------------------------------------

    def open(self, request, timeout=None):  # type: ignore[no-untyped-def]
        url = request.full_url
        assert url.startswith("http://127.0.0.1:23119/"), "T12-40: the endpoint stays pinned to IPv4 loopback"
        raw = url.split("/api", 1)[1] if "/api" in url else url
        path, _, query = raw.partition("?")
        params = urllib.parse.parse_qs(query)
        method = request.get_method()
        headers = {name.lower(): value for name, value in request.header_items()}
        self.requests.append({"method": method, "path": path, "query": query, "headers": headers, "body": request.data})

        if path in ("", "/"):
            return _Answer(b"Zotero local API", {"zotero-server-id": SERVER_ID, "zotero-api-version": "3"})
        if path == "/itemTypes":
            return _Answer(json.dumps(ITEM_TYPES).encode(), {})
        if path == "/users/0/tags":
            return _Answer(json.dumps([{"data": {"tag": "access/metadata_only"}}]).encode(), {"zotero-total-results": "1"})
        if path == "/users/0/searches":
            return _Answer(b"[]", {"zotero-total-results": "0"})
        if path == "/users/0/fulltext":
            if "since=" not in query:
                raise self._refused(400, "Bad Request", b'{"error":"since is required"}')
            return _Answer(b"{}", {})

        if re.fullmatch(r"/users/0/collections/[A-Z0-9]{8}", path):
            key = path.rsplit("/", 1)[1]
            if key not in self.collections:
                raise self._refused(404, "Not Found", b'{"error":"Not found"}')  # P8
            return _Answer(json.dumps(next(row for row in self._collection_rows() if row["key"] == key)).encode(), self._version_headers())

        if re.fullmatch(r"/users/0/collections/[A-Z0-9]{8}/tags", path):
            raise self._refused(404, "Not Found", b'{"error":"Not found"}')  # P5

        if (collection_match := re.fullmatch(r"/users/0/collections/([A-Z0-9]{8})/items", path)):
            key = collection_match.group(1)
            if method == "POST":
                raise self._refused(405, "Method Not Allowed", b'{"error":"Method not allowed"}')  # P4
            if key not in self.collections:
                raise self._refused(404, "Not Found", b'{"error":"Not found"}')  # P8
            return self._collection_items(key, params)

        if path == "/users/0/collections":
            if method == "HEAD":
                return _Answer(b"", {"zotero-server-id": SERVER_ID})
            if method == "POST":
                return self._post_collections(request, headers)
            return _Answer(json.dumps(self._collection_rows(params)).encode(), {"zotero-total-results": str(len(self.collections)), **self._version_headers()})

        if path == "/users/0/items":
            if method == "POST":
                return self._post_items(request, headers)
            return self._library_items(params)

        if re.fullmatch(r"/users/0/items/[A-Z0-9]{8}", path):
            key = path.rsplit("/", 1)[1]
            if key not in self.items:
                raise self._refused(404, "Not Found", b'{"error":"Not found"}')
            if method in ("PUT", "PATCH"):
                return self._write_item(key, request, headers, method)
            return _Answer(json.dumps(self.items[key]).encode(), self._version_headers())

        raise self._refused(404, "Not Found", b'{"error":"No such endpoint"}')

    # --- reads --------------------------------------------------------------------------

    def _export_body(self, rows: list[dict[str, Any]], fmt: str) -> bytes:
        if fmt == "csljson":
            return json.dumps([{"id": row["key"], "title": row["data"].get("title") or row["data"].get("note"), "type": "note" if row["data"].get("itemType") == "note" else "article-journal"} for row in rows]).encode()
        if fmt in ("bibtex", "biblatex"):
            # P6: BibTeX carried 43 records for the same 43 items — the child notes are not in it.
            def bibtex_entry(row: dict[str, Any]) -> str:
                return "@article{" + str(row["key"]) + ",\n title = {" + str(row["data"].get("title")) + "},\n annote = {access/metadata_only}\n}\n"

            return "".join(bibtex_entry(row) for row in rows if row["data"].get("itemType") != "note").encode()
        return "".join(str(row["key"]) + ',"' + str(row["data"].get("title")) + '"\n' for row in rows if row["data"].get("itemType") != "note").encode()

    def _library_items(self, params: dict[str, list[str]]) -> _Answer:
        # P5: `?collection=<key>` and `?noCollections=1` are IGNORED — this answers the whole library, which is
        # why a scoped read has to go through the collection's own items path. P6: no membership in an export.
        fmt = (params.get("format") or ["json"])[0]
        rows = list(self.items.values())
        limit = int((params.get("limit") or [str(len(rows))])[0])
        start = int((params.get("start") or ["0"])[0])
        if fmt != "json":
            return _Answer(self._export_body(rows, fmt), {"zotero-total-results": str(len(rows)), **self._version_headers()})
        return _Answer(json.dumps(rows[start:start + limit]).encode(), {"zotero-total-results": str(len(rows)), **self._version_headers()})

    def _collection_items(self, key: str, params: dict[str, list[str]]) -> _Answer:
        members = self._member_keys(key)
        # P5: the answer carries the members AND their child notes — 43 items arrived as 93 records.
        rows = sorted((row for row in self.items.values() if row["key"] in members or (row["data"].get("parentItem") in members and row["data"].get("itemType") == "note")), key=lambda row: str(row["key"]))
        fmt = (params.get("format") or ["json"])[0]
        if fmt != "json":
            return _Answer(self._export_body(rows, fmt), {"zotero-total-results": str(len(members)), **self._version_headers()})
        limit = int((params.get("limit") or [str(len(rows))])[0])
        return _Answer(json.dumps(rows[:limit]).encode(), {"zotero-total-results": str(len(rows)), **self._version_headers()})

    # --- writes -------------------------------------------------------------------------

    def _post_collections(self, request, headers: dict[str, str]) -> _Answer:  # type: ignore[no-untyped-def]
        self._require_key(headers)
        document = json.loads(request.data or b"{}")
        if not isinstance(document, list):
            raise self._refused(400, "Bad Request", b'{"error":"Uploaded data must be a JSON array"}')  # P1
        success: dict[str, str] = {}
        failed: dict[str, str] = {}
        for position, row in enumerate(document):
            name = str((row or {}).get("name") or "")
            if "FAIL" in name:  # fixture hook, see the class docstring
                failed[str(position)] = "Invalid data"
                continue
            key = self._next_collection_key()
            parent = (row or {}).get("parentCollection")
            self.collections[key] = {"name": name, "parentCollection": parent if isinstance(parent, str) else False}
            success[str(position)] = key
        self._bump_library()
        self.writes.append({"op": "post_collections", "success": success, "failed": failed})
        return _Answer(json.dumps({"success": success, "failed": failed}).encode(), self._version_headers())

    def _post_items(self, request, headers: dict[str, str]) -> _Answer:  # type: ignore[no-untyped-def]
        self._require_key(headers)
        document = json.loads(request.data or b"{}")
        if not isinstance(document, list):
            raise self._refused(400, "Bad Request", b'{"error":"Uploaded data must be a JSON array"}')  # P1
        success: dict[str, str] = {}
        failed: dict[str, str] = {}
        self._bump_library()
        for position, row in enumerate(document):
            title = str((row or {}).get("title") or "")
            if "FAIL" in title:  # fixture hook, see the class docstring
                failed[str(position)] = "Invalid data"
                continue
            key = f"NEW{len(self.items) + 1:05d}"  # eight characters, the shape `ZOTERO_ITEM_KEY_PATTERN` demands of a key it will put in a request path
            # Zotero's item `version` is a library version, not a per-item counter: an item's version is the
            # library version its last change landed at. The emulator keeps that fact, because the guard a
            # second write in the same authorization builds from is the version the first response reported.
            self.items[key] = {"key": key, "version": self.library_version, "data": {**row, "key": key, "collections": []}}
            success[str(position)] = key
        self.writes.append({"op": "post_items", "success": success, "failed": failed})
        return _Answer(json.dumps({"success": success, "failed": failed}).encode(), self._version_headers())

    def _write_item(self, key: str, request, headers: dict[str, str], method: str) -> _Answer:  # type: ignore[no-untyped-def]
        self._require_key(headers)
        self.item_writes += 1
        if self.external_edit_at_item_write is not None and self.item_writes == self.external_edit_at_item_write and self.external_edit_key:
            # The operator changed this item in Zotero's own interface after the plan read it.
            row = self.items[self.external_edit_key]
            row["version"] = int(row["version"]) + 1
        if self.fail_at_item_write is not None and self.item_writes == self.fail_at_item_write:
            raise self._refused(500, "Internal Server Error", b'{"error":"the port stopped answering this one"}')
        guard = headers.get("if-unmodified-since-version")
        if self.deny_key_at_item_write is not None and self.item_writes == self.deny_key_at_item_write:
            # The port itself refuses a key it had been answering: Zotero's 401, arriving mid-write. The
            # Toolkit's own key check cannot produce this — it refuses before the port is reached — so this is
            # the only way a test can show what a 401 in the middle of a batch does to the receipt. One shot,
            # so a resume of the same scenario runs against a port that answers again.
            self.deny_key_at_item_write = None
            raise self._refused(401, "Unauthorized", b'{"error":"Write key rejected by Zotero"}', {"WWW-Authenticate": 'Zotero-API-Key realm="Zotero Local API"'})
        if not guard:
            raise self._refused(428, "Precondition Required", b'{"error":"If-Unmodified-Since-Version required"}')
        row = self.items[key]
        if int(guard) != int(row["version"]):
            raise self._refused(412, "Precondition Failed", b'{"error":"version mismatch"}')
        body = json.loads(request.data or b"{}")
        if not isinstance(body, dict):
            raise self._refused(400, "Bad Request", b'{"error":"Uploaded data must be a JSON object"}')
        if row["data"].get("itemType") == "note" and "collections" in body:
            raise self._refused(500, "Internal Server Error", b'{"error":"notes cannot be filed directly"}')  # P4
        self._bump_library()
        # Zotero's item `version` is a library version: an item's version is the library version its last
        # change landed at, and that is the number the next `If-Unmodified-Since-Version` must name.
        self.items[key] = {"key": key, "version": self.library_version, "data": body}
        self.writes.append({"op": "put_item", "key": key, "method": method, "body": body})
        if self.hide_version_at_item_write is not None and self.item_writes == self.hide_version_at_item_write:
            return _Answer(b"", {})  # a 204 that names no version: the next guard cannot be built from it
        return _Answer(b"", self._version_headers())

    # --- disposal -----------------------------------------------------------------------

    def dispose(self) -> None:
        """Drop the disposable library. Registered as a test finalizer so no scenario leaves state behind."""
        self.items.clear()
        self.collections.clear()
        self.requests.clear()
        self.writes.clear()
        self.disposed = True


@pytest.fixture()
def zotero10(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch, tmp_path) -> _EmulatedZotero10:
    """The measured Zotero answering the pinned loopback URL, over a disposable workspace.

    The workspace clock ticks one second per stored file: a snapshot is named for the second it was taken in and
    a second write in the same second is refused with `ZOTERO_SNAPSHOT_EXISTS`. A scenario that snapshots twice
    in one second is a fixture speed artefact, not a library fact, so the clock is stepped here instead.
    """
    library = _EmulatedZotero10()
    monkeypatch.setattr(research.urllib.request, "build_opener", lambda *_args: library)
    monkeypatch.delenv(research.ZOTERO_WRITE_KEY_ENV, raising=False)
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(tmp_path))
    tick = itertools.count()
    base = datetime(2026, 11, 19, 10, 0, 0, tzinfo=UTC)
    monkeypatch.setattr(zotero_store, "_stamp", lambda now=None: (now or base + timedelta(seconds=next(tick))).strftime("%Y%m%dT%H%M%SZ"))
    request.addfinalizer(library.dispose)
    return library


def _authorize(monkeypatch: pytest.MonkeyPatch) -> None:
    """The operator's own authorized key, held only in the worker's environment (DD14-06)."""
    monkeypatch.setenv(research.ZOTERO_WRITE_KEY_ENV, WRITE_KEY)


def _ensure_two_collections(monkeypatch: pytest.MonkeyPatch, zotero10: _EmulatedZotero10) -> dict[str, Any]:
    """`projekty` and its child `projekt/krestanstvi`, created the way P9 created them."""
    result = recommended_server.zotero_write("apply", changes=[{"op": "ensure_collection", "name": "projekty"}, {"op": "ensure_collection", "name": "projekt/krestanstvi", "parentCollection": "projekty"}], confirm=research.ZOTERO_WRITE_CONFIRM)
    assert "error" not in result, result
    return result


def _filing_changes(collection_key: str) -> list[dict[str, Any]]:
    return [{"op": "add_to_collection", "key": key, "collectionKey": collection_key} for key in ITEM_KEYS]


def _writes(zotero10: _EmulatedZotero10) -> list[dict[str, Any]]:
    return [entry for entry in zotero10.requests if entry["method"] in ("PUT", "PATCH", "POST")]


# --- the request shapes the measured Zotero answers (defect D1) ------------------------------

def test_a_post_body_that_is_one_object_gets_the_400_the_real_server_gives(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """P1 is the whole of defect D1: 0.3.13 sent `{"name": ...}` and the port refused it, while the preview called the step valid."""
    _authorize(monkeypatch)
    with pytest.raises(research.ResearchError) as error:
        research._zotero_request("users/0/collections", timeout=5, method="POST", body={"name": "projekty"}, extra_headers={"Zotero-API-Key": WRITE_KEY}, write=True)
    assert error.value.code == "ZOTERO_REQUEST_REJECTED"
    assert "400" in str(error.value.evidence) and "must be a JSON array" in str(error.value.evidence)

    created, headers = research._zotero_request("users/0/collections", timeout=5, method="POST", body=[{"name": "projekty"}], body_is_list=True, extra_headers={"Zotero-API-Key": WRITE_KEY}, write=True)
    assert created == {"success": {"0": PROJECT_KEY}, "failed": {}}
    assert headers["last-modified-version"] == str(zotero10.library_version)
    assert isinstance(json.loads(zotero10.requests[-1]["body"]), list), "the serialized POST body is a JSON array on the wire"


def test_plan_bodies_are_arrays_for_post_and_objects_for_put(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """The plan states the shape, the client honours it, and a PUT never carries an array (P1/P4)."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    plan = research._zotero_plan([
        {"op": "create_collection", "name": "studie", "parentCollection": PROJECT_KEY},
        {"op": "create_item", "title": "Nový záznam", "itemType": "journalArticle"},
        {"op": "add_to_collection", "key": ITEM_KEYS[0], "collectionKey": CHILD_KEY},
    ])
    assert [step["method"] for step in plan] == ["POST", "POST", "PUT"]
    assert plan[0]["body"] == [{"name": "studie", "parentCollection": PROJECT_KEY}] and plan[0]["bodyIsList"] is True
    assert isinstance(plan[1]["body"], list) and plan[1]["body"][0]["title"] == "Nový záznam"
    assert isinstance(plan[2]["body"], dict) and plan[2]["body"]["collections"] == [CHILD_KEY]

    applied = research.zotero_write_apply([{"op": "create_collection", "name": "studie", "parentCollection": PROJECT_KEY}, {"op": "create_item", "title": "Nový záznam"}, {"op": "add_to_collection", "key": ITEM_KEYS[0], "collectionKey": CHILD_KEY}], confirm=research.ZOTERO_WRITE_CONFIRM)
    posts = [entry for entry in zotero10.requests if entry["method"] == "POST"]
    assert posts and all(isinstance(json.loads(entry["body"]), list) for entry in posts)
    puts = [entry for entry in zotero10.requests if entry["method"] == "PUT"]
    assert len(puts) == 1 and not isinstance(json.loads(puts[0]["body"]), list), "the filing went out as an object, because P4 measured it that way"
    assert applied["createdKeys"] == sorted(applied["createdKeys"]) and len(applied["createdKeys"]) == 2


def test_a_list_body_without_the_marker_is_refused_before_it_reaches_the_port(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """The shape is a reviewed property, so a caller cannot get it wrong in either direction."""
    _authorize(monkeypatch)
    before = len(zotero10.requests)
    with pytest.raises(research.ResearchError) as list_without_marker:
        research._zotero_request("users/0/items", timeout=5, method="POST", body=[{"title": "x"}], extra_headers={"Zotero-API-Key": WRITE_KEY}, write=True)
    assert list_without_marker.value.code == "ZOTERO_REQUEST_BODY_SHAPE_INVALID"
    with pytest.raises(research.ResearchError) as array_on_put:
        research._zotero_request(f"users/0/items/{ITEM_KEYS[0]}", timeout=5, method="PUT", body={"title": "x"}, body_is_list=True, extra_headers={"Zotero-API-Key": WRITE_KEY, "If-Unmodified-Since-Version": "100"}, write=True)
    assert array_on_put.value.code == "ZOTERO_REQUEST_BODY_SHAPE_INVALID"
    assert len(zotero10.requests) == before, "a shape refusal sends nothing"


def test_a_plan_never_carries_the_collection_items_post_shape(zotero10: _EmulatedZotero10) -> None:
    """`POST /collections/<key>/items` answers 405 (P4). The guard refuses the shape, not just one caller (D9)."""
    with pytest.raises(research.ResearchError) as error:
        research._zotero_plan_append([], {"op": "add_to_collection", "method": "POST", "path": f"users/0/collections/{CHILD_KEY}/items", "body": [{"key": ITEM_KEYS[0]}], "bodyIsList": True})
    assert error.value.code == "ZOTERO_PLAN_SHAPE_INVALID" and "405" in str(error.value)
    with pytest.raises(research.ResearchError) as object_post:
        research._zotero_plan_append([], {"op": "create_collection", "method": "POST", "path": "users/0/collections", "body": {"name": "projekty"}})
    assert object_post.value.code == "ZOTERO_PLAN_SHAPE_INVALID", "the 0.3.13 object-body shape cannot re-enter a plan"
    with pytest.raises(research.ResearchError) as array_put:
        research._zotero_plan_append([], {"op": "add_to_collection", "method": "PUT", "path": f"users/0/items/{ITEM_KEYS[0]}", "body": [{"collections": [CHILD_KEY]}]})
    assert array_put.value.code == "ZOTERO_PLAN_SHAPE_INVALID"
    assert zotero10.requests == []


# --- what apply reads back from the server's own answer (defect D2) ---------------------------

def test_apply_reads_created_keys_from_the_success_map_and_never_silences_failed(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """0.3.13 reported `key: None` for a POST because it looked for a top-level `key` this API does not send."""
    _authorize(monkeypatch)
    result = research.zotero_write_apply([{"op": "create_collection", "name": "projekty"}, {"op": "create_item", "title": "Nový záznam"}], confirm=research.ZOTERO_WRITE_CONFIRM)
    collection_key, item_key = (entry["key"] for entry in result["applied"])
    assert collection_key == PROJECT_KEY, "the key came from the response's `success` map, not from a `key` field this API does not send"
    assert re.fullmatch(research.ZOTERO_ITEM_KEY_PATTERN, item_key) and zotero10.items[item_key]["data"]["title"] == "Nový záznam", "the created item's key is the one the server named, and it names the right record"
    assert result["createdKeys"] == sorted({collection_key, item_key})
    assert result["libraryVersion"] == zotero10.library_version == 344, "the library version advanced from the write responses (P9: 342 → 385 across 43 writes)"
    assert result["serverFailures"] == []

    failed_write = research.zotero_write_apply([{"op": "create_item", "title": "FAIL marker"}], confirm=research.ZOTERO_WRITE_CONFIRM)
    assert failed_write["createdKeys"] == []
    assert failed_write["serverFailures"] == [{"index": 0, "batch": 1, "op": "create_item", "position": "0", "reason": "Invalid data"}]
    assert failed_write["applied"][0]["key"] is None, "no key is invented when the server did not give one"
    assert failed_write["notUndoable"][0]["reason"].startswith("recorded as not undoable")


def test_preview_names_the_answer_apply_will_read_back(zotero10: _EmulatedZotero10) -> None:
    """The preview and the apply have to describe the same exchange, or the operator approved something else."""
    preview = research.zotero_write_preview([{"op": "create_collection", "name": "projekty"}])
    assert preview["dryRun"] is True and preview["zoteroModified"] is False
    assert zotero10.writes == [] and zotero10.requests == []
    assert "success" in preview["responseShapes"]["POST"] and "400" in preview["responseShapes"]["POST"]
    assert "204" in preview["responseShapes"]["PUT"]
    assert preview["notUndoable"][0]["op"] == "create_collection"
    assert "no delete verb" in preview["notUndoable"][0]["reason"], "an operation the Toolkit cannot undo is visible in the preview (DD14-07)"


# --- collections: finding one, and never inventing one (defect D7) ----------------------------

def test_reserved_special_collection_names_are_refused_and_no_request_is_made(zotero10: _EmulatedZotero10) -> None:
    assert research.ZOTERO_RESERVED_COLLECTION_NAMES == frozenset({"My Publications", "Unfiled Items", "Duplicate Items", "Retracted Items", "New Items", "Feed Documents"})
    for op in ("ensure_collection", "create_collection"):
        with pytest.raises(research.ResearchError) as error:
            research.zotero_write_preview([{"op": op, "name": "My Publications"}])
        assert error.value.code == "ZOTERO_COLLECTION_NAME_RESERVED"
        assert "imitation" in str(error.value) and "404" in str(error.value), "the refusal says why a collection of that name is not My Publications (P8)"
    assert zotero10.requests == [], "the refusal is before any HTTP request"
    # A name that merely contains one is the operator's own filing decision and is planned.
    plan = research.zotero_write_preview([{"op": "ensure_collection", "name": "projekty / My Publications"}])["planned"]
    assert plan[0]["method"] == "POST" and plan[0]["body"] == [{"name": "projekty / My Publications"}]


def test_two_collections_of_one_name_are_named_not_guessed(zotero10: _EmulatedZotero10) -> None:
    """P2: same name, two keys. A Toolkit that picked one would file into a collection nobody chose."""
    zotero10.collections["AAAA1111"] = {"name": "projekty", "parentCollection": False}
    zotero10.collections["BBBB2222"] = {"name": "projekty", "parentCollection": False}
    with pytest.raises(research.ResearchError) as error:
        research.zotero_write_preview([{"op": "ensure_collection", "name": "projekty"}])
    assert error.value.code == "ZOTERO_COLLECTION_AMBIGUOUS"
    assert "AAAA1111" in str(error.value) and "BBBB2222" in str(error.value)
    assert _writes(zotero10) == [], "nothing is written while the name stays ambiguous"


def test_ensure_collection_takes_the_collection_that_is_already_there_and_writes_nothing(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    _authorize(monkeypatch)
    zotero10.collections[PROJECT_KEY] = {"name": "projekty", "parentCollection": False}
    step = research.zotero_write_preview([{"op": "ensure_collection", "name": "projekty"}])["planned"][0]
    assert step["action"] == "existing" and step["write"] is False and step["key"] == PROJECT_KEY
    assert step["method"] is None and step["body"] is None

    applied = recommended_server.zotero_write("apply", changes=[{"op": "ensure_collection", "name": "projekty"}], confirm=research.ZOTERO_WRITE_CONFIRM)
    assert applied["zoteroModified"] is False and applied["applied"][0]["request"] is False
    assert _writes(zotero10) == [], "an existing collection is not a write"
    assert applied["collectionCheck"]["consistent"] is True and applied["collectionCheck"]["checkedKeys"] == [PROJECT_KEY]


def test_ensure_collection_creates_the_parent_first_and_uses_the_key_it_created(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """P3 and P9: `projekty`, then `projekt/krestanstvi` under it, keys read out of the server's `success` map."""
    _authorize(monkeypatch)
    preview = research.zotero_write_preview([{"op": "ensure_collection", "name": "projekt/krestanstvi", "parentCollection": "projekty"}])
    assert [step["op"] for step in preview["planned"]] == ["ensure_collection", "ensure_collection"]
    parent, child = preview["planned"]
    assert parent["body"] == [{"name": "projekty"}] and child["parentFromStep"] == 0 and child["parentCollectionName"] == "projekty"
    assert "success" in child.get("bodyNote", ""), "a parent this write creates has no key until that POST answers (P1)"

    applied = recommended_server.zotero_write("apply", changes=[{"op": "ensure_collection", "name": "projekt/krestanstvi", "parentCollection": "projekty"}], confirm=research.ZOTERO_WRITE_CONFIRM)
    assert applied["createdKeys"] == [CHILD_KEY, PROJECT_KEY]
    assert zotero10.collections[CHILD_KEY]["parentCollection"] == PROJECT_KEY, "P3: data.parentCollection is the parent key"
    child_row = next(row for row in recommended_server.zotero_library("collections")["collections"] if row["key"] == CHILD_KEY)
    assert child_row["path"] == "projekty / projekt/krestanstvi", "the path is spelled from parentCollection (P3): it says which `projekty` a filing lands in"

    undo = recommended_server.zotero_write("undo", journal_id=applied["journal"]["journalId"])
    assert undo["undone"] == [] and len(undo["refused"]) == 2
    assert all("no delete verb" in entry["reason"] and "collection" in entry["reason"] for entry in undo["refused"]), "an ensured collection is refused by undo, with the reason stated (DD14-07)"
    assert zotero10.collections, "refusing the undo also means deleting nothing"


def test_a_document_note_is_never_filed_and_the_refusal_precedes_the_write(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """P4 measured `PATCH` on a note with `collections` → 500. The Toolkit refuses instead of collecting a 500."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    note = zotero10.items[NOTE_KEYS[0]]
    with pytest.raises(research.ResearchError) as direct:
        research._zotero_request(f"users/0/items/{NOTE_KEYS[0]}", timeout=5, method="PATCH", body={**note["data"], "collections": [CHILD_KEY]}, extra_headers={"Zotero-API-Key": WRITE_KEY, "If-Unmodified-Since-Version": str(note["version"])}, write=True)
    assert direct.value.code == "ZOTERO_REQUEST_FAILED" and "500" in str(direct.value.evidence), "the emulator answers the 500 the operator measured"

    writes_before = len(zotero10.writes)
    with pytest.raises(research.ResearchError) as planned:
        research.zotero_write_preview([{"op": "add_to_collection", "key": NOTE_KEYS[0], "collectionKey": CHILD_KEY}])
    assert planned.value.code == "ZOTERO_NOTE_NOT_FILEABLE" and "document note" in str(planned.value) and "500" in str(planned.value), "the refusal names the measured answer it is avoiding and the parent the note travels with"
    assert len(zotero10.writes) == writes_before, "the refusal is before the write request"


def test_a_special_collection_is_invisible_and_a_collection_tag_read_names_the_404(zotero10: _EmulatedZotero10) -> None:
    """P8 and P5: the local API answers neither a special collection nor a collection-scoped tag read."""
    special = recommended_server.zotero_library("collection_items", key=SPECIAL_KEY)
    assert special["error"]["code"] == "ZOTERO_NOT_FOUND"

    requests_before = len(zotero10.requests)
    tags = recommended_server.zotero_library("collection_tags", key=CHILD_KEY)
    assert tags["error"]["code"] == "ZOTERO_COLLECTION_TAGS_UNSUPPORTED"
    assert "404" in tags["error"]["message"] and "/tags" in tags["error"]["message"]
    assert len(zotero10.requests) == requests_before, "the refusal states the measured 404 instead of asking the port again"

    bad_key = recommended_server.zotero_library("collection_items", key="nope")
    assert bad_key["error"]["code"] == "ZOTERO_COLLECTION_KEY_INVALID"
    assert len(zotero10.requests) == requests_before

    unsupported = recommended_server.zotero_library("merge")
    assert unsupported["error"]["code"] == "ZOTERO_ACTION_UNSUPPORTED"
    assert "collection_items" in unsupported["error"]["message"], "the action list and the message that enumerates it cannot drift apart (D4)"


# --- reading membership, and exporting one collection (defect D4, D5) -------------------------

def test_collection_items_is_the_only_read_that_answers_membership(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """P5: the collection path answers items and notes; `GET /items?collection=` is ignored."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    applied = recommended_server.zotero_write("apply", changes=_filing_changes(CHILD_KEY), confirm=research.ZOTERO_WRITE_CONFIRM)
    assert "error" not in applied, applied

    read = recommended_server.zotero_library("collection_items", key=CHILD_KEY, limit=100)
    assert read["returned"] == 93 and read["notesIncluded"] == 50 and read["memberCount"] == 43, "43 items arrived as 93 records (P5), so the notes are reported apart"
    assert read["readOnly"] is True and len(read["members"]) == 43 and read["truncated"] is False
    short = recommended_server.zotero_library("collection_items", key=CHILD_KEY)
    assert short["returned"] == 25 and short["totalResults"] == "93" and short["truncated"] is True, "the bound is reported, not hidden"

    collection_reads = [entry for entry in zotero10.requests if entry["path"].endswith(f"/collections/{CHILD_KEY}/items")]
    assert collection_reads and all(not entry["path"].startswith("/users/0/items") for entry in collection_reads)
    assert not any("collection=" in entry["query"] for entry in zotero10.requests), "the ignored `GET /items?collection=` shape is never asked for (P5)"
    assert applied["collectionState"][0]["recordsRead"] == 93 and applied["collectionState"][0]["notesIncluded"] == 50


def test_collection_listing_and_status_carry_the_numbers_and_the_path(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """D4: `numItems`, `numCollections` and `collectionCount` were read by 0.3.13 and thrown away."""
    _authorize(monkeypatch)
    assert recommended_server.zotero_library("collections")["collectionCount"] == 0
    assert recommended_server.zotero_library("status")["counts"]["collectionCount"] == 0
    _ensure_two_collections(monkeypatch, zotero10)
    recommended_server.zotero_write("apply", changes=_filing_changes(CHILD_KEY), confirm=research.ZOTERO_WRITE_CONFIRM)

    listing = recommended_server.zotero_library("collections")
    assert listing["collectionCount"] == 2
    parent = next(row for row in listing["collections"] if row["key"] == PROJECT_KEY)
    child = next(row for row in listing["collections"] if row["key"] == CHILD_KEY)
    assert child["numItems"] == 43 and child["numCollections"] == 0 and child["parentCollection"] == PROJECT_KEY
    assert parent["numItems"] == 0 and parent["numCollections"] == 1 and parent["path"] == "projekty"
    status = recommended_server.zotero_library("status")
    assert status["counts"]["collectionCount"] == 2 and status["counts"]["items"] == "93"


def test_export_can_be_scoped_to_a_collection_and_still_carries_no_membership(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """D5 with P6: a scoped export goes through the collection's items path, and no format carries membership."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    recommended_server.zotero_write("apply", changes=_filing_changes(CHILD_KEY), confirm=research.ZOTERO_WRITE_CONFIRM)

    whole = research.zotero_export("csljson", limit=50)
    assert whole["scope"] == "library" and whole["collectionKey"] is None and whole["membershipInExport"] is False

    scoped = research.zotero_export("csljson", limit=100, collection_key=CHILD_KEY)
    assert scoped["scope"] == "collection" and scoped["collectionKey"] == CHILD_KEY and scoped["collectionName"] == "projekt/krestanstvi"
    assert scoped["membershipInExport"] is False, "P6: no export format this API answers with carries membership"
    assert "93 records" in scoped["noteWarning"] and "note" in scoped["noteWarning"]
    assert [entry for entry in zotero10.requests if entry["path"] == f"/users/0/collections/{CHILD_KEY}/items" and "format=csljson" in entry["query"]]

    bibtex = research.zotero_export("bibtex", limit=100, collection_key=CHILD_KEY)
    assert "no document notes" in bibtex["noteWarning"] and "43 records" in bibtex["noteWarning"]
    unmeasured = research.zotero_export("biblatex", limit=10, collection_key=CHILD_KEY)
    assert "not measured" in unmeasured["noteWarning"], "a format the 19 November 2026 measurement does not cover says so"

    with pytest.raises(research.ResearchError) as error:
        research.zotero_export("csljson", 10, collection_key=SPECIAL_KEY)
    assert error.value.code == "ZOTERO_COLLECTION_NOT_FOUND" and "404" in str(error.value), "a special collection cannot be exported through this path either (P8)"
    with pytest.raises(research.ResearchError) as bad_shape:
        research.zotero_export("csljson", 10, collection_key="nope")
    assert bad_shape.value.code == "ZOTERO_COLLECTION_KEY_INVALID"


# --- the 43-item filing, proven by membership (defect D3, D8, P9) ------------------------------

def test_a_43_item_filing_over_two_batches_is_proven_by_membership_and_loses_no_undo(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """snapshot → preview (no write) → authorized apply → re-read, the P9 run, then checked (DD14-11)."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    changes = _filing_changes(CHILD_KEY)

    writes_before_preview = len(zotero10.writes)
    preview = recommended_server.zotero_write("preview", changes=changes)
    assert preview["operationCount"] == 43 and preview["batchesNeeded"] == 2 and preview["operationsPerBatch"] == 25
    assert preview["dryRun"] is True and len(zotero10.writes) == writes_before_preview, "preview is not a write"
    assert preview["journalFit"]["entries"] == 43 and preview["journalFit"]["fits"] is True

    version_before = zotero10.library_version
    applied = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM)
    batches = [entry["batch"] for entry in applied["applied"]]
    assert batches.count(1) == 25 and batches.count(2) == 18 and applied["batchesNeeded"] == 2, "43 operations are two batches of at most 25 (D8)"
    puts = [entry for entry in zotero10.requests if entry["method"] == "PUT"]
    assert len(puts) == 43 and all(entry["headers"].get("if-unmodified-since-version") for entry in puts), "43× 204, every one with its version guard"
    assert not any(entry["method"] == "POST" and re.fullmatch(r"/users/0/collections/[A-Z0-9]{8}/items", entry["path"]) for entry in zotero10.requests), "the 405 shape never appears in a plan (D9)"
    assert applied["libraryVersion"] == zotero10.library_version == version_before + 43, "the version advanced from the responses (P9: 342 → 385)"

    assert applied["journal"]["entriesTotal"] == 43 and applied["journal"]["entries"] == 43 and applied["journal"]["droppedEntries"] == 0
    assert applied["journal"]["undoComplete"] is True and applied["journal"]["truncated"] is False, "at the old 4 096-byte cap this journal lost 30+ entries and nobody was told (D8)"

    check = applied["collectionCheck"]
    assert check["mismatch"] is False and check["consistent"] is True
    record = next(row for row in check["collections"] if row["key"] == CHILD_KEY)
    assert record["membersBefore"] == 0 and record["membersAfter"] == 43 and record["filedOperations"] == 43
    assert record["numItemsBefore"] == 0 and record["numItemsAfter"] == 43, "P9: numItems 43"
    assert record["existedBefore"] is True and applied["snapshot"]["baseline"]["collections"][CHILD_KEY]["members"] == 0, "the 0 is what the snapshot read of this collection, not a missing baseline read as an empty one"
    assert record["recordsReadAfter"] == 93 and record["notesIncludedAfter"] == 50
    assert applied["countCheck"]["before"] == "93" and applied["countCheck"]["after"] == "93" and applied["countCheck"]["mismatch"] is False
    assert "filing changes membership" in applied["countCheck"]["note"], "an item count cannot prove a filing (P9) — that is what collectionCheck is for"

    undo = recommended_server.zotero_write("undo", journal_id=applied["journal"]["journalId"])
    assert len(undo["undone"]) == 43 and undo["refused"] == [] and undo["journalUndoComplete"] is True
    assert next(row for row in recommended_server.zotero_library("collections")["collections"] if row["key"] == CHILD_KEY)["numItems"] == 0
    assert recommended_server.zotero_library("collection_items", key=CHILD_KEY, limit=100)["memberCount"] == 0
    assert zotero10.items[ITEM_KEYS[0]]["data"]["collections"] == [], "an undone filing leaves the item outside the collection"


def test_a_collection_check_names_a_filing_that_answered_204_and_arrived_nowhere(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """DD14-11 against a server that lies: every write answered 204 and nothing landed."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)

    def pretending(key: str, request, headers: dict[str, str], method: str) -> _Answer:  # type: ignore[no-untyped-def]
        zotero10.writes.append({"op": "put_item", "key": key, "method": method, "applied": False})
        return _Answer(b"", zotero10._version_headers())

    monkeypatch.setattr(zotero10, "_write_item", pretending)
    applied = recommended_server.zotero_write("apply", changes=_filing_changes(CHILD_KEY)[:3], confirm=research.ZOTERO_WRITE_CONFIRM)
    assert all(entry["method"] == "PUT" for entry in applied["applied"]) and applied["zoteroModified"] is True

    check = applied["collectionCheck"]
    assert check["mismatch"] is True and check["consistent"] is False
    record = next(row for row in check["collections"] if row["key"] == CHILD_KEY)
    assert record["membersBefore"] == 0 and record["membersAfter"] == 0 and record["filedOperations"] == 3
    assert "no member arrived" in record["reason"]


# --- interruption, version conflict, and the resume-safe path (D8) ------------------------------

def test_a_batch_that_stops_partway_names_what_arrived_and_the_next_batch_to_run(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """A stopped write is reported per operation, and `resume_after` sends only what was not sent."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    changes = _filing_changes(CHILD_KEY)
    zotero10.fail_at_item_write = 30  # the 30th filing request, inside the second batch, gets no usable answer

    stopped = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM)
    assert stopped["error"]["code"] == "ZOTERO_REQUEST_FAILED"
    assert stopped["blocked"] is None, "an interruption is not a version conflict, so it does not block the library"
    assert len(stopped["applied"]) == 29 and len(stopped["notApplied"]) == 14
    assert stopped["notApplied"][0]["index"] == 29 and stopped["notApplied"][0]["batch"] == 2
    assert stopped["nextBatch"]["resumeAfter"] == 29 and stopped["nextBatch"]["batchesRemaining"] == 1
    assert len(stopped["nextBatch"]["operations"]) == 14
    assert "not sent again blindly" in stopped["nextBatch"]["note"]
    assert zotero_store.read_write_block() is None
    interrupted = next(row for row in stopped["collectionCheck"]["collections"] if row["key"] == CHILD_KEY)
    assert interrupted["membersBefore"] == 0 and interrupted["membersAfter"] == 29 and interrupted["filedOperations"] == 29
    assert stopped["collectionCheck"]["consistent"] is True, "an interrupted write is still checked against membership: the receipt says 29 of 43 arrived, and the collection says 29"

    resumed = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM, resume_after=29)
    assert resumed["zoteroModified"] is True and resumed["operationCount"] == 14 and resumed["resumedAfter"] == 29
    assert [entry["batch"] for entry in resumed["applied"]] == [2] * 14
    filed_early = {f"/users/0/items/{key}" for key in ITEM_KEYS[:30]}
    # 31 requests on the first 30 keys, and that is the right number: the first apply sent 29 filings that
    # arrived, plus one attempt on ITEM_KEYS[29] that got no answer. `resume_after=29` skips the 29 applied
    # steps and re-sends the attempt that never landed together with the 13 steps that were never sent — so
    # ITEM_KEYS[29] is written twice while none of the 29 applied ones is written again. Counting 30 here
    # would demand that the interrupted operation be dropped, which is the silent loss this report exists to avoid.
    early_requests = [entry for entry in zotero10.requests if entry["method"] == "PUT" and entry["path"] in filed_early]
    assert len(early_requests) == 31, "29 applied filings, 1 interrupted attempt, 1 legitimate re-send of that attempt"
    assert len({entry["path"] for entry in early_requests}) == 30, "every applied filing was sent exactly once: only the interrupted one appears twice"
    assert len([entry for entry in zotero10.requests if entry["method"] == "PUT"]) == 44, "30 requests from the stopped apply plus the 14 the resume sent"
    check = next(row for row in resumed["collectionCheck"]["collections"] if row["key"] == CHILD_KEY)
    assert check["membersBefore"] == 29 and check["membersAfter"] == 43 and resumed["collectionCheck"]["consistent"] is True


def test_a_version_conflict_is_named_and_blocks_the_next_apply_until_the_library_is_snapshotted(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """412 means the version guards this plan was built from describe a library that no longer exists."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    zotero10.external_edit_at_item_write = 2
    zotero10.external_edit_key = ITEM_KEYS[1]

    conflict = recommended_server.zotero_write("apply", changes=_filing_changes(CHILD_KEY), confirm=research.ZOTERO_WRITE_CONFIRM)
    assert conflict["error"]["code"] == "ZOTERO_WRITE_CONFLICT"
    assert conflict["blocked"]["blocksNextApply"] is True and conflict["blocked"]["until"].startswith("re-read the library")
    assert len(conflict["applied"]) == 1 and len(conflict["notApplied"]) == 42
    assert zotero_store.read_write_block() is not None

    requests_before = len(zotero10.requests)
    second = recommended_server.zotero_write("apply", changes=[{"op": "add_to_collection", "key": ITEM_KEYS[2], "collectionKey": CHILD_KEY}], confirm=research.ZOTERO_WRITE_CONFIRM)
    assert second["error"]["code"] == "ZOTERO_WRITE_BLOCKED" and "snapshot" in second["error"]["message"]
    assert len(zotero10.requests) == requests_before, "a blocked write sends nothing at all, not even the reads it would plan from"

    snapshot = recommended_server.zotero_write("snapshot")
    assert snapshot["snapshot"]["blockCleared"] is True and zotero_store.read_write_block() is None
    assert snapshot["snapshot"]["libraryVersion"] == zotero10.library_version

    third = recommended_server.zotero_write("apply", changes=[{"op": "add_to_collection", "key": ITEM_KEYS[2], "collectionKey": CHILD_KEY}], confirm=research.ZOTERO_WRITE_CONFIRM)
    assert third["zoteroModified"] is True and third["collectionCheck"]["consistent"] is True


def test_write_gates_still_refuse_before_the_port_and_the_key_stays_out_of_every_record(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """The invariants 0.3.13 shipped with are unchanged: double confirmation, no key in any record, no delete."""
    for op in ("delete", "delete_item", "merge", "duplicate_check"):
        with pytest.raises(research.ResearchError) as refused:
            research.zotero_write_preview([{"op": op, "key": ITEM_KEYS[0]}])
        assert refused.value.code == "ZOTERO_WRITE_ACTION_UNSUPPORTED"
    assert _writes(zotero10) == []

    with pytest.raises(research.ResearchError) as no_confirm:
        research.zotero_write_apply([{"op": "add_to_collection", "key": ITEM_KEYS[0], "collectionKey": CHILD_KEY}], confirm="yes")
    assert no_confirm.value.code == "WRITE_CONFIRM_REQUIRED"

    unauthorized = recommended_server.zotero_write("apply", changes=[{"op": "ensure_collection", "name": "projekty"}], confirm=research.ZOTERO_WRITE_CONFIRM)
    assert unauthorized["error"]["code"] == "ZOTERO_WRITE_KEY_MISSING" and _writes(zotero10) == []

    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    applied = recommended_server.zotero_write("apply", changes=[{"op": "add_to_collection", "key": ITEM_KEYS[0], "collectionKey": CHILD_KEY}], confirm=research.ZOTERO_WRITE_CONFIRM)
    journal = zotero_store.read_journal(applied["journal"]["journalId"])
    corpus = json.dumps([applied, journal], ensure_ascii=False) + (tmp_path / applied["snapshot"]["path"]).read_text(encoding="utf-8")
    assert WRITE_KEY not in corpus, "the key is read from the environment at request time and appears in no response, journal, snapshot or plan (DD14-06)"
    assert all(entry["headers"].get("zotero-api-key") == WRITE_KEY for entry in _writes(zotero10))
    assert zotero_store.read_write_block() is None


# --- the before-side a filing is checked against (review, 22 November 2026) ---------------------

def test_a_check_with_no_snapshot_baseline_says_it_has_no_before_side(zotero10: _EmulatedZotero10) -> None:
    """The false-pass this closes: a collection with 10 members, 3 filings that answered 204, nothing landed.

    0.3.15 handed `collection_check` the short record `write_snapshot` answers with — counts, no collections,
    no items — so every `membersBefore` read 0, every collection read `existedBefore: false`, and a filing that
    landed nowhere was reported consistent. A check with no baseline now says so.
    """
    result = {
        "applied": [{"index": 0, "op": "add_to_collection", "key": ITEM_KEYS[0], "collectionKey": CHILD_KEY, "request": True}],
        "collectionKeys": [CHILD_KEY],
        "createdKeys": [],
        "collectionState": [{"key": CHILD_KEY, "name": "projekt/krestanstvi", "path": "projekty / projekt/krestanstvi", "listed": True, "numItems": 10, "memberCount": 10, "recordsRead": 10, "notesIncluded": 0}],
    }
    summary_only = {"path": ".research-toolkit/zotero-snapshots/20261119T100000Z.json", "itemCount": 93, "totalResults": "93", "collectionCount": 2, "truncated": False}
    check = zotero_store.collection_check(summary_only, result)
    assert check["baselineSource"] == "missing" and check["mismatch"] is True and check["consistent"] is False, "no baseline is not a clean result"
    assert "no before-side" in check["collections"][0]["reason"]
    assert check["collections"][0]["membersBefore"] is None and check["collections"][0]["numItemsBefore"] is None, "an unknown before-side is reported as unknown, not as zero"


def test_a_filing_that_answered_204_into_a_collection_that_already_had_members_is_caught(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """DD14-11 in the normal case: the collection was not empty, so a 204 that moved nothing is visible."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    for key in ITEM_KEYS[:10]:
        zotero10.items[key]["data"]["collections"] = [CHILD_KEY]  # 10 members before the write, the reviewer's probe

    def pretending(key: str, request, headers: dict[str, str], method: str) -> _Answer:  # type: ignore[no-untyped-def]
        zotero10.writes.append({"op": "put_item", "key": key, "method": method, "applied": False})
        return _Answer(b"", zotero10._version_headers())

    monkeypatch.setattr(zotero10, "_write_item", pretending)
    changes = [{"op": "add_to_collection", "key": key, "collectionKey": CHILD_KEY} for key in ITEM_KEYS[10:13]]
    applied = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM)
    assert applied["snapshot"]["baseline"]["collections"][CHILD_KEY]["members"] == 10, "the snapshot record carries the collection facts the check compares against"

    record = next(row for row in applied["collectionCheck"]["collections"] if row["key"] == CHILD_KEY)
    assert record["existedBefore"] is True and record["membersBefore"] == 10 and record["numItemsBefore"] == 10
    assert record["membersAfter"] == 10 and record["filedOperations"] == 3
    assert applied["collectionCheck"]["mismatch"] is True and applied["collectionCheck"]["consistent"] is False
    assert "no member arrived" in record["reason"] and "10" in record["reason"], "the reason names the number it compared, not only that something is wrong"


def test_a_snapshot_truncated_item_read_is_not_presented_as_the_library_membership(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """A baseline built on an item read that stopped early is a lower bound, and the check says so."""
    baseline = zotero_store.collection_baseline({"items": [{"key": key, "data": {"collections": [CHILD_KEY]}} for key in ITEM_KEYS[:5]], "collections": [{"key": CHILD_KEY, "name": "projekty", "path": "projekty", "numItems": 5}], "truncated": True})
    assert baseline["truncated"] is True and baseline["collections"][CHILD_KEY]["members"] == 5
    check = zotero_store.collection_check({"baseline": baseline}, {"applied": [{"index": 0, "op": "add_to_collection", "key": ITEM_KEYS[6], "collectionKey": CHILD_KEY, "request": True}], "collectionKeys": [CHILD_KEY], "collectionState": [{"key": CHILD_KEY, "memberCount": 6, "numItems": 6, "recordsRead": 6, "notesIncluded": 0, "path": "projekty"}]})
    assert check["mismatch"] is True and check["consistent"] is False, "an incomplete before-side cannot certify a filing"
    assert "lower bound" in check["collections"][0]["reason"]


# --- two operations on one item, and the version each write is allowed to claim (review 2) -------

def test_two_operations_on_one_item_in_one_write_are_guarded_by_the_version_the_first_write_reported(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """The plan reads an item once, so both steps would carry one version; the second write would answer 412."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    changes = [{"op": "add_to_collection", "key": ITEM_KEYS[5], "collectionKey": CHILD_KEY}, {"op": "add_tags", "key": ITEM_KEYS[5], "tags": ["topic/ošetřovatelství"]}]
    plan = research._zotero_plan(changes)
    assert plan[0]["guard"] == plan[1]["guard"], "the defect exactly: one plan-time read, two requests claiming the same version"

    applied = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM)
    assert "error" not in applied, applied
    first, second = applied["applied"]
    assert first["guardSource"] == "snapshot" and second["guardSource"].startswith("the version step 0 reported")
    puts = [entry for entry in zotero10.requests if entry["method"] == "PUT"]
    assert len(puts) == 2 and puts[1]["headers"]["if-unmodified-since-version"] == str(first["version"]) != puts[0]["headers"]["if-unmodified-since-version"]
    data = zotero10.items[ITEM_KEYS[5]]["data"]
    assert data["collections"] == [CHILD_KEY] and any(tag["tag"] == "topic/ošetřovatelství" for tag in data["tags"]), "both operations landed on the one item"
    assert applied["collectionCheck"]["consistent"] is True


def test_a_second_operation_on_one_item_is_refused_when_the_first_reported_no_version(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """A 204 that names no version leaves the Toolkit with no guard, and an unguarded write is a 428."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    zotero10.hide_version_at_item_write = 1
    changes = [{"op": "add_to_collection", "key": ITEM_KEYS[5], "collectionKey": CHILD_KEY}, {"op": "add_tags", "key": ITEM_KEYS[5], "tags": ["topic/ošetřovatelství"]}]
    stopped = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM)
    assert stopped["error"]["code"] == "ZOTERO_WRITE_VERSION_UNKNOWN"
    assert len(stopped["applied"]) == 1 and len(stopped["notApplied"]) == 1, "the receipt still says which half landed"
    assert len([entry for entry in zotero10.requests if entry["method"] == "PUT"]) == 1, "the step with no guard was never sent"
    assert zotero_store.read_write_block() is None, "this is an interruption, not a version conflict: the library is not blocked"


# --- a name, a parent, and what `ensure_collection` is allowed to conclude (review 3) ------------

def test_a_root_collection_of_the_childs_name_is_not_adopted_under_a_parent_that_does_not_exist_yet(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """Adopting `AAAA1111` while creating `projekty` would leave the child beside the parent, not under it."""
    _authorize(monkeypatch)
    zotero10.collections["AAAA1111"] = {"name": "projekt/krestanstvi", "parentCollection": False}
    changes = [{"op": "ensure_collection", "name": "projekt/krestanstvi", "parentCollection": "projekty"}]
    preview = recommended_server.zotero_write("preview", changes=changes)
    assert preview["error"]["code"] == "ZOTERO_COLLECTION_PARENT_MISMATCH"
    assert "AAAA1111" in preview["error"]["message"] and "the library root" in preview["error"]["message"] and "projekty" in preview["error"]["message"]
    assert _writes(zotero10) == [], "the refusal is before the write, and nothing is re-parented on the way"

    refused = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM)
    assert refused["error"]["code"] == "ZOTERO_COLLECTION_PARENT_MISMATCH" and _writes(zotero10) == []


def test_a_same_name_collection_elsewhere_is_named_not_adopted_when_the_parent_is_there(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """P2 with a parent: the name matches two collections in two places, and the plan names the other one."""
    _authorize(monkeypatch)
    created = _ensure_two_collections(monkeypatch, zotero10)
    assert created["createdKeys"] == [CHILD_KEY, PROJECT_KEY]
    zotero10.collections["BBBB2222"] = {"name": "projekt/krestanstvi", "parentCollection": False}  # same name, at the root

    step = research.zotero_write_preview([{"op": "ensure_collection", "name": "projekt/krestanstvi", "parentCollection": "projekty"}])["planned"][0]
    assert step["action"] == "existing" and step["key"] == CHILD_KEY, "the collection under the named parent is the one asked for"
    assert step["alsoNamedElsewhere"] == ["BBBB2222"] and "BBBB2222" in step["note"]
    assert zotero10.collections["BBBB2222"]["parentCollection"] is False, "the other one is named, not touched"


# --- what a resume is allowed to conclude (review 4) ---------------------------------------------

def test_a_resume_that_would_send_nothing_is_refused_rather_than_journaled(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """`resume_after` equal to the plan length leaves an authorization that sends no operation."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    changes = [{"op": "add_to_collection", "key": key, "collectionKey": CHILD_KEY} for key in ITEM_KEYS[:3]]
    journals_before = sorted(path.name for path in (tmp_path / ".research-toolkit" / "zotero-journal").glob("*.json"))
    writes_before = len(_writes(zotero10))
    refused = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM, resume_after=3)
    assert refused["error"]["code"] == "ZOTERO_WRITE_NOTHING_TO_APPLY"
    assert len(_writes(zotero10)) == writes_before, "nothing was sent"
    assert sorted(path.name for path in (tmp_path / ".research-toolkit" / "zotero-journal").glob("*.json")) == journals_before, "a write that sent nothing does not get a journal pretending it did"

    partial = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM, resume_after=2)
    assert partial["operationCount"] == 1 and len(partial["skippedOperations"]) == 2
    assert "an earlier apply reported them as applied" in partial["skippedNote"], "the skipped operations are named, not dropped"
    assert partial["collectionCheck"]["collections"][0]["membersAfter"] == 1, "the receipt covers only what this call sent"


# --- the journal cap is a file size, so it is measured on a file (review 5) ----------------------

def test_the_journal_cap_is_measured_on_the_file_that_actually_gets_written(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """`journalId`, `takenAt` and `snapshot` are written with the entries, so they are counted with them."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    changes = _filing_changes(CHILD_KEY)
    preview = recommended_server.zotero_write("preview", changes=changes)
    entries_only = len(json.dumps({"entries": zotero_store._journal_entries(preview["planned"])}, ensure_ascii=False).encode("utf-8"))
    assert preview["journalFit"]["bytesNeeded"] > entries_only, "the measurement includes the wrapper the file is written with"
    monkeypatch.setattr(zotero_store, "JOURNAL_MAX_BYTES", entries_only + 20)  # enough for the wrapper idea, not for the file
    fit = recommended_server.zotero_write("preview", changes=changes)["journalFit"]
    assert fit["fits"] is False and fit["bytesNeeded"] > fit["maxBytes"]
    writes_before = len(_writes(zotero10))
    refused = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM)
    assert refused["error"]["code"] == "ZOTERO_JOURNAL_TOO_SMALL" and len(_writes(zotero10)) == writes_before, "the refusal is before the write, not after it"

    accepted = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM, allow_journal_truncation=True)
    journal = accepted["journal"]
    written = (tmp_path / journal["path"]).stat().st_size
    assert written == journal["bytes"] <= zotero_store.JOURNAL_MAX_BYTES, "the cap holds for the file on disk, not only for the entries"
    assert journal["droppedEntries"] > 0 and journal["undoComplete"] is False and "cannot put them back" in journal["warning"]


# --- a listing that stopped early is not the library (review 6) ----------------------------------

def test_a_collection_listing_that_stopped_early_is_not_used_as_a_census(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """`collectionCount` was stated as fact while the read could answer 100; a name match needs the whole list."""
    _authorize(monkeypatch)
    for index in range(1049):
        zotero10.collections[f"C{index:07d}"] = {"name": f"census {index}", "parentCollection": False}
    listing = research.list_zotero_collections()
    assert listing["returnedCount"] == 1000 and listing["totalCount"] == "1049" and listing["truncated"] is True
    assert listing["collectionCount"] == listing["returnedCount"], "`collectionCount` is what this read answered, and `truncated` says that is not everything"
    # The fixture records the path apart from the query, which is what `list_zotero_collections` puts `start` in.
    assert len([entry for entry in zotero10.requests if entry["path"] == "/users/0/collections"]) == research.ZOTERO_COLLECTION_MAX_PAGES, "the listing is paged up to a stated bound"
    assert any("start=900" in entry["query"] for entry in zotero10.requests if entry["path"] == "/users/0/collections"), "the last page asked for is the tenth, not the eleventh this library would need"

    with pytest.raises(research.ResearchError) as error:
        research.zotero_write_preview([{"op": "ensure_collection", "name": "census 1048"}])
    assert error.value.code == "ZOTERO_COLLECTION_LISTING_TRUNCATED"
    assert _writes(zotero10) == [], "no collection is created or adopted on the strength of a half census"


def test_a_total_results_header_that_is_not_a_number_becomes_a_named_refusal(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """0.3.13 ran `int(total)` on a header it did not check, and the tool layer only catches `ResearchError`."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    original = zotero10._collection_items

    def garbled(key: str, params: dict[str, list[str]]) -> _Answer:
        answer = original(key, params)
        return _Answer(answer.body, {**answer.headers, "zotero-total-results": "many"})

    monkeypatch.setattr(zotero10, "_collection_items", garbled)
    with pytest.raises(research.ResearchError) as error:
        research.zotero_collection_items(CHILD_KEY)
    assert error.value.code == "ZOTERO_TOTAL_RESULTS_INVALID" and "many" in str(error.value)
    read = recommended_server.zotero_library("collection_items", key=CHILD_KEY)
    assert read["error"]["code"] == "ZOTERO_TOTAL_RESULTS_INVALID", "the tool answers a named refusal, not a crash"


# --- invariants that were real in code and unproven in tests (review 8) -------------------------

def test_collections_is_not_a_field_update_fields_writes(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """`collections` stays out of `ZOTERO_WRITABLE_FIELDS` on purpose: `add_to_collection` owns it (D6/D9, P4)."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    writes_before = len(_writes(zotero10))
    assert "collections" not in research.ZOTERO_WRITABLE_FIELDS
    for fields in ({"collections": [CHILD_KEY]}, {"title": "Renamed", "collections": [CHILD_KEY]}):
        with pytest.raises(research.ResearchError) as error:
            research.zotero_write_preview([{"op": "update_fields", "key": ITEM_KEYS[0], "fields": fields}])
        assert error.value.code == "ZOTERO_WRITE_FIELD_REFUSED" and "collections" in str(error.value)
    assert len(_writes(zotero10)) == writes_before, "membership is not written as an item field"


def test_one_confirmation_authorizes_the_whole_plan_up_to_a_named_ceiling(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """A 43-item filing is one confirmation over two batches, and the ceiling says where that stops."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    preview = research.zotero_write_preview(_filing_changes(CHILD_KEY))
    assert preview["authorizedOperations"] == 43 and preview["batchesNeeded"] == 2
    assert preview["maxOperationsPerAuthorization"] == research.ZOTERO_WRITE_MAX_OPERATIONS * research.ZOTERO_WRITE_MAX_BATCHES == 100
    assert "authorizes all 43 operations" in preview["authorizationNote"] and "ZOTERO_WRITE_COUNT_INVALID" in preview["authorizationNote"]

    requests_before = len(zotero10.requests)
    with pytest.raises(research.ResearchError) as error:
        research.zotero_write_preview([{"op": "update_fields", "key": ITEM_KEYS[0], "fields": {"extra": f"line {index}"}} for index in range(101)])
    assert error.value.code == "ZOTERO_WRITE_COUNT_INVALID" and "100" in str(error.value)
    assert len(zotero10.requests) == requests_before, "the ceiling is refused before the library is read or written"


def test_a_401_from_the_port_mid_batch_is_reported_operation_by_operation(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch) -> None:
    """The Toolkit's own key check cannot produce a 401 — it refuses before the port is reached (T14-15)."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    zotero10.deny_key_at_item_write = 21
    changes = _filing_changes(CHILD_KEY)
    stopped = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM)
    assert stopped["error"]["code"] == "ZOTERO_WRITE_KEY_MISSING"
    assert len(stopped["applied"]) == 20 and len(stopped["notApplied"]) == 23, "20 filings arrived, 23 never left"
    assert stopped["blocked"] is None and zotero_store.read_write_block() is None, "a key refused mid-write is not a version conflict"
    assert stopped["nextBatch"]["resumeAfter"] == 20 and stopped["nextBatch"]["batchesRemaining"] == 1

    resumed = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM, resume_after=20)
    assert resumed["operationCount"] == 23 and len(resumed["skippedOperations"]) == 20
    record = next(row for row in resumed["collectionCheck"]["collections"] if row["key"] == CHILD_KEY)
    assert record["membersBefore"] == 20 and record["membersAfter"] == 43 and resumed["collectionCheck"]["consistent"] is True


def test_a_blocked_write_marker_that_cannot_be_read_is_a_state_that_refuses_the_write(zotero10: _EmulatedZotero10, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    """A marker the Toolkit cannot read is not the absence of a marker."""
    _authorize(monkeypatch)
    _ensure_two_collections(monkeypatch, zotero10)
    marker = tmp_path / ".research-toolkit" / "zotero-journal" / "blocked-write.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text("{ this is not json", encoding="utf-8")

    assert zotero_store.read_write_block()["corrupt"] is True
    changes = [{"op": "add_to_collection", "key": ITEM_KEYS[2], "collectionKey": CHILD_KEY}]
    writes_before = len(_writes(zotero10))
    refused = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM)
    assert refused["error"]["code"] == "ZOTERO_WRITE_BLOCK_UNREADABLE" and len(_writes(zotero10)) == writes_before, "a marker that cannot be read is a reason to send nothing"

    snapshot = recommended_server.zotero_write("snapshot")
    assert snapshot["snapshot"]["blockCleared"] is True and zotero_store.read_write_block() is None, "the snapshot is what replaces a marker the Toolkit cannot read"
    after = recommended_server.zotero_write("apply", changes=changes, confirm=research.ZOTERO_WRITE_CONFIRM)
    assert after["zoteroModified"] is True and after["collectionCheck"]["consistent"] is True
