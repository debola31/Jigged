"""The setting steps' takes, Find X and Y and Set Z, in every setup of nist-ftc-10, meet their outcomes on the full body
at the VF-2's pendant: the work offset the machine ends with puts the spindle on the datum the take planned, the jog
handle turns only while a hand turns it, every key the plan presses registers on the machine and no other does, and
every per-frame check passes (docs/moonshot/physics.md). Physics tier: farm and hub only (`pytest moonshot -m farm`),
on the takes the runners write to the data root (takes/nist-ftc-10/<step id>/).

What each take carries besides its record (take.npz, scene.json):
    take.json     "sets": {axis: {"method": "edge_finder" | "probe" | "touch_off", "datum_mm": [x, y, z]}}, the
                  world point (mm, at frame 0) each axis's zero must pass through; for "z", "tool": {"length_mm"},
                  the gauge line to the tip of the tool the zero is set with; "events": the plan's key presses
                  ({"kind": "press", "key", "t0", "t1"})
    outcome.json  the machine at the end: "work": {"G54": [X, Y, Z]}, "tool_length": {n: Z}, "tool": n (machine
                  mm, Haas's signs), and "pressed": [[t, key], ...] as the machine registered them
    checks.json   per frame, "touching": what the hands touch, and "handle_deg": the jog handle's angle

The expected position is worked out here from the record's own body poses, not from the machine's control code
(plan §6, rule 2): machine X and Y move the table by -X and -Y, machine Z the head by +Z, each 0 at home.
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
STEPS = [s["id"] for s in expand(load_plan("nist-ftc-10")) if s["title"] in ("Find X and Y", "Set Z")]
TOLERANCE = {"edge_finder": "setting.edge_finder_mm", "probe": "setting.probe_mm", "touch_off": "setting.touch_off_mm"}
DETENT_DEG = 3.6


@pytest.fixture(params=STEPS)
def take(request):
    folder = TAKES / request.param
    if not (folder / "take.npz").exists():
        pytest.skip(f"no take at {folder}")
    return folder


def _json(folder, name):
    return json.loads((folder / name).read_text(encoding="utf-8"))


def test_the_record_is_complete(take):
    assert check(take) == []


def test_every_per_frame_check_passes(take):
    from moonshot.validate.take import run
    failed = {k: v for k, v in run(take).items() if isinstance(v, str) or not v.passed}
    assert not failed, failed


def test_the_work_offset_puts_the_spindle_on_the_planned_datum(take):
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
            tip = gauge - tk["tool"]["length_mm"]
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
    for (t, k), e in zip(got, planned):
        assert e["t0"] <= t <= e["t1"] + 0.2, f"{k} registered at {t:.2f} s, planned {e['t0']:.2f}-{e['t1']:.2f}"
