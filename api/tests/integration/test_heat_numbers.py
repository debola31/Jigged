"""Heat numbers ride on the ledger and freeze onto the packing slip — 20260904063844 (closes #642).

WHAT THIS GUARDS. Material traceability was cut on 2026-07-27 and re-confirmed 2026-08-01; a second
customer reopened it on 2026-09-04 for heat numbers ONLY, at the ledger grain: the heat is text on the
movement that received the bar and the movement that took it to a job, and the shipment freezes the
job's heats when the slip is created. Stock is NOT tracked per heat — `part_location_stock` is
untouched — so nothing here asserts a balance by heat, on purpose (docs/modules/inventory.md §5.6).

Five things only the database can prove:

  * **Normalisation happens in one place, for every writer.** `trg_normalize_heat_number` upper-cases,
    trims, and turns an empty string into NULL, so "" can never print as a blank heat and two dialogs
    cannot disagree about case.
  * **The heat is correctable; the quantity is not.** `restrict_transaction_update_to_notes` is an
    allowlist by omission, and `heat_number` was deliberately left un-named rather than the function
    rebuilt. A typo on a mill tag must be fixable from the part's history; a quantity must not.
  * **Exactly one overload, and the browser still reaches it.** Adding `p_heat_number` is a new
    signature. `DROP FUNCTION IF EXISTS` against a wrong signature succeeds and does nothing, leaving
    two callable functions for PostgREST to pick between; and DROP destroys the ACL, which until this
    migration was only PUBLIC's built-in default. Both are asserted here as well as in the migration's
    own guard, because the guard runs on an empty database and this runs on the one CI replays.
  * **The slip freezes what it printed.** `create_shipment_with_line_items` snapshots the DISTINCT
    (heat, material) pairs on the job's depletions; correcting the ledger afterwards leaves the slip
    alone (Document Snapshot Standard, docs/architecture.md §15).
  * **Absent is `[]`, not NULL** — the explicit "nothing recorded" state every existing slip already
    satisfies at rest.

Runs as `authenticated` with real JWT claims, the way PostgREST does per request, so the EXECUTE
grants, `get_user_company_ids()` and the billing gate are genuinely exercised.

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
    cur.execute(
        "SELECT set_config('request.jwt.claims', %s, true)",
        (json.dumps({"sub": user_id, "role": "authenticated"}),),
    )
    cur.execute("SET LOCAL ROLE authenticated")


@contextmanager
def user_session(user_id: str):
    """A transactional connection acting as `user_id`. The caller commits."""
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
    """A company with one shelf, two raw materials, one made part, and a job for it.

    `is_demo` so `company_can_write()` is true without a billing row — the billing gate would
    otherwise mask what a test is actually asserting. Parts are created at quantity 0 so
    `seed_new_part_balance` seeds nothing; every balance comes from the RPC under test.
    """
    company = str(uuid.uuid4())
    user = str(uuid.uuid4())
    tag = company[:8]
    with db.cursor() as cur:
        cur.execute(
            "INSERT INTO companies (id, name, is_demo) VALUES (%s, %s, true)",
            (company, f"Heat Test {tag}"),
        )
        cur.execute(
            """
            INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                                    email_confirmed_at, created_at, updated_at)
            VALUES (%s, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                    %s, '', now(), now(), now())
            """,
            (user, f"heat-{tag}@test.jigged.local"),
        )
        cur.execute(
            "INSERT INTO user_company_access (user_id, company_id, role) VALUES (%s, %s, 'admin')",
            (user, company),
        )
        cur.execute("SELECT inv_get_or_create_unassigned(%s)", (company,))
        cur.execute(
            "INSERT INTO inventory_locations (company_id, name, kind) VALUES (%s, 'Shelf A', 'shelf')"
            " RETURNING id",
            (company,),
        )
        shelf = cur.fetchone()[0]

        def part(name, source="bought", unit="in"):
            cur.execute(
                """
                INSERT INTO parts (company_id, part_name, source, primary_unit, quantity)
                VALUES (%s, %s, %s, %s, 0) RETURNING id
                """,
                (company, name, source, unit),
            )
            return cur.fetchone()[0]

        bar = part(f"BAR-4140-{tag}")
        plate = part(f"PLATE-6061-{tag}")
        made = part(f"WIDGET-{tag}", unit="ea")

        cur.execute(
            "INSERT INTO customers (company_id, name) VALUES (%s, %s) RETURNING id",
            (company, f"Customer {tag}"),
        )
        customer = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO customer_addresses (customer_id, address_line1, city, state, postal_code,
                                            country, default_billing, default_shipping)
            VALUES (%s, '1 Heat Way', 'Testtown', 'CA', '94000', 'USA', true, true) RETURNING id
            """,
            (customer,),
        )
        address = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO jobs (company_id, customer_id, job_number, production_status, fulfillment_status)
            VALUES (%s, %s, %s, 'in_progress', 'unshipped') RETURNING id
            """,
            (company, customer, f"J-H{tag}"),
        )
        job = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO job_parts (job_id, company_id, part_id, sequence, quantity,
                                   production_status, fulfillment_status)
            VALUES (%s, %s, %s, 10, 10, 'completed', 'unshipped') RETURNING id
            """,
            (job, company, made),
        )
        job_part = cur.fetchone()[0]

    yield {
        "company": company,
        "user": user,
        "shelf": shelf,
        "bar": bar,
        "plate": plate,
        "made": made,
        "customer": customer,
        "address": address,
        "job": job,
        "job_part": job_part,
        "bar_name": f"BAR-4140-{tag}",
        "plate_name": f"PLATE-6061-{tag}",
    }

    with db.cursor() as cur:
        # `shipments.company_id` has no ON DELETE clause, so the slips go first (lines and audit
        # rows hang off them); companies then cascades through jobs, job_parts, customers, stock
        # and ledger. The auth user is the one row outside that tree.
        cur.execute(
            "DELETE FROM shipment_line_items WHERE shipment_id IN"
            " (SELECT id FROM shipments WHERE company_id = %s)",
            (company,),
        )
        cur.execute("DELETE FROM job_fulfillment_audit WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM shipments WHERE company_id = %s", (company,))
        cur.execute("DELETE FROM companies WHERE id = %s", (company,))
        cur.execute("DELETE FROM auth.users WHERE id = %s", (user,))


