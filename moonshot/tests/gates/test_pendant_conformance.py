"""The VF-2's pendant passes conformance before a setting take is filmed on it (plan §3.2): the jog handle, buttons
and E-stop stand where Haas's CAD has them, the handle clicks through 100 detents a turn and jogs the selected axis
by the selected increment per detent, a key registers only when pressed hard enough, and the offset keys write what
the machine's position says. Protected (plan §6, rule 1).

The CAD numbers are measured from the pendant's GLB (library/machines/vf2/links/pendant.glb, station frame, mm),
not from the station record, so the record can't drift from the machine it describes. Machine coordinates follow
Haas's: +X moves the table left (the tool right across the part), +Y moves it toward the operator, +Z raises the
head, and each is 0 at home."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.world.vf2 import Control, record, standalone_xml

FACE_Y = -986.3                                        # the pendant's face
HANDLE = (677.4, 1410.5, 40.0, -1023.1)                # centre x, z; radius; front face y
BUTTONS = {"cycle_start": (649.6, 1300.0), "feed_hold": (705.5, 1300.0)}   # 31.5 mm across, front at y -996.4
ESTOP = (677.7, 1531.5, -1035.2)                       # centre x, z; front y
INCH = 25.4


@pytest.fixture
def vf2():
    """The table mid-travel in X and Y (at home, X and Y are at the end of their travel), the head at home."""
    m = mujoco.MjModel.from_xml_string(standalone_xml())
    d = mujoco.MjData(m)
    for a in ("x", "y"):
        lo, hi = m.jnt_range[m.joint(f"vf2_{a}").id]
        d.qpos[m.jnt_qposadr[m.joint(f"vf2_{a}").id]] = (lo + hi) / 2
    mujoco.mj_forward(m, d)
    return m, d


def _extent(m, d, geom, axis):
    """The geom's near and far faces along a world axis (mm), from its world box or cylinder."""
    g = m.geom(geom).id
    R = d.geom_xmat[g].reshape(3, 3)
    size = m.geom_size[g]
    if m.geom_type[g] == mujoco.mjtGeom.mjGEOM_CYLINDER:
        half = np.abs(R[axis, 2]) * size[1] + np.sqrt(max(0.0, 1 - R[axis, 2] ** 2)) * size[0]
    else:
        half = np.abs(R[axis, :3]) @ size[:3]
    c = d.geom_xpos[g][axis]
    return (c - half) * 1000, (c + half) * 1000


def test_the_pendant_face_jog_handle_buttons_and_estop_are_where_the_cad_has_them(vf2):
    m, d = vf2
    assert _extent(m, d, "vf2_pendant_face", 1)[0] == pytest.approx(FACE_Y, abs=1.0)
    x, z, r, front = HANDLE
    c = d.body("vf2_jog_handle").xpos * 1000
    assert c[[0, 2]] == pytest.approx([x, z], abs=1.5)
    assert _extent(m, d, "vf2_jog_handle", 1)[0] == pytest.approx(front, abs=1.0)
    assert _extent(m, d, "vf2_jog_handle", 0) == pytest.approx((x - r, x + r), abs=1.5)
    for b, (bx, bz) in BUTTONS.items():
        g = m.geom(f"vf2_{b}_button").id
        assert d.geom_xpos[g][[0, 2]] * 1000 == pytest.approx([bx, bz], abs=1.5), b
        assert _extent(m, d, f"vf2_{b}_button", 1)[0] == pytest.approx(-996.4, abs=1.0), b
        assert d.site(f"vf2_{b}").xpos[[0, 2]] * 1000 == pytest.approx([bx, bz], abs=1.5), b
    ex, ez, efront = ESTOP
    assert d.geom_xpos[m.geom("vf2_estop").id][[0, 2]] * 1000 == pytest.approx([ex, ez], abs=1.5)
    assert _extent(m, d, "vf2_estop", 1)[0] == pytest.approx(efront, abs=1.5)


def test_every_key_sits_on_the_pendant_face(vf2):
    m, d = vf2
    keys = record()["affordances"]["keys"]["at_mm"]
    assert {"handle_jog", "inc_0.001", "inc_0.01", "inc_0.1", "+x", "+y", "+z", "offset", "part_zero_set",
            "tool_offset_measure", "enter", "mdi"} <= set(keys)
    lo_x, hi_x = _extent(m, d, "vf2_pendant_face", 0)
    lo_z, hi_z = _extent(m, d, "vf2_pendant_face", 2)
    for k in keys:
        p = d.site(f"vf2_key_{k}").xpos * 1000
        assert p[1] == pytest.approx(FACE_Y, abs=1.0), k
        assert lo_x < p[0] < hi_x and lo_z < p[2] < hi_z, k


def _turn(m, d, ctl, detents, settle=300):
    """Turn the handle by hand: drive its hinge to `detents` more detents, then let go and let it settle."""
    q = m.jnt_qposadr[m.joint("vf2_jog").id]
    target = d.qpos[q] + math.radians(3.6) * detents
    dof = m.jnt_dofadr[m.joint("vf2_jog").id]
    for _ in range(3000):
        d.qfrc_applied[dof] = 2.0 * (target - d.qpos[q]) - 0.02 * d.qvel[dof]
        ctl.step()
        if abs(target - d.qpos[q]) < 1e-3 and abs(d.qvel[dof]) < 0.05:     # let go once it has stopped
            break
    d.qfrc_applied[dof] = 0.0
    for _ in range(settle):
        ctl.step()


