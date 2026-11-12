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
  * **A slip receipt can close the PO for QuickBooks.** The pieces that bring the last open line
    back beside a line closed short leave nothing outstanding, which is the derived "closed" the
    push acts on. Receiving is a plain INSERT, so a trigger settles the linked PO: that receipt,
    its undo, the slip's void and an unlink each move `content_version`; an ordinary receipt does
    not (QB9).

Run:
    cd api && pytest -m integration tests/integration/test_vendor_purchase_order_outside_service.py
"""
from __future__ import annotations

import threading
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


# ── QB9: a receipt on a linked slip can close the PO for the push ─────────────────────────────


def _closed_short_beside_the_step(db, shop: ps.Shop, quantity=100) -> ps.Po:
    """Sent to V1: line 1 the anodize step, line 2 bar stock closed short before any came. Once the
    step is back in full nothing is outstanding, so the PO's derived status is closed."""
    po = ps.make_po(db, shop, [ps.outside_line(shop.outside_op, quantity), ps.part_line(shop.bar, 10, "feet")],
                    sent=True)
    ps.set_lines(shop.admin, po.id, [po.lines[1]], "close", reason="Bought locally")
    return po


def _version(db, po: ps.Po) -> int:
    return ps.po_row(db, po.id)["content_version"]


def _quickbooks_state(db, po: ps.Po) -> str:
    return ps.po_status(db, po.id)["quickbooks_state"]


def _slip_receipts(db, slip: str) -> list[dict]:
    return ps.rows(db, """
        SELECT * FROM public.outside_shipment_receipts WHERE outside_shipment_id = %s
         ORDER BY created_at""", (slip,))


def _undo_slip_receipt(user: str, receipt: str) -> None:
    """The browser's undo (voidOutsideReceipt): its column-scoped UPDATE of voided_at."""
    ps.sql_as(user, """
        UPDATE public.outside_shipment_receipts SET voided_at = now(), voided_by = %s
         WHERE id = %s AND voided_at IS NULL""", (user, receipt))


def _production(db, shop: ps.Shop) -> tuple[str, str]:
    return (ps.scalar(db, "SELECT production_status FROM job_parts WHERE id = %s", (shop.job_part,)),
            ps.scalar(db, "SELECT production_status FROM jobs WHERE id = %s", (shop.job,)))


def _step_back_in_full(db, shop: ps.Shop) -> tuple[ps.Po, str]:
    """The PO closed by its slip: the station op done, 100 out and 100 back."""
    po = _closed_short_beside_the_step(db, shop)
    ps.complete_operation(db, shop, shop.station_op, shop.job_part, 100)
    slip = ps.send_outside(shop.admin, shop.outside_op, 100)[0]
    ps.receive_slip(db, shop.admin, slip, 100)
    assert ps.po_status(db, po.id)["status"] == ps.CLOSED
    assert _production(db, shop) == ("completed", "completed")
    return po, slip


def test_the_slip_receipt_that_brings_the_step_back_closes_the_po_for_quickbooks(db, shop):
    """[QB9, O3] The last pieces back on the vendor packing slip, beside a line closed short, leave
    nothing outstanding: the PO reads closed and the push would close it in QuickBooks. Recording
    them is a plain INSERT -- an operator's, from the phone -- so the trigger behind it settles the
    PO and it reads out of date. The pieces before them are an ordinary receipt and move nothing,
    and the operation -> part -> job cascade still reaches the job beside the new trigger."""
    po = _closed_short_beside_the_step(db, shop)
    ps.complete_operation(db, shop, shop.station_op, shop.job_part, 100)
    slip = ps.send_outside(shop.admin, shop.outside_op, 100)[0]
    assert ps.slip_link(db, slip) == po.lines[0]
    ps.insert_po_link(db, shop, po.id, pushed_content_version=_version(db, po))
    version = _version(db, po)

    ps.receive_slip(db, shop.operator, slip, 60)
    assert ps.po_status(db, po.id)["status"] == ps.PARTLY_RECEIVED
    assert (_version(db, po), _quickbooks_state(db, po)) == (version, "in_quickbooks")

    ps.receive_slip(db, shop.operator, slip, 40)
    assert ps.po_status(db, po.id)["status"] == ps.CLOSED
    assert ps.po_row(db, po.id)["closed_at"] is None, "closed by the slip receipt, not by hand"
    assert (_version(db, po), _quickbooks_state(db, po)) == (version + 1, "out_of_date")
    assert _production(db, shop) == ("completed", "completed"), "the cascade stopped short of the job"