# ── RPC helpers, called the way PostgREST calls them: named, defaults omitted ──────────────────


def receive(cur, shop, part, qty, heat):
    cur.execute(
        "SELECT add_stock_at_location(%s::uuid, %s::uuid, %s, 'in', %s, p_heat_number => %s)",
        (part, shop["shelf"], qty, qty, heat),
    )


def take(cur, shop, part, qty, heat, job=None):
    cur.execute(
        """
        SELECT deplete_stock_at_location(%s::uuid, %s::uuid, %s, 'in', %s,
                                         p_graceful => true, p_job_id => %s::uuid,
                                         p_heat_number => %s)
        """,
        (part, shop["shelf"], qty, qty, job, heat),
    )


def ship(cur, shop, qty=5):
    cur.execute(
        """
        SELECT create_shipment_with_line_items(
            %s::uuid, %s::uuid, %s::uuid, NULL, current_date, NULL, 'customer_pickup', %s::jsonb)
        """,
        (
            shop["company"],
            shop["customer"],
            shop["address"],
            json.dumps([{"job_part_id": shop["job_part"], "quantity": qty}]),
        ),
    )
    return cur.fetchone()[0]


def ledger_heats(db, part, kind):
    with db.cursor() as cur:
        cur.execute(
            "SELECT heat_number FROM inventory_transactions WHERE part_id = %s AND type = %s"
            " ORDER BY created_at",
            (part, kind),
        )
        return [r[0] for r in cur.fetchall()]


def snapshot(db, shipment_id):
    with db.cursor() as cur:
        cur.execute("SELECT heat_numbers_snapshot FROM shipments WHERE id = %s", (shipment_id,))
        return cur.fetchone()[0]


# ── Normalisation ──────────────────────────────────────────────────────────────────────────────


