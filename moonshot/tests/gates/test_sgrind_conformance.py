"""The surface grinder station passes conformance before anything is filmed on it (plan §3.2): its table traverses past
both ends of its 10 x 24 in chuck, its handwheels keep their ratios and graduations, its wheel runs at its speed only
after ON and coasts to a stop after OFF, its guard leaves no more of the wheel open than OSHA allows, and its magnetic
chuck holds a part by a real force on it, scaled by the part's material, thickness and gap, when its lever is on, and
not when it is off. Protected (plan §6, rule 1).

The grinder is shop.json's grinder-1, a 10 x 24 manual grinder drawn from a GrabCAD STEP with no maker
(moonshot/library/stations/sgrind.json says where each number comes from). The makers' numbers this holds it to:
- South Bend SB1029 (6 x 18 manual) owner's manual: cross feed 0.2 in a turn in 0.001 in graduations; down feed
  0.05 in a turn in 0.0002 in graduations; the OFF button stays in until twisted, and ON doesn't start the machine
  until it is (Test Run, steps 6-9); the wheel is let come to a complete stop (Operation Overview, step 8);
- Clausing CSG2A1020 (10 x 20): its table traverses 4.41 in beyond its chuck, so this one 28.41 in;
- Sharp SG-618 (6 x 18 manual): 2.7 in of table a turn of the longitudinal handwheel;
- OSHA 29 CFR 1910.215(b)(4): a surface grinder's guard exposes at most 150 deg of the wheel, starting not more than
  15 deg above the spindle's horizontal plane;
- McMaster: a permanent-magnet chuck holds up to 30 psi (20.7 N/cm2) of a steel part's face.

Joint zero is the STEP's pose; the table's slide is positive to the right, the saddle's toward the column, the
wheelhead's up. Each handwheel turns positive clockwise as the operator at it sees it: the table's moves the table
right, the cross handwheel the saddle toward the column, the down-feed handwheel the wheel down. The chuck's lever is
off at zero and on at 180 deg.
"""
import math

import mujoco
import numpy as np
import pytest

from moonshot.contracts.thresholds import threshold
from moonshot.world.sgrind import Control, record, standalone_xml

IN = 25.4
SFPM = 0.3048 / 60                         # m/s per surface foot per minute


def build(loose: str = ""):
    m = mujoco.MjModel.from_xml_string(standalone_xml(loose))
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    return m, d


@pytest.fixture
def grinder():
    return build()


def adr(m, joint):
    return m.jnt_qposadr[m.joint(joint).id]


def dof(m, joint):
    return m.jnt_dofadr[m.joint(joint).id]


def put(m, d, joint, value):
    d.qpos[adr(m, joint)] = value
    mujoco.mj_forward(m, d)


def turn(m, d, ctl, joint, torque, steps):
    """Turn a handwheel with a steady torque, as a hand on it does."""
    for _ in range(steps):
        d.qfrc_applied[:] = 0.0
        d.qfrc_applied[dof(m, joint)] = torque
        ctl.step()
    d.qfrc_applied[:] = 0.0


def push(m, d, ctl, body, force, steps, at=None):
    """Push a body with a steady force (N, world) at a point (its centre of mass if none) for some steps."""
    b = m.body(body).id
    for _ in range(steps):
        d.qfrc_applied[:] = 0.0
        mujoco.mj_applyFT(m, d, np.asarray(force, float), np.zeros(3),
                          d.xipos[b].copy() if at is None else np.asarray(at, float), b, d.qfrc_applied)
        ctl.step()
    d.qfrc_applied[:] = 0.0


