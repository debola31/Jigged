"""Reduce NIMBLE to what the body model needs, once: moonshot/body/data/hand_rest.json.

The NIMBLE model is 713 MB and lives in the data root, never in git, so CI couldn't build the body model from it.
Its kinematics are small, though: 25 joint centres, 26 anatomical joints (axis, rest angle, range) and a collision
capsule per bone fitted to the skin. Those are committed, and a data-root test fails if they drift from NIMBLE.

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
INSET_MM = 2.0          # capsules sit inside the skin by the pad's compression, so contact presses skin that far


def fit_capsules(hand: AnatomicalHand, J: np.ndarray) -> dict[int, tuple[np.ndarray, np.ndarray, float]]:
    """Per bone: a capsule from its joint to its child joint, radius = the skin's distance from that segment
    (40th percentile of the skin vertices that bone mostly moves), minus the pad's compression."""
    m = hand.model
    skin = (hand.rest_v[m.skin_sep:] - hand.rest_J[0]) * hand.scale
    sw = m.sw[m.skin_sep:]
    used = np.zeros(len(skin), bool)
    used[np.unique(m.skin_f)] = True
    owner = np.argmax(sw, 1)
    children = {j: [c for c in range(25) if PARENT[c] == j] for j in range(25)}
    caps = {}
    for j in range(1, 25):
        if j not in JOINT_BONE or not children[j]:
            continue
        a, b = J[j], J[children[j][0]]
        sel = used & (owner == j)
        if sel.sum() < 10:
            continue
        p = skin[sel]
        u = (b - a) / np.linalg.norm(b - a)
        t = np.clip((p - a) @ u, 0, np.linalg.norm(b - a))
        r = float(np.percentile(np.linalg.norm(p - (a + np.outer(t, u)), axis=1), 40)) - INSET_MM
        if JOINTS[j].startswith("dis"):          # the tip joint sits inside the pulp: reach to the pad's end
            b = b + u * max(0.0, r * 0.4)
        caps[j] = (a, b, max(r, 4.0))
    return caps


def derive(nimble_dir: Path) -> dict:
    hand = AnatomicalHand(Nimble(nimble_dir))
    J = (hand.rest_J - hand.rest_J[0]) * hand.scale
    caps = fit_capsules(hand, J)
    r = lambda v: [round(float(x), 4) for x in v]   # noqa: E731
    return {
        "source": "NIMBLE (Li et al. 2022) via moonshot/body/derive_hand.py; scale and axes from moonshot/body/hand.py",
        "scale": hand.scale,
        "joints": [{"name": JOINTS[j], "parent": PARENT[j], "pos_mm": r(J[j])} for j in range(25)],
        "dofs": [{"name": d["name"], "joint": _bone_joint(d["bone"]), "axis": r(d["axis"]),
                  "rest_deg": round(d["rest"], 3), "range_deg": [d["lo"], d["hi"]]} for d in hand.dofs],
        "capsules": {JOINTS[j]: {"from_mm": r(a), "to_mm": r(b), "radius_mm": round(rad, 3)}
                     for j, (a, b, rad) in caps.items()},
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
