"""Route-level integration tests for the QuickBooks endpoints.

Exercises the gating (push requires a converted quote), the idempotency claim
(lost-ack + double-submit -> one invoice), concurrent double-submit, the
admin-only guard, and the read-back payment mirror (what QBO last said about each
invoice) — going through the real FastAPI app against a local Supabase.

Both QBO HTTP boundaries are mocked — services.quickbooks.create_invoice on the
push, fetch_invoice_facts on the read — so no real Intuit call is made; everything
else (auth, gating, the ON CONFLICT idempotency claim, the link rows, the guarded
mirror RPC and the invoicing_status triggers it fires) runs against the real DB.

Requires a local Supabase with this branch's migration applied:
    supabase start && supabase migration up
    TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY / TEST_SUPABASE_SECRET_KEY set.
"""
from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

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
        # quickbooks_invoice_links delete cascades to quickbooks_invoice_line_items
        # (qb_ili_job_part_fk is RESTRICT, so these must go before job_parts).
        "quickbooks_invoice_links",
        "quickbooks_customer_map",
        "quickbooks_connections",
        # The Desktop row too: assert_single_accounting_provider refuses a QBO
        # connection while one survives, so a leftover would break the next test.
        "quickbooks_desktop_connections",
        # shipments delete cascades to shipment_line_items (whose job_part FK is
        # NO ACTION), so shipments must also go before job_parts.
        "shipments",
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
        job_part = (
            admin.table("job_parts")
            .insert(
                {
                    "company_id": company_id,
                    "job_id": job_id,
                    "part_id": part["id"],
                    "source_quote_line_item_id": qli["id"],
                    "sequence": 0,
                    "quantity": 10,
                    # Invoicing reads price off job_parts now (single read shape),
                    # so the seed must carry it like convert/create-from-PO do.
                    "unit_price": 12.5,
                    "total_price": 125,
                    "production_status": "not_started",
                    "fulfillment_status": "unshipped",
                }
            )
            .execute()
            .data[0]
        )
        job_part_id = job_part["id"]
    else:
        job_part_id = None
    return {
        "customer_id": customer["id"],
        "quote_id": quote["id"],
        "job_id": job_id,
        "job_part_id": job_part_id,
    }


def _seed_shipment(admin, company_id: str, customer_id: str, job_id: str, job_part_id: str, qty: float) -> None:
    """Ship `qty` of a job_part so it becomes invoiceable (invoicing is ship-capped:
    invoiceable = shipped - already-invoiced)."""
    shipment = (
        admin.table("shipments")
        .insert(
            {
                "company_id": company_id,
                "customer_id": customer_id,
                "job_id": job_id,
                "packing_slip_number": f"PS-RT-{uuid4().hex[:8]}",
                "ship_date": datetime.now(timezone.utc).date().isoformat(),
            }
        )
        .execute()
        .data[0]
    )
    admin.table("shipment_line_items").insert(
        {"shipment_id": shipment["id"], "job_part_id": job_part_id, "quantity": qty}
    ).execute()


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
            {
                "customer": {"action": "create"},
                "request_id": str(uuid4()),
                "lines": [{"job_part_id": "00000000-0000-0000-0000-000000000001", "quantity": 1}],
            },
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
    # Ship all 10 so the whole line is invoiceable (invoicing is ship-capped).
    _seed_shipment(supabase_admin, cid, seed["customer_id"], seed["job_id"], seed["job_part_id"], 10)

    calls = {"n": 0}

    def _fake_create_invoice(db, company_id, payload, request_id):
        calls["n"] += 1
        return {"id": f"INV-{calls['n']}", "doc_number": "D-1", "sync_token": "0"}

    monkeypatch.setattr(qbservice, "create_invoice", _fake_create_invoice)
    # Same request_id on both submits → idempotent replay (a double-click of ONE draft).
    body = {
        "customer": {"action": "use_existing", "qb_customer_id": "QB-1"},
        "request_id": str(uuid4()),
        "lines": [{"job_part_id": seed["job_part_id"], "quantity": 10}],
    }
    path = f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice"
    try:
        r1 = await _post(seeded_user_a["access_token"], path, body)
        assert r1.status_code == 200, r1.text
        d1 = r1.json()
        assert d1["already_existed"] is False
        assert d1["qb_invoice_id"] == "INV-1"
        # A QBO deep link is returned + stored (sandbox connection -> sandbox host).
        # The /login?pagereq= shape, not /app/invoice?txnId=: only this form
        # carries the transaction id through QBO's unauthenticated sign-in
        # bounce (verified by redirect trace), and deeplinkcompanyid pins the
        # company so the link can't open a different QBO company's invoice.
        assert d1["url"] == "https://sandbox.qbo.intuit.com/login?deeplinkcompanyid=realm-rt&pagereq=invoice%3FtxnId%3DINV-1"

        r2 = await _post(seeded_user_a["access_token"], path, body)
        assert r2.status_code == 200, r2.text
        d2 = r2.json()
        assert d2["already_existed"] is True
        assert d2["qb_invoice_id"] == "INV-1"
        assert d2["url"] == "https://sandbox.qbo.intuit.com/login?deeplinkcompanyid=realm-rt&pagereq=invoice%3FtxnId%3DINV-1"

        assert calls["n"] == 1  # QBO invoice created exactly once
        links = (
            supabase_admin.table("quickbooks_invoice_links")
            .select("id, status, qb_invoice_url")
            .eq("job_id", seed["job_id"])
            .execute()
            .data
        )
        assert len(links) == 1 and links[0]["status"] == "created"
        assert links[0]["qb_invoice_url"] == "https://sandbox.qbo.intuit.com/login?deeplinkcompanyid=realm-rt&pagereq=invoice%3FtxnId%3DINV-1"

        # The per-part line snapshot is persisted (the Jigged-side qty-invoiced truth)...
        line_items = (
            supabase_admin.table("quickbooks_invoice_line_items")
            .select("job_part_id, quantity, unit_price, total_price")
            .eq("invoice_link_id", links[0]["id"])
            .execute()
            .data
        )
        assert len(line_items) == 1
        assert line_items[0]["job_part_id"] == seed["job_part_id"]
        assert float(line_items[0]["quantity"]) == 10
        assert float(line_items[0]["total_price"]) == 125
        # ...and the invoicing_status axis flipped to fully_invoiced (10 of 10).
        jp = (
            supabase_admin.table("job_parts")
            .select("invoicing_status")
            .eq("id", seed["job_part_id"])
            .single()
            .execute()
            .data
        )
        assert jp["invoicing_status"] == "fully_invoiced"
    finally:
        _cleanup(supabase_admin, cid)


