"""The Full package MCP surface: eleven corpus/record verbs with separated reads and writes."""
import hashlib
import json
import sqlite3
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


def test_the_shipped_lab_surface_carries_titles_annotations_and_cache_hints():
    # 0.3.9 adds verify_sources: the store must be able to say whether a present file was actually
    # checked, and that claim needs its own verb rather than an inference from index_corpus.
    # 0.3.14 (HR-01/HR-06) adds embed_corpus, the verb that builds the stored vectors. Which presets
    # enable it is the preset package's decision, so this asserts the server's own verb set against
    # the preset package's lab-verb list, and keeps the cross-language gate unchanged: presets.json
    # must name exactly the presets.py lab verbs.
    server_verbs = {item.__name__ for item in lab_server.LAB_TOOLS}
    assert server_verbs == LAB_TOOLS | {"embed_corpus"}, "the server's lab verbs are the preset lab verbs plus embed_corpus"
    assert set(lab_server.TOOL_TITLES) == server_verbs
    assert set(lab_server.TOOL_ANNOTATIONS) == server_verbs
    registry = next(server for server in REGISTRY['servers'] if server['module'] == 'research_stack.lab_server')
    assert sorted(registry['tools']) == sorted(LAB_TOOLS)
    recorder = Recorder()
    registered = register_tools(recorder, lab_server.LAB_TOOLS, lab_server.TOOL_TITLES, lab_server.TOOL_ANNOTATIONS)
    assert registered == sorted(LAB_TOOLS & server_verbs), "a verb registers only when the selected preset enables it"
    for name, title, annotations in recorder.registered:
        assert title == lab_server.TOOL_TITLES[name]
        assert annotations is not None
        assert annotations.read_only_hint == (name in READ_ONLY_VERBS), f"{name} must be annotated as it really behaves"
        assert annotations.destructive_hint == (name in DESTRUCTIVE_VERBS)
        if name != "claims_write":
            assert annotations.open_world_hint is False, "local corpus verbs must not advertise an open world"
    embed = lab_server.TOOL_ANNOTATIONS["embed_corpus"]
    assert embed.read_only_hint is False and embed.destructive_hint is False and embed.idempotent_hint is True and embed.open_world_hint is False, \
        "embed_corpus writes the store from stored text, never a source, and re-running it is safe"
    assert lab_server.TOOL_TITLES["embed_corpus"] and lab_server.TOOL_TITLES["search_corpus"]
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


def test_draft_is_an_accepted_claim_status_through_the_verb_and_an_unknown_one_is_refused(workspace):
    """HR-32 (F-02): the claim status a researcher uses for work in progress, end to end."""
    lab_server.index_corpus(["notes/sources.md"])
    chunk_id = lab_server.search_corpus("stitching")["hits"][0]["chunk_id"]
    created = lab_server.claims_write("A statement still being checked against the guild records.",
                                      evidence_chunk_ids=[chunk_id], status="draft")
    assert created["claim"]["status"] == "draft"
    assert lab_server.claims_read(status="draft")["claimCount"] == 1

    refused = lab_server.claims_write("A statement with an invented status.", status="under-review")
    assert refused["error"]["code"] == "CLAIM_STATUS" and "draft" in refused["error"]["message"]
    assert lab_server.claims_read()["claimCount"] == 1, "a refused status change leaves the claim as it was"


