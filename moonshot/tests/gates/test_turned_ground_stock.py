"""O2, the part comes out right (plan §2), for G2's turned and ground parts: the stock the ST-25's, the surface
grinder's and (ll-1007224's bolt holes) the VF-2's cycles leave is within physics.stock_deviation_mm of the part's STEP
on every face its steps finish. Measured as test_cycle_stock.py measures the VF-2's parts, with its functions:
OpenCASCADE's tessellation of both, exact point-to-triangle distances, both ways round (nothing left on a face, nothing
cut from it, no material standing over it), never with the code that cut the stock (plan §6, rule 2). Protected (plan
§6, rule 1).

Both shapes are meshed first to MESH_MM of their surfaces, absolute: the shared measure asks OCC for 1% of each face's
size (its tessellate() is relative) up to 0.3 rad, which on a turned face is chord sag of 0.044 mm on the Ø31.5 spigots
and up to 0.35 on the Ø63, as much as the limit itself; it keeps a finer mesh it finds.

What the cycles hand this gate, as the VF-2's do: takes/<part>-<step id>/stock-end.brep for each cycle step that cuts,
the stock after it in the part's model frame (mm); the last one is the finished stock. A turned part's stock is
revolved about the spindle's axis, which is the STEP's own; a part-off hands on the part, not the bar left in the chuck.

The faces held: every face of the STEP, but where the user decides. Each part's fixture (tests/fixtures/stock/
<part>.json) exempts no face and has no band; an exemption added there is the user's decision, made visibly. A face the
blank comes with (as supplied, not cut here) is held too: the blank the plan names must already have it. The one
decision so far (2026-11-06): ct-tpg322's chipbreaker is ground on the surface grinder by straight passes of the wheel
along each edge, which can't follow the groove round the noses, so the three nose regions are exempt as what a
straight wheel leaves, and each edge's groove is held over the 10.7 of its 16.5 mm (the IC's triangle) the wheel
reaches. A fixture's zones say so: each a nose's sharp vertex (the triangle's, plan view), the two edges from it, and
along_mm; a point is in it if it lies within along_mm of the vertex along its nearer edge, on a face of the zone's
types, at or above z_min_mm (the top: the land, the groove and the plateau, never the flanks or the bottom).

Each part's gate proves itself on its own STEP (plan §5.4): the part passes; a turned diameter or ground face left
0.15 mm over reads 0.15; a feature left uncut fails; the blank fails; ct-tpg322's zones take only its top round each
nose.

Physics tier: heavy, run on the hub (`pytest moonshot -m farm -s` prints the report).
"""
import numpy as np
import pytest

from moonshot.contracts.thresholds import threshold
from moonshot.tests.gates.test_cycle_stock import Mesh, deviation, finished_stock, fixture, load_part, report

pytestmark = [pytest.mark.farm, pytest.mark.data_root]

PARTS = ["ct-tpg322", "ll-1011439", "ll-1007224"]       # G2 (plan §7): ground, turned, turned then milled
OVER_MM = 0.15                                           # what each self-proof leaves on or takes off
MESH_MM, MESH_RAD = 0.002, 0.1                           # each mesh within 2 µm of its surface, absolute


def fine(shape):
    """The shape meshed within MESH_MM of its surface, absolute (see the module's doc)."""
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    BRepMesh_IncrementalMesh(shape.wrapped, MESH_MM, False, MESH_RAD, True)
    return shape


def in_zones(points: np.ndarray, face_ids: np.ndarray, faces: list, zones: list[dict]) -> np.ndarray:
    """Which points lie in a fixture's zones (see the module's doc)."""
    out = np.zeros(len(points), bool)
    types = np.array([f.geomType() for f in faces])
    for z in zones:
        v = np.asarray(z["vertex_mm"], float)
        rel = points[:, :2] - v
        dirs = [np.asarray(e, float) / np.linalg.norm(e) for e in z["edges"]]
        along = np.stack([rel @ e for e in dirs], 1)
        off = np.stack([np.abs(rel[:, 0] * e[1] - rel[:, 1] * e[0]) for e in dirs], 1)
        t = along[np.arange(len(points)), np.argmin(off, 1)]
        out |= np.isin(types[face_ids], z["types"]) & (points[:, 2] >= z["z_min_mm"]) & (t <= z["along_mm"])
    return out


