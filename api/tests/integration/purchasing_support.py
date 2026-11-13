"""Shared shop, helpers and contract names for the purchasing database tests (plan §5.1).

WHAT THIS IS. Eleven test files exercise the purchasing schema, and they agree on three things
because all three live here:

  * **One shop.** A company with a `billing_exempt` row, so the billing gate can never mask
    what a test asserts, and three members: an admin, a `user` and an operator. Vendors V1
    (Atlas Metals) and V2 (Brightline Plating), each with addresses and contacts; a customer
    with an address; a rack with one leaf shelf under it; parts BAR (stocked in `inches`,
    bought in `feet` = 12, with three pricing tiers), SCREW (`each`, bought by the
    `hundred` = 100) and WIDGET (made); two work centres; a job for 100 WIDGETs routed
    through the first work centre and then V1's anodize service; and a second job that
    ships 250 SCREWs bought whole (a bought job part).
  * **One way to call the database.** `rpc()` calls a function the way PostgREST does: by
    argument NAME, sending only the keys it is given, so a missing DEFAULT or a second
    overload fails here exactly as it would in the browser. `call()` and `refuse()` are each
    one transaction as one member — which is what one PostgREST request is — and `refuse()`
    never commits, so a writer that wrongly accepts a call cannot leave a mark.
  * **One `DELETE FROM companies` as the whole teardown.** That is the S6 check, run after
    every test: a purchasing table that does not cascade from its company makes every test
    error at teardown. The rows are then purged leaves-first, so the next test still starts
    clean, and the failure is reported rather than swallowed.

NAMES ARE ASSUMPTIONS WRITTEN DOWN ONCE. Tables, columns, views, RPC argument names and jsonb
keys are the plan's §3 contract; where §3 is silent they are the Database architect's design.
A mismatch with the migrations is therefore one edit here, not eleven.

Runs as `authenticated` with real JWT claims, the way PostgREST does per request, so EXECUTE
grants, `get_user_company_ids()` and the billing gate are genuinely exercised. Requires a local
Supabase with every migration applied; skipped without one.
"""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Iterable

import psycopg2
import psycopg2.extras
import pytest

DB_URL = os.getenv(
    "TEST_SUPABASE_DB_URL", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
)
# supabase/seed.sql gives the insights role a local login, password `postgres`.
READONLY_URL = DB_URL.replace("postgres:postgres@", "jigged_ai_readonly:postgres@", 1)

# The caller's local date. Every writer takes it as `p_today` and never reads CURRENT_DATE
# (§3.3 rule 7), so a fixed date keeps price-sheet validity and lateness deterministic.
TODAY = date(2026, 11, 9)
RECEIVED_AT = "2026-11-05T15:30:00+00:00"


# ── The contract's names (§3.1, §3.2, §3.4) ────────────────────────────────────────────────────

PURCHASING_TABLES = (
    "purchasing_document_series",
    "vendor_purchase_orders",
    "vendor_purchase_order_lines",
    "vendor_purchase_order_receipts",
    "vendor_purchase_order_revisions",
    "part_vendors",
    "part_vendor_price_breaks",
    "vendor_rfqs",
    "vendor_rfq_lines",
    "vendor_rfq_invitations",
    "vendor_rfq_responses",
    "quickbooks_vendor_map",
    "quickbooks_purchasing_setup",
    "quickbooks_purchase_order_links",
    "quickbooks_purchase_order_line_links",
)
QUICKBOOKS_TABLES = PURCHASING_TABLES[-4:]
# Readable by nobody but the service role and the members of the company (§3.12).
AI_EXEMPT_TABLES = ("vendor_purchase_order_revisions", "purchasing_document_series") + QUICKBOOKS_TABLES

PURCHASING_VIEWS = (
    "vendor_purchase_order_line_status",
    "vendor_purchase_order_status",
    "part_on_order",
    "part_vendor_last_purchase",
    "vendor_rfq_status",
)

# Every SECURITY DEFINER write door (§3.3). `create_outside_shipment` is deliberately absent:
# operators send outside work, so it carries no office assertion (§3.3, O3).
WRITER_RPCS = (
    "create_vendor_purchase_order",
    "save_vendor_purchase_order",
    "set_vendor_purchase_order_state",
    "set_vendor_purchase_order_line_state",
    "receive_vendor_purchase_order",
    "void_vendor_purchase_order_receipt",
    "set_outside_shipment_vendor_purchase_order_line",
    "save_part_vendor",
    "archive_part_vendor",
    "apply_part_cost_from_vendor",
    "create_vendor_rfq",
    "save_vendor_rfq",
    "set_vendor_rfq_state",
    "set_vendor_rfq_invitation_state",
    "save_vendor_rfq_responses",
    "award_vendor_rfq",
)
# Reads the browser may call. The two definitions are also the insights AI's (§3.4, M5).
READ_FUNCTIONS = (
    "is_vendor_purchase_order_late",
    "vendor_po_line_amount",
    "preview_part_cost_from_vendor",
)
# A name the purchasing migrations would give any function of theirs, used by the catalogue
# checks so a helper nobody listed is still policed.
PURCHASING_FUNCTION_PATTERN = (
    "vendor_purchase_order|vendor_po|vendor_rfq|part_vendor|purchasing|preferred_vendor"
    "|part_cost_from_vendor|office_member"
)

# §3.4 statuses, first match wins.
DRAFT, SENT, PARTLY_RECEIVED, RECEIVED, CLOSED = (
    "draft", "sent", "partially_received", "received", "closed")
LINE_OPEN, LINE_NO_RECEIPT = "open", "no_receipt"

# §3.3 refusal sentences. Not-found and not-a-member read the same on purpose: the function
# cannot be used to probe whether a record exists.
NOT_AVAILABLE = "That record is not available."
OFFICE_TASK = "This is an office task"
DRAFT_RECEIPT_HINT = "mark it sent first"
OUTSIDE_RECEIPT_HINT = "Outside work is received on its vendor packing slip"
STALE_PREVIEW_HINT = "changed since you previewed"

# ── THE VENDOR-VISIBLE DOCUMENT (§3.3, P3) ──────────────────────────────────────────────────────
# The fields a save can change on a SENT purchase order that the vendor's copy shows — the one
# list both layers read. A change to any of them bumps the revision once per send cycle; the
# internal fields never do. `test_vendor_purchase_orders.py` is parametrized over recipes that
# must cover every name below and pins these tuples to __tests__/fixtures/vendorPoVisibleFields.json;
# the Vitest `vendorPoVisibleFields` test reads these four literal tuples (keep them literal) and
# pins lib/purchasing/vendorPoVisibleFields.ts to them, so no side can grow alone.
# (`ordered_on` and `vendor_id` are vendor-visible too, but a sent PO refuses both — P4.
# `line_kind` and `job_operation_id` print too, but they are fixed for an existing line, draft
# or sent: the save refuses a change, so only adding or removing a line moves them.)
# `job_part_id` is here because it carries the job: a part or other line moved to another
# job's part prints the other job number.
VENDOR_VISIBLE_HEADER_FIELDS = (
    "vendor_contact_id",
    "vendor_address_id",
    "ship_to_kind",
    "ship_to_vendor_id",
    "ship_to_vendor_address_id",
    "ship_to_customer_id",
    "ship_to_customer_address_id",
    "need_by_on",
    "payment_terms",
    "ship_via",
    "notes_to_vendor",
)
VENDOR_VISIBLE_LINE_FIELDS = (
    "part_id",
    "description",
    "vendor_part_number",
    "quantity",
    "unit",
    "unit_price",
    "need_by_on",
    "cert_required",
    "job_id",
    "job_part_id",
    "work_center_id",
)
INTERNAL_HEADER_FIELDS = ("internal_notes",)
INTERNAL_LINE_FIELDS = ("promised_on",)


