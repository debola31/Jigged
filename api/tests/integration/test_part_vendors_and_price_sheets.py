"""The approved vendor list and per-vendor price sheets (plan §3.2, §3.3, §3.8; V1, V2, L1).

WHAT THIS GUARDS.

  * **One row per (part, vendor), and the row is the identity.** Saving the same pair again
    updates it; archiving and saving again revives the SAME row, so its history and its sheet
    come back with it (V1).
  * **`parts.preferred_vendor_id` stays the only "preferred" marker** — it already has four
    writers (the part form, the importer, MCP, the demo seeder) — so the invariant "a preferred
    vendor is always on the list" is held by a trigger on `parts`, a backfill and an assertion,
    not by a second flag kept in sync. The trigger also closes a latent hole: a preferred
    vendor from another company. Disapproving the preferred vendor is refused, making a
    Do-not-use vendor preferred is refused, and archiving the preferred row clears it (V1).
  * **A sheet is replaced whole, in purchase units, with dates per sheet** (V2), and its
    purchase unit is the stock unit or has the part's one conversion row (L1).

Run:
    cd api && pytest -m integration tests/integration/test_part_vendors_and_price_sheets.py
"""
from __future__ import annotations

from decimal import Decimal

import pytest
from psycopg2 import errors

from tests.integration import purchasing_support as ps
from tests.integration.purchasing_support import db, other_shop, shop  # noqa: F401

pytestmark = pytest.mark.integration


def _refuse_save(shop: ps.Shop, part: str, vendor: str, changes: dict | None = None,
                 breaks: list | None = None, make_preferred: bool = False):
    return ps.refuse(shop.user, "save_part_vendor", **ps.part_vendor_args(part, vendor, changes, breaks, make_preferred))


def _prefer(shop: ps.Shop, part: str, vendor: str | None) -> None:
    """The part form's own write: a direct UPDATE of `parts`, as the browser makes it."""
    ps.sql_as(shop.user, "UPDATE parts SET preferred_vendor_id = %s WHERE id = %s", (vendor, part))


# ── V1: identity, archive and revive ───────────────────────────────────────────────────────────


def test_one_row_per_part_and_vendor_and_saving_again_updates_it(db, shop):
    """[V1] The full UNIQUE(part_id, vendor_id) is identity: a second save is an update."""
    ps.save_avl(shop.user, shop.bar, shop.v1, {"purchase_unit": "feet", "lead_time_days": 5})
    first = ps.avl_row(db, shop.bar, shop.v1)
    ps.save_avl(shop.user, shop.bar, shop.v1, {"purchase_unit": "feet", "lead_time_days": 9,
                                               "vendor_part_number": "AT-4140-1"})
    again = ps.avl_row(db, shop.bar, shop.v1)
    assert again["id"] == first["id"]
    assert (again["lead_time_days"], again["vendor_part_number"]) == (9, "AT-4140-1")
    assert ps.scalar(db, "SELECT count(*) FROM part_vendors WHERE part_id = %s", (shop.bar,)) == 1

    with pytest.raises(errors.UniqueViolation):
        ps.execute(db, "INSERT INTO part_vendors (company_id, part_id, vendor_id, purchase_unit) VALUES (%s, %s, %s, 'feet')",
                   (shop.company, shop.bar, shop.v1))


def test_archiving_then_saving_again_revives_the_same_row(db, shop):
    """[V1] Adding the same vendor again revives the row rather than making a second one."""
    ps.save_avl(shop.user, shop.bar, shop.v1, {"purchase_unit": "feet"})
    row_id = ps.avl_row(db, shop.bar, shop.v1)["id"]
    ps.call(shop.user, "archive_part_vendor", p_part_vendor_id=row_id)
    assert ps.avl_row(db, shop.bar, shop.v1)["deleted_at"] is not None

    ps.save_avl(shop.user, shop.bar, shop.v1, {"purchase_unit": "feet"})
    revived = ps.avl_row(db, shop.bar, shop.v1)
    assert revived["id"] == row_id and revived["deleted_at"] is None


@pytest.mark.parametrize("status", ["approved", "conditional", "disapproved"])
def test_the_three_statuses_are_approved_conditional_and_do_not_use(db, shop, status):
    """[V1] Shown as Approved / Conditional / Do not use."""
    ps.save_avl(shop.user, shop.screw, shop.v2, {"purchase_unit": "hundred", "status": status,
                                                 "status_note": "Audited 2026-10"})
    assert ps.avl_row(db, shop.screw, shop.v2)["status"] == status


def test_any_other_status_is_refused(db, shop):
    """[V1]"""
    ps.assert_sentence_refusal(_refuse_save(shop, shop.screw, shop.v2, {"purchase_unit": "hundred",
                                                                        "status": "preferred"}))
    assert ps.avl_row(db, shop.screw, shop.v2) is None


# ── V1: the preferred vendor is always on the list ─────────────────────────────────────────────


