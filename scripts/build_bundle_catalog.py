"""Generate and verify `extension/bundles/catalog.json` from the staged skill-bundle trees.

DD9-16 makes the catalog a checked-in artifact that a machine can re-derive. This script is the
only producer of it. It measures the payload copy (`extension/bundles/<bundle-id>/**`), compares
it byte-for-byte with the reviewed staged tree (`templates/skill-bundles/**`), and refuses when a
file is missing on either side or a hash drifts. The authored half of the catalog — id, version,
topic, purpose, prerequisites, provenance, license status — lives here, in reviewable source; the
measured half — the per-file SHA-256 and byte count — is never typed by hand.

Run:
    python scripts/build_bundle_catalog.py            # regenerate (writes only if something changed)
    python scripts/build_bundle_catalog.py --check    # verify only; a stale catalog is a failure

The output is deterministic: sorted keys, sorted file paths, LF endings, no generation timestamp.
A catalog that changes when nothing in the bundle changed would make every release digest move.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
PAYLOAD_ROOT = ROOT / "extension" / "bundles"
CATALOG_PATH = PAYLOAD_ROOT / "catalog.json"

SCHEMA_VERSION = 1
GENERATED_BY = "scripts/build_bundle_catalog.py"
SKILL_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*$")
# The same shape `extension/runtime.js` enforces for the overlay: one skill directory, one level.
BUNDLE_PATH_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$")

LICENSE_UNRESOLVED = "unresolved — author consent required before publication"

# Authored bundle metadata. `files` is filled in by measurement below, never by hand.
BUNDLES: list[dict[str, object]] = [
    {
        "id": "theological-research",
        "version": "2.0",
        "topic": "theology",
        "purpose": (
            "Scholarly theological research: frame the question, search in the languages the field "
            "is published in, keep bibliographic records reviewable, label access status and "
            "confidence, and write a report whose limits are stated. Version 2.0 of the PoC written "
            "by sestra Denisa and Michael, packaged with the adaptations recorded in "
            "docs/implementation/phase-9-document-ingestion/bundle-notes.md."
        ),
        "skills": ["theological-research"],
        "stagedTree": "templates/skill-bundles/theology/theological-research",
        "payloadTree": "extension/bundles/theological-research",
        "prerequisites": [
            "Python 3.12 or newer available as `python3` — only for the two optional scripts; they import the Python standard library only and need no pip install, no uv and no toolkit venv.",
            "Network access to api.crossref.org and api.openalex.org — only when you run scripts/crossref_lookup.py yourself. The toolkit installer and the control panel never run it and make no network request.",
            "No licensed database (ATLA or similar) is provisioned, connected or entitlement-checked by the toolkit; any such access belongs to the user's institution.",
            "The toolkit provides a local lexical (BM25) index over text sources. It provides no vector or embedding search, no OCR and no scanned-image recognition.",
            "references/my-library.md installs as an empty template: the bundle ships with no record of the user's holdings.",
            "The host must read skills from .github/skills/<skill-id>/SKILL.md. The toolkit writes that path but cannot observe whether the host discovers it.",
        ],
        "provenance": {
            "sourceSnapshot": "Aplikovaná umělá inteligence pro sestry karmelitky/theological-research/ (author working directory, 2026-10-29)",
            "stagedTree": "templates/skill-bundles/theology/theological-research/",
            "payloadTree": "extension/bundles/theological-research/",
            "hashMethod": (
                "SHA-256 measured over the bytes of each file in the payload copy by "
                "scripts/build_bundle_catalog.py, then compared byte-for-byte with the staged tree; "
                "scripts/verify_vsix.py compares the same digests with the packaged VSIX members."
            ),
            "date": "2026-11-05",
            "adaptations": "docs/implementation/phase-9-document-ingestion/bundle-notes.md",
        },
        "owners": {"theological-research": "theological-research"},
        "sharedSkillRule": (
            "Every skill in `skills` has exactly one owner bundle in `owners`. Only the owner bundle "
            "writes that skill's files; another bundle that lists the same skill reports it as shared "
            "and writes nothing there. No bundle ever removes a skill, and no bundle removes a skill "
            "owned by another bundle."
        ),
        "license": "MIT",
        "publishable": True,
    },
    # DD9-23: the 0.3.8 workaround skill is brought under this catalog, rewritten for 0.3.9 direct
    # ingestion, so one workspace does not carry two competing instructions for the same job. It is
    # The toolkit-authored bundle is distributed under MIT.
    {
        "id": "document-corpus-bridge",
        "version": "2.0",
        "topic": "documents",
        "purpose": (
            "Index user-selected PDF and DOCX files into the corpus and cite them by the page or item of "
            "the original document, with coverage, warnings, freshness and the limits of the extraction "
            "kept visible. Replaces the 0.3.8 derived-Markdown workaround, which is kept only as an "
            "explicit fallback for files the indexer refuses."
        ),
        "skills": ["document-corpus-bridge"],
        "stagedTree": "templates/skill-bundles/toolkit/document-corpus-bridge",
        "payloadTree": "extension/bundles/document-corpus-bridge",
        "prerequisites": [
            "The Corpus index and record store component step has run in this workspace.",
            "A preset that carries the store verbs: Index, search and record claims carries all ten; Full research workflow carries index_corpus and search_corpus.",
            "The toolkit provides a local lexical (BM25) index over text sources. It provides no vector or embedding search, no OCR and no scanned-image recognition.",
            "The host must read skills from .github/skills/<skill-id>/SKILL.md. The toolkit writes that path but cannot observe whether the host discovers it.",
        ],
        "provenance": {
            "sourceSnapshot": "templates/recommended-overlay/.github/skills/document-corpus-bridge/SKILL.md (0.3.8-era workaround skill, added 2026-11-05, never packaged)",
            "stagedTree": "templates/skill-bundles/toolkit/document-corpus-bridge/",
            "payloadTree": "extension/bundles/document-corpus-bridge/",
            "hashMethod": (
                "SHA-256 measured over the bytes of each file in the payload copy by "
                "scripts/build_bundle_catalog.py, then compared byte-for-byte with the staged tree; "
                "scripts/verify_vsix.py compares the same digests with the packaged VSIX members."
            ),
            "date": "2026-11-06",
            "adaptations": "docs/implementation/phase-9-document-ingestion/bundle-notes.md",
        },
        "owners": {"document-corpus-bridge": "document-corpus-bridge"},
        "sharedSkillRule": (
            "Every skill in `skills` has exactly one owner bundle in `owners`. Only the owner bundle "
            "writes that skill's files; another bundle that lists the same skill reports it as shared "
            "and writes nothing there. No bundle ever removes a skill, and no bundle removes a skill "
            "owned by another bundle."
        ),
        "license": "MIT",
        "publishable": True,
    },
]


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def tree_files(root: Path) -> dict[str, bytes]:
    """Every file under `root`, keyed by its POSIX path relative to `root`."""
    if not root.is_dir():
        raise ValueError(f"bundle tree is missing: {root}")
    found: dict[str, bytes] = {}
    for path in sorted(root.rglob("*")):
        if path.is_dir():
            continue
        if path.is_symlink():
            raise ValueError(f"bundle trees must hold real files, not links: {path}")
        relative = PurePosixPath(path.relative_to(root)).as_posix()
        found[relative] = path.read_bytes()
    if not found:
        raise ValueError(f"bundle tree is empty: {root}")
    return found


def measure_bundle(bundle: dict[str, object]) -> list[dict[str, object]]:
    """Hash the payload copy and prove it is byte-identical to the reviewed staged tree."""
    bundle_id = str(bundle["id"])
    payload_root = ROOT / str(bundle["payloadTree"])
    staged_root = ROOT / str(bundle["stagedTree"])
    payload = tree_files(payload_root)
    staged = tree_files(staged_root)

    missing_in_payload = sorted(set(staged) - set(payload))
    extra_in_payload = sorted(set(payload) - set(staged))
    if missing_in_payload:
        raise ValueError(f"{bundle_id}: staged files absent from the payload copy: {missing_in_payload}")
    if extra_in_payload:
        raise ValueError(f"{bundle_id}: payload files that are not in the reviewed staged tree: {extra_in_payload}")

    drifted = sorted(name for name in staged if staged[name] != payload[name])
    if drifted:
        raise ValueError(f"{bundle_id}: payload copy differs from the reviewed staged tree: {drifted}")

    files: list[dict[str, object]] = []
    for relative in sorted(payload):
        data = payload[relative]
        if b"\r\n" in data:
            raise ValueError(f"{bundle_id}: CRLF line endings in {relative}; the packaged artifact must be LF-only")
        # Catalog paths are relative to the bundle root, so they carry the bundle id as their first part.
        catalog_path = f"{bundle_id}/{relative}"
        if not BUNDLE_PATH_PATTERN.match(catalog_path) or ".." in PurePosixPath(catalog_path).parts:
            raise ValueError(f"{bundle_id}: unsafe bundle file path: {catalog_path!r}")
        skill_id = skill_for(bundle, relative)
        if skill_id not in bundle["skills"]:
            raise ValueError(f"{bundle_id}: {catalog_path} is not under a skill this bundle declares")
        files.append({"path": catalog_path, "sha256": sha256_of(data), "bytes": len(data)})
    return files


def skill_for(bundle: dict[str, object], relative: str) -> str:
    """Which skill directory a bundle file lands in.

    A one-skill bundle installs its whole tree under that skill. A multi-skill bundle must group its
    files under a directory named after the skill, so the mapping from payload path to
    `.github/skills/<skill-id>/…` never has to be guessed. `extension/bundles.js` applies the same rule.
    """
    skills = list(bundle["skills"])
    parts = PurePosixPath(relative).parts
    if len(skills) == 1:
        return str(skills[0])
    if not parts or parts[0] not in skills:
        raise ValueError(f"{bundle['id']}: {relative} is not grouped under one of {skills}")
    return str(parts[0])


def build_catalog() -> dict[str, object]:
    bundles: list[dict[str, object]] = []
    for bundle in BUNDLES:
        entry = dict(bundle)
        entry["files"] = measure_bundle(entry)
        bundles.append(entry)
    bundles.sort(key=lambda item: str(item["id"]))

    owners: dict[str, str] = {}
    for bundle in bundles:
        for skill in bundle["skills"]:
            if not SKILL_ID_PATTERN.match(skill):
                raise ValueError(f"unsafe skill id {skill!r} in bundle {bundle['id']}")
        declared = bundle["owners"]
        if set(declared) != set(bundle["skills"]):
            raise ValueError(f"bundle {bundle['id']}: owners must declare exactly the skills it lists")
        for skill, owner in declared.items():
            if not SKILL_ID_PATTERN.match(owner):
                raise ValueError(f"bundle {bundle['id']}: owner bundle id {owner!r} is unsafe")
        owners.update(declared)
    for bundle in bundles:
        for skill, owner in bundle["owners"].items():
            if owner != bundle["id"] and not any(str(other["id"]) == owner for other in bundles):
                raise ValueError(f"bundle {bundle['id']}: skill {skill} is owned by unknown bundle {owner}")

    unresolved = [str(bundle["id"]) for bundle in bundles if str(bundle["license"]).startswith("unresolved")]
    for bundle in bundles:
        if bundle["publishable"] and str(bundle["license"]).startswith("unresolved"):
            raise ValueError(f"bundle {bundle['id']}: license is unresolved, so it cannot be marked publishable")

    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedBy": GENERATED_BY,
        "sharedSkillRule": "Only the owner bundle named in `owners` writes a skill's files; a non-owner reports it as shared and writes nothing. No bundle removes a skill, and never one owned by another bundle.",
        "bundles": bundles,
        "unresolvedLicenses": unresolved,
    }


def serialise(catalog: dict[str, object]) -> str:
    return json.dumps(catalog, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate or verify extension/bundles/catalog.json")
    parser.add_argument("--check", action="store_true", help="verify the catalog on disk without writing it")
    args = parser.parse_args()

    try:
        catalog = build_catalog()
    except ValueError as exc:
        print(f"bundle catalog failed: {exc}", file=sys.stderr)
        return 1

    payload = serialise(catalog)
    existing = CATALOG_PATH.read_text(encoding="utf-8") if CATALOG_PATH.exists() else None
    if args.check:
        if existing is None:
            print("bundle catalog failed: extension/bundles/catalog.json does not exist", file=sys.stderr)
            return 1
        if existing != payload:
            print("bundle catalog failed: extension/bundles/catalog.json is stale — run "
                  "python scripts/build_bundle_catalog.py", file=sys.stderr)
            return 1
    elif existing != payload:
        CATALOG_PATH.write_text(payload, encoding="utf-8", newline="\n")

    file_count = sum(len(bundle["files"]) for bundle in catalog["bundles"])
    byte_count = sum(int(item["bytes"]) for bundle in catalog["bundles"] for item in bundle["files"])
    written = "unchanged" if existing == payload else ("verified" if args.check else "written")
    print(f"bundles/catalog.json {written}: {len(catalog['bundles'])} bundle(s), {file_count} files, "
          f"{byte_count} bytes, {len(catalog['unresolvedLicenses'])} unresolved license(s), "
          f"publishable={all(bool(bundle['publishable']) for bundle in catalog['bundles'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
