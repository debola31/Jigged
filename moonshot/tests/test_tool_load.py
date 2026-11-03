"""Loading the tools (moonshot/motion/tool_load.py, moonshot/world/tooling.py, the VF-2's drawbar and tool changer in
moonshot/world/vf2.py): a holder is the tool the cycle takes cut with, the control counts pockets as Haas's does,
the drawbar holds a holder pushed into the spindle once Tool Release is let go, and each step's takes leave every
tool in the pocket its number names."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.motion import tool_load as T
from moonshot.planning.steps import expand
from moonshot.planning.takes import spans, tool_takes
from moonshot.planning.validate import load_plan
from moonshot.sim import cam
from moonshot.world import tooling as TL
from moonshot.world import vf2

PLAN = load_plan("nist-ftc-10")
TOOLS = [s for s in expand(PLAN) if s["title"] == "Load the tools"]


@pytest.mark.parametrize("tool_id", sorted(cam.SPEEDS))
def test_a_holder_carries_the_tool_the_cycle_takes_cut_with(tool_id):
    t, c = TL.cutter(tool_id), cam.tool(tool_id)
    assert t["r"] == pytest.approx(c.r) and t["length"] == pytest.approx(c.length)
    assert TL.GAUGE_MM == pytest.approx(cam.GAUGE_MM)


def test_tools_are_numbered_in_the_order_the_plan_first_uses_them():
    num = T.pockets(PLAN)
    assert num == {"facem": 1, "em12": 2, "em38": 3, "drill-2p5": 4, "drill-6": 5, "bem14": 6, "em14": 7,
                   "ream-3p5": 8, "tap-m3": 9, "drill-7": 10, "drill-5p5": 11}
    assert T.PROBE_POCKET not in num.values()


def _control():
    m = mujoco.MjModel.from_xml_string(vf2.standalone_xml())
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    return vf2.Control(m, d), m, d


def _key(c, k, held=False):
    c.touch({k: 5.0})
    c.apply()
    if not held:
        c.touch({})
        c.apply()


def test_the_control_changes_tools_as_haas_does():
    c, _, _ = _control()
    c.setup_mode, c.current, c.spindle_tool = True, 20, "probe"
    for k in ["mdi", "t", "1", "space", "m", "0", "6", "enter", "cycle_start"]:
        _key(c, k)
    assert c.pockets == {20: "probe"} and c.current == 1 and c.spindle_tool is None
    c.spindle_tool = "facem"                       # seated by hand
    _key(c, "atc_fwd")
    assert c.pockets == {20: "probe", 1: "facem"} and c.current == 2 and c.spindle_tool is None
    c.current = 20
    _key(c, "atc_fwd")                             # 20 wraps to 1, which brings the face mill back
    assert c.current == 1 and c.spindle_tool == "facem" and 1 not in c.pockets


def test_atc_fwd_needs_the_doors_shut_or_setup_mode():
    c, _, _ = _control()
    c.open_doors()
    c.mode, c.current = "mdi", 3
    _key(c, "atc_fwd")
    assert c.current == 3 and not c.changes


def test_tool_release_opens_the_drawbar_only_while_held_in_mdi_or_handle_jog():
    c, m, d = _control()
    fingers = c.fingers
    assert len(fingers) == 3
    c.mode = "mdi"
    _key(c, "tool_release_head", held=True)
    assert c.tool_release_held() and np.allclose(d.ctrl[fingers], vf2.SPINDLE_BORE["open_rad"])
    c.touch({})
    c.apply()
    assert not c.tool_release_held() and np.allclose(d.ctrl[fingers], vf2.SPINDLE_BORE["closed_rad"])
    c.mode = "memory"
    _key(c, "tool_release_head", held=True)
    assert not c.tool_release_held()


def test_the_taper_seats_where_the_holder_meets_the_gauge_point():
    """The bore's shoulder ring stops the taper's round top with the holder's gauge line on the spindle's."""
    b, t = vf2.SPINDLE_BORE, TL.TAPER
    assert t["z1"] + math.sqrt(t["r"] ** 2 - b["seat_r"] ** 2) == pytest.approx(b["seat_z"], abs=0.01)
    assert b["ring_r"] - t["r"] == pytest.approx(0.4, abs=0.05)
    assert b["seat_r"] > TL.KNOB_HEAD[0] + 1.0                  # the knob's head passes up through the shoulder


def test_the_drawbar_holds_a_holder_pushed_up_into_it():
    """A plate pushes a holder 1.5 mm off the axis up into the spindle while Tool Release is held; let go, the
    fingers close under the knob, and the holder stays seated with the plate lowered away."""
    body, acts = vf2.worldbody()
    sp = np.array(vf2.record()["joints"]["spindle"]["centre_mm"], float)
    start = sp + [1.5, 0.0, -75.0]
    plate_z = start[2] + TL.FLANGE_BOTTOM[1]
    plates = "".join(f'<geom name="plate{s}" type="box" size="0.006 0.03 0.003" pos="{s * 0.024} 0 -0.003" mass="0.25" '
                     f'contype="2" conaffinity="1"/>' for s in (-1, 1))
    xml = f"""<mujoco><compiler angle="radian" autolimits="true"/>
  <option timestep="0.001" integrator="implicitfast" solver="Newton" cone="elliptic" impratio="10"
          noslip_iterations="10"><flag multiccd="enable"/></option>
  <default><joint limited="true"/><default class="steel"><geom contype="1" conaffinity="3" friction="0.25 0.004 0.0001"
    priority="1" solref="0.002 1" solimp="0.95 0.99 0.0005"/></default></default>
  <worldbody>{body}{TL.holder_body("holder", "em12", start)}
    <body name="pusher" pos="{start[0] / 1000:.5f} {start[1] / 1000:.5f} {plate_z / 1000:.5f}">
      <joint name="push" type="slide" axis="0 0 1" range="-0.1 0.1" damping="50"/>{plates}</body></worldbody>
  <actuator>{acts}<position name="a_push" joint="push" kp="4000" dampratio="1"/></actuator></mujoco>"""
    m = mujoco.MjModel.from_xml_string(xml)
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    c = vf2.Control(m, d)
    c.mode = "mdi"
    push, hb, spb = m.actuator("a_push").id, m.body("holder").id, m.body("vf2_spindle").id

    def run(t_end, mm, held):
        while d.time < t_end:
            c.touch({"tool_release_head": 6.0} if held else {})
            d.ctrl[push] = mm(d.time) / 1000
            c.apply()
            mujoco.mj_step(m, d)

    run(0.3, lambda t: 0.0, False)
    run(1.5, lambda t: min(80.0, (t - 0.3) * 100.0), True)
    run(1.8, lambda t: 80.0, False)                            # let go: the fingers clamp
    run(2.8, lambda t: 80.0 - (t - 1.8) * 30.0, False)          # the plate lowered away under the flange
    rel = (d.xpos[hb] - d.xpos[spb]) * 1000
    assert abs(rel[2]) < 0.5 and np.hypot(*rel[:2]) < 0.6, rel
    assert d.xpos[m.body("pusher").id][2] * 1000 < sp[2] + TL.FLANGE_BOTTOM[1] - 20.0   # the plate well clear of it


@pytest.mark.parametrize("step", TOOLS, ids=lambda s: s["id"])
def test_each_step_leaves_every_tool_in_its_numbered_pocket(step):
    seq = T.sequence(PLAN, step)
    assert [s["name"] for s in seq] == tool_takes(step)
    assert [t for t, _, _ in spans("nist-ftc-10", step)] == [f"nist-ftc-10/{step['id']}/{n}" for n in tool_takes(step)]
    num = T.pockets(PLAN)
    # replay the machine's bookkeeping through the takes' keys
    c, _, _ = _control()
    c.setup_mode = True
    first = seq[0]
    c.pockets, c.current, c.spindle_tool = dict(first["pockets"]), first["current"], "probe"
    for k in ["mdi", *f"t{first['to']}", "space", "m", "0", "6", "enter", "cycle_start"]:
        _key(c, k)
    for s in seq[1:]:
        assert c.current == s["current"]
        if s["kind"] == "seat":
            c.spindle_tool = s["tool"]
        else:
            _key(c, "atc_fwd")
    for t in step["facts"]["tool_ids"]:
        assert c.pockets[num[t]] == t
    assert c.pockets[T.PROBE_POCKET] == "probe" and c.spindle_tool is None
