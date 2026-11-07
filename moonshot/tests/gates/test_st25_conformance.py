"""The Haas ST-25 station passes conformance before anything is filmed on it (plan §3.2): its axes have the spec's
travel and speed, its door opens only when pulled, its chucks close by the drawtube with their makers' stroke and
grip, its turret indexes its 12 stations, its tool setter's arm swings into the tools' path, and its interlocks block
what Haas's manual says they block. Protected (plan §6, rule 1).

Sources, by the numbers they give:
- Haas, ST-25 specifications (haascnc.com, read 2026-11-06): X 8.40 in (213 mm), Z 22.50 in (572 mm), rapids
  945 ipm (24.0 m/min) on both, 3,400 rpm, 300 ft-lbf (407 N m) at 500 rpm, 10 in hydraulic chuck, 12-station BOT
  turret, the tailstock not standard.
- Haas, 2023 Lathe Operator's Manual, 3.5 Run/Setup Mode Restrictions (door open): Cycle Start, spindle FWD/REV, tool
  change (turret) and the probe arm not allowed in either mode; handle jog allowed in setup mode only; chuck clamp and
  unclamp allowed in both. "In Run and in Setup mode, the enclosure doors are locked closed during CNC program
  execution, spindle rotation or axis movement."
- Haas Settings 283 (no unclamp above its rpm) and 284 (Cycle Start with the chuck unclamped, off unless set); M10/M11
  clamp and unclamp; M104/M105 the probe arm; the NGC foot pedal (TG0066): chuck clamp and unclamp.
- Kitagawa, BR10 specifications (kitagawa.global, read 2026-11-06): jaw stroke 8.8 mm on the diameter, plunger stroke
  19 mm, 49 kN draw bar pull for 123 kN static grip (OD).
- Royal Products 42057 (royalproducts.com, read 2026-11-06) and its instructions R220001 rev D: a pullback collet
  chuck, the collet drawn in to close by the drawtube, 4,490 lbf drawbar for 15,750 lbf clamping.
"""
import math

import mujoco
import numpy as np
import pytest

from moonshot.world.st25 import Control, record, standalone_xml

INCH = 25.4
RAPID_MM_S = 945 * INCH / 60                 # 945 ipm
BR10 = {"stroke_dia_mm": 8.8, "plunger_mm": 19.0, "grip_per_pull": 123.0 / 49.0}
ROYAL = {"grip_per_pull": 15750.0 / 4490.0}


def build(workholding="br10", **kw):
    m = mujoco.MjModel.from_xml_string(standalone_xml(workholding=workholding, **kw))
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    return m, d


@pytest.fixture
def st25():
    return build()


def q(m, d, joint):
    return d.qpos[m.jnt_qposadr[m.joint(joint).id]]


def travel_mm(m, joint):
    lo, hi = m.jnt_range[m.joint(joint).id]
    return (hi - lo) * 1000


def run(ctl, seconds):
    for _ in range(int(round(seconds / ctl.model.opt.timestep))):
        ctl.step()


def close_door(ctl):
    ctl.data.qpos[ctl.q["door"]] = 0.0
    mujoco.mj_forward(ctl.model, ctl.data)


def open_door(ctl):
    ctl.data.qpos[ctl.q["door"]] = 0.3
    mujoco.mj_forward(ctl.model, ctl.data)


# --- the axes -----------------------------------------------------------------------------------------------------

def test_axes_have_the_specs_travel(st25):
    m, _ = st25
    assert travel_mm(m, "st25_x") == pytest.approx(8.40 * INCH, abs=0.5)
    assert travel_mm(m, "st25_z") == pytest.approx(22.50 * INCH, abs=0.5)


