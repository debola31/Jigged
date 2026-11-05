"""A plan's setups become vise loads the take can run: the stock, or a machined part as its bounding box, as it sits
in the vise, on both parallels whether set down short or slid home."""
import numpy as np
import pytest

from moonshot.motion.loads import part_pose, vise_load
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


@pytest.mark.parametrize("setup, size", [("op20", (158.0, 75.0, 37.6)), ("op30", (158.0, 31.0, 75.0)),
                                         ("op40", (158.0, 31.0, 75.0))])
def test_later_setups_load_the_machined_part_as_its_box(setup, size):
    load = vise_load(load_plan("nist-ftc-10"), setup)
    assert load.size_mm == pytest.approx(size)
    assert on_both(load, 0.0) and on_both(load, PLACE_GAP)


@pytest.mark.parametrize("setup", ["op50"])
def test_a_part_standing_on_end_sits_on_the_vise_floor(setup):
    load = vise_load(load_plan("nist-ftc-10"), setup)
    assert load.size_mm == pytest.approx((31.0, 75.0, 158.0))
    assert load.parallel_h == 0 and not load.parallels_y
    assert part_pose(load_plan("nist-ftc-10"), setup)["centre_mm"][2] == pytest.approx(VISE["seat_z"] + 79.0)


@pytest.mark.parametrize("setup", ["op10", "op20", "op30", "op40", "op50"])
def test_every_setup_poses_the_part_as_a_rotation_with_its_face_up(setup):
    plan = load_plan("nist-ftc-10")
    s = next(x for x in plan["setups"] if x["id"] == setup)
    p = part_pose(plan, setup)
    R = p["R"]
    assert R @ R.T == pytest.approx(np.eye(3)) and np.linalg.det(R) == pytest.approx(1.0)
    up = np.eye(3)["XYZ".index(s["face_up"][1])] * (1 if s["face_up"][0] == "+" else -1)
    assert R @ up == pytest.approx([0, 0, 1])
    # the model's box, placed by the pose, is the box the vise holds
    corners = np.array(np.meshgrid(*p["envelope_mm"])).reshape(3, -1).T
    world = p["origin_mm"] + corners @ R.T
    assert world.min(0) == pytest.approx(p["centre_mm"] - p["size_mm"] / 2)
    assert world.max(0)[1] == pytest.approx(VISE["fixed_face_y"]), "against the fixed jaw"


@pytest.mark.parametrize("setup", ["op30", "op40"])
def test_datum_a_sits_against_the_fixed_jaw_when_the_jaws_close_on_it(setup):
    R = part_pose(load_plan("nist-ftc-10"), setup)["R"]
    assert R @ [0, -1.0, 0] == pytest.approx([0, 1.0, 0])


def test_a_given_box_poses_the_part_as_the_default_does():
    plan = load_plan("nist-ftc-10")
    for setup in ("op10", "op20", "op50"):
        a, b = part_pose(plan, setup), part_pose(plan, setup, env=part_pose(plan, setup)["envelope_mm"])
        assert all(np.array_equal(a[k], b[k]) for k in ("R", "centre_mm", "size_mm", "origin_mm"))


def box_in_world(p) -> tuple[np.ndarray, np.ndarray]:
    corners = np.array(np.meshgrid(*p["envelope_mm"])).reshape(3, -1).T
    world = p["origin_mm"] + corners @ p["R"].T
    return world.min(0), world.max(0)


@pytest.mark.parametrize("part", ["nist-ftc-09", "ll-1005337"])
def test_a_clamped_plate_lies_flat_on_the_spoilboard_long_side_along_the_table(part):
    from moonshot.motion.loads import SPOILBOARD_CENTRE_XY, SPOILBOARD_TOP_Z
    plan = load_plan(part)
    s = plan["setups"][0]
    p = part_pose(plan, s["id"])
    R = p["R"]
    assert R @ R.T == pytest.approx(np.eye(3)) and np.linalg.det(R) == pytest.approx(1.0)
    up = np.eye(3)["XYZ".index(s["face_up"][1])] * (1 if s["face_up"][0] == "+" else -1)
    assert R @ up == pytest.approx([0, 0, 1])
    lo, hi = box_in_world(p)
    assert lo[2] == pytest.approx(SPOILBOARD_TOP_Z)
    assert hi[0] - lo[0] >= hi[1] - lo[1], "its longer side along the table"
    assert (lo[0] + hi[0]) / 2 == pytest.approx(SPOILBOARD_CENTRE_XY[0])


def test_nist_ftc_09_is_centred_on_the_spoilboard():
    from moonshot.motion.loads import SPOILBOARD_CENTRE_XY
    lo, hi = box_in_world(part_pose(load_plan("nist-ftc-09"), "op10"))
    assert (lo[1] + hi[1]) / 2 == pytest.approx(SPOILBOARD_CENTRE_XY[1])


def test_ll_1005337_sits_by_its_near_edge_then_slides_10_mm_toward_you():
    from moonshot.motion.loads import PLATE_NEAR_Y_MM, Y_TRAVEL_FRONT
    plan = load_plan("ll-1005337")
    p10, p20 = part_pose(plan, "op10"), part_pose(plan, "op20")
    assert box_in_world(p10)[0][1] == pytest.approx(PLATE_NEAR_Y_MM["ll-1005337"])
    assert PLATE_NEAR_Y_MM["ll-1005337"] + 3.2 - 6.35 == pytest.approx(Y_TRAVEL_FRONT + 0.5)
    assert np.array_equal(p20["R"], p10["R"])
    assert p20["origin_mm"] - p10["origin_mm"] == pytest.approx([0, -10.0, 0])
    # the model's X = -400 edge is the near one (plan)
    assert (p10["R"] @ [1.0, 0, 0]) == pytest.approx([0, 1.0, 0])
