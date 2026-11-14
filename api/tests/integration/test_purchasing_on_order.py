"""On order and Last PO price, as the views compute them (plan §3.4, §3.10; B1, L2).

WHAT THIS GUARDS. "On order" feeds the buy list, the job's Materials card, the part's places
drawer and three MCP tools, so it is computed ONCE, in `part_on_order`, and every one of those
reads it. The rules a re-derivation would get wrong:

  * **Stock units.** 2.5 `hundred` is 250 `each` on order, so it can be netted against stock.
  * **Only sent, open, live part lines.** A draft is "on draft", shown separately; a closed
    line, a closed or archived PO and a fully received line are on order for nobody.
  * **Receipts lower it, voids restore it** — it is derived, never stored.
  * **A unit that no longer matches the part's stock unit is counted, not converted.** The line
    froze `each`; if the part is now stocked in boxes, adding the two would be a wrong number.
  * **Last PO price** is the newest PRICED line on a SENT, live PO per (part, vendor) — never a
    draft, never an archived PO, never a "to be confirmed" line.

Run:
    cd api && pytest -m integration tests/integration/test_purchasing_on_order.py
"""
from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, shop  # noqa: F401

pytestmark = pytest.mark.integration


def _bar_po(db, shop: ps.Shop, feet, *, sent: bool = True) -> ps.Po:
    return ps.make_po(db, shop, [ps.part_line(shop.bar, feet, "feet")], sent=sent)


def _quantities(db, part: str) -> tuple[Decimal, Decimal]:
    found = ps.on_order(db, part)
    return Decimal(found["on_order_quantity"]), Decimal(found["on_draft_quantity"])


def test_a_draft_counts_on_draft_and_sending_it_moves_it_on_order(db, shop):
    """[B1] 10 ft drafted is 120 in on draft; once sent it is 120 in on order."""
    po = _bar_po(db, shop, 10, sent=False)
    assert _quantities(db, shop.bar) == (0, 120)
    ps.mark_sent(shop.admin, po.id)
    assert _quantities(db, shop.bar) == (120, 0)


def test_closed_archived_and_fully_received_lines_are_on_order_for_nobody(db, shop):
    """[B1] Only the first PO counts: the others are a closed line, an archived PO, a closed PO
    and a line already received in full."""
    _bar_po(db, shop, 10)

    closed_line = _bar_po(db, shop, 5)
    ps.set_lines(shop.admin, closed_line.id, closed_line.lines, "close")
    archived = _bar_po(db, shop, 2)
    ps.set_state(shop.admin, archived.id, "archive")
    closed_po = _bar_po(db, shop, 3)
    ps.set_state(shop.admin, closed_po.id, "close")
    received = _bar_po(db, shop, 1)
    ps.receive(shop.admin, received.id, [ps.entry(received.lines[0], 1, location=shop.shelf)])

    assert _quantities(db, shop.bar)[0] == 120


def test_a_hundred_line_is_on_order_in_stock_units(db, shop):
    """[B1, L3] 2.5 hundred screws are 250 each on order."""
    ps.make_po(db, shop, [ps.part_line(shop.screw, 2.5, "hundred")], sent=True)
    assert _quantities(db, shop.screw) == (250, 0)


def test_a_partial_receipt_lowers_on_order_and_a_void_restores_it(db, shop):
    """[B1] Derived from the receipts, so a void puts it straight back."""
    po = ps.make_po(db, shop, [ps.part_line(shop.screw, 2.5, "hundred")], sent=True)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 1, location=shop.shelf)])
    assert _quantities(db, shop.screw)[0] == 150

    ps.void_receipt(shop.admin, ps.receipts_of(db, po.id)[0]["id"])
    assert _quantities(db, shop.screw)[0] == 250


def test_a_change_of_stock_unit_moves_the_line_to_the_mismatch_count(db, shop):
    """[B1] The line froze `each`; the part is now stocked in boxes. It is counted as a
    mismatch and left out of the quantity rather than added in the wrong unit."""
    ps.make_po(db, shop, [ps.part_line(shop.screw, 2, "hundred")], sent=True)
    ps.execute(db, "UPDATE parts SET primary_unit = 'box' WHERE id = %s", (shop.screw,))
    found = ps.on_order(db, shop.screw)
    assert Decimal(found["on_order_quantity"]) == 0
    assert found["unit_mismatch_line_count"] == 1


def test_last_po_price_is_the_newest_priced_line_on_a_sent_live_po_per_vendor(db, shop):
    """[L2] "Last PO price": newer drafts, newer archived POs and newer unpriced lines are all
    skipped; each vendor has its own."""
    def bought(vendor: str, price, day: date, *, send: bool = True, archive: bool = False) -> ps.Po:
        po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet", unit_price=price,
                                                price_source=None if price is None else "manual")],
                        vendor=vendor, ordered_on=day, sent=send)
        if archive:
            ps.set_state(shop.admin, po.id, "archive")
        return po

    bought(shop.v1, 2.00, date(2026, 10, 1))
    newest_live = bought(shop.v1, 2.20, date(2026, 10, 15))
    bought(shop.v1, 1.90, date(2026, 11, 1), archive=True)
    bought(shop.v1, 1.50, date(2026, 11, 2), send=False)
    bought(shop.v1, None, date(2026, 11, 3))
    from_v2 = bought(shop.v2, 2.75, date(2026, 10, 20))

    last = {str(r["vendor_id"]): r for r in ps.rows(
        db, "SELECT * FROM part_vendor_last_purchase WHERE part_id = %s", (shop.bar,))}
    assert last[shop.v1]["po_number"] == newest_live.number
    assert Decimal(last[shop.v1]["unit_price"]) == Decimal("2.2")
    assert last[shop.v2]["po_number"] == from_v2.number
    assert Decimal(last[shop.v2]["unit_price"]) == Decimal("2.75")
