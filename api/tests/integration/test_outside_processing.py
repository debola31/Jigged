"""Outside processing: shipping & receiving.

An outside operation used to carry its lifecycle as four columns on
`job_operations` -- sent_at/sent_by, completed_at/completed_by -- flipped by a
button. Since 20260903203741 the SEND is a row in `outside_shipments` and the
RETURN is a row in `outside_shipment_receipts`, and the operation's status is
DERIVED from them. Three things that used to be conventions are now enforced,
and each one is a test here because none of them fails loudly on its own:

  * A quantity drives the status. `compute_job_operation_status` no longer
    exempts an outside op, and the 100-out/98-back case has to land on
    `in_progress` rather than silently completing a step two pieces short.

  * The void order is load-bearing. Voiding a shipment must void its receipts
    FIRST, as two top-level statements. From a trigger instead, the
    op -> part -> job cascade reaches pg_trigger_depth() 3 and
    sync_job_production_status_from_parts() bails at `> 2`: the job status
    freezes, silently, with nothing in the logs.

  * The browser has exactly one door. There is no INSERT grant on
    outside_shipments and a trigger refuses a hand-written status, so paperwork
    and status cannot drift apart.

Run:
    cd api && pytest -m integration tests/integration/test_outside_processing.py

Requires TEST_SUPABASE_URL + TEST_SUPABASE_SECRET_KEY (service role) and
TEST_SUPABASE_PUBLISHABLE_KEY -- `supabase start` then
`eval "$(supabase status -o env)"`.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass

import pytest
from postgrest.exceptions import APIError
from supabase import Client


pytestmark = pytest.mark.integration


@dataclass
class OutsideJob:
    """One job_part routed station -> outside service, in seeded_user_a's company."""

    company_id: str
    job_id: str
    job_part_id: str
    op_id: str            # the outside operation
    station_op_id: str    # the in-house one before it
    vendor_id: str
    service_id: str
    quantity: int


