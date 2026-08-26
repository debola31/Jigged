"""The insights tool loop, running wherever the job runs.

ONE HANDLER, TWO HOSTS. The desktop worker calls this after claiming a job; the
FastAPI route calls it inline for a feature still on Anthropic. Neither has its
own copy, because two copies of a five-iteration agentic loop would drift and the
drift would only show up as "the local one answers differently".

WHAT MOVED, AND WHAT DID NOT. The loop moved out of ClaudeProvider.chat_with_tools:
company_id now arrives on the job row instead of being regex-scraped out of the
user message, and exhausting the iteration cap RAISES instead of returning
"I wasn't able to complete the analysis. Please try a simpler question." as an
HTTP 200 -- a failure dressed as an answer, which a user cannot tell from a real
one. Everything downstream is untouched: the same system prompt (written FOR tool
use), the same execute_sql sandbox, the same chart validation and markdown
scrubbing.
"""
from __future__ import annotations

import logging
from typing import Any

from services import llm
from services.ai_features.base import JobContext
from services.insights_presentation import (
    _extract_chart_config,
    _flatten_markdown_tables,
    _select_chart_type,
    _strip_code_blocks,
    _strip_inline_markdown,
    _validate_chart_config,
    classify_non_answer,
)
from services.llm.base import Message, ToolCall
from services.llm.errors import LLMErrorEcho, LLMToolLoopExhausted
from tools.tool_json import dumps_tool_result

logger = logging.getLogger(__name__)

# As before the move. The cap exists because a model that keeps asking for one
# more query is not converging, and each iteration is a full round trip.
MAX_TOOL_ITERATIONS = 5
MAX_TOKENS = 4000

# What the model is told when it tries to answer holding nothing but a failed
# query. Written as an instruction with a fallback in it, because "try again" on
# its own is what produced the echo the second time round.
CORRECTION = (
    "Your query failed and no query has succeeded yet, so there is nothing behind "
    "that answer. Fix the SQL using the error in the tool result and call "
    "execute_sql once more. If it fails again, say plainly that the figure is "
    "unavailable -- never repeat a database error, a column name or SQL back to "
    "the user."
)

# How much of a rejected answer goes into the failure. ai_jobs.error is capped at
# 2048 by a CHECK, and whoever is asking why a question came back empty needs to
# see what the model actually said.
_REJECTED_ECHO_CHARS = 300


async def _run_tool(company_id: str, call: ToolCall) -> dict[str, Any]:
    """Execute one tool call. A tool FAILING is data for the model, not an error.

    The executor returns shaped errors -- SQL_ERROR for anything a rewrite can
    fix, NOT_PERMITTED for anything no rewrite can -- precisely so the model can
    correct itself on the next iteration. That self-correction is one of the
    layers documented in ai-insights.md, and raising here would delete it.

    An exception that ESCAPES the executor is neither of those kinds, so the
    result below carries no error_kind and the loop counts it as neither a
    fixable failure nor a success. That is the right reading: the executor
    already shapes every failure the model could have caused, so anything left
    is ours and no retry reaches it.
    """
    from services.insights_service import execute_sql_tool, execute_tool

    try:
        if call.name == "execute_sql":
            return await execute_sql_tool(
                company_id=company_id,
                sql=call.arguments.get("sql", ""),
                description=call.arguments.get("description", ""),
            )
        return execute_tool(
            company_id=company_id, tool_name=call.name, tool_input=call.arguments
        )
    except Exception as exc:  # noqa: BLE001 - hand the failure back to the model
        logger.warning("insights tool %s failed: %s", call.name, type(exc).__name__)
        return {"error": str(exc)}


def _correction_turns(text: str) -> list[Message]:
    """The corrective exchange: what the model said, then what to do about it.

    Ordinary multi-turn, matching call.py's _repair_turns -- never an assistant
    prefill, which 4.6+ models reject outright.

    THE ASSISTANT TURN IS CONDITIONAL, and that is not tidiness. Anthropic
    rejects a message with empty content, and "the model produced nothing at all"
    is one of the exact shapes that reaches this function; appending it verbatim
    would turn a recoverable turn into a 400 from the vendor.
    """
    turns = [Message(role="assistant", content=text)] if text.strip() else []
    return turns + [Message(role="user", content=CORRECTION)]


