"""The muscle check agrees with what people can do (plan §3.1, body conformance: muscle check agrees). Replayed through
MyoSuite's arm (moonshot/validate/muscle.py), MyoArm takes our arm's posture; an easy motion needs little effort, a
load people hold stays under 100%, and a deliberately superhuman take, by load or by speed, fails the registered
check (muscle_activation). Protected (plan §6, rule 1)."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.body.skeleton import build
from moonshot.validate.muscle import TRUNK_TO_WRIST, MyoArm, arm_speed, muscle_activation

FPS = 30.0
ARM_LENGTH_POSE = {"sh_plane": 90, "sh_elev": 90, "elbow": 0}       # straight out in front


@pytest.fixture(scope="module")
def arm():
    return MyoArm()


def min_jerk(s):
    s = min(1.0, max(0.0, s))
    return 10 * s**3 - 15 * s**4 + 6 * s**5


def replay(arm, seconds, pose, hand_load_kg=0.0):
    """A synthetic take: trunk-to-wrist angles from pose(fraction of the take), an upright trunk, and the weight of
    a held load hanging from the hand. Returns what the check reads."""
    n = int(seconds * FPS)
    theta = np.zeros((n, len(TRUNK_TO_WRIST)))
    for k in range(n):
        for name, v in pose(k / max(1, n - 1)).items():
            theta[k, TRUNK_TO_WRIST.index(name)] = v
    load = np.zeros((n, 6))
    load[:, 2] = -9.81 * hand_load_kg
    r = arm.replay(theta, {}, FPS, np.tile([0.0, 0.0, -9.81], (n, 1)), load)
    return {"muscle_activation": r.activation.max(1).tolist(), "arm_speed_deg_s": arm_speed(theta, FPS).tolist(),
            "fps": FPS, "_residual": r.residual_nm}


def test_myoarm_takes_our_arms_posture(arm):
    """Over random postures, MyoArm's upper arm, forearm and hand point the way ours do within 15 deg, and its hand's
    roll (the knuckle line) within 25 deg: the two arms' joints differ, so the mapping is approximate, not loose."""
    body = build()
    m = mujoco.MjModel.from_xml_string(body.xml)
    d = mujoco.MjData(m)
    rng = np.random.default_rng(7)
    lo, hi = [-30, 10, -60, 10, -60, -40, -10], [120, 130, 60, 125, 60, 40, 20]
    worst = np.zeros(4)
    for _ in range(40):
        pose = dict(zip(TRUNK_TO_WRIST[3:], rng.uniform(lo, hi)))
        d.qpos[:] = 0
        for n, v in pose.items():
            d.qpos[m.jnt_qposadr[m.joint(f"R_{n}").id]] = math.radians(v - body.joints[f"R_{n}"].rest)
        mujoco.mj_kinematics(m, d)
        ours = [d.body(b).xpos for b in ("R_humerus", "R_forearm", "R_hand", "R_pro3", "R_pro2", "R_pro5")]
        theta = np.zeros((1, len(TRUNK_TO_WRIST)))
        theta[0, 3:] = list(pose.values())
        arm.d.qpos[:] = arm.C @ np.radians(arm.angles(theta, {})[0])
        mujoco.mj_kinematics(arm.m, arm.d)
        to_ours = arm.from_ours.T
        theirs = [to_ours @ arm.d.body(b).xpos for b in ("humerus_r", "radius_r", "lunate_r", "3proxph_r",
                                                          "2proxph_r", "5proxph_r")]
        for i, (a, b) in enumerate(((0, 1), (1, 2), (2, 3), (4, 5))):
            u, v = ours[b] - ours[a], theirs[b] - theirs[a]
            angle = math.degrees(math.acos(np.clip(u @ v / np.linalg.norm(u) / np.linalg.norm(v), -1, 1)))
            worst[i] = max(worst[i], angle)
    assert worst[:3].max() < 15, f"upper arm, forearm, hand at worst {worst[:3].round(1)} deg apart"
    assert worst[3] < 25, f"the hand's roll at worst {worst[3]:.1f} deg apart"


def test_an_easy_motion_needs_little_effort(arm):
    hanging = replay(arm, 1.0, lambda s: {"elbow": 5})
    assert max(hanging["muscle_activation"]) < 0.1, "the arm hanging at the side needs next to nothing"
    reach = replay(arm, 1.5, lambda s: {"sh_plane": 90, "sh_elev": 60 * min_jerk(s), "elbow": 10 + 30 * min_jerk(s)})
    assert max(reach["muscle_activation"]) < 0.3, "a slow unloaded reach forward needs under 30%"
    assert muscle_activation(reach).passed


@pytest.mark.parametrize("kg", [0.8, 5.0])
def test_a_load_people_hold_out_passes(arm, kg):
    """The vise take's 0.8 kg blank, and 5 kg, held straight out: about 32 + 11 N m at the shoulder for 5 kg, inside
    the 77 N m men's shoulder flexion reaches (strength.json, sh_elev)."""
    take = replay(arm, 1.0, lambda s: ARM_LENGTH_POSE, hand_load_kg=kg)
    assert max(take["muscle_activation"]) < 1.0
    assert muscle_activation(take).passed


def test_a_load_no_one_holds_out_fails(arm):
    """25 kg straight out needs about 170 N m at the shoulder, over twice what men's shoulder flexion reaches."""
    take = replay(arm, 1.0, lambda s: ARM_LENGTH_POSE, hand_load_kg=25.0)
    assert max(take["muscle_activation"]) > 1.0
    assert not muscle_activation(take).passed


def test_a_motion_too_fast_for_any_arm_fails(arm):
    """The elbow flexed 90 deg in a tenth of a second (1,350 deg/s at its peak): the forearm's own inertia needs
    more torque than the elbow's flexors can make."""
    take = replay(arm, 0.5, lambda s: {"elbow": 10 + 90 * min_jerk(s * 5)})
    assert max(take["muscle_activation"]) > 1.0
    assert not muscle_activation(take).passed
