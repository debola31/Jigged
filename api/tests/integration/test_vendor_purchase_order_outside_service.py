"""Outside-service lines and vendor packing slips (plan §3.3 create_outside_shipment, §3.6; O1–O3).

WHAT THIS GUARDS. The purchase order is an OPTIONAL commercial layer over outside processing:
the vendor packing slip (`outside_shipments`) stays the only record of movement, and a slip
carries at most one link to the PO line it ships against. The fixture mirrors
test_outside_processing.py — a job part routed through a station and then V1's anodize step.

  * **Linking is automatic and exact.** A send links to the single eligible line (draft or sent,
    not closed, not archived, same operation and vendor); a line links the live, unlinked slips
    already out; a mismatched link cannot be stored at all; and there is one open outside line
    per (operation, vendor), reopen included (O1).
  * **The line's figures come from its slips** — sent, at vendor, received — and closing a slip
    short and closing the line are independent decisions (O2).
  * **Linking never changes a status.** The link column is in no status trigger's `UPDATE OF`
    list, receipts and voids still cascade operation → part → job inside the trigger-depth
    budget, and an operator still sends and receives from the phone — `create_outside_shipment`
    keeps its 8 arguments, its grants and no office assertion (O3).

Run:
    cd api && pytest -m integration tests/integration/test_vendor_purchase_order_outside_service.py
"""
from __future__ import annotations

from datetime import date, timedelta
from decimal import Decimal

import pytest
from psycopg2 import errors

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, other_shop, shop  # noqa: F401

pytestmark = pytest.mark.integration


def _outside_po(db, shop: ps.Shop, quantity=100, *, sent: bool = False, **kw) -> ps.Po:
    return ps.make_po(db, shop, [ps.outside_line(shop.outside_op, quantity, **kw)], sent=sent)


def _send_through_v2(db, shop: ps.Shop, quantity) -> str:
    """A slip for the SAME operation that went to V2 — the step was re-routed after a send."""
    ps.execute(db, "UPDATE job_operations SET vendor_service_id = %s WHERE id = %s", (shop.plating, shop.outside_op))
    try:
        return ps.send_outside(shop.admin, shop.outside_op, quantity)[0]
    finally:
        ps.execute(db, "UPDATE job_operations SET vendor_service_id = %s WHERE id = %s", (shop.anodize, shop.outside_op))


def _figures(db, line: str) -> tuple:
    found = ps.line_status(db, line)
    return tuple(Decimal(found[k]) for k in ("sent_quantity", "at_vendor_quantity", "received_quantity"))


# ── O1: how a slip gets linked ──────────────────────────────────────────────────────────────────


def test_a_send_links_to_a_draft_outside_line_already_on_a_po(db, shop):
    """[O1] Draft lines are eligible: a slip sent before "Mark as sent" still counts."""
    po = _outside_po(db, shop)
    slip, number = ps.send_outside(shop.admin, shop.outside_op, 40)
    assert number.startswith("VPS-")
    assert ps.slip_link(db, slip) == po.lines[0]


def test_a_line_created_after_two_sends_links_both_and_skips_other_vendors_and_voided_slips(db, shop):
    """[O1] Inserting the line links the live, unlinked slips for that operation and vendor."""
    first = ps.send_outside(shop.admin, shop.outside_op, 30)[0]
    second = ps.send_outside(shop.admin, shop.outside_op, 30)[0]
    voided = ps.send_outside(shop.admin, shop.outside_op, 10)[0]
    ps.void_slip(shop.admin, voided)
    elsewhere = _send_through_v2(db, shop, 20)

    po = _outside_po(db, shop)
    line = po.lines[0]
    assert {s: ps.slip_link(db, s) for s in (first, second, voided, elsewhere)} == {
        first: line, second: line, voided: None, elsewhere: None}


@pytest.mark.parametrize("ineligible", ["closed-line", "archived-po"])
def test_a_closed_line_or_an_archived_po_is_not_eligible(db, shop, ineligible):
    """[O1] Only an open line on a live PO can claim a new slip."""
    po = _outside_po(db, shop, sent=True)
    if ineligible == "closed-line":
        ps.set_lines(shop.admin, po.id, [po.lines[0]], "close")
    else:
        ps.set_state(shop.admin, po.id, "archive")
    slip = ps.send_outside(shop.admin, shop.outside_op, 25)[0]
    assert ps.slip_link(db, slip) is None


