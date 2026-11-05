"""Cutting bar stock to length on the band saw (the bandsaw-cut-to-length card), for each of G1's bar parts, as the
person's takes at the saw and the machine's cut between them (plan §5.4): the bar slid along the bed to the stop
(<part>-saw), clamped by the handwheel (<part>-saw-clamp), the saw started and its feed opened (saw-start, the same
for every bar), cut by the machine with no one at it (<part>-saw-cut), the cut piece slid clear of the fixed jaw and the stop block
(<part>-saw-slide), and taken off to the bench from where that left it (lift-out-<part>-saw). Physics tier, on the takes the runner writes to the data root (moonshot/sim/bandsaw.py).
Protected (plan §6, rule 1).

The cut's outcomes are measured from the records, not the runner's account (plan §6, rule 2): where the bar lay when
it was clamped (the clamp take's record) against the blade's plane, the cut as it ran (cut.npz), and where the piece
and the rest of the bar went (the slide's and the lift-out's records). The length is the part's own blank (its plan's stock), held to
the shop's tolerance for its saw (library/records/shop.json saw-1: 0.015 in on a cut length, the stock sawn oversize
and machined).
"""
import json
from pathlib import Path

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.world import bandsaw as BS
from moonshot.world import saw_cell as SC

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
PARTS = ("ct-slbeam", "ll-1007223")         # G1's parts sawn from bar
PERSON = ("load", "clamp", "start", "slide", "unload")
SHOP = Path(__file__).resolve().parents[2] / "library" / "records" / "shop.json"
IN = 25.4
STILL_MM = 0.1              # clamped, the rest moves no more than this while it is cut
LIFT_MM = 20.0              # taken away, the piece rises this far off the bed at least
CLEAR_MM = 20.0             # slid clear, its cut end is this far from the blade at least: room for the fingers


def folders(part: str) -> dict[str, Path]:
    t = data_root() / "takes"
    return {"load": t / f"{part}-saw", "clamp": t / f"{part}-saw-clamp", "start": t / "saw-start",
            "cut": t / f"{part}-saw-cut", "slide": t / f"{part}-saw-slide", "unload": t / f"lift-out-{part}-saw"}


SLIDE_N = 15.0              # the card's push that slides the bar (bandsaw-cut-to-length phase 6)


def clamp_n() -> float:
    """Snug, as the card ends the clamp: the hand can no longer slide the bar. Both jaws' friction holds it against the
    card's slide force with people's own grip margin over slipping (physics.grip_safety_margin, its top): 82.5 N. The
    user allowed a lower force on 2026-11-05; the take reached this one (150 N), so it stands."""
    return SLIDE_N * threshold("physics.grip_safety_margin").band[1] / (2 * SC.STOCK["friction"])


def shop_tolerance_mm() -> float:
    shop = json.loads(SHOP.read_text(encoding="utf-8"))
    saw = next(m for m in shop["machines"] if m["id"] == "saw-1")
    assert shop["shop"]["units"] == "inch"
    return saw["achievable_tolerance"]["value"] * IN


def blank_mm(part: str) -> float:
    """The part's blank length, from its plan's stock: the size that isn't the bar's section."""
    from moonshot.planning.validate import load_plan
    st = load_plan(part)["stock"]
    return next(x for x in st["size_mm"] if all(abs(x - b) > 0.01 for b in st["bar_mm"]))


def quat_R(q):
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def load_take(folder: Path) -> dict:
    d = np.load(folder / "take.npz")
    tk = json.loads((folder / "take.json").read_text(encoding="utf-8"))
    place = SC.Place(tuple(tk["place"]["at_mm"]), tk["place"]["yaw_deg"])
    return {"dir": folder, "npz": d, "i": {str(b): j for j, b in enumerate(d["bodies"])}, "plan": tk, "place": place,
            "scene": json.loads((folder / "scene.json").read_text(encoding="utf-8")),
            "checks": json.loads((folder / "checks.json").read_text(encoding="utf-8")),
            "state": json.loads((folder / "state.json").read_text(encoding="utf-8"))}