def block_xml(name, size_mm, at_mm, density=7850.0, friction=None):
    """A free box resting on the chuck's face: size_mm its full sides, at_mm its bottom face's middle."""
    face = record()["chuck"]
    mu = face["face_friction"] if friction is None else friction
    half = np.asarray(size_mm, float) / 2000
    c = np.asarray(at_mm, float) / 1000 + np.array([0, 0, half[2]])
    return (f'    <body name="{name}" pos="{c[0]:.6f} {c[1]:.6f} {c[2]:.6f}">\n'
            f'      <freejoint name="{name}"/>\n'
            f'      <geom name="{name}" type="box" size="{half[0]:.6f} {half[1]:.6f} {half[2]:.6f}" '
            f'density="{density}" friction="{mu} 0.004 0.0001" contype="1" conaffinity="3" priority="1" '
            f'solref="0.002 1" solimp="0.95 0.99 0.001"/>\n'
            f'    </body>\n')


def on_chuck(x_mm=-150.0, y_mm=None, lift_mm=0.0):
    """A point on the chuck's face (world mm at joint zero), lift_mm above it."""
    c = record()["chuck"]
    y = c["centre_mm"][1] if y_mm is None else y_mm
    return np.array([x_mm, y, c["face_z_mm"] + lift_mm])


def settle(ctl, steps=300):
    for _ in range(steps):
        ctl.step()


def moved_mm(d, m, body, p0):
    return float(np.linalg.norm(d.xpos[m.body(body).id] - p0) * 1000)


def switch_on(m, d, ctl):
    put(m, d, "sg_chuck_lever", math.pi)


# --- the table, the saddle and the wheelhead ---------------------------------------------------------------------

def test_the_chuck_is_10_by_24_in_and_the_wheel_10_by_1_in(grinder):
    m, _ = grinder
    face = m.geom("sg_chuck_face")
    assert 2000 * face.size[0] == pytest.approx(24 * IN, abs=0.5)
    assert 2000 * face.size[1] == pytest.approx(10 * IN, abs=0.5)
    wheel = m.geom("sg_wheel")
    assert 1000 * wheel.size[0] == pytest.approx(5 * IN, abs=0.5)           # radius
    assert 2000 * wheel.size[1] == pytest.approx(1 * IN, abs=0.5)           # width


def test_the_table_traverses_28_41_in_and_carries_the_whole_chuck_past_the_wheel(grinder):
    m, d = grinder
    lo, hi = m.jnt_range[m.joint("sg_table").id]
    assert (hi - lo) * 1000 == pytest.approx((24 + 4.41) * IN, abs=0.5)
    half = m.geom("sg_chuck_face").size[0]
    for q, far_end in ((lo, +1), (hi, -1)):
        put(m, d, "sg_table", q)
        end_x = d.geom("sg_chuck_face").xpos[0] + far_end * half
        wheel_x = d.site("sg_wheel_bottom_head").xpos[0]
        assert -far_end * (end_x - wheel_x) * 1000 >= 1 * IN                 # past the wheel by an inch or more


def test_the_longitudinal_handwheel_moves_the_table_2_7_in_a_turn_and_a_push_turns_it_back(grinder):
    m, d = grinder
    ctl = Control(m, d)
    tol = threshold("physics.mechanism_ratio_mm").value
    x0, w0 = d.qpos[adr(m, "sg_table")], d.qpos[adr(m, "sg_table_handwheel")]
    turn(m, d, ctl, "sg_table_handwheel", 1.5, 1000)
    turns = (d.qpos[adr(m, "sg_table_handwheel")] - w0) / (2 * math.pi)
    assert turns > 0.5
    travel = (d.qpos[adr(m, "sg_table")] - x0) * 1000
    assert abs(travel - turns * 2.7 * IN) <= tol and travel > 0               # clockwise: the table goes right
    settle(ctl, 1000)
    w1 = d.qpos[adr(m, "sg_table_handwheel")]
    push(m, d, ctl, "sg_table", [-80.0, 0.0, 0.0], 1000)                     # a rack and pinion isn't self-locking
    assert d.qpos[adr(m, "sg_table_handwheel")] < w1 - 0.1


