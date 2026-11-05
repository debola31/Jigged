"""How the grasp checks read a step take's record (moonshot/sim/runner.py TakeRunner): a left hand's grasp is measured
from the left hand's own angles (sim.npz q_L, the runner's key), an object both hands carry is read as carried by
either's weld (carry_<object>_R, carry_<object>_L), and a grasp the user exempted from a check (take.json "exempt",
by its grip) is listed rather than judged, while the take's other grasps still are.

The take is built here: a block on the table the left hand reaches for in 1 s and carries, and, with `second`, a
second block the right hand reaches for afterwards."""
import json

import numpy as np
import pytest

from moonshot.body.skeleton import build
from moonshot.sim.runner import ARM
from moonshot.validate import grasp_timing as GT
from moonshot.validate import hand_opening as HO
from moonshot.validate import objects

FPS = 30


def _min_jerk(s):
    s = np.clip(s, 0.0, 1.0)
    return 10 * s ** 3 - 15 * s ** 4 + 6 * s ** 5


def make_take(folder, exempt=(), second=False):
    """A step take's record: n frames; the left hand reaches the block over frames 20-50 and carries it from 50; with
    second, the right hand reaches block_b over frames 70-100. exempt: the grips (by name) exempt from both grasp
    checks."""
    n = 130
    t = np.arange(n) / FPS
    names = [j[2:] for j in build().joints if j.startswith("R_") and j[2:] not in ARM]
    rest = np.array([build().joints[f"R_{j}"].rest for j in names])
    W_L = np.zeros((n, 3))
    W_L[:, 0] = 300.0 * _min_jerk((np.arange(n) - 20) / 30.0)
    W_R = np.zeros((n, 3))
    W_R[:, 0] = -300.0 * _min_jerk((np.arange(n) - 70) / 30.0)
    bodies = ["block", "block_b"]
    pos = np.zeros((n, 2, 3))
    pos[:, 0] = [300.0, 0.0, 20.0]
    pos[:, 1] = [-300.0, 0.0, 20.0]
    quat = np.tile([1.0, 0.0, 0.0, 0.0], (n, 2, 1))
    np.savez(folder / "take.npz", fps=FPS, t=t, bodies=np.array(bodies), pos=pos, quat=quat, R_W=W_R, L_W=W_L)
    geom = lambda name: {"name": name, "type": "box", "size": [20.0, 20.0, 20.0], "pos": [0.0, 0.0, 0.0],   # noqa: E731
                         "quat": [1.0, 0.0, 0.0, 0.0], "rgba": [1, 1, 1, 1]}
    (folder / "scene.json").write_text(json.dumps({"bodies": {b: {"role": "object", "geoms": [geom(f"{b}_g")]}
                                                              for b in bodies}}), encoding="utf-8")
    touching = [["block_g"] if k >= 50 else [] for k in range(n)]
    if second:
        touching = [tt + (["block_b_g"] if k >= 100 else []) for k, tt in enumerate(touching)]
    active = [["carry_block_L"] if k >= 52 else [] for k in range(n)]
    ck = {"touching": touching, "active_constraints": active, "touch_lead": [{} for _ in range(n)], "load_N": {},
          "weight_N": {}}
    (folder / "checks.json").write_text(json.dumps(ck), encoding="utf-8")
    events = [{"kind": "grip", "t0": 50 / FPS - 0.1, "t1": t[-1], "side": "L", "grip": "grab_L", "on": "block"},
              {"kind": "carry", "t0": 52 / FPS, "t1": t[-1], "side": "L", "obj": "block"}]
    if second:
        events += [{"kind": "grip", "t0": 100 / FPS - 0.1, "t1": t[-1], "side": "R", "grip": "grab_R", "on": "block_b"},
                   {"kind": "carry", "t0": 102 / FPS, "t1": t[-1], "side": "R", "obj": "block_b"}]
    tk = {"events": events, "exempt": [{"grip": g, "checks": ["grasp_timing", "hand_opening"], "why": "test"}
                                       for g in exempt]}
    (folder / "take.json").write_text(json.dumps(tk), encoding="utf-8")
    q = np.tile(rest, (n, 1))
    np.savez(folder / "sim.npz", t=t, fps=FPS, names=np.array(names), q=q, q_L=q)   # the runner's keys: no L_q
    return folder


def test_a_left_hand_grasp_in_a_step_take_is_measured(tmp_path):
    data = HO.measure(make_take(tmp_path))
    assert data["hand"] == {"block": "L"}
    assert len(data["aperture_L_mm"]) == len(data["aperture_mm"])
    r = HO.hand_opening(data)
    assert [g["hand"] for g in r.detail["reaches"]] == ["L"]           # judged, from the left hand's own opening
    g = GT.grasp_timing(GT.measure(tmp_path))
    assert [x["hand"] for x in g.detail["grasps"]] == ["L"]
    assert g.detail["grasps"][0]["reach_s"] == pytest.approx(1.0, abs=0.15)


def test_an_object_both_hands_carry_is_carried_by_either_weld():
    assert objects.carried([["carry_blank_R", "carry_blank_L"], ["carry_blank_L"], ["carry_air_gun"], []]) == \
        [["blank"], ["blank"], ["air_gun"], []]


def test_an_exempt_grasp_is_listed_not_judged(tmp_path):
    folder = make_take(tmp_path, exempt=("grab_L",))
    r = HO.hand_opening(HO.measure(folder))
    g = GT.grasp_timing(GT.measure(folder))
    for res in (r, g):
        assert res.passed and res.detail["exempt"] == ["block"]


def test_only_the_exempt_grasp_is_skipped(tmp_path):
    folder = make_take(tmp_path, exempt=("grab_L",), second=True)
    r = HO.hand_opening(HO.measure(folder))
    g = GT.grasp_timing(GT.measure(folder))
    assert [x["object"] for x in r.detail["reaches"]] == ["block_b"]
    assert [x["object"] for x in g.detail["grasps"]] == ["block_b"]
    assert [x["object"] for x in g.detail["exempt_reaches"]] == ["block"]