def _params(params: Any):
    """psycopg2 takes a sequence for `%s` placeholders and a mapping for `%(name)s` ones."""
    return params if isinstance(params, dict) else tuple(params)


# ── Connections and impersonation ───────────────────────────────────────────────────────────────


def connect(url: str = DB_URL):
    try:
        return psycopg2.connect(url)
    except psycopg2.OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"No local Postgres at {url}: {exc}")


def act_as(cur, user_id: str) -> None:
    """Become `user_id` for the rest of this transaction, as PostgREST does per request."""
    cur.execute(
        "SELECT set_config('request.jwt.claims', %s, true)",
        (json.dumps({"sub": user_id, "role": "authenticated"}),),
    )
    cur.execute("SET LOCAL ROLE authenticated")


@contextmanager
def session(user_id: str):
    """One transaction as `user_id`. The caller commits; COMMIT ends the impersonation, so a
    session is never reused after it."""
    conn = connect()
    try:
        with conn.cursor() as cur:
            act_as(cur, user_id)
            yield conn, cur
    finally:
        conn.close()


@contextmanager
def ai_session(company_id: str):
    """A connection AS jigged_ai_readonly, scoped to one company the way the sandbox is."""
    try:
        conn = psycopg2.connect(READONLY_URL)
    except psycopg2.OperationalError as exc:  # pragma: no cover - environment guard
        pytest.skip(f"No jigged_ai_readonly login: {exc}")
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT current_user")
            if cur.fetchone()[0] != "jigged_ai_readonly":
                pytest.skip("READONLY_URL is not the insights role; these assertions would be vacuous")
            cur.execute("SELECT set_config('jigged.company_id', %s, false)", (company_id,))
            yield cur
    finally:
        conn.close()


# ── Calling a function the way PostgREST does ──────────────────────────────────────────────────


def _json_default(value: Any):
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    raise TypeError(f"cannot send {type(value).__name__} as json")


def _encode(key: str, value: Any):
    # Every array argument in the contract is named `*_ids` (uuid[]); every other list or dict
    # is a jsonb argument. Both go as UNTYPED literals so Postgres resolves the function from
    # the argument names alone, the way PostgREST's named call does.
    if key.endswith("_ids") and isinstance(value, (list, tuple)):
        return "{" + ",".join(str(v) for v in value) + "}"
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, default=_json_default)
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


def rpc(cur, name: str, **args):
    """Call public.<name> by argument name, sending only the keys given.

    Returns the single value of a one-column result (jsonb, uuid, boolean, void), or the first
    row as a tuple for a TABLE(...) result such as `(id, po_number)`.
    """
    keys = list(args)
    sql = "SELECT * FROM public.{}({})".format(name, ", ".join(f"{k} => %s" for k in keys))
    cur.execute(sql, [_encode(k, args[k]) for k in keys])
    if cur.description is None:
        return None
    rows = cur.fetchall()
    if not rows:
        return None
    return rows[0][0] if len(cur.description) == 1 else rows[0]


# SQLSTATEs that mean the call never reached a function body that meant to refuse it. Counting
# one of these as "refused" would let a misspelt argument pass every refusal test in this suite.
NEVER_REACHED = {
    "42883": "no function matches these argument names",
    "42725": "the call is ambiguous between overloads",
    "42P01": "a relation does not exist",
    "42703": "a column does not exist",
    "42601": "a syntax error",
    "42804": "a datatype mismatch",
}


def _reached(exc: psycopg2.Error, what: str) -> psycopg2.Error:
    if exc.pgcode in NEVER_REACHED:
        pytest.fail(f"{what} never reached a deliberate refusal ({NEVER_REACHED[exc.pgcode]}): {exc}")
    return exc


def call(user_id: str, name: str, **args):
    """One request as `user_id`: call the function and commit."""
    with session(user_id) as (conn, cur):
        result = rpc(cur, name, **args)
        conn.commit()
        return result


def refuse(user_id: str, name: str, **args) -> psycopg2.Error:
    """One request as `user_id` that must be refused. Never commits, whatever happens."""
    with session(user_id) as (conn, cur):
        try:
            result = rpc(cur, name, **args)
        except psycopg2.Error as exc:
            conn.rollback()
            return _reached(exc, name)
        conn.rollback()
    pytest.fail(f"{name} accepted a call it must refuse; it returned {result!r}")


def sql_as(user_id: str, sql: str, params: Iterable = ()):
    """A direct table statement as `user_id`, committed — the browser's own table writes."""
    with session(user_id) as (conn, cur):
        cur.execute(sql, _params(params))
        result = cur.fetchall() if cur.description else None
        conn.commit()
        return result


def refuse_sql(user_id: str, sql: str, params: Iterable = ()) -> psycopg2.Error:
    with session(user_id) as (conn, cur):
        try:
            cur.execute(sql, _params(params))
        except psycopg2.Error as exc:
            conn.rollback()
            return _reached(exc, sql)
        conn.rollback()
    pytest.fail(f"the database accepted a statement it must refuse: {sql}")


# ── What a refusal must look like (§3.3, §3.14) ────────────────────────────────────────────────

_RAW_CONSTRAINT = re.compile(r"violates (check|not-null|exclusion|foreign key|unique) constraint", re.I)


def message(exc: psycopg2.Error) -> str:
    diag = getattr(exc, "diag", None)
    return (diag.message_primary if diag and diag.message_primary else str(exc)).strip()


def assert_not_available(exc: psycopg2.Error) -> None:
    """Not found and not a member: P0001 with the one sentence (§3.3 step 2)."""
    assert exc.pgcode == "P0001", f"expected P0001 {NOT_AVAILABLE!r}, got {exc.pgcode}: {message(exc)}"
    assert message(exc) == NOT_AVAILABLE, f"expected {NOT_AVAILABLE!r}, got {message(exc)!r}"


def assert_office_only(exc: psycopg2.Error) -> None:
    """An operator: 42501, "This is an office task…" (§3.3 step 2)."""
    assert exc.pgcode == "42501", f"expected 42501 for an operator, got {exc.pgcode}: {message(exc)}"
    assert message(exc).startswith(OFFICE_TASK), f"expected {OFFICE_TASK!r}…, got {message(exc)!r}"


def assert_billing_blocked(exc: psycopg2.Error) -> None:
    """A lapsed company: 42501 in the shape `isBillingWriteBlocked` recognises
    (lib/supabaseErrors.ts), so the UI shows the Subscribe path rather than "no permission"."""
    assert exc.pgcode == "42501", f"expected 42501 for billing, got {exc.pgcode}: {message(exc)}"
    text = message(exc)
    assert "billing_gate" in text or "no active subscription" in text, (
        f"a billing refusal the UI cannot recognise as billing: {text!r}")


def _assert_sentence(exc: psycopg2.Error, fragments: Iterable[str]) -> None:
    text = message(exc)
    assert text, "a refusal with no message"
    assert not _RAW_CONSTRAINT.search(text), (
        f"a raw constraint message reached the caller instead of a sentence: {text!r}")
    for fragment in fragments:
        assert fragment.lower() in text.lower(), f"expected {fragment!r} in {text!r}"


