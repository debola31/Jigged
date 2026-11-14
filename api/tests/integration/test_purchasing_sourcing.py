"""Use as part cost: a vendor's price sheet becomes the part's estimate cost (plan §3.3, §3.8; V3, V4).

WHAT THIS GUARDS. A PO price is a frozen term of one document and NEVER a cost record. The one
way a vendor's price reaches `part_pricing_tiers` is an explicit action — previewed, then
applied — because a tier's cost moves every quote price built on it:

  * **The preview writes nothing**, converts the sheet's purchase unit to the stock unit (per
    foot → per inch) and flags tiers that sit below the vendor's minimum (V3).
  * **Apply updates `cost_per_unit` IN PLACE.** Same tier ids, same quantities, same markups —
    quote drift detection compares exactly those, so replacing the rows would flag every
    quote. Tiers are inserted (at markup 0, the starter-tier convention) only when the part has
    none. It refuses if anything changed since the preview, and refuses made parts (V3).
  * **Nothing else in purchasing writes tiers** — checked in the catalogue, and by receiving at
    a different price (V3).
  * **Documents keep their numbers**: quote lines are untouched (only tiers whose cost really
    moved will read "Pricing changed"), existing job parts keep their frozen true cost, and
    new job parts take the new one (V4).

BAR's tiers (from the shop): 12 in at $2.50 (+20%), 1200 in at $1.50 (+15%), 2400 in at $1.40
(+10%). The sheet: 10 ft at $24.00/ft, 100 ft at $18.00/ft — so $2.00/in, $1.50/in, $1.50/in.

Run:
    cd api && pytest -m integration tests/integration/test_purchasing_sourcing.py
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, shop  # noqa: F401

pytestmark = pytest.mark.integration


@pytest.fixture
def sheet(db, shop) -> str:
    """V1's sheet for BAR, in feet, valid today. Returns the part_vendors id."""
    ps.save_avl(shop.admin, shop.bar, shop.v1,
                {"purchase_unit": "feet", "quoted_on": "2026-11-01", "valid_until": "2027-01-31"},
                breaks=[{"min_quantity": 10, "unit_price": 24}, {"min_quantity": 100, "unit_price": 18}])
    return str(ps.avl_row(db, shop.bar, shop.v1)["id"])


def _preview(shop: ps.Shop, part_vendor: str) -> dict:
    return ps.call(shop.user, "preview_part_cost_from_vendor", p_part_vendor_id=part_vendor, p_today=ps.TODAY)


def _apply(shop: ps.Shop, part_vendor: str, preview: dict):
    return ps.call(shop.user, "apply_part_cost_from_vendor", p_part_vendor_id=part_vendor,
                   p_today=ps.TODAY, p_expected=preview)


def _price_at(db, part: str, quantity) -> Decimal:
    return ps.scalar(db, "SELECT public.compute_part_price_at_qty(%s::uuid, %s::numeric)", (part, quantity))


# ── V3: preview, apply, refusals ───────────────────────────────────────────────────────────────


def test_the_preview_converts_a_per_foot_sheet_to_per_inch_costs_and_flags_below_minimum(db, shop, sheet):
    """[V3] The 12 in tier is 1 ft — below the 10 ft minimum — so it takes the lowest break and
    says so; 1200 in is 100 ft at $18, i.e. $1.50/in."""
    tiers = {str(t["tier_id"]): t for t in _preview(shop, sheet)["tiers"]}
    small, mid, large = (tiers[shop.bar_tiers[q]] for q in (12, 1200, 2400))
    assert Decimal(str(small["proposed_cost"])) == Decimal("2")
    assert small["below_vendor_minimum"] is True
    assert Decimal(str(mid["proposed_cost"])) == Decimal("1.5") and mid["below_vendor_minimum"] is False
    assert Decimal(str(large["proposed_cost"])) == Decimal("1.5")


def test_the_preview_writes_nothing(db, shop, sheet):
    """[V3] It is a SECURITY INVOKER read; the tiers are exactly as they were."""
    before = ps.tiers(db, shop.bar)
    _preview(shop, sheet)
    assert ps.tiers(db, shop.bar) == before


def test_apply_updates_costs_in_place_keeping_ids_quantities_and_markups(db, shop, sheet):
    """[V3] Same rows, new costs: what quote drift detection compares stays comparable."""
    before = ps.tiers(db, shop.bar)
    _apply(shop, sheet, _preview(shop, sheet))
    after = ps.tiers(db, shop.bar)
    assert [(t["id"], t["quantity"], t["markup_percent"]) for t in after] == \
           [(t["id"], t["quantity"], t["markup_percent"]) for t in before]
    assert [t["cost_per_unit"] for t in after] == [Decimal("2"), Decimal("1.5"), Decimal("1.5")]


def test_apply_refuses_when_a_tier_changed_since_the_preview(db, shop, sheet):
    """[V3] "Changed since you previewed" — and the edit someone else made is kept."""
    preview = _preview(shop, sheet)
    ps.execute(db, "UPDATE part_pricing_tiers SET cost_per_unit = 2.75 WHERE id = %s", (shop.bar_tiers[12],))
    err = ps.refuse(shop.user, "apply_part_cost_from_vendor", p_part_vendor_id=sheet, p_today=ps.TODAY,
                    p_expected=preview)
    ps.assert_state_refusal(err, ps.STALE_PREVIEW_HINT)
    assert ps.scalar(db, "SELECT cost_per_unit FROM part_pricing_tiers WHERE id = %s", (shop.bar_tiers[12],)) == Decimal("2.75")


