"""Requests for quotation: invite, record responses, compare, award (plan §3.2, §3.3, §3.9; Q1–Q3).

WHAT THIS GUARDS.

  * **Structure.** An RFQ is numbered from its own `RFQ-` series and invites each vendor with
    a frozen contact. A line is a part or ad-hoc text, in one unit, asking for 1–4 positive
    quantities (Q1).
  * **Responses belong to one RFQ structurally.** Composite foreign keys tie a response to an
    invitation AND a line of the same RFQ; there is one response per (invitation, line,
    quantity), and its quantity must be one the line asked for. Prices are per the RFQ line's
    unit, or "no bid". A declined vendor's responses are refused; awarded responses are frozen;
    a quoted line cannot be removed and an archived RFQ refuses edits (Q1, Q2).
  * **Award is atomic** and makes one DRAFT purchase order per vendor, ad-hoc lines becoming
    "other" lines; a line is awarded once; a failure half-way leaves nothing; price sheets are
    written only when asked, creating the vendor's list row as Approved (Q3).

Run:
    cd api && pytest -m integration tests/integration/test_vendor_rfqs.py
"""
from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

import pytest
from psycopg2 import errors

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, shop  # noqa: F401

pytestmark = pytest.mark.integration


@dataclass
class Rfq:
    id: str
    number: str
    lines: list[str]
    invitations: dict[str, str]  # vendor_id → invitation id


def _rfq(db, shop: ps.Shop, lines: list[dict], vendors: list[str] | None = None, *, send: bool = True) -> Rfq:
    vendors = vendors or [shop.v1, shop.v2]
    rfq_id, number = ps.create_rfq(shop.user, shop.company, lines, vendors)
    invitations = {vendor: str(row["id"]) for vendor, row in ps.invitations_of(db, rfq_id).items()}
    if send:
        for invitation in invitations.values():
            ps.set_invitation(shop.user, invitation, "mark_sent")
    return Rfq(rfq_id, number, [str(r["id"]) for r in ps.rfq_lines_of(db, rfq_id)], invitations)


def _response(db, rfq: Rfq, invitation: str, line: str, quantity) -> dict:
    return next(r for r in ps.responses_of(db, rfq.id)
                if str(r["vendor_rfq_invitation_id"]) == invitation and str(r["vendor_rfq_line_id"]) == line
                and Decimal(r["quantity"]) == Decimal(str(quantity)))


def _quote(shop: ps.Shop, rfq: Rfq, vendor: str, *responses) -> None:
    """(line, quantity, unit_price) triples for one vendor's invitation."""
    ps.save_responses(shop.user, rfq.invitations[vendor],
                      [{"line_id": line, "quantity": qty, "unit_price": price, "lead_time_days": 10}
                       for line, qty, price in responses])


def _refuse_responses(shop: ps.Shop, invitation: str, responses: list[dict]):
    return ps.refuse(shop.user, "save_vendor_rfq_responses", p_invitation_id=invitation, p_responses=responses)


def _pos_from(db, rfq: Rfq) -> list[dict]:
    return ps.rows(db, "SELECT * FROM vendor_purchase_orders WHERE vendor_rfq_id = %s ORDER BY created_at", (rfq.id,))


# ── Q1: structure ───────────────────────────────────────────────────────────────────────────────


