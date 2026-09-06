"""`apply_location_layout` reshapes a storage unit in one transaction — 20260815192344.

WHAT THIS GUARDS. `Change layout` was the create wizard pointed at an existing unit: every path out
of it ended in an INSERT-ONLY RPC, and the client passed the unit's real sibling names so the
generated ones continued *past* them. Asking a five-row cabinet for three rows produced eight, and
the confirm button read `Create 8 places`. The label promised a change; no code path could express
one.

Three things here cannot be tested anywhere else, and each is the reason a whole section of the
migration exists:

  * **The parking pass.** `inventory_locations_unique_sibling_name` is a UNIQUE *INDEX* on the
    EXPRESSION `lower(btrim(name))`, so it is not deferrable and cannot be made deferrable
    (ADD CONSTRAINT UNIQUE takes no expressions). Postgres checks a unique index per TUPLE, so
    `Row 1` <-> `Row 2` fails even as one UPDATE. `test_swapping_two_names_in_one_call` fails
    without section 4 of the migration and passes with it. A frontend test cannot see this at all.
  * **The deferral**, inherited from `subdivide_location`: a surviving leaf that gains children
    passes through a state `location_children_hold_no_stock` refuses at statement time.
  * **Rollback**, including that no location is left wearing a parked name. A half-applied reshape
    can already have deleted bins, which is strictly worse than the partial tree #618 was about.

Runs as `authenticated` with real JWT claims, the way PostgREST does per request, so the EXECUTE
grant, `get_user_company_ids()` and the billing gate are genuinely exercised rather than bypassed by
a superuser connection.

Requires a local Supabase with all migrations applied. Skipped without it.
"""
from __future__ import annotations

import json
import os
import threading
import time
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
    cur.execute(
        "SELECT set_config('request.jwt.claims', %s, true)",
        (json.dumps({"sub": user_id, "role": "authenticated"}),),
    )
    cur.execute("SET LOCAL ROLE authenticated")


@contextmanager
def user_session(user_id: str):
    """A transactional connection acting as `user_id`. The caller commits.

    Autocommit stays OFF: `set_config(..., true)` is transaction-local, so on an autocommit
    connection the claim expires with the statement that set it and `get_user_company_ids()`
    silently resolves to nothing. Leaving the commit to the caller is what the deferred-check and
    concurrency tests need.
    """
    conn = _connect()
    try:
        with conn.cursor() as cur:
            _as_user(cur, user_id)
            yield conn, cur
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
    """A company owning `Cabinet 3` = Row 1, Row 2, Row 3 (bare leaves), plus a second company.

    `is_demo` so `company_can_write()` is true without a billing row — otherwise the billing gate
    would mask what a test is actually asserting.
    """
    company = str(uuid.uuid4())
    other = str(uuid.uuid4())
    user = str(uuid.uuid4())
    with db.cursor() as cur:
        for cid, label in ((company, "Reshape Test"), (other, "Reshape Other")):
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
            (user, f"reshape-{company[:8]}@test.jigged.local"),
        )
        cur.execute(
            "INSERT INTO user_company_access (user_id, company_id, role) VALUES (%s, %s, 'admin')",
            (user, company),
        )
        cur.execute("SELECT inv_get_or_create_unassigned(%s)", (company,))
        unassigned = cur.fetchone()[0]

        def location(name, parent=None, sort_order=0, cid=company):
            cur.execute(
                "INSERT INTO inventory_locations (company_id, parent_id, name, sort_order) "
                "VALUES (%s, %s, %s, %s) RETURNING id",
                (cid, parent, name, sort_order),
            )
            return cur.fetchone()[0]

        cabinet = location("Cabinet 3")
        rows = [location(f"Row {i + 1}", cabinet, i) for i in range(3)]
        foreign_cabinet = location("Their Cabinet", None, 0, other)

        # quantity 0 at creation so seed_new_part_balance seeds nothing; placement is explicit.
        cur.execute(
            """
            INSERT INTO parts (company_id, part_name, source, primary_unit, quantity)
            VALUES (%s, %s, 'bought', 'each', 0) RETURNING id
            """,
            (company, f"RESHAPE-{company[:8]}"),
        )
        part = cur.fetchone()[0]

    yield {
        "company": company,
        "other": other,
        "user": user,
        "cabinet": cabinet,
        "rows": rows,
        "foreign_cabinet": foreign_cabinet,
        "unassigned": unassigned,
        "part": part,
    }

    with db.cursor() as cur:
        for cid in (company, other):
            cur.execute("DELETE FROM part_location_stock WHERE company_id = %s", (cid,))
            cur.execute("DELETE FROM inventory_transactions WHERE company_id = %s", (cid,))
            # Before the parts: `material_lots.part_id` is ON DELETE RESTRICT on purpose — a lot is
            # the evidence trail for material that has shipped, so a hard delete of the part must
            # not silently take the proof with it. Nothing in the app hard-deletes a part (they
            # archive), so the constraint only ever bites a fixture like this one.
            cur.execute("DELETE FROM material_lots WHERE company_id = %s", (cid,))
            cur.execute("DELETE FROM parts WHERE company_id = %s", (cid,))
            # Three passes: the deepest tree a test builds is cabinet › row › bin.
            for _ in range(3):
                cur.execute(
                    "DELETE FROM inventory_locations WHERE company_id = %s AND parent_id IS NOT NULL"
                    " AND NOT EXISTS (SELECT 1 FROM inventory_locations c"
                    "                 WHERE c.parent_id = inventory_locations.id)",
                    (cid,),
                )
            cur.execute("DELETE FROM inventory_locations WHERE company_id = %s", (cid,))
            cur.execute("DELETE FROM companies WHERE id = %s", (cid,))
        cur.execute("DELETE FROM auth.users WHERE id = %s", (user,))


