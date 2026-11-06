"""A stock fixture's exemptions take exactly the faces its decision names, and nothing more (tests/fixtures/stock/),
each one face of the STEP with no band round it (the user's decisions, 2026-11-05):
- ll-1005337: the dowel holes' two back countersinks, the undercut notches' four leaned R15 corners and their four
  short vertical side walls;
- nist-ftc-09: the lettering's 17 faces that meet in square inside corners."""
import math

import pytest

from moonshot.tests.gates.test_cycle_stock import exemption, fixture, load_part

pytestmark = pytest.mark.data_root


def taken(part: str) -> list:
    fx = fixture(part)
    assert fx["band_mm"] == 0.0
    out = [(f, exemption(f, fx)) for f in load_part(part).Faces()]
    return [(f, why) for f, why in out if why]


def test_ll_1005337_exempts_its_countersinks_leaned_r15_corners_and_notch_side_walls():
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    faces = taken("ll-1005337")
    assert sorted(why for _, why in faces) == (["bench countersink"] * 2 + ["leaned R15"] * 4
                                               + ["notch side wall"] * 4)
    for f, why in faces:
        a = BRepAdaptor_Surface(f.wrapped)
        if why == "bench countersink":
            assert abs(math.degrees(a.Cone().SemiAngle())) == pytest.approx(45.0, abs=0.1)
            assert f.BoundingBox().zmin == pytest.approx(-20.0, abs=0.01)           # opens out through the back
        elif why == "leaned R15":
            cyl = a.Cylinder()
            tilt = math.degrees(math.acos(abs(cyl.Axis().Direction().Z())))
            assert cyl.Radius() == pytest.approx(15.0, abs=1e-3) and tilt == pytest.approx(20.0, abs=0.1)
        else:                                                    # a vertical wall at a notch's side, by its mouth
            assert abs(f.normalAt().z) < 1e-6 and f.Center().x in (pytest.approx(-150.0), pytest.approx(-250.0))


def test_nist_ftc_09_exempts_ten_regions_its_letters_inside_corners_within_the_end_mill_s_radius():
    """The region exemption (the user's decision, 2026-11-05): each of the lettering's ten inside corners, within the
    1/32 in end mill's radius of the corner's edge, and no more: an edge of the STEP, vertical, the letters' 1.27 mm
    deep, where two of the lettering's walls meet with the material wrapped round it."""
    import cadquery as cq
    import numpy as np
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    fx = fixture("nist-ftc-09")
    regions = fx["regions"]
    assert len(regions) == 10 and {r["what"] for r in regions} == {"letter inside corner"}
    part = load_part("nist-ftc-09")
    for r in regions:
        assert r["within_mm"] == pytest.approx(0.397)                         # 1/32 in / 2
        a, b = (np.asarray(v, float) for v in r["edge"])
        assert np.linalg.norm(b - a) == pytest.approx(1.27, abs=0.01) and abs(b - a)[[0, 2]].max() < 1e-6
        assert 12.0 <= a[0] <= 70.0 and 102.0 <= a[2] <= 119.0
        line = cq.Edge.makeLine(cq.Vector(*a), cq.Vector(*b))
        on = [f for f in part.Faces() if BRepExtrema_DistShapeShape(f.wrapped, line.wrapped).Value() < 1e-3
              and f.BoundingBox().ylen > 1.0]                                  # the two walls it runs along
        assert len(on) == 2 and all(f.geomType() == "PLANE" and exemption(f, fx) == "letter corner" for f in on)


def test_nist_ftc_10_exempts_five_regions_datum_a_s_rim_round_the_side_slot_s_mouth():
    """The extended mask (the user's decision, 2026-11-05): datum A's five edges round the +Z side slot's mouth (the
    masked plan gap, 2026-11-03), each within the slot's 3 mm depth, and no more: each an edge of datum A's own
    face (y = 0), at the slot."""
    import cadquery as cq
    import numpy as np
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    regions = fixture("nist-ftc-10")["regions"]
    assert len(regions) == 5 and {r["what"] for r in regions} == {"plan gap mouth"}
    datum_a = next(f for f in load_part("nist-ftc-10").Faces()
                   if f.geomType() == "PLANE" and f.normalAt().y < -0.99 and abs(f.Center().y) < 1e-6)
    for r in regions:
        assert r["within_mm"] == pytest.approx(3.0)
        a, b = (np.asarray(v, float) for v in r["edge"])
        assert a[1] == b[1] == pytest.approx(0.0) and all(44.0 <= p[0] <= 56.0 and p[2] >= 34.0 for p in (a, b))
        line = cq.Edge.makeLine(cq.Vector(*a), cq.Vector(*b))
        assert BRepExtrema_DistShapeShape(datum_a.wrapped, line.wrapped).Value() < 1e-3   # on datum A's own rim


def test_a_region_takes_only_points_near_its_edge_on_the_faces_that_meet_it():
    import cadquery as cq
    import numpy as np
    from moonshot.tests.gates.test_cycle_stock import in_regions
    box = cq.Solid.makeBox(10, 10, 10)
    faces = box.Faces()
    region = [{"edge": [[0, 0, 0], [0, 0, 10]], "within_mm": 0.4}]            # the box's edge along z at the origin
    far = next(i for i, f in enumerate(faces) if f.Center().x == pytest.approx(10))      # the x = 10 face
    near = next(i for i, f in enumerate(faces) if f.Center().y == pytest.approx(0))      # the y = 0 face, on the edge
    pts = np.array([[0.3, 0, 5], [0.5, 0, 5], [10, 0.3, 5]])
    ids = np.array([near, near, far])
    assert in_regions(pts, ids, faces, region).tolist() == [True, False, False]


def test_nist_ftc_09_exempts_the_lettering_s_17_square_cornered_faces():
    faces = taken("nist-ftc-09")
    assert len(faces) == 17 and {why for _, why in faces} == {"letter corner"}
    for f, _ in faces:                                           # the lettering's, and only its planes
        c = f.Center()
        assert f.geomType() == "PLANE" and 12.0 <= c.x <= 70.0 and 102.0 <= c.z <= 119.0 and 1.7 <= c.y <= 3.0
