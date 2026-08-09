"""The jobs-list search cap applies AFTER every filter, in a meaningful order — 20260809001523.

WHAT THIS GUARDS (#688). `search_jobs_by_identifier` has always capped its output, because the
caller sends the matching ids back through a PostgREST `.in()` URL and that URL has a hard ceiling
(see JOB_SEARCH_LIMIT in lib/queryLimits.ts). The cap is not the defect. Three things about it were:

  1. `ORDER BY m.job_id` existed only to serve `DISTINCT ON`. It is not a ranking, so the rows that
     survived LIMIT were whichever UUIDs happened to sort first — not the newest, not the most
     relevant.
  2. The status / customer / overdue filters were applied by the CALLER, on the main query, AFTER
     the cap. So the filters cut into an already-arbitrary subset: search a customer with 300 jobs
     and the open ones on screen were whichever open ones survived a random cut.
  3. `deleted_at` was never filtered here, so archived jobs consumed cap slots and were then thrown
     away by the caller — making (2) worse.

WHY THIS IS A PYTHON INTEGRATION TEST. The behaviour only appears above the cap, and
`supabase/seed.sql` has single-digit job counts — it can never trigger it, which is exactly why the
bug survived preview branches and was only reasoned about, never observed. Seeding hundreds of jobs into
`seed.sql` to fix that would slow every `db reset` and pollute the demo company for a property that
is about scale, not fixtures. So these tests create their own rows and clean them up.

The RLS test sets `request.jwt.claims` and `SET ROLE authenticated` to reproduce what PostgREST does
per request, so it exercises the real EXECUTE grant and the real membership check rather than
running as a superuser that would pass either way. That matters here because the DROP + CREATE in
this migration rebuilt the function's ACL from scratch.

Requires a local Postgres with all migrations applied. Skipped without it. From a git worktree the
shared Supabase stack will NOT have this migration — point TEST_SUPABASE_DB_URL at a throwaway
replay DB instead (docs/runbooks/local-dev-and-testing.md).
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import date, timedelta

import psycopg2
import pytest

pytestmark = pytest.mark.integration

DB_URL = os.getenv(
    "TEST_SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)

# Above the function's own 200 hard ceiling, so both the caller's cap and the clamp
# are observable.
JOB_COUNT = 250
# The value the frontend actually sends (JOB_SEARCH_LIMIT in lib/queryLimits.ts).
LIMIT = 120
# Every job's number contains this, so one query matches the whole fixture.
MARKER = "SEARCHCAP"


def _connect():
    try:
        return psycopg2.connect(DB_URL)
    except psycopg2.OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"No local Postgres at {DB_URL}: {exc}")


@pytest.fixture
def db():
    conn = _connect()
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture
def shop(db):
    """A company with JOB_COUNT matching jobs, spread across statuses, plus archived decoys.

    Job i is created i days ago, so "newest" is unambiguous and testable. `is_demo` so
    `company_can_write()` is true without a billing row.
    """
    company = str(uuid.uuid4())
    user = str(uuid.uuid4())
    today = date.today()

    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO companies (id, name, is_demo) VALUES (%s, %s, true)",
            (company, f"Search Cap {company[:8]}"),
        )
        cur.execute(
            """
            INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                                    email_confirmed_at, created_at, updated_at)
            VALUES (%s, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                    %s, '', now(), now(), now())
            """,
            (user, f"searchcap-{company[:8]}@test.jigged.local"),
        )
        cur.execute(
            "INSERT INTO user_company_access (user_id, company_id, role) VALUES (%s, %s, 'admin')",
            (user, company),
        )
        cur.execute(
            "INSERT INTO customers (company_id, name) VALUES (%s, %s) RETURNING id",
            (company, f"Big Account {company[:8]}"),
        )
        big_customer = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO customers (company_id, name) VALUES (%s, %s) RETURNING id",
            (company, f"Small Account {company[:8]}"),
        )
        small_customer = cur.fetchone()[0]

        # Statuses cycle so every lifecycle stage is represented, and the overwhelming
        # majority are closed — the shape of a real customer's history, and the reason
        # a cap applied before the status filter was so damaging.
        combos = [
            ("completed", "fully_shipped"),   # closed
            ("completed", "fully_shipped"),   # closed
            ("cancelled", "unshipped"),       # closed
            ("not_started", "unshipped"),     # open
            ("in_progress", "unshipped"),     # open
        ]
        ids = []
        for i in range(JOB_COUNT):
            production, fulfillment = combos[i % len(combos)]
            cur.execute(
                """
                INSERT INTO jobs (company_id, customer_id, job_number, production_status,
                                  fulfillment_status, is_hot, due_date, created_at)
                VALUES (%s, %s, %s, %s, %s, false, %s, now() - (%s || ' days')::interval)
                RETURNING id
                """,
                (
                    company,
                    big_customer if i % 10 else small_customer,
                    f"{MARKER}-{i:04d}",
                    production,
                    fulfillment,
                    today - timedelta(days=1) if production == "not_started" else None,
                    i,
                ),
            )
            ids.append(cur.fetchone()[0])

        # Archived decoys. They must not consume cap slots and must not be counted.
        archived = []
        for i in range(10):
            cur.execute(
                """
                INSERT INTO jobs (company_id, customer_id, job_number, production_status,
                                  fulfillment_status, deleted_at)
                VALUES (%s, %s, %s, 'not_started', 'unshipped', now())
                RETURNING id
                """,
                (company, big_customer, f"{MARKER}-ARCH-{i:02d}"),
            )
            archived.append(cur.fetchone()[0])

    yield {
        "company": company,
        "user": user,
        "big_customer": big_customer,
        "small_customer": small_customer,
        "ids": ids,
        "archived": archived,
    }

    with db.cursor() as cur:
        cur.execute("DELETE FROM shipment_line_items WHERE shipment_id IN "
                    "(SELECT id FROM shipments WHERE company_id = %s)", (company,))
        cur.execute("DELETE FROM shipments WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM job_parts WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM parts WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM jobs WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM customers WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM user_company_access WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM companies WHERE id = %s", (company,))
        cur.execute("DELETE FROM auth.users WHERE id = %s", (user,))


def search(db, company, query=MARKER, *, pairs=None, customer=None, overdue=False,
           today=None, limit=LIMIT):
    with db.cursor() as cur:
        cur.execute(
            "SELECT job_id, match_source, total_matches "
            "FROM search_jobs_by_identifier(%s, %s, %s, %s, %s, %s, %s)",
            (company, query, pairs, customer, overdue, today or date.today(), limit),
        )
        return cur.fetchall()


def job_numbers(db, rows):
    """Resolve returned ids to job numbers, preserving the RPC's row order."""
    ids = [r[0] for r in rows]
    if not ids:
        return []
    with db.cursor() as cur:
        cur.execute("SELECT id, job_number FROM jobs WHERE id = ANY(%s::uuid[])", (ids,))
        by_id = dict(cur.fetchall())
    return [by_id[i] for i in ids]


