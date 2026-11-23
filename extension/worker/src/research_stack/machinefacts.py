"""Machine-level integration facts: one file, one directory, no secrets and no paths (DD12-02).

A probe's classification is evidence about a moment on this machine, so it is recorded outside every
workspace and outside every profile: the same per-user application-data directory the shared provider
budget already resolves (`provider_budget.budget_directory`), one directory, one file, read by every
profile of the same OS user. The file holds only what DD12-02 allows — a provider id, whether the
application was found, a classification of what was found, the platform, the time of detection and a
non-sensitive diagnostic code — and it is replaced atomically and size-capped. A secret, a key-shaped
or token-shaped string, a workspace path, an absolute path to a user file and a Zotero library path
are refused by naming the rule they broke, never by quoting the value. Nothing here asks anything of
a network or of an application: this module reads and writes one file.

Since 0.3.15 the same file carries a second, separate section for a hosted provider: what the operator
decided about Semantic Scholar (consent, access mode, key decision) and whether the Toolkit ever reached
it. It lives in its own section and never in `facts`, because `facts` means *installation on this machine*
and a hosted API has none — the host reader (`extension/integrationprobe.js`) refuses a Semantic Scholar
entry there, and a document that tripped that refusal would take the Zotero fact down with it. A consent
instant is copied here from the record the extension carried; it is never inferred, and a process that was
not given the consent is not allowed to claim one.
"""

from __future__ import annotations

import json
import os
import platform
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable

from . import provider_budget

FACTS_FILE_NAME = "integration-facts.json"
SCHEMA_VERSION = 1
# The Toolkit's own bound on this file, stated here rather than inherited from anywhere: the document
# is five fields for the one provider that has an installation fact, plus the hosted provider's five
# decision fields, so 8 KiB is already far past what it can legitimately grow to. A write that would pass
# the bound is a defect to report — the write is refused whole and the file on disk is left exactly as it
# was. Nothing is ever truncated.
MAX_FACTS_BYTES = 8_192
# `auth-required` belongs here because it is evidence about the machine too: something answered on the Zotero
# port and asked for a credential. Leaving it out would silently discard the one fact that state carries.
CLASSIFICATIONS = ("ready", "api-disabled", "not-running", "not-installed", "auth-required", "unknown")
FACT_PROVIDERS = ("zotero", "semantic_scholar")
# Semantic Scholar is a hosted endpoint: there is no installation on this machine to record, and giving
# it a fact in the installation section would be a claim about the operator's machine that nothing observed.
# It is a provider this file states facts *about*, and those facts live in the state section below.
INSTALLATION_PROVIDERS = ("zotero",)
STATE_PROVIDERS = ("semantic_scholar",)
# The five fields the hosted-provider section may hold. `mode` is how this process was allowed to ask
# (an anonymous call against a global pool, or a call carrying a key the operator stored); `keyDecision`
# is what the operator decided about getting one, which is a different fact from whether one exists.
STATE_FIELDS = ("licenseAcknowledgedAt", "mode", "keyDecision", "lastSuccessfulCheckAt", "updatedAtMs")
STATE_MODES = ("anonymous", "keyed")
STATE_KEY_DECISIONS = ("not-offered", "guided", "provided", "declined", "removed")
MOMENT_MAX_LENGTH = 40
CODE_SHAPE = re.compile(r"[A-Z][A-Z0-9_]{0,47}")
PLATFORM_SHAPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}")
TOKEN_SHAPE = re.compile(r"[A-Za-z0-9+/=_-]{16,}")
SECRET_MARKERS = ("key", "token", "secret", "password", "passphrase", "credential", "bearer", "authorization", "apikey")
# A file name is a path in everything but its separator, and these are the ones a workspace or a
# Zotero data directory would carry. `zotero.sqlite` is the library itself: DD12-02 keeps it out.
FILE_SUFFIX_MARKERS = (".md", ".txt", ".json", ".csv", ".bib", ".ris", ".pdf", ".docx", ".ipynb", ".sqlite")
REFUSALS = {
    "FACTS_PROVIDER_REFUSED": "this provider has no machine-level installation fact to record",
    "FACTS_CLASSIFICATION_REFUSED": "the classification is not one of the words the host can read",
    "FACTS_SECRET_REFUSED": "a secret, a key-shaped string and a token-shaped string never enter the machine-level file",
    "FACTS_PATH_REFUSED": "a workspace path, an absolute path to a user file and a Zotero library path never enter the machine-level file",
    "FACTS_VALUE_REFUSED": "a value is not the shape its field requires",
    "FACTS_STATE_REFUSED": "the recorded provider decision is not one of the values this release records",
    "FACTS_TOO_LARGE": "the file would pass the Toolkit's own size bound; the write is refused, not truncated",
    "FACTS_DIRECTORY_UNAVAILABLE": "the machine-level directory could not be created or written, so the fact was not recorded",
}