def test_the_cross_handwheel_feeds_0_2_in_a_turn_in_0_001_in_graduations_and_locks(grinder):
    m, d = grinder
    ctl = Control(m, d)
    tol = threshold("physics.mechanism_ratio_mm").value
    J = record()["joints"]["cross_handwheel"]
    assert J["lead_mm"] == pytest.approx(0.2 * IN) and J["graduations"] == 200
    assert J["lead_mm"] / J["graduations"] == pytest.approx(0.001 * IN)
    y0, w0 = d.qpos[adr(m, "sg_saddle")], d.qpos[adr(m, "sg_cross_handwheel")]
    turn(m, d, ctl, "sg_cross_handwheel", 1.5, 1000)
    turns = (d.qpos[adr(m, "sg_cross_handwheel")] - w0) / (2 * math.pi)
    assert turns > 0.25
    travel = (d.qpos[adr(m, "sg_saddle")] - y0) * 1000
    assert abs(travel - turns * 0.2 * IN) <= tol and travel > 0               # clockwise: toward the column
    assert ctl.cross_graduations() == pytest.approx(turns * 200, abs=0.5)
    settle(ctl, 500)
    y1 = d.qpos[adr(m, "sg_saddle")]
    push(m, d, ctl, "sg_table", [0.0, -400.0, 0.0], 1000)                    # past the ways' friction, the screw holds
    assert abs(d.qpos[adr(m, "sg_saddle")] - y1) * 1000 < 0.02


def test_the_downfeed_handwheel_lowers_the_wheel_0_05_in_a_turn_in_0_0002_in_graduations(grinder):
    m, d = grinder
    ctl = Control(m, d)
    tol = threshold("physics.mechanism_ratio_mm").value
    J = record()["joints"]["downfeed_handwheel"]
    assert J["lead_mm"] == pytest.approx(0.05 * IN) and J["graduations"] == 250
    assert J["lead_mm"] / J["graduations"] == pytest.approx(0.0002 * IN)
    h0, w0 = ctl.wheel_above_chuck_mm(), d.qpos[adr(m, "sg_downfeed_handwheel")]
    g0 = ctl.downfeed_graduations()
    turn(m, d, ctl, "sg_downfeed_handwheel", 1.5, 1000)
    turns = (d.qpos[adr(m, "sg_downfeed_handwheel")] - w0) / (2 * math.pi)
    assert turns > 0.25
    drop = h0 - ctl.wheel_above_chuck_mm()
    assert abs(drop - turns * 0.05 * IN) <= tol and drop > 0                  # clockwise: the wheel goes down
    assert ctl.downfeed_graduations() - g0 == pytest.approx(turns * 250, abs=0.5)   # the dial turns with it
    settle(ctl, 500)
    h1 = ctl.wheel_above_chuck_mm()
    settle(ctl, 3000)                                                         # the screw holds the head's weight
    assert abs(ctl.wheel_above_chuck_mm() - h1) < 0.002


def test_a_hand_turns_the_dial_alone_to_set_it_without_moving_the_wheel(grinder):
    m, d = grinder
    ctl = Control(m, d)
    turn(m, d, ctl, "sg_downfeed_handwheel", 1.5, 500)
    settle(ctl, 1000)
    h0, w0, g0 = ctl.wheel_above_chuck_mm(), d.qpos[adr(m, "sg_downfeed_handwheel")], ctl.downfeed_graduations()
    turn(m, d, ctl, "sg_downfeed_dial", -0.55, 200)                         # a fingertip turns the dial back
    settle(ctl, 1000)
    assert g0 - ctl.downfeed_graduations() > 2.0                              # the reading moved
    assert abs(d.qpos[adr(m, "sg_downfeed_handwheel")] - w0) < 1e-3          # the handwheel didn't
    assert abs(ctl.wheel_above_chuck_mm() - h0) < 0.002                       # nor the wheel


def test_the_wheel_comes_down_to_the_chuck_and_rises_10_in_above_it(grinder):
    m, d = grinder
    ctl = Control(m, d)
    lo, hi = m.jnt_range[m.joint("sg_wheelhead").id]
    put(m, d, "sg_wheelhead", lo)
    assert ctl.wheel_above_chuck_mm() == pytest.approx(0.0, abs=0.5)
    put(m, d, "sg_wheelhead", hi)
    assert ctl.wheel_above_chuck_mm() >= 10 * IN


