"""The VF-2 station passes conformance before anything is filmed on it (plan §3.2): its axes have the spec's travel
and speed, its doors open only when pulled, and its interlocks block what they should. Protected (plan §6, rule 1)."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.world.vf2 import Control, record, standalone_xml


@pytest.fixture
def vf2():
    m = mujoco.MjModel.from_xml_string(standalone_xml())
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    return m, d


def travel(m, joint):
    lo, hi = m.jnt_range[m.joint(joint).id]
    return (hi - lo) * 1000


def test_axes_have_the_specs_travel(vf2):
    m, _ = vf2
    spec = {"x": 30 * 25.4, "y": 16 * 25.4, "z": 20 * 25.4}          # Haas VF-2: 30 x 16 x 20 in
    for a, mm in spec.items():
        assert travel(m, f"vf2_{a}") == pytest.approx(mm, abs=0.5)


def test_an_axis_moves_at_rapid_speed_and_no_faster(vf2):
    m, d = vf2
    ctl = Control(m, d, program=[(762.0, 0.0, 0.0, 0.0)])
    ctl.press("cycle_start")
    for _ in range(500):
        ctl.step()
    x = d.qpos[m.jnt_qposadr[m.joint("vf2_x").id]] * 1000
    rapid = record()["joints"]["x"]["speed_mm_s"]
    assert rapid * 0.5 * 0.95 < x <= rapid * 0.5 + 1.0                  # 0.5 s at the rapid rate


def test_cycle_start_with_a_door_open_is_refused(vf2):
    m, d = vf2
    d.qpos[m.jnt_qposadr[m.joint("vf2_door_left").id]] = 0.3
    ctl = Control(m, d, program=[(100.0, 0.0, 0.0, 5000.0)])
    ctl.press("cycle_start")
    assert ctl.state == "idle" and "cycle_start_refused" in ctl.events


def test_opening_the_door_while_running_holds_feed_and_stops_the_spindle(vf2):
    m, d = vf2
    ctl = Control(m, d, program=[(700.0, 0.0, 0.0, 5000.0)])
    ctl.press("cycle_start")
    for _ in range(300):
        ctl.step()
    assert d.qvel[m.jnt_dofadr[m.joint("vf2_spindle").id]] > 100        # turning, rad/s
    d.qpos[m.jnt_qposadr[m.joint("vf2_door_right").id]] = 0.05
    for _ in range(800):
        ctl.step()
    assert ctl.state == "feed_hold" and "door_opened_feed_hold" in ctl.events
    assert abs(d.qvel[m.jnt_dofadr[m.joint("vf2_spindle").id]]) < 5


def test_a_program_runs_to_its_end(vf2):
    m, d = vf2
    ctl = Control(m, d, program=[(100.0, 50.0, -20.0, 3000.0), (150.0, 80.0, -40.0, 3000.0)])
    ctl.press("cycle_start")
    for _ in range(3000):
        ctl.step()
    assert ctl.state == "idle" and "program_end" in ctl.events
    got = [d.qpos[m.jnt_qposadr[m.joint(f"vf2_{a}").id]] * 1000 for a in ("x", "y", "z")]
    assert np.allclose(got, [150.0, 80.0, -40.0], atol=0.5)


def test_a_door_stays_shut_unless_pulled_and_opens_when_pulled(vf2):
    m, d = vf2
    door = m.body("vf2_door_right").id
    q = m.jnt_qposadr[m.joint("vf2_door_right").id]
    for _ in range(500):
        mujoco.mj_step(m, d)
    assert d.qpos[q] * 1000 < 1.0                                       # friction holds it
    d.xfrc_applied[door, 0] = 40.0                                      # a 40 N pull on the handle, to the right
    for _ in range(1000):
        mujoco.mj_step(m, d)
    assert d.qpos[q] * 1000 > 50.0


def test_pendant_buttons_and_door_handles_are_sites(vf2):
    m, _ = vf2
    for s in ("vf2_cycle_start", "vf2_feed_hold", "vf2_door_left_handle", "vf2_door_right_handle"):
        assert m.site(s).id >= 0
    assert record()["joints"]["spindle"]["max_rpm"] == 8100
    assert m.actuator_ctrlrange[m.actuator("a_vf2_spindle").id][1] == pytest.approx(8100 * 2 * math.pi / 60, rel=1e-3)
