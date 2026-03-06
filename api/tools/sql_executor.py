"""
SQL executor for AI-generated queries.

Uses asyncpg for direct PostgreSQL connection with a read-only role.
Validates queries before execution and enforces row limits.
"""

import json
import logging
import os
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Optional

import asyncpg

from .sql_validator import validate_query

logger = logging.getLogger(__name__)

# Connection pool (lazily initialized)
_pool: Optional[asyncpg.Pool] = None

# Maximum rows to return
MAX_ROWS = 200

# Statement timeout in milliseconds
STATEMENT_TIMEOUT_MS = 5000


def _json_serializable(value: Any) -> Any:
    """Convert PostgreSQL types to JSON-serializable values."""
    if isinstance(value, Decimal):
        # Return int if no decimal places, otherwise float
        if value == int(value):
            return int(value)
        return float(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        return value
    return value


async def init_pool() -> Optional[asyncpg.Pool]:
    """Initialize the asyncpg connection pool."""
    global _pool
    if _pool is not None:
        return _pool

    dsn = os.getenv("AI_READONLY_DATABASE_URL")
    if not dsn:
        logger.warning(
            "AI_READONLY_DATABASE_URL not set. SQL tool will not be available."
        )
        return None

    try:
        _pool = await asyncpg.create_pool(
            dsn=dsn,
            min_size=1,
            max_size=3,
            command_timeout=STATEMENT_TIMEOUT_MS / 1000,
        )
        logger.info("AI SQL executor pool initialized.")
        return _pool
    except Exception as e:
        logger.error(f"Failed to initialize AI SQL pool: {e}")
        return None


async def close_pool() -> None:
    """Close the connection pool."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def execute_sql_query(
    company_id: str,
    sql: str,
    description: str = "",
) -> dict:
    """
    Validate and execute an AI-generated SQL query.

    The query must use $1 as a placeholder for company_id.
    Results are limited to MAX_ROWS rows.

    Args:
        company_id: The company UUID to bind as $1.
        sql: The SQL query with $1 placeholder.
        description: Brief description of what the query computes.

    Returns:
        Dict with keys: columns, rows, row_count, description.
        On error: Dict with keys: error, rows (empty list).
    """
    # 1. Validate
    is_valid, error_msg = validate_query(sql)
    if not is_valid:
        return {
            "error": error_msg,
            "suggestion": (
                "Please rewrite the query. Common issues: "
                "missing $1 for company_id, using a restricted table, "
                "or using non-SELECT statements."
            ),
            "rows": [],
        }

    # 2. Ensure pool is ready
    pool = await init_pool()
    if pool is None:
        return {
            "error": "Database connection not available. AI_READONLY_DATABASE_URL may not be configured.",
            "rows": [],
        }

    # 3. Enforce row limit
    cleaned_sql = sql.strip().rstrip(";")

    # Check if query already has a LIMIT clause
    import re
    has_limit = bool(re.search(r"\bLIMIT\b\s+\d+", cleaned_sql, re.IGNORECASE))
    if not has_limit:
        cleaned_sql = f"{cleaned_sql}\nLIMIT {MAX_ROWS}"

    # 4. Execute
    try:
        async with pool.acquire() as conn:
            # Set statement timeout for this connection
            await conn.execute(
                f"SET statement_timeout = '{STATEMENT_TIMEOUT_MS}'"
            )

            rows = await conn.fetch(cleaned_sql, company_id)

            if not rows:
                return {
                    "columns": [],
                    "rows": [],
                    "row_count": 0,
                    "description": description,
                }

            # Convert to list of dicts with JSON-safe values
            columns = list(rows[0].keys())
            result_rows = []
            for row in rows[:MAX_ROWS]:
                result_rows.append(
                    {col: _json_serializable(row[col]) for col in columns}
                )

            return {
                "columns": columns,
                "rows": result_rows,
                "row_count": len(result_rows),
                "description": description,
            }

    except asyncpg.exceptions.QueryCanceledError:
        return {
            "error": (
                "Query timed out (5 second limit). "
                "Try a simpler query, add filters, or reduce the date range."
            ),
            "rows": [],
        }
    except asyncpg.exceptions.PostgresSyntaxError as e:
        return {
            "error": f"SQL syntax error: {e.message}",
            "rows": [],
        }
    except asyncpg.exceptions.UndefinedTableError as e:
        return {
            "error": f"Table not found: {e.message}",
            "rows": [],
        }
    except asyncpg.exceptions.UndefinedColumnError as e:
        return {
            "error": f"Column not found: {e.message}",
            "rows": [],
        }
    except Exception as e:
        logger.error(f"SQL execution error: {e}", exc_info=True)
        return {
            "error": f"Query execution failed: {str(e)}",
            "rows": [],
        }
