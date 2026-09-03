"""The two silent-data-loss hazards the vendor_services split had to close.

Both are the same shape: a function inferring "is this outside work?" from a
join, and that join no longer resolving after `work_centers.kind` was dropped.
Neither fails loudly — one loses a send stamp, the other drops a whole
operation — so neither would be caught by anything except a test that
reproduces it.

  * HAZARD 1. `compute_job_operation_status` early-returns an outside op's
    stored status. Reading `kind` through a dead join, the guard stops firing,
    the completion-quantity path takes over with v_good = 0, and every
    sent/received op resets to 'pending' on the next part-quantity edit. The
    trigger runs over EVERY op on the part, so one edit loses every send stamp
    on it. You find out when the plater calls.

  * HAZARD 2. `create_job_part_operations_from_routing` INNER JOINed
    work_centers. The moment `routing_operations.work_center_id` became
    nullable, every outside step was silently dropped at job creation: no
    error, no traveler step, v_seq renumbering the survivors, and the part
    reading complete when it was never sent out.

The third test covers the inheritance the split introduced, on the axis the
2026-08-19 incident was about: the list and detail priceability verdicts are
separate implementations of one rule, and an inherited outside price is exactly
the case a drifted predicate would miss.

If any of these fails, production data is being destroyed silently. Do not
relax the assertion.

Run:
    cd api && pytest -m integration tests/integration/test_vendor_services_split_hazards.py

Requires TEST_SUPABASE_URL + TEST_SUPABASE_SECRET_KEY (service role) — run
`supabase start` then `eval "$(supabase status -o env)"` and export them.
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

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
class OutsideEnv:
    """One made part routed through a station and then an outside service.

    The outside step sets NO price of its own, so everything downstream has to
    reach the service's $4.50 by inheritance — which is the path that would
    silently read as "never priced" if the COALESCE were missing anywhere.
    """

    company_id: str
    part_id: str
    routing_id: str
    service_id: str
    station_id: str


@pytest.fixture
def env(admin: Client):
    suffix = uuid.uuid4().hex[:8]

    company_id = (
        admin.table("companies").insert({"name": f"Hazard-{suffix}"}).execute().data[0]["id"]
    )

    vendor_id = (
        admin.table("vendors")
        .insert({"company_id": company_id, "name": f"Hazard Coatings {suffix}"})
        .execute()
        .data[0]["id"]
    )

    service_id = (
        admin.table("vendor_services")
        .insert(
            {
                "company_id": company_id,
                "vendor_id": vendor_id,
                "name": "Anodize",
                "unit_price": 4.5,
            }
        )
        .execute()
        .data[0]["id"]
    )

    station_id = (
        admin.table("work_centers")
        .insert({"company_id": company_id, "name": "Hazard Mill", "labor_rate": 60})
        .execute()
        .data[0]["id"]
    )

    part_id = (
        admin.table("parts")
        .insert(
            {
                "company_id": company_id,
                "part_name": f"HAZARD-{suffix}",
                "source": "made",
                "primary_unit": "ea",
            }
        )
        .execute()
        .data[0]["id"]
    )

    routing_id = (
        admin.table("routings")
        .insert({"company_id": company_id, "part_id": part_id, "name": f"Hazard-{suffix}"})
        .execute()
        .data[0]["id"]
    )

    admin.table("routing_operations").insert(
        [
            {
                "routing_id": routing_id,
                "work_center_id": station_id,
                "sequence": 10,
                "setup_minutes": 30,
                "cycle_minutes_per_unit": 10,
            },
            {
                "routing_id": routing_id,
                "vendor_service_id": service_id,
                "sequence": 20,
                # No override — the step INHERITS the service's price.
            },
        ]
    ).execute()

    yield OutsideEnv(
        company_id=company_id,
        part_id=part_id,
        routing_id=routing_id,
        service_id=service_id,
        station_id=station_id,
    )

    admin.table("companies").delete().eq("id", company_id).execute()


def _make_job_part(admin: Client, env: OutsideEnv, quantity: int = 10) -> str:
    suffix = uuid.uuid4().hex[:6]
    job_id = (
        admin.table("jobs")
        .insert(
            {
                "company_id": env.company_id,
                "job_number": f"HZ-{suffix}",
                "production_status": "not_started",
                "fulfillment_status": "unshipped",
            }
        )
        .execute()
        .data[0]["id"]
    )

    job_part_id = (
        admin.table("job_parts")
        .insert(
            {
                "company_id": env.company_id,
                "job_id": job_id,
                "part_id": env.part_id,
                "quantity": quantity,
                "sequence": 1,
                "production_status": "not_started",
                "fulfillment_status": "unshipped",
            }
        )
        .execute()
        .data[0]["id"]
    )

    admin.rpc(
        "create_job_part_operations_from_routing",
        {"p_job_part_id": job_part_id, "p_routing_id": env.routing_id},
    ).execute()

    return job_part_id


def test_job_creation_does_not_drop_the_outside_step(admin: Client, env: OutsideEnv):
    """HAZARD 2. Both steps must be cloned, and the outside one named for the SERVICE."""
    job_part_id = _make_job_part(admin, env)

    ops = (
        admin.table("job_operations")
        .select("id, operation_name, vendor_service_id, external_unit_price_snapshot")
        .eq("job_part_id", job_part_id)
        .execute()
        .data
    )

    assert len(ops) == 2, "the outside step was dropped at job creation"

    outside = [o for o in ops if o["vendor_service_id"] is not None]
    assert len(outside) == 1

    # The SERVICE's name, so the traveler reads "Anodize" rather than the
    # plater's legal name — the defect that motivated the whole split.
    assert outside[0]["operation_name"] == "Anodize"

    # The EFFECTIVE price. The step set no override, so a snapshot of NULL here
    # would later read as "never priced" and exclude the job_part from
    # profitability rather than costing it.
    assert float(outside[0]["external_unit_price_snapshot"]) == 4.5


def test_a_quantity_edit_does_not_reset_a_sent_op(admin: Client, env: OutsideEnv):
    """HAZARD 1. A part-quantity edit must leave a sent op's status and stamp alone.

    Since 20260903203741 the send IS a row in `outside_shipments`, so this test
    creates one instead of writing `status='sent'` onto the operation (which the
    browser can no longer do at all, and which would now be re-derived away).

    The assertion is unchanged, and the reason it holds is stronger than it was.
    The hazard used to be held off by an explicit early return that a dead join
    could stop firing. Now the outside arm of compute_job_operation_status reads
    outside_shipments and outside_shipment_receipts, and a part-quantity edit
    writes NEITHER -- so it cannot reach the send even in principle. sent_at
    survives for the same reason: it is a mirror of the shipment row rather than
    the record itself.
    """
    job_part_id = _make_job_part(admin, env)

    op = (
        admin.table("job_operations")
        .select("id, job_id, job_part_id")
        .eq("job_part_id", job_part_id)
        .not_.is_("vendor_service_id", "null")
        .single()
        .execute()
        .data
    )

    service = (
        admin.table("vendor_services")
        .select("vendor_id, name, vendors(name)")
        .eq("id", env.service_id)
        .single()
        .execute()
        .data
    )

    # Service role, so this goes straight at the table. The RPC is the browser's
    # only door and is covered by the route tests; what is under test here is the
    # recompute, and a shipment row is what drives it.
    shipped_at = "2026-08-01T00:00:00Z"
    admin.table("outside_shipments").insert(
        {
            "company_id": env.company_id,
            "job_id": op["job_id"],
            "job_part_id": op["job_part_id"],
            "job_operation_id": op["id"],
            "vendor_id": service["vendor_id"],
            "vendor_name": service["vendors"]["name"],
            "service_name": service["name"],
            "slip_number": f"OSP-HAZARD-{uuid.uuid4().hex[:6]}",
            "quantity": 10,
            "shipped_at": shipped_at,
        }
    ).execute()

    def read() -> dict:
        return (
            admin.table("job_operations")
            .select("status, sent_at")
            .eq("id", op["id"])
            .single()
            .execute()
            .data
        )

    before = read()
    assert before["status"] == "sent", "creating a shipment did not send the operation"
    assert before["sent_at"] is not None, "creating a shipment did not stamp sent_at"

    # The trigger path that used to wipe it.
    admin.table("job_parts").update({"quantity": 25}).eq("id", job_part_id).execute()

    after = read()
    assert after["status"] == "sent", "a part-quantity edit reset the outside op to pending"
    assert after["sent_at"] is not None, "a part-quantity edit cleared the send stamp"
    assert after["sent_at"] == before["sent_at"], "a part-quantity edit moved the send stamp"


def test_both_priceability_verdicts_agree_on_an_inherited_price(admin: Client, env: OutsideEnv):
    """The list and the detail must agree when the only outside price is inherited."""
    admin.table("part_pricing_tiers").insert(
        {
            "company_id": env.company_id,
            "part_id": env.part_id,
            "sequence": 1,
            "quantity": 1,
            "markup_percent": 30,
        }
    ).execute()

    listed = (
        admin.rpc("get_priceable_part_ids", {"p_company_id": env.company_id}).execute().data
        or []
    )
    detail = (
        admin.rpc("compute_part_cost_explain", {"p_part_id": env.part_id, "p_qty": 10})
        .execute()
        .data[0]
    )

    assert (env.part_id in listed) == detail["is_priceable"], (
        "the list and detail priceability verdicts disagree on an inherited outside price"
    )
    assert detail["is_priceable"] is True

    # And the inherited price actually reaches the money: labour is
    # (30/10 + 10) x 60/60 = $13.00, plus the service's $4.50.
    cost = admin.rpc(
        "compute_part_cost_at_qty", {"p_part_id": env.part_id, "p_qty": 10}
    ).execute().data
    assert float(cost) == pytest.approx(17.5)
