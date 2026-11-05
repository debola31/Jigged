"""Set the stop (the first step of a setup whose part stands on the vise's floor, nist-ftc-10 op50: "...then set the
stop"), on the full body: the right hand takes the stop block from the table, pinched by its top, and stands it on the
vise's floor at the part's end, where the load take sets the part against it.

In the physics run the stop ends standing on the floor within the placement limits of where the load take expects it,
and upright; it is carried only in the hand, never dropped; and the take is a take record. Physics tier, on the takes
the planner writes to the data root: the shared takes/set-stop nist-ftc-10 plays (op50's), and every other part's
floor setups' own runs, each the stop at its part's end with its part waiting on the table
(takes/<part>-<setup>-set-stop, moonshot/planning/takes.py per_setup), which also pass every per-frame check
(moonshot/validate/take.py).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.planning.takes import played

pytestmark = [pytest.mark.farm, pytest.mark.data_root]


@pytest.fixture(scope="module", params=played("set-stop"))
def run(request):
    folder = data_root() / "takes" / request.param
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    from moonshot.sim.set_stop import SetStop
    r = SetStop(folder)
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
    assert check(run.folder) == []


def test_a_setups_run_passes_every_per_frame_check(run):
    from moonshot.validate.take import run as checks
    if run.folder.name == "set-stop":
        pytest.skip("the shared take, published before its per-frame checks were gated here")
    run.export()
    failed = {k: v for k, v in checks(run.folder).items() if isinstance(v, str) or not v.passed}
    assert not failed, (run.folder.name, failed)
