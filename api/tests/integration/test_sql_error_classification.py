"""Which asyncpg exception Postgres actually raises, asserted against Postgres.

WHY THIS FILE EXISTS RATHER THAN MORE UNIT TESTS. classify_not_permitted decides
whether the model gets another turn, and it decides by exception CLASS. The unit
tests construct those classes by hand, so they pin what we do with each one and
can say nothing about which one arrives -- and getting that wrong is exactly the
bug this file was written after.

`UndefinedFunctionError` was treated as a privilege boundary on the reasoning that
a function the sandbox cannot reach would raise it. It does not. A function the
role may not EXECUTE raises InsufficientPrivilegeError; 42883 is reserved for the
model's own expression being wrong -- bad argument types, bad arity, an operator
that does not exist for the operands, a function nobody defined. The cost was a
whole eval question: Arctic-Text2SQL wrote `DATE($2, '-6 months')`, a SQLite
idiom, and was told "This object is unavailable. Do not retry this query."

So these assertions are deliberately about the DATABASE, not about us. If a
Postgres upgrade re-classifies one of these, the retry rule silently changes
meaning, and this is the only place that would notice.
"""
from __future__ import annotations

import os

import asyncpg
import pytest

pytestmark = pytest.mark.integration

_RO_DSN = os.getenv("AI_READONLY_DATABASE_URL")
_needs_ro = pytest.mark.skipif(not _RO_DSN, reason="AI_READONLY_DATABASE_URL not configured")

# Never has to exist. These probes are about how a statement FAILS, and a company
# with no rows fails the same way as one with rows.
_PROBE_COMPANY = "00000000-0000-0000-0000-000000000000"


async def _connect_as_the_ai_role():
    """Connect, and refuse to run unless the DSN is really the sandbox role.

    The same guard test_ai_read_access.py carries, for the same reason: `.env.local`
    has pointed this variable at the `postgres` role, which owns the tables and so
    bypasses RLS. Half of what is asserted below would still pass, which is worse
    than not asserting it.
    """
    conn = await asyncpg.connect(_RO_DSN, timeout=20)
    who = await conn.fetchval("SELECT current_user")
    if who != "jigged_ai_readonly":
        await conn.close()
        pytest.skip(f"AI_READONLY_DATABASE_URL connects as {who!r}, not jigged_ai_readonly")
    return conn


async def _raises(conn, sql: str, *args):
    async with conn.transaction(readonly=True):
        await conn.execute(f"SET LOCAL jigged.company_id = '{_PROBE_COMPANY}'")
        try:
            await conn.fetch(sql, *args)
        except Exception as exc:  # noqa: BLE001 - the exception IS the assertion
            return exc
    return None


@_needs_ro
async def test_a_type_mistake_in_an_operator_is_an_undefined_function_error():
    """`$2 - INTERVAL '6 months'` with an untyped parameter. semantics.md warns
    about it in bold, and a local SQL model writes it anyway."""
    conn = await _connect_as_the_ai_role()
    try:
        exc = await _raises(
            conn,
            "SELECT COUNT(*) FROM jobs WHERE company_id = $1 "
            "AND created_at >= $2 - INTERVAL '6 months'",
            _PROBE_COMPANY, __import__("datetime").date(2026, 8, 27),
        )
    finally:
        await conn.close()

    assert isinstance(exc, asyncpg.exceptions.UndefinedFunctionError)
    assert "operator does not exist" in str(exc)


@_needs_ro
async def test_a_sqlite_idiom_is_an_undefined_function_error():
    """Arctic-Text2SQL is trained on Spider and BIRD, which are SQLite. `DATE(x, '-6
    months')` is the shape that costs a question."""
    conn = await _connect_as_the_ai_role()
    try:
        exc = await _raises(
            conn,
            "SELECT COUNT(*) FROM jobs WHERE company_id = $1 "
            "AND created_at >= DATE($2, '-6 months')",
            _PROBE_COMPANY, __import__("datetime").date(2026, 8, 27),
        )
    finally:
        await conn.close()

    assert isinstance(exc, asyncpg.exceptions.UndefinedFunctionError)


@_needs_ro
async def test_a_function_the_sandbox_may_not_execute_is_a_privilege_error():
    """THE LOAD-BEARING ONE. This is the case UndefinedFunctionError was kept
    terminal for, and it never raised UndefinedFunctionError at all. If this ever
    starts to, the retry rule needs revisiting -- and only this test would say so.
    """
    conn = await _connect_as_the_ai_role()
    try:
        target = await conn.fetchrow(
            """
            SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.prosecdef
               AND NOT has_function_privilege(current_user, p.oid, 'EXECUTE')
               AND p.pronargs BETWEEN 1 AND 4
             ORDER BY p.pronargs, p.proname
             LIMIT 1
            """
        )
        if target is None:
            pytest.skip("the sandbox may execute every SECURITY DEFINER function")

        types = [seg.strip().split(" ", 1)[-1] for seg in target["args"].split(",")]
        call = f"SELECT public.{target['proname']}(" + ", ".join(
            f"NULL::{t}" for t in types
        ) + ")"
        exc = await _raises(conn, call)
    finally:
        await conn.close()

    assert isinstance(exc, asyncpg.exceptions.InsufficientPrivilegeError), (
        f"a revoked function raised {type(exc).__name__}, not InsufficientPrivilegeError. "
        "classify_not_permitted routes 42883 to the model for a retry on that "
        "assumption; if it is wrong, a privilege failure now loops."
    )
    assert "permission denied" in str(exc)


@_needs_ro
async def test_an_unreadable_table_is_still_terminal():
    from tools.sql_executor import NOT_PERMITTED_KIND, classify_not_permitted

    conn = await _connect_as_the_ai_role()
    try:
        exc = await _raises(conn, "SELECT 1 FROM public.no_such_table_at_all WHERE $1 = $1", _PROBE_COMPANY)
    finally:
        await conn.close()

    assert isinstance(exc, asyncpg.exceptions.UndefinedTableError)
    assert classify_not_permitted(exc)["error_kind"] == NOT_PERMITTED_KIND


@pytest.fixture
async def executor_pool():
    """Release the executor's module-global pool afterwards.

    tools.sql_executor caches one pool in a module global, and
    tests/integration/test_sql_executor.py opens and closes it around every test.
    A test here that calls execute_sql_query and walks away leaves that global set
    to a pool bound to an event loop pytest-asyncio has since closed -- so the NEXT
    file to ask for it gets "pool is closed" and fails for reasons that have
    nothing to do with it. Cheap to give back; confusing to leave behind.
    """
    from tools.sql_executor import close_pool

    yield
    await close_pool()


@_needs_ro
async def test_the_sqlite_idiom_now_reaches_the_model_as_a_retryable_error(executor_pool):
    """End to end through the executor, which is where the classification is felt.
    Before the fix this returned NOT_PERMITTED and the loop ended on it."""
    import datetime

    from tools.sql_executor import SQL_ERROR_KIND, execute_sql_query

    result = await execute_sql_query(
        company_id=_PROBE_COMPANY,
        sql="SELECT COUNT(*) AS n FROM jobs WHERE company_id = $1 "
            "AND created_at >= DATE($2, '-6 months')",
        today=datetime.date(2026, 8, 27),
    )

    assert result["error_kind"] == SQL_ERROR_KIND, result
    assert "Rewrite the query" in result["error"]
    assert "Do not retry" not in result["error"]
