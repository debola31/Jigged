"""Long conversations on a fixed window: what is replayed, and when it is folded.

THE TWO PROPERTIES THAT MATTER, in order of cost if they break.

  1. The system turn is BYTE-IDENTICAL with or without history, and the summary
     call reuses it with the same tools. Ollama's cache is llama.cpp's longest-
     common-prefix cache; the ~13K-token prefix is reused only while nothing in
     front of the history changes. A summary inside the system prompt, or a
     summary call without the tool schema, evicts it for the whole box.

  2. Compaction runs AFTER the answer, never before it, and a failed summary
     never costs the answer. The answer is the deliverable; the summary is what
     makes the next question cheap, and every turn is still a row in the thread.

The budget is patched to small numbers so the tests are about arithmetic, not
about how long a fake system prompt happens to be.
"""
from __future__ import annotations

from contextlib import ExitStack
from unittest.mock import patch

import pytest

from services.ai_features import insights
from services.ai_features.base import JobContext
from services.llm.base import LLMResult, Message
from services.llm.errors import LLMChainExhausted, LLMTimeout
from tests.unit.test_insights_loop_integrity import SQL_FAILED, SQL_OK, Conversation, _answer, _asks_for_sql
from tools.sql_executor import SQL_ERROR_KIND

pytestmark = pytest.mark.unit


