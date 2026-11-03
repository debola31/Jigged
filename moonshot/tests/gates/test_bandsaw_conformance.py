"""The band saw station passes conformance before anything is filmed on it (plan §3.2): it takes the stock its spec
says, its blade runs only inside the spec's speed range and only with both wheel guards shut, its vise screw keeps its
ratio, and its head lowers on the feed valve, holds when the valve is shut, lifts by hand and stops the blade at the
end of the cut. Protected (plan §6, rule 1).

The saw is McMaster-Carr 8962N13 (shop.json saw-1): 9 in round and 9 x 16 in rectangular capacity, blade speed
98-262 sfpm. Its head's joint is zero at the top stop and lowers positive; the movable jaw closes positive, and so does
the handwheel's positive turn; the wheel guards open positive. The feed is the vertical speed at which the middle of
the blade's cutting edge descends."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.contracts.thresholds import threshold
from moonshot.world.bandsaw import Control, record, standalone_xml

IN = 25.4
SFPM = 0.3048 / 60                       # m/s per surface foot per minute


@pytest.fixture
def saw():
    m = mujoco.MjModel.from_xml_string(standalone_xml())
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    return m, d


def adr(m, joint):
    return m.jnt_qposadr[m.joint(joint).id]


def dof(m, joint):
    return m.jnt_dofadr[m.joint(joint).id]


def put(m, d, joint, value):
    d.qpos[adr(m, joint)] = value
    mujoco.mj_forward(m, d)


def edge_above_bed_mm(d, x_mm):
    """The blade's cutting edge above the bed top at world x, on the straight run between the guides."""
    a, b = d.site("saw_blade_edge_a").xpos, d.site("saw_blade_edge_b").xpos
    t = (x_mm / 1000 - a[0]) / (b[0] - a[0])
    return (a[2] + t * (b[2] - a[2]) - d.site("saw_bed").xpos[2]) * 1000


def edge_mid(d):
    return (d.site("saw_blade_edge_a").xpos + d.site("saw_blade_edge_b").xpos) / 2


def opening_mm(d):
    return (d.site("saw_fixed_jaw_face").xpos[0] - d.site("saw_jaw_face").xpos[0]) * 1000


def blade_sfpm(m, d):
    return d.qvel[dof(m, "saw_blade")] * record()["blade"]["drive_radius_mm"] / 1000 / SFPM


def stroke_mm(m, d):
    """How far the middle of the cutting edge drops from the top stop to the bottom stop."""
    top, bottom = m.jnt_range[m.joint("saw_head").id]
    put(m, d, "saw_head", bottom)
    z = edge_mid(d)[2]
    put(m, d, "saw_head", top)
    return (edge_mid(d)[2] - z) * 1000


def descend(m, d, ctl, seconds):
    """Step the saw; the edge's descent speed at each step, mm/s."""
    z, speeds = edge_mid(d)[2], []
    for _ in range(int(seconds / m.opt.timestep)):
        ctl.step()
        speeds.append((z - edge_mid(d)[2]) * 1000 / m.opt.timestep)
        z = edge_mid(d)[2]
    return np.array(speeds)


def test_the_vise_opens_to_the_specs_16_in_and_closes_fully(saw):
    m, d = saw
    lo, hi = m.jnt_range[m.joint("saw_jaw").id]
    put(m, d, "saw_jaw", lo)
    assert opening_mm(d) >= 16 * IN - 0.5
    put(m, d, "saw_jaw", hi)
    assert opening_mm(d) == pytest.approx(0.0, abs=0.5)


def test_the_raised_blade_clears_9_in_stock_and_the_lowered_one_cuts_through_it(saw):
    m, d = saw
    top, bottom = m.jnt_range[m.joint("saw_head").id]
    fixed = d.site("saw_fixed_jaw_face").xpos[0] * 1000
    span = np.linspace(fixed - 16 * IN, fixed, 9)            # a 9 x 16 in bar against the fixed jaw
    put(m, d, "saw_head", top)
    assert min(edge_above_bed_mm(d, x) for x in span) >= 9 * IN
    put(m, d, "saw_head", bottom)
    assert max(edge_above_bed_mm(d, x) for x in span) < 0.0


def test_the_blade_runs_inside_the_specs_speed_range(saw):
    m, d = saw
    assert record()["blade"]["speed_sfpm"] == [98, 262]
    ctl = Control(m, d)
    for asked, runs_at in ((262, 262), (400, 262), (150, 150), (50, 98)):
        ctl.set_speed(asked)
        ctl.press("start")
        for _ in range(3000):
            ctl.step()
        assert ctl.state == "running"
        assert blade_sfpm(m, d) == pytest.approx(runs_at, rel=0.02)
        ctl.press("stop")
        for _ in range(3000):
            ctl.step()
        assert ctl.state == "idle" and abs(blade_sfpm(m, d)) < 1.0


def test_the_blade_runs_only_with_both_guards_shut(saw):
    m, d = saw
    ctl = Control(m, d)
    ctl.set_speed(200)
    for cover in ("saw_cover_idler", "saw_cover_drive"):
        put(m, d, cover, 0.5)                                  # half a radian open
        ctl.press("start")
        assert ctl.state == "idle" and "start_refused" in ctl.events
        for _ in range(500):
            ctl.step()
        assert abs(blade_sfpm(m, d)) < 1.0
        put(m, d, cover, 0.0)
    ctl.press("start")
    for _ in range(3000):
        ctl.step()
    assert ctl.state == "running" and blade_sfpm(m, d) > 150
    put(m, d, "saw_cover_drive", 0.3)                          # opened while running
    for _ in range(3000):
        ctl.step()
    assert ctl.state == "idle" and "guard_opened_stop" in ctl.events
    assert abs(blade_sfpm(m, d)) < 1.0


