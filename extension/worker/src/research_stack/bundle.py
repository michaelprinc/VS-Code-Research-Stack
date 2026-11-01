"""Create an explicit, user-mediated NotebookLM handoff folder."""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

from .documents import DocumentError, sha256_file

SUPPORTED = {".pdf", ".docx", ".txt", ".md"}
MAX_FILE_BYTES = 50 * 1024 * 1024


def export_bundle(output: Path, sources: list[Path]) -> dict[str, object]:
    output = output.expanduser().resolve()
    if output.exists():
        raise DocumentError("OUTPUT_EXISTS: choose a new bundle directory; existing files are not overwritten.")
    if not sources:
        raise DocumentError("NO_SOURCES: select one or more PDF, DOCX, TXT or Markdown files.")
    output.parent.mkdir(parents=True, exist_ok=True)
    rows: list[tuple[str, str]] = []
    with tempfile.TemporaryDirectory(prefix=f".{output.name}-", dir=output.parent) as temp:
        staging = Path(temp)
        for index, supplied in enumerate(sources, start=1):
            source = supplied.expanduser().resolve(strict=True)
            if not source.is_file() or source.suffix.lower() not in SUPPORTED:
                raise DocumentError(f"UNSUPPORTED_SOURCE: {source.name}; choose PDF, DOCX, TXT or Markdown.")
            if source.stat().st_size > MAX_FILE_BYTES:
                raise DocumentError(f"INPUT_TOO_LARGE: {source.name} exceeds the 50 MiB per-file limit.")
            safe_name = source.name.replace("/", "_").replace("\\", "_")
            destination_name = f"{index:02d}-{safe_name}"
            before_hash = sha256_file(source)
            shutil.copyfile(source, staging / destination_name)
            copied_hash = sha256_file(staging / destination_name)
            after_hash = sha256_file(source)
            if before_hash != copied_hash or copied_hash != after_hash:
                raise DocumentError(f"SOURCE_CHANGED_DURING_EXPORT: {source.name}; rerun with a stable source file.")
            rows.append((destination_name, copied_hash))
        index_text = "# NotebookLM handoff source index\n\n" + "\n".join(
            f"- `{name}` — SHA-256 `{digest}`" for name, digest in rows
        ) + "\n\nImport the selected files manually in NotebookLM. Review account, policy, rights, and data-sharing requirements before upload. This folder creation does not contact Google or upload anything.\n"
        (staging / "source-index.md").write_text(index_text, encoding="utf-8", newline="\n")
        staging.rename(output)
    return {"path": str(output), "sourceCount": len(rows), "sources": [{"name": name, "sha256": digest} for name, digest in rows]}
