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

    wipe("shipment_line_items", "shipment_id", shipment_ids)
    for t in ("shipments", "note_reactions", "note_views", "note_media", "notes",
              "job_fulfillment_audit", "job_operation_completions", "inventory_transactions",
              "part_location_stock"):
        wipe_company(t)
    wipe("job_materials", "job_id", job_ids)
    wipe("job_operations", "job_id", job_ids)
    for t in ("job_parts", "jobs", "quote_line_items", "quote_materials", "quote_operations",
              "quotes"):
        wipe_company(t)
    wipe("routing_operations", "routing_id", routing_ids)
    wipe_company("routings")
    if part_ids:
        supabase_admin.table("parts_bom").delete().in_("parent_part_id", part_ids).execute()
        supabase_admin.table("parts_bom").delete().in_("child_part_id", part_ids).execute()
        supabase_admin.table("part_procurement_tiers").delete().in_("part_id", part_ids).execute()
        supabase_admin.table("parts_unit_conversions").delete().in_("part_id", part_ids).execute()
    for t in ("part_pricing_tiers", "parts", "work_center_attachments", "work_centers",
              "customers", "vendors"):
        wipe_company(t)
    # inventory_locations.parent_id RESTRICTs itself — children before parents.
    supabase_admin.table("inventory_locations").delete().eq(
        "company_id", company_id
    ).not_.is_("parent_id", "null").execute()
    wipe_company("inventory_locations")


# A source flag set chosen to cover the case that is easy to get wrong: an opt-IN flag turned on
# AND an opt-OUT flag explicitly turned off. `readFeatureFlag` resolves an omitted key to the
# descriptor's default, so squashing "absent" into "false" would silently re-enable ai_insights
# for a tenant that had killed it.
SOURCE_SETTINGS = {
    "features": {
        "inventory_locations": True,
        "machine_maintenance": True,
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
    both — the mistake `auto_track_stocked_part` exists to make easy — every stocked part would
    read double. Recompute the sum independently and compare."""
    demo_id = demo["demo_id"]

    parts = (
        supabase_admin.table("parts")
        .select("id, part_name, quantity, is_stocked")
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
        # Every balance row is a real holding (#657), so a stocked part with stock is non-zero.
        if p["is_stocked"]:
            assert float(p["quantity"]) > 0, f"{p['part_name']}: stocked but holds nothing"


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
            "is_stocked": False,
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
    surface. Copied verbatim: an explicit `false` has to survive as `false`, because an
    absent key resolves to the descriptor default and ai_insights defaults to ON."""
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
    changed["data_import"] = True            # newly enabled
    changed["inventory_locations"] = False   # newly disabled
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
        {"settings": {**SOURCE_SETTINGS, "features": {"data_import": True}}}
    ).eq("id", source_id).execute()
    flagged_demo["client"].rpc(
        "sync_demo_access",
        {"p_source_company_id": source_id, "p_demo_company_id": demo_id},
    ).execute()

    after = _settings(supabase_admin, demo_id)
    assert after["features"] == {"data_import": True}, "the flag change should land"
    assert after["defaults"] == {"quote_validity_days": 30}, "demo-side edit was reverted"
    assert after["default_payment_terms"] == "Net 15", "demo-side edit was reverted"


def test_reset_re_mirrors_flags(supabase_admin, flagged_demo):
    """Reset restores the demo's product surface as well as its rows, so it does not depend on
    when the user last entered."""
    source_id, demo_id = flagged_demo["source_id"], flagged_demo["demo_id"]

    supabase_admin.table("companies").update(
        {"settings": {"features": {"machine_maintenance": True}}}
    ).eq("id", source_id).execute()

    flagged_demo["client"].rpc(
        "reset_demo_company",
        {"p_source_company_id": source_id, "p_user_id": flagged_demo["user"]["user_id"]},
    ).execute()

    assert _settings(supabase_admin, demo_id)["features"] == {"machine_maintenance": True}


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
