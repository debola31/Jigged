"""A part's length checked with the 6 in calipers' outside jaws (G1's inspect steps whose first check is a size, plan
§5.4): the left hand fetches the calipers by the beam and carries them face up to the part lying on its mat, the right
takes the slider, opens the jaws past the part, and closes them on its two ends; they are read, opened, drawn back,
closed and put back. Physics tier, on the take the runner writes to the data root (takes/<part>-inspect); a part whose
take isn't made yet is skipped. Protected (plan §6, rule 1).

The reading is the slider's travel along the beam (the beam body's +x) from where it starts, closed, measured from the
take record, and it is held to what the part really is, the size its record gives (library/records/parts/<part>/
part.json), within the calipers' own accuracy (their record, Mitutoyo 500-196-30: 0.001 in). And both jaws' measuring
faces are on the part's two ends as it is read, in the part's own frame: a reading taken in the air, or with one jaw
off its face and the part pushed along the mat, can't pass.
"""
import json
from pathlib import Path

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
MOONSHOT = Path(__file__).resolve().parents[2]
IN = 25.4
# each part: which of its record's sizes is checked (0 the first), and the STEP axis it lies along
PARTS = {"ll-1007223": {"size": 0, "axis": 2}}
LIFT_MM = 20.0              # carried, the calipers rise this far off the bench at least
PUT_BACK_MM = 15.0          # set down this near where they were taken from, as a person puts a tool back
CLOSED_MM = 0.5             # closed again: the slider back within this of zero
ON_FACE_MM = 0.1            # a jaw's measuring face within this of the part's end while it is read
OPENED_MM = 3.0             # the jaws opened past the part by this at least before they go round it


def size_mm(part: str) -> float:
    rec = json.loads((MOONSHOT / "library" / "records" / "parts" / part / "part.json").read_text(encoding="utf-8"))
    return float(rec["size"].split(" mm")[0].split(" x ")[PARTS[part]["size"]])


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


@pytest.fixture(scope="module", params=sorted(PARTS))
def take(request):
    folder = data_root() / "takes" / f"{request.param}-inspect"
    if not (folder / "take.npz").exists():
        pytest.skip(f"no physics run in {folder}")
    d = np.load(folder / "take.npz")
    bodies = [str(b) for b in d["bodies"]]
    return {"part": request.param, "folder": folder, "npz": d, "i": {b: k for k, b in enumerate(bodies)},
            "scene": json.loads((folder / "scene.json").read_text(encoding="utf-8")),
            "plan": json.loads((folder / "take.json").read_text(encoding="utf-8")),
            "checks": json.loads((folder / "checks.json").read_text(encoding="utf-8"))}


def pose(take, body):
    d, i = take["npz"], take["i"][body]
    return d["pos"][:, i], d["quat"][:, i]


def reading_mm(take) -> np.ndarray:
    """Per frame, the slider's travel along the beam from frame 0."""
    pb, qb = pose(take, "insp_cal6")
    ps, _ = pose(take, "insp_cal6_slider")
    along = np.array([(quat_R(q).T @ (s - b))[0] for b, q, s in zip(pb, qb, ps)])
    return along - along[0]


def jaw_face(take, body, geom, side):
    """Per frame, in world mm, the middle of a jaw box's face on its -x (side -1) or +x (side +1) side, and the beam's
    +x."""
    g = next(g for g in take["scene"]["bodies"][body]["geoms"] if g["name"] == geom)
    assert g["type"] == "box"
    Rg = quat_R(g["quat"])
    local = np.array(g["pos"]) + Rg @ np.array([side * g["size"][0], 0.0, 0.0])
    p, q = pose(take, body)
    return np.array([pk + quat_R(qk) @ local for pk, qk in zip(p, q)])


def in_part(take, pts):
    """World points, per frame, in the part's frame (mm)."""
    p, q = pose(take, "part")
    return np.array([quat_R(qk).T @ (x - pk) for x, pk, qk in zip(pts, p, q)])


def read_frames(take):
    t0, t1 = take["plan"]["read"]
    t = take["npz"]["t"]
    return (t >= t0) & (t <= t1)


def test_the_record_is_complete_and_two_handed(take):
    assert check(take["folder"]) == []
    assert sorted(str(a) for a in take["npz"]["arms"]) == ["L", "R"]


def test_the_part_stays_on_its_mat(take):
    p, q = pose(take, "part")
    assert np.linalg.norm(p - p[0], axis=1).max() <= threshold("physics.placement_mm").value
    assert max(turned_deg(q[0], qk) for qk in q) <= threshold("physics.placement_deg").value


def test_the_jaws_are_opened_past_the_part_before_they_go_round_it(take):
    assert reading_mm(take).max() >= size_mm(take["part"]) + OPENED_MM


def test_the_calipers_read_the_size(take):
    k = read_frames(take)
    r = reading_mm(take)[k]
    assert len(r) >= 0.5 * float(take["npz"]["fps"]), "a reading is held long enough to read"
    err = np.abs(r - size_mm(take["part"]))
    assert err.max() <= caliper_accuracy_mm(), f"read {r.min():.3f}-{r.max():.3f} mm"


def test_both_jaws_are_on_the_parts_ends_as_it_is_read(take):
    k = read_frames(take)
    ax, half = PARTS[take["part"]]["axis"], size_mm(take["part"]) / 2
    # the fixed jaw's measuring face is its box's +x side (toward the slider), the moving jaw's its -x side
    fixed = in_part(take, jaw_face(take, "insp_cal6", "cal6_jaw_out", +1))[k, ax]
    moving = in_part(take, jaw_face(take, "insp_cal6_slider", "cal6_mjaw_out", -1))[k, ax]
    ends = sorted([fixed.mean(), moving.mean()])
    assert abs(ends[0] + half) <= ON_FACE_MM and abs(ends[1] - half) <= ON_FACE_MM, (fixed.mean(), moving.mean())


def test_the_calipers_are_carried_closed_and_put_back(take):
    p, _ = pose(take, "insp_cal6")
    fps = float(take["npz"]["fps"])
    assert p[:, 2].max() - p[0, 2] >= LIFT_MM
    assert abs(reading_mm(take)[-1]) <= CLOSED_MM
    assert np.linalg.norm(p[-1, :2] - p[0, :2]) <= PUT_BACK_MM
    assert abs(p[-1, 2] - p[0, 2]) <= threshold("physics.placement_mm").value      # resting on the bench again
    still = p[-int(0.3 * fps):]
    assert np.linalg.norm(still - still[-1], axis=1).max() < 0.1


def test_the_hands_never_touch_the_jaws_and_the_skin_is_measured_on_calipers_and_part(take):
    assert {"cal6_jaw_out", "cal6_mjaw_out"} <= set(take["checks"]["never_held"])
    assert {"part", "insp_cal6", "insp_cal6_slider"} <= set(take["checks"]["solids"])


def test_the_take_passes_every_check(take):
    from moonshot.validate.take import run
    failed = {k: v for k, v in run(take["folder"]).items() if isinstance(v, str) or not v.passed}
    assert not failed, failed