@pytest.fixture
def outside(supabase_admin: Client, seeded_user_a: dict) -> OutsideJob:
    """Built with the service role so the test body can act as the browser.

    The fixture company starts with NO company_billing row, which
    company_can_write() reads as "not paid up" -- and create_outside_shipment
    checks that BY HAND because SECURITY DEFINER bypasses the restrictive RLS
    policy that would otherwise enforce it. So the gate has to be opened here or
    every send in this file 42501s. Removed again on teardown: the fixture
    company is session-scoped and shared, and a billing row left behind would
    silently satisfy the gate for someone else's test.
    """
    admin = supabase_admin
    company_id = seeded_user_a["company_id"]
    sfx = uuid.uuid4().hex[:8]

    admin.table("company_billing").upsert(
        {"company_id": company_id, "billing_exempt": True}, on_conflict="company_id"
    ).execute()

    vendor_id = (
        admin.table("vendors")
        .insert({"company_id": company_id, "name": f"OSP Plater {sfx}"})
        .execute().data[0]["id"]
    )
    admin.table("vendor_addresses").insert(
        {
            "vendor_id": vendor_id, "address_line1": "1 Anodize Way",
            "city": "Warren", "state": "MI", "postal_code": "48089",
            "is_default": True,
        }
    ).execute()
    admin.table("vendor_contacts").insert(
        {"vendor_id": vendor_id, "name": "Receiving Dock",
         "role": "shipping_receiving", "is_primary": True}
    ).execute()

    service_id = (
        admin.table("vendor_services")
        .insert({"company_id": company_id, "vendor_id": vendor_id,
                 "name": "Anodize", "unit_price": 3.5})
        .execute().data[0]["id"]
    )
    station_id = (
        admin.table("work_centers")
        .insert({"company_id": company_id, "name": f"OSP Mill {sfx}", "labor_rate": 60})
        .execute().data[0]["id"]
    )
    part_id = (
        admin.table("parts")
        .insert({"company_id": company_id, "part_name": f"OSP-{sfx}",
                 "source": "made", "primary_unit": "ea"})
        .execute().data[0]["id"]
    )
    routing_id = (
        admin.table("routings")
        .insert({"company_id": company_id, "part_id": part_id, "name": f"OSP-{sfx}"})
        .execute().data[0]["id"]
    )
    admin.table("routing_operations").insert(
        [
            {"routing_id": routing_id, "work_center_id": station_id,
             "sequence": 10, "setup_minutes": 15, "cycle_minutes_per_unit": 2},
            {"routing_id": routing_id, "vendor_service_id": service_id, "sequence": 20},
        ]
    ).execute()

    job_id = (
        admin.table("jobs")
        .insert({"company_id": company_id, "job_number": f"J-{sfx[:4]}",
                 "production_status": "not_started", "fulfillment_status": "unshipped"})
        .execute().data[0]["id"]
    )
    job_part_id = (
        admin.table("job_parts")
        .insert({"company_id": company_id, "job_id": job_id, "part_id": part_id,
                 "quantity": 100, "sequence": 1,
                 "production_status": "not_started", "fulfillment_status": "unshipped"})
        .execute().data[0]["id"]
    )
    admin.rpc("create_job_part_operations_from_routing",
              {"p_job_part_id": job_part_id, "p_routing_id": routing_id}).execute()

    ops = (
        admin.table("job_operations")
        .select("id, vendor_service_id, sequence")
        .eq("job_part_id", job_part_id).order("sequence").execute().data
    )
    assert len(ops) == 2, "the outside step was dropped at job creation"

    yield OutsideJob(
        company_id=company_id, job_id=job_id, job_part_id=job_part_id,
        op_id=next(o["id"] for o in ops if o["vendor_service_id"]),
        station_op_id=next(o["id"] for o in ops if not o["vendor_service_id"]),
        vendor_id=vendor_id, service_id=service_id, quantity=100,
    )

    admin.table("jobs").delete().eq("id", job_id).execute()
    admin.table("company_billing").delete().eq("company_id", company_id).execute()


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def _op(admin: Client, op_id: str) -> dict:
    return (
        admin.table("job_operations")
        .select("status, sent_at, sent_by, completed_at, completed_by")
        .eq("id", op_id).single().execute().data
    )


def _send(user: dict, op_id: str, qty: float, **kw) -> dict:
    """The browser's only door. Returns {shipment_id, slip_number}."""
    args = {"p_job_operation_id": op_id, "p_quantity": qty, **kw}
    rows = user["client"].rpc("create_outside_shipment", args).execute().data
    return rows[0] if isinstance(rows, list) else rows


def _receive(user: dict, ship: dict, admin: Client, good: float, scrapped: float = 0) -> None:
    """Receiving is a plain insert -- deliberately not an RPC."""
    row = (
        admin.table("outside_shipments")
        .select("company_id, id, job_operation_id, job_part_id")
        .eq("id", ship["shipment_id"]).single().execute().data
    )
    user["client"].table("outside_shipment_receipts").insert(
        {
            "company_id": row["company_id"],
            "outside_shipment_id": row["id"],
            "job_operation_id": row["job_operation_id"],
            "job_part_id": row["job_part_id"],
            "quantity_good": good,
            "quantity_scrapped": scrapped,
            # Set explicitly, exactly as the access layer does for
            # job_operation_completions.completed_by. There is deliberately no
            # DEFAULT auth.uid() on the column: the two receipt-shaped tables
            # would then disagree about who is responsible for attribution.
            "received_by": user["user_id"],
        }
    ).execute()


# --------------------------------------------------------------------------
# the derivation
# --------------------------------------------------------------------------

