#!/usr/bin/env python3
"""Deduplicate a list of bibliographic records and flag suspicious near-duplicates.

Usage:
    python3 scripts/dedupe_records.py records.json
    python3 scripts/dedupe_records.py /home/you/research/records.json

Working directory: the default input path `records.json` is resolved against the CURRENT
WORKING DIRECTORY, not against the directory this script lives in. Pass an explicit path
when you are not standing in the folder that holds the file. Nothing is written to disk:
the deduplicated array goes to stdout, so redirect it if you want a file.

What this script is, and what it is not:
  - it contacts no service and verifies nothing against a catalogue;
  - it compares two fields only: `title` and `doi` (see the report it prints);
  - a record it drops is not proof of a duplicate. Every dropped record is counted in the summary and
    reported on stderr with its reason, and the summary states the input count against the output
    count so a loss is visible. Treat the output as a reviewable draft, not a clean list.

Output: a deduplicated JSON array on stdout, and a report on stderr listing dropped records with
their reason, near-identical titles, and records with no identifier at all.

How much of that report appears on stderr (added in 0.3.15, T16-12): the per-record detail is capped at
MAX_DETAIL_LINES (40) lines, so a run over a large export stays readable and an agent's context is not
filled with two thousand lines. The cap covers ONLY the per-record detail lines. The summary counts, the
JSON array on stdout and the exit code are identical with or without it — a capped report is a shorter
report, never a partial result. When lines are hidden, stderr says how many and how to see them:
    python3 scripts/dedupe_records.py records.json --verbose
or, where a flag cannot be passed, the environment variable the script reads:
    RST_DEDUPE_VERBOSE=1 python3 scripts/dedupe_records.py records.json

Exit codes:
  0 = nothing was dropped and nothing needs review
  1 = review needed (a record was dropped, or a near-duplicate or no-identifier record was flagged)
  2 = bad input (missing file, invalid JSON, or JSON that is not an array)
"""

import argparse
import json
import os
import re
import sys
import unicodedata
from difflib import SequenceMatcher

NEAR_DUPLICATE_RATIO = 0.92   # high on purpose: below this, translated titles legitimately differ

# How many per-record detail lines the stderr report prints before it says "and N more" (T16-12).
# It bounds ONLY the detail lines: the summary counts, the JSON on stdout and the exit code are the
# same whether the detail is capped or printed in full, so the cap can never hide a result.
MAX_DETAIL_LINES = 40
# The environment variable that asks for the full detail when a flag cannot be passed — for example
# when the script is run by an agent that supplies only the command and the environment.
VERBOSE_ENVIRONMENT_VARIABLE = "RST_DEDUPE_VERBOSE"
TRUE_VALUES = {"1", "true", "yes", "on"}

# A DOI written as a bare handle and as a resolver URL names the same work. Comparing the raw
# strings made the same record look like two works.
DOI_PREFIXES = ("https://doi.org/", "http://doi.org/", "info:doi/", "doi:")


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = re.sub(r"[^a-z0-9 ]", " ", text.lower())
    return " ".join(text.split())


def normalize_doi(value) -> str:
    """Bare-DOI form: drop the resolver prefix so `10.x/y` and `https://doi.org/10.x/y` match."""
    doi = str(value or "").strip().lower()
    for prefix in DOI_PREFIXES:
        if doi.startswith(prefix):
            doi = doi[len(prefix):]
            break
    return doi.strip(" /")


