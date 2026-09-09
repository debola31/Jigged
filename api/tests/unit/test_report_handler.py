"""The report handler: gather with the same loop, compose once, then let code decide.

THE PROPERTY THAT MATTERS: every number the report asserts appeared in a query
result of this job. A model that writes a plausible total it never computed is
the executive-summary version of "$X on $Y of revenue" -- a confident figure the
owner cannot check -- and it is refused by construction, not by asking nicely.
"""
from __future__ import annotations

import json
from unittest.mock import patch

import pytest

from models.report_spec import ReportSpec
from services.ai_features import insights, report
from services.ai_features.base import JobContext
from services.insights_presentation import CHART_EXEMPLAR
from services.ai_features.base import result_kind
from services.llm.base import LLMResult, ToolCall
from services.llm.errors import LLMErrorEcho
from tests.unit.test_insights_conversation import Recording
from tests.unit.test_insights_loop_integrity import SQL_FAILED, SQL_OK, _answer, _asks_for_sql
from tools.chat_tools import CHAT_TOOLS, COMPOSE_REPORT_TOOL

pytestmark = pytest.mark.unit

ROWS = {
    "columns": ["month", "booked", "jobs"],
    "rows": [
        {"month": "2026-06-01", "booked": "13367.00", "jobs": 10},
        {"month": "2026-07-01", "booked": "34444.00", "jobs": 38},
        {"month": "2026-08-01", "booked": "48971.00", "jobs": 33},
        {"month": "total", "booked": "96782.00", "jobs": 81},
    ],
    "row_count": 4,
    "description": "booked by month",
}


def _report(**over) -> dict:
    base = {
        "title": "OPERATIONS SUMMARY",
        "period_start": "2026-06-01", "period_end": "2026-08-31", "period_label": "Jun–Aug 2026",
        "headline": "Booked $96,782 across 81 jobs.",
        "kpis": [{"label": "Booked", "value": 96782, "format": "currency", "caption": "81 jobs"}],
        "blocks": [{
            "type": "chart", "title": "Booked by month", "chart_type": "bar",
            "x_label": "Month", "y_label": "Booked ($)",
            "points": [{"label": "Jun", "value": 13367}, {"label": "Jul", "value": 34444},
                       {"label": "Aug", "value": 48971}],
            "note": None,
        }],
    }
    base.update(over)
    return base


def _composed(spec: dict) -> LLMResult:
    return LLMResult(text=json.dumps(spec), model="m", provider="p", tokens_in=100, tokens_out=50)


async def run_report(convo: Recording, request: str = "operations summary for June to August") -> dict:
    with patch.object(report.llm, "complete", convo.complete), \
         patch.object(insights, "_run_tool", convo.run_tool), \
         patch("services.insights_service._build_chat_system_prompt", return_value="SYSTEM"):
        return await insights.run(JobContext(
            feature="insights", company_id="c0", request_id="rid",
            payload={"kind": "report", "request": request, "today": "2026-09-07"},
        ))


# ------------------------------------------------------------------ dispatch


async def test_a_report_payload_is_dispatched_by_kind_and_shares_the_system_turn():
    convo = Recording(turns=[_asks_for_sql(), _answer("READY"), _composed(_report())], tool_results=[ROWS])
    result = await run_report(convo)

    assert "report" in result and result["report"]["title"] == "OPERATIONS SUMMARY"
    # Every call starts with the identical system turn: the prefix chat jobs cached.
    assert {seen[0].text() for seen in convo.seen} == {"SYSTEM"}
    assert report.REPORT_BRIEF in convo.seen[0][1].text()
    assert "operations summary for June to August" in convo.seen[0][1].text()


async def test_the_request_turn_states_todays_date_in_words():
    """$2 is a bind parameter whose value the model never sees, and a report has to
    write period_start and period_end as literal dates. The second live run, asked
    for "June to September", dated them 2023 and summarised a quarter with no data."""
    convo = Recording(turns=[_asks_for_sql(), _answer("READY"), _composed(_report())], tool_results=[ROWS])
    await run_report(convo)

    first = convo.seen[0][1].text()
    assert "Today is 2026-09-07." in first
    assert first.index("Today is 2026-09-07.") < first.index("The request:")
    assert "most recent such months on or before today" in report.REPORT_BRIEF


