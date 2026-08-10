"""`create_location_tree` builds a whole storage unit in one transaction — 20260810142715 (#618).

WHAT THIS GUARDS. `materializeLocationSpec` used to insert node-by-node in an awaited loop. A
12 x 15 cabinet was 240 sequential round trips — slow enough on an old office computer that the
shop owner concluded the app had frozen — and a failure halfway left every node created before it:
a partial tree, no rollback, an opaque error. The atomicity is the feature, so it is what these
tests pin. A version of the RPC that inserted correctly but did not roll back would pass a request
count assertion in the frontend suite and fail only here.

WHY A SEPARATE FUNCTION AND NOT A WIDER `subdivide_location`. That one derives company_id from the
parent row, so it cannot express a ROOT create. Adding a p_company_id would change its arity, and
CREATE OR REPLACE at a new arity makes an OVERLOAD rather than a replacement — the trap
20260731235450 already sprang in this module ("is not unique (SQLSTATE 42725) ... which is
precisely what `supabase db reset` produced on the first attempt, from seed.sql").

Runs as `authenticated` with real JWT claims, the way PostgREST does per request, so the EXECUTE
grant, `get_user_company_ids()` and the billing gate are all genuinely exercised rather than
bypassed by a superuser connection.

Requires a local Supabase with all migrations applied. Skipped without it.
"""
from __future__ import annotations

import json
import os
import uuid
from contextlib import contextmanager

import psycopg2
import pytest
from psycopg2 import errors

pytestmark = pytest.mark.integration

DB_URL = os.getenv(
    "TEST_SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)


def _connect():
    try:
        return psycopg2.connect(DB_URL)
    except psycopg2.OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"No local Postgres at {DB_URL}: {exc}")


def _as_user(cur, user_id: str) -> None:
    """Reproduce a PostgREST request: the JWT claim, then the role."""
    cur.execute(
        "SELECT set_config('request.jwt.claims', %s, true)",
        (json.dumps({"sub": user_id, "role": "authenticated"}),),
    )
    cur.execute("SET ROLE authenticated")


@contextmanager
def user_session(user_id: str):
    """A transactional connection acting as `user_id`, the way a browser request would.

    Autocommit stays OFF, and that is not incidental: `set_config(..., true)` is
    TRANSACTION-local, so on an autocommit connection the JWT claim is discarded before the next
    statement runs and `get_user_company_ids()` returns nothing — every call then fails "access
    denied" regardless of who the caller is. The sibling container/bin file keeps its own session
    helper for the same reason.

    Separate from the superuser `db` fixture so `SET ROLE authenticated` cannot leak into fixture
    teardown, where RLS would then deny the cleanup.
    """
    conn = _connect()
    try:
        with conn.cursor() as cur:
            _as_user(cur, user_id)
            yield cur
        conn.commit()
    finally:
        conn.close()


@pytest.fixture
def db():
    conn = _connect()
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture
def shop(db):
    """A company with one empty container, plus a second company to test tenancy against.

    `is_demo` so `company_can_write()` is true without a billing row — otherwise the billing gate
    would mask what a test is actually asserting.
    """
    company = str(uuid.uuid4())
    other = str(uuid.uuid4())
    user = str(uuid.uuid4())
    with db.cursor() as cur:
        for cid, label in ((company, "Tree Test"), (other, "Tree Other")):
            cur.execute(
                "INSERT INTO companies (id, name, is_demo) VALUES (%s, %s, true)",
                (cid, f"{label} {cid[:8]}"),
            )
        cur.execute(
            """
            INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                                    email_confirmed_at, created_at, updated_at)
            VALUES (%s, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                    %s, '', now(), now(), now())
            """,
            (user, f"tree-{company[:8]}@test.jigged.local"),
        )
        # Member of the first company only — `other` is what a cross-tenant attempt reaches for.
        cur.execute(
            "INSERT INTO user_company_access (user_id, company_id, role) VALUES (%s, %s, 'admin')",
            (user, company),
        )
        cur.execute(
            "INSERT INTO inventory_locations (company_id, parent_id, name) "
            "VALUES (%s, NULL, 'Cabinet 1') RETURNING id",
            (company,),
        )
        cabinet = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO inventory_locations (company_id, parent_id, name) "
            "VALUES (%s, NULL, 'Their Cabinet') RETURNING id",
            (other,),
        )
        foreign_cabinet = cur.fetchone()[0]

    yield {
        "company": company,
        "other": other,
        "user": user,
        "cabinet": cabinet,
        "foreign_cabinet": foreign_cabinet,
    }

    with db.cursor() as cur:
        for cid in (company, other):
            cur.execute(
                "DELETE FROM inventory_locations WHERE company_id = %s AND parent_id IS NOT NULL",
                (cid,),
            )
            # Two passes: a three-level tree has grandchildren pointing at children.
            cur.execute(
                "DELETE FROM inventory_locations WHERE company_id = %s AND parent_id IS NOT NULL",
                (cid,),
            )
            cur.execute("DELETE FROM inventory_locations WHERE company_id = %s", (cid,))
            cur.execute("DELETE FROM companies WHERE id = %s", (cid,))
        cur.execute("DELETE FROM auth.users WHERE id = %s", (user,))


