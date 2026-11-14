"""The demo lifecycle: create, reset, and reset again — issues #675 and #550.

WHAT THIS GUARDS. Until this file, `create_demo_company`, `reset_demo_company` and
`seed_demo_data` had no automated coverage at all, and both of the ways that could fail did:

1. **The seeder drifted off the schema and nobody noticed for five months.** The active template
   and the seeder were written against a March 2026 schema. By August the seeder referenced five
   columns that no longer existed (`customers.contact_name`, `quotes.lead_time_days`,
   `jobs.status`, `job_parts.status`, and a template that omitted `parts.primary_unit`). Demo mode
   was not degraded, it was *unenterable* — `create_demo_company` calls the same seeder, so a
   company without a demo could not make one, and Reset threw on the first INSERT.

2. **Reset was RESTRICT-blocked by its own output (#675).** The function deleted 19 tables and
   never touched `shipments`, `shipment_line_items` or `part_location_stock`. Because the body is
   a single plpgsql transaction, one RESTRICT violation rolled the whole thing back — so a demo
   that had shipped anything could never be reset again, permanently, and it deleted *nothing*
   rather than deleting some of it.

The second failure is why `test_reset_is_repeatable` resets **twice**. The first reset runs
against a hand-seeded demo; only the second runs against a demo the seeder itself produced, which
is the state that holds shipments and per-location stock. A single reset passes even with the
#675 bug present, which is exactly how it survived review.

These tests deliberately assert *derived* state — `parts.quantity` against the sum of
`part_location_stock`, job statuses against completions — rather than the template's own numbers.
Asserting the template back at itself would pass even if every trigger were broken. Counts are
asserted as lower bounds so growing the template does not break the suite; the point is that the
graph is populated and internally consistent, not that it has exactly N rows.

Requires a local Supabase with all migrations applied. Skipped without it.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest

pytestmark = pytest.mark.integration


def _demo_id(supabase_admin, source_company_id: str) -> str | None:
    row = (
        supabase_admin.table("companies")
        .select("demo_company_id")
        .eq("id", source_company_id)
        .single()
        .execute()
    )
    return row.data["demo_company_id"]


def _count(supabase_admin, table: str, company_id: str) -> int:
    res = (
        supabase_admin.table(table)
        .select("id", count="exact")
        .eq("company_id", company_id)
        .execute()
    )
    return res.count or 0


def _ids(supabase_admin, table: str, company_id: str) -> list[str]:
    rows = (
        supabase_admin.table(table).select("id").eq("company_id", company_id).execute()
    ).data
    return [r["id"] for r in rows]


def _wipe_company(supabase_admin, company_id: str) -> None:
    """Delete a company's rows leaves-first so the company row itself can be dropped.

    This mirrors `reset_demo_company`'s ordering for the same reason it exists there: several
    children are ON DELETE RESTRICT against parts / work_centers / inventory_locations, so the
    CASCADE from `companies` cannot get through them on its own. Teardown only — the tests
    exercise the real function, never this.
    """
    part_ids = _ids(supabase_admin, "parts", company_id)
    job_ids = _ids(supabase_admin, "jobs", company_id)
    routing_ids = _ids(supabase_admin, "routings", company_id)
    shipment_ids = _ids(supabase_admin, "shipments", company_id)

    def wipe(table: str, column: str, values: list[str]) -> None:
        if values:
            supabase_admin.table(table).delete().in_(column, values).execute()

    def wipe_company(table: str) -> None:
        supabase_admin.table(table).delete().eq("company_id", company_id).execute()

    # Purchasing first, leaves first, as reset_demo_company does: PO lines RESTRICT parts, jobs,
    # job parts and operations; receipts RESTRICT their lines; RFQ lines RESTRICT parts and
    # jobs; invitations RESTRICT vendors. The preference is cleared before the list rows go,
    # so no "a preferred vendor is always listed" rule can stand in the way of the delete.
    supabase_admin.table("parts").update({"preferred_vendor_id": None}).eq("company_id", company_id).execute()
    for t in ("quickbooks_purchase_order_line_links", "quickbooks_purchase_order_links",
              "quickbooks_vendor_map", "quickbooks_purchasing_setup",
              "vendor_rfq_responses", "vendor_rfq_invitations", "vendor_rfq_lines",
              "part_vendor_price_breaks", "part_vendors",
              "vendor_purchase_order_receipts", "vendor_purchase_order_revisions",
              "outside_shipment_receipts", "outside_shipments",
              "vendor_purchase_order_lines", "vendor_purchase_orders", "vendor_rfqs",
              "purchasing_document_series"):
        wipe_company(t)

    wipe("shipment_line_items", "shipment_id", shipment_ids)
    for t in ("shipments", "note_reactions", "note_views", "note_media", "notes",
              "job_fulfillment_audit", "job_operation_completions", "inventory_transactions",
              "part_location_stock"):
        wipe_company(t)
    # Lots after the ledger and the balances, before parts: material_lots.part_id RESTRICTs.
    for t in ("lot_certificates", "material_lots"):
        wipe_company(t)
    wipe("job_materials", "job_id", job_ids)
    wipe("job_operations", "job_id", job_ids)
    for t in ("job_parts", "jobs", "quote_line_items", "quotes"):
        wipe_company(t)
    wipe("routing_operations", "routing_id", routing_ids)
    wipe_company("routings")
    if part_ids:
        supabase_admin.table("parts_bom").delete().in_("parent_part_id", part_ids).execute()
        supabase_admin.table("parts_bom").delete().in_("child_part_id", part_ids).execute()
        supabase_admin.table("part_pricing_tiers").delete().in_("part_id", part_ids).execute()
        supabase_admin.table("parts_unit_conversions").delete().in_("part_id", part_ids).execute()
    # vendor_services before vendors: vendor_services.vendor_id RESTRICTs, so a
    # vendor that performs a service cannot be deleted while the service stands.
    for t in ("part_pricing_tiers", "parts", "work_center_attachments", "work_centers",
              "customers", "vendor_services", "vendors"):
        wipe_company(t)
    # inventory_locations.parent_id RESTRICTs itself — children before parents.
    supabase_admin.table("inventory_locations").delete().eq(
        "company_id", company_id
    ).not_.is_("parent_id", "null").execute()
    wipe_company("inventory_locations")


# A source flag set chosen to cover the case that is easy to get wrong: a flag EXPLICITLY turned
# off, alongside one that is simply ABSENT. `readFeatureFlag` resolves an omitted key to the
# descriptor's default, and every registered flag now defaults ON — so squashing "absent" into
# "false" would kill a feature the tenant can see, and squashing "false" into "absent" would
# silently re-enable one they had killed. The mirror must preserve the difference, not merely the
# truthiness.
#
# `example_flag` is deliberately left OUT of this dict: its absence is the second half of the
# assertion. It is not a registered flag, and need not be: `sync_demo_features` copies the block
# verbatim, whatever its keys. It stands in for `dashboard_revenue`, retired 2026-11-08, which left
# `ai_insights` the only registered flag. (The opt-IN half this comment used to describe went with
# the `machine_maintenance` and `quickbooks_desktop` flags in Aug 2026.)
SOURCE_SETTINGS = {
    "features": {
        "ai_insights": False,
    },
    "ai_limits": {"chat_per_hour": 100},
}


def _make_demo(supabase_admin, billing_user, source_settings=None):
    source_id = billing_user["company_id"]
    if source_settings is not None:
        supabase_admin.table("companies").update({"settings": source_settings}).eq(
            "id", source_id
        ).execute()
    billing_user["client"].rpc(
        "create_demo_company",
        {"p_source_company_id": source_id, "p_user_id": billing_user["user_id"]},
    ).execute()
    return {
        "source_id": source_id,
        "demo_id": _demo_id(supabase_admin, source_id),
        "user": billing_user,
        "client": billing_user["client"],
    }


def _drop_demo(supabase_admin, made):
    # The demo company is not the fixture's own company, so _teardown_seeded_user will not
    # reach it.
    if made["demo_id"]:
        _wipe_company(supabase_admin, made["demo_id"])
        supabase_admin.table("companies").update({"demo_company_id": None}).eq(
            "id", made["source_id"]
        ).execute()
        supabase_admin.table("companies").delete().eq("id", made["demo_id"]).execute()


@pytest.fixture
def demo(supabase_admin, billing_user):
    """A company whose demo has been created through the real RPC, as the real user.

    `billing_user` is reused only because it is the one function-scoped fixture that yields a
    fresh company plus an admin user holding a JWT — `create_demo_company` requires both
    (`auth.uid()` must equal p_user_id, and the caller must be an admin of the source company).
    Nothing here touches billing.
    """
    made = _make_demo(supabase_admin, billing_user)
    yield made
    _drop_demo(supabase_admin, made)


@pytest.fixture
def flagged_demo(supabase_admin, billing_user):
    """Same, but the source company carries SOURCE_SETTINGS *before* the demo is created — so
    these tests see what `create_demo_company` copied rather than what a later sync fixed up."""
    made = _make_demo(supabase_admin, billing_user, SOURCE_SETTINGS)
    yield made
    _drop_demo(supabase_admin, made)


def _settings(supabase_admin, company_id: str) -> dict:
    row = (
        supabase_admin.table("companies")
        .select("settings")
        .eq("id", company_id)
        .single()
        .execute()
    )
    return row.data["settings"] or {}


def test_create_demo_company_seeds_the_graph(supabase_admin, demo):
    """First entry creates the hidden company and populates it. This is the assertion that
    would have caught the schema drift: every one of these tables is written by a different
    branch of the seeder, and the old seeder died at the first (`parts`)."""
    demo_id = demo["demo_id"]
    assert demo_id, "create_demo_company did not link a demo company"

    company = (
        supabase_admin.table("companies").select("is_demo").eq("id", demo_id).single().execute()
    )
    assert company.data["is_demo"] is True

    # Lower bounds, not equalities — the template is expected to grow.
    for table, at_least in (
        ("inventory_locations", 10),
        ("vendors", 3),
        ("work_centers", 6),
        ("vendor_services", 1),
        ("parts", 20),
        ("part_location_stock", 10),
        ("customers", 4),
        ("quotes", 4),
        ("jobs", 6),
        ("job_parts", 8),
        ("notes", 10),
        ("shipments", 2),
        ("inventory_transactions", 5),
    ):
        assert _count(supabase_admin, table, demo_id) >= at_least, f"{table} under-seeded"


def test_seeded_part_quantities_are_derived_not_asserted(supabase_admin, demo):
    """`parts.quantity` is maintained from `part_location_stock` by trigger. If the seeder wrote
    both — the mistake `seed_new_part_balance` exists to make easy — every part carrying stock
    would read double. Recompute the sum independently and compare."""
    demo_id = demo["demo_id"]

    parts = (
        supabase_admin.table("parts")
        .select("id, part_name, quantity")
        .eq("company_id", demo_id)
        .execute()
    ).data
    stock = (
        supabase_admin.table("part_location_stock")
        .select("part_id, quantity")
        .eq("company_id", demo_id)
        .execute()
    ).data

    summed: dict[str, float] = {}
    for row in stock:
        summed[row["part_id"]] = summed.get(row["part_id"], 0) + float(row["quantity"])

    for p in parts:
        assert float(p["quantity"]) == summed.get(p["id"], 0.0), (
            f"{p['part_name']}: parts.quantity {p['quantity']} != "
            f"sum(part_location_stock) {summed.get(p['id'], 0.0)}"
        )
    # Every balance row is a real holding (#657), so a part with balance rows reads non-zero and
    # a part with none reads exactly 0. `is_stocked` used to select which parts had to be
    # positive; with the flag gone the balances themselves are the discriminator, which is a
    # stronger assertion — it now covers every part rather than the flagged subset.
    for part_id, total in summed.items():
        assert total > 0, f"part {part_id}: has balance rows summing to {total}"


def test_seeded_job_statuses_come_from_the_triggers(supabase_admin, demo):
    """The seeder inserts every job as not_started/unshipped and lets completions and shipment
    lines drive the rest. If it asserted statuses directly they could hold a combination the app
    can never produce — a job 'completed' with pending operations, say. Assert the spread exists
    and that each status agrees with the rows underneath it."""
    demo_id = demo["demo_id"]

    jobs = (
        supabase_admin.table("jobs")
        .select("id, job_number, production_status, fulfillment_status")
        .eq("company_id", demo_id)
        .execute()
    ).data

    production = {j["production_status"] for j in jobs}
    fulfillment = {j["fulfillment_status"] for j in jobs}
    assert {"not_started", "in_progress", "completed"} <= production, (
        f"demo should show every production status, saw {production}"
    )
    assert {"unshipped", "fully_shipped"} <= fulfillment, (
        f"demo should show shipped and unshipped work, saw {fulfillment}"
    )

    # A job is completed only if none of its parts are still outstanding.
    by_job: dict[str, list[str]] = {}
    for jp in (
        supabase_admin.table("job_parts")
        .select("job_id, production_status")
        .eq("company_id", demo_id)
        .execute()
    ).data:
        by_job.setdefault(jp["job_id"], []).append(jp["production_status"])

    for j in jobs:
        parts = by_job.get(j["id"], [])
        if j["production_status"] == "completed":
            assert parts and all(s in ("completed", "cancelled") for s in parts), (
                f"{j['job_number']} is completed but its parts are {parts}"
            )
        if j["production_status"] == "not_started":
            assert all(s == "not_started" for s in parts), (
                f"{j['job_number']} is not_started but its parts are {parts}"
            )


# Outside steps travel on vendor packing slips (20261112194119). The template marks some outside
# steps `sent` and some `completed`; until that migration the seeder wrote those statuses straight
# onto job_operations with no slip behind them -- a fix 20260903203741 had made and a later rebuild
# silently reverted. compute_job_operation_status reads only slips and receipts, so each such step
# disagreed with its own derivation and the first part-quantity edit dropped it to `pending`.
def _outside_steps(supabase_admin, company_id: str) -> tuple[list[dict], dict, dict]:
    """-> (the demo's outside operations, their live slips by operation with each slip's live
    good quantity, ordered quantity by job_part id)."""
    job_ids = _ids(supabase_admin, "jobs", company_id)
    ops = (
        supabase_admin.table("job_operations")
        .select("id, job_part_id, status, sent_at")
        .in_("job_id", job_ids).not_.is_("vendor_service_id", "null").execute()
    ).data
    slips = (
        supabase_admin.table("outside_shipments")
        .select("id, job_operation_id, slip_number, quantity, shipped_at, due_back_on, "
                "vendor_name, service_name, closed_at, voided_at")
        .eq("company_id", company_id).execute()
    ).data
    good: dict[str, float] = {}
    for r in (
        supabase_admin.table("outside_shipment_receipts")
        .select("outside_shipment_id, quantity_good, voided_at")
        .eq("company_id", company_id).execute()
    ).data:
        if r["voided_at"] is None:
            good[r["outside_shipment_id"]] = good.get(r["outside_shipment_id"], 0.0) + float(r["quantity_good"])
    by_op: dict[str, list[dict]] = {}
    for s in slips:
        if s["voided_at"] is None:
            by_op.setdefault(s["job_operation_id"], []).append({**s, "good": good.get(s["id"], 0.0)})
    ordered = {
        jp["id"]: float(jp["quantity"]) for jp in (
            supabase_admin.table("job_parts").select("id, quantity").eq("company_id", company_id).execute()
        ).data
    }
    return ops, by_op, ordered


def _assert_outside_steps_agree_with_their_slips(supabase_admin, company_id: str) -> None:
    ops, by_op, ordered = _outside_steps(supabase_admin, company_id)
    sent = [o for o in ops if o["status"] == "sent"]
    back = [o for o in ops if o["status"] == "completed"]
    assert sent, "the demo shows no outside step at a vendor, so this proves nothing"
    assert back, "the demo shows no outside step that came back, so this proves nothing"

    for op in sent:
        open_slips = [s for s in by_op.get(op["id"], []) if s["closed_at"] is None]
        at_vendor = sum(float(s["quantity"]) - s["good"] for s in open_slips)
        assert open_slips and at_vendor > 0, (
            f"operation {op['id']} reads sent with no live slip holding pieces at the vendor")
        for s in open_slips:
            assert s["slip_number"].startswith("VPS-"), s["slip_number"]
            assert s["vendor_name"] and s["service_name"], "the slip froze no vendor or service name"
            assert s["due_back_on"] >= s["shipped_at"][:10], "due back before it left"
        first_out = min(s["shipped_at"] for s in by_op[op["id"]])
        assert datetime.fromisoformat(op["sent_at"]) == datetime.fromisoformat(first_out), (
            "sent_at must mirror the first live slip")

    for op in back:
        returned = sum(s["good"] for s in by_op.get(op["id"], []))
        assert returned >= ordered[op["job_part_id"]], (
            f"operation {op['id']} reads completed with {returned} of "
            f"{ordered[op['job_part_id']]} back on its slips")


def test_seeded_outside_steps_are_backed_by_slips(supabase_admin, demo):
    """Every demo step at a vendor has a live VPS- slip with pieces outstanding, and every one that
    came back has receipts covering the part -- the rows the status is derived from."""
    _assert_outside_steps_agree_with_their_slips(supabase_admin, demo["demo_id"])


def test_a_part_quantity_edit_leaves_a_seeded_send_at_the_vendor(supabase_admin, demo):
    """The symptom that was reported. recompute_job_ops_status_from_part_qty() re-derives every
    operation on the part; with no slip behind it a seeded `sent` step came back `pending`."""
    demo_id = demo["demo_id"]
    ops, _, ordered = _outside_steps(supabase_admin, demo_id)
    op = next(o for o in ops if o["status"] == "sent")

    supabase_admin.table("job_parts").update(
        {"quantity": ordered[op["job_part_id"]] + 1}
    ).eq("id", op["job_part_id"]).execute()

    after = (
        supabase_admin.table("job_operations").select("status, sent_at").eq("id", op["id"])
        .single().execute()
    ).data
    assert after["status"] == "sent", f"a quantity edit moved a step at the vendor to {after['status']}"
    assert after["sent_at"] == op["sent_at"], "a quantity edit rewrote the send stamp"


def test_reset_twice_sends_the_outside_steps_on_fresh_slips(supabase_admin, demo):
    """Reset deletes receipts, then slips, before the operations they belong to -- and the
    re-seeded jobs reuse their numbers, so a slip left behind would collide on VPS-{job}-1. Twice,
    for #675's reason: only the second reset runs against slips the seeder itself wrote."""
    demo_id, client, user = demo["demo_id"], demo["client"], demo["user"]
    args = {"p_source_company_id": demo["source_id"], "p_user_id": user["user_id"]}

    client.rpc("reset_demo_company", args).execute()
    client.rpc("reset_demo_company", args).execute()

    _assert_outside_steps_agree_with_their_slips(supabase_admin, demo_id)
    numbers = [
        s["slip_number"] for s in (
            supabase_admin.table("outside_shipments").select("slip_number")
            .eq("company_id", demo_id).execute()
        ).data
    ]
    assert len(numbers) == len(set(numbers)), f"a reset stacked slips: {sorted(numbers)}"


