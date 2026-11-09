"""POST /api/insights/{company_id}/query against a real database: the sandbox decides, not the route.

The unit file (tests/unit/test_insights_query_route.py) proves what the ROUTE does. These prove
what the DATABASE does with a statement the caller wrote, through the whole stack: a real user
token, verify_office_access, the validator, and execute_sql_query as jigged_ai_readonly with
jigged.company_id set per transaction. Company isolation and the archive filter are the
ai_readonly_select policies' (docs/modules/ai-insights.md), so only a database can show them.

Needs a local Supabase with migrations applied, the TEST_SUPABASE_* variables (see
tests/conftest.py), and AI_READONLY_DATABASE_URL pointing at jigged_ai_readonly on THAT local
database. The module skips rather than pass vacuously when the DSN is the superuser, and refuses
to run against anything but localhost.
"""
from __future__ import annotations

import os
import secrets
from urllib.parse import urlsplit

import pytest
from httpx import ASGITransport, AsyncClient

from index import app
from tools.sql_executor import MAX_ROWS, close_pool, init_pool

# The real OAuth flow, for an assistant's token. Imported rather than copied: one way to mint one.
from tests.integration.test_mcp_token_binding import assistant_token  # noqa: F401

pytestmark = [pytest.mark.integration, pytest.mark.slow]

_RO_DSN = os.getenv("AI_READONLY_DATABASE_URL", "")
GATEWAY_KEY = "query-route-gateway-key-" + secrets.token_hex(8)


@pytest.fixture(autouse=True)
async def _sandbox():
    """The executor's pool, on the LOCAL sandbox role only, closed after each test (the pool is
    bound to the test's event loop)."""
    if urlsplit(_RO_DSN).hostname not in ("127.0.0.1", "localhost"):
        pytest.skip("AI_READONLY_DATABASE_URL is not a local database")
    pool = await init_pool()
    if pool is None:
        pytest.skip("AI_READONLY_DATABASE_URL not configured")
    async with pool.acquire() as conn:
        who = await conn.fetchval("SELECT current_user")
    if who != "jigged_ai_readonly":
        await close_pool()
        pytest.skip(f"AI_READONLY_DATABASE_URL connects as {who!r}; the policies would not be exercised")
    yield
    await close_pool()


@pytest.fixture(autouse=True)
def _route_env(monkeypatch):
    """The route's token check and membership read go to the local test Supabase."""
    url = os.environ["TEST_SUPABASE_URL"]
    monkeypatch.setenv("SUPABASE_URL", url)
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", url)
    monkeypatch.setenv("SUPABASE_SECRET_KEY", os.environ["TEST_SUPABASE_SECRET_KEY"])
    monkeypatch.setenv("MCP_GATEWAY_KEY", GATEWAY_KEY)


@pytest.fixture(scope="module")
def shop(supabase_admin, seeded_user_a, seeded_user_b):
    """A live and an archived customer in company A, and one in company B."""
    tag = f"IQ-{secrets.token_hex(3)}"
    a, b = seeded_user_a["company_id"], seeded_user_b["company_id"]
    rows = (
        supabase_admin.table("customers")
        .insert(
            [
                {"company_id": a, "name": f"{tag} A live"},
                {"company_id": a, "name": f"{tag} A archived", "deleted_at": "2026-11-01T00:00:00Z"},
                {"company_id": b, "name": f"{tag} B other shop"},
            ]
        )
        .execute()
    ).data
    yield {"tag": tag, "a": a, "b": b}
    supabase_admin.table("customers").delete().in_("id", [r["id"] for r in rows]).execute()


async def _post(company_id: str, sql: str, token: str, headers: dict | None = None, today: str | None = None):
    body: dict = {"sql": sql}
    if today:
        body["today"] = today
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
        headers={"Authorization": f"Bearer {token}", **(headers or {})},
    ) as ac:
        return await ac.post(f"/api/insights/{company_id}/query", json=body)


def _names(response) -> list[str]:
    assert response.status_code == 200, response.text
    return [row["name"] for row in response.json()["rows"]]


async def test_reads_its_own_company(shop, seeded_user_a):
    res = await _post(
        shop["a"],
        f"SELECT name FROM customers WHERE company_id = $1 AND name LIKE '{shop['tag']}%' ORDER BY name",
        seeded_user_a["access_token"],
    )
    assert _names(res) == [f"{shop['tag']} A live"]
    assert res.json()["columns"] == ["name"]
    assert res.json()["capped"] is False


async def test_another_companys_rows_cannot_be_read(shop, seeded_user_a):
    token = seeded_user_a["access_token"]
    # Naming B's id outright: $1 satisfies the validator, and the policy still hides B's rows.
    named = await _post(
        shop["a"],
        f"SELECT name FROM customers WHERE (company_id = $1 OR company_id = '{shop['b']}') "
        f"AND name LIKE '{shop['tag']}%'",
        token,
    )
    assert _names(named) == [f"{shop['tag']} A live"]
    only_b = await _post(
        shop["a"],
        f"SELECT name FROM customers WHERE company_id = '{shop['b']}' AND $1::text IS NOT NULL",
        token,
    )
    assert _names(only_b) == []
    # And B's id in the URL is refused before any SQL runs: A is not a member there.
    other_url = await _post(shop["b"], "SELECT name FROM customers WHERE company_id = $1", token)
    assert other_url.status_code == 403


