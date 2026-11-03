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
