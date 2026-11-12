"""Vendor purchase orders: create, edit, send, close, archive and the derived status (plan §3.2–§3.5).

WHAT THIS GUARDS. "PO" already means the customer's PO in Jigged, so this is the vendor's
document: a frozen copy of who it went to and what it said, with the commercial terms of each
line, and a status nobody stores. Each rule below is one a careless writer breaks silently:

  * **The document is frozen.** Vendor, contact, address, ship-to and terms and conditions are
    snapshots; editing the address book afterwards must not rewrite paper the vendor holds (P1).
  * **Line kinds are enforced twice**, by the RPC as a sentence and by CHECKs as a backstop for
    every other writer (P2). The factor between the purchase unit and the stock unit is frozen
    on the line and there is one factor per (part, unit) — a bar that is 144 in on one line and
    120 in on the next is how stock silently drifts (L1).
  * **The revision bumps once per send cycle**, on the md5 of what the vendor sees. Drafts never
    bump; internal notes, promised dates and closing never bump (P3). `content_version` is the
    separate counter of what QuickBooks holds, and it moves exactly when one of those fields
    does, including close and reopen -- and "closed" is the derived status the push acts on, so
    the delivery that leaves nothing outstanding beside a line closed short moves it too (QB9).
  * **Edit guards** keep a PO consistent with what already happened: an existing line's kind
    and routing step, received quantities, the vendor once sent, closed and archived POs, and
    stale saves (P4). Archive is never blocked and lets go of its outside slips (P5).
  * **Status is computed once, in the views** (P6), and "late" and "amount" are one SQL
    definition each, pinned to the TypeScript mirrors by shared golden fixtures (P7).

Run:
    cd api && pytest -m integration tests/integration/test_vendor_purchase_orders.py
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Callable

import pytest
from psycopg2 import errors

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, shop  # noqa: F401

pytestmark = pytest.mark.integration

_FIXTURES = Path(__file__).resolve().parents[3] / "__tests__" / "fixtures"
LATE_CASES = _FIXTURES / "vendorPoLateCases.json"
AMOUNT_CASES = _FIXTURES / "vendorPoAmountCases.json"
VISIBLE_FIELDS = _FIXTURES / "vendorPoVisibleFields.json"


def _refuse_create(shop: ps.Shop, lines, *, vendor: str | None = None, header: dict | None = None):
    return ps.refuse(shop.admin, "create_vendor_purchase_order",
                     **ps.create_args(vendor or shop.v1, lines, header=header))


def _refuse_save(db, user: str, po_id: str, *, stale: str | None = None, **kw):
    expected = stale if stale is not None else ps.updated_at_text(db, po_id)
    return ps.refuse(user, "save_vendor_purchase_order", **ps.save_args(po_id, expected=expected, **kw))


# ── A sent PO: the starting point for the revision, edit-guard and content-version tests ──────


@dataclass
class SentPo:
    shop: ps.Shop
    po: ps.Po
    bar_line: str      # 10 ft of BAR at $24.00/ft
    screw_line: str    # 2.5 hundred SCREWs at $12.00/hundred
    machine_line: str  # a spindle rebuild on the Haas, done on site: an Other line expecting no receipt


SENT_HEADER = {
    "need_by_on": "2026-12-01",
    "payment_terms": "Net 30",
    "ship_via": "UPS Ground",
    "notes_to_vendor": "Call before delivery",
    "internal_notes": "Quoted by phone",
}


@pytest.fixture
def sent(db, shop) -> SentPo:
    po = ps.make_po(db, shop, [
        ps.part_line(shop.bar, 10, "feet", unit_price=24, price_source="price_sheet",
                     description="4140 bar, 1in round", vendor_part_number="AT-4140-1",
                     need_by_on="2026-12-01"),
        ps.part_line(shop.screw, 2.5, "hundred", unit_price=12, description="M5x16 SHCS"),
        # No receipt, so closing the two part lines still leaves nothing outstanding (P6).
        ps.other_line("Spindle rebuild, on site", unit_price=1800, work_center_id=shop.work_center,
                      expects_receipt=False),
    ], header=dict(SENT_HEADER), sent=True)
    return SentPo(shop=shop, po=po, bar_line=po.lines[0], screw_line=po.lines[1], machine_line=po.lines[2])


def _save(db, ctx: SentPo, patch: dict, user: str | None = None):
    """A vendor-visible save, carrying the `updated_at` the form loaded."""
    return ps.save_po(user or ctx.shop.user, ctx.po.id, expected=ps.updated_at_text(db, ctx.po.id), **patch)


# ── P1: the document is frozen ─────────────────────────────────────────────────────────────────


def test_create_derives_the_company_and_freezes_vendor_contact_address_and_shop_ship_to(db, shop):
    """[P1] The company comes from the vendor; the contact defaults to SALES (not the primary
    contact), the address to the vendor's default, the ship-to to the shop's own address."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")])
    row = ps.po_row(db, po.id)
    assert row["company_id"] == shop.company
    assert row["vendor_id"] == shop.v1 and row["vendor_name"] == shop.v1_name
    assert row["vendor_contact_id"] == shop.v1_sales
    assert row["vendor_contact"]["name"] == "Sally Sales"
    assert row["vendor_address_id"] == shop.v1_address
    assert row["vendor_address"]["city"] == "Gary"
    assert row["ship_to_kind"] == "shop"
    assert row["ship_to_name"] == shop.name
    assert row["ship_to_address"]["city"] == "Detroit"
    assert row["ordered_on"] == ps.TODAY
    assert row["created_by"] == shop.admin
    assert row["revision"] == 0 and row["sent_revision"] is None and row["issued_at"] is None


def test_with_no_sales_contact_the_primary_contact_is_the_default(db, shop):
    """[P1] Sales first, then primary: V2 has only a primary receiving contact."""
    po = ps.make_po(db, shop, [ps.other_line()], vendor=shop.v2)
    assert ps.po_row(db, po.id)["vendor_contact_id"] == shop.v2_contact


def test_an_archived_vendor_is_refused(db, shop):
    """[P1] A create derives the company from a LIVE vendor."""
    ps.execute(db, "UPDATE vendors SET deleted_at = now() WHERE id = %s", (shop.v2,))
    ps.assert_sentence_refusal(_refuse_create(shop, [ps.other_line()], vendor=shop.v2))
    assert ps.count(db, "vendor_purchase_orders", shop.company) == 0


@pytest.mark.parametrize("kind", ["shop", "vendor", "customer"])
def test_each_ship_to_kind_freezes_its_party(db, shop, kind):
    """[P1] Our shop, another vendor (drop-ship to the plater) or a customer (drop-ship)."""
    ids = {"shop": {}, "vendor": {"vendor_id": shop.v2, "vendor_address_id": shop.v2_address},
           "customer": {"customer_id": shop.customer, "customer_address_id": shop.customer_address}}[kind]
    po = ps.make_po(db, shop, [ps.other_line()], header=ps.ship_to(kind, **ids))

    name, city = {"shop": (shop.name, "Detroit"), "vendor": (shop.v2_name, "Warren"),
                  "customer": (shop.customer_name, "Toledo")}[kind]
    row = ps.po_row(db, po.id)
    assert (row["ship_to_kind"], row["ship_to_name"], row["ship_to_address"]["city"]) == (kind, name, city)


@pytest.mark.parametrize(
    "header",
    [
        pytest.param(lambda s: ps.ship_to("shop", customer_id=s.customer), id="shop-with-a-customer"),
        pytest.param(lambda s: ps.ship_to("vendor", vendor_id=s.v2, customer_id=s.customer), id="vendor-with-a-customer"),
        pytest.param(lambda s: ps.ship_to("customer", customer_id=s.customer, customer_address_id=s.customer_address,
                                          vendor_address_id=s.v2_address), id="customer-with-a-vendor-address"),
        pytest.param(lambda s: ps.ship_to("vendor", vendor_id=s.v2, vendor_address_id=s.v1_address),
                     id="another-vendors-address"),
        pytest.param(lambda s: ps.ship_to("customer", customer_id=s.customer, customer_address_id=s.v2_address),
                     id="a-vendor-address-as-the-customers"),
        pytest.param(lambda s: {"vendor_contact_id": s.v2_contact}, id="a-contact-of-another-vendor"),
        pytest.param(lambda s: {"vendor_address_id": s.v2_address}, id="an-address-of-another-vendor"),
    ],
)
def test_a_party_id_on_the_wrong_side_or_of_another_party_is_refused(db, shop, header):
    """[P1] The ship-to ids must match its kind, and every address and contact must belong to
    the party it is printed under."""
    ps.assert_sentence_refusal(_refuse_create(shop, [ps.other_line()], header=header(shop)))
    assert ps.count(db, "vendor_purchase_orders", shop.company) == 0


