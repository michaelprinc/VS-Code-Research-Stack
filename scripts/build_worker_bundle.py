"""Bundle reviewed worker source, locks and workspace overlay templates, never an environment or corpus.

The bundle is only written when every shipped `pyproject.toml` / `uv.lock` pair is lock-current. 0.3.6
shipped a worker lock that still recorded the 0.3.4 project version, and `uv sync --locked` refused it on
every real host; nothing in this build compared the two files. See specs/phase-7-lock-integrity/.
"""
import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lockintegrity

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


def assert_overlay_tree_is_reviewed(overlay_root: Path = OVERLAY_ROOT, allowed: list[str] = OVERLAY_FILES) -> None:
    """Refuse to build when the overlay tree holds a template the allowlist does not name.

    On 5 November 2026 a sixth overlay skill (`document-corpus-bridge`) was authored into this tree,
    reviewed, and silently skipped: the allowlist is a list, the audit only checks what it expects, and
    nothing compared the two. A reviewed file that never ships is worse than a missing one, because the
    tree says it exists.
    """
    present = {
        PurePosixPath(path.relative_to(overlay_root)).as_posix()
        for path in overlay_root.rglob('*') if path.is_file()
    }
    unnamed = sorted(present - set(allowed))
    if unnamed:
        raise ValueError(
            "overlay templates are not in the allowlist — package them by naming them in OVERLAY_FILES, "
            f"or move them out of the overlay tree: {unnamed}"
        )


def assert_locks_current(pairs: list[tuple[str, str]], root: Path = ROOT) -> None:
    """Refuse to bundle a pair that `uv sync --locked` would refuse on a real host."""
    problems: list[str] = []
    for pyproject_relative, lock_relative in pairs:
        problems.extend(lockintegrity.check_pair(root / pyproject_relative, root / lock_relative))
    if problems:
        raise ValueError(
            'lockfile drift — this build would ship a uv.lock that uv refuses: '
            + '; '.join(problems)
        )


SOURCE_PAIRS = [
    ('pyproject.toml', 'uv.lock'),
    ('templates/recommended-overlay/notebooks/analysis/pyproject.toml',
     'templates/recommended-overlay/notebooks/analysis/uv.lock'),
]
BUILT_PAIRS = [('extension/worker/pyproject.toml', 'extension/worker/uv.lock')]


def build():
    assert_locks_current(SOURCE_PAIRS)
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
    assert_overlay_tree_is_reviewed(OVERLAY_ROOT, OVERLAY_FILES)
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
    # The pair that was just copied is the pair a host will run `uv sync --locked` against, and the
    # manifest hashes it. Check the pair before the manifest exists, so a refused build cannot leave
    # behind a worker tree and a `bundle.json` that agree with each other and disagree with uv —
    # the state the VSIX audit is the only thing able to notice.
    assert_locks_current(BUILT_PAIRS)
    built_version = re.search(r'^version = "([^"]+)"', (target / 'pyproject.toml').read_text(encoding='utf-8'), re.M).group(1)
    if built_version != version:
        raise ValueError(f'worker bundle version mismatch: bundle {version} vs bundled pyproject {built_version}')
    (target / 'bundle.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(f'Worker bundle built: {len(entries)} reviewed source/lock files and {len(overlay_entries)} overlay templates for worker {version}.')


if __name__ == '__main__':
    build()
