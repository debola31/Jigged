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


def _seed_customer(admin, company_id: str) -> str:
    """A customer row created with the service role, so it exists regardless of billing."""
    res = admin.table("customers").insert(
        {"company_id": company_id, "name": "gate-fixture"}
    ).execute()
    return res.data[0]["id"]


def _try_update(user_client, row_id: str):
    """PATCH a gated tenant row as the authenticated user."""
    return (
        user_client.table("customers")
        .update({"name": "gate-fixture-renamed"})
        .eq("id", row_id)
        .execute()
    )


def _try_delete(user_client, row_id: str):
    return user_client.table("customers").delete().eq("id", row_id).execute()


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


def test_update_blocked_when_billing_lapsed(supabase_admin, billing_user):
    """A blocked UPDATE must RAISE, not quietly change nothing.

    Until `billing_gate_update_with_check` the gate blocked updates through the policy's USING
    clause, which FILTERS the row out of the statement rather than refusing it — so a lapsed
    shop's save affected zero rows and returned no error. `markOperationReceived` reported
    `{"success": true}` on a row it never touched because of exactly this.
    """
    company_id = billing_user["company_id"]
    row_id = _seed_customer(supabase_admin, company_id)
    _set_billing(supabase_admin, company_id, subscription_status="canceled", ended_at=_iso(-30))

    with pytest.raises(Exception) as exc:
        _try_update(billing_user["client"], row_id)
    _assert_rls_blocked(exc.value)

    # And the row genuinely did not change.
    row = supabase_admin.table("customers").select("name").eq("id", row_id).single().execute()
    assert row.data["name"] == "gate-fixture"


def test_update_blocked_on_parent_resolved_child(supabase_admin, billing_user):
    """The same, for a child table that resolves its company through a parent FK.

    job_operations is the one that matters: it is the table behind markOperationReceived, and
    it has no company_id of its own, so it cannot use apply_billing_write_gate.
    """
    company_id = billing_user["company_id"]
    job = supabase_admin.table("jobs").insert(
        {
            "company_id": company_id,
            "job_number": "J-GATE-1",
            "production_status": "not_started",
            "fulfillment_status": "unshipped",
        }
    ).execute().data[0]
    part = supabase_admin.table("parts").insert(
        {
            "company_id": company_id,
            "part_name": "gate-part",
            "source": "made",
            "primary_unit": "ea",
        }
    ).execute().data[0]
    job_part = supabase_admin.table("job_parts").insert(
        {
            "company_id": company_id,
            "job_id": job["id"],
            "part_id": part["id"],
            "sequence": 1,
            "quantity": 1,
            "production_status": "not_started",
            "fulfillment_status": "unshipped",
        }
    ).execute().data[0]
    op = supabase_admin.table("job_operations").insert(
        {"job_id": job["id"], "job_part_id": job_part["id"], "operation_name": "mill", "sequence": 1}
    ).execute().data[0]

    _set_billing(supabase_admin, company_id, subscription_status="canceled", ended_at=_iso(-30))

    with pytest.raises(Exception) as exc:
        billing_user["client"].table("job_operations").update(
            {"status": "completed"}
        ).eq("id", op["id"]).execute()
    _assert_rls_blocked(exc.value)


def test_blocked_writes_name_the_billing_policy(supabase_admin, billing_user):
    """The message must name `billing_gate_*`.

    This is a CONTRACT, not an incidental detail. `isBillingWriteBlocked` in
    lib/supabaseErrors.ts keys on that substring to tell a lapsed subscription from a plain
    permission denial, and everything downstream — the copy, the Subscribe button, the Sentry
    exemption — hangs off it. Rename the policies and every one of those silently reverts to
    "You don't have permission to do that."

    It holds because Postgres emits one WithCheckOption per RESTRICTIVE policy, each carrying
    its own name, while OR-folding the permissive ones into a single nameless entry.
    """
    company_id = billing_user["company_id"]
    row_id = _seed_customer(supabase_admin, company_id)
    _set_billing(supabase_admin, company_id, subscription_status="canceled", ended_at=_iso(-30))

    with pytest.raises(Exception) as exc:
        _try_write(billing_user["client"], company_id)
    assert "billing_gate_insert" in str(exc.value), (
        f"INSERT denial must name its policy, got: {exc.value}"
    )

    with pytest.raises(Exception) as exc:
        _try_update(billing_user["client"], row_id)
    assert "billing_gate_update" in str(exc.value), (
        f"UPDATE denial must name its policy, got: {exc.value}"
    )


