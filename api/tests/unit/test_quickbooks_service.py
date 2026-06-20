"""Unit tests for services.quickbooks (no DB, no network).

Covers the pieces a reviewer flagged as load-bearing: the tax/rounding mapping,
the compare-and-set token refresh (and its invalid_grant branches), QBO query
escaping, and customer resolution tiers.
"""
from __future__ import annotations

import json
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
    def __init__(self, status_code: int, json_data=None, text=""):
        self.status_code = status_code
        self._json = json_data
        self.text = text or (json.dumps(json_data) if json_data is not None else "")
        self.content = self.text.encode()

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


def test_client_credentials_missing_raises(monkeypatch):
    monkeypatch.delenv("QUICK_BOOKS_CLIENT_ID", raising=False)
    with pytest.raises(qb.QuickBooksServiceUnavailable):
        qb._client_credentials()


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
        quote_number="Q-2026-0001",
        bill_addr={"Line1": "1 Main St", "City": "Detroit"},
        lines=[
            {"quantity": 10, "unit_price": 12.5, "part_name": "Bracket", "description": "Rev C"},
            {"quantity": 2, "unit_price": 100.0, "part_name": "Shaft", "description": None},
        ],
    )
    assert payload["CustomerRef"] == {"value": "42"}
    # DocNumber is omitted so QBO auto-assigns; the quote number lives in the memo.
    assert "DocNumber" not in payload
    assert payload["PrivateNote"] == "Jigged quote Q-2026-0001"
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


def test_payload_rounding_reconciles_to_total():
    lines = [
        {"quantity": 3, "unit_price": 12.3456, "part_name": "A", "description": None},
        {"quantity": 7, "unit_price": 0.9999, "part_name": "B", "description": None},
    ]
    payload = qb.quote_to_invoice_payload(
        customer_ref="1", item_ref="1", quote_number=None, bill_addr=None, lines=lines
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
            quote_number=None,
            bill_addr=None,
            lines=[{"quantity": 1, "unit_price": None, "part_name": "X", "description": None}],
        )


def test_payload_memo_and_billaddr_optional():
    payload = qb.quote_to_invoice_payload(
        customer_ref="1",
        item_ref="1",
        quote_number="Q-0007",
        bill_addr=None,
        lines=[{"quantity": 1, "unit_price": 5.0, "part_name": "P", "description": None}],
    )
    assert "DocNumber" not in payload  # QBO auto-assigns
    assert payload["PrivateNote"] == "Jigged quote Q-0007"
    assert "BillAddr" not in payload


def test_invoice_deep_link():
    assert qb.invoice_deep_link("sandbox", "130") == "https://app.sandbox.qbo.intuit.com/app/invoice?txnId=130"
    assert qb.invoice_deep_link("production", "130") == "https://app.qbo.intuit.com/app/invoice?txnId=130"


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
