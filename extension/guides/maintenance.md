# Maintaining scalable component documentation

The source of the user guide is the set of individual Markdown files in `extension/guides/`, indexed by `extension/components.json`. The control-panel component list and guide actions use the same registry. `guides/index.md` is generated; do not maintain a second manual component table.

## Add or revise a component

1. Add one registry record with a stable ID, title, group, kind, profile membership, concise purpose, `guides/<id>.md` path, current official HTTPS URL (or null for an unselected provider), and actual local-review date.
2. Author its own guide with **Setup**, **First task and readiness**, **Troubleshooting and limits**, and **Current documentation** sections. Separate implemented toolkit behavior from external software and planned integration. Explain what the diagnostic proves and what the user must test manually.
3. Link maintained official documentation and verify it. Record the review date of local instructions; never claim that bundled text is automatically current. Prefer a stable official landing page over copying an entire vendor manual. Document version-specific differences when they affect onboarding.
4. Add detection logic only when there is concrete installation/readiness evidence. Otherwise retain Not checked, External service or Planned; never infer readiness from desired package membership. Include a meaningful positive/negative test for the new detector.
5. Run `uv run --locked python scripts/build_guide_index.py`, Node tests, relevant Python tests and the VSIX audit. Packaging also regenerates the index and validates guide completeness, paths and official links. The archive audit checks every bundled guide against its source and rejects undeclared files or tampering.

## Keep sources current

Review each component's official source during a release or when a user reports a changed workflow. Update that individual guide and its registry review date, then regenerate the hub. `Latest docs` resolves the registry URL through the host browser only when clicked; it is not an updater, crawler or cached mirror. Future automated freshness checking should be an explicit feature with its own scope and evidence rather than relabeling old text as current.

Catalog requirement versions, detected installation versions and current documentation versions are different facts. Do not copy catalog versions into the installed inventory. Preserve component-specific setup/limits so onboarding remains useful as the toolkit grows.

[Back to guide hub](index.md)
