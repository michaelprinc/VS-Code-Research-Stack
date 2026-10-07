# Phase 4 tasks — package integrity and scalability preview

Revision: 0.2.0-preview.

| ID | Work | Evidence | State |
|---|---|---|---|
| M4P-01 | Define a bounded VSIX preview scope and host/package targets | `specs/phase-4/{spec,design,tasks,acceptance}.md` | Complete for preview; G4 scope remains open |
| M4P-02 | Create lazy readiness and package-preference commands | `extension/vsix-manifest.json`, `extension/extension.js` | Implemented; selection only |
| M4P-03 | Pin exact packaging/test tools and audit dependency closure | `extension/package-lock.json`, npm audit receipt | Implemented; rebuild checks required |
| M4P-04 | Build allow-listed VSIX and verify exact payload/hash/size | `dist/research-stack-toolkit-0.2.0.vsix`, package audit receipt | Complete for preview |
| M4P-05 | Install exact artifact in a disposable VS Code profile | isolated extension listing/installation receipt | Complete for Windows reference host |
| M4P-06 | Exercise all package selections, persistence across Extension Host restart and responsiveness | host test output | Complete for Windows reference host |
| M4P-07 | Rerun Phase 1–3 tests and document open G1–G3 blockers | 31 Python tests passed; gate report | Complete for preview; G1–G3 remain open |
| M4P-08 | Commit source/docs/receipts; verify clean remote main | Git commit and `ls-remote` | Complete for this preview revision |

## Follow-on work before full Phase 4

1. Close G1–G3 or narrow advertised profiles to those with verified receipts.
2. Resolve license and publisher identity; test minimum/current Stable on clean Windows and macOS.
3. Wire tested profile resolver, secure configuration/SecretStorage, MCP definition provider and workspace ownership/merge behavior.
4. Add setup preview/journal/cancellation/repair and actual component installation adapters only for locked recipes.
5. Add signed/trusted update inputs, staged updates, migration and failed-update recovery.
6. Verify exact release VSIX on clean hosts, multi-window/workspace concurrency, accessibility, data preservation and update/recovery scenarios before G4.
