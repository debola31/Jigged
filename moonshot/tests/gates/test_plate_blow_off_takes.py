"""Blow the chips off a plate's table with the air gun, on the full body: each plate setup's "Clean the table" (the
spoilboard bare, its clamps parked) and ll-1005337 op10's unload, whose plate stays clamped for op20. The right hand
takes the gun from its holster, blows along the middle of the table with the trigger held, and puts it back.

In the physics run the gun leaves the holster only in the hand and is never dropped (it moves with the hand, within
the grip's slip limit, while carried); the trigger is held at least 1.5 s with the nozzle over the spoilboard; the gun
ends back in its holster; a plate on the table isn't moved; and the take is a take record. Physics tier, on the takes
the planner writes to the data root (moonshot/motion/plate_blow_off.py).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = ["nist-ftc-09-op10-clean", "ll-1005337-op10-clean", "ll-1005337-op10-unload"]


@pytest.fixture(scope="module", params=TAKES)
def run(request):
    folder = data_root() / "takes" / request.param
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    from moonshot.sim.plate_blow_off import PlateBlowOff
    r = PlateBlowOff(folder)
    r.run(log=None)
    return r


def test_the_gun_is_never_dropped(run):
    o = run.outcome()
    assert o["max_slip_mm"] < threshold("physics.grip_slip_mm").value, o
    assert o["lifted_mm"] > 120, "it came out of the holster"


def test_the_trigger_is_held_over_the_table(run):
    assert run.outcome()["blowing_over_table_s"] >= 1.5


def test_the_gun_ends_back_in_its_holster(run):
    assert run.outcome()["end_off_rest_mm"] < 10.0


def test_a_plate_on_the_table_isnt_moved(run):
    o = run.outcome()
    if "plate_moved_mm" in o:
        assert o["plate_moved_mm"] < 0.1, o


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(run.folder) == []