def test_making_a_vendor_preferred_lists_it_and_revives_an_archived_row(db, shop):
    """[V1] An UPDATE or an INSERT of `preferred_vendor_id` creates the row as Approved in the
    stock unit — or revives the archived one, keeping its id."""
    _prefer(shop, shop.bar, shop.v1)
    listed = ps.avl_row(db, shop.bar, shop.v1)
    assert (listed["status"], listed["purchase_unit"], listed["deleted_at"]) == ("approved", "inches", None)

    new_part = ps.scalar(db, """
        INSERT INTO parts (company_id, part_name, source, primary_unit, quantity, preferred_vendor_id)
        VALUES (%s, 'DOWEL-6MM', 'bought', 'each', 0, %s) RETURNING id""", (shop.company, shop.v2))
    assert ps.avl_row(db, new_part, shop.v2)["deleted_at"] is None

    _prefer(shop, shop.bar, shop.v2)
    ps.call(shop.user, "archive_part_vendor", p_part_vendor_id=listed["id"])
    assert ps.preferred_vendor(db, shop.bar) == shop.v2, "archiving a row that is not preferred cleared the preference"
    _prefer(shop, shop.bar, shop.v1)
    revived = ps.avl_row(db, shop.bar, shop.v1)
    assert revived["id"] == listed["id"] and revived["deleted_at"] is None


def test_saving_with_make_preferred_sets_the_parts_preferred_vendor(db, shop):
    """[V1] The Buying tab's star."""
    ps.save_avl(shop.user, shop.bar, shop.v2, {"purchase_unit": "feet"}, make_preferred=True)
    assert ps.preferred_vendor(db, shop.bar) == shop.v2


def test_a_preferred_vendor_from_another_company_is_refused(db, shop, other_shop):
    """[V1] The latent hole the trigger closes: `parts.preferred_vendor_id` is a plain FK."""
    err = ps.refuse_sql(shop.user, "UPDATE parts SET preferred_vendor_id = %s WHERE id = %s", (other_shop.v1, shop.bar))
    ps.assert_sentence_refusal(err)
    assert ps.preferred_vendor(db, shop.bar) is None


def test_a_do_not_use_vendor_cannot_be_made_preferred(db, shop):
    """[V1] Neither by the part form nor by the star."""
    ps.save_avl(shop.user, shop.bar, shop.v2, {"purchase_unit": "feet", "status": "disapproved"})
    ps.assert_sentence_refusal(ps.refuse_sql(shop.user, "UPDATE parts SET preferred_vendor_id = %s WHERE id = %s",
                                             (shop.v2, shop.bar)))
    ps.assert_sentence_refusal(_refuse_save(shop, shop.bar, shop.v2, {"purchase_unit": "feet"}, make_preferred=True))
    assert ps.preferred_vendor(db, shop.bar) is None


def test_disapproving_the_preferred_vendor_is_refused(db, shop):
    """[V1] Choose another preferred vendor first."""
    _prefer(shop, shop.bar, shop.v1)
    ps.assert_sentence_refusal(_refuse_save(shop, shop.bar, shop.v1, {"purchase_unit": "inches", "status": "disapproved"}))
    assert ps.avl_row(db, shop.bar, shop.v1)["status"] == "approved"


def test_archiving_the_preferred_row_clears_the_preference(db, shop):
    """[V1] So the invariant holds at rest rather than in a "what if it's archived" branch."""
    _prefer(shop, shop.bar, shop.v1)
    ps.call(shop.user, "archive_part_vendor", p_part_vendor_id=ps.avl_row(db, shop.bar, shop.v1)["id"])
    assert ps.preferred_vendor(db, shop.bar) is None
    assert ps.avl_row(db, shop.bar, shop.v1)["deleted_at"] is not None


def test_no_part_at_rest_has_an_unlisted_or_foreign_preferred_vendor(db):
    """[V1] The backfill's assertion, re-run against whatever this database holds — the seed,
    the demo templates and every other test's leftovers included."""
    unlisted = ps.rows(db, """
        SELECT p.id, p.part_name FROM parts p
         WHERE p.preferred_vendor_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM part_vendors pv
                            WHERE pv.part_id = p.id AND pv.vendor_id = p.preferred_vendor_id
                              AND pv.deleted_at IS NULL)""")
    assert unlisted == [], f"preferred vendors missing from their part's list: {unlisted[:5]}"
    foreign = ps.rows(db, """
        SELECT p.id, p.part_name FROM parts p JOIN vendors v ON v.id = p.preferred_vendor_id
         WHERE v.company_id <> p.company_id""")
    assert foreign == [], f"preferred vendors from another company: {foreign[:5]}"


# ── V2 / L1: the price sheet ───────────────────────────────────────────────────────────────────


