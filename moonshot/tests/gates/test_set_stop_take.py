"""Set the stop (the first step of a setup whose part stands on the vise's floor, nist-ftc-10 op50: "...then set the
stop"), on the full body: the right hand takes the stop block from the table, pinched by its top, and stands it on the
vise's floor at the part's end, where the load take sets the part against it.

In the physics run the stop ends standing on the floor within the placement limits of where the load take expects it,
and upright; it is carried only in the hand, never dropped; and the take is a take record. Physics tier, on the take
the planner writes to the data root (takes/set-stop).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKE = data_root() / "takes" / "set-stop"


@pytest.fixture(scope="module")
def run():
    if not (TAKE / "reference.npz").exists():
        pytest.skip(f"no planned take at {TAKE}")
    from moonshot.sim.set_stop import SetStop
    r = SetStop(TAKE)
    r.run(log=None)
    return r


def test_the_stop_stands_where_the_load_expects_it(run):
    o = run.outcome()
    assert max(abs(v) for v in o["off_mm"]) < threshold("physics.placement_mm").value, o
    assert o["tilt_deg"] < threshold("physics.placement_deg").value, o


def test_the_stop_is_carried_and_not_dropped(run):
    o = run.outcome()
    assert o["lifted_mm"] > 20, "it came off the table"
    assert o["max_slip_mm"] < threshold("physics.grip_slip_mm").value, o


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(TAKE) == []
