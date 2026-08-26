"""A refused object must end the turn, not start a retry loop.

THE BUG THIS PINS. In the Gate 1 insights eval every arm hit permission errors,
and the executor handed the model back "Query execution failed: permission denied
for table X" -- which reads like a transient failure worth another go. Claude
spent 4 of its 5 tool turns retrying job_operations; all 4 loop exhaustions in
that run trace to permission-error retries hitting MAX_TOOL_ITERATIONS. The model
was behaving reasonably; the tool result was lying about whether retrying could
ever work.

A refused object is TERMINAL. No amount of rephrasing grants a privilege, so the
result says so in words the model can act on, and names the object so the answer
can say which figure is unavailable.
"""
from __future__ import annotations

import asyncpg
import pytest

from tools.sql_executor import NOT_PERMITTED_KIND, classify_not_permitted


TERMINAL = [
    pytest.param(
        asyncpg.exceptions.InsufficientPrivilegeError(
            "permission denied for table job_operation_intervals"),
        "job_operation_intervals",
        id="permission-denied-table",
    ),
    pytest.param(
        asyncpg.exceptions.InsufficientPrivilegeError(
            "permission denied for view v_operator_hours"),
        "v_operator_hours",
        id="permission-denied-view",
    ),
    pytest.param(
        asyncpg.exceptions.UndefinedTableError(
            'relation "user_company_access" does not exist'),
        "user_company_access",
        id="undefined-table",
    ),
    pytest.param(
        asyncpg.exceptions.UndefinedFunctionError(
            "function public.job_last_ship_date(uuid) does not exist"),
        "public.job_last_ship_date(uuid)",
        id="undefined-function",
    ),
    pytest.param(
        asyncpg.exceptions.UndefinedColumnError(
            'column "freight_account_snapshot" does not exist'),
        "freight_account_snapshot",
        id="undefined-column",
    ),
]


@pytest.mark.parametrize("exc,expected_object", TERMINAL)
def test_a_refused_object_is_named_and_declared_terminal(exc, expected_object):
    result = classify_not_permitted(exc)

    assert result is not None, f"{type(exc).__name__} must be classified as terminal"
    assert result["error"].startswith(f"NOT_PERMITTED: {expected_object}."), result["error"]
    assert "Do not retry this query" in result["error"]
    assert "state the data is unavailable" in result["error"]
    assert result["error_kind"] == NOT_PERMITTED_KIND
    assert result["rows"] == []


@pytest.mark.parametrize("exc,expected_object", TERMINAL)
def test_the_object_comes_from_the_exception_not_the_sql(exc, expected_object):
    """Parsing the SQL would name whatever the model typed, including a table it
    was allowed to read that happened to sit in the same query. Postgres names the
    one it actually refused."""
    result = classify_not_permitted(exc)
    assert expected_object in result["error"]


@pytest.mark.parametrize(
    "exc",
    [
        pytest.param(asyncpg.exceptions.PostgresSyntaxError("syntax error at or near \"slect\""),
                     id="syntax-error"),
        pytest.param(asyncpg.exceptions.QueryCanceledError("canceling statement due to timeout"),
                     id="timeout"),
        pytest.param(asyncpg.exceptions.InvalidTextRepresentationError(
            'invalid input syntax for type uuid: ""'), id="bad-uuid-cast"),
        pytest.param(RuntimeError("something else entirely"), id="not-a-postgres-error"),
    ],
)
def test_retryable_and_unrelated_errors_are_left_alone(exc):
    """Self-correction is one of the layers this feature relies on -- a syntax
    error SHOULD come back as a retryable error, because rewriting the query
    genuinely fixes it. Only privilege and existence failures are terminal."""
    assert classify_not_permitted(exc) is None


def test_an_unparseable_message_still_terminates():
    """Better a vague terminal answer than a retry loop. If Postgres phrases it in
    a way the patterns miss, the turn still ends."""
    result = classify_not_permitted(
        asyncpg.exceptions.InsufficientPrivilegeError("permission denied, somehow"))

    assert result is not None
    assert result["error"].startswith("NOT_PERMITTED:")
    assert "Do not retry this query" in result["error"]