# ── Payload helpers ──────────────────────────────────────────────────────────


def keep(location_id, name, sort_order, parent_ref=None):
    """A node that already exists. `id:` is what tells a rename from a remove-then-create."""
    return {
        "ref": f"id:{location_id}",
        "parent_ref": parent_ref,
        "name": name,
        "kind": None,
        "sort_order": sort_order,
    }


def create(ref, name, sort_order, parent_ref=None):
    return {"ref": ref, "parent_ref": parent_ref, "name": name, "kind": None,
            "sort_order": sort_order}


def move(part, from_id, to_ref, qty, unit="each"):
    return {"part_id": part, "from_location_id": from_id, "to_ref": to_ref,
            "quantity": qty, "unit": unit, "converted_quantity": qty}


def apply_layout(cur, parent, nodes, moves=None, removals=None):
    cur.execute(
        "SELECT id, name, parent_id, sort_order FROM apply_location_layout("
        "  %s, %s::jsonb, %s::jsonb, %s::uuid[])",
        (parent, json.dumps(nodes), json.dumps(moves or []), removals or []),
    )
    return cur.fetchall()


def stock_at(db, location_id, part):
    with db.cursor() as cur:
        cur.execute(
            "SELECT quantity FROM part_location_stock WHERE location_id = %s AND part_id = %s",
            (location_id, part),
        )
        row = cur.fetchone()
    return row[0] if row else None


def names_under(db, parent):
    with db.cursor() as cur:
        cur.execute(
            "SELECT name FROM inventory_locations WHERE parent_id = %s ORDER BY sort_order",
            (parent,),
        )
        return [r[0] for r in cur.fetchall()]


def place_stock(shop, location_id, qty):
    """Through the real RPC, so the ledger rows a reshape later has to move actually exist.

    Its own `user_session`, NOT the autocommit `db` fixture: the JWT claim is transaction-local, so
    on an autocommit connection it expires with the statement that set it and every RPC then
    reports "access denied" regardless of who is calling.
    """
    with user_session(shop["user"]) as (conn, cur):
        cur.execute(
            "SELECT add_stock_at_location(%s, %s, %s, 'each', %s)",
            (shop["part"], location_id, qty, qty),
        )
        conn.commit()


