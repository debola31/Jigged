"""The Jigged side of a vendor-PO push: the projection, its hash, and the name rules.

The projection is what Jigged would tell QuickBooks about one PO, built from the
database rows and nothing else. Its hash is what makes "a push with no changes"
cost ZERO provider calls: it is compared with the hash stored at the last push
before anything resolves a term, a ship method or a vendor (plan §3.11).

Criteria: QB6 (vendor-name rules), QB9 (the out-of-date indicator and the no-op
push), QB4 (the operation a push performs).
"""
import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

import services.accounting.purchase_order as pom  # noqa: E402

pytestmark = pytest.mark.unit


def _header(**over):
    base = {
        "id": "po-1",
        "company_id": "co-1",
        "po_number": "PO-1042",
        "revision": 2,
        "sent_revision": 2,
        "vendor_id": "ven-1",
        "vendor_name": "Acme Anodizing",
        "vendor_address": {"address_line1": "1 Plating Way", "city": "Dayton",
                           "state": "OH", "postal_code": "45402", "country": "US"},
        "ordered_on": "2026-11-09",
        "need_by_on": "2026-11-20",
        "payment_terms": "Net 30",
        "ship_via": "UPS Ground",
        "notes_to_vendor": "Certs with the shipment, please.",
        "internal_notes": "Bryce says they are slow in December.",
        "terms_and_conditions": "Standard terms apply.",
        "ship_to_kind": "shop",
        "ship_to_name": "L&L Machine",
        "ship_to_address": {"address_line1": "200 Shop Rd", "city": "Akron",
                            "state": "OH", "postal_code": "44301", "country": "US"},
        "content_version": 7,
        "deleted_at": None,
        "issued_at": "2026-11-09T15:00:00+00:00",
    }
    base.update(over)
    return base


def _line(**over):
    base = {
        "id": "line-1",
        "line_number": 1,
        "line_kind": "part",
        "part_id": "part-1",
        "part_name": "BRKT-100",
        "description": "6061-T6 1.0in bar",
        "vendor_part_number": "88-120",
        "quantity": 3,
        "unit": "bar",
        "stock_unit": "inches",
        "stock_factor": 144,
        "unit_price": 41.5,
        "price_source": "price_sheet",
        "need_by_on": "2026-11-20",
        "promised_on": "2026-11-18",
        "cert_required": True,
        "expects_receipt": True,
        "job_number": "J-0141",
        "closed_at": None,
    }
    base.update(over)
    return base


def _po(header=None, lines=None, status="sent"):
    return pom.projection_from_rows(
        header or _header(), lines if lines is not None else [_line()], status=status
    )


# ───────────────────────── the projection ─────────────────────────
def test_projection_orders_lines_by_line_number_not_by_row_order():
    """QuickBooks line ids are mapped back to Jigged lines BY POSITION, so the
    send order must be a property of the PO, never of how the rows arrived."""
    po = _po(lines=[_line(id="b", line_number=2), _line(id="a", line_number=1)])
    assert [ln.line_id for ln in po.lines] == ["a", "b"]


def test_projection_reads_numbers_exactly():
    po = _po(lines=[_line(quantity=2.5, unit_price=0.12345, stock_factor=100)])
    ln = po.lines[0]
    assert ln.quantity == Decimal("2.5")
    assert ln.unit_price == Decimal("0.12345")
    assert ln.stock_factor == Decimal("100")


def test_a_null_price_stays_null():
    """NULL means "price to be confirmed" (plan §3.5). It must not become 0."""
    assert _po(lines=[_line(unit_price=None)]).lines[0].unit_price is None


def test_closed_comes_from_the_status_view_not_from_closed_at_alone():
    """§3.4: closed is "explicitly closed, OR nothing outstanding and a line closed
    short" -- only the view knows the second half, so the push follows the view."""
    assert _po(status="closed").closed is True
    assert _po(header=_header(closed_at="2026-11-10T00:00:00Z"), status="sent").closed is False


def test_archived_is_read_from_deleted_at():
    assert _po(header=_header(deleted_at="2026-11-10T00:00:00Z")).archived is True
    assert _po().archived is False


# ───────────────────────── the hash (QB9) ─────────────────────────
def test_hash_is_stable_under_key_order():
    """QB9: the hash is of Jigged's projection, so two reads of the same rows --
    PostgREST does not promise key order -- must hash the same."""
    header = _header()
    reordered = dict(reversed(list(header.items())))
    line = _line()
    reordered_line = dict(reversed(list(line.items())))
    assert pom.payload_hash(_po(header, [line])) == pom.payload_hash(_po(reordered, [reordered_line]))


