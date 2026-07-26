"""Unit tests for the Stripe billing routes.

Covers the version-drift field readers (scenario 12), the demo-reject guard
(scenario 22), the /checkout/sync ownership check (scenario 9b), and the webhook
signature-failure path (scenario 7). Stripe + Supabase are mocked; no network, no
DB.
"""
import asyncio

import pytest
import stripe
from stripe import StripeObject

from fastapi import HTTPException

import routes.stripe_routes as sr
from models.stripe_models import CheckoutRequest, CheckoutSyncRequest, PortalRequest

pytestmark = pytest.mark.unit


def _stripe_obj(data: dict) -> StripeObject:
    """A real StripeObject (which, unlike a dict, has NO .get() method) so tests
    exercise the same accessor path as live Stripe responses."""
    return StripeObject.construct_from(data, "sk_test")


# ───────────────────────── accessor helper vs real StripeObject ─────────────────────────
def test_g_works_on_stripe_object_and_dict():
    # Regression guard: StripeObject has no .get(); _g must still read it.
    obj = _stripe_obj({"status": "active", "cancel_at": None})
    assert not hasattr(obj, "get")  # documents the SDK behavior that broke us
    assert sr._g(obj, "status") == "active"
    assert sr._g(obj, "cancel_at", "x") is None  # present but null
    assert sr._g(obj, "missing", "default") == "default"
    assert sr._g({"a": 1}, "a") == 1
    assert sr._g(None, "a", "d") == "d"


def test_accessor_helpers_on_stripe_object():
    sub = _stripe_obj({
        "id": "sub_1", "status": "trialing", "customer": "cus_1",
        "metadata": {"company_id": "c-123"},
        "items": {"data": [{"current_period_end": 111, "price": {"id": "price_x"}}]},
    })
    assert sr._sub_price_id(sub) == "price_x"
    assert sr._sub_period_end(sub) == 111
    assert sr._g(sr._g(sub, "metadata"), "company_id") == "c-123"


# ───────────────────────── pure helpers ─────────────────────────
def test_iso_from_unix_roundtrip_and_none():
    assert sr._iso_from_unix(None) is None
    assert sr._iso_from_unix(0) is None  # falsy → treated as absent
    iso = sr._iso_from_unix(1_700_000_000)
    assert iso is not None and iso.startswith("2023-11-14T")


def test_sub_period_end_prefers_item_then_falls_back():
    # newer API: current_period_end lives on the subscription item
    sub_item = {"items": {"data": [{"current_period_end": 111}]}, "current_period_end": 999}
    assert sr._sub_period_end(sub_item) == 111
    # older API: only the subscription-level field
    sub_legacy = {"items": {"data": [{}]}, "current_period_end": 999}
    assert sr._sub_period_end(sub_legacy) == 999
    # nothing → None
    assert sr._sub_period_end({"items": {"data": []}}) is None


def test_sub_price_id():
    assert sr._sub_price_id({"items": {"data": [{"price": {"id": "price_x"}}]}}) == "price_x"
    assert sr._sub_price_id({"items": {"data": []}}) is None
    assert sr._sub_price_id({}) is None


# ───────────────────────── fakes ─────────────────────────
class _Result:
    def __init__(self, data):
        self.data = data


class _Chain:
    def __init__(self, data):
        self._data = data

    def select(self, *a, **k):
        return self

    def eq(self, *a, **k):
        return self

    def limit(self, *a, **k):
        return self

    def update(self, *a, **k):
        return self

    def upsert(self, *a, **k):
        return self

    def insert(self, *a, **k):
        return self

    def execute(self):
        return _Result(self._data)


class FakeClient:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return _Chain(self._tables.get(name, []))

    def rpc(self, name, params):
        return _Chain([])


class FakeRequest:
    def __init__(self, body=b"", headers=None):
        self._body = body
        self.headers = headers or {}

    async def body(self):
        return self._body


async def _noop_admin(request, company_id):
    return "user-123"


# ───────────────────────── checkout: demo reject ─────────────────────────
def test_checkout_rejects_demo_company(monkeypatch):
    monkeypatch.setattr(sr, "_verify_company_admin", _noop_admin)
    monkeypatch.setattr(
        sr,
        "_service_client",
        lambda: FakeClient({"companies": [{"id": "c1", "is_demo": True, "email": None}]}),
    )
    with pytest.raises(HTTPException) as exc:
        asyncio.run(sr.create_checkout(CheckoutRequest(company_id="c1"), FakeRequest()))
    assert exc.value.status_code == 400
    assert "demo" in exc.value.detail.lower()


