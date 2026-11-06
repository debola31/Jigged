"""Each part's deburring step (nist-ftc-10's step 69, "Deburr every edge", and G1's), as a two-handed physics take at
the inspection bench (plan §5.4): the left hand holds the finished part still on the bench while the right draws the
deburring tool's blade along its edges, then puts the tool back. Physics tier, on the take the runner writes to the
data root (takes/<part>-deburr); a part whose take isn't made yet is skipped. Protected (plan §6, rule 1).

Each stroke is measured from the take record, the blade's own collider against the edge the plan names in the
part's frame (its STEP's, mm), so the measurement doesn't use the runner's account of it (plan §6, rule 2). The
press force is the runner's: contact forces aren't in the record.
"""
import json

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
PARTS = ("nist-ftc-10", "ll-1007223", "ct-slbeam", "nist-ftc-09", "ll-1005337")
ON_EDGE_MM = 0.5            # the blade's collider within this of the edge counts as on it
ON_EDGE_FRAC = 0.9          # ... in this share of a stroke's frames, its first and last 0.2 s aside
COVER_FRAC = 0.8            # and its contact runs along this share of the edge
STROKE_MIN_MM = 50.0        # a stroke shorter than this isn't deburring an edge
LIFT_MM = 20.0              # carried, the tool rises this far off the bench at least
PUT_BACK_MM = 15.0          # set down this near where it was taken from, as a person puts a tool back


def quat_R(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def turned_deg(q0, q1):
    return float(np.degrees(2 * np.arccos(min(1.0, abs(float(np.dot(q0, q1)))))))


@pytest.fixture(scope="module", params=PARTS)
def take(request):
    folder = data_root() / "takes" / f"{request.param}-deburr"
    if not (folder / "take.npz").exists():
        pytest.skip(f"no physics run in {folder}")
    d = np.load(folder / "take.npz")
    bodies = [str(b) for b in d["bodies"]]
    return {"folder": folder, "npz": d, "i": {b: k for k, b in enumerate(bodies)},
            "scene": json.loads((folder / "scene.json").read_text(encoding="utf-8")),
            "plan": json.loads((folder / "take.json").read_text(encoding="utf-8")),
            "report": json.loads((folder / "report.json").read_text(encoding="utf-8")),
            "checks": json.loads((folder / "checks.json").read_text(encoding="utf-8"))}


def pose(take, body):
    d, i = take["npz"], take["i"][body]
    return d["pos"][:, i], d["quat"][:, i]


def blade_segments(take):
    """The blade's capsule, per frame, in world mm: its two end points and radius."""
    g = next(g for g in take["scene"]["bodies"]["deburr_tool"]["geoms"] if g["name"] == "deburr_blade")
    assert g["type"] == "capsule"
    r, half = g["size"][0], g["size"][1]
    axis = quat_R(g["quat"])[:, 2]
    ends = np.array([np.array(g["pos"]) - axis * half, np.array(g["pos"]) + axis * half])
    p, q = pose(take, "deburr_tool")
    return np.array([[pk + quat_R(qk) @ e for e in ends] for pk, qk in zip(p, q)]), r


def test_the_record_is_complete_and_two_handed(take):
    assert check(take["folder"]) == []
    assert sorted(str(a) for a in take["npz"]["arms"]) == ["L", "R"]


def test_the_part_stays_where_the_left_hand_holds_it(take):
    p, q = pose(take, "part")
    assert np.linalg.norm(p - p[0], axis=1).max() <= threshold("physics.placement_mm").value
    assert max(turned_deg(q[0], qk) for qk in q) <= threshold("physics.placement_deg").value


def test_each_stroke_runs_the_blade_along_its_edge(take):
    strokes = take["plan"]["strokes"]
    assert strokes, "a deburring take strokes at least one edge"
    t = take["npz"]["t"]
    seg, r = blade_segments(take)
    pp, pq = pose(take, "part")
    for s in strokes:
        a, b = (np.array(x, float) for x in s["edge_mm"])          # in the part's frame
        length = np.linalg.norm(b - a)
        assert length >= STROKE_MIN_MM, s
        u = (b - a) / length
        ks = np.nonzero((t >= s["t0"] + 0.2) & (t <= s["t1"] - 0.2))[0]
        on, along = 0, []
        for k in ks:
            R = quat_R(pq[k])
            ends = (seg[k] - pp[k]) @ R                               # the blade in the part's frame
            pts = ends[0] + np.linspace(0, 1, 60)[:, None] * (ends[1] - ends[0])
            w = np.clip((pts - a) @ u, 0, length)
            dist = np.linalg.norm(pts - a - np.outer(w, u), axis=1) - r
            if dist.min() <= ON_EDGE_MM:
                on += 1
                along.append(w[np.argmin(dist)])
        assert on >= ON_EDGE_FRAC * len(ks), f"blade on its edge {on} of {len(ks)} frames: {s}"
        assert np.ptp(along) >= COVER_FRAC * length, f"contact ran {np.ptp(along):.0f} of {length:.0f} mm: {s}"


def test_each_stroke_presses_with_its_force(take):
    for s, r in zip(take["plan"]["strokes"], take["report"]["strokes"], strict=True):
        assert abs(r["press_N_median"] - s["force_N"]) <= threshold("physics.force_target_frac").value * s["force_N"], r


def test_the_tool_is_carried_and_put_back(take):
    p, q = pose(take, "deburr_tool")
    fps = float(take["npz"]["fps"])
    assert p[:, 2].max() - p[0, 2] >= LIFT_MM
    assert np.linalg.norm(p[-1, :2] - p[0, :2]) <= PUT_BACK_MM
    assert abs(p[-1, 2] - p[0, 2]) <= threshold("physics.placement_mm").value      # resting on the bench again
    still = p[-int(0.3 * fps):]
    assert np.linalg.norm(still - still[-1], axis=1).max() < 0.1


def test_the_hand_never_touches_the_blade_and_the_skin_is_measured_on_both_tool_and_part(take):
    assert "deburr_blade" in take["checks"]["never_held"]
    assert {"part", "deburr_tool"} <= set(take["checks"]["solids"])


def test_the_take_passes_every_check(take):
    from moonshot.validate.take import run
    failed = {k: v for k, v in run(take["folder"]).items() if isinstance(v, str) or not v.passed}
    assert not failed, failed
