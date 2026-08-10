"""
Single source of truth for "is this part ready to quote?".

The parts LIST uses the set-based RPC `get_priceable_part_ids`; the part DETAIL
page uses `compute_part_cost_explain(...).is_priceable`. They must never
disagree.

The rule (standard-costing model): a part is quotable iff its cost RESOLVES
(bought: procurement tier; made: every op priced and every BOM child costable)
AND the part ITSELF has a markup. A material's own markup is NOT required — the
parent marks up the rolled-up cost, so a child's markup is never used. (This
re-resolves the old #12 agreement, which had required a markup on every tree
node, in the correct direction.)

The tests use a made PARENT consuming a made SUB and assert:
  * child SUB lacking a markup does NOT block PARENT (both views: ready);
  * PARENT lacking a markup IS blocked, and only PARENT (the root) is flagged;
  * both views agree in every case.

Run:
    cd api && pytest -m integration tests/integration/test_priceability_agreement.py

Requires TEST_SUPABASE_URL + TEST_SUPABASE_SECRET_KEY (service role) — run
`supabase start` then `eval "$(supabase status -o env)"` and export them.
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from typing import Any

import pytest
from supabase import Client, create_client


pytestmark = pytest.mark.integration


@pytest.fixture(scope="module")
def admin() -> Client:
    url = os.getenv("TEST_SUPABASE_URL")
    key = os.getenv("TEST_SUPABASE_SECRET_KEY")
    if not url or not key:
        pytest.skip("Supabase admin credentials not configured")
    return create_client(url, key)


@dataclass
class PriceabilityEnv:
    company_id: str
    parent_id: str
    sub_id: str


def _make_part(admin: Client, company_id: str, name: str) -> str:
    row = (
        admin.table("parts")
        .insert(
            {
                "company_id": company_id,
                "part_name": name,
                "source": "made",
                "primary_unit": "ea",
            }
        )
        .execute()
    )
    return row.data[0]["id"]


def _add_priced_routing(admin: Client, company_id: str, part_id: str, wc_id: str) -> None:
    """Give a made part a one-op routing whose work center carries a labor rate,
    so the op is fully priced and the part's cost resolves."""
    routing = (
        admin.table("routings")
        .insert({"company_id": company_id, "part_id": part_id, "name": "R"})
        .execute()
    )
    admin.table("routing_operations").insert(
        {
            "routing_id": routing.data[0]["id"],
            "work_center_id": wc_id,
            "sequence": 10,
            "setup_minutes": 10,
            "cycle_minutes_per_unit": 1,
        }
    ).execute()


@pytest.fixture
def env(admin: Client):
    suffix = uuid.uuid4().hex[:8]

    company = (
        admin.table("companies").insert({"name": f"Priceability-{suffix}"}).execute()
    )
    company_id = company.data[0]["id"]

    # Internal work center with a labor rate → routing ops are fully priced.
    wc = (
        admin.table("work_centers")
        .insert(
            {"company_id": company_id, "name": "Mill", "kind": "internal", "labor_rate": 50}
        )
        .execute()
    )
    wc_id = wc.data[0]["id"]

    parent_id = _make_part(admin, company_id, f"PARENT-{suffix}")
    sub_id = _make_part(admin, company_id, f"SUB-{suffix}")
    _add_priced_routing(admin, company_id, parent_id, wc_id)
    _add_priced_routing(admin, company_id, sub_id, wc_id)

    # PARENT consumes one SUB.
    admin.table("parts_bom").insert(
        {
            "parent_part_id": parent_id,
            "child_part_id": sub_id,
            "quantity": 1,
            "unit": "ea",
            "sequence": 10,
        }
    ).execute()

    yield PriceabilityEnv(company_id, parent_id, sub_id)

    # FK-safe teardown (parts_bom / routing_operations cascade from parts/routings
    # in some paths, but delete explicitly so the test is self-contained).
    admin.table("parts_bom").delete().eq("parent_part_id", parent_id).execute()
    admin.table("routings").delete().eq("company_id", company_id).execute()
    admin.table("part_pricing_tiers").delete().eq("company_id", company_id).execute()
    admin.table("parts").delete().eq("company_id", company_id).execute()
    admin.table("work_centers").delete().eq("company_id", company_id).execute()
    admin.table("companies").delete().eq("id", company_id).execute()


