"""The take record: what a physics run hands the renderer (plan §6). One folder per take, any station, both arms.

take.npz, n frames:
    fps                      ()          frames per second
    t                        (n,)        seconds
    bodies                   (B,)        every MuJoCo body but the world, by name
    pos                      (n, B, 3)   mm, world
    quat                     (n, B, 4)   w x y z, world
    eye, look, up            (n, 3)      the camera: the operator's eyes and the point they look at (mm), and up
    arms                     (A,)        "R", and "L" when the left arm works
    mirror_x                 ()          mm: the body's mid-plane, x = mirror_x
  per arm s in arms, the hand as NIMBLE poses it:
    {s}_q_names              (J,)        NIMBLE's joint names
    {s}_q                    (n, J)      degrees, NIMBLE's convention
    {s}_W, {s}_S, {s}_E      (n, 3)      mm: wrist, shoulder, elbow
    {s}_H, {s}_forearm       (n, 3, 3)   the hand's and the forearm's frames, NIMBLE's wrist convention
  The left arm is given as the right arm in the mirrored world, as the planner has it (moonshot/motion/kinematics.py):
  pose a right hand with L_q, L_H and L_W, then reflect it through x = mirror_x (and flip its faces) to draw it.

scene.json:
    {"schema": "jigged.take-scene/1", "station": "vf2", "arms": ["R", "L"],
     "bodies": {name: {"role": "body" | "object",
                       "glbs": [{"path": "<under the data root>",            optional: the render meshes
                                 "in_body": [x, y, z, qw, qx, qy, qz]}],     mm: the GLB's frame in the body's
                       "geoms": [{"name", "type", "size", "pos", "quat", "rgba"}]}}}   mm: MuJoCo's colliders
  "body" bodies are the person, drawn as skin from the hands above, not from geoms; an "object" with no GLBs is drawn
  from its geoms. Geoms are also what the skin bake presses the skin onto.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

SCHEMA = "jigged.take-scene/1"
ARM_KEYS = {"q": 2, "W": 2, "S": 2, "E": 2, "H": 3, "forearm": 3}


def check(folder: Path) -> list[str]:
    """What's wrong with a take record, or nothing."""
    folder = Path(folder)
    errors = []
    try:
        d = np.load(folder / "take.npz")
        scene = json.loads((folder / "scene.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return [f"unreadable: {e}"]
    if scene.get("schema") != SCHEMA:
        errors.append(f"scene.json schema is {scene.get('schema')!r}, not {SCHEMA}")
    n, bodies = len(d["t"]), [str(b) for b in d["bodies"]]
    shapes = {"pos": (n, len(bodies), 3), "quat": (n, len(bodies), 4), "eye": (n, 3), "look": (n, 3), "up": (n, 3)}
    for arm in (str(a) for a in d["arms"]):
        J = len(d[f"{arm}_q_names"]) if f"{arm}_q_names" in d else 0
        shapes |= {f"{arm}_{k}": (n, J) if k == "q" else (n, 3) if r == 2 else (n, 3, 3) for k, r in ARM_KEYS.items()}
    for k, shape in shapes.items():
        if k not in d:
            errors.append(f"take.npz has no {k}")
        elif d[k].shape != shape:
            errors.append(f"{k} is {d[k].shape}, not {shape}")
    if not errors and not np.allclose(np.linalg.norm(d["quat"], axis=2), 1, atol=1e-6):
        errors.append("quat has rows that aren't unit")
    if sorted(scene.get("arms", [])) != sorted(str(a) for a in d["arms"]):
        errors.append("scene.json and take.npz name different arms")
    missing = set(scene.get("bodies", {})) - set(bodies)
    if missing:
        errors.append(f"scene.json names bodies the take doesn't move: {sorted(missing)[:5]}")
    return errors
