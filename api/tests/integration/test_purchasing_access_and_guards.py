"""Who may write purchasing data, and what the database refuses on its own (plan §3.2, §3.3, §3.12; S1–S6, M5).

WHAT THIS GUARDS. Every purchasing write is a SECURITY DEFINER RPC — the browser holds SELECT
and nothing else — and SECURITY DEFINER bypasses RLS. So each door has to do, in its own body,
what a policy would otherwise do for it, in this order (§3.3):

  1. derive the company from the record (or the vendor), never trust a `p_company_id` except
     for RFQ create and the settings save;
  2. `assert_office_member`: not found or not a member is P0001 "That record is not
     available." — the same sentence, so the door cannot probe for a record — and an
     operator is 42501 "This is an office task…";
  3. the literal `company_can_write` check: 42501 for a lapsed company, in the shape the UI
     recognises as billing;
  4. lock the header; 5. scope EVERY id inside arrays and jsonb to this document;
  6. pre-validate every CHECK as a sentence; 7. take `p_today` from the caller.

This file asserts each of those across every writer (S1–S3), the absence of any browser table
write (S4), every CI guard (S5), what the insights AI may read (M5), and that one company DELETE
removes the whole purchasing graph (S6).

Run:
    cd api && pytest -m integration tests/integration/test_purchasing_access_and_guards.py
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import pytest
from psycopg2 import errors

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, shop  # noqa: F401

pytestmark = pytest.mark.integration


@dataclass
class Guarded:
    db: Any
    shop: ps.Shop
    stranger: ps.Shop
    world: ps.World
    stranger_world: ps.World


@pytest.fixture(scope="module")
def guarded():
    """One populated company and one stranger, shared by the module. Safe to share because
    every test here only REFUSES — `ps.refuse` never commits — or reads."""
    conn = ps.connect()
    conn.autocommit = True
    built: list[ps.Shop] = []
    try:
        shop_ = ps.build_shop(conn, "Guarded")
        built.append(shop_)
        stranger = ps.build_shop(conn, "Stranger")
        built.append(stranger)
        yield Guarded(conn, shop_, stranger, ps.build_world(conn, shop_), ps.build_world(conn, stranger))
    finally:
        failures = []
        for each in reversed(built):
            try:
                ps.drop_shop(conn, each)
            except BaseException as exc:  # noqa: BLE001 - drop both, then report
                failures.append(exc)
        conn.close()
        if failures:
            raise failures[0]


def _writer_calls(g: Guarded) -> dict[str, dict]:
    """A VALID call of every writer against the guarded company — so a refusal below can only
    be about who is calling."""
    s, w = g.shop, g.world
    return {
        "create_vendor_purchase_order": ps.create_args(s.v1, [ps.other_line("Freight")]),
        "save_vendor_purchase_order": ps.save_args(w.po.id, changes={"internal_notes": "Called"}),
        "set_vendor_purchase_order_state": dict(p_id=w.po.id, p_action="close", p_today=ps.TODAY),
        "set_vendor_purchase_order_line_state": dict(p_id=w.po.id, p_line_ids=[w.bar_line], p_action="close"),
        "receive_vendor_purchase_order": ps.receive_args(w.po.id, [ps.entry(w.bar_line, 1, location=s.shelf)]),
        "void_vendor_purchase_order_receipt": dict(p_receipt_id=w.receipt),
        "set_outside_shipment_vendor_purchase_order_line": ps.relink_args(w.slip, None),
        "save_part_vendor": ps.part_vendor_args(s.bar, s.v1, {"purchase_unit": "feet", "lead_time_days": 9}),
        "archive_part_vendor": dict(p_part_vendor_id=w.avl),
        "apply_part_cost_from_vendor": dict(p_part_vendor_id=w.avl, p_today=ps.TODAY, p_expected={}),
        "save_purchasing_document_settings": dict(p_company_id=s.company, p_kind="vendor_purchase_order",
                                                  p_changes={"next_number": 500}),
        "create_vendor_rfq": ps.rfq_create_args(s.company, [ps.rfq_adhoc_line("Anodize brackets")], [s.v1]),
        "save_vendor_rfq": dict(p_id=w.rfq, p_changes={"title": "Renamed"},
                                p_expected_updated_at=ps.rfq_updated_at_text(g.db, w.rfq)),
        "set_vendor_rfq_state": dict(p_id=w.rfq, p_action="close"),
        "set_vendor_rfq_invitation_state": dict(p_id=w.invitation_v2, p_action="decline"),
        "save_vendor_rfq_responses": dict(p_invitation_id=w.invitation_v1,
                                          p_responses=[{"line_id": w.rfq_line, "quantity": 10, "unit_price": 22}]),
        "award_vendor_rfq": ps.award_args(w.rfq, [w.response]),
    }


# The record each writer derives its company from (§3.3 step 1).
ROOTS = {
    "create_vendor_purchase_order": ("p_vendor_id",),
    "save_vendor_purchase_order": ("p_id",),
    "set_vendor_purchase_order_state": ("p_id",),
    "set_vendor_purchase_order_line_state": ("p_id",),
    "receive_vendor_purchase_order": ("p_id",),
    "void_vendor_purchase_order_receipt": ("p_receipt_id",),
    "set_outside_shipment_vendor_purchase_order_line": ("p_outside_shipment_id",),
    "save_part_vendor": ("p_part_id", "p_vendor_id"),
    "archive_part_vendor": ("p_part_vendor_id",),
    "apply_part_cost_from_vendor": ("p_part_vendor_id",),
    "save_purchasing_document_settings": ("p_company_id",),
    "create_vendor_rfq": ("p_company_id",),
    "save_vendor_rfq": ("p_id",),
    "set_vendor_rfq_state": ("p_id",),
    "set_vendor_rfq_invitation_state": ("p_id",),
    "save_vendor_rfq_responses": ("p_invitation_id",),
    "award_vendor_rfq": ("p_rfq_id",),
}


def test_the_writer_list_is_the_contract(guarded):
    """[S1] The parametrization below covers every write door §3.3 names, no more, no less."""
    assert set(_writer_calls(guarded)) == set(ps.WRITER_RPCS) == set(ROOTS)


# ── S1: roles, membership and the sentence for each ───────────────────────────────────────────


@pytest.mark.parametrize("name", ps.WRITER_RPCS)
def test_an_operator_is_refused_by_every_purchasing_writer(guarded, name):
    """[S1] 42501 "This is an office task…" — from the database, not just the UI and MCP."""
    ps.assert_office_only(ps.refuse(guarded.shop.operator, name, **_writer_calls(guarded)[name]))


@pytest.mark.parametrize("name", ps.WRITER_RPCS)
def test_a_member_of_another_company_is_told_the_record_is_not_available(guarded, name):
    """[S1, S3] P0001 "That record is not available." for a real record in someone else's company."""
    ps.assert_not_available(ps.refuse(guarded.stranger.admin, name, **_writer_calls(guarded)[name]))