def assert_state_refusal(exc: psycopg2.Error, *fragments: str) -> None:
    """A state rule: P0001 and a sentence (§3.14)."""
    assert exc.pgcode == "P0001", f"expected a P0001 sentence, got {exc.pgcode}: {message(exc)}"
    _assert_sentence(exc, fragments)


def assert_sentence_refusal(exc: psycopg2.Error, *fragments: str) -> None:
    """A rule on the caller's input, pre-validated (§3.3 step 6): a sentence under P0001 or
    23514 — never 42501 (reserved for operators and billing), never XX000 (our bugs), and never
    Postgres' own constraint wording."""
    assert exc.pgcode in ("P0001", "23514"), (
        f"expected a P0001/23514 sentence, got {exc.pgcode}: {message(exc)}")
    _assert_sentence(exc, fragments)


def assert_refused(exc: psycopg2.Error, codes: Iterable[str]) -> None:
    assert exc.pgcode in tuple(codes), f"expected one of {tuple(codes)}, got {exc.pgcode}: {message(exc)}"


# ── Reading ─────────────────────────────────────────────────────────────────────────────────────


def rows(db, sql: str, params: Iterable = ()) -> list[dict]:
    with db.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute(sql, _params(params))
        return [dict(r) for r in cur.fetchall()]


def row(db, sql: str, params: Iterable = ()) -> dict | None:
    found = rows(db, sql, params)
    return found[0] if found else None


def scalar(db, sql: str, params: Iterable = ()):
    with db.cursor() as cur:
        cur.execute(sql, _params(params))
        found = cur.fetchone()
        return found[0] if found else None


def execute(db, sql: str, params: Iterable = ()) -> None:
    with db.cursor() as cur:
        cur.execute(sql, _params(params))


def count(db, table: str, company_id: str) -> int:
    return scalar(db, f"SELECT count(*) FROM public.{table} WHERE company_id = %s", (company_id,))


def footprint(db, company_id: str) -> dict:
    """Row counts of everything a purchasing writer could touch, for "wrote nothing" checks."""
    tables = PURCHASING_TABLES + (
        "inventory_transactions", "part_location_stock", "material_lots", "part_pricing_tiers",
        "outside_shipments")
    found = {t: count(db, t, company_id) for t in tables}
    found["parts.quantity"] = scalar(
        db, "SELECT COALESCE(sum(quantity), 0) FROM public.parts WHERE company_id = %s", (company_id,))
    return found


# ── The shop ────────────────────────────────────────────────────────────────────────────────────


@dataclass
class Shop:
    company: str
    name: str
    tag: str
    admin: str
    user: str
    operator: str
    v1: str
    v1_name: str
    v1_address: str
    v1_remit: str
    v1_sales: str
    v1_payables: str
    v2: str
    v2_name: str
    v2_address: str
    v2_contact: str
    anodize: str
    plating: str
    customer: str
    customer_name: str
    customer_address: str
    rack: str
    shelf: str
    bar: str
    bar_name: str
    bar_tiers: dict
    screw: str
    screw_name: str
    widget: str
    widget_name: str
    work_center: str
    work_center_name: str
    work_center_2: str
    work_center_2_name: str
    routing: str
    job: str
    job_number: str
    job_part: str
    station_op: str
    outside_op: str
    second_job: str       # a second job, shipping SCREWs bought whole...
    second_job_number: str
    screw_job_part: str   # ...as its one bought job part (250 each)

    @property
    def users(self) -> tuple[str, str, str]:
        return (self.admin, self.user, self.operator)


def _one(cur, sql: str, params: Iterable = ()) -> str:
    cur.execute(sql, _params(params))
    return cur.fetchone()[0]


def build_shop(db, label: str = "Purchasing") -> Shop:
    """Everything §5.1 lists, written as the service role so the test body can act as members.

    Parts start at quantity 0 so `seed_new_part_balance` seeds nothing; every balance a test
    reads comes from the RPC under test. A build that fails half-way removes what it wrote.
    """
    company = str(uuid.uuid4())
    admin, user, operator = (str(uuid.uuid4()) for _ in range(3))
    try:
        return _build_shop(db, label, company, admin, user, operator)
    except BaseException:
        try:
            execute(db, "DELETE FROM companies WHERE id = %s", (company,))
            execute(db, "DELETE FROM auth.users WHERE id = ANY(%s::uuid[])", ([admin, user, operator],))
        except psycopg2.Error:
            pass
        raise