# ── The thing it exists for ──────────────────────────────────────────────────


def test_shrinking_removes_the_surplus_rather_than_appending(db, shop):
    """THE BUG. Three real rows, asked for two: the third goes, and 1-2 keep their ids."""
    r1, r2, r3 = shop["rows"]
    with user_session(shop["user"]) as (conn, cur):
        apply_layout(
            cur, shop["cabinet"],
            [keep(r1, "Row 1", 0), keep(r2, "Row 2", 1)],
            removals=[r3],
        )
        conn.commit()

    assert names_under(db, shop["cabinet"]) == ["Row 1", "Row 2"]
    with db.cursor() as cur:
        cur.execute("SELECT count(*) FROM inventory_locations WHERE id = %s", (r3,))
        assert cur.fetchone()[0] == 0
        # The survivors are the SAME rows — a printed QR label still resolves.
        cur.execute(
            "SELECT count(*) FROM inventory_locations WHERE id = ANY(%s::uuid[])", ([r1, r2],)
        )
        assert cur.fetchone()[0] == 2


def test_swapping_two_names_in_one_call(db, shop):
    """Fails without the parking pass, and there is no ordering of updates that would save it.

    The sibling-name index is an EXPRESSION index, so it is not deferrable and cannot be made so;
    Postgres also checks a unique index per tuple, so a single multi-row UPDATE fails identically.
    """
    r1, r2, r3 = shop["rows"]
    with user_session(shop["user"]) as (conn, cur):
        apply_layout(
            cur, shop["cabinet"],
            [keep(r1, "Row 2", 0), keep(r2, "Row 1", 1), keep(r3, "Row 3", 2)],
        )
        conn.commit()

    assert names_under(db, shop["cabinet"]) == ["Row 2", "Row 1", "Row 3"]


def test_stock_moves_out_of_a_removed_row_into_the_survivor(db, shop):
    r1, r2, r3 = shop["rows"]
    place_stock(shop, r3, 10)

    with user_session(shop["user"]) as (conn, cur):
        apply_layout(
            cur, shop["cabinet"],
            [keep(r1, "Row 1", 0), keep(r2, "Row 2", 1)],
            moves=[move(shop["part"], r3, f"id:{r1}", 10)],
            removals=[r3],
        )
        conn.commit()

    assert stock_at(db, r1, shop["part"]) == 10
    # The rollup is untouched: this moved stock, it did not create or destroy any.
    with db.cursor() as cur:
        cur.execute("SELECT quantity FROM parts WHERE id = %s", (shop["part"],))
        assert cur.fetchone()[0] == 10
        # Delegated to transfer_stock, so the ledger is a paired transfer like any other movement.
        cur.execute(
            "SELECT type, transfer_group_id FROM inventory_transactions "
            "WHERE part_id = %s AND transfer_group_id IS NOT NULL ORDER BY type",
            (shop["part"],),
        )
        ledger = cur.fetchall()
    assert [r[0] for r in ledger] == ["addition", "depletion"]
    assert ledger[0][1] == ledger[1][1]


def test_the_ledger_records_the_shelf_the_stock_actually_left(db, shop):
    """The parking sentinel must never reach `inventory_transactions`.

    `transfer_stock` reads the SOURCE's name for its note, and `location_name` is snapshotted and
    then immutable — so parking a bin before moving its stock out wrote `Transfer from
    ~reshaping~<uuid>` into history permanently. Parking is reversible inside the transaction; the
    history it poisons on the way past is not. Found by reading the operator's activity feed after
    a real reshape, which is the only place it was visible.
    """
    r1, _, r3 = shop["rows"]
    place_stock(shop, r3, 7)

    with user_session(shop["user"]) as (conn, cur):
        apply_layout(
            cur, shop["cabinet"],
            [keep(r1, "Row 1", 0), keep(shop["rows"][1], "Row 2", 1)],
            moves=[move(shop["part"], r3, f"id:{r1}", 7)],
            removals=[r3],
        )
        conn.commit()

    with db.cursor() as cur:
        cur.execute(
            "SELECT notes, location_name FROM inventory_transactions "
            "WHERE part_id = %s AND transfer_group_id IS NOT NULL",
            (shop["part"],),
        )
        rows = cur.fetchall()
    assert rows, "the move wrote no ledger rows"
    blob = " ".join(f"{n} {ln}" for n, ln in rows)
    assert "~reshaping~" not in blob, blob
    assert "Row 3" in blob, blob


