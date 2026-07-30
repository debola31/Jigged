"""Integration tests for note view-logging: dedupe, exclusions, and the privacy rules.

These are the acceptance criteria for the attribution loop, written against a real
database because every one of them is enforced in Postgres rather than in the app:

  - dedupe is a UNIQUE constraint, not application logic;
  - "never the author" and "never an excluded account" live inside a SECURITY
    DEFINER function, so the browser cannot opt out;
  - "everyone else sees counts only" is the ABSENCE of a SELECT grant, which no
    frontend test could observe.

The product rule underneath all of it: if a shop owner can audit who reads notes,
reading becomes an admission of ignorance and the read side dies. So the strongest
assertions here are the negative ones.

Requires a local Supabase with all migrations applied (TEST_SUPABASE_URL /
TEST_SUPABASE_PUBLISHABLE_KEY / TEST_SUPABASE_SECRET_KEY). Skipped without it.
"""
from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone

import pytest
from supabase import create_client

pytestmark = pytest.mark.integration


def _publishable_key() -> str:
    return os.environ.get("TEST_SUPABASE_PUBLISHABLE_KEY") or os.environ["TEST_SUPABASE_ANON_KEY"]


def _add_member(admin, company_id: str, label: str, role: str = "operator") -> dict:
    """A company member with their own signed-in client.

    Deliberately defaults to `operator`, not `admin`: note_viewers() blocks admins
    outright (an admin could otherwise author a must-read note and legitimately
    harvest a named read list), so an admin-by-default cast would make the core
    author-sees-names test silently vacuous.
    """
    email = f"nv-{label}-{os.urandom(4).hex()}@test.jigged.local"
    password = "test-password-note-views"
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
        "name": label.title(),
        "client": client,
    }


@pytest.fixture
def shop(supabase_admin):
    """A company with an author, two readers, an admin, a routed part, and two jobs."""
    admin = supabase_admin
    company_id = (
        admin.table("companies")
        .insert({"name": f"nv-{os.urandom(3).hex()}"})
        .execute()
        .data[0]["id"]
    )
    # Demo company => company_can_write() is true without a billing row, so the
    # billing gate never masks an RLS result we are actually trying to assert.
    admin.table("companies").update({"is_demo": True}).eq("id", company_id).execute()

    author = _add_member(admin, company_id, "kurtis")
    reader = _add_member(admin, company_id, "dana")
    reader2 = _add_member(admin, company_id, "sam")
    boss = _add_member(admin, company_id, "shane", role="admin")

    # primary_unit is NOT NULL via parts_requires_unit; production/fulfillment
    # status are NOT NULL on jobs. Both are easy to miss because the access layer
    # always supplies them.
    part_id = (
        admin.table("parts")
        .insert(
            {
                "company_id": company_id,
                "part_name": f"BRACKET-{os.urandom(2).hex()}",
                "primary_unit": "ea",
            }
        )
        .execute()
        .data[0]["id"]
    )
    wc_id = (
        admin.table("work_centers")
        .insert({"company_id": company_id, "name": f"MILL-{os.urandom(2).hex()}"})
        .execute()
        .data[0]["id"]
    )
    routing_id = (
        admin.table("routings")
        .insert({"company_id": company_id, "part_id": part_id, "name": "Main"})
        .execute()
        .data[0]["id"]
    )
    routing_op_id = (
        admin.table("routing_operations")
        .insert({"routing_id": routing_id, "work_center_id": wc_id, "sequence": 10})
        .execute()
        .data[0]["id"]
    )

    jobs = []
    for n in ("J-0041", "J-0052"):
        jobs.append(
            admin.table("jobs")
            .insert(
                {
                    "company_id": company_id,
                    "job_number": f"{n}-{os.urandom(2).hex()}",
                    "production_status": "not_started",
                    "fulfillment_status": "unshipped",
                }
            )
            .execute()
            .data[0]["id"]
        )

    ctx = {
        "company_id": company_id,
        "author": author,
        "reader": reader,
        "reader2": reader2,
        "boss": boss,
        "part_id": part_id,
        "routing_operation_id": routing_op_id,
        "work_center_id": wc_id,
        "job_a": jobs[0],
        "job_b": jobs[1],
        "admin": admin,
    }
    yield ctx

    # notes first: a machine-subject note holds work_centers with ON DELETE
    # RESTRICT, so tearing down in the other order leaves the work center behind
    # and the failure is swallowed by the except.
    for table in ("notes", "jobs", "routings", "parts", "work_centers"):
        try:
            admin.table(table).delete().eq("company_id", company_id).execute()
        except Exception:
            pass
    admin.table("companies").delete().eq("id", company_id).execute()
    for m in (author, reader, reader2, boss):
        try:
            admin.auth.admin.delete_user(m["user_id"])
        except Exception:
            pass