def load(path: str) -> list:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        print(f"ERROR: {path} not found. Save the collected records as a JSON array first, "
              f"or pass the path of the file you meant (relative paths resolve against the current "
              f"working directory, which is {os.getcwd()}).")
        sys.exit(2)
    except json.JSONDecodeError as exc:
        print(f"ERROR: {path} is not valid JSON: {exc}")
        sys.exit(2)
    if not isinstance(data, list):
        print("ERROR: expected a JSON array of records.")
        sys.exit(2)
    return data


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Deduplicate bibliographic records and flag suspicious near-duplicates.",
        epilog="Only title and doi are compared. Every dropped record is reported on stderr; the per-record "
               f"detail is capped at {MAX_DETAIL_LINES} lines unless you pass --verbose or set "
               f"{VERBOSE_ENVIRONMENT_VARIABLE}=1. The summary counts, the JSON on stdout and the exit code "
               "do not change with the cap.",
    )
    parser.add_argument(
        "path", nargs="?", default="records.json",
        help="JSON array of records. Relative paths resolve against the current working "
             "directory. Default: ./records.json",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help=f"print every dropped and every flagged record on stderr instead of the first "
             f"{MAX_DETAIL_LINES} detail lines. Equivalent to {VERBOSE_ENVIRONMENT_VARIABLE}=1. "
             "Summary counts, JSON output and exit codes are identical either way.",
    )
    args = parser.parse_args()
    verbose = args.verbose or str(os.environ.get(VERBOSE_ENVIRONMENT_VARIABLE, "")).strip().lower() in TRUE_VALUES

    records = load(args.path)
    problems = []
    dropped = []
    seen_doi = {}
    kept = []

    for index, record in enumerate(records):
        if not isinstance(record, dict):
            dropped.append(f"record {index}: dropped - not an object (a JSON array of objects is expected)")
            continue
        title = normalize(record.get("title", ""))
        doi = normalize_doi(record.get("doi", ""))

        if not title:
            dropped.append(f"record {index}: dropped - no title to compare; re-add it from the source and mark it unverified")
            continue

        if doi:
            if doi in seen_doi:
                dropped.append(
                    f"record {index}: dropped - DOI {doi} is already carried by kept record {seen_doi[doi]} "
                    f"('{record.get('title')}')"
                )
                continue
            seen_doi[doi] = len(kept)

        duplicate_of = None
        for other_index, other in enumerate(kept):
            ratio = SequenceMatcher(None, title, normalize(other.get("title", ""))).ratio()
            if ratio >= NEAR_DUPLICATE_RATIO:
                duplicate_of = (other_index, ratio)
                break

        if duplicate_of:
            other_index, ratio = duplicate_of
            other = kept[other_index]
            same_year = record.get("year") == other.get("year")
            note = "" if same_year else " [different years - possible edition, reprint or translation]"
            if same_year:
                # Drop only when the years agree; a different year may be a genuine edition and is kept for review.
                dropped.append(
                    f"record {index}: dropped - near-duplicate ({ratio:.2f}) of kept '{other.get('title')}'"
                    f" ('{record.get('title')}'){note}"
                )
                continue
            problems.append(
                f"near-duplicate ({ratio:.2f}): '{record.get('title')}' vs kept '{other.get('title')}'"
                f"{note} - kept for review, decide which work this is"
            )

        if not doi:
            problems.append(f"no identifier: '{record.get('title')}' - verify via catalogue, then mark verified or unverified")

        kept.append(record)

    json.dump(kept, sys.stdout, ensure_ascii=False, indent=2)
    print()

    if len(kept) + len(dropped) != len(records):
        print(f"ERROR: kept ({len(kept)}) + dropped ({len(dropped)}) does not equal the input count "
              f"({len(records)}). Treat this output as unreliable.", file=sys.stderr)
        return 1

    print(f"records in: {len(records)}  kept: {len(kept)}  dropped: {len(dropped)}  flagged for review: {len(problems)}", file=sys.stderr)
    # The cap is on the detail lines only. Which records were dropped and which were flagged is already
    # stated by the counts above, so a capped report is a shorter report and never a partial one.
    budget = len(dropped) + len(problems) if verbose else MAX_DETAIL_LINES
    dropped_shown = min(len(dropped), budget)
    problems_shown = min(len(problems), budget - dropped_shown)
    for entry in dropped[:dropped_shown]:
        print(f"  DROPPED {entry}", file=sys.stderr)
    for problem in problems[:problems_shown]:
        print(f"  - {problem}", file=sys.stderr)
    hidden_dropped = len(dropped) - dropped_shown
    hidden_problems = len(problems) - problems_shown
    if hidden_dropped or hidden_problems:
        print(f"  … {hidden_dropped + hidden_problems} detail line(s) of {len(dropped) + len(problems)} not printed "
              f"({hidden_dropped} dropped record(s), {hidden_problems} record(s) flagged for review). "
              f"The full report on demand: pass --verbose or set {VERBOSE_ENVIRONMENT_VARIABLE}=1. "
              f"The summary counts above, the JSON on stdout and the exit code already account for every "
              f"one of them.", file=sys.stderr)
    print("Fields compared: title (diacritics and punctuation removed) and doi (bare-DOI form; "
          "https://doi.org/... and 10.... are treated as the same identifier).", file=sys.stderr)
    print("Not compared: authors. Year is used only to annotate a near-duplicate - it never merges "
          "or drops a record on its own.", file=sys.stderr)
    print("This script verified nothing against a catalogue. A dropped record is a decision it made "
          "on a title or DOI string; review the dropped list before using the output.", file=sys.stderr)
    return 1 if (dropped or problems) else 0


if __name__ == "__main__":
    sys.exit(main())
