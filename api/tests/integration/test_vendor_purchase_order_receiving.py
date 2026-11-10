"""Receiving against a vendor purchase order (plan §3.3 receive/void, §3.5, §3.7; R1–R5, L3).

WHAT THIS GUARDS. A receipt is the one purchasing write that moves stock, so it goes through
the stock engine (`add_stock_at_location`) and nothing else, and every way it can quietly go
wrong is pinned here:

  * **Units are exact.** 2.5 `hundred` is 250 `each`, typed either way, and the line's frozen
    factor does the converting — never `convertToBaseUnit`, which returns unconverted numbers.
    A line ordered in feet and received in inches closes exactly, with no 99.999936 (R1, L3).
  * **Heats.** Normalised, stamped onto a NEW lot with the vendor and receipt date once, and
    processed FIRST within a batch — otherwise the untagged entry lands lot-less, the heat then
    switches tracking on, the stock moves to PRE-TRACKING and the first receipt can never be
    voided (R2).
  * **One delivery is one atomic, idempotent call.** A lost response or a second tab replays
    the same `receipt_group_id` and must not double the stock (R3).
  * **A void reverses through the stock engine** and refuses when the stock has gone (R4).
  * **The stock RPCs change only by handing back their ledger row** — same signature, same
    grants, every existing caller unchanged (R5).
  * **A bought part on a job keeps today's production status**: a receipt is not a "received"
    gate (founder default, §2).

Run:
    cd api && pytest -m integration tests/integration/test_vendor_purchase_order_receiving.py
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, other_shop, shop  # noqa: F401

pytestmark = pytest.mark.integration


def _sent(db, shop: ps.Shop, *lines, vendor: str | None = None) -> ps.Po:
    return ps.make_po(db, shop, list(lines), vendor=vendor, sent=True)


def _screws(db, shop: ps.Shop, hundreds=2.5) -> ps.Po:
    return _sent(db, shop, ps.part_line(shop.screw, hundreds, "hundred", unit_price=12, description="M5x16 SHCS"))


def _bar(db, shop: ps.Shop, feet=10, **kw) -> ps.Po:
    return _sent(db, shop, ps.part_line(shop.bar, feet, "feet", unit_price=24, description="4140 bar"), **kw)


def _refuse_receipt(shop: ps.Shop, po_id: str, entries: list[dict], **kw):
    return ps.refuse(shop.admin, "receive_vendor_purchase_order", **ps.receive_args(po_id, entries, **kw))


def _ledger_count(db, part: str, kind: str) -> int:
    return ps.scalar(db, "SELECT count(*) FROM inventory_transactions WHERE part_id = %s AND type = %s", (part, kind))


# ── R1 / L3: the balance, the roll-up, the ledger row and its link ─────────────────────────────


def test_two_and_a_half_hundred_screws_land_as_250_each_with_the_ledger_linked(db, shop):
    """[R1, L3] Per-100 pricing end to end: the receipt stores what was typed, the stock and
    the roll-up move by 250, and the ledger row it wrote is the one it links."""
    po = _screws(db, shop)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 2.5, location=shop.shelf)])

    (receipt,) = ps.receipts_of(db, po.id)
    assert (receipt["quantity"], receipt["unit"]) == (Decimal("2.5"), "hundred")
    assert receipt["stock_quantity"] == 250
    assert receipt["line_kind"] == "part" and receipt["part_id"] == shop.screw
    assert receipt["location_id"] == shop.shelf
    assert receipt["received_by"] == shop.admin

    assert ps.balance(db, shop.screw, shop.shelf) == 250
    assert ps.part_quantity(db, shop.screw) == 250
    ledger = ps.ledger_row(db, receipt["inventory_transaction_id"])
    # The receipt keeps the place label the ledger snapshots: the full path, because shelf
    # names repeat across racks and the label must outlive the place being deleted.
    assert receipt["location_name"] == ledger["location_name"] == "Rack A › Shelf A1"
    assert ledger["type"] == "addition" and ledger["part_id"] == shop.screw
    assert (ledger["quantity"], ledger["unit"], ledger["converted_quantity"]) == (Decimal("2.5"), "hundred", 250)
    assert po.number in (ledger["notes"] or ""), "the part's history cannot say which PO this came from"


def test_the_same_delivery_typed_in_stock_units_lands_the_same_stock(db, shop):
    """[R1] "250 each" against a line in hundreds: stored exactly as typed, same stock."""
    po = _screws(db, shop)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 250, location=shop.shelf, quantity_unit="stock")])

    (receipt,) = ps.receipts_of(db, po.id)
    assert (receipt["quantity"], receipt["unit"], receipt["stock_quantity"]) == (250, "each", 250)
    assert ps.balance(db, shop.screw, shop.shelf) == 250
    assert ps.line_status(db, po.lines[0])["status"] == ps.RECEIVED


def test_a_feet_line_received_in_inches_closes_exactly(db, shop):
    """[R1] 10 ft ordered; 100 in then 20 in received. No round trip through feet, so no drift:
    the line is received to the inch."""
    po = _bar(db, shop)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 100, location=shop.shelf, quantity_unit="stock")])
    assert ps.line_status(db, po.lines[0])["status"] == ps.PARTLY_RECEIVED
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 20, location=shop.shelf, quantity_unit="stock")])

    assert [r["stock_quantity"] for r in ps.receipts_of(db, po.id)] == [100, 20]
    status = ps.line_status(db, po.lines[0])
    assert status["status"] == ps.RECEIVED
    assert Decimal(status["received_stock_quantity"]) == 120


# ── R2: heats, lots, tracking, locations ────────────────────────────────────────────────────────


def test_a_heat_is_normalised_and_a_new_lot_is_stamped_with_vendor_and_date_once(db, shop):
    """[R2] ` ht-9 ` is HT-9. The lot the receipt creates says who sold it and when it came in;
    the same heat arriving later from another vendor joins that lot and leaves it alone."""
    first = _bar(db, shop)
    ps.receive(shop.admin, first.id, [ps.entry(first.lines[0], 5, location=shop.shelf, heat=" ht-9 ")],
               received_at="2026-11-02T09:00:00+00:00")
    (receipt,) = ps.receipts_of(db, first.id)
    assert receipt["heat_number"] == "HT-9"
    lot = ps.lot_row(db, receipt["lot_id"])
    assert lot["heat_number"] == "HT-9" and lot["vendor_id"] == shop.v1
    assert lot["received_at"] == datetime(2026, 11, 2, 9, 0, tzinfo=timezone.utc)

    later = _bar(db, shop, feet=2, vendor=shop.v2)
    ps.receive(shop.admin, later.id, [ps.entry(later.lines[0], 2, location=shop.shelf, heat="HT-9")],
               received_at="2026-11-06T09:00:00+00:00")
    (again,) = ps.receipts_of(db, later.id)
    assert again["lot_id"] == receipt["lot_id"], "a heat is a lot, not a receipt"
    unchanged = ps.lot_row(db, receipt["lot_id"])
    assert (unchanged["vendor_id"], unchanged["received_at"]) == (shop.v1, lot["received_at"])


def test_a_batch_of_untagged_and_heat_entries_gives_every_receipt_a_lot_and_both_void(db, shop):
    """[R2, R4] The PRE-TRACKING stranding, closed by processing heats first.

    Entry 0 has no heat, entry 1 has one, on a part nobody tracks yet. In payload order, entry 0
    lands lot-less and entry 1 then switches tracking on, moving entry 0's stock into
    PRE-TRACKING: receipt 0 records no lot and can never be voided. Heats first, entry 1 starts
    tracking with nothing to migrate and entry 0 lands in a lot of its own.
    """
    po = _bar(db, shop)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 4, location=shop.shelf),
                                   ps.entry(po.lines[0], 6, location=shop.shelf, heat="H-77")])
    receipts = ps.receipts_of(db, po.id)
    untagged = next(r for r in receipts if r["heat_number"] is None)
    tagged = next(r for r in receipts if r["heat_number"] == "H-77")
    assert untagged["entry_index"] < tagged["entry_index"], "entry_index is the payload's order, not processing order"
    assert untagged["lot_id"] is not None, "the untagged entry was stranded before tracking started"
    assert tagged["lot_id"] is not None and tagged["lot_id"] != untagged["lot_id"]

    for receipt in (untagged, tagged):
        assert ps.void_receipt(shop.admin, receipt["id"])["voided"] is True
    assert ps.balance(db, shop.bar, shop.shelf) == 0


def test_the_first_heat_on_an_untracked_part_records_started_tracking(db, shop):
    """[R2] The receipt remembers that it was the one that started tracking the part."""
    po = _bar(db, shop)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 3, location=shop.shelf, heat="H-1")])
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 3, location=shop.shelf, heat="H-2")])
    first, second = ps.receipts_of(db, po.id)
    assert (first["started_tracking"], second["started_tracking"]) == (True, False)
    assert ps.lot_tracked(db, shop.bar) is True


def test_a_location_that_has_places_under_it_is_refused(db, shop):
    """[R2] Stock sits on leaves: the rack holds a shelf, so nothing is received onto the rack."""
    po = _bar(db, shop)
    ps.assert_sentence_refusal(_refuse_receipt(shop, po.id, [ps.entry(po.lines[0], 1, location=shop.rack)]))
    assert ps.receipts_of(db, po.id) == []


# ── R3: atomic, idempotent, splittable, flagged ────────────────────────────────────────────────


def test_a_batch_naming_another_companys_location_writes_nothing(db, shop, other_shop):
    """[R3, S3] The third entry's place belongs to someone else. The first two must not land:
    no receipts, no ledger rows, no stock, no lot for the heat."""
    po = _sent(db, shop, ps.part_line(shop.bar, 10, "feet"), ps.part_line(shop.screw, 2, "hundred"))
    before = ps.footprint(db, shop.company)
    err = _refuse_receipt(shop, po.id, [
        ps.entry(po.lines[0], 2, location=shop.shelf, heat="H-5"),
        ps.entry(po.lines[1], 1, location=shop.shelf),
        ps.entry(po.lines[0], 1, location=other_shop.shelf),
    ])
    ps.assert_sentence_refusal(err)
    assert ps.footprint(db, shop.company) == before
    assert ps.scalar(db, "SELECT count(*) FROM material_lots WHERE part_id = %s", (shop.bar,)) == 0


def test_replaying_a_receipt_group_returns_the_first_result_and_writes_nothing(db, shop):
    """[R3] The same `receipt_group_id` twice — a lost response, a second tab, an assistant's
    retry — writes one set of receipts and one ledger row."""
    po = _screws(db, shop)
    group = str(uuid.uuid4())
    entries = [ps.entry(po.lines[0], 1, location=shop.shelf)]
    first = ps.receive(shop.admin, po.id, entries, group=group)
    replay = ps.receive(shop.admin, po.id, entries, group=group)

    assert replay == first
    assert len(ps.receipts_of(db, po.id)) == 1
    assert _ledger_count(db, shop.screw, "addition") == 1
    assert ps.balance(db, shop.screw, shop.shelf) == 100


def test_one_line_can_be_split_across_heats_and_places(db, shop):
    """[R3] "+ another heat or place": three entries for one line, three receipts, three
    balances keyed by (place, heat)."""
    shelf_2 = ps.add_shelf(db, shop, "Shelf A2")
    po = _bar(db, shop)
    line = po.lines[0]
    ps.receive(shop.admin, po.id, [ps.entry(line, 3, location=shop.shelf, heat="H-1"),
                                   ps.entry(line, 4, location=shelf_2, heat="H-2"),
                                   ps.entry(line, 3, location=shelf_2, heat="H-1")])

    assert sorted(r["stock_quantity"] for r in ps.receipts_of(db, po.id)) == [36, 36, 48]
    h1 = ps.row(db, "SELECT id FROM material_lots WHERE part_id = %s AND heat_number = 'H-1'", (shop.bar,))["id"]
    h2 = ps.row(db, "SELECT id FROM material_lots WHERE part_id = %s AND heat_number = 'H-2'", (shop.bar,))["id"]
    assert ps.balance(db, shop.bar, shop.shelf, h1) == 36
    assert ps.balance(db, shop.bar, shelf_2, h2) == 48
    assert ps.balance(db, shop.bar, shelf_2, h1) == 36
    assert ps.line_status(db, line)["status"] == ps.RECEIVED


def test_an_over_receipt_is_recorded_and_flagged(db, shop):
    """[R3] 12 ft against 10 ordered: it records, and the result says so."""
    po = _bar(db, shop)
    result = ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 12, location=shop.shelf)])
    assert any(r.get("over_received") for r in result["receipts"]), "an over-receipt was not flagged"
    status = ps.line_status(db, po.lines[0])
    assert status["status"] == ps.RECEIVED and Decimal(status["received_stock_quantity"]) == 144


def test_close_remaining_closes_a_short_line(db, shop):
    """[R3] "That's everything — close the remaining 4": the line closes, its sibling does not."""
    po = _sent(db, shop, ps.part_line(shop.bar, 10, "feet"), ps.part_line(shop.screw, 1, "hundred"))
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 6, location=shop.shelf, close_remaining=True)])
    assert ps.line_row(db, po.lines[0])["closed_at"] is not None
    assert ps.line_status(db, po.lines[0])["status"] == ps.CLOSED
    assert ps.line_status(db, po.lines[1])["status"] == ps.LINE_OPEN


def test_receiving_a_draft_is_refused_and_says_mark_it_sent_first(db, shop):
    """[R3] Receiving is against what the vendor was sent; the UI offers "Mark it sent today"."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")])
    err = _refuse_receipt(shop, po.id, [ps.entry(po.lines[0], 1, location=shop.shelf)])
    ps.assert_state_refusal(err, ps.DRAFT_RECEIPT_HINT)