def test_a_second_open_outside_line_for_the_same_operation_and_vendor_is_refused(db, shop):
    """[O1] One open outside line per (operation, vendor), across POs — so a send never has to
    guess which line it ships against. Closing the first frees the operation."""
    first = _outside_po(db, shop)
    err = ps.refuse(shop.admin, "create_vendor_purchase_order",
                    **ps.create_args(shop.v1, [ps.outside_line(shop.outside_op, 50)]))
    ps.assert_sentence_refusal(err)

    ps.mark_sent(shop.admin, first.id)
    ps.set_lines(shop.admin, first.id, [first.lines[0]], "close")
    _outside_po(db, shop, 50)


@pytest.mark.parametrize("reopen", ["the-line", "the-po"])
def test_reopening_cannot_make_a_second_open_outside_line(db, shop, reopen):
    """[O1] Reopen re-checks the rule, at line level and on the whole PO."""
    first = _outside_po(db, shop, sent=True)
    if reopen == "the-line":
        ps.set_lines(shop.admin, first.id, [first.lines[0]], "close")
    else:
        ps.set_state(shop.admin, first.id, "close")
    _outside_po(db, shop, 50)  # the operation is free again, and is taken

    if reopen == "the-line":
        err = ps.refuse(shop.admin, "set_vendor_purchase_order_line_state",
                        p_id=first.id, p_line_ids=[first.lines[0]], p_action="reopen")
    else:
        err = ps.refuse(shop.admin, "set_vendor_purchase_order_state",
                        p_id=first.id, p_action="reopen", p_today=ps.TODAY)
    ps.assert_state_refusal(err)
    if reopen == "the-line":
        assert ps.line_row(db, first.lines[0])["closed_at"] is not None
    else:
        assert ps.po_row(db, first.id)["closed_at"] is not None


def test_relink_moves_a_slip_and_unlink_lets_it_go_without_touching_the_operation(db, shop):
    """[O1, O3] The explicit correction. Neither move writes `job_operations`."""
    first = _outside_po(db, shop, sent=True)
    slip = ps.send_outside(shop.admin, shop.outside_op, 40)[0]
    assert ps.slip_link(db, slip) == first.lines[0]
    ps.set_lines(shop.admin, first.id, [first.lines[0]], "close")
    second = _outside_po(db, shop, 60, sent=True)
    assert ps.slip_link(db, slip) == first.lines[0], "a linked slip was stolen by a new line"

    operation_before = ps.operation_row(db, shop.outside_op)
    ps.relink(shop.user, slip, second.lines[0])
    assert ps.slip_link(db, slip) == second.lines[0]
    ps.relink(shop.user, slip, None)
    assert ps.slip_link(db, slip) is None
    assert ps.operation_row(db, shop.outside_op) == operation_before, "linking changed the operation"


@pytest.mark.parametrize("target", ["a-part-line", "another-operations-line", "another-companys-line"])
def test_relink_refuses_a_line_that_does_not_match_the_slip(db, shop, other_shop, target):
    """[O1, S3] Same company, an outside line, the same operation, the same vendor."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 1, "feet"), ps.outside_line(shop.outside_op, 100)])
    slip = ps.send_outside(shop.admin, shop.outside_op, 10)[0]
    if target == "a-part-line":
        line = po.lines[0]
    elif target == "another-operations-line":
        _, operation = ps.add_outside_job_part(db, shop, shop.anodize)
        line = ps.make_po(db, shop, [ps.outside_line(operation, 40)]).lines[0]
    else:
        line = ps.make_po(db, other_shop, [ps.outside_line(other_shop.outside_op, 40)]).lines[0]

    err = ps.refuse(shop.admin, "set_outside_shipment_vendor_purchase_order_line", **ps.relink_args(slip, line))
    ps.assert_sentence_refusal(err)
    assert ps.slip_link(db, slip) == po.lines[1]


@pytest.mark.parametrize("target", ["a-part-line", "another-operations-line"])
def test_a_mismatched_link_cannot_be_stored_even_by_the_service_role(db, shop, target):
    """[O1] The BEFORE trigger makes a wrong link unrepresentable, whoever writes it."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 1, "feet"), ps.outside_line(shop.outside_op, 100)])
    slip = ps.send_outside(shop.admin, shop.outside_op, 10)[0]
    if target == "a-part-line":
        line = po.lines[0]
    else:
        _, operation = ps.add_outside_job_part(db, shop, shop.anodize)
        line = ps.make_po(db, shop, [ps.outside_line(operation, 40)]).lines[0]
    with pytest.raises(errors.CheckViolation):
        ps.execute(db, "UPDATE outside_shipments SET vendor_purchase_order_line_id = %s WHERE id = %s", (line, slip))