def test_the_status_walks_the_send_and_receive_quantities(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    """pending -> sent -> in_progress -> sent -> in_progress, on quantities alone.

    The middle `in_progress` is the one worth reading twice: 50 went out and 50
    came back, so NOTHING is at the vendor -- but 50 pieces have never been
    through the process, so the step is not done either. Reading that as `sent`
    would leave a phantom on the At-vendor list forever.
    """
    admin = supabase_admin
    assert _op(admin, outside.op_id)["status"] == "pending"

    s1 = _send(seeded_user_a, outside.op_id, 50)
    assert _op(admin, outside.op_id)["status"] == "sent"

    _receive(seeded_user_a, s1, admin, good=50)
    assert _op(admin, outside.op_id)["status"] == "in_progress"

    s2 = _send(seeded_user_a, outside.op_id, 50)
    assert _op(admin, outside.op_id)["status"] == "sent"

    _receive(seeded_user_a, s2, admin, good=50)
    after = _op(admin, outside.op_id)
    assert after["status"] == "completed"
    assert after["completed_at"] is not None
    # The receipt's actor, not a completions row -- an outside op has none, and
    # reading it from there is how completed_by silently went NULL.
    assert after["completed_by"] == seeded_user_a["user_id"]


def test_a_short_return_reads_in_progress_rather_than_completing_two_pieces_light(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    """100 out, 98 good + 2 scrapped at the vendor.

    Outstanding is zero, so nothing is at the plater and the op must not read
    `sent`. But 98 < 100, so it must not read `completed` either -- exactly what
    an in-house op says at 98 good of 100. Dropping the order to 98 is the shop
    deciding to ship short, and the existing part-quantity trigger closes it.
    """
    admin = supabase_admin
    s1 = _send(seeded_user_a, outside.op_id, 100)
    _receive(seeded_user_a, s1, admin, good=98, scrapped=2)

    assert _op(admin, outside.op_id)["status"] == "in_progress"

    admin.table("job_parts").update({"quantity": 98}).eq("id", outside.job_part_id).execute()
    assert _op(admin, outside.op_id)["status"] == "completed"


def test_pieces_the_vendor_never_returns_keep_the_op_at_the_vendor(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    """98 back with NO scrap recorded means 2 are still on someone's rack.

    This is the counterpart to the test above and the reason quantity_scrapped
    is a separate column: booking a piece as scrapped is a decision a person
    takes, and until they take it the shop is still owed the part.
    """
    admin = supabase_admin
    s1 = _send(seeded_user_a, outside.op_id, 100)
    _receive(seeded_user_a, s1, admin, good=98, scrapped=0)

    assert _op(admin, outside.op_id)["status"] == "sent"


def test_a_quantity_edit_cannot_reach_the_send(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    """The 20260823163931 hazard, now closed by construction rather than a guard.

    recompute_job_ops_status_from_part_qty() runs the status function over every
    op on the part. The outside arm reads shipments and receipts, and a quantity
    edit writes neither -- so it cannot lose the send even in principle.
    """
    admin = supabase_admin
    _send(seeded_user_a, outside.op_id, 40)
    before = _op(admin, outside.op_id)

    admin.table("job_parts").update({"quantity": 250}).eq("id", outside.job_part_id).execute()

    after = _op(admin, outside.op_id)
    assert after["status"] == "sent"
    assert after["sent_at"] == before["sent_at"]
    assert after["sent_by"] == before["sent_by"]


# --------------------------------------------------------------------------
# the void, and its ordering
# --------------------------------------------------------------------------

def test_voiding_a_shipment_that_has_a_receipt_reaches_the_job(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    """THE TRIGGER-DEPTH TRAP.

    void_outside_shipment voids receipts and shipment as two TOP-LEVEL
    statements, so each fires its triggers at depth 1 and the part -> job sync
    lands at 2. Move that cascade into a trigger on outside_shipments and the
    job rollup arrives at depth 3, where sync_job_production_status_from_parts()
    bails -- the op and part would still look right here while the JOB silently
    froze. Asserting the job is the whole point of this test.
    """
    admin = supabase_admin
    # Finish the in-house step first so the job is unambiguously in progress.
    s1 = _send(seeded_user_a, outside.op_id, 100)
    _receive(seeded_user_a, s1, admin, good=100)

    assert _op(admin, outside.op_id)["status"] == "completed"
    job_before = admin.table("jobs").select("production_status").eq(
        "id", outside.job_id).single().execute().data["production_status"]

    seeded_user_a["client"].rpc(
        "void_outside_shipment", {"p_shipment_id": s1["shipment_id"]}).execute()

    after = _op(admin, outside.op_id)
    assert after["status"] == "pending", "voiding the only shipment did not un-send the op"
    assert after["sent_at"] is None, "voiding every shipment left the send stamp behind"
    assert after["completed_at"] is None

    part = admin.table("job_parts").select("production_status").eq(
        "id", outside.job_part_id).single().execute().data["production_status"]
    job = admin.table("jobs").select("production_status").eq(
        "id", outside.job_id).single().execute().data["production_status"]
    assert part == "not_started"
    # The job followed the part. If this reads the pre-void value while `part`
    # is correct, the cascade was suppressed at trigger depth 3.
    assert job == "not_started", f"job status froze at {job_before!r} -- cascade suppressed"

    receipts = admin.table("outside_shipment_receipts").select("voided_at").eq(
        "outside_shipment_id", s1["shipment_id"]).execute().data
    assert all(r["voided_at"] is not None for r in receipts), "receipts outlived their shipment"


def test_voiding_is_idempotent(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    s1 = _send(seeded_user_a, outside.op_id, 10)
    first = seeded_user_a["client"].rpc(
        "void_outside_shipment", {"p_shipment_id": s1["shipment_id"]}).execute().data
    second = seeded_user_a["client"].rpc(
        "void_outside_shipment", {"p_shipment_id": s1["shipment_id"]}).execute().data
    assert first == 0 and second == 0     # no live receipts either time
    assert _op(supabase_admin, outside.op_id)["status"] == "pending"


# --------------------------------------------------------------------------
# slip numbers
# --------------------------------------------------------------------------

def test_a_voided_slip_number_is_never_reissued(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    """The counter runs over ALL rows including voided ones.

    The plater is holding a piece of paper reading OSP-xxxx-1. Handing that
    number to a different box is how two shipments become one in a phone call.
    """
    s1 = _send(seeded_user_a, outside.op_id, 10)
    seeded_user_a["client"].rpc(
        "void_outside_shipment", {"p_shipment_id": s1["shipment_id"]}).execute()
    s2 = _send(seeded_user_a, outside.op_id, 10)

    assert s1["slip_number"].endswith("-1")
    assert s2["slip_number"].endswith("-2")
    assert s1["slip_number"] != s2["slip_number"]


def test_the_slip_carries_the_job_base_and_freezes_the_vendor_block(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    """OSP-{jobBase}-{n}, and a ship-to snapshot that a later edit cannot rewrite."""
    admin = supabase_admin
    job_number = admin.table("jobs").select("job_number").eq(
        "id", outside.job_id).single().execute().data["job_number"]
    base = job_number.split("-", 1)[1]

    s1 = _send(seeded_user_a, outside.op_id, 10)
    assert s1["slip_number"] == f"OSP-{base}-1"

    row = admin.table("outside_shipments").select(
        "vendor_name, service_name, ship_to_address, ship_to_contact"
    ).eq("id", s1["shipment_id"]).single().execute().data

    assert row["service_name"] == "Anodize", "the slip named the vendor where it should name the process"
    assert row["ship_to_address"]["city"] == "Warren"
    assert row["ship_to_contact"]["name"] == "Receiving Dock"

    # Rename the vendor: the document must not move.
    admin.table("vendors").update({"name": "Renamed Plater"}).eq(
        "id", outside.vendor_id).execute()
    frozen = admin.table("outside_shipments").select("vendor_name").eq(
        "id", s1["shipment_id"]).single().execute().data["vendor_name"]
    assert frozen != "Renamed Plater", "the ship-to snapshot followed a live vendor rename"


# --------------------------------------------------------------------------
# the one door
# --------------------------------------------------------------------------

def test_the_browser_cannot_hand_write_an_outside_op_state(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    """Decision #2 as a database fact, not a code convention."""
    with pytest.raises(APIError) as exc:
        seeded_user_a["client"].table("job_operations").update(
            {"status": "sent"}).eq("id", outside.op_id).execute()
    assert "derived" in str(exc.value).lower()

    assert _op(supabase_admin, outside.op_id)["status"] == "pending"


def test_the_browser_can_still_edit_an_unrelated_column_on_the_same_row(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    """The guard is narrow on purpose: it names five columns, not the row."""
    seeded_user_a["client"].table("job_operations").update(
        {"notes": "call before shipping"}).eq("id", outside.op_id).execute()
    assert supabase_admin.table("job_operations").select("notes").eq(
        "id", outside.op_id).single().execute().data["notes"] == "call before shipping"


def test_the_browser_cannot_insert_a_shipment_directly(
    seeded_user_a: dict, outside: OutsideJob
):
    """No INSERT grant: the RPC is the only way to mint a slip number."""
    with pytest.raises(APIError):
        seeded_user_a["client"].table("outside_shipments").insert(
            {
                "company_id": outside.company_id, "job_id": outside.job_id,
                "job_part_id": outside.job_part_id, "job_operation_id": outside.op_id,
                "vendor_id": outside.vendor_id, "vendor_name": "x",
                "service_name": "y", "slip_number": "OSP-FAKE-1", "quantity": 5,
            }
        ).execute()


def test_an_in_house_operation_cannot_be_shipped_out(
    seeded_user_a: dict, outside: OutsideJob
):
    with pytest.raises(APIError) as exc:
        _send(seeded_user_a, outside.station_op_id, 10)
    assert "in-house" in str(exc.value).lower()


def test_the_rpc_refuses_a_zero_quantity_and_a_backwards_due_date(
    seeded_user_a: dict, outside: OutsideJob
):
    with pytest.raises(APIError):
        _send(seeded_user_a, outside.op_id, 0)
    with pytest.raises(APIError) as exc:
        _send(seeded_user_a, outside.op_id, 5,
              p_shipped_at="2026-09-10T00:00:00Z", p_due_back_on="2026-09-01")
    assert "due-back" in str(exc.value).lower()


def test_a_receipt_cannot_be_attached_to_another_operations_shipment(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    """The composite FK, doing what a denormalized column comment cannot.

    outside_shipment_id, company_id, job_operation_id and job_part_id are
    checked as ONE key, so a receipt whose ids disagree with its shipment is
    unrepresentable rather than a rule three future queries have to remember.
    """
    admin = supabase_admin
    s1 = _send(seeded_user_a, outside.op_id, 10)
    row = admin.table("outside_shipments").select(
        "company_id, id, job_part_id").eq("id", s1["shipment_id"]).single().execute().data

    with pytest.raises(APIError):
        seeded_user_a["client"].table("outside_shipment_receipts").insert(
            {
                "company_id": row["company_id"],
                "outside_shipment_id": row["id"],
                "job_operation_id": outside.station_op_id,   # the WRONG operation
                "job_part_id": row["job_part_id"],
                "quantity_good": 10,
            }
        ).execute()


def test_an_empty_receipt_is_refused(
    supabase_admin: Client, seeded_user_a: dict, outside: OutsideJob
):
    s1 = _send(seeded_user_a, outside.op_id, 10)
    with pytest.raises(APIError):
        _receive(seeded_user_a, s1, supabase_admin, good=0, scrapped=0)


# --------------------------------------------------------------------------
# tenancy
# --------------------------------------------------------------------------

def test_another_tenant_sees_no_shipments_and_cannot_send(
    supabase_admin: Client, seeded_user_a: dict, seeded_user_b: dict, outside: OutsideJob
):
    s1 = _send(seeded_user_a, outside.op_id, 10)

    visible = seeded_user_b["client"].table("outside_shipments").select("id").eq(
        "id", s1["shipment_id"]).execute().data
    assert visible == [], "a shipment leaked across tenants"

    with pytest.raises(APIError) as exc:
        _send(seeded_user_b, outside.op_id, 10)
    assert "access" in str(exc.value).lower()

    with pytest.raises(APIError):
        seeded_user_b["client"].rpc(
            "void_outside_shipment", {"p_shipment_id": s1["shipment_id"]}).execute()
