"""The setting steps' takes, Find X and Y and Set Z, in every VF-2 setup of G1's parts and of G2's ll-1007224 (its Op 30:
X and Y by a boss cycle round its top spigot, Z off its flange's top face), meet their outcomes on the full body
at the VF-2's pendant: the work offset the machine ends with puts the spindle on the datum the take planned, the jog
handle turns only while a hand turns it, every key the plan presses registers on the machine and no other does, and
every per-frame check passes (docs/moonshot/physics.md). Physics tier: farm and hub only (`pytest moonshot -m farm`),
on the takes the runners write to the data root (takes/<part>/<step id>/).

So does Check it's square, where a setup stands the part on the vise floor (nist-ftc-10's op50, ct-slbeam's op20 and
op30): a test indicator in the spindle, its ball pressed against the part's side, swept up it by jogging Z with the
handle; the needle stays put. So does Check it's straight, where a plate lies on the spoilboard (nist-ftc-09's op10,
ll-1005337's op10): the ball against its long edge, swept along it by jogging X; and ll-1007223's op30, the ball down
on the stem's side, which faces up at the floor of the T's notch, swept across it by jogging Y. A setup's "cuts"
(boxes, world mm at frame 0) are taken out of the part's box, as the probe's sensing takes them (sim/pendant.py).

What each take carries besides its record (take.npz, scene.json):
    take.json     "sets": {axis: {"method": "edge_finder" | "probe" | "touch_off", "datum_mm": [x, y, z], "wcs"}}, the
                  world point (mm, at frame 0) each axis's zero must pass through, in the work offset "wcs" (G54 if
                  none); for "z", "tool": {"length_mm"},
                  the gauge line to the tip of the tool the zero is set with; "events": the plan's key presses
                  ({"kind": "press", "key", "t0", "t1"}); for the check, "setup": {"tool": {"length_mm", "tip_r",
                  "offset_mm"} (the gauge line to the bottom of the indicator's ball, its radius, and how far its
                  centre stands off the spindle's axis, [x, y] in the tool's frame), "centre_mm", "half_mm" (the
                  part's box at frame 0, world, which it stands square to)}
    outcome.json  the machine at the end: "work": {"G54": [X, Y, Z], ...}, "tool_length": {n: Z}, "tool": n (machine
                  mm, Haas's signs), and "pressed": [[t, key], ...] as the machine registered them
    checks.json   per frame, "touching": what the hands touch, and "handle_deg": the jog handle's angle

The expected position is worked out here from the record's own body poses, not from the machine's control code
(plan §6, rule 2): machine X and Y move the table by -X and -Y, machine Z the head by +Z, each 0 at home. So is the
needle: how far the part's side pushes the indicator's ball in, from the tool's and the part's poses.
"""
import json

import numpy as np
import pytest

from moonshot.config import data_root
from moonshot.contracts.take_record import check
from moonshot.contracts.thresholds import threshold
from moonshot.planning.steps import expand
from moonshot.planning.takes import tool_takes
from moonshot.planning.validate import PLANS, load_plan

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = data_root() / "takes" / "nist-ftc-10"
PARTS = ("nist-ftc-10", "nist-ftc-09", "ll-1005337", "ll-1007223", "ct-slbeam",      # G1
         "ll-1007224")                                                               # G2's part drilled on the VF-2
# the VF-2's steps: a lathe's Set Z is a touch-off at the ST-25, not at this pendant
STEPS = [(p, s) for p in PARTS for s in expand(load_plan(p)) if s.get("machine") == "vf2"]
# ll-1005337's Op 20 checks the plate slid straight by probing its second dowel hole into G55 (the user's decision,
# 2026-11-05: its finished near edge stands past the Y travel's front): a work offset, held to the probe's bar
PROBED_CHECKS = ["ll-1005337/op20-check"]
SETTING = [f"{p}/{s['id']}" for p, s in STEPS if s["title"] in ("Find X and Y", "Set Z")] + PROBED_CHECKS
CHECKS = [f"{p}/{s['id']}" for p, s in STEPS if s["title"] in ("Check it's square", "Check it's straight")
          and f"{p}/{s['id']}" not in PROBED_CHECKS]
