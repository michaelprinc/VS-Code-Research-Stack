from pathlib import Path

from research_stack.workspace import initialize_workspace


def test_workspace_init_is_idempotent_and_preserves_user_files(tmp_path: Path) -> None:
    workspace = tmp_path / "Research Workspace č"
    workspace.mkdir()
    (workspace / "AGENTS.md").write_text("user-owned", encoding="utf-8")
    first = initialize_workspace(workspace)
    second = initialize_workspace(workspace)
    assert "AGENTS.md" in first["preserved"]
    assert (workspace / "AGENTS.md").read_text(encoding="utf-8") == "user-owned"
    assert ".mcp.json" in first["created"]
    assert ".mcp.json" in second["preserved"]
    assert (workspace / ".research-toolkit/worker/src/research_stack/mcp_server.py").is_file()
