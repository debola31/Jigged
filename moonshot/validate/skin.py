"""The rendered skin's depth inside solids, per frame, from a take record (moonshot/contracts/take_record.py; plan §5.1;
docs/moonshot/physics.md).

NIMBLE's skin, posed by each arm's own finger angles and hand frame (take.npz), against every object's colliders in
the scene (scene.json), wherever the run put them. The left hand is posed as the right of the mirrored world, as the
record gives it, and reflected through x = mirror_x. The physics hand is capsules; this is the skin the render draws
on them, so the depth is what a viewer would see sink in, measured without MuJoCo's contact report (plan §6, rule 2).
trainual's bake presses that skin onto the surfaces it sinks into, which hides the depth; this doesn't.
"""
from __future__ import annotations

import json
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from scipy.spatial.transform import Rotation

from moonshot.body.hand import AnatomicalHand
from moonshot.body.nimble import Nimble
from moonshot.config import data_root

REACH_MM = 250.0            # farther than this from the wrist, past a solid's bounding sphere, the skin can't touch it


def _sdf(p, g):
    """Signed distance (mm) from points p (n, 3), in the geom's own frame, to a collider: box, cylinder and capsule
    along their z, sphere, or plane (its z the outward normal)."""
    t, s = g["type"], np.asarray(g["size"], float)
    if t == "box":
        d = np.abs(p) - s[:3]
        return np.linalg.norm(np.maximum(d, 0), axis=1) + np.minimum(d.max(1), 0)
    if t == "cylinder":
        d = np.stack([np.linalg.norm(p[:, :2], axis=1) - s[0], np.abs(p[:, 2]) - s[1]], 1)
        return np.linalg.norm(np.maximum(d, 0), axis=1) + np.minimum(d.max(1), 0)
    if t == "capsule":
        q = p.copy()
        q[:, 2] -= np.clip(q[:, 2], -s[1], s[1])
        return np.linalg.norm(q, axis=1) - s[0]
    if t == "sphere":
        return np.linalg.norm(p, axis=1) - s[0]
    if t == "plane":
        return p[:, 2]
    raise ValueError(f"the skin check has no distance for a {t} collider ({g['name']})")


def _radius(g) -> float:
    s = np.asarray(g["size"], float)
    return {"box": float(np.linalg.norm(s[:3])), "cylinder": float(np.hypot(s[0], s[1])),
            "capsule": float(s[0] + s[1]), "sphere": float(s[0])}.get(g["type"], np.inf)


def _near(W, c, Rg, g) -> bool:
    if g["type"] == "plane":
        return abs((W - c) @ Rg[:, 2]) < REACH_MM
    return np.linalg.norm(W - c) < _radius(g) + REACH_MM


def _solids(take: Path) -> list[tuple[int, dict]]:
    """(body index in take.npz, collider) for every object's colliders: what the skin mustn't sink into."""
    d = np.load(take / "take.npz")
    scene = json.loads((take / "scene.json").read_text(encoding="utf-8"))
    names = [str(b) for b in d["bodies"]]
    return [(names.index(n), g) for n, b in scene["bodies"].items() if b["role"] == "object" for g in b["geoms"]]


def _depths(take: Path, frames: np.ndarray) -> list[float]:
    d = np.load(take / "take.npz")
    hand = AnatomicalHand(Nimble(data_root() / "hand-model" / "nimble"))
    B = hand.wrist_frame()
    used = np.unique(hand.model.skin_f)
    solids = _solids(take)
    mirror_x = float(d["mirror_x"])
    out = []
    for k in frames:
        R = Rotation.from_quat(d["quat"][k][:, [1, 2, 3, 0]]).as_matrix()          # w x y z -> scipy's x y z w
        placed = []
        for b, g in solids:
            Rg = R[b] @ Rotation.from_quat(np.r_[g["quat"][1:], g["quat"][0]]).as_matrix()
            placed.append((d["pos"][k, b] + R[b] @ np.asarray(g["pos"], float), Rg, g))
        worst = 0.0
        for arm in (str(a) for a in d["arms"]):
            W = d[f"{arm}_W"][k].copy()
            if arm == "L":
                W[0] = 2 * mirror_x - W[0]
            near = [(c, Rg, g) for c, Rg, g in placed if _near(W, c, Rg, g)]
            if not near:
                continue
            q = dict(zip((str(n) for n in d[f"{arm}_q_names"]), d[f"{arm}_q"][k]))
            skin = hand.forward(hand.clamp(q), collision=True, smooth=True)["skin"]
            p = (skin @ (d[f"{arm}_H"][k] @ B.T).T + d[f"{arm}_W"][k])[used]
            if arm == "L":
                p[:, 0] = 2 * mirror_x - p[:, 0]
            for c, Rg, g in near:
                worst = max(worst, float(-np.min(_sdf((p - c) @ Rg, g))))
        out.append(worst)
    return out


def depth_mm(take: Path, workers: int | None = None) -> list[float]:
    """Per frame, the deepest skin vertex of either hand inside any object's collider (mm, 0 when none is inside).
    Frames are split across processes: posing NIMBLE's skin out of its muscle takes about 2 s a frame, so a hand
    farther than REACH_MM from every solid isn't posed."""
    n = len(np.load(take / "take.npz")["t"])
    workers = min(n, workers or max(1, (os.cpu_count() or 2) - 1))
    chunks = np.array_split(np.arange(n), workers)
    if workers == 1:
        return _depths(take, chunks[0])
    with ProcessPoolExecutor(workers) as ex:
        return [x for part in ex.map(_depths, [take] * len(chunks), chunks) for x in part]
