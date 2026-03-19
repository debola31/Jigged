"""
Integration tests for the AI insights chat pipeline.

Tests the full flow from user message -> tool use -> SQL execution -> response,
with the LLM mocked to control tool calls deterministically.

Requires AI_READONLY_DATABASE_URL to be set.
"""

import json
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

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


def _mock_tool_use_response(tool_name: str, tool_input: dict):
    """Build a mock Claude API response that requests a tool call."""
    tool_block = MagicMock()
    tool_block.type = "tool_use"
    tool_block.id = f"tool_{uuid.uuid4().hex[:8]}"
    tool_block.name = tool_name
    tool_block.input = tool_input

    response = MagicMock()
    response.stop_reason = "tool_use"
    response.content = [tool_block]
    response.usage = MagicMock(input_tokens=100, output_tokens=50)
    return response


def _mock_text_response(text: str):
    """Build a mock Claude API response with just text."""
    text_block = MagicMock()
    text_block.type = "text"
    text_block.text = text

    response = MagicMock()
    response.stop_reason = "end_turn"
    response.content = [text_block]
    response.usage = MagicMock(input_tokens=100, output_tokens=50)
    return response


class TestChatPipeline:
    """Tests for the full chat -> tool -> SQL -> response pipeline."""

    async def test_full_chat_with_sql_tool(self):
        """Simulate Claude requesting a SQL query via the full chat pipeline."""
        from services.ai.claude_provider import ClaudeProvider

        company_id = str(uuid.uuid4())

        # Mock the Anthropic API: first call -> tool_use, second call -> text
        mock_responses = [
            _mock_tool_use_response(
                "execute_sql",
                {
                    "sql": "SELECT COUNT(*) AS total FROM customers WHERE company_id = $1",
                    "description": "Count customers",
                },
            ),
            _mock_text_response("You have 0 customers in your system."),
        ]

        provider = ClaudeProvider()

        with patch.object(
            provider.client.messages, "create", side_effect=mock_responses
        ):
            result = await provider.chat_with_tools(
                messages=[{
                    "role": "user",
                    "content": f"[company_id:{company_id}] How many customers do I have?",
                }],
                tools=[{
                    "name": "execute_sql",
                    "description": "Execute SQL",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "sql": {"type": "string"},
                            "description": {"type": "string"},
                        },
                        "required": ["sql"],
                    },
                }],
                system_prompt="You are a data analyst.",
            )

        assert result is not None
        assert "content" in result
        assert "customers" in result["content"].lower()
        assert "execute_sql" in result["tool_calls"]

    async def test_chat_recovers_from_sql_error(self):
        """When SQL fails, Claude gets the error and responds gracefully."""
        from services.ai.claude_provider import ClaudeProvider

        company_id = str(uuid.uuid4())

        mock_responses = [
            # Claude tries a query against a restricted table
            _mock_tool_use_response(
                "execute_sql",
                {
                    "sql": "SELECT * FROM system_admins WHERE company_id = $1",
                    "description": "Bad table",
                },
            ),
            # Claude recovers with a text response
            _mock_text_response("I encountered an error querying that data."),
        ]

        provider = ClaudeProvider()

        with patch.object(
            provider.client.messages, "create", side_effect=mock_responses
        ):
            result = await provider.chat_with_tools(
                messages=[{
                    "role": "user",
                    "content": f"[company_id:{company_id}] Show admin data",
                }],
                tools=[{
                    "name": "execute_sql",
                    "description": "Execute SQL",
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "sql": {"type": "string"},
                            "description": {"type": "string"},
                        },
                        "required": ["sql"],
                    },
                }],
                system_prompt="You are a data analyst.",
            )

        assert result is not None
        assert "content" in result
        # The tool was called (even though it failed)
        assert "execute_sql" in result["tool_calls"]
