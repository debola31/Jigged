"""Record a physics run as a take record (moonshot/contracts/take_record.py), the renderer's only input: every body's
pose each frame, both hands as NIMBLE poses them, the camera, and what each body looks like.
"""
from __future__ import annotations

import json
from pathlib import Path

import mujoco
import numpy as np

from moonshot.contracts.take_record import ARM_KEYS, SCHEMA


def _pose(p_m, q) -> list[float]:
    return [round(float(v), 4) for v in (*(np.asarray(p_m) * 1000), *q)]


def glbs_in_bodies(model: mujoco.MjModel, root: str, links: dict[str, tuple[str, str]]) -> dict[str, list[dict]]:
    """Each body's GLBs, for meshes authored in `root`'s frame at joint zero (a station's links): links maps a link
    to (its body, its GLB's path under the data root)."""
    d = mujoco.MjData(model)
    mujoco.mj_kinematics(model, d)
    out: dict[str, list[dict]] = {}
    pr, qr = d.body(root).xpos, d.body(root).xquat
    for link, (body, path) in links.items():
        pb, qb = d.body(body).xpos, d.body(body).xquat
        qi = np.zeros(4)
        mujoco.mju_negQuat(qi, qb)
        p, q = np.zeros(3), np.zeros(4)
        mujoco.mju_rotVecQuat(p, pr - pb, qi)
        mujoco.mju_mulQuat(q, qi, qr)
        out.setdefault(body, []).append({"path": path, "in_body": _pose(p, q), "link": link})
    return out


class Recorder:
    def __init__(self, model: mujoco.MjModel, person: set[str], arms=("R",)):
        self.model, self.person, self.arms = model, person, tuple(arms)
        self.names = [model.body(b).name for b in range(1, model.nbody)]
        self.pos, self.quat, self.cam = [], [], []
        self.hands = {s: {k: [] for k in ARM_KEYS} for s in self.arms}

    def frame(self, data: mujoco.MjData, hands: dict[str, dict], eye, look, up) -> None:
        """One frame: the bodies from data, each arm's hand (ARM_KEYS) and the camera, all in mm."""
        self.pos.append(data.xpos[1:] * 1000)
        self.quat.append(data.xquat[1:].copy())
        self.cam.append(np.array([eye, look, up], float))
        for s in self.arms:
            for k in ARM_KEYS:
                self.hands[s][k].append(np.asarray(hands[s][k], float))

    def write(self, folder: Path, fps: int, mirror_x: float, q_names: dict[str, list[str]], station: str,
              glbs: dict[str, list[dict]] | None = None) -> None:
        folder, m, glbs = Path(folder), self.model, glbs or {}
        n = len(self.pos)
        cam = np.array(self.cam)
        arrays = {"fps": fps, "t": np.arange(n) / fps, "bodies": np.array(self.names), "pos": np.array(self.pos),
                  "quat": np.array(self.quat), "eye": cam[:, 0], "look": cam[:, 1], "up": cam[:, 2],
                  "arms": np.array(self.arms), "mirror_x": float(mirror_x)}
        for s in self.arms:
            arrays[f"{s}_q_names"] = np.array(q_names[s])
            arrays |= {f"{s}_{k}": np.array(v) for k, v in self.hands[s].items()}
        np.savez_compressed(folder / "take.npz", **arrays)
        bodies = {}
        for b, name in enumerate(self.names, start=1):
            geoms = [{"name": m.geom(g).name, "type": mujoco.mjtGeom(m.geom_type[g]).name[7:].lower(),
                      "size": [round(float(v) * 1000, 3) for v in m.geom_size[g]],
                      "pos": [round(float(v) * 1000, 3) for v in m.geom_pos[g]],
                      "quat": [round(float(v), 6) for v in m.geom_quat[g]],
                      "rgba": [round(float(v), 3) for v in m.geom_rgba[g]]}
                     for g in range(m.ngeom) if m.geom_bodyid[g] == b]
            entry = {"role": "body" if name in self.person else "object", "geoms": geoms}
            if name in glbs:
                entry["glbs"] = glbs[name]
            bodies[name] = entry
        scene = {"schema": SCHEMA, "station": station, "arms": list(self.arms), "bodies": bodies}
        (folder / "scene.json").write_text(json.dumps(scene, indent=1), encoding="utf-8")
