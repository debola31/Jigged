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
touches it, since every face it rests or clamps on is machined flat by then; the render draws its real shape. The cut
simulation hands part_pose that box itself (`env`): the stock the setup before left, in the model's frame.

A plate clamped to the table (a setup whose workholding has "clamps") lies on a 3/4 in MDF spoilboard bolted to the
VF-2's table at its loading position, centred on the table where the vise stands (the vise comes off for it), its top
at SPOILBOARD_TOP_Z, or RISER_MM higher on a riser for a part whose short tools need the plate higher
(plate_board_top). The plate lies flat on it, face_up up, its longer side along the table (world x) and the other
pointing +y, so its low edge in the model is the near one; x completes the rotation. It is centred on the spoilboard,
unless PLATE_NEAR_Y_MM places its near edge (a plate as wide as the Y travel, placed so its near edge's cutter path
starts at the front of it). A setup whose workholding has "shift" is the same plate, still on the spoilboard, slid
along the table: the setup before's pose, moved.
"""
from __future__ import annotations

import re

import numpy as np

from moonshot.world import vf2
from moonshot.world.vise import REFERENCE, TABLE_Z, VISE, Load

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
# (x 0..49, y 0..40, z -37.5..37.5); ct-slbeam 76.2 x 38.1 x 50.8 from the origin, its 38.1 the bar's own width;
# ll-1005337's plate 400 x 600 (x -400..0, y 0..600), its 19.05 the plate's own thickness (z -20..-0.95)
STOCK_MM = {"ll-1007223": ((-4.075, 53.075), (-2.225, 42.225), (-41.275, 41.275)),
            "ct-slbeam": ((-3.175, 79.375), (0.0, 38.1), (-3.175, 53.975)),
            "ll-1005337": ((-403.2, 3.2), (-30.2, 630.2), (-20.0, -0.95))}
# ll-1007223: Op 10 faces the top to 40 and profiles the flange's edges and both ends to 49 x 75 down to 1 mm above
# the jaws (y 17.475), leaving the skirt below them the stock's own size, which Op 20 holds above its soft jaws; Op 30
# holds the finished part
ENVELOPE_MM |= {("ll-1007223", "op20"): ((-4.075, 53.075), (-2.225, 40.0), (-41.275, 41.275)),
                ("ll-1007223", "op30"): ((0.0, 49.0), (0.0, 40.0), (-37.5, 37.5))}
# ct-slbeam: Op 10 faces the bottom (z 0), Op 20 the long leg's end (x 76.2), Op 30 the back (x 0)
ENVELOPE_MM |= {("ct-slbeam", "op20"): ((-3.175, 79.375), (0.0, 38.1), (0.0, 53.975)),
                ("ct-slbeam", "op30"): ((-3.175, 76.2), (0.0, 38.1), (0.0, 53.975)),
                ("ct-slbeam", "op40"): ((0.0, 76.2), (0.0, 38.1), (0.0, 53.975))}
# a plate on the table: the spoilboard is 3/4 in MDF, centred on the table (its top collider's box, world mm at loading)
SPOILBOARD_MM = 0.75 * INCH
SPOILBOARD_TOP_Z = TABLE_Z + SPOILBOARD_MM                  # 872.05, on the table itself
# a part whose short tools can't reach its plate down there has the spoilboard raised on a riser bolted to the table
# (moonshot/world/spoilboard.py): nist-ftc-09's 1-1/2 in miniature end mills (keyhole em18, lettering em132) stop 4.6
# and 2.4 mm short of the sheet in Z, so it stands on a 1.000 in aluminium sub-plate (the user's decision, 2026-11-05)
RISER_MM = {"nist-ftc-09": 1.0 * INCH}


def plate_board_top(part: str | None) -> float:
    """The top of the spoilboard a part's plate lies on (world mm, the table at loading): on its riser if it has one."""
    return SPOILBOARD_TOP_Z + RISER_MM.get(part, 0.0)
_TABLE = vf2.record()["colliders"]["table_top"]
SPOILBOARD_CENTRE_XY = ((_TABLE["box_min_mm"][0] + _TABLE["box_max_mm"][0]) / 2,       # -381.5, the vise's x
                        (_TABLE["box_min_mm"][1] + _TABLE["box_max_mm"][1]) / 2)       # -340.5