# ───────────────────────── concurrency ─────────────────────────
async def test_concurrent_double_submit_creates_one_invoice(supabase_admin, seeded_user_a, monkeypatch):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    _map_customer(supabase_admin, cid, seed["customer_id"])
    _seed_shipment(supabase_admin, cid, seed["customer_id"], seed["job_id"], seed["job_part_id"], 10)

    calls = {"n": 0}

    def _fake_create_invoice(db, company_id, payload, request_id):
        calls["n"] += 1
        return {"id": "INV-1", "doc_number": "D-1", "sync_token": "0"}

    monkeypatch.setattr(qbservice, "create_invoice", _fake_create_invoice)
    # Same request_id on both concurrent submits — the unique index lets exactly one win.
    body = {
        "customer": {"action": "use_existing", "qb_customer_id": "QB-1"},
        "request_id": str(uuid4()),
        "lines": [{"job_part_id": seed["job_part_id"], "quantity": 10}],
    }
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


# ───────────────────────── ship-cap + progressive invoicing ─────────────────────────
async def test_invoicing_is_ordered_capped_not_ship_capped(supabase_admin, seeded_user_a, monkeypatch):
    """Billing is capped at ORDERED, not shipped: you MAY bill ahead of shipping
    (a packing slip isn't a delivery), but not beyond the ordered quantity."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)  # ordered qty = 10
    _map_customer(supabase_admin, cid, seed["customer_id"])
    # Only 4 shipped — yet billing all 10 (ordered) is allowed.
    _seed_shipment(supabase_admin, cid, seed["customer_id"], seed["job_id"], seed["job_part_id"], 4)

    calls = {"n": 0}

    def _fake_create_invoice(db, company_id, payload, request_id):
        calls["n"] += 1
        return {"id": f"INV-{calls['n']}", "doc_number": f"D-{calls['n']}", "sync_token": "0"}

    monkeypatch.setattr(qbservice, "create_invoice", _fake_create_invoice)
    path = f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice"
    try:
        # Bill 10 of 10 ordered even though only 4 shipped → allowed.
        ok = await _post(
            seeded_user_a["access_token"],
            path,
            {
                "customer": {"action": "use_existing", "qb_customer_id": "QB-1"},
                "request_id": str(uuid4()),
                "lines": [{"job_part_id": seed["job_part_id"], "quantity": 10}],
            },
        )
        assert ok.status_code == 200, ok.text
        assert calls["n"] == 1

        # Now try 1 more → over the ordered qty → 400, no further QBO call.
        over = await _post(
            seeded_user_a["access_token"],
            path,
            {
                "customer": {"action": "use_existing", "qb_customer_id": "QB-1"},
                "request_id": str(uuid4()),
                "lines": [{"job_part_id": seed["job_part_id"], "quantity": 1}],
            },
        )
        assert over.status_code == 400, over.text
        assert calls["n"] == 1
    finally:
        _cleanup(supabase_admin, cid)


async def test_two_invoices_bill_remaining(supabase_admin, seeded_user_a, monkeypatch):
    """Progressive billing: ship 10, invoice 6 on one invoice, then 4 on a second —
    two links, qty fully invoiced. Distinct request_ids => two distinct invoices."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    _map_customer(supabase_admin, cid, seed["customer_id"])
    _seed_shipment(supabase_admin, cid, seed["customer_id"], seed["job_id"], seed["job_part_id"], 10)

    calls = {"n": 0}

    def _fake_create_invoice(db, company_id, payload, request_id):
        calls["n"] += 1
        return {"id": f"INV-{calls['n']}", "doc_number": f"D-{calls['n']}", "sync_token": "0"}

    monkeypatch.setattr(qbservice, "create_invoice", _fake_create_invoice)
    path = f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice"
    try:
        r1 = await _post(
            seeded_user_a["access_token"],
            path,
            {
                "customer": {"action": "use_existing", "qb_customer_id": "QB-1"},
                "request_id": str(uuid4()),
                "lines": [{"job_part_id": seed["job_part_id"], "quantity": 6}],
            },
        )
        assert r1.status_code == 200, r1.text
        assert r1.json()["already_existed"] is False

        r2 = await _post(
            seeded_user_a["access_token"],
            path,
            {
                "customer": {"action": "use_existing", "qb_customer_id": "QB-1"},
                "request_id": str(uuid4()),
                "lines": [{"job_part_id": seed["job_part_id"], "quantity": 4}],
            },
        )
        assert r2.status_code == 200, r2.text
        assert r2.json()["already_existed"] is False

        assert calls["n"] == 2  # two distinct invoices created
        links = (
            supabase_admin.table("quickbooks_invoice_links")
            .select("id")
            .eq("job_id", seed["job_id"])
            .eq("status", "created")
            .execute()
            .data
        )
        assert len(links) == 2

        # 6 + 4 = 10 invoiced → fully_invoiced; a third invoice is now blocked (0 left).
        jp = (
            supabase_admin.table("job_parts")
            .select("invoicing_status")
            .eq("id", seed["job_part_id"])
            .single()
            .execute()
            .data
        )
        assert jp["invoicing_status"] == "fully_invoiced"

        r3 = await _post(
            seeded_user_a["access_token"],
            path,
            {
                "customer": {"action": "use_existing", "qb_customer_id": "QB-1"},
                "request_id": str(uuid4()),
                "lines": [{"job_part_id": seed["job_part_id"], "quantity": 1}],
            },
        )
        assert r3.status_code == 400, r3.text  # nothing left to invoice
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


