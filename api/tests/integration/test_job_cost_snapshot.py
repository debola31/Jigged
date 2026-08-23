"""
A job freezes its COST the way it already froze its revenue.

`job_parts.unit_price` / `total_price` have been denormalised off the quote since
20260621162024. The cost side had nothing: `job_operations` froze the MINUTES and
`job_materials` froze the QUANTITIES, but not one rate. So profitability re-read
`work_centers.labor_rate` live and a shipped job's profit moved whenever a rate
changed — and materials could not be charged at all, because no number existed.

What this file pins down, in rough order of how expensive it would be to get
wrong and not notice:

  * FROZEN. Change a labour rate after the fact and the rollup moves while the
    job's snapshot does not. This is the entire point of the feature and the one
    property with no other guard.
  * AGREES AT BIRTH. The snapshot equals `compute_part_cost_at_qty` at the moment
    it is taken — one implementation of the cost rule, not two.
  * RE-TAKEN ON QUANTITY, AND ONLY ON QUANTITY. Cost genuinely depends on how
    many you make (amortised setup, procurement tiers), so a quantity edit
    re-estimates. Any other UPDATE must leave history alone.
  * NEVER BLOCKS, NEVER LIES. A part that cannot be costed still goes on a job;
    its snapshot is NULL, and NULL is reported as excluded, never as free.
  * RECONCILES. Labour rebuilt from the frozen rates plus materials-by-
    subtraction adds back up to the snapshot.
  * THE QUERY ACTUALLY RUNS. `get_part_profitability` returned HTTP 400 from
    2026-06-23 to 2026-08-11 because it selected `external_setup_cost`, dropped
    by 20260623022617. Nothing executed the real select string, so nothing
    noticed for seven weeks. The last test calls the real function.

Run:
    cd api && pytest -m integration tests/integration/test_job_cost_snapshot.py

Requires TEST_SUPABASE_URL + TEST_SUPABASE_SECRET_KEY (service role) — run
`supabase start` then `eval "$(supabase status -o env)"` and export them.
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from decimal import Decimal

import pytest
from supabase import Client, create_client


pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def admin() -> Client:
    url = os.getenv("TEST_SUPABASE_URL")
    key = os.getenv("TEST_SUPABASE_SECRET_KEY")
    if not url or not key:
        pytest.skip("Supabase admin credentials not configured")
    return create_client(url, key)


@dataclass
class JobEnv:
    """One made part on one job, with numbers that divide cleanly by hand.

    WIDGET  made, routing = 30 min setup + 10 min/unit at $60/hr
                  BOM = 2 x BAR
    BAR     bought, $4.00/ea

    At qty 5:  labour (30/5 + 10) x 60/60 = $16.00, materials 2 x 4 = $8.00
               true cost = $24.00/unit
    At qty 10: labour (30/10 + 10) x 60/60 = $13.00, same materials
               true cost = $21.00/unit
    """

    company_id: str
    widget_id: str
    bar_id: str
    work_center_id: str
    job_id: str
    job_part_id: str


def _num(v) -> Decimal | None:
    return None if v is None else Decimal(str(v))


def _rollup(admin: Client, part_id: str, qty: float) -> Decimal | None:
    res = admin.rpc(
        "compute_part_cost_at_qty", {"p_part_id": part_id, "p_qty": qty}
    ).execute()
    return _num(res.data)


def _job_part(admin: Client, job_part_id: str) -> dict:
    return (
        admin.table("job_parts")
        .select("id, quantity, true_cost_per_unit")
        .eq("id", job_part_id)
        .single()
        .execute()
        .data
    )


def _snapshot(admin: Client, job_part_id: str) -> Decimal | None:
    return _num(_job_part(admin, job_part_id)["true_cost_per_unit"])


@pytest.fixture
def env(admin: Client):
    suffix = uuid.uuid4().hex[:8]

    company_id = (
        admin.table("companies")
        .insert({"name": f"JobCost-{suffix}"})
        .execute()
        .data[0]["id"]
    )

    wc_id = (
        admin.table("work_centers")
        .insert(
            {"company_id": company_id, "name": "Mill", "labor_rate": 60}
        )
        .execute()
        .data[0]["id"]
    )

    def make_part(name: str, source: str) -> str:
        return (
            admin.table("parts")
            .insert(
                {
                    "company_id": company_id,
                    "part_name": f"{name}-{suffix}",
                    "source": source,
                    "primary_unit": "ea",
                    "costing_batch_quantity": 1,
                }
            )
            .execute()
            .data[0]["id"]
        )

    bar_id = make_part("BAR", "bought")
    admin.table("part_procurement_tiers").insert(
        {"part_id": bar_id, "min_quantity": 1, "cost_per_unit": 4}
    ).execute()

    widget_id = make_part("WIDGET", "made")
    routing_id = (
        admin.table("routings")
        .insert({"company_id": company_id, "part_id": widget_id, "name": "R"})
        .execute()
        .data[0]["id"]
    )
    admin.table("routing_operations").insert(
        {
            "routing_id": routing_id,
            "work_center_id": wc_id,
            "sequence": 10,
            "setup_minutes": 30,
            "cycle_minutes_per_unit": 10,
        }
    ).execute()
    admin.table("parts_bom").insert(
        {
            "parent_part_id": widget_id,
            "child_part_id": bar_id,
            "quantity": 2,
            "unit": "ea",
            "sequence": 10,
        }
    ).execute()

    job_id = (
        admin.table("jobs")
        .insert(
            {
                "company_id": company_id,
                "job_number": f"J-{suffix}",
                "production_status": "not_started",
                "fulfillment_status": "fully_shipped",
            }
        )
        .execute()
        .data[0]["id"]
    )
    job_part_id = (
        admin.table("job_parts")
        .insert(
            {
                "job_id": job_id,
                "company_id": company_id,
                "part_id": widget_id,
                "sequence": 10,
                "quantity": 5,
                "production_status": "completed",
                "fulfillment_status": "fully_shipped",
                "unit_price": 50,
                "total_price": 250,
            }
        )
        .execute()
        .data[0]["id"]
    )

    yield JobEnv(
        company_id=company_id,
        widget_id=widget_id,
        bar_id=bar_id,
        work_center_id=wc_id,
        job_id=job_id,
        job_part_id=job_part_id,
    )

    admin.table("job_operations").delete().eq("job_id", job_id).execute()
    admin.table("job_materials").delete().eq("job_id", job_id).execute()
    admin.table("job_parts").delete().eq("job_id", job_id).execute()
    admin.table("jobs").delete().eq("id", job_id).execute()
    admin.table("parts_bom").delete().eq("parent_part_id", widget_id).execute()
    admin.table("routings").delete().eq("company_id", company_id).execute()
    admin.table("part_procurement_tiers").delete().eq("part_id", bar_id).execute()
    admin.table("parts").delete().eq("company_id", company_id).execute()
    admin.table("work_centers").delete().eq("company_id", company_id).execute()
    admin.table("companies").delete().eq("id", company_id).execute()


def test_snapshot_is_taken_on_insert_and_equals_the_rollup(admin: Client, env: JobEnv):
    """One implementation of the cost rule. The snapshot is not a re-derivation;
    it is the rollup's own answer, stored."""
    snapshot = _snapshot(admin, env.job_part_id)

    assert snapshot == Decimal("24.0000")  # 16 labour + 8 material, by hand
    assert snapshot == _rollup(admin, env.widget_id, 5)


