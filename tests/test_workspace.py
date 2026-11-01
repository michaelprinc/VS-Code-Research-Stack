import json
import os
from pathlib import Path

from research_stack.cli import main
from research_stack.paths import PathPolicyError
from research_stack.records import SCHEMA_VERSION, index_state
from research_stack.workspace import initialize_workspace, init_lab_workspace


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


def test_cliJunction_cannot_redirect_a_bootstrap_destination_outside_the_workspace(tmp_path: Path) -> None:
    """F01: the CLI bootstrap refuses a linked destination instead of writing through it."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(str(outside), str(workspace / ".github"), target_is_directory=True)
    try:
        initialize_workspace(workspace)
    except PathPolicyError as failure:
        assert "PATH_IS_LINK" in str(failure)
    else:
        raise AssertionError("a linked .github directory was followed instead of refused")
    assert not list(outside.iterdir()), "nothing was written through the link"


def test_init_lab_creates_the_store_and_records_only_what_exists(tmp_path: Path) -> None:
    workspace = tmp_path / "Research Workspace č"
    workspace.mkdir()
    (workspace / "notes").mkdir()
    (workspace / "notes" / "one.md").write_text("# One\n\nA claim about the guild records.\n", encoding="utf-8")
    result = init_lab_workspace(workspace)
    assert result["ok"] is True and result["tableCount"] == 7
    assert result["store"] == str(workspace / ".research-toolkit/store/research.sqlite3")
    state = json.loads((workspace / ".research-toolkit/lab-state.json").read_text(encoding="utf-8"))
    assert state["profileId"] == "full" and state["serviceMode"] == "local-stdio"
    assert state["storeSchemaVersion"] == SCHEMA_VERSION
    assert state["vectorSearch"] == "not-implemented" and state["externalDatabases"] == "not-installed"
    assert "full-profile.json" not in [item.name for item in (workspace / ".research-toolkit").iterdir()], \
        "the toolkit does not claim an index service it does not run"

    again = init_lab_workspace(workspace)
    assert again["preexisting"] is True
    assert (workspace / "notes" / "one.md").read_text(encoding="utf-8").startswith("# One")

    exit_code = main(["init-lab", "--workspace", str(workspace)])
    assert exit_code == 0
    assert index_state(workspace)["schemaVersion"] == SCHEMA_VERSION


def test_init_lab_refuses_a_missing_workspace(tmp_path: Path) -> None:
    assert main(["init-lab", "--workspace", str(tmp_path / "nope")]) == 2


def test_the_bootstrap_workspace_ignores_every_derived_record_store_path(tmp_path: Path) -> None:
    """T5-20: the record store holds copied source text, so derived data is never committed by default."""
    workspace = tmp_path / "Derived data"
    initialize_workspace(workspace)
    ignore = (workspace / ".gitignore").read_text(encoding="utf-8")
    for derived in (".research-toolkit/store/", ".research-toolkit/backups/",
                    ".research-toolkit/lab-state.json", ".research-toolkit/managed/.setup.lock",
                    ".research-toolkit/logs/"):
        assert derived in ignore, f"{derived} is not ignored by the bootstrap workspace"
    created = init_lab_workspace(workspace)
    assert created["ok"] is True and created["tableCount"] == 7, "the store step reports what the store contains"
    assert created["store"] == str(workspace / ".research-toolkit/store/research.sqlite3")


def test_labStateJunction_cannot_redirect_the_lab_state_record_outside_the_workspace(tmp_path: Path) -> None:
    """T5-01: the lab-state write goes through the same containment policy as every other toolkit write."""
    workspace_root = tmp_path / "Linked state"
    workspace_root.mkdir()
    outside = tmp_path / "outside-state"
    outside.mkdir()
    os.symlink(str(outside), str(workspace_root / ".research-toolkit"), target_is_directory=True)
    try:
        init_lab_workspace(workspace_root)
    except (PathPolicyError, ValueError) as error:
        assert "PATH_IS_LINK" in str(error), f"the refusal must name the linked path, got {error}"
    else:
        raise AssertionError("a linked .research-toolkit directory must be refused, not followed")
    assert not list(outside.iterdir()), "nothing was written through the link"