# --------------------------------------------------------------------------------------
# The cap itself
# --------------------------------------------------------------------------------------

def test_caps_rows_but_reports_the_true_total(db, shop):
    """The list is cut; the count is not. This is what lets the UI say "120 of 150"."""
    rows = search(db, shop["company"])
    assert len(rows) == LIMIT
    # Constant across every row, and it is the pre-cap count.
    assert {r[2] for r in rows} == {JOB_COUNT}


def test_keeps_the_newest_rows_not_a_uuid_lottery(db, shop):
    """Job i was created i days ago, so the newest LIMIT jobs are 0000..0119."""
    rows = search(db, shop["company"])
    numbers = job_numbers(db, rows)
    assert numbers == [f"{MARKER}-{i:04d}" for i in range(LIMIT)]


def test_hot_jobs_survive_the_cap_even_when_old(db, shop):
    """A rush job is the one row a shop cannot afford to have silently cut."""
    oldest = f"{MARKER}-{JOB_COUNT - 1:04d}"
    with db.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET is_hot = true WHERE company_id = %s AND job_number = %s",
            (shop["company"], oldest),
        )
    numbers = job_numbers(db, search(db, shop["company"]))
    assert numbers[0] == oldest


def test_clamps_the_limit_to_the_url_ceiling(db, shop):
    """No caller can talk the function past what a PostgREST .in() URL can carry."""
    assert len(search(db, shop["company"], limit=100_000)) == 200
    # And a nonsense low limit clamps up rather than erroring out a search box.
    assert len(search(db, shop["company"], limit=0)) == 1
    assert len(search(db, shop["company"], limit=None)) == 100


