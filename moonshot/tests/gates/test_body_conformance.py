"""The body model passes its conformance tests before anything else is built on it (plan §3.1).

Protected (plan §6, rule 1): these are the bar the body model meets, not tests of its implementation details.
Range, speed, strength, couplings, proportions, gravity and left-right symmetry.
"""
import json
import math

import mujoco
import numpy as np
import pytest

from moonshot.body.controller import Controller
from moonshot.body.skeleton import DATA, MIRROR, build
from moonshot.contracts.thresholds import threshold


@pytest.fixture(scope="module")
def body():
    return build()


@pytest.fixture
def sim(body):
    m = mujoco.MjModel.from_xml_string(body.xml)
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    return m, d, Controller(body, m, d)


def anat(body, d, m, name):
    j = body.joints[name]
    q = d.qpos[m.jnt_qposadr[m.joint(name).id]]
    return j.rest + (math.degrees(q) if j.kind == "hinge" else q * 1000)


def test_the_skeleton_has_every_joint(body):
    m = mujoco.MjModel.from_xml_string(body.xml)
    assert m.njnt == 73                                         # trunk 3 + 2 x (girdle 2, arm 7, hand 26)
    assert m.nu == 73 - 14                                      # the 7 coupled joints per side have no motor


def test_left_is_the_right_mirrored(body, sim):
    m, d, _ = sim
    rng = np.random.default_rng(0)
    for name, j in body.joints.items():
        if name.startswith("R_"):
            v = rng.uniform(j.lo, j.hi)
            for side in ("R", "L"):
                jj = body.joints[f"{side}_{j.base}"]
                d.qpos[m.jnt_qposadr[m.joint(jj.name).id]] = (math.radians(v - jj.rest) if jj.kind == "hinge"
                                                              else (v - jj.rest) / 1000)
    mujoco.mj_kinematics(m, d)
    for i in range(m.nbody):
        n = m.body(i).name
        if n.startswith("R_"):
            assert np.allclose(d.body("L_" + n[2:]).xpos, MIRROR @ d.body(n).xpos, atol=1e-6), n


@pytest.mark.parametrize("side", ["R"])
def test_every_joint_stops_at_its_range(body, sim, side):
    """Driven past its limit with its full strength, each joint stops within the tolerance of it."""
    m, d, ctl = sim
    tol = threshold("body.joint_range_tolerance_deg").value
    m.opt.gravity[:] = 0
    for name, j in body.joints.items():
        if j.kind != "hinge" or not (name.startswith(f"{side}_") or name.startswith("trunk")):
            continue
        mujoco.mj_resetData(m, d)
        ctl.target[:] = 0
        dof = m.jnt_dofadr[m.joint(name).id]
        for push, limit in ((max(j.strength), j.hi), (-max(j.strength), j.lo)):
            d.qfrc_applied[:] = 0
            d.qfrc_applied[dof] = push
            if j.driven:
                ctl.set({name: limit + 30 if push > 0 else limit - 30})
            ctl.run(0.4)
            got = anat(body, d, m, name)
            assert (got <= j.hi + tol) if push > 0 else (got >= j.lo - tol), f"{name}: {got:.2f} vs {[j.lo, j.hi]}"


def test_joints_move_no_faster_than_their_top_speed(body, sim):
    m, d, ctl = sim
    m.opt.gravity[:] = 0
    ctl.set({"R_elbow": 140, "R_sh_elev": 120, "R_wr_flex": 70})
    ctl.run(0.1)
    for name in ("R_elbow", "R_sh_elev", "R_wr_flex"):
        j = body.joints[name]
        moved = abs(anat(body, d, m, name) - 0.0)
        assert moved <= j.speed * 0.1 + 2.0, f"{name} moved {moved:.1f} deg in 0.1 s; top speed {j.speed} deg/s"


