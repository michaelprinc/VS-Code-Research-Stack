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