def _make_note(
    shop, body: str = "back the feed off on the last pass", days_ago: int | None = None
) -> str:
    """A DURABLE part-subject note authored by `author`, captured on job A.

    `days_ago` matters for the ranking tests: the Playbook pins anything from the
    last 14 days newest-first, so a note created NOW is ordered by recency and
    tells you nothing about usefulness ranking. Age it past the window to exercise
    that half.
    """
    row = {
        "company_id": shop["company_id"],
        "subject_kind": "part",
        "part_id": shop["part_id"],
        "routing_operation_id": shop["routing_operation_id"],
        "captured_job_id": shop["job_a"],
        "author_id": shop["author"]["access_id"],
        "body": body,
    }
    if days_ago is not None:
        row["created_at"] = (
            datetime.now(timezone.utc) - timedelta(days=days_ago)
        ).isoformat()
    return shop["admin"].table("notes").insert(row).execute().data[0]["id"]


def _counts(shop, note_id: str) -> tuple[int, int]:
    row = (
        shop["admin"]
        .table("notes")
        .select("viewer_count, usage_count")
        .eq("id", note_id)
        .single()
        .execute()
        .data
    )
    return row["viewer_count"], row["usage_count"]


def _rows(shop, note_id: str) -> list[dict]:
    return (
        shop["admin"].table("note_views").select("*").eq("note_id", note_id).execute().data
    )


# ── dedupe: rows are (person, job), counters split people from jobs ──────────


def test_same_person_same_job_twice_is_one_row(shop):
    note_id = _make_note(shop)
    for _ in range(2):
        shop["reader"]["client"].rpc(
            "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
        ).execute()

    assert len(_rows(shop, note_id)) == 1
    assert _counts(shop, note_id) == (1, 1)


def test_same_person_two_jobs_is_repeat_use_not_repeat_opens(shop):
    """The distinction the two counters exist for: one PERSON, two JOBS."""
    note_id = _make_note(shop)
    for job in (shop["job_a"], shop["job_b"]):
        shop["reader"]["client"].rpc(
            "log_note_views", {"p_note_ids": [note_id], "p_job_id": job}
        ).execute()

    assert len(_rows(shop, note_id)) == 2
    viewers, usage = _counts(shop, note_id)
    assert viewers == 1, "one person read it, however many jobs they used it on"
    assert usage == 2, "used on two jobs — the signal that it is load-bearing"


def test_job_less_reads_dedupe_to_one_row(shop):
    """NULLS NOT DISTINCT. Without it, every Playbook read inserts a new row."""
    note_id = _make_note(shop)
    for _ in range(3):
        shop["reader"]["client"].rpc(
            "log_note_views", {"p_note_ids": [note_id], "p_job_id": None}
        ).execute()

    assert len(_rows(shop, note_id)) == 1
    viewers, usage = _counts(shop, note_id)
    assert viewers == 1
    assert usage == 0, "a read with no job context is not usage on a job"


def test_two_people_two_viewers(shop):
    note_id = _make_note(shop)
    for m in ("reader", "reader2"):
        shop[m]["client"].rpc(
            "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
        ).execute()

    assert _counts(shop, note_id) == (2, 1)


# ── exclusions, enforced in the DB rather than the client ────────────────────