def test_undoing_that_slip_receipt_opens_the_po_again_and_counts(db, shop):
    """[QB9, O3] The browser's undo is a column-scoped UPDATE of voided_at: nothing is back, the PO
    is no longer closed, content_version moves again, and the part and job step back with it."""
    po, slip = _step_back_in_full(db, shop)
    version = _version(db, po)

    _undo_slip_receipt(shop.user, _slip_receipts(db, slip)[-1]["id"])
    assert ps.po_status(db, po.id)["status"] == ps.PARTLY_RECEIVED
    assert _version(db, po) == version + 1
    assert _production(db, shop) == ("in_progress", "in_progress")


def test_voiding_the_slip_opens_the_po_again_and_counts(db, shop):
    """[QB9, O3] void_outside_shipment voids the receipts first, as two top-level statements, and
    the receipts' void is what settles the PO; the void cascade still reaches the job."""
    po, slip = _step_back_in_full(db, shop)
    version = _version(db, po)

    ps.void_slip(shop.admin, slip)
    assert ps.po_status(db, po.id)["status"] == ps.PARTLY_RECEIVED
    assert _version(db, po) == version + 1
    assert _production(db, shop) == ("in_progress", "in_progress"), (
        "the job froze: the cascade was suppressed at trigger depth 3")


def test_unlinking_a_slip_with_parts_back_opens_its_po_again_and_counts(db, shop):
    """[QB9, O1] What came back on a slip counts toward the line it is linked to, so unlinking it
    takes the PO out of closed. The relink locks and settles the PO the slip leaves, and still
    leaves the operation alone."""
    po, slip = _step_back_in_full(db, shop)
    version = _version(db, po)
    operation_before = ps.operation_row(db, shop.outside_op)

    ps.relink(shop.user, slip, None)
    assert ps.po_status(db, po.id)["status"] == ps.PARTLY_RECEIVED
    assert _version(db, po) == version + 1
    assert ps.operation_row(db, shop.outside_op) == operation_before, "unlinking changed the operation"


def test_the_rest_arriving_after_the_step_was_closed_short_takes_the_po_out_of_closed(db, shop):
    """[QB9] The step was closed short at 60 of 100 and the bar received in full: closed. Then the
    plater finds the other 40 and they come back on the same slip. The step is received, no line is
    short any more and the PO reads received -- which the push would reopen in QuickBooks -- so it
    counts too."""
    po = ps.make_po(db, shop, [ps.outside_line(shop.outside_op, 100), ps.part_line(shop.bar, 10, "feet")],
                    sent=True)
    slip = ps.send_outside(shop.admin, shop.outside_op, 100)[0]
    ps.receive_slip(db, shop.admin, slip, 60)
    ps.set_lines(shop.admin, po.id, [po.lines[0]], "close", reason="40 lost at the plater")
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[1], 10, location=shop.shelf)])
    assert ps.po_status(db, po.id)["status"] == ps.CLOSED
    version = _version(db, po)

    ps.receive_slip(db, shop.admin, slip, 40)
    assert ps.po_status(db, po.id)["status"] == ps.RECEIVED
    assert _version(db, po) == version + 1


def _receive_in_open_transaction(db, conn, user: str, slip: str, good) -> None:
    """The browser's receipt INSERT, left uncommitted on `conn`."""
    s = ps.slip_row(db, slip)
    with conn.cursor() as cur:
        ps.act_as(cur, user)
        cur.execute("""
            INSERT INTO public.outside_shipment_receipts
                (company_id, outside_shipment_id, job_operation_id, job_part_id, quantity_good, received_by)
            VALUES (%s, %s, %s, %s, %s, %s)""",
            (s["company_id"], slip, s["job_operation_id"], s["job_part_id"], good, user))


def _race(db, hold, then) -> None:
    """`hold(conn)` runs and stays open; `then(conn)` starts on a second connection and must queue
    on a lock; the first commits; the second must then finish cleanly -- no deadlock, no error."""
    first, second = ps.connect(), ps.connect()
    outcome: dict = {}

    def the_second():
        try:
            then(second)
            second.commit()
        except Exception as exc:  # noqa: BLE001 - reported below, with its SQLSTATE
            outcome["error"] = exc

    try:
        hold(first)
        worker = threading.Thread(target=the_second)
        worker.start()
        assert ps.wait_until_blocked(db, second.get_backend_pid()), "the second transaction did not queue"
        first.commit()
        worker.join(timeout=20)
        assert not worker.is_alive(), "the second transaction never finished"
        assert "error" not in outcome, f"the second transaction failed: {outcome.get('error')!r}"
    finally:
        first.close()
        second.close()


