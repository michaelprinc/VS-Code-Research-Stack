"""Verify actual MCP document reads, report checks and source preservation."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

from docx import Document
from pypdf import PdfWriter

CHECK = Path(__file__).resolve().parents[1] / 'extension/functional_check.py'


def invoke(*args, preset=None):
    environment = {**os.environ, 'RESEARCH_STACK_TOOL_PRESET': preset} if preset else None
    process = subprocess.run([sys.executable, '-I', '-B', str(CHECK), *map(str, args)],
        capture_output=True, text=True, encoding='utf-8', timeout=80, env=environment)
    return process.returncode, json.loads(process.stdout)


def test_real_mcp_fixture_reading_reports_search_and_research_adapter():
    code, result = invoke()
    assert code == 0
    for field in ['pdfRead', 'docxRead', 'sourceHashesAndLocators', 'markdownWrite', 'docxWrite', 'lexicalSearch', 'researchAdapter', 'corpusIndex', 'recordStore', 'toolAnnotations', 'toolCacheHints']:
        assert result[field] is True
    assert result['externalProvidersChecked'] is False
    surface = result['toolSurface']
    assert surface['basis'] == 'measured from real tools/list responses'
    assert surface['toolCount'] == 20
    assert {server['module'] for server in surface['servers']} == {'research_stack.mcp_server', 'research_stack.recommended_server', 'research_stack.lab_server'}
    assert sorted(result['tools']) == ['read_document', 'read_text_source', 'search_local_text', 'write_docx', 'write_markdown']
    assert sorted(result['labTools']) == ['claims_export', 'claims_read', 'claims_write', 'evidence_read', 'index_corpus',
                                          'search_corpus', 'store_maintenance', 'store_status', 'unindex_corpus']
    assert result['lab']['chunksIndexed'] >= 1 and result['lab']['claimId'] and result['lab']['backupCreated'] is True
    assert result['lab']['evidenceResolved'] is True and result['lab']['claimsExported'] is True
    assert result['lab']['evidenceRetainedAfterUnindex'] is True
    for server in surface['servers']:
        assert server['toolCount'] <= server['budget'], server['module']
    destructive = {tool['name'] for server in surface['servers'] for tool in server['tools'] if tool['destructiveHint'] is True}
    assert destructive == {'store_maintenance', 'unindex_corpus'}, "annotations must match what the verbs really do"
    measured = [tool for server in surface['servers'] for tool in server['tools']]
    assert all(tool['characters'] > 0 and tool['tokensEstimate'] > 0 and tool['title'] for tool in measured)
    assert surface['tokensEstimate'] == sum(tool['tokensEstimate'] for tool in measured)
    assert surface['characters'] == sum(tool['characters'] for tool in measured)


def test_check_discovers_the_full_surface_even_when_a_narrow_preset_is_selected():
    # The check must measure the whole surface whatever goal the operator selected.
    code, result = invoke(preset='read-and-cite')
    assert code == 0
    assert result['toolSurface']['toolCount'] == 20
    assert sorted(result['tools']) == ['read_document', 'read_text_source', 'search_local_text', 'write_docx', 'write_markdown']


def test_selected_docx_is_read_through_mcp_without_changing_source(tmp_path):
    source = tmp_path / 'Research é with spaces.docx'
    doc = Document()
    doc.add_paragraph('Výzkum a skutečné čtení vybraného dokumentu.')
    doc.save(source)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    code, result = invoke('--workspace', tmp_path, '--document', source.name)
    assert code == 0
    assert 'skutečné čtení' in result['preview']
    assert result['sha256'] == before == hashlib.sha256(source.read_bytes()).hexdigest()
    assert result['locators'][0]['item'] == 1


def test_scanned_pdf_does_not_become_false_ready(tmp_path):
    source = tmp_path / 'blank.pdf'
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    with source.open('wb') as target:
        writer.write(target)
    code, result = invoke('--workspace', tmp_path, '--document', source.name)
    assert code == 2
    assert result['ok'] is False
    assert 'OCR' in result['detail']


def test_document_outside_workspace_and_damaged_documents_fail_without_echoing_contents(tmp_path):
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    source = tmp_path / 'private.docx'
    source.write_bytes(b'private credential text, not a zip')
    code, result = invoke('--workspace', workspace, '--document', '../private.docx')
    assert code == 2 and result['ok'] is False
    inside = workspace / 'bad.docx'
    inside.write_bytes(source.read_bytes())
    code, result = invoke('--workspace', workspace, '--document', inside.name)
    assert code == 2 and result['ok'] is False
    assert 'private credential' not in json.dumps(result)