def test_a_made_part_cannot_take_its_cost_from_a_vendor(db, shop):
    """[V3] A made part's cost is its routing and BOM; sourcing applies to bought parts only.
    (The list row is written directly so this does not depend on whether the Buying tab offers
    made parts.)"""
    part_vendor = ps.scalar(db, """
        INSERT INTO part_vendors (company_id, part_id, vendor_id, purchase_unit, status)
        VALUES (%s, %s, %s, 'each', 'approved') RETURNING id""", (shop.company, shop.widget, shop.v1))
    ps.execute(db, """
        INSERT INTO part_vendor_price_breaks (company_id, part_vendor_id, min_quantity, unit_price)
        VALUES (%s, %s, 10, 30)""", (shop.company, part_vendor))

    ps.assert_sentence_refusal(ps.refuse(shop.user, "preview_part_cost_from_vendor",
                                         p_part_vendor_id=part_vendor, p_today=ps.TODAY))
    ps.assert_sentence_refusal(ps.refuse(shop.user, "apply_part_cost_from_vendor", p_part_vendor_id=part_vendor,
                                         p_today=ps.TODAY, p_expected={}))
    assert ps.tiers(db, shop.widget) == []


def test_a_part_with_no_tiers_gets_one_per_break_at_markup_zero(db, shop):
    """[V3] The only insert: SCREW has no tiers, so each break becomes a tier at its stock
    quantity (1 hundred = 100, 10 hundred = 1000), costed per each, at markup 0."""
    ps.save_avl(shop.admin, shop.screw, shop.v2, {"purchase_unit": "hundred"},
                breaks=[{"min_quantity": 1, "unit_price": 12}, {"min_quantity": 10, "unit_price": 9}])
    part_vendor = str(ps.avl_row(db, shop.screw, shop.v2)["id"])
    _apply(shop, part_vendor, _preview(shop, part_vendor))

    assert [(t["quantity"], t["cost_per_unit"], t["markup_percent"]) for t in ps.tiers(db, shop.screw)] == [
        (100, Decimal("0.12"), 0), (1000, Decimal("0.09"), 0)]


def test_only_apply_writes_pricing_tiers_among_the_purchasing_functions(db):
    """[V3] The catalogue check: of every function the purchasing migrations own, exactly one
    has a body that inserts, updates or deletes `part_pricing_tiers`."""
    writers = ps.rows(db, """
        SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname ~ %s AND p.prosrc ~* %s""",
        (ps.PURCHASING_FUNCTION_PATTERN,
         r"(insert\s+into|update|delete\s+from)\s+(public\.)?part_pricing_tiers"))
    assert {w["proname"] for w in writers} == {"apply_part_cost_from_vendor"}


def test_receiving_at_a_new_price_leaves_the_tiers_alone(db, shop, sheet):
    """[V3] A PO price is a term of one document, never a cost record."""
    before = ps.tiers(db, shop.bar)
    po = ps.make_po(db, shop, [ps.part_line(shop.bar, 10, "feet", unit_price=31.75)], sent=True)
    ps.receive(shop.admin, po.id, [ps.entry(po.lines[0], 10, location=shop.shelf)])
    assert ps.tiers(db, shop.bar) == before


# ── V4: documents keep their numbers ───────────────────────────────────────────────────────────


def test_apply_leaves_quote_lines_alone_and_moves_only_the_tiers_whose_cost_changed(db, shop, sheet):
    """[V4] The quote line is untouched. Only the 12 in tier's price really moved (by more than
    0.005), so only quote lines on it will read "Pricing changed"; the 1200 in tier's cost was
    already $1.50, so its price did not move at all."""
    small_before, mid_before = _price_at(db, shop.bar, 12), _price_at(db, shop.bar, 1200)
    quote = ps.scalar(db, """
        INSERT INTO quotes (company_id, customer_id, quote_number, status)
        VALUES (%s, %s, '', 'active') RETURNING id""", (shop.company, shop.customer))
    line = ps.scalar(db, """
        INSERT INTO quote_line_items (company_id, quote_id, part_id, quantity, unit_price, sequence, source_tier_id)
        VALUES (%s, %s, %s, 12, %s, 1, %s) RETURNING id""",
        (shop.company, quote, shop.bar, small_before, shop.bar_tiers[12]))
    quoted = ps.row(db, "SELECT * FROM quote_line_items WHERE id = %s", (line,))

    _apply(shop, sheet, _preview(shop, sheet))

    assert ps.row(db, "SELECT * FROM quote_line_items WHERE id = %s", (line,)) == quoted, "applying a cost re-priced a quote"
    assert abs(_price_at(db, shop.bar, 12) - quoted["unit_price"]) > Decimal("0.005")
    assert _price_at(db, shop.bar, 1200) == mid_before


def test_existing_job_costs_stay_frozen_and_a_new_job_part_takes_the_new_cost(db, shop, sheet):
    """[V4] `job_parts.true_cost_per_unit` is frozen at insert: $2.50 before, still $2.50 after;
    a job part added afterwards costs $2.00."""
    existing = ps.add_job_part(db, shop, shop.bar, 12)
    true_cost = "SELECT true_cost_per_unit FROM job_parts WHERE id = %s"
    assert ps.scalar(db, true_cost, (existing,)) == Decimal("2.5")

    _apply(shop, sheet, _preview(shop, sheet))
    assert ps.scalar(db, true_cost, (existing,)) == Decimal("2.5")

    later_job = ps.add_job(db, shop, f"J-{shop.tag[:4].upper()}-2")
    added = ps.add_job_part(db, shop, shop.bar, 12, job=later_job)
    assert ps.scalar(db, true_cost, (added,)) == Decimal("2")