def test_checkout_blocks_second_subscription_via_stripe(monkeypatch):
    """Even if the local cache is stale (no status), an existing Stripe
    subscription must block a second one (authoritative double-subscribe guard)."""
    monkeypatch.setattr(sr, "_verify_company_admin", _noop_admin)
    monkeypatch.setattr(
        sr, "_service_client",
        lambda: FakeClient({
            "companies": [{"id": "c1", "is_demo": False, "email": None}],
            "company_billing": [{"stripe_customer_id": "cus_x", "subscription_status": None}],
        }),
    )

    class _FakeSubs:
        @staticmethod
        def list(customer=None, status=None, limit=None):
            # cache says "no sub", but Stripe has a live one
            return _stripe_obj({"data": [{"id": "sub_live", "status": "active"}]})

    class _FakeStripe:
        Subscription = _FakeSubs

    monkeypatch.setattr(sr, "_stripe", lambda: _FakeStripe())

    with pytest.raises(HTTPException) as exc:
        asyncio.run(sr.create_checkout(CheckoutRequest(company_id="c1"), FakeRequest()))
    assert exc.value.status_code == 409


# ───────────────────────── portal: self-heal reconcile ─────────────────────────
def _portal_client():
    return FakeClient({
        "companies": [{"id": "c1", "is_demo": False, "email": None}],
        "company_billing": [{"stripe_customer_id": "cus_x", "subscription_status": "trialing"}],
    })


def test_portal_no_live_subscription_clears_and_409(monkeypatch):
    """Stale cache says trialing but Stripe has no live sub → clear + 409."""
    monkeypatch.setattr(sr, "_verify_company_admin", _noop_admin)
    monkeypatch.setattr(sr, "_service_client", _portal_client)

    class _FakeSubs:
        @staticmethod
        def list(customer=None, status=None, limit=None):
            return _stripe_obj({"data": [{"id": "sub_dead", "status": "canceled"}]})

    class _FakeStripe:
        Subscription = _FakeSubs

    monkeypatch.setattr(sr, "_stripe", lambda: _FakeStripe())

    with pytest.raises(HTTPException) as exc:
        asyncio.run(sr.create_portal(PortalRequest(company_id="c1"), FakeRequest()))
    assert exc.value.status_code == 409
    assert "subscribe" in exc.value.detail.lower()


def test_portal_with_live_subscription_opens(monkeypatch):
    monkeypatch.setattr(sr, "_verify_company_admin", _noop_admin)
    monkeypatch.setattr(sr, "_service_client", _portal_client)
    monkeypatch.setattr(sr, "_apply_subscription", lambda *a, **k: None)

    class _FakeSubs:
        @staticmethod
        def list(customer=None, status=None, limit=None):
            return _stripe_obj({"data": [{"id": "sub_live", "status": "active"}]})

    class _FakePortal:
        @staticmethod
        def create(customer=None, return_url=None):
            return _stripe_obj({"url": "https://billing.stripe.com/session/xyz"})

    class _FakeStripe:
        Subscription = _FakeSubs
        billing_portal = type("_B", (), {"Session": _FakePortal})

    monkeypatch.setattr(sr, "_stripe", lambda: _FakeStripe())

    resp = asyncio.run(sr.create_portal(PortalRequest(company_id="c1"), FakeRequest()))
    assert resp.url.startswith("https://billing.stripe.com/")


# ───────────────────────── checkout/sync: ownership check ─────────────────────────
def test_checkout_sync_rejects_cross_company_session(monkeypatch):
    monkeypatch.setattr(sr, "_verify_company_admin", _noop_admin)
    # company_billing lookup (customer→company) returns nothing.
    monkeypatch.setattr(sr, "_service_client", lambda: FakeClient({"company_billing": []}))

    class _FakeSessions:
        @staticmethod
        def retrieve(session_id, expand=None):
            # A real StripeObject (no .get()) belonging to a DIFFERENT company.
            return _stripe_obj({
                "client_reference_id": "other-company",
                "customer": "cus_x",
                "subscription": "sub_x",
            })

    class _FakeStripe:
        checkout = type("_C", (), {"Session": _FakeSessions})

    monkeypatch.setattr(sr, "_stripe", lambda: _FakeStripe())

    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            sr.checkout_sync(
                CheckoutSyncRequest(company_id="c1", session_id="cs_test_1"),
                FakeRequest(),
            )
        )
    assert exc.value.status_code == 403


