"""Goal-based tool presets for the Research Stack workers.

A preset describes the goal the operator is working on ("read and cite one
document", "prepare a Zotero import"), not the MCP server layout. The selected
preset id is passed to each worker through RESEARCH_STACK_TOOL_PRESET and only
the tools that serve that goal are registered, so the assistant is given a
smaller, purpose-shaped tool surface.

An unset or unknown preset value resolves to "all", which preserves the
behaviour of every earlier release: existing MCP configurations, skills and
prompts keep working unchanged.
"""

from __future__ import annotations

import os

PRESET_ENV = "RESEARCH_STACK_TOOL_PRESET"
DEFAULT_PRESET = "all"

DOCUMENT_TOOLS = frozenset({"read_document", "read_text_source", "search_local_text", "write_markdown", "write_docx"})
# 0.3.13: the Zotero work is two verbs, not three. `zotero_write` is the only destructive Zotero verb and
# it is deliberately kept out of every package default preset (DD14-03).
RESEARCH_TOOLS = frozenset({"search_literature", "check_citation", "zotero_library", "zotero_write", "prepare_zotero_import"})
RESEARCH_READ_TOOLS = RESEARCH_TOOLS - frozenset({"zotero_write"})
LAB_TOOLS = frozenset({"index_corpus", "embed_corpus", "unindex_corpus", "search_corpus", "evidence_read", "verify_sources", "claims_read", "claims_write", "claims_export", "store_status", "store_maintenance"})
ALL_TOOLS = DOCUMENT_TOOLS | RESEARCH_TOOLS | LAB_TOOLS

#: Preset id -> the toolkit tools that the goal enables. Kept in sync with
#: extension/presets.json by tests/test_presets.py and extension/test/presets.test.js.
TOOL_PRESETS: dict[str, frozenset[str]] = {
    "read-and-cite": frozenset({"read_document", "read_text_source", "write_markdown", "write_docx"}),
    "find-in-notes": frozenset({"search_local_text", "read_text_source", "read_document"}),
    "verify-citations": frozenset({"search_literature", "check_citation"}),
    # The one goal whose whole point is the Zotero handoff, and therefore the only managed preset that
    # ever sees a Zotero write.
    "zotero-handoff": RESEARCH_TOOLS,
    "research-core": DOCUMENT_TOOLS | RESEARCH_READ_TOOLS,
    # Retired in 0.3.14 (DD15-07): these two ids stay registered so a saved 0.3.13 preference resolves
    # to a stated retirement instead of falling back in silence. They are offered by no package and
    # carry no third-party surface, because their whole 0.3.13 content was an unnamed tool estimate.
    "research-lab": DOCUMENT_TOOLS | RESEARCH_READ_TOOLS,
    "research-lab-max": DOCUMENT_TOOLS | RESEARCH_READ_TOOLS,
    # The continuous Full journey: read a source, index it, build its retrieval vectors, retrieve a
    # passage, resolve and re-verify the evidence, record a claim, export it, and read the store.
    # 15 toolkit tools, inside the 20-tool 0.3.14 budget.
    "research-workflow": frozenset({
        "read_document", "read_text_source", "write_markdown", "write_docx",
        "search_literature", "check_citation",
        "index_corpus", "embed_corpus", "search_corpus", "evidence_read", "verify_sources",
        "claims_read", "claims_write", "claims_export", "store_status",
    }),
    "corpus-lab": LAB_TOOLS | frozenset({"read_text_source"}),
    # The three max goals (HR-10, DD15-01). Each carries the toolkit verbs its objective uses and
    # names the one or five it leaves out; the GitHub difference between them is third-party and is
    # described in extension/presets.json, which is where the exact tool names live.
    "research-max-github-full": frozenset({
        "read_document", "read_text_source", "write_markdown", "write_docx",
        "search_literature", "check_citation", "zotero_library",
        "index_corpus", "embed_corpus", "search_corpus", "evidence_read", "verify_sources",
        "claims_read", "claims_write", "claims_export", "store_status",
    }),
    # Reading evidence does not need a vacuum or a restore: store_maintenance is the verb this goal drops.
    "research-max-github-limited": ALL_TOOLS - frozenset({"store_maintenance"}),
    # The stored corpus is this goal's search surface, so search_local_text is the verb it drops.
    "research-max-no-github": ALL_TOOLS - frozenset({"search_local_text"}),
    DEFAULT_PRESET: ALL_TOOLS,
}


class PresetError(ValueError):
    """An actionable error about the requested tool preset."""


def preset_names() -> list[str]:
    return sorted(name for name in TOOL_PRESETS if name != DEFAULT_PRESET)


def selected_preset(environ: dict[str, str] | None = None) -> str:
    """Return the requested preset, falling back to the 0.3.2 behaviour."""
    value = (environ if environ is not None else os.environ).get(PRESET_ENV, DEFAULT_PRESET)
    value = value.strip() or DEFAULT_PRESET
    if value not in TOOL_PRESETS:
        raise PresetError(
            f"TOOL_PRESET_UNKNOWN: {value!r} is not a Research Stack tool preset. "
            f"Expected one of {', '.join(preset_names())} or {DEFAULT_PRESET}."
        )
    return value


def enabled_tools(preset: str) -> frozenset[str]:
    if preset not in TOOL_PRESETS:
        raise PresetError(f"TOOL_PRESET_UNKNOWN: {preset!r}.")
    return TOOL_PRESETS[preset]


def tool_enabled(name: str, environ: dict[str, str] | None = None) -> bool:
    return name in enabled_tools(selected_preset(environ))


def register_tools(
    server,
    functions,
    titles: dict[str, str] | None = None,
    annotations: dict[str, object] | None = None,
    environ: dict[str, str] | None = None,
) -> list[str]:
    """Register only the tools the selected goal enables, in deterministic name order.

    A stable ``tools/list`` order keeps client prompt caches and tool lists comparable
    between sessions; behaviour annotations are passed through so clients can display
    and gate read versus write tools.
    """
    preset = selected_preset(environ)
    registered: list[str] = []
    for function in sorted(functions, key=lambda item: item.__name__):
        name = function.__name__
        if name not in enabled_tools(preset):
            continue
        kwargs: dict[str, object] = {"title": (titles or {}).get(name)}
        hint = (annotations or {}).get(name)
        if hint is not None:
            kwargs["annotations"] = hint
        server.tool(**kwargs)(function)
        registered.append(name)
    return registered