def _build_shop(db, label: str, company: str, admin: str, user: str, operator: str) -> Shop:
    tag = company[:8]
    name = f"{label} {tag}"
    with db.cursor() as cur:
        cur.execute(
            """
            INSERT INTO companies (id, name, address_line1, city, state, postal_code, country, phone)
            VALUES (%s, %s, '1420 Rand Drive', 'Detroit', 'MI', '48211', 'USA', '(313) 555-0142')
            """,
            (company, name),
        )
        cur.execute(
            "INSERT INTO company_billing (company_id, billing_exempt) VALUES (%s, true)"
            " ON CONFLICT (company_id) DO UPDATE SET billing_exempt = true",
            (company,),
        )
        for uid, role in ((admin, "admin"), (user, "user"), (operator, "operator")):
            cur.execute(
                """
                INSERT INTO auth.users (id, instance_id, aud, role, email, encrypted_password,
                                        email_confirmed_at, created_at, updated_at)
                VALUES (%s, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
                        %s, '', now(), now(), now())
                """,
                (uid, f"po-{role}-{tag}@test.jigged.local"),
            )
            cur.execute(
                "INSERT INTO user_company_access (user_id, company_id, role, name) VALUES (%s, %s, %s, %s)",
                (uid, company, role, f"{role.title()} {tag}"),
            )

        # V1 sells material and anodizes. Its SALES contact is not the primary one, so the
        # "sales, then primary" default is visible; its remit-to address is not the default.
        v1 = _one(cur, "INSERT INTO vendors (company_id, name) VALUES (%s, 'Atlas Metals') RETURNING id", (company,))
        v1_address = _one(cur, """
            INSERT INTO vendor_addresses (vendor_id, address_line1, city, state, postal_code, country, is_default)
            VALUES (%s, '1 Mill Road', 'Gary', 'IN', '46402', 'USA', true) RETURNING id""", (v1,))
        v1_remit = _one(cur, """
            INSERT INTO vendor_addresses (vendor_id, address_line1, city, state, postal_code, country, is_default)
            VALUES (%s, 'PO Box 9', 'Merrillville', 'IN', '46410', 'USA', false) RETURNING id""", (v1,))
        v1_sales = _one(cur, """
            INSERT INTO vendor_contacts (vendor_id, name, role, is_primary, email)
            VALUES (%s, 'Sally Sales', 'sales', false, 'sally@atlas.test') RETURNING id""", (v1,))
        v1_payables = _one(cur, """
            INSERT INTO vendor_contacts (vendor_id, name, role, is_primary, email)
            VALUES (%s, 'Pat Payables', 'accounts_payable', true, 'ap@atlas.test') RETURNING id""", (v1,))
        # V2 has no sales contact, so its primary one is the default.
        v2 = _one(cur, "INSERT INTO vendors (company_id, name) VALUES (%s, 'Brightline Plating') RETURNING id", (company,))
        v2_address = _one(cur, """
            INSERT INTO vendor_addresses (vendor_id, address_line1, city, state, postal_code, country, is_default)
            VALUES (%s, '77 Plating Way', 'Warren', 'MI', '48089', 'USA', true) RETURNING id""", (v2,))
        v2_contact = _one(cur, """
            INSERT INTO vendor_contacts (vendor_id, name, role, is_primary, email)
            VALUES (%s, 'Vic Dock', 'shipping_receiving', true, 'dock@brightline.test') RETURNING id""", (v2,))
        anodize = _one(cur, """
            INSERT INTO vendor_services (company_id, vendor_id, name, unit_price)
            VALUES (%s, %s, 'Anodize', 3.5) RETURNING id""", (company, v1))
        plating = _one(cur, """
            INSERT INTO vendor_services (company_id, vendor_id, name, unit_price)
            VALUES (%s, %s, 'Zinc plate', 4.25) RETURNING id""", (company, v2))

        customer = _one(cur, "INSERT INTO customers (company_id, name) VALUES (%s, 'Northwind Hydraulics') RETURNING id", (company,))
        customer_address = _one(cur, """
            INSERT INTO customer_addresses (customer_id, address_line1, city, state, postal_code, country,
                                            default_billing, default_shipping)
            VALUES (%s, '9 Harbor Street', 'Toledo', 'OH', '43604', 'USA', true, true) RETURNING id""", (customer,))

        rack = _one(cur, "INSERT INTO inventory_locations (company_id, name) VALUES (%s, 'Rack A') RETURNING id", (company,))
        shelf = _one(cur, """
            INSERT INTO inventory_locations (company_id, parent_id, name) VALUES (%s, %s, 'Shelf A1') RETURNING id""",
            (company, rack))

        def part(part_name: str, source: str, unit: str) -> str:
            return _one(cur, """
                INSERT INTO parts (company_id, part_name, source, primary_unit, quantity)
                VALUES (%s, %s, %s, %s, 0) RETURNING id""", (company, part_name, source, unit))

        bar = part("BAR-4140-1RD", "bought", "inches")
        screw = part("SHCS-M5X16", "bought", "each")
        widget = part("WIDGET-1042", "made", "each")
        cur.execute("INSERT INTO parts_unit_conversions (part_id, from_unit, to_primary_factor) VALUES (%s, 'feet', 12)", (bar,))
        cur.execute("INSERT INTO parts_unit_conversions (part_id, from_unit, to_primary_factor) VALUES (%s, 'hundred', 100)", (screw,))
        bar_tiers = {}
        for seq, (qty, cost, markup) in enumerate(((12, "2.50", 20), (1200, "1.50", 15), (2400, "1.40", 10)), start=1):
            bar_tiers[qty] = _one(cur, """
                INSERT INTO part_pricing_tiers (company_id, part_id, quantity, sequence, cost_per_unit, markup_percent)
                VALUES (%s, %s, %s, %s, %s, %s) RETURNING id""", (company, bar, qty, seq, cost, markup))

        work_center = _one(cur, """
            INSERT INTO work_centers (company_id, name, labor_rate) VALUES (%s, 'Haas VF-2', 75) RETURNING id""", (company,))
        # A second machine, so an Other line can be moved from one to the other (P3).
        work_center_2 = _one(cur, """
            INSERT INTO work_centers (company_id, name, labor_rate) VALUES (%s, 'Okuma LB3000', 65) RETURNING id""",
            (company,))
        routing = _one(cur, """
            INSERT INTO routings (company_id, part_id, name) VALUES (%s, %s, 'Standard') RETURNING id""", (company, widget))
        cur.execute("""
            INSERT INTO routing_operations (routing_id, work_center_id, sequence, setup_minutes, cycle_minutes_per_unit)
            VALUES (%s, %s, 10, 15, 2)""", (routing, work_center))
        cur.execute("""
            INSERT INTO routing_operations (routing_id, vendor_service_id, sequence) VALUES (%s, %s, 20)""",
            (routing, anodize))

        job_number = f"J-{tag[:4].upper()}"
        job = _one(cur, """
            INSERT INTO jobs (company_id, customer_id, job_number, production_status, fulfillment_status)
            VALUES (%s, %s, %s, 'not_started', 'unshipped') RETURNING id""", (company, customer, job_number))
        job_part = _one(cur, """
            INSERT INTO job_parts (job_id, company_id, part_id, sequence, quantity, production_status, fulfillment_status)
            VALUES (%s, %s, %s, 1, 100, 'not_started', 'unshipped') RETURNING id""", (job, company, widget))
        cur.execute("SELECT public.create_job_part_operations_from_routing(%s::uuid, %s::uuid)", (job_part, routing))
        cur.execute(
            "SELECT id, vendor_service_id FROM job_operations WHERE job_part_id = %s ORDER BY sequence",
            (job_part,),
        )
        ops = cur.fetchall()
        assert len(ops) == 2, "the routing did not produce a station and an outside operation"
        station_op = next(o[0] for o in ops if o[1] is None)
        outside_op = next(o[0] for o in ops if o[1] is not None)

        # A second job, so a line can carry another job through its job part (P3). Its one
        # job part is bought whole: no operations, `completed` at creation as the app writes it.
        second_job_number = f"J-{tag[:4].upper()}-K"
        second_job = _one(cur, """
            INSERT INTO jobs (company_id, customer_id, job_number, production_status, fulfillment_status)
            VALUES (%s, %s, %s, 'not_started', 'unshipped') RETURNING id""", (company, customer, second_job_number))
        screw_job_part = _one(cur, """
            INSERT INTO job_parts (job_id, company_id, part_id, sequence, quantity, production_status, fulfillment_status)
            VALUES (%s, %s, %s, 1, 250, 'completed', 'unshipped') RETURNING id""", (second_job, company, screw))

    return Shop(
        company=company, name=name, tag=tag, admin=admin, user=user, operator=operator,
        v1=v1, v1_name="Atlas Metals", v1_address=v1_address, v1_remit=v1_remit,
        v1_sales=v1_sales, v1_payables=v1_payables,
        v2=v2, v2_name="Brightline Plating", v2_address=v2_address, v2_contact=v2_contact,
        anodize=anodize, plating=plating,
        customer=customer, customer_name="Northwind Hydraulics", customer_address=customer_address,
        rack=rack, shelf=shelf,
        bar=bar, bar_name="BAR-4140-1RD", bar_tiers=bar_tiers,
        screw=screw, screw_name="SHCS-M5X16", widget=widget, widget_name="WIDGET-1042",
        work_center=work_center, work_center_name="Haas VF-2",
        work_center_2=work_center_2, work_center_2_name="Okuma LB3000", routing=routing,
        job=job, job_number=job_number, job_part=job_part, station_op=station_op, outside_op=outside_op,
        second_job=second_job, second_job_number=second_job_number, screw_job_part=screw_job_part,
    )


# Leaves first, for the purge that runs only when the single DELETE failed.
_PURGE_ORDER = (
    "quickbooks_purchase_order_line_links", "quickbooks_purchase_order_links",
    "quickbooks_vendor_map", "quickbooks_purchasing_setup",
    "vendor_rfq_responses", "vendor_rfq_invitations", "vendor_rfq_lines",
    "part_vendor_price_breaks", "part_vendors",
    "vendor_purchase_order_receipts", "vendor_purchase_order_revisions",
    "outside_shipment_receipts", "outside_shipments",
    "vendor_purchase_order_lines", "vendor_purchase_orders", "vendor_rfqs",
    "purchasing_document_series", "lot_certificates", "inventory_transactions",
    "part_location_stock", "material_lots", "job_operation_completions",
)


