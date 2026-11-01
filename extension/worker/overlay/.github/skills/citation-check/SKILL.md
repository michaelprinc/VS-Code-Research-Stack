---
name: citation-check
description: Check DOI syntax and compare citation fields with Crossref metadata without overstating validation.
---

# Citation check

- Normalize DOI URL prefixes and case, then request the Crossref record by DOI.
- A found record means Crossref has metadata; compare title, author and year while preserving the returned provider fields.
- A Crossref miss is unresolved, not proof that the DOI or work is invalid. Suggest an alternate agency or manual resolver check.
- Report provider outage, denial and rate limit separately from a miss.
- Never claim that a valid DOI proves the paper's scientific claims or the quality of the cited work.
