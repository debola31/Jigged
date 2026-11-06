"""A part's "Send it out" step (ct-slbeam's for black oxide, ll-1007223's for zinc) as a physics take at the
outside-process rack (plan §5.4): the right hand picks the finished part up off the coating shelf, lifts it over the
rim of the kraft bag the vendor's tag hangs on, sets it down inside on the bag's floor and lets go. Physics tier, on
the takes the runner writes to the data root (takes/<part>-send-out). Protected (plan §6, rule 1).

Where the part ends is measured from the take record, its colliders against the bag's in the bag's own frame, so the
measurement doesn't use the runner's account of it (plan §6, rule 2). Where the coating shelf and the bag are comes
from the take's scene, as the station record puts them (moonshot/library/stations/outproc_rack.json).
"""
import json

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
PARTS = ["ct-slbeam", "ll-1007223"]
RIM_CLEAR_MM = 5.0          # carried over the bag, the part's underside at least this far over its rim
STILL_S = 0.3               # let go, the part and the bag at rest this long before the take ends


def quat_R(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def tilt_deg(q0, q1):
    """How far a body's up has turned: what lying level is, whatever it has turned about the vertical."""
    return float(np.degrees(np.arccos(np.clip(quat_R(q0)[:, 2] @ quat_R(q1)[:, 2], -1.0, 1.0))))


@pytest.fixture(scope="module", params=PARTS)
def take(request):
    folder = data_root() / "takes" / f"{request.param}-send-out"
    if not (folder / "take.npz").exists():
        pytest.skip(f"no physics run in {folder}")
    d = np.load(folder / "take.npz")
    return {"folder": folder, "npz": d, "i": {str(b): k for k, b in enumerate(d["bodies"])},
            "scene": json.loads((folder / "scene.json").read_text(encoding="utf-8")),
            "plan": json.loads((folder / "take.json").read_text(encoding="utf-8")),
            "checks": json.loads((folder / "checks.json").read_text(encoding="utf-8"))}


def pose(take, body):
    d, i = take["npz"], take["i"][body]
    return d["pos"][:, i], d["quat"][:, i]


def geoms(take, body, prefix=""):
    return [g for g in take["scene"]["bodies"][body]["geoms"] if g["name"].startswith(prefix)]


def box_bounds(g):
    """A box geom's bounds in its body's frame (mm): the record's boxes are unturned in their bodies."""
    assert g["type"] == "box" and np.allclose(g["quat"], [1, 0, 0, 0])
    p, s = np.asarray(g["pos"], float), np.asarray(g["size"], float)
    return p - s, p + s


def corners(take, body, k):
    """The corners of a body's box colliders at frame k, world mm."""
    p, q = pose(take, body)
    R = quat_R(q[k])
    out = []
    for g in geoms(take, body):
        lo, hi = box_bounds(g)
        out += [p[k] + R @ np.array([x, y, z]) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
    return np.array(out)


def bag_inside(take):
    """The bag's inside in its frame: between its walls, from its floor's top to its rim."""
    walls = {g["name"]: box_bounds(g) for g in geoms(take, "bag", "bag_wall")}
    floor = box_bounds(geoms(take, "bag", "bag_floor")[0])
    lo = np.array([walls["bag_wall_left"][1][0], walls["bag_wall_near"][1][1], floor[1][2]])
    hi = np.array([walls["bag_wall_right"][0][0], walls["bag_wall_far"][0][1], walls["bag_wall_near"][1][2]])
    return lo, hi


def test_the_record_is_complete_and_two_handed(take):
    assert check(take["folder"]) == []
    assert sorted(str(a) for a in take["npz"]["arms"]) == ["L", "R"]


def test_the_bag_stands_tagged_on_the_coating_shelf(take):
    assert geoms(take, "bag", "bag_tag"), "the bag carries the vendor's tag"
    shelf = box_bounds(geoms(take, "outproc_rack", "rack_shelf_coating")[0])
    p, _ = pose(take, "bag")
    lo, _ = box_bounds(geoms(take, "bag", "bag_floor")[0])
    assert abs(p[0, 2] + lo[2] - shelf[1][2]) <= threshold("physics.placement_mm").value


def test_the_part_starts_on_the_coating_shelf(take):
    shelf = box_bounds(geoms(take, "outproc_rack", "rack_shelf_coating")[0])
    assert abs(corners(take, "part", 0)[:, 2].min() - shelf[1][2]) <= threshold("physics.placement_mm").value


def test_the_part_is_carried_over_the_bags_rim(take):
    p, _ = pose(take, "part")
    rim = pose(take, "bag")[0][0, 2] + bag_inside(take)[1][2]
    lowest = np.array([corners(take, "part", k)[:, 2].min() for k in range(len(p))])
    assert lowest.max() >= rim + RIM_CLEAR_MM


def test_the_part_ends_in_the_bag_on_its_floor_level_and_still(take):
    pb, qb = pose(take, "bag")
    lo, hi = bag_inside(take)
    k = len(pb) - 1
    inside = (corners(take, "part", k) - pb[k]) @ quat_R(qb[k])          # in the bag's frame
    tol = threshold("physics.placement_mm").value
    assert (inside[:, :2] >= lo[:2]).all() and (inside[:, :2] <= hi[:2]).all(), "the part lies within the bag's walls"
    assert abs(inside[:, 2].min() - lo[2]) <= tol, "the part rests on the bag's floor"
    p, q = pose(take, "part")
    assert tilt_deg(q[0], q[-1]) <= threshold("physics.placement_deg").value, "set down level, as it lay"
    n = int(STILL_S * float(take["npz"]["fps"]))
    assert np.linalg.norm(p[-n:] - p[-1], axis=1).max() < 0.1


def test_the_bag_stays_where_it_stands(take):
    p, q = pose(take, "bag")
    assert np.linalg.norm(p - p[0], axis=1).max() <= threshold("physics.placement_mm").value
    assert max(tilt_deg(q[0], qk) for qk in q) <= threshold("physics.placement_deg").value


def test_the_skin_is_measured_on_the_part_and_the_bag(take):
    assert {"part", "bag"} <= set(take["checks"]["solids"])


def test_the_take_passes_every_check(take):
    from moonshot.validate.take import run
    failed = {k: v for k, v in run(take["folder"]).items() if isinstance(v, str) or not v.passed}
    assert not failed, failed