# --- the wheel, its guard and its controls ------------------------------------------------------------------------

def test_the_wheel_runs_at_its_speed_only_after_on_and_inside_its_rating(grinder):
    m, d = grinder
    ctl = Control(m, d)
    S = record()["spindle"]
    rpm = S["rpm"]
    assert math.pi * S["wheel_mm"][0] / 1000 * rpm / 60 <= S["wheel_rated_sfpm"] * SFPM   # SB1029 safety rule 2
    ctl.press("start")
    settle(ctl, 5000)
    assert ctl.state == "running" and ctl.spindle_rpm() == pytest.approx(rpm, rel=0.02)
    assert ctl.spindle_rpm() <= rpm * 1.02


def test_off_stays_in_until_twisted_and_the_wheel_coasts_to_a_stop(grinder):
    m, d = grinder
    ctl = Control(m, d)
    ctl.press("start")
    settle(ctl, 5000)
    ctl.press("stop")
    assert ctl.state == "idle" and ctl.stop_in
    rpm, t = ctl.spindle_rpm(), 0.0
    settle(ctl, 2000)
    assert ctl.spindle_rpm() > 0.8 * rpm                                      # no brake: it coasts
    ctl.press("start")                                                        # OFF not reset: ON doesn't start it
    assert ctl.state == "idle" and "start_refused" in ctl.events
    while ctl.spindle_rpm() > 1.0 and t < 90.0:
        settle(ctl, 1000)
        t += 1.0
    assert 20.0 <= t + 2.0 <= 60.0                                            # stopped in 20-60 s
    ctl.twist_stop()
    assert not ctl.stop_in
    ctl.press("start")
    assert ctl.state == "running"


def test_the_guard_exposes_at_most_150_deg_of_the_wheel_starting_at_most_15_deg_above_horizontal(grinder):
    m, d = grinder
    centre = d.site("sg_wheel_centre").xpos.copy()
    radius = m.geom("sg_wheel").size[0]
    head, spindle = m.body("sg_wheelhead").id, m.body("sg_spindle").id
    gid = np.zeros(1, np.int32)
    open_deg = []
    for a in np.arange(0.0, 360.0, 0.5):                                       # a ray in the wheel's plane, from 0 = right
        v = np.array([math.cos(math.radians(a)), 0.0, math.sin(math.radians(a))])
        dist = mujoco.mj_ray(m, d, centre, v, None, 1, spindle, gid)
        covered = dist >= 0 and m.geom_bodyid[gid[0]] == head and dist < radius + 0.08
        if not covered:
            open_deg.append(a)
    exposure = len(open_deg) * 0.5
    assert 0 < exposure <= 150.0
    highest = max(math.degrees(math.asin(math.sin(math.radians(a)))) for a in open_deg)   # above the horizontal
    assert highest <= 15.0


def test_coolant_is_not_fitted():
    assert record()["coolant"]["fitted"] is False


# --- the magnetic chuck ---------------------------------------------------------------------------------------------

def test_the_lever_sets_the_field_and_rests_at_either_end(grinder):
    m, d = grinder
    ctl = Control(m, d)
    assert ctl.field() == pytest.approx(0.0, abs=1e-6)
    put(m, d, "sg_chuck_lever", math.pi / 2)
    assert ctl.field() == pytest.approx(0.5, abs=1e-6)
    for end in (0.0, math.pi):
        put(m, d, "sg_chuck_lever", end + (0.15 if end == 0.0 else -0.15))   # left a little short of either end
        settle(ctl, 2000)
        assert d.qpos[adr(m, "sg_chuck_lever")] == pytest.approx(end, abs=math.radians(1.0))
    assert ctl.field() == pytest.approx(1.0, abs=1e-4)
    put(m, d, "sg_chuck_lever", 0.0)
    turn(m, d, ctl, "sg_chuck_lever", 3.0, 2000)                              # too light a push: it stays off
    assert d.qpos[adr(m, "sg_chuck_lever")] < math.radians(20)
    turn(m, d, ctl, "sg_chuck_lever", 12.0, 2000)                             # a firm one turns it on
    settle(ctl, 1000)
    assert d.qpos[adr(m, "sg_chuck_lever")] == pytest.approx(math.pi, abs=math.radians(1.0))