def test_author_reading_own_note_logs_nothing(shop):
    note_id = _make_note(shop)
    shop["author"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()

    assert _rows(shop, note_id) == []
    assert _counts(shop, note_id) == (0, 0)


def test_excluded_account_logs_nothing(shop):
    """The founder logs in constantly and must not inflate anyone's numbers."""
    note_id = _make_note(shop)
    shop["admin"].table("user_company_access").update(
        {"excluded_from_metrics": True}
    ).eq("id", shop["reader"]["access_id"]).execute()

    shop["reader"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()

    assert _rows(shop, note_id) == []


def test_browser_cannot_flip_the_exclusion_flag(shop):
    """Otherwise: exclude everyone but one person, watch the counters, and you
    have that person's entire reading history. RLS cannot scope to a column;
    the column-level GRANT is what closes this."""
    with pytest.raises(Exception) as exc:
        shop["boss"]["client"].table("user_company_access").update(
            {"excluded_from_metrics": True}
        ).eq("id", shop["reader"]["access_id"]).execute()
    assert "42501" in str(exc.value).lower() or "permission" in str(exc.value).lower()


def test_admin_can_still_change_a_member_role(shop):
    """Regression guard on the column-scoped grant above: the one browser write
    this table actually has must keep working."""
    shop["boss"]["client"].table("user_company_access").update({"role": "user"}).eq(
        "id", shop["reader2"]["access_id"]
    ).execute()
    row = (
        shop["admin"]
        .table("user_company_access")
        .select("role")
        .eq("id", shop["reader2"]["access_id"])
        .single()
        .execute()
        .data
    )
    assert row["role"] == "user"


# ── visibility: counts for everyone, names for the author only ───────────────


def test_note_views_is_unreadable_by_any_browser_role(shop):
    note_id = _make_note(shop)
    shop["reader"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()

    for who in ("author", "reader", "boss"):
        try:
            res = shop[who]["client"].table("note_views").select("*").execute()
            assert res.data == [], f"{who} could read note_views rows"
        except Exception as exc:  # a permission error is the expected outcome
            assert "42501" in str(exc).lower() or "permission" in str(exc).lower()


def test_author_sees_named_viewers_with_job_numbers(shop):
    note_id = _make_note(shop)
    shop["reader"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()

    rows = shop["author"]["client"].rpc("note_viewers", {"p_note_id": note_id}).execute().data
    assert [r["viewer_name"] for r in rows] == ["Dana"]
    assert rows[0]["job_number"]


def test_author_sees_one_row_per_person_however_many_jobs(shop):
    """With job in the dedupe key this is a query obligation rather than a
    physical impossibility, so it gets its own test."""
    note_id = _make_note(shop)
    for job in (shop["job_a"], shop["job_b"]):
        shop["reader"]["client"].rpc(
            "log_note_views", {"p_note_ids": [note_id], "p_job_id": job}
        ).execute()

    rows = shop["author"]["client"].rpc("note_viewers", {"p_note_id": note_id}).execute().data
    assert len(rows) == 1, "the author must never see that one person came back"


def test_non_author_gets_no_names(shop):
    note_id = _make_note(shop)
    shop["reader"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()

    assert shop["reader2"]["client"].rpc("note_viewers", {"p_note_id": note_id}).execute().data == []


def test_attribution_does_not_depend_on_the_authors_role(shop):
    """An admin author sees names exactly like an operator author does.

    Roles are fluid in a shop this size — an operator promoted to lead must not
    silently lose the feedback loop on notes they already wrote. The rule has no
    role branch: you see who used YOUR notes, nobody sees who used anyone else's.
    """
    note_id = (
        shop["admin"]
        .table("notes")
        .insert(
            {
                "company_id": shop["company_id"],
                "subject_kind": "part",
                "part_id": shop["part_id"],
                "author_id": shop["boss"]["access_id"],
                "body": "everyone read the new spec",
            }
        )
        .execute()
        .data[0]["id"]
    )
    shop["reader"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()

    rows = shop["boss"]["client"].rpc("note_viewers", {"p_note_id": note_id}).execute().data
    assert [r["viewer_name"] for r in rows] == ["Dana"]
    assert _counts(shop, note_id)[0] == 1


def test_role_change_does_not_change_what_an_author_can_see(shop):
    """The concrete regression the role branch would have caused: promote the
    author, and their view of their own notes must be identical."""
    note_id = _make_note(shop)
    shop["reader"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()

    before = shop["author"]["client"].rpc("note_viewers", {"p_note_id": note_id}).execute().data

    shop["admin"].table("user_company_access").update({"role": "admin"}).eq(
        "id", shop["author"]["access_id"]
    ).execute()

    after = shop["author"]["client"].rpc("note_viewers", {"p_note_id": note_id}).execute().data
    assert after == before
    assert [r["viewer_name"] for r in after] == ["Dana"]


def test_counters_never_fall_when_a_member_is_deleted(shop):
    """The strongest attack this design faces: snapshot the counters, delete one
    member so their rows cascade, snapshot again, and every note whose count
    dropped was read by that person. Monotonic counters close it."""
    note_id = _make_note(shop)
    for m in ("reader", "reader2"):
        shop[m]["client"].rpc(
            "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
        ).execute()
    before = _counts(shop, note_id)

    shop["admin"].table("user_company_access").delete().eq(
        "id", shop["reader"]["access_id"]
    ).execute()

    assert _counts(shop, note_id) == before


# ── the login-banner digest ──────────────────────────────────────────────────


def test_digest_counts_people_not_rows(shop):
    """Three rows can be one person on three jobs. "3 views" for a single reader
    consulting one note is the exact overstatement this must not make — the
    digest sums viewer_count, which is per (person, note)."""
    note_id = _make_note(shop)
    for job in (shop["job_a"], shop["job_b"]):
        shop["reader"]["client"].rpc(
            "log_note_views", {"p_note_ids": [note_id], "p_job_id": job}
        ).execute()

    assert len(_rows(shop, note_id)) == 2
    n = shop["author"]["client"].rpc("my_note_digest").execute().data[0]["views"]
    assert n == 1


def test_digest_is_scoped_to_the_callers_own_notes(shop):
    note_id = _make_note(shop)
    shop["reader"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()

    n = shop["reader2"]["client"].rpc("my_note_digest").execute().data[0]["views"]
    assert n == 0


def test_digest_takes_no_time_window(shop):
    """The permanent rule, asserted rather than left to code review: the digest
    accepts NO arguments. A caller-supplied window would be a bisection oracle
    recovering WHEN a note was read, which combined with note_viewers() naming
    the reader reconstructs "Kurtis had to look this up on Tuesday". The banner
    subtracts a running total on the client instead, so no instant ever crosses
    the wire."""
    with pytest.raises(Exception):
        shop["author"]["client"].rpc(
            "my_note_digest", {"p_tz": "America/Detroit"}
        ).execute()


def test_digest_is_a_running_total_not_a_window(shop):
    """It must keep climbing as new people read, with no window that could age
    a view out — that is what makes "N new views since you last looked" work
    from a client-side subtraction alone."""
    note_id = _make_note(shop)
    assert shop["author"]["client"].rpc("my_note_digest").execute().data[0]["views"] == 0

    shop["reader"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()
    assert shop["author"]["client"].rpc("my_note_digest").execute().data[0]["views"] == 1

    shop["reader2"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()
    assert shop["author"]["client"].rpc("my_note_digest").execute().data[0]["views"] == 2


# ── the durable subject, and the constraints protecting it ───────────────────


def test_durable_note_is_readable_without_touching_the_capturing_job(shop):
    """The whole point: a note written on job A is found by part + step alone."""
    note_id = _make_note(shop)

    found = (
        shop["reader"]["client"]
        .table("notes")
        .select("id")
        .eq("part_id", shop["part_id"])
        .eq("routing_operation_id", shop["routing_operation_id"])
        .execute()
        .data
    )
    assert [r["id"] for r in found] == [note_id]


def test_subject_check_rejects_a_mixed_subject(shop):
    with pytest.raises(Exception):
        shop["admin"].table("notes").insert(
            {
                "company_id": shop["company_id"],
                "subject_kind": "part",
                "part_id": shop["part_id"],
                "job_id": shop["job_a"],  # a part-subject note has no job
                "body": "mixed",
            }
        ).execute()


def test_subject_check_rejects_an_unknown_kind(shop):
    with pytest.raises(Exception):
        shop["admin"].table("notes").insert(
            {
                "company_id": shop["company_id"],
                "subject_kind": "sandwich",
                "part_id": shop["part_id"],
                "body": "nope",
            }
        ).execute()


def test_subject_must_belong_to_the_same_company(shop, supabase_admin):
    """A Postgres CHECK cannot span tables, so this is the trigger's job. The
    hole predates this work: a member of two companies could file a note under
    company A referencing company B's job."""
    other_company = (
        supabase_admin.table("companies")
        .insert({"name": f"nv-other-{os.urandom(3).hex()}"})
        .execute()
        .data[0]["id"]
    )
    other_part = (
        supabase_admin.table("parts")
        .insert(
            {
                "company_id": other_company,
                "part_name": "FOREIGN",
                "primary_unit": "ea",
            }
        )
        .execute()
        .data[0]["id"]
    )
    try:
        with pytest.raises(Exception) as exc:
            supabase_admin.table("notes").insert(
                {
                    "company_id": shop["company_id"],
                    "subject_kind": "part",
                    "part_id": other_part,
                    "body": "cross-tenant",
                }
            ).execute()
        assert "not in company" in str(exc.value)
    finally:
        supabase_admin.table("parts").delete().eq("company_id", other_company).execute()
        supabase_admin.table("companies").delete().eq("id", other_company).execute()


def test_note_survives_its_routing_step_being_deleted(shop):
    """Deleting a routing step must degrade the note to part-level, never destroy
    accumulated knowledge. This is why part_id is stored alongside the step."""
    note_id = _make_note(shop)
    shop["admin"].table("routing_operations").delete().eq(
        "id", shop["routing_operation_id"]
    ).execute()

    row = shop["admin"].table("notes").select("*").eq("id", note_id).single().execute().data
    assert row["routing_operation_id"] is None
    assert row["part_id"] == shop["part_id"]
    assert row["subject_kind"] == "part"


# ── drift and coverage invariants ────────────────────────────────────────────


def test_counters_never_drift_below_reality(supabase_admin):
    """One-sided by design: stored > live is expected (departed members), stored
    < live means the trigger failed."""
    rows = supabase_admin.rpc("note_count_anomalies", {}).execute().data
    assert rows == [], f"counter drift: {rows}"


def test_new_tables_are_gated_or_explicitly_exempt(supabase_admin):
    """Mirrors test_no_tenant_table_left_ungated — note_views and operator_events
    are SECURITY DEFINER-only writers, so they are exempt rather than gated."""
    rows = supabase_admin.rpc("tenant_tables_missing_write_gate", {}).execute().data
    assert rows == [], f"un-gated tenant tables: {rows}"


def test_read_log_is_not_granted_to_the_ai_sql_role(shop):
    """Regression guard for a grant that arrives by DEFAULT, not by anyone writing it.

    baseline.sql sets `ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES TO
    jigged_ai_readonly`, so every new public table is granted to the AI SQL role on
    creation. Both tables here therefore need an explicit REVOKE, and this test
    exists because reading the migration will not reveal the grant — only the
    database will. "Which operators read the setup notes?" must not be answerable.
    """
    leaks = shop["admin"].rpc("no_client_access_grant_leaks", {}).execute().data
    assert leaks == [], f"no-client-access tables are granted to: {leaks}"


# ── note_reactions: the voluntary half, and its policies ─────────────────────
# The UI hides the thumbs-up on your own notes and offers no negative option,
# but the UI is not the enforcement. These assert the database refuses on its
# own, because a future surface (an API client, a bulk import, a different
# screen) will not inherit the component's good manners.


def _react(client, shop, note_id, reactor_access_id, kind="helpful"):
    return (
        client.table("note_reactions")
        .insert(
            {
                "company_id": shop["company_id"],
                "note_id": note_id,
                "reactor_id": reactor_access_id,
                "kind": kind,
            }
        )
        .execute()
    )


def test_a_colleague_can_mark_a_note_helpful(shop):
    note_id = _make_note(shop)
    _react(shop["reader"]["client"], shop, note_id, shop["reader"]["access_id"])

    rows = (
        shop["author"]["client"]
        .table("note_reactions")
        .select("kind, reactor_id")
        .eq("note_id", note_id)
        .execute()
        .data
    )
    assert [r["kind"] for r in rows] == ["helpful"]


def test_you_cannot_endorse_your_own_note(shop):
    """Self-endorsement is noise, and the UI hides the control — but the policy
    is what actually refuses it."""
    note_id = _make_note(shop)
    with pytest.raises(Exception):
        _react(shop["author"]["client"], shop, note_id, shop["author"]["access_id"])


def test_you_cannot_react_as_someone_else(shop):
    """"Kurtis confirmed this" must not be expressible by anyone but Kurtis."""
    note_id = _make_note(shop)
    with pytest.raises(Exception):
        _react(
            shop["reader"]["client"], shop, note_id, shop["reader2"]["access_id"]
        )


def test_there_is_no_negative_reaction(shop):
    """Not a UI omission — the CHECK constraint has no slot for one. An
    inaccurate note is corrected or superseded, never publicly judged."""
    note_id = _make_note(shop)
    for kind in ("unhelpful", "disputed", "wrong"):
        with pytest.raises(Exception):
            _react(shop["reader"]["client"], shop, note_id, shop["reader"]["access_id"], kind)


def test_reacting_twice_is_blocked_by_the_unique_constraint(shop):
    note_id = _make_note(shop)
    _react(shop["reader"]["client"], shop, note_id, shop["reader"]["access_id"])
    with pytest.raises(Exception):
        _react(shop["reader"]["client"], shop, note_id, shop["reader"]["access_id"])


def test_an_admin_cannot_delete_someone_elses_reaction(shop):
    """A boss who can curate the public record of what the shop found useful is
    a worse problem than a stale reaction. The DELETE policy is scoped to the
    reactor, with no admin branch."""
    note_id = _make_note(shop)
    _react(shop["reader"]["client"], shop, note_id, shop["reader"]["access_id"])

    shop["boss"]["client"].table("note_reactions").delete().eq(
        "note_id", note_id
    ).execute()

    still_there = (
        shop["admin"]
        .table("note_reactions")
        .select("id")
        .eq("note_id", note_id)
        .execute()
        .data
    )
    assert len(still_there) == 1


def test_you_can_take_your_own_reaction_back(shop):
    note_id = _make_note(shop)
    _react(shop["reader"]["client"], shop, note_id, shop["reader"]["access_id"])

    shop["reader"]["client"].table("note_reactions").delete().eq(
        "note_id", note_id
    ).eq("reactor_id", shop["reader"]["access_id"]).execute()

    assert (
        shop["admin"]
        .table("note_reactions")
        .select("id")
        .eq("note_id", note_id)
        .execute()
        .data
        == []
    )


def test_a_reaction_can_never_be_edited(shop):
    """No UPDATE policy and no UPDATE grant, so 'helpful' cannot silently become
    'confirmed'. A reaction is created or removed, never amended."""
    note_id = _make_note(shop)
    _react(shop["reader"]["client"], shop, note_id, shop["reader"]["access_id"])

    with pytest.raises(Exception):
        shop["reader"]["client"].table("note_reactions").update(
            {"kind": "confirmed"}
        ).eq("note_id", note_id).execute()


def test_playbook_ranks_the_load_bearing_note_first(shop):
    """Newest-first buried the note that had actually been consulted. usage_count
    is behavioural — someone reached for it while doing the work — so it outranks
    both recency and an opinion offered afterwards."""
    # Both aged past the 14-day guard, and the VETERAN is the OLDER of the two —
    # so if ordering were still recency-based this would fail.
    veteran = _make_note(shop, "seat the bearings with the arbor fixture", days_ago=90)
    curiosity = _make_note(shop, "read this once, never again", days_ago=30)

    # The veteran is consulted on two jobs; the other on none.
    for job in (shop["job_a"], shop["job_b"]):
        shop["reader"]["client"].rpc(
            "log_note_views", {"p_note_ids": [veteran], "p_job_id": job}
        ).execute()

    rows = (
        shop["reader"]["client"]
        .rpc("part_playbook_notes", {"p_part_id": shop["part_id"]})
        .execute()
        .data
    )
    ids = [r["id"] for r in rows]
    assert ids.index(veteran) < ids.index(curiosity)


def test_a_fresh_note_is_never_buried_by_a_veteran(shop):
    """THE GUARD. Pure usefulness ranking sinks a correction written this morning
    below an old note with a long history — and on a shop floor the fresh warning
    is the one that must be seen. The original plan solved this with a 'confirmed'
    reaction and visual decay; both were dropped, so this carries it alone."""
    veteran = _make_note(shop, "the long-standing way we run this", days_ago=90)
    for job in (shop["job_a"], shop["job_b"]):
        shop["reader"]["client"].rpc(
            "log_note_views", {"p_note_ids": [veteran], "p_job_id": job}
        ).execute()

    # Written today, never consulted: usage_count 0. Usefulness alone would sink it.
    fresh = _make_note(shop, "FIXTURE CHANGED - the old arbor is scrapped")

    rows = (
        shop["reader"]["client"]
        .rpc("part_playbook_notes", {"p_part_id": shop["part_id"]})
        .execute()
        .data
    )
    ids = [r["id"] for r in rows]
    assert ids.index(fresh) < ids.index(veteran)


def test_helpful_breaks_a_usage_tie(shop):
    # Aged past the guard, and the ENDORSED one is older, so recency cannot be
    # what puts it first.
    b = _make_note(shop, "equally used, endorsed", days_ago=90)
    a = _make_note(shop, "equally used, unendorsed", days_ago=30)
    _react(shop["reader"]["client"], shop, b, shop["reader"]["access_id"])

    rows = (
        shop["reader"]["client"]
        .rpc("part_playbook_notes", {"p_part_id": shop["part_id"]})
        .execute()
        .data
    )
    ids = [r["id"] for r in rows]
    assert ids.index(b) < ids.index(a)


def test_playbook_reactions_say_who_reacted(shop):
    """THE BUG THIS EXISTS FOR. The array carried kind/name/created_at but not
    reactor_id, so a reader could never be found in it: the thumbs-up rendered
    un-pressed on a note they had already marked helpful, and a second tap just
    re-inserted a duplicate. The reaction was persisting the whole time — it
    simply could not be recognised as theirs. Component tests could not catch
    this: they are handed the array directly."""
    note_id = _make_note(shop)
    _react(shop["reader"]["client"], shop, note_id, shop["reader"]["access_id"])

    rows = (
        shop["reader"]["client"]
        .rpc("part_playbook_notes", {"p_part_id": shop["part_id"]})
        .execute()
        .data
    )
    reactions = next(r["reactions"] for r in rows if r["id"] == note_id)
    assert [x["reactor_id"] for x in reactions] == [shop["reader"]["access_id"]]


def test_digest_reports_helpful_as_well_as_views(shop):
    note_id = _make_note(shop)
    shop["reader"]["client"].rpc(
        "log_note_views", {"p_note_ids": [note_id], "p_job_id": shop["job_a"]}
    ).execute()
    _react(shop["reader2"]["client"], shop, note_id, shop["reader2"]["access_id"])

    row = shop["author"]["client"].rpc("my_note_digest").execute().data[0]
    assert row["views"] == 1
    assert row["helpful"] == 1


def test_digest_counts_only_the_callers_own_helpful(shop):
    note_id = _make_note(shop)
    _react(shop["reader"]["client"], shop, note_id, shop["reader"]["access_id"])

    row = shop["reader2"]["client"].rpc("my_note_digest").execute().data[0]
    assert row["helpful"] == 0


def test_playbook_returns_author_id_so_the_ui_can_hide_the_control(shop):
    """Without it the reaction UI cannot tell whose note it is, and every tap on
    your own note would be a guaranteed 42501 that reads as a broken button.
    Matching on author_name instead breaks on two people with the same name."""
    _make_note(shop)
    rows = (
        shop["reader"]["client"]
        .rpc("part_playbook_notes", {"p_part_id": shop["part_id"]})
        .execute()
        .data
    )
    assert rows and rows[0]["author_id"] == shop["author"]["access_id"]


# ── machine maintenance: the machine subject, and derived open state ─────────
#
# See docs/modules/machine-maintenance.md. The point of these is that the module
# stores NO "open" flag: an observation is open exactly while no entry resolves
# it. That only holds if the database guarantees a resolver always sits on the
# same machine as its target, because the read derives open-ness from a single
# work-center result set and would silently mis-report if a resolver could live
# anywhere else. So the invariant is the trigger's job, and these are the tests
# that say so.


def _machine_note(shop, body: str, kind: str | None = None, resolves: str | None = None) -> str:
    row = {
        "company_id": shop["company_id"],
        "subject_kind": "work_center",
        "work_center_id": shop["work_center_id"],
        "author_id": shop["author"]["access_id"],
        "body": body,
    }
    if kind is not None:
        row["maintenance_kind"] = kind
    if resolves is not None:
        row["resolves_note_id"] = resolves
    return shop["admin"].table("notes").insert(row).execute().data[0]["id"]


def test_a_machine_entry_can_be_written_at_all(shop):
    """The work_center subject has been modelled since the notes rewrite and
    nothing has ever written one. This is the first row that does."""
    note_id = _machine_note(shop, "Way cover has started to drag.", kind="noticed")

    row = shop["admin"].table("notes").select("*").eq("id", note_id).single().execute().data
    assert row["subject_kind"] == "work_center"
    assert row["work_center_id"] == shop["work_center_id"]
    assert row["maintenance_kind"] == "noticed"
    assert row["job_id"] is None and row["part_id"] is None


def test_kind_is_optional(shop):
    """An unclassified entry is still knowledge. A forced taxonomy at capture
    time is what stops capture, so the column has to accept nothing."""
    note_id = _machine_note(shop, "Topped up the way lube.")
    row = shop["admin"].table("notes").select("maintenance_kind").eq("id", note_id).single().execute().data
    assert row["maintenance_kind"] is None


def test_kind_is_limited_to_the_five_verbs(shop):
    with pytest.raises(Exception):
        _machine_note(shop, "x", kind="lubricated")


def test_a_part_note_cannot_carry_a_maintenance_kind(shop):
    with pytest.raises(Exception):
        shop["admin"].table("notes").insert(
            {
                "company_id": shop["company_id"],
                "subject_kind": "part",
                "part_id": shop["part_id"],
                "body": "x",
                "maintenance_kind": "cleaned",
            }
        ).execute()


def test_open_is_derived_from_the_absence_of_a_resolver(shop):
    """The whole open-items model in one test. Nothing is written to close an
    item — a second entry is added, and the first stops being open because of it."""
    observation = _machine_note(shop, "Coolant smells off.", kind="noticed")

    def resolvers_of(note_id: str) -> list[dict]:
        return (
            shop["admin"].table("notes").select("id").eq("resolves_note_id", note_id).execute().data
        )

    assert resolvers_of(observation) == []

    fix = _machine_note(shop, "Drained and recharged the coolant.", kind="repaired", resolves=observation)
    assert [r["id"] for r in resolvers_of(observation)] == [fix]


def test_deleting_the_fix_reopens_the_observation(shop):
    """ON DELETE SET NULL, not CASCADE: removing the record of a fix must not
    remove the observation, and the item legitimately becomes open again."""
    observation = _machine_note(shop, "Chip conveyor jams on long runs.", kind="noticed")
    fix = _machine_note(shop, "Cleared the jam and re-tensioned.", resolves=observation)

    shop["admin"].table("notes").delete().eq("id", fix).execute()

    still_there = shop["admin"].table("notes").select("id").eq("id", observation).execute().data
    assert len(still_there) == 1
    assert (
        shop["admin"].table("notes").select("id").eq("resolves_note_id", observation).execute().data
        == []
    )


def test_a_fix_cannot_point_at_an_entry_on_another_machine(shop):
    """If this were allowed the open list would be wrong rather than merely
    incomplete: the resolver would never appear in the target machine's result
    set, so the item would read as open forever while a fix existed elsewhere."""
    observation = _machine_note(shop, "Spindle runs warm.", kind="noticed")
    other_wc = (
        shop["admin"]
        .table("work_centers")
        .insert({"company_id": shop["company_id"], "name": f"LATHE-{os.urandom(2).hex()}"})
        .execute()
        .data[0]["id"]
    )
    with pytest.raises(Exception):
        shop["admin"].table("notes").insert(
            {
                "company_id": shop["company_id"],
                "subject_kind": "work_center",
                "work_center_id": other_wc,
                "body": "fixed it (on the wrong machine)",
                "resolves_note_id": observation,
            }
        ).execute()


def test_a_fix_cannot_point_at_an_entry_that_was_never_noticed(shop):
    routine = _machine_note(shop, "Wiped it down.", kind="cleaned")
    with pytest.raises(Exception):
        _machine_note(shop, "resolving a non-problem", resolves=routine)


def test_a_fix_cannot_point_at_a_note_in_another_company(shop, supabase_admin):
    """And the refusal must not say WHY. The validator is SECURITY DEFINER, so it
    reads past RLS; a message that distinguished "no such note" from "different
    company" would be a cross-tenant existence oracle."""
    other_company = (
        supabase_admin.table("companies")
        .insert({"name": f"mm-other-{os.urandom(3).hex()}"})
        .execute()
        .data[0]["id"]
    )
    try:
        other_wc = (
            supabase_admin.table("work_centers")
            .insert({"company_id": other_company, "name": "FOREIGN MILL"})
            .execute()
            .data[0]["id"]
        )
        foreign = (
            supabase_admin.table("notes")
            .insert(
                {
                    "company_id": other_company,
                    "subject_kind": "work_center",
                    "work_center_id": other_wc,
                    "body": "their problem",
                    "maintenance_kind": "noticed",
                }
            )
            .execute()
            .data[0]["id"]
        )

        with pytest.raises(Exception) as exc:
            _machine_note(shop, "resolving someone else's machine", resolves=foreign)
        assert "not an open observation on this machine" in str(exc.value)

        # Same message for a uuid that does not exist at all — the two cases are
        # indistinguishable from outside, which is the point.
        with pytest.raises(Exception) as exc2:
            _machine_note(shop, "resolving nothing", resolves="99999999-9999-9999-9999-999999999999")
        assert "not an open observation on this machine" in str(exc2.value)
    finally:
        supabase_admin.table("notes").delete().eq("company_id", other_company).execute()
        supabase_admin.table("work_centers").delete().eq("company_id", other_company).execute()
        supabase_admin.table("companies").delete().eq("id", other_company).execute()


def test_a_machine_entry_still_cannot_carry_another_subject(shop):
    with pytest.raises(Exception):
        shop["admin"].table("notes").insert(
            {
                "company_id": shop["company_id"],
                "subject_kind": "work_center",
                "work_center_id": shop["work_center_id"],
                "part_id": shop["part_id"],
                "body": "two subjects",
            }
        ).execute()


def test_a_machine_read_never_counts_toward_usage(shop):
    """usage_count counts DISTINCT JOBS a note was consulted on, and a machine
    read has no job. §8 of the module doc states this stays zero permanently and
    must never be displayed there — this is what pins it."""
    note_id = _machine_note(shop, "Grease points are behind the rear panel.")
    shop["reader"]["client"].rpc("log_note_views", {"p_note_ids": [note_id]}).execute()

    viewer_count, usage_count = _counts(shop, note_id)
    assert viewer_count == 1
    assert usage_count == 0
