"""Lay the plate down (each plate setup's "Lay the plate on the spoilboard"), on the full body: the take starts with
the plate in both hands at the doorway, carried in from off-screen, and lays it on the spoilboard at its place.

In the physics run the plate ends at its place within the placement limits, lying flat; it moves with the hands while
they carry it, within the grip's slip limit, and stays where it was let go; its exemption names only its own grips
and the two grasp checks (the user's decision, 2026-11-05); and the take is a take record. Physics tier, on the
takes the planner writes to the data root (moonshot/motion/plate_load.py).
"""
import json

import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.planning.takes import PLATE_TAKES, plate_take

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = [plate_take(part, "op10", PLATE_TAKES["load"]) for part in ("nist-ftc-09", "ll-1005337")]


@pytest.fixture(scope="module", params=TAKES)
def run(request):
    folder = data_root() / "takes" / request.param
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    from moonshot.sim.plate_load import PlateLoad
    r = PlateLoad(folder)
    r.run(log=None)
    return r


def test_the_plate_lies_at_its_place_flat(run):
    o = run.outcome()
    assert max(abs(v) for v in o["off_mm"]) < threshold("physics.placement_mm").value, o
    assert o["tilt_deg"] < threshold("physics.placement_deg").value, o


def test_the_plate_is_carried_and_not_dropped(run):
    o = run.outcome()
    for s in ("R", "L"):
        assert o[f"max_slip_{s}_mm"] < threshold("physics.grip_slip_mm").value, o


def test_the_plate_stays_where_it_was_let_go(run):
    # "let go" is when it comes to rest off the hands: 0.3 s after the last frame a hand touches it, or a second after
    # the carry ends if later (moonshot/sim/plate_load.py let_go_frame). Laid from underneath, a plate rests on the
    # fingers under its ends after the carry and drops their thickness onto the board as they come out; measured from
    # a second after the carry, mid draw-out, that drop counted. A measurement fix, the 0.5 mm limit unchanged
    # (accepted by the coordinator, 2026-11-06)
    assert run.outcome()["moved_after_let_go_mm"] < 0.5


def test_only_the_plates_grips_are_exempt_and_only_from_the_grasp_checks(run):
    tk = json.loads((run.folder / "take.json").read_text(encoding="utf-8"))
    assert sorted(x["grip"] for x in tk["exempt"]) == ["plate_L", "plate_R"]
    assert all(sorted(x["checks"]) == ["grasp_timing", "hand_opening"] for x in tk["exempt"])


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(run.folder) == []
