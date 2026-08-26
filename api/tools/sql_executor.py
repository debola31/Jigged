"""
SQL executor for AI-generated queries.

Uses asyncpg for direct PostgreSQL connection with a read-only role.
Validates queries before execution and enforces row limits.
"""

import json
import logging
import os
import re
import uuid
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


NOT_PERMITTED_KIND = "not_permitted"

# Errors no rewrite of the query can fix. Privilege and existence are properties
# of the database, not of the phrasing.
_NOT_PERMITTED_ERRORS = (
    asyncpg.exceptions.InsufficientPrivilegeError,
    asyncpg.exceptions.UndefinedTableError,
    asyncpg.exceptions.UndefinedFunctionError,
)

# UndefinedColumnError is deliberately NOT here. It was, for one run, and the eval
# caught it: the model wrote `shipments.total_price`, a column that simply does not
# exist, and got told not to retry -- when picking the right column name is exactly
# the correction the next turn would have made. A missing column is a model
# mistake; a missing privilege is a property of the database. Only the second is
# terminal.
#
# A WITHHELD column is not affected: reading one raises InsufficientPrivilegeError
# ("permission denied for column ..."), which is caught above.

# The refused object, taken from POSTGRES'S message rather than from the SQL: a
# query names several objects and only one of them was the problem, so parsing
# the statement would routinely accuse a table the model was allowed to read.
_REFUSED_OBJECT_PATTERNS = (
    re.compile(r'permission denied for \w+ ([\w."]+)', re.IGNORECASE),
    re.compile(r'relation "([^"]+)" does not exist', re.IGNORECASE),
    re.compile(r"function ([\w.]+\([^)]*\)) does not exist", re.IGNORECASE),
    re.compile(r'column "([^"]+)" does not exist', re.IGNORECASE),
)


def classify_not_permitted(exc: Exception) -> Optional[dict]:
    """A TERMINAL tool result for a refused object, or None if the error is retryable.

    Self-correction is one of the layers this feature rests on, and it is worth
    keeping: a syntax error handed back to the model genuinely does get fixed on
    the next turn. A privilege error does not. Before this existed the two were
    phrased alike -- "Query execution failed: permission denied for table X" --
    and in the Gate 1 eval every arm spent turns retrying objects it was never
    going to be granted, until the 5-iteration cap ended the answer instead of
    the model doing so. One turn spent, not five.

    Naming the object is the other half: an answer that says WHICH figure is
    unavailable is useful, where "something went wrong" is not.
    """
    if not isinstance(exc, _NOT_PERMITTED_ERRORS):
        return None

    message = getattr(exc, "message", None) or str(exc)
    match = next(
        (m for m in (p.search(message) for p in _REFUSED_OBJECT_PATTERNS) if m), None
    )
    # An unrecognised phrasing still terminates. A vague terminal answer beats a
    # retry loop, and Postgres wording is not something we control.
    refused = match.group(1).strip('"') if match else message

    return {
        "error": (
            f"NOT_PERMITTED: {refused}. This object is unavailable. Do not retry "
            f"this query; answer from the permitted objects or state the data is "
            f"unavailable."
        ),
        "error_kind": NOT_PERMITTED_KIND,
        "rows": [],
    }


def describe_dsn(dsn: str) -> str:
    """host:port/dbname for a DSN, credentials dropped.

    Lives here because this module owns the DSN, and every caller that wants to SAY
    which database it is about needs the same guarantee that the password does not
    come along. Startup banners and eval output both get pasted into issues.
    """
    from urllib.parse import urlsplit

    parts = urlsplit(dsn)
    user = f"{parts.username}@" if parts.username else ""
    return f"{user}{parts.hostname or '?'}:{parts.port or 5432}{parts.path}"


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
            min_size=0,
            max_size=1,
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
    # 0. Validate company_id is a proper UUID (required for safe SET LOCAL interpolation)
    try:
        uuid.UUID(company_id)
    except (ValueError, AttributeError):
        return {"error": "Invalid company_id format.", "rows": []}

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

            # Wrap in transaction so SET LOCAL takes effect.
            # SET LOCAL outside a transaction is a no-op and can corrupt
            # connection state through Supabase's connection pooler.
            async with conn.transaction(readonly=True):
                # Set company context for RLS policies (defense-in-depth)
                await conn.execute(
                    f"SET LOCAL jigged.company_id = '{company_id}'"
                )

                rows = await conn.fetch(cleaned_sql, company_id)

            # Process results outside the transaction
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
    except _NOT_PERMITTED_ERRORS as e:
        # Ahead of the generic handler on purpose: these used to fall through to
        # "Query execution failed: <postgres text>", which reads as transient.
        result = classify_not_permitted(e)
        logger.warning(
            "SQL refused as %s: %s", NOT_PERMITTED_KIND, result["error"]
        )
        return result
    except Exception as e:
        logger.error(f"SQL execution error: {e}", exc_info=True)
        return {
            "error": f"Query execution failed: {str(e)}",
            "rows": [],
        }