def test_reset_is_repeatable(supabase_admin, demo):
    """#675. The FIRST reset is not the interesting one — the second is, because by then the demo
    holds the shipments and per-location stock the seeder wrote, and those are RESTRICT parents of
    job_parts and parts. With the old function this raised and, being one transaction, left the
    demo permanently un-resettable with nothing deleted."""
    demo_id, client, user = demo["demo_id"], demo["client"], demo["user"]
    args = {"p_source_company_id": demo["source_id"], "p_user_id": user["user_id"]}

    before = _count(supabase_admin, "parts", demo_id)
    assert _count(supabase_admin, "shipments", demo_id) > 0, (
        "the guard is meaningless unless the seed actually produced shipments"
    )

    client.rpc("reset_demo_company", args).execute()
    client.rpc("reset_demo_company", args).execute()

    assert _demo_id(supabase_admin, demo["source_id"]) == demo_id, "reset must keep the company"
    assert _count(supabase_admin, "parts", demo_id) == before, "reset must re-seed to the same shape"
    # No duplication: reset wipes before it seeds, so a second run cannot stack a second copy.
    assert _count(supabase_admin, "shipments", demo_id) > 0


def test_reset_clears_the_tables_that_were_out_of_scope(supabase_admin, demo):
    """The 15 `company_id` tables reset used to ignore. A row inserted into each must be gone
    afterwards — otherwise 'reset to template state' quietly means 'mostly'."""
    demo_id, client, user = demo["demo_id"], demo["client"], demo["user"]

    part_id = (
        supabase_admin.table("parts").select("id").eq("company_id", demo_id).limit(1).execute()
    ).data[0]["id"]
    location_id = (
        supabase_admin.table("inventory_locations")
        .select("id")
        .eq("company_id", demo_id)
        .limit(1)
        .execute()
    ).data[0]["id"]

    # A shelf and a balance the template did not create, standing in for anything a user does
    # while exploring the demo.
    stray_location = (
        supabase_admin.table("inventory_locations")
        .insert({"company_id": demo_id, "name": "Stray Shelf", "kind": "shelf"})
        .execute()
    ).data[0]["id"]
    supabase_admin.table("company_custom_units").insert(
        {"company_id": demo_id, "unit_name": "stray-unit"}
    ).execute()

    client.rpc(
        "reset_demo_company",
        {"p_source_company_id": demo["source_id"], "p_user_id": user["user_id"]},
    ).execute()

    for table, row_id in (
        ("inventory_locations", stray_location),
        ("parts", part_id),
        ("part_location_stock", None),
    ):
        if row_id:
            gone = supabase_admin.table(table).select("id").eq("id", row_id).execute()
            assert gone.data == [], f"{table} row {row_id} survived the reset"

    units = (
        supabase_admin.table("company_custom_units")
        .select("unit_name")
        .eq("company_id", demo_id)
        .execute()
    ).data
    assert "stray-unit" not in {u["unit_name"] for u in units}
    # The stale location_id must not survive either — it was captured before the reset.
    assert (
        supabase_admin.table("inventory_locations").select("id").eq("id", location_id).execute().data
        == []
    )


