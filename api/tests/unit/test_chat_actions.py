"""Jigged chat's actions: the bridge to the MCP tools, and the approval loop around it.

The bridge is tested against a mocked HTTP transport (the route is TypeScript); the loop
against a scripted model, as test_insights_loop_integrity.py does. What matters most:

  * a change never runs before the person approves it, unless they always-allow it
  * what runs is exactly what the card showed -- minus the summary field, which is ours
  * a resumed conversation gets back the tool results it is waiting for, in call order
  * a decline runs nothing
"""
from __future__ import annotations

import itertools
import json
from unittest.mock import patch

import httpx
import pytest

from services.ai_features import insights
from services.ai_features.base import JobContext
from services.chat_actions import (
    APPROVAL_SUMMARY_FIELD,
    DECLINED,
    SESSION_EXPIRED,
    UNREACHABLE,
    ActionOutcome,
    ChatActions,
    ToolSpec,
    app_base_url,
)
from services.llm.base import LLMResult, Message, ToolCall

pytestmark = pytest.mark.unit

_ids = itertools.count()

READ = ToolSpec(
    name="get_quote", title="Get quote", description="Reads a quote.", access="read",
    destructive=False,
    input_schema={"type": "object", "properties": {"quote_id": {"type": "string"}}, "required": ["quote_id"]},
)
WRITE = ToolSpec(
    name="create_quote", title="Create quote", description="Creates a quote.", access="write",
    destructive=False,
    input_schema={"type": "object", "properties": {"customer_id": {"type": "string"}}, "required": ["customer_id"]},
)
ARCHIVE = ToolSpec(
    name="archive_record", title="Archive record", description="Archives a record.", access="write",
    destructive=True, input_schema={"type": "object", "properties": {}},
)


# ------------------------------------------------------------------- the bridge


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def __getattr__(self, _name):
        return lambda *a, **k: self

    def execute(self):
        return type("R", (), {"data": self._rows})()


class _Db:
    def __init__(self, grants=()):
        self.grants = [{"tool_name": g} for g in grants]
        self.upserts: list = []

    def table(self, name):
        assert name == "chat_action_grants"
        db = self

        class _T(_Rows):
            def upsert(self, rows, on_conflict=None):
                db.upserts.append((rows, on_conflict))
                return self

        return _T(self.grants)