# ── O2: the line's figures come from its slips ─────────────────────────────────────────────────


def test_receiving_60_of_100_reads_partly_received_with_40_at_the_vendor(db, shop):
    """[O2] Sent 100 · at vendor 40 · back 60. The operation is still `sent`."""
    po = _outside_po(db, shop, sent=True)
    slip = ps.send_outside(shop.admin, shop.outside_op, 100)[0]
    ps.receive_slip(db, shop.admin, slip, 60)

    assert _figures(db, po.lines[0]) == (100, 40, 60)
    assert ps.line_status(db, po.lines[0])["status"] == ps.PARTLY_RECEIVED
    assert ps.po_status(db, po.id)["status"] == ps.PARTLY_RECEIVED
    assert ps.operation_row(db, shop.outside_op)["status"] == "sent"


def test_the_expected_date_is_the_earliest_due_back_among_slips_still_out(db, shop):
    """[O2] An outside line has no promise of its own: it is due when its slips are due back,
    else on its need-by date."""
    today = date.today()
    po = _outside_po(db, shop, sent=True, need_by_on=(today + timedelta(days=30)).isoformat())
    assert ps.line_status(db, po.lines[0])["expected_on"] == today + timedelta(days=30)

    early = ps.send_outside(shop.admin, shop.outside_op, 50, p_due_back_on=(today + timedelta(days=10)).isoformat())[0]
    ps.send_outside(shop.admin, shop.outside_op, 50, p_due_back_on=(today + timedelta(days=15)).isoformat())
    assert ps.line_status(db, po.lines[0])["expected_on"] == today + timedelta(days=10)

    ps.receive_slip(db, shop.admin, early, 50)
    assert ps.line_status(db, po.lines[0])["expected_on"] == today + timedelta(days=15)


def test_short_closing_the_slip_and_closing_the_line_are_independent(db, shop):
    """[O2] The slip's short-close settles the paperwork (nothing is at the vendor any more) and
    leaves the PO line open; closing the line then leaves the operation exactly where it was."""
    po = _outside_po(db, shop, sent=True)
    slip = ps.send_outside(shop.admin, shop.outside_op, 100)[0]
    ps.receive_slip(db, shop.admin, slip, 60)
    ps.close_slip(shop.admin, slip)

    assert _figures(db, po.lines[0]) == (100, 0, 60)
    assert ps.line_status(db, po.lines[0])["status"] == ps.PARTLY_RECEIVED
    operation_before = ps.operation_row(db, shop.outside_op)
    assert operation_before["status"] == "in_progress"

    ps.set_lines(shop.admin, po.id, [po.lines[0]], "close", reason="40 scrapped at the plater")
    assert ps.line_status(db, po.lines[0])["status"] == ps.CLOSED
    assert ps.operation_row(db, shop.outside_op) == operation_before


def test_an_outside_lines_quantity_cannot_drop_below_what_came_back(db, shop):
    """[O2, P4] For an outside line, "received" is the receipts on its linked slips."""
    po = _outside_po(db, shop, sent=True)
    slip = ps.send_outside(shop.admin, shop.outside_op, 100)[0]
    ps.receive_slip(db, shop.admin, slip, 60)
    err = ps.refuse(shop.user, "save_vendor_purchase_order",
                    **ps.save_args(po.id, lines=[{"id": po.lines[0], "quantity": 50}],
                                   expected=ps.updated_at_text(db, po.id)))
    ps.assert_state_refusal(err)
    ps.save_po(shop.user, po.id, lines=[{"id": po.lines[0], "quantity": 60}], expected=ps.updated_at_text(db, po.id))


# ── O3: linking never changes a status ─────────────────────────────────────────────────────────