def deviation_in_zones(part, stock, fx: dict) -> dict:
    """test_cycle_stock's deviation, both ways round, with the fixture's zones left out of the gate (and reported)."""
    assert not fx["exempt"] and not fx["band_mm"] and not fx.get("regions")
    faces = part.Faces()
    pmesh, smesh = Mesh(faces), Mesh(stock.Faces())
    pts, fid = pmesh.samples()
    d1 = smesh.nearest(pts)[1]
    g1 = ~in_zones(pts, fid, faces, fx["zones"])
    spts, _ = smesh.samples(seed=1)
    c2, d2, fid2 = pmesh.nearest(spts)
    g2 = ~in_zones(c2, fid2, faces, fx["zones"])
    worst, gated = np.zeros(len(faces)), np.zeros(len(faces))
    np.maximum.at(worst, fid, d1)
    np.maximum.at(worst, fid2, d2)
    np.maximum.at(gated, fid[g1], d1[g1])
    np.maximum.at(gated, fid2[g2], d2[g2])
    w1, w2 = d1[g1].max(initial=0.0), d2[g2].max(initial=0.0)
    at = pts[g1][np.argmax(d1[g1])] if w1 >= w2 else c2[g2][np.argmax(d2[g2])]
    per_face = [{"face": i, "type": f.geomType(), "exempt": "zone" if not g1[fid == i].all() else None,
                 "worst_mm": round(float(worst[i]), 4), "gated_worst_mm": round(float(gated[i]), 4),
                 "centre": [round(v, 2) for v in f.Center().toTuple()]} for i, f in enumerate(faces)]
    return {"worst_mm": float(max(w1, w2)), "at": [round(float(v), 2) for v in at], "per_face": per_face,
            "gated_frac": float(g1.mean())}


def measure(part: str, stock) -> dict:
    """The deviation, both shapes meshed fine: test_cycle_stock's, or with the fixture's zones."""
    fx = fixture(part)
    p, s = fine(load_part(part)), fine(stock)
    return deviation_in_zones(p, s, fx) if fx.get("zones") else deviation(p, s, fx)


def _plan_or_skip(part: str) -> None:
    from moonshot.planning.validate import PLANS
    if not (PLANS / f"{part}.json").exists():
        pytest.skip(f"no plan for {part} yet")


def _with(part, extra):
    """The part with material added: fused where OCC can, else beside it as a compound (the extra's own faces show)."""
    import cadquery as cq
    try:
        out = part.fuse(extra).clean()
        if out.isValid() and out.Volume() > part.Volume():
            return out
    except Exception:
        pass
    return cq.Compound.makeCompound([part, extra])


def _ring(r_in: float, r_out: float, y0: float, y1: float):
    """A ring about the model's y axis (the turned parts' spindle axis), r_in to r_out, from y0 to y1."""
    import cadquery as cq
    outer = cq.Solid.makeCylinder(r_out, y1 - y0, cq.Vector(0, y0, 0), cq.Vector(0, 1, 0))
    if r_in <= 0:
        return outer
    return outer.cut(cq.Solid.makeCylinder(r_in, y1 - y0, cq.Vector(0, y0, 0), cq.Vector(0, 1, 0)))


# --- the gate -------------------------------------------------------------------------------------------------------

def test_each_part_s_fixture_exempts_only_what_the_user_decided():
    """No face, band or region anywhere; ct-tpg322's three nose zones only (the user's decision, 2026-11-06)."""
    for part in PARTS:
        fx = fixture(part)
        assert fx["part"] == part and fx["exempt"] == [] and fx["band_mm"] == 0.0 and not fx.get("regions"), part
        assert not fx.get("zones") or part == "ct-tpg322", part
    zones = fixture("ct-tpg322")["zones"]
    side = 2 * np.sqrt(3) * 0.375 / 2 * 25.4                               # the IC's triangle: 16.497 mm
    assert len(zones) == 3 and {z["what"] for z in zones} == {"chipbreaker nose"}
    for z in zones:
        assert z["along_mm"] == pytest.approx((side - 10.7) / 2, abs=0.01)       # 10.7 of each edge held
        assert np.linalg.norm(z["vertex_mm"]) == pytest.approx(side / np.sqrt(3), abs=0.01)   # a sharp vertex
        assert z["types"] == ["PLANE", "CYLINDER"] and z["z_min_mm"] == pytest.approx(2.97)  # the top only
        for e in z["edges"]:                                              # each along an edge to another vertex
            end = np.asarray(z["vertex_mm"]) + np.asarray(e) / np.linalg.norm(e) * side
            assert min(np.linalg.norm(end - np.asarray(o["vertex_mm"])) for o in zones) < 0.01


@pytest.mark.parametrize("part", PARTS)
def test_the_finished_stock_is_the_part(part):
    _plan_or_skip(part)
    limit = threshold("physics.stock_deviation_mm").value
    r = measure(part, finished_stock(part))
    print(f"\n{part}: " + report(r, limit))
    assert r["gated_frac"] == 1.0 or fixture(part).get("zones"), "a face of the STEP isn't held"
    assert r["worst_mm"] <= limit, report(r, limit)


def test_ct_tpg322_zones_take_only_its_top_round_each_nose():
    """The zones leave the flanks, the bottom and each edge's middle held: under a quarter of the samples, all on the
    top (z 2.97 and up) and none further from a sharp vertex than its zone reaches."""
    part = fine(load_part("ct-tpg322"))
    faces = part.Faces()
    pts, fid = Mesh(faces).samples()
    zones = fixture("ct-tpg322")["zones"]
    z = in_zones(pts, fid, faces, zones)
    assert 0.02 < z.mean() < 0.25
    assert (pts[z, 2] >= 2.97).all()
    near = np.min([np.linalg.norm(pts[z, :2] - np.asarray(q["vertex_mm"]), axis=1) for q in zones], axis=0)
    assert near.max() < 2.9 + 2.0                                     # along an edge, and its groove's 1.65 in
    mids = [(np.asarray(a["vertex_mm"]) + np.asarray(b["vertex_mm"])) / 2 for a, b in
            zip(zones, zones[1:] + zones[:1])]
    for m in mids:                                                    # each edge's middle is held
        close = np.linalg.norm(pts[:, :2] - m, axis=1) < 2.0
        assert close.any() and not z[close].any()


