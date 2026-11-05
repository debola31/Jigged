"""Close the doors and start the cycle (every VF-2 setup's step 8, `python -m moonshot.planning.steps nist-ftc-10`),
in two takes on the full body: the hands push the fully open doors shut, one at a time, then the right index presses
Cycle Start; and open the doors (every unload's first take) fully, one at a time, to the track's end.

In the physics run, the doors close because the hands push them (they start fully open, and nothing else moves
them) and open because the hands draw them out to their stops; each hand moves its own door; and Cycle Start is
pressed once, with the doors closed, which the machine accepts and starts running. The takes pass every per-frame
check (moonshot/validate/take.py). Physics tier, on the takes the planner writes to the data root (takes/door-close,
takes/cycle-start, takes/door-open).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.world import vf2

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = data_root() / "takes"
CLOSE, START, OPEN = TAKES / "door-close", TAKES / "cycle-start", TAKES / "door-open"
FULLY_OPEN_MM = vf2.record()["joints"]["door_right"]["range_mm"][1]
AT_STOP_MM = 3.0                # a door run home sits this close to its stop


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


@pytest.fixture(scope="module")
def opened():
    from moonshot.sim.door_cycle import DoorOpen
    return _run(OPEN, DoorOpen)


def test_both_doors_start_open_and_end_closed(close):
    o = close.outcome()
    assert min(o["door_open_mm_start"].values()) >= 299.0, "opened as far as the take opens them (door_cycle.OPEN_MM)"
    assert max(o["door_open_mm_end"].values()) < 5.0, o


def test_each_hand_pulls_its_own_door(close):
    o = close.outcome()
    for door, side in (("door_left", "L"), ("door_right", "R")):
        assert o["pulled_by"][door] == side, o["pulled_by"]
        assert o["hand_force_N_max"][door] > 5.0, "a door that closes untouched isn't closed by a hand"


def test_both_doors_start_shut_and_end_fully_open(opened):
    o = opened.outcome()
    assert max(o["door_open_mm_start"].values()) < 5.0, o
    for door, mm in o["door_open_mm_end"].items():
        assert abs(mm - FULLY_OPEN_MM) <= AT_STOP_MM, f"{door} ends {mm} mm open, not at its stop: {o}"


def test_each_hand_opens_its_own_door(opened):
    o = opened.outcome()
    for door, side in (("door_left", "L"), ("door_right", "R")):
        assert o["pulled_by"][door] == side, o["pulled_by"]
        assert o["hand_force_N_max"][door] > 5.0, "a door that opens untouched isn't opened by a hand"


def test_cycle_start_is_pressed_once_and_accepted(start):
    o = start.outcome()
    assert o["events"].count("cycle_start") == 1, o["events"]
    assert "cycle_start_refused" not in o["events"]
    assert o["state"] == "running"
    assert o["press_N_max"] >= 5.0, "the record's 5 N"


def test_the_takes_are_take_records(close, start, opened):
    for r, folder in ((close, CLOSE), (start, START), (opened, OPEN)):
        r.export(folder)
        assert check(folder) == []


def test_the_door_takes_pass_every_per_frame_check(close, opened):
    from moonshot.validate.take import run
    for r, folder in ((close, CLOSE), (opened, OPEN)):
        r.export(folder)
        failed = {k: v for k, v in run(folder).items() if isinstance(v, str) or not v.passed}
        assert not failed, (folder.name, failed)
