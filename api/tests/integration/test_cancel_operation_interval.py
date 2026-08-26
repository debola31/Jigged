"""An operator can discard a running timer, and only their own.

THE DEAD END THESE ARE WRITTEN AGAINST. Before `cancel_operation_interval`, an
operator who started a step and produced nothing could not stop the clock:
`close_operation_interval` refuses a non-owner, and the owner's only close path
runs through `createOperationCompletion`, floored at `quantity_good > 0`. The
workaround was already in use — the E2E suite's `stopTimer()` records a completion
and then voids it, on purpose, and production held two 21-second and 8-second
intervals on J-0013 EDM created and voided by hand for exactly that reason.

WHY THIS IS A DATABASE TEST. Every guarantee is in Postgres. The ownership
assertion is inside a `SECURITY DEFINER` function; the billing refusal is a
`RAISE` the browser never sees the inputs to; and the property that makes the
feature work at all — that voiding FREES THE WORK CENTRE'S CHAIN SLOT — is a
consequence of two partial unique indexes carrying `voided_at IS NULL` in their
predicates. None of that is observable from the frontend.

The `voided_by` assertion is the one that would otherwise fail silently: this
table's `voided_by` references `user_company_access(id)` while its sibling on
`job_operation_completions` holds an `auth.users` id and carries no FK at all.
Writing the wrong kind is a `23503`, and copying the wrong-but-valid id would be
worse — a row attributed to a different person.

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


def _add_member(admin, company_id: str, label: str, role: str = "operator") -> dict:
    """A company member with their own signed-in, anon-key client.

    `operator`, not `admin`: cancelling your own timing is the weakest thing an
    operator must be able to do, and a version that only worked for admins would
    miss the entire point.
    """
    email = f"coi-{label}-{os.urandom(4).hex()}@test.jigged.local"
    password = "test-password-cancel-interval"
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
    """One writable shop, two operators, and a part with two steps at one machine."""
    admin = supabase_admin
    company_id = (
        admin.table("companies")
        .insert({"name": f"coi-{os.urandom(3).hex()}"})
        .execute()
        .data[0]["id"]
    )
    # Demo => company_can_write() is true with no billing row. One test flips this
    # off deliberately; every other test needs writes to succeed for reasons that
    # have nothing to do with billing.
    admin.table("companies").update({"is_demo": True}).eq("id", company_id).execute()

    owner = _add_member(admin, company_id, "kurtis")
    mate = _add_member(admin, company_id, "dana")

    work_center_id = (
        admin.table("work_centers")
        .insert({"company_id": company_id, "name": f"EDM-{os.urandom(2).hex()}"})
        .execute()
        .data[0]["id"]
    )
    part_id = (
        admin.table("parts")
        .insert(
            {
                "company_id": company_id,
                "part_name": f"SKYLINE-{os.urandom(2).hex()}",
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
                "job_number": f"J-9100-{os.urandom(2).hex()}",
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

    # Two steps at the SAME work centre, so the chain-slot test has somewhere to
    # start next without inventing a second machine.
    ctx = {
        "admin": admin,
        "company_id": company_id,
        "owner": owner,
        "mate": mate,
        "work_center_id": work_center_id,
        "op_a": _operation(10, "EDM ROUGH"),
        "op_b": _operation(20, "EDM FINISH"),
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
    for m in (owner, mate):
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


def _cancel(member: dict, interval_id: str):
    return (
        member["client"]
        .rpc("cancel_operation_interval", {"p_interval_id": interval_id})
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


def test_the_owner_can_discard_a_timer_that_produced_nothing(shop):
    """The whole point. No completion, no quantity, no fabricated end."""
    interval_id = _start(shop["owner"], shop["op_a"])

    _cancel(shop["owner"], interval_id)

    row = _row(shop["admin"], interval_id)
    assert row["voided_at"] is not None
    assert row["ended_at"] is None, (
        "a cancel must not stamp an end — we do not know when the work stopped, and "
        "job_op_intervals_close_reason_iff_ended is satisfied only while both are NULL"
    )
    assert row["close_reason"] is None

    # And no completion was invented to get here — which is the workaround this
    # button exists to delete.
    completions = (
        shop["admin"]
        .table("job_operation_completions")
        .select("id")
        .eq("job_operation_id", shop["op_a"])
        .execute()
        .data
    )
    assert completions == []


def test_voided_by_is_an_access_id_not_an_auth_id(shop):
    """The id-kind trap. `job_operation_intervals.voided_by` references
    `user_company_access(id)`; the same-named column on `job_operation_completions`
    holds an `auth.users` id and has no FK. A wrong-kind write is a 23503; a
    valid-but-wrong-kind write would attribute the void to someone else."""
    interval_id = _start(shop["owner"], shop["op_a"])
    _cancel(shop["owner"], interval_id)

    row = _row(shop["admin"], interval_id)
    assert row["voided_by"] == shop["owner"]["access_id"]
    assert row["voided_by"] == row["operator_id"], (
        "the canceller is the owner here, so the two ids must agree — if they do "
        "not, one of them is the wrong kind"
    )
    assert row["voided_by"] != shop["owner"]["user_id"]


def test_the_work_centre_is_free_immediately_afterwards(shop):
    """The property that makes this useful rather than cosmetic.

    Both partial unique indexes carry `voided_at IS NULL`, so a void clears the
    chain slot without an end time. If it did not, the machine would stay blocked
    and the operator would be no better off than before.
    """
    first = _start(shop["owner"], shop["op_a"])
    _cancel(shop["owner"], first)

    # Same work centre, different step, different person — the shift handoff.
    second = _start(shop["mate"], shop["op_b"])
    assert second != first

    row = _row(shop["admin"], second)
    assert row["ended_at"] is None and row["voided_at"] is None


def test_a_non_owner_is_refused(shop):
    """Same assertion `close_operation_interval` makes, and for the same reason:
    with RLS bypassed, an unchecked id would let any member destroy anyone's
    recorded hours."""
    interval_id = _start(shop["owner"], shop["op_a"])

    with pytest.raises(Exception) as exc:
        _cancel(shop["mate"], interval_id)
    assert "only cancel an activity you started" in str(exc.value).lower()

    assert _row(shop["admin"], interval_id)["voided_at"] is None


def test_cancelling_twice_is_not_an_error(shop):
    """A gloved double-tap and a retry after a dropped cellular response both land
    here. Neither is a mistake worth surfacing."""
    interval_id = _start(shop["owner"], shop["op_a"])
    _cancel(shop["owner"], interval_id)
    first_voided_at = _row(shop["admin"], interval_id)["voided_at"]

    _cancel(shop["owner"], interval_id)  # must not raise

    assert _row(shop["admin"], interval_id)["voided_at"] == first_voided_at, (
        "the second call must be a no-op, not a re-stamp — a re-stamp would move "
        "the void time on every retry"
    )


def test_cancelling_an_already_closed_interval_is_a_no_op(shop):
    """The race worth naming: the chain can close your interval while the confirm
    dialog is open, because someone else took the machine. Cancelling then must not
    reach back and void real, closed work."""
    interval_id = _start(shop["owner"], shop["op_a"])
    _start(shop["mate"], shop["op_b"])  # chain-closes the first as 'switched'

    closed = _row(shop["admin"], interval_id)
    assert closed["ended_at"] is not None and closed["close_reason"] == "switched"

    _cancel(shop["owner"], interval_id)  # must not raise

    after = _row(shop["admin"], interval_id)
    assert after["voided_at"] is None, (
        "a closed interval is out of scope — the lookup filters `ended_at IS NULL`, "
        "so a late cancel cannot destroy a span the chain already measured"
    )


def test_a_lapsed_subscription_cannot_cancel(shop):
    """SECURITY DEFINER bypasses the RESTRICTIVE billing policy, so the gate is
    enforced by hand inside the function. Without it a lapsed shop could still
    write and `test_no_tenant_table_left_ungated` would not notice, because the
    TABLE is gated — the bypass is the hole, not the table."""
    interval_id = _start(shop["owner"], shop["op_a"])

    # Drop out of demo, with no billing row: company_can_write() is now false.
    shop["admin"].table("companies").update({"is_demo": False}).eq(
        "id", shop["company_id"]
    ).execute()

    with pytest.raises(Exception) as exc:
        _cancel(shop["owner"], interval_id)
    assert "billing_gate" in str(exc.value)

    assert _row(shop["admin"], interval_id)["voided_at"] is None


def test_a_cancelled_interval_is_invisible_to_every_reader(shop):
    """It contributes to no total and appears on no surface — which is what makes
    voiding an honest answer rather than a hidden one."""
    interval_id = _start(shop["owner"], shop["op_a"])
    _cancel(shop["owner"], interval_id)

    # The owner's own list — backs the step screen's START-vs-running decision.
    mine = (
        shop["owner"]["client"]
        .table("job_operation_intervals")
        .select("id")
        .is_("ended_at", None)
        .is_("voided_at", None)
        .execute()
        .data
    )
    assert interval_id not in {r["id"] for r in mine}

    # The office aggregate — no minutes, and no open count to explain.
    actuals = (
        shop["admin"]
        .rpc("get_operation_actuals", {"p_job_operation_ids": [shop["op_a"]]})
        .execute()
        .data
    )
    for row in actuals or []:
        assert row["open_count"] == 0
        assert (row["actual_minutes"] or 0) == 0