def test_reset_preserves_membership_and_leaves_the_real_company_alone(supabase_admin, demo):
    """Reset is documented to wipe data and keep the team. And the whole premise of demo mode is
    that the two graphs never touch: the demo is a separate company_id, so a reset must not reach
    across into the user's real data."""
    demo_id, client, user = demo["demo_id"], demo["client"], demo["user"]
    source_id = demo["source_id"]

    supabase_admin.table("parts").insert(
        {
            "company_id": source_id,
            "part_name": "REAL-PART-DO-NOT-TOUCH",
            "source": "bought",
            "primary_unit": "each",
        }
    ).execute()

    access_before = _count(supabase_admin, "user_company_access", demo_id)
    assert access_before > 0, "create_demo_company should have mirrored access"

    client.rpc(
        "reset_demo_company",
        {"p_source_company_id": source_id, "p_user_id": user["user_id"]},
    ).execute()

    assert _count(supabase_admin, "user_company_access", demo_id) == access_before

    real = (
        supabase_admin.table("parts")
        .select("part_name")
        .eq("company_id", source_id)
        .execute()
    ).data
    assert [r["part_name"] for r in real] == ["REAL-PART-DO-NOT-TOUCH"], (
        "reset touched the real company's data"
    )


def test_reset_rejects_a_caller_who_is_not_the_user(supabase_admin, demo):
    """`p_user_id != auth.uid()` is the only thing standing between a signed-in user and someone
    else's demo, since the function is SECURITY DEFINER and reads past RLS."""
    with pytest.raises(Exception) as exc:
        demo["client"].rpc(
            "reset_demo_company",
            {
                "p_source_company_id": demo["source_id"],
                "p_user_id": "00000000-0000-0000-0000-000000000000",
            },
        ).execute()
    assert "Access denied" in str(exc.value)


