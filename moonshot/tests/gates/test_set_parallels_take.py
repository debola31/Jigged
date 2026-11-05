"""Set the parallels (every VF-2 setup's first step, "...then set the parallels"), on the full body: the right hand
takes each parallel from its rack, pinched by its top edge, and stands it on the vise's seat where the load take
expects it.

In the physics run each parallel ends standing on the seat within the placement limits of where the load take puts
it, and upright; it is carried only in the hand, never dropped; and the take is a take record. Physics tier, on the
takes the planner writes to the data root: the shared takes/set-parallels nist-ftc-10 plays (the reference load's),
and every other part's setups' own runs, each its load's parallels with its part waiting on the table
(takes/<part>-<setup>-set-parallels, moonshot/planning/takes.py per_setup), which also pass every per-frame check
(moonshot/validate/take.py).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.planning.takes import played

pytestmark = [pytest.mark.farm, pytest.mark.data_root]


@pytest.fixture(scope="module", params=played("set-parallels"))
def run(request):
    folder = data_root() / "takes" / request.param
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    from moonshot.sim.set_parallels import SetParallels
    r = SetParallels(folder)
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
    assert check(run.folder) == []


def test_a_setups_run_passes_every_per_frame_check(run):
    from moonshot.validate.take import run as checks
    if run.folder.name == "set-parallels":
        pytest.skip("the shared take, published before its per-frame checks were gated here")
    run.export()
    failed = {k: v for k, v in checks(run.folder).items() if isinstance(v, str) or not v.passed}
    assert not failed, (run.folder.name, failed)