def test_the_copy_ignores_later_edits_to_vendor_contact_address_and_customer(db, shop):
    """[P1] The Document Snapshot Standard: the vendor holds this paper as it was printed."""
    po = ps.make_po(db, shop, [ps.other_line()], header=ps.ship_to(
        "customer", customer_id=shop.customer, customer_address_id=shop.customer_address))
    frozen = ps.po_row(db, po.id)

    ps.execute(db, "UPDATE vendors SET name = 'Atlas Renamed' WHERE id = %s", (shop.v1,))
    ps.execute(db, "UPDATE vendor_contacts SET name = 'Sally Renamed' WHERE id = %s", (shop.v1_sales,))
    ps.execute(db, "UPDATE vendor_addresses SET city = 'Elsewhere' WHERE id = %s", (shop.v1_address,))
    ps.execute(db, "UPDATE customers SET name = 'Northwind Renamed' WHERE id = %s", (shop.customer,))
    ps.execute(db, "UPDATE customer_addresses SET city = 'Elsewhere' WHERE id = %s", (shop.customer_address,))

    after = ps.po_row(db, po.id)
    for column in ("vendor_name", "vendor_contact", "vendor_address", "ship_to_name", "ship_to_address"):
        assert after[column] == frozen[column], f"{column} followed a live edit"


def test_an_other_line_freezes_its_machine_and_its_job(db, shop):
    """[P1] A spindle rebuild is bought against a machine: its name is frozen on the line."""
    po = ps.make_po(db, shop, [ps.other_line("Spindle rebuild", unit_price=1800,
                                             work_center_id=shop.work_center, job_id=shop.job)])
    line = ps.lines_of(db, po.id)[0]
    assert line["work_center_id"] == shop.work_center
    assert line["work_center_name"] == shop.work_center_name
    assert line["job_number"] == shop.job_number

    ps.execute(db, "UPDATE work_centers SET name = 'Haas renamed' WHERE id = %s", (shop.work_center,))
    assert ps.lines_of(db, po.id)[0]["work_center_name"] == shop.work_center_name


def test_vendors_carry_standing_payment_terms_like_customers(db, shop):
    """[P1] `vendors.default_payment_terms` mirrors `customers.default_payment_terms`, and the
    browser writes it directly as the vendor page's terms card does."""
    ps.sql_as(shop.user, "UPDATE vendors SET default_payment_terms = 'Net 45' WHERE id = %s", (shop.v1,))
    assert ps.scalar(db, "SELECT default_payment_terms FROM vendors WHERE id = %s", (shop.v1,)) == "Net 45"


# ── P2 / L4: line kinds, references and the approved vendor list ───────────────────────────────


LINE_SHAPES = [
    pytest.param(lambda s: {"line_kind": "part", "quantity": 1, "unit": "each", "unit_price": 1,
                            "price_source": "manual", "description": "no part"}, id="part-line-without-a-part"),
    pytest.param(lambda s: ps.part_line(s.bar, 1, "feet", job_operation_id=s.outside_op), id="part-line-on-an-operation"),
    pytest.param(lambda s: {"line_kind": "outside_service", "quantity": 1, "unit": "each", "unit_price": 1,
                            "price_source": "manual", "description": "no operation"}, id="outside-line-without-an-operation"),
    pytest.param(lambda s: ps.outside_line(s.station_op, 100), id="outside-line-on-an-in-house-operation"),
    pytest.param(lambda s: ps.outside_line(s.outside_op, 100, work_center_id=s.work_center), id="outside-line-on-a-machine"),
    pytest.param(lambda s: ps.outside_line(s.outside_op, 100, promised_on="2026-12-01"), id="outside-line-with-its-own-promise"),
    pytest.param(lambda s: ps.other_line("Bar", part_id=s.bar), id="other-line-with-a-part"),
    pytest.param(lambda s: ps.other_line("Op", job_operation_id=s.outside_op), id="other-line-on-an-operation"),
    pytest.param(lambda s: ps.part_line(s.bar, 1, "feet", expects_receipt=False), id="part-line-expecting-no-receipt"),
    pytest.param(lambda s: ps.outside_line(s.outside_op, 100, expects_receipt=False), id="outside-line-expecting-no-receipt"),
    pytest.param(lambda s: ps.part_line(s.bar, 0, "feet"), id="zero-quantity"),
    pytest.param(lambda s: ps.other_line("Fee", unit_price=-1), id="negative-price"),
]


@pytest.mark.parametrize("make_line", LINE_SHAPES)
def test_each_line_kind_refuses_a_shape_it_cannot_hold(db, shop, make_line):
    """[P2] The RPC names the problem as a sentence before any CHECK can fire."""
    ps.assert_sentence_refusal(_refuse_create(shop, [make_line(shop)]))
    assert ps.count(db, "vendor_purchase_orders", shop.company) == 0


@pytest.mark.parametrize(
    "statement",
    [
        pytest.param("UPDATE vendor_purchase_order_lines SET part_id = NULL WHERE id = %(part)s", id="part-line-loses-its-part"),
        pytest.param("UPDATE vendor_purchase_order_lines SET part_id = %(bar)s WHERE id = %(other)s", id="other-line-gains-a-part"),
        pytest.param("UPDATE vendor_purchase_order_lines SET expects_receipt = false WHERE id = %(part)s",
                     id="part-line-stops-expecting-a-receipt"),
        pytest.param("UPDATE vendor_purchase_order_lines SET job_operation_id = NULL WHERE id = %(outside)s",
                     id="outside-line-loses-its-operation"),
        pytest.param("UPDATE vendor_purchase_order_lines SET quantity = 0 WHERE id = %(part)s", id="zero-quantity"),
    ],
)
def test_the_line_checks_hold_for_every_writer_not_just_the_rpc(db, shop, statement):
    """[P2] The CHECKs are the backstop for the service role, a repair script, the next RPC."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet"), ps.other_line(), ps.outside_line(shop.outside_op, 100)])
    with pytest.raises(errors.CheckViolation):
        ps.execute(db, statement, {"part": po.lines[0], "other": po.lines[1], "outside": po.lines[2], "bar": shop.bar})


def test_an_outside_line_for_another_vendors_operation_is_refused(db, shop):
    """[P2] The anodize step is V1's; a V2 purchase order cannot carry it."""
    ps.assert_sentence_refusal(_refuse_create(shop, [ps.outside_line(shop.outside_op, 100)], vendor=shop.v2))


@pytest.mark.parametrize(
    "archive, make_line",
    [
        pytest.param("UPDATE parts SET deleted_at = now() WHERE id = %(bar)s",
                     lambda s: ps.part_line(s.bar, 1, "feet"), id="an-archived-part"),
        pytest.param("UPDATE jobs SET deleted_at = now() WHERE id = %(job)s",
                     lambda s: ps.outside_line(s.outside_op, 100), id="an-operation-on-an-archived-job"),
        pytest.param("UPDATE jobs SET deleted_at = now() WHERE id = %(job)s",
                     lambda s: ps.part_line(s.bar, 1, "feet", job_id=s.job), id="material-for-an-archived-job"),
        pytest.param("UPDATE work_centers SET deleted_at = now() WHERE id = %(wc)s",
                     lambda s: ps.other_line("Rebuild", work_center_id=s.work_center), id="an-archived-machine"),
    ],
)
def test_archived_references_are_refused_on_a_line(db, shop, archive, make_line):
    """[P2] Archived part, job or operation references are refused."""
    ps.execute(db, archive, {"bar": shop.bar, "job": shop.job, "wc": shop.work_center})
    ps.assert_sentence_refusal(_refuse_create(shop, [make_line(shop)]))


def test_a_do_not_use_vendor_is_blocked_and_a_conditional_one_is_not(db, shop):
    """[P2, L4] Do not use blocks, in the RPC as well as the UI; Conditional is an amber
    caption, not a block; a vendor not on the list at all is a quiet caption."""
    ps.save_avl(shop.admin, shop.bar, shop.v2, {"status": "disapproved", "purchase_unit": "feet",
                                                "status_note": "Failed the cert audit"})
    ps.save_avl(shop.admin, shop.screw, shop.v2, {"status": "conditional", "purchase_unit": "hundred"})

    ps.assert_sentence_refusal(_refuse_create(shop, [ps.part_line(shop.bar, 10, "feet")], vendor=shop.v2))

    po = ps.make_po(db, shop, [ps.part_line(shop.screw, 1, "hundred")], vendor=shop.v2)
    ps.make_po(db, shop, [ps.part_line(shop.widget, 5, "each")], vendor=shop.v2)  # not on its list

    # Adding the Do-not-use part to an existing PO is blocked the same way.
    err = _refuse_save(db, shop.user, po.id, lines=[ps.part_line(shop.bar, 2, "feet")])
    ps.assert_sentence_refusal(err)
    assert len(ps.lines_of(db, po.id)) == 1


