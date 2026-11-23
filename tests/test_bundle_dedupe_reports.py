"""T16-12 (P10): `dedupe_records.py` keeps its counts, its JSON and its exit codes, and bounds its stderr.

The script is the bundle's own review tool: it reports every record it dropped. On a large export that
report was unbounded — a 2 000-record run wrote ~1 900 per-record lines to stderr — which is what fills
an agent's context and buries the summary line the operator actually reads. 0.3.15 caps ONLY the
per-record detail lines and states, on stderr, how many were hidden and how to ask for them
(`--verbose`, or `RST_DEDUPE_VERBOSE=1`).

What this file proves, against the packaged copy of the script and the byte-identity of the two trees:

  1. the staged tree and the payload copy are the same bytes (the catalog build enforces it; this pins
     it from the test side, on the file that the cap changed);
  2. a 2 000-record synthetic run stays bounded on stderr — a fixed line count, not one that grows with
     the input — while the uncapped report on the same input is ~43× larger;
  3. the summary counts are identical capped and uncapped, so the cap hides detail and never a result;
  4. the JSON array on stdout is complete, byte-identical in every run, and holds exactly `kept` records;
  5. the exit codes are the ones the script has always returned: 1 when a run dropped or flagged
     something, 0 when it did neither, 2 for each of the three bad-input cases;
  6. the suppression line names how much it hid, both halves of that total, and both ways to get it.

Standard library only, run through `subprocess` exactly as a user or an agent runs it. The records are
synthetic: no real work is named and nothing is fetched.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
STAGED = ROOT / "templates/skill-bundles/theology/theological-research/scripts/dedupe_records.py"
PAYLOAD = ROOT / "extension/bundles/theological-research/scripts/dedupe_records.py"

# The cap the script states in its own help, repeated here so a change to one side fails this test.
MAX_DETAIL_LINES = 40
VERBOSE_ENVIRONMENT_VARIABLE = "RST_DEDUPE_VERBOSE"

# 2 000 synthetic records in the shapes the script treats differently, so one run produces drops by DOI,
# drops for a missing title, drops for a same-year near-duplicate, and flags for records with no
# identifier at all. Sizes are chosen to keep the run near two seconds, not to flatter the result.
UNIQUE_RECORDS = 150
DOI_DUPLICATE_RECORDS = 1200
NO_TITLE_RECORDS = 400
NO_IDENTIFIER_RECORDS = 150
NEAR_DUPLICATE_RECORDS = 100
TOTAL_RECORDS = (UNIQUE_RECORDS + DOI_DUPLICATE_RECORDS + NO_TITLE_RECORDS
                 + NO_IDENTIFIER_RECORDS + NEAR_DUPLICATE_RECORDS)

WORDS = """altar antiphon apophatic basilica beatitudes catechesis christology cloister communion
confession convent discernment doctrine doxology exegesis hermeneutics hymnography iconography
incensation justification kenosis koinonia liturgy marianism martyrdom mysticism ontology orthodoxy
paideia penitence pneumatology prolepsis sacramentary sanctification soteriology theosis typology
virginity wisdom worship""".split()


def word_pair(index: int, salt: int) -> tuple[str, str]:
    first = WORDS[(index * salt + 3) % len(WORDS)]
    second = WORDS[(index * salt + salt + 5) % len(WORDS)]
    if first == second:
        second = WORDS[(index * salt + salt + 6) % len(WORDS)]
    return first, second


def synthetic_records() -> tuple[list[dict[str, object]], list[str]]:
    """Build the 2 000 records and the titles the near-duplicate group is derived from."""
    records: list[dict[str, object]] = []
    unique_titles: list[str] = []
    for index in range(UNIQUE_RECORDS):
        first, second = word_pair(index, 7)
        title = f"{first} {second} fascicle"
        unique_titles.append(title)
        records.append({"title": title, "doi": f"10.5555/rskt.{index}", "year": 1970 + (index % 50)})
    for index in range(DOI_DUPLICATE_RECORDS):
        source = index % UNIQUE_RECORDS
        records.append({
            "title": f"Second copy {index} of an indexed work",
            "doi": f"https://doi.org/10.5555/rskt.{source}",
            "year": 1970 + (source % 50),
        })
    for index in range(NO_TITLE_RECORDS):
        records.append({"title": "", "doi": f"10.5555/untitled.{index}", "year": 2005})
    for index in range(NO_IDENTIFIER_RECORDS):
        first, second = word_pair(index, 11)
        records.append({"title": f"{first} {second} notebook", "year": 1998})
    for index in range(NEAR_DUPLICATE_RECORDS):
        source = index % UNIQUE_RECORDS
        records.append({
            "title": f"{unique_titles[source]} reprint",
            "doi": f"10.5555/near.{index}",
            "year": 1970 + (source % 50),
        })
    return records, unique_titles


def run(records_file: Path, *extra: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    environment = {key: value for key, value in os.environ.items() if key != VERBOSE_ENVIRONMENT_VARIABLE}
    environment.update(env or {})
    return subprocess.run(
        [sys.executable, str(PAYLOAD), str(records_file), *extra],
        capture_output=True, text=True, encoding="utf-8", check=False, env=environment,
    )


def parse_summary(stderr: str) -> dict[str, int]:
    line = next(entry for entry in stderr.splitlines() if entry.startswith("records in:"))
    parts = dict(entry.split(": ") for entry in line.split("  "))
    return {
        "in": int(parts["records in"]),
        "kept": int(parts["kept"]),
        "dropped": int(parts["dropped"]),
        "flagged": int(parts["flagged for review"]),
    }


@pytest.fixture(scope="module")
def large_input(tmp_path_factory: pytest.TempPathFactory) -> Path:
    records, _ = synthetic_records()
    path = tmp_path_factory.mktemp("dedupe-large") / "records.json"
    path.write_text(json.dumps(records, ensure_ascii=False), encoding="utf-8")
    return path


def test_the_two_trees_ship_the_same_dedupe_script() -> None:
    staged, payload = STAGED.read_bytes(), PAYLOAD.read_bytes()
    assert staged == payload, "the staged tree and the payload copy of dedupe_records.py are not the same bytes"
    source = payload.decode("utf-8")
    assert f"MAX_DETAIL_LINES = {MAX_DETAIL_LINES}" in source, "the cap is not in the shipped script"
    assert '"--verbose"' in source, "the script does not offer the flag its help promises"
    assert VERBOSE_ENVIRONMENT_VARIABLE in source, "the environment variable is not in the shipped script"
    assert "not printed" in source, "the script never states that it hid detail"
    # What must not have moved: the fields it compares, and the honesty line about what it verified.
    assert "Fields compared: title" in source and "Not compared: authors" in source
    assert "This script verified nothing against a catalogue" in source


def test_a_two_thousand_record_run_stays_bounded_on_stderr(large_input: Path) -> None:
    result = run(large_input)
    lines = result.stderr.splitlines()
    summary = parse_summary(result.stderr)
    detail = summary["dropped"] + summary["flagged"]

    assert summary["in"] == TOTAL_RECORDS == 2000
    assert summary["kept"] + summary["dropped"] == summary["in"], "the summary does not account for every record"
    assert detail > MAX_DETAIL_LINES, "the fixture produced too little detail to prove a cap"

    # summary line + at most MAX_DETAIL_LINES detail lines + the suppression line + the three closing lines.
    assert len(lines) <= 1 + MAX_DETAIL_LINES + 1 + 3, \
        f"stderr grew with the input: {len(lines)} lines for {detail} detail items"
    assert len(result.stderr.encode("utf-8")) < 20_000, "stderr bytes grew with the input"
    assert result.stderr.count("DROPPED") <= MAX_DETAIL_LINES
    assert result.returncode == 1, "a run that dropped records must still exit 1"

    kept = json.loads(result.stdout)
    assert len(kept) == summary["kept"], "the JSON on stdout is not the full kept set"
    assert all(isinstance(record, dict) and record.get("title") for record in kept)

    suppressed = detail - MAX_DETAIL_LINES
    notice = next(line for line in lines if "not printed" in line)
    assert f"{suppressed} detail line(s)" in notice, "the notice does not name how much it hid"
    assert "--verbose" in notice and f"{VERBOSE_ENVIRONMENT_VARIABLE}=1" in notice, \
        "the notice does not say how to get the full detail"
    assert "already account for every" in notice, \
        "the notice does not state that the counts and the JSON still cover the hidden records"


def test_the_full_detail_on_demand_is_the_report_the_cap_hides(large_input: Path) -> None:
    capped = run(large_input)
    by_flag = run(large_input, "--verbose")
    by_environment = run(large_input, env={VERBOSE_ENVIRONMENT_VARIABLE: "1"})

    capped_summary, flag_summary = parse_summary(capped.stderr), parse_summary(by_flag.stderr)
    assert flag_summary == capped_summary == parse_summary(by_environment.stderr), \
        "asking for the full detail changed a count"
    assert by_flag.stdout == capped.stdout == by_environment.stdout, "the JSON output changed between runs"
    assert by_flag.returncode == capped.returncode == by_environment.returncode == 1

    detail = capped_summary["dropped"] + capped_summary["flagged"]
    full_lines = by_flag.stderr.splitlines()
    assert not any("not printed" in line for line in full_lines), "--verbose still suppressed something"
    # summary line + every dropped line + every flagged line + the three closing lines.
    assert len(full_lines) == 1 + detail + 3, f"--verbose did not print all {detail} detail lines"
    assert by_flag.stderr.count("DROPPED") == capped_summary["dropped"], "--verbose did not print every dropped record"
    assert by_environment.stderr == by_flag.stderr, "the environment variable is not equivalent to the flag"

    capped_bytes, full_bytes = len(capped.stderr.encode("utf-8")), len(by_flag.stderr.encode("utf-8"))
    assert full_bytes > 10 * capped_bytes, f"the cap bounded nothing measurable: {capped_bytes} vs {full_bytes}"


def test_the_suppression_line_names_both_halves_of_what_it_hid(large_input: Path) -> None:
    result = run(large_input)
    summary = parse_summary(result.stderr)
    notice = next(line for line in result.stderr.splitlines() if "not printed" in line)
    assert summary["dropped"] > MAX_DETAIL_LINES and summary["flagged"] > 0, \
        "the fixture must hide dropped records AND flagged ones for this to mean anything"
    assert "dropped record(s)" in notice and "flagged for review" in notice, \
        "the notice counts one kind of loss and not the other"
    shown_dropped = MAX_DETAIL_LINES
    assert f"{summary['dropped'] - shown_dropped} dropped record(s)" in notice, \
        "the notice does not say how many dropped records it hid"
    assert f"{summary['flagged']} record(s) flagged for review" in notice, \
        "the notice says the wrong number of hidden flags"


def test_small_runs_and_the_three_bad_input_cases_return_the_codes_they_always_returned(tmp_path: Path) -> None:
    clean = tmp_path / "clean.json"
    clean.write_text(json.dumps([
        {"title": "Augustine on the catechesis of the catechumen", "doi": "10.5555/clean.1", "year": 1995},
        {"title": "Gregory of Nyssa and the apophatic way", "doi": "10.5555/clean.2", "year": 1996},
    ], ensure_ascii=False), encoding="utf-8")
    result = run(clean)
    assert result.returncode == 0, "a run that dropped and flagged nothing must exit 0"
    assert len(json.loads(result.stdout)) == 2
    assert "not printed" not in result.stderr, "a small run gained a suppression line it does not need"
    assert "records in: 2  kept: 2  dropped: 0  flagged for review: 0" in result.stderr

    flagged = tmp_path / "flagged.json"
    flagged.write_text(json.dumps([{"title": "A note with no identifier at all", "year": 1911}], ensure_ascii=False),
                       encoding="utf-8")
    assert run(flagged).returncode == 1, "a flagged record must still exit 1"

    missing = tmp_path / "does-not-exist.json"
    assert run(missing).returncode == 2, "a missing file must still exit 2"
    invalid = tmp_path / "invalid.json"
    invalid.write_text("{ not json", encoding="utf-8")
    assert run(invalid).returncode == 2, "invalid JSON must still exit 2"
    not_array = tmp_path / "not-array.json"
    not_array.write_text('{"title": "a single object, not an array"}', encoding="utf-8")
    assert run(not_array).returncode == 2, "JSON that is not an array must still exit 2"