@pytest.mark.parametrize("closed", ["the-po", "the-line"])
def test_a_closed_po_or_a_closed_line_takes_no_receipt(db, shop, closed):
    """[R3] Nothing more is expected, so nothing more is received against it."""
    po = _bar(db, shop)
    if closed == "the-po":
        ps.set_state(shop.admin, po.id, "close")
    else:
        ps.set_lines(shop.admin, po.id, [po.lines[0]], "close")
    ps.assert_state_refusal(_refuse_receipt(shop, po.id, [ps.entry(po.lines[0], 1, location=shop.shelf)]))
    assert ps.receipts_of(db, po.id) == []


def test_outside_work_is_received_on_its_slip_not_here(db, shop):
    """[R3] The slip stays the only record of movement for outside work (§3.6)."""
    po = _sent(db, shop, ps.outside_line(shop.outside_op, 100))
    err = _refuse_receipt(shop, po.id, [ps.entry(po.lines[0], 10)])
    ps.assert_state_refusal(err, ps.OUTSIDE_RECEIPT_HINT)


def test_an_other_line_records_quantity_only(db, shop):
    """[R3] A calibration visit is received, not stocked: no place, no ledger row, no lot."""
    po = _sent(db, shop, ps.other_line("Calibrate the CMM", unit_price=450, work_center_id=shop.work_center))
    ledger_before = ps.count(db, "inventory_transactions", shop.company)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 1)])

    (receipt,) = ps.receipts_of(db, po.id)
    assert receipt["line_kind"] == "other" and receipt["quantity"] == 1
    for column in ("part_id", "location_id", "lot_id", "stock_quantity", "inventory_transaction_id"):
        assert receipt[column] is None, f"an other-line receipt carries {column}"
    assert ps.count(db, "inventory_transactions", shop.company) == ledger_before
    assert ps.line_status(db, po.lines[0])["status"] == ps.RECEIVED