def test_a_store_over_the_chunk_ceiling_is_refused_by_every_verb_that_would_score_a_slice(workspace, monkeypatch):
    """T16-04 at the verb boundary: the refusal is an envelope a client can act on, not a stack trace.

    The store here was built by direct SQL, which is how an over-ceiling store realistically exists:
    a restored backup, or a store written before the ceiling was reviewed. ``index_corpus`` was never
    asked to write it, so nothing on the write path ever checked its size, and before 0.3.15 the four
    scoring verbs each answered from the first 20 000 chunks without saying so.

    The 0.3.14 envelope is unchanged — ``resultState``/``error.code``/``error.message`` — and the
    refusal adds the numbers as data next to the code, so the client reads ``currentChunkCount`` and
    ``limit`` instead of parsing the sentence (HR-34). A refused read stays labelled a read.
    """
    root = workspace
    records.init_store(root)
    connection = sqlite3.connect(records.store_path(root))
    text = "The guild records name the stitching pattern of barefoot sandals."
    text_sha = hashlib.sha256(text.encode("utf-8")).hexdigest()
    connection.executemany(
        "INSERT INTO chunks (chunk_id, content_id, source_path, source_sha256, locator, text, text_sha256, "
        "chunker_id, chars, current, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        [(f"over-{index:06d}", f"content-{index:06d}", f"notes/over-{index // 1000}.md", f"{index:064x}"[:64],
          f"paragraph={index % 1000}", text, text_sha, "hashing:1200:120", len(text), "2026-11-22T00:00:00+00:00")
         for index in range(records.MAX_STORE_CHUNKS + 1)],
    )
    # The chunk rows are the store; the source rows are what ``unindex_corpus`` needs in order to be
    # the remediation the refusal names, so the fixture writes both.
    connection.executemany(
        "INSERT OR REPLACE INTO sources (path, source_sha256, bytes, chunk_count, indexed_at, outcome, verification) "
        "VALUES (?, ?, 4096, ?, '2026-11-22T00:00:00+00:00', 'complete', 'verified')",
        [(f"notes/over-{group}.md", f"{group:064x}"[:64], min(1000, records.MAX_STORE_CHUNKS + 1 - group * 1000))
         for group in range((records.MAX_STORE_CHUNKS + 1) // 1000 + 1)],
    )
    connection.commit()
    connection.close()

    for mode in ("lexical", "vector", "hybrid"):
        refusal = lab_server.search_corpus("guild records stitching", limit=5, mode=mode)
        assert refusal["resultState"] == "error", f"the {mode} mode answered from a slice instead of refusing"
        error = refusal["error"]
        assert error["code"] == records.STORE_OVER_LIMIT_READ_CODE
        assert error["currentChunkCount"] == records.MAX_STORE_CHUNKS + 1
        assert error["limit"] == records.MAX_STORE_CHUNKS
        assert error["overBy"] == 1
        assert "slice" in error["consequence"] and error["remediation"], "the payload names the consequence and the way back"
        assert "unindex_corpus" in " ".join(error["remediation"])
        assert refusal["readOnly"] is True, "a refused read stays labelled a read"

    embed = lab_server.embed_corpus()
    assert embed["resultState"] == "error" and embed["error"]["code"] == records.STORE_OVER_LIMIT_READ_CODE
    assert embed["error"]["currentChunkCount"] == records.MAX_STORE_CHUNKS + 1

    status = lab_server.store_status()
    assert status["readOnly"] is True and status["chunkCount"] == records.MAX_STORE_CHUNKS + 1
    assert status["vectorSearch"]["overLimit"] is True and status["vectorSearch"]["chunkLimit"] == records.MAX_STORE_CHUNKS

    # The write-side name for the same ceiling is unchanged, and the write path stays the place where
    # an over-ceiling store is brought back under it.
    over_limit_write = lab_server.index_corpus(["notes/sources.md"])
    assert over_limit_write["error"]["code"] == records.STORE_CHUNK_LIMIT_CODE
    assert over_limit_write["error"]["code"] != records.STORE_OVER_LIMIT_READ_CODE, (
        "the write refusal and the read refusal stay distinguishable: one stopped a write, one stopped a ranking")

    removed = lab_server.unindex_corpus(["notes/over-0.md", "notes/over-1.md"])
    assert removed["removedSources"] == ["notes/over-0.md", "notes/over-1.md"]
    status_after = lab_server.store_status()
    assert status_after["vectorSearch"]["overLimit"] is False, "the remediation the refusal names actually brings the store back under the ceiling"
    assert lab_server.search_corpus("stitching pattern guild")["method"] == "bm25", "the default mode is unchanged once the store is supported again"


def test_the_embedding_receipt_says_which_chunks_it_computed_and_which_it_reused(workspace):
    """T16-04 in the embedding report: total, computed now, reused, and produced no signature.

    ``vectorsWritten``/``vectorsReused`` existed in 0.3.14 but the receipt never said they add up to
    the store, and a chunk whose stored row matched its labels while its blob was unreadable was
    counted as reused. The receipt now accounts for every current chunk in one bucket each.
    """
    lab_server.index_corpus(["notes/sources.md"])
    reused = lab_server.embed_corpus()
    assert reused["writeMode"] == "store-only"
    accounting = reused["chunkAccounting"]
    assert accounting["totalCurrentChunks"] == reused["currentChunks"]
    assert accounting["embeddedNow"] == 0 and accounting["reusedExistingVector"] == accounting["totalCurrentChunks"]
    assert accounting["noSignatureProduced"] == 0 and accounting["sumsToCurrentChunks"] is True
    assert reused["chunkLimit"] == records.MAX_STORE_CHUNKS

    connection = sqlite3.connect(records.store_path(workspace))
    target = connection.execute("SELECT chunk_id FROM chunks WHERE current = 1 ORDER BY chunk_id LIMIT 1").fetchone()[0]
    connection.execute("UPDATE chunk_vectors SET vector = ? WHERE chunk_id = ?", ("truncated-base64", target))
    connection.commit()
    connection.close()

    rebuilt = lab_server.embed_corpus()
    assert rebuilt["chunkAccounting"]["rebuiltUnreadableVector"] == 1
    assert rebuilt["chunkAccounting"]["reusedExistingVector"] == rebuilt["chunkAccounting"]["totalCurrentChunks"] - 1
    assert rebuilt["after"]["undecodableVectorCount"] == 0
    assert rebuilt["after"]["scoreableChunks"] == rebuilt["currentChunks"]


def test_status_and_search_on_a_fresh_workspace_report_the_missing_store_without_creating_one(workspace):
    """F13: a read against a workspace with no store must not create one."""
    before = list(workspace.rglob("*"))
    status = lab_server.store_status()
    assert status["error"]["code"] == "STORE_MISSING"
    assert lab_server.search_corpus("guild")["error"]["code"] == "STORE_MISSING"
    assert lab_server.claims_read()["error"]["code"] == "STORE_MISSING"
    assert not records.store_path(workspace).exists(), "a read created a store in a workspace that had none"
    assert list(workspace.rglob("*")) == before
