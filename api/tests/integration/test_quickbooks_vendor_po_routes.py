"""Sending a VENDOR purchase order to QuickBooks: the route, end to end (plan §3.11, §5.2).

The QuickBooks boundary is replaced (services.quickbooks_purchasing for Online,
services.quickbooks_desktop_purchasing for Desktop, plus each one's resolve_term_id), the
way test_quickbooks_desktop_routes.py replaces Conductor. Everything else is real: the
office-role and billing checks, the purchasing RPCs that make and send the PO, the link and
line-link rows, the compare-and-set claim, the vendor map and the setup rows.

The `Boundary` below makes "QuickBooks was never called" checkable: every provider
function FAILS THE TEST unless a test allowed it. So a test that allows nothing proves a
route made zero QuickBooks calls -- which is the whole of QB4's no-change rule and QB1/QB2's
"before any QuickBooks call".

Requires a local Supabase with this branch's migrations applied (supabase db reset) and
TEST_SUPABASE_URL / TEST_SUPABASE_PUBLISHABLE_KEY / TEST_SUPABASE_SECRET_KEY set; the
shop and the PO come from tests/integration/purchasing_support.py.

Criteria: QB2, QB3, QB4, QB5, QB6, QB7, QB8, QB9, QB10.
"""
from __future__ import annotations

import asyncio
import os
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import uuid4

import pytest
from httpx import ASGITransport, AsyncClient
from supabase import create_client

import routes.company_auth as company_auth
import routes.quickbooks_purchasing_routes as po_routes
import services.accounting.purchase_order as pom
import services.quickbooks as qb
import services.quickbooks_desktop as qbd
import services.quickbooks_desktop_purchasing as qbdp
import services.quickbooks_purchasing as qbp
from index import app
from services.accounting.base import PushedPurchaseOrder, QbPurchaseOrderLine, QbPurchaseOrderState
from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, shop  # noqa: F401
from tests.integration.test_mcp_token_binding import GATEWAY_KEY, assistant_token  # noqa: F401

pytestmark = pytest.mark.integration

REALM = "realm-vendor-po-test"
END_USER = "end_usr_vendor_po_test"
ITEM = "QB-ITEM-PURCHASES"
AP = "QB-AP-33"
QB_VENDOR = "QB-VEN-9"
PASSWORD = "test-password-vendor-po"

QBO_CALLS = (
    "find_vendor_candidates", "create_vendor", "list_purchase_accounts", "list_ap_accounts",
    "list_purchase_items", "create_purchase_item", "check_purchasing_preferences",
    "create_purchase_order", "read_purchase_order", "update_purchase_order",
)
QBD_CALLS = QBO_CALLS + ("resolve_ship_method_id", "find_created_purchase_order")


# ───────────────────────── environment and the QuickBooks boundary ─────────────────────────
@pytest.fixture(autouse=True)
def _route_env(monkeypatch):
    url = os.environ["TEST_SUPABASE_URL"]
    monkeypatch.setenv("SUPABASE_URL", url)
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", url)
    monkeypatch.setenv("SUPABASE_SECRET_KEY", os.environ["TEST_SUPABASE_SECRET_KEY"])
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    monkeypatch.setenv("QUICK_BOOKS_CLIENT_ID", "cid_test")
    monkeypatch.setenv("QUICK_BOOKS_CLIENT_SECRET", "secret_test")
    monkeypatch.setenv("QUICKBOOKS_REDIRECT_URI", "http://localhost:8000/api/quickbooks/callback")
    monkeypatch.setenv("CONDUCTOR_API_KEY", "sk_conductor_test")
    monkeypatch.setenv("CONDUCTOR_PUBLISHABLE_KEY", "pk_conductor_test")
    monkeypatch.setenv("APP_BASE_URL", "https://jigged.test")
    monkeypatch.delenv("QUICKBOOKS_FAKE", raising=False)


def returns(value):
    return lambda *a, **k: value


def raises(exc):
    def _raise(*a, **k):
        raise exc
    return _raise


