"""The QuickBooks reference data a vendor-PO push needs: accounts, items, vendors.

Each function here is called only from an explicit click -- the Settings panel's
"Choose item", the AP account picker, "Check QuickBooks", or Send/Update/Close -- and
each is tested with the HTTP boundary patched, so nothing here talks to Intuit or
Conductor.

Rules pinned:
  * A purchase item must post to an expense, cost-of-goods-sold or other-expense
    account, VERIFIED, not assumed. A same-named item is reused only when it posts to
    the chosen account (the invoice path's resolve_default_item does not check, which
    is a known bug this code must not copy).
  * The invoice item ("Machined Parts", or the connection's own invoice item id) is
    never a purchase item: it posts to income.
  * Vendor names are refused, never truncated; QuickBooks Online's 6240 is resolved by
    re-querying, never by guessing.
  * QUICKBOOKS_FAKE makes every call deterministic with no network, and is inert in
    production.
  * Jigged never creates bills or item receipts (founder decision): no new module
    references either endpoint or entity.

Criteria: QB3, QB6, QB7, QB12.
"""
import ast
import sys
import uuid
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.accounting.purchase_order as pom  # noqa: E402
import services.quickbooks as qb  # noqa: E402
import services.quickbooks_desktop as qbd  # noqa: E402
import services.quickbooks_desktop_purchasing as qbdp  # noqa: E402
import services.quickbooks_purchasing as qbp  # noqa: E402
from services.accounting.base import QbPurchaseOrderState  # noqa: E402

pytestmark = pytest.mark.unit

API_ROOT = Path(__file__).resolve().parents[2]
NEW_MODULES = [
    API_ROOT / "services" / "accounting" / "purchase_order.py",
    API_ROOT / "services" / "accounting" / "purchasing_fake.py",
    API_ROOT / "services" / "quickbooks_purchasing.py",
    API_ROOT / "services" / "quickbooks_desktop_purchasing.py",
    API_ROOT / "routes" / "quickbooks_purchasing_routes.py",
]


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    monkeypatch.setenv("CONDUCTOR_API_KEY", "sk_conductor_test")
    monkeypatch.delenv("QUICKBOOKS_FAKE", raising=False)


def _fault(code, message="", status=400):
    return qb.QuickBooksApiError(
        f"QuickBooks API error ({status})", status=status,
        fault={"Fault": {"Error": [{"Message": message, "code": code}], "type": "ValidationFault"}},
    )


# ───────────────────────── accounts (QB7) ─────────────────────────
QBO_ACCOUNTS = [
    {"Id": "1", "Name": "Job Materials", "FullyQualifiedName": "Cost of Goods Sold:Job Materials",
     "AccountType": "Cost of Goods Sold"},
    {"Id": "2", "Name": "Repairs and Maintenance", "AccountType": "Expense"},
    {"Id": "3", "Name": "Freight", "AccountType": "Other Expense"},
    {"Id": "4", "Name": "Sales of Product Income", "AccountType": "Income"},
    {"Id": "5", "Name": "Accounts Payable (A/P)", "AccountType": "Accounts Payable"},
    {"Id": "6", "Name": "Inventory Asset", "AccountType": "Other Current Asset"},
]


def test_qbo_purchase_accounts_are_expense_cogs_and_other_expense(monkeypatch):
    queries = []

    def _fake_query(db, company_id, query):
        queries.append(query)
        return {"Account": QBO_ACCOUNTS}

    monkeypatch.setattr(qb, "qb_query", _fake_query)
    accounts = qbp.list_purchase_accounts(None, "co-1")
    assert [a["id"] for a in accounts] == ["1", "2", "3"]
    assert accounts[0] == {"id": "1", "full_name": "Cost of Goods Sold:Job Materials",
                           "type": "Cost of Goods Sold"}
    assert "Active = true" in queries[0]


def test_qbo_ap_accounts_are_accounts_payable_only(monkeypatch):
    monkeypatch.setattr(qb, "qb_query", lambda *a, **k: {"Account": QBO_ACCOUNTS})
    assert qbp.list_ap_accounts(None, "co-1") == [
        {"id": "5", "full_name": "Accounts Payable (A/P)", "type": "Accounts Payable"}]


