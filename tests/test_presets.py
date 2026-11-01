"""Goal presets decide which toolkit tools the workers register."""
import json
from pathlib import Path

import pytest

from research_stack.presets import (
    ALL_TOOLS,
    DEFAULT_PRESET,
    DOCUMENT_TOOLS,
    LAB_TOOLS,
    PRESET_ENV,
    RESEARCH_TOOLS,
    TOOL_PRESETS,
    PresetError,
    enabled_tools,
    preset_names,
    register_tools,
    selected_preset,
    tool_enabled,
)

REGISTRY = json.loads((Path(__file__).resolve().parents[1] / 'extension/presets.json').read_text(encoding='utf-8'))


class Recorder:
    """Stand-in for MCPServer.tool() that records what would be registered."""

    def __init__(self):
        self.registered = []

    def tool(self, title=None, annotations=None):
        def decorator(function):
            self.registered.append((function.__name__, title, annotations))
            return function
        return decorator

    def run(self, transport=None):
        self.ran = transport


def document_tools():
    from research_stack.mcp_server import DOCUMENT_TOOLS, TOOL_ANNOTATIONS, TOOL_TITLES
    return DOCUMENT_TOOLS, TOOL_TITLES, TOOL_ANNOTATIONS


def research_tools():
    from research_stack.recommended_server import RESEARCH_TOOLS, TOOL_ANNOTATIONS, TOOL_TITLES
    return RESEARCH_TOOLS, TOOL_TITLES, TOOL_ANNOTATIONS


def test_worker_gating_and_the_extension_registry_agree():
    registry = {item['id']: set(item['tools']) for item in REGISTRY['presets']}
    assert set(registry) == set(TOOL_PRESETS) - {DEFAULT_PRESET}
    assert preset_names() == sorted(registry)
    for preset_id, tools in registry.items():
        assert set(enabled_tools(preset_id)) == tools, preset_id
    shipped = set()
    for server in REGISTRY['servers']:
        shipped |= set(server['tools'])
    assert shipped == ALL_TOOLS
    for preset in REGISTRY['presets']:
        assert len(preset['tools']) <= REGISTRY['budget']['clientCeiling']


def test_no_preset_exceeds_the_client_ceiling_and_the_widest_uses_the_budget():
    ceiling = REGISTRY['budget']['clientCeiling']
    for preset in REGISTRY['presets']:
        total = len(preset['tools']) + sum(item['toolsEstimate'] for item in preset['thirdParty'])
        assert total <= ceiling, f"{preset['id']}: {total} tools"
    widest = max(REGISTRY['presets'], key=lambda item: len(item['tools']) + sum(x['toolsEstimate'] for x in item['thirdParty']))
    assert len(widest['tools']) + sum(x['toolsEstimate'] for x in widest['thirdParty']) > REGISTRY['budget']['accuracyBand']
    assert widest['id'] == 'research-lab-max'


def test_missing_environment_keeps_the_previous_full_behaviour():
    assert selected_preset({}) == DEFAULT_PRESET
    assert selected_preset({PRESET_ENV: '   '}) == DEFAULT_PRESET
    assert enabled_tools(selected_preset({})) == ALL_TOOLS
    assert tool_enabled('prepare_zotero_import', {}) is True


def test_environment_selects_the_goal_surface():
    environ = {PRESET_ENV: ' read-and-cite '}
    assert selected_preset(environ) == 'read-and-cite'
    assert tool_enabled('read_document', environ) is True
    assert tool_enabled('search_local_text', environ) is False
    assert tool_enabled('zotero_item', environ) is False


def test_unknown_preset_fails_closed_with_an_actionable_message():
    with pytest.raises(PresetError) as failure:
        selected_preset({PRESET_ENV: 'everything-allowed'})
    message = str(failure.value)
    assert 'TOOL_PRESET_UNKNOWN' in message
    assert 'read-and-cite' in message and DEFAULT_PRESET in message
    with pytest.raises(PresetError):
        enabled_tools('not-a-preset')


def test_registration_is_limited_to_the_goal_and_keeps_titles(monkeypatch):
    monkeypatch.setenv(PRESET_ENV, 'read-and-cite')
    functions, titles, annotations = document_tools()
    recorder = Recorder()
    registered = register_tools(recorder, functions, titles, annotations)
    assert registered == sorted(['read_document', 'read_text_source', 'write_docx', 'write_markdown']), 'registration order is stable across releases'
    assert all(title for _, title, _ in recorder.registered)
    assert all(annotations is not None for _, _, annotations in recorder.registered), 'every tool states its annotations'
    assert 'search_local_text' not in registered


def test_a_goal_that_needs_no_research_server_registers_nothing_there(monkeypatch):
    monkeypatch.setenv(PRESET_ENV, 'read-and-cite')
    functions, titles, annotations = research_tools()
    recorder = Recorder()
    assert register_tools(recorder, functions, titles, annotations) == []
    assert recorder.registered == []


