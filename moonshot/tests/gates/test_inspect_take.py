"""nist-ftc-10's step 70, "Check the pocket depth", as a two-handed physics take at the inspection bench (plan §5.4):
the left hand holds the finished part still on the bench while the right stands the 6 in calipers on its top face
and runs the depth rod down to the pocket's floor, reads them, closes them and puts them back. Physics tier, on the
take the runner writes to the data root (takes/nist-ftc-10-inspect). Protected (plan §6, rule 1).

The reading is the slider's travel along the beam (the beam body's +x) from where it starts, closed, measured from
the take record, and it is held to what the part really is: the process plan's 17 mm pocket, within the
calipers' own accuracy (their record, Mitutoyo 500-196-30: 0.001 in). A rod short of the floor, a beam not seated
on the face, or a tilted beam all read wrong, so the reading is the whole measurement.
"""
import json
from pathlib import Path

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKE = data_root() / "takes" / "nist-ftc-10-inspect"
MOONSHOT = Path(__file__).resolve().parents[2]
IN = 25.4
LIFT_MM = 20.0              # carried, the calipers rise this far off the bench at least
PUT_BACK_MM = 15.0          # set down this near where they were taken from, as a person puts a tool back
CLOSED_MM = 0.5             # closed again: the slider back within this of zero


def pocket_depth_mm() -> float:
    plan = json.loads((MOONSHOT / "planning" / "plans" / "nist-ftc-10.json").read_text(encoding="utf-8"))
    op = next(o for s in plan["setups"] for o in s["operations"] if o["kind"] == "pocket" and s["id"] == "op10")
    return float(op["features"][0]["at_mm"])


def caliper_accuracy_mm() -> float:
    rec = json.loads((MOONSHOT / "library" / "records" / "assets" / "inspection" / "cal6" / "cal6.json")
                     .read_text(encoding="utf-8"))
    spec = next(s for s in rec["key_specs"] if s["name"] == "Accuracy")
    assert spec["unit"] == "in"
    return spec["value"] * IN


def quat_R(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def turned_deg(q0, q1):
    return float(np.degrees(2 * np.arccos(min(1.0, abs(float(np.dot(q0, q1)))))))


@pytest.fixture(scope="module")
def take():
    if not (TAKE / "take.npz").exists():
        pytest.skip(f"no physics run in {TAKE}")
    d = np.load(TAKE / "take.npz")
    bodies = [str(b) for b in d["bodies"]]
    return {"npz": d, "i": {b: k for k, b in enumerate(bodies)},
            "plan": json.loads((TAKE / "take.json").read_text(encoding="utf-8")),
            "checks": json.loads((TAKE / "checks.json").read_text(encoding="utf-8"))}


def pose(take, body):
    d, i = take["npz"], take["i"][body]
    return d["pos"][:, i], d["quat"][:, i]


def reading_mm(take) -> np.ndarray:
    """Per frame, the slider's travel along the beam from frame 0."""
    pb, qb = pose(take, "insp_cal6")
    ps, _ = pose(take, "insp_cal6_slider")
    along = np.array([(quat_R(q).T @ (s - b))[0] for b, q, s in zip(pb, qb, ps)])
    return along - along[0]


def test_the_record_is_complete_and_two_handed(take):
    assert check(TAKE) == []
    assert sorted(str(a) for a in take["npz"]["arms"]) == ["L", "R"]


def test_the_part_stays_where_the_left_hand_holds_it(take):
    p, q = pose(take, "part")
    assert np.linalg.norm(p - p[0], axis=1).max() <= threshold("physics.placement_mm").value
    assert max(turned_deg(q[0], qk) for qk in q) <= threshold("physics.placement_deg").value


def test_the_calipers_read_the_pocket_depth(take):
    t0, t1 = take["plan"]["read"]
    t = take["npz"]["t"]
    r = reading_mm(take)[(t >= t0) & (t <= t1)]
    assert len(r) >= 0.5 * float(take["npz"]["fps"]), "a reading is held long enough to read"
    err = np.abs(r - pocket_depth_mm())
    assert err.max() <= caliper_accuracy_mm(), f"read {r.min():.3f}-{r.max():.3f} mm"


def test_the_calipers_are_carried_closed_and_put_back(take):
    p, _ = pose(take, "insp_cal6")
    fps = float(take["npz"]["fps"])
    assert p[:, 2].max() - p[0, 2] >= LIFT_MM
    assert abs(reading_mm(take)[-1]) <= CLOSED_MM
    assert np.linalg.norm(p[-1, :2] - p[0, :2]) <= PUT_BACK_MM
    assert abs(p[-1, 2] - p[0, 2]) <= threshold("physics.placement_mm").value      # resting on the bench again
    still = p[-int(0.3 * fps):]
    assert np.linalg.norm(still - still[-1], axis=1).max() < 0.1


def test_the_hand_never_touches_the_rod_and_the_skin_is_measured_on_calipers_and_part(take):
    assert "cal6_rod" in take["checks"]["never_held"]
    assert {"part", "insp_cal6", "insp_cal6_slider"} <= set(take["checks"]["solids"])


def test_the_take_passes_every_check(take):
    from moonshot.validate.take import run
    failed = {k: v for k, v in run(TAKE).items() if isinstance(v, str) or not v.passed}
    assert not failed, failed