# ── R4: voids ───────────────────────────────────────────────────────────────────────────────────


def test_a_void_reverses_the_stock_through_the_ledger(db, shop):
    """[R4] A depletion that names the lot, stamped on the receipt; the line is open again."""
    po = _bar(db, shop)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 5, location=shop.shelf, heat="H-3")])
    (receipt,) = ps.receipts_of(db, po.id)

    assert ps.void_receipt(shop.user, receipt["id"], reason="Booked to the wrong PO")["voided"] is True
    (voided,) = ps.receipts_of(db, po.id)
    assert voided["voided_at"] is not None and voided["voided_by"] == shop.user
    assert voided["void_reason"] == "Booked to the wrong PO"
    reversal = ps.ledger_row(db, voided["void_transaction_id"])
    assert reversal["type"] == "depletion" and reversal["converted_quantity"] == 60
    assert reversal["lot_id"] == receipt["lot_id"]
    assert ps.balance(db, shop.bar, shop.shelf) == 0
    assert ps.line_status(db, po.lines[0])["status"] == ps.LINE_OPEN


def test_a_void_is_refused_once_the_stock_has_gone_to_a_job(db, shop):
    """[R4] 100 of the 120 in went into the job. The void refuses and changes nothing; the shop
    corrects it with a count instead."""
    po = _bar(db, shop)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 10, location=shop.shelf, heat="H-4")])
    (receipt,) = ps.receipts_of(db, po.id)
    ps.call(shop.admin, "deplete_stock_at_location", p_part_id=shop.bar, p_location_id=shop.shelf,
            p_quantity=100, p_unit="inches", p_converted_quantity=100, p_job_id=shop.job,
            p_lot_id=receipt["lot_id"])

    err = ps.refuse(shop.admin, "void_vendor_purchase_order_receipt", p_receipt_id=receipt["id"])
    ps.assert_sentence_refusal(err)
    assert ps.receipts_of(db, po.id)[0]["voided_at"] is None
    assert ps.balance(db, shop.bar, shop.shelf) == 20


