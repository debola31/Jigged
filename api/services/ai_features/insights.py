"""The insights tool loop, running wherever the job runs.

ONE HANDLER, TWO HOSTS. The desktop worker calls this after claiming a job; the
FastAPI route calls it inline for a feature whose chain head is a hosted
provider. Neither has its
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

A CONVERSATION, ON A 32K WINDOW. The route ships the replay set in the payload:
the latest summary of older turns and every user/assistant turn after it. This
loop replays them AFTER the system turn (so the ~13K-token prefix stays
byte-identical across every job and Ollama's KV cache keeps it), keeps as many
recent turns as the budget allows, answers, and only THEN -- when the thread has
grown past COMPACT_AT_FRACTION of the budget -- makes one more call that folds
the oldest turns into a new summary. The summary call starts with the SAME system
turn and the SAME tools, because Qwen's template renders both into the prefix
and changing either would evict the cache for the whole box. Old tool results
are never replayed; the answer is what carries forward.
"""
from __future__ import annotations

import logging
from datetime import date
from typing import Any

from services import llm
from services.ai_features.base import JobContext
from services.insights_presentation import (
    OFF_TOPIC_REPLY,
    _drop_exemplar_echo,
    _extract_chart_config,
    _flatten_markdown_tables,
    _select_chart_type,
    _strip_code_blocks,
    _strip_inline_markdown,
    _validate_chart_config,
    classify_non_answer,
    echoes_exemplar,
    numbers_in,
    unsupported_figures,
)
from services.llm.base import Message, ToolCall
from services.llm.errors import LLMError, LLMErrorEcho, LLMToolLoopExhausted
from services.llm.ollama_provider import OLLAMA_NUM_CTX
from tools.tool_json import dumps_tool_result

logger = logging.getLogger(__name__)

# As before the move. The cap exists because a model that keeps asking for one
# more query is not converging, and each iteration is a full round trip.
MAX_TOOL_ITERATIONS = 5
MAX_TOKENS = 4000

# ---- the context budget --------------------------------------------------------
# Everything here is a module constant, never env: the window is what the adapter
# pins (OLLAMA_NUM_CTX, one definition), and the rest is arithmetic against it.
#
#   32,768  the window
#  -13,000  the stable prefix: system prompt (~50 KB / 4) + the tool schema
#   -4,000  the answer reserve (MAX_TOKENS)
#   -8,000  tool results appended DURING this turn (a reserve, not a cap)
#     -600  the summary reserve
#     -125  the question (<= 500 chars)
#   ~7,000  history budget -- about twenty turns; compaction at ~4,900, down to ~3,500
#
# The tool schema is rendered into the system block by the chat template, so it
# is prefix too: two tools since 2026-09-08 (execute_sql and compose_report, ~1.9 KB
# of JSON at ~3 chars/token plus the template's framing). Estimated rather than
# measured: no tokenizer ships with the worker, chars/4 is a fair rate for prose,
# and ai_calls.tokens_in (the server's own prompt_eval_count) is the calibration
# point if it drifts.
TOOLS_PREFIX_TOKENS = 700
TOOL_RESULT_HEADROOM_TOKENS = 8_000
SUMMARY_MAX_TOKENS = 600
CHARS_PER_TOKEN = 4
# Conversation text is denser than the prose prompt: measured against Ollama's own
# prompt_eval_count on 2026-09-07, the ~50 KB system prompt tokenises at ~4.0
# chars/token, the 25-turn live thread at 3.3, and a digit-heavy synthetic history
# at 2.4 -- one the chars/4 estimate placed at 5.7K tokens was 9.5K, so the
# window thought it had room, never compacted, and ate into the tool-result
# headroom. History and summaries are estimated at 3.
HISTORY_CHARS_PER_TOKEN = 3
# The most history a question carries, whatever the window would allow (_history_budget).
HISTORY_MAX_TOKENS = 5_000
# MemGPT's numbers, and every compaction since: fold when past 70 % of the budget,
# down to 50 %, so a thread near the edge is not summarised on every turn.
COMPACT_AT_FRACTION = 0.7
EVICT_TO_FRACTION = 0.5