def test_z_runs_along_the_spindle_and_x_square_to_it_through_its_axis(st25):
    """Z is parallel to the spindle's axis; X is square to it, on the slant, and its line runs through the spindle's
    axis, so a tool's tip moves along a radius (the turret's centre is on that line in Haas's CAD)."""
    m, d = st25
    zax = m.jnt_axis[m.joint("st25_z").id]
    xax = m.jnt_axis[m.joint("st25_x").id]
    sp = m.jnt_axis[m.joint("st25_spindle").id]
    assert abs(abs(float(np.dot(zax, sp))) - 1) < 1e-6
    assert abs(float(np.dot(xax, sp))) < 1e-6
    centre = d.site("st25_turret_centre").xpos
    axis_pt = d.site("st25_spindle_axis").xpos
    off = centre - axis_pt
    off -= np.dot(off, sp) * sp
    assert np.linalg.norm(np.cross(off / np.linalg.norm(off), xax)) < 2e-3


def test_an_axis_moves_at_rapid_speed_and_no_faster(st25):
    m, d = st25
    ctl = Control(m, d, program=[(-200.0, 0.0, 0.0)])
    close_door(ctl)
    ctl.clamp()
    run(ctl, 0.1)
    ctl.press("cycle_start")
    run(ctl, 0.3)
    x = -q(m, d, "st25_x") * 1000
    assert RAPID_MM_S * 0.3 * 0.9 < x <= RAPID_MM_S * 0.3 + 1.0


def test_a_program_runs_to_its_end(st25):
    m, d = st25
    ctl = Control(m, d, program=[(-50.0, -100.0, 1000.0), (-80.0, -200.0, 1000.0, 3000.0)])
    close_door(ctl)
    ctl.clamp()
    run(ctl, 0.1)
    ctl.press("cycle_start")
    run(ctl, 6.0)
    assert ctl.state == "idle" and "program_end" in ctl.events
    assert q(m, d, "st25_x") * 1000 == pytest.approx(-80.0, abs=0.5)
    assert q(m, d, "st25_z") * 1000 == pytest.approx(-200.0, abs=0.5)


# --- the spindle --------------------------------------------------------------------------------------------------

def test_the_spindle_reaches_its_top_speed_and_no_more(st25):
    m, d = st25
    assert record()["joints"]["spindle"]["max_rpm"] == 3400
    lo, hi = m.actuator_ctrlrange[m.actuator("a_st25_spindle").id]
    assert hi == pytest.approx(3400 * 2 * math.pi / 60, rel=1e-3)
    assert m.actuator_forcerange[m.actuator("a_st25_spindle").id][1] == pytest.approx(407.0, rel=0.01)
    ctl = Control(m, d)
    close_door(ctl)
    ctl.clamp()
    run(ctl, 0.1)
    ctl.spindle(5000.0)                     # past the top: held to 3,400
    run(ctl, 3.0)
    rpm = d.qvel[m.jnt_dofadr[m.joint("st25_spindle").id]] * 60 / (2 * math.pi)
    assert 3400 * 0.97 < rpm <= 3400 * 1.01


# --- the door and its interlocks ----------------------------------------------------------------------------------

def test_the_door_stays_shut_unless_pulled_and_opens_when_pulled(st25):
    m, d = st25
    door = m.body("st25_door").id
    for _ in range(500):
        mujoco.mj_step(m, d)
    assert abs(q(m, d, "st25_door")) * 1000 < 1.0
    d.xfrc_applied[door, :3] = 40.0 * np.asarray(m.jnt_axis[m.joint("st25_door").id])   # a 40 N pull, opening it
    for _ in range(1000):
        mujoco.mj_step(m, d)
    assert q(m, d, "st25_door") * 1000 > 50.0


def test_the_door_opens_toward_the_headstock_far_enough_to_reach_the_chuck(st25):
    m, d = st25
    ax = m.jnt_axis[m.joint("st25_door").id]
    assert ax[0] < -0.99                                                # it slides toward -X, the spindle's end
    assert travel_mm(m, "st25_door") > 600


