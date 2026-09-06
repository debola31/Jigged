"""Unit tests for services.quickbooks (no DB, no network).

Covers the pieces a reviewer flagged as load-bearing: the tax/rounding mapping,
the compare-and-set token refresh (and its invalid_grant branches), QBO query
escaping, and customer resolution tiers.

Plus the read-only invoice payment mirror (2026-09-03): the status rule, the strict
query wrapper that refuses to read an unreadable answer as "no rows", the chunked
invoice fetch and its confirm-before-missing rule, and the freshness decision that
makes opening the Invoices menu ask Intuit only when it has to.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.quickbooks as qb  # noqa: E402


# ───────────────────────── fakes ─────────────────────────
class _Resp:
    def __init__(self, data):
        self.data = data


class _FakeTable:
    """Emulates the supabase-py chain for a single keyed store, including the
    compare-and-set semantics of update().eq(...).eq(...)."""

    def __init__(self, store: dict):
        self.store = store
        self._op = None
        self._filters: dict = {}
        self._payload = None

    def select(self, *a, **k):
        self._op = "select"
        return self

    def update(self, payload):
        self._op = "update"
        self._payload = payload
        return self

    def insert(self, payload):
        self._op = "insert"
        self._payload = payload
        return self

    def upsert(self, payload, **k):
        self._op = "upsert"
        self._payload = payload
        return self

    def delete(self):
        self._op = "delete"
        return self

    def eq(self, col, val):
        self._filters[col] = val
        return self

    def limit(self, n):
        return self

    def order(self, *a, **k):
        return self

    def in_(self, col, vals):
        self._filters[(col, "in")] = vals
        return self

    def execute(self):
        cid = self._filters.get("company_id")
        row = self.store.get(cid)
        if self._op == "select":
            return _Resp([row] if row else [])
        if self._op == "update":
            if row is None:
                return _Resp([])
            for col, val in self._filters.items():
                if isinstance(col, tuple):
                    continue
                if row.get(col) != val:
                    return _Resp([])  # CAS miss
            row.update(self._payload)
            return _Resp([row])
        if self._op in ("insert", "upsert"):
            r = dict(self._payload)
            self.store[r["company_id"]] = r
            return _Resp([r])
        if self._op == "delete":
            self.store.pop(cid, None)
            return _Resp([])
        return _Resp([])


class _FakeDB:
    def __init__(self, store: dict):
        self.store = store

    def table(self, name):
        return _FakeTable(self.store)


class _FakeResponse:
    def __init__(self, status_code: int, json_data=None, text="", headers=None):
        self.status_code = status_code
        self._json = json_data
        self.text = text or (json.dumps(json_data) if json_data is not None else "")
        self.content = self.text.encode()
        self.headers = headers if headers is not None else {"intuit_tid": "tid-test"}

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class _FakeClient:
    def __init__(self, response):
        self._response = response

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def post(self, *a, **k):
        return self._response

    def request(self, *a, **k):
        return self._response


@pytest.fixture(autouse=True)
def _base_env(monkeypatch):
    monkeypatch.setenv("QUICK_BOOKS_CLIENT_ID", "cid_test")
    monkeypatch.setenv("QUICK_BOOKS_CLIENT_SECRET", "secret_test")
    monkeypatch.setenv("QUICKBOOKS_REDIRECT_URI", "http://localhost:8000/api/quickbooks/callback")
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "sandbox")
    monkeypatch.delenv("QUICKBOOKS_MINOR_VERSION", raising=False)


def _conn(**over) -> dict:
    base = {
        "company_id": "co1",
        "realm_id": "realm-123",
        "environment": "sandbox",
        "access_token": "access-old",
        "access_expires_at": (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat(),
        "refresh_token": "refresh-old",
        "refresh_expires_at": (datetime.now(timezone.utc) + timedelta(days=100)).isoformat(),
        "token_version": 3,
        "reconnect_required": False,
    }
    base.update(over)
    return base


def _bundle(access="access-new", refresh="refresh-new", seconds=3600) -> qb.TokenBundle:
    now = datetime.now(timezone.utc)
    return qb.TokenBundle(
        access_token=access,
        refresh_token=refresh,
        access_expires_at=now + timedelta(seconds=seconds),
        refresh_expires_at=now + timedelta(days=100),
    )


# ───────────────────────── config / env ─────────────────────────
def test_environment_and_api_base(monkeypatch):
    assert qb._environment() == "sandbox"
    assert qb._api_base() == qb.SANDBOX_API_BASE
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "production")
    assert qb._api_base() == qb.PROD_API_BASE


@pytest.mark.parametrize("environment", ["sandbox", "production"])
def test_client_credentials_missing_raises(monkeypatch, environment):
    """Raises in production too. Until 2026-08-15 production read
    QUICKBOOKS_PROD_CLIENT_ID and fell back to this name, so a production
    deployment missing its own credential quietly used another environment's
    Intuit app instead of saying so."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", environment)
    monkeypatch.delenv("QUICK_BOOKS_CLIENT_ID", raising=False)
    with pytest.raises(qb.QuickBooksServiceUnavailable):
        qb._client_credentials()


@pytest.mark.parametrize("environment", ["sandbox", "production"])
def test_client_credentials_read_one_name_in_every_environment(monkeypatch, environment):
    """The regression guard for the 2026-08-15 simplification: reintroducing a
    QUICKBOOKS_PROD_* name would stop production reading the value Vercel holds
    for it, and the old fallback would hide that until token refresh."""
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", environment)
    monkeypatch.setenv("QUICK_BOOKS_CLIENT_ID", "cid-for-this-environment")
    monkeypatch.setenv("QUICK_BOOKS_CLIENT_SECRET", "secret-for-this-environment")
    # Set the retired names to values that would be visibly wrong if read.
    monkeypatch.setenv("QUICKBOOKS_PROD_CLIENT_ID", "retired-prod-name")
    monkeypatch.setenv("QUICKBOOKS_CLIENT_ID", "retired-alt-name")
    assert qb._client_credentials() == ("cid-for-this-environment", "secret-for-this-environment")


def test_minor_version_default_and_override(monkeypatch):
    assert qb._minor_version() == qb.DEFAULT_MINOR_VERSION
    monkeypatch.setenv("QUICKBOOKS_MINOR_VERSION", "99")
    assert qb._minor_version() == "99"