def test_the_hold_follows_the_material_the_thickness_and_the_gap():
    C = record()["chuck"]
    m, d = build()
    ctl = Control(m, d)
    switch_on(m, d, ctl)
    p = ctl.pressure_n_cm2
    assert C["rated_n_cm2"] == pytest.approx(30 * 4.4482 / 6.4516, rel=0.01)  # 30 psi
    assert p("steel", 25.4) == pytest.approx(C["rated_n_cm2"], rel=1e-6)
    assert p("carbide", 3.175) == pytest.approx(0.064 * C["rated_n_cm2"], rel=0.01)
    assert p("aluminium", 25.4) == 0.0 and p("stainless_300", 25.4) == 0.0
    assert p("steel", 1.0) == pytest.approx(C["rated_n_cm2"] / 3.175, rel=0.01)   # thinner than a pole
    assert p("steel", 25.4, gap_mm=0.1) < 0.6 * C["rated_n_cm2"]
    assert p("steel", 25.4, gap_mm=1.0) < 0.1 * C["rated_n_cm2"]
    put(m, d, "sg_chuck_lever", 0.0)
    assert p("steel", 25.4) == 0.0


BLOCK = (76.2, 50.8, 25.4)                 # a 1-2-3 block on its 2 x 3 in face


def block_hold_n():
    C = record()["chuck"]
    return C["rated_n_cm2"] * BLOCK[0] * BLOCK[1] / 100


def test_on_the_chuck_holds_a_steel_block_against_a_push_and_a_lift_and_off_it_doesnt():
    C = record()["chuck"]
    mu = C["face_friction"]
    kg = 7850 * np.prod(BLOCK) * 1e-9
    m, d = build(block_xml("block", BLOCK, on_chuck()))
    ctl = Control(m, d, held={"block": "steel"})
    settle(ctl)
    p0 = d.xpos[m.body("block").id].copy()
    push(m, d, ctl, "block", [1.25 * mu * kg * 9.81, 0, 0], 500)              # off: it slides at its weight's friction
    assert moved_mm(d, m, "block", p0) > 2.0

    m, d = build(block_xml("block", BLOCK, on_chuck()))
    ctl = Control(m, d, held={"block": "steel"})
    switch_on(m, d, ctl)
    settle(ctl)
    hold = block_hold_n() + kg * 9.81
    p0 = d.xpos[m.body("block").id].copy()
    push(m, d, ctl, "block", [0.8 * mu * hold, 0, 0], 1000)                   # on: friction on the pull holds it
    assert moved_mm(d, m, "block", p0) < 0.1
    push(m, d, ctl, "block", [0, 0, 0.8 * hold], 1000)                        # and lifting under the pull doesn't
    assert moved_mm(d, m, "block", p0) < 0.1
    push(m, d, ctl, "block", [1.25 * mu * hold, 0, 0], 500)                   # past friction it slides
    assert moved_mm(d, m, "block", p0) > 2.0


def test_a_lift_past_the_pull_takes_the_block_off():
    kg = 7850 * np.prod(BLOCK) * 1e-9
    m, d = build(block_xml("block", BLOCK, on_chuck()))
    ctl = Control(m, d, held={"block": "steel"})
    switch_on(m, d, ctl)
    settle(ctl)
    p0 = d.xpos[m.body("block").id].copy()
    push(m, d, ctl, "block", [0, 0, 1.25 * (block_hold_n() + kg * 9.81)], 300)
    assert (d.xpos[m.body("block").id][2] - p0[2]) * 1000 > 5.0