TOLERANCE = {"edge_finder": "setting.edge_finder_mm", "probe": "setting.probe_mm", "touch_off": "setting.touch_off_mm"}
DETENT_DEG = 3.6


def _folder(step):
    folder = data_root() / "takes" / step
    if not (folder / "take.npz").exists():
        pytest.skip(f"no take at {folder}")
    return folder


@pytest.fixture(params=SETTING + CHECKS)
def take(request):
    return _folder(request.param)


@pytest.fixture(params=SETTING)
def setting(request):
    return _folder(request.param)


@pytest.fixture(params=CHECKS)
def square(request):
    return _folder(request.param)


def _json(folder, name):
    return json.loads((folder / name).read_text(encoding="utf-8"))


def test_the_record_is_complete(take):
    assert check(take) == []


# not applicable to a pendant take (the user's decision, 2026-11-03): they measure a reach to grasp a part, the hand's
# opening for it, and the card's footage, none of which a hand at the pendant's keys and handle makes; every other
# per-frame check holds, nothing_moves_without_a_cause included
NOT_APPLICABLE = ("grasp_timing", "hand_opening", "matches_its_footage")


def test_every_per_frame_check_passes(take):
    from moonshot.validate.take import load_all, run
    assert set(NOT_APPLICABLE) <= set(load_all()), "a check named not applicable no longer exists"
    failed = {k: v for k, v in run(take).items()
              if k not in NOT_APPLICABLE and (isinstance(v, str) or not v.passed)}
    assert not failed, "\n".join(f"{k}: {v}" for k, v in failed.items())        # each in full: pytest cuts a dict


def test_the_work_offset_puts_the_spindle_on_the_planned_datum(setting):
    take = setting
    tk, out = _json(take, "take.json"), _json(take, "outcome.json")
    d = np.load(take / "take.npz")
    names = [str(b) for b in d["bodies"]]
    pos = lambda body: d["pos"][0, names.index(body)]              # noqa: E731  mm, frame 0
    base, spindle = pos("vf2"), pos("vf2_spindle")
    table = pos("vf2_table") - base                                  # the X and Y joints' travel at frame 0
    head = pos("vf2_head") - base                                    # the Z joint's
    assert tk["sets"], "the take sets no axis"
    for axis, s in tk["sets"].items():
        tol = threshold(TOLERANCE[s["method"]]).value
        datum = np.array(s["datum_mm"], float)
        G54 = np.array(out["work"][s.get("wcs", "G54")], float)             # the offset the take sets, G54 unless named
        if axis in "xy":
            i = "xy".index(axis)
            # at machine X (Y) = G54, the table's joint stands at -G54, carrying the datum with it
            at_zero = datum[i] + (-G54[i] - table[i])
            assert abs(at_zero - spindle[i]) <= tol, f"{axis}: {at_zero - spindle[i]:+.4f} mm off the spindle"
        else:
            tool = str(out["tool"])
            # with the tool commanded to work Z0 the gauge line stands at machine Z = G54 Z + the tool's length offset
            gauge = spindle[2] - head[2] + G54[2] + out["tool_length"][tool]
            tip = gauge - tk["setup"]["tool"]["length_mm"]
            assert abs(tip - datum[2]) <= tol, f"z: the tool's tip {tip - datum[2]:+.4f} mm off the datum"


def test_the_jog_handle_turns_only_while_a_hand_turns_it(take):
    c = _json(take, "checks.json")
    deg, touching = np.array(c["handle_deg"], float), c["touching"]
    moved = np.flatnonzero(np.abs(np.diff(deg)) > DETENT_DEG / 2) + 1
    loose = [int(k) for k in moved if not any("vf2_jog_handle" in touching[j] for j in (k - 1, k))]
    assert not loose, f"the handle turned untouched at frames {loose[:5]}"


def test_every_planned_key_press_registers_and_no_other(take):
    tk, out = _json(take, "take.json"), _json(take, "outcome.json")
    planned = sorted((e for e in tk["events"] if e["kind"] == "press"), key=lambda e: e["t0"])
    got = out["pressed"]
    assert [k for _, k in got] == [e["key"] for e in planned]
    # within the press, give or take the hand running ahead of its plan (0.05 s, the user's decision, 2026-11-03) or
    # behind it (0.2 s)
    for (t, k), e in zip(got, planned):
        assert e["t0"] - 0.05 <= t <= e["t1"] + 0.2, \
            f"{k} registered at {t:.2f} s, planned {e['t0']:.2f}-{e['t1']:.2f}"


