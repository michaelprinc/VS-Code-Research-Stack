"""The Full package MCP surface: nine corpus/record verbs with separated reads and writes."""
import json
from pathlib import Path

import pytest

from research_stack import lab_server, records
from research_stack.presets import LAB_TOOLS, register_tools

REGISTRY = json.loads((Path(__file__).resolve().parents[1] / 'extension/presets.json').read_text(encoding='utf-8'))

READ_ONLY_VERBS = {"claims_export", "claims_read", "evidence_read", "search_corpus", "store_status"}
DESTRUCTIVE_VERBS = {"store_maintenance", "unindex_corpus"}


class Recorder:
    def __init__(self):
        self.registered = []

    def tool(self, title=None, annotations=None):
        def decorator(function):
            self.registered.append((function.__name__, title, annotations))
            return function
        return decorator

    def run(self, transport=None):
        self.ran = transport


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    (tmp_path / "notes").mkdir()
    (tmp_path / "notes" / "sources.md").write_text(
        "# Sources\n\nThe guild records name the stitching pattern used for barefoot sandals.\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", str(tmp_path))
    return tmp_path


def test_the_shipped_lab_surface_is_nine_verbs_with_titles_annotations_and_cache_hints():
    assert {item.__name__ for item in lab_server.LAB_TOOLS} == LAB_TOOLS
    assert len(LAB_TOOLS) == 9
    assert set(lab_server.TOOL_TITLES) == LAB_TOOLS
    assert set(lab_server.TOOL_ANNOTATIONS) == LAB_TOOLS
    registry = next(server for server in REGISTRY['servers'] if server['module'] == 'research_stack.lab_server')
    assert sorted(registry['tools']) == sorted(LAB_TOOLS)
    recorder = Recorder()
    assert register_tools(recorder, lab_server.LAB_TOOLS, lab_server.TOOL_TITLES, lab_server.TOOL_ANNOTATIONS) == sorted(LAB_TOOLS)
    for name, title, annotations in recorder.registered:
        assert title == lab_server.TOOL_TITLES[name]
        assert annotations is not None
        assert annotations.read_only_hint == (name in READ_ONLY_VERBS), f"{name} must be annotated as it really behaves"
        assert annotations.destructive_hint == (name in DESTRUCTIVE_VERBS)
        if name != "claims_write":
            assert annotations.open_world_hint is False, "local corpus verbs must not advertise an open world"
    hint = lab_server.TOOL_LIST_CACHE_HINTS['tools/list']
    assert hint.ttl_ms == 300_000 and hint.scope == 'private'


def test_a_missing_or_invalid_workspace_returns_an_error_envelope_not_a_traceback(monkeypatch):
    monkeypatch.delenv("RESEARCH_STACK_WORKSPACE", raising=False)
    failure = lab_server.search_corpus("guild")
    assert failure["resultState"] == "error" and failure["error"]["code"] == "CONFIG_REQUIRED"
    assert "RESEARCH_STACK_WORKSPACE" in failure["error"]["message"]
    monkeypatch.setenv("RESEARCH_STACK_WORKSPACE", "/definitely/not/here")
    failure = lab_server.store_status()
    assert failure["error"]["code"] == "CONFIG_INVALID"


def test_index_search_and_claim_round_trip_through_the_tools(workspace):
    indexed = lab_server.index_corpus(["notes/sources.md"])
    assert indexed["mode"] == "index" and indexed["persistentIndex"] is True
    assert indexed["chunksStored"] >= 1 and len(indexed["indexFingerprint"]) == 64

    hits = lab_server.search_corpus("stitching pattern guild", limit=3)
    assert hits["method"] == "bm25" and hits["readOnly"] is True and hits["hits"]
    chunk_id = hits["hits"][0]["chunk_id"]

    written = lab_server.claims_write("The guild records name the stitching pattern.", evidence_chunk_ids=[chunk_id],
                                      status="supported", evidence_rationale="Direct statement in the sources note.")
    assert written["writeMode"] == "create-or-patch" and written["created"] is True
    claim_id = written["claim"]["claim_id"]

    read = lab_server.claims_read()
    assert read["readOnly"] is True and read["claimCount"] == 1
    assert read["claims"][0]["claim_id"] == claim_id
    assert read["claims"][0]["evidence"][0]["chunk_id"] == chunk_id
    assert read["claims"][0]["evidence"][0]["role"] == "supporting"

    resolved = lab_server.evidence_read([chunk_id, "invented-id"])
    assert resolved["readOnly"] is True and resolved["evidence"][0]["chunk_id"] == chunk_id
    assert resolved["unresolved"] == ["invented-id"]
    assert resolved["evidence"][0]["sourcePath"] == "notes/sources.md" and len(resolved["evidence"][0]["textSha256"]) == 64

    exported = lab_server.claims_export([claim_id])
    assert exported["references"][0]["reference"] == "notes/sources.md" and len(exported["references"][0]["sha256"]) == 64

    status = lab_server.store_status()
    assert status["claimCount"] == 1 and status["chunkCount"] >= 1 and status["indexFingerprint"] == indexed["indexFingerprint"]
    assert status["schemaVersion"] == records.SCHEMA_VERSION