def _bridge(handler=None, granted=()):
    def default(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": [{"type": "text", "text": "{}"}], "structuredContent": {}})

    seen: list[httpx.Request] = []

    def recording(request):
        seen.append(request)
        return (handler or default)(request)

    actions = ChatActions(
        base_url="https://jigged.test", token="session-token", company_id="c0", user_id="u1",
        db=_Db(), specs=[READ, WRITE, ARCHIVE], granted=set(granted),
        transport=httpx.MockTransport(recording),
    )
    return actions, seen


def test_the_search_tool_leads_and_every_jigged_tool_is_deferred():
    tools = _bridge()[0].anthropic_tools()
    assert tools[0] == {"type": "tool_search_tool_bm25_20251119", "name": "tool_search_tool_bm25"}
    assert "defer_loading" not in tools[0]
    assert [t["name"] for t in tools[1:]] == ["get_quote", "create_quote", "archive_record"]
    assert all(t["defer_loading"] is True for t in tools[1:])


def test_only_a_change_asks_for_the_sentence_the_person_approves():
    by_name = {t["name"]: t for t in _bridge()[0].anthropic_tools()[1:]}
    assert APPROVAL_SUMMARY_FIELD in by_name["create_quote"]["input_schema"]["required"]
    assert APPROVAL_SUMMARY_FIELD in by_name["create_quote"]["input_schema"]["properties"]
    assert APPROVAL_SUMMARY_FIELD not in json.dumps(by_name["get_quote"])
    # The manifest's own schema is copied, never edited in place.
    assert APPROVAL_SUMMARY_FIELD not in json.dumps(WRITE.input_schema)


def test_a_change_needs_approval_unless_always_allowed_and_a_read_never_does():
    actions, _ = _bridge(granted={"create_quote"})
    assert actions.needs_approval("archive_record") is True
    assert actions.needs_approval("create_quote") is False
    assert actions.needs_approval("get_quote") is False
    assert actions.needs_approval("not_a_tool") is False


async def test_a_call_runs_as_the_person_and_never_sends_the_summary():
    actions, seen = _bridge(lambda r: httpx.Response(200, json={
        "content": [{"type": "text", "text": '{"quote_id": "q-1"}'}],
        "structuredContent": {"quote_id": "q-1", "total": 4200},
    }))
    outcome = await actions.call("create_quote", {"customer_id": "cu-1", APPROVAL_SUMMARY_FIELD: "Create it"})
    assert outcome == ActionOutcome('{"quote_id": "q-1"}', False, {"quote_id": "q-1", "total": 4200})
    request = seen[0]
    assert str(request.url) == "https://jigged.test/chat-tools"
    assert request.headers["authorization"] == "Bearer session-token"
    assert json.loads(request.content) == {
        "company_id": "c0", "tool": "create_quote", "arguments": {"customer_id": "cu-1"},
    }


@pytest.mark.parametrize("status, text", [(401, SESSION_EXPIRED), (500, UNREACHABLE), (404, UNREACHABLE)])
async def test_a_failed_call_is_a_sentence_for_the_model_never_an_exception(status, text):
    actions, _ = _bridge(lambda r: httpx.Response(status, json={}))
    assert await actions.call("create_quote", {}) == ActionOutcome(text, True)


async def test_an_unreachable_route_says_it_is_not_known_whether_it_ran():
    def boom(request):
        raise httpx.ConnectTimeout("slow")

    actions, _ = _bridge(boom)
    assert await actions.call("create_quote", {}) == ActionOutcome(UNREACHABLE, True)


async def test_a_refusal_comes_back_marked_as_an_error():
    actions, _ = _bridge(lambda r: httpx.Response(200, json={
        "content": [{"type": "text", "text": "That customer is archived."}], "isError": True,
    }))
    assert await actions.call("create_quote", {}) == ActionOutcome("That customer is archived.", True, None)


async def test_open_reads_the_manifest_and_the_persons_grants():
    manifest = {"tools": [
        {"name": "create_quote", "title": "Create quote", "description": "d", "access": "write",
         "destructive": False, "input_schema": {"type": "object"}},
    ]}
    transport = httpx.MockTransport(lambda r: httpx.Response(200, json=manifest))
    actions = await ChatActions.open(
        token="t", company_id="c0", user_id="u1", db=_Db(grants=["create_quote"]),
        base_url="https://jigged.test", transport=transport,
    )
    assert actions.knows("create_quote") and not actions.needs_approval("create_quote")


async def test_open_refuses_without_this_deployments_own_origin(monkeypatch):
    monkeypatch.delenv("APP_BASE_URL", raising=False)
    with pytest.raises(RuntimeError):
        await ChatActions.open(token="t", company_id="c0", user_id="u1", db=_Db())


def test_preview_tools_use_the_current_deployment_instead_of_a_shared_alias(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("VERCEL_URL", "jigged-current-pr.vercel.app")
    monkeypatch.setenv("APP_BASE_URL", "https://preview.jigged.app")
    assert app_base_url() == "https://jigged-current-pr.vercel.app"


@pytest.mark.parametrize("host", ["", "https://other.example", "other.example", "jigged.vercel.app/path", "user@jigged.vercel.app"])
def test_preview_without_a_valid_deployment_origin_never_falls_back_to_another_environment(monkeypatch, host):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("VERCEL_URL", host)
    monkeypatch.setenv("APP_BASE_URL", "https://jigged.app")
    assert app_base_url() is None


def test_production_tools_keep_the_configured_origin(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "production")
    monkeypatch.setenv("VERCEL_URL", "jigged-current.vercel.app")
    monkeypatch.setenv("APP_BASE_URL", "https://jigged.app/")
    assert app_base_url() == "https://jigged.app"


async def test_protected_preview_can_load_and_call_tools_as_the_person(monkeypatch):
    monkeypatch.setenv("VERCEL_ENV", "preview")
    monkeypatch.setenv("VERCEL_URL", "jigged-current-pr.vercel.app")
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-bypass-secret")
    seen = []

    def respond(request):
        seen.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"tools": []})
        return httpx.Response(200, json={"structuredContent": {"ok": True}})

    actions = await ChatActions.open(
        token="session-token", company_id="c0", user_id="u1", db=_Db(),
        transport=httpx.MockTransport(respond),
    )
    outcome = await actions.call("create_quote", {})
    assert not outcome.is_error
    assert [r.method for r in seen] == ["GET", "POST"]
    for request in seen:
        assert str(request.url) == "https://jigged-current-pr.vercel.app/chat-tools"
        assert request.headers["authorization"] == "Bearer session-token"
        assert request.headers["x-vercel-protection-bypass"] == "test-bypass-secret"
        assert "test-bypass-secret" not in str(request.url)
        assert "test-bypass-secret" not in request.content.decode()


