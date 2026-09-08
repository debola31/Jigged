"""Figures in an answer must come from somewhere the reader can trust.

THE FINDING THIS FILE EXISTS FOR. The 25-turn live conversation on qwen3:32b
(2026-09-07, seeded shop, through the real route, queue and worker): once the
thread carried history, six of twenty-four answers stated figures without running
a query. "And in July?" produced $21,564.12 against a real $23,518.67; August
$23,789.45 against $75,668.71; a quarter average, a work-centre ranking and a
top-three share came from nowhere. In the single-turn eval every question ran a
query. Earlier turns tell the model what the user means; they must never become
its source of numbers.
"""
from __future__ import annotations

import pytest

from services.ai_features import insights
from services.insights_presentation import figures_in_text, numbers_in, unsupported_figures
from services.llm.errors import LLMErrorEcho
from tests.unit.test_insights_conversation import Recording, _turn, run_with
from tests.unit.test_insights_loop_integrity import _answer, _asks_for_sql

pytestmark = pytest.mark.unit

BOOKED_JULY = {"columns": ["booked"], "rows": [{"booked": "23518.67"}], "row_count": 1, "description": "booked in July"}


# ------------------------------------------------------------ the extractor


def test_figures_are_money_percentages_decimals_and_every_count():
    text = ("Booked $12,330.83, a 62.3% share, 1,234 parts, 4.5 days, $23.5K in August, 19 open jobs, "
            "0 jobs in July; top 5 by value, due 2026-09-03, job J-0020, quote #12, in 2026, "
            "id 6ba7b810-9dad-11d1-80b4-00c04fd430c8.")
    assert figures_in_text(text) == {12330.83, 62.3, 1234.0, 4.5, 23500.0, 19.0, 0.0, 5.0}


def test_a_figure_rounded_by_the_model_still_traces_to_its_result():
    assert unsupported_figures("July was $23,519.", {23518.67}) == []
    # A ratio the SQL returned as 0.714 and the model wrote as a percentage.
    assert unsupported_figures("A 71% win rate.", {0.714}) == []
    assert unsupported_figures("July was $21,564.12.", {23518.67}) == [21564.12]


def test_numbers_in_walks_rows_and_money_strings():
    seen: set[float] = set()
    numbers_in(BOOKED_JULY, seen)
    assert 23518.67 in seen and 1.0 in seen  # the value, and row_count


# ------------------------------------------------------------- the handler


async def test_a_figure_from_no_query_earns_one_corrective_turn_and_then_a_query():
    convo = Recording(
        turns=[_answer("The total booked in July is $21,564.12."), _asks_for_sql(), _answer("July was $23,519.")],
        tool_results=[BOOKED_JULY],
    )
    result = await run_with(convo, {"history": [_turn(1, "user", "What did we book in June?"), _turn(2, "assistant", "June was $19,227.39.")]})

    assert convo.calls == 3
    correction = convo.seen[1][-1]
    assert correction.role == "user"
    assert "no query" in correction.text() and "21564.1" in correction.text()
    assert result["answer"] == "July was $23,519."
    assert result["grounding_corrected"] is True
    assert result["tool_calls"] == ["execute_sql"]


async def test_an_answer_still_invented_after_the_correction_fails_visibly():
    convo = Recording(turns=[_answer("July was $21,564.12."), _answer("As I said, July was $21,564.12.")])
    with pytest.raises(LLMErrorEcho, match=r"\[ungrounded_figures\]"):
        await run_with(convo, {})
    assert convo.calls == 2


async def test_a_figure_quoted_from_the_conversation_is_still_queried_this_turn():
    """"0 jobs in July", queried, licensed "0 jobs in August", never queried and
    wrong, when history counted as a source. It no longer does: a figure worth
    repeating is worth one query."""
    june = {"columns": ["booked"], "rows": [{"booked": "19227.39"}], "row_count": 1, "description": "June"}
    convo = Recording(
        turns=[_answer("June, at $19,227.39, was the better month."), _asks_for_sql(), _answer("June, at $19,227.39, was the better month.")],
        tool_results=[june],
    )
    result = await run_with(convo, {"history": [_turn(1, "user", "What did we book in June?"), _turn(2, "assistant", "June was $19,227.39.")]})
    assert convo.calls == 3
    assert result["grounding_corrected"] is True


async def test_a_zero_is_a_figure():
    convo = Recording(turns=[_answer("We booked 0 jobs in August."), _answer("We booked 0 jobs in August.")])
    with pytest.raises(LLMErrorEcho, match=r"\[ungrounded_figures\]"):
        await run_with(convo, {"history": [_turn(1, "user", "And in July?"), _turn(2, "assistant", "We booked 0 jobs in July.")]})


async def test_a_count_the_query_returned_as_rows_is_grounded_by_row_count():
    rows = {"columns": ["customer"], "rows": [{"customer": "A"}, {"customer": "B"}, {"customer": "C"}], "row_count": 3, "description": "d"}
    convo = Recording(turns=[_asks_for_sql(), _answer("3 customers have not ordered in six months: A, B and C.")], tool_results=[rows])
    result = await run_with(convo, {})
    assert result["answer"].startswith("3 customers") and result["grounding_corrected"] is False


async def test_prose_without_figures_needs_no_query():
    convo = Recording(turns=[_answer("Ironclad Fabrication has the most open jobs among those customers.")])
    result = await run_with(convo, {"history": [_turn(1, "user", "q"), _turn(2, "assistant", "Ironclad: three late jobs.")]})
    assert result["answer"].startswith("Ironclad") and convo.calls == 1


async def test_chart_rows_in_the_fence_are_not_prose_figures():
    """The chart carries the query's own rows; only the sentence is judged."""
    fence = '''Bookings by month are below.
```json
{"chart_type": "bar", "x_key": "m", "y_key": "v", "x_label": "Month", "y_label": "Booked", "data": [{"m": "Jun", "v": 19227.39}, {"m": "Jul", "v": 23518.67}, {"m": "Aug", "v": 75668.71}]}
```'''
    convo = Recording(turns=[_asks_for_sql(), _answer(fence)], tool_results=[{"columns": ["m", "v"], "rows": [{"m": "Jun", "v": 19227.39}, {"m": "Jul", "v": 23518.67}, {"m": "Aug", "v": 75668.71}], "row_count": 3, "description": "d"}])
    result = await run_with(convo, {})
    assert result["answer"].startswith("Bookings by month")
    assert result["chart_config"] is not None


def test_history_is_estimated_denser_than_the_prompt():
    """Measured 2026-09-07 against qwen3:32b's own prompt_eval_count: the prose
    prompt tokenises at ~4 chars/token, the live thread at 3.3, a digit-heavy
    history at 2.4. The window that used chars/4 for a 22.9K-char history put it
    at 5.7K tokens; the model counted 9.5K, and compaction never fired."""
    assert insights.HISTORY_CHARS_PER_TOKEN == 3
    assert insights._turn_tokens({"content": "x" * 30}) == 10
    assert insights._estimate_tokens("x" * 40) == 10


def test_the_prompt_tells_the_model_earlier_turns_are_not_a_source_of_figures():
    from services.insights_service import _build_chat_system_prompt
    assert "never a source of figures" in _build_chat_system_prompt()