def test_with_the_door_open_cycle_start_spindle_turret_and_probe_arm_are_refused(st25):
    m, d = st25
    for setup in (False, True):
        ctl = Control(m, d, program=[(-10.0, -10.0, 500.0)], setup_mode=setup)
        open_door(ctl)
        ctl.clamp()
        run(ctl, 0.1)
        ctl.press("cycle_start")
        ctl.mdi("S500 M03")
        ctl.type_keys("T3")
        ctl.press("atc_fwd")
        ctl.mdi("M104")
        run(ctl, 0.5)
        assert ctl.state == "idle"
        assert "cycle_start_refused" in ctl.events
        assert abs(d.qvel[m.jnt_dofadr[m.joint("st25_spindle").id]]) < 1.0
        assert ctl.station == 1
        assert abs(q(m, d, "st25_probe_arm")) < 1e-3
        mujoco.mj_resetData(m, d)


def test_with_the_door_open_handle_jog_works_only_in_setup_mode(st25):
    m, d = st25
    for setup, moves in ((False, False), (True, True)):
        ctl = Control(m, d, setup_mode=setup)
        open_door(ctl)
        for k in ("handle_jog", "inc_0.01", "-z"):
            ctl.press(k)
        d.qpos[ctl.q["jog"]] -= 10 * 2 * math.pi / 100          # ten clicks, counter-clockwise: -Z
        run(ctl, 0.5)
        moved = abs(q(m, d, "st25_z")) * 1000
        assert (moved == pytest.approx(10 * 0.01 * INCH, abs=0.02)) if moves else moved < 0.01
        mujoco.mj_resetData(m, d)


def test_with_the_door_open_the_chuck_clamps_and_unclamps(st25):
    m, d = st25
    for setup in (False, True):
        ctl = Control(m, d, setup_mode=setup)
        open_door(ctl)
        ctl.press_pedal()
        run(ctl, 0.5)
        assert ctl.chuck == "clamped"
        ctl.press_pedal()
        run(ctl, 0.5)
        assert ctl.chuck == "unclamped"
        mujoco.mj_resetData(m, d)


def test_the_door_is_locked_while_the_spindle_turns(st25):
    m, d = st25
    ctl = Control(m, d)
    close_door(ctl)
    ctl.clamp()
    run(ctl, 0.1)
    ctl.spindle(500.0)
    run(ctl, 1.0)
    d.xfrc_applied[m.body("st25_door").id, :3] = 80.0 * np.asarray(m.jnt_axis[m.joint("st25_door").id])
    run(ctl, 1.0)
    assert abs(q(m, d, "st25_door")) * 1000 < 2.0
    d.xfrc_applied[:] = 0
    ctl.spindle(0.0)
    run(ctl, 2.0)
    assert not ctl.door_locked()


# --- the chuck: the Kitagawa BR10 on the drawtube -----------------------------------------------------------------

def test_the_three_jaws_move_together_through_the_makers_stroke():
    m, d = build("br10")
    ctl = Control(m, d)
    ctl.clamp()
    run(ctl, 1.0)                                    # nothing to grip: the jaws close the whole stroke
    r = [q(m, d, f"st25_jaw_{k}") * 1000 for k in range(3)]
    assert np.allclose(r, r[0], atol=0.02)
    assert 2 * r[0] == pytest.approx(BR10["stroke_dia_mm"], abs=0.1)
    assert q(m, d, "st25_drawtube") * 1000 == pytest.approx(BR10["plunger_mm"], abs=0.2)
    ctl.unclamp()
    run(ctl, 1.0)
    assert all(abs(q(m, d, f"st25_jaw_{k}")) * 1000 < 0.05 for k in range(3))


