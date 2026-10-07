# ADR-011: Optional browser and institutional source capabilities

Date: 7 October 2026. Status: opt-in design; no capability selected; G3 pending.

## Context

Some research workflows may need browser-driven public-source review or provider-specific institutional access. These capabilities have different permissions, session handling, policy and verification requirements from the local Full core.

## Decision

Treat Playwright/browser automation and every institutional provider adapter as separate optional capabilities. Do not include authenticated browser state in general diagnostics; use a dedicated profile and user-mediated authentication. Provider adapters must use documented, entitled APIs/export paths and retain provider/source provenance. Do not automate MFA/CAPTCHA avoidance, bypass access controls or infer content-use rights from successful login. A disabled, unauthorized or unavailable connector is reported as such and does not block Full core if excluded from the support label.

## Consequences and limits

Optionality keeps the core local and reduces accidental network/session scope. It does not prove an OS sandbox, institutional entitlement, export license or provider compatibility. No browser runtime or institutional adapter is installed or selected by this decision.

## Required evidence

For each advertised capability, record immutable package/browser identity, permission and data-flow scope, a safe fixture workflow, session expiry/denial behavior, licensing/entitlement evidence and accurate degraded-state reporting.
