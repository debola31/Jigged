"""Reduce NIMBLE to what the body model needs, once: moonshot/body/data/hand_rest.json.

The NIMBLE model is 713 MB and lives in the data root, never in git, so CI couldn't build the body model from it.
Its kinematics are small, though: 25 joint centres, 26 anatomical joints (axis, rest angle, range) and the
colliders fitted to the skin: a capsule per fingertip and a convex shell per other bone (fit_colliders). Those are committed, and a data-root test fails if they drift from NIMBLE.

    python -m moonshot.body.derive_hand            # rewrites moonshot/body/data/hand_rest.json

All positions are millimetres in NIMBLE's rest frame, scaled to an adult male hand, with the wrist joint at the
origin. `wrist_frame` maps the hand's own axes (long, radial, dorsal) into that frame. Right hand only; the body
model mirrors it for the left.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from moonshot.body.hand import AnatomicalHand
from moonshot.body.nimble import JOINT_BONE, JOINTS, PARENT, Nimble
from moonshot.config import data_root

OUT = Path(__file__).resolve().parent / "data" / "hand_rest.json"
# the colliders are fitted to the skin, so the physics stops where the skin meets a surface (the user's decision,
# 2026-11-04): before, they sat inside it by the pads' compression (2-3 mm) and the palm's one capsule 10-18 mm inside
# the palm's skin, so a firm fingertip touch read 3.1-3.4 mm of skin sunk into the part against the 3.5 mm bar, and a
# palm pushing a door's bar 8 mm
PAD_INSET_MM = 0.75     # a fingertip's capsule: its pad side this far inside the skin (the soft contact gives the rest)
BULGE_MM = 0.5          # ... its back and sides at most this far outside it
SHELL_INSET_MM = 1.0    # the palm's and the other bones' convex shells: this far inside the skin
SHELLS = ("carpal", "met", "pro", "int")


def _unit(v: np.ndarray) -> np.ndarray:
    return v / np.linalg.norm(v)


def _seg_dist(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    u = b - a
    t = np.clip((p - a) @ u / (u @ u), 0, 1)
    return np.linalg.norm(p - (a + np.outer(t, u)), axis=1)


def shell(p: np.ndarray, inset: float = SHELL_INSET_MM) -> np.ndarray:
    """A bone's convex shell: its skin's convex hull, each corner moved in along its faces' mean normal by inset."""
    from scipy.spatial import ConvexHull
    hull = ConvexHull(p)
    vn = np.zeros((len(p), 3))
    for f, eq in zip(hull.simplices, hull.equations):
        vn[f] += eq[:3]
    vs = hull.vertices
    return p[vs] - inset * vn[vs] / np.linalg.norm(vn[vs], axis=1, keepdims=True)