def test_build_authorize_url():
    url = qb.build_authorize_url("state-xyz")
    assert url.startswith(qb.AUTH_BASE + "?")
    assert "client_id=cid_test" in url
    assert "scope=com.intuit.quickbooks.accounting" in url
    assert "response_type=code" in url
    assert "state=state-xyz" in url
    assert "redirect_uri=http%3A%2F%2Flocalhost%3A8000" in url


def test_escape_qb_literal():
    assert qb._escape_qb_literal("O'Brien Tool") == "O\\'Brien Tool"
    assert qb._escape_qb_literal("back\\slash") == "back\\\\slash"


# ───────────────────────── mapping ─────────────────────────
def test_payload_basic_taxcode_and_item():
    payload = qb.quote_to_invoice_payload(
        customer_ref="42",
        item_ref="7",
        job_number="J-2026-0001",
        bill_addr={"Line1": "1 Main St", "City": "Detroit"},
        lines=[
            {"quantity": 10, "unit_price": 12.5, "part_name": "Bracket", "description": "Rev C"},
            {"quantity": 2, "unit_price": 100.0, "part_name": "Shaft", "description": None},
        ],
    )
    assert payload["CustomerRef"] == {"value": "42"}
    # DocNumber is omitted so QBO auto-assigns; the job number lives in the memo.
    assert "DocNumber" not in payload
    assert payload["PrivateNote"] == "Jigged job J-2026-0001"
    assert payload["BillAddr"]["City"] == "Detroit"
    assert len(payload["Line"]) == 2
    line0 = payload["Line"][0]
    assert line0["DetailType"] == "SalesItemLineDetail"
    assert line0["Amount"] == 125.0
    assert line0["Description"] == "Bracket — Rev C"
    detail = line0["SalesItemLineDetail"]
    assert detail["ItemRef"] == {"value": "7"}
    assert detail["Qty"] == 10
    assert detail["UnitPrice"] == 12.5
    # Every line must be explicitly non-taxable (AST default is TAXABLE on omit).
    assert detail["TaxCodeRef"] == {"value": "NON"}
    assert payload["Line"][1]["Description"] == "Shaft"


def test_payload_includes_customer_po_in_memo_and_lines():
    payload = qb.quote_to_invoice_payload(
        customer_ref="42",
        item_ref="7",
        job_number="J-2026-0001",
        customer_po_number="PO-789",
        bill_addr=None,
        lines=[
            {"quantity": 1, "unit_price": 5.0, "part_name": "Bracket", "description": "Rev C"},
            {"quantity": 2, "unit_price": 3.0, "part_name": "Shaft", "description": None},
        ],
    )
    # PO number is appended to the memo alongside the job number.
    assert payload["PrivateNote"] == "Jigged job J-2026-0001 · PO Number: PO-789"
    # ...and to every line Description, after the part identity.
    assert payload["Line"][0]["Description"] == "Bracket — Rev C (PO Number: PO-789)"
    assert payload["Line"][1]["Description"] == "Shaft (PO Number: PO-789)"


def test_payload_po_only_memo_without_job_number():
    payload = qb.quote_to_invoice_payload(
        customer_ref="1",
        item_ref="1",
        job_number=None,
        customer_po_number="PO-12",
        bill_addr=None,
        lines=[{"quantity": 1, "unit_price": 5.0, "part_name": "P", "description": None}],
    )
    assert payload["PrivateNote"] == "PO Number: PO-12"
    assert payload["Line"][0]["Description"] == "P (PO Number: PO-12)"


def test_payload_no_po_leaves_lines_and_memo_unchanged():
    payload = qb.quote_to_invoice_payload(
        customer_ref="1",
        item_ref="1",
        job_number="J-0007",
        customer_po_number=None,
        bill_addr=None,
        lines=[{"quantity": 1, "unit_price": 5.0, "part_name": "P", "description": None}],
    )
    assert payload["PrivateNote"] == "Jigged job J-0007"
    assert payload["Line"][0]["Description"] == "P"


def test_payload_rounding_reconciles_to_total():
    lines = [
        {"quantity": 3, "unit_price": 12.3456, "part_name": "A", "description": None},
        {"quantity": 7, "unit_price": 0.9999, "part_name": "B", "description": None},
    ]
    payload = qb.quote_to_invoice_payload(
        customer_ref="1", item_ref="1", job_number=None, bill_addr=None, lines=lines
    )
    amounts = [ln["Amount"] for ln in payload["Line"]]
    assert amounts[0] == round(3 * 12.3456, 2)  # 37.04
    assert amounts[1] == round(7 * 0.9999, 2)  # 7.00
    # The invoice total is the sum of the rounded line amounts.
    assert round(sum(amounts), 2) == 44.04


def test_payload_null_price_raises():
    with pytest.raises(qb.QuickBooksApiError):
        qb.quote_to_invoice_payload(
            customer_ref="1",
            item_ref="1",
            job_number=None,
            bill_addr=None,
            lines=[{"quantity": 1, "unit_price": None, "part_name": "X", "description": None}],
        )


def test_payload_memo_and_billaddr_optional():
    payload = qb.quote_to_invoice_payload(
        customer_ref="1",
        item_ref="1",
        job_number="J-0007",
        bill_addr=None,
        lines=[{"quantity": 1, "unit_price": 5.0, "part_name": "P", "description": None}],
    )
    assert "DocNumber" not in payload  # QBO auto-assigns
    assert payload["PrivateNote"] == "Jigged job J-0007"
    assert "BillAddr" not in payload


def test_invoice_deep_link_uses_the_form_that_survives_sign_in():
    """The /login?pagereq= shape, not /app/invoice?txnId=.

    Traced live against both hosts: opening /app/invoice?txnId=130 with no QBO
    session bounces to accounts.intuit.com and leaves
    qbo.deeplink={"pagereq":"invoice"} — the transaction id is dropped, which is
    why the user landed on a blank NEW invoice. The /login form leaves
    qbo.deeplink={"pagereq":"invoice?txnId=130"} and adds account_id_hint, so
    both the transaction AND the company survive the bounce.
    """
    assert qb.invoice_deep_link("sandbox", "130", "9341457314157411") == (
        "https://sandbox.qbo.intuit.com/login"
        "?deeplinkcompanyid=9341457314157411&pagereq=invoice%3FtxnId%3D130"
    )
    assert qb.invoice_deep_link("production", "130", "1234567890") == (
        "https://qbo.intuit.com/login"
        "?deeplinkcompanyid=1234567890&pagereq=invoice%3FtxnId%3D130"
    )


