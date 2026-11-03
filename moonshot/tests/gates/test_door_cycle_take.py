"""Close the doors and start the cycle (every VF-2 setup's step 8, `python -m moonshot.planning.steps nist-ftc-10`),
in two takes on the full body: both hands pull the open doors shut, then the right index presses Cycle Start.

In the physics run, the doors close because the hands pull them (they start open, and nothing else moves them);
each hand pulls its own door; and Cycle Start is pressed once, with the doors closed, which the machine accepts and
starts running. Both takes pass every per-frame check (moonshot/validate/take.py). Physics tier, on the takes the
planner writes to the data root (takes/door-close, takes/cycle-start).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
CLOSE, START = data_root() / "takes" / "door-close", data_root() / "takes" / "cycle-start"


def _run(folder, runner):
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    r = runner(folder)
    r.run(log=None)
    return r


@pytest.fixture(scope="module")
def close():
    from moonshot.sim.door_cycle import DoorClose
    return _run(CLOSE, DoorClose)


@pytest.fixture(scope="module")
def start():
    from moonshot.sim.door_cycle import CycleStart
    return _run(START, CycleStart)


def test_both_doors_start_open_and_end_closed(close):
    o = close.outcome()
    assert min(o["door_open_mm_start"].values()) > 300
    assert max(o["door_open_mm_end"].values()) < 5.0, o


def test_each_hand_pulls_its_own_door(close):
    o = close.outcome()
    for door, side in (("door_left", "L"), ("door_right", "R")):
        assert o["pulled_by"][door] == side, o["pulled_by"]
        assert o["hand_force_N_max"][door] > 5.0, "a door that closes untouched isn't closed by a hand"


def test_cycle_start_is_pressed_once_and_accepted(start):
    o = start.outcome()
    assert o["events"].count("cycle_start") == 1, o["events"]
    assert "cycle_start_refused" not in o["events"]
    assert o["state"] == "running"
    assert o["press_N_max"] >= 5.0, "the record's 5 N"


def test_the_takes_are_take_records(close, start):
    for r, folder in ((close, CLOSE), (start, START)):
        r.export(folder)
        assert check(folder) == []
