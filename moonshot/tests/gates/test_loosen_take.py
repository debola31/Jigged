"""Loosen the vise (every VF-2 setup's last step, "...loosen the vise and lift the part out"), on the full body:
the right hand cranks the vise open a turn by its knob. The part is lifted out by the vise take started in the vise
(test_vise_take.py's lift-out).

In the physics run the jaw opens by the screw's lead for the turn cranked, and the take is a take record. Physics
tier, on the take the planner writes to the data root (takes/loosen).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.world.vise import VISE

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKE = data_root() / "takes" / "loosen"


@pytest.fixture(scope="module")
def run():
    if not (TAKE / "reference.npz").exists():
        pytest.skip(f"no planned take at {TAKE}")
    from moonshot.sim.unload import Unload
    r = Unload(TAKE)
    r.run(log=None)
    return r


def test_the_crank_opens_the_jaw_by_the_screws_lead(run):
    o = run.outcome()
    assert abs(o["opened_mm"] + o["turns"] * VISE["lead"]) < threshold("physics.mechanism_ratio_mm").value, o
    assert o["turns"] < -0.8, "cranked back about a turn"


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(TAKE) == []
