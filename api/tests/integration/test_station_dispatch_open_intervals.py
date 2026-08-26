"""A step with a timer running must appear on its station's dispatch list.

THE PRODUCTION FAILURE THESE ARE WRITTEN AGAINST (2026-08-25). J-0118 / OP 30 EDM
had an interval open since 3:01 PM. It appeared on the office Still-running card
and on no operator surface at all — not "My Station" at EDM, not "Completed", not
"All Stations". The one step on the floor that was actually running was the one
step the floor could not see.

Two correct rules composed into a wrong answer. `job_operations.status` derives
from RECORDED QUANTITY, so a step somebody started but has produced nothing on is
`pending`; and get_ready_operations_for_station admitted a `pending` step only
when it was sequence-ready. Starting, meanwhile, does not require
sequence-readiness — shops work out of order and the traveler permits it — so the
write path admitted a case the read path then hid.

WHY IT IS WORTH A DATABASE TEST rather than a unit test: every load-bearing piece
is in Postgres. The new branch is a WHERE clause; the reason it needs a
SECURITY DEFINER helper is an RLS policy (`job_op_intervals_select_own` — the
interval worth finding is by definition somebody ELSE'S, and the dispatch RPC is
SECURITY INVOKER); and the guardrail that keeps this from becoming a per-person
time view is the ABSENCE of a SELECT grant, which no frontend test can observe.

So the assertions come in pairs throughout: the row appears, AND nothing about
who is on it comes with it.

Requires a local Supabase with all migrations applied (TEST_SUPABASE_URL /
TEST_SUPABASE_PUBLISHABLE_KEY / TEST_SUPABASE_SECRET_KEY). Skipped without it.
"""
from __future__ import annotations

import os
import uuid

import pytest
from supabase import create_client

pytestmark = pytest.mark.integration


def _publishable_key() -> str:
    return os.environ.get("TEST_SUPABASE_PUBLISHABLE_KEY") or os.environ["TEST_SUPABASE_ANON_KEY"]


