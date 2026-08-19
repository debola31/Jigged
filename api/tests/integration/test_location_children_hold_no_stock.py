"""A place with sub-locations holds no stock — 20260806160053.

WHAT THIS GUARDS. If Cabinet 1-A is just Side 1 and Side 2, nobody ever means "put it in the
cabinet". Until 20260806160053 every layer allowed it: no picker filtered parents, no RPC checked,
and nothing in the schema said otherwise. Two constraint triggers now close both directions —
stock may only land on a leaf, and a location holding stock may not gain children.

WHY THIS USES psycopg2 RATHER THAN THE SUPABASE CLIENT. One test here cannot be written through
PostgREST at all. PostgREST runs one transaction per request, and the defect below needs two
transactions open at once:

    T1 inserts children under Cabinet 1-A, uncommitted. T2 inserts stock at Cabinet 1-A; its
    EXISTS cannot see T1's uncommitted children, so it passes. T1's deferred check fires at its
    own commit, cannot see T2's uncommitted stock row, so it passes. Both commit. A parent now
    holds stock and NOTHING RAISED.

That is textbook write skew, and it is why both trigger bodies take conflicting row locks
(FOR SHARE on the stock side, FOR UPDATE on the structural side) before their EXISTS. Deferral does
not help — a deferred trigger takes a fresh snapshot at commit, which still excludes an uncommitted
transaction — and Postgres only detects write skew at SERIALIZABLE, which nothing here runs at.

`test_concurrent_*` are therefore the tests that matter most in this file: **a version of the
triggers with the row locks removed passes every other test here and fails only those two.** If you
are tempted to simplify the locks away, delete them and watch.

The RPC tests set `request.jwt.claims` and `SET ROLE authenticated` to reproduce exactly what
PostgREST does per request, so they exercise the real EXECUTE grant and the real membership check
rather than running as a superuser that would pass either way.

Requires a local Supabase with all migrations applied. Skipped without it.
"""
from __future__ import annotations

import json
import os
import threading
import uuid
from contextlib import contextmanager

import psycopg2
import pytest
from psycopg2 import errors

pytestmark = pytest.mark.integration

# The Supabase CLI's fixed local port. Overridable for CI, and skipped rather than failed when
# nothing is listening — same posture as the rest of this directory.
DB_URL = os.getenv(
    "TEST_SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)


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
    """A company with: an empty container, a stocked leaf, a bare leaf, and the system pile.

    `is_demo` so `company_can_write()` is true without a billing row — otherwise the billing gate
    could mask the result a test is trying to assert.
    """
    company = str(uuid.uuid4())
    user = str(uuid.uuid4())
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO companies (id, name, is_demo) VALUES (%s, %s, true)",
            (company, f"Container Test {company[:8]}"),
        )
        # A real auth user, so get_user_company_ids() resolves for the RPC tests.
        cur.execute(
            """
            INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                                    email_confirmed_at, created_at, updated_at)
            VALUES (%s, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                    %s, '', now(), now(), now())
            """,
            (user, f"container-{company[:8]}@test.jigged.local"),
        )
        cur.execute(
            "INSERT INTO user_company_access (user_id, company_id, role) VALUES (%s, %s, 'admin')",
            (user, company),
        )
        cur.execute("SELECT inv_get_or_create_unassigned(%s)", (company,))
        unassigned = cur.fetchone()[0]

        def location(name, parent=None):
            cur.execute(
                "INSERT INTO inventory_locations (company_id, parent_id, name) "
                "VALUES (%s, %s, %s) RETURNING id",
                (company, parent, name),
            )
            return cur.fetchone()[0]

        container = location("Cabinet 1-A")
        side_one = location("Side 1", container)
        stocked = location("Shelf X")
        bare = location("Yard")

        # quantity 0 at creation so seed_new_part_balance seeds nothing; the placement is then
        # explicit. parts.quantity is a rollup, so it becomes 100 by trigger.
        cur.execute(
            """
            INSERT INTO parts (company_id, part_name, source, primary_unit, quantity)
            VALUES (%s, %s, 'bought', 'each', 0) RETURNING id
            """,
            (company, f"CONTAINER-{company[:8]}"),
        )
        part = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO part_location_stock (company_id, part_id, location_id, quantity) "
            "VALUES (%s, %s, %s, 100)",
            (company, part, stocked),
        )

    yield {
        "company": company,
        "user": user,
        "container": container,
        "side_one": side_one,
        "stocked": stocked,
        "bare": bare,
        "unassigned": unassigned,
        "part": part,
    }

    with db.cursor() as cur:
        cur.execute("DELETE FROM part_location_stock WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM inventory_transactions WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM parts WHERE company_id = %s", (company,))
        cur.execute(
            "DELETE FROM inventory_locations WHERE company_id = %s AND parent_id IS NOT NULL",
            (company,),
        )
        cur.execute("DELETE FROM inventory_locations WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM companies WHERE id = %s", (company,))
        cur.execute("DELETE FROM auth.users WHERE id = %s", (user,))


