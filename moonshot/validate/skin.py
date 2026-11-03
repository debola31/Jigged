"""The rendered skin's depth inside solids, per frame, from a physics run (plan §5.1; docs/moonshot/physics.md).

NIMBLE's skin, posed by the run's own finger angles and hand frame (sim.npz), against the parts the hand works on:
for the vise take, the blank, the crank's knob and lever, and the parallels. A take whose checks.json names its
solids (the bench takes) is measured from its take record instead: every hand it records, the left reflected back
through the body's mid-plane, against every collider of each named body where the record has it that frame. The
physics hand is capsules; this is the skin the render draws on them, so the depth is what a viewer would see sink in,
measured without MuJoCo's contact report (plan §6, rule 2). trainual's bake presses that skin onto the surfaces it
sinks into, which hides the depth; this doesn't.
"""
from __future__ import annotations

import json
import math
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from moonshot.body.hand import AnatomicalHand
from moonshot.body.nimble import Nimble
from moonshot.config import data_root
from moonshot.world import vise as V


def _box(p, c, R, half):
    d = np.abs((p - c) @ R) - half
    return np.linalg.norm(np.maximum(d, 0), axis=1) + np.minimum(d.max(1), 0)


def _cylinder(p, a, b, r):
    """Signed distance to a capped cylinder from a to b, radius r."""
    u = (b - a) / np.linalg.norm(b - a)
    t = (p - a) @ u
    L = np.linalg.norm(b - a)
    d = np.stack([np.linalg.norm(p - a - np.outer(t, u), axis=1) - r, np.abs(t - L / 2) - L / 2], 1)
    return np.linalg.norm(np.maximum(d, 0), axis=1) + np.minimum(d.max(1), 0)


def _capsule(p, a, b, r):
    u = b - a
    t = np.clip((p - a) @ u / (u @ u), 0, 1)
    return np.linalg.norm(p - a - np.outer(t, u), axis=1) - r


def _depths(take: Path, frames: np.ndarray) -> list[float]:
    sim = np.load(take / "sim.npz")
    tk = json.loads((take / "take.json").read_text(encoding="utf-8"))
    load = V.Load.from_json(tk["load"]) if "load" in tk else V.REFERENCE
    hand = AnatomicalHand(Nimble(data_root() / "hand-model" / "nimble"))
    B = hand.wrist_frame()
    used = np.unique(hand.model.skin_f)
    names = [str(n) for n in sim["names"]]
    ax, VS = np.asarray(V.VISE["screw_axis"], float), V.VISE
    para = np.array([V.PARALLEL_L / 2, V.PARALLEL_T / 2, load.parallel_h / 2])
    out = []
    for k in frames:
        skin = hand.forward(hand.clamp(dict(zip(names, sim["q"][k]))), collision=True, smooth=True)["skin"]
        p = (skin @ (sim["H"][k] @ B.T).T + sim["W"][k])[used]
        phi = math.radians(sim["crank"][k])
        root = ax + VS["lever"] * np.array([math.sin(phi), 0, math.cos(phi)])
        sdf = [_box(p, sim["blank"][k], sim["blank_R"][k], load.half),
               _cylinder(p, root, root - [0, VS["knob_len"], 0], VS["knob_r"]),
               _capsule(p, ax + [0, 2, 0], root + [0, 2, 0], 8.0)]
        sdf += [_box(p, c, np.eye(3), para) for c in sim["para"][k]]
        out.append(float(max(0.0, -np.min(sdf))))
    return out


def _quat_R(q) -> np.ndarray:
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def _geom_sdf(p, g: dict, pos, R) -> np.ndarray:
    """Signed distance (mm) to a take record's collider (scene.json) on a body at (pos, R)."""
    c = pos + R @ np.asarray(g["pos"], float)
    Rg = R @ _quat_R(g["quat"])
    s = np.asarray(g["size"], float)
    if g["type"] == "box":
        return _box(p, c, Rg, s[:3])
    if g["type"] in ("capsule", "cylinder"):
        a, b = c - Rg[:, 2] * s[1], c + Rg[:, 2] * s[1]
        return _capsule(p, a, b, s[0]) if g["type"] == "capsule" else _cylinder(p, a, b, s[0])
    if g["type"] == "sphere":
        return np.linalg.norm(p - c, axis=1) - s[0]
    raise ValueError(f"no distance for a {g['type']} collider ({g['name']})")


def _record_depths(take: Path, frames: np.ndarray) -> list[float]:
    """The take record's way: every recorded hand against every collider of checks.json's solids."""
    sim, rec = np.load(take / "sim.npz"), np.load(take / "take.npz")
    scene = json.loads((take / "scene.json").read_text(encoding="utf-8"))
    solids = json.loads((take / "checks.json").read_text(encoding="utf-8"))["solids"]
    bodies = [str(b) for b in rec["bodies"]]
    geoms = [(bodies.index(b), g) for b in solids for g in scene["bodies"][b]["geoms"]]
    hand = AnatomicalHand(Nimble(data_root() / "hand-model" / "nimble"))
    B = hand.wrist_frame()
    used = np.unique(hand.model.skin_f)
    names = [str(n) for n in sim["names"]]
    x2 = 2.0 * float(rec["mirror_x"])
    out = []
    for k in frames:
        deepest = 0.0
        for arm in (str(a) for a in rec["arms"]):
            pre = "" if arm == "R" else f"{arm}_"
            skin = hand.forward(hand.clamp(dict(zip(names, sim[pre + "q"][k]))), collision=True, smooth=True)["skin"]
            p = (skin @ (sim[pre + "H"][k] @ B.T).T + sim[pre + "W"][k])[used]
            if arm == "L":                                 # posed as the mirrored world's right hand: reflect it back
                p[:, 0] = x2 - p[:, 0]
            for i, g in geoms:
                deepest = max(deepest, float(-np.min(_geom_sdf(p, g, rec["pos"][k, i], _quat_R(rec["quat"][k, i])))))
        out.append(deepest)
    return out


def depth_mm(take: Path, workers: int | None = None) -> list[float]:
    """Per frame, the deepest skin vertex inside any of the solids (mm, 0 when none is inside). Frames are split
    across processes: posing NIMBLE's skin out of its muscle takes about 2 s a frame."""
    n = len(np.load(take / "sim.npz")["t"])
    checks = take / "checks.json"
    by_record = checks.exists() and "solids" in json.loads(checks.read_text(encoding="utf-8"))
    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    chunks = np.array_split(np.arange(n), workers)
    with ProcessPoolExecutor(workers) as ex:
        return [d for part in ex.map(_record_depths if by_record else _depths, [take] * len(chunks), chunks)
                for d in part]
