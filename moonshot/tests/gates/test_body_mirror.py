"""The body's left arm is its right arm mirrored, for any trunk: with the trunk's side-bend and twist negated, the
right arm reflected through the mid-plane lands exactly where the left arm does (plan §3.1). The planner relies on it
to plan a left hand as a right hand in the mirrored world (moonshot/motion/kinematics.py). Protected (plan §6, rule 1).
"""
import math

import mujoco
import numpy as np
import pytest

from moonshot.body.skeleton import build

ARM = ["sh_plane", "sh_elev", "sh_rot", "elbow", "pron", "wr_flex", "wr_dev", "sc_prot", "sc_elev"]


@pytest.fixture(scope="module")
def sim():
    body = build()
    m = mujoco.MjModel.from_xml_string(body.xml)
    return body, m, mujoco.MjData(m)


def _pose(body, m, d, angles):
    d.qpos[:] = 0
    for name, v in angles.items():
        j = body.joints[name]
        d.qpos[m.jnt_qposadr[m.joint(name).id]] = math.radians(v - j.rest) if j.kind == "hinge" else (v - j.rest) / 1000
    mujoco.mj_kinematics(m, d)


def test_the_left_arm_is_the_right_arm_mirrored(sim):
    body, m, d = sim
    rng = np.random.default_rng(7)
    for _ in range(25):
        trunk = {"trunk_flex": rng.uniform(-10, 40), "trunk_lat": rng.uniform(-20, 20), "trunk_rot": rng.uniform(-30, 30)}
        arm = {n: rng.uniform(body.joints["R_" + n].lo, body.joints["R_" + n].hi) for n in ARM}
        _pose(body, m, d, trunk | {"L_" + n: v for n, v in arm.items()})
        left = {b: d.body("L_" + b).xpos.copy() for b in ("humerus", "forearm", "hand")}
        mid = d.body("pelvis").xpos[0]
        mirrored = trunk | {"trunk_lat": -trunk["trunk_lat"], "trunk_rot": -trunk["trunk_rot"]}
        _pose(body, m, d, mirrored | {"R_" + n: v for n, v in arm.items()})
        for b, p in left.items():
            q = d.body("R_" + b).xpos.copy()
            q[0] = 2 * mid - q[0]
            assert np.linalg.norm(q - p) * 1000 < 1e-6, (b, trunk, arm)
