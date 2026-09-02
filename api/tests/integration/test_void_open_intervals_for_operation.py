"""The office can discard a timer it did not start, and only the office can.

THE DEAD END THESE ARE WRITTEN AGAINST. `close_operation_interval` and
`cancel_operation_interval` both assert the caller OWNS the interval — the right
call, because with RLS bypassed an unchecked id would let any member rewrite
anyone's recorded hours. The consequence, unnoticed for twelve days, is that an
interval whose owner has gone home was reachable by nobody at all, while
`get_open_intervals`'s COMMENT called the dashboard list "the only route" to
exactly that row. Reported 2026-08-28 against J-0001: an interval opened at 06:49,
visible from the office, closable by no one.

`void_open_intervals_for_operation` is the narrow exception. These tests pin what
makes it narrow rather than that it works:

  * it crosses ownership — the whole feature;
  * it is ADMIN-gated, so an operator cannot silently wipe a colleague's timing;
  * it VOIDS and never closes, so no finish time is fabricated;
  * it frees the work centre's chain slot, which is a consequence of two partial
    unique indexes carrying `voided_at IS NULL` and is invisible from the app;
  * it refuses a lapsed shop, because SECURITY DEFINER bypasses the RESTRICTIVE
    billing policy and the gate has to be re-stated by hand;
  * it returns a COUNT and never operator identity, which is the surveillance
    guardrail expressed in a signature.

WHY THIS IS A DATABASE TEST. Every one of those is in Postgres. The admin gate is
inside a `SECURITY DEFINER` body, the billing refusal is a `RAISE` the browser
never sees the inputs to, and the chain-slot property is an index predicate. None
of it is observable from the frontend.

The `voided_by` assertion is the one that would otherwise fail silently: this
table's `voided_by` references `user_company_access(id)` while its sibling on
`job_operation_completions` holds an `auth.users` id and carries no FK at all.

Requires a local Supabase with all migrations applied (TEST_SUPABASE_URL /
TEST_SUPABASE_PUBLISHABLE_KEY / TEST_SUPABASE_SECRET_KEY). Skipped without it.
"""
from __future__ import annotations

import os

import pytest
from supabase import create_client

pytestmark = pytest.mark.integration


def _publishable_key() -> str:
    return os.environ.get("TEST_SUPABASE_PUBLISHABLE_KEY") or os.environ["TEST_SUPABASE_ANON_KEY"]


def _add_member(admin, company_id: str, label: str, role: str) -> dict:
    email = f"voi-{label}-{os.urandom(4).hex()}@test.jigged.local"
    password = "test-password-void-open-intervals"
    created = admin.auth.admin.create_user(
        {"email": email, "password": password, "email_confirm": True}
    )
    access = (
        admin.table("user_company_access")
        .insert(
            {
                "user_id": created.user.id,
                "company_id": company_id,
                "role": role,
                "name": label.title(),
            }
        )
        .execute()
    )
    client = create_client(os.environ["TEST_SUPABASE_URL"], _publishable_key())
    client.auth.sign_in_with_password({"email": email, "password": password})
    return {
        "user_id": created.user.id,
        "access_id": access.data[0]["id"],
        "client": client,
    }