_seq = 0


def facts_path(env: dict[str, str] | None = None) -> Path:
    """The one file every profile of this OS user reads: the budget's own directory, its own name."""
    return provider_budget.budget_directory(env)[0] / FACTS_FILE_NAME


def _refuse(code: str) -> dict[str, Any]:
    """A refusal is an answer, and it names the rule — never the value that broke it."""
    return {"written": False, "code": code, "rule": REFUSALS[code]}


def _rule_broken(value: str) -> str | None:
    """Which DD12-02 rule this string breaks, or None when it breaks none. The string is not returned."""
    lowered = value.lower()
    if any(marker in lowered for marker in FILE_SUFFIX_MARKERS):
        return "FACTS_PATH_REFUSED"
    if any(marker in lowered for marker in SECRET_MARKERS):
        return "FACTS_SECRET_REFUSED"
    if TOKEN_SHAPE.fullmatch(value) and any(character.isdigit() for character in value) \
            and sum(1 for character in set(lowered) if character.isalnum()) >= 8:
        return "FACTS_SECRET_REFUSED"
    if "/" in value or "\\" in value or value.startswith("~") or re.match(r"^[A-Za-z]:", value):
        return "FACTS_PATH_REFUSED"
    return None


def _valid_fact(provider: str, value: Any) -> dict[str, Any] | None:
    """One stored installation fact, or None when it is not a fact this release is allowed to state."""
    if provider not in INSTALLATION_PROVIDERS:
        return None
    if not isinstance(value, dict) or set(value) != {"found", "classification", "platform", "detectedAtMs", "code"}:
        return None
    found, classification = value["found"], value["classification"]
    host, moment, code = value["platform"], value["detectedAtMs"], value["code"]
    if not isinstance(found, bool) or classification not in CLASSIFICATIONS:
        return None
    if not isinstance(host, str) or not PLATFORM_SHAPE.fullmatch(host) or _rule_broken(host):
        return None
    # A fact dated at the epoch is not evidence about a moment, and the host reader refuses one, so this
    # reader must not accept what this writer could otherwise produce.
    if isinstance(moment, bool) or not isinstance(moment, int) or moment <= 0:
        return None
    if code is not None and (not isinstance(code, str) or not CODE_SHAPE.fullmatch(code) or _rule_broken(code)):
        return None
    return {"found": found, "classification": classification, "platform": host, "detectedAtMs": moment, "code": code}


def _valid_moment(value: Any) -> bool:
    """True when the value is nothing, or is an ISO instant short enough to state. A path, a key or a token
    is not a moment, so the field that takes a moment cannot be used to smuggle one in."""
    if value is None:
        return True
    if not isinstance(value, str) or len(value) > MOMENT_MAX_LENGTH:
        return False
    try:
        datetime.fromisoformat(value)
    except ValueError:
        return False
    return True


def _valid_state(value: Any) -> dict[str, Any] | None:
    """One hosted provider's recorded decision, or None when the record is not one this release states."""
    if not isinstance(value, dict) or set(value) != set(STATE_FIELDS):
        return None
    if value["mode"] not in STATE_MODES:
        return None
    if value["keyDecision"] is not None and value["keyDecision"] not in STATE_KEY_DECISIONS:
        return None
    if not all(_valid_moment(value[field]) for field in ("licenseAcknowledgedAt", "lastSuccessfulCheckAt")):
        return None
    if isinstance(value["updatedAtMs"], bool) or not isinstance(value["updatedAtMs"], int) or value["updatedAtMs"] <= 0:
        return None
    return {field: value[field] for field in STATE_FIELDS}


