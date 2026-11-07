"""Clamp the plate down's nuts (each plate setup's "Set <n> step clamps on its margin and tighten each nut"): in the
physics run each clamp's nut, parked up its stud, is run down onto its strap by the wrench and snugged, turning on
its thread (clamp_thread_<i>) the turn the wrench's strokes give it, and the wrench is laid back where it lay.
Physics tier, on the takes the planner writes to the data root (moonshot/motion/plate_seat.py,
moonshot/motion/plate_wrench.py).
"""
import math

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.motion import plate_wrench as PW
from moonshot.planning.takes import plate_take, seat_takes
from moonshot.world import spoilboard as SB

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = [plate_take(part, "op10", t) for part in ("nist-ftc-09", "ll-1005337") for t in seat_takes(part)]
SEATED_MM = 0.2            # a snugged nut's flange this close to its strap (its bite takes it a little past)
TURN_DEG = 25.0            # ... and its turn this close to its whole run's, the snug and the bite


@pytest.fixture(scope="module", params=TAKES)
def run(request):
    folder = data_root() / "takes" / request.param
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    from moonshot.sim.plate_clamps import PlateClamps
    r = PlateClamps(folder)
    r.run(log=None)
    return r


def worked(run) -> list:
    """The clamps whose nuts the take runs down (a long plate's end's, in its own take)."""
    return [c for c in run.clamps if c.name in run.nuts]


def test_each_nut_is_run_down_onto_its_strap(run):
    for c in worked(run):
        o = run.outcome()[f"{c.name}_nut"]
        assert abs(o["over_strap_mm"]) < SEATED_MM, (c.name, o)


def test_each_nut_turns_as_the_wrench_turns_it(run):
    whole = math.degrees(SB.PARK_NUT_GAP_MM / SB.LEAD_MM * 2 * math.pi)
    for c in worked(run):
        o = run.outcome()[f"{c.name}_nut"]
        assert o["turn_deg"] == pytest.approx(-whole, abs=TURN_DEG), (c.name, o)


def test_the_wrench_is_laid_back_where_it_lay(run):
    at, _ = PW.rest(run.plate)
    p = run.data.body("wrench").xpos * 1000
    assert np.linalg.norm(p[:2] - at[:2]) < 5.0 and abs(p[2] - at[2]) < 1.0