async def test_the_compose_call_is_schema_constrained_and_carries_no_tools():
    convo = Recording(turns=[_asks_for_sql(), _answer("READY"), _composed(_report())], tool_results=[ROWS])
    await run_report(convo)

    gather, ready, compose = convo.kwargs
    assert gather["tools"] and ready["tools"]
    assert compose["json_schema"] is ReportSpec
    assert compose.get("tools") is None
    assert compose["max_tokens"] == report.REPORT_MAX_TOKENS
    # The gathered results are in front of the compose request.
    assert any(m.role == "tool" for m in convo.seen[2])
    assert convo.seen[2][-1].text() == report.COMPOSE_REQUEST


# ------------------------------------------------------------- traceability


async def test_every_figure_traces_to_a_query_result_including_counts_and_decimals():
    convo = Recording(turns=[_asks_for_sql(), _answer("READY"), _composed(_report())], tool_results=[ROWS])
    result = await run_report(convo)
    assert result["dropped"] == []
    assert result["report"]["kpis"][0]["value"] == 96782


async def test_an_invented_figure_earns_one_repair_then_fails_the_job():
    invented = _report(kpis=[{"label": "Booked", "value": 123456, "format": "currency", "caption": None}])
    convo = Recording(
        turns=[_asks_for_sql(), _answer("READY"), _composed(invented), _composed(invented)],
        tool_results=[ROWS],
    )
    with pytest.raises(LLMErrorEcho) as exc:
        await run_report(convo)

    assert "ungrounded_figures" in str(exc.value) and "123456" in str(exc.value)
    assert convo.calls == 4
    repair = convo.seen[3][-1].text()
    assert "appear in no query result" in repair and "123456" in repair


async def test_a_repaired_report_is_accepted():
    invented = _report(kpis=[{"label": "Booked", "value": 123456, "format": "currency", "caption": None}])
    convo = Recording(
        turns=[_asks_for_sql(), _answer("READY"), _composed(invented), _composed(_report())],
        tool_results=[ROWS],
    )
    result = await run_report(convo)
    assert result["report"]["kpis"][0]["value"] == 96782


async def test_a_copied_value_rounded_to_the_cent_is_a_copy_not_an_invention():
    rows = {**ROWS, "rows": [{"avg": "4774.8211"}, {"avg": "1.0"}, {"avg": "2.0"}], "row_count": 3}
    rounded = _report(kpis=[{"label": "Average job", "value": 4774.82, "format": "currency", "caption": None}],
                      blocks=[{"type": "text", "body": "Average job value held near $4,775."}])
    convo = Recording(turns=[_asks_for_sql(), _answer("READY"), _composed(rounded)], tool_results=[rows])
    result = await run_report(convo)
    assert result["report"]["kpis"][0]["value"] == 4774.82


def test_untraceable_figures_reads_kpis_cells_totals_and_points():
    spec = ReportSpec.model_validate(_report(blocks=[{
        "type": "table", "title": "T",
        "columns": [{"label": "A", "format": "plain"}, {"label": "B", "format": "integer"}],
        "rows": [["x", 10]], "total_row": ["Total", 999], "note": None,
    }]))
    bad = report.untraceable_figures(spec, {96782.0, 10.0})
    assert [x for _, x in bad] == [999.0]


# ------------------------------------------------------------- the gates


async def test_no_successful_query_means_no_report():
    convo = Recording(turns=[_asks_for_sql(), _answer("READY"), _asks_for_sql(), _answer("READY")],
                      tool_results=[SQL_FAILED, SQL_FAILED])
    with pytest.raises(LLMErrorEcho) as exc:
        await run_report(convo)
    assert "report_no_data" in str(exc.value)


async def test_a_chart_block_becomes_a_chart_config_the_renderer_already_knows():
    convo = Recording(turns=[_asks_for_sql(), _answer("READY"), _composed(_report())], tool_results=[ROWS])
    result = await run_report(convo)
    chart = result["report"]["blocks"][0]
    assert chart["type"] == "chart"
    cfg = chart["chart_config"]
    assert (cfg["x_key"], cfg["y_key"]) == ("label", "value")
    assert cfg["data"][0] == {"label": "Jun", "value": 13367}
    assert cfg["chart_type"] in ("bar", "bar_horizontal", "area")


