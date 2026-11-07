# Lessons — Research Stack Toolkit

Durable process lessons. Release-specific decisions live in `specs/phase-N/design.md`.

## 0.3.7 (2026-11-02) — a lockfile that uv refuses

1. **A version bump is a re-lock, not a string replacement.** 0.3.6 changed `pyproject.toml` and copied
   the old `uv.lock` forward. uv compares the lock's root `[[package]]` entry with `[project].version`
   before it honours `--locked`, so the release was unusable on every host. Any script that writes a
   version must re-check the pair beside it — that is now `scripts/lockintegrity.py`, called by the
   bundle builder, the VSIX audit and the test suite.
2. **Regenerate lockfiles with a pinned uv; never hand-edit them.** `uv lock` produced a two-line diff
   and a byte-identical result on a second run. A hand edit would have risked the 39 third-party pins.
   Keep the binary version in the evidence (`uv 0.13.6`) so the artifact is reproducible.
3. **Match a tool's message, not its exit code.** The same refusal exits 1 on uv ≥ 0.8 and 2 on
   0.5.0–0.7.22. Code that branches on the number silently stops detecting the failure on half the range.
4. **`--no-config` does not neutralise the environment.** uv lets `UV_*` variables win over config
   files, so a user's `UV_INDEX_URL` or `UV_LOCKED` can make a correct lock look stale. A reviewed
   command has to scrub the variables that change its meaning.
