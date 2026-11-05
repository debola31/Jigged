"""Close the doors and start the cycle (every VF-2 setup's step 8, `python -m moonshot.planning.steps nist-ftc-10`),
in two takes on the full body: the hands push the fully open doors shut, one at a time, then the right index presses
Cycle Start; and open the doors (every unload's first take) fully, one at a time, to the track's end.

In the physics run, the doors close because the hands push them (they start fully open, and nothing else moves
them) and open because the hands draw them out to their stops; each hand moves its own door; and Cycle Start is
pressed once, with the doors closed, which the machine accepts and starts running. The door takes pass every
per-frame check (moonshot/validate/take.py), and a setup's own Cycle Start every one but grasp timing and hand opening,
which it is exempt from (the user's decision, 2026-11-04: it grasps nothing). Physics tier, on the takes the planner
writes to the data root: the shared takes nist-ftc-10 plays (takes/door-close, takes/cycle-start, takes/door-open) and
every other part's setups' own runs of them, each with its part or plate on the table (takes/<part>-<setup>-door-close,
...; moonshot/planning/takes.py per_setup).
"""
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.planning.takes import played
from moonshot.world import vf2

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = data_root() / "takes"
FULLY_OPEN_MM = vf2.record()["joints"]["door_right"]["range_mm"][1]
AT_STOP_MM = 3.0                # a door run home sits this close to its stop
CYCLE_START_EXEMPT = ("grasp_timing", "hand_opening")
CLOSE, START, OPEN = played("door-close"), played("cycle-start"), played("door-open")


def _run(name, runner):
    folder = TAKES / name
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    r = runner(folder)
    r.run(log=None)
    return r


@pytest.fixture(scope="module", params=CLOSE)
def close(request):
    from moonshot.sim.door_cycle import DoorClose
    return _run(request.param, DoorClose)


@pytest.fixture(scope="module", params=START)
def start(request):
    from moonshot.sim.door_cycle import CycleStart
    return _run(request.param, CycleStart)


@pytest.fixture(scope="module", params=OPEN)
def opened(request):
    from moonshot.sim.door_cycle import DoorOpen
    return _run(request.param, DoorOpen)


def test_the_setups_have_their_own_takes():
    """Every part but nist-ftc-10 plays its setups' own door and Cycle Start takes."""
    for kind, names in (("door-close", CLOSE), ("cycle-start", START), ("door-open", OPEN)):
        assert kind in names, f"nist-ftc-10 plays the shared {kind}"
        assert any(n.startswith("ct-slbeam-") for n in names), names


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


def _is_record(r) -> None:
    r.export(r.folder)
    assert check(r.folder) == []


def test_the_close_take_is_a_take_record(close):
    _is_record(close)


def test_the_start_take_is_a_take_record(start):
    _is_record(start)


def test_the_open_take_is_a_take_record(opened):
    _is_record(opened)


def _failed(r, exempt=()) -> dict:
    from moonshot.validate.take import run
    r.export(r.folder)
    return {k: v for k, v in run(r.folder).items() if k not in exempt and (isinstance(v, str) or not v.passed)}


def test_the_close_take_passes_every_per_frame_check(close):
    failed = _failed(close)
    assert not failed, (close.folder.name, failed)


def test_the_open_take_passes_every_per_frame_check(opened):
    failed = _failed(opened)
    assert not failed, (opened.folder.name, failed)


def test_a_setups_cycle_start_passes_every_per_frame_check_it_is_held_to(start):
    if start.folder.name == "cycle-start":
        pytest.skip("the shared take, published before its per-frame checks were gated here")
    failed = _failed(start, CYCLE_START_EXEMPT)
    assert not failed, (start.folder.name, failed)
