"""Bundle reviewed worker source, locks and workspace overlay templates, never an environment or corpus."""
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OVERLAY_ROOT = ROOT / "templates" / "recommended-overlay"
OVERLAY_FILES = [
    ".github/skills/citation-check/SKILL.md",
    ".github/skills/evidence-extraction/SKILL.md",
    ".github/skills/literature-search/SKILL.md",
    ".github/skills/paper-review/SKILL.md",
    ".github/skills/research-summary/SKILL.md",
    ".research-toolkit/recommended-profile.json",
    "notebooks/analysis/.python-version",
    "notebooks/analysis/pyproject.toml",
    "notebooks/analysis/uv.lock",
    "notebooks/phase-2-metadata-proof.ipynb",
    "research/README.md",
]
OVERLAY_PATTERN = re.compile(
    r"^(\.github/skills/[a-z0-9-]+/SKILL\.md|\.research-toolkit/recommended-profile\.json"
    r"|notebooks/analysis/(pyproject\.toml|uv\.lock|\.python-version)|notebooks/[a-z0-9-]+\.ipynb|research/README\.md)$"
)


def build():
    target = ROOT / 'extension/worker'
    target.mkdir(exist_ok=True)
    version = re.search(r'__version__ = "([^"]+)"', (ROOT / 'src/research_stack/__init__.py').read_text(encoding='utf-8')).group(1)
    files = ['pyproject.toml', 'uv.lock', '.python-version', 'README.md'] + [
        str(p.relative_to(ROOT)).replace('\\', '/') for p in sorted((ROOT / 'src/research_stack').glob('*.py'))
    ]
    entries = {}
    for relative in files:
        content = (ROOT / relative).read_bytes()
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        entries[relative] = hashlib.sha256(content).hexdigest()
    overlay_entries = {}
    for relative in OVERLAY_FILES:
        if not OVERLAY_PATTERN.match(relative):
            raise ValueError(f"Overlay path is outside the reviewed pattern: {relative}")
        source = OVERLAY_ROOT / relative
        if not source.is_file():
            raise ValueError(f"Missing reviewed overlay template: {relative}")
        content = source.read_bytes()
        destination = target / 'overlay' / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
        overlay_entries[relative] = hashlib.sha256(content).hexdigest()
    manifest = {
        'schemaVersion': 2,
        'workerVersion': version,
        'extensionVersion': version,
        'files': entries,
        'overlayFiles': overlay_entries,
    }
    (target / 'bundle.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'Worker bundle built: {len(entries)} reviewed source/lock files and {len(overlay_entries)} overlay templates for worker {version}.')


if __name__ == '__main__':
    build()
