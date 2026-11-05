"""The VF-2's table set up for a plate passes conformance before anything is filmed on it (plan Â§3.2): the 3/4 in MDF
spoilboard is level on the table where the plates' pose expects it (moonshot/motion/loads.py SPOILBOARD_TOP_Z), each
plan's plate laid on it rests at its true height and stays, the step clamps' studs stand in the table's T-slots clear
of the plate, a clamped clamp's nose bears on the plate's margin inside the outline's cutter path with its heel on its
block and the strap level, a parked clamp lies clear of the plate, and a nut turned on its stud runs along the
1/2-13 thread and clamps the plate so a push that would slide it doesn't. Protected (plan Â§6, rule 1).

The clamp kit is the shop's clamp-kit-1 (McMaster 8957A43: 5/8 in T-slots, 1/2-13 studs; shop.json), the table the
VF-2's three T-slots 4.921 in apart (shop.json vf2-1)."""
import math

import mujoco
import numpy as np
import pytest

from moonshot.contracts.thresholds import threshold
from moonshot.motion import loads, plates
from moonshot.planning.validate import load_plan
from moonshot.world import spoilboard as SB

IN = 25.4
SETUPS = plates.setups()
# the outline's cutter (plan: nist-ftc-09's 3/8 in end mill, ll-1005337's 1/2 in) runs outside the part's edge: a nose
# must stay out of its path, the stock's margin less the cutter's diameter
CUTTER_MM = {"nist-ftc-09": 0.375 * IN, "ll-1005337": 0.5 * IN}
PART_LONG_MM = {"nist-ftc-09": 11.0 * IN, "ll-1005337": 600.0}      # the finished part's length along the table


def build(part, setup, state="clamped", free=(), extra=""):
    p, cl = plates.plate(part, setup), plates.clamps(part, setup)
    m = mujoco.MjModel.from_xml_string(SB.standalone_xml(p, cl, state, free, extra))
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    return m, d, p, cl


def settle(m, d, seconds, before=None):
    for _ in range(int(seconds / m.opt.timestep)):
        if before:
            before()
        mujoco.mj_step(m, d)


def corners_mm(m, d, g):
    signs = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)])
    return (d.geom_xpos[g] + (signs * m.geom_size[g]) @ d.geom_xmat[g].reshape(3, 3).T) * 1000


def geoms(m, prefix):
    return [g for g in range(m.ngeom) if m.geom(g).name.startswith(prefix)]


def margin_clear_mm(part, setup) -> float:
    """How far onto the plate's end a nose may reach and stay out of the outline's cutter path (mm): the stock's
    margin past the part's end, less the cutter's diameter (its path runs a radius outside the edge)."""
    return (plates.plate(part, setup).size[0] - PART_LONG_MM[part]) / 2 - CUTTER_MM[part]


def test_the_spoilboard_is_36_x_14_x_3_4_in_mdf_level_where_the_plates_pose_expects_it():
    m, d, _, _ = build(*SETUPS[0])
    c = corners_mm(m, d, m.geom("spoilboard").id)
    assert sorted(np.ptp(c, axis=0)) == pytest.approx(sorted([0.75 * IN, 14 * IN, 36 * IN]), abs=0.01)
    top = c[c[:, 2] > c[:, 2].mean()]
    assert np.ptp(top[:, 2]) < 1e-6
    assert top[:, 2].max() == pytest.approx(loads.SPOILBOARD_TOP_Z, abs=0.01)
    assert c[:, 2].min() == pytest.approx(SB.TABLE_Z, abs=0.01)                  # on the table's top
    assert c[:, :2].mean(0) == pytest.approx(loads.SPOILBOARD_CENTRE_XY, abs=0.01)


@pytest.mark.parametrize("part,setup", SETUPS)
def test_the_plate_rests_on_the_spoilboard_at_its_true_height_and_stays(part, setup):
    m, d, p, _ = build(part, setup, "parked", free=())
    assert d.body("blank").xpos * 1000 == pytest.approx(loads.part_pose(load_plan(part), setup)["centre_mm"],
                                                        abs=0.01)
    settle(m, d, 1.0)
    rest = d.body("blank").xpos * 1000
    assert rest[2] - p.size[2] / 2 == pytest.approx(SB.TOP_Z, abs=0.05)
    settle(m, d, 1.0)
    assert np.linalg.norm(d.body("blank").xpos * 1000 - rest) < 0.01
    assert m.body_mass[m.body("blank").id] == pytest.approx(p.mass_kg, rel=1e-3)


@pytest.mark.parametrize("part,setup", SETUPS)
def test_each_stud_stands_upright_in_a_t_slot_clear_of_the_plate(part, setup):
    m, d, p, cl = build(part, setup)
    w = next(x for x in load_plan(part)["setups"] if x["id"] == setup)["workholding"]
    assert len(cl) == w["clamps"]
    lo, hi = p.centre - p.size / 2, p.centre + p.size / 2
    for i, k in enumerate(cl):
        g = m.geom(f"stud_{i}").id
        axis = d.geom_xmat[g].reshape(3, 3)[:, 2]
        assert axis[2] == pytest.approx(1.0, abs=1e-9)
        x, y, z = d.geom_xpos[g] * 1000
        assert min(abs(y - s) for s in SB.TSLOT_Y) < 1e-3, k.name
        assert z - m.geom_size[g][1] * 1000 < SB.TABLE_Z                         # its foot in the T-nut
        gap = max(lo[0] - x, x - hi[0])                                         # off the plate's end
        assert gap - SB.STUD_R >= 20.0, (k.name, gap)