def test_qbd_purchase_accounts_ask_once_per_account_type(monkeypatch):
    """Conductor's accounts list takes ONE accountType per call."""
    calls = []

    def _fake_list(path, end_user_id, params):
        calls.append((path, params["accountType"], params.get("status")))
        return [{"id": f"{params['accountType']}-1", "fullName": f"{params['accountType']} account"}]

    monkeypatch.setattr(qbd, "_list", _fake_list)
    accounts = qbdp.list_purchase_accounts("eu")
    assert calls == [("/accounts", "expense", "active"),
                     ("/accounts", "cost_of_goods_sold", "active"),
                     ("/accounts", "other_expense", "active")]
    assert [a["type"] for a in accounts] == ["expense", "cost_of_goods_sold", "other_expense"]


def test_qbd_has_no_ap_account_to_choose():
    """Desktop POs carry no accounts-payable account; only QuickBooks Online asks."""
    assert qbdp.list_ap_accounts("eu") == []


# ───────────────────────── items (QB7) ─────────────────────────
def test_qbo_purchase_items_are_non_inventory_and_service_with_an_expense_account(monkeypatch):
    monkeypatch.setattr(qb, "qb_query", lambda *a, **k: {"Item": [
        {"Id": "10", "Name": "Raw material", "Type": "NonInventory",
         "ExpenseAccountRef": {"value": "1", "name": "Job Materials"}},
        {"Id": "11", "Name": "Outside processing", "Type": "Service",
         "ExpenseAccountRef": {"value": "2", "name": "Repairs and Maintenance"}},
        {"Id": "12", "Name": "Bar stock", "Type": "Inventory",
         "ExpenseAccountRef": {"value": "1", "name": "Job Materials"}},
        {"Id": "13", "Name": "Consulting", "Type": "Service"},
        {"Id": "14", "Name": "Hardware", "Type": "Category"},
    ]})
    items = qbp.list_purchase_items(None, "co-1")
    # Inventory items are never offered: Jigged owns stock.
    assert [i["id"] for i in items] == ["10", "11"]
    assert items[0] == {"id": "10", "name": "Raw material", "type": "NonInventory",
                        "posting_account_id": "1", "posting_account_name": "Job Materials"}


def test_qbd_purchase_items_read_one_way_and_two_way_posting_accounts(monkeypatch):
    pages = {
        "/non-inventory-items": {"data": [
            {"id": "N1", "fullName": "Jigged purchases",
             "salesOrPurchaseDetails": {"postingAccount": {"id": "A1", "fullName": "Job Materials"}}},
            {"id": "N2", "fullName": "Resale part",
             "salesAndPurchaseDetails": {"expenseAccount": {"id": "A2", "fullName": "Cost of Goods Sold"},
                                         "incomeAccount": {"id": "I1", "fullName": "Sales"}}},
        ], "hasMore": False, "nextCursor": None},
        "/service-items": {"data": [
            {"id": "S1", "fullName": "Anodize",
             "salesOrPurchaseDetails": {"postingAccount": {"id": "A3", "fullName": "Outside services"}}},
        ], "hasMore": False, "nextCursor": None},
    }
    monkeypatch.setattr(qbd, "_request", lambda method, path, **k: pages[path])
    items = qbdp.list_purchase_items("eu")
    assert [(i["id"], i["type"], i["posting_account_id"]) for i in items] == [
        ("N1", "non_inventory", "A1"), ("N2", "non_inventory", "A2"), ("S1", "service", "A3")]


def test_qbd_item_lists_follow_the_cursor(monkeypatch):
    seen = []

    def _fake_request(method, path, **kwargs):
        params = kwargs.get("params") or {}
        seen.append((path, params.get("cursor")))
        if path == "/non-inventory-items" and not params.get("cursor"):
            return {"data": [{"id": "N1", "fullName": "One",
                              "salesOrPurchaseDetails": {"postingAccount": {"id": "A"}}}],
                    "hasMore": True, "nextCursor": "c2"}
        if path == "/non-inventory-items":
            return {"data": [{"id": "N2", "fullName": "Two",
                              "salesOrPurchaseDetails": {"postingAccount": {"id": "A"}}}],
                    "hasMore": False, "nextCursor": None}
        return {"data": [], "hasMore": False}

    monkeypatch.setattr(qbd, "_request", _fake_request)
    assert [i["id"] for i in qbdp.list_purchase_items("eu")] == ["N1", "N2"]
    assert ("/non-inventory-items", "c2") in seen


