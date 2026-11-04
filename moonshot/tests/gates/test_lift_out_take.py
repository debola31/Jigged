"""The unload's last take, on the full body: the part lifted out of the loosened vise (a vise take started in the vise,
moonshot/motion/setup_take.py build_lift_out) and set on the table, for each of nist-ftc-10's setups. Held to the vise
take's grab: lifted by friction with a human grip, held without slipping, and no finger through a solid
(test_vise_take.py). Where on the table it is set down isn't held to the vise's placement: nothing is set against it.

Physics tier, on the takes the planner writes to the data root (takes/lift-out-nist-ftc-10-opNN).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.thresholds import threshold

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = {s: data_root() / "takes" / f"lift-out-nist-ftc-10-{s}" for s in ("op10", "op20", "op30", "op40", "op50")}


@pytest.fixture(scope="module", params=sorted(TAKES))
def report(request):
    take = TAKES[request.param]
    if not (take / "reference.npz").exists():
        pytest.skip(f"no planned take at {take}")
    from moonshot.sim.vise_take import SKIN_MU, ViseTake
    run = ViseTake(take)
    assert run.in_vise, "a lift-out starts with the part in the vise"
    rep = run.run(log=lambda *a: None)
    rep["_slip_force_per_side"] = run.load.mass_kg * 9.81 / (2 * SKIN_MU)
    return rep


def test_lifts_the_part_out_by_friction_with_a_human_grip(report):
    g = report["grab_hold"]
    assert g["lifted_by_friction"]
    lo, hi = threshold("physics.grip_safety_margin").band
    for side in ("grip_N_thumb_median", "grip_N_fingers_median"):
        assert lo <= g[side] / report["_slip_force_per_side"] <= hi, f"{side} = {g[side]} N"


def test_carrying_it_doesnt_slip(report):
    assert report["grab_hold"]["max_slip_mm"] < threshold("physics.grip_slip_mm").value


def test_fingers_dont_pass_through_solids(report):
    assert report["max_contact_depth_mm"] < threshold("physics.collision_penetration_mm").value