def _hold_arm_forward(body, load_kg):
    b = build(load_kg=load_kg)
    m = mujoco.MjModel.from_xml_string(b.xml)
    d = mujoco.MjData(m)
    ctl = Controller(b, m, d)
    pose = {"R_sh_plane": 90, "R_sh_elev": 90, "R_elbow": 0, "R_pron": 0, "R_wr_flex": 0}
    for name, v in pose.items():                           # start there, so only holding is tested
        j = b.joints[name]
        d.qpos[m.jnt_qposadr[m.joint(name).id]] = math.radians(v - j.rest)
    ctl.set(pose)
    for i, a in enumerate(ctl.acts):
        d.ctrl[a] = ctl.target[i]
    ctl.run(1.5)
    return b, m, d


def test_the_arm_holds_a_blank_at_arms_length():
    """0.8 kg, the vise take's blank, held straight out in front: the shoulder holds within 5 deg."""
    b, m, d = _hold_arm_forward(None, 0.8)
    assert abs(anat(b, d, m, "R_sh_elev") - 90) < 5


def test_the_arm_cannot_hold_what_a_person_cannot():
    """25 kg at arm's length needs ~90 N m at the shoulder, past its 77 N m: the arm sags."""
    b, m, d = _hold_arm_forward(None, 25.0)
    assert anat(b, d, m, "R_sh_elev") < 90 - 20


def test_holding_the_arm_out_costs_a_sustainable_effort():
    """Gravity: the empty arm held forward costs well under the shoulder's strength."""
    b, m, d = _hold_arm_forward(None, 0.0)
    a = m.actuator("a_R_sh_elev").id
    effort = abs(d.actuator_force[a]) / max(b.joints["R_sh_elev"].strength)
    assert effort < 0.3, f"holding the empty arm out costs {effort:.0%} of shoulder strength"


def test_hanging_arms_cost_almost_nothing(body, sim):
    m, d, ctl = sim
    ctl.run(1.0)
    for side in "RL":
        a = m.actuator(f"a_{side}_sh_elev").id
        assert abs(d.actuator_force[a]) < 0.05 * max(body.joints[f"{side}_sh_elev"].strength)


def test_coupled_joints_follow_their_leaders(body, sim):
    m, d, ctl = sim
    m.opt.gravity[:] = 0
    ctl.set({"R_index_pip": 60, "R_ring_mcp_flex": 60, "R_thumb_cmc_flex": 20})
    ctl.run(1.0)
    for c in body.couplings:
        f, ld = anat(body, d, m, f"R_{c.follower}"), anat(body, d, m, f"R_{c.leader}")
        j = body.joints[f"R_{c.follower}"]
        want = min(j.hi, max(j.lo, c.k * ld + c.c))
        assert abs(f - want) < 3.0, f"{c.follower} = {f:.1f}, coupling wants {want:.1f} from {c.leader} = {ld:.1f}"


def test_segment_masses_and_lengths_match_the_anthropometry(body, sim):
    m, d, _ = sim
    segs = json.loads((DATA / "segments.json").read_text(encoding="utf-8"))
    kg, frac = segs["body_mass_kg"]["value"], segs["mass_fraction"]
    for seg, body_name in (("upper_arm", "R_humerus"), ("forearm", "R_forearm")):
        assert m.body(body_name).mass[0] == pytest.approx(frac[seg] * kg, rel=1e-3)
    hand = sum(m.body_mass[i] for i in range(m.nbody)
               if m.body(i).name.startswith("R_") and m.body(i).name not in ("R_girdle", "R_humerus", "R_forearm"))
    assert hand == pytest.approx(frac["hand"] * kg, rel=1e-3)
    L = segs["length_mm"]
    shoulder_z = d.body("R_girdle").xpos[2] * 1000
    assert shoulder_z == pytest.approx(L["lumbar_height"] + L["shoulder_from_lumbar"][2], abs=1)
    elbow_to_mcp = np.linalg.norm(d.body("R_pro3").xpos - d.body("R_forearm").xpos) * 1000
    assert elbow_to_mcp == pytest.approx(segs["elbow_to_grip_mm"]["value"], rel=0.10)