# --------------------------------------------------------------------------------------
# Filters apply BEFORE the cap — the ordering-of-operations fix
# --------------------------------------------------------------------------------------

def test_archived_jobs_are_neither_returned_nor_counted(db, shop):
    """They used to consume cap slots and then be discarded by the caller."""
    rows = search(db, shop["company"])
    assert rows[0][2] == JOB_COUNT  # not JOB_COUNT + 10
    assert not set(r[0] for r in rows) & set(shop["archived"])


def test_stage_pairs_narrow_before_the_cap(db, shop):
    """The defect in one assertion: 30 open jobs must all come back, and count as 30.

    Before the fix the cap took 100 arbitrary jobs first — mostly closed, since a real
    history is mostly closed — and the caller then filtered those down to whatever
    handful of open ones happened to survive.
    """
    open_pairs = ["not_started:unshipped", "in_progress:unshipped"]
    rows = search(db, shop["company"], pairs=open_pairs)
    expected = sum(1 for i in range(JOB_COUNT) if i % 5 in (3, 4))
    assert len(rows) == expected
    assert rows[0][2] == expected
    numbers = set(job_numbers(db, rows))
    assert numbers == {f"{MARKER}-{i:04d}" for i in range(JOB_COUNT) if i % 5 in (3, 4)}


def test_empty_stage_pairs_match_nothing(db, shop):
    """"The user ticked no statuses" is a real answer, not "don't narrow"."""
    assert search(db, shop["company"], pairs=[]) == []


def test_null_stage_pairs_mean_no_narrowing(db, shop):
    assert search(db, shop["company"], pairs=None)[0][2] == JOB_COUNT


def test_customer_narrows_before_the_cap(db, shop):
    rows = search(db, shop["company"], customer=shop["small_customer"])
    expected = sum(1 for i in range(JOB_COUNT) if i % 10 == 0)
    assert len(rows) == expected
    assert rows[0][2] == expected


def test_overdue_narrows_before_the_cap_on_the_callers_local_date(db, shop):
    """p_today drives the boundary, so the SQL agrees with the client's local midnight."""
    rows = search(db, shop["company"], overdue=True)
    # Only the not_started jobs carry a due date, and it is yesterday.
    expected = sum(1 for i in range(JOB_COUNT) if i % 5 == 3)
    assert len(rows) == expected

    # Rewind "today" past those due dates and they stop being overdue — proving the
    # parameter is what's consulted, not current_date.
    assert search(db, shop["company"], overdue=True, today=date.today() - timedelta(days=5)) == []

    # An omitted date falls back to the server's today rather than silently
    # reporting that nothing is overdue (`due_date < NULL` is NULL).
    assert len(search(db, shop["company"], overdue=True, today=None)) == expected


def test_filters_compose(db, shop):
    rows = search(
        db,
        shop["company"],
        pairs=["not_started:unshipped"],
        customer=shop["small_customer"],
    )
    expected = sum(1 for i in range(JOB_COUNT) if i % 5 == 3 and i % 10 == 0)
    assert len(rows) == expected
    assert all(r[2] == expected for r in rows)


# --------------------------------------------------------------------------------------
# Behaviour that must NOT have changed
# --------------------------------------------------------------------------------------