# ===========================================================================
# Feature-flag mirroring
#
# A demo company is invisible to /admin/companies — admin_routes.py lists with
# .eq("is_demo", False) — so its `settings.features` block cannot be edited
# anywhere. Before mirroring it sat at `{}` forever, meaning every opt-in flag
# read off no matter what the real company had enabled.
# ===========================================================================


def test_create_mirrors_source_feature_flags(supabase_admin, flagged_demo):
    """The demo stands in for the user's own company, so it must show the same product
    surface. Copied verbatim: an explicit `false` has to survive as `false` AND an absent key has
    to stay absent, because an absent key resolves to the descriptor default and every registered
    flag defaults ON."""
    demo_features = _settings(supabase_admin, flagged_demo["demo_id"]).get("features")
    assert demo_features == SOURCE_SETTINGS["features"]


def test_ai_limits_are_deliberately_not_mirrored(supabase_admin, flagged_demo):
    """`ai_limits` is admin-only like `features`, and is withheld on purpose: it caps Anthropic
    spend per company, so copying a raised cap onto a second company_id doubles the exposure.
    The demo keeps the default (20/hour) instead."""
    assert "ai_limits" not in _settings(supabase_admin, flagged_demo["demo_id"])


def test_entry_sync_propagates_a_flag_flipped_after_creation(supabase_admin, flagged_demo):
    """Flags change after a demo exists. `sync_demo_access` is what DemoModeProvider calls on
    every entry, which makes it the one place that convergence can happen."""
    source_id, demo_id = flagged_demo["source_id"], flagged_demo["demo_id"]

    changed = dict(SOURCE_SETTINGS["features"])
    changed["ai_insights"] = True            # newly enabled (was an explicit false)
    changed["example_flag"] = False     # newly disabled (was absent, i.e. default on)
    supabase_admin.table("companies").update(
        {"settings": {**SOURCE_SETTINGS, "features": changed}}
    ).eq("id", source_id).execute()

    flagged_demo["client"].rpc(
        "sync_demo_access",
        {"p_source_company_id": source_id, "p_demo_company_id": demo_id},
    ).execute()

    assert _settings(supabase_admin, demo_id)["features"] == changed


