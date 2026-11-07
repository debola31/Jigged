"""The grind's declared shortcut is reported by frame (moonshot/sim/sgrind.py CutFrames): while the wheel's rim is
inside the part's uncut shape, as in a rock take's strokes, each frame's active constraints name "grind_cut"; with the
wheel clear of the part, as when it is fed down off the work, none does. The shortcuts check then times it
(moonshot/validate/shortcuts.py)."""
import math

import mujoco
import numpy as np

from moonshot.sim.sgrind import GRIND_CUT, CutFrames
from moonshot.tests.test_grind_cell import IC, THICK, blocked_in
from moonshot.validate.shortcuts import shortcuts_declared
from moonshot.world import grind_cell as GC
from moonshot.world import sgrind as SG

FPS = 30
PER_RAD_MM = SG.record()["joints"]["table_handwheel"]["travel_mm_per_turn"] / (2 * math.pi)


def axis_mm(m, d, slide):
    return d.qpos[m.jnt_qposadr[m.joint(f"sg_{slide}").id]] * 1000


def shift_chuck(m, d, ctl, dx_mm=0.0, dy_mm=0.0):
    """The table and saddle moved by (dx, dy) and what is on the chuck with them, as their travel carries it."""
    for b in [m.body(n).id for n in ctl.held]:
        a = m.jnt_qposadr[m.body_jntadr[b]]
        d.qpos[a:a + 2] += np.array([dx_mm, dy_mm]) * 0.001
    ctl.set_axes(table_mm=axis_mm(m, d, "table") + dx_mm, saddle_mm=axis_mm(m, d, "saddle") + dy_mm)


GROOVE_MM = IC / 2 - 0.254 - SG.record()["wheels"]["dwheel-1a1r"]["width_mm"] / 2   # the wheel's mid-plane from the
                                    # insert's middle at the first groove: its side the land's .010 in inside the edge


def under_the_wheel(depth_mm):
    """The cell with its insert brought under the wheel at its first edge's groove, as the plan grinds it (the
    wheel's side the land inside the edge, clear of the keeper behind it), the chuck on, and the wheel lowered
    depth_mm into its top (negative: above it)."""
    m, d, loose = blocked_in()
    ctl = GC.control(m, d, loose)
    lever = m.jnt_qposadr[m.joint("sg_chuck_lever").id]
    for k in range(400):                                                 # settled, the chuck turned on
        d.qpos[lever] = math.pi * min(1.0, (k + 1) / 300)
        ctl.step()
    groove = d.xpos[m.body("chucked_part").id] + np.array([0.0, GROOVE_MM * 0.001, 0.0])   # its first flank faces +Y
    shift = (d.site("sg_wheel_bottom_head").xpos - groove)[:2] * 1000
    shift_chuck(m, d, ctl, *shift)
    top = d.xpos[m.body("chucked_part").id][2] + THICK * 0.001
    drop = (top - d.site("sg_wheel_bottom_head").xpos[2]) * 1000 - depth_mm
    ctl.set_axes(head_mm=axis_mm(m, d, "wheelhead") + drop)
    for _ in range(100):
        ctl.step()
    return m, d, ctl


def frames(m, d, ctl, cut, n, table_mm=None):
    """n frames of the cell's physics, the table rocked to table_mm(t) (mm from where it starts) by a hand's torque
    on its handwheel, tracking it, or left where it is: each frame's reported constraints."""
    spf = int(round(1.0 / (FPS * m.opt.timestep)))
    wheel = m.joint("sg_table_handwheel")
    a, v = m.jnt_qposadr[wheel.id], m.jnt_dofadr[wheel.id]
    w0 = d.qpos[a]
    out = []
    for k in range(n):
        for s in range(spf):
            d.qfrc_applied[:] = 0.0
            if table_mm is not None:
                want = w0 + table_mm((k + s / spf) / FPS) / PER_RAD_MM
                d.qfrc_applied[v] = 20.0 * (want - d.qpos[a]) - 1.0 * d.qvel[v]   # N m: a hand on its knob
            ctl.step()
            cut.step(m, d)
        out.append(cut.frame([]))
    d.qfrc_applied[:] = 0.0
    return out


def rocking(t):
    """The table rocked +-1.5 mm, a stroke a second, as the plan's strokes."""
    return 1.5 * math.sin(2 * math.pi * t)


def test_a_rocks_frames_inside_the_part_report_the_grind():
    m, d, ctl = under_the_wheel(0.2)                                      # 0.2 mm in, the groove's depth
    cut = CutFrames()
    rock = frames(m, d, ctl, cut, 30, rocking)
    assert all(GRIND_CUT in f for f in rock) and cut.frames == 30


def test_frames_with_the_wheel_clear_of_the_part_dont():
    m, d, ctl = under_the_wheel(0.2)
    shift_chuck(m, d, ctl, dx_mm=30.0)                                    # the table run 30 mm off the work
    cut = CutFrames()
    assert not any(GRIND_CUT in f for f in frames(m, d, ctl, cut, 20))
    m, d, ctl = under_the_wheel(-1.0)                                     # over it but a millimetre above
    cut = CutFrames()
    assert not any(GRIND_CUT in f for f in frames(m, d, ctl, cut, 10, rocking))


def test_the_shortcuts_check_times_the_reported_grind():
    reported = [[GRIND_CUT]] * 15 + [[]] * 15
    r = shortcuts_declared({"fps": FPS, "active_constraints": reported, "applied_forces": [[]] * 30})
    assert r.passed and r.detail["shortcut_seconds"]["grind_cut"] == 0.5