def test_a_loaded_leaf_can_gain_children_and_its_stock_moves_down(db, shop):
    """The deferral, inherited from subdivide_location. Illegal at statement time, legal at COMMIT."""
    r1, _, _ = shop["rows"]
    place_stock(shop, r1, 8)

    with user_session(shop["user"]) as (conn, cur):
        apply_layout(
            cur, shop["cabinet"],
            [
                keep(r1, "Row 1", 0),
                create("new:l", "Left", 0, f"id:{r1}"),
                create("new:r", "Right", 1, f"id:{r1}"),
                keep(shop["rows"][1], "Row 2", 1),
                keep(shop["rows"][2], "Row 3", 2),
            ],
            moves=[move(shop["part"], r1, "new:l", 8)],
        )
        conn.commit()

    assert names_under(db, r1) == ["Left", "Right"]
    with db.cursor() as cur:
        cur.execute("SELECT id FROM inventory_locations WHERE parent_id = %s AND name = 'Left'", (r1,))
        left = cur.fetchone()[0]
    assert stock_at(db, left, shop["part"]) == 8
    # The container holds no balance row at all — transfer_stock deletes an emptied source
    # (20260802144310), which is what lets direction (b)'s EXISTS check pass at COMMIT.
    assert stock_at(db, r1, shop["part"]) is None


def test_a_unit_can_flatten_to_one_location_and_keep_its_stock(db, shop):
    """`to_ref: 'parent'` — the unit itself receives what its bins were holding."""
    r1, r2, r3 = shop["rows"]
    place_stock(shop, r2, 6)

    with user_session(shop["user"]) as (conn, cur):
        apply_layout(
            cur, shop["cabinet"], [],
            moves=[move(shop["part"], r2, "parent", 6)],
            removals=[r1, r2, r3],
        )
        conn.commit()

    assert names_under(db, shop["cabinet"]) == []
    assert stock_at(db, shop["cabinet"], shop["part"]) == 6


# ── Rollback ─────────────────────────────────────────────────────────────────


def test_removing_a_row_that_still_holds_stock_rolls_everything_back(db, shop):
    """And names the location, because 'subtree still holds stock' does not say which shelf."""
    r1, r2, r3 = shop["rows"]
    place_stock(shop, r3, 4)

    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.ForeignKeyViolation) as exc:
            apply_layout(
                cur, shop["cabinet"],
                [keep(r1, "Shelf A", 0), keep(r2, "Shelf B", 1)],
                removals=[r3],  # no moves: its stock has nowhere to go
            )
        conn.rollback()
    assert "Row 3" in str(exc.value)

    # Nothing applied — including the two renames that come BEFORE the removal in the body.
    assert names_under(db, shop["cabinet"]) == ["Row 1", "Row 2", "Row 3"]
    assert stock_at(db, r3, shop["part"]) == 4


def test_a_failed_reshape_leaves_no_location_wearing_a_parked_name(db, shop):
    """The parking pass is only safe because it cannot outlive the transaction.

    A browser that renamed `Row 1` to a sentinel and then died would leave a location literally
    called that on a shop's shelf. This is the assertion that keeps parking inside the RPC.
    """
    r1, r2, r3 = shop["rows"]
    place_stock(shop, r3, 2)

    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(psycopg2.Error):
            apply_layout(
                cur, shop["cabinet"],
                [keep(r1, "Row 2", 0), keep(r2, "Row 1", 1)],
                removals=[r3],
            )
        conn.rollback()

    with db.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM inventory_locations WHERE name LIKE '~reshaping~%%'"
        )
        assert cur.fetchone()[0] == 0


