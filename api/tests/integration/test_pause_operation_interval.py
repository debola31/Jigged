"""An operator can pause a running span, and only their own.

WHY THIS FEATURE EXISTS AT ALL, since it reverses a written non-goal. The chain
expresses "I stopped doing this" as "I started doing something else" — which works
only when there IS a next thing. Walking away had no honest expression: the
operator could `Cancel activity`, which DISCARDS the measured minutes, or leave the
clock running, which holds the work centre against everyone else and lands on the
office list as a forgotten timer.

WHY THIS IS A DATABASE TEST. Every guarantee is in Postgres and none of it is
observable from the frontend:

  * the ownership assertion is inside a `SECURITY DEFINER` function;
  * the billing refusal is a `RAISE` the browser never sees the inputs to;
  * the property the whole feature turns on — that closing the span FREES THE WORK
    CENTRE'S CHAIN SLOT — is a consequence of two partial unique indexes keying on
    `ended_at IS NULL`, which is also the reason a `paused` FLAG on an open row was
    rejected in favour of closing it;
  * and the distinction from cancel is two column values, not a UI state.

THE BOUNDARY THESE PIN, and it is the one a future refactor is most likely to blur:
pause CLOSES (`ended_at` stamped, `close_reason='paused'`, minutes kept and summed
by `get_operation_actuals`); cancel VOIDS (`voided_at` stamped, `ended_at` left
NULL, minutes gone). They are one letter apart on screen and opposite in effect.

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

    `operator`, not `admin`: pausing your own work is the weakest thing an operator
    must be able to do, and a version that only worked for admins would miss the
    entire point.
    """
    email = f"poi-{label}-{os.urandom(4).hex()}@test.jigged.local"
    password = "test-password-pause-interval"
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
        .insert({"name": f"poi-{os.urandom(3).hex()}"})
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


def _pause(member: dict, interval_id: str):
    return (
        member["client"]
        .rpc("pause_operation_interval", {"p_interval_id": interval_id})
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


def _actual_minutes(member: dict, job_operation_id: str) -> float:
    rows = (
        member["client"]
        .rpc("get_operation_actuals", {"p_job_operation_ids": [job_operation_id]})
        .execute()
        .data
    )
    return float(rows[0]["actual_minutes"]) if rows else 0.0


def test_pause_closes_the_span_and_keeps_its_minutes(shop):
    """The whole point, and the opposite of cancel."""
    interval_id = _start(shop["owner"], shop["op_a"])
    # Back-date the raw start so the span has real length. `started_at` is not in
    # the browser's UPDATE grant by design, so this goes through the admin client.
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", interval_id).execute()

    _pause(shop["owner"], interval_id)

    row = _row(shop["admin"], interval_id)
    assert row["ended_at"] is not None, "pause CLOSES the span; cancel is the one that does not"
    assert row["close_reason"] == "paused"
    assert row["voided_at"] is None, (
        "voiding would discard the minutes, which is cancel's job and the exact "
        "behaviour pause exists to avoid"
    )
    # And the time is counted, which is the difference an operator can see.
    assert _actual_minutes(shop["owner"], shop["op_a"]) > 0


def test_pause_frees_the_work_centre_for_someone_else(shop):
    """The reason it closes the span rather than flagging an open row.

    Both partial unique indexes carry `ended_at IS NULL`, so a paused-but-open row
    would keep holding the machine — an operator at lunch would block the shop.
    """
    interval_id = _start(shop["owner"], shop["op_a"])
    _pause(shop["owner"], interval_id)

    # Same work centre, different step, different person. Under a flag-on-open-row
    # design this raises 23505.
    other = _start(shop["mate"], shop["op_b"])
    assert other

    # And the paused span was NOT chain-closed a second time: it is already closed,
    # so start_operation_interval's UPDATE (which targets `ended_at IS NULL`) misses
    # it and cannot rewrite `paused` to `switched`.
    assert _row(shop["admin"], interval_id)["close_reason"] == "paused"


def test_resume_opens_a_new_span_and_the_minutes_add_up(shop):
    """Resume is start_operation_interval. There is no resume RPC, on purpose."""
    first = _start(shop["owner"], shop["op_a"])
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", first).execute()
    _pause(shop["owner"], first)

    second = _start(shop["owner"], shop["op_a"])
    assert second != first, "resuming must not reopen the closed span"

    spans = (
        shop["admin"]
        .table("job_operation_intervals")
        .select("id, close_reason")
        .eq("job_operation_id", shop["op_a"])
        .execute()
        .data
    )
    assert len(spans) == 2
    assert {s["close_reason"] for s in spans} == {"paused", None}


def test_a_stranger_cannot_pause_your_work(shop):
    """Pausing states YOUR intent to come back, and nobody can state it for you.

    A colleague who needs the machine STARTS on it, and the chain closes yours as
    `switched` — that path is unchanged and deliberately still crosses ownership.
    """
    interval_id = _start(shop["owner"], shop["op_a"])

    with pytest.raises(Exception) as err:
        _pause(shop["mate"], interval_id)
    assert "only pause an activity you started" in str(err.value).lower()

    assert _row(shop["admin"], interval_id)["ended_at"] is None


def test_pausing_an_already_closed_span_is_a_no_op(shop):
    """Idempotent like its siblings, so a gloved double-tap is harmless."""
    interval_id = _start(shop["owner"], shop["op_a"])
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", interval_id).execute()
    _pause(shop["owner"], interval_id)
    first_end = _row(shop["admin"], interval_id)["ended_at"]

    _pause(shop["owner"], interval_id)

    assert _row(shop["admin"], interval_id)["ended_at"] == first_end


def test_a_zero_length_pause_is_refused_in_words(shop):
    """`job_op_intervals_ordered` is strict, and a constraint name is not an error
    an operator can act on.

    The RPC must not "fix" this by nudging the end forward a second — that
    fabricates a measurement, which is the thing this whole table refuses to do.
    """
    interval_id = _start(shop["owner"], shop["op_a"])
    # A start in the future is the only way to force the case deterministically;
    # in life it is a pause tapped in the same instant as the start.
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2099-01-01T00:00:00+00:00"}
    ).eq("id", interval_id).execute()

    with pytest.raises(Exception) as err:
        _pause(shop["owner"], interval_id)
    message = str(err.value).lower()
    assert "cancel the activity" in message
    assert "job_op_intervals_ordered" not in message, (
        "the constraint name is not something the floor can act on"
    )


