"""A plan's first setup becomes a vise load the take can run: the stock as it sits in the vise, on both parallels
whether set down short or slid home."""
import pytest

from moonshot.motion.loads import vise_load
from moonshot.motion.setup_take import PLACE_GAP
from moonshot.planning.validate import load_plan
from moonshot.world.vise import PARALLEL_T, REFERENCE, VISE


def on_both(load, shift_mm):
    """Is the part, slid shift_mm off the fixed jaw, fully over both parallels?"""
    near, far = VISE["fixed_face_y"] - shift_mm - load.size_mm[1], VISE["fixed_face_y"] - shift_mm
    return all(near + PARALLEL_T / 2 < y < far - PARALLEL_T / 2 for y in load.parallels_y.values())


def test_the_reference_rules_reproduce_the_reference():
    plan = {"stock": {"size_mm": list(REFERENCE.size_mm)},
            "setups": [{"id": "s", "face_up": "+Z", "workholding": {"parallels_in": 1.0, "jaw_on": "Y faces"}}]}
    load = vise_load(plan, "s")
    assert load.size_mm == pytest.approx(REFERENCE.size_mm)
    assert load.opening0 == pytest.approx(REFERENCE.opening0)
    assert load.parallels_y == pytest.approx(REFERENCE.parallels_y)


def test_nist_ftc_10_op10_loads_the_stock_on_one_inch_parallels():
    load = vise_load(load_plan("nist-ftc-10"), "op10")
    assert load.size_mm == pytest.approx((165.1, 82.55, 38.1))
    assert load.parallel_h == pytest.approx(25.4)
    assert on_both(load, 0.0) and on_both(load, PLACE_GAP)
    assert load.opening0 > load.size_mm[1]


def test_later_setups_wait_for_stock_removal():
    with pytest.raises(NotImplementedError):
        vise_load(load_plan("nist-ftc-10"), "op20")
