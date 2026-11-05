"""The skin bake: a take record's hands and sleeves for every frame of the render, and the rest of what the render needs
per frame, resampled to the render's 24 fps. Ported from trainual's motion/skin_bake.py.

    python -m moonshot.render.bake <take folder> [--out <folder>] [--fps 24]

Per frame and arm:
- NIMBLE's skin for the frame's joint angles (pose correctives from all 19 bone rotations; skin pushed outside the
  muscles, as NIMBLE's own collision step does), placed by the hand frame;
- the 21 mm wrist stub stretched into a forearm that follows the forearm's frame (pronation included) instead of the
  hand's, blended across the wrist, so the wrist bends between two rigid segments;
- contact: skin inside any object's geom is pressed onto its surface, and the skin around the patch bulges outward
  (the pulp displaced sideways);
- a shirt sleeve along shoulder, elbow and wrist, its cuff just above the wrist, with folds that bunch at the elbow.
The left arm comes as the right arm in the mirrored world (moonshot/contracts/take_record.py): it is posed as a right
arm, reflected through x = mirror_x, and its faces flipped, before it touches anything.

Writes <out>/: hand_<arm>.pc2 and sleeve_<arm>.pc2 (Blender's point caches, metres), skin_{diffuse,normal,spec}.png,
and bake.npz:
    fps, n, t                              the render's frame rate, frame count and times (s)
    bodies, pos, quat                      the take's bodies at the render's frames (mm; w x y z)
    eye, look, up, focus                   the camera, and where it focuses: between the working wrists (mm)
    arms                                   the arms drawn
    hand_faces_<arm>, sleeve_faces_<arm>   faces, wound outward on each arm
    hand_uv, hand_face_uv_<arm>, sleeve_uv UVs: the hand's per face corner, the sleeve's per vertex
    attr_<name>                            the skin's static attributes for the shader: rest, crease, nail, palmar, fore
    depth_<arm>                            per frame, how deep the skin was inside a solid before it was pressed (mm)
    mesh_<body>                            for a body with "meshes", the take frame whose mesh each render frame draws
"""
from __future__ import annotations

import json
import os
import struct
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree

from moonshot.body.hand import AnatomicalHand
from moonshot.body.nimble import Nimble, taubin, vertex_normals
from moonshot.config import data_root

FPS = 24
STUB_KEEP_MM = 3.0           # the stub below this (proximal of the wrist joint) becomes forearm
FOREARM_MM = 75.0            # how far the skin reaches up the forearm (under the sleeve)
CUFF_MM = 32.0               # cuff edge, proximal of the wrist joint
REACH_MM = 260.0             # a geom further than this from the wrist can't touch the hand or its stub
MARGIN_MM = 0.3              # skin is pressed this far outside a surface
# NIMBLE's appearance model (10-component PCA of scanned hands): the mean reads washed-out orange; this
# mix is less orange with the dorsal creases and veins of the scans more visible
SKIN_ALPHA = np.array([0.0, 0.9, 0.0, -0.7, 0, 0, 0, 0, 0, 0])


def write_pc2(path: Path, frames: np.ndarray) -> None:
    """Blender's Mesh Cache format: POINTCACHE2, then float32 xyz per point per sample."""
    n, v, _ = frames.shape
    with open(path, "wb") as f:
        f.write(b"POINTCACHE2\0")
        f.write(struct.pack("<iiffi", 1, v, 0.0, 1.0, n))
        f.write(frames.astype("<f4").tobytes())


def quat_mat(q) -> np.ndarray:
    """Rotation matrices from w x y z quaternions, (..., 4) -> (..., 3, 3)."""
    w, x, y, z = np.moveaxis(np.asarray(q, float), -1, 0)
    return np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], -1),
                     np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], -1),
                     np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1)], -2)


def mirror(p, mirror_x: float) -> np.ndarray:
    p = np.array(p, float)
    p[..., 0] = 2 * mirror_x - p[..., 0]
    return p


# --- resampling ---------------------------------------------------------------------------------------------------

