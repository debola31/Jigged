"""The grinder cell (moonshot/world/grind_cell.py) holds what a take needs: a triangle insert blocked in by three
keepers on the magnetic chuck stays trapped against a push once the chuck is on, the keepers' pinwheel doesn't
cross, the cell composes with the body model, and the grinder's state carries from one take to the next."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.body import skeleton
from moonshot.world import grind_cell as GC
from moonshot.world import sgrind as SG

IC, THICK, NOSE, CLEAR = 9.525, 3.175, 0.79375, 11.0       # ct-tpg322: 3/8 IC, 1/8 thick, 1/32 nose, 11 deg (P)


SHORT_MM = GC.KEEPER["size_mm"][0]   # the shop's keepers, 1-1/2 in long, which a pinwheel round the insert fits (below)
PARALLEL_MM = 152.4                  # the shop's 6 in parallels, which it doesn't


def blocked_in():
    """The insert in the middle of the chuck, its first flank along the table's travel facing the back, with three
    1-1/2 in keepers round it, all on the chuck's face."""
    top = GC.chuck_top_mm()
    centre = np.array([150.0, SG.record()["chuck"]["centre_mm"][1], top])
    asset, part = GC.part_body(GC.CHUCK, GC.triangle_insert_mm(IC, THICK, NOSE, CLEAR), centre, yaw_deg=90.0)
    keepers = "".join(GC.keeper_body(GC.CHUCK, i, c, yaw, SHORT_MM)
                      for i, (c, yaw) in enumerate(GC.pinwheel(centre, 90.0, IC, length_mm=SHORT_MM), 1))
    loose = part + keepers
    m = mujoco.MjModel.from_xml_string(GC.standalone_xml(GC.CHUCK, loose, asset))
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    return m, d, loose


def on_chuck(m, d, body):
    return d.xpos[m.body(body).id] - d.xpos[m.body("sg_chuck").id]


def pinwheel_span_mm(length_mm):
    """How far a pinwheel of keepers round the insert, its first flank along the travel, reaches across the table
    (y) from the insert's middle: (back, front)."""
    ys = []
    for c, yaw in GC.pinwheel(np.zeros(3), 90.0, IC, length_mm=length_mm):
        for s in (-1, 1):
            for t in (-1, 1):
                a = math.radians(yaw)
                ys.append(c[1] + s * length_mm / 2 * math.sin(a) + t * GC.KEEPER["size_mm"][1] / 2 * math.cos(a))
    return max(ys), -min(ys)


def test_six_inch_keepers_dont_fit_round_the_insert_and_short_ones_do():
    """A pinwheel's three keepers run 120 deg apart, so with a flank along the travel two run across the table. Six
    in long they reach 256 mm across it (122 behind the insert's middle, 134 in front), past the chuck's 254; and
    behind it, past the 38.7 mm behind the wheel's plane where the spindle's housing comes down to the chuck's face
    with the 6 in wheel at the work (sgrind.json joints.wheelhead). 1-1/2 in keepers reach 23 mm back and 35 in
    front."""
    depth = 2 * SG.record()["colliders"]["chuck_face"]["box_max_mm"][1] - 2 * SG.record()["chuck"]["centre_mm"][1]
    back, front = pinwheel_span_mm(PARALLEL_MM)
    assert back + front > depth and back > 38.7
    back, front = pinwheel_span_mm(SHORT_MM)
    assert back + front < depth and back < 38.7 + 5.0


def test_the_pinwheels_keepers_dont_cross_and_touch_nothing_at_rest():
    m, d, _ = blocked_in()
    keepers = {m.geom(f"chucked_keeper_{i}").id for i in (1, 2, 3)}
    for i in range(d.ncon):
        c = d.contact[i]
        if {c.geom1, c.geom2} <= keepers:
            assert c.dist > -1e-4, (m.geom(c.geom1).name, m.geom(c.geom2).name, c.dist)


def test_the_insert_is_trapped_by_its_keepers_once_the_chuck_is_on():
    m, d, loose = blocked_in()
    ctl = GC.control(m, d, loose)
    assert ctl.held == {"chucked_part": "carbide", "chucked_keeper_1": "steel", "chucked_keeper_2": "steel",
                        "chucked_keeper_3": "steel"}
    for _ in range(200):                                                      # set down, the chuck off: they settle
        ctl.step()
    lever = m.jnt_qposadr[m.joint("sg_chuck_lever").id]
    for k in range(500):                                                      # the lever turned on over half a second
        d.qpos[lever] = math.pi * min(1.0, (k + 1) / 400)
        ctl.step()
    assert -ctl.wrench["chucked_keeper_1"][2] > 80.0                           # a 1-1/2 x 1/2 in face: about 100 N
    assert 0.0 < -ctl.wrench["chucked_part"][2] < 2.0                          # the carbide: about a newton
    b = m.body("chucked_part").id
    p0 = on_chuck(m, d, "chucked_part").copy()
    k0 = {i: on_chuck(m, d, f"chucked_keeper_{i}").copy() for i in (1, 2, 3)}
    up = np.array([0.0, 0.0, THICK * 0.001])                                 # at its top face
    # a fingertip's nudge, 1 N each way along the travel and across it: what a take puts on it. A pass's grinding
    # forces (several to tens of N) aren't simulated, the grind being the cut simulation's work; on this 4.9 g part at
    # the 1 ms timestep they would move it a millimetre a step, past what contacts resolve
    for direction in ([1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]):
        for _ in range(300):
            d.qfrc_applied[:] = 0.0
            mujoco.mj_applyFT(m, d, 1.0 * np.array(direction, float), np.zeros(3), d.xpos[b] + up, b,
                              d.qfrc_applied)
            ctl.step()
    d.qfrc_applied[:] = 0.0
    # it shifts inside its pocket (0.05 mm at each top edge, the flanks undercut 0.62 mm by the clearance) and no
    # further; the keepers, held at hundreds of newtons, don't move
    assert np.linalg.norm(on_chuck(m, d, "chucked_part") - p0) * 1000 < 1.0
    for i, k in k0.items():
        assert np.linalg.norm(on_chuck(m, d, f"chucked_keeper_{i}") - k) * 1000 < 0.05


