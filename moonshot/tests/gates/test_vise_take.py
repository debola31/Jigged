"""The new core's vise take, verb by verb, on the full body (plan §5.4, step 1, stage 2), meets the outcomes trainual's
accepted take met. That take itself stopped being the bar on 2026-11-01's review: it bends the wrist past its
ellipse and grips the crank round the lever's joint (docs/moonshot/physics.md). The take run here is the one the
ported planner writes to the data root (takes/setup-take), and nist-ftc-10's first setup (takes/nist-ftc-10-op10).
Physics tier: farm and hub only (`pytest moonshot -m farm`).

Known gap, not asserted here: free-motion wrist lag still exceeds the tracking-lag threshold at a few moments
(the fast lift to inspect, the departure from the crank); see the checklist.
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.thresholds import threshold
from moonshot.world import vise as V

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
# the reference load, and nist-ftc-10's first setup: its stock, 1.4 kg and 165 mm long, on 1 in parallels
TAKES = {"reference": data_root() / "takes" / "setup-take", "nist-ftc-10-op10": data_root() / "takes" / "nist-ftc-10-op10"}


@pytest.fixture(scope="module", params=sorted(TAKES))
def report(request):
    take = TAKES[request.param]
    if not (take / "reference.npz").exists():
        pytest.skip(f"no planned take at {take}")
    from moonshot.sim.vise_take import SKIN_MU, ViseTake
    run = ViseTake(take)
    rep = run.run(log=lambda *a: None)
    rep["_slip_force_per_side"] = run.load.mass_kg * 9.81 / (2 * SKIN_MU)
    rep["_load"] = run.load
    return rep


def test_grab_lifts_the_blank_by_friction_with_a_human_grip(report):
    g = report["grab_hold"]
    assert g["lifted_by_friction"]
    lo, hi = threshold("physics.grip_safety_margin").band
    for side in ("grip_N_thumb_median", "grip_N_fingers_median"):
        assert lo <= g[side] / report["_slip_force_per_side"] <= hi, f"{side} = {g[side]} N"


def test_hold_doesnt_slip(report):
    assert report["grab_hold"]["max_slip_mm"] < threshold("physics.grip_slip_mm").value


def test_place_sets_it_down_where_planned_and_flat(report):
    p = report["place"]
    assert max(abs(x) for x in p["set_down_vs_planned_mm"]) < threshold("physics.placement_mm").value
    assert p["tilt_deg"] < threshold("physics.placement_deg").value


def test_slide_seats_it_against_the_fixed_jaw(report):
    assert abs(report["slide"]["gap_to_fixed_jaw_after_mm"]) < threshold("physics.placement_mm").value


def test_push_reaches_its_force(report):
    p = report["push"]
    assert abs(p["press_N_median"] - p["target_N"]) <= threshold("physics.force_target_frac").value * p["target_N"]


def test_rotate_closes_the_vise_by_the_screws_ratio(report):
    r = report["rotate"]
    load = report["_load"]
    travel = r["turns"] * V.VISE["lead"]
    assert abs((load.opening0 - r["opening_final_mm"]) - travel) < threshold("physics.mechanism_ratio_mm").value
    assert r["opening_final_mm"] < load.size_mm[1], "the jaw must close onto the part"
    assert r["clamp_N_final"] > 1000, "a final pull clamps the part firmly"


def test_measure_finds_both_parallels_pinched(report):
    for m in report["measure"]:
        assert abs(m["press_N_median"] - 3.0) <= threshold("physics.force_target_frac").value * 3.0, m
        assert m["parallel_moved_mm"] < threshold("physics.parallel_pinched_mm").value, m


def test_fingers_dont_pass_through_solids(report):
    assert report["max_contact_depth_mm"] < threshold("physics.collision_penetration_mm").value