def test_a_second_void_changes_nothing_and_says_so(db, shop):
    """[R4] Idempotent: `{voided: false}` the second time, and one reversal in the ledger."""
    po = _screws(db, shop)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 1, location=shop.shelf)])
    receipt = ps.receipts_of(db, po.id)[0]["id"]
    assert ps.void_receipt(shop.admin, receipt)["voided"] is True
    assert ps.void_receipt(shop.admin, receipt)["voided"] is False
    assert _ledger_count(db, shop.screw, "depletion") == 1


def test_voiding_the_receipt_that_started_tracking_leaves_tracking_on(db, shop):
    """[R4] Tracking is switched off only by a deliberate act; the lot stays."""
    po = _bar(db, shop)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 2, location=shop.shelf, heat="H-6")])
    (receipt,) = ps.receipts_of(db, po.id)
    assert receipt["started_tracking"] is True
    ps.void_receipt(shop.admin, receipt["id"])
    assert ps.lot_tracked(db, shop.bar) is True
    assert ps.lot_row(db, receipt["lot_id"]) is not None


# ── R5: the stock engine, changed only by its return value ─────────────────────────────────────

STOCK_SIGNATURES = {
    "add_stock_at_location": (
        "p_part_id uuid, p_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, "
        "p_notes text, p_operator_id uuid, p_photo_path text, p_heat_number text, p_lot_id uuid"),
    "deplete_stock_at_location": (
        "p_part_id uuid, p_location_id uuid, p_quantity numeric, p_unit text, p_converted_quantity numeric, "
        "p_graceful boolean, p_notes text, p_job_id uuid, p_job_operation_id uuid, p_operator_id uuid, "
        "p_heat_number text, p_lot_id uuid"),
}


