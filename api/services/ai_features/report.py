"""One-page executive summaries: the model gathers and fills, code decides.

WHAT THE USER ASKED FOR, AND WHAT SHIPS. The user types what the report should
cover -- "operations summary for June to September", "how is Hastings Machine
doing this year", "backlog and late jobs". The model runs the SAME tool loop as
chat to gather the figures, then fills a ReportSpec in one schema-constrained
call; a deterministic renderer in the browser lays the spec out on exactly one
page under the shop's header. The reference document this replaces was a fixed
set of period aggregates; this is that shape opened to whatever the owner asks,
with the guardrails moved from the model into a schema and a renderer.

THE GUARDRAILS, AND WHO ENFORCES EACH.
  * One page, minimal prose, an AI-inferred title -- models/report_spec.py caps
    them; utils/reportPdf.ts measures and drops what still does not fit, naming
    what it dropped.
  * Every figure comes from a query -- untraceable_figures() below: every number
    in a KPI, a table cell or a chart point must equal (to rounding) a value that
    appeared in a tool result of THIS job. Derived figures are computed in SQL,
    never in the model's head; the prompt says so and the guard makes it so. One
    repair turn names the offenders; a second failure is an error_echo job.
  * The model never formats -- values are raw; each declares a format the renderer
    applies.
  * Charts valid -- the chat gate (_validate_chart_config, _drop_exemplar_echo,
    _select_chart_type) on every chart block; an invalid one is dropped and named.
  * Same safety boundary as chat -- same execute_sql tool, validator, sandbox, and
    the SAME system turn, so the KV prefix is shared with every chat job.

Dispatched from insights.run on payload.kind == "report" (the report door) and,
since 2026-09-08, when the chat loop sees the model call compose_report: the brief
it wrote becomes the request, and the result's kind = 'report' flips the job row
when it settles. Either way the two hosts, the chain, the ledger and the error
kinds are all the ones chat already has.
"""
from __future__ import annotations

import json
import logging
import math
from datetime import date
from decimal import Decimal
from typing import Any

from services import llm
from services.ai_features import insights
from services.ai_features.base import JobContext
from services.insights_presentation import (
    numbers_in,
    _drop_exemplar_echo,
    _select_chart_type,
    _validate_chart_config,
    classify_non_answer,
    echoes_exemplar,
)
from services.llm.base import Message
from services.llm.errors import LLMErrorEcho, LLMToolLoopExhausted
from models.report_spec import (
    BLOCK_MAX, CHART_POINTS_MAX, CHART_POINTS_MIN, HEADLINE_MAX, KPI_MAX,
    TABLE_COLUMNS_MAX, TABLE_ROWS_MAX, TEXT_BODY_MAX, TITLE_MAX,
    ChartBlock, ReportSpec, TableBlock, TextBlock,
)
from tools.tool_json import dumps_tool_result

logger = logging.getLogger(__name__)

# More room than a question: a report gathers several figures. Still a cap,
# because a model that keeps asking for one more query is not converging.
MAX_REPORT_TOOL_ITERATIONS = 8
# The compose call. A full spec is a few hundred tokens; this is headroom.
REPORT_MAX_TOKENS = 3000

# A figure "appears in a result" if it equals one to rounding: half a unit or
# half a percent, whichever is larger. The model copies raw values, but a SQL
# AVG returns 4774.8211 and the model may write 4774.82 -- that is a copy, not
# an invention. Anything looser would let an invented number through.
_ABS_TOLERANCE = 0.5
_REL_TOLERANCE = 0.005

