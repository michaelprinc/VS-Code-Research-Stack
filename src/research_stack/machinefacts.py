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
"""

from __future__ import annotations

import json
import os
import platform
import re
import time
from pathlib import Path
from typing import Any, Callable

from . import provider_budget

FACTS_FILE_NAME = "integration-facts.json"
SCHEMA_VERSION = 1
# The Toolkit's own bound on this file, stated here rather than inherited from anywhere: the document
# is five fields for the one provider that has an installation fact, so 8 KiB is already far past what
# it can legitimately grow to. A write that would pass the bound is a defect to report — the write is
# refused whole and the file on disk is left exactly as it was. Nothing is ever truncated.
MAX_FACTS_BYTES = 8_192
# `auth-required` belongs here because it is evidence about the machine too: something answered on the Zotero
# port and asked for a credential. Leaving it out would silently discard the one fact that state carries.
CLASSIFICATIONS = ("ready", "api-disabled", "not-running", "not-installed", "auth-required", "unknown")
# Semantic Scholar is a hosted endpoint: there is no installation on this machine to record, and giving
# it a fact would be a claim about the operator's machine that nothing observed.
FACT_PROVIDERS = ("zotero",)
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
    "FACTS_TOO_LARGE": "the file would pass the Toolkit's own size bound; the write is refused, not truncated",
    "FACTS_DIRECTORY_UNAVAILABLE": "the machine-level directory could not be created or written, so the fact was not recorded",
}

_seq = 0


def facts_path(env: dict[str, str] | None = None) -> Path:
    """The one file every profile of this OS user reads: the budget's own directory, its own name."""
    return provider_budget.budget_directory(env)[0] / FACTS_FILE_NAME


def _no_facts() -> dict[str, Any]:
    return {"schemaVersion": SCHEMA_VERSION, "facts": {}}


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


def _valid_fact(value: Any) -> dict[str, Any] | None:
    """One stored fact, or None when it is not a fact this release is allowed to state."""
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


def read_facts(env: dict[str, str] | None = None) -> dict[str, Any]:
    """The machine-level facts as they stand, or a well-formed document holding no facts.

    A file that is absent, unreadable, not JSON, of another schema, or whose entries do not hold the
    five fields all answer the same way: no facts, no exception, and no claim about the machine. A
    reader cannot tell a refused read from a machine on which nothing was ever detected, which is the
    honest direction — the file states nothing it did not earn.
    """
    try:
        with open(facts_path(env), "rb") as handle:
            document = json.loads(handle.read().decode("utf-8"))
    except (OSError, ValueError):
        return _no_facts()
    if not isinstance(document, dict) or document.get("schemaVersion") != SCHEMA_VERSION \
            or not isinstance(document.get("facts"), dict):
        return _no_facts()
    facts = {name: fact for name in FACT_PROVIDERS
             if (fact := _valid_fact(document["facts"].get(name))) is not None}
    return {"schemaVersion": SCHEMA_VERSION, "facts": facts}


def write_fact(provider: str, *, found: bool, classification: str, platform: str, detected_at_ms: int,
               code: str | None, env: dict[str, str] | None = None) -> dict[str, Any]:
    """Record one provider's fact by atomically replacing the whole document, or refuse and say why.

    The refusal is the returned answer, not a raised error: `{"written": False, "code": ..., "rule": ...}`
    names the rule the value broke and quotes no part of the value. A document that would pass
    `MAX_FACTS_BYTES` is refused whole, the file on disk is left as it was, and nothing is truncated.
    """
    if provider not in FACT_PROVIDERS:
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
    path = facts_path(env)
    facts = read_facts(env)["facts"]
    facts[provider] = {"found": found, "classification": classification, "platform": platform,
                       "detectedAtMs": int(detected_at_ms), "code": code}
    payload = (json.dumps({"schemaVersion": SCHEMA_VERSION, "facts": facts}, indent=2, ensure_ascii=True) + "\n").encode("utf-8")
    if len(payload) > MAX_FACTS_BYTES:
        return _refuse("FACTS_TOO_LARGE")
    global _seq
    _seq += 1
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
