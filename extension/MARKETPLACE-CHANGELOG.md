# Changelog

## 0.3.13 — Public Preview

**Zotero work now lives in the Toolkit's own worker, with the dry run and the backup built in.** `zotero_library` carries every read — status, collections, items, search, indexed full text and supported exports — and `zotero_write` carries the gated write: a `preview` that shows the exact request and sends nothing, and an `apply` that refuses without both a key Zotero issued to you and the literal confirmation `write-to-zotero`. Before the first change the Toolkit saves a bounded snapshot of the library data it read and journals the values it replaced, so `undo` can replay them; version guards refuse a conflicting write instead of overwriting it. Delete, merge and duplicate checking are not supported. A generated RIS file is structurally validated before it is written, and `TY - GEN` no longer arrives as a journal article. No third-party Zotero server or external binary is installed on your behalf.

- **Both topic skill bundles now state their licence.** `theological-research` carries its own MIT licence inside the bundle and `document-corpus-bridge` carries the repository's, so both ship as publishable. Publication remains gated on the open gates G1–G4, not on a licence.
- **Marketplace packaging.** The package now carries its own `LICENSE.txt` plus `SUPPORT.md` and `SECURITY.md`, so the listing shows a licence and the routes for reporting a problem or a vulnerability.
- **Carried forward from 0.3.10:** the optional Marketplace update check (one bounded HTTPS GET, at most once a day, switchable with `researchStack.checkForUpdates`) and the operator-reviewed problem report that redacts personal facts before you send anything.

**What this release does not claim.** No Toolkit write has been executed against a real Zotero library; the write path is proven against an emulated loopback server and over the real MCP transport. G1–G4 remain open, and reference-host installation, Extension Host and rendered-window receipts are still outstanding. Vector search, embeddings, DuckDB/Qdrant integration and notebook kernel setup are not provided. Scanned documents need OCR outside the Toolkit.

Earlier releases are recorded in the [changelog archive](CHANGELOG-archive.md), which holds the detailed notes for 0.2.0 through 0.3.12.