def test_an_incomplete_distribution_dies_at_commit(db, shop):
    """Moving only part of a subdivided leaf's stock leaves a container holding some.

    The deferred check fires at COMMIT, after every insert and transfer has already succeeded —
    deferring is not skipping.
    """
    r1, _, _ = shop["rows"]
    place_stock(shop, r1, 10)

    with user_session(shop["user"]) as (conn, cur):
        apply_layout(
            cur, shop["cabinet"],
            [
                keep(r1, "Row 1", 0),
                create("new:l", "Left", 0, f"id:{r1}"),
                keep(shop["rows"][1], "Row 2", 1),
                keep(shop["rows"][2], "Row 3", 2),
            ],
            moves=[move(shop["part"], r1, "new:l", 4)],  # 6 left behind
        )
        with pytest.raises(psycopg2.Error):
            conn.commit()

    assert names_under(db, r1) == []
    assert stock_at(db, r1, shop["part"]) == 10


# ── The partition, and tenancy ───────────────────────────────────────────────


def test_a_descendant_named_in_neither_list_is_refused(db, shop):
    """The failure this prevents is silent: an orphan under a parent that no longer exists."""
    r1, r2, r3 = shop["rows"]
    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.CheckViolation) as exc:
            apply_layout(cur, shop["cabinet"], [keep(r1, "Row 1", 0), keep(r2, "Row 2", 1)])
        conn.rollback()
    assert "neither kept nor removed" in str(exc.value)


def test_a_location_cannot_be_both_kept_and_removed(db, shop):
    r1, r2, r3 = shop["rows"]
    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.CheckViolation) as exc:
            apply_layout(
                cur, shop["cabinet"],
                [keep(r1, "Row 1", 0), keep(r2, "Row 2", 1), keep(r3, "Row 3", 2)],
                removals=[r3],
            )
        conn.rollback()
    assert "both kept and removed" in str(exc.value)


def test_a_ref_naming_a_location_outside_the_unit_is_refused(db, shop):
    """Otherwise a member could rename any location in the company by grafting its id in."""
    r1, r2, r3 = shop["rows"]
    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.CheckViolation) as exc:
            apply_layout(
                cur, shop["cabinet"],
                [keep(r1, "Row 1", 0), keep(r2, "Row 2", 1), keep(r3, "Row 3", 2),
                 keep(shop["unassigned"], "Hijacked", 3)],
            )
        conn.rollback()
    assert "not inside this unit" in str(exc.value)

    with db.cursor() as cur:
        cur.execute("SELECT name FROM inventory_locations WHERE id = %s", (shop["unassigned"],))
        assert cur.fetchone()[0] == "Unassigned"


def test_a_duplicate_sibling_name_reads_as_a_sentence(db, shop):
    """Folded the way the expression index folds it, so `row 1 ` collides with `Row 1`."""
    r1, r2, r3 = shop["rows"]
    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.UniqueViolation) as exc:
            apply_layout(
                cur, shop["cabinet"],
                [keep(r1, "Row 1", 0), keep(r2, "  row 1 ", 1), keep(r3, "Row 3", 2)],
            )
        conn.rollback()
    assert "both called" in str(exc.value)


def test_the_put_away_pile_has_no_layout_to_change(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.CheckViolation) as exc:
            apply_layout(cur, shop["unassigned"], [create("new:a", "Left", 0)])
        conn.rollback()
    assert "no layout to change" in str(exc.value)


def test_a_non_member_cannot_reshape_a_foreign_cabinet(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.InsufficientPrivilege):
            apply_layout(cur, shop["foreign_cabinet"], [create("new:a", "Row 1", 0)])
        conn.rollback()

    assert names_under(db, shop["foreign_cabinet"]) == []


def test_an_empty_change_is_refused(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.CheckViolation):
            apply_layout(cur, shop["cabinet"], [])
        conn.rollback()