# ───────────────────────── payment-status mirror (QBO -> Jigged) ─────────────────────────
# The one direction Jigged reads QuickBooks. Every test below replaces
# services.quickbooks.fetch_invoice_facts — refresh_invoice_statuses resolves it as a
# module global at call time — so no Intuit call is made while the route, the guarded
# RPC and the invoicing_status triggers all run for real against the local database.


def _fact(total: str, balance: str, *, due_date: str | None = None, txn_date: str | None = None) -> dict:
    """One invoice as fetch_invoice_facts reports it. Amounts are strings for the same
    reason the service produces them that way: they cross a JSON boundary into
    apply_qbo_invoice_mirror, where a float would round money."""
    return {"total_amt": total, "balance": balance, "due_date": due_date, "txn_date": txn_date}


class _FakeIntuit:
    """The Intuit read boundary, recorded.

    `facts` maps a QBO invoice id to its facts, or to None for an invoice QuickBooks
    confirmed is gone — the only input that produces `missing`. `raises` makes the read
    fail instead, which is the case the mirror must never write down.

    Every call is appended to `calls`, so "QuickBooks was not asked at all" is as
    assertable as what it answered."""

    def __init__(self, facts: dict | None = None, raises: Exception | None = None):
        self.facts = facts or {}
        self.raises = raises
        self.calls: list[list[str]] = []

    def __call__(self, db, company_id, invoice_ids):
        self.calls.append(list(invoice_ids))
        if self.raises is not None:
            raise self.raises
        # An id the test did not stage means the route sent one it should not have (a
        # foreign realm, a pending link). Fail rather than answer for it — a .get()
        # default would quietly report that invoice `missing` and pass.
        unstaged = [i for i in invoice_ids if i not in self.facts]
        assert not unstaged, f"the route asked about un-staged invoice ids: {unstaged}"
        return {i: self.facts[i] for i in invoice_ids}


def _seed_desktop_connection(admin, company_id: str) -> None:
    """A QuickBooks Desktop company. Seeded INSTEAD of _seed_connection, never
    alongside it — assert_single_accounting_provider rejects the second one."""
    admin.table("quickbooks_desktop_connections").insert(
        {
            "company_id": company_id,
            "conductor_end_user_id": "end_usr_rt",
            "environment": "sandbox",
        }
    ).execute()


def _seed_link(admin, company_id: str, seed: dict, qb_invoice_id: str, **columns) -> dict:
    """A 'created' QBO invoice link, inserted directly rather than pushed.

    The void tests below go through the real push route because they need its line
    items and the invoicing_status triggers. The freshness tests use this instead:
    planting a chosen qb_status_checked_at is the whole point of them, and no push can
    produce one."""
    row = {
        "company_id": company_id,
        "job_id": seed["job_id"],
        "quote_id": seed["quote_id"],
        "realm_id": "realm-rt",
        "provider": "qbo",
        "qb_request_id": str(uuid4()),
        "qb_invoice_id": qb_invoice_id,
        "status": "created",
    }
    row.update(columns)
    return admin.table("quickbooks_invoice_links").insert(row).execute().data[0]


def _status_path(company_id: str, job_id: str) -> str:
    return f"/api/quickbooks/{company_id}/jobs/{job_id}/invoice-status"