def _as_user(cur, user_id: str):
    """Reproduce what PostgREST does per request: claims, then the browser role.

    Both settings are transaction-local, so this only works on a connection with autocommit OFF —
    on an autocommit connection `set_config(..., true)` expires with the statement that set it and
    `get_user_company_ids()` silently resolves to nothing. Use `user_session` rather than calling
    this against the shared `db` fixture.
    """
    cur.execute(
        "SELECT set_config('request.jwt.claims', %s, true)",
        (json.dumps({"sub": user_id, "role": "authenticated"}),),
    )
    cur.execute("SET LOCAL ROLE authenticated")


@contextmanager
def user_session(user_id: str):
    """A transactional connection acting as `user_id`, the way a browser request would.

    The caller commits; leaving it uncommitted is what the deferred-check test needs.
    """
    conn = _connect()  # autocommit stays off: the transaction IS the point
    try:
        with conn.cursor() as cur:
            _as_user(cur, user_id)
            yield conn, cur
    finally:
        conn.close()


# ── Direction (a): stock may only land on a leaf ──────────────────────────────


def test_stock_cannot_be_written_to_a_container(db, shop):
    with pytest.raises(errors.CheckViolation, match="sub-locations"):
        with db.cursor() as cur:
            cur.execute(
                "INSERT INTO part_location_stock (company_id, part_id, location_id, quantity) "
                "VALUES (%s, %s, %s, 5)",
                (shop["company"], shop["part"], shop["container"]),
            )


def test_stock_on_a_leaf_still_works(db, shop):
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO part_location_stock (company_id, part_id, location_id, quantity) "
            "VALUES (%s, %s, %s, 5)",
            (shop["company"], shop["part"], shop["bare"]),
        )
        cur.execute(
            "SELECT quantity FROM part_location_stock WHERE location_id = %s", (shop["bare"],)
        )
        assert cur.fetchone()[0] == 5


# ── Direction (b): a stocked location may not gain children ───────────────────


def test_child_cannot_be_added_under_a_stocked_location(db, shop):
    with pytest.raises(errors.CheckViolation, match="holds stock"):
        with db.cursor() as cur:
            cur.execute(
                "INSERT INTO inventory_locations (company_id, parent_id, name) VALUES (%s, %s, %s)",
                (shop["company"], shop["stocked"], "Bin 1"),
            )


def test_location_cannot_be_reparented_into_a_stocked_location(db, shop):
    with pytest.raises(errors.CheckViolation, match="holds stock"):
        with db.cursor() as cur:
            cur.execute(
                "UPDATE inventory_locations SET parent_id = %s WHERE id = %s",
                (shop["stocked"], shop["bare"]),
            )


def test_the_put_away_pile_can_never_be_divided(db, shop):
    """`Unassigned` is where the importer and auto-track put homeless stock. Children would make it
    unwritable and strand them, so it is refused even while empty."""
    with pytest.raises(errors.CheckViolation, match="put-away pile"):
        with db.cursor() as cur:
            cur.execute(
                "INSERT INTO inventory_locations (company_id, parent_id, name) VALUES (%s, %s, %s)",
                (shop["company"], shop["unassigned"], "Nope"),
            )


