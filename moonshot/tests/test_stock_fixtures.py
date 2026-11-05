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


def test_nist_ftc_09_exempts_the_lettering_s_17_square_cornered_faces():
    faces = taken("nist-ftc-09")
    assert len(faces) == 17 and {why for _, why in faces} == {"letter corner"}
    for f, _ in faces:                                           # the lettering's, and only its planes
        c = f.Center()
        assert f.geomType() == "PLANE" and 12.0 <= c.x <= 70.0 and 102.0 <= c.z <= 119.0 and 1.7 <= c.y <= 3.0
