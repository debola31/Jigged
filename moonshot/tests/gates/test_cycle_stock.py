"""O2, the part comes out right (plan §2): the stock the VF-2's cycles leave is within physics.stock_deviation_mm of the
part's STEP on its machined faces. Measured here, on OpenCASCADE's tessellation of both with exact point-to-triangle
distances, never with the code that cut the stock (plan §6, rule 2). Protected (plan §6, rule 1).

What the cycle hands this gate (moonshot/sim/cycle_take.py writes it): takes/<part>-<step id>/stock-end.brep for each
cycle step, the stock after that operation in the part's model frame (mm). The last cycle step's is the finished stock.

Machined faces are every face of the STEP but those its fixture (tests/fixtures/stock/<part>.json) exempts, each with
its reason, and on a face that meets a concave exempt blend, the band within band_mm of that blend. Both ways round:
every point of a machined face lies within the limit of the stock's surface (nothing left on, nothing cut away), and
every point of the stock's surface whose nearest point of the part lies on a machined face lies within the limit of it
(no material left over a face). Exempt faces' deviations are reported, not gated.

Physics tier: heavy, run on the hub (`pytest moonshot -m farm -s` prints the report).
"""
import json
import math
from functools import cache
from pathlib import Path

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.thresholds import threshold

pytestmark = [pytest.mark.farm, pytest.mark.data_root]

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "stock"
PART = "nist-ftc-10"
TESSELLATE_MM, TESSELLATE_RAD = 0.01, 0.3              # each mesh within 10 µm of its surface
SAMPLE_MM = 0.5                                          # one sample per this square on average, on every face


def step_path(part: str) -> Path:
    p = data_root() / "parts" / part / "part.step"
    if not p.exists():
        pytest.skip(f"no STEP for {part} in the data root")
    return p


def fixture(part: str) -> dict:
    return json.loads((FIXTURES / f"{part}.json").read_text(encoding="utf-8"))


@cache
def load_part(part: str):
    import cadquery as cq
    return cq.importers.importStep(str(step_path(part))).val()


# --- the part's faces: which are machined ------------------------------------------------------------------------

def _sample_point(face):
    """A point inside the face, its outward normal (the face's orientation applied) and its adaptor."""
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.BRepGProp import BRepGProp_Face
    from OCP.gp import gp_Pnt, gp_Vec
    u0, u1, v0, v1 = face._uvBounds()
    u, v = (u0 + u1) / 2, (v0 + v1) / 2
    p, n = gp_Pnt(), gp_Vec()
    BRepGProp_Face(face.wrapped).Normal(u, v, p, n)
    n.Normalize()
    return np.array([p.X(), p.Y(), p.Z()]), np.array([n.X(), n.Y(), n.Z()]), BRepAdaptor_Surface(face.wrapped)


def _xyz(p) -> np.ndarray:
    return np.array([p.X(), p.Y(), p.Z()])


def concave(face) -> bool:
    """Whether a blend's centre of curvature lies outside the material (an inside radius, which a tool larger than it
    can't reach into). Splines are taken as concave."""
    t = face.geomType()
    if t == "BSPLINE":
        return True
    p, n, a = _sample_point(face)
    if t == "CYLINDER":
        c = a.Cylinder()
        r, o, d = c.Radius(), _xyz(c.Axis().Location()), _xyz(c.Axis().Direction())
        q = p + r * n - o
        return np.linalg.norm(q - (q @ d) * d) < r / 2
    if t == "SPHERE":
        s = a.Sphere()
        return np.linalg.norm(p + s.Radius() * n - _xyz(s.Location())) < s.Radius() / 2
    if t == "TORUS":
        tr = a.Torus()
        r, big = tr.MinorRadius(), tr.MajorRadius()
        o, d = _xyz(tr.Location()), _xyz(tr.Axis().Direction())
        q = p + r * n - o
        h = q @ d
        return math.hypot(h, np.linalg.norm(q - h * d) - big) < r / 2
    return False


def exemption(face, fx: dict) -> str | None:
    """The fixture's reason a face isn't gated ("blend", "drill point"), or None for a machined face."""
    t = face.geomType()
    for e in fx["exempt"]:
        if t not in e["types"]:
            continue
        if t == "CYLINDER" and "radius_max_mm" in e:
            from OCP.BRepAdaptor import BRepAdaptor_Surface
            r = BRepAdaptor_Surface(face.wrapped).Cylinder().Radius()
            u0, u1, _, _ = face._uvBounds()
            if r > e["radius_max_mm"] + 1e-6 or math.degrees(u1 - u0) > e["arc_max_deg"]:
                continue
        return e["what"]
    return None