def test_a_sideways_knock_wedges_the_insert_up_over_its_keepers():
    """Its 11 deg clearance turns a keeper's push on its flank 11 deg upward: a sideways push lifts it by about 0.19 of
    itself, more than the carbide's pull and weight (about 1.2 N) once it passes about 6.5 N. In a pass the wheel's
    down-force, about twice its sideways force, keeps it seated; a knock without it lifts it out."""
    m, d, loose = blocked_in()
    ctl = GC.control(m, d, loose)
    for _ in range(200):
        ctl.step()
    lever = m.jnt_qposadr[m.joint("sg_chuck_lever").id]
    for k in range(500):
        d.qpos[lever] = math.pi * min(1.0, (k + 1) / 400)
        ctl.step()
    b = m.body("chucked_part").id
    z0 = d.xpos[b][2]
    for _ in range(300):
        d.qfrc_applied[:] = 0.0
        mujoco.mj_applyFT(m, d, np.array([10.0, 0.0, 0.0]), np.zeros(3), d.xpos[b] + [0.0, 0.0, THICK * 0.001], b,
                          d.qfrc_applied)
        ctl.step()
    assert (d.xpos[b][2] - z0) * 1000 > 1.0


def test_the_cell_composes_with_the_body_model():
    body = skeleton.build()
    _, _, loose = blocked_in()
    asset, _ = GC.part_body(GC.CHUCK, GC.triangle_insert_mm(IC, THICK, NOSE, CLEAR), [0, 0, 0])
    xml = GC.with_body(body.xml, GC.RIGHT, loose, asset, carried=("chucked_part",))
    m = mujoco.MjModel.from_xml_string(xml)
    assert m.actuator("a_sg_spindle").id > m.actuator(0).id or m.nu > 2
    assert m.equality("carry_chucked_part").id >= 0 and m.equality("sg_downfeed_screw").id >= 0
    glbs = SG.render_links()
    assert glbs["wheel"][1].endswith("wheel_dwheel-1a1r.glb") and "coolant_nozzle" in glbs


def test_the_grind_is_reported_only_while_the_wheel_is_inside_the_part():
    m, d, _ = blocked_in()
    head = m.jnt_qposadr[m.joint("sg_wheelhead").id]
    a = m.jnt_qposadr[m.joint("chucked_part").id]
    d.qpos[a:a + 2] = d.site("sg_wheel_bottom_head").xpos[:2]               # the insert's middle under the wheel
    d.qpos[head] = -0.150
    mujoco.mj_forward(m, d)
    assert not GC.grind_cut_active(m, d)                                       # the wheel well above it
    top = d.xpos[m.body("chucked_part").id][2] + THICK * 0.001
    d.qpos[head] += top - d.site("sg_wheel_bottom_head").xpos[2] - 0.0002          # 0.2 mm into its top
    mujoco.mj_forward(m, d)
    assert GC.grind_cut_active(m, d)


def test_the_grinders_state_carries_to_the_next_take():
    m, d, loose = blocked_in()
    ctl = GC.control(m, d, loose)
    d.qpos[m.jnt_qposadr[m.joint("sg_chuck_lever").id]] = math.pi
    d.qpos[m.jnt_qposadr[m.joint("sg_table").id]] = -0.25
    ctl.press("start")
    ctl.turn_coolant(True)
    for _ in range(300):
        ctl.step()
    state = GC.grinder_state(m, d, ctl, GC.CHUCK)
    m2, d2, loose2 = blocked_in()
    ctl2 = GC.control(m2, d2, loose2)
    GC.set_grinder(m2, d2, ctl2, state, GC.CHUCK)
    assert ctl2.state == "running" and ctl2.coolant_on
    assert d2.qpos[m2.jnt_qposadr[m2.joint("sg_table").id]] == pytest.approx(d.qpos[m.jnt_qposadr[m.joint("sg_table").id]])
    assert np.allclose(d2.xpos[m2.body("chucked_part").id], d.xpos[m.body("chucked_part").id], atol=1e-6)
