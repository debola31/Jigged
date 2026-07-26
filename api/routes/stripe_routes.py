"""
Stripe self-serve subscription billing.

Design: maximum delegation to Stripe. We create hosted Checkout Sessions and
Customer Portal sessions (server-side, returned as redirect URLs) and consume
webhooks. Stripe is the sole source of truth; `company_billing` is a webhook-fed
read cache. No card data touches our stack; no Stripe.js on the client.

Auth model (mirrors quickbooks_routes):
  - /checkout, /portal, /checkout/sync are company-scoped and require the caller's
    Supabase JWT + the 'admin' role on the company.
  - /webhook has NO bearer token (Stripe calls it); its trust signal is the
    Stripe-Signature header verified against STRIPE_WEBHOOK_SECRET.

All cache writes go through the SECURITY DEFINER RPC `apply_stripe_subscription`
(guarded upsert, monotonic by event time) using the service-role key.
"""
from __future__ import annotations

import logging
import os
import secrets
import string
import time
from datetime import datetime, timezone

import sentry_sdk
import stripe
from fastapi import APIRouter, HTTPException, Request
from supabase import Client, create_client

from models.stripe_models import (
    CheckoutRequest,
    CheckoutSyncRequest,
    PortalRequest,
    SyncResponse,
    UrlResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/stripe", tags=["stripe"])

# Pin the API version explicitly — Stripe's 2025 billing changes moved
# current_period_end onto the subscription item and the invoice→subscription
# reference onto invoice.parent; we read the version-correct fields below.
STRIPE_API_VERSION = "2026-06-24.dahlia"

# Statuses that count as a live paying/trialing relationship.
LIVE_STATUSES = ("trialing", "active", "past_due")


# ───────────────────────── config helpers ─────────────────────────
def _stripe():
    # Use a RESTRICTED key (rk_...) — least-privilege by design, and it maps
    # 1:1 to the var the Stripe Dashboard/Vercel label "STRIPE_RESTRICTED_KEY".
    # We deliberately do NOT fall back to STRIPE_SECRET_KEY: a single
    # authoritative var avoids someone later editing the (unused) secret key and
    # wondering why nothing changed.
    key = os.getenv("STRIPE_RESTRICTED_KEY")
    if not key:
        raise HTTPException(
            status_code=503, detail="Stripe not configured (STRIPE_RESTRICTED_KEY)"
        )
    stripe.api_key = key
    stripe.api_version = STRIPE_API_VERSION
    return stripe


def _service_client() -> Client:
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL") or os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SECRET_KEY") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise HTTPException(status_code=503, detail="Database not configured")
    return create_client(url, key)


def _default_price_id() -> str:
    """The default monthly price every self-serve company gets. The reserved
    founder-customer price is applied per-company via company_billing.override_price_id."""
    pid = os.getenv("STRIPE_PRICE_ID")
    if not pid:
        raise HTTPException(status_code=503, detail="STRIPE_PRICE_ID not configured")
    return pid


def _webhook_secret() -> str:
    s = os.getenv("STRIPE_WEBHOOK_SECRET")
    if not s:
        raise HTTPException(status_code=503, detail="STRIPE_WEBHOOK_SECRET not configured")
    return s


def _app_base_url() -> str:
    explicit = os.getenv("APP_BASE_URL") or os.getenv("NEXT_PUBLIC_APP_URL")
    if explicit:
        return explicit.rstrip("/")
    origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:3000")
    first = next((o.strip() for o in origins.split(",") if o.strip()), "http://localhost:3000")
    return first.rstrip("/")


def _integration_identifier() -> str:
    suffix = "".join(secrets.choice(string.ascii_letters) for _ in range(8))
    return f"jigged-selfserve-{suffix}"


def _billing_url(base: str, company_id: str) -> str:
    # Billing lives as a card on the main Settings page (the checkout success page
    # handles the ?session_id reconcile).
    return f"{base}/dashboard/{company_id}/settings"