def test_the_node_cap_is_enforced_in_the_rpc(db, shop):
    """A LOCK bound, not a payload bound — so no caller can break atomicity by looping."""
    r1, r2, r3 = shop["rows"]
    nodes = [keep(r1, "Row 1", 0), keep(r2, "Row 2", 1), keep(r3, "Row 3", 2)]
    nodes += [create(f"new:{i}", f"Bin {i}", i, f"id:{r1}") for i in range(1000)]
    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.CheckViolation) as exc:
            apply_layout(cur, shop["cabinet"], nodes)
        conn.rollback()
    assert "smaller sections" in str(exc.value)


# ── Concurrency ──────────────────────────────────────────────────────────────


def test_a_reshape_and_a_concurrent_stock_write_cannot_both_win(db, shop):
    """The subtree-wide FOR UPDATE, which is wider than subdivide_location's single-row lock.

    A reshape deleting a bin, against an operator putting something in it. Without the lock both
    transactions see a consistent-but-stale world — no children here, no stock there — and commit,
    leaving stock pointing at a location that no longer exists. FOR UPDATE conflicts with the
    FOR SHARE `assert_stock_location_is_a_leaf` takes, so the second one to reach its lock blocks.
    """
    r1, r2, r3 = shop["rows"]
    outcome = {}

    def add_stock():
        with user_session(shop["user"]) as (conn, cur):
            try:
                cur.execute(
                    "SELECT add_stock_at_location(%s, %s, 5, 'each', 5)",
                    (shop["part"], r3),
                )
                conn.commit()
                outcome["stock"] = "committed"
            except psycopg2.Error as exc:
                conn.rollback()
                outcome["stock"] = f"failed: {type(exc).__name__}"

    with user_session(shop["user"]) as (conn, cur):
        # Takes the subtree lock, then holds it while the other thread tries to write into r3.
        apply_layout(
            cur, shop["cabinet"],
            [keep(r1, "Row 1", 0), keep(r2, "Row 2", 1)],
            removals=[r3],
        )

        writer = threading.Thread(target=add_stock)
        writer.start()
        time.sleep(0.5)
        # The writer must still be blocked on the lock — if it had gone through, the two would
        # have raced instead of queueing.
        assert writer.is_alive(), "the stock write was not blocked by the reshape's lock"

        conn.commit()
        writer.join(timeout=10)

    # r3 is gone, so the queued write lands on a deleted location and must fail rather than
    # resurrect it or write a dangling balance row.
    assert outcome["stock"].startswith("failed"), outcome
    assert stock_at(db, r3, shop["part"]) is None


# ── The regression this migration also fixes ─────────────────────────────────


def test_a_used_then_emptied_location_can_be_deleted(db, shop):
    """`delete_location` was broken for any transacted location from 20260731235450 to here.

    `inventory_transactions.location_id` is ON DELETE SET NULL, so deleting a location UPDATEs its
    ledger rows. 20260622034847 removed `location_id` from the notes-only immutability guard for
    exactly that reason; 20260731235450 rebuilt the guard and put it back, reading a deliberate
    removal as an oversight. Every delete of a used shelf then raised "Only the notes field can be
    updated on inventory transactions" — an error naming nothing the user did.

    Asserted against `delete_location` directly, not through the reshape, because the bug is that
    function's and outlives this feature.
    """
    r1, _, _ = shop["rows"]
    place_stock(shop, r1, 3)
    with user_session(shop["user"]) as (conn, cur):
        cur.execute(
            "SELECT deplete_stock_at_location(%s, %s, 3, 'each', 3)", (shop["part"], r1)
        )
        conn.commit()

    with user_session(shop["user"]) as (conn, cur):
        cur.execute("SELECT delete_location(%s)", (r1,))
        conn.commit()

    with db.cursor() as cur:
        cur.execute("SELECT count(*) FROM inventory_locations WHERE id = %s", (r1,))
        assert cur.fetchone()[0] == 0
        # The ledger survives with its snapshot; only the live link is nulled.
        cur.execute(
            "SELECT location_id, location_name FROM inventory_transactions "
            "WHERE part_id = %s AND location_name IS NOT NULL LIMIT 1",
            (shop["part"],),
        )
        location_id, location_name = cur.fetchone()
    assert location_id is None
    assert "Row 1" in location_name


