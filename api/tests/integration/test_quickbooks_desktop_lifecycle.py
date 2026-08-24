"""Connection lifecycle and the terms cache for QuickBooks
Desktop.

Split from test_quickbooks_desktop_routes.py, which owns the invoice push. These
exercise the endpoints a shop touches while SETTING UP -- connect, status --
plus the terms cache, which exists for one reason:
PaymentTermsPicker calls the terms endpoint from a MOUNT effect on every quote
form and customer page, and against Desktop a live read would be a Web Connector
round trip on page load aimed at a PC that may be switched off.

The Conductor HTTP boundary is mocked; auth, RLS, ownership checks and the cache
rows run against a real local Supabase.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.quickbooks_desktop as qbdservice  # noqa: E402
from index import app  # noqa: E402

pytestmark = pytest.mark.integration

END_USER = "end_usr_lifecycle_test"


@pytest.fixture(autouse=True)
def _route_env(monkeypatch):
    url = os.environ["TEST_SUPABASE_URL"]
    secret = os.environ["TEST_SUPABASE_SECRET_KEY"]
    monkeypatch.setenv("SUPABASE_URL", url)
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", url)
    monkeypatch.setenv("SUPABASE_SECRET_KEY", secret)
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    monkeypatch.setenv("CONDUCTOR_API_KEY", "sk_conductor_test")
    monkeypatch.setenv("CONDUCTOR_PUBLISHABLE_KEY", "pk_conductor_test")


def _cleanup(admin, company_id: str) -> None:
    for table in (
        "quickbooks_terms_cache",
        "quickbooks_desktop_connections",
        "quickbooks_connections",
        "customers",
    ):
        try:
            admin.table(table).delete().eq("company_id", company_id).execute()
        except Exception:
            pass


def _seed_connection(admin, company_id: str) -> None:
    admin.table("quickbooks_desktop_connections").insert(
        {
            "company_id": company_id,
            "conductor_end_user_id": END_USER,
            "environment": "sandbox",
        }
    ).execute()


async def _post(token: str, path: str, body: dict):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver",
                           headers={"Authorization": f"Bearer {token}"}) as ac:
        return await ac.post(path, json=body)


async def _get(token: str, path: str):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver",
                           headers={"Authorization": f"Bearer {token}"}) as ac:
        return await ac.get(path)


def _set_role(admin, company_id: str, user_id: str, role: str) -> None:
    admin.table("user_company_access").update({"role": role}).eq(
        "company_id", company_id
    ).eq("user_id", user_id).execute()


# ───────────────────────── connect ─────────────────────────
async def test_connect_requires_admin(supabase_admin, seeded_user_a, monkeypatch):
    """The role check is now the ONLY thing between a caller and a billable Conductor connection.

    Until Aug 2026 a `quickbooks_desktop` feature flag stood in front of this too, checked on the
    backend precisely because Conductor bills $49/month per active company file. That flag was
    retired with the rest of the registry cleanup, taking its two tests with it — so this one is
    load-bearing in a way it was not before: `connect` mints a working auth-flow link, and nothing
    downstream can refuse the resulting bill.

    Note it never set the flag even when the flag existed, because `verify_company_access` runs
    first — which is why it passes unchanged.
    """
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    monkeypatch.setattr(
        qbdservice, "ensure_end_user",
        lambda *a, **k: pytest.fail("must not reach Conductor for a non-admin"),
    )
    _set_role(supabase_admin, cid, seeded_user_a["user_id"], "user")
    try:
        resp = await _post(seeded_user_a["access_token"],
                           f"/api/quickbooks-desktop/{cid}/connect", {})
        assert resp.status_code == 403
    finally:
        _set_role(supabase_admin, cid, seeded_user_a["user_id"], "admin")
        _cleanup(supabase_admin, cid)


async def test_connect_refuses_when_quickbooks_online_is_connected(
    supabase_admin, seeded_user_a, monkeypatch
):
    """A readable 409, rather than letting the database's single-provider trigger
    surface as an opaque 500."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    supabase_admin.table("quickbooks_connections").insert(
        {"company_id": cid, "realm_id": "realm-x", "environment": "sandbox",
         "access_token": "AT", "access_expires_at": "2030-01-01T00:00:00Z",
         "refresh_token": "RT"}
    ).execute()
    monkeypatch.setattr(qbdservice, "ensure_end_user",
                        lambda *a, **k: pytest.fail("must not reach Conductor"))
    try:
        resp = await _post(seeded_user_a["access_token"],
                           f"/api/quickbooks-desktop/{cid}/connect", {})
        assert resp.status_code == 409
        assert "QuickBooks Online" in resp.json()["detail"]
    finally:
        _cleanup(supabase_admin, cid)


