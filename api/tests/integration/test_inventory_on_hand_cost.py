"""`inventory_on_hand_cost` agrees with the canonical cost function — including the FLOOR arm.

WHAT THIS GUARDS, and why no vitest can. The view re-implements the tier rule that
`part_rollup_at_qty` owns (20260906182521), because a view cannot call a plpgsql function per row
without paying for it. Two implementations of one rule drift, and the drift is silent: the table
still renders, the total still adds up, and every figure on it is wrong by a tier.

THE ARM THAT MATTERS IS THE SECOND ONE. The rule is "highest break <= quantity", and then — when
the shop holds FEWER than the smallest break — "floor to the lowest break so the part is still
costable". A reading that stops at the first arm reports every part held in small quantity as
having no cost on file: it manufactures gaps out of ordinary data, and a shop seeing 40 of its 60
parts listed as uncosted would rightly stop trusting the total.

That case is not reachable from seed data — every seeded part's smallest break is 1 — which is
exactly why it is constructed here rather than left to a hand check.

Requires a local Supabase with all migrations applied. Skipped without it.
"""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.integration


@pytest.fixture
def shop(supabase_admin):
    """A company, one place, and a helper for putting a priced part on the shelf."""
    company_id = str(uuid.uuid4())
    supabase_admin.table("companies").insert(
        {"id": company_id, "name": f"On-hand cost {company_id[:8]}"}
    ).execute()
    place = (
        supabase_admin.table("inventory_locations")
        .insert({"company_id": company_id, "name": "Shelf A", "kind": "shelf"})
        .execute()
        .data[0]["id"]
    )

    def add_part(name, source="bought", tiers=(), quantity=0):
        part_id = (
            supabase_admin.table("parts")
            .insert(
                {
                    "company_id": company_id,
                    "part_name": f"{name}-{company_id[:6]}",
                    "source": source,
                    "primary_unit": "ea",
                    "quantity": 0,
                }
            )
            .execute()
            .data[0]["id"]
        )
        for seq, (break_qty, cost) in enumerate(tiers):
            supabase_admin.table("part_pricing_tiers").insert(
                {
                    "company_id": company_id,
                    "part_id": part_id,
                    "quantity": break_qty,
                    "cost_per_unit": cost,
                    "sequence": seq,
                }
            ).execute()
        if quantity:
            # Written straight to the balance table, as the sibling holdings test does. The
            # `add_stock_at_location` RPC asserts company access against the CALLER, which a
            # service-role client carrying no user context cannot satisfy — and the RPC's own
            # behaviour is not what is under test here; the view's arithmetic over the rows is.
            supabase_admin.table("part_location_stock").insert(
                {
                    "company_id": company_id,
                    "part_id": part_id,
                    "location_id": place,
                    "quantity": quantity,
                }
            ).execute()
        return part_id

    yield {"company_id": company_id, "place": place, "add_part": add_part}

    supabase_admin.table("companies").delete().eq("id", company_id).execute()


def _rows(supabase_admin, company_id):
    return (
        supabase_admin.table("inventory_on_hand_cost")
        .select("*")
        .eq("company_id", company_id)
        .execute()
        .data
    )


def test_costs_at_the_highest_break_at_or_below_what_is_held(shop, supabase_admin):
    """The first arm: 50 held against breaks of 1/10/100 costs at the 10 break."""
    shop["add_part"]("bar", tiers=((1, 5.0), (10, 4.0), (100, 3.0)), quantity=50)
    row = _rows(supabase_admin, shop["company_id"])[0]

    assert float(row["cost_per_unit"]) == 4.0
    assert row["cost_below_min"] is False
    assert row["gap_reason"] is None
    assert float(row["on_hand_cost"]) == 200.0