def test_permissive_denial_is_nameless(supabase_admin, billing_user):
    """The other half of that contract: a MEMBERSHIP failure must NOT name a billing policy.

    Permissive policies OR-fold into one unnamed WithCheckOption, so writing into a company you
    do not belong to produces the bare form. If this ever changes, `isBillingWriteBlocked`
    starts matching non-members and the product offers a Subscribe button to someone whose
    problem paying would not fix.
    """
    other = supabase_admin.table("companies").insert({"name": "gate-nonmember-co"}).execute().data[0]
    # Writable, so billing is definitively not the reason this write fails.
    supabase_admin.table("company_billing").upsert(
        {"company_id": other["id"], "subscription_status": "active"}, on_conflict="company_id"
    ).execute()
    try:
        with pytest.raises(Exception) as exc:
            billing_user["client"].table("customers").insert(
                {"company_id": other["id"], "name": "intruder"}
            ).execute()
        _assert_rls_blocked(exc.value)
        assert "billing_gate" not in str(exc.value), (
            f"a membership denial must stay nameless, got: {exc.value}"
        )
    finally:
        supabase_admin.table("companies").delete().eq("id", other["id"]).execute()


def test_delete_is_silently_filtered_when_lapsed(supabase_admin, billing_user):
    """DELETE stays silent, deliberately — this pins the decision so nobody 'fixes' it.

    A DELETE policy has no WITH CHECK to fail through, so the only RLS-shaped fix would be
    USING (true) plus a BEFORE DELETE trigger that raises — which inverts the failure mode from
    fail-closed to fail-OPEN if that trigger is ever dropped. Not worth it: this repo
    soft-deletes every user-facing entity (archive is an UPDATE, covered above), and the
    remaining hard deletes assert the returned row count in TypeScript instead (assertDeleted).
    """
    company_id = billing_user["company_id"]
    row_id = _seed_customer(supabase_admin, company_id)
    _set_billing(supabase_admin, company_id, subscription_status="canceled", ended_at=_iso(-30))

    res = _try_delete(billing_user["client"], row_id)
    assert res.data == [], "expected the delete to be filtered to zero rows, not to raise"

    still = supabase_admin.table("customers").select("id").eq("id", row_id).execute()
    assert still.data, "the row should still be there — the delete was refused"


def test_update_gate_never_filters(supabase_admin):
    """Every billing_gate_update must be USING (true) WITH CHECK (...).

    The completeness guard next door checks a tenant table IS gated; it cannot see that one is
    gated the OLD, silent way. That is exactly how this bug would come back, because the
    natural thing to hand-write is the USING(...) WITH CHECK(...) pair visible on every other
    policy.
    """
    res = supabase_admin.rpc("tenant_tables_with_silent_update_gate", {}).execute()
    assert res.data == [], (
        f"these tables still filter blocked updates instead of raising: {res.data}"
    )


def test_gate_key_is_immutable(supabase_admin, billing_user):
    """company_id cannot be moved to another company from the browser.

    `USING (true)` is only equivalent to the old shape because NEW.company_id ≡ OLD.company_id.
    Without this trigger a member of both a lapsed company A and a writable company B could
    PATCH an A row's company_id to B and pass both checks.
    """
    company_id = billing_user["company_id"]
    row_id = _seed_customer(supabase_admin, company_id)
    other = supabase_admin.table("companies").insert({"name": "gate-move-target"}).execute().data[0]
    try:
        with pytest.raises(Exception) as exc:
            billing_user["client"].table("customers").update(
                {"company_id": other["id"]}
            ).eq("id", row_id).execute()
        assert "immutable" in str(exc.value).lower(), (
            f"expected the gate-key immutability trigger to fire, got: {exc.value}"
        )
    finally:
        supabase_admin.table("companies").delete().eq("id", other["id"]).execute()


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
