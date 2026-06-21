"""Route-level integration tests for the QuickBooks endpoints.

Exercises the gating (push requires a converted quote), the idempotency claim
(lost-ack + double-submit -> one invoice), concurrent double-submit, and the
admin-only guard — going through the real FastAPI app against a local Supabase.

The QBO HTTP boundary is mocked (services.quickbooks.create_invoice) so no real
Intuit call is made; everything else (auth, gating, the ON CONFLICT idempotency
claim, the link rows) runs against the real DB.

Requires a local Supabase with this branch's migration applied:
    supabase start && supabase migration up
    TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY / TEST_SUPABASE_SECRET_KEY set.
"""
from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from httpx import ASGITransport, AsyncClient
from supabase import create_client

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.quickbooks as qbservice  # noqa: E402
from index import app  # noqa: E402

pytestmark = pytest.mark.integration


@pytest.fixture(autouse=True)
def _route_env(monkeypatch):
    """Point the route's service client (and token validation) at the local test
    Supabase, and supply QBO config. _service_client() reads env at call time."""
    url = os.environ["TEST_SUPABASE_URL"]
    secret = os.environ["TEST_SUPABASE_SECRET_KEY"]
    monkeypatch.setenv("SUPABASE_URL", url)
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", url)
    monkeypatch.setenv("SUPABASE_SECRET_KEY", secret)
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    monkeypatch.setenv("QUICK_BOOKS_CLIENT_ID", "cid_test")
    monkeypatch.setenv("QUICK_BOOKS_CLIENT_SECRET", "secret_test")
    monkeypatch.setenv("QUICKBOOKS_REDIRECT_URI", "http://localhost:8000/api/quickbooks/callback")
    monkeypatch.setenv("QUICKBOOKS_STATE_SECRET", "test-state-secret")


def _now_iso(**delta) -> str:
    return (datetime.now(timezone.utc) + timedelta(**delta)).isoformat()


def _cleanup(admin, company_id: str) -> None:
    for table in (
        "quickbooks_invoice_links",
        "quickbooks_customer_map",
        "quickbooks_connections",
        "job_parts",
        "jobs",
        "quote_line_items",
        "quotes",
        "parts",
        "customers",
    ):
        try:
            admin.table(table).delete().eq("company_id", company_id).execute()
        except Exception:
            pass


def _seed_connection(admin, company_id: str) -> None:
    admin.table("quickbooks_connections").insert(
        {
            "company_id": company_id,
            "realm_id": "realm-rt",
            "environment": "sandbox",
            "access_token": "AT",
            "access_expires_at": _now_iso(hours=1),
            "refresh_token": "RT",
            "refresh_expires_at": _now_iso(days=100),
            "default_item_id": "1",  # so resolve_default_item never calls QBO
        }
    ).execute()


def _seed_quote(admin, company_id: str, converted: bool) -> dict:
    customer = (
        admin.table("customers").insert({"company_id": company_id, "name": "RT QB Customer"}).execute().data[0]
    )
    part = (
        admin.table("parts")
        .insert({"company_id": company_id, "part_name": "RT-PART-1", "primary_unit": "each", "source": "made"})
        .execute()
        .data[0]
    )
    quote = (
        admin.table("quotes")
        .insert(
            {
                "company_id": company_id,
                "customer_id": customer["id"],
                "quote_number": "",
                "status": "active",
                "converted_at": _now_iso() if converted else None,
            }
        )
        .execute()
        .data[0]
    )
    qli = (
        admin.table("quote_line_items")
        .insert(
            {
                "company_id": company_id,
                "quote_id": quote["id"],
                "part_id": part["id"],
                "sequence": 0,
                "quantity": 10,
                "unit_price": 12.5,
            }
        )
        .execute()
        .data[0]
    )
    job_id = None
    if converted:
        job = (
            admin.table("jobs")
            .insert(
                {
                    "company_id": company_id,
                    "customer_id": customer["id"],
                    "quote_id": quote["id"],
                    "job_number": "J-RT-QB",
                    "production_status": "not_started",
                    "fulfillment_status": "unshipped",
                }
            )
            .execute()
            .data[0]
        )
        job_id = job["id"]
        admin.table("job_parts").insert(
            {
                "company_id": company_id,
                "job_id": job_id,
                "part_id": part["id"],
                "source_quote_line_item_id": qli["id"],
                "sequence": 0,
                "quantity": 10,
                "production_status": "not_started",
                "fulfillment_status": "unshipped",
            }
        ).execute()
    return {"customer_id": customer["id"], "quote_id": quote["id"], "job_id": job_id}


def _map_customer(admin, company_id: str, customer_id: str) -> None:
    admin.table("quickbooks_customer_map").insert(
        {
            "company_id": company_id,
            "customer_id": customer_id,
            "realm_id": "realm-rt",
            "qb_customer_id": "QB-1",
        }
    ).execute()


async def _post(token: str, path: str, body: dict):
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://testserver", headers={"Authorization": f"Bearer {token}"}
    ) as ac:
        return await ac.post(path, json=body)


# ───────────────────────── gating ─────────────────────────
async def test_preflight_404_for_missing_job(supabase_admin, seeded_user_a):
    # Invoicing is job-keyed now; a job is intrinsically billable, so the old
    # "convert the quote first" gate is gone — a non-existent job just 404s.
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    try:
        resp = await _post(
            seeded_user_a["access_token"],
            f"/api/quickbooks/{cid}/jobs/00000000-0000-0000-0000-000000000000/preflight",
            {},
        )
        assert resp.status_code == 404
    finally:
        _cleanup(supabase_admin, cid)


