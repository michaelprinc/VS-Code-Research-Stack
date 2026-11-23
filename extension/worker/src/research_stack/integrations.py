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
import re
import shutil
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import machinefacts, research
from .research import ResearchError

PROBE_PROVIDERS = ("zotero", "semantic_scholar")
API_KEY_ENV = "SEMANTIC_SCHOLAR_API_KEY"
LICENSE_ENV = "SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED"
# Two carry-alongs the extension may add to the same call (0.3.15): the instant the operator's confirmation
# was recorded, and what they decided about a key. Both are values the panel already holds and neither is a
# credential; a value that is not an ISO instant or not a known decision is dropped, never guessed at.
LICENSE_INSTANT_ENV = "SEMANTIC_SCHOLAR_LICENSE_ACKNOWLEDGED_AT"
KEY_DECISION_ENV = "SEMANTIC_SCHOLAR_KEY_DECISION"
# The four answers to "why was nothing asked of this provider", named instead of collapsed into one boolean.
# The collapse is what produced the wrong field conclusion on 21 November 2026 and the correction on 22
# November: `PROVIDER_TERMS_NOT_ACKNOWLEDGED` was raised on a machine where the operator had already consented
# in the panel, because the only evidence the worker had was a variable the panel sets in the process it
# launches. A stored consent and a missing switch have different next steps. The gate itself stays where it is
# — `research.py` refuses the request when the switch is absent — and this module only names which situation
# that refusal actually was.
TERMS_STATES = ("PROVIDER_TERMS_ACKNOWLEDGED", "PROVIDER_TERMS_ACKNOWLEDGED_BY_SWITCH_ONLY",
                "PROVIDER_TERMS_STORED_BUT_NOT_INJECTED", "PROVIDER_TERMS_NOT_ACKNOWLEDGED")
# What the provider is like to this operator in practice, which is not the same question as "which HTTP
# status came back": authorised, anonymous, no key taken, and no check ever reached the service.
ACCESS_STATES = ("awaiting-consent", "consent-stored-not-injected", "usable", "rate-limited",
                 "consented-but-unusable", "unchecked")
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
# The sentence for the case the old wording got wrong. It names the record, names what this process did not
# get, and sends the operator to the path that carries it — not back to a confirmation they already gave.
_S2_STORED_NOT_INJECTED = ("Your confirmation of the Semantic Scholar agreements is recorded on this machine, but this check ran in a process "
                           "that was not given that confirmation, so nothing was asked of the provider. Check integrations from the Toolkit's "
                           "own card, which is the path that carries your confirmation to the worker. Nothing needs to be confirmed again, "
                           "and no key was read.")
# Added to a refusal when the whole picture says "allowed to ask, never reached": anonymous mode, no key
# taken, no successful check on this machine. The 429 alone reads as a pause; this is the part that says
# the pause is what an anonymous pool does to an operator who declined a key.
_S2_UNUSABLE = (" The check was authorised and still did not reach the service. The Toolkit asks anonymously, where every unauthenticated "
                "caller shares one global pool, your record shows no key was taken, and no check has reached this provider on this machine "
                "yet. Your confirmation stands unchanged; a key is the step that changes the answer.")
# Confirmed 8 November 2026 from https://www.zotero.org/support/dev/web_api/v3/local_api, which names this setting
# and states that requests return 403 Forbidden without it. No other Zotero setting is named in this module.
ZOTERO_LOCAL_API_SETTING_TEXT = ("The local API must be enabled in Zotero's preferences (Settings → Advanced → "
                                 "'Allow other applications on this computer to communicate with Zotero'); "
                                 "requests return 403 Forbidden if it is not enabled.")