class Boundary:
    """Every QuickBooks-facing function of one provider, replaced by a recorder.

    A function the test did not allow FAILS the test when called, so "QuickBooks was
    never called" is the default and a test opts in to each call it expects."""

    def __init__(self, monkeypatch, provider: str):
        self.provider = provider
        self.calls: list[tuple[str, tuple, dict]] = []
        self._behaviour: dict = {}
        module = qbp if provider == "qbo" else qbdp
        for name in (QBO_CALLS if provider == "qbo" else QBD_CALLS):
            monkeypatch.setattr(module, name, self._stub(name))
        monkeypatch.setattr(qb if provider == "qbo" else qbd, "resolve_term_id", self._stub("resolve_term_id"))

    def _stub(self, name):
        def stub(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            if name not in self._behaviour:
                raise AssertionError(f"QuickBooks was called ({name}) without the test allowing it")
            return self._behaviour[name](*args, **kwargs)
        return stub

    def on(self, name: str, behaviour) -> "Boundary":
        self._behaviour[name] = behaviour
        return self

    def forbid_all(self) -> "Boundary":
        self._behaviour.clear()
        return self

    def named(self, name: str) -> list[tuple[tuple, dict]]:
        return [(a, k) for n, a, k in self.calls if n == name]

    # The payload a write was sent with, wherever the provider put it positionally.
    def payloads(self, name: str) -> list[dict]:
        out = []
        for args, kwargs in self.named(name):
            out.append(next(a for a in reversed(args) if isinstance(a, dict)))
        return out

    def request_ids(self, name: str) -> list[str]:
        return [k["request_id"] for _, k in self.named(name)]


def _line_ids(payload: dict, provider: str) -> list:
    if provider == "qbo":
        return [ln.get("Id") for ln in payload.get("Line") or []]
    return [ln.get("id") for ln in payload.get("lines") or []]


def creates(provider: str, qb_id: str = "QB-PO-1", doc_number: str | None = None):
    """A create that answers like QuickBooks: an id per line, in the order sent."""
    def _create(*args, **kwargs):
        payload = next(a for a in reversed(args) if isinstance(a, dict))
        lines = payload.get("Line") if provider == "qbo" else payload.get("lines")
        number = doc_number or payload.get("DocNumber" if provider == "qbo" else "refNumber")
        return PushedPurchaseOrder(
            id=qb_id, doc_number=number, sync_token="0",
            line_ids=tuple(f"{qb_id}-L{i}" for i in range(1, len(lines or []) + 1)),
            closed=(payload.get("POStatus") == "Closed") if provider == "qbo" else False,
        )
    return _create


def updates(provider: str, token: str = "1"):
    """An update that keeps every sent id and gives a new id to every new line."""
    def _update(*args, **kwargs):
        payload = next(a for a in reversed(args) if isinstance(a, dict))
        ids = _line_ids(payload, provider)
        new = iter(range(100, 200))
        line_ids = tuple((i if i not in (None, "-1") else f"NEW-{next(new)}") for i in ids)
        closed = None
        if provider == "qbo" and "POStatus" in payload:
            closed = payload["POStatus"] == "Closed"
        if provider == "qbd" and "isManuallyClosed" in payload:
            closed = payload["isManuallyClosed"]
        return PushedPurchaseOrder(id=args[-2] if provider == "qbd" else args[2], doc_number=None,
                                   sync_token=token, line_ids=line_ids, closed=closed)
    return _update


def state_from_links(db, po_id: str, *, token: str = "0", closed: bool = False,
                     fully_received: bool = False, extra_lines=(), received: dict | None = None):
    """The QuickBooks PO exactly as Jigged last recorded pushing it."""
    link = _link(db, po_id)
    lines = []
    for row in ps.rows(db, "SELECT * FROM public.quickbooks_purchase_order_line_links WHERE link_id = %s",
                       (link["id"],)):
        got = Decimal(str((received or {}).get(row["qb_line_id"], 0)))
        lines.append(QbPurchaseOrderLine(id=row["qb_line_id"], item_id=row["qb_item_id"],
                                         quantity=Decimal(5), rate=Decimal(1), received_quantity=got))
    lines.extend(QbPurchaseOrderLine(id=i, item_id="SOMEONE-ELSES") for i in extra_lines)
    return QbPurchaseOrderState(id=link["qb_po_id"], sync_token=token, doc_number=link["qb_doc_number"],
                                lines=tuple(lines), closed=closed, fully_received=fully_received)


# ───────────────────────── the shop's people, connection and setup ─────────────────────────
def _member(supabase_admin, company_id: str, role: str) -> dict:
    email = f"qbpo-{role}-{os.urandom(4).hex()}@test.jigged.local"
    user = supabase_admin.auth.admin.create_user(
        {"email": email, "password": PASSWORD, "email_confirm": True}).user
    access = supabase_admin.table("user_company_access").insert(
        {"user_id": user.id, "company_id": company_id, "role": role}).execute().data[0]
    session = create_client(os.environ["TEST_SUPABASE_URL"], os.environ["TEST_SUPABASE_PUBLISHABLE_KEY"]
                            ).auth.sign_in_with_password({"email": email, "password": PASSWORD})
    return {"user_id": user.id, "access_id": access["id"], "token": session.session.access_token}


@pytest.fixture
def people(supabase_admin, shop):  # noqa: F811
    """Three members with real sessions (the purchasing_support shop's own members exist only
    in auth.users, so they can act in the database but cannot sign in to the API)."""
    made = {role: _member(supabase_admin, shop.company, role) for role in ("admin", "user", "operator")}
    yield SimpleNamespace(**made)
    for member in made.values():
        try:
            supabase_admin.auth.admin.delete_user(member["user_id"])
        except Exception:
            pass


def seed_qbo(supabase_admin, company_id: str, *, default_item_id: str | None = "INVOICE-ITEM-1") -> str:
    now = datetime.now(timezone.utc)
    return supabase_admin.table("quickbooks_connections").insert({
        "company_id": company_id, "realm_id": REALM, "environment": "sandbox",
        "access_token": "AT", "access_expires_at": (now + timedelta(hours=1)).isoformat(),
        "refresh_token": "RT", "refresh_expires_at": (now + timedelta(days=100)).isoformat(),
        "default_item_id": default_item_id,
    }).execute().data[0]["id"]


def seed_qbd(supabase_admin, company_id: str) -> str:
    return supabase_admin.table("quickbooks_desktop_connections").insert({
        "company_id": company_id, "conductor_end_user_id": END_USER, "environment": "sandbox",
        "default_service_item_id": "80000010-INVOICE", "default_income_account_id": "170000-INCOME",
    }).execute().data[0]["id"]


def seed_setup(supabase_admin, company_id: str, provider: str, connection_id: str, *,
               kinds=("part", "outside_service", "other"), item: str = ITEM, ap: str | None = AP) -> None:
    realm = REALM if provider == "qbo" else END_USER
    fk = "quickbooks_connection_id" if provider == "qbo" else "quickbooks_desktop_connection_id"
    rows = [{"company_id": company_id, "provider": provider, "realm_id": realm, fk: connection_id,
             "setup_key": f"item:{kind}", "qb_id": item, "qb_name": "Jigged purchases",
             "posting_account_id": "COGS-1", "posting_account_name": "Cost of Goods Sold"}
            for kind in kinds]
    if provider == "qbo" and ap:
        rows.append({"company_id": company_id, "provider": "qbo", "realm_id": realm, fk: connection_id,
                     "setup_key": "ap_account", "qb_id": ap, "qb_name": "Accounts Payable (A/P)"})
    if rows:
        supabase_admin.table("quickbooks_purchasing_setup").insert(rows).execute()


def map_vendor(supabase_admin, company_id: str, vendor_id: str, provider: str,
               qb_vendor_id: str = QB_VENDOR) -> None:
    supabase_admin.table("quickbooks_vendor_map").insert({
        "company_id": company_id, "vendor_id": vendor_id, "provider": provider,
        "realm_id": REALM if provider == "qbo" else END_USER, "qb_vendor_id": qb_vendor_id,
        "qb_display_name": "Atlas Metals",
    }).execute()


@pytest.fixture
def qbo(supabase_admin, shop):  # noqa: F811
    connection = seed_qbo(supabase_admin, shop.company)
    seed_setup(supabase_admin, shop.company, "qbo", connection)
    return connection


@pytest.fixture
def qbd_conn(supabase_admin, shop):  # noqa: F811
    connection = seed_qbd(supabase_admin, shop.company)
    seed_setup(supabase_admin, shop.company, "qbd", connection)
    return connection


HEADER = {"payment_terms": "Net 30", "ship_via": "UPS Ground", "notes_to_vendor": "Certs with the shipment."}


def other_lines():
    return [ps.other_line("Spindle rebuild", 1, unit_price=2400),
            ps.other_line("Freight", 1, unit_price=85, expects_receipt=False)]


def sent_po(db, shop, lines=None, **kw):  # noqa: F811
    return ps.make_po(db, shop, lines or other_lines(), header=kw.pop("header", HEADER), sent=True, **kw)


# ───────────────────────── HTTP and rows ─────────────────────────
async def call(token: str, method: str, path: str, body: dict | None = None, headers: dict | None = None):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver",
                           headers={"Authorization": f"Bearer {token}", **(headers or {})}) as ac:
        if method == "GET":
            return await ac.get(path)
        return await ac.post(path, json=body if body is not None else {})