@pytest.mark.parametrize("environment, host", [("production", "jigged.test"), ("preview", "different.vercel.app")])
async def test_preview_bypass_is_never_sent_to_another_origin_or_production(monkeypatch, environment, host):
    monkeypatch.setenv("VERCEL_ENV", environment)
    monkeypatch.setenv("VERCEL_URL", host)
    monkeypatch.setenv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-bypass-secret")
    actions, seen = _bridge()
    await actions.call("get_quote", {})
    assert "x-vercel-protection-bypass" not in seen[0].headers


# ---------------------------------------------------------------------- the loop


class FakeActions:
    """The bridge, minus HTTP: the specs, the grants, and a record of every call."""

    def __init__(self, granted=(), outcomes=None):
        self._real = ChatActions(
            base_url="https://jigged.test", token="t", company_id="c0", user_id="u1", db=None,
            specs=[READ, WRITE, ARCHIVE], granted=set(granted),
        )
        self.calls: list[tuple[str, dict]] = []
        self.outcomes = dict(outcomes or {})

    def knows(self, name):
        return self._real.knows(name)

    def spec(self, name):
        return self._real.spec(name)

    def needs_approval(self, name):
        return self._real.needs_approval(name)

    def anthropic_tools(self):
        return self._real.anthropic_tools()

    async def call(self, name, arguments):
        args = {k: v for k, v in arguments.items() if k != APPROVAL_SUMMARY_FIELD}
        self.calls.append((name, args))
        return self.outcomes.get(name, ActionOutcome('{"ok": true}', False, {"ok": True}))


def _calls(*calls: tuple[str, dict]) -> LLMResult:
    return LLMResult(
        text="",
        tool_calls=[ToolCall(id=f"call_{next(_ids)}", name=n, arguments=a) for n, a in calls],
        model="m", provider="p", tokens_in=10, tokens_out=5,
    )


def _answer(text: str) -> LLMResult:
    return LLMResult(text=text, model="m", provider="p", tokens_in=10, tokens_out=5)


class Script:
    def __init__(self, turns, tool_results=()):
        self.turns = list(turns)
        self.tool_results = list(tool_results)
        self.seen: list[list[Message]] = []
        self.tools_offered: list = []

    async def complete(self, feature, messages, **kwargs):
        self.seen.append(list(messages))
        self.tools_offered.append(kwargs.get("tools"))
        return self.turns.pop(0)

    async def run_tool(self, company_id, call, today, dsn=None):
        return self.tool_results.pop(0)


async def _run(script: Script, actions, payload=None, resume=None):
    with patch.object(insights.llm, "complete", script.complete), \
         patch.object(insights, "_run_tool", script.run_tool), \
         patch("services.insights_service._build_chat_system_prompt", return_value="SYSTEM"):
        return await insights.run(JobContext(
            feature="insights", company_id="c0", request_id="rid",
            payload=payload or {"question": "make a quote for Acme", "today": "2026-11-09"},
            actions=actions, resume=resume,
        ))


