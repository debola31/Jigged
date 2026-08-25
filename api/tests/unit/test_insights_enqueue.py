"""The insights route after it stopped answering questions itself.

It now enqueues and returns a job id. What still has to be true: the flag and the
rate limit remain the ONLY door to creating work, every typed failure maps to a
status a human sentence can go with, and that sentence is a plain string.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from fastapi import HTTPException

from models.insights_models import ChatRequest
from routes import insights_routes as routes
from services import ai_jobs
from services.llm.errors import (
    LLMChainExhausted,
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

    async def _post(self, question="how many jobs are late?"):
        return await routes.chat("co-1", ChatRequest(question=question))

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
