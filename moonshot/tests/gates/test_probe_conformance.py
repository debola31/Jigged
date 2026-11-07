"""The VF-2's spindle probe and tool setter cycles pass conformance before a setting take uses them (plan §3.2; the
vf2-tool-setter card): a cycle output from VPS runs on Cycle Start, moves the probe toward the feature until it
touches, goes back where it started, and writes what the touches say. The touch is the machine's sensing, given to
the control as a callable, as the runner reads it from the geometry. Protected (plan §6, rule 1).

Haas's conventions: with a tool setter, a tool's length offset is its length, gauge line to tip (mm, positive), and
a work Z is the gauge line's machine Z with the tool at Z0 less that length; a probe's ball radius lies between its
centre at the touch and the surface."""
import mujoco
import numpy as np
import pytest

from moonshot.world.vf2 import Control, standalone_xml

BALL_R = 3.0                 # the OMP40-2's 6 mm ruby ball
PROBE_MM = 100.0             # the probe's length, gauge line to the ball's bottom


@pytest.fixture
def ctl():
    m = mujoco.MjModel.from_xml_string(standalone_xml())
    d = mujoco.MjData(m)
    for a, v in (("x", 0.381), ("y", 0.2), ("z", -0.2)):
        d.qpos[m.jnt_qposadr[m.joint(f"vf2_{a}").id]] = v
    mujoco.mj_forward(m, d)
    return Control(m, d, tool=20, tool_length={20: PROBE_MM})


def _run(ctl, seconds=20.0):
    ctl.touch({"cycle_start": 5.0})
    ctl.step()
    ctl.touch({})
    for _ in range(int(seconds / ctl.model.opt.timestep)):
        ctl.step()
        if ctl.state == "idle":
            break
    assert ctl.state == "idle", "the cycle didn't end"


def test_a_cycle_waits_for_cycle_start_and_needs_the_doors_closed(ctl):
    ctl.vps("surface", axis="x", sign=1, ball_r=BALL_R)
    start = ctl.machine_mm().copy()
    for _ in range(300):
        ctl.step()
    assert ctl.machine_mm() == pytest.approx(start, abs=1e-3), "nothing moves before Cycle Start"
    ctl.open_doors()
    ctl.press("cycle_start")
    assert "cycle_start_refused" in ctl.events


def test_a_surface_cycle_stops_at_the_touch_comes_back_and_sets_the_offset(ctl):
    start = ctl.machine_mm().copy()
    surface = start[0] + 20.0 + BALL_R                    # the face 20 mm past the ball, along +X
    ctl.sensor = lambda: ctl.machine_mm()[0] + BALL_R >= surface
    ctl.vps("surface", axis="x", sign=1, ball_r=BALL_R)
    _run(ctl)
    assert ctl.work["G54"][0] == pytest.approx(surface, abs=0.01)
    assert ctl.machine_mm() == pytest.approx(start, abs=0.01), "back where it started"
    assert ctl.work["G54"][1:] == pytest.approx([0, 0])


def test_a_bore_cycle_sets_x_and_y_at_its_centre(ctl):
    start = ctl.machine_mm().copy()
    centre, r = start[:2] + [1.2, -0.7], 5.0               # a 10 mm bore (the ears' counterbores), the probe 1.4 mm off its centre
    ctl.sensor = lambda: np.linalg.norm(ctl.machine_mm()[:2] - centre) + BALL_R >= r
    ctl.vps("bore", ball_r=BALL_R)
    _run(ctl)
    assert ctl.work["G54"][:2] == pytest.approx(centre, abs=0.01)


def test_a_z_surface_cycle_sets_work_z_from_the_probes_length(ctl):
    start = ctl.machine_mm().copy()
    touch = start[2] - 15.0                                 # the ball meets the surface 15 mm down
    ctl.sensor = lambda: ctl.machine_mm()[2] <= touch
    ctl.vps("surface", axis="z", sign=-1, ball_r=BALL_R)
    _run(ctl)
    # a tool at work Z0 has its gauge line at G54 Z + its length, so its tip at G54 Z: the surface, where the ball's
    # bottom was with the gauge line at the touch
    assert ctl.work["G54"][2] == pytest.approx(touch - PROBE_MM, abs=0.01)


def test_a_tool_setter_cycle_writes_the_tools_length(ctl):
    ctl.tool = 3
    setter_mm = -300.0                                       # the setter's top, as the gauge line's machine Z less 0
    length = 120.0
    ctl.sensor = lambda: ctl.machine_mm()[2] - length <= setter_mm
    ctl.vps("tool_length", setter_z=setter_mm, gauge_length=125.0)
    _run(ctl, seconds=40.0)
    assert ctl.tool_length[3] == pytest.approx(length, abs=0.01)


def test_a_boss_cycle_touches_it_from_outside_and_sets_x_and_y_at_its_centre(ctl):
    """From over a boss (ll-1007224's Ø31.5 spigot), the probe 1.1 mm off its centre: out past each side, down the depth,
    in to it, back out and up over it; X's pair, then Y's from over X's centre; each touch found within its travel, and
    it ends over the centre, as high as it started."""
    start = ctl.machine_mm().copy()
    centre, r, depth = start[:2] + [0.9, -0.6], 15.75, 8.0
    low = lambda: ctl.machine_mm()[2] < start[2] - depth / 2           # noqa: E731  the boss's top, half the depth down
    ctl.sensor = lambda: low() and np.linalg.norm(ctl.machine_mm()[:2] - centre) - BALL_R <= r
    ctl.vps("boss", ball_r=BALL_R, dia_mm=2 * r, depth_mm=depth)
    _run(ctl, seconds=40.0)
    assert ctl.work["G54"][:2] == pytest.approx(centre, abs=0.01)
    assert ctl.machine_mm() == pytest.approx([*centre, start[2]], abs=0.01), "back over the centre, as high as it started"
    assert "probe_missed" not in ctl.events
