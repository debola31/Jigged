"""Reading what the worker published, assuming nothing about it.

The document may be absent (worker never started), a previous run's (worker
restarted a moment ago), truncated (never, given os.replace, but a reader that
depends on that is a reader waiting to be wrong), or from a future schema. All
four are ordinary and none may raise.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

SCHEMA = 1

# Mirrors worker/status.py's DEFAULT_PATH. It is duplicated rather than imported
# because importing worker.status is harmless today but worker/__main__.py drags
# psycopg2 and the whole provider layer, and this process must stay able to run
# when the worker's dependencies cannot. tests/test_contract.py asserts the two
# agree, so the duplication cannot drift silently.
DEFAULT_PATH = Path.home() / "Library/Application Support/Jigged/worker-status.json"

# How many missed publications before the document is treated as ABANDONED.
#
# This is NOT the product's 60-second offline rule and must never be confused with
# it. That rule answers "should the browser say the AI is unavailable" and lives in
# sweep_ai_jobs(), WORKER_STALE_AFTER_MS and ai_workers' column comment. This
# answers a different question that only exists on this box -- "has the process
# stopped publishing while still holding a pid" -- and it is a wedged-process
# detector, not a health verdict. Four is simply generous enough that a slow tick
# is not an alarm.
ABANDONED_AFTER_BEATS = 4


def path() -> Path:
    return Path(os.getenv("JIGGED_STATUS_FILE") or DEFAULT_PATH)


def load(target: Optional[Path] = None) -> Optional[Dict[str, Any]]:
    """The document, or None. Never raises."""
    try:
        raw = (target or path()).read_text()
    except OSError:
        return None
    try:
        doc = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(doc, dict) or doc.get("schema") != SCHEMA:
        # A schema we do not know is not a document we may guess at. Treated as
        # absent, which degrades to "launchd says a pid exists" rather than to a
        # confident wrong answer.
        return None
    return doc


def age_seconds(iso: Optional[str], now: Optional[datetime] = None) -> Optional[float]:
    """Seconds since an ISO timestamp, or None if it is missing or unparseable."""
    if not iso:
        return None
    try:
        when = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return ((now or datetime.now(timezone.utc)) - when).total_seconds()


def is_abandoned(doc: Dict[str, Any], now: Optional[datetime] = None) -> bool:
    """Has the process stopped publishing while still holding a pid?"""
    beat = doc.get("heartbeat_seconds") or 15
    age = age_seconds(doc.get("written_at"), now)
    return age is not None and age > beat * ABANDONED_AFTER_BEATS


def databases(doc: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = doc.get("databases")
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def production(doc: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    return next((d for d in databases(doc) if d.get("is_default")), None)