def test_child_under_an_empty_container_still_works(db, shop):
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO inventory_locations (company_id, parent_id, name) "
            "VALUES (%s, %s, %s) RETURNING id",
            (shop["company"], shop["container"], "Side 2"),
        )
        assert cur.fetchone()[0]


# ── Concurrency: the pair only holds because the locks conflict ───────────────


def _blocked_insert(url: str, sql: str, params: tuple, sink: list, opened: list):
    """Run one statement on its own connection, leaving the transaction open.

    The connection is handed to `opened` BEFORE the statement runs, so the test can close it even
    when this thread is still blocked or has left a transaction open. Skipping that leaks an `idle
    in transaction` backend holding row locks, and the fixture teardown's DELETE then blocks
    forever — which is exactly how this file first hung.
    """
    conn = psycopg2.connect(url)
    opened.append(conn)
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params)
        sink.append(("ok", None))
    except Exception as exc:  # noqa: BLE001 - the exception IS the assertion
        sink.append(("raised", exc))


@pytest.mark.parametrize("commit_first", ["structure", "stock"])
def test_concurrent_subdivide_and_stock_cannot_both_win(db, shop, commit_first):
    """Two transactions, one bin. Whichever commits second must raise.

    Without the row locks in the trigger bodies BOTH commit and the invariant breaks silently —
    which is the entire reason those locks exist. This is the test that proves it.
    """
    target = shop["bare"]  # empty leaf: legal for either move, in isolation
    add_child = (
        "INSERT INTO inventory_locations (company_id, parent_id, name) VALUES (%s, %s, %s)",
        (shop["company"], target, "Late Bin"),
    )
    add_stock = (
        "INSERT INTO part_location_stock (company_id, part_id, location_id, quantity) "
        "VALUES (%s, %s, %s, 7)",
        (shop["company"], shop["part"], target),
    )
    first, second = (add_child, add_stock) if commit_first == "structure" else (add_stock, add_child)

    winner = psycopg2.connect(DB_URL)
    sink: list = []
    opened: list = []
    loser = threading.Thread(
        target=_blocked_insert, args=(DB_URL, second[0], second[1], sink, opened)
    )
    try:
        with winner.cursor() as cur:
            cur.execute(*first)  # takes its row lock; does not commit yet

        loser.start()
        loser.join(timeout=3)

        # The lock pair is what makes this true. Without it the second statement returns
        # immediately, having seen nothing, and this is the assertion that fails.
        assert loser.is_alive(), "second transaction did not block — the row locks do not conflict"

        winner.commit()
        loser.join(timeout=15)
        assert not loser.is_alive(), "second transaction never unblocked"

        assert sink, "second transaction produced no outcome"
        outcome, payload = sink[0]
        assert outcome == "raised", "second transaction was allowed to break the invariant"
        assert isinstance(payload, errors.CheckViolation)
    finally:
        winner.rollback()
        winner.close()
        # Unblocks the loser if it is still waiting on the lock, then closes it either way —
        # otherwise a failed assertion strands an open transaction and hangs teardown.
        loser.join(timeout=15)
        for conn in opened:
            conn.close()


# ── apply_location_layout: the one caller allowed through the illegal state ───
#
# Was `subdivide_location`, dropped in 20260815192344. A reshape is a strict superset of a
# subdivide — all-creates plus moves — and keeping both would have left two browser-callable
# SECURITY DEFINER functions permitted to defer this invariant. These three cases move across
# unchanged in what they assert; only the call does. The rest of the reshape surface (the parking
# pass, removals, the partition rule) lives in `test_apply_location_layout.py`.