def test_invoice_deep_link_falls_back_without_a_realm():
    """No realm -> the plain link. Degraded (loses the transaction on a cold
    session) but never broken, and it keeps older stored links meaningful."""
    assert qb.invoice_deep_link("sandbox", "130") == (
        "https://sandbox.qbo.intuit.com/app/invoice?txnId=130"
    )


# ───────────────────────── token lifecycle ─────────────────────────
def test_fresh_token_skips_refresh(monkeypatch):
    store = {"co1": _conn()}  # expires in 1h -> not refreshing
    called = {"refresh": 0}
    monkeypatch.setattr(qb, "refresh_tokens", lambda rt: called.__setitem__("refresh", called["refresh"] + 1))
    token, realm = qb.ensure_fresh_access_token(_FakeDB(store), "co1")
    assert token == "access-old"
    assert realm == "realm-123"
    assert called["refresh"] == 0


def test_refresh_rotates_and_persists_via_cas(monkeypatch):
    store = {"co1": _conn(access_expires_at=datetime.now(timezone.utc).isoformat())}  # expiring -> refresh
    monkeypatch.setattr(qb, "refresh_tokens", lambda rt: _bundle("access-new", "refresh-new"))
    token, _ = qb.ensure_fresh_access_token(_FakeDB(store), "co1")
    assert token == "access-new"
    # Rotated refresh token persisted + version bumped (CAS from 3 -> 4).
    assert store["co1"]["refresh_token"] == "refresh-new"
    assert store["co1"]["token_version"] == 4


def test_invalid_grant_unchanged_version_sets_reconnect(monkeypatch):
    store = {"co1": _conn(access_expires_at=datetime.now(timezone.utc).isoformat())}

    def _raise(rt):
        raise qb._InvalidGrant("invalid_grant")

    monkeypatch.setattr(qb, "refresh_tokens", _raise)
    with pytest.raises(qb.QuickBooksNotConnected):
        qb.ensure_fresh_access_token(_FakeDB(store), "co1")
    assert store["co1"]["reconnect_required"] is True


def test_invalid_grant_sibling_rotated_uses_new_token(monkeypatch):
    store = {"co1": _conn(access_expires_at=datetime.now(timezone.utc).isoformat())}

    def _sibling_then_fail(rt):
        # Simulate a concurrent sibling that rotated + persisted just before us.
        store["co1"]["token_version"] = 4
        store["co1"]["access_token"] = "access-sibling"
        store["co1"]["access_expires_at"] = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        raise qb._InvalidGrant("invalid_grant")

    monkeypatch.setattr(qb, "refresh_tokens", _sibling_then_fail)
    token, _ = qb.ensure_fresh_access_token(_FakeDB(store), "co1")
    assert token == "access-sibling"
    assert store["co1"]["reconnect_required"] is False


def test_cas_miss_uses_stored_token(monkeypatch):
    store = {"co1": _conn(access_expires_at=datetime.now(timezone.utc).isoformat())}

    def _refresh_but_bump_version(rt):
        # A sibling bumps the version after we read but before our CAS update,
        # so our update (filtered on the old version) affects 0 rows.
        store["co1"]["token_version"] = 99
        store["co1"]["access_token"] = "access-sibling"
        store["co1"]["access_expires_at"] = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        return _bundle("access-mine", "refresh-mine")

    monkeypatch.setattr(qb, "refresh_tokens", _refresh_but_bump_version)
    token, _ = qb.ensure_fresh_access_token(_FakeDB(store), "co1")
    # CAS missed -> fall back to the stored (sibling's) token, not ours.
    assert token == "access-sibling"


def test_no_connection_raises():
    with pytest.raises(qb.QuickBooksNotConnected):
        qb.ensure_fresh_access_token(_FakeDB({}), "co1")


def test_env_mismatch_raises(monkeypatch):
    store = {"co1": _conn(environment="production")}
    with pytest.raises(qb.QuickBooksNotConnected):
        qb.ensure_fresh_access_token(_FakeDB(store), "co1")


def test_reconnect_required_raises():
    store = {"co1": _conn(reconnect_required=True)}
    with pytest.raises(qb.QuickBooksNotConnected):
        qb.ensure_fresh_access_token(_FakeDB(store), "co1")


def test_persist_connection_clears_reconnect_flag():
    store = {"co1": _conn(reconnect_required=True, token_version=5)}
    qb.persist_connection(_FakeDB(store), "co1", "realm-123", _bundle())
    assert store["co1"]["reconnect_required"] is False
    assert store["co1"]["token_version"] == 6  # bumped on reconnect


# ───────────────────────── token exchange over httpx ─────────────────────────
def test_exchange_code_parses_tokens(monkeypatch):
    resp = _FakeResponse(
        200,
        json_data={
            "access_token": "AT",
            "refresh_token": "RT",
            "expires_in": 3600,
            "x_refresh_token_expires_in": 8640000,
        },
    )
    monkeypatch.setattr(qb.httpx, "Client", lambda *a, **k: _FakeClient(resp))
    bundle = qb.exchange_code_for_tokens("the-code")
    assert bundle.access_token == "AT"
    assert bundle.refresh_token == "RT"
    assert bundle.refresh_expires_at is not None


def test_refresh_detects_invalid_grant(monkeypatch):
    resp = _FakeResponse(400, text='{"error":"invalid_grant"}')
    monkeypatch.setattr(qb.httpx, "Client", lambda *a, **k: _FakeClient(resp))
    with pytest.raises(qb._InvalidGrant):
        qb.refresh_tokens("dead-token")


def test_api_error_captures_intuit_tid(monkeypatch):
    resp = _FakeResponse(500, json_data={"error": "server_error"}, headers={"intuit_tid": "tid-xyz"})
    monkeypatch.setattr(qb.httpx, "Client", lambda *a, **k: _FakeClient(resp))
    with pytest.raises(qb.QuickBooksApiError) as exc:
        qb.refresh_tokens("rt")
    assert exc.value.tid == "tid-xyz"
    assert exc.value.status == 500


# ───────────────────────── customer resolution ─────────────────────────
def test_find_customer_exact(monkeypatch):
    monkeypatch.setattr(qb, "qb_query", lambda db, co, q: {"Customer": [{"Id": "9", "DisplayName": "Acme"}]})
    res = qb.find_customer_candidates(_FakeDB({}), "co1", "Acme")
    assert res["status"] == "exact_match"
    assert res["qb_customer_id"] == "9"


