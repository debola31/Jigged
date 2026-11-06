"""The body's strength varies with joint angle and speed as people's does (plan §3.1, body conformance: strength
curves). Each motor's cap is its peak (moonshot/body/data/strength.json) scaled by its curve at the joint's angle and
speed, and MuJoCo holds the motor to it on every step (moonshot/body/controller.py, StrengthCaps).

The published numbers are written here, not read from strength.json, so the data is checked against its sources.
Protected (plan §6, rule 1)."""
import json
import math

import mujoco
import numpy as np
import pytest

from moonshot.body.controller import Controller, StrengthCaps
from moonshot.body.skeleton import DATA, build, strength_key
from moonshot.config import data_root

# Frey-Law et al. 2012, J Appl Biomech 28(6):726-737, Tables 4 and 5: men's mean peak elbow torque (N m) by elbow
# flexion (deg, 0 = straight) and speed (deg/s, 0 = isometric). None: over half the men couldn't reach that speed.
ANGLES = [15, 40, 65, 90, 110]
FLEXION = {0: [56.4, 62.9, 63.0, 60.3, 56.4], 60: [41.2, 43.9, 44.7, 42.3, 35.7], 120: [36.1, 38.0, 38.7, 36.8, 27.9],
           180: [32.1, 33.9, 33.1, 29.2, 18.7], 240: [None, 30.0, 27.9, 21.5, 12.0], 300: [None, None, 25.7, 18.4, 8.4]}
EXTENSION = {0: [40.2, 50.5, 52.8, 50.7, 45.4], 60: [26.2, 37.4, 39.6, 38.3, 36.4], 120: [21.9, 33.6, 35.6, 35.2, 33.7],
             180: [15.3, 29.0, 31.8, 33.0, 30.8], 240: [8.7, 20.5, 26.1, 28.5, None], 300: [5.5, 17.1, 24.6, 26.7, None]}
# Grip by wrist flexion (+) / extension (-): Bhardwaj et al. 2011, Indian J Plast Surg 44(1):55-58, 100 adults,
# splinted, right hand: 27.9 kg at 45 deg extension, 13.9 kg at 30 deg flexion. O'Driscoll et al. 1992, J Hand Surg
# Am 17(1):169-177: strongest at 35 deg extension (self-selected); at 15 deg extension two thirds to three quarters.
GRIP_FLEXORS = ["mcp_flex", "pip"]
FINGERS = ["index", "middle", "ring", "little"]
# Aronis et al. 2025, J Funct Morphol Kinesiol 11(1):20, Table 1: 14 men standing, mean isometric shoulder flexion
# torque (N m) by elevation (deg). Koski & McGill 1994, Clin Biomech 9(2):99-104: 26 men, shoulder flexion at 45 deg,
# 68.6 N m isometric and 46.9 N m concentric at 50 deg/s.
ELEVATION = {90: 77.24, 100: 71.81, 110: 68.85, 120: 64.92, 130: 59.92, 140: 52.37, 150: 48.29, 160: 43.19}
KOSKI_45 = {0: 68.6, 50: 46.9}
# Ruas et al. 2015, Sports 3(3):236-245, Table 2: 20 men, arm abducted 90 deg, preferred arm, concentric at 60 deg/s,
# mean torque (N m) by humeral rotation (deg, + internal).
ROTATION = list(range(-80, 51, 10))
INTERNAL = [38.2, 39.8, 40.9, 41.7, 41.7, 41.2, 39.6, 37.3, 36.6, 35.6, 34.7, 32.9, 30.7, 27.1]
EXTERNAL = [23.0, 29.1, 33.9, 35.8, 37.2, 37.8, 37.9, 38.0, 37.9, 38.0, 38.0, 37.5, 36.9, 33.9]
# Behrens et al. 2019, Front Bioeng Biotechnol 7:181, Table 1: 18 men, mean isometric wrist flexion torque (N m) by
# wrist flexion (deg, - extension). Delp et al. 1996, J Biomech 29(10):1371-1375: 10 men, extension moment relatively
# constant from 30 deg flexion to 70 deg extension.
WRIST_FLEXION = {-30: 16.08, 0: 19.17, 30: 18.46}
# Every strength key with no curve of its own, in strength.json's `curves`, must say why (`reason`); those with one
# name a source.
SOURCED = {"elbow", "sh_elev", "sh_rot", "wr_flex"}


@pytest.fixture(scope="module")
def body():
    return build()


@pytest.fixture
def state(body):
    m = mujoco.MjModel.from_xml_string(body.xml)
    return body, m, mujoco.MjData(m), StrengthCaps(body, m)


