"""Bounded, read-only diagnostic invoked only by an explicit trusted-workspace check.

No uv sync, installation, server launch, research document read or network request.
Only library imports and in-memory PDF/DOCX round trips are tested.
"""
import importlib.metadata
import importlib.util
import io
import json
import platform
from pathlib import Path

results = {}


def check(component, distribution, operation, detail):
    try:
        version = importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        version = None
    try:
        operation()
        results[component] = {"version": version, "ok": bool(version), "detail": detail}
    except Exception:
        results[component] = {"version": version, "ok": False, "detail": "Distribution missing or library smoke test failed. Review environment setup; no documents were read."}


def sdk():
    from mcp.server import MCPServer
    assert callable(MCPServer)


def pdf():
    from pypdf import PdfReader, PdfWriter
    stream = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(stream)
    stream.seek(0)
    assert len(PdfReader(stream).pages) == 1


def docx():
    from docx import Document
    stream = io.BytesIO()
    document = Document()
    document.add_paragraph("Research Toolkit diagnostic")
    document.save(stream)
    stream.seek(0)
    assert Document(stream).paragraphs[0].text == "Research Toolkit diagnostic"


check("mcp-python-sdk", "mcp", sdk, "MCPServer import passed; server reachability and client authorization are not tested.")
check("mcp-types", "mcp-types", lambda: __import__("mcp_types", fromlist=["ToolAnnotations"]), "Tool annotation types import passed; no server was started.")
check("pypdf", "pypdf", pdf, "In-memory PDF write/read passed; no research documents read. OCR remains separate.")
check("python-docx", "python-docx", docx, "In-memory DOCX write/read passed; no output files created.")
spec = importlib.util.find_spec("research_stack")
check("document-worker", "research-stack-basic", lambda: bool(spec) or (_ for _ in ()).throw(ValueError()), "Package/module presence only; MCP invocation not tested.")
module_root = Path(spec.origin).parent if spec and spec.origin else None
print(json.dumps({"python": platform.python_version(), "packages": results, "recommended": bool(module_root and (module_root / "recommended_server.py").is_file()), "full": bool(module_root and (module_root / "full.py").is_file()), "lab": bool(module_root and (module_root / "lab_server.py").is_file() and (module_root / "records.py").is_file())}))