def resample(d, fps: int = FPS) -> dict:
    """Every per-frame array of a take record at the render's frame rate: positions and angles linearly, rotations
    by normalised interpolation. Also "x", each render frame's place in the take, in (fractional) take frames."""
    src, n_src = float(d["fps"]), len(d["t"])
    n = int(np.floor((n_src - 1) * fps / src + 1e-9)) + 1
    x = np.arange(n) * src / fps
    k0 = np.minimum(np.floor(x + 1e-9).astype(int), n_src - 1)
    k1 = np.minimum(k0 + 1, n_src - 1)
    a = x - k0

    def lerp(v):
        w = a.reshape(-1, *[1] * (v.ndim - 1))
        return v[k0] * (1 - w) + v[k1] * w

    def rot(v):                                             # (n, 3, 3), back onto rotations
        u, _, vt = np.linalg.svd(lerp(v))
        return u @ vt

    q0, q1 = d["quat"][k0], d["quat"][k1]
    q1 = np.where(np.sum(q0 * q1, -1, keepdims=True) < 0, -q1, q1)
    w = a[:, None, None]
    quat = q0 * (1 - w) + q1 * w
    out = {"fps": fps, "n": n, "t": np.arange(n) / fps, "x": x, "bodies": np.asarray(d["bodies"]),
           "pos": lerp(d["pos"]), "quat": quat / np.linalg.norm(quat, axis=-1, keepdims=True),
           "eye": lerp(d["eye"]), "look": lerp(d["look"]), "up": lerp(d["up"]),
           "arms": [str(s) for s in d["arms"]], "mirror_x": float(d["mirror_x"])}
    for s in out["arms"]:
        out[f"{s}_q_names"] = [str(v) for v in d[f"{s}_q_names"]]
        out |= {f"{s}_{k}": lerp(d[f"{s}_{k}"]) for k in ("q", "W", "S", "E")}
        out |= {f"{s}_{k}": rot(d[f"{s}_{k}"]) for k in ("H", "forearm")}
    return out


def mesh_frames(x: np.ndarray, frames: list[int]) -> np.ndarray:
    """The take frame whose mesh each render frame draws: the latest listed at or before it."""
    k = np.floor(np.asarray(x) + 1e-9).astype(int)
    listed = np.array(sorted(frames))
    return listed[np.maximum(np.searchsorted(listed, k, side="right") - 1, 0)]


# --- colliders: signed distance and outward normal, for points (m, 3) in mm ------------------------------------------

def _box(p, c, R, half):
    q = (p - c) @ R
    d = np.abs(q) - half
    out = np.maximum(d, 0)
    no = np.linalg.norm(out, axis=1)
    dist = no + np.minimum(d.max(1), 0)
    i, ax = np.arange(len(q)), d.argmax(1)
    n = np.zeros_like(q)
    n[i, ax] = np.where(q[i, ax] < 0, -1.0, 1.0)
    n = np.where((no > 0)[:, None], np.sign(q) * out / np.maximum(no, 1e-12)[:, None], n)
    return dist, n @ R.T


def _sphere(p, c, r):
    v = p - c
    L = np.linalg.norm(v, axis=1)
    return L - r, v / np.maximum(L, 1e-12)[:, None]


def _capsule(p, a, b, r):
    u = b - a
    t = np.clip((p - a) @ u / max(u @ u, 1e-12), 0, 1)
    v = p - a - np.outer(t, u)
    L = np.linalg.norm(v, axis=1)
    return L - r, v / np.maximum(L, 1e-12)[:, None]


def _cylinder(p, c, axis, r, half_len):
    q = p - c
    t = q @ axis
    rad = q - np.outer(t, axis)
    rl = np.linalg.norm(rad, axis=1)
    dr, da = rl - r, np.abs(t) - half_len
    dist = np.where((dr > 0) & (da > 0), np.hypot(np.maximum(dr, 0), np.maximum(da, 0)), np.maximum(dr, da))
    n = np.where((dr > da)[:, None], rad / np.maximum(rl, 1e-12)[:, None], np.sign(t)[:, None] * axis)
    return dist, n


