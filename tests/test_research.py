from __future__ import annotations

import json
from pathlib import Path
import urllib.error

import pytest

from research_stack import research
from research_stack.recommended import add_recommended_workspace
from research_stack.workspace import initialize_workspace


def test_normalize_doi_handles_url_case_and_invalid_values() -> None:
    assert research.normalize_doi("https://doi.org/10.1234/ABC.X") == "10.1234/abc.x"
    assert research.normalize_doi("doi: 10.5555/xyz") == "10.5555/xyz"
    assert research.normalize_doi("not-a-doi") is None


def test_search_all_merges_only_exact_doi_and_retains_field_conflicts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED", "true")
    def response(url: str, headers: dict[str, str] | None = None):
        if "api.openalex.org" in url:
            return ({"results": [{"id": "https://openalex.org/W1", "doi": "https://doi.org/10.1234/ABC", "title": "Provider A title", "authorships": [{"author": {"display_name": "Ada Author"}}], "publication_year": 2024, "abstract_inverted_index": {"Evidence": [1], "Bounded": [0]}}], "meta": {"count": 1}}, {})
        if "api.crossref.org" in url:
            return ({"message": {"items": [{"DOI": "10.1234/abc", "title": ["Provider B title"], "author": [{"given": "Ada", "family": "Author"}], "published-print": {"date-parts": [[2024]]}}], "total-results": 1}}, {})
        return ({"data": [{"paperId": "S2-2", "title": "Provider C title", "authors": [{"name": "Other author"}], "year": 2024, "externalIds": {"DOI": "10.9876/else"}}], "total": 1}, {})

    monkeypatch.setattr(research, "_request_json", response)
    result = research.search_literature("all", "bounded evidence", 5)
    assert result["resultState"] == "complete"
    assert len(result["records"]) == 2
    by_id = {record["id"]: record for record in result["records"]}
    shared = by_id["doi:10.1234/abc"]
    assert shared["title"]["value"] == "Provider A title"
    assert shared["title"]["conflicts"] == ["Provider A title", "Provider B title"]
    assert len(shared["title"]["provenance"]) == 2
    assert shared["abstract"]["value"] == "Bounded Evidence"
    assert by_id["doi:10.9876/else"]["sourceIds"] == {"semantic_scholar": "S2-2"}
    assert by_id["doi:10.9876/else"]["attribution"][0]["url"].endswith("?utm_source=api")
    import jsonschema

    schema = json.loads((Path(__file__).resolve().parents[1] / "schemas/research-record.schema.json").read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    for record in result["records"]:
        validator.validate(record)


def test_search_rejects_unbounded_input() -> None:
    with pytest.raises(research.ResearchError, match="limit must be"):
        research.search_literature("openalex", "question", 26)


def test_all_search_preserves_partial_provider_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED", "true")
    def one(provider: str, _query: str, _limit: int):
        if provider == "crossref":
            raise research.ResearchError("PROVIDER_RATE_LIMITED", "limited", retry_after="2")
        return [], {"provider": provider, "returned": 0}

    monkeypatch.setattr(research, "_search_one", one)
    result = research.search_literature("all", "topic", 1)
    assert result["resultState"] == "partial"
    assert len(result["providers"]) == 2
    assert result["errors"][0]["provider"] == "crossref"
    assert result["errors"][0]["retryAfter"] == "2"


def test_semantic_scholar_requires_explicit_license_acknowledgment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED", raising=False)
    monkeypatch.setattr(research, "_search_one", lambda *_args: pytest.fail("Terms gate must block the request"))
    with pytest.raises(research.ResearchError) as error:
        research.search_literature("semantic_scholar", "topic", 1)
    assert error.value.code == "PROVIDER_TERMS_NOT_ACKNOWLEDGED"


def test_zotero_collection_read_keeps_server_identity_and_read_only(monkeypatch: pytest.MonkeyPatch) -> None:
    def fixture(path: str):
        assert path == "users/0/collections?limit=100&format=json"
        return ([{"key": "ABCD1234", "data": {"name": "Disposable", "parentCollection": False}}], {"zotero-server-id": "fixture-server"})

    monkeypatch.setattr(research, "_zotero_request", fixture)
    result = research.list_zotero_collections()
    assert result["serverId"] == "fixture-server"
    assert result["readOnly"] is True
    assert result["collections"][0]["name"] == "Disposable"


def test_provider_denial_is_not_reported_as_no_results(monkeypatch: pytest.MonkeyPatch) -> None:
    class DeniedOpener:
        def open(self, *_args, **_kwargs):
            raise urllib.error.HTTPError("https://api.openalex.org/works", 429, "slow down", {"Retry-After": "4"}, None)

    monkeypatch.setattr(research.urllib.request, "build_opener", lambda *_args, **_kwargs: DeniedOpener())
    with pytest.raises(research.ResearchError) as error:
        research._request_json("https://api.openalex.org/works")
    assert error.value.code == "PROVIDER_RATE_LIMITED"
    assert error.value.retry_after == "4"


def test_crossref_miss_is_unresolved_not_invalid(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing(*_args, **_kwargs):
        raise research.ResearchError("PROVIDER_NOT_FOUND", "not found")

    monkeypatch.setattr(research, "_request_json", missing)
    result = research.validate_citation("https://doi.org/10.1234/not-in-crossref")
    assert result["status"] == "unresolved"
    assert "not proof" in result["reason"]


def test_ris_is_user_reviewable_and_keeps_doi() -> None:
    text = research.to_ris([{"title": {"value": "Evidence report"}, "publicationType": {"value": "journal-article"}, "doi": {"value": "10.1234/abc"}, "authors": {"value": ["Ada Author"]}, "year": {"value": 2024}, "attribution": [{"provider": "Semantic Scholar", "url": "https://www.semanticscholar.org/paper/paper-id?utm_source=api"}]}])
    assert "TY  - JOUR" in text
    assert "AU  - Ada Author" in text
    assert "DO  - 10.1234/abc" in text
    assert "UR  - https://www.semanticscholar.org/paper/paper-id?utm_source=api" in text
    assert text.endswith("ER  -\n")


def test_zotero_item_key_validation_precedes_network(monkeypatch: pytest.MonkeyPatch) -> None:
    def should_not_call(*_args, **_kwargs):
        pytest.fail("Invalid key must be rejected before any local request")

    monkeypatch.setattr(research, "_zotero_request", should_not_call)
    with pytest.raises(research.ResearchError, match="eight uppercase"):
        research.get_zotero_item("not-a-key")


def test_add_recommended_merges_and_is_idempotent(tmp_path) -> None:
    initialize_workspace(tmp_path)
    worker_package = tmp_path / ".research-toolkit/worker/src/research_stack"
    (worker_package / "research.py").unlink()
    (worker_package / "recommended_server.py").unlink()
    extensions_path = tmp_path / ".vscode/extensions.json"
    extensions_path.write_text(json.dumps({"recommendations": ["GitHub.copilot"], "unrelated": True}), encoding="utf-8")
    mcp_path = tmp_path / ".mcp.json"
    config = json.loads(mcp_path.read_text(encoding="utf-8"))
    config["mcpServers"]["custom-user-server"] = {"command": "custom"}
    mcp_path.write_text(json.dumps(config), encoding="utf-8")
    sentinel = tmp_path / ".github/skills/user-skill/SKILL.md"
    sentinel.parent.mkdir(parents=True)
    sentinel.write_text("user content", encoding="utf-8")

    first = add_recommended_workspace(tmp_path)
    second = add_recommended_workspace(tmp_path)
    extensions = json.loads(extensions_path.read_text(encoding="utf-8"))
    mcp = json.loads(mcp_path.read_text(encoding="utf-8"))
    assert "ms-python.python" in extensions["recommendations"]
    assert "ms-toolsai.jupyter" in extensions["recommendations"]
    assert extensions["unrelated"] is True
    assert "custom-user-server" in mcp["mcpServers"]
    assert "research-stack-basic" in mcp["mcpServers"]
    assert "research-stack-recommended" in mcp["mcpServers"]
    assert sentinel.read_text(encoding="utf-8") == "user content"
    assert any(name.endswith("research.py") for name in first["created"])
    assert second["created"] == []


def test_recommended_profile_delta_matches_schema() -> None:
    import jsonschema

    root = Path(__file__).resolve().parents[1]
    schema = json.loads((root / "schemas/recommended-profile.schema.json").read_text(encoding="utf-8"))
    profile = json.loads((root / "templates/recommended-overlay/.research-toolkit/recommended-profile.json").read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator(schema).validate(profile)