@pytest.mark.parametrize("part,setup", SETUPS)
def test_each_clamped_nose_bears_on_the_margin_clear_of_the_cutter_heel_on_its_block_strap_level(part, setup):
    m, d, p, cl = build(part, setup)
    lo, hi = p.centre - p.size / 2, p.centre + p.size / 2
    clear = margin_clear_mm(part, setup)
    for k in cl:
        nose = corners_mm(m, d, m.geom(f"{k.name}_nose").id)
        heel = corners_mm(m, d, m.geom(f"{k.name}_heel").id)
        assert nose[:, 2].min() == pytest.approx(p.top, abs=0.2), k.name               # down on the plate
        on = (nose[:, 0] >= lo[0]) & (nose[:, 0] <= hi[0]) & (nose[:, 1] >= lo[1]) & (nose[:, 1] <= hi[1])
        assert on.any(), k.name
        reach = np.minimum(nose[:, 0] - lo[0], hi[0] - nose[:, 0]).max()
        assert 0 < reach <= clear, (k.name, reach, clear)
        over = nose[(nose[:, 0] >= lo[0]) & (nose[:, 0] <= hi[0])]                       # the pad over the plate
        assert (over[:, 1] >= lo[1] + 2.0).all() and (over[:, 1] <= hi[1] - 2.0).all(), k.name   # not off a side
        i = int(k.name.split("_")[1])
        block = np.vstack([corners_mm(m, d, g) for g in geoms(m, f"heel_block_{i}_")])
        step = corners_mm(m, d, m.geom(f"heel_block_{i}_0").id)
        assert heel[:, 2].min() == pytest.approx(step[:, 2].max(), abs=0.2), k.name   # the heel on its step
        assert block[:, 2].min() == pytest.approx(SB.TOP_Z, abs=1e-3)
        tilt = math.degrees(math.asin(abs(heel[:, 2].min() - nose[:, 2].min()) / np.linalg.norm(
            heel[:, :2].mean(0) - nose[:, :2].mean(0))))
        assert tilt < 0.5, (k.name, tilt)


@pytest.mark.parametrize("part,setup", SETUPS)
def test_a_parked_clamp_lies_still_on_the_spoilboard_clear_of_the_plate(part, setup):
    m, d, p, cl = build(part, setup, "parked", free=tuple(c.name for c in plates.clamps(part, setup)))
    lo, hi = p.centre - p.size / 2, p.centre + p.size / 2
    settle(m, d, 0.5)
    at = {k.name: d.body(k.name).xpos.copy() for k in cl}
    settle(m, d, 1.0)
    for k in cl:
        c = np.vstack([corners_mm(m, d, g) for g in geoms(m, f"{k.name}_") if "nut" not in m.geom(g).name])
        assert c[:, 2].min() == pytest.approx(SB.TOP_Z, abs=0.1), k.name
        gap = np.maximum(lo[0] - c[:, 0], c[:, 0] - hi[0]).min()
        assert gap >= 15.0, (k.name, gap)
        assert np.linalg.norm(d.body(k.name).xpos - at[k.name]) * 1000 < threshold("physics.placement_mm").value


def test_a_nut_spun_on_its_stud_runs_along_the_thread_down_onto_the_strap():
    """ll-1005337's first clamp, free on its stud, and its nut 6 mm up the stud: spun down at a turn a second, as
    fingers spin it, it runs 1.954 mm a turn (1/2-13) and comes to rest on the strap, which stays on the plate and its
    block. How hard a tightened nut bites isn't held here yet: the thread's turn-to-slide ratio, soft as MuJoCo makes
    it, gives under the 5 kN a clamp bites with, and how the thread is modelled waits on your decision."""
    part, setup = "ll-1005337", "op10"
    cl = plates.clamps(part, setup)
    name = cl[0].name
    m, d, p, _ = build(part, setup, "clamped", free=(name,))
    turn = m.jnt_qposadr[m.joint(f"{name}_nut_turn").id]
    slide = m.jnt_qposadr[m.joint(f"{name}_nut_slide").id]
    dof = m.jnt_dofadr[m.joint(f"{name}_nut_turn").id]
    d.qpos[slide] = SB.PARK_NUT_GAP_MM * 0.001                   # run up off the strap
    d.qpos[turn] = d.qpos[slide] / (SB.LEAD_MM * 0.001 / (2 * math.pi))
    mujoco.mj_forward(m, d)
    settle(m, d, 0.2)
    z0, a0 = d.qpos[slide], d.qpos[turn]
    c0 = d.body(name).xpos.copy()

    def spin():                                                   # fingers' torque, at most 0.1 N m
        d.qfrc_applied[dof] = float(np.clip(-0.05 * (d.qvel[dof] + 2 * math.pi), -0.1, 0.1))
    settle(m, d, 1.5, spin)
    run = (d.qpos[slide] - z0) * 1000
    turned = (d.qpos[turn] - a0) / (2 * math.pi)
    assert run == pytest.approx(turned * SB.LEAD_MM, rel=1e-3)   # along the thread
    assert run < -2.0
    settle(m, d, 2.5, spin)
    flange, strap = m.geom(f"{name}_nut_flange").id, {m.geom(f"{name}_rail_a").id, m.geom(f"{name}_rail_b").id}
    assert any({c.geom1, c.geom2} & strap and flange in (c.geom1, c.geom2) for c in d.contact[:d.ncon])
    assert d.qpos[slide] * 1000 == pytest.approx(0.0, abs=0.1)    # on the strap where it is clamped
    assert np.linalg.norm(d.body(name).xpos - c0) * 1000 < 0.2