def colliders(geoms: list[tuple[int, dict]], pos: np.ndarray, quat: np.ndarray, near: list[np.ndarray]) -> list:
    """The geoms of object bodies posed at one frame, as sdf(points) -> (distance, outward normal), keeping those
    within reach of any of the wrists in `near`. Meshes and height fields carry no shape here and are skipped."""
    out, R_body = [], quat_mat(quat)
    for b, g in geoms:
        R = R_body[b] @ quat_mat(g["quat"])
        c = pos[b] + R_body[b] @ np.asarray(g["pos"], float)
        size, kind = np.asarray(g["size"], float), g["type"]
        if kind == "plane":
            if min(abs((w - c) @ R[:, 2]) for w in near) < REACH_MM:
                out.append(lambda p, c=c, n=R[:, 2]: ((p - c) @ n - MARGIN_MM, np.broadcast_to(n, p.shape)))
            continue
        bound = {"box": np.linalg.norm(size), "sphere": size[0], "capsule": size[0] + size[1],
                 "cylinder": np.hypot(size[0], size[1]), "ellipsoid": size.max()}.get(kind)
        if bound is None or min(np.linalg.norm(w - c) for w in near) > REACH_MM + bound:
            continue
        if kind == "box":
            out.append(lambda p, c=c, R=R, h=size + MARGIN_MM: _box(p, c, R, h))
        elif kind in ("sphere", "ellipsoid"):
            out.append(lambda p, c=c, r=size.max() + MARGIN_MM: _sphere(p, c, r))
        elif kind == "capsule":
            ax = R[:, 2] * size[1]
            out.append(lambda p, a=c - ax, b=c + ax, r=size[0] + MARGIN_MM: _capsule(p, a, b, r))
        elif kind == "cylinder":
            out.append(lambda p, c=c, ax=R[:, 2], r=size[0] + MARGIN_MM, h=size[1] + MARGIN_MM: _cylinder(p, c, ax, r, h))
    return out


def press(world: np.ndarray, faces: np.ndarray, sdfs: list) -> tuple[np.ndarray, float]:
    """Press skin that is inside a collider onto its surface and bulge the ring around each patch outward. Returns
    the skin and the deepest any of it was inside (mm)."""
    depth = np.zeros(len(world))
    out = world.copy()
    for sdf in sdfs:
        d, nrm = sdf(out)
        inside = d < 0
        if inside.any():
            out[inside] -= nrm[inside] * d[inside, None]
            depth[inside] = np.maximum(depth[inside], -d[inside])
    hit = np.nonzero(depth > 0.05)[0]
    if len(hit):
        vn = vertex_normals(out, faces)
        tree = cKDTree(out[hit])
        bulge = np.zeros(len(out))
        for i, nb in enumerate(tree.query_ball_point(out, r=7.0)):
            if nb and depth[i] <= 0.05:
                dd = np.linalg.norm(out[hit[nb]] - out[i], axis=1)
                bulge[i] = 0.3 * np.max(depth[hit[nb]] * np.exp(-(dd / 4.0) ** 2))
        out += vn * bulge[:, None]
        for sdf in sdfs:                                    # a second pass keeps the bulge out of the surface
            d, nrm = sdf(out)
            inside = d < 0
            out[inside] -= nrm[inside] * d[inside, None]
    return out, float(depth.max())


# --- the skin -----------------------------------------------------------------------------------------------------