@pytest.mark.parametrize(
    "item, invoice_ids, expected",
    [
        ({"id": "7", "name": "Machined Parts"}, (), True),
        ({"id": "7", "name": "  machined parts "}, (), True),
        ({"id": "9", "name": "Jigged purchases"}, ("9",), True),
        ({"id": "8", "name": "Jigged purchases"}, ("9", None), False),
    ],
)
def test_the_invoice_item_is_never_a_purchase_item(item, invoice_ids, expected):
    """Refused by id AND by name: the invoice item posts to income, so a PO on it
    would book purchases as negative revenue."""
    assert pom.is_invoice_item(item, invoice_item_ids=invoice_ids) is expected


def test_qbo_reuses_a_same_named_item_only_when_it_posts_to_the_chosen_account(monkeypatch):
    monkeypatch.setattr(qb, "qb_query", lambda *a, **k: {"Item": [
        {"Id": "10", "Name": "Jigged purchases", "Type": "NonInventory", "Active": True,
         "ExpenseAccountRef": {"value": "1", "name": "Job Materials"}}]})
    monkeypatch.setattr(qb, "qb_request", lambda *a, **k: pytest.fail("created a duplicate item"))
    item = qbp.create_purchase_item(None, "co-1", "Jigged purchases", "1", request_id="r-1")
    assert item["id"] == "10" and item["created"] is False


def test_qbo_refuses_a_same_named_item_on_another_account(monkeypatch):
    monkeypatch.setattr(qb, "qb_query", lambda *a, **k: {"Item": [
        {"Id": "10", "Name": "Jigged purchases", "Type": "NonInventory", "Active": True,
         "ExpenseAccountRef": {"value": "2", "name": "Repairs and Maintenance"}}]})
    monkeypatch.setattr(qb, "qb_request", lambda *a, **k: pytest.fail("created a duplicate item"))
    with pytest.raises(pom.PurchasingRefusal) as exc:
        qbp.create_purchase_item(None, "co-1", "Jigged purchases", "1", request_id="r-1")
    assert exc.value.code == "qb_item_name_taken"
    assert "Repairs and Maintenance" in exc.value.message


def test_qbo_creates_a_non_inventory_item_posting_only_to_the_expense_account(monkeypatch):
    sent = {}
    monkeypatch.setattr(qb, "qb_query", lambda *a, **k: {})

    def _fake_request(db, company_id, method, path, json_body=None, params=None):
        sent.update(method=method, path=path, body=json_body, params=params)
        return {"Item": {"Id": "20", "Name": json_body["Name"], "Type": "NonInventory",
                         "ExpenseAccountRef": {"value": "1", "name": "Job Materials"}}}

    monkeypatch.setattr(qb, "qb_request", _fake_request)
    item = qbp.create_purchase_item(None, "co-1", "Jigged purchases", "1", request_id="r-1")
    assert (sent["method"], sent["path"]) == ("POST", "item")
    assert sent["body"] == {"Name": "Jigged purchases", "Type": "NonInventory",
                            "ExpenseAccountRef": {"value": "1"}}
    assert sent["params"]["requestid"] == "r-1"
    assert item == {"id": "20", "name": "Jigged purchases", "type": "NonInventory",
                    "posting_account_id": "1", "posting_account_name": "Job Materials",
                    "created": True}


def test_qbd_item_names_longer_than_31_characters_are_refused():
    with pytest.raises(ValueError):
        qbdp.create_purchase_item("eu", "x" * 32, "A1")


def test_qbd_creates_a_one_way_non_inventory_item(monkeypatch):
    sent = {}
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [])

    def _fake_request(method, path, **kwargs):
        sent.update(method=method, path=path, **kwargs)
        return {"id": "N9", "fullName": "Jigged purchases",
                "salesOrPurchaseDetails": {"postingAccount": {"id": "A1", "fullName": "Job Materials"}}}

    monkeypatch.setattr(qbd, "_request", _fake_request)
    item = qbdp.create_purchase_item("eu", "Jigged purchases", "A1")
    assert (sent["method"], sent["path"]) == ("POST", "/non-inventory-items")
    assert sent["is_write"] is True
    body = sent["json_body"]
    assert body["name"] == "Jigged purchases"
    assert body["salesOrPurchaseDetails"]["postingAccountId"] == "A1"
    assert "salesAndPurchaseDetails" not in body
    assert item["id"] == "N9" and item["created"] is True