def test_find_customer_candidates_then_unmatched(monkeypatch):
    calls = {"n": 0}

    def _q(db, co, query):
        calls["n"] += 1
        if "DisplayName = " in query:
            return {"Customer": []}  # no exact
        return {"Customer": [{"Id": "5", "DisplayName": "Acme, Inc."}]}  # fuzzy

    monkeypatch.setattr(qb, "qb_query", _q)
    res = qb.find_customer_candidates(_FakeDB({}), "co1", "Acme")
    assert res["status"] == "candidates"
    assert res["candidates"][0]["qb_id"] == "5"

    monkeypatch.setattr(qb, "qb_query", lambda db, co, q: {"Customer": []})
    res2 = qb.find_customer_candidates(_FakeDB({}), "co1", "Nobody")
    assert res2["status"] == "unmatched"


def test_create_customer_duplicate_links_existing(monkeypatch):
    def _req(db, co, method, path, json_body=None, params=None):
        raise qb.QuickBooksApiError("dup", status=400, fault={"Fault": {"Error": [{"Message": "Duplicate Name Exists Error"}]}})

    monkeypatch.setattr(qb, "qb_request", _req)
    monkeypatch.setattr(qb, "qb_query", lambda db, co, q: {"Customer": [{"Id": "77", "DisplayName": "Acme"}]})
    cid = qb.create_customer(_FakeDB({}), "co1", "Acme")
    assert cid == "77"


# ─────────────────────── terms + PO placement ───────────────────────
# Every assertion below was verified against a live QuickBooks sandbox before
# being written; the comments record what was observed, not what was assumed.


def test_payload_sends_sales_term_and_never_a_due_date():
    """SalesTermRef alone — DueDate is deliberately omitted.

    Verified live: supplying BOTH lets them disagree. An invoice pushed with
    SalesTermRef=Net 60 and DueDate=TxnDate+7 stored the +7 date while still
    reporting Net 60, so the printed invoice read "Terms: Net 60" beside a due
    date a week out. With the term alone, QBO derived 2026-09-30 from a
    2026-08-01 invoice — correct.
    """
    payload = qb.quote_to_invoice_payload(
        customer_ref="42",
        item_ref="7",
        job_number="J-0001",
        bill_addr=None,
        lines=[{"quantity": 1, "unit_price": 5.0, "part_name": "P", "description": None}],
        sales_term_id="4",
    )
    assert payload["SalesTermRef"] == {"value": "4"}
    assert "DueDate" not in payload


def test_payload_without_a_term_sends_no_sales_term_ref():
    """No term resolved -> the field is absent, not null.

    This is the pre-existing behaviour and it is NOT harmless: five real sandbox
    invoices pushed this way all came back with a due date of exactly TxnDate+30
    from a QuickBooks company default that nothing in Jigged chose. Keeping the
    key absent (rather than sending null) is what lets QBO apply that fallback
    without erroring, so a term Jigged cannot resolve degrades to today's
    behaviour instead of failing the push.
    """
    payload = qb.quote_to_invoice_payload(
        customer_ref="42", item_ref="7", job_number="J-0001", bill_addr=None,
        lines=[{"quantity": 1, "unit_price": 5.0, "part_name": "P", "description": None}],
    )
    assert "SalesTermRef" not in payload
    assert "DueDate" not in payload


def test_po_goes_to_customer_memo_which_actually_prints():
    """CustomerMemo is the placement that reaches the customer with zero setup.

    Verified by pulling the invoice PDF: it renders under "Note to customer".
    PrivateNote does NOT print — Intuit documents it as "does not appear on the
    invoice to the customer" — so the memo is what makes the PO visible to an AP
    department on a company that has configured nothing.
    """
    payload = qb.quote_to_invoice_payload(
        customer_ref="1", item_ref="1", job_number="J-0007",
        customer_po_number="PO-789", bill_addr=None,
        lines=[{"quantity": 1, "unit_price": 5.0, "part_name": "P", "description": None}],
    )
    assert payload["CustomerMemo"] == {"value": "PO Number: PO-789"}
    # ...and the two pre-existing placements are untouched. The line suffix is
    # what the pilot shop's AP is already paying from; it must never regress.
    assert payload["Line"][0]["Description"] == "P (PO Number: PO-789)"
    assert payload["PrivateNote"] == "Jigged job J-0007 · PO Number: PO-789"


def test_no_custom_field_when_the_shop_has_not_configured_one():
    """The default state — and the one that must never guess.

    Verified live that an unconfigured company reports only three booleans, all
    false, with no field names at all. Writing to a guessed DefinitionId would
    silently overwrite whatever the shop keeps in that slot (commonly "Sales
    Rep" or "Job #") and the slot mapping cannot be reassigned afterwards.
    """
    payload = qb.quote_to_invoice_payload(
        customer_ref="1", item_ref="1", job_number=None,
        customer_po_number="PO-12", bill_addr=None,
        lines=[{"quantity": 1, "unit_price": 5.0, "part_name": "P", "description": None}],
        po_custom_field_id=None,
    )
    assert "CustomField" not in payload


def test_custom_field_used_only_when_discovery_supplied_an_id():
    payload = qb.quote_to_invoice_payload(
        customer_ref="1", item_ref="1", job_number=None,
        customer_po_number="PO-12", bill_addr=None,
        lines=[{"quantity": 1, "unit_price": 5.0, "part_name": "P", "description": None}],
        po_custom_field_id="2",
        po_custom_field_name="Customer PO #",
    )
    assert payload["CustomField"] == [
        {"DefinitionId": "2", "Type": "StringType",
         "StringValue": "PO-12", "Name": "Customer PO #"}
    ]


def test_no_po_means_no_memo_and_no_custom_field():
    payload = qb.quote_to_invoice_payload(
        customer_ref="1", item_ref="1", job_number="J-0007", bill_addr=None,
        lines=[{"quantity": 1, "unit_price": 5.0, "part_name": "P", "description": None}],
        po_custom_field_id="1",
    )
    assert "CustomerMemo" not in payload
    assert "CustomField" not in payload


def test_parse_net_days_reads_common_term_shapes():
    """Falls back to 0 (due on receipt) on anything unreadable — the
    conservative direction: a term we cannot parse should ask for payment
    sooner, never silently extend credit."""
    assert qb._parse_net_days("Net 30") == 30
    assert qb._parse_net_days("net30") == 30
    assert qb._parse_net_days("2/10 Net 60") == 60
    assert qb._parse_net_days("50% Deposit / Balance Net 30") == 30
    assert qb._parse_net_days("Due on Receipt") == 0
    assert qb._parse_net_days("Cash on Delivery") == 0
    assert qb._parse_net_days("") == 0


