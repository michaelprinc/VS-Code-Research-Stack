"""Bounded, read-only integration probe for Zotero and Semantic Scholar (DD11-01, DD11-09).

Runs only on an explicit operator action, through the reviewed worker boundary, reusing
``research.py``'s adapters: no network path of its own, writes no workspace file, opens no library
file, changes no configuration, and never the value of a credential or environment variable — only
whether one is present. Installation, authorization and readiness stay separate dimensions (DD11-03).
It records one machine-level fact outside the workspace via ``machinefacts`` (DD12-02): a
classification and a timestamp, never a credential.
"""

from __future__ import annotations

import os
import platform
import shutil
from pathlib import Path

from . import machinefacts, research
from .research import ResearchError

PROBE_PROVIDERS = ("zotero", "semantic_scholar")
API_KEY_ENV = "SEMANTIC_SCHOLAR_API_KEY"
LICENSE_ENV = "SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED"
PROBE_QUERY = "quantum entanglement"  # fixed query
READ_ONLY_WARNING = "The probe is read-only: it writes no workspace file and reports no credential value."
_NOT_WRITING = " No library file was opened, no workspace file was written, no configuration changed."
_S2_SCOPE = " At most one bounded metadata request (fixed query, limit 1); no full text downloaded."
_S2_DEFAULT = ("unreachable", "The provider did not answer; no result count was inferred.")
_S2_FAILURES = {
    "PROVIDER_TERMS_NOT_ACKNOWLEDGED": ("auth-required", "No request was sent; the missing step is the operator's acknowledgement of the Semantic Scholar API licence."),
    "PROVIDER_AUTH_REQUIRED": ("auth-required", "The provider refused the request; an API key may be required."),
    "PROVIDER_RATE_LIMITED": ("rate-limited", "The provider rate-limited the probe: a degraded readiness window, not a lost credential."),
}
# Confirmed 8 November 2026 from https://www.zotero.org/support/dev/web_api/v3/local_api, which names this setting
# and states that requests return 403 Forbidden without it. No other Zotero setting is named in this module.
ZOTERO_LOCAL_API_SETTING_TEXT = ("The local API must be enabled in Zotero's preferences (Settings → Advanced → "
                                 "'Allow other applications on this computer to communicate with Zotero'); "
                                 "requests return 403 Forbidden if it is not enabled.")
_ZOTERO_REFUSING = ("api-disabled", "Zotero appears to be running but refuses local clients. " + ZOTERO_LOCAL_API_SETTING_TEXT)
_ZOTERO_NOT_RUNNING = ("not-running", "Zotero was found on a documented path, but neither the local API nor the connector ping answered at 127.0.0.1:23119.")
_ZOTERO_ABSENT = ("not-installed", "Nothing answered at 127.0.0.1:23119, the connector ping included, and no Zotero was found on a documented path.")
_ZOTERO_ANSWERED = ("unknown", "Something answered at 127.0.0.1:23119, but the listing failed, so which state applies is unknown.")
_ZOTERO_NO_ANSWER = ("unknown", "The request to 127.0.0.1:23119 produced no usable answer, so which state applies is unknown; Zotero 10 drops some requests without responding.")


def detect_zotero_installation() -> dict[str, object]:
    """Report only an installation this probe found: a path is stat-ed, never run."""
    candidates = [found] if (found := shutil.which("zotero")) else []
    system = platform.system()
    if system == "Windows":
        candidates += [os.path.join(f, "Zotero", "zotero.exe") for f in map(os.environ.get, ("PROGRAMFILES", "LOCALAPPDATA")) if f]
    elif system == "Darwin":
        candidates.append("/Applications/Zotero.app")
    else:
        candidates += ["/var/lib/flatpak/app/org.zotero.Zotero", "/usr/lib/zotero/zotero", str(Path.home() / ".zotero" / "zotero")]
    for candidate in candidates:
        if Path(candidate).exists():
            return {"installed": True, "evidence": f"found at {candidate}"}
    return {"installed": False, "evidence": "no Zotero installation was found on a documented path"}


@machinefacts.record_probe_fact
def probe_zotero() -> dict[str, object]:
    """Read-only Zotero readiness: the local API is the primary evidence, the connector ping its fallback."""
    try:
        receipt = research.list_zotero_collections()
    except ResearchError as exc:
        if exc.code in ("ZOTERO_NOT_AVAILABLE", "ZOTERO_API_DISABLED"):
            # The local API call failed, so the connector ping is worth making: Zotero answers it whether or not
            # the local-API preference is on. A request that was accepted and answered badly already proves more.
            answered = research.zotero_connector_ping()
            if exc.code == "ZOTERO_API_DISABLED" or answered:
                installed, (outcome, head) = True, _ZOTERO_REFUSING  # running, and the local API is refusing
            else:
                installed = detect_zotero_installation()["installed"]
                outcome, head = _ZOTERO_NOT_RUNNING if installed else _ZOTERO_ABSENT
        elif exc.code == "ZOTERO_NO_ANSWER":  # a silent drop is a state, not a crash and not an absence
            installed, (outcome, head) = True, _ZOTERO_NO_ANSWER
        else:  # an HTTP answer on the Zotero port is evidence of an installation
            installed, (outcome, head) = True, _ZOTERO_ANSWERED
        return {"outcome": outcome, "code": exc.code, "installed": installed, "serverId": None, "detail": head + _NOT_WRITING}
    return {"outcome": "ready", "code": None, "installed": True, "serverId": receipt.get("serverId"),
            "detail": "Zotero's local API answered: the read-only collection listing succeeded." + _NOT_WRITING}


def probe_semantic_scholar() -> dict[str, object]:
    """Read-only Semantic Scholar readiness: booleans for the two gates, never values."""
    gates = {"credentialConfigured": bool(os.environ.get(API_KEY_ENV)), "licenseAcknowledged": os.environ.get(LICENSE_ENV, "").lower() == "true"}
    try:
        result = research.search_literature("semantic_scholar", PROBE_QUERY, 1)
    except ResearchError as exc:
        outcome, head = _S2_FAILURES.get(exc.code, _S2_DEFAULT)
        return {"outcome": outcome, "code": exc.code, "detail": head + _S2_SCOPE, **gates, **({"retryAfter": exc.retry_after} if exc.retry_after else {})}
    records = result.get("records") or []
    detail = (f"Semantic Scholar answered the fixed probe query with {len(records)} record(s)."
              if records else "The endpoint answered and returned no matching record; that is not a failure.") + _S2_SCOPE
    return {"outcome": "ready", "code": None, "detail": detail, **gates}


def probe_integrations(providers: str) -> dict[str, object]:
    """Probe the named providers only; one provider's failure never fails the other."""
    requested = list(dict.fromkeys(item.strip() for item in providers.split(",") if item.strip()))
    accepted = ", ".join(PROBE_PROVIDERS)
    if not requested:
        raise ValueError(f"Name at least one provider; accepted providers: {accepted}.")
    if unknown := sorted({name for name in requested if name not in PROBE_PROVIDERS}):
        raise ValueError(f"Unknown provider(s) {', '.join(unknown)}; accepted providers: {accepted}.")
    result: dict[str, object] = {"probe": "integrations", "providers": requested}
    if "zotero" in requested:
        result["zotero"] = probe_zotero()
    if "semantic_scholar" in requested:
        result["semanticScholar"] = probe_semantic_scholar()
    result["warnings"] = [READ_ONLY_WARNING]
    return result
