"""Route-level integration tests for the QuickBooks Desktop push path.

The Conductor HTTP boundary is mocked; everything else -- auth, the idempotency
claim, the link and line-item rows, the invoicing_status triggers and the
over-invoice backstop -- runs against a real local Supabase.

These cover the three branches that exist ONLY because Conductor has no
idempotency mechanism, each of which is a way to bill a customer twice if it is
wrong:

  * an ambiguous create parks as 'needs_verification' and is never auto-retried
  * that link blocks a further invoice on the same job
  * an errored link is reclaimed in place, because the retry reuses its request_id

Requires a local Supabase with this branch's migrations applied:
    supabase start && supabase db reset
    TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY / TEST_SUPABASE_SECRET_KEY set.
"""
from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.quickbooks_desktop as qbdservice  # noqa: E402
from index import app  # noqa: E402

pytestmark = pytest.mark.integration

END_USER = "end_usr_rt_test"


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
    monkeypatch.delenv("QUICKBOOKS_FAKE", raising=False)
    # Reference-data reads that would otherwise hit Conductor. The tax code is the
    # one QBD sends on every line; None keeps these payloads simple.
    monkeypatch.setattr(qbdservice, "customer_tax_code_id", lambda *a, **k: None)
    monkeypatch.setattr(qbdservice, "resolve_term_id", lambda *a, **k: None)


def _cleanup(admin, company_id: str) -> None:
    for table in (
        "quickbooks_invoice_links",
        "quickbooks_customer_map",
        "quickbooks_desktop_connections",
        "quickbooks_connections",
        "shipments",
        "job_parts",
        "jobs",
        "parts",
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
            # Pre-resolved so resolve_default_item never calls out.
            "default_service_item_id": "80000010-1000000000",
            "default_income_account_id": "170000-933270541",
        }
    ).execute()


def _seed_job(admin, company_id: str, qty: float = 10) -> dict:
    customer = admin.table("customers").insert(
        {"company_id": company_id, "name": "QBD RT Customer"}
    ).execute().data[0]
    part = admin.table("parts").insert(
        {"company_id": company_id, "part_name": "QBD-RT-1",
         "primary_unit": "each", "source": "made"}
    ).execute().data[0]
    job = admin.table("jobs").insert(
        {"company_id": company_id, "customer_id": customer["id"],
         "job_number": f"J-QBD-{uuid4().hex[:6]}", "production_status": "not_started",
         "fulfillment_status": "unshipped"}
    ).execute().data[0]
    job_part = admin.table("job_parts").insert(
        {"company_id": company_id, "job_id": job["id"], "part_id": part["id"],
         "sequence": 0, "quantity": qty, "unit_price": 12.5, "total_price": 12.5 * qty,
         "production_status": "not_started", "fulfillment_status": "unshipped"}
    ).execute().data[0]
    admin.table("quickbooks_customer_map").insert(
        {"company_id": company_id, "customer_id": customer["id"], "realm_id": END_USER,
         "provider": "qbd", "qb_customer_id": "QBD-CUST-1"}
    ).execute()
    return {"customer_id": customer["id"], "job_id": job["id"],
            "job_part_id": job_part["id"]}


async def _post(token: str, path: str, body: dict):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver",
                           headers={"Authorization": f"Bearer {token}"}) as ac:
        return await ac.post(path, json=body)


def _links(admin, company_id: str) -> list[dict]:
    return admin.table("quickbooks_invoice_links").select("*").eq(
        "company_id", company_id
    ).execute().data or []


def _line_items(admin, link_id: str) -> list[dict]:
    return admin.table("quickbooks_invoice_line_items").select("*").eq(
        "invoice_link_id", link_id
    ).execute().data or []


def _body(job_part_id: str, qty: float, request_id: str) -> dict:
    return {
        "customer": {"action": "use_existing", "qb_customer_id": "QBD-CUST-1"},
        "request_id": request_id,
        "lines": [{"job_part_id": job_part_id, "quantity": qty}],
        "transaction_date": datetime.now(timezone.utc).date().isoformat(),
    }


