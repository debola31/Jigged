"""Loosen the vise (every VF-2 setup's last step, "...loosen the vise and lift the part out"), on the full body:
the right hand cranks the vise open a turn by its knob. The part is lifted out by the vise take started in the vise
(test_vise_take.py's lift-out).

In the physics run the jaw opens by the screw's lead for the turn cranked, and the take is a take record. Physics
tier, on the takes the planner writes to the data root: the shared takes/loosen nist-ftc-10 plays (the reference
load's), and every other part's vise setups' own runs, each its part clamped as its load leaves it
(takes/<part>-<setup>-loosen, moonshot/planning/takes.py per_setup), which also pass every per-frame check
(moonshot/validate/take.py).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.planning.takes import played
from moonshot.world.vise import VISE

pytestmark = [pytest.mark.farm, pytest.mark.data_root]


@pytest.fixture(scope="module", params=played("loosen"))
def run(request):
    folder = data_root() / "takes" / request.param
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    from moonshot.sim.unload import Unload
    r = Unload(folder)
    r.run(log=None)
    return r


def test_the_crank_opens_the_jaw_by_the_screws_lead(run):
    o = run.outcome()
    assert abs(o["opened_mm"] + o["turns"] * VISE["lead"]) < threshold("physics.mechanism_ratio_mm").value, o
    assert o["turns"] < -0.8, "cranked back about a turn"


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(run.folder) == []


def test_a_setups_run_passes_every_per_frame_check(run):
    from moonshot.validate.take import run as checks
    if run.folder.name == "loosen":
        pytest.skip("the shared take, published before its per-frame checks were gated here")
    run.export()
    failed = {k: v for k, v in checks(run.folder).items() if isinstance(v, str) or not v.passed}
    assert not failed, (run.folder.name, failed)