def _apply_default(admin: Client, env: PriceabilityEnv, part_id: str) -> None:
    """Give a part a single pricing tier with a 25% markup. Each part now owns
    its markup directly on part_pricing_tiers — there is no shared markup-rate
    layer — so a filled markup is just a tier row with a non-null markup_percent."""
    admin.table("part_pricing_tiers").insert(
        {
            "part_id": part_id,
            "company_id": env.company_id,
            "sequence": 10,
            "quantity": 1,
            "markup_percent": 25,
        }
    ).execute()


def _list_priceable(admin: Client, company_id: str) -> set[str]:
    res = admin.rpc("get_priceable_part_ids", {"p_company_id": company_id}).execute()
    return set(res.data or [])


def _detail_explain(admin: Client, part_id: str) -> dict[str, Any]:
    res = admin.rpc(
        "compute_part_cost_explain", {"p_part_id": part_id, "p_qty": 1}
    ).execute()
    assert res.data, "compute_part_cost_explain returned no row"
    return res.data[0]


def test_child_markup_does_not_block_parent(admin: Client, env: PriceabilityEnv):
    # PARENT gets a markup; SUB (its made child) is deliberately left without
    # one. A material's markup is never used inside a parent (the parent marks
    # up the rolled-up cost), so this must NOT block quoting the parent.
    _apply_default(admin, env, env.parent_id)

    explain = _detail_explain(admin, env.parent_id)
    list_priceable = _list_priceable(admin, env.company_id)

    # The parent's cost resolves, and it IS ready — the child's missing markup
    # is irrelevant. Detail and list agree.
    assert explain["unit_cost"] is not None
    assert explain["is_priceable"] is True
    assert env.parent_id in list_priceable
    # No markup gaps flagged: only the root would be, and it has one.
    assert explain["missing_markups"] == []
    # SUB isn't sellable on its own (no markup), but that doesn't block PARENT.
    assert env.sub_id not in list_priceable


def test_root_without_markup_is_not_priceable(admin: Client, env: PriceabilityEnv):
    # Neither PARENT nor SUB has a markup. The part being QUOTED (parent) needs
    # one; its material (sub) does not.
    explain = _detail_explain(admin, env.parent_id)
    list_priceable = _list_priceable(admin, env.company_id)

    assert explain["unit_cost"] is not None  # cost still resolves
    assert explain["is_priceable"] is False  # parent itself has no markup
    assert env.parent_id not in list_priceable

    # Only the ROOT (parent) is flagged for markup — never the sub.
    missing_markup_ids = {g["part_id"] for g in explain["missing_markups"]}
    assert env.parent_id in missing_markup_ids
    assert env.sub_id not in missing_markup_ids


def test_list_and_detail_agree_when_everything_has_markup(admin: Client, env: PriceabilityEnv):
    # Give BOTH the parent and the sub-part a markup.
    _apply_default(admin, env, env.parent_id)
    _apply_default(admin, env, env.sub_id)

    explain = _detail_explain(admin, env.parent_id)
    list_priceable = _list_priceable(admin, env.company_id)

    # Ready on BOTH views (parent has a markup; the sub's is now irrelevant).
    assert explain["is_priceable"] is True
    assert explain["missing_markups"] == []
    assert env.parent_id in list_priceable


# ═══════════════════════════════════════════════════════════════════════════
# Charge basis (#727) re-opens the markup question for ONE edge at a time.
#
# "A material's markup is never used inside a parent" stopped being true the
# moment a BOM line could charge its child at PRICE — and the shop-wide default
# then makes it untrue in the other direction, because a bought child covered by
# the default needs no tier of its own. The rule both views must encode:
#
#     a price-basis child is satisfied  <=>  it has a markup tier
#                                            OR (it is bought AND the default is set)
#
# These four cases are the whole truth table. They fail loudly if the list RPC
# and the detail explain ever drift apart on it.
# ═══════════════════════════════════════════════════════════════════════════


def _charge_at_price(admin: Client, env: PriceabilityEnv) -> None:
    admin.table("parts_bom").update({"charge_basis": "price"}).eq(
        "parent_part_id", env.parent_id
    ).eq("child_part_id", env.sub_id).execute()


