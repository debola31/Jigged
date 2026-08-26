"""The A/B's `answered` column has to mean a shop owner got an answer.

WHAT IT USED TO MEAN. `ok` was set by "the handler returned without raising", so
an arm whose final turn was "The column total_price does not exist..." scored
11/11 answered. The table said the local arms were doing better than they were,
which is the one thing a gate-deciding eval must not do -- FLIP_CONDITION is
stated before the run precisely so the numbers cannot be argued with afterwards,
and that is worthless if the numbers are measuring the wrong thing.

ONE PREDICATE, TWO CALLERS. The eval scores with the same function the handler
gates on, asserted by identity below, so the two can never drift into
disagreeing about what an answer is.
"""
from __future__ import annotations

import pytest

pytestmark = pytest.mark.unit


def _outcome(**kw):
    from evals.insights_ab import Outcome

    base = dict(arm="ollama", question="how many jobs are late?", ok=True, tool_calls=1)
    return Outcome(**{**base, **kw})


def test_the_eval_and_the_handler_share_one_predicate():
    """Not two copies that agree today. The reason semantics.md is rendered into
    the prompt rather than paraphrased in Python is the same reason as this."""
    from evals import insights_ab
    from services import insights_presentation

    assert insights_ab.looks_like_error_echo is insights_presentation.looks_like_error_echo


@pytest.mark.parametrize("answer", [
    pytest.param("The column total_price does not exist.", id="echoed-column-error"),
    pytest.param("The SQL query encountered a syntax error, please review.", id="echoed-syntax"),
    pytest.param("", id="empty"),
    pytest.param("   \n ", id="whitespace"),
])
def test_an_echo_or_an_empty_string_is_not_an_answer(answer):
    assert _outcome(answer=answer).answered is False


@pytest.mark.parametrize("answer", [
    pytest.param("You have 4 late jobs.", id="a-figure"),
    pytest.param("Jigged does not track payroll, so that cannot be calculated here.",
                 id="a-decline"),
    pytest.param("Three jobs came back with an error code.", id="error-as-shop-data"),
])
def test_a_substantive_answer_counts(answer):
    assert _outcome(answer=answer).answered is True


def test_a_run_that_raised_is_never_answered():
    assert _outcome(ok=False, error="LLMErrorEcho: ...", answer="").answered is False


def test_grounded_requires_answered():
    """`grounded` asks whether a number came from a query. A non-answer has no
    number and no query, and counting it as grounded would flatter the arm
    twice for the same failure."""
    assert _outcome(answer="The column total_price does not exist.", tool_calls=1).grounded is False
    assert _outcome(answer="You have 4 late jobs.", tool_calls=1).grounded is True


def test_the_eval_is_stricter_than_the_handler_on_purpose():
    """The handler lets an echo through when a query succeeded -- it is a floor
    under "no data at all", not a judge. A scoring pass has no such duty, and it
    cannot see which tool results succeeded anyway: it holds the answer text and
    a count of tool calls."""
    assert _outcome(answer="Query execution failed: relation does not exist",
                    tool_calls=3).answered is False
