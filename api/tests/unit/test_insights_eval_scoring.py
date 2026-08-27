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


def test_grounded_separates_an_honest_decline_from_an_invented_figure():
    """The one thing this column is for, and the reason it survived being retired.

    It was nearly deleted on 2026-08-27: across the five-arm run it read 11/11 for
    every arm, including one that got 3 of 11 queries to execute, so it plainly
    cannot rank arms that all call the tool. Then Arctic-Text2SQL-R1-7B was put
    through the tool loop and made ZERO tool calls on eleven questions -- it
    narrated prose about the SQL it would write -- and scored 8/11 answered against
    0/11 grounded.

    `used sql` says a query never ran. It does not say whether the answer contained
    numbers anyway, and that is the whole difference between an arm that declined
    and an arm that invented. No other column carries it.
    """
    invented = _outcome(answer="Your revenue this quarter is $40,000.", tool_calls=0)
    declined = _outcome(answer="Jigged does not track payroll, so that is unavailable.", tool_calls=0)

    assert invented.answered is True, "both reach the user as substantive prose"
    assert declined.answered is True

    assert invented.grounded is False
    assert declined.grounded is True


def test_grounded_requires_answered():
    """A non-answer has no number and no query, and counting it as grounded would
    flatter the arm twice for one failure."""
    assert _outcome(answer="The column total_price does not exist.", tool_calls=1).grounded is False
    assert _outcome(answer="You have 4 late jobs.", tool_calls=1).grounded is True


def test_grounded_cannot_catch_a_wrong_number_that_came_from_a_query():
    """Labelled as a crude proxy in its own docstring, and pinned so nobody reads a
    passing groundedness column as "the figures are right". The five-arm run scored
    an answer grounded that reported the company's gross profit when asked for the
    average value of a job."""
    assert _outcome(answer="The average job value is $60,861.51.", tool_calls=1).grounded is True

def test_the_eval_is_stricter_than_the_handler_on_purpose():
    """The handler lets an echo through when a query succeeded -- it is a floor
    under "no data at all", not a judge. A scoring pass has no such duty, and it
    cannot see which tool results succeeded anyway: it holds the answer text and
    a count of tool calls."""
    assert _outcome(answer="Query execution failed: relation does not exist",
                    tool_calls=3).answered is False
