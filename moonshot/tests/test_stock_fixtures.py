"""A stock fixture's exemptions take exactly the faces its decision names, and nothing more (tests/fixtures/stock/):
ll-1005337's six (the user's decision, 2026-11-05), the dowel holes' two back countersinks and the undercut notches'
four leaned R15 corners."""
import math

import pytest

from moonshot.tests.gates.test_cycle_stock import exemption, fixture, load_part

pytestmark = pytest.mark.data_root


def test_ll_1005337_exempts_its_two_back_countersinks_and_four_leaned_r15_corners():
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    fx = fixture("ll-1005337")
    assert fx["band_mm"] == 0.0
    taken = [(f, exemption(f, fx)) for f in load_part("ll-1005337").Faces()]
    taken = [(f, why) for f, why in taken if why]
    assert sorted(why for _, why in taken) == ["bench countersink"] * 2 + ["leaned R15"] * 4
    for f, why in taken:
        a = BRepAdaptor_Surface(f.wrapped)
        if why == "bench countersink":
            cone = a.Cone()
            assert abs(math.degrees(cone.SemiAngle())) == pytest.approx(45.0, abs=0.1)
            assert f.BoundingBox().zmin == pytest.approx(-20.0, abs=0.01)           # opens out through the back
        else:
            cyl = a.Cylinder()
            tilt = math.degrees(math.acos(abs(cyl.Axis().Direction().Z())))
            assert cyl.Radius() == pytest.approx(15.0, abs=1e-3) and tilt == pytest.approx(20.0, abs=0.1)