def _read_sections(env: dict[str, str] | None) -> tuple[dict[str, Any], dict[str, Any]]:
    """The file's two sections as this release can honour them; a damaged one reads as nothing was said.

    A file that is absent, unreadable, not JSON, of another schema, or whose entries do not hold the fields
    all answer the same way: no facts, no exception, and no claim about the machine. A reader cannot tell a
    refused read from a machine on which nothing was ever detected, which is the honest direction — the file
    states nothing it did not earn.
    """
    try:
        with open(facts_path(env), "rb") as handle:
            document = json.loads(handle.read().decode("utf-8"))
    except (OSError, ValueError):
        return ({}, {})
    if not isinstance(document, dict) or document.get("schemaVersion") != SCHEMA_VERSION:
        return ({}, {})
    recorded, states = document.get("facts"), document.get("providerState")
    facts = {} if not isinstance(recorded, dict) else {
        name: fact for name in INSTALLATION_PROVIDERS if (fact := _valid_fact(name, recorded.get(name))) is not None}
    honoured = {} if not isinstance(states, dict) else {
        name: state for name in STATE_PROVIDERS if (state := _valid_state(states.get(name))) is not None}
    return (facts, honoured)


def read_facts(env: dict[str, str] | None = None) -> dict[str, Any]:
    """The machine-level installation facts as they stand, or a well-formed document holding no facts."""
    facts, _states = _read_sections(env)
    return {"schemaVersion": SCHEMA_VERSION, "facts": facts}


def read_provider_state(env: dict[str, str] | None = None) -> dict[str, Any]:
    """What the operator decided about a hosted provider, as this machine recorded it: `{}` when nothing was.

    This is the section that answers the question an environment variable cannot: whether the consent exists
    on this machine at all, independently of whether the process doing the asking was given the switch.
    """
    _facts, states = _read_sections(env)
    return states


