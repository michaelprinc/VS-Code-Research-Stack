# Zotero local integration

Read bibliography metadata and prepare reviewed manual RIS import.

## Setup

Install Zotero separately. Reading needs no account and no API key: the adapter uses loopback localhost:23119/api and read-only operations. If a read returns 403, enable the local API in Zotero under Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"; the Toolkit never changes that setting for you. Manual RIS import is a separate user action.

## First task and readiness

Open Research Toolkit → Integrations & Accounts and run Check integrations. The Toolkit detects whether Zotero is installed, whether it answers, and whether its local API is refused, and remembers that decision for every workspace in this VS Code profile — it does not repeat the guide in a second project. A configured Zotero that is not running is reported as "not answering", not as "not installed".

## Troubleshooting and limits

Diagnostics makes no request until you press Check integrations, so "not checked yet" does not mean absent. The current official guide says local read requests need no authentication; Zotero 10 write requests use a separate local key and a consent dialog. This adapter performs reads only — it never writes to Zotero and never accepts a write consent on your behalf. A 403 means the local API is off, not that Zotero is missing; a refused connection means Zotero is not running. Review version-specific instructions before attempting any separate write integration.

## Current documentation

[Current official documentation](https://www.zotero.org/support/dev/web_api/v3/local_api). Local onboarding reviewed on 8 November 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
