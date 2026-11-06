# Citation standards

## Contents
- Default style
- Record fields
- DOI and metadata verification
- Deduplication
- Quotations and locators
- Common failure patterns

## Default style

Chicago notes-bibliography, unless the user or the target journal specifies otherwise. Common alternatives: SBL for biblical studies, Turabian for student work, and Czech theological-journal styles. Keep one style for the whole report.

## Record fields

For every source collected, keep: author/editor · exact title and subtitle · year · journal or book · volume/issue/pages · DOI or stable identifier · URL or repository record · source type · access status · verification status. Store these as `records.json` so scripts can check them.

## DOI and metadata verification

1. Run `scripts/crossref_lookup.py "exact title" --author Surname --year YYYY`.
2. Accept a match only when title and author agree. Year and container are supporting evidence, not proof.
3. If Crossref has no record, try OpenAlex or the publisher page. If nothing confirms it, mark the record `unverified` and say so in the bibliography.
4. Book chapters: verify the container title, not only the chapter title.
5. Translations and reprints: cite the edition actually consulted; note the original date separately.
6. Serials with renamed titles: record the title as published in that year.

## Deduplication

Run `scripts/dedupe_records.py records.json`. It groups by DOI first, then by normalized title similarity. Review the reported near-matches by hand: the same work under translated titles, and a chapter versus its containing volume, are the two cases that most often look like duplicates.

## Quotations and locators

Quote only from text actually inspected. Give a locator: printed page, PDF page, chapter or section heading, or for ancient texts the standard reference system (e.g. a Greek/Latin edition numbering) rather than a page of one translation. State which translation is quoted. If wording cannot be checked, paraphrase and mark it, or state that the wording is unverified.

Never present a search snippet as a quotation. Never add page numbers that were not seen.

## Common failure patterns

- A plausible title with no retrievable record → fabricated or garbled citation. Re-search or drop it.
- Right work, wrong year → preprint vs monograph, or translation vs original.
- Right author, wrong work → citation attached to a source that only mentions the topic.
- One source repeated through several secondary citations → counted as consensus. Trace it back.
- Secondary source cited for what a primary text says → cite the primary text.
