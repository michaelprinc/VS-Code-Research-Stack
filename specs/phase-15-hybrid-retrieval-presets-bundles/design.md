# Phase 15 design (0.3.14)

Decisions DD15-01…DD15-05 are in [spec.md](spec.md). This file records how the four packages fit
together and the boundaries each one must not cross. It is written before the packages land so that
a reviewer can tell whether what landed is what was designed.

## 1. Retrieval inside the store (P2)

**Why no external service.** G3's named candidates are Qdrant, an embedding model and DuckDB. All
three are `kind: "planned"` in `components.json`, and installing any of them means the Toolkit ships
an installer for a component it has not reviewed. The requirement the operator actually has is
retrieval that is better than pure BM25 for a passage they half-remember, computed on their own
machine, with the same provenance guarantees. A deterministic hashing backend satisfies that without
a new dependency, without a download, and without a network capability in the payload.

**Backend contract.** A named backend (`BACKEND_ID`, `EMBEDDING_DIMENSIONS`) produces a fixed-length,
L2-normalised vector from the stored chunk text. Every stored vector records the backend id, the
dimension, and the hash of the text it was made from. A vector whose backend id, dimension or text
hash does not match is *stale*: retrieval refuses to use it and names the verb that rebuilds it
(HR-04, HR-06). This is what makes a backend change a re-index instead of a silent mismatch.

**Honest limits.** A hashing backend is a lexical-signature model. It catches morphological and
spelling-variant overlap BM25 misses; it does not know that "hypokalemia" and "low serum potassium"
are the same clinical idea. The module docstring, `store_status` and `lab-state.json` must all say
this, and no document may call it semantic search.

**Fusion.** Retrieval modes are `lexical`, `vector`, `hybrid`. `lexical` is byte-compatible with the
0.3.13 output. `hybrid` is a deterministic fusion (reciprocal-rank fusion of the two rank lists plus
a normalised score blend) and every hit names both contributions. A fused score is a ranking device,
not a probability, and the response says so.

**lab-state.json becomes derived.** It is written by the store after every store-writing verb, from a
SELECT over the DB, and it carries `derived: true`, the counters, the retrieval state and
`refreshedAt`. `store_status` answers the same numbers from the same query. A reader can still verify
it directly — that is the point of HR-05, which closes the "the numbers happen to match today"
problem in the operator's report.

## 2. Presets and the tool surface (P5)

**The 0.3.13 mistake.** A preset carried a whole third-party *server* as one estimated number, and
the toolkit cap of 12 forced the lab verbs out of the wide presets, so the widest preset offered the
assistant GitHub and Playwright but no way to touch the research store. Two defects, one cause: the
preset described servers instead of describing the goal.

**0.3.14 shape.**

```jsonc
{
  "id": "research-max-github-limited",
  "goal": "…",
  "tools": [ /* exact toolkit verbs, ≤ 20 */ ],
  "thirdParty": [
    {
      "id": "github-limited",
      "label": "GitHub MCP, read-only selection",
      "server": "https://api.githubcopilot.com/mcp/",
      "toolsets": ["context", "repos", "issues", "pull_requests"],
      "tools": ["search_repositories", "get_file_contents", /* exact names */],
      "toolsEstimate": 18,             // = tools.length, derived, not asserted
      "readOnly": true
    }
  ]
}
```

- `toolsEstimate` is **derived from the list length**, so a preset cannot claim more tools than it
  names. Vendor-published counts are kept only as a note, never as the preset's own number.
- The budget rule becomes: toolkit verbs ≤ 20, `toolkitTools + thirdPartyTools ≤ 108`
  (128 − the ≥20 headroom rule), and the ceiling/headroom tests are re-pinned, not deleted.
- Tool selection for Copilot is a **separate, explicit act**: a command writes the chosen selection
  (server entry + its toolset/tool allow-list, in the shape the editor reads) into the workspace's
  MCP configuration after showing what it will write, and refuses to overwrite a file it did not
  write. It installs nothing and never puts a token in a workspace file.
- The Toolkit's own servers keep the 0.3.11 rule: `RESEARCH_STACK_TOOL_PRESET` gates registration,
  an unknown preset is refused, and `all` remains the unmanaged escape hatch.

## 3. Bundles: force update, archive, restore (P3)

Three invariants, in this order:

1. **Nothing is lost silently.** Every file an overwrite is about to replace is copied into an
   immutable archive first. The copy happens before the `wx`-safe staged write, so a crash leaves the
   operator with both the archive and the original file.
2. **The archive is a record, not a backup system.** `.research-toolkit/bundles/archive/<bundleId>/
   <stamp>/` holds the bytes plus `archive.json` (which catalog hash the file was being replaced
   *by*, so an archive is traceable to the reviewed version that displaced it). `archive/index.json`
   and `archive/archive.log` name every archive, the log stating the absolute path. Nothing is
   deleted, so "keep every version" costs disk the operator can see and prune themselves.
3. **A restore is also an overwrite.** Restoring an archived version archives whatever it replaces,
   with reason `restore`. Ownership by another bundle is still refused: that is not a force question.

## 4. Integration bounds (P4)

`researchStack.integrationTimeoutMs` and `researchStack.integrationCooldownSeconds` exist as settings
whose defaults are the numbers 0.3.13 already ran with, clamped to a stated range, resolved in one
place, and handed to both the probe call and the model's cooldown check. The test renegotiation is
the point: a test may no longer pin a literal while a setting can change the value — it pins that the
value used is the value published.

## 5. Cross-package boundaries

- `extension/extension.js` is edited by P3 (bundle commands), P4 (integration region) and P5 (preset
  region / MCP provider). P5 goes last and re-reads the file before editing.
- `extension/package.json`: P4 owns the configuration properties, P5 owns the preset enum, P8 owns
  the version.
- `src/research_stack/presets.py` and `extension/presets.json` are P5 only; P2 reports its new verb
  names to P5 instead of editing them.
- The network capability must not move: `reviewedNetworkBoundary` still names `extension/updates.js`
  as the only packaged JavaScript member with outbound capability. P5's MCP-config writing is a
  workspace file write, not a socket.
