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


def test_grounded_is_gone_and_stays_gone():
    """Retired 2026-08-27, and pinned so it is not quietly reinstated.

    It asked "does this answer contain digits without a tool call?", and every arm
    calls the tool -- so it read 11/11 for all five arms of the five-arm run,
    including one that got 3 of 11 queries to execute and one that answered "what
    is the average value of a job this quarter?" with the company's gross profit.
    A gate leg that cannot separate two arms is not a weak signal, it is no signal,
    and FLIP_CONDITION carried it as one of three.

    Reinstating it needs a definition that can tell those arms apart. For the
    pipeline arms an untraceable number is already impossible by construction, and
    for the tool-loop arms the handler reports no per-query outcome to compute it
    from -- so that definition does not exist at this seam today.
    """
    from evals.insights_ab import FLIP_CONDITION, Outcome

    assert not hasattr(Outcome, "grounded")
    assert "WITHDRAWN" in FLIP_CONDITION

def test_the_eval_is_stricter_than_the_handler_on_purpose():
    """The handler lets an echo through when a query succeeded -- it is a floor
    under "no data at all", not a judge. A scoring pass has no such duty, and it
    cannot see which tool results succeeded anyway: it holds the answer text and
    a count of tool calls."""
    assert _outcome(answer="Query execution failed: relation does not exist",
                    tool_calls=3).answered is False