def test_every_shipped_tool_is_reachable_by_some_preset_and_has_a_title(monkeypatch):
    monkeypatch.setenv(PRESET_ENV, DEFAULT_PRESET)
    document_functions, document_titles, document_annotations = document_tools()
    research_functions, research_titles, research_annotations = research_tools()
    document = Recorder()
    research = Recorder()
    assert register_tools(document, document_functions, document_titles, document_annotations) == sorted(item.__name__ for item in document_functions)
    assert register_tools(research, research_functions, research_titles, research_annotations) == sorted(item.__name__ for item in research_functions)
    for recorder in (document, research):
        assert all(annotations is not None for _, _, annotations in recorder.registered), 'every shipped tool states its annotations'
        assert all(title for _, title, _ in recorder.registered)
    assert set(document_titles) == set(item.__name__ for item in document_functions)
    assert set(research_titles) == set(item.__name__ for item in research_functions)
    for title in [*document_titles.values(), *research_titles.values()]:
        assert 3 < len(title) <= 64


def test_the_corpus_goals_are_the_only_presets_that_enable_record_store_tools():
    for preset in ('read-and-cite', 'find-in-notes', 'verify-citations', 'zotero-handoff', 'research-core', 'research-lab', 'research-lab-max'):
        assert not (enabled_tools(preset) & LAB_TOOLS), f'{preset} must not start the corpus tools'
    assert enabled_tools('corpus-lab') == LAB_TOOLS | frozenset({'read_text_source'})
    workflow = enabled_tools('research-workflow')
    assert workflow & LAB_TOOLS == frozenset({'index_corpus', 'search_corpus', 'evidence_read', 'claims_read', 'claims_write'}), \
        'the Full workflow gets the journey verbs, not the destructive maintenance verbs'
    assert 'store_maintenance' not in workflow and 'unindex_corpus' not in workflow
    assert LAB_TOOLS <= ALL_TOOLS and not (LAB_TOOLS & (DOCUMENT_TOOLS | RESEARCH_TOOLS))


def test_the_registry_labels_match_the_tools_they_enable():
    """F17: a preset label may not promise a surface its tool list does not contain."""
    registry = {item['id']: item for item in REGISTRY['presets']}
    for preset_id, item in registry.items():
        tools = set(item['tools'])
        label = item['label'].lower()
        goal = item['goal'].lower()
        promises_index = 'index' in label or 'claim' in label
        if promises_index:
            assert tools & LAB_TOOLS, f"{preset_id}: the label promises the index/claims surface"
        if 'no corpus index' in goal:
            assert not (tools & LAB_TOOLS), f"{preset_id}: the goal says no index but the tools include it"
        assert item['goal'] and len(item['goal']) > 40, preset_id
        assert 1 <= len(item['tips']) <= 4, preset_id
        assert all(len(tip) > 25 for tip in item['tips']), preset_id
        assert len(item['label']) <= 60 and len(item['label']) > 8, preset_id
    defaults = {package: [item['id'] for item in REGISTRY['presets'] if package in item['defaultFor']] for package in ('basic', 'recommended', 'full')}
    assert all(len(ids) == 1 for ids in defaults.values()), defaults
    assert defaults['full'] == ['research-workflow']
    assert defaults['recommended'] == ['research-core']
    assert defaults['basic'] == ['read-and-cite']


def test_no_preset_ships_more_toolkit_tools_than_the_release_budget_allows():
    ceiling = REGISTRY['budget']['toolkitCeilingPerPreset']
    headroom = REGISTRY['budget']['minimumHeadroom']
    for preset in REGISTRY['presets']:
        assert len(preset['tools']) <= ceiling, f"{preset['id']}: {len(preset['tools'])} toolkit tools"
        total = len(preset['tools']) + sum(item['toolsEstimate'] for item in preset['thirdParty'])
        assert ceiling - len(preset['tools']) >= 0 and REGISTRY['budget']['clientCeiling'] - total >= headroom, preset['id']


def test_the_deprecated_search_alias_is_registered_only_for_unmanaged_configurations(monkeypatch):
    from research_stack import recommended_server as module

    assert 'search' not in RESEARCH_TOOLS and 'search' not in ALL_TOOLS
    assert 'search' not in REGISTRY['servers'][1]['tools'], 'the shipped registry advertises the real name only'
    monkeypatch.setenv(PRESET_ENV, DEFAULT_PRESET)
    recorder = Recorder()
    monkeypatch.setattr(module, 'server', recorder)
    module.main()
    assert 'search' in [name for name, _, _ in recorder.registered], 'hand-written MCP entries still call search'
    monkeypatch.setenv(PRESET_ENV, 'research-core')
    managed = Recorder()
    monkeypatch.setattr(module, 'server', managed)
    module.main()
    assert 'search' not in [name for name, _, _ in managed.registered], 'a managed goal-shaped preset gets no duplicate tool'