def test_qbd_reuses_a_same_named_item_only_on_the_same_account(monkeypatch):
    monkeypatch.setattr(qbd, "_list", lambda path, eu, params: [
        {"id": "N1", "name": "Jigged purchases", "fullName": "Jigged purchases", "isActive": True,
         "salesOrPurchaseDetails": {"postingAccount": {"id": "A1", "fullName": "Job Materials"}}}
    ] if path == "/non-inventory-items" else [])
    monkeypatch.setattr(qbd, "_request", lambda *a, **k: pytest.fail("created a duplicate"))
    assert qbdp.create_purchase_item("eu", "Jigged purchases", "A1")["id"] == "N1"
    with pytest.raises(pom.PurchasingRefusal) as exc:
        qbdp.create_purchase_item("eu", "Jigged purchases", "A2")
    assert exc.value.code == "qb_item_name_taken"
    assert "Job Materials" in exc.value.message


# ───────────────────────── vendors (QB6) ─────────────────────────
ATTEMPT = "7d9b8f1e-0000-4000-8000-000000000001"


def test_the_vendor_request_id_is_derived_from_the_attempt():
    """A resumed attempt re-sends the vendor create with the SAME id, so Intuit
    replays it instead of creating a second vendor -- and it is never the PO's own
    request id, because Intuit's requestid must be unique per company."""
    rid = qbp.vendor_request_id(ATTEMPT)
    assert rid == str(uuid.uuid5(uuid.UUID(ATTEMPT), "vendor"))
    assert rid != ATTEMPT


def test_qbo_vendor_create_sends_the_name_and_address(monkeypatch):
    sent = {}

    def _fake_request(db, company_id, method, path, json_body=None, params=None):
        sent.update(path=path, body=json_body, params=params)
        return {"Vendor": {"Id": "56"}}

    monkeypatch.setattr(qb, "qb_request", _fake_request)
    vid = qbp.create_vendor(None, "co-1", "Acme Anodizing",
                            {"address_line1": "1 Plating Way", "city": "Dayton", "state": "OH"},
                            request_id=qbp.vendor_request_id(ATTEMPT))
    assert vid == "56"
    assert sent["path"] == "vendor"
    assert sent["body"]["DisplayName"] == "Acme Anodizing"
    assert sent["body"]["CompanyName"] == "Acme Anodizing"
    assert sent["body"]["BillAddr"] == {"Line1": "1 Plating Way", "City": "Dayton",
                                        "CountrySubDivisionCode": "OH"}
    assert sent["params"]["requestid"] == qbp.vendor_request_id(ATTEMPT)


@pytest.mark.parametrize(
    "requery, expected",
    [
        ([{"Id": "57", "DisplayName": "Acme Anodizing", "Active": True}], "57"),
        ([{"Id": "58", "DisplayName": "Acme Anodizing", "Active": False}], "qb_vendor_inactive"),
        ([], "qb_vendor_name_taken"),
    ],
)
def test_qbo_6240_is_resolved_by_requerying(monkeypatch, requery, expected):
    """An active vendor of that name is a race we lost (use it); an inactive one
    must be reactivated by a human; none means a customer or employee holds it."""
    queries = []

    def _fake_request(*a, **k):
        raise _fault("6240", "Duplicate Name Exists Error")

    def _fake_query(db, company_id, query):
        queries.append(query)
        return {"Vendor": requery}

    monkeypatch.setattr(qb, "qb_request", _fake_request)
    monkeypatch.setattr(qb, "qb_query", _fake_query)
    if expected.startswith("qb_"):
        with pytest.raises(pom.PurchasingRefusal) as exc:
            qbp.create_vendor(None, "co-1", "Acme Anodizing", None, request_id="r")
        assert exc.value.code == expected
    else:
        assert qbp.create_vendor(None, "co-1", "Acme Anodizing", None, request_id="r") == expected
    assert "Active IN (true, false)" in queries[0]


def test_qbo_vendor_names_with_a_colon_are_refused_before_any_call(monkeypatch):
    monkeypatch.setattr(qb, "qb_request", lambda *a, **k: pytest.fail("sent a refused name"))
    with pytest.raises(pom.PurchasingRefusal) as exc:
        qbp.create_vendor(None, "co-1", "Acme: Plating", None, request_id="r")
    assert exc.value.code == "qb_vendor_name_invalid"


