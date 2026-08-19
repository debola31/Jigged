"""`part_location_stock` holds only real holdings — issue #657.

WHAT THIS GUARDS. Since 20260802144310 a row in this table means *the part is here*: emptying a
bin deletes its row, and `CHECK (quantity > 0)` makes that structural rather than conventional.
Most of that invariant defends itself — a producer that tries to store a zero now raises.

One thing does NOT defend itself, and it is the reason this file exists.

ORIGINALLY the hazard was an UPDATE. `trg_auto_track_stocked_part` was
`AFTER INSERT OR UPDATE OF is_stocked`, and `updatePart` sent `is_stocked` on every save — so the
body re-ran when someone merely renamed a part, re-inserting `NEW.quantity` at Unassigned on top
of stock already sitting on a real shelf. Measured while writing that migration: a no-op
`UPDATE parts SET is_stocked = is_stocked` took a part from 580 to 1160. It wrote no
`inventory_transactions` row, so it was invisible in the ledger and unrecoverable from it.

THAT SCENARIO IS NOW UNREPRESENTABLE, and the tests below changed shape for that reason rather
than because the risk went away. Dropping `parts.is_stocked` took the column the trigger keyed on
with it, so the replacement — `trg_seed_new_part_balance` — is `AFTER INSERT` only and no part
save can re-enter it. What survives is the seeding path itself: an INSERT still parks an opening
quantity at Unassigned, and it still must not do so when the part already holds stock, nor when it
holds nothing. The `NOT EXISTS` guard that stopped the doubling is deliberately kept in the new
function for exactly that case, so this file remains its regression pin.

No constraint catches a doubling, because both the row and the rollup stay internally consistent —
they are just consistently wrong.

Requires a local Supabase with all migrations applied. Skipped without it.
"""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.integration


@pytest.fixture
def shop(supabase_admin):
    """A company with a system bucket, a real shelf, and one part holding stock on the shelf."""
    company_id = str(uuid.uuid4())
    supabase_admin.table("companies").insert(
        {"id": company_id, "name": f"Residue Test {company_id[:8]}"}
    ).execute()

    # The system bucket is what `resolveFallbackPlace` needs and what the seeding trigger uses.
    unassigned = supabase_admin.rpc(
        "inv_get_or_create_unassigned", {"p_company_id": company_id}
    ).execute().data
    shelf = supabase_admin.table("inventory_locations").insert(
        {"company_id": company_id, "name": "Shelf A", "kind": "shelf"}
    ).execute().data[0]["id"]

    # Created at 0 so the trigger seeds nothing, then placed on the shelf explicitly — which is
    # the shape that made the doubling visible: stock on a real shelf, no row at Unassigned.
    part = supabase_admin.table("parts").insert(
        {
            "company_id": company_id,
            "part_name": f"RESIDUE-{company_id[:8]}",
            "source": "bought",
            "primary_unit": "each",
            "quantity": 0,
        }
    ).execute().data[0]["id"]

    supabase_admin.table("part_location_stock").insert(
        {"company_id": company_id, "part_id": part, "location_id": shelf, "quantity": 580}
    ).execute()

    yield {"company": company_id, "part": part, "shelf": shelf, "unassigned": unassigned}

    supabase_admin.table("companies").delete().eq("id", company_id).execute()


def _on_hand(supabase_admin, part_id: str) -> float:
    rows = (
        supabase_admin.table("part_location_stock")
        .select("quantity")
        .eq("part_id", part_id)
        .execute()
        .data
    )
    return sum(float(r["quantity"]) for r in rows)


def _rollup(supabase_admin, part_id: str) -> float:
    return float(
        supabase_admin.table("parts").select("quantity").eq("id", part_id).single().execute().data[
            "quantity"
        ]
    )


