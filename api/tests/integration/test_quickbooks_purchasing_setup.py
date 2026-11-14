"""Settings → QuickBooks → Purchasing: the items, the AP account and "Check QuickBooks".

The panel reads the setup on MOUNT, so that read is database-only and must never call
QuickBooks (QB1). Everything that does call QuickBooks -- listing accounts and items,
choosing or creating an item, the AP account, the preferences check -- is an admin's
explicit click behind the billing gate (QB2). The default is ONE general purchases item
filling all three line kinds; a per-kind split is optional (QB7, founder decision).
Disconnecting deletes the setup and keeps the vendor map (QB11).

Same boundary and fixtures as test_quickbooks_vendor_po_routes.py. Requires a local
Supabase with this branch's migrations applied.

Criteria: QB1, QB2, QB7, QB11.
"""
from __future__ import annotations

import pytest

import services.accounting.purchase_order as pom
import services.quickbooks as qb
import services.quickbooks_desktop as qbd
from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, shop  # noqa: F401
from tests.integration.test_quickbooks_vendor_po_routes import (  # noqa: F401
    AP,
    END_USER,
    ITEM,
    Boundary,
    _route_env,
    call,
    map_vendor,
    people,
    raises,
    returns,
    seed_qbd,
    seed_qbo,
    seed_setup,
)

pytestmark = pytest.mark.integration

COGS = {"id": "COGS-1", "full_name": "Cost of Goods Sold", "type": "Cost of Goods Sold"}
REPAIRS = {"id": "EXP-7", "full_name": "Repairs and Maintenance", "type": "Expense"}
PURCHASES = {"id": ITEM, "name": "Jigged purchases", "type": "NonInventory",
             "posting_account_id": "COGS-1", "posting_account_name": "Cost of Goods Sold"}
OUTSIDE = {"id": "QB-ITEM-OUTSIDE", "name": "Outside services", "type": "Service",
           "posting_account_id": "EXP-7", "posting_account_name": "Repairs and Maintenance"}
INCOME_ITEM = {"id": "QB-ITEM-SALES", "name": "Consulting", "type": "Service",
               "posting_account_id": "INC-1", "posting_account_name": "Sales"}
INVOICE_ITEM = {"id": "INVOICE-ITEM-1", "name": "Machined Parts", "type": "Service",
                "posting_account_id": "COGS-1", "posting_account_name": "Cost of Goods Sold"}


def base(company: str) -> str:
    return f"/api/quickbooks/{company}/purchasing"


def setup_rows(db, company: str) -> dict[str, dict]:  # noqa: F811
    return {r["setup_key"]: r for r in ps.rows(
        db, "SELECT * FROM public.quickbooks_purchasing_setup WHERE company_id = %s", (company,))}


def lists(boundary: Boundary, items=(PURCHASES, OUTSIDE, INCOME_ITEM, INVOICE_ITEM)) -> Boundary:
    return boundary.on("list_purchase_accounts", returns([COGS, REPAIRS])) \
        .on("list_purchase_items", returns([dict(i) for i in items]))


