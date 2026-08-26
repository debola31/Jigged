"""What counts as an answer, in one place, for the handler and the A/B alike.

WHY THIS GREW. The predicate started as "did the model read a database error
back to the user", because that was the failure the first eval showed. The next
eval showed a different one that it scored as a perfectly good answer: Arctic's
final turn on "Which parts have no routing yet?" was the literal text

    <execute_sql>
    {"description": "...", "sql": "SELECT ..."}

printed as prose, with zero tool calls -- the model narrating a tool call it
never made. No error language anywhere in it, so both the gate and the eval waved
it through.

The rule that covers both, and the one being tested here: A FINAL TURN IS A
NON-ANSWER WHEN IT IS, IN SUBSTANCE, MACHINE PAYLOAD RATHER THAN PROSE. A
database error is one kind of machine payload. An unexecuted tool call is
another.

THE NEGATIVE CASES ARE THE POINT. A predicate this broad earns its keep only if
it cannot fire on a real answer, so every rule below is anchored on structure --
a tag, a JSON key in key position, a fence that IS the message -- never on
vocabulary. "We should select the top vendors" is prose about selecting. An
answer that names a column while reporting real figures is an answer.
"""
from __future__ import annotations

import pytest

from services.insights_presentation import classify_non_answer, looks_like_error_echo

pytestmark = pytest.mark.unit


# ------------------------------------------------------------ non-answers

# Arctic's actual final turn, and the shapes around it.
PSEUDO_TOOL_CALLS = [
    pytest.param(
        '<execute_sql>\n{"description": "Parts with no routing", '
        '"sql": "SELECT p.part_number FROM parts p WHERE p.company_id = $1"}',
        "tool_call_tag",
        id="arctic-verbatim",
    ),
    pytest.param("<execute_sql>", "tool_call_tag", id="bare-tag"),
    pytest.param("</execute_sql>", "tool_call_tag", id="closing-tag"),
    pytest.param("<get_revenue_by_period>{}</get_revenue_by_period>", "tool_call_tag",
                 id="a-different-tool-name"),
    pytest.param(
        '{"description": "parts with no routing", "sql": "SELECT 1"}',
        "sql_payload",
        id="json-payload-no-tag",
    ),
    pytest.param(
        'Here is the query I would run: {"sql": "SELECT p.id FROM parts p", '
        '"description": "d"}',
        "sql_payload",
        id="json-payload-with-a-preamble",
    ),
    pytest.param(
        "```sql\nSELECT p.part_number FROM parts p WHERE p.company_id = $1\n```",
        "sql_block",
        id="a-fence-that-is-the-whole-message",
    ),
    pytest.param(
        "Here you go:\n```sql\nSELECT p.part_number, p.description FROM parts p\n"
        "WHERE p.company_id = $1 AND NOT EXISTS (SELECT 1 FROM routings r)\n```",
        "sql_block",
        id="a-fence-with-a-throwaway-line-around-it",
    ),
]


@pytest.mark.parametrize("text,reason", PSEUDO_TOOL_CALLS)
def test_an_unexecuted_tool_call_is_not_an_answer(text, reason):
    assert classify_non_answer(text) == reason
    assert looks_like_error_echo(text) is True


def test_the_reason_is_reported_so_the_failure_says_which_rule_fired():
    """A job row that says only "not an answer" sends whoever is triaging back to
    the transcript. Naming the rule is the difference between a countable failure
    mode and a shrug."""
    assert classify_non_answer("") == "empty"
    assert classify_non_answer("The column x does not exist.") == "error_echo"
    assert classify_non_answer("<execute_sql>") == "tool_call_tag"
    assert classify_non_answer("You have 4 late jobs.") is None


# --------------------------------------------------------------- answers

REAL_ANSWERS = [
    # The two the brief names explicitly.
    pytest.param("We should select the top vendors by spend before renegotiating.",
                 id="prose-using-the-word-select"),
    pytest.param("Total total_price across shipped jobs was $48,210 last quarter.",
                 id="names-a-column-but-reports-figures"),
    # And the surrounding ground a structural rule could too easily take.
    pytest.param("Acme: $50,120, Globex: $35,400, Initech: $28,900.", id="an-inline-list"),
    pytest.param("No parts are missing a routing.", id="a-flat-answer"),
    pytest.param("Jigged does not track payroll, so that cannot be calculated here.",
                 id="a-decline"),
    pytest.param("Three jobs came back with an error code this week.", id="error-as-shop-data"),
    pytest.param("Revenue is up 12% on the quarter, driven by the Acme reorder.",
                 id="a-comparison"),
    pytest.param("The sql column on that report is blank for 4 parts.",
                 id="the-word-sql-in-prose"),
]


@pytest.mark.parametrize("text", REAL_ANSWERS)
def test_a_real_answer_is_never_taken_for_machine_payload(text):
    assert classify_non_answer(text) is None, f"a real answer was rejected: {text!r}"
    assert looks_like_error_echo(text) is False


def test_an_answer_that_quotes_a_little_sql_is_still_an_answer():
    """The fence rule is about a fence that IS the message. An answer that
    explains itself and happens to show the filter it used is prose with a
    citation in it, and rejecting that would push the model away from showing
    its work."""
    text = (
        "Four parts have no routing: PN-1001, PN-1002, PN-1188 and PN-1203. "
        "I counted parts with no matching row in routings, excluding archived "
        "parts, over the whole catalogue rather than a date window, because "
        "routing is not dated. Here is the filter I used, for the record: "
        "```sql\nNOT EXISTS (SELECT 1 FROM routings r WHERE r.part_id = p.id)\n```"
    )

    assert classify_non_answer(text) is None