def _links_by_invoice(admin, job_id: str) -> dict[str, dict]:
    """Every link on the job, whole rows, keyed by QBO invoice id."""
    rows = admin.table("quickbooks_invoice_links").select("*").eq("job_id", job_id).execute().data
    return {r["qb_invoice_id"]: r for r in rows}


def _invoicing_status(admin, job_part_id: str) -> str:
    return (
        admin.table("job_parts")
        .select("invoicing_status")
        .eq("id", job_part_id)
        .single()
        .execute()
        .data["invoicing_status"]
    )


def _fake_pushes(monkeypatch) -> dict:
    """create_invoice, stubbed to hand back INV-1, INV-2, … in call order."""
    calls = {"n": 0}

    def _create(db, company_id, payload, request_id):
        calls["n"] += 1
        return {"id": f"INV-{calls['n']}", "doc_number": f"D-{calls['n']}", "sync_token": "0"}

    monkeypatch.setattr(qbservice, "create_invoice", _create)
    return calls


async def _push(token: str, company_id: str, seed: dict, quantity: float):
    return await _post(
        token,
        f"/api/quickbooks/{company_id}/jobs/{seed['job_id']}/invoice",
        {
            "customer": {"action": "use_existing", "qb_customer_id": "QB-1"},
            "request_id": str(uuid4()),
            "lines": [{"job_part_id": seed["job_part_id"], "quantity": quantity}],
        },
    )


async def test_a_successful_check_stores_every_mirror_column(
    supabase_admin, seeded_user_a, monkeypatch
):
    """One pass writes what QuickBooks said and dates it.

    The QBO total here (137.50) deliberately EXCEEDS Jigged's line total (125.00), the
    way a taxed invoice does. The status still comes from balance vs the QBO total —
    37.50 outstanding of 137.50 is `partial` — because measuring a tax-inclusive total
    against Jigged's own lines would report a settled invoice as part-paid on every
    taxed shop."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    _map_customer(supabase_admin, cid, seed["customer_id"])
    _seed_shipment(supabase_admin, cid, seed["customer_id"], seed["job_id"], seed["job_part_id"], 10)
    _fake_pushes(monkeypatch)
    try:
        pushed = await _push(seeded_user_a["access_token"], cid, seed, 10)
        assert pushed.status_code == 200, pushed.text

        fake = _FakeIntuit(
            {"INV-1": _fact("137.50", "37.50", due_date="2026-09-30", txn_date="2026-09-01")}
        )
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", fake)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        # Never checked before, so the backend asked — exactly once, for the one invoice.
        assert fake.calls == [["INV-1"]]
        assert body["checked"] is True
        assert body["skipped_other_realm"] == 0
        (row,) = body["invoices"]
        assert row["qb_status"] == "partial"
        assert float(row["qb_total_amt"]) == 137.5
        assert float(row["qb_balance"]) == 37.5
        assert row["qb_due_date"] == "2026-09-30"
        assert row["qb_txn_date"] == "2026-09-01"
        assert row["voided_at"] is None

        stored = _links_by_invoice(supabase_admin, seed["job_id"])["INV-1"]
        assert stored["qb_status"] == "partial"
        assert float(stored["qb_total_amt"]) == 137.5
        assert float(stored["qb_balance"]) == 37.5
        assert stored["qb_due_date"] == "2026-09-30"
        assert stored["qb_txn_date"] == "2026-09-01"
        # The response's checked_at IS the stamp on the row, not merely some later time:
        # they are the one clock read the route takes before calling Intuit.
        assert datetime.fromisoformat(stored["qb_status_checked_at"]) == datetime.fromisoformat(
            body["checked_at"]
        )
    finally:
        _cleanup(supabase_admin, cid)


async def test_a_failed_read_leaves_the_stored_answer_untouched(
    supabase_admin, seeded_user_a, monkeypatch
):
    """THE test of this feature. "We couldn't ask" must never be written down as an
    answer: persisting it would tell a shop owner an invoice is unpaid when it may have
    been settled that morning.

    So the whole row is compared before and after — every mirror column AND
    qb_status_checked_at AND updated_at — rather than just the status word."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        # A stored answer old enough to be re-checked: the read WILL be attempted.
        _seed_link(
            supabase_admin,
            cid,
            seed,
            "INV-STORED",
            qb_status="paid",
            qb_total_amt=125,
            qb_balance=0,
            qb_due_date="2026-08-01",
            qb_txn_date="2026-07-01",
            qb_status_checked_at=_now_iso(minutes=-30),
        )
        before = _links_by_invoice(supabase_admin, seed["job_id"])["INV-STORED"]

        fake = _FakeIntuit(raises=qbservice.QuickBooksReadUnavailable("Intuit is down"))
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", fake)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})

        # 409, not 5xx: an Intuit outage on a menu open is expected third-party
        # downtime, and the Starlette Sentry integration captures 5xx only.
        assert resp.status_code == 409, resp.text
        detail = resp.json()["detail"]
        assert detail["code"] == "qbo_unreachable"
        assert fake.calls == [["INV-STORED"]]  # it really did try

        after = _links_by_invoice(supabase_admin, seed["job_id"])["INV-STORED"]
        assert after == before
    finally:
        _cleanup(supabase_admin, cid)


