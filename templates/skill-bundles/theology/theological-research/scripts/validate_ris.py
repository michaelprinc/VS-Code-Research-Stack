#!/usr/bin/env python3
"""Check the structure of a RIS file before Zotero is asked to import it.

Usage:
    python3 scripts/validate_ris.py file.ris
    python3 scripts/validate_ris.py file.ris --expect 12

Why this exists: an import measured on 14 November 2026 returned HTTP success and created 156 items,
61 of them empty. A status code is not an import result. The text is checked before it is offered to
Zotero, and the record count you wrote is compared with the library count afterwards.

The rules are the rules of `validate_ris_text()` in the Toolkit's `research_stack/research.py`, copied
on purpose rather than imported: this script runs standalone on any Python 3.12, standard library only,
no pip install, no uv, no toolkit venv, no network.

Read-only. The file is read and reported on. It is never rewritten, re-encoded or reordered.

Exit codes:
  0 = no defects (warnings are allowed, and are listed)
  1 = defects found — do not import this file
  2 = usage or input error (no such file, unreadable, not UTF-8 text)
"""

import argparse
import re
import sys

# A RIS line is `XX  - value`. The two spaces are part of the format. The space after the dash is
# optional because other tools omit it, and `ER  - ` legitimately carries no value.
RIS_TAG_PATTERN = re.compile(r"^([A-Z][A-Z0-9]) {2}- ?(.*)$")

# These two tags delimit a record, so either one appearing twice inside a record means the boundary
# between two records is wrong.
RIS_SINGLE_TAGS = ("TY", "ER")

# Tags that hold one value each. A second line with one of them is dropped or concatenated by the
# translator, so the second value is lost rather than added.
RIS_NON_REPEATABLE = ("PY", "DO", "AB", "TI", "JO", "J2", "LA", "SN", "UR", "CY", "PB", "VL", "IS", "SP", "T2")

# Tags Zotero's RIS translator reads. Anything else arrives as a note tagged `_RIS import` instead of
# as a field. `C1`-`C10` are Zotero's own reference fields and its own export writes them.
RIS_KNOWN_TAGS = frozenset({"TY", "AU", "A2", "A3", "A4", "AB", "AD", "AN", "AU", "CY", "DA", "DO", "DP", "ET", "ID", "IS", "JO", "J2", "KW", "LA", "M1", "M2", "N1", "N2", "PB", "PY", "SN", "SP", "ST", "T1", "T2", "TI", "TY", "UR", "VL", "ER", "C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10"})

# Type codes the translator maps. An unmapped code arrives as a journal article with an empty title.
RIS_TYPE_CODES = ("ART", "BOOK", "CHAP", "CONF", "CPAPER", "DATA", "GEN", "JOUR", "MAP", "MUSIC", "NEWS", "PAT", "PCOMP", "REF", "RPRT", "SLIDE", "STAT", "THES", "UNPD", "WEB")

# The tags that make a record recognisable as a work. A record carrying none of them is how an empty
# item arrives in the library — 61 of them on 14 November 2026.
RIS_AUTHOR_OR_TITLE_TAGS = ("AU", "A2", "T1", "TI", "ST")

# The identifiers one record can be matched against another. Without one, deduplication is a guess.
RIS_IDENTIFIER_TAGS = ("DO", "ID", "UR", "SN")

# Named out because `GEN` is the code that produced the wrong item types the operator repaired by hand.
GEN_ADVICE = ("TY GEN is mapped to journalArticle by the RIS translator in the build measured on "
              "14 November 2026. For a legal, conciliar or magisterial text use STAT; for a report "
              "RPRT; for a dissertation THES.")


