"""The insights route after it stopped answering questions itself.

It now enqueues and returns a job id. What still has to be true: the flag and the
rate limit remain the ONLY door to creating work, every typed failure maps to a
status a human sentence can go with, and that sentence is a plain string.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from models.insights_models import ChatRequest
from routes import insights_routes as routes
from services import ai_jobs
from services.llm.errors import (
    LLMChainExhausted,
    LLMErrorEcho,
    LLMNotConfigured,
    LLMRequestError,
    LLMTimeout,
    LLMToolLoopExhausted,
    LLMProviderError,
)

pytestmark = pytest.mark.unit


ALL_FAILURES = [
    ai_jobs.AiUnavailable("The AI box is offline right now."),
    LLMRequestError("bad call"),
    LLMNotConfigured("no chain"),
    LLMChainExhausted("insights", "rid", [LLMTimeout("slow", provider="ollama")]),
    LLMChainExhausted("insights", "rid", [LLMProviderError("500", provider="anthropic")]),
    LLMToolLoopExhausted("too many turns"),
    LLMErrorEcho("the final turn was the tool's error text"),
    RuntimeError("something else entirely"),
]


@pytest.mark.parametrize("exc", ALL_FAILURES, ids=lambda e: type(e).__name__)
def test_every_failure_maps_to_a_plain_string_detail(exc):
    """utils/insightsAccess.ts does `new Error(errorData.detail)` and renders the
    message straight into an Alert. A dict detail shows the user "[object Object]",
    and nothing in the type system stops one being added later."""
    mapped = routes._map_llm_error(exc)
    assert isinstance(mapped, HTTPException)
    assert isinstance(mapped.detail, str) and mapped.detail
    assert mapped.detail == mapped.detail.strip()


def test_an_offline_local_chain_is_a_503_and_says_what_still_works():
    """Not a 502. A desktop that is asleep is expected downtime -- Sentry captures
    5xx, and paging on someone's box being off trains the alert away."""
    exc = LLMChainExhausted("insights", "rid", [LLMTimeout("no answer", provider="ollama")])
    mapped = routes._map_llm_error(exc)
    assert mapped.status_code == 503
    assert "still works" in mapped.detail


def test_a_hosted_provider_failing_is_a_502_because_that_one_is_ours():
    exc = LLMChainExhausted("insights", "rid", [LLMProviderError("500", provider="anthropic")])
    assert routes._map_llm_error(exc).status_code == 502


def test_no_error_message_leaks_a_vendor_name_to_the_user():
    """A machinist should not read "DeepInfra 429". The provider detail goes to the
    log and to Sentry; the browser gets a sentence about their shop."""
    for exc in ALL_FAILURES:
        detail = routes._map_llm_error(exc).detail.lower()
        for vendor in ("deepinfra", "ollama", "anthropic", "qwen", "claude"):
            assert vendor not in detail, f"{type(exc).__name__} leaked {vendor!r}"


@pytest.mark.parametrize("exc, kind", [
    (LLMChainExhausted("insights", "r", [LLMTimeout("s", provider="ollama")]), "ai_offline"),
    (LLMChainExhausted("insights", "r", [LLMProviderError("s", provider="anthropic")]), "provider"),
    (LLMNotConfigured("none"), "ai_offline"),
    # Its own kind, not 'internal'. A model reading a database error back is not
    # a bug in our code, and the whole reason the gate exists is so this failure
    # can be counted -- which needs it to be separable in the job rows.
    (LLMErrorEcho("echoed the tool error"), "error_echo"),
    (RuntimeError("?"), "internal"),
])
def test_the_error_kind_separates_downtime_from_an_incident(exc, kind):
    """error_kind is what the frontend reads to choose between "the box is offline"
    and "that failed", and what decides whether Sentry hears about it."""
    assert routes._error_kind(exc) == kind