def test_the_needle_stays_put_through_a_sweep_along_the_side(square):
    tk = _json(square, "take.json")
    s, d = tk["setup"], np.load(square / "take.npz")
    names = [str(b) for b in d["bodies"]]
    tool, blank = (names.index(b) for b in ("tool", "blank"))
    r = s["tool"]["tip_r"]
    w, v = d["quat"][:, tool, :1], d["quat"][:, tool, 1:]
    down = np.array([*s["tool"].get("offset_mm", (0.0, 0.0)), -(s["tool"]["length_mm"] - r)])   # the ball, tool frame
    t = 2 * np.cross(v, down)
    ball = d["pos"][:, tool] + down + w * t + np.cross(v, t)            # rotated by the tool's quaternion
    p = ball - (np.array(s["centre_mm"], float) + d["pos"][:, blank] - d["pos"][0, blank])   # the part moves with the table

    def box_gap(v, half):                                               # signed distance from a box's surface
        out = np.abs(v) - np.asarray(half, float)
        return np.linalg.norm(np.maximum(out, 0), axis=1) + np.minimum(out.max(axis=1), 0)
    gap = box_gap(p, s["half_mm"])
    for c in s.get("cuts", []):                                         # the part's box less its cuts
        gap = np.maximum(gap, -box_gap(p - (np.array(c["centre_mm"], float) - s["centre_mm"]), c["half_mm"]))
    needle = r - gap                                                    # mm the side pushes the ball in
    on = np.flatnonzero(needle > 0)
    assert on.size, "the indicator never touches the part"
    assert np.all(np.diff(on) == 1), f"the ball leaves the side mid-sweep, at frame {on[np.argmax(np.diff(on) > 1)]}"
    # the sweep: the ball's way over the side, along whichever direction it went farthest (up a square check's side by
    # Z, along a straight check's edge by X, across the stem's side by Y)
    q = p[on]
    a = int(np.argmax(np.abs(q[-1] - q[0])))
    lo, hi = sorted((q[0, a], q[-1, a]))
    assert hi - lo >= threshold("setting.sweep_mm").value, f"swept {hi - lo:.1f} mm along the side"
    sweep = (q[:, a] > lo + 0.5) & (q[:, a] < hi - 0.5)                  # not the ball's way in or out
    spread = np.ptp(needle[on][sweep])
    assert spread <= threshold("setting.indicator_mm").value, f"the needle moved {spread:.4f} mm"


# --- Load the tools ----------------------------------------------------------------------------------------------------
# In every part's every setup that brings new tools (nist-ftc-10's, and every other part a plan is written for), its
# takes cut together under takes/<part>/<step id>/ (moonshot/planning/
# takes.py tool_takes; the vf2-tool-load card): at the pendant MDI, the first tool's number and ATC FWD empty the
# spindle; then for each tool its holder is taken off the stand on the table and pushed up into the spindle while the
# left hand holds Tool Release (a seat take), and ATC FWD puts it in its pocket (an atc take). A holder in a far fork
# (planning/takes.py split) is taken in two takes cut together, as the operator steps over: picked off the stand from in
# front of it and held up (a pick take), then pushed up into the spindle from the doorway (an insert take), which starts
# with it held where the pick left it, from the body. Each holder ends seated on the spindle's gauge point, held by the
# drawbar alone with the hand off it; every key the plan presses registers and no other; and the machine ends the step
# with each tool in the pocket its number names, the tools numbered in the order the plan first uses them, the probe in
# the shop's 20.
#
# Besides the record: take.json "load" (kind, tool, pocket, and the state the run starts from), outcome.json "pockets"
# ({pocket: tool}), "spindle_tool", "tool_release_held_s" (when the machine read Tool Release held) and "pressed";
# checks.json "touching_R", the right hand's touches.
TOOL_STEPS = {f"{p}/{s['id']}": s for p in sorted(x.stem for x in PLANS.glob("*.json"))
              for s in expand(load_plan(p)) if s["title"] == "Load the tools"}      # by <part>/<step id>
