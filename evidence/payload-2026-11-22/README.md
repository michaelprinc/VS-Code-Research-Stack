# Payload delta measurement — final, 2026-11-23 (P8 / T16-08)

**Status of these numbers: final for 0.3.15.** They were measured on the built candidate
`dist/research-stack-toolkit-0.3.15.vsix` after every package in this round had landed and the worker bundle
had been rebuilt from the reviewed `src/`. A provisional version of this note existed earlier in the round;
its candidate figure was measured mid-edit and is corrected below, because the correction is itself part of
the record.

## Baseline reproduction (the part that was proven before the build)

The audited 0.3.14 artifact had been overwritten in `dist/` by an interim build, so it was rebuilt from
the implementation commit in a clean git worktree (`git worktree add /tmp/base-0314 5995dfa`, the same
`npm run package` path, node_modules shared from the working tree):

```
/tmp/base-0314/dist/research-stack-toolkit-0.3.14.vsix
  121 members, 561 509 bytes packed, 1 710 211 bytes unpacked
  sha256 dba2c8040aa607e4d3aa4940e4fbd5760502729efba59d69c7eb95e17305f1dc
```

That digest is **identical to the one recorded for the audited 0.3.14 artifact** in the phase-15
acceptance record (T15-21) and in `.agent/QUALITY_STATE.md`. So the comparison below is against the
release the plan says to compare with, not against a rebuild that merely looks similar.

## The 0.3.15 candidate

```
dist/research-stack-toolkit-0.3.15.vsix
  121 members, 614 663 bytes packed (+53 154), 1 882 706 bytes unpacked (+172 495)
  sha256 d5c8a5fa433f87eaa96bd9b88a4d3a9b8df85330076e43f0e055409dc56f1d24
```

**Member set unchanged: 121 → 121, none added, none removed, none trimmed.** Every byte of the difference is
content growth inside members that were already in the package:

| Member | 0.3.14 | 0.3.15 | Δ |
|---|---|---|---|
| `extension/worker/src/research_stack/research.py` | 69 174 | 134 870 | **+65 696** |
| `extension/worker/src/research_stack/zotero_store.py` | 6 073 | 24 777 | +18 704 |
| `extension/worker/src/research_stack/records.py` | 102 315 | 115 604 | +13 289 |
| `extension/worker/src/research_stack/integrations.py` | 17 397 | 25 681 | +8 284 |
| `extension/guides/zotero-local-api.md` | 7 204 | 13 962 | +6 758 |
| `extension/worker/src/research_stack/machinefacts.py` | 10 526 | 17 120 | +6 594 |
| `extension/bundles/theological-research/references/my-library.md` | 3 188 | 9 198 | +6 010 |
| `extension/worker/src/research_stack/recommended_server.py` | 9 831 | 15 412 | +5 581 |
| `extension/bundles/theological-research/references/zotero-vocabulary.md` | 4 348 | 9 905 | +5 557 |
| `extension/changelog.md` | 5 956 | 11 146 | +5 190 |
| `extension/integrations.js` | 35 903 | 40 469 | +4 566 |
| `extension/worker/src/research_stack/provider_budget.py` | 17 384 | 21 685 | +4 301 |
| `extension/worker/README.md` | 33 297 | 37 936 | +4 639 |
| `extension/readme.md` | 17 731 | 21 446 | +3 715 |
| `extension/bundles/theological-research/scripts/dedupe_records.py` | 7 192 | 10 316 | +3 124 |
| `extension/diagnostics.js` | 18 798 | 20 996 | +2 198 |
| `extension/bundles/catalog.json` | 9 130 | 10 533 | +1 403 |
| `extension/worker/src/research_stack/lab_server.py` | 14 778 | 16 175 | +1 397 |
| `extension/integrationprobe.js` | 17 642 | 18 966 | +1 324 |
| `extension/extension.js` | 157 413 | 158 371 | +958 |
| `extension/guides/research-stack-full-markdown-bm25-prototype.md` | 1 319 | 1 999 | +680 |
| `extension/guides/onboarding.md` | 28 875 | 29 513 | +638 |
| `extension/guides/research-record-store.md` | 5 175 | 5 741 | +566 |
| `extension/bundles/theological-research/SKILL.md` | 11 547 | 12 045 | +498 |
| `extension/guides/research-corpus-index.md` | 5 895 | 6 374 | +479 |
| `extension/guides/toolkit.md` | 9 556 | 9 902 | +346 |
| **sum of the 26 changed members** | | | **+172 495** |

