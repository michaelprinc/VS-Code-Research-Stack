# Semantic Scholar

Use optional Academic Graph metadata search.

## Setup

Most public endpoints work with no account and no key. Open Research Toolkit → Integrations & Accounts, read the [API licence](https://api.semanticscholar.org/license/) and activate the service once; the Toolkit records your confirmation, its reference and its date in this VS Code profile, and never confirms the licence for you. The adapter requires SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED=true after that review and can read SEMANTIC_SCHOLAR_API_KEY from VS Code's secret storage or from your environment. That record is not a grant of rights: the licence limits the use, and some uses need separate permission from the provider.

## First task and readiness

Run Check integrations to make one bounded metadata request, then search in your research MCP client. Inspect identifiers and provider attribution, and distinguish metadata from available full text. A key is optional: add one later from the same panel if anonymous capacity is not enough, without re-running the guide.

## Troubleshooting and limits

External service does not mean installed or authorized: activation, readiness and a stored key are three separate states. Anonymous requests share one capacity and can be rate limited — a 429 is a temporary limit, it does not cancel your authorization or ask you to register again. Access keys, quotas and terms can change; consult current docs. Diagnostics makes no request until you ask for one, and local adapter presence is not service readiness.

## Current documentation

[Current official documentation](https://api.semanticscholar.org/api-docs/). Local onboarding reviewed on 8 November 2026. The bundled guide is a release snapshot; the official link opens the maintained source and may describe a newer version than your lock.

[Back to guide hub](index.md)