# ───────────────────────── auth (mirrors quickbooks) ─────────────────────────
async def _verify_company_admin(request: Request, company_id: str) -> str:
    """Verify the caller's Supabase JWT and require the 'admin' role on company_id."""
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")

    client = _service_client()
    try:
        user_response = client.auth.get_user(token)
        if not user_response or not user_response.user:
            raise HTTPException(status_code=401, detail="Invalid token")
        user_id = user_response.user.id
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("Token verification failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired token")

    access = (
        client.table("user_company_access")
        .select("role")
        .eq("user_id", user_id)
        .eq("company_id", company_id)
        .limit(1)
        .execute()
    )
    if not access.data:
        raise HTTPException(status_code=403, detail="No access to this company")
    if access.data[0].get("role") != "admin":
        raise HTTPException(status_code=403, detail="Admin role required")
    return user_id


# ───────────────────────── db + stripe helpers ─────────────────────────
def _get_company(client: Client, company_id: str) -> dict:
    res = (
        client.table("companies")
        .select("id, is_demo, email")
        .eq("id", company_id)
        .limit(1)
        .execute()
    )
    if not res.data:
        raise HTTPException(status_code=404, detail="Company not found")
    return res.data[0]


def _get_billing(client: Client, company_id: str) -> dict | None:
    res = (
        client.table("company_billing")
        .select("*")
        .eq("company_id", company_id)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


def _g(obj, key, default=None):
    """Field access that works on both Stripe objects and plain dicts.

    stripe-python's StripeObject supports attribute + bracket access but NOT the
    dict `.get()` method, so `stripe_obj.get("x")` raises AttributeError. This
    normalizes both: dicts use `.get`, Stripe objects use `getattr`.
    """
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _resolve_company_from_customer(client: Client, customer_id: str | None) -> str | None:
    if not customer_id:
        return None
    res = (
        client.table("company_billing")
        .select("company_id")
        .eq("stripe_customer_id", customer_id)
        .limit(1)
        .execute()
    )
    return res.data[0]["company_id"] if res.data else None


def _iso_from_unix(unix: int | None) -> str | None:
    if not unix:
        return None
    return datetime.fromtimestamp(int(unix), tz=timezone.utc).isoformat()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sub_price_id(sub) -> str | None:
    data = _g(_g(sub, "items"), "data") or []
    if not data:
        return None
    return _g(_g(data[0], "price"), "id")


def _sub_period_end(sub) -> int | None:
    # 2025 billing changes: current_period_end lives on the subscription item on
    # newer API versions; fall back to the subscription-level field for safety.
    data = _g(_g(sub, "items"), "data") or []
    if data:
        cpe = _g(data[0], "current_period_end")
        if cpe:
            return cpe
    return _g(sub, "current_period_end")


def _apply_subscription(client: Client, company_id: str, sub, event_at_iso: str) -> None:
    """Overwrite the company_billing cache from a fresh subscription object,
    guarded (monotonic) and grandfather-clearing, via the SECURITY DEFINER RPC."""
    client.rpc(
        "apply_stripe_subscription",
        {
            "p_company_id": company_id,
            "p_stripe_customer_id": _g(sub, "customer"),
            "p_stripe_subscription_id": _g(sub, "id"),
            "p_status": _g(sub, "status"),
            "p_price_id": _sub_price_id(sub),
            "p_current_period_end": _iso_from_unix(_sub_period_end(sub)),
            "p_cancel_at": _iso_from_unix(_g(sub, "cancel_at")),
            "p_canceled_at": _iso_from_unix(_g(sub, "canceled_at")),
            "p_ended_at": _iso_from_unix(_g(sub, "ended_at")),
            "p_trial_end": _iso_from_unix(_g(sub, "trial_end")),
            "p_event_at": event_at_iso,
        },
    ).execute()


def _clear_subscription_cache(client: Client, company_id: str) -> None:
    """Null out the cached subscription fields (keeps stripe_customer_id + any
    overrides / billing_exempt). Used when Stripe reports no live subscription."""
    client.table("company_billing").update(
        {
            "subscription_status": None,
            "stripe_subscription_id": None,
            "subscription_price_id": None,
            "current_period_end": None,
            "cancel_at": None,
            "canceled_at": None,
            "ended_at": None,
            "trial_end": None,
            "subscription_event_at": None,
        }
    ).eq("company_id", company_id).execute()


def _sync_customer(s, client: Client, company_id: str, customer_id: str) -> str | None:
    """The ONE function that writes subscription state (Stripe's recommended
    "single source of truth" sync). Fetch the customer's current subscription from
    Stripe and overwrite the cache with its ACTUAL status — trialing / active /
    past_due / canceled / unpaid / paused — so a canceled sub still surfaces its
    grace window. Clears the cache only when the customer has NO subscription at
    all. Returns the cached status (or None).

    The webhook and every reconcile path call this, so behaviour is identical
    everywhere and no code has to parse event payloads. May raise
    stripe.error.StripeError (callers map it to a 502)."""
    subs = s.Subscription.list(customer=customer_id, status="all", limit=100)
    data = _g(subs, "data") or []
    if not data:
        _clear_subscription_cache(client, company_id)
        return None
    # Prefer a live subscription; else the most recent (Stripe returns newest first).
    chosen = next((x for x in data if _g(x, "status") in LIVE_STATUSES), data[0])
    _apply_subscription(client, company_id, chosen, _now_iso())
    return _g(chosen, "status")


def _resolve_company_for_event(s, client: Client, obj, customer_id: str | None) -> str | None:
    """Resolve our company from any webhook object: the cached stripe_customer_id
    (fast, no Stripe call), else the object's client_reference_id (checkout) or
    metadata (subscriptions), else the Customer's metadata."""
    company_id = _resolve_company_from_customer(client, customer_id)
    if company_id:
        return company_id
    company_id = _g(obj, "client_reference_id") or _g(_g(obj, "metadata"), "company_id")
    if company_id:
        return company_id
    if customer_id:
        try:
            cust = s.Customer.retrieve(customer_id)
            return _g(_g(cust, "metadata"), "company_id")
        except stripe.error.StripeError:
            return None
    return None


# ───────────────────────── endpoints ─────────────────────────
@router.post("/checkout", response_model=UrlResponse)
async def create_checkout(body: CheckoutRequest, request: Request):
    """Start a subscription Checkout. Price + trial are chosen server-side."""
    await _verify_company_admin(request, body.company_id)
    client = _service_client()
    company = _get_company(client, body.company_id)
    if company.get("is_demo"):
        raise HTTPException(status_code=400, detail="Demo companies cannot subscribe")

    s = _stripe()
    billing = _get_billing(client, body.company_id)

    # Double-subscribe guard. The local cache is the fast path, but it can be stale
    # (e.g. the webhook hasn't been delivered yet — or isn't running locally), so a
    # company with an existing Stripe Customer is verified AUTHORITATIVELY against
    # Stripe before we ever create a second subscription.
    if billing and billing.get("subscription_status") in LIVE_STATUSES:
        raise HTTPException(
            status_code=409,
            detail="This company already has an active subscription. Use Manage Billing.",
        )

    # One Stripe Customer per company (reliable event→company resolution key).
    customer_id = billing.get("stripe_customer_id") if billing else None
    if customer_id:
        try:
            existing = s.Subscription.list(customer=customer_id, status="all", limit=100)
        except stripe.error.StripeError as e:
            sentry_sdk.capture_exception(e)
            raise HTTPException(status_code=502, detail="Stripe error checking subscriptions")
        for sub in _g(existing, "data") or []:
            if _g(sub, "status") in LIVE_STATUSES:
                raise HTTPException(
                    status_code=409,
                    detail="This company already has an active subscription. Use Manage Billing.",
                )
    else:
        try:
            customer = s.Customer.create(
                email=company.get("email") or None,
                metadata={"company_id": body.company_id},
                idempotency_key=f"customer-{body.company_id}",
            )
        except stripe.error.StripeError as e:
            sentry_sdk.capture_exception(e)
            raise HTTPException(status_code=502, detail="Stripe error creating customer")
        customer_id = _g(customer, "id")
        client.table("company_billing").upsert(
            {"company_id": body.company_id, "stripe_customer_id": customer_id},
            on_conflict="company_id",
        ).execute()

    # Server-side price + trial selection (frontend never names a price).
    override_price = billing.get("override_price_id") if billing else None
    price_id = override_price or _default_price_id()
    override_trial = billing.get("override_trial_days") if billing else None
    trial_days = 30 if override_trial is None else int(override_trial)

    subscription_data: dict = {"metadata": {"company_id": body.company_id}}
    if trial_days > 0:
        subscription_data["trial_period_days"] = trial_days
        # A card is always collected upfront, so this should never fire; defensive.
        subscription_data["trial_settings"] = {
            "end_behavior": {"missing_payment_method": "cancel"}
        }

    base = _app_base_url()
    try:
        session = s.checkout.Session.create(
            mode="subscription",
            customer=customer_id,
            line_items=[{"price": price_id, "quantity": 1}],
            subscription_data=subscription_data,
            client_reference_id=body.company_id,
            success_url=f"{_billing_url(base, body.company_id)}?session_id={{CHECKOUT_SESSION_ID}}",
            cancel_url=_billing_url(base, body.company_id),
            integration_identifier=_integration_identifier(),
            idempotency_key=f"checkout-{body.company_id}-{int(time.time() // 10)}",
        )
    except stripe.error.StripeError as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=502, detail="Stripe error creating checkout session")

    return UrlResponse(url=_g(session, "url"))