SUMMARY_PREAMBLE = "Earlier in this conversation (summary): "
SUMMARY_INSTRUCTION = (
    "Summarise the earlier part of this conversation for your own later reference, "
    "in at most 200 words of plain prose. Keep every figure with its unit and the "
    "period it covers, every customer, vendor, part or job named, every date range, "
    "and anything the user corrected or asked you to remember. Do not call any tool "
    "and do not add anything that was not said."
)

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


async def _run_tool(company_id: str, call: ToolCall, today: date | None) -> dict[str, Any]:
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

    CHAT_TOOLS offers two tools, and compose_report never reaches here (both loops
    intercept it before any tool runs), so a name other than execute_sql means the
    model INVENTED one -- which an OpenAI-compat local model does, and
    openai_compat parses whatever name comes back. The raise below is caught two
    lines down and handed to the model as data, exactly as the deleted
    execute_tool dispatcher used to do with its own ValueError.
    """
    from services.insights_service import execute_sql_tool

    try:
        if call.name != "execute_sql":
            raise ValueError(f"Unknown tool: {call.name}")
        return await execute_sql_tool(
            company_id=company_id,
            sql=call.arguments.get("sql", ""),
            description=call.arguments.get("description", ""),
            today=today,
        )
    except Exception as exc:  # noqa: BLE001 - hand the failure back to the model
        logger.warning("insights tool %s failed: %s", call.name, type(exc).__name__)
        return {"error": str(exc)}


def _estimate_tokens(text: str) -> int:
    """ceil(chars / 4), for the prose prompt and the question."""
    return -(-len(text or "") // CHARS_PER_TOKEN)


def _estimate_history_tokens(text: str) -> int:
    """ceil(chars / 3): conversation turns and summaries are denser than prose
    (HISTORY_CHARS_PER_TOKEN). The trigger's token_estimate column keeps chars/4
    and is informational; this is what the window is sized by."""
    return -(-len(text or "") // HISTORY_CHARS_PER_TOKEN)


def _history_budget(system_prompt: str, question: str) -> int:
    """How many tokens of summary + earlier turns this question may carry.

    Computed from the REAL system prompt rather than a constant, so the budget
    shrinks by itself when semantics.md grows -- and a test asserts the floor.
    """
    prefix = _estimate_tokens(system_prompt) + TOOLS_PREFIX_TOKENS
    fits = max(
        0,
        OLLAMA_NUM_CTX
        - prefix
        - MAX_TOKENS
        - TOOL_RESULT_HEADROOM_TOKENS
        - SUMMARY_MAX_TOKENS
        - _estimate_tokens(question),
    )
    # The window would allow ~7K; the cap keeps a cold turn -- the prefix cache
    # evicted because the box served something else -- to ~18K tokens of prefill,
    # about three minutes at the ~100 tokens/s this box manages uncached. A 21.7K
    # prompt ran past the 240 s timeout on 2026-09-07.
    return min(fits, HISTORY_MAX_TOKENS)


def _turn_tokens(turn: dict[str, Any]) -> int:
    return _estimate_history_tokens(str(turn.get("content") or ""))


def _window(history: list[dict[str, Any]], budget: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(evicted, kept): the newest turns that fit the budget, oldest evicted first.

    Evicted turns are not lost -- they are still rows in the thread -- they are
    just not replayed this turn, and the compaction after the answer folds them
    into the summary so the next question sees them that way.
    """
    kept: list[dict[str, Any]] = []
    total = 0
    for turn in reversed(history):
        cost = _turn_tokens(turn)
        if total + cost > budget:
            break
        kept.append(turn)
        total += cost
    kept.reverse()
    return history[: len(history) - len(kept)], kept


