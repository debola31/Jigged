"""
API routes for AI Insights & Charts feature.

Endpoints:
- POST /{company_id}/chat        - Submit natural language question
- POST /{company_id}/report      - Submit a one-page summary request
- POST /{company_id}/chat/decide - Approve, always allow or decline a change the chat proposed
- POST /{company_id}/query       - Run one caller-written SELECT in the sandbox (no model)
- GET  /{company_id}/schema      - The schema notes and definitions that SELECT is written against

Note: Saved insights CRUD (get/save/delete) is handled client-side
via direct Supabase queries with RLS policies. Low-stock surfacing is
client-side too — it's the shortage lens on the parts page, not an alert feed.
"""

import logging
import os
import re
import time

import sentry_sdk
from datetime import date, datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from supabase import Client, create_client

import routes.company_auth as company_auth
from models.insights_models import (
    ChatDecision,
    ChatEnqueued,
    ChatRequest,
    DataQueryRequest,
    DataQueryResult,
    DataSchema,
    ReportRequest,
)
from services import ai_jobs
from services.ai_features import JobContext, handler_for
from services.chat_actions import ChatActions, app_base_url, grant
from services.insights_service import load_semantics
from tools import sql_executor
from tools.schema_context import SCHEMA_CONTEXT
from tools.sql_validator import validate_query_detailed
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
    replay = {
        "thread_id": thread_id,
        "summary": {"content": summary["content"], "covers_through_seq": covers} if summary else None,
        "history": history,
    }
    # Keep original references available after the discussion is compacted.
    uploads = []
    jobs = (
        db.table("ai_jobs").select("payload->uploads")
        .eq("company_id", company_id).eq("thread_id", thread_id)
        .not_.is_("payload->uploads", "null")
        .order("created_at", desc=True).limit(3).execute()
    ).data or []
    for job in jobs:
        for upload in job.get("uploads") or []:
            if not any(prior["id"] == upload["id"] for prior in uploads):
                uploads.append(upload)
    if uploads:
        replay["prior_uploads"] = uploads[:3]
    return replay


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
async def chat(company_id: str, request: ChatRequest, http_request: Request):
    """Enqueue a question. The answer arrives on the job row.

    THE ONLY THING THAT CREATES AN ai_jobs ROW. That is the carve-out the polling
    design rests on: a poll may discover work and may never create it, so the
    feature flag and the per-company rate limit sit in front of the only door.

    Gated, in this order, on the caller being an office member of the company (401 /
    403), the per-company ai_insights flag (403) and the company's hourly cap (429).
    Returns 202 with a job id; the browser polls ai_jobs under RLS.
    """
    # First, before the flag or the cap: the company id is the URL's, and everything
    # after this runs with the service-role key, so without it anyone could read any
    # shop's data and spend its hourly cap.
    user_id, _ = await company_auth.verify_office_access(http_request, company_id)
    # Jigged's own model is never invoked for an AI assistant (the customer's assistant is the AI).
    company_auth.refuse_assistant(http_request)
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
    if request.uploads:
        if not thread_id:
            raise HTTPException(status_code=400, detail="Start a conversation before attaching files.")
        for upload in request.uploads:
            expected = f"{company_id}/chat/{thread_id}/{upload.id}/manifest.json"
            if upload.manifest_path != expected:
                raise HTTPException(status_code=400, detail="That upload does not belong to this conversation.")
        payload["uploads"] = [upload.model_dump(mode="json") for upload in request.uploads]

    try:
        if thread_id:
            # The replay set rides in the payload for the same reason `today` does.
            payload.update(_thread_replay(db, company_id, thread_id))
        rows = ai_jobs.enqueue(
            db,
            company_id=company_id,
            feature="insights",
            payload=payload,
            # Who asked. A change the model proposes may be approved by that person
            # and nobody else (decide_chat_action).
            requested_by=user_id,
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

    # A fresh question that cannot load the tools still gets an answer -- read-only, as
    # the chat was before actions -- and the failure is reported, not hidden.
    actions = None
    if _chat_actions_enabled():
        try:
            actions = await ChatActions.open(
                token=company_auth._bearer(http_request),
                company_id=company_id,
                user_id=user_id,
                db=db,
            )
        except Exception as exc:  # noqa: BLE001 - degrade to read-only, visibly
            logger.warning("chat actions unavailable for job %s: %s", job["id"], exc)
            sentry_sdk.capture_exception(exc)

    await _run_inline(db, job, question=request.question, company_id=company_id, actions=actions)
    return ChatEnqueued(job_id=job["id"], status="settled", executor="backend")


def _chat_actions_enabled() -> bool:
    """Actions need this deployment's own origin (APP_BASE_URL, set on Production) and are
    on unless CHAT_ACTIONS=off -- the switch that turns them off without a deploy."""
    return bool(app_base_url()) and os.getenv("CHAT_ACTIONS", "on").strip().lower() != "off"


_DECISION_VERBS = {
    "approve": "Approved",
    "always": "Approved, and always allowed",
    "decline": "Declined",
}


@router.post("/{company_id}/chat/decide", response_model=ChatEnqueued, status_code=202)
async def decide_chat_action(company_id: str, request: ChatDecision, http_request: Request):
    """The person's answer to a change the chat proposed: approve, always allow, or decline.

    It continues the SAME conversation from where it stopped (the parent job's
    `resume_state`), as a new job in the thread, so the transcript records the decision
    ("Approved: ...") followed by what came of it. Same door as a question -- office
    access, the flag, the hourly cap -- and the same one-in-flight rule per thread.

    WHO MAY DECIDE: the person who asked, on the newest turn of their conversation. A change
    the conversation has moved past is no longer waiting; approving it would resume a
    conversation that has since gone elsewhere.
    """
    user_id, _ = await company_auth.verify_office_access(http_request, company_id)
    company_auth.refuse_assistant(http_request)
    ai_enabled, chat_limit = _get_company_ai_settings(company_id)
    if not ai_enabled:
        raise HTTPException(status_code=403, detail="AI Insights is disabled for this company.")
    _check_chat_rate_limit(company_id, chat_limit)

    db = _get_supabase_service_role()
    ai_jobs.sweep(db)

    parent = _waiting_job(db, company_id, str(request.job_id), user_id)
    pending: list[dict[str, Any]] = parent["result"]["pending_actions"]

    if not _chat_actions_enabled():
        raise HTTPException(status_code=503, detail=_ACTIONS_OFF)
    try:
        actions = await ChatActions.open(
            token=company_auth._bearer(http_request), company_id=company_id, user_id=user_id, db=db,
        )
    except Exception as exc:  # noqa: BLE001 - nothing has run; say so
        logger.warning("chat actions unavailable for decision on %s: %s", parent["id"], exc)
        sentry_sdk.capture_exception(exc)
        raise HTTPException(status_code=503, detail=_ACTIONS_OFF) from exc

    if request.decision == "always":
        grant(db, company_id, user_id, [action["tool"] for action in pending])

    summaries = "; ".join(str(action.get("summary") or action["tool"]) for action in pending)
    decided = f"{_DECISION_VERBS[request.decision]}: {summaries}"[:500]
    try:
        rows = ai_jobs.enqueue(
            db,
            company_id=company_id,
            feature="insights",
            payload={
                "question": decided,
                "today": _client_today(request.today).isoformat(),
                "resume_of": parent["id"],
                "decision": request.decision,
            },
            requested_by=user_id,
            thread_id=parent["thread_id"],
            kind="chat",
        )
    except (ai_jobs.AiUnavailable, LLMNotConfigured) as exc:
        raise _map_llm_error(exc) from exc
    except Exception as exc:
        if _is_one_in_flight_violation(exc):
            raise HTTPException(status_code=409, detail=_ALREADY_DECIDED) from exc
        logger.error("chat decision enqueue failed: %s", exc, exc_info=True)
        sentry_sdk.capture_exception(exc)
        raise HTTPException(status_code=500, detail="Internal server error") from exc

    job = rows[0]
    if job["executor"] != "backend":
        # The chain moved to the desktop between the question and the click. A resumed
        # conversation carries this model's own blocks; another model cannot take it up.
        ai_jobs.mark_failed(db, job["id"], error=_DECIDED_ON_A_WORKER_CHAIN, error_kind="internal")
        raise HTTPException(status_code=503, detail=_ACTIONS_OFF)

    await _run_inline(
        db, job, question=decided, company_id=company_id, actions=actions,
        resume={
            "state": parent["result"].get("resume_state") or {},
            "pending": pending,
            "decision": request.decision,
        },
    )
    return ChatEnqueued(job_id=job["id"], status="settled", executor="backend")


_ACTIONS_OFF = "Jigged chat can't make changes right now, so nothing was changed. Try again shortly."
_ALREADY_DECIDED = "That change is no longer waiting for a decision."
# A constant, not a literal at the call: the error-kind guard reads every string literal
# passed to mark_failed as a kind (tests/unit/test_error_kinds_match_the_check.py).
_DECIDED_ON_A_WORKER_CHAIN = "decided after insights moved to the desktop worker; nothing ran"


def _waiting_job(db, company_id: str, job_id: str, user_id: str) -> dict[str, Any]:
    """The job whose proposed change is being decided, or the HTTP error that says why not.

    404 when it is not this company's or not this person's (indistinguishable on purpose);
    409 when it holds no waiting change, or the conversation has moved on since.
    """
    found = (
        db.table("ai_jobs")
        .select("id, company_id, requested_by, thread_id, kind, status, result, created_at")
        .eq("id", job_id)
        .limit(1)
        .execute()
    ).data or []
    parent = found[0] if found else None
    if not parent or parent["company_id"] != company_id or parent.get("requested_by") != user_id:
        raise HTTPException(status_code=404, detail="That conversation was not found.")
    result = parent.get("result") or {}
    if (
        parent.get("status") != "succeeded"
        or parent.get("kind") != "chat"
        or not parent.get("thread_id")
        or not result.get("pending_actions")
        or not result.get("resume_state")
    ):
        raise HTTPException(status_code=409, detail=_ALREADY_DECIDED)
    later = (
        db.table("ai_jobs")
        .select("id")
        .eq("thread_id", parent["thread_id"])
        .gt("created_at", parent["created_at"])
        .limit(1)
        .execute()
    ).data or []
    if later:
        raise HTTPException(status_code=409, detail=_ALREADY_DECIDED)
    return parent


@router.post("/{company_id}/report", response_model=ChatEnqueued, status_code=202)
async def report(company_id: str, request: ReportRequest, http_request: Request):
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
    await company_auth.verify_office_access(http_request, company_id)
    # Jigged's own model is never invoked for an AI assistant (the customer's assistant is the AI).
    company_auth.refuse_assistant(http_request)
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


async def _run_inline(
    db,
    job: dict,
    *,
    question: str,
    company_id: str,
    actions: ChatActions | None = None,
    resume: dict[str, Any] | None = None,
) -> None:
    """Work a backend-executed job inside the enqueueing request.

    EXACTLY ONE JOB PER REQUEST, ENFORCED BY A CHECK ON THE TABLE. N inline calls
    inside one function's wall is not slow, it is fatal, which is why fan-out is
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
                actions=actions,
                resume=resume,
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


# ============================================================
# Data query: the customer's own assistant writes the SQL
# ============================================================
#
# An AI assistant (Claude, ChatGPT) connected through /mcp writes its own SELECT and reads the
# rows, for answers and charts it draws itself. NO MODEL OF OURS RUNS and no ai_jobs row is
# created. The statement goes through the insights sandbox exactly as Jigged's own model's do:
# validate_query_detailed, then execute_sql_query as jigged_ai_readonly with jigged.company_id set
# per transaction, under MAX_ROWS and STATEMENT_TIMEOUT_MS. So the DATABASE enforces the company,
# the deleted_at filter and what is readable (the ai_readonly_select policies), not this file.
#
# WHAT IS DELIBERATELY NOT HERE, against the two routes above:
#   * refuse_assistant. Those routes spend AI credits; this one spends none, and an assistant is
#     who it is for. verify_office_access still refuses an assistant token that did not come
#     through /mcp (the gateway key) and any operator.
#   * the ai_insights flag. It switches off Jigged's own chat ("hides the AI area and blocks the
#     chat endpoint", lib/featureFlags.ts). The rows behind it are the data every other assistant
#     read tool returns, none of which follows the flag, and assistants have no per-company switch
#     (the user's call, 2026-11-09).
#   * the hourly chat cap. It counts ai_jobs, which this never writes. Every call through /mcp is
#     counted against the per-company limit in lib/mcp/audit.ts before it reaches here.
#
# WHO: any office member, as in the app. The ask bar renders for every office user on the
# dashboard, with no admin gate; operators never reach it.

# WHO DID THE WORK IS NOT QUERYABLE FROM HERE. The sandbox can read job_operations.completed_by,
# inventory_transactions.operator_id and the other *_by columns (user ids), and
# `GROUP BY completed_by` is a per-person pace table: what the surveillance guardrail forbids
# (docs/modules/operator-view.md). Every MCP tool's declared output is checked for these names by
# __tests__/lib/mcp/catalogue.test.ts; a query's columns are decided at run time, so the same rule
# is applied here, BY NAME SHAPE rather than as a list of columns, so a new *_by column is covered
# the day it is added. The durable fix is a column REVOKE from jigged_ai_readonly (a migration),
# which would cover Jigged's own chat too.
_PERSON_COLUMN = r"\w+_by|\w+_by_name|operator_id|user_id|user_name|author\w*"
_NAMES_A_PERSON_COLUMN = re.compile(rf"\b({_PERSON_COLUMN})\b", re.IGNORECASE)
_IS_A_PERSON_COLUMN = re.compile(rf"(?:{_PERSON_COLUMN})", re.IGNORECASE)

PERSON_COLUMN_DETAIL = (
    "Jigged doesn't give assistants who did a piece of work, so {column} can't be queried. "
    "Ask about the work itself: its status, quantities and dates."
)

# What the endpoint holds a statement to, said once and served with the schema so the two cannot
# disagree. Every line is enforced above or in the sandbox; none is advice.
QUERY_RULES = [
    "One SELECT or WITH statement, PostgreSQL. Anything that changes data is refused.",
    "Scope every company table with company_id = $1; Jigged binds the id, and a query without $1 is refused.",
    "$2 is today's date. Pass `today` (the shop's local date) when the query uses it, and write "
    "$2::date where nothing else fixes its type. CURRENT_DATE, now() and the other clock functions are refused.",
    "Archived records are invisible: the connection filters deleted_at itself.",
    f"At most {sql_executor.MAX_ROWS} rows come back; aggregate or filter for more.",
    f"A query is stopped after {sql_executor.STATEMENT_TIMEOUT_MS // 1000} seconds.",
    "Columns that record who did a piece of work (completed_by, operator_id and other *_by "
    "columns) can't be queried.",
]


def _person_columns_in(value: Any, found: set[str]) -> set[str]:
    """Every key anywhere in a result row that names a person: a `SELECT *`, or `jo.*`, or a
    json column carrying one. The SQL-text check below cannot see those."""
    if isinstance(value, dict):
        for key, inner in value.items():
            if _IS_A_PERSON_COLUMN.fullmatch(str(key)):
                found.add(str(key))
            _person_columns_in(inner, found)
    elif isinstance(value, list):
        for inner in value:
            _person_columns_in(inner, found)
    return found


def _query_today(sql: str, claimed: date | None) -> date | None:
    """$2 for this statement, or a 400 that says why there is none.

    Bound only when the statement uses it -- the executor's own test, so the two cannot disagree.
    NEVER the server's date by default: the database is UTC, which is already tomorrow for the
    last hours of a working day in the Americas, and that is the bug `today` exists to remove
    (see _client_today). A plausibility window of one day either side, as for the chat.
    """
    # Private to the executor, read rather than copied: this is ITS decision whether to bind $2.
    if not sql_executor._USES_TODAY_PARAM.search(sql):
        return None
    if claimed is None:
        raise HTTPException(
            status_code=400,
            detail="This query uses $2, today's date. Send `today` as the shop's local date (YYYY-MM-DD).",
        )
    if abs((claimed - datetime.now(timezone.utc).date()).days) > _TODAY_SKEW_DAYS:
        raise HTTPException(
            status_code=400,
            detail=f"`today` is {claimed.isoformat()}, more than a day from the actual date. "
            "Send the shop's local date as it is now.",
        )
    return claimed


def _query_failure(result: dict) -> HTTPException:
    """The executor's error, as a sentence for the caller.

    The executor phrases its errors as instructions to Jigged's own model ("Rewrite the query
    ... Never describe this error to the user"); this caller is another model, writing for a
    person, so the instruction is cut and the cause kept. The prefixes and the instruction are
    the executor's own constants, so a rewording there fails test_insights_query_route rather
    than leaking the instruction through.
    """
    error = str(result.get("error") or "")
    # Not `kind`: test_error_kinds_match_the_check reads every `kind = …` in this file as a
    # value written to ai_jobs.error_kind. This one is only read.
    failure_kind = result.get("error_kind")
    if failure_kind == sql_executor.NOT_PERMITTED_KIND:
        refused = error.removeprefix("NOT_PERMITTED: ").split(". This object is unavailable", 1)[0]
        return HTTPException(
            status_code=400,
            detail=f"The query names {refused}, which doesn't exist or can't be read from Jigged's "
            "shop data. The data schema lists what can.",
        )
    if failure_kind == sql_executor.SQL_ERROR_KIND:
        cause = (
            error.removeprefix("SQL_ERROR: ")
            .removesuffix(sql_executor._REWRITE_INSTRUCTION)
            .strip()
            .rstrip(".")
        )
        return HTTPException(status_code=400, detail=f"The query failed: {cause}.")
    # Neither kind is the caller's to fix: no sandbox connection is configured here
    # (AI_READONLY_DATABASE_URL), or the pool could not be built. A 5xx, so Sentry hears of it.
    logger.error("data query could not run: %s", error)
    return HTTPException(
        status_code=503, detail="Shop data queries aren't available right now. Try again in a moment."
    )


@router.post("/{company_id}/query", response_model=DataQueryResult)
async def query(company_id: str, request: DataQueryRequest, http_request: Request):
    """Run one caller-written SELECT in the insights sandbox and return its rows.

    In this order: the caller (an office member; an assistant only through /mcp), the
    validator's refusal as a sentence, the person-column rule, today's date, then the
    executor. The executor validates again; that is its own guard and costs nothing.
    """
    await company_auth.verify_office_access(http_request, company_id)

    sql = request.sql
    ok, message, _reason = validate_query_detailed(sql)
    if not ok:
        raise HTTPException(status_code=400, detail=message)

    named = _NAMES_A_PERSON_COLUMN.search(sql)
    if named:
        raise HTTPException(status_code=400, detail=PERSON_COLUMN_DETAIL.format(column=named.group(1)))

    today = _query_today(sql, request.today)
    result = await sql_executor.execute_sql_query(company_id=company_id, sql=sql, today=today)
    if "error" in result:
        raise _query_failure(result)

    columns: list[str] = list(result["columns"])
    rows: list[dict[str, Any]] = list(result["rows"])
    person = sorted(
        {c for c in columns if _IS_A_PERSON_COLUMN.fullmatch(c)} | _person_columns_in(rows, set())
    )
    if person:
        raise HTTPException(status_code=400, detail=PERSON_COLUMN_DETAIL.format(column=", ".join(person)))

    row_count = int(result["row_count"])
    return DataQueryResult(
        columns=columns,
        rows=rows,
        row_count=row_count,
        row_cap=sql_executor.MAX_ROWS,
        # The executor appends LIMIT MAX_ROWS (or slices to it), so a full page is the one
        # ambiguous case: exactly MAX_ROWS matched, or more did. Said as "may match more".
        capped=row_count >= sql_executor.MAX_ROWS,
    )


@router.get("/{company_id}/schema", response_model=DataSchema)
async def data_schema(company_id: str, http_request: Request):
    """What Jigged's own model writes its SQL against, for a caller writing its own.

    SCHEMA_CONTEXT and semantics.md VERBATIM, from the objects the chat's prompt is built from,
    so there is no second copy to drift. Both are written for the sandbox this route's sibling
    runs in: "do not filter deleted_at" and "$2 is today" hold there exactly as for the chat.
    Company-scoped only for the caller check; the text is the same for every company.
    """
    await company_auth.verify_office_access(http_request, company_id)
    return DataSchema(
        schema_context=SCHEMA_CONTEXT.strip(),
        semantics=load_semantics(),
        query_rules=QUERY_RULES,
        row_cap=sql_executor.MAX_ROWS,
        timeout_seconds=sql_executor.STATEMENT_TIMEOUT_MS / 1000,
    )


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
