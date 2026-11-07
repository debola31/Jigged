"""The ST-25 cell holds together before anything is filmed in it (plan §3.2): the operator stands clear of the machine
at the chuck and at the pendant, the chuck's jaws and the pendant's buttons are inside the arm's reach from there,
and stock clamped in the chuck turns with the spindle with the body in the scene. Protected (plan §6, rule 1)."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.body.skeleton import build
from moonshot.world import lathe_cell as LC

INCH = 25.4


def scene(pelvis, workholding="br10", loose="", door_open=True, **kw):
    xml = LC.with_body(build(pelvis_mm=pelvis).xml, workholding=workholding, loose=loose, **kw)
    m = mujoco.MjModel.from_xml_string(xml)
    d = mujoco.MjData(m)
    ctl = LC.start(m, d, door_open=door_open)
    mujoco.mj_forward(m, d)
    return m, d, ctl


def touching_machine(m, d):
    machine = {g for g in range(m.ngeom) if m.geom(g).name.startswith("st25_")}
    body = {g for g in range(m.ngeom) if m.geom(g).name[:2] in ("L_", "R_", "g_")}
    return [(m.geom(a).name, m.geom(b).name) for a, b in zip(d.contact.geom1[:d.ncon], d.contact.geom2[:d.ncon])
            if {a, b} & machine and {a, b} & body]


def arm_length_mm(m, d, side="R"):
    """The arm's length, shoulder to the middle fingertip, as the body model hangs it at rest."""
    return float(np.linalg.norm(d.body(f"{side}_dis3_end").xpos - d.body(f"{side}_humerus").xpos)) * 1000


def test_the_operator_stands_clear_at_the_chuck_with_the_door_open():
    m, d, ctl = scene(LC.LOAD_PELVIS_MM)
    assert not ctl.doors_closed()
    assert not touching_machine(m, d)


def test_the_operator_stands_clear_at_the_pendant_with_the_door_shut():
    m, d, _ = scene(LC.PENDANT_PELVIS_MM, door_open=False)
    assert not touching_machine(m, d)


def test_the_chucks_jaws_are_within_reach_from_the_chuck():
    m, d, _ = scene(LC.LOAD_PELVIS_MM)
    reach = arm_length_mm(m, d)
    for side in ("R", "L"):
        shoulder = d.body(f"{side}_humerus").xpos * 1000
        for k in range(3):
            jaw = d.site(f"st25_jaw_{k}_face").xpos * 1000
            assert np.linalg.norm(jaw - shoulder) < reach, (side, k)


def test_the_pendants_buttons_are_within_reach_from_the_pendant():
    m, d, _ = scene(LC.PENDANT_PELVIS_MM, door_open=False)
    reach = arm_length_mm(m, d)
    for s in ("st25_cycle_start", "st25_feed_hold", "st25_jog_rim", "st25_key_handle_jog", "st25_key_z_face_measure"):
        assert min(np.linalg.norm(d.site(s).xpos - d.body(f"{side}_humerus").xpos) * 1000
                   for side in ("R", "L")) < reach, s


def test_stock_clamped_in_the_chuck_turns_with_the_spindle_in_the_cell():
    """A 2-1/2 in 6061 blank in the BR10's soft jaws bored to it, as ll-1007224's op10 holds it: 8 mm of its 25.4 in
    the jaws, so its weight is held up (as the hand holds it) until the jaws have closed on it."""
    blank = LC.stock_xml("stock", 63.5, 25.4, LC.in_jaws_mm(63.5, 25.4, 8.0), LC.DENSITY["6061"])
    m, d, ctl = scene(LC.LOAD_PELVIS_MM, loose=blank, bore_mm=63.5)
    stock = m.body("stock").id
    d.xfrc_applied[stock, 2] = m.body_subtreemass[stock] * 9.81
    ctl.clamp()
    for _ in range(800):
        ctl.step()
    d.xfrc_applied[stock, 2] = 0.0
    assert ctl.chuck == "clamped"
    d.qpos[ctl.q["door"]] = 0.0
    ctl.spindle(1000.0)
    for _ in range(1500):
        ctl.step()
    sp = m.jnt_dofadr[m.joint("st25_spindle").id]
    bar = m.jnt_dofadr[m.joint("stock").id]
    R = d.body("stock").xmat.reshape(3, 3)
    assert (R @ d.qvel[bar + 3:bar + 6])[0] == pytest.approx(d.qvel[sp], rel=0.02)
    assert np.linalg.norm(d.body("stock").xpos[1:] * 1000 - [0.0, 1005.2]) < 0.5      # on the spindle's axis


def test_a_bar_in_the_collet_clamps_on_the_axis():
    """A 5/8 in AMPCO 18 bar in the 5/8 in collet, 20 mm out, as ll-1011439's op10 holds it."""
    bar = LC.stock_xml("stock", 0.625 * INCH, 3 * INCH, LC.in_collet_mm(3 * INCH, 20.0), LC.DENSITY["ampco18"])
    m, d, ctl = scene(LC.LOAD_PELVIS_MM, workholding="c5", loose=bar)
    ctl.press_pedal()
    for _ in range(800):
        ctl.step()
    assert ctl.chuck == "clamped"
    assert np.linalg.norm(d.body("stock").xpos[1:] * 1000 - [0.0, 1005.2]) < 0.5
    end = d.body("stock").xpos[0] * 1000 + 1.5 * INCH
    assert end == pytest.approx(LC.st25.record()["workholding"]["c5"]["nose_x_mm"] + 20.0, abs=1.0)
    assert math.isfinite(float(d.qpos.sum()))