def test_po_field_pattern_matches_real_shop_labels():
    """Discovery matches on the shop's LABEL, never on slot position — Intuit
    states definitions "may not appear in numeric order" in Preferences."""
    for label in ("PO Number", "PO #", "Customer PO", "customer purchase order", "P.O."):
        assert qb._PO_FIELD_PATTERN.search(label), label
    for label in ("Sales Rep", "Job #", "Crew", "Priority"):
        assert not qb._PO_FIELD_PATTERN.search(label), label


def test_resolve_term_id_matches_the_truncated_name_it_created(monkeypatch):
    """QBO caps Term.Name at 31 chars, so a longer Jigged term is stored short.

    The lookup has to accept BOTH spellings. Matching only the full string would
    miss the truncated row we created ourselves, re-POST the identical name, and
    take QBO's duplicate-name 400 — so the first invoice on a job would carry a
    SalesTermRef and every later one would silently carry none."""
    long_term = "Net 30 from date of shipment, 1.5%/mo"
    assert len(long_term) > qb._QB_TERM_NAME_MAX
    stored = long_term[: qb._QB_TERM_NAME_MAX]

    monkeypatch.setattr(
        qb, "list_qb_terms", lambda db, cid: [{"id": "9", "name": stored, "due_days": 30}]
    )

    def _must_not_create(*args, **kwargs):
        raise AssertionError("re-created a term that already exists in QuickBooks")

    monkeypatch.setattr(qb, "qb_request", _must_not_create)
    assert qb.resolve_term_id(None, "c1", long_term) == "9"


def test_resolve_term_id_creates_within_the_name_cap(monkeypatch):
    """A term QBO does not have is created under the truncated name — the same
    string the lookup above will match on the next push."""
    long_term = "Net 30 from date of shipment, 1.5%/mo"
    monkeypatch.setattr(qb, "list_qb_terms", lambda db, cid: [])
    sent: dict = {}

    def _capture(db, cid, method, path, json_body=None):
        sent.update(json_body or {})
        return {"Term": {"Id": "12"}}

    monkeypatch.setattr(qb, "qb_request", _capture)
    assert qb.resolve_term_id(None, "c1", long_term) == "12"
    assert sent["Name"] == long_term[: qb._QB_TERM_NAME_MAX]
    assert len(sent["Name"]) <= qb._QB_TERM_NAME_MAX
    assert sent["DueDays"] == 30


def test_resolve_term_id_is_case_insensitive(monkeypatch):
    """QBO ships "Due on receipt"; Jigged's preset is "Due on Receipt". A
    case-sensitive compare would try to create it, and creating a Term whose
    name already exists is rejected with HTTP 400 (verified live) — failing the
    push on the most common term in the list."""
    monkeypatch.setattr(
        qb, "list_qb_terms", lambda db, cid: [{"id": "1", "name": "Due on receipt", "due_days": 0}]
    )
    assert qb.resolve_term_id(None, "c1", "Due on Receipt") == "1"


def test_discover_po_custom_field_raises_when_it_cannot_ask(monkeypatch):
    """"Couldn't check" must never be reported as "there is no field".

    The caller persists this result, so swallowing the error would let one
    Intuit blip wipe a correctly discovered field id and silently stop the PO
    reaching invoices."""
    def _boom(*args, **kwargs):
        raise RuntimeError("intuit is down")

    monkeypatch.setattr(qb, "qb_query", _boom)
    with pytest.raises(RuntimeError):
        qb.discover_po_custom_field(None, "c1")


def test_discover_po_custom_field_reports_none_for_an_unconfigured_company(monkeypatch):
    """An answered question with a negative answer IS returned as None — that is
    the ordinary starting state, and it must stay distinguishable from the
    unanswered case above."""
    monkeypatch.setattr(qb, "qb_query", lambda *a, **k: {"Preferences": [{}]})
    assert qb.discover_po_custom_field(None, "c1") == {
        "id": None, "name": None, "candidates": []
    }


def test_discover_po_custom_field_matches_label_not_slot(monkeypatch):
    """Slot 1 is "Sales Rep" here and the PO lives in slot 3. Writing to a
    guessed DefinitionId would overwrite whatever the shop keeps in that slot,
    and the mapping cannot be reassigned afterwards."""
    prefs = {
        "Preferences": [
            {
                "SalesFormsPrefs": {
                    "CustomField": [
                        {
                            "CustomField": [
                                {"Name": "SalesFormsPrefs.UseSalesCustom1", "BooleanValue": True},
                                {"Name": "SalesFormsPrefs.SalesCustomName1",
                                 "StringValue": "Sales Rep"},
                                {"Name": "SalesFormsPrefs.UseSalesCustom3", "BooleanValue": True},
                                {"Name": "SalesFormsPrefs.SalesCustomName3",
                                 "StringValue": "Customer PO #"},
                            ]
                        }
                    ]
                }
            }
        ]
    }
    monkeypatch.setattr(qb, "qb_query", lambda *a, **k: prefs)
    found = qb.discover_po_custom_field(None, "c1")
    assert found["id"] == "3"
    assert found["name"] == "Customer PO #"
    assert {c["name"] for c in found["candidates"]} == {"Sales Rep", "Customer PO #"}


def test_discover_po_custom_field_ignores_a_disabled_slot(monkeypatch):
    """A named-but-switched-off field does not print, so offering it would put
    the PO somewhere nobody sees."""
    prefs = {
        "Preferences": [
            {
                "SalesFormsPrefs": {
                    "CustomField": [
                        {
                            "CustomField": [
                                {"Name": "SalesFormsPrefs.UseSalesCustom2", "BooleanValue": False},
                                {"Name": "SalesFormsPrefs.SalesCustomName2",
                                 "StringValue": "PO Number"},
                            ]
                        }
                    ]
                }
            }
        ]
    }
    monkeypatch.setattr(qb, "qb_query", lambda *a, **k: prefs)
    found = qb.discover_po_custom_field(None, "c1")
    assert found["id"] is None
    assert found["candidates"] == []


# ───────────────────────── invoiced-quantity scoping ─────────────────────────
class _InvoicedFakeTable:
    """Routes by table name, enough for sum_invoiced_by_part's two reads."""

    def __init__(self, name: str, job_parts: list, line_items: list):
        self.name = name
        self.job_parts = job_parts
        self.line_items = line_items

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def in_(self, *a, **k):
        return self

    def execute(self):
        return _Resp(self.job_parts if self.name == "job_parts" else self.line_items)