async def run(ctx: JobContext) -> dict[str, Any]:
    """Answer one question. Returns the shape ai_jobs.result stores.

    THREE THINGS STAND BETWEEN A FAILED QUERY AND A SHOP OWNER, and only the
    first was here before. The tool result says the failure is the model's to fix
    (tools/sql_executor.retryable_sql_error); this loop gives it ONE more go
    before letting it answer with nothing; and the answer is refused outright if
    no query ever succeeded and the text is the error read back. Every local arm
    of the insights A/B failed at the second and third of those, and the job
    settled `succeeded` with "The column total_price does not exist..." in it.
    """
    from services.insights_service import _build_chat_system_prompt
    from tools.metric_tools import CHAT_TOOLS
    from tools.sql_executor import NOT_PERMITTED_KIND, SQL_ERROR_KIND

    question = (ctx.payload.get("question") or "").strip()
    if not question:
        raise ValueError("insights job payload has no question")

    # No `system=` parameter anywhere in this layer: the system prompt is a turn,
    # and split_system() puts it where each vendor wants it.
    messages = [
        Message(role="system", content=_build_chat_system_prompt()),
        Message(role="user", content=question),
    ]

    tool_names: list[str] = []
    tokens_used = 0
    refused = 0
    # Counted over execute_sql results only, and a refused object is NEITHER: a
    # NOT_PERMITTED result must not earn a retry (that is the loop
    # classify_not_permitted was written to delete) nor condemn a legitimate
    # "Jigged does not track that" answer.
    sql_ok = 0
    sql_failed = 0
    corrected = False
    result = None

    for _ in range(MAX_TOOL_ITERATIONS):
        result = await llm.complete(
            ctx.feature,
            messages,
            max_tokens=MAX_TOKENS,
            tools=CHAT_TOOLS,
            request_id=ctx.request_id,
            chain=ctx.chain,
            audit_writer=ctx.audit_writer,
        )
        tokens_used += result.tokens_in + result.tokens_out

        if not result.tool_calls:
            # ONE corrective turn, and only into the one state that is always
            # wrong: the model is answering while every query it ran failed and
            # none succeeded. Once per conversation -- a second injection would
            # push the real work past the cap, and the cap is what ends a loop
            # that is not converging.
            if sql_failed and not sql_ok and not corrected:
                corrected = True
                messages = messages + _correction_turns(result.text)
                logger.info(
                    "insights %s: correcting a failed-query answer", ctx.request_id
                )
                continue
            break

        # Run the tools first, then wire the messages: the count of refused
        # objects is what the eval asserts to zero, and it is invisible once the
        # dict has been through json.dumps.
        tool_results = [
            (call, await _run_tool(ctx.company_id, call)) for call in result.tool_calls
        ]
        refused += sum(
            1 for _, r in tool_results if r.get("error_kind") == NOT_PERMITTED_KIND
        )
        for call, r in tool_results:
            if call.name != "execute_sql":
                continue
            if "error" not in r:
                # Zero rows is a SUCCESS: the query ran, and "none" is an answer.
                sql_ok += 1
            elif r.get("error_kind") == SQL_ERROR_KIND:
                sql_failed += 1

        # Rebind rather than append: the gateway's retry works on a copy, and this
        # loop owning one mutable list would make the two aliasing bugs possible
        # again from the other direction.
        messages = messages + [
            Message(role="assistant", content=result.text, tool_calls=result.tool_calls)
        ] + [
            # dumps_tool_result, never a bare json.dumps: a UUID in a result row
            # killed this exact line twice, because the type mapping lived in a
            # helper that shaped rows elsewhere and nothing shaped them here.
            Message(role="tool", tool_call_id=call.id, content=dumps_tool_result(r))
            for call, r in tool_results
        ]
        tool_names.extend(call.name for call in result.tool_calls)
    else:
        # The cap was reached with the model still asking for tools. Previously
        # this returned a canned apology as a SUCCESS.
        raise LLMToolLoopExhausted(
            f"the insights loop reached {MAX_TOOL_ITERATIONS} iterations without an "
            f"answer ({refused} refused-object result(s))",
            feature=ctx.feature,
            request_id=ctx.request_id,
            provider=result.provider if result else None,
            model=result.model if result else None,
            tokens_out=tokens_used,
        )

    raw = result.text
    answer = _strip_inline_markdown(_flatten_markdown_tables(_strip_code_blocks(raw)))

    # Gated on the SCRUBBED text, because that is what the user would have read.
    # Both halves are required, and the second is deliberately conservative: if
    # any query succeeded the answer goes through however it reads. Judging a
    # grounded answer is the eval's job and a human's, and a rule that could
    # reject one will eventually reject a good one.
    #
    # The kind on the job row stays 'error_echo' even when the rule that fired
    # was a narrated tool call rather than a read-back error: it is one failure
    # -- the final turn was not an answer -- and splitting it would cost a
    # migration to say something the reason in the message already says.
    non_answer = classify_non_answer(answer) if not sql_ok else None
    if non_answer:
        raise LLMErrorEcho(
            f"the model's final turn carried no answer and no successful query "
            f"[{non_answer}] ({sql_failed} failed, {refused} refused): "
            f"{answer[:_REJECTED_ECHO_CHARS]!r}",
            feature=ctx.feature,
            request_id=ctx.request_id,
            provider=result.provider,
            model=result.model,
            tokens_out=tokens_used,
        )

    chart_config = _select_chart_type(
        _validate_chart_config(_extract_chart_config(raw)), question
    )

    return {
        "answer": answer,
        "chart_config": chart_config,
        "tool_calls": tool_names,
        "provider": result.provider,
        "model": result.model,
        "tokens_used": tokens_used,
        # Zero is the acceptance bar: a refused object should end the turn, so a
        # non-zero count means the context is still advertising what it cannot read.
        "not_permitted": refused,
    }