# ───────────────────────── the happy path ─────────────────────────
async def test_push_creates_one_invoice_with_no_deep_link(
    supabase_admin, seeded_user_a, monkeypatch
):
    """QuickBooks Desktop has no web app, so url must be null -- the job page
    already renders a non-link row for that."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_job(supabase_admin, cid)
    calls = []
    monkeypatch.setattr(
        qbdservice, "create_invoice",
        lambda eu, payload, *, request_id: calls.append(payload)
        or {"id": "QBD-INV-1", "doc_number": "1100", "sync_token": "1"},
    )
    try:
        resp = await _post(
            seeded_user_a["access_token"],
            f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
            _body(seed["job_part_id"], 4, str(uuid4())),
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["url"] is None
        assert resp.json()["doc_number"] == "1100"

        links = _links(supabase_admin, cid)
        assert len(links) == 1
        assert links[0]["status"] == "created"
        assert links[0]["provider"] == "qbd"
        assert links[0]["realm_id"] == END_USER
        assert len(_line_items(supabase_admin, links[0]["id"])) == 1
        # QuickBooks assigns the number, so we must not send one.
        assert "refNumber" not in calls[0]
    finally:
        _cleanup(supabase_admin, cid)


async def test_double_submit_creates_one_invoice(supabase_admin, seeded_user_a, monkeypatch):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_job(supabase_admin, cid)
    calls = []
    monkeypatch.setattr(
        qbdservice, "create_invoice",
        lambda eu, payload, *, request_id: calls.append(request_id)
        or {"id": "QBD-INV-1", "doc_number": "1100", "sync_token": "1"},
    )
    rid = str(uuid4())
    try:
        first = await _post(seeded_user_a["access_token"],
                            f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                            _body(seed["job_part_id"], 4, rid))
        second = await _post(seeded_user_a["access_token"],
                             f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                             _body(seed["job_part_id"], 4, rid))
        assert first.status_code == 200 and second.status_code == 200
        assert second.json()["already_existed"] is True
        assert len(calls) == 1, "the replay must not reach QuickBooks"
        assert len(_links(supabase_admin, cid)) == 1
    finally:
        _cleanup(supabase_admin, cid)


# ───────────────────────── unknown outcome ─────────────────────────
async def test_unknown_outcome_parks_for_verification_and_counts_nothing(
    supabase_admin, seeded_user_a, monkeypatch
):
    """The invoice may exist. It must not be retried, and its quantity must not
    count until a human confirms it."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_job(supabase_admin, cid)

    def _timeout(*a, **k):
        raise qbdservice.QbdUnknownOutcome("lost contact")

    monkeypatch.setattr(qbdservice, "create_invoice", _timeout)
    monkeypatch.setattr(qbdservice, "find_created_invoice", lambda *a, **k: None)
    try:
        resp = await _post(seeded_user_a["access_token"],
                           f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                           _body(seed["job_part_id"], 4, str(uuid4())))
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "qbd_verify"

        link = _links(supabase_admin, cid)[0]
        assert link["status"] == "needs_verification"
        # The quantities ARE recorded -- they are unreconstructable otherwise --
        # but the status keeps them out of every invoiced-quantity computation.
        assert len(_line_items(supabase_admin, link["id"])) == 1
        job_part = supabase_admin.table("job_parts").select("invoicing_status").eq(
            "id", seed["job_part_id"]
        ).execute().data[0]
        assert job_part["invoicing_status"] == "uninvoiced"
    finally:
        _cleanup(supabase_admin, cid)