class _InvoicedFakeDB:
    def __init__(self, job_parts: list, line_items: list):
        self.job_parts = job_parts
        self.line_items = line_items

    def table(self, name):
        return _InvoicedFakeTable(name, self.job_parts, self.line_items)


def test_sum_invoiced_counts_every_realm():
    """Invoiced quantity is NOT scoped by realm, and that is the fix.

    assert_invoice_not_over_ordered (migration 20260702011324) counts every
    created non-void line with no realm predicate. While this function filtered
    by realm the two disagreed, so a company whose realm changed got a generous
    qty_invoiceable from the route and then an opaque 500 from the trigger.
    Switching a company between QuickBooks Online and Desktop changes the scope
    key by construction, so this would have fired on day one of QBD.
    """
    db = _InvoicedFakeDB(
        job_parts=[{"id": "jp1"}],
        line_items=[
            {"job_part_id": "jp1", "quantity": 4,
             "link": {"status": "created", "voided_at": None}},
            # A different accounting file entirely — still counted, because the
            # DB trigger counts it.
            {"job_part_id": "jp1", "quantity": 6,
             "link": {"status": "created", "voided_at": None}},
        ],
    )
    assert qb.sum_invoiced_by_part(db, "job1") == {"jp1": 10.0}


def test_sum_invoiced_ignores_pending_and_voided_links():
    """Only 'created' and non-void counts — the same predicate the trigger uses."""
    db = _InvoicedFakeDB(
        job_parts=[{"id": "jp1"}],
        line_items=[
            {"job_part_id": "jp1", "quantity": 5,
             "link": {"status": "created", "voided_at": None}},
            {"job_part_id": "jp1", "quantity": 3,
             "link": {"status": "pending", "voided_at": None}},
            {"job_part_id": "jp1", "quantity": 7,
             "link": {"status": "created", "voided_at": "2026-08-01T00:00:00Z"}},
        ],
    )
    assert qb.sum_invoiced_by_part(db, "job1") == {"jp1": 5.0}


# ───────────────────────── invoice payment mirror: the status rule ─────────────────────────
# derive_invoice_status is the one place the word a shop owner reads is decided, and it is
# pure — no clock, no I/O — so every case below is exact rather than approximate.


def test_a_paid_invoice_reads_paid():
    """Nothing owed is the whole test. QBO reports a settled invoice as Balance 0
    while keeping TotalAmt, so `paid` can never be inferred from the total alone."""
    assert qb.derive_invoice_status(
        found=True, total_amt="500.00", balance="0.00", jigged_total="500.00"
    ) == "paid"


def test_a_part_paid_invoice_reads_partial():
    assert qb.derive_invoice_status(
        found=True, total_amt="500.00", balance="200.00", jigged_total="500.00"
    ) == "partial"


def test_an_untouched_invoice_reads_open():
    assert qb.derive_invoice_status(
        found=True, total_amt="500.00", balance="500.00", jigged_total="500.00"
    ) == "open"


def test_a_voided_invoice_is_not_read_as_paid():
    """QBO does not delete a voided invoice — it zeroes the amounts and keeps the
    number, so a void arrives looking exactly like a settled invoice: Balance 0.

    Ordering the void test ABOVE the balance test is what keeps the two apart, and it
    is the ordering that matters rather than the arithmetic: read the other way round,
    every void in the shop would show as money collected."""
    assert qb.derive_invoice_status(
        found=True, total_amt="0.00", balance="0.00", jigged_total="1000.00"
    ) == "voided"


def test_a_zero_dollar_invoice_with_no_jigged_lines_is_paid():
    """The other side of that ordering. An invoice we never put lines on has a zero
    total legitimately — nothing is owed on it and there is no evidence anyone voided
    anything — so it must fall through to `paid` rather than be called a void."""
    assert qb.derive_invoice_status(
        found=True, total_amt="0.00", balance="0.00", jigged_total="0.00"
    ) == "paid"


def test_partial_versus_open_uses_quickbooks_own_total_not_jiggeds():
    """THE TAX-INCLUSIVE TRAP. QuickBooks totals include sales tax; Jigged's line
    total does not. On a taxed invoice the QBO total legitimately EXCEEDS ours, so an
    untouched invoice's balance (1077.50, tax included) sits above Jigged's line total
    (1000.00).

    Comparing the balance against jigged_total to decide partial vs open would call
    that invoice partly paid on the day it was issued — and would do it on every
    invoice at every shop that charges tax. jigged_total is for the void test only."""
    assert qb.derive_invoice_status(
        found=True, total_amt="1077.50", balance="1077.50", jigged_total="1000.00"
    ) == "open"
    # A genuine part payment against that same taxed invoice still reads partial.
    assert qb.derive_invoice_status(
        found=True, total_amt="1077.50", balance="77.50", jigged_total="1000.00"
    ) == "partial"
    # And the substitution read the other way round: 27.50 has been paid, so the
    # invoice IS partly paid even though more is still owed than Jigged ever billed.
    # Comparing against jigged_total here would call it untouched.
    assert qb.derive_invoice_status(
        found=True, total_amt="1077.50", balance="1050.00", jigged_total="1000.00"
    ) == "partial"


def test_an_invoice_confirmed_absent_reads_missing():
    """found=False comes from fetch_invoice_facts alone, and only after TWO successful
    queries failed to return the id — see the confirm tests below."""
    assert qb.derive_invoice_status(
        found=False, total_amt=None, balance=None, jigged_total="500.00"
    ) == "missing"


@pytest.mark.parametrize(
    "total_amt, balance",
    [
        (None, "0.00"),            # QBO omitted TotalAmt entirely
        ("500.00", None),          # QBO omitted Balance entirely
        ("five hundred", "0.00"),  # a body we could parse as JSON but not as money
        ("500.00", "n/a"),
    ],
)
def test_an_unreadable_amount_raises_rather_than_guessing(total_amt, balance):
    """Every fallback available here is a claim about money QuickBooks did not make:
    0 says "settled", None says "unknown" in a column that means "checked", and
    keeping the previous value dates a stale balance as fresh. So the pass aborts and
    the stored answer stays exactly as QuickBooks last left it."""
    with pytest.raises(ValueError):
        qb.derive_invoice_status(
            found=True, total_amt=total_amt, balance=balance, jigged_total="500.00"
        )


# ───────────────────────── invoice payment mirror: reading QBO ─────────────────────────
_ID_LITERAL = re.compile(r"'([^']*)'")

