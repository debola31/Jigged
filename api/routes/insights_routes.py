"""
API routes for AI Insights & Charts feature.

Endpoints:
- POST /{company_id}/chat        - Submit natural language question

Note: Saved insights CRUD (get/save/delete) is handled client-side
via direct Supabase queries with RLS policies. Low-stock surfacing is
client-side too — it's the shortage lens on the parts page, not an alert feed.
"""

import logging
import os
import time

import sentry_sdk
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException
from supabase import Client, create_client

from models.insights_models import ChatEnqueued, ChatRequest
from services import ai_jobs
from services.ai_features import JobContext, handler_for
from services.llm.errors import (
    LLMChainExhausted,
    LLMErrorEcho,
    LLMNotConfigured,
    LLMRequestError,
    LLMToolLoopExhausted,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/insights", tags=["insights"])


def _get_supabase_service_role() -> Client:
    """Get a Supabase client with service role key."""
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Database not available")
    return create_client(url, key)


# Default per-company hourly cap, used when a company has no explicit override
# in settings.ai_limits.chat_per_hour. A system admin can raise/lower it per
# company from /admin.
DEFAULT_CHAT_LIMIT_PER_HOUR = 20


def _get_company_ai_settings(company_id: str) -> tuple[bool, int]:
    """Read (ai_insights_enabled, chat_per_hour) from companies.settings.

    ai_insights is opt-OUT — a GA feature with a per-tenant kill-switch: enabled
    unless the company row explicitly stores settings.features.ai_insights =
    false. The rate limit falls back to DEFAULT_CHAT_LIMIT_PER_HOUR when unset
    or invalid.

    Fails open — (True, default) — on a read error, matching the rate limiter's
    allow-through-on-error stance so a transient DB blip never dark-launches the
    GA feature off.
    """
    try:
        supabase = _get_supabase_service_role()
        resp = (
            supabase.table("companies")
            .select("settings")
            .eq("id", company_id)
            .single()
            .execute()
        )
        settings = (resp.data or {}).get("settings") or {}
    except Exception as e:
        logger.warning(f"Failed to read company AI settings: {e}")
        return True, DEFAULT_CHAT_LIMIT_PER_HOUR

    features = settings.get("features") or {}
    raw_enabled = features.get("ai_insights")
    # Missing key → default on; explicit false (bool or legacy "false") → off.
    enabled = raw_enabled is None or raw_enabled is True or raw_enabled == "true"

    limits = settings.get("ai_limits") or {}
    raw_limit = limits.get("chat_per_hour")
    limit = (
        int(raw_limit)
        if isinstance(raw_limit, (int, float)) and int(raw_limit) > 0
        else DEFAULT_CHAT_LIMIT_PER_HOUR
    )
    return enabled, limit


def _seconds_until_window_frees(oldest_created_at, now: datetime) -> int:
    """Seconds until the oldest in-window query ages past the 1-hour window.

    Clamped to [1, 3600]; falls back to 3600 if the timestamp can't be parsed.
    """
    try:
        # PostgREST returns ISO 8601; tolerate a trailing 'Z'.
        oldest = datetime.fromisoformat(str(oldest_created_at).replace("Z", "+00:00"))
        remaining = int((oldest + timedelta(hours=1) - now).total_seconds())
    except (ValueError, TypeError):
        return 3600
    return max(1, min(remaining, 3600))


def _check_chat_rate_limit(company_id: str, limit: int) -> None:
    """
    Enforce the company's chat rate limit (queries in the last hour).

    On breach, raises 429 with a message reflecting the company's actual limit
    and a Retry-After header set to the seconds until the oldest in-window query
    ages out. A read error is non-fatal (allow the request through).
    """
    supabase = _get_supabase_service_role()
    now = datetime.now(timezone.utc)
    one_hour_ago = now - timedelta(hours=1)

    try:
        response = (
            supabase.table("ai_chat_queries")
            .select("created_at")
            .eq("company_id", company_id)
            .gte("created_at", one_hour_ago.isoformat())
            .order("created_at", desc=False)
            .execute()
        )

        rows = response.data or []
        if len(rows) >= limit:
            retry_after = _seconds_until_window_frees(rows[0].get("created_at"), now)
            raise HTTPException(
                status_code=429,
                detail=(
                    f"Rate limit exceeded. Maximum {limit} AI chat queries "
                    f"per hour per company."
                ),
                headers={"Retry-After": str(retry_after)},
            )
    except HTTPException:
        raise
    except Exception as e:
        logger.warning(f"Rate limit check failed: {e}")
        # If rate limit check fails, allow the request through


# ============================================================
# Chat
# ============================================================


def _map_llm_error(exc: Exception) -> HTTPException:
    """Turn a typed AI failure into an HTTP response the ask bar can render.

    `detail` IS ALWAYS A PLAIN STRING. utils/insightsAccess.ts does
    `throw new Error(errorData.detail || ...)` and renders the message straight
    into an Alert, so a {"code","message"} dict shows the user "[object Object]".
    The repo's rule is structured detail only when the browser must BRANCH on the
    failure, and here it must not -- it only has to say the sentence.

    Status choices are deliberate against Sentry's 5xx-only capture:
      503 offline   -- a desktop that is asleep is expected downtime, not an
                       incident, and paging on it trains the alert away.
      502 exhausted -- every configured provider failed, including a hosted one,
                       on a request we accepted and rate-limited. That IS ours.
    """
    if isinstance(exc, ai_jobs.AiUnavailable):
        return HTTPException(status_code=503, detail=str(exc))
    if isinstance(exc, LLMRequestError):
        return HTTPException(status_code=400, detail="That question couldn't be sent to the AI service.")
    if isinstance(exc, LLMNotConfigured):
        return HTTPException(status_code=503, detail="AI is not configured for this deployment.")
    if isinstance(exc, LLMChainExhausted):
        if exc.is_offline:
            return HTTPException(
                status_code=503,
                detail="The AI box is offline right now. Everything else still works.",
            )
        return HTTPException(
            status_code=502,
            detail="The AI service is unavailable right now. Please try again in a moment.",
        )
    if isinstance(exc, LLMToolLoopExhausted):
        return HTTPException(
            status_code=502,
            detail="That question needed more steps than the assistant could take. Try asking it more simply.",
        )
    if isinstance(exc, LLMErrorEcho):
        return HTTPException(
            status_code=502,
            detail="That question came back without an answer. Try asking it a different way.",
        )
    return HTTPException(status_code=500, detail="Internal server error")


def _error_kind(exc: Exception) -> str:
    if isinstance(exc, LLMChainExhausted):
        return "ai_offline" if exc.is_offline else "provider"
    if isinstance(exc, LLMToolLoopExhausted):
        return "provider"
    # Its own kind rather than 'provider' or 'internal'. The provider answered
    # and our code did not misbehave -- the answer was not an answer, and that
    # is a distinct thing to be able to count in the job rows.
    if isinstance(exc, LLMErrorEcho):
        return "error_echo"
    if isinstance(exc, LLMNotConfigured):
        return "ai_offline"
    return "internal"


# How far the browser's date may sit from the server's before we stop believing it.
# One day covers every real timezone (UTC-12..UTC+14 spans two calendar dates at any
# instant, so a legitimate client is never more than one day either side) plus a
# clock that is slightly wrong. Beyond that it is a broken device clock or someone
# asking what was late in 2019, and neither should quietly reshape an answer.
_TODAY_SKEW_DAYS = 1


def _client_today(claimed: date) -> date:
    """The caller's local date, refused if it is not plausibly today.

    Trusting it outright would let a caller pick any "today" and get a confidently
    wrong answer about what is overdue; ignoring it would put us back on UTC, which
    is the bug. So: believe it within a day of the server's date, and refuse
    outside that rather than silently substituting one -- a substituted date is
    exactly the kind of quiet disagreement this whole change exists to remove.
    """
    server_today = datetime.now(timezone.utc).date()
    if abs((claimed - server_today).days) > _TODAY_SKEW_DAYS:
        raise HTTPException(
            status_code=400,
            detail="Your device's date looks wrong. Check the clock and try again.",
        )
    return claimed


@router.post("/{company_id}/chat", response_model=ChatEnqueued, status_code=202)
async def chat(company_id: str, request: ChatRequest):
    """Enqueue a question. The answer arrives on the job row.

    THE ONLY THING THAT CREATES AN ai_jobs ROW. That is the carve-out the polling
    design rests on: a poll may discover work and may never create it, so the
    feature flag and the per-company rate limit sit in front of the only door.

    Gated on the per-company ai_insights flag (403) and the company's hourly cap
    (429). Returns 202 with a job id; the browser polls ai_jobs under RLS.
    """
    ai_enabled, chat_limit = _get_company_ai_settings(company_id)
    if not ai_enabled:
        raise HTTPException(status_code=403, detail="AI Insights is disabled for this company.")
    _check_chat_rate_limit(company_id, chat_limit)

    db = _get_supabase_service_role()
    # Only path that can collect a stuck backend row: the worker's own sweep is
    # scoped by RLS to executor='worker', and the person watching a spinner is by
    # definition not enqueueing anything.
    ai_jobs.sweep(db)

    try:
        rows = ai_jobs.enqueue(
            db,
            company_id=company_id,
            feature="insights",
            payload={
                "question": request.question,
                # In the PAYLOAD, not a handler argument: the desktop worker gets
                # the job row and nothing else, so this is the one place that makes
                # both execution paths see the same date without wiring it twice.
                "today": _client_today(request.today).isoformat(),
            },
        )
    except (ai_jobs.AiUnavailable, LLMNotConfigured) as exc:
        raise _map_llm_error(exc) from exc
    except Exception as exc:
        logger.error("insights enqueue failed: %s", exc, exc_info=True)
        sentry_sdk.capture_exception(exc)
        raise HTTPException(status_code=500, detail="Internal server error") from exc

    job = rows[0]
    if job["executor"] == "worker":
        # The desktop claims it. Nothing else happens in this request.
        return ChatEnqueued(job_id=job["id"], status=job["status"], executor="worker")

    await _run_inline(db, job, question=request.question, company_id=company_id)
    return ChatEnqueued(job_id=job["id"], status="settled", executor="backend")


async def _run_inline(db, job: dict, *, question: str, company_id: str) -> None:
    """Work a backend-executed job inside the enqueueing request.

    EXACTLY ONE JOB PER REQUEST, ENFORCED BY A CHECK ON THE TABLE. N inline calls
    inside one 60s Vercel wall is not slow, it is fatal, which is why fan-out is
    worker-only.

    The lease set by mark_running is what makes a platform kill recoverable: a
    killed request leaves the row `running`, and both the sweep's lease branch and
    the frontend's deadline rule collect it. Without the lease both match NULL and
    the job spins until the poll wall.
    """
    started = time.time()
    ai_jobs.mark_running(db, job["id"])
    try:
        result = await handler_for(job["feature"])(
            JobContext(
                feature=job["feature"],
                company_id=company_id,
                request_id=job["request_id"],
                payload=job["payload"],
            )
        )
    except Exception as exc:  # noqa: BLE001 - every failure becomes a terminal row
        kind = _error_kind(exc)
        if kind not in ("ai_offline",):
            # An exhausted LOCAL chain is a box being asleep. Everything else on a
            # hosted chain is ours, and Sentry should hear about it.
            logger.error("insights job %s failed: %s", job["id"], exc, exc_info=True)
            sentry_sdk.capture_exception(exc)
        ai_jobs.mark_failed(db, job["id"], error=str(exc), error_kind=kind)
        return

    ai_jobs.mark_succeeded(db, job["id"], result)
    _log_chat_query(db, company_id, question, result, int((time.time() - started) * 1000))


def _log_chat_query(db, company_id: str, question: str, result: dict, duration_ms: int) -> None:
    """Keep ai_chat_queries current: it backs saved insights, the /admin view AND
    the rate limiter, so dropping it would quietly disable the cap.

    provider and model now carry whoever ACTUALLY answered rather than a hardcoded
    "anthropic" -- the point of a chain is that the answer's origin varies.
    """
    try:
        db.table("ai_chat_queries").insert({
            "company_id": company_id,
            "question": question,
            "tool_calls": result.get("tool_calls", []),
            "response": result.get("answer", ""),
            "chart_config": result.get("chart_config"),
            "provider": result.get("provider", "unknown"),
            "model": result.get("model"),
            "tokens_used": result.get("tokens_used"),
            "duration_ms": duration_ms,
        }).execute()
    except Exception as exc:  # noqa: BLE001 - telemetry never fails the request
        logger.warning("Failed to log chat query: %s", exc)


# ---- presentation helpers -----------------------------------------------------
# Moved to services/insights_presentation.py so the desktop worker can run them
# without importing a route module. Re-exported here because two unit-test modules
# and the route body itself resolve them from this namespace -- the same shape as
# quickbooks_routes.py's `_service_client = company_auth.service_client`.
from services.insights_presentation import (  # noqa: E402
    _extract_chart_config,
    _flatten_markdown_tables,
    _select_chart_type,
    _strip_code_blocks,
    _strip_inline_markdown,
    _validate_chart_config,
)