def drop_shop(db, shop: Shop) -> None:
    """ONE `DELETE FROM companies` — the S6 check after every test (see the module docstring)."""
    failure = None
    try:
        execute(db, "DELETE FROM companies WHERE id = %s", (shop.company,))
    except psycopg2.Error as exc:
        failure = exc
        for table in _PURGE_ORDER:
            try:
                execute(db, f"DELETE FROM public.{table} WHERE company_id = %s", (shop.company,))
            except psycopg2.Error:
                pass  # a table this database does not have yet
        execute(db, "DELETE FROM companies WHERE id = %s", (shop.company,))
    execute(db, "DELETE FROM auth.users WHERE id = ANY(%s::uuid[])", (list(shop.users),))
    if failure is not None:
        pytest.fail(
            "a single DELETE FROM companies did not remove the purchasing graph (S6); the rows "
            f"were purged leaves-first instead: {failure}")


@pytest.fixture
def db():
    conn = connect()
    conn.autocommit = True
    yield conn
    conn.close()


@pytest.fixture
def shop(db):
    built = build_shop(db, "Purchasing")
    yield built
    drop_shop(db, built)


@pytest.fixture
def other_shop(db):
    """A second company: ids that belong to someone else (S3), and a series of its own (N1)."""
    built = build_shop(db, "Elsewhere")
    yield built
    drop_shop(db, built)


# ── Extra rows a test can add to the shop ─────────────────────────────────────────────────────


def add_shelf(db, shop: Shop, name: str) -> str:
    return scalar(db, """
        INSERT INTO inventory_locations (company_id, parent_id, name) VALUES (%s, %s, %s) RETURNING id""",
        (shop.company, shop.rack, name))


def add_job(db, shop: Shop, job_number: str) -> str:
    return scalar(db, """
        INSERT INTO jobs (company_id, customer_id, job_number, production_status, fulfillment_status)
        VALUES (%s, %s, %s, 'not_started', 'unshipped') RETURNING id""", (shop.company, shop.customer, job_number))


_NEXT_SEQUENCE = "(SELECT COALESCE(max(sequence), 0) + 1 FROM public.job_parts WHERE job_id = %s)"


def add_job_part(db, shop: Shop, part: str, quantity, *, job: str | None = None) -> str:
    """A bought part on a job: no operations, `completed` at creation as the app writes it."""
    job = job or shop.job
    return scalar(db, f"""
        INSERT INTO job_parts (job_id, company_id, part_id, sequence, quantity, production_status, fulfillment_status)
        VALUES (%s, %s, %s, {_NEXT_SEQUENCE}, %s, 'completed', 'unshipped') RETURNING id""",
        (job, shop.company, part, job, quantity))


def add_outside_job_part(db, shop: Shop, service: str, quantity: int = 40) -> tuple[str, str]:
    """A second made part on the shop's job, routed through one outside `service`.
    Returns (job_part_id, operation_id)."""
    part_name = f"BRACKET-{uuid.uuid4().hex[:6].upper()}"
    with db.cursor() as cur:
        part = _one(cur, """
            INSERT INTO parts (company_id, part_name, source, primary_unit, quantity)
            VALUES (%s, %s, 'made', 'each', 0) RETURNING id""", (shop.company, part_name))
        routing = _one(cur, "INSERT INTO routings (company_id, part_id, name) VALUES (%s, %s, 'Outside') RETURNING id",
                       (shop.company, part))
        cur.execute("INSERT INTO routing_operations (routing_id, vendor_service_id, sequence) VALUES (%s, %s, 10)",
                    (routing, service))
        job_part = _one(cur, f"""
            INSERT INTO job_parts (job_id, company_id, part_id, sequence, quantity, production_status, fulfillment_status)
            VALUES (%s, %s, %s, {_NEXT_SEQUENCE}, %s, 'not_started', 'unshipped') RETURNING id""",
            (shop.job, shop.company, part, shop.job, quantity))
        cur.execute("SELECT public.create_job_part_operations_from_routing(%s::uuid, %s::uuid)", (job_part, routing))
        op = _one(cur, "SELECT id FROM job_operations WHERE job_part_id = %s", (job_part,))
    return job_part, op


def complete_operation(db, shop: Shop, operation: str, job_part: str, good) -> None:
    execute(db, """
        INSERT INTO job_operation_completions (company_id, job_operation_id, job_part_id, quantity_good, completed_by)
        VALUES (%s, %s, %s, %s, %s)""", (shop.company, operation, job_part, good, shop.admin))


# ── Purchase orders ─────────────────────────────────────────────────────────────────────────────


def part_line(part: str, quantity, unit: str, *, unit_price=10, price_source="manual",
              description: str = "Material", **extra) -> dict:
    return {"line_kind": "part", "part_id": part, "quantity": quantity, "unit": unit,
            "unit_price": unit_price, "price_source": price_source, "description": description, **extra}


def outside_line(operation: str, quantity, *, unit_price=3.5, price_source="vendor_service",
                 description: str = "Anodize", unit: str = "each", **extra) -> dict:
    return {"line_kind": "outside_service", "job_operation_id": operation, "quantity": quantity,
            "unit": unit, "unit_price": unit_price, "price_source": price_source,
            "description": description, **extra}


def other_line(description: str = "Freight", quantity=1, *, unit: str = "each", unit_price=45,
               price_source="manual", **extra) -> dict:
    return {"line_kind": "other", "description": description, "quantity": quantity, "unit": unit,
            "unit_price": unit_price, "price_source": price_source, **extra}


def ship_to(kind: str, **ids) -> dict:
    """The header's `ship_to` object: {kind, vendor_id, vendor_address_id, customer_id,
    customer_address_id} (Database architect §1.5). Stored as `ship_to_kind`, `ship_to_<id>`,
    `ship_to_name` and `ship_to_address` on the PO."""
    return {"ship_to": {"kind": kind, **ids}}


def create_args(vendor: str, lines: Iterable[dict], *, header: dict | None = None,
                ordered_on=TODAY, today=TODAY) -> dict:
    return dict(p_vendor_id=vendor, p_ordered_on=ordered_on, p_today=today,
                p_header=header or {}, p_lines=list(lines))


def create_po(user: str, vendor: str, lines: Iterable[dict], **kw) -> tuple[str, str]:
    """`create_vendor_purchase_order` → (id, po_number), read by position."""
    created = call(user, "create_vendor_purchase_order", **create_args(vendor, lines, **kw))
    return str(created[0]), created[1]


@dataclass
class Po:
    id: str
    number: str
    lines: list[str]  # line ids in line_number order, i.e. payload order


def make_po(db, shop: Shop, lines: Iterable[dict], *, vendor: str | None = None,
            header: dict | None = None, user: str | None = None, sent: bool = False,
            ordered_on=TODAY) -> Po:
    who = user or shop.admin
    po_id, number = create_po(who, vendor or shop.v1, lines, header=header, ordered_on=ordered_on)
    if sent:
        mark_sent(who, po_id)
    return Po(id=po_id, number=number, lines=[r["id"] for r in lines_of(db, po_id)])


def mark_sent(user: str, po_id: str, today=TODAY):
    return call(user, "set_vendor_purchase_order_state", p_id=po_id, p_action="mark_sent", p_today=today)


def set_state(user: str, po_id: str, action: str, *, reason: str | None = None, today=TODAY):
    args = dict(p_id=po_id, p_action=action, p_today=today)
    if reason is not None:
        args["p_reason"] = reason
    return call(user, "set_vendor_purchase_order_state", **args)


