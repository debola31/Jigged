"""Reduce NIMBLE to what the body model needs, once: moonshot/body/data/hand_rest.json.

The NIMBLE model is 713 MB and lives in the data root, never in git, so CI couldn't build the body model from it.
Its kinematics are small, though: 25 joint centres, 26 anatomical joints (axis, rest angle, range) and a collision
hull per bone, from the skin. Those are committed, and a data-root test fails if they drift from NIMBLE.

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


def fit_hulls(hand: AnatomicalHand) -> dict[int, tuple[np.ndarray, float]]:
    """Per bone: the convex hull of the skin it mostly moves (a fingertip's end joint's skin goes to its bone), at
    rest, as (hull vertices mm, volume mm^3). The collision shape is the skin's own surface, to within its
    concavities. Capsules inside the skin let it sink 8 mm into what the hand held (docs/moonshot/physics.md);
    MuJoCo's soft contact now stands in for the pads' compression."""
    from scipy.spatial import ConvexHull
    m = hand.model
    skin = (hand.rest_v[m.skin_sep:] - hand.rest_J[0]) * hand.scale
    used = np.zeros(len(skin), bool)
    used[np.unique(m.skin_f)] = True
    bone = lambda j: j if j in JOINT_BONE else bone(PARENT[j])   # noqa: E731
    owner = np.array([bone(j) for j in np.argmax(m.sw[m.skin_sep:], 1)])
    hulls = {}
    for j in sorted(set(owner[used])):
        p = skin[used & (owner == j)]
        if len(p) >= 10:
            h = ConvexHull(p)
            hulls[j] = (p[h.vertices], float(h.volume))
    return hulls


def derive(nimble_dir: Path) -> dict:
    hand = AnatomicalHand(Nimble(nimble_dir))
    J = (hand.rest_J - hand.rest_J[0]) * hand.scale
    hulls = fit_hulls(hand)
    r = lambda v: [round(float(x), 4) for x in v]   # noqa: E731
    return {
        "source": "NIMBLE (Li et al. 2022) via moonshot/body/derive_hand.py; scale and axes from moonshot/body/hand.py",
        "scale": hand.scale,
        "joints": [{"name": JOINTS[j], "parent": PARENT[j], "pos_mm": r(J[j])} for j in range(25)],
        "dofs": [{"name": d["name"], "joint": _bone_joint(d["bone"]), "axis": r(d["axis"]),
                  "rest_deg": round(d["rest"], 3), "range_deg": [d["lo"], d["hi"]]} for d in hand.dofs],
        "hulls": {JOINTS[j]: {"vertices_mm": [[round(float(x), 2) for x in v] for v in p], "volume_mm3": round(vol, 1)}
                  for j, (p, vol) in hulls.items()},
        "wrist_frame": [r(row) for row in hand.wrist_frame()],
    }


def _bone_joint(bone: int) -> int:
    """The NIMBLE joint a bone rotates at."""
    return next(j for j, b in JOINT_BONE.items() if b == bone)


def main() -> None:
    OUT.write_text(json.dumps(derive(data_root() / "hand-model" / "nimble"), indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