# ── The depth cap ────────────────────────────────────────────────────────────


def test_storage_cannot_be_built_deeper_than_the_grid_can_draw(db, shop):
    """`LevelConfigStep.MAX_LEVELS` was a disabled button and nothing else.

    The wizard allowed four levels under a unit; `readUnitLayout` drew three and rendered the rest
    as a flat list captioned "this one nests deeper than the grid draws" — whose rows navigated the
    pane away with no path back on a wide screen. So a 320-location cabinet could be built at
    exactly the depth the wizard offered and then be neither drawable nor navigable.

    The grid now draws four levels under a unit, and this refuses a fifth. The two numbers are the
    same number on purpose.
    """
    r1, _, _ = shop["rows"]
    with db.cursor() as cur:
        # cabinet(1) › Row 1(2) › a(3) › b(4) › c(5) is the cap.
        cur.execute(
            "INSERT INTO inventory_locations (company_id, parent_id, name) "
            "VALUES (%s, %s, 'a') RETURNING id",
            (shop["company"], r1),
        )
        a = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO inventory_locations (company_id, parent_id, name) "
            "VALUES (%s, %s, 'b') RETURNING id",
            (shop["company"], a),
        )
        b = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO inventory_locations (company_id, parent_id, name) "
            "VALUES (%s, %s, 'c') RETURNING id",
            (shop["company"], b),
        )
        c = cur.fetchone()[0]

        with pytest.raises(errors.CheckViolation) as exc:
            cur.execute(
                "INSERT INTO inventory_locations (company_id, parent_id, name) "
                "VALUES (%s, %s, 'too deep')",
                (shop["company"], c),
            )
    assert "5 levels deep at most" in str(exc.value)


def test_the_cap_also_refuses_a_reshape_that_would_break_it(db, shop):
    """Through the RPC, since that is the path a client actually takes."""
    r1, r2, r3 = shop["rows"]
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO inventory_locations (company_id, parent_id, name) "
            "VALUES (%s, %s, 'a') RETURNING id",
            (shop["company"], r1),
        )
        a = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO inventory_locations (company_id, parent_id, name) "
            "VALUES (%s, %s, 'b') RETURNING id",
            (shop["company"], a),
        )
        b = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO inventory_locations (company_id, parent_id, name) "
            "VALUES (%s, %s, 'c') RETURNING id",
            (shop["company"], b),
        )
        c = cur.fetchone()[0]

    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.CheckViolation):
            apply_layout(
                cur,
                shop["cabinet"],
                [
                    keep(r1, "Row 1", 0),
                    keep(a, "a", 0, f"id:{r1}"),
                    keep(b, "b", 0, f"id:{a}"),
                    keep(c, "c", 0, f"id:{b}"),
                    # cabinet(1) › Row 1(2) › a(3) › b(4) › c(5) › NEW is level 6.
                    create("new:deep", "too deep", 0, f"id:{c}"),
                    keep(r2, "Row 2", 1),
                    keep(r3, "Row 3", 2),
                ],
            )
        conn.rollback()


# ── A reshape of traced material (20260906160314) ────────────────────────────
#
# `transfer_stock` refuses a lot-less move of a heat-tracked part -- there is no such thing as
# "move 12 of this bar" when the shelf holds 8 of one heat and 4 of another. This RPC delegates
# every redistribution to it and passed no lot, so reshaping a unit holding traced material raised
# outright. Nothing caught it because every other test here uses an untracked part.