def test_a_lapsed_subscription_cannot_pause(shop):
    """SECURITY DEFINER bypasses the RESTRICTIVE billing gate, so the function
    calls company_can_write by hand. Without that line the table is gated and the
    write still lands."""
    interval_id = _start(shop["owner"], shop["op_a"])
    shop["admin"].table("companies").update({"is_demo": False}).eq(
        "id", shop["company_id"]
    ).execute()

    with pytest.raises(Exception) as err:
        _pause(shop["owner"], interval_id)
    assert "subscription is not active" in str(err.value).lower()


def test_the_operator_sees_their_own_pause_and_not_a_colleague_s(shop):
    """get_my_paused_operations is SECURITY INVOKER, so job_op_intervals_select_own
    does the scoping. A definer version would need a hand-written owner filter, and
    a bug in that filter is a per-person time view."""
    mine = _start(shop["owner"], shop["op_a"])
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", mine).execute()
    _pause(shop["owner"], mine)

    theirs = _start(shop["mate"], shop["op_b"])
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", theirs).execute()
    _pause(shop["mate"], theirs)

    rows = (
        shop["owner"]["client"]
        .rpc("get_my_paused_operations", {"p_company_id": shop["company_id"]})
        .execute()
        .data
    )
    assert [r["job_operation_id"] for r in rows] == [shop["op_a"]]


def test_the_operator_s_paused_list_carries_no_estimate(shop):
    """Enforced in the RETURNS TABLE rather than in the component.

    This list renders beside live clocks, and an estimate-derived figure there is
    the adjacent comparison the surveillance guardrail refuses. The office sibling
    DOES carry it; see the next test.
    """
    interval_id = _start(shop["owner"], shop["op_a"])
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", interval_id).execute()
    _pause(shop["owner"], interval_id)

    rows = (
        shop["owner"]["client"]
        .rpc("get_my_paused_operations", {"p_company_id": shop["company_id"]})
        .execute()
        .data
    )
    assert rows
    assert "expected_minutes" not in rows[0]