async def test_status_refused_when_quickbooks_is_not_connected(supabase_admin, seeded_user_a):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)  # the job and all, but no connection
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"] == "QuickBooks Online is not connected."
    finally:
        _cleanup(supabase_admin, cid)


async def test_status_refused_when_the_connection_needs_reconnecting(supabase_admin, seeded_user_a):
    """A dead refresh token cannot answer, and the shop's action is to reconnect — so it
    is told that, rather than shown a balance nobody could verify."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    supabase_admin.table("quickbooks_connections").update({"reconnect_required": True}).eq(
        "company_id", cid
    ).execute()
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"] == (
            "Reconnect QuickBooks first — we can't check payments until then."
        )
    finally:
        _cleanup(supabase_admin, cid)


async def test_status_refused_for_a_quickbooks_desktop_company(supabase_admin, seeded_user_a):
    """Desktop keeps the balance on a PC behind the Web Connector, which may be switched
    off — so it gets an honest refusal instead of a multi-second menu open."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_desktop_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 400, resp.text
        assert resp.json()["detail"] == (
            "Payment status needs QuickBooks Online; this company uses QuickBooks Desktop."
        )
    finally:
        _cleanup(supabase_admin, cid)


async def test_invoices_in_another_realm_are_counted_not_queried(
    supabase_admin, seeded_user_a, monkeypatch
):
    """A QBO invoice Id is unique only WITHIN a company file. Querying an id left over
    from a previous realm can come back as a DIFFERENT invoice carrying the same number,
    so those links are counted for the UI to explain and never asked about."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        _seed_link(supabase_admin, cid, seed, "INV-CURRENT")
        _seed_link(supabase_admin, cid, seed, "INV-OLD-REALM", realm_id="realm-previous")

        fake = _FakeIntuit({"INV-CURRENT": _fact("125.00", "0.00")})
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", fake)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 200, resp.text
        body = resp.json()

        # The foreign id never reached the boundary — _FakeIntuit would have refused it —
        # and it is not in the answer either.
        assert fake.calls == [["INV-CURRENT"]]
        assert body["skipped_other_realm"] == 1
        assert [r["qb_invoice_id"] for r in body["invoices"]] == ["INV-CURRENT"]

        stored = _links_by_invoice(supabase_admin, seed["job_id"])
        assert stored["INV-CURRENT"]["qb_status"] == "paid"
        assert stored["INV-OLD-REALM"]["qb_status"] is None
        assert stored["INV-OLD-REALM"]["qb_status_checked_at"] is None
    finally:
        _cleanup(supabase_admin, cid)


async def test_a_fresh_answer_asks_quickbooks_nothing(supabase_admin, seeded_user_a, monkeypatch):
    """A second menu open inside the freshness window costs one Supabase read and no
    Intuit call — which is what makes checking automatically affordable at all. The
    stored rows still come back; `checked: false` is not an empty answer."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        _seed_link(
            supabase_admin,
            cid,
            seed,
            "INV-FRESH",
            qb_status="paid",
            qb_total_amt=125,
            qb_balance=0,
            qb_status_checked_at=_now_iso(minutes=-1),
        )
        fake = _FakeIntuit({"INV-FRESH": _fact("999.00", "999.00")})
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", fake)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 200, resp.text
        body = resp.json()

        assert fake.calls == []  # the boundary was never touched
        assert body["checked"] is False
        assert body["checked_at"] is None
        (row,) = body["invoices"]
        assert row["qb_status"] == "paid"
        assert float(row["qb_balance"]) == 0
    finally:
        _cleanup(supabase_admin, cid)


async def test_an_invoice_webhook_marker_forces_a_check(supabase_admin, seeded_user_a, monkeypatch):
    """qb_stale_at newer than the last check: an Invoice notification arrived. The
    webhook reads nothing from Intuit itself — this is where that read happens."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        _seed_link(
            supabase_admin,
            cid,
            seed,
            "INV-MARKED",
            qb_status="open",
            qb_total_amt=125,
            qb_balance=125,
            qb_status_checked_at=_now_iso(minutes=-2),
            qb_stale_at=_now_iso(minutes=-1),
        )
        fake = _FakeIntuit({"INV-MARKED": _fact("125.00", "0.00")})
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", fake)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 200, resp.text
        assert fake.calls == [["INV-MARKED"]]
        assert resp.json()["checked"] is True
        assert _links_by_invoice(supabase_admin, seed["job_id"])["INV-MARKED"]["qb_status"] == "paid"
    finally:
        _cleanup(supabase_admin, cid)


async def test_a_realm_wide_webhook_marker_forces_a_check(
    supabase_admin, seeded_user_a, monkeypatch
):
    """A Payment or CreditMemo notification names only the payment, so the webhook marks
    the whole realm stale rather than resolving it to invoices — resolving would need an
    Intuit read inside a handler that must stay a pure DB write."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    supabase_admin.table("quickbooks_connections").update(
        {"qb_invoices_stale_since": _now_iso(minutes=-1)}
    ).eq("company_id", cid).execute()
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        _seed_link(
            supabase_admin,
            cid,
            seed,
            "INV-REALM-MARKED",
            qb_status="open",
            qb_total_amt=125,
            qb_balance=125,
            qb_status_checked_at=_now_iso(minutes=-2),
        )
        fake = _FakeIntuit({"INV-REALM-MARKED": _fact("125.00", "60.00")})
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", fake)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 200, resp.text
        assert fake.calls == [["INV-REALM-MARKED"]]
        stored = _links_by_invoice(supabase_admin, seed["job_id"])["INV-REALM-MARKED"]
        assert stored["qb_status"] == "partial"
        assert float(stored["qb_balance"]) == 60
    finally:
        _cleanup(supabase_admin, cid)