@pytest.fixture
def shop(supabase_admin):
    """One writable shop, an operator, an office admin, and two steps at one machine."""
    admin = supabase_admin
    company_id = (
        admin.table("companies")
        .insert({"name": f"voi-{os.urandom(3).hex()}"})
        .execute()
        .data[0]["id"]
    )
    # Demo => company_can_write() is true with no billing row. One test flips this
    # off deliberately; every other test needs writes to succeed for reasons that
    # have nothing to do with billing.
    admin.table("companies").update({"is_demo": True}).eq("id", company_id).execute()

    machinist = _add_member(admin, company_id, "joe", "operator")
    office = _add_member(admin, company_id, "cory", "admin")

    work_center_id = (
        admin.table("work_centers")
        .insert({"company_id": company_id, "name": f"HAAS-{os.urandom(2).hex()}"})
        .execute()
        .data[0]["id"]
    )
    part_id = (
        admin.table("parts")
        .insert(
            {
                "company_id": company_id,
                "part_name": f"JAW-{os.urandom(2).hex()}",
                "primary_unit": "ea",
            }
        )
        .execute()
        .data[0]["id"]
    )
    job_id = (
        admin.table("jobs")
        .insert(
            {
                "company_id": company_id,
                "job_number": f"J-9200-{os.urandom(2).hex()}",
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
                "company_id": company_id,
                "job_id": job_id,
                "part_id": part_id,
                "sequence": 10,
                "quantity": 60,
                "production_status": "not_started",
                "fulfillment_status": "unshipped",
            }
        )
        .execute()
        .data[0]["id"]
    )

    def _operation(sequence: int, name: str) -> str:
        return (
            admin.table("job_operations")
            .insert(
                {
                    "job_id": job_id,
                    "job_part_id": job_part_id,
                    "sequence": sequence,
                    "operation_name": name,
                    "work_center_id": work_center_id,
                }
            )
            .execute()
            .data[0]["id"]
        )

    ctx = {
        "admin": admin,
        "company_id": company_id,
        "machinist": machinist,
        "office": office,
        "work_center_id": work_center_id,
        "op_a": _operation(10, "HAAS ROUGH"),
        "op_b": _operation(20, "HAAS FINISH"),
    }
    yield ctx

    for table in (
        "job_operation_intervals",
        "job_operation_completions",
        "job_parts",
        "jobs",
        "parts",
        "work_centers",
    ):
        try:
            admin.table(table).delete().eq("company_id", company_id).execute()
        except Exception:
            pass
    admin.table("companies").delete().eq("id", company_id).execute()
    for m in (machinist, office):
        try:
            admin.auth.admin.delete_user(m["user_id"])
        except Exception:
            pass


def _start(member: dict, job_operation_id: str) -> str:
    """Start through the real RPC. The browser has no INSERT grant on the table, so
    a direct insert would exercise a path that cannot happen."""
    resp = (
        member["client"]
        .rpc("start_operation_interval", {"p_job_operation_id": job_operation_id})
        .execute()
    )
    return resp.data[0]["interval_id"]


def _void(member: dict, job_operation_id: str):
    return (
        member["client"]
        .rpc("void_open_intervals_for_operation", {"p_job_operation_id": job_operation_id})
        .execute()
    )


def _row(admin, interval_id: str) -> dict:
    return (
        admin.table("job_operation_intervals")
        .select("id, ended_at, close_reason, voided_at, voided_by, operator_id")
        .eq("id", interval_id)
        .single()
        .execute()
        .data
    )


def test_the_office_can_discard_a_timer_it_did_not_start(shop):
    """The whole feature, and the thing every sibling function refuses."""
    interval_id = _start(shop["machinist"], shop["op_a"])

    resp = _void(shop["office"], shop["op_a"])

    assert resp.data == 1, "returns how many were discarded"
    row = _row(shop["admin"], interval_id)
    assert row["voided_at"] is not None
    assert row["operator_id"] == shop["machinist"]["access_id"], (
        "the row still belongs to whoever was on the machine — discarding is not "
        "reassignment"
    )


def test_it_voids_rather_than_closes_so_no_finish_time_is_invented(shop):
    """Nobody in the office knows when the work stopped, and the person who does
    is not here. A stamped end would be read back as a measurement."""
    interval_id = _start(shop["machinist"], shop["op_a"])

    _void(shop["office"], shop["op_a"])

    row = _row(shop["admin"], interval_id)
    assert row["ended_at"] is None, (
        "a discard must not stamp an end — job_op_intervals_close_reason_iff_ended "
        "is satisfied only while both stay NULL"
    )
    assert row["close_reason"] is None


def test_it_records_the_office_actor_as_a_membership_id_not_an_auth_id(shop):
    """The two `voided_by` columns in this family are different KINDS of id.

    `job_operation_completions.voided_by` holds an `auth.users` id and carries no
    FK; this one references `user_company_access(id)`. Writing the wrong kind
    raises 23503 and takes the whole discard down with it.
    """
    _start(shop["machinist"], shop["op_a"])

    _void(shop["office"], shop["op_a"])

    row = (
        shop["admin"]
        .table("job_operation_intervals")
        .select("voided_by")
        .eq("job_operation_id", shop["op_a"])
        .single()
        .execute()
        .data
    )
    assert row["voided_by"] == shop["office"]["access_id"]
    assert row["voided_by"] != shop["office"]["user_id"]


