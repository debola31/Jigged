"""A failed query is an instruction to the model, never a sentence for the user.

THE BUG THIS PINS. Across every local arm of the insights A/B the model's last
turn WAS the tool's error text -- "The column total_price does not exist...",
"The SQL query encountered a syntax error, please review..." -- and the handler
returned it as the answer with the job marked succeeded. The executor had said
what went wrong and nothing about what to do next, so describing it back was a
reasonable thing for a model to do with it.

Three layers stop that now. This file is the first: the tool result names the
failure as retryable, says to rewrite and run again, and says in words not to
repeat it to the user. The other two -- one corrective turn, then a gate on the
final answer -- are in test_insights_loop_integrity.py.

A REFUSED OBJECT IS UNTOUCHED, and that separation is the whole design.
NOT_PERMITTED stays terminal: no rewrite grants a privilege, and telling the
model to try once more is precisely the retry loop classify_not_permitted was
written to delete. So is infrastructure: a dead pool is not the model's mistake.
"""
from __future__ import annotations

import uuid

import pytest

from tools.sql_executor import (
    NOT_PERMITTED_KIND,
    SQL_ERROR_KIND,
    classify_not_permitted,
    execute_sql_query,
    retryable_sql_error,
)

pytestmark = pytest.mark.unit


# The messages that actually came back during the eval, plus the two shapes the
# executor synthesises itself.
POSTGRES_MESSAGES = [
    pytest.param('column "total_price" does not exist', id="undefined-column"),
    pytest.param('syntax error at or near "slect"', id="syntax"),
    pytest.param("canceling statement due to statement timeout", id="timeout"),
    pytest.param("operator does not exist: uuid = text", id="type-mismatch"),
]


@pytest.mark.parametrize("message", POSTGRES_MESSAGES)
def test_a_failed_query_is_handed_back_as_an_instruction(message):
    result = retryable_sql_error(message)

    assert result["error"].startswith("SQL_ERROR: "), result["error"]
    assert message[:20] in result["error"], "the cause has to survive the reshaping"
    # The two sentences that make it an instruction rather than a description.
    assert "Rewrite the query using this error and execute again." in result["error"]
    assert "Never describe this error to the user." in result["error"]
    assert result["error_kind"] == SQL_ERROR_KIND
    assert result["rows"] == []


def test_the_message_is_one_line():
    """Postgres pads a message with DETAIL/HINT/CONTEXT lines and a caret diagram.
    A tool result is read by a model that will paste back whatever shape it is
    given, so it arrives as one line or the instruction is buried under a
    position marker."""
    result = retryable_sql_error(
        'syntax error at or near "FORM"\nLINE 1: SELECT * FORM jobs\n               ^\nHINT:  try FROM'
    )

    assert "\n" not in result["error"]
    assert "FORM" in result["error"]


def test_a_very_long_message_is_capped():
    """A generated query can put a whole statement in the error text, and the
    tool result is prompt on every remaining turn."""
    result = retryable_sql_error("x" * 5000)

    assert len(result["error"]) < 600
    assert result["error"].endswith("Never describe this error to the user.")


async def test_a_query_the_validator_refuses_is_shaped_the_same_way():
    """Reaches the branch with no database: validation runs before init_pool().

    A rejection here is the same KIND of failure as a syntax error -- the model
    wrote the wrong query and can write a better one -- so it gets the same
    result shape. That is what lets the loop count "failed, and fixable" as one
    thing instead of inspecting message text.
    """
    result = await execute_sql_query(
        company_id=str(uuid.uuid4()),
        sql="SELECT COUNT(*) FROM customers",  # no $1
        description="missing the placeholder",
    )

    assert result["error"].startswith("SQL_ERROR: ")
    assert result["error_kind"] == SQL_ERROR_KIND
    assert "Rewrite the query using this error and execute again." in result["error"]
    # The old shape carried the advice in a second key nothing rendered.
    assert "suggestion" not in result
    assert "$1" in result["error"], "the fixable detail must survive the reshaping"


async def test_our_own_broken_wiring_is_not_dressed_up_as_the_models_mistake():
    """company_id is bound by the executor, never written by the model. Telling
    it to "rewrite the query and try again" would spend a turn on something no
    rewrite can reach."""
    result = await execute_sql_query(
        company_id="not-a-uuid",
        sql="SELECT COUNT(*) AS n FROM customers WHERE company_id = $1",
        description="bad company id",
    )

    assert "error" in result
    assert result.get("error_kind") != SQL_ERROR_KIND
    assert "SQL_ERROR" not in result["error"]


def test_a_refused_object_is_still_terminal_and_carries_no_retry_instruction():
    """The regression guard for this whole change. If SQL_ERROR shaping ever
    swallowed the not-permitted branch, every arm would go back to spending its
    five turns re-asking for a privilege."""
    import asyncpg

    result = classify_not_permitted(
        asyncpg.exceptions.InsufficientPrivilegeError("permission denied for table note_views")
    )

    assert result["error"].startswith("NOT_PERMITTED: note_views.")
    assert result["error_kind"] == NOT_PERMITTED_KIND
    assert "SQL_ERROR" not in result["error"]
    assert "execute again" not in result["error"]
    assert "Do not retry this query" in result["error"]
