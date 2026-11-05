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



class TouchOnsets:
    """When, between a run's frames, each touch the checks read began (checks.json touch_lead; plan §5.2): the
    touching record has a frame's instant only, and a reach is a few frames long, so with the frame alone the hand's
    widest opening moved 7% either way through a reach (validate/hand_opening.py, measured between frames: the user's
    decision, 2026-11-04). Per frame: each geom an arm came to touch, or equality that came on, during it (off at the
    step before), with how long before the frame's record it first did, in frames, (0, 1].

    mine, others: per geom, the arms' own, and what they may touch."""

    def __init__(self, model: mujoco.MjModel, mine: np.ndarray, others: np.ndarray):
        self.model, self.mine, self.others = model, mine, others
        self.prev: set[tuple[str, int]] = set()
        self.first: dict[tuple[str, int], int] = {}
        self.n = 0

    def step(self, data: mujoco.MjData) -> None:
        g = data.contact.geom[:data.ncon]
        a, b = self.mine[g[:, 0]], self.mine[g[:, 1]]
        now = {("g", int(x)) for x in g[a & self.others[g[:, 1]], 1]}
        now |= {("g", int(x)) for x in g[b & self.others[g[:, 0]], 0]}
        now |= {("e", int(i)) for i in np.flatnonzero(data.eq_active)}
        for x in now - self.prev:
            self.first.setdefault(x, self.n)
        self.prev = now
        self.n += 1

    def frame(self) -> dict[str, float]:
        m, n = self.model, max(1, self.n)
        out = {(m.geom(i).name if k == "g" else m.equality(i).name): round((n - s) / n, 4)
               for (k, i), s in self.first.items()}
        self.first, self.n = {}, 0
        return out


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


def hand_wrench(model: mujoco.MjModel, data: mujoco.MjData, hand: str) -> list[float]:
    """The net force and torque the world puts on a hand and everything it carries in its subtree (N, N m, world;
    torque about the wrist), what the muscle check replays the hand's load from (checks.json hand_wrench)."""
    m, d = model, data
    mujoco.mj_rnePostConstraint(m, d)
    h = m.body(hand).id
    W = d.xpos[h]
    f, tq = np.zeros(3), np.zeros(3)
    for b in range(m.nbody):
        p = b
        while p and p != h:
            p = m.body_parentid[p]
        if p != h:
            continue
        fb, tb = d.cfrc_ext[b][3:], d.cfrc_ext[b][:3]
        f += fb
        tq += tb + np.cross(d.subtree_com[m.body_rootid[b]] - W, fb)
    return [*f.round(4).tolist(), *tq.round(5).tolist()]


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
              glbs: dict[str, list[dict]] | None = None, meshes: dict[str, dict] | None = None) -> None:
        """meshes: {body: {"dir", "frames"}} for the bodies drawn from GLBs already written into the folder."""
        folder, m, glbs, meshes = Path(folder), self.model, glbs or {}, meshes or {}
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
            if name in meshes:
                entry["meshes"] = meshes[name]
            bodies[name] = entry
        scene = {"schema": SCHEMA, "station": station, "arms": list(self.arms), "bodies": bodies}
        (folder / "scene.json").write_text(json.dumps(scene, indent=1), encoding="utf-8")