def test_a_later_rate_change_does_not_move_the_job(admin: Client, env: JobEnv):
    """THE property. A job that shipped is history, not a cost-recalc context.

    Before this feature there was no snapshot to compare against — profitability
    read the live rate, so this assertion could not even be written.
    """
    before = _snapshot(admin, env.job_part_id)

    admin.table("work_centers").update({"labor_rate": 120}).eq(
        "id", env.work_center_id
    ).execute()

    # The part genuinely costs more to make now...
    assert _rollup(admin, env.widget_id, 5) == Decimal("40.0000")  # 32 labour + 8
    # ...and the job still says what it cost when it was created.
    assert _snapshot(admin, env.job_part_id) == before == Decimal("24.0000")


def test_a_material_cost_change_does_not_move_the_job_either(admin: Client, env: JobEnv):
    """Same guarantee on the other half of the cost. Materials were previously
    absent from profitability entirely, so this drift was invisible twice over."""
    admin.table("part_procurement_tiers").update({"cost_per_unit": 9}).eq(
        "part_id", env.bar_id
    ).execute()

    assert _rollup(admin, env.widget_id, 5) == Decimal("34.0000")  # 16 + 2 x 9
    assert _snapshot(admin, env.job_part_id) == Decimal("24.0000")


def test_a_quantity_edit_re_estimates(admin: Client, env: JobEnv):
    """Cost depends on quantity — setup amortises, procurement tiers move — so
    changing the order re-takes the estimate. Note this is deliberately NOT
    symmetric with price, which updateJobPartQuantity keeps sticky: a price is an
    agreement with the customer, a cost is a measurement of us."""
    admin.table("job_parts").update({"quantity": 10}).eq("id", env.job_part_id).execute()

    # Setup spread over 10 instead of 5: labour 13 instead of 16.
    assert _snapshot(admin, env.job_part_id) == Decimal("21.0000")
    assert _snapshot(admin, env.job_part_id) == _rollup(admin, env.widget_id, 10)