def _write_sections(facts: dict[str, Any], states: dict[str, Any], provider: str, env: dict[str, str] | None) -> dict[str, Any]:
    """Replace the whole document atomically, or refuse whole: a section is never written by cutting another."""
    document: dict[str, Any] = {"schemaVersion": SCHEMA_VERSION, "facts": facts}
    if states:
        document["providerState"] = states
    payload = (json.dumps(document, indent=2, ensure_ascii=True) + "\n").encode("utf-8")
    if len(payload) > MAX_FACTS_BYTES:
        return _refuse("FACTS_TOO_LARGE")
    global _seq
    _seq += 1
    path = facts_path(env)
    temp = Path(f"{path}.{os.getpid()}-{_seq}.tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(temp, "xb") as handle:
            handle.write(payload)
        os.replace(temp, path)
    except OSError:
        temp.unlink(missing_ok=True)
        return _refuse("FACTS_DIRECTORY_UNAVAILABLE")
    return {"written": True, "provider": provider, "path": str(path), "bytes": len(payload)}


def write_fact(provider: str, *, found: bool, classification: str, platform: str, detected_at_ms: int,
               code: str | None, env: dict[str, str] | None = None) -> dict[str, Any]:
    """Record one provider's installation fact by atomically replacing the whole document, or refuse and say why.

    The refusal is the returned answer, not a raised error: `{"written": False, "code": ..., "rule": ...}`
    names the rule the value broke and quotes no part of the value. A document that would pass
    `MAX_FACTS_BYTES` is refused whole, the file on disk is left as it was, and nothing is truncated. The
    hosted-provider section travels through the write unchanged: an installation fact is not a licence to
    rewrite what the operator decided about a hosted provider.
    """
    if provider not in FACT_PROVIDERS:
        return _refuse("FACTS_PROVIDER_REFUSED")
    if provider not in INSTALLATION_PROVIDERS:
        return _refuse("FACTS_PROVIDER_REFUSED")
    if classification not in CLASSIFICATIONS:
        return _refuse("FACTS_CLASSIFICATION_REFUSED")
    for value in (platform, code):
        if value is None:
            continue
        if not isinstance(value, str):
            return _refuse("FACTS_VALUE_REFUSED")
        if (rule := _rule_broken(value)) is not None:
            return _refuse(rule)
    if not isinstance(found, bool):
        return _refuse("FACTS_VALUE_REFUSED")
    if isinstance(detected_at_ms, bool) or not isinstance(detected_at_ms, int) or detected_at_ms <= 0:
        return _refuse("FACTS_VALUE_REFUSED")
    if not isinstance(platform, str) or not PLATFORM_SHAPE.fullmatch(platform):
        return _refuse("FACTS_VALUE_REFUSED")
    if code is not None and not CODE_SHAPE.fullmatch(code):
        return _refuse("FACTS_VALUE_REFUSED")
    facts, states = _read_sections(env)
    facts[provider] = {"found": found, "classification": classification, "platform": platform,
                       "detectedAtMs": int(detected_at_ms), "code": code}
    return _write_sections(facts, states, provider, env)


def write_state(provider: str, *, mode: str, updated_at_ms: int, license_acknowledged_at: str | None = None,
                key_decision: str | None = None, last_successful_check_at: str | None = None,
                env: dict[str, str] | None = None) -> dict[str, Any]:
    """Record a hosted provider's consent, access mode, key decision and last successful check, or refuse.

    A value this process was not told keeps whatever an earlier process recorded: a decision an operator made
    is not erased by a process that knows nothing about it, and a consent instant is never invented to fill a
    gap. `mode` is required because a process that cannot say how it was allowed to ask has no business
    writing this section. Nothing here can hold a credential — the fields are a mode, a decision, two ISO
    instants and a millisecond stamp, and a value outside those shapes is refused.
    """
    if provider not in STATE_PROVIDERS:
        return _refuse("FACTS_PROVIDER_REFUSED")
    if mode not in STATE_MODES:
        return _refuse("FACTS_STATE_REFUSED")
    if key_decision is not None and key_decision not in STATE_KEY_DECISIONS:
        return _refuse("FACTS_STATE_REFUSED")
    if not all(_valid_moment(value) for value in (license_acknowledged_at, last_successful_check_at)):
        return _refuse("FACTS_VALUE_REFUSED")
    if isinstance(updated_at_ms, bool) or not isinstance(updated_at_ms, int) or updated_at_ms <= 0:
        return _refuse("FACTS_VALUE_REFUSED")
    facts, states = _read_sections(env)
    held = states.get(provider) or {field: None for field in STATE_FIELDS}
    states[provider] = {"licenseAcknowledgedAt": license_acknowledged_at or held["licenseAcknowledgedAt"],
                        "mode": mode, "keyDecision": key_decision if key_decision is not None else held["keyDecision"],
                        "lastSuccessfulCheckAt": last_successful_check_at or held["lastSuccessfulCheckAt"],
                        "updatedAtMs": int(updated_at_ms)}
    return _write_sections(facts, states, provider, env)


def record_zotero(result: dict[str, Any], *, now_ms: Callable[[], float] = time.time) -> dict[str, Any]:
    """The classification a Zotero probe already reached, as the machine-level fact it produced."""
    return write_fact("zotero", found=bool(result.get("installed")),
                      classification=str(result.get("outcome") or "unknown"), platform=platform.system(),
                      detected_at_ms=int(now_ms() * 1000), code=result.get("code"))


def record_probe_fact(probe: Callable[[], dict[str, Any]]) -> Callable[[], dict[str, Any]]:
    """Wrap a probe so the classification it reached also lands in the machine-level file (DD12-02).

    The probe's own answer is returned untouched. A refused fact never reaches the caller and never
    fails the probe: the fact is a copy of what was already reported, not a step the probe can trip on.
    """
    def run() -> dict[str, Any]:
        result = probe()
        record_zotero(result)
        return result

    return run