def test_the_office_list_is_admin_only_and_names_nobody(shop):
    """An operator gets nothing; an admin gets the row with an estimate and no
    operator identity. There is no admin-readable SELECT policy on the table
    because PostgREST would supply the grouping for free."""
    interval_id = _start(shop["owner"], shop["op_a"])
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", interval_id).execute()
    _pause(shop["owner"], interval_id)

    as_operator = (
        shop["owner"]["client"]
        .rpc("get_paused_operations", {"p_company_id": shop["company_id"]})
        .execute()
        .data
    )
    assert as_operator == []

    boss = _add_member(shop["admin"], shop["company_id"], "morgan", role="admin")
    try:
        rows = (
            boss["client"]
            .rpc("get_paused_operations", {"p_company_id": shop["company_id"]})
            .execute()
            .data
        )
        assert [r["job_operation_id"] for r in rows] == [shop["op_a"]]
        assert "expected_minutes" in rows[0]
        assert "operator_id" not in rows[0]
    finally:
        shop["admin"].auth.admin.delete_user(boss["user_id"])


def test_a_resumed_step_leaves_the_paused_lists(shop):
    """Otherwise the office chases work somebody already picked back up."""
    interval_id = _start(shop["owner"], shop["op_a"])
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", interval_id).execute()
    _pause(shop["owner"], interval_id)
    _start(shop["owner"], shop["op_a"])

    rows = (
        shop["owner"]["client"]
        .rpc("get_my_paused_operations", {"p_company_id": shop["company_id"]})
        .execute()
        .data
    )
    assert rows == []


def test_a_paused_step_stays_on_the_station_dispatch_list(shop):
    """THE J-0118 REGRESSION, one control later.

    A paused step has produced nothing, so `job_operations.status` derives to
    `pending`; its span is CLOSED, so the has_open_interval branch misses it. Out of
    sequence as well and it satisfies none of the branches — which would make Pause
    a control that HIDES the work it is used on.

    op_b is sequence 20 behind an incomplete sequence 10, so it is deliberately not
    sequence-ready. Without the fourth branch this returns nothing for it.
    """
    interval_id = _start(shop["owner"], shop["op_b"])
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", interval_id).execute()
    _pause(shop["owner"], interval_id)

    rows = (
        shop["owner"]["client"]
        .rpc(
            "get_ready_operations_for_station",
            {
                "p_company_id": shop["company_id"],
                "p_work_center_id": shop["work_center_id"],
            },
        )
        .execute()
        .data
    )
    by_op = {r["job_operation_id"]: r for r in rows}
    assert shop["op_b"] in by_op, "a paused step must not fall off every operator surface"
    assert by_op[shop["op_b"]]["has_paused_interval"] is True
    assert by_op[shop["op_b"]]["has_open_interval"] is False


def test_the_station_mark_carries_no_person_and_no_time(shop):
    """Same contract as get_running_operation_ids_for_station: ids and nothing else.

    "OP 20 at EDM is paused" is a fact about a MACHINE. An operator_id or a
    timestamp here would publish one operator's pace to whoever walks up next.
    """
    interval_id = _start(shop["owner"], shop["op_b"])
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", interval_id).execute()
    _pause(shop["owner"], interval_id)

    # The mate can see the MARK on the dispatch list even though the pause is not
    # theirs — that is the point of the definer helper — but it is a bare boolean.
    rows = (
        shop["mate"]["client"]
        .rpc(
            "get_ready_operations_for_station",
            {
                "p_company_id": shop["company_id"],
                "p_work_center_id": shop["work_center_id"],
            },
        )
        .execute()
        .data
    )
    marked = [r for r in rows if r["job_operation_id"] == shop["op_b"]]
    assert marked and marked[0]["has_paused_interval"] is True
    assert "operator_id" not in marked[0]
    assert "paused_at" not in marked[0]