async def test_an_answer_older_than_the_age_bound_forces_a_check(
    supabase_admin, seeded_user_a, monkeypatch
):
    """The age bound is what covers a webhook that never arrived — wrong host, retries
    exhausted, subscription lapsed — without polling anything."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        _seed_link(
            supabase_admin,
            cid,
            seed,
            "INV-AGED",
            qb_status="open",
            qb_total_amt=125,
            qb_balance=125,
            # Read off the service constant, so moving the bound moves this test with it.
            qb_status_checked_at=_now_iso(minutes=-(qbservice.INVOICE_STATUS_MAX_AGE_MINUTES + 1)),
        )
        fake = _FakeIntuit({"INV-AGED": _fact("125.00", "0.00")})
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", fake)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 200, resp.text
        assert fake.calls == [["INV-AGED"]]
        assert _links_by_invoice(supabase_admin, seed["job_id"])["INV-AGED"]["qb_status"] == "paid"
    finally:
        _cleanup(supabase_admin, cid)


async def test_a_voided_invoice_reopens_the_quantity_and_the_re_push_succeeds(
    supabase_admin, seeded_user_a, monkeypatch
):
    """The behaviour the owner asked for, end to end.

    Bill 6 then 4 of 10 (the progressive shape of test_two_invoices_bill_remaining), so
    the part is fully_invoiced. Voiding the first invoice IN QUICKBOOKS must give those
    6 back: apply_qbo_invoice_mirror stamps voided_at, which fires
    trigger_recompute_jp_invoicing_on_link, and the part reopens to partially_invoiced —
    4 still billed. Then the 6 can be billed again, which is the half that proves the
    quantity really came back rather than only the label."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    _map_customer(supabase_admin, cid, seed["customer_id"])
    _seed_shipment(supabase_admin, cid, seed["customer_id"], seed["job_id"], seed["job_part_id"], 10)
    pushes = _fake_pushes(monkeypatch)
    try:
        assert (await _push(seeded_user_a["access_token"], cid, seed, 6)).status_code == 200
        assert (await _push(seeded_user_a["access_token"], cid, seed, 4)).status_code == 200
        assert _invoicing_status(supabase_admin, seed["job_part_id"]) == "fully_invoiced"

        # QBO does not delete a voided invoice; it zeroes the total and keeps the
        # number. Jigged billed 75.00 on INV-1, so a zero total is a void over there.
        fake = _FakeIntuit({"INV-1": _fact("0.00", "0.00"), "INV-2": _fact("50.00", "50.00")})
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", fake)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 200, resp.text

        stored = _links_by_invoice(supabase_admin, seed["job_id"])
        assert stored["INV-1"]["qb_status"] == "voided"
        assert stored["INV-1"]["voided_at"] is not None
        assert stored["INV-1"]["voided_by"] is None  # mirror-owned, not a human void
        assert stored["INV-2"]["qb_status"] == "open"
        assert stored["INV-2"]["voided_at"] is None
        assert _invoicing_status(supabase_admin, seed["job_part_id"]) == "partially_invoiced"

        # The 6 are billable again — 4 + 6 = 10, back to fully_invoiced.
        repush = await _push(seeded_user_a["access_token"], cid, seed, 6)
        assert repush.status_code == 200, repush.text
        assert repush.json()["already_existed"] is False
        assert pushes["n"] == 3
        assert _invoicing_status(supabase_admin, seed["job_part_id"]) == "fully_invoiced"
    finally:
        _cleanup(supabase_admin, cid)


