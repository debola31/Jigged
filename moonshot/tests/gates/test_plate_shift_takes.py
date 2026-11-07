"""Shift the plate (a plate setup that slides the setup before's plate along the table: shift-plate), on the full
body: the wrench breaks each nut loose a little, both hands slide the plate to the setup's place under the clamps'
noses, and the wrench snugs each nut again.

In the physics run the plate ends at the setup's place within the placement limits, lying flat; each clamp ends in
its clamped pose; each nut is snug on its strap again; and the take is a take record. Physics tier, on the takes the
planner writes to the data root (moonshot/motion/plate_shift.py).
"""
import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.planning.takes import PLATE_TAKES, plate_take

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = [plate_take("ll-1005337", "op20", PLATE_TAKES["shift"])]
SEATED_MM = 0.2


@pytest.fixture(scope="module", params=TAKES)
def run(request):
    folder = data_root() / "takes" / request.param
    if not (folder / "reference.npz").exists():
        pytest.skip(f"no planned take at {folder}")
    from moonshot.sim.plate_lift_off import PlateLiftOff
    r = PlateLiftOff(folder)
    r.run(log=None)
    return r


def test_the_plate_lies_at_the_setups_place_flat(run):
    to = np.asarray(run.tk["plate_to"], float)
    p = run.data.body("blank").xpos * 1000
    assert np.abs(p - to).max() < threshold("physics.placement_mm").value, (p - to)
    assert run.outcome()["plate_tilt_deg"] < threshold("physics.placement_deg").value


def test_each_clamp_ends_clamped(run):
    o = run.outcome()
    for c in run.clamps:
        assert max(abs(v) for v in o[c.name]["off_mm"]) < threshold("physics.placement_mm").value, (c.name, o[c.name])
        assert o[c.name]["tilt_deg"] < threshold("physics.placement_deg").value, (c.name, o[c.name])


def test_each_nut_is_snug_again(run):
    o = run.outcome()
    for c in run.clamps:
        assert abs(o[f"{c.name}_nut"]["over_strap_mm"]) < SEATED_MM, (c.name, o[f"{c.name}_nut"])


def test_the_take_is_a_take_record(run):
    run.export()
    assert check(run.folder) == []