class TestSeedingAnOpeningBalanceDoesNotDoubleStock:
    """The 580 -> 1160 regression, pinned on the path that can still reach it."""

    def test_an_ordinary_part_save_leaves_the_balance_alone(self, supabase_admin, shop):
        """The direct descendant of `test_touching_is_stocked_leaves_the_balance_alone`.

        That test updated `is_stocked` because that was the column the trigger keyed on. There is
        no such column now, so this sends the plainest possible save — a rename — and asserts the
        same thing: an UPDATE to `parts` must not move stock. With the trigger `AFTER INSERT` only
        that is structural rather than defended, which is the improvement worth pinning.
        """
        assert _on_hand(supabase_admin, shop["part"]) == 580

        supabase_admin.table("parts").update(
            {"part_name": f"RENAMED-{shop['company'][:8]}"}
        ).eq("id", shop["part"]).execute()

        assert _on_hand(supabase_admin, shop["part"]) == 580, (
            "an ordinary part save re-inserted the part's quantity at Unassigned on top of the "
            "stock already on its shelf"
        )
        assert _rollup(supabase_admin, shop["part"]) == 580

    def test_it_does_not_mint_a_row_at_unassigned(self, supabase_admin, shop):
        supabase_admin.table("parts").update(
            {"part_name": f"RENAMED2-{shop['company'][:8]}"}
        ).eq("id", shop["part"]).execute()

        rows = (
            supabase_admin.table("part_location_stock")
            .select("location_id")
            .eq("part_id", shop["part"])
            .execute()
            .data
        )
        assert [r["location_id"] for r in rows] == [shop["shelf"]]

    def test_a_part_created_at_zero_stays_row_less(self, supabase_admin, shop):
        """No row is not a broken state — it is how "this part is nowhere" is represented.

        This is also the common case now that every part is stockable: parts are created at 0 and
        receive stock later. Seeding a zero row would violate the table's own
        `CHECK (quantity > 0)`, so the trigger's early return is load-bearing.

        The count sheet reaches such a part through `resolveFallbackPlace`, which reads the
        company's system bucket from the LOCATIONS list, so it needs no balance row to offer an
        opening count.
        """
        empty = supabase_admin.table("parts").insert(
            {
                "company_id": shop["company"],
                "part_name": f"NOWHERE-{shop['company'][:8]}",
                "source": "bought",
                "primary_unit": "each",
                "quantity": 0,
            }
        ).execute().data[0]["id"]

        assert _on_hand(supabase_admin, empty) == 0
        rows = (
            supabase_admin.table("part_location_stock")
            .select("id")
            .eq("part_id", empty)
            .execute()
            .data
        )
        assert rows == [], "a part with nothing anywhere should carry no balance row at all"

    def test_a_part_created_with_stock_is_parked_at_unassigned(self, supabase_admin, shop):
        """The other half of the trigger, which nothing else in this file covered.

        An INSERT carrying a non-zero quantity is legal — `enforce_tracked_part_quantity` is
        BEFORE UPDATE only — and it is how the CSV importer and service-role scripts create a part
        that already holds stock. Exactly one row, at the system bucket, matching the rollup.
        """
        stocked = supabase_admin.table("parts").insert(
            {
                "company_id": shop["company"],
                "part_name": f"OPENING-{shop['company'][:8]}",
                "source": "bought",
                "primary_unit": "each",
                "quantity": 42,
            }
        ).execute().data[0]["id"]

        rows = (
            supabase_admin.table("part_location_stock")
            .select("location_id, quantity")
            .eq("part_id", stocked)
            .execute()
            .data
        )
        assert len(rows) == 1
        assert rows[0]["location_id"] == shop["unassigned"]
        assert float(rows[0]["quantity"]) == 42
        assert _rollup(supabase_admin, stocked) == 42


class TestTheTableRefusesAZero:
    """The constraint that makes the rest of it structural rather than conventional."""

    def test_a_direct_zero_write_raises(self, supabase_admin, shop):
        with pytest.raises(Exception) as exc:
            supabase_admin.table("part_location_stock").update({"quantity": 0}).eq(
                "part_id", shop["part"]
            ).execute()
        assert "quantity_positive" in str(exc.value)

    def test_a_direct_zero_insert_raises(self, supabase_admin, shop):
        with pytest.raises(Exception) as exc:
            supabase_admin.table("part_location_stock").insert(
                {
                    "company_id": shop["company"],
                    "part_id": shop["part"],
                    "location_id": shop["unassigned"],
                    "quantity": 0,
                }
            ).execute()
        assert "quantity_positive" in str(exc.value)


def test_the_seeded_database_carries_no_residue(supabase_admin):
    """Total, and cheap: after `db reset` there must be no zero row anywhere.

    The seed is itself a producer — `pg_temp.deplete_job` consumed material with
    `greatest(0, quantity - used)` and drove four parts straight to zero — so this also pins that
    the seed was migrated along with the RPCs rather than left behind the constraint.
    """
    rows = (
        supabase_admin.table("part_location_stock").select("id").lte("quantity", 0).execute().data
    )
    assert rows == []