def test_two_slip_receipts_that_close_the_po_only_together_count_it_once(db, shop):
    """[QB9] The write skew a before-and-after hash would miss. Two steps on one PO, a third line
    closed short, and the last pieces of each step come back at the same moment: neither receipt
    alone leaves nothing outstanding, both together do. The trigger takes the PO lock before it
    reads, so the second receipt queues, then reads both, and the close is counted exactly once."""
    _, second_op = ps.add_outside_job_part(db, shop, shop.anodize)
    po = ps.make_po(db, shop, [ps.outside_line(shop.outside_op, 100), ps.outside_line(second_op, 40),
                               ps.part_line(shop.bar, 10, "feet")], sent=True)
    ps.set_lines(shop.admin, po.id, [po.lines[2]], "close", reason="Bought locally")
    first_slip = ps.send_outside(shop.admin, shop.outside_op, 100)[0]
    second_slip = ps.send_outside(shop.admin, second_op, 40)[0]
    assert (ps.slip_link(db, first_slip), ps.slip_link(db, second_slip)) == (po.lines[0], po.lines[1])
    version = _version(db, po)

    _race(db,
          lambda conn: _receive_in_open_transaction(db, conn, shop.operator, first_slip, 100),
          lambda conn: _receive_in_open_transaction(db, conn, shop.operator, second_slip, 40))
    assert ps.po_status(db, po.id)["status"] == ps.CLOSED
    assert _version(db, po) == version + 1


def test_a_receipt_racing_a_relink_of_its_slip_settles_the_po_the_slip_moved_to(db, shop):
    """[QB9, O1] The relink holds both POs while the receipt's trigger waits for the one the slip
    was on. When it gets the lock the slip has moved, so it reads the link again and settles the
    PO the receipt now counts toward -- here the receipt is what closes that PO."""
    old = _outside_po(db, shop, sent=True)
    slip = ps.send_outside(shop.admin, shop.outside_op, 100)[0]
    ps.receive_slip(db, shop.admin, slip, 60)
    ps.set_lines(shop.admin, old.id, [old.lines[0]], "close", reason="Moving it to the right PO")
    new = _closed_short_beside_the_step(db, shop)
    assert ps.slip_link(db, slip) == old.lines[0], "a linked slip was stolen by a new line"
    versions = (_version(db, old), _version(db, new))

    def relink_and_hold(conn):
        with conn.cursor() as cur:
            ps.act_as(cur, shop.admin)
            ps.rpc(cur, "set_outside_shipment_vendor_purchase_order_line", **ps.relink_args(slip, new.lines[0]))

    _race(db, relink_and_hold, lambda conn: _receive_in_open_transaction(db, conn, shop.operator, slip, 40))
    assert ps.slip_link(db, slip) == new.lines[0]
    assert ps.po_status(db, new.id)["status"] == ps.CLOSED
    assert (_version(db, old), _version(db, new)) == (versions[0], versions[1] + 1)


def test_the_receipt_trigger_is_a_sibling_of_the_cascade_and_fires_before_it(db):
    """[QB9, O3] The settle triggers on outside_shipment_receipts are AFTER, their function is
    SECURITY DEFINER (the browser cannot write the PO header) and not browser-executable, and they
    sort before the operation -> part -> job cascade trigger, so the PO lock is taken before the
    cascade locks a job row."""
    triggers = ps.rows(db, """
        SELECT tgname, tgtype FROM pg_trigger
         WHERE tgrelid = 'public.outside_shipment_receipts'::regclass AND NOT tgisinternal
         ORDER BY tgname""")
    before = 2  # pg_trigger.tgtype bit
    settles = [t["tgname"] for t in triggers if "settle_vendor_po" in t["tgname"]]
    cascades = [t["tgname"] for t in triggers if t["tgname"].startswith("trigger_recompute_op_status_on_outside_receipt")]
    assert len(settles) == 2 and cascades, triggers
    assert not any(t["tgtype"] & before for t in triggers if t["tgname"] in settles), "the settle must be AFTER"
    assert max(settles) < min(cascades), "the settle trigger must fire before the cascade"
    fn = ps.row(db, """
        SELECT p.prosecdef, has_function_privilege('authenticated', p.oid, 'EXECUTE') AS browser
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'outside_receipt_settles_vendor_purchase_order'""")
    assert fn == {"prosecdef": True, "browser": False}