TOOL_TAKES = [f"{ps}/{t}" for ps, s in TOOL_STEPS.items() for t in tool_takes(s)]
SEATS = [t for t in TOOL_TAKES if "-seat-" in t or "-insert-" in t]          # the takes that seat a holder
PICKS = [t for t in TOOL_TAKES if "-pick-" in t]
PROBE_POCKET = 20                                   # moonshot/library/records/shop.json conventions.probe_tool_number
INSERT_GRASPED = ("grasp_timing", "hand_opening")   # an insert's holder is grasped in the pick before it, not in it


def _tool_folder(path):
    """A tool take's folder, takes/<part>/<step id>/<take>."""
    folder = data_root() / "takes" / path
    if not (folder / "take.npz").exists():
        pytest.skip(f"no take at {folder}")
    return folder


@pytest.fixture(params=TOOL_TAKES)
def tool_take(request):
    return _tool_folder(request.param)


@pytest.fixture(params=SEATS)
def seat(request):
    return _tool_folder(request.param)


@pytest.fixture(params=PICKS)
def pick(request):
    return _tool_folder(request.param)


@pytest.fixture(params=list(TOOL_STEPS))
def tool_step(request):
    step = TOOL_STEPS[request.param]
    folders = [data_root() / "takes" / request.param / t for t in tool_takes(step)]
    missing = [f for f in folders if not (f / "take.npz").exists()]
    if missing:
        pytest.skip(f"no take at {missing[0]}")
    return step, folders


def test_a_tool_take_record_is_complete(tool_take):
    assert check(tool_take) == []


def test_every_per_frame_check_passes_on_a_tool_take(tool_take):
    """At the pendant, every check but the three not applicable to a pendant take (NOT_APPLICABLE); a seat or pick take
    reaches to grasp a holder and lifts it, so it is held to every check, the grasp's timing and the hand's opening
    included; an insert, the holder in the hand from its first frame, to every check but those two (INSERT_GRASPED:
    its grasp is the pick's, timed and measured there)."""
    from moonshot.validate.take import run
    kind = _json(tool_take, "take.json")["load"]["kind"]
    exempt = NOT_APPLICABLE if kind in ("change", "atc") else INSERT_GRASPED if kind == "insert" else ()
    failed = {k: v for k, v in run(tool_take).items()
              if k not in exempt and (isinstance(v, str) or not v.passed)}
    assert not failed, "\n".join(f"{k}: {v}" for k, v in failed.items())


def test_every_planned_key_press_registers_on_a_tool_take(tool_take):
    test_every_planned_key_press_registers_and_no_other(tool_take)


def test_the_holder_ends_seated_in_the_spindle_held_by_the_drawbar_alone(seat):
    """From the record's own poses: the holder's gauge line on the spindle's gauge point and its axis on the spindle's,
    within what a placement may miss by; lifted off the stand to get there; still, and the right hand off it, at the
    end; and Tool Release held while it went up (the machine's own record of the button)."""
    d, ck, out = np.load(seat / "take.npz"), _json(seat, "checks.json"), _json(seat, "outcome.json")
    names = [str(b) for b in d["bodies"]]
    h, sp = names.index("holder"), names.index("vf2_spindle")
    rel = d["pos"][-1, h] - d["pos"][-1, sp]
    w, x, y, z = d["quat"][-1, h]
    tilt = np.degrees(np.arccos(np.clip(1 - 2 * (x * x + y * y), -1, 1)))     # its axis from vertical
    mm, deg = threshold("physics.placement_mm").value, threshold("physics.placement_deg").value
    assert abs(rel[2]) <= mm, f"the gauge line {rel[2]:+.2f} mm off the spindle's"
    assert np.hypot(*rel[:2]) <= mm, f"the axis {np.hypot(*rel[:2]):.2f} mm off the spindle's"
    assert tilt <= deg, f"tilted {tilt:.2f} deg"
    if "-seat-" in seat.name:
        assert d["pos"][-1, h, 2] - d["pos"][0, h, 2] > 300, "the holder never came off the stand"
    fps = float(d["fps"])
    tail = d["pos"][-int(0.5 * fps):, h] - d["pos"][-int(0.5 * fps):, sp]
    assert np.ptp(tail, axis=0).max() < 0.1, "the holder moves in the spindle at the end"
    assert not any(n.startswith("holder") for t in ck["touching_R"][-int(0.5 * fps):] for n in t), "still held"
    assert "tool_release_head" in [k for _, k in out["pressed"]]
    assert out["tool_release_held_s"] is not None, "the drawbar never opened"