class Skin:
    """NIMBLE's skin as the render draws it: the vertices the faces use, with the forearm stretched from the stub."""

    def __init__(self, hand: AnatomicalHand):
        self.hand = hand
        m = hand.model
        self.used = np.unique(m.skin_f)
        remap = np.full(len(hand.rest_v) - m.skin_sep, -1)
        remap[self.used] = np.arange(len(self.used))
        self.faces = remap[m.skin_f]
        rest = (hand.rest_v[m.skin_sep:] - hand.rest_J[0]) * hand.scale        # hand frame (NIMBLE axes), mm
        self.B = hand.wrist_frame()
        s = rest @ self.B[:, 0]
        # stretch the stub along the long axis; weight onto the forearm across the wrist
        k = (FOREARM_MM - STUB_KEEP_MM) / max(-s.min() - STUB_KEEP_MM, 1e-6)
        self.stretch = np.where(s < -STUB_KEEP_MM, (-STUB_KEEP_MM + (s + STUB_KEEP_MM) * k) - s, 0.0)
        x = np.clip((-s - STUB_KEEP_MM) / 16.0, 0, 1)
        self.w_fore = x * x * (3 - 2 * x)
        txt = m.uv_obj_lines().splitlines()
        self.uv = np.array([list(map(float, ln.split()[1:3])) for ln in txt if ln.startswith("vt ")])
        self.face_uv = np.array([[int(c.split("/")[1]) - 1 for c in ln.split()[1:]] for ln in txt
                                 if ln.startswith("f ")])
        self.attr = {k: v[self.used] for k, v in self._attributes(rest).items()}

    def _attributes(self, rest_local):
        """Static per-vertex data for the shader: rest position (procedural detail that stays on the skin), dorsal
        knuckle masks (creases), nail mask, palmar mask, the forearm weight."""
        h = self.hand
        J = (h.rest_J - h.rest_J[0]) * h.scale
        rest = rest_local + self.B[:, 0] * self.stretch[:, None]
        n = vertex_normals(rest_local, h.model.skin_f)
        dorsal = -h.palmar
        crease = np.zeros(len(rest))
        for j in (2, 3, 6, 7, 8, 11, 12, 13, 16, 17, 18, 21, 22, 23):   # thumb MCP/IP; finger MCP, PIP, DIP
            d = np.linalg.norm(rest - J[j], axis=1)
            r = 11.0 if j in (6, 11, 16, 21) else 8.0
            crease = np.maximum(crease, np.exp(-(d / r) ** 2) * np.clip((n @ dorsal) * 1.6, 0, 1))
        nail = np.zeros(len(rest))
        for j0, j1 in ((3, 4), (8, 9), (13, 14), (18, 19), (23, 24)):
            u = J[j1] - J[j0]
            L = np.linalg.norm(u)
            u /= L
            t = (rest - J[j0]) @ u
            near = (t > 0.3 * L) & (t < 1.2 * L)
            facing = n @ dorsal if j0 != 3 else n @ np.cross(u, dorsal)
            dist = np.linalg.norm(rest - J[j0] - np.outer(t, u), axis=1)
            nail = np.maximum(nail, near * np.clip((facing - 0.4) * 3, 0, 1) * (dist < 9.5 * h.scale))
        return {"rest": rest * 0.001, "crease": crease, "nail": nail, "palmar": np.clip(n @ h.palmar, 0, 1),
                "fore": self.w_fore}

    def pose(self, q: dict, H, W, F) -> np.ndarray:
        """World skin (mm) of a right hand: joint angles q, hand frame H at wrist W, forearm frame F."""
        h = self.hand
        o = h.model.forward(h.nimble_pose(h.clamp(q)), shaped=(h.rest_v, h.rest_J))
        skin = h.model.push_skin_out_of_muscle(o["skin"], o["muscle"])
        skin = taubin(skin, h.model.skin_f, iters=2)
        local = (skin - h.rest_J[0]) * h.scale + self.B[:, 0] * self.stretch[:, None]
        w = self.w_fore[:, None]
        world = (1 - w) * (local @ (H @ self.B.T).T) + w * (local @ (F @ self.B.T).T) + W
        return world[self.used]