_ZOTERO_REFUSING = ("api-disabled", "Zotero appears to be running but refuses local clients. " + ZOTERO_LOCAL_API_SETTING_TEXT)
# A refused connection is not the same fact as Zotero being absent: Zotero opens this port late in its startup,
# and when another program already holds 23119 it starts no HTTP server at all. Both readings are named.
_ZOTERO_NOT_RUNNING = ("not-running", "Zotero was found on a documented path, but nothing answered at 127.0.0.1:23119, the connector ping included. Zotero opens that port late in its startup, and starts no HTTP server at all when another program already holds it, so this is not proof that Zotero is absent.")
_ZOTERO_ABSENT = ("not-installed", "Nothing answered at 127.0.0.1:23119, the connector ping included, and no Zotero was found on a documented path. A Zotero that is still starting answers nothing on that port yet, so this reports that no evidence of Zotero was found, not that Zotero is absent.")
# Which stage got no answer, said as the stage: a stage that answers nothing names what the Toolkit does not know.
_ZOTERO_SILENT = {"root": f"the documented root request produced no usable answer within {research.ZOTERO_ROOT_TIMEOUT_SECONDS} seconds",
                  "head": f"the path check produced no usable answer within {research.ZOTERO_ROOT_TIMEOUT_SECONDS} seconds",
                  "listing": f"the collection listing produced no usable answer within {research.ZOTERO_LISTING_TIMEOUT_SECONDS} seconds"}
_ZOTERO_STILL_LOADING = (" The same request was asked a second time and produced none either: Zotero answers the local API only after the library has finished loading, so a Zotero still loading its library answers nothing to this request.")
# The same page states that read requests require no authentication, and that `/api/` should be requested first
# so the answer can be read before any other path is tried. A 401 on a read is therefore not a missing credential.
_ZOTERO_PREFIX = ("Something answered at 127.0.0.1:23119, but ",
                  "Zotero's local API answered at /api/, so the local API is enabled and a Zotero is running, but ")
_ZOTERO_DEFAULT = ("unknown", "the request was answered and nothing useful came back, so which state applies is unknown.")
# What an answer means, as a clause that reads after either prefix above. Naming the answer is the point: a 404,
# a 401 and a body this release cannot read are three different things to an operator, and used to be one sentence.
_ZOTERO_CLAUSES = {
    "ZOTERO_AUTH_REQUIRED": ("auth-required", "the answer was 401, asking for authentication. A read request needs no authentication, so this is not a missing credential: the Toolkit sends none for this read and has no place to keep one."),
    "ZOTERO_NOT_FOUND": ("unknown", "it did not recognise this request, which is a different fact from Zotero being absent; which state applies is unknown."),
    "ZOTERO_SCHEMA_UNEXPECTED": ("unknown", "the answer was not the JSON the local API returns, so which state applies is unknown."),
    "ZOTERO_REQUEST_REJECTED": ("unknown", "it answered 400 and rejected the request itself, which is a fact about this request and not about Zotero being absent; which state applies is unknown."),
    "ZOTERO_REQUEST_NOT_ALLOWED": ("unknown", "it refused the request as one that looks like a browser request. No Zotero setting needs changing for this answer, and which state applies is unknown."),
    "ZOTERO_API_VERSION_UNSUPPORTED": ("unknown", "it answered 501, that the API version this request asked for is not implemented; which state applies is unknown."),
}
_KEY_SHAPED = re.compile(r"[A-Za-z0-9+/=_-]{16,}")
_PATH_SHAPED = re.compile(r"[A-Za-z]:[\\/]\S*|(?:/[A-Za-z0-9_.-]+){2,}")


def _key_shaped(match: re.Match[str]) -> str:
    """A run is key-shaped on the same rule `machinefacts` uses: a long run that carries a digit."""
    return "[redacted]" if any(character.isdigit() for character in match.group()) else match.group()


def _scrub(value: object, limit: int) -> str | None:
    """One short line for the receipt: whitespace flattened, key-shaped runs and file paths taken out."""
    if not isinstance(value, str):
        return None
    text = _PATH_SHAPED.sub("[path]", _KEY_SHAPED.sub(_key_shaped, re.sub(r"\s+", " ", value).strip()[:limit]))
    return text or None


def _answered(root: dict[str, object], head: dict[str, object] | None = None) -> str:
    """What the cheap stages said, kept as their own headers say it: the status, the API version, the server id."""
    seen = [f"root {root.get('status')}"]
    seen += [f"{name} {root[key]}" for name, key in (("Zotero-API-Version", "zotero-api-version"), ("Zotero-Server-ID", "zotero-server-id")) if root.get(key)]
    if head is not None:
        seen.append(f"HEAD {head.get('status')}")
    return " ".join(seen)


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