def test_a_made_part_can_be_bought_whole_on_a_part_line(db, shop):
    """[P2] A subcontracted whole part is a real case: part lines take any live part."""
    po = ps.make_po(db, shop, [ps.part_line(shop.widget, 40, "each", description="Subcontracted widget")])
    line = ps.lines_of(db, po.id)[0]
    assert line["part_id"] == shop.widget and line["part_name"] == shop.widget_name
    assert Decimal(line["stock_factor"]) == 1


# ── L1: units ──────────────────────────────────────────────────────────────────────────────────


def test_a_feet_line_freezes_factor_12_against_the_inch_stock_unit(db, shop):
    """[L1] The factor comes from parts_unit_conversions and is frozen on the line."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")])
    line = ps.lines_of(db, po.id)[0]
    assert (line["unit"], line["stock_unit"], Decimal(line["stock_factor"])) == ("feet", "inches", 12)


def test_a_unit_with_no_conversion_is_refused(db, shop):
    """[L1] `convertToBaseUnit` would have used 1; the RPC refuses instead."""
    ps.assert_sentence_refusal(_refuse_create(shop, [ps.part_line(shop.bar, 3, "bars")]))


def test_one_unit_name_cannot_carry_two_factors(db, shop):
    """[L1] One factor per (part, unit): a second `feet` row for BAR is a unique violation."""
    with pytest.raises(errors.UniqueViolation):
        ps.execute(db, "INSERT INTO parts_unit_conversions (part_id, from_unit, to_primary_factor) VALUES (%s, 'feet', 10)",
                   (shop.bar,))


def test_ea_on_an_each_part_is_the_stock_unit_itself(db, shop):
    """[L1] The alias `ea` is `each` in SQL as in TypeScript: factor 1, never "no conversion"."""
    po = ps.make_po(db, shop, [ps.part_line(shop.screw, 250, "ea")])
    line = ps.lines_of(db, po.id)[0]
    assert line["stock_unit"] == "each" and Decimal(line["stock_factor"]) == 1


def test_a_later_conversion_edit_never_reaches_an_existing_line(db, shop):
    """[L1] The vendor quoted 10 ft as 120 in; re-defining `feet` does not re-write that."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")])
    ps.execute(db, "UPDATE parts_unit_conversions SET to_primary_factor = 10 WHERE part_id = %s AND from_unit = 'feet'",
               (shop.bar,))
    assert Decimal(ps.lines_of(db, po.id)[0]["stock_factor"]) == 12
    later = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")])
    assert Decimal(ps.lines_of(db, later.id)[0]["stock_factor"]) == 10


# ── L2: price source and "to be confirmed" ────────────────────────────────────────────────────


@pytest.mark.parametrize("source", ["price_sheet", "last_po", "estimate", "vendor_service", "rfq", "manual"])
def test_the_price_source_is_stored_as_sent(db, shop, source):
    """[L2] `price_source` is persisted so the line keeps saying where its price came from."""
    line = (ps.outside_line(shop.outside_op, 100, price_source=source) if source == "vendor_service"
            else ps.part_line(shop.bar, 10, "feet", unit_price=20, price_source=source))
    po = ps.make_po(db, shop, [line])
    assert ps.lines_of(db, po.id)[0]["price_source"] == source


def test_an_unknown_price_source_is_refused(db, shop):
    """[L2] The six sources are the whole list."""
    ps.assert_sentence_refusal(_refuse_create(shop, [ps.part_line(shop.bar, 10, "feet", price_source="guess")]))


def test_a_line_with_no_price_is_to_be_confirmed(db, shop):
    """[L2] NULL means "price to be confirmed": no amount, flagged on the PO, never zero."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet", unit_price=None, price_source=None),
                               ps.part_line(shop.screw, 1, "hundred", unit_price=12)])
    assert ps.lines_of(db, po.id)[0]["unit_price"] is None
    status = ps.po_status(db, po.id)
    assert status["has_unpriced_lines"] is True
    assert status["ordered_amount"] == Decimal("12.00"), "a to-be-confirmed line was counted as money"
    assert ps.scalar(db, "SELECT public.vendor_po_line_amount(10::numeric, NULL::numeric)") is None


# ── P3: revisions ──────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Recipe:
    scope: str                              # "header" or "line"
    fields: tuple[str, ...]                 # the vendor-visible / internal fields it changes
    build: Callable[[SentPo], dict]         # → save_po(**patch)


VISIBLE_RECIPES = {
    "notes_to_vendor": Recipe("header", ("notes_to_vendor",), lambda c: {"changes": {"notes_to_vendor": "Deliver to dock B"}}),
    "ship_via": Recipe("header", ("ship_via",), lambda c: {"changes": {"ship_via": "Will call"}}),
    "payment_terms": Recipe("header", ("payment_terms",), lambda c: {"changes": {"payment_terms": "Net 45"}}),
    "header_need_by_on": Recipe("header", ("need_by_on",), lambda c: {"changes": {"need_by_on": "2026-12-15"}}),
    "vendor_contact": Recipe("header", ("vendor_contact_id",),
                             lambda c: {"changes": {"vendor_contact_id": c.shop.v1_payables}}),
    "vendor_address": Recipe("header", ("vendor_address_id",),
                             lambda c: {"changes": {"vendor_address_id": c.shop.v1_remit}}),
    # The patch key is the `ship_to` object; the fields it changes on the document are the columns.
    "ship_to_customer": Recipe("header", ("ship_to_kind", "ship_to_customer_id", "ship_to_customer_address_id"),
                               lambda c: {"changes": ps.ship_to("customer", customer_id=c.shop.customer,
                                                                customer_address_id=c.shop.customer_address)}),
    "ship_to_vendor": Recipe("header", ("ship_to_kind", "ship_to_vendor_id", "ship_to_vendor_address_id"),
                             lambda c: {"changes": ps.ship_to("vendor", vendor_id=c.shop.v2,
                                                              vendor_address_id=c.shop.v2_address)}),
    "line_quantity": Recipe("line", ("quantity",), lambda c: {"lines": [{"id": c.bar_line, "quantity": 12}]}),
    "line_unit_price": Recipe("line", ("unit_price",), lambda c: {"lines": [{"id": c.bar_line, "unit_price": 22.5}]}),
    "line_description": Recipe("line", ("description",),
                               lambda c: {"lines": [{"id": c.bar_line, "description": "4140 bar, 1.25in round"}]}),
    "line_vendor_part_number": Recipe("line", ("vendor_part_number",),
                                      lambda c: {"lines": [{"id": c.bar_line, "vendor_part_number": "AT-4140-1.25"}]}),
    "line_unit": Recipe("line", ("unit", "quantity"),
                        lambda c: {"lines": [{"id": c.bar_line, "unit": "inches", "quantity": 120}]}),
    "line_need_by_on": Recipe("line", ("need_by_on",), lambda c: {"lines": [{"id": c.bar_line, "need_by_on": "2026-12-08"}]}),
    "line_cert_required": Recipe("line", ("cert_required",), lambda c: {"lines": [{"id": c.bar_line, "cert_required": True}]}),
    "line_part": Recipe("line", ("part_id", "unit", "quantity"),
                        lambda c: {"lines": [{"id": c.screw_line, "part_id": c.shop.widget, "unit": "each", "quantity": 250}]}),
    "line_job": Recipe("line", ("job_id",), lambda c: {"lines": [{"id": c.bar_line, "job_id": c.shop.job}]}),
    # The job part carries its job: the screws are now bought for the second job, whose number prints.
    "line_job_part": Recipe("line", ("job_part_id",),
                            lambda c: {"lines": [{"id": c.screw_line, "job_part_id": c.shop.screw_job_part}]}),
    "line_work_center": Recipe("line", ("work_center_id",),
                               lambda c: {"lines": [{"id": c.machine_line, "work_center_id": c.shop.work_center_2}]}),
    "line_added": Recipe("line", (), lambda c: {"lines": [ps.other_line("Freight", unit_price=45)]}),
    "line_removed": Recipe("line", (), lambda c: {"removed": [c.screw_line]}),
}

INTERNAL_RECIPES = {
    "internal_notes": Recipe("header", ("internal_notes",), lambda c: {"changes": {"internal_notes": "Chase on Tuesday"}}),
    "line_promised_on": Recipe("line", ("promised_on",), lambda c: {"lines": [{"id": c.bar_line, "promised_on": "2026-11-28"}]}),
}


def _another_visible_change(recipe: Recipe) -> dict:
    field = "notes_to_vendor" if "ship_via" in recipe.fields else "ship_via"
    return {"changes": {field: "A second change in the same cycle"}}


def test_the_parametrization_covers_the_whole_shared_field_list():
    """[P3] Every name in the shared vendor-visible list has a recipe below, and the internal
    list is exactly the internal recipes — so the list cannot grow without this file testing it."""
    def covered(recipes: dict, scope: str) -> set[str]:
        return {f for r in recipes.values() if r.scope == scope for f in r.fields}

    assert set(ps.VENDOR_VISIBLE_HEADER_FIELDS) <= covered(VISIBLE_RECIPES, "header")
    assert set(ps.VENDOR_VISIBLE_LINE_FIELDS) <= covered(VISIBLE_RECIPES, "line")
    assert covered(INTERNAL_RECIPES, "header") == set(ps.INTERNAL_HEADER_FIELDS)
    assert covered(INTERNAL_RECIPES, "line") == set(ps.INTERNAL_LINE_FIELDS)
    visible = set(ps.VENDOR_VISIBLE_HEADER_FIELDS) | set(ps.VENDOR_VISIBLE_LINE_FIELDS)
    assert not visible & (set(ps.INTERNAL_HEADER_FIELDS) | set(ps.INTERNAL_LINE_FIELDS))


def test_the_shared_field_list_is_the_fixture_the_po_form_reads():
    """[P3] ONE LIST: the four tuples these tests parametrize over are exactly the data in
    __tests__/fixtures/vendorPoVisibleFields.json, which the PO form's "Save as Rev N+1"
    prediction is pinned to; adding or removing a line has a recipe here; and the two fields a
    sent PO refuses are the two the edit-guard tests refuse."""
    assert VISIBLE_FIELDS.is_file(), f"{VISIBLE_FIELDS} is missing; the PO form and these tests both read it"
    shared = json.loads(VISIBLE_FIELDS.read_text(encoding="utf-8"))
    assert list(ps.VENDOR_VISIBLE_HEADER_FIELDS) == shared["vendor_visible_header_fields"]
    assert list(ps.VENDOR_VISIBLE_LINE_FIELDS) == shared["vendor_visible_line_fields"]
    assert list(ps.INTERNAL_HEADER_FIELDS) == shared["internal_header_fields"]
    assert list(ps.INTERNAL_LINE_FIELDS) == shared["internal_line_fields"]
    assert set(shared["line_set_changes"]) <= set(VISIBLE_RECIPES)
    assert set(shared["fixed_once_sent_fields"]) == {"vendor_id", "ordered_on"}


def test_a_draft_never_bumps_the_revision(db, shop):
    """[P3] Nothing has been sent, so there is nothing to revise."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")])
    for patch in ({"changes": {"notes_to_vendor": "Certs please"}},
                  {"lines": [{"id": po.lines[0], "quantity": 11}]},
                  {"lines": [ps.other_line("Freight")]}):
        ps.save_po(shop.user, po.id, expected=ps.updated_at_text(db, po.id), **patch)
    row = ps.po_row(db, po.id)
    assert row["revision"] == 0 and row["sent_revision"] is None
    assert ps.revisions_of(db, po.id) == []