PROPOSE = (
    "create_quote",
    {"customer_id": "cu-1", APPROVAL_SUMMARY_FIELD: "Create a quote for Acme Corp, 3 lines, $4,200."},
)


async def test_a_change_stops_and_waits_without_running():
    actions = FakeActions()
    script = Script([_calls(PROPOSE)])
    result = await _run(script, actions)

    assert actions.calls == []
    [pending] = result["pending_actions"]
    assert pending["tool"] == "create_quote"
    assert pending["summary"] == "Create a quote for Acme Corp, 3 lines, $4,200."
    assert pending["arguments"] == {"customer_id": "cu-1"}
    assert result["answer"] == "This needs your approval before it runs: Create a quote for Acme Corp, 3 lines, $4,200."
    state = result["resume_state"]
    assert state["question"] == "make a quote for Acme"
    # The conversation as it stopped, ending on the assistant turn that holds the call.
    assert state["messages"][-1]["role"] == "assistant"
    assert state["messages"][-1]["tool_calls"][0]["name"] == "create_quote"
    # The actions section and the tools reached the model.
    assert any("ACTIONS." in m.text() for m in script.seen[0] if m.role == "system")
    assert script.tools_offered[0][-1]["name"] == "archive_record"


async def test_an_always_allowed_change_runs_at_once():
    actions = FakeActions(granted={"create_quote"})
    result = await _run(Script([_calls(PROPOSE), _answer("Done: the quote is created.")]), actions)
    assert actions.calls == [("create_quote", {"customer_id": "cu-1"})]
    assert "pending_actions" not in result
    assert result["answer"] == "Done: the quote is created."


async def test_a_lookup_runs_at_once_and_its_figures_ground_the_answer():
    actions = FakeActions(outcomes={"get_quote": ActionOutcome('{"total": 4200}', False, {"total": 4200})})
    script = Script([_calls(("get_quote", {"quote_id": "q-1"})), _answer("That quote totals $4,200.")])
    result = await _run(script, actions)
    assert actions.calls == [("get_quote", {"quote_id": "q-1"})]
    assert result["answer"] == "That quote totals $4,200."


async def _paused_then(decision: str, actions: FakeActions, final: str = "Done."):
    first = await _run(Script([_calls(PROPOSE)]), FakeActions())
    script = Script([_answer(final)])
    result = await _run(
        script, actions,
        payload={"question": "Approved: Create a quote", "today": "2026-11-09"},
        resume={"state": first["resume_state"], "pending": first["pending_actions"], "decision": decision},
    )
    return first, script, result


@pytest.mark.parametrize("decision", ["approve", "always"])
async def test_an_approved_change_runs_exactly_as_shown_and_the_model_hears_the_result(decision):
    actions = FakeActions(outcomes={"create_quote": ActionOutcome('{"quote_number": "Q-1042"}', False, {})})
    first, script, result = await _paused_then(decision, actions, final="Created quote Q-1042 for Acme.")
    assert actions.calls == [("create_quote", first["pending_actions"][0]["arguments"])]
    seen = script.seen[0]
    # The stopped assistant turn, then exactly one tool result for its one call.
    assert seen[-2].role == "assistant" and seen[-2].tool_calls[0].name == "create_quote"
    assert seen[-1].role == "tool" and seen[-1].tool_call_id == seen[-2].tool_calls[0].id
    assert seen[-1].text() == '{"quote_number": "Q-1042"}'
    assert result["answer"] == "Created quote Q-1042 for Acme."
    assert {"tool": "create_quote", "outcome": "ok"} in result["tool_trace"]


async def test_a_decline_runs_nothing_and_says_so_to_the_model():
    actions = FakeActions()
    _, script, result = await _paused_then("decline", actions, final="Okay, I left it alone.")
    assert actions.calls == []
    assert script.seen[0][-1].text() == DECLINED
    assert {"tool": "create_quote", "outcome": "declined"} in result["tool_trace"]