def caps(state, pose: dict, speed: dict | None = None) -> dict[str, tuple[float, float]]:
    """Each named joint's motor cap (against, along its positive direction) at this pose (anatomical degrees) and
    speed (deg/s)."""
    body, m, d, sc = state
    d.qpos[:], d.qvel[:] = 0, 0
    for name, v in pose.items():
        d.qpos[m.jnt_qposadr[m.joint(name).id]] = math.radians(v - body.joints[name].rest)
    for name, v in (speed or {}).items():
        d.qvel[m.jnt_dofadr[m.joint(name).id]] = math.radians(v)
    sc.apply(d)
    out = {}
    for name in set(pose) | set(speed or {}):
        if body.joints[name].driven:
            lo, hi = m.actuator_forcerange[m.actuator(f"a_{name}").id]
            out[name] = (-lo, hi)
    return out


@pytest.mark.parametrize("side", ["R", "L"])
def test_the_elbow_follows_frey_laws_strength_surface(state, side):
    """Flexing, the flexion cap; extending, the extension cap; each as a fraction of its isometric peak at 65 deg."""
    e = f"{side}_elbow"
    peak_flex = caps(state, {e: 65})[e][1]
    peak_ext = caps(state, {e: 65})[e][0]
    for table, direction, peak, col in ((FLEXION, 1, peak_flex, 1), (EXTENSION, -1, peak_ext, 0)):
        iso = max(table[0])
        for speed, row in table.items():
            for angle, torque in zip(ANGLES, row):
                if torque is None:
                    continue
                got = caps(state, {e: angle}, {e: direction * speed})[e][col] / peak
                assert got == pytest.approx(torque / iso, abs=0.01), \
                    f"{e} {'flexing' if direction > 0 else 'extending'} at {angle} deg, {speed} deg/s: {got:.3f}"


def test_every_joint_is_weaker_moving_fast_than_slow(body, state):
    """Shortening at 120 deg/s, every hinge's motor is weaker than held still, both ways."""
    for name, j in body.joints.items():
        if j.kind != "hinge" or not j.driven:
            continue
        still = caps(state, {name: j.rest})[name]
        for col, sign in ((1, 1), (0, -1)):
            fast = caps(state, {name: j.rest}, {name: sign * 120})[name][col]
            assert fast < 0.9 * still[col], f"{name}: {fast:.2f} moving vs {still[col]:.2f} still"


@pytest.mark.parametrize("side", ["R", "L"])
def test_grip_falls_as_the_wrist_bends(body, state, side):
    """The long finger flexors cross the wrist: their strength follows the wrist's flexion as grip does."""
    w = f"{side}_wr_flex"
    flexors = [f"{side}_{f}_{k}" for f in FINGERS for k in GRIP_FLEXORS] + [f"{side}_thumb_ip"]
    for name in flexors:
        rest = body.joints[name].rest
        at = lambda wrist: caps(state, {name: rest, w: wrist})[name][1]   # noqa: E731
        assert at(30) / at(-45) == pytest.approx(13.9 / 27.9, abs=0.03), f"{name}: Bhardwaj 2011's 30 deg flexion"
        assert 2 / 3 - 0.01 <= at(-15) / at(-35) <= 3 / 4 + 0.01, f"{name}: O'Driscoll 1992's 15 deg extension"
        assert at(80) < 0.5 * at(-35), f"{name}: with the wrist fully flexed"


@pytest.mark.parametrize("side", ["R", "L"])
def test_the_shoulder_raises_the_arm_as_aronis_and_koski_measured(state, side):
    """Raising the arm, weaker the higher it is (Aronis 2025); at 90 deg the 77 N m peak; moving at 50 deg/s, Koski &
    McGill's fraction of isometric."""
    s = f"{side}_sh_elev"
    peak = caps(state, {s: 90})[s][1]
    assert peak == pytest.approx(77, abs=0.5), f"{s} raising at 90 deg: {peak:.1f} N m"
    for angle, torque in ELEVATION.items():
        got = caps(state, {s: angle})[s][1] / peak
        assert got == pytest.approx(torque / ELEVATION[90], abs=0.01), f"{s} raising at {angle} deg: {got:.3f}"
    got = caps(state, {s: 45}, {s: 50})[s][1] / caps(state, {s: 45})[s][1]
    assert got == pytest.approx(KOSKI_45[50] / KOSKI_45[0], abs=0.01), f"{s} raising at 50 deg/s: {got:.3f}"


@pytest.mark.parametrize("side", ["R", "L"])
def test_humeral_rotation_follows_ruas_angle_specific_torque(state, side):
    """Internal rotation (+, the motor pushing along) strongest stretched, external strongest mid-range: each as a
    fraction of its own peak (Ruas 2015's 60 deg/s shape)."""
    r = f"{side}_sh_rot"
    for table, col in ((INTERNAL, 1), (EXTERNAL, 0)):
        peak = max(caps(state, {r: a})[r][col] for a in ROTATION)
        for angle, torque in zip(ROTATION, table):
            got = caps(state, {r: angle})[r][col] / peak
            assert got == pytest.approx(torque / max(table), abs=0.01), \
                f"{r} {'internal' if col else 'external'} at {angle} deg: {got:.3f}"