def test_mark_sent_records_revision_zero_and_snapshots_the_document(db, shop):
    """[P3, P5] The first send stamps the issue and keeps exactly what was sent."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")], header={"notes_to_vendor": "Certs please"})
    ps.mark_sent(shop.user, po.id)
    row = ps.po_row(db, po.id)
    assert (row["revision"], row["sent_revision"]) == (0, 0)
    assert row["issued_at"] is not None and row["issued_by"] == shop.user and row["last_sent_at"] is not None
    (snapshot,) = ps.revisions_of(db, po.id)
    assert snapshot["revision"] == 0 and snapshot["sent_by"] == shop.user and snapshot["sent_at"] is not None
    assert "Certs please" in json.dumps(snapshot["document"]), "the snapshot is not the document the vendor saw"


def test_resending_an_unchanged_revision_keeps_one_snapshot_and_the_first_issue(db, sent):
    """[P3] A second Mark as sent re-stamps the send, not the issue, and writes no second copy."""
    first = ps.po_row(db, sent.po.id)
    ps.mark_sent(sent.shop.admin, sent.po.id)
    again = ps.po_row(db, sent.po.id)
    assert again["issued_at"] == first["issued_at"]
    assert again["last_sent_at"] >= first["last_sent_at"]
    assert [r["revision"] for r in ps.revisions_of(db, sent.po.id)] == [0]


@pytest.mark.parametrize("name", sorted(VISIBLE_RECIPES))
def test_each_vendor_visible_change_bumps_the_revision_once_per_send_cycle(db, sent, name):
    """[P3] Parametrized over the shared vendor-visible list: the first change after a send
    makes Rev 1, a second change in the same cycle does not make Rev 2, and the next send
    records Rev 1 — on the same PO number."""
    recipe = VISIBLE_RECIPES[name]
    _save(db, sent, recipe.build(sent))
    row = ps.po_row(db, sent.po.id)
    assert (row["revision"], row["sent_revision"]) == (1, 0)
    assert ps.po_status(db, sent.po.id)["has_unsent_changes"] is True

    _save(db, sent, _another_visible_change(recipe))
    assert ps.po_row(db, sent.po.id)["revision"] == 1, "a second change in one cycle bumped again"
    assert [r["revision"] for r in ps.revisions_of(db, sent.po.id)] == [0]

    ps.mark_sent(sent.shop.admin, sent.po.id)
    resent = ps.po_row(db, sent.po.id)
    assert (resent["revision"], resent["sent_revision"]) == (1, 1)
    assert [r["revision"] for r in ps.revisions_of(db, sent.po.id)] == [0, 1]
    assert ps.po_status(db, sent.po.id)["has_unsent_changes"] is False
    assert resent["po_number"] == sent.po.number


@pytest.mark.parametrize("name", sorted(INTERNAL_RECIPES))
def test_internal_notes_and_promised_dates_never_bump_the_revision(db, sent, name):
    """[P3] Parametrized over the internal list, sent the way the auto-saves send them: with no
    expected timestamp at all."""
    ps.save_po(sent.shop.user, sent.po.id, **INTERNAL_RECIPES[name].build(sent))
    row = ps.po_row(db, sent.po.id)
    assert (row["revision"], row["sent_revision"]) == (0, 0)
    assert ps.po_status(db, sent.po.id)["has_unsent_changes"] is False


@pytest.mark.parametrize("what", ["a-line", "the-po"])
def test_closing_never_bumps_the_revision(db, sent, what):
    """[P3] Closing changes what Jigged expects, not what the vendor was asked for."""
    if what == "a-line":
        ps.set_lines(sent.shop.user, sent.po.id, [sent.bar_line], "close", reason="Vendor is out of stock")
    else:
        ps.set_state(sent.shop.user, sent.po.id, "close", reason="Cancelled")
    assert ps.po_row(db, sent.po.id)["revision"] == 0


def test_saving_the_value_it_already_has_does_not_bump(db, sent):
    """[P3] The bump is on the md5 of the vendor-visible document, not on "Save was pressed"."""
    _save(db, sent, {"changes": {"notes_to_vendor": SENT_HEADER["notes_to_vendor"]}})
    assert ps.po_row(db, sent.po.id)["revision"] == 0


def test_the_next_send_cycle_bumps_again_to_rev_2(db, sent):
    """[P3] Once Rev 1 has gone, the next vendor-visible change makes Rev 2."""
    _save(db, sent, {"changes": {"ship_via": "Freight collect"}})
    ps.mark_sent(sent.shop.admin, sent.po.id)
    _save(db, sent, {"changes": {"ship_via": "Will call"}})
    row = ps.po_row(db, sent.po.id)
    assert (row["revision"], row["sent_revision"]) == (2, 1)


# ── P4: edit guards ─────────────────────────────────────────────────────────────────────────────


def _receive_bar(sent: SentPo, feet) -> None:
    ps.receive(sent.shop.admin, sent.po.id, [ps.entry(sent.bar_line, feet, location=sent.shop.shelf)])


def test_quantity_cannot_drop_below_what_was_received(db, sent):
    """[P4] 6 ft are on the shelf; the line cannot say 5 were ordered. 6 is fine."""
    _receive_bar(sent, 6)
    ps.assert_state_refusal(_refuse_save(db, sent.shop.user, sent.po.id, lines=[{"id": sent.bar_line, "quantity": 5}]))
    assert ps.line_row(db, sent.bar_line)["quantity"] == 10
    _save(db, sent, {"lines": [{"id": sent.bar_line, "quantity": 6}]})
    assert ps.line_row(db, sent.bar_line)["quantity"] == 6


def test_a_line_with_receipts_cannot_be_removed_and_numbers_are_never_reused(db, sent):
    """[P4] A received line is closed short, never deleted. An unreceived one can go, and the
    next new line does not take its printed number."""
    _receive_bar(sent, 2)
    ps.assert_state_refusal(_refuse_save(db, sent.shop.user, sent.po.id, removed=[sent.bar_line]))
    assert ps.line_row(db, sent.bar_line) is not None

    _save(db, sent, {"removed": [sent.screw_line]})
    assert ps.line_row(db, sent.screw_line) is None
    _save(db, sent, {"lines": [ps.other_line("Freight")]})
    assert [line["line_number"] for line in ps.lines_of(db, sent.po.id)] == [1, 3, 4]


@pytest.mark.parametrize(
    "patch",
    [
        pytest.param(lambda c: {"id": c.bar_line, "unit": "inches", "quantity": 120}, id="unit"),
        pytest.param(lambda c: {"id": c.bar_line, "part_id": c.shop.screw, "unit": "each"}, id="part"),
        pytest.param(lambda c: {"id": c.bar_line, "line_kind": "other", "part_id": None}, id="kind"),
    ],
)
def test_kind_part_and_unit_are_fixed_once_anything_is_received(db, sent, patch):
    """[P4] The receipts already in stock were converted with this part, unit and factor."""
    _receive_bar(sent, 3)
    before = ps.line_row(db, sent.bar_line)
    ps.assert_state_refusal(_refuse_save(db, sent.shop.user, sent.po.id, lines=[patch(sent)]))
    assert ps.line_row(db, sent.bar_line) == before


def _one_of_each_kind(db, shop: ps.Shop, *, sent: bool) -> ps.Po:
    """Lines 1-3: 10 ft of BAR, the job's anodize step, a spindle rebuild on the Haas."""
    return ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet"),
                                 ps.outside_line(shop.outside_op, 100),
                                 ps.other_line("Spindle rebuild", unit_price=1800, work_center_id=shop.work_center)],
                      sent=sent)