def _press(ctl, key, force=3.0):
    ctl.touch({key: force})
    ctl.step()
    ctl.touch({})
    ctl.step()


def test_the_handle_clicks_into_100_detents_a_turn(vf2):
    m, d = vf2
    ctl = Control(m, d)
    q = m.jnt_qposadr[m.joint("vf2_jog").id]
    d.qpos[q] = math.radians(3.6 * 1.3)                # let go between detents: it falls into the nearest
    for _ in range(500):
        ctl.step()
    assert math.degrees(d.qpos[q]) / 3.6 == pytest.approx(1.0, abs=0.1)
    assert record()["affordances"]["jog_handle"]["detents_per_turn"] == 100


def test_clockwise_is_positive_and_turns_the_rim_to_the_right(vf2):
    """Clockwise as the operator sees it: the top of the dial moves to their right (+x)."""
    m, d = vf2
    x0 = d.site("vf2_jog_rim").xpos[0]
    _turn(m, d, Control(m, d), 5)
    assert d.site("vf2_jog_rim").xpos[0] > x0


def test_in_handle_jog_each_detent_moves_the_selected_axis_by_the_increment(vf2):
    m, d = vf2
    ctl = Control(m, d)
    for k in ("handle_jog", "+x", "inc_0.001"):
        _press(ctl, k)
    x0 = ctl.machine_mm().copy()
    _turn(m, d, ctl, 25)
    assert ctl.machine_mm() - x0 == pytest.approx([25 * 0.001 * INCH, 0, 0], abs=0.002)
    qx = d.qpos[m.jnt_qposadr[m.joint("vf2_x").id]]
    _press(ctl, "inc_0.01")
    _turn(m, d, ctl, -10)
    assert ctl.machine_mm()[0] - x0[0] == pytest.approx((25 * 0.001 - 10 * 0.01) * INCH, abs=0.002)
    assert d.qpos[m.jnt_qposadr[m.joint("vf2_x").id]] > qx, "-X moves the table to the right"
    for k in ("+z", "inc_0.1"):
        _press(ctl, k)
    _turn(m, d, ctl, -4)
    assert ctl.machine_mm()[2] - x0[2] == pytest.approx(-4 * 0.1 * INCH, abs=0.002)


def test_outside_handle_jog_the_handle_moves_nothing(vf2):
    m, d = vf2
    ctl = Control(m, d)
    x0 = ctl.machine_mm().copy()
    _turn(m, d, ctl, 30)
    assert ctl.machine_mm() == pytest.approx(x0, abs=1e-3)


def test_a_key_registers_once_and_only_when_pressed_hard_enough(vf2):
    m, d = vf2
    ctl = Control(m, d)
    actuation = record()["affordances"]["keys"]["actuation_n"]
    ctl.touch({"handle_jog": 0.5 * actuation})
    ctl.step()
    assert ctl.mode != "handle_jog" and not ctl.pressed
    for _ in range(50):                                     # held down: still one press
        ctl.touch({"handle_jog": 1.5 * actuation})
        ctl.step()
    assert ctl.mode == "handle_jog" and [k for _, k in ctl.pressed] == ["handle_jog"]


def test_part_zero_set_writes_the_axis_position_and_enter_adds_what_was_typed(vf2):
    m, d = vf2
    ctl = Control(m, d)
    for k in ("handle_jog", "+x", "inc_0.1"):
        _press(ctl, k)
    _turn(m, d, ctl, -20)
    for k in ("offset", "part_zero_set"):                  # the work offsets, the cursor on G54 X
        _press(ctl, k)
    x = ctl.machine_mm()[0]
    assert ctl.work["G54"][0] == pytest.approx(x, abs=1e-3)          # the servo settles by nanometres
    for k in ("-", "8", "2", ".", "5", "5", "enter"):
        _press(ctl, k)
    assert ctl.work["G54"][0] == pytest.approx(x - 82.55, abs=1e-3)
    for k in ("right", "right", "part_zero_set"):          # the cursor to G54 Z
        _press(ctl, k)
    assert ctl.work["G54"][2] == pytest.approx(ctl.machine_mm()[2], abs=1e-3)


def test_tool_offset_measure_writes_the_spindle_z_into_the_tool_in_the_spindle(vf2):
    m, d = vf2
    ctl = Control(m, d, tool=1)
    for k in ("handle_jog", "+z", "inc_0.1"):
        _press(ctl, k)
    _turn(m, d, ctl, -30)
    for k in ("offset", "offset", "tool_offset_measure"):  # the second press pages to the tool offsets
        _press(ctl, k)
    assert ctl.tool_length[1] == pytest.approx(ctl.machine_mm()[2], abs=1e-3)
    assert ctl.machine_mm()[2] == pytest.approx(-30 * 0.1 * INCH, abs=0.01)