def turns_with_spindle(ctl, seconds=1.0):
    """(the spindle's turn, the bar's turn) over `seconds` (rad): a bar held without slipping turns as far."""
    m, d = ctl.model, ctl.data
    sp, bar = m.jnt_dofadr[m.joint("st25_spindle").id], m.jnt_dofadr[m.joint("test_bar").id]
    a_sp = a_bar = 0.0
    for _ in range(int(round(seconds / m.opt.timestep))):
        ctl.step()
        R = d.body("test_bar").xmat.reshape(3, 3)
        a_sp += d.qvel[sp] * m.opt.timestep
        a_bar += (R @ d.qvel[bar + 3:bar + 6])[0] * m.opt.timestep
    return a_sp, a_bar


def grip_n(m, d, part="test_bar"):
    """The chuck's gripping force on the part (N), as a maker measures it: each jaw's (or collet finger's) push on the
    part along its own stroke, summed over the jaws. A contact's normal force counts by its component along the
    jaw's slide, as a bore's arc spreads it over faces that lean from the jaw's line."""
    total, f = 0.0, np.zeros(6)
    pb = m.body(part).id
    for i in range(d.ncon):
        c = d.contact[i]
        b1, b2 = m.geom_bodyid[c.geom1], m.geom_bodyid[c.geom2]
        jaw = b1 if b2 == pb else b2
        if pb in (b1, b2) and m.body(jaw).name.startswith(("st25_jaw", "st25_collet")):
            mujoco.mj_contactForce(m, d, i, f)
            slide = d.xaxis[m.body_jntadr[jaw]]
            total += f[0] * abs(float(np.dot(c.frame[:3], slide)))
    return total


def test_the_br10_grips_with_its_makers_ratio_and_holds_a_bar_at_speed():
    m, d = build("br10", bore_mm=63.5, test_bar_mm=63.5)
    ctl = Control(m, d, clamp_n=10000.0)            # 10 kN draw, a fifth of the BR10's 49 kN
    ctl.clamp()
    run(ctl, 1.0)
    assert ctl.chuck == "clamped"
    assert grip_n(m, d) == pytest.approx(10000.0 * BR10["grip_per_pull"], rel=0.05)
    close_door(ctl)
    ctl.spindle(1000.0)
    run(ctl, 1.0)
    a_sp, a_bar = turns_with_spindle(ctl)
    assert a_sp > 100                                                # 1,000 rpm: 105 rad in the second
    assert a_bar == pytest.approx(a_sp, rel=0.005)                   # turning with it, not slipping


def test_the_chuck_wont_unclamp_while_turning_past_setting_283(st25):
    m, d = st25
    ctl = Control(m, d)
    close_door(ctl)
    ctl.clamp()
    run(ctl, 0.2)
    ctl.spindle(1000.0)
    run(ctl, 1.0)
    ctl.press_pedal()
    run(ctl, 0.2)
    assert ctl.chuck == "clamped" and "unclamp_refused" in ctl.events


def test_the_spindle_wont_start_or_cycle_start_with_the_chuck_unclamped(st25):
    m, d = st25
    ctl = Control(m, d, program=[(-10.0, -10.0, 500.0)])
    close_door(ctl)
    ctl.spindle(500.0)
    ctl.press("cycle_start")
    run(ctl, 0.5)
    assert abs(d.qvel[m.jnt_dofadr[m.joint("st25_spindle").id]]) < 1.0
    assert ctl.state == "idle" and "cycle_start_refused" in ctl.events


def test_m10_and_m11_clamp_and_unclamp(st25):
    m, d = st25
    ctl = Control(m, d)
    close_door(ctl)
    ctl.mdi("M10")
    run(ctl, 0.5)
    assert ctl.chuck == "clamped"
    ctl.mdi("M11")
    run(ctl, 0.5)
    assert ctl.chuck == "unclamped"