# the front of the Y travel: where the spindle stands over the table at Y's far end (moonshot/sim/cam.py joints)
Y_TRAVEL_FRONT = vf2.record()["joints"]["spindle"]["centre_mm"][1] - vf2.record()["joints"]["y"]["range_mm"][1]
# a plate placed by its near edge (world y of its stock's near edge). ll-1005337 (plan: "placed so the near edge's
# cutter path starts at the front of the Y travel; the far edge's would end 6.8 mm past the back of it"): the 1/2 in
# end mill's centre (r 6.35) 0.5 mm inside the front, and the 406.4 mm stock 3.2 mm wider than the part each side
PLATE_NEAR_Y_MM = {"ll-1005337": Y_TRAVEL_FRONT + 0.5 + 0.25 * INCH - 3.2}


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


def part_pose(plan: dict, setup_id: str, env=None) -> dict:
    """The part in the vise, or a plate on the table (world mm, the table at its loading position): R, the box's
    centre and size (along, across, up), and the model's origin, so a model point p stands at origin_mm + R @ p.
    env: the part's box in its model's frame ([[xmin, xmax], [ymin, ymax], [zmin, zmax]] mm), as the cut simulation
    has it; by default envelope()."""
    s = _setup(plan, setup_id)
    w = s["workholding"]
    if "clamps" in w:
        return plate_pose(plan, setup_id, env)
    env = envelope(plan, setup_id) if env is None else np.asarray(env, float)
    R = rotation(s["face_up"], w["jaw_on"])
    size = np.abs(R) @ (env[:, 1] - env[:, 0])
    centre = np.array([VISE["x"], VISE["fixed_face_y"] - size[1] / 2,
                       VISE["seat_z"] + w["parallels_in"] * INCH + size[2] / 2])
    return {"R": R, "centre_mm": centre, "size_mm": size, "origin_mm": centre - R @ env.mean(1), "envelope_mm": env}


def plate_rotation(face_up: str, env: np.ndarray) -> np.ndarray:
    """R for a plate lying flat (as rotation()): up is face_up, the longer of its other two sides along world x, the
    shorter pointing world +y."""
    up = AXIS[face_up[-1]]
    a, b = sorted({0, 1, 2} - {up}, key=lambda i: env[i, 1] - env[i, 0], reverse=True)
    e = np.eye(3)
    z = e[up] * (1.0 if face_up[0] == "+" else -1.0)
    y = e[b]
    return np.stack([np.cross(y, z), y, z])


def plate_shift(plan: dict, setup_id: str) -> tuple[str, np.ndarray] | None:
    """For a setup that slides the plate along the table ("shift": "<n> mm toward you" or "toward the back"): the
    setup it slides from (the one before) and the move (world mm). None for any other setup."""
    w = _setup(plan, setup_id).get("workholding", {})
    if "shift" not in w:
        return None
    m = re.fullmatch(r"(\d+(?:\.\d+)?) mm toward (you|the back)", w["shift"])
    if not m:
        raise ValueError(f"{setup_id}: can't read the plate's shift {w['shift']!r}")
    i = [x["id"] for x in plan["setups"]].index(setup_id)
    return plan["setups"][i - 1]["id"], np.array([0.0, (-1.0 if m.group(2) == "you" else 1.0) * float(m.group(1)), 0.0])


def shifted(before: dict, move: np.ndarray, env: np.ndarray) -> dict:
    """A plate's pose slid by move from the pose before; env is only the box it reports."""
    R, origin = before["R"], before["origin_mm"] + move
    return {"R": R, "centre_mm": origin + R @ env.mean(1), "size_mm": np.abs(R) @ (env[:, 1] - env[:, 0]),
            "origin_mm": origin, "envelope_mm": env}