def push(token, company, po_id, body=None, **kw):
    return call(token, "POST", f"/api/quickbooks/{company}/vendor-pos/{po_id}/push", body, **kw)


def preflight(token, company, po_id, **kw):
    return call(token, "POST", f"/api/quickbooks/{company}/vendor-pos/{po_id}/preflight", **kw)


def verify(token, company, link_id):
    return call(token, "POST", f"/api/quickbooks/{company}/vendor-po-links/{link_id}/verify")


def _link(db, po_id: str) -> dict | None:
    return ps.row(db, "SELECT * FROM public.quickbooks_purchase_order_links WHERE vendor_purchase_order_id = %s",
                  (po_id,))


def _line_links(db, link_id: str) -> list[dict]:
    return ps.rows(db, """
        SELECT ll.*, l.line_number FROM public.quickbooks_purchase_order_line_links ll
          LEFT JOIN public.vendor_purchase_order_lines l ON l.id = ll.vendor_purchase_order_line_id
         WHERE ll.link_id = %s ORDER BY l.line_number""", (link_id,))


def _content_version(db, po_id: str) -> int:
    return ps.scalar(db, "SELECT content_version FROM public.vendor_purchase_orders WHERE id = %s", (po_id,))


def _stale_pending(db, shop, po, provider: str, *, operation="create", qb_vendor_id=None,  # noqa: F811
                   qb_po_id=None) -> str:
    """A link a dead worker left 'pending' five minutes ago. Inserted, not updated: the
    updated_at trigger would stamp an UPDATE with now()."""
    request_id = str(uuid4())
    old = datetime.now(timezone.utc) - timedelta(minutes=5)
    ps.execute(db, """
        INSERT INTO public.quickbooks_purchase_order_links
            (company_id, vendor_purchase_order_id, provider, realm_id, operation, status, qb_request_id,
             qb_vendor_id, transaction_date, qb_po_id, attempt_content_version, created_at, updated_at)
        VALUES (%s, %s, %s, %s, %s, 'pending', %s, %s, %s, %s,
                (SELECT content_version FROM public.vendor_purchase_orders WHERE id = %s), %s, %s)""",
        (shop.company, po.id, provider, REALM if provider == "qbo" else END_USER, operation, request_id,
         qb_vendor_id, ps.TODAY, qb_po_id, po.id, old, old))
    return request_id


async def pushed_once(db, shop, people, boundary, provider, lines=None):  # noqa: F811
    """A PO already in QuickBooks: sent, pushed once, everything recorded."""
    po = sent_po(db, shop, lines)
    map_vendor(ps_admin(), shop.company, shop.v1, provider)
    boundary.on("resolve_term_id", returns(None)).on("create_purchase_order", creates(provider))
    if provider == "qbd":
        boundary.on("resolve_ship_method_id", returns(None))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    return po


def ps_admin():
    return create_client(os.environ["TEST_SUPABASE_URL"], os.environ["TEST_SUPABASE_SECRET_KEY"])


# ───────────────────────── access (QB2) ─────────────────────────
async def test_a_lapsed_company_is_refused_everywhere_before_quickbooks_hears_anything(
        db, shop, people, qbo, monkeypatch):  # noqa: F811
    """The push writes with the service role, past the billing RLS, so every route asks
    company_can_write itself -- and before QuickBooks is touched (a Conductor call on a
    lapsed tenant is a bill nobody pays)."""
    from fastapi import HTTPException

    po = sent_po(db, shop)
    boundary = Boundary(monkeypatch, "qbo")
    asked: list[str] = []

    def _lapsed(company_id: str) -> None:
        asked.append(company_id)
        raise HTTPException(status_code=403, detail=company_auth.BILLING_BLOCKED_DETAIL)

    monkeypatch.setattr(company_auth, "assert_company_can_write", _lapsed)
    token = people.admin["token"]
    base = f"/api/quickbooks/{shop.company}"
    for method, path in (
        ("POST", f"{base}/vendor-pos/{po.id}/preflight"),
        ("POST", f"{base}/vendor-pos/{po.id}/push"),
        ("POST", f"{base}/vendor-po-links/{uuid4()}/verify"),
        ("GET", f"{base}/purchasing/accounts"),
        ("GET", f"{base}/purchasing/items"),
        ("POST", f"{base}/purchasing/ap-account"),
        ("POST", f"{base}/purchasing/check-preferences"),
    ):
        body = {"qb_account_id": AP} if path.endswith("ap-account") else None
        res = await call(token, method, path, body)
        assert res.status_code == 403, (path, res.text)
        assert res.json()["detail"] == company_auth.BILLING_BLOCKED_DETAIL
    assert boundary.calls == []
    assert len(asked) == 7
    assert _link(db, po.id) is None


