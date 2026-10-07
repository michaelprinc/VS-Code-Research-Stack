# Phase 1 acceptance plan

Revision: 0.1.0. Fixture content is synthetic and created by the test code; no private source corpus is included.

| Scenario | Verification | Evidence / result |
|---|---|---|
| T1-01 | Run inspect; verify no credentials/config writes | Gate report |
| T1-02 | Create Python 3.12 locked venv; inspect effective versions | Setup receipt |
| T1-03 | Initialize a Unicode/space path twice with user-owned files | Workspace fixture test |
| T1-04 | Extract synthetic DOCX paragraph/table; classify blank/scanned PDF | Document fixture tests |
| T1-05 | Create report with citations; reject overwrite; source hashes remain stable | Document checks |
| T1-05b | Create a user-selected NotebookLM handoff folder; verify copied source hashes and no upload/network call | Bundle fixture test |
| T1-06 | Discover and call both tools through actual VS Code/Copilot chat | Not tested; account/host interaction required |
| T1-07 | Verify local Git detection; test selected GitHub repo read/revoked auth | Local detection only; remote route not implemented |
| T1-08 | Repeat locked environment sync and workspace init | Repeat run; interruption recovery remains untested |
| T1-09 | Attempt traversal and symlink escape; reject output overwrite and oversized limits | Path/document fixture tests |
| T1-10 | Use paths with spaces/Unicode and avoid environment dumps/secrets | Workspace fixture; code inspection |

Do not close G1 until the actual host invocation and second clean reference environment are verified or explicitly removed from mandatory scope through a reviewed decision.