def _history_turns(summary: str | None, kept: list[dict[str, Any]]) -> list[Message]:
    """The replayed conversation, AFTER the system turn.

    The summary is a user turn, never part of the system prompt: inside the system
    turn it would change the prefix bytes on every compaction and evict the KV
    cache for the whole box. Consecutive user turns are legal on the native path
    and merged by Anthropic.
    """
    turns: list[Message] = []
    if summary and summary.strip():
        turns.append(Message(role="user", content=SUMMARY_PREAMBLE + summary.strip()))
    for turn in kept:
        content = str(turn.get("content") or "").strip()
        role = turn.get("role")
        if not content or role not in ("user", "assistant"):
            continue
        turns.append(Message(role=role, content=content))
    return turns


def _fold_request(prior_summary: str | None, folded: list[dict[str, Any]]) -> str:
    lines = [SUMMARY_INSTRUCTION, ""]
    if prior_summary and prior_summary.strip():
        lines += ["Previous summary:", prior_summary.strip(), ""]
    lines.append("Turns to fold in:")
    for turn in folded:
        speaker = "User" if turn.get("role") == "user" else "Analyst"
        lines.append(f"{speaker}: {str(turn.get('content') or '').strip()}")
    return "\n".join(lines)


async def _compact(
    ctx: JobContext,
    system_prompt: str,
    prior_summary: str | None,
    folded: list[dict[str, Any]],
) -> tuple[str, int]:
    """One call that folds the oldest turns into a new summary. Returns (text, tokens).

    SAME SYSTEM TURN, SAME TOOLS as the main call, on purpose: the chat template
    renders both into the prefix, so any other shape would evict the ~13K-token
    KV cache the next question relies on. The instruction says not to call a
    tool; a summary that does, or that is machine payload rather than prose, is
    refused -- never stored.
    """
    from tools.chat_tools import CHAT_TOOLS

    result = await llm.complete(
        ctx.feature,
        [
            Message(role="system", content=system_prompt),
            Message(role="user", content=_fold_request(prior_summary, folded)),
        ],
        max_tokens=SUMMARY_MAX_TOKENS,
        tools=CHAT_TOOLS,
        request_id=ctx.request_id,
        chain=ctx.chain,
        audit_writer=ctx.audit_writer,
    )
    tokens = result.tokens_in + result.tokens_out
    if result.tool_calls:
        raise LLMErrorEcho(
            "[summary_tool_call] the model called a tool instead of summarising",
            feature=ctx.feature, request_id=ctx.request_id,
            provider=result.provider, model=result.model, tokens_out=tokens,
        )
    text = _strip_inline_markdown(_strip_code_blocks(result.text)).strip()
    rule = classify_non_answer(text)
    if rule:
        raise LLMErrorEcho(
            f"[summary_not_prose:{rule}] {text[:_REJECTED_ECHO_CHARS]!r}",
            feature=ctx.feature, request_id=ctx.request_id,
            provider=result.provider, model=result.model, tokens_out=tokens,
        )
    return text, tokens


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


GROUNDING_CORRECTION = (
    "Your answer states figures that come from no query run in this turn: {figures}. "
    "Earlier turns of this conversation only tell you what the user means; they are not a "
    "source of numbers, even when they held the same figure. Run the query that produces "
    "each figure now and answer again, or say the figure is unavailable."
)