@pytest.mark.parametrize("name", ps.WRITER_RPCS)
def test_a_missing_record_reads_exactly_like_a_foreign_one(guarded, name):
    """[S1] Same SQLSTATE, same sentence: the door cannot be used to learn that an id exists."""
    args = _writer_calls(guarded)[name]
    for key in ROOTS[name]:
        args[key] = str(uuid.uuid4())
    ps.assert_not_available(ps.refuse(guarded.shop.admin, name, **args))


@pytest.mark.parametrize("name", ps.WRITER_RPCS)
def test_every_writer_is_one_definer_function_the_browser_can_call_and_anon_cannot(db, name):
    """[S1] One overload (PostgREST resolves by name), SECURITY DEFINER, EXECUTE for
    authenticated and not for anon."""
    found = ps.rows(db, """
        SELECT p.prosecdef AS definer,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS browser,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = %s""", (name,))
    assert len(found) == 1, f"{name} has {len(found)} overloads"
    assert found[0] == {"definer": True, "browser": True, "anon": False}


@pytest.mark.parametrize("name", ps.WRITER_RPCS)
def test_every_writer_asserts_the_office_role_and_the_billing_gate_in_its_own_body(db, name):
    """[S1, S2] Steps 2 and 3, by text: `definer_writers_missing_write_gate` matches the literal
    `company_can_write`, so hoisting it into a helper would turn that guard red for a reason no
    error message names."""
    body = ps.scalar(db, """
        SELECT pg_get_functiondef(p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = %s""", (name,))
    assert "assert_office_member" in body and "company_can_write" in body


@pytest.mark.parametrize("name, ai", [("is_vendor_purchase_order_late", True), ("vendor_po_line_amount", True),
                                      ("preview_part_cost_from_vendor", False)])
def test_the_read_functions_run_as_their_caller_and_the_browser_can_call_them(db, name, ai):
    """[S1, M5] SECURITY INVOKER reads; the two definitions are the insights AI's as well."""
    found = ps.rows(db, """
        SELECT p.prosecdef AS definer,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS browser,
               has_function_privilege('jigged_ai_readonly', p.oid, 'EXECUTE') AS ai
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = %s""", (name,))
    assert len(found) == 1
    assert found[0]["definer"] is False and found[0]["browser"] is True
    if ai:
        assert found[0]["ai"] is True


def test_no_internal_purchasing_helper_is_reachable_from_the_browser(db):
    """[S1] The assertion helper, the trigger, the number minter, the snapshot and document
    builders: none is executable by anon or authenticated. Policed by name pattern, so a helper
    nobody listed is still caught."""
    found = ps.rows(db, """
        SELECT p.proname,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS browser
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND (p.proname ~ %s OR p.proname IN ('company_address_block_snapshot', 'next_purchasing_document_number'))""",
        (ps.PURCHASING_FUNCTION_PATTERN,))
    names = {r["proname"] for r in found}
    assert {"assert_office_member", "ensure_preferred_vendor_is_listed"} <= names
    public = set(ps.WRITER_RPCS) | set(ps.READ_FUNCTIONS)
    leaks = sorted(r["proname"] for r in found if r["proname"] not in public and (r["anon"] or r["browser"]))
    assert leaks == [], f"internal purchasing functions the browser can execute: {leaks}"