def save_args(po_id: str, *, changes: dict | None = None, lines: list | None = None,
              removed: list | None = None, expected: str | None = None, today=TODAY) -> dict:
    """Patch semantics: only what changes. `p_expected_updated_at` is sent only when a test
    passes it — the promised-date and internal-note auto-saves send none (§3.3)."""
    args = dict(p_id=po_id, p_changes=changes or {}, p_lines=lines or [],
                p_removed_line_ids=removed or [], p_today=today)
    if expected is not None:
        args["p_expected_updated_at"] = expected
    return args


def save_po(user: str, po_id: str, **kw):
    return call(user, "save_vendor_purchase_order", **save_args(po_id, **kw))


def set_lines(user: str, po_id: str, line_ids: list[str], action: str, *, reason: str | None = None):
    args = dict(p_id=po_id, p_line_ids=line_ids, p_action=action)
    if reason is not None:
        args["p_reason"] = reason
    return call(user, "set_vendor_purchase_order_line_state", **args)


def entry(line: str, quantity, *, location: str | None = None, quantity_unit: str = "purchase",
          heat: str | None = None, lot: str | None = None, close_remaining: bool | None = None,
          notes: str | None = None) -> dict:
    found = {"line_id": line, "quantity": quantity, "quantity_unit": quantity_unit}
    for key, value in (("location_id", location), ("heat_number", heat), ("lot_id", lot),
                       ("close_remaining", close_remaining), ("notes", notes)):
        if value is not None:
            found[key] = value
    return found


def receive_args(po_id: str, entries: list[dict], *, group: str | None = None,
                 received_at: str = RECEIVED_AT, packing_slip: str | None = None) -> dict:
    args = dict(p_id=po_id, p_receipt_group_id=group or str(uuid.uuid4()), p_receipts=entries,
                p_received_at=received_at)
    if packing_slip is not None:
        args["p_vendor_packing_slip"] = packing_slip
    return args


def receive(user: str, po_id: str, entries: list[dict], **kw):
    return call(user, "receive_vendor_purchase_order", **receive_args(po_id, entries, **kw))


def void_receipt(user: str, receipt_id: str, reason: str | None = None):
    args = dict(p_receipt_id=receipt_id)
    if reason is not None:
        args["p_reason"] = reason
    return call(user, "void_vendor_purchase_order_receipt", **args)


def po_row(db, po_id: str) -> dict:
    return row(db, "SELECT * FROM public.vendor_purchase_orders WHERE id = %s", (po_id,))


def lines_of(db, po_id: str) -> list[dict]:
    return rows(db, """
        SELECT * FROM public.vendor_purchase_order_lines
         WHERE vendor_purchase_order_id = %s ORDER BY line_number""", (po_id,))


def line_row(db, line_id: str) -> dict:
    return row(db, "SELECT * FROM public.vendor_purchase_order_lines WHERE id = %s", (line_id,))


def receipts_of(db, po_id: str) -> list[dict]:
    return rows(db, """
        SELECT * FROM public.vendor_purchase_order_receipts
         WHERE vendor_purchase_order_id = %s ORDER BY created_at, entry_index""", (po_id,))


def revisions_of(db, po_id: str) -> list[dict]:
    return rows(db, """
        SELECT * FROM public.vendor_purchase_order_revisions
         WHERE vendor_purchase_order_id = %s ORDER BY revision""", (po_id,))


def po_status(db, po_id: str) -> dict:
    return row(db, "SELECT * FROM public.vendor_purchase_order_status WHERE id = %s", (po_id,))


def line_status(db, line_id: str) -> dict:
    return row(db, "SELECT * FROM public.vendor_purchase_order_line_status WHERE id = %s", (line_id,))


def updated_at_text(db, po_id: str) -> str:
    """`updated_at` exactly as PostgREST serialises it — the string the form loaded and passes
    back unchanged (§3.3: `p_expected_updated_at text`; `toISOString` would drop microseconds)."""
    return scalar(db, "SELECT to_json(updated_at) #>> '{}' FROM public.vendor_purchase_orders WHERE id = %s",
                  (po_id,))


def on_order(db, part: str) -> dict:
    """The `part_on_order` row, or zeros for a part with nothing on any PO."""
    found = row(db, "SELECT * FROM public.part_on_order WHERE part_id = %s", (part,))
    return found or {"on_order_quantity": 0, "on_draft_quantity": 0, "unit_mismatch_line_count": 0}


# ── Stock ───────────────────────────────────────────────────────────────────────────────────────


def balance(db, part: str, location: str, lot: str | None = None) -> Decimal:
    if lot is None:
        sql, params = ("SELECT COALESCE(sum(quantity), 0) FROM public.part_location_stock"
                       " WHERE part_id = %s AND location_id = %s"), (part, location)
    else:
        sql, params = ("SELECT COALESCE(sum(quantity), 0) FROM public.part_location_stock"
                       " WHERE part_id = %s AND location_id = %s AND lot_id = %s"), (part, location, lot)
    return scalar(db, sql, params)


def part_quantity(db, part: str) -> Decimal:
    return scalar(db, "SELECT quantity FROM public.parts WHERE id = %s", (part,))


def ledger_row(db, transaction_id: str) -> dict:
    return row(db, "SELECT * FROM public.inventory_transactions WHERE id = %s", (transaction_id,))


def lot_row(db, lot_id: str) -> dict:
    return row(db, "SELECT * FROM public.material_lots WHERE id = %s", (lot_id,))


def lot_tracked(db, part: str) -> bool:
    return scalar(db, "SELECT lot_tracked FROM public.parts WHERE id = %s", (part,))


def tiers(db, part: str) -> list[dict]:
    return rows(db, """
        SELECT id, quantity, cost_per_unit, markup_percent FROM public.part_pricing_tiers
         WHERE part_id = %s ORDER BY quantity""", (part,))


# ── Outside processing ──────────────────────────────────────────────────────────────────────────


def send_outside(user: str, operation: str, quantity, **kw) -> tuple[str, str]:
    """`create_outside_shipment`, unchanged 8-argument signature → (shipment_id, slip_number)."""
    sent = call(user, "create_outside_shipment", p_job_operation_id=operation, p_quantity=quantity, **kw)
    return str(sent[0]), sent[1]


def slip_row(db, slip: str) -> dict:
    return row(db, "SELECT * FROM public.outside_shipments WHERE id = %s", (slip,))


def slip_link(db, slip: str) -> str | None:
    found = scalar(db, "SELECT vendor_purchase_order_line_id FROM public.outside_shipments WHERE id = %s", (slip,))
    return str(found) if found else None


def receive_slip(db, user: str, slip: str, good) -> None:
    """Receiving outside work is the browser's plain INSERT, deliberately not an RPC."""
    s = slip_row(db, slip)
    sql_as(user, """
        INSERT INTO public.outside_shipment_receipts
            (company_id, outside_shipment_id, job_operation_id, job_part_id, quantity_good, received_by)
        VALUES (%s, %s, %s, %s, %s, %s)""",
        (s["company_id"], slip, s["job_operation_id"], s["job_part_id"], good, user))


def close_slip(user: str, slip: str) -> None:
    """Short-close: the browser's column-scoped UPDATE."""
    sql_as(user, "UPDATE public.outside_shipments SET closed_at = now(), closed_by = %s WHERE id = %s",
           (user, slip))


