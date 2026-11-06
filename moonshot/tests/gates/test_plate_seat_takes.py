"""Clamp the plate down (each plate setup's "Set <n> step clamps on its margin and tighten each nut"), on the full
body: each step clamp, parked across the table off the plate's end, swung by its end's hand onto the plate's margin
and its heel block; a long plate's in two takes, one per end (moonshot/planning/takes.py seat_takes), each held to it
all for the clamps it sets.

In the physics run each clamp ends on its stud in its clamped pose, within the placement limits, and lying flat; it is
carried only in the hand and never dropped; the plate isn't moved; and the take is a take record. Physics tier, on
the takes the planner writes to the data root (moonshot/motion/plate_seat.py).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.planning.takes import plate_take, seat_takes

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = [plate_take(part, "op10", t) for part in ("nist-ftc-09", "ll-1005337") for t in seat_takes(part)]


def strap(name: str) -> bool:
    """Is an outcome's entry a clamp's strap (clamp_<i>), not its nut's (clamp_<i>_nut)?"""
    return name.startswith("clamp_") and not name.endswith("_nut")


@pytest.fixture(scope="module", params=TAKES)
def run(request):
    folder = data_root() / "takes" / request.param
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    from moonshot.sim.plate_clamps import PlateClamps
    r = PlateClamps(folder)
    r.run(log=None)
    return r


def test_each_clamp_lands_in_its_clamped_pose(run):
    for name, o in run.outcome().items():
        if not strap(name):
            continue
        assert max(abs(v) for v in o["off_mm"]) < threshold("physics.placement_mm").value, (name, o)
        assert abs(o["yaw_off_deg"]) < threshold("physics.placement_deg").value, (name, o)
        assert o["tilt_deg"] < threshold("physics.placement_deg").value, (name, o)


def test_each_clamp_is_carried_and_not_dropped(run):
    for name, o in run.outcome().items():
        if strap(name):
            assert o["max_slip_mm"] < threshold("physics.grip_slip_mm").value, (name, o)


def test_the_plate_isnt_moved(run):
    assert max(abs(v) for v in run.outcome()["plate_off_mm"]) < threshold("physics.placement_mm").value


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(run.folder) == []
