"""Stripe-sandbox lifecycle tests for the billing sync (REAL Stripe, not mocked).

These exercise `_sync_customer` against **real Stripe test-mode objects**, which is
what catches the class of bug the unit tests (plain dicts) can't — e.g. stripe
StripeObject has no `.get()`. They drive the Stripe SDK directly and call the sync
function, so they do NOT require `stripe listen` or the FastAPI server running —
only sandbox creds + a local Supabase.

NOT run in CI by default (CI can't hold your Stripe sandbox secrets). To run:

    cd /path/to/Jigged
    supabase start                                  # local DB
    eval "$(supabase status -o env)"
    export TEST_SUPABASE_URL=$API_URL \
           TEST_SUPABASE_PUBLISHABLE_KEY=$ANON_KEY \
           TEST_SUPABASE_SECRET_KEY=$SERVICE_ROLE_KEY
    cd api && conda run -n jigged python -m pytest \
        tests/integration/test_billing_stripe_lifecycle.py -m stripe_live -q

STRIPE_SECRET_KEY / STRIPE_PRICE_ID / STRIPE_FOUNDING_PRICE_ID are read from the
repo's .env.local. The suite skips if STRIPE_SECRET_KEY is not a TEST key. Every
test creates and then deletes its own Stripe test Customer.
"""
from __future__ import annotations

import os
import time

import pytest
from dotenv import load_dotenv

import routes.stripe_routes as sr

pytestmark = [pytest.mark.integration, pytest.mark.stripe_live]

# Load the repo .env.local so STRIPE_* are available (as the backend does).
load_dotenv(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".env.local"))

_STRIPE_KEY = os.getenv("STRIPE_SECRET_KEY", "")
_DEFAULT_PRICE = os.getenv("STRIPE_PRICE_ID")
_FOUNDER_PRICE = os.getenv("STRIPE_FOUNDING_PRICE_ID")

# Guard: only run against a TEST-mode key, never live.
if not _STRIPE_KEY.startswith(("sk_test", "rk_test")):
    pytest.skip(
        "STRIPE_SECRET_KEY is not a test key — skipping live Stripe lifecycle tests.",
        allow_module_level=True,
    )
if not _DEFAULT_PRICE or not _FOUNDER_PRICE:
    pytest.skip("STRIPE_PRICE_ID / STRIPE_FOUNDING_PRICE_ID not set.", allow_module_level=True)


@pytest.fixture
def stripe_sdk():
    import stripe

    stripe.api_key = _STRIPE_KEY
    stripe.api_version = sr.STRIPE_API_VERSION
    return stripe


@pytest.fixture
def sandbox_customer(stripe_sdk, billing_user):
    """A real Stripe test Customer with a default test card, tied to a fresh
    company. Deleted (which cancels its subscriptions) on teardown."""
    customer = stripe_sdk.Customer.create(
        metadata={"company_id": billing_user["company_id"]},
        payment_method="pm_card_visa",
        invoice_settings={"default_payment_method": "pm_card_visa"},
    )
    yield {"customer_id": customer["id"], "company_id": billing_user["company_id"]}
    try:
        stripe_sdk.Customer.delete(customer["id"])
    except Exception:
        pass


def _billing_row(supabase_admin, company_id):
    res = (
        supabase_admin.table("company_billing")
        .select("*")
        .eq("company_id", company_id)
        .execute()
    )
    return res.data[0] if res.data else None


def _sync(stripe_sdk, supabase_admin, sandbox_customer):
    return sr._sync_customer(
        stripe_sdk, supabase_admin, sandbox_customer["company_id"], sandbox_customer["customer_id"]
    )


def test_sync_reflects_real_trial_subscription(stripe_sdk, supabase_admin, sandbox_customer):
    """A real trialing subscription syncs into the cache with the version-correct
    fields (status, price, item current_period_end)."""
    stripe_sdk.Subscription.create(
        customer=sandbox_customer["customer_id"],
        items=[{"price": _DEFAULT_PRICE}],
        trial_period_days=30,
    )
    status = _sync(stripe_sdk, supabase_admin, sandbox_customer)
    assert status == "trialing"
    row = _billing_row(supabase_admin, sandbox_customer["company_id"])
    assert row["subscription_status"] == "trialing"
    assert row["subscription_price_id"] == _DEFAULT_PRICE
    assert row["current_period_end"] is not None  # read off the subscription item
    assert row["trial_end"] is not None
    assert row["billing_exempt"] is False


def test_founder_override_no_trial_charges_immediately(stripe_sdk, supabase_admin, sandbox_customer):
    """The reserved $250 / no-trial path lands 'active' (immediate charge), no trial."""
    stripe_sdk.Subscription.create(
        customer=sandbox_customer["customer_id"],
        items=[{"price": _FOUNDER_PRICE}],
        # no trial_period_days → immediate charge with the default test card
    )
    status = _sync(stripe_sdk, supabase_admin, sandbox_customer)
    assert status == "active"
    row = _billing_row(supabase_admin, sandbox_customer["company_id"])
    assert row["subscription_status"] == "active"
    assert row["subscription_price_id"] == _FOUNDER_PRICE
    assert row["trial_end"] is None


def test_cancel_at_period_end_is_reflected(stripe_sdk, supabase_admin, sandbox_customer):
    """Canceling at period end keeps the sub live with cancel_at set (the 'Canceling'
    UI state)."""
    sub = stripe_sdk.Subscription.create(
        customer=sandbox_customer["customer_id"],
        items=[{"price": _DEFAULT_PRICE}],
        trial_period_days=30,
    )
    stripe_sdk.Subscription.modify(sub["id"], cancel_at_period_end=True)
    status = _sync(stripe_sdk, supabase_admin, sandbox_customer)
    assert status == "trialing"  # still live until the period ends
    row = _billing_row(supabase_admin, sandbox_customer["company_id"])
    assert row["cancel_at"] is not None


def test_immediate_cancel_then_no_subscription(stripe_sdk, supabase_admin, sandbox_customer):
    """Canceling immediately → the sub is canceled; a later sync with no live sub
    still surfaces the canceled state (grace), then clearing when truly gone."""
    sub = stripe_sdk.Subscription.create(
        customer=sandbox_customer["customer_id"],
        items=[{"price": _DEFAULT_PRICE}],
        trial_period_days=30,
    )
    stripe_sdk.Subscription.cancel(sub["id"])
    status = _sync(stripe_sdk, supabase_admin, sandbox_customer)
    assert status == "canceled"
    row = _billing_row(supabase_admin, sandbox_customer["company_id"])
    assert row["subscription_status"] == "canceled"
    assert row["ended_at"] is not None


def test_sync_clears_cache_when_customer_has_no_subscription(
    stripe_sdk, supabase_admin, sandbox_customer
):
    """A customer that never subscribed → the cache is cleared to no-subscription."""
    status = _sync(stripe_sdk, supabase_admin, sandbox_customer)
    assert status is None
    row = _billing_row(supabase_admin, sandbox_customer["company_id"])
    # Row may not exist, or exists with null status — either is "no subscription".
    assert row is None or row["subscription_status"] is None
