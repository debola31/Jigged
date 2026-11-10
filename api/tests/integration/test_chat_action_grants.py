"""public.chat_action_grants: who may see and change Jigged chat's "Always allow" list.

Migration 20261110021756. A grant lets the chat change data for a person without asking, so
the table is a permission, and these are its edges:

  * a person sees and revokes their own grants only
  * the browser never creates one (the backend does, on the person's click) and can change
    `deleted_at` alone -- revoking, never turning one grant into another
  * an AI assistant's OAuth token (a client_id claim) gets nothing, even its own person's rows
  * the insights AI's SQL role cannot read it
"""
from __future__ import annotations

import json
import os
from contextlib import contextmanager

import psycopg2
import pytest

pytestmark = pytest.mark.integration

DB_URL = os.getenv(
    "TEST_SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)
READONLY_URL = DB_URL.replace("postgres:postgres@", "jigged_ai_readonly:postgres@", 1)


@pytest.fixture
def billing_open(supabase_admin, seeded_user_a):
    """The write gate reads a company with no billing row as unpaid; open it for the browser
    write tests and close it again, as test_ai_chat_threads.py does."""
    company_id = seeded_user_a["company_id"]
    supabase_admin.table("company_billing").upsert(
        {"company_id": company_id, "billing_exempt": True}, on_conflict="company_id"
    ).execute()
    yield
    supabase_admin.table("company_billing").delete().eq("company_id", company_id).execute()


def _grant(admin, seeded, tool="create_quote") -> str:
    # One tool per test: the seeded users are session-scoped, and a second grant of the
    # same action is (correctly) a unique-key violation.
    return admin.table("chat_action_grants").insert({
        "company_id": seeded["company_id"], "user_id": seeded["user_id"], "tool_name": tool,
    }).execute().data[0]["id"]


@contextmanager
def _as(claims: dict):
    """A raw session as `authenticated` with these JWT claims -- the shape PostgREST gives a
    request, without needing an OAuth server to mint an assistant's token."""
    try:
        conn = psycopg2.connect(DB_URL)
    except psycopg2.OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"No Postgres: {exc}")
    try:
        with conn.cursor() as cur:
            cur.execute("BEGIN")
            cur.execute("SELECT set_config('request.jwt.claims', %s, true)", (json.dumps(claims),))
            cur.execute("SET LOCAL ROLE authenticated")
            yield cur
            cur.execute("ROLLBACK")
    finally:
        conn.close()


def test_a_person_sees_only_their_own_grants(supabase_admin, seeded_user_a, seeded_user_b):
    mine = _grant(supabase_admin, seeded_user_a)
    theirs = _grant(supabase_admin, seeded_user_b)
    ids = {r["id"] for r in seeded_user_a["client"].table("chat_action_grants").select("id").execute().data}
    assert mine in ids
    assert theirs not in ids, "one person could see what another lets the chat do"


def test_the_browser_cannot_create_a_grant(seeded_user_a, billing_open):
    """Only the backend writes one, in the request that runs the change the person approved."""
    with pytest.raises(Exception) as exc:
        seeded_user_a["client"].table("chat_action_grants").insert({
            "company_id": seeded_user_a["company_id"], "user_id": seeded_user_a["user_id"],
            "tool_name": "archive_record",
        }).execute()
    assert "42501" in str(exc.value) or "permission denied" in str(exc.value).lower()


def test_a_person_can_revoke_their_grant_and_nothing_else(supabase_admin, seeded_user_a, billing_open):
    grant_id = _grant(supabase_admin, seeded_user_a, tool="add_stock")
    client = seeded_user_a["client"]

    client.table("chat_action_grants").update({"deleted_at": "2026-11-10T00:00:00Z"}).eq("id", grant_id).execute()
    row = supabase_admin.table("chat_action_grants").select("deleted_at").eq("id", grant_id).execute().data[0]
    assert row["deleted_at"] is not None

    # The column grant: renaming a grant would be granting a different action.
    with pytest.raises(Exception) as exc:
        client.table("chat_action_grants").update({"tool_name": "archive_record"}).eq("id", grant_id).execute()
    assert "42501" in str(exc.value) or "permission denied" in str(exc.value).lower()


def test_an_ai_assistants_token_gets_nothing_even_for_its_own_person(supabase_admin, seeded_user_a):
    _grant(supabase_admin, seeded_user_a, tool="update_job")
    base = {"sub": seeded_user_a["user_id"], "role": "authenticated", "aud": "authenticated"}

    with _as(base) as cur:
        cur.execute("SELECT count(*) FROM public.chat_action_grants")
        assert cur.fetchone()[0] >= 1, "the browser session should see its own grant"

    with _as({**base, "client_id": "some-assistant"}) as cur:
        cur.execute("SELECT count(*) FROM public.chat_action_grants")
        assert cur.fetchone()[0] == 0, "an assistant token read the chat's permissions"


def test_the_insights_sql_role_cannot_read_grants():
    try:
        conn = psycopg2.connect(READONLY_URL)
    except psycopg2.OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"No jigged_ai_readonly login: {exc}")
    conn.autocommit = True
    try:
        with conn.cursor() as cur, pytest.raises(psycopg2.errors.InsufficientPrivilege):
            cur.execute("SELECT 1 FROM public.chat_action_grants LIMIT 1")
    finally:
        conn.close()
