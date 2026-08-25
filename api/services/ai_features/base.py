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

    `chain` and `audit_writer` are injectable because the worker resolves its own
    chain and writes the ledger over libpq as jigged_ai_worker, while the backend
    resolves from env and writes through PostgREST as service_role. Everything
    else about running the job is identical, which is the point.
    """

    feature: str
    company_id: str
    request_id: str
    payload: dict[str, Any] = field(default_factory=dict)
    chain: list[LLMProvider] | None = None
    audit_writer: AuditWriter | None = None


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