def test_mirror_leaves_the_demo_editable_settings_blocks_alone(supabase_admin, flagged_demo):
    """Settings is reachable *inside* demo mode — full CRUD is the point — so `defaults` and
    `default_payment_terms` can be edited there. Mirroring the whole `settings` object on every
    entry would silently revert whatever the user had just changed."""
    source_id, demo_id = flagged_demo["source_id"], flagged_demo["demo_id"]

    demo_settings = _settings(supabase_admin, demo_id)
    supabase_admin.table("companies").update(
        {
            "settings": {
                **demo_settings,
                "defaults": {"quote_validity_days": 30},
                "default_payment_terms": "Net 15",
            }
        }
    ).eq("id", demo_id).execute()

    # An admin flips a flag on the source; entry re-syncs.
    supabase_admin.table("companies").update(
        {"settings": {**SOURCE_SETTINGS, "features": {"example_flag": False}}}
    ).eq("id", source_id).execute()
    flagged_demo["client"].rpc(
        "sync_demo_access",
        {"p_source_company_id": source_id, "p_demo_company_id": demo_id},
    ).execute()

    after = _settings(supabase_admin, demo_id)
    assert after["features"] == {"example_flag": False}, "the flag change should land"
    assert after["defaults"] == {"quote_validity_days": 30}, "demo-side edit was reverted"
    assert after["default_payment_terms"] == "Net 15", "demo-side edit was reverted"