def test_the_foot_pedal_is_a_pedal_that_springs_back_and_toggles_the_chuck(st25):
    m, d = st25
    ctl = Control(m, d)
    pedal = m.body("st25_pedal").id
    d.xfrc_applied[pedal, 2] = -60.0                  # a foot's push down on the pedal
    run(ctl, 0.3)
    assert ctl.chuck == "clamped"
    d.xfrc_applied[pedal, 2] = 0.0
    run(ctl, 0.5)
    assert abs(q(m, d, "st25_pedal")) < math.radians(0.5)        # sprung back
    assert ctl.chuck == "clamped"                                # one press, one toggle
    d.xfrc_applied[pedal, 2] = -60.0
    run(ctl, 0.3)
    assert ctl.chuck == "unclamped"


# --- the chuck: the Royal 5C collet chuck -------------------------------------------------------------------------

def test_the_collet_chuck_closes_on_a_bar_with_its_makers_ratio():
    m, d = build("c5", test_bar_mm=0.625 * INCH)
    ctl = Control(m, d, clamp_n=5000.0)             # about a quarter of the 5C's 4,490 lbf (20 kN) drawbar
    ctl.press_pedal()
    run(ctl, 1.0)
    assert ctl.chuck == "clamped"
    assert grip_n(m, d) == pytest.approx(5000.0 * ROYAL["grip_per_pull"], rel=0.05)
    close_door(ctl)
    ctl.spindle(2000.0)
    run(ctl, 1.0)
    a_sp, a_bar = turns_with_spindle(ctl)
    assert a_sp > 200
    assert a_bar == pytest.approx(a_sp, rel=0.005)


def test_the_open_collet_clears_its_bar_and_closes_under_its_size():
    """Open (the drawtube pushed out), the 5/8 in collet's bore clears a 5/8 in bar; drawn in on nothing, it closes
    under that size, so it grips a bar at the bottom of its size."""
    m, d = build("c5")
    bar_r = 0.625 * INCH / 2

    def bore_r():
        sp = d.site("st25_spindle_axis").xpos
        return [np.linalg.norm((d.site(f"st25_collet_face_{k}").xpos - sp)[1:]) * 1000 for k in range(3)]

    assert min(bore_r()) > bar_r
    ctl = Control(m, d, clamp_n=2000.0)
    ctl.clamp()
    run(ctl, 1.0)
    assert max(bore_r()) < bar_r


# --- the turret ---------------------------------------------------------------------------------------------------

def test_the_turret_has_12_stations_and_indexes_to_the_one_asked_for(st25):
    m, d = st25
    assert record()["turret"]["stations"] == 12
    ctl = Control(m, d)
    close_door(ctl)
    ctl.press("mdi")
    ctl.type_keys("T7")
    ctl.press("atc_fwd")
    run(ctl, 3.0)
    assert ctl.station == 7
    ang = q(m, d, "st25_turret")
    assert (math.degrees(ang) % 360) == pytest.approx(6 * 30.0, abs=0.1)
    ctl.press("atc_fwd")                                             # the next station
    run(ctl, 1.5)
    assert ctl.station == 8


def test_every_station_has_its_mounting_frame(st25):
    m, _ = st25
    for k in range(1, 13):
        assert m.site(f"st25_station_{k}").id >= 0


def test_the_active_station_faces_the_spindle(st25):
    m, d = st25
    sp = d.site("st25_spindle_axis").xpos
    s1 = d.site("st25_station_1").xpos
    c = d.site("st25_turret_centre").xpos
    # station 1, at home, is the station nearest the spindle's axis
    assert np.linalg.norm((s1 - sp)[1:]) < np.linalg.norm((c - sp)[1:])
    for k in range(2, 13):
        assert np.linalg.norm((d.site(f"st25_station_{k}").xpos - sp)[1:]) > np.linalg.norm((s1 - sp)[1:])


# --- the tool setter's arm (the automatic tool presetter, Haas's option, in the STEP) -----------------------------