class TestTheOnlyDoor:
    """Exactly one thing may create an ai_jobs row. These are the locks on it.

    Calls the handler directly rather than over the ASGI client: conftest's
    `client` fixture depends on auth_token -> test_user -> supabase_admin, and
    THAT fixture calls pytest.exit (not skip) when TEST_SUPABASE_URL is unset --
    aborting the whole session. A unit file must never reach it.
    """

    async def _post(self, question="how many jobs are late?", today=None):
        # `today` is the caller's LOCAL date and is required: the sandbox binds it
        # as $2 and refuses CURRENT_DATE, so there is no server-side fallback to
        # fall back TO. Defaulted to the server's own date here so these tests stay
        # about the door, not about the clock -- _client_today's own rules are
        # pinned in TestTheClientsDate below.
        return await routes.chat(
            "co-1",
            ChatRequest(
                question=question,
                today=today or datetime.now(timezone.utc).date(),
            ),
        )

    async def test_a_disabled_company_cannot_enqueue(self):
        with patch.object(routes, "_get_company_ai_settings", return_value=(False, 20)), \
             patch.object(routes.ai_jobs, "enqueue") as enqueue:
            with pytest.raises(HTTPException) as exc:
                await self._post()
        assert exc.value.status_code == 403
        enqueue.assert_not_called()

    async def test_an_over_limit_company_cannot_enqueue(self):
        """The cap is on the door, not on the worker. A queue that could be filled
        past the limit and drained later would make the limit decorative."""
        with patch.object(routes, "_get_company_ai_settings", return_value=(True, 20)), \
             patch.object(routes, "_check_chat_rate_limit",
                          side_effect=HTTPException(status_code=429, detail="Rate limit exceeded.")), \
             patch.object(routes.ai_jobs, "enqueue") as enqueue:
            with pytest.raises(HTTPException) as exc:
                await self._post()
        assert exc.value.status_code == 429
        enqueue.assert_not_called()

    async def test_an_offline_box_creates_no_job_at_all(self):
        """The enqueue response is the AUTHORITATIVE offline signal -- the browser's
        heartbeat read is only a proactive hint. A job created against a dead worker
        would sit queued until the sweep, showing a spinner for nothing."""
        with patch.object(routes, "_get_company_ai_settings", return_value=(True, 20)), \
             patch.object(routes, "_check_chat_rate_limit"), \
             patch.object(routes, "_get_supabase_service_role"), \
             patch.object(routes.ai_jobs, "sweep", return_value=0), \
             patch.object(routes.ai_jobs, "enqueue",
                          side_effect=ai_jobs.AiUnavailable("The AI box is offline right now.")):
            with pytest.raises(HTTPException) as exc:
                await self._post()
        assert exc.value.status_code == 503
        assert "offline" in exc.value.detail

    async def test_a_worker_routed_job_returns_immediately_without_running_anything(self):
        job = {"id": "job-1", "status": "queued", "executor": "worker",
               "feature": "insights", "request_id": "r", "payload": {}}
        with patch.object(routes, "_get_company_ai_settings", return_value=(True, 20)), \
             patch.object(routes, "_check_chat_rate_limit"), \
             patch.object(routes, "_get_supabase_service_role"), \
             patch.object(routes.ai_jobs, "sweep", return_value=0), \
             patch.object(routes.ai_jobs, "enqueue", return_value=[job]), \
             patch.object(routes, "_run_inline") as inline:
            res = await self._post()
        assert res.job_id == "job-1" and res.executor == "worker"
        inline.assert_not_called()

    async def test_a_backend_routed_job_is_worked_before_the_response_returns(self):
        """Unmigrated surfaces still run inline, but through the SAME lifecycle --
        so the browser polls one state machine regardless of who answered."""
        job = {"id": "job-2", "status": "queued", "executor": "backend",
               "feature": "insights", "request_id": "r", "payload": {}}
        with patch.object(routes, "_get_company_ai_settings", return_value=(True, 20)), \
             patch.object(routes, "_check_chat_rate_limit"), \
             patch.object(routes, "_get_supabase_service_role"), \
             patch.object(routes.ai_jobs, "sweep", return_value=0), \
             patch.object(routes.ai_jobs, "enqueue", return_value=[job]), \
             patch.object(routes, "_run_inline") as inline:
            res = await self._post()
        assert res.executor == "backend"
        inline.assert_awaited_once()

    async def test_the_sweep_runs_on_the_enqueue_path(self):
        """The only place a stuck BACKEND row can be collected: the worker's sweep
        is scoped by RLS to executor='worker', and a user watching a spinner is by
        definition not enqueueing."""
        job = {"id": "j", "status": "queued", "executor": "worker",
               "feature": "insights", "request_id": "r", "payload": {}}
        with patch.object(routes, "_get_company_ai_settings", return_value=(True, 20)), \
             patch.object(routes, "_check_chat_rate_limit"), \
             patch.object(routes, "_get_supabase_service_role"), \
             patch.object(routes.ai_jobs, "sweep", return_value=0) as sweep, \
             patch.object(routes.ai_jobs, "enqueue", return_value=[job]):
            await self._post()
        sweep.assert_called_once()


