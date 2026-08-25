"""Enqueue, sweep and report for the ai_jobs queue.

WHAT THIS MODULE IS FOR. Exactly one thing may create an ai_jobs row: an
authenticated request handler acting on an explicit user action, after the
feature flag and the per-company rate limit. That is the carve-out the whole
polling design rests on -- a poll may DISCOVER work and may never create it --
so the creation path lives in one place where it can be read whole.

TWO EXECUTORS, ONE LIFECYCLE. A feature whose chain resolves to a local model is
routed to the desktop worker; one still on Anthropic is worked inline by the
enqueueing request. Both produce the same status vocabulary, so the frontend has
one state machine rather than two.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from services.llm.errors import LLMNotConfigured
from services.llm.registry import chain_for, resolve_feature

logger = logging.getLogger(__name__)

# Interactive surfaces outrank batch surfaces, and nothing preempts unless
# something assigns this. The claim orders by priority before its resident-model
# tie-break, so an interactive arrival is worth a 43-63s model swap and equal
# work is not.
PRIORITY_INTERACTIVE = 10
PRIORITY_BATCH = 0
_INTERACTIVE_FEATURES = frozenset({"insights"})

# A client-supplied page_count is a spend multiplier: fan-out mints one model
# call per page from one click, so an unbounded count turns a single button press
# into hundreds of calls. 60 covers any real package -- a drawing PDF longer than
# that is a manual, not a print -- and the worker RECONCILES the claim against the
# real page count when it opens the file, because a cap alone still trusts the
# client's number.
MAX_FAN_OUT = 60

# Comfortably past Vercel's 60s wall, so a healthy inline call never trips it and
# a killed one is collected within 30 seconds. The CHECK on ai_jobs makes the
# lease mandatory for any in-flight row; without it the sweep's lease branch and
# the frontend's lease rule both match nothing for backend rows.
BACKEND_LEASE_SECONDS = 90
BACKEND_QUEUE_TTL_SECONDS = 120


class AiJobRateLimited(RuntimeError):
    """The company is over its hourly cap for this feature -> HTTP 429."""

    def __init__(self, message: str, retry_after: int) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class AiUnavailable(RuntimeError):
    """No worker can serve this feature's model right now -> HTTP 503.

    Checked BEFORE a row is created, so an offline box produces no job to poll and
    no ledger row -- the enqueue response is the authoritative offline signal and
    the browser's heartbeat read is only the proactive hint.
    """


def _now() -> datetime:
    return datetime.now(timezone.utc)


def resolve_execution(feature: str) -> tuple[str, str, str]:
    """(resolved_feature, executor, model) for a feature's configured chain.

    The chain's HEAD decides. A chain is local-only or hosted-only by policy, so
    the head is the whole answer rather than a first guess.
    """
    resolved = resolve_feature(feature)
    head = chain_for(resolved)[0]
    executor = "worker" if head.name == "ollama" else "backend"
    return resolved, executor, head.model


def worker_can_serve(db, model: str) -> bool:
    """Whether a live worker advertises this model.

    Mirrors sweep_ai_jobs()'s branch 1 exactly, including its model-awareness: a
    worker that is up but has never loaded qwen3-vl:4b must not count as coverage
    for a drawing job. The 60s threshold appears here, in the sweep, and in the
    frontend deadline rule -- change one and change all three.
    """
    cutoff = (_now() - timedelta(seconds=60)).isoformat()
    rows = (
        db.table("ai_workers").select("models").gte("last_seen_at", cutoff).execute()
    ).data or []
    return any(model in (row.get("models") or []) for row in rows)


def sweep(db) -> int:
    """Reconcile abandoned jobs. Best-effort: never fails an enqueue.

    Called at the top of every enqueue because enqueues are the only thing that
    creates work, and -- run as service_role here -- this is the ONLY path that
    can collect a stuck backend row. The worker's own sweep is scoped by RLS to
    executor='worker'.
    """
    try:
        return int((db.rpc("sweep_ai_jobs", {}).execute()).data or 0)
    except Exception as exc:  # noqa: BLE001 - a sweep failure must not block work
        logger.warning("ai_jobs sweep failed: %s", exc)
        return 0


def count_recent(db, company_id: str, feature: str, hours: int = 1) -> int:
    """Jobs this company started for this feature in the window.

    Counts DISTINCT batch_key for fanned-out work, not rows: a 40-page package is
    one thing the user did, and counting rows would let a single import exhaust an
    hourly cap by itself.
    """
    since = (_now() - timedelta(hours=hours)).isoformat()
    rows = (
        db.table("ai_jobs")
        .select("id, batch_key, created_at")
        .eq("company_id", company_id)
        .eq("feature", feature)
        .gte("created_at", since)
        .execute()
    ).data or []
    units = {r["batch_key"] or r["id"] for r in rows}
    return len(units)


def enqueue(
    db,
    *,
    company_id: str,
    feature: str,
    payload: dict[str, Any],
    requested_by: str | None = None,
    page_count: int = 1,
    request_id: str | None = None,
) -> list[dict[str, Any]]:
    """Create the job row(s) for one user action. Returns the created rows.

    Raises AiUnavailable when the feature routes to a worker and none is alive --
    before creating anything, so an offline box leaves no job to poll.
    """
    if page_count < 1:
        raise ValueError("page_count must be at least 1")
    if page_count > MAX_FAN_OUT:
        raise ValueError(
            f"page_count {page_count} exceeds the {MAX_FAN_OUT}-page cap. Fan-out mints "
            f"one model call per page, so an unbounded count turns one click into "
            f"hundreds of calls."
        )

    resolved, executor, model = resolve_execution(feature)

    if page_count > 1 and executor != "worker":
        # A CHECK enforces this too. Raising here makes it a clean 501 rather than
        # a constraint violation, and says why: N inline Anthropic calls inside one
        # 60s wall is not slow, it is fatal.
        raise LLMNotConfigured(
            f"{resolved} resolves to an inline executor, which processes exactly one "
            f"job per request. Fan-out is worker-only.",
            feature=resolved,
        )

    if executor == "worker" and not worker_can_serve(db, model):
        raise AiUnavailable(
            "The AI box is offline right now, so this can't run. Everything else still works."
        )

    request_id = request_id or str(uuid.uuid4())
    batch_key = str(uuid.uuid4()) if page_count > 1 else None
    priority = PRIORITY_INTERACTIVE if resolved.split("_")[0] in _INTERACTIVE_FEATURES else PRIORITY_BATCH
    expires_at = (
        (_now() + timedelta(seconds=BACKEND_QUEUE_TTL_SECONDS)).isoformat()
        if executor == "backend"
        else None
    )

    rows = [
        {
            "company_id": company_id,
            "requested_by": requested_by,
            "feature": resolved,
            "executor": executor,
            "model": model,
            "priority": priority,
            "batch_key": batch_key,
            "payload": {**payload, "page_number": page, "page_count": page_count}
            if page_count > 1
            else payload,
            # One request_id per PAGE when fanned out: each page is its own logical
            # call with its own ai_calls rows, and batch_key is what groups them.
            "request_id": request_id if page_count == 1 else str(uuid.uuid4()),
            "expires_at": expires_at,
        }
        for page in range(1, page_count + 1)
    ]
    return (db.table("ai_jobs").insert(rows).execute()).data or []


def mark_running(db, job_id: str, *, lease_seconds: int = BACKEND_LEASE_SECONDS) -> None:
    """Move a backend job to running WITH A LEASE.

    The lease is not optional and not decoration. claim_ai_jobs() is the only other
    thing that sets one and it is worker-only, so without this a Vercel-killed
    inline job sits `running` with lease_expires_at NULL -- matching neither the
    sweep's lease branch nor the frontend's lease rule, both of which claim to
    catch exactly that case. A CHECK refuses the update without it.
    """
    db.table("ai_jobs").update({
        "status": "running",
        "claimed_at": _now().isoformat(),
        "lease_expires_at": (_now() + timedelta(seconds=lease_seconds)).isoformat(),
    }).eq("id", job_id).execute()


def mark_succeeded(db, job_id: str, result: dict[str, Any]) -> None:
    db.table("ai_jobs").update({
        "status": "succeeded",
        "result": result,
        "finished_at": _now().isoformat(),
    }).eq("id", job_id).execute()


def mark_failed(db, job_id: str, *, error: str, error_kind: str) -> None:
    """Terminal failure. `error_kind` separates "the box is asleep" from an incident.

    'ai_offline' is expected downtime and must NOT page: a desktop that is off is
    not an outage, and alerting on it trains the alert away.
    """
    db.table("ai_jobs").update({
        "status": "failed",
        "error": (error or "unknown failure")[:2048],
        "error_kind": error_kind,
        "finished_at": _now().isoformat(),
    }).eq("id", job_id).execute()


__all__ = [
    "AiJobRateLimited",
    "AiUnavailable",
    "BACKEND_LEASE_SECONDS",
    "MAX_FAN_OUT",
    "PRIORITY_BATCH",
    "PRIORITY_INTERACTIVE",
    "count_recent",
    "enqueue",
    "mark_failed",
    "mark_running",
    "mark_succeeded",
    "resolve_execution",
    "sweep",
    "worker_can_serve",
]