def fingertip(p: np.ndarray, a: np.ndarray, b: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """A distal phalanx's capsule, fitted to its skin p: a circle in the cross-section whose pad side sits PAD_INSET_MM
    inside the skin and whose back no more than BULGE_MM outside it (no wider than the finger), its cap reaching the
    pulp's end PAD_INSET_MM in. The pad is where the skin stands out most from a capsule centred in its
    cross-section, as the earlier fit was."""
    u, L = _unit(b - a), np.linalg.norm(b - a)
    t = (p - a) @ u
    rho = p - a - np.outer(t, u)
    c = rho.mean(0)
    r0 = float(np.percentile(np.linalg.norm(rho - c, axis=1), 90)) - 2.5
    out = (_seg_dist(p, a + c, b + c + u * max(0.0, r0 * 0.4)) - max(r0, 4.0)) > 1.0
    n = (rho[out] / np.linalg.norm(rho[out], axis=1, keepdims=True)).mean(0)
    n = _unit(n - u * (n @ u))
    lat = np.cross(u, n)
    inner = (t > 0.2 * L) & (t < 0.8 * L)
    x, y = rho[inner] @ n, rho[inner] @ lat
    r_p, r_d = np.percentile(x, 97), -np.percentile(x, 3)
    y_hi, y_lo = np.percentile(y, 97), np.percentile(y, 3)
    R = float(min((r_p - PAD_INSET_MM + r_d + BULGE_MM) / 2, (y_hi - y_lo) / 2 + BULGE_MM))
    off = (r_p - PAD_INSET_MM - R) * n + (y_hi + y_lo) / 2 * lat
    a2 = a + off
    e = np.percentile((p - a2) @ u, 99.5) - PAD_INSET_MM - R - L
    return a2, a2 + u * (L + max(e, -0.5 * L)), R


def fit_colliders(hand: AnatomicalHand, J: np.ndarray) -> tuple[dict, dict]:
    """Per bone, from the skin vertices that bone mostly moves (NIMBLE's rest pose): the fingertips' capsules
    (fingertip), and every other bone's convex shell (shell), the palm's the carpal bone's.

    A fingertip stays a capsule: the presses aim its end (motion/pendant.py) and the hand opening is measured
    between the thumb's and index's (body/aperture.py). The fit leaves the rest skin within about 1 mm outside the
    colliders (1.0 at the shells, 0.7-1.1 at the fingertips' 90th percentile), where the earlier fit left 2-4 mm at
    the fingers and 10-18 mm at the palm. A shell stands proud of its skin where the skin is hollow (the palm's
    middle, the creases at the knuckles; the proximal phalanges' 3-5 mm at their 98th percentile): there a contact
    leaves a gap rather than sinking the skin. The hand's own colliders don't collide with each other."""
    m = hand.model
    skin = (hand.rest_v[m.skin_sep:] - hand.rest_J[0]) * hand.scale
    used = np.zeros(len(skin), bool)
    used[np.unique(m.skin_f)] = True
    owner = np.argmax(m.sw[m.skin_sep:], 1)
    children = {j: [c for c in range(25) if PARENT[c] == j] for j in range(25)}
    caps, shells = {}, {}
    for j in range(25):
        sel = used & (owner == j)
        if sel.sum() < 10:
            continue
        if JOINTS[j].startswith("dis") and children[j]:
            caps[j] = fingertip(skin[sel], J[j], J[children[j][0]])
        elif JOINTS[j].startswith(SHELLS):
            shells[j] = shell(skin[sel])
    return caps, shells


def derive(nimble_dir: Path) -> dict:
    hand = AnatomicalHand(Nimble(nimble_dir))
    J = (hand.rest_J - hand.rest_J[0]) * hand.scale
    caps, shells = fit_colliders(hand, J)
    r = lambda v: [round(float(x), 4) for x in v]   # noqa: E731
    return {
        "source": "NIMBLE (Li et al. 2022) via moonshot/body/derive_hand.py; scale and axes from moonshot/body/hand.py",
        "scale": hand.scale,
        "joints": [{"name": JOINTS[j], "parent": PARENT[j], "pos_mm": r(J[j])} for j in range(25)],
        "dofs": [{"name": d["name"], "joint": _bone_joint(d["bone"]), "axis": r(d["axis"]),
                  "rest_deg": round(d["rest"], 3), "range_deg": [d["lo"], d["hi"]]} for d in hand.dofs],
        "capsules": {JOINTS[j]: {"from_mm": r(a), "to_mm": r(b), "radius_mm": round(rad, 3)}
                     for j, (a, b, rad) in caps.items()},
        "shells": {JOINTS[j]: {"vertices_mm": [r(v) for v in vs], "volume_mm3": round(_volume(vs), 1)}
                   for j, vs in shells.items()},
        "wrist_frame": [r(row) for row in hand.wrist_frame()],
    }


def _volume(v: np.ndarray) -> float:
    from scipy.spatial import ConvexHull
    return float(ConvexHull(v).volume)


def _bone_joint(bone: int) -> int:
    """The NIMBLE joint a bone rotates at."""
    return next(j for j, b in JOINT_BONE.items() if b == bone)


def main() -> None:
    OUT.write_text(json.dumps(derive(data_root() / "hand-model" / "nimble"), indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