def test_a_receipt_stores_the_heat_upper_cased_and_trimmed(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        receive(cur, shop, shop["bar"], 120, "  4471a ")
        conn.commit()
    assert ledger_heats(db, shop["bar"], "addition") == ["4471A"]


def test_an_empty_or_blank_heat_is_not_recorded_rather_than_stored_blank(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        receive(cur, shop, shop["bar"], 10, "")
        receive(cur, shop, shop["bar"], 10, "   ")
        receive(cur, shop, shop["bar"], 10, None)
        conn.commit()
    assert ledger_heats(db, shop["bar"], "addition") == [None, None, None]


def test_a_heat_longer_than_a_mill_tag_is_refused(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.CheckViolation):
            receive(cur, shop, shop["bar"], 10, "X" * 65)
        conn.rollback()


# ── The take carries it, with or without a job ─────────────────────────────────────────────────


def test_the_take_to_a_job_carries_the_heat_and_the_job(db, shop):
    """A take records the heat it named, and refuses to record one that never came in.

    The second half is the rule 20260906121901 added, and it is the whole point of the picker
    that replaced the free-text box. `8823` was never received for this part, so `resolve_lot`
    returns nothing on the way out and the row records no heat -- rather than minting a lot to
    consume, which is how a mistyped 4417 used to become a real record and print on a slip.
    """
    with user_session(shop["user"]) as (conn, cur):
        receive(cur, shop, shop["bar"], 100, "4471")
        take(cur, shop, shop["bar"], 40, "4471", job=shop["job"])
        take(cur, shop, shop["bar"], 10, "8823")  # a heat nobody ever received
        conn.commit()
    with db.cursor() as cur:
        # Both takes commit in one transaction, so their created_at is identical (now() is
        # transaction-stable) and row order is arbitrary — compare as a set, not a sequence.
        cur.execute(
            "SELECT heat_number, job_id::text FROM inventory_transactions"
            " WHERE part_id = %s AND type = 'depletion'",
            (shop["bar"],),
        )
        assert set(cur.fetchall()) == {("4471", shop["job"]), (None, None)}

    # And no lot was invented for it, which is the durable half of the same rule.
    with db.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM material_lots WHERE part_id = %s AND lot_code = '8823'",
            (shop["bar"],),
        )
        assert cur.fetchone()[0] == 0


# ── Correctable, unlike everything else on the row ─────────────────────────────────────────────


def test_the_heat_is_correctable_from_the_history_but_the_quantity_is_not(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        receive(cur, shop, shop["bar"], 100, "4471")
        conn.commit()
    with db.cursor() as cur:
        cur.execute(
            "SELECT id FROM inventory_transactions WHERE part_id = %s AND type = 'addition'",
            (shop["bar"],),
        )
        row = cur.fetchone()[0]

    with user_session(shop["user"]) as (conn, cur):
        cur.execute(
            "UPDATE inventory_transactions SET heat_number = %s WHERE id = %s", (" 4472 ", row)
        )
        conn.commit()
    assert ledger_heats(db, shop["bar"], "addition") == ["4472"]

    with user_session(shop["user"]) as (conn, cur):
        with pytest.raises(errors.RaiseException, match="Only the notes field"):
            cur.execute("UPDATE inventory_transactions SET quantity = 5 WHERE id = %s", (row,))
        conn.rollback()


# ── One overload each, and the browser still reaches them ──────────────────────────────────────


@pytest.mark.parametrize(
    "name", ["add_stock_at_location", "deplete_stock_at_location", "create_shipment_with_line_items"]
)
def test_exactly_one_overload_reachable_by_authenticated_and_not_by_anon(db, name):
    with db.cursor() as cur:
        cur.execute(
            """
            SELECT has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                   has_function_privilege('anon', p.oid, 'EXECUTE')
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public' AND p.proname = %s
            """,
            (name,),
        )
        rows = cur.fetchall()
    assert len(rows) == 1, f"{name} has {len(rows)} overloads — PostgREST would have to guess"
    assert rows[0] == (True, False)


def test_the_two_stock_rpcs_take_the_lot_as_their_trailing_defaulted_parameter(db):
    """PostgREST resolves by the names supplied, so every added parameter must trail and default.

    p_lot_id joined behind p_heat_number in 20260906121901. A caller that supplies neither -- which
    every untracked-part write does -- has to still match the one overload.
    """
    with db.cursor() as cur:
        cur.execute(
            """
            SELECT p.proname, pg_get_function_identity_arguments(p.oid), p.pronargdefaults
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname = 'public'
               AND p.proname IN ('add_stock_at_location', 'deplete_stock_at_location')
             ORDER BY p.proname
            """
        )
        rows = cur.fetchall()
    for name, args, defaults in rows:
        assert args.endswith("p_lot_id uuid"), (name, args)
        assert "p_heat_number text" in args, (name, args)
        assert defaults >= 2, (name, defaults)


# ── The slip freezes the job's heats ───────────────────────────────────────────────────────────


def test_a_job_with_no_heats_ships_with_an_empty_array_not_null(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        receive(cur, shop, shop["bar"], 100, None)
        take(cur, shop, shop["bar"], 40, None, job=shop["job"])
        shipment = ship(cur, shop)
        conn.commit()
    assert snapshot(db, shipment) == []


def test_the_slip_freezes_distinct_heats_per_material_ordered_by_material(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        receive(cur, shop, shop["bar"], 100, "4471")
        receive(cur, shop, shop["bar"], 100, "4471")  # second delivery, same heat
        receive(cur, shop, shop["plate"], 50, "8823")
        take(cur, shop, shop["bar"], 40, "4471", job=shop["job"])
        take(cur, shop, shop["bar"], 40, "4471", job=shop["job"])
        take(cur, shop, shop["plate"], 20, "8823", job=shop["job"])
        first = ship(cur, shop)
        conn.commit()

    assert snapshot(db, first) == [
        {"heat_number": "4471", "material_name": shop["bar_name"]},
        {"heat_number": "8823", "material_name": shop["plate_name"]},
    ]

    # The office corrects a typo on the ledger afterwards: the slip in the customer's hands does
    # not move; the NEXT slip says the corrected thing. That is the Document Snapshot Standard.
    with db.cursor() as cur:
        cur.execute(
            "UPDATE inventory_transactions SET heat_number = '4472'"
            " WHERE part_id = %s AND type = 'depletion' AND job_id = %s",
            (shop["bar"], shop["job"]),
        )
    assert snapshot(db, first)[0]["heat_number"] == "4471"

    with user_session(shop["user"]) as (conn, cur):
        second = ship(cur, shop, qty=2)
        conn.commit()
    assert [e["heat_number"] for e in snapshot(db, second)] == ["4472", "8823"]


def test_the_snapshot_is_an_array_by_constraint(db, shop):
    with user_session(shop["user"]) as (conn, cur):
        shipment = ship(cur, shop)
        conn.commit()
    with db.cursor() as cur:
        with pytest.raises(errors.CheckViolation):
            cur.execute(
                "UPDATE shipments SET heat_numbers_snapshot = '{}'::jsonb WHERE id = %s",
                (shipment,),
            )