def test_get_open_intervals_carries_the_whole_step_estimate(shop):
    """The office needs `expected_minutes` to flag a SHORT step running long.

    Six hours flat could not tell a 20-minute deburr left running over lunch from
    a 5-hour EDM burn doing exactly what it should. The figure is the whole step —
    setup plus quantity x run-per-unit — not the per-unit rate, because what is
    being compared against is a whole-step elapsed time.
    """
    shop["admin"].table("job_operations").update(
        {"estimated_setup_minutes": 15, "estimated_run_minutes_per_unit": 0.5}
    ).eq("id", shop["op_a"]).execute()
    _start(shop["owner"], shop["op_a"])

    boss = _add_member(shop["admin"], shop["company_id"], "sam", role="admin")
    try:
        rows = (
            boss["client"]
            .rpc("get_open_intervals", {"p_company_id": shop["company_id"]})
            .execute()
            .data
        )
        row = next(r for r in rows if r["job_operation_id"] == shop["op_a"])
        # 15 setup + 60 parts x 0.5 = 45
        assert float(row["expected_minutes"]) == 45.0
        assert "operator_id" not in row
    finally:
        shop["admin"].auth.admin.delete_user(boss["user_id"])


def test_a_step_with_no_estimate_reports_zero_not_null(shop):
    """0 is the caller's signal to fall back to the flat ceiling.

    NULL would force every reader to branch on it, and lib/duration.ts tests
    `expected > 0` precisely so there is one shape. Both estimate columns are
    nullable and a step with neither is ordinary.
    """
    _start(shop["owner"], shop["op_a"])

    boss = _add_member(shop["admin"], shop["company_id"], "lee", role="admin")
    try:
        rows = (
            boss["client"]
            .rpc("get_open_intervals", {"p_company_id": shop["company_id"]})
            .execute()
            .data
        )
        row = next(r for r in rows if r["job_operation_id"] == shop["op_a"])
        assert row["expected_minutes"] is not None
        assert float(row["expected_minutes"]) == 0.0
    finally:
        shop["admin"].auth.admin.delete_user(boss["user_id"])


def test_a_colleague_taking_over_does_not_clear_your_paused_row(shop):
    """A HORIZON, pinned so nobody "fixes" it into a per-person time view.

    `get_my_paused_operations` is SECURITY INVOKER, so its "has anything happened
    on this step since?" check reads the table AS THE CALLER and cannot see a
    colleague's span. Your row therefore keeps reading `Paused` after somebody else
    picks the step up.

    THE FIX THAT LOOKS OBVIOUS IS THE ONE TO REFUSE: making it SECURITY DEFINER
    with a hand-written `operator_id = get_operator_access_id(...)` filter. A bug
    in that single line is a per-person time view, and no path in this product
    resolves recorded time to a named person (20260825170421).

    The cost is small and self-correcting — tapping the row goes to the step, whose
    primary reads RESUME, and resuming takes the machine through the chain, which
    is the documented shift handoff. The OFFICE list has no horizon; see below.
    """
    mine = _start(shop["owner"], shop["op_a"])
    shop["admin"].table("job_operation_intervals").update(
        {"started_at": "2026-09-07T09:00:00+00:00"}
    ).eq("id", mine).execute()
    _pause(shop["owner"], mine)

    _start(shop["mate"], shop["op_a"])

    still_mine = (
        shop["owner"]["client"]
        .rpc("get_my_paused_operations", {"p_company_id": shop["company_id"]})
        .execute()
        .data
    )
    assert [r["job_operation_id"] for r in still_mine] == [shop["op_a"]], (
        "the horizon is real; if this now returns [] someone changed the security "
        "model and the docstring above needs re-reading before it is celebrated"
    )

    # And the office, which is DEFINER, sees the truth: the step is RUNNING, so it
    # is not on the paused list at all.
    boss = _add_member(shop["admin"], shop["company_id"], "robin", role="admin")
    try:
        office_paused = (
            boss["client"]
            .rpc("get_paused_operations", {"p_company_id": shop["company_id"]})
            .execute()
            .data
        )
        assert office_paused == []
        office_open = (
            boss["client"]
            .rpc("get_open_intervals", {"p_company_id": shop["company_id"]})
            .execute()
            .data
        )
        assert [r["job_operation_id"] for r in office_open] == [shop["op_a"]]
    finally:
        shop["admin"].auth.admin.delete_user(boss["user_id"])
