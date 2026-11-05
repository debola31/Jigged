"""The inspection bench passes conformance before anything is filmed on it (plan §3.2): its granite plate stands at its
height and is as flat as its grade, a part set anywhere on it rests at its true height, and each instrument rests
where the record puts it, wholly on its surface, and stays there. Protected (plan §6, rule 1).

The plate is the shop's 12 x 18 x 3 in grade A granite plate (shop.json height-gauge-1; the hgauge record) on its
34 in workbench (the bench record). Grade A at that size is flat to 0.0001 in (GGG-P-463c, ASME B89.3.7). Each
instrument's body frame has its underside at z = 0, so it rests at its surface's height."""
import mujoco
import numpy as np
import pytest

from moonshot.contracts.thresholds import threshold
from moonshot.world.inspection_bench import record, standalone_xml

IN = 25.4
GRADE_A_MM = 0.0001 * IN
GAUGE_RESOLUTION_MM = 0.0005 * IN          # the height gauge's (shop.json height-gauge-1)
INSTRUMENTS = {"cal6", "mic1", "dti", "gblock", "hgauge", "rough", "thread"}
BLOCK_HALF_MM = np.array([3.0, 2.0, 1.0]) * IN / 2      # a 1-2-3 block, lying on its 2 x 3 face
BLOCK_KG = 0.772                                       # 98.3 cm3 of steel


def build(loose: str = "", instruments: bool = True):
    m = mujoco.MjModel.from_xml_string(standalone_xml(loose, instruments=instruments))
    d = mujoco.MjData(m)
    mujoco.mj_forward(m, d)
    return m, d


def settle(m, d, seconds):
    for _ in range(int(seconds / m.opt.timestep)):
        mujoco.mj_step(m, d)


def corners_mm(m, d, geom):
    assert m.geom_type[geom] == mujoco.mjtGeom.mjGEOM_BOX
    signs = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)])
    return (d.geom_xpos[geom] + (signs * m.geom_size[geom]) @ d.geom_xmat[geom].reshape(3, 3).T) * 1000


def tops_mm(m, d):
    return {s: corners_mm(m, d, m.geom(f"insp_{g}").id)[:, 2].max() for s, g in (("plate", "plate"),
                                                                                ("bench", "bench_top"))}


def footprint_mm(m, d, surface):
    c = corners_mm(m, d, m.geom(f"insp_{'plate' if surface == 'plate' else 'bench_top'}").id)
    return c[:, :2].min(0), c[:, :2].max(0)


def instrument_geoms(m, name):
    b = m.body(f"insp_{name}").id
    return [g for g in range(m.ngeom) if m.geom_bodyid[g] == b]


def turned_deg(q0, q1):
    return np.degrees(2 * np.arccos(min(1.0, abs(float(np.dot(q0, q1))))))


def test_the_plate_is_12_x_18_x_3_in_grade_a_flat_and_level_on_its_34_in_bench():
    m, d = build()
    g = m.geom("insp_plate").id
    assert sorted(np.ptp(corners_mm(m, d, g), axis=0)) == pytest.approx(sorted([3 * IN, 12 * IN, 18 * IN]), abs=0.1)
    top = corners_mm(m, d, g)
    top = top[top[:, 2] > d.geom_xpos[g][2] * 1000]
    assert np.ptp(top[:, 2]) <= GRADE_A_MM                 # level and flat across its diagonal
    tops = tops_mm(m, d)
    assert tops["bench"] == pytest.approx(34 * IN, abs=0.1)
    assert tops["plate"] == pytest.approx(tops["bench"] + 3 * IN, abs=GRADE_A_MM)