# ── S2: a lapsed company ───────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("name", ps.WRITER_RPCS)
def test_a_lapsed_company_is_refused_by_every_writer_with_nothing_written(guarded, name):
    """[S2] 42501 in the billing shape, from an admin with every other right, and the company's
    purchasing and stock rows exactly as they were."""
    g = guarded
    before = ps.footprint(g.db, g.shop.company)
    ps.execute(g.db, "UPDATE company_billing SET billing_exempt = false WHERE company_id = %s", (g.shop.company,))
    try:
        err = ps.refuse(g.shop.admin, name, **_writer_calls(g)[name])
    finally:
        ps.execute(g.db, "UPDATE company_billing SET billing_exempt = true WHERE company_id = %s", (g.shop.company,))
    ps.assert_billing_blocked(err)
    assert ps.footprint(g.db, g.shop.company) == before


# ── S3: ids from another document or another company ──────────────────────────────────────────


def _cross(user, name, args, watch=None, expect="sentence"):
    return user, name, args, watch, expect


S3_CASES = {
    "create:another-companys-part": lambda g: _cross(
        g.shop.admin, "create_vendor_purchase_order", ps.create_args(g.shop.v1, [ps.part_line(g.stranger.bar, 1, "feet")])),
    "create:another-companys-operation": lambda g: _cross(
        g.shop.admin, "create_vendor_purchase_order",
        ps.create_args(g.shop.v1, [ps.outside_line(g.stranger.outside_op, 10)])),
    "create:another-companys-machine": lambda g: _cross(
        g.shop.admin, "create_vendor_purchase_order",
        ps.create_args(g.shop.v1, [ps.other_line("Rebuild", work_center_id=g.stranger.work_center)])),
    "create:another-companys-job": lambda g: _cross(
        g.shop.admin, "create_vendor_purchase_order",
        ps.create_args(g.shop.v1, [ps.part_line(g.shop.bar, 1, "feet", job_id=g.stranger.job)])),
    "create:another-companys-customer-as-ship-to": lambda g: _cross(
        g.shop.admin, "create_vendor_purchase_order",
        ps.create_args(g.shop.v1, [ps.other_line()], header=ps.ship_to(
            "customer", customer_id=g.stranger.customer, customer_address_id=g.stranger.customer_address))),
    "save:a-line-of-another-po": lambda g: _cross(
        g.shop.admin, "save_vendor_purchase_order",
        ps.save_args(g.world.po.id, lines=[{"id": g.world.draft.lines[0], "quantity": 99}],
                     expected=ps.updated_at_text(g.db, g.world.po.id)),
        ("vendor_purchase_order_lines", g.world.draft.lines[0])),
    "save:a-line-of-another-company": lambda g: _cross(
        g.shop.admin, "save_vendor_purchase_order",
        ps.save_args(g.world.po.id, lines=[{"id": g.stranger_world.draft.lines[0], "quantity": 99}],
                     expected=ps.updated_at_text(g.db, g.world.po.id)),
        ("vendor_purchase_order_lines", g.stranger_world.draft.lines[0])),
    "save:removing-a-line-of-another-po": lambda g: _cross(
        g.shop.admin, "save_vendor_purchase_order",
        ps.save_args(g.world.po.id, removed=[g.world.draft.lines[0]], expected=ps.updated_at_text(g.db, g.world.po.id)),
        ("vendor_purchase_order_lines", g.world.draft.lines[0])),
    "save:removing-a-line-of-another-company": lambda g: _cross(
        g.shop.admin, "save_vendor_purchase_order",
        ps.save_args(g.world.po.id, removed=[g.stranger_world.draft.lines[0]],
                     expected=ps.updated_at_text(g.db, g.world.po.id)),
        ("vendor_purchase_order_lines", g.stranger_world.draft.lines[0])),
    "close:a-line-of-another-po": lambda g: _cross(
        g.shop.admin, "set_vendor_purchase_order_line_state",
        dict(p_id=g.world.po.id, p_line_ids=[g.world.bar_line, g.world.draft.lines[0]], p_action="close"),
        ("vendor_purchase_order_lines", g.world.draft.lines[0])),
    "close:a-line-of-another-company": lambda g: _cross(
        g.shop.admin, "set_vendor_purchase_order_line_state",
        dict(p_id=g.world.po.id, p_line_ids=[g.stranger_world.bar_line], p_action="close"),
        ("vendor_purchase_order_lines", g.stranger_world.bar_line)),
    "receive:a-line-of-another-po": lambda g: _cross(
        g.shop.admin, "receive_vendor_purchase_order",
        ps.receive_args(g.world.po.id, [ps.entry(g.world.draft.lines[0], 1, location=g.shop.shelf)])),
    "receive:a-line-of-another-company": lambda g: _cross(
        g.shop.admin, "receive_vendor_purchase_order",
        ps.receive_args(g.world.po.id, [ps.entry(g.stranger_world.bar_line, 1, location=g.shop.shelf)])),
    "receive:into-another-companys-place": lambda g: _cross(
        g.shop.admin, "receive_vendor_purchase_order",
        ps.receive_args(g.world.po.id, [ps.entry(g.world.bar_line, 1, location=g.stranger.shelf)])),
    "receive:into-another-parts-lot": lambda g: _cross(
        g.shop.admin, "receive_vendor_purchase_order",
        ps.receive_args(g.world.po.id, [ps.entry(g.world.bar_line, 1, location=g.shop.shelf, lot=g.world.screw_lot)])),
    "void:a-receipt-of-another-company": lambda g: _cross(
        g.shop.admin, "void_vendor_purchase_order_receipt", dict(p_receipt_id=g.stranger_world.receipt),
        ("vendor_purchase_order_receipts", g.stranger_world.receipt), expect="not_available"),
    "relink:a-slip-of-another-company": lambda g: _cross(
        g.shop.admin, "set_outside_shipment_vendor_purchase_order_line",
        ps.relink_args(g.stranger_world.slip, g.world.outside_line),
        ("outside_shipments", g.stranger_world.slip), expect="not_available"),
    "relink:to-a-line-of-another-company": lambda g: _cross(
        g.shop.admin, "set_outside_shipment_vendor_purchase_order_line",
        ps.relink_args(g.world.slip, g.stranger_world.outside_line), ("outside_shipments", g.world.slip)),
    "part-vendor:another-companys-vendor": lambda g: _cross(
        g.shop.admin, "save_part_vendor", ps.part_vendor_args(g.shop.bar, g.stranger.v1, {"purchase_unit": "feet"})),
    "rfq:another-companys-vendor": lambda g: _cross(
        g.shop.admin, "create_vendor_rfq",
        ps.rfq_create_args(g.shop.company, [ps.rfq_adhoc_line("Brackets")], [g.stranger.v1])),
    "rfq:another-companys-part": lambda g: _cross(
        g.shop.admin, "create_vendor_rfq",
        ps.rfq_create_args(g.shop.company, [ps.rfq_part_line(g.stranger.bar, "feet", [10])], [g.shop.v1])),
    "rfq-save:a-line-of-another-rfq": lambda g: _cross(
        g.shop.admin, "save_vendor_rfq",
        dict(p_id=g.world.rfq, p_changes={}, p_lines=[{"id": g.world.rfq2_line, "description": "Taken over"}],
             p_expected_updated_at=ps.rfq_updated_at_text(g.db, g.world.rfq)),
        ("vendor_rfq_lines", g.world.rfq2_line)),
    "rfq-save:removing-a-line-of-another-rfq": lambda g: _cross(
        g.shop.admin, "save_vendor_rfq",
        dict(p_id=g.world.rfq, p_changes={}, p_removed_line_ids=[g.world.rfq2_line],
             p_expected_updated_at=ps.rfq_updated_at_text(g.db, g.world.rfq)),
        ("vendor_rfq_lines", g.world.rfq2_line)),
    "rfq-save:removing-an-invitation-of-another-rfq": lambda g: _cross(
        g.shop.admin, "save_vendor_rfq",
        dict(p_id=g.world.rfq, p_changes={}, p_removed_invitation_ids=[g.world.rfq2_invitation],
             p_expected_updated_at=ps.rfq_updated_at_text(g.db, g.world.rfq)),
        ("vendor_rfq_invitations", g.world.rfq2_invitation)),
    "respond:on-a-line-of-another-rfq": lambda g: _cross(
        g.shop.admin, "save_vendor_rfq_responses",
        dict(p_invitation_id=g.world.invitation_v1,
             p_responses=[{"line_id": g.world.rfq2_line, "quantity": 20, "unit_price": 5}])),
    "award:a-response-of-another-rfq": lambda g: _cross(
        g.shop.admin, "award_vendor_rfq", ps.award_args(g.world.rfq, [g.world.rfq2_response]),
        ("vendor_rfq_responses", g.world.rfq2_response)),
    "award:a-response-of-another-company": lambda g: _cross(
        g.shop.admin, "award_vendor_rfq", ps.award_args(g.world.rfq, [g.stranger_world.response]),
        ("vendor_rfq_responses", g.stranger_world.response)),
}