def test_floors_to_the_lowest_break_when_held_below_it(shop, supabase_admin):
    """THE ARM THIS FILE EXISTS FOR.

    Hold 5 against a smallest break of 10. The part is still costable — at the 10 break — and is
    FLAGGED rather than reported as a gap. Stopping at the first arm would return NULL here, and
    every part a shop holds a handful of would show as having no cost on file.
    """
    shop["add_part"]("plate", tiers=((10, 4.0), (100, 3.0)), quantity=5)
    row = _rows(supabase_admin, shop["company_id"])[0]

    assert float(row["cost_per_unit"]) == 4.0, "below the smallest break must floor, not go NULL"
    assert row["cost_below_min"] is True, "and must say so, rather than pass as an ordinary price"
    assert row["gap_reason"] is None, "a floored price is a caveat, not a gap"
    assert float(row["on_hand_cost"]) == 20.0


def test_agrees_with_part_rollup_at_qty_for_every_bought_part(shop, supabase_admin):
    """Parity against the canonical function, at the quantity the view chooses its tier at.

    This is the check that catches drift if either implementation is edited alone.
    """
    shop["add_part"]("a", tiers=((1, 5.0), (10, 4.0)), quantity=50)
    shop["add_part"]("b", tiers=((10, 4.0),), quantity=5)   # floors
    shop["add_part"]("c", tiers=((1, 2.5),), quantity=3)

    for row in _rows(supabase_admin, shop["company_id"]):
        if row["source"] != "bought":
            continue
        canonical = supabase_admin.rpc(
            "part_rollup_at_qty",
            {
                "p_part_id": row["part_id"],
                "p_qty": row["part_total_quantity"],
                "p_apply_charge_basis": False,
            },
        ).execute().data
        assert float(row["cost_per_unit"]) == float(canonical), (
            f"view and part_rollup_at_qty disagree for {row['part_name']}"
        )


def test_a_bought_part_with_no_tier_is_a_named_gap_not_a_zero(shop, supabase_admin):
    shop["add_part"]("no-price", tiers=(), quantity=7)
    row = _rows(supabase_admin, shop["company_id"])[0]

    assert row["cost_per_unit"] is None, "a missing cost is NULL, never 0"
    assert row["on_hand_cost"] is None
    assert row["gap_reason"] == "no_cost_tier"


def test_a_made_part_is_a_different_gap_from_a_missing_tier(shop, supabase_admin):
    """`cost_per_unit` is NULL for a made part BY DESIGN — its cost is the routing rollup.

    Folding it into the same count as a missing tier would report a design decision as a
    data-quality problem about a field that does not exist for that part.
    """
    shop["add_part"]("assembly", source="made", tiers=(), quantity=4)
    row = _rows(supabase_admin, shop["company_id"])[0]

    assert row["gap_reason"] == "made"
    assert row["cost_per_unit"] is None


def test_the_tier_is_chosen_at_the_part_total_not_per_shelf(shop, supabase_admin):
    """One bar on two shelves shows ONE unit cost.

    Choosing per balance would price 30-on-a-shelf and 30-on-another at the 10 break while the
    shop holds 60 — two different unit costs for one bar, which reads as a bug and stops a
    filtered total being the sum of its rows.
    """
    part_id = shop["add_part"]("split", tiers=((1, 5.0), (50, 3.0)), quantity=30)
    second = (
        supabase_admin.table("inventory_locations")
        .insert({"company_id": shop["company_id"], "name": "Shelf B", "kind": "shelf"})
        .execute()
        .data[0]["id"]
    )
    supabase_admin.table("part_location_stock").insert(
        {
            "company_id": shop["company_id"],
            "part_id": part_id,
            "location_id": second,
            "quantity": 30,
        }
    ).execute()

    rows = _rows(supabase_admin, shop["company_id"])
    assert len(rows) == 2, "one row per balance — a part on two shelves is two rows"
    assert {float(r["cost_per_unit"]) for r in rows} == {3.0}, "60 held, so the 50 break applies to both"
    assert sum(float(r["on_hand_cost"]) for r in rows) == 180.0


def test_an_archived_part_is_not_stock_on_a_shelf(shop, supabase_admin):
    part_id = shop["add_part"]("gone", tiers=((1, 5.0),), quantity=10)
    supabase_admin.table("parts").update({"deleted_at": "now()"}).eq("id", part_id).execute()

    assert _rows(supabase_admin, shop["company_id"]) == []