async def test_what_ran_beside_a_held_change_is_kept_for_the_resume_in_call_order():
    actions = FakeActions()
    turn = _calls(("execute_sql", {"sql": "SELECT 1", "description": "d"}), PROPOSE)
    first = await _run(Script([turn], tool_results=[{"columns": ["n"], "rows": [{"n": 3}], "row_count": 1}]), actions)
    assert [r["tool_call_id"] for r in first["resume_state"]["results"]] == [turn.tool_calls[0].id]

    script = Script([_answer("Done.")])
    await _run(
        script, FakeActions(),
        payload={"question": "Approved: x", "today": "2026-11-09"},
        resume={"state": first["resume_state"], "pending": first["pending_actions"], "decision": "approve"},
    )
    tool_turns = [m for m in script.seen[0] if m.role == "tool"]
    assert [m.tool_call_id for m in tool_turns] == [c.id for c in turn.tool_calls]


async def test_without_the_bridge_the_chat_is_read_only_as_before():
    from tools.chat_tools import CHAT_TOOLS

    script = Script([_answer("Nothing to do.")])
    await _run(script, None)
    assert script.tools_offered[0] is CHAT_TOOLS
    assert not any("ACTIONS." in m.text() for m in script.seen[0] if m.role == "system")


# ------------------------------------------------------------- deciding: who and when


class _JobsDb:
    """ai_jobs for _waiting_job: the parent by id, and 'anything later in the thread'."""

    def __init__(self, parent, later=()):
        self.parent = parent
        self.later = list(later)

    def table(self, name):
        assert name == "ai_jobs"
        db = self

        class _Q:
            def __init__(self):
                self.filters = {}

            def select(self, *_a):
                return self

            def eq(self, col, val):
                self.filters[col] = val
                return self

            def gt(self, col, val):
                self.filters["later"] = True
                return self

            def limit(self, _n):
                return self

            def execute(self):
                if self.filters.get("later"):
                    rows = db.later
                else:
                    rows = [db.parent] if db.parent and db.parent["id"] == self.filters.get("id") else []
                return type("R", (), {"data": rows})()

        return _Q()


def _parent(**over):
    row = {
        "id": "job-1", "company_id": "c0", "requested_by": "u1", "thread_id": "t1", "kind": "chat",
        "status": "succeeded", "created_at": "2026-11-09T10:00:00Z",
        "result": {"pending_actions": [{"id": "x", "tool": "create_quote"}], "resume_state": {"messages": []}},
    }
    row.update(over)
    return row


def test_the_asker_may_decide_on_the_newest_turn():
    from routes.insights_routes import _waiting_job

    assert _waiting_job(_JobsDb(_parent()), "c0", "job-1", "u1")["id"] == "job-1"


@pytest.mark.parametrize("parent, user", [
    pytest.param(_parent(requested_by="someone-else"), "u1", id="a-colleague"),
    pytest.param(_parent(requested_by=None), "u1", id="nobody-recorded"),
    pytest.param(_parent(company_id="other"), "u1", id="another-company"),
    pytest.param(None, "u1", id="no-such-job"),
])
def test_nobody_else_may_and_it_reads_as_not_found(parent, user):
    from fastapi import HTTPException

    from routes.insights_routes import _waiting_job

    with pytest.raises(HTTPException) as exc:
        _waiting_job(_JobsDb(parent), "c0", "job-1", user)
    assert exc.value.status_code == 404


@pytest.mark.parametrize("parent, later", [
    pytest.param(_parent(), [{"id": "job-2"}], id="the-conversation-moved-on"),
    pytest.param(_parent(result={"answer": "x"}), [], id="nothing-was-waiting"),
    pytest.param(_parent(status="failed"), [], id="the-job-failed"),
    pytest.param(_parent(kind="report"), [], id="a-report"),
])
def test_a_change_no_longer_waiting_cannot_be_decided(parent, later):
    from fastapi import HTTPException

    from routes.insights_routes import _waiting_job

    with pytest.raises(HTTPException) as exc:
        _waiting_job(_JobsDb(parent, later), "c0", "job-1", "u1")
    assert exc.value.status_code == 409