def _zotero_state(exc: ResearchError, root: dict[str, object] | None, stage: str, head: dict[str, object] | None = None, retried: bool = False) -> dict[str, object]:
    """The state the evidence supports, with what the server actually said attached.

    `root` is None when the documented root got no answer at all, which is the only case the connector ping is
    owed: the ping answers whatever the local-API preference says, so it is what separates a Zotero whose HTTP
    server is up from a port that answers nothing. A 403 is itself an answer, so it never owes a request. Once
    the root answered, the preference is on and a Zotero is running, so a later request that was not accepted is
    neither "not installed" nor "the preference is off".
    """
    if root is None and exc.code in ("ZOTERO_NOT_AVAILABLE", "ZOTERO_NO_ANSWER"):
        if research.zotero_connector_ping():
            installed, outcome = True, "unknown"
            text = ("The connector endpoint answered, so a Zotero is running and its HTTP server is up, but "
                    + _ZOTERO_SILENT[stage] + ", so which state applies is unknown.")
        else:
            installed = detect_zotero_installation()["installed"]
            outcome, text = _ZOTERO_NOT_RUNNING if installed else _ZOTERO_ABSENT
    elif exc.code == "ZOTERO_NO_ANSWER":
        installed, outcome = True, "unknown"
        text = _ZOTERO_PREFIX[1] + _ZOTERO_SILENT[stage] + ", so which state applies is unknown." + (_ZOTERO_STILL_LOADING if retried else "")
    elif exc.code == "ZOTERO_API_DISABLED":
        installed = True
        if root is None:
            outcome, text = "api-disabled", _ZOTERO_REFUSING[1]
        else:
            # The documented root answered, so the preference is on: a 403 on a later path cannot be read as
            # the setting being off, and telling the operator to change it would send them to the wrong place.
            outcome, text = "unknown", _ZOTERO_PREFIX[1] + "a later request was refused with 403, so which state applies is unknown."
    else:  # an answer on the Zotero port is evidence of an installation
        installed = True
        outcome, clause = _ZOTERO_CLAUSES.get(exc.code, _ZOTERO_DEFAULT)
        text = _ZOTERO_PREFIX[1 if root is not None else 0] + clause
    seen = " ".join(part for part in (root and _answered(root, head), exc.evidence) if part)
    return {"outcome": outcome, "code": exc.code, "installed": installed,
            "serverId": _scrub((root or {}).get("zotero-server-id"), 120), "evidence": _scrub(seen, 160),
            "detail": text + _NOT_WRITING}


@machinefacts.record_probe_fact
def probe_zotero() -> dict[str, object]:
    """Three stages from cheap to expensive, and one retry of the one stage that pays for the library load.

    `/api/` first, as the official local API page directs: a 403 there is the documented answer for the
    local-API preference being off, and a 200 there proves the preference is on and that a Zotero is answering,
    whatever a later path then does. Then `HEAD /api/users/0/collections`, which Zotero answers before it
    consults that preference, so it says the path is registered and the Host header was accepted. Then the
    listing, which is what proves the library can be read. The listing is the only stage asked twice, and only
    when it got no answer at all: Zotero's local API waits for the library to finish loading before it answers,
    so the first request is the one that pays for a library that is still loading and the second is the cheap
    one. No other stage is repeated, and the connector ping stays the last fallback, asked only when a stage got
    no answer. The receipt carries the status and a clipped line of what the server said, so a report from
    another machine says which answer Zotero gave instead of leaving the cause to be guessed.

    The worst case is 34 seconds of request time: 5 for the root, 5 for the path check, 12 and 12 for the
    listing and its one retry. The 3 second ping is only reached on the short path where the root itself got no
    answer, which costs 5 plus 3, and it is never asked after the listing has been retried — by then the answer
    is already known. Each bound limits one request, not the whole check, so the host's own process bound is
    what guarantees a receipt arrives at all; it is set above 34 seconds so a slow Zotero is reported, not killed.
    """
    try:
        root = research.zotero_local_api_root()
    except ResearchError as exc:
        return _zotero_state(exc, None, "root")
    try:
        head = research.zotero_collections_head()
    except ResearchError as exc:
        return _zotero_state(exc, root, "head")
    try:
        listing, attempts = research.list_zotero_collections(), 1
    except ResearchError as exc:
        if exc.code != "ZOTERO_NO_ANSWER":
            return _zotero_state(exc, root, "listing", head)
        # One retry, of this stage only, and only because it got no answer: the first request is the one that
        # waits for the library to load, so asking the same listing once more is the cheap question.
        try:
            listing, attempts = research.list_zotero_collections(), 2
        except ResearchError as again:
            return _zotero_state(again, root, "listing", head, retried=True)
    collections = listing.get("collections") or []
    loaded = f" The first attempt got no answer within {research.ZOTERO_LISTING_TIMEOUT_SECONDS} seconds and the second answered, which is what a library that was still loading looks like." if attempts == 2 else ""
    if collections:
        head_text = f"Zotero's local API answered: the read-only collection listing succeeded with {len(collections)} collection(s)." + loaded
    else:
        # An empty library is a working library: the listing succeeded, there is simply nothing in it yet.
        head_text = "Zotero's local API answered: the read-only collection listing succeeded and returned no collections, which is a working empty library, not a failure." + loaded
    return {"outcome": "ready", "code": None, "installed": True, "serverId": _scrub(listing.get("serverId"), 120),
            "evidence": _scrub(_answered(root, head), 160), "detail": head_text + _NOT_WRITING}