_FAULT_BODY = {
    "Fault": {
        "Error": [{"Message": "Object Not Found", "code": "610"}],
        "type": "ValidationFault",
    },
    "time": "2026-09-03T18:00:00.000-07:00",
}


def _invoice_row(invoice_id: str, total="100.00", balance="0.00") -> dict:
    return {
        "Id": invoice_id,
        "TotalAmt": total,
        "Balance": balance,
        "DueDate": "2026-09-30",
        "TxnDate": "2026-09-01",
    }


class _FakeQueries:
    """Stands in for qb_query_strict. Answers from the set of invoice ids QuickBooks
    "has", records every query text so chunking and escaping can be asserted, and can
    fail a chosen call to simulate Intuit going down mid-pass.

    `on_confirm` are ids the batch query misses but the single-id re-read finds —
    the query-index lag that _confirm_invoice exists for."""

    def __init__(self, present=(), *, on_confirm=(), extra_rows=(), fail_at=None):
        self.present = set(present)
        self.on_confirm = set(on_confirm)
        self.extra_rows = list(extra_rows)
        self.fail_at = fail_at
        self.queries: list[str] = []

    def __call__(self, db, company_id, query):
        self.queries.append(query)
        if self.fail_at is not None and len(self.queries) == self.fail_at:
            raise qb.QuickBooksApiError("QuickBooks API error (500)", status=500)
        held = self.present | (self.on_confirm if " Id = " in query else set())
        rows = [_invoice_row(i) for i in _ID_LITERAL.findall(query) if i in held]
        rows.extend(self.extra_rows)
        return {"Invoice": rows} if rows else {}


def test_qb_query_strict_raises_when_the_body_carries_no_query_response(monkeypatch):
    """A 200 whose body is not the shape we expect — a proxy's error page, a
    maintenance stub — must not read as "no invoices exist"."""
    monkeypatch.setattr(qb, "qb_request", lambda *a, **k: {"time": "2026-09-03T18:00:00Z"})
    with pytest.raises(qb.QuickBooksReadUnavailable):
        qb.qb_query_strict(None, "c1", "select * from Invoice")


def test_qb_query_strict_raises_on_a_fault_returned_with_http_200(monkeypatch):
    """Intuit answers some query faults with a 200 carrying a Fault, so the HTTP
    status alone does not say whether the answer is usable."""
    monkeypatch.setattr(qb, "qb_request", lambda *a, **k: _FAULT_BODY)
    with pytest.raises(qb.QuickBooksReadUnavailable):
        qb.qb_query_strict(None, "c1", "select * from Invoice")


def test_qb_query_strict_returns_a_readable_answer_including_an_empty_one(monkeypatch):
    """An empty QueryResponse IS an answer — QuickBooks looked and found nothing — and
    has to stay distinguishable from the unreadable bodies above."""
    monkeypatch.setattr(
        qb, "qb_request", lambda *a, **k: {"QueryResponse": {"Invoice": [_invoice_row("7")]}}
    )
    assert qb.qb_query_strict(None, "c1", "q")["Invoice"][0]["Id"] == "7"
    monkeypatch.setattr(qb, "qb_request", lambda *a, **k: {"QueryResponse": {}})
    assert qb.qb_query_strict(None, "c1", "q") == {}


def test_qb_query_cannot_be_used_here_because_it_reads_a_fault_as_no_rows(monkeypatch):
    """WHY qb_query_strict exists at all, asserted rather than left as a comment.

    qb_query returns resp.get("QueryResponse", {}), so the fault body below arrives as
    an empty result. For reference-data lookups that is harmless. Here it is exactly
    the failure the house rule forbids: "we couldn't ask" becoming "the invoice was
    deleted", stored as `missing` and read by a shop owner as a deleted invoice."""
    monkeypatch.setattr(qb, "qb_request", lambda *a, **k: _FAULT_BODY)
    assert qb.qb_query(None, "c1", "select * from Invoice") == {}
    with pytest.raises(qb.QuickBooksReadUnavailable):
        qb.qb_query_strict(None, "c1", "select * from Invoice")


def test_many_invoices_are_asked_in_capped_chunks_that_cannot_be_silently_paged(monkeypatch):
    """250 ids -> 100 + 100 + 50, every query carrying MAXRESULTS.

    QBO pages a query at 100 rows BY DEFAULT and truncates with no marker and no
    count, so without MAXRESULTS a full chunk could come back short — and every
    dropped id would look like an absence, which is the only input that yields
    `missing`."""
    fake = _FakeQueries(present=(str(n) for n in range(250)))
    monkeypatch.setattr(qb, "qb_query_strict", fake)

    facts = qb.fetch_invoice_facts(None, "c1", [str(n) for n in range(250)])

    assert len(facts) == 250
    assert all(f is not None for f in facts.values())
    # Three chunks and nothing else: every id came back, so no confirm re-read fired.
    assert len(fake.queries) == 3
    assert [len(_ID_LITERAL.findall(q)) for q in fake.queries] == [100, 100, 50]
    for query in fake.queries:
        assert f"MAXRESULTS {qb.INVOICE_QUERY_MAXRESULTS}" in query
    # Ids go in as quoted literals — an unquoted id is a QBO syntax error.
    assert "'0'" in fake.queries[0]


def test_one_absence_is_confirmed_by_a_second_read_before_it_counts(monkeypatch):
    """QBO's query index lags a freshly created invoice, so an id can be genuinely
    absent from a batch query and present a second later on its own. One absence is
    therefore not evidence, and the per-id re-read is what turns it into evidence."""
    fake = _FakeQueries(present={"10"}, on_confirm={"11"})
    monkeypatch.setattr(qb, "qb_query_strict", fake)

    facts = qb.fetch_invoice_facts(None, "c1", ["10", "11"])

    assert facts["10"] is not None
    assert facts["11"] is not None  # found on the second look — NOT missing
    assert len(fake.queries) == 2
    assert "Id = '11'" in fake.queries[1]


def test_only_a_second_absence_reports_an_invoice_as_gone(monkeypatch):
    """The single input that can produce `missing`: absent from two consecutive
    SUCCESSFUL queries. None here means confirmed absent, never "we didn't see it"."""
    fake = _FakeQueries(present={"10"})
    monkeypatch.setattr(qb, "qb_query_strict", fake)

    facts = qb.fetch_invoice_facts(None, "c1", ["10", "11"])

    assert facts["11"] is None
    assert len(fake.queries) == 2