def _call(cur, company, nodes, parent=None):
    cur.execute(
        "SELECT id, name, parent_id, sort_order FROM create_location_tree(%s, %s::jsonb, %s)",
        (company, json.dumps(nodes), parent),
    )
    return cur.fetchall()


def _grid(rows: int, cols: int):
    """The shape the shop actually built: rows of bins, flat, parent before child."""
    nodes = []
    for r in range(rows):
        nodes.append(
            {"ref": f"r{r}", "parent_ref": None, "name": f"Row {r + 1}", "kind": "row",
             "sort_order": r}
        )
        for c in range(cols):
            nodes.append(
                {"ref": f"r{r}c{c}", "parent_ref": f"r{r}", "name": f"Bin {c + 1}",
                 "kind": "bin", "sort_order": c}
            )
    return nodes


# ── The thing it exists for ───────────────────────────────────────────────────


def test_builds_a_whole_cabinet_in_one_call(db, shop):
    """12 x 15 = 180 bins plus 12 rows, in a single statement."""
    with user_session(shop["user"]) as cur:
        created = _call(cur, shop["company"], _grid(12, 15), shop["cabinet"])

    assert len(created) == 192
    rows = [r for r in created if r[2] == shop["cabinet"]]
    assert len(rows) == 12
    # Every bin hangs off a row this same call created — not off the cabinet, and not off nothing.
    row_ids = {r[0] for r in rows}
    bins = [r for r in created if r[0] not in row_ids]
    assert len(bins) == 180
    assert all(b[2] in row_ids for b in bins)


def test_a_failure_partway_leaves_nothing_behind(db, shop):
    """The whole reason for the RPC: the old loop left a partial tree with no way back.

    A duplicate sibling name inside the payload trips the unique index on a LATER node, so the
    earlier inserts in the same statement must roll back with it.
    """
    nodes = [
        {"ref": "a", "parent_ref": None, "name": "Row 1", "kind": "row", "sort_order": 0},
        {"ref": "b", "parent_ref": None, "name": "Row 2", "kind": "row", "sort_order": 1},
        {"ref": "c", "parent_ref": None, "name": "Row 1", "kind": "row", "sort_order": 2},
    ]
    with user_session(shop["user"]) as cur:
        with pytest.raises(errors.UniqueViolation):
            _call(cur, shop["company"], nodes, shop["cabinet"])

    with db.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM inventory_locations WHERE parent_id = %s", (shop["cabinet"],)
        )
        assert cur.fetchone()[0] == 0, "Row 2 survived a failed run — the old partial-tree bug"


def test_creates_a_root_level_unit(db, shop):
    """The case `subdivide_location` cannot express, because it derives company from the parent."""
    nodes = [{"ref": "u", "parent_ref": None, "name": "New Shelf", "kind": None, "sort_order": 0}]
    with user_session(shop["user"]) as cur:
        created = _call(cur, shop["company"], nodes)

    assert len(created) == 1
    assert created[0][2] is None


# ── The node contract ─────────────────────────────────────────────────────────