class Sleeve:
    """A work-shirt sleeve: a tube from the cuff, past the elbow, over the shoulder, with folds."""

    def __init__(self, n_around=40, n_along=70, seed=3):
        self.na, self.nl = n_around, n_along
        self.ph = np.random.default_rng(seed).uniform(0, 2 * np.pi, (6,))
        u = np.linspace(0, 1, n_along)
        th = np.linspace(0, 2 * np.pi, n_around, endpoint=False)
        self.U, self.TH = np.meshgrid(u, th, indexing="ij")
        f = []
        for i in range(n_along - 1):
            for j in range(n_around):
                a, b = i * n_around + j, i * n_around + (j + 1) % n_around
                f.append([a, a + n_around, b + n_around, b])
        # the cuff's hem: an inner layer folded back 12 mm, so the open end has thickness
        base = n_along * n_around
        for j in range(n_around):
            a, b = j, (j + 1) % n_around
            f.append([b, base + b, base + a, a])
        for i in range(2):
            for j in range(n_around):
                a = base + i * n_around + j
                b = base + i * n_around + (j + 1) % n_around
                f.append([a, b, b + n_around, a + n_around])
        self.faces = np.array(f)[:, ::-1]                  # wound outward; trainual's pointed in
        uu = np.concatenate([self.U.ravel(), np.zeros(3 * n_around)])
        tt = np.concatenate([self.TH.ravel(), np.tile(th, 3)])
        self.uv = np.stack([tt / (2 * np.pi), uu], 1)

    def pose(self, W, E, S, F) -> np.ndarray:
        """Vertices (mm) for wrist W, elbow E, shoulder S and forearm frame F."""
        upper, fore = E - S, W - E
        elbow_deg = np.degrees(np.arccos(np.clip(upper @ fore / np.linalg.norm(upper) / np.linalg.norm(fore), -1, 1)))
        cuff = W - F[:, 0] * CUFF_MM
        top = S + (S - E) / np.linalg.norm(S - E) * 60.0
        # centreline: cuff -> elbow -> shoulder, a smooth curve (quadratic Bezier pieces through E)
        lf, lu = np.linalg.norm(E - cuff), np.linalg.norm(top - E)
        u = np.linspace(0, 1, self.nl)
        split = lf / (lf + lu)
        pts, tang = [], []
        for x in u:
            if x <= split:
                t = x / split
                A, B, C = cuff, E - (E - cuff) * 0.25, E + (top - E) * 0.08
            else:
                t = (x - split) / (1 - split)
                A, B, C = E + (top - E) * 0.08, E + (top - E) * 0.3, top
            pts.append((1 - t) ** 2 * A + 2 * (1 - t) * t * B + t * t * C)
            d = 2 * (1 - t) * (B - A) + 2 * t * (C - B)
            tang.append(d / np.linalg.norm(d))
        pts, tang = np.array(pts), np.array(tang)
        # cross-section frames: start from the forearm's radial axis, parallel-transported
        n0 = F[:, 1] - tang[0] * F[:, 1].dot(tang[0])
        n0 /= np.linalg.norm(n0)
        frames = []
        for i in range(self.nl):
            if i:
                n0 = n0 - tang[i] * n0.dot(tang[i])
                n0 /= np.linalg.norm(n0)
            frames.append((n0, np.cross(tang[i], n0)))
        bend = max(0.0, (elbow_deg - 30) / 100)
        V = np.zeros((self.nl, self.na, 3))
        for i in range(self.nl):
            x = u[i]
            r = np.interp(x, [0, 0.04, split, 1], [36, 40, 49, 58])
            n1, n2 = frames[i]
            th = self.TH[i]
            # folds: soft rings along the sleeve, a few long creases, bunching at the elbow when it bends
            folds = 1.6 * np.sin(2 * np.pi * x * 9 + 1.3 * np.sin(th * 2 + self.ph[0]) + self.ph[1])
            folds += 1.0 * np.sin(th * 3 + 6 * x + self.ph[2])
            near_elbow = np.exp(-((x - split) / 0.07) ** 2)
            folds += bend * near_elbow * (3.5 * np.sin(2 * np.pi * x * 22 + 2 * np.sin(th + self.ph[3])) + 2.0)
            rr = r + folds - bend * near_elbow * 6 * np.cos(th - 0.3)      # the inside of the elbow compresses
            ex = np.where(x < split, 1.12, 1.05)                             # an oval, wider across the forearm
            V[i] = pts[i] + (np.outer(np.cos(th) * rr * ex, n1) + np.outer(np.sin(th) * rr, n2))
        V = V.reshape(-1, 3)
        # hem: folded inner layer at the cuff, 1.5 mm inside, going 12 mm up
        c0 = V[:self.na]
        inward = (pts[0] - c0) / np.linalg.norm(pts[0] - c0, axis=1, keepdims=True)
        hem = [c0 + inward * 1.5 + tang[0] * 0.5, c0 + inward * 1.8 + tang[0] * 6, c0 + inward * 2.0 + tang[0] * 12]
        return np.concatenate([V] + hem)


# --- the bake -----------------------------------------------------------------------------------------------------

_W: dict = {}


def _init(r: dict, geoms: list) -> None:
    _W["r"], _W["geoms"] = r, geoms
    _W["skin"], _W["sleeve"] = Skin(AnatomicalHand(Nimble(data_root() / "hand-model" / "nimble"))), Sleeve()
    _W["faces"] = {"R": _W["skin"].faces, "L": _W["skin"].faces[:, ::-1]}