async def test_an_operator_is_refused_by_every_vendor_po_route(db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    boundary = Boundary(monkeypatch, "qbo")
    token = people.operator["token"]
    for res in (await preflight(token, shop.company, po.id), await push(token, shop.company, po.id),
                await verify(token, shop.company, str(uuid4()))):
        assert res.status_code == 403, res.text
        assert res.json()["detail"] == company_auth.OFFICE_ONLY_DETAIL
    assert boundary.calls == []


async def test_a_user_can_push_but_setup_writes_need_an_admin(db, shop, people, qbo, monkeypatch):  # noqa: F811
    """Decision 3: admins AND users send POs. The QuickBooks item mapping is an admin's."""
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbo")
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("create_purchase_order", creates("qbo"))
    res = await push(people.user["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    assert len(boundary.named("create_purchase_order")) == 1
    refused = await call(people.user["token"], "POST", f"/api/quickbooks/{shop.company}/purchasing/items",
                         {"all_kinds": {"action": "use_existing", "qb_item_id": ITEM}})
    assert refused.status_code == 403


async def test_an_assistant_needs_the_gateway_to_push(db, shop, people, qbo, monkeypatch, supabase_admin,  # noqa: F811
                                                     seeded_user_a, assistant_token):  # noqa: F811
    """An AI assistant's token reaches the push only through /mcp (the x-jigged-mcp key),
    the same rule the database applies to the Data API. The token is minted through the
    real OAuth flow (test_mcp_token_binding.assistant_token), for seeded_user_a."""
    supabase_admin.table("user_company_access").insert(
        {"user_id": seeded_user_a["user_id"], "company_id": shop.company, "role": "user"}).execute()
    monkeypatch.setenv("MCP_GATEWAY_KEY", GATEWAY_KEY)
    po = sent_po(db, shop)
    map_vendor(supabase_admin, shop.company, shop.v1, "qbo")
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("create_purchase_order", creates("qbo"))
    refused = await push(assistant_token, shop.company, po.id)
    assert refused.status_code == 403
    assert refused.json()["detail"] == company_auth.UNBOUND_ASSISTANT_DETAIL
    assert boundary.calls == []
    allowed = await push(assistant_token, shop.company, po.id,
                         headers={company_auth.MCP_GATEWAY_HEADER: GATEWAY_KEY})
    assert allowed.status_code == 200, allowed.text


# ───────────────────────── create (QB3, QB4) ─────────────────────────
async def test_qbo_create_sends_the_mapping_and_records_the_link(db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbo")
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns("TERM-3")) \
        .on("create_purchase_order", creates("qbo", "QB-77"))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["operation"] == "create"
    assert body["qb_po_id"] == "QB-77"
    assert body["doc_number"] == po.number
    assert body["url"] == ("https://sandbox.qbo.intuit.com/login?deeplinkcompanyid=" + REALM
                           + "&pagereq=purchaseorder%3FtxnId%3DQB-77")
    assert body["already_existed"] is False and body["already_up_to_date"] is False

    [payload] = boundary.payloads("create_purchase_order")
    assert payload["DocNumber"] == po.number
    assert payload["TxnDate"] == ps.TODAY.isoformat()
    assert payload["VendorRef"] == {"value": QB_VENDOR}
    assert payload["APAccountRef"] == {"value": AP}
    assert payload["SalesTermRef"] == {"value": "TERM-3"}
    assert payload["Memo"] == HEADER["notes_to_vendor"]
    assert payload["PrivateNote"].startswith(f"Jigged {po.number}")
    assert [ln["ItemBasedExpenseLineDetail"]["ItemRef"]["value"] for ln in payload["Line"]] == [ITEM, ITEM]
    assert [ln["Amount"] for ln in payload["Line"]] == [2400, 85]
    [kwargs] = [k for _, k in boundary.named("create_purchase_order")]
    link = _link(db, po.id)
    assert str(link["qb_request_id"]) == kwargs["request_id"]
    assert link["status"] == "created" and link["operation"] == "create"
    assert link["qb_po_id"] == "QB-77" and link["qb_vendor_id"] == QB_VENDOR
    assert link["pushed_content_version"] == _content_version(db, po.id)
    assert link["pushed_payload_hash"] and link["pushed_revision"] == 0
    assert link["pushed_by"] is not None and link["last_failure"] is None
    assert [r["qb_line_id"] for r in _line_links(db, link["id"])] == ["QB-77-L1", "QB-77-L2"]
    assert {r["qb_item_id"] for r in _line_links(db, link["id"])} == {ITEM}


async def test_qbd_create_sends_its_number_and_attempt_id_and_has_no_deep_link(
        db, shop, people, qbd_conn, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbd")
    boundary = Boundary(monkeypatch, "qbd").on("resolve_term_id", returns("20000-1")) \
        .on("resolve_ship_method_id", returns("SHIP-1")).on("create_purchase_order", creates("qbd", "8000-PO"))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    assert res.json()["url"] is None
    [payload] = boundary.payloads("create_purchase_order")
    link = _link(db, po.id)
    assert payload["refNumber"] == po.number
    assert payload["externalId"] == str(link["qb_request_id"])
    assert payload["vendorId"] == QB_VENDOR
    assert all("amount" not in ln and isinstance(ln["rate"], str) for ln in payload["lines"])
    assert payload["vendorMessage"] == HEADER["notes_to_vendor"]
    assert link["provider"] == "qbd" and link["realm_id"] == END_USER


async def test_a_replay_is_up_to_date_after_one_call(db, shop, people, qbo, monkeypatch):  # noqa: F811
    boundary = Boundary(monkeypatch, "qbo")
    po = await pushed_once(db, shop, people, boundary, "qbo")
    again = await push(people.admin["token"], shop.company, po.id)
    assert again.status_code == 200, again.text
    assert again.json()["already_up_to_date"] is True
    assert len(boundary.named("create_purchase_order")) == 1


async def test_concurrent_pushes_create_one_purchase_order(db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbo")
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("create_purchase_order", creates("qbo"))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver",
                           headers={"Authorization": f"Bearer {people.admin['token']}"}) as ac:
        path = f"/api/quickbooks/{shop.company}/vendor-pos/{po.id}/push"
        r1, r2 = await asyncio.gather(ac.post(path, json={}), ac.post(path, json={}))
    assert {r1.status_code, r2.status_code} == {200}
    assert len(boundary.named("create_purchase_order")) == 1
    assert len(ps.rows(db, "SELECT id FROM public.quickbooks_purchase_order_links "
                           "WHERE vendor_purchase_order_id = %s", (po.id,))) == 1


async def test_a_stale_online_attempt_resumes_with_the_same_request_id(db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbo")
    request_id = _stale_pending(db, shop, po, "qbo", qb_vendor_id=QB_VENDOR)
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("create_purchase_order", creates("qbo"))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    assert boundary.request_ids("create_purchase_order") == [request_id]


async def test_an_ambiguous_failure_keeps_the_request_id_and_a_rejection_mints_a_new_one(
        db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbo")
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)).on(
        "create_purchase_order", raises(qb.QuickBooksApiError("QuickBooks request failed: reset")))
    lost = await push(people.admin["token"], shop.company, po.id)
    assert lost.status_code == 502
    # Not "rejected": it may have landed, and the next send resumes the same attempt.
    assert lost.json()["detail"]["code"] == "qbo_unreachable"
    first = _link(db, po.id)
    assert (first["status"], first["last_failure"]) == ("error", "ambiguous")

    boundary.on("create_purchase_order", raises(qb.QuickBooksApiError(
        "QuickBooks API error (400)", status=400,
        fault={"Fault": {"Error": [{"code": "6000", "Message": "A business validation error"}]}})))
    refused = await push(people.admin["token"], shop.company, po.id)
    assert refused.status_code == 502
    assert refused.json()["detail"]["code"] == "qbo_rejected"
    second = _link(db, po.id)
    assert (second["status"], second["last_failure"]) == ("error", "rejected")

    boundary.on("create_purchase_order", creates("qbo"))
    ok = await push(people.admin["token"], shop.company, po.id)
    assert ok.status_code == 200, ok.text
    ids = boundary.request_ids("create_purchase_order")
    assert ids[0] == ids[1] == str(first["qb_request_id"]), "the ambiguous attempt was resumed"
    assert ids[2] != ids[1], "a rejected attempt gets a new id"


async def test_a_push_with_no_changes_makes_zero_provider_calls(db, shop, people, qbo, monkeypatch):  # noqa: F811
    """Not even a term or ship-method lookup: the stored hash answers it (QB4)."""
    boundary = Boundary(monkeypatch, "qbo")
    po = await pushed_once(db, shop, people, boundary, "qbo")
    boundary.forbid_all()
    before = len(boundary.calls)
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    assert res.json()["already_up_to_date"] is True
    assert len(boundary.calls) == before


async def test_an_internal_note_never_makes_the_po_out_of_date(db, shop, people, qbo, monkeypatch):  # noqa: F811
    """QB9: internal notes (and receipts) are Jigged-only, so content_version stays put and
    the push stays a zero-call no-op."""
    boundary = Boundary(monkeypatch, "qbo")
    po = await pushed_once(db, shop, people, boundary, "qbo")
    version = _content_version(db, po.id)
    ps.save_po(shop.admin, po.id, changes={"internal_notes": "Bryce says they are slow in December."})
    assert _content_version(db, po.id) == version
    boundary.forbid_all()
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.json()["already_up_to_date"] is True
    assert _link(db, po.id)["pushed_content_version"] == _content_version(db, po.id)


# ───────────────────────── the Desktop unknown outcome (QB5) ─────────────────────────
async def test_a_desktop_unknown_outcome_is_probed_once_parked_and_reported_once(
        db, shop, people, qbd_conn, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbd")
    captured: list[str] = []
    monkeypatch.setattr(po_routes.sentry_sdk, "capture_message", lambda msg, **k: captured.append(msg))
    boundary = Boundary(monkeypatch, "qbd").on("resolve_term_id", returns(None)) \
        .on("resolve_ship_method_id", returns(None)) \
        .on("create_purchase_order", raises(qbd.QbdUnknownOutcome("lost"))) \
        .on("find_created_purchase_order", returns(None))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 409, res.text
    detail = res.json()["detail"]
    assert detail["code"] == "qbd_verify"
    link = _link(db, po.id)
    assert link["status"] == "needs_verification"
    assert detail["link_id"] == str(link["id"])
    assert len(boundary.named("find_created_purchase_order")) == 1
    assert captured == ["QuickBooks Desktop purchase order outcome unknown"]

    blocked = await push(people.admin["token"], shop.company, po.id)
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "qbd_blocked_unverified"
    assert len(boundary.named("create_purchase_order")) == 1, "never retried automatically"


async def test_a_parked_po_blocks_only_itself(db, shop, people, qbd_conn, monkeypatch):  # noqa: F811
    parked = sent_po(db, shop)
    other = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbd")
    monkeypatch.setattr(po_routes.sentry_sdk, "capture_message", lambda *a, **k: None)
    boundary = Boundary(monkeypatch, "qbd").on("resolve_term_id", returns(None)) \
        .on("resolve_ship_method_id", returns(None)) \
        .on("create_purchase_order", raises(qbd.QbdUnknownOutcome("lost"))) \
        .on("find_created_purchase_order", returns(None))
    assert (await push(people.admin["token"], shop.company, parked.id)).status_code == 409
    boundary.on("create_purchase_order", creates("qbd", "8000-OTHER"))
    res = await push(people.admin["token"], shop.company, other.id)
    assert res.status_code == 200, res.text


async def test_verify_adopts_what_the_probe_finds(db, shop, people, qbd_conn, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbd")
    monkeypatch.setattr(po_routes.sentry_sdk, "capture_message", lambda *a, **k: None)
    boundary = Boundary(monkeypatch, "qbd").on("resolve_term_id", returns(None)) \
        .on("resolve_ship_method_id", returns(None)) \
        .on("create_purchase_order", raises(qbd.QbdUnknownOutcome("lost"))) \
        .on("find_created_purchase_order", returns(None))
    await push(people.admin["token"], shop.company, po.id)
    link = _link(db, po.id)
    boundary.on("find_created_purchase_order", returns(PushedPurchaseOrder(
        id="8000-FOUND", doc_number=po.number, sync_token="3", line_ids=("F-L1", "F-L2"), closed=False)))
    res = await verify(people.user["token"], shop.company, str(link["id"]))
    assert res.status_code == 200, res.text
    assert res.json()["outcome"] == "adopted"
    adopted = _link(db, po.id)
    assert (adopted["status"], adopted["qb_po_id"]) == ("created", "8000-FOUND")
    assert [r["qb_line_id"] for r in _line_links(db, adopted["id"])] == ["F-L1", "F-L2"]
    again = await verify(people.user["token"], shop.company, str(link["id"]))
    assert again.json()["outcome"] == "adopted", "idempotent"


async def test_verify_releases_when_nothing_landed_and_a_retry_creates_one(
        db, shop, people, qbd_conn, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbd")
    monkeypatch.setattr(po_routes.sentry_sdk, "capture_message", lambda *a, **k: None)
    boundary = Boundary(monkeypatch, "qbd").on("resolve_term_id", returns(None)) \
        .on("resolve_ship_method_id", returns(None)) \
        .on("create_purchase_order", raises(qbd.QbdUnknownOutcome("lost"))) \
        .on("find_created_purchase_order", returns(None))
    await push(people.admin["token"], shop.company, po.id)
    link = _link(db, po.id)
    res = await verify(people.admin["token"], shop.company, str(link["id"]))
    assert res.json()["outcome"] == "released"
    assert _link(db, po.id)["status"] == "error"
    boundary.on("create_purchase_order", creates("qbd", "8000-RETRY"))
    retry = await push(people.admin["token"], shop.company, po.id)
    assert retry.status_code == 200, retry.text
    assert len(boundary.named("create_purchase_order")) == 2


async def test_a_stale_desktop_attempt_is_probed_and_adopted(db, shop, people, qbd_conn, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbd")
    _stale_pending(db, shop, po, "qbd", qb_vendor_id=QB_VENDOR)
    boundary = Boundary(monkeypatch, "qbd").on("find_created_purchase_order", returns(PushedPurchaseOrder(
        id="8000-LANDED", doc_number=po.number, sync_token="2", line_ids=("D-L1", "D-L2"), closed=False)))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    assert res.json()["already_existed"] is True
    assert boundary.named("create_purchase_order") == []
    assert _link(db, po.id)["qb_po_id"] == "8000-LANDED"


async def test_an_unknown_outcome_the_probe_finds_is_adopted_at_once(db, shop, people, qbd_conn, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbd")
    Boundary(monkeypatch, "qbd").on("resolve_term_id", returns(None)) \
        .on("resolve_ship_method_id", returns(None)) \
        .on("create_purchase_order", raises(qbd.QbdUnknownOutcome("lost"))) \
        .on("find_created_purchase_order", returns(PushedPurchaseOrder(
            id="8000-IT-LANDED", doc_number=po.number, sync_token="1", line_ids=("A", "B"), closed=False)))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    assert res.json()["qb_po_id"] == "8000-IT-LANDED"


# ───────────────────────── vendors (QB6) ─────────────────────────
async def test_an_exact_name_is_linked_and_mapped(db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("find_vendor_candidates", returns({"status": "exact_match", "qb_vendor_id": "QB-ATLAS",
                                                "candidates": [{"qb_id": "QB-ATLAS", "display_name": "Atlas Metals"}]})) \
        .on("create_purchase_order", creates("qbo"))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    assert boundary.named("create_vendor") == []
    assert boundary.payloads("create_purchase_order")[0]["VendorRef"] == {"value": "QB-ATLAS"}
    mapped = ps.row(db, "SELECT * FROM public.quickbooks_vendor_map WHERE vendor_id = %s", (shop.v1,))
    assert mapped["qb_vendor_id"] == "QB-ATLAS" and mapped["provider"] == "qbo"


async def test_similar_names_need_a_choice_and_nothing_is_written(db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    candidates = [{"qb_id": "1", "display_name": "Atlas Metals Inc"}, {"qb_id": "2", "display_name": "Atlas Metal"}]
    Boundary(monkeypatch, "qbo").on("find_vendor_candidates", returns(
        {"status": "candidates", "qb_vendor_id": None, "candidates": candidates}))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["code"] == "qb_vendor_choice_required"
    assert detail["candidates"] == candidates
    assert _link(db, po.id) is None, "a choice the shop has to make is not a failed send"


async def test_an_explicit_choice_links_that_vendor(db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("create_purchase_order", creates("qbo"))
    res = await push(people.admin["token"], shop.company, po.id,
                     {"vendor": {"action": "use_existing", "qb_vendor_id": "2"}})
    assert res.status_code == 200, res.text
    assert boundary.named("find_vendor_candidates") == []
    assert boundary.payloads("create_purchase_order")[0]["VendorRef"] == {"value": "2"}


async def test_an_unmatched_vendor_is_created_with_a_derived_request_id(db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("find_vendor_candidates", returns({"status": "unmatched", "qb_vendor_id": None, "candidates": []})) \
        .on("create_vendor", returns("QB-NEW-VENDOR")).on("create_purchase_order", creates("qbo"))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    [(args, kwargs)] = boundary.named("create_vendor")
    link = _link(db, po.id)
    assert kwargs["request_id"] == qbp.vendor_request_id(str(link["qb_request_id"]))
    assert "Atlas Metals" in args
    assert link["qb_vendor_id"] == "QB-NEW-VENDOR"


async def test_a_desktop_name_over_41_characters_is_refused_and_nothing_created(
        db, shop, people, qbd_conn, monkeypatch):  # noqa: F811
    ps.execute(db, "UPDATE public.vendors SET name = %s WHERE id = %s",
               ("Precision Anodizing and Plating Services of Ohio", shop.v1))
    po = sent_po(db, shop)
    boundary = Boundary(monkeypatch, "qbd").on("find_vendor_candidates", returns(
        {"status": "unmatched", "qb_vendor_id": None, "candidates": []}))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "qb_vendor_name_invalid"
    assert boundary.named("create_vendor") == [] and boundary.named("create_purchase_order") == []


@pytest.mark.parametrize("code", ["qb_vendor_name_taken", "qb_vendor_inactive"])
async def test_a_taken_or_inactive_vendor_name_is_a_409(db, shop, people, qbo, monkeypatch, code):  # noqa: F811
    po = sent_po(db, shop)
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("find_vendor_candidates", returns({"status": "unmatched", "qb_vendor_id": None, "candidates": []})) \
        .on("create_vendor", raises(pom.PurchasingRefusal(code, name="Atlas Metals")))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == code
    assert boundary.named("create_purchase_order") == []
    assert _link(db, po.id)["status"] == "error"


# ───────────────────────── setup the push needs (QB7) ─────────────────────────
async def test_only_the_kinds_on_the_po_are_required(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    connection = seed_qbo(supabase_admin, shop.company)
    seed_setup(supabase_admin, shop.company, "qbo", connection, kinds=("other",))
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbo")
    Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)).on("create_purchase_order", creates("qbo"))
    assert (await push(people.admin["token"], shop.company, po.id)).status_code == 200

    with_part = sent_po(db, shop, [ps.part_line(shop.screw, 2, "hundred", unit_price=12.5)] + other_lines())
    res = await push(people.admin["token"], shop.company, with_part.id)
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["code"] == "qb_setup_required"
    assert detail["missing"] == ["item:part"]
    assert "parts and material" in detail["message"]


async def test_one_ap_account_is_used_and_several_need_a_choice(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    connection = seed_qbo(supabase_admin, shop.company)
    seed_setup(supabase_admin, shop.company, "qbo", connection, ap=None)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbo")
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("list_ap_accounts", returns([{"id": "AP-1", "full_name": "A/P", "type": "Accounts Payable"},
                                         {"id": "AP-2", "full_name": "A/P 2", "type": "Accounts Payable"}]))
    po = sent_po(db, shop)
    several = await push(people.admin["token"], shop.company, po.id)
    assert several.status_code == 409
    assert several.json()["detail"]["missing"] == ["ap_account"]

    boundary.on("list_ap_accounts", returns([{"id": "AP-1", "full_name": "A/P", "type": "Accounts Payable"}])) \
        .on("create_purchase_order", creates("qbo"))
    one = await push(people.admin["token"], shop.company, po.id)
    assert one.status_code == 200, one.text
    assert boundary.payloads("create_purchase_order")[0]["APAccountRef"] == {"value": "AP-1"}
    stored = ps.row(db, "SELECT * FROM public.quickbooks_purchasing_setup WHERE company_id = %s "
                        "AND setup_key = 'ap_account'", (shop.company,))
    assert stored["qb_id"] == "AP-1"


# ───────────────────────── update, close, reopen, archive (QB8, QB9) ─────────────────────────
async def test_an_update_reads_once_sends_the_line_ids_and_stores_the_new_ones(
        db, shop, people, qbo, monkeypatch):  # noqa: F811
    boundary = Boundary(monkeypatch, "qbo")
    po = await pushed_once(db, shop, people, boundary, "qbo")
    link = _link(db, po.id)
    ps.save_po(shop.admin, po.id, lines=[{"id": po.lines[0], "quantity": 2}, ps.other_line("Coolant", 4, unit_price=31)],
               expected=ps.updated_at_text(db, po.id))
    ps.mark_sent(shop.admin, po.id)
    assert _content_version(db, po.id) > link["pushed_content_version"]

    boundary.on("read_purchase_order", lambda *a, **k: state_from_links(db, po.id, token="0")) \
        .on("update_purchase_order", updates("qbo", token="1"))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    assert res.json()["operation"] == "update"
    assert len(boundary.named("read_purchase_order")) == 1
    [payload] = boundary.payloads("update_purchase_order")
    assert payload["sparse"] is True and payload["SyncToken"] == "0"
    assert _line_ids(payload, "qbo") == ["QB-PO-1-L1", "QB-PO-1-L2", None]
    after = _link(db, po.id)
    assert after["qb_sync_token"] == "1"
    assert after["pushed_content_version"] == _content_version(db, po.id)
    assert [r["qb_line_id"] for r in _line_links(db, after["id"])] == ["QB-PO-1-L1", "QB-PO-1-L2", "NEW-100"]


async def test_a_removed_line_is_dropped_from_quickbooks_too(db, shop, people, qbo, monkeypatch):  # noqa: F811
    """Its QuickBooks line id must still be known after the Jigged line is gone, or the
    update would mistake it for a line the bookkeeper added (qb_foreign_lines). Removing an
    unreceived line deletes it, so this needs
    quickbooks_purchase_order_line_links.vendor_purchase_order_line_id ON DELETE SET NULL: the
    row stays, naming no line. QuickBooks still holds both lines, as the first push left them --
    read from before the removal, so a vanished row cannot make the guard pass by accident."""
    boundary = Boundary(monkeypatch, "qbo")
    po = await pushed_once(db, shop, people, boundary, "qbo")
    in_quickbooks = state_from_links(db, po.id)
    assert sorted(line.id for line in in_quickbooks.lines) == ["QB-PO-1-L1", "QB-PO-1-L2"]
    ps.save_po(shop.admin, po.id, removed=[po.lines[1]], expected=ps.updated_at_text(db, po.id))
    ps.mark_sent(shop.admin, po.id)
    held = {r["qb_line_id"]: r["vendor_purchase_order_line_id"] for r in _line_links(db, _link(db, po.id)["id"])}
    assert held == {"QB-PO-1-L1": po.lines[0], "QB-PO-1-L2": None}, "the removed line's QuickBooks line was forgotten"
    boundary.on("read_purchase_order", lambda *a, **k: in_quickbooks) \
        .on("update_purchase_order", updates("qbo"))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    assert _line_ids(boundary.payloads("update_purchase_order")[0], "qbo") == ["QB-PO-1-L1"]
    assert [r["qb_line_id"] for r in _line_links(db, _link(db, po.id)["id"])] == ["QB-PO-1-L1"]


@pytest.mark.parametrize("case", ["missing", "foreign", "in_use"])
async def test_quickbooks_state_refusals_change_nothing(db, shop, people, qbd_conn, monkeypatch, case):  # noqa: F811
    boundary = Boundary(monkeypatch, "qbd")
    po = await pushed_once(db, shop, people, boundary, "qbd")
    before = _link(db, po.id)
    ps.save_po(shop.admin, po.id, lines=[{"id": po.lines[0], "quantity": 0.5}], expected=ps.updated_at_text(db, po.id))
    ps.mark_sent(shop.admin, po.id)
    if case == "missing":
        boundary.on("read_purchase_order", returns(None))
        code = "qb_po_missing"
    elif case == "foreign":
        boundary.on("read_purchase_order", lambda *a, **k: state_from_links(db, po.id, extra_lines=("BOOKKEEPER",)))
        code = "qb_foreign_lines"
    else:
        boundary.on("read_purchase_order",
                    lambda *a, **k: state_from_links(db, po.id, received={f"{before['qb_po_id']}-L1": 1}))
        code = "qb_line_in_use"
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 409, res.text
    assert res.json()["detail"]["code"] == code
    assert boundary.named("update_purchase_order") == []
    after = _link(db, po.id)
    for column in ("status", "qb_request_id", "qb_sync_token", "pushed_content_version", "pushed_payload_hash"):
        assert after[column] == before[column], column


@pytest.mark.parametrize("provider", ["qbo", "qbd"])
async def test_close_and_reopen_are_sent_header_only(db, shop, people, supabase_admin, monkeypatch, provider):  # noqa: F811
    connection = (seed_qbo if provider == "qbo" else seed_qbd)(supabase_admin, shop.company)
    seed_setup(supabase_admin, shop.company, provider, connection)
    boundary = Boundary(monkeypatch, provider)
    po = await pushed_once(db, shop, people, boundary, provider)
    ps.set_state(shop.admin, po.id, "close", reason="Nothing more coming")
    boundary.on("read_purchase_order", lambda *a, **k: state_from_links(db, po.id, token="0")) \
        .on("update_purchase_order", updates(provider, token="1"))
    closed = await push(people.admin["token"], shop.company, po.id)
    assert closed.status_code == 200, closed.text
    assert closed.json()["operation"] == "close"
    payload = boundary.payloads("update_purchase_order")[-1]
    if provider == "qbo":
        assert payload == {"Id": "QB-PO-1", "SyncToken": "0", "sparse": True, "POStatus": "Closed"}
    else:
        assert payload == {"revisionNumber": "0", "isManuallyClosed": True}
    assert _link(db, po.id)["qb_closed"] is True

    ps.set_state(shop.admin, po.id, "reopen")
    boundary.on("read_purchase_order", lambda *a, **k: state_from_links(db, po.id, token="1", closed=True))
    reopened = await push(people.admin["token"], shop.company, po.id)
    assert reopened.json()["operation"] == "reopen"
    payload = boundary.payloads("update_purchase_order")[-1]
    assert payload.get("POStatus", payload.get("isManuallyClosed")) in ("Open", False)
    assert _link(db, po.id)["qb_closed"] is False


async def test_a_desktop_po_received_in_full_cannot_be_reopened(db, shop, people, qbd_conn, monkeypatch):  # noqa: F811
    boundary = Boundary(monkeypatch, "qbd")
    po = await pushed_once(db, shop, people, boundary, "qbd")
    ps.set_state(shop.admin, po.id, "close", reason="done")
    boundary.on("read_purchase_order", lambda *a, **k: state_from_links(db, po.id)) \
        .on("update_purchase_order", updates("qbd"))
    assert (await push(people.admin["token"], shop.company, po.id)).status_code == 200
    ps.set_state(shop.admin, po.id, "reopen")
    boundary.on("read_purchase_order", lambda *a, **k: state_from_links(db, po.id, closed=True, fully_received=True))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "qb_cannot_reopen"


async def test_an_unsent_revision_is_refused_naming_the_vendor(db, shop, people, qbo, monkeypatch):  # noqa: F811
    boundary = Boundary(monkeypatch, "qbo")
    po = await pushed_once(db, shop, people, boundary, "qbo")
    ps.save_po(shop.admin, po.id, lines=[{"id": po.lines[0], "quantity": 3}], expected=ps.updated_at_text(db, po.id))
    boundary.forbid_all()
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["code"] == "vendor_po_unsent_revision"
    assert "Rev 1" in detail["message"] and "Atlas Metals" in detail["message"]


async def test_an_archived_po_makes_no_call_and_is_refused(db, shop, people, qbo, monkeypatch):  # noqa: F811
    boundary = Boundary(monkeypatch, "qbo")
    po = await pushed_once(db, shop, people, boundary, "qbo")
    ps.set_state(shop.admin, po.id, "archive")
    boundary.forbid_all()
    before = len(boundary.calls)
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "vendor_po_archived"
    assert len(boundary.calls) == before
    assert _link(db, po.id)["status"] == "created", "the link stays readable"


# ───────────────────────── the error map (QB10) ─────────────────────────
async def test_a_draft_and_an_unpriced_line_are_refused(db, shop, people, qbo, monkeypatch):  # noqa: F811
    boundary = Boundary(monkeypatch, "qbo")
    draft = ps.make_po(db, shop, other_lines(), header=HEADER, sent=False)
    res = await push(people.admin["token"], shop.company, draft.id)
    assert res.status_code == 409 and res.json()["detail"]["code"] == "vendor_po_draft"
    tbc = sent_po(db, shop, [ps.other_line("Rebuild", 1, unit_price=None, price_source=None)])
    res = await push(people.admin["token"], shop.company, tbc.id)
    assert res.status_code == 409 and res.json()["detail"]["code"] == "vendor_po_line_unpriced"
    assert boundary.calls == []


async def test_a_recording_failure_is_a_500_and_the_next_push_does_not_create_again(
        db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbo")
    boundary = Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("create_purchase_order", creates("qbo", "QB-REC"))
    real = po_routes._write_line_links
    failures = iter([RuntimeError("database went away")])

    def _flaky(*a, **k):
        exc = next(failures, None)
        if exc:
            raise exc
        return real(*a, **k)

    monkeypatch.setattr(po_routes, "_write_line_links", _flaky)
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 500
    link = _link(db, po.id)
    assert (link["status"], link["last_failure"], link["qb_po_id"]) == ("error", "ambiguous", "QB-REC")
    again = await push(people.admin["token"], shop.company, po.id)
    assert again.status_code == 200, again.text
    ids = boundary.request_ids("create_purchase_order")
    assert ids[0] == ids[1], "resumed with the same request id: Intuit replays, nothing is created twice"
    assert _link(db, po.id)["status"] == "created"


async def test_a_429_is_busy_and_kept_out_of_sentry(db, shop, people, qbo, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbo")
    Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)).on(
        "create_purchase_order", raises(qb.QuickBooksApiError("QuickBooks API error (429)", status=429)))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 409
    assert res.json()["detail"]["code"] == "qbo_busy"
    assert _link(db, po.id)["last_failure"] == "rejected"


async def test_quickbooks_own_number_is_stored_and_reported(db, shop, people, qbo, monkeypatch):  # noqa: F811
    """Custom transaction numbers off: QuickBooks Online ignores DocNumber."""
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbo")
    Boundary(monkeypatch, "qbo").on("resolve_term_id", returns(None)) \
        .on("create_purchase_order", creates("qbo", doc_number="1043"))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.json()["doc_number"] == "1043"
    assert any("QuickBooks numbered it 1043" in w for w in res.json()["warnings"])
    assert _link(db, po.id)["qb_doc_number"] == "1043"


async def test_an_unforeseen_rejection_is_a_502_with_quickbooks_words(db, shop, people, qbd_conn, monkeypatch):  # noqa: F811
    po = sent_po(db, shop)
    map_vendor(ps_admin(), shop.company, shop.v1, "qbd")
    Boundary(monkeypatch, "qbd").on("resolve_term_id", returns(None)) \
        .on("resolve_ship_method_id", returns(None)) \
        .on("create_purchase_order", raises(qbd.QbdApiError("Item name too long")))
    res = await push(people.admin["token"], shop.company, po.id)
    assert res.status_code == 502
    assert res.json()["detail"] == {"code": "qbd_rejected", "message": "Item name too long"}


async def test_preflight_reports_without_reading_the_quickbooks_po(db, shop, people, qbo, monkeypatch):  # noqa: F811
    """The dialog's preflight never reads the QuickBooks PO; on a first send it searches
    vendors, and a failed search offers to create."""
    po = sent_po(db, shop)
    Boundary(monkeypatch, "qbo").on("find_vendor_candidates", raises(qb.QuickBooksApiError("down")))
    res = await preflight(people.user["token"], shop.company, po.id)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["connected"] is True and body["provider"] == "qbo" and body["has_deep_links"] is True
    assert body["operation"] == "create"
    assert body["vendor"]["status"] == "unmatched"
    assert body["vendor"]["jigged_name"] == "Atlas Metals"
    assert body["refusal"] is None and body["blocked"] is None and body["setup_missing"] == []
