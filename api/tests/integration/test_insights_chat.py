"""
Integration tests for execute_sql_tool, the handler behind the only chat tool.

A second class used to sit below this one, driving ClaudeProvider.chat_with_tools
with a mocked Anthropic client. That loop was the pre-gateway implementation and
had no production caller — services/ai_features/insights.py owns the real loop,
and test_insights_loop_integrity.py covers it. Both are gone.

Requires AI_READONLY_DATABASE_URL to be set.
"""

import uuid

import pytest

from tools.sql_executor import init_pool, close_pool

pytestmark = [pytest.mark.integration, pytest.mark.slow]


@pytest.fixture(autouse=True)
async def pool_lifecycle():
    """Ensure DB pool is available."""
    pool = await init_pool()
    if pool is None:
        pytest.skip("AI_READONLY_DATABASE_URL not configured")
    yield
    await close_pool()


class TestSqlTool:
    """Tests for the execute_sql_tool function directly."""

    async def test_valid_query_executes(self):
        from services.insights_service import execute_sql_tool

        result = await execute_sql_tool(
            company_id=str(uuid.uuid4()),
            sql="SELECT COUNT(*) AS cnt FROM customers WHERE company_id = $1",
            description="Count customers",
        )
        assert "error" not in result
        assert result["row_count"] == 1

    async def test_mutation_query_rejected(self):
        from services.insights_service import execute_sql_tool

        result = await execute_sql_tool(
            company_id=str(uuid.uuid4()),
            sql="DELETE FROM customers WHERE company_id = $1",
            description="Bad query",
        )
        assert "error" in result

    async def test_missing_placeholder_rejected(self):
        from services.insights_service import execute_sql_tool

        result = await execute_sql_tool(
            company_id=str(uuid.uuid4()),
            sql="SELECT COUNT(*) FROM customers",
            description="No placeholder",
        )
        assert "error" in result