def test_a_part_set_anywhere_on_the_plate_rests_at_its_true_height():
    m, d = build(instruments=False)
    g = m.geom("insp_plate").id
    centre, axes, half = d.geom_xpos[g] * 1000, d.geom_xmat[g].reshape(3, 3), m.geom_size[g] * 1000
    top = tops_mm(m, d)["plate"]
    spots = [(0.0, 0.0)] + [(sx * (half[0] - 60), sy * (half[1] - 40)) for sx in (-1, 1) for sy in (-1, 1)]
    loose = ""
    for i, (u, v) in enumerate(spots):                     # the middle and near each corner
        p = centre + axes @ np.array([u, v, 0.0])
        p[2] = top + BLOCK_HALF_MM[2] + 0.2                # let go 0.2 mm up
        loose += (f'<body name="block{i}" pos="{" ".join(f"{x / 1000:.6f}" for x in p)}"><freejoint/>'
                  f'<geom type="box" size="{" ".join(f"{x / 1000:.6f}" for x in BLOCK_HALF_MM)}" mass="{BLOCK_KG}"/>'
                  f'</body>\n')
    m, d = build(loose, instruments=False)
    settle(m, d, 1.0)
    rests = np.array([d.body(f"block{i}").xpos[2] * 1000 - BLOCK_HALF_MM[2] for i in range(len(spots))])
    assert np.abs(rests - top).max() <= GAUGE_RESOLUTION_MM  # a height read off this plate is true
    assert np.ptp(rests) <= GRADE_A_MM
    before = np.array([d.body(f"block{i}").xpos for i in range(len(spots))])
    settle(m, d, 2.0)
    after = np.array([d.body(f"block{i}").xpos for i in range(len(spots))])
    assert np.linalg.norm(after - before, axis=1).max() * 1000 < 0.001


def test_each_instrument_starts_where_the_record_puts_it():
    m, d = build()
    rests = record()["rests"]
    assert set(rests) == INSTRUMENTS
    assert rests["hgauge"]["on"] == "plate"                 # a height gauge reads from the plate
    tops = tops_mm(m, d)
    for k, r in rests.items():
        x, y = r["at_mm"]
        assert d.body(f"insp_{k}").xpos * 1000 == pytest.approx([x, y, tops[r["on"]]], abs=0.01)


def test_each_instrument_settles_where_it_was_put_and_stays_there():
    m, d = build()
    start = {k: (d.body(f"insp_{k}").xipos.copy(), d.body(f"insp_{k}").xquat.copy()) for k in INSTRUMENTS}
    settle(m, d, 1.0)
    settled = {k: (d.body(f"insp_{k}").xipos.copy(), d.body(f"insp_{k}").xquat.copy()) for k in INSTRUMENTS}
    settle(m, d, 2.0)
    for k in INSTRUMENTS:
        assert np.linalg.norm(settled[k][0] - start[k][0]) * 1000 <= threshold("physics.placement_mm").value, k
        assert turned_deg(settled[k][1], start[k][1]) <= threshold("physics.placement_deg").value, k
        assert np.linalg.norm(d.body(f"insp_{k}").xipos - settled[k][0]) * 1000 < 0.001, k


def test_each_instrument_sits_wholly_on_its_surface_clear_of_the_others():
    m, d = build()
    settle(m, d, 1.0)
    rests, tops = record()["rests"], tops_mm(m, d)
    for k, r in rests.items():
        c = np.vstack([corners_mm(m, d, g) for g in instrument_geoms(m, k)])
        assert abs(c[:, 2].min() - tops[r["on"]]) <= GAUGE_RESOLUTION_MM, k
        lo, hi = footprint_mm(m, d, r["on"])
        assert (c[:, :2] >= lo).all() and (c[:, :2] <= hi).all(), k
    bodies = {m.body(f"insp_{k}").id for k in INSTRUMENTS}
    touching = [(m.body(m.geom_bodyid[a]).name, m.body(m.geom_bodyid[b]).name)
                for a, b in zip(d.contact.geom1, d.contact.geom2)
                if m.geom_bodyid[a] in bodies and m.geom_bodyid[b] in bodies]
    assert not touching