def _frame(i: int):
    r, skin, sleeve = _W["r"], _W["skin"], _W["sleeve"]
    out, mx = {}, r["mirror_x"]
    wrists = [r[f"{s}_W"][i] if s == "R" else mirror(r[f"{s}_W"][i], mx) for s in r["arms"]]
    sdfs = colliders(_W["geoms"], r["pos"][i], r["quat"][i], wrists)
    for s in r["arms"]:
        q = dict(zip(r[f"{s}_q_names"], r[f"{s}_q"][i]))
        W, S, E, H, F = (r[f"{s}_{k}"][i] for k in ("W", "S", "E", "H", "forearm"))
        hand, arm = skin.pose(q, H, W, F), sleeve.pose(W, E, S, F)
        if s != "R":                                    # posed as a right arm in the mirrored world
            hand, arm = mirror(hand, mx), mirror(arm, mx)
        hand, depth = press(hand, _W["faces"][s], sdfs)
        out[s] = (hand.astype(np.float32), arm.astype(np.float32), depth)
    return i, out


def bake(take: Path, out: Path, fps: int = FPS, workers: int | None = None) -> dict:
    """Bake a take record (a folder with take.npz and scene.json) into `out` for render_take.py."""
    take, out = Path(take), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    r = resample(np.load(take / "take.npz"), fps)
    scene = json.loads((take / "scene.json").read_text(encoding="utf-8"))
    names = [str(b) for b in r["bodies"]]
    geoms = [(names.index(b), g) for b, e in scene["bodies"].items() if e["role"] == "object"
             for g in e.get("geoms", [])]
    n, arms = r["n"], r["arms"]
    frames: list = [{}] * n
    workers = workers or max(1, min(10, (os.cpu_count() or 2) - 1))
    if arms and workers == 1:
        _init(r, geoms)
        frames = [_frame(i)[1] for i in range(n)]
    elif arms:
        with ProcessPoolExecutor(workers, initializer=_init, initargs=(r, geoms)) as ex:
            for i, f in ex.map(_frame, range(n), chunksize=4):
                frames[i] = f
    arrays = {"fps": fps, "n": n, "t": r["t"], "arms": np.array(arms, dtype=str), "bodies": r["bodies"],
              "pos": r["pos"], "quat": r["quat"], "eye": r["eye"], "look": r["look"], "up": r["up"],
              "focus": np.mean([r[f"{s}_W"] if s == "R" else mirror(r[f"{s}_W"], r["mirror_x"]) for s in arms], 0)
              if arms else r["look"]}                    # no hands (a machine's cycle): what the eyes look at
    for name, b in scene["bodies"].items():
        if "meshes" in b:
            arrays[f"mesh_{name}"] = mesh_frames(r["x"], b["meshes"]["frames"])
    if arms:
        if "skin" not in _W:
            _init(r, geoms)
        skin, sleeve = _W["skin"], _W["sleeve"]
        arrays |= {"hand_uv": skin.uv, "sleeve_uv": sleeve.uv, **{f"attr_{k}": v for k, v in skin.attr.items()}}
        for s in arms:
            flip = (lambda f: f[:, ::-1]) if s != "R" else (lambda f: f)  # noqa: E731
            arrays[f"hand_faces_{s}"], arrays[f"sleeve_faces_{s}"] = flip(skin.faces), flip(sleeve.faces)
            arrays[f"hand_face_uv_{s}"] = flip(skin.face_uv)             # each face's UVs follow its corners
            arrays[f"depth_{s}"] = np.array([f[s][2] for f in frames], np.float32)
            write_pc2(out / f"hand_{s}.pc2", np.array([f[s][0] for f in frames]) * 0.001)
            write_pc2(out / f"sleeve_{s}.pc2", np.array([f[s][1] for f in frames]) * 0.001)
        from PIL import Image
        for k, img in skin.hand.model.textures(SKIN_ALPHA).items():
            Image.fromarray((img * 255).astype(np.uint8)).save(out / f"skin_{k}.png")
    np.savez(out / "bake.npz", **arrays)
    return {"frames": n, "fps": fps, "arms": arms, "seconds": round(time.perf_counter() - t0, 1),
            "depth_mm": {s: round(float(arrays[f"depth_{s}"].max()), 2) for s in arms}}


def main(argv: list[str]) -> None:
    take = Path(argv[0])
    opt = lambda flag, default: argv[argv.index(flag) + 1] if flag in argv else default   # noqa: E731
    out = Path(opt("--out", take / "bake"))
    print(f"[bake] {take} -> {out}: {bake(take, out, int(opt('--fps', FPS)))}", flush=True)


if __name__ == "__main__":
    main(sys.argv[1:])