# --- each part's gate proves itself (plan §5.4) ---------------------------------------------------------------------

@pytest.mark.parametrize("part", PARTS)
def test_the_part_itself_passes(part):
    r = measure(part, load_part(part))
    assert r["worst_mm"] <= 0.005 and (r["gated_frac"] == 1.0 or fixture(part).get("zones")), report(r, 0.005)


def test_ll_1011439_pilot_left_0_15_mm_over_reads_0_15():
    part = load_part("ll-1011439")
    r = measure("ll-1011439", _with(part, _ring(4.0, 4.0 + OVER_MM, -2.3, -0.4)))           # the Ø8 g6
    assert r["worst_mm"] == pytest.approx(OVER_MM, abs=0.005), report(r, 0.1)


def test_ll_1011439_crown_turned_0_15_mm_under_fails():
    part = load_part("ll-1011439")
    r = measure("ll-1011439", part.cut(_ring(6.21 - OVER_MM, 8.0, 7.6, 8.4)))                # into the R7
    assert r["worst_mm"] > 0.1, report(r, 0.1)


def test_ll_1011439_tap_hole_left_undrilled_fails():
    part = load_part("ll-1011439")
    r = measure("ll-1011439", _with(part, _ring(0.0, 1.65, -3.0, 7.1)))                       # Ø3.3, 10.1 deep
    assert r["worst_mm"] > 1.0, report(r, 0.1)


def test_ll_1011439_bar_fails():
    assert measure("ll-1011439", _ring(0.0, 7.0, -4.0, 14.0))["worst_mm"] > 0.5


def test_ll_1007224_spigot_left_0_15_mm_over_reads_0_15():
    part = load_part("ll-1007224")
    r = measure("ll-1007224", _with(part, _ring(15.75, 15.75 + OVER_MM, 12.9, 14.6)))       # Ø31.5 g6
    assert r["worst_mm"] == pytest.approx(OVER_MM, abs=0.005), report(r, 0.1)


def test_ll_1007224_bolt_hole_left_undrilled_fails():
    import cadquery as cq
    part = load_part("ll-1007224")
    plug = cq.Solid.makeCylinder(3.3, 9.0, cq.Vector(0, 3.2, 25.0), cq.Vector(0, 1, 0))         # 1 of 5X Ø6.6 thru
    r = measure("ll-1007224", _with(part, plug))
    assert r["worst_mm"] > 1.0, report(r, 0.1)


def test_ll_1007224_sawn_blank_fails():
    assert measure("ll-1007224", _ring(0.0, 33.0, -2.0, 17.4))["worst_mm"] > 0.5


def _top(part) -> list:
    """The insert's top faces (z = 3.175): the land round the chipbreaker and the plateau inside it."""
    return [f for f in part.Faces() if f.geomType() == "PLANE" and abs(f.Center().z - 3.175) < 1e-3]


def test_ct_tpg322_left_0_15_mm_thick_reads_0_15():
    import cadquery as cq
    part = load_part("ct-tpg322")
    slab = cq.Compound.makeCompound([cq.Solid.extrudeLinear(f, cq.Vector(0, 0, OVER_MM)) for f in _top(part)])
    r = measure("ct-tpg322", _with(part, slab))                                     # the groove stays as ground
    assert r["worst_mm"] == pytest.approx(OVER_MM, abs=0.005), report(r, 0.1)


def test_ct_tpg322_chipbreaker_left_unground_fails():
    import cadquery as cq
    part = load_part("ct-tpg322")
    floor = next(f for f in part.Faces() if f.geomType() == "PLANE" and abs(f.Center().z - 2.972) < 1e-3)
    fill = cq.Solid.extrudeLinear(floor, cq.Vector(0, 0, 3.175 - 2.972))            # the groove .008 deep, filled
    r = measure("ct-tpg322", _with(part, fill))
    assert r["worst_mm"] > 0.15, report(r, 0.1)


def test_ct_tpg322_blank_0_15_mm_over_each_face_fails():
    import cadquery as cq
    part = load_part("ct-tpg322")
    land = max((f for f in _top(part) if f.innerWires()), key=lambda f: f.Area())
    outline = cq.Face.makeFromWires(land.outerWire()).moved(cq.Location(cq.Vector(0, 0, -3.175 - OVER_MM)))
    blank = cq.Solid.extrudeLinear(outline, cq.Vector(0, 0, 3.175 + 2 * OVER_MM))
    assert measure("ct-tpg322", blank)["worst_mm"] > 0.1