async def test_unverified_invoice_blocks_another_push_on_that_job(
    supabase_admin, seeded_user_a, monkeypatch
):
    """Because the parked quantity counts for nothing, the ordered cap would
    otherwise let the same quantity be billed a second time."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_job(supabase_admin, cid)
    monkeypatch.setattr(qbdservice, "create_invoice",
                        lambda *a, **k: (_ for _ in ()).throw(
                            qbdservice.QbdUnknownOutcome("lost contact")))
    monkeypatch.setattr(qbdservice, "find_created_invoice", lambda *a, **k: None)
    try:
        await _post(seeded_user_a["access_token"],
                    f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                    _body(seed["job_part_id"], 4, str(uuid4())))
        blocked = await _post(seeded_user_a["access_token"],
                              f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                              _body(seed["job_part_id"], 4, str(uuid4())))
        assert blocked.status_code == 409
        assert blocked.json()["detail"]["code"] == "qbd_blocked_unverified"
        assert len(_links(supabase_admin, cid)) == 1
    finally:
        _cleanup(supabase_admin, cid)


# ───────────────────────── verify ─────────────────────────
async def test_verify_adopts_an_invoice_that_exists(supabase_admin, seeded_user_a, monkeypatch):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_job(supabase_admin, cid)
    monkeypatch.setattr(qbdservice, "create_invoice",
                        lambda *a, **k: (_ for _ in ()).throw(
                            qbdservice.QbdUnknownOutcome("lost contact")))
    monkeypatch.setattr(qbdservice, "find_created_invoice", lambda *a, **k: None)
    try:
        await _post(seeded_user_a["access_token"],
                    f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                    _body(seed["job_part_id"], 4, str(uuid4())))
        link = _links(supabase_admin, cid)[0]

        # It was there all along.
        monkeypatch.setattr(
            qbdservice, "find_created_invoice",
            lambda *a, **k: {"id": "QBD-INV-9", "doc_number": "1101", "sync_token": "1"},
        )
        resp = await _post(seeded_user_a["access_token"],
                           f"/api/quickbooks/{cid}/invoices/{link['id']}/verify", {})
        assert resp.status_code == 200, resp.text
        assert resp.json()["outcome"] == "adopted"
        assert resp.json()["qb_invoice_id"] == "QBD-INV-9"

        after = _links(supabase_admin, cid)[0]
        assert after["status"] == "created"
        # Now that it is 'created', the quantity counts.
        job_part = supabase_admin.table("job_parts").select("invoicing_status").eq(
            "id", seed["job_part_id"]
        ).execute().data[0]
        assert job_part["invoicing_status"] == "partially_invoiced"

        # Adopting twice records the invoice once.
        again = await _post(seeded_user_a["access_token"],
                            f"/api/quickbooks/{cid}/invoices/{link['id']}/verify", {})
        assert again.status_code == 200
        assert len(_line_items(supabase_admin, link["id"])) == 1
    finally:
        _cleanup(supabase_admin, cid)


async def test_verify_releases_when_the_invoice_never_landed(
    supabase_admin, seeded_user_a, monkeypatch
):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_job(supabase_admin, cid)
    monkeypatch.setattr(qbdservice, "create_invoice",
                        lambda *a, **k: (_ for _ in ()).throw(
                            qbdservice.QbdUnknownOutcome("lost contact")))
    monkeypatch.setattr(qbdservice, "find_created_invoice", lambda *a, **k: None)
    try:
        await _post(seeded_user_a["access_token"],
                    f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                    _body(seed["job_part_id"], 4, str(uuid4())))
        link = _links(supabase_admin, cid)[0]
        resp = await _post(seeded_user_a["access_token"],
                           f"/api/quickbooks/{cid}/invoices/{link['id']}/verify", {})
        assert resp.status_code == 200
        assert resp.json()["outcome"] == "released"
        assert _links(supabase_admin, cid)[0]["status"] == "error"
    finally:
        _cleanup(supabase_admin, cid)


async def test_retry_after_release_creates_exactly_one_new_invoice(
    supabase_admin, seeded_user_a, monkeypatch
):
    """The push dialog's retry reuses the SAME request_id, so the errored row
    still holds it. Without the reclaim branch this collides with
    UNIQUE(realm_id, qb_request_id) and dead-ends."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_job(supabase_admin, cid)
    rid = str(uuid4())
    monkeypatch.setattr(qbdservice, "create_invoice",
                        lambda *a, **k: (_ for _ in ()).throw(
                            qbdservice.QbdUnknownOutcome("lost contact")))
    monkeypatch.setattr(qbdservice, "find_created_invoice", lambda *a, **k: None)
    try:
        await _post(seeded_user_a["access_token"],
                    f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                    _body(seed["job_part_id"], 4, rid))
        link = _links(supabase_admin, cid)[0]
        await _post(seeded_user_a["access_token"],
                    f"/api/quickbooks/{cid}/invoices/{link['id']}/verify", {})
        assert _links(supabase_admin, cid)[0]["status"] == "error"

        creates = []
        monkeypatch.setattr(
            qbdservice, "create_invoice",
            lambda eu, payload, *, request_id: creates.append(request_id)
            or {"id": "QBD-INV-2", "doc_number": "1102", "sync_token": "1"},
        )
        retry = await _post(seeded_user_a["access_token"],
                            f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                            _body(seed["job_part_id"], 4, rid))
        assert retry.status_code == 200, retry.text
        assert len(creates) == 1
        links = _links(supabase_admin, cid)
        assert len(links) == 1, "reclaimed in place, not a second link row"
        assert links[0]["status"] == "created"
        assert links[0]["qb_invoice_id"] == "QBD-INV-2"
        assert len(_line_items(supabase_admin, links[0]["id"])) == 1
    finally:
        _cleanup(supabase_admin, cid)