def test_refuses_a_forward_reference_rather_than_guessing(db, shop):
    """Silently rooting a node in the wrong place is unrecoverable, so it raises instead."""
    nodes = [
        {"ref": "child", "parent_ref": "parent", "name": "Bin 1", "kind": "bin", "sort_order": 0},
        {"ref": "parent", "parent_ref": None, "name": "Row 1", "kind": "row", "sort_order": 0},
    ]
    with user_session(shop["user"]) as cur:
        with pytest.raises(errors.CheckViolation, match="parent before child"):
            _call(cur, shop["company"], nodes, shop["cabinet"])


def test_refuses_a_node_with_no_ref(db, shop):
    with user_session(shop["user"]) as cur:
        with pytest.raises(errors.CheckViolation, match="needs a ref"):
            _call(cur, shop["company"], [{"parent_ref": None, "name": "Row 1"}], shop["cabinet"])


def test_refuses_an_empty_payload(db, shop):
    with user_session(shop["user"]) as cur:
        with pytest.raises(errors.CheckViolation, match="Nothing to create"):
            _call(cur, shop["company"], [], shop["cabinet"])


def test_caps_the_node_count(db, shop):
    """A lock bound, not a payload bound — every inserted row holds one for the transaction.

    Enforced in the RPC rather than the UI so no caller, present or future, can break the
    atomicity guarantee by looping.
    """
    nodes = [
        {"ref": f"n{i}", "parent_ref": None, "name": f"Row {i}", "kind": "row", "sort_order": i}
        for i in range(1001)
    ]
    with user_session(shop["user"]) as cur:
        with pytest.raises(errors.CheckViolation, match="Too many places"):
            _call(cur, shop["company"], nodes, shop["cabinet"])


# ── Tenancy ───────────────────────────────────────────────────────────────────


def test_refuses_a_company_the_caller_does_not_belong_to(db, shop):
    nodes = [{"ref": "a", "parent_ref": None, "name": "Row 1", "kind": "row", "sort_order": 0}]
    with user_session(shop["user"]) as cur:
        with pytest.raises(errors.InsufficientPrivilege, match="access denied"):
            _call(cur, shop["other"], nodes)


def test_refuses_a_parent_belonging_to_another_company(db, shop):
    """The company here is the caller's own claim, not something derived from the parent row.

    So the pairing has to be checked: otherwise a member of company A could pass their own company
    id with company B's cabinet and graft a subtree into another shop's storage.
    """
    nodes = [{"ref": "a", "parent_ref": None, "name": "Row 1", "kind": "row", "sort_order": 0}]
    with user_session(shop["user"]) as cur:
        with pytest.raises(psycopg2.Error):
            _call(cur, shop["company"], nodes, shop["foreign_cabinet"])

    with db.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM inventory_locations WHERE parent_id = %s",
            (shop["foreign_cabinet"],),
        )
        assert cur.fetchone()[0] == 0


# ── It does NOT get subdivide_location's privileges ───────────────────────────


def test_refuses_to_give_children_to_a_place_holding_stock(db, shop):
    """`subdivide_location` defers the container/bin check because it must pass through the
    illegal intermediate state — create the children, then move the stock down. This one has no
    move step, so it keeps the check IMMEDIATE and is simply refused. A future edit that copied
    the deferral across without copying the moves would break the invariant silently, so it is
    worth asserting the absence.
    """
    with db.cursor() as cur:
        cur.execute(
            """
            INSERT INTO parts (company_id, part_name, source, is_stocked, primary_unit, quantity)
            VALUES (%s, %s, 'bought', true, 'each', 0) RETURNING id
            """,
            (shop["company"], f"TREE-{shop['company'][:8]}"),
        )
        part = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO part_location_stock (company_id, part_id, location_id, quantity) "
            "VALUES (%s, %s, %s, 5)",
            (shop["company"], part, shop["cabinet"]),
        )

    nodes = [{"ref": "a", "parent_ref": None, "name": "Row 1", "kind": "row", "sort_order": 0}]
    with user_session(shop["user"]) as cur:
        with pytest.raises(errors.CheckViolation, match="holds stock"):
            _call(cur, shop["company"], nodes, shop["cabinet"])

    with db.cursor() as cur:
        cur.execute("DELETE FROM part_location_stock WHERE company_id = %s", (shop["company"],))
        cur.execute("DELETE FROM inventory_transactions WHERE company_id = %s", (shop["company"],))
        cur.execute("DELETE FROM parts WHERE id = %s", (part,))