def test_no_after_trigger_on_slips_fires_on_the_link_column(db):
    """[O3] The trigger `UPDATE OF` lists are the contract (20260906005725). Only a BEFORE,
    read-only check may name the link column; no status trigger fires on every UPDATE."""
    attnum = ps.scalar(db, """
        SELECT attnum FROM pg_attribute
         WHERE attrelid = 'public.outside_shipments'::regclass
           AND attname = 'vendor_purchase_order_line_id' AND NOT attisdropped""")
    assert attnum, "outside_shipments.vendor_purchase_order_line_id does not exist"

    triggers = ps.rows(db, """
        SELECT tgname, tgtype, tgattr::int2[] AS columns FROM pg_trigger
         WHERE tgrelid = 'public.outside_shipments'::regclass AND NOT tgisinternal""")
    before, update = 2, 16  # pg_trigger.tgtype bits
    for trigger in triggers:
        is_after_update = (trigger["tgtype"] & update) and not (trigger["tgtype"] & before)
        if not is_after_update:
            continue
        columns = trigger["columns"] or []
        assert columns, f"{trigger['tgname']} fires on every UPDATE, link changes included"
        assert attnum not in columns, f"{trigger['tgname']} fires when a slip is linked"


def test_a_linked_receipt_completes_the_part_and_job_and_a_slip_void_reverses_it(db, shop):
    """[O2, O3] The cascade still reaches the job at trigger depth ≤ 2, and voiding the slip
    lowers the line's received figure and re-derives the part and the job."""
    po = _outside_po(db, shop, sent=True)
    ps.complete_operation(db, shop, shop.station_op, shop.job_part, 100)
    slip = ps.send_outside(shop.admin, shop.outside_op, 100)[0]
    ps.receive_slip(db, shop.admin, slip, 100)

    assert ps.line_status(db, po.lines[0])["status"] == ps.RECEIVED
    assert ps.scalar(db, "SELECT production_status FROM job_parts WHERE id = %s", (shop.job_part,)) == "completed"
    assert ps.scalar(db, "SELECT production_status FROM jobs WHERE id = %s", (shop.job,)) == "completed"

    ps.void_slip(shop.admin, slip)
    assert Decimal(ps.line_status(db, po.lines[0])["received_quantity"]) == 0
    assert ps.scalar(db, "SELECT production_status FROM job_parts WHERE id = %s", (shop.job_part,)) == "in_progress"
    assert ps.scalar(db, "SELECT production_status FROM jobs WHERE id = %s", (shop.job,)) == "in_progress", (
        "the job froze — the cascade was suppressed at trigger depth 3")


def test_an_operator_still_sends_and_receives_and_the_slip_links(db, shop):
    """[O3, S1] Operators send outside work from the phone; the PO layer must not take that away."""
    po = _outside_po(db, shop, sent=True)
    slip, number = ps.send_outside(shop.operator, shop.outside_op, 25)
    assert number.startswith("VPS-")
    assert ps.slip_link(db, slip) == po.lines[0]
    ps.receive_slip(db, shop.operator, slip, 25)
    assert Decimal(ps.line_status(db, po.lines[0])["received_quantity"]) == 25


def test_create_outside_shipment_keeps_one_overload_its_grants_and_its_body(db):
    """[O3] Rebuilt from its newest body: exactly one overload with the unchanged 8 arguments,
    authenticated can execute and anon cannot, the body still mints `VPS-` and now writes the
    link — and carries no office assertion, because operators send."""
    found = ps.rows(db, """
        SELECT pg_get_function_identity_arguments(p.oid) AS args, pg_get_functiondef(p.oid) AS body,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS browser,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'create_outside_shipment'""")
    assert len(found) == 1, f"create_outside_shipment has {len(found)} overloads; every 8-argument send would fail"
    fn = found[0]
    assert fn["args"] == ("p_job_operation_id uuid, p_quantity numeric, p_vendor_address_id uuid, "
                          "p_vendor_contact_id uuid, p_shipped_at timestamp with time zone, p_due_back_on date, "
                          "p_carrier text, p_notes text")
    assert (fn["browser"], fn["anon"]) == (True, False)
    assert "'VPS-'" in fn["body"] and "vendor_purchase_order_line_id" in fn["body"]
    assert "assert_office_member" not in fn["body"], "operators send outside work; they must not be refused"
