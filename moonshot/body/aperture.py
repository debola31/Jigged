"""The hand's opening, thumb tip to index tip (mm), from the right hand's anatomical angles, posed on the body model's
hand: what the hand-opening check measures (moonshot/validate/hand_opening.py) and the planner opens the hand to
(moonshot/motion/primitives.py open_for).
"""
from __future__ import annotations

import functools

import mujoco
import numpy as np


@functools.cache
def _body():
    from moonshot.body.skeleton import build
    body = build()
    return body, mujoco.MjModel.from_xml_string(body.xml)


def aperture_mm(q: np.ndarray, names: list[str]) -> np.ndarray:
    """Per frame, thumb tip to index tip (mm), from the right hand's anatomical angles."""
    body, m = _body()
    d = mujoco.MjData(m)
    adr = [m.jnt_qposadr[m.joint(f"R_{n}").id] for n in names]
    rest = np.array([body.joints[f"R_{n}"].rest for n in names])
    tips = [m.geom(f"R_g_{s}").id for s in ("dis1", "dis2")]
    out = []
    for row in q:
        d.qpos[adr] = np.radians(row - rest)
        mujoco.mj_kinematics(m, d)
        ends = []
        for g in tips:                                   # the capsule's end farther from its joint
            c, ax, half = d.geom_xpos[g], d.geom_xmat[g].reshape(3, 3)[:, 2], m.geom_size[g, 1]
            joint = d.xpos[m.geom_bodyid[g]]
            ends.append(max((c + ax * half, c - ax * half), key=lambda p: np.linalg.norm(p - joint)))
        out.append(np.linalg.norm(ends[0] - ends[1]) * 1000)
    return np.array(out)