def test_an_unrelated_update_leaves_history_alone(admin: Client, env: JobEnv):
    """Only a quantity change re-estimates. Touching anything else on a shipped
    job must not silently re-price it at today's rates."""
    admin.table("work_centers").update({"labor_rate": 120}).eq(
        "id", env.work_center_id
    ).execute()

    admin.table("job_parts").update({"production_status": "completed"}).eq(
        "id", env.job_part_id
    ).execute()

    assert _snapshot(admin, env.job_part_id) == Decimal("24.0000")


def test_setting_the_same_quantity_is_not_a_change(admin: Client, env: JobEnv):
    """A no-op write is a no-op. Re-saving a form at the same quantity must not
    quietly re-price the job."""
    admin.table("work_centers").update({"labor_rate": 120}).eq(
        "id", env.work_center_id
    ).execute()

    admin.table("job_parts").update({"quantity": 5}).eq("id", env.job_part_id).execute()

    assert _snapshot(admin, env.job_part_id) == Decimal("24.0000")


def test_an_uncostable_part_still_goes_on_a_job(admin: Client, env: JobEnv):
    """A part with an unpriced operation raises out of the rollup by design. That
    must never stop someone creating the job — record "unknown" instead."""
    orphan_wc = (
        admin.table("work_centers")
        .insert(
            {
                "company_id": env.company_id,
                "name": "Unrated",
                "labor_rate": None,
            }
        )
        .execute()
        .data[0]["id"]
    )
    broken_id = (
        admin.table("parts")
        .insert(
            {
                "company_id": env.company_id,
                "part_name": f"BROKEN-{uuid.uuid4().hex[:8]}",
                "source": "made",
                "primary_unit": "ea",
                "costing_batch_quantity": 1,
            }
        )
        .execute()
        .data[0]["id"]
    )
    routing_id = (
        admin.table("routings")
        .insert({"company_id": env.company_id, "part_id": broken_id, "name": "R"})
        .execute()
        .data[0]["id"]
    )
    admin.table("routing_operations").insert(
        {
            "routing_id": routing_id,
            "work_center_id": orphan_wc,
            "sequence": 10,
            "setup_minutes": 0,
            "cycle_minutes_per_unit": 5,
        }
    ).execute()

    # The insert succeeds — that is the assertion.
    row = (
        admin.table("job_parts")
        .insert(
            {
                "job_id": env.job_id,
                "company_id": env.company_id,
                "part_id": broken_id,
                "sequence": 20,
                "quantity": 3,
                "production_status": "not_started",
                "fulfillment_status": "unshipped",
                "unit_price": 10,
                "total_price": 30,
            }
        )
        .execute()
        .data[0]
    )

    assert row["true_cost_per_unit"] is None


def test_operation_rates_are_frozen_beside_the_minutes(admin: Client, env: JobEnv):
    """The routing clone writes the rate the operation will forever be measured
    at, so labour stays itemisable without reading a live work_centers row."""
    routing_id = (
        admin.table("routings")
        .select("id")
        .eq("part_id", env.widget_id)
        .single()
        .execute()
        .data["id"]
    )
    admin.rpc(
        "create_job_part_operations_from_routing",
        {"p_job_part_id": env.job_part_id, "p_routing_id": routing_id},
    ).execute()

    ops = (
        admin.table("job_operations")
        .select(
            "estimated_setup_minutes, estimated_run_minutes_per_unit, "
            "work_center_kind_snapshot, labor_rate_snapshot, external_unit_price_snapshot"
        )
        .eq("job_part_id", env.job_part_id)
        .execute()
        .data
    )

    assert len(ops) == 1
    op = ops[0]
    assert op["work_center_kind_snapshot"] == "internal"
    assert _num(op["labor_rate_snapshot"]) == Decimal("60.00")
    assert op["external_unit_price_snapshot"] is None

    # And it stays put when the work centre is re-rated.
    admin.table("work_centers").update({"labor_rate": 120}).eq(
        "id", env.work_center_id
    ).execute()
    again = (
        admin.table("job_operations")
        .select("labor_rate_snapshot")
        .eq("job_part_id", env.job_part_id)
        .execute()
        .data[0]
    )
    assert _num(again["labor_rate_snapshot"]) == Decimal("60.00")