@pytest.fixture(scope="module", params=PARTS)
def takes(request):
    part = request.param
    f = folders(part)
    missing = [str(f[k]) for k in f if not (f[k] / ("cut.npz" if k == "cut" else "take.npz")).exists()]
    if missing:
        pytest.skip(f"no physics run in {missing}")
    from moonshot.motion import bandsaw as P
    P.use_part(part)
    out = {k: load_take(f[k]) for k in PERSON}
    out["cut"] = dict(np.load(f["cut"] / "cut.npz"))
    out["part"], out["folders"] = part, f
    return out


def pose(take, body, k=slice(None)):
    """A body's centre (the station's mm) and rotation (the station's frame) at frame(s) k."""
    d, i, pl = take["npz"], take["i"][body], take["place"]
    p = pl.station(d["pos"][k, i])
    q = d["quat"][k, i]
    R = np.stack([pl.R.T @ quat_R(x) for x in q]) if q.ndim == 2 else pl.R.T @ quat_R(q)
    return p, R


def length_mm(take, body) -> float:
    g = next(g for g in take["scene"]["bodies"][body]["geoms"] if g["name"] == body)
    return 2 * g["size"][1]


def bar_end_y(take, k=-1) -> float:
    """Where the bar's end toward the stop is along the bed: its centre less half its length along its own axis."""
    c, R = pose(take, "bar", k)
    return float((c - R[:, 1] * length_mm(take, "bar") / 2)[1])


def test_every_take_record_is_complete(takes):
    for k in PERSON:
        assert check(takes[k]["dir"]) == [], k
        assert takes[k]["plan"]["card"] == "bandsaw-cut-to-length"
    for k in ("load", "clamp", "slide", "unload"):
        assert takes[k]["plan"]["part"] == takes["part"], k


def test_the_bar_is_slid_to_the_stop(takes):
    t = takes["load"]
    assert bar_end_y(t, 0) > SC.stop_face_y() + 40.0                   # it started well short of the stop
    assert abs(bar_end_y(t) - SC.stop_face_y()) <= shop_tolerance_mm()
    c0, _ = pose(t, "bar", 0)
    c1, _ = pose(t, "bar", -1)
    assert abs(c1[2] - c0[2]) <= threshold("physics.placement_mm").value   # slid along the bed, not lifted


def test_the_piece_is_cut_to_the_parts_length(takes):
    """From the bar's end as it lay clamped to the kerf's near side, where the blade's plane crosses its axis: the
    part's own blank."""
    t = takes["clamp"]
    c, R = pose(t, "bar", -1)
    axis = R[:, 1]
    end = c - axis * length_mm(t, "bar") / 2
    kerf = c + axis * (-c[1] / axis[1])                               # the blade's plane is y = 0
    piece = float(np.linalg.norm(kerf - end)) - SC.KERF_MM / 2
    assert abs(piece - blank_mm(takes["part"])) <= shop_tolerance_mm(), piece
    assert length_mm(takes["unload"], "piece") == pytest.approx(piece, abs=0.01)    # the piece the lift-out takes


def test_the_saw_is_started_and_its_feed_opened(takes):
    """Start pressed, the blade up to its speed; the valve's knob turned the card's quarter turn (from its pose in the
    record), which opens it to the cutting feed, and the bow coming down."""
    t = takes["start"]
    sfpm = np.asarray(t["checks"]["machine_axes"]["saw_blade_sfpm"])
    assert abs(sfpm[0]) < 1.0 and sfpm[-1] >= BS.record()["blade"]["speed_sfpm"][0] * 0.98
    _, R = pose(t, "saw_feed_valve")
    turn = np.degrees(np.arctan2((R[0].T @ R[-1])[1, 0], (R[0].T @ R[-1])[0, 0]))
    assert turn == pytest.approx(90.0, abs=10.0)
    rec = BS.record()["joints"]["feed_valve"]
    head = np.asarray(t["checks"]["machine_axes"]["saw_head_deg"])
    feed = t["state"]["control"]["feed_mm_s"]
    assert feed == pytest.approx(turn * rec["mm_s_per_deg"], rel=0.05) and head[-1] > head[0]