def _grounding_turns(text: str, figures: list[float]) -> list[Message]:
    """The corrective exchange for an answer that invented its numbers -- the 25-turn
    live conversation did so on six turns of twenty-four once it had history. Same
    shape as _correction_turns, same conditional assistant turn."""
    turns = [Message(role="assistant", content=text)] if text.strip() else []
    listed = ", ".join(f"{x:g}" for x in figures[:8])
    return turns + [Message(role="user", content=GROUNDING_CORRECTION.format(figures=listed))]


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
    from tools.chat_tools import CHAT_TOOLS, COMPOSE_REPORT_TOOL
    from tools.sql_executor import NOT_PERMITTED_KIND, SQL_ERROR_KIND

    if ctx.payload.get("kind") == "report":
        # A one-page executive summary through the report door: same chain, same
        # tools, same system turn, a different shape of answer. The other way in is
        # further down, when the model answers a question by calling compose_report.
        # services/ai_features/report.py.
        from services.ai_features import report

        return await report.run(ctx)

    question = (ctx.payload.get("question") or "").strip()
    if not question:
        raise ValueError("insights job payload has no question")

    # The caller's local date, bound as $2 by the executor. Absent only on a job row
    # enqueued before this field existed; those cannot reach a model needing a date,
    # because the validator refuses CURRENT_DATE and a query using $2 with nothing
    # bound fails loudly rather than answering from the server's clock.
    raw_today = ctx.payload.get("today")
    today = date.fromisoformat(raw_today) if raw_today else None

    # The conversation so far, as the route loaded it: the latest summary and
    # every turn after it. Absent on a one-off question and on every job row
    # enqueued before threads existed, which then run exactly as before.
    history: list[dict[str, Any]] = list(ctx.payload.get("history") or [])
    prior = ctx.payload.get("summary") or None
    prior_summary: str | None = (prior or {}).get("content") if isinstance(prior, dict) else None

    system_prompt = _build_chat_system_prompt()
    budget = _history_budget(system_prompt, question)
    evicted, kept = _window(history, budget)

    # No `system=` parameter anywhere in this layer: the system prompt is a turn,
    # and split_system() puts it where each vendor wants it. History goes AFTER
    # it and before the question -- the order the KV cache can reuse.
    messages = (
        [Message(role="system", content=system_prompt)]
        + _history_turns(prior_summary, kept)
        + [Message(role="user", content=question)]
    )

    # Every figure in the answer has to come from a query result of THIS turn.
    # Earlier turns tell the model what the user means, never what the number is:
    # a July zero it had queried licensed an August zero it had not.
    known_figures: set[float] = set()
    grounding_corrected = False

    tool_names: list[str] = []
    # What ran, for the thread's audit column. Never replayed into a prompt.
    tool_trace: list[dict[str, Any]] = []
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
            # ONE corrective turn for an answer that states figures this turn's
            # queries did not produce and the conversation never held. Once a
            # thread carries history the model answers "And in July?" from
            # memory; the correction sends it back to the tool.
            prose = _strip_inline_markdown(_flatten_markdown_tables(_strip_code_blocks(result.text)))
            refusable = echoes_exemplar(prose) or classify_non_answer(prose) is not None
            invented = [] if refusable else unsupported_figures(prose, known_figures)
            if invented and not grounding_corrected:
                grounding_corrected = True
                messages = messages + _grounding_turns(result.text, invented)
                logger.info(
                    "insights %s: correcting an ungrounded answer (%d figure(s))",
                    ctx.request_id, len(invented),
                )
                continue
            break

        # THE MODEL MAY ANSWER WITH A DOCUMENT. compose_report is how it says the
        # person asked for one -- a report, a one-pager, a PDF -- the way a
        # chart_config fence is how it says the answer wants a chart; there is no
        # Ask/Report picker for the person to choose. The brief it wrote, with the
        # conversation in view so "that" is resolved, becomes the report's request,
        # and the job settles as kind = 'report' (the executors flip the column from
        # the result). Nothing gathered so far is carried over: a page is gathered
        # for differently from a sentence, and the brief tells the report path what
        # to gather.
        handoff = next((c for c in result.tool_calls if c.name == COMPOSE_REPORT_TOOL), None)
        if handoff is not None:
            from services.ai_features import report

            brief = str(handoff.arguments.get("brief") or "").strip() or question
            logger.info("insights %s: the model asked for a report; composing", ctx.request_id)
            return await report.run(ctx, request=brief)

        # Run the tools first, then wire the messages: the count of refused
        # objects is what the eval asserts to zero, and it is invisible once the
        # dict has been through json.dumps.
        tool_results = [
            (call, await _run_tool(ctx.company_id, call, today))
            for call in result.tool_calls
        ]
        refused += sum(
            1 for _, r in tool_results if r.get("error_kind") == NOT_PERMITTED_KIND
        )
        for call, r in tool_results:
            if call.name != "execute_sql":
                continue
            trace: dict[str, Any] = {
                "sql": call.arguments.get("sql", ""),
                "description": call.arguments.get("description", ""),
            }
            if "error" not in r:
                # Zero rows is a SUCCESS: the query ran, and "none" is an answer.
                sql_ok += 1
                trace["row_count"] = r.get("row_count")
                numbers_in(r, known_figures)
            else:
                trace["error_kind"] = r.get("error_kind")
                if r.get("error_kind") == SQL_ERROR_KIND:
                    sql_failed += 1
            tool_trace.append(trace)

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
    if non_answer is None and echoes_exemplar(answer):
        # THE ONE RULE APPLIED TO A GROUNDED ANSWER TOO. The format example's
        # labels cannot be shop data, so a sentence carrying them is the example
        # read back -- developer text reaching the user -- whatever query ran.
        non_answer = "exemplar_echo"
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

    # THE GROUNDING GUARD, on the text the user would read: every figure comes
    # from a query result of this turn. The loop offered one corrective turn; a
    # second invented answer fails visibly rather than reaching the person as a
    # fact.
    ungrounded = unsupported_figures(answer, known_figures)
    if ungrounded:
        raise LLMErrorEcho(
            f"[ungrounded_figures] {len(ungrounded)} figure(s) in the answer come from no "
            f"query result of this turn: "
            f"{', '.join(f'{x:g}' for x in ungrounded[:6])}; {answer[:_REJECTED_ECHO_CHARS]!r}",
            feature=ctx.feature,
            request_id=ctx.request_id,
            provider=result.provider,
            model=result.model,
            tokens_out=tokens_used,
        )

    chart_config = _select_chart_type(
        _drop_exemplar_echo(_validate_chart_config(_extract_chart_config(raw))), question
    )

    # COMPACTION, AFTER THE ANSWER. The answer is the deliverable and is already
    # in hand; the summary is what makes the NEXT question cheap. Fold whenever
    # something was evicted this turn (it must reach the summary or it is lost to
    # the thread's context) or the replayed history has grown past the threshold.
    summary: str | None = None
    covers: int | None = None
    summary_error: str | None = None
    carried = sum(_turn_tokens(t) for t in kept) + _estimate_history_tokens(prior_summary or "")
    this_turn = _estimate_history_tokens(question) + _estimate_history_tokens(answer)
    if evicted or carried + this_turn > COMPACT_AT_FRACTION * budget:
        folded = list(evicted)
        remaining = list(kept)
        while remaining and (
            sum(_turn_tokens(t) for t in remaining) + this_turn > EVICT_TO_FRACTION * budget
        ):
            folded.append(remaining.pop(0))
        if folded:
            try:
                summary, extra = await _compact(ctx, system_prompt, prior_summary, folded)
                tokens_used += extra
                covers = int(folded[-1]["seq"])
            except LLMError as exc:
                # The answer is not discarded for a failed summary. The thread
                # still holds every turn, the ai_calls row already names the
                # failure, and the next question tries again. Recorded on the
                # result rather than swallowed, so it is countable.
                summary_error = exc.as_error_text()[:300]
                logger.warning("insights %s: compaction failed: %s", ctx.request_id, summary_error)

    return {
        "answer": answer,
        "chart_config": chart_config,
        "tool_calls": tool_names,
        "tool_trace": tool_trace,
        "provider": result.provider,
        "model": result.model,
        "tokens_used": tokens_used,
        # Zero is the acceptance bar: a refused object should end the turn, so a
        # non-zero count means the context is still advertising what it cannot read.
        "not_permitted": refused,
        # The templated refusal for a question that is not about the shop, flagged
        # so PostHog can count the rate without reading a question. Exact match:
        # the template is prose with no markdown, so the scrub leaves it intact.
        "off_topic": answer.strip() == OFF_TOPIC_REPLY,
        # The model stated figures its queries did not produce and was sent back
        # to the tool once. Its rate says how often a thread tempts the model to
        # answer from memory.
        "grounding_corrected": grounding_corrected,
        # Read by the ai_jobs trigger, never by the browser: a summary row is
        # written only when these are set.
        "summary": summary,
        "summary_covers_through_seq": covers,
        "summary_error": summary_error,
    }
