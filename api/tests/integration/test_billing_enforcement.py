"""Integration tests for the DB-layer billing write-gate (no Stripe needed).

These are the D10/D11 scenarios: entitlement is enforced by RLS, so a lapsed /
never-subscribed company genuinely cannot write while an exempt / active / demo
company can. Assertions run as the `authenticated` role through a real user-JWT
client (the same path the app uses); a blocked write must fail with the RLS
policy (42501), not some other error. Billing states are seeded directly with the
service role.

Requires a local Supabase with all migrations applied (TEST_SUPABASE_URL /
TEST_SUPABASE_PUBLISHABLE_KEY / TEST_SUPABASE_SECRET_KEY). Skipped without it.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

pytestmark = pytest.mark.integration

GRACE_DAYS = 7  # mirrors lib/entitlement.GRACE_DAYS + company_can_write()


def _iso(days_from_now: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days_from_now)).isoformat()


def _set_billing(admin, company_id: str, **fields) -> None:
    admin.table("company_billing").upsert(
        {"company_id": company_id, **fields}, on_conflict="company_id"
    ).execute()


def _clear_billing(admin, company_id: str) -> None:
    admin.table("company_billing").delete().eq("company_id", company_id).execute()


def _try_write(user_client, company_id: str):
    """Attempt a customers INSERT as the authenticated user (customers is a gated
    tenant table). Returns the response, or raises on RLS rejection."""
    return (
        user_client.table("customers")
        .insert({"company_id": company_id, "name": "billing-gate-test"})
        .execute()
    )


def _assert_rls_blocked(exc: Exception) -> None:
    msg = str(exc).lower()
    assert "42501" in msg or "row-level security" in msg, (
        f"expected an RLS (42501) rejection, got: {exc}"
    )


# ── golden cases: (label, billing fields | None, is_demo, write allowed?) ──────
# Mirrors __tests__/lib/entitlement.test.ts GOLDEN_CASES + verify_billing_parity.sql.
CASES = [
    ("no_row", None, False, False),
    ("exempt", {"billing_exempt": True}, False, True),
    ("trialing", {"subscription_status": "trialing"}, False, True),
    ("active", {"subscription_status": "active"}, False, True),
    ("past_due", {"subscription_status": "past_due"}, False, True),
    ("canceled_in_grace", {"subscription_status": "canceled", "ended_at": _iso(-2)}, False, True),
    ("canceled_past_grace", {"subscription_status": "canceled", "ended_at": _iso(-30)}, False, False),
    ("unpaid_past_grace", {"subscription_status": "unpaid", "ended_at": _iso(-10)}, False, False),
    ("paused", {"subscription_status": "paused"}, False, False),
    ("incomplete", {"subscription_status": "incomplete"}, False, False),
    ("demo_no_row", None, True, True),
]


@pytest.mark.parametrize("label,fields,is_demo,allowed", CASES, ids=[c[0] for c in CASES])
def test_write_gate_enforced_by_rls(supabase_admin, billing_user, label, fields, is_demo, allowed):
    """The RLS gate allows/blocks a real authenticated-client write per billing state."""
    company_id = billing_user["company_id"]
    user_client = billing_user["client"]

    if is_demo:
        supabase_admin.table("companies").update({"is_demo": True}).eq("id", company_id).execute()
    if fields is None:
        _clear_billing(supabase_admin, company_id)
    else:
        _set_billing(supabase_admin, company_id, **fields)

    if allowed:
        res = _try_write(user_client, company_id)
        assert res.data and res.data[0]["name"] == "billing-gate-test"
        supabase_admin.table("customers").delete().eq("id", res.data[0]["id"]).execute()
    else:
        with pytest.raises(Exception) as exc:
            _try_write(user_client, company_id)
        _assert_rls_blocked(exc.value)


def test_select_still_works_when_write_blocked(supabase_admin, billing_user):
    """Read-only, never a hard lockout: a lapsed company can still SELECT."""
    company_id = billing_user["company_id"]
    _set_billing(supabase_admin, company_id, subscription_status="canceled", ended_at=_iso(-30))
    # A row seeded via service role (bypasses RLS); the user can still read it.
    supabase_admin.table("customers").insert(
        {"company_id": company_id, "name": "readable"}
    ).execute()

    read = billing_user["client"].table("customers").select("name").eq(
        "company_id", company_id
    ).execute()
    assert any(r["name"] == "readable" for r in read.data)

    # …but a write is rejected.
    with pytest.raises(Exception) as exc:
        _try_write(billing_user["client"], company_id)
    _assert_rls_blocked(exc.value)


def test_company_can_write_parity(supabase_admin, billing_user):
    """The SQL company_can_write() matches the entitlement rule for every golden
    case — the DB half of the getEntitlement <-> company_can_write parity."""
    company_id = billing_user["company_id"]
    for label, fields, is_demo, allowed in CASES:
        supabase_admin.table("companies").update({"is_demo": is_demo}).eq("id", company_id).execute()
        # Clear first so a prior case's columns (e.g. billing_exempt) never leak
        # into this one via upsert.
        _clear_billing(supabase_admin, company_id)
        if fields is not None:
            _set_billing(supabase_admin, company_id, **fields)

        got = supabase_admin.rpc("company_can_write", {"check_company_id": company_id}).execute()
        assert got.data is allowed, f"company_can_write parity failed for {label}: {got.data}"


def test_apply_stripe_subscription_monotonic_and_exempt_clear(supabase_admin, billing_user):
    """The webhook sync RPC: stale events are rejected; exempt clears on active but
    NOT on trialing (Amendment 4)."""
    company_id = billing_user["company_id"]
    _clear_billing(supabase_admin, company_id)

    def apply(status, event_at):
        supabase_admin.rpc(
            "apply_stripe_subscription",
            {
                "p_company_id": company_id, "p_stripe_customer_id": "cus_test",
                "p_stripe_subscription_id": "sub_test", "p_status": status,
                "p_price_id": "price_test", "p_current_period_end": None,
                "p_cancel_at": None, "p_canceled_at": None, "p_ended_at": None,
                "p_trial_end": None, "p_event_at": event_at,
            },
        ).execute()

    def row():
        return supabase_admin.table("company_billing").select("*").eq(
            "company_id", company_id
        ).single().execute().data

    apply("trialing", "2026-01-01T00:00:00+00:00")
    assert row()["subscription_status"] == "trialing"
    apply("active", "2025-12-31T00:00:00+00:00")  # stale → rejected by monotonic guard
    assert row()["subscription_status"] == "trialing"
    apply("active", "2026-01-02T00:00:00+00:00")  # newer → applies
    assert row()["subscription_status"] == "active"

    # Exempt clears only on active/past_due, not trialing.
    _set_billing(supabase_admin, company_id, billing_exempt=True)
    apply("trialing", "2026-02-01T00:00:00+00:00")
    assert row()["billing_exempt"] is True
    apply("active", "2026-02-02T00:00:00+00:00")
    assert row()["billing_exempt"] is False


def test_no_tenant_table_left_ungated(supabase_admin):
    """The tech-debt guard: every browser-writable tenant table is gated or
    explicitly exempt. A new tenant table left un-gated fails this test."""
    res = supabase_admin.rpc("tenant_tables_missing_write_gate", {}).execute()
    assert res.data == [], f"tenant tables missing the billing write-gate: {res.data}"


def test_no_definer_function_walks_past_the_gate(supabase_admin):
    """The companion guard, and the one that would have caught #645.

    `test_no_tenant_table_left_ungated` checks that a POLICY EXISTS. A SECURITY
    DEFINER function runs as the function owner, and no table here sets FORCE ROW
    LEVEL SECURITY, so an owner bypasses RLS entirely — a definer function writing
    a gated table is invisible to a policy-existence check.

    That is exactly how all five location-stock RPCs shipped with no entitlement
    check while CI stayed green, and it made billing depend on a feature flag: a
    lapsed shop with `inventory_locations` OFF was blocked (direct browser insert,
    gate applies) and the same shop with it ON could write freely.
    """
    res = supabase_admin.rpc("definer_writers_missing_write_gate", {}).execute()
    assert res.data == [], (
        "SECURITY DEFINER functions write a billing-gated table without calling "
        f"company_can_write: {res.data}. Add PERFORM public.inv_assert_can_write(<company>) "
        "after the membership check, or argue the exemption in the function's list."
    )