def test_an_invented_evidence_id_is_refused_so_claims_cannot_float_free(workspace):
    lab_server.index_corpus(["notes/sources.md"])
    failure = lab_server.claims_write("A claim with no source.", evidence_chunk_ids=["not-a-real-chunk"])
    assert failure["error"]["code"] == "EVIDENCE_NOT_FOUND"
    assert lab_server.claims_read()["claimCount"] == 0, "a rejected write leaves no partial claim behind"


def test_index_mode_and_store_action_mistakes_are_reported(workspace):
    lab_server.index_corpus(["notes/sources.md"])
    bad_mode = lab_server.index_corpus(["notes/sources.md"], mode="overwrite-everything")
    assert bad_mode["error"]["code"] == "INDEX_MODE"
    removed_by_old_mode = lab_server.index_corpus(["notes/sources.md"], mode="remove")
    assert removed_by_old_mode["error"]["code"] == "INDEX_MODE_REMOVED"
    assert "unindex_corpus" in removed_by_old_mode["error"]["message"]
    bad_action = lab_server.store_maintenance("backup-everything")
    assert bad_action["error"]["code"] == "STORE_ACTION"


def test_unindex_corpus_is_the_destructive_verb_and_keeps_cited_evidence(workspace):
    lab_server.index_corpus(["notes/sources.md"])
    chunk_id = lab_server.search_corpus("stitching")["hits"][0]["chunk_id"]
    lab_server.claims_write("The stitching pattern is named in the guild records.", evidence_chunk_ids=[chunk_id], status="supported")

    removed = lab_server.unindex_corpus(["notes/sources.md"])
    assert removed["mode"] == "remove" and removed["removedSources"] == ["notes/sources.md"]
    assert removed["retainedEvidenceChunks"] >= 1
    assert removed["sourceFilesModified"] is False
    assert (workspace / "notes" / "sources.md").is_file(), "un-indexing never deletes the researcher's file"
    assert not lab_server.search_corpus("stitching")["hits"], "the removed source is no longer searchable"

    claim = lab_server.claims_read()["claims"][0]
    assert claim["evidence"][0]["chunk_id"] == chunk_id and claim["evidence"][0]["stale"] is True
    assert lab_server.evidence_read([chunk_id])["evidence"][0]["resolvable"] is True
    assert lab_server.claims_export([claim["claim_id"]])["excludedStaleReferences"] == 1

    not_indexed = lab_server.unindex_corpus(["notes/never-indexed.md"])
    assert not_indexed["removedSources"] == [] and not_indexed["notIndexed"] == ["notes/never-indexed.md"]


def test_reindexing_through_the_tools_keeps_evidence_resolvable(workspace):
    lab_server.index_corpus(["notes/sources.md"])
    chunk_id = lab_server.search_corpus("stitching")["hits"][0]["chunk_id"]
    lab_server.claims_write("The guild records name the stitching pattern.", evidence_chunk_ids=[chunk_id], status="supported")
    (workspace / "notes" / "sources.md").write_text("# Sources\n\nRevised: the archive names a different pattern.\n", encoding="utf-8")
    lab_server.index_corpus(["notes/sources.md"], mode="reindex")

    claim = lab_server.claims_read()["claims"][0]
    assert claim["staleEvidenceCount"] == 1 and claim["evidence"][0]["resolvable"] is True
    assert "recorded assessment" in lab_server.claims_read()["assessment"]


def test_store_maintenance_backs_up_and_vacuum_still_needs_confirmation(workspace):
    lab_server.index_corpus(["notes/sources.md"])
    backup = lab_server.store_maintenance("backup")
    assert Path(backup["backup"]).is_file() and backup["integrityCheck"] == "ok" and len(backup["sha256"]) == 64
    assert backup["writeMode"] == "new-file-only"

    unconfirmed = lab_server.store_maintenance("vacuum")
    assert unconfirmed["error"]["code"] == "CONFIRM_REQUIRED"
    confirmed = lab_server.store_maintenance("vacuum", confirm=True)
    assert confirmed["confirmed"] is True
    assert records.index_state(workspace)["chunkCount"] == confirmed["chunksBefore"]

    staged = lab_server.store_maintenance("restore", backup_path=backup["backup"])
    assert staged["activated"] is False and Path(staged["candidate"]).is_file()
    assert lab_server.claims_read()["claimCount"] == 0
    lab_server.claims_write("A claim that an unconfirmed restore must not discard.")
    assert lab_server.claims_read()["claimCount"] == 1
    activated = lab_server.store_maintenance("restore", backup_path=backup["backup"], confirm=True)
    assert activated["activated"] is True and Path(activated["previousStorePreserved"]).is_file()
    assert lab_server.claims_read()["claimCount"] == 0, "the activated restore matches the backup"


def test_status_and_search_on_a_fresh_workspace_report_the_missing_store_without_creating_one(workspace):
    """F13: a read against a workspace with no store must not create one."""
    before = list(workspace.rglob("*"))
    status = lab_server.store_status()
    assert status["error"]["code"] == "STORE_MISSING"
    assert lab_server.search_corpus("guild")["error"]["code"] == "STORE_MISSING"
    assert lab_server.claims_read()["error"]["code"] == "STORE_MISSING"
    assert not records.store_path(workspace).exists(), "a read created a store in a workspace that had none"
    assert list(workspace.rglob("*")) == before