@router.post("/portal", response_model=UrlResponse)
async def create_portal(body: PortalRequest, request: Request):
    """Open the Stripe-hosted Customer Portal for self-service billing management."""
    await _verify_company_admin(request, body.company_id)
    client = _service_client()
    company = _get_company(client, body.company_id)
    if company.get("is_demo"):
        raise HTTPException(status_code=400, detail="Demo companies have no billing portal")

    billing = _get_billing(client, body.company_id)
    customer_id = billing.get("stripe_customer_id") if billing else None
    if not customer_id:
        sentry_sdk.capture_message(
            f"Portal requested for company {body.company_id} with no stripe_customer_id"
        )
        raise HTTPException(status_code=409, detail="No billing customer for this company")

    s = _stripe()

    # Self-heal a stale cache before opening the portal: if there's no live
    # subscription (e.g. a missed customer.subscription.deleted webhook), clear the
    # cache and 409 so the client flips to "Subscribe" instead of opening an empty,
    # unactionable portal.
    try:
        status = _sync_customer(s, client, body.company_id, customer_id)
    except stripe.error.StripeError as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=502, detail="Stripe error checking subscriptions")
    if status not in LIVE_STATUSES:
        raise HTTPException(
            status_code=409, detail="No active subscription to manage. Please subscribe."
        )

    base = _app_base_url()
    try:
        session = s.billing_portal.Session.create(
            customer=customer_id,
            return_url=_billing_url(base, body.company_id),
        )
    except stripe.error.StripeError as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=502, detail="Stripe error creating portal session")

    return UrlResponse(url=_g(session, "url"))


