"""
Single source of truth for "is this part ready to quote?".

The parts LIST uses the set-based RPC `get_priceable_part_ids`; the part DETAIL
page uses `compute_part_cost_explain(...).is_priceable`. They must never
disagree — a part flagged Incomplete on the list must not read "ready" on its
detail page (the #12 FB CBD-ALT .025R bug: a made sub-part with no markup of its
own still let the parent compute a cost, so the detail page showed nothing to
fix while the list correctly flagged it).

This test builds the minimal reproduction — a made PARENT whose made sub-part
SUB has a resolvable cost but no markup — and asserts:

  * the parent's cost DOES resolve (unit_cost is not None), yet
  * BOTH views agree it is NOT ready (SUB needs a markup), and
  * once SUB gets a markup, BOTH views agree it IS ready.

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
    default_rate_id: str


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

    # The companies AFTER INSERT trigger seeds a "Default" markup rate
    # (is_default=true) — grab its id to apply below.
    default_rate = (
        admin.table("markup_rates")
        .select("id")
        .eq("company_id", company_id)
        .eq("is_default", True)
        .single()
        .execute()
    )
    default_rate_id = default_rate.data["id"]

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

    yield PriceabilityEnv(company_id, parent_id, sub_id, default_rate_id)

    # FK-safe teardown (parts_bom / routing_operations cascade from parts/routings
    # in some paths, but delete explicitly so the test is self-contained).
    admin.table("parts_bom").delete().eq("parent_part_id", parent_id).execute()
    admin.table("routings").delete().eq("company_id", company_id).execute()
    admin.table("part_pricing_tiers").delete().eq("company_id", company_id).execute()
    admin.table("parts").delete().eq("company_id", company_id).execute()
    admin.table("work_centers").delete().eq("company_id", company_id).execute()
    admin.table("markup_rates").delete().eq("company_id", company_id).execute()
    admin.table("companies").delete().eq("id", company_id).execute()


def _apply_default(admin: Client, env: PriceabilityEnv, part_id: str) -> None:
    admin.rpc(
        "bulk_apply_markup_rate",
        {
            "p_company_id": env.company_id,
            "p_part_ids": [part_id],
            "p_rate_id": env.default_rate_id,
        },
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


def test_list_and_detail_agree_when_subpart_lacks_markup(admin: Client, env: PriceabilityEnv):
    # PARENT gets the Default markup; SUB is deliberately left without one —
    # the exact #12 shape.
    _apply_default(admin, env, env.parent_id)

    explain = _detail_explain(admin, env.parent_id)
    list_priceable = _list_priceable(admin, env.company_id)

    # The parent's cost resolves — this is why the OLD detail page (unit_cost
    # != null) wrongly said "ready".
    assert explain["unit_cost"] is not None

    # But it is NOT ready: SUB has no markup. Detail and list must agree.
    assert explain["is_priceable"] is False
    assert env.parent_id not in list_priceable

    # And the detail explainer names the offending sub-part so the UI can link it.
    missing_markup_ids = {g["part_id"] for g in explain["missing_markups"]}
    assert env.sub_id in missing_markup_ids


def test_list_and_detail_agree_when_everything_has_markup(admin: Client, env: PriceabilityEnv):
    # Give BOTH the parent and the sub-part the Default markup.
    _apply_default(admin, env, env.parent_id)
    _apply_default(admin, env, env.sub_id)

    explain = _detail_explain(admin, env.parent_id)
    list_priceable = _list_priceable(admin, env.company_id)

    # Now ready on BOTH views.
    assert explain["is_priceable"] is True
    assert explain["missing_markups"] == []
    assert env.parent_id in list_priceable
