"""What a process plan's vise setup loads (plan §7), and how it sits: the one definition every take and the stock's
meshes use for a setup's part in the vise.

`part_pose` gives the part's frame in the vise: which way each axis of the part's model (its STEP's frame) points in
the world, and where the part's box stands, with the table at its loading position. `vise_load` gives what the vise
take reads: the part's size along the jaws, across them and up, the parallels under it, and the jaw opening to
start from, placed as in the reference take (moonshot/world/vise.py REFERENCE).

The pose, by rule:
- up is the plan's face_up, and across the jaws its jaw_on axis; along the jaws is the third, pointing +;
- where the jaws close on datum A's axis (datum A is the model's y = 0 face), datum A sits against the fixed jaw,
  and along takes the sign that keeps the frame a rotation;
- a setup with no parallels stands on the vise's floor.

The saw's setup, and the first on the mill, hold the stock. A later setup loads a machined part as its bounding box
(ENVELOPE_MM), until the stock-removal model hands each setup its part: a declared shortcut, sound where the vise
touches it, since every face it rests or clamps on is machined flat by then; the render draws its real shape.
"""
from __future__ import annotations

import numpy as np

from moonshot.world.vise import REFERENCE, VISE, Load

AXIS = {"X": 0, "Y": 1, "Z": 2}
INCH = 25.4
# from the reference take: parallel a stands this far in from the fixed jaw, parallel b this far in from the part's
# near edge (so the part sits on both whether set down short or slid home), and the jaws start this much wider
# than the part
FIXED_TO_A = VISE["fixed_face_y"] - REFERENCE.parallels_y["para_a"]
NEAR_TO_B = REFERENCE.parallels_y["para_b"] - (VISE["fixed_face_y"] - REFERENCE.size_mm[1])
OPENING_MARGIN = REFERENCE.opening0 - REFERENCE.size_mm[1]
# a part standing taller than it is wide is opened for wider, as a machinist would: op30's 31 mm part, 75 tall, swung
# 7-10 mm in the hand and was set down on the moving jaw's top with 7.8 mm to spare
TALL_MARGIN, TALL_MARGIN_MAX = 0.4, 30.0
# under a narrow part (op30's 31 mm, on its side) parallel a comes in closer to the jaw so the two keep this pitch
MIN_PITCH = 6.8
# the stock is centred on the part in its model's x and z; Op 10 faces this much off datum A [proposed]
FACE_A_MM = {"nist-ftc-10": 0.5}
# each later setup's part as its box in the model's frame (mm). nist-ftc-10 finishes 158 x 31 x 75 (x -79..79, y 0..31
# from datum A, z -37.5..37.5): Op 10 profiles the outline and faces datum A, Op 20 faces the top to 31
ENVELOPE_MM = {("nist-ftc-10", "op20"): ((-79.0, 79.0), (0.0, 37.6), (-37.5, 37.5))}
ENVELOPE_MM |= {("nist-ftc-10", s): ((-79.0, 79.0), (0.0, 31.0), (-37.5, 37.5)) for s in ("op30", "op40", "op50")}
# the stock's box in the model's frame where the part isn't centred on the origin: centred on the part's box (its
# STEP's bounding box) on every axis, so each face machined takes an even share off. ll-1007223 finishes 49 x 40 x 75
# (x 0..49, y 0..40, z -37.5..37.5); ct-slbeam 76.2 x 38.1 x 50.8 from the origin, its 38.1 the bar's own width
STOCK_MM = {"ll-1007223": ((-4.075, 53.075), (-2.225, 42.225), (-41.275, 41.275)),
            "ct-slbeam": ((-3.175, 79.375), (0.0, 38.1), (-3.175, 53.975))}
# ll-1007223: Op 10 faces the top to 40 and profiles the flange's edges and both ends to 49 x 75 down to 1 mm above
# the jaws (y 17.475); Op 20 holds it by the flange in soft jaws, on the faced top, its box the 49 x 75 the jaws and
# the parallels touch: the skirt Op 10 couldn't reach (y -2.225..17.475, 4.1 mm wider each side, 3.8 longer each
# end) stands above the jaws, left out [declared shortcut]; Op 30 holds the finished part
ENVELOPE_MM |= {("ll-1007223", "op20"): ((0.0, 49.0), (-2.225, 40.0), (-37.5, 37.5)),
                ("ll-1007223", "op30"): ((0.0, 49.0), (0.0, 40.0), (-37.5, 37.5))}