def test_an_rfq_is_numbered_and_invites_each_vendor_with_a_contact_snapshot(db, shop):
    """[Q1] RFQ-0001; one invitation per vendor carrying its name and its sales-then-primary
    contact as printed; a part line in one unit with up to four quantities."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10, 50, 100, 500])], send=False)
    assert rfq.number == "RFQ-0001"

    invitations = ps.invitations_of(db, rfq.id)
    assert set(invitations) == {shop.v1, shop.v2}
    assert invitations[shop.v1]["vendor_name"] == shop.v1_name
    assert invitations[shop.v1]["vendor_contact"]["name"] == "Sally Sales"
    assert invitations[shop.v2]["vendor_contact"]["name"] == "Vic Dock"

    (line,) = ps.rfq_lines_of(db, rfq.id)
    assert line["part_id"] == shop.bar and line["part_name"] == shop.bar_name and line["unit"] == "feet"
    assert [Decimal(q) for q in line["quantities"]] == [10, 50, 100, 500]
    assert ps.rfq_status(db, rfq.id) == "draft"


@pytest.mark.parametrize("quantities", [[], [1, 2, 3, 4, 5], [10, 0], [-5]])
def test_a_line_asks_for_one_to_four_positive_quantities(db, shop, quantities):
    """[Q1] Zero, five, a zero and a negative are each refused before anything is written."""
    err = ps.refuse(shop.user, "create_vendor_rfq",
                    **ps.rfq_create_args(shop.company, [ps.rfq_adhoc_line("Brackets", quantities)], [shop.v1]))
    ps.assert_sentence_refusal(err)
    assert ps.count(db, "vendor_rfqs", shop.company) == 0


def test_the_status_walks_draft_sent_quoted_awarded_closed(db, shop):
    """[Q1] Derived in `vendor_rfq_status`, never stored."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10])], send=False)
    assert ps.rfq_status(db, rfq.id) == "draft"
    ps.set_invitation(shop.user, rfq.invitations[shop.v1], "mark_sent")
    assert ps.rfq_status(db, rfq.id) == "sent"
    _quote(shop, rfq, shop.v1, (rfq.lines[0], 10, 24))
    assert ps.rfq_status(db, rfq.id) == "quoted"
    ps.award(shop.user, rfq.id, [str(_response(db, rfq, rfq.invitations[shop.v1], rfq.lines[0], 10)["id"])])
    assert ps.rfq_status(db, rfq.id) == "awarded"
    ps.set_rfq_state(shop.user, rfq.id, "close")
    assert ps.rfq_status(db, rfq.id) == "closed"


def test_a_quoted_line_cannot_be_removed_but_an_unquoted_one_can(db, shop):
    """[Q1] Removing a line that has responses would orphan prices a vendor gave us."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10]), ps.rfq_adhoc_line("Saw-cut blanks", [20])])
    _quote(shop, rfq, shop.v1, (rfq.lines[0], 10, 24))

    err = ps.refuse(shop.user, "save_vendor_rfq", p_id=rfq.id, p_changes={}, p_removed_line_ids=[rfq.lines[0]],
                    p_expected_updated_at=ps.rfq_updated_at_text(db, rfq.id))
    ps.assert_state_refusal(err)
    ps.save_rfq(db, shop.user, rfq.id, p_removed_line_ids=[rfq.lines[1]])
    assert [str(r["id"]) for r in ps.rfq_lines_of(db, rfq.id)] == [rfq.lines[0]]


def test_an_archived_rfq_refuses_edits_and_responses(db, shop):
    """[Q1] Archive is a soft delete; an archived RFQ is read-only."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10])])
    ps.set_rfq_state(shop.user, rfq.id, "archive")
    assert ps.rfq_row(db, rfq.id)["deleted_at"] is not None

    err = ps.refuse(shop.user, "save_vendor_rfq", p_id=rfq.id, p_changes={"title": "Renamed"},
                    p_expected_updated_at=ps.rfq_updated_at_text(db, rfq.id))
    ps.assert_state_refusal(err)
    ps.assert_state_refusal(_refuse_responses(shop, rfq.invitations[shop.v1],
                                              [{"line_id": rfq.lines[0], "quantity": 10, "unit_price": 24}]))


# ── Q1 / Q2: responses ─────────────────────────────────────────────────────────────────────────