# (shop, po, another V1 anodize step) → the patch of one existing line.
FIXED_KIND_AND_STEP = [
    pytest.param(lambda s, po, step: {"id": po.lines[0], "line_kind": "other", "part_id": None}, id="part-to-other"),
    pytest.param(lambda s, po, step: {"id": po.lines[2], "line_kind": "part", "part_id": s.screw, "unit": "each",
                                      "work_center_id": None}, id="other-to-part"),
    pytest.param(lambda s, po, step: {"id": po.lines[1], "line_kind": "other"}, id="outside-to-other"),
    pytest.param(lambda s, po, step: {"id": po.lines[1], "job_operation_id": step}, id="outside-to-another-step"),
    pytest.param(lambda s, po, step: {"id": po.lines[1], "job_operation_id": None}, id="outside-drops-its-step"),
    pytest.param(lambda s, po, step: {"id": po.lines[0], "job_operation_id": step}, id="part-takes-a-step"),
]


@pytest.mark.parametrize("sent", [False, True], ids=["draft", "sent"])
@pytest.mark.parametrize("patch", FIXED_KIND_AND_STEP)
def test_an_existing_lines_kind_and_routing_step_never_change(db, shop, patch, sent):
    """[P2, P4] A line's kind decides what it prints and how it is received, and an outside
    line's step decides which slips follow it — so neither changes on an existing line, draft
    or sent, receipts or none. That is also why neither is on the shared vendor-visible list:
    only adding or removing a line moves them. Refused with a sentence; nothing written."""
    _, another_step = ps.add_outside_job_part(db, shop, shop.anodize)
    po = _one_of_each_kind(db, shop, sent=sent)
    before = ps.lines_of(db, po.id)
    err = _refuse_save(db, shop.user, po.id, lines=[patch(shop, po, another_step)])
    ps.assert_state_refusal(err, "kind", "routing step")
    assert ps.lines_of(db, po.id) == before


def test_repeating_a_lines_own_kind_and_step_is_not_a_change(db, shop):
    """[P4] The refusal is about a change: a client that sends a line's kind and step back with
    an edit (the whole line, say) is accepted."""
    po = _one_of_each_kind(db, shop, sent=True)
    ps.save_po(shop.user, po.id, expected=ps.updated_at_text(db, po.id), lines=[
        {"id": po.lines[0], "line_kind": "part", "job_operation_id": None, "quantity": 11},
        {"id": po.lines[1], "line_kind": "outside_service", "job_operation_id": shop.outside_op, "quantity": 90},
    ])
    assert [ps.line_row(db, line)["quantity"] for line in po.lines[:2]] == [11, 90]


def test_the_vendor_is_fixed_once_sent_but_a_draft_can_change_it(db, shop, sent):
    """[P4] To change vendors after sending, close it and duplicate it. A draft re-snapshots."""
    ps.assert_state_refusal(_refuse_save(db, shop.user, sent.po.id, changes={"vendor_id": shop.v2}))
    assert ps.po_row(db, sent.po.id)["vendor_id"] == shop.v1

    draft = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")])
    ps.save_po(shop.user, draft.id, changes={"vendor_id": shop.v2}, expected=ps.updated_at_text(db, draft.id))
    row = ps.po_row(db, draft.id)
    assert row["vendor_id"] == shop.v2 and row["vendor_name"] == shop.v2_name
    assert row["vendor_contact_id"] in (None, shop.v2_contact), "V1's contact survived a change to V2"


def test_the_order_date_moves_only_while_a_draft(db, shop, sent):
    """[P4] `ordered_on` is the browser's local date, editable while a draft (§3.2)."""
    draft = ps.make_po(db, shop, [ps.other_line()])
    ps.save_po(shop.user, draft.id, changes={"ordered_on": "2026-11-02"}, expected=ps.updated_at_text(db, draft.id))
    assert ps.po_row(db, draft.id)["ordered_on"] == date(2026, 11, 2)

    ps.assert_state_refusal(_refuse_save(db, shop.user, sent.po.id, changes={"ordered_on": "2026-11-02"}))


@pytest.mark.parametrize("how", ["close", "archive"])
def test_a_closed_or_archived_po_takes_only_internal_notes_and_promised_dates(db, sent, how):
    """[P4, P5] Read-only except the two fields that never reach the vendor."""
    user, po = sent.shop.user, sent.po.id
    ps.set_state(user, po, how)
    ps.assert_state_refusal(_refuse_save(db, user, po, changes={"notes_to_vendor": "Too late"}))
    ps.assert_state_refusal(_refuse_save(db, user, po, lines=[{"id": sent.bar_line, "quantity": 11}]))

    ps.save_po(user, po, changes={"internal_notes": "Vendor called back"})
    ps.save_po(user, po, lines=[{"id": sent.bar_line, "promised_on": "2026-11-30"}])
    assert ps.po_row(db, po)["internal_notes"] == "Vendor called back"
    assert ps.line_row(db, sent.bar_line)["promised_on"] == date(2026, 11, 30)


def test_a_stale_vendor_visible_save_is_refused_but_promises_and_notes_never_are(db, sent):
    """[P4] Another tab saved first: a vendor-visible save carrying the old `updated_at` is
    refused, while the promised-date and internal-note auto-saves are never stale."""
    stale = ps.updated_at_text(db, sent.po.id)
    ps.save_po(sent.shop.admin, sent.po.id, changes={"ship_via": "Freight collect"}, expected=stale)

    ps.assert_state_refusal(_refuse_save(db, sent.shop.user, sent.po.id, stale=stale,
                                         changes={"notes_to_vendor": "Mine"}))
    assert ps.po_row(db, sent.po.id)["notes_to_vendor"] == SENT_HEADER["notes_to_vendor"]

    ps.save_po(sent.shop.user, sent.po.id, lines=[{"id": sent.bar_line, "promised_on": "2026-11-27"}], expected=stale)
    ps.save_po(sent.shop.user, sent.po.id, changes={"internal_notes": "Called them"}, expected=stale)
    assert ps.line_row(db, sent.bar_line)["promised_on"] == date(2026, 11, 27)
    assert ps.po_row(db, sent.po.id)["internal_notes"] == "Called them"


# ── P5: lifecycle ──────────────────────────────────────────────────────────────────────────────


def test_mark_sent_needs_at_least_one_line(db, shop):
    """[P5] An empty purchase order is not a document anyone can act on."""
    po_id, _ = ps.create_po(shop.admin, shop.v1, [])
    err = ps.refuse(shop.admin, "set_vendor_purchase_order_state", p_id=po_id, p_action="mark_sent", p_today=ps.TODAY)
    ps.assert_state_refusal(err)
    assert ps.po_row(db, po_id)["issued_at"] is None