def test_a_chunk_answering_with_more_rows_than_it_was_asked_for_raises(monkeypatch):
    """More rows than ids means the `Id in (...)` filter did not apply, so the page is
    one we cannot explain. Absence from a page like that says nothing about whether an
    invoice exists, and deriving `missing` from it would be a guess."""
    fake = _FakeQueries(present={"10", "11"}, extra_rows=[_invoice_row("999")])
    monkeypatch.setattr(qb, "qb_query_strict", fake)
    with pytest.raises(qb.QuickBooksReadUnavailable):
        qb.fetch_invoice_facts(None, "c1", ["10", "11"])


def test_a_failing_chunk_yields_nothing_at_all_rather_than_a_partial_map(monkeypatch):
    """The first chunk succeeded and the second did not. Returning the first chunk's
    answers would let the caller write fresh statuses for some invoices on a job and
    leave the rest at a stale balance with an unchanged timestamp — one job showing
    two answers of different ages that both look current."""
    fake = _FakeQueries(present=(str(n) for n in range(150)), fail_at=2)
    monkeypatch.setattr(qb, "qb_query_strict", fake)
    with pytest.raises(qb.QuickBooksReadUnavailable):
        qb.fetch_invoice_facts(None, "c1", [str(n) for n in range(150)])


def test_the_fake_branch_reports_paid_without_touching_intuit(monkeypatch):
    """QUICKBOOKS_FAKE lets the e2e suite drive the whole store-and-render path with no
    network — the same escape hatch, and the same guard, as create_invoice."""
    monkeypatch.setenv("QUICKBOOKS_FAKE", "1")

    def _must_not_ask(*a, **k):
        raise AssertionError("the fake branch reached QuickBooks")

    monkeypatch.setattr(qb, "qb_query_strict", _must_not_ask)

    fact = qb.fetch_invoice_facts(None, "c1", ["10"])["10"]
    assert fact["balance"] == "0.00"
    assert qb.derive_invoice_status(
        found=True,
        total_amt=fact["total_amt"],
        balance=fact["balance"],
        jigged_total="1.00",
    ) == "paid"


def test_the_fake_branch_is_ignored_in_production(monkeypatch):
    """The guard that stops a stray environment variable marking a real shop's
    invoices paid."""
    monkeypatch.setenv("QUICKBOOKS_FAKE", "1")
    monkeypatch.setenv("QUICKBOOKS_ENVIRONMENT", "production")
    fake = _FakeQueries(present={"10"})
    monkeypatch.setattr(qb, "qb_query_strict", fake)

    qb.fetch_invoice_facts(None, "c1", ["10"])
    assert len(fake.queries) == 1  # it really asked Intuit


# ───────────────────────── invoice payment mirror: when to ask ─────────────────────────
# links_need_check is what makes the menu-open automatic without polling anything: the
# BACKEND decides whether Intuit is asked, and the browser only says "the user opened
# the invoice list".

_NOW = datetime(2026, 9, 3, 18, 0, tzinfo=timezone.utc)


def _link(**over) -> dict:
    base = {
        "id": "link-1",
        "realm_id": "realm-123",
        "qb_invoice_id": "1001",
        "qb_status_checked_at": (_NOW - timedelta(minutes=1)).isoformat(),
        "qb_stale_at": None,
    }
    base.update(over)
    return base


def test_a_freshly_checked_set_of_links_is_not_re_asked():
    """The baseline every trigger below is measured against: opening the menu twice in
    a minute is one Intuit call, not two."""
    assert qb.links_need_check([_link()], _conn(), _NOW) is False


def test_an_invoice_that_has_never_been_checked_is_asked_about():
    """The first menu-open after a push, and the state every existing row is in until
    the launch backfill runs."""
    assert qb.links_need_check([_link(qb_status_checked_at=None)], _conn(), _NOW) is True


def test_a_webhook_marking_this_invoice_stale_forces_a_re_check():
    """The fast path. The webhook wrote qb_stale_at and made no Intuit call itself, so
    this comparison is the only thing that turns a notification into a read."""
    link = _link(qb_stale_at=(_NOW - timedelta(seconds=30)).isoformat())
    assert qb.links_need_check([link], _conn(), _NOW) is True
    # A marker OLDER than our last check is already accounted for — that read happened
    # after the change, so re-asking would be a wasted call.
    seen = _link(qb_stale_at=(_NOW - timedelta(minutes=5)).isoformat())
    assert qb.links_need_check([seen], _conn(), _NOW) is False


def test_a_payment_webhook_marking_the_whole_realm_stale_forces_a_re_check():
    """Payment and CreditMemo notifications name only their own id. Resolving one to
    the invoices it settles would be an Intuit call inside the webhook handler, which
    must stay a pure DB write — so the connection is marked and every link re-reads."""
    conn = _conn(qb_invoices_stale_since=(_NOW - timedelta(seconds=30)).isoformat())
    assert qb.links_need_check([_link()], conn, _NOW) is True


def test_an_answer_older_than_the_age_bound_is_re_asked():
    """The backstop for the webhook that never arrived — wrong host, Intuit retries
    exhausted, subscription lapsed. Nothing polls; this fires only when someone opens
    the menu, which is the difference between an age bound and a poller.

    The minutes below are LITERAL, and the constant is pinned, on purpose. Deriving
    them from INVOICE_STATUS_MAX_AGE_MINUTES made this test move its own goalpost:
    raising the bound to a month left it green, which is exactly the change that would
    silently stop the backstop firing."""
    assert qb.INVOICE_STATUS_MAX_AGE_MINUTES == 10

    stale = _link(qb_status_checked_at=(_NOW - timedelta(minutes=11)).isoformat())
    assert qb.links_need_check([stale], _conn(), _NOW) is True
    # Inside the bound, with no marker, is left alone — otherwise every menu-open
    # would be an Intuit call and the bound would be doing nothing.
    current = _link(qb_status_checked_at=(_NOW - timedelta(minutes=9)).isoformat())
    assert qb.links_need_check([current], _conn(), _NOW) is False


@pytest.mark.parametrize(
    "link_over, conn_over",
    [
        ({"qb_status_checked_at": "not a timestamp"}, {}),
        ({"qb_stale_at": "not a timestamp"}, {}),
        ({}, {"qb_invoices_stale_since": "not a timestamp"}),
    ],
)
def test_an_unreadable_timestamp_forces_a_re_check(link_over, conn_over):
    """Asking again costs one Intuit call. Treating an unreadable timestamp as
    "nothing to do" would show a stale balance as current, which is the single failure
    this whole feature exists to prevent."""
    assert qb.links_need_check([_link(**link_over)], _conn(**conn_over), _NOW) is True
