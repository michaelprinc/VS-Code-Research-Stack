# Fixture 09 — Citation export rules (synthetic text)

Stored claims become report references only when their evidence resolves to a stored chunk. A reference names the
source path, the locator and the hash of the chunk text that was cited, so a later reader can reopen the same version.

Evidence that a source re-index retired is reported as stale rather than dropped: the claim keeps the link, and the
export counts the reference as excluded. An unverified source is reported separately from a verified one.

The export never invents a locator. If the chunk no longer resolves, the reference is listed as unresolved and the
claim is exported without that evidence.