@pytest.mark.parametrize("name", sorted(STOCK_SIGNATURES))
def test_each_stock_rpc_keeps_one_overload_its_signature_and_its_grants(db, name):
    """[R5] CREATE OR REPLACE word for word: one overload PostgREST can resolve, the same
    arguments, authenticated can execute and anon cannot."""
    found = ps.rows(db, """
        SELECT pg_get_function_identity_arguments(p.oid) AS args,
               has_function_privilege('authenticated', p.oid, 'EXECUTE') AS browser,
               has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
          FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = %s""", (name,))
    assert len(found) == 1, f"{name} has {len(found)} overloads"
    assert found[0]["args"] == STOCK_SIGNATURES[name]
    assert (found[0]["browser"], found[0]["anon"]) == (True, False)


def test_both_stock_rpcs_hand_back_their_ledger_row_and_ad_hoc_callers_still_work(db, shop):
    """[R5] The operator's ad-hoc receive and take, exactly as they call today, now also get
    `transaction_id` — and every key they already read is still there."""
    added = ps.call(shop.operator, "add_stock_at_location", p_part_id=shop.screw, p_location_id=shop.shelf,
                    p_quantity=40, p_unit="each", p_converted_quantity=40)
    assert ps.ledger_row(db, added["transaction_id"])["type"] == "addition"
    assert added["location_balance"] == 40 and added["part_quantity"] == 40 and added["started_tracking"] is False

    taken = ps.call(shop.operator, "deplete_stock_at_location", p_part_id=shop.screw, p_location_id=shop.shelf,
                    p_quantity=15, p_unit="each", p_converted_quantity=15, p_graceful=False)
    assert ps.ledger_row(db, taken["transaction_id"])["type"] == "depletion"
    assert taken["location_balance"] == 25 and taken["has_discrepancy"] is False


# ── Founder default: no "received" gate on a bought job part ──────────────────────────────────


def test_a_receipt_against_a_job_leaves_the_jobs_statuses_alone(db, shop):
    """[R1, §2] A bought part on a job keeps today's production status; the job shows its POs
    instead. The receipt touches neither `job_parts` nor `jobs` — not even `updated_at`."""
    bought = ps.add_job_part(db, shop, shop.screw, 50)
    before_part = ps.row(db, "SELECT production_status, updated_at FROM job_parts WHERE id = %s", (bought,))
    before_job = ps.row(db, "SELECT production_status, updated_at FROM jobs WHERE id = %s", (shop.job,))

    po = _sent(db, shop, ps.part_line(shop.screw, 0.5, "hundred", job_id=shop.job, job_part_id=bought))
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 0.5, location=shop.shelf)])

    assert ps.row(db, "SELECT production_status, updated_at FROM job_parts WHERE id = %s", (bought,)) == before_part
    assert ps.row(db, "SELECT production_status, updated_at FROM jobs WHERE id = %s", (shop.job,)) == before_job