async def test_archived_rows_do_not_come_back(shop, seeded_user_a):
    res = await _post(
        shop["a"],
        f"SELECT name FROM customers WHERE company_id = $1 AND (deleted_at IS NOT NULL "
        f"OR name = '{shop['tag']} A archived')",
        seeded_user_a["access_token"],
    )
    assert _names(res) == []


async def test_a_non_select_is_refused_and_changes_nothing(shop, seeded_user_a, supabase_admin):
    token = seeded_user_a["access_token"]
    for sql in (
        f"DELETE FROM customers WHERE company_id = $1 AND name LIKE '{shop['tag']}%'",
        f"UPDATE customers SET name = 'gone' WHERE company_id = $1 AND name LIKE '{shop['tag']}%'",
    ):
        res = await _post(shop["a"], sql, token)
        assert res.status_code == 400, res.text
    left = (
        supabase_admin.table("customers").select("name").like("name", f"{shop['tag']}%").execute()
    ).data
    assert len(left) == 3


async def test_the_row_cap_holds(shop, seeded_user_a):
    token = seeded_user_a["access_token"]
    for sql in (
        "SELECT g FROM generate_series(1, 500) AS g WHERE $1::text IS NOT NULL",
        # A LIMIT of its own above the cap is cut to the cap as well.
        "SELECT g FROM generate_series(1, 500) AS g WHERE $1::text IS NOT NULL LIMIT 400",
    ):
        res = await _post(shop["a"], sql, token)
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["row_count"] == MAX_ROWS == len(body["rows"])
        assert body["capped"] is True
        assert body["row_cap"] == MAX_ROWS


async def test_runs_no_ai_job(shop, seeded_user_a, supabase_admin):
    def jobs() -> int:
        return len(supabase_admin.table("ai_jobs").select("id").eq("company_id", shop["a"]).execute().data)

    before = jobs()
    res = await _post(shop["a"], "SELECT COUNT(*) AS n FROM jobs WHERE company_id = $1", seeded_user_a["access_token"])
    assert res.status_code == 200, res.text
    assert jobs() == before


async def test_who_did_the_work_is_refused(shop, seeded_user_a):
    # The sandbox CAN read completed_by (a user id), so this is the route's rule, end to end. The
    # `SELECT *` half needs rows to have columns and is unit-tested.
    named = await _post(
        shop["a"],
        "SELECT completed_by, COUNT(*) FROM job_operations jo JOIN jobs j ON j.id = jo.job_id "
        "WHERE j.company_id = $1 GROUP BY completed_by",
        seeded_user_a["access_token"],
    )
    assert named.status_code == 400
    assert "completed_by" in named.json()["detail"]


async def test_an_operator_token_is_refused(shop, supabase_admin):
    email = f"iq-operator-{secrets.token_hex(4)}@test.jigged.local"
    password = "iq-operator-" + secrets.token_hex(8)
    user = supabase_admin.auth.admin.create_user({"email": email, "password": password, "email_confirm": True}).user
    try:
        supabase_admin.table("user_company_access").insert(
            {"user_id": user.id, "company_id": shop["a"], "role": "operator"}
        ).execute()
        from supabase import create_client

        session = create_client(
            os.environ["TEST_SUPABASE_URL"], os.environ["TEST_SUPABASE_PUBLISHABLE_KEY"]
        ).auth.sign_in_with_password({"email": email, "password": password})
        res = await _post(
            shop["a"], "SELECT COUNT(*) AS n FROM customers WHERE company_id = $1", session.session.access_token
        )
        assert res.status_code == 403
        assert "office" in res.json()["detail"]
    finally:
        supabase_admin.table("user_company_access").delete().eq("user_id", user.id).execute()
        supabase_admin.auth.admin.delete_user(user.id)


async def test_an_assistant_token_needs_the_gateway_key(shop, assistant_token):  # noqa: F811
    sql = f"SELECT name FROM customers WHERE company_id = $1 AND name LIKE '{shop['tag']}%'"
    for headers in ({}, {"x-jigged-mcp": "not-" + GATEWAY_KEY}):
        res = await _post(shop["a"], sql, assistant_token, headers)
        assert res.status_code == 403, res.text
        assert "jigged.app/mcp" in res.json()["detail"]
    bound = await _post(shop["a"], sql, assistant_token, {"x-jigged-mcp": GATEWAY_KEY})
    assert _names(bound) == [f"{shop['tag']} A live"]


async def test_the_schema_is_served_to_an_office_member(shop, seeded_user_a):
    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
        headers={"Authorization": f"Bearer {seeded_user_a['access_token']}"},
    ) as ac:
        res = await ac.get(f"/api/insights/{shop['a']}/schema")
    assert res.status_code == 200, res.text
    body = res.json()
    assert "### customers" in body["schema_context"]
    assert "## Late job" in body["semantics"]
    assert body["row_cap"] == MAX_ROWS