@pytest.mark.parametrize("case", sorted(S3_CASES))
def test_an_id_from_another_document_or_company_is_refused_and_changes_nothing(guarded, case):
    """[S3] In any argument, array or jsonb entry. The other document — and both companies'
    whole purchasing footprint — is exactly as it was."""
    g = guarded
    user, name, args, watch, expect = S3_CASES[case](g)
    watched_sql = f"SELECT * FROM public.{watch[0]} WHERE id = %s" if watch else None
    watched = ps.row(g.db, watched_sql, (watch[1],)) if watch else None
    before = (ps.footprint(g.db, g.shop.company), ps.footprint(g.db, g.stranger.company))

    err = ps.refuse(user, name, **args)
    if expect == "not_available":
        ps.assert_not_available(err)
    else:
        ps.assert_sentence_refusal(err)

    assert (ps.footprint(g.db, g.shop.company), ps.footprint(g.db, g.stranger.company)) == before
    if watch:
        assert ps.row(g.db, watched_sql, (watch[1],)) == watched


@pytest.mark.parametrize(
    "table, column, target, other, also",
    [
        pytest.param("vendor_purchase_order_receipts", "vendor_purchase_order_id",
                     lambda g: g.world.receipt, lambda g: g.world.draft.id, None, id="a-receipt-onto-another-po"),
        # The line number moves with it: the other PO has a line 1 of its own, and the unique
        # (PO, line number) key would otherwise refuse the move before the foreign key is asked.
        pytest.param("vendor_purchase_order_lines", "vendor_purchase_order_id",
                     lambda g: g.world.draft.lines[0], lambda g: g.stranger_world.draft.id,
                     ("line_number", 9999), id="a-line-onto-another-companys-po"),
        pytest.param("vendor_rfq_responses", "vendor_rfq_line_id",
                     lambda g: g.world.response, lambda g: g.world.rfq2_line, None, id="a-response-onto-another-rfqs-line"),
    ],
)
def test_composite_keys_keep_a_child_on_its_own_document(guarded, table, column, target, other, also):
    """[S3] Structural, for every writer: composite foreign keys make a child row on another
    parent, or another company's parent, unrepresentable."""
    g = guarded
    row_id = target(g)
    columns = [column] + ([also[0]] if also else [])
    original = ps.row(g.db, f"SELECT {', '.join(columns)} FROM public.{table} WHERE id = %s", (row_id,))
    moved = [other(g)] + ([also[1]] if also else [])
    assignments = ", ".join(f"{c} = %s" for c in columns)
    try:
        with pytest.raises(errors.ForeignKeyViolation):
            ps.execute(g.db, f"UPDATE public.{table} SET {assignments} WHERE id = %s", (*moved, row_id))
    finally:
        ps.execute(g.db, f"UPDATE public.{table} SET {assignments} WHERE id = %s",
                   (*(original[c] for c in columns), row_id))


