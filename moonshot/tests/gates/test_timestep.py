"""Stable, not lucky (plan §5.1, §5.4 step 4): the vise take run at half the timestep gives the same per-verb outcomes.
Each outcome may change by less than its own threshold, and every pass/fail outcome comes out the same, whether or
not the take passes it. The physics is unchanged (moonshot/sim/vise_take.py); only the model's timestep is halved.

Physics tier: farm and hub only, on the take the planner writes to the data root. Protected (plan §6, rule 1)."""
import pytest

from moonshot.config import data_root
from moonshot.contracts.thresholds import threshold
from moonshot.world import vise as V

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKE = data_root() / "takes" / "setup-take"


@pytest.fixture(scope="module")
def runs():
    if not (TAKE / "reference.npz").exists():
        pytest.skip(f"no planned take at {TAKE}")
    from moonshot.sim.vise_take import ViseTake
    out = []
    for dt in (None, 0.5):
        vt = ViseTake(TAKE)
        if dt:
            vt.model.opt.timestep *= dt
        out.append(vt.run(log=lambda *a: None))
    return out


def t(name):
    return threshold(name).value


def test_the_grab_lifts_and_holds_alike(runs):
    a, b = (r["grab_hold"] for r in runs)
    assert a["lifted_by_friction"] == b["lifted_by_friction"]
    slip_force = V.BLANK_KG * 9.81 / (2 * 0.6)
    lo, hi = threshold("physics.grip_safety_margin").band
    for side in ("grip_N_thumb_median", "grip_N_fingers_median"):
        assert abs(a[side] - b[side]) / slip_force < hi - lo, (side, a[side], b[side])
    assert abs(a["max_slip_mm"] - b["max_slip_mm"]) < t("physics.grip_slip_mm"), (a, b)
    assert (a["max_slip_mm"] < t("physics.grip_slip_mm")) == (b["max_slip_mm"] < t("physics.grip_slip_mm"))


def test_the_place_and_slide_land_alike(runs):
    a, b = runs
    for x, y in zip(a["place"]["set_down_vs_planned_mm"], b["place"]["set_down_vs_planned_mm"]):
        assert abs(x - y) < t("physics.placement_mm"), (a["place"], b["place"])
    assert abs(a["place"]["tilt_deg"] - b["place"]["tilt_deg"]) < t("physics.placement_deg")
    gap = (a["slide"]["gap_to_fixed_jaw_after_mm"], b["slide"]["gap_to_fixed_jaw_after_mm"])
    assert abs(gap[0] - gap[1]) < t("physics.placement_mm"), gap


def test_the_push_reaches_the_same_force(runs):
    a, b = (r["push"] for r in runs)
    assert abs(a["press_N_median"] - b["press_N_median"]) <= t("physics.force_target_frac") * a["target_N"], (a, b)


def test_the_crank_closes_the_vise_alike(runs):
    a, b = (r["rotate"] for r in runs)
    tol = t("physics.mechanism_ratio_mm")
    assert abs(a["turns"] - b["turns"]) * V.VISE["lead"] < tol, (a, b)
    assert abs(a["opening_final_mm"] - b["opening_final_mm"]) < tol, (a, b)
    assert (a["clamp_N_final"] > 1000) == (b["clamp_N_final"] > 1000), (a, b)


def test_the_parallels_are_found_alike(runs):
    pinched = t("physics.parallel_pinched_mm")
    for a, b in zip(runs[0]["measure"], runs[1]["measure"]):
        assert abs(a["press_N_median"] - b["press_N_median"]) <= t("physics.force_target_frac") * 3.0, (a, b)
        assert abs(a["parallel_moved_mm"] - b["parallel_moved_mm"]) < pinched, (a, b)
        assert (a["parallel_moved_mm"] < pinched) == (b["parallel_moved_mm"] < pinched), (a, b)


def test_the_fingers_go_no_deeper(runs):
    a, b = (r["max_contact_depth_mm"] for r in runs)
    limit = t("physics.collision_penetration_mm")
    assert abs(a - b) < limit and (a < limit) == (b < limit), (a, b)