def plate_pose(plan: dict, setup_id: str, env=None) -> dict:
    """A plate on the spoilboard (see the module's doc): part_pose's dict. A setup that slides the plate (plate_shift)
    is the setup before's pose, moved; by default it reports the box the setup before had."""
    s = _setup(plan, setup_id)
    if sh := plate_shift(plan, setup_id):
        before = part_pose(plan, sh[0])
        return shifted(before, sh[1], before["envelope_mm"] if env is None else np.asarray(env, float))
    env = envelope(plan, setup_id) if env is None else np.asarray(env, float)
    R = plate_rotation(s["face_up"], env)
    size = np.abs(R) @ (env[:, 1] - env[:, 0])
    cy = SPOILBOARD_CENTRE_XY[1]
    if plan.get("part") in PLATE_NEAR_Y_MM:
        cy = PLATE_NEAR_Y_MM[plan["part"]] + size[1] / 2
    centre = np.array([SPOILBOARD_CENTRE_XY[0], cy, plate_board_top(plan.get("part")) + size[2] / 2])
    return {"R": R, "centre_mm": centre, "size_mm": size, "origin_mm": centre - R @ env.mean(1), "envelope_mm": env}


# each stock material's density (kg/m^3), found by its key as a word in the plan's stock material, with its source
DENSITY = {
    "6061": (2700.0, "6061-T6 aluminium 2.70 g/cm^3: ASM Aerospace Specification Metals, Aluminum 6061-T6 data sheet"),
    "4140": (7850.0, "AISI 4140 steel 7.85 g/cm^3: MatWeb, AISI 4140 Steel (ASM Handbook vol. 1 values)"),
    "304": (8000.0, "AISI 304 stainless 8.00 g/cm^3: MatWeb, AISI Type 304 Stainless Steel (ASM Handbook vol. 1 values)"),
    "acetal": (1410.0, "acetal 1.41 g/cm^3 (copolymer; Delrin homopolymer 1.42): MatWeb, Overview of materials for Acetal"),
    "delrin": (1410.0, "Delrin acetal 1.41-1.42 g/cm^3: DuPont Delrin 150 product information; as acetal above"),
}


def density(plan: dict) -> float:
    """The stock's density (kg/m^3) from its material (DENSITY). A material the table doesn't know raises: taken as
    the Load's default, aluminium, G1's 4140 steel parts weighed a third of what they do."""
    material = str(plan.get("stock", {}).get("material", ""))
    for key, (rho, _source) in DENSITY.items():
        if re.search(rf"\b{key}\b", material.lower()):
            return rho
    raise ValueError(f"no density for the stock material {material!r}: add it to loads.DENSITY, with its source")


def vise_load(plan: dict, setup_id: str) -> Load:
    w = _setup(plan, setup_id)["workholding"]
    along, width, up = (float(v) for v in part_pose(plan, setup_id)["size_mm"])
    fy = VISE["fixed_face_y"]
    to_a = min(FIXED_TO_A, width - NEAR_TO_B - MIN_PITCH)
    paras = {"para_a": fy - to_a, "para_b": fy - width + NEAR_TO_B} if w["parallels_in"] else {}
    return Load(size_mm=(along, width, up), parallel_h=w["parallels_in"] * INCH, parallels_y=paras,
                opening0=width + (min(TALL_MARGIN_MAX, max(OPENING_MARGIN, TALL_MARGIN * up)) if up > width
                                  else OPENING_MARGIN), density=density(plan))


def scene_spec(part: str, setup_id: str, stock: str = "in", vise: str = "clamped") -> dict:
    """What a per-setup take at the VF-2 (moonshot/planning/takes.py per_setup) finds on its table, for take.json:
    {"scene": ..., and for a vise setup "load", its Load, which the checks read the part from}. stock: the part as it
    enters the setup ("in": the start and the clean) or as its last cycle leaves it ("out": the unload). vise:
    "clamped", the part clamped on its parallels or on the floor against its stop, as the start and the unload find it;
    or "open", the vise open at the load's opening, the parallels in their rack (or the stop on the table) and the part
    waiting on the table, as the clean finds it. A plate setup's plate lies on its spoilboard under its clamps
    (moonshot/motion/plates.py)."""
    from moonshot.planning.validate import load_plan
    plan = load_plan(part)
    plate = "clamps" in _setup(plan, setup_id)["workholding"]
    out: dict = {"scene": {"part": part, "setup": setup_id, "stock": stock, "plate": plate,
                           "vise": None if plate else vise}}
    if not plate:
        out["load"] = vise_load(plan, setup_id).to_json()
    return out