# ── §3.3 rule 7 and the jsonb-key rule ─────────────────────────────────────────────────────────


@pytest.mark.parametrize("which", ["create", "award"])
def test_today_comes_from_the_caller_and_is_required(guarded, which):
    """[P7, §3.3 rule 7] Never CURRENT_DATE, which is UTC and a day off every evening in Detroit."""
    g = guarded
    if which == "create":
        ps.refuse(g.shop.admin, "create_vendor_purchase_order", **ps.create_args(g.shop.v1, [ps.other_line()], today=None))
    else:
        ps.refuse(g.shop.admin, "award_vendor_rfq", **ps.award_args(g.world.rfq, [g.world.response], today=None))


UNKNOWN_KEYS = {
    "create-header": lambda g: ("create_vendor_purchase_order",
                                ps.create_args(g.shop.v1, [ps.other_line()], header={"bogus_key": 1})),
    "create-line": lambda g: ("create_vendor_purchase_order",
                              ps.create_args(g.shop.v1, [{**ps.other_line(), "bogus_key": 1}])),
    "save-changes": lambda g: ("save_vendor_purchase_order",
                               ps.save_args(g.world.po.id, changes={"bogus_key": 1},
                                            expected=ps.updated_at_text(g.db, g.world.po.id))),
    "save-line": lambda g: ("save_vendor_purchase_order",
                            ps.save_args(g.world.po.id, lines=[{"id": g.world.bar_line, "bogus_key": 1}],
                                         expected=ps.updated_at_text(g.db, g.world.po.id))),
    "receive-entry": lambda g: ("receive_vendor_purchase_order", ps.receive_args(
        g.world.po.id, [{**ps.entry(g.world.bar_line, 1, location=g.shop.shelf), "bogus_key": 1}])),
    "settings": lambda g: ("save_purchasing_document_settings",
                           dict(p_company_id=g.shop.company, p_kind="vendor_purchase_order", p_changes={"bogus_key": 1})),
    "part-vendor": lambda g: ("save_part_vendor",
                              ps.part_vendor_args(g.shop.bar, g.shop.v1, {"purchase_unit": "feet", "bogus_key": 1})),
    "price-break": lambda g: ("save_part_vendor", ps.part_vendor_args(
        g.shop.bar, g.shop.v1, {"purchase_unit": "feet"}, [{"min_quantity": 1, "unit_price": 2, "bogus_key": 1}])),
    "rfq-line": lambda g: ("create_vendor_rfq", ps.rfq_create_args(
        g.shop.company, [{**ps.rfq_adhoc_line("Brackets"), "bogus_key": 1}], [g.shop.v1])),
    "rfq-response": lambda g: ("save_vendor_rfq_responses", dict(
        p_invitation_id=g.world.invitation_v1,
        p_responses=[{"line_id": g.world.rfq_line, "quantity": 10, "unit_price": 5, "bogus_key": 1}])),
}


@pytest.mark.parametrize("case", sorted(UNKNOWN_KEYS))
def test_an_unrecognised_jsonb_key_is_our_bug_not_a_refusal(guarded, case):
    """[S1] A key the function does not recognise raises XX000: the caller is out of step with
    the contract, which is ours to fix — never a silently ignored field, never a "refusal" the
    assistant would apologise for."""
    name, args = UNKNOWN_KEYS[case](guarded)
    err = ps.refuse(guarded.shop.admin, name, **args)
    assert err.pgcode == "XX000", f"expected XX000, got {err.pgcode}: {ps.message(err)}"


# ── S4: the browser has no table writes ─────────────────────────────────────────────────────────