class TestTheClientsDate:
    """`today` comes from the browser, so it is checked before it is used.

    WHY IT COMES FROM THE BROWSER AT ALL. This database runs in UTC. For a shop in
    the Americas that means UTC has already rolled into tomorrow for the last hours
    of every working day, so anything computed from the server clock calls a job
    late before the shop's day is over. The jobs list has always sent the browser's
    date into SQL as p_today; the chat now sends the same value, and the sandbox
    binds it as $2 with CURRENT_DATE refused outright.

    WHY IT IS CHECKED. Trusting it outright lets a caller name any "today" and get a
    confidently wrong answer about what is overdue. Ignoring it puts us back on UTC.
    So: believe it within a day, refuse outside that.
    """

    def _today(self, offset_days=0):
        return datetime.now(timezone.utc).date() + timedelta(days=offset_days)

    @pytest.mark.parametrize("offset", [-1, 0, 1])
    def test_any_real_timezone_is_accepted(self, offset):
        # UTC-12 through UTC+14 means two calendar dates are live at any instant,
        # so a legitimate client is never more than a day either side.
        assert routes._client_today(self._today(offset)) == self._today(offset)

    @pytest.mark.parametrize("offset", [-2, 2, -400, 4000])
    def test_a_date_no_timezone_could_produce_is_refused(self, offset):
        with pytest.raises(HTTPException) as exc:
            routes._client_today(self._today(offset))
        assert exc.value.status_code == 400

    def test_the_refusal_does_not_quietly_substitute_a_date(self):
        """A substituted date would be the original bug in a new place.

        Silently using the server's date here would mean the answer disagrees with
        the screen and nobody is told -- which is exactly the class of failure this
        parameter exists to remove. Fail loudly instead.
        """
        with pytest.raises(HTTPException):
            routes._client_today(self._today(5))

    def test_the_message_tells_the_user_what_to_fix(self):
        with pytest.raises(HTTPException) as exc:
            routes._client_today(self._today(9))
        assert "clock" in exc.value.detail.lower()
        # No SQL, no parameter names, no "$2" -- a shop owner reads this.
        assert "$2" not in exc.value.detail


class TestTheDateReachesTheQueue:
    """The date rides on the ai_jobs row, not on a handler argument.

    That is the one place that makes the desktop worker behave identically without
    a second piece of wiring: the worker claims a row and gets its payload, nothing
    else. A `today` passed only to the inline path would leave a local model
    answering from the UTC clock while the hosted one did not.
    """

    async def test_the_payload_carries_the_callers_date(self):
        with patch.object(routes, "_get_company_ai_settings", return_value=(True, 20)), \
             patch.object(routes, "_check_chat_rate_limit"), \
             patch.object(routes, "_get_supabase_service_role"), \
             patch.object(routes.ai_jobs, "sweep"), \
             patch.object(routes.ai_jobs, "enqueue") as enqueue:
            enqueue.return_value = [
                {"id": "j1", "status": "queued", "executor": "worker",
                 "payload": {}, "request_id": "r", "feature": "insights"}
            ]
            await routes.chat(
                "co-1",
                ChatRequest(question="how many jobs are late?",
                            today=datetime.now(timezone.utc).date()),
            )

        payload = enqueue.call_args.kwargs["payload"]
        assert payload["today"] == datetime.now(timezone.utc).date().isoformat(), (
            "the caller's date must be on the job row -- the desktop worker sees "
            "nothing else"
        )
        assert payload["question"] == "how many jobs are late?"
