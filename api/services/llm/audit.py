"""The single writer for ai_calls.

BEST-EFFORT, ON PURPOSE, AND THAT IS NOT A CONTRADICTION OF THE
"no swallowed exceptions" RULE. That rule governs PROVIDER failures reaching the
user. This is telemetry, and telemetry that can fail a shop owner's question is
worse than telemetry -- the same call insights_routes.py already makes for
ai_chat_queries.

TWO BACKENDS, ONE ROW SHAPE. The FastAPI backend writes through PostgREST as
service_role; the desktop worker writes over its own libpq connection as
jigged_ai_worker, which has INSERT and deliberately no SELECT. Both go through
`build_row`, so the two paths cannot drift into logging different things.
"""
from __future__ import annotations

import asyncio
import logging
from decimal import Decimal
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

AuditWriter = Callable[[dict[str, Any]], Awaitable[None]]


def build_row(
    *,
    feature: str,
    provider: str,
    model: str,
    request_id: str,
    success: bool,
    tokens_in: int = 0,
    tokens_out: int = 0,
    latency_ms: int = 0,
    est_cost_usd: Decimal | str = Decimal("0"),
    error: str | None = None,
) -> dict[str, Any]:
    """One ai_calls row, shaped for either writer.

    est_cost_usd goes as a STRING. Decimal is not JSON-serialisable, so a
    supabase-py insert of the raw object raises at runtime and nowhere else --
    Postgres accepts the string into numeric without losing a digit.
    """
    return {
        "feature": feature.lower(),
        "provider": provider.lower(),
        "model": model,
        "tokens_in": max(0, int(tokens_in)),
        "tokens_out": max(0, int(tokens_out)),
        "latency_ms": max(0, int(latency_ms)),
        "est_cost_usd": str(est_cost_usd),
        "request_id": request_id,
        "success": success,
        # The DB CHECK refuses a failure with no reason and a success with one, so
        # this coupling is enforced on both sides rather than trusted here.
        "error": (error or "unknown failure")[:2048] if not success else None,
    }


def _insert_via_supabase(row: dict[str, Any]) -> None:
    # Imported inside the function so `import services.llm` does not pull FastAPI
    # into the worker process, which has no route layer at all.
    from routes.company_auth import service_client

    service_client().table("ai_calls").insert(row).execute()


async def supabase_writer(row: dict[str, Any]) -> None:
    """Default writer: PostgREST as service_role.

    asyncio.to_thread because supabase-py is synchronous and would block the event
    loop for the round trip. Explicitly NOT asyncio.create_task: on Vercel the
    container can be frozen the instant the response returns, so a detached task
    never runs and the row vanishes with no error anywhere. Awaiting is what makes
    "every call is logged" true rather than aspirational.
    """
    await asyncio.to_thread(_insert_via_supabase, row)


async def record(writer: AuditWriter | None, row: dict[str, Any]) -> None:
    """Write one row, swallowing any failure into a warning.

    The swallow is the point: a logging outage must not turn into an outage of the
    feature. What it must ALSO not do is mask a provider failure -- the caller
    raises that separately, and there is a test for exactly that interaction.
    """
    try:
        await (writer or supabase_writer)(row)
    except Exception as exc:  # noqa: BLE001 - telemetry must never fail the request
        logger.warning(
            "failed to record ai_calls row (%s/%s request_id=%s): %s",
            row.get("feature"), row.get("provider"), row.get("request_id"), exc,
        )


__all__ = ["AuditWriter", "build_row", "record", "supabase_writer"]