async def test_a_chart_block_the_chart_gate_refuses_is_dropped_and_named():
    """All-equal values are a flat, uninformative chart: the chat gate says prose.
    The block goes, the report stays, and the footer will say what is not shown."""
    flat = _report(blocks=[
        {"type": "chart", "title": "Flat", "chart_type": "bar", "x_label": "x", "y_label": "y",
         "points": [{"label": "a", "value": 10}, {"label": "b", "value": 10}, {"label": "c", "value": 10}],
         "note": None},
        {"type": "text", "body": "Booked held steady through the summer."},
    ])
    rows = {**ROWS, "rows": ROWS["rows"] + [{"month": "x", "booked": "10", "jobs": 10}]}
    convo = Recording(turns=[_asks_for_sql(), _answer("READY"), _composed(flat)], tool_results=[rows])
    result = await run_report(convo)
    assert result["dropped"] == ["Flat"]
    assert [b["type"] for b in result["report"]["blocks"]] == ["text"]


async def test_the_format_example_in_a_chart_block_is_dropped():
    echo = _report(blocks=[{
        "type": "chart", "title": "Vendors", "chart_type": "bar", "x_label": "Vendor", "y_label": "Spend",
        "points": [{"label": r["vendor"], "value": r["spend"]} for r in CHART_EXEMPLAR["data"]],
        "note": None,
    }, {"type": "text", "body": "Booked held steady."}])
    rows = {**ROWS, "rows": ROWS["rows"] + [{"spend": v} for v in (1000, 750, 500)]}
    convo = Recording(turns=[_asks_for_sql(), _answer("READY"), _composed(echo)], tool_results=[rows])
    result = await run_report(convo)
    assert result["dropped"] == ["Vendors"]
    assert [b["type"] for b in result["report"]["blocks"]] == ["text"]


async def test_prose_that_is_machine_payload_fails_the_report():
    bad = _report(headline="SQL_ERROR: column booked does not exist")
    convo = Recording(turns=[_asks_for_sql(), _answer("READY"), _composed(bad)], tool_results=[ROWS])
    with pytest.raises(LLMErrorEcho) as exc:
        await run_report(convo)
    assert "report_prose" in str(exc.value)


async def test_the_trace_and_the_counts_ride_on_the_result():
    convo = Recording(turns=[_asks_for_sql("SELECT 1"), _answer("READY"), _composed(_report())], tool_results=[ROWS])
    result = await run_report(convo)
    assert result["tool_trace"][0]["sql"] == "SELECT 1" and result["tool_trace"][0]["row_count"] == 4
    assert result["tool_calls"] == ["execute_sql"]
    assert result["tokens_used"] == 15 + 15 + 150


# ------------------------------------------ a question answered with a page

BRIEF = "One-page report of booked revenue by month, June to August 2026"


def _asks_to_compose(brief: str | None = BRIEF) -> LLMResult:
    args = {} if brief is None else {"brief": brief}
    return LLMResult(
        text="", tool_calls=[ToolCall(id="call_compose", name=COMPOSE_REPORT_TOOL, arguments=args)],
        model="m", provider="p", tokens_in=10, tokens_out=5,
    )


async def run_question(convo: Recording, question: str = "Put that in a PDF") -> dict:
    """A CHAT payload -- the composer has one door -- with a conversation behind it."""
    with patch.object(report.llm, "complete", convo.complete), \
         patch.object(insights, "_run_tool", convo.run_tool), \
         patch("services.insights_service._build_chat_system_prompt", return_value="SYSTEM"):
        return await insights.run(JobContext(
            feature="insights", company_id="c0", request_id="rid",
            payload={"question": question, "today": "2026-09-07",
                     "history": [{"seq": 1, "role": "user", "content": "Booked revenue by month?"},
                                 {"seq": 2, "role": "assistant",
                                  "content": "June $13,367, July $34,444, August $48,971."}]},
        ))