BROWSER_WRITES = {
    "insert": "INSERT INTO public.{t} (company_id) VALUES (%s)",
    "update": "UPDATE public.{t} SET company_id = company_id WHERE company_id = %s",
    "delete": "DELETE FROM public.{t} WHERE company_id = %s",
}


@pytest.mark.parametrize("verb", sorted(BROWSER_WRITES))
@pytest.mark.parametrize("table", ps.PURCHASING_TABLES)
def test_the_browser_cannot_insert_update_or_delete_a_purchasing_table(guarded, table, verb):
    """[S4] 42501 — no grant at all, so not even RLS is consulted."""
    err = ps.refuse_sql(guarded.shop.admin, BROWSER_WRITES[verb].format(t=table), (guarded.shop.company,))
    assert err.pgcode == "42501", f"{verb} on {table}: {err.pgcode} {ps.message(err)}"


@pytest.mark.parametrize("table", ps.PURCHASING_TABLES)
def test_the_browser_holds_select_and_nothing_else(db, table):
    """[S4] No column-scoped write grant either, and TRUNCATE, REFERENCES, TRIGGER and MAINTAIN
    revoked from anon and authenticated. The service role keeps full access."""
    qualified = f"public.{table}"
    maintain = ps.scalar(db, "SELECT current_setting('server_version_num')::int >= 170000")
    for role in ("anon", "authenticated"):
        for privilege in ("INSERT", "UPDATE", "REFERENCES"):
            assert not ps.scalar(db, "SELECT has_any_column_privilege(%s, %s, %s)", (role, qualified, privilege)), \
                f"{role} holds {privilege} on {table}"
        for privilege in ("DELETE", "TRUNCATE", "TRIGGER") + (("MAINTAIN",) if maintain else ()):
            assert not ps.scalar(db, "SELECT has_table_privilege(%s, %s, %s)", (role, qualified, privilege)), \
                f"{role} holds {privilege} on {table}"
    assert ps.scalar(db, "SELECT has_table_privilege('authenticated', %s, 'SELECT')", (qualified,))
    for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE"):
        assert ps.scalar(db, "SELECT has_table_privilege('service_role', %s, %s)", (qualified, privilege))


@pytest.mark.parametrize("table", [t for t in ps.PURCHASING_TABLES if t not in ps.QUICKBOOKS_TABLES])
def test_members_read_their_own_rows_and_never_another_companys(guarded, table):
    """[S4] RLS: `company_id IN (SELECT get_user_company_ids())`."""
    g = guarded
    sql = f"SELECT count(*) FROM public.{table} WHERE company_id = %s"
    with ps.session(g.shop.user) as (_conn, cur):
        cur.execute(sql, (g.shop.company,))
        assert cur.fetchone()[0] >= 1, f"a member cannot read {table}"
    with ps.session(g.stranger.user) as (_conn, cur):
        cur.execute(sql, (g.shop.company,))
        assert cur.fetchone()[0] == 0, f"{table} leaked across companies"


def test_the_browser_cannot_link_a_slip_by_hand(guarded):
    """[S4, O1] The browser may UPDATE a slip's close columns only; the link is the RPC's."""
    err = ps.refuse_sql(guarded.shop.admin, "UPDATE outside_shipments SET vendor_purchase_order_line_id = NULL WHERE id = %s",
                        (guarded.world.slip,))
    assert err.pgcode == "42501"


# ── S5: every CI guard ──────────────────────────────────────────────────────────────────────────

GUARDS = (
    "tenant_tables_missing_write_gate",
    "definer_writers_missing_write_gate",
    "function_execute_leaks",
    "tenant_tables_missing_ai_decision",
    "ai_policies_missing_soft_delete_filter",
    "ai_policies_without_grant",
    "tenant_tables_with_silent_update_gate",
)


@pytest.mark.parametrize("guard", GUARDS)
def test_every_ci_guard_returns_nothing(db, guard):
    """[S5] Write gate, definer gate, execute leaks, AI decision, AI soft-delete — empty after
    the purchasing migrations, with every new table and function decided."""
    assert ps.rows(db, f"SELECT * FROM public.{guard}()") == []


# ── M5: what the insights AI may read ───────────────────────────────────────────────────────────

AI_READABLE = {
    "vendor_purchase_orders": ("id", "company_id", "po_number", "vendor_id", "vendor_name", "ordered_on",
                               "need_by_on", "revision", "sent_revision", "issued_at", "closed_at"),
    "vendor_purchase_order_lines": ("id", "company_id", "vendor_purchase_order_id", "line_number", "line_kind",
                                    "part_id", "description", "quantity", "unit", "stock_unit", "stock_factor",
                                    "unit_price", "need_by_on", "promised_on", "job_id", "closed_at"),
    "vendor_purchase_order_receipts": ("id", "company_id", "vendor_purchase_order_id", "vendor_purchase_order_line_id",
                                       "quantity", "unit", "stock_quantity", "part_id", "location_id", "lot_id",
                                       "heat_number", "received_at", "voided_at"),
    "part_vendors": ("id", "company_id", "part_id", "vendor_id", "status", "vendor_part_number", "purchase_unit",
                     "lead_time_days", "minimum_order_quantity", "quoted_on", "valid_until"),
    "part_vendor_price_breaks": ("id", "company_id", "part_vendor_id", "min_quantity", "unit_price"),
    "vendor_rfqs": ("id", "company_id", "rfq_number", "title", "needed_by_on", "respond_by_on", "closed_at"),
    "vendor_rfq_lines": ("id", "company_id", "vendor_rfq_id", "part_id", "description", "unit", "quantities"),
    "vendor_rfq_invitations": ("id", "company_id", "vendor_rfq_id", "vendor_id", "vendor_name", "sent_at",
                               "declined_at", "quoted_on"),
    "vendor_rfq_responses": ("id", "company_id", "vendor_rfq_invitation_id", "vendor_rfq_line_id", "quantity",
                             "unit_price", "no_bid", "lead_time_days", "valid_until", "awarded_at"),
}