def _set_company_default(admin: Client, env: PriceabilityEnv, markup: float | None) -> None:
    admin.table("companies").update(
        {"default_material_markup_percent": markup}
    ).eq("id", env.company_id).execute()


def test_price_basis_child_without_markup_blocks_the_parent(
    admin: Client, env: PriceabilityEnv
):
    # PARENT is sellable, but it charges SUB at price and SUB has no markup —
    # there is no number to charge. Both views must say so, and both must name
    # SUB rather than leaving the user hunting.
    _apply_default(admin, env, env.parent_id)
    _charge_at_price(admin, env)

    explain = _detail_explain(admin, env.parent_id)
    list_priceable = _list_priceable(admin, env.company_id)

    assert explain["is_priceable"] is False
    assert env.sub_id in {g["part_id"] for g in explain["missing_markups"]}
    assert env.parent_id not in list_priceable


def test_price_basis_child_with_its_own_markup_is_satisfied(
    admin: Client, env: PriceabilityEnv
):
    _apply_default(admin, env, env.parent_id)
    _apply_default(admin, env, env.sub_id)
    _charge_at_price(admin, env)

    explain = _detail_explain(admin, env.parent_id)
    assert explain["is_priceable"] is True
    assert explain["missing_markups"] == []
    assert env.parent_id in _list_priceable(admin, env.company_id)


def test_company_default_does_not_cover_a_MADE_child(
    admin: Client, env: PriceabilityEnv
):
    # SUB is a made part. The shop-wide material markup is scoped to purchased
    # cost, so it must NOT rescue this — marking up in-house work is a decision,
    # not a default.
    _apply_default(admin, env, env.parent_id)
    _charge_at_price(admin, env)
    _set_company_default(admin, env, 25)

    explain = _detail_explain(admin, env.parent_id)
    assert explain["is_priceable"] is False
    assert env.sub_id in {g["part_id"] for g in explain["missing_markups"]}
    assert env.parent_id not in _list_priceable(admin, env.company_id)


def test_company_default_covers_a_BOUGHT_child_and_the_verdict_flips_back(
    admin: Client, env: PriceabilityEnv
):
    # Swap the price-basis child for a bought one with a procurement tier but no
    # pricing tier — the L&L case: purchased material, marked up shop-wide.
    suffix = uuid.uuid4().hex[:8]
    bought = (
        admin.table("parts")
        .insert(
            {
                "company_id": env.company_id,
                "part_name": f"BAR-{suffix}",
                "source": "bought",
                "primary_unit": "ea",
            }
        )
        .execute()
    )
    bought_id = bought.data[0]["id"]
    admin.table("part_procurement_tiers").insert(
        {"part_id": bought_id, "min_quantity": 1, "cost_per_unit": 10}
    ).execute()
    admin.table("parts_bom").update(
        {"child_part_id": bought_id, "charge_basis": "price"}
    ).eq("parent_part_id", env.parent_id).eq("child_part_id", env.sub_id).execute()
    _apply_default(admin, env, env.parent_id)

    try:
        # Default unset: no tier, no rung — blocked, and the bought child is named.
        _set_company_default(admin, env, None)
        explain = _detail_explain(admin, env.parent_id)
        assert explain["is_priceable"] is False
        assert bought_id in {g["part_id"] for g in explain["missing_markups"]}
        assert env.parent_id not in _list_priceable(admin, env.company_id)

        # Default set: covered, on both views, with no tier added anywhere. This
        # is the setup cliff the default exists to remove.
        _set_company_default(admin, env, 25)
        explain = _detail_explain(admin, env.parent_id)
        assert explain["is_priceable"] is True
        assert explain["missing_markups"] == []
        assert env.parent_id in _list_priceable(admin, env.company_id)

        # Cleared again: the verdict flips straight back, no stale state.
        _set_company_default(admin, env, None)
        assert _detail_explain(admin, env.parent_id)["is_priceable"] is False
        assert env.parent_id not in _list_priceable(admin, env.company_id)
    finally:
        admin.table("parts_bom").delete().eq("parent_part_id", env.parent_id).execute()
        admin.table("part_procurement_tiers").delete().eq("part_id", bought_id).execute()
        admin.table("parts").delete().eq("id", bought_id).execute()