def test_blank_query_returns_nothing(db, shop):
    assert search(db, shop["company"], query="   ") == []
    assert search(db, shop["company"], query=None) == []


def test_wildcards_in_the_query_are_escaped_not_interpreted(db, shop):
    """'%' must match a literal percent sign, not every job."""
    assert search(db, shop["company"], query="%") == []


def test_match_source_still_reports_which_field_matched(db, shop):
    rows = search(db, shop["company"], query=f"{MARKER}-0001")
    assert [r[1] for r in rows] == ["job_number"]

    rows = search(db, shop["company"], query="Big Account")
    assert rows and {r[1] for r in rows} == {"customer"}


def test_voided_shipments_do_not_match_by_packing_slip(db, shop):
    """Regression guard on pre-existing behaviour the rewrite had to preserve."""
    company, job = shop["company"], shop["ids"][0]
    slip = f"PS-{company[:8]}"
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO parts (company_id, part_name, source, primary_unit) "
            "VALUES (%s, %s, 'made', 'each') RETURNING id",
            (company, f"SLIPPART-{company[:8]}"),
        )
        part = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO job_parts (company_id, job_id, part_id, sequence, quantity, "
            "production_status, fulfillment_status) "
            "VALUES (%s, %s, %s, 1, 1, 'not_started', 'unshipped') RETURNING id",
            (company, job, part),
        )
        job_part = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO shipments (company_id, customer_id, job_id, packing_slip_number, voided_at)
            SELECT %s, j.customer_id, j.id, %s, now() FROM jobs j WHERE j.id = %s
            RETURNING id
            """,
            (company, slip, job),
        )
        shipment = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO shipment_line_items (shipment_id, job_part_id, quantity) "
            "VALUES (%s, %s, 1)",
            (shipment, job_part),
        )

    assert search(db, company, query=slip) == []

    with db.cursor() as cur:
        cur.execute("UPDATE shipments SET voided_at = NULL WHERE id = %s", (shipment,))
    rows = search(db, company, query=slip)
    assert [r[1] for r in rows] == ["packing_slip"]


# --------------------------------------------------------------------------------------
# The DROP + CREATE rebuilt the ACL, so re-prove tenancy end to end
# --------------------------------------------------------------------------------------

def test_a_member_can_execute_it_as_the_browser_role(db, shop):
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT set_config('request.jwt.claims', %s, true)",
                (json.dumps({"sub": shop["user"], "role": "authenticated"}),),
            )
            cur.execute("SET LOCAL ROLE authenticated")
            cur.execute(
                "SELECT count(*) FROM search_jobs_by_identifier(%s, %s, NULL, NULL, false, %s, %s)",
                (shop["company"], MARKER, date.today(), LIMIT),
            )
            assert cur.fetchone()[0] == LIMIT
        conn.rollback()
    finally:
        conn.close()


def test_a_non_member_sees_nothing_because_it_is_security_invoker(db, shop):
    """p_company_id is a narrowing filter, never the security boundary — RLS is."""
    stranger = str(uuid.uuid4())
    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT set_config('request.jwt.claims', %s, true)",
                (json.dumps({"sub": stranger, "role": "authenticated"}),),
            )
            cur.execute("SET LOCAL ROLE authenticated")
            cur.execute(
                "SELECT count(*) FROM search_jobs_by_identifier(%s, %s, NULL, NULL, false, %s, %s)",
                (shop["company"], MARKER, date.today(), LIMIT),
            )
            assert cur.fetchone()[0] == 0
        conn.rollback()
    finally:
        conn.close()


def test_anon_may_not_execute_it_at_all(db):
    """The baseline granted anon EXECUTE; this migration deliberately does not."""
    with db.cursor() as cur:
        cur.execute(
            "SELECT has_function_privilege('anon', "
            "'public.search_jobs_by_identifier(uuid, text, text[], uuid, boolean, date, integer)', "
            "'EXECUTE')"
        )
        assert cur.fetchone()[0] is False