def test_a_draft_cannot_be_closed(db, shop):
    """[P5] Close needs a sent PO (Database architect design §1.5); a draft is archived."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")])
    err = ps.refuse(shop.admin, "set_vendor_purchase_order_state", p_id=po.id, p_action="close", p_today=ps.TODAY)
    ps.assert_state_refusal(err)


def test_closing_and_reopening_the_whole_po(db, sent):
    """[P5] Close stamps who and why; reopen clears it and the PO reads Sent again."""
    ps.set_state(sent.shop.user, sent.po.id, "close", reason="Vendor discontinued the bar")
    row = ps.po_row(db, sent.po.id)
    assert row["closed_at"] is not None and row["closed_by"] == sent.shop.user
    assert row["closed_reason"] == "Vendor discontinued the bar"
    assert ps.po_status(db, sent.po.id)["status"] == ps.CLOSED

    ps.set_state(sent.shop.user, sent.po.id, "reopen")
    assert ps.po_row(db, sent.po.id)["closed_at"] is None
    assert ps.po_status(db, sent.po.id)["status"] == ps.SENT


def test_lines_close_and_reopen_in_one_batch(db, sent):
    """[P5] One call closes several lines atomically, and one call reopens them."""
    both = [sent.bar_line, sent.screw_line]
    ps.set_lines(sent.shop.user, sent.po.id, both, "close", reason="Cancelled by phone")
    for line in both:
        assert ps.line_row(db, line)["closed_at"] is not None
        assert ps.line_status(db, line)["status"] == ps.CLOSED
    assert ps.po_status(db, sent.po.id)["status"] == ps.CLOSED

    ps.set_lines(sent.shop.user, sent.po.id, both, "reopen")
    assert [ps.line_status(db, line)["status"] for line in both] == [ps.LINE_OPEN, ps.LINE_OPEN]
    assert ps.po_status(db, sent.po.id)["status"] == ps.SENT


def test_archive_is_never_blocked_and_lets_go_of_its_slips(db, shop):
    """[P5] Archive works on a PO with receipts and a linked slip, and unlinks the slip so a
    re-created PO can claim it."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet"), ps.outside_line(shop.outside_op, 100)], sent=True)
    slip, _ = ps.send_outside(shop.admin, shop.outside_op, 40)
    assert ps.slip_link(db, slip) == po.lines[1]
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 3, location=shop.shelf)])

    ps.set_state(shop.user, po.id, "archive")
    assert ps.po_row(db, po.id)["deleted_at"] is not None
    assert ps.slip_link(db, slip) is None, "an archived PO kept its outside slip"


# ── P6: the status matrix, through the views ──────────────────────────────────────────────────


def _bar_and_screw(db, shop, *, sent: bool = True, extra=()) -> ps.Po:
    return ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet"),
                                 ps.part_line(shop.screw, 1, "hundred"), *extra], sent=sent)


def _statuses(db, po: ps.Po) -> tuple[str, list[str]]:
    return ps.po_status(db, po.id)["status"], [ps.line_status(db, line)["status"] for line in po.lines]


def _take(shop, po: ps.Po, *entries) -> None:
    ps.receive(shop.admin, po.id, [ps.entry(line, qty, location=shop.shelf) for line, qty in entries])


def test_a_po_never_sent_is_draft_line_by_line(db, shop):
    """[P6] Draft is the first match."""
    po = _bar_and_screw(db, shop, sent=False)
    assert _statuses(db, po) == (ps.DRAFT, [ps.DRAFT, ps.DRAFT])


def test_a_sent_po_with_nothing_received_reads_sent_with_open_lines(db, shop):
    """[P6]"""
    po = _bar_and_screw(db, shop)
    assert _statuses(db, po) == (ps.SENT, [ps.LINE_OPEN, ps.LINE_OPEN])


def test_a_partial_receipt_reads_partly_received(db, shop):
    """[P6] Progress is in stock units: 4 ft of 10 is 48 in of 120."""
    po = _bar_and_screw(db, shop)
    _take(shop, po, (po.lines[0], 4))
    assert _statuses(db, po) == (ps.PARTLY_RECEIVED, [ps.PARTLY_RECEIVED, ps.LINE_OPEN])
    line = ps.line_status(db, po.lines[0])
    assert Decimal(line["received_stock_quantity"]) == 48


def test_receiving_every_line_reads_received(db, shop):
    """[P6]"""
    po = _bar_and_screw(db, shop)
    _take(shop, po, (po.lines[0], 10), (po.lines[1], 1))
    assert _statuses(db, po) == (ps.RECEIVED, [ps.RECEIVED, ps.RECEIVED])


def test_an_over_receipt_reads_received(db, shop):
    """[P6] Received ≥ ordered is received; the UI adds "Received +N"."""
    po = _bar_and_screw(db, shop)
    _take(shop, po, (po.lines[0], 12), (po.lines[1], 1))
    assert _statuses(db, po) == (ps.RECEIVED, [ps.RECEIVED, ps.RECEIVED])


def test_an_explicit_close_reads_closed(db, shop):
    """[P6]"""
    po = _bar_and_screw(db, shop)
    _take(shop, po, (po.lines[0], 4))
    ps.set_state(shop.admin, po.id, "close")
    assert _statuses(db, po) == (ps.CLOSED, [ps.CLOSED, ps.CLOSED])


def test_lines_closed_short_with_nothing_outstanding_read_closed(db, shop):
    """[P6] One line received, the other closed short: nothing outstanding, one closed → Closed."""
    po = _bar_and_screw(db, shop)
    _take(shop, po, (po.lines[0], 10))
    ps.set_lines(shop.admin, po.id, [po.lines[1]], "close")
    assert _statuses(db, po) == (ps.CLOSED, [ps.RECEIVED, ps.CLOSED])


def test_a_closed_line_beside_an_open_one_reads_partly_received(db, shop):
    """[P6] "Anything received or closed" — the open line still holds the PO open."""
    po = _bar_and_screw(db, shop)
    ps.set_lines(shop.admin, po.id, [po.lines[1]], "close")
    assert _statuses(db, po) == (ps.PARTLY_RECEIVED, [ps.LINE_OPEN, ps.CLOSED])


def test_a_line_that_expects_no_receipt_never_holds_the_po_open(db, shop):
    """[P6] Freight is paid, not received: once the bar arrives the PO is Received."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet"),
                               ps.other_line("Freight", expects_receipt=False)], sent=True)
    assert ps.line_status(db, po.lines[1])["status"] == ps.LINE_NO_RECEIPT
    _take(shop, po, (po.lines[0], 10))
    assert _statuses(db, po) == (ps.RECEIVED, [ps.RECEIVED, ps.LINE_NO_RECEIPT])


def test_a_po_of_only_no_receipt_lines_stays_sent_until_closed(db, shop):
    """[P6] It must not read Received the moment it is sent."""
    po = ps.make_po(db, shop, [ps.other_line("Freight", expects_receipt=False),
                               ps.other_line("Expedite fee", expects_receipt=False)], sent=True)
    assert ps.po_status(db, po.id)["status"] == ps.SENT
    ps.set_state(shop.admin, po.id, "close")
    assert ps.po_status(db, po.id)["status"] == ps.CLOSED


def test_voiding_the_only_receipt_returns_the_po_to_sent(db, shop):
    """[P6] A void takes the receipt out of every figure."""
    po = _bar_and_screw(db, shop)
    _take(shop, po, (po.lines[0], 4))
    ps.void_receipt(shop.admin, ps.receipts_of(db, po.id)[0]["id"])
    assert _statuses(db, po) == (ps.SENT, [ps.LINE_OPEN, ps.LINE_OPEN])


def test_ordered_and_open_value_round_each_line_then_sum(db, shop):
    """[P6, P7] Line amount = round(qty × price, 2); the PO sums line amounts; "open value" is
    what is still to arrive at the PO price; a to-be-confirmed line adds nothing."""
    po = ps.make_po(db, shop, [ps.part_line(shop.screw, 3, "each", unit_price=1.23455),    # 3.70365 → 3.70
                               ps.part_line(shop.bar, 10, "feet", unit_price=2),           # 20.00
                               ps.other_line("Expedite", unit_price=None, price_source=None)], sent=True)
    status = ps.po_status(db, po.id)
    assert status["ordered_amount"] == Decimal("23.70")
    assert status["open_amount"] == Decimal("23.70")
    assert status["has_unpriced_lines"] is True

    _take(shop, po, (po.lines[1], 5))
    assert ps.po_status(db, po.id)["open_amount"] == Decimal("13.70")


def test_next_expected_on_takes_the_promise_over_the_need_by_and_skips_finished_lines(db, shop):
    """[P6] Expected = COALESCE(promised_on, need_by_on); next = the earliest outstanding."""
    po = ps.make_po(db, shop, [
        ps.part_line(shop.bar, 10, "feet", need_by_on="2026-12-10"),
        ps.part_line(shop.screw, 1, "hundred", need_by_on="2026-12-20", promised_on="2026-12-05"),
    ], sent=True)
    assert ps.po_status(db, po.id)["next_expected_on"] == date(2026, 12, 5)
    _take(shop, po, (po.lines[1], 1))
    assert ps.po_status(db, po.id)["next_expected_on"] == date(2026, 12, 10)


def test_search_text_carries_number_vendor_parts_vendor_part_numbers_and_jobs(db, shop):
    """[P8] The list's one search box searches across the lines, so the view carries it."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet", vendor_part_number="AT-4140-1", job_id=shop.job)])
    text = (ps.po_status(db, po.id)["search_text"] or "").lower()
    for needle in (po.number, shop.v1_name, shop.bar_name, "AT-4140-1", shop.job_number):
        assert needle.lower() in text, f"{needle!r} is not searchable"