def test_the_bar_is_clamped_while_it_is_cut(takes):
    assert takes["clamp"]["checks"]["jaw_N"][-1] >= clamp_n()            # snug when the hand leaves the handwheel
    cut = takes["cut"]
    top = SC.bed_z() + SC.STOCK["h"]
    head = np.radians(cut["head_deg"])
    # the blade's edge over the bar, from the station's own geometry: the cut runs from where it meets the bar's top
    import mujoco
    m = mujoco.MjModel.from_xml_string(BS.standalone_xml())
    d = mujoco.MjData(m)
    x = np.mean(SC.bar_x())
    edge = []
    for q in head:
        d.qpos[m.jnt_qposadr[m.joint("saw_head").id]] = q
        mujoco.mj_kinematics(m, d)
        a, b = d.site("saw_blade_edge_a").xpos * 1000, d.site("saw_blade_edge_b").xpos * 1000
        edge.append(a[2] + (x - a[0]) / (b[0] - a[0]) * (b[2] - a[2]))
    edge = np.array(edge)
    cutting = (edge <= top) & (edge >= SC.bed_z())                     # the blade in the bar
    assert cutting.any() and edge.min() < SC.bed_z(), "the blade went through the bar"
    rest = cut["rest"]
    assert np.linalg.norm(rest[cutting] - rest[0], axis=1).max() <= STILL_MM
    assert cut["jaw_N"][cutting].min() >= clamp_n()
    assert cut["blade_sfpm"][cutting].min() >= BS.record()["blade"]["speed_sfpm"][0] * 0.98   # running as it cut
    assert abs(cut["blade_sfpm"][-1]) < 1.0                            # and stopped itself at the end of the cut
    assert cut["head_deg"][-1] >= BS.record()["joints"]["head"]["range_deg"][1] - 0.5


def corners_xy(take, body, k=-1) -> np.ndarray:
    """A stock body's four corners in plan (the station's mm) at frame k."""
    c, R = pose(take, body, k)
    hw, hl = SC.STOCK["w"] / 2, length_mm(take, body) / 2
    return np.array([(c + R @ [sx * hw, sy * hl, 0.0])[:2] for sx in (-1, 1) for sy in (-1, 1)])


def test_the_piece_is_slid_clear(takes):
    """Off the stop block's face and away from the blade, its ends free for the hand that lifts it, still flat on the
    bed; the rest of the bar still clamped."""
    t = takes["slide"]
    xy = corners_xy(t, "piece")
    assert xy[:, 0].max() < SC.bar_x()[0], xy                           # past the block's edge (it is the bar's width)
    assert xy[:, 1].max() <= -CLEAR_MM, xy                              # the blade's plane is y = 0
    p, _ = pose(t, "piece", -1)
    assert abs(p[2] - (SC.bed_z() + SC.STOCK["h"] / 2)) <= threshold("physics.placement_mm").value
    r, _ = pose(t, "rest")
    assert np.linalg.norm(r - r[0], axis=1).max() <= STILL_MM


def test_the_piece_comes_free_and_is_set_down_on_the_bench(takes):
    t = takes["unload"]
    p, _ = pose(t, "piece")
    s, _ = pose(takes["slide"], "piece", -1)
    assert np.linalg.norm(p[0] - s) <= threshold("physics.placement_mm").value   # where the slide left it
    assert p[:, 2].max() - p[0, 2] >= LIFT_MM
    lo, hi = np.array(SC.BENCH["lo"]), np.array(SC.BENCH["hi"])
    assert (lo < p[-1, :2]).all() and (p[-1, :2] < hi).all(), p[-1]
    assert abs(p[-1, 2] - (SC.bench_top_mm() + SC.STOCK["h"] / 2)) <= threshold("physics.placement_mm").value
    fps = float(t["npz"]["fps"])
    still = p[-int(0.3 * fps):]
    assert np.linalg.norm(still - still[-1], axis=1).max() < 0.5        # resting there, let go
    r, _ = pose(t, "rest")
    assert np.linalg.norm(r - r[0], axis=1).max() <= STILL_MM          # the rest stays clamped


def test_the_hand_never_touches_the_blade(takes):
    for k in PERSON:
        assert "saw_blade" in takes[k]["checks"]["never_held"]


@pytest.mark.parametrize("k", PERSON)
def test_each_take_passes_every_check(takes, k):
    from moonshot.validate.take import run
    failed = {n: v for n, v in run(takes["folders"][k]).items() if isinstance(v, str) or not v.passed}
    assert not failed, failed