async def test_connect_persists_the_end_user(supabase_admin, seeded_user_a, monkeypatch):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    monkeypatch.setattr(qbdservice, "ensure_end_user", lambda *a, **k: {"id": "end_usr_new"})
    monkeypatch.setattr(
        qbdservice, "create_auth_session",
        lambda *a, **k: {"auth_flow_url": "https://connect.conductor.is/qbd/x?key=pk",
                         "expires_at": "2026-08-12T00:00:00Z"},
    )
    try:
        resp = await _post(seeded_user_a["access_token"],
                           f"/api/quickbooks-desktop/{cid}/connect", {})
        assert resp.status_code == 200, resp.text
        assert resp.json()["auth_flow_url"].startswith("https://connect.conductor.is/")
        row = supabase_admin.table("quickbooks_desktop_connections").select("*").eq(
            "company_id", cid).execute().data[0]
        assert row["conductor_end_user_id"] == "end_usr_new"
    finally:
        _cleanup(supabase_admin, cid)


# ───────────────────────── status ─────────────────────────
async def test_status_is_not_linked_until_a_request_has_succeeded(
    supabase_admin, seeded_user_a, monkeypatch
):
    """Conductor creates the integration_connection the moment the auth flow
    STARTS, so a half-finished setup must not read as working."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    monkeypatch.setattr(qbdservice, "connection_state", lambda *a, **k: {
        "linked": False, "integration_connection_id": "int_conn_1",
        "last_successful_request_at": None})
    try:
        resp = await _get(seeded_user_a["access_token"],
                          f"/api/quickbooks-desktop/{cid}/status")
        assert resp.status_code == 200
        assert resp.json()["connected"] is True
        assert resp.json()["linked"] is False
    finally:
        _cleanup(supabase_admin, cid)


async def test_status_does_not_assert_disconnected_when_the_probe_fails(
    supabase_admin, seeded_user_a, monkeypatch
):
    """Could not check is never denied."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    monkeypatch.setattr(qbdservice, "connection_state",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    try:
        resp = await _get(seeded_user_a["access_token"],
                          f"/api/quickbooks-desktop/{cid}/status")
        assert resp.status_code == 200
        assert resp.json()["connected"] is True
    finally:
        _cleanup(supabase_admin, cid)


# ───────────────────────── terms cache ─────────────────────────
async def test_terms_are_served_from_cache_without_touching_quickbooks(
    supabase_admin, seeded_user_a, monkeypatch
):
    """This is the whole point of the cache: the picker calls it on mount."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    supabase_admin.table("quickbooks_terms_cache").insert(
        {"company_id": cid, "provider": "qbd", "realm_id": END_USER,
         "qb_term_id": "10000-933272658", "name": "Net 30", "due_days": 30}
    ).execute()
    monkeypatch.setattr(qbdservice, "list_terms",
                        lambda *a, **k: pytest.fail("terms must come from the cache"))
    try:
        resp = await _get(seeded_user_a["access_token"], f"/api/quickbooks/{cid}/terms")
        assert resp.status_code == 200
        body = resp.json()
        assert body["connected"] is True
        assert body["terms"] == [
            {"id": "10000-933272658", "name": "Net 30", "due_days": 30}
        ]
    finally:
        _cleanup(supabase_admin, cid)


async def test_a_cold_terms_cache_degrades_rather_than_failing(
    supabase_admin, seeded_user_a, monkeypatch
):
    """An empty cache must not stop anyone writing a quote: the picker falls back
    to Jigged's presets and resolve_term_id creates the term at push time."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    monkeypatch.setattr(qbdservice, "list_terms",
                        lambda *a, **k: pytest.fail("terms must come from the cache"))
    try:
        resp = await _get(seeded_user_a["access_token"], f"/api/quickbooks/{cid}/terms")
        assert resp.status_code == 200
        assert resp.json() == {"connected": True, "terms": []}
    finally:
        _cleanup(supabase_admin, cid)


async def test_terms_refresh_writes_the_cache_and_drops_deleted_terms(
    supabase_admin, seeded_user_a, monkeypatch
):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    supabase_admin.table("quickbooks_terms_cache").insert(
        {"company_id": cid, "provider": "qbd", "realm_id": END_USER,
         "qb_term_id": "STALE", "name": "Deleted Term", "due_days": 7}
    ).execute()
    monkeypatch.setattr(qbdservice, "list_terms", lambda *a, **k: [
        {"id": "T1", "name": "Net 15", "due_days": 15},
        {"id": "T2", "name": "Due on receipt", "due_days": 0},
    ])
    try:
        resp = await _post(seeded_user_a["access_token"],
                           f"/api/quickbooks-desktop/{cid}/terms/refresh", {})
        assert resp.status_code == 200
        assert resp.json()["terms"] == 2
        rows = supabase_admin.table("quickbooks_terms_cache").select("qb_term_id").eq(
            "company_id", cid).execute().data
        assert {r["qb_term_id"] for r in rows} == {"T1", "T2"}
    finally:
        _cleanup(supabase_admin, cid)
