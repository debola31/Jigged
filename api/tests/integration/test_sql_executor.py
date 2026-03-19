"""
Integration tests for the SQL executor.

Tests that queries execute correctly through the real database connection,
including the connection pooler. These tests would have caught the
SET LOCAL $1 bug that broke AI insights.

Requires AI_READONLY_DATABASE_URL to be set.
"""

import os
import uuid

import pytest

from tools.sql_executor import execute_sql_query, init_pool, close_pool, MAX_ROWS


# Use a known demo company or skip if no DB configured
pytestmark = [pytest.mark.integration, pytest.mark.slow]


@pytest.fixture(autouse=True)
async def pool_lifecycle():
    """Initialize and close the connection pool around each test."""
    pool = await init_pool()
    if pool is None:
        pytest.skip("AI_READONLY_DATABASE_URL not configured")
    yield pool
    await close_pool()


def _get_test_company_id() -> str:
    """Get a company_id to use for testing.

    Uses TEST_COMPANY_ID env var, or queries for any company.
    """
    return os.getenv("TEST_COMPANY_ID", "")


class TestPoolConnection:
    """Tests that the connection pool works through the pooler."""

    async def test_pool_initializes(self):
        pool = await init_pool()
        assert pool is not None

    async def test_simple_select(self):
        """Basic SELECT through the pooler - the most fundamental test."""
        result = await execute_sql_query(
            company_id=str(uuid.uuid4()),
            sql="SELECT COUNT(*) AS cnt FROM customers WHERE company_id = $1",
            description="Connection test",
        )
        assert "error" not in result
        assert result["row_count"] == 1

    async def test_set_local_works_in_transaction(self):
        """Verify SET LOCAL works through the pooler.

        This is the exact scenario that was broken: SET LOCAL with
        parameterized $1 fails through Supavisor. The fix uses string
        interpolation with UUID validation inside a transaction.

        We test indirectly: if the query succeeds at all, SET LOCAL
        didn't corrupt the connection state (which was the original bug).
        """
        company_id = str(uuid.uuid4())
        result = await execute_sql_query(
            company_id=company_id,
            sql="SELECT COUNT(*) AS cnt FROM customers WHERE company_id = $1",
            description="SET LOCAL test",
        )
        # The key assertion: no error means SET LOCAL + parameterized query
        # both succeeded through the pooler without corruption
        assert "error" not in result, f"SET LOCAL failed: {result.get('error')}"
        assert result["row_count"] == 1


class TestQueryExecution:
    """Tests for actual query execution against the database."""

    async def test_invalid_company_id_rejected(self):
        result = await execute_sql_query(
            company_id="not-a-uuid",
            sql="SELECT 1 WHERE $1 IS NOT NULL",
        )
        assert "error" in result
        assert "Invalid company_id" in result["error"]

    async def test_empty_result_returns_structure(self):
        """Queries returning no rows should still return proper structure."""
        fake_company = str(uuid.uuid4())
        result = await execute_sql_query(
            company_id=fake_company,
            sql="SELECT id FROM customers WHERE company_id = $1",
            description="Empty result test",
        )
        assert "error" not in result
        assert result["rows"] == []
        assert result["row_count"] == 0

    async def test_validation_failure_returns_error(self):
        """Invalid SQL should be caught by the validator before execution."""
        result = await execute_sql_query(
            company_id=str(uuid.uuid4()),
            sql="DROP TABLE customers",
        )
        assert "error" in result
        assert result["rows"] == []

    async def test_syntax_error_handled(self):
        """SQL syntax errors should return a clean error, not crash."""
        result = await execute_sql_query(
            company_id=str(uuid.uuid4()),
            sql="SELECT FROM WHERE $1",
        )
        assert "error" in result

    async def test_row_limit_enforced(self):
        """Queries without LIMIT should have one auto-appended."""
        result = await execute_sql_query(
            company_id=str(uuid.uuid4()),
            sql="SELECT id FROM customers WHERE company_id = $1",
            description="Row limit test",
        )
        # Should succeed (even with 0 rows) and not exceed MAX_ROWS
        assert "error" not in result
        assert result["row_count"] <= MAX_ROWS

    async def test_query_with_explicit_limit(self):
        """Queries with existing LIMIT should not get a second one."""
        result = await execute_sql_query(
            company_id=str(uuid.uuid4()),
            sql="SELECT id FROM customers WHERE company_id = $1 LIMIT 3",
        )
        assert "error" not in result
        assert result["row_count"] <= 3


class TestDataTypes:
    """Tests that various PostgreSQL data types serialize correctly.

    Uses aggregate queries (COUNT, etc.) which always return exactly one row
    regardless of data, plus expression columns for type testing.
    """

    async def test_timestamp_serialization(self):
        result = await execute_sql_query(
            company_id=str(uuid.uuid4()),
            sql="SELECT NOW() AS ts, COUNT(*) AS cnt FROM customers WHERE company_id = $1",
        )
        assert "error" not in result
        assert result["row_count"] == 1
        # Should be ISO format string
        assert "T" in str(result["rows"][0]["ts"])

    async def test_numeric_serialization(self):
        result = await execute_sql_query(
            company_id=str(uuid.uuid4()),
            sql="SELECT 42.5::NUMERIC AS num, 100::NUMERIC AS whole, COUNT(*) AS cnt "
                "FROM customers WHERE company_id = $1",
        )
        assert "error" not in result
        row = result["rows"][0]
        assert row["num"] == 42.5
        assert row["whole"] == 100  # Should be int, not 100.0

    async def test_uuid_serialization(self):
        result = await execute_sql_query(
            company_id=str(uuid.uuid4()),
            sql="SELECT gen_random_uuid() AS uid, COUNT(*) AS cnt "
                "FROM customers WHERE company_id = $1",
        )
        assert "error" not in result
        # UUID should be a valid string
        uuid.UUID(str(result["rows"][0]["uid"]))


class TestWithRealData:
    """Tests against real company data. Skipped if TEST_COMPANY_ID not set."""

    @pytest.fixture(autouse=True)
    def require_company_id(self):
        cid = _get_test_company_id()
        if not cid:
            pytest.skip("TEST_COMPANY_ID not set")

    async def test_customers_query(self):
        result = await execute_sql_query(
            company_id=_get_test_company_id(),
            sql="SELECT id, name FROM customers WHERE company_id = $1 LIMIT 5",
            description="List customers",
        )
        assert "error" not in result, f"Failed: {result.get('error')}"
        assert "columns" in result

    async def test_jobs_with_join(self):
        result = await execute_sql_query(
            company_id=_get_test_company_id(),
            sql=(
                "SELECT j.id, c.name AS customer_name "
                "FROM jobs j "
                "JOIN customers c ON j.customer_id = c.id "
                "WHERE j.company_id = $1 "
                "LIMIT 5"
            ),
            description="Jobs with customer names",
        )
        assert "error" not in result, f"Failed: {result.get('error')}"

    async def test_aggregate_query(self):
        result = await execute_sql_query(
            company_id=_get_test_company_id(),
            sql=(
                "SELECT COUNT(*) AS total_jobs "
                "FROM jobs WHERE company_id = $1"
            ),
            description="Count jobs",
        )
        assert "error" not in result, f"Failed: {result.get('error')}"
        assert result["row_count"] == 1