def _terms_state(switch: bool, stored: dict[str, Any], carried: str | None = None) -> str:
    """Which of the four consent situations this process is actually in, as one named state.

    `switch` is what this process was handed; `stored` is what this machine recorded; `carried` is the instant
    the extension handed over with the switch. Reading only the first is the defect the 21 November report
    fell into — an environment variable is a switch, not proof that the operator agreed, and its absence is
    not proof that they refused.
    """
    if switch and (stored.get("licenseAcknowledgedAt") or carried):
        return "PROVIDER_TERMS_ACKNOWLEDGED"
    if switch:
        return "PROVIDER_TERMS_ACKNOWLEDGED_BY_SWITCH_ONLY"
    if stored.get("licenseAcknowledgedAt"):
        return "PROVIDER_TERMS_STORED_BUT_NOT_INJECTED"
    return "PROVIDER_TERMS_NOT_ACKNOWLEDGED"


def _carried_instant() -> str | None:
    """The consent instant the extension carried, or nothing. A value that is not an ISO instant is dropped."""
    value = (os.environ.get(LICENSE_INSTANT_ENV) or "").strip()
    if not value or len(value) > machinefacts.MOMENT_MAX_LENGTH:
        return None
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return None
    return value


def _carried_decision() -> str | None:
    """The key decision the extension carried, or nothing. A word the panel does not record is dropped."""
    value = (os.environ.get(KEY_DECISION_ENV) or "").strip()
    return value if value in machinefacts.STATE_KEY_DECISIONS else None


def _record_s2_state(terms: str, mode: str, stored: dict[str, Any], reached: bool, carried: str | None) -> dict[str, Any]:
    """Copy what this process was told and what it measured into the machine-level file, or write nothing.

    The consent instant is recorded only for a consent the extension handed to this process: the Toolkit
    records a decision it was given, never one it inferred, and never on the operator's behalf — the switch
    stays deliberate, and `authorizeSemanticScholar` in the panel still refuses to record anything without
    the operator's own confirmation. When neither happened, no state is written and no earlier state is
    rewritten, so a process that knows nothing cannot erase what an operator decided.
    """
    authorised = terms in ("PROVIDER_TERMS_ACKNOWLEDGED", "PROVIDER_TERMS_ACKNOWLEDGED_BY_SWITCH_ONLY")
    if not authorised and not reached:
        return stored
    machinefacts.write_state("semantic_scholar", mode=mode, updated_at_ms=int(time.time() * 1000),
                             license_acknowledged_at=carried if terms == "PROVIDER_TERMS_ACKNOWLEDGED" else None,
                             key_decision=_carried_decision(),
                             last_successful_check_at=datetime.now(UTC).isoformat() if reached else None)
    return machinefacts.read_provider_state().get("semantic_scholar") or stored


def _access_state(terms: str, state: dict[str, Any], reached: bool, outcome: str) -> str:
    """Whether this provider is usable for this operator, said as one named state rather than as a status."""
    if terms == "PROVIDER_TERMS_NOT_ACKNOWLEDGED":
        return "awaiting-consent"
    if terms == "PROVIDER_TERMS_STORED_BUT_NOT_INJECTED":
        return "consent-stored-not-injected"
    if reached:
        return "usable"
    if state.get("lastSuccessfulCheckAt"):
        return "rate-limited"
    return "consented-but-unusable" if outcome in ("rate-limited", "unreachable", "auth-required") else "unchecked"