def neighbours(shape) -> dict:
    """Each face's neighbours across its edges."""
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
    from OCP.TopExp import TopExp
    from OCP.TopTools import TopTools_IndexedDataMapOfShapeListOfShape
    import cadquery as cq
    m = TopTools_IndexedDataMapOfShapeListOfShape()
    TopExp.MapShapesAndAncestors_s(shape.wrapped, TopAbs_EDGE, TopAbs_FACE, m)
    out: dict = {}
    for i in range(1, m.Extent() + 1):
        faces = [cq.Face(f) for f in m.FindFromIndex(i)]
        for a in faces:
            out.setdefault(a, set()).update(b for b in faces if not b.wrapped.IsSame(a.wrapped))
    return out


# --- meshes and distances (VTK's cell locator: exact point-to-triangle distance) ------------------------------------

class Mesh:
    """These faces as one triangle mesh, each triangle knowing its face."""

    def __init__(self, faces):
        import vtk
        from vtk.util.numpy_support import numpy_to_vtk, numpy_to_vtkIdTypeArray
        vs, fs, ids, n = [], [], [], 0
        for i, f in enumerate(faces):
            v, t = f.tessellate(TESSELLATE_MM, TESSELLATE_RAD)
            if not t:
                continue
            vs.append(np.array([(p.x, p.y, p.z) for p in v]))
            fs.append(np.array(t) + n)
            ids.append(np.full(len(t), i))
            n += len(v)
        self.v, self.f, self.face = np.vstack(vs), np.vstack(fs), np.concatenate(ids)
        pts = vtk.vtkPoints()
        pts.SetData(numpy_to_vtk(self.v, deep=True))
        cells = vtk.vtkCellArray()
        cells.SetData(numpy_to_vtkIdTypeArray(np.arange(0, 3 * len(self.f) + 1, 3, dtype=np.int64), deep=True),
                      numpy_to_vtkIdTypeArray(self.f.astype(np.int64).ravel(), deep=True))
        self.poly = vtk.vtkPolyData()
        self.poly.SetPoints(pts)
        self.poly.SetPolys(cells)
        self.locator = vtk.vtkStaticCellLocator()
        self.locator.SetDataSet(self.poly)
        self.locator.BuildLocator()

    def nearest(self, points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Each point's nearest point on the mesh, its distance, and the face it lies on."""
        import vtk
        c, cell, sub, d2 = [0.0, 0.0, 0.0], vtk.reference(0), vtk.reference(0), vtk.reference(0.0)
        out, dist, tri = np.empty((len(points), 3)), np.empty(len(points)), np.empty(len(points), int)
        for k, p in enumerate(points):
            self.locator.FindClosestPoint(p, c, cell, sub, d2)
            out[k], dist[k], tri[k] = c, d2.get(), cell.get()
        return out, np.sqrt(dist), self.face[tri]

    def samples(self, seed: int = 0) -> tuple[np.ndarray, np.ndarray]:
        """Points spread over the mesh, one per SAMPLE_MM square on average, plus every vertex; and each one's
        face."""
        rng = np.random.default_rng(seed)
        a, b, c = (self.v[self.f[:, k]] for k in range(3))
        area = np.linalg.norm(np.cross(b - a, c - a), axis=1) / 2
        tri = np.repeat(np.arange(len(area)), rng.poisson(area / SAMPLE_MM ** 2))
        r1, r2 = rng.random(len(tri)), rng.random(len(tri))
        flip = r1 + r2 > 1
        r1[flip], r2[flip] = 1 - r1[flip], 1 - r2[flip]
        pts = a[tri] + r1[:, None] * (b - a)[tri] + r2[:, None] * (c - a)[tri]
        corner_face = np.zeros(len(self.v), int)
        corner_face[self.f.ravel()] = np.repeat(self.face, 3)
        return np.vstack([pts, self.v]), np.concatenate([self.face[tri], corner_face])


def deviation(part, stock, fx: dict) -> dict:
    """Both ways round: the worst distance on machined faces, and per face (machined and exempt)."""
    faces = part.Faces()
    why = [exemption(f, fx) for f in faces]
    index = {f: i for i, f in enumerate(faces)}
    near = neighbours(part)
    blends = {i for i, f in enumerate(faces) if why[i] == "blend" and concave(f)}
    pmesh, smesh = Mesh(faces), Mesh(stock.Faces())
    band = fx["band_mm"]

    def banded(points: np.ndarray, face_ids: np.ndarray) -> np.ndarray:
        """Which points lie within band_mm of a concave blend their own face meets."""
        out = np.zeros(len(points), bool)
        for fi in np.unique(face_ids):
            nb = [index[g] for g in near.get(faces[fi], ()) if index[g] in blends]
            if not nb or why[fi] is not None:
                continue
            sel = face_ids == fi
            out[sel] = Mesh([faces[j] for j in nb]).nearest(points[sel])[1] <= band
        return out

    worst = np.zeros(len(faces))
    # the part's faces against the stock: nothing left on them, nothing cut from them
    pts, fid = pmesh.samples()
    d1 = smesh.nearest(pts)[1]
    gated1 = np.array([why[i] is None for i in fid]) & ~banded(pts, fid)
    np.maximum.at(worst, fid, d1)
    # the stock's surface against the part: nothing standing over a machined face
    spts, _ = smesh.samples(seed=1)
    c2, d2, fid2 = pmesh.nearest(spts)
    gated2 = np.array([why[i] is None for i in fid2]) & ~banded(c2, fid2)
    np.maximum.at(worst, fid2, d2)
    w1 = d1[gated1].max(initial=0.0)
    w2 = d2[gated2].max(initial=0.0)
    at = pts[gated1][np.argmax(d1[gated1])] if w1 >= w2 and gated1.any() else c2[gated2][np.argmax(d2[gated2])]
    per_face = [{"face": i, "type": f.geomType(), "exempt": why[i], "worst_mm": round(float(worst[i]), 4),
                 "centre": [round(v, 2) for v in f.Center().toTuple()]} for i, f in enumerate(faces)]
    return {"worst_mm": float(max(w1, w2)), "at": [round(float(v), 2) for v in at], "per_face": per_face,
            "gated_frac": float(gated1.mean())}


def report(r: dict, limit: float) -> str:
    bad = sorted((f for f in r["per_face"] if f["worst_mm"] > limit), key=lambda f: -f["worst_mm"])
    lines = [f"worst on machined faces {r['worst_mm']:.3f} mm at {r['at']}; {r['gated_frac']:.0%} of samples gated"]
    lines += [f"  face {f['face']:3d} {f['type']:9s} {f['exempt'] or 'machined':11s} {f['worst_mm']:7.3f} mm "
              f"near {f['centre']}" for f in bad[:40]]
    return "\n".join(lines)


# --- the gate -------------------------------------------------------------------------------------------------------

def finished_stock(part: str):
    import cadquery as cq
    from moonshot.planning.steps import expand
    from moonshot.planning.validate import load_plan
    steps = [s for s in expand(load_plan(part)) if s["kind"] == "cycle"]
    ends = [data_root() / "takes" / f"{part}-{s['id']}" / "stock-end.brep" for s in steps]
    ends = [p for p in ends if p.exists()]
    if not ends:
        pytest.skip(f"no cycle has run on {part}")
    return cq.Shape.importBrep(str(ends[-1]))


def test_the_finished_stock_is_the_part():
    limit = threshold("physics.stock_deviation_mm").value
    r = deviation(load_part(PART), finished_stock(PART), fixture(PART))
    print("\n" + report(r, limit))
    assert r["worst_mm"] <= limit, report(r, limit)


# --- the gate proves itself (plan §5.4): it passes the part and fails stock that isn't it ---------------------------

def test_the_part_itself_passes():
    part = load_part(PART)
    r = deviation(part, part, fixture(PART))
    assert r["worst_mm"] <= 0.02 and r["gated_frac"] > 0.5, report(r, 0.02)


def test_a_pocket_cut_0_3_mm_too_deep_fails():
    import cadquery as cq
    part = load_part(PART)
    deeper = part.cut(cq.Solid.makeBox(60, 0.3, 30, cq.Vector(-50, 17.0, -15)))      # the pocket floor is y = 17
    r = deviation(part, deeper, fixture(PART))
    assert r["worst_mm"] == pytest.approx(0.3, abs=0.03), report(r, 0.1)


def test_an_ear_hole_left_undrilled_fails():
    import cadquery as cq
    part = load_part(PART)
    plug = cq.Solid.makeCylinder(3.0, 6.0, cq.Vector(70, 0, 28.5), cq.Vector(0, 1, 0))      # the Ø6 hole, y 0-6
    filled = cq.Compound.makeCompound([part, plug])           # OCC can't fuse into this STEP; the plug's ends show
    r = deviation(part, filled, fixture(PART))
    assert r["worst_mm"] > 1.0, report(r, 0.1)


def test_the_raw_stock_fails():
    import cadquery as cq
    part = load_part(PART)
    size = [165.1, 38.1, 82.55]
    box = cq.Solid.makeBox(*size, cq.Vector(-size[0] / 2, -3.55, -size[2] / 2))
    assert deviation(part, box, fixture(PART))["worst_mm"] > 3.0
