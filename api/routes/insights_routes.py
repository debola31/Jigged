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

from models.insights_models import ChatEnqueued, ChatRequest, ReportRequest
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
    Enforce the company's chat rate limit (AI jobs enqueued in the last hour).

    COUNTS ai_jobs, NOT ai_chat_queries. The cap guards the one door that creates
    AI work, and ai_jobs is the one table both executors write at that door. The
    transcript table is written only by the inline backend path (_run_inline), so
    once insights routed to the desktop worker it recorded nothing and the cap
    silently counted zero -- a worker-served shop had no hourly limit at all.
    Every enqueued row counts, including attempts that later failed or were
    refused as non-answers: each one spent model time on the box.

    On breach, raises 429 with a message reflecting the company's actual limit
    and a Retry-After header set to the seconds until the oldest in-window job
    ages out. A read error is non-fatal (allow the request through).
    """
    supabase = _get_supabase_service_role()
    now = datetime.now(timezone.utc)
    one_hour_ago = now - timedelta(hours=1)

    try:
        response = (
            supabase.table("ai_jobs")
            .select("created_at")
            .eq("company_id", company_id)
            # insights and insights_dev alike: the cap is per surface, whichever
            # chain served it. Reports are insights jobs too and count.
            .like("feature", "insights%")
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
    failure. Here it branches on the HTTP STATUS alone -- utils/insightsAccess.ts
    raises a ChatEnqueueError carrying it, and the ask bar renders a 503 as the
    same quiet offline notice a mid-job outage gets -- so the sentence stays a
    sentence.

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
                detail=(
                    "Insights are temporarily unavailable right now. "
                    "Everything else still works."
                ),
            )
        if exc.is_context_overflow:
            # 400, not 5xx: nothing is down and nothing broke -- the conversation
            # outgrew the window, and only the user can start a new one.
            return HTTPException(
                status_code=400,
                detail="That conversation has grown past what the assistant can hold. Start a new one.",
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
        if exc.is_offline:
            return "ai_offline"
        if exc.is_context_overflow:
            return "context_overflow"
        return "provider"
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


def _is_one_in_flight_violation(exc: Exception) -> bool:
    """The unique index ai_jobs_one_in_flight_per_thread, as PostgREST reports it."""
    code = getattr(exc, "code", None)
    return str(code) == "23505" and "ai_jobs_one_in_flight_per_thread" in str(
        getattr(exc, "message", None) or exc
    )


def _thread_replay(db, company_id: str, thread_id: str) -> dict:
    """The replay set for a conversation: the latest summary, and every turn after it.

    FAILS VISIBLE, unlike the rate limiter's deliberate fail-open. A question
    answered without its history is a silently wrong answer -- the model would
    read "and by month?" with no idea what "and" continues -- so a read error here
    propagates to the generic 500 rather than degrading to a one-off question.

    The thread must be this company's and not archived. The route trusts
    thread_id from the body (it has no auth of its own -- ai-insights.md, Known
    gaps), so the company check is the one integrity it CAN enforce; per-user
    integrity lives in the RLS the browser created the thread under.
    """
    thread = (
        db.table("ai_chat_threads")
        .select("id, company_id, deleted_at")
        .eq("id", thread_id)
        .limit(1)
        .execute()
    ).data or []
    if not thread or thread[0].get("company_id") != company_id or thread[0].get("deleted_at"):
        raise HTTPException(
            status_code=404, detail="That conversation isn't available any more. Start a new one."
        )

    rows = (
        db.table("ai_chat_messages")
        .select("seq, role, content, covers_through_seq")
        .eq("thread_id", thread_id)
        .order("seq", desc=False)
        .execute()
    ).data or []

    # The LATEST summary wins -- the highest seq -- and its covers_through_seq is
    # where replay starts. Rows at or before it are folded in already.
    summary = None
    for row in rows:
        if row["role"] == "summary":
            summary = row
    covers = int(summary["covers_through_seq"]) if summary else 0
    history = [
        {"seq": row["seq"], "role": row["role"], "content": row["content"]}
        for row in rows
        if row["role"] in ("user", "assistant") and row["seq"] > covers
    ]
    return {
        "thread_id": thread_id,
        "summary": {"content": summary["content"], "covers_through_seq": covers} if summary else None,
        "history": history,
    }


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

    payload: dict = {
        "question": request.question,
        # In the PAYLOAD, not a handler argument: the desktop worker gets the job
        # row and nothing else, so this is the one place that makes both execution
        # paths see the same date without wiring it twice.
        "today": _client_today(request.today).isoformat(),
    }
    thread_id = str(request.thread_id) if request.thread_id else None

    try:
        if thread_id:
            # The replay set rides in the payload for the same reason `today` does.
            payload.update(_thread_replay(db, company_id, thread_id))
        rows = ai_jobs.enqueue(
            db,
            company_id=company_id,
            feature="insights",
            payload=payload,
            thread_id=thread_id,
            kind="chat",
        )
    except HTTPException:
        raise
    except (ai_jobs.AiUnavailable, LLMNotConfigured) as exc:
        raise _map_llm_error(exc) from exc
    except Exception as exc:
        if _is_one_in_flight_violation(exc):
            # One question at a time per conversation. A second tab, or a double
            # click: not an incident, and the row the first one made is the one to
            # wait for.
            raise HTTPException(
                status_code=409,
                detail="Still working on the previous question in this conversation. Give it a moment.",
            ) from exc
        logger.error("insights enqueue failed: %s", exc, exc_info=True)
        sentry_sdk.capture_exception(exc)
        raise HTTPException(status_code=500, detail="Internal server error") from exc

    job = rows[0]
    if job["executor"] == "worker":
        # The desktop claims it. Nothing else happens in this request.
        return ChatEnqueued(job_id=job["id"], status=job["status"], executor="worker")

    await _run_inline(db, job, question=request.question, company_id=company_id)
    return ChatEnqueued(job_id=job["id"], status="settled", executor="backend")


@router.post("/{company_id}/report", response_model=ChatEnqueued, status_code=202)
async def report(company_id: str, request: ReportRequest):
    """Enqueue a one-page executive summary. The spec arrives on the job row.

    The direct door. The composer has no Report verb since 2026-09-08: a report
    asked in the chat reaches the same handler through the model's compose_report
    tool, and the job's kind flips to 'report' when it settles. This route is for
    a caller that already knows it wants a page.

    The SAME door as a question: flag, cap, sweep, heartbeat. A report is one job
    that makes several model calls, so it counts once against the cap and holds
    the single slot for a few minutes; the browser renders the resulting spec to
    PDF itself (utils/reportPdf.ts). No storage object, no backend rendering.
    """
    ai_enabled, chat_limit = _get_company_ai_settings(company_id)
    if not ai_enabled:
        raise HTTPException(status_code=403, detail="AI Insights is disabled for this company.")
    _check_chat_rate_limit(company_id, chat_limit)

    db = _get_supabase_service_role()
    ai_jobs.sweep(db)

    # A report asked in a conversation joins it: the thread must be this
    # company's and live (the same 404 a question gets), and the one-in-flight
    # rule applies -- a report holds the thread for minutes, so a question asked
    # meanwhile is told to wait rather than queued behind it. The replay set is
    # not sent: the report gathers its own figures with SQL and the request is
    # the whole brief.
    thread_id = str(request.thread_id) if request.thread_id else None
    if thread_id:
        _thread_replay(db, company_id, thread_id)

    try:
        rows = ai_jobs.enqueue(
            db,
            company_id=company_id,
            feature="insights",
            payload={
                "kind": "report",
                "request": request.request,
                "today": _client_today(request.today).isoformat(),
            },
            thread_id=thread_id,
            kind="report",
        )
    except (ai_jobs.AiUnavailable, LLMNotConfigured) as exc:
        raise _map_llm_error(exc) from exc
    except Exception as exc:
        if _is_one_in_flight_violation(exc):
            raise HTTPException(
                status_code=409,
                detail="Still working on the previous question in this conversation. Give it a moment.",
            ) from exc
        logger.error("insights report enqueue failed: %s", exc, exc_info=True)
        sentry_sdk.capture_exception(exc)
        raise HTTPException(status_code=500, detail="Internal server error") from exc

    job = rows[0]
    if job["executor"] == "worker":
        return ChatEnqueued(job_id=job["id"], status=job["status"], executor="worker")

    await _run_inline(db, job, question=request.request, company_id=company_id)
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
    """Transcript row for a BACKEND-executed job, and only those.

    The worker path never reaches this function, so ai_chat_queries holds inline
    turns alone; a worker turn's transcript is ai_jobs.payload->>'question' and
    result->>'answer'. This docstring used to claim the table backed saved
    insights, the /admin view and the rate limiter. None of that holds: pins live
    in saved_insights via the browser, nothing in the UI reads this table, and the
    cap counts ai_jobs (see _check_chat_rate_limit) precisely because this table
    went quiet when insights moved to the worker. It stays for the eval's question
    seed (evals/insights_ab.py) and for debugging the hosted path.

    provider and model carry whoever ACTUALLY answered rather than a hardcoded
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