def validate(text: str, expect: int | None) -> dict:
    """The rules of `validate_ris_text()`, kept in step with it: same problems, same warnings."""
    problems: list[tuple[int, str, str]] = []
    warnings: list[tuple[int, str, str]] = []
    records = 0
    current: dict = {"tags": [], "start": 0}
    for index, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.rstrip("\r")  # a CRLF file is still readable RIS; the line shape is what matters
        if not line.strip():
            continue
        match = RIS_TAG_PATTERN.match(line)
        if not match:
            problems.append((index, "malformed-line", f"Expected `XX  - value`, found {line[:40]!r}."))
            continue
        tag = match.group(1)[:2]
        value = match.group(2)
        if tag not in RIS_KNOWN_TAGS:
            problems.append((index, "unknown-tag", f"{tag} is not a tag Zotero's RIS translator reads; it becomes a note tagged `_RIS import`."))
        if tag in RIS_SINGLE_TAGS and tag in current["tags"]:
            problems.append((index, "duplicate-record-marker", f"{tag} appears twice in one record."))
        if tag in RIS_NON_REPEATABLE and tag in current["tags"]:
            problems.append((index, "repeated-field", f"{tag} is not repeatable; the second value would be dropped or concatenated."))
        current["tags"].append(tag)
        if tag == "TY":
            records += 1
            current["start"] = index
            code = value.strip()
            if code not in RIS_TYPE_CODES:
                problems.append((index, "unknown-record-type", f"TY {code!r} is not a type Zotero's RIS translator maps."))
            elif code == "GEN":
                warnings.append((index, "generic-record-type", GEN_ADVICE))
        if tag == "ER":
            if "TY" not in current["tags"]:
                problems.append((index, "record-without-type", "A record ended without a TY line."))
            if not any(t in RIS_AUTHOR_OR_TITLE_TAGS for t in current["tags"]):
                problems.append((current["start"], "record-without-author-or-title", "This record has neither an author nor a title, which is how an empty item arrives in the library."))
            if not any(t in RIS_IDENTIFIER_TAGS for t in current["tags"]):
                warnings.append((current["start"], "record-without-identifier", "No DOI, ID, URL or ISBN: this record cannot be deduplicated reliably."))
            current = {"tags": [], "start": 0}
    if current["tags"]:
        problems.append((current["start"] or 1, "record-without-end", "A record opened and never closed with ER."))
    if expect is not None and expect != records:
        problems.append((0, "record-count-mismatch", f"Expected {expect} records, found {records}."))
    return {"records": records, "lines": len(text.splitlines()), "problems": problems, "warnings": warnings}


def report(path: str, result: dict) -> None:
    print(f"file: {path}")
    print(f"records: {result['records']}   lines: {result['lines']}")
    problems, warnings = result["problems"], result["warnings"]
    print(f"problems: {len(problems)}" if not problems else f"problems ({len(problems)}):")
    for line, kind, detail in problems:
        print(f"  line {line}  {kind}: {detail}")
    print(f"warnings: {len(warnings)}" if not warnings else f"warnings ({len(warnings)}):")
    for line, kind, detail in warnings:
        print(f"  line {line}  {kind}: {detail}")
    if any(kind == "record-without-identifier" for _, kind, _ in warnings):
        # The advice lives here rather than in the warning text, so the warning text stays identical
        # to the Toolkit's own validator.
        print("  hint: mark those records status/needs-identifier (references/zotero-vocabulary.md) instead of guessing a match.")
    if problems:
        print(f"verdict: {path} has {len(problems)} defect(s). Fix them before Zotero sees the file.")
    else:
        print(f"verdict: {path} is structurally clean — {result['records']} record(s), "
              f"{len(warnings)} warning(s). After the import, compare this record count with the library count.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check a RIS file's structure before it is imported into Zotero.")
    parser.add_argument("path", help="the RIS file to check. It is read only; nothing is written.")
    parser.add_argument("--expect", type=int, default=None, metavar="N",
                        help="report a defect when the file does not hold exactly N records")
    args = parser.parse_args()

    try:
        with open(args.path, encoding="utf-8") as handle:
            text = handle.read()
    except UnicodeDecodeError as exc:
        print(f"validate_ris: {args.path} is not UTF-8 text: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"validate_ris: {args.path}: {exc}", file=sys.stderr)
        return 2

    result = validate(text, args.expect)
    report(args.path, result)
    return 1 if result["problems"] else 0


if __name__ == "__main__":
    sys.exit(main())