@pytest.mark.parametrize(
    "field, value",
    [
        ("internal_notes", "a different internal note"),
        ("terms_and_conditions", "New terms."),
        ("vendor_name", "Acme Anodizing (renamed)"),
        ("vendor_address", {"address_line1": "2 Elsewhere"}),
        ("content_version", 99),
        ("issued_at", "2026-12-01T00:00:00Z"),
    ],
)
def test_hash_ignores_header_fields_quickbooks_never_receives(field, value):
    """QB9: the out-of-date indicator must not light up for something that would
    change nothing in QuickBooks. Internal notes in particular never reach it."""
    assert pom.payload_hash(_po(_header(**{field: value}))) == pom.payload_hash(_po())


@pytest.mark.parametrize(
    "field, value",
    [
        ("promised_on", "2026-12-01"),
        ("need_by_on", "2026-12-01"),
        ("price_source", "manual"),
        ("cert_required", False),
        ("expects_receipt", False),
        ("received_quantity", 3),
        ("received_stock_quantity", 432),
    ],
)
def test_hash_ignores_line_fields_quickbooks_never_receives(field, value):
    """QB9: receipts and promised dates are Jigged-only. A receipt landing must
    never make the PO read "out of date in QuickBooks"."""
    assert pom.payload_hash(_po(lines=[_line(**{field: value})])) == pom.payload_hash(_po())


@pytest.mark.parametrize(
    "field, value",
    [
        ("po_number", "PO-1043"),
        ("revision", 3),
        ("ordered_on", "2026-11-10"),
        ("need_by_on", "2026-12-01"),
        ("payment_terms", "Net 45"),
        ("ship_via", "FedEx"),
        ("notes_to_vendor", "Different notes."),
        ("ship_to_name", "Another Dock"),
        ("ship_to_address", {"address_line1": "9 New St", "city": "Akron"}),
    ],
)
def test_hash_changes_with_every_pushed_header_field(field, value):
    assert pom.payload_hash(_po(_header(**{field: value}))) != pom.payload_hash(_po())


@pytest.mark.parametrize(
    "field, value",
    [
        ("quantity", 4),
        ("unit_price", 41.75),
        ("unit", "feet"),
        ("stock_factor", 12),
        ("description", "6061-T6 1.25in bar"),
        ("vendor_part_number", "88-121"),
        ("job_number", "J-0142"),
        ("closed_at", "2026-11-12T00:00:00Z"),
    ],
)
def test_hash_changes_with_every_pushed_line_field(field, value):
    assert pom.payload_hash(_po(lines=[_line(**{field: value})])) != pom.payload_hash(_po())


def test_hash_changes_when_a_line_is_added_or_removed():
    two = _po(lines=[_line(), _line(id="line-2", line_number=2)])
    assert pom.payload_hash(two) != pom.payload_hash(_po())


def test_hash_can_be_taken_as_quickbooks_holds_it():
    """The stored hash is of what QuickBooks HOLDS. Taking it with QuickBooks'
    closed state is how a close is told apart from a content change."""
    closed = _po(status="closed")
    assert pom.payload_hash(closed, closed=False) == pom.payload_hash(_po())
    assert pom.payload_hash(closed) != pom.payload_hash(_po())


# ───────────────────────── the operation (QB4, QB9) ─────────────────────────
def _link(po, **over):
    base = {
        "qb_po_id": "QB-77",
        "qb_closed": False,
        "pushed_payload_hash": pom.payload_hash(po),
    }
    base.update(over)
    return base


def test_no_link_or_no_qb_id_means_create():
    po = _po()
    assert pom.operation_for(po, None) == "create"
    assert pom.operation_for(po, {"qb_po_id": None}) == "create"


def test_an_unchanged_po_needs_nothing():
    """QB4: "a push with no changes makes zero provider calls" -- the decision is
    made here, from the database alone."""
    po = _po()
    assert pom.operation_for(po, _link(po)) == "none"


def test_a_content_change_is_an_update():
    po = _po()
    edited = _po(lines=[_line(quantity=5)])
    assert pom.operation_for(edited, _link(po)) == "update"


def test_closing_in_jigged_is_a_close_and_reopening_is_a_reopen():
    po = _po()
    closed = _po(status="closed")
    assert pom.operation_for(closed, _link(po)) == "close"
    assert pom.operation_for(po, _link(po, qb_closed=True)) == "reopen"


def test_a_header_only_close_sends_no_content():
    """A close with nothing else changed must not resend the lines -- on QuickBooks
    Online that would rewrite lines the bookkeeper may already have billed."""
    po = _po()
    closed = _po(status="closed")
    assert pom.content_changed(closed, _link(po)) is False
    edited_and_closed = _po(lines=[_line(quantity=9)], status="closed")
    assert pom.content_changed(edited_and_closed, _link(po)) is True


def test_a_missing_stored_hash_is_never_mistaken_for_up_to_date():
    po = _po()
    assert pom.operation_for(po, _link(po, pushed_payload_hash=None)) == "update"