# ct-slbeam: Op 10 faces the bottom (z 0), Op 20 the long leg's end (x 76.2), Op 30 the back (x 0)
ENVELOPE_MM |= {("ct-slbeam", "op20"): ((-3.175, 79.375), (0.0, 38.1), (0.0, 53.975)),
                ("ct-slbeam", "op30"): ((-3.175, 76.2), (0.0, 38.1), (0.0, 53.975)),
                ("ct-slbeam", "op40"): ((0.0, 76.2), (0.0, 38.1), (0.0, 53.975))}


def _setup(plan: dict, setup_id: str) -> dict:
    return next(x for x in plan["setups"] if x["id"] == setup_id)


def envelope(plan: dict, setup_id: str) -> np.ndarray:
    """The setup's part as a box in its model's frame: [[xmin, xmax], [ymin, ymax], [zmin, zmax]] mm."""
    setups = plan["setups"]
    first = next(i for i, s in enumerate(setups) if "workholding" in s)        # the first on the mill
    if any(s["id"] == setup_id for s in setups[:first + 1]):
        if plan.get("part") in STOCK_MM:
            return np.array(STOCK_MM[plan["part"]], float)
        sx, sy, sz = plan["stock"]["size_mm"]
        a = FACE_A_MM.get(plan.get("part"), 0.0)
        return np.array([[-sx / 2, sx / 2], [-a, sy - a], [-sz / 2, sz / 2]])
    return np.array(ENVELOPE_MM[(plan["part"], setup_id)], float)


def rotation(face_up: str, jaw_on: str) -> np.ndarray:
    """R, the model's axes in the world: a model vector v points along R @ v, with world x along the jaws, y across
    them toward the fixed jaw, and z up."""
    up, across = AXIS[face_up[-1]], AXIS[jaw_on[0]]
    along = ({0, 1, 2} - {up, across}).pop()
    e = np.eye(3)
    z = e[up] * (1.0 if face_up[0] == "+" else -1.0)
    if across == AXIS["Y"]:                       # datum A (y = 0, facing -y) against the fixed jaw (world +y)
        y = -e[across]
        x = np.cross(y, z)
    else:
        x = e[along]
        y = np.cross(z, x)
    return np.stack([x, y, z])


def part_pose(plan: dict, setup_id: str) -> dict:
    """The part in the vise (world mm, the table at its loading position): R, the box's centre and size (along,
    across, up), and the model's origin, so a model point p stands at origin_mm + R @ p."""
    w = _setup(plan, setup_id)["workholding"]
    s = _setup(plan, setup_id)
    R = rotation(s["face_up"], w["jaw_on"])
    env = envelope(plan, setup_id)
    size = np.abs(R) @ (env[:, 1] - env[:, 0])
    centre = np.array([VISE["x"], VISE["fixed_face_y"] - size[1] / 2,
                       VISE["seat_z"] + w["parallels_in"] * INCH + size[2] / 2])
    return {"R": R, "centre_mm": centre, "size_mm": size, "origin_mm": centre - R @ env.mean(1), "envelope_mm": env}


def vise_load(plan: dict, setup_id: str) -> Load:
    w = _setup(plan, setup_id)["workholding"]
    along, width, up = (float(v) for v in part_pose(plan, setup_id)["size_mm"])
    fy = VISE["fixed_face_y"]
    to_a = min(FIXED_TO_A, width - NEAR_TO_B - MIN_PITCH)
    paras = {"para_a": fy - to_a, "para_b": fy - width + NEAR_TO_B} if w["parallels_in"] else {}
    return Load(size_mm=(along, width, up), parallel_h=w["parallels_in"] * INCH, parallels_y=paras,
                opening0=width + (min(TALL_MARGIN_MAX, max(OPENING_MARGIN, TALL_MARGIN * up)) if up > width
                                  else OPENING_MARGIN))