def test_qbd_vendor_names_over_41_characters_are_refused_never_truncated(monkeypatch):
    monkeypatch.setattr(qbd, "_request", lambda *a, **k: pytest.fail("sent a refused name"))
    with pytest.raises(pom.PurchasingRefusal) as exc:
        qbdp.create_vendor("eu", "Precision Anodizing and Plating Services of Ohio", None)
    assert exc.value.code == "qb_vendor_name_invalid"


def test_qbd_vendor_create_sends_name_company_and_capped_address(monkeypatch):
    sent = {}

    def _fake_request(method, path, **kwargs):
        sent.update(method=method, path=path, **kwargs)
        return {"id": "80000001-1"}

    monkeypatch.setattr(qbd, "_request", _fake_request)
    vid = qbdp.create_vendor("eu", "Acme Anodizing", {"address_line1": "L" * 60, "city": "C" * 40})
    assert vid == "80000001-1"
    assert (sent["method"], sent["path"], sent["is_write"]) == ("POST", "/vendors", True)
    assert sent["noun"] == "vendor"
    assert sent["json_body"]["name"] == "Acme Anodizing"
    assert sent["json_body"]["billingAddress"] == {"line1": "L" * 41, "city": "C" * 31}


@pytest.mark.parametrize(
    "found, expected",
    [
        ([{"id": "V1", "name": "Acme Anodizing", "isActive": True}], "V1"),
        ([{"id": "V2", "name": "Acme Anodizing", "isActive": False}], "qb_vendor_inactive"),
        ([], "qb_vendor_name_taken"),
    ],
)
def test_qbd_duplicate_name_is_resolved_by_an_exact_search(monkeypatch, found, expected):
    searches = []

    def _fake_request(*a, **k):
        raise qbd.QbdApiError("The name \"Acme Anodizing\" of the list element is already in use.",
                              integration_code="3100")

    def _fake_list(path, eu, params):
        searches.append(dict(params))
        return found

    monkeypatch.setattr(qbd, "_request", _fake_request)
    monkeypatch.setattr(qbd, "_list", _fake_list)
    if expected.startswith("qb_"):
        with pytest.raises(pom.PurchasingRefusal) as exc:
            qbdp.create_vendor("eu", "Acme Anodizing", None)
        assert exc.value.code == expected
    else:
        assert qbdp.create_vendor("eu", "Acme Anodizing", None) == expected
    assert searches[0]["nameContains"] == "Acme Anodizing"
    assert searches[0]["status"] == "all"


def test_a_qbd_vendor_create_that_timed_out_is_resolved_by_name(monkeypatch):
    """Never retried blind: names are unique in QuickBooks, so a lookup settles it --
    and when it does not, the shop is asked to try again rather than parked, because
    no purchase order was sent."""
    def _timeout(*a, **k):
        raise qbd.QbdUnknownOutcome("We couldn't confirm whether QuickBooks recorded that vendor.")

    monkeypatch.setattr(qbd, "_request", _timeout)
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [{"id": "V7", "name": "Acme Anodizing",
                                                         "isActive": True}])
    assert qbdp.create_vendor("eu", "Acme Anodizing", None) == "V7"
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [])
    with pytest.raises(pom.PurchasingRefusal) as exc:
        qbdp.create_vendor("eu", "Acme Anodizing", None)
    assert exc.value.code == "qbd_offline"


# ───────────────────────── ship method and preferences ─────────────────────────
def test_qbo_ship_method_is_the_text_itself():
    """QuickBooks Online has no ship-method entity to look up."""
    assert qbp.resolve_ship_method_id("UPS Ground") == "UPS Ground"
    assert qbp.resolve_ship_method_id("  ") is None


def test_qbd_ship_method_matches_by_name_and_never_creates(monkeypatch):
    calls = []

    def _fake_list(path, eu, params):
        calls.append((path, dict(params)))
        return [{"id": "SM1", "name": "UPS Ground Freight"}, {"id": "SM2", "name": "ups ground"}]

    monkeypatch.setattr(qbd, "_list", _fake_list)
    monkeypatch.setattr(qbd, "_request", lambda *a, **k: pytest.fail("created a ship method"))
    assert qbdp.resolve_ship_method_id("eu", "UPS Ground") == "SM2"
    assert calls == [("/shipping-methods", {"nameContains": "UPS Ground"})]
    monkeypatch.setattr(qbd, "_list", lambda *a, **k: [])
    assert qbdp.resolve_ship_method_id("eu", "Bob's Truck") is None


