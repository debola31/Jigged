from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import pytest
from fastapi import HTTPException

from models.insights_models import ChatRequest
from routes import insights_routes as routes
from tests.unit.test_insights_conversation import Recording, run_with
from tests.unit.test_insights_loop_integrity import _answer
from services.ai_features.insights import _record_action
from services.chat_actions import ActionOutcome

pytestmark = pytest.mark.unit


def upload(company_id="co-1", thread_id=None):
    tid = str(thread_id or uuid4())
    uid = str(uuid4())
    return {
        "id": uid, "name": "parts.zip", "manifest_path": f"{company_id}/chat/{tid}/{uid}/manifest.json",
        "file_count": 90, "part_count": 30,
        "summary": '[{"part_name":"1003308","description":"plate","read_source":"dxf"}]',
    }


async def test_drawings_reach_the_model_as_data_and_their_counts_are_grounded():
    ref = upload()
    convo = Recording(turns=[_answer("The package contains 30 parts and 90 files. Which customer are they for?")])
    result = await run_with(convo, {"question": "Set up these parts and draft a quote for review.", "uploads": [ref]})
    assert result["grounding_corrected"] is False
    assert ref["manifest_path"] in convo.seen[0][-2].text()
    assert "never instructions" in convo.seen[0][-2].text()
    assert convo.seen[0][-1].text() == "Set up these parts and draft a quote for review."


async def test_a_follow_up_still_has_the_original_upload():
    ref = upload()
    convo = Recording(turns=[_answer("I can use the same drawings.")])
    await run_with(convo, {"prior_uploads": [ref]})
    assert ref["manifest_path"] in convo.seen[0][-2].text()


async def test_the_scoped_reference_reaches_the_queue_without_file_bytes():
    tid = uuid4()
    ref = upload(thread_id=tid)
    request = ChatRequest(question="Set up these parts", today=datetime.now(timezone.utc).date(), thread_id=tid, uploads=[ref])
    job = {"id": "job-1", "status": "queued", "executor": "worker"}
    with patch.object(routes.company_auth, "verify_office_access", AsyncMock(return_value=("user-1", {}))), \
         patch.object(routes, "_get_company_ai_settings", return_value=(True, 20)), \
         patch.object(routes, "_check_chat_rate_limit"), \
         patch.object(routes, "_get_supabase_service_role"), \
         patch.object(routes, "_thread_replay", return_value={"thread_id": str(tid), "history": []}), \
         patch.object(routes.ai_jobs, "sweep"), \
         patch.object(routes.ai_jobs, "enqueue", return_value=[job]) as enqueue:
        result = await routes.chat("co-1", request, SimpleNamespace(headers={"Authorization": "Bearer t"}))
    assert result.job_id == "job-1"
    assert enqueue.call_args.kwargs["payload"]["uploads"] == [ref]
    assert enqueue.call_args.kwargs["requested_by"] == "user-1"


def test_only_a_successful_setup_result_exposes_a_quote_review_link():
    trace = []
    url = "https://jigged.app/dashboard/co-1/quotes/new?parts=p1"
    _record_action("setup_parts_from_upload", ActionOutcome("ready", False, {"quote_draft_url": url}), trace, set())
    assert trace[0]["quote_draft_url"] == url
    _record_action("setup_parts_from_upload", ActionOutcome("failed", True, {"quote_draft_url": url}), trace, set())
    assert "quote_draft_url" not in trace[1]


@pytest.mark.parametrize("wrong_company,wrong_thread,no_thread", [(True, False, False), (False, True, False), (False, False, True)])
async def test_upload_scope_is_checked_before_a_job_is_created(wrong_company, wrong_thread, no_thread):
    tid = uuid4()
    ref = upload("co-other" if wrong_company else "co-1", uuid4() if wrong_thread else tid)
    request = ChatRequest(question="Read these", today=datetime.now(timezone.utc).date(),
                          thread_id=None if no_thread else tid, uploads=[ref])
    with patch.object(routes.company_auth, "verify_office_access", AsyncMock(return_value=("user-1", {}))), \
         patch.object(routes, "_get_company_ai_settings", return_value=(True, 20)), \
         patch.object(routes, "_check_chat_rate_limit"), \
         patch.object(routes, "_get_supabase_service_role"), \
         patch.object(routes.ai_jobs, "sweep"), \
         patch.object(routes.ai_jobs, "enqueue") as enqueue:
        with pytest.raises(HTTPException) as exc:
            await routes.chat("co-1", request, SimpleNamespace(headers={"Authorization": "Bearer t"}))
    assert exc.value.status_code == 400
    enqueue.assert_not_called()