def test_subdivide_moves_the_stock_down_and_commits(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        cur.execute(
            "SELECT id, name FROM apply_location_layout(%s, %s::jsonb, %s::jsonb)",
            (
                shop["stocked"],
                json.dumps(
                    [
                        {"ref": "a", "parent_ref": None, "name": "Bin 1", "sort_order": 0},
                        {"ref": "b", "parent_ref": None, "name": "Bin 2", "sort_order": 1},
                    ]
                ),
                json.dumps(
                    [
                        {
                            "part_id": shop["part"],
                            "from_location_id": shop["stocked"],
                            "to_ref": "a",
                            "quantity": 60,
                            "unit": "each",
                            "converted_quantity": 60,
                        },
                        {
                            "part_id": shop["part"],
                            "from_location_id": shop["stocked"],
                            "to_ref": "b",
                            "quantity": 40,
                            "unit": "each",
                            "converted_quantity": 40,
                        },
                    ]
                ),
            ),
        )
        created = {name: loc_id for loc_id, name in cur.fetchall()}
        conn.commit()  # the deferred check runs here, and must pass

    # The RPC returns the whole subtree, the unit included — after a flatten the unit is the only
    # location left, so it cannot be omitted.
    assert set(created) == {"Shelf X", "Bin 1", "Bin 2"}

    with db.cursor() as cur:
        cur.execute(
            "SELECT location_id, quantity FROM part_location_stock WHERE part_id = %s",
            (shop["part"],),
        )
        balances = dict(cur.fetchall())
        # The parent kept nothing — that is the invariant, checked at COMMIT.
        assert shop["stocked"] not in balances
        assert balances[created["Bin 1"]] == 60
        assert balances[created["Bin 2"]] == 40

        # The rollup is untouched: this moved stock, it did not create or destroy any.
        cur.execute("SELECT quantity FROM parts WHERE id = %s", (shop["part"],))
        assert cur.fetchone()[0] == 100

        # Delegating to transfer_stock means a normal paired ledger, not a bespoke one.
        cur.execute(
            "SELECT count(*), count(DISTINCT transfer_group_id) FROM inventory_transactions "
            "WHERE part_id = %s",
            (shop["part"],),
        )
        assert cur.fetchone() == (4, 2)


def test_subdivide_with_an_incomplete_distribution_rolls_everything_back(db, shop):
    """Leaving stock behind on the new parent must take the sub-locations down with it.

    The check is deferred, so the RPC itself returns happily and the failure lands at COMMIT. What
    matters is that nothing survives — a half-applied subdivide would leave a container holding
    stock, which is the state this whole migration exists to make unreachable.
    """
    with user_session(shop["user"]) as (conn, cur):
        cur.execute(
            "SELECT id FROM apply_location_layout(%s, %s::jsonb, %s::jsonb)",
            (
                shop["stocked"],
                json.dumps([{"ref": "a", "parent_ref": None, "name": "Bin 1"}]),
                json.dumps(
                    [
                        {
                            "part_id": shop["part"],
                            "from_location_id": shop["stocked"],
                            "to_ref": "a",
                            "quantity": 60,  # 40 left behind on the parent
                            "unit": "each",
                            "converted_quantity": 60,
                        }
                    ]
                ),
            ),
        )
        assert cur.fetchone(), "the RPC should succeed; the deferred check fires at COMMIT"

        with pytest.raises(errors.CheckViolation, match="sub-locations"):
            conn.commit()
        conn.rollback()

    with db.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM inventory_locations WHERE parent_id = %s", (shop["stocked"],)
        )
        assert cur.fetchone()[0] == 0, "the sub-locations survived a rolled-back subdivide"
        cur.execute(
            "SELECT quantity FROM part_location_stock WHERE location_id = %s", (shop["stocked"],)
        )
        assert cur.fetchone()[0] == 100


def test_subdivide_is_refused_to_a_non_member(db, shop):
    """SECURITY DEFINER bypasses RLS, so the membership check inside the body is the only tenant
    boundary this RPC has."""
    outsider = str(uuid.uuid4())
    with db.cursor() as cur:
        cur.execute(
            """
            INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                                    email_confirmed_at, created_at, updated_at)
            VALUES (%s, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                    %s, '', now(), now(), now())
            """,
            (outsider, f"outsider-{outsider[:8]}@test.jigged.local"),
        )
    try:
        with pytest.raises(errors.InsufficientPrivilege, match="access denied"):
            with user_session(outsider) as (_conn, cur):
                cur.execute(
                    "SELECT id FROM apply_location_layout(%s, %s::jsonb)",
                    (
                        shop["container"],
                        json.dumps([{"ref": "a", "parent_ref": None, "name": "Side 2"}]),
                    ),
                )
    finally:
        with db.cursor() as cur:
            cur.execute("DELETE FROM auth.users WHERE id = %s", (outsider,))
