"""POST /api/insights/{company_id}/query and GET .../schema: a customer's own assistant writing SQL.

The statement runs in the insights sandbox exactly as Jigged's own model's do, and NO model of ours
runs. What has to be true, with the database out of the picture (the real-database half is
tests/integration/test_insights_query.py):

  * the caller check is verify_office_access, so operators and unbound assistant tokens are refused
    and a bound assistant is not (unlike /chat and /report, which refuse every assistant);
  * the validator refuses before the executor is reached, and its sentence is the answer;
  * nothing touches ai_jobs, the AI flag or the hourly cap;
  * who did a piece of work cannot be queried (the surveillance guardrail);
  * today's date is the caller's, never the server's UTC day;
  * the executor's instructions to Jigged's own model never reach the caller;
  * the row cap is reported.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import asyncpg
import jwt
import pytest
from fastapi import HTTPException

import routes.company_auth as company_auth
from models.insights_models import DATA_QUERY_MAX_SQL_CHARS, DataQueryRequest
from routes import insights_routes as routes
from services.insights_service import load_semantics
from tools import sql_executor
from tools.schema_context import SCHEMA_CONTEXT

pytestmark = pytest.mark.unit

COMPANY = "11111111-1111-1111-1111-111111111111"
REQ = SimpleNamespace(headers={"Authorization": "Bearer t"})
GATEWAY_KEY = "unit-test-gateway-key"
_REAL_OFFICE_ACCESS = company_auth.verify_office_access

COUNT_CUSTOMERS = "SELECT COUNT(*) AS customers FROM customers WHERE company_id = $1"


def _rows(n: int) -> dict:
    return {
        "columns": ["n"],
        "rows": [{"n": i} for i in range(n)],
        "row_count": n,
        "description": "",
    }


@pytest.fixture(autouse=True)
def office_caller(monkeypatch):
    """An office member of COMPANY, unless a test swaps in the real check."""
    guard = AsyncMock(return_value=("user-1", {"id": "access-1", "role": "user"}))
    monkeypatch.setattr(company_auth, "verify_office_access", guard)
    return guard


@pytest.fixture(autouse=True)
def executor(monkeypatch):
    run = AsyncMock(return_value=_rows(1))
    monkeypatch.setattr(sql_executor, "execute_sql_query", run)
    return run


@pytest.fixture(autouse=True)
def no_ai(monkeypatch):
    """Every test also proves no AI path is reached: no job, no flag read, no cap."""
    tripwire = MagicMock(side_effect=AssertionError("the data query must not reach the AI path"))
    monkeypatch.setattr(routes.ai_jobs, "enqueue", tripwire)
    monkeypatch.setattr(routes.ai_jobs, "sweep", tripwire)
    monkeypatch.setattr(routes, "_get_company_ai_settings", tripwire)
    monkeypatch.setattr(routes, "_check_chat_rate_limit", tripwire)
    monkeypatch.setattr(routes, "handler_for", tripwire)
    return tripwire


async def _query(sql: str = COUNT_CUSTOMERS, today: date | None = None, req=REQ):
    return await routes.query(COMPANY, DataQueryRequest(sql=sql, today=today), req)


async def _refused(sql: str, today: date | None = None, req=REQ) -> HTTPException:
    with pytest.raises(HTTPException) as exc:
        await _query(sql, today, req)
    return exc.value


class TestHappyPath:
    async def test_runs_the_statement_as_written_for_the_url_company(self, executor, office_caller):
        result = await _query()
        office_caller.assert_awaited_once_with(REQ, COMPANY)
        executor.assert_awaited_once_with(company_id=COMPANY, sql=COUNT_CUSTOMERS, today=None)
        assert result.columns == ["n"]
        assert result.rows == [{"n": 0}]
        assert result.row_count == 1
        assert result.row_cap == sql_executor.MAX_ROWS
        assert result.capped is False


class TestOnlyASelect:
    @pytest.mark.parametrize(
        "sql",
        [
            "DELETE FROM customers WHERE company_id = $1",
            "UPDATE customers SET name = 'x' WHERE company_id = $1",
            "INSERT INTO customers (company_id, name) VALUES ($1, 'x')",
            "SELECT 1 WHERE $1 IS NOT NULL; DROP TABLE customers",
            "WITH x AS (DELETE FROM customers WHERE company_id = $1 RETURNING id) SELECT * FROM x",
            "SELECT * INTO copy FROM customers WHERE company_id = $1",
        ],
    )
    async def test_anything_but_a_select_is_refused_before_the_database(self, sql, executor):
        refused = await _refused(sql)
        assert refused.status_code == 400
        assert isinstance(refused.detail, str) and refused.detail
        executor.assert_not_awaited()

    async def test_the_refusal_is_the_validators_own_sentence(self, executor):
        refused = await _refused("SELECT COUNT(*) FROM customers")
        assert refused.detail == "Query must include $1 placeholder for company_id filtering."

    async def test_a_denylisted_table_is_refused_by_name(self, executor):
        refused = await _refused("SELECT * FROM customer_carrier_accounts WHERE company_id = $1")
        assert "customer_carrier_accounts" in refused.detail
        executor.assert_not_awaited()

    async def test_the_clock_is_refused(self, executor):
        refused = await _refused("SELECT COUNT(*) FROM jobs WHERE company_id = $1 AND due_date < CURRENT_DATE")
        assert "CURRENT_DATE" in refused.detail
        executor.assert_not_awaited()


class TestWhoMayQuery:
    async def test_an_operator_is_refused(self, monkeypatch, executor):
        monkeypatch.setattr(company_auth, "verify_office_access", _REAL_OFFICE_ACCESS)
        monkeypatch.setattr(
            company_auth,
            "verify_company_access",
            AsyncMock(return_value=("op-1", {"id": "access-op", "role": "operator"})),
        )
        refused = await _refused(COUNT_CUSTOMERS)
        assert refused.status_code == 403
        assert refused.detail == company_auth.OFFICE_ONLY_DETAIL
        executor.assert_not_awaited()

    async def test_no_token_is_401(self, monkeypatch, executor):
        monkeypatch.setattr(company_auth, "verify_office_access", _REAL_OFFICE_ACCESS)
        refused = await _refused(COUNT_CUSTOMERS, req=SimpleNamespace(headers={}))
        assert refused.status_code == 401
        executor.assert_not_awaited()

    async def test_a_stranger_to_the_company_is_refused(self, office_caller, executor):
        office_caller.side_effect = HTTPException(status_code=403, detail="No access to this company")
        refused = await _refused(COUNT_CUSTOMERS)
        assert refused.status_code == 403
        executor.assert_not_awaited()

    def _assistant(self, monkeypatch, gateway: str | None) -> SimpleNamespace:
        """The real verify_office_access over a stubbed membership read, with an OAuth token."""
        monkeypatch.setattr(company_auth, "verify_office_access", _REAL_OFFICE_ACCESS)
        monkeypatch.setenv("MCP_GATEWAY_KEY", GATEWAY_KEY)
        client = MagicMock()
        client.auth.get_user.return_value = SimpleNamespace(user=SimpleNamespace(id="user-1"))
        table = client.table.return_value.select.return_value.eq.return_value.eq.return_value
        table.limit.return_value.execute.return_value.data = [{"id": "access-1", "role": "admin"}]
        monkeypatch.setattr(company_auth, "service_client", lambda: client)
        token = jwt.encode(
            {"sub": "user-1", "role": "authenticated", "client_id": "client-9"},
            "unit-test-secret-at-least-32-bytes-long",
            algorithm="HS256",
        )
        headers = {"Authorization": f"Bearer {token}"}
        if gateway is not None:
            headers[company_auth.MCP_GATEWAY_HEADER] = gateway
        return SimpleNamespace(headers=headers)

    @pytest.mark.parametrize("gateway", [None, "", "wrong-key"])
    async def test_an_assistant_token_without_the_gateway_key_is_refused(self, gateway, monkeypatch, executor):
        refused = await _refused(COUNT_CUSTOMERS, req=self._assistant(monkeypatch, gateway))
        assert refused.status_code == 403
        assert refused.detail == company_auth.UNBOUND_ASSISTANT_DETAIL
        executor.assert_not_awaited()

    async def test_an_assistant_through_mcp_is_who_this_is_for(self, monkeypatch, executor):
        """Unlike /chat and /report: refuse_assistant is not on this door."""
        result = await _query(req=self._assistant(monkeypatch, GATEWAY_KEY))
        assert result.row_count == 1
        executor.assert_awaited_once()


class TestWhoDidTheWork:
    @pytest.mark.parametrize(
        "sql, column",
        [
            (
                "SELECT completed_by, COUNT(*) FROM job_operations jo JOIN jobs j ON j.id = jo.job_id "
                "WHERE j.company_id = $1 GROUP BY completed_by",
                "completed_by",
            ),
            ("SELECT operator_id FROM inventory_transactions WHERE company_id = $1", "operator_id"),
            ("SELECT q.created_by AS who FROM quotes q WHERE q.company_id = $1", "created_by"),
            ("SELECT voided_by FROM shipments WHERE company_id = $1", "voided_by"),
        ],
    )
    async def test_naming_a_person_column_is_refused(self, sql, column, executor):
        refused = await _refused(sql)
        assert refused.status_code == 400
        assert column in refused.detail
        executor.assert_not_awaited()

    async def test_a_select_star_that_returns_one_is_refused(self, executor):
        executor.return_value = {
            "columns": ["id", "status", "completed_by"],
            "rows": [{"id": "op-1", "status": "completed", "completed_by": "u-1"}],
            "row_count": 1,
        }
        refused = await _refused(
            "SELECT jo.* FROM job_operations jo JOIN jobs j ON j.id = jo.job_id WHERE j.company_id = $1"
        )
        assert refused.status_code == 400
        assert "completed_by" in refused.detail
        assert "u-1" not in refused.detail

    async def test_one_inside_a_json_value_is_refused(self, executor):
        executor.return_value = {
            "columns": ["op"],
            "rows": [{"op": {"id": "op-1", "sent_by": "u-1"}}],
            "row_count": 1,
        }
        refused = await _refused("SELECT 1 AS op FROM jobs WHERE company_id = $1")
        assert "sent_by" in refused.detail

    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT DATE_TRUNC('month', created_at) AS m, COUNT(*) AS jobs_by_month FROM jobs "
            "WHERE company_id = $1 GROUP BY 1 ORDER BY 1",
            "SELECT customer_name, COUNT(*) FROM jobs WHERE company_id = $1 GROUP BY customer_name",
        ],
    )
    async def test_ordinary_grouping_is_not_mistaken_for_one(self, sql, executor):
        await _query(sql)
        executor.assert_awaited_once()


class TestToday:
    LATE = (
        "SELECT COUNT(*) AS late FROM jobs WHERE company_id = $1 "
        "AND public.is_job_late(due_date, production_status, fulfillment_status, $2)"
    )

    async def test_the_callers_date_is_bound_when_the_query_uses_it(self, executor):
        today = datetime.now(timezone.utc).date()
        await _query(self.LATE, today)
        assert executor.await_args.kwargs["today"] == today

    async def test_a_query_using_it_without_one_is_refused_not_given_the_servers(self, executor):
        refused = await _refused(self.LATE)
        assert refused.status_code == 400
        assert "today" in refused.detail
        executor.assert_not_awaited()

    async def test_an_implausible_date_is_refused(self, executor):
        refused = await _refused(self.LATE, datetime.now(timezone.utc).date() - timedelta(days=30))
        assert refused.status_code == 400
        executor.assert_not_awaited()

    async def test_a_query_without_it_ignores_one(self, executor):
        await _query(COUNT_CUSTOMERS, date(2019, 1, 1))
        assert executor.await_args.kwargs["today"] is None


class TestFailures:
    async def test_a_database_error_keeps_the_cause_and_drops_the_instruction(self, executor):
        executor.return_value = sql_executor.retryable_sql_error('column "total_price" does not exist')
        refused = await _refused(COUNT_CUSTOMERS)
        assert refused.status_code == 400
        assert refused.detail == 'The query failed: column "total_price" does not exist.'

    async def test_a_timeout_says_so(self, executor):
        executor.return_value = sql_executor.retryable_sql_error(
            "query timed out (5 second limit); simplify it, add filters, or narrow the date range"
        )
        refused = await _refused(COUNT_CUSTOMERS)
        assert "timed out" in refused.detail
        assert "Rewrite" not in refused.detail

    async def test_an_unreadable_table_is_named(self, executor):
        executor.return_value = sql_executor.classify_not_permitted(
            asyncpg.exceptions.InsufficientPrivilegeError("permission denied for table company_billing")
        )
        refused = await _refused("SELECT * FROM company_billing WHERE company_id = $1")
        assert refused.status_code == 400
        assert "company_billing" in refused.detail
        for instruction in ("Do not retry", "NOT_PERMITTED", "answer from the permitted"):
            assert instruction not in refused.detail

    @pytest.mark.parametrize(
        "result",
        [
            sql_executor.retryable_sql_error("syntax error: at or near FROM"),
            sql_executor.classify_not_permitted(
                asyncpg.exceptions.UndefinedTableError('relation "widgets" does not exist')
            ),
        ],
    )
    async def test_no_instruction_to_our_own_model_reaches_the_caller(self, result, executor):
        executor.return_value = result
        detail = (await _refused(COUNT_CUSTOMERS)).detail
        for phrase in ("SQL_ERROR", "NOT_PERMITTED", "Rewrite the query", "Never describe", "Do not retry"):
            assert phrase not in detail

    async def test_no_sandbox_connection_is_ours_a_503(self, executor):
        executor.return_value = {
            "error": "Database connection not available. AI_READONLY_DATABASE_URL may not be configured.",
            "rows": [],
        }
        refused = await _refused(COUNT_CUSTOMERS)
        assert refused.status_code == 503
        assert "AI_READONLY_DATABASE_URL" not in refused.detail


class TestRowCap:
    async def test_a_full_page_is_reported_as_capped(self, executor):
        executor.return_value = _rows(sql_executor.MAX_ROWS)
        result = await _query()
        assert result.row_count == sql_executor.MAX_ROWS
        assert result.capped is True

    async def test_one_short_is_not(self, executor):
        executor.return_value = _rows(sql_executor.MAX_ROWS - 1)
        assert (await _query()).capped is False

    async def test_an_empty_result_is_well_formed(self, executor):
        executor.return_value = {"columns": [], "rows": [], "row_count": 0, "description": ""}
        result = await _query()
        assert (result.columns, result.rows, result.row_count, result.capped) == ([], [], 0, False)


class TestTheMcpToolSaysTheSame:
    """lib/mcp/tools/query.ts states the cap, the timeout and the SQL length in its description
    and input schema. Those are copies of these constants; this keeps them honest."""

    SOURCE = Path(__file__).resolve().parents[3] / "lib" / "mcp" / "tools" / "query.ts"

    @pytest.mark.parametrize(
        "line",
        [
            f"export const ROW_CAP = {sql_executor.MAX_ROWS};",
            f"export const TIMEOUT_SECONDS = {sql_executor.STATEMENT_TIMEOUT_MS // 1000};",
            f"export const MAX_SQL_CHARS = {DATA_QUERY_MAX_SQL_CHARS:_};",
        ],
    )
    def test_constant(self, line):
        assert line in self.SOURCE.read_text(encoding="utf-8")


class TestSchema:
    async def test_serves_the_chats_own_schema_and_definitions_verbatim(self, office_caller):
        schema = await routes.data_schema(COMPANY, REQ)
        office_caller.assert_awaited_once_with(REQ, COMPANY)
        assert schema.schema_context == SCHEMA_CONTEXT.strip()
        assert schema.semantics == load_semantics()
        assert schema.row_cap == sql_executor.MAX_ROWS
        assert schema.timeout_seconds == sql_executor.STATEMENT_TIMEOUT_MS / 1000
        assert any("$1" in rule for rule in schema.query_rules)
        assert any("completed_by" in rule for rule in schema.query_rules)

    async def test_an_operator_gets_nothing(self, monkeypatch):
        monkeypatch.setattr(company_auth, "verify_office_access", _REAL_OFFICE_ACCESS)
        monkeypatch.setattr(
            company_auth,
            "verify_company_access",
            AsyncMock(return_value=("op-1", {"id": "access-op", "role": "operator"})),
        )
        with pytest.raises(HTTPException) as exc:
            await routes.data_schema(COMPANY, REQ)
        assert exc.value.status_code == 403