def test_labour_and_materials_reconcile_to_the_snapshot(admin: Client, env: JobEnv):
    """Materials are not stored per BOM line — costing one line needs the unit
    conversion, the whole-unit ceiling and the made-vs-bought valuation rule, all
    of which live inside part_rollup_at_qty. They come out by subtraction, and
    this is the test that the subtraction is exact."""
    routing_id = (
        admin.table("routings")
        .select("id")
        .eq("part_id", env.widget_id)
        .single()
        .execute()
        .data["id"]
    )
    admin.rpc(
        "create_job_part_operations_from_routing",
        {"p_job_part_id": env.job_part_id, "p_routing_id": routing_id},
    ).execute()

    jp = _job_part(admin, env.job_part_id)
    qty = Decimal(str(jp["quantity"]))
    op = (
        admin.table("job_operations")
        .select(
            "estimated_setup_minutes, estimated_run_minutes_per_unit, labor_rate_snapshot"
        )
        .eq("job_part_id", env.job_part_id)
        .execute()
        .data[0]
    )

    # Minutes x rate BEFORE dividing by 60 — dividing first leaves Decimal with a
    # repeating fraction and 80 comes back as 79.999…, which is an artefact of
    # the test's arithmetic and not of anything under test.
    minutes = Decimal(str(op["estimated_setup_minutes"])) + Decimal(
        str(op["estimated_run_minutes_per_unit"])
    ) * qty
    labour_total = minutes * Decimal(str(op["labor_rate_snapshot"])) / Decimal("60")
    total_cost = Decimal(str(jp["true_cost_per_unit"])) * qty
    materials_total = total_cost - labour_total

    assert total_cost == Decimal("120")  # 5 units x $24
    assert labour_total == Decimal("80")  # (30 + 10x5) min x $60/hr
    # The number that is never stored anywhere, recovered exactly:
    # 5 units x 2 BAR x $4.
    assert materials_total == Decimal("40")


def test_get_part_profitability_runs_and_charges_materials(
    admin: Client, env: JobEnv, monkeypatch
):
    """Calls the REAL function, including its real select string.

    That string is the thing that broke: it named `external_setup_cost` after the
    column was dropped, so every call 400'd from 2026-06-23 until this rewrite,
    silently, because no test ever executed it. It also proves materials now
    reach the cost side at all — profit here is only correct because the $8/unit
    of BAR is charged.
    """
    from services import insights_service

    routing_id = (
        admin.table("routings")
        .select("id")
        .eq("part_id", env.widget_id)
        .single()
        .execute()
        .data["id"]
    )
    admin.rpc(
        "create_job_part_operations_from_routing",
        {"p_job_part_id": env.job_part_id, "p_routing_id": routing_id},
    ).execute()

    monkeypatch.setattr(
        insights_service, "_get_supabase_service_role", lambda: admin
    )

    result = insights_service.get_part_profitability(env.company_id)

    assert result["excluded_job_parts"] == 0
    assert len(result["parts"]) == 1
    part = result["parts"][0]

    # 5 units: revenue 250, cost 5 x 24 = 120, of which 80 labour and 40 material.
    assert part["revenue"] == 250.0
    assert part["cost"] == 120.0
    assert part["labor_cost"] == 80.0
    assert part["material_cost"] == 40.0
    assert part["profit"] == 130.0
    assert part["margin_pct"] == 52.0


def test_an_uncosted_job_part_is_excluded_not_counted_free(
    admin: Client, env: JobEnv, monkeypatch
):
    """"We could not tell" must never render as "it was free" — that inflates
    profit, which is the one direction a shop must not be misled in."""
    from services import insights_service

    admin.table("job_parts").update({"true_cost_per_unit": None}).eq(
        "id", env.job_part_id
    ).execute()

    monkeypatch.setattr(
        insights_service, "_get_supabase_service_role", lambda: admin
    )

    result = insights_service.get_part_profitability(env.company_id)

    assert result["excluded_job_parts"] == 1
    assert result["parts"] == []