# ── P7: one definition each for "late" and "amount" ───────────────────────────────────────────


def _load(path: Path) -> dict:
    # Numbers through their decimal text, never a binary float: 1.005 and 2.675 are the cases
    # the amount fixture exists for, and a float would hand SQL the wrong half-cent.
    return json.loads(path.read_text(encoding="utf-8"), parse_float=Decimal)


def test_the_golden_fixtures_are_where_both_sides_look():
    """[P7] ONE FILE, TWO RUNNERS: the TypeScript mirrors and this file read the same cases.

    Shapes — late: {"today": "YYYY-MM-DD", "cases": [{"name", "status", "expected_on",
    "today"?, "late"}]}; amount: {"cases": [{"name", "quantity", "unit_price", "amount"}]}.
    Unpriced (to be confirmed) amounts are this file's own case, below. Do not inline a copy of
    either fixture into this file.
    """
    for path in (LATE_CASES, AMOUNT_CASES):
        assert path.is_file(), f"{path} is missing; lib/purchasing's tests and this file both read it"
        assert _load(path)["cases"], f"{path.name} has no cases"


def test_the_late_predicate_matches_every_golden_case(db):
    """[P7] `is_vendor_purchase_order_late(status, expected_on, today)` against the fixture."""
    data = _load(LATE_CASES)
    wrong = []
    for case in data["cases"]:
        got = ps.scalar(db, "SELECT public.is_vendor_purchase_order_late(%s, %s::date, %s::date)",
                        (case["status"], case["expected_on"], case.get("today", data.get("today"))))
        if got is not case["late"]:
            wrong.append(f"{case.get('name', case)}: expected {case['late']}, got {got}")
    assert not wrong, "SQL and the golden cases disagree:\n  " + "\n  ".join(wrong)


def test_the_amount_function_matches_every_golden_case(db):
    """[P7] `vendor_po_line_amount(qty, price)` against the fixture the TypeScript mirror and
    the Python QuickBooks builder also read."""
    wrong = []
    for case in _load(AMOUNT_CASES)["cases"]:
        price = None if case["unit_price"] is None else str(case["unit_price"])
        got = ps.scalar(db, "SELECT public.vendor_po_line_amount(%s::numeric, %s::numeric)",
                        (str(case["quantity"]), price))
        expected = None if case["amount"] is None else Decimal(str(case["amount"]))
        if got != expected:
            wrong.append(f"{case.get('name', case)}: expected {expected}, got {got}")
    assert not wrong, "SQL and the golden cases disagree:\n  " + "\n  ".join(wrong)


@pytest.mark.parametrize(
    "status, expected_on, today, late",
    [
        ("sent", "2026-11-08", "2026-11-09", True),
        ("partially_received", "2026-11-08", "2026-11-09", True),
        ("sent", "2026-11-09", "2026-11-09", False),   # due today is not late yet
        ("sent", "2026-11-08", "2026-11-08", False),   # the caller's date decides, not the server's
        ("sent", None, "2026-11-09", False),
        ("draft", "2026-10-01", "2026-11-09", False),
        ("received", "2026-10-01", "2026-11-09", False),
        ("closed", "2026-10-01", "2026-11-09", False),
    ],
)
def test_late_is_open_work_past_its_date_on_the_callers_calendar(db, status, expected_on, today, late):
    """[P7] Only Sent and Partly received can be late, judged against the caller's own date."""
    got = ps.scalar(db, "SELECT public.is_vendor_purchase_order_late(%s, %s::date, %s::date)",
                    (status, expected_on, today))
    assert got is late


def test_the_late_predicate_is_immutable(db):
    """[P7] IMMUTABLE and argument-only, so the views, the AI and any layer agree on it."""
    volatility = ps.scalar(db, """
        SELECT p.provolatile FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'is_vendor_purchase_order_late'""")
    assert volatility == "i"


@pytest.mark.parametrize(
    "quantity, price, amount",
    [("3", "1.23455", "3.70"), ("2.5", "0.10001", "0.25"), ("1", "0.125", "0.13"),
     ("1000", "0.00001", "0.01"), ("7", None, None)],
)
def test_a_line_amount_is_quantity_times_price_rounded_to_cents(db, quantity, price, amount):
    """[P7] round(qty × price, 2), half away from zero; to be confirmed has no amount."""
    got = ps.scalar(db, "SELECT public.vendor_po_line_amount(%s::numeric, %s::numeric)", (quantity, price))
    assert got == (None if amount is None else Decimal(amount))


# ── QB9: content_version, the counter of what QuickBooks holds ────────────────────────────────


def _close_bar_line(db, c: SentPo):
    ps.set_lines(c.shop.user, c.po.id, [c.bar_line], "close")


def _receive_three(db, c: SentPo, **kw):
    ps.receive(c.shop.user, c.po.id, [ps.entry(c.bar_line, 3, location=c.shop.shelf, **kw)])


def _close_screw_line(db, c: SentPo):
    """Line 2 closed short with nothing received: QuickBooks Desktop closes that line, and the
    PO stays open while the bar is still owed."""
    ps.set_lines(c.shop.user, c.po.id, [c.screw_line], "close", reason="Vendor is out")


def _receive_all_bar(db, c: SentPo):
    """All 10 ft. Beside the closed screw line (and the no-receipt line) nothing is outstanding,
    so the derived status becomes closed -- the status the push closes the QuickBooks PO from."""
    ps.receive(c.shop.user, c.po.id, [ps.entry(c.bar_line, 10, location=c.shop.shelf)])


def _close_screw_then_receive_all_bar(db, c: SentPo):
    _close_screw_line(db, c)
    _receive_all_bar(db, c)
    assert ps.po_status(db, c.po.id)["status"] == ps.CLOSED


def _void_the_bar_receipt(db, c: SentPo):
    receipt = next(r for r in ps.receipts_of(db, c.po.id) if r["vendor_purchase_order_line_id"] == c.bar_line)
    ps.void_receipt(c.shop.user, receipt["id"])


def _receive_every_line_in_full(db, c: SentPo):
    ps.receive(c.shop.user, c.po.id, [ps.entry(c.bar_line, 10, location=c.shop.shelf),
                                      ps.entry(c.screw_line, 2.5, location=c.shop.shelf)])


def _open_rev_1(db, c: SentPo):
    """A vendor-visible change has already opened Rev 1, so the revision -- which the pushed
    projection carries too -- cannot move again this cycle: only the field itself can move
    content_version. Without it, every vendor-visible save after a send bumps through the
    revision and would hide a field the projection lacks."""
    _save(db, c, {"changes": {"ship_via": "Will call"}})


def _rename_bar_in_open_rev_1(db, c: SentPo):
    ps.execute(db, "UPDATE parts SET part_name = 'BAR-4140-1RD-B' WHERE id = %s", (c.shop.bar,))
    _open_rev_1(db, c)


def _add_anodize_line(db, c: SentPo):
    _save(db, c, {"lines": [ps.outside_line(c.shop.outside_op, 100)]})


def _anodize_line(db, c: SentPo) -> str:
    return next(r["id"] for r in ps.lines_of(db, c.po.id) if r["line_kind"] == "outside_service")