def test_the_purchase_unit_is_the_stock_unit_or_has_its_conversion(db, shop):
    """[V2, L1] The factor lives in parts_unit_conversions; a unit without one is refused."""
    ps.save_avl(shop.user, shop.bar, shop.v1, {"purchase_unit": "inches"})
    ps.save_avl(shop.user, shop.bar, shop.v1, {"purchase_unit": "feet"})
    assert ps.avl_row(db, shop.bar, shop.v1)["purchase_unit"] == "feet"

    ps.assert_sentence_refusal(_refuse_save(shop, shop.bar, shop.v2, {"purchase_unit": "bars"}))
    assert ps.avl_row(db, shop.bar, shop.v2) is None


def test_a_save_replaces_the_whole_sheet_and_no_sheet_leaves_it(db, shop):
    """[V2] Non-null breaks replace the sheet; null leaves it as it is."""
    ps.save_avl(shop.user, shop.bar, shop.v1, {"purchase_unit": "feet", "quoted_on": "2026-11-01",
                                               "valid_until": "2027-01-31"},
                breaks=[{"min_quantity": 10, "unit_price": 24}, {"min_quantity": 100, "unit_price": 18}])
    row = ps.avl_row(db, shop.bar, shop.v1)
    assert [(b["min_quantity"], b["unit_price"]) for b in ps.breaks_of(db, row["id"])] == [(10, 24), (100, 18)]
    assert all(b["source"] == "manual" for b in ps.breaks_of(db, row["id"]))

    ps.save_avl(shop.user, shop.bar, shop.v1, {"purchase_unit": "feet", "lead_time_days": 3})
    assert len(ps.breaks_of(db, row["id"])) == 2

    ps.save_avl(shop.user, shop.bar, shop.v1, {"purchase_unit": "feet"}, breaks=[{"min_quantity": 50, "unit_price": 20}])
    assert [(b["min_quantity"], b["unit_price"]) for b in ps.breaks_of(db, row["id"])] == [(50, 20)]


def test_the_quoted_and_valid_dates_belong_to_the_sheet(db, shop):
    """[V2] Per sheet, on the list row — one quote, one validity."""
    ps.save_avl(shop.user, shop.bar, shop.v1, {"purchase_unit": "feet", "quoted_on": "2026-11-01",
                                               "valid_until": "2027-01-31"},
                breaks=[{"min_quantity": 10, "unit_price": 24}])
    row = ps.avl_row(db, shop.bar, shop.v1)
    assert (row["quoted_on"].isoformat(), row["valid_until"].isoformat()) == ("2026-11-01", "2027-01-31")


def test_valid_until_before_quoted_on_is_refused(db, shop):
    """[V2]"""
    ps.assert_sentence_refusal(_refuse_save(shop, shop.bar, shop.v1, {"purchase_unit": "feet",
                                                                      "quoted_on": "2026-11-01",
                                                                      "valid_until": "2026-10-01"}))


def test_a_duplicate_break_quantity_is_refused(db, shop):
    """[V2] UNIQUE(part_vendor_id, min_quantity): two prices for "10 and up" is no price."""
    err = _refuse_save(shop, shop.bar, shop.v1, {"purchase_unit": "feet"},
                       breaks=[{"min_quantity": 10, "unit_price": 24}, {"min_quantity": 10, "unit_price": 22}])
    ps.assert_refused(err, ("P0001", "23514", "23505"))
    assert ps.avl_row(db, shop.bar, shop.v1) is None


@pytest.mark.parametrize(
    "price_break",
    [pytest.param({"min_quantity": 0, "unit_price": 24}, id="zero-quantity"),
     pytest.param({"min_quantity": 10, "unit_price": 0}, id="zero-price")],
)
def test_a_break_is_a_positive_quantity_at_a_positive_price(db, shop, price_break):
    """[V2] Breaks are in purchase units and priced per purchase unit."""
    ps.assert_sentence_refusal(_refuse_save(shop, shop.bar, shop.v1, {"purchase_unit": "feet"}, breaks=[price_break]))


def test_a_lead_time_is_between_zero_and_730_days(db, shop):
    """[V1] `lead_time_days` 0–730."""
    ps.assert_sentence_refusal(_refuse_save(shop, shop.bar, shop.v1, {"purchase_unit": "feet", "lead_time_days": 731}))


def test_breaks_and_minimums_are_kept_in_purchase_units(db, shop):
    """[V2] A sheet in hundreds stores hundreds: 10 hundred is a break at 10, not at 1000."""
    ps.save_avl(shop.user, shop.screw, shop.v2, {"purchase_unit": "hundred", "minimum_order_quantity": 5},
                breaks=[{"min_quantity": 10, "unit_price": Decimal("9.5")}])
    row = ps.avl_row(db, shop.screw, shop.v2)
    assert row["minimum_order_quantity"] == 5
    assert [(b["min_quantity"], b["unit_price"]) for b in ps.breaks_of(db, row["id"])] == [(10, Decimal("9.5"))]
