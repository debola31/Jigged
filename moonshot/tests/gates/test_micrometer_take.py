"""A part's thickness checked with the 0-1 in micrometer (G1's inspect steps whose caption's first check is a
micrometer's: ct-slbeam's "both legs .750 +-.002 with the micrometer"), plan §5.4: the left hand fetches it by the frame
and carries it to the part lying on its mat, the right takes the thimble and opens it past the leg; the anvil is set on
one face and the spindle brought onto the other; it is read, backed off, drawn clear and put back. Physics tier, on the
take the runner writes to the data root (takes/<part>-inspect); a part whose take isn't made yet is skipped.
Protected (plan §6, rule 1).

The reading is the spindle's face's distance from the anvil's along the frame's axis, from the take record and the
scene's own colliders, held to what the part really is, the leg its record gives (library/records/parts/<part>/
part.json), within half a graduation of the thimble (the micrometer's record: 0.001 in): what its scale shows. Its
accuracy, 0.0001 in, is finer than a contact in the physics holds. And both faces are on the leg's two sides as it is
read, in the part's own frame.
"""
import json
import re
from pathlib import Path

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
MOONSHOT = Path(__file__).resolve().parents[2]
IN = 25.4
# each part: the STEP axis its leg is read along, and where on that axis the leg's first face lies (mm)
PARTS = {"ct-slbeam": {"axis": 0, "face": 0.0}}
LIFT_MM = 20.0              # carried, the micrometer rises this far off the bench at least
PUT_BACK_MM = 15.0          # set down this near where it was taken from, as a person puts a tool back
REST_MM = 0.5               # and the spindle back within this of where it was
ON_FACE_MM = 0.1            # a face within this of the leg's side while it is read
OPENED_MM = 1.0             # opened past the leg by this at least before it goes round it


def leg_mm(part: str) -> float:
    rec = json.loads((MOONSHOT / "library" / "records" / "parts" / part / "part.json").read_text(encoding="utf-8"))
    return float(re.search(r"([\d.]+) legs", rec["size"]).group(1)) * IN


def half_graduation_mm() -> float:
    rec = json.loads((MOONSHOT / "library" / "records" / "assets" / "inspection" / "mic1" / "mic1.json")
                     .read_text(encoding="utf-8"))
    spec = next(s for s in rec["key_specs"] if s["name"] == "Graduation")
    assert spec["unit"] == "in"
    return spec["value"] * IN / 2


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


def face(take, body, geom, side):
    """A cylinder along its body's x: the middle of its end face on the -x (side -1) or +x (side +1) side, in its
    body (mm)."""
    g = next(g for g in take["scene"]["bodies"][body]["geoms"] if g["name"] == geom)
    assert g["type"] == "cylinder"
    return np.array(g["pos"]) + quat_R(g["quat"]) @ np.array([0.0, 0.0, g["size"][1]]) * np.sign(
        quat_R(g["quat"])[0, 2]) * side


def faces_world(take):
    """Per frame, world mm: the anvil's face (its +x end) and the spindle's (its -x end)."""
    a_local = face(take, "insp_mic1", "mic1_anvil", +1)
    s_local = face(take, "insp_mic1_spindle", "mic1_spindle", -1)
    pf, qf = pose(take, "insp_mic1")
    ps, qs = pose(take, "insp_mic1_spindle")
    a = np.array([p + quat_R(q) @ a_local for p, q in zip(pf, qf)])
    s = np.array([p + quat_R(q) @ s_local for p, q in zip(ps, qs)])
    return a, s


def reading_mm(take) -> np.ndarray:
    """Per frame, the spindle's face's distance from the anvil's along the frame's axis."""
    a, s = faces_world(take)
    _, qf = pose(take, "insp_mic1")
    return np.array([(quat_R(q).T @ (sk - ak))[0] for ak, sk, q in zip(a, s, qf)])


def in_part(take, pts):
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


def test_it_is_opened_past_the_leg_before_it_goes_round_it(take):
    assert reading_mm(take).max() >= leg_mm(take["part"]) + OPENED_MM


def test_the_micrometer_reads_the_leg(take):
    k = read_frames(take)
    r = reading_mm(take)[k]
    assert len(r) >= 0.5 * float(take["npz"]["fps"]), "a reading is held long enough to read"
    err = np.abs(r - leg_mm(take["part"]))
    assert err.max() <= half_graduation_mm(), f"read {r.min():.4f}-{r.max():.4f} mm"


def test_anvil_and_spindle_are_on_the_legs_sides_as_it_is_read(take):
    k = read_frames(take)
    spec = PARTS[take["part"]]
    a, s = faces_world(take)
    sides = sorted([in_part(take, a)[k, spec["axis"]].mean(), in_part(take, s)[k, spec["axis"]].mean()])
    lo, hi = spec["face"], spec["face"] + leg_mm(take["part"])
    assert abs(sides[0] - lo) <= ON_FACE_MM and abs(sides[1] - hi) <= ON_FACE_MM, sides


def test_the_micrometer_is_carried_and_put_back(take):
    p, _ = pose(take, "insp_mic1")
    fps = float(take["npz"]["fps"])
    r = reading_mm(take)
    assert p[:, 2].max() - p[0, 2] >= LIFT_MM
    assert abs(r[-1] - r[0]) <= REST_MM
    assert np.linalg.norm(p[-1, :2] - p[0, :2]) <= PUT_BACK_MM
    assert abs(p[-1, 2] - p[0, 2]) <= threshold("physics.placement_mm").value      # resting on the bench again
    still = p[-int(0.3 * fps):]
    assert np.linalg.norm(still - still[-1], axis=1).max() < 0.1


def test_the_hands_never_touch_its_faces_and_the_skin_is_measured_on_it_and_the_part(take):
    assert {"mic1_anvil", "mic1_spindle"} <= set(take["checks"]["never_held"])
    assert {"part", "insp_mic1", "insp_mic1_spindle"} <= set(take["checks"]["solids"])


def test_the_take_passes_every_check(take):
    from moonshot.validate.take import run
    failed = {k: v for k, v in run(take["folder"]).items() if isinstance(v, str) or not v.passed}
    assert not failed, failed
