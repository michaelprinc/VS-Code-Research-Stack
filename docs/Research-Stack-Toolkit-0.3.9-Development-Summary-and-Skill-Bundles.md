# Research Stack Toolkit 0.3.9 — DeepSeek Harness development brief

**Status:** proposed work for the LLM development agent running inside the DeepSeek Harness Docker container. The deliverable remains the **Research Stack Toolkit VS Code extension**. This document specifies work to be performed from the Harness environment; it does not claim the work is implemented, installed or released.

## Objective

Develop 0.3.9 so that users of the VS Code extension can index text-bearing PDF and DOCX documents directly into the local research database with original-document provenance, and install topic-oriented `SKILL.md` bundles through the Toolkit control panel. The first bundle is **Theological research**, based on the PoC skill already available to the Harness.

## Execution boundary and observed baseline

- Carry out code inspection, implementation, repository edits, build, tests and evidence collection as LLM-driven tasks in the existing `deepseek-harness-021rc2` container. Work in the mounted Toolkit source and use isolated fixtures and test stores. Do not confuse the development container with the user's VS Code extension host.
- At the time of this revision, the container was healthy and the Toolkit source was visible at `/data/dsh/home/Aplikovaná umělá inteligence pro sestry karmelitky/Research-Stack/toolkit`. The theology PoC exists beside the mounted project at `/data/dsh/home/Aplikovaná umělá inteligence pro sestry karmelitky/theological-research/`. Recheck actual mounts, available tools, permissions and runtime before work; do not rely on these paths as proof of permanent configuration.
- A read-only check found `/usr/bin/python3` 3.13.5 did not have `mcp`, `pypdf` or `docx` importable. This applies to that interpreter only; use a suitable isolated, project-locked environment if one is available or prepare one through the repository's documented process. Do not assume the Windows-managed worker runs inside Linux.
- Do not stop, restart, recreate or interrupt the Harness or Strata services without the user's explicit authorization. Do not alter live profiles, unrelated chat sessions, research stores or credentials as part of development.
- Existing 0.3.8 evidence: VS Code/Copilot with Qwen read a synthetic two-page PDF using the Toolkit reader. A separate MCP test verified a text-only SQLite/BM25 index, linked claims and persistence across a server restart. Direct PDF indexing returned `UNSUPPORTED_FORMAT`; source changes were not reflected in evidence freshness until reindex. These are baseline observations, not evidence that the Harness can already execute 0.3.9 workflows.

## LLM task 1 — direct PDF/DOCX ingestion

Inspect the existing document reader, corpus indexing, schema, source and evidence contracts. Implement and test direct indexing of explicitly selected workspace PDFs and DOCX files, reusing shared structured extraction rather than requiring manually prepared text. Process complete documents in bounded batches within the declared limits; a reader's per-call limit must not silently truncate indexing. Leave source files unchanged.

Record original path, source-byte SHA-256, parser/chunker identity and version, coverage and warnings. PDF chunks must map to original page numbers and extracted-text offsets; DOCX chunks must map to ordered paragraph or table-row items and offsets. Do not invent PDF line/bounding-box data or DOCX page numbers. Preserve original provenance through search, evidence resolution, claims and reports. Keep the existing Markdown/text workflow and lexical BM25 retrieval compatible.

Classify per-file outcomes as complete, partial or failed, including pages/items with no extractable text and encrypted, corrupt or oversized files. Define an explicit policy for partial acceptance; do not silently replace a good indexed version with incomplete or failed extraction. Distinguish structured application failures from MCP transport failures and report mixed-batch outcomes clearly.

## LLM task 2 — freshness, preservation and migration

Distinguish the version in the index from a source file whose present hash has actually been checked. Report changed, missing, inaccessible and unchecked sources honestly. Make reindexing and failure/cancellation behavior transactional, protect against sources changing during extraction, and preserve claim-linked older chunks as historical evidence. Exports should disclose and exclude stale or unverified references by default, with any historical inclusion explicitly labeled.

Review the current schema and migrations; implement any needed versioned, transactional migration, compatibility rules and tested backup/rollback using copies of 0.3.8 stores. Preserve existing claims, identifiers and user data. Document extracted text retained in SQLite and its backups.

## LLM task 3 — topic-based skill bundle interface

Design and implement a reviewed built-in bundle catalog and VS Code control-panel flow. Each bundle has stable identifiers, version, topic, purpose, complete skill directories, required support files and hashes, compatibility and provenance. Display the chosen workspace, exact target paths, prerequisites and per-file state before installation. The interface installs reviewed files only; it must not silently change tool presets, run model requests or connect to outside services.

Implement installation into the selected workspace's `.github/skills/<skill-id>/` with safe paths, staged verification, per-skill receipts, logs and retry/repair behavior. Preserve user-modified files and show conflicts; never treat a completed 0.3.8 overlay receipt as evidence that a new bundle is installed. Show separate statuses for files installed, host discovery verified and actual workflow tested. Define safe ownership for skills shared by multiple bundles, and do not remove user documents, claims or shared skills as a side effect.

Inspect existing explicit overlay allowlists, generated worker payload and VSIX audits before changing them. Add an upgrade path and packaging verification, including exact source-to-payload hashes. Keep existing package settings, workspaces and user preferences intact.

## LLM task 4 — include the theological research PoC

Use the actual [staged PoC theological skill](../templates/skill-bundles/theology/theological-research/SKILL.md), version 2.0, with its six reference documents and two Python scripts; its README and four evaluation scenarios are available in the source snapshot. The snapshot's 11 files were copied from the running Harness and their SHA-256 hashes matched at the time of the earlier check. Recheck before packaging.

Review the original and document all release adaptations. The PoC scripts assume a working directory and Python environment; the metadata lookup can contact Crossref/OpenAlex, and the library reference is a template, not proof of access. Verify path resolution, subprocess behavior, network disclosure and dependency availability in the actual Harness and packaged host. Treat near-duplicate bibliographic output as reviewable rather than automatically authoritative. The original directory did not include a license file; clarify redistribution terms before publishing the bundle. Bundle presence must not be presented as an assistant having used or validated it.

## LLM task 5 — container-based verification and evidence

Within the Harness container, run appropriate deterministic tests for PDF/DOCX extraction, coverage and provenance; text-index regression; persistent search and claims; changed/missing source handling; malformed and scanned inputs; interrupted updates; schema migration; and bundle catalog, installation, upgrades, collisions, user edits and source-to-package integrity. Test scripts using disposable fixtures and isolated stores, not the user's production data. Run the repository's relevant build, package and existing checks that the environment can support. Preserve command results, environment details and failures in a development report.

Where the container supports a real VS Code extension-host test, run it and report the actual host and result. A live Windows VS Code/Copilot session is **not established as accessible from the Harness container**: do not claim it was tested or pass a Windows-specific acceptance gate without evidence. Identify any required external host validation as a separate, unverified follow-up, not a completed Harness task. Likewise, confirm Harness skill discovery and MCP connectivity with a real isolated test before claiming either works.

## Definition of done

The LLM produces a reviewable 0.3.9 implementation, automated tests, package artifacts and a concise evidence report, all developed from the Harness container. The direct document workflow and theological bundle interface must be implemented together; missing prerequisites, environment limits or failing tests must be reported rather than represented as a complete release. No deployment to the live Harness or installation into the user's VS Code is implied by completing development.

OCR, scanned-image recognition, vector/embedding search, background ingestion, external account provisioning and automatic paper acquisition are not part of this 0.3.9 brief. The separately staged [theological skill](../templates/skill-bundles/theology/theological-research/SKILL.md) is source material; its presence does not mean the bundle interface has been built.