def test_reset_re_mirrors_flags(supabase_admin, flagged_demo):
    """Reset restores the demo's product surface as well as its rows, so it does not depend on
    when the user last entered."""
    source_id, demo_id = flagged_demo["source_id"], flagged_demo["demo_id"]

    supabase_admin.table("companies").update(
        {"settings": {"features": {"example_flag": False}}}
    ).eq("id", source_id).execute()

    flagged_demo["client"].rpc(
        "reset_demo_company",
        {"p_source_company_id": source_id, "p_user_id": flagged_demo["user"]["user_id"]},
    ).execute()

    assert _settings(supabase_admin, demo_id)["features"] == {"example_flag": False}


def test_sync_demo_features_is_not_reachable_from_the_browser(demo):
    """It is SECURITY DEFINER and writes companies.settings, so an exposed EXECUTE grant would
    let any signed-in user rewrite any company's feature block."""
    with pytest.raises(Exception) as exc:
        demo["client"].rpc(
            "sync_demo_features",
            {
                "p_source_company_id": demo["source_id"],
                "p_demo_company_id": demo["demo_id"],
            },
        ).execute()
    assert "sync_demo_features" in str(exc.value) or "permission denied" in str(exc.value).lower()


def test_every_seeded_part_is_priceable(supabase_admin, demo):
    """No part in the demo may show the Parts page's "Incomplete — needs setup before it can be
    quoted" marker.

    Template v3 failed this against 31 of 45 parts and nobody noticed, because the failure is
    only visible as a column of ⚠ icons — there was no assertion to fail. `get_priceable_part_ids`
    is what the page itself calls, so this asks the same question the UI asks rather than
    re-deriving it: priceable = costable AND carrying a markup pricing tier. Re-implementing that
    rule here would let the two drift apart, which is the whole failure mode.
    """
    demo_id = demo["demo_id"]

    priceable = set(
        supabase_admin.rpc("get_priceable_part_ids", {"p_company_id": demo_id}).execute().data
        or []
    )
    parts = (
        supabase_admin.table("parts")
        .select("id, part_name, source")
        .eq("company_id", demo_id)
        .execute()
    ).data

    incomplete = sorted(
        f"{p['part_name']} ({p['source']})" for p in parts if p["id"] not in priceable
    )
    assert not incomplete, (
        f"{len(incomplete)} of {len(parts)} seeded parts would show the incomplete-setup "
        f"warning:\n  " + "\n  ".join(incomplete)
    )


# ===========================================================================
# sync_demo_access authorization
#
# The function is SECURITY DEFINER — it must be, since it writes
# user_company_access rows for OTHER users — and is granted EXECUTE to anon and
# authenticated. Until 20260808024044 it had no caller check of any kind, and both
# company ids came straight from the caller. That is a privilege-escalation
# primitive: pass your own company as the source and a victim as the "demo", and
# the function inserts you into the victim carrying your own role. Company UUIDs
# are not secrets; they are in every URL the app renders.
#
# It went unnoticed because only the office Settings page (behind AdminGuard)
# reached this RPC. The operator "Me" tab now calls it too, which is what makes
# authorizing it a precondition rather than a cleanup.
# ===========================================================================


def test_sync_rejects_a_company_that_is_not_the_source_demo(supabase_admin, demo, seeded_user_b):
    """THE ESCALATION TEST. User B is a legitimate admin of their own company and names
    someone else's company as the "demo" to sync into. Nothing about that caller is
    suspicious — they are signed in and are a member of the source they pass."""
    victim_id = demo["source_id"]
    b_company_id = seeded_user_b["company_id"]

    before = _count(supabase_admin, "user_company_access", victim_id)

    with pytest.raises(Exception) as exc:
        seeded_user_b["client"].rpc(
            "sync_demo_access",
            {"p_source_company_id": b_company_id, "p_demo_company_id": victim_id},
        ).execute()
    assert "Access denied" in str(exc.value)

    # The assertion that matters is not the raise, it is that nobody was added.
    assert _count(supabase_admin, "user_company_access", victim_id) == before, (
        "sync_demo_access inserted membership into a company the caller has no relationship with"
    )


def test_sync_rejects_a_caller_who_is_not_a_member_of_the_source(demo, seeded_user_b):
    """Guard 1 already makes this harmless in effect — it only copies a company onto its own
    demo. It is still a write on behalf of a company the caller has nothing to do with, and
    there is no reason to allow it."""
    with pytest.raises(Exception) as exc:
        seeded_user_b["client"].rpc(
            "sync_demo_access",
            {
                "p_source_company_id": demo["source_id"],
                "p_demo_company_id": demo["demo_id"],
            },
        ).execute()
    assert "Access denied" in str(exc.value)


def test_sync_still_works_for_a_member_of_the_source(supabase_admin, demo):
    """The guards must not break the thing they protect: this is the call both the office
    provider and the operator "Me" tab make on every entry, and an operator who was hired
    after the demo was created depends on it for their access row."""
    supabase_admin.table("user_company_access").delete().eq(
        "company_id", demo["demo_id"]
    ).eq("user_id", demo["user"]["user_id"]).execute()

    demo["client"].rpc(
        "sync_demo_access",
        {"p_source_company_id": demo["source_id"], "p_demo_company_id": demo["demo_id"]},
    ).execute()

    restored = (
        supabase_admin.table("user_company_access")
        .select("role")
        .eq("company_id", demo["demo_id"])
        .eq("user_id", demo["user"]["user_id"])
        .execute()
    ).data
    assert restored, "entry sync did not mirror the member back into the demo"