@pytest.mark.parametrize("side", ["R", "L"])
def test_the_wrist_flexes_as_behrens_measured_and_extends_as_delp_did(state, side):
    """Flexion weakest extended (Behrens 2019); extension flat from 70 deg extension to 30 deg flexion (Delp 1996)."""
    w = f"{side}_wr_flex"
    peak = caps(state, {w: 0})[w][1]
    for angle, torque in WRIST_FLEXION.items():
        got = caps(state, {w: angle})[w][1] / peak
        assert got == pytest.approx(torque / WRIST_FLEXION[0], abs=0.01), f"{w} flexing at {angle} deg: {got:.3f}"
    ext = [caps(state, {w: a})[w][0] for a in (-70, -35, 0, 30)]
    assert max(ext) - min(ext) < 0.01 * max(ext), f"{w} extending: {ext}"


def test_every_curve_names_its_source_or_says_why_it_has_none(body):
    """strength.json: each hinge's strength key either has a sourced curve or states, as `proposed`, why it has none."""
    data = json.loads((DATA / "strength.json").read_text(encoding="utf-8"))["curves"]
    hand = data["hand"]
    for key in sorted({strength_key(j.base) for j in body.joints.values() if j.kind == "hinge"}):
        entry = data.get(key) or (hand if key in hand["keys"] else None)
        assert entry, f"{key}: no curve and no reason"
        for direction in ("against", "along"):
            c = entry.get(direction, entry)
            assert c.get("source") in ("study", "proposed") and c.get("reason"), f"{key} {direction}: {c}"
            if c["source"] == "study":
                assert "torque_nm" in c, f"{key} {direction}: a study source with no numbers"
        assert (key in SOURCED) == any(entry.get(d, {}).get("source") == "study" for d in ("against", "along")), key


@pytest.mark.parametrize("load", [0.6, 0.8])
def test_mujoco_holds_the_elbow_to_its_curve(body, load):
    """Driven flat out against a constant load, the elbow flexes at the speed where its curve gives that load: in
    MuJoCo, on every step, not just in the cap's arithmetic. Gravity off; the load is a fraction of the isometric
    strength at 65 deg, where Frey-Law's 65 deg column says how fast that is."""
    m = mujoco.MjModel.from_xml_string(body.xml)
    d = mujoco.MjData(m)
    m.opt.gravity[:] = 0
    sc = StrengthCaps(body, m)
    e, j = "R_elbow", body.joints["R_elbow"]
    q, v = m.jnt_qposadr[m.joint(e).id], m.jnt_dofadr[m.joint(e).id]
    a = m.actuator(f"a_{e}").id
    d.qpos[q] = math.radians(20 - j.rest)
    peak = caps((body, m, mujoco.MjData(m), sc), {e: 65})[e][1]
    d.qfrc_applied[v] = -load * peak
    col = [FLEXION[s][ANGLES.index(65)] / FLEXION[0][ANGLES.index(65)] for s in sorted(FLEXION)]
    want = float(np.interp(-load, [-x for x in col], sorted(FLEXION)))      # the speed where the curve gives load
    speed = None
    for _ in range(3000):
        d.ctrl[a] = d.qpos[q] + 100.0                                         # flat out
        sc.apply(d)
        mujoco.mj_step(m, d)
        assert abs(d.actuator_force[a]) <= m.actuator_forcerange[a, 1] + 1e-9
        if j.rest + math.degrees(d.qpos[q]) >= 65:
            speed = math.degrees(d.qvel[v])
            break
    assert speed is not None, "the elbow never reached 65 deg"
    assert speed == pytest.approx(want, abs=15), f"{speed:.0f} deg/s under {load:.0%}; the curve allows {want:.0f}"


@pytest.mark.farm
@pytest.mark.data_root
def test_the_vise_takes_plan_needs_no_more_than_the_curves_allow():
    """The body alone tracking the vise take's plan never needs a motor at its strength for that angle and speed.
    test_reference_take.py's saturation check reads each motor's static peak once; this reads the cap each step."""
    take = data_root() / "takes" / "setup-take"
    if not (take / "reference.npz").exists():
        pytest.skip(f"no planned take at {take}")
    from moonshot.sim.reference import ReferenceTake
    b = build()
    m = mujoco.MjModel.from_xml_string(b.xml)
    d = mujoco.MjData(m)
    plan = ReferenceTake(b, m, take)
    d.qpos[:], d.qvel[:], _ = plan.at(0.0)
    mujoco.mj_forward(m, d)
    ctl = Controller(b, m, d)
    saturated: dict[str, int] = {}
    for s in range(int(plan.duration / m.opt.timestep)):
        ctl.track(*plan.at(s * m.opt.timestep))
        lo, hi = m.actuator_forcerange[ctl.acts].T
        f = d.actuator_force[ctl.acts]
        for i in np.flatnonzero((f >= 0.999 * hi) | (f <= 0.999 * lo)):
            saturated[ctl.names[i]] = saturated.get(ctl.names[i], 0) + 1
    assert not saturated, f"steps at the curve's strength, per motor: {saturated}"
