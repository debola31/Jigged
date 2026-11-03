"""The cycle steps' machinery (moonshot/sim/cam.py, moonshot/sim/cycle_take.py): the speeds it plans are inside the
gate's limits, the VF-2 runs a move at its programmed feed, and the 2D regions the paths come from are what they say."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.sim import cam
from moonshot.tests.gates.test_cycle_takes import program_problems
from moonshot.world.vf2 import Control, standalone_xml


@pytest.mark.parametrize("tool_id", sorted(cam.SPEEDS))
def test_every_tool_runs_inside_its_limits(tool_id):
    t = cam.tool(tool_id)
    moves = [[380.0, 150.0, -300.0, None], [380.0, 150.0, -330.0, t.feed], [400.0, 150.0, -330.0, t.feed]]
    assert program_problems({"passes": [{"tool": tool_id, "rpm": t.rpm, "moves": moves}]}) == []


def test_a_move_runs_at_its_feed():
    m = mujoco.MjModel.from_xml_string(standalone_xml())
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    ctl = Control(m, d, program=[(100.0, 0.0, 0.0, 3000.0, 600.0)])            # 600 mm/min: 10 mm/s
    ctl.press("cycle_start")
    for _ in range(2000):
        ctl.step()
    x = d.qpos[m.jnt_qposadr[m.joint("vf2_x").id]] * 1000
    assert x == pytest.approx(20.0, abs=0.5)


def test_an_edge_is_sampled_end_to_end():
    import cadquery as cq
    circle = cam.sample(cq.Edge.makeCircle(5, cq.Vector(0, 0, 0)), 1.0)
    assert np.ptp(circle[:, 0]) == pytest.approx(10, abs=0.05) and np.ptp(circle[:, 1]) == pytest.approx(10, abs=0.05)
    line = cam.sample(cq.Edge.makeLine(cq.Vector(0, 0, 0), cq.Vector(10, 0, 0)), 1.0)
    assert line[0] == pytest.approx([0, 0, 0]) and line[-1] == pytest.approx([10, 0, 0])


def test_regions_grow_and_shrink_by_the_tool():
    r = cam.rect(0, 10, 0, 4)
    bb = r.BoundingBox()
    assert (bb.xlen, bb.ylen) == pytest.approx((10, 4))
    assert cam.grow(r, 1.0).Area() == pytest.approx(40 + 2 * (10 + 4) + math.pi, rel=1e-4)
    assert cam.shrink(r, 1.0).Area() == pytest.approx(8 * 2, rel=1e-4)
    assert cam.shrink(r, 2.5) is None
    assert cam.contains(r, 5, 2) and not cam.contains(r, 11, 2)
