"""Process plans (moonshot/planning): checked against their parts, and their written steps tell the truth."""
import copy

import pytest

from moonshot.config import data_root
from moonshot.planning.steps import caption_names_only_facts, expand
from moonshot.planning.validate import PLANS, check, load_plan

PARTS = sorted(p.stem for p in PLANS.glob("*.json"))


def needs_step(part):
    step = data_root() / "parts" / part / "part.step"
    if not step.exists():
        pytest.skip(f"no STEP for {part} in the data root")
    return step


@pytest.mark.data_root
@pytest.mark.parametrize("part", PARTS)
def test_plan_matches_its_part_and_the_shop(part):
    needs_step(part)
    assert check(load_plan(part))["problems"] == []


@pytest.mark.data_root
def test_a_plan_claiming_a_hole_the_part_lacks_is_refused():
    needs_step("nist-ftc-10")
    plan = copy.deepcopy(load_plan("nist-ftc-10"))
    plan["setups"][0]["operations"][3]["features"][0]["count"] = 9           # the part has 8 Ø2.5 cross holes
    assert any("Ø2.5" in p for p in check(plan)["problems"])


@pytest.mark.data_root
def test_stock_that_doesnt_fit_the_machine_is_refused():
    needs_step("nist-ftc-10")
    plan = copy.deepcopy(load_plan("nist-ftc-10"))
    plan["stock"]["size_mm"] = [800.0, 150.0, 450.0]                        # nist-ctc-01's size
    assert any("travel" in p for p in check(plan)["problems"])


@pytest.mark.parametrize("part", PARTS)
def test_every_caption_names_only_its_facts(part):
    for s in expand(load_plan(part)):
        assert caption_names_only_facts(s), s["id"]


def test_a_caption_inventing_a_number_is_caught():
    bad = {"caption": "Tighten to 40 N m.", "facts": {"what": "tighten the vise"}}
    assert not caption_names_only_facts(bad)


@pytest.mark.parametrize("part", PARTS)
def test_steps_have_unique_ids_and_every_operation_has_a_cycle_step(part):
    plan, steps = load_plan(part), expand(load_plan(part))
    ids = [s["id"] for s in steps]
    assert len(ids) == len(set(ids))
    ops = {(s["id"], op["id"]) for s in plan["setups"] for op in s["operations"]}
    assert ops == {(s["setup"], s["operation"]) for s in steps if s["kind"] == "cycle"}
