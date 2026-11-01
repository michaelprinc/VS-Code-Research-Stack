"""Real local stdio MCP checks; fixtures are temporary, selected sources read-only."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import sys
import tempfile
from pathlib import Path

from docx import Document
from mcp import Client
from mcp.client.stdio import StdioServerParameters
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

# Tool definitions are re-sent with every request, so their size is measured here
# and stored in the setup receipt for the control panel's context estimate.
TOKENS_PER_CHAR = 4
TOOL_SCHEMA_OVERHEAD_TOKENS = 40

# C-13: the enabled tool surface is budgeted per server and recorded from real discovery.
SERVER_BUDGETS = {
    'research_stack.mcp_server': 5,
    'research_stack.recommended_server': 6,
    'research_stack.lab_server': 9,
}
EXPECTED_TOOLS = {
    'research_stack.mcp_server': {'read_document', 'read_text_source', 'search_local_text', 'write_docx', 'write_markdown'},
    'research_stack.recommended_server': {'check_citation', 'prepare_zotero_import', 'search_literature', 'zotero_collections', 'zotero_item', 'search'},
    'research_stack.lab_server': {'claims_export', 'claims_read', 'claims_write', 'evidence_read', 'index_corpus',
                                  'search_corpus', 'store_maintenance', 'store_status', 'unindex_corpus'},
}


def parameters(root, module, preset='all'):
    # The check always discovers the complete surface, whatever preset the operator selected.
    return StdioServerParameters(command=sys.executable, args=['-I', '-B', '-m', module],
        env={**os.environ, 'RESEARCH_STACK_WORKSPACE': str(root), 'RESEARCH_STACK_TOOL_PRESET': preset}, cwd=str(root))


def tool_surface(module, tools):
    """Measure the discovered tool definitions: name, title, description, annotations and input schema."""
    measured = []
    for tool in tools:
        # The SDK model exposes the schema as input_schema (camelCase is the wire alias); accept either shape.
        schema = getattr(tool, 'input_schema', None) or getattr(tool, 'inputSchema', None) or {}
        annotations = getattr(tool, 'annotations', None)
        characters = len(tool.name) + len(tool.title or '') + len(tool.description or '') + len(json.dumps(schema, ensure_ascii=True))
        measured.append({'name': tool.name, 'title': tool.title or tool.name, 'characters': characters,
                         'annotated': annotations is not None,
                         'readOnlyHint': getattr(annotations, 'read_only_hint', None) if annotations is not None else None,
                         'destructiveHint': getattr(annotations, 'destructive_hint', None) if annotations is not None else None,
                         'tokensEstimate': math.ceil(characters / TOKENS_PER_CHAR) + TOOL_SCHEMA_OVERHEAD_TOKENS})
    measured.sort(key=lambda item: item['name'])
    return {'module': module, 'toolCount': len(measured),
            'characters': sum(item['characters'] for item in measured),
            'tokensEstimate': sum(item['tokensEstimate'] for item in measured),
            'budget': SERVER_BUDGETS[module], 'annotatedCount': sum(1 for item in measured if item['annotated']),
            'tools': measured}


def result_value(result):
    if result.is_error or not isinstance(result.structured_content, dict):
        raise ValueError('MCP tool returned an error or invalid result.')
    return result.structured_content


def make_pdf(path):
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=100)
    font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): font})})
    stream = DecodedStreamObject()
    stream.set_data(b'BT /F1 12 Tf 10 40 Td (Research Toolkit PDF reading check) Tj ET')
    page[NameObject('/Contents')] = writer._add_object(stream)
    with path.open('xb') as target:
        writer.write(target)


async def lab_checks(client):
    """Exercise the Full-package corpus index and record store through real MCP calls."""
    indexed = result_value(await client.call_tool('index_corpus', {'paths': ['notes.md'], 'mode': 'index'}))
    if not indexed.get('chunksStored') or not indexed.get('indexFingerprint'):
        raise ValueError('Corpus indexing validation failed.')
    hits = result_value(await client.call_tool('search_corpus', {'query': 'provenance evidence', 'limit': 5}))
    if not hits.get('hits') or 'source_path' not in hits['hits'][0]:
        raise ValueError('Stored corpus search validation failed.')
    chunk_id = hits['hits'][0]['chunk_id']
    written = result_value(await client.call_tool('claims_write', {'statement': 'Synthetic claim for the reading check.', 'evidence_chunk_ids': [chunk_id]}))
    claim_id = written.get('claim', {}).get('claim_id')
    if not claim_id or written.get('created') is not True:
        raise ValueError('Claim write validation failed.')
    read = result_value(await client.call_tool('claims_read', {'claim_id': claim_id}))
    if read.get('claimCount') != 1 or read['claims'][0]['evidence'][0]['chunk_id'] != chunk_id:
        raise ValueError('Claim read/evidence-link validation failed.')
    evidence = result_value(await client.call_tool('evidence_read', {'chunk_ids': [chunk_id]}))
    if not evidence.get('evidence') or evidence['evidence'][0]['sourcePath'] != 'notes.md' or evidence['evidence'][0]['resolvable'] is not True:
        raise ValueError('Evidence resolution validation failed.')
    exported = result_value(await client.call_tool('claims_export', {'claim_ids': [claim_id]}))
    if not exported.get('references') or exported['references'][0]['reference'] != 'notes.md' or len(exported['references'][0]['sha256']) != 64:
        raise ValueError('Claim export validation failed.')
    status = result_value(await client.call_tool('store_status', {}))
    if status.get('action') != 'status' or not status.get('store') or status.get('schemaVersion') != 2:
        raise ValueError('Store status validation failed.')
    unconfirmed = result_value(await client.call_tool('store_maintenance', {'action': 'vacuum'}))
    if unconfirmed.get('resultState') != 'error' or 'CONFIRM_REQUIRED' not in json.dumps(unconfirmed):
        raise ValueError('Store maintenance confirmation rule not enforced.')
    backed_up = result_value(await client.call_tool('store_maintenance', {'action': 'backup'}))
    if backed_up.get('action') != 'backup' or not backed_up.get('backup') or backed_up.get('integrityCheck') != 'ok':
        raise ValueError('Store backup validation failed.')
    staged = result_value(await client.call_tool('store_maintenance', {'action': 'restore', 'backup_path': backed_up['backup']}))
    if staged.get('activated') is not False or not staged.get('candidate'):
        raise ValueError('Restore must stage a validated candidate before any activation.')
    removed = result_value(await client.call_tool('unindex_corpus', {'paths': ['notes.md']}))
    if removed.get('removedSources') != ['notes.md'] or not removed.get('retainedEvidenceChunks'):
        raise ValueError('Un-indexing must retain the evidence a stored claim still cites.')
    after_removal = result_value(await client.call_tool('claims_read', {'claim_id': claim_id}))
    link = after_removal['claims'][0]['evidence'][0]
    if link['resolvable'] is not True or link['stale'] is not True:
        raise ValueError('Stored claim evidence became unresolvable after re-indexing.')
    return {'chunksIndexed': indexed['chunksStored'], 'claimId': claim_id, 'indexFingerprint': indexed['indexFingerprint'],
            'backupCreated': True, 'evidenceResolved': True, 'claimsExported': True, 'evidenceRetainedAfterUnindex': True}


async def smoke():
    with tempfile.TemporaryDirectory(prefix='research-toolkit-reading-') as temporary:
        root = Path(temporary)
        source = root / 'fixture with spaces.docx'
        document = Document()
        document.add_paragraph('Research Toolkit DOCX reading check: Výzkum a evidence.')
        document.save(source)
        pdf = root / 'fixture.pdf'
        make_pdf(pdf)
        (root / 'notes.md').write_text('Research toolkit evidence and provenance across selected notes.', encoding='utf-8')
        hashes = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (source, pdf)}
        servers = []
        async with Client(parameters(root, 'research_stack.mcp_server'), read_timeout_seconds=20) as client:
            discovered = (await client.list_tools()).tools
            tools = sorted(t.name for t in discovered)
            document_surface = tool_surface('research_stack.mcp_server', discovered)
            if not EXPECTED_TOOLS['research_stack.mcp_server'] <= set(tools):
                raise ValueError('Required worker tools were not discovered.')
            if any(not tool.title for tool in discovered):
                raise ValueError('A toolkit tool has no title.')
            if any(getattr(tool, 'annotations', None) is None for tool in discovered):
                raise ValueError('A toolkit tool has no behaviour annotations.')
            if (await client.list_tools()).ttl_ms is None:
                raise ValueError('tools/list carries no cache hint.')
            for p, marker, locator in [(source, 'Výzkum a evidence', 'item'), (pdf, 'PDF reading check', 'page')]:
                data = result_value(await client.call_tool('read_document', {'path': p.name, 'count': 5}))
                if marker not in data['text'] or data['sha256'] != hashes[p.name] or data['locators'][0][locator] != 1:
                    raise ValueError('Reading text, source hash or locator validation failed.')
            citations = [{'label': 'Synthetic source', 'reference': 'fixture paragraph 1', 'sha256': hashes[source.name]}]
            for name, filename in [('write_markdown', 'report.md'), ('write_docx', 'report.docx')]:
                result_value(await client.call_tool(name, {'title': 'Reading check', 'body': 'Synthetic evidence.', 'output_path': 'outputs/' + filename, 'sources': citations}))
            if 'Synthetic source' not in (root / 'outputs/report.md').read_text(encoding='utf-8'):
                raise ValueError('Markdown report validation failed.')
            if 'Synthetic source' not in '\n'.join(p.text for p in Document(root / 'outputs/report.docx').paragraphs):
                raise ValueError('DOCX report validation failed.')
            hits = result_value(await client.call_tool('search_local_text', {'paths': ['notes.md'], 'query': 'provenance'}))
            if not hits.get('hits'):
                raise ValueError('Local lexical search validation failed.')
            if 'read_text_source' not in json.dumps(hits.get('reopenWith', '')):
                raise ValueError('Local search results do not say how to reopen the passage.')
            reopened = result_value(await client.call_tool('read_text_source', {'path': 'notes.md', 'locator': hits['hits'][0]['locator']}))
            if 'provenance' not in reopened['text'] or reopened['sha256'] != hashlib.sha256((root / 'notes.md').read_bytes()).hexdigest():
                raise ValueError('Reopening a local text hit through read_text_source failed.')
            servers.append(document_surface)
        async with Client(parameters(root, 'research_stack.recommended_server'), read_timeout_seconds=20) as client:
            discovered = (await client.list_tools()).tools
            research_tools = sorted(t.name for t in discovered)
            research_surface = tool_surface('research_stack.recommended_server', discovered)
            if not EXPECTED_TOOLS['research_stack.recommended_server'] <= set(research_tools):
                raise ValueError('Research adapter tools were not discovered.')
            if 'search' not in research_tools:
                raise ValueError('The deprecated search alias is not registered for unmanaged configurations.')
            result_value(await client.call_tool('prepare_zotero_import', {'records': [{'title': 'Synthetic reference', 'authors': ['Toolkit'], 'year': 2026}], 'file_name': 'fixture.ris'}))
            if 'Synthetic reference' not in (root / 'research/imports/fixture.ris').read_text(encoding='utf-8'):
                raise ValueError('Local RIS preparation validation failed.')
            servers.append(research_surface)
        async with Client(parameters(root, 'research_stack.lab_server'), read_timeout_seconds=25) as client:
            discovered = (await client.list_tools()).tools
            lab_tools = sorted(t.name for t in discovered)
            lab_surface = tool_surface('research_stack.lab_server', discovered)
            if not EXPECTED_TOOLS['research_stack.lab_server'] <= set(lab_tools):
                raise ValueError('Corpus and record tools were not discovered.')
            lab = await lab_checks(client)
            servers.append(lab_surface)
        if any(hashlib.sha256((root / name).read_bytes()).hexdigest() != digest for name, digest in hashes.items()):
            raise ValueError('Source preservation validation failed.')
        for surface in servers:
            if surface['toolCount'] > surface['budget']:
                raise ValueError(f"Tool budget exceeded for {surface['module']}: {surface['toolCount']} > {surface['budget']}.")
        surface = {'basis': 'measured from real tools/list responses', 'servers': servers,
            'toolCount': sum(item['toolCount'] for item in servers),
            'characters': sum(item['characters'] for item in servers),
            'tokensEstimate': sum(item['tokensEstimate'] for item in servers)}
        return {'ok': True, 'pdfRead': True, 'docxRead': True, 'sourceHashesAndLocators': True,
            'markdownWrite': True, 'docxWrite': True, 'lexicalSearch': True, 'researchAdapter': True,
            'corpusIndex': True, 'recordStore': True, 'toolAnnotations': True, 'toolCacheHints': True,
            'lab': lab, 'tools': tools, 'researchTools': research_tools, 'labTools': lab_tools,
            'toolSurface': surface, 'externalProvidersChecked': False}


async def read(root, relative):
    from research_stack.paths import resolve_under
    source = resolve_under(root, relative, must_exist=True)
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    async with Client(parameters(root, 'research_stack.mcp_server'), read_timeout_seconds=20) as client:
        data = result_value(await client.call_tool('read_document', {'path': relative, 'count': 5}))
    if before != data['sha256'] or before != hashlib.sha256(source.read_bytes()).hexdigest():
        raise ValueError('Source preservation/hash validation failed.')
    text = data['text']
    return {'ok': bool(text.strip()), 'document': relative, 'kind': data['kind'], 'sha256': before,
        'locators': data['locators'], 'warnings': data['warnings'], 'characters': len(text), 'preview': text[:4000],
        'detail': 'First five pages/paragraphs read through MCP; source unchanged.' if text.strip() else 'No text extracted. Scanned PDFs need OCR; see the PDF guide.'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--workspace', type=Path)
    parser.add_argument('--document')
    args = parser.parse_args()
    try:
        operation = read(args.workspace.resolve(strict=True), args.document) if args.document and args.workspace else smoke()
        result = asyncio.run(asyncio.wait_for(operation, timeout=75))
    except Exception as error:
        # Server/package stderr and exception payloads can contain document text; never echo them.
        result = {'ok': False, 'detail': f'Functional check failed ({type(error).__name__}). Review worker setup and the selected document; encrypted, damaged or scanned files may need preparation.'}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if result['ok'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
