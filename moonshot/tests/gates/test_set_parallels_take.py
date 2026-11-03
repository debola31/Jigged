"""Set the parallels (every VF-2 setup's first step, "...then set the parallels"), on the full body: the right hand
takes each parallel from its rack, pinched by its top edge, and stands it on the vise's seat where the load take
expects it.

In the physics run each parallel ends standing on the seat within the placement limits of where the load take puts
it, and upright; it is carried only in the hand, never dropped; and the take is a take record. Physics tier, on the
take the planner writes to the data root (takes/set-parallels).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKE = data_root() / "takes" / "set-parallels"


@pytest.fixture(scope="module")
def run():
    if not (TAKE / "reference.npz").exists():
        pytest.skip(f"no planned take at {TAKE}")
    from moonshot.sim.set_parallels import SetParallels
    r = SetParallels(TAKE)
    r.run(log=None)
    return r


@pytest.mark.parametrize("name", ["para_a", "para_b"])
def test_each_parallel_stands_where_the_load_expects_it(run, name):
    o = run.outcome()[name]
    assert max(abs(v) for v in o["off_mm"]) < threshold("physics.placement_mm").value, o
    assert o["tilt_deg"] < threshold("physics.placement_deg").value, o


@pytest.mark.parametrize("name", ["para_a", "para_b"])
def test_each_parallel_is_carried_and_not_dropped(run, name):
    o = run.outcome()[name]
    assert o["lifted_mm"] > 20, "it came out of the rack"
    assert o["max_slip_mm"] < threshold("physics.grip_slip_mm").value, o


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(TAKE) == []