def test_a_response_cannot_point_at_another_rfqs_line(db, shop):
    """[Q1, Q2] The composite foreign key makes it unrepresentable; the RPC refuses it first."""
    first = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10])], [shop.v1])
    second = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10])], [shop.v1])

    with pytest.raises(errors.ForeignKeyViolation):
        ps.execute(db, """
            INSERT INTO vendor_rfq_responses (company_id, vendor_rfq_id, vendor_rfq_invitation_id,
                                              vendor_rfq_line_id, quantity, unit_price)
            VALUES (%s, %s, %s, %s, 10, 5)""",
                   (shop.company, first.id, first.invitations[shop.v1], second.lines[0]))

    ps.assert_sentence_refusal(_refuse_responses(shop, first.invitations[shop.v1],
                                                 [{"line_id": second.lines[0], "quantity": 10, "unit_price": 5}]))
    assert ps.responses_of(db, first.id) == [] and ps.responses_of(db, second.id) == []


def test_a_duplicate_response_is_refused(db, shop):
    """[Q2] One price per (invitation, line, quantity), in the RPC and in the table."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10, 50])])
    err = _refuse_responses(shop, rfq.invitations[shop.v1], [
        {"line_id": rfq.lines[0], "quantity": 10, "unit_price": 24},
        {"line_id": rfq.lines[0], "quantity": 10, "unit_price": 23}])
    ps.assert_refused(err, ("P0001", "23514", "23505"))

    _quote(shop, rfq, shop.v1, (rfq.lines[0], 10, 24))
    with pytest.raises(errors.UniqueViolation):
        ps.execute(db, """
            INSERT INTO vendor_rfq_responses (company_id, vendor_rfq_id, vendor_rfq_invitation_id,
                                              vendor_rfq_line_id, quantity, unit_price)
            VALUES (%s, %s, %s, %s, 10, 23)""",
                   (shop.company, rfq.id, rfq.invitations[shop.v1], rfq.lines[0]))


def test_a_response_quantity_must_be_one_the_line_asked_for(db, shop):
    """[Q2] A price at 25 answers a question nobody asked."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10, 50])])
    ps.assert_sentence_refusal(_refuse_responses(shop, rfq.invitations[shop.v1],
                                                 [{"line_id": rfq.lines[0], "quantity": 25, "unit_price": 24}]))


def test_a_response_is_priced_per_line_unit_or_is_a_no_bid(db, shop):
    """[Q2] The full response grid: price per RFQ-line unit, lead time, minimum, validity,
    vendor P/N — or "no bid", which carries no price."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10, 50])])
    ps.save_responses(shop.user, rfq.invitations[shop.v1], [
        {"line_id": rfq.lines[0], "quantity": 10, "unit_price": 24.5, "lead_time_days": 7,
         "minimum_order_quantity": 10, "valid_until": "2026-12-31", "vendor_part_number": "AT-4140-1"},
        {"line_id": rfq.lines[0], "quantity": 50, "no_bid": True},
    ])
    priced = _response(db, rfq, rfq.invitations[shop.v1], rfq.lines[0], 10)
    assert priced["unit_price"] == Decimal("24.5") and priced["no_bid"] is False
    assert (priced["lead_time_days"], priced["vendor_part_number"]) == (7, "AT-4140-1")
    no_bid = _response(db, rfq, rfq.invitations[shop.v1], rfq.lines[0], 50)
    assert no_bid["no_bid"] is True and no_bid["unit_price"] is None


def test_responses_can_be_edited_until_awarded_then_they_freeze(db, shop):
    """[Q2] A vendor revises a price; once it is awarded, the price is the PO's."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10])])
    _quote(shop, rfq, shop.v1, (rfq.lines[0], 10, 24))
    _quote(shop, rfq, shop.v1, (rfq.lines[0], 10, 23))
    revised = _response(db, rfq, rfq.invitations[shop.v1], rfq.lines[0], 10)
    assert revised["unit_price"] == 23

    ps.award(shop.user, rfq.id, [str(revised["id"])])
    ps.assert_state_refusal(_refuse_responses(shop, rfq.invitations[shop.v1],
                                              [{"line_id": rfq.lines[0], "quantity": 10, "unit_price": 21}]))
    assert _response(db, rfq, rfq.invitations[shop.v1], rfq.lines[0], 10)["unit_price"] == 23


