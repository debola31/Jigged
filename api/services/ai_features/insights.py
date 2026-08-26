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

import json
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
)
from services.llm.base import Message, ToolCall
from services.llm.errors import LLMToolLoopExhausted

logger = logging.getLogger(__name__)

# As before the move. The cap exists because a model that keeps asking for one
# more query is not converging, and each iteration is a full round trip.
MAX_TOOL_ITERATIONS = 5
MAX_TOKENS = 4000


async def _run_tool(company_id: str, call: ToolCall) -> dict[str, Any]:
    """Execute one tool call. A tool FAILING is data for the model, not an error.

    The executor returns shaped errors ("Query timed out", "column does not
    exist") precisely so the model can correct itself on the next iteration --
    that self-correction is one of the seven layers documented in ai-insights.md,
    and raising here would delete it.
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


async def run(ctx: JobContext) -> dict[str, Any]:
    """Answer one question. Returns the shape ai_jobs.result stores."""
    from services.insights_service import _build_chat_system_prompt
    from tools.metric_tools import CHAT_TOOLS
    from tools.sql_executor import NOT_PERMITTED_KIND

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

        # Rebind rather than append: the gateway's retry works on a copy, and this
        # loop owning one mutable list would make the two aliasing bugs possible
        # again from the other direction.
        messages = messages + [
            Message(role="assistant", content=result.text, tool_calls=result.tool_calls)
        ] + [
            Message(role="tool", tool_call_id=call.id, content=json.dumps(r))
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
    chart_config = _select_chart_type(
        _validate_chart_config(_extract_chart_config(raw)), question
    )
    answer = _strip_inline_markdown(_flatten_markdown_tables(_strip_code_blocks(raw)))

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