def void_slip(user: str, slip: str):
    return call(user, "void_outside_shipment", p_shipment_id=slip)


def relink(user: str, slip: str, line: str | None):
    return call(user, "set_outside_shipment_vendor_purchase_order_line", **relink_args(slip, line))


def relink_args(slip: str, line: str | None) -> dict:
    """§3.3 writes it `(p_slip, p_line|null)`; the argument names are the Database architect's."""
    return dict(p_outside_shipment_id=slip, p_vendor_purchase_order_line_id=line)


def operation_row(db, operation: str) -> dict:
    return row(db, "SELECT * FROM public.job_operations WHERE id = %s", (operation,))


# ── Approved vendors and price sheets ──────────────────────────────────────────────────────────


def part_vendor_args(part: str, vendor: str, changes: dict | None = None, breaks: list | None = None,
                     make_preferred: bool = False) -> dict:
    return dict(p_part_id=part, p_vendor_id=vendor, p_changes=changes or {},
                p_price_breaks=breaks, p_make_preferred=make_preferred)


def save_avl(user: str, part: str, vendor: str, changes: dict | None = None,
             breaks: list | None = None, make_preferred: bool = False):
    return call(user, "save_part_vendor", **part_vendor_args(part, vendor, changes, breaks, make_preferred))


def avl_row(db, part: str, vendor: str) -> dict | None:
    return row(db, "SELECT * FROM public.part_vendors WHERE part_id = %s AND vendor_id = %s", (part, vendor))


def breaks_of(db, part_vendor: str) -> list[dict]:
    return rows(db, """
        SELECT * FROM public.part_vendor_price_breaks WHERE part_vendor_id = %s ORDER BY min_quantity""",
        (part_vendor,))


def preferred_vendor(db, part: str) -> str | None:
    found = scalar(db, "SELECT preferred_vendor_id FROM public.parts WHERE id = %s", (part,))
    return str(found) if found else None


# ── RFQs ────────────────────────────────────────────────────────────────────────────────────────


def rfq_part_line(part: str, unit: str, quantities: list, *, description: str = "Material", **extra) -> dict:
    return {"part_id": part, "description": description, "unit": unit, "quantities": quantities, **extra}


def rfq_adhoc_line(description: str, quantities: list | None = None, *, unit: str = "each", **extra) -> dict:
    return {"description": description, "unit": unit,
            "quantities": [10] if quantities is None else quantities, **extra}


def rfq_create_args(company: str, lines: list[dict], vendor_ids: list[str], *, title: str = "Request") -> dict:
    """`create_vendor_rfq(p_company_id, p_header, p_lines, p_vendor_ids)` — the same header-as-
    jsonb shape §3.3 gives `create_vendor_purchase_order`."""
    return dict(p_company_id=company, p_header={"title": title}, p_lines=lines, p_vendor_ids=vendor_ids)


def create_rfq(user: str, company: str, lines: list[dict], vendor_ids: list[str], **kw) -> tuple[str, str]:
    """`create_vendor_rfq` → (id, rfq_number), read by position."""
    created = call(user, "create_vendor_rfq", **rfq_create_args(company, lines, vendor_ids, **kw))
    return str(created[0]), created[1]


def rfq_row(db, rfq: str) -> dict:
    return row(db, "SELECT * FROM public.vendor_rfqs WHERE id = %s", (rfq,))


def rfq_lines_of(db, rfq: str) -> list[dict]:
    return rows(db, "SELECT * FROM public.vendor_rfq_lines WHERE vendor_rfq_id = %s ORDER BY line_number", (rfq,))


def invitations_of(db, rfq: str) -> dict[str, dict]:
    """vendor_id → invitation row."""
    return {str(r["vendor_id"]): r for r in rows(
        db, "SELECT * FROM public.vendor_rfq_invitations WHERE vendor_rfq_id = %s", (rfq,))}


def responses_of(db, rfq: str) -> list[dict]:
    return rows(db, """
        SELECT * FROM public.vendor_rfq_responses WHERE vendor_rfq_id = %s ORDER BY created_at, quantity""", (rfq,))


def rfq_status(db, rfq: str) -> str | None:
    return scalar(db, "SELECT status FROM public.vendor_rfq_status WHERE id = %s", (rfq,))


def rfq_updated_at_text(db, rfq: str) -> str:
    return scalar(db, "SELECT to_json(updated_at) #>> '{}' FROM public.vendor_rfqs WHERE id = %s", (rfq,))


def set_invitation(user: str, invitation: str, action: str, *, reason: str | None = None):
    args = dict(p_id=invitation, p_action=action)
    if reason is not None:
        args["p_reason"] = reason
    return call(user, "set_vendor_rfq_invitation_state", **args)


def save_responses(user: str, invitation: str, responses: list[dict]):
    return call(user, "save_vendor_rfq_responses", p_invitation_id=invitation, p_responses=responses)


def award_args(rfq: str, response_ids: list[str], *, save_to_sheets: bool = False, today=TODAY) -> dict:
    return dict(p_rfq_id=rfq, p_response_ids=response_ids, p_save_to_price_sheets=save_to_sheets, p_today=today)


def award(user: str, rfq: str, response_ids: list[str], **kw):
    return call(user, "award_vendor_rfq", **award_args(rfq, response_ids, **kw))


def save_rfq(db, user: str, rfq: str, *, changes: dict | None = None, **kw):
    return call(user, "save_vendor_rfq", p_id=rfq, p_changes=changes or {},
                p_expected_updated_at=rfq_updated_at_text(db, rfq), **kw)


def set_rfq_state(user: str, rfq: str, action: str):
    return call(user, "set_vendor_rfq_state", p_id=rfq, p_action=action)


# ── QuickBooks rows (only the service role writes these) ──────────────────────────────────────


def insert_qbo_connection(db, shop: Shop, realm: str) -> str:
    return scalar(db, """
        INSERT INTO quickbooks_connections (company_id, realm_id, access_token, refresh_token, access_expires_at)
        VALUES (%s, %s, 'test-access', 'test-refresh', now() + interval '1 hour') RETURNING id""",
        (shop.company, realm))


def insert_qbd_connection(db, shop: Shop, end_user: str) -> str:
    return scalar(db, """
        INSERT INTO quickbooks_desktop_connections (company_id, conductor_end_user_id)
        VALUES (%s, %s) RETURNING id""", (shop.company, end_user))


def insert_vendor_map(db, shop: Shop, vendor: str, realm: str, *, provider: str = "qbo") -> str:
    return scalar(db, """
        INSERT INTO quickbooks_vendor_map (company_id, vendor_id, provider, realm_id, qb_vendor_id, qb_display_name)
        VALUES (%s, %s, %s, %s, '58', 'Atlas Metals') RETURNING id""", (shop.company, vendor, provider, realm))


# §3.2 says only "FKs to the QBO and QBD connection rows, exactly one of them set". The Database
# architect named them qbo_/qbd_connection_id; naming them after the tables they reference is
# just as valid. These tests assert the BEHAVIOUR (cascade, exactly one), so they accept either.
_SETUP_CONNECTION_COLUMNS = (
    ("quickbooks_connection_id", "quickbooks_desktop_connection_id"),
    ("qbo_connection_id", "qbd_connection_id"),
)


def setup_connection_columns(db) -> tuple[str, str]:
    """(QBO column, QBD column) on quickbooks_purchasing_setup."""
    present = {r["column_name"] for r in rows(db, """
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'quickbooks_purchasing_setup'""")}
    for pair in _SETUP_CONNECTION_COLUMNS:
        if set(pair) <= present:
            return pair
    pytest.fail(f"quickbooks_purchasing_setup has no QBO/QBD connection columns: {sorted(present)}")


