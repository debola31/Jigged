"""
Per-BOM-line charge basis: the rollup math and the no-op guarantees (#727).

A BOM line declares what its child contributes to the parent — our COST (default)
or the child's MARKED-UP PRICE. Two engine modes over one function body:

    compute_part_cost_at_qty         charge bases ignored  -> TRUE cost
    compute_part_charge_base_at_qty  charge bases honored  -> what a PRICE is built on

The rules this file pins down, each of which is easy to get subtly wrong and
impossible to notice afterwards because the failure mode is a quote that is
quietly a few percent off:

  * NO-OP. With every line at 'cost' the two modes agree, with or without a
    company default set. Nothing that exists today changes value.
  * NESTING. A 'cost' line contributes the child's CHARGE BASE, so a material
    markup declared deep in a tree survives the hop up — but is applied exactly
    ONCE, never re-applied at the made part above it.
  * BOUGHT-ONLY DEFAULT. companies.default_material_markup_percent covers a
    bought child with no tier. It never covers a made one; that stays a gap.
  * NO SILENT FALLBACK. A price line with no tier and no eligible default is
    un-priceable, not quietly costed.

The priceability agreement across those combinations lives in
`test_priceability_agreement.py`.

Run:
    cd api && pytest -m integration tests/integration/test_bom_charge_basis.py

Requires TEST_SUPABASE_URL + TEST_SUPABASE_SECRET_KEY (service role) — run
`supabase start` then `eval "$(supabase status -o env)"` and export them.
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from decimal import Decimal

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
class ChargeBasisEnv:
    """The worked example from the #727 plan, built for real.

    Company default 25%.
      BAR      bought, cost $10/ea, NO pricing tier
      BRACKET  made,   labor $30/unit, BOM = 1 x BAR on a PRICE line, no tier
      ASSEMBLY made,   labor $20/unit, own markup 40%, BOM = 1 x BRACKET
    """

    company_id: str
    bar_id: str
    bracket_id: str
    assembly_id: str
    asm_bom_id: str
    bracket_bom_id: str


def _num(v) -> Decimal | None:
    return None if v is None else Decimal(str(v))


def _cost(admin: Client, part_id: str, qty: float = 1) -> Decimal | None:
    res = admin.rpc(
        "compute_part_cost_at_qty", {"p_part_id": part_id, "p_qty": qty}
    ).execute()
    return _num(res.data)


def _charge_base(admin: Client, part_id: str, qty: float = 1) -> Decimal | None:
    res = admin.rpc(
        "compute_part_charge_base_at_qty", {"p_part_id": part_id, "p_qty": qty}
    ).execute()
    return _num(res.data)


def _price(admin: Client, part_id: str, qty: float = 1) -> dict | None:
    res = admin.rpc(
        "compute_part_price_explain_at_qty", {"p_part_id": part_id, "p_qty": qty}
    ).execute()
    rows = res.data or []
    return rows[0] if rows else None


def _set_default(admin: Client, company_id: str, markup: float | None) -> None:
    admin.table("companies").update(
        {"default_material_markup_percent": markup}
    ).eq("id", company_id).execute()


def _set_basis(admin: Client, bom_id: str, basis: str) -> None:
    admin.table("parts_bom").update({"charge_basis": basis}).eq("id", bom_id).execute()


@pytest.fixture
def env(admin: Client):
    suffix = uuid.uuid4().hex[:8]

    company = (
        admin.table("companies")
        .insert({"name": f"ChargeBasis-{suffix}", "default_material_markup_percent": 25})
        .execute()
    )
    company_id = company.data[0]["id"]

    wc = (
        admin.table("work_centers")
        .insert(
            {"company_id": company_id, "name": "Mill", "kind": "internal", "labor_rate": 60}
        )
        .execute()
    )
    wc_id = wc.data[0]["id"]

    def make_part(name: str, source: str) -> str:
        row = (
            admin.table("parts")
            .insert(
                {
                    "company_id": company_id,
                    "part_name": f"{name}-{suffix}",
                    "source": source,
                    "primary_unit": "ea",
                    "costing_batch_quantity": 1,
                }
            )
            .execute()
        )
        return row.data[0]["id"]

    def add_routing(part_id: str, cycle_minutes: int) -> None:
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
                # No setup: the lot size is 1, so setup would just add noise to
                # numbers whose whole point is being checkable by hand.
                "setup_minutes": 0,
                "cycle_minutes_per_unit": cycle_minutes,
            }
        ).execute()

    bar_id = make_part("BAR", "bought")
    admin.table("part_procurement_tiers").insert(
        {"part_id": bar_id, "min_quantity": 1, "cost_per_unit": 10}
    ).execute()

    bracket_id = make_part("BRACKET", "made")
    add_routing(bracket_id, 30)  # 30 min @ $60/hr = $30/unit
    bracket_bom = (
        admin.table("parts_bom")
        .insert(
            {
                "parent_part_id": bracket_id,
                "child_part_id": bar_id,
                "quantity": 1,
                "unit": "ea",
                "sequence": 10,
                "charge_basis": "price",
            }
        )
        .execute()
    )

    assembly_id = make_part("ASSEMBLY", "made")
    add_routing(assembly_id, 20)  # 20 min @ $60/hr = $20/unit
    admin.table("part_pricing_tiers").insert(
        {
            "part_id": assembly_id,
            "company_id": company_id,
            "sequence": 10,
            "quantity": 1,
            "markup_percent": 40,
        }
    ).execute()
    asm_bom = (
        admin.table("parts_bom")
        .insert(
            {
                "parent_part_id": assembly_id,
                "child_part_id": bracket_id,
                "quantity": 1,
                "unit": "ea",
                "sequence": 10,
                "charge_basis": "cost",
            }
        )
        .execute()
    )

    yield ChargeBasisEnv(
        company_id=company_id,
        bar_id=bar_id,
        bracket_id=bracket_id,
        assembly_id=assembly_id,
        asm_bom_id=asm_bom.data[0]["id"],
        bracket_bom_id=bracket_bom.data[0]["id"],
    )

    admin.table("parts_bom").delete().in_(
        "parent_part_id", [bracket_id, assembly_id]
    ).execute()
    admin.table("routings").delete().eq("company_id", company_id).execute()
    admin.table("part_pricing_tiers").delete().eq("company_id", company_id).execute()
    admin.table("part_procurement_tiers").delete().eq("part_id", bar_id).execute()
    admin.table("parts").delete().eq("company_id", company_id).execute()
    admin.table("work_centers").delete().eq("company_id", company_id).execute()
    admin.table("companies").delete().eq("id", company_id).execute()


# ── The two no-op guarantees ────────────────────────────────────────────────
# This is the money-path requirement: shipping the migration must not move a
# single existing number. Both halves matter — setting a shop-wide default is
# ALSO a no-op until some line opts in, which is what makes it safe to turn on
# before touching any BOM.


def test_all_cost_lines_no_default_is_a_no_op(admin: Client, env: ChargeBasisEnv):
    _set_default(admin, env.company_id, None)
    _set_basis(admin, env.bracket_bom_id, "cost")

    for part_id in (env.bar_id, env.bracket_id, env.assembly_id):
        for qty in (1, 10, 100):
            assert _cost(admin, part_id, qty) == _charge_base(admin, part_id, qty)


def test_default_alone_changes_nothing(admin: Client, env: ChargeBasisEnv):
    # A shop can set its default markup before touching a single BOM line and
    # nothing reprices. The default is only ever consulted on a 'price' line.
    _set_basis(admin, env.bracket_bom_id, "cost")
    _set_default(admin, env.company_id, None)
    before = {
        p: [_charge_base(admin, p, q) for q in (1, 10, 100)]
        for p in (env.bar_id, env.bracket_id, env.assembly_id)
    }

    _set_default(admin, env.company_id, 25)
    after = {
        p: [_charge_base(admin, p, q) for q in (1, 10, 100)]
        for p in (env.bar_id, env.bracket_id, env.assembly_id)
    }
    assert before == after


# ── The price rungs ─────────────────────────────────────────────────────────


def test_bought_child_with_no_tier_uses_the_company_default(
    admin: Client, env: ChargeBasisEnv
):
    priced = _price(admin, env.bar_id, 1)
    assert priced is not None
    assert _num(priced["unit_price"]) == Decimal("12.50")  # 10 x 1.25
    assert priced["rate_source"] == "company_default"
    assert _num(priced["markup_percent"]) == Decimal("25")


def test_own_tier_beats_the_company_default(admin: Client, env: ChargeBasisEnv):
    # Explicit beats default: give BAR a 10% tier and the shop-wide 25% steps aside.
    admin.table("part_pricing_tiers").insert(
        {
            "part_id": env.bar_id,
            "company_id": env.company_id,
            "sequence": 10,
            "quantity": 1,
            "markup_percent": 10,
        }
    ).execute()

    priced = _price(admin, env.bar_id, 1)
    assert priced is not None
    assert _num(priced["unit_price"]) == Decimal("11.00")
    assert priced["rate_source"] == "tier"
    assert _num(priced["markup_percent"]) == Decimal("10")


def test_no_tier_and_no_default_is_unpriceable_never_cost(
    admin: Client, env: ChargeBasisEnv
):
    _set_default(admin, env.company_id, None)

    # No rung applies, so the price resolver returns NO ROW at all — not the
    # cost, which is the silent fallback this rule exists to forbid.
    assert _price(admin, env.bar_id, 1) is None
    # And the gap propagates: BRACKET charges BAR at price, so BRACKET cannot be
    # costed either.
    assert _charge_base(admin, env.bracket_id, 1) is None
    # True cost is unaffected — it never consults a markup.
    assert _cost(admin, env.bracket_id, 1) == Decimal("40")


# ── The nesting rule, and no double-marking ─────────────────────────────────


def test_cost_line_carries_the_child_charge_base_exactly_once(
    admin: Client, env: ChargeBasisEnv
):
    # BRACKET: true 40 (30 labor + 10 bar), charge base 42.50 (30 + 10 x 1.25).
    assert _cost(admin, env.bracket_id, 1) == Decimal("40")
    assert _charge_base(admin, env.bracket_id, 1) == Decimal("42.50")

    # ASSEMBLY takes BRACKET at OUR COST — which means BRACKET's charge base, so
    # the material markup survives the hop. It is NOT re-marked: 62.50, not
    # 20 + 42.50 x 1.25. The default never applies to a made part.
    assert _charge_base(admin, env.assembly_id, 1) == Decimal("62.50")
    assert _cost(admin, env.assembly_id, 1) == Decimal("60")

    priced = _price(admin, env.assembly_id, 1)
    assert priced is not None
    assert _num(priced["unit_price"]) == Decimal("87.50")  # 62.50 x 1.40
    assert priced["rate_source"] == "tier"


def test_stacking_is_allowed_and_visible(admin: Client, env: ChargeBasisEnv):
    # BRACKET charged at price into ASSEMBLY, with its own 15% tier: material
    # 25% + bracket 15% + assembly 40% all compound, deliberately.
    admin.table("part_pricing_tiers").insert(
        {
            "part_id": env.bracket_id,
            "company_id": env.company_id,
            "sequence": 10,
            "quantity": 1,
            "markup_percent": 15,
        }
    ).execute()
    _set_basis(admin, env.asm_bom_id, "price")

    bracket_priced = _price(admin, env.bracket_id, 1)
    assert bracket_priced is not None
    assert _num(bracket_priced["unit_price"]) == Decimal("48.88")  # 42.50 x 1.15

    assert _charge_base(admin, env.assembly_id, 1) == Decimal("68.88")
    assert _num(_price(admin, env.assembly_id, 1)["unit_price"]) == Decimal("96.43")

    # True cost never moves, so the effective margin is computable and wider
    # than the part's own 40% — which is the point of showing it.
    assert _cost(admin, env.assembly_id, 1) == Decimal("60")


def test_default_never_covers_a_made_child(admin: Client, env: ChargeBasisEnv):
    # BRACKET charged at price with NO tier of its own. It is made, so the
    # shop-wide default does not apply and this stays a gap — marking up
    # in-house work is a deliberate decision that needs its own tier.
    _set_basis(admin, env.asm_bom_id, "price")
    assert _price(admin, env.bracket_id, 1) is None
    assert _charge_base(admin, env.assembly_id, 1) is None

    explain = admin.rpc(
        "compute_part_cost_explain", {"p_part_id": env.assembly_id, "p_qty": 1}
    ).execute().data[0]
    assert explain["is_priceable"] is False
    assert env.bracket_id in {g["part_id"] for g in explain["missing_markups"]}
