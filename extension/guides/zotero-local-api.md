# Zotero local integration

Read bibliography metadata and prepare reviewed manual RIS import.

## Setup

Install Zotero separately and enable its local API using instructions for your version. The adapter uses loopback localhost:23119/api and read-only operations. Manual RIS import is a separate user action.

## First task and readiness

Run Zotero, start the research adapter and request a small local bibliography read. Confirm intended entries and review generated RIS before importing through Zotero UI.

## Troubleshooting and limits

Diagnostics does not scan Zotero or contact its endpoint, so Not verified does not mean absent. The current official guide says local read requests need no authentication; Zotero 10 write requests use a separate local key. This adapter performs reads only. Check that the local API is enabled if a read returns 403. Review version-specific instructions before attempting any separate write integration.

## Current documentation

[Current official documentation](https://www.zotero.org/support/dev/web_api/v3/local_api). Local onboarding reviewed on 11 October 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