def test_an_operator_cannot_discard_a_colleagues_timing(shop):
    """The gate. Without it this function is a hole straight through the
    ownership assertion that every other write path on this table enforces."""
    interval_id = _start(shop["machinist"], shop["op_a"])
    intruder = _add_member(shop["admin"], shop["company_id"], "mallory", "operator")

    with pytest.raises(Exception) as excinfo:
        _void(intruder, shop["op_a"])
    assert "admin" in str(excinfo.value).lower()

    assert _row(shop["admin"], interval_id)["voided_at"] is None

    shop["admin"].auth.admin.delete_user(intruder["user_id"])


def test_an_operator_cannot_discard_even_their_own_through_this_path(shop):
    """Not an oversight: the operator's path is `cancel_operation_interval`, which
    is owner-gated. Widening this one to "admin OR owner" would make the admin
    gate decorative, since every caller is the owner of something."""
    interval_id = _start(shop["machinist"], shop["op_a"])

    with pytest.raises(Exception):
        _void(shop["machinist"], shop["op_a"])

    assert _row(shop["admin"], interval_id)["voided_at"] is None


def test_discarding_frees_the_work_centre_so_the_next_job_can_start(shop):
    """The property that makes this useful rather than merely tidy, and it is an
    index predicate rather than anything in the function body:
    `job_op_intervals_one_open_per_work_center` carries `voided_at IS NULL`."""
    _start(shop["machinist"], shop["op_a"])

    _void(shop["office"], shop["op_a"])

    # A DIFFERENT operator starting a DIFFERENT step on the same machine. Under a
    # merely-hidden row this raises 23505 on the partial unique index.
    second = _start(shop["office"], shop["op_b"])
    assert second is not None


def test_it_is_a_quiet_no_op_when_nothing_is_running(shop):
    """The common path. The office completes a step nobody was timing, and this
    is called unconditionally on every completion."""
    assert _void(shop["office"], shop["op_a"]).data == 0


def test_it_is_a_quiet_no_op_on_a_step_that_does_not_exist(shop):
    """Idempotent for the same reasons close_/cancel_ are — a retry after a
    dropped response must not be an error."""
    assert _void(shop["office"], "00000000-0000-0000-0000-000000000000").data == 0


def test_it_leaves_a_closed_interval_alone(shop):
    """Scoped to OPEN rows. A sweep that also took closed ones would delete real
    measured work every time the office completed a step."""
    interval_id = _start(shop["machinist"], shop["op_a"])
    shop["machinist"]["client"].rpc(
        "close_operation_interval", {"p_interval_id": interval_id}
    ).execute()

    assert _void(shop["office"], shop["op_a"]).data == 0
    assert _row(shop["admin"], interval_id)["voided_at"] is None


def test_a_lapsed_shop_cannot_discard(shop):
    """SECURITY DEFINER bypasses the RESTRICTIVE billing policy, so the gate is
    re-stated by hand in the body. If that call is ever hoisted into a helper,
    `definer_writers_missing_write_gate()` goes red on the string match — but
    only this asserts the behaviour."""
    interval_id = _start(shop["machinist"], shop["op_a"])
    shop["admin"].table("companies").update({"is_demo": False}).eq(
        "id", shop["company_id"]
    ).execute()

    with pytest.raises(Exception) as excinfo:
        _void(shop["office"], shop["op_a"])
    assert "subscription" in str(excinfo.value).lower()

    assert _row(shop["admin"], interval_id)["voided_at"] is None


def test_it_returns_a_count_and_never_operator_identity(shop):
    """The surveillance guardrail expressed in a signature. The office is given
    what it needs to act — "something stopped" — and nothing that resolves the
    machine to a person. See
    docs/modules/operator-view.md#surveillance-guardrail-non-negotiable.
    """
    _start(shop["machinist"], shop["op_a"])

    resp = _void(shop["office"], shop["op_a"])

    assert isinstance(resp.data, int)
    # And the office still cannot read the row it just voided: there is no admin
    # SELECT policy on this table, and this change did not add one.
    visible = (
        shop["office"]["client"]
        .table("job_operation_intervals")
        .select("id, operator_id")
        .eq("job_operation_id", shop["op_a"])
        .execute()
    )
    assert visible.data == []