def _add_member(admin, company_id: str, label: str, role: str = "operator") -> dict:
    """A company member with their own signed-in, anon-key client.

    `operator`, not `admin`: the point of the fix is that a SECOND person can see
    and take over a step the first left running, and an operator is the weakest
    role that must be able to. Anything that only works for admins would be a
    different (and much easier) feature.
    """
    email = f"sdoi-{label}-{os.urandom(4).hex()}@test.jigged.local"
    password = "test-password-station-dispatch"
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
def floor(supabase_admin):
    """One shop, two operators, and a part routed DEBURR (10) → EDM (30).

    The J-0118 shape exactly: EDM is NOT sequence-ready, because DEBURR before it
    is still pending. A third part is routed straight to EDM and IS ready, so the
    tests can tell "the running row was added" from "the filter fell open".
    """
    admin = supabase_admin
    company_id = (
        admin.table("companies")
        .insert({"name": f"sdoi-{os.urandom(3).hex()}"})
        .execute()
        .data[0]["id"]
    )
    # Demo => company_can_write() is true with no billing row, so the billing gate
    # inside start_operation_interval never masks what these tests assert.
    admin.table("companies").update({"is_demo": True}).eq("id", company_id).execute()

    owner = _add_member(admin, company_id, "kurtis")
    mate = _add_member(admin, company_id, "dana")

    def _work_center(name: str) -> str:
        return (
            admin.table("work_centers")
            .insert({"company_id": company_id, "name": f"{name}-{os.urandom(2).hex()}"})
            .execute()
            .data[0]["id"]
        )

    deburr_id = _work_center("DEBURR")
    edm_id = _work_center("EDM")

    def _job_part(job_number: str, part_label: str) -> dict:
        part_id = (
            admin.table("parts")
            .insert(
                {
                    "company_id": company_id,
                    "part_name": f"{part_label}-{os.urandom(2).hex()}",
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
                    "job_number": f"{job_number}-{os.urandom(2).hex()}",
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
        return {"job_id": job_id, "job_part_id": job_part_id, "part_id": part_id}

    def _operation(jp: dict, sequence: int, name: str, work_center_id: str) -> str:
        return (
            admin.table("job_operations")
            .insert(
                {
                    "job_id": jp["job_id"],
                    "job_part_id": jp["job_part_id"],
                    "sequence": sequence,
                    "operation_name": name,
                    "work_center_id": work_center_id,
                }
            )
            .execute()
            .data[0]["id"]
        )

    # The stranded shape: EDM sits behind an unfinished DEBURR.
    blocked = _job_part("J-9001", "SKYLINE")
    _operation(blocked, 10, "DEBURR", deburr_id)
    blocked_edm_op = _operation(blocked, 30, "EDM", edm_id)

    # The control: EDM is this part's first step, so it is ready on its own.
    ready = _job_part("J-9002", "BRACKET")
    ready_edm_op = _operation(ready, 10, "EDM", edm_id)

    ctx = {
        "admin": admin,
        "company_id": company_id,
        "owner": owner,
        "mate": mate,
        "edm_id": edm_id,
        "deburr_id": deburr_id,
        "blocked_edm_op": blocked_edm_op,
        "ready_edm_op": ready_edm_op,
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


def _dispatch(member: dict, company_id: str, work_center_id: str) -> list[dict]:
    """The station list exactly as utils/operatorAccess.ts fetches it."""
    return (
        member["client"]
        .rpc(
            "get_ready_operations_for_station",
            {"p_company_id": company_id, "p_work_center_id": work_center_id},
        )
        .execute()
        .data
        or []
    )


def _op_ids(rows: list[dict]) -> set[str]:
    return {r["job_operation_id"] for r in rows}


def _start(member: dict, job_operation_id: str) -> str:
    """Start a timer through the real RPC, as the member — not a direct INSERT.

    The browser has no INSERT grant on job_operation_intervals at all, so a direct
    insert would test a path that cannot happen and would skip the ownership and
    billing checks the real one applies.
    """
    resp = (
        member["client"]
        .rpc("start_operation_interval", {"p_job_operation_id": job_operation_id})
        .execute()
    )
    return resp.data[0]["interval_id"]


def test_an_out_of_sequence_step_is_hidden_until_someone_starts_it(floor):
    """The negative control, and it must run FIRST in spirit: if this half ever
    stops holding, the "fix" is just a filter that fell open and every other
    assertion here is vacuous."""
    rows = _dispatch(floor["mate"], floor["company_id"], floor["edm_id"])

    assert floor["ready_edm_op"] in _op_ids(rows), (
        "the part whose FIRST step is EDM must be on the EDM list — if it is not, "
        "the fixture is wrong and nothing below means anything"
    )
    assert floor["blocked_edm_op"] not in _op_ids(rows), (
        "EDM behind an unfinished DEBURR is not ready and nobody is on it, so it "
        "must stay off the dispatch list"
    )


def test_a_started_step_appears_at_its_station_for_a_different_operator(floor):
    """THE REGRESSION. Kurtis starts EDM out of sequence; Dana, at the EDM
    station, must see it.

    Deliberately asserted as the OTHER member: `job_op_intervals_select_own`
    scopes the interval table to the caller's own rows, so a version of this
    written as the starter would pass against a broken implementation.
    """
    before = _op_ids(_dispatch(floor["mate"], floor["company_id"], floor["edm_id"]))
    assert floor["blocked_edm_op"] not in before

    _start(floor["owner"], floor["blocked_edm_op"])

    rows = _dispatch(floor["mate"], floor["company_id"], floor["edm_id"])
    running = [r for r in rows if r["job_operation_id"] == floor["blocked_edm_op"]]
    assert running, (
        "a step with a timer open at this station must be on this station's list, "
        "whatever the steps before it say"
    )
    assert running[0]["has_open_interval"] is True
    assert running[0]["op_status"] == "pending", (
        "and it is still `pending` — op status derives from recorded quantity, "
        "which is exactly why has_open_interval had to be its own flag rather "
        "than something inferred from the status the row already carried"
    )


def test_the_running_step_sorts_above_idle_ready_work(floor):
    """An operator walking up to EDM deals with the machine that is already
    turning before the pile of work that is merely next."""
    _start(floor["owner"], floor["blocked_edm_op"])

    rows = _dispatch(floor["mate"], floor["company_id"], floor["edm_id"])
    assert len(rows) >= 2, "need the ready row too, or the ordering claim is untested"
    assert rows[0]["job_operation_id"] == floor["blocked_edm_op"]
    assert rows[0]["has_open_interval"] is True
    assert rows[1]["has_open_interval"] is False


def test_the_dispatch_row_reveals_nothing_about_who_is_on_it(floor):
    """The guardrail half, and the reason the helper returns bare ids.

    docs/modules/operator-view.md#surveillance-guardrail-non-negotiable: an open
    interval is a fact about a MACHINE. Dana may learn that EDM is running. She
    may not learn that it is Kurtis, when he started, or how long he has been on
    it — from this row or from anywhere else.
    """
    interval_id = _start(floor["owner"], floor["blocked_edm_op"])

    rows = _dispatch(floor["mate"], floor["company_id"], floor["edm_id"])
    running = next(r for r in rows if r["job_operation_id"] == floor["blocked_edm_op"])

    forbidden = {"operator_id", "operator_name", "started_at", "elapsed", "duration"}
    assert forbidden.isdisjoint(running.keys()), (
        f"the dispatch row grew a field that identifies or times the person: "
        f"{forbidden & set(running.keys())}"
    )

    # The table itself is unchanged: the SELECT policy is still own-rows-only, and
    # the SECURITY DEFINER helper did not become a way around it.
    visible = (
        floor["mate"]["client"]
        .table("job_operation_intervals")
        .select("id")
        .execute()
        .data
    )
    assert visible == [], (
        "the interval row must remain unreadable to everyone but its owner — "
        "the dispatch list learns the operation id and nothing else"
    )
    assert interval_id not in {r["id"] for r in visible}

    # And the helper the dispatch RPC leans on returns ids, full stop. It is
    # browser-callable (its caller is SECURITY INVOKER and runs as the caller), so
    # what it returns is reachable directly and has to be safe on its own terms.
    direct = (
        floor["mate"]["client"]
        .rpc(
            "get_running_operation_ids_for_station",
            {
                "p_company_id": floor["company_id"],
                "p_work_center_id": floor["edm_id"],
            },
        )
        .execute()
        .data
    )
    assert direct == [floor["blocked_edm_op"]], (
        "the helper must return operation ids and nothing else, in any shape"
    )


def test_the_helper_returns_nothing_for_a_company_you_are_not_in(floor):
    """SECURITY DEFINER bypasses RLS, so the membership re-derivation inside the
    helper is the ONLY thing standing between a caller and another shop's floor.
    A random company id must come back empty rather than erroring or answering."""
    _start(floor["owner"], floor["blocked_edm_op"])

    leaked = (
        floor["mate"]["client"]
        .rpc(
            "get_running_operation_ids_for_station",
            {
                "p_company_id": str(uuid.uuid4()),
                "p_work_center_id": floor["edm_id"],
            },
        )
        .execute()
        .data
    )
    assert leaked == []


def test_a_step_running_at_another_station_stays_off_this_station(floor):
    """The chain is per work centre, so the list is too. A timer open on DEBURR
    must not drag its step onto the EDM board — the operator standing at EDM
    cannot act on it, and a dispatch list that lists other people's machines is
    back to being noise."""
    deburr_rows_before = _dispatch(
        floor["mate"], floor["company_id"], floor["deburr_id"]
    )
    assert deburr_rows_before, "DEBURR is step 10, so it is ready — fixture check"

    _start(floor["owner"], deburr_rows_before[0]["job_operation_id"])

    edm_rows = _dispatch(floor["mate"], floor["company_id"], floor["edm_id"])
    assert floor["blocked_edm_op"] not in _op_ids(edm_rows), (
        "starting DEBURR must not surface the EDM step behind it"
    )
    assert all(r["has_open_interval"] is False for r in edm_rows)