def test_a_pick_holds_the_holder_up_where_its_insert_starts(pick):
    """From the record's own poses: the holder lifted well clear of the stand and still in the hand (its carry) at the
    pick's end, not yet near the spindle; and the insert after it starts with the holder where the pick left it
    from the body (the two takes' lumbars: the operator stepped over, the holder in hand), within the tracking a run's
    hand keeps to its plan (physics.tracking_lag_mm)."""
    d, ck, tk = np.load(pick / "take.npz"), _json(pick, "checks.json"), _json(pick, "take.json")
    names = [str(b) for b in d["bodies"]]
    h = names.index("holder")
    assert d["pos"][-1, h, 2] - d["pos"][0, h, 2] > 150, "the holder never came off the stand"
    assert "carry_holder" in ck["active_constraints"][-1], "the holder not in the hand at the pick's end"
    step = TOOL_STEPS[f"{pick.parent.parent.name}/{pick.parent.name}"]
    takes = tool_takes(step)
    insert = pick.parent / takes[takes.index(pick.name) + 1]
    assert "-insert-" in insert.name
    d2, tk2 = np.load(insert / "take.npz"), _json(insert, "take.json")
    h2 = [str(b) for b in d2["bodies"]].index("holder")
    left = d["pos"][-1, h] - np.array(tk["lumbar"], float)
    starts = d2["pos"][0, h2] - np.array(tk2["lumbar"], float)
    off = float(np.linalg.norm(left - starts))
    assert off <= threshold("physics.tracking_lag_mm").value, f"the insert starts {off:.1f} mm off where the pick left it"


def _numbers(part):
    """The tools' numbers, the order the part's plan first uses them on the VF-2 (not the band saw's blade)."""
    order = list(dict.fromkeys(op["tool"] for s in load_plan(part)["setups"] if s.get("machine", "vf2") == "vf2"
                               for op in s["operations"]))
    return {t: i + 1 for i, t in enumerate(order)}


def test_the_step_ends_with_every_tool_in_its_pocket(tool_step):
    """The last take's machine holds each of the step's tools in its numbered pocket, the probe in 20 and the spindle
    empty; each ATC FWD put the tool just seated in its pocket; and each seat take's machine ends holding that tool in
    the spindle, the pocket its number names facing it."""
    step, folders = tool_step
    num = _numbers(folders[0].parent.parent.name)
    last = _json(folders[-1], "outcome.json")
    pockets = {int(p): t for p, t in last["pockets"].items()}
    for t in step["facts"]["tool_ids"]:
        assert pockets.get(num[t]) == t, f"{t} not in pocket {num[t]}: {pockets}"
    assert pockets.get(PROBE_POCKET) == "probe" and last["spindle_tool"] is None
    for f in folders:
        out, tk = _json(f, "outcome.json"), _json(f, "take.json")
        kind, tool = tk["load"]["kind"], tk["load"].get("tool")
        if kind == "atc":
            assert "atc_fwd" in [k for _, k in out["pressed"]], f.name
            assert {int(p): t for p, t in out["pockets"].items()}.get(num[tool]) == tool, f.name
        elif kind in ("seat", "insert"):
            assert out["spindle_tool"] == tool and out["current"] == num[tool], f.name
        elif kind == "pick":                        # held up, the pocket waiting for it at the spindle
            assert out["spindle_tool"] is None and out["current"] == num[tool], f.name
        else:                                       # the change: the probe put away, the first new pocket empty
            assert {int(p): t for p, t in out["pockets"].items()}.get(PROBE_POCKET) == "probe", f.name
            assert out["spindle_tool"] is None and out["current"] == num[step["facts"]["tool_ids"][0]], f.name