@router.post("/checkout/sync", response_model=SyncResponse)
async def checkout_sync(body: CheckoutSyncRequest, request: Request):
    """Success-page reconcile: pull the just-completed session's subscription and
    overwrite the cache immediately (backstops a delayed/lost webhook)."""
    await _verify_company_admin(request, body.company_id)
    s = _stripe()
    client = _service_client()

    try:
        session = s.checkout.Session.retrieve(body.session_id)
    except stripe.error.StripeError as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=404, detail="Checkout session not found")

    # Ownership: the session MUST belong to the authenticated company. Without this
    # an admin could pass another company's session_id and adopt its subscription.
    owner = _g(session, "client_reference_id")
    if not owner:
        owner = _resolve_company_from_customer(client, _g(session, "customer"))
    if owner != body.company_id:
        sentry_sdk.capture_message(
            f"checkout/sync ownership mismatch: session {body.session_id} owner {owner} "
            f"!= {body.company_id}"
        )
        raise HTTPException(status_code=403, detail="Session does not belong to this company")

    customer_id = _g(session, "customer")
    if not customer_id:
        return SyncResponse(status=None)
    try:
        status = _sync_customer(s, client, body.company_id, customer_id)
    except stripe.error.StripeError as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=502, detail="Stripe error syncing subscription")
    return SyncResponse(status=status)