Each of these belongs to a fix this release was asked to make, and the two largest carry most of it: the
Zotero collection write path and the provider field fixes in `research.py`, and the snapshot baseline plus
the journal-cap measurement in `zotero_store.py`. Documentation and bundle text — the guide that had to name
the refusals the code actually raises, the bundle member that had to stop describing collections as tags, and
the release notes the operator reads — account for +31 014 of the growth. Nothing was moved out of the
package and no reviewed member was dropped to make the numbers fit.

## The ceiling, and the correction this round owes itself

`scripts/verify_vsix.py` held `MAX_UNPACKED_BYTES = 1_769_472` (1.6875 MiB, raised in 0.3.14 with 59 261
bytes of headroom, 3.4 % of that ceiling). Against that ceiling the candidate above fails with
`unpacked payload exceeds the 1769472 byte preview limit`. That is the gate doing its job.

Earlier in this round the decision was written down as **1 835 008 bytes (1.75 MiB)**, from an interim build
measured at 1 814 329 unpacked bytes. That measurement was taken while two packages were still editing
`src/research_stack/research.py` and `zotero_store.py`, and it was 68 377 bytes short of the truth: the
Zotero store growth and the provider field patch landed after it. A ceiling chosen from a stale measurement
is a ceiling that has to be raised again, so 0.3.15 raises it to the next step on the ladder this file has
used — **1 966 080 bytes (1.875 MiB)**, 1.5 → 1.6875 → 1.875 — which leaves **83 374 bytes of headroom: 4.2 % of the ceiling, 4.4 % of the payload**. 0.3.14 inherited
59 261 bytes, 3.4 % of its ceiling. The headroom is larger in bytes than last release's and about the same
in proportion, which is what the next release needs to inherit.

The alternative — trimming reviewed members to fit 1 769 472 — was considered and refused. The growth is in
the code and the text the 0.3.15 fixes required; shrinking documentation or worker behaviour to hold a budget
figure would trade a measured defect fix for a number.

The candidate was built twice in this round and the second build is the one measured above. The first
(`121 members, 614 494 B, 1 881 606 B unpacked, sha256 `4180292abced23ef…`) was packaged while two
packaged pages still stated that no 0.3.15 gate run existed — a statement that had just become false.
Correcting those pages changed `extension/readme.md` and the generated `extension/worker/README.md`,
which changed the archive. Nothing about the release itself moved between the two builds; the
difference is +1 100 unpacked bytes of corrected prose, and only the second digest is the candidate's.
## Gate results on this artifact

| Gate | Result |
|---|---|
| `npm run package` | `dist/research-stack-toolkit-0.3.15.vsix (121 files, 600.09 KB)`, worker bundle built from 25 reviewed source/lock files and 11 overlay templates for worker 0.3.15, guide hub from 29 component guides |
| `npm run verify-package` | `"result": "passed"` (ceiling 1 966 080, unpacked 1 882 706, digest `d5c8a5fa…`, bundle catalog 2.0 and 2.2, 16 bundle files, 0 unresolved licences, `publishable: true`) |
| `npm run check:payload` | `"result": "passed"` |
| `npm test` (extension/) | 541 tests, 541 pass, 0 fail, 0 skipped |
| `npm run test:panel` | 9 assertions run, 9 pass, 0 not proven |
| `npm run test:browser` | see [evidence/host-2026-11-22/README.md](../host-2026-11-22/) — Chromium render of the shipped panel, `errors: []`, three theme screenshots |

`npm test` shows no skipped case on this artifact: the release-gate case that skips when no candidate exists
ran, because a candidate does exist. It is the same gate that reported the stale `extension/worker/README.md`
before the worker bundle was rebuilt, so its passing here is the rebuild being checked, not a case that was
quietly dropped.