def test_m104_swings_the_probe_arm_into_the_tools_plane_and_m105_back(st25):
    m, d = st25
    ctl = Control(m, d)
    close_door(ctl)
    ctl.mdi("M104")
    run(ctl, 3.0)
    assert ctl.probe_arm == "extended"
    tip = d.site("st25_probe_tip").xpos
    sp = d.site("st25_spindle_axis").xpos
    xax = m.jnt_axis[m.joint("st25_x").id]
    n = np.cross(m.jnt_axis[m.joint("st25_spindle").id], xax)        # square to the plane the tools move in
    assert abs(float(np.dot(tip - sp, n))) * 1000 < 2.0
    ctl.mdi("M105")
    run(ctl, 3.0)
    assert ctl.probe_arm == "retracted"


def test_a_tool_touching_the_probe_stops_the_axis_and_records_the_offset(st25):
    m, d = st25
    ctl = Control(m, d)
    close_door(ctl)
    ctl.mdi("M104")
    run(ctl, 3.0)
    ctl.probe_touch = lambda: True                                   # the stylus deflected
    ctl.press("handle_jog")
    ctl.press("inc_0.001")
    ctl.press("-x")
    x0 = q(m, d, "st25_x")
    d.qpos[ctl.q["jog"]] -= 20 * 2 * math.pi / 100
    run(ctl, 0.5)
    assert "probe_touch" in ctl.events
    assert abs(q(m, d, "st25_x") - x0) * 1000 < 0.05                  # stopped where it touched
    assert ctl.station in ctl.tool_offset and ctl.tool_offset[ctl.station]["x"] is not None


# --- the pendant ---------------------------------------------------------------------------------------------------

def test_pendant_buttons_keys_door_handle_and_pedal_are_sites(st25):
    m, _ = st25
    for s in ("st25_cycle_start", "st25_feed_hold", "st25_door_handle", "st25_pedal_pad", "st25_jog_rim",
              "st25_key_x_diameter_measure", "st25_key_z_face_measure", "st25_key_atc_fwd", "st25_key_handle_jog",
              "st25_key_fwd", "st25_key_stop"):
        assert m.site(s).id >= 0


def test_handle_jog_moves_by_the_increment_per_click(st25):
    m, d = st25
    ctl = Control(m, d)
    close_door(ctl)
    for k in ("handle_jog", "inc_0.001", "-x"):
        ctl.press(k)
    d.qpos[ctl.q["jog"]] -= 25 * 2 * math.pi / 100                   # 25 clicks counter-clockwise: -X
    run(ctl, 0.5)
    assert -q(m, d, "st25_x") * 1000 == pytest.approx(25 * 0.001 * INCH, abs=0.005)


def test_z_face_measure_and_x_diameter_measure_record_the_tools_offsets(st25):
    """Haas's Set a Tool Offset: Z FACE MEASURE records the machine Z; X DIAMETER MEASURE records the machine X, then
    the measured diameter typed and ENTER makes it the centreline's (the machine X less the diameter: X is in
    diameters)."""
    m, d = st25
    ctl = Control(m, d)
    close_door(ctl)
    d.qpos[ctl.q["z"]] = -0.3
    d.qpos[ctl.q["x"]] = -0.1
    mujoco.mj_forward(m, d)
    ctl.press("offset")
    ctl.press("z_face_measure")
    ctl.press("x_diameter_measure")
    ctl.type_keys("25.4")
    ctl.press("enter")
    t = ctl.tool_offset[ctl.station]
    assert t["z"] == pytest.approx(ctl.machine_mm()[1], abs=1e-6)
    assert t["x"] == pytest.approx(ctl.machine_mm()[0] - 25.4, abs=1e-6)
    assert ctl.machine_mm()[0] == pytest.approx(2 * -100.0, abs=1e-6)          # X in diameters


# --- what the station leaves out ----------------------------------------------------------------------------------

def test_the_tailstock_is_an_option_the_station_declares_absent(st25):
    m, _ = st25
    assert any("tailstock" in g.lower() for g in record()["gaps"])
    assert all("tailstock" not in m.joint(j).name for j in range(m.njnt))