async def test_a_missing_invoice_reopens_the_quantity_the_same_way(
    supabase_admin, seeded_user_a, monkeypatch
):
    """An invoice DELETED in QuickBooks releases its quantity exactly as a void does.

    A None fact is what fetch_invoice_facts returns only after an id was absent from two
    consecutive SUCCESSFUL queries; the amounts go to NULL because there are none to
    report for an invoice that is not there."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    _map_customer(supabase_admin, cid, seed["customer_id"])
    _seed_shipment(supabase_admin, cid, seed["customer_id"], seed["job_id"], seed["job_part_id"], 10)
    _fake_pushes(monkeypatch)
    try:
        assert (await _push(seeded_user_a["access_token"], cid, seed, 6)).status_code == 200
        assert (await _push(seeded_user_a["access_token"], cid, seed, 4)).status_code == 200
        assert _invoicing_status(supabase_admin, seed["job_part_id"]) == "fully_invoiced"

        fake = _FakeIntuit({"INV-1": None, "INV-2": _fact("50.00", "0.00")})
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", fake)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 200, resp.text

        stored = _links_by_invoice(supabase_admin, seed["job_id"])
        assert stored["INV-1"]["qb_status"] == "missing"
        assert stored["INV-1"]["qb_total_amt"] is None
        assert stored["INV-1"]["qb_balance"] is None
        assert stored["INV-1"]["voided_at"] is not None
        assert stored["INV-2"]["qb_status"] == "paid"
        assert _invoicing_status(supabase_admin, seed["job_part_id"]) == "partially_invoiced"
    finally:
        _cleanup(supabase_admin, cid)


async def test_an_invoice_that_comes_back_re_locks_the_quantity(
    supabase_admin, seeded_user_a, monkeypatch
):
    """A void undone in QuickBooks must re-lock the quantity, or the shop could bill the
    same parts twice. Only a MIRROR-owned voided_at is cleared, which is why the voided
    rows stay in the batch instead of being filtered out of it."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    _map_customer(supabase_admin, cid, seed["customer_id"])
    _seed_shipment(supabase_admin, cid, seed["customer_id"], seed["job_id"], seed["job_part_id"], 10)
    _fake_pushes(monkeypatch)
    try:
        assert (await _push(seeded_user_a["access_token"], cid, seed, 10)).status_code == 200

        voided = _FakeIntuit({"INV-1": _fact("0.00", "0.00")})
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", voided)
        first = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert first.status_code == 200, first.text
        link_id = _links_by_invoice(supabase_admin, seed["job_id"])["INV-1"]["id"]
        assert _invoicing_status(supabase_admin, seed["job_part_id"]) == "uninvoiced"

        # Un-voiding it in QuickBooks sends an Invoice notification, and that marker is
        # what makes the next menu open ask again — without one, a second open inside
        # the freshness window is deliberately answered from store.
        supabase_admin.table("quickbooks_invoice_links").update({"qb_stale_at": _now_iso()}).eq(
            "id", link_id
        ).execute()

        back = _FakeIntuit({"INV-1": _fact("125.00", "125.00")})
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", back)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 200, resp.text
        assert back.calls == [["INV-1"]]

        stored = _links_by_invoice(supabase_admin, seed["job_id"])["INV-1"]
        assert stored["qb_status"] == "open"
        assert stored["voided_at"] is None
        assert _invoicing_status(supabase_admin, seed["job_part_id"]) == "fully_invoiced"
    finally:
        _cleanup(supabase_admin, cid)


async def test_a_human_void_is_never_touched_by_the_mirror(
    supabase_admin, seeded_user_a, monkeypatch
):
    """voided_by is what tells voided_at's two owners apart. A row a person voided in
    Jigged is filtered out of apply_qbo_invoice_mirror entirely — the mirror can neither
    undo that void nor date a status onto it — and the response says so, because the
    rows it returns are re-selected after the write rather than assembled from what we
    hoped to store."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        human_void_at = _now_iso(minutes=-5)
        _seed_link(
            supabase_admin,
            cid,
            seed,
            "INV-HUMAN-VOID",
            voided_at=human_void_at,
            voided_by=seeded_user_a["user_id"],
        )
        fake = _FakeIntuit({"INV-HUMAN-VOID": _fact("125.00", "0.00")})
        monkeypatch.setattr(qbservice, "fetch_invoice_facts", fake)
        resp = await _post(seeded_user_a["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 200, resp.text
        (row,) = resp.json()["invoices"]
        assert row["qb_status"] is None

        stored = _links_by_invoice(supabase_admin, seed["job_id"])["INV-HUMAN-VOID"]
        assert stored["qb_status"] is None
        assert stored["qb_status_checked_at"] is None
        assert stored["qb_balance"] is None
        assert datetime.fromisoformat(stored["voided_at"]) == datetime.fromisoformat(human_void_at)
    finally:
        _cleanup(supabase_admin, cid)


async def test_an_older_reading_never_overwrites_a_newer_one(supabase_admin, seeded_user_a):
    """Two passes overlap whenever two people open the same job, or a menu open races the
    backfill script. Without the monotonic guard the slower Intuit response wins and a
    paid invoice flips back to open. The RPC is driven directly because that is the only
    way to put the two answers in a deterministic order."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        link = _seed_link(supabase_admin, cid, seed, "INV-RACE")
        newer = datetime.now(timezone.utc)
        older = newer - timedelta(minutes=5)

        def _apply(checked_at, status, balance):
            return supabase_admin.rpc(
                "apply_qbo_invoice_mirror",
                {
                    "p_company_id": cid,
                    "p_realm_id": "realm-rt",
                    "p_checked_at": checked_at.isoformat(),
                    "p_rows": [
                        {
                            "link_id": link["id"],
                            "status": status,
                            "total_amt": "125.00",
                            "balance": balance,
                            "due_date": None,
                            "txn_date": None,
                        }
                    ],
                },
            ).execute()

        assert _apply(newer, "paid", "0.00").data == 1
        # The older read lands second and must change nothing at all.
        assert _apply(older, "open", "125.00").data == 0

        stored = _links_by_invoice(supabase_admin, seed["job_id"])["INV-RACE"]
        assert stored["qb_status"] == "paid"
        assert float(stored["qb_balance"]) == 0
        assert datetime.fromisoformat(stored["qb_status_checked_at"]) == newer
    finally:
        _cleanup(supabase_admin, cid)