REPORT_BRIEF = (
    "You are preparing a ONE-PAGE executive summary for the shop owner, in two stages.\n"
    "Stage 1, now: gather the figures with execute_sql. Decide which sections the request "
    "needs, run the queries, and compute EVERY derived figure in SQL -- totals, averages, "
    "rates, shares, month-by-month splits -- never in your head. Use $2 for today's date "
    "in SQL. The period is exactly the one the request names; months named without a year "
    "are the most recent such months on or before today; if the request names no period, "
    "choose one and say which in the period label. When the data is gathered, reply with "
    "the single word READY and nothing else; do not write the report yet.\n"
    "Stage 2, when asked: the report as JSON matching the schema you will be given. "
    "A title of at most six words naming the subject -- never the period, which has its own "
    "line; the period as start and end dates plus a short label; a headline of at most "
    f"{HEADLINE_MAX} characters; up to "
    f"{KPI_MAX} KPI tiles, each a label of one to three words, a raw value, a format, and a "
    "caption of at most three words that ADDS to the value -- '84 jobs' under a booked total "
    "-- or null when there is nothing to add; a caption never repeats the value; up to "
    f"{BLOCK_MAX} blocks, each a table (at most {TABLE_ROWS_MAX} rows "
    f"and {TABLE_COLUMNS_MAX} columns, cells aligned with the columns), a chart "
    f"({CHART_POINTS_MIN} to {CHART_POINTS_MAX} points; label points on a time axis with ISO "
    "dates YYYY-MM-DD, never month names, so the axis keeps calendar order; each chart shows "
    "something no other block already shows), or one text block of at most two "
    f"sentences ({TEXT_BODY_MAX} characters). Numbers over words; when the request is about "
    "particular jobs, customers, parts or quotes, a table that names them beats a count of them. "
    "Every number in the report "
    "must be a value that appeared in a query result. Values are raw numbers: never format "
    "them, declare a format (currency, integer, percent, plain) and the renderer will."
)
COMPOSE_REQUEST = (
    "Now write the report as JSON matching the schema. Use only figures present in the "
    "query results above, as raw numbers. period_start and period_end are YYYY-MM-DD."
)


def _numbers_in(value: Any, out: set[float]) -> None:
    """Every numeric value reachable in a tool result, as floats. The walker lives
    in insights_presentation (chat's grounding guard uses it too)."""
    numbers_in(value, out)


def _traceable(x: float, seen: set[float]) -> bool:
    if x in seen:
        return True
    return any(abs(x - v) <= max(_ABS_TOLERANCE, abs(v) * _REL_TOLERANCE) for v in seen)


def _figures(spec: ReportSpec) -> list[tuple[str, float]]:
    """Every number the report asserts, with where it sits."""
    out: list[tuple[str, float]] = []
    for i, kpi in enumerate(spec.kpis):
        out.append((f"kpis[{i}] {kpi.label}", kpi.value))
    for b, block in enumerate(spec.blocks):
        if isinstance(block, TableBlock):
            rows = list(block.rows) + ([block.total_row] if block.total_row else [])
            for r, row in enumerate(rows):
                for c, cell in enumerate(row):
                    if isinstance(cell, (int, float)) and not isinstance(cell, bool):
                        out.append((f"blocks[{b}] {block.title} row {r} col {c}", float(cell)))
        elif isinstance(block, ChartBlock):
            for p, point in enumerate(block.points):
                out.append((f"blocks[{b}] {block.title} point {p} {point.label}", point.value))
    return out


def untraceable_figures(spec: ReportSpec, seen: set[float]) -> list[tuple[str, float]]:
    """The numbers in the spec that appeared in no query result."""
    return [(where, x) for where, x in _figures(spec) if not _traceable(x, seen)]


def _chart_config_for(block: ChartBlock, request: str) -> dict | None:
    """A chart block through the chat gate: validate, refuse an echo, pick the type."""
    config = {
        "chart_type": block.chart_type,
        "data": [{"label": p.label, "value": p.value} for p in block.points],
        "x_key": "label",
        "y_key": "value",
        "x_label": block.x_label,
        "y_label": block.y_label,
    }
    return _select_chart_type(_drop_exemplar_echo(_validate_chart_config(config)), request)


def render_blocks(spec: ReportSpec, request: str) -> tuple[list[dict[str, Any]], list[str]]:
    """The blocks as the browser draws them, and the titles of any it will not see."""
    blocks: list[dict[str, Any]] = []
    dropped: list[str] = []
    for block in spec.blocks:
        if isinstance(block, ChartBlock):
            config = _chart_config_for(block, request)
            if config is None:
                dropped.append(block.title)
                continue
            blocks.append({"type": "chart", "title": block.title, "note": block.note, "chart_config": config})
        elif isinstance(block, TableBlock):
            blocks.append(block.model_dump(mode="json"))
        elif isinstance(block, TextBlock):
            blocks.append(block.model_dump(mode="json"))
    return blocks, dropped