# ───────────────────────── push preconditions ─────────────────────────
def test_a_draft_is_refused_naming_mark_sent():
    refusal = pom.push_refusal(_po(_header(sent_revision=None, issued_at=None), status="draft"),
                               provider="qbo")
    assert refusal.code == "vendor_po_draft"
    assert "Mark it as sent" in refusal.message


def test_an_unsent_revision_is_refused_naming_the_vendor():
    """Plan §3.11: "Rev 2 hasn't gone to Acme — send it first"."""
    refusal = pom.push_refusal(_po(_header(revision=2, sent_revision=1)), provider="qbd")
    assert refusal.code == "vendor_po_unsent_revision"
    assert "Rev 2" in refusal.message and "Acme Anodizing" in refusal.message


def test_an_archived_po_is_refused_before_anything_else():
    refusal = pom.push_refusal(
        _po(_header(deleted_at="2026-11-10T00:00:00Z", sent_revision=None), status="draft"),
        provider="qbo",
    )
    assert refusal.code == "vendor_po_archived"


def test_an_unpriced_line_is_refused_naming_the_line():
    refusal = pom.push_refusal(
        _po(lines=[_line(), _line(id="line-2", line_number=2, unit_price=None)]), provider="qbo"
    )
    assert refusal.code == "vendor_po_line_unpriced"
    assert "Line 2" in refusal.message


def test_a_zero_price_is_a_price():
    """0 is allowed (a no-charge rework); only NULL means "to be confirmed"."""
    assert pom.push_refusal(_po(lines=[_line(unit_price=0)]), provider="qbo") is None


def test_desktop_po_number_of_11_characters_passes_and_12_is_refused():
    """QB6: QuickBooks Desktop's refNumber holds 11 characters. Refused before any
    call, never truncated -- a truncated number is a different PO's number."""
    assert pom.push_refusal(_po(_header(po_number="PO-12345678")), provider="qbd") is None
    refusal = pom.push_refusal(_po(_header(po_number="PO-123456789")), provider="qbd")
    assert refusal.code == "qbd_po_number_too_long"
    assert "12" in refusal.message
    # QuickBooks Online's DocNumber holds 21, so the same number is fine there.
    assert pom.push_refusal(_po(_header(po_number="PO-123456789")), provider="qbo") is None


def test_a_ready_po_has_no_refusal():
    assert pom.push_refusal(_po(), provider="qbo") is None
    assert pom.push_refusal(_po(), provider="qbd") is None


# ───────────────────────── vendor names (QB6) ─────────────────────────
@pytest.mark.parametrize("max_length", [41])
def test_desktop_vendor_name_of_41_passes_and_42_is_refused(max_length):
    assert pom.vendor_name_problem("A" * 41, max_length=max_length) is None
    problem = pom.vendor_name_problem("A" * 42, max_length=max_length)
    assert problem is not None and "41" in problem


@pytest.mark.parametrize(
    "name", ["Acme: Plating", "Acme\tPlating", "Acme\nPlating", "Acme\r\nPlating", "   "]
)
def test_colons_tabs_line_breaks_and_blanks_are_refused(name):
    """QuickBooks reads ':' as a sub-name separator; a tab or line break cannot be
    typed into its name field. Both providers refuse them."""
    assert pom.vendor_name_problem(name, max_length=500) is not None
    assert pom.vendor_name_problem(name, max_length=41) is not None


def test_a_refused_name_is_never_truncated_to_fit():
    """QB6: two vendors can share their first 41 characters, and a truncated name
    would link the PO to the wrong one. The rule REFUSES; it has no fixed-up
    version to offer."""
    long_name = "Precision Anodizing and Plating Services of Ohio"
    problem = pom.vendor_name_problem(long_name, max_length=41)
    assert problem is not None
    assert long_name[:41] not in problem


# ───────────────────────── money and units ─────────────────────────
def test_line_amount_rounds_half_away_from_zero_like_sql():
    """SQL's round(numeric, 2) rounds half away from zero; Python's round() on a
    float does neither reliably. 1.5 x 0.01 = 0.015 must be 0.02."""
    assert pom.line_amount(Decimal("1.5"), Decimal("0.01")) == Decimal("0.02")
    assert pom.line_amount(3, Decimal("41.5")) == Decimal("124.50")


def test_rate_is_a_five_decimal_string():
    assert pom.rate_string(Decimal("12.5")) == "12.50000"
    assert pom.rate_string(Decimal("0.12345")) == "0.12345"


def test_unit_label_names_the_factor_when_the_purchase_unit_differs():
    """"A price per 100 prints as Unit: hundred (= 100 each)"."""
    po = _po(lines=[_line(unit="hundred", stock_unit="each", stock_factor=100)])
    assert pom.unit_label(po.lines[0]) == "hundred (= 100 each)"
    same = _po(lines=[_line(unit="each", stock_unit="each", stock_factor=1)])
    assert pom.unit_label(same.lines[0]) == "each"