AI_WITHHELD = [
    ("vendor_purchase_orders", "created_by"), ("vendor_purchase_orders", "issued_by"),
    ("vendor_purchase_orders", "closed_by"), ("vendor_purchase_orders", "internal_notes"),
    ("vendor_purchase_orders", "vendor_contact"), ("vendor_purchase_orders", "vendor_address"),
    ("vendor_purchase_orders", "ship_to_address"), ("vendor_purchase_orders", "terms_and_conditions"),
    ("vendor_purchase_order_lines", "closed_by"),
    ("vendor_purchase_order_receipts", "received_by"), ("vendor_purchase_order_receipts", "voided_by"),
    ("vendor_purchase_order_receipts", "notes"), ("vendor_purchase_order_receipts", "void_reason"),
    ("part_vendors", "created_by"), ("part_vendors", "notes"),
    ("vendor_rfqs", "created_by"), ("vendor_rfqs", "internal_notes"), ("vendor_rfqs", "terms_and_conditions"),
    ("vendor_rfq_invitations", "sent_by"), ("vendor_rfq_invitations", "declined_by"),
    ("vendor_rfq_invitations", "vendor_contact"),
    ("vendor_rfq_responses", "awarded_by"), ("vendor_rfq_responses", "notes"),
]


@pytest.mark.parametrize("table", sorted(AI_READABLE))
def test_the_ai_reads_the_business_columns(guarded, table):
    """[M5] `apply_ai_read_access` with column lists: what a shop owner asks about is readable."""
    with ps.ai_session(guarded.shop.company) as cur:
        cur.execute(f"SELECT {', '.join(AI_READABLE[table])} FROM public.{table} LIMIT 1")
        cur.fetchall()


@pytest.mark.parametrize("table, column", AI_WITHHELD, ids=[f"{t}.{c}" for t, c in AI_WITHHELD])
def test_the_ai_is_denied_actors_internal_notes_snapshots_and_terms(guarded, table, column):
    """[M5] Withheld: who did it, internal notes, contact and address snapshots, terms and
    conditions, notes and void reasons."""
    with ps.ai_session(guarded.shop.company) as cur:
        with pytest.raises(errors.InsufficientPrivilege):
            cur.execute(f"SELECT {column} FROM public.{table} LIMIT 1")


ARCHIVED = [
    ("vendor_purchase_orders", "id", lambda w: w.archived_po.id),
    ("vendor_purchase_order_lines", "vendor_purchase_order_id", lambda w: w.archived_po.id),
    ("vendor_purchase_order_receipts", "vendor_purchase_order_id", lambda w: w.archived_po.id),
    ("vendor_purchase_order_status", "id", lambda w: w.archived_po.id),
    ("vendor_purchase_order_line_status", "vendor_purchase_order_id", lambda w: w.archived_po.id),
    ("part_vendors", "id", lambda w: w.archived_avl),
    ("part_vendor_price_breaks", "part_vendor_id", lambda w: w.archived_avl),
    ("vendor_rfqs", "id", lambda w: w.archived_rfq),
    ("vendor_rfq_lines", "vendor_rfq_id", lambda w: w.archived_rfq),
    ("vendor_rfq_invitations", "vendor_rfq_id", lambda w: w.archived_rfq),
    ("vendor_rfq_status", "id", lambda w: w.archived_rfq),
]


@pytest.mark.parametrize("table, column, target", ARCHIVED, ids=[a[0] for a in ARCHIVED])
def test_the_ai_cannot_see_archived_purchasing_rows(guarded, table, column, target):
    """[M5] Soft delete is enforced in RLS, not asked for in a prompt — and child tables inherit
    their parent's `deleted_at`, through the tables and through the views."""
    g = guarded
    sql = f"SELECT count(*) FROM public.{table} WHERE {column} = %s"
    assert ps.scalar(g.db, sql, (target(g.world),)) >= 1, "the archived rows this test hides are missing"
    with ps.ai_session(g.shop.company) as cur:
        cur.execute(sql, (target(g.world),))
        assert cur.fetchone()[0] == 0, f"the insights AI can see archived rows in {table}"