async def test_invoice_404_for_missing_job(supabase_admin, seeded_user_a):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    try:
        resp = await _post(
            seeded_user_a["access_token"],
            f"/api/quickbooks/{cid}/jobs/00000000-0000-0000-0000-000000000000/invoice",
            {"customer": {"action": "create"}},
        )
        assert resp.status_code == 404
    finally:
        _cleanup(supabase_admin, cid)


async def test_preflight_reports_not_connected(supabase_admin, seeded_user_a):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)  # no connection seeded
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        resp = await _post(
            seeded_user_a["access_token"], f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/preflight", {}
        )
        assert resp.status_code == 200
        assert resp.json()["connected"] is False
    finally:
        _cleanup(supabase_admin, cid)


# ───────────────────────── idempotency ─────────────────────────
async def test_invoice_push_is_idempotent(supabase_admin, seeded_user_a, monkeypatch):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    _map_customer(supabase_admin, cid, seed["customer_id"])

    calls = {"n": 0}

    def _fake_create_invoice(db, company_id, payload, request_id):
        calls["n"] += 1
        return {"id": f"INV-{calls['n']}", "doc_number": "D-1", "sync_token": "0"}

    monkeypatch.setattr(qbservice, "create_invoice", _fake_create_invoice)
    body = {"customer": {"action": "use_existing", "qb_customer_id": "QB-1"}}
    path = f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice"
    try:
        r1 = await _post(seeded_user_a["access_token"], path, body)
        assert r1.status_code == 200
        d1 = r1.json()
        assert d1["already_existed"] is False
        assert d1["qb_invoice_id"] == "INV-1"
        # A QBO deep link is returned + stored (sandbox connection -> sandbox host).
        assert d1["url"] == "https://app.sandbox.qbo.intuit.com/app/invoice?txnId=INV-1"

        r2 = await _post(seeded_user_a["access_token"], path, body)
        assert r2.status_code == 200
        d2 = r2.json()
        assert d2["already_existed"] is True
        assert d2["qb_invoice_id"] == "INV-1"
        assert d2["url"] == "https://app.sandbox.qbo.intuit.com/app/invoice?txnId=INV-1"

        assert calls["n"] == 1  # QBO invoice created exactly once
        links = (
            supabase_admin.table("quickbooks_invoice_links")
            .select("status, qb_invoice_url")
            .eq("job_id", seed["job_id"])
            .execute()
            .data
        )
        assert len(links) == 1 and links[0]["status"] == "created"
        assert links[0]["qb_invoice_url"] == "https://app.sandbox.qbo.intuit.com/app/invoice?txnId=INV-1"
    finally:
        _cleanup(supabase_admin, cid)


# ───────────────────────── concurrency ─────────────────────────
async def test_concurrent_double_submit_creates_one_invoice(supabase_admin, seeded_user_a, monkeypatch):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    _map_customer(supabase_admin, cid, seed["customer_id"])

    calls = {"n": 0}

    def _fake_create_invoice(db, company_id, payload, request_id):
        calls["n"] += 1
        return {"id": "INV-1", "doc_number": "D-1", "sync_token": "0"}

    monkeypatch.setattr(qbservice, "create_invoice", _fake_create_invoice)
    body = {"customer": {"action": "use_existing", "qb_customer_id": "QB-1"}}
    path = f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice"
    try:
        transport = ASGITransport(app=app)
        async with AsyncClient(
            transport=transport,
            base_url="http://testserver",
            headers={"Authorization": f"Bearer {seeded_user_a['access_token']}"},
        ) as ac:
            r1, r2 = await asyncio.gather(ac.post(path, json=body), ac.post(path, json=body))

        assert {r1.status_code, r2.status_code} == {200}
        assert calls["n"] == 1  # only the insert-winner POSTed to QBO
        links = (
            supabase_admin.table("quickbooks_invoice_links")
            .select("status")
            .eq("job_id", seed["job_id"])
            .execute()
            .data
        )
        assert len(links) == 1 and links[0]["status"] == "created"
    finally:
        _cleanup(supabase_admin, cid)


# ───────────────────────── admin guard ─────────────────────────
async def test_authorize_requires_admin(supabase_admin, seeded_user_a):
    cid = seeded_user_a["company_id"]
    email = f"qb-nonadmin-{os.urandom(4).hex()}@test.jigged.local"
    password = "test-password-qb-nonadmin"
    user = supabase_admin.auth.admin.create_user(
        {"email": email, "password": password, "email_confirm": True}
    ).user
    supabase_admin.table("user_company_access").insert(
        {"user_id": user.id, "company_id": cid, "role": "operator"}
    ).execute()
    anon = create_client(os.environ["TEST_SUPABASE_URL"], os.environ["TEST_SUPABASE_PUBLISHABLE_KEY"])
    token = anon.auth.sign_in_with_password({"email": email, "password": password}).session.access_token
    try:
        resp = await _post(token, f"/api/quickbooks/{cid}/authorize", {})
        assert resp.status_code == 403
    finally:
        supabase_admin.table("user_company_access").delete().eq("user_id", user.id).execute()
        try:
            supabase_admin.auth.admin.delete_user(user.id)
        except Exception:
            pass