# ───────────────────────── guards that must still hold ─────────────────────────
async def test_over_invoicing_is_refused(supabase_admin, seeded_user_a, monkeypatch):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_job(supabase_admin, cid, qty=10)
    monkeypatch.setattr(qbdservice, "create_invoice",
                        lambda *a, **k: {"id": "X", "doc_number": "1", "sync_token": "1"})
    try:
        resp = await _post(seeded_user_a["access_token"],
                           f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                           _body(seed["job_part_id"], 11, str(uuid4())))
        assert resp.status_code == 400
        assert _links(supabase_admin, cid) == []
    finally:
        _cleanup(supabase_admin, cid)


async def test_offline_is_a_409_not_a_server_error(supabase_admin, seeded_user_a, monkeypatch):
    """A shop PC being switched off is a warning with a retry, not an error. The
    status code is what keeps it out of Sentry: the Starlette integration
    captures 5xx only."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_job(supabase_admin, cid)
    monkeypatch.setattr(qbdservice, "create_invoice",
                        lambda *a, **k: (_ for _ in ()).throw(
                            qbdservice.QbdOffline("QuickBooks isn't running on the shop PC.")))
    try:
        resp = await _post(seeded_user_a["access_token"],
                           f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice",
                           _body(seed["job_part_id"], 4, str(uuid4())))
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "qbd_offline"
        assert _links(supabase_admin, cid)[0]["status"] == "error"
    finally:
        _cleanup(supabase_admin, cid)


async def test_a_company_cannot_hold_both_providers(supabase_admin, seeded_user_a):
    """Enforced by assert_single_accounting_provider(), not merely by the routes."""
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    try:
        with pytest.raises(Exception) as exc:
            supabase_admin.table("quickbooks_connections").insert(
                {"company_id": cid, "realm_id": "realm-x", "environment": "sandbox",
                 "access_token": "AT", "access_expires_at": "2030-01-01T00:00:00Z",
                 "refresh_token": "RT"}
            ).execute()
        assert "already connected to QuickBooks Desktop" in str(exc.value)
    finally:
        _cleanup(supabase_admin, cid)


async def test_transaction_date_cannot_backdate_into_a_closed_period(
    supabase_admin, seeded_user_a, monkeypatch
):
    cid = seeded_user_a["company_id"]
    _cleanup(supabase_admin, cid)
    _seed_connection(supabase_admin, cid)
    seed = _seed_job(supabase_admin, cid)
    monkeypatch.setattr(qbdservice, "create_invoice",
                        lambda *a, **k: {"id": "X", "doc_number": "1", "sync_token": "1"})
    body = _body(seed["job_part_id"], 4, str(uuid4()))
    body["transaction_date"] = "2020-01-01"
    try:
        resp = await _post(seeded_user_a["access_token"],
                           f"/api/quickbooks/{cid}/jobs/{seed['job_id']}/invoice", body)
        assert resp.status_code == 400
        assert _links(supabase_admin, cid) == []
    finally:
        _cleanup(supabase_admin, cid)