def test_a_declined_vendors_responses_are_refused_until_the_decline_is_undone(db, shop):
    """[Q2] Declined is a state of the invitation: no prices while it holds."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10])])
    ps.set_invitation(shop.user, rfq.invitations[shop.v2], "decline", reason="No capacity this month")
    assert ps.invitations_of(db, rfq.id)[shop.v2]["declined_at"] is not None

    ps.assert_state_refusal(_refuse_responses(shop, rfq.invitations[shop.v2],
                                              [{"line_id": rfq.lines[0], "quantity": 10, "unit_price": 22}]))

    ps.set_invitation(shop.user, rfq.invitations[shop.v2], "undo_decline")
    assert ps.invitations_of(db, rfq.id)[shop.v2]["declined_at"] is None
    _quote(shop, rfq, shop.v2, (rfq.lines[0], 10, 22))


# ── Q3: award ───────────────────────────────────────────────────────────────────────────────────


def test_award_to_two_vendors_makes_one_draft_po_each_and_stamps_the_links(db, shop):
    """[Q3] The cheaper bar from V2, the screws from V1: two DRAFT POs tied to the RFQ, each line
    priced from its response (`price_source` 'rfq'), the factor from the part's conversion, and
    each awarded response pointing at the PO line it became."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10, 50]), ps.rfq_part_line(shop.screw, "hundred", [5])])
    bar, screws = rfq.lines
    _quote(shop, rfq, shop.v1, (bar, 10, 24), (screws, 5, 13))
    _quote(shop, rfq, shop.v2, (bar, 10, 22.5), (screws, 5, 12))
    bar_from_v2 = _response(db, rfq, rfq.invitations[shop.v2], bar, 10)
    screws_from_v1 = _response(db, rfq, rfq.invitations[shop.v1], screws, 5)

    ps.award(shop.user, rfq.id, [str(bar_from_v2["id"]), str(screws_from_v1["id"])])

    pos = {str(p["vendor_id"]): p for p in _pos_from(db, rfq)}
    assert set(pos) == {shop.v1, shop.v2}
    assert all(p["issued_at"] is None for p in pos.values()), "an award sent a PO nobody reviewed"

    (v2_line,) = ps.lines_of(db, pos[shop.v2]["id"])
    assert (v2_line["part_id"], v2_line["quantity"], v2_line["unit"]) == (shop.bar, 10, "feet")
    assert (v2_line["unit_price"], v2_line["price_source"], v2_line["stock_factor"]) == (Decimal("22.5"), "rfq", 12)
    (v1_line,) = ps.lines_of(db, pos[shop.v1]["id"])
    assert (v1_line["part_id"], v1_line["quantity"], v1_line["unit_price"]) == (shop.screw, 5, 13)

    stamped = {str(r["id"]): r for r in ps.responses_of(db, rfq.id)}
    assert str(stamped[str(bar_from_v2["id"])]["vendor_purchase_order_line_id"]) == str(v2_line["id"])
    assert str(stamped[str(screws_from_v1["id"])]["vendor_purchase_order_line_id"]) == str(v1_line["id"])
    assert stamped[str(bar_from_v2["id"])]["awarded_at"] is not None
    losers = [r for key, r in stamped.items() if key not in (str(bar_from_v2["id"]), str(screws_from_v1["id"]))]
    assert all(r["awarded_at"] is None for r in losers)