@router.post("/reconcile", response_model=SyncResponse)
async def reconcile(body: PortalRequest, request: Request):
    """Refresh the cache from Stripe's live state and return the current status.
    Called when the billing card is VIEWED (a deliberate settings visit, not every
    page load), so the card is accurate even if a webhook was missed. Bounded to at
    most one Stripe read per view, and skipped entirely when there's no customer."""
    await _verify_company_admin(request, body.company_id)
    client = _service_client()
    company = _get_company(client, body.company_id)
    if company.get("is_demo"):
        return SyncResponse(status=None)  # demo: never billed

    billing = _get_billing(client, body.company_id)
    customer_id = billing.get("stripe_customer_id") if billing else None
    if not customer_id:
        return SyncResponse(status=None)  # never subscribed — nothing to reconcile

    s = _stripe()
    try:
        status = _sync_customer(s, client, body.company_id, customer_id)
    except stripe.error.StripeError as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=502, detail="Stripe error reconciling subscription")
    return SyncResponse(status=status)


@router.post("/webhook")
async def webhook(request: Request):
    """Stripe webhook. Verifies the signature, resolves the company, refetches the
    subscription (source of truth), and overwrites the cache (guarded)."""
    payload = await request.body()
    sig = request.headers.get("Stripe-Signature", "")
    s = _stripe()

    try:
        event = s.Webhook.construct_event(payload, sig, _webhook_secret())
    except ValueError as e:  # malformed payload
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=400, detail="Invalid payload")
    except stripe.error.SignatureVerificationError as e:
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=400, detail="Invalid signature")

    try:
        _handle_event(s, event)
    except Exception as e:  # noqa: BLE001  — real errors → 500 so Stripe retries
        logger.error("Webhook handler error for %s: %s", _g(event, "type"), e)
        sentry_sdk.capture_exception(e)
        raise HTTPException(status_code=500, detail="Webhook handler error")

    return {"received": True}


# Events that mean "this customer's subscription state may have changed". On any
# of them we simply re-sync the customer from Stripe — the event only tells us
# WHICH customer to refetch, never what to write.
_HANDLED_EVENTS = frozenset(
    {
        "checkout.session.completed",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "invoice.paid",
        "invoice.payment_failed",
    }
)


def _handle_event(s, event) -> None:
    """Single-sync dispatch. For any subscription-relevant event, resolve the
    customer + company and re-sync from Stripe (no payload parsing). Unresolvable
    references are captured to Sentry and acknowledged — never silently defaulted."""
    etype = _g(event, "type")
    if etype not in _HANDLED_EVENTS:
        return
    obj = _g(_g(event, "data"), "object")
    customer_id = _g(obj, "customer")
    if not customer_id:
        return  # e.g. a subscription-less invoice — nothing to sync
    client = _service_client()
    company_id = _resolve_company_for_event(s, client, obj, customer_id)
    if not company_id:
        sentry_sdk.capture_message(
            f"Stripe {etype}: unresolvable company for customer {customer_id}"
        )
        return
    _sync_customer(s, client, company_id, customer_id)
