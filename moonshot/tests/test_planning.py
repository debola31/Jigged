"""Process plans (moonshot/planning): checked against their parts, and their written steps tell the truth."""
import copy

import pytest

from moonshot.config import data_root
from moonshot.planning.steps import caption_names_only_facts, expand
from moonshot.planning.takes import spans
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


@pytest.mark.data_root
def test_stock_short_along_one_axis_is_refused():
    needs_step("ll-1007223")
    plan = copy.deepcopy(load_plan("ll-1007223"))
    plan["stock"]["size_mm"] = [57.15, 44.45, 70.0]                         # the part is 75 long in z
    assert any("doesn't contain" in p for p in check(plan)["problems"])


@pytest.mark.data_root
def test_stock_wider_than_the_vise_opens_is_refused():
    needs_step("ll-1007223")
    plan = copy.deepcopy(load_plan("ll-1007223"))
    plan["stock"]["size_mm"][0] = 120.0                    # across the jaws in Op 10; the 6 in vise opens 101.6 mm
    assert any("across the jaws" in p for p in check(plan)["problems"])


@pytest.mark.data_root
def test_a_bar_bigger_than_the_saw_is_refused():
    needs_step("ll-1007223")
    plan = copy.deepcopy(load_plan("ll-1007223"))
    plan["stock"]["bar_mm"] = [150.0, 450.0]               # nist-ctc-01's section; the saw takes 9 x 16 in
    assert any("bandsaw" in p for p in check(plan)["problems"])


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
    machine_only = [s for s in steps if s["kind"] == "cycle"]
    assert ops == {(s["setup"], s["operation"]) for s in machine_only if "setup" in s}
    assert all(s["station"] == "outside" for s in machine_only if "setup" not in s)     # a vendor's process


@pytest.mark.parametrize("part", PARTS)
def test_outside_processes_are_machine_only_and_sent_by_a_person(part):
    """A vendor's plating or coating is machine-only; the person's part of it, sending it out, is a step of its own."""
    finish = load_plan(part).get("finish", [])
    for i, f in enumerate(finish):
        if f["station"] == "outside" and f.get("machine_only"):
            assert i and finish[i - 1]["station"] == "outside" and not finish[i - 1].get("machine_only"), f["id"]


VF2_SHARED = {"blow-off", "set-parallels", "set-stop", "door-close", "cycle-start", "door-open", "loosen"}


@pytest.mark.parametrize("part", PARTS)
def test_every_step_has_takes_and_no_other_mill_borrows_the_vf2s(part):
    """The VF-2 cell's shared takes (its doors, its vise's blow-off) can't stand in for another machine's."""
    for s in expand(load_plan(part)):
        takes = [t for t, _, _ in spans(part, s)]
        assert takes, s["id"]
        if s.get("machine", "vf2") != "vf2":
            assert not VF2_SHARED & set(takes), s["id"]