def place_stock_with_heat(shop, location_id, qty, heat):
    """Receive with a heat, which also turns tracking on for the part (20260906153732)."""
    with user_session(shop["user"]) as (conn, cur):
        cur.execute(
            "SELECT add_stock_at_location(%s, %s, %s, 'each', %s, p_heat_number => %s)",
            (shop["part"], location_id, qty, qty, heat),
        )
        conn.commit()


def lot_of(db, part, heat):
    with db.cursor() as cur:
        cur.execute(
            "SELECT id FROM material_lots WHERE part_id = %s AND heat_number = %s", (part, heat)
        )
        return cur.fetchone()[0]


def stock_by_heat(db, location_id, part):
    """(heat, quantity) at one place -- one row per lot, which is the whole point."""
    with db.cursor() as cur:
        cur.execute(
            """
            SELECT l.heat_number, s.quantity
              FROM part_location_stock s
              LEFT JOIN material_lots l ON l.id = s.lot_id
             WHERE s.location_id = %s AND s.part_id = %s
             ORDER BY l.heat_number NULLS FIRST
            """,
            (location_id, part),
        )
        return [(r[0], float(r[1])) for r in cur.fetchall()]


def test_a_move_that_names_no_heat_is_refused_for_a_tracked_part(db, shop):
    """The failure the fix exists for, asserted as a failure rather than assumed away.

    A payload without `lot_id` is exactly what the client sent before 20260906160314, and it must
    not quietly move the wrong pile -- it raises, and the whole reshape rolls back.
    """
    r1, r2, r3 = shop["rows"]
    place_stock_with_heat(shop, r3, 8, "4471")

    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.CheckViolation) as exc:
            apply_layout(
                cur,
                shop["cabinet"],
                [keep(r1, "Row 1", 0), keep(r2, "Row 2", 1)],
                moves=[move(shop["part"], r3, f"id:{r1}", 8)],
                removals=[r3],
            )
        conn.rollback()
    assert "heat" in str(exc.value).lower()


def test_each_heat_moves_to_where_it_was_sent(db, shop):
    """Two heats in the bin being removed, sent to two different rows.

    Lot-blind this could not happen at all; lot-aware it is two ordinary transfers, and the split
    survives the reshape rather than being merged into one pile on the way.
    """
    r1, r2, r3 = shop["rows"]
    place_stock_with_heat(shop, r3, 8, "4471")
    place_stock_with_heat(shop, r3, 4, "8823")
    assert stock_by_heat(db, r3, shop["part"]) == [("4471", 8.0), ("8823", 4.0)]

    with user_session(shop["user"]) as (conn, cur):
        apply_layout(
            cur,
            shop["cabinet"],
            [keep(r1, "Row 1", 0), keep(r2, "Row 2", 1)],
            moves=[
                {
                    **move(shop["part"], r3, f"id:{r1}", 8),
                    "lot_id": lot_of(db, shop["part"], "4471"),
                },
                {
                    **move(shop["part"], r3, f"id:{r2}", 4),
                    "lot_id": lot_of(db, shop["part"], "8823"),
                },
            ],
            removals=[r3],
        )
        conn.commit()

    assert stock_by_heat(db, r1, shop["part"]) == [("4471", 8.0)]
    assert stock_by_heat(db, r2, shop["part"]) == [("8823", 4.0)]
    assert stock_by_heat(db, r3, shop["part"]) == []


def test_an_untracked_part_reshapes_exactly_as_it_always_did(db, shop):
    """The other half of the promise: a shop that never records a heat sees no change at all.

    An absent `lot_id` is "no lot", not "unspecified" -- so the old payload shape still works.
    """
    r1, r2, r3 = shop["rows"]
    place_stock(shop, r3, 100)

    with user_session(shop["user"]) as (conn, cur):
        apply_layout(
            cur,
            shop["cabinet"],
            [keep(r1, "Row 1", 0), keep(r2, "Row 2", 1)],
            moves=[move(shop["part"], r3, f"id:{r1}", 100)],
            removals=[r3],
        )
        conn.commit()

    assert stock_by_heat(db, r1, shop["part"]) == [(None, 100.0)]
