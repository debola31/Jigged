"""Lift the plate off (a plate setup's unload when its plate doesn't stay clamped: lift-off-plate), on the full body:
the wrench breaks each nut loose and runs it back up its stud, each clamp is slid back off the plate to park, and
both hands carry the plate up and out.

In the physics run each nut is run back up to park; each clamp ends parked, within the placement limits; the plate
is carried out in both hands, level, where its planned path ends; neither the clamps, the wrench nor the plate is
dropped from a hand; and the take is a take record. Physics tier, on the takes the planner writes to the data root
(moonshot/motion/plate_lift_off.py).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.planning.takes import PLATE_UNLOAD, plate_take
from moonshot.world import spoilboard as SB

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = [plate_take("ll-1005337", "op20", PLATE_UNLOAD[1]), plate_take("nist-ftc-09", "op10", PLATE_UNLOAD[1])]
NUT_MM = 0.5                 # a nut run up to park this close to its parked height
CARRIED_MM = 15.0            # the plate in the hands this close to where its planned path ends


@pytest.fixture(scope="module", params=TAKES)
def run(request):
    folder = data_root() / "takes" / request.param
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    from moonshot.sim.plate_lift_off import PlateLiftOff
    r = PlateLiftOff(folder)
    r.run(log=None)
    return r


def test_each_nut_is_run_back_up(run):
    o = run.outcome()
    for c in run.clamps:
        n = o[f"{c.name}_nut"]
        assert abs(n["over_strap_mm"] - SB.PARK_NUT_GAP_MM) < NUT_MM + 0.3, (c.name, n)


def test_each_clamp_ends_parked(run):
    o = run.outcome()
    for c in run.clamps:
        assert max(abs(v) for v in o[c.name]["parked_off_mm"]) < threshold("physics.placement_mm").value, (c.name,
                                                                                                          o[c.name])
        assert abs(o[c.name]["parked_tilt_off_deg"]) < threshold("physics.placement_deg").value, (c.name, o[c.name])


def test_the_plate_is_carried_out_level(run):
    o = run.outcome()
    assert max(abs(v) for v in o["plate_end_off_mm"]) < CARRIED_MM, o["plate_end_off_mm"]
    assert o["plate_lifted_mm"] > 50.0
    assert o["plate_tilt_deg"] < 3.0


def test_nothing_is_dropped(run):
    for c in run.clamps:
        assert run.outcome()[c.name]["max_slip_mm"] < threshold("physics.grip_slip_mm").value


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(run.folder) == []
