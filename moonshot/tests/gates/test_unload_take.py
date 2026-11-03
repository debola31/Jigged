"""Loosen the vise and lift the part out (every VF-2 setup's last step, "...loosen the vise and lift the part out"),
on the full body: the right hand cranks the vise open a turn by its knob, then takes the part by its faces above the
jaws, as it was set in, lifts it out and sets it down on the table beside the vise.

In the physics run the jaw opens by the screw's lead for the turn cranked; the part rises clear of the jaws only
while the hand holds it, moves with it (within the grip's slip limit) and is set down flat where planned; and the
take is a take record. Physics tier, on the take the planner writes to the data root (takes/unload).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.world.vise import VISE

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKE = data_root() / "takes" / "unload"


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


def test_the_hand_lifts_it_clear_and_holds_it(run):
    o = run.outcome()
    assert o["cleared_jaws_mm"] > 5, o
    assert o["lifted_in_hand"], o
    assert o["max_slip_mm"] < threshold("physics.grip_slip_mm").value, o


def test_it_is_set_down_where_planned_and_flat(run):
    o = run.outcome()
    assert max(abs(v) for v in o["set_down_vs_planned_mm"]) < threshold("physics.placement_mm").value, o
    assert o["tilt_deg"] < threshold("physics.placement_deg").value, o


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(TAKE) == []