# ===========================================================================
# operator_events excludes demo companies
#
# operator_events is the capture funnel and, for the first weeks of the pilot, the
# only readable signal — every reading in utils/operatorEventsAccess.ts is a ratio
# against app_opened. Exploring the demo is exactly the behaviour that fires app_opened,
# station_selected and completion_recorded in bursts, so a training session would
# otherwise be indistinguishable from a good week.
#
# Decided at the WRITE rather than at read time on purpose: a read-time is_demo
# filter is the silent missing-filter failure CLAUDE.md names as the repo's
# most-violated rule. The table cannot contain rows nobody remembers to exclude.
# ===========================================================================


def _operator_event_count(supabase_admin, company_id: str) -> int:
    res = (
        supabase_admin.table("operator_events")
        .select("id", count="exact")
        .eq("company_id", company_id)
        .execute()
    )
    return res.count or 0


def test_operator_events_are_not_recorded_for_a_demo_company(supabase_admin, demo):
    before = _operator_event_count(supabase_admin, demo["demo_id"])

    demo["client"].rpc(
        "log_operator_event",
        {"p_company_id": demo["demo_id"], "p_kind": "app_opened", "p_context": {}},
    ).execute()

    assert _operator_event_count(supabase_admin, demo["demo_id"]) == before, (
        "demo-mode activity entered the funnel every adoption ratio is measured against"
    )


def test_operator_events_are_still_recorded_for_the_real_company(supabase_admin, demo):
    """The control. Without it the test above passes just as well when logging is broken
    outright, which is the failure mode that would silence the pilot's only signal."""
    source_id = demo["source_id"]
    before = _operator_event_count(supabase_admin, source_id)

    demo["client"].rpc(
        "log_operator_event",
        {"p_company_id": source_id, "p_kind": "app_opened", "p_context": {}},
    ).execute()

    assert _operator_event_count(supabase_admin, source_id) == before + 1


# ===========================================================================
# Purchasing in the demo (plan §2 "Demo data", §5.1; V1, S6)
#
# There is no purchasing template: the demo starts with no purchase orders. But a demo user can
# make every kind of purchasing row, and each one is a RESTRICT parent somewhere — PO lines of
# parts, jobs and operations; receipts of their lines; RFQ lines of parts and jobs; invitations
# of vendors; and the heat a receipt records is a material_lots row, which RESTRICTs its part
# and which reset_demo_company never deleted before this. Reset is one transaction, so a single
# missed table rolls the whole reset back and the demo can never be reset again (#675's shape).
# ===========================================================================

PURCHASING_ROWS = (
    "vendor_purchase_orders", "vendor_purchase_order_lines", "vendor_purchase_order_receipts",
    "vendor_purchase_order_revisions", "vendor_rfqs", "vendor_rfq_lines", "vendor_rfq_invitations",
    "vendor_rfq_responses", "part_vendor_price_breaks", "purchasing_document_series",
    "material_lots", "lot_certificates",
)


def _count_rows(supabase_admin, table: str, company_id: str) -> int:
    # By company_id rather than id: purchasing_document_series is keyed (company, kind).
    res = (
        supabase_admin.table(table)
        .select("company_id", count="exact")
        .eq("company_id", company_id)
        .execute()
    )
    return res.count or 0


def _first(rows):
    return rows[0] if isinstance(rows, list) else rows