def test_qbd_ship_method_lookup_failure_omits_it(monkeypatch):
    def _offline(*a, **k):
        raise qbd.QbdOffline("offline")

    monkeypatch.setattr(qbd, "_list", _offline)
    assert qbdp.resolve_ship_method_id("eu", "UPS Ground") is None


def test_qbo_preferences_read_custom_numbers_from_other_prefs(monkeypatch):
    """Intuit documents the PO number rule under
    Preferences:OtherPrefs:NameValue.Name = VendorAndPurchasesPrefs.UseCustomTxnNumbers.
    Whether purchase orders are ON has no documented flag (UNVERIFIED, M-1): it is
    reported as unknown rather than guessed."""
    monkeypatch.setattr(qb, "qb_request", lambda *a, **k: {"Preferences": {"OtherPrefs": {"NameValue": [
        {"Name": "VendorAndPurchasesPrefs.UseCustomTxnNumbers", "Value": "false"},
        {"Name": "SalesFormsPrefs.DefaultItem", "Value": "1"},
    ]}}})
    assert qbp.check_purchasing_preferences(None, "co-1") == {
        "purchase_orders_enabled": None, "custom_txn_numbers": False}


def test_qbd_preferences_read_whether_inventory_and_pos_are_on(monkeypatch):
    monkeypatch.setattr(qbd, "_request", lambda *a, **k: {"purchasesAndVendors": {"isUsingInventory": True}})
    assert qbdp.check_purchasing_preferences("eu") == {
        "purchase_orders_enabled": True, "custom_txn_numbers": True}


