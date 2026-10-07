import json
from pathlib import Path

from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]


def test_basic_profile_matches_versioned_schema() -> None:
    schema = json.loads((ROOT / "schemas/profile.schema.json").read_text(encoding="utf-8"))
    profile = json.loads((ROOT / "templates/basic-workspace/.research-toolkit/profile.json").read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(profile)


def test_portable_mcp_template_has_one_server_and_no_credentials() -> None:
    config = json.loads((ROOT / "templates/basic-workspace/.mcp.json").read_text(encoding="utf-8"))
    assert set(config) == {"mcpServers"}
    assert set(config["mcpServers"]) == {"research-stack-basic"}
    server = config["mcpServers"]["research-stack-basic"]
    assert server["command"] == "uv"
    assert "${workspaceFolder}" in " ".join(server["args"])
    assert server["env"]["RESEARCH_STACK_WORKSPACE"] == "${workspaceFolder}"
    assert not any(key.lower().endswith(("token", "secret", "password", "key")) for key in server["env"])


def test_optional_github_entry_is_readonly_and_separate() -> None:
    config = json.loads((ROOT / "templates/optional/github-repos-readonly.mcp.json").read_text(encoding="utf-8"))
    server = config["mcpServers"]["github-repos-readonly"]
    assert server["type"] == "http"
    assert server["url"] == "https://api.githubcopilot.com/mcp/x/repos/readonly"
    assert "token" not in json.dumps(config).lower()
