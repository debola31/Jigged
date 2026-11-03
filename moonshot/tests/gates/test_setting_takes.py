"""The setting steps' takes, Find X and Y and Set Z, in every setup of nist-ftc-10, meet their outcomes on the full body
at the VF-2's pendant: the work offset the machine ends with puts the spindle on the datum the take planned, the jog
handle turns only while a hand turns it, every key the plan presses registers on the machine and no other does, and
every per-frame check passes (docs/moonshot/physics.md). Physics tier: farm and hub only (`pytest moonshot -m farm`),
on the takes the runners write to the data root (takes/nist-ftc-10/<step id>/).

So does Check it's square, where a setup stands the part on the vise floor (op50): a test indicator in the spindle,
its ball pressed against the part's side, swept up it by jogging Z with the handle; the needle stays put.

What each take carries besides its record (take.npz, scene.json):
    take.json     "sets": {axis: {"method": "edge_finder" | "probe" | "touch_off", "datum_mm": [x, y, z]}}, the
                  world point (mm, at frame 0) each axis's zero must pass through; for "z", "tool": {"length_mm"},
                  the gauge line to the tip of the tool the zero is set with; "events": the plan's key presses
                  ({"kind": "press", "key", "t0", "t1"}); for the check, "setup": {"tool": {"length_mm", "tip_r",
                  "offset_mm"} (the gauge line to the bottom of the indicator's ball, its radius, and how far its
                  centre stands off the spindle's axis, [x, y] in the tool's frame), "centre_mm", "half_mm" (the
                  part's box at frame 0, world, which it stands square to)}
    outcome.json  the machine at the end: "work": {"G54": [X, Y, Z]}, "tool_length": {n: Z}, "tool": n (machine
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
from moonshot.planning.validate import load_plan

pytestmark = [pytest.mark.farm, pytest.mark.data_root]
TAKES = data_root() / "takes" / "nist-ftc-10"
SETTING = [s["id"] for s in expand(load_plan("nist-ftc-10")) if s["title"] in ("Find X and Y", "Set Z")]
CHECKS = [s["id"] for s in expand(load_plan("nist-ftc-10")) if s["title"] == "Check it's square"]
TOLERANCE = {"edge_finder": "setting.edge_finder_mm", "probe": "setting.probe_mm", "touch_off": "setting.touch_off_mm"}
DETENT_DEG = 3.6


def _folder(step):
    folder = TAKES / step
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
    assert not failed, failed


def test_the_work_offset_puts_the_spindle_on_the_planned_datum(setting):
    take = setting
    tk, out = _json(take, "take.json"), _json(take, "outcome.json")
    d = np.load(take / "take.npz")
    names = [str(b) for b in d["bodies"]]
    pos = lambda body: d["pos"][0, names.index(body)]              # noqa: E731  mm, frame 0
    base, spindle = pos("vf2"), pos("vf2_spindle")
    table = pos("vf2_table") - base                                  # the X and Y joints' travel at frame 0
    head = pos("vf2_head") - base                                    # the Z joint's
    G54 = np.array(out["work"]["G54"], float)
    assert tk["sets"], "the take sets no axis"
    for axis, s in tk["sets"].items():
        tol = threshold(TOLERANCE[s["method"]]).value
        datum = np.array(s["datum_mm"], float)
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


def test_the_needle_stays_put_through_a_sweep_up_the_side(square):
    tk = _json(square, "take.json")
    s, d = tk["setup"], np.load(square / "take.npz")
    names = [str(b) for b in d["bodies"]]
    tool, blank, head = (names.index(b) for b in ("tool", "blank", "vf2_head"))
    r = s["tool"]["tip_r"]
    w, v = d["quat"][:, tool, :1], d["quat"][:, tool, 1:]
    down = np.array([*s["tool"].get("offset_mm", (0.0, 0.0)), -(s["tool"]["length_mm"] - r)])   # the ball, tool frame
    t = 2 * np.cross(v, down)
    ball = d["pos"][:, tool] + down + w * t + np.cross(v, t)            # rotated by the tool's quaternion
    p = ball - (np.array(s["centre_mm"], float) + d["pos"][:, blank] - d["pos"][0, blank])   # the part moves with the table
    out = np.abs(p) - np.array(s["half_mm"], float)
    gap = np.linalg.norm(np.maximum(out, 0), axis=1) + np.minimum(out.max(axis=1), 0)
    needle = r - gap                                                    # mm the side pushes the ball in
    on = np.flatnonzero(needle > 0)
    assert on.size, "the indicator never touches the part"
    assert np.all(np.diff(on) == 1), f"the ball leaves the side mid-sweep, at frame {on[np.argmax(np.diff(on) > 1)]}"
    z = d["pos"][on, head, 2]
    rise = z[-1] - z[0]
    assert rise >= threshold("setting.sweep_mm").value, f"swept {rise:.1f} mm up the side"
    sweep = (z > z[0] + 0.5) & (z < z[-1] - 0.5)                        # while the head rises, not the ball's way in or out
    spread = np.ptp(needle[on][sweep])
    assert spread <= threshold("setting.indicator_mm").value, f"the needle moved {spread:.4f} mm"
