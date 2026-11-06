"""Two-joint muscles: the long finger flexors and extensors cross the wrist, so bending the wrist moves the fingers
(plan §3.1, body conformance: couplings). In a relaxed hand, bending the wrist back closes the fingers and bending it
forward opens them; with effort, the fingers hold whatever the plan asks while the wrist moves.

The published numbers are written here, not read from anatomy.json, so the data is checked against its source.
Protected (plan §6, rule 1)."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.body.controller import Controller
from moonshot.body.skeleton import build

# Neumann 2009, Kinesiology of the Musculoskeletal System, 2nd ed., ch. 8, pp. 266-267 (as cited by Sonune et al.
# 2024, Can Prosthet Orthot J 7(1):42879): complete wrist extension flexes a healthy relaxed hand's MCP joints about
# 35 deg and PIP 50 deg (DIP 20, which here follows PIP by its own coupling).
FULL_EXTENSION = {"mcp_flex": 35.0, "pip": 50.0}
FINGERS = ["index", "middle", "ring", "little"]
ARM = {"sc_prot", "sc_elev", "sh_plane", "sh_elev", "sh_rot", "elbow", "pron", "wr_flex", "wr_dev"}


@pytest.fixture(scope="module")
def body():
    return build()


def anat(body, m, d, name):
    return body.joints[name].rest + math.degrees(d.qpos[m.jnt_qposadr[m.joint(name).id]])


def relaxed(body, side):
    """The body with gravity off and the side's finger and thumb motors off: no effort in the hand."""
    m = mujoco.MjModel.from_xml_string(body.xml)
    d = mujoco.MjData(m)
    m.opt.gravity[:] = 0
    mujoco.mj_forward(m, d)
    ctl = Controller(body, m, d)
    for n in ctl.names:
        if n.startswith(f"{side}_") and n[2:] not in ARM:
            a = m.actuator(f"a_{n}").id
            m.actuator_gainprm[a, 0] = 0
            m.actuator_biasprm[a, 1:3] = 0
    return m, d, ctl


def wrist_to(body, side, deg):
    m, d, ctl = relaxed(body, side)
    ctl.set({f"{side}_wr_flex": deg})
    ctl.run(1.5)
    return m, d


@pytest.mark.parametrize("side", ["R", "L"])
def test_bending_the_wrist_back_closes_a_relaxed_hand(body, side):
    m, d = wrist_to(body, side, -65)
    assert anat(body, m, d, f"{side}_wr_flex") < -63
    for f in FINGERS:
        for joint, want in FULL_EXTENSION.items():
            got = anat(body, m, d, f"{side}_{f}_{joint}")
            assert got == pytest.approx(want, abs=4), f"{side} {f} {joint}: {got:.1f} deg at full wrist extension"
        assert anat(body, m, d, f"{side}_{f}_dip") > 10, f"{side} {f}: the fingertip joint follows"


@pytest.mark.parametrize("side", ["R", "L"])
def test_bending_the_wrist_forward_opens_it(body, side):
    neutral = wrist_to(body, side, 0)
    flexed = wrist_to(body, side, 75)
    for f in FINGERS:
        for joint in FULL_EXTENSION:
            n = f"{side}_{f}_{joint}"
            assert anat(body, *flexed, n) < anat(body, *neutral, n) - 10, f"{n} doesn't open with the wrist flexed"


def test_effort_holds_the_fingers_while_the_wrist_moves(body):
    """Tracking a plan, with the hand's motors on, the fingers stay where planned as the wrist sweeps from extension
    to flexion: the coupling is a pull the motors overcome, as a person holds a grip with the wrist moving."""
    m = mujoco.MjModel.from_xml_string(body.xml)
    d = mujoco.MjData(m)
    ctl = Controller(body, m, d)
    q0 = d.qpos.copy()

    def qpos(name, deg):
        return m.jnt_qposadr[m.joint(name).id], math.radians(deg - body.joints[name].rest)

    held = {f"R_{f}_{j}": 30.0 for f in FINGERS for j in FULL_EXTENSION}
    plan = dict(held)
    for c in body.couplings:                       # a plan the couplings agree with, in order (CMC5 follows CMC4)
        plan[f"R_{c.follower}"] = c.k * plan.get(f"R_{c.leader}", body.joints[f"R_{c.leader}"].rest) + c.c
    for name, v in plan.items():
        i, x = qpos(name, v)
        q0[i] = x
    w, w0 = qpos("R_wr_flex", -50)
    _, w1 = qpos("R_wr_flex", 50)
    q0[w] = w0
    d.qpos[:] = q0
    mujoco.mj_forward(m, d)
    worst = 0.0
    for s in range(1500):
        t = min(1.0, s * m.opt.timestep / 1.0)
        p = 10 * t**3 - 15 * t**4 + 6 * t**5
        v = (30 * t**2 - 60 * t**3 + 30 * t**4) * (s * m.opt.timestep < 1.0)
        a = (60 * t - 180 * t**2 + 120 * t**3) * (s * m.opt.timestep < 1.0)
        q, qv, qa = q0.copy(), np.zeros(m.nv), np.zeros(m.nv)
        q[w] = w0 + p * (w1 - w0)
        dof = m.jnt_dofadr[m.joint("R_wr_flex").id]
        qv[dof], qa[dof] = v * (w1 - w0), a * (w1 - w0)
        ctl.track(q, qv, qa)
        worst = max(worst, max(abs(anat(body, m, d, n) - x) for n, x in held.items()))
    assert worst < 3.0, f"a finger strayed {worst:.1f} deg from its plan while the wrist moved"