async def run(ctx: JobContext, *, request: str | None = None) -> dict[str, Any]:
    """Gather, compose, check. Returns the shape ai_jobs.result stores.

    Two ways in. The report door enqueues `kind = 'report'` with the request in
    the payload. Since 2026-09-08 the chat loop also lands here, when the model
    answers a question by calling compose_report: `request` is then the brief the
    model wrote with the conversation in view, so "put that in a PDF" arrives as a
    request that stands alone, and the result says `kind = 'report'` so the
    executor flips the job row's column when it records the success.
    """
    from services.insights_service import _build_chat_system_prompt
    from tools.chat_tools import CHAT_TOOLS, COMPOSE_REPORT_TOOL
    from tools.sql_executor import NOT_PERMITTED_KIND, SQL_ERROR_KIND

    request = (request or ctx.payload.get("request") or "").strip()
    if not request:
        raise ValueError("report job payload has no request")
    raw_today = ctx.payload.get("today")
    today = date.fromisoformat(raw_today) if raw_today else None

    # The SAME system turn as chat, so the KV prefix is shared. The brief is the
    # first user turn, never part of the system prompt, for the same reason the
    # conversation summary is not.
    # TODAY IS STATED IN WORDS. $2 is a bind parameter whose value the model never
    # sees, and a report has to write period_start and period_end as literal dates:
    # the second live run, asked for "June to September", dated them 2023 and
    # summarised a quarter with no data in it.
    system_prompt = _build_chat_system_prompt()
    dated = f"Today is {today.isoformat()}. " if today else ""
    messages = [
        Message(role="system", content=system_prompt),
        Message(role="user", content=f"{REPORT_BRIEF}\n\n{dated}The request: {request}"),
    ]

    tool_names: list[str] = []
    tool_trace: list[dict[str, Any]] = []
    seen: set[float] = set()
    tokens_used = 0
    refused = 0
    sql_ok = 0
    sql_failed = 0
    corrected = False
    result = None
    # Set when the loop's last assistant turn was appended inside it (the model
    # called compose_report beside its queries), so the compose step does not
    # append that text a second time.
    final_turn_recorded = False

    for _ in range(MAX_REPORT_TOOL_ITERATIONS):
        result = await llm.complete(
            ctx.feature, messages, max_tokens=insights.MAX_TOKENS, tools=CHAT_TOOLS,
            request_id=ctx.request_id, chain=ctx.chain, audit_writer=ctx.audit_writer,
        )
        tokens_used += result.tokens_in + result.tokens_out

        if not result.tool_calls:
            if sql_failed and not sql_ok and not corrected:
                corrected = True
                messages = messages + insights._correction_turns(result.text)
                continue
            break

        # compose_report is offered here too -- the tools block is part of the
        # prefix the KV cache reuses, so it has to match chat's -- and in this loop
        # it means "I have what I need", the same signal as answering in prose. Any
        # queries beside it run first; then composing begins. It is never handed on.
        composing = any(call.name == COMPOSE_REPORT_TOOL for call in result.tool_calls)
        calls = [call for call in result.tool_calls if call.name != COMPOSE_REPORT_TOOL]
        if composing and not calls and not result.text.strip():
            break
        tool_results = [(call, await insights._run_tool(ctx.company_id, call, today)) for call in calls]
        refused += sum(1 for _, r in tool_results if r.get("error_kind") == NOT_PERMITTED_KIND)
        for call, r in tool_results:
            if call.name != "execute_sql":
                continue
            trace: dict[str, Any] = {
                "sql": call.arguments.get("sql", ""),
                "description": call.arguments.get("description", ""),
            }
            if "error" not in r:
                sql_ok += 1
                trace["row_count"] = r.get("row_count")
                # Every value the model may later assert. Counts too: "84 jobs" is
                # legitimately COUNT(*), which arrives as a cell like any other.
                _numbers_in(r.get("rows"), seen)
                _numbers_in(r.get("row_count"), seen)
            else:
                trace["error_kind"] = r.get("error_kind")
                if r.get("error_kind") == SQL_ERROR_KIND:
                    sql_failed += 1
            tool_trace.append(trace)

        messages = messages + [
            Message(role="assistant", content=result.text, tool_calls=calls)
        ] + [
            Message(role="tool", tool_call_id=call.id, content=dumps_tool_result(r))
            for call, r in tool_results
        ]
        tool_names.extend(call.name for call in calls)
        if composing:
            final_turn_recorded = True
            break
    else:
        raise LLMToolLoopExhausted(
            f"the report loop reached {MAX_REPORT_TOOL_ITERATIONS} iterations without gathering "
            f"({refused} refused-object result(s))",
            feature=ctx.feature, request_id=ctx.request_id,
            provider=result.provider if result else None, model=result.model if result else None,
            tokens_out=tokens_used,
        )

    if not sql_ok:
        # No figure can be traced to a query, so no report can be written. Not an
        # answer dressed as one.
        raise LLMErrorEcho(
            f"[report_no_data] no query succeeded before composing ({sql_failed} failed, {refused} refused)",
            feature=ctx.feature, request_id=ctx.request_id,
            provider=result.provider, model=result.model, tokens_out=tokens_used,
        )

    # Compose: one schema-constrained call over the gathered results. No tools,
    # so the grammar applies cleanly; the same system turn, so the prefix holds.
    compose = messages
    if result.text.strip() and not final_turn_recorded:
        compose = compose + [Message(role="assistant", content=result.text)]
    compose = compose + [Message(role="user", content=COMPOSE_REQUEST)]

    spec: ReportSpec | None = None
    figures_repaired = False
    for attempt in (1, 2):
        composed = await llm.complete(
            ctx.feature, compose, json_schema=ReportSpec, max_tokens=REPORT_MAX_TOKENS,
            request_id=ctx.request_id, chain=ctx.chain, audit_writer=ctx.audit_writer,
        )
        tokens_used += composed.tokens_in + composed.tokens_out
        spec = ReportSpec.model_validate_json(composed.text)

        bad = untraceable_figures(spec, seen)
        if not bad:
            break
        if attempt == 2:
            raise LLMErrorEcho(
                f"[ungrounded_figures] {len(bad)} figure(s) appear in no query result after one "
                f"repair: {', '.join(f'{where}={x:g}' for where, x in bad[:6])}",
                feature=ctx.feature, request_id=ctx.request_id,
                provider=composed.provider, model=composed.model, tokens_out=tokens_used,
            )
        figures_repaired = True
        problems = "; ".join(f"{where} = {x:g}" for where, x in bad[:12])
        compose = compose + [
            Message(role="assistant", content=composed.text),
            Message(role="user", content=(
                f"These figures appear in no query result: {problems}. Replace each with a value "
                f"that does appear in the results above, or remove it, and reply with the full "
                f"report JSON again. Do not compute new figures."
            )),
        ]

    assert spec is not None
    for text in [spec.headline, *(b.body for b in spec.blocks if isinstance(b, TextBlock))]:
        rule = classify_non_answer(text) or ("exemplar_echo" if echoes_exemplar(text) else None)
        if rule:
            raise LLMErrorEcho(
                f"[report_prose:{rule}] {text[:insights._REJECTED_ECHO_CHARS]!r}",
                feature=ctx.feature, request_id=ctx.request_id,
                provider=composed.provider, model=composed.model, tokens_out=tokens_used,
            )

    blocks, dropped = render_blocks(spec, request)
    report = {
        "title": spec.title,
        "period_start": spec.period_start.isoformat(),
        "period_end": spec.period_end.isoformat(),
        "period_label": spec.period_label,
        "headline": spec.headline,
        "kpis": [k.model_dump(mode="json") for k in spec.kpis],
        "blocks": blocks,
    }
    return {
        # The executors write this into ai_jobs.kind on success (result_kind): a
        # question the model answered with a report settles as one.
        "kind": "report",
        # What the page was composed from: the door's request, or the brief the
        # model wrote when it chose compose_report in a conversation.
        "brief": request,
        "report": report,
        "dropped": dropped,
        # A compose call is the expensive one (≈150 s on the M4 Max); this says whether
        # the job paid for two because a figure appeared in no query result.
        "figures_repaired": figures_repaired,
        "tool_calls": tool_names,
        "tool_trace": tool_trace,
        "provider": composed.provider,
        "model": composed.model,
        "tokens_used": tokens_used,
        "not_permitted": refused,
    }


__all__ = ["MAX_REPORT_TOOL_ITERATIONS", "REPORT_BRIEF", "REPORT_MAX_TOKENS", "render_blocks", "run", "untraceable_figures"]
