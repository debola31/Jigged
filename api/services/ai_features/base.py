"""What a feature handler receives, and how one is found.

A handler is `async (JobContext) -> dict`, and the dict is what lands in
ai_jobs.result. Keeping the contract this narrow is what lets the same function
serve a claimed worker job and an inline backend job without knowing which it is.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from services.llm.audit import AuditWriter
from services.llm.base import LLMProvider


@dataclass(frozen=True)
class JobContext:
    """One job's inputs, plus the seams the two hosts need to differ on.

    `chain`, `audit_writer` and `readonly_dsn` are injectable because the worker
    resolves its own chain, writes the ledger over libpq as jigged_ai_worker, and
    since 2026-09-09 serves several databases at once, while the backend resolves
    all three from env and writes through PostgREST as service_role. Everything
    else about running the job is identical, which is the point.

    `readonly_dsn` is WHICH DATABASE THIS JOB'S SQL RUNS AGAINST. The worker sets
    it from the database the job was claimed from -- production or one live
    preview branch -- so nothing ambient decides. Left None by the backend and the
    evals, where tools/sql_executor falls back to AI_READONLY_DATABASE_URL because
    one process there serves exactly one database.
    """

    feature: str
    company_id: str
    request_id: str
    payload: dict[str, Any] = field(default_factory=dict)
    chain: list[LLMProvider] | None = None
    audit_writer: AuditWriter | None = None
    readonly_dsn: str | None = None


Handler = Callable[[JobContext], Awaitable[dict[str, Any]]]


def handler_for(feature: str) -> Handler:
    """Resolve a handler by feature name, dev suffix and all.

    Raises rather than defaulting: a job whose feature nothing handles is a
    misconfiguration, and quietly succeeding with an empty result would be the
    silent degradation this layer refuses.
    """
    base = feature.removesuffix("_dev")
    if base == "insights":
        from services.ai_features import insights

        return insights.run
    raise LookupError(
        f"no handler for feature {feature!r}. Add one in services/ai_features/ and "
        f"register it here; a job that cannot be run must fail loudly."
    )


__all__ = ["Handler", "JobContext", "handler_for"]


# The two values ai_jobs.kind may hold; the CHECK constraint on the column is the
# source of truth (20260907234149_ai_chat_threads_and_messages.sql).
JOB_KINDS = frozenset({"chat", "report"})


def result_kind(result: dict[str, Any] | None) -> str | None:
    """The kind a settling job should carry, when its result says so.

    A chat job whose model answered by calling compose_report returns a report
    result with `kind = 'report'`; both executors write it into `ai_jobs.kind` on
    success, so the Reports list, the thread trigger and the settle event read one
    column. Anything unrecognised leaves the column as enqueued: the CHECK
    constraint is the real guard, and a bad value would fail the settle itself.
    """
    kind = (result or {}).get("kind")
    return kind if isinstance(kind, str) and kind in JOB_KINDS else None