async def test_a_question_the_model_answers_by_composing_becomes_a_report():
    """One composer, no picker (2026-09-08): the model reads "put that in a PDF",
    resolves "that" from the conversation and calls compose_report with a brief
    that stands alone. The handler hands the brief to the report path, and the
    result says kind = 'report' so the executors flip the row."""
    convo = Recording(turns=[_asks_to_compose(), _asks_for_sql(), _answer("READY"), _composed(_report())],
                      tool_results=[ROWS])
    result = await run_question(convo)

    assert result["kind"] == "report" and result_kind(result) == "report"
    assert result["report"]["title"] == "OPERATIONS SUMMARY"
    assert result["brief"] == BRIEF
    # The chat call saw the conversation and the question, with both tools offered;
    # the report path saw the brief, never the question.
    chat_call, gather = convo.seen[0], convo.seen[1]
    assert chat_call[-1].text() == "Put that in a PDF"
    assert convo.kwargs[0]["tools"] is CHAT_TOOLS
    assert report.REPORT_BRIEF in gather[1].text()
    assert f"The request: {BRIEF}" in gather[1].text()
    assert "Put that in a PDF" not in gather[1].text()
    # Same system turn throughout: the prefix chat cached is the one the report reuses.
    assert {seen[0].text() for seen in convo.seen} == {"SYSTEM"}


async def test_a_compose_call_with_no_brief_falls_back_to_the_question():
    convo = Recording(turns=[_asks_to_compose(brief=None), _asks_for_sql(), _answer("READY"), _composed(_report())],
                      tool_results=[ROWS])
    result = await run_question(convo, question="One-page report on this quarter")

    assert result["kind"] == "report"
    assert result["brief"] == "One-page report on this quarter"
    assert "The request: One-page report on this quarter" in convo.seen[1][1].text()


async def test_a_plain_answer_carries_no_kind_so_the_row_stays_as_enqueued():
    convo = Recording(turns=[_asks_for_sql(), _answer("4 jobs are late.")], tool_results=[SQL_OK])
    result = await run_question(convo, question="How many jobs are late?")

    assert result["answer"] == "4 jobs are late." and "kind" not in result
    assert result_kind(result) is None
    assert result_kind({"kind": "report"}) == "report"
    assert result_kind({"kind": "poem"}) is None and result_kind(None) is None


async def test_in_the_report_loop_compose_report_means_done_gathering():
    """The tools block must match chat's for the prefix to hold, so the report
    loop is offered compose_report too. There it ends gathering -- the queries
    beside it run first -- and it is never dispatched again."""
    both = LLMResult(
        text="", model="m", provider="p", tokens_in=10, tokens_out=5,
        tool_calls=[
            ToolCall(id="c1", name="execute_sql",
                     arguments={"sql": "SELECT 1 FROM jobs WHERE company_id = $1", "description": "d"}),
            ToolCall(id="c2", name=COMPOSE_REPORT_TOOL, arguments={"brief": "ignored here"}),
        ],
    )
    convo = Recording(turns=[both, _composed(_report())], tool_results=[ROWS])
    result = await run_report(convo)

    assert result["kind"] == "report" and result["report"]["title"] == "OPERATIONS SUMMARY"
    # Two calls: the gather that asked to compose, then the compose. No third.
    assert len(convo.seen) == 2
    compose = convo.seen[1]
    assert compose[-1].text() == report.COMPOSE_REQUEST
    assert any(m.role == "tool" for m in compose)
    # The query is recorded as a tool call; the compose_report call is not.
    recorded = [c.name for m in compose if m.role == "assistant" for c in m.tool_calls]
    assert recorded == ["execute_sql"]
    assert result["tool_calls"] == ["execute_sql"]


async def test_a_bare_compose_call_in_the_report_loop_composes_over_what_was_gathered():
    convo = Recording(turns=[_asks_for_sql(), _asks_to_compose(), _composed(_report())], tool_results=[ROWS])
    result = await run_report(convo)

    assert result["report"]["title"] == "OPERATIONS SUMMARY"
    assert len(convo.seen) == 3
    compose = convo.seen[2]
    # Nothing was appended for the bare call: the tool result, then the request.
    assert compose[-1].text() == report.COMPOSE_REQUEST and compose[-2].role == "tool"