5. **Check the platform's tooling before choosing a version number.** `@vscode/vsce` validates the
   manifest with `semver.valid`, which rejects a four-part version; the requested `0.3.6.1` could not be
   packaged at all ([vscode-vsce #415](https://github.com/microsoft/vscode-vsce/issues/415)). The
   constraint is now a test, not a surprise discovered during packaging.
6. **Verification scripts must derive the artifact name.** Hard-coded `…-0.3.6.vsix` in npm scripts made
   `verify-package` and `check:payload` audit the previous release after a version bump.
7. **A fallback must be visible.** `--locked` → one `--frozen` is only safe if the step evidence says a
   fallback happened; otherwise a host-specific problem is reported as a clean install.
8. **Subagents need an explicit write scope.** An audit child was briefed read-only and edited nine
   files; the work was usable but had to be reviewed line by line. State the writable file list, or
   state read-only and ask for a report.
9. **A hand-written parser needs the tool's real output as its fixture.** Both lock readers looked fine
   against the shipped pair and were wrong: an array was cut at a nested `]`, uv writes `marker` before
   `specifier`, extras live in their own `extras` key, `include-group` is not a requirement. Each shape was
   confirmed by running real uv (0.5.0 and 0.13.6) on a probe project before the reader was changed.
10. **Two readers of the same pair must be aligned on measured behaviour, not on intuition.** uv 0.13.6
    writes `provides-extras`; uv 0.5.0 does not. Treating the missing key as drift would have made the
    toolkit refuse a lock real uv accepts. Absence of an optional key is only drift when a receipt shows a
    version that always writes it.
11. **Package after the last edit to a packaged file.** `verify_vsix.py` compares packaged bytes with the
    source tree, so any edit to a payload file after `npm run package` invalidates the audit and the
    recorded sha256. `CHANGELOG.md` and `test/` are not packaged; `readme.md`, `runtime.js` and the worker
    tree are.
12. **Record a tag, not a commit hash, inside the release notes.** Amending the release commit to add its
    own hash changes the hash. The tag name is stable and points at whatever the release commit becomes.
13. **`addopts = "-q"` in `[tool.pytest.ini_options]` hides the pass/skip summary line.** Count with
    `-o addopts="" -q` before quoting a number in evidence, or the receipt silently loses its verdict.
14. **A working tree is not the tag.** `.gitattributes` says `* text=auto eol=lf`, so git stores LF while the
    checkout can hold CRLF and still report itself clean. A VSIX built from that tree is not buildable from
    the tag. Normalise the staged tree in the packager and make the verifier refuse the difference.
15. **Case-insensitivity is a Windows feature you have to code for.** Node keeps the OS spelling of
    environment names, so a case-sensitive deny-list let `Uv_Index_Url` through. Compare names lower-cased,
    and drop the reviewed names too — a host spelling of a name the toolkit sets is the same collision.
16. **A fallback that fails must carry the first refusal.** Catching uv's lock refusal and then losing its
    text turns a lockfile problem into a network-looking error. Combine both sentences and say how many
    attempts ran.
17. **An acceptance row is only done when a test drives the failure it describes.** "Both attempts
    recorded" sat unproven until a test made `--frozen` fail. When a proof is missing, write that in the
    row instead of naming a file that does not cover it.
18. **Do not let a delegated agent's number become a documented fact before it is re-measured.** The
    synthetic-fixture count moved twice while agents were editing the same file; quote it from a command
    run at freeze time, with the grep caveat spelled out.
19. **Line endings are only half of a reproducible artifact.** Two builds of the same commit produced
    312,471-byte VSIXes with byte-identical members and three different digests, because vsce writes the
    copy time of each staged file and a `new Date()` for the members it generates; a build from a fresh
    clone then differed again because 32 members carried 0664 here and 0644 in the clone. `SOURCE_DATE_EPOCH`
    (which vsce honours by stamping every entry and sorting members) plus `chmod 0644` on the staged tree
    made the digest reproducible, and `scripts/verify_vsix.py` now refuses an artifact whose entries carry
    any other timestamp or mode.
20. **A documented reproduce command must be read-only, or say where it writes.** `run_uv_matrix.py` and
    `run_lock_provenance.py` write their JSON into the evidence folder, so following the README's own
    reproduce line modified two tracked receipts and created a third file; a child agent then "undid" it
    with `git checkout --` plus `rm -f` and destroyed an untracked receipt. Both scripts now take `--out`.
21. **Compare parsed semantics, not normalised text.** Both readers refused `pypdf<7,>=6.4` beside the
    `>=6.4,<7` that uv itself writes, and the same for `requires-python` — uv accepts those pairs, so the
    false alarm would have blocked the toolkit's own build. Bounds are compared as sets now.
22. **A reader that walks only the root entry cannot see the rest of the file.** A deleted or duplicated
    transitive `[[package]]` block, a lock header uv cannot read, and an `sdist` written as a list were all
    certified clean while uv refused them with exit 2.
23. **A gate that is true "by inspection" is not a gate.** "No `uv lock` inside a managed runtime" had no
    test and no verifier. It is now enforced where the call is made: the boundary refuses a `lock`
    subcommand and a `sync` with neither `--locked` nor `--frozen`, without spawning.
24. **When no real host can produce a failure, drive the path with a stand-in that emits measured real
    output, and label it.** No uv from 0.5.0 to 0.13.6 rejects the shipped pairs, so the fallback paths were
    exercised with a stand-in uv that replays the sentences captured from real uv runs and otherwise execs
    the real binary. The label belongs in the receipt, not in a footnote.
25. **A measurement harness can invent a verdict.** `uv lock --check --no-config` makes uv ignore
    `[tool.uv]` completely, and a fixture whose `dynamic` dependencies come from `requirements.txt` needs
    that side file on disk. Four adversarial rows measured the opposite of their recorded exit code until
    both harness details were fixed (`--no-config` dropped, `requirements.txt` / `extras.txt` written).
    Reproduce uv's own command line, and copy every file the fixture references.
26. **An internal error must not be returned as a verdict.** `pairProblems` wrapped its comparison in a
    catch that returned `lock comparison failed: <message>`; the pre-flight and the packager read that as a
    finding about the dependency pair, so a reader bug blocked the release gate while saying nothing about
    the files. Parse failures are verdicts — uv itself refuses to open those files — a failure inside the
    comparison propagates to the caller, which reports it in its own words.
27. **An interval merge is only proven by its open end.** `_merge_intervals` folded
    `[(None,(3,14)), ((3,14),None)]` into `(None,(3,14))`, so the shipped `resolution-markers` partition
    read as a coverage hole on the toolkit's own release pair. Assert the unbounded result, and run the
    same corpus through both readers: 52 marker/range cases, 0 divergences, is what made the fix provable.

## 0.3.8 (2026-11-04) — a report the host console could not carry

28. **A step's failure and its effect are different facts.** The panel said *Corpus index and record
    store* failed; the store had already been created and the report of that success is what raised. Read
    the failing command's own error path in the source before repeating the panel's verb — `exitCode: 2`
    was `cli.py`'s own `return 2`, not an interpreter crash.
29. **`UnicodeEncodeError` is a `ValueError` subclass.** A CLI that catches
    `except (DocumentError, OSError, ValueError)` to report domain errors turns an output-encoding failure
    into a fake domain error, and the handler's own `print` can fail the same way. A codec failure needs
    its own class at the boundary, and the boundary must not classify it by exit code.
30. **Isolation changes what the environment can do.** `-I` implies `-E`, so `PYTHONIOENCODING` is inert
    under it; in a non-isolated child `PYTHONIOENCODING` beats `-X utf8`. Both were measured on this host
    before the fix was chosen, and both are now asserted in `tests/test_stdio.py`. Reasoning from
    documentation would have produced a fix that does nothing.
31. **A harness that captures stdout in UTF-8 cannot see a codec failure.** `tests/test_workspace.py`
    calls `main()` in process, so `print()` writes into pytest's UTF-8 capture: 200+ green Python tests
    shipped a defect that only appears when the child's stdout is a Windows code page. Encoding defects are
    proven with real children, real pipes and a forced code page.
32. **The parent's decoder is lossy and silent.** `stream.setEncoding("utf8")` turns a cp1250 child's
    bytes into U+FFFD with exit 0, and the runner then holds a path that names nothing. Put the guard where
    the semantics live — the step that will use the path — not in the byte boundary.
33. **A receipt a machine parses must be ASCII.** `ensure_ascii=True` costs nothing, survives a stream that
    cannot be reconfigured, and decodes back through `JSON.parse` to the same text the operator reads.
34. **The position number in a codec error is a property of the path, not of the defect.** The field
    reported `position 67`; the same defect on this host reports 59–63 depending on the prefix. Match the
    sentence, the character and the exit code, not the offset.
35. **Fixtures that hard-code the release value break on the release.** Re-locking to 0.3.8 made 16
    `String.replace` searches in `extension/test/lockfile-adversarial.test.js` match nothing, so six "drift"
    fixtures compared an unmutated pair and reported the opposite verdict from uv. Derive the value from
    the shipped pair and bump to a version the pair cannot already hold.
36. **Documentation inside the artifact is part of the artifact.** 0.3.7 shipped guides telling the operator
    to install `research-stack-toolkit-0.3.6.vsix`. `scripts/verify_vsix.py` now refuses packaged
    documentation that names another release, and a test proves the refusal by re-stamping a shipped guide.
37. **A gate script's CLI is part of the gate.** `scripts/lockintegrity.py` takes an optional root, so
    `lockintegrity.py --json` was read as a root directory and printed `"ok": false` with three
    `missing pair:` lines — a false failure that looked like a real one. Run a verifier through its real
    interface and check the receipt, not just the exit code.

## Research 2026-11-04 — testing Windows-targeted software from Linux

Report: [docs/research/windows-testing-on-linux-2026-11/](../docs/research/windows-testing-on-linux-2026-11/README.md).

38. **Check what the development host actually is before planning emulation.** This host is WSL2 and the
    repository is on `K:\` through a 9p drvfs mount (`stat -f` → `v9fs`): real NTFS case-insensitivity, the
    field workspace itself, and the field attempt log are reachable — while `cmd.exe`, `taskkill.exe`,
    `chcp` and `python.exe` are absent from PATH. Windows *names* are available here; Windows *processes*
    are not.
39. **A platform defect usually has a documented mechanism.** CPython uses UTF-8 for the Windows console
    device but the ANSI code page for **pipes and redirected files** (PEP 540), and `execFile` gives the
    child a pipe — that one rule predicts the field failure. `-I` implies `-E`, so the fix had to be the
    `-X utf8` flag rather than `PYTHONUTF8`.
40. **An emulator's defaults are not the target's defaults.** Wine derives its code page from the Unix
    locale (`WINEUNIXCP`, UTF-8 by default), so a default Wine prefix tests UTF-8 behaviour while claiming
    to test cp1252. Same class as forcing a non-UTF-8 Linux locale, which mangles argv through
    `surrogateescape` first.
41. **Name the layer a test lives at.** SHAPE (the call form) / EMULATED (mechanism reproduced on Linux) /
    FIXTURE (bytes recorded on real Windows) / WINDOWS-BACKED (hosted CI or a VM) / FIELD (the user's
    machine). The label decides what a release note may claim, and it is what stops a local pass from being
    read as Windows verification.
42. **A test file that is not enumerated never runs.** `extension/package.json` lists 16 test files
    explicitly; a 17th passes when run by hand and is invisible to CI. `module-boundaries.test.js` already
    refuses an unreviewed shipped module — the same guard is missing for test files.

## 0.3.9 — direct ingestion, freshness and migration (2026-11-06)

43. **A per-call reader cap is not an indexing cap.** `extract_document`'s 50-page/100-item limit is a
    response-size rule. Reusing it as the indexing limit would have silently indexed the first 100 pages of
    a 500-page PDF. `extract_source` loops under the same cap and `coverage.batches` proves the loop ran.
44. **A failure must be attributed to the unit it belongs to.** One unreadable page is that page's
    `failedUnits` entry, not the file's verdict. Classifying the whole file as failed because one page
    raised throws away text that reads cleanly; classifying it as complete hides the gap.
45. **A store audit must tolerate the schema it is auditing.** `_snapshot` counted `index_runs` in every
    copy it made, so `backup` refused a genuine 0.3.8 store — the exact store the migration story needs a
    backup of. Count what the snapshot has, and assert `schemaVersion` in the receipt.
46. **Do not swallow a database error in a helper whose failure is the only signal.**
    `_record_cancelled_run` caught `sqlite3.Error` and rolled back; the audit row was never written because
    `_connect(root)` opens **read-only** and an audit write needs `create=True`. The swallow turned a
    one-line mistake into a full test cycle of "the row is just missing".
47. **A `--workspace` verb must resolve relative paths against the workspace it was given.** The CLI
    resolved them against the process cwd, so the panel's own relative paths came back as
    `SOURCE_OUTSIDE_ROOT`. Verified by `tests/test_stdio.py::test_a_source_outside_the_workspace_is_refused_by_the_verb`.
48. **Read the release tag, not the memory of it.** `tests/test_migration.py` builds its fixture by
    `git archive v0.3.8` and running **that** code. The alternative — hand-writing the old DDL — tests the
    test. It also found the read-refusal behaviour (`STORE_SCHEMA_UPGRADE_REQUIRED`) that a hand-written
    fixture would have invented wrongly.
49. **A version bump is a re-lock and a documentation change.** `uv lock` (pinned 0.13.6) changed exactly
    one line; `scripts/verify_vsix.py` then refused the packaged guides because they still told the
    operator to install `research-stack-toolkit-0.3.8.vsix` and look in `worker-0.3.8/`. Both are the same
    release-identity defect class as 0.3.7's stale docs.
50. **Counting gates are the cheapest drift detectors, and they break loudly.** `unit.test.js` pins the
    contributed-command count and the disposed-subscription count; adding five commands moved both. Update
    the number **and** name the new commands in the assertion, so the gate keeps its meaning.
51. **A payload directory is not a payload module.** The 0.3.9 bundle work staged `extension/bundles/` in
    `extension/scripts/package.js` but not `extension/bundles.js`, and `extension/package.json`'s `files`
    allowlist did not name it either. The VSIX audit passed — the inventory simply did not expect the
    module — while `npm run check:payload` failed with `Cannot find module './bundles'` loading the packaged
    `extension.js`. A package that activates and then fails to load is not caught by a content audit; it is
    caught by running the packaged entry point. When a release adds a module, add it to the staging list,
    the `files` allowlist, the manifest mirror and the audit inventory, in that order.
52. **vsce refuses an include pattern that matches nothing it staged.** Adding `bundles.js` to `files`
    without adding it to the staging list produced `ERROR The following include patterns … do not match any
    files packaged` and `npm run package` exited 1 — masked as exit 0 by `| tail -4`. Check the real exit
    code of a pipeline before believing a build succeeded.
53. **A plan that is handed no observation must not assume an empty world.** `planInstall` reported all 11
    files `new` when the caller supplied no hashes, and the control panel is exactly such a caller: it would
    have offered to rewrite files that were already the reviewed bytes and called an operator's edit
    something it never installed. When a function takes caller-supplied state, either require it or observe
    it yourself; a default of "nothing exists" is a lie with a nice API.
54. **A fixture that hard-codes the previous release stops testing the gate it exists to test.**
    `tests/test_vsix.py` built its stale-documentation fixture by replacing `worker-0.3.8`; once the guides
    said `worker-0.3.9` the replacement matched nothing and `assert stale != shipped` failed — the same class
    as 0.3.8's `lockfile-adversarial.test.js` trap. Derive the fixture from the reviewed version
    (`extension/vsix-manifest.json`) so the gate survives the next bump.
55. **Generated files are edited by their builder, not by hand.** `extension/worker/README.md` is a copy of
    the repository `README.md` whose SHA-256 is recorded in `extension/worker/bundle.json`. Editing the copy
    breaks the worker-bundle hash check; the fix is to edit the source and re-run
    `scripts/build_worker_bundle.py`. A documentation task that names a generated file has a packaging step
    hidden inside it.
56. **A list-based allowlist silently drops a reviewed file, and no gate notices.** A sixth overlay skill was
    authored into `templates/recommended-overlay/` and never shipped: the builder iterates `OVERLAY_FILES`,
    the VSIX audit checks the members it expects, and nothing asked what the tree actually held. The file was
    also stale — it described 0.3.8 behaviour as though it were current, so the harm was not only a missing
    file but a wrong instruction sitting in a reviewed tree. Compare the tree with the allowlist at build time
    (`scripts/build_worker_bundle.py::assert_overlay_tree_is_reviewed`), and when a release changes what a
    reviewed document says, change the document or remove it.
57. **A capability gate that scans bytes also scans prose.** Adding the update channel made `scripts/verify_vsix.py`
    report `packaged JavaScript introduces network capability: ['extension/extension.js']` because a *comment* contained
    the word "socket". The fix was to reword the comment, not to widen the gate. And a gate that only forbids is a gate
    that passes when the reviewed code is deleted: `verify_vsix.py` now also fails when `extension/updates.js` loses the
    host, the timeout, the byte cap, the cooldown or its `httpsGet`.
58. **Returning a shared variable after an `await` returns somebody else's answer.** `runUpdateCheck` assigned
    `updateCheck`, awaited a message box, then `return updateCheck`. A panel-scheduled check that finished during that
    await overwrote the variable, so the command returned `not-published` while the setting said `disabled`. Build a
    local verdict and return that; the shared variable is for the panel, not for the caller.
59. **An assertion about a counter must run before anything else can move it.** The payload check's update assertions
    sat after the GUI section, which had already scheduled a check; the request count no longer described the calls
    being asserted. Move the measurement to a point where the only activity is the one under test.
60. **Run `--help` on the version you pinned instead of reading the documentation.** `--oidc` is in
    `@vscode/vsce` 4.1.0's `publish --help` and absent from the pinned 4.0.0's; `create-publisher` is gone from both,
    and `--githubPat` has never existed. A runbook written from docs alone would have used a flag that errors out.
61. **When two official sources disagree, record both with their dates and plan to the conservative one.** VS Code docs
    (2026-11-04) say global PATs retire 2026-12-01; the DevOps blog (2026-10-23) strikes that through to 2027-01-27, and
    the Learn page contains both sentences. The runbook plans to the earlier date and cites the postponement.
62. **A prompt that auto-answers in CI is a silent policy change.** vsce asks `y/N` for a missing LICENSE and a missing
    `repository`, but answers `y` itself when stdout is not a TTY — so an unlicensed package publishes from a pipeline
    without anyone deciding it. Pass `--skip-license` explicitly and let the flag be the decision.
63. **`pytest -q` on top of `addopts = "-q"` is `-qq`, and `-qq` prints no summary.** The suite passed and the receipt
    looked empty. Evidence commands pass `-o addopts=""`.
64. **A harness that flattens a host API is a test lie.** `Uri.joinPath` returning a bare string made `savedFile.fsPath`
    undefined in the packaged flow, and dropping the `options` argument of `showInformationMessage` made a modal consent
    dialog untestable. When a harness is the only host a test can see, its fidelity is part of the assertion.
65. **Redaction patterns fail in both directions, and only one direction is obvious.** A URL scheme was eaten as a
    Windows path (`https://` → `http<path>`), the Marketplace API path was eaten as a token blob, and `\\wsl$` plus UNC
    paths were not matched at all. Test the strings that must survive, not only the ones that must not.
66. **A byte budget that leaves the footer and the user's own text outside it is not a budget.** The report cap was
    exceeded because the cap was applied to the log tail only. Take the fixed parts out of the budget first, then
    truncate the variable part with a function that backs off rather than splitting a UTF-8 character.
67. **A successful `vsce package` is not a publishable package.** The 30-keyword limit, the prerelease refusal and the
    PNG icon rule are enforced by the Marketplace or by `publish`, not by `package`. Verify against the server (the
    `extensionquery` probe, `vsce show`) and against `publish --help`, not against a green package step.