def _as_any_writer(column: str, value, line: Callable[[object, SentPo], str]):
    """ONE line column changed the way every PO writer makes its change: the change, then the
    settle step every writer ends with (vendor_purchase_order_settle_versions, which compares the
    pushed projection's md5 with the stored content_hash). For the snapshots no RPC moves on their
    own: an existing line's step is fixed, so its service name never moves by itself, and its
    stock unit and factor move only with its unit or its part."""
    def act(db, c: SentPo):
        target = line(db, c)
        ps.execute(db, f"UPDATE public.vendor_purchase_order_lines SET {column} = %s WHERE id = %s", (value, target))
        ps.scalar(db, "SELECT public.vendor_purchase_order_settle_versions(%s, false)", (c.po.id,))
    return act


CONTENT_CASES = [
    ("save_notes_to_vendor", True, None, lambda db, c: _save(db, c, {"changes": {"notes_to_vendor": "Dock B"}})),
    ("save_payment_terms", True, None, lambda db, c: _save(db, c, {"changes": {"payment_terms": "Net 45"}})),
    ("save_ship_via", True, None, lambda db, c: _save(db, c, {"changes": {"ship_via": "Will call"}})),
    ("save_header_need_by_on", True, None, lambda db, c: _save(db, c, {"changes": {"need_by_on": "2026-12-20"}})),
    ("save_line_quantity", True, None, lambda db, c: _save(db, c, {"lines": [{"id": c.bar_line, "quantity": 11}]})),
    ("save_line_unit_price", True, None, lambda db, c: _save(db, c, {"lines": [{"id": c.bar_line, "unit_price": 23}]})),
    ("save_line_vendor_part_number", True, None,
     lambda db, c: _save(db, c, {"lines": [{"id": c.bar_line, "vendor_part_number": "AT-NEW"}]})),
    ("save_line_added", True, None, lambda db, c: _save(db, c, {"lines": [ps.other_line("Freight")]})),
    ("save_line_removed", True, None, lambda db, c: _save(db, c, {"removed": [c.screw_line]})),
    # The QuickBooks line description prints these (api/services/accounting/purchase_order.py
    # describe_line): the part number, the machine, the job, the unit label and the service.
    ("save_line_part_number_refreshed_in_open_rev", True, _rename_bar_in_open_rev_1,
     lambda db, c: _save(db, c, {"lines": [{"id": c.bar_line, "part_id": c.shop.bar}]})),
    ("save_line_work_center_in_open_rev", True, _open_rev_1,
     lambda db, c: _save(db, c, {"lines": [{"id": c.machine_line, "work_center_id": c.shop.work_center_2}]})),
    ("save_line_job_part_in_open_rev", True, _open_rev_1,
     lambda db, c: _save(db, c, {"lines": [{"id": c.screw_line, "job_part_id": c.shop.screw_job_part}]})),
    ("any_writer_line_stock_unit", True, None,
     _as_any_writer("stock_unit", "millimeters", lambda db, c: c.bar_line)),
    ("any_writer_line_stock_factor", True, None, _as_any_writer("stock_factor", 10, lambda db, c: c.bar_line)),
    ("any_writer_line_service_name", True, _add_anodize_line,
     _as_any_writer("service_name", "Hard anodize", _anodize_line)),
    ("any_writer_line_promised_on", False, None,
     _as_any_writer("promised_on", date(2026, 11, 30), lambda db, c: c.bar_line)),
    ("save_internal_notes", False, None,
     lambda db, c: ps.save_po(c.shop.user, c.po.id, changes={"internal_notes": "Called"})),
    ("save_promised_on", False, None,
     lambda db, c: ps.save_po(c.shop.user, c.po.id, lines=[{"id": c.bar_line, "promised_on": "2026-11-30"}])),
    ("close_po", True, None, lambda db, c: ps.set_state(c.shop.user, c.po.id, "close")),
    ("reopen_po", True, lambda db, c: ps.set_state(c.shop.user, c.po.id, "close"),
     lambda db, c: ps.set_state(c.shop.user, c.po.id, "reopen")),
    ("close_line", True, None, _close_bar_line),
    ("reopen_line", True, _close_bar_line,
     lambda db, c: ps.set_lines(c.shop.user, c.po.id, [c.bar_line], "reopen")),
    ("receive", False, None, _receive_three),
    ("receive_closing_the_rest", True, None, lambda db, c: _receive_three(db, c, close_remaining=True)),
    ("void_a_receipt", False, _receive_three,
     lambda db, c: ps.void_receipt(c.shop.user, ps.receipts_of(db, c.po.id)[0]["id"])),
    # The DERIVED status is what the push closes from, so a delivery is a QuickBooks change
    # exactly when it moves the PO into or out of closed.
    ("receive_part_beside_a_line_closed_short", False, _close_screw_line, _receive_three),
    ("receive_the_rest_beside_a_line_closed_short", True, _close_screw_line, _receive_all_bar),
    ("void_the_receipt_that_left_nothing_outstanding", True, _close_screw_then_receive_all_bar,
     _void_the_bar_receipt),
    ("receive_every_line_in_full", False, None, _receive_every_line_in_full),
    ("void_a_receipt_on_a_po_received_in_full", False, _receive_every_line_in_full, _void_the_bar_receipt),
    ("close_po_already_closed_by_its_receipts", False, _close_screw_then_receive_all_bar,
     lambda db, c: ps.set_state(c.shop.user, c.po.id, "close")),
]


@pytest.mark.parametrize("name, bumps, setup, act", CONTENT_CASES, ids=[case[0] for case in CONTENT_CASES])
def test_content_version_moves_exactly_when_a_field_quickbooks_holds_changes(db, sent, name, bumps, setup, act):
    """[QB9] Writer × field. Every pushed field bumps it — close and reopen included, at the
    PO and at the line, and a receipt that closes the remainder is a line close. "Closed" is the
    derived status the push acts on, so the delivery that leaves nothing outstanding beside a
    line closed short bumps it, and so does voiding that delivery; an ordinary receipt or void,
    internal notes and promised dates never do, so "Out of date in QuickBooks" is exact."""
    if setup is not None:
        setup(db, sent)
    before = ps.po_row(db, sent.po.id)["content_version"]
    act(db, sent)
    after = ps.po_row(db, sent.po.id)["content_version"]
    assert (after > before) is bumps, f"{name}: content_version {before} → {after}"


def test_the_pushed_projection_closes_with_the_derived_status_the_push_acts_on(db, sent):
    """[QB9] The route closes the QuickBooks PO when vendor_purchase_order_status reads closed
    (projection_from_rows), so the database's projection -- the one content_version counts -- must
    say closed at the same moment. Here a delivery closes the PO while closed_at is still NULL, and
    voiding it opens it again; reading closed_at would have the two disagree twice."""
    from services.accounting.purchase_order import projection_from_rows

    def closed_in_both() -> tuple[bool, bool]:
        status = ps.po_status(db, sent.po.id)["status"]
        pushed = projection_from_rows(ps.po_row(db, sent.po.id), ps.lines_of(db, sent.po.id), status=status)
        counted = ps.scalar(db, "SELECT public.vendor_purchase_order_pushed_projection(%s)", (sent.po.id,))
        return counted["closed"], pushed.closed

    assert closed_in_both() == (False, False)
    _close_screw_then_receive_all_bar(db, sent)
    assert ps.po_row(db, sent.po.id)["closed_at"] is None, "closed by its receipts, not by hand"
    assert closed_in_both() == (True, True)
    _void_the_bar_receipt(db, sent)
    assert closed_in_both() == (False, False)


def test_a_new_po_starts_at_version_0_with_the_hash_it_counts_from(db, shop):
    """[QB9] create_vendor_purchase_order ends like every writer, by settling, which records the
    md5 version 0 describes; the first change after it is the first one counted."""
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet")])
    row = ps.po_row(db, po.id)
    assert row["content_version"] == 0
    assert row["content_hash"] == ps.scalar(
        db, "SELECT md5(public.vendor_purchase_order_pushed_projection(%s)::text)", (po.id,))


def test_the_pushed_projection_carries_every_line_field_the_quickbooks_push_reads(db, sent):
    """[QB9] api/services/accounting/purchase_order.py builds each QuickBooks line (description,
    unit label, rate) from these line fields and hashes them. "Out of date" is exact only if
    vendor_purchase_order_pushed_projection, which every writer compares before and after,
    carries each one: a field it lacks can change while the PO still reads "In QuickBooks"."""
    from dataclasses import fields

    from services.accounting.purchase_order import PurchaseOrderLineProjection

    column = {"line_id": "id", "part_number": "part_name"}  # where the push reads these two from
    read = {column.get(f.name, f.name) for f in fields(PurchaseOrderLineProjection)}
    lines = ps.scalar(db, "SELECT public.vendor_purchase_order_pushed_projection(%s)", (sent.po.id,))["lines"]
    assert lines, "the projection has no lines to compare"
    missing = read - set(lines[0])
    assert not missing, f"the pushed projection lacks {sorted(missing)}"