def test_an_ad_hoc_line_awards_as_an_other_line(db, shop):
    """[Q3] Free text has no part, so the PO line it becomes is an "other" line."""
    rfq = _rfq(db, shop, [ps.rfq_adhoc_line("Heat treat 40 brackets to 40 HRC", [40])], [shop.v1])
    _quote(shop, rfq, shop.v1, (rfq.lines[0], 40, 3.10))
    ps.award(shop.user, rfq.id, [str(_response(db, rfq, rfq.invitations[shop.v1], rfq.lines[0], 40)["id"])])

    (po,) = _pos_from(db, rfq)
    (line,) = ps.lines_of(db, po["id"])
    assert line["line_kind"] == "other" and line["part_id"] is None
    assert "Heat treat" in line["description"]
    assert (line["quantity"], line["unit_price"]) == (40, Decimal("3.1"))


def test_a_line_cannot_be_awarded_twice(db, shop):
    """[Q3] Not the same response again, and not another vendor's price for the same line."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10])])
    _quote(shop, rfq, shop.v1, (rfq.lines[0], 10, 24))
    _quote(shop, rfq, shop.v2, (rfq.lines[0], 10, 22))
    from_v1 = str(_response(db, rfq, rfq.invitations[shop.v1], rfq.lines[0], 10)["id"])
    from_v2 = str(_response(db, rfq, rfq.invitations[shop.v2], rfq.lines[0], 10)["id"])
    ps.award(shop.user, rfq.id, [from_v1])

    for again in (from_v1, from_v2):
        ps.assert_state_refusal(ps.refuse(shop.user, "award_vendor_rfq", **ps.award_args(rfq.id, [again])))
    assert len(_pos_from(db, rfq)) == 1


def test_an_award_that_fails_part_way_leaves_nothing(db, shop):
    """[Q3] V2 was archived after quoting. The award of both lines fails on V2's PO — and V1's
    PO, created first, must not survive it: no POs, no stamped responses."""
    rfq = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10]), ps.rfq_part_line(shop.screw, "hundred", [5])])
    _quote(shop, rfq, shop.v1, (rfq.lines[0], 10, 24))
    _quote(shop, rfq, shop.v2, (rfq.lines[1], 5, 12))
    winners = [str(_response(db, rfq, rfq.invitations[shop.v1], rfq.lines[0], 10)["id"]),
               str(_response(db, rfq, rfq.invitations[shop.v2], rfq.lines[1], 5)["id"])]
    ps.execute(db, "UPDATE vendors SET deleted_at = now() WHERE id = %s", (shop.v2,))

    ps.assert_sentence_refusal(ps.refuse(shop.user, "award_vendor_rfq", **ps.award_args(rfq.id, winners)))
    assert _pos_from(db, rfq) == []
    assert ps.count(db, "vendor_purchase_orders", shop.company) == 0
    assert all(r["awarded_at"] is None for r in ps.responses_of(db, rfq.id))


def test_price_sheets_are_saved_only_when_asked_and_create_an_approved_row(db, shop):
    """[Q3] The "Save to price sheets" box is off by default. Ticked, it upserts V2's list row
    for the part — Approved when it was missing — with a break from the awarded response."""
    plain = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10])], [shop.v2])
    _quote(shop, plain, shop.v2, (plain.lines[0], 10, 22.5))
    ps.award(shop.user, plain.id, [str(_response(db, plain, plain.invitations[shop.v2], plain.lines[0], 10)["id"])])
    assert ps.avl_row(db, shop.bar, shop.v2) is None, "an award wrote a price sheet nobody asked for"

    saved = _rfq(db, shop, [ps.rfq_part_line(shop.bar, "feet", [10])], [shop.v2])
    _quote(shop, saved, shop.v2, (saved.lines[0], 10, 21))
    winner = str(_response(db, saved, saved.invitations[shop.v2], saved.lines[0], 10)["id"])
    ps.award(shop.user, saved.id, [winner], save_to_sheets=True)

    row = ps.avl_row(db, shop.bar, shop.v2)
    assert row is not None and row["status"] == "approved" and row["purchase_unit"] == "feet"
    from_rfq = [b for b in ps.breaks_of(db, row["id"]) if b["source"] == "rfq"]
    assert any(str(b["vendor_rfq_response_id"]) == winner and b["unit_price"] == 21 for b in from_rfq)