async def test_invoice_status_is_denied_to_a_non_member(
    supabase_admin, seeded_user_a, seeded_user_b
):
    """Everything else about this company is in order — connected, a real job — so
    membership is the only thing the 403 can be attributable to."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    try:
        resp = await _post(seeded_user_b["access_token"], _status_path(cid, seed["job_id"]), {})
        assert resp.status_code == 403, resp.text
    finally:
        _cleanup(supabase_admin, cid)


# ───────────────── reconnecting to a different QuickBooks company ─────────────────
#
# The authorize screen grants access for whichever Intuit account is signed into
# the browser, and Intuit offers a brand new trial company to a signer who has
# none — so the realm coming back is not necessarily the realm that went out.
# persist_connection overwrites realm_id unconditionally, so before the guard an
# accidental sign-in silently repointed the shop at an empty company file while
# every invoice link and customer mapping stayed bound to the old one.


def _mint_callback_state(company_id: str, user_id: str) -> str:
    import routes.quickbooks_routes as qbr

    return qbr._mint_state(company_id, user_id)


async def _callback(state: str, realm_id: str):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as ac:
        return await ac.get(
            "/api/quickbooks/callback",
            params={"state": state, "code": "auth-code", "realmId": realm_id},
            follow_redirects=False,
        )


def _fake_token_exchange(monkeypatch, revoked: list):
    """Stub the Intuit calls the callback makes, and record any revoke."""
    import routes.quickbooks_routes as qbr

    bundle = SimpleNamespace(
        access_token="AT-new",
        access_expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        refresh_token="RT-new",
        refresh_expires_at=datetime.now(timezone.utc) + timedelta(days=100),
    )
    monkeypatch.setattr(qbr.qb, "exchange_code_for_tokens", lambda code: bundle)
    monkeypatch.setattr(qbr.qb, "revoke_token", lambda token: revoked.append(token))
    # The company-name lookup is best-effort in the route; make it a no-op so a
    # test failure can only come from the guard.
    monkeypatch.setattr(
        qbr.qb, "qb_request", lambda *a, **k: {"CompanyInfo": {"CompanyName": "Other Co"}}
    )
    return bundle


async def test_reconnect_to_a_different_realm_is_refused_when_history_exists(
    supabase_admin, seeded_user_a, monkeypatch
):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    _map_customer(supabase_admin, cid, seed["customer_id"])
    revoked: list = []
    _fake_token_exchange(monkeypatch, revoked)
    try:
        resp = await _callback(_mint_callback_state(cid, seeded_user_a["user_id"]), "realm-OTHER")

        assert resp.status_code == 302
        assert "qb=realm_mismatch" in resp.headers["location"]

        # The connection is untouched: same realm, same tokens. This is the
        # assertion that matters — a redirect with the right word in it would
        # still be a bug if the row had already been overwritten.
        conn = (
            supabase_admin.table("quickbooks_connections")
            .select("realm_id, access_token, refresh_token")
            .eq("company_id", cid)
            .single()
            .execute()
            .data
        )
        assert conn["realm_id"] == "realm-rt"
        assert conn["access_token"] == "AT"
        assert conn["refresh_token"] == "RT"

        # The grant we decided not to keep is handed back, not left live.
        assert revoked == ["RT-new"]
    finally:
        _cleanup(supabase_admin, cid)


async def test_reconnect_to_a_different_realm_is_allowed_when_there_is_no_history(
    supabase_admin, seeded_user_a, monkeypatch
):
    # A shop that connected the WRONG company on its first try must not be
    # trapped: with nothing bound to the old realm there is nothing to strand,
    # so the switch goes through.
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    _fake_token_exchange(monkeypatch, [])
    try:
        resp = await _callback(_mint_callback_state(cid, seeded_user_a["user_id"]), "realm-OTHER")

        assert resp.status_code == 302
        assert "qb=connected" in resp.headers["location"]
        conn = (
            supabase_admin.table("quickbooks_connections")
            .select("realm_id")
            .eq("company_id", cid)
            .single()
            .execute()
            .data
        )
        assert conn["realm_id"] == "realm-OTHER"
    finally:
        _cleanup(supabase_admin, cid)


async def test_reconnecting_the_same_realm_still_works_with_history(
    supabase_admin, seeded_user_a, monkeypatch
):
    # The ordinary case the guard must not break: an expired connection being
    # renewed against the company it was always bound to.
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_quote(supabase_admin, cid, converted=True)
    _map_customer(supabase_admin, cid, seed["customer_id"])
    _fake_token_exchange(monkeypatch, [])
    try:
        resp = await _callback(_mint_callback_state(cid, seeded_user_a["user_id"]), "realm-rt")

        assert resp.status_code == 302
        assert "qb=connected" in resp.headers["location"]
        conn = (
            supabase_admin.table("quickbooks_connections")
            .select("realm_id, access_token, reconnect_required")
            .eq("company_id", cid)
            .single()
            .execute()
            .data
        )
        assert conn["realm_id"] == "realm-rt"
        assert conn["access_token"] == "AT-new"
        assert conn["reconnect_required"] is False
    finally:
        _cleanup(supabase_admin, cid)