def test_the_ai_sees_live_purchase_orders_through_the_table_and_the_view(guarded):
    """[M5] The control for the test above: the live PO is visible, with its derived status."""
    g = guarded
    with ps.ai_session(g.shop.company) as cur:
        cur.execute("SELECT count(*) FROM public.vendor_purchase_orders WHERE id = %s", (g.world.po.id,))
        assert cur.fetchone()[0] == 1
        cur.execute("SELECT status FROM public.vendor_purchase_order_status WHERE id = %s", (g.world.po.id,))
        assert cur.fetchone()[0] == ps.PARTLY_RECEIVED


@pytest.mark.parametrize("view", ps.PURCHASING_VIEWS)
def test_the_ai_can_select_star_from_every_purchasing_view(guarded, view):
    """[M5] A security_invoker view reads its tables AS the AI, so a view that touches a
    withheld column fails here — the reason `outside_shipments.closed_at` needed its grant."""
    with ps.ai_session(guarded.shop.company) as cur:
        cur.execute(f"SELECT * FROM public.{view} LIMIT 5")
        cur.fetchall()


@pytest.mark.parametrize("view", ps.PURCHASING_VIEWS)
def test_each_view_is_security_invoker_granted_and_carries_no_actor_column(db, view):
    """[M5] Computed once, readable by the browser, the backend and the AI, naming no person."""
    options = ps.scalar(db, "SELECT reloptions FROM pg_class WHERE oid = %s::regclass", (f"public.{view}",)) or []
    assert any(o.lower() in ("security_invoker=true", "security_invoker=on", "security_invoker=1") for o in options), \
        f"{view} is not security_invoker: {options}"
    for role in ("authenticated", "service_role", "jigged_ai_readonly"):
        assert ps.scalar(db, "SELECT has_table_privilege(%s, %s, 'SELECT')", (role, f"public.{view}")), f"{role} cannot read {view}"
    columns = [r["attname"] for r in ps.rows(db, """
        SELECT attname FROM pg_attribute WHERE attrelid = %s::regclass AND attnum > 0 AND NOT attisdropped""",
        (f"public.{view}",))]
    assert [c for c in columns if c.endswith("_by")] == []


@pytest.mark.parametrize("table", ps.AI_EXEMPT_TABLES)
def test_the_ai_is_denied_the_exempt_tables(guarded, table):
    """[M5] Revisions (superseded prices would read as current), the numbering series, and the
    four QuickBooks tables (third-party ids)."""
    with ps.ai_session(guarded.shop.company) as cur:
        with pytest.raises(errors.InsufficientPrivilege):
            cur.execute(f"SELECT 1 FROM public.{table} LIMIT 1")


def test_the_ai_reads_a_slips_close_and_its_po_line(guarded):
    """[M5] The missing `outside_shipments.closed_at` grant is fixed, and the link is readable."""
    with ps.ai_session(guarded.shop.company) as cur:
        cur.execute("SELECT closed_at, vendor_purchase_order_line_id FROM public.outside_shipments WHERE id = %s",
                    (guarded.world.slip,))
        assert cur.fetchone()[1] == guarded.world.outside_line


def test_the_ai_can_call_the_two_definitions(guarded):
    """[M5] The predicates the schema context tells the model to use."""
    with ps.ai_session(guarded.shop.company) as cur:
        cur.execute("SELECT public.is_vendor_purchase_order_late('sent', '2026-11-01'::date, '2026-11-09'::date),"
                    " public.vendor_po_line_amount(3::numeric, 1.23455::numeric)")
        assert cur.fetchone() == (True, Decimal("3.70"))


# ── S6: one DELETE removes the whole graph ─────────────────────────────────────────────────────


def test_a_single_company_delete_removes_the_whole_purchasing_graph(db, shop):
    """[S6] Every purchasing table cascades from its company, RESTRICT references included —
    with every kind of row present: receipts with a lot and its certificate, a second revision,
    an awarded RFQ and the draft it made, linked slips, and the QuickBooks rows."""
    world = ps.build_world(db, shop)
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 5, "feet")], sent=True)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 5, location=shop.shelf, heat="H-DEL")])
    lot = ps.receipts_of(db, po.id)[0]["lot_id"]
    ps.execute(db, "INSERT INTO lot_certificates (company_id, lot_id, file_name, file_path) VALUES (%s, %s, 'cert.pdf', %s)",
               (shop.company, lot, f"{shop.company}/lots/{lot}/cert.pdf"))
    ps.save_po(shop.user, world.po.id, changes={"notes_to_vendor": "Rev 1"}, expected=ps.updated_at_text(db, world.po.id))
    ps.mark_sent(shop.user, world.po.id)
    ps.award(shop.admin, world.rfq, [world.response])
    realm = f"realm-{shop.tag}"
    ps.insert_setup(db, shop, qbo_connection=ps.insert_qbo_connection(db, shop, realm), realm=realm)
    ps.insert_vendor_map(db, shop, shop.v1, realm)
    ps.insert_line_link(db, shop, ps.insert_po_link(db, shop, world.po.id, realm=realm), world.bar_line)

    ps.execute(db, "DELETE FROM companies WHERE id = %s", (shop.company,))

    tables = ps.PURCHASING_TABLES + ("material_lots", "lot_certificates", "outside_shipments")
    leftovers = {t: ps.count(db, t, shop.company) for t in tables}
    assert not any(leftovers.values()), f"rows outlived their company: {leftovers}"