# ───────────────────────── fake mode (QB12) ─────────────────────────
class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def order(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def execute(self):
        class _R:
            pass

        r = _R()
        r.data = self._rows
        return r


class _FakeDB:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return _Rows(self._tables.get(name, []))


@pytest.fixture
def fake_mode(monkeypatch):
    monkeypatch.setenv("QUICKBOOKS_FAKE", "1")

    def _boom(*a, **k):
        raise AssertionError("fake mode made a network call")

    monkeypatch.setattr(httpx, "Client", _boom)
    monkeypatch.setattr(qb, "qb_request", _boom)
    monkeypatch.setattr(qb, "qb_query", _boom)
    monkeypatch.setattr(qbd, "_request", _boom)
    monkeypatch.setattr(qbd, "_list", _boom)


FAKE_DB = _FakeDB({
    "quickbooks_purchase_order_links": [{"id": "link-1", "qb_po_id": "E2E-PO-1", "qb_sync_token": "3",
                                         "qb_closed": False, "qb_doc_number": "PO-1042"}],
    "quickbooks_purchase_order_line_links": [
        {"qb_line_id": "E2E-L-1", "qb_item_id": "E2E-ITEM-1", "vendor_purchase_order_line_id": "line-1"}],
})


def test_fake_mode_covers_every_online_call_deterministically(fake_mode):
    assert qbp.find_vendor_candidates(None, "co-1", "Acme")["status"] == "unmatched"
    first = qbp.create_vendor(None, "co-1", "Acme", None, request_id="r")
    assert first == qbp.create_vendor(None, "co-1", "Acme", None, request_id="other")
    assert first.startswith("E2E-")
    assert qbp.list_purchase_accounts(None, "co-1")
    assert qbp.list_ap_accounts(None, "co-1")
    assert qbp.list_purchase_items(None, "co-1")
    item = qbp.create_purchase_item(None, "co-1", "Jigged purchases", "E2E-ACCT-COGS", request_id="r")
    assert item["id"].startswith("E2E-")
    assert qbp.check_purchasing_preferences(None, "co-1")["custom_txn_numbers"] is True
    pushed = qbp.create_purchase_order(None, "co-1", {"DocNumber": "PO-1042", "Line": [{}, {}]},
                                       request_id="7d9b8f1e-aaaa")
    assert pushed.id == "E2E-PO-7d9b8f1e"
    assert pushed.doc_number == "PO-1042"
    assert len(pushed.line_ids) == 2
    state = qbp.read_purchase_order(FAKE_DB, "co-1", "E2E-PO-1")
    assert isinstance(state, QbPurchaseOrderState)
    assert state.sync_token == "3" and state.line_ids == ("E2E-L-1",)
    updated = qbp.update_purchase_order(
        None, "co-1", "E2E-PO-1",
        {"Id": "E2E-PO-1", "SyncToken": "3", "sparse": True, "Line": [{"Id": "E2E-L-1"}, {}]},
        request_id="99999999-bbbb")
    assert updated.sync_token == "4"
    assert updated.line_ids[0] == "E2E-L-1" and len(updated.line_ids) == 2


def test_fake_mode_covers_every_desktop_call_deterministically(fake_mode):
    assert qbdp.find_vendor_candidates("eu", "Acme")["status"] == "unmatched"
    assert qbdp.create_vendor("eu", "Acme", None).startswith("E2E-")
    assert qbdp.list_purchase_accounts("eu")
    assert qbdp.list_purchase_items("eu")
    assert qbdp.create_purchase_item("eu", "Jigged purchases", "E2E-ACCT-COGS")["id"].startswith("E2E-")
    assert qbdp.resolve_ship_method_id("eu", "UPS Ground").startswith("E2E-")
    assert qbdp.check_purchasing_preferences("eu")["purchase_orders_enabled"] is True
    pushed = qbdp.create_purchase_order("eu", {"refNumber": "PO-1042", "lines": [{}]},
                                        request_id="7d9b8f1e-aaaa")
    assert pushed.id == "E2E-PO-7d9b8f1e" and pushed.doc_number == "PO-1042"
    assert qbdp.read_purchase_order("eu", "E2E-PO-1", db=FAKE_DB, company_id="co-1").line_ids == ("E2E-L-1",)
    updated = qbdp.update_purchase_order("eu", "E2E-PO-1",
                                         {"revisionNumber": "3", "lines": [{"id": "E2E-L-1"}, {"id": "-1"}]},
                                         request_id="99999999-bbbb")
    assert updated.sync_token == "4" and updated.line_ids[0] == "E2E-L-1"
    assert qbdp.find_created_purchase_order("eu", qb_vendor_id="V", transaction_date="2026-11-09",
                                            external_id="x") is None


def test_fake_mode_is_inert_in_production(monkeypatch):
    """A stray QUICKBOOKS_FAKE in production must never fake a real PO."""
    monkeypatch.setenv("QUICKBOOKS_FAKE", "1")
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "production")

    class _Reached(Exception):
        pass

    def _reached(*a, **k):
        raise _Reached()

    monkeypatch.setattr(qb, "qb_request", _reached)
    monkeypatch.setattr(qbd, "_request", _reached)
    with pytest.raises(_Reached):
        qbp.create_purchase_order(None, "co-1", {"Line": []}, request_id="r")
    with pytest.raises(_Reached):
        qbdp.create_purchase_order("eu", {"lines": []}, request_id="r")


# ───────────────────────── never bills or item receipts (QB3) ─────────────────────────
def _code_words(path: Path) -> list[str]:
    """Every identifier and non-docstring string constant in a module. Prose in
    docstrings and comments may SAY "Jigged never creates bills"; code may not
    reach for one."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(getattr(body[0], "value", None), ast.Constant):
                docstrings.add(id(body[0].value))
    words: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            words.append(node.value)
        elif isinstance(node, ast.Name):
            words.append(node.id)
        elif isinstance(node, ast.Attribute):
            words.append(node.attr)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            words.append(node.name)
        elif isinstance(node, ast.keyword) and node.arg:
            words.append(node.arg)
    return words


@pytest.mark.parametrize("path", NEW_MODULES, ids=lambda p: p.name)
def test_no_new_module_reaches_for_a_bill_or_an_item_receipt(path):
    import re

    assert path.exists(), path
    forbidden = [
        re.compile(r"(^|/)bills?($|/|\?)"),           # QBO /bill, QBD /bills
        re.compile(r"\bBill\b"),                       # the QBO entity (not BillAddr)
        re.compile(r"(?i)item[-_ ]?receipts?"),        # QBD /item-receipts, any ItemReceipt
        re.compile(r"(?i)^(create|push|enter)_?bills?$"),
        re.compile(r"(?i)linkToTransaction"),          # how a bill or receipt links a PO line
    ]
    hits = [w for w in _code_words(path) for pattern in forbidden if pattern.search(w)]
    assert not hits, f"{path.name} references a bill or item receipt: {hits}"