def _stage_purchasing(supabase_admin, client, demo_id: str) -> dict:
    """Every kind of purchasing row a demo user can make, through the real RPCs as the real
    user: a sent PO with a part line, an outside line linked to a slip and an "other" line on a
    machine; a receipt that records a heat (so a lot) with a certificate on it; and an RFQ with
    an invitation."""
    admin = supabase_admin
    today = date.today().isoformat()

    job_ids = [
        j["id"] for j in admin.table("jobs").select("id").eq("company_id", demo_id)
        .is_("deleted_at", "null").execute().data
    ]
    outside_ops = (
        admin.table("job_operations")
        .select("id, job_part_id, vendor_service_id, status")
        .in_("job_id", job_ids).not_.is_("vendor_service_id", "null").execute().data
    )
    op = next(o for o in outside_ops if o["status"] != "completed")
    vendor = (
        admin.table("vendor_services").select("vendor_id").eq("id", op["vendor_service_id"])
        .single().execute().data["vendor_id"]
    )
    piece_part = (
        admin.table("job_parts").select("part_id").eq("id", op["job_part_id"]).single().execute().data["part_id"]
    )
    piece_unit = (
        admin.table("parts").select("primary_unit").eq("id", piece_part).single().execute().data["primary_unit"]
    )
    material = next(
        p for p in admin.table("parts").select("id, primary_unit").eq("company_id", demo_id)
        .eq("source", "bought").is_("deleted_at", "null").execute().data
        if p["primary_unit"]
    )
    machine = (
        admin.table("work_centers").select("id").eq("company_id", demo_id).is_("deleted_at", "null")
        .limit(1).execute().data[0]["id"]
    )
    places = admin.table("inventory_locations").select("id, parent_id").eq("company_id", demo_id).execute().data
    parents = {p["parent_id"] for p in places if p["parent_id"]}
    leaf = next(p["id"] for p in places if p["id"] not in parents)

    po_id = _first(client.rpc("create_vendor_purchase_order", {
        "p_vendor_id": vendor, "p_ordered_on": today, "p_today": today, "p_header": {},
        "p_lines": [
            {"line_kind": "part", "part_id": material["id"], "quantity": 5, "unit": material["primary_unit"],
             "unit_price": 2.5, "price_source": "manual", "description": "Demo material"},
            {"line_kind": "outside_service", "job_operation_id": op["id"], "quantity": 1, "unit": piece_unit,
             "unit_price": 3.5, "price_source": "vendor_service", "description": "Demo outside step"},
            {"line_kind": "other", "work_center_id": machine, "quantity": 1, "unit": "each",
             "unit_price": 450, "price_source": "manual", "description": "Calibration"},
        ],
    }).execute().data)["id"]
    client.rpc("set_vendor_purchase_order_state",
               {"p_id": po_id, "p_action": "mark_sent", "p_today": today}).execute()
    lines = {
        line["line_kind"]: line["id"] for line in admin.table("vendor_purchase_order_lines")
        .select("id, line_kind").eq("vendor_purchase_order_id", po_id).execute().data
    }

    slip = _first(client.rpc("create_outside_shipment",
                             {"p_job_operation_id": op["id"], "p_quantity": 1}).execute().data)["shipment_id"]
    linked = (
        admin.table("outside_shipments").select("vendor_purchase_order_line_id").eq("id", slip)
        .single().execute().data["vendor_purchase_order_line_id"]
    )
    assert linked == lines["outside_service"], "the demo slip did not link to its PO line"

    client.rpc("receive_vendor_purchase_order", {
        "p_id": po_id, "p_receipt_group_id": str(uuid.uuid4()),
        "p_receipts": [{"line_id": lines["part"], "quantity": 5, "quantity_unit": "purchase",
                        "location_id": leaf, "heat_number": "DEMO-HEAT-1"}],
        "p_received_at": datetime.now(timezone.utc).isoformat(),
    }).execute()
    lot = (
        admin.table("vendor_purchase_order_receipts").select("lot_id").eq("vendor_purchase_order_id", po_id)
        .execute().data[0]["lot_id"]
    )
    admin.table("lot_certificates").insert({
        "company_id": demo_id, "lot_id": lot, "file_name": "mill-cert.pdf",
        "file_path": f"{demo_id}/lots/{lot}/mill-cert.pdf",
    }).execute()

    client.rpc("create_vendor_rfq", {
        "p_company_id": demo_id, "p_vendor_ids": [vendor], "p_header": {"title": "Demo request"},
        "p_lines": [{"part_id": material["id"], "description": "Demo material",
                     "unit": material["primary_unit"], "quantities": [10]}],
    }).execute()
    return {"vendor": vendor, "po_id": po_id}


def test_seeded_preferred_vendors_are_on_their_vendors_lists(supabase_admin, demo):
    """[V1] The template writes `preferred_vendor_id` directly; the trigger on `parts` puts each
    of those vendors on its part's approved list, so the demo's Buying tab is never empty for a
    part that has a preferred vendor."""
    demo_id = demo["demo_id"]
    preferred = (
        supabase_admin.table("parts").select("id, part_name, preferred_vendor_id")
        .eq("company_id", demo_id).not_.is_("preferred_vendor_id", "null").execute().data
    )
    assert preferred, "the template sets no preferred vendor, so this proves nothing"
    listed = {
        (r["part_id"], r["vendor_id"]) for r in supabase_admin.table("part_vendors")
        .select("part_id, vendor_id").eq("company_id", demo_id).is_("deleted_at", "null").execute().data
    }
    missing = [p["part_name"] for p in preferred if (p["id"], p["preferred_vendor_id"]) not in listed]
    assert not missing, f"preferred vendors missing from the approved list: {missing}"


def test_reset_clears_purchasing_twice_and_restarts_the_numbering(supabase_admin, demo):
    """[S6] With a sent PO, an outside line linked to a slip, an "other" line on a machine, a
    receipt with a heat and a certificate, and an RFQ invitation all present, reset succeeds —
    twice, the #675 shape — leaves no purchasing row, lot or certificate behind, and the next PO
    is PO-0001 again because the series went with it."""
    demo_id, client, user = demo["demo_id"], demo["client"], demo["user"]
    _stage_purchasing(supabase_admin, client, demo_id)
    staged = {t: _count_rows(supabase_admin, t, demo_id) for t in PURCHASING_ROWS}
    for table in ("vendor_purchase_orders", "vendor_purchase_order_receipts", "vendor_rfq_invitations",
                  "material_lots", "lot_certificates", "purchasing_document_series"):
        assert staged[table] > 0, f"the staging made no {table}, so the reset proves nothing about it"

    args = {"p_source_company_id": demo["source_id"], "p_user_id": user["user_id"]}
    client.rpc("reset_demo_company", args).execute()
    client.rpc("reset_demo_company", args).execute()

    left = {t: _count_rows(supabase_admin, t, demo_id) for t in PURCHASING_ROWS}
    assert left == {t: 0 for t in PURCHASING_ROWS}, f"reset left purchasing rows behind: {left}"

    vendor = (
        supabase_admin.table("vendors").select("id").eq("company_id", demo_id).is_("deleted_at", "null")
        .limit(1).execute().data[0]["id"]
    )
    today = date.today().isoformat()
    created = _first(client.rpc("create_vendor_purchase_order", {
        "p_vendor_id": vendor, "p_ordered_on": today, "p_today": today, "p_header": {},
        "p_lines": [{"line_kind": "other", "description": "Freight", "quantity": 1, "unit": "each",
                     "unit_price": 45, "price_source": "manual"}],
    }).execute().data)
    assert created["po_number"] == "PO-0001", "the numbering survived the reset"