def insert_setup(db, shop: Shop, *, qbo_connection: str | None = None, qbd_connection: str | None = None,
                 setup_key: str = "item:part", realm: str = "realm-po-1") -> str:
    qbo_column, qbd_column = setup_connection_columns(db)
    return scalar(db, f"""
        INSERT INTO quickbooks_purchasing_setup
            (company_id, provider, realm_id, {qbo_column}, {qbd_column}, setup_key, qb_id, qb_name)
        VALUES (%s, %s, %s, %s, %s, %s, '19', 'Purchases') RETURNING id""",
        (shop.company, "qbo" if qbo_connection else "qbd", realm, qbo_connection, qbd_connection, setup_key))


def insert_po_link(db, shop: Shop, po_id: str, *, realm: str = "realm-po-1", status: str = "created",
                   qb_po_id: str | None = "1043", pushed_content_version: int | None = None,
                   request_id: str | None = None, provider: str = "qbo", **extra) -> str:
    """A link row as the push route writes it. `extra` adds columns (e.g. last_failure)."""
    columns = {
        "company_id": shop.company, "vendor_purchase_order_id": po_id, "provider": provider,
        "realm_id": realm, "qb_request_id": request_id or str(uuid.uuid4()), "operation": "create",
        "status": status, "qb_po_id": qb_po_id, "pushed_content_version": pushed_content_version, **extra,
    }
    names = ", ".join(columns)
    placeholders = ", ".join(["%s"] * len(columns))
    return scalar(db, f"INSERT INTO quickbooks_purchase_order_links ({names}) VALUES ({placeholders}) RETURNING id",
                  list(columns.values()))


def insert_line_link(db, shop: Shop, link: str, line: str) -> str:
    return scalar(db, """
        INSERT INTO quickbooks_purchase_order_line_links (company_id, link_id, vendor_purchase_order_line_id, qb_line_id, qb_item_id)
        VALUES (%s, %s, %s, '1', '19') RETURNING id""", (shop.company, link, line))


# ── A populated purchasing graph, for the access, guard and AI tests ──────────────────────────


@dataclass
class World:
    po: Po               # sent: BAR (feet) · freight (other, no receipt) · anodize (outside)
    bar_line: str
    freight_line: str
    outside_line: str
    draft: Po            # a second PO in the same company: one SCREW line
    receipt: str         # 4 ft received on bar_line
    slip: str            # 100 WIDGETs out, auto-linked to outside_line
    avl: str             # (BAR, V1) in feet, two breaks
    screw_lot: str       # a SCREW heat, for "another part's lot"
    rfq: str             # BAR × [10, 50] to V1 and V2; V1 sent and quoted
    rfq_line: str
    invitation_v1: str
    invitation_v2: str
    response: str        # V1's price at 10
    rfq2: str            # a second RFQ in the same company, quoted by V1
    rfq2_line: str
    rfq2_invitation: str
    rfq2_response: str
    archived_po: Po      # sent, received, then archived
    archived_avl: str    # (SCREW, V2) with a break, archived
    archived_rfq: str


def build_world(db, shop: Shop) -> World:
    a = shop.admin
    save_avl(a, shop.bar, shop.v1, {"purchase_unit": "feet", "lead_time_days": 5},
             breaks=[{"min_quantity": 10, "unit_price": 24}, {"min_quantity": 100, "unit_price": 18}])
    avl = str(avl_row(db, shop.bar, shop.v1)["id"])

    po = make_po(db, shop, [
        part_line(shop.bar, 10, "feet", unit_price=24, price_source="price_sheet", description="4140 bar"),
        other_line("Freight", unit_price=45, expects_receipt=False),
        outside_line(shop.outside_op, 100),
    ], sent=True)
    draft = make_po(db, shop, [part_line(shop.screw, 2.5, "hundred", unit_price=12, description="M5 screws")])
    slip, _ = send_outside(a, shop.outside_op, 100)
    receive(a, po.id, [entry(po.lines[0], 4, location=shop.shelf)])
    receipt = str(receipts_of(db, po.id)[0]["id"])
    added = call(a, "add_stock_at_location", p_part_id=shop.screw, p_location_id=shop.shelf,
                 p_quantity=50, p_unit="each", p_converted_quantity=50, p_heat_number="S-1")
    screw_lot = str(added["lot_id"])

    rfq, _ = create_rfq(a, shop.company, [rfq_part_line(shop.bar, "feet", [10, 50])], [shop.v1, shop.v2])
    rfq_line = str(rfq_lines_of(db, rfq)[0]["id"])
    invitations = invitations_of(db, rfq)
    set_invitation(a, str(invitations[shop.v1]["id"]), "mark_sent")
    save_responses(a, str(invitations[shop.v1]["id"]),
                   [{"line_id": rfq_line, "quantity": 10, "unit_price": 23, "lead_time_days": 7}])
    response = str(responses_of(db, rfq)[0]["id"])

    rfq2, _ = create_rfq(a, shop.company, [rfq_adhoc_line("Saw-cut blanks", [20])], [shop.v1], title="Blanks")
    rfq2_line = str(rfq_lines_of(db, rfq2)[0]["id"])
    rfq2_invitation = str(invitations_of(db, rfq2)[shop.v1]["id"])
    set_invitation(a, rfq2_invitation, "mark_sent")
    save_responses(a, rfq2_invitation, [{"line_id": rfq2_line, "quantity": 20, "unit_price": 6}])
    rfq2_response = str(responses_of(db, rfq2)[0]["id"])

    archived_po = make_po(db, shop, [part_line(shop.bar, 2, "feet", description="Old order")], sent=True)
    receive(a, archived_po.id, [entry(archived_po.lines[0], 1, location=shop.shelf)])
    set_state(a, archived_po.id, "archive")
    save_avl(a, shop.screw, shop.v2, {"purchase_unit": "hundred"}, breaks=[{"min_quantity": 1, "unit_price": 12}])
    archived_avl = str(avl_row(db, shop.screw, shop.v2)["id"])
    call(a, "archive_part_vendor", p_part_vendor_id=archived_avl)
    archived_rfq, _ = create_rfq(a, shop.company, [rfq_adhoc_line("Old request")], [shop.v2], title="Old")
    set_rfq_state(a, archived_rfq, "archive")

    return World(
        po=po, bar_line=po.lines[0], freight_line=po.lines[1], outside_line=po.lines[2],
        draft=draft, receipt=receipt, slip=slip, avl=avl, screw_lot=screw_lot,
        rfq=rfq, rfq_line=rfq_line, invitation_v1=str(invitations[shop.v1]["id"]),
        invitation_v2=str(invitations[shop.v2]["id"]), response=response,
        rfq2=rfq2, rfq2_line=rfq2_line, rfq2_invitation=rfq2_invitation, rfq2_response=rfq2_response,
        archived_po=archived_po, archived_avl=archived_avl, archived_rfq=archived_rfq,
    )


def wait_until_blocked(db, pid: int, timeout: float = 10.0) -> bool:
    """True once backend `pid` is waiting on a lock — the proof that a second create queued."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        waiting = scalar(db, "SELECT wait_event_type FROM pg_stat_activity WHERE pid = %s", (pid,))
        if waiting == "Lock":
            return True
        time.sleep(0.05)
    return False