def test_checkout_sync_syncs_owned_session(monkeypatch):
    """Positive path: a session that belongs to the caller syncs that customer."""
    monkeypatch.setattr(sr, "_verify_company_admin", _noop_admin)
    monkeypatch.setattr(sr, "_service_client", lambda: FakeClient({}))

    synced = {}
    monkeypatch.setattr(
        sr, "_sync_customer",
        lambda s, client, company_id, customer_id: (
            synced.update({"company_id": company_id, "customer_id": customer_id}) or "trialing"
        ),
    )

    class _FakeSessions:
        @staticmethod
        def retrieve(session_id, **kwargs):
            return _stripe_obj({"client_reference_id": "c1", "customer": "cus_x"})

    class _FakeStripe:
        checkout = type("_C", (), {"Session": _FakeSessions})

    monkeypatch.setattr(sr, "_stripe", lambda: _FakeStripe())

    resp = asyncio.run(
        sr.checkout_sync(CheckoutSyncRequest(company_id="c1", session_id="cs_1"), FakeRequest())
    )
    assert resp.status == "trialing"
    assert synced == {"company_id": "c1", "customer_id": "cus_x"}


# ───────────────────────── _sync_customer: single source-of-truth ─────────────────────────
def test_sync_customer_applies_canceled_not_clears(monkeypatch):
    """A canceled sub is cached as 'canceled' (keeps its grace window), NOT wiped."""
    applied, cleared = {}, {"called": False}
    monkeypatch.setattr(sr, "_apply_subscription",
                        lambda c, cid, sub, at: applied.update({"status": sr._g(sub, "status")}))
    monkeypatch.setattr(sr, "_clear_subscription_cache",
                        lambda c, cid: cleared.update({"called": True}))

    class _FakeSubs:
        @staticmethod
        def list(customer=None, status=None, limit=None):
            return _stripe_obj({"data": [{"id": "s1", "status": "canceled"}]})

    s = type("_S", (), {"Subscription": _FakeSubs})()
    out = sr._sync_customer(s, FakeClient({}), "c1", "cus_x")
    assert out == "canceled"
    assert applied == {"status": "canceled"}
    assert cleared["called"] is False


def test_sync_customer_clears_when_no_subscriptions(monkeypatch):
    cleared = {"called": False}
    monkeypatch.setattr(sr, "_clear_subscription_cache",
                        lambda c, cid: cleared.update({"called": True}))

    class _FakeSubs:
        @staticmethod
        def list(customer=None, status=None, limit=None):
            return _stripe_obj({"data": []})

    s = type("_S", (), {"Subscription": _FakeSubs})()
    out = sr._sync_customer(s, FakeClient({}), "c1", "cus_x")
    assert out is None
    assert cleared["called"] is True


def test_webhook_event_syncs_resolved_customer(monkeypatch):
    """A subscription event resolves the company from the cache and re-syncs."""
    monkeypatch.setattr(
        sr, "_service_client",
        lambda: FakeClient({"company_billing": [{"company_id": "c1", "stripe_customer_id": "cus_x"}]}),
    )
    synced = {}
    monkeypatch.setattr(
        sr, "_sync_customer",
        lambda s, client, company_id, customer_id: synced.update(
            {"company_id": company_id, "customer_id": customer_id}
        ),
    )
    event = _stripe_obj({
        "type": "customer.subscription.updated",
        "data": {"object": {"id": "sub_x", "customer": "cus_x", "status": "active"}},
    })
    sr._handle_event(object(), event)
    assert synced == {"company_id": "c1", "customer_id": "cus_x"}


# ───────────────────────── webhook: signature failure ─────────────────────────
def test_webhook_rejects_bad_signature(monkeypatch):
    def _construct_event(payload, sig, secret):
        raise stripe.error.SignatureVerificationError("bad sig", sig)

    class _FakeStripe:
        Webhook = type("_W", (), {"construct_event": staticmethod(_construct_event)})

    monkeypatch.setattr(sr, "_stripe", lambda: _FakeStripe())
    monkeypatch.setattr(sr, "_webhook_secret", lambda: "whsec_test")

    req = FakeRequest(body=b"{}", headers={"Stripe-Signature": "t=1,v1=deadbeef"})
    with pytest.raises(HTTPException) as exc:
        asyncio.run(sr.webhook(req))
    assert exc.value.status_code == 400