# ───────────────────────── the mount read (QB1) ─────────────────────────
async def test_reading_the_setup_never_calls_quickbooks(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    connection = seed_qbo(supabase_admin, shop.company)
    seed_setup(supabase_admin, shop.company, "qbo", connection)
    boundary = Boundary(monkeypatch, "qbo")
    for member in (people.admin, people.user):
        res = await call(member["token"], "GET", f"{base(shop.company)}/setup")
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["connected"] is True and body["provider"] == "qbo"
        assert body["one_item_for_all"] is True
        assert [i["line_kind"] for i in body["items"]] == ["part", "outside_service", "other"]
        assert body["ap_account"] == {"qb_id": AP, "qb_name": "Accounts Payable (A/P)"}
        assert body["missing"] == []
    assert boundary.calls == []
    refused = await call(people.operator["token"], "GET", f"{base(shop.company)}/setup")
    assert refused.status_code == 403


async def test_setup_reads_as_not_connected_without_quickbooks(shop, people, monkeypatch):  # noqa: F811
    boundary = Boundary(monkeypatch, "qbo")
    res = await call(people.user["token"], "GET", f"{base(shop.company)}/setup")
    assert res.status_code == 200
    assert res.json() == {"connected": False, "provider": None, "items": [], "one_item_for_all": False,
                          "ap_account": None, "preferences": None, "missing": []}
    assert boundary.calls == []


async def test_an_unset_setup_lists_what_is_missing(shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company)
    Boundary(monkeypatch, "qbo")
    body = (await call(people.admin["token"], "GET", f"{base(shop.company)}/setup")).json()
    assert body["missing"] == ["item:part", "item:outside_service", "item:other", "ap_account"]


# ───────────────────────── who may click (QB2) ─────────────────────────
async def test_the_lists_and_setup_writes_need_an_admin(shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company)
    boundary = Boundary(monkeypatch, "qbo")
    for member in (people.user, people.operator):
        for method, path, body in (
            ("GET", f"{base(shop.company)}/accounts", None),
            ("GET", f"{base(shop.company)}/items", None),
            ("POST", f"{base(shop.company)}/items", {"all_kinds": {"action": "use_existing", "qb_item_id": ITEM}}),
            ("POST", f"{base(shop.company)}/ap-account", {"qb_account_id": AP}),
            ("POST", f"{base(shop.company)}/check-preferences", None),
        ):
            res = await call(member["token"], method, path, body)
            assert res.status_code == 403, (member is people.user, path, res.text)
    assert boundary.calls == []


# ───────────────────────── items (QB7) ─────────────────────────
async def test_the_item_list_marks_eligibility_and_never_offers_the_invoice_item(
        shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company, default_item_id="INVOICE-ITEM-1")
    lists(Boundary(monkeypatch, "qbo"))
    res = await call(people.admin["token"], "GET", f"{base(shop.company)}/items")
    assert res.status_code == 200, res.text
    body = res.json()
    by_id = {i["id"]: i for i in body["items"]}
    assert set(by_id) == {ITEM, "QB-ITEM-OUTSIDE", "QB-ITEM-SALES"}
    assert by_id[ITEM]["eligible"] is True and by_id["QB-ITEM-SALES"]["eligible"] is False
    assert [a["id"] for a in body["accounts"]] == ["COGS-1", "EXP-7"]


async def test_one_item_fills_all_three_kinds(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company)
    lists(Boundary(monkeypatch, "qbo"))
    res = await call(people.admin["token"], "POST", f"{base(shop.company)}/items",
                     {"all_kinds": {"action": "use_existing", "qb_item_id": ITEM}})
    assert res.status_code == 200, res.text
    assert res.json()["one_item_for_all"] is True
    rows = setup_rows(db, shop.company)
    assert {k: rows[k]["qb_id"] for k in pom.ITEM_SETUP_KEYS.values()} == {
        "item:part": ITEM, "item:outside_service": ITEM, "item:other": ITEM}
    assert rows["item:part"]["posting_account_id"] == "COGS-1"
    assert rows["item:part"]["chosen_by"] == people.admin["access_id"]
    assert rows["item:part"]["created_in_quickbooks"] is False


async def test_a_per_kind_split_is_optional(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company)
    lists(Boundary(monkeypatch, "qbo"))
    res = await call(people.admin["token"], "POST", f"{base(shop.company)}/items", {"by_kind": {
        "part": {"action": "use_existing", "qb_item_id": ITEM},
        "outside_service": {"action": "use_existing", "qb_item_id": "QB-ITEM-OUTSIDE"},
        "other": {"action": "use_existing", "qb_item_id": "QB-ITEM-OUTSIDE"},
    }})
    assert res.status_code == 200, res.text
    assert res.json()["one_item_for_all"] is False
    rows = setup_rows(db, shop.company)
    assert rows["item:part"]["qb_id"] == ITEM
    assert rows["item:outside_service"]["qb_id"] == rows["item:other"]["qb_id"] == "QB-ITEM-OUTSIDE"


async def test_creating_an_item_posts_it_to_the_chosen_account_once(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company)
    created = {"id": "QB-ITEM-NEW", "name": "Jigged purchases", "type": "NonInventory",
               "posting_account_id": "COGS-1", "posting_account_name": "Cost of Goods Sold", "created": True}
    boundary = lists(Boundary(monkeypatch, "qbo")).on("create_purchase_item", returns(created))
    res = await call(people.admin["token"], "POST", f"{base(shop.company)}/items",
                     {"all_kinds": {"action": "create", "qb_account_id": "COGS-1"}})
    assert res.status_code == 200, res.text
    [(args, kwargs)] = boundary.named("create_purchase_item")
    assert args[-2:] == ("Jigged purchases", "COGS-1")
    assert kwargs["request_id"]
    rows = setup_rows(db, shop.company)
    assert all(rows[k]["qb_id"] == "QB-ITEM-NEW" and rows[k]["created_in_quickbooks"]
               for k in pom.ITEM_SETUP_KEYS.values())


@pytest.mark.parametrize("item_id", ["INVOICE-ITEM-1", "QB-ITEM-MACHINED"])
async def test_the_invoice_item_is_refused_by_id_and_by_name(db, shop, people, supabase_admin, monkeypatch,  # noqa: F811
                                                            item_id):
    seed_qbo(supabase_admin, shop.company, default_item_id="INVOICE-ITEM-1")
    by_name = {**INVOICE_ITEM, "id": "QB-ITEM-MACHINED"}
    lists(Boundary(monkeypatch, "qbo"), items=(PURCHASES, INVOICE_ITEM, by_name))
    res = await call(people.admin["token"], "POST", f"{base(shop.company)}/items",
                     {"all_kinds": {"action": "use_existing", "qb_item_id": item_id}})
    assert res.status_code == 400
    assert "invoices post to" in res.json()["detail"]
    assert setup_rows(db, shop.company) == {}


async def test_an_item_posting_to_income_is_refused(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company)
    lists(Boundary(monkeypatch, "qbo"))
    res = await call(people.admin["token"], "POST", f"{base(shop.company)}/items",
                     {"all_kinds": {"action": "use_existing", "qb_item_id": "QB-ITEM-SALES"}})
    assert res.status_code == 400
    assert "isn't an expense" in res.json()["detail"]
    assert setup_rows(db, shop.company) == {}


async def test_a_same_named_item_on_another_account_is_a_409(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company)
    lists(Boundary(monkeypatch, "qbo")).on("create_purchase_item", raises(pom.PurchasingRefusal(
        "qb_item_name_taken", name="Jigged purchases", account="Repairs and Maintenance")))
    res = await call(people.admin["token"], "POST", f"{base(shop.company)}/items",
                     {"all_kinds": {"action": "create", "qb_account_id": "COGS-1"}})
    assert res.status_code == 409
    detail = res.json()["detail"]
    assert detail["code"] == "qb_item_name_taken"
    assert "Repairs and Maintenance" in detail["message"]
    assert setup_rows(db, shop.company) == {}


async def test_either_one_item_or_a_mapping_never_both(shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company)
    boundary = Boundary(monkeypatch, "qbo")
    choice = {"action": "use_existing", "qb_item_id": ITEM}
    for body in ({}, {"all_kinds": choice, "by_kind": {"part": choice}}):
        res = await call(people.admin["token"], "POST", f"{base(shop.company)}/items", body)
        assert res.status_code == 400, res.text
    assert boundary.calls == []


async def test_a_desktop_item_is_created_one_way(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbd(supabase_admin, shop.company)
    created = {"id": "8000-ITEM", "name": "Jigged purchases", "type": "non_inventory",
               "posting_account_id": "COGS-1", "posting_account_name": "Cost of Goods Sold", "created": True}
    boundary = lists(Boundary(monkeypatch, "qbd")).on("create_purchase_item", returns(created))
    res = await call(people.admin["token"], "POST", f"{base(shop.company)}/items",
                     {"all_kinds": {"action": "create", "qb_account_id": "COGS-1"}})
    assert res.status_code == 200, res.text
    assert len(boundary.named("create_purchase_item")) == 1
    row = setup_rows(db, shop.company)["item:other"]
    assert (row["provider"], row["realm_id"]) == ("qbd", END_USER)
    assert row["quickbooks_desktop_connection_id"] is not None and row["quickbooks_connection_id"] is None


# ───────────────────────── the AP account and the preferences check ─────────────────────────
async def test_the_ap_account_must_be_payable_and_is_online_only(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company)
    Boundary(monkeypatch, "qbo").on("list_ap_accounts", returns(
        [{"id": "AP-1", "full_name": "Accounts Payable (A/P)", "type": "Accounts Payable"}]))
    wrong = await call(people.admin["token"], "POST", f"{base(shop.company)}/ap-account", {"qb_account_id": "COGS-1"})
    assert wrong.status_code == 400
    ok = await call(people.admin["token"], "POST", f"{base(shop.company)}/ap-account", {"qb_account_id": "AP-1"})
    assert ok.status_code == 200, ok.text
    assert setup_rows(db, shop.company)["ap_account"]["qb_id"] == "AP-1"


async def test_desktop_has_no_ap_account_to_choose(shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbd(supabase_admin, shop.company)
    boundary = Boundary(monkeypatch, "qbd")
    res = await call(people.admin["token"], "POST", f"{base(shop.company)}/ap-account", {"qb_account_id": "X"})
    assert res.status_code == 400
    assert boundary.calls == []


async def test_check_quickbooks_is_stored_for_online_with_its_warnings(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbo(supabase_admin, shop.company)
    Boundary(monkeypatch, "qbo").on("check_purchasing_preferences", returns(
        {"purchase_orders_enabled": None, "custom_txn_numbers": False}))
    res = await call(people.admin["token"], "POST", f"{base(shop.company)}/check-preferences")
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["custom_txn_numbers"] is False and body["purchase_orders_enabled"] is None
    assert len(body["warnings"]) == 2
    stored = setup_rows(db, shop.company)["qbo_preferences"]
    assert stored["details"]["custom_txn_numbers"] is False
    assert stored["details"]["checked_at"] == body["checked_at"]
    view = (await call(people.user["token"], "GET", f"{base(shop.company)}/setup")).json()
    assert view["preferences"]["custom_txn_numbers"] is False


async def test_check_quickbooks_on_desktop_answers_without_storing(db, shop, people, supabase_admin, monkeypatch):  # noqa: F811
    seed_qbd(supabase_admin, shop.company)
    Boundary(monkeypatch, "qbd").on("check_purchasing_preferences", returns(
        {"purchase_orders_enabled": False, "custom_txn_numbers": True}))
    res = await call(people.admin["token"], "POST", f"{base(shop.company)}/check-preferences")
    assert res.status_code == 200, res.text
    assert any("Inventory and purchase orders are active" in w for w in res.json()["warnings"])
    assert "qbo_preferences" not in setup_rows(db, shop.company)


# ───────────────────────── disconnect (QB11) ─────────────────────────
@pytest.mark.parametrize("provider", ["qbo", "qbd"])
async def test_disconnecting_clears_the_setup_and_keeps_the_vendor_map(db, shop, people, supabase_admin,  # noqa: F811
                                                                      monkeypatch, provider):
    """The setup rows hang off the connection row ON DELETE CASCADE, so both Disconnect
    routes clear them without knowing they exist; the vendor map is history, kept like
    the customer map."""
    connection = (seed_qbo if provider == "qbo" else seed_qbd)(supabase_admin, shop.company)
    seed_setup(supabase_admin, shop.company, provider, connection)
    map_vendor(supabase_admin, shop.company, shop.v1, provider)
    monkeypatch.setattr(qb, "revoke_token", lambda *a, **k: None)
    monkeypatch.setattr(qbd, "delete_end_user", lambda *a, **k: None)
    path = (f"/api/quickbooks/{shop.company}/disconnect" if provider == "qbo"
            else f"/api/quickbooks-desktop/{shop.company}/disconnect")
    res = await call(people.admin["token"], "POST", path)
    assert res.status_code == 200, res.text
    assert setup_rows(db, shop.company) == {}
    assert ps.scalar(db, "SELECT count(*) FROM public.quickbooks_vendor_map WHERE company_id = %s",
                     (shop.company,)) == 1