def probe_semantic_scholar() -> dict[str, object]:
    """Read-only Semantic Scholar readiness: named states for the gates, booleans for the credentials, never values.

    The receipt answers three questions that used to be collapsed into one: was the operator asked to agree
    and did they, was this process given that agreement, and is the provider reachable for this operator in
    practice. A `credentialConfigured`/`licenseAcknowledged` pair cannot answer the second or the third, and
    an anonymous 429 reported as a bare `rate-limited` hides the fact that the operator declined a key.
    """
    switch = os.environ.get(LICENSE_ENV, "").strip().lower() == "true"
    stored = machinefacts.read_provider_state().get("semantic_scholar") or {}
    carried = _carried_instant()
    gates = {"credentialConfigured": bool(os.environ.get(API_KEY_ENV)), "licenseAcknowledged": switch}
    mode = "keyed" if gates["credentialConfigured"] else "anonymous"
    terms = _terms_state(switch, stored, carried)
    reached = False
    try:
        result = research.search_literature("semantic_scholar", PROBE_QUERY, 1)
        records = result.get("records") or []
        reached = True
        detail = (f"Semantic Scholar answered the fixed probe query with {len(records)} record(s)."
                  if records else "The endpoint answered and returned no matching record; that is not a failure.") + _S2_SCOPE
        report: dict[str, object] = {"outcome": "ready", "code": None, "detail": detail, **gates}
    except ResearchError as exc:
        outcome, head = _S2_FAILURES.get(exc.code, _S2_DEFAULT)
        code = exc.code
        if exc.code == "PROVIDER_TERMS_NOT_ACKNOWLEDGED" and stored.get("licenseAcknowledgedAt"):
            code, head = "PROVIDER_TERMS_STORED_BUT_NOT_INJECTED", _S2_STORED_NOT_INJECTED
        report = {"outcome": outcome, "code": code, "detail": head + _S2_SCOPE, **gates,
                  **({"retryAfter": exc.retry_after} if exc.retry_after else {})}
    state = _record_s2_state(terms, mode, stored, reached, carried)
    access = _access_state(terms, state, reached, str(report["outcome"]))
    if access == "consented-but-unusable":
        report["detail"] = str(report["detail"]) + _S2_UNUSABLE
    return {**report, "termsState": terms, "accessState": access,
            "providerState": {"mode": mode, "keyDecision": state.get("keyDecision"),
                              "licenseAcknowledgedAt": state.get("licenseAcknowledgedAt"),
                              "lastSuccessfulCheckAt": state.get("lastSuccessfulCheckAt")}}


def _guarded(provider: str, probe: Callable[[], dict[str, object]]) -> dict[str, object]:
    """A readiness check must answer even when the probe itself breaks.

    Measured defect: one provider's unexpected exception destroyed the whole receipt, so the other provider
    was never checked, the worker exited non-zero, and the host reported "The integration check failed".
    A crash is recorded as its own outcome so the operator sees which provider was not answered. Only
    `Exception` is caught — `pytest.fail` and a skip are `BaseException`, so a test tripwire still trips.
    """
    try:
        return probe()
    except Exception as exc:  # noqa: BLE001 — the point of this function is that nothing escapes it
        return {"outcome": "unknown", "code": f"PROBE_{provider.upper()}_FAILED",
                "detail": f"The readiness check for {provider} stopped before it could answer ({type(exc).__name__}). "
                          "Nothing was learned about this provider from this run; the check can be run again."}


def probe_integrations(providers: str) -> dict[str, object]:
    """Probe the named providers only; one provider's failure, even an unexpected one, never fails the other."""
    requested = list(dict.fromkeys(item.strip() for item in providers.split(",") if item.strip()))
    accepted = ", ".join(PROBE_PROVIDERS)
    if not requested:
        raise ValueError(f"Name at least one provider; accepted providers: {accepted}.")
    if unknown := sorted({name for name in requested if name not in PROBE_PROVIDERS}):
        raise ValueError(f"Unknown provider(s) {', '.join(unknown)}; accepted providers: {accepted}.")
    result: dict[str, object] = {"probe": "integrations", "providers": requested}
    if "zotero" in requested:
        result["zotero"] = _guarded("zotero", probe_zotero)
    if "semantic_scholar" in requested:
        result["semanticScholar"] = _guarded("semantic_scholar", probe_semantic_scholar)
    result["warnings"] = [READ_ONLY_WARNING]
    return result