class Recording(Conversation):
    """The scripted model, also recording the kwargs of every call and able to fail."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.kwargs: list[dict] = []

    async def complete(self, feature, messages, **kwargs):
        self.kwargs.append(kwargs)
        if self.turns and isinstance(self.turns[0], Exception):
            self.seen.append(list(messages))
            raise self.turns.pop(0)
        return await super().complete(feature, messages, **kwargs)


def _turn(seq: int, role: str, content: str) -> dict:
    return {"seq": seq, "role": role, "content": content}


def _history(n: int, chars: int = 40) -> list[dict]:
    """n turns alternating user/assistant, each `chars` long -> chars/4 tokens each."""
    return [
        _turn(i + 1, "user" if i % 2 == 0 else "assistant", f"t{i + 1}-".ljust(chars, "x"))
        for i in range(n)
    ]


async def run_with(convo: Conversation, payload: dict, budget: int | None = None) -> dict:
    with ExitStack() as stack:
        stack.enter_context(patch.object(insights.llm, "complete", convo.complete))
        stack.enter_context(patch.object(insights, "_run_tool", convo.run_tool))
        stack.enter_context(patch("services.insights_service._build_chat_system_prompt", return_value="SYSTEM"))
        if budget is not None:
            stack.enter_context(patch.object(insights, "_history_budget", return_value=budget))
        return await insights.run(JobContext(
            feature="insights", company_id="c0", request_id="rid",
            payload={"question": "and by month?", "today": "2026-09-07", **payload},
        ))


def _roles(messages: list[Message]) -> list[str]:
    return [m.role for m in messages]


# ------------------------------------------------------------------ replay


async def test_a_payload_without_conversation_keys_runs_exactly_as_before():
    """Evals and every job row enqueued before threads existed."""
    convo = Recording(turns=[_answer("Four.")])
    result = await run_with(convo, {})
    assert _roles(convo.seen[0]) == ["system", "user"]
    assert convo.calls == 1
    assert (result["summary"], result["summary_covers_through_seq"], result["summary_error"]) == (None, None, None)


async def test_history_is_replayed_after_the_system_turn_and_before_the_question():
    convo = Recording(turns=[_answer("Four.")])
    await run_with(convo, {
        "summary": {"content": "We discussed late jobs.", "covers_through_seq": 2},
        "history": [_turn(3, "user", "q3"), _turn(4, "assistant", "a4")],
    })
    seen = convo.seen[0]
    assert _roles(seen) == ["system", "user", "user", "assistant", "user"]
    assert seen[0].text() == "SYSTEM"
    assert seen[1].text() == insights.SUMMARY_PREAMBLE + "We discussed late jobs."
    assert (seen[2].text(), seen[3].text()) == ("q3", "a4")
    assert seen[4].text() == "and by month?"


async def test_the_system_turn_is_byte_identical_with_and_without_history():
    """THE PREFIX. The summary goes in a user turn precisely so this holds."""
    bare = Recording(turns=[_answer("x")])
    await run_with(bare, {})
    threaded = Recording(turns=[_answer("x")])
    await run_with(threaded, {"summary": {"content": "S", "covers_through_seq": 1},
                              "history": [_turn(2, "user", "q"), _turn(3, "assistant", "a")]})
    assert bare.seen[0][0] == threaded.seen[0][0]


async def test_over_budget_history_keeps_the_newest_turns_and_folds_the_rest():
    # Six 10-token turns against a 30-token budget: the newest three fit.
    convo = Recording(turns=[_answer("Four."), _answer("Earlier we covered t1 to t3.")])
    result = await run_with(convo, {"history": _history(6)}, budget=30)

    replayed = [m.text() for m in convo.seen[0] if m.role in ("user", "assistant")]
    assert [t[:3] for t in replayed[:-1]] == ["t4-", "t5-", "t6-"]
    # The evicted turns must reach the summary or they are lost to the thread --
    # and the fold keeps going past them, down to half the budget, so the next
    # question has room. With a budget this small that is everything.
    assert convo.calls == 2
    assert result["summary"] == "Earlier we covered t1 to t3."
    assert result["summary_covers_through_seq"] >= 3


# ---------------------------------------------------------------- compaction


async def test_compaction_reuses_the_system_turn_and_the_tools():
    from tools.chat_tools import CHAT_TOOLS

    convo = Recording(turns=[_answer("Four."), _answer("Summary.")])
    await run_with(convo, {"history": _history(6)}, budget=30)

    main, summary = convo.seen
    assert summary[0] == main[0], "the summary call must start with the identical system turn"
    assert _roles(summary) == ["system", "user"]
    assert convo.kwargs[1]["tools"] is CHAT_TOOLS
    assert convo.kwargs[1]["max_tokens"] == insights.SUMMARY_MAX_TOKENS


async def test_the_fold_request_carries_the_previous_summary_and_only_the_folded_turns():
    # Eight 10-token turns fit a 100-token budget but sit past 70 %; the fold
    # takes the oldest four (down to 40 + this turn <= 50) and leaves t5..t8.
    convo = Recording(turns=[_answer("Four."), _answer("Summary.")])
    await run_with(convo, {
        "summary": {"content": "Older still.", "covers_through_seq": 0},
        "history": _history(8),
    }, budget=100)

    request = convo.seen[1][1].text()
    assert insights.SUMMARY_INSTRUCTION in request
    assert "Previous summary:" in request and "Older still." in request
    assert "t1-" in request and "t4-" in request
    assert "t5-" not in request, "kept turns are not folded"


async def test_a_thread_under_the_threshold_is_not_compacted():
    convo = Recording(turns=[_answer("Four.")])
    result = await run_with(convo, {"history": _history(2)}, budget=10_000)
    assert convo.calls == 1
    assert result["summary"] is None and result["summary_covers_through_seq"] is None


async def test_compaction_fires_past_the_threshold_even_with_nothing_evicted():
    """Eight 10-token turns fit an 100-token budget, but 80 > 70 %: fold the oldest
    down to half so the NEXT question has room, and do not fold again until then."""
    convo = Recording(turns=[_answer("Four."), _answer("Summary.")])
    result = await run_with(convo, {"history": _history(8)}, budget=100)

    assert convo.calls == 2
    covers = result["summary_covers_through_seq"]
    assert covers is not None
    remaining = [t for t in _history(8) if t["seq"] > covers]
    this_turn = insights._estimate_tokens("and by month?") + insights._estimate_tokens("Four.")
    assert sum(insights._turn_tokens(t) for t in remaining) + this_turn <= 50
    assert result["summary"] == "Summary."


async def test_compaction_happens_after_the_answer_not_before():
    """The first call is the question; the summary is never asked for first."""
    convo = Recording(turns=[_answer("Four."), _answer("Summary.")])
    await run_with(convo, {"history": _history(6)}, budget=30)
    assert convo.seen[0][-1].text() == "and by month?"
    assert insights.SUMMARY_INSTRUCTION in convo.seen[1][-1].text()


async def test_summary_tokens_count_toward_the_jobs_total():
    convo = Recording(turns=[_answer("Four."), _answer("Summary.")])
    result = await run_with(convo, {"history": _history(6)}, budget=30)
    assert result["tokens_used"] == 2 * 15  # _answer() results are 10 in + 5 out each


# ---------------------------------------------------------- summary failures


async def test_a_summary_that_is_a_tool_call_is_refused_but_the_answer_survives():
    convo = Recording(turns=[_answer("Four."), _asks_for_sql()])
    result = await run_with(convo, {"history": _history(6)}, budget=30)
    assert result["answer"] == "Four."
    assert result["summary"] is None and result["summary_covers_through_seq"] is None
    assert "summary_tool_call" in result["summary_error"]


async def test_a_summary_that_is_machine_payload_is_refused():
    convo = Recording(turns=[_answer("Four."), _answer("SQL_ERROR: column x does not exist")])
    result = await run_with(convo, {"history": _history(6)}, budget=30)
    assert result["answer"] == "Four."
    assert "summary_not_prose" in result["summary_error"]


async def test_a_provider_failure_during_compaction_keeps_the_answer():
    boom = LLMChainExhausted("insights", "rid", [LLMTimeout("slow", provider="ollama")])
    convo = Recording(turns=[_answer("Four."), boom])
    result = await run_with(convo, {"history": _history(6)}, budget=30)
    assert result["answer"] == "Four."
    assert result["summary"] is None
    assert "LLMChainExhausted" in result["summary_error"]


# ------------------------------------------------------------------- budget


def test_the_budget_floor_against_the_real_prompt():
    """Fires the day semantics.md grows too far: a 500-char question must still
    leave at least 4,000 tokens for a conversation."""
    from services.insights_service import _build_chat_system_prompt

    assert insights._history_budget(_build_chat_system_prompt(), "x" * 500) >= 4_000


def test_the_estimate_rounds_up():
    assert insights._estimate_tokens("") == 0
    assert insights._estimate_tokens("abcd") == 1
    assert insights._estimate_tokens("abcde") == 2


def test_the_window_keeps_the_newest_contiguous_run():
    evicted, kept = insights._window(_history(6), budget=25)
    assert [t["seq"] for t in kept] == [5, 6]
    assert [t["seq"] for t in evicted] == [1, 2, 3, 4]
    assert insights._window([], 100) == ([], [])


# ------------------------------------------------------------------- trace


async def test_the_tool_trace_records_each_query_without_its_rows():
    convo = Recording(
        turns=[_asks_for_sql("SELECT 1 FROM jobs WHERE company_id = $1"), _answer("Four.")],
        tool_results=[SQL_OK],
    )
    result = await run_with(convo, {})
    assert result["tool_trace"] == [
        {"sql": "SELECT 1 FROM jobs WHERE company_id = $1", "description": "d", "row_count": 1}
    ]


async def test_a_failed_query_is_traced_by_its_kind():
    convo = Recording(
        turns=[_asks_for_sql("SELECT nope"), _asks_for_sql("SELECT 1"), _answer("Four.")],
        tool_results=[SQL_FAILED, SQL_OK],
    )
    result = await run_with(convo, {})
    assert result["tool_trace"][0]["error_kind"] == SQL_ERROR_KIND
    assert result["tool_trace"][1]["row_count"] == 1