def test_the_pull_on_the_part_is_the_chucks_pull_reversed():
    m, d = build(block_xml("block", BLOCK, on_chuck()))
    ctl = Control(m, d, held={"block": "steel"})
    switch_on(m, d, ctl)
    settle(ctl)
    part, chuck = ctl.wrench["block"], ctl.wrench["sg_chuck"]
    assert part[2] < 0 and abs(part[2]) == pytest.approx(block_hold_n(), rel=0.02)
    assert np.allclose(part[:3], -chuck[:3], atol=1e-6)
    b, c = m.body("block").id, m.body("sg_chuck").id
    total = part[3:] + chuck[3:] + np.cross(d.xipos[b] - d.xipos[c], part[:3])   # both about the chuck's centre
    assert np.abs(total).max() < 1e-6


def test_a_carbide_insert_gets_carbides_share_and_aluminium_none():
    insert = (15.0, 13.0, 3.175)
    C = record()["chuck"]
    mu = C["face_friction"]
    loose = (block_xml("insert", insert, on_chuck(-150.0), density=14900.0)
             + block_xml("alu", BLOCK, on_chuck(150.0), density=2700.0))
    m, d = build(loose)
    ctl = Control(m, d, held={"insert": "carbide", "alu": "aluminium"})
    switch_on(m, d, ctl)
    settle(ctl)
    pull = -ctl.wrench["insert"][2]
    assert pull == pytest.approx(0.064 * C["rated_n_cm2"] * insert[0] * insert[1] / 100, rel=0.02)
    assert np.abs(ctl.wrench.get("alu", np.zeros(6))).max() == 0.0
    kg = 14900 * np.prod(insert) * 1e-9
    p0 = d.xpos[m.body("insert").id].copy()
    push(m, d, ctl, "insert", [1.25 * mu * (pull + kg * 9.81), 0, 0], 500)   # a light push slides it
    assert moved_mm(d, m, "insert", p0) > 2.0
    kg = 2700 * np.prod(BLOCK) * 1e-9
    p0 = d.xpos[m.body("alu").id].copy()
    push(m, d, ctl, "alu", [1.25 * mu * kg * 9.81, 0, 0], 500)
    assert moved_mm(d, m, "alu", p0) > 2.0


def test_the_magnet_reaches_a_part_set_down_near_it_and_not_one_held_off_it():
    m, d = build(block_xml("block", BLOCK, on_chuck(lift_mm=1.0)))
    ctl = Control(m, d, held={"block": "steel"})
    switch_on(m, d, ctl)
    ctl.apply()
    mujoco.mj_forward(m, d)
    ctl.apply()
    pull = -ctl.wrench["block"][2]
    assert 0.0 < pull < 0.1 * block_hold_n()                                  # a millimetre off: a small pull
    m, d = build(block_xml("block", BLOCK, on_chuck(lift_mm=10.0)))
    ctl = Control(m, d, held={"block": "steel"})
    switch_on(m, d, ctl)
    ctl.apply()
    mujoco.mj_forward(m, d)
    ctl.apply()
    assert np.abs(ctl.wrench["block"]).max() == 0.0                           # out of its reach: none


def test_at_rest_it_stays_at_rest(grinder):
    m, d = grinder
    ctl = Control(m, d)
    q0 = d.qpos.copy()
    settle(ctl, 2000)
    assert np.abs(d.qpos - q0).max() < 5e-5


def test_controls_are_sites(grinder):
    m, _ = grinder
    for s in ("sg_start", "sg_stop", "sg_power_light", "sg_chuck_lever", "sg_table_handwheel_knob",
              "sg_table_handwheel_rim", "sg_cross_handwheel_knob", "sg_cross_handwheel_rim",
              "sg_downfeed_handwheel_knob", "sg_downfeed_handwheel_rim", "sg_downfeed_dial", "sg_chuck_centre",
              "sg_wheel_bottom_head"):
        assert m.site(s).id >= 0