def test_the_vise_screw_keeps_its_ratio_and_the_quick_release_frees_the_jaw(saw):
    m, d = saw
    ctl = Control(m, d)
    lead = record()["joints"]["handwheel"]["lead_mm"]
    j0, w0 = d.qpos[adr(m, "saw_jaw")], d.qpos[adr(m, "saw_handwheel")]
    for _ in range(2000):
        d.qfrc_applied[dof(m, "saw_handwheel")] = 5.0          # a 5 N m turn of the handwheel
        ctl.step()
    turns = (d.qpos[adr(m, "saw_handwheel")] - w0) / (2 * math.pi)
    assert turns > 1.0
    travel = (d.qpos[adr(m, "saw_jaw")] - j0) * 1000
    assert abs(travel - turns * lead) <= threshold("physics.mechanism_ratio_mm").value
    d.qfrc_applied[:] = 0.0
    jaw = m.body("saw_jaw").id
    j1 = d.qpos[adr(m, "saw_jaw")]
    for _ in range(1000):
        d.xfrc_applied[jaw, 0] = -40.0                         # a 40 N push to open it, screw engaged
        ctl.step()
    assert abs(d.qpos[adr(m, "saw_jaw")] - j1) * 1000 < 0.5    # the screw holds it
    ctl.release_vise()
    j2, w2 = d.qpos[adr(m, "saw_jaw")], d.qpos[adr(m, "saw_handwheel")]
    for _ in range(1000):
        d.xfrc_applied[jaw, 0] = -40.0
        ctl.step()
    assert (j2 - d.qpos[adr(m, "saw_jaw")]) * 1000 > 10.0      # released, it slides
    assert abs(d.qpos[adr(m, "saw_handwheel")] - w2) < 0.01    # and the handwheel stays put


def test_with_the_feed_valve_shut_the_head_holds(saw):
    m, d = saw
    ctl = Control(m, d)
    top, bottom = m.jnt_range[m.joint("saw_head").id]
    for at in (top, (top + bottom) / 2):
        put(m, d, "saw_head", at)
        p0 = edge_mid(d).copy()
        for _ in range(5000):
            ctl.step()
        assert np.linalg.norm(edge_mid(d) - p0) * 1000 < 0.1


def test_the_head_lowers_by_itself_at_the_valves_rate_and_stops_at_its_stop(saw):
    m, d = saw
    ctl = Control(m, d)
    top, bottom = m.jnt_range[m.joint("saw_head").id]
    fastest = record()["joints"]["head"]["feed_mm_s"][1]
    stroke = stroke_mm(m, d)
    for rate, seconds in ((fastest / 4, 3.0), (fastest, stroke / fastest + 2.0)):
        put(m, d, "saw_head", top)
        d.qvel[:] = 0.0
        ctl.set_feed(rate)
        speeds = descend(m, d, ctl, seconds)
        assert speeds.max() <= rate * 1.05
        assert np.median(speeds[speeds > 0.1]) == pytest.approx(rate, rel=0.10)
        ctl.set_feed(0.0)
    assert d.qpos[adr(m, "saw_head")] == pytest.approx(bottom, abs=math.radians(0.2))


def test_a_hand_lifts_the_head_back_up_with_the_valve_shut(saw):
    m, d = saw
    ctl = Control(m, d)
    top, bottom = m.jnt_range[m.joint("saw_head").id]
    put(m, d, "saw_head", bottom)
    head = m.body("saw_head").id
    for _ in range(3000):
        d.qfrc_applied[:] = 0.0
        mujoco.mj_applyFT(m, d, np.array([0.0, 0.0, 100.0]), np.zeros(3), d.site("saw_head_handle").xpos.copy(),
                          head, d.qfrc_applied)                # a 100 N lift at the handle (proposed: one hand)
        ctl.step()
    assert d.qpos[adr(m, "saw_head")] == pytest.approx(top, abs=math.radians(1.0))


def test_the_blade_stops_at_the_end_of_the_cut(saw):
    m, d = saw
    ctl = Control(m, d)
    fastest = record()["joints"]["head"]["feed_mm_s"][1]
    seconds = stroke_mm(m, d) / fastest + 2.0
    ctl.set_speed(200)
    ctl.press("start")
    ctl.set_feed(fastest)
    descend(m, d, ctl, seconds)
    assert ctl.state == "idle" and "end_of_cut" in ctl.events
    for _ in range(3000):
        ctl.step()
    assert abs(blade_sfpm(m, d)) < 1.0


def test_at_rest_it_stays_at_rest(saw):
    m, d = saw
    ctl = Control(m, d)
    q0 = d.qpos.copy()
    for _ in range(2000):
        ctl.step()
    assert np.abs(d.qpos - q0).max() < 5e-5                    # 0.05 mm, or 0.05 mm a metre out on a hinge


def test_controls_are_sites(saw):
    m, _ = saw
    for s in ("saw_start", "saw_stop", "saw_feed_valve", "saw_head_handle", "saw_handwheel_rim", "saw_quick_release",
              "saw_cover_idler_handle", "saw_cover_drive_handle"):
        assert m.site(s).id >= 0
